/**
 * TOKENMAXX HEAVY leftovers after #303 fifth-wave / tip past #300 —
 * residual *devices + keys* soft→*concurrent-race* sixth-wave binds
 * unsaturated by:
 *   #303 fifth-wave (devices soft multi-error ∥ password∥OAuth UIA;
 *        no Unrecognized auth type under race; no UIA *challenge*
 *        401 flows under multi-error matrix),
 *   #293/#280 third-wave (Unrecognized sequential matrix only;
 *        OIDC UIA challenge sequential soft floods),
 *   #269/#265 soft residual (sequential Device not found / Invalid
 *        password pins; limited Promise.all pairs).
 *
 * Gap table (why leftover after fifth-wave):
 *   Unrecognized auth type ∥ Device not found ∥ Invalid password ∥
 *     delete success under Promise.all
 *     | #293 sequential Unrecognized only
 *   DELETE UIA challenge (401 flows) ∥ soft multi-error ∥ success
 *     | routes/leftovers sequential; fifth-wave never raced challenge
 *   Unrecognized ∥ Cross-signing not approved ∥ Device not found
 *     under race
 *     | fourth-wave OAuth UIA soft flood without devices soft
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
    generateOpaqueId: vi.fn(async () => 'pinned-uia-session-fw6'),
  };
});

import devicesApp from '../src/api/devices';
import keysApp from '../src/api/keys';
import { verifyPassword } from '../src/utils/crypto';

const USER = '@alice:example.com';
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

const CROSS_SIGNING_NOT_APPROVED = {
  errcode: 'M_UNAUTHORIZED',
  error: 'Cross-signing reset not approved. Please approve the request at the provided URL.',
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
// Unrecognized auth type ∥ devices soft multi-error ∥ delete success
// ---------------------------------------------------------------------------

describe('devices soft residual sixth-wave Unrecognized∥devices soft race after #303', () => {
  const unrecognizedTypes = [
    'm.login.email',
    'm.login.dummy',
    'm.login.application_service',
    'org.example.custom',
  ] as const;

  it('Unrecognized ∥ Device not found ∥ Invalid password ∥ delete ok under race', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'KEEP' }), seedDevice({ device_id: 'DEL' })],
    });
    const keysEnv = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
      }),
    });
    const [unrec, notFound, badPw, ok] = await Promise.all([
      keysRequest(
        keysEnv,
        DEVICE_SIGNING,
        jsonInit(
          'POST',
          masterKeyBody({
            auth: { type: 'm.login.email' },
          })
        )
      ),
      devicesRequest(db, `${DEVICES}/MISSING`, { method: 'GET', headers: AUTH }),
      devicesRequest(
        db,
        `${DEVICES}/KEEP`,
        jsonInit('DELETE', {
          auth: { type: 'm.login.password', password: 'wrong' },
        })
      ),
      devicesRequest(
        db,
        `${DEVICES}/DEL`,
        jsonInit('DELETE', {
          auth: { type: 'm.login.password', password: PASS },
        })
      ),
    ]);
    expect(unrec.status).toBe(400);
    expect(unrec.body).toEqual(unrecognizedBody('m.login.email'));
    expect(notFound.body).toEqual(DEVICE_NOT_FOUND);
    expect(badPw.body).toEqual(INVALID_PASSWORD);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({});
    expect(db.devices.some((d) => d.device_id === 'KEEP')).toBe(true);
    expect(db.devices.some((d) => d.device_id === 'DEL')).toBe(false);
  });

  it('four Unrecognized types all bind under race with Missing devices', async () => {
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'KEEP' })] });
    const keysEnv = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
      }),
    });
    const results = await Promise.all([
      ...unrecognizedTypes.map((authType) =>
        keysRequest(
          keysEnv,
          DEVICE_SIGNING,
          jsonInit(
            'POST',
            masterKeyBody({
              auth: { type: authType },
            })
          )
        )
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
    for (let i = 0; i < unrecognizedTypes.length; i++) {
      expect(results[i].body).toEqual(unrecognizedBody(unrecognizedTypes[i]));
    }
    expect(results[unrecognizedTypes.length].body).toEqual(MISSING_DEVICES);
  });

  for (let i = 0; i < 8; i++) {
    it(`Unrecognized ∥ devices soft ∥ success flood-${i}`, async () => {
      const authType = unrecognizedTypes[i % unrecognizedTypes.length];
      const delId = `DEL-${i}`;
      const keepId = `KEEP-${i}`;
      const db = createDevicesDb({
        devices: [seedDevice({ device_id: keepId }), seedDevice({ device_id: delId })],
      });
      const keysEnv = createKeysEnv({
        db: createKeysDb({
          crossSigningKeys: [existingMasterKey()],
          passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
        }),
      });
      const [unrec, notFound, badJson, ok] = await Promise.all([
        keysRequest(
          keysEnv,
          DEVICE_SIGNING,
          jsonInit(
            'POST',
            masterKeyBody({
              auth: { type: authType },
            })
          )
        ),
        devicesRequest(db, `${DEVICES}/MISS-${i}`, { method: 'GET', headers: AUTH }),
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
      expect(unrec.body).toEqual(unrecognizedBody(authType));
      expect(notFound.body).toEqual(DEVICE_NOT_FOUND);
      expect(badJson.body).toEqual(BAD_JSON);
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({});
    });
  }
});

// ---------------------------------------------------------------------------
// DELETE UIA challenge (401 flows) ∥ soft multi-error ∥ success
// ---------------------------------------------------------------------------

describe('devices soft residual sixth-wave UIA challenge race after #303', () => {
  it('UIA challenge ∥ Device not found ∥ Invalid password ∥ delete ok under race', async () => {
    const db = createDevicesDb({
      devices: [
        seedDevice({ device_id: 'CHALLENGE' }),
        seedDevice({ device_id: 'KEEP' }),
        seedDevice({ device_id: 'DEL' }),
      ],
    });
    const [challenge, notFound, badPw, ok] = await Promise.all([
      devicesRequest(db, `${DEVICES}/CHALLENGE`, { method: 'DELETE', headers: AUTH }),
      devicesRequest(db, `${DEVICES}/GONE`, { method: 'GET', headers: AUTH }),
      devicesRequest(
        db,
        `${DEVICES}/KEEP`,
        jsonInit('DELETE', {
          auth: { type: 'm.login.password', password: 'wrong' },
        })
      ),
      devicesRequest(
        db,
        `${DEVICES}/DEL`,
        jsonInit('DELETE', {
          auth: { type: 'm.login.password', password: PASS },
        })
      ),
    ]);
    expect(challenge.status).toBe(401);
    const challengeBody = challenge.body as {
      flows: Array<{ stages: string[] }>;
      params: Record<string, unknown>;
      session: string;
    };
    expect(challengeBody.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(challengeBody.params).toEqual({});
    expect(typeof challengeBody.session).toBe('string');
    expect(challengeBody.session.length).toBeGreaterThan(0);
    expect(notFound.body).toEqual(DEVICE_NOT_FOUND);
    expect(badPw.body).toEqual(INVALID_PASSWORD);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({});
    expect(db.devices.some((d) => d.device_id === 'CHALLENGE')).toBe(true);
  });

  it('DELETE empty-body challenge ∥ delete_devices Missing devices ∥ badJson under race', async () => {
    const db = createDevicesDb({
      devices: [seedDevice({ device_id: 'A' }), seedDevice({ device_id: 'B' })],
    });
    const [challenge, missing, badJson] = await Promise.all([
      devicesRequest(db, `${DEVICES}/A`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{}',
      }),
      devicesRequest(
        db,
        DELETE_DEVICES,
        jsonInit('POST', {
          auth: { type: 'm.login.password', password: PASS },
        })
      ),
      devicesRequest(db, `${DEVICES}/B`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: '{not-json',
      }),
    ]);
    expect(challenge.status).toBe(401);
    const body = challenge.body as { flows: unknown; session: string };
    expect(body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(typeof body.session).toBe('string');
    expect(missing.body).toEqual(MISSING_DEVICES);
    expect(badJson.body).toEqual(BAD_JSON);
  });

  for (let i = 0; i < 8; i++) {
    it(`UIA challenge ∥ soft ∥ success flood-${i}`, async () => {
      const db = createDevicesDb({
        devices: [
          seedDevice({ device_id: `CH-${i}` }),
          seedDevice({ device_id: `KEEP-${i}` }),
          seedDevice({ device_id: `DEL-${i}` }),
        ],
      });
      const [challenge, badPw, ok] = await Promise.all([
        devicesRequest(db, `${DEVICES}/CH-${i}`, { method: 'DELETE', headers: AUTH }),
        devicesRequest(
          db,
          `${DEVICES}/KEEP-${i}`,
          jsonInit('DELETE', {
            auth: { type: 'm.login.password', password: `bad-${i}` },
          })
        ),
        devicesRequest(
          db,
          `${DEVICES}/DEL-${i}`,
          jsonInit('DELETE', {
            auth: { type: 'm.login.password', password: PASS },
          })
        ),
      ]);
      expect(challenge.status).toBe(401);
      expect((challenge.body as { flows: unknown }).flows).toEqual([
        { stages: ['m.login.password'] },
      ]);
      expect(badPw.body).toEqual(INVALID_PASSWORD);
      expect(ok.status).toBe(200);
    });
  }
});

// ---------------------------------------------------------------------------
// Unrecognized ∥ Cross-signing not approved ∥ Device not found
// ---------------------------------------------------------------------------

describe('devices soft residual sixth-wave Unrecognized∥not-approved∥devices after #303', () => {
  it('Unrecognized ∥ not-approved ∥ Device not found under race', async () => {
    const cache = mockKv({
      'uia_session:pend': JSON.stringify({
        user_id: USER,
        completed_stages: [],
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
    const db = createDevicesDb({ devices: [seedDevice({ device_id: 'ONLY' })] });
    const [unrec, pending, notFound] = await Promise.all([
      keysRequest(
        keysEnv,
        DEVICE_SIGNING,
        jsonInit(
          'POST',
          masterKeyBody({
            auth: { type: 'm.login.dummy' },
          })
        )
      ),
      keysRequest(
        keysEnv,
        DEVICE_SIGNING,
        jsonInit(
          'POST',
          masterKeyBody({
            auth: { type: 'm.oauth', session: 'pend' },
          })
        )
      ),
      devicesRequest(db, `${DEVICES}/GONE`, { method: 'GET', headers: AUTH }),
    ]);
    expect(unrec.body).toEqual(unrecognizedBody('m.login.dummy'));
    expect(pending.body).toEqual(CROSS_SIGNING_NOT_APPROVED);
    expect(notFound.body).toEqual(DEVICE_NOT_FOUND);
    expect(cache.data['uia_session:pend']).toBeTruthy();
  });

  it('Unrecognized ∥ not-approved ∥ Invalid password ∥ delete ok under race', async () => {
    const cache = mockKv({
      'uia_session:pend': JSON.stringify({
        user_id: USER,
        completed_stages: [],
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
      devices: [seedDevice({ device_id: 'KEEP' }), seedDevice({ device_id: 'DEL' })],
    });
    const [unrec, pending, badPw, ok] = await Promise.all([
      keysRequest(
        keysEnv,
        DEVICE_SIGNING,
        jsonInit(
          'POST',
          masterKeyBody({
            auth: { type: 'org.example.custom' },
          })
        )
      ),
      keysRequest(
        keysEnv,
        DEVICE_SIGNING,
        jsonInit(
          'POST',
          masterKeyBody({
            auth: { type: 'org.matrix.cross_signing_reset', session: 'pend' },
          })
        )
      ),
      devicesRequest(
        db,
        `${DEVICES}/KEEP`,
        jsonInit('DELETE', {
          auth: { type: 'm.login.password', password: 'nope' },
        })
      ),
      devicesRequest(
        db,
        `${DEVICES}/DEL`,
        jsonInit('DELETE', {
          auth: { type: 'm.login.password', password: PASS },
        })
      ),
    ]);
    expect(unrec.body).toEqual(unrecognizedBody('org.example.custom'));
    expect(pending.body).toEqual(CROSS_SIGNING_NOT_APPROVED);
    expect(badPw.body).toEqual(INVALID_PASSWORD);
    expect(ok.status).toBe(200);
    expect(db.devices.map((d) => d.device_id)).toEqual(['KEEP']);
  });

  for (let i = 0; i < 8; i++) {
    it(`Unrecognized ∥ not-approved ∥ Device not found flood-${i}`, async () => {
      const cache = mockKv({
        [`uia_session:pend-${i}`]: JSON.stringify({
          user_id: USER,
          completed_stages: [],
        }),
      });
      const keysEnv = createKeysEnv({
        db: createKeysDb({
          crossSigningKeys: [existingMasterKey()],
          idpLinkCounts: new Map([[USER, 1]]),
        }),
        cacheKv: cache,
      });
      const db = createDevicesDb({ devices: [seedDevice({ device_id: `ONLY-${i}` })] });
      const authType =
        i % 2 === 0 ? 'm.login.email' : 'm.login.application_service';
      const [unrec, pending, notFound] = await Promise.all([
        keysRequest(
          keysEnv,
          DEVICE_SIGNING,
          jsonInit(
            'POST',
            masterKeyBody({
              auth: { type: authType },
            })
          )
        ),
        keysRequest(
          keysEnv,
          DEVICE_SIGNING,
          jsonInit(
            'POST',
            masterKeyBody({
              auth: {
                type: i % 2 === 0 ? 'm.oauth' : 'm.login.sso',
                session: `pend-${i}`,
              },
            })
          )
        ),
        devicesRequest(db, `${DEVICES}/GONE-${i}`, { method: 'GET', headers: AUTH }),
      ]);
      expect(unrec.body).toEqual(unrecognizedBody(authType));
      expect(pending.body).toEqual(CROSS_SIGNING_NOT_APPROVED);
      expect(notFound.body).toEqual(DEVICE_NOT_FOUND);
    });
  }
});
