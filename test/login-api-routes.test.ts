/**
 * TOKENMAXX HEAVY deepen after #94/#96/#99 — different slice: login/register API routes.
 * Avoids keys (#99), key-backups (#96), search (#94). Tests-only — no product inventing.
 * Exercises login flows, lockout, refresh rotation, register/guest, logout, whoami,
 * and get_token via Hono app.request().
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
    // Avoid 100k-iter PBKDF2 in login/register loops; product paths still call these.
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

  // Keep localpart index in sync when seeding via Map only
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

              throw new Error(`Unhandled SQL in login test stub: ${sql.slice(0, 140)}`);
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
  sessions?: ReturnType<typeof mockKv>
): Env & { _sessions: ReturnType<typeof mockKv> } {
  const SESSIONS = sessions ?? mockKv();
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
    SESSIONS,
    _sessions: SESSIONS,
  } as unknown as Env & { _sessions: ReturnType<typeof mockKv> };
}

async function request(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown; headers: Headers }> {
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

describe('login GET /login', () => {
  it('lists password, token, and dummy flows', async () => {
    const env = envFor(createLoginDb());
    const res = await request(env, '/_matrix/client/v3/login');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      flows: [
        { type: 'm.login.password' },
        { type: 'm.login.token' },
        { type: 'm.login.dummy' },
      ],
    });
  });
});

describe('login POST /login — JSON and type validation', () => {
  it('rejects non-JSON body with M_BAD_JSON', async () => {
    const env = envFor(createLoginDb());
    const res = await request(env, '/_matrix/client/v3/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('rejects unknown login type with M_UNRECOGNIZED', async () => {
    const env = envFor(createLoginDb());
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.sso' }, '')
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_UNRECOGNIZED',
      error: expect.stringContaining('Unknown login type'),
    });
  });

  it('rejects password login missing identifier or password', async () => {
    const env = envFor(createLoginDb());
    const a = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.password', password: 'x' }, '')
    );
    expect(a.status).toBe(400);
    expect(a.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });

    const b = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        { type: 'm.login.password', identifier: { type: 'm.id.user', user: 'alice' } },
        ''
      )
    );
    expect(b.status).toBe(400);
    expect(b.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('rejects unknown identifier type for password login', async () => {
    const env = envFor(createLoginDb());
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.thirdparty', medium: 'email', address: 'a@b.c' },
          password: 'secret123',
        },
        ''
      )
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_UNRECOGNIZED',
      error: expect.stringContaining('Unknown identifier type'),
    });
  });
});

describe('login POST /login — password flow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts localpart identifier and returns tokens + expires_in_ms', async () => {
    const db = createLoginDb({
      users: new Map([[USER, seedAlice()]]),
    });
    const env = envFor(db);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody(), '')
    );
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe(DEVICE);
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(String(body.access_token)).toMatch(/^syt_/);
    expect(typeof body.refresh_token).toBe('string');
    expect(String(body.refresh_token)).toMatch(/^syr_/);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(db.devices).toHaveLength(1);
    expect(db.devices[0]).toMatchObject({
      user_id: USER,
      device_id: DEVICE,
      display_name: 'Test Device',
    });
    expect(db.tokens).toHaveLength(1);
    expect(env._sessions.puts.some((p) => p.key.startsWith('refresh:'))).toBe(true);
    expect(
      env._sessions.puts.find((p) => p.key.startsWith('refresh:'))?.options?.expirationTtl
    ).toBe(7 * 24 * 60 * 60);
  });

  it('accepts full MXID identifier and generates device_id when omitted', async () => {
    const db = createLoginDb({
      users: new Map([[USER, seedAlice()]]),
    });
    const env = envFor(db);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        passwordLoginBody({
          identifier: { type: 'm.id.user', user: USER },
          device_id: undefined,
        }),
        ''
      )
    );
    expect(res.status).toBe(200);
    const body = res.body as { user_id: string; device_id: string };
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBeTruthy();
    expect(body.device_id).not.toBe(DEVICE);
    expect(db.devices[0].device_id).toBe(body.device_id);
  });

  it('rejects unknown user (no password hash) with M_FORBIDDEN', async () => {
    const env = envFor(createLoginDb());
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody(), '')
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Invalid username or password',
    });
  });

  it('rejects wrong password and increments lockout attempts', async () => {
    const db = createLoginDb({
      users: new Map([[USER, seedAlice()]]),
    });
    const sessions = mockKv();
    const env = envFor(db, sessions);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody({ password: 'wrong-pass' }), '')
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
    const lockout = JSON.parse(sessions.data[`lockout:${USER}`]);
    expect(lockout).toEqual({ attempts: 1 });
    expect(sessions.puts[0].options?.expirationTtl).toBe(3600);
  });

  it('locks account after 5 failed attempts with M_LIMIT_EXCEEDED', async () => {
    const now = 1_700_000_100_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const db = createLoginDb({
      users: new Map([[USER, seedAlice()]]),
    });
    const sessions = mockKv({
      [`lockout:${USER}`]: JSON.stringify({ attempts: 4 }),
    });
    const env = envFor(db, sessions);

    const fail = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody({ password: 'nope' }), '')
    );
    expect(fail.status).toBe(403);
    const stored = JSON.parse(sessions.data[`lockout:${USER}`]);
    expect(stored.attempts).toBe(5);
    expect(stored.lockedUntil).toBe(now + 15 * 60 * 1000);

    const locked = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody(), '')
    );
    expect(locked.status).toBe(429);
    expect(locked.body).toMatchObject({
      errcode: 'M_LIMIT_EXCEEDED',
      error: expect.stringContaining('Too many failed login attempts'),
      retry_after_ms: expect.any(Number),
    });
    expect((locked.body as { retry_after_ms: number }).retry_after_ms).toBeGreaterThan(0);
  });

  it('clears lockout counter on successful password login', async () => {
    const db = createLoginDb({
      users: new Map([[USER, seedAlice()]]),
    });
    const sessions = mockKv({
      [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }),
    });
    const env = envFor(db, sessions);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody(), '')
    );
    expect(res.status).toBe(200);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
    expect(sessions.deletes).toContain(`lockout:${USER}`);
  });

  it('allows login after lockout window expires', async () => {
    const now = 1_700_000_200_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const db = createLoginDb({
      users: new Map([[USER, seedAlice()]]),
    });
    const sessions = mockKv({
      [`lockout:${USER}`]: JSON.stringify({
        attempts: 5,
        lockedUntil: now - 1,
      }),
    });
    const env = envFor(db, sessions);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody(), '')
    );
    expect(res.status).toBe(200);
    expect(sessions.deletes).toContain(`lockout:${USER}`);
  });

  it('rejects deactivated users with M_USER_DEACTIVATED', async () => {
    const db = createLoginDb({
      users: new Map([
        [
          USER,
          userRow({
            user_id: USER,
            localpart: 'alice',
            password_hash: 'mockok:secret123',
            is_deactivated: 1,
          }),
        ],
      ]),
    });
    const env = envFor(db);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody(), '')
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_USER_DEACTIVATED' });
  });

  it('rejects when password verifies but user row is missing', async () => {
    // Password hash lookup succeeds via a synthetic first() path, but getUserById fails.
    // Simulate by seeding only password via a user that we remove after hash check —
    // instead: put hash in a user then wipe users map before getUserById by using
    // a custom db that returns hash once then null for profile select.
    const inserts: SqlCall[] = [];
    const deletes: SqlCall[] = [];
    let hashCalls = 0;
    const customDb = {
      users: new Map(),
      usersByLocalpart: new Map(),
      devices: [] as DeviceRow[],
      tokens: [] as TokenRow[],
      inserts,
      deletes,
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                if (sql.includes('SELECT password_hash FROM users')) {
                  hashCalls += 1;
                  return { password_hash: 'mockok:secret123' } as T;
                }
                if (sql.includes('FROM users WHERE user_id = ?')) {
                  return null;
                }
                return null;
              },
              async run() {
                inserts.push({ sql, args });
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    };
    const env = envFor(customDb as unknown as LoginDb);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody(), '')
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Invalid username or password',
    });
    expect(hashCalls).toBe(1);
  });
});

describe('login POST /login — token flow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects missing token with M_MISSING_PARAM', async () => {
    const env = envFor(createLoginDb());
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token' }, '')
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('rejects unknown login token with M_FORBIDDEN', async () => {
    const env = envFor(createLoginDb());
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: 'nope' }, '')
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Invalid or expired login token',
    });
  });

  it('rejects expired login token, deletes it, and returns M_FORBIDDEN', async () => {
    const now = 1_700_000_300_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const rawToken = 'expired-login-token';
    const tokenHash = await hashToken(rawToken);
    const sessions = mockKv({
      [`login_token:${tokenHash}`]: JSON.stringify({
        user_id: USER,
        expires_at: now - 1,
      }),
    });
    const db = createLoginDb({
      users: new Map([[USER, seedAlice()]]),
    });
    const env = envFor(db, sessions);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: rawToken, device_id: DEVICE }, '')
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Login token has expired',
    });
    expect(sessions.deletes).toContain(`login_token:${tokenHash}`);
    expect(db.tokens).toHaveLength(0);
  });

  it('consumes one-time login token and issues session tokens', async () => {
    const now = 1_700_000_400_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const rawToken = 'valid-login-token';
    const tokenHash = await hashToken(rawToken);
    const sessions = mockKv({
      [`login_token:${tokenHash}`]: JSON.stringify({
        user_id: USER,
        expires_at: now + 60_000,
      }),
    });
    const db = createLoginDb({
      users: new Map([[USER, seedAlice()]]),
    });
    const env = envFor(db, sessions);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.token',
          token: rawToken,
          device_id: DEVICE,
          initial_device_display_name: 'QR Device',
        },
        ''
      )
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      user_id: USER,
      device_id: DEVICE,
      home_server: SERVER,
      expires_in_ms: 3_600_000,
    });
    expect(sessions.deletes).toContain(`login_token:${tokenHash}`);
    expect(sessions.data[`login_token:${tokenHash}`]).toBeUndefined();
    expect(db.devices[0].display_name).toBe('QR Device');

    // Token is one-time: second use fails
    const again = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: rawToken, device_id: DEVICE }, '')
    );
    expect(again.status).toBe(403);
  });
});

describe('login POST /login — dummy flow', () => {
  it('rejects missing identifier', async () => {
    const env = envFor(createLoginDb());
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.dummy' }, '')
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('rejects unknown identifier type', async () => {
    const env = envFor(createLoginDb());
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.dummy',
          identifier: { type: 'm.id.phone', country: 'US', phone: '1' },
        },
        ''
      )
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_UNRECOGNIZED' });
  });

  it('logs in with localpart without password verification', async () => {
    const db = createLoginDb({
      users: new Map([
        [
          USER,
          userRow({
            user_id: USER,
            localpart: 'alice',
            password_hash: null,
          }),
        ],
      ]),
    });
    const env = envFor(db);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.dummy',
          identifier: { type: 'm.id.user', user: 'alice' },
          device_id: DEVICE,
        },
        ''
      )
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ user_id: USER, device_id: DEVICE });
  });

  it('logs in with full MXID identifier', async () => {
    const db = createLoginDb({
      users: new Map([[USER, seedAlice()]]),
    });
    const env = envFor(db);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.dummy',
          identifier: { type: 'm.id.user', user: USER },
          device_id: DEVICE,
        },
        ''
      )
    );
    expect(res.status).toBe(200);
    expect((res.body as { user_id: string }).user_id).toBe(USER);
  });

  it('rejects dummy login for unknown user', async () => {
    const env = envFor(createLoginDb());
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.dummy',
          identifier: { type: 'm.id.user', user: 'ghost' },
          device_id: DEVICE,
        },
        ''
      )
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
});

describe('login POST /logout and /logout/all', () => {
  it('logout deletes the current access token by hash', async () => {
    const token = 'syt_current_session';
    const tokenHash = await hashToken(token);
    const db = createLoginDb({
      users: new Map([[USER, seedAlice()]]),
      tokens: [
        {
          token_id: 'tid1',
          token_hash: tokenHash,
          user_id: USER,
          device_id: DEVICE,
          created_at: 1,
        },
        {
          token_id: 'tid2',
          token_hash: 'otherhash',
          user_id: USER,
          device_id: 'OTHER',
          created_at: 1,
        },
      ],
    });
    const env = envFor(db);
    const res = await request(env, '/_matrix/client/v3/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.tokens.map((t) => t.token_id)).toEqual(['tid2']);
    expect(db.deletes[0].args).toEqual([tokenHash]);
  });

  it('logout with no extractable token still returns empty object', async () => {
    // requireAuth is mocked to always pass; extractAccessToken returns null without Bearer
    const db = createLoginDb();
    const env = envFor(db);
    const res = await request(env, '/_matrix/client/v3/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.deletes).toHaveLength(0);
  });

  it('logout/all deletes every token for the authenticated user', async () => {
    const db = createLoginDb({
      tokens: [
        {
          token_id: 'a',
          token_hash: 'h1',
          user_id: USER,
          device_id: DEVICE,
          created_at: 1,
        },
        {
          token_id: 'b',
          token_hash: 'h2',
          user_id: USER,
          device_id: 'D2',
          created_at: 1,
        },
        {
          token_id: 'c',
          token_hash: 'h3',
          user_id: BOB,
          device_id: 'D3',
          created_at: 1,
        },
      ],
    });
    const env = envFor(db);
    const res = await request(
      env,
      '/_matrix/client/v3/logout/all',
      jsonInit('POST', {})
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.tokens).toEqual([
      {
        token_id: 'c',
        token_hash: 'h3',
        user_id: BOB,
        device_id: 'D3',
        created_at: 1,
      },
    ]);
  });
});

describe('login POST /refresh', () => {
  it('rejects non-JSON body with M_BAD_JSON', async () => {
    const env = envFor(createLoginDb());
    const res = await request(env, '/_matrix/client/v3/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('rejects missing refresh_token with M_MISSING_PARAM', async () => {
    const env = envFor(createLoginDb());
    const res = await request(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', {}, '')
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('rejects unknown refresh token with M_UNKNOWN_TOKEN', async () => {
    const env = envFor(createLoginDb());
    const res = await request(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: 'syr_missing' }, '')
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      errcode: 'M_UNKNOWN_TOKEN',
      error: 'Invalid or expired refresh token',
    });
  });

  it('rotates refresh token: deletes old, issues new access+refresh pair', async () => {
    const oldRefresh = 'syr_old_refresh_token';
    const oldHash = await hashToken(oldRefresh);
    const sessions = mockKv({
      [`refresh:${oldHash}`]: JSON.stringify({
        userId: USER,
        deviceId: DEVICE,
        accessTokenId: 'old-access-id',
        createdAt: 1,
      }),
    });
    const db = createLoginDb({
      tokens: [
        {
          token_id: 'old-access-id',
          token_hash: 'oldhash',
          user_id: USER,
          device_id: DEVICE,
          created_at: 1,
        },
      ],
    });
    const env = envFor(db, sessions);
    const res = await request(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: oldRefresh }, '')
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      access_token: string;
      refresh_token: string;
      expires_in_ms: number;
    };
    expect(body.access_token).toMatch(/^syt_/);
    expect(body.refresh_token).toMatch(/^syr_/);
    expect(body.refresh_token).not.toBe(oldRefresh);
    expect(body.expires_in_ms).toBe(3_600_000);

    // Old refresh deleted; old access deleted; new access inserted; new refresh stored
    expect(sessions.deletes).toContain(`refresh:${oldHash}`);
    expect(sessions.data[`refresh:${oldHash}`]).toBeUndefined();
    expect(db.tokens.find((t) => t.token_id === 'old-access-id')).toBeUndefined();
    expect(db.tokens).toHaveLength(1);
    expect(db.tokens[0].user_id).toBe(USER);
    expect(db.tokens[0].device_id).toBe(DEVICE);

    const newRefreshHash = await hashToken(body.refresh_token);
    const stored = JSON.parse(sessions.data[`refresh:${newRefreshHash}`]);
    expect(stored).toMatchObject({
      userId: USER,
      deviceId: DEVICE,
      accessTokenId: db.tokens[0].token_id,
    });
    expect(
      sessions.puts.find((p) => p.key === `refresh:${newRefreshHash}`)?.options
        ?.expirationTtl
    ).toBe(7 * 24 * 60 * 60);

    // Rotated: old refresh cannot be reused
    const reuse = await request(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: oldRefresh }, '')
    );
    expect(reuse.status).toBe(401);
  });

  it('stores refresh data with null deviceId when original had null', async () => {
    const oldRefresh = 'syr_null_device';
    const oldHash = await hashToken(oldRefresh);
    const sessions = mockKv({
      [`refresh:${oldHash}`]: JSON.stringify({
        userId: USER,
        deviceId: null,
        accessTokenId: 'aid',
        createdAt: 1,
      }),
    });
    const db = createLoginDb({
      tokens: [
        {
          token_id: 'aid',
          token_hash: 'h',
          user_id: USER,
          device_id: null,
          created_at: 1,
        },
      ],
    });
    const env = envFor(db, sessions);
    const res = await request(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: oldRefresh }, '')
    );
    expect(res.status).toBe(200);
    expect(db.tokens[0].device_id).toBeNull();
  });
});

describe('login GET /register/available', () => {
  it('requires username query param', async () => {
    const env = envFor(createLoginDb());
    const res = await request(env, '/_matrix/client/v3/register/available');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('rejects invalid localpart characters', async () => {
    const env = envFor(createLoginDb());
    const res = await request(
      env,
      '/_matrix/client/v3/register/available?username=Alice'
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_INVALID_USERNAME',
      error: expect.stringContaining('invalid characters'),
    });
  });

  it('rejects empty username after query present as empty string', async () => {
    const env = envFor(createLoginDb());
    // username= is present but empty → missingParam path via !username
    const res = await request(env, '/_matrix/client/v3/register/available?username=');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('returns M_USER_IN_USE when localpart exists', async () => {
    const db = createLoginDb({
      users: new Map([[USER, seedAlice()]]),
    });
    const env = envFor(db);
    const res = await request(
      env,
      '/_matrix/client/v3/register/available?username=alice'
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_USER_IN_USE' });
  });

  it('returns available:true for unused valid localpart', async () => {
    const env = envFor(createLoginDb());
    const res = await request(
      env,
      '/_matrix/client/v3/register/available?username=carol'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts localparts with allowed special characters', async () => {
    const env = envFor(createLoginDb());
    const res = await request(
      env,
      '/_matrix/client/v3/register/available?username=a.b_c=d/e-1'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });
});

describe('login POST /register', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects non-JSON body with M_BAD_JSON', async () => {
    const env = envFor(createLoginDb());
    const res = await request(env, '/_matrix/client/v3/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('rejects invalid registration kind', async () => {
    const env = envFor(createLoginDb());
    const res = await request(
      env,
      '/_matrix/client/v3/register?kind=admin',
      jsonInit(
        'POST',
        { username: 'x', password: 'Password1', auth: { type: 'm.login.dummy' } },
        ''
      )
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_INVALID_PARAM',
      error: expect.stringContaining('Invalid registration kind'),
    });
  });

  it('returns UIA dummy challenge when auth is missing', async () => {
    const env = envFor(createLoginDb());
    const res = await request(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', { username: 'carol', password: 'Password1' }, '')
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.dummy'] }],
      params: {},
      session: expect.any(String),
    });
  });

  it('returns UIA challenge when auth type is not m.login.dummy', async () => {
    const env = envFor(createLoginDb());
    const res = await request(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username: 'carol',
          password: 'Password1',
          auth: { type: 'm.login.password' },
        },
        ''
      )
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.dummy'] }],
      session: expect.any(String),
    });
  });

  it('requires username after UIA dummy auth', async () => {
    const env = envFor(createLoginDb());
    const res = await request(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        { password: 'Password1', auth: { type: 'm.login.dummy' } },
        ''
      )
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('rejects invalid username characters after UIA', async () => {
    const env = envFor(createLoginDb());
    const res = await request(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username: 'BadUser',
          password: 'Password1',
          auth: { type: 'm.login.dummy' },
        },
        ''
      )
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_USERNAME' });
  });

  it('requires password after UIA', async () => {
    const env = envFor(createLoginDb());
    const res = await request(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        { username: 'carol', auth: { type: 'm.login.dummy' } },
        ''
      )
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('rejects weak passwords with M_WEAK_PASSWORD', async () => {
    const env = envFor(createLoginDb());
    const short = await request(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username: 'carol',
          password: 'short1',
          auth: { type: 'm.login.dummy' },
        },
        ''
      )
    );
    expect(short.status).toBe(400);
    expect(short.body).toMatchObject({
      errcode: 'M_WEAK_PASSWORD',
      error: expect.stringContaining('at least 8'),
    });

    const noLetter = await request(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username: 'carol',
          password: '12345678',
          auth: { type: 'm.login.dummy' },
        },
        ''
      )
    );
    expect(noLetter.status).toBe(400);
    expect(noLetter.body).toMatchObject({
      errcode: 'M_WEAK_PASSWORD',
      error: expect.stringContaining('letter'),
    });

    const noNumber = await request(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username: 'carol',
          password: 'onlyletters',
          auth: { type: 'm.login.dummy' },
        },
        ''
      )
    );
    expect(noNumber.status).toBe(400);
    expect(noNumber.body).toMatchObject({
      errcode: 'M_WEAK_PASSWORD',
      error: expect.stringContaining('number or special'),
    });
  });

  it('rejects registration when user id already exists', async () => {
    const db = createLoginDb({
      users: new Map([[USER, seedAlice()]]),
    });
    const env = envFor(db);
    const res = await request(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username: 'alice',
          password: 'Password1',
          auth: { type: 'm.login.dummy' },
        },
        ''
      )
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_USER_IN_USE' });
  });

  it('registers user, hashes password, and returns login tokens', async () => {
    const db = createLoginDb();
    const env = envFor(db);
    const res = await request(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username: 'carol',
          password: 'Password1',
          device_id: 'DEV1',
          initial_device_display_name: 'Phone',
          auth: { type: 'm.login.dummy' },
        },
        ''
      )
    );
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.user_id).toBe(`@carol:${SERVER}`);
    expect(body.device_id).toBe('DEV1');
    expect(body.home_server).toBe(SERVER);
    expect(body.access_token).toMatch(/^syt_/);
    expect(body.refresh_token).toMatch(/^syr_/);
    expect(body.expires_in_ms).toBe(3_600_000);

    const stored = db.users.get(`@carol:${SERVER}`);
    expect(stored?.password_hash).toBe('mockok:Password1');
    expect(stored?.is_guest).toBe(0);
    expect(db.devices[0]).toMatchObject({
      user_id: `@carol:${SERVER}`,
      device_id: 'DEV1',
      display_name: 'Phone',
    });
    expect(env._sessions.puts.some((p) => p.key.startsWith('refresh:'))).toBe(true);
  });

  it('honor inhibit_login and skips token issuance', async () => {
    const db = createLoginDb();
    const env = envFor(db);
    const res = await request(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username: 'dave',
          password: 'Password1',
          inhibit_login: true,
          auth: { type: 'm.login.dummy' },
        },
        ''
      )
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user_id: `@dave:${SERVER}`,
      home_server: SERVER,
    });
    expect(db.tokens).toHaveLength(0);
    expect(db.devices).toHaveLength(0);
    expect(env._sessions.puts).toHaveLength(0);
  });

  it('registers guest with opaque localpart and null password', async () => {
    const db = createLoginDb();
    const env = envFor(db);
    const res = await request(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', { device_id: 'GUESTDEV' }, '')
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      user_id: string;
      device_id: string;
      access_token: string;
    };
    expect(body.user_id).toMatch(new RegExp(`^@[^:]+:${SERVER}$`));
    expect(body.user_id).not.toBe(`@guest:${SERVER}`);
    expect(body.device_id).toBe('GUESTDEV');
    expect(body.access_token).toMatch(/^syt_/);

    const stored = db.users.get(body.user_id);
    expect(stored?.is_guest).toBe(1);
    expect(stored?.password_hash).toBeNull();
  });

  it('defaults kind to user when query omitted', async () => {
    const db = createLoginDb();
    const env = envFor(db);
    const res = await request(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username: 'erin',
          password: 'Password1!',
          auth: { type: 'm.login.dummy' },
          inhibit_login: true,
        },
        ''
      )
    );
    expect(res.status).toBe(200);
    expect(db.users.get(`@erin:${SERVER}`)?.is_guest).toBe(0);
  });

  it('generates device_id when omitted on full registration', async () => {
    const db = createLoginDb();
    const env = envFor(db);
    const res = await request(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username: 'frank',
          password: 'Password9',
          auth: { type: 'm.login.dummy' },
        },
        ''
      )
    );
    expect(res.status).toBe(200);
    const body = res.body as { device_id: string };
    expect(body.device_id).toBeTruthy();
    expect(db.devices[0].device_id).toBe(body.device_id);
  });
});

describe('login POST /v1/login/get_token', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores hashed login token in SESSIONS with 2-minute TTL', async () => {
    const now = 1_700_000_500_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const sessions = mockKv();
    const env = envFor(createLoginDb(), sessions);
    const res = await request(
      env,
      '/_matrix/client/v1/login/get_token',
      jsonInit('POST', {})
    );
    expect(res.status).toBe(200);
    const body = res.body as { login_token: string; expires_in_ms: number };
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(body.login_token.length).toBeGreaterThan(20);
    expect(body.login_token).not.toMatch(/[+/=]/);

    const tokenHash = await hashToken(body.login_token);
    const key = `login_token:${tokenHash}`;
    expect(sessions.data[key]).toBeTruthy();
    const stored = JSON.parse(sessions.data[key]);
    expect(stored).toEqual({
      user_id: USER,
      expires_at: now + 120_000,
    });
    expect(sessions.puts[0].options?.expirationTtl).toBe(120);
  });

  it('produces a token that can be redeemed via m.login.token', async () => {
    const now = 1_700_000_600_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const db = createLoginDb({
      users: new Map([[USER, seedAlice()]]),
    });
    const sessions = mockKv();
    const env = envFor(db, sessions);

    const issued = await request(
      env,
      '/_matrix/client/v1/login/get_token',
      jsonInit('POST', {})
    );
    const loginToken = (issued.body as { login_token: string }).login_token;

    const redeemed = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        { type: 'm.login.token', token: loginToken, device_id: 'FROMQR' },
        ''
      )
    );
    expect(redeemed.status).toBe(200);
    expect(redeemed.body).toMatchObject({
      user_id: USER,
      device_id: 'FROMQR',
    });
  });
});

describe('login GET /account/whoami', () => {
  it('returns user_id, device_id, and is_guest for existing user', async () => {
    const db = createLoginDb({
      users: new Map([[USER, seedAlice()]]),
    });
    const env = envFor(db);
    const res = await request(env, '/_matrix/client/v3/account/whoami');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user_id: USER,
      device_id: DEVICE,
      is_guest: false,
    });
  });

  it('returns is_guest true for guest accounts', async () => {
    const db = createLoginDb({
      users: new Map([
        [
          USER,
          userRow({
            user_id: USER,
            localpart: 'alice',
            is_guest: 1,
            password_hash: null,
          }),
        ],
      ]),
    });
    const env = envFor(db);
    const res = await request(env, '/_matrix/client/v3/account/whoami');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user_id: USER,
      device_id: DEVICE,
      is_guest: true,
    });
  });

  it('returns M_UNKNOWN_TOKEN when user row is missing', async () => {
    const env = envFor(createLoginDb());
    const res = await request(env, '/_matrix/client/v3/account/whoami');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
  });
});

describe('login TOKENMAXX integration leftovers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('password login stores refresh payload matching access token id', async () => {
    const db = createLoginDb({
      users: new Map([[USER, seedAlice()]]),
    });
    const env = envFor(db);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody(), '')
    );
    expect(res.status).toBe(200);
    const body = res.body as { refresh_token: string; access_token: string };
    const refreshHash = await hashToken(body.refresh_token);
    const stored = JSON.parse(env._sessions.data[`refresh:${refreshHash}`]);
    expect(stored.accessTokenId).toBe(db.tokens[0].token_id);
    expect(stored.userId).toBe(USER);
    expect(stored.deviceId).toBe(DEVICE);
    expect(typeof stored.createdAt).toBe('number');
  });

  it('failed attempts accumulate across requests until lock threshold', async () => {
    const now = 1_700_000_700_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const db = createLoginDb({
      users: new Map([[USER, seedAlice()]]),
    });
    const sessions = mockKv();
    const env = envFor(db, sessions);

    for (let i = 1; i <= 4; i++) {
      const res = await request(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', passwordLoginBody({ password: 'bad' }), '')
      );
      expect(res.status).toBe(403);
      expect(JSON.parse(sessions.data[`lockout:${USER}`]).attempts).toBe(i);
      expect(JSON.parse(sessions.data[`lockout:${USER}`]).lockedUntil).toBeUndefined();
    }

    const fifth = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody({ password: 'bad' }), '')
    );
    expect(fifth.status).toBe(403);
    expect(JSON.parse(sessions.data[`lockout:${USER}`])).toEqual({
      attempts: 5,
      lockedUntil: now + 15 * 60 * 1000,
    });
  });

  it('guest registration does not require UIA auth object', async () => {
    const env = envFor(createLoginDb());
    const res = await request(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', {}, '')
    );
    expect(res.status).toBe(200);
    expect((res.body as { access_token: string }).access_token).toBeTruthy();
  });

  it('register with kind=user explicitly still requires UIA', async () => {
    const env = envFor(createLoginDb());
    const res = await request(
      env,
      '/_matrix/client/v3/register?kind=user',
      jsonInit('POST', { username: 'gina', password: 'Password1' }, '')
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.dummy'] }],
    });
  });

  it('logout uses query access_token when Authorization header absent', async () => {
    const token = 'syt_query_token';
    const tokenHash = await hashToken(token);
    const db = createLoginDb({
      tokens: [
        {
          token_id: 'q1',
          token_hash: tokenHash,
          user_id: USER,
          device_id: DEVICE,
          created_at: 1,
        },
      ],
    });
    const env = envFor(db);
    const res = await request(
      env,
      `/_matrix/client/v3/logout?access_token=${encodeURIComponent(token)}`,
      { method: 'POST' }
    );
    expect(res.status).toBe(200);
    expect(db.tokens).toHaveLength(0);
  });
});


describe('login TOKENMAXX edge leftovers after #101', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects omitted login type as M_UNRECOGNIZED', async () => {
    const env = envFor(createLoginDb({ users: new Map([[USER, seedAlice()]]) }));
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { identifier: { type: 'm.id.user', user: 'alice' }, password: 'x' }, '')
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_UNRECOGNIZED' });
  });

  it('rejects empty-string password as M_MISSING_PARAM', async () => {
    const env = envFor(createLoginDb({ users: new Map([[USER, seedAlice()]]) }));
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody({ password: '' }), '')
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('token login rejects deactivated user after consuming token', async () => {
    const raw = 'mlt_deact';
    const tokenHash = await hashToken(raw);
    const sessions = mockKv({
      [`login_token:${tokenHash}`]: JSON.stringify({
        user_id: USER,
        expires_at: Date.now() + 60_000,
      }),
    });
    const db = createLoginDb({
      users: new Map([
        [
          USER,
          userRow({
            user_id: USER,
            localpart: 'alice',
            password_hash: 'mockok:secret123',
            is_deactivated: 1,
          }),
        ],
      ]),
    });
    const env = envFor(db, sessions);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: DEVICE }, '')
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_USER_DEACTIVATED' });
    expect(sessions.data[`login_token:${tokenHash}`]).toBeUndefined();
    expect(sessions.deletes).toContain(`login_token:${tokenHash}`);
  });

  it('dummy login rejects deactivated user', async () => {
    const db = createLoginDb({
      users: new Map([
        [
          USER,
          userRow({
            user_id: USER,
            localpart: 'alice',
            password_hash: null,
            is_deactivated: 1,
          }),
        ],
      ]),
    });
    const env = envFor(db);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.dummy',
          identifier: { type: 'm.id.user', user: 'alice' },
          device_id: DEVICE,
        },
        ''
      )
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_USER_DEACTIVATED' });
  });

  it('token login rejects when user missing after redeem', async () => {
    const raw = 'mlt_nouser';
    const tokenHash = await hashToken(raw);
    const sessions = mockKv({
      [`login_token:${tokenHash}`]: JSON.stringify({
        user_id: '@ghost:example.com',
        expires_at: Date.now() + 60_000,
      }),
    });
    const env = envFor(createLoginDb(), sessions);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw }, '')
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
    expect(sessions.deletes).toContain(`login_token:${tokenHash}`);
  });

  it('re-arms lockout after window expires on next failure', async () => {
    const t0 = 1_700_000_800_000;
    vi.spyOn(Date, 'now').mockReturnValue(t0);
    const sessions = mockKv({
      [`lockout:${USER}`]: JSON.stringify({
        attempts: 5,
        lockedUntil: t0 - 1,
      }),
    });
    const db = createLoginDb({ users: new Map([[USER, seedAlice()]]) });
    const env = envFor(db, sessions);

    const fail = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody({ password: 'bad' }), '')
    );
    expect(fail.status).toBe(403);
    const locked = JSON.parse(sessions.data[`lockout:${USER}`]);
    expect(locked.attempts).toBe(6);
    expect(locked.lockedUntil).toBe(t0 + 15 * 60 * 1000);

    const blocked = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody({ password: 'bad' }), '')
    );
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({
      errcode: 'M_LIMIT_EXCEEDED',
      retry_after_ms: locked.lockedUntil - t0,
    });
  });

  it('returns exact retry_after_ms from frozen clock', async () => {
    const now = 1_700_000_900_000;
    const lockedUntil = now + 42_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const sessions = mockKv({
      [`lockout:${USER}`]: JSON.stringify({ attempts: 5, lockedUntil }),
    });
    const env = envFor(createLoginDb({ users: new Map([[USER, seedAlice()]]) }), sessions);
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', passwordLoginBody({ password: 'bad' }), '')
    );
    expect(res.status).toBe(429);
    expect((res.body as { retry_after_ms: number }).retry_after_ms).toBe(42_000);
  });

  it('looks up foreign full MXID as-is without formatUserId', async () => {
    const env = envFor(createLoginDb());
    const res = await request(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        passwordLoginBody({
          identifier: { type: 'm.id.user', user: '@alice:other.com' },
        }),
        ''
      )
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('rejects empty refresh_token', async () => {
    const env = envFor(createLoginDb());
    const res = await request(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: '' }, '')
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('guest register hashes provided password and skips strength', async () => {
    const db = createLoginDb();
    const env = envFor(db);
    const res = await request(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', { password: 'x', device_id: 'G1' }, '')
    );
    expect(res.status).toBe(200);
    const body = res.body as { user_id: string };
    expect(db.users.get(body.user_id)?.password_hash).toBe('mockok:x');
    expect(db.users.get(body.user_id)?.is_guest).toBe(1);
  });

  it('guest register with inhibit_login returns no tokens', async () => {
    const db = createLoginDb();
    const env = envFor(db);
    const res = await request(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', { inhibit_login: true }, '')
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ home_server: SERVER });
    expect((res.body as { access_token?: string }).access_token).toBeUndefined();
    expect(db.tokens).toHaveLength(0);
    expect(db.devices).toHaveLength(0);
    expect(env._sessions.puts).toHaveLength(0);
  });

  it('register rejects empty-string username/password after UIA', async () => {
    const env = envFor(createLoginDb());
    const a = await request(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        { username: '', password: 'Password1', auth: { type: 'm.login.dummy' } },
        ''
      )
    );
    expect(a.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });

    const b = await request(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        { username: 'zoe', password: '', auth: { type: 'm.login.dummy' } },
        ''
      )
    );
    expect(b.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('register rejects password longer than 1000 chars', async () => {
    const env = envFor(createLoginDb());
    const pw = `Aa1${'y'.repeat(998)}`;
    expect(pw.length).toBe(1001);
    const res = await request(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        { username: 'longpw', password: pw, auth: { type: 'm.login.dummy' } },
        ''
      )
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_WEAK_PASSWORD',
      error: expect.stringMatching(/1000/),
    });
  });

  it('inhibit_login: 0 is falsy so tokens are issued', async () => {
    const db = createLoginDb();
    const env = envFor(db);
    const res = await request(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username: 'issued',
          password: 'Password1',
          auth: { type: 'm.login.dummy' },
          inhibit_login: 0,
        },
        ''
      )
    );
    expect(res.status).toBe(200);
    expect((res.body as { access_token: string }).access_token).toBeTruthy();
    expect((res.body as { refresh_token: string }).refresh_token).toBeTruthy();
  });

  it('register/available rejects 256-char and illegal charset localparts', async () => {
    const env = envFor(createLoginDb());
    const long = 'a'.repeat(256);
    const a = await request(env, `/_matrix/client/v3/register/available?username=${long}`);
    expect(a.status).toBe(400);
    expect(a.body).toMatchObject({ errcode: 'M_INVALID_USERNAME' });

    const b = await request(env, '/_matrix/client/v3/register/available?username=bad name');
    expect(b.status).toBe(400);
    expect(b.body).toMatchObject({ errcode: 'M_INVALID_USERNAME' });
  });

  it('get_token issues distinct tokens with 120000 expires_in_ms', async () => {
    const sessions = mockKv();
    const env = envFor(createLoginDb({ users: new Map([[USER, seedAlice()]]) }), sessions);
    const a = await request(env, '/_matrix/client/v1/login/get_token', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });
    const b = await request(env, '/_matrix/client/v1/login/get_token', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ta = (a.body as { login_token: string; expires_in_ms: number }).login_token;
    const tb = (b.body as { login_token: string }).login_token;
    expect(ta).not.toBe(tb);
    expect((a.body as { expires_in_ms: number }).expires_in_ms).toBe(120000);
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('login_token:'))).toHaveLength(2);
  });
});
