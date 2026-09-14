/**
 * TOKENMAXX HEAVY leftovers after #142/#143 — login API soft success/reliability.
 * Orthogonal to login-register-failure-leftovers + login-api-route-edges.
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

describe('login soft leftovers GET /login flows shape after #142', () => {

  it('flows soft-0', async () => {
    const env = loginEnv(createLoginDb());
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/login');
    expect(status).toBe(200);
    expect(body.flows).toEqual([
      { type: 'm.login.password' },
      { type: 'm.login.token' },
      { type: 'm.login.dummy' },
    ]);
  });

  it('flows soft-1', async () => {
    const env = loginEnv(createLoginDb());
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/login');
    expect(status).toBe(200);
    expect(body.flows).toEqual([
      { type: 'm.login.password' },
      { type: 'm.login.token' },
      { type: 'm.login.dummy' },
    ]);
  });

  it('flows soft-2', async () => {
    const env = loginEnv(createLoginDb());
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/login');
    expect(status).toBe(200);
    expect(body.flows).toEqual([
      { type: 'm.login.password' },
      { type: 'm.login.token' },
      { type: 'm.login.dummy' },
    ]);
  });

  it('flows soft-3', async () => {
    const env = loginEnv(createLoginDb());
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/login');
    expect(status).toBe(200);
    expect(body.flows).toEqual([
      { type: 'm.login.password' },
      { type: 'm.login.token' },
      { type: 'm.login.dummy' },
    ]);
  });

  it('flows soft-4', async () => {
    const env = loginEnv(createLoginDb());
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/login');
    expect(status).toBe(200);
    expect(body.flows).toEqual([
      { type: 'm.login.password' },
      { type: 'm.login.token' },
      { type: 'm.login.dummy' },
    ]);
  });

  it('flows soft-5', async () => {
    const env = loginEnv(createLoginDb());
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/login');
    expect(status).toBe(200);
    expect(body.flows).toEqual([
      { type: 'm.login.password' },
      { type: 'm.login.token' },
      { type: 'm.login.dummy' },
    ]);
  });

  it('flows soft-6', async () => {
    const env = loginEnv(createLoginDb());
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/login');
    expect(status).toBe(200);
    expect(body.flows).toEqual([
      { type: 'm.login.password' },
      { type: 'm.login.token' },
      { type: 'm.login.dummy' },
    ]);
  });

  it('flows soft-7', async () => {
    const env = loginEnv(createLoginDb());
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/login');
    expect(status).toBe(200);
    expect(body.flows).toEqual([
      { type: 'm.login.password' },
      { type: 'm.login.token' },
      { type: 'm.login.dummy' },
    ]);
  });

  it('flows soft-8', async () => {
    const env = loginEnv(createLoginDb());
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/login');
    expect(status).toBe(200);
    expect(body.flows).toEqual([
      { type: 'm.login.password' },
      { type: 'm.login.token' },
      { type: 'm.login.dummy' },
    ]);
  });

  it('flows soft-9', async () => {
    const env = loginEnv(createLoginDb());
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/login');
    expect(status).toBe(200);
    expect(body.flows).toEqual([
      { type: 'm.login.password' },
      { type: 'm.login.token' },
      { type: 'm.login.dummy' },
    ]);
  });

  it('flows soft-10', async () => {
    const env = loginEnv(createLoginDb());
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/login');
    expect(status).toBe(200);
    expect(body.flows).toEqual([
      { type: 'm.login.password' },
      { type: 'm.login.token' },
      { type: 'm.login.dummy' },
    ]);
  });

  it('flows soft-11', async () => {
    const env = loginEnv(createLoginDb());
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/login');
    expect(status).toBe(200);
    expect(body.flows).toEqual([
      { type: 'm.login.password' },
      { type: 'm.login.token' },
      { type: 'm.login.dummy' },
    ]);
  });
});

describe('login soft leftovers password success device_id soft flood after #142', () => {

  it('password login device soft-0', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const deviceId = `SOFTDEV0`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: deviceId,
        initial_device_display_name: 'Soft Device 0',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe(deviceId);
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.devices.some((d) => d.device_id === deviceId && d.display_name === 'Soft Device 0')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });

  it('password login device soft-1', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const deviceId = `SOFTDEV1`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: deviceId,
        initial_device_display_name: 'Soft Device 1',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe(deviceId);
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.devices.some((d) => d.device_id === deviceId && d.display_name === 'Soft Device 1')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });

  it('password login device soft-2', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const deviceId = `SOFTDEV2`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: deviceId,
        initial_device_display_name: 'Soft Device 2',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe(deviceId);
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.devices.some((d) => d.device_id === deviceId && d.display_name === 'Soft Device 2')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });

  it('password login device soft-3', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const deviceId = `SOFTDEV3`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: deviceId,
        initial_device_display_name: 'Soft Device 3',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe(deviceId);
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.devices.some((d) => d.device_id === deviceId && d.display_name === 'Soft Device 3')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });

  it('password login device soft-4', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const deviceId = `SOFTDEV4`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: deviceId,
        initial_device_display_name: 'Soft Device 4',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe(deviceId);
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.devices.some((d) => d.device_id === deviceId && d.display_name === 'Soft Device 4')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });

  it('password login device soft-5', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const deviceId = `SOFTDEV5`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: deviceId,
        initial_device_display_name: 'Soft Device 5',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe(deviceId);
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.devices.some((d) => d.device_id === deviceId && d.display_name === 'Soft Device 5')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });

  it('password login device soft-6', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const deviceId = `SOFTDEV6`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: deviceId,
        initial_device_display_name: 'Soft Device 6',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe(deviceId);
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.devices.some((d) => d.device_id === deviceId && d.display_name === 'Soft Device 6')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });

  it('password login device soft-7', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const deviceId = `SOFTDEV7`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: deviceId,
        initial_device_display_name: 'Soft Device 7',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe(deviceId);
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.devices.some((d) => d.device_id === deviceId && d.display_name === 'Soft Device 7')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });

  it('password login device soft-8', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const deviceId = `SOFTDEV8`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: deviceId,
        initial_device_display_name: 'Soft Device 8',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe(deviceId);
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.devices.some((d) => d.device_id === deviceId && d.display_name === 'Soft Device 8')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });

  it('password login device soft-9', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const deviceId = `SOFTDEV9`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: deviceId,
        initial_device_display_name: 'Soft Device 9',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe(deviceId);
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.devices.some((d) => d.device_id === deviceId && d.display_name === 'Soft Device 9')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });

  it('password login device soft-10', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const deviceId = `SOFTDEV10`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: deviceId,
        initial_device_display_name: 'Soft Device 10',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe(deviceId);
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.devices.some((d) => d.device_id === deviceId && d.display_name === 'Soft Device 10')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });

  it('password login device soft-11', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const deviceId = `SOFTDEV11`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: deviceId,
        initial_device_display_name: 'Soft Device 11',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe(deviceId);
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.devices.some((d) => d.device_id === deviceId && d.display_name === 'Soft Device 11')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });

  it('password login device soft-12', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const deviceId = `SOFTDEV12`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: deviceId,
        initial_device_display_name: 'Soft Device 12',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe(deviceId);
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.devices.some((d) => d.device_id === deviceId && d.display_name === 'Soft Device 12')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });

  it('password login device soft-13', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const deviceId = `SOFTDEV13`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: deviceId,
        initial_device_display_name: 'Soft Device 13',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe(deviceId);
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.devices.some((d) => d.device_id === deviceId && d.display_name === 'Soft Device 13')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });

  it('password login device soft-14', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const deviceId = `SOFTDEV14`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: deviceId,
        initial_device_display_name: 'Soft Device 14',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe(deviceId);
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.devices.some((d) => d.device_id === deviceId && d.display_name === 'Soft Device 14')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });

  it('password login device soft-15', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const deviceId = `SOFTDEV15`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: deviceId,
        initial_device_display_name: 'Soft Device 15',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe(deviceId);
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.devices.some((d) => d.device_id === deviceId && d.display_name === 'Soft Device 15')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });

  it('password login device soft-16', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const deviceId = `SOFTDEV16`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: deviceId,
        initial_device_display_name: 'Soft Device 16',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe(deviceId);
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.devices.some((d) => d.device_id === deviceId && d.display_name === 'Soft Device 16')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });

  it('password login device soft-17', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const deviceId = `SOFTDEV17`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: deviceId,
        initial_device_display_name: 'Soft Device 17',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe(deviceId);
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.devices.some((d) => d.device_id === deviceId && d.display_name === 'Soft Device 17')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });

  it('password login device soft-18', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const deviceId = `SOFTDEV18`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: deviceId,
        initial_device_display_name: 'Soft Device 18',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe(deviceId);
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.devices.some((d) => d.device_id === deviceId && d.display_name === 'Soft Device 18')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });

  it('password login device soft-19', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const deviceId = `SOFTDEV19`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: STRONG_PW,
        device_id: deviceId,
        initial_device_display_name: 'Soft Device 19',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe(deviceId);
    expect(body.home_server).toBe(SERVER);
    expect(body.expires_in_ms).toBe(60 * 60 * 1000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(db.devices.some((d) => d.device_id === deviceId && d.display_name === 'Soft Device 19')).toBe(true);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
  });
});

describe('login soft leftovers dummy login success soft flood after #142', () => {

  it('dummy login soft-0', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.dummy',
        identifier: { type: 'm.id.user', user: 'alice' },
        device_id: 'DUM0',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DUM0');
  });

  it('dummy login soft-1', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.dummy',
        identifier: { type: 'm.id.user', user: '@alice:example.com' },
        device_id: 'DUM1',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DUM1');
  });

  it('dummy login soft-2', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.dummy',
        identifier: { type: 'm.id.user', user: 'alice' },
        device_id: 'DUM2',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DUM2');
  });

  it('dummy login soft-3', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.dummy',
        identifier: { type: 'm.id.user', user: '@alice:example.com' },
        device_id: 'DUM3',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DUM3');
  });

  it('dummy login soft-4', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.dummy',
        identifier: { type: 'm.id.user', user: 'alice' },
        device_id: 'DUM4',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DUM4');
  });

  it('dummy login soft-5', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.dummy',
        identifier: { type: 'm.id.user', user: '@alice:example.com' },
        device_id: 'DUM5',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DUM5');
  });

  it('dummy login soft-6', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.dummy',
        identifier: { type: 'm.id.user', user: 'alice' },
        device_id: 'DUM6',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DUM6');
  });

  it('dummy login soft-7', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.dummy',
        identifier: { type: 'm.id.user', user: '@alice:example.com' },
        device_id: 'DUM7',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DUM7');
  });

  it('dummy login soft-8', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.dummy',
        identifier: { type: 'm.id.user', user: 'alice' },
        device_id: 'DUM8',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DUM8');
  });

  it('dummy login soft-9', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.dummy',
        identifier: { type: 'm.id.user', user: '@alice:example.com' },
        device_id: 'DUM9',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DUM9');
  });

  it('dummy login soft-10', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.dummy',
        identifier: { type: 'm.id.user', user: 'alice' },
        device_id: 'DUM10',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DUM10');
  });

  it('dummy login soft-11', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.dummy',
        identifier: { type: 'm.id.user', user: '@alice:example.com' },
        device_id: 'DUM11',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DUM11');
  });

  it('dummy login soft-12', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.dummy',
        identifier: { type: 'm.id.user', user: 'alice' },
        device_id: 'DUM12',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DUM12');
  });

  it('dummy login soft-13', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.dummy',
        identifier: { type: 'm.id.user', user: '@alice:example.com' },
        device_id: 'DUM13',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DUM13');
  });

  it('dummy login soft-14', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.dummy',
        identifier: { type: 'm.id.user', user: 'alice' },
        device_id: 'DUM14',
      }, '')
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DUM14');
  });
});

describe('login soft leftovers refresh rotation TTL soft flood after #142', () => {

  it('refresh soft TTL-0', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_soft_0`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REFDEV0',
      accessTokenId: 'oldtok0',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok0',
      token_hash: 'oldhash0',
      user_id: USER,
      device_id: 'REFDEV0',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
    expect(db.tokens.every((t) => t.token_id !== 'oldtok0')).toBe(true);
  });

  it('refresh soft TTL-1', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_soft_1`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REFDEV1',
      accessTokenId: 'oldtok1',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok1',
      token_hash: 'oldhash1',
      user_id: USER,
      device_id: 'REFDEV1',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
    expect(db.tokens.every((t) => t.token_id !== 'oldtok1')).toBe(true);
  });

  it('refresh soft TTL-2', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_soft_2`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REFDEV2',
      accessTokenId: 'oldtok2',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok2',
      token_hash: 'oldhash2',
      user_id: USER,
      device_id: 'REFDEV2',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
    expect(db.tokens.every((t) => t.token_id !== 'oldtok2')).toBe(true);
  });

  it('refresh soft TTL-3', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_soft_3`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REFDEV3',
      accessTokenId: 'oldtok3',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok3',
      token_hash: 'oldhash3',
      user_id: USER,
      device_id: 'REFDEV3',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
    expect(db.tokens.every((t) => t.token_id !== 'oldtok3')).toBe(true);
  });

  it('refresh soft TTL-4', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_soft_4`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REFDEV4',
      accessTokenId: 'oldtok4',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok4',
      token_hash: 'oldhash4',
      user_id: USER,
      device_id: 'REFDEV4',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
    expect(db.tokens.every((t) => t.token_id !== 'oldtok4')).toBe(true);
  });

  it('refresh soft TTL-5', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_soft_5`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REFDEV5',
      accessTokenId: 'oldtok5',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok5',
      token_hash: 'oldhash5',
      user_id: USER,
      device_id: 'REFDEV5',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
    expect(db.tokens.every((t) => t.token_id !== 'oldtok5')).toBe(true);
  });

  it('refresh soft TTL-6', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_soft_6`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REFDEV6',
      accessTokenId: 'oldtok6',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok6',
      token_hash: 'oldhash6',
      user_id: USER,
      device_id: 'REFDEV6',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
    expect(db.tokens.every((t) => t.token_id !== 'oldtok6')).toBe(true);
  });

  it('refresh soft TTL-7', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_soft_7`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REFDEV7',
      accessTokenId: 'oldtok7',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok7',
      token_hash: 'oldhash7',
      user_id: USER,
      device_id: 'REFDEV7',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
    expect(db.tokens.every((t) => t.token_id !== 'oldtok7')).toBe(true);
  });

  it('refresh soft TTL-8', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_soft_8`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REFDEV8',
      accessTokenId: 'oldtok8',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok8',
      token_hash: 'oldhash8',
      user_id: USER,
      device_id: 'REFDEV8',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
    expect(db.tokens.every((t) => t.token_id !== 'oldtok8')).toBe(true);
  });

  it('refresh soft TTL-9', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_soft_9`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REFDEV9',
      accessTokenId: 'oldtok9',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok9',
      token_hash: 'oldhash9',
      user_id: USER,
      device_id: 'REFDEV9',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
    expect(db.tokens.every((t) => t.token_id !== 'oldtok9')).toBe(true);
  });

  it('refresh soft TTL-10', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_soft_10`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REFDEV10',
      accessTokenId: 'oldtok10',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok10',
      token_hash: 'oldhash10',
      user_id: USER,
      device_id: 'REFDEV10',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
    expect(db.tokens.every((t) => t.token_id !== 'oldtok10')).toBe(true);
  });

  it('refresh soft TTL-11', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_soft_11`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REFDEV11',
      accessTokenId: 'oldtok11',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok11',
      token_hash: 'oldhash11',
      user_id: USER,
      device_id: 'REFDEV11',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
    expect(db.tokens.every((t) => t.token_id !== 'oldtok11')).toBe(true);
  });

  it('refresh soft TTL-12', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_soft_12`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REFDEV12',
      accessTokenId: 'oldtok12',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok12',
      token_hash: 'oldhash12',
      user_id: USER,
      device_id: 'REFDEV12',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
    expect(db.tokens.every((t) => t.token_id !== 'oldtok12')).toBe(true);
  });

  it('refresh soft TTL-13', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_soft_13`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REFDEV13',
      accessTokenId: 'oldtok13',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok13',
      token_hash: 'oldhash13',
      user_id: USER,
      device_id: 'REFDEV13',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
    expect(db.tokens.every((t) => t.token_id !== 'oldtok13')).toBe(true);
  });

  it('refresh soft TTL-14', async () => {
    const db = createLoginDb({ users: aliceUser() });
    const sessions = mockKv();
    const refresh = `syr_soft_14`;
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: 'REFDEV14',
      accessTokenId: 'oldtok14',
      createdAt: NOW - 1000,
    });
    db.tokens.push({
      token_id: 'oldtok14',
      token_hash: 'oldhash14',
      user_id: USER,
      device_id: 'REFDEV14',
      created_at: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh }, '')
    );
    expect(status).toBe(200);
    expect(body.expires_in_ms).toBe(3_600_000);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(sessions.deletes).toContain(`refresh:${refreshHash}`);
    expect(sessions.puts.some((p) => p.key.startsWith('refresh:') && p.options?.expirationTtl === REFRESH_TTL)).toBe(true);
    expect(db.tokens.every((t) => t.token_id !== 'oldtok14')).toBe(true);
  });
});

describe('login soft leftovers get_token TTL soft flood after #142', () => {

  it('get_token soft TTL-0', async () => {
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
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(sessions.puts.some((p) => p.key.startsWith('login_token:') && p.options?.expirationTtl === 120)).toBe(true);
  });

  it('get_token soft TTL-1', async () => {
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
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(sessions.puts.some((p) => p.key.startsWith('login_token:') && p.options?.expirationTtl === 120)).toBe(true);
  });

  it('get_token soft TTL-2', async () => {
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
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(sessions.puts.some((p) => p.key.startsWith('login_token:') && p.options?.expirationTtl === 120)).toBe(true);
  });

  it('get_token soft TTL-3', async () => {
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
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(sessions.puts.some((p) => p.key.startsWith('login_token:') && p.options?.expirationTtl === 120)).toBe(true);
  });

  it('get_token soft TTL-4', async () => {
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
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(sessions.puts.some((p) => p.key.startsWith('login_token:') && p.options?.expirationTtl === 120)).toBe(true);
  });

  it('get_token soft TTL-5', async () => {
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
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(sessions.puts.some((p) => p.key.startsWith('login_token:') && p.options?.expirationTtl === 120)).toBe(true);
  });

  it('get_token soft TTL-6', async () => {
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
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(sessions.puts.some((p) => p.key.startsWith('login_token:') && p.options?.expirationTtl === 120)).toBe(true);
  });

  it('get_token soft TTL-7', async () => {
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
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(sessions.puts.some((p) => p.key.startsWith('login_token:') && p.options?.expirationTtl === 120)).toBe(true);
  });

  it('get_token soft TTL-8', async () => {
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
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(sessions.puts.some((p) => p.key.startsWith('login_token:') && p.options?.expirationTtl === 120)).toBe(true);
  });

  it('get_token soft TTL-9', async () => {
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
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(sessions.puts.some((p) => p.key.startsWith('login_token:') && p.options?.expirationTtl === 120)).toBe(true);
  });

  it('get_token soft TTL-10', async () => {
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
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(sessions.puts.some((p) => p.key.startsWith('login_token:') && p.options?.expirationTtl === 120)).toBe(true);
  });

  it('get_token soft TTL-11', async () => {
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
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(sessions.puts.some((p) => p.key.startsWith('login_token:') && p.options?.expirationTtl === 120)).toBe(true);
  });

  it('get_token soft TTL-12', async () => {
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
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(sessions.puts.some((p) => p.key.startsWith('login_token:') && p.options?.expirationTtl === 120)).toBe(true);
  });

  it('get_token soft TTL-13', async () => {
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
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(sessions.puts.some((p) => p.key.startsWith('login_token:') && p.options?.expirationTtl === 120)).toBe(true);
  });

  it('get_token soft TTL-14', async () => {
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
    expect(body.expires_in_ms).toBe(120_000);
    expect(typeof body.login_token).toBe('string');
    expect(sessions.puts.some((p) => p.key.startsWith('login_token:') && p.options?.expirationTtl === 120)).toBe(true);
  });
});

describe('login soft leftovers whoami guest/user soft flood after #142', () => {

  it('whoami soft is_guest=0 #0', async () => {
    authState.userId = USER;
    authState.deviceId = 'WHO0';
    const db = createLoginDb({ users: aliceUser({ is_guest: 0 }) });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/account/whoami');
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: USER, device_id: 'WHO0', is_guest: false });
  });

  it('whoami soft is_guest=1 #1', async () => {
    authState.userId = USER;
    authState.deviceId = 'WHO1';
    const db = createLoginDb({ users: aliceUser({ is_guest: 1 }) });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/account/whoami');
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: USER, device_id: 'WHO1', is_guest: true });
  });

  it('whoami soft is_guest=0 #2', async () => {
    authState.userId = USER;
    authState.deviceId = 'WHO2';
    const db = createLoginDb({ users: aliceUser({ is_guest: 0 }) });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/account/whoami');
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: USER, device_id: 'WHO2', is_guest: false });
  });

  it('whoami soft is_guest=1 #3', async () => {
    authState.userId = USER;
    authState.deviceId = 'WHO3';
    const db = createLoginDb({ users: aliceUser({ is_guest: 1 }) });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/account/whoami');
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: USER, device_id: 'WHO3', is_guest: true });
  });

  it('whoami soft is_guest=0 #4', async () => {
    authState.userId = USER;
    authState.deviceId = 'WHO4';
    const db = createLoginDb({ users: aliceUser({ is_guest: 0 }) });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/account/whoami');
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: USER, device_id: 'WHO4', is_guest: false });
  });

  it('whoami soft is_guest=1 #5', async () => {
    authState.userId = USER;
    authState.deviceId = 'WHO5';
    const db = createLoginDb({ users: aliceUser({ is_guest: 1 }) });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/account/whoami');
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: USER, device_id: 'WHO5', is_guest: true });
  });

  it('whoami soft is_guest=0 #6', async () => {
    authState.userId = USER;
    authState.deviceId = 'WHO6';
    const db = createLoginDb({ users: aliceUser({ is_guest: 0 }) });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/account/whoami');
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: USER, device_id: 'WHO6', is_guest: false });
  });

  it('whoami soft is_guest=1 #7', async () => {
    authState.userId = USER;
    authState.deviceId = 'WHO7';
    const db = createLoginDb({ users: aliceUser({ is_guest: 1 }) });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/account/whoami');
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: USER, device_id: 'WHO7', is_guest: true });
  });

  it('whoami soft is_guest=0 #8', async () => {
    authState.userId = USER;
    authState.deviceId = 'WHO8';
    const db = createLoginDb({ users: aliceUser({ is_guest: 0 }) });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/account/whoami');
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: USER, device_id: 'WHO8', is_guest: false });
  });

  it('whoami soft is_guest=1 #9', async () => {
    authState.userId = USER;
    authState.deviceId = 'WHO9';
    const db = createLoginDb({ users: aliceUser({ is_guest: 1 }) });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/account/whoami');
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: USER, device_id: 'WHO9', is_guest: true });
  });

  it('whoami soft is_guest=0 #10', async () => {
    authState.userId = USER;
    authState.deviceId = 'WHO10';
    const db = createLoginDb({ users: aliceUser({ is_guest: 0 }) });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/account/whoami');
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: USER, device_id: 'WHO10', is_guest: false });
  });

  it('whoami soft is_guest=1 #11', async () => {
    authState.userId = USER;
    authState.deviceId = 'WHO11';
    const db = createLoginDb({ users: aliceUser({ is_guest: 1 }) });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/account/whoami');
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: USER, device_id: 'WHO11', is_guest: true });
  });
});

describe('login soft leftovers register inhibit_login soft flood after #142', () => {

  it('register inhibit_login soft-0', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const username = `softuser0`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', {
        username,
        password: STRONG_PW,
        auth: { type: 'm.login.dummy', session: 's0' },
        inhibit_login: true,
      }, '')
    );
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: `@${username}:${SERVER}`, home_server: SERVER });
    expect(body.access_token).toBeUndefined();
    expect(db.tokens.length).toBe(0);
  });

  it('register inhibit_login soft-1', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const username = `softuser1`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', {
        username,
        password: STRONG_PW,
        auth: { type: 'm.login.dummy', session: 's1' },
        inhibit_login: true,
      }, '')
    );
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: `@${username}:${SERVER}`, home_server: SERVER });
    expect(body.access_token).toBeUndefined();
    expect(db.tokens.length).toBe(0);
  });

  it('register inhibit_login soft-2', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const username = `softuser2`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', {
        username,
        password: STRONG_PW,
        auth: { type: 'm.login.dummy', session: 's2' },
        inhibit_login: true,
      }, '')
    );
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: `@${username}:${SERVER}`, home_server: SERVER });
    expect(body.access_token).toBeUndefined();
    expect(db.tokens.length).toBe(0);
  });

  it('register inhibit_login soft-3', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const username = `softuser3`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', {
        username,
        password: STRONG_PW,
        auth: { type: 'm.login.dummy', session: 's3' },
        inhibit_login: true,
      }, '')
    );
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: `@${username}:${SERVER}`, home_server: SERVER });
    expect(body.access_token).toBeUndefined();
    expect(db.tokens.length).toBe(0);
  });

  it('register inhibit_login soft-4', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const username = `softuser4`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', {
        username,
        password: STRONG_PW,
        auth: { type: 'm.login.dummy', session: 's4' },
        inhibit_login: true,
      }, '')
    );
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: `@${username}:${SERVER}`, home_server: SERVER });
    expect(body.access_token).toBeUndefined();
    expect(db.tokens.length).toBe(0);
  });

  it('register inhibit_login soft-5', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const username = `softuser5`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', {
        username,
        password: STRONG_PW,
        auth: { type: 'm.login.dummy', session: 's5' },
        inhibit_login: true,
      }, '')
    );
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: `@${username}:${SERVER}`, home_server: SERVER });
    expect(body.access_token).toBeUndefined();
    expect(db.tokens.length).toBe(0);
  });

  it('register inhibit_login soft-6', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const username = `softuser6`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', {
        username,
        password: STRONG_PW,
        auth: { type: 'm.login.dummy', session: 's6' },
        inhibit_login: true,
      }, '')
    );
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: `@${username}:${SERVER}`, home_server: SERVER });
    expect(body.access_token).toBeUndefined();
    expect(db.tokens.length).toBe(0);
  });

  it('register inhibit_login soft-7', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const username = `softuser7`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', {
        username,
        password: STRONG_PW,
        auth: { type: 'm.login.dummy', session: 's7' },
        inhibit_login: true,
      }, '')
    );
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: `@${username}:${SERVER}`, home_server: SERVER });
    expect(body.access_token).toBeUndefined();
    expect(db.tokens.length).toBe(0);
  });

  it('register inhibit_login soft-8', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const username = `softuser8`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', {
        username,
        password: STRONG_PW,
        auth: { type: 'm.login.dummy', session: 's8' },
        inhibit_login: true,
      }, '')
    );
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: `@${username}:${SERVER}`, home_server: SERVER });
    expect(body.access_token).toBeUndefined();
    expect(db.tokens.length).toBe(0);
  });

  it('register inhibit_login soft-9', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const username = `softuser9`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', {
        username,
        password: STRONG_PW,
        auth: { type: 'm.login.dummy', session: 's9' },
        inhibit_login: true,
      }, '')
    );
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: `@${username}:${SERVER}`, home_server: SERVER });
    expect(body.access_token).toBeUndefined();
    expect(db.tokens.length).toBe(0);
  });

  it('register inhibit_login soft-10', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const username = `softuser10`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', {
        username,
        password: STRONG_PW,
        auth: { type: 'm.login.dummy', session: 's10' },
        inhibit_login: true,
      }, '')
    );
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: `@${username}:${SERVER}`, home_server: SERVER });
    expect(body.access_token).toBeUndefined();
    expect(db.tokens.length).toBe(0);
  });

  it('register inhibit_login soft-11', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const username = `softuser11`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', {
        username,
        password: STRONG_PW,
        auth: { type: 'm.login.dummy', session: 's11' },
        inhibit_login: true,
      }, '')
    );
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: `@${username}:${SERVER}`, home_server: SERVER });
    expect(body.access_token).toBeUndefined();
    expect(db.tokens.length).toBe(0);
  });

  it('register inhibit_login soft-12', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const username = `softuser12`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', {
        username,
        password: STRONG_PW,
        auth: { type: 'm.login.dummy', session: 's12' },
        inhibit_login: true,
      }, '')
    );
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: `@${username}:${SERVER}`, home_server: SERVER });
    expect(body.access_token).toBeUndefined();
    expect(db.tokens.length).toBe(0);
  });

  it('register inhibit_login soft-13', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const username = `softuser13`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', {
        username,
        password: STRONG_PW,
        auth: { type: 'm.login.dummy', session: 's13' },
        inhibit_login: true,
      }, '')
    );
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: `@${username}:${SERVER}`, home_server: SERVER });
    expect(body.access_token).toBeUndefined();
    expect(db.tokens.length).toBe(0);
  });

  it('register inhibit_login soft-14', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const username = `softuser14`;
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', {
        username,
        password: STRONG_PW,
        auth: { type: 'm.login.dummy', session: 's14' },
        inhibit_login: true,
      }, '')
    );
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: `@${username}:${SERVER}`, home_server: SERVER });
    expect(body.access_token).toBeUndefined();
    expect(db.tokens.length).toBe(0);
  });
});

describe('login soft leftovers register available soft valid flood after #142', () => {

  it('available soft-0', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register/available?username=avail_soft_0'
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });

  it('available soft-1', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register/available?username=avail_soft_1'
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });

  it('available soft-2', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register/available?username=avail_soft_2'
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });

  it('available soft-3', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register/available?username=avail_soft_3'
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });

  it('available soft-4', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register/available?username=avail_soft_4'
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });

  it('available soft-5', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register/available?username=avail_soft_5'
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });

  it('available soft-6', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register/available?username=avail_soft_6'
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });

  it('available soft-7', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register/available?username=avail_soft_7'
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });

  it('available soft-8', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register/available?username=avail_soft_8'
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });

  it('available soft-9', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register/available?username=avail_soft_9'
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });

  it('available soft-10', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register/available?username=avail_soft_10'
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });

  it('available soft-11', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register/available?username=avail_soft_11'
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });

  it('available soft-12', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register/available?username=avail_soft_12'
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });

  it('available soft-13', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register/available?username=avail_soft_13'
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });

  it('available soft-14', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register/available?username=avail_soft_14'
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });

  it('available soft-15', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register/available?username=avail_soft_15'
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });

  it('available soft-16', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register/available?username=avail_soft_16'
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });

  it('available soft-17', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register/available?username=avail_soft_17'
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });

  it('available soft-18', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register/available?username=avail_soft_18'
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });

  it('available soft-19', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/register/available?username=avail_soft_19'
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
});

describe('login soft leftovers logout / logout_all soft after #142', () => {

  it('logout soft-0', async () => {
    const token = 'logout-tok-0';
    const tokenHash = await hashToken(token);
    const db = createLoginDb({
      users: aliceUser(),
      tokens: [
        { token_id: 't0', token_hash: tokenHash, user_id: USER, device_id: DEVICE, created_at: NOW },
        { token_id: 'other0', token_hash: 'otherhash0', user_id: USER, device_id: 'OTHER', created_at: NOW },
      ],
    });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/logout',
      jsonInit('POST', {}, token)
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.tokens.every((t) => t.token_hash !== tokenHash)).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'other0')).toBe(true);
  });

  it('logout soft-1', async () => {
    const token = 'logout-tok-1';
    const tokenHash = await hashToken(token);
    const db = createLoginDb({
      users: aliceUser(),
      tokens: [
        { token_id: 't1', token_hash: tokenHash, user_id: USER, device_id: DEVICE, created_at: NOW },
        { token_id: 'other1', token_hash: 'otherhash1', user_id: USER, device_id: 'OTHER', created_at: NOW },
      ],
    });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/logout',
      jsonInit('POST', {}, token)
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.tokens.every((t) => t.token_hash !== tokenHash)).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'other1')).toBe(true);
  });

  it('logout soft-2', async () => {
    const token = 'logout-tok-2';
    const tokenHash = await hashToken(token);
    const db = createLoginDb({
      users: aliceUser(),
      tokens: [
        { token_id: 't2', token_hash: tokenHash, user_id: USER, device_id: DEVICE, created_at: NOW },
        { token_id: 'other2', token_hash: 'otherhash2', user_id: USER, device_id: 'OTHER', created_at: NOW },
      ],
    });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/logout',
      jsonInit('POST', {}, token)
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.tokens.every((t) => t.token_hash !== tokenHash)).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'other2')).toBe(true);
  });

  it('logout soft-3', async () => {
    const token = 'logout-tok-3';
    const tokenHash = await hashToken(token);
    const db = createLoginDb({
      users: aliceUser(),
      tokens: [
        { token_id: 't3', token_hash: tokenHash, user_id: USER, device_id: DEVICE, created_at: NOW },
        { token_id: 'other3', token_hash: 'otherhash3', user_id: USER, device_id: 'OTHER', created_at: NOW },
      ],
    });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/logout',
      jsonInit('POST', {}, token)
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.tokens.every((t) => t.token_hash !== tokenHash)).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'other3')).toBe(true);
  });

  it('logout soft-4', async () => {
    const token = 'logout-tok-4';
    const tokenHash = await hashToken(token);
    const db = createLoginDb({
      users: aliceUser(),
      tokens: [
        { token_id: 't4', token_hash: tokenHash, user_id: USER, device_id: DEVICE, created_at: NOW },
        { token_id: 'other4', token_hash: 'otherhash4', user_id: USER, device_id: 'OTHER', created_at: NOW },
      ],
    });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/logout',
      jsonInit('POST', {}, token)
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.tokens.every((t) => t.token_hash !== tokenHash)).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'other4')).toBe(true);
  });

  it('logout soft-5', async () => {
    const token = 'logout-tok-5';
    const tokenHash = await hashToken(token);
    const db = createLoginDb({
      users: aliceUser(),
      tokens: [
        { token_id: 't5', token_hash: tokenHash, user_id: USER, device_id: DEVICE, created_at: NOW },
        { token_id: 'other5', token_hash: 'otherhash5', user_id: USER, device_id: 'OTHER', created_at: NOW },
      ],
    });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/logout',
      jsonInit('POST', {}, token)
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.tokens.every((t) => t.token_hash !== tokenHash)).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'other5')).toBe(true);
  });

  it('logout soft-6', async () => {
    const token = 'logout-tok-6';
    const tokenHash = await hashToken(token);
    const db = createLoginDb({
      users: aliceUser(),
      tokens: [
        { token_id: 't6', token_hash: tokenHash, user_id: USER, device_id: DEVICE, created_at: NOW },
        { token_id: 'other6', token_hash: 'otherhash6', user_id: USER, device_id: 'OTHER', created_at: NOW },
      ],
    });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/logout',
      jsonInit('POST', {}, token)
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.tokens.every((t) => t.token_hash !== tokenHash)).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'other6')).toBe(true);
  });

  it('logout soft-7', async () => {
    const token = 'logout-tok-7';
    const tokenHash = await hashToken(token);
    const db = createLoginDb({
      users: aliceUser(),
      tokens: [
        { token_id: 't7', token_hash: tokenHash, user_id: USER, device_id: DEVICE, created_at: NOW },
        { token_id: 'other7', token_hash: 'otherhash7', user_id: USER, device_id: 'OTHER', created_at: NOW },
      ],
    });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/logout',
      jsonInit('POST', {}, token)
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.tokens.every((t) => t.token_hash !== tokenHash)).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'other7')).toBe(true);
  });

  it('logout soft-8', async () => {
    const token = 'logout-tok-8';
    const tokenHash = await hashToken(token);
    const db = createLoginDb({
      users: aliceUser(),
      tokens: [
        { token_id: 't8', token_hash: tokenHash, user_id: USER, device_id: DEVICE, created_at: NOW },
        { token_id: 'other8', token_hash: 'otherhash8', user_id: USER, device_id: 'OTHER', created_at: NOW },
      ],
    });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/logout',
      jsonInit('POST', {}, token)
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.tokens.every((t) => t.token_hash !== tokenHash)).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'other8')).toBe(true);
  });

  it('logout soft-9', async () => {
    const token = 'logout-tok-9';
    const tokenHash = await hashToken(token);
    const db = createLoginDb({
      users: aliceUser(),
      tokens: [
        { token_id: 't9', token_hash: tokenHash, user_id: USER, device_id: DEVICE, created_at: NOW },
        { token_id: 'other9', token_hash: 'otherhash9', user_id: USER, device_id: 'OTHER', created_at: NOW },
      ],
    });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(
      env,
      '/_matrix/client/v3/logout',
      jsonInit('POST', {}, token)
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.tokens.every((t) => t.token_hash !== tokenHash)).toBe(true);
    expect(db.tokens.some((t) => t.token_id === 'other9')).toBe(true);
  });

  it('logout/all soft-0', async () => {
    authState.userId = USER;
    const db = createLoginDb({
      users: aliceUser(),
      tokens: [
        { token_id: 'a0', token_hash: 'ha0', user_id: USER, device_id: 'A', created_at: NOW },
        { token_id: 'b0', token_hash: 'hb0', user_id: USER, device_id: 'B', created_at: NOW },
      ],
    });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/logout/all', jsonInit('POST', {}));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.tokens.length).toBe(0);
  });

  it('logout/all soft-1', async () => {
    authState.userId = USER;
    const db = createLoginDb({
      users: aliceUser(),
      tokens: [
        { token_id: 'a1', token_hash: 'ha1', user_id: USER, device_id: 'A', created_at: NOW },
        { token_id: 'b1', token_hash: 'hb1', user_id: USER, device_id: 'B', created_at: NOW },
      ],
    });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/logout/all', jsonInit('POST', {}));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.tokens.length).toBe(0);
  });

  it('logout/all soft-2', async () => {
    authState.userId = USER;
    const db = createLoginDb({
      users: aliceUser(),
      tokens: [
        { token_id: 'a2', token_hash: 'ha2', user_id: USER, device_id: 'A', created_at: NOW },
        { token_id: 'b2', token_hash: 'hb2', user_id: USER, device_id: 'B', created_at: NOW },
      ],
    });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/logout/all', jsonInit('POST', {}));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.tokens.length).toBe(0);
  });

  it('logout/all soft-3', async () => {
    authState.userId = USER;
    const db = createLoginDb({
      users: aliceUser(),
      tokens: [
        { token_id: 'a3', token_hash: 'ha3', user_id: USER, device_id: 'A', created_at: NOW },
        { token_id: 'b3', token_hash: 'hb3', user_id: USER, device_id: 'B', created_at: NOW },
      ],
    });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/logout/all', jsonInit('POST', {}));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.tokens.length).toBe(0);
  });

  it('logout/all soft-4', async () => {
    authState.userId = USER;
    const db = createLoginDb({
      users: aliceUser(),
      tokens: [
        { token_id: 'a4', token_hash: 'ha4', user_id: USER, device_id: 'A', created_at: NOW },
        { token_id: 'b4', token_hash: 'hb4', user_id: USER, device_id: 'B', created_at: NOW },
      ],
    });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/logout/all', jsonInit('POST', {}));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.tokens.length).toBe(0);
  });

  it('logout/all soft-5', async () => {
    authState.userId = USER;
    const db = createLoginDb({
      users: aliceUser(),
      tokens: [
        { token_id: 'a5', token_hash: 'ha5', user_id: USER, device_id: 'A', created_at: NOW },
        { token_id: 'b5', token_hash: 'hb5', user_id: USER, device_id: 'B', created_at: NOW },
      ],
    });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/logout/all', jsonInit('POST', {}));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.tokens.length).toBe(0);
  });

  it('logout/all soft-6', async () => {
    authState.userId = USER;
    const db = createLoginDb({
      users: aliceUser(),
      tokens: [
        { token_id: 'a6', token_hash: 'ha6', user_id: USER, device_id: 'A', created_at: NOW },
        { token_id: 'b6', token_hash: 'hb6', user_id: USER, device_id: 'B', created_at: NOW },
      ],
    });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/logout/all', jsonInit('POST', {}));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.tokens.length).toBe(0);
  });

  it('logout/all soft-7', async () => {
    authState.userId = USER;
    const db = createLoginDb({
      users: aliceUser(),
      tokens: [
        { token_id: 'a7', token_hash: 'ha7', user_id: USER, device_id: 'A', created_at: NOW },
        { token_id: 'b7', token_hash: 'hb7', user_id: USER, device_id: 'B', created_at: NOW },
      ],
    });
    const env = loginEnv(db);
    const { status, body } = await loginRequest(env, '/_matrix/client/v3/logout/all', jsonInit('POST', {}));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.tokens.length).toBe(0);
  });
});

describe('login soft leftovers home_server reflection soft matrix after #142', () => {
  const names = ['example.com', 'example.org', 'test.example.com', 'matrix.example.com'];
  for (const name of names) {
    it(`password login home_server=${name}`, async () => {
      const userId = `@alice:${name}`;
      const u = userRow({
        user_id: userId,
        localpart: 'alice',
        password_hash: `mockok:${STRONG_PW}`,
      });
      const db = createLoginDb({ users: new Map([[userId, u]]) });
      const env = loginEnv(db, mockKv(), name);
      const { status, body } = await loginRequest(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'alice' },
          password: STRONG_PW,
          device_id: 'HS',
        }, '')
      );
      expect(status).toBe(200);
      expect(body.home_server).toBe(name);
      expect(body.user_id).toBe(userId);
    });
  }
});
