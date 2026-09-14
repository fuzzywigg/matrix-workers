/**
 * TOKENMAXX HEAVY leftovers after #276 — residual *devices + keys* soft
 * error-string binds unsaturated by:
 *   #269 devices-keys-soft-residual-leftovers (single-device DELETE /
 *        device_signing / upload mismatch / keys/changes / UIA CACHE;
 *        no delete_devices Invalid password; no keys-route badJson;
 *        no SSO/token submit exact texts; no signature-failure soft flood),
 *   #259 devices-keys-residual-concurrent-race (TOCTOU races; no exact
 *        `error` string pins),
 *   #241/#154 leftovers (errcode soft floods without message text).
 *
 * Gap table (why leftover after #269):
 *   delete_devices Invalid password shapes   | #269 only single DELETE
 *   DELETE empty-string password              | leftovers errcode-only
 *   keys upload/query/claim/signing/sig/token | badJson default text unbound
 *     bad JSON
 *   SSO redirect missing session              | routes MatchObject errcode
 *   SSO redirect expired UIA                  | routes MatchObject errcode
 *   token/submit session falsy / expired /    | errcode-only in routes
 *     user mismatch / bad JSON
 *   signatures/upload insert throw            | unit once; no soft flood
 *   upload user-only ∥ device-only mismatch   | #269 only dual mismatch
 *   keys/changes empty-string from/to         | #269 only absent params
 *   OAuth auth-type matrix missing session    | #269 one OAuth-style type
 *
 * Tests-only. Fixtures use example.com only. Reversible by deleting this file.
 * No product inventing / secrets / DNS.
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
    generateOpaqueId: vi.fn(async () => 'pinned-uia-session-sw'),
  };
});

import devicesApp from '../src/api/devices';
import keysApp from '../src/api/keys';
import { verifyPassword } from '../src/utils/crypto';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const DEVICE = 'DEVICEA';
const SERVER = 'example.com';
const PASS = 's3cret';
const AUTH = { Authorization: 'Bearer test-token' };
const DEVICES = '/_matrix/client/v3/devices';
const DELETE_DEVICES = '/_matrix/client/v3/delete_devices';
const KEYS_UPLOAD = '/_matrix/client/v3/keys/upload';
const KEYS_QUERY = '/_matrix/client/v3/keys/query';
const KEYS_CLAIM = '/_matrix/client/v3/keys/claim';
const DEVICE_SIGNING = '/_matrix/client/v3/keys/device_signing/upload';
const SIGNATURES = '/_matrix/client/v3/keys/signatures/upload';
const KEYS_CHANGES = '/_matrix/client/v3/keys/changes';
const SSO_REDIRECT = '/_matrix/client/v3/auth/m.login.sso/redirect';
const TOKEN_SUBMIT = '/_matrix/client/v3/auth/m.login.token/submit';

const BAD_JSON_ERROR = {
  errcode: 'M_BAD_JSON',
  error: 'Could not parse request body as JSON',
} as const;

const INVALID_PASSWORD = {
  errcode: 'M_FORBIDDEN',
  error: 'Invalid password',
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
  throwOnSignatureInsert?: boolean;
} = {}) {
  const crossSigningKeys = opts.crossSigningKeys ?? [];
  const passwordHashes = opts.passwordHashes ?? new Map<string, string | null>();
  const idpLinkCounts = opts.idpLinkCounts ?? new Map<string, number>();
  const streamPositions: Record<string, number> = { device_keys: 10 };
  const throwOnSignatureInsert = opts.throwOnSignatureInsert ?? false;

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
              if (sql.includes('INSERT INTO cross_signing_signatures')) {
                if (throwOnSignatureInsert) {
                  throw new Error('signature insert failed');
                }
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (
                sql.includes('INSERT INTO device_key_changes') ||
                sql.includes('INSERT INTO one_time_keys') ||
                sql.includes('INSERT INTO fallback_keys') ||
                sql.includes('INSERT INTO cross_signing_keys')
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
  } as unknown as Env & {
    _cache: ReturnType<typeof mockKv>;
    _db: KeysDb;
  };
}

async function keysRequest(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
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

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...AUTH },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function rawBadJson(method: string): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...AUTH },
    body: `{not-json-${method}`,
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

function mismatchError(userId: string, deviceId: string): string {
  return `device_keys.user_id and device_keys.device_id must match authenticated user. Got user_id=${userId} (expected ${USER}), device_id=${deviceId} (expected ${DEVICE})`;
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
// Devices — delete_devices + empty-string DELETE Invalid password
// ---------------------------------------------------------------------------

describe('devices soft residual delete_devices Invalid password after #269', () => {
  for (let i = 0; i < 8; i++) {
    it(`delete_devices wrong password binds Invalid password soft-${i}`, async () => {
      const db = createDevicesDb({ devices: [seedDevice({ device_id: `W${i}` })] });
      const res = await devicesRequest(
        db,
        DELETE_DEVICES,
        jsonInit('POST', {
          devices: [`W${i}`],
          auth: { type: 'm.login.password', password: `wrong-${i}` },
        })
      );
      expect(res.status).toBe(403);
      expect(res.body).toEqual(INVALID_PASSWORD);
      expect(vi.mocked(verifyPassword)).toHaveBeenCalled();
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`delete_devices m.login.password without password binds Invalid password soft-${i}`, async () => {
      const db = createDevicesDb({ devices: [seedDevice({ device_id: `N${i}` })] });
      const res = await devicesRequest(
        db,
        DELETE_DEVICES,
        jsonInit('POST', {
          devices: [`N${i}`],
          auth: { type: 'm.login.password' },
        })
      );
      expect(res.status).toBe(403);
      expect(res.body).toEqual(INVALID_PASSWORD);
      expect(vi.mocked(verifyPassword)).not.toHaveBeenCalled();
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`delete_devices empty-string password binds Invalid password soft-${i}`, async () => {
      const db = createDevicesDb({ devices: [seedDevice({ device_id: `E${i}` })] });
      const res = await devicesRequest(
        db,
        DELETE_DEVICES,
        jsonInit('POST', {
          devices: [`E${i}`],
          auth: { type: 'm.login.password', password: '' },
        })
      );
      expect(res.status).toBe(403);
      expect(res.body).toEqual(INVALID_PASSWORD);
      expect(vi.mocked(verifyPassword)).not.toHaveBeenCalled();
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`delete_devices missing user row binds Invalid password soft-${i}`, async () => {
      const db = createDevicesDb({
        devices: [seedDevice({ device_id: `M${i}` })],
        missingUser: true,
      });
      const res = await devicesRequest(
        db,
        DELETE_DEVICES,
        jsonInit('POST', {
          devices: [`M${i}`],
          auth: { type: 'm.login.password', password: PASS },
        })
      );
      expect(res.status).toBe(403);
      expect(res.body).toEqual(INVALID_PASSWORD);
      expect(vi.mocked(verifyPassword)).not.toHaveBeenCalled();
    });
  }

  it('delete_devices wrong∥empty∥missing-user all bind Invalid password under Promise.all', async () => {
    const dbWrong = createDevicesDb({ devices: [seedDevice({ device_id: 'R1' })] });
    const dbEmpty = createDevicesDb({ devices: [seedDevice({ device_id: 'R2' })] });
    const dbMissing = createDevicesDb({
      devices: [seedDevice({ device_id: 'R3' })],
      missingUser: true,
    });
    const [a, b, c] = await Promise.all([
      devicesRequest(
        dbWrong,
        DELETE_DEVICES,
        jsonInit('POST', {
          devices: ['R1'],
          auth: { type: 'm.login.password', password: 'nope' },
        })
      ),
      devicesRequest(
        dbEmpty,
        DELETE_DEVICES,
        jsonInit('POST', {
          devices: ['R2'],
          auth: { type: 'm.login.password', password: '' },
        })
      ),
      devicesRequest(
        dbMissing,
        DELETE_DEVICES,
        jsonInit('POST', {
          devices: ['R3'],
          auth: { type: 'm.login.password', password: PASS },
        })
      ),
    ]);
    expect(a.body).toEqual(INVALID_PASSWORD);
    expect(b.body).toEqual(INVALID_PASSWORD);
    expect(c.body).toEqual(INVALID_PASSWORD);
  });
});

describe('devices soft residual DELETE empty-string password after #269', () => {
  for (let i = 0; i < 8; i++) {
    it(`DELETE empty-string password binds Invalid password soft-${i}`, async () => {
      const db = createDevicesDb({ devices: [seedDevice({ device_id: `D${i}` })] });
      const res = await devicesRequest(
        db,
        `${DEVICES}/D${i}`,
        jsonInit('DELETE', {
          auth: { type: 'm.login.password', password: '' },
        })
      );
      expect(res.status).toBe(403);
      expect(res.body).toEqual(INVALID_PASSWORD);
      expect(vi.mocked(verifyPassword)).not.toHaveBeenCalled();
    });
  }

  it('DELETE empty-string∥wrong password both bind Invalid password under Promise.all', async () => {
    const dbA = createDevicesDb({ devices: [seedDevice({ device_id: 'PA' })] });
    const dbB = createDevicesDb({ devices: [seedDevice({ device_id: 'PB' })] });
    const [empty, wrong] = await Promise.all([
      devicesRequest(
        dbA,
        `${DEVICES}/PA`,
        jsonInit('DELETE', { auth: { type: 'm.login.password', password: '' } })
      ),
      devicesRequest(
        dbB,
        `${DEVICES}/PB`,
        jsonInit('DELETE', { auth: { type: 'm.login.password', password: 'x' } })
      ),
    ]);
    expect(empty.body).toEqual(INVALID_PASSWORD);
    expect(wrong.body).toEqual(INVALID_PASSWORD);
  });
});

// ---------------------------------------------------------------------------
// Keys — badJson default message across routes #269 left unbound
// ---------------------------------------------------------------------------

describe('keys soft residual badJson binds after #269', () => {
  const routes: { label: string; path: string }[] = [
    { label: 'upload', path: KEYS_UPLOAD },
    { label: 'query', path: KEYS_QUERY },
    { label: 'claim', path: KEYS_CLAIM },
    { label: 'device_signing', path: DEVICE_SIGNING },
    { label: 'signatures', path: SIGNATURES },
    { label: 'token_submit', path: TOKEN_SUBMIT },
  ];

  for (const route of routes) {
    for (let i = 0; i < 4; i++) {
      it(`${route.label} bad JSON binds Could not parse soft-${i}`, async () => {
        const env = createKeysEnv();
        const res = await keysRequest(env, route.path, rawBadJson('POST'));
        expect(res.status).toBe(400);
        expect(res.body).toEqual(BAD_JSON_ERROR);
      });
    }
  }

  it('upload∥query∥claim∥signing bad JSON all bind under Promise.all', async () => {
    const env = createKeysEnv();
    const results = await Promise.all([
      keysRequest(env, KEYS_UPLOAD, rawBadJson('POST')),
      keysRequest(env, KEYS_QUERY, rawBadJson('POST')),
      keysRequest(env, KEYS_CLAIM, rawBadJson('POST')),
      keysRequest(env, DEVICE_SIGNING, rawBadJson('POST')),
      keysRequest(env, SIGNATURES, rawBadJson('POST')),
      keysRequest(env, TOKEN_SUBMIT, rawBadJson('POST')),
    ]);
    for (const res of results) {
      expect(res.status).toBe(400);
      expect(res.body).toEqual(BAD_JSON_ERROR);
    }
  });
});

// ---------------------------------------------------------------------------
// Keys — upload user-only / device-only mismatch interpolations
// ---------------------------------------------------------------------------

describe('keys soft residual upload split mismatch binds after #269', () => {
  for (let i = 0; i < 6; i++) {
    it(`upload user-only mismatch binds full interpolated error soft-${i}`, async () => {
      const env = createKeysEnv();
      const badUser = `@eve-${i}:example.com`;
      const res = await keysRequest(
        env,
        KEYS_UPLOAD,
        jsonInit('POST', {
          device_keys: {
            user_id: badUser,
            device_id: DEVICE,
            algorithms: ['m.olm.v1.curve25519-aes-sha2'],
            keys: {},
            signatures: {},
          },
        })
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        errcode: 'M_INVALID_PARAM',
        error: mismatchError(badUser, DEVICE),
      });
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`upload device-only mismatch binds full interpolated error soft-${i}`, async () => {
      const env = createKeysEnv();
      const badDevice = `OTHER${i}`;
      const res = await keysRequest(
        env,
        KEYS_UPLOAD,
        jsonInit('POST', {
          device_keys: {
            user_id: USER,
            device_id: badDevice,
            algorithms: ['m.olm.v1.curve25519-aes-sha2'],
            keys: {},
            signatures: {},
          },
        })
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        errcode: 'M_INVALID_PARAM',
        error: mismatchError(USER, badDevice),
      });
    });
  }

  it('user-only∥device-only mismatch both bind under Promise.all', async () => {
    const env = createKeysEnv();
    const [userOnly, deviceOnly] = await Promise.all([
      keysRequest(
        env,
        KEYS_UPLOAD,
        jsonInit('POST', {
          device_keys: {
            user_id: BOB,
            device_id: DEVICE,
            algorithms: [],
            keys: {},
            signatures: {},
          },
        })
      ),
      keysRequest(
        env,
        KEYS_UPLOAD,
        jsonInit('POST', {
          device_keys: {
            user_id: USER,
            device_id: 'OTHER',
            algorithms: [],
            keys: {},
            signatures: {},
          },
        })
      ),
    ]);
    expect(userOnly.body).toEqual({
      errcode: 'M_INVALID_PARAM',
      error: mismatchError(BOB, DEVICE),
    });
    expect(deviceOnly.body).toEqual({
      errcode: 'M_INVALID_PARAM',
      error: mismatchError(USER, 'OTHER'),
    });
  });
});

// ---------------------------------------------------------------------------
// Keys — changes empty-string from/to (falsy residual)
// ---------------------------------------------------------------------------

describe('keys soft residual changes empty-string from/to after #269', () => {
  const shapes = [
    { label: 'empty from', path: `${KEYS_CHANGES}?from=&to=10` },
    { label: 'empty to', path: `${KEYS_CHANGES}?from=1&to=` },
    { label: 'both empty', path: `${KEYS_CHANGES}?from=&to=` },
  ];

  for (const shape of shapes) {
    for (let i = 0; i < 4; i++) {
      it(`keys/changes ${shape.label} binds Missing required parameter soft-${i}`, async () => {
        const env = createKeysEnv();
        const res = await keysRequest(env, shape.path);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({
          errcode: 'M_MISSING_PARAM',
          error: 'Missing required parameter: from and to required',
        });
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Keys — OAuth auth-type matrix missing session
// ---------------------------------------------------------------------------

describe('keys soft residual OAuth auth-type session matrix after #269', () => {
  const authTypes = [
    'org.matrix.cross_signing_reset',
    'm.oauth',
    'm.login.oauth',
    'm.login.sso',
    'm.login.token',
    undefined,
  ] as const;

  for (const authType of authTypes) {
    for (let i = 0; i < 3; i++) {
      const label = authType === undefined ? 'no-type' : authType;
      it(`device_signing ${label} missing session binds auth.session soft-${i}`, async () => {
        const env = createKeysEnv({
          db: createKeysDb({
            crossSigningKeys: [existingMasterKey()],
            passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
          }),
        });
        const auth =
          authType === undefined
            ? {}
            : { type: authType };
        const res = await keysRequest(
          env,
          DEVICE_SIGNING,
          jsonInit('POST', masterKeyBody({ auth }))
        );
        expect(res.status).toBe(400);
        expect(res.body).toEqual({
          errcode: 'M_MISSING_PARAM',
          error: 'Missing required parameter: auth.session',
        });
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Keys — signatures/upload Failed to store signature soft flood
// ---------------------------------------------------------------------------

describe('keys soft residual signatures failure bind after #269', () => {
  for (let i = 0; i < 8; i++) {
    it(`signatures insert throw binds Failed to store signature soft-${i}`, async () => {
      const env = createKeysEnv({
        db: createKeysDb({ throwOnSignatureInsert: true }),
      });
      const keyId = `key-${i}`;
      const res = await keysRequest(
        env,
        SIGNATURES,
        jsonInit('POST', {
          [BOB]: {
            [keyId]: {
              signatures: { [USER]: { 'ed25519:usk': `sig-${i}` } },
            },
          },
        })
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        failures: {
          [BOB]: {
            [keyId]: { errcode: 'M_UNKNOWN', error: 'Failed to store signature' },
          },
        },
      });
    });
  }

  it('two concurrent signature throws both bind Failed to store signature', async () => {
    const envA = createKeysEnv({ db: createKeysDb({ throwOnSignatureInsert: true }) });
    const envB = createKeysEnv({ db: createKeysDb({ throwOnSignatureInsert: true }) });
    const [a, b] = await Promise.all([
      keysRequest(
        envA,
        SIGNATURES,
        jsonInit('POST', {
          [BOB]: { kA: { signatures: { [USER]: { 'ed25519:usk': 'a' } } } },
        })
      ),
      keysRequest(
        envB,
        SIGNATURES,
        jsonInit('POST', {
          [BOB]: { kB: { signatures: { [USER]: { 'ed25519:usk': 'b' } } } },
        })
      ),
    ]);
    expect(a.body).toEqual({
      failures: {
        [BOB]: { kA: { errcode: 'M_UNKNOWN', error: 'Failed to store signature' } },
      },
    });
    expect(b.body).toEqual({
      failures: {
        [BOB]: { kB: { errcode: 'M_UNKNOWN', error: 'Failed to store signature' } },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Keys — SSO redirect + token/submit exact soft residual texts
// ---------------------------------------------------------------------------

describe('keys soft residual SSO redirect binds after #269', () => {
  for (let i = 0; i < 8; i++) {
    it(`SSO redirect missing session binds Missing session parameter soft-${i}`, async () => {
      const env = createKeysEnv();
      const path = i % 2 === 0 ? SSO_REDIRECT : `${SSO_REDIRECT}?redirectUrl=https://client.example/done`;
      const res = await keysRequest(env, path);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        errcode: 'M_MISSING_PARAM',
        error: 'Missing session parameter',
      });
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`SSO redirect expired UIA binds exact text soft-${i}`, async () => {
      const env = createKeysEnv();
      const res = await keysRequest(env, `${SSO_REDIRECT}?session=gone-${i}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        errcode: 'M_UNKNOWN',
        error: 'UIA session not found or expired',
      });
    });
  }

  it('SSO missing∥expired both bind under Promise.all', async () => {
    const env = createKeysEnv();
    const [missing, expired] = await Promise.all([
      keysRequest(env, SSO_REDIRECT),
      keysRequest(env, `${SSO_REDIRECT}?session=nope`),
    ]);
    expect(missing.body).toEqual({
      errcode: 'M_MISSING_PARAM',
      error: 'Missing session parameter',
    });
    expect(expired.body).toEqual({
      errcode: 'M_UNKNOWN',
      error: 'UIA session not found or expired',
    });
  });
});

describe('keys soft residual token/submit binds after #269', () => {
  const falsySessions: { label: string; body: Record<string, unknown> }[] = [
    { label: 'omit', body: {} },
    { label: 'null', body: { session: null } },
    { label: 'empty', body: { session: '' } },
    { label: 'false', body: { session: false } },
    { label: 'zero', body: { session: 0 } },
  ];

  for (const shape of falsySessions) {
    for (let i = 0; i < 3; i++) {
      it(`token/submit ${shape.label} session binds Missing required parameter soft-${i}`, async () => {
        const env = createKeysEnv();
        const res = await keysRequest(env, TOKEN_SUBMIT, jsonInit('POST', shape.body));
        expect(res.status).toBe(400);
        expect(res.body).toEqual({
          errcode: 'M_MISSING_PARAM',
          error: 'Missing required parameter: session',
        });
      });
    }
  }

  for (let i = 0; i < 6; i++) {
    it(`token/submit expired UIA binds exact text soft-${i}`, async () => {
      const env = createKeysEnv();
      const res = await keysRequest(
        env,
        TOKEN_SUBMIT,
        jsonInit('POST', { session: `missing-${i}` })
      );
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        errcode: 'M_UNKNOWN',
        error: 'UIA session not found or expired',
      });
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`token/submit session user mismatch binds Session user mismatch soft-${i}`, async () => {
      const cache = mockKv({
        [`uia_session:tok-${i}`]: JSON.stringify({
          user_id: BOB,
          completed_stages: [],
        }),
      });
      const env = createKeysEnv({ cacheKv: cache });
      const res = await keysRequest(
        env,
        TOKEN_SUBMIT,
        jsonInit('POST', { session: `tok-${i}` })
      );
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        errcode: 'M_FORBIDDEN',
        error: 'Session user mismatch',
      });
    });
  }

  it('token falsy∥expired∥mismatch all bind under Promise.all', async () => {
    const cache = mockKv({
      'uia_session:race-m': JSON.stringify({ user_id: BOB, completed_stages: [] }),
    });
    const env = createKeysEnv({ cacheKv: cache });
    const [falsy, expired, mismatch] = await Promise.all([
      keysRequest(env, TOKEN_SUBMIT, jsonInit('POST', { session: '' })),
      keysRequest(env, TOKEN_SUBMIT, jsonInit('POST', { session: 'gone' })),
      keysRequest(env, TOKEN_SUBMIT, jsonInit('POST', { session: 'race-m' })),
    ]);
    expect(falsy.body).toEqual({
      errcode: 'M_MISSING_PARAM',
      error: 'Missing required parameter: session',
    });
    expect(expired.body).toEqual({
      errcode: 'M_UNKNOWN',
      error: 'UIA session not found or expired',
    });
    expect(mismatch.body).toEqual({
      errcode: 'M_FORBIDDEN',
      error: 'Session user mismatch',
    });
  });
});
