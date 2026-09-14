/**
 * TOKENMAXX HEAVY leftovers after #324 eighth-wave / tip past #315 —
 * residual *devices + keys* soft→*concurrent-race* ninth-wave binds
 * unsaturated by:
 *   #324 eighth-wave (SSO∥Device not found∥DELETE challenge; token∥
 *        PUT∥Unrecognized; OAuth approved∥DELETE challenge∥No password;
 *        list∥keys challenge∥Invalid password∥badJson — never SSO soft
 *        ∥ PUT ok ∥ keys challenge; never token soft ∥ DELETE challenge
 *        ∥ No password; never OAuth *approved* success ∥ GET list ∥
 *        Unrecognized ∥ Missing devices; never GET single device ok ∥
 *        delete_devices challenge ∥ badJson ∥ Session mismatch),
 *   #315 seventh-wave (challenge∥Unrecognized∥not-approved; PUT without
 *        SSO/token soft),
 *   #306 sixth-wave (Unrecognized∥not-approved without SSO/list/approved).
 *
 * Gap table (why leftover after eighth-wave):
 *   SSO Missing∥expired ∥ PUT display_name ok ∥ keys UIA challenge
 *     | eighth SSO∥DELETE challenge; eighth list∥keys challenge
 *   token missing∥expired∥mismatch ∥ DELETE challenge ∥ No password
 *     | eighth token∥PUT; eighth approved∥No password without token soft
 *   OAuth approved upload ok ∥ GET list ok ∥ Unrecognized ∥ Missing devices
 *     | eighth approved∥DELETE; eighth list∥keys challenge without approved+Unrecognized
 *   GET single device ok ∥ delete_devices challenge ∥ badJson ∥ Session mismatch
 *     | never single-device GET success under concurrent soft with token mismatch
 *
 * Tests-only. Fixtures use example.com only. Reversible by deleting this file.
 * No invent-product / secrets / DNS. Skips room-cache (tridecenary saturated).
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
// SSO redirect soft ∥ PUT display_name ok ∥ keys UIA challenge
// ---------------------------------------------------------------------------

describe('devices soft residual ninth-wave SSO∥PUT∥keys-challenge after #324', () => {
  it('SSO Missing session ∥ expired ∥ PUT ok ∥ keys UIA challenge under race', async () => {
    const keysEnv = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
        idpLinkCounts: new Map([[USER, 1]]),
      }),
    });
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'PHONE', display_name: 'Old' })],
    });
    const [missing, expired, putOk, challenge] = await Promise.all([
      keysRequest(keysEnv, SSO_REDIRECT),
      keysRequest(keysEnv, `${SSO_REDIRECT}?session=gone`),
      devicesRequest(
        db,
        `${DEVICES}/PHONE`,
        jsonInit('PUT', { display_name: 'Ninth Label' })
      ),
      keysRequest(keysEnv, DEVICE_SIGNING, jsonInit('POST', masterKeyBody())),
    ]);
    expect(missing.body).toEqual(SSO_MISSING_SESSION);
    expect(expired.body).toEqual(UIA_EXPIRED);
    expect(putOk.status).toBe(200);
    expect(db.devices.find((d) => d.device_id === 'PHONE')?.display_name).toBe('Ninth Label');
    expect(challenge.status).toBe(401);
    const kc = challenge.body as {
      flows: Array<{ stages: string[] }>;
      session: string;
    };
    expect(kc.session).toBe('pinned-uia-session-fw9');
    expect(kc.flows).toEqual(
      expect.arrayContaining([
        { stages: ['org.matrix.cross_signing_reset'] },
        { stages: ['m.oauth'] },
        { stages: ['m.login.password'] },
      ])
    );
    expect(keysEnv._cache.data['uia_session:pinned-uia-session-fw9']).toBeTruthy();
  });

  it('SSO Missing∥expired ∥ PUT ok ∥ keys challenge ∥ Device not found', async () => {
    const keysEnv = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
        idpLinkCounts: new Map([[USER, 1]]),
      }),
    });
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'PHONE' })],
    });
    const [missing, expired, putOk, challenge, notFound] = await Promise.all([
      keysRequest(keysEnv, `${SSO_REDIRECT}?redirectUrl=https://client.example/done`),
      keysRequest(keysEnv, `${SSO_REDIRECT}?session=nope`),
      devicesRequest(
        db,
        `${DEVICES}/PHONE`,
        jsonInit('PUT', { display_name: 'Ok' })
      ),
      keysRequest(keysEnv, DEVICE_SIGNING, jsonInit('POST', masterKeyBody())),
      devicesRequest(db, `${DEVICES}/GONE`, { method: 'GET', headers: AUTH }),
    ]);
    expect(missing.body).toEqual(SSO_MISSING_SESSION);
    expect(expired.body).toEqual(UIA_EXPIRED);
    expect(putOk.status).toBe(200);
    expect(challenge.status).toBe(401);
    expect(notFound.body).toEqual(DEVICE_NOT_FOUND);
  });

  for (let i = 0; i < 8; i++) {
    it(`SSO ∥ PUT ∥ keys challenge flood-${i}`, async () => {
      const keysEnv = createKeysEnv({
        db: createKeysDb({
          crossSigningKeys: [existingMasterKey()],
          passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
          idpLinkCounts: new Map([[USER, 1]]),
        }),
      });
      const db = createDevicesDb({
        devices: [seedDevice({ device_id: `PHONE-${i}` })],
      });
      const [missing, expired, putOk, challenge] = await Promise.all([
        keysRequest(
          keysEnv,
          i % 2 === 0 ? SSO_REDIRECT : `${SSO_REDIRECT}?redirectUrl=https://x.example/d`
        ),
        keysRequest(keysEnv, `${SSO_REDIRECT}?session=gone-${i}`),
        devicesRequest(
          db,
          `${DEVICES}/PHONE-${i}`,
          jsonInit('PUT', { display_name: `L-${i}` })
        ),
        keysRequest(keysEnv, DEVICE_SIGNING, jsonInit('POST', masterKeyBody())),
      ]);
      expect(missing.body).toEqual(SSO_MISSING_SESSION);
      expect(expired.body).toEqual(UIA_EXPIRED);
      expect(putOk.status).toBe(200);
      expect(challenge.status).toBe(401);
      expect((challenge.body as { session: string }).session).toBe(
        'pinned-uia-session-fw9'
      );
    });
  }
});

// ---------------------------------------------------------------------------
// token/submit soft ∥ DELETE challenge ∥ No password
// ---------------------------------------------------------------------------

describe('devices soft residual ninth-wave token∥DELETE-challenge∥No-password after #324', () => {
  it('token missing ∥ expired ∥ mismatch ∥ DELETE challenge ∥ No password under race', async () => {
    const cache = mockKv({
      'uia_session:mm': JSON.stringify({
        user_id: BOB,
        completed_stages: [],
      }),
    });
    const keysEnvTok = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
      }),
      cacheKv: cache,
    });
    const keysEnvNoPw = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        passwordHashes: new Map([[USER, null]]),
      }),
    });
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'CHALLENGE' }), seedDevice({ device_id: 'KEEP' })],
    });
    const [missing, expired, mismatch, challenge, noPw] = await Promise.all([
      keysRequest(keysEnvTok, TOKEN_SUBMIT, jsonInit('POST', {})),
      keysRequest(keysEnvTok, TOKEN_SUBMIT, jsonInit('POST', { session: 'gone' })),
      keysRequest(keysEnvTok, TOKEN_SUBMIT, jsonInit('POST', { session: 'mm' })),
      devicesRequest(db, `${DEVICES}/CHALLENGE`, { method: 'DELETE', headers: AUTH }),
      keysRequest(
        keysEnvNoPw,
        DEVICE_SIGNING,
        jsonInit(
          'POST',
          masterKeyBody({
            auth: { type: 'm.login.password', password: PASS },
          })
        )
      ),
    ]);
    expect(missing.body).toEqual(TOKEN_MISSING_SESSION);
    expect(expired.body).toEqual(UIA_EXPIRED);
    expect(mismatch.body).toEqual(SESSION_MISMATCH);
    expect(challenge.status).toBe(401);
    expect(noPw.body).toEqual(NO_PASSWORD);
    expect(db.devices.some((d) => d.device_id === 'CHALLENGE')).toBe(true);
    expect(cache.data['uia_session:mm']).toBeTruthy();
  });

  it('token missing∥expired∥mismatch ∥ DELETE challenge ∥ No password ∥ Invalid password', async () => {
    const cache = mockKv({
      'uia_session:mm': JSON.stringify({
        user_id: BOB,
        completed_stages: [],
      }),
    });
    const keysEnvTok = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
      }),
      cacheKv: cache,
    });
    const keysEnvNoPw = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        passwordHashes: new Map([[USER, null]]),
      }),
    });
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'CHALLENGE' }),
        seedDevice({ device_id: 'KEEP' }),
      ],
    });
    const [missing, expired, mismatch, challenge, noPw, badPw] = await Promise.all([
      keysRequest(keysEnvTok, TOKEN_SUBMIT, jsonInit('POST', { session: null })),
      keysRequest(keysEnvTok, TOKEN_SUBMIT, jsonInit('POST', { session: 'gone' })),
      keysRequest(keysEnvTok, TOKEN_SUBMIT, jsonInit('POST', { session: 'mm' })),
      devicesRequest(db, `${DEVICES}/CHALLENGE`, { method: 'DELETE', headers: AUTH }),
      keysRequest(
        keysEnvNoPw,
        DEVICE_SIGNING,
        jsonInit(
          'POST',
          masterKeyBody({
            auth: { type: 'm.login.password', password: 'x' },
          })
        )
      ),
      devicesRequest(
        db,
        `${DEVICES}/KEEP`,
        jsonInit('DELETE', {
          auth: { type: 'm.login.password', password: 'wrong' },
        })
      ),
    ]);
    expect(missing.body).toEqual(TOKEN_MISSING_SESSION);
    expect(expired.body).toEqual(UIA_EXPIRED);
    expect(mismatch.body).toEqual(SESSION_MISMATCH);
    expect(challenge.status).toBe(401);
    expect(noPw.body).toEqual(NO_PASSWORD);
    expect(badPw.body).toEqual(INVALID_PASSWORD);
  });

  for (let i = 0; i < 8; i++) {
    it(`token soft ∥ DELETE challenge ∥ No password flood-${i}`, async () => {
      const cache = mockKv({
        [`uia_session:mm-${i}`]: JSON.stringify({
          user_id: BOB,
          completed_stages: [],
        }),
      });
      const keysEnvTok = createKeysEnv({
        db: createKeysDb({
          crossSigningKeys: [existingMasterKey()],
        }),
        cacheKv: cache,
      });
      const keysEnvNoPw = createKeysEnv({
        db: createKeysDb({
          crossSigningKeys: [existingMasterKey()],
          passwordHashes: new Map([[USER, null]]),
        }),
      });
      const db = createDevicesDb({
        devices: [seedDevice({ device_id: `CH-${i}` })],
      });
      const [missing, expired, challenge, noPw] = await Promise.all([
        keysRequest(keysEnvTok, TOKEN_SUBMIT, jsonInit('POST', {})),
        keysRequest(keysEnvTok, TOKEN_SUBMIT, jsonInit('POST', { session: `gone-${i}` })),
        devicesRequest(db, `${DEVICES}/CH-${i}`, { method: 'DELETE', headers: AUTH }),
        keysRequest(
          keysEnvNoPw,
          DEVICE_SIGNING,
          jsonInit(
            'POST',
            masterKeyBody({
              auth: { type: 'm.login.password', password: `p-${i}` },
            })
          )
        ),
      ]);
      expect(missing.body).toEqual(TOKEN_MISSING_SESSION);
      expect(expired.body).toEqual(UIA_EXPIRED);
      expect(challenge.status).toBe(401);
      expect(noPw.body).toEqual(NO_PASSWORD);
    });
  }
});

// ---------------------------------------------------------------------------
// OAuth approved upload ok ∥ GET list ok ∥ Unrecognized ∥ Missing devices
// ---------------------------------------------------------------------------

describe('devices soft residual ninth-wave OAuth-approved∥list∥Unrecognized after #324', () => {
  it('OAuth approved upload ok ∥ GET list ok ∥ Unrecognized ∥ Missing devices under race', async () => {
    const cache = mockKv({
      'uia_session:ok': JSON.stringify({
        user_id: USER,
        completed_stages: ['m.oauth'],
      }),
    });
    const keysEnvOk = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
        idpLinkCounts: new Map([[USER, 1]]),
      }),
      cacheKv: cache,
    });
    const keysEnvUnrec = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
      }),
    });
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'PHONE', display_name: 'Phone' }),
        seedDevice({ device_id: 'KEEP' }),
      ],
    });
    const [ok, list, unrec, missing] = await Promise.all([
      keysRequest(
        keysEnvOk,
        DEVICE_SIGNING,
        jsonInit(
          'POST',
          masterKeyBody({
            auth: { type: 'm.oauth', session: 'ok' },
          })
        )
      ),
      devicesRequest(db, DEVICES, { method: 'GET', headers: AUTH }),
      keysRequest(
        keysEnvUnrec,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({ auth: { type: 'm.login.email' } }))
      ),
      devicesRequest(
        db,
        DELETE_DEVICES,
        jsonInit('POST', {
          devices: null,
          auth: { type: 'm.login.password', password: PASS },
        })
      ),
    ]);
    expect(ok.status).toBe(200);
    expect(list.status).toBe(200);
    const listBody = list.body as { devices: Array<{ device_id: string }> };
    expect(listBody.devices.map((d) => d.device_id).sort()).toEqual(['KEEP', 'PHONE']);
    expect(unrec.body).toEqual(unrecognizedBody('m.login.email'));
    expect(missing.body).toEqual(MISSING_DEVICES);
  });

  it('OAuth approved ∥ list ok ∥ Unrecognized ∥ Missing ∥ Device not found', async () => {
    const cache = mockKv({
      'uia_session:ok': JSON.stringify({
        user_id: USER,
        completed_stages: ['org.matrix.cross_signing_reset'],
      }),
    });
    const keysEnvOk = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
        idpLinkCounts: new Map([[USER, 1]]),
      }),
      cacheKv: cache,
    });
    const keysEnvUnrec = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
      }),
    });
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'A' }), seedDevice({ device_id: 'B' })],
    });
    const [ok, list, unrec, missing, notFound] = await Promise.all([
      keysRequest(
        keysEnvOk,
        DEVICE_SIGNING,
        jsonInit(
          'POST',
          masterKeyBody({
            auth: { type: 'org.matrix.cross_signing_reset', session: 'ok' },
          })
        )
      ),
      devicesRequest(db, DEVICES, { method: 'GET', headers: AUTH }),
      keysRequest(
        keysEnvUnrec,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({ auth: { type: 'm.login.dummy' } }))
      ),
      devicesRequest(
        db,
        DELETE_DEVICES,
        jsonInit('POST', {
          devices: null,
          auth: { type: 'm.login.password', password: PASS },
        })
      ),
      devicesRequest(db, `${DEVICES}/GONE`, { method: 'GET', headers: AUTH }),
    ]);
    expect(ok.status).toBe(200);
    expect(list.status).toBe(200);
    expect((list.body as { devices: unknown[] }).devices).toHaveLength(2);
    expect(unrec.body).toEqual(unrecognizedBody('m.login.dummy'));
    expect(missing.body).toEqual(MISSING_DEVICES);
    expect(notFound.body).toEqual(DEVICE_NOT_FOUND);
  });

  for (let i = 0; i < 8; i++) {
    it(`OAuth approved ∥ list ∥ Unrecognized ∥ Missing flood-${i}`, async () => {
      const stage = i % 2 === 0 ? 'm.oauth' : 'm.login.token';
      const authType = i % 2 === 0 ? 'm.login.email' : 'org.example.custom';
      const cache = mockKv({
        [`uia_session:ok-${i}`]: JSON.stringify({
          user_id: USER,
          completed_stages: [stage],
        }),
      });
      const keysEnvOk = createKeysEnv({
        db: createKeysDb({
          crossSigningKeys: [existingMasterKey()],
          passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
          idpLinkCounts: new Map([[USER, 1]]),
        }),
        cacheKv: cache,
      });
      const keysEnvUnrec = createKeysEnv({
        db: createKeysDb({
          crossSigningKeys: [existingMasterKey()],
        }),
      });
      const db = createDevicesDb({
        devices: [
          seedDevice({ device_id: `P-${i}` }),
          seedDevice({ device_id: `K-${i}` }),
        ],
      });
      const [ok, list, unrec, missing] = await Promise.all([
        keysRequest(
          keysEnvOk,
          DEVICE_SIGNING,
          jsonInit(
            'POST',
            masterKeyBody({
              auth: {
                type: i % 2 === 0 ? 'm.oauth' : 'm.login.token',
                session: `ok-${i}`,
              },
            })
          )
        ),
        devicesRequest(db, DEVICES, { method: 'GET', headers: AUTH }),
        keysRequest(
          keysEnvUnrec,
          DEVICE_SIGNING,
          jsonInit('POST', masterKeyBody({ auth: { type: authType } }))
        ),
        devicesRequest(
          db,
          DELETE_DEVICES,
          jsonInit('POST', {
            devices: null,
            auth: { type: 'm.login.password', password: PASS },
          })
        ),
      ]);
      expect(ok.status).toBe(200);
      expect(list.status).toBe(200);
      expect(unrec.body).toEqual(unrecognizedBody(authType));
      expect(missing.body).toEqual(MISSING_DEVICES);
    });
  }
});

// ---------------------------------------------------------------------------
// GET single device ok ∥ delete_devices challenge ∥ badJson ∥ Session mismatch
// ---------------------------------------------------------------------------

describe('devices soft residual ninth-wave GET-device∥delete_devices∥mismatch after #324', () => {
  it('GET single device ok ∥ delete_devices challenge ∥ badJson ∥ Session mismatch under race', async () => {
    const cache = mockKv({
      'uia_session:mm': JSON.stringify({
        user_id: BOB,
        completed_stages: [],
      }),
    });
    const keysEnv = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
      }),
      cacheKv: cache,
    });
    const db = createDevicesDb({
      devices: [
        seedDevice({
          device_id: 'PHONE',
          display_name: 'Phone',
          last_seen_ts: 1_700_000_000_000,
          last_seen_ip: '203.0.113.10',
        }),
        seedDevice({ device_id: 'KEEP' }),
      ],
    });
    const [getOk, delChallenge, badJson, mismatch] = await Promise.all([
      devicesRequest(db, `${DEVICES}/PHONE`, { method: 'GET', headers: AUTH }),
      devicesRequest(db, DELETE_DEVICES, jsonInit('POST', { devices: ['KEEP'] })),
      devicesRequest(db, DELETE_DEVICES, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{bad',
      }),
      keysRequest(keysEnv, TOKEN_SUBMIT, jsonInit('POST', { session: 'mm' })),
    ]);
    expect(getOk.status).toBe(200);
    expect(getOk.body).toMatchObject({
      device_id: 'PHONE',
      display_name: 'Phone',
      last_seen_ts: 1_700_000_000_000,
      last_seen_ip: '203.0.113.10',
    });
    expect(delChallenge.status).toBe(401);
    const dc = delChallenge.body as {
      flows: Array<{ stages: string[] }>;
      session: string;
    };
    expect(dc.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof dc.session).toBe('string');
    expect(badJson.body).toEqual(BAD_JSON);
    expect(mismatch.body).toEqual(SESSION_MISMATCH);
    expect(db.devices.some((d) => d.device_id === 'KEEP')).toBe(true);
  });

  it('GET device ok ∥ delete_devices challenge ∥ badJson ∥ mismatch ∥ Invalid password', async () => {
    const cache = mockKv({
      'uia_session:mm': JSON.stringify({
        user_id: BOB,
        completed_stages: [],
      }),
    });
    const keysEnv = createKeysEnv({ cacheKv: cache });
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'PHONE' }), seedDevice({ device_id: 'KEEP' })],
    });
    const [getOk, delChallenge, badJson, mismatch, badPw] = await Promise.all([
      devicesRequest(db, `${DEVICES}/PHONE`, { method: 'GET', headers: AUTH }),
      devicesRequest(db, DELETE_DEVICES, jsonInit('POST', { devices: ['KEEP'] })),
      devicesRequest(db, `${DEVICES}/PHONE`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{bad',
      }),
      keysRequest(keysEnv, TOKEN_SUBMIT, jsonInit('POST', { session: 'mm' })),
      devicesRequest(
        db,
        `${DEVICES}/KEEP`,
        jsonInit('DELETE', {
          auth: { type: 'm.login.password', password: 'wrong' },
        })
      ),
    ]);
    expect(getOk.status).toBe(200);
    expect(delChallenge.status).toBe(401);
    expect(badJson.body).toEqual(BAD_JSON);
    expect(mismatch.body).toEqual(SESSION_MISMATCH);
    expect(badPw.body).toEqual(INVALID_PASSWORD);
  });

  for (let i = 0; i < 8; i++) {
    it(`GET device ∥ delete_devices challenge ∥ badJson ∥ mismatch flood-${i}`, async () => {
      const cache = mockKv({
        [`uia_session:mm-${i}`]: JSON.stringify({
          user_id: BOB,
          completed_stages: [],
        }),
      });
      const keysEnv = createKeysEnv({ cacheKv: cache });
      const db = createDevicesDb({
        devices: [
          seedDevice({ device_id: `PHONE-${i}` }),
          seedDevice({ device_id: `KEEP-${i}` }),
        ],
      });
      const [getOk, delChallenge, badJson, mismatch] = await Promise.all([
        devicesRequest(db, `${DEVICES}/PHONE-${i}`, { method: 'GET', headers: AUTH }),
        devicesRequest(
          db,
          DELETE_DEVICES,
          jsonInit('POST', { devices: [`KEEP-${i}`] })
        ),
        devicesRequest(db, i % 2 === 0 ? DELETE_DEVICES : `${DEVICES}/PHONE-${i}`, {
          method: i % 2 === 0 ? 'POST' : 'PUT',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '{bad',
        }),
        keysRequest(
          keysEnv,
          TOKEN_SUBMIT,
          jsonInit('POST', { session: `mm-${i}` })
        ),
      ]);
      expect(getOk.status).toBe(200);
      expect(delChallenge.status).toBe(401);
      expect(badJson.body).toEqual(BAD_JSON);
      expect(mismatch.body).toEqual(SESSION_MISMATCH);
    });
  }
});
