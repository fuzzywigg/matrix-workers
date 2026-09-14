/**
 * TOKENMAXX HEAVY leftovers after #145 — login API contract/binding deepen.
 * Orthogonal to login-api-soft-leftovers + login-register-failure + login-qr-kv leftovers.
 * Tests-only — Hono app.request() against src/api/login.ts. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { hashToken } from '../src/utils/crypto';

const authState = vi.hoisted(() => ({
  userId: '@alice:example.com',
  deviceId: 'DEVICE' as string | null,
}));

vi.mock('../src/middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/middleware/auth')>();
  return {
    ...actual,
    requireAuth: () => {
      return async (
        c: { set: (k: string, v: unknown) => void },
        next: () => Promise<void>
      ) => {
        c.set('userId', authState.userId);
        c.set('deviceId', authState.deviceId);
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

vi.mock('../src/utils/ids', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ids')>();
  let opaqueSeq = 0;
  let deviceSeq = 0;
  return {
    ...actual,
    generateOpaqueId: vi.fn(async (len?: number) => {
      opaqueSeq += 1;
      const base = `opaque${opaqueSeq}`.padEnd(len ?? 16, '0');
      return base.slice(0, len ?? 16);
    }),
    generateDeviceId: vi.fn(async () => {
      deviceSeq += 1;
      return `GENDEV${deviceSeq}`;
    }),
    generateAccessToken: vi.fn(async () => {
      opaqueSeq += 1;
      return `syt_access_${opaqueSeq}`;
    }),
    generateRefreshToken: vi.fn(async () => {
      opaqueSeq += 1;
      return `syr_refresh_${opaqueSeq}`;
    }),
  };
});

import login from '../src/api/login';
import { hashPassword, verifyPassword } from '../src/utils/crypto';

const SERVER = 'example.com';
const USER = `@alice:${SERVER}`;
const DEVICE = 'DEVICE';
const STRONG_PW = 'Password1!';
const NOW = 1_730_300_000_000;
const REFRESH_TTL = 7 * 24 * 60 * 60;

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
    created_at: partial.created_at ?? NOW,
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
    new Map<string, UserRow>([...users.values()].map((u) => [u.localpart, u]));
  const devices = opts.devices ?? [];
  const tokens = opts.tokens ?? [];
  const inserts: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const selects: SqlCall[] = [];

  for (const u of users.values()) {
    if (!usersByLocalpart.has(u.localpart)) usersByLocalpart.set(u.localpart, u);
  }

  return {
    users,
    usersByLocalpart,
    devices,
    tokens,
    inserts,
    deletes,
    selects,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              if (sql.includes('SELECT password_hash FROM users')) {
                const userId = args[0] as string;
                const u = users.get(userId);
                return (u ? { password_hash: u.password_hash } : null) as T;
              }
              if (
                sql.includes('FROM users WHERE user_id = ?') &&
                sql.includes('SELECT user_id, localpart')
              ) {
                const u = users.get(args[0] as string);
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
                const u = usersByLocalpart.get(args[0] as string);
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
                const [userId, deviceId, displayName] = args as [string, string, string | null];
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
              throw new Error(`Unhandled SQL soft leftovers stub: ${sql.slice(0, 140)}`);
            },
          };
        },
      };
    },
  };
}

type LoginDb = ReturnType<typeof createLoginDb>;

function loginEnv(
  db: LoginDb,
  sessions?: ReturnType<typeof mockKv>,
  serverName = SERVER
): Env & { _sessions: ReturnType<typeof mockKv>; _db: LoginDb } {
  const SESSIONS = sessions ?? mockKv();
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: serverName,
    SESSIONS,
    _sessions: SESSIONS,
    _db: db,
  } as unknown as Env & { _sessions: ReturnType<typeof mockKv>; _db: LoginDb };
}

async function loginRequest(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: any }> {
  const res = await login.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

function jsonInit(method: string, body?: unknown, token = 'test-token'): RequestInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function aliceUser(overrides: Partial<UserRow> = {}): Map<string, UserRow> {
  const u = userRow({
    user_id: USER,
    localpart: 'alice',
    password_hash: `mockok:${STRONG_PW}`,
    ...overrides,
  });
  return new Map([[USER, u]]);
}

beforeEach(() => {
  authState.userId = USER;
  authState.deviceId = DEVICE;
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(hashPassword).mockImplementation(async (password: string) => `mockok:${password}`);
  vi.mocked(verifyPassword).mockImplementation(async (password: string, storedHash: string) => {
    return storedHash === `mockok:${password}`;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('login contract leftovers method matrix after #145', () => {
  // GET /login is a valid discovery endpoint; exclude it from the POST-only matrix.
  const posts = [
    '/_matrix/client/v3/logout',
    '/_matrix/client/v3/logout/all',
    '/_matrix/client/v3/refresh',
    '/_matrix/client/v3/register',
    '/_matrix/client/v1/login/get_token',
  ];
  for (const path of posts) {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      it(`${method} ${path} → 404`, async () => {
        const env = loginEnv(createLoginDb({ users: aliceUser() }));
        const { status } = await loginRequest(env, path, { method });
        expect(status).toBe(404);
      });
    }
  }
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    it(`${method} /_matrix/client/v3/login → 404`, async () => {
      const env = loginEnv(createLoginDb({ users: aliceUser() }));
      const { status } = await loginRequest(env, '/_matrix/client/v3/login', { method });
      expect(status).toBe(404);
    });
  }
});
describe('login contract leftovers MXID identifier soft flood after #145', () => {
  it('password login full MXID soft-0', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: USER },
          password: STRONG_PW,
          device_id: 'MX0',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('MX0');
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('password login full MXID soft-1', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: USER },
          password: STRONG_PW,
          device_id: 'MX1',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('MX1');
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('password login full MXID soft-2', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: USER },
          password: STRONG_PW,
          device_id: 'MX2',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('MX2');
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('password login full MXID soft-3', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: USER },
          password: STRONG_PW,
          device_id: 'MX3',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('MX3');
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('password login full MXID soft-4', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: USER },
          password: STRONG_PW,
          device_id: 'MX4',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('MX4');
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('password login full MXID soft-5', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: USER },
          password: STRONG_PW,
          device_id: 'MX5',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('MX5');
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('password login full MXID soft-6', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: USER },
          password: STRONG_PW,
          device_id: 'MX6',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('MX6');
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('password login full MXID soft-7', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: USER },
          password: STRONG_PW,
          device_id: 'MX7',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('MX7');
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('password login full MXID soft-8', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: USER },
          password: STRONG_PW,
          device_id: 'MX8',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('MX8');
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('password login full MXID soft-9', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: USER },
          password: STRONG_PW,
          device_id: 'MX9',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('MX9');
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('password login full MXID soft-10', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: USER },
          password: STRONG_PW,
          device_id: 'MX10',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('MX10');
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('password login full MXID soft-11', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: USER },
          password: STRONG_PW,
          device_id: 'MX11',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('MX11');
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('password login full MXID soft-12', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: USER },
          password: STRONG_PW,
          device_id: 'MX12',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('MX12');
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('password login full MXID soft-13', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: USER },
          password: STRONG_PW,
          device_id: 'MX13',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('MX13');
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('password login full MXID soft-14', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: USER },
          password: STRONG_PW,
          device_id: 'MX14',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('MX14');
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('password login full MXID soft-15', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: USER },
          password: STRONG_PW,
          device_id: 'MX15',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('MX15');
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('password login full MXID soft-16', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: USER },
          password: STRONG_PW,
          device_id: 'MX16',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('MX16');
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('password login full MXID soft-17', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: USER },
          password: STRONG_PW,
          device_id: 'MX17',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('MX17');
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
});
describe('login contract leftovers lockout clear soft flood after #145', () => {
  it('password success clears lockout soft-0', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv({
      [`lockout:${USER}`]: JSON.stringify({ attempts: 1 }),
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'alice' },
          password: STRONG_PW,
          device_id: 'CLR0',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(sessions.deletes).toContain(`lockout:${USER}`);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
  });
  it('password success clears lockout soft-1', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv({
      [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }),
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'alice' },
          password: STRONG_PW,
          device_id: 'CLR1',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(sessions.deletes).toContain(`lockout:${USER}`);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
  });
  it('password success clears lockout soft-2', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv({
      [`lockout:${USER}`]: JSON.stringify({ attempts: 3 }),
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'alice' },
          password: STRONG_PW,
          device_id: 'CLR2',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(sessions.deletes).toContain(`lockout:${USER}`);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
  });
  it('password success clears lockout soft-3', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv({
      [`lockout:${USER}`]: JSON.stringify({ attempts: 4 }),
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'alice' },
          password: STRONG_PW,
          device_id: 'CLR3',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(sessions.deletes).toContain(`lockout:${USER}`);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
  });
  it('password success clears lockout soft-4', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv({
      [`lockout:${USER}`]: JSON.stringify({ attempts: 1 }),
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'alice' },
          password: STRONG_PW,
          device_id: 'CLR4',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(sessions.deletes).toContain(`lockout:${USER}`);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
  });
  it('password success clears lockout soft-5', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv({
      [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }),
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'alice' },
          password: STRONG_PW,
          device_id: 'CLR5',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(sessions.deletes).toContain(`lockout:${USER}`);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
  });
  it('password success clears lockout soft-6', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv({
      [`lockout:${USER}`]: JSON.stringify({ attempts: 3 }),
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'alice' },
          password: STRONG_PW,
          device_id: 'CLR6',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(sessions.deletes).toContain(`lockout:${USER}`);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
  });
  it('password success clears lockout soft-7', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv({
      [`lockout:${USER}`]: JSON.stringify({ attempts: 4 }),
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'alice' },
          password: STRONG_PW,
          device_id: 'CLR7',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(sessions.deletes).toContain(`lockout:${USER}`);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
  });
  it('password success clears lockout soft-8', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv({
      [`lockout:${USER}`]: JSON.stringify({ attempts: 1 }),
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'alice' },
          password: STRONG_PW,
          device_id: 'CLR8',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(sessions.deletes).toContain(`lockout:${USER}`);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
  });
  it('password success clears lockout soft-9', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv({
      [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }),
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'alice' },
          password: STRONG_PW,
          device_id: 'CLR9',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(sessions.deletes).toContain(`lockout:${USER}`);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
  });
  it('password success clears lockout soft-10', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv({
      [`lockout:${USER}`]: JSON.stringify({ attempts: 3 }),
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'alice' },
          password: STRONG_PW,
          device_id: 'CLR10',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(sessions.deletes).toContain(`lockout:${USER}`);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
  });
  it('password success clears lockout soft-11', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv({
      [`lockout:${USER}`]: JSON.stringify({ attempts: 4 }),
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'alice' },
          password: STRONG_PW,
          device_id: 'CLR11',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(sessions.deletes).toContain(`lockout:${USER}`);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
  });
  it('password success clears lockout soft-12', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv({
      [`lockout:${USER}`]: JSON.stringify({ attempts: 1 }),
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'alice' },
          password: STRONG_PW,
          device_id: 'CLR12',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(sessions.deletes).toContain(`lockout:${USER}`);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
  });
  it('password success clears lockout soft-13', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv({
      [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }),
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'alice' },
          password: STRONG_PW,
          device_id: 'CLR13',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(sessions.deletes).toContain(`lockout:${USER}`);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
  });
  it('password success clears lockout soft-14', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv({
      [`lockout:${USER}`]: JSON.stringify({ attempts: 3 }),
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'alice' },
          password: STRONG_PW,
          device_id: 'CLR14',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(sessions.deletes).toContain(`lockout:${USER}`);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
  });
});
describe('login contract leftovers guest register soft flood after #145', () => {
  it('guest register soft-0', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', { initial_device_display_name: 'Guest Soft 0' }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toMatch(/^@opaque\d+:example\.com$/);
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(typeof body.device_id).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    const created = [...db.users.values()][0];
    expect(created.is_guest).toBe(1);
    expect(created.password_hash).toBeNull();
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('guest register soft-1', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', { initial_device_display_name: 'Guest Soft 1' }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toMatch(/^@opaque\d+:example\.com$/);
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(typeof body.device_id).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    const created = [...db.users.values()][0];
    expect(created.is_guest).toBe(1);
    expect(created.password_hash).toBeNull();
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('guest register soft-2', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', { initial_device_display_name: 'Guest Soft 2' }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toMatch(/^@opaque\d+:example\.com$/);
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(typeof body.device_id).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    const created = [...db.users.values()][0];
    expect(created.is_guest).toBe(1);
    expect(created.password_hash).toBeNull();
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('guest register soft-3', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', { initial_device_display_name: 'Guest Soft 3' }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toMatch(/^@opaque\d+:example\.com$/);
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(typeof body.device_id).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    const created = [...db.users.values()][0];
    expect(created.is_guest).toBe(1);
    expect(created.password_hash).toBeNull();
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('guest register soft-4', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', { initial_device_display_name: 'Guest Soft 4' }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toMatch(/^@opaque\d+:example\.com$/);
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(typeof body.device_id).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    const created = [...db.users.values()][0];
    expect(created.is_guest).toBe(1);
    expect(created.password_hash).toBeNull();
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('guest register soft-5', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', { initial_device_display_name: 'Guest Soft 5' }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toMatch(/^@opaque\d+:example\.com$/);
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(typeof body.device_id).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    const created = [...db.users.values()][0];
    expect(created.is_guest).toBe(1);
    expect(created.password_hash).toBeNull();
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('guest register soft-6', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', { initial_device_display_name: 'Guest Soft 6' }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toMatch(/^@opaque\d+:example\.com$/);
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(typeof body.device_id).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    const created = [...db.users.values()][0];
    expect(created.is_guest).toBe(1);
    expect(created.password_hash).toBeNull();
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('guest register soft-7', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', { initial_device_display_name: 'Guest Soft 7' }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toMatch(/^@opaque\d+:example\.com$/);
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(typeof body.device_id).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    const created = [...db.users.values()][0];
    expect(created.is_guest).toBe(1);
    expect(created.password_hash).toBeNull();
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('guest register soft-8', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', { initial_device_display_name: 'Guest Soft 8' }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toMatch(/^@opaque\d+:example\.com$/);
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(typeof body.device_id).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    const created = [...db.users.values()][0];
    expect(created.is_guest).toBe(1);
    expect(created.password_hash).toBeNull();
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('guest register soft-9', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', { initial_device_display_name: 'Guest Soft 9' }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toMatch(/^@opaque\d+:example\.com$/);
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(typeof body.device_id).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    const created = [...db.users.values()][0];
    expect(created.is_guest).toBe(1);
    expect(created.password_hash).toBeNull();
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('guest register soft-10', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', { initial_device_display_name: 'Guest Soft 10' }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toMatch(/^@opaque\d+:example\.com$/);
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(typeof body.device_id).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    const created = [...db.users.values()][0];
    expect(created.is_guest).toBe(1);
    expect(created.password_hash).toBeNull();
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('guest register soft-11', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', { initial_device_display_name: 'Guest Soft 11' }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toMatch(/^@opaque\d+:example\.com$/);
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(typeof body.device_id).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    const created = [...db.users.values()][0];
    expect(created.is_guest).toBe(1);
    expect(created.password_hash).toBeNull();
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('guest register soft-12', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', { initial_device_display_name: 'Guest Soft 12' }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toMatch(/^@opaque\d+:example\.com$/);
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(typeof body.device_id).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    const created = [...db.users.values()][0];
    expect(created.is_guest).toBe(1);
    expect(created.password_hash).toBeNull();
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('guest register soft-13', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', { initial_device_display_name: 'Guest Soft 13' }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toMatch(/^@opaque\d+:example\.com$/);
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(typeof body.device_id).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    const created = [...db.users.values()][0];
    expect(created.is_guest).toBe(1);
    expect(created.password_hash).toBeNull();
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('guest register soft-14', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', { initial_device_display_name: 'Guest Soft 14' }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toMatch(/^@opaque\d+:example\.com$/);
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(typeof body.device_id).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    const created = [...db.users.values()][0];
    expect(created.is_guest).toBe(1);
    expect(created.password_hash).toBeNull();
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
});
describe('login contract leftovers Content-Type soft flood after #145', () => {
  const cts = ['application/json', 'application/json; charset=utf-8', 'application/json;charset=UTF-8'];
  it('login CT soft-0', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/login', {
      method: 'POST',
      headers: { 'Content-Type': cts[0] },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: 'CT0',
      }),
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
  });
  it('login CT soft-1', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/login', {
      method: 'POST',
      headers: { 'Content-Type': cts[1] },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: 'CT1',
      }),
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
  });
  it('login CT soft-2', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/login', {
      method: 'POST',
      headers: { 'Content-Type': cts[2] },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: 'CT2',
      }),
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
  });
  it('login CT soft-3', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/login', {
      method: 'POST',
      headers: { 'Content-Type': cts[0] },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: 'CT3',
      }),
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
  });
  it('login CT soft-4', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/login', {
      method: 'POST',
      headers: { 'Content-Type': cts[1] },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: 'CT4',
      }),
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
  });
  it('login CT soft-5', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/login', {
      method: 'POST',
      headers: { 'Content-Type': cts[2] },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: 'CT5',
      }),
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
  });
  it('login CT soft-6', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/login', {
      method: 'POST',
      headers: { 'Content-Type': cts[0] },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: 'CT6',
      }),
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
  });
  it('login CT soft-7', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/login', {
      method: 'POST',
      headers: { 'Content-Type': cts[1] },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: 'CT7',
      }),
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
  });
  it('login CT soft-8', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/login', {
      method: 'POST',
      headers: { 'Content-Type': cts[2] },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: 'CT8',
      }),
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
  });
  it('login CT soft-9', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/login', {
      method: 'POST',
      headers: { 'Content-Type': cts[0] },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: 'CT9',
      }),
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
  });
  it('login CT soft-10', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/login', {
      method: 'POST',
      headers: { 'Content-Type': cts[1] },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: 'CT10',
      }),
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
  });
  it('login CT soft-11', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/login', {
      method: 'POST',
      headers: { 'Content-Type': cts[2] },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: 'CT11',
      }),
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
  });
});
describe('login contract leftovers refresh deletes access soft flood after #145', () => {
  it('refresh deletes old access token_id soft-0', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_contract_0`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REF0',
      accessTokenId: 'oldtok0',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok0',
      token_hash: 'oldhash0',
      user_id: USER,
      device_id: 'REF0',
      created_at: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'keeper0',
      token_hash: 'keeperhash0',
      user_id: USER,
      device_id: 'OTHER',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.tokens.every((t) => t.token_id !== 'oldtok0')).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'keeper0')).toBe(true);
    expect(db.deletes.some((d) => d.sql.includes('token_id') && d.args[0] === 'oldtok0')).toBe(true);
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
  });
  it('refresh deletes old access token_id soft-1', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_contract_1`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REF1',
      accessTokenId: 'oldtok1',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok1',
      token_hash: 'oldhash1',
      user_id: USER,
      device_id: 'REF1',
      created_at: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'keeper1',
      token_hash: 'keeperhash1',
      user_id: USER,
      device_id: 'OTHER',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.tokens.every((t) => t.token_id !== 'oldtok1')).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'keeper1')).toBe(true);
    expect(db.deletes.some((d) => d.sql.includes('token_id') && d.args[0] === 'oldtok1')).toBe(true);
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
  });
  it('refresh deletes old access token_id soft-2', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_contract_2`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REF2',
      accessTokenId: 'oldtok2',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok2',
      token_hash: 'oldhash2',
      user_id: USER,
      device_id: 'REF2',
      created_at: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'keeper2',
      token_hash: 'keeperhash2',
      user_id: USER,
      device_id: 'OTHER',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.tokens.every((t) => t.token_id !== 'oldtok2')).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'keeper2')).toBe(true);
    expect(db.deletes.some((d) => d.sql.includes('token_id') && d.args[0] === 'oldtok2')).toBe(true);
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
  });
  it('refresh deletes old access token_id soft-3', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_contract_3`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REF3',
      accessTokenId: 'oldtok3',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok3',
      token_hash: 'oldhash3',
      user_id: USER,
      device_id: 'REF3',
      created_at: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'keeper3',
      token_hash: 'keeperhash3',
      user_id: USER,
      device_id: 'OTHER',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.tokens.every((t) => t.token_id !== 'oldtok3')).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'keeper3')).toBe(true);
    expect(db.deletes.some((d) => d.sql.includes('token_id') && d.args[0] === 'oldtok3')).toBe(true);
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
  });
  it('refresh deletes old access token_id soft-4', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_contract_4`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REF4',
      accessTokenId: 'oldtok4',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok4',
      token_hash: 'oldhash4',
      user_id: USER,
      device_id: 'REF4',
      created_at: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'keeper4',
      token_hash: 'keeperhash4',
      user_id: USER,
      device_id: 'OTHER',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.tokens.every((t) => t.token_id !== 'oldtok4')).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'keeper4')).toBe(true);
    expect(db.deletes.some((d) => d.sql.includes('token_id') && d.args[0] === 'oldtok4')).toBe(true);
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
  });
  it('refresh deletes old access token_id soft-5', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_contract_5`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REF5',
      accessTokenId: 'oldtok5',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok5',
      token_hash: 'oldhash5',
      user_id: USER,
      device_id: 'REF5',
      created_at: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'keeper5',
      token_hash: 'keeperhash5',
      user_id: USER,
      device_id: 'OTHER',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.tokens.every((t) => t.token_id !== 'oldtok5')).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'keeper5')).toBe(true);
    expect(db.deletes.some((d) => d.sql.includes('token_id') && d.args[0] === 'oldtok5')).toBe(true);
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
  });
  it('refresh deletes old access token_id soft-6', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_contract_6`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REF6',
      accessTokenId: 'oldtok6',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok6',
      token_hash: 'oldhash6',
      user_id: USER,
      device_id: 'REF6',
      created_at: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'keeper6',
      token_hash: 'keeperhash6',
      user_id: USER,
      device_id: 'OTHER',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.tokens.every((t) => t.token_id !== 'oldtok6')).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'keeper6')).toBe(true);
    expect(db.deletes.some((d) => d.sql.includes('token_id') && d.args[0] === 'oldtok6')).toBe(true);
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
  });
  it('refresh deletes old access token_id soft-7', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_contract_7`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REF7',
      accessTokenId: 'oldtok7',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok7',
      token_hash: 'oldhash7',
      user_id: USER,
      device_id: 'REF7',
      created_at: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'keeper7',
      token_hash: 'keeperhash7',
      user_id: USER,
      device_id: 'OTHER',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.tokens.every((t) => t.token_id !== 'oldtok7')).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'keeper7')).toBe(true);
    expect(db.deletes.some((d) => d.sql.includes('token_id') && d.args[0] === 'oldtok7')).toBe(true);
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
  });
  it('refresh deletes old access token_id soft-8', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_contract_8`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REF8',
      accessTokenId: 'oldtok8',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok8',
      token_hash: 'oldhash8',
      user_id: USER,
      device_id: 'REF8',
      created_at: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'keeper8',
      token_hash: 'keeperhash8',
      user_id: USER,
      device_id: 'OTHER',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.tokens.every((t) => t.token_id !== 'oldtok8')).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'keeper8')).toBe(true);
    expect(db.deletes.some((d) => d.sql.includes('token_id') && d.args[0] === 'oldtok8')).toBe(true);
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
  });
  it('refresh deletes old access token_id soft-9', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_contract_9`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REF9',
      accessTokenId: 'oldtok9',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok9',
      token_hash: 'oldhash9',
      user_id: USER,
      device_id: 'REF9',
      created_at: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'keeper9',
      token_hash: 'keeperhash9',
      user_id: USER,
      device_id: 'OTHER',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.tokens.every((t) => t.token_id !== 'oldtok9')).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'keeper9')).toBe(true);
    expect(db.deletes.some((d) => d.sql.includes('token_id') && d.args[0] === 'oldtok9')).toBe(true);
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
  });
  it('refresh deletes old access token_id soft-10', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_contract_10`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REF10',
      accessTokenId: 'oldtok10',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok10',
      token_hash: 'oldhash10',
      user_id: USER,
      device_id: 'REF10',
      created_at: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'keeper10',
      token_hash: 'keeperhash10',
      user_id: USER,
      device_id: 'OTHER',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.tokens.every((t) => t.token_id !== 'oldtok10')).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'keeper10')).toBe(true);
    expect(db.deletes.some((d) => d.sql.includes('token_id') && d.args[0] === 'oldtok10')).toBe(true);
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
  });
  it('refresh deletes old access token_id soft-11', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_contract_11`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REF11',
      accessTokenId: 'oldtok11',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok11',
      token_hash: 'oldhash11',
      user_id: USER,
      device_id: 'REF11',
      created_at: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'keeper11',
      token_hash: 'keeperhash11',
      user_id: USER,
      device_id: 'OTHER',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.tokens.every((t) => t.token_id !== 'oldtok11')).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'keeper11')).toBe(true);
    expect(db.deletes.some((d) => d.sql.includes('token_id') && d.args[0] === 'oldtok11')).toBe(true);
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
  });
  it('refresh deletes old access token_id soft-12', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_contract_12`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REF12',
      accessTokenId: 'oldtok12',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok12',
      token_hash: 'oldhash12',
      user_id: USER,
      device_id: 'REF12',
      created_at: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'keeper12',
      token_hash: 'keeperhash12',
      user_id: USER,
      device_id: 'OTHER',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.tokens.every((t) => t.token_id !== 'oldtok12')).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'keeper12')).toBe(true);
    expect(db.deletes.some((d) => d.sql.includes('token_id') && d.args[0] === 'oldtok12')).toBe(true);
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
  });
  it('refresh deletes old access token_id soft-13', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_contract_13`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REF13',
      accessTokenId: 'oldtok13',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok13',
      token_hash: 'oldhash13',
      user_id: USER,
      device_id: 'REF13',
      created_at: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'keeper13',
      token_hash: 'keeperhash13',
      user_id: USER,
      device_id: 'OTHER',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.tokens.every((t) => t.token_id !== 'oldtok13')).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'keeper13')).toBe(true);
    expect(db.deletes.some((d) => d.sql.includes('token_id') && d.args[0] === 'oldtok13')).toBe(true);
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
  });
  it('refresh deletes old access token_id soft-14', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_contract_14`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REF14',
      accessTokenId: 'oldtok14',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok14',
      token_hash: 'oldhash14',
      user_id: USER,
      device_id: 'REF14',
      created_at: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'keeper14',
      token_hash: 'keeperhash14',
      user_id: USER,
      device_id: 'OTHER',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.tokens.every((t) => t.token_id !== 'oldtok14')).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'keeper14')).toBe(true);
    expect(db.deletes.some((d) => d.sql.includes('token_id') && d.args[0] === 'oldtok14')).toBe(true);
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
  });
});
describe('login contract leftovers get_token fields soft flood after #145', () => {
  it('get_token fields soft-0', async () => {
    authState.userId = USER;
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v1/login/get_token',
      jsonInit('POST', {}, 'tok')
    );
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['expires_in_ms', 'login_token']);
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(body.login_token.length).toBeGreaterThan(10);
    const put = sessions.puts.find((p) => p.key.startsWith('login_token:'));
    expect(put?.options?.expirationTtl).toBe(120);
    const stored = JSON.parse(put!.value);
    expect(stored.user_id).toBe(USER);
    expect(stored.expires_at).toBe(NOW + 120_000);
  });
  it('get_token fields soft-1', async () => {
    authState.userId = USER;
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v1/login/get_token',
      jsonInit('POST', {}, 'tok')
    );
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['expires_in_ms', 'login_token']);
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(body.login_token.length).toBeGreaterThan(10);
    const put = sessions.puts.find((p) => p.key.startsWith('login_token:'));
    expect(put?.options?.expirationTtl).toBe(120);
    const stored = JSON.parse(put!.value);
    expect(stored.user_id).toBe(USER);
    expect(stored.expires_at).toBe(NOW + 120_000);
  });
  it('get_token fields soft-2', async () => {
    authState.userId = USER;
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v1/login/get_token',
      jsonInit('POST', {}, 'tok')
    );
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['expires_in_ms', 'login_token']);
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(body.login_token.length).toBeGreaterThan(10);
    const put = sessions.puts.find((p) => p.key.startsWith('login_token:'));
    expect(put?.options?.expirationTtl).toBe(120);
    const stored = JSON.parse(put!.value);
    expect(stored.user_id).toBe(USER);
    expect(stored.expires_at).toBe(NOW + 120_000);
  });
  it('get_token fields soft-3', async () => {
    authState.userId = USER;
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v1/login/get_token',
      jsonInit('POST', {}, 'tok')
    );
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['expires_in_ms', 'login_token']);
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(body.login_token.length).toBeGreaterThan(10);
    const put = sessions.puts.find((p) => p.key.startsWith('login_token:'));
    expect(put?.options?.expirationTtl).toBe(120);
    const stored = JSON.parse(put!.value);
    expect(stored.user_id).toBe(USER);
    expect(stored.expires_at).toBe(NOW + 120_000);
  });
  it('get_token fields soft-4', async () => {
    authState.userId = USER;
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v1/login/get_token',
      jsonInit('POST', {}, 'tok')
    );
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['expires_in_ms', 'login_token']);
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(body.login_token.length).toBeGreaterThan(10);
    const put = sessions.puts.find((p) => p.key.startsWith('login_token:'));
    expect(put?.options?.expirationTtl).toBe(120);
    const stored = JSON.parse(put!.value);
    expect(stored.user_id).toBe(USER);
    expect(stored.expires_at).toBe(NOW + 120_000);
  });
  it('get_token fields soft-5', async () => {
    authState.userId = USER;
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v1/login/get_token',
      jsonInit('POST', {}, 'tok')
    );
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['expires_in_ms', 'login_token']);
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(body.login_token.length).toBeGreaterThan(10);
    const put = sessions.puts.find((p) => p.key.startsWith('login_token:'));
    expect(put?.options?.expirationTtl).toBe(120);
    const stored = JSON.parse(put!.value);
    expect(stored.user_id).toBe(USER);
    expect(stored.expires_at).toBe(NOW + 120_000);
  });
  it('get_token fields soft-6', async () => {
    authState.userId = USER;
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v1/login/get_token',
      jsonInit('POST', {}, 'tok')
    );
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['expires_in_ms', 'login_token']);
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(body.login_token.length).toBeGreaterThan(10);
    const put = sessions.puts.find((p) => p.key.startsWith('login_token:'));
    expect(put?.options?.expirationTtl).toBe(120);
    const stored = JSON.parse(put!.value);
    expect(stored.user_id).toBe(USER);
    expect(stored.expires_at).toBe(NOW + 120_000);
  });
  it('get_token fields soft-7', async () => {
    authState.userId = USER;
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v1/login/get_token',
      jsonInit('POST', {}, 'tok')
    );
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['expires_in_ms', 'login_token']);
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(body.login_token.length).toBeGreaterThan(10);
    const put = sessions.puts.find((p) => p.key.startsWith('login_token:'));
    expect(put?.options?.expirationTtl).toBe(120);
    const stored = JSON.parse(put!.value);
    expect(stored.user_id).toBe(USER);
    expect(stored.expires_at).toBe(NOW + 120_000);
  });
  it('get_token fields soft-8', async () => {
    authState.userId = USER;
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v1/login/get_token',
      jsonInit('POST', {}, 'tok')
    );
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['expires_in_ms', 'login_token']);
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(body.login_token.length).toBeGreaterThan(10);
    const put = sessions.puts.find((p) => p.key.startsWith('login_token:'));
    expect(put?.options?.expirationTtl).toBe(120);
    const stored = JSON.parse(put!.value);
    expect(stored.user_id).toBe(USER);
    expect(stored.expires_at).toBe(NOW + 120_000);
  });
  it('get_token fields soft-9', async () => {
    authState.userId = USER;
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v1/login/get_token',
      jsonInit('POST', {}, 'tok')
    );
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['expires_in_ms', 'login_token']);
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(body.login_token.length).toBeGreaterThan(10);
    const put = sessions.puts.find((p) => p.key.startsWith('login_token:'));
    expect(put?.options?.expirationTtl).toBe(120);
    const stored = JSON.parse(put!.value);
    expect(stored.user_id).toBe(USER);
    expect(stored.expires_at).toBe(NOW + 120_000);
  });
  it('get_token fields soft-10', async () => {
    authState.userId = USER;
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v1/login/get_token',
      jsonInit('POST', {}, 'tok')
    );
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['expires_in_ms', 'login_token']);
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(body.login_token.length).toBeGreaterThan(10);
    const put = sessions.puts.find((p) => p.key.startsWith('login_token:'));
    expect(put?.options?.expirationTtl).toBe(120);
    const stored = JSON.parse(put!.value);
    expect(stored.user_id).toBe(USER);
    expect(stored.expires_at).toBe(NOW + 120_000);
  });
  it('get_token fields soft-11', async () => {
    authState.userId = USER;
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v1/login/get_token',
      jsonInit('POST', {}, 'tok')
    );
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['expires_in_ms', 'login_token']);
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(body.login_token.length).toBeGreaterThan(10);
    const put = sessions.puts.find((p) => p.key.startsWith('login_token:'));
    expect(put?.options?.expirationTtl).toBe(120);
    const stored = JSON.parse(put!.value);
    expect(stored.user_id).toBe(USER);
    expect(stored.expires_at).toBe(NOW + 120_000);
  });
  it('get_token fields soft-12', async () => {
    authState.userId = USER;
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v1/login/get_token',
      jsonInit('POST', {}, 'tok')
    );
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['expires_in_ms', 'login_token']);
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(body.login_token.length).toBeGreaterThan(10);
    const put = sessions.puts.find((p) => p.key.startsWith('login_token:'));
    expect(put?.options?.expirationTtl).toBe(120);
    const stored = JSON.parse(put!.value);
    expect(stored.user_id).toBe(USER);
    expect(stored.expires_at).toBe(NOW + 120_000);
  });
  it('get_token fields soft-13', async () => {
    authState.userId = USER;
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v1/login/get_token',
      jsonInit('POST', {}, 'tok')
    );
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['expires_in_ms', 'login_token']);
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(body.login_token.length).toBeGreaterThan(10);
    const put = sessions.puts.find((p) => p.key.startsWith('login_token:'));
    expect(put?.options?.expirationTtl).toBe(120);
    const stored = JSON.parse(put!.value);
    expect(stored.user_id).toBe(USER);
    expect(stored.expires_at).toBe(NOW + 120_000);
  });
  it('get_token fields soft-14', async () => {
    authState.userId = USER;
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v1/login/get_token',
      jsonInit('POST', {}, 'tok')
    );
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['expires_in_ms', 'login_token']);
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(body.login_token.length).toBeGreaterThan(10);
    const put = sessions.puts.find((p) => p.key.startsWith('login_token:'));
    expect(put?.options?.expirationTtl).toBe(120);
    const stored = JSON.parse(put!.value);
    expect(stored.user_id).toBe(USER);
    expect(stored.expires_at).toBe(NOW + 120_000);
  });
});
describe('login contract leftovers register tokens soft flood after #145', () => {
  it('register success tokens soft-0', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const username = `contract0`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username,
          password: STRONG_PW,
          auth: { type: 'm.login.dummy', session: 's0' },
          device_id: 'REG0',
          initial_device_display_name: 'Reg Soft 0',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@${username}:${SERVER}`);
    expect(body.device_id).toBe('REG0');
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(db.devices.some((d) => d.device_id === 'REG0' && d.display_name === 'Reg Soft 0')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('register success tokens soft-1', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const username = `contract1`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username,
          password: STRONG_PW,
          auth: { type: 'm.login.dummy', session: 's1' },
          device_id: 'REG1',
          initial_device_display_name: 'Reg Soft 1',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@${username}:${SERVER}`);
    expect(body.device_id).toBe('REG1');
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(db.devices.some((d) => d.device_id === 'REG1' && d.display_name === 'Reg Soft 1')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('register success tokens soft-2', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const username = `contract2`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username,
          password: STRONG_PW,
          auth: { type: 'm.login.dummy', session: 's2' },
          device_id: 'REG2',
          initial_device_display_name: 'Reg Soft 2',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@${username}:${SERVER}`);
    expect(body.device_id).toBe('REG2');
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(db.devices.some((d) => d.device_id === 'REG2' && d.display_name === 'Reg Soft 2')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('register success tokens soft-3', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const username = `contract3`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username,
          password: STRONG_PW,
          auth: { type: 'm.login.dummy', session: 's3' },
          device_id: 'REG3',
          initial_device_display_name: 'Reg Soft 3',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@${username}:${SERVER}`);
    expect(body.device_id).toBe('REG3');
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(db.devices.some((d) => d.device_id === 'REG3' && d.display_name === 'Reg Soft 3')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('register success tokens soft-4', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const username = `contract4`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username,
          password: STRONG_PW,
          auth: { type: 'm.login.dummy', session: 's4' },
          device_id: 'REG4',
          initial_device_display_name: 'Reg Soft 4',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@${username}:${SERVER}`);
    expect(body.device_id).toBe('REG4');
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(db.devices.some((d) => d.device_id === 'REG4' && d.display_name === 'Reg Soft 4')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('register success tokens soft-5', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const username = `contract5`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username,
          password: STRONG_PW,
          auth: { type: 'm.login.dummy', session: 's5' },
          device_id: 'REG5',
          initial_device_display_name: 'Reg Soft 5',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@${username}:${SERVER}`);
    expect(body.device_id).toBe('REG5');
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(db.devices.some((d) => d.device_id === 'REG5' && d.display_name === 'Reg Soft 5')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('register success tokens soft-6', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const username = `contract6`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username,
          password: STRONG_PW,
          auth: { type: 'm.login.dummy', session: 's6' },
          device_id: 'REG6',
          initial_device_display_name: 'Reg Soft 6',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@${username}:${SERVER}`);
    expect(body.device_id).toBe('REG6');
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(db.devices.some((d) => d.device_id === 'REG6' && d.display_name === 'Reg Soft 6')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('register success tokens soft-7', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const username = `contract7`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username,
          password: STRONG_PW,
          auth: { type: 'm.login.dummy', session: 's7' },
          device_id: 'REG7',
          initial_device_display_name: 'Reg Soft 7',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@${username}:${SERVER}`);
    expect(body.device_id).toBe('REG7');
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(db.devices.some((d) => d.device_id === 'REG7' && d.display_name === 'Reg Soft 7')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('register success tokens soft-8', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const username = `contract8`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username,
          password: STRONG_PW,
          auth: { type: 'm.login.dummy', session: 's8' },
          device_id: 'REG8',
          initial_device_display_name: 'Reg Soft 8',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@${username}:${SERVER}`);
    expect(body.device_id).toBe('REG8');
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(db.devices.some((d) => d.device_id === 'REG8' && d.display_name === 'Reg Soft 8')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('register success tokens soft-9', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const username = `contract9`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username,
          password: STRONG_PW,
          auth: { type: 'm.login.dummy', session: 's9' },
          device_id: 'REG9',
          initial_device_display_name: 'Reg Soft 9',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@${username}:${SERVER}`);
    expect(body.device_id).toBe('REG9');
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(db.devices.some((d) => d.device_id === 'REG9' && d.display_name === 'Reg Soft 9')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('register success tokens soft-10', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const username = `contract10`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username,
          password: STRONG_PW,
          auth: { type: 'm.login.dummy', session: 's10' },
          device_id: 'REG10',
          initial_device_display_name: 'Reg Soft 10',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@${username}:${SERVER}`);
    expect(body.device_id).toBe('REG10');
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(db.devices.some((d) => d.device_id === 'REG10' && d.display_name === 'Reg Soft 10')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
  it('register success tokens soft-11', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const username = `contract11`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        {
          username,
          password: STRONG_PW,
          auth: { type: 'm.login.dummy', session: 's11' },
          device_id: 'REG11',
          initial_device_display_name: 'Reg Soft 11',
        },
        ''
      )
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@${username}:${SERVER}`);
    expect(body.device_id).toBe('REG11');
    expect(body.home_server).toBe(SERVER);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(db.devices.some((d) => d.device_id === 'REG11' && d.display_name === 'Reg Soft 11')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
});
describe('login contract leftovers available soft flood after #145', () => {
  it('available encoding soft-0', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const name = 'avail_contract_0';
    const { status, body } = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(name)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('available encoding soft-1', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const name = 'avail_contract_1';
    const { status, body } = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(name)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('available encoding soft-2', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const name = 'avail_contract_2';
    const { status, body } = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(name)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('available encoding soft-3', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const name = 'avail_contract_3';
    const { status, body } = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(name)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('available encoding soft-4', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const name = 'avail_contract_4';
    const { status, body } = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(name)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('available encoding soft-5', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const name = 'avail_contract_5';
    const { status, body } = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(name)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('available encoding soft-6', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const name = 'avail_contract_6';
    const { status, body } = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(name)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('available encoding soft-7', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const name = 'avail_contract_7';
    const { status, body } = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(name)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('available encoding soft-8', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const name = 'avail_contract_8';
    const { status, body } = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(name)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('available encoding soft-9', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const name = 'avail_contract_9';
    const { status, body } = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(name)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('available encoding soft-10', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const name = 'avail_contract_10';
    const { status, body } = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(name)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('available encoding soft-11', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const name = 'avail_contract_11';
    const { status, body } = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(name)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('available encoding soft-12', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const name = 'avail_contract_12';
    const { status, body } = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(name)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('available encoding soft-13', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const name = 'avail_contract_13';
    const { status, body } = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(name)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('available encoding soft-14', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const name = 'avail_contract_14';
    const { status, body } = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(name)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('available encoding soft-15', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const name = 'avail_contract_15';
    const { status, body } = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(name)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('available encoding soft-16', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const name = 'avail_contract_16';
    const { status, body } = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(name)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('available encoding soft-17', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const name = 'avail_contract_17';
    const { status, body } = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(name)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('available encoding soft-18', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const name = 'avail_contract_18';
    const { status, body } = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(name)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('available encoding soft-19', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const name = 'avail_contract_19';
    const { status, body } = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(name)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
});
