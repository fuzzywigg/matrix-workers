/**
 * TOKENMAXX HEAVY deepen after #94/#96 — different slice: client E2EE keys API routes.
 * Avoids key-backups (#93/#96), search (#94), oauth (#90), spaces (#89).
 * Tests-only — no product inventing.
 * Exercises upload/query/claim/changes, device_signing UIA, signatures, and SSO UIA flows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

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
    generateOpaqueId: vi.fn(async () => 'pinned-uia-session-16'),
  };
});

import keysApp from '../src/api/keys';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const DEVICE = 'DEVICEA';
const DEVICE_B = 'DEVICEB';
const SERVER = 'example.com';
const REMOTE = 'remote.example.org';

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };

function mockKv(data: Record<string, string> = {}) {
  const puts: KvPut[] = [];
  const deletes: string[] = [];
  const kv = {
    data,
    puts,
    deletes,
    get: async (key: string, type?: string) => {
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
      data[key] = value;
      puts.push({ key, value, options });
    },
    delete: async (key: string) => {
      deletes.push(key);
      delete data[key];
    },
  };
  return kv as unknown as KVNamespace & {
    data: Record<string, string>;
    puts: KvPut[];
    deletes: string[];
  };
}

type DeviceKeyMap = Record<string, unknown>;
type CrossSigningStore = {
  master?: unknown;
  self_signing?: unknown;
  user_signing?: unknown;
};

type OtkEntry = { keyId: string; keyData: unknown; claimed: boolean };
type OtkStore = Record<string, OtkEntry[]>;

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
  failGet?: boolean;
  failPut?: boolean;
} = {}) {
  const deviceKeys = opts.deviceKeys ?? {};
  const crossSigning = opts.crossSigning ?? {};
  const fetches: Array<{ url: string; method: string; body?: unknown }> = [];

  const stub = {
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

      if (opts.failGet && path.endsWith('/get')) {
        return new Response('boom', { status: 500 });
      }
      if (opts.failPut && path.endsWith('/put')) {
        return new Response('boom', { status: 500 });
      }

      if (path === '/device-keys/get') {
        const deviceId = url.searchParams.get('device_id');
        if (deviceId) {
          return Response.json(deviceKeys[deviceId] ?? null);
        }
        return Response.json(deviceKeys);
      }

      if (path === '/device-keys/put') {
        const b = body as { device_id: string; keys: unknown };
        deviceKeys[b.device_id] = b.keys as DeviceKeyMap;
        return Response.json({ success: true });
      }

      if (path === '/cross-signing/get') {
        return Response.json(crossSigning);
      }

      if (path === '/cross-signing/put') {
        Object.assign(crossSigning, body as CrossSigningStore);
        return Response.json({ success: true });
      }

      return new Response('not found', { status: 404 });
    },
  };

  return stub;
}

function createFederationStub() {
  const fetches: Array<{ url: string; body?: unknown }> = [];
  return {
    fetches,
    async fetch(req: Request): Promise<Response> {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        body = undefined;
      }
      fetches.push({ url: req.url, body });
      return Response.json({ ok: true });
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
  accountData?: Map<string, string>;
  throwOnSignatureInsert?: boolean;
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
  const accountData = opts.accountData ?? new Map<string, string>();
  let nextOtkId = otks.reduce((m, r) => Math.max(m, r.id), 0) + 1;

  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const runs: SqlCall[] = [];

  const db = {
    streamPositions,
    otks,
    fallbacks,
    signatures,
    keyChanges,
    memberships,
    crossSigningKeys,
    idpLinkCounts,
    passwordHashes,
    accountData,
    inserts,
    updates,
    runs,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              // stream position
              if (sql.includes('SELECT position FROM stream_positions')) {
                const name = args[0] as string;
                return { position: streamPositions[name] ?? 1 } as T;
              }

              // cross_signing_keys count
              if (sql.includes('SELECT COUNT(*) as count FROM cross_signing_keys')) {
                const userId = args[0] as string;
                const count = crossSigningKeys.filter((k) => k.user_id === userId).length;
                return { count } as T;
              }

              // idp_user_links count
              if (sql.includes('SELECT COUNT(*) as count FROM idp_user_links')) {
                const userId = args[0] as string;
                return { count: idpLinkCounts.get(userId) ?? 0 } as T;
              }

              // password hash
              if (sql.includes('SELECT password_hash FROM users')) {
                const userId = args[0] as string;
                if (!passwordHashes.has(userId)) return null;
                return { password_hash: passwordHashes.get(userId) ?? null } as T;
              }

              // SSSS account_data
              if (
                sql.includes('FROM account_data') &&
                sql.includes('m.secret_storage.default_key')
              ) {
                const userId = args[0] as string;
                const content = accountData.get(userId);
                if (!content) return null;
                return { content } as T;
              }

              // legacy OTK claim
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

              // fallback key
              if (sql.includes('FROM fallback_keys')) {
                const [userId, deviceId, algorithm] = args as [string, string, string];
                const hit = fallbacks.find(
                  (f) =>
                    f.user_id === userId &&
                    f.device_id === deviceId &&
                    f.algorithm === algorithm
                );
                if (!hit) return null;
                return {
                  key_id: hit.key_id,
                  key_data: hit.key_data,
                  used: hit.used,
                } as T;
              }

              return null;
            },

            async all<T>() {
              // cross_signing_signatures for merge
              if (sql.includes('FROM cross_signing_signatures') && sql.includes('SELECT signer_user_id')) {
                const [userId, keyId] = args as [string, string];
                const results = signatures.filter(
                  (s) => s.user_id === userId && s.key_id === keyId
                );
                return { results } as { results: T[] };
              }

              // keys/changes shared-room users
              if (
                sql.includes('FROM device_key_changes dkc') &&
                sql.includes('room_memberships')
              ) {
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
                // DISTINCT-ish
                const seen = new Set<string>();
                const distinct = results.filter((r) => {
                  const k = `${r.user_id}:${r.change_type}`;
                  if (seen.has(k)) return false;
                  seen.add(k);
                  return true;
                });
                return { results: distinct } as { results: T[] };
              }

              // getServersInRoomsWithUser
              if (
                sql.includes('SUBSTR(rm2.user_id') &&
                sql.includes('room_memberships rm1')
              ) {
                const requester = args[0] as string;
                const joinedRooms = new Set(
                  memberships
                    .filter((m) => m.user_id === requester && m.membership === 'join')
                    .map((m) => m.room_id)
                );
                const servers = new Set<string>();
                for (const m of memberships) {
                  if (!joinedRooms.has(m.room_id) || m.membership !== 'join') continue;
                  if (m.user_id === requester) continue;
                  const idx = m.user_id.indexOf(':');
                  if (idx > 0) servers.add(m.user_id.slice(idx + 1));
                }
                return {
                  results: [...servers].map((server_name) => ({ server_name })),
                } as { results: T[] };
              }

              return { results: [] as T[] };
            },

            async run(): Promise<{ meta: { changes: number; last_row_id: number }; success: boolean }> {
              runs.push({ sql, args });

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
                  number,
                ];
                keyChanges.push({
                  user_id: userId,
                  device_id: deviceId,
                  change_type: changeType,
                  stream_position: streamPosition,
                });
                return { success: true, meta: { changes: 1, last_row_id: keyChanges.length } };
              }

              if (sql.includes('INSERT INTO one_time_keys')) {
                inserts.push({ sql, args });
                const [userId, deviceId, algorithm, keyId, keyData] = args as [
                  string,
                  string,
                  string,
                  string,
                  string,
                ];
                const existing = otks.find(
                  (k) =>
                    k.user_id === userId &&
                    k.device_id === deviceId &&
                    k.algorithm === algorithm &&
                    k.key_id === keyId
                );
                if (existing) {
                  existing.key_data = keyData;
                  existing.claimed = 0;
                } else {
                  otks.push({
                    id: nextOtkId++,
                    user_id: userId,
                    device_id: deviceId,
                    algorithm,
                    key_id: keyId,
                    key_data: keyData,
                    claimed: 0,
                  });
                }
                return { success: true, meta: { changes: 1, last_row_id: nextOtkId } };
              }

              if (sql.includes('UPDATE one_time_keys SET claimed = 1') && sql.includes('key_id = ?')) {
                updates.push({ sql, args });
                const [, userId, deviceId, keyId] = args as [number, string, string, string];
                const hit = otks.find(
                  (k) =>
                    k.user_id === userId && k.device_id === deviceId && k.key_id === keyId
                );
                if (hit) hit.claimed = 1;
                return { success: true, meta: { changes: hit ? 1 : 0, last_row_id: 0 } };
              }

              if (sql.includes('UPDATE one_time_keys SET claimed = 1') && sql.includes('WHERE id = ?')) {
                updates.push({ sql, args });
                const [, id] = args as [number, number];
                const hit = otks.find((k) => k.id === id);
                if (hit) hit.claimed = 1;
                return { success: true, meta: { changes: hit ? 1 : 0, last_row_id: 0 } };
              }

              if (sql.includes('INSERT INTO fallback_keys')) {
                inserts.push({ sql, args });
                const [userId, deviceId, algorithm, keyId, keyData] = args as [
                  string,
                  string,
                  string,
                  string,
                  string,
                ];
                const existing = fallbacks.find(
                  (f) =>
                    f.user_id === userId &&
                    f.device_id === deviceId &&
                    f.algorithm === algorithm
                );
                if (existing) {
                  existing.key_id = keyId;
                  existing.key_data = keyData;
                  existing.used = 0;
                } else {
                  fallbacks.push({
                    user_id: userId,
                    device_id: deviceId,
                    algorithm,
                    key_id: keyId,
                    key_data: keyData,
                    used: 0,
                  });
                }
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              if (sql.includes('UPDATE fallback_keys SET used = 1')) {
                updates.push({ sql, args });
                const [userId, deviceId, algorithm] = args as [string, string, string];
                const hit = fallbacks.find(
                  (f) =>
                    f.user_id === userId &&
                    f.device_id === deviceId &&
                    f.algorithm === algorithm
                );
                if (hit) hit.used = 1;
                return { success: true, meta: { changes: hit ? 1 : 0, last_row_id: 0 } };
              }

              if (sql.includes('INSERT INTO cross_signing_signatures')) {
                if (opts.throwOnSignatureInsert) {
                  throw new Error('signature insert failed');
                }
                inserts.push({ sql, args });
                const [userId, keyId, signerUserId, signerKeyId, signature] = args as [
                  string,
                  string,
                  string,
                  string,
                  string,
                ];
                const existing = signatures.find(
                  (s) =>
                    s.user_id === userId &&
                    s.key_id === keyId &&
                    s.signer_user_id === signerUserId &&
                    s.signer_key_id === signerKeyId
                );
                if (existing) {
                  existing.signature = signature;
                } else {
                  signatures.push({
                    user_id: userId,
                    key_id: keyId,
                    signer_user_id: signerUserId,
                    signer_key_id: signerKeyId,
                    signature,
                  });
                }
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              if (sql.includes('INSERT INTO cross_signing_keys')) {
                inserts.push({ sql, args });
                // SQL binds: userId, keyId, JSON — key_type is literal in SQL
                const keyTypeMatch = sql.match(/VALUES \(\?, '(\w+)', \?, \?\)/);
                const keyType = keyTypeMatch?.[1] ?? 'master';
                const [userId, keyId, keyData] = args as [string, string, string];
                const existing = crossSigningKeys.find(
                  (k) => k.user_id === userId && k.key_type === keyType
                );
                if (existing) {
                  existing.key_id = keyId;
                  existing.key_data = keyData;
                } else {
                  crossSigningKeys.push({
                    user_id: userId,
                    key_type: keyType,
                    key_id: keyId,
                    key_data: keyData,
                  });
                }
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              throw new Error(`Unhandled SQL in keys test stub: ${sql.slice(0, 140)}`);
            },
          };
        },
      };
    },
  };

  return db;
}

type KeysDb = ReturnType<typeof createKeysDb>;
type UserKeysStub = ReturnType<typeof createUserKeysStub>;
type FedStub = ReturnType<typeof createFederationStub>;

function createEnv(opts: {
  db?: KeysDb;
  deviceKeysKv?: ReturnType<typeof mockKv>;
  oneTimeKeysKv?: ReturnType<typeof mockKv>;
  cacheKv?: ReturnType<typeof mockKv>;
  accountDataKv?: ReturnType<typeof mockKv>;
  crossSigningKv?: ReturnType<typeof mockKv>;
  userKeys?: UserKeysStub;
  federation?: FedStub;
  remoteServers?: string[];
} = {}) {
  const db = opts.db ?? createKeysDb();
  const deviceKeysKv = opts.deviceKeysKv ?? mockKv();
  const oneTimeKeysKv = opts.oneTimeKeysKv ?? mockKv();
  const cacheKv = opts.cacheKv ?? mockKv();
  const accountDataKv = opts.accountDataKv ?? mockKv();
  const crossSigningKv = opts.crossSigningKv ?? mockKv();
  const userKeys = opts.userKeys ?? createUserKeysStub();
  const federation = opts.federation ?? createFederationStub();

  // Per-server federation stubs keyed by idFromName
  const fedByServer = new Map<string, FedStub>();
  const remoteServers = opts.remoteServers ?? [];

  // Seed memberships for getServersInRoomsWithUser when remoteServers provided
  if (remoteServers.length > 0 && db.memberships.length === 0) {
    db.memberships.push(
      { room_id: '!shared:example.com', user_id: USER, membership: 'join' },
      ...remoteServers.map((s) => ({
        room_id: '!shared:example.com',
        user_id: `@remote:user@${s}`.includes('@') ? `@remote:${s}` : `@u:${s}`,
        membership: 'join' as const,
      }))
    );
    // Fix remote user ids
    for (let i = 0; i < remoteServers.length; i++) {
      db.memberships[i + 1] = {
        room_id: '!shared:example.com',
        user_id: `@remote:${remoteServers[i]}`,
        membership: 'join',
      };
    }
  }

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
      idFromName: (name: string) => {
        if (!fedByServer.has(name)) {
          fedByServer.set(name, createFederationStub());
        }
        return { name, toString: () => name };
      },
      get: (id: { name: string }) => {
        if (!fedByServer.has(id.name)) {
          fedByServer.set(id.name, federation);
        }
        // Prefer shared federation stub for assertions when only one remote
        return fedByServer.get(id.name) ?? federation;
      },
    },
    _fedByServer: fedByServer,
    _userKeys: userKeys,
    _db: db,
    _cache: cacheKv,
    _otk: oneTimeKeysKv,
    _deviceKeys: deviceKeysKv,
    _accountData: accountDataKv,
    _crossSigning: crossSigningKv,
  };

  return env as unknown as Env & typeof env;
}

async function request(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown; headers: Headers; text: string }> {
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

function deviceKeysPayload(overrides: Record<string, unknown> = {}) {
  return {
    user_id: USER,
    device_id: DEVICE,
    algorithms: ['m.olm.v1.curve25519-aes-sha2', 'm.megolm.v1.aes-sha2'],
    keys: {
      [`curve25519:${DEVICE}`]: 'curveKey',
      [`ed25519:${DEVICE}`]: 'edKey',
    },
    signatures: {
      [USER]: { [`ed25519:${DEVICE}`]: 'sig' },
    },
    ...overrides,
  };
}

function masterKeyPayload() {
  return {
    user_id: USER,
    usage: ['master'],
    keys: { 'ed25519:master': 'masterPub' },
    signatures: { [USER]: { [`ed25519:${DEVICE}`]: 'msig' } },
  };
}

function selfSigningKeyPayload() {
  return {
    user_id: USER,
    usage: ['self_signing'],
    keys: { 'ed25519:ssk': 'sskPub' },
    signatures: { [USER]: { 'ed25519:master': 'ssig' } },
  };
}

function userSigningKeyPayload() {
  return {
    user_id: USER,
    usage: ['user_signing'],
    keys: { 'ed25519:usk': 'uskPub' },
    signatures: { [USER]: { 'ed25519:master': 'usig' } },
  };
}

// ---------------------------------------------------------------------------
// POST /keys/upload
// ---------------------------------------------------------------------------

describe('keys POST /keys/upload', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects non-JSON body with M_BAD_JSON', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/keys/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('rejects device_keys that do not match authenticated user/device', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        device_keys: deviceKeysPayload({ user_id: BOB, device_id: 'OTHER' }),
      })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_INVALID_PARAM',
      error: expect.stringContaining('must match authenticated user'),
    });
    expect(env._userKeys.fetches).toEqual([]);
  });

  it('rejects mismatched device_id alone', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        device_keys: deviceKeysPayload({ device_id: 'WRONG' }),
      })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('uploads device_keys to DO + KV and records key change', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({
      unsigned: { device_display_name: 'Alice Phone' },
    });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: keys })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ one_time_key_counts: {} });
    expect(env._userKeys.deviceKeys[DEVICE]).toEqual(keys);
    expect(env._deviceKeys.data[`device:${USER}:${DEVICE}`]).toBe(JSON.stringify(keys));
    expect(env._db.keyChanges).toHaveLength(1);
    expect(env._db.keyChanges[0]).toMatchObject({
      user_id: USER,
      device_id: DEVICE,
      change_type: 'update',
      stream_position: 11,
    });
  });

  it('queues m.device_list_update EDUs to remote servers sharing rooms', async () => {
    const fed = createFederationStub();
    const env = createEnv({ federation: fed, remoteServers: [REMOTE] });
    // Force FEDERATION.get to return our shared stub
    (env as { FEDERATION: { get: (id: { name: string }) => FedStub } }).FEDERATION.get = () =>
      fed;

    const keys = deviceKeysPayload({
      unsigned: { device_display_name: 'Phone' },
    });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: keys })
    );
    expect(res.status).toBe(200);
    expect(fed.fetches.length).toBeGreaterThanOrEqual(1);
    expect(fed.fetches[0].body).toMatchObject({
      destination: REMOTE,
      edu_type: 'm.device_list_update',
      content: {
        user_id: USER,
        device_id: DEVICE,
        device_display_name: 'Phone',
        deleted: false,
        keys,
      },
    });
  });

  it('swallows federation EDU failures without failing upload', async () => {
    const env = createEnv({ remoteServers: [REMOTE] });
    (env as { FEDERATION: { get: () => { fetch: () => Promise<Response> } } }).FEDERATION.get =
      () => ({
        fetch: async () => {
          throw new Error('fed down');
        },
      });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload() })
    );
    expect(res.status).toBe(200);
    expect(env._userKeys.deviceKeys[DEVICE]).toBeTruthy();
  });

  it('uploads one_time_keys into KV+D1 and returns unclaimed counts', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        one_time_keys: {
          'signed_curve25519:AAAA': { key: 'otk1' },
          'signed_curve25519:BBBB': { key: 'otk2' },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_key_counts: { signed_curve25519: 2 },
    });
    const stored = JSON.parse(env._otk.data[`otk:${USER}:${DEVICE}`]) as OtkStore;
    expect(stored.signed_curve25519).toHaveLength(2);
    expect(env._db.otks).toHaveLength(2);
  });

  it('replaces an existing one-time key id instead of duplicating', async () => {
    const otkKv = mockKv({
      [`otk:${USER}:${DEVICE}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:AAAA', keyData: { key: 'old' }, claimed: false },
        ],
      }),
    });
    const env = createEnv({ oneTimeKeysKv: otkKv });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        one_time_keys: { 'signed_curve25519:AAAA': { key: 'new' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_key_counts: { signed_curve25519: 1 },
    });
    const stored = JSON.parse(otkKv.data[`otk:${USER}:${DEVICE}`]) as OtkStore;
    expect(stored.signed_curve25519).toHaveLength(1);
    expect(stored.signed_curve25519[0].keyData).toEqual({ key: 'new' });
  });

  it('returns existing OTK counts when uploading without one_time_keys', async () => {
    const otkKv = mockKv({
      [`otk:${USER}:${DEVICE}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:A', keyData: {}, claimed: false },
          { keyId: 'signed_curve25519:B', keyData: {}, claimed: true },
        ],
        curve25519: [{ keyId: 'curve25519:C', keyData: {}, claimed: false }],
      }),
    });
    const env = createEnv({ oneTimeKeysKv: otkKv });
    const res = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_key_counts: { signed_curve25519: 1, curve25519: 1 },
    });
  });

  it('returns empty counts when no OTKs exist and body is empty', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ one_time_key_counts: {} });
  });

  it('stores fallback_keys in D1', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        fallback_keys: {
          'signed_curve25519:FALLBACK': { key: 'fb', fallback: true },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(env._db.fallbacks).toHaveLength(1);
    expect(env._db.fallbacks[0]).toMatchObject({
      user_id: USER,
      device_id: DEVICE,
      algorithm: 'signed_curve25519',
      key_id: 'signed_curve25519:FALLBACK',
      used: 0,
    });
  });

  it('upserts fallback_keys for the same algorithm', async () => {
    const db = createKeysDb({
      fallbacks: [
        {
          user_id: USER,
          device_id: DEVICE,
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:OLD',
          key_data: JSON.stringify({ key: 'old' }),
          used: 1,
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        fallback_keys: { 'signed_curve25519:NEW': { key: 'new' } },
      })
    );
    expect(res.status).toBe(200);
    expect(db.fallbacks).toHaveLength(1);
    expect(db.fallbacks[0]).toMatchObject({
      key_id: 'signed_curve25519:NEW',
      used: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// POST /keys/query
// ---------------------------------------------------------------------------

describe('keys POST /keys/query', () => {
  it('rejects non-JSON body with M_BAD_JSON', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: 'nope',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('returns empty maps when device_keys is omitted', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/keys/query', jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      device_keys: {},
      master_keys: {},
      self_signing_keys: {},
      user_signing_keys: {},
      failures: {},
    });
  });

  it('queries all devices when device list is empty array', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: deviceKeysPayload(),
        [DEVICE_B]: deviceKeysPayload({ device_id: DEVICE_B }),
      },
      crossSigning: {
        master: masterKeyPayload(),
        self_signing: selfSigningKeyPayload(),
        user_signing: userSigningKeyPayload(),
      },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      device_keys: Record<string, Record<string, unknown>>;
      master_keys: Record<string, unknown>;
      self_signing_keys: Record<string, unknown>;
      user_signing_keys: Record<string, unknown>;
    };
    expect(Object.keys(body.device_keys[USER])).toEqual(
      expect.arrayContaining([DEVICE, DEVICE_B])
    );
    expect(body.master_keys[USER]).toEqual(masterKeyPayload());
    expect(body.self_signing_keys[USER]).toEqual(selfSigningKeyPayload());
    // Own user_signing is returned
    expect(body.user_signing_keys[USER]).toEqual(userSigningKeyPayload());
  });

  it('queries specific devices and merges DB signatures', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: deviceKeysPayload(),
      },
    });
    const db = createKeysDb({
      signatures: [
        {
          user_id: USER,
          key_id: DEVICE,
          signer_user_id: USER,
          signer_key_id: 'ed25519:master',
          signature: 'crossSig',
        },
      ],
    });
    const env = createEnv({ userKeys, db });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      device_keys: Record<string, Record<string, { signatures: Record<string, Record<string, string>> }>>;
    };
    expect(body.device_keys[USER][DEVICE].signatures[USER]['ed25519:master']).toBe('crossSig');
  });

  it('hides user_signing keys when querying another user', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {},
      crossSigning: {
        master: { keys: { 'ed25519:m': 'x' } },
        user_signing: { keys: { 'ed25519:u': 'y' } },
      },
    });
    // DO is shared stub; for Bob query the same stub is used (idFromName differs but get returns same)
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [BOB]: [] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      master_keys: Record<string, unknown>;
      user_signing_keys: Record<string, unknown>;
    };
    expect(body.master_keys[BOB]).toEqual({ keys: { 'ed25519:m': 'x' } });
    expect(body.user_signing_keys[BOB]).toBeUndefined();
    expect(body.user_signing_keys).toEqual({});
  });

  it('skips null device entries from DO when listing all devices', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: deviceKeysPayload(),
        GONE: null as unknown as DeviceKeyMap,
      },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER].GONE).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// POST /keys/claim
// ---------------------------------------------------------------------------

describe('keys POST /keys/claim', () => {
  it('rejects non-JSON body with M_BAD_JSON', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/keys/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: '{',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('returns empty one_time_keys when request omits one_time_keys', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ one_time_keys: {}, failures: {} });
  });

  it('claims first unclaimed OTK from KV and marks claimed in KV+D1', async () => {
    const otkKv = mockKv({
      [`otk:${BOB}:${DEVICE_B}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:AAA', keyData: { key: 'k1' }, claimed: true },
          { keyId: 'signed_curve25519:BBB', keyData: { key: 'k2' }, claimed: false },
        ],
      }),
    });
    const env = createEnv({ oneTimeKeysKv: otkKv });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [DEVICE_B]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: {
        [BOB]: { [DEVICE_B]: { 'signed_curve25519:BBB': { key: 'k2' } } },
      },
      failures: {},
    });
    const stored = JSON.parse(otkKv.data[`otk:${BOB}:${DEVICE_B}`]) as OtkStore;
    expect(stored.signed_curve25519[1].claimed).toBe(true);
    expect(env._db.updates.some((u) => u.sql.includes('UPDATE one_time_keys SET claimed'))).toBe(
      true
    );
  });

  it('falls back to D1 legacy OTKs when KV has none unclaimed', async () => {
    const db = createKeysDb({
      otks: [
        {
          id: 7,
          user_id: BOB,
          device_id: DEVICE_B,
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:LEGACY',
          key_data: JSON.stringify({ key: 'legacy' }),
          claimed: 0,
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [DEVICE_B]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: {
        [BOB]: { [DEVICE_B]: { 'signed_curve25519:LEGACY': { key: 'legacy' } } },
      },
      failures: {},
    });
    expect(db.otks[0].claimed).toBe(1);
  });

  it('falls back to fallback_keys and marks used with fallback:true', async () => {
    const db = createKeysDb({
      fallbacks: [
        {
          user_id: BOB,
          device_id: DEVICE_B,
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:FB',
          key_data: JSON.stringify({ key: 'fbkey' }),
          used: 0,
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [DEVICE_B]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: {
        [BOB]: {
          [DEVICE_B]: {
            'signed_curve25519:FB': { key: 'fbkey', fallback: true },
          },
        },
      },
      failures: {},
    });
    expect(db.fallbacks[0].used).toBe(1);
  });

  it('returns empty device map entry when no OTK or fallback exists', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [DEVICE_B]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [BOB]: {} },
      failures: {},
    });
  });

  it('skips claimed-only KV algorithm buckets and tries D1 then fallback', async () => {
    const otkKv = mockKv({
      [`otk:${BOB}:${DEVICE_B}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:X', keyData: { key: 'x' }, claimed: true },
        ],
      }),
    });
    const db = createKeysDb({
      fallbacks: [
        {
          user_id: BOB,
          device_id: DEVICE_B,
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:FB2',
          key_data: JSON.stringify({ key: 'fb2' }),
          used: 0,
        },
      ],
    });
    const env = createEnv({ oneTimeKeysKv: otkKv, db });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [DEVICE_B]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      one_time_keys: Record<string, Record<string, Record<string, { fallback?: boolean }>>>;
    };
    expect(body.one_time_keys[BOB][DEVICE_B]['signed_curve25519:FB2'].fallback).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /keys/changes
// ---------------------------------------------------------------------------

describe('keys GET /keys/changes', () => {
  it('requires from and to query params', async () => {
    const env = createEnv();
    const a = await request(env, '/_matrix/client/v3/keys/changes', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(a.status).toBe(400);
    expect(a.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });

    const b = await request(env, '/_matrix/client/v3/keys/changes?from=1', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(b.status).toBe(400);
    expect(b.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('splits changed vs left for shared-room users in stream range', async () => {
    const db = createKeysDb({
      memberships: [
        { room_id: '!r1:example.com', user_id: USER, membership: 'join' },
        { room_id: '!r1:example.com', user_id: BOB, membership: 'join' },
        { room_id: '!r1:example.com', user_id: '@carol:example.com', membership: 'join' },
        { room_id: '!other:example.com', user_id: '@outsider:example.com', membership: 'join' },
      ],
      keyChanges: [
        { user_id: BOB, device_id: 'D', change_type: 'update', stream_position: 5 },
        { user_id: BOB, device_id: 'D', change_type: 'update', stream_position: 6 },
        { user_id: '@carol:example.com', device_id: null, change_type: 'delete', stream_position: 7 },
        {
          user_id: '@outsider:example.com',
          device_id: 'X',
          change_type: 'update',
          stream_position: 8,
        },
        { user_id: BOB, device_id: 'D', change_type: 'update', stream_position: 100 },
      ],
    });
    const env = createEnv({ db });
    const res = await request(env, '/_matrix/client/v3/keys/changes?from=4&to=10', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      changed: [BOB],
      left: ['@carol:example.com'],
    });
  });

  it('treats invalid from as 0 and invalid to as MAX_SAFE_INTEGER', async () => {
    const db = createKeysDb({
      memberships: [
        { room_id: '!r:example.com', user_id: USER, membership: 'join' },
        { room_id: '!r:example.com', user_id: BOB, membership: 'join' },
      ],
      keyChanges: [
        { user_id: BOB, device_id: 'D', change_type: 'update', stream_position: 1 },
        {
          user_id: BOB,
          device_id: 'D',
          change_type: 'update',
          stream_position: Number.MAX_SAFE_INTEGER,
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(env, '/_matrix/client/v3/keys/changes?from=abc&to=xyz', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ changed: [BOB], left: [] });
  });
});

// ---------------------------------------------------------------------------
// POST /keys/device_signing/upload
// ---------------------------------------------------------------------------

describe('keys POST /keys/device_signing/upload', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects non-JSON body with M_BAD_JSON', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/keys/device_signing/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: 'x',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('skips UIA on first-time cross-signing setup (MSC3967)', async () => {
    const env = createEnv();
    const master = masterKeyPayload();
    const self = selfSigningKeyPayload();
    const user = userSigningKeyPayload();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: master,
        self_signing_key: self,
        user_signing_key: user,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(env._userKeys.crossSigning).toMatchObject({
      master,
      self_signing: self,
      user_signing: user,
    });
    expect(env._db.crossSigningKeys.map((k) => k.key_type).sort()).toEqual([
      'master',
      'self_signing',
      'user_signing',
    ]);
    expect(JSON.parse(env._crossSigning.data[`user:${USER}`])).toMatchObject({
      master,
      self_signing: self,
      user_signing: user,
    });
    expect(env._db.keyChanges.some((c) => c.change_type === 'update')).toBe(true);
  });

  it('returns UIA password challenge when replacing existing keys without auth', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        {
          user_id: USER,
          key_type: 'master',
          key_id: 'ed25519:master',
          key_data: '{}',
        },
      ],
      passwordHashes: new Map([[USER, 'mockok:secret']]),
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload() })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      session: 'pinned-uia-session-16',
      flows: [{ stages: ['m.login.password'] }],
    });
    expect(env._cache.data['uia_session:pinned-uia-session-16']).toBeTruthy();
    const session = JSON.parse(env._cache.data['uia_session:pinned-uia-session-16']);
    expect(session).toMatchObject({
      user_id: USER,
      type: 'device_signing_upload',
      is_oidc_user: false,
      has_password: true,
    });
  });

  it('returns MSC4312 OAuth UIA flows for OIDC users with existing keys', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'm', key_data: '{}' },
      ],
      idpLinkCounts: new Map([[USER, 1]]),
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload() })
    );
    expect(res.status).toBe(401);
    const body = res.body as {
      flows: Array<{ stages: string[] }>;
      params: Record<string, { url: string }>;
      session: string;
    };
    expect(body.flows).toEqual([
      { stages: ['org.matrix.cross_signing_reset'] },
      { stages: ['m.oauth'] },
    ]);
    expect(body.params['org.matrix.cross_signing_reset'].url).toContain(
      '/oauth/authorize/uia?session=pinned-uia-session-16'
    );
    expect(body.params['m.oauth'].url).toBe(
      body.params['org.matrix.cross_signing_reset'].url
    );
  });

  it('offers both OIDC and password flows when user has both', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'm', key_data: '{}' },
      ],
      idpLinkCounts: new Map([[USER, 2]]),
      passwordHashes: new Map([[USER, 'mockok:pw']]),
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload() })
    );
    expect(res.status).toBe(401);
    const body = res.body as { flows: Array<{ stages: string[] }> };
    expect(body.flows).toEqual([
      { stages: ['org.matrix.cross_signing_reset'] },
      { stages: ['m.oauth'] },
      { stages: ['m.login.password'] },
    ]);
  });

  it('falls back to password flow when user has neither OIDC nor password', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'm', key_data: '{}' },
      ],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload() })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.password'] }],
    });
  });

  it('accepts password auth and replaces keys', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'old', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:secret']]),
    });
    const userKeys = createUserKeysStub({
      crossSigning: { master: { keys: { old: 'x' } } },
    });
    const env = createEnv({ db, userKeys });
    const master = masterKeyPayload();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: master,
        auth: { type: 'm.login.password', password: 'secret' },
      })
    );
    expect(res.status).toBe(200);
    expect(userKeys.crossSigning.master).toEqual(master);
  });

  it('rejects password auth when user has no password hash', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'm', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, null]]),
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: masterKeyPayload(),
        auth: { type: 'm.login.password', password: 'x' },
      })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('rejects password auth missing password field', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'm', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:secret']]),
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: masterKeyPayload(),
        auth: { type: 'm.login.password' },
      })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('rejects invalid password', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'm', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, 'mockok:secret']]),
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: masterKeyPayload(),
        auth: { type: 'm.login.password', password: 'wrong' },
      })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('accepts MSC4312 session auth after completed stage and deletes session', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'm', key_data: '{}' },
      ],
      idpLinkCounts: new Map([[USER, 1]]),
    });
    const cache = mockKv({
      'uia_session:sess1': JSON.stringify({
        user_id: USER,
        completed_stages: ['org.matrix.cross_signing_reset'],
      }),
    });
    const env = createEnv({ db, cacheKv: cache });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: masterKeyPayload(),
        auth: { type: 'org.matrix.cross_signing_reset', session: 'sess1' },
      })
    );
    expect(res.status).toBe(200);
    expect(cache.data['uia_session:sess1']).toBeUndefined();
    expect(cache.deletes).toContain('uia_session:sess1');
  });

  it('accepts auth with no type when session has m.login.token completed', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'm', key_data: '{}' },
      ],
    });
    const cache = mockKv({
      'uia_session:sess2': JSON.stringify({
        user_id: USER,
        completed_stages: ['m.login.token'],
      }),
    });
    const env = createEnv({ db, cacheKv: cache });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        self_signing_key: selfSigningKeyPayload(),
        auth: { session: 'sess2' },
      })
    );
    expect(res.status).toBe(200);
  });

  it('rejects OAuth auth missing session', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'm', key_data: '{}' },
      ],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: masterKeyPayload(),
        auth: { type: 'm.oauth' },
      })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('rejects expired UIA session', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'm', key_data: '{}' },
      ],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: masterKeyPayload(),
        auth: { type: 'm.login.sso', session: 'missing' },
      })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      errcode: 'M_UNKNOWN',
      error: expect.stringContaining('expired'),
    });
  });

  it('rejects UIA session belonging to another user', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'm', key_data: '{}' },
      ],
    });
    const cache = mockKv({
      'uia_session:sess3': JSON.stringify({
        user_id: BOB,
        completed_stages: ['m.oauth'],
      }),
    });
    const env = createEnv({ db, cacheKv: cache });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: masterKeyPayload(),
        auth: { type: 'm.oauth', session: 'sess3' },
      })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('rejects UIA session without completed OAuth stage', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'm', key_data: '{}' },
      ],
    });
    const cache = mockKv({
      'uia_session:sess4': JSON.stringify({
        user_id: USER,
        completed_stages: [],
      }),
    });
    const env = createEnv({ db, cacheKv: cache });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: masterKeyPayload(),
        auth: { type: 'm.login.oauth', session: 'sess4' },
      })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ errcode: 'M_UNAUTHORIZED' });
  });

  it('rejects unrecognized auth type', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'm', key_data: '{}' },
      ],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: masterKeyPayload(),
        auth: { type: 'm.login.email' },
      })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_UNRECOGNIZED',
      error: expect.stringContaining('m.login.email'),
    });
  });

  it('allows upload when SSSS is present in ACCOUNT_DATA KV', async () => {
    const accountDataKv = mockKv({
      [`global:${USER}:m.secret_storage.default_key`]: JSON.stringify({ key: 'ssk' }),
    });
    const env = createEnv({ accountDataKv });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload() })
    );
    expect(res.status).toBe(200);
  });

  it('allows upload when SSSS is only in D1 account_data', async () => {
    const db = createKeysDb({
      accountData: new Map([[USER, JSON.stringify({ key: 'd1key' })]]),
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload() })
    );
    expect(res.status).toBe(200);
  });

  it('treats invalid D1 SSSS JSON as missing and still allows upload', async () => {
    const db = createKeysDb({
      accountData: new Map([[USER, '{bad']]),
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload() })
    );
    expect(res.status).toBe(200);
  });

  it('merges partial key uploads with existing DO cross-signing keys', async () => {
    const userKeys = createUserKeysStub({
      crossSigning: {
        master: masterKeyPayload(),
        self_signing: selfSigningKeyPayload(),
      },
    });
    const env = createEnv({ userKeys });
    const usk = userSigningKeyPayload();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { user_signing_key: usk })
    );
    expect(res.status).toBe(200);
    expect(userKeys.crossSigning).toMatchObject({
      master: masterKeyPayload(),
      self_signing: selfSigningKeyPayload(),
      user_signing: usk,
    });
  });

  it('uses empty key_id when master_key.keys is missing', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: { user_id: USER, usage: ['master'] },
      })
    );
    expect(res.status).toBe(200);
    expect(env._db.crossSigningKeys[0].key_id).toBe('');
  });
});

// ---------------------------------------------------------------------------
// POST /keys/signatures/upload
// ---------------------------------------------------------------------------

describe('keys POST /keys/signatures/upload', () => {
  it('rejects non-JSON body with M_BAD_JSON', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/keys/signatures/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: 'no',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('stores cross-signing signatures and records key change', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [BOB]: {
          masterPub: {
            keys: { 'ed25519:masterPub': 'x' },
            signatures: {
              [USER]: { 'ed25519:usk': 'sigBobMaster' },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ failures: {} });
    expect(env._db.signatures).toEqual([
      {
        user_id: BOB,
        key_id: 'masterPub',
        signer_user_id: USER,
        signer_key_id: 'ed25519:usk',
        signature: 'sigBobMaster',
      },
    ]);
    expect(env._db.keyChanges[0]).toMatchObject({
      user_id: BOB,
      device_id: null,
      change_type: 'update',
    });
  });

  it('updates device key signatures in DO+KV when device_id present', async () => {
    const existing = deviceKeysPayload({
      user_id: BOB,
      device_id: DEVICE_B,
      signatures: { [BOB]: { [`ed25519:${DEVICE_B}`]: 'self' } },
    });
    const userKeys = createUserKeysStub({
      deviceKeys: { [DEVICE_B]: existing },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [BOB]: {
          [DEVICE_B]: {
            device_id: DEVICE_B,
            user_id: BOB,
            signatures: {
              [USER]: { 'ed25519:usk': 'crossDevice' },
            },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(userKeys.deviceKeys[DEVICE_B]).toMatchObject({
      signatures: {
        [BOB]: { [`ed25519:${DEVICE_B}`]: 'self' },
        [USER]: { 'ed25519:usk': 'crossDevice' },
      },
    });
    expect(env._deviceKeys.data[`device:${BOB}:${DEVICE_B}`]).toBeTruthy();
    expect(env._db.signatures[0].key_id).toBe(DEVICE_B);
  });

  it('ignores missing device key in DO without failing the request', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [BOB]: {
          MISSING: {
            device_id: 'MISSING',
            signatures: { [USER]: { 'ed25519:usk': 'x' } },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ failures: {} });
    expect(env._db.signatures).toHaveLength(1);
  });

  it('records per-key failures when signature insert throws', async () => {
    const db = createKeysDb({ throwOnSignatureInsert: true });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [BOB]: {
          key1: {
            signatures: { [USER]: { 'ed25519:usk': 'x' } },
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      failures: {
        [BOB]: {
          key1: { errcode: 'M_UNKNOWN', error: 'Failed to store signature' },
        },
      },
    });
  });

  it('handles empty signature maps without inserts', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [BOB]: {
          key1: { signatures: {} },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(env._db.signatures).toEqual([]);
    // Still records key change even with empty signatures
    expect(env._db.keyChanges).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// SSO / token UIA helpers under /auth/m.login.*
// ---------------------------------------------------------------------------

describe('keys UIA SSO redirect / callback / token submit', () => {
  it('SSO redirect requires session param', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/auth/m.login.sso/redirect');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('SSO redirect 404s when UIA session missing', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/auth/m.login.sso/redirect?session=nope'
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN' });
  });

  it('SSO redirect stores redirectUrl and redirects to OAuth authorize', async () => {
    const cache = mockKv({
      'uia_session:s1': JSON.stringify({ user_id: USER, completed_stages: [] }),
    });
    const env = createEnv({ cacheKv: cache });
    const res = await keysApp.request(
      'http://localhost/_matrix/client/v3/auth/m.login.sso/redirect?session=s1&redirectUrl=https://client.example/done',
      {},
      env
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get('Location')!;
    expect(loc).toContain(`https://${SERVER}/oauth/authorize?`);
    expect(loc).toContain('client_id=matrix-uia');
    expect(loc).toContain('state=s1');
    expect(loc).toContain(encodeURIComponent(`https://${SERVER}/_matrix/client/v3/auth/m.login.sso/callback`));
    const session = JSON.parse(cache.data['uia_session:s1']);
    expect(session.redirect_url).toBe('https://client.example/done');
  });

  it('SSO redirect defaults redirect_url to callback when redirectUrl omitted', async () => {
    const cache = mockKv({
      'uia_session:s2': JSON.stringify({ user_id: USER }),
    });
    const env = createEnv({ cacheKv: cache });
    await keysApp.request(
      'http://localhost/_matrix/client/v3/auth/m.login.sso/redirect?session=s2',
      {},
      env
    );
    const session = JSON.parse(cache.data['uia_session:s2']);
    expect(session.redirect_url).toBe(
      `https://${SERVER}/_matrix/client/v3/auth/m.login.sso/callback`
    );
  });

  it('SSO callback renders error page when IdP returns error', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/auth/m.login.sso/callback?error=access_denied&error_description=Nope'
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain('SSO Authentication Failed');
    expect(res.text).toContain('Nope');
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('SSO callback error page falls back to error code when description missing', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/auth/m.login.sso/callback?error=server_error'
    );
    expect(res.text).toContain('server_error');
  });

  it('SSO callback requires state', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/auth/m.login.sso/callback?code=abc');
    expect(res.text).toContain('Invalid Request');
    expect(res.text).toContain('Missing state parameter');
  });

  it('SSO callback errors when session expired', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/auth/m.login.sso/callback?code=abc&state=gone'
    );
    expect(res.text).toContain('Session Expired');
  });

  it('SSO callback marks m.login.sso complete and returns success HTML', async () => {
    const cache = mockKv({
      'uia_session:s3': JSON.stringify({
        user_id: USER,
        completed_stages: [],
        redirect_url: 'https://client/done',
      }),
    });
    const env = createEnv({ cacheKv: cache });
    const res = await request(
      env,
      '/_matrix/client/v3/auth/m.login.sso/callback?code=authcode&state=s3'
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain('Authentication Successful');
    expect(res.text).toContain('Session: s3');
    expect(res.text).toContain("type: 'uia_complete'");
    const session = JSON.parse(cache.data['uia_session:s3']);
    expect(session.completed_stages).toContain('m.login.sso');
    expect(session.sso_completed_at).toEqual(expect.any(Number));
  });

  it('SSO callback does not duplicate m.login.sso stage', async () => {
    const cache = mockKv({
      'uia_session:s4': JSON.stringify({
        user_id: USER,
        completed_stages: ['m.login.sso'],
      }),
    });
    const env = createEnv({ cacheKv: cache });
    await request(
      env,
      '/_matrix/client/v3/auth/m.login.sso/callback?code=authcode&state=s4'
    );
    const session = JSON.parse(cache.data['uia_session:s4']);
    expect(session.completed_stages.filter((s: string) => s === 'm.login.sso')).toHaveLength(
      1
    );
  });

  it('SSO callback without code renders authentication failed', async () => {
    const cache = mockKv({
      'uia_session:s5': JSON.stringify({ user_id: USER }),
    });
    const env = createEnv({ cacheKv: cache });
    const res = await request(
      env,
      '/_matrix/client/v3/auth/m.login.sso/callback?state=s5'
    );
    expect(res.text).toContain('Authentication Failed');
    expect(res.text).toContain('No authorization code received');
  });

  it('token submit rejects non-JSON', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/auth/m.login.token/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: 'x',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('token submit requires session', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/auth/m.login.token/submit',
      jsonInit('POST', {})
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('token submit 404s for missing session', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/auth/m.login.token/submit',
      jsonInit('POST', { session: 'missing' })
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN' });
  });

  it('token submit rejects session for another user', async () => {
    const cache = mockKv({
      'uia_session:t1': JSON.stringify({ user_id: BOB, completed_stages: [] }),
    });
    const env = createEnv({ cacheKv: cache });
    const res = await request(
      env,
      '/_matrix/client/v3/auth/m.login.token/submit',
      jsonInit('POST', { session: 't1' })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('token submit marks m.login.token complete', async () => {
    const cache = mockKv({
      'uia_session:t2': JSON.stringify({ user_id: USER, completed_stages: [] }),
    });
    const env = createEnv({ cacheKv: cache });
    const res = await request(
      env,
      '/_matrix/client/v3/auth/m.login.token/submit',
      jsonInit('POST', { session: 't2' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ completed: ['m.login.token'], session: 't2' });
    const session = JSON.parse(cache.data['uia_session:t2']);
    expect(session.completed_stages).toEqual(['m.login.token']);
    expect(session.token_completed_at).toEqual(expect.any(Number));
  });

  it('token submit does not duplicate completed stage', async () => {
    const cache = mockKv({
      'uia_session:t3': JSON.stringify({
        user_id: USER,
        completed_stages: ['m.login.token'],
      }),
    });
    const env = createEnv({ cacheKv: cache });
    await request(
      env,
      '/_matrix/client/v3/auth/m.login.token/submit',
      jsonInit('POST', { session: 't3' })
    );
    const session = JSON.parse(cache.data['uia_session:t3']);
    expect(session.completed_stages).toEqual(['m.login.token']);
  });
});

describe('keys DO failure surfaces', () => {
  it('returns 500 when DO device-keys put fails on upload', async () => {
    const userKeys = createUserKeysStub({ failPut: true });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload() })
    );
    expect(res.status).toBe(500);
  });

  it('returns 500 when DO device-keys get fails on query', async () => {
    const userKeys = createUserKeysStub({ failGet: true });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(res.status).toBe(500);
  });

  it('returns 500 when DO cross-signing get fails on device_signing upload', async () => {
    const userKeys = createUserKeysStub({ failGet: true });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload() })
    );
    expect(res.status).toBe(500);
  });
});

describe('keys TOKENMAXX leftover edges after #96', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('counts only unclaimed OTKs after mixed upload into existing store', async () => {
    const otkKv = mockKv({
      [`otk:${USER}:${DEVICE}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:OLD', keyData: {}, claimed: true },
        ],
      }),
    });
    const env = createEnv({ oneTimeKeysKv: otkKv });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        one_time_keys: { 'signed_curve25519:NEW': { key: 'n' } },
      })
    );
    expect(res.body).toEqual({
      one_time_key_counts: { signed_curve25519: 1 },
    });
  });

  it('accepts m.login.sso completed stage for device_signing replacement', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'm', key_data: '{}' },
      ],
    });
    const cache = mockKv({
      'uia_session:edge': JSON.stringify({
        user_id: USER,
        completed_stages: ['m.login.sso'],
      }),
    });
    const env = createEnv({ db, cacheKv: cache });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: masterKeyPayload(),
        auth: { type: 'm.login.sso', session: 'edge' },
      })
    );
    expect(res.status).toBe(200);
  });

  it('treats empty password hash string as no password for UIA capability', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'm', key_data: '{}' },
      ],
      passwordHashes: new Map([[USER, '']]),
      idpLinkCounts: new Map([[USER, 0]]),
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload() })
    );
    expect(res.status).toBe(401);
    // Neither OIDC nor password → fallback password flow only
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.password'] }],
    });
  });

  it('filters local server out of device_list_update EDU destinations', async () => {
    const fed = createFederationStub();
    const db = createKeysDb({
      memberships: [
        { room_id: '!r:example.com', user_id: USER, membership: 'join' },
        { room_id: '!r:example.com', user_id: `@local:${SERVER}`, membership: 'join' },
        { room_id: '!r:example.com', user_id: `@remote:${REMOTE}`, membership: 'join' },
      ],
    });
    const env = createEnv({ db, federation: fed });
    (env as { FEDERATION: { get: (id: { name: string }) => FedStub } }).FEDERATION.get = (
      id
    ) => {
      // Record which server was requested via a side channel on the stub
      const s = createFederationStub();
      s.fetches.push({ url: `dest:${id.name}` });
      return s;
    };
    // Simpler: capture destinations
    const destinations: string[] = [];
    (env as { FEDERATION: { idFromName: (n: string) => { name: string }; get: (id: { name: string }) => FedStub } }).FEDERATION.get =
      (id) => {
        destinations.push(id.name);
        return fed;
      };

    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload() })
    );
    expect(res.status).toBe(200);
    expect(destinations).toEqual([REMOTE]);
    expect(destinations).not.toContain(SERVER);
  });
});


describe('keys TOKENMAXX leftovers after #99/#101', () => {
  it('returns 500 when DO cross-signing put fails on first-time MSC3967 upload', async () => {
    const userKeys = createUserKeysStub({ failPut: true });
    const env = createEnv({ userKeys, db: createKeysDb({ crossSigningKeys: [] }) });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKeyPayload() })
    );
    expect(res.status).toBe(500);
  });

  it('returns 500 when DO cross-signing get fails mid-query after devices loaded', async () => {
    // failGet fails all /get including device-keys — already covered.
    // Granular: fail only cross-signing get by wrapping stub.
    const base = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: ['m.olm.v1.curve25519-aes-sha2'],
          device_id: DEVICE,
          user_id: USER,
          keys: {},
        },
      },
    });
    const orig = base.fetch.bind(base);
    base.fetch = async (req: Request) => {
      const path = new URL(req.url).pathname;
      if (path === '/cross-signing/get') {
        return new Response('cs boom', { status: 500 });
      }
      return orig(req);
    };
    const env = createEnv({ userKeys: base });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(500);
  });

  it('omits specific device id when DO returns null', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: {
          algorithms: ['m.olm.v1.curve25519-aes-sha2'],
          device_id: DEVICE,
          user_id: USER,
          keys: { 'ed25519:DEVICEA': 'k' },
        },
      },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: ['MISSING', DEVICE] } })
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>> };
    expect(body.device_keys[USER][DEVICE]).toBeTruthy();
    expect(body.device_keys[USER].MISSING).toBeUndefined();
  });

  it('claims fallback even when used=1 (code does not check used)', async () => {
    const db = createKeysDb({
      fallbacks: [
        {
          user_id: BOB,
          device_id: DEVICE_B,
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:USED',
          key_data: JSON.stringify({ key: 'used-fb' }),
          used: 1,
        },
      ],
    });
    const env = createEnv({ db, oneTimeKeysKv: mockKv() });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [DEVICE_B]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      one_time_keys: Record<string, Record<string, Record<string, { fallback?: boolean }>>>;
    };
    expect(body.one_time_keys[BOB][DEVICE_B]['signed_curve25519:USED'].fallback).toBe(true);
  });

  it('falls through to D1 OTK when KV store exists without requested algorithm bucket', async () => {
    const otkKv = mockKv({
      [`otk:${BOB}:${DEVICE_B}`]: JSON.stringify({
        curve25519: [{ keyId: 'curve25519:Z', keyData: { key: 'z' }, claimed: false }],
      }),
    });
    const db = createKeysDb({
      otks: [
        {
          id: 7,
          user_id: BOB,
          device_id: DEVICE_B,
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:D1',
          key_data: JSON.stringify({ key: 'd1' }),
          claimed: 0,
        },
      ],
    });
    const env = createEnv({ oneTimeKeysKv: otkKv, db });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [BOB]: { [DEVICE_B]: 'signed_curve25519' } },
      })
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      one_time_keys: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(body.one_time_keys[BOB][DEVICE_B]['signed_curve25519:D1']).toBeTruthy();
    expect(db.otks[0].claimed).toBe(1);
  });

  it('accepts m.oauth completed stage for device_signing replacement', async () => {
    const db = createKeysDb({
      crossSigningKeys: [
        { user_id: USER, key_type: 'master', key_id: 'm', key_data: '{}' },
      ],
    });
    const cache = mockKv({
      'uia_session:oauth-edge': JSON.stringify({
        user_id: USER,
        completed_stages: ['m.oauth'],
      }),
    });
    const env = createEnv({ db, cacheKv: cache });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: masterKeyPayload(),
        auth: { type: 'm.oauth', session: 'oauth-edge' },
      })
    );
    expect(res.status).toBe(200);
    expect(cache.data['uia_session:oauth-edge']).toBeUndefined();
  });

  it('stores empty key_id when self_signing_key lacks keys map', async () => {
    const db = createKeysDb({ crossSigningKeys: [] });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: masterKeyPayload(),
        self_signing_key: { user_id: USER, usage: ['self_signing'], signatures: {} },
      })
    );
    expect(res.status).toBe(200);
    const ss = db.crossSigningKeys.find((k) => k.key_type === 'self_signing');
    expect(ss?.key_id).toBe('');
  });

  it('signatures/upload with no signatures[signer] still records key change', async () => {
    const db = createKeysDb();
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [USER]: {
          [DEVICE]: {
            algorithms: [],
            device_id: DEVICE,
            user_id: USER,
            keys: {},
            // no signatures field for signer
          },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ failures: {} });
    expect(db.keyChanges.length).toBeGreaterThan(0);
  });
});
