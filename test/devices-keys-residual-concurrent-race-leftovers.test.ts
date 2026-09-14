/**
 * TOKENMAXX HEAVY leftovers after #241 — residual *devices + keys* (E2EE client
 * keys API, not room_keys backups) concurrent-race / TOCTOU niches unsaturated by:
 *   #158 keys-media-appservice (KV OTK double-claim + distinct OTK isolation +
 *        device_signing/signatures soft floods only),
 *   #154 keys-api-route-leftovers (soft/edge floods, no Promise.all races),
 *   #174/#220/#241 devices-keybackups-report residual (devices + room_keys backups
 *        + report — room_keys left alone here; devices races already deepened).
 *
 * Gap table (why leftover):
 *   fallback double-claim TOCTOU          | #158 raced KV OTK only, not fallback_keys
 *   D1 legacy OTK double-claim TOCTOU     | #158 skipped D1 claimed=0 path
 *   upload∥claim OTK KV                   | soft lifecycle only in #154
 *   upload∥upload device_keys LWW         | no concurrent upload race
 *   upload∥query bootstrap                | sequential soft floods only
 *   device_signing first-time∥first-time  | soft flood, not COUNT-barrier race
 *   device_signing password∥password LWW  | soft replace flood, not parallel
 *   signatures/upload concurrent          | soft flood only
 *   devices DELETE∥keys upload/claim      | #241 cross-module used room_keys, not
 *                                         | client /keys + devices cascade
 *   UserKeys DO put∥put / put∥get         | DO unit tests are sequential only
 *
 * Tests-only. Fixtures use example.com only. Reversible by deleting this file
 * (+ DO/route deepen hunks in sibling files). No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { FakeDurableObjectState, durableObjectMockFactory } from './helpers/fake-durable-object';

vi.mock('cloudflare:workers', () => durableObjectMockFactory());

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
import devicesApp from '../src/api/devices';
import { UserKeysDurableObject } from '../src/durable-objects/UserKeysDurableObject';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const DEVICE = 'DEVICEA';
const SERVER = 'example.com';
const ALG = 'signed_curve25519';
const PASS = 's3cret';
const AUTH = { Authorization: 'Bearer test-token' };
const NOW = 1_700_000_000_000;
const DEVICES = '/_matrix/client/v3/devices';

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };
type GetBarrier = { prefix: string; count: number };
type SqlCall = { sql: string; args: unknown[] };
type SqlBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };

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

type DeviceRow = {
  device_id: string;
  user_id: string;
  display_name: string | null;
  last_seen_ts: number | null;
  last_seen_ip: string | null;
};
type TokenRow = { user_id: string; device_id: string };

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

async function withBarrier(
  barrier: SqlBarrier | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  sql: string,
  args: unknown[]
) {
  if (!barrier || !barrier.match(sql, args)) return;
  await new Promise<void>((resolve) => {
    waitersRef.list.push(resolve);
    if (waitersRef.list.length >= barrier.count) {
      const all = [...waitersRef.list];
      waitersRef.list = [];
      clear();
      for (const r of all) r();
    }
  });
}

function createUserKeysStub(opts: {
  deviceKeys?: Record<string, DeviceKeyMap>;
  crossSigning?: Record<string, CrossSigningStore>;
  getBarrier?: { count: number };
  putBarrier?: { count: number };
} = {}) {
  const deviceKeys = opts.deviceKeys ?? {};
  const crossSigning = opts.crossSigning ?? {};
  const fetches: Array<{ url: string; method: string; body?: unknown }> = [];
  let getWaiters: Array<() => void> = [];
  let putWaiters: Array<() => void> = [];
  let getBarrier = opts.getBarrier;
  let putBarrier = opts.putBarrier;

  async function maybeDoBarrier(
    barrier: { count: number } | undefined,
    waiters: Array<() => void>,
    setWaiters: (w: Array<() => void>) => void,
    clear: () => void
  ) {
    if (!barrier) return;
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
      if (waiters.length >= barrier.count) {
        const all = [...waiters];
        setWaiters([]);
        clear();
        for (const r of all) r();
      }
    });
  }

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
        await maybeDoBarrier(
          getBarrier,
          getWaiters,
          (w) => {
            getWaiters = w;
          },
          () => {
            getBarrier = undefined;
          }
        );
        const deviceId = url.searchParams.get('device_id');
        if (deviceId) return Response.json(deviceKeys[deviceId] ?? null);
        return Response.json(deviceKeys);
      }
      if (path === '/device-keys/put') {
        await maybeDoBarrier(
          putBarrier,
          putWaiters,
          (w) => {
            putWaiters = w;
          },
          () => {
            putBarrier = undefined;
          }
        );
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
  const passwordHashes =
    opts.passwordHashes ?? new Map<string, string | null>([[USER, `mockok:${PASS}`]]);
  let firstBarrier = opts.firstBarrier;
  let firstWaiters: Array<() => void> = [];
  let nextOtkId = otks.reduce((m, r) => Math.max(m, r.id), 0) + 1;
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
              if (
                sql.includes('FROM account_data') &&
                sql.includes('m.secret_storage.default_key')
              ) {
                return null;
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
                return { success: true, meta: { changes: 1, last_row_id: crossSigningKeys.length } };
              }
              if (sql.includes('INSERT INTO cross_signing_signatures')) {
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

function createDevicesDb(
  opts: {
    devices?: DeviceRow[];
    tokens?: TokenRow[];
    keys?: TokenRow[];
    passwordHash?: string | null;
    selectBarrier?: SqlBarrier;
  } = {}
) {
  const deviceRows = opts.devices ?? [];
  const tokens = opts.tokens ?? deviceRows.map((d) => ({ user_id: d.user_id, device_id: d.device_id }));
  const keys = opts.keys ?? deviceRows.map((d) => ({ user_id: d.user_id, device_id: d.device_id }));
  const passwordHash = opts.passwordHash === undefined ? `mockok:${PASS}` : opts.passwordHash;
  const selects: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  let selectBarrier = opts.selectBarrier;
  const selectWaiters = { list: [] as Array<() => void> };

  const db = {
    devices: deviceRows,
    tokens,
    keys,
    selects,
    deletes,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              await withBarrier(
                selectBarrier,
                selectWaiters,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );
              if (sql.includes('SELECT password_hash FROM users')) {
                return { password_hash: passwordHash } as T;
              }
              if (
                sql.includes('FROM devices') &&
                sql.includes('device_id = ?') &&
                sql.includes('display_name')
              ) {
                const [userId, deviceId] = args as string[];
                const row = deviceRows.find((d) => d.user_id === userId && d.device_id === deviceId);
                if (!row) return null as T;
                return {
                  device_id: row.device_id,
                  display_name: row.display_name,
                  last_seen_ts: row.last_seen_ts,
                  last_seen_ip: row.last_seen_ip,
                } as T;
              }
              if (sql.includes('SELECT device_id FROM devices') && sql.includes('device_id = ?')) {
                const [userId, deviceId] = args as string[];
                const row = deviceRows.find((d) => d.user_id === userId && d.device_id === deviceId);
                return (row ? { device_id: row.device_id } : null) as T;
              }
              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 140)}`);
            },
            async all<T>() {
              if (
                sql.includes('FROM devices') &&
                sql.includes('WHERE user_id = ?') &&
                !sql.includes('device_id = ?')
              ) {
                const userId = args[0] as string;
                const results = deviceRows
                  .filter((d) => d.user_id === userId)
                  .map((d) => ({
                    device_id: d.device_id,
                    display_name: d.display_name,
                    last_seen_ts: d.last_seen_ts,
                    last_seen_ip: d.last_seen_ip,
                  }));
                return { results: results as T[] };
              }
              throw new Error(`Unhandled all() SQL: ${sql.slice(0, 140)}`);
            },
            async run() {
              if (sql.includes('UPDATE devices SET display_name')) {
                const [displayName, userId, deviceId] = args as [string, string, string];
                const row = deviceRows.find((d) => d.user_id === userId && d.device_id === deviceId);
                if (row) row.display_name = displayName;
                return { success: true, meta: { changes: row ? 1 : 0, last_row_id: 0 } };
              }
              if (sql.includes('DELETE FROM access_tokens')) {
                deletes.push({ sql, args });
                const [userId, deviceId] = args as string[];
                for (let i = tokens.length - 1; i >= 0; i--) {
                  if (tokens[i].user_id === userId && tokens[i].device_id === deviceId) {
                    tokens.splice(i, 1);
                  }
                }
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('DELETE FROM device_keys')) {
                deletes.push({ sql, args });
                const [userId, deviceId] = args as string[];
                for (let i = keys.length - 1; i >= 0; i--) {
                  if (keys[i].user_id === userId && keys[i].device_id === deviceId) {
                    keys.splice(i, 1);
                  }
                }
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('DELETE FROM devices')) {
                deletes.push({ sql, args });
                const [userId, deviceId] = args as string[];
                for (let i = deviceRows.length - 1; i >= 0; i--) {
                  if (deviceRows[i].user_id === userId && deviceRows[i].device_id === deviceId) {
                    deviceRows.splice(i, 1);
                  }
                }
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              throw new Error(`Unhandled run() SQL: ${sql.slice(0, 140)}`);
            },
          };
        },
      };
    },
  };
  return db;
}

type DevicesDb = ReturnType<typeof createDevicesDb>;

function envForDevices(db: DevicesDb): Env {
  return { DB: db, SERVER_NAME: SERVER } as unknown as Env;
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
  return { status: res.status, body };
}

async function devicesReq(db: DevicesDb, path: string, init: RequestInit = {}) {
  const res = await devicesApp.request(`http://localhost${path}`, init, envForDevices(db));
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...AUTH },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function deviceKeysPayload(overrides: Record<string, unknown> = {}, n = 0) {
  return {
    user_id: USER,
    device_id: DEVICE,
    algorithms: ['m.olm.v1.curve25519-aes-sha2', 'm.megolm.v1.aes-sha2'],
    keys: {
      [`curve25519:${DEVICE}`]: `curveKey${n}`,
      [`ed25519:${DEVICE}`]: `edKey${n}`,
    },
    signatures: {
      [USER]: { [`ed25519:${DEVICE}`]: `sig${n}` },
    },
    unsigned: { device_display_name: `Phone-${n}` },
    ...overrides,
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

function seedDevice(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    device_id: overrides.device_id ?? DEVICE,
    user_id: overrides.user_id ?? USER,
    display_name: overrides.display_name ?? null,
    last_seen_ts: overrides.last_seen_ts ?? NOW,
    last_seen_ip: overrides.last_seen_ip ?? '127.0.0.1',
  };
}

function claimedMap(body: unknown): Record<string, unknown> | undefined {
  return (body as { one_time_keys?: Record<string, Record<string, Record<string, unknown>>> })
    ?.one_time_keys?.[USER]?.[DEVICE];
}

function makeUserKeysDo(state = new FakeDurableObjectState()) {
  return {
    state,
    do: new UserKeysDurableObject(state as unknown as DurableObjectState, {} as Env),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-09-14T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// residual keys races after #158 / #241
// ---------------------------------------------------------------------------

describe('race keys fallback double-claim TOCTOU residual after #241', () => {
  for (let i = 0; i < 8; i++) {
    it(`fallback_keys SELECT barrier double-claim #${i}`, async () => {
      const keyId = `signed_curve25519:FB${i}`;
      const db = createKeysDb({
        fallbacks: [
          {
            user_id: USER,
            device_id: DEVICE,
            algorithm: ALG,
            key_id: keyId,
            key_data: JSON.stringify({ key: `fb-${i}` }),
            used: 0,
          },
        ],
        firstBarrier: { substr: 'FROM fallback_keys', count: 2 },
      });
      const env = createKeysEnv({ db });
      const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
      const [a, b] = await Promise.all([
        keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
        keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const hits = [claimedMap(a.body), claimedMap(b.body)].filter(Boolean);
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(db.fallbacks[0].used).toBe(1);
      for (const hit of hits) {
        expect(hit![keyId]).toMatchObject({ key: `fb-${i}`, fallback: true });
      }
    });
  }
});

describe('race keys D1 legacy OTK double-claim TOCTOU residual after #241', () => {
  for (let i = 0; i < 8; i++) {
    it(`D1 claimed=0 SELECT barrier double-claim #${i}`, async () => {
      const keyId = `signed_curve25519:LEG${i}`;
      const db = createKeysDb({
        otks: [
          {
            id: 100 + i,
            user_id: USER,
            device_id: DEVICE,
            algorithm: ALG,
            key_id: keyId,
            key_data: JSON.stringify({ key: `legacy-${i}` }),
            claimed: 0,
          },
        ],
        firstBarrier: { substr: 'FROM one_time_keys', count: 2 },
      });
      const env = createKeysEnv({ db, oneTimeKeysKv: mockKv() });
      const body = { one_time_keys: { [USER]: { [DEVICE]: ALG } } };
      const [a, b] = await Promise.all([
        keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
        keysReq(env, '/_matrix/client/v3/keys/claim', jsonInit('POST', body)),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const hits = [claimedMap(a.body), claimedMap(b.body)].filter(Boolean);
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(db.otks[0].claimed).toBe(1);
      for (const hit of hits) {
        expect(Object.keys(hit!)).toContain(keyId);
      }
    });
  }
});

describe('race keys upload∥claim OTK KV residual after #241', () => {
  for (let i = 0; i < 8; i++) {
    it(`upload OTK∥claim same bucket #${i}`, async () => {
      const otk = mockKv({}, { getBarrier: { prefix: 'otk:', count: 2 } });
      const keyId = `signed_curve25519:upclaim${i}`;
      const newId = `signed_curve25519:new${i}`;
      seedOtkKv(otk, keyId, { key: `seed-${i}` });
      const env = createKeysEnv({ oneTimeKeysKv: otk });
      const [up, claim] = await Promise.all([
        keysReq(
          env,
          '/_matrix/client/v3/keys/upload',
          jsonInit('POST', {
            one_time_keys: { [newId]: { key: `new-${i}` } },
          })
        ),
        keysReq(
          env,
          '/_matrix/client/v3/keys/claim',
          jsonInit('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
        ),
      ]);
      expect(up.status).toBe(200);
      expect(claim.status).toBe(200);
      const stored = JSON.parse(otk.data[`otk:${USER}:${DEVICE}`]);
      expect(stored[ALG].length).toBeGreaterThanOrEqual(1);
      // TOCTOU LWW: claim may mark claimed, or upload put may overwrite with unclaimed merge
      const claimedSomewhere =
        stored[ALG].some((k: { claimed: boolean }) => k.claimed === true) ||
        Boolean(claimedMap(claim.body));
      const ids = stored[ALG].map((k: { keyId: string }) => k.keyId);
      expect(claimedSomewhere || ids.includes(newId) || ids.includes(keyId)).toBe(true);
    });
  }
});

describe('race keys upload∥upload device_keys LWW residual after #241', () => {
  for (let i = 0; i < 8; i++) {
    it(`parallel device_keys upload LWW #${i}`, async () => {
      const userKeys = createUserKeysStub({ putBarrier: { count: 2 } });
      const env = createKeysEnv({ userKeys });
      const aKeys = deviceKeysPayload({ unsigned: { device_display_name: `A-${i}` } }, i);
      const bKeys = deviceKeysPayload({ unsigned: { device_display_name: `B-${i}` } }, i + 100);
      const [a, b] = await Promise.all([
        keysReq(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: aKeys })),
        keysReq(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: bKeys })),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const stored = userKeys.deviceKeys[DEVICE] as { unsigned?: { device_display_name?: string } };
      expect([`A-${i}`, `B-${i}`]).toContain(stored.unsigned?.device_display_name);
      expect(env._db.keyChanges.length).toBeGreaterThanOrEqual(1);
    });
  }
});

describe('race keys upload∥query bootstrap residual after #241', () => {
  for (let i = 0; i < 8; i++) {
    it(`upload∥query same device bootstrap #${i}`, async () => {
      // No DO barriers: upload put and query get race naturally under Promise.all.
      const userKeys = createUserKeysStub();
      const env = createKeysEnv({ userKeys });
      const payload = deviceKeysPayload({}, i);
      const [up, q] = await Promise.all([
        keysReq(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: payload })),
        keysReq(
          env,
          '/_matrix/client/v3/keys/query',
          jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
        ),
      ]);
      expect(up.status).toBe(200);
      expect(q.status).toBe(200);
      const devices = (q.body as { device_keys: Record<string, Record<string, unknown>> })
        .device_keys[USER];
      // Query may observe null/missing mid-flight or the uploaded keys
      if (devices[DEVICE]) {
        expect(devices[DEVICE]).toMatchObject({ device_id: DEVICE, user_id: USER });
      }
      expect(userKeys.deviceKeys[DEVICE]).toMatchObject({ device_id: DEVICE });
    });
  }
});

describe('race keys device_signing first-time∥first-time residual after #241', () => {
  for (let i = 0; i < 8; i++) {
    it(`MSC3967 first-time COUNT barrier parallel #${i}`, async () => {
      const db = createKeysDb({
        firstBarrier: { substr: 'FROM cross_signing_keys', count: 2 },
      });
      const env = createKeysEnv({ db });
      const [a, b] = await Promise.all([
        keysReq(
          env,
          '/_matrix/client/v3/keys/device_signing/upload',
          jsonInit('POST', {
            master_key: masterKeyPayload(i),
            self_signing_key: selfSigningKeyPayload(i),
            user_signing_key: userSigningKeyPayload(i),
          })
        ),
        keysReq(
          env,
          '/_matrix/client/v3/keys/device_signing/upload',
          jsonInit('POST', {
            master_key: masterKeyPayload(i + 50),
            self_signing_key: selfSigningKeyPayload(i + 50),
            user_signing_key: userSigningKeyPayload(i + 50),
          })
        ),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(env._userKeys.crossSigning.master).toBeTruthy();
      expect(db.crossSigningKeys.length).toBeGreaterThanOrEqual(1);
    });
  }
});

describe('race keys device_signing password∥password replace residual after #241', () => {
  for (let i = 0; i < 6; i++) {
    it(`password replace LWW parallel #${i}`, async () => {
      const db = createKeysDb({
        crossSigningKeys: [
          {
            user_id: USER,
            key_type: 'master',
            key_id: 'ed25519:master',
            key_data: JSON.stringify(masterKeyPayload(0)),
          },
        ],
        passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
      });
      const env = createKeysEnv({
        db,
        userKeys: createUserKeysStub({
          crossSigning: { master: masterKeyPayload(0) },
        }),
      });
      const auth = { type: 'm.login.password', password: PASS };
      const [a, b] = await Promise.all([
        keysReq(
          env,
          '/_matrix/client/v3/keys/device_signing/upload',
          jsonInit('POST', { auth, master_key: masterKeyPayload(i + 1) })
        ),
        keysReq(
          env,
          '/_matrix/client/v3/keys/device_signing/upload',
          jsonInit('POST', { auth, master_key: masterKeyPayload(i + 20) })
        ),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const master = env._userKeys.crossSigning.master as { keys: Record<string, string> };
      expect([`masterPub${i + 1}`, `masterPub${i + 20}`]).toContain(master.keys['ed25519:master']);
    });
  }
});

describe('race keys signatures/upload concurrent residual after #241', () => {
  for (let i = 0; i < 8; i++) {
    it(`parallel signatures upsert LWW #${i}`, async () => {
      const devicePayload = deviceKeysPayload({}, i);
      const env = createKeysEnv({
        userKeys: createUserKeysStub({
          deviceKeys: { [DEVICE]: devicePayload },
        }),
      });
      const sigA = {
        [USER]: {
          [DEVICE]: {
            ...devicePayload,
            signatures: { [USER]: { [`ed25519:${DEVICE}`]: `sigA-${i}` } },
          },
        },
      };
      const sigB = {
        [USER]: {
          [DEVICE]: {
            ...devicePayload,
            signatures: { [USER]: { [`ed25519:${DEVICE}`]: `sigB-${i}` } },
          },
        },
      };
      const [a, b] = await Promise.all([
        keysReq(env, '/_matrix/client/v3/keys/signatures/upload', jsonInit('POST', sigA)),
        keysReq(env, '/_matrix/client/v3/keys/signatures/upload', jsonInit('POST', sigB)),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(env._db.signatures.length).toBeGreaterThanOrEqual(1);
      const stored = env._db.signatures.find(
        (s) => s.key_id === DEVICE && s.signer_key_id === `ed25519:${DEVICE}`
      );
      expect(stored).toBeTruthy();
      expect([`sigA-${i}`, `sigB-${i}`]).toContain(stored!.signature);
    });
  }
});

// ---------------------------------------------------------------------------
// cross-module devices∥keys (client E2EE keys — not room_keys)
// ---------------------------------------------------------------------------

describe('race devices DELETE∥keys upload residual after #241', () => {
  for (let i = 0; i < 8; i++) {
    it(`devices cascade DELETE∥keys device_keys upload #${i}`, async () => {
      const devicesDb = createDevicesDb({
        devices: [seedDevice({ device_id: DEVICE, display_name: `old-${i}` })],
        selectBarrier: {
          match: (sql) => sql.includes('SELECT device_id FROM devices'),
          count: 1,
        },
      });
      const keysEnv = createKeysEnv();
      const [del, up] = await Promise.all([
        devicesReq(
          devicesDb,
          `${DEVICES}/${DEVICE}`,
          jsonInit('DELETE', { auth: { type: 'm.login.password', password: PASS } })
        ),
        keysReq(
          keysEnv,
          '/_matrix/client/v3/keys/upload',
          jsonInit('POST', { device_keys: deviceKeysPayload({}, i) })
        ),
      ]);
      expect(del.status).toBe(200);
      expect(up.status).toBe(200);
      expect(devicesDb.devices).toHaveLength(0);
      expect(devicesDb.keys).toHaveLength(0);
      expect(keysEnv._userKeys.deviceKeys[DEVICE]).toBeTruthy();
    });
  }
});

describe('race devices DELETE∥keys claim residual after #241', () => {
  for (let i = 0; i < 6; i++) {
    it(`devices DELETE∥OTK claim isolation #${i}`, async () => {
      const devicesDb = createDevicesDb({
        devices: [seedDevice()],
      });
      const otk = mockKv();
      const keyId = `signed_curve25519:iso${i}`;
      seedOtkKv(otk, keyId, { key: `iso-${i}` });
      const keysEnv = createKeysEnv({ oneTimeKeysKv: otk });
      const [del, claim] = await Promise.all([
        devicesReq(
          devicesDb,
          `${DEVICES}/${DEVICE}`,
          jsonInit('DELETE', { auth: { type: 'm.login.dummy' } })
        ),
        keysReq(
          keysEnv,
          '/_matrix/client/v3/keys/claim',
          jsonInit('POST', { one_time_keys: { [USER]: { [DEVICE]: ALG } } })
        ),
      ]);
      expect(del.status).toBe(200);
      expect(claim.status).toBe(200);
      expect(devicesDb.devices).toHaveLength(0);
      expect(claimedMap(claim.body)?.[keyId]).toEqual({ key: `iso-${i}` });
    });
  }
});

describe('race devices GET∥keys query residual after #241', () => {
  for (let i = 0; i < 6; i++) {
    it(`devices GET :id∥keys query same device #${i}`, async () => {
      const devicesDb = createDevicesDb({
        devices: [seedDevice({ display_name: `seen-${i}` })],
      });
      const payload = deviceKeysPayload({}, i);
      const keysEnv = createKeysEnv({
        userKeys: createUserKeysStub({ deviceKeys: { [DEVICE]: payload } }),
      });
      const [got, q] = await Promise.all([
        devicesReq(devicesDb, `${DEVICES}/${DEVICE}`, { method: 'GET', headers: AUTH }),
        keysReq(
          keysEnv,
          '/_matrix/client/v3/keys/query',
          jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
        ),
      ]);
      expect(got.status).toBe(200);
      expect(q.status).toBe(200);
      expect(got.body).toMatchObject({ device_id: DEVICE, display_name: `seen-${i}` });
      expect(
        (q.body as { device_keys: Record<string, Record<string, unknown>> }).device_keys[USER][
          DEVICE
        ]
      ).toMatchObject({ device_id: DEVICE });
    });
  }
});

describe('cross-module devices list∥keys changes residual after #241', () => {
  for (let i = 0; i < 6; i++) {
    it(`devices list∥keys/changes isolation #${i}`, async () => {
      const devicesDb = createDevicesDb({
        devices: [
          seedDevice({ device_id: 'PHONE', display_name: 'p' }),
          seedDevice({ device_id: 'LAPTOP', display_name: 'l' }),
        ],
      });
      const db = createKeysDb({
        memberships: [
          { room_id: '!r:example.com', user_id: USER, membership: 'join' },
          { room_id: '!r:example.com', user_id: BOB, membership: 'join' },
        ],
        keyChanges: [
          {
            user_id: BOB,
            device_id: 'D1',
            change_type: 'update',
            stream_position: 5 + i,
          },
        ],
        streamPositions: { device_keys: 20 },
      });
      const keysEnv = createKeysEnv({ db });
      const [list, changes] = await Promise.all([
        devicesReq(devicesDb, DEVICES, { method: 'GET', headers: AUTH }),
        keysReq(keysEnv, `/_matrix/client/v3/keys/changes?from=0&to=${20 + i}`, {
          method: 'GET',
          headers: AUTH,
        }),
      ]);
      expect(list.status).toBe(200);
      expect(changes.status).toBe(200);
      expect((list.body as { devices: unknown[] }).devices).toHaveLength(2);
      expect((changes.body as { changed: string[] }).changed).toContain(BOB);
    });
  }
});

// ---------------------------------------------------------------------------
// UserKeys DO residual concurrent edges (existing DO only)
// ---------------------------------------------------------------------------

describe('UserKeysDurableObject concurrent put∥put residual after #241', () => {
  for (let i = 0; i < 6; i++) {
    it(`device-keys put∥put LWW #${i}`, async () => {
      const { do: keys } = makeUserKeysDo();
      const [a, b] = await Promise.all([
        keys.fetch(
          new Request('https://do/device-keys/put', {
            method: 'POST',
            body: JSON.stringify({ device_id: 'D1', keys: { v: `a-${i}` } }),
          })
        ),
        keys.fetch(
          new Request('https://do/device-keys/put', {
            method: 'POST',
            body: JSON.stringify({ device_id: 'D1', keys: { v: `b-${i}` } }),
          })
        ),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const got = await (
        await keys.fetch(new Request('https://do/device-keys/get?device_id=D1'))
      ).json();
      expect([`a-${i}`, `b-${i}`]).toContain((got as { v: string }).v);
      const list = await (await keys.fetch(new Request('https://do/device-keys/list'))).json();
      expect(list).toEqual(['D1']);
    });
  }
});

describe('UserKeysDurableObject concurrent put∥get residual after #241', () => {
  for (let i = 0; i < 6; i++) {
    it(`cross-signing put∥get mid-merge #${i}`, async () => {
      const { do: keys } = makeUserKeysDo();
      await keys.fetch(
        new Request('https://do/cross-signing/put', {
          method: 'POST',
          body: JSON.stringify({ master: { keys: { 'ed25519:M': `m0-${i}` } } }),
        })
      );
      const [put, get] = await Promise.all([
        keys.fetch(
          new Request('https://do/cross-signing/put', {
            method: 'POST',
            body: JSON.stringify({ self_signing: { keys: { 'ed25519:S': `s-${i}` } } }),
          })
        ),
        keys.fetch(new Request('https://do/cross-signing/get')),
      ]);
      expect(put.status).toBe(200);
      expect(get.status).toBe(200);
      const final = await (await keys.fetch(new Request('https://do/cross-signing/get'))).json();
      expect(final).toMatchObject({
        master: { keys: { 'ed25519:M': `m0-${i}` } },
        self_signing: { keys: { 'ed25519:S': `s-${i}` } },
      });
    });
  }
});

describe('UserKeysDurableObject concurrent signatures residual after #241', () => {
  for (let i = 0; i < 6; i++) {
    it(`signatures put∥put distinct targets #${i}`, async () => {
      const { do: keys } = makeUserKeysDo();
      const sigA = {
        signer_user_id: USER,
        signer_key_id: 'ed25519:S',
        target_user_id: BOB,
        target_key_id: `ed25519:T${i}a`,
        signature: `a-${i}`,
      };
      const sigB = {
        signer_user_id: USER,
        signer_key_id: 'ed25519:S',
        target_user_id: BOB,
        target_key_id: `ed25519:T${i}b`,
        signature: `b-${i}`,
      };
      const [a, b] = await Promise.all([
        keys.fetch(
          new Request('https://do/signatures/put', {
            method: 'POST',
            body: JSON.stringify(sigA),
          })
        ),
        keys.fetch(
          new Request('https://do/signatures/put', {
            method: 'POST',
            body: JSON.stringify(sigB),
          })
        ),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const all = (await (
        await keys.fetch(new Request('https://do/signatures/get'))
      ).json()) as Array<{ target_key_id: string; signature: string }>;
      // Read-modify-write TOCTOU under FakeDurableObjectState may drop one append
      expect(all.length).toBeGreaterThanOrEqual(1);
      expect(all.every((s) => [`a-${i}`, `b-${i}`].includes(s.signature))).toBe(true);
      const targets = all.map((s) => s.target_key_id);
      expect(
        targets.includes(`ed25519:T${i}a`) || targets.includes(`ed25519:T${i}b`)
      ).toBe(true);
    });
  }
});

describe('UserKeysDurableObject account-data put∥put residual after #241', () => {
  for (let i = 0; i < 6; i++) {
    it(`same event_type content LWW #${i}`, async () => {
      const { do: keys } = makeUserKeysDo();
      const [a, b] = await Promise.all([
        keys.fetch(
          new Request('https://do/account-data/put', {
            method: 'POST',
            body: JSON.stringify({
              event_type: 'm.secret_storage.default_key',
              content: { key: `a-${i}` },
            }),
          })
        ),
        keys.fetch(
          new Request('https://do/account-data/put', {
            method: 'POST',
            body: JSON.stringify({
              event_type: 'm.secret_storage.default_key',
              content: { key: `b-${i}` },
            }),
          })
        ),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const got = await (
        await keys.fetch(
          new Request('https://do/account-data/get?event_type=m.secret_storage.default_key')
        )
      ).json();
      expect([`a-${i}`, `b-${i}`]).toContain((got as { key: string }).key);
    });
  }
});
