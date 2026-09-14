/**
 * TOKENMAXX HEAVY deepen after #97 (key-backups) + oauth/search work.
 * Different slice: Client-Server E2EE keys HTTP routes (src/api/keys.ts).
 * Tests-only — no product inventing. Exercises upload/query/claim/changes,
 * device_signing UIA, signatures, and SSO/token UIA helpers via Hono app.request().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const USER = '@alice:example.com';
const DEVICE = 'DEVICEA';
const OTHER = '@bob:example.com';
const SERVER = 'example.com';
const REMOTE = 'remote.example.com';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>
    ) => {
      c.set('userId', USER);
      c.set('deviceId', DEVICE);
      await next();
    };
  },
}));

vi.mock('../src/utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/crypto')>();
  return {
    ...actual,
    verifyPassword: vi.fn(async (password: string, hash: string) => {
      return hash === `mockok:${password}`;
    }),
  };
});

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getServersInRoomsWithUser: vi.fn(async () => [REMOTE, SERVER]),
    getPasswordHash: vi.fn(async (db: { users?: Map<string, { password_hash: string | null }> }, userId: string) => {
      const row = db.users?.get(userId);
      if (row) return row.password_hash;
      return null;
    }),
  };
});

import keys from '../src/api/keys';
import { getServersInRoomsWithUser, getPasswordHash } from '../src/services/database';
import { verifyPassword } from '../src/utils/crypto';

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };

function mockKv(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial };
  const puts: KvPut[] = [];
  const deletes: string[] = [];
  const kv = {
    data,
    puts,
    deletes,
    get: async (key: string, type?: string) => {
      const raw = data[key];
      if (raw == null) return null;
      if (type === 'json') return JSON.parse(raw);
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
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  };
  return kv as unknown as KVNamespace & {
    data: Record<string, string>;
    puts: KvPut[];
    deletes: string[];
  };
}

type DeviceKeyMap = Record<string, Record<string, unknown>>;
type CrossSigningMap = {
  master?: Record<string, unknown>;
  self_signing?: Record<string, unknown>;
  user_signing?: Record<string, unknown>;
};

function createUserKeysDO(opts: {
  deviceKeys?: DeviceKeyMap;
  crossSigning?: Record<string, CrossSigningMap>;
  failPaths?: string[];
} = {}) {
  const deviceKeys: DeviceKeyMap = opts.deviceKeys ?? {};
  const crossSigning: Record<string, CrossSigningMap> = opts.crossSigning ?? {};
  const failPaths = new Set(opts.failPaths ?? []);
  const fetchLog: Array<{ userId: string; url: string; method: string; body?: unknown }> = [];

  function stubFor(userId: string) {
    return {
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);
        const path = url.pathname;
        let body: unknown;
        if (req.method === 'POST') {
          try {
            body = await req.clone().json();
          } catch {
            body = undefined;
          }
        }
        fetchLog.push({ userId, url: req.url, method: req.method, body });

        if (failPaths.has(path)) {
          return new Response('DO boom', { status: 500 });
        }

        if (path === '/cross-signing/get') {
          return Response.json(crossSigning[userId] ?? {});
        }
        if (path === '/cross-signing/put') {
          const incoming = (body ?? {}) as CrossSigningMap;
          crossSigning[userId] = { ...(crossSigning[userId] ?? {}), ...incoming };
          return Response.json({ success: true });
        }
        if (path === '/device-keys/get') {
          const deviceId = url.searchParams.get('device_id');
          const userMap = deviceKeys[userId] ?? {};
          if (deviceId) {
            return Response.json(userMap[deviceId] ?? null);
          }
          return Response.json(userMap);
        }
        if (path === '/device-keys/put') {
          const { device_id, keys: dk } = body as { device_id: string; keys: unknown };
          if (!deviceKeys[userId]) deviceKeys[userId] = {};
          deviceKeys[userId][device_id] = dk as Record<string, unknown>;
          return Response.json({ success: true });
        }
        return new Response('Not found', { status: 404 });
      },
    };
  }

  const ns = {
    deviceKeys,
    crossSigning,
    fetchLog,
    idFromName(name: string) {
      return { name };
    },
    get(id: { name: string }) {
      return stubFor(id.name);
    },
  };
  return ns as unknown as DurableObjectNamespace & {
    deviceKeys: DeviceKeyMap;
    crossSigning: Record<string, CrossSigningMap>;
    fetchLog: typeof fetchLog;
  };
}

type EduCapture = { destination: string; edu_type: string; content: Record<string, unknown> };

function createFederationDO(edus: EduCapture[] = [], opts: { throwOnSend?: boolean } = {}) {
  const ns = {
    edus,
    idFromName(name: string) {
      return { name };
    },
    get(id: { name: string }) {
      return {
        async fetch(req: Request): Promise<Response> {
          if (opts.throwOnSend) {
            throw new Error('federation DO down');
          }
          const url = new URL(req.url);
          if (url.pathname === '/send-edu' && req.method === 'POST') {
            const body = (await req.json()) as EduCapture;
            edus.push(body);
            return Response.json({ ok: true });
          }
          return new Response('Not found', { status: 404 });
        },
      };
    },
  };
  return ns as unknown as DurableObjectNamespace & { edus: EduCapture[] };
}

type OtkRow = {
  id: number;
  user_id: string;
  device_id: string;
  algorithm: string;
  key_id: string;
  key_data: string;
  claimed: number;
  claimed_at?: number;
};

type FallbackRow = {
  user_id: string;
  device_id: string;
  algorithm: string;
  key_id: string;
  key_data: string;
  used: number;
};

type ChangeRow = {
  user_id: string;
  device_id: string | null;
  change_type: string;
  stream_position: number;
};

type SigRow = {
  user_id: string;
  key_id: string;
  signer_user_id: string;
  signer_key_id: string;
  signature: string;
};

type CsKeyRow = {
  user_id: string;
  key_type: string;
  key_id: string;
  key_data: string;
};

type SqlCall = { sql: string; args: unknown[] };

function createKeysDb(opts: {
  streamPosition?: number;
  oneTimeKeys?: OtkRow[];
  fallbackKeys?: FallbackRow[];
  changes?: ChangeRow[];
  crossSigningCount?: number;
  crossSigningKeys?: CsKeyRow[];
  signatures?: SigRow[];
  idpLinkCounts?: Map<string, number>;
  users?: Map<string, { password_hash: string | null }>;
  accountData?: Map<string, string>;
  /** Precomputed rows returned by the keys/changes join query */
  changeQueryResults?: Array<{ user_id: string; change_type: string }>;
  throwOnSignatureInsert?: boolean;
} = {}) {
  let streamPosition = opts.streamPosition ?? 0;
  const oneTimeKeys = opts.oneTimeKeys ?? [];
  const fallbackKeys = opts.fallbackKeys ?? [];
  const changes = opts.changes ?? [];
  let crossSigningCount = opts.crossSigningCount ?? (opts.crossSigningKeys?.length ? 1 : 0);
  const crossSigningKeys = opts.crossSigningKeys ?? [];
  const signatures = opts.signatures ?? [];
  const idpLinkCounts = opts.idpLinkCounts ?? new Map<string, number>();
  const users = opts.users ?? new Map<string, { password_hash: string | null }>();
  const accountData = opts.accountData ?? new Map<string, string>();
  let nextOtkId = oneTimeKeys.reduce((m, r) => Math.max(m, r.id), 0) + 1;

  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const runs: SqlCall[] = [];

  const db = {
    users,
    oneTimeKeys,
    fallbackKeys,
    changes,
    signatures,
    crossSigningKeys,
    accountData,
    inserts,
    updates,
    runs,
    get streamPosition() {
      return streamPosition;
    },
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              // stream_positions SELECT
              if (sql.includes('SELECT position FROM stream_positions')) {
                return { position: streamPosition } as T;
              }

              // cross_signing_keys COUNT
              if (
                sql.includes('SELECT COUNT(*) as count FROM cross_signing_keys') &&
                sql.includes('user_id = ?')
              ) {
                const userId = args[0] as string;
                if (opts.crossSigningCount !== undefined && !opts.crossSigningKeys) {
                  return { count: userId === USER ? crossSigningCount : 0 } as T;
                }
                const count = crossSigningKeys.filter((k) => k.user_id === userId).length;
                return { count } as T;
              }

              // idp_user_links COUNT
              if (sql.includes('FROM idp_user_links') && sql.includes('COUNT(*)')) {
                const userId = args[0] as string;
                return { count: idpLinkCounts.get(userId) ?? 0 } as T;
              }

              // users password_hash (if product ever hits DB directly)
              if (sql.includes('FROM users') && sql.includes('password_hash')) {
                const userId = args[0] as string;
                const u = users.get(userId);
                return (u ? { password_hash: u.password_hash } : null) as T;
              }

              // account_data SSSS
              if (
                sql.includes('FROM account_data') &&
                sql.includes("m.secret_storage.default_key")
              ) {
                const userId = args[0] as string;
                const content = accountData.get(userId);
                return (content ? { content } : null) as T;
              }

              // one_time_keys legacy claim SELECT
              if (
                sql.includes('FROM one_time_keys') &&
                sql.includes('claimed = 0') &&
                sql.includes('SELECT id, key_id, key_data')
              ) {
                const [userId, deviceId, algorithm] = args as string[];
                const hit = oneTimeKeys.find(
                  (k) =>
                    k.user_id === userId &&
                    k.device_id === deviceId &&
                    k.algorithm === algorithm &&
                    k.claimed === 0
                );
                return (hit
                  ? { id: hit.id, key_id: hit.key_id, key_data: hit.key_data }
                  : null) as T;
              }

              // fallback_keys SELECT
              if (sql.includes('FROM fallback_keys') && sql.includes('SELECT key_id, key_data, used')) {
                const [userId, deviceId, algorithm] = args as string[];
                const hit = fallbackKeys.find(
                  (k) =>
                    k.user_id === userId &&
                    k.device_id === deviceId &&
                    k.algorithm === algorithm
                );
                return (hit
                  ? { key_id: hit.key_id, key_data: hit.key_data, used: hit.used }
                  : null) as T;
              }

              return null;
            },

            async all<T>() {
              // keys/changes shared-room filter query
              if (
                sql.includes('FROM device_key_changes') &&
                sql.includes('SELECT DISTINCT') &&
                sql.includes('room_memberships')
              ) {
                if (opts.changeQueryResults) {
                  return { results: opts.changeQueryResults } as { results: T[] };
                }
                const fromPos = args[0] as number;
                const toPos = args[1] as number;
                const results = changes
                  .filter((c) => c.stream_position > fromPos && c.stream_position <= toPos)
                  .map((c) => ({ user_id: c.user_id, change_type: c.change_type }));
                // Deduplicate by user+type like DISTINCT
                const seen = new Set<string>();
                const distinct = results.filter((r) => {
                  const k = `${r.user_id}|${r.change_type}`;
                  if (seen.has(k)) return false;
                  seen.add(k);
                  return true;
                });
                return { results: distinct } as { results: T[] };
              }

              // cross_signing_signatures SELECT for merge
              if (
                sql.includes('FROM cross_signing_signatures') &&
                sql.includes('SELECT signer_user_id, signer_key_id, signature')
              ) {
                const [userId, keyId] = args as string[];
                const results = signatures.filter(
                  (s) => s.user_id === userId && s.key_id === keyId
                );
                return { results } as { results: T[] };
              }

              return { results: [] as T[] };
            },

            async run() {
              runs.push({ sql, args });

              // stream_positions UPDATE
              if (sql.includes('UPDATE stream_positions') && sql.includes('position = position + 1')) {
                streamPosition += 1;
                updates.push({ sql, args });
                return { success: true, meta: { changes: 1 } };
              }

              // device_key_changes INSERT
              if (sql.includes('INSERT INTO device_key_changes')) {
                const [userId, deviceId, changeType, pos] = args as [
                  string,
                  string | null,
                  string,
                  number,
                ];
                changes.push({
                  user_id: userId,
                  device_id: deviceId,
                  change_type: changeType,
                  stream_position: pos,
                });
                inserts.push({ sql, args });
                return { success: true, meta: { changes: 1 } };
              }

              // one_time_keys INSERT
              if (sql.includes('INSERT INTO one_time_keys')) {
                const [userId, deviceId, algorithm, keyId, keyData] = args as string[];
                const existing = oneTimeKeys.findIndex(
                  (k) =>
                    k.user_id === userId &&
                    k.device_id === deviceId &&
                    k.algorithm === algorithm &&
                    k.key_id === keyId
                );
                if (existing >= 0) {
                  oneTimeKeys[existing].key_data = keyData;
                } else {
                  oneTimeKeys.push({
                    id: nextOtkId++,
                    user_id: userId,
                    device_id: deviceId,
                    algorithm,
                    key_id: keyId,
                    key_data: keyData,
                    claimed: 0,
                  });
                }
                inserts.push({ sql, args });
                return { success: true, meta: { changes: 1 } };
              }

              // one_time_keys UPDATE claimed by key_id
              if (
                sql.includes('UPDATE one_time_keys SET claimed = 1') &&
                sql.includes('key_id = ?')
              ) {
                const [claimedAt, userId, deviceId, keyId] = args as [
                  number,
                  string,
                  string,
                  string,
                ];
                const hit = oneTimeKeys.find(
                  (k) =>
                    k.user_id === userId &&
                    k.device_id === deviceId &&
                    k.key_id === keyId
                );
                if (hit) {
                  hit.claimed = 1;
                  hit.claimed_at = claimedAt;
                }
                updates.push({ sql, args });
                return { success: true, meta: { changes: hit ? 1 : 0 } };
              }

              // one_time_keys UPDATE claimed by id
              if (
                sql.includes('UPDATE one_time_keys SET claimed = 1') &&
                sql.includes('WHERE id = ?')
              ) {
                const [claimedAt, id] = args as [number, number];
                const hit = oneTimeKeys.find((k) => k.id === id);
                if (hit) {
                  hit.claimed = 1;
                  hit.claimed_at = claimedAt;
                }
                updates.push({ sql, args });
                return { success: true, meta: { changes: hit ? 1 : 0 } };
              }

              // fallback_keys INSERT
              if (sql.includes('INSERT INTO fallback_keys')) {
                const [userId, deviceId, algorithm, keyId, keyData] = args as string[];
                const idx = fallbackKeys.findIndex(
                  (k) =>
                    k.user_id === userId &&
                    k.device_id === deviceId &&
                    k.algorithm === algorithm
                );
                if (idx >= 0) {
                  fallbackKeys[idx] = {
                    user_id: userId,
                    device_id: deviceId,
                    algorithm,
                    key_id: keyId,
                    key_data: keyData,
                    used: 0,
                  };
                } else {
                  fallbackKeys.push({
                    user_id: userId,
                    device_id: deviceId,
                    algorithm,
                    key_id: keyId,
                    key_data: keyData,
                    used: 0,
                  });
                }
                inserts.push({ sql, args });
                return { success: true, meta: { changes: 1 } };
              }

              // fallback_keys UPDATE used
              if (sql.includes('UPDATE fallback_keys SET used = 1')) {
                const [userId, deviceId, algorithm] = args as string[];
                const hit = fallbackKeys.find(
                  (k) =>
                    k.user_id === userId &&
                    k.device_id === deviceId &&
                    k.algorithm === algorithm
                );
                if (hit) hit.used = 1;
                updates.push({ sql, args });
                return { success: true, meta: { changes: hit ? 1 : 0 } };
              }

              // cross_signing_keys INSERT
              if (sql.includes('INSERT INTO cross_signing_keys')) {
                const [userId, keyId, keyData] = args as string[];
                const keyType = sql.includes("'master'")
                  ? 'master'
                  : sql.includes("'self_signing'")
                    ? 'self_signing'
                    : 'user_signing';
                const idx = crossSigningKeys.findIndex(
                  (k) => k.user_id === userId && k.key_type === keyType
                );
                const row: CsKeyRow = {
                  user_id: userId,
                  key_type: keyType,
                  key_id: keyId,
                  key_data: keyData,
                };
                if (idx >= 0) crossSigningKeys[idx] = row;
                else crossSigningKeys.push(row);
                crossSigningCount = Math.max(crossSigningCount, 1);
                inserts.push({ sql, args });
                return { success: true, meta: { changes: 1 } };
              }

              // cross_signing_signatures INSERT
              if (sql.includes('INSERT INTO cross_signing_signatures')) {
                if (opts.throwOnSignatureInsert) {
                  throw new Error('signature insert failed');
                }
                const [userId, keyId, signerUserId, signerKeyId, signature] = args as string[];
                const idx = signatures.findIndex(
                  (s) =>
                    s.user_id === userId &&
                    s.key_id === keyId &&
                    s.signer_user_id === signerUserId &&
                    s.signer_key_id === signerKeyId
                );
                const row: SigRow = {
                  user_id: userId,
                  key_id: keyId,
                  signer_user_id: signerUserId,
                  signer_key_id: signerKeyId,
                  signature,
                };
                if (idx >= 0) signatures[idx] = row;
                else signatures.push(row);
                inserts.push({ sql, args });
                return { success: true, meta: { changes: 1 } };
              }

              return { success: true, meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };

  return db as unknown as D1Database & typeof db;
}

function makeEnv(opts: {
  db?: ReturnType<typeof createKeysDb>;
  deviceKeys?: ReturnType<typeof mockKv>;
  oneTimeKeys?: ReturnType<typeof mockKv>;
  crossSigningKeys?: ReturnType<typeof mockKv>;
  cache?: ReturnType<typeof mockKv>;
  accountData?: ReturnType<typeof mockKv>;
  userKeys?: ReturnType<typeof createUserKeysDO>;
  federation?: ReturnType<typeof createFederationDO>;
  serverName?: string;
} = {}): Env & {
  _userKeys: ReturnType<typeof createUserKeysDO>;
  _federation: ReturnType<typeof createFederationDO>;
  _db: ReturnType<typeof createKeysDb>;
  _deviceKv: ReturnType<typeof mockKv>;
  _otkKv: ReturnType<typeof mockKv>;
  _csKv: ReturnType<typeof mockKv>;
  _cache: ReturnType<typeof mockKv>;
  _accountData: ReturnType<typeof mockKv>;
} {
  const db = opts.db ?? createKeysDb();
  const userKeys = opts.userKeys ?? createUserKeysDO();
  const federation = opts.federation ?? createFederationDO();
  const deviceKv = opts.deviceKeys ?? mockKv();
  const otkKv = opts.oneTimeKeys ?? mockKv();
  const csKv = opts.crossSigningKeys ?? mockKv();
  const cache = opts.cache ?? mockKv();
  const accountData = opts.accountData ?? mockKv();

  return {
    SERVER_NAME: opts.serverName ?? SERVER,
    SERVER_VERSION: '0.1.0-test',
    DB: db,
    DEVICE_KEYS: deviceKv,
    ONE_TIME_KEYS: otkKv,
    CROSS_SIGNING_KEYS: csKv,
    CACHE: cache,
    ACCOUNT_DATA: accountData,
    USER_KEYS: userKeys,
    FEDERATION: federation,
    _userKeys: userKeys,
    _federation: federation,
    _db: db,
    _deviceKv: deviceKv,
    _otkKv: otkKv,
    _csKv: csKv,
    _cache: cache,
    _accountData: accountData,
  } as Env & {
    _userKeys: ReturnType<typeof createUserKeysDO>;
    _federation: ReturnType<typeof createFederationDO>;
    _db: ReturnType<typeof createKeysDb>;
    _deviceKv: ReturnType<typeof mockKv>;
    _otkKv: ReturnType<typeof mockKv>;
    _csKv: ReturnType<typeof mockKv>;
    _cache: ReturnType<typeof mockKv>;
    _accountData: ReturnType<typeof mockKv>;
  };
}

async function request(
  path: string,
  init: RequestInit = {},
  env: Env = makeEnv()
): Promise<{ status: number; body: unknown; headers: Headers; text?: string }> {
  const res = await keys.request(`http://localhost${path}`, init, env);
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/html')) {
    const text = await res.text();
    return { status: res.status, body: text, headers: res.headers, text };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body, headers: res.headers };
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer t',
    },
    body: JSON.stringify(body),
  };
}

function deviceKeysPayload(overrides: Record<string, unknown> = {}) {
  return {
    user_id: USER,
    device_id: DEVICE,
    algorithms: ['m.olm.v1.curve25519-aes-sha2', 'm.megolm.v1.aes-sha2'],
    keys: {
      [`curve25519:${DEVICE}`]: 'curvePub',
      [`ed25519:${DEVICE}`]: 'edPub',
    },
    signatures: {
      [USER]: { [`ed25519:${DEVICE}`]: 'devSig' },
    },
    unsigned: { device_display_name: 'Alice Phone' },
    ...overrides,
  };
}

function masterKey() {
  return {
    user_id: USER,
    usage: ['master'],
    keys: { 'ed25519:master': 'masterPub' },
    signatures: { [USER]: { [`ed25519:${DEVICE}`]: 'mskSig' } },
  };
}

function selfSigningKey() {
  return {
    user_id: USER,
    usage: ['self_signing'],
    keys: { 'ed25519:ssk': 'sskPub' },
    signatures: { [USER]: { 'ed25519:master': 'sskSig' } },
  };
}

function userSigningKey() {
  return {
    user_id: USER,
    usage: ['user_signing'],
    keys: { 'ed25519:usk': 'uskPub' },
    signatures: { [USER]: { 'ed25519:master': 'uskSig' } },
  };
}

beforeEach(() => {
  vi.mocked(getServersInRoomsWithUser).mockResolvedValue([REMOTE, SERVER]);
  vi.mocked(getPasswordHash).mockImplementation(
    async (db: { users?: Map<string, { password_hash: string | null }> }, userId: string) => {
      const row = db.users?.get(userId);
      if (row) return row.password_hash;
      return null;
    }
  );
  vi.mocked(verifyPassword).mockImplementation(
    async (password: string, hash: string) => hash === `mockok:${password}`
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// POST /keys/upload
// ---------------------------------------------------------------------------

describe('POST /_matrix/client/v3/keys/upload', () => {
  it('returns M_BAD_JSON for invalid JSON body', async () => {
    const env = makeEnv();
    const res = await request(
      '/_matrix/client/v3/keys/upload',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: '{not-json',
      },
      env
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('rejects device_keys user_id mismatch with M_INVALID_PARAM', async () => {
    const env = makeEnv();
    const res = await request(
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload({ user_id: OTHER }) }),
      env
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
    expect(String((res.body as { error: string }).error)).toContain('must match');
  });

  it('rejects device_keys device_id mismatch with M_INVALID_PARAM', async () => {
    const env = makeEnv();
    const res = await request(
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload({ device_id: 'OTHERDEV' }) }),
      env
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('happy upload writes DO + DEVICE_KEYS KV + recordKeyChange', async () => {
    const env = makeEnv();
    const payload = deviceKeysPayload();
    const res = await request(
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: payload }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ one_time_key_counts: {} });
    expect(env._userKeys.deviceKeys[USER][DEVICE]).toMatchObject({
      user_id: USER,
      device_id: DEVICE,
    });
    const kvKey = `device:${USER}:${DEVICE}`;
    expect(env._deviceKv.data[kvKey]).toBeTruthy();
    expect(JSON.parse(env._deviceKv.data[kvKey])).toMatchObject({ device_id: DEVICE });
    expect(env._db.changes).toHaveLength(1);
    expect(env._db.changes[0]).toMatchObject({
      user_id: USER,
      device_id: DEVICE,
      change_type: 'update',
    });
  });

  it('queues m.device_list_update EDU to remote servers only', async () => {
    const edus: EduCapture[] = [];
    const env = makeEnv({ federation: createFederationDO(edus) });
    await request(
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload() }),
      env
    );
    expect(edus).toHaveLength(1);
    expect(edus[0]).toMatchObject({
      destination: REMOTE,
      edu_type: 'm.device_list_update',
      content: {
        user_id: USER,
        device_id: DEVICE,
        deleted: false,
        device_display_name: 'Alice Phone',
      },
    });
    expect(edus[0].content.keys).toMatchObject({ device_id: DEVICE });
  });

  it('swallows federation EDU failures without failing upload', async () => {
    const env = makeEnv({
      federation: createFederationDO([], { throwOnSend: true }),
    });
    const res = await request(
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload() }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ one_time_key_counts: {} });
  });

  it('uploads one_time_keys into KV+D1 and returns counts', async () => {
    const env = makeEnv();
    const res = await request(
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        one_time_keys: {
          'signed_curve25519:AAAA': { key: 'otk1', signatures: {} },
          'signed_curve25519:BBBB': { key: 'otk2', signatures: {} },
        },
      }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_key_counts: { signed_curve25519: 2 },
    });
    const stored = JSON.parse(env._otkKv.data[`otk:${USER}:${DEVICE}`]) as Record<
      string,
      { keyId: string; claimed: boolean }[]
    >;
    expect(stored.signed_curve25519).toHaveLength(2);
    expect(stored.signed_curve25519.every((k) => !k.claimed)).toBe(true);
    expect(env._db.oneTimeKeys).toHaveLength(2);
  });

  it('replaces existing OTK with same keyId and recounts unclaimed', async () => {
    const otkKv = mockKv({
      [`otk:${USER}:${DEVICE}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:AAAA', keyData: { key: 'old' }, claimed: true },
        ],
      }),
    });
    const env = makeEnv({ oneTimeKeys: otkKv });
    const res = await request(
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        one_time_keys: {
          'signed_curve25519:AAAA': { key: 'new' },
          'signed_curve25519:CCCC': { key: 'c' },
        },
      }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_key_counts: { signed_curve25519: 2 },
    });
    const stored = JSON.parse(otkKv.data[`otk:${USER}:${DEVICE}`]) as {
      signed_curve25519: { keyId: string; keyData: { key: string }; claimed: boolean }[];
    };
    expect(stored.signed_curve25519.find((k) => k.keyId.endsWith('AAAA'))?.keyData.key).toBe(
      'new'
    );
    expect(stored.signed_curve25519.find((k) => k.keyId.endsWith('AAAA'))?.claimed).toBe(false);
  });

  it('returns existing OTK counts when no one_time_keys in body', async () => {
    const otkKv = mockKv({
      [`otk:${USER}:${DEVICE}`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:1', keyData: {}, claimed: false },
          { keyId: 'signed_curve25519:2', keyData: {}, claimed: true },
        ],
        curve25519: [{ keyId: 'curve25519:x', keyData: {}, claimed: false }],
      }),
    });
    const env = makeEnv({ oneTimeKeys: otkKv });
    const res = await request(
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {}),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_key_counts: { signed_curve25519: 1, curve25519: 1 },
    });
  });

  it('inserts fallback_keys into D1', async () => {
    const env = makeEnv();
    const res = await request(
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        fallback_keys: {
          'signed_curve25519:FALLBACK': { key: 'fb', signatures: {} },
        },
      }),
      env
    );
    expect(res.status).toBe(200);
    expect(env._db.fallbackKeys).toHaveLength(1);
    expect(env._db.fallbackKeys[0]).toMatchObject({
      user_id: USER,
      device_id: DEVICE,
      algorithm: 'signed_curve25519',
      key_id: 'signed_curve25519:FALLBACK',
      used: 0,
    });
  });

  it('empty upload without keys returns empty counts object', async () => {
    const env = makeEnv();
    const res = await request('/_matrix/client/v3/keys/upload', jsonInit('POST', {}), env);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ one_time_key_counts: {} });
  });
});

// ---------------------------------------------------------------------------
// POST /keys/query
// ---------------------------------------------------------------------------

describe('POST /_matrix/client/v3/keys/query', () => {
  it('returns M_BAD_JSON for invalid JSON', async () => {
    const env = makeEnv();
    const res = await request(
      '/_matrix/client/v3/keys/query',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: 'nope',
      },
      env
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('empty device_keys map still returns empty result shells', async () => {
    const env = makeEnv();
    const res = await request(
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: {} }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      device_keys: {},
      master_keys: {},
      self_signing_keys: {},
      user_signing_keys: {},
      failures: {},
    });
  });

  it('missing device_keys field returns empty shells', async () => {
    const env = makeEnv();
    const res = await request('/_matrix/client/v3/keys/query', jsonInit('POST', {}), env);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ device_keys: {}, failures: {} });
  });

  it('queries all devices when device list empty/absent', async () => {
    const userKeys = createUserKeysDO({
      deviceKeys: {
        [USER]: {
          [DEVICE]: deviceKeysPayload(),
          DEVICEB: { ...deviceKeysPayload(), device_id: 'DEVICEB' },
        },
      },
      crossSigning: {
        [USER]: {
          master: masterKey(),
          self_signing: selfSigningKey(),
          user_signing: userSigningKey(),
        },
      },
    });
    const env = makeEnv({ userKeys });
    const res = await request(
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [] } }),
      env
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      device_keys: Record<string, Record<string, unknown>>;
      master_keys: Record<string, unknown>;
      self_signing_keys: Record<string, unknown>;
      user_signing_keys: Record<string, unknown>;
    };
    expect(Object.keys(body.device_keys[USER]).sort()).toEqual(['DEVICEA', 'DEVICEB']);
    expect(body.master_keys[USER]).toMatchObject({ usage: ['master'] });
    expect(body.self_signing_keys[USER]).toMatchObject({ usage: ['self_signing'] });
    expect(body.user_signing_keys[USER]).toMatchObject({ usage: ['user_signing'] });
  });

  it('queries specific devices only', async () => {
    const userKeys = createUserKeysDO({
      deviceKeys: {
        [USER]: {
          [DEVICE]: deviceKeysPayload(),
          DEVICEB: { device_id: 'DEVICEB' },
        },
      },
    });
    const env = makeEnv({ userKeys });
    const res = await request(
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } }),
      env
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_keys: Record<string, Record<string, unknown>> };
    expect(Object.keys(body.device_keys[USER])).toEqual([DEVICE]);
  });

  it('merges cross_signing_signatures from D1 into device keys', async () => {
    const userKeys = createUserKeysDO({
      deviceKeys: {
        [USER]: {
          [DEVICE]: {
            ...deviceKeysPayload(),
            signatures: { [USER]: { [`ed25519:${DEVICE}`]: 'devSig' } },
          },
        },
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
    const env = makeEnv({ userKeys, db });
    const res = await request(
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } }),
      env
    );
    const body = res.body as {
      device_keys: Record<string, Record<string, { signatures: Record<string, Record<string, string>> }>>;
    };
    expect(body.device_keys[USER][DEVICE].signatures[USER]['ed25519:master']).toBe('crossSig');
    expect(body.device_keys[USER][DEVICE].signatures[USER][`ed25519:${DEVICE}`]).toBe('devSig');
  });

  it('returns user_signing only when querying own keys', async () => {
    const userKeys = createUserKeysDO({
      crossSigning: {
        [USER]: {
          master: masterKey(),
          user_signing: userSigningKey(),
        },
        [OTHER]: {
          master: { user_id: OTHER, keys: { 'ed25519:m': 'bobM' } },
          user_signing: { user_id: OTHER, keys: { 'ed25519:u': 'bobU' } },
        },
      },
      deviceKeys: {
        [USER]: {},
        [OTHER]: { DEV1: { device_id: 'DEV1' } },
      },
    });
    const env = makeEnv({ userKeys });
    const res = await request(
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [], [OTHER]: [] } }),
      env
    );
    const body = res.body as {
      user_signing_keys: Record<string, unknown>;
      master_keys: Record<string, unknown>;
    };
    expect(body.user_signing_keys[USER]).toBeTruthy();
    expect(body.user_signing_keys[OTHER]).toBeUndefined();
    expect(body.master_keys[OTHER]).toBeTruthy();
  });

  it('skips null device key entries from DO', async () => {
    const userKeys = createUserKeysDO({
      deviceKeys: { [USER]: { [DEVICE]: deviceKeysPayload() } },
    });
    // Specific device miss returns null
    const env = makeEnv({ userKeys });
    const res = await request(
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: ['MISSING'] } }),
      env
    );
    const body = res.body as { device_keys: Record<string, Record<string, unknown>> };
    expect(body.device_keys[USER]).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// POST /keys/claim
// ---------------------------------------------------------------------------

describe('POST /_matrix/client/v3/keys/claim', () => {
  it('returns M_BAD_JSON for invalid JSON', async () => {
    const env = makeEnv();
    const res = await request(
      '/_matrix/client/v3/keys/claim',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: '{',
      },
      env
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('claims first unclaimed OTK from KV and marks claimed in KV+D1', async () => {
    const otkKv = mockKv({
      [`otk:${OTHER}:DEV1`]: JSON.stringify({
        signed_curve25519: [
          { keyId: 'signed_curve25519:A', keyData: { key: 'a' }, claimed: true },
          { keyId: 'signed_curve25519:B', keyData: { key: 'b' }, claimed: false },
        ],
      }),
    });
    const db = createKeysDb({
      oneTimeKeys: [
        {
          id: 1,
          user_id: OTHER,
          device_id: 'DEV1',
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:B',
          key_data: '{"key":"b"}',
          claimed: 0,
        },
      ],
    });
    const env = makeEnv({ oneTimeKeys: otkKv, db });
    const res = await request(
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [OTHER]: { DEV1: 'signed_curve25519' } },
      }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: {
        [OTHER]: { DEV1: { 'signed_curve25519:B': { key: 'b' } } },
      },
      failures: {},
    });
    const stored = JSON.parse(otkKv.data[`otk:${OTHER}:DEV1`]) as {
      signed_curve25519: { keyId: string; claimed: boolean }[];
    };
    expect(stored.signed_curve25519.find((k) => k.keyId.endsWith(':B'))?.claimed).toBe(true);
    expect(db.oneTimeKeys[0].claimed).toBe(1);
  });

  it('falls back to D1 legacy OTK when KV has none unclaimed', async () => {
    const db = createKeysDb({
      oneTimeKeys: [
        {
          id: 9,
          user_id: OTHER,
          device_id: 'DEV1',
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:LEG',
          key_data: JSON.stringify({ key: 'legacy' }),
          claimed: 0,
        },
      ],
    });
    const env = makeEnv({ db });
    const res = await request(
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [OTHER]: { DEV1: 'signed_curve25519' } },
      }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: {
        [OTHER]: { DEV1: { 'signed_curve25519:LEG': { key: 'legacy' } } },
      },
      failures: {},
    });
    expect(db.oneTimeKeys[0].claimed).toBe(1);
  });

  it('uses fallback_keys with fallback:true when no OTKs remain', async () => {
    const db = createKeysDb({
      fallbackKeys: [
        {
          user_id: OTHER,
          device_id: 'DEV1',
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:FB',
          key_data: JSON.stringify({ key: 'fallbackKey', signatures: { x: 1 } }),
          used: 0,
        },
      ],
    });
    const env = makeEnv({ db });
    const res = await request(
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [OTHER]: { DEV1: 'signed_curve25519' } },
      }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: {
        [OTHER]: {
          DEV1: {
            'signed_curve25519:FB': {
              key: 'fallbackKey',
              signatures: { x: 1 },
              fallback: true,
            },
          },
        },
      },
      failures: {},
    });
    expect(db.fallbackKeys[0].used).toBe(1);
  });

  it('returns empty claim map when nothing available', async () => {
    const env = makeEnv();
    const res = await request(
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [OTHER]: { DEV1: 'signed_curve25519' } },
      }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      one_time_keys: { [OTHER]: {} },
      failures: {},
    });
  });

  it('missing one_time_keys field returns empty shells', async () => {
    const env = makeEnv();
    const res = await request('/_matrix/client/v3/keys/claim', jsonInit('POST', {}), env);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ one_time_keys: {}, failures: {} });
  });
});

// ---------------------------------------------------------------------------
// GET /keys/changes
// ---------------------------------------------------------------------------

describe('GET /_matrix/client/v3/keys/changes', () => {
  it('requires from and to query params', async () => {
    const env = makeEnv();
    const missingBoth = await request('/_matrix/client/v3/keys/changes', {}, env);
    expect(missingBoth.status).toBe(400);
    expect(missingBoth.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });

    const missingTo = await request('/_matrix/client/v3/keys/changes?from=1', {}, env);
    expect(missingTo.status).toBe(400);
    expect(missingTo.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });

    const missingFrom = await request('/_matrix/client/v3/keys/changes?to=2', {}, env);
    expect(missingFrom.status).toBe(400);
  });

  it('splits update changes into changed and delete into left', async () => {
    const db = createKeysDb({
      changeQueryResults: [
        { user_id: OTHER, change_type: 'update' },
        { user_id: '@carol:example.com', change_type: 'delete' },
      ],
    });
    const env = makeEnv({ db });
    const res = await request('/_matrix/client/v3/keys/changes?from=0&to=10', {}, env);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      changed: [OTHER],
      left: ['@carol:example.com'],
    });
  });

  it('dedupes repeated user ids in changed/left', async () => {
    const db = createKeysDb({
      changeQueryResults: [
        { user_id: OTHER, change_type: 'update' },
        { user_id: OTHER, change_type: 'update' },
        { user_id: OTHER, change_type: 'delete' },
        { user_id: OTHER, change_type: 'delete' },
      ],
    });
    const env = makeEnv({ db });
    const res = await request('/_matrix/client/v3/keys/changes?from=1&to=99', {}, env);
    expect(res.body).toEqual({
      changed: [OTHER],
      left: [OTHER],
    });
  });

  it('filters by stream_position range via SQL stub args', async () => {
    const db = createKeysDb({
      changes: [
        { user_id: OTHER, device_id: 'D', change_type: 'update', stream_position: 5 },
        { user_id: '@z:example.com', device_id: 'D', change_type: 'update', stream_position: 15 },
      ],
    });
    const env = makeEnv({ db });
    const res = await request('/_matrix/client/v3/keys/changes?from=0&to=10', {}, env);
    expect(res.body).toEqual({ changed: [OTHER], left: [] });
  });

  it('non-numeric from defaults to 0; empty results when none in range', async () => {
    const db = createKeysDb({ changes: [] });
    const env = makeEnv({ db });
    const res = await request('/_matrix/client/v3/keys/changes?from=abc&to=5', {}, env);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ changed: [], left: [] });
  });
});

// ---------------------------------------------------------------------------
// POST /keys/device_signing/upload
// ---------------------------------------------------------------------------

describe('POST /_matrix/client/v3/keys/device_signing/upload', () => {
  it('returns M_BAD_JSON for invalid JSON', async () => {
    const env = makeEnv();
    const res = await request(
      '/_matrix/client/v3/keys/device_signing/upload',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: 'x',
      },
      env
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('first upload skips UIA (MSC3967) and stores DO+D1+CROSS_SIGNING_KEYS', async () => {
    const env = makeEnv({ db: createKeysDb({ crossSigningCount: 0 }) });
    const res = await request(
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: masterKey(),
        self_signing_key: selfSigningKey(),
        user_signing_key: userSigningKey(),
      }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(env._userKeys.crossSigning[USER]).toMatchObject({
      master: masterKey(),
      self_signing: selfSigningKey(),
      user_signing: userSigningKey(),
    });
    expect(env._db.crossSigningKeys.map((k) => k.key_type).sort()).toEqual([
      'master',
      'self_signing',
      'user_signing',
    ]);
    expect(JSON.parse(env._csKv.data[`user:${USER}`])).toMatchObject({
      master: masterKey(),
    });
    expect(env._db.changes.some((c) => c.change_type === 'update')).toBe(true);
  });

  it('existing keys without auth → 401 password flow when user has password', async () => {
    const db = createKeysDb({
      crossSigningCount: 1,
      users: new Map([[USER, { password_hash: 'mockok:secret' }]]),
    });
    const env = makeEnv({ db });
    const res = await request(
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKey() }),
      env
    );
    expect(res.status).toBe(401);
    const body = res.body as {
      flows: Array<{ stages: string[] }>;
      session: string;
      params: Record<string, unknown>;
    };
    expect(body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(body.session).toBeTruthy();
    expect(env._cache.data[`uia_session:${body.session}`]).toBeTruthy();
  });

  it('existing keys without auth → 401 OIDC flows for OIDC users', async () => {
    const db = createKeysDb({
      crossSigningCount: 2,
      idpLinkCounts: new Map([[USER, 1]]),
    });
    const env = makeEnv({ db });
    const res = await request(
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKey() }),
      env
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
      '/oauth/authorize/uia?session='
    );
    expect(body.params['m.oauth'].url).toContain(body.session);
  });

  it('existing keys: OIDC+password offers all three flows', async () => {
    const db = createKeysDb({
      crossSigningCount: 1,
      idpLinkCounts: new Map([[USER, 1]]),
      users: new Map([[USER, { password_hash: 'mockok:pw' }]]),
    });
    const env = makeEnv({ db });
    const res = await request(
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { self_signing_key: selfSigningKey() }),
      env
    );
    expect(res.status).toBe(401);
    const body = res.body as { flows: Array<{ stages: string[] }> };
    expect(body.flows).toEqual([
      { stages: ['org.matrix.cross_signing_reset'] },
      { stages: ['m.oauth'] },
      { stages: ['m.login.password'] },
    ]);
  });

  it('password auth success replaces keys', async () => {
    const db = createKeysDb({
      crossSigningCount: 1,
      users: new Map([[USER, { password_hash: 'mockok:correct' }]]),
    });
    const env = makeEnv({ db });
    const res = await request(
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: masterKey(),
        auth: { type: 'm.login.password', password: 'correct' },
      }),
      env
    );
    expect(res.status).toBe(200);
    expect(env._userKeys.crossSigning[USER]?.master).toMatchObject(masterKey());
    expect(verifyPassword).toHaveBeenCalled();
  });

  it('password auth fail → 403 Invalid password', async () => {
    const db = createKeysDb({
      crossSigningCount: 1,
      users: new Map([[USER, { password_hash: 'mockok:correct' }]]),
    });
    const env = makeEnv({ db });
    const res = await request(
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: masterKey(),
        auth: { type: 'm.login.password', password: 'wrong' },
      }),
      env
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN', error: 'Invalid password' });
  });

  it('password auth with no stored hash → 403', async () => {
    const db = createKeysDb({ crossSigningCount: 1, users: new Map() });
    const env = makeEnv({ db });
    const res = await request(
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: masterKey(),
        auth: { type: 'm.login.password', password: 'x' },
      }),
      env
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'No password set for user' });
  });

  it('password auth missing auth.password → M_MISSING_PARAM', async () => {
    const db = createKeysDb({
      crossSigningCount: 1,
      users: new Map([[USER, { password_hash: 'mockok:x' }]]),
    });
    const env = makeEnv({ db });
    const res = await request(
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: masterKey(),
        auth: { type: 'm.login.password' },
      }),
      env
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('OIDC session missing → 401 M_UNKNOWN', async () => {
    const db = createKeysDb({
      crossSigningCount: 1,
      idpLinkCounts: new Map([[USER, 1]]),
    });
    const env = makeEnv({ db });
    const res = await request(
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: masterKey(),
        auth: { type: 'org.matrix.cross_signing_reset', session: 'gone' },
      }),
      env
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      errcode: 'M_UNKNOWN',
      error: 'UIA session not found or expired',
    });
  });

  it('OIDC session without completed_stages → 401 M_UNAUTHORIZED', async () => {
    const cache = mockKv({
      'uia_session:sess1': JSON.stringify({
        user_id: USER,
        completed_stages: [],
      }),
    });
    const db = createKeysDb({
      crossSigningCount: 1,
      idpLinkCounts: new Map([[USER, 1]]),
    });
    const env = makeEnv({ db, cache });
    const res = await request(
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: masterKey(),
        auth: { type: 'm.oauth', session: 'sess1' },
      }),
      env
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ errcode: 'M_UNAUTHORIZED' });
  });

  it('OIDC approved session stores keys and deletes UIA session', async () => {
    const cache = mockKv({
      'uia_session:ok': JSON.stringify({
        user_id: USER,
        completed_stages: ['org.matrix.cross_signing_reset'],
      }),
    });
    const db = createKeysDb({
      crossSigningCount: 1,
      idpLinkCounts: new Map([[USER, 1]]),
    });
    const env = makeEnv({ db, cache });
    const res = await request(
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: masterKey(),
        auth: { type: 'org.matrix.cross_signing_reset', session: 'ok' },
      }),
      env
    );
    expect(res.status).toBe(200);
    expect(cache.data['uia_session:ok']).toBeUndefined();
    expect(cache.deletes).toContain('uia_session:ok');
    expect(env._csKv.data[`user:${USER}`]).toBeTruthy();
  });

  it('OIDC auth missing session param → M_MISSING_PARAM', async () => {
    const db = createKeysDb({ crossSigningCount: 1 });
    const env = makeEnv({ db });
    const res = await request(
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: masterKey(),
        auth: { type: 'm.login.sso' },
      }),
      env
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('OIDC session user mismatch → 403', async () => {
    const cache = mockKv({
      'uia_session:x': JSON.stringify({
        user_id: OTHER,
        completed_stages: ['m.login.token'],
      }),
    });
    const db = createKeysDb({ crossSigningCount: 1 });
    const env = makeEnv({ db, cache });
    const res = await request(
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: masterKey(),
        auth: { type: 'm.login.token', session: 'x' },
      }),
      env
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Session user mismatch' });
  });

  it('unknown auth type → M_UNRECOGNIZED', async () => {
    const db = createKeysDb({ crossSigningCount: 1 });
    const env = makeEnv({ db });
    const res = await request(
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', {
        master_key: masterKey(),
        auth: { type: 'm.login.email.request_token' },
      }),
      env
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_UNRECOGNIZED' });
  });

  it('allows upload when SSSS missing (bootstrap path)', async () => {
    const env = makeEnv({ db: createKeysDb({ crossSigningCount: 0 }) });
    const res = await request(
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKey() }),
      env
    );
    expect(res.status).toBe(200);
  });

  it('reads SSSS from ACCOUNT_DATA KV when present', async () => {
    const accountData = mockKv({
      [`global:${USER}:m.secret_storage.default_key`]: JSON.stringify({ key: 'ssk1' }),
    });
    const env = makeEnv({
      db: createKeysDb({ crossSigningCount: 0 }),
      accountData,
    });
    const res = await request(
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKey() }),
      env
    );
    expect(res.status).toBe(200);
  });

  it('falls back to D1 account_data for SSSS check', async () => {
    const db = createKeysDb({
      crossSigningCount: 0,
      accountData: new Map([
        [USER, JSON.stringify({ key: 'from-d1' })],
      ]),
    });
    const env = makeEnv({ db });
    const res = await request(
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { self_signing_key: selfSigningKey() }),
      env
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /keys/signatures/upload
// ---------------------------------------------------------------------------

describe('POST /_matrix/client/v3/keys/signatures/upload', () => {
  it('returns M_BAD_JSON for invalid JSON', async () => {
    const env = makeEnv();
    const res = await request(
      '/_matrix/client/v3/keys/signatures/upload',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: 'bad',
      },
      env
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('stores signatures in D1 and merges into device key DO+KV', async () => {
    const existing = deviceKeysPayload();
    const userKeys = createUserKeysDO({
      deviceKeys: { [USER]: { [DEVICE]: { ...existing } } },
    });
    const env = makeEnv({ userKeys });
    const signed = {
      ...existing,
      signatures: {
        [USER]: {
          [`ed25519:${DEVICE}`]: 'devSig',
          'ed25519:master': 'newCrossSig',
        },
      },
    };
    const res = await request(
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', { [USER]: { [DEVICE]: signed } }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ failures: {} });
    expect(env._db.signatures.some((s) => s.signature === 'newCrossSig')).toBe(true);
    expect(
      (env._userKeys.deviceKeys[USER][DEVICE] as { signatures: Record<string, Record<string, string>> })
        .signatures[USER]['ed25519:master']
    ).toBe('newCrossSig');
    expect(env._deviceKv.data[`device:${USER}:${DEVICE}`]).toBeTruthy();
    expect(env._db.changes.length).toBeGreaterThan(0);
  });

  it('stores cross-signing key signatures without device_id', async () => {
    const env = makeEnv();
    const signedMaster = {
      ...masterKey(),
      signatures: {
        [USER]: { [`ed25519:${DEVICE}`]: 'sigOnMaster' },
      },
    };
    const res = await request(
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', { [USER]: { 'ed25519:master': signedMaster } }),
      env
    );
    expect(res.status).toBe(200);
    expect(env._db.signatures[0]).toMatchObject({
      user_id: USER,
      key_id: 'ed25519:master',
      signer_user_id: USER,
      signer_key_id: `ed25519:${DEVICE}`,
      signature: 'sigOnMaster',
    });
  });

  it('maps stubbed insert errors into failures map', async () => {
    const db = createKeysDb({ throwOnSignatureInsert: true });
    const env = makeEnv({ db });
    const res = await request(
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [USER]: {
          [DEVICE]: {
            device_id: DEVICE,
            signatures: { [USER]: { 'ed25519:master': 'x' } },
          },
        },
      }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      failures: {
        [USER]: {
          [DEVICE]: {
            errcode: 'M_UNKNOWN',
            error: 'Failed to store signature',
          },
        },
      },
    });
  });

  it('empty body returns empty failures', async () => {
    const env = makeEnv();
    const res = await request(
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {}),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ failures: {} });
  });

  it('device key missing in DO still stores D1 signatures', async () => {
    const env = makeEnv();
    const res = await request(
      '/_matrix/client/v3/keys/signatures/upload',
      jsonInit('POST', {
        [USER]: {
          MISSING: {
            device_id: 'MISSING',
            signatures: { [USER]: { 'ed25519:master': 'orphan' } },
          },
        },
      }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ failures: {} });
    expect(env._db.signatures[0].signature).toBe('orphan');
    expect(env._deviceKv.data[`device:${USER}:MISSING`]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// GET SSO redirect / callback / token submit
// ---------------------------------------------------------------------------

describe('GET /_matrix/client/v3/auth/m.login.sso/redirect', () => {
  it('missing session → 400 M_MISSING_PARAM', async () => {
    const env = makeEnv();
    const res = await request('/_matrix/client/v3/auth/m.login.sso/redirect', {}, env);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: 'Missing session parameter',
    });
  });

  it('missing UIA session → 404', async () => {
    const env = makeEnv();
    const res = await request(
      '/_matrix/client/v3/auth/m.login.sso/redirect?session=nosuch',
      {},
      env
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      errcode: 'M_UNKNOWN',
      error: 'UIA session not found or expired',
    });
  });

  it('success redirects to oauth/authorize with state=session', async () => {
    const cache = mockKv({
      'uia_session:s1': JSON.stringify({ user_id: USER, completed_stages: [] }),
    });
    const env = makeEnv({ cache });
    const res = await keys.request(
      'http://localhost/_matrix/client/v3/auth/m.login.sso/redirect?session=s1&redirectUrl=https://client.example/done',
      { redirect: 'manual' },
      env
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get('Location')!;
    expect(loc).toContain(`https://${SERVER}/oauth/authorize`);
    expect(loc).toContain('response_type=code');
    expect(loc).toContain('client_id=matrix-uia');
    expect(loc).toContain('state=s1');
    expect(loc).toContain('scope=openid');
    const stored = JSON.parse(cache.data['uia_session:s1']);
    expect(stored.redirect_url).toBe('https://client.example/done');
  });

  it('defaults redirect_url to callback when redirectUrl omitted', async () => {
    const cache = mockKv({
      'uia_session:s2': JSON.stringify({ user_id: USER }),
    });
    const env = makeEnv({ cache });
    await keys.request(
      'http://localhost/_matrix/client/v3/auth/m.login.sso/redirect?session=s2',
      { redirect: 'manual' },
      env
    );
    const stored = JSON.parse(cache.data['uia_session:s2']);
    expect(stored.redirect_url).toBe(
      `https://${SERVER}/_matrix/client/v3/auth/m.login.sso/callback`
    );
  });
});

describe('GET /_matrix/client/v3/auth/m.login.sso/callback', () => {
  it('error query → HTML error page', async () => {
    const env = makeEnv();
    const res = await request(
      '/_matrix/client/v3/auth/m.login.sso/callback?error=access_denied&error_description=Nope',
      {},
      env
    );
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain('SSO Authentication Failed');
    expect(String(res.body)).toContain('Nope');
  });

  it('missing state → HTML Invalid Request', async () => {
    const env = makeEnv();
    const res = await request(
      '/_matrix/client/v3/auth/m.login.sso/callback?code=abc',
      {},
      env
    );
    expect(String(res.body)).toContain('Invalid Request');
    expect(String(res.body)).toContain('Missing state parameter');
  });

  it('expired session → HTML Session Expired', async () => {
    const env = makeEnv();
    const res = await request(
      '/_matrix/client/v3/auth/m.login.sso/callback?code=abc&state=expired',
      {},
      env
    );
    expect(String(res.body)).toContain('Session Expired');
  });

  it('code success → HTML success + completed_stages includes m.login.sso', async () => {
    const cache = mockKv({
      'uia_session:good': JSON.stringify({
        user_id: USER,
        completed_stages: [],
        redirect_url: 'https://client/x',
      }),
    });
    const env = makeEnv({ cache });
    const res = await request(
      '/_matrix/client/v3/auth/m.login.sso/callback?code=authcode&state=good',
      {},
      env
    );
    expect(String(res.body)).toContain('Authentication Successful');
    expect(String(res.body)).toContain('Session: good');
    const stored = JSON.parse(cache.data['uia_session:good']);
    expect(stored.completed_stages).toContain('m.login.sso');
    expect(stored.sso_completed_at).toBeTypeOf('number');
  });

  it('no code and no error → Authentication Failed HTML', async () => {
    const cache = mockKv({
      'uia_session:st': JSON.stringify({ user_id: USER }),
    });
    const env = makeEnv({ cache });
    const res = await request(
      '/_matrix/client/v3/auth/m.login.sso/callback?state=st',
      {},
      env
    );
    expect(String(res.body)).toContain('Authentication Failed');
    expect(String(res.body)).toContain('No authorization code received');
  });

  it('does not duplicate m.login.sso in completed_stages', async () => {
    const cache = mockKv({
      'uia_session:dup': JSON.stringify({
        user_id: USER,
        completed_stages: ['m.login.sso'],
      }),
    });
    const env = makeEnv({ cache });
    await request(
      '/_matrix/client/v3/auth/m.login.sso/callback?code=c&state=dup',
      {},
      env
    );
    const stored = JSON.parse(cache.data['uia_session:dup']);
    expect(stored.completed_stages.filter((s: string) => s === 'm.login.sso')).toHaveLength(1);
  });
});

describe('POST /_matrix/client/v3/auth/m.login.token/submit', () => {
  it('returns M_BAD_JSON for invalid JSON', async () => {
    const env = makeEnv();
    const res = await request(
      '/_matrix/client/v3/auth/m.login.token/submit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: '{',
      },
      env
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('missing session → M_MISSING_PARAM', async () => {
    const env = makeEnv();
    const res = await request(
      '/_matrix/client/v3/auth/m.login.token/submit',
      jsonInit('POST', {}),
      env
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('expired session → 404', async () => {
    const env = makeEnv();
    const res = await request(
      '/_matrix/client/v3/auth/m.login.token/submit',
      jsonInit('POST', { session: 'gone' }),
      env
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      errcode: 'M_UNKNOWN',
      error: 'UIA session not found or expired',
    });
  });

  it('user mismatch → 403', async () => {
    const cache = mockKv({
      'uia_session:mm': JSON.stringify({ user_id: OTHER, completed_stages: [] }),
    });
    const env = makeEnv({ cache });
    const res = await request(
      '/_matrix/client/v3/auth/m.login.token/submit',
      jsonInit('POST', { session: 'mm' }),
      env
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Session user mismatch' });
  });

  it('success adds m.login.token to completed stages', async () => {
    const cache = mockKv({
      'uia_session:tok': JSON.stringify({ user_id: USER, completed_stages: [] }),
    });
    const env = makeEnv({ cache });
    const res = await request(
      '/_matrix/client/v3/auth/m.login.token/submit',
      jsonInit('POST', { session: 'tok' }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      completed: ['m.login.token'],
      session: 'tok',
    });
    const stored = JSON.parse(cache.data['uia_session:tok']);
    expect(stored.completed_stages).toContain('m.login.token');
    expect(stored.token_completed_at).toBeTypeOf('number');
  });

  it('idempotent when m.login.token already completed', async () => {
    const cache = mockKv({
      'uia_session:tok2': JSON.stringify({
        user_id: USER,
        completed_stages: ['m.login.token'],
      }),
    });
    const env = makeEnv({ cache });
    const res = await request(
      '/_matrix/client/v3/auth/m.login.token/submit',
      jsonInit('POST', { session: 'tok2' }),
      env
    );
    expect(res.status).toBe(200);
    const stored = JSON.parse(cache.data['uia_session:tok2']);
    expect(stored.completed_stages.filter((s: string) => s === 'm.login.token')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Integration-ish edges / TOKENMAXX extras
// ---------------------------------------------------------------------------

describe('keys routes TOKENMAXX edges after #97', () => {
  it('upload + query round-trip via shared UserKeys DO', async () => {
    const userKeys = createUserKeysDO();
    const env = makeEnv({ userKeys });
    await request(
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', { device_keys: deviceKeysPayload() }),
      env
    );
    const q = await request(
      '/_matrix/client/v3/keys/query',
      jsonInit('POST', { device_keys: { [USER]: [DEVICE] } }),
      env
    );
    expect(
      (q.body as { device_keys: Record<string, Record<string, { device_id: string }>> })
        .device_keys[USER][DEVICE].device_id
    ).toBe(DEVICE);
  });

  it('upload OTK then claim consumes it', async () => {
    const env = makeEnv();
    await request(
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        one_time_keys: { 'signed_curve25519:Z': { key: 'z' } },
      }),
      env
    );
    const claim = await request(
      '/_matrix/client/v3/keys/claim',
      jsonInit('POST', {
        one_time_keys: { [USER]: { [DEVICE]: 'signed_curve25519' } },
      }),
      env
    );
    expect(claim.body).toMatchObject({
      one_time_keys: { [USER]: { [DEVICE]: { 'signed_curve25519:Z': { key: 'z' } } } },
    });
    const recount = await request(
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {}),
      env
    );
    expect(recount.body).toEqual({ one_time_key_counts: { signed_curve25519: 0 } });
  });

  it('device_signing first upload records stream position progression', async () => {
    const db = createKeysDb({ streamPosition: 40, crossSigningCount: 0 });
    const env = makeEnv({ db });
    await request(
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKey() }),
      env
    );
    expect(db.streamPosition).toBe(41);
    expect(db.changes[0].stream_position).toBe(41);
  });

  it('fallback_keys replace on conflict resets used=0', async () => {
    const db = createKeysDb({
      fallbackKeys: [
        {
          user_id: USER,
          device_id: DEVICE,
          algorithm: 'signed_curve25519',
          key_id: 'signed_curve25519:OLD',
          key_data: '{"key":"old"}',
          used: 1,
        },
      ],
    });
    const env = makeEnv({ db });
    await request(
      '/_matrix/client/v3/keys/upload',
      jsonInit('POST', {
        fallback_keys: { 'signed_curve25519:NEW': { key: 'new' } },
      }),
      env
    );
    expect(db.fallbackKeys).toHaveLength(1);
    expect(db.fallbackKeys[0].key_id).toBe('signed_curve25519:NEW');
    expect(db.fallbackKeys[0].used).toBe(0);
  });

  it('SSO callback error without description uses error code as message', async () => {
    const env = makeEnv();
    const res = await request(
      '/_matrix/client/v3/auth/m.login.sso/callback?error=server_error',
      {},
      env
    );
    expect(String(res.body)).toContain('server_error');
  });

  it('UIA challenge stores session with type device_signing_upload and 300s TTL', async () => {
    const db = createKeysDb({
      crossSigningCount: 1,
      users: new Map([[USER, { password_hash: 'mockok:p' }]]),
    });
    const env = makeEnv({ db });
    const res = await request(
      '/_matrix/client/v3/keys/device_signing/upload',
      jsonInit('POST', { master_key: masterKey() }),
      env
    );
    const session = (res.body as { session: string }).session;
    const put = env._cache.puts.find((p) => p.key === `uia_session:${session}`);
    expect(put?.options?.expirationTtl).toBe(300);
    expect(JSON.parse(put!.value)).toMatchObject({
      user_id: USER,
      type: 'device_signing_upload',
      has_password: true,
      is_oidc_user: false,
    });
  });
});
