/**
 * TOKENMAXX HEAVY tip-relaunch after #340/#357 — residual *devices + keys*
 * soft→*concurrent-race* tenth-wave binds unsaturated by ninth-wave (#340):
 *   SSO callback no-code ∥ SSO redirect Missing ∥ Device not found ∥
 *     Invalid password (ninth callback without redirect/Invalid password;
 *     redirect without callback HTML/Device not found),
 *   OAuth approved ∥ keys UIA challenge ∥ DELETE challenge ∥ PUT ok
 *     (ninth approved without keys/DELETE challenge/PUT; token∥keys∥PUT
 *     without OAuth approved/DELETE challenge),
 *   token missing ∥ Unrecognized ∥ Missing devices ∥ No password
 *     (ninth token without Unrecognized/Missing/No password;
 *     Unrecognized without token soft),
 *   Session mismatch ∥ badJson ∥ list ok ∥ SSO expired HTML
 *     (ninth mismatch without badJson/list/SSO expired; list without
 *     mismatch/badJson/SSO expired).
 *
 * Gap table (why leftover after #340 ninth / tip past #357):
 *   callback no-code ∥ redirect Missing ∥ Device not found ∥ Invalid password
 *     | ninth callback and redirect in separate quads
 *   OAuth approved ∥ keys challenge ∥ DELETE challenge ∥ PUT ok
 *     | ninth approved and keys∥PUT in separate quads
 *   token missing ∥ Unrecognized ∥ Missing devices ∥ No password
 *     | ninth token/Unrecognized/No password never co-raced
 *   Session mismatch ∥ badJson ∥ list ok ∥ SSO expired HTML
 *     | ninth mismatch/badJson/list/SSO expired never co-raced
 *
 * Tests-only. Fixtures use example.com only. Reversible by deleting this file.
 * No invent-product / secrets / DNS. Skips room-cache (sexdecenary saturated).
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
    generateOpaqueId: vi.fn(async () => 'pinned-uia-session-fw9'),
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

const DEVICE_NOT_FOUND = {
  errcode: 'M_NOT_FOUND',
  error: 'Device not found',
} as const;

const INVALID_PASSWORD = {
  errcode: 'M_FORBIDDEN',
  error: 'Invalid password',
} as const;

const BAD_JSON = {
  errcode: 'M_BAD_JSON',
  error: 'Could not parse request body as JSON',
} as const;

const MISSING_DEVICES = {
  errcode: 'M_MISSING_PARAM',
  error: 'Missing required parameter: devices',
} as const;

const NO_PASSWORD = {
  errcode: 'M_FORBIDDEN',
  error: 'No password set for user',
} as const;

const SSO_MISSING_SESSION = {
  errcode: 'M_MISSING_PARAM',
  error: 'Missing session parameter',
} as const;

const UIA_EXPIRED = {
  errcode: 'M_UNKNOWN',
  error: 'UIA session not found or expired',
} as const;

const TOKEN_MISSING_SESSION = {
  errcode: 'M_MISSING_PARAM',
  error: 'Missing required parameter: session',
} as const;

const SESSION_MISMATCH = {
  errcode: 'M_FORBIDDEN',
  error: 'Session user mismatch',
} as const;

const CROSS_SIGNING_NOT_APPROVED = {
  errcode: 'M_UNAUTHORIZED',
  error: 'Cross-signing reset not approved. Please approve the request at the provided URL.',
} as const;

const SSO_MISSING_STATE = 'Missing state parameter';
const SSO_EXPIRED_BODY = 'The UIA session has expired. Please try again.';
const SSO_NO_CODE = 'No authorization code received';

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
} = {}) {
  const deviceRows = opts.devices ?? [];
  const passwordHash =
    opts.passwordHash === undefined ? `mockok:${PASS}` : opts.passwordHash;
  const missingUser = opts.missingUser ?? false;

  return {
    devices: deviceRows,
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
                const [displayName, userId, deviceId] = args as [string, string, string];
                const row = deviceRows.find(
                  (d) => d.user_id === userId && d.device_id === deviceId
                );
                if (row) row.display_name = displayName;
                return { success: true, meta: { changes: row ? 1 : 0, last_row_id: 0 } };
              }
              if (
                sql.includes('DELETE FROM access_tokens') ||
                sql.includes('DELETE FROM device_keys') ||
                sql.includes('DELETE FROM devices')
              ) {
                const deviceId = args[1] as string;
                const idx = deviceRows.findIndex(
                  (d) => d.user_id === (args[0] as string) && d.device_id === deviceId
                );
                if (idx >= 0 && sql.includes('DELETE FROM devices')) {
                  deviceRows.splice(idx, 1);
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

function unrecognizedBody(authType: string) {
  return {
    errcode: 'M_UNRECOGNIZED',
    error: `Unrecognized auth type: ${authType}`,
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


// ---------------------------------------------------------------------------
// SSO callback no-code ∥ SSO redirect Missing ∥ Device not found ∥ Invalid password
// ---------------------------------------------------------------------------

describe('devices soft residual tenth-wave callback∥redirect∥notfound∥badPw after #340', () => {
  it('SSO callback no-code ∥ SSO redirect Missing ∥ Device not found ∥ Invalid password under race', async () => {
    const cache = mockKv({
      'uia_session:race-nocode': JSON.stringify({
        user_id: USER,
        completed_stages: [],
      }),
    });
    const keysEnv = createKeysEnv({ cacheKv: cache });
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'PHONE' }), seedDevice({ device_id: 'KEEP' })],
    });
    const [noCode, ssoMissing, notFound, badPw] = await Promise.all([
      keysRequest(keysEnv, `${SSO_CALLBACK}?state=race-nocode`),
      keysRequest(keysEnv, SSO_REDIRECT),
      devicesRequest(db, `${DEVICES}/GONE`, { method: 'GET', headers: AUTH }),
      devicesRequest(
        db,
        `${DEVICES}/PHONE`,
        jsonInit('DELETE', {
          auth: { type: 'm.login.password', password: 'wrong' },
        })
      ),
    ]);
    expect(noCode.status).toBe(200);
    expect(noCode.text.includes(SSO_NO_CODE)).toBe(true);
    expect(ssoMissing.body).toEqual(SSO_MISSING_SESSION);
    expect(notFound.body).toEqual(DEVICE_NOT_FOUND);
    expect(badPw.body).toEqual(INVALID_PASSWORD);
    expect(db.devices.some((d) => d.device_id === 'PHONE')).toBe(true);
  });

  it('callback no-code∥Missing state ∥ redirect Missing∥expired ∥ not found ∥ Invalid password', async () => {
    const cache = mockKv({
      'uia_session:race-nocode': JSON.stringify({
        user_id: USER,
        completed_stages: [],
      }),
    });
    const keysEnv = createKeysEnv({ cacheKv: cache });
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'PHONE' })],
    });
    const [noCode, missingState, ssoMissing, ssoExpired, notFound, badPw] = await Promise.all([
      keysRequest(keysEnv, `${SSO_CALLBACK}?state=race-nocode`),
      keysRequest(keysEnv, `${SSO_CALLBACK}?code=abc`),
      keysRequest(keysEnv, SSO_REDIRECT),
      keysRequest(keysEnv, `${SSO_REDIRECT}?session=gone`),
      devicesRequest(db, `${DEVICES}/GONE`, { method: 'GET', headers: AUTH }),
      devicesRequest(
        db,
        `${DEVICES}/PHONE`,
        jsonInit('DELETE', {
          auth: { type: 'm.login.password', password: 'wrong' },
        })
      ),
    ]);
    expect(noCode.text.includes(SSO_NO_CODE)).toBe(true);
    expect(missingState.text.includes(SSO_MISSING_STATE)).toBe(true);
    expect(ssoMissing.body).toEqual(SSO_MISSING_SESSION);
    expect(ssoExpired.body).toEqual(UIA_EXPIRED);
    expect(notFound.body).toEqual(DEVICE_NOT_FOUND);
    expect(badPw.body).toEqual(INVALID_PASSWORD);
  });

  for (let i = 0; i < 8; i++) {
    it(`callback ∥ redirect ∥ Device not found ∥ Invalid password flood-${i}`, async () => {
      const cache = mockKv({
        [`uia_session:nocode-${i}`]: JSON.stringify({
          user_id: USER,
          completed_stages: [],
        }),
      });
      const keysEnv = createKeysEnv({ cacheKv: cache });
      const db = createDevicesDb({
        devices: [seedDevice({ device_id: `PH-${i}` })],
      });
      const [noCode, ssoMissing, notFound, badPw] = await Promise.all([
        keysRequest(keysEnv, `${SSO_CALLBACK}?state=nocode-${i}`),
        keysRequest(keysEnv, SSO_REDIRECT),
        devicesRequest(db, `${DEVICES}/GONE-${i}`, { method: 'GET', headers: AUTH }),
        devicesRequest(
          db,
          `${DEVICES}/PH-${i}`,
          jsonInit('DELETE', {
            auth: { type: 'm.login.password', password: 'wrong' },
          })
        ),
      ]);
      expect(noCode.text.includes(SSO_NO_CODE)).toBe(true);
      expect(ssoMissing.body).toEqual(SSO_MISSING_SESSION);
      expect(notFound.body).toEqual(DEVICE_NOT_FOUND);
      expect(badPw.body).toEqual(INVALID_PASSWORD);
    });
  }
});


// ---------------------------------------------------------------------------
// OAuth approved ∥ keys UIA challenge ∥ DELETE challenge ∥ PUT ok
// ---------------------------------------------------------------------------

describe('devices soft residual tenth-wave OAuth-approved∥keys∥DELETE∥PUT after #340', () => {
  it('OAuth approved ∥ keys UIA challenge ∥ DELETE challenge ∥ PUT ok under race', async () => {
    const cache = mockKv({
      'uia_session:ok': JSON.stringify({
        user_id: USER,
        completed_stages: ['m.oauth'],
      }),
    });
    const keysEnv = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
        idpLinkCounts: new Map([[USER, 1]]),
      }),
      cacheKv: cache,
    });
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'PHONE', display_name: 'Old' }),
        seedDevice({ device_id: 'CHALLENGE' }),
        seedDevice({ device_id: 'KEEP' }),
      ],
    });
    const [ok, keysChallenge, delChallenge, putOk] = await Promise.all([
      keysRequest(
        keysEnv,
        DEVICE_SIGNING,
        jsonInit(
          'POST',
          masterKeyBody({
            auth: { type: 'm.oauth', session: 'ok' },
          })
        )
      ),
      keysRequest(keysEnv, DEVICE_SIGNING, jsonInit('POST', masterKeyBody())),
      devicesRequest(db, `${DEVICES}/CHALLENGE`, { method: 'DELETE', headers: AUTH }),
      devicesRequest(
        db,
        `${DEVICES}/PHONE`,
        jsonInit('PUT', { display_name: 'Race Label' })
      ),
    ]);
    expect(ok.status).toBe(200);
    expect(keysChallenge.status).toBe(401);
    const keysBody = keysChallenge.body as {
      flows: Array<{ stages: string[] }>;
      session: string;
    };
    expect(keysBody.flows.length).toBeGreaterThan(0);
    expect(
      keysBody.flows.some(
        (f) =>
          f.stages.includes('m.login.password') ||
          f.stages.includes('org.matrix.cross_signing_reset') ||
          f.stages.includes('m.oauth')
      )
    ).toBe(true);
    expect(typeof keysBody.session).toBe('string');
    expect(delChallenge.status).toBe(401);
    const delBody = delChallenge.body as {
      flows: Array<{ stages: string[] }>;
      session: string;
    };
    expect(delBody.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof delBody.session).toBe('string');
    expect(putOk.status).toBe(200);
    expect(db.devices.find((d) => d.device_id === 'PHONE')?.display_name).toBe('Race Label');
    expect(db.devices.some((d) => d.device_id === 'CHALLENGE')).toBe(true);
  });

  it('OAuth approved ∥ keys challenge ∥ DELETE challenge ∥ PUT ok ∥ Device not found', async () => {
    const cache = mockKv({
      'uia_session:ok': JSON.stringify({
        user_id: USER,
        completed_stages: ['org.matrix.cross_signing_reset'],
      }),
    });
    const keysEnv = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
        idpLinkCounts: new Map([[USER, 1]]),
      }),
      cacheKv: cache,
    });
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'PHONE' }),
        seedDevice({ device_id: 'CHALLENGE' }),
      ],
    });
    const [ok, keysChallenge, delChallenge, putOk, notFound] = await Promise.all([
      keysRequest(
        keysEnv,
        DEVICE_SIGNING,
        jsonInit(
          'POST',
          masterKeyBody({
            auth: { type: 'org.matrix.cross_signing_reset', session: 'ok' },
          })
        )
      ),
      keysRequest(keysEnv, DEVICE_SIGNING, jsonInit('POST', masterKeyBody())),
      devicesRequest(db, `${DEVICES}/CHALLENGE`, { method: 'DELETE', headers: AUTH }),
      devicesRequest(
        db,
        `${DEVICES}/PHONE`,
        jsonInit('PUT', { display_name: 'Ok' })
      ),
      devicesRequest(db, `${DEVICES}/GONE`, { method: 'GET', headers: AUTH }),
    ]);
    expect(ok.status).toBe(200);
    expect(keysChallenge.status).toBe(401);
    expect(delChallenge.status).toBe(401);
    expect(putOk.status).toBe(200);
    expect(notFound.body).toEqual(DEVICE_NOT_FOUND);
  });

  for (let i = 0; i < 8; i++) {
    it(`OAuth approved ∥ keys ∥ DELETE challenge ∥ PUT flood-${i}`, async () => {
      const stage = i % 2 === 0 ? 'm.oauth' : 'm.login.token';
      const cache = mockKv({
        [`uia_session:ok-${i}`]: JSON.stringify({
          user_id: USER,
          completed_stages: [stage],
        }),
      });
      const keysEnv = createKeysEnv({
        db: createKeysDb({
          crossSigningKeys: [existingMasterKey()],
          passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
          idpLinkCounts: new Map([[USER, 1]]),
        }),
        cacheKv: cache,
      });
      const db = createDevicesDb({
        devices: [
          seedDevice({ device_id: `PH-${i}` }),
          seedDevice({ device_id: `CH-${i}` }),
        ],
      });
      const [ok, keysChallenge, delChallenge, putOk] = await Promise.all([
        keysRequest(
          keysEnv,
          DEVICE_SIGNING,
          jsonInit(
            'POST',
            masterKeyBody({
              auth: { type: stage, session: `ok-${i}` },
            })
          )
        ),
        keysRequest(keysEnv, DEVICE_SIGNING, jsonInit('POST', masterKeyBody())),
        devicesRequest(db, `${DEVICES}/CH-${i}`, { method: 'DELETE', headers: AUTH }),
        devicesRequest(
          db,
          `${DEVICES}/PH-${i}`,
          jsonInit('PUT', { display_name: `L-${i}` })
        ),
      ]);
      expect(ok.status).toBe(200);
      expect(keysChallenge.status).toBe(401);
      expect(delChallenge.status).toBe(401);
      expect(putOk.status).toBe(200);
    });
  }
});


// ---------------------------------------------------------------------------
// token missing ∥ Unrecognized ∥ Missing devices ∥ No password
// ---------------------------------------------------------------------------

describe('devices soft residual tenth-wave token∥Unrecognized∥Missing∥NoPw after #340', () => {
  it('token missing ∥ Unrecognized ∥ Missing devices ∥ No password under race', async () => {
    const keysEnv = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        passwordHashes: new Map([[USER, null]]),
        idpLinkCounts: new Map([[USER, 1]]),
      }),
    });
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'PHONE' })],
    });
    const [tokenMissing, unrec, missing, noPw] = await Promise.all([
      keysRequest(keysEnv, TOKEN_SUBMIT, jsonInit('POST', {})),
      keysRequest(
        keysEnv,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({ auth: { type: 'm.login.email' } }))
      ),
      devicesRequest(db, DELETE_DEVICES, jsonInit('POST', { devices: null })),
      keysRequest(
        keysEnv,
        DEVICE_SIGNING,
        jsonInit(
          'POST',
          masterKeyBody({
            auth: { type: 'm.login.password', password: PASS },
          })
        )
      ),
    ]);
    expect(tokenMissing.body).toEqual(TOKEN_MISSING_SESSION);
    expect(unrec.body).toEqual(unrecognizedBody('m.login.email'));
    expect(missing.body).toEqual(MISSING_DEVICES);
    expect(noPw.body).toEqual(NO_PASSWORD);
  });

  it('token missing∥expired ∥ Unrecognized ∥ Missing devices ∥ No password ∥ list ok', async () => {
    const keysEnv = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        passwordHashes: new Map([[USER, null]]),
        idpLinkCounts: new Map([[USER, 1]]),
      }),
    });
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'PHONE', display_name: 'Phone' }),
        seedDevice({ device_id: 'KEEP' }),
      ],
    });
    const [tokenMissing, tokenExpired, unrec, missing, noPw, list] = await Promise.all([
      keysRequest(keysEnv, TOKEN_SUBMIT, jsonInit('POST', {})),
      keysRequest(keysEnv, TOKEN_SUBMIT, jsonInit('POST', { session: 'gone' })),
      keysRequest(
        keysEnv,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({ auth: { type: 'm.login.dummy' } }))
      ),
      devicesRequest(db, DELETE_DEVICES, jsonInit('POST', { devices: null })),
      keysRequest(
        keysEnv,
        DEVICE_SIGNING,
        jsonInit(
          'POST',
          masterKeyBody({
            auth: { type: 'm.login.password', password: PASS },
          })
        )
      ),
      devicesRequest(db, DEVICES, { method: 'GET', headers: AUTH }),
    ]);
    expect(tokenMissing.body).toEqual(TOKEN_MISSING_SESSION);
    expect(tokenExpired.body).toEqual(UIA_EXPIRED);
    expect(unrec.body).toEqual(unrecognizedBody('m.login.dummy'));
    expect(missing.body).toEqual(MISSING_DEVICES);
    expect(noPw.body).toEqual(NO_PASSWORD);
    expect(list.status).toBe(200);
    const listBody = list.body as { devices: Array<{ device_id: string }> };
    expect(listBody.devices.map((d) => d.device_id).sort()).toEqual(['KEEP', 'PHONE']);
  });

  for (let i = 0; i < 8; i++) {
    it(`token ∥ Unrecognized ∥ Missing devices ∥ No password flood-${i}`, async () => {
      const authType = i % 2 === 0 ? 'm.login.email' : 'org.example.custom';
      const keysEnv = createKeysEnv({
        db: createKeysDb({
          crossSigningKeys: [existingMasterKey()],
          passwordHashes: new Map([[USER, null]]),
          idpLinkCounts: new Map([[USER, 1]]),
        }),
      });
      const db = createDevicesDb({
        devices: [seedDevice({ device_id: `PH-${i}` })],
      });
      const [tokenMissing, unrec, missing, noPw] = await Promise.all([
        keysRequest(keysEnv, TOKEN_SUBMIT, jsonInit('POST', {})),
        keysRequest(
          keysEnv,
          DEVICE_SIGNING,
          jsonInit('POST', masterKeyBody({ auth: { type: authType } }))
        ),
        devicesRequest(db, DELETE_DEVICES, jsonInit('POST', { devices: null })),
        keysRequest(
          keysEnv,
          DEVICE_SIGNING,
          jsonInit(
            'POST',
            masterKeyBody({
              auth: { type: 'm.login.password', password: PASS },
            })
          )
        ),
      ]);
      expect(tokenMissing.body).toEqual(TOKEN_MISSING_SESSION);
      expect(unrec.body).toEqual(unrecognizedBody(authType));
      expect(missing.body).toEqual(MISSING_DEVICES);
      expect(noPw.body).toEqual(NO_PASSWORD);
    });
  }
});


// ---------------------------------------------------------------------------
// Session mismatch ∥ badJson ∥ list ok ∥ SSO expired HTML
// ---------------------------------------------------------------------------

describe('devices soft residual tenth-wave mismatch∥badJson∥list∥SSO-expired after #340', () => {
  it('Session mismatch ∥ badJson ∥ list ok ∥ SSO expired HTML under race', async () => {
    const cache = mockKv({
      'uia_session:mm': JSON.stringify({
        user_id: BOB,
        completed_stages: [],
      }),
    });
    const keysEnv = createKeysEnv({ cacheKv: cache });
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'PHONE', display_name: 'Phone' }),
        seedDevice({ device_id: 'KEEP' }),
      ],
    });
    const [mismatch, badJson, list, expired] = await Promise.all([
      keysRequest(keysEnv, TOKEN_SUBMIT, jsonInit('POST', { session: 'mm' })),
      devicesRequest(db, `${DEVICES}/PHONE`, {
        method: 'PUT',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: '{not-json',
      }),
      devicesRequest(db, DEVICES, { method: 'GET', headers: AUTH }),
      keysRequest(keysEnv, `${SSO_CALLBACK}?code=abc&state=gone`),
    ]);
    expect(mismatch.body).toEqual(SESSION_MISMATCH);
    expect(badJson.body).toEqual(BAD_JSON);
    expect(list.status).toBe(200);
    const listBody = list.body as { devices: Array<{ device_id: string }> };
    expect(listBody.devices.map((d) => d.device_id).sort()).toEqual(['KEEP', 'PHONE']);
    expect(expired.status).toBe(200);
    expect(expired.text.includes(SSO_EXPIRED_BODY)).toBe(true);
  });

  it('mismatch ∥ badJson ∥ list ∥ SSO expired ∥ token missing ∥ Device not found', async () => {
    const cache = mockKv({
      'uia_session:mm': JSON.stringify({
        user_id: BOB,
        completed_stages: [],
      }),
    });
    const keysEnv = createKeysEnv({ cacheKv: cache });
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'PHONE' })],
    });
    const [mismatch, badJson, list, expired, tokenMissing, notFound] = await Promise.all([
      keysRequest(keysEnv, TOKEN_SUBMIT, jsonInit('POST', { session: 'mm' })),
      devicesRequest(db, DELETE_DEVICES, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: '{bad',
      }),
      devicesRequest(db, DEVICES, { method: 'GET', headers: AUTH }),
      keysRequest(keysEnv, `${SSO_CALLBACK}?code=x&state=missing`),
      keysRequest(keysEnv, TOKEN_SUBMIT, jsonInit('POST', {})),
      devicesRequest(db, `${DEVICES}/GONE`, { method: 'GET', headers: AUTH }),
    ]);
    expect(mismatch.body).toEqual(SESSION_MISMATCH);
    expect(badJson.body).toEqual(BAD_JSON);
    expect(list.status).toBe(200);
    expect(expired.text.includes(SSO_EXPIRED_BODY)).toBe(true);
    expect(tokenMissing.body).toEqual(TOKEN_MISSING_SESSION);
    expect(notFound.body).toEqual(DEVICE_NOT_FOUND);
  });

  for (let i = 0; i < 8; i++) {
    it(`mismatch ∥ badJson ∥ list ∥ SSO expired flood-${i}`, async () => {
      const cache = mockKv({
        [`uia_session:mm-${i}`]: JSON.stringify({
          user_id: BOB,
          completed_stages: [],
        }),
      });
      const keysEnv = createKeysEnv({ cacheKv: cache });
      const db = createDevicesDb({
        devices: [seedDevice({ device_id: `PH-${i}` })],
      });
      const [mismatch, badJson, list, expired] = await Promise.all([
        keysRequest(keysEnv, TOKEN_SUBMIT, jsonInit('POST', { session: `mm-${i}` })),
        devicesRequest(db, `${DEVICES}/PH-${i}`, {
          method: 'PUT',
          headers: { ...AUTH, 'Content-Type': 'application/json' },
          body: '{x',
        }),
        devicesRequest(db, DEVICES, { method: 'GET', headers: AUTH }),
        keysRequest(keysEnv, `${SSO_CALLBACK}?code=c&state=gone-${i}`),
      ]);
      expect(mismatch.body).toEqual(SESSION_MISMATCH);
      expect(badJson.body).toEqual(BAD_JSON);
      expect(list.status).toBe(200);
      expect(expired.text.includes(SSO_EXPIRED_BODY)).toBe(true);
    });
  }
});
