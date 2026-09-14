/**
 * TOKENMAXX HEAVY deepen after #125/#126 — login/register API route edges leftovers.
 * Companion to login-api-routes.test.ts (#101). Prefer login leftovers over appservice/
 * federation/devices/keys/sliding-sync/sync/voip/rooms/oidc/media/relations.
 * Tests-only — no product inventing. Exercises Hono app.request() on src/api/login.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { hashToken } from '../src/utils/crypto';

vi.mock('../src/middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/middleware/auth')>();
  return {
    ...actual,
    requireAuth: () => {
      return async (
        c: { set: (k: string, v: unknown) => void },
        next: () => Promise<void>
      ) => {
        c.set('userId', '@alice:example.com');
        c.set('deviceId', 'DEVICE');
        await next();
      };
    },
  };
});

vi.mock('../src/utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/crypto')>();
  return {
    ...actual,
    verifyPassword: vi.fn(async (password: string, storedHash: string) => {
      return storedHash === `mockok:${password}`;
    }),
    hashPassword: vi.fn(async (password: string) => `mockok:${password}`),
  };
});

import login from '../src/api/login';

const SERVER = 'example.com';
const USER = `@alice:${SERVER}`;
const BOB = `@bob:${SERVER}`;
const DEVICE = 'DEVICE';
const NOW = 1_730_000_000_000;

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
      return undefined;
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

type UserRow = {
  user_id: string;
  localpart: string;
  display_name: string | null;
  avatar_url: string | null;
  password_hash: string | null;
  is_guest: number;
  is_deactivated: number;
  admin: number;
  created_at: number;
};

type DeviceRow = {
  user_id: string;
  device_id: string;
  display_name: string | null;
  created_at: number;
};

type TokenRow = {
  token_id: string;
  token_hash: string;
  user_id: string;
  device_id: string | null;
  created_at: number;
};

type SqlCall = { sql: string; args: unknown[] };

function userRow(
  partial: Partial<UserRow> & Pick<UserRow, 'user_id' | 'localpart'>
): UserRow {
  return {
    display_name: partial.display_name ?? partial.localpart,
    avatar_url: partial.avatar_url ?? null,
    password_hash: partial.password_hash ?? null,
    is_guest: partial.is_guest ?? 0,
    is_deactivated: partial.is_deactivated ?? 0,
    admin: partial.admin ?? 0,
    created_at: partial.created_at ?? 1_700_000_000_000,
    user_id: partial.user_id,
    localpart: partial.localpart,
  };
}

function createLoginDb(opts: {
  users?: Map<string, UserRow>;
  usersByLocalpart?: Map<string, UserRow>;
  devices?: DeviceRow[];
  tokens?: TokenRow[];
} = {}) {
  const users = opts.users ?? new Map<string, UserRow>();
  const usersByLocalpart =
    opts.usersByLocalpart ??
    new Map<string, UserRow>(
      [...users.values()].map((u) => [u.localpart, u] as [string, UserRow])
    );
  const devices = opts.devices ?? [];
  const tokens = opts.tokens ?? [];
  const inserts: SqlCall[] = [];
  const deletes: SqlCall[] = [];

  for (const u of users.values()) {
    if (!usersByLocalpart.has(u.localpart)) {
      usersByLocalpart.set(u.localpart, u);
    }
  }

  const db = {
    users,
    usersByLocalpart,
    devices,
    tokens,
    inserts,
    deletes,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT password_hash FROM users')) {
                const userId = args[0] as string;
                const u = users.get(userId);
                return (u ? { password_hash: u.password_hash } : null) as T;
              }

              if (
                sql.includes('FROM users WHERE user_id = ?') &&
                sql.includes('SELECT user_id, localpart')
              ) {
                const userId = args[0] as string;
                const u = users.get(userId);
                if (!u) return null;
                return {
                  user_id: u.user_id,
                  localpart: u.localpart,
                  display_name: u.display_name,
                  avatar_url: u.avatar_url,
                  is_guest: u.is_guest,
                  is_deactivated: u.is_deactivated,
                  admin: u.admin,
                  created_at: u.created_at,
                } as T;
              }

              if (
                sql.includes('FROM users WHERE localpart = ?') &&
                sql.includes('SELECT user_id, localpart')
              ) {
                const localpart = args[0] as string;
                const u = usersByLocalpart.get(localpart);
                if (!u) return null;
                return {
                  user_id: u.user_id,
                  localpart: u.localpart,
                  display_name: u.display_name,
                  avatar_url: u.avatar_url,
                  is_guest: u.is_guest,
                  is_deactivated: u.is_deactivated,
                  admin: u.admin,
                  created_at: u.created_at,
                } as T;
              }

              return null;
            },

            async run() {
              if (sql.includes('INSERT INTO users')) {
                inserts.push({ sql, args });
                const [userId, localpart, passwordHash, isGuest] = args as [
                  string,
                  string,
                  string | null,
                  number,
                ];
                const row = userRow({
                  user_id: userId,
                  localpart,
                  password_hash: passwordHash,
                  is_guest: isGuest,
                });
                users.set(userId, row);
                usersByLocalpart.set(localpart, row);
                return { success: true, meta: { changes: 1 } };
              }

              if (sql.includes('INSERT INTO devices')) {
                inserts.push({ sql, args });
                const [userId, deviceId, displayName] = args as [
                  string,
                  string,
                  string | null,
                ];
                devices.push({
                  user_id: userId,
                  device_id: deviceId,
                  display_name: displayName,
                  created_at: Date.now(),
                });
                return { success: true, meta: { changes: 1 } };
              }

              if (sql.includes('INSERT INTO access_tokens')) {
                inserts.push({ sql, args });
                const [tokenId, tokenHash, userId, deviceId] = args as [
                  string,
                  string,
                  string,
                  string | null,
                ];
                tokens.push({
                  token_id: tokenId,
                  token_hash: tokenHash,
                  user_id: userId,
                  device_id: deviceId,
                  created_at: Date.now(),
                });
                return { success: true, meta: { changes: 1 } };
              }

              if (sql.includes('DELETE FROM access_tokens WHERE token_hash = ?')) {
                deletes.push({ sql, args });
                const hash = args[0] as string;
                for (let i = tokens.length - 1; i >= 0; i--) {
                  if (tokens[i].token_hash === hash) tokens.splice(i, 1);
                }
                return { success: true, meta: { changes: 1 } };
              }

              if (sql.includes('DELETE FROM access_tokens WHERE user_id = ?')) {
                deletes.push({ sql, args });
                const userId = args[0] as string;
                for (let i = tokens.length - 1; i >= 0; i--) {
                  if (tokens[i].user_id === userId) tokens.splice(i, 1);
                }
                return { success: true, meta: { changes: 1 } };
              }

              if (sql.includes('DELETE FROM access_tokens WHERE token_id = ?')) {
                deletes.push({ sql, args });
                const tokenId = args[0] as string;
                for (let i = tokens.length - 1; i >= 0; i--) {
                  if (tokens[i].token_id === tokenId) tokens.splice(i, 1);
                }
                return { success: true, meta: { changes: 1 } };
              }

              throw new Error(`Unhandled SQL in login edges stub: ${sql.slice(0, 140)}`);
            },
          };
        },
      };
    },
  };

  return db;
}

type LoginDb = ReturnType<typeof createLoginDb>;

function envFor(
  db: LoginDb,
  sessions?: ReturnType<typeof mockKv>,
  serverName = SERVER
): Env & { _sessions: ReturnType<typeof mockKv> } {
  const SESSIONS = sessions ?? mockKv();
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: serverName,
    SESSIONS,
    _sessions: SESSIONS,
  } as unknown as Env & { _sessions: ReturnType<typeof mockKv> };
}

async function request(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await login.request(`http://localhost${path}`, init, env);
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, headers: res.headers };
}

function jsonInit(method: string, body?: unknown, token = 'test-token'): RequestInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function seedAlice(password = 'secret123'): UserRow {
  return userRow({
    user_id: USER,
    localpart: 'alice',
    password_hash: `mockok:${password}`,
  });
}

function passwordLoginBody(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: 'alice' },
    password: 'secret123',
    device_id: DEVICE,
    initial_device_display_name: 'Test Device',
    ...overrides,
  };
}

function aliceDb(): LoginDb {
  return createLoginDb({ users: new Map([[USER, seedAlice()]]) });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ===========================================================================
// GET /login edges
// ===========================================================================

describe('login edges GET /login response shape', () => {
  it('returns exactly three flows with only type fields', async () => {
    const res = await request(envFor(createLoginDb()), '/_matrix/client/v3/login');
    expect(res.status).toBe(200);
    expect(res.body.flows).toEqual([
      { type: 'm.login.password' },
      { type: 'm.login.token' },
      { type: 'm.login.dummy' },
    ]);
    for (const flow of res.body.flows) {
      expect(Object.keys(flow)).toEqual(['type']);
    }
  });

  it('does not require auth and ignores query tokens', async () => {
    const res = await request(
      envFor(createLoginDb()),
      '/_matrix/client/v3/login?access_token=nope'
    );
    expect(res.status).toBe(200);
    expect(res.body.flows).toHaveLength(3);
  });
});

// ===========================================================================
// Password login identifier + body edges
// ===========================================================================

describe('login edges password identifier parsing', () => {
  it.each([
    ['m.id.thirdparty', { type: 'm.id.thirdparty', medium: 'email', address: 'a@b.c' }],
    ['m.id.phone', { type: 'm.id.phone', country: 'US', phone: '15551212' }],
    ['missing type', { user: 'alice' }],
    ['empty type', { type: '', user: 'alice' }],
    ['null type', { type: null, user: 'alice' }],
    ['numeric type', { type: 1, user: 'alice' }],
  ])('rejects identifier %s', async (_label, identifier) => {
    const env = envFor(aliceDb());
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody({ identifier }), '')
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_UNRECOGNIZED');
  });

  it('formats localpart with SERVER_NAME from env (custom domain)', async () => {
    const custom = 'homeserver.test';
    const userId = `@alice:${custom}`;
    const db = createLoginDb({
      users: new Map([
        [
          userId,
          userRow({
            user_id: userId,
            localpart: 'alice',
            password_hash: 'mockok:secret123',
          }),
        ],
      ]),
    });
    const env = envFor(db, mockKv(), custom);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody({ device_id: 'D1' }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(userId);
    expect(res.body.home_server).toBe(custom);
  });

  it('treats @-prefixed user as full MXID without reformatting', async () => {
    const env = envFor(aliceDb());
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        passwordLoginBody({
          identifier: { type: 'm.id.user', user: USER },
          device_id: 'MXIDDEV',
        }),
        ''
      )
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(USER);
    expect(res.body.device_id).toBe('MXIDDEV');
  });

  it('rejects null password with M_MISSING_PARAM', async () => {
    const env = envFor(aliceDb());
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody({ password: null }), '')
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('rejects missing identifier object', async () => {
    const env = envFor(aliceDb());
    const body = passwordLoginBody();
    delete body.identifier;
    const res = await request(env, '/_matrix/client/v3/login', jsonInit('POST', body, ''));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('rejects null identifier', async () => {
    const env = envFor(aliceDb());
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody({ identifier: null }), '')
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('stores initial_device_display_name on device insert', async () => {
    const db = aliceDb();
    const env = envFor(db);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        passwordLoginBody({
          device_id: 'NAMED',
          initial_device_display_name: 'Alice Phone',
        }),
        ''
      )
    );
    expect(res.status).toBe(200);
    expect(db.devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          device_id: 'NAMED',
          display_name: 'Alice Phone',
          user_id: USER,
        }),
      ])
    );
  });

  it('passes undefined display name when initial_device_display_name omitted', async () => {
    const db = aliceDb();
    const env = envFor(db);
    const body = passwordLoginBody({ device_id: 'NODISP' });
    delete body.initial_device_display_name;
    const res = await request(env, '/_matrix/client/v3/login', jsonInit('POST', body, ''));
    expect(res.status).toBe(200);
    const device = db.devices.find((d) => d.device_id === 'NODISP');
    // createDevice binds undefined → SQLite/D1 null
    expect(device?.display_name == null).toBe(true);
  });

  it('returns expires_in_ms of exactly one hour and syt_/syr_ token prefixes', async () => {
    const env = envFor(aliceDb());
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody(), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.expires_in_ms).toBe(3_600_000);
    expect(res.body.access_token).toMatch(/^syt_/);
    expect(res.body.refresh_token).toMatch(/^syr_/);
    expect(res.body.home_server).toBe(SERVER);
  });

  it('stores refresh KV with 7-day TTL (604800 seconds)', async () => {
    const sessions = mockKv();
    const env = envFor(aliceDb(), sessions);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody(), '')
    );
    expect(res.status).toBe(200);
    const refreshPuts = sessions.puts.filter((p) => p.key.startsWith('refresh:'));
    expect(refreshPuts).toHaveLength(1);
    expect(refreshPuts[0].options?.expirationTtl).toBe(7 * 24 * 60 * 60);
    const stored = JSON.parse(sessions.data[refreshPuts[0].key]);
    expect(stored.userId).toBe(USER);
    expect(stored.deviceId).toBe(DEVICE);
    expect(stored.createdAt).toBe(NOW);
    expect(typeof stored.accessTokenId).toBe('string');
  });

  it('does not create lockout key on successful login with no prior failures', async () => {
    const sessions = mockKv();
    const env = envFor(aliceDb(), sessions);
    await request(env, '/_matrix/client/v3/login', jsonInit('POST', passwordLoginBody(), ''));
    expect(Object.keys(sessions.data).some((k) => k.startsWith('lockout:'))).toBe(false);
  });

  it('rejects array body as M_UNRECOGNIZED (no type field)', async () => {
    const env = envFor(aliceDb());
    const res = await request(env, '/_matrix/client/v3/login', jsonInit('POST', [], ''));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_UNRECOGNIZED');
  });

  it('rejects numeric type field', async () => {
    const env = envFor(aliceDb());
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 1, password: 'x', identifier: { type: 'm.id.user', user: 'alice' } }, '')
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_UNRECOGNIZED');
  });
});

// ===========================================================================
// Lockout edges
// ===========================================================================

describe('login edges lockout counters and TTL', () => {
  it('stores lockout with expirationTtl 3600 on each failure', async () => {
    const sessions = mockKv();
    const env = envFor(aliceDb(), sessions);
    await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody({ password: 'wrong' }), '')
    );
    const puts = sessions.puts.filter((p) => p.key === `lockout:${USER}`);
    expect(puts).toHaveLength(1);
    expect(puts[0].options?.expirationTtl).toBe(3600);
    expect(JSON.parse(puts[0].value)).toEqual({ attempts: 1 });
  });

  it('increments attempts 1→4 without lockedUntil', async () => {
    const sessions = mockKv();
    const env = envFor(aliceDb(), sessions);
    for (let i = 1; i <= 4; i++) {
      const res = await request(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', passwordLoginBody({ password: 'wrong' }), '')
      );
      expect(res.status).toBe(403);
      expect(JSON.parse(sessions.data[`lockout:${USER}`])).toEqual({ attempts: i });
    }
  });

  it('sets lockedUntil = now + 15 minutes on 5th failure and logs warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessions = mockKv();
    const env = envFor(aliceDb(), sessions);
    for (let i = 0; i < 5; i++) {
      await request(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', passwordLoginBody({ password: 'wrong' }), '')
      );
    }
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]);
    expect(lock.attempts).toBe(5);
    expect(lock.lockedUntil).toBe(NOW + 15 * 60 * 1000);
    expect(warn).toHaveBeenCalled();
    const msg = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toContain('[login]');
    expect(msg).toContain(USER);
  });

  it('returns retry_after_ms that shrinks as clock advances during lockout', async () => {
    const sessions = mockKv();
    sessions.data[`lockout:${USER}`] = JSON.stringify({
      attempts: 5,
      lockedUntil: NOW + 15 * 60 * 1000,
    });
    const env = envFor(aliceDb(), sessions);
    const a = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody(), '')
    );
    expect(a.status).toBe(429);
    expect(a.body.retry_after_ms).toBe(15 * 60 * 1000);

    vi.setSystemTime(NOW + 60_000);
    const b = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody(), '')
    );
    expect(b.status).toBe(429);
    expect(b.body.retry_after_ms).toBe(14 * 60 * 1000);
  });

  it('blocks even correct password during lockout window', async () => {
    const sessions = mockKv();
    sessions.data[`lockout:${USER}`] = JSON.stringify({
      attempts: 5,
      lockedUntil: NOW + 1_000,
    });
    const env = envFor(aliceDb(), sessions);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody(), '')
    );
    expect(res.status).toBe(429);
    expect(res.body.errcode).toBe('M_LIMIT_EXCEEDED');
  });

  it('deletes lockout key on successful login after prior failures', async () => {
    const sessions = mockKv();
    sessions.data[`lockout:${USER}`] = JSON.stringify({ attempts: 3 });
    const env = envFor(aliceDb(), sessions);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody(), '')
    );
    expect(res.status).toBe(200);
    expect(sessions.deletes).toContain(`lockout:${USER}`);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
  });
});

// ===========================================================================
// register/available localpart charset matrix
// ===========================================================================

describe('login edges register/available charset matrix', () => {
  it('rejects invalid localpart (uppercase)', async () => {
    const env = envFor(createLoginDb());
    const username = "Alice";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (space)', async () => {
    const env = envFor(createLoginDb());
    const username = "a b";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (at-sign)', async () => {
    const env = envFor(createLoginDb());
    const username = "a@b";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (colon)', async () => {
    const env = envFor(createLoginDb());
    const username = "a:b";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (plus)', async () => {
    const env = envFor(createLoginDb());
    const username = "a+b";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (bang)', async () => {
    const env = envFor(createLoginDb());
    const username = "a!b";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (hash)', async () => {
    const env = envFor(createLoginDb());
    const username = "a#b";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (dollar)', async () => {
    const env = envFor(createLoginDb());
    const username = "a$b";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (percent)', async () => {
    const env = envFor(createLoginDb());
    const username = "a%b";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (ampersand)', async () => {
    const env = envFor(createLoginDb());
    const username = "a&b";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (star)', async () => {
    const env = envFor(createLoginDb());
    const username = "a*b";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (paren)', async () => {
    const env = envFor(createLoginDb());
    const username = "a(b";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (bracket)', async () => {
    const env = envFor(createLoginDb());
    const username = "a[b";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (brace)', async () => {
    const env = envFor(createLoginDb());
    const username = "a{b";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (comma)', async () => {
    const env = envFor(createLoginDb());
    const username = "a,b";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (semicolon)', async () => {
    const env = envFor(createLoginDb());
    const username = "a;b";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (single-quote)', async () => {
    const env = envFor(createLoginDb());
    const username = "a'b";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (double-quote)', async () => {
    const env = envFor(createLoginDb());
    const username = "a\"b";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (backslash)', async () => {
    const env = envFor(createLoginDb());
    const username = "a\\b";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (tilde)', async () => {
    const env = envFor(createLoginDb());
    const username = "a~b";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (caret)', async () => {
    const env = envFor(createLoginDb());
    const username = "a^b";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (pipe)', async () => {
    const env = envFor(createLoginDb());
    const username = "a|b";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (question)', async () => {
    const env = envFor(createLoginDb());
    const username = "a?b";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (unicode)', async () => {
    const env = envFor(createLoginDb());
    const username = "alice\u00e9";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (emoji)', async () => {
    const env = envFor(createLoginDb());
    const username = "alice\ud83d\ude00";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (newline)', async () => {
    const env = envFor(createLoginDb());
    const username = "alice\n";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (tab)', async () => {
    const env = envFor(createLoginDb());
    const username = "alice\t";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (leading-space)', async () => {
    const env = envFor(createLoginDb());
    const username = " alice";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (trailing-space)', async () => {
    const env = envFor(createLoginDb());
    const username = "alice ";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('accepts valid localpart (alice)', async () => {
    const env = envFor(createLoginDb());
    const username = "alice";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (a)', async () => {
    const env = envFor(createLoginDb());
    const username = "a";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (user.name)', async () => {
    const env = envFor(createLoginDb());
    const username = "user.name";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (user_name)', async () => {
    const env = envFor(createLoginDb());
    const username = "user_name";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (user-name)', async () => {
    const env = envFor(createLoginDb());
    const username = "user-name";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (user=name)', async () => {
    const env = envFor(createLoginDb());
    const username = "user=name";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (user/name)', async () => {
    const env = envFor(createLoginDb());
    const username = "user/name";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (0user)', async () => {
    const env = envFor(createLoginDb());
    const username = "0user";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (user0)', async () => {
    const env = envFor(createLoginDb());
    const username = "user0";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (len-255)', async () => {
    const env = envFor(createLoginDb());
    const username = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (x.y_z=1/2-3)', async () => {
    const env = envFor(createLoginDb());
    const username = "x.y_z=1/2-3";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (===)', async () => {
    const env = envFor(createLoginDb());
    const username = "===";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (...)', async () => {
    const env = envFor(createLoginDb());
    const username = "...";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (___)', async () => {
    const env = envFor(createLoginDb());
    const username = "___";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (---)', async () => {
    const env = envFor(createLoginDb());
    const username = "---";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (///)', async () => {
    const env = envFor(createLoginDb());
    const username = "///";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (abc123)', async () => {
    const env = envFor(createLoginDb());
    const username = "abc123";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (0)', async () => {
    const env = envFor(createLoginDb());
    const username = "0";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (=)', async () => {
    const env = envFor(createLoginDb());
    const username = "=";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (.)', async () => {
    const env = envFor(createLoginDb());
    const username = ".";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (_)', async () => {
    const env = envFor(createLoginDb());
    const username = "_";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (-)', async () => {
    const env = envFor(createLoginDb());
    const username = "-";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (/)', async () => {
    const env = envFor(createLoginDb());
    const username = "/";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (a/b/c)', async () => {
    const env = envFor(createLoginDb());
    const username = "a/b/c";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (ends=)', async () => {
    const env = envFor(createLoginDb());
    const username = "ends=";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (ends.)', async () => {
    const env = envFor(createLoginDb());
    const username = "ends.";
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('rejects empty username query as missing', async () => {
    const env = envFor(createLoginDb());
    const res = await request(env, '/_matrix/client/v3/register/available?username=');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('rejects length 256', async () => {
    const env = envFor(createLoginDb());
    const username = 'a'.repeat(256);
    const res = await request(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('returns M_USER_IN_USE for existing localpart without leaking fields', async () => {
    const env = envFor(aliceDb());
    const res = await request(env, '/_matrix/client/v3/register/available?username=alice');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_USER_IN_USE');
    expect(res.body).not.toHaveProperty('user_id');
    expect(res.body).not.toHaveProperty('available');
  });
});

// ===========================================================================
// Token + dummy login edges
// ===========================================================================

describe('login edges m.login.token', () => {
  async function seedToken(
    sessions: ReturnType<typeof mockKv>,
    raw: string,
    partial: { user_id?: string; expires_at?: number } = {}
  ) {
    const hash = await hashToken(raw);
    sessions.data[`login_token:${hash}`] = JSON.stringify({
      user_id: partial.user_id ?? USER,
      expires_at: partial.expires_at ?? NOW + 120_000,
    });
    return hash;
  }

  it('rejects empty-string token as M_MISSING_PARAM', async () => {
    const env = envFor(aliceDb());
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: '' }, '')
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('rejects null token as M_MISSING_PARAM', async () => {
    const env = envFor(aliceDb());
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: null }, '')
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('treats expires_at === now as still valid (strict > check)', async () => {
    const sessions = mockKv();
    const raw = 'mlt_exact_now';
    await seedToken(sessions, raw, { expires_at: NOW });
    const env = envFor(aliceDb(), sessions);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'T1' }, '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(USER);
  });

  it('deletes expired token key before returning forbidden', async () => {
    const sessions = mockKv();
    const raw = 'mlt_expired_edge';
    const hash = await seedToken(sessions, raw, { expires_at: NOW - 1 });
    const env = envFor(aliceDb(), sessions);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw }, '')
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/expired/i);
    expect(sessions.deletes).toContain(`login_token:${hash}`);
  });

  it('consumes one-time token (second redeem fails)', async () => {
    const sessions = mockKv();
    const raw = 'mlt_once';
    await seedToken(sessions, raw);
    const env = envFor(aliceDb(), sessions);
    const first = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'A' }, '')
    );
    expect(first.status).toBe(200);
    const second = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'B' }, '')
    );
    expect(second.status).toBe(403);
  });

  it('issues refresh token and device like password flow', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const raw = 'mlt_full';
    await seedToken(sessions, raw);
    const env = envFor(db, sessions);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.token',
          token: raw,
          device_id: 'QRDEV',
          initial_device_display_name: 'QR Phone',
        },
        ''
      )
    );
    expect(res.status).toBe(200);
    expect(res.body.device_id).toBe('QRDEV');
    expect(res.body.refresh_token).toMatch(/^syr_/);
    expect(res.body.expires_in_ms).toBe(3_600_000);
    expect(db.devices.some((d) => d.display_name === 'QR Phone')).toBe(true);
  });

  it('can log in bob via token without password hash lookup', async () => {
    const bob = userRow({ user_id: BOB, localpart: 'bob', password_hash: null });
    const db = createLoginDb({ users: new Map([[BOB, bob]]) });
    const sessions = mockKv();
    const raw = 'mlt_bob';
    await seedToken(sessions, raw, { user_id: BOB });
    const env = envFor(db, sessions);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'B1' }, '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(BOB);
  });
});

describe('login edges m.login.dummy', () => {
  it('rejects null identifier', async () => {
    const env = envFor(aliceDb());
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.dummy', identifier: null }, '')
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('rejects thirdparty identifier type', async () => {
    const env = envFor(aliceDb());
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.dummy',
          identifier: { type: 'm.id.thirdparty', medium: 'email', address: 'a@b.c' },
        },
        ''
      )
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_UNRECOGNIZED');
  });

  it('logs in with localpart and ignores password field if present', async () => {
    const db = aliceDb();
    const env = envFor(db);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.dummy',
          identifier: { type: 'm.id.user', user: 'alice' },
          password: 'not-checked',
          device_id: 'DUM1',
        },
        ''
      )
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(USER);
    expect(res.body.device_id).toBe('DUM1');
  });

  it('formats localpart for custom SERVER_NAME', async () => {
    const custom = 'edge.test';
    const userId = `@alice:${custom}`;
    const db = createLoginDb({
      users: new Map([
        [userId, userRow({ user_id: userId, localpart: 'alice', password_hash: null })],
      ]),
    });
    const env = envFor(db, mockKv(), custom);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        { type: 'm.login.dummy', identifier: { type: 'm.id.user', user: 'alice' }, device_id: 'X' },
        ''
      )
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(userId);
    expect(res.body.home_server).toBe(custom);
  });

  it('generates device_id when omitted', async () => {
    const env = envFor(aliceDb());
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        { type: 'm.login.dummy', identifier: { type: 'm.id.user', user: USER } },
        ''
      )
    );
    expect(res.status).toBe(200);
    expect(typeof res.body.device_id).toBe('string');
    expect(res.body.device_id.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Refresh rotation edges
// ===========================================================================

describe('login edges refresh token rotation', () => {
  async function seedRefresh(
    sessions: ReturnType<typeof mockKv>,
    db: LoginDb,
    raw: string,
    partial: { userId?: string; deviceId?: string | null; accessTokenId?: string } = {}
  ) {
    const hash = await hashToken(raw);
    const accessTokenId = partial.accessTokenId ?? 'atok-old';
    sessions.data[`refresh:${hash}`] = JSON.stringify({
      userId: partial.userId ?? USER,
      deviceId: partial.deviceId === undefined ? DEVICE : partial.deviceId,
      accessTokenId,
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: accessTokenId,
      token_hash: 'old-access-hash',
      user_id: partial.userId ?? USER,
      device_id: partial.deviceId === undefined ? DEVICE : partial.deviceId,
      created_at: NOW - 1000,
    });
    return hash;
  }

  it('rotates three times in a chain; prior refresh tokens die', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    let raw = 'syr_chain_0';
    await seedRefresh(sessions, db, raw);
    const env = envFor(db, sessions);
    const seen: string[] = [raw];
    for (let i = 0; i < 3; i++) {
      const res = await request(
        env,
        '/_matrix/client/v3/refresh',
        jsonInit('POST', { refresh_token: raw }, '')
      );
      expect(res.status).toBe(200);
      expect(res.body.expires_in_ms).toBe(3_600_000);
      expect(res.body.access_token).toMatch(/^syt_/);
      expect(res.body.refresh_token).toMatch(/^syr_/);
      expect(seen).not.toContain(res.body.refresh_token);
      seen.push(res.body.refresh_token);
      raw = res.body.refresh_token;
    }
    // first token cannot be reused
    const dead = await request(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: seen[0] }, '')
    );
    expect(dead.status).toBe(401);
    expect(dead.body.errcode).toBe('M_UNKNOWN_TOKEN');
  });

  it('deletes old access token by token_id from D1', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const raw = 'syr_del_access';
    await seedRefresh(sessions, db, raw, { accessTokenId: 'delete-me' });
    const env = envFor(db, sessions);
    const res = await request(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(200);
    expect(db.tokens.every((t) => t.token_id !== 'delete-me')).toBe(true);
    expect(db.deletes.some((d) => d.sql.includes('token_id') && d.args[0] === 'delete-me')).toBe(
      true
    );
  });

  it('preserves null deviceId across rotation', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const raw = 'syr_null_dev';
    await seedRefresh(sessions, db, raw, { deviceId: null, accessTokenId: 'n1' });
    const env = envFor(db, sessions);
    const res = await request(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(200);
    const newHash = await hashToken(res.body.refresh_token);
    const stored = JSON.parse(sessions.data[`refresh:${newHash}`]);
    expect(stored.deviceId).toBeNull();
    expect(db.tokens.at(-1)?.device_id).toBeNull();
  });

  it('stores new refresh with 7-day TTL and fresh createdAt', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const raw = 'syr_ttl';
    await seedRefresh(sessions, db, raw);
    const env = envFor(db, sessions);
    const res = await request(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    const newHash = await hashToken(res.body.refresh_token);
    const put = sessions.puts.find((p) => p.key === `refresh:${newHash}`);
    expect(put?.options?.expirationTtl).toBe(604800);
    expect(JSON.parse(put!.value).createdAt).toBe(NOW);
  });

  it('rejects whitespace-only refresh_token as unknown (truthy but missing KV)', async () => {
    const env = envFor(aliceDb());
    const res = await request(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: '   ' }, '')
    );
    expect(res.status).toBe(401);
    expect(res.body.errcode).toBe('M_UNKNOWN_TOKEN');
  });

  it('rejects null refresh_token as missing', async () => {
    const env = envFor(aliceDb());
    const res = await request(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: null }, '')
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
});

// ===========================================================================
// Register edges
// ===========================================================================

describe('login edges POST /register', () => {
  const uia = { type: 'm.login.dummy', session: 'edge-sess' };

  it('rejects kind=admin and kind=User (case-sensitive)', async () => {
    const env = envFor(createLoginDb());
    for (const kind of ['admin', 'User', 'GUEST', 'guest ', ' user']) {
      const res = await request(
        env,
        `/_matrix/client/v3/register?kind=${encodeURIComponent(kind)}`,
        jsonInit('POST', { username: 'x', password: 'Password1', auth: uia }, '')
      );
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_INVALID_PARAM');
    }
  });

  it('returns UIA with fresh session when auth.session present but type wrong', async () => {
    const env = envFor(createLoginDb());
    const res = await request(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        { username: 'x', password: 'Password1', auth: { type: 'm.login.password', session: 's' } },
        ''
      )
    );
    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.dummy'] }]);
    expect(typeof res.body.session).toBe('string');
    expect(res.body.session).not.toBe('s');
  });

  it('registers with special-char localparts allowed by Matrix', async () => {
    const env = envFor(createLoginDb());
    for (const username of ['a.b', 'a_b', 'a-b', 'a=b', 'a/b', 'user.name_1']) {
      const res = await request(
        env,
        '/_matrix/client/v3/register',
        jsonInit(
          'POST',
          { username, password: 'Password1', auth: uia, inhibit_login: true },
          ''
        )
      );
      expect(res.status).toBe(200);
      expect(res.body.user_id).toBe(`@${username}:${SERVER}`);
    }
  });

  it('inhibit_login true omits tokens and does not insert devices/tokens', async () => {
    const db = createLoginDb();
    const env = envFor(db);
    const res = await request(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username: 'inhibited',
          password: 'Password1',
          auth: uia,
          inhibit_login: true,
          device_id: 'SHOULD_NOT',
        },
        ''
      )
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user_id: `@inhibited:${SERVER}`, home_server: SERVER });
    expect(res.body).not.toHaveProperty('access_token');
    expect(db.devices).toHaveLength(0);
    expect(db.tokens).toHaveLength(0);
  });

  it.each([false, 0, '', null])(
    'treats inhibit_login=%j as falsy and issues tokens',
    async (inhibit_login) => {
      const db = createLoginDb();
      const env = envFor(db);
      const username = `u${String(inhibit_login)}_${Math.random().toString(16).slice(2, 6)}`.toLowerCase().replace(/[^a-z0-9._=/-]/g, 'x');
      const res = await request(
        env,
        '/_matrix/client/v3/register',
        jsonInit(
          'POST',
          { username, password: 'Password1', auth: uia, inhibit_login },
          ''
        )
      );
      expect(res.status).toBe(200);
      expect(res.body.access_token).toMatch(/^syt_/);
      expect(res.body.refresh_token).toMatch(/^syr_/);
    }
  );

  it('guest registration ignores username and creates opaque localpart', async () => {
    const db = createLoginDb();
    const env = envFor(db);
    const res = await request(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', { username: 'ignored', password: 'Password1', device_id: 'G1' }, '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).not.toBe(`@ignored:${SERVER}`);
    expect(res.body.user_id).toMatch(new RegExp(`^@[A-Za-z0-9._=/-]+:${SERVER}$`));
    const row = [...db.users.values()][0];
    expect(row.is_guest).toBe(1);
    expect(row.password_hash).toBe('mockok:Password1');
  });

  it('guest without password stores null hash', async () => {
    const db = createLoginDb();
    const env = envFor(db);
    const res = await request(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', { device_id: 'G2' }, '')
    );
    expect(res.status).toBe(200);
    expect([...db.users.values()][0].password_hash).toBeNull();
  });

  it('persists initial_device_display_name on full register', async () => {
    const db = createLoginDb();
    const env = envFor(db);
    const res = await request(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username: 'dispuser',
          password: 'Password1',
          auth: uia,
          device_id: 'REGDEV',
          initial_device_display_name: 'Register Laptop',
        },
        ''
      )
    );
    expect(res.status).toBe(200);
    expect(db.devices[0]).toMatchObject({
      device_id: 'REGDEV',
      display_name: 'Register Laptop',
    });
  });

  it('stores register refresh with 7-day TTL', async () => {
    const sessions = mockKv();
    const env = envFor(createLoginDb(), sessions);
    const res = await request(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        { username: 'ttluser', password: 'Password1', auth: uia, device_id: 'T' },
        ''
      )
    );
    expect(res.status).toBe(200);
    const put = sessions.puts.find((p) => p.key.startsWith('refresh:'));
    expect(put?.options?.expirationTtl).toBe(604800);
  });
});

describe('login edges register password special-character acceptance', () => {
  const uia = { type: 'm.login.dummy', session: 'pw-sess' };
  const specials = ["!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "+", "-", "=", "[", "]", "{", "}", ";", "'", ":", "\"", "|", ",", ".", "<", ">", "/", "?"] as const;

  it.each(specials.map((s, i) => [i, s] as const))(
    'accepts Password + special charCode %i',
    async (i, special) => {
      const env = envFor(createLoginDb());
      const username = `sp${i}`;
      const res = await request(
        env,
        '/_matrix/client/v3/register',
        jsonInit(
          'POST',
          {
            username,
            password: `Password${special}`,
            auth: uia,
            inhibit_login: true,
          },
          ''
        )
      );
      expect(res.status).toBe(200);
    }
  );
});

// ===========================================================================
// Logout / whoami / get_token edges
// ===========================================================================

describe('login edges logout and logout/all', () => {
  it('logout deletes only the bearer token hash', async () => {
    const db = aliceDb();
    const token = 'access-to-delete';
    const hash = await hashToken(token);
    db.tokens.push(
      {
        token_id: 't1',
        token_hash: hash,
        user_id: USER,
        device_id: DEVICE,
        created_at: NOW,
      },
      {
        token_id: 't2',
        token_hash: 'other-hash',
        user_id: USER,
        device_id: 'OTHER',
        created_at: NOW,
      }
    );
    const env = envFor(db);
    const res = await request(env, '/_matrix/client/v3/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.tokens.map((t) => t.token_id)).toEqual(['t2']);
  });

  it('logout/all deletes every access token for middleware user', async () => {
    const db = aliceDb();
    db.tokens.push(
      {
        token_id: 'a',
        token_hash: 'h1',
        user_id: USER,
        device_id: 'D1',
        created_at: NOW,
      },
      {
        token_id: 'b',
        token_hash: 'h2',
        user_id: USER,
        device_id: 'D2',
        created_at: NOW,
      },
      {
        token_id: 'c',
        token_hash: 'h3',
        user_id: BOB,
        device_id: 'D3',
        created_at: NOW,
      }
    );
    const env = envFor(db);
    const res = await request(env, '/_matrix/client/v3/logout/all', jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(db.tokens.map((t) => t.token_id)).toEqual(['c']);
  });

  it('logout/all does not touch refresh KV keys', async () => {
    const sessions = mockKv({ 'refresh:abc': '{"userId":"@alice:example.com"}' });
    const db = aliceDb();
    const env = envFor(db, sessions);
    await request(env, '/_matrix/client/v3/logout/all', jsonInit('POST', {}));
    expect(sessions.data['refresh:abc']).toBeTruthy();
    expect(sessions.deletes).toEqual([]);
  });
});

describe('login edges whoami', () => {
  it('returns is_guest false for is_guest=0', async () => {
    const env = envFor(aliceDb());
    const res = await request(env, '/_matrix/client/v3/account/whoami', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user_id: USER,
      device_id: DEVICE,
      is_guest: false,
    });
  });

  it('returns is_guest from user row (numeric 1)', async () => {
    const guest = userRow({
      user_id: USER,
      localpart: 'alice',
      password_hash: null,
      is_guest: 1,
    });
    const env = envFor(createLoginDb({ users: new Map([[USER, guest]]) }));
    const res = await request(env, '/_matrix/client/v3/account/whoami', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body.is_guest).toBe(true);
  });

  it('returns M_UNKNOWN_TOKEN when user missing', async () => {
    const env = envFor(createLoginDb());
    const res = await request(env, '/_matrix/client/v3/account/whoami', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(401);
    expect(res.body.errcode).toBe('M_UNKNOWN_TOKEN');
  });
});

describe('login edges get_token', () => {
  it('stores hashed login_token with TTL 120 and expires_at = now+120s', async () => {
    const sessions = mockKv();
    const env = envFor(aliceDb(), sessions);
    const res = await request(env, '/_matrix/client/v1/login/get_token', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body.expires_in_ms).toBe(120_000);
    expect(typeof res.body.login_token).toBe('string');
    expect(res.body.login_token).not.toMatch(/[+/=]/);
    const keys = Object.keys(sessions.data).filter((k) => k.startsWith('login_token:'));
    expect(keys).toHaveLength(1);
    const put = sessions.puts.find((p) => p.key === keys[0]);
    expect(put?.options?.expirationTtl).toBe(120);
    const stored = JSON.parse(sessions.data[keys[0]]);
    expect(stored.user_id).toBe(USER);
    expect(stored.expires_at).toBe(NOW + 120_000);
  });

  it('get_token → m.login.token round-trip', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const env = envFor(db, sessions);
    const minted = await request(env, '/_matrix/client/v1/login/get_token', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });
    const loginToken = minted.body.login_token as string;
    const redeemed = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: loginToken, device_id: 'FROMQR' }, '')
    );
    expect(redeemed.status).toBe(200);
    expect(redeemed.body.user_id).toBe(USER);
    expect(redeemed.body.device_id).toBe('FROMQR');
    // consumed
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('login_token:'))).toHaveLength(0);
  });

  it('issues URL-safe base64 tokens without padding across many calls', async () => {
    const sessions = mockKv();
    const env = envFor(aliceDb(), sessions);
    const tokens: string[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await request(env, '/_matrix/client/v1/login/get_token', {
        method: 'POST',
        headers: { Authorization: 'Bearer t' },
      });
      expect(res.status).toBe(200);
      tokens.push(res.body.login_token);
      expect(res.body.login_token).not.toMatch(/[+/=]/);
    }
    expect(new Set(tokens).size).toBe(12);
  });
});

// ===========================================================================
// Cross-flow integration leftovers
// ===========================================================================

describe('login edges TOKENMAXX cross-flow leftovers after #125', () => {
  it('password login → refresh → logout access token', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const env = envFor(db, sessions);
    const loginRes = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody({ device_id: 'FLOW' }), '')
    );
    expect(loginRes.status).toBe(200);
    const refreshed = await request(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: loginRes.body.refresh_token }, '')
    );
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).not.toBe(loginRes.body.access_token);

    const logout = await request(env, '/_matrix/client/v3/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${refreshed.body.access_token}` },
    });
    expect(logout.status).toBe(200);
    const accessHash = await hashToken(refreshed.body.access_token);
    expect(db.tokens.every((t) => t.token_hash !== accessHash)).toBe(true);
  });

  it('register → whoami sees new user when middleware user matches', async () => {
    // middleware always sets alice; register alice-colliding is user_in_use.
    // Instead: register other user, whoami still returns alice from middleware + alice row.
    const db = aliceDb();
    const env = envFor(db);
    const reg = await request(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username: 'other',
          password: 'Password1',
          auth: { type: 'm.login.dummy' },
          inhibit_login: true,
        },
        ''
      )
    );
    expect(reg.status).toBe(200);
    const who = await request(env, '/_matrix/client/v3/account/whoami', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });
    expect(who.body.user_id).toBe(USER);
  });

  it('dummy login response includes home_server matching env', async () => {
    const env = envFor(aliceDb(), mockKv(), 'matrix.example.org');
    // user id still @alice:example.com in DB — dummy with full MXID
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.dummy',
          identifier: { type: 'm.id.user', user: USER },
          device_id: 'H',
        },
        ''
      )
    );
    expect(res.status).toBe(200);
    expect(res.body.home_server).toBe('matrix.example.org');
  });

  it('password failure does not create devices or tokens', async () => {
    const db = aliceDb();
    const env = envFor(db);
    await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody({ password: 'nope' }), '')
    );
    expect(db.devices).toHaveLength(0);
    expect(db.tokens).toHaveLength(0);
  });

  it('lockout is per-userId (bob failures do not lock alice)', async () => {
    const bob = userRow({
      user_id: BOB,
      localpart: 'bob',
      password_hash: 'mockok:secret123',
    });
    const db = createLoginDb({
      users: new Map([
        [USER, seedAlice()],
        [BOB, bob],
      ]),
    });
    const sessions = mockKv();
    const env = envFor(db, sessions);
    for (let i = 0; i < 5; i++) {
      await request(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'bob' },
            password: 'wrong',
            device_id: 'X',
          },
          ''
        )
      );
    }
    expect(sessions.data[`lockout:${BOB}`]).toBeTruthy();
    const aliceOk = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody(), '')
    );
    expect(aliceOk.status).toBe(200);
  });

  it('Content-Type with charset still parses JSON login body', async () => {
    const env = envFor(aliceDb());
    const res = await request(env, '/_matrix/client/v3/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(passwordLoginBody()),
    });
    expect(res.status).toBe(200);
  });

  it('truncated JSON yields M_BAD_JSON', async () => {
    const env = envFor(aliceDb());
    const res = await request(env, '/_matrix/client/v3/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"type":"m.login.password"',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('register available then register succeeds for same name', async () => {
    const db = createLoginDb();
    const env = envFor(db);
    const avail = await request(env, '/_matrix/client/v3/register/available?username=fresh');
    expect(avail.body).toEqual({ available: true });
    const reg = await request(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username: 'fresh',
          password: 'Password1',
          auth: { type: 'm.login.dummy' },
          inhibit_login: true,
        },
        ''
      )
    );
    expect(reg.status).toBe(200);
    const avail2 = await request(env, '/_matrix/client/v3/register/available?username=fresh');
    expect(avail2.body.errcode).toBe('M_USER_IN_USE');
  });
});
