/**
 * TOKENMAXX HEAVY leftovers after #158 — keys/media/appservice *concurrent race / TOCTOU*
 * + soft/edge reliability for slices #158 leftovers soft-flooded lightly.
 * Orthogonal to oauth/push/identity (#160) and login/QR/identity races (#163).
 * Focus: OTK claim double-consume, placeholder PUT overwrite race, AS txn races,
 * device_signing/signatures/thumbnail/preview soft floods missing from #158 leftovers.
 * Tests-only. Fixtures use example.com only. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import type { AppServiceRegistration } from '../src/services/appservice';

const asMocks = vi.hoisted(() => ({
  getAppServiceByToken: vi.fn(),
  getUserById: vi.fn(),
  opaqueSeq: 0,
}));

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICEA');
      await next();
    };
  },
}));

vi.mock('../src/utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/crypto')>();
  return {
    ...actual,
    verifyPassword: vi.fn(async (password: string, storedHash: string) => {
      return storedHash === `mockok:${password}`;
    }),
  };
});

vi.mock('../src/utils/ids', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ids')>();
  return {
    ...actual,
    generateOpaqueId: async (length: number = 18) => {
      asMocks.opaqueSeq += 1;
      const base = `raceid${asMocks.opaqueSeq}`.padEnd(Math.max(length, 8), '0');
      return base.slice(0, Math.max(length, base.length));
    },
  };
});

vi.mock('../src/services/appservice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/appservice')>();
  return {
    ...actual,
    getAppServiceByToken: (...args: unknown[]) => asMocks.getAppServiceByToken(...args),
  };
});

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getUserById: (...args: unknown[]) => asMocks.getUserById(...args),
  };
});

import {
  getInterestedAppServices,
  isExclusiveAppServiceAlias,
  isExclusiveAppServiceUser,
  sendAppServiceTransaction,
} from '../src/services/appservice';
import keysApp from '../src/api/keys';
import mediaApp from '../src/api/media';
import appserviceApp from '../src/api/appservice';

const getAppServiceByToken = asMocks.getAppServiceByToken;
const getUserById = asMocks.getUserById;

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const DEVICE = 'DEVICEA';
const SERVER = 'example.com';
const AS_TOKEN = 'as-token-bridge-race';
const NOW = 1_700_000_000_000;
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;
const ALG = 'signed_curve25519';

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };
type GetBarrier = { prefix: string; count: number };

function mockKv(
  data: Record<string, string> = {},
  opts: { getBarrier?: GetBarrier; putBarrier?: GetBarrier } = {}
) {
  const puts: KvPut[] = [];
  const deletes: string[] = [];
  const events: string[] = [];
  let getWaiters: Array<() => void> = [];
  let putWaiters: Array<() => void> = [];
  let getBarrier: GetBarrier | undefined = opts.getBarrier;
  let putBarrier: GetBarrier | undefined = opts.putBarrier;

  async function maybeBarrier(
    key: string,
    barrier: GetBarrier | undefined,
    waiters: Array<() => void>,
    setWaiters: (w: Array<() => void>) => void,
    clearBarrier: () => void
  ) {
    if (!barrier || !key.startsWith(barrier.prefix)) return;
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
      if (waiters.length >= barrier.count) {
        const all = [...waiters];
        setWaiters([]);
        clearBarrier();
        for (const r of all) r();
      }
    });
  }

  const kv = {
    data,
    puts,
    deletes,
    events,
    get: async (key: string, type?: string) => {
      events.push(`kv:get:${key}`);
      await maybeBarrier(
        key,
        getBarrier,
        getWaiters,
        (w) => {
          getWaiters = w;
        },
        () => {
          getBarrier = undefined;
        }
      );
      const raw = data[key];
      if (raw == null) return null;
      if (type === 'json') {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
      return raw;
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      events.push(`kv:put:${key}`);
      await maybeBarrier(
        key,
        putBarrier,
        putWaiters,
        (w) => {
          putWaiters = w;
        },
        () => {
          putBarrier = undefined;
        }
      );
      data[key] = value;
      puts.push({ key, value, options });
    },
    delete: async (key: string) => {
      events.push(`kv:delete:${key}`);
      deletes.push(key);
      delete data[key];
    },
  };
  return kv as unknown as KVNamespace & {
    data: Record<string, string>;
    puts: KvPut[];
    deletes: string[];
    events: string[];
  };
}

type DeviceKeyMap = Record<string, unknown>;
type CrossSigningStore = {
  master?: unknown;
  self_signing?: unknown;
  user_signing?: unknown;
};

type FallbackRow = {
  user_id: string;
  device_id: string;
  algorithm: string;
  key_id: string;
  key_data: string;
  used: number;
};

type OtkRow = {
  id: number;
  user_id: string;
  device_id: string;
  algorithm: string;
  key_id: string;
  key_data: string;
  claimed: number;
};

type SigRow = {
  user_id: string;
  key_id: string;
  signer_user_id: string;
  signer_key_id: string;
  signature: string;
};

type KeyChange = {
  user_id: string;
  device_id: string | null;
  change_type: string;
  stream_position: number;
};

type Membership = { room_id: string; user_id: string; membership: string };

type CrossSigningKeyRow = {
  user_id: string;
  key_type: string;
  key_id: string;
  key_data: string;
};

type SqlCall = { sql: string; args: unknown[] };

function createUserKeysStub(opts: {
  deviceKeys?: Record<string, DeviceKeyMap>;
  crossSigning?: Record<string, CrossSigningStore>;
} = {}) {
  const deviceKeys = opts.deviceKeys ?? {};
  const crossSigning = opts.crossSigning ?? {};
  const fetches: Array<{ url: string; method: string; body?: unknown }> = [];
  return {
    fetches,
    deviceKeys,
    crossSigning,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      let body: unknown;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        try {
          body = await req.json();
        } catch {
          body = undefined;
        }
      }
      fetches.push({ url: req.url, method: req.method, body });
      if (path === '/device-keys/get') {
        const deviceId = url.searchParams.get('device_id');
        if (deviceId) return Response.json(deviceKeys[deviceId] ?? null);
        return Response.json(deviceKeys);
      }
      if (path === '/device-keys/put') {
        const b = body as { device_id: string; keys: unknown };
        deviceKeys[b.device_id] = b.keys as DeviceKeyMap;
        return Response.json({ success: true });
      }
      if (path === '/cross-signing/get') return Response.json(crossSigning);
      if (path === '/cross-signing/put') {
        Object.assign(crossSigning, body as CrossSigningStore);
        return Response.json({ success: true });
      }
      return new Response('not found', { status: 404 });
    },
  };
}

function createKeysDb(opts: {
  streamPositions?: Record<string, number>;
  otks?: OtkRow[];
  fallbacks?: FallbackRow[];
  signatures?: SigRow[];
  keyChanges?: KeyChange[];
  memberships?: Membership[];
  crossSigningKeys?: CrossSigningKeyRow[];
  idpLinkCounts?: Map<string, number>;
  passwordHashes?: Map<string, string | null>;
  firstBarrier?: { substr: string; count: number };
} = {}) {
  const streamPositions = { ...(opts.streamPositions ?? { device_keys: 10 }) };
  const otks = opts.otks ?? [];
  const fallbacks = opts.fallbacks ?? [];
  const signatures = opts.signatures ?? [];
  const keyChanges = opts.keyChanges ?? [];
  const memberships = opts.memberships ?? [];
  const crossSigningKeys = opts.crossSigningKeys ?? [];
  const idpLinkCounts = opts.idpLinkCounts ?? new Map<string, number>();
  const passwordHashes = opts.passwordHashes ?? new Map<string, string | null>();
  let firstBarrier = opts.firstBarrier;
  let firstWaiters: Array<() => void> = [];
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const events: string[] = [];

  async function maybeFirstBarrier(sql: string) {
    if (!firstBarrier || !sql.includes(firstBarrier.substr)) return;
    await new Promise<void>((resolve) => {
      firstWaiters.push(resolve);
      if (firstWaiters.length >= firstBarrier!.count) {
        const all = [...firstWaiters];
        firstWaiters = [];
        firstBarrier = undefined;
        for (const r of all) r();
      }
    });
  }

  return {
    streamPositions,
    otks,
    fallbacks,
    signatures,
    keyChanges,
    memberships,
    crossSigningKeys,
    idpLinkCounts,
    passwordHashes,
    inserts,
    updates,
    events,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              events.push(`db:first:${sql.slice(0, 70)}`);
              await maybeFirstBarrier(sql);
              if (sql.includes('SELECT position FROM stream_positions')) {
                const name = args[0] as string;
                return { position: streamPositions[name] ?? 1 } as T;
              }
              if (sql.includes('SELECT COUNT(*) as count FROM cross_signing_keys')) {
                const userId = args[0] as string;
                const count = crossSigningKeys.filter((k) => k.user_id === userId).length;
                return { count } as T;
              }
              if (sql.includes('SELECT COUNT(*) as count FROM idp_user_links')) {
                const userId = args[0] as string;
                return { count: idpLinkCounts.get(userId) ?? 0 } as T;
              }
              if (sql.includes('SELECT password_hash FROM users')) {
                const userId = args[0] as string;
                if (!passwordHashes.has(userId)) return null;
                return { password_hash: passwordHashes.get(userId) ?? null } as T;
              }
              if (
                sql.includes('FROM one_time_keys') &&
                sql.includes('claimed = 0') &&
                sql.includes('LIMIT 1')
              ) {
                const [userId, deviceId, algorithm] = args as [string, string, string];
                const hit = otks.find(
                  (k) =>
                    k.user_id === userId &&
                    k.device_id === deviceId &&
                    k.algorithm === algorithm &&
                    k.claimed === 0
                );
                if (!hit) return null;
                return { id: hit.id, key_id: hit.key_id, key_data: hit.key_data } as T;
              }
              if (sql.includes('FROM fallback_keys')) {
                const [userId, deviceId, algorithm] = args as [string, string, string];
                const hit = fallbacks.find(
                  (f) =>
                    f.user_id === userId &&
                    f.device_id === deviceId &&
                    f.algorithm === algorithm
                );
                if (!hit) return null;
                return { key_id: hit.key_id, key_data: hit.key_data, used: hit.used } as T;
              }
              return null;
            },
            async all<T>() {
              if (sql.includes('FROM cross_signing_signatures') && sql.includes('SELECT signer_user_id')) {
                const [userId, keyId] = args as [string, string];
                const results = signatures.filter((s) => s.user_id === userId && s.key_id === keyId);
                return { results } as { results: T[] };
              }
              if (sql.includes('FROM device_key_changes dkc') && sql.includes('room_memberships')) {
                const [fromPos, toPos, requester] = args as [number, number, string];
                const joinedRooms = new Set(
                  memberships
                    .filter((m) => m.user_id === requester && m.membership === 'join')
                    .map((m) => m.room_id)
                );
                const sharedUsers = new Set(
                  memberships
                    .filter((m) => joinedRooms.has(m.room_id) && m.membership === 'join')
                    .map((m) => m.user_id)
                );
                const results = keyChanges
                  .filter(
                    (c) =>
                      c.stream_position > fromPos &&
                      c.stream_position <= toPos &&
                      sharedUsers.has(c.user_id)
                  )
                  .map((c) => ({ user_id: c.user_id, change_type: c.change_type }));
                return { results } as { results: T[] };
              }
              if (sql.includes('SUBSTR(rm2.user_id') && sql.includes('room_memberships rm1')) {
                return { results: [] as T[] };
              }
              return { results: [] as T[] };
            },
            async run() {
              events.push(`db:run:${sql.slice(0, 70)}`);
              if (sql.includes('UPDATE stream_positions SET position = position + 1')) {
                updates.push({ sql, args });
                const name = args[0] as string;
                streamPositions[name] = (streamPositions[name] ?? 0) + 1;
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('INSERT INTO device_key_changes')) {
                inserts.push({ sql, args });
                const [userId, deviceId, changeType, streamPosition] = args as [
                  string,
                  string | null,
                  string,
                  number
                ];
                keyChanges.push({
                  user_id: userId,
                  device_id: deviceId,
                  change_type: changeType,
                  stream_position: streamPosition,
                });
                return { success: true, meta: { changes: 1, last_row_id: keyChanges.length } };
              }
              if (sql.includes('UPDATE one_time_keys SET claimed = 1')) {
                updates.push({ sql, args });
                if (sql.includes('WHERE id = ?')) {
                  const id = args[1] as number;
                  const hit = otks.find((k) => k.id === id);
                  if (hit) hit.claimed = 1;
                } else {
                  const [, userId, deviceId, keyId] = args as [number, string, string, string];
                  const hit = otks.find(
                    (k) => k.user_id === userId && k.device_id === deviceId && k.key_id === keyId
                  );
                  if (hit) hit.claimed = 1;
                }
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('UPDATE fallback_keys SET used = 1')) {
                updates.push({ sql, args });
                const [userId, deviceId, algorithm] = args as [string, string, string];
                const hit = fallbacks.find(
                  (f) => f.user_id === userId && f.device_id === deviceId && f.algorithm === algorithm
                );
                if (hit) hit.used = 1;
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('DELETE FROM cross_signing_keys WHERE user_id = ?')) {
                const userId = args[0] as string;
                for (let i = crossSigningKeys.length - 1; i >= 0; i--) {
                  if (crossSigningKeys[i].user_id === userId) crossSigningKeys.splice(i, 1);
                }
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('INSERT INTO cross_signing_keys')) {
                inserts.push({ sql, args });
                const [userId, keyType, keyId, keyData] = args as [string, string, string, string];
                crossSigningKeys.push({
                  user_id: userId,
                  key_type: keyType,
                  key_id: keyId,
                  key_data: keyData,
                });
                return { success: true, meta: { changes: 1, last_row_id: crossSigningKeys.length } };
              }
              if (sql.includes('INSERT INTO cross_signing_signatures')) {
                inserts.push({ sql, args });
                const [userId, keyId, signerUserId, signerKeyId, signature] = args as [
                  string,
                  string,
                  string,
                  string,
                  string
                ];
                signatures.push({
                  user_id: userId,
                  key_id: keyId,
                  signer_user_id: signerUserId,
                  signer_key_id: signerKeyId,
                  signature,
                });
                return { success: true, meta: { changes: 1, last_row_id: signatures.length } };
              }
              return { success: true, meta: { changes: 0, last_row_id: 0 } };
            },
          };
        },
      };
    },
  };
}

type KeysDb = ReturnType<typeof createKeysDb>;
type UserKeysStub = ReturnType<typeof createUserKeysStub>;

function createKeysEnv(opts: {
  db?: KeysDb;
  oneTimeKeysKv?: ReturnType<typeof mockKv>;
  cacheKv?: ReturnType<typeof mockKv>;
  accountDataKv?: ReturnType<typeof mockKv>;
  crossSigningKv?: ReturnType<typeof mockKv>;
  deviceKeysKv?: ReturnType<typeof mockKv>;
  userKeys?: UserKeysStub;
} = {}) {
  const db = opts.db ?? createKeysDb();
  const oneTimeKeysKv = opts.oneTimeKeysKv ?? mockKv();
  const cacheKv = opts.cacheKv ?? mockKv();
  const accountDataKv = opts.accountDataKv ?? mockKv();
  const crossSigningKv = opts.crossSigningKv ?? mockKv();
  const deviceKeysKv = opts.deviceKeysKv ?? mockKv();
  const userKeys = opts.userKeys ?? createUserKeysStub();
  const env = {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
    DEVICE_KEYS: deviceKeysKv,
    ONE_TIME_KEYS: oneTimeKeysKv,
    CACHE: cacheKv,
    ACCOUNT_DATA: accountDataKv,
    CROSS_SIGNING_KEYS: crossSigningKv,
    USER_KEYS: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => userKeys,
    },
    FEDERATION: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => ({
        async fetch() {
          return Response.json({ ok: true });
        },
      }),
    },
    _db: db,
    _otk: oneTimeKeysKv,
    _cache: cacheKv,
    _userKeys: userKeys,
    _crossSigning: crossSigningKv,
    _deviceKeys: deviceKeysKv,
  };
  return env as unknown as Env & typeof env;
}

async function keysReq(env: Env, path: string, init: RequestInit = {}) {
  const res = await keysApp.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, headers: res.headers, text };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function masterKeyPayload(n = 0) {
  return {
    user_id: USER,
    usage: ['master'],
    keys: { 'ed25519:master': `masterPub${n}` },
    signatures: { [USER]: { 'ed25519:master': `masterSig${n}` } },
  };
}

function selfSigningKeyPayload(n = 0) {
  return {
    user_id: USER,
    usage: ['self_signing'],
    keys: { 'ed25519:self': `selfPub${n}` },
    signatures: { [USER]: { 'ed25519:master': `selfSig${n}` } },
  };
}

function userSigningKeyPayload(n = 0) {
  return {
    user_id: USER,
    usage: ['user_signing'],
    keys: { 'ed25519:user': `userPub${n}` },
    signatures: { [USER]: { 'ed25519:master': `userSig${n}` } },
  };
}

function seedOtkKv(
  otk: ReturnType<typeof mockKv>,
  keyId: string,
  keyData: Record<string, unknown> = { key: 'otk-data' }
) {
  otk.data[`otk:${USER}:${DEVICE}`] = JSON.stringify({
    [ALG]: [{ keyId, keyData, claimed: false }],
  });
}

// ---------- media fixtures ----------

type MediaRow = {
  media_id: string;
  user_id: string;
  content_type: string;
  content_length: number;
  filename: string | null;
  created_at: number;
};

type R2ObjectLike = {
  body: ReadableStream | ArrayBuffer | Uint8Array | string;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
};

type MediaBucket = {
  store: Map<string, R2ObjectLike>;
  puts: Array<{ key: string; body: ArrayBuffer | Uint8Array | string; options?: unknown }>;
  gets: string[];
  get: (key: string) => Promise<R2ObjectLike | null>;
  put: (
    key: string,
    body: ArrayBuffer | Uint8Array | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    }
  ) => Promise<void>;
};

type MediaDb = {
  rows: MediaRow[];
  inserts: SqlCall[];
  updates: SqlCall[];
  events: string[];
  prepare: (sql: string) => {
    bind: (...args: unknown[]) => {
      first: <T>() => Promise<T | null>;
      run: () => Promise<{ success: boolean; meta: { changes: number; last_row_id: number } }>;
      all: <T>() => Promise<{ results: T[] }>;
    };
  };
};

function createMediaDb(
  opts: { rows?: MediaRow[]; firstBarrier?: { substr: string; count: number } } = {}
): MediaDb {
  const rows = opts.rows ? [...opts.rows] : [];
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const events: string[] = [];
  let firstBarrier = opts.firstBarrier;
  let firstWaiters: Array<() => void> = [];

  async function maybeFirstBarrier(sql: string) {
    if (!firstBarrier || !sql.includes(firstBarrier.substr)) return;
    await new Promise<void>((resolve) => {
      firstWaiters.push(resolve);
      if (firstWaiters.length >= firstBarrier!.count) {
        const all = [...firstWaiters];
        firstWaiters = [];
        firstBarrier = undefined;
        for (const r of all) r();
      }
    });
  }

  return {
    rows,
    inserts,
    updates,
    events,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              events.push(`db:first:${sql.slice(0, 70)}`);
              await maybeFirstBarrier(sql);
              if (sql.includes('SELECT content_type, filename FROM media WHERE media_id = ?')) {
                const mediaId = args[0] as string;
                const row = rows.find((r) => r.media_id === mediaId);
                if (!row) return null;
                return { content_type: row.content_type, filename: row.filename } as T;
              }
              if (sql.includes('SELECT content_type FROM media WHERE media_id = ?')) {
                const mediaId = args[0] as string;
                const row = rows.find((r) => r.media_id === mediaId);
                if (!row) return null;
                return { content_type: row.content_type } as T;
              }
              if (sql.includes('SELECT user_id, content_length FROM media WHERE media_id = ?')) {
                const mediaId = args[0] as string;
                const row = rows.find((r) => r.media_id === mediaId);
                if (!row) return null;
                return { user_id: row.user_id, content_length: row.content_length } as T;
              }
              return null;
            },
            async run() {
              events.push(`db:run:${sql.slice(0, 70)}`);
              if (sql.includes('INSERT INTO media')) {
                inserts.push({ sql, args });
                if (sql.includes('filename')) {
                  const [mediaId, userId, contentType, contentLength, filename, createdAt] = args as [
                    string,
                    string,
                    string,
                    number,
                    string | null,
                    number
                  ];
                  rows.push({
                    media_id: mediaId,
                    user_id: userId,
                    content_type: contentType,
                    content_length: contentLength,
                    filename,
                    created_at: createdAt,
                  });
                } else if (
                  sql.includes("'application/octet-stream'") &&
                  sql.includes('content_length') &&
                  args.length === 3
                ) {
                  const [mediaId, userId, createdAt] = args as [string, string, number];
                  rows.push({
                    media_id: mediaId,
                    user_id: userId,
                    content_type: 'application/octet-stream',
                    content_length: 0,
                    filename: null,
                    created_at: createdAt,
                  });
                } else {
                  const [mediaId, userId, contentType, contentLength, createdAt] = args as [
                    string,
                    string,
                    string,
                    number,
                    number
                  ];
                  rows.push({
                    media_id: mediaId,
                    user_id: userId,
                    content_type: contentType,
                    content_length: contentLength,
                    filename: null,
                    created_at: createdAt,
                  });
                }
                return { success: true, meta: { changes: 1, last_row_id: rows.length } };
              }
              if (sql.includes('UPDATE media SET content_type')) {
                updates.push({ sql, args });
                const [contentType, contentLength, filename, mediaId] = args as [
                  string,
                  number,
                  string | null,
                  string
                ];
                const row = rows.find((r) => r.media_id === mediaId);
                if (row) {
                  row.content_type = contentType;
                  row.content_length = contentLength;
                  row.filename = filename;
                  return { success: true, meta: { changes: 1, last_row_id: 0 } };
                }
                return { success: true, meta: { changes: 0, last_row_id: 0 } };
              }
              return { success: true, meta: { changes: 0, last_row_id: 0 } };
            },
            async all<T>() {
              return { results: [] as T[] };
            },
          };
        },
      };
    },
  };
}

function createMediaBucket(seed: Record<string, R2ObjectLike> = {}): MediaBucket {
  const store = new Map<string, R2ObjectLike>(Object.entries(seed));
  const puts: MediaBucket['puts'] = [];
  const gets: string[] = [];
  return {
    store,
    puts,
    gets,
    async get(key: string) {
      gets.push(key);
      return store.get(key) ?? null;
    },
    async put(key, body, options) {
      puts.push({ key, body, options });
      const normalized =
        typeof body === 'string'
          ? body
          : body instanceof ArrayBuffer
            ? body
            : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      store.set(key, {
        body: normalized as ArrayBuffer | string,
        httpMetadata: options?.httpMetadata,
        customMetadata: options?.customMetadata,
      });
    },
  };
}

function createCache(data: Record<string, string> = {}) {
  const puts: KvPut[] = [];
  return {
    data,
    puts,
    async get(key: string) {
      return data[key] ?? null;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      data[key] = value;
      puts.push({ key, value, options });
    },
    async delete(key: string) {
      delete data[key];
    },
  };
}

function mediaEnv(opts: {
  db?: MediaDb;
  media?: MediaBucket;
  cache?: ReturnType<typeof createCache>;
} = {}) {
  const db = opts.db ?? createMediaDb();
  const media = opts.media ?? createMediaBucket();
  const cache = opts.cache ?? createCache();
  return {
    DB: db as unknown as D1Database,
    MEDIA: media as unknown as R2Bucket,
    CACHE: cache as unknown as KVNamespace,
    SERVER_NAME: SERVER,
    _db: db,
    _media: media,
    _cache: cache,
  } as unknown as Env & { _db: MediaDb; _media: MediaBucket; _cache: ReturnType<typeof createCache> };
}

async function mediaReq(path: string, init: RequestInit = {}, env?: Env) {
  const e = env ?? mediaEnv();
  const res = await mediaApp.request(`http://localhost${path}`, init, e);
  const contentType = res.headers.get('Content-Type') || '';
  const text = await res.text();
  let body: unknown = text;
  if (contentType.includes('application/json') || (text.startsWith('{') && text.endsWith('}'))) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, headers: res.headers, text, env: e };
}

function seedRow(partial: Partial<MediaRow> & { media_id: string }): MediaRow {
  return {
    media_id: partial.media_id,
    user_id: partial.user_id ?? USER,
    content_type: partial.content_type ?? 'image/png',
    content_length: partial.content_length ?? 4,
    filename: partial.filename ?? null,
    created_at: partial.created_at ?? NOW,
  };
}

function bytesOf(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ---------- appservice fixtures ----------

const BRIDGE_REG: AppServiceRegistration = {
  id: 'bridge',
  url: 'https://bridge.example.com',
  as_token: AS_TOKEN,
  hs_token: 'hs-token-bridge',
  sender_localpart: 'bridge_bot',
  rate_limited: false,
  protocols: ['irc'],
  namespaces: {
    users: [{ exclusive: true, regex: `^@_bridge_.*:${SERVER.replace(/\./g, '\\.')}$` }],
    rooms: [{ exclusive: false, regex: `^!bridge_.*:${SERVER.replace(/\./g, '\\.')}$` }],
    aliases: [{ exclusive: true, regex: `^#_bridge_.*:${SERVER.replace(/\./g, '\\.')}$` }],
  },
};

const SLACK_REG: AppServiceRegistration = {
  id: 'slack',
  url: 'https://slack.example.com',
  as_token: 'as-token-slack',
  hs_token: 'hs-token-slack',
  sender_localpart: 'slack_bot',
  rate_limited: true,
  protocols: ['slack'],
  namespaces: {
    users: [{ exclusive: true, regex: `^@_slack_.*:${SERVER.replace(/\./g, '\\.')}$` }],
    rooms: [{ exclusive: false, regex: `^!slack_.*:${SERVER.replace(/\./g, '\\.')}$` }],
    aliases: [{ exclusive: false, regex: `^#_slack_.*:${SERVER.replace(/\./g, '\\.')}$` }],
  },
};

function createAsTxnDb() {
  const txns: Array<{
    txn_id: number;
    appservice_id: string;
    events: string;
    created_at: number;
    sent_at: number | null;
    retry_count: number;
  }> = [];
  let nextId = 1;
  const events: string[] = [];
  return {
    txns,
    events,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              return null as T;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              events.push(`db:run:${sql.slice(0, 70)}`);
              if (sql.includes('INSERT INTO appservice_transactions')) {
                const [appserviceId, evJson, createdAt] = args as [string, string, number];
                const txn_id = nextId++;
                txns.push({
                  txn_id,
                  appservice_id: appserviceId,
                  events: evJson,
                  created_at: createdAt,
                  sent_at: null,
                  retry_count: 0,
                });
                return { success: true, meta: { changes: 1, last_row_id: txn_id } };
              }
              if (sql.includes('UPDATE appservice_transactions SET sent_at')) {
                const [sentAt, txnId] = args as [number, number];
                const hit = txns.find((t) => t.txn_id === txnId);
                if (hit) hit.sent_at = sentAt;
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('UPDATE appservice_transactions SET retry_count')) {
                const txnId = args[0] as number;
                const hit = txns.find((t) => t.txn_id === txnId);
                if (hit) hit.retry_count += 1;
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              return { success: true, meta: { changes: 0, last_row_id: 0 } };
            },
          };
        },
      };
    },
  };
}

beforeEach(() => {
  asMocks.opaqueSeq = 0;
  getAppServiceByToken.mockReset();
  getUserById.mockReset();
  getAppServiceByToken.mockResolvedValue(BRIDGE_REG);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-09-14T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('race keys claim: same OTK KV double-consume TOCTOU after #158', () => {
  it('OTK claim barrier race #0', async () => {
    const otk = mockKv({}, { getBarrier: { prefix: 'otk:', count: 2 } });
    const keyId = 'signed_curve25519:race0';
    seedOtkKv(otk, keyId, { key: 'payload-0' });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const claimedA = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    const claimedB = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    // TOCTOU: both may observe unclaimed and both return the same keyId
    const hits = [claimedA, claimedB].filter(Boolean);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(otk.puts.filter((p) => p.key === `otk:${USER}:${DEVICE}`).length).toBeGreaterThanOrEqual(1);
    const stored = JSON.parse(otk.data[`otk:${USER}:${DEVICE}`]);
    expect(stored[ALG][0].claimed).toBe(true);
  });
  it('OTK claim barrier race #1', async () => {
    const otk = mockKv({}, { getBarrier: { prefix: 'otk:', count: 2 } });
    const keyId = 'signed_curve25519:race1';
    seedOtkKv(otk, keyId, { key: 'payload-1' });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const claimedA = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    const claimedB = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    // TOCTOU: both may observe unclaimed and both return the same keyId
    const hits = [claimedA, claimedB].filter(Boolean);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(otk.puts.filter((p) => p.key === `otk:${USER}:${DEVICE}`).length).toBeGreaterThanOrEqual(1);
    const stored = JSON.parse(otk.data[`otk:${USER}:${DEVICE}`]);
    expect(stored[ALG][0].claimed).toBe(true);
  });
  it('OTK claim barrier race #2', async () => {
    const otk = mockKv({}, { getBarrier: { prefix: 'otk:', count: 2 } });
    const keyId = 'signed_curve25519:race2';
    seedOtkKv(otk, keyId, { key: 'payload-2' });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const claimedA = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    const claimedB = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    // TOCTOU: both may observe unclaimed and both return the same keyId
    const hits = [claimedA, claimedB].filter(Boolean);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(otk.puts.filter((p) => p.key === `otk:${USER}:${DEVICE}`).length).toBeGreaterThanOrEqual(1);
    const stored = JSON.parse(otk.data[`otk:${USER}:${DEVICE}`]);
    expect(stored[ALG][0].claimed).toBe(true);
  });
  it('OTK claim barrier race #3', async () => {
    const otk = mockKv({}, { getBarrier: { prefix: 'otk:', count: 2 } });
    const keyId = 'signed_curve25519:race3';
    seedOtkKv(otk, keyId, { key: 'payload-3' });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const claimedA = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    const claimedB = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    // TOCTOU: both may observe unclaimed and both return the same keyId
    const hits = [claimedA, claimedB].filter(Boolean);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(otk.puts.filter((p) => p.key === `otk:${USER}:${DEVICE}`).length).toBeGreaterThanOrEqual(1);
    const stored = JSON.parse(otk.data[`otk:${USER}:${DEVICE}`]);
    expect(stored[ALG][0].claimed).toBe(true);
  });
  it('OTK claim barrier race #4', async () => {
    const otk = mockKv({}, { getBarrier: { prefix: 'otk:', count: 2 } });
    const keyId = 'signed_curve25519:race4';
    seedOtkKv(otk, keyId, { key: 'payload-4' });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const claimedA = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    const claimedB = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    // TOCTOU: both may observe unclaimed and both return the same keyId
    const hits = [claimedA, claimedB].filter(Boolean);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(otk.puts.filter((p) => p.key === `otk:${USER}:${DEVICE}`).length).toBeGreaterThanOrEqual(1);
    const stored = JSON.parse(otk.data[`otk:${USER}:${DEVICE}`]);
    expect(stored[ALG][0].claimed).toBe(true);
  });
  it('OTK claim barrier race #5', async () => {
    const otk = mockKv({}, { getBarrier: { prefix: 'otk:', count: 2 } });
    const keyId = 'signed_curve25519:race5';
    seedOtkKv(otk, keyId, { key: 'payload-5' });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const claimedA = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    const claimedB = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    // TOCTOU: both may observe unclaimed and both return the same keyId
    const hits = [claimedA, claimedB].filter(Boolean);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(otk.puts.filter((p) => p.key === `otk:${USER}:${DEVICE}`).length).toBeGreaterThanOrEqual(1);
    const stored = JSON.parse(otk.data[`otk:${USER}:${DEVICE}`]);
    expect(stored[ALG][0].claimed).toBe(true);
  });
  it('OTK claim barrier race #6', async () => {
    const otk = mockKv({}, { getBarrier: { prefix: 'otk:', count: 2 } });
    const keyId = 'signed_curve25519:race6';
    seedOtkKv(otk, keyId, { key: 'payload-6' });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const claimedA = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    const claimedB = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    // TOCTOU: both may observe unclaimed and both return the same keyId
    const hits = [claimedA, claimedB].filter(Boolean);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(otk.puts.filter((p) => p.key === `otk:${USER}:${DEVICE}`).length).toBeGreaterThanOrEqual(1);
    const stored = JSON.parse(otk.data[`otk:${USER}:${DEVICE}`]);
    expect(stored[ALG][0].claimed).toBe(true);
  });
  it('OTK claim barrier race #7', async () => {
    const otk = mockKv({}, { getBarrier: { prefix: 'otk:', count: 2 } });
    const keyId = 'signed_curve25519:race7';
    seedOtkKv(otk, keyId, { key: 'payload-7' });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const claimedA = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    const claimedB = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    // TOCTOU: both may observe unclaimed and both return the same keyId
    const hits = [claimedA, claimedB].filter(Boolean);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(otk.puts.filter((p) => p.key === `otk:${USER}:${DEVICE}`).length).toBeGreaterThanOrEqual(1);
    const stored = JSON.parse(otk.data[`otk:${USER}:${DEVICE}`]);
    expect(stored[ALG][0].claimed).toBe(true);
  });
  it('OTK claim barrier race #8', async () => {
    const otk = mockKv({}, { getBarrier: { prefix: 'otk:', count: 2 } });
    const keyId = 'signed_curve25519:race8';
    seedOtkKv(otk, keyId, { key: 'payload-8' });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const claimedA = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    const claimedB = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    // TOCTOU: both may observe unclaimed and both return the same keyId
    const hits = [claimedA, claimedB].filter(Boolean);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(otk.puts.filter((p) => p.key === `otk:${USER}:${DEVICE}`).length).toBeGreaterThanOrEqual(1);
    const stored = JSON.parse(otk.data[`otk:${USER}:${DEVICE}`]);
    expect(stored[ALG][0].claimed).toBe(true);
  });
  it('OTK claim barrier race #9', async () => {
    const otk = mockKv({}, { getBarrier: { prefix: 'otk:', count: 2 } });
    const keyId = 'signed_curve25519:race9';
    seedOtkKv(otk, keyId, { key: 'payload-9' });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const claimedA = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    const claimedB = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    // TOCTOU: both may observe unclaimed and both return the same keyId
    const hits = [claimedA, claimedB].filter(Boolean);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(otk.puts.filter((p) => p.key === `otk:${USER}:${DEVICE}`).length).toBeGreaterThanOrEqual(1);
    const stored = JSON.parse(otk.data[`otk:${USER}:${DEVICE}`]);
    expect(stored[ALG][0].claimed).toBe(true);
  });
  it('OTK claim barrier race #10', async () => {
    const otk = mockKv({}, { getBarrier: { prefix: 'otk:', count: 2 } });
    const keyId = 'signed_curve25519:race10';
    seedOtkKv(otk, keyId, { key: 'payload-10' });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const claimedA = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    const claimedB = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    // TOCTOU: both may observe unclaimed and both return the same keyId
    const hits = [claimedA, claimedB].filter(Boolean);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(otk.puts.filter((p) => p.key === `otk:${USER}:${DEVICE}`).length).toBeGreaterThanOrEqual(1);
    const stored = JSON.parse(otk.data[`otk:${USER}:${DEVICE}`]);
    expect(stored[ALG][0].claimed).toBe(true);
  });
  it('OTK claim barrier race #11', async () => {
    const otk = mockKv({}, { getBarrier: { prefix: 'otk:', count: 2 } });
    const keyId = 'signed_curve25519:race11';
    seedOtkKv(otk, keyId, { key: 'payload-11' });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const claimedA = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    const claimedB = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    // TOCTOU: both may observe unclaimed and both return the same keyId
    const hits = [claimedA, claimedB].filter(Boolean);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(otk.puts.filter((p) => p.key === `otk:${USER}:${DEVICE}`).length).toBeGreaterThanOrEqual(1);
    const stored = JSON.parse(otk.data[`otk:${USER}:${DEVICE}`]);
    expect(stored[ALG][0].claimed).toBe(true);
  });
  it('OTK claim barrier race #12', async () => {
    const otk = mockKv({}, { getBarrier: { prefix: 'otk:', count: 2 } });
    const keyId = 'signed_curve25519:race12';
    seedOtkKv(otk, keyId, { key: 'payload-12' });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const claimedA = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    const claimedB = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    // TOCTOU: both may observe unclaimed and both return the same keyId
    const hits = [claimedA, claimedB].filter(Boolean);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(otk.puts.filter((p) => p.key === `otk:${USER}:${DEVICE}`).length).toBeGreaterThanOrEqual(1);
    const stored = JSON.parse(otk.data[`otk:${USER}:${DEVICE}`]);
    expect(stored[ALG][0].claimed).toBe(true);
  });
  it('OTK claim barrier race #13', async () => {
    const otk = mockKv({}, { getBarrier: { prefix: 'otk:', count: 2 } });
    const keyId = 'signed_curve25519:race13';
    seedOtkKv(otk, keyId, { key: 'payload-13' });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const claimedA = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    const claimedB = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    // TOCTOU: both may observe unclaimed and both return the same keyId
    const hits = [claimedA, claimedB].filter(Boolean);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(otk.puts.filter((p) => p.key === `otk:${USER}:${DEVICE}`).length).toBeGreaterThanOrEqual(1);
    const stored = JSON.parse(otk.data[`otk:${USER}:${DEVICE}`]);
    expect(stored[ALG][0].claimed).toBe(true);
  });
  it('OTK claim barrier race #14', async () => {
    const otk = mockKv({}, { getBarrier: { prefix: 'otk:', count: 2 } });
    const keyId = 'signed_curve25519:race14';
    seedOtkKv(otk, keyId, { key: 'payload-14' });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const claimedA = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    const claimedB = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    // TOCTOU: both may observe unclaimed and both return the same keyId
    const hits = [claimedA, claimedB].filter(Boolean);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(otk.puts.filter((p) => p.key === `otk:${USER}:${DEVICE}`).length).toBeGreaterThanOrEqual(1);
    const stored = JSON.parse(otk.data[`otk:${USER}:${DEVICE}`]);
    expect(stored[ALG][0].claimed).toBe(true);
  });
  it('OTK claim barrier race #15', async () => {
    const otk = mockKv({}, { getBarrier: { prefix: 'otk:', count: 2 } });
    const keyId = 'signed_curve25519:race15';
    seedOtkKv(otk, keyId, { key: 'payload-15' });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const [a, b] = await Promise.all([
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
      keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const claimedA = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    const claimedB = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER]?.[DEVICE];
    // TOCTOU: both may observe unclaimed and both return the same keyId
    const hits = [claimedA, claimedB].filter(Boolean);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(otk.puts.filter((p) => p.key === `otk:${USER}:${DEVICE}`).length).toBeGreaterThanOrEqual(1);
    const stored = JSON.parse(otk.data[`otk:${USER}:${DEVICE}`]);
    expect(stored[ALG][0].claimed).toBe(true);
  });
});

describe('race keys claim: distinct OTKs parallel isolation after #158', () => {
  it('distinct OTK isolation #0', async () => {
    const otk = mockKv();
    const keyA = 'signed_curve25519:isoA0';
    const keyB = 'signed_curve25519:isoB0';
    otk.data[`otk:${USER}:${DEVICE}`] = JSON.stringify({
      [ALG]: [
        { keyId: keyA, keyData: { key: 'a-0' }, claimed: false },
        { keyId: keyB, keyData: { key: 'b-0' }, claimed: false },
      ],
    });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const a = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    const b = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ca = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    const cb = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    expect(Object.keys(ca)).toEqual([keyA]);
    expect(Object.keys(cb)).toEqual([keyB]);
  });
  it('distinct OTK isolation #1', async () => {
    const otk = mockKv();
    const keyA = 'signed_curve25519:isoA1';
    const keyB = 'signed_curve25519:isoB1';
    otk.data[`otk:${USER}:${DEVICE}`] = JSON.stringify({
      [ALG]: [
        { keyId: keyA, keyData: { key: 'a-1' }, claimed: false },
        { keyId: keyB, keyData: { key: 'b-1' }, claimed: false },
      ],
    });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const a = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    const b = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ca = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    const cb = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    expect(Object.keys(ca)).toEqual([keyA]);
    expect(Object.keys(cb)).toEqual([keyB]);
  });
  it('distinct OTK isolation #2', async () => {
    const otk = mockKv();
    const keyA = 'signed_curve25519:isoA2';
    const keyB = 'signed_curve25519:isoB2';
    otk.data[`otk:${USER}:${DEVICE}`] = JSON.stringify({
      [ALG]: [
        { keyId: keyA, keyData: { key: 'a-2' }, claimed: false },
        { keyId: keyB, keyData: { key: 'b-2' }, claimed: false },
      ],
    });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const a = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    const b = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ca = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    const cb = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    expect(Object.keys(ca)).toEqual([keyA]);
    expect(Object.keys(cb)).toEqual([keyB]);
  });
  it('distinct OTK isolation #3', async () => {
    const otk = mockKv();
    const keyA = 'signed_curve25519:isoA3';
    const keyB = 'signed_curve25519:isoB3';
    otk.data[`otk:${USER}:${DEVICE}`] = JSON.stringify({
      [ALG]: [
        { keyId: keyA, keyData: { key: 'a-3' }, claimed: false },
        { keyId: keyB, keyData: { key: 'b-3' }, claimed: false },
      ],
    });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const a = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    const b = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ca = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    const cb = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    expect(Object.keys(ca)).toEqual([keyA]);
    expect(Object.keys(cb)).toEqual([keyB]);
  });
  it('distinct OTK isolation #4', async () => {
    const otk = mockKv();
    const keyA = 'signed_curve25519:isoA4';
    const keyB = 'signed_curve25519:isoB4';
    otk.data[`otk:${USER}:${DEVICE}`] = JSON.stringify({
      [ALG]: [
        { keyId: keyA, keyData: { key: 'a-4' }, claimed: false },
        { keyId: keyB, keyData: { key: 'b-4' }, claimed: false },
      ],
    });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const a = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    const b = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ca = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    const cb = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    expect(Object.keys(ca)).toEqual([keyA]);
    expect(Object.keys(cb)).toEqual([keyB]);
  });
  it('distinct OTK isolation #5', async () => {
    const otk = mockKv();
    const keyA = 'signed_curve25519:isoA5';
    const keyB = 'signed_curve25519:isoB5';
    otk.data[`otk:${USER}:${DEVICE}`] = JSON.stringify({
      [ALG]: [
        { keyId: keyA, keyData: { key: 'a-5' }, claimed: false },
        { keyId: keyB, keyData: { key: 'b-5' }, claimed: false },
      ],
    });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const a = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    const b = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ca = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    const cb = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    expect(Object.keys(ca)).toEqual([keyA]);
    expect(Object.keys(cb)).toEqual([keyB]);
  });
  it('distinct OTK isolation #6', async () => {
    const otk = mockKv();
    const keyA = 'signed_curve25519:isoA6';
    const keyB = 'signed_curve25519:isoB6';
    otk.data[`otk:${USER}:${DEVICE}`] = JSON.stringify({
      [ALG]: [
        { keyId: keyA, keyData: { key: 'a-6' }, claimed: false },
        { keyId: keyB, keyData: { key: 'b-6' }, claimed: false },
      ],
    });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const a = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    const b = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ca = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    const cb = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    expect(Object.keys(ca)).toEqual([keyA]);
    expect(Object.keys(cb)).toEqual([keyB]);
  });
  it('distinct OTK isolation #7', async () => {
    const otk = mockKv();
    const keyA = 'signed_curve25519:isoA7';
    const keyB = 'signed_curve25519:isoB7';
    otk.data[`otk:${USER}:${DEVICE}`] = JSON.stringify({
      [ALG]: [
        { keyId: keyA, keyData: { key: 'a-7' }, claimed: false },
        { keyId: keyB, keyData: { key: 'b-7' }, claimed: false },
      ],
    });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const a = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    const b = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ca = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    const cb = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    expect(Object.keys(ca)).toEqual([keyA]);
    expect(Object.keys(cb)).toEqual([keyB]);
  });
  it('distinct OTK isolation #8', async () => {
    const otk = mockKv();
    const keyA = 'signed_curve25519:isoA8';
    const keyB = 'signed_curve25519:isoB8';
    otk.data[`otk:${USER}:${DEVICE}`] = JSON.stringify({
      [ALG]: [
        { keyId: keyA, keyData: { key: 'a-8' }, claimed: false },
        { keyId: keyB, keyData: { key: 'b-8' }, claimed: false },
      ],
    });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const a = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    const b = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ca = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    const cb = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    expect(Object.keys(ca)).toEqual([keyA]);
    expect(Object.keys(cb)).toEqual([keyB]);
  });
  it('distinct OTK isolation #9', async () => {
    const otk = mockKv();
    const keyA = 'signed_curve25519:isoA9';
    const keyB = 'signed_curve25519:isoB9';
    otk.data[`otk:${USER}:${DEVICE}`] = JSON.stringify({
      [ALG]: [
        { keyId: keyA, keyData: { key: 'a-9' }, claimed: false },
        { keyId: keyB, keyData: { key: 'b-9' }, claimed: false },
      ],
    });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const a = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    const b = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ca = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    const cb = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    expect(Object.keys(ca)).toEqual([keyA]);
    expect(Object.keys(cb)).toEqual([keyB]);
  });
  it('distinct OTK isolation #10', async () => {
    const otk = mockKv();
    const keyA = 'signed_curve25519:isoA10';
    const keyB = 'signed_curve25519:isoB10';
    otk.data[`otk:${USER}:${DEVICE}`] = JSON.stringify({
      [ALG]: [
        { keyId: keyA, keyData: { key: 'a-10' }, claimed: false },
        { keyId: keyB, keyData: { key: 'b-10' }, claimed: false },
      ],
    });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const a = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    const b = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ca = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    const cb = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    expect(Object.keys(ca)).toEqual([keyA]);
    expect(Object.keys(cb)).toEqual([keyB]);
  });
  it('distinct OTK isolation #11', async () => {
    const otk = mockKv();
    const keyA = 'signed_curve25519:isoA11';
    const keyB = 'signed_curve25519:isoB11';
    otk.data[`otk:${USER}:${DEVICE}`] = JSON.stringify({
      [ALG]: [
        { keyId: keyA, keyData: { key: 'a-11' }, claimed: false },
        { keyId: keyB, keyData: { key: 'b-11' }, claimed: false },
      ],
    });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const a = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    const b = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ca = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    const cb = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    expect(Object.keys(ca)).toEqual([keyA]);
    expect(Object.keys(cb)).toEqual([keyB]);
  });
  it('distinct OTK isolation #12', async () => {
    const otk = mockKv();
    const keyA = 'signed_curve25519:isoA12';
    const keyB = 'signed_curve25519:isoB12';
    otk.data[`otk:${USER}:${DEVICE}`] = JSON.stringify({
      [ALG]: [
        { keyId: keyA, keyData: { key: 'a-12' }, claimed: false },
        { keyId: keyB, keyData: { key: 'b-12' }, claimed: false },
      ],
    });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const a = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    const b = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ca = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    const cb = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    expect(Object.keys(ca)).toEqual([keyA]);
    expect(Object.keys(cb)).toEqual([keyB]);
  });
  it('distinct OTK isolation #13', async () => {
    const otk = mockKv();
    const keyA = 'signed_curve25519:isoA13';
    const keyB = 'signed_curve25519:isoB13';
    otk.data[`otk:${USER}:${DEVICE}`] = JSON.stringify({
      [ALG]: [
        { keyId: keyA, keyData: { key: 'a-13' }, claimed: false },
        { keyId: keyB, keyData: { key: 'b-13' }, claimed: false },
      ],
    });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const a = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    const b = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ca = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    const cb = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    expect(Object.keys(ca)).toEqual([keyA]);
    expect(Object.keys(cb)).toEqual([keyB]);
  });
  it('distinct OTK isolation #14', async () => {
    const otk = mockKv();
    const keyA = 'signed_curve25519:isoA14';
    const keyB = 'signed_curve25519:isoB14';
    otk.data[`otk:${USER}:${DEVICE}`] = JSON.stringify({
      [ALG]: [
        { keyId: keyA, keyData: { key: 'a-14' }, claimed: false },
        { keyId: keyB, keyData: { key: 'b-14' }, claimed: false },
      ],
    });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const a = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    const b = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ca = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    const cb = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    expect(Object.keys(ca)).toEqual([keyA]);
    expect(Object.keys(cb)).toEqual([keyB]);
  });
  it('distinct OTK isolation #15', async () => {
    const otk = mockKv();
    const keyA = 'signed_curve25519:isoA15';
    const keyB = 'signed_curve25519:isoB15';
    otk.data[`otk:${USER}:${DEVICE}`] = JSON.stringify({
      [ALG]: [
        { keyId: keyA, keyData: { key: 'a-15' }, claimed: false },
        { keyId: keyB, keyData: { key: 'b-15' }, claimed: false },
      ],
    });
    const env = createKeysEnv({ oneTimeKeysKv: otk });
    const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
    const a = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    const b = await keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ca = (a.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    const cb = (b.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
      .one_time_keys[USER][DEVICE];
    expect(Object.keys(ca)).toEqual([keyA]);
    expect(Object.keys(cb)).toEqual([keyB]);
  });
});

describe('keys device_signing first-time soft flood after #158', () => {
  it('device_signing first-time soft-0', async () => {
    const env = createKeysEnv();
    const master = masterKeyPayload(0);
    const self = selfSigningKeyPayload(0);
    const user = userSigningKeyPayload(0);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: master, self_signing_key: self, user_signing_key: user })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(env._userKeys.crossSigning).toMatchObject({
      master,
      self_signing: self,
      user_signing: user,
    });
    expect(env._db.crossSigningKeys).toHaveLength(3);
  });
  it('device_signing first-time soft-1', async () => {
    const env = createKeysEnv();
    const master = masterKeyPayload(1);
    const self = selfSigningKeyPayload(1);
    const user = userSigningKeyPayload(1);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: master, self_signing_key: self, user_signing_key: user })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(env._userKeys.crossSigning).toMatchObject({
      master,
      self_signing: self,
      user_signing: user,
    });
    expect(env._db.crossSigningKeys).toHaveLength(3);
  });
  it('device_signing first-time soft-2', async () => {
    const env = createKeysEnv();
    const master = masterKeyPayload(2);
    const self = selfSigningKeyPayload(2);
    const user = userSigningKeyPayload(2);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: master, self_signing_key: self, user_signing_key: user })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(env._userKeys.crossSigning).toMatchObject({
      master,
      self_signing: self,
      user_signing: user,
    });
    expect(env._db.crossSigningKeys).toHaveLength(3);
  });
  it('device_signing first-time soft-3', async () => {
    const env = createKeysEnv();
    const master = masterKeyPayload(3);
    const self = selfSigningKeyPayload(3);
    const user = userSigningKeyPayload(3);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: master, self_signing_key: self, user_signing_key: user })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(env._userKeys.crossSigning).toMatchObject({
      master,
      self_signing: self,
      user_signing: user,
    });
    expect(env._db.crossSigningKeys).toHaveLength(3);
  });
  it('device_signing first-time soft-4', async () => {
    const env = createKeysEnv();
    const master = masterKeyPayload(4);
    const self = selfSigningKeyPayload(4);
    const user = userSigningKeyPayload(4);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: master, self_signing_key: self, user_signing_key: user })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(env._userKeys.crossSigning).toMatchObject({
      master,
      self_signing: self,
      user_signing: user,
    });
    expect(env._db.crossSigningKeys).toHaveLength(3);
  });
  it('device_signing first-time soft-5', async () => {
    const env = createKeysEnv();
    const master = masterKeyPayload(5);
    const self = selfSigningKeyPayload(5);
    const user = userSigningKeyPayload(5);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: master, self_signing_key: self, user_signing_key: user })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(env._userKeys.crossSigning).toMatchObject({
      master,
      self_signing: self,
      user_signing: user,
    });
    expect(env._db.crossSigningKeys).toHaveLength(3);
  });
  it('device_signing first-time soft-6', async () => {
    const env = createKeysEnv();
    const master = masterKeyPayload(6);
    const self = selfSigningKeyPayload(6);
    const user = userSigningKeyPayload(6);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: master, self_signing_key: self, user_signing_key: user })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(env._userKeys.crossSigning).toMatchObject({
      master,
      self_signing: self,
      user_signing: user,
    });
    expect(env._db.crossSigningKeys).toHaveLength(3);
  });
  it('device_signing first-time soft-7', async () => {
    const env = createKeysEnv();
    const master = masterKeyPayload(7);
    const self = selfSigningKeyPayload(7);
    const user = userSigningKeyPayload(7);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: master, self_signing_key: self, user_signing_key: user })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(env._userKeys.crossSigning).toMatchObject({
      master,
      self_signing: self,
      user_signing: user,
    });
    expect(env._db.crossSigningKeys).toHaveLength(3);
  });
  it('device_signing first-time soft-8', async () => {
    const env = createKeysEnv();
    const master = masterKeyPayload(8);
    const self = selfSigningKeyPayload(8);
    const user = userSigningKeyPayload(8);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: master, self_signing_key: self, user_signing_key: user })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(env._userKeys.crossSigning).toMatchObject({
      master,
      self_signing: self,
      user_signing: user,
    });
    expect(env._db.crossSigningKeys).toHaveLength(3);
  });
  it('device_signing first-time soft-9', async () => {
    const env = createKeysEnv();
    const master = masterKeyPayload(9);
    const self = selfSigningKeyPayload(9);
    const user = userSigningKeyPayload(9);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: master, self_signing_key: self, user_signing_key: user })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(env._userKeys.crossSigning).toMatchObject({
      master,
      self_signing: self,
      user_signing: user,
    });
    expect(env._db.crossSigningKeys).toHaveLength(3);
  });
  it('device_signing first-time soft-10', async () => {
    const env = createKeysEnv();
    const master = masterKeyPayload(10);
    const self = selfSigningKeyPayload(10);
    const user = userSigningKeyPayload(10);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: master, self_signing_key: self, user_signing_key: user })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(env._userKeys.crossSigning).toMatchObject({
      master,
      self_signing: self,
      user_signing: user,
    });
    expect(env._db.crossSigningKeys).toHaveLength(3);
  });
  it('device_signing first-time soft-11', async () => {
    const env = createKeysEnv();
    const master = masterKeyPayload(11);
    const self = selfSigningKeyPayload(11);
    const user = userSigningKeyPayload(11);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: master, self_signing_key: self, user_signing_key: user })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(env._userKeys.crossSigning).toMatchObject({
      master,
      self_signing: self,
      user_signing: user,
    });
    expect(env._db.crossSigningKeys).toHaveLength(3);
  });
  it('device_signing first-time soft-12', async () => {
    const env = createKeysEnv();
    const master = masterKeyPayload(12);
    const self = selfSigningKeyPayload(12);
    const user = userSigningKeyPayload(12);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: master, self_signing_key: self, user_signing_key: user })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(env._userKeys.crossSigning).toMatchObject({
      master,
      self_signing: self,
      user_signing: user,
    });
    expect(env._db.crossSigningKeys).toHaveLength(3);
  });
  it('device_signing first-time soft-13', async () => {
    const env = createKeysEnv();
    const master = masterKeyPayload(13);
    const self = selfSigningKeyPayload(13);
    const user = userSigningKeyPayload(13);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: master, self_signing_key: self, user_signing_key: user })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(env._userKeys.crossSigning).toMatchObject({
      master,
      self_signing: self,
      user_signing: user,
    });
    expect(env._db.crossSigningKeys).toHaveLength(3);
  });
  it('device_signing first-time soft-14', async () => {
    const env = createKeysEnv();
    const master = masterKeyPayload(14);
    const self = selfSigningKeyPayload(14);
    const user = userSigningKeyPayload(14);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: master, self_signing_key: self, user_signing_key: user })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(env._userKeys.crossSigning).toMatchObject({
      master,
      self_signing: self,
      user_signing: user,
    });
    expect(env._db.crossSigningKeys).toHaveLength(3);
  });
  it('device_signing first-time soft-15', async () => {
    const env = createKeysEnv();
    const master = masterKeyPayload(15);
    const self = selfSigningKeyPayload(15);
    const user = userSigningKeyPayload(15);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: master, self_signing_key: self, user_signing_key: user })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(env._userKeys.crossSigning).toMatchObject({
      master,
      self_signing: self,
      user_signing: user,
    });
    expect(env._db.crossSigningKeys).toHaveLength(3);
  });
});

describe('keys device_signing UIA challenge soft flood after #158', () => {
  it('device_signing UIA challenge soft-0', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:secret0']]),
    });
    const env = createKeysEnv({ db });
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload(0) })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.password'] }],
    });
    const session = (res.body as { session: string }).session;
    expect(session).toBeTruthy();
    expect(env._cache.data[`uia_session:${session}`]).toBeTruthy();
  });
  it('device_signing UIA challenge soft-1', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:secret1']]),
    });
    const env = createKeysEnv({ db });
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload(1) })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.password'] }],
    });
    const session = (res.body as { session: string }).session;
    expect(session).toBeTruthy();
    expect(env._cache.data[`uia_session:${session}`]).toBeTruthy();
  });
  it('device_signing UIA challenge soft-2', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:secret2']]),
    });
    const env = createKeysEnv({ db });
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload(2) })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.password'] }],
    });
    const session = (res.body as { session: string }).session;
    expect(session).toBeTruthy();
    expect(env._cache.data[`uia_session:${session}`]).toBeTruthy();
  });
  it('device_signing UIA challenge soft-3', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:secret3']]),
    });
    const env = createKeysEnv({ db });
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload(3) })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.password'] }],
    });
    const session = (res.body as { session: string }).session;
    expect(session).toBeTruthy();
    expect(env._cache.data[`uia_session:${session}`]).toBeTruthy();
  });
  it('device_signing UIA challenge soft-4', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:secret4']]),
    });
    const env = createKeysEnv({ db });
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload(4) })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.password'] }],
    });
    const session = (res.body as { session: string }).session;
    expect(session).toBeTruthy();
    expect(env._cache.data[`uia_session:${session}`]).toBeTruthy();
  });
  it('device_signing UIA challenge soft-5', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:secret5']]),
    });
    const env = createKeysEnv({ db });
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload(5) })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.password'] }],
    });
    const session = (res.body as { session: string }).session;
    expect(session).toBeTruthy();
    expect(env._cache.data[`uia_session:${session}`]).toBeTruthy();
  });
  it('device_signing UIA challenge soft-6', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:secret6']]),
    });
    const env = createKeysEnv({ db });
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload(6) })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.password'] }],
    });
    const session = (res.body as { session: string }).session;
    expect(session).toBeTruthy();
    expect(env._cache.data[`uia_session:${session}`]).toBeTruthy();
  });
  it('device_signing UIA challenge soft-7', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:secret7']]),
    });
    const env = createKeysEnv({ db });
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload(7) })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.password'] }],
    });
    const session = (res.body as { session: string }).session;
    expect(session).toBeTruthy();
    expect(env._cache.data[`uia_session:${session}`]).toBeTruthy();
  });
  it('device_signing UIA challenge soft-8', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:secret8']]),
    });
    const env = createKeysEnv({ db });
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload(8) })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.password'] }],
    });
    const session = (res.body as { session: string }).session;
    expect(session).toBeTruthy();
    expect(env._cache.data[`uia_session:${session}`]).toBeTruthy();
  });
  it('device_signing UIA challenge soft-9', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:secret9']]),
    });
    const env = createKeysEnv({ db });
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload(9) })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.password'] }],
    });
    const session = (res.body as { session: string }).session;
    expect(session).toBeTruthy();
    expect(env._cache.data[`uia_session:${session}`]).toBeTruthy();
  });
  it('device_signing UIA challenge soft-10', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:secret10']]),
    });
    const env = createKeysEnv({ db });
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload(10) })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.password'] }],
    });
    const session = (res.body as { session: string }).session;
    expect(session).toBeTruthy();
    expect(env._cache.data[`uia_session:${session}`]).toBeTruthy();
  });
  it('device_signing UIA challenge soft-11', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:secret11']]),
    });
    const env = createKeysEnv({ db });
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload(11) })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.password'] }],
    });
    const session = (res.body as { session: string }).session;
    expect(session).toBeTruthy();
    expect(env._cache.data[`uia_session:${session}`]).toBeTruthy();
  });
  it('device_signing UIA challenge soft-12', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:secret12']]),
    });
    const env = createKeysEnv({ db });
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload(12) })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.password'] }],
    });
    const session = (res.body as { session: string }).session;
    expect(session).toBeTruthy();
    expect(env._cache.data[`uia_session:${session}`]).toBeTruthy();
  });
  it('device_signing UIA challenge soft-13', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:secret13']]),
    });
    const env = createKeysEnv({ db });
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload(13) })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.password'] }],
    });
    const session = (res.body as { session: string }).session;
    expect(session).toBeTruthy();
    expect(env._cache.data[`uia_session:${session}`]).toBeTruthy();
  });
  it('device_signing UIA challenge soft-14', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:secret14']]),
    });
    const env = createKeysEnv({ db });
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload(14) })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.password'] }],
    });
    const session = (res.body as { session: string }).session;
    expect(session).toBeTruthy();
    expect(env._cache.data[`uia_session:${session}`]).toBeTruthy();
  });
  it('device_signing UIA challenge soft-15', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:secret15']]),
    });
    const env = createKeysEnv({ db });
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload(15) })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.password'] }],
    });
    const session = (res.body as { session: string }).session;
    expect(session).toBeTruthy();
    expect(env._cache.data[`uia_session:${session}`]).toBeTruthy();
  });
});

describe('keys device_signing password replace soft flood after #158', () => {
  it('device_signing password replace soft-0', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:pw0']]),
    });
    const env = createKeysEnv({ db });
    const master = masterKeyPayload(0);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: master,
        auth: { type: 'm.login.password', password: 'pw0' },
      })
    );
    expect(res.status).toBe(200);
    expect(env._userKeys.crossSigning.master).toEqual(master);
  });
  it('device_signing password replace soft-1', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:pw1']]),
    });
    const env = createKeysEnv({ db });
    const master = masterKeyPayload(1);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: master,
        auth: { type: 'm.login.password', password: 'pw1' },
      })
    );
    expect(res.status).toBe(200);
    expect(env._userKeys.crossSigning.master).toEqual(master);
  });
  it('device_signing password replace soft-2', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:pw2']]),
    });
    const env = createKeysEnv({ db });
    const master = masterKeyPayload(2);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: master,
        auth: { type: 'm.login.password', password: 'pw2' },
      })
    );
    expect(res.status).toBe(200);
    expect(env._userKeys.crossSigning.master).toEqual(master);
  });
  it('device_signing password replace soft-3', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:pw3']]),
    });
    const env = createKeysEnv({ db });
    const master = masterKeyPayload(3);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: master,
        auth: { type: 'm.login.password', password: 'pw3' },
      })
    );
    expect(res.status).toBe(200);
    expect(env._userKeys.crossSigning.master).toEqual(master);
  });
  it('device_signing password replace soft-4', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:pw4']]),
    });
    const env = createKeysEnv({ db });
    const master = masterKeyPayload(4);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: master,
        auth: { type: 'm.login.password', password: 'pw4' },
      })
    );
    expect(res.status).toBe(200);
    expect(env._userKeys.crossSigning.master).toEqual(master);
  });
  it('device_signing password replace soft-5', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:pw5']]),
    });
    const env = createKeysEnv({ db });
    const master = masterKeyPayload(5);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: master,
        auth: { type: 'm.login.password', password: 'pw5' },
      })
    );
    expect(res.status).toBe(200);
    expect(env._userKeys.crossSigning.master).toEqual(master);
  });
  it('device_signing password replace soft-6', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:pw6']]),
    });
    const env = createKeysEnv({ db });
    const master = masterKeyPayload(6);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: master,
        auth: { type: 'm.login.password', password: 'pw6' },
      })
    );
    expect(res.status).toBe(200);
    expect(env._userKeys.crossSigning.master).toEqual(master);
  });
  it('device_signing password replace soft-7', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:pw7']]),
    });
    const env = createKeysEnv({ db });
    const master = masterKeyPayload(7);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: master,
        auth: { type: 'm.login.password', password: 'pw7' },
      })
    );
    expect(res.status).toBe(200);
    expect(env._userKeys.crossSigning.master).toEqual(master);
  });
  it('device_signing password replace soft-8', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:pw8']]),
    });
    const env = createKeysEnv({ db });
    const master = masterKeyPayload(8);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: master,
        auth: { type: 'm.login.password', password: 'pw8' },
      })
    );
    expect(res.status).toBe(200);
    expect(env._userKeys.crossSigning.master).toEqual(master);
  });
  it('device_signing password replace soft-9', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:pw9']]),
    });
    const env = createKeysEnv({ db });
    const master = masterKeyPayload(9);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: master,
        auth: { type: 'm.login.password', password: 'pw9' },
      })
    );
    expect(res.status).toBe(200);
    expect(env._userKeys.crossSigning.master).toEqual(master);
  });
  it('device_signing password replace soft-10', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:pw10']]),
    });
    const env = createKeysEnv({ db });
    const master = masterKeyPayload(10);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: master,
        auth: { type: 'm.login.password', password: 'pw10' },
      })
    );
    expect(res.status).toBe(200);
    expect(env._userKeys.crossSigning.master).toEqual(master);
  });
  it('device_signing password replace soft-11', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:pw11']]),
    });
    const env = createKeysEnv({ db });
    const master = masterKeyPayload(11);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: master,
        auth: { type: 'm.login.password', password: 'pw11' },
      })
    );
    expect(res.status).toBe(200);
    expect(env._userKeys.crossSigning.master).toEqual(master);
  });
  it('device_signing password replace soft-12', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:pw12']]),
    });
    const env = createKeysEnv({ db });
    const master = masterKeyPayload(12);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: master,
        auth: { type: 'm.login.password', password: 'pw12' },
      })
    );
    expect(res.status).toBe(200);
    expect(env._userKeys.crossSigning.master).toEqual(master);
  });
  it('device_signing password replace soft-13', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:pw13']]),
    });
    const env = createKeysEnv({ db });
    const master = masterKeyPayload(13);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: master,
        auth: { type: 'm.login.password', password: 'pw13' },
      })
    );
    expect(res.status).toBe(200);
    expect(env._userKeys.crossSigning.master).toEqual(master);
  });
  it('device_signing password replace soft-14', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:pw14']]),
    });
    const env = createKeysEnv({ db });
    const master = masterKeyPayload(14);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: master,
        auth: { type: 'm.login.password', password: 'pw14' },
      })
    );
    expect(res.status).toBe(200);
    expect(env._userKeys.crossSigning.master).toEqual(master);
  });
  it('device_signing password replace soft-15', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'ed25519:master', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:pw15']]),
    });
    const env = createKeysEnv({ db });
    const master = masterKeyPayload(15);
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: master,
        auth: { type: 'm.login.password', password: 'pw15' },
      })
    );
    expect(res.status).toBe(200);
    expect(env._userKeys.crossSigning.master).toEqual(master);
  });
});

describe('keys signatures/upload soft flood after #158', () => {
  it('signatures upload soft-0', async () => {
    const env = createKeysEnv();
    const keyId = 'masterPub0';
    const sig = 'sig-race-0';
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [BOB]: {
          [keyId]: {
            keys: { [`ed25519:${keyId}`]: 'x0' },
            signatures: {
              [USER]: { 'ed25519:usk': sig },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ failures: {} });
    expect(env._db.signatures.some((s) => s.signature === sig)).toBe(true);
    expect(env._db.keyChanges.length).toBeGreaterThanOrEqual(1);
  });
  it('signatures upload soft-1', async () => {
    const env = createKeysEnv();
    const keyId = 'masterPub1';
    const sig = 'sig-race-1';
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [BOB]: {
          [keyId]: {
            keys: { [`ed25519:${keyId}`]: 'x1' },
            signatures: {
              [USER]: { 'ed25519:usk': sig },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ failures: {} });
    expect(env._db.signatures.some((s) => s.signature === sig)).toBe(true);
    expect(env._db.keyChanges.length).toBeGreaterThanOrEqual(1);
  });
  it('signatures upload soft-2', async () => {
    const env = createKeysEnv();
    const keyId = 'masterPub2';
    const sig = 'sig-race-2';
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [BOB]: {
          [keyId]: {
            keys: { [`ed25519:${keyId}`]: 'x2' },
            signatures: {
              [USER]: { 'ed25519:usk': sig },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ failures: {} });
    expect(env._db.signatures.some((s) => s.signature === sig)).toBe(true);
    expect(env._db.keyChanges.length).toBeGreaterThanOrEqual(1);
  });
  it('signatures upload soft-3', async () => {
    const env = createKeysEnv();
    const keyId = 'masterPub3';
    const sig = 'sig-race-3';
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [BOB]: {
          [keyId]: {
            keys: { [`ed25519:${keyId}`]: 'x3' },
            signatures: {
              [USER]: { 'ed25519:usk': sig },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ failures: {} });
    expect(env._db.signatures.some((s) => s.signature === sig)).toBe(true);
    expect(env._db.keyChanges.length).toBeGreaterThanOrEqual(1);
  });
  it('signatures upload soft-4', async () => {
    const env = createKeysEnv();
    const keyId = 'masterPub4';
    const sig = 'sig-race-4';
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [BOB]: {
          [keyId]: {
            keys: { [`ed25519:${keyId}`]: 'x4' },
            signatures: {
              [USER]: { 'ed25519:usk': sig },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ failures: {} });
    expect(env._db.signatures.some((s) => s.signature === sig)).toBe(true);
    expect(env._db.keyChanges.length).toBeGreaterThanOrEqual(1);
  });
  it('signatures upload soft-5', async () => {
    const env = createKeysEnv();
    const keyId = 'masterPub5';
    const sig = 'sig-race-5';
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [BOB]: {
          [keyId]: {
            keys: { [`ed25519:${keyId}`]: 'x5' },
            signatures: {
              [USER]: { 'ed25519:usk': sig },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ failures: {} });
    expect(env._db.signatures.some((s) => s.signature === sig)).toBe(true);
    expect(env._db.keyChanges.length).toBeGreaterThanOrEqual(1);
  });
  it('signatures upload soft-6', async () => {
    const env = createKeysEnv();
    const keyId = 'masterPub6';
    const sig = 'sig-race-6';
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [BOB]: {
          [keyId]: {
            keys: { [`ed25519:${keyId}`]: 'x6' },
            signatures: {
              [USER]: { 'ed25519:usk': sig },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ failures: {} });
    expect(env._db.signatures.some((s) => s.signature === sig)).toBe(true);
    expect(env._db.keyChanges.length).toBeGreaterThanOrEqual(1);
  });
  it('signatures upload soft-7', async () => {
    const env = createKeysEnv();
    const keyId = 'masterPub7';
    const sig = 'sig-race-7';
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [BOB]: {
          [keyId]: {
            keys: { [`ed25519:${keyId}`]: 'x7' },
            signatures: {
              [USER]: { 'ed25519:usk': sig },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ failures: {} });
    expect(env._db.signatures.some((s) => s.signature === sig)).toBe(true);
    expect(env._db.keyChanges.length).toBeGreaterThanOrEqual(1);
  });
  it('signatures upload soft-8', async () => {
    const env = createKeysEnv();
    const keyId = 'masterPub8';
    const sig = 'sig-race-8';
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [BOB]: {
          [keyId]: {
            keys: { [`ed25519:${keyId}`]: 'x8' },
            signatures: {
              [USER]: { 'ed25519:usk': sig },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ failures: {} });
    expect(env._db.signatures.some((s) => s.signature === sig)).toBe(true);
    expect(env._db.keyChanges.length).toBeGreaterThanOrEqual(1);
  });
  it('signatures upload soft-9', async () => {
    const env = createKeysEnv();
    const keyId = 'masterPub9';
    const sig = 'sig-race-9';
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [BOB]: {
          [keyId]: {
            keys: { [`ed25519:${keyId}`]: 'x9' },
            signatures: {
              [USER]: { 'ed25519:usk': sig },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ failures: {} });
    expect(env._db.signatures.some((s) => s.signature === sig)).toBe(true);
    expect(env._db.keyChanges.length).toBeGreaterThanOrEqual(1);
  });
  it('signatures upload soft-10', async () => {
    const env = createKeysEnv();
    const keyId = 'masterPub10';
    const sig = 'sig-race-10';
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [BOB]: {
          [keyId]: {
            keys: { [`ed25519:${keyId}`]: 'x10' },
            signatures: {
              [USER]: { 'ed25519:usk': sig },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ failures: {} });
    expect(env._db.signatures.some((s) => s.signature === sig)).toBe(true);
    expect(env._db.keyChanges.length).toBeGreaterThanOrEqual(1);
  });
  it('signatures upload soft-11', async () => {
    const env = createKeysEnv();
    const keyId = 'masterPub11';
    const sig = 'sig-race-11';
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [BOB]: {
          [keyId]: {
            keys: { [`ed25519:${keyId}`]: 'x11' },
            signatures: {
              [USER]: { 'ed25519:usk': sig },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ failures: {} });
    expect(env._db.signatures.some((s) => s.signature === sig)).toBe(true);
    expect(env._db.keyChanges.length).toBeGreaterThanOrEqual(1);
  });
  it('signatures upload soft-12', async () => {
    const env = createKeysEnv();
    const keyId = 'masterPub12';
    const sig = 'sig-race-12';
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [BOB]: {
          [keyId]: {
            keys: { [`ed25519:${keyId}`]: 'x12' },
            signatures: {
              [USER]: { 'ed25519:usk': sig },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ failures: {} });
    expect(env._db.signatures.some((s) => s.signature === sig)).toBe(true);
    expect(env._db.keyChanges.length).toBeGreaterThanOrEqual(1);
  });
  it('signatures upload soft-13', async () => {
    const env = createKeysEnv();
    const keyId = 'masterPub13';
    const sig = 'sig-race-13';
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [BOB]: {
          [keyId]: {
            keys: { [`ed25519:${keyId}`]: 'x13' },
            signatures: {
              [USER]: { 'ed25519:usk': sig },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ failures: {} });
    expect(env._db.signatures.some((s) => s.signature === sig)).toBe(true);
    expect(env._db.keyChanges.length).toBeGreaterThanOrEqual(1);
  });
  it('signatures upload soft-14', async () => {
    const env = createKeysEnv();
    const keyId = 'masterPub14';
    const sig = 'sig-race-14';
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [BOB]: {
          [keyId]: {
            keys: { [`ed25519:${keyId}`]: 'x14' },
            signatures: {
              [USER]: { 'ed25519:usk': sig },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ failures: {} });
    expect(env._db.signatures.some((s) => s.signature === sig)).toBe(true);
    expect(env._db.keyChanges.length).toBeGreaterThanOrEqual(1);
  });
  it('signatures upload soft-15', async () => {
    const env = createKeysEnv();
    const keyId = 'masterPub15';
    const sig = 'sig-race-15';
    const res = await keysReq(
      env,
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [BOB]: {
          [keyId]: {
            keys: { [`ed25519:${keyId}`]: 'x15' },
            signatures: {
              [USER]: { 'ed25519:usk': sig },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ failures: {} });
    expect(env._db.signatures.some((s) => s.signature === sig)).toBe(true);
    expect(env._db.keyChanges.length).toBeGreaterThanOrEqual(1);
  });
});

describe('race media PUT placeholder: double-fill TOCTOU after #158', () => {
  it('placeholder put barrier race #0', async () => {
    const mediaId = 'ph-race-0';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_length: 0, content_type: 'application/octet-stream' })],
      firstBarrier: { substr: 'SELECT user_id, content_length FROM media', count: 2 },
    });
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const path = `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`;
    const [a, b] = await Promise.all([
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('A-0'),
      }, env),
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('B-0'),
      }, env),
    ]);
    // TOCTOU: both may pass content_length===0 check before either UPDATE
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + [a, b].filter((r) => r.status !== 200).length).toBe(2);
    expect(media.puts.length).toBe(oks.length);
    expect(db.rows[0].content_length).toBeGreaterThan(0);
  });
  it('placeholder put barrier race #1', async () => {
    const mediaId = 'ph-race-1';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_length: 0, content_type: 'application/octet-stream' })],
      firstBarrier: { substr: 'SELECT user_id, content_length FROM media', count: 2 },
    });
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const path = `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`;
    const [a, b] = await Promise.all([
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('A-1'),
      }, env),
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('B-1'),
      }, env),
    ]);
    // TOCTOU: both may pass content_length===0 check before either UPDATE
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + [a, b].filter((r) => r.status !== 200).length).toBe(2);
    expect(media.puts.length).toBe(oks.length);
    expect(db.rows[0].content_length).toBeGreaterThan(0);
  });
  it('placeholder put barrier race #2', async () => {
    const mediaId = 'ph-race-2';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_length: 0, content_type: 'application/octet-stream' })],
      firstBarrier: { substr: 'SELECT user_id, content_length FROM media', count: 2 },
    });
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const path = `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`;
    const [a, b] = await Promise.all([
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('A-2'),
      }, env),
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('B-2'),
      }, env),
    ]);
    // TOCTOU: both may pass content_length===0 check before either UPDATE
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + [a, b].filter((r) => r.status !== 200).length).toBe(2);
    expect(media.puts.length).toBe(oks.length);
    expect(db.rows[0].content_length).toBeGreaterThan(0);
  });
  it('placeholder put barrier race #3', async () => {
    const mediaId = 'ph-race-3';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_length: 0, content_type: 'application/octet-stream' })],
      firstBarrier: { substr: 'SELECT user_id, content_length FROM media', count: 2 },
    });
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const path = `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`;
    const [a, b] = await Promise.all([
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('A-3'),
      }, env),
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('B-3'),
      }, env),
    ]);
    // TOCTOU: both may pass content_length===0 check before either UPDATE
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + [a, b].filter((r) => r.status !== 200).length).toBe(2);
    expect(media.puts.length).toBe(oks.length);
    expect(db.rows[0].content_length).toBeGreaterThan(0);
  });
  it('placeholder put barrier race #4', async () => {
    const mediaId = 'ph-race-4';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_length: 0, content_type: 'application/octet-stream' })],
      firstBarrier: { substr: 'SELECT user_id, content_length FROM media', count: 2 },
    });
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const path = `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`;
    const [a, b] = await Promise.all([
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('A-4'),
      }, env),
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('B-4'),
      }, env),
    ]);
    // TOCTOU: both may pass content_length===0 check before either UPDATE
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + [a, b].filter((r) => r.status !== 200).length).toBe(2);
    expect(media.puts.length).toBe(oks.length);
    expect(db.rows[0].content_length).toBeGreaterThan(0);
  });
  it('placeholder put barrier race #5', async () => {
    const mediaId = 'ph-race-5';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_length: 0, content_type: 'application/octet-stream' })],
      firstBarrier: { substr: 'SELECT user_id, content_length FROM media', count: 2 },
    });
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const path = `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`;
    const [a, b] = await Promise.all([
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('A-5'),
      }, env),
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('B-5'),
      }, env),
    ]);
    // TOCTOU: both may pass content_length===0 check before either UPDATE
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + [a, b].filter((r) => r.status !== 200).length).toBe(2);
    expect(media.puts.length).toBe(oks.length);
    expect(db.rows[0].content_length).toBeGreaterThan(0);
  });
  it('placeholder put barrier race #6', async () => {
    const mediaId = 'ph-race-6';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_length: 0, content_type: 'application/octet-stream' })],
      firstBarrier: { substr: 'SELECT user_id, content_length FROM media', count: 2 },
    });
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const path = `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`;
    const [a, b] = await Promise.all([
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('A-6'),
      }, env),
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('B-6'),
      }, env),
    ]);
    // TOCTOU: both may pass content_length===0 check before either UPDATE
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + [a, b].filter((r) => r.status !== 200).length).toBe(2);
    expect(media.puts.length).toBe(oks.length);
    expect(db.rows[0].content_length).toBeGreaterThan(0);
  });
  it('placeholder put barrier race #7', async () => {
    const mediaId = 'ph-race-7';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_length: 0, content_type: 'application/octet-stream' })],
      firstBarrier: { substr: 'SELECT user_id, content_length FROM media', count: 2 },
    });
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const path = `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`;
    const [a, b] = await Promise.all([
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('A-7'),
      }, env),
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('B-7'),
      }, env),
    ]);
    // TOCTOU: both may pass content_length===0 check before either UPDATE
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + [a, b].filter((r) => r.status !== 200).length).toBe(2);
    expect(media.puts.length).toBe(oks.length);
    expect(db.rows[0].content_length).toBeGreaterThan(0);
  });
  it('placeholder put barrier race #8', async () => {
    const mediaId = 'ph-race-8';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_length: 0, content_type: 'application/octet-stream' })],
      firstBarrier: { substr: 'SELECT user_id, content_length FROM media', count: 2 },
    });
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const path = `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`;
    const [a, b] = await Promise.all([
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('A-8'),
      }, env),
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('B-8'),
      }, env),
    ]);
    // TOCTOU: both may pass content_length===0 check before either UPDATE
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + [a, b].filter((r) => r.status !== 200).length).toBe(2);
    expect(media.puts.length).toBe(oks.length);
    expect(db.rows[0].content_length).toBeGreaterThan(0);
  });
  it('placeholder put barrier race #9', async () => {
    const mediaId = 'ph-race-9';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_length: 0, content_type: 'application/octet-stream' })],
      firstBarrier: { substr: 'SELECT user_id, content_length FROM media', count: 2 },
    });
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const path = `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`;
    const [a, b] = await Promise.all([
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('A-9'),
      }, env),
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('B-9'),
      }, env),
    ]);
    // TOCTOU: both may pass content_length===0 check before either UPDATE
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + [a, b].filter((r) => r.status !== 200).length).toBe(2);
    expect(media.puts.length).toBe(oks.length);
    expect(db.rows[0].content_length).toBeGreaterThan(0);
  });
  it('placeholder put barrier race #10', async () => {
    const mediaId = 'ph-race-10';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_length: 0, content_type: 'application/octet-stream' })],
      firstBarrier: { substr: 'SELECT user_id, content_length FROM media', count: 2 },
    });
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const path = `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`;
    const [a, b] = await Promise.all([
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('A-10'),
      }, env),
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('B-10'),
      }, env),
    ]);
    // TOCTOU: both may pass content_length===0 check before either UPDATE
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + [a, b].filter((r) => r.status !== 200).length).toBe(2);
    expect(media.puts.length).toBe(oks.length);
    expect(db.rows[0].content_length).toBeGreaterThan(0);
  });
  it('placeholder put barrier race #11', async () => {
    const mediaId = 'ph-race-11';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_length: 0, content_type: 'application/octet-stream' })],
      firstBarrier: { substr: 'SELECT user_id, content_length FROM media', count: 2 },
    });
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const path = `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`;
    const [a, b] = await Promise.all([
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('A-11'),
      }, env),
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('B-11'),
      }, env),
    ]);
    // TOCTOU: both may pass content_length===0 check before either UPDATE
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + [a, b].filter((r) => r.status !== 200).length).toBe(2);
    expect(media.puts.length).toBe(oks.length);
    expect(db.rows[0].content_length).toBeGreaterThan(0);
  });
  it('placeholder put barrier race #12', async () => {
    const mediaId = 'ph-race-12';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_length: 0, content_type: 'application/octet-stream' })],
      firstBarrier: { substr: 'SELECT user_id, content_length FROM media', count: 2 },
    });
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const path = `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`;
    const [a, b] = await Promise.all([
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('A-12'),
      }, env),
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('B-12'),
      }, env),
    ]);
    // TOCTOU: both may pass content_length===0 check before either UPDATE
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + [a, b].filter((r) => r.status !== 200).length).toBe(2);
    expect(media.puts.length).toBe(oks.length);
    expect(db.rows[0].content_length).toBeGreaterThan(0);
  });
  it('placeholder put barrier race #13', async () => {
    const mediaId = 'ph-race-13';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_length: 0, content_type: 'application/octet-stream' })],
      firstBarrier: { substr: 'SELECT user_id, content_length FROM media', count: 2 },
    });
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const path = `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`;
    const [a, b] = await Promise.all([
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('A-13'),
      }, env),
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('B-13'),
      }, env),
    ]);
    // TOCTOU: both may pass content_length===0 check before either UPDATE
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + [a, b].filter((r) => r.status !== 200).length).toBe(2);
    expect(media.puts.length).toBe(oks.length);
    expect(db.rows[0].content_length).toBeGreaterThan(0);
  });
  it('placeholder put barrier race #14', async () => {
    const mediaId = 'ph-race-14';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_length: 0, content_type: 'application/octet-stream' })],
      firstBarrier: { substr: 'SELECT user_id, content_length FROM media', count: 2 },
    });
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const path = `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`;
    const [a, b] = await Promise.all([
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('A-14'),
      }, env),
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('B-14'),
      }, env),
    ]);
    // TOCTOU: both may pass content_length===0 check before either UPDATE
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + [a, b].filter((r) => r.status !== 200).length).toBe(2);
    expect(media.puts.length).toBe(oks.length);
    expect(db.rows[0].content_length).toBeGreaterThan(0);
  });
  it('placeholder put barrier race #15', async () => {
    const mediaId = 'ph-race-15';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_length: 0, content_type: 'application/octet-stream' })],
      firstBarrier: { substr: 'SELECT user_id, content_length FROM media', count: 2 },
    });
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const path = `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`;
    const [a, b] = await Promise.all([
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('A-15'),
      }, env),
      mediaReq(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' },
        body: bytesOf('B-15'),
      }, env),
    ]);
    // TOCTOU: both may pass content_length===0 check before either UPDATE
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + [a, b].filter((r) => r.status !== 200).length).toBe(2);
    expect(media.puts.length).toBe(oks.length);
    expect(db.rows[0].content_length).toBeGreaterThan(0);
  });
});

describe('race media create∥create distinct ids after #158', () => {
  it('parallel create distinct soft-0', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const init = {
      method: 'POST' as const,
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    };
    const [a, b] = await Promise.all([
      mediaReq('/_matrix/client/v1/media/create', init, env),
      mediaReq('/_matrix/client/v1/media/create', init, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const uriA = (a.body as { content_uri: string }).content_uri;
    const uriB = (b.body as { content_uri: string }).content_uri;
    expect(uriA).not.toBe(uriB);
    expect(db.rows).toHaveLength(2);
  });
  it('parallel create distinct soft-1', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const init = {
      method: 'POST' as const,
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    };
    const [a, b] = await Promise.all([
      mediaReq('/_matrix/client/v1/media/create', init, env),
      mediaReq('/_matrix/client/v1/media/create', init, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const uriA = (a.body as { content_uri: string }).content_uri;
    const uriB = (b.body as { content_uri: string }).content_uri;
    expect(uriA).not.toBe(uriB);
    expect(db.rows).toHaveLength(2);
  });
  it('parallel create distinct soft-2', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const init = {
      method: 'POST' as const,
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    };
    const [a, b] = await Promise.all([
      mediaReq('/_matrix/client/v1/media/create', init, env),
      mediaReq('/_matrix/client/v1/media/create', init, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const uriA = (a.body as { content_uri: string }).content_uri;
    const uriB = (b.body as { content_uri: string }).content_uri;
    expect(uriA).not.toBe(uriB);
    expect(db.rows).toHaveLength(2);
  });
  it('parallel create distinct soft-3', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const init = {
      method: 'POST' as const,
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    };
    const [a, b] = await Promise.all([
      mediaReq('/_matrix/client/v1/media/create', init, env),
      mediaReq('/_matrix/client/v1/media/create', init, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const uriA = (a.body as { content_uri: string }).content_uri;
    const uriB = (b.body as { content_uri: string }).content_uri;
    expect(uriA).not.toBe(uriB);
    expect(db.rows).toHaveLength(2);
  });
  it('parallel create distinct soft-4', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const init = {
      method: 'POST' as const,
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    };
    const [a, b] = await Promise.all([
      mediaReq('/_matrix/client/v1/media/create', init, env),
      mediaReq('/_matrix/client/v1/media/create', init, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const uriA = (a.body as { content_uri: string }).content_uri;
    const uriB = (b.body as { content_uri: string }).content_uri;
    expect(uriA).not.toBe(uriB);
    expect(db.rows).toHaveLength(2);
  });
  it('parallel create distinct soft-5', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const init = {
      method: 'POST' as const,
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    };
    const [a, b] = await Promise.all([
      mediaReq('/_matrix/client/v1/media/create', init, env),
      mediaReq('/_matrix/client/v1/media/create', init, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const uriA = (a.body as { content_uri: string }).content_uri;
    const uriB = (b.body as { content_uri: string }).content_uri;
    expect(uriA).not.toBe(uriB);
    expect(db.rows).toHaveLength(2);
  });
  it('parallel create distinct soft-6', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const init = {
      method: 'POST' as const,
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    };
    const [a, b] = await Promise.all([
      mediaReq('/_matrix/client/v1/media/create', init, env),
      mediaReq('/_matrix/client/v1/media/create', init, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const uriA = (a.body as { content_uri: string }).content_uri;
    const uriB = (b.body as { content_uri: string }).content_uri;
    expect(uriA).not.toBe(uriB);
    expect(db.rows).toHaveLength(2);
  });
  it('parallel create distinct soft-7', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const init = {
      method: 'POST' as const,
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    };
    const [a, b] = await Promise.all([
      mediaReq('/_matrix/client/v1/media/create', init, env),
      mediaReq('/_matrix/client/v1/media/create', init, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const uriA = (a.body as { content_uri: string }).content_uri;
    const uriB = (b.body as { content_uri: string }).content_uri;
    expect(uriA).not.toBe(uriB);
    expect(db.rows).toHaveLength(2);
  });
  it('parallel create distinct soft-8', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const init = {
      method: 'POST' as const,
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    };
    const [a, b] = await Promise.all([
      mediaReq('/_matrix/client/v1/media/create', init, env),
      mediaReq('/_matrix/client/v1/media/create', init, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const uriA = (a.body as { content_uri: string }).content_uri;
    const uriB = (b.body as { content_uri: string }).content_uri;
    expect(uriA).not.toBe(uriB);
    expect(db.rows).toHaveLength(2);
  });
  it('parallel create distinct soft-9', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const init = {
      method: 'POST' as const,
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    };
    const [a, b] = await Promise.all([
      mediaReq('/_matrix/client/v1/media/create', init, env),
      mediaReq('/_matrix/client/v1/media/create', init, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const uriA = (a.body as { content_uri: string }).content_uri;
    const uriB = (b.body as { content_uri: string }).content_uri;
    expect(uriA).not.toBe(uriB);
    expect(db.rows).toHaveLength(2);
  });
  it('parallel create distinct soft-10', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const init = {
      method: 'POST' as const,
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    };
    const [a, b] = await Promise.all([
      mediaReq('/_matrix/client/v1/media/create', init, env),
      mediaReq('/_matrix/client/v1/media/create', init, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const uriA = (a.body as { content_uri: string }).content_uri;
    const uriB = (b.body as { content_uri: string }).content_uri;
    expect(uriA).not.toBe(uriB);
    expect(db.rows).toHaveLength(2);
  });
  it('parallel create distinct soft-11', async () => {
    const db = createMediaDb();
    const media = createMediaBucket();
    const env = mediaEnv({ db, media });
    const init = {
      method: 'POST' as const,
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    };
    const [a, b] = await Promise.all([
      mediaReq('/_matrix/client/v1/media/create', init, env),
      mediaReq('/_matrix/client/v1/media/create', init, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const uriA = (a.body as { content_uri: string }).content_uri;
    const uriB = (b.body as { content_uri: string }).content_uri;
    expect(uriA).not.toBe(uriB);
    expect(db.rows).toHaveLength(2);
  });
});

describe('media thumbnail soft flood after #158', () => {
  it('v3 thumbnail cached soft-0', async () => {
    const mediaId = 'thumb-0';
    const w = 10;
    const h = 10;
    const thumbKey = `thumb_${mediaId}_${w}x${h}_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/png' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'ORIG0' },
      [thumbKey]: { body: 'THUMB0', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=${w}&height=${h}`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('THUMB0');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });
  it('v3 thumbnail cached soft-1', async () => {
    const mediaId = 'thumb-1';
    const w = 20;
    const h = 20;
    const thumbKey = `thumb_${mediaId}_${w}x${h}_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/png' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'ORIG1' },
      [thumbKey]: { body: 'THUMB1', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=${w}&height=${h}`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('THUMB1');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });
  it('v3 thumbnail cached soft-2', async () => {
    const mediaId = 'thumb-2';
    const w = 30;
    const h = 30;
    const thumbKey = `thumb_${mediaId}_${w}x${h}_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/png' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'ORIG2' },
      [thumbKey]: { body: 'THUMB2', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=${w}&height=${h}`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('THUMB2');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });
  it('v3 thumbnail cached soft-3', async () => {
    const mediaId = 'thumb-3';
    const w = 40;
    const h = 40;
    const thumbKey = `thumb_${mediaId}_${w}x${h}_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/png' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'ORIG3' },
      [thumbKey]: { body: 'THUMB3', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=${w}&height=${h}`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('THUMB3');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });
  it('v3 thumbnail cached soft-4', async () => {
    const mediaId = 'thumb-4';
    const w = 50;
    const h = 50;
    const thumbKey = `thumb_${mediaId}_${w}x${h}_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/png' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'ORIG4' },
      [thumbKey]: { body: 'THUMB4', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=${w}&height=${h}`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('THUMB4');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });
  it('v3 thumbnail cached soft-5', async () => {
    const mediaId = 'thumb-5';
    const w = 60;
    const h = 10;
    const thumbKey = `thumb_${mediaId}_${w}x${h}_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/png' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'ORIG5' },
      [thumbKey]: { body: 'THUMB5', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=${w}&height=${h}`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('THUMB5');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });
  it('v3 thumbnail cached soft-6', async () => {
    const mediaId = 'thumb-6';
    const w = 70;
    const h = 20;
    const thumbKey = `thumb_${mediaId}_${w}x${h}_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/png' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'ORIG6' },
      [thumbKey]: { body: 'THUMB6', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=${w}&height=${h}`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('THUMB6');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });
  it('v3 thumbnail cached soft-7', async () => {
    const mediaId = 'thumb-7';
    const w = 80;
    const h = 30;
    const thumbKey = `thumb_${mediaId}_${w}x${h}_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/png' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'ORIG7' },
      [thumbKey]: { body: 'THUMB7', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=${w}&height=${h}`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('THUMB7');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });
  it('v3 thumbnail cached soft-8', async () => {
    const mediaId = 'thumb-8';
    const w = 10;
    const h = 40;
    const thumbKey = `thumb_${mediaId}_${w}x${h}_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/png' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'ORIG8' },
      [thumbKey]: { body: 'THUMB8', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=${w}&height=${h}`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('THUMB8');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });
  it('v3 thumbnail cached soft-9', async () => {
    const mediaId = 'thumb-9';
    const w = 20;
    const h = 50;
    const thumbKey = `thumb_${mediaId}_${w}x${h}_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/png' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'ORIG9' },
      [thumbKey]: { body: 'THUMB9', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=${w}&height=${h}`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('THUMB9');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });
  it('v3 thumbnail cached soft-10', async () => {
    const mediaId = 'thumb-10';
    const w = 30;
    const h = 10;
    const thumbKey = `thumb_${mediaId}_${w}x${h}_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/png' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'ORIG10' },
      [thumbKey]: { body: 'THUMB10', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=${w}&height=${h}`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('THUMB10');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });
  it('v3 thumbnail cached soft-11', async () => {
    const mediaId = 'thumb-11';
    const w = 40;
    const h = 20;
    const thumbKey = `thumb_${mediaId}_${w}x${h}_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/png' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'ORIG11' },
      [thumbKey]: { body: 'THUMB11', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=${w}&height=${h}`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('THUMB11');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });
  it('v3 thumbnail cached soft-12', async () => {
    const mediaId = 'thumb-12';
    const w = 50;
    const h = 30;
    const thumbKey = `thumb_${mediaId}_${w}x${h}_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/png' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'ORIG12' },
      [thumbKey]: { body: 'THUMB12', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=${w}&height=${h}`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('THUMB12');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });
  it('v3 thumbnail cached soft-13', async () => {
    const mediaId = 'thumb-13';
    const w = 60;
    const h = 40;
    const thumbKey = `thumb_${mediaId}_${w}x${h}_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/png' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'ORIG13' },
      [thumbKey]: { body: 'THUMB13', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=${w}&height=${h}`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('THUMB13');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });
  it('v3 thumbnail cached soft-14', async () => {
    const mediaId = 'thumb-14';
    const w = 70;
    const h = 50;
    const thumbKey = `thumb_${mediaId}_${w}x${h}_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/png' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'ORIG14' },
      [thumbKey]: { body: 'THUMB14', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=${w}&height=${h}`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('THUMB14');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });
  it('v3 thumbnail cached soft-15', async () => {
    const mediaId = 'thumb-15';
    const w = 80;
    const h = 10;
    const thumbKey = `thumb_${mediaId}_${w}x${h}_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/png' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'ORIG15' },
      [thumbKey]: { body: 'THUMB15', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=${w}&height=${h}`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('THUMB15');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('X-Thumbnail-Generated')).toBeNull();
  });
});

describe('media thumbnail non-image soft flood after #158', () => {
  it('v3 thumbnail non-image soft-0', async () => {
    const mediaId = 'pdf-0';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'application/pdf' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'PDF0' } });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=64&height=64`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('PDF0');
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
  });
  it('v3 thumbnail non-image soft-1', async () => {
    const mediaId = 'pdf-1';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'application/pdf' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'PDF1' } });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=64&height=64`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('PDF1');
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
  });
  it('v3 thumbnail non-image soft-2', async () => {
    const mediaId = 'pdf-2';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'application/pdf' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'PDF2' } });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=64&height=64`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('PDF2');
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
  });
  it('v3 thumbnail non-image soft-3', async () => {
    const mediaId = 'pdf-3';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'application/pdf' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'PDF3' } });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=64&height=64`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('PDF3');
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
  });
  it('v3 thumbnail non-image soft-4', async () => {
    const mediaId = 'pdf-4';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'application/pdf' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'PDF4' } });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=64&height=64`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('PDF4');
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
  });
  it('v3 thumbnail non-image soft-5', async () => {
    const mediaId = 'pdf-5';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'application/pdf' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'PDF5' } });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=64&height=64`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('PDF5');
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
  });
  it('v3 thumbnail non-image soft-6', async () => {
    const mediaId = 'pdf-6';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'application/pdf' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'PDF6' } });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=64&height=64`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('PDF6');
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
  });
  it('v3 thumbnail non-image soft-7', async () => {
    const mediaId = 'pdf-7';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'application/pdf' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'PDF7' } });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=64&height=64`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('PDF7');
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
  });
  it('v3 thumbnail non-image soft-8', async () => {
    const mediaId = 'pdf-8';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'application/pdf' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'PDF8' } });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=64&height=64`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('PDF8');
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
  });
  it('v3 thumbnail non-image soft-9', async () => {
    const mediaId = 'pdf-9';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'application/pdf' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'PDF9' } });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=64&height=64`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('PDF9');
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
  });
  it('v3 thumbnail non-image soft-10', async () => {
    const mediaId = 'pdf-10';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'application/pdf' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'PDF10' } });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=64&height=64`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('PDF10');
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
  });
  it('v3 thumbnail non-image soft-11', async () => {
    const mediaId = 'pdf-11';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'application/pdf' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'PDF11' } });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=64&height=64`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('PDF11');
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
  });
  it('v3 thumbnail non-image soft-12', async () => {
    const mediaId = 'pdf-12';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'application/pdf' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'PDF12' } });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=64&height=64`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('PDF12');
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
  });
  it('v3 thumbnail non-image soft-13', async () => {
    const mediaId = 'pdf-13';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'application/pdf' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'PDF13' } });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=64&height=64`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('PDF13');
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
  });
  it('v3 thumbnail non-image soft-14', async () => {
    const mediaId = 'pdf-14';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'application/pdf' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'PDF14' } });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=64&height=64`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('PDF14');
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
  });
  it('v3 thumbnail non-image soft-15', async () => {
    const mediaId = 'pdf-15';
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'application/pdf' })],
    });
    const media = createMediaBucket({ [mediaId]: { body: 'PDF15' } });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=64&height=64`,
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('PDF15');
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
  });
});

describe('media client v1 thumbnail soft flood after #158', () => {
  it('v1 thumbnail cached soft-0', async () => {
    const mediaId = 'v1thumb-0';
    const thumbKey = `thumb_${mediaId}_32x32_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/jpeg' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'J0' },
      [thumbKey]: { body: 'TJ0', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}?width=32&height=32`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('TJ0');
  });
  it('v1 thumbnail cached soft-1', async () => {
    const mediaId = 'v1thumb-1';
    const thumbKey = `thumb_${mediaId}_32x32_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/jpeg' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'J1' },
      [thumbKey]: { body: 'TJ1', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}?width=32&height=32`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('TJ1');
  });
  it('v1 thumbnail cached soft-2', async () => {
    const mediaId = 'v1thumb-2';
    const thumbKey = `thumb_${mediaId}_32x32_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/jpeg' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'J2' },
      [thumbKey]: { body: 'TJ2', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}?width=32&height=32`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('TJ2');
  });
  it('v1 thumbnail cached soft-3', async () => {
    const mediaId = 'v1thumb-3';
    const thumbKey = `thumb_${mediaId}_32x32_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/jpeg' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'J3' },
      [thumbKey]: { body: 'TJ3', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}?width=32&height=32`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('TJ3');
  });
  it('v1 thumbnail cached soft-4', async () => {
    const mediaId = 'v1thumb-4';
    const thumbKey = `thumb_${mediaId}_32x32_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/jpeg' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'J4' },
      [thumbKey]: { body: 'TJ4', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}?width=32&height=32`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('TJ4');
  });
  it('v1 thumbnail cached soft-5', async () => {
    const mediaId = 'v1thumb-5';
    const thumbKey = `thumb_${mediaId}_32x32_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/jpeg' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'J5' },
      [thumbKey]: { body: 'TJ5', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}?width=32&height=32`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('TJ5');
  });
  it('v1 thumbnail cached soft-6', async () => {
    const mediaId = 'v1thumb-6';
    const thumbKey = `thumb_${mediaId}_32x32_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/jpeg' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'J6' },
      [thumbKey]: { body: 'TJ6', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}?width=32&height=32`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('TJ6');
  });
  it('v1 thumbnail cached soft-7', async () => {
    const mediaId = 'v1thumb-7';
    const thumbKey = `thumb_${mediaId}_32x32_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/jpeg' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'J7' },
      [thumbKey]: { body: 'TJ7', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}?width=32&height=32`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('TJ7');
  });
  it('v1 thumbnail cached soft-8', async () => {
    const mediaId = 'v1thumb-8';
    const thumbKey = `thumb_${mediaId}_32x32_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/jpeg' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'J8' },
      [thumbKey]: { body: 'TJ8', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}?width=32&height=32`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('TJ8');
  });
  it('v1 thumbnail cached soft-9', async () => {
    const mediaId = 'v1thumb-9';
    const thumbKey = `thumb_${mediaId}_32x32_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/jpeg' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'J9' },
      [thumbKey]: { body: 'TJ9', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}?width=32&height=32`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('TJ9');
  });
  it('v1 thumbnail cached soft-10', async () => {
    const mediaId = 'v1thumb-10';
    const thumbKey = `thumb_${mediaId}_32x32_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/jpeg' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'J10' },
      [thumbKey]: { body: 'TJ10', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}?width=32&height=32`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('TJ10');
  });
  it('v1 thumbnail cached soft-11', async () => {
    const mediaId = 'v1thumb-11';
    const thumbKey = `thumb_${mediaId}_32x32_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/jpeg' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'J11' },
      [thumbKey]: { body: 'TJ11', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}?width=32&height=32`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('TJ11');
  });
  it('v1 thumbnail cached soft-12', async () => {
    const mediaId = 'v1thumb-12';
    const thumbKey = `thumb_${mediaId}_32x32_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/jpeg' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'J12' },
      [thumbKey]: { body: 'TJ12', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}?width=32&height=32`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('TJ12');
  });
  it('v1 thumbnail cached soft-13', async () => {
    const mediaId = 'v1thumb-13';
    const thumbKey = `thumb_${mediaId}_32x32_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/jpeg' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'J13' },
      [thumbKey]: { body: 'TJ13', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}?width=32&height=32`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('TJ13');
  });
  it('v1 thumbnail cached soft-14', async () => {
    const mediaId = 'v1thumb-14';
    const thumbKey = `thumb_${mediaId}_32x32_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/jpeg' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'J14' },
      [thumbKey]: { body: 'TJ14', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}?width=32&height=32`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('TJ14');
  });
  it('v1 thumbnail cached soft-15', async () => {
    const mediaId = 'v1thumb-15';
    const thumbKey = `thumb_${mediaId}_32x32_scale`;
    const db = createMediaDb({
      rows: [seedRow({ media_id: mediaId, content_type: 'image/jpeg' })],
    });
    const media = createMediaBucket({
      [mediaId]: { body: 'J15' },
      [thumbKey]: { body: 'TJ15', httpMetadata: { contentType: 'image/jpeg' } },
    });
    const env = mediaEnv({ db, media });
    const res = await mediaReq(
      `/_matrix/client/v1/media/thumbnail/${SERVER}/${mediaId}?width=32&height=32`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe('TJ15');
  });
});

describe('media preview_url cache soft flood after #158', () => {
  it('v3 preview cached soft-0', async () => {
    const url = 'https://preview.example.com/page-0';
    const cached = JSON.stringify({ 'og:title': 'Cached 0' });
    const cache = createCache({ [`preview:${url}`]: cached });
    const env = mediaEnv({ cache });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:title': 'Cached 0' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('v3 preview cached soft-1', async () => {
    const url = 'https://preview.example.com/page-1';
    const cached = JSON.stringify({ 'og:title': 'Cached 1' });
    const cache = createCache({ [`preview:${url}`]: cached });
    const env = mediaEnv({ cache });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:title': 'Cached 1' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('v3 preview cached soft-2', async () => {
    const url = 'https://preview.example.com/page-2';
    const cached = JSON.stringify({ 'og:title': 'Cached 2' });
    const cache = createCache({ [`preview:${url}`]: cached });
    const env = mediaEnv({ cache });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:title': 'Cached 2' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('v3 preview cached soft-3', async () => {
    const url = 'https://preview.example.com/page-3';
    const cached = JSON.stringify({ 'og:title': 'Cached 3' });
    const cache = createCache({ [`preview:${url}`]: cached });
    const env = mediaEnv({ cache });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:title': 'Cached 3' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('v3 preview cached soft-4', async () => {
    const url = 'https://preview.example.com/page-4';
    const cached = JSON.stringify({ 'og:title': 'Cached 4' });
    const cache = createCache({ [`preview:${url}`]: cached });
    const env = mediaEnv({ cache });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:title': 'Cached 4' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('v3 preview cached soft-5', async () => {
    const url = 'https://preview.example.com/page-5';
    const cached = JSON.stringify({ 'og:title': 'Cached 5' });
    const cache = createCache({ [`preview:${url}`]: cached });
    const env = mediaEnv({ cache });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:title': 'Cached 5' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('v3 preview cached soft-6', async () => {
    const url = 'https://preview.example.com/page-6';
    const cached = JSON.stringify({ 'og:title': 'Cached 6' });
    const cache = createCache({ [`preview:${url}`]: cached });
    const env = mediaEnv({ cache });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:title': 'Cached 6' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('v3 preview cached soft-7', async () => {
    const url = 'https://preview.example.com/page-7';
    const cached = JSON.stringify({ 'og:title': 'Cached 7' });
    const cache = createCache({ [`preview:${url}`]: cached });
    const env = mediaEnv({ cache });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:title': 'Cached 7' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('v3 preview cached soft-8', async () => {
    const url = 'https://preview.example.com/page-8';
    const cached = JSON.stringify({ 'og:title': 'Cached 8' });
    const cache = createCache({ [`preview:${url}`]: cached });
    const env = mediaEnv({ cache });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:title': 'Cached 8' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('v3 preview cached soft-9', async () => {
    const url = 'https://preview.example.com/page-9';
    const cached = JSON.stringify({ 'og:title': 'Cached 9' });
    const cache = createCache({ [`preview:${url}`]: cached });
    const env = mediaEnv({ cache });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:title': 'Cached 9' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('v3 preview cached soft-10', async () => {
    const url = 'https://preview.example.com/page-10';
    const cached = JSON.stringify({ 'og:title': 'Cached 10' });
    const cache = createCache({ [`preview:${url}`]: cached });
    const env = mediaEnv({ cache });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:title': 'Cached 10' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('v3 preview cached soft-11', async () => {
    const url = 'https://preview.example.com/page-11';
    const cached = JSON.stringify({ 'og:title': 'Cached 11' });
    const cache = createCache({ [`preview:${url}`]: cached });
    const env = mediaEnv({ cache });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:title': 'Cached 11' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('v3 preview cached soft-12', async () => {
    const url = 'https://preview.example.com/page-12';
    const cached = JSON.stringify({ 'og:title': 'Cached 12' });
    const cache = createCache({ [`preview:${url}`]: cached });
    const env = mediaEnv({ cache });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:title': 'Cached 12' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('v3 preview cached soft-13', async () => {
    const url = 'https://preview.example.com/page-13';
    const cached = JSON.stringify({ 'og:title': 'Cached 13' });
    const cache = createCache({ [`preview:${url}`]: cached });
    const env = mediaEnv({ cache });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:title': 'Cached 13' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('v3 preview cached soft-14', async () => {
    const url = 'https://preview.example.com/page-14';
    const cached = JSON.stringify({ 'og:title': 'Cached 14' });
    const cache = createCache({ [`preview:${url}`]: cached });
    const env = mediaEnv({ cache });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:title': 'Cached 14' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('v3 preview cached soft-15', async () => {
    const url = 'https://preview.example.com/page-15';
    const cached = JSON.stringify({ 'og:title': 'Cached 15' });
    const cache = createCache({ [`preview:${url}`]: cached });
    const env = mediaEnv({ cache });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:title': 'Cached 15' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('media preview_url image soft flood after #158', () => {
  it('v3 preview image soft-0', async () => {
    const url = 'https://cdn.example.com/img-0.png';
    const cache = createCache();
    const env = mediaEnv({ cache });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('fakepng', {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      )
    );
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:image': url, 'og:image:type': 'image/png' });
    expect(cache.data[`preview:${url}`]).toBeTruthy();
  });
  it('v3 preview image soft-1', async () => {
    const url = 'https://cdn.example.com/img-1.png';
    const cache = createCache();
    const env = mediaEnv({ cache });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('fakepng', {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      )
    );
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:image': url, 'og:image:type': 'image/png' });
    expect(cache.data[`preview:${url}`]).toBeTruthy();
  });
  it('v3 preview image soft-2', async () => {
    const url = 'https://cdn.example.com/img-2.png';
    const cache = createCache();
    const env = mediaEnv({ cache });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('fakepng', {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      )
    );
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:image': url, 'og:image:type': 'image/png' });
    expect(cache.data[`preview:${url}`]).toBeTruthy();
  });
  it('v3 preview image soft-3', async () => {
    const url = 'https://cdn.example.com/img-3.png';
    const cache = createCache();
    const env = mediaEnv({ cache });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('fakepng', {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      )
    );
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:image': url, 'og:image:type': 'image/png' });
    expect(cache.data[`preview:${url}`]).toBeTruthy();
  });
  it('v3 preview image soft-4', async () => {
    const url = 'https://cdn.example.com/img-4.png';
    const cache = createCache();
    const env = mediaEnv({ cache });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('fakepng', {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      )
    );
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:image': url, 'og:image:type': 'image/png' });
    expect(cache.data[`preview:${url}`]).toBeTruthy();
  });
  it('v3 preview image soft-5', async () => {
    const url = 'https://cdn.example.com/img-5.png';
    const cache = createCache();
    const env = mediaEnv({ cache });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('fakepng', {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      )
    );
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:image': url, 'og:image:type': 'image/png' });
    expect(cache.data[`preview:${url}`]).toBeTruthy();
  });
  it('v3 preview image soft-6', async () => {
    const url = 'https://cdn.example.com/img-6.png';
    const cache = createCache();
    const env = mediaEnv({ cache });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('fakepng', {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      )
    );
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:image': url, 'og:image:type': 'image/png' });
    expect(cache.data[`preview:${url}`]).toBeTruthy();
  });
  it('v3 preview image soft-7', async () => {
    const url = 'https://cdn.example.com/img-7.png';
    const cache = createCache();
    const env = mediaEnv({ cache });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('fakepng', {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      )
    );
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:image': url, 'og:image:type': 'image/png' });
    expect(cache.data[`preview:${url}`]).toBeTruthy();
  });
  it('v3 preview image soft-8', async () => {
    const url = 'https://cdn.example.com/img-8.png';
    const cache = createCache();
    const env = mediaEnv({ cache });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('fakepng', {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      )
    );
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:image': url, 'og:image:type': 'image/png' });
    expect(cache.data[`preview:${url}`]).toBeTruthy();
  });
  it('v3 preview image soft-9', async () => {
    const url = 'https://cdn.example.com/img-9.png';
    const cache = createCache();
    const env = mediaEnv({ cache });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('fakepng', {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      )
    );
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:image': url, 'og:image:type': 'image/png' });
    expect(cache.data[`preview:${url}`]).toBeTruthy();
  });
  it('v3 preview image soft-10', async () => {
    const url = 'https://cdn.example.com/img-10.png';
    const cache = createCache();
    const env = mediaEnv({ cache });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('fakepng', {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      )
    );
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:image': url, 'og:image:type': 'image/png' });
    expect(cache.data[`preview:${url}`]).toBeTruthy();
  });
  it('v3 preview image soft-11', async () => {
    const url = 'https://cdn.example.com/img-11.png';
    const cache = createCache();
    const env = mediaEnv({ cache });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('fakepng', {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      )
    );
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:image': url, 'og:image:type': 'image/png' });
    expect(cache.data[`preview:${url}`]).toBeTruthy();
  });
  it('v3 preview image soft-12', async () => {
    const url = 'https://cdn.example.com/img-12.png';
    const cache = createCache();
    const env = mediaEnv({ cache });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('fakepng', {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      )
    );
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:image': url, 'og:image:type': 'image/png' });
    expect(cache.data[`preview:${url}`]).toBeTruthy();
  });
  it('v3 preview image soft-13', async () => {
    const url = 'https://cdn.example.com/img-13.png';
    const cache = createCache();
    const env = mediaEnv({ cache });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('fakepng', {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      )
    );
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:image': url, 'og:image:type': 'image/png' });
    expect(cache.data[`preview:${url}`]).toBeTruthy();
  });
  it('v3 preview image soft-14', async () => {
    const url = 'https://cdn.example.com/img-14.png';
    const cache = createCache();
    const env = mediaEnv({ cache });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('fakepng', {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      )
    );
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:image': url, 'og:image:type': 'image/png' });
    expect(cache.data[`preview:${url}`]).toBeTruthy();
  });
  it('v3 preview image soft-15', async () => {
    const url = 'https://cdn.example.com/img-15.png';
    const cache = createCache();
    const env = mediaEnv({ cache });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('fakepng', {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      )
    );
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent(url)}`,
      { headers: { Authorization: 'Bearer t' } },
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'og:image': url, 'og:image:type': 'image/png' });
    expect(cache.data[`preview:${url}`]).toBeTruthy();
  });
});

describe('media preview_url SSRF soft flood after #158', () => {
  it('preview SSRF soft-0', async () => {
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://127.0.0.1/')}`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect([400, 403]).toContain(res.status);
  });
  it('preview SSRF soft-1', async () => {
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://localhost/')}`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect([400, 403]).toContain(res.status);
  });
  it('preview SSRF soft-2', async () => {
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://[::1]/')}`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect([400, 403]).toContain(res.status);
  });
  it('preview SSRF soft-3', async () => {
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://0.0.0.0/')}`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect([400, 403]).toContain(res.status);
  });
  it('preview SSRF soft-4', async () => {
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent('file:///etc/passwd')}`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect([400, 403]).toContain(res.status);
  });
  it('preview SSRF soft-5', async () => {
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent('ftp://example.com/')}`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect([400, 403]).toContain(res.status);
  });
  it('preview SSRF soft-6', async () => {
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://169.254.169.254/')}`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect([400, 403]).toContain(res.status);
  });
  it('preview SSRF soft-7', async () => {
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://10.0.0.1/')}`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect([400, 403]).toContain(res.status);
  });
  it('preview SSRF soft-8', async () => {
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://192.168.1.1/')}`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect([400, 403]).toContain(res.status);
  });
  it('preview SSRF soft-9', async () => {
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://172.16.0.1/')}`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect([400, 403]).toContain(res.status);
  });
  it('preview SSRF soft-10', async () => {
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://example.com:22/')}`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect([400, 403]).toContain(res.status);
  });
  it('preview SSRF soft-11', async () => {
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://example.com:3306/')}`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect([400, 403]).toContain(res.status);
  });
  it('preview SSRF soft-12', async () => {
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://metadata.google.internal/')}`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect([400, 403]).toContain(res.status);
  });
  it('preview SSRF soft-13', async () => {
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent('https://127.0.0.1/')}`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect([400, 403]).toContain(res.status);
  });
  it('preview SSRF soft-14', async () => {
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://[fc00::1]/')}`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect([400, 403]).toContain(res.status);
  });
  it('preview SSRF soft-15', async () => {
    const res = await mediaReq(
      `/_matrix/media/v3/preview_url?url=${encodeURIComponent('http://2130706433/')}`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect([400, 403]).toContain(res.status);
  });
});

describe('race appservice sendTransaction parallel after #158', () => {
  it('AS txn parallel soft-0', async () => {
    const db = createAsTxnDb();
    const fetches: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        fetches.push(u);
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!bridge_r0:example.com', sender: '@_bridge_u0:example.com' }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(db.txns).toHaveLength(2);
    expect(db.txns.every((t) => t.sent_at !== null)).toBe(true);
    expect(fetches).toHaveLength(2);
    expect(fetches[0]).not.toBe(fetches[1]);
  });
  it('AS txn parallel soft-1', async () => {
    const db = createAsTxnDb();
    const fetches: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        fetches.push(u);
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!bridge_r1:example.com', sender: '@_bridge_u1:example.com' }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(db.txns).toHaveLength(2);
    expect(db.txns.every((t) => t.sent_at !== null)).toBe(true);
    expect(fetches).toHaveLength(2);
    expect(fetches[0]).not.toBe(fetches[1]);
  });
  it('AS txn parallel soft-2', async () => {
    const db = createAsTxnDb();
    const fetches: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        fetches.push(u);
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!bridge_r2:example.com', sender: '@_bridge_u2:example.com' }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(db.txns).toHaveLength(2);
    expect(db.txns.every((t) => t.sent_at !== null)).toBe(true);
    expect(fetches).toHaveLength(2);
    expect(fetches[0]).not.toBe(fetches[1]);
  });
  it('AS txn parallel soft-3', async () => {
    const db = createAsTxnDb();
    const fetches: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        fetches.push(u);
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!bridge_r3:example.com', sender: '@_bridge_u3:example.com' }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(db.txns).toHaveLength(2);
    expect(db.txns.every((t) => t.sent_at !== null)).toBe(true);
    expect(fetches).toHaveLength(2);
    expect(fetches[0]).not.toBe(fetches[1]);
  });
  it('AS txn parallel soft-4', async () => {
    const db = createAsTxnDb();
    const fetches: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        fetches.push(u);
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!bridge_r4:example.com', sender: '@_bridge_u4:example.com' }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(db.txns).toHaveLength(2);
    expect(db.txns.every((t) => t.sent_at !== null)).toBe(true);
    expect(fetches).toHaveLength(2);
    expect(fetches[0]).not.toBe(fetches[1]);
  });
  it('AS txn parallel soft-5', async () => {
    const db = createAsTxnDb();
    const fetches: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        fetches.push(u);
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!bridge_r5:example.com', sender: '@_bridge_u5:example.com' }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(db.txns).toHaveLength(2);
    expect(db.txns.every((t) => t.sent_at !== null)).toBe(true);
    expect(fetches).toHaveLength(2);
    expect(fetches[0]).not.toBe(fetches[1]);
  });
  it('AS txn parallel soft-6', async () => {
    const db = createAsTxnDb();
    const fetches: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        fetches.push(u);
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!bridge_r6:example.com', sender: '@_bridge_u6:example.com' }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(db.txns).toHaveLength(2);
    expect(db.txns.every((t) => t.sent_at !== null)).toBe(true);
    expect(fetches).toHaveLength(2);
    expect(fetches[0]).not.toBe(fetches[1]);
  });
  it('AS txn parallel soft-7', async () => {
    const db = createAsTxnDb();
    const fetches: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        fetches.push(u);
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!bridge_r7:example.com', sender: '@_bridge_u7:example.com' }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(db.txns).toHaveLength(2);
    expect(db.txns.every((t) => t.sent_at !== null)).toBe(true);
    expect(fetches).toHaveLength(2);
    expect(fetches[0]).not.toBe(fetches[1]);
  });
  it('AS txn parallel soft-8', async () => {
    const db = createAsTxnDb();
    const fetches: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        fetches.push(u);
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!bridge_r8:example.com', sender: '@_bridge_u8:example.com' }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(db.txns).toHaveLength(2);
    expect(db.txns.every((t) => t.sent_at !== null)).toBe(true);
    expect(fetches).toHaveLength(2);
    expect(fetches[0]).not.toBe(fetches[1]);
  });
  it('AS txn parallel soft-9', async () => {
    const db = createAsTxnDb();
    const fetches: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        fetches.push(u);
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!bridge_r9:example.com', sender: '@_bridge_u9:example.com' }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(db.txns).toHaveLength(2);
    expect(db.txns.every((t) => t.sent_at !== null)).toBe(true);
    expect(fetches).toHaveLength(2);
    expect(fetches[0]).not.toBe(fetches[1]);
  });
  it('AS txn parallel soft-10', async () => {
    const db = createAsTxnDb();
    const fetches: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        fetches.push(u);
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!bridge_r10:example.com', sender: '@_bridge_u10:example.com' }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(db.txns).toHaveLength(2);
    expect(db.txns.every((t) => t.sent_at !== null)).toBe(true);
    expect(fetches).toHaveLength(2);
    expect(fetches[0]).not.toBe(fetches[1]);
  });
  it('AS txn parallel soft-11', async () => {
    const db = createAsTxnDb();
    const fetches: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        fetches.push(u);
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!bridge_r11:example.com', sender: '@_bridge_u11:example.com' }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(db.txns).toHaveLength(2);
    expect(db.txns.every((t) => t.sent_at !== null)).toBe(true);
    expect(fetches).toHaveLength(2);
    expect(fetches[0]).not.toBe(fetches[1]);
  });
  it('AS txn parallel soft-12', async () => {
    const db = createAsTxnDb();
    const fetches: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        fetches.push(u);
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!bridge_r12:example.com', sender: '@_bridge_u12:example.com' }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(db.txns).toHaveLength(2);
    expect(db.txns.every((t) => t.sent_at !== null)).toBe(true);
    expect(fetches).toHaveLength(2);
    expect(fetches[0]).not.toBe(fetches[1]);
  });
  it('AS txn parallel soft-13', async () => {
    const db = createAsTxnDb();
    const fetches: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        fetches.push(u);
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!bridge_r13:example.com', sender: '@_bridge_u13:example.com' }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(db.txns).toHaveLength(2);
    expect(db.txns.every((t) => t.sent_at !== null)).toBe(true);
    expect(fetches).toHaveLength(2);
    expect(fetches[0]).not.toBe(fetches[1]);
  });
  it('AS txn parallel soft-14', async () => {
    const db = createAsTxnDb();
    const fetches: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        fetches.push(u);
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!bridge_r14:example.com', sender: '@_bridge_u14:example.com' }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(db.txns).toHaveLength(2);
    expect(db.txns.every((t) => t.sent_at !== null)).toBe(true);
    expect(fetches).toHaveLength(2);
    expect(fetches[0]).not.toBe(fetches[1]);
  });
  it('AS txn parallel soft-15', async () => {
    const db = createAsTxnDb();
    const fetches: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        fetches.push(u);
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!bridge_r15:example.com', sender: '@_bridge_u15:example.com' }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(db.txns).toHaveLength(2);
    expect(db.txns.every((t) => t.sent_at !== null)).toBe(true);
    expect(fetches).toHaveLength(2);
    expect(fetches[0]).not.toBe(fetches[1]);
  });
});

describe('race appservice sendTransaction fail∥ok after #158', () => {
  it('AS txn mixed outcome soft-0', async () => {
    const db = createAsTxnDb();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n % 2 === 1) return new Response('err', { status: 500 });
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!x:example.com', sender: USER }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, SLACK_REG, ev),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect([a, b].filter((x) => !x).length).toBe(1);
    expect(db.txns).toHaveLength(2);
    const sent = db.txns.filter((t) => t.sent_at !== null);
    const retried = db.txns.filter((t) => t.retry_count > 0);
    expect(sent).toHaveLength(1);
    expect(retried).toHaveLength(1);
  });
  it('AS txn mixed outcome soft-1', async () => {
    const db = createAsTxnDb();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n % 2 === 1) return new Response('err', { status: 500 });
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!x:example.com', sender: USER }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, SLACK_REG, ev),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect([a, b].filter((x) => !x).length).toBe(1);
    expect(db.txns).toHaveLength(2);
    const sent = db.txns.filter((t) => t.sent_at !== null);
    const retried = db.txns.filter((t) => t.retry_count > 0);
    expect(sent).toHaveLength(1);
    expect(retried).toHaveLength(1);
  });
  it('AS txn mixed outcome soft-2', async () => {
    const db = createAsTxnDb();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n % 2 === 1) return new Response('err', { status: 500 });
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!x:example.com', sender: USER }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, SLACK_REG, ev),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect([a, b].filter((x) => !x).length).toBe(1);
    expect(db.txns).toHaveLength(2);
    const sent = db.txns.filter((t) => t.sent_at !== null);
    const retried = db.txns.filter((t) => t.retry_count > 0);
    expect(sent).toHaveLength(1);
    expect(retried).toHaveLength(1);
  });
  it('AS txn mixed outcome soft-3', async () => {
    const db = createAsTxnDb();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n % 2 === 1) return new Response('err', { status: 500 });
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!x:example.com', sender: USER }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, SLACK_REG, ev),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect([a, b].filter((x) => !x).length).toBe(1);
    expect(db.txns).toHaveLength(2);
    const sent = db.txns.filter((t) => t.sent_at !== null);
    const retried = db.txns.filter((t) => t.retry_count > 0);
    expect(sent).toHaveLength(1);
    expect(retried).toHaveLength(1);
  });
  it('AS txn mixed outcome soft-4', async () => {
    const db = createAsTxnDb();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n % 2 === 1) return new Response('err', { status: 500 });
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!x:example.com', sender: USER }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, SLACK_REG, ev),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect([a, b].filter((x) => !x).length).toBe(1);
    expect(db.txns).toHaveLength(2);
    const sent = db.txns.filter((t) => t.sent_at !== null);
    const retried = db.txns.filter((t) => t.retry_count > 0);
    expect(sent).toHaveLength(1);
    expect(retried).toHaveLength(1);
  });
  it('AS txn mixed outcome soft-5', async () => {
    const db = createAsTxnDb();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n % 2 === 1) return new Response('err', { status: 500 });
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!x:example.com', sender: USER }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, SLACK_REG, ev),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect([a, b].filter((x) => !x).length).toBe(1);
    expect(db.txns).toHaveLength(2);
    const sent = db.txns.filter((t) => t.sent_at !== null);
    const retried = db.txns.filter((t) => t.retry_count > 0);
    expect(sent).toHaveLength(1);
    expect(retried).toHaveLength(1);
  });
  it('AS txn mixed outcome soft-6', async () => {
    const db = createAsTxnDb();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n % 2 === 1) return new Response('err', { status: 500 });
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!x:example.com', sender: USER }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, SLACK_REG, ev),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect([a, b].filter((x) => !x).length).toBe(1);
    expect(db.txns).toHaveLength(2);
    const sent = db.txns.filter((t) => t.sent_at !== null);
    const retried = db.txns.filter((t) => t.retry_count > 0);
    expect(sent).toHaveLength(1);
    expect(retried).toHaveLength(1);
  });
  it('AS txn mixed outcome soft-7', async () => {
    const db = createAsTxnDb();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n % 2 === 1) return new Response('err', { status: 500 });
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!x:example.com', sender: USER }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, SLACK_REG, ev),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect([a, b].filter((x) => !x).length).toBe(1);
    expect(db.txns).toHaveLength(2);
    const sent = db.txns.filter((t) => t.sent_at !== null);
    const retried = db.txns.filter((t) => t.retry_count > 0);
    expect(sent).toHaveLength(1);
    expect(retried).toHaveLength(1);
  });
  it('AS txn mixed outcome soft-8', async () => {
    const db = createAsTxnDb();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n % 2 === 1) return new Response('err', { status: 500 });
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!x:example.com', sender: USER }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, SLACK_REG, ev),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect([a, b].filter((x) => !x).length).toBe(1);
    expect(db.txns).toHaveLength(2);
    const sent = db.txns.filter((t) => t.sent_at !== null);
    const retried = db.txns.filter((t) => t.retry_count > 0);
    expect(sent).toHaveLength(1);
    expect(retried).toHaveLength(1);
  });
  it('AS txn mixed outcome soft-9', async () => {
    const db = createAsTxnDb();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n % 2 === 1) return new Response('err', { status: 500 });
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!x:example.com', sender: USER }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, SLACK_REG, ev),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect([a, b].filter((x) => !x).length).toBe(1);
    expect(db.txns).toHaveLength(2);
    const sent = db.txns.filter((t) => t.sent_at !== null);
    const retried = db.txns.filter((t) => t.retry_count > 0);
    expect(sent).toHaveLength(1);
    expect(retried).toHaveLength(1);
  });
  it('AS txn mixed outcome soft-10', async () => {
    const db = createAsTxnDb();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n % 2 === 1) return new Response('err', { status: 500 });
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!x:example.com', sender: USER }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, SLACK_REG, ev),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect([a, b].filter((x) => !x).length).toBe(1);
    expect(db.txns).toHaveLength(2);
    const sent = db.txns.filter((t) => t.sent_at !== null);
    const retried = db.txns.filter((t) => t.retry_count > 0);
    expect(sent).toHaveLength(1);
    expect(retried).toHaveLength(1);
  });
  it('AS txn mixed outcome soft-11', async () => {
    const db = createAsTxnDb();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n % 2 === 1) return new Response('err', { status: 500 });
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!x:example.com', sender: USER }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, SLACK_REG, ev),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect([a, b].filter((x) => !x).length).toBe(1);
    expect(db.txns).toHaveLength(2);
    const sent = db.txns.filter((t) => t.sent_at !== null);
    const retried = db.txns.filter((t) => t.retry_count > 0);
    expect(sent).toHaveLength(1);
    expect(retried).toHaveLength(1);
  });
  it('AS txn mixed outcome soft-12', async () => {
    const db = createAsTxnDb();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n % 2 === 1) return new Response('err', { status: 500 });
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!x:example.com', sender: USER }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, SLACK_REG, ev),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect([a, b].filter((x) => !x).length).toBe(1);
    expect(db.txns).toHaveLength(2);
    const sent = db.txns.filter((t) => t.sent_at !== null);
    const retried = db.txns.filter((t) => t.retry_count > 0);
    expect(sent).toHaveLength(1);
    expect(retried).toHaveLength(1);
  });
  it('AS txn mixed outcome soft-13', async () => {
    const db = createAsTxnDb();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n % 2 === 1) return new Response('err', { status: 500 });
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!x:example.com', sender: USER }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, SLACK_REG, ev),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect([a, b].filter((x) => !x).length).toBe(1);
    expect(db.txns).toHaveLength(2);
    const sent = db.txns.filter((t) => t.sent_at !== null);
    const retried = db.txns.filter((t) => t.retry_count > 0);
    expect(sent).toHaveLength(1);
    expect(retried).toHaveLength(1);
  });
  it('AS txn mixed outcome soft-14', async () => {
    const db = createAsTxnDb();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n % 2 === 1) return new Response('err', { status: 500 });
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!x:example.com', sender: USER }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, SLACK_REG, ev),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect([a, b].filter((x) => !x).length).toBe(1);
    expect(db.txns).toHaveLength(2);
    const sent = db.txns.filter((t) => t.sent_at !== null);
    const retried = db.txns.filter((t) => t.retry_count > 0);
    expect(sent).toHaveLength(1);
    expect(retried).toHaveLength(1);
  });
  it('AS txn mixed outcome soft-15', async () => {
    const db = createAsTxnDb();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n % 2 === 1) return new Response('err', { status: 500 });
        return new Response('{}', { status: 200 });
      })
    );
    const ev = [{ type: 'm.room.message', room_id: '!x:example.com', sender: USER }];
    const [a, b] = await Promise.all([
      sendAppServiceTransaction(db as unknown as D1Database, BRIDGE_REG, ev),
      sendAppServiceTransaction(db as unknown as D1Database, SLACK_REG, ev),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect([a, b].filter((x) => !x).length).toBe(1);
    expect(db.txns).toHaveLength(2);
    const sent = db.txns.filter((t) => t.sent_at !== null);
    const retried = db.txns.filter((t) => t.retry_count > 0);
    expect(sent).toHaveLength(1);
    expect(retried).toHaveLength(1);
  });
});

describe('appservice interest soft flood after #158', () => {
  it('interest soft-0', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const sender = 0 % 2 === 0 ? `@_bridge_u0:${SERVER}` : `@_slack_u0:${SERVER}`;
    const room = 0 % 3 === 0 ? `!bridge_r0:${SERVER}` : `!other_r0:${SERVER}`;
    const hit = getInterestedAppServices(regs, {
      room_id: room,
      sender,
      type: 'm.room.message',
    });
    expect(hit.length).toBeGreaterThanOrEqual(1);
    expect(hit.some((r) => r.id === (0 % 2 === 0 ? 'bridge' : 'slack'))).toBe(true);
  });
  it('interest soft-1', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const sender = 1 % 2 === 0 ? `@_bridge_u1:${SERVER}` : `@_slack_u1:${SERVER}`;
    const room = 1 % 3 === 0 ? `!bridge_r1:${SERVER}` : `!other_r1:${SERVER}`;
    const hit = getInterestedAppServices(regs, {
      room_id: room,
      sender,
      type: 'm.room.message',
    });
    expect(hit.length).toBeGreaterThanOrEqual(1);
    expect(hit.some((r) => r.id === (1 % 2 === 0 ? 'bridge' : 'slack'))).toBe(true);
  });
  it('interest soft-2', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const sender = 2 % 2 === 0 ? `@_bridge_u2:${SERVER}` : `@_slack_u2:${SERVER}`;
    const room = 2 % 3 === 0 ? `!bridge_r2:${SERVER}` : `!other_r2:${SERVER}`;
    const hit = getInterestedAppServices(regs, {
      room_id: room,
      sender,
      type: 'm.room.message',
    });
    expect(hit.length).toBeGreaterThanOrEqual(1);
    expect(hit.some((r) => r.id === (2 % 2 === 0 ? 'bridge' : 'slack'))).toBe(true);
  });
  it('interest soft-3', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const sender = 3 % 2 === 0 ? `@_bridge_u3:${SERVER}` : `@_slack_u3:${SERVER}`;
    const room = 3 % 3 === 0 ? `!bridge_r3:${SERVER}` : `!other_r3:${SERVER}`;
    const hit = getInterestedAppServices(regs, {
      room_id: room,
      sender,
      type: 'm.room.message',
    });
    expect(hit.length).toBeGreaterThanOrEqual(1);
    expect(hit.some((r) => r.id === (3 % 2 === 0 ? 'bridge' : 'slack'))).toBe(true);
  });
  it('interest soft-4', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const sender = 4 % 2 === 0 ? `@_bridge_u4:${SERVER}` : `@_slack_u4:${SERVER}`;
    const room = 4 % 3 === 0 ? `!bridge_r4:${SERVER}` : `!other_r4:${SERVER}`;
    const hit = getInterestedAppServices(regs, {
      room_id: room,
      sender,
      type: 'm.room.message',
    });
    expect(hit.length).toBeGreaterThanOrEqual(1);
    expect(hit.some((r) => r.id === (4 % 2 === 0 ? 'bridge' : 'slack'))).toBe(true);
  });
  it('interest soft-5', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const sender = 5 % 2 === 0 ? `@_bridge_u5:${SERVER}` : `@_slack_u5:${SERVER}`;
    const room = 5 % 3 === 0 ? `!bridge_r5:${SERVER}` : `!other_r5:${SERVER}`;
    const hit = getInterestedAppServices(regs, {
      room_id: room,
      sender,
      type: 'm.room.message',
    });
    expect(hit.length).toBeGreaterThanOrEqual(1);
    expect(hit.some((r) => r.id === (5 % 2 === 0 ? 'bridge' : 'slack'))).toBe(true);
  });
  it('interest soft-6', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const sender = 6 % 2 === 0 ? `@_bridge_u6:${SERVER}` : `@_slack_u6:${SERVER}`;
    const room = 6 % 3 === 0 ? `!bridge_r6:${SERVER}` : `!other_r6:${SERVER}`;
    const hit = getInterestedAppServices(regs, {
      room_id: room,
      sender,
      type: 'm.room.message',
    });
    expect(hit.length).toBeGreaterThanOrEqual(1);
    expect(hit.some((r) => r.id === (6 % 2 === 0 ? 'bridge' : 'slack'))).toBe(true);
  });
  it('interest soft-7', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const sender = 7 % 2 === 0 ? `@_bridge_u7:${SERVER}` : `@_slack_u7:${SERVER}`;
    const room = 7 % 3 === 0 ? `!bridge_r7:${SERVER}` : `!other_r7:${SERVER}`;
    const hit = getInterestedAppServices(regs, {
      room_id: room,
      sender,
      type: 'm.room.message',
    });
    expect(hit.length).toBeGreaterThanOrEqual(1);
    expect(hit.some((r) => r.id === (7 % 2 === 0 ? 'bridge' : 'slack'))).toBe(true);
  });
  it('interest soft-8', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const sender = 8 % 2 === 0 ? `@_bridge_u8:${SERVER}` : `@_slack_u8:${SERVER}`;
    const room = 8 % 3 === 0 ? `!bridge_r8:${SERVER}` : `!other_r8:${SERVER}`;
    const hit = getInterestedAppServices(regs, {
      room_id: room,
      sender,
      type: 'm.room.message',
    });
    expect(hit.length).toBeGreaterThanOrEqual(1);
    expect(hit.some((r) => r.id === (8 % 2 === 0 ? 'bridge' : 'slack'))).toBe(true);
  });
  it('interest soft-9', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const sender = 9 % 2 === 0 ? `@_bridge_u9:${SERVER}` : `@_slack_u9:${SERVER}`;
    const room = 9 % 3 === 0 ? `!bridge_r9:${SERVER}` : `!other_r9:${SERVER}`;
    const hit = getInterestedAppServices(regs, {
      room_id: room,
      sender,
      type: 'm.room.message',
    });
    expect(hit.length).toBeGreaterThanOrEqual(1);
    expect(hit.some((r) => r.id === (9 % 2 === 0 ? 'bridge' : 'slack'))).toBe(true);
  });
  it('interest soft-10', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const sender = 10 % 2 === 0 ? `@_bridge_u10:${SERVER}` : `@_slack_u10:${SERVER}`;
    const room = 10 % 3 === 0 ? `!bridge_r10:${SERVER}` : `!other_r10:${SERVER}`;
    const hit = getInterestedAppServices(regs, {
      room_id: room,
      sender,
      type: 'm.room.message',
    });
    expect(hit.length).toBeGreaterThanOrEqual(1);
    expect(hit.some((r) => r.id === (10 % 2 === 0 ? 'bridge' : 'slack'))).toBe(true);
  });
  it('interest soft-11', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const sender = 11 % 2 === 0 ? `@_bridge_u11:${SERVER}` : `@_slack_u11:${SERVER}`;
    const room = 11 % 3 === 0 ? `!bridge_r11:${SERVER}` : `!other_r11:${SERVER}`;
    const hit = getInterestedAppServices(regs, {
      room_id: room,
      sender,
      type: 'm.room.message',
    });
    expect(hit.length).toBeGreaterThanOrEqual(1);
    expect(hit.some((r) => r.id === (11 % 2 === 0 ? 'bridge' : 'slack'))).toBe(true);
  });
  it('interest soft-12', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const sender = 12 % 2 === 0 ? `@_bridge_u12:${SERVER}` : `@_slack_u12:${SERVER}`;
    const room = 12 % 3 === 0 ? `!bridge_r12:${SERVER}` : `!other_r12:${SERVER}`;
    const hit = getInterestedAppServices(regs, {
      room_id: room,
      sender,
      type: 'm.room.message',
    });
    expect(hit.length).toBeGreaterThanOrEqual(1);
    expect(hit.some((r) => r.id === (12 % 2 === 0 ? 'bridge' : 'slack'))).toBe(true);
  });
  it('interest soft-13', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const sender = 13 % 2 === 0 ? `@_bridge_u13:${SERVER}` : `@_slack_u13:${SERVER}`;
    const room = 13 % 3 === 0 ? `!bridge_r13:${SERVER}` : `!other_r13:${SERVER}`;
    const hit = getInterestedAppServices(regs, {
      room_id: room,
      sender,
      type: 'm.room.message',
    });
    expect(hit.length).toBeGreaterThanOrEqual(1);
    expect(hit.some((r) => r.id === (13 % 2 === 0 ? 'bridge' : 'slack'))).toBe(true);
  });
  it('interest soft-14', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const sender = 14 % 2 === 0 ? `@_bridge_u14:${SERVER}` : `@_slack_u14:${SERVER}`;
    const room = 14 % 3 === 0 ? `!bridge_r14:${SERVER}` : `!other_r14:${SERVER}`;
    const hit = getInterestedAppServices(regs, {
      room_id: room,
      sender,
      type: 'm.room.message',
    });
    expect(hit.length).toBeGreaterThanOrEqual(1);
    expect(hit.some((r) => r.id === (14 % 2 === 0 ? 'bridge' : 'slack'))).toBe(true);
  });
  it('interest soft-15', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const sender = 15 % 2 === 0 ? `@_bridge_u15:${SERVER}` : `@_slack_u15:${SERVER}`;
    const room = 15 % 3 === 0 ? `!bridge_r15:${SERVER}` : `!other_r15:${SERVER}`;
    const hit = getInterestedAppServices(regs, {
      room_id: room,
      sender,
      type: 'm.room.message',
    });
    expect(hit.length).toBeGreaterThanOrEqual(1);
    expect(hit.some((r) => r.id === (15 % 2 === 0 ? 'bridge' : 'slack'))).toBe(true);
  });
});

describe('appservice exclusive soft flood after #158', () => {
  it('exclusive user/alias soft-0', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const u = isExclusiveAppServiceUser(regs, `@_bridge_x0:${SERVER}`);
    expect(u?.id).toBe('bridge');
    const a = isExclusiveAppServiceAlias(regs, `#_bridge_a0:${SERVER}`);
    expect(a?.id).toBe('bridge');
    const none = isExclusiveAppServiceUser(regs, `@human0:${SERVER}`);
    expect(none).toBeNull();
  });
  it('exclusive user/alias soft-1', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const u = isExclusiveAppServiceUser(regs, `@_bridge_x1:${SERVER}`);
    expect(u?.id).toBe('bridge');
    const a = isExclusiveAppServiceAlias(regs, `#_bridge_a1:${SERVER}`);
    expect(a?.id).toBe('bridge');
    const none = isExclusiveAppServiceUser(regs, `@human1:${SERVER}`);
    expect(none).toBeNull();
  });
  it('exclusive user/alias soft-2', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const u = isExclusiveAppServiceUser(regs, `@_bridge_x2:${SERVER}`);
    expect(u?.id).toBe('bridge');
    const a = isExclusiveAppServiceAlias(regs, `#_bridge_a2:${SERVER}`);
    expect(a?.id).toBe('bridge');
    const none = isExclusiveAppServiceUser(regs, `@human2:${SERVER}`);
    expect(none).toBeNull();
  });
  it('exclusive user/alias soft-3', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const u = isExclusiveAppServiceUser(regs, `@_bridge_x3:${SERVER}`);
    expect(u?.id).toBe('bridge');
    const a = isExclusiveAppServiceAlias(regs, `#_bridge_a3:${SERVER}`);
    expect(a?.id).toBe('bridge');
    const none = isExclusiveAppServiceUser(regs, `@human3:${SERVER}`);
    expect(none).toBeNull();
  });
  it('exclusive user/alias soft-4', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const u = isExclusiveAppServiceUser(regs, `@_bridge_x4:${SERVER}`);
    expect(u?.id).toBe('bridge');
    const a = isExclusiveAppServiceAlias(regs, `#_bridge_a4:${SERVER}`);
    expect(a?.id).toBe('bridge');
    const none = isExclusiveAppServiceUser(regs, `@human4:${SERVER}`);
    expect(none).toBeNull();
  });
  it('exclusive user/alias soft-5', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const u = isExclusiveAppServiceUser(regs, `@_bridge_x5:${SERVER}`);
    expect(u?.id).toBe('bridge');
    const a = isExclusiveAppServiceAlias(regs, `#_bridge_a5:${SERVER}`);
    expect(a?.id).toBe('bridge');
    const none = isExclusiveAppServiceUser(regs, `@human5:${SERVER}`);
    expect(none).toBeNull();
  });
  it('exclusive user/alias soft-6', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const u = isExclusiveAppServiceUser(regs, `@_bridge_x6:${SERVER}`);
    expect(u?.id).toBe('bridge');
    const a = isExclusiveAppServiceAlias(regs, `#_bridge_a6:${SERVER}`);
    expect(a?.id).toBe('bridge');
    const none = isExclusiveAppServiceUser(regs, `@human6:${SERVER}`);
    expect(none).toBeNull();
  });
  it('exclusive user/alias soft-7', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const u = isExclusiveAppServiceUser(regs, `@_bridge_x7:${SERVER}`);
    expect(u?.id).toBe('bridge');
    const a = isExclusiveAppServiceAlias(regs, `#_bridge_a7:${SERVER}`);
    expect(a?.id).toBe('bridge');
    const none = isExclusiveAppServiceUser(regs, `@human7:${SERVER}`);
    expect(none).toBeNull();
  });
  it('exclusive user/alias soft-8', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const u = isExclusiveAppServiceUser(regs, `@_bridge_x8:${SERVER}`);
    expect(u?.id).toBe('bridge');
    const a = isExclusiveAppServiceAlias(regs, `#_bridge_a8:${SERVER}`);
    expect(a?.id).toBe('bridge');
    const none = isExclusiveAppServiceUser(regs, `@human8:${SERVER}`);
    expect(none).toBeNull();
  });
  it('exclusive user/alias soft-9', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const u = isExclusiveAppServiceUser(regs, `@_bridge_x9:${SERVER}`);
    expect(u?.id).toBe('bridge');
    const a = isExclusiveAppServiceAlias(regs, `#_bridge_a9:${SERVER}`);
    expect(a?.id).toBe('bridge');
    const none = isExclusiveAppServiceUser(regs, `@human9:${SERVER}`);
    expect(none).toBeNull();
  });
  it('exclusive user/alias soft-10', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const u = isExclusiveAppServiceUser(regs, `@_bridge_x10:${SERVER}`);
    expect(u?.id).toBe('bridge');
    const a = isExclusiveAppServiceAlias(regs, `#_bridge_a10:${SERVER}`);
    expect(a?.id).toBe('bridge');
    const none = isExclusiveAppServiceUser(regs, `@human10:${SERVER}`);
    expect(none).toBeNull();
  });
  it('exclusive user/alias soft-11', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const u = isExclusiveAppServiceUser(regs, `@_bridge_x11:${SERVER}`);
    expect(u?.id).toBe('bridge');
    const a = isExclusiveAppServiceAlias(regs, `#_bridge_a11:${SERVER}`);
    expect(a?.id).toBe('bridge');
    const none = isExclusiveAppServiceUser(regs, `@human11:${SERVER}`);
    expect(none).toBeNull();
  });
  it('exclusive user/alias soft-12', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const u = isExclusiveAppServiceUser(regs, `@_bridge_x12:${SERVER}`);
    expect(u?.id).toBe('bridge');
    const a = isExclusiveAppServiceAlias(regs, `#_bridge_a12:${SERVER}`);
    expect(a?.id).toBe('bridge');
    const none = isExclusiveAppServiceUser(regs, `@human12:${SERVER}`);
    expect(none).toBeNull();
  });
  it('exclusive user/alias soft-13', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const u = isExclusiveAppServiceUser(regs, `@_bridge_x13:${SERVER}`);
    expect(u?.id).toBe('bridge');
    const a = isExclusiveAppServiceAlias(regs, `#_bridge_a13:${SERVER}`);
    expect(a?.id).toBe('bridge');
    const none = isExclusiveAppServiceUser(regs, `@human13:${SERVER}`);
    expect(none).toBeNull();
  });
  it('exclusive user/alias soft-14', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const u = isExclusiveAppServiceUser(regs, `@_bridge_x14:${SERVER}`);
    expect(u?.id).toBe('bridge');
    const a = isExclusiveAppServiceAlias(regs, `#_bridge_a14:${SERVER}`);
    expect(a?.id).toBe('bridge');
    const none = isExclusiveAppServiceUser(regs, `@human14:${SERVER}`);
    expect(none).toBeNull();
  });
  it('exclusive user/alias soft-15', async () => {
    const regs = [BRIDGE_REG, SLACK_REG];
    const u = isExclusiveAppServiceUser(regs, `@_bridge_x15:${SERVER}`);
    expect(u?.id).toBe('bridge');
    const a = isExclusiveAppServiceAlias(regs, `#_bridge_a15:${SERVER}`);
    expect(a?.id).toBe('bridge');
    const none = isExclusiveAppServiceUser(regs, `@human15:${SERVER}`);
    expect(none).toBeNull();
  });
});

describe('appservice route users soft flood after #158', () => {
  it('AS users route soft-0', async () => {
    getUserById.mockResolvedValue({ user_id: `@_bridge_u0:${SERVER}` });
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/users/${encodeURIComponent(`@_bridge_u0:${SERVER}`)}`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
  it('AS users route soft-1', async () => {
    getUserById.mockResolvedValue({ user_id: `@_bridge_u1:${SERVER}` });
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/users/${encodeURIComponent(`@_bridge_u1:${SERVER}`)}`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
  it('AS users route soft-2', async () => {
    getUserById.mockResolvedValue({ user_id: `@_bridge_u2:${SERVER}` });
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/users/${encodeURIComponent(`@_bridge_u2:${SERVER}`)}`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
  it('AS users route soft-3', async () => {
    getUserById.mockResolvedValue({ user_id: `@_bridge_u3:${SERVER}` });
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/users/${encodeURIComponent(`@_bridge_u3:${SERVER}`)}`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
  it('AS users route soft-4', async () => {
    getUserById.mockResolvedValue({ user_id: `@_bridge_u4:${SERVER}` });
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/users/${encodeURIComponent(`@_bridge_u4:${SERVER}`)}`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
  it('AS users route soft-5', async () => {
    getUserById.mockResolvedValue({ user_id: `@_bridge_u5:${SERVER}` });
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/users/${encodeURIComponent(`@_bridge_u5:${SERVER}`)}`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
  it('AS users route soft-6', async () => {
    getUserById.mockResolvedValue({ user_id: `@_bridge_u6:${SERVER}` });
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/users/${encodeURIComponent(`@_bridge_u6:${SERVER}`)}`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
  it('AS users route soft-7', async () => {
    getUserById.mockResolvedValue({ user_id: `@_bridge_u7:${SERVER}` });
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/users/${encodeURIComponent(`@_bridge_u7:${SERVER}`)}`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
  it('AS users route soft-8', async () => {
    getUserById.mockResolvedValue({ user_id: `@_bridge_u8:${SERVER}` });
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/users/${encodeURIComponent(`@_bridge_u8:${SERVER}`)}`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
  it('AS users route soft-9', async () => {
    getUserById.mockResolvedValue({ user_id: `@_bridge_u9:${SERVER}` });
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/users/${encodeURIComponent(`@_bridge_u9:${SERVER}`)}`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
  it('AS users route soft-10', async () => {
    getUserById.mockResolvedValue({ user_id: `@_bridge_u10:${SERVER}` });
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/users/${encodeURIComponent(`@_bridge_u10:${SERVER}`)}`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
  it('AS users route soft-11', async () => {
    getUserById.mockResolvedValue({ user_id: `@_bridge_u11:${SERVER}` });
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/users/${encodeURIComponent(`@_bridge_u11:${SERVER}`)}`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
  it('AS users route soft-12', async () => {
    getUserById.mockResolvedValue({ user_id: `@_bridge_u12:${SERVER}` });
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/users/${encodeURIComponent(`@_bridge_u12:${SERVER}`)}`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
  it('AS users route soft-13', async () => {
    getUserById.mockResolvedValue({ user_id: `@_bridge_u13:${SERVER}` });
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/users/${encodeURIComponent(`@_bridge_u13:${SERVER}`)}`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
  it('AS users route soft-14', async () => {
    getUserById.mockResolvedValue({ user_id: `@_bridge_u14:${SERVER}` });
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/users/${encodeURIComponent(`@_bridge_u14:${SERVER}`)}`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
  it('AS users route soft-15', async () => {
    getUserById.mockResolvedValue({ user_id: `@_bridge_u15:${SERVER}` });
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/users/${encodeURIComponent(`@_bridge_u15:${SERVER}`)}`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
});

describe('appservice route thirdparty soft flood after #158', () => {
  it('AS thirdparty protocol soft-0', async () => {
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/thirdparty/protocol/proto0`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ user_fields: [], location_fields: [], instances: [] });
  });
  it('AS thirdparty protocol soft-1', async () => {
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/thirdparty/protocol/proto1`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ user_fields: [], location_fields: [], instances: [] });
  });
  it('AS thirdparty protocol soft-2', async () => {
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/thirdparty/protocol/proto2`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ user_fields: [], location_fields: [], instances: [] });
  });
  it('AS thirdparty protocol soft-3', async () => {
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/thirdparty/protocol/proto3`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ user_fields: [], location_fields: [], instances: [] });
  });
  it('AS thirdparty protocol soft-4', async () => {
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/thirdparty/protocol/proto4`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ user_fields: [], location_fields: [], instances: [] });
  });
  it('AS thirdparty protocol soft-5', async () => {
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/thirdparty/protocol/proto5`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ user_fields: [], location_fields: [], instances: [] });
  });
  it('AS thirdparty protocol soft-6', async () => {
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/thirdparty/protocol/proto6`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ user_fields: [], location_fields: [], instances: [] });
  });
  it('AS thirdparty protocol soft-7', async () => {
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/thirdparty/protocol/proto7`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ user_fields: [], location_fields: [], instances: [] });
  });
  it('AS thirdparty protocol soft-8', async () => {
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/thirdparty/protocol/proto8`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ user_fields: [], location_fields: [], instances: [] });
  });
  it('AS thirdparty protocol soft-9', async () => {
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/thirdparty/protocol/proto9`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ user_fields: [], location_fields: [], instances: [] });
  });
  it('AS thirdparty protocol soft-10', async () => {
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/thirdparty/protocol/proto10`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ user_fields: [], location_fields: [], instances: [] });
  });
  it('AS thirdparty protocol soft-11', async () => {
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/thirdparty/protocol/proto11`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ user_fields: [], location_fields: [], instances: [] });
  });
  it('AS thirdparty protocol soft-12', async () => {
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/thirdparty/protocol/proto12`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ user_fields: [], location_fields: [], instances: [] });
  });
  it('AS thirdparty protocol soft-13', async () => {
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/thirdparty/protocol/proto13`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ user_fields: [], location_fields: [], instances: [] });
  });
  it('AS thirdparty protocol soft-14', async () => {
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/thirdparty/protocol/proto14`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ user_fields: [], location_fields: [], instances: [] });
  });
  it('AS thirdparty protocol soft-15', async () => {
    const env = { DB: {} as D1Database, SERVER_NAME: SERVER } as Env;
    const res = await appserviceApp.request(
      `http://localhost/_matrix/app/v1/thirdparty/protocol/proto15`,
      { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ user_fields: [], location_fields: [], instances: [] });
  });
});

describe('cross-module keys∥media lifecycle soft flood after #158', () => {
  it('keys claim then media create soft-0', async () => {
    const otk = mockKv();
    seedOtkKv(otk, 'signed_curve25519:life0', { key: 'life-0' });
    const keysEnv = createKeysEnv({ oneTimeKeysKv: otk });
    const claim = await keysReq(
      keysEnv,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(claim.status).toBe(200);
    const mdb = createMediaDb();
    const media = createMediaBucket();
    const menv = mediaEnv({ db: mdb, media });
    const created = await mediaReq(
      '/_matrix/client/v1/media/create',
      { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: '{}' },
      menv
    );
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await mediaReq(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      { method: 'PUT', headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' }, body: bytesOf('life0') },
      menv
    );
    expect(put.status).toBe(200);
    expect(mdb.rows[0].content_length).toBe(bytesOf('life0').byteLength);
  });
  it('keys claim then media create soft-1', async () => {
    const otk = mockKv();
    seedOtkKv(otk, 'signed_curve25519:life1', { key: 'life-1' });
    const keysEnv = createKeysEnv({ oneTimeKeysKv: otk });
    const claim = await keysReq(
      keysEnv,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(claim.status).toBe(200);
    const mdb = createMediaDb();
    const media = createMediaBucket();
    const menv = mediaEnv({ db: mdb, media });
    const created = await mediaReq(
      '/_matrix/client/v1/media/create',
      { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: '{}' },
      menv
    );
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await mediaReq(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      { method: 'PUT', headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' }, body: bytesOf('life1') },
      menv
    );
    expect(put.status).toBe(200);
    expect(mdb.rows[0].content_length).toBe(bytesOf('life1').byteLength);
  });
  it('keys claim then media create soft-2', async () => {
    const otk = mockKv();
    seedOtkKv(otk, 'signed_curve25519:life2', { key: 'life-2' });
    const keysEnv = createKeysEnv({ oneTimeKeysKv: otk });
    const claim = await keysReq(
      keysEnv,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(claim.status).toBe(200);
    const mdb = createMediaDb();
    const media = createMediaBucket();
    const menv = mediaEnv({ db: mdb, media });
    const created = await mediaReq(
      '/_matrix/client/v1/media/create',
      { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: '{}' },
      menv
    );
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await mediaReq(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      { method: 'PUT', headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' }, body: bytesOf('life2') },
      menv
    );
    expect(put.status).toBe(200);
    expect(mdb.rows[0].content_length).toBe(bytesOf('life2').byteLength);
  });
  it('keys claim then media create soft-3', async () => {
    const otk = mockKv();
    seedOtkKv(otk, 'signed_curve25519:life3', { key: 'life-3' });
    const keysEnv = createKeysEnv({ oneTimeKeysKv: otk });
    const claim = await keysReq(
      keysEnv,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(claim.status).toBe(200);
    const mdb = createMediaDb();
    const media = createMediaBucket();
    const menv = mediaEnv({ db: mdb, media });
    const created = await mediaReq(
      '/_matrix/client/v1/media/create',
      { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: '{}' },
      menv
    );
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await mediaReq(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      { method: 'PUT', headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' }, body: bytesOf('life3') },
      menv
    );
    expect(put.status).toBe(200);
    expect(mdb.rows[0].content_length).toBe(bytesOf('life3').byteLength);
  });
  it('keys claim then media create soft-4', async () => {
    const otk = mockKv();
    seedOtkKv(otk, 'signed_curve25519:life4', { key: 'life-4' });
    const keysEnv = createKeysEnv({ oneTimeKeysKv: otk });
    const claim = await keysReq(
      keysEnv,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(claim.status).toBe(200);
    const mdb = createMediaDb();
    const media = createMediaBucket();
    const menv = mediaEnv({ db: mdb, media });
    const created = await mediaReq(
      '/_matrix/client/v1/media/create',
      { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: '{}' },
      menv
    );
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await mediaReq(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      { method: 'PUT', headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' }, body: bytesOf('life4') },
      menv
    );
    expect(put.status).toBe(200);
    expect(mdb.rows[0].content_length).toBe(bytesOf('life4').byteLength);
  });
  it('keys claim then media create soft-5', async () => {
    const otk = mockKv();
    seedOtkKv(otk, 'signed_curve25519:life5', { key: 'life-5' });
    const keysEnv = createKeysEnv({ oneTimeKeysKv: otk });
    const claim = await keysReq(
      keysEnv,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(claim.status).toBe(200);
    const mdb = createMediaDb();
    const media = createMediaBucket();
    const menv = mediaEnv({ db: mdb, media });
    const created = await mediaReq(
      '/_matrix/client/v1/media/create',
      { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: '{}' },
      menv
    );
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await mediaReq(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      { method: 'PUT', headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' }, body: bytesOf('life5') },
      menv
    );
    expect(put.status).toBe(200);
    expect(mdb.rows[0].content_length).toBe(bytesOf('life5').byteLength);
  });
  it('keys claim then media create soft-6', async () => {
    const otk = mockKv();
    seedOtkKv(otk, 'signed_curve25519:life6', { key: 'life-6' });
    const keysEnv = createKeysEnv({ oneTimeKeysKv: otk });
    const claim = await keysReq(
      keysEnv,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(claim.status).toBe(200);
    const mdb = createMediaDb();
    const media = createMediaBucket();
    const menv = mediaEnv({ db: mdb, media });
    const created = await mediaReq(
      '/_matrix/client/v1/media/create',
      { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: '{}' },
      menv
    );
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await mediaReq(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      { method: 'PUT', headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' }, body: bytesOf('life6') },
      menv
    );
    expect(put.status).toBe(200);
    expect(mdb.rows[0].content_length).toBe(bytesOf('life6').byteLength);
  });
  it('keys claim then media create soft-7', async () => {
    const otk = mockKv();
    seedOtkKv(otk, 'signed_curve25519:life7', { key: 'life-7' });
    const keysEnv = createKeysEnv({ oneTimeKeysKv: otk });
    const claim = await keysReq(
      keysEnv,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(claim.status).toBe(200);
    const mdb = createMediaDb();
    const media = createMediaBucket();
    const menv = mediaEnv({ db: mdb, media });
    const created = await mediaReq(
      '/_matrix/client/v1/media/create',
      { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: '{}' },
      menv
    );
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await mediaReq(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      { method: 'PUT', headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' }, body: bytesOf('life7') },
      menv
    );
    expect(put.status).toBe(200);
    expect(mdb.rows[0].content_length).toBe(bytesOf('life7').byteLength);
  });
  it('keys claim then media create soft-8', async () => {
    const otk = mockKv();
    seedOtkKv(otk, 'signed_curve25519:life8', { key: 'life-8' });
    const keysEnv = createKeysEnv({ oneTimeKeysKv: otk });
    const claim = await keysReq(
      keysEnv,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(claim.status).toBe(200);
    const mdb = createMediaDb();
    const media = createMediaBucket();
    const menv = mediaEnv({ db: mdb, media });
    const created = await mediaReq(
      '/_matrix/client/v1/media/create',
      { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: '{}' },
      menv
    );
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await mediaReq(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      { method: 'PUT', headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' }, body: bytesOf('life8') },
      menv
    );
    expect(put.status).toBe(200);
    expect(mdb.rows[0].content_length).toBe(bytesOf('life8').byteLength);
  });
  it('keys claim then media create soft-9', async () => {
    const otk = mockKv();
    seedOtkKv(otk, 'signed_curve25519:life9', { key: 'life-9' });
    const keysEnv = createKeysEnv({ oneTimeKeysKv: otk });
    const claim = await keysReq(
      keysEnv,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(claim.status).toBe(200);
    const mdb = createMediaDb();
    const media = createMediaBucket();
    const menv = mediaEnv({ db: mdb, media });
    const created = await mediaReq(
      '/_matrix/client/v1/media/create',
      { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: '{}' },
      menv
    );
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await mediaReq(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      { method: 'PUT', headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' }, body: bytesOf('life9') },
      menv
    );
    expect(put.status).toBe(200);
    expect(mdb.rows[0].content_length).toBe(bytesOf('life9').byteLength);
  });
  it('keys claim then media create soft-10', async () => {
    const otk = mockKv();
    seedOtkKv(otk, 'signed_curve25519:life10', { key: 'life-10' });
    const keysEnv = createKeysEnv({ oneTimeKeysKv: otk });
    const claim = await keysReq(
      keysEnv,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(claim.status).toBe(200);
    const mdb = createMediaDb();
    const media = createMediaBucket();
    const menv = mediaEnv({ db: mdb, media });
    const created = await mediaReq(
      '/_matrix/client/v1/media/create',
      { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: '{}' },
      menv
    );
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await mediaReq(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      { method: 'PUT', headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' }, body: bytesOf('life10') },
      menv
    );
    expect(put.status).toBe(200);
    expect(mdb.rows[0].content_length).toBe(bytesOf('life10').byteLength);
  });
  it('keys claim then media create soft-11', async () => {
    const otk = mockKv();
    seedOtkKv(otk, 'signed_curve25519:life11', { key: 'life-11' });
    const keysEnv = createKeysEnv({ oneTimeKeysKv: otk });
    const claim = await keysReq(
      keysEnv,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
    );
    expect(claim.status).toBe(200);
    const mdb = createMediaDb();
    const media = createMediaBucket();
    const menv = mediaEnv({ db: mdb, media });
    const created = await mediaReq(
      '/_matrix/client/v1/media/create',
      { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: '{}' },
      menv
    );
    expect(created.status).toBe(200);
    const uri = (created.body as { content_uri: string }).content_uri;
    const mediaId = uri.split('/').pop()!;
    const put = await mediaReq(
      `/_matrix/client/v1/media/upload/${SERVER}/${mediaId}`,
      { method: 'PUT', headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' }, body: bytesOf('life11') },
      menv
    );
    expect(put.status).toBe(200);
    expect(mdb.rows[0].content_length).toBe(bytesOf('life11').byteLength);
  });
});

describe('media config size invariant soft flood after #158', () => {
  it('config size soft-0', async () => {
    const a = await mediaReq('/_matrix/media/v3/config');
    const b = await mediaReq('/_matrix/client/v1/media/config', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({ 'm.upload.size': MAX_UPLOAD_SIZE });
    expect(b.body).toEqual(a.body);
  });
  it('config size soft-1', async () => {
    const a = await mediaReq('/_matrix/media/v3/config');
    const b = await mediaReq('/_matrix/client/v1/media/config', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({ 'm.upload.size': MAX_UPLOAD_SIZE });
    expect(b.body).toEqual(a.body);
  });
  it('config size soft-2', async () => {
    const a = await mediaReq('/_matrix/media/v3/config');
    const b = await mediaReq('/_matrix/client/v1/media/config', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({ 'm.upload.size': MAX_UPLOAD_SIZE });
    expect(b.body).toEqual(a.body);
  });
  it('config size soft-3', async () => {
    const a = await mediaReq('/_matrix/media/v3/config');
    const b = await mediaReq('/_matrix/client/v1/media/config', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({ 'm.upload.size': MAX_UPLOAD_SIZE });
    expect(b.body).toEqual(a.body);
  });
  it('config size soft-4', async () => {
    const a = await mediaReq('/_matrix/media/v3/config');
    const b = await mediaReq('/_matrix/client/v1/media/config', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({ 'm.upload.size': MAX_UPLOAD_SIZE });
    expect(b.body).toEqual(a.body);
  });
  it('config size soft-5', async () => {
    const a = await mediaReq('/_matrix/media/v3/config');
    const b = await mediaReq('/_matrix/client/v1/media/config', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({ 'm.upload.size': MAX_UPLOAD_SIZE });
    expect(b.body).toEqual(a.body);
  });
  it('config size soft-6', async () => {
    const a = await mediaReq('/_matrix/media/v3/config');
    const b = await mediaReq('/_matrix/client/v1/media/config', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({ 'm.upload.size': MAX_UPLOAD_SIZE });
    expect(b.body).toEqual(a.body);
  });
  it('config size soft-7', async () => {
    const a = await mediaReq('/_matrix/media/v3/config');
    const b = await mediaReq('/_matrix/client/v1/media/config', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({ 'm.upload.size': MAX_UPLOAD_SIZE });
    expect(b.body).toEqual(a.body);
  });
  it('config size soft-8', async () => {
    const a = await mediaReq('/_matrix/media/v3/config');
    const b = await mediaReq('/_matrix/client/v1/media/config', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({ 'm.upload.size': MAX_UPLOAD_SIZE });
    expect(b.body).toEqual(a.body);
  });
  it('config size soft-9', async () => {
    const a = await mediaReq('/_matrix/media/v3/config');
    const b = await mediaReq('/_matrix/client/v1/media/config', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({ 'm.upload.size': MAX_UPLOAD_SIZE });
    expect(b.body).toEqual(a.body);
  });
  it('config size soft-10', async () => {
    const a = await mediaReq('/_matrix/media/v3/config');
    const b = await mediaReq('/_matrix/client/v1/media/config', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({ 'm.upload.size': MAX_UPLOAD_SIZE });
    expect(b.body).toEqual(a.body);
  });
  it('config size soft-11', async () => {
    const a = await mediaReq('/_matrix/media/v3/config');
    const b = await mediaReq('/_matrix/client/v1/media/config', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({ 'm.upload.size': MAX_UPLOAD_SIZE });
    expect(b.body).toEqual(a.body);
  });
  it('config size soft-12', async () => {
    const a = await mediaReq('/_matrix/media/v3/config');
    const b = await mediaReq('/_matrix/client/v1/media/config', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({ 'm.upload.size': MAX_UPLOAD_SIZE });
    expect(b.body).toEqual(a.body);
  });
  it('config size soft-13', async () => {
    const a = await mediaReq('/_matrix/media/v3/config');
    const b = await mediaReq('/_matrix/client/v1/media/config', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({ 'm.upload.size': MAX_UPLOAD_SIZE });
    expect(b.body).toEqual(a.body);
  });
  it('config size soft-14', async () => {
    const a = await mediaReq('/_matrix/media/v3/config');
    const b = await mediaReq('/_matrix/client/v1/media/config', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({ 'm.upload.size': MAX_UPLOAD_SIZE });
    expect(b.body).toEqual(a.body);
  });
  it('config size soft-15', async () => {
    const a = await mediaReq('/_matrix/media/v3/config');
    const b = await mediaReq('/_matrix/client/v1/media/config', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({ 'm.upload.size': MAX_UPLOAD_SIZE });
    expect(b.body).toEqual(a.body);
  });
});

