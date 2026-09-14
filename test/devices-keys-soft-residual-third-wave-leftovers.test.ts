/**
 * TOKENMAXX HEAVY leftovers after #280 — residual *devices + keys* soft
 * third-wave binds unsaturated by:
 *   #280 soft residual second-wave (delete_devices Invalid password /
 *        keys badJson / SSO redirect *errors* / token/submit *errors* /
 *        OAuth missing-session matrix; no SSO success/callback HTML;
 *        no token success; no OIDC UIA challenge params; no OAuth
 *        expired/mismatch/not-approved matrix; no non-password DELETE),
 *   #269 soft residual first-wave (Device not found / single DELETE
 *        Invalid password / device_signing password+UIA error strings /
 *        password-only UIA CACHE; OIDC dual-flow params unbound),
 *   #259 concurrent-race (TOCTOU; no exact soft string pins).
 *
 * Gap table (why leftover after #280):
 *   DELETE / delete_devices non-password auth success | password errors only
 *   OIDC UIA challenge dual-flow params URL           | routes once; #269 pw CACHE
 *   OIDC+password combined UIA flows                  | routes once
 *   OAuth auth-type expired / mismatch / not-approved | #280 missing-session only
 *   Unrecognized auth type string matrix              | #269 only m.login.email
 *   completed_stages approval stage-name matrix       | #269 empty stages only
 *   SSO redirect success Location + redirect_url      | routes once; #280 errors
 *   SSO callback HTML error/success text soft flood   | routes once
 *   token/submit success completed + CACHE stage      | routes once; #280 errors
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

// ---------------------------------------------------------------------------
// Devices — non-password auth skips verifyPassword and deletes (#280 left open)
// ---------------------------------------------------------------------------

describe('devices soft residual non-password DELETE success after #280', () => {
  const authShapes: { label: string; auth: Record<string, unknown> }[] = [
    { label: 'empty-auth-object', auth: {} },
    { label: 'unknown-type', auth: { type: 'm.login.dummy' } },
    { label: 'sso-type', auth: { type: 'm.login.sso', session: 'x' } },
    { label: 'token-type', auth: { type: 'm.login.token', token: 't' } },
  ];

  for (const shape of authShapes) {
    for (let i = 0; i < 4; i++) {
      it(`DELETE ${shape.label} skips verifyPassword and deletes soft-${i}`, async () => {
        const deviceId = `NP${shape.label[0]}${i}`;
        const db = createDevicesDb({ devices: [seedDevice({ device_id: deviceId })] });
        const res = await devicesRequest(
          db,
          `${DEVICES}/${deviceId}`,
          jsonInit('DELETE', { auth: shape.auth })
        );
        expect(res.status).toBe(200);
        expect(res.body).toEqual({});
        expect(vi.mocked(verifyPassword)).not.toHaveBeenCalled();
        expect(db.deleted).toContain(deviceId);
      });
    }
  }

  for (const shape of authShapes) {
    for (let i = 0; i < 3; i++) {
      it(`delete_devices ${shape.label} skips verifyPassword soft-${i}`, async () => {
        const deviceId = `DD${shape.label[0]}${i}`;
        const db = createDevicesDb({ devices: [seedDevice({ device_id: deviceId })] });
        const res = await devicesRequest(
          db,
          DELETE_DEVICES,
          jsonInit('POST', {
            devices: [deviceId],
            auth: shape.auth,
          })
        );
        expect(res.status).toBe(200);
        expect(res.body).toEqual({});
        expect(vi.mocked(verifyPassword)).not.toHaveBeenCalled();
        expect(db.deleted).toContain(deviceId);
      });
    }
  }

  it('DELETE∥delete_devices non-password both succeed under Promise.all', async () => {
    const dbA = createDevicesDb({ devices: [seedDevice({ device_id: 'RA' })] });
    const dbB = createDevicesDb({ devices: [seedDevice({ device_id: 'RB' })] });
    const [a, b] = await Promise.all([
      devicesRequest(
        dbA,
        `${DEVICES}/RA`,
        jsonInit('DELETE', { auth: { type: 'm.login.dummy' } })
      ),
      devicesRequest(
        dbB,
        DELETE_DEVICES,
        jsonInit('POST', {
          devices: ['RB'],
          auth: { type: 'm.login.sso' },
        })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(vi.mocked(verifyPassword)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Keys — OIDC UIA challenge dual-flow params (routes once; #269 password only)
// ---------------------------------------------------------------------------

describe('keys soft residual OIDC UIA challenge params after #280', () => {
  for (let i = 0; i < 8; i++) {
    it(`OIDC-only UIA challenge binds dual MSC4312 flows + approval URL soft-${i}`, async () => {
      const cache = mockKv();
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
          master_key: {
            user_id: USER,
            usage: ['master'],
            keys: { 'ed25519:master': `oidc-${i}` },
          },
        }))
      );
      expect(res.status).toBe(401);
      const body = res.body as {
        session: string;
        flows: Array<{ stages: string[] }>;
        params: Record<string, { url: string }>;
      };
      expect(body.session).toBe('pinned-uia-session-tw');
      expect(body.flows).toEqual([
        { stages: ['org.matrix.cross_signing_reset'] },
        { stages: ['m.oauth'] },
      ]);
      const approval =
        `https://${SERVER}/oauth/authorize/uia?session=pinned-uia-session-tw` +
        `&action=org.matrix.cross_signing_reset`;
      expect(body.params['org.matrix.cross_signing_reset']).toEqual({ url: approval });
      expect(body.params['m.oauth']).toEqual({ url: approval });
      const put = cache.puts.find((p) => p.key === 'uia_session:pinned-uia-session-tw');
      expect(put).toBeDefined();
      expect(put!.options).toEqual({ expirationTtl: 300 });
      expect(JSON.parse(put!.value)).toMatchObject({
        user_id: USER,
        type: 'device_signing_upload',
        is_oidc_user: true,
        has_password: false,
        completed_stages: [],
      });
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`OIDC+password UIA challenge binds three flows soft-${i}`, async () => {
      const env = createKeysEnv({
        db: createKeysDb({
          crossSigningKeys: [existingMasterKey()],
          idpLinkCounts: new Map([[USER, 2]]),
          passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
        }),
      });
      const res = await keysRequest(
        env,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          master_key: {
            user_id: USER,
            usage: ['master'],
            keys: { 'ed25519:master': `both-${i}` },
          },
        }))
      );
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        session: 'pinned-uia-session-tw',
        flows: [
          { stages: ['org.matrix.cross_signing_reset'] },
          { stages: ['m.oauth'] },
          { stages: ['m.login.password'] },
        ],
      });
    });
  }

  it('OIDC-only∥OIDC+password challenges both bind under Promise.all', async () => {
    const envOidc = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        idpLinkCounts: new Map([[USER, 1]]),
      }),
    });
    const envBoth = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        idpLinkCounts: new Map([[USER, 1]]),
        passwordHashes: new Map([[USER, `mockok:${PASS}`]]),
      }),
    });
    const [oidc, both] = await Promise.all([
      keysRequest(envOidc, DEVICE_SIGNING, jsonInit('POST', masterKeyBody())),
      keysRequest(envBoth, DEVICE_SIGNING, jsonInit('POST', masterKeyBody())),
    ]);
    expect((oidc.body as { flows: unknown[] }).flows).toHaveLength(2);
    expect((both.body as { flows: unknown[] }).flows).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Keys — OAuth auth-type matrix expired / mismatch / not-approved (#280 session-only)
// ---------------------------------------------------------------------------

describe('keys soft residual OAuth auth-type failure matrix after #280', () => {
  const authTypes = [
    'org.matrix.cross_signing_reset',
    'm.oauth',
    'm.login.oauth',
    'm.login.sso',
    'm.login.token',
  ] as const;

  for (const authType of authTypes) {
    for (let i = 0; i < 2; i++) {
      it(`${authType} expired session binds UIA expired soft-${i}`, async () => {
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
            auth: { type: authType, session: `gone-${authType}-${i}` },
          }))
        );
        expect(res.status).toBe(401);
        expect(res.body).toEqual(UIA_EXPIRED);
      });
    }
  }

  for (const authType of authTypes) {
    for (let i = 0; i < 2; i++) {
      it(`${authType} session user mismatch binds soft-${i}`, async () => {
        const sid = `mm-${authType}-${i}`;
        const cache = mockKv({
          [`uia_session:${sid}`]: JSON.stringify({
            user_id: BOB,
            completed_stages: ['org.matrix.cross_signing_reset'],
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
            auth: { type: authType, session: sid },
          }))
        );
        expect(res.status).toBe(403);
        expect(res.body).toEqual(SESSION_MISMATCH);
      });
    }
  }

  for (const authType of authTypes) {
    for (let i = 0; i < 2; i++) {
      it(`${authType} incomplete stages binds not approved soft-${i}`, async () => {
        const sid = `pend-${authType}-${i}`;
        const cache = mockKv({
          [`uia_session:${sid}`]: JSON.stringify({
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
        const res = await keysRequest(
          env,
          DEVICE_SIGNING,
          jsonInit('POST', masterKeyBody({
            auth: { type: authType, session: sid },
          }))
        );
        expect(res.status).toBe(401);
        expect(res.body).toEqual(CROSS_SIGNING_NOT_APPROVED);
      });
    }
  }

  it('expired∥mismatch∥not-approved all bind under Promise.all', async () => {
    const cache = mockKv({
      'uia_session:race-mm': JSON.stringify({
        user_id: BOB,
        completed_stages: ['m.oauth'],
      }),
      'uia_session:race-pend': JSON.stringify({
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
          auth: { type: 'm.oauth', session: 'missing' },
        }))
      ),
      keysRequest(
        env,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'm.login.sso', session: 'race-mm' },
        }))
      ),
      keysRequest(
        env,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'm.login.token', session: 'race-pend' },
        }))
      ),
    ]);
    expect(expired.body).toEqual(UIA_EXPIRED);
    expect(mismatch.body).toEqual(SESSION_MISMATCH);
    expect(pending.body).toEqual(CROSS_SIGNING_NOT_APPROVED);
  });
});

// ---------------------------------------------------------------------------
// Keys — Unrecognized auth type string matrix (#269 only m.login.email)
// ---------------------------------------------------------------------------

describe('keys soft residual unrecognized auth type matrix after #280', () => {
  // Note: falsy `auth.type` (undefined / '') is treated as OAuth-compat, not unrecognized.
  const types = [
    'm.login.email',
    'm.login.dummy',
    'm.login.application_service',
    'org.example.custom',
    'm.login.password.extra',
    'm.login.msisdn',
  ];

  for (const authType of types) {
    for (let i = 0; i < 3; i++) {
      it(`unrecognized type ${JSON.stringify(authType)} binds soft-${i}`, async () => {
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
            auth: { type: authType },
          }))
        );
        expect(res.status).toBe(400);
        expect(res.body).toEqual({
          errcode: 'M_UNRECOGNIZED',
          error: `Unrecognized auth type: ${authType}`,
        });
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Keys — completed_stages approval stage-name matrix → replace success
// ---------------------------------------------------------------------------

describe('keys soft residual OAuth approval stage-name matrix after #280', () => {
  const stages = [
    'org.matrix.cross_signing_reset',
    'm.oauth',
    'm.login.oauth',
    'm.login.sso',
    'm.login.token',
  ] as const;

  for (const stage of stages) {
    for (let i = 0; i < 3; i++) {
      it(`completed_stages includes ${stage} allows replace soft-${i}`, async () => {
        const sid = `ok-${stage}-${i}`;
        const cache = mockKv({
          [`uia_session:${sid}`]: JSON.stringify({
            user_id: USER,
            completed_stages: [stage],
          }),
        });
        const env = createKeysEnv({
          db: createKeysDb({
            crossSigningKeys: [existingMasterKey()],
            idpLinkCounts: new Map([[USER, 1]]),
          }),
          cacheKv: cache,
        });
        const master = {
          user_id: USER,
          usage: ['master'],
          keys: { 'ed25519:master': `approved-${stage}-${i}` },
        };
        const res = await keysRequest(
          env,
          DEVICE_SIGNING,
          jsonInit('POST', {
            master_key: master,
            auth: { type: 'org.matrix.cross_signing_reset', session: sid },
          })
        );
        expect(res.status).toBe(200);
        expect(res.body).toEqual({});
        expect(cache.deletes).toContain(`uia_session:${sid}`);
        expect(env._userKeys.crossSigning.master).toEqual(master);
      });
    }
  }

  it('two approved stage names both replace under Promise.all', async () => {
    const cacheA = mockKv({
      'uia_session:a': JSON.stringify({
        user_id: USER,
        completed_stages: ['m.oauth'],
      }),
    });
    const cacheB = mockKv({
      'uia_session:b': JSON.stringify({
        user_id: USER,
        completed_stages: ['m.login.token'],
      }),
    });
    const envA = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        idpLinkCounts: new Map([[USER, 1]]),
      }),
      cacheKv: cacheA,
    });
    const envB = createKeysEnv({
      db: createKeysDb({
        crossSigningKeys: [existingMasterKey()],
        idpLinkCounts: new Map([[USER, 1]]),
      }),
      cacheKv: cacheB,
    });
    const [a, b] = await Promise.all([
      keysRequest(
        envA,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'm.oauth', session: 'a' },
          master_key: {
            user_id: USER,
            usage: ['master'],
            keys: { 'ed25519:master': 'race-a' },
          },
        }))
      ),
      keysRequest(
        envB,
        DEVICE_SIGNING,
        jsonInit('POST', masterKeyBody({
          auth: { type: 'm.login.token', session: 'b' },
          master_key: {
            user_id: USER,
            usage: ['master'],
            keys: { 'ed25519:master': 'race-b' },
          },
        }))
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Keys — SSO redirect success Location + redirect_url (#280 errors only)
// ---------------------------------------------------------------------------

describe('keys soft residual SSO redirect success after #280', () => {
  for (let i = 0; i < 8; i++) {
    it(`SSO redirect with redirectUrl binds Location + CACHE soft-${i}`, async () => {
      const sid = `redir-${i}`;
      const cache = mockKv({
        [`uia_session:${sid}`]: JSON.stringify({
          user_id: USER,
          completed_stages: [],
        }),
      });
      const env = createKeysEnv({ cacheKv: cache });
      const clientDone = `https://client.example/done-${i}`;
      const res = await keysRequest(
        env,
        `${SSO_REDIRECT}?session=${sid}&redirectUrl=${encodeURIComponent(clientDone)}`
      );
      expect(res.status).toBe(302);
      const loc = res.headers.get('Location')!;
      expect(loc).toContain(`https://${SERVER}/oauth/authorize?`);
      expect(loc).toContain('response_type=code');
      expect(loc).toContain('client_id=matrix-uia');
      expect(loc).toContain(`state=${sid}`);
      expect(loc).toContain(
        encodeURIComponent(`https://${SERVER}/_matrix/client/v3/auth/m.login.sso/callback`)
      );
      expect(JSON.parse(cache.data[`uia_session:${sid}`]).redirect_url).toBe(clientDone);
      const put = cache.puts.find((p) => p.key === `uia_session:${sid}`);
      expect(put!.options).toEqual({ expirationTtl: 300 });
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`SSO redirect without redirectUrl defaults callback soft-${i}`, async () => {
      const sid = `def-${i}`;
      const cache = mockKv({
        [`uia_session:${sid}`]: JSON.stringify({ user_id: USER }),
      });
      const env = createKeysEnv({ cacheKv: cache });
      const res = await keysRequest(env, `${SSO_REDIRECT}?session=${sid}`);
      expect(res.status).toBe(302);
      expect(JSON.parse(cache.data[`uia_session:${sid}`]).redirect_url).toBe(
        `https://${SERVER}/_matrix/client/v3/auth/m.login.sso/callback`
      );
    });
  }

  it('SSO success∥error paths isolate under Promise.all', async () => {
    const cache = mockKv({
      'uia_session:ok': JSON.stringify({ user_id: USER }),
    });
    const env = createKeysEnv({ cacheKv: cache });
    const [ok, missing] = await Promise.all([
      keysRequest(env, `${SSO_REDIRECT}?session=ok`),
      keysRequest(env, SSO_REDIRECT),
    ]);
    expect(ok.status).toBe(302);
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({
      errcode: 'M_MISSING_PARAM',
      error: 'Missing session parameter',
    });
  });
});

// ---------------------------------------------------------------------------
// Keys — SSO callback HTML soft residual texts (routes once)
// ---------------------------------------------------------------------------

describe('keys soft residual SSO callback HTML after #280', () => {
  for (let i = 0; i < 6; i++) {
    it(`SSO callback IdP error binds Authentication Failed HTML soft-${i}`, async () => {
      const env = createKeysEnv();
      const res = await keysRequest(
        env,
        `${SSO_CALLBACK}?error=access_denied&error_description=Nope-${i}`
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      expect(res.text).toContain('SSO Authentication Failed');
      expect(res.text).toContain(`Nope-${i}`);
    });
  }

  for (let i = 0; i < 4; i++) {
    it(`SSO callback error without description falls back to code soft-${i}`, async () => {
      const env = createKeysEnv();
      const res = await keysRequest(env, `${SSO_CALLBACK}?error=server_error_${i}`);
      expect(res.text).toContain('SSO Authentication Failed');
      expect(res.text).toContain(`server_error_${i}`);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`SSO callback missing state binds Invalid Request soft-${i}`, async () => {
      const env = createKeysEnv();
      const res = await keysRequest(env, `${SSO_CALLBACK}?code=abc-${i}`);
      expect(res.text).toContain('Invalid Request');
      expect(res.text).toContain('Missing state parameter');
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`SSO callback expired state binds Session Expired soft-${i}`, async () => {
      const env = createKeysEnv();
      const res = await keysRequest(
        env,
        `${SSO_CALLBACK}?code=abc&state=gone-${i}`
      );
      expect(res.text).toContain('Session Expired');
      expect(res.text).toContain('The UIA session has expired. Please try again.');
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`SSO callback success marks m.login.sso + Authentication Successful soft-${i}`, async () => {
      const sid = `ok-${i}`;
      const cache = mockKv({
        [`uia_session:${sid}`]: JSON.stringify({
          user_id: USER,
          completed_stages: [],
          redirect_url: `https://client.example/done-${i}`,
        }),
      });
      const env = createKeysEnv({ cacheKv: cache });
      const res = await keysRequest(
        env,
        `${SSO_CALLBACK}?code=authcode&state=${sid}`
      );
      expect(res.status).toBe(200);
      expect(res.text).toContain('Authentication Successful');
      expect(res.text).toContain(`Session: ${sid}`);
      expect(res.text).toContain("type: 'uia_complete'");
      const session = JSON.parse(cache.data[`uia_session:${sid}`]);
      expect(session.completed_stages).toEqual(['m.login.sso']);
      expect(session.sso_completed_at).toEqual(expect.any(Number));
      const put = cache.puts.find((p) => p.key === `uia_session:${sid}`);
      expect(put!.options).toEqual({ expirationTtl: 300 });
    });
  }

  for (let i = 0; i < 4; i++) {
    it(`SSO callback without code binds Authentication Failed soft-${i}`, async () => {
      const sid = `nocode-${i}`;
      const cache = mockKv({
        [`uia_session:${sid}`]: JSON.stringify({ user_id: USER }),
      });
      const env = createKeysEnv({ cacheKv: cache });
      const res = await keysRequest(env, `${SSO_CALLBACK}?state=${sid}`);
      expect(res.text).toContain('Authentication Failed');
      expect(res.text).toContain('No authorization code received');
    });
  }

  for (let i = 0; i < 4; i++) {
    it(`SSO callback does not duplicate m.login.sso stage soft-${i}`, async () => {
      const sid = `dup-${i}`;
      const cache = mockKv({
        [`uia_session:${sid}`]: JSON.stringify({
          user_id: USER,
          completed_stages: ['m.login.sso'],
        }),
      });
      const env = createKeysEnv({ cacheKv: cache });
      await keysRequest(env, `${SSO_CALLBACK}?code=authcode&state=${sid}`);
      const session = JSON.parse(cache.data[`uia_session:${sid}`]);
      expect(session.completed_stages.filter((s: string) => s === 'm.login.sso')).toHaveLength(
        1
      );
    });
  }

  it('SSO callback error∥success HTML isolate under Promise.all', async () => {
    const cache = mockKv({
      'uia_session:race-ok': JSON.stringify({
        user_id: USER,
        completed_stages: [],
      }),
    });
    const env = createKeysEnv({ cacheKv: cache });
    const [err, ok] = await Promise.all([
      keysRequest(env, `${SSO_CALLBACK}?error=access_denied&error_description=Nope`),
      keysRequest(env, `${SSO_CALLBACK}?code=c&state=race-ok`),
    ]);
    expect(err.text).toContain('SSO Authentication Failed');
    expect(ok.text).toContain('Authentication Successful');
  });
});

// ---------------------------------------------------------------------------
// Keys — token/submit success completed (#280 error binds only)
// ---------------------------------------------------------------------------

describe('keys soft residual token/submit success after #280', () => {
  for (let i = 0; i < 8; i++) {
    it(`token/submit success binds completed + CACHE stage soft-${i}`, async () => {
      const sid = `tok-ok-${i}`;
      const cache = mockKv({
        [`uia_session:${sid}`]: JSON.stringify({
          user_id: USER,
          completed_stages: [],
        }),
      });
      const env = createKeysEnv({ cacheKv: cache });
      const res = await keysRequest(
        env,
        TOKEN_SUBMIT,
        jsonInit('POST', { session: sid })
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        completed: ['m.login.token'],
        session: sid,
      });
      const session = JSON.parse(cache.data[`uia_session:${sid}`]);
      expect(session.completed_stages).toEqual(['m.login.token']);
      expect(session.token_completed_at).toEqual(expect.any(Number));
      const put = cache.puts.find((p) => p.key === `uia_session:${sid}`);
      expect(put!.options).toEqual({ expirationTtl: 300 });
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`token/submit does not duplicate m.login.token soft-${i}`, async () => {
      const sid = `tok-dup-${i}`;
      const cache = mockKv({
        [`uia_session:${sid}`]: JSON.stringify({
          user_id: USER,
          completed_stages: ['m.login.token'],
        }),
      });
      const env = createKeysEnv({ cacheKv: cache });
      const res = await keysRequest(
        env,
        TOKEN_SUBMIT,
        jsonInit('POST', { session: sid })
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        completed: ['m.login.token'],
        session: sid,
      });
      const session = JSON.parse(cache.data[`uia_session:${sid}`]);
      expect(session.completed_stages).toEqual(['m.login.token']);
    });
  }

  it('token success∥expired∥mismatch isolate under Promise.all', async () => {
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
    const [ok, expired, mismatch] = await Promise.all([
      keysRequest(env, TOKEN_SUBMIT, jsonInit('POST', { session: 'race-ok' })),
      keysRequest(env, TOKEN_SUBMIT, jsonInit('POST', { session: 'gone' })),
      keysRequest(env, TOKEN_SUBMIT, jsonInit('POST', { session: 'race-mm' })),
    ]);
    expect(ok.body).toEqual({
      completed: ['m.login.token'],
      session: 'race-ok',
    });
    expect(expired.body).toEqual(UIA_EXPIRED);
    expect(mismatch.body).toEqual(SESSION_MISMATCH);
  });
});
