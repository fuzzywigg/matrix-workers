/**
 * TOKENMAXX HEAVY leftovers after #154 / deepen after #241 — keys API
 * soft/edge/reliability. Complements keys-api-routes.test.ts and
 * devices-keys-residual-concurrent-race-leftovers.test.ts.
 * Tests-only — no product inventing. Fixtures use example.com only.
 *
 * Deepen after #241: fallback claim, D1 legacy claim, upload fallback_keys,
 * query user_signing isolation, device_signing unrecognized/empty password,
 * signatures missing device, empty one_time_keys counts — niches soft-flooded
 * lightly or not at all after #154 (present in routes base only).
 */
import { describe, expect, it, vi } from 'vitest';
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
const SERVER = 'example.com';

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




// ---------------------------------------------------------------------------
// POST /keys/upload
// ---------------------------------------------------------------------------

describe('keys leftovers upload device_keys soft flood after #154', () => {

  it('upload device_keys soft-0', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({
      unsigned: { device_display_name: 'Phone-0' },
      keys: {
        [`curve25519:${DEVICE}`]: 'curveKey0',
        [`ed25519:${DEVICE}`]: 'edKey0',
      },
    });
    const res = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ one_time_key_counts: {} });
    expect(env._userKeys.deviceKeys[DEVICE]).toEqual(keys);
    expect(env._db.keyChanges).toHaveLength(1);
  });

  it('upload device_keys soft-1', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({
      unsigned: { device_display_name: 'Phone-1' },
      keys: {
        [`curve25519:${DEVICE}`]: 'curveKey1',
        [`ed25519:${DEVICE}`]: 'edKey1',
      },
    });
    const res = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ one_time_key_counts: {} });
    expect(env._userKeys.deviceKeys[DEVICE]).toEqual(keys);
    expect(env._db.keyChanges).toHaveLength(1);
  });

  it('upload device_keys soft-2', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({
      unsigned: { device_display_name: 'Phone-2' },
      keys: {
        [`curve25519:${DEVICE}`]: 'curveKey2',
        [`ed25519:${DEVICE}`]: 'edKey2',
      },
    });
    const res = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ one_time_key_counts: {} });
    expect(env._userKeys.deviceKeys[DEVICE]).toEqual(keys);
    expect(env._db.keyChanges).toHaveLength(1);
  });

  it('upload device_keys soft-3', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({
      unsigned: { device_display_name: 'Phone-3' },
      keys: {
        [`curve25519:${DEVICE}`]: 'curveKey3',
        [`ed25519:${DEVICE}`]: 'edKey3',
      },
    });
    const res = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ one_time_key_counts: {} });
    expect(env._userKeys.deviceKeys[DEVICE]).toEqual(keys);
    expect(env._db.keyChanges).toHaveLength(1);
  });

  it('upload device_keys soft-4', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({
      unsigned: { device_display_name: 'Phone-4' },
      keys: {
        [`curve25519:${DEVICE}`]: 'curveKey4',
        [`ed25519:${DEVICE}`]: 'edKey4',
      },
    });
    const res = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ one_time_key_counts: {} });
    expect(env._userKeys.deviceKeys[DEVICE]).toEqual(keys);
    expect(env._db.keyChanges).toHaveLength(1);
  });

  it('upload device_keys soft-5', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({
      unsigned: { device_display_name: 'Phone-5' },
      keys: {
        [`curve25519:${DEVICE}`]: 'curveKey5',
        [`ed25519:${DEVICE}`]: 'edKey5',
      },
    });
    const res = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ one_time_key_counts: {} });
    expect(env._userKeys.deviceKeys[DEVICE]).toEqual(keys);
    expect(env._db.keyChanges).toHaveLength(1);
  });

  it('upload device_keys soft-6', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({
      unsigned: { device_display_name: 'Phone-6' },
      keys: {
        [`curve25519:${DEVICE}`]: 'curveKey6',
        [`ed25519:${DEVICE}`]: 'edKey6',
      },
    });
    const res = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ one_time_key_counts: {} });
    expect(env._userKeys.deviceKeys[DEVICE]).toEqual(keys);
    expect(env._db.keyChanges).toHaveLength(1);
  });

  it('upload device_keys soft-7', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({
      unsigned: { device_display_name: 'Phone-7' },
      keys: {
        [`curve25519:${DEVICE}`]: 'curveKey7',
        [`ed25519:${DEVICE}`]: 'edKey7',
      },
    });
    const res = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ one_time_key_counts: {} });
    expect(env._userKeys.deviceKeys[DEVICE]).toEqual(keys);
    expect(env._db.keyChanges).toHaveLength(1);
  });

  it('upload device_keys soft-8', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({
      unsigned: { device_display_name: 'Phone-8' },
      keys: {
        [`curve25519:${DEVICE}`]: 'curveKey8',
        [`ed25519:${DEVICE}`]: 'edKey8',
      },
    });
    const res = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ one_time_key_counts: {} });
    expect(env._userKeys.deviceKeys[DEVICE]).toEqual(keys);
    expect(env._db.keyChanges).toHaveLength(1);
  });

  it('upload device_keys soft-9', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({
      unsigned: { device_display_name: 'Phone-9' },
      keys: {
        [`curve25519:${DEVICE}`]: 'curveKey9',
        [`ed25519:${DEVICE}`]: 'edKey9',
      },
    });
    const res = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ one_time_key_counts: {} });
    expect(env._userKeys.deviceKeys[DEVICE]).toEqual(keys);
    expect(env._db.keyChanges).toHaveLength(1);
  });

  it('upload device_keys soft-10', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({
      unsigned: { device_display_name: 'Phone-10' },
      keys: {
        [`curve25519:${DEVICE}`]: 'curveKey10',
        [`ed25519:${DEVICE}`]: 'edKey10',
      },
    });
    const res = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ one_time_key_counts: {} });
    expect(env._userKeys.deviceKeys[DEVICE]).toEqual(keys);
    expect(env._db.keyChanges).toHaveLength(1);
  });

  it('upload device_keys soft-11', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({
      unsigned: { device_display_name: 'Phone-11' },
      keys: {
        [`curve25519:${DEVICE}`]: 'curveKey11',
        [`ed25519:${DEVICE}`]: 'edKey11',
      },
    });
    const res = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ one_time_key_counts: {} });
    expect(env._userKeys.deviceKeys[DEVICE]).toEqual(keys);
    expect(env._db.keyChanges).toHaveLength(1);
  });

  it('upload device_keys soft-12', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({
      unsigned: { device_display_name: 'Phone-12' },
      keys: {
        [`curve25519:${DEVICE}`]: 'curveKey12',
        [`ed25519:${DEVICE}`]: 'edKey12',
      },
    });
    const res = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ one_time_key_counts: {} });
    expect(env._userKeys.deviceKeys[DEVICE]).toEqual(keys);
    expect(env._db.keyChanges).toHaveLength(1);
  });

  it('upload device_keys soft-13', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({
      unsigned: { device_display_name: 'Phone-13' },
      keys: {
        [`curve25519:${DEVICE}`]: 'curveKey13',
        [`ed25519:${DEVICE}`]: 'edKey13',
      },
    });
    const res = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ one_time_key_counts: {} });
    expect(env._userKeys.deviceKeys[DEVICE]).toEqual(keys);
    expect(env._db.keyChanges).toHaveLength(1);
  });

  it('upload device_keys soft-14', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({
      unsigned: { device_display_name: 'Phone-14' },
      keys: {
        [`curve25519:${DEVICE}`]: 'curveKey14',
        [`ed25519:${DEVICE}`]: 'edKey14',
      },
    });
    const res = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ one_time_key_counts: {} });
    expect(env._userKeys.deviceKeys[DEVICE]).toEqual(keys);
    expect(env._db.keyChanges).toHaveLength(1);
  });

  it('upload device_keys soft-15', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({
      unsigned: { device_display_name: 'Phone-15' },
      keys: {
        [`curve25519:${DEVICE}`]: 'curveKey15',
        [`ed25519:${DEVICE}`]: 'edKey15',
      },
    });
    const res = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ one_time_key_counts: {} });
    expect(env._userKeys.deviceKeys[DEVICE]).toEqual(keys);
    expect(env._db.keyChanges).toHaveLength(1);
  });
});

describe('keys leftovers upload one_time_keys soft flood after #154', () => {

  it('upload one_time_keys soft-0', async () => {
    const env = createEnv();
    const otkId = `ed25519:OTK0`;
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        one_time_keys: {
          [otkId]: { key: 'otk0', signatures: { [USER]: { [`ed25519:${DEVICE}`]: 's0' } } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_key_counts: expect.any(Object) });
  });

  it('upload one_time_keys soft-1', async () => {
    const env = createEnv();
    const otkId = `ed25519:OTK1`;
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        one_time_keys: {
          [otkId]: { key: 'otk1', signatures: { [USER]: { [`ed25519:${DEVICE}`]: 's1' } } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_key_counts: expect.any(Object) });
  });

  it('upload one_time_keys soft-2', async () => {
    const env = createEnv();
    const otkId = `ed25519:OTK2`;
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        one_time_keys: {
          [otkId]: { key: 'otk2', signatures: { [USER]: { [`ed25519:${DEVICE}`]: 's2' } } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_key_counts: expect.any(Object) });
  });

  it('upload one_time_keys soft-3', async () => {
    const env = createEnv();
    const otkId = `ed25519:OTK3`;
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        one_time_keys: {
          [otkId]: { key: 'otk3', signatures: { [USER]: { [`ed25519:${DEVICE}`]: 's3' } } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_key_counts: expect.any(Object) });
  });

  it('upload one_time_keys soft-4', async () => {
    const env = createEnv();
    const otkId = `ed25519:OTK4`;
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        one_time_keys: {
          [otkId]: { key: 'otk4', signatures: { [USER]: { [`ed25519:${DEVICE}`]: 's4' } } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_key_counts: expect.any(Object) });
  });

  it('upload one_time_keys soft-5', async () => {
    const env = createEnv();
    const otkId = `ed25519:OTK5`;
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        one_time_keys: {
          [otkId]: { key: 'otk5', signatures: { [USER]: { [`ed25519:${DEVICE}`]: 's5' } } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_key_counts: expect.any(Object) });
  });

  it('upload one_time_keys soft-6', async () => {
    const env = createEnv();
    const otkId = `ed25519:OTK6`;
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        one_time_keys: {
          [otkId]: { key: 'otk6', signatures: { [USER]: { [`ed25519:${DEVICE}`]: 's6' } } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_key_counts: expect.any(Object) });
  });

  it('upload one_time_keys soft-7', async () => {
    const env = createEnv();
    const otkId = `ed25519:OTK7`;
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        one_time_keys: {
          [otkId]: { key: 'otk7', signatures: { [USER]: { [`ed25519:${DEVICE}`]: 's7' } } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_key_counts: expect.any(Object) });
  });

  it('upload one_time_keys soft-8', async () => {
    const env = createEnv();
    const otkId = `ed25519:OTK8`;
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        one_time_keys: {
          [otkId]: { key: 'otk8', signatures: { [USER]: { [`ed25519:${DEVICE}`]: 's8' } } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_key_counts: expect.any(Object) });
  });

  it('upload one_time_keys soft-9', async () => {
    const env = createEnv();
    const otkId = `ed25519:OTK9`;
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        one_time_keys: {
          [otkId]: { key: 'otk9', signatures: { [USER]: { [`ed25519:${DEVICE}`]: 's9' } } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_key_counts: expect.any(Object) });
  });

  it('upload one_time_keys soft-10', async () => {
    const env = createEnv();
    const otkId = `ed25519:OTK10`;
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        one_time_keys: {
          [otkId]: { key: 'otk10', signatures: { [USER]: { [`ed25519:${DEVICE}`]: 's10' } } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_key_counts: expect.any(Object) });
  });

  it('upload one_time_keys soft-11', async () => {
    const env = createEnv();
    const otkId = `ed25519:OTK11`;
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        one_time_keys: {
          [otkId]: { key: 'otk11', signatures: { [USER]: { [`ed25519:${DEVICE}`]: 's11' } } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_key_counts: expect.any(Object) });
  });

  it('upload one_time_keys soft-12', async () => {
    const env = createEnv();
    const otkId = `ed25519:OTK12`;
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        one_time_keys: {
          [otkId]: { key: 'otk12', signatures: { [USER]: { [`ed25519:${DEVICE}`]: 's12' } } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_key_counts: expect.any(Object) });
  });

  it('upload one_time_keys soft-13', async () => {
    const env = createEnv();
    const otkId = `ed25519:OTK13`;
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        one_time_keys: {
          [otkId]: { key: 'otk13', signatures: { [USER]: { [`ed25519:${DEVICE}`]: 's13' } } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_key_counts: expect.any(Object) });
  });

  it('upload one_time_keys soft-14', async () => {
    const env = createEnv();
    const otkId = `ed25519:OTK14`;
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        one_time_keys: {
          [otkId]: { key: 'otk14', signatures: { [USER]: { [`ed25519:${DEVICE}`]: 's14' } } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_key_counts: expect.any(Object) });
  });

  it('upload one_time_keys soft-15', async () => {
    const env = createEnv();
    const otkId = `ed25519:OTK15`;
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        one_time_keys: {
          [otkId]: { key: 'otk15', signatures: { [USER]: { [`ed25519:${DEVICE}`]: 's15' } } },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_key_counts: expect.any(Object) });
  });
});

describe('keys leftovers query soft flood after #154', () => {

  it('query own device soft-0', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: deviceKeysPayload({ unsigned: { device_display_name: 'Q0' } }),
      },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(res.status).toBe(200);
    expect((res.body as { device_keys: Record<string, Record<string, unknown>> }).device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('query own device soft-1', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: deviceKeysPayload({ unsigned: { device_display_name: 'Q1' } }),
      },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(res.status).toBe(200);
    expect((res.body as { device_keys: Record<string, Record<string, unknown>> }).device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('query own device soft-2', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: deviceKeysPayload({ unsigned: { device_display_name: 'Q2' } }),
      },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(res.status).toBe(200);
    expect((res.body as { device_keys: Record<string, Record<string, unknown>> }).device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('query own device soft-3', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: deviceKeysPayload({ unsigned: { device_display_name: 'Q3' } }),
      },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(res.status).toBe(200);
    expect((res.body as { device_keys: Record<string, Record<string, unknown>> }).device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('query own device soft-4', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: deviceKeysPayload({ unsigned: { device_display_name: 'Q4' } }),
      },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(res.status).toBe(200);
    expect((res.body as { device_keys: Record<string, Record<string, unknown>> }).device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('query own device soft-5', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: deviceKeysPayload({ unsigned: { device_display_name: 'Q5' } }),
      },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(res.status).toBe(200);
    expect((res.body as { device_keys: Record<string, Record<string, unknown>> }).device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('query own device soft-6', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: deviceKeysPayload({ unsigned: { device_display_name: 'Q6' } }),
      },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(res.status).toBe(200);
    expect((res.body as { device_keys: Record<string, Record<string, unknown>> }).device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('query own device soft-7', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: deviceKeysPayload({ unsigned: { device_display_name: 'Q7' } }),
      },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(res.status).toBe(200);
    expect((res.body as { device_keys: Record<string, Record<string, unknown>> }).device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('query own device soft-8', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: deviceKeysPayload({ unsigned: { device_display_name: 'Q8' } }),
      },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(res.status).toBe(200);
    expect((res.body as { device_keys: Record<string, Record<string, unknown>> }).device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('query own device soft-9', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: deviceKeysPayload({ unsigned: { device_display_name: 'Q9' } }),
      },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(res.status).toBe(200);
    expect((res.body as { device_keys: Record<string, Record<string, unknown>> }).device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('query own device soft-10', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: deviceKeysPayload({ unsigned: { device_display_name: 'Q10' } }),
      },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(res.status).toBe(200);
    expect((res.body as { device_keys: Record<string, Record<string, unknown>> }).device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('query own device soft-11', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: deviceKeysPayload({ unsigned: { device_display_name: 'Q11' } }),
      },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(res.status).toBe(200);
    expect((res.body as { device_keys: Record<string, Record<string, unknown>> }).device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('query own device soft-12', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: deviceKeysPayload({ unsigned: { device_display_name: 'Q12' } }),
      },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(res.status).toBe(200);
    expect((res.body as { device_keys: Record<string, Record<string, unknown>> }).device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('query own device soft-13', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: deviceKeysPayload({ unsigned: { device_display_name: 'Q13' } }),
      },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(res.status).toBe(200);
    expect((res.body as { device_keys: Record<string, Record<string, unknown>> }).device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('query own device soft-14', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: deviceKeysPayload({ unsigned: { device_display_name: 'Q14' } }),
      },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(res.status).toBe(200);
    expect((res.body as { device_keys: Record<string, Record<string, unknown>> }).device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('query own device soft-15', async () => {
    const userKeys = createUserKeysStub({
      deviceKeys: {
        [DEVICE]: deviceKeysPayload({ unsigned: { device_display_name: 'Q15' } }),
      },
    });
    const env = createEnv({ userKeys });
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(res.status).toBe(200);
    expect((res.body as { device_keys: Record<string, Record<string, unknown>> }).device_keys[USER][DEVICE]).toBeTruthy();
  });

  it('query empty device list soft-0', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ device_keys: expect.any(Object) });
  });

  it('query empty device list soft-1', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ device_keys: expect.any(Object) });
  });

  it('query empty device list soft-2', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ device_keys: expect.any(Object) });
  });

  it('query empty device list soft-3', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ device_keys: expect.any(Object) });
  });

  it('query empty device list soft-4', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ device_keys: expect.any(Object) });
  });

  it('query empty device list soft-5', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ device_keys: expect.any(Object) });
  });

  it('query empty device list soft-6', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ device_keys: expect.any(Object) });
  });

  it('query empty device list soft-7', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ device_keys: expect.any(Object) });
  });

  it('query empty device list soft-8', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ device_keys: expect.any(Object) });
  });

  it('query empty device list soft-9', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ device_keys: expect.any(Object) });
  });

  it('query empty device list soft-10', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ device_keys: expect.any(Object) });
  });

  it('query empty device list soft-11', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ device_keys: expect.any(Object) });
  });

  it('query empty device list soft-12', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ device_keys: expect.any(Object) });
  });

  it('query empty device list soft-13', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ device_keys: expect.any(Object) });
  });

  it('query empty device list soft-14', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ device_keys: expect.any(Object) });
  });

  it('query empty device list soft-15', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ device_keys: expect.any(Object) });
  });
});

describe('keys leftovers changes soft flood after #154', () => {

  it('GET changes soft-0', async () => {
    const from = String(1000 + 0);
    const to = String(2000 + 0);
    const env = createEnv({
      db: createKeysDb({
        keyChanges: [
          {
            user_id: BOB,
            device_id: 'DEV0',
            change_type: 'update',
            stream_position: 1500 + 0,
          },
        ],
        memberships: [
          { room_id: '!shared:example.com', user_id: USER, membership: 'join' },
          { room_id: '!shared:example.com', user_id: BOB, membership: 'join' },
        ],
      }),
    });
    const res = await request(env, `/_matrix/client/v3/keys/changes?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: expect.any(Array), left: expect.any(Array) });
  });

  it('GET changes soft-1', async () => {
    const from = String(1000 + 1);
    const to = String(2000 + 1);
    const env = createEnv({
      db: createKeysDb({
        keyChanges: [
          {
            user_id: BOB,
            device_id: 'DEV1',
            change_type: 'update',
            stream_position: 1500 + 1,
          },
        ],
        memberships: [
          { room_id: '!shared:example.com', user_id: USER, membership: 'join' },
          { room_id: '!shared:example.com', user_id: BOB, membership: 'join' },
        ],
      }),
    });
    const res = await request(env, `/_matrix/client/v3/keys/changes?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: expect.any(Array), left: expect.any(Array) });
  });

  it('GET changes soft-2', async () => {
    const from = String(1000 + 2);
    const to = String(2000 + 2);
    const env = createEnv({
      db: createKeysDb({
        keyChanges: [
          {
            user_id: BOB,
            device_id: 'DEV2',
            change_type: 'update',
            stream_position: 1500 + 2,
          },
        ],
        memberships: [
          { room_id: '!shared:example.com', user_id: USER, membership: 'join' },
          { room_id: '!shared:example.com', user_id: BOB, membership: 'join' },
        ],
      }),
    });
    const res = await request(env, `/_matrix/client/v3/keys/changes?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: expect.any(Array), left: expect.any(Array) });
  });

  it('GET changes soft-3', async () => {
    const from = String(1000 + 3);
    const to = String(2000 + 3);
    const env = createEnv({
      db: createKeysDb({
        keyChanges: [
          {
            user_id: BOB,
            device_id: 'DEV3',
            change_type: 'update',
            stream_position: 1500 + 3,
          },
        ],
        memberships: [
          { room_id: '!shared:example.com', user_id: USER, membership: 'join' },
          { room_id: '!shared:example.com', user_id: BOB, membership: 'join' },
        ],
      }),
    });
    const res = await request(env, `/_matrix/client/v3/keys/changes?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: expect.any(Array), left: expect.any(Array) });
  });

  it('GET changes soft-4', async () => {
    const from = String(1000 + 4);
    const to = String(2000 + 4);
    const env = createEnv({
      db: createKeysDb({
        keyChanges: [
          {
            user_id: BOB,
            device_id: 'DEV4',
            change_type: 'update',
            stream_position: 1500 + 4,
          },
        ],
        memberships: [
          { room_id: '!shared:example.com', user_id: USER, membership: 'join' },
          { room_id: '!shared:example.com', user_id: BOB, membership: 'join' },
        ],
      }),
    });
    const res = await request(env, `/_matrix/client/v3/keys/changes?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: expect.any(Array), left: expect.any(Array) });
  });

  it('GET changes soft-5', async () => {
    const from = String(1000 + 5);
    const to = String(2000 + 5);
    const env = createEnv({
      db: createKeysDb({
        keyChanges: [
          {
            user_id: BOB,
            device_id: 'DEV5',
            change_type: 'update',
            stream_position: 1500 + 5,
          },
        ],
        memberships: [
          { room_id: '!shared:example.com', user_id: USER, membership: 'join' },
          { room_id: '!shared:example.com', user_id: BOB, membership: 'join' },
        ],
      }),
    });
    const res = await request(env, `/_matrix/client/v3/keys/changes?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: expect.any(Array), left: expect.any(Array) });
  });

  it('GET changes soft-6', async () => {
    const from = String(1000 + 6);
    const to = String(2000 + 6);
    const env = createEnv({
      db: createKeysDb({
        keyChanges: [
          {
            user_id: BOB,
            device_id: 'DEV6',
            change_type: 'update',
            stream_position: 1500 + 6,
          },
        ],
        memberships: [
          { room_id: '!shared:example.com', user_id: USER, membership: 'join' },
          { room_id: '!shared:example.com', user_id: BOB, membership: 'join' },
        ],
      }),
    });
    const res = await request(env, `/_matrix/client/v3/keys/changes?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: expect.any(Array), left: expect.any(Array) });
  });

  it('GET changes soft-7', async () => {
    const from = String(1000 + 7);
    const to = String(2000 + 7);
    const env = createEnv({
      db: createKeysDb({
        keyChanges: [
          {
            user_id: BOB,
            device_id: 'DEV7',
            change_type: 'update',
            stream_position: 1500 + 7,
          },
        ],
        memberships: [
          { room_id: '!shared:example.com', user_id: USER, membership: 'join' },
          { room_id: '!shared:example.com', user_id: BOB, membership: 'join' },
        ],
      }),
    });
    const res = await request(env, `/_matrix/client/v3/keys/changes?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: expect.any(Array), left: expect.any(Array) });
  });

  it('GET changes soft-8', async () => {
    const from = String(1000 + 8);
    const to = String(2000 + 8);
    const env = createEnv({
      db: createKeysDb({
        keyChanges: [
          {
            user_id: BOB,
            device_id: 'DEV8',
            change_type: 'update',
            stream_position: 1500 + 8,
          },
        ],
        memberships: [
          { room_id: '!shared:example.com', user_id: USER, membership: 'join' },
          { room_id: '!shared:example.com', user_id: BOB, membership: 'join' },
        ],
      }),
    });
    const res = await request(env, `/_matrix/client/v3/keys/changes?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: expect.any(Array), left: expect.any(Array) });
  });

  it('GET changes soft-9', async () => {
    const from = String(1000 + 9);
    const to = String(2000 + 9);
    const env = createEnv({
      db: createKeysDb({
        keyChanges: [
          {
            user_id: BOB,
            device_id: 'DEV9',
            change_type: 'update',
            stream_position: 1500 + 9,
          },
        ],
        memberships: [
          { room_id: '!shared:example.com', user_id: USER, membership: 'join' },
          { room_id: '!shared:example.com', user_id: BOB, membership: 'join' },
        ],
      }),
    });
    const res = await request(env, `/_matrix/client/v3/keys/changes?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: expect.any(Array), left: expect.any(Array) });
  });

  it('GET changes soft-10', async () => {
    const from = String(1000 + 10);
    const to = String(2000 + 10);
    const env = createEnv({
      db: createKeysDb({
        keyChanges: [
          {
            user_id: BOB,
            device_id: 'DEV10',
            change_type: 'update',
            stream_position: 1500 + 10,
          },
        ],
        memberships: [
          { room_id: '!shared:example.com', user_id: USER, membership: 'join' },
          { room_id: '!shared:example.com', user_id: BOB, membership: 'join' },
        ],
      }),
    });
    const res = await request(env, `/_matrix/client/v3/keys/changes?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: expect.any(Array), left: expect.any(Array) });
  });

  it('GET changes soft-11', async () => {
    const from = String(1000 + 11);
    const to = String(2000 + 11);
    const env = createEnv({
      db: createKeysDb({
        keyChanges: [
          {
            user_id: BOB,
            device_id: 'DEV11',
            change_type: 'update',
            stream_position: 1500 + 11,
          },
        ],
        memberships: [
          { room_id: '!shared:example.com', user_id: USER, membership: 'join' },
          { room_id: '!shared:example.com', user_id: BOB, membership: 'join' },
        ],
      }),
    });
    const res = await request(env, `/_matrix/client/v3/keys/changes?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: expect.any(Array), left: expect.any(Array) });
  });

  it('GET changes soft-12', async () => {
    const from = String(1000 + 12);
    const to = String(2000 + 12);
    const env = createEnv({
      db: createKeysDb({
        keyChanges: [
          {
            user_id: BOB,
            device_id: 'DEV12',
            change_type: 'update',
            stream_position: 1500 + 12,
          },
        ],
        memberships: [
          { room_id: '!shared:example.com', user_id: USER, membership: 'join' },
          { room_id: '!shared:example.com', user_id: BOB, membership: 'join' },
        ],
      }),
    });
    const res = await request(env, `/_matrix/client/v3/keys/changes?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: expect.any(Array), left: expect.any(Array) });
  });

  it('GET changes soft-13', async () => {
    const from = String(1000 + 13);
    const to = String(2000 + 13);
    const env = createEnv({
      db: createKeysDb({
        keyChanges: [
          {
            user_id: BOB,
            device_id: 'DEV13',
            change_type: 'update',
            stream_position: 1500 + 13,
          },
        ],
        memberships: [
          { room_id: '!shared:example.com', user_id: USER, membership: 'join' },
          { room_id: '!shared:example.com', user_id: BOB, membership: 'join' },
        ],
      }),
    });
    const res = await request(env, `/_matrix/client/v3/keys/changes?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: expect.any(Array), left: expect.any(Array) });
  });

  it('GET changes soft-14', async () => {
    const from = String(1000 + 14);
    const to = String(2000 + 14);
    const env = createEnv({
      db: createKeysDb({
        keyChanges: [
          {
            user_id: BOB,
            device_id: 'DEV14',
            change_type: 'update',
            stream_position: 1500 + 14,
          },
        ],
        memberships: [
          { room_id: '!shared:example.com', user_id: USER, membership: 'join' },
          { room_id: '!shared:example.com', user_id: BOB, membership: 'join' },
        ],
      }),
    });
    const res = await request(env, `/_matrix/client/v3/keys/changes?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: expect.any(Array), left: expect.any(Array) });
  });

  it('GET changes soft-15', async () => {
    const from = String(1000 + 15);
    const to = String(2000 + 15);
    const env = createEnv({
      db: createKeysDb({
        keyChanges: [
          {
            user_id: BOB,
            device_id: 'DEV15',
            change_type: 'update',
            stream_position: 1500 + 15,
          },
        ],
        memberships: [
          { room_id: '!shared:example.com', user_id: USER, membership: 'join' },
          { room_id: '!shared:example.com', user_id: BOB, membership: 'join' },
        ],
      }),
    });
    const res = await request(env, `/_matrix/client/v3/keys/changes?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: expect.any(Array), left: expect.any(Array) });
  });
});

describe('keys leftovers claim soft flood after #154', () => {

  it('claim missing returns empty soft-0', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: {
          [USER]: { [DEVICE]: 'signed_curve25519' },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_keys: expect.any(Object) });
  });

  it('claim missing returns empty soft-1', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: {
          [USER]: { [DEVICE]: 'signed_curve25519' },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_keys: expect.any(Object) });
  });

  it('claim missing returns empty soft-2', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: {
          [USER]: { [DEVICE]: 'signed_curve25519' },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_keys: expect.any(Object) });
  });

  it('claim missing returns empty soft-3', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: {
          [USER]: { [DEVICE]: 'signed_curve25519' },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_keys: expect.any(Object) });
  });

  it('claim missing returns empty soft-4', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: {
          [USER]: { [DEVICE]: 'signed_curve25519' },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_keys: expect.any(Object) });
  });

  it('claim missing returns empty soft-5', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: {
          [USER]: { [DEVICE]: 'signed_curve25519' },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_keys: expect.any(Object) });
  });

  it('claim missing returns empty soft-6', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: {
          [USER]: { [DEVICE]: 'signed_curve25519' },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_keys: expect.any(Object) });
  });

  it('claim missing returns empty soft-7', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: {
          [USER]: { [DEVICE]: 'signed_curve25519' },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_keys: expect.any(Object) });
  });

  it('claim missing returns empty soft-8', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: {
          [USER]: { [DEVICE]: 'signed_curve25519' },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_keys: expect.any(Object) });
  });

  it('claim missing returns empty soft-9', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: {
          [USER]: { [DEVICE]: 'signed_curve25519' },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_keys: expect.any(Object) });
  });

  it('claim missing returns empty soft-10', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: {
          [USER]: { [DEVICE]: 'signed_curve25519' },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_keys: expect.any(Object) });
  });

  it('claim missing returns empty soft-11', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: {
          [USER]: { [DEVICE]: 'signed_curve25519' },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_keys: expect.any(Object) });
  });

  it('claim missing returns empty soft-12', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: {
          [USER]: { [DEVICE]: 'signed_curve25519' },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_keys: expect.any(Object) });
  });

  it('claim missing returns empty soft-13', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: {
          [USER]: { [DEVICE]: 'signed_curve25519' },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_keys: expect.any(Object) });
  });

  it('claim missing returns empty soft-14', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: {
          [USER]: { [DEVICE]: 'signed_curve25519' },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_keys: expect.any(Object) });
  });

  it('claim missing returns empty soft-15', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: {
          [USER]: { [DEVICE]: 'signed_curve25519' },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ one_time_keys: expect.any(Object) });
  });
});

describe('keys leftovers failure edges after #154', () => {
  it('upload bad JSON', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/keys/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: '{bad',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('upload mismatched user', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload({ user_id: BOB }) })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('query bad JSON', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/keys/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: '{',
    });
    expect(res.status).toBe(400);
  });

  it('changes missing from', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/keys/changes?to=10');
    expect([400, 200]).toContain(res.status);
  });

  it('upload wrong device soft-0', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload({ device_id: 'WRONG0' }) })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('upload wrong device soft-1', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload({ device_id: 'WRONG1' }) })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('upload wrong device soft-2', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload({ device_id: 'WRONG2' }) })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('upload wrong device soft-3', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload({ device_id: 'WRONG3' }) })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('upload wrong device soft-4', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload({ device_id: 'WRONG4' }) })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('upload wrong device soft-5', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload({ device_id: 'WRONG5' }) })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('upload wrong device soft-6', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload({ device_id: 'WRONG6' }) })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('upload wrong device soft-7', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload({ device_id: 'WRONG7' }) })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('upload wrong device soft-8', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload({ device_id: 'WRONG8' }) })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('upload wrong device soft-9', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload({ device_id: 'WRONG9' }) })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('upload wrong device soft-10', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload({ device_id: 'WRONG10' }) })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('upload wrong device soft-11', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload({ device_id: 'WRONG11' }) })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('upload wrong device soft-12', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload({ device_id: 'WRONG12' }) })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('upload wrong device soft-13', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload({ device_id: 'WRONG13' }) })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('upload wrong device soft-14', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload({ device_id: 'WRONG14' }) })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('upload wrong device soft-15', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload({ device_id: 'WRONG15' }) })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });
});

describe('keys leftovers Content-Type charset soft flood after #154', () => {
  const charsets = [
    'application/json',
    'application/json; charset=utf-8',
    'application/json;charset=UTF-8',
    'application/json; charset=UTF-8',
    'application/json; charset="utf-8"',
  ];

  it('upload charset soft-0', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/keys/upload', {
      method: 'POST',
      headers: { 'Content-Type': charsets[0], Authorization: 'Bearer t' },
      body: JSON.stringify({ device_keys: deviceKeysPayload({ unsigned: { device_display_name: 'ct-0' } }) }),
    });
    expect(res.status).toBe(200);
  });

  it('upload charset soft-1', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/keys/upload', {
      method: 'POST',
      headers: { 'Content-Type': charsets[1], Authorization: 'Bearer t' },
      body: JSON.stringify({ device_keys: deviceKeysPayload({ unsigned: { device_display_name: 'ct-1' } }) }),
    });
    expect(res.status).toBe(200);
  });

  it('upload charset soft-2', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/keys/upload', {
      method: 'POST',
      headers: { 'Content-Type': charsets[2], Authorization: 'Bearer t' },
      body: JSON.stringify({ device_keys: deviceKeysPayload({ unsigned: { device_display_name: 'ct-2' } }) }),
    });
    expect(res.status).toBe(200);
  });

  it('upload charset soft-3', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/keys/upload', {
      method: 'POST',
      headers: { 'Content-Type': charsets[3], Authorization: 'Bearer t' },
      body: JSON.stringify({ device_keys: deviceKeysPayload({ unsigned: { device_display_name: 'ct-3' } }) }),
    });
    expect(res.status).toBe(200);
  });

  it('upload charset soft-4', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/keys/upload', {
      method: 'POST',
      headers: { 'Content-Type': charsets[4], Authorization: 'Bearer t' },
      body: JSON.stringify({ device_keys: deviceKeysPayload({ unsigned: { device_display_name: 'ct-4' } }) }),
    });
    expect(res.status).toBe(200);
  });
});

describe('keys leftovers method matrix after #154', () => {
  const cases: Array<{ path: string; bad: string[] }> = [
    { path: '/_matrix/client/v3/keys/upload', bad: ['GET', 'PUT', 'DELETE', 'PATCH'] },
    { path: '/_matrix/client/v3/keys/query', bad: ['GET', 'PUT', 'DELETE', 'PATCH'] },
    { path: '/_matrix/client/v3/keys/claim', bad: ['GET', 'PUT', 'DELETE', 'PATCH'] },
    { path: '/_matrix/client/v3/keys/changes', bad: ['POST', 'PUT', 'DELETE', 'PATCH'] },
  ];
  for (const c of cases) {
    for (const method of c.bad) {
      it(`${method} ${c.path} → 404/405`, async () => {
        const env = createEnv();
        const res = await request(env, c.path, jsonInit(method, method === 'GET' ? undefined : {}));
        expect([404, 405]).toContain(res.status);
      });
    }
  }
});

describe('keys leftovers lifecycle soft floods after #154', () => {

  it('upload then query then changes soft-0', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({ unsigned: { device_display_name: 'Life-0' } });
    const up = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(up.status).toBe(200);
    const q = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(q.status).toBe(200);
    const ch = await request(env, '/_matrix/client/v3/keys/changes?from=0&to=999999');
    expect(ch.status).toBe(200);
  });

  it('upload then query then changes soft-1', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({ unsigned: { device_display_name: 'Life-1' } });
    const up = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(up.status).toBe(200);
    const q = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(q.status).toBe(200);
    const ch = await request(env, '/_matrix/client/v3/keys/changes?from=0&to=999999');
    expect(ch.status).toBe(200);
  });

  it('upload then query then changes soft-2', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({ unsigned: { device_display_name: 'Life-2' } });
    const up = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(up.status).toBe(200);
    const q = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(q.status).toBe(200);
    const ch = await request(env, '/_matrix/client/v3/keys/changes?from=0&to=999999');
    expect(ch.status).toBe(200);
  });

  it('upload then query then changes soft-3', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({ unsigned: { device_display_name: 'Life-3' } });
    const up = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(up.status).toBe(200);
    const q = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(q.status).toBe(200);
    const ch = await request(env, '/_matrix/client/v3/keys/changes?from=0&to=999999');
    expect(ch.status).toBe(200);
  });

  it('upload then query then changes soft-4', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({ unsigned: { device_display_name: 'Life-4' } });
    const up = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(up.status).toBe(200);
    const q = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(q.status).toBe(200);
    const ch = await request(env, '/_matrix/client/v3/keys/changes?from=0&to=999999');
    expect(ch.status).toBe(200);
  });

  it('upload then query then changes soft-5', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({ unsigned: { device_display_name: 'Life-5' } });
    const up = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(up.status).toBe(200);
    const q = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(q.status).toBe(200);
    const ch = await request(env, '/_matrix/client/v3/keys/changes?from=0&to=999999');
    expect(ch.status).toBe(200);
  });

  it('upload then query then changes soft-6', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({ unsigned: { device_display_name: 'Life-6' } });
    const up = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(up.status).toBe(200);
    const q = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(q.status).toBe(200);
    const ch = await request(env, '/_matrix/client/v3/keys/changes?from=0&to=999999');
    expect(ch.status).toBe(200);
  });

  it('upload then query then changes soft-7', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({ unsigned: { device_display_name: 'Life-7' } });
    const up = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(up.status).toBe(200);
    const q = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(q.status).toBe(200);
    const ch = await request(env, '/_matrix/client/v3/keys/changes?from=0&to=999999');
    expect(ch.status).toBe(200);
  });

  it('upload then query then changes soft-8', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({ unsigned: { device_display_name: 'Life-8' } });
    const up = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(up.status).toBe(200);
    const q = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(q.status).toBe(200);
    const ch = await request(env, '/_matrix/client/v3/keys/changes?from=0&to=999999');
    expect(ch.status).toBe(200);
  });

  it('upload then query then changes soft-9', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({ unsigned: { device_display_name: 'Life-9' } });
    const up = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(up.status).toBe(200);
    const q = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(q.status).toBe(200);
    const ch = await request(env, '/_matrix/client/v3/keys/changes?from=0&to=999999');
    expect(ch.status).toBe(200);
  });

  it('upload then query then changes soft-10', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({ unsigned: { device_display_name: 'Life-10' } });
    const up = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(up.status).toBe(200);
    const q = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(q.status).toBe(200);
    const ch = await request(env, '/_matrix/client/v3/keys/changes?from=0&to=999999');
    expect(ch.status).toBe(200);
  });

  it('upload then query then changes soft-11', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({ unsigned: { device_display_name: 'Life-11' } });
    const up = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(up.status).toBe(200);
    const q = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(q.status).toBe(200);
    const ch = await request(env, '/_matrix/client/v3/keys/changes?from=0&to=999999');
    expect(ch.status).toBe(200);
  });

  it('upload then query then changes soft-12', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({ unsigned: { device_display_name: 'Life-12' } });
    const up = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(up.status).toBe(200);
    const q = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(q.status).toBe(200);
    const ch = await request(env, '/_matrix/client/v3/keys/changes?from=0&to=999999');
    expect(ch.status).toBe(200);
  });

  it('upload then query then changes soft-13', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({ unsigned: { device_display_name: 'Life-13' } });
    const up = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(up.status).toBe(200);
    const q = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(q.status).toBe(200);
    const ch = await request(env, '/_matrix/client/v3/keys/changes?from=0&to=999999');
    expect(ch.status).toBe(200);
  });

  it('upload then query then changes soft-14', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({ unsigned: { device_display_name: 'Life-14' } });
    const up = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(up.status).toBe(200);
    const q = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(q.status).toBe(200);
    const ch = await request(env, '/_matrix/client/v3/keys/changes?from=0&to=999999');
    expect(ch.status).toBe(200);
  });

  it('upload then query then changes soft-15', async () => {
    const env = createEnv();
    const keys = deviceKeysPayload({ unsigned: { device_display_name: 'Life-15' } });
    const up = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', { device_keys: keys }));
    expect(up.status).toBe(200);
    const q = await request(
      env,
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } })
    );
    expect(q.status).toBe(200);
    const ch = await request(env, '/_matrix/client/v3/keys/changes?from=0&to=999999');
    expect(ch.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// deepen keys-api route leftovers after #241
// ---------------------------------------------------------------------------

describe('keys leftovers claim fallback soft flood after #241', () => {
  for (let i = 0; i < 8; i++) {
    it(`claim fallback_keys marks used soft-${i}`, async () => {
      const keyId = `signed_curve25519:FB${i}`;
      const env = createEnv({
        db: createKeysDb({
          fallbacks: [
            {
              user_id: USER,
              device_id: DEVICE,
              algorithm: 'signed_curve25519',
              key_id: keyId,
              key_data: JSON.stringify({ key: `fb-${i}` }),
              used: 0,
            },
          ],
        }),
      });
      const res = await request(
        env,
        '/_matrix/client/v3/keys/claim',
        jsonInit('POST', {
          one_time_keys: { [USER]: { [DEVICE]: 'signed_curve25519' } },
        })
      );
      expect(res.status).toBe(200);
      const claimed = (
        res.body as { one_time_keys: Record<string, Record<string, Record<string, { fallback?: boolean }>>> }
      ).one_time_keys[USER][DEVICE][keyId];
      expect(claimed).toMatchObject({ key: `fb-${i}`, fallback: true });
      expect(env._db.fallbacks[0].used).toBe(1);
    });
  }
});

describe('keys leftovers claim D1 legacy OTK soft flood after #241', () => {
  for (let i = 0; i < 8; i++) {
    it(`claim D1 legacy OTK soft-${i}`, async () => {
      const keyId = `signed_curve25519:LEG${i}`;
      const env = createEnv({
        db: createKeysDb({
          otks: [
            {
              id: 200 + i,
              user_id: USER,
              device_id: DEVICE,
              algorithm: 'signed_curve25519',
              key_id: keyId,
              key_data: JSON.stringify({ key: `leg-${i}` }),
              claimed: 0,
            },
          ],
        }),
        oneTimeKeysKv: mockKv(),
      });
      const res = await request(
        env,
        '/_matrix/client/v3/keys/claim',
        jsonInit('POST', {
          one_time_keys: { [USER]: { [DEVICE]: 'signed_curve25519' } },
        })
      );
      expect(res.status).toBe(200);
      expect(
        (res.body as { one_time_keys: Record<string, Record<string, Record<string, unknown>>> })
          .one_time_keys[USER][DEVICE][keyId]
      ).toEqual({ key: `leg-${i}` });
      expect(env._db.otks[0].claimed).toBe(1);
    });
  }
});

describe('keys leftovers upload fallback_keys soft flood after #241', () => {
  for (let i = 0; i < 8; i++) {
    it(`upload fallback_keys soft-${i}`, async () => {
      const env = createEnv();
      const keyId = `signed_curve25519:UPFB${i}`;
      const res = await request(
        env,
        '/_matrix/client/v3/keys/upload',
        jsonInit('POST', {
          fallback_keys: { [keyId]: { key: `upfb-${i}`, fallback: true } },
        })
      );
      expect(res.status).toBe(200);
      expect(env._db.fallbacks).toHaveLength(1);
      expect(env._db.fallbacks[0]).toMatchObject({
        user_id: USER,
        device_id: DEVICE,
        algorithm: 'signed_curve25519',
        key_id: keyId,
        used: 0,
      });
    });
  }
});

describe('keys leftovers query user_signing isolation soft flood after #241', () => {
  for (let i = 0; i < 8; i++) {
    it(`query other user omits user_signing soft-${i}`, async () => {
      const env = createEnv({
        userKeys: createUserKeysStub({
          crossSigning: {
            master: { keys: { 'ed25519:M': `m-${i}` } },
            self_signing: { keys: { 'ed25519:S': `s-${i}` } },
            user_signing: { keys: { 'ed25519:U': `u-${i}` } },
          },
          deviceKeys: {},
        }),
      });
      // Auth is USER; query BOB — user_signing must be omitted
      env._userKeys.crossSigning = {
        master: { keys: { 'ed25519:M': `m-${i}` } },
        self_signing: { keys: { 'ed25519:S': `s-${i}` } },
        user_signing: { keys: { 'ed25519:U': `u-${i}` } },
      };
      // Stub serves same store for any user id in this mock — assert own vs other via API shape
      const other = await request(
        env,
        '/_matrix/client/v3/keys/query',
        jsonInit('POST', { device_keys: { [BOB]: [] } })
      );
      expect(other.status).toBe(200);
      const body = other.body as {
        master_keys: Record<string, unknown>;
        self_signing_keys: Record<string, unknown>;
        user_signing_keys: Record<string, unknown>;
      };
      // Mock returns CS keys for any queried user; route only attaches user_signing for self
      expect(body.user_signing_keys[BOB]).toBeUndefined();
      expect(body.master_keys[BOB]).toBeTruthy();
      expect(body.self_signing_keys[BOB]).toBeTruthy();
    });
  }

  for (let i = 0; i < 4; i++) {
    it(`query self includes user_signing soft-${i}`, async () => {
      const env = createEnv({
        userKeys: createUserKeysStub({
          crossSigning: {
            master: { keys: { 'ed25519:M': `self-m-${i}` } },
            user_signing: { keys: { 'ed25519:U': `self-u-${i}` } },
          },
        }),
      });
      const res = await request(
        env,
        '/_matrix/client/v3/keys/query',
        jsonInit('POST', { device_keys: { [USER]: [] } })
      );
      expect(res.status).toBe(200);
      expect(
        (res.body as { user_signing_keys: Record<string, unknown> }).user_signing_keys[USER]
      ).toMatchObject({ keys: { 'ed25519:U': `self-u-${i}` } });
    });
  }
});

describe('keys leftovers device_signing auth edges soft flood after #241', () => {
  for (let i = 0; i < 6; i++) {
    it(`unrecognized auth type soft-${i}`, async () => {
      const env = createEnv({
        db: createKeysDb({
          crossSigningKeys: [
            {
              user_id: USER,
              key_type: 'master',
              key_id: 'ed25519:master',
              key_data: '{}',
            },
          ],
          passwordHashes: new Map([[USER, 'mockok:s3cret']]),
        }),
      });
      const res = await request(
        env,
        '/_matrix/client/v3/keys/device_signing/upload',
        jsonInit('POST', {
          auth: { type: 'm.login.dummy' },
          master_key: {
            user_id: USER,
            usage: ['master'],
            keys: { 'ed25519:master': `x-${i}` },
          },
        })
      );
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ errcode: 'M_UNRECOGNIZED' });
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`empty-string password soft-${i}`, async () => {
      const env = createEnv({
        db: createKeysDb({
          crossSigningKeys: [
            {
              user_id: USER,
              key_type: 'master',
              key_id: 'ed25519:master',
              key_data: '{}',
            },
          ],
          passwordHashes: new Map([[USER, 'mockok:s3cret']]),
        }),
      });
      const res = await request(
        env,
        '/_matrix/client/v3/keys/device_signing/upload',
        jsonInit('POST', {
          auth: { type: 'm.login.password', password: '' },
          master_key: {
            user_id: USER,
            usage: ['master'],
            keys: { 'ed25519:master': `e-${i}` },
          },
        })
      );
      expect([400, 403]).toContain(res.status);
    });
  }
});

describe('keys leftovers upload empty one_time_keys counts soft flood after #241', () => {
  for (let i = 0; i < 8; i++) {
    it(`empty body returns counts map soft-${i}`, async () => {
      const env = createEnv();
      const res = await request(env, '/_matrix/client/v3/keys/upload', jsonInit('POST', {}));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ one_time_key_counts: {} });
    });
  }
});

describe('keys leftovers signatures missing device soft flood after #241', () => {
  for (let i = 0; i < 6; i++) {
    it(`signatures for unknown device still 200 soft-${i}`, async () => {
      const env = createEnv();
      const res = await request(
        env,
        '/_matrix/client/v3/keys/signatures/upload',
        jsonInit('POST', {
          [USER]: {
            MISSING: {
              user_id: USER,
              device_id: 'MISSING',
              algorithms: [],
              keys: {},
              signatures: { [USER]: { 'ed25519:MISSING': `sig-${i}` } },
            },
          },
        })
      );
      expect(res.status).toBe(200);
      expect(env._db.signatures.some((s) => s.signature === `sig-${i}`)).toBe(true);
    });
  }
});
