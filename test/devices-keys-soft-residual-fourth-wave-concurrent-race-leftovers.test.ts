/**
 * TOKENMAXX HEAVY leftovers after #293/#297 soft residual third-wave /
 * tip past #297 — residual *devices + keys* soft→*concurrent-race*
 * fourth-wave binds unsaturated by:
 *   #297/#293 third-wave (SSO callback HTML / token success / OAuth
 *        expired∥mismatch∥not-approved soft floods are *sequential*;
 *        only one SSO error∥success Promise.all pair; no Missing-state
 *        ∥ expired ∥ no-code ∥ Authentication Successful *quad* flood;
 *        no multi-auth-type soft-string barrier flood),
 *   #259 concurrent-race (TOCTOU/status; no exact soft errcode+error pins),
 *   #280 second-wave (SSO/token *errors* only).
 *
 * Gap table (why leftover after third-wave):
 *   SSO callback `Missing state parameter` ∥
 *     `The UIA session has expired. Please try again.` ∥
 *     `No authorization code received` ∥
 *     `Authentication Successful` + CACHE `m.login.sso` under flood
 *     | third-wave sequential + single error∥success pair
 *   device_signing OAuth UIA exact bodies
 *     (`UIA session not found or expired` /
 *      `Session user mismatch` /
 *      `Cross-signing reset not approved…`)
 *     under multi-auth-type Promise.all soft flood
 *     | third-wave one-shot triple only
 *   token/submit Missing session param exact ∥ success ∥ expired ∥ mismatch
 *     | third-wave success∥expired∥mismatch without missingParam
 *
 * Tests-only. Fixtures use example.com only. Reversible by deleting this file.
 * No invent-product / secrets / DNS. Skips room-cache (denary saturated).
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
    generateOpaqueId: vi.fn(async () => 'pinned-uia-session-tw'),
  };
});

import devicesApp from '../src/api/devices';
import keysApp from '../src/api/keys';
import { verifyPassword } from '../src/utils/crypto';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const SERVER = 'example.com';
const PASS = 's3cret';
const AUTH = { Authorization: 'Bearer test-token' };
const DEVICES = '/_matrix/client/v3/devices';
const DELETE_DEVICES = '/_matrix/client/v3/delete_devices';
const DEVICE_SIGNING = '/_matrix/client/v3/keys/device_signing/upload';
const SSO_REDIRECT = '/_matrix/client/v3/auth/m.login.sso/redirect';
const SSO_CALLBACK = '/_matrix/client/v3/auth/m.login.sso/callback';
const TOKEN_SUBMIT = '/_matrix/client/v3/auth/m.login.token/submit';

const CROSS_SIGNING_NOT_APPROVED = {
  errcode: 'M_UNAUTHORIZED',
  error: 'Cross-signing reset not approved. Please approve the request at the provided URL.',
} as const;

const UIA_EXPIRED = {
  errcode: 'M_UNKNOWN',
  error: 'UIA session not found or expired',
} as const;

const SESSION_MISMATCH = {
  errcode: 'M_FORBIDDEN',
  error: 'Session user mismatch',
} as const;

type DeviceRow = {
  device_id: string;
  user_id: string;
  display_name: string | null;
  last_seen_ts: number | null;
  last_seen_ip: string | null;
};

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };

type CrossSigningKeyRow = {
  user_id: string;
  key_type: string;
  key_id: string;
  key_data: string;
};

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

function createDevicesDb(opts: {
  devices?: DeviceRow[];
  passwordHash?: string | null;
  missingUser?: boolean;
  deleted?: string[];
} = {}) {
  const deviceRows = opts.devices ?? [];
  const passwordHash =
    opts.passwordHash === undefined ? `mockok:${PASS}` : opts.passwordHash;
  const missingUser = opts.missingUser ?? false;
  const deleted = opts.deleted ?? [];

  return {
    devices: deviceRows,
    deleted,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT password_hash FROM users')) {
                if (missingUser) return null as T;
                return { password_hash: passwordHash } as T;
              }
              if (
                sql.includes('FROM devices') &&
                sql.includes('device_id = ?') &&
                sql.includes('display_name')
              ) {
                const [userId, deviceId] = args as string[];
                const row = deviceRows.find(
                  (d) => d.user_id === userId && d.device_id === deviceId
                );
                if (!row) return null as T;
                return {
                  device_id: row.device_id,
                  display_name: row.display_name,
                  last_seen_ts: row.last_seen_ts,
                  last_seen_ip: row.last_seen_ip,
                } as T;
              }
              if (
                sql.includes('SELECT device_id FROM devices') &&
                sql.includes('device_id = ?')
              ) {
                const [userId, deviceId] = args as string[];
                const row = deviceRows.find(
                  (d) => d.user_id === userId && d.device_id === deviceId
                );
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
                return { success: true, meta: { changes: 0, last_row_id: 0 } };
              }
              if (sql.includes('DELETE FROM devices')) {
                deleted.push(String(args[1]));
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (
                sql.includes('DELETE FROM access_tokens') ||
                sql.includes('DELETE FROM device_keys')
              ) {
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              throw new Error(`Unhandled run() SQL: ${sql.slice(0, 140)}`);
            },
          };
        },
      };
    },
  };
}

type DevicesDb = ReturnType<typeof createDevicesDb>;

function devicesEnv(db: DevicesDb): Env {
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
  } as unknown as Env;
}

async function devicesRequest(
  db: DevicesDb,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  const res = await devicesApp.request(`http://localhost${path}`, init, devicesEnv(db));
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

function seedDevice(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    device_id: overrides.device_id ?? 'PHONE',
    user_id: overrides.user_id ?? USER,
    display_name: overrides.display_name ?? null,
    last_seen_ts: overrides.last_seen_ts ?? null,
    last_seen_ip: overrides.last_seen_ip ?? null,
  };
}

function createUserKeysStub() {
  const deviceKeys: Record<string, unknown> = {};
  const crossSigning: Record<string, unknown> = {};
  return {
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
      if (path === '/device-keys/get') {
        const deviceId = url.searchParams.get('device_id');
        if (deviceId) return Response.json(deviceKeys[deviceId] ?? null);
        return Response.json(deviceKeys);
      }
      if (path === '/device-keys/put') {
        const b = body as { device_id: string; keys: unknown };
        deviceKeys[b.device_id] = b.keys;
        return Response.json({ success: true });
      }
      if (path === '/cross-signing/get') return Response.json(crossSigning);
      if (path === '/cross-signing/put') {
        Object.assign(crossSigning, body as object);
        return Response.json({ success: true });
      }
      return new Response('not found', { status: 404 });
    },
  };
}

function createKeysDb(opts: {
  crossSigningKeys?: CrossSigningKeyRow[];
  passwordHashes?: Map<string, string | null>;
  idpLinkCounts?: Map<string, number>;
} = {}) {
  const crossSigningKeys = opts.crossSigningKeys ?? [];
  const passwordHashes = opts.passwordHashes ?? new Map<string, string | null>();
  const idpLinkCounts = opts.idpLinkCounts ?? new Map<string, number>();
  const streamPositions: Record<string, number> = { device_keys: 10 };

  return {
    crossSigningKeys,
    passwordHashes,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT position FROM stream_positions')) {
                const name = args[0] as string;
                return { position: streamPositions[name] ?? 1 } as T;
              }
              if (sql.includes('SELECT COUNT(*) as count FROM cross_signing_keys')) {
                const userId = args[0] as string;
                return {
                  count: crossSigningKeys.filter((k) => k.user_id === userId).length,
                } as T;
              }
              if (sql.includes('SELECT COUNT(*) as count FROM idp_user_links')) {
                const userId = args[0] as string;
                return { count: idpLinkCounts.get(userId) ?? 0 } as T;
              }
              if (sql.includes('SELECT password_hash FROM users')) {
                const userId = args[0] as string;
                if (!passwordHashes.has(userId)) return null as T;
                return { password_hash: passwordHashes.get(userId) ?? null } as T;
              }
              if (
                sql.includes('FROM account_data') &&
                sql.includes('m.secret_storage.default_key')
              ) {
                return null as T;
              }
              return null as T;
            },
            async all<T>() {
              if (
                sql.includes('FROM device_key_changes dkc') &&
                sql.includes('room_memberships')
              ) {
                return { results: [] as T[] };
              }
              if (
                sql.includes('FROM cross_signing_signatures') &&
                sql.includes('SELECT signer_user_id')
              ) {
                return { results: [] as T[] };
              }
              if (
                sql.includes('SUBSTR(rm2.user_id') &&
                sql.includes('room_memberships rm1')
              ) {
                return { results: [] as T[] };
              }
              return { results: [] as T[] };
            },
            async run() {
              if (sql.includes('UPDATE stream_positions SET position = position + 1')) {
                const name = args[0] as string;
                streamPositions[name] = (streamPositions[name] ?? 0) + 1;
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (
                sql.includes('INSERT INTO device_key_changes') ||
                sql.includes('INSERT INTO one_time_keys') ||
                sql.includes('INSERT INTO fallback_keys') ||
                sql.includes('INSERT INTO cross_signing_keys') ||
                sql.includes('INSERT INTO cross_signing_signatures')
              ) {
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              throw new Error(`Unhandled SQL in soft residual stub: ${sql.slice(0, 140)}`);
            },
          };
        },
      };
    },
  };
}

type KeysDb = ReturnType<typeof createKeysDb>;

function createKeysEnv(opts: {
  db?: KeysDb;
  cacheKv?: ReturnType<typeof mockKv>;
} = {}) {
  const db = opts.db ?? createKeysDb();
  const cacheKv = opts.cacheKv ?? mockKv();
  const userKeys = createUserKeysStub();
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
    DEVICE_KEYS: mockKv(),
    ONE_TIME_KEYS: mockKv(),
    CACHE: cacheKv,
    ACCOUNT_DATA: mockKv(),
    CROSS_SIGNING_KEYS: mockKv(),
    USER_KEYS: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => userKeys,
    },
    FEDERATION: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => ({
        fetch: async () => Response.json({ ok: true }),
      }),
    },
    _cache: cacheKv,
    _db: db,
    _userKeys: userKeys,
  } as unknown as Env & {
    _cache: ReturnType<typeof mockKv>;
    _db: KeysDb;
    _userKeys: ReturnType<typeof createUserKeysStub>;
  };
}

async function keysRequest(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{
  status: number;
  body: unknown;
  text: string;
  headers: Headers;
}> {
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
  return { status: res.status, body, text, headers: res.headers };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...AUTH },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function existingMasterKey(): CrossSigningKeyRow {
  return {
    user_id: USER,
    key_type: 'master',
    key_id: 'ed25519:master',
    key_data: '{}',
  };
}

function masterKeyBody(extra: Record<string, unknown> = {}) {
  return {
    master_key: {
      user_id: USER,
      usage: ['master'],
      keys: { 'ed25519:master': 'mk' },
    },
    ...extra,
  };
}

beforeEach(() => {
  vi.mocked(verifyPassword).mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SSO_MISSING_STATE = 'Missing state parameter';
const SSO_EXPIRED_BODY = 'The UIA session has expired. Please try again.';
const SSO_NO_CODE = 'No authorization code received';
const SSO_SUCCESS = 'Authentication Successful';
const TOKEN_MISSING_SESSION = {
  errcode: 'M_MISSING_PARAM',
  error: 'Missing required parameter: session',
} as const;

// ---------------------------------------------------------------------------
// SSO callback exact HTML quad flood under Promise.all (third-wave sequential)
// ---------------------------------------------------------------------------

describe('keys soft residual fourth-wave SSO callback quad race after #297', () => {
  it('Missing state ∥ expired ∥ no-code ∥ Authentication Successful under race', async () => {
    const cache = mockKv({
      'uia_session:race-ok': JSON.stringify({
        user_id: USER,
        completed_stages: [],
        redirect_url: 'https://client.example/done',
      }),
      'uia_session:race-nocode': JSON.stringify({
        user_id: USER,
        completed_stages: [],
      }),
    });
    const env = createKeysEnv({ cacheKv: cache });
    const results = await Promise.all([
      keysRequest(env, `${SSO_CALLBACK}?code=abc`),
      keysRequest(env, `${SSO_CALLBACK}?code=abc&state=gone`),
      keysRequest(env, `${SSO_CALLBACK}?state=race-nocode`),
      keysRequest(env, `${SSO_CALLBACK}?code=authcode&state=race-ok`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.some((r) => r.text.includes(SSO_MISSING_STATE))).toBe(true);
    expect(results.some((r) => r.text.includes('Invalid Request'))).toBe(true);
    expect(results.some((r) => r.text.includes(SSO_EXPIRED_BODY))).toBe(true);
    expect(results.some((r) => r.text.includes('Session Expired'))).toBe(true);
    expect(results.some((r) => r.text.includes(SSO_NO_CODE))).toBe(true);
    expect(results.some((r) => r.text.includes('Authentication Failed'))).toBe(true);
    expect(results.some((r) => r.text.includes(SSO_SUCCESS))).toBe(true);
    const session = JSON.parse(cache.data['uia_session:race-ok']);
    expect(session.completed_stages).toEqual(['m.login.sso']);
    expect(session.sso_completed_at).toEqual(expect.any(Number));
    const put = cache.puts.find((p) => p.key === 'uia_session:race-ok');
    expect(put!.options).toEqual({ expirationTtl: 300 });
    // soft sessions untouched
    expect(cache.data['uia_session:race-nocode']).toBeTruthy();
  });

  it('IdP error ∥ Missing state ∥ expired ∥ success under race', async () => {
    const cache = mockKv({
      'uia_session:ok2': JSON.stringify({
        user_id: USER,
        completed_stages: [],
      }),
    });
    const env = createKeysEnv({ cacheKv: cache });
    const results = await Promise.all([
      keysRequest(
        env,
        `${SSO_CALLBACK}?error=access_denied&error_description=Nope`
      ),
      keysRequest(env, `${SSO_CALLBACK}?code=x`),
      keysRequest(env, `${SSO_CALLBACK}?code=x&state=missing`),
      keysRequest(env, `${SSO_CALLBACK}?code=c&state=ok2`),
    ]);
    expect(results.some((r) => r.text.includes('SSO Authentication Failed'))).toBe(true);
    expect(results.some((r) => r.text.includes('Nope'))).toBe(true);
    expect(results.some((r) => r.text.includes(SSO_MISSING_STATE))).toBe(true);
    expect(results.some((r) => r.text.includes(SSO_EXPIRED_BODY))).toBe(true);
    expect(results.some((r) => r.text.includes(SSO_SUCCESS))).toBe(true);
  });

  for (let i = 0; i < 10; i++) {
    it(`SSO callback exact HTML quad flood-${i}`, async () => {
      const sid = `ok-${i}`;
      const nocode = `nc-${i}`;
      const cache = mockKv({
        [`uia_session:${sid}`]: JSON.stringify({
          user_id: USER,
          completed_stages: [],
        }),
        [`uia_session:${nocode}`]: JSON.stringify({
          user_id: USER,
          completed_stages: [],
        }),
      });
      const env = createKeysEnv({ cacheKv: cache });
      const results = await Promise.all([
        keysRequest(env, `${SSO_CALLBACK}?code=c-${i}`),
        keysRequest(env, `${SSO_CALLBACK}?code=c&state=gone-${i}`),
        keysRequest(env, `${SSO_CALLBACK}?state=${nocode}`),
        keysRequest(env, `${SSO_CALLBACK}?code=auth&state=${sid}`),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.some((r) => r.text.includes(SSO_MISSING_STATE))).toBe(true);
      expect(results.some((r) => r.text.includes(SSO_EXPIRED_BODY))).toBe(true);
      expect(results.some((r) => r.text.includes(SSO_NO_CODE))).toBe(true);
      expect(results.some((r) => r.text.includes(SSO_SUCCESS))).toBe(true);
      expect(JSON.parse(cache.data[`uia_session:${sid}`]).completed_stages).toEqual([
        'm.login.sso',
      ]);
    });
  }

  it('does not duplicate m.login.sso while soft siblings race', async () => {
    const cache = mockKv({
      'uia_session:dup': JSON.stringify({
        user_id: USER,
        completed_stages: ['m.login.sso'],
      }),
    });
    const env = createKeysEnv({ cacheKv: cache });
    const results = await Promise.all([
      keysRequest(env, `${SSO_CALLBACK}?code=a`),
      keysRequest(env, `${SSO_CALLBACK}?code=a&state=gone`),
      keysRequest(env, `${SSO_CALLBACK}?code=a&state=dup`),
      keysRequest(env, `${SSO_CALLBACK}?code=a&state=dup`),
    ]);
    expect(results.some((r) => r.text.includes(SSO_MISSING_STATE))).toBe(true);
    expect(results.some((r) => r.text.includes(SSO_EXPIRED_BODY))).toBe(true);
    expect(
      results.filter((r) => r.text.includes(SSO_SUCCESS)).length
    ).toBeGreaterThanOrEqual(1);
    const stages = JSON.parse(cache.data['uia_session:dup']).completed_stages.filter(
      (s: string) => s === 'm.login.sso'
    );
    expect(stages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// device_signing OAuth UIA exact soft strings under multi-auth-type race flood
// ---------------------------------------------------------------------------

describe('keys soft residual fourth-wave OAuth UIA soft flood after #297', () => {
  const authTypes = [
    'org.matrix.cross_signing_reset',
    'm.oauth',
    'm.login.oauth',
    'm.login.sso',
    'm.login.token',
  ] as const;

  it('five auth-types expired∥mismatch∥not-approved exact bodies under race', async () => {
    const cache = mockKv({
      'uia_session:mm': JSON.stringify({
        user_id: BOB,
        completed_stages: ['m.oauth'],
      }),
      'uia_session:pend': JSON.stringify({
        user_id: USER,
        completed_stages: [],
      }),
    });
    const env = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        idpLinkCounts: new Map([[USER, 1]]),
      }),
      cacheKv: cache,
    });
    const results = await Promise.all(
      authTypes.flatMap((authType) => [
        keysRequest(
          env,
          DEVICE_SIGNING,
          jsonInit('POST', masterKeyBody({
            auth: { type: authType, session: `gone-${authType}` },
          }))
        ),
        keysRequest(
          env,
          DEVICE_SIGNING,
          jsonInit('POST', masterKeyBody({
            auth: { type: authType, session: 'mm' },
          }))
        ),
        keysRequest(
          env,
          DEVICE_SIGNING,
          jsonInit('POST', masterKeyBody({
            auth: { type: authType, session: 'pend' },
          }))
        ),
      ])
    );
    expect(results.length).toBe(15);
    const expired = results.filter((r) => {
      const b = r.body as { error?: string };
      return b?.error === UIA_EXPIRED.error;
    });
    const mismatch = results.filter((r) => {
      const b = r.body as { error?: string };
      return b?.error === SESSION_MISMATCH.error;
    });
    const pending = results.filter((r) => {
      const b = r.body as { error?: string };
      return b?.error === CROSS_SIGNING_NOT_APPROVED.error;
    });
    expect(expired.length).toBe(5);
    expect(mismatch.length).toBe(5);
    expect(pending.length).toBe(5);
    for (const r of expired) {
      expect(r.status).toBe(401);
      expect(r.body).toEqual(UIA_EXPIRED);
    }
    for (const r of mismatch) {
      expect(r.status).toBe(403);
      expect(r.body).toEqual(SESSION_MISMATCH);
    }
    for (const r of pending) {
      expect(r.status).toBe(401);
      expect(r.body).toEqual(CROSS_SIGNING_NOT_APPROVED);
    }
    // soft paths must not delete pending/mm sessions
    expect(cache.data['uia_session:mm']).toBeTruthy();
    expect(cache.data['uia_session:pend']).toBeTruthy();
  });

  for (let i = 0; i < 8; i++) {
    it(`OAuth UIA expired∥mismatch∥not-approved soft flood-${i}`, async () => {
      const authType = authTypes[i % authTypes.length];
      const cache = mockKv({
        [`uia_session:mm-${i}`]: JSON.stringify({
          user_id: BOB,
          completed_stages: ['org.matrix.cross_signing_reset'],
        }),
        [`uia_session:pend-${i}`]: JSON.stringify({
          user_id: USER,
          completed_stages: [],
        }),
      });
      const env = createKeysEnv({
        db: createKeysDb({
          crossSigningKeys: [existingMasterKey()],
          idpLinkCounts: new Map([[USER, 1]]),
        }),
        cacheKv: cache,
      });
      const [expired, mismatch, pending] = await Promise.all([
        keysRequest(
          env,
          DEVICE_SIGNING,
          jsonInit('POST', masterKeyBody({
            auth: { type: authType, session: `gone-${i}` },
          }))
        ),
        keysRequest(
          env,
          DEVICE_SIGNING,
          jsonInit('POST', masterKeyBody({
            auth: { type: authType, session: `mm-${i}` },
          }))
        ),
        keysRequest(
          env,
          DEVICE_SIGNING,
          jsonInit('POST', masterKeyBody({
            auth: { type: authType, session: `pend-${i}` },
          }))
        ),
      ]);
      expect(expired.body).toEqual(UIA_EXPIRED);
      expect(mismatch.body).toEqual(SESSION_MISMATCH);
      expect(pending.body).toEqual(CROSS_SIGNING_NOT_APPROVED);
    });
  }

  it('approved replace ∥ expired ∥ mismatch ∥ not-approved under race', async () => {
    const cache = mockKv({
      'uia_session:ok': JSON.stringify({
        user_id: USER,
        completed_stages: ['m.oauth'],
      }),
      'uia_session:mm': JSON.stringify({
        user_id: BOB,
        completed_stages: ['m.oauth'],
      }),
      'uia_session:pend': JSON.stringify({
        user_id: USER,
        completed_stages: [],
      }),
    });
    const env = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        idpLinkCounts: new Map([[USER, 1]]),
      }),
      cacheKv: cache,
    });
    const [ok, expired, mismatch, pending] = await Promise.all([
      keysRequest(
        env,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'm.oauth', session: 'ok' },
        }))
      ),
      keysRequest(
        env,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'm.login.sso', session: 'gone' },
        }))
      ),
      keysRequest(
        env,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'm.login.token', session: 'mm' },
        }))
      ),
      keysRequest(
        env,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'org.matrix.cross_signing_reset', session: 'pend' },
        }))
      ),
    ]);
    expect(ok.status).toBe(200);
    expect(expired.body).toEqual(UIA_EXPIRED);
    expect(mismatch.body).toEqual(SESSION_MISMATCH);
    expect(pending.body).toEqual(CROSS_SIGNING_NOT_APPROVED);
    // approved session cleaned up
    expect(cache.data['uia_session:ok']).toBeUndefined();
    expect(cache.deletes).toContain('uia_session:ok');
  });
});

// ---------------------------------------------------------------------------
// token/submit Missing session exact ∥ success ∥ expired ∥ mismatch
// ---------------------------------------------------------------------------

describe('keys soft residual fourth-wave token/submit missingParam race after #297', () => {
  it('missing session param ∥ success ∥ expired ∥ mismatch under race', async () => {
    const cache = mockKv({
      'uia_session:race-ok': JSON.stringify({
        user_id: USER,
        completed_stages: [],
      }),
      'uia_session:race-mm': JSON.stringify({
        user_id: BOB,
        completed_stages: [],
      }),
    });
    const env = createKeysEnv({ cacheKv: cache });
    const [missing, ok, expired, mismatch] = await Promise.all([
      keysRequest(env, TOKEN_SUBMIT, jsonInit('POST', {})),
      keysRequest(env, TOKEN_SUBMIT, jsonInit('POST', { session: 'race-ok' })),
      keysRequest(env, TOKEN_SUBMIT, jsonInit('POST', { session: 'gone' })),
      keysRequest(env, TOKEN_SUBMIT, jsonInit('POST', { session: 'race-mm' })),
    ]);
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual(TOKEN_MISSING_SESSION);
    expect(ok.body).toEqual({
      completed: ['m.login.token'],
      session: 'race-ok',
    });
    expect(expired.body).toEqual(UIA_EXPIRED);
    expect(mismatch.body).toEqual(SESSION_MISMATCH);
    expect(JSON.parse(cache.data['uia_session:race-ok']).completed_stages).toEqual([
      'm.login.token',
    ]);
  });

  for (let i = 0; i < 8; i++) {
    it(`token missingParam ∥ success ∥ expired flood-${i}`, async () => {
      const sid = `tok-${i}`;
      const cache = mockKv({
        [`uia_session:${sid}`]: JSON.stringify({
          user_id: USER,
          completed_stages: [],
        }),
      });
      const env = createKeysEnv({ cacheKv: cache });
      const [missing, ok, expired] = await Promise.all([
        keysRequest(env, TOKEN_SUBMIT, jsonInit('POST', { session: null })),
        keysRequest(env, TOKEN_SUBMIT, jsonInit('POST', { session: sid })),
        keysRequest(env, TOKEN_SUBMIT, jsonInit('POST', { session: `gone-${i}` })),
      ]);
      expect(missing.body).toEqual(TOKEN_MISSING_SESSION);
      expect(ok.body).toEqual({
        completed: ['m.login.token'],
        session: sid,
      });
      expect(expired.body).toEqual(UIA_EXPIRED);
    });
  }
});
