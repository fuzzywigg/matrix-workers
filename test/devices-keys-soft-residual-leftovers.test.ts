/**
 * TOKENMAXX HEAVY leftovers after #265 — residual *devices + keys* soft
 * error-string binds unsaturated by:
 *   #259 devices-keys-residual-concurrent-race (TOCTOU / Promise.all races;
 *        no exact `error` string pins),
 *   #241/#154 devices-api-route-leftovers + keys-api-route-leftovers
 *        (errcode soft floods only — `M_NOT_FOUND` / `M_FORBIDDEN` /
 *        `M_UNRECOGNIZED` without message text),
 *   #257/#258 filters-appservice-auth-residual (filters error strings done;
 *        devices/keys left open).
 *
 * Gap table (why leftover):
 *   Device not found GET/PUT/DELETE          | leftovers assert errcode only
 *   Invalid password DELETE shapes           | errcode-only; missing user /
 *                                            | missing password share message
 *   delete_devices missing/null/not-array    | M_MISSING_PARAM without text
 *   PUT / delete_devices bad JSON            | default badJson message unbound
 *   upload device_keys user/device mismatch  | full interpolated error unbound
 *   device_signing password / UIA / OAuth    | No password / Invalid password /
 *                                            | auth.password / auth.session /
 *                                            | UIA expired / Session user /
 *                                            | Cross-signing not approved /
 *                                            | Unrecognized auth type text
 *   keys/changes missing from+to             | missingParam text unbound
 *   UIA challenge CACHE put contract         | expirationTtl + type unbound
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
    generateOpaqueId: vi.fn(async () => 'pinned-uia-session-16'),
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
const DEVICE_SIGNING = '/_matrix/client/v3/keys/device_signing/upload';
const KEYS_CHANGES = '/_matrix/client/v3/keys/changes';

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
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Devices — exact error-string binds
// ---------------------------------------------------------------------------

describe('devices soft residual Device not found binds after #259', () => {
  for (let i = 0; i < 6; i++) {
    it(`GET missing binds Device not found soft-${i}`, async () => {
      const db = createDevicesDb({ devices: [] });
      const res = await devicesRequest(db, `${DEVICES}/NOPE-${i}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        errcode: 'M_NOT_FOUND',
        error: 'Device not found',
      });
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`PUT missing binds Device not found soft-${i}`, async () => {
      const db = createDevicesDb({ devices: [] });
      const res = await devicesRequest(
        db,
        `${DEVICES}/NOPE-${i}`,
        jsonInit('PUT', { display_name: `x-${i}` })
      );
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        errcode: 'M_NOT_FOUND',
        error: 'Device not found',
      });
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`DELETE missing binds Device not found soft-${i}`, async () => {
      const db = createDevicesDb({ devices: [] });
      const res = await devicesRequest(db, `${DEVICES}/NOPE-${i}`, {
        method: 'DELETE',
        headers: AUTH,
      });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        errcode: 'M_NOT_FOUND',
        error: 'Device not found',
      });
    });
  }

  it('GET-missing∥DELETE-missing both bind Device not found under Promise.all', async () => {
    const db = createDevicesDb({ devices: [] });
    const [getRes, delRes] = await Promise.all([
      devicesRequest(db, `${DEVICES}/GONE-A`),
      devicesRequest(db, `${DEVICES}/GONE-B`, { method: 'DELETE', headers: AUTH }),
    ]);
    expect(getRes.body).toEqual({
      errcode: 'M_NOT_FOUND',
      error: 'Device not found',
    });
    expect(delRes.body).toEqual({
      errcode: 'M_NOT_FOUND',
      error: 'Device not found',
    });
  });
});

describe('devices soft residual Invalid password binds after #259', () => {
  for (let i = 0; i < 6; i++) {
    it(`DELETE wrong password binds Invalid password soft-${i}`, async () => {
      const db = createDevicesDb({ devices: [seedDevice({ device_id: `P${i}` })] });
      const res = await devicesRequest(
        db,
        `${DEVICES}/P${i}`,
        jsonInit('DELETE', {
          auth: { type: 'm.login.password', password: `wrong-${i}` },
        })
      );
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        errcode: 'M_FORBIDDEN',
        error: 'Invalid password',
      });
      expect(verifyPassword).toHaveBeenCalled();
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`DELETE m.login.password without password binds Invalid password soft-${i}`, async () => {
      const db = createDevicesDb({ devices: [seedDevice({ device_id: `Q${i}` })] });
      const res = await devicesRequest(
        db,
        `${DEVICES}/Q${i}`,
        jsonInit('DELETE', { auth: { type: 'm.login.password' } })
      );
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        errcode: 'M_FORBIDDEN',
        error: 'Invalid password',
      });
      expect(verifyPassword).not.toHaveBeenCalled();
    });
  }

  for (let i = 0; i < 4; i++) {
    it(`DELETE missing user row binds Invalid password soft-${i}`, async () => {
      const db = createDevicesDb({
        devices: [seedDevice({ device_id: `M${i}` })],
        missingUser: true,
      });
      const res = await devicesRequest(
        db,
        `${DEVICES}/M${i}`,
        jsonInit('DELETE', {
          auth: { type: 'm.login.password', password: PASS },
        })
      );
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        errcode: 'M_FORBIDDEN',
        error: 'Invalid password',
      });
      expect(verifyPassword).not.toHaveBeenCalled();
    });
  }
});

describe('devices soft residual delete_devices + bad JSON binds after #259', () => {
  const missingShapes: Array<{ label: string; body: unknown }> = [
    { label: 'omit', body: { auth: { type: 'm.login.password', password: PASS } } },
    { label: 'null', body: { devices: null, auth: { type: 'm.login.password', password: PASS } } },
    { label: 'string', body: { devices: 'PHONE', auth: { type: 'm.login.password', password: PASS } } },
    { label: 'object', body: { devices: { id: 'PHONE' }, auth: { type: 'm.login.password', password: PASS } } },
  ];

  for (let i = 0; i < missingShapes.length; i++) {
    const shape = missingShapes[i];
    it(`delete_devices ${shape.label} devices binds Missing required parameter: devices soft-${i}`, async () => {
      const db = createDevicesDb({ devices: [seedDevice()] });
      const res = await devicesRequest(db, DELETE_DEVICES, jsonInit('POST', shape.body));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        errcode: 'M_MISSING_PARAM',
        error: 'Missing required parameter: devices',
      });
    });
  }

  for (let i = 0; i < 4; i++) {
    it(`PUT bad JSON binds Could not parse request body as JSON soft-${i}`, async () => {
      const db = createDevicesDb({ devices: [seedDevice({ device_id: `B${i}` })] });
      const res = await devicesRequest(db, `${DEVICES}/B${i}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: `{not-json-${i}`,
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        errcode: 'M_BAD_JSON',
        error: 'Could not parse request body as JSON',
      });
    });
  }

  for (let i = 0; i < 4; i++) {
    it(`delete_devices bad JSON binds Could not parse request body as JSON soft-${i}`, async () => {
      const db = createDevicesDb({ devices: [seedDevice()] });
      const res = await devicesRequest(db, DELETE_DEVICES, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: `{bad-delete-${i}`,
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        errcode: 'M_BAD_JSON',
        error: 'Could not parse request body as JSON',
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Keys — exact error-string binds
// ---------------------------------------------------------------------------

describe('keys soft residual upload mismatch bind after #259', () => {
  for (let i = 0; i < 6; i++) {
    it(`upload user/device mismatch binds full interpolated error soft-${i}`, async () => {
      const env = createKeysEnv();
      const res = await keysRequest(
        env,
        KEYS_UPLOAD,
        jsonInit('POST', {
          device_keys: {
            user_id: BOB,
            device_id: `OTHER-${i}`,
            algorithms: [],
            keys: {},
            signatures: {},
          },
        })
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        errcode: 'M_INVALID_PARAM',
        error:
          `device_keys.user_id and device_keys.device_id must match authenticated user. ` +
          `Got user_id=${BOB} (expected ${USER}), device_id=OTHER-${i} (expected ${DEVICE})`,
      });
    });
  }
});

describe('keys soft residual device_signing password binds after #259', () => {
  for (let i = 0; i < 6; i++) {
    it(`device_signing no password hash binds No password set for user soft-${i}`, async () => {
      const env = createKeysEnv({
        db: createKeysDb({
          crossSigningKeys: [existingMasterKey()],
          // passwordHashes empty → getPasswordHash null
        }),
      });
      const res = await keysRequest(
        env,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'm.login.password', password: PASS },
          master_key: {
            user_id: USER,
            usage: ['master'],
            keys: { 'ed25519:master': `nopw-${i}` },
          },
        }))
      );
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        errcode: 'M_FORBIDDEN',
        error: 'No password set for user',
      });
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`device_signing bad password binds Invalid password soft-${i}`, async () => {
      const env = createKeysEnv({
        db: createKeysDb({
          crossSigningKeys: [existingMasterKey()],
          passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
        }),
      });
      const res = await keysRequest(
        env,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'm.login.password', password: `wrong-${i}` },
        }))
      );
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        errcode: 'M_FORBIDDEN',
        error: 'Invalid password',
      });
    });
  }

  for (let i = 0; i < 4; i++) {
    it(`device_signing missing auth.password binds Missing required parameter soft-${i}`, async () => {
      const env = createKeysEnv({
        db: createKeysDb({
          crossSigningKeys: [existingMasterKey()],
          passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
        }),
      });
      const res = await keysRequest(
        env,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'm.login.password' },
        }))
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        errcode: 'M_MISSING_PARAM',
        error: 'Missing required parameter: auth.password',
      });
    });
  }

  for (let i = 0; i < 4; i++) {
    it(`device_signing empty-string password binds Missing required parameter soft-${i}`, async () => {
      const env = createKeysEnv({
        db: createKeysDb({
          crossSigningKeys: [existingMasterKey()],
          passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
        }),
      });
      const res = await keysRequest(
        env,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'm.login.password', password: '' },
        }))
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        errcode: 'M_MISSING_PARAM',
        error: 'Missing required parameter: auth.password',
      });
    });
  }
});

describe('keys soft residual device_signing UIA/OAuth binds after #259', () => {
  for (let i = 0; i < 4; i++) {
    it(`OAuth-style auth missing session binds auth.session soft-${i}`, async () => {
      const env = createKeysEnv({
        db: createKeysDb({
          crossSigningKeys: [existingMasterKey()],
          idpLinkCounts: new Map([[USER, 1]]),
        }),
      });
      const res = await keysRequest(
        env,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'org.matrix.cross_signing_reset' },
        }))
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        errcode: 'M_MISSING_PARAM',
        error: 'Missing required parameter: auth.session',
      });
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`missing/expired UIA session binds exact text soft-${i}`, async () => {
      const env = createKeysEnv({
        db: createKeysDb({
          crossSigningKeys: [existingMasterKey()],
          idpLinkCounts: new Map([[USER, 1]]),
        }),
      });
      const res = await keysRequest(
        env,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: {
            type: 'org.matrix.cross_signing_reset',
            session: `expired-${i}`,
          },
        }))
      );
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        errcode: 'M_UNKNOWN',
        error: 'UIA session not found or expired',
      });
    });
  }

  for (let i = 0; i < 4; i++) {
    it(`session user_id mismatch binds Session user mismatch soft-${i}`, async () => {
      const cache = mockKv({
        [`uia_session:sess-${i}`]: JSON.stringify({
          user_id: BOB,
          created_at: Date.now(),
          type: 'device_signing_upload',
          completed_stages: ['org.matrix.cross_signing_reset'],
          is_oidc_user: true,
          has_password: false,
        }),
      });
      const env = createKeysEnv({
        db: createKeysDb({
          crossSigningKeys: [existingMasterKey()],
          idpLinkCounts: new Map([[USER, 1]]),
        }),
        cacheKv: cache,
      });
      const res = await keysRequest(
        env,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: {
            type: 'org.matrix.cross_signing_reset',
            session: `sess-${i}`,
          },
        }))
      );
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        errcode: 'M_FORBIDDEN',
        error: 'Session user mismatch',
      });
    });
  }

  for (let i = 0; i < 4; i++) {
    it(`incomplete completed_stages binds Cross-signing reset not approved soft-${i}`, async () => {
      const cache = mockKv({
        [`uia_session:pend-${i}`]: JSON.stringify({
          user_id: USER,
          created_at: Date.now(),
          type: 'device_signing_upload',
          completed_stages: [],
          is_oidc_user: true,
          has_password: false,
        }),
      });
      const env = createKeysEnv({
        db: createKeysDb({
          crossSigningKeys: [existingMasterKey()],
          idpLinkCounts: new Map([[USER, 1]]),
        }),
        cacheKv: cache,
      });
      const res = await keysRequest(
        env,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: {
            type: 'org.matrix.cross_signing_reset',
            session: `pend-${i}`,
          },
        }))
      );
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        errcode: 'M_UNAUTHORIZED',
        error:
          'Cross-signing reset not approved. Please approve the request at the provided URL.',
      });
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`unrecognized auth type binds Unrecognized auth type soft-${i}`, async () => {
      const env = createKeysEnv({
        db: createKeysDb({
          crossSigningKeys: [existingMasterKey()],
          passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
        }),
      });
      const res = await keysRequest(
        env,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'm.login.email' },
        }))
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        errcode: 'M_UNRECOGNIZED',
        error: 'Unrecognized auth type: m.login.email',
      });
    });
  }
});

describe('keys soft residual changes + UIA challenge CACHE after #259', () => {
  for (let i = 0; i < 6; i++) {
    it(`keys/changes without from/to binds Missing required parameter soft-${i}`, async () => {
      const env = createKeysEnv();
      const path =
        i % 3 === 0
          ? KEYS_CHANGES
          : i % 3 === 1
            ? `${KEYS_CHANGES}?from=1`
            : `${KEYS_CHANGES}?to=10`;
      const res = await keysRequest(env, path);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        errcode: 'M_MISSING_PARAM',
        error: 'Missing required parameter: from and to required',
      });
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`UIA challenge CACHE put binds expirationTtl 300 + type soft-${i}`, async () => {
      const cache = mockKv();
      const env = createKeysEnv({
        db: createKeysDb({
          crossSigningKeys: [existingMasterKey()],
          passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
        }),
        cacheKv: cache,
      });
      const res = await keysRequest(
        env,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          master_key: {
            user_id: USER,
            usage: ['master'],
            keys: { 'ed25519:master': `uia-${i}` },
          },
        }))
      );
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        session: 'pinned-uia-session-16',
        flows: expect.arrayContaining([{ stages: ['m.login.password'] }]),
      });
      const put = cache.puts.find((p) => p.key === 'uia_session:pinned-uia-session-16');
      expect(put).toBeDefined();
      expect(put!.options).toEqual({ expirationTtl: 300 });
      const stored = JSON.parse(put!.value) as {
        user_id: string;
        type: string;
        completed_stages: unknown[];
      };
      expect(stored).toMatchObject({
        user_id: USER,
        type: 'device_signing_upload',
        completed_stages: [],
      });
    });
  }
});
