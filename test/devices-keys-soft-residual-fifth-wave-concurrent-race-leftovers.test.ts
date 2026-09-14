/**
 * TOKENMAXX HEAVY leftovers after #300 fourth-wave / tip past #299 —
 * residual *devices + keys* soft→*concurrent-race* fifth-wave binds
 * unsaturated by:
 *   #300/#297 fourth-wave (SSO HTML quad / OAuth UIA soft flood /
 *        token missingParam race; no devices.ts soft multi-error matrix;
 *        no device_signing *password* soft strings under race with OAuth),
 *   #293 third-wave (DELETE/delete_devices non-password success;
 *        sequential soft floods),
 *   #280/#269 soft residual (sequential Device not found / Invalid
 *        password / badJson / Missing devices pins; limited Promise.all
 *        pairs only — never full multi-error ∥ success concurrent matrix).
 *
 * Gap table (why leftover after fourth-wave):
 *   Device not found ∥ Invalid password ∥ badJson ∥ Missing devices ∥
 *     delete success under Promise.all
 *     | #269 sequential + GET∥DELETE pair only
 *   device_signing password Invalid password / No password /
 *     Missing auth.password ∥ OAuth UIA expired/mismatch under race
 *     | #269 sequential; #300 OAuth-only flood
 *   delete_devices Invalid password ∥ Missing devices ∥ badJson ∥
 *     success under race
 *     | #280 sequential + wrong∥empty∥missing-user triple only
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
    generateOpaqueId: vi.fn(async () => 'pinned-uia-session-fw5'),
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

const MISSING_AUTH_PASSWORD = {
  errcode: 'M_MISSING_PARAM',
  error: 'Missing required parameter: auth.password',
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
                return { success: true, meta: { changes: 0, last_row_id: 0 } };
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
// devices.ts soft multi-error ∥ success concurrent matrix
// ---------------------------------------------------------------------------

describe('devices soft residual fifth-wave multi-error race after #300', () => {
  it('Device not found ∥ Invalid password ∥ badJson ∥ Missing devices ∥ delete ok under race', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'KEEP' }), seedDevice({ device_id: 'DEL' })],
    });
    const [notFound, badPw, badJson, missingDevices, ok] = await Promise.all([
      devicesRequest(db, `${DEVICES}/MISSING`, { method: 'GET', headers: AUTH }),
      devicesRequest(
        db,
        `${DEVICES}/KEEP`,
        jsonInit('DELETE', {
          auth: { type: 'm.login.password', password: 'wrong' },
        })
      ),
      devicesRequest(db, `${DEVICES}/KEEP`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      }),
      devicesRequest(db, DELETE_DEVICES, jsonInit('POST', { devices: null, auth: { type: 'm.login.password', password: PASS } })),
      devicesRequest(
        db,
        `${DEVICES}/DEL`,
        jsonInit('DELETE', {
          auth: { type: 'm.login.password', password: PASS },
        })
      ),
    ]);
    expect(notFound.status).toBe(404);
    expect(notFound.body).toEqual(DEVICE_NOT_FOUND);
    expect(badPw.status).toBe(403);
    expect(badPw.body).toEqual(INVALID_PASSWORD);
    expect(badJson.status).toBe(400);
    expect(badJson.body).toEqual(BAD_JSON);
    expect(missingDevices.status).toBe(400);
    expect(missingDevices.body).toEqual(MISSING_DEVICES);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({});
    expect(db.devices.some((d) => d.device_id === 'KEEP')).toBe(true);
    expect(db.devices.some((d) => d.device_id === 'DEL')).toBe(false);
  });

  it('GET/PUT/DELETE Device not found all bind under race', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'ONLY' })] });
    const results = await Promise.all([
      devicesRequest(db, `${DEVICES}/GONE-A`, { method: 'GET', headers: AUTH }),
      devicesRequest(db, `${DEVICES}/GONE-B`, jsonInit('PUT', { display_name: 'x' })),
      devicesRequest(
        db,
        `${DEVICES}/GONE-C`,
        jsonInit('DELETE', {
          auth: { type: 'm.login.password', password: PASS },
        })
      ),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
    expect(results.every((r) => r.body === DEVICE_NOT_FOUND || JSON.stringify(r.body) === JSON.stringify(DEVICE_NOT_FOUND))).toBe(true);
    for (const r of results) {
      expect(r.body).toEqual(DEVICE_NOT_FOUND);
    }
  });

  for (let i = 0; i < 10; i++) {
    it(`devices soft multi-error ∥ success flood-${i}`, async () => {
      const delId = `DEL-${i}`;
      const keepId = `KEEP-${i}`;
      const db = createDevicesDb({
        devices: [seedDevice({ device_id: keepId }), seedDevice({ device_id: delId })],
      });
      const [notFound, badPw, badJson, ok] = await Promise.all([
        devicesRequest(db, `${DEVICES}/MISS-${i}`, { method: 'GET', headers: AUTH }),
        devicesRequest(
          db,
          `${DEVICES}/${keepId}`,
          jsonInit('DELETE', {
            auth: { type: 'm.login.password', password: `wrong-${i}` },
          })
        ),
        devicesRequest(db, DELETE_DEVICES, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '{bad',
        }),
        devicesRequest(
          db,
          `${DEVICES}/${delId}`,
          jsonInit('DELETE', {
            auth: { type: 'm.login.password', password: PASS },
          })
        ),
      ]);
      expect(notFound.body).toEqual(DEVICE_NOT_FOUND);
      expect(badPw.body).toEqual(INVALID_PASSWORD);
      expect(badJson.body).toEqual(BAD_JSON);
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({});
    });
  }
});

// ---------------------------------------------------------------------------
// delete_devices Invalid password ∥ Missing devices ∥ badJson ∥ success
// ---------------------------------------------------------------------------

describe('devices soft residual fifth-wave delete_devices soft race after #300', () => {
  it('Invalid password ∥ Missing devices ∥ badJson ∥ success under race', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'A' }),
        seedDevice({ device_id: 'B' }),
        seedDevice({ device_id: 'C' }),
      ],
    });
    const [badPw, missing, badJson, ok] = await Promise.all([
      devicesRequest(
        db,
        DELETE_DEVICES,
        jsonInit('POST', {
          devices: ['A'],
          auth: { type: 'm.login.password', password: 'nope' },
        })
      ),
      devicesRequest(
        db,
        DELETE_DEVICES,
        jsonInit('POST', {
          auth: { type: 'm.login.password', password: PASS },
        })
      ),
      devicesRequest(db, DELETE_DEVICES, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: 'not-json',
      }),
      devicesRequest(
        db,
        DELETE_DEVICES,
        jsonInit('POST', {
          devices: ['B', 'C'],
          auth: { type: 'm.login.password', password: PASS },
        })
      ),
    ]);
    expect(badPw.body).toEqual(INVALID_PASSWORD);
    expect(missing.body).toEqual(MISSING_DEVICES);
    expect(badJson.body).toEqual(BAD_JSON);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({});
    expect(db.devices.map((d) => d.device_id)).toEqual(['A']);
  });

  it('wrong∥empty∥missing-user∥not-array all soft-bind under race', async () => {
    const dbWrong = createDevicesDb({
      devices: [seedDevice({ device_id: 'W' })],
    });
    const dbEmpty = createDevicesDb({
      devices: [seedDevice({ device_id: 'E' })],
    });
    const dbMissingUser = createDevicesDb({
      devices: [seedDevice({ device_id: 'M' })],
      missingUser: true,
    });
    const dbNotArray = createDevicesDb({
      devices: [seedDevice({ device_id: 'N' })],
    });
    const [wrong, empty, missingUser, notArray] = await Promise.all([
      devicesRequest(
        dbWrong,
        DELETE_DEVICES,
        jsonInit('POST', {
          devices: ['W'],
          auth: { type: 'm.login.password', password: 'x' },
        })
      ),
      devicesRequest(
        dbEmpty,
        DELETE_DEVICES,
        jsonInit('POST', {
          devices: ['E'],
          auth: { type: 'm.login.password', password: '' },
        })
      ),
      devicesRequest(
        dbMissingUser,
        DELETE_DEVICES,
        jsonInit('POST', {
          devices: ['M'],
          auth: { type: 'm.login.password', password: PASS },
        })
      ),
      devicesRequest(
        dbNotArray,
        DELETE_DEVICES,
        jsonInit('POST', {
          devices: 'not-an-array',
          auth: { type: 'm.login.password', password: PASS },
        })
      ),
    ]);
    expect(wrong.body).toEqual(INVALID_PASSWORD);
    expect(empty.body).toEqual(INVALID_PASSWORD);
    expect(missingUser.body).toEqual(INVALID_PASSWORD);
    expect(notArray.body).toEqual(MISSING_DEVICES);
  });

  for (let i = 0; i < 8; i++) {
    it(`delete_devices soft ∥ success flood-${i}`, async () => {
      const db = createDevicesDb({
        devices: [
          seedDevice({ device_id: `KEEP-${i}` }),
          seedDevice({ device_id: `GONE-${i}` }),
        ],
      });
      const [badPw, missing, ok] = await Promise.all([
        devicesRequest(
          db,
          DELETE_DEVICES,
          jsonInit('POST', {
            devices: [`KEEP-${i}`],
            auth: { type: 'm.login.password', password: `bad-${i}` },
          })
        ),
        devicesRequest(
          db,
          DELETE_DEVICES,
          jsonInit('POST', {
            devices: null,
            auth: { type: 'm.login.password', password: PASS },
          })
        ),
        devicesRequest(
          db,
          DELETE_DEVICES,
          jsonInit('POST', {
            devices: [`GONE-${i}`],
            auth: { type: 'm.login.password', password: PASS },
          })
        ),
      ]);
      expect(badPw.body).toEqual(INVALID_PASSWORD);
      expect(missing.body).toEqual(MISSING_DEVICES);
      expect(ok.status).toBe(200);
      expect(db.devices.map((d) => d.device_id)).toEqual([`KEEP-${i}`]);
    });
  }
});

// ---------------------------------------------------------------------------
// device_signing password soft ∥ OAuth UIA soft under concurrent race
// ---------------------------------------------------------------------------

describe('keys soft residual fifth-wave password∥OAuth UIA race after #300', () => {
  it('Invalid password ∥ No password ∥ Missing auth.password ∥ OAuth expired under race', async () => {
    const cache = mockKv();
    const envPw = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
      }),
      cacheKv: cache,
    });
    const envNoPw = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        passwordHashes: new Map([[USER, null]]),
        idpLinkCounts: new Map([[USER, 0]]),
      }),
    });
    const [badPw, noPw, missingPw, expired] = await Promise.all([
      keysRequest(
        envPw,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'm.login.password', password: 'wrong' },
        }))
      ),
      keysRequest(
        envNoPw,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'm.login.password', password: 'x' },
        }))
      ),
      keysRequest(
        envPw,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'm.login.password' },
        }))
      ),
      keysRequest(
        envPw,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'm.oauth', session: 'gone' },
        }))
      ),
    ]);
    expect(badPw.body).toEqual(INVALID_PASSWORD);
    expect(noPw.body).toEqual(NO_PASSWORD);
    expect(missingPw.body).toEqual(MISSING_AUTH_PASSWORD);
    expect(expired.body).toEqual(UIA_EXPIRED);
  });

  it('password ok ∥ Invalid password ∥ OAuth mismatch ∥ OAuth expired under race', async () => {
    const cache = mockKv({
      'uia_session:mm': JSON.stringify({
        user_id: BOB,
        completed_stages: ['m.oauth'],
      }),
    });
    const env = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
        idpLinkCounts: new Map([[USER, 1]]),
      }),
      cacheKv: cache,
    });
    const [ok, badPw, mismatch, expired] = await Promise.all([
      keysRequest(
        env,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'm.login.password', password: PASS },
        }))
      ),
      keysRequest(
        env,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'm.login.password', password: 'nope' },
        }))
      ),
      keysRequest(
        env,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'm.login.oauth', session: 'mm' },
        }))
      ),
      keysRequest(
        env,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'm.login.sso', session: 'gone' },
        }))
      ),
    ]);
    expect(ok.status).toBe(200);
    expect(badPw.body).toEqual(INVALID_PASSWORD);
    expect(mismatch.body).toEqual(SESSION_MISMATCH);
    expect(expired.body).toEqual(UIA_EXPIRED);
    expect(cache.data['uia_session:mm']).toBeTruthy();
  });

  for (let i = 0; i < 8; i++) {
    it(`password soft ∥ OAuth UIA soft flood-${i}`, async () => {
      const cache = mockKv({
        [`uia_session:mm-${i}`]: JSON.stringify({
          user_id: BOB,
          completed_stages: ['m.oauth'],
        }),
      });
      const env = createKeysEnv({
        db: createKeysDb({
          crossSigningKeys: [existingMasterKey()],
          passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
          idpLinkCounts: new Map([[USER, 1]]),
        }),
        cacheKv: cache,
      });
      const softPw =
        i % 2 === 0
          ? masterKeyBody({
              auth: { type: 'm.login.password', password: `wrong-${i}` },
            })
          : masterKeyBody({
              auth: { type: 'm.login.password' },
            });
      const [pw, oauthSoft] = await Promise.all([
        keysRequest(env, DEVICE_SIGNING, jsonInit('POST', softPw)),
        keysRequest(
          env,
          DEVICE_SIGNING,
          jsonInit('POST', masterKeyBody({
            auth: {
              type: i % 2 === 0 ? 'm.oauth' : 'm.login.token',
              session: i % 3 === 0 ? `gone-${i}` : `mm-${i}`,
            },
          }))
        ),
      ]);
      if (i % 2 === 0) {
        expect(pw.body).toEqual(INVALID_PASSWORD);
      } else {
        expect(pw.body).toEqual(MISSING_AUTH_PASSWORD);
      }
      const oauthBody = oauthSoft.body as { error?: string };
      expect(
        oauthBody.error === UIA_EXPIRED.error || oauthBody.error === SESSION_MISMATCH.error
      ).toBe(true);
    });
  }

  it('empty-string password Missing auth.password ∥ No password ∥ OAuth expired triple', async () => {
    const envPw = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
      }),
    });
    const envNoPw = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        passwordHashes: new Map([[USER, null]]),
      }),
    });
    const [empty, noPw, expired] = await Promise.all([
      keysRequest(
        envPw,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'm.login.password', password: '' },
        }))
      ),
      keysRequest(
        envNoPw,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'm.login.password', password: 'x' },
        }))
      ),
      keysRequest(
        envPw,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'org.matrix.cross_signing_reset', session: 'gone' },
        }))
      ),
    ]);
    expect(empty.body).toEqual(MISSING_AUTH_PASSWORD);
    expect(noPw.body).toEqual(NO_PASSWORD);
    expect(expired.body).toEqual(UIA_EXPIRED);
  });
});
