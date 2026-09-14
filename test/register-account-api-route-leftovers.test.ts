/**
 * TOKENMAXX HEAVY deepen after oauth leftovers (#134/#136) — register + account leftovers.
 * Orthogonal to open #137 (login/push/account-data edits) and merged #135 (account-api-routes).
 * New suite file — does not touch oauth. Prefer register/account leftovers.
 * Tests-only — Hono app.request() against src/api/login.ts + src/api/account.ts. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

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

const emailMocks = vi.hoisted(() => ({
  sendVerificationEmail: vi.fn(),
  createVerificationSession: vi.fn(),
  validateEmailToken: vi.fn(),
  getValidatedSession: vi.fn(),
}));

vi.mock('../src/services/email', () => ({
  sendVerificationEmail: emailMocks.sendVerificationEmail,
  createVerificationSession: emailMocks.createVerificationSession,
  validateEmailToken: emailMocks.validateEmailToken,
  getValidatedSession: emailMocks.getValidatedSession,
}));

import login from '../src/api/login';
import account from '../src/api/account';
import { hashPassword, verifyPassword } from '../src/utils/crypto';

const SERVER = 'example.com';
const USER = `@alice:${SERVER}`;
const DEVICE = 'DEVICE';
const CURRENT_PW = 'oldpass1';
const STRONG_PW = 'Password1!';
const NOW = 1_730_300_000_000;

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

type ThreepidRow = {
  user_id: string;
  medium: string;
  address: string;
  validated_at: number;
  added_at: number;
};

type Membership = { room_id: string; user_id: string; membership: string };
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
              throw new Error(`Unhandled SQL in register leftovers stub: ${sql.slice(0, 140)}`);
            },
          };
        },
      };
    },
  };
}

type LoginDb = ReturnType<typeof createLoginDb>;

function createAccountDb(opts: {
  users?: Map<
    string,
    {
      user_id: string;
      password_hash: string | null;
      is_deactivated: number;
      display_name: string | null;
      avatar_url: string | null;
    }
  >;
  threepids?: ThreepidRow[];
  memberships?: Membership[];
  tokens?: { token_hash: string; user_id: string; device_id: string }[];
} = {}) {
  const users =
    opts.users ??
    new Map([
      [
        USER,
        {
          user_id: USER,
          password_hash: `mockok:${CURRENT_PW}`,
          is_deactivated: 0,
          display_name: 'Alice',
          avatar_url: 'mxc://example.com/a',
        },
      ],
    ]);
  const threepids = opts.threepids ?? [];
  const memberships = opts.memberships ?? [];
  const tokens = opts.tokens ?? [
    { token_hash: 'tok-a', user_id: USER, device_id: DEVICE },
    { token_hash: 'tok-b', user_id: USER, device_id: 'DEVICEB' },
  ];
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const runs: SqlCall[] = [];

  return {
    users,
    threepids,
    memberships,
    tokens,
    inserts,
    updates,
    deletes,
    runs,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT password_hash FROM users')) {
                const user = users.get(args[0] as string);
                if (!user) return null;
                return { password_hash: user.password_hash } as T;
              }
              if (
                sql.includes('FROM user_threepids') &&
                sql.includes("medium = 'email'") &&
                sql.includes('address = ?')
              ) {
                const address = args[0] as string;
                const hit = threepids.find((t) => t.medium === 'email' && t.address === address);
                return (hit ? { user_id: hit.user_id } : null) as T;
              }
              return null;
            },
            async all<T>() {
              if (sql.includes('FROM user_threepids') && sql.includes('WHERE user_id = ?')) {
                const userId = args[0] as string;
                return {
                  results: threepids
                    .filter((t) => t.user_id === userId)
                    .map((t) => ({
                      medium: t.medium,
                      address: t.address,
                      validated_at: t.validated_at,
                      added_at: t.added_at,
                    })),
                } as { results: T[] };
              }
              if (sql.includes('FROM room_memberships') && sql.includes("membership = 'join'")) {
                const userId = args[0] as string;
                return {
                  results: memberships
                    .filter((m) => m.user_id === userId && m.membership === 'join')
                    .map((m) => ({ room_id: m.room_id })),
                } as { results: T[] };
              }
              return { results: [] as T[] };
            },
            async run() {
              runs.push({ sql, args });
              if (sql.includes('UPDATE users SET password_hash')) {
                updates.push({ sql, args });
                const [hash, userId] = args as [string, string];
                const user = users.get(userId);
                if (user) user.password_hash = hash;
                return { success: true, meta: { changes: user ? 1 : 0, last_row_id: 0 } };
              }
              if (sql.includes('UPDATE users SET is_deactivated = 1')) {
                updates.push({ sql, args });
                const user = users.get(args[0] as string);
                if (user) user.is_deactivated = 1;
                return { success: true, meta: { changes: user ? 1 : 0, last_row_id: 0 } };
              }
              if (sql.includes('UPDATE users SET display_name = NULL')) {
                updates.push({ sql, args });
                const user = users.get(args[0] as string);
                if (user) {
                  user.display_name = null;
                  user.avatar_url = null;
                }
                return { success: true, meta: { changes: user ? 1 : 0, last_row_id: 0 } };
              }
              if (sql.includes('UPDATE room_memberships SET membership = ')) {
                updates.push({ sql, args });
                const [roomId, userId] = args as [string, string];
                const hit = memberships.find((m) => m.room_id === roomId && m.user_id === userId);
                if (hit) hit.membership = 'leave';
                return { success: true, meta: { changes: hit ? 1 : 0, last_row_id: 0 } };
              }
              if (sql.includes('DELETE FROM access_tokens')) {
                deletes.push({ sql, args });
                const userId = args[0] as string;
                for (let i = tokens.length - 1; i >= 0; i--) {
                  if (tokens[i].user_id === userId) tokens.splice(i, 1);
                }
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('INSERT OR REPLACE INTO user_threepids')) {
                inserts.push({ sql, args });
                const [userId, address, validatedAt, addedAt] = args as [
                  string,
                  string,
                  number,
                  number,
                ];
                threepids.push({
                  user_id: userId,
                  medium: 'email',
                  address,
                  validated_at: validatedAt,
                  added_at: addedAt,
                });
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('DELETE FROM user_threepids')) {
                deletes.push({ sql, args });
                const [userId, medium, address] = args as [string, string, string];
                for (let i = threepids.length - 1; i >= 0; i--) {
                  const t = threepids[i];
                  if (t.user_id === userId && t.medium === medium && t.address === address) {
                    threepids.splice(i, 1);
                  }
                }
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('DELETE FROM email_verification_sessions')) {
                deletes.push({ sql, args });
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              throw new Error(`Unhandled SQL in account leftovers stub: ${sql.slice(0, 160)}`);
            },
          };
        },
      };
    },
  };
}

type AccountDb = ReturnType<typeof createAccountDb>;

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

function accountEnv(
  db?: AccountDb,
  cache?: ReturnType<typeof mockKv>
): Env & { _db: AccountDb; _cache: ReturnType<typeof mockKv> } {
  const d = db ?? createAccountDb();
  const c = cache ?? mockKv();
  return {
    DB: d as unknown as D1Database,
    SERVER_NAME: SERVER,
    CACHE: c,
    EMAIL: { send: vi.fn(async () => ({ messageId: 'm1' })) },
    _db: d,
    _cache: c,
  } as unknown as Env & { _db: AccountDb; _cache: ReturnType<typeof mockKv> };
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

async function accountRequest(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: any }> {
  const res = await account.request(`http://localhost${path}`, init, env);
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

function registerBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    username: 'carol',
    password: STRONG_PW,
    auth: { type: 'm.login.dummy', session: 'sess-reg' },
    device_id: 'REGDEV',
    initial_device_display_name: 'Reg Device',
    ...overrides,
  };
}

function passwordAuth(password = CURRENT_PW, session = 'sess-1') {
  return { type: 'm.login.password', session, password };
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
  emailMocks.sendVerificationEmail.mockResolvedValue({ success: true });
  emailMocks.createVerificationSession.mockResolvedValue({
    sessionId: 'sid-new',
    token: '654321',
  });
  emailMocks.validateEmailToken.mockResolvedValue({ success: true });
  emailMocks.getValidatedSession.mockResolvedValue({ email: 'alice@example.com' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});


describe('register leftovers GET /register/available', () => {
  it('requires username query param when missing', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(env, '/_matrix/client/v3/register/available');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('binds localpart lookup exactly once for available names', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const res = await loginRequest(env, '/_matrix/client/v3/register/available?username=freshuser');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
    const localpartSelects = db.selects.filter((s) => s.sql.includes('localpart = ?'));
    expect(localpartSelects).toHaveLength(1);
    expect(localpartSelects[0].args).toEqual(['freshuser']);
  });

  it('returns M_USER_IN_USE for deactivated localpart', async () => {
    const db = createLoginDb({
      users: new Map([
        [USER, userRow({ user_id: USER, localpart: 'alice', is_deactivated: 1, password_hash: 'mockok:x' })],
      ]),
    });
    const env = loginEnv(db);
    const res = await loginRequest(env, '/_matrix/client/v3/register/available?username=alice');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_USER_IN_USE');
  });

  it('returns M_USER_IN_USE for guest localpart collision', async () => {
    const guestId = `@guestabc:${SERVER}`;
    const db = createLoginDb({
      users: new Map([[guestId, userRow({ user_id: guestId, localpart: 'guestabc', is_guest: 1 })]]),
    });
    const env = loginEnv(db);
    const res = await loginRequest(env, '/_matrix/client/v3/register/available?username=guestabc');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_USER_IN_USE');
  });

  it('accepts 255-char localpart and rejects 256', async () => {
    const env = loginEnv(createLoginDb());
    const ok = 'a'.repeat(255);
    const bad = 'a'.repeat(256);
    const r1 = await loginRequest(env, `/_matrix/client/v3/register/available?username=${encodeURIComponent(ok)}`);
    expect(r1.status).toBe(200);
    expect(r1.body.available).toBe(true);
    const r2 = await loginRequest(env, `/_matrix/client/v3/register/available?username=${encodeURIComponent(bad)}`);
    expect(r2.status).toBe(400);
    expect(r2.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('accepts slash and equals in localpart', async () => {
    const env = loginEnv(createLoginDb());
    for (const name of ['user/name', 'user=name', 'a.b_c-d/e=f']) {
      const res = await loginRequest(
        env,
        `/_matrix/client/v3/register/available?username=${encodeURIComponent(name)}`
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ available: true });
    }
  });

  it('empty username string is missing after present query', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(env, '/_matrix/client/v3/register/available?username=');
    // empty string is falsy → missing param
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
});


describe('register leftovers available invalid charset matrix', () => {

  it('rejects invalid localpart (uppercase)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "Alice";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (space)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (at)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a@b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (colon)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a:b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (plus)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a+b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (bang)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a!b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (hash)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a#b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (dollar)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a$b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (percent)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a%b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (amp)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a&b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (star)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a*b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (paren-open)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a(b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (paren-close)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a)b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (bracket)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a[b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (brace)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a{b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (comma)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a,b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (semicolon)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a;b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (squote)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a'b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (dquote)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a\"b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (backslash)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a\\b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (tilde)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a~b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (caret)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a^b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (pipe)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a|b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (question)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a?b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (unicode)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "caf\u00e9";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (emoji)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "user\ud83d\ude00";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (newline)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a\nb";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (tab)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a\tb";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (leading-space)', async () => {
    const env = loginEnv(createLoginDb());
    const username = " alice";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('rejects invalid localpart (trailing-space)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "alice ";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

});


describe('register leftovers available valid localpart matrix', () => {

  it('accepts valid localpart (alice)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "alice";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (a)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (0)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "0";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (9z)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "9z";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (user.name)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "user.name";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (user_name)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "user_name";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (user-name)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "user-name";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (user=name)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "user=name";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (user/name)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "user/name";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (abc123)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "abc123";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (.=_/-a)', async () => {
    const env = loginEnv(createLoginDb());
    const username = ".=_/-a";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (a/=._-9)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a/=._-9";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (len-64)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (len-128)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('accepts valid localpart (len-200)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

});


describe('register leftovers POST /register — UIA and kind', () => {
  it('rejects non-JSON with M_BAD_JSON', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(env, '/_matrix/client/v3/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('rejects invalid kind values', async () => {
    const env = loginEnv(createLoginDb());
    for (const kind of ['admin', 'USER', 'Guest', 'bot', ' ', 'null']) {
      const res = await loginRequest(
        env,
        `/_matrix/client/v3/register?kind=${encodeURIComponent(kind)}`,
        jsonInit('POST', registerBody({ username: `k${kind.trim() || 'sp'}` }), '')
      );
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_INVALID_PARAM');
    }
  });

  it('empty kind query defaults to user via falsy ||', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register?kind=',
      jsonInit('POST', registerBody({ username: 'kindempty' }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@kindempty:${SERVER}`);
  });

  it('returns UIA when auth missing with unique sessions', async () => {
    const env = loginEnv(createLoginDb());
    const a = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', { username: 'u1', password: STRONG_PW }, '')
    );
    const b = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', { username: 'u1', password: STRONG_PW }, '')
    );
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.flows).toEqual([{ stages: ['m.login.dummy'] }]);
    expect(a.body.params).toEqual({});
    expect(typeof a.body.session).toBe('string');
    expect(a.body.session).not.toBe(b.body.session);
  });

  it('returns UIA for wrong auth types', async () => {
    const env = loginEnv(createLoginDb());
    for (const type of ['m.login.password', 'm.login.token', 'm.login.sso', '', 'dummy']) {
      const res = await loginRequest(
        env,
        '/_matrix/client/v3/register',
        jsonInit('POST', registerBody({ auth: { type }, username: 'xtype' }), '')
      );
      expect(res.status).toBe(401);
      expect(res.body.flows[0].stages).toEqual(['m.login.dummy']);
    }
  });

  it('returns UIA when auth is empty object', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ auth: {} }), '')
    );
    expect(res.status).toBe(401);
  });

  it('guest registration skips UIA even without auth', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', {}, '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toMatch(/^@opaque\d+:example\.com$/);
    expect(res.body.access_token).toMatch(/^syt_/);
    expect(res.body.refresh_token).toMatch(/^syr_/);
    expect(res.body.expires_in_ms).toBe(3_600_000);
    expect(res.body.home_server).toBe(SERVER);
  });

  it('kind=user explicit still requires UIA', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register?kind=user',
      jsonInit('POST', { username: 'needsuia', password: STRONG_PW }, '')
    );
    expect(res.status).toBe(401);
  });
});


describe('register leftovers POST /register — password strength', () => {

  it('rejects weak password (too-short-7)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "weak0", password: "Ab1!xyz" }), '')
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ errcode: 'M_WEAK_PASSWORD', error: "Password must be at least 8 characters long" });
  });

  it('rejects weak password (no-letter)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "weak1", password: "12345678!" }), '')
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ errcode: 'M_WEAK_PASSWORD', error: "Password must contain at least one letter" });
  });

  it('rejects weak password (letters-only)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "weak2", password: "OnlyLetters" }), '')
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ errcode: 'M_WEAK_PASSWORD', error: "Password must contain at least one number or special character" });
  });

  it('rejects weak password (too-long-1001)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "weak3", password: "A1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }), '')
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ errcode: 'M_WEAK_PASSWORD', error: "Password must be at most 1000 characters long" });
  });

  it('rejects weak password (seven-as)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "weak4", password: "aaaaaaa" }), '')
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ errcode: 'M_WEAK_PASSWORD', error: "Password must be at least 8 characters long" });
  });

  it('rejects weak password (eight-letters)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "weak5", password: "abcdefgh" }), '')
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ errcode: 'M_WEAK_PASSWORD', error: "Password must contain at least one number or special character" });
  });

  it('accepts strong password (min-8-digit)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong0", password: "Password1", device_id: "D0" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong0:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (min-8-special)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong1", password: "Password!", device_id: "D1" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong1:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (exact-1000)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong2", password: "A1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", device_id: "D2" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong2:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (mixed)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong3", password: "Aa1!Bb2@", device_id: "D3" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong3:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-0-33)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong4", password: "Password!", device_id: "D4" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong4:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-1-64)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong5", password: "Password@", device_id: "D5" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong5:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-2-35)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong6", password: "Password#", device_id: "D6" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong6:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-3-36)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong7", password: "Password$", device_id: "D7" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong7:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-4-37)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong8", password: "Password%", device_id: "D8" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong8:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-5-94)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong9", password: "Password^", device_id: "D9" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong9:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-6-38)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong10", password: "Password&", device_id: "D10" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong10:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-7-42)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong11", password: "Password*", device_id: "D11" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong11:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-8-40)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong12", password: "Password(", device_id: "D12" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong12:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-9-41)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong13", password: "Password)", device_id: "D13" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong13:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-10-95)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong14", password: "Password_", device_id: "D14" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong14:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-11-43)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong15", password: "Password+", device_id: "D15" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong15:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-12-45)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong16", password: "Password-", device_id: "D16" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong16:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-13-61)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong17", password: "Password=", device_id: "D17" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong17:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-14-91)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong18", password: "Password[", device_id: "D18" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong18:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-15-93)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong19", password: "Password]", device_id: "D19" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong19:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-16-123)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong20", password: "Password{", device_id: "D20" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong20:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-17-125)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong21", password: "Password}", device_id: "D21" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong21:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-18-59)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong22", password: "Password;", device_id: "D22" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong22:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-19-39)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong23", password: "Password'", device_id: "D23" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong23:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-20-58)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong24", password: "Password:", device_id: "D24" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong24:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-21-34)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong25", password: "Password\"", device_id: "D25" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong25:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-22-124)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong26", password: "Password|", device_id: "D26" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong26:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-23-44)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong27", password: "Password,", device_id: "D27" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong27:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-24-46)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong28", password: "Password.", device_id: "D28" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong28:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-25-60)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong29", password: "Password<", device_id: "D29" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong29:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-26-62)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong30", password: "Password>", device_id: "D30" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong30:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-27-47)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong31", password: "Password/", device_id: "D31" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong31:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

  it('accepts strong password (special-28-63)', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: "strong32", password: "Password?", device_id: "D32" }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@strong32:${SERVER}`);
    expect(res.body.access_token).toMatch(/^syt_/);
  });

});


describe('register leftovers POST /register — success binds and inhibit_login', () => {
  it('persists user/device/token SQL binds and refresh KV', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: 'bindme', initial_device_display_name: 'Phone' }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@bindme:${SERVER}`);
    expect(res.body.device_id).toBe('REGDEV');
    expect(res.body.home_server).toBe(SERVER);
    expect(res.body.expires_in_ms).toBe(3_600_000);

    const userIns = db.inserts.filter((i) => i.sql.includes('INSERT INTO users'));
    expect(userIns).toHaveLength(1);
    expect(userIns[0].args[0]).toBe(`@bindme:${SERVER}`);
    expect(userIns[0].args[1]).toBe('bindme');
    expect(userIns[0].args[2]).toBe(`mockok:${STRONG_PW}`);
    expect(userIns[0].args[3]).toBe(0);

    const devIns = db.inserts.filter((i) => i.sql.includes('INSERT INTO devices'));
    expect(devIns[0].args.slice(0, 3)).toEqual([`@bindme:${SERVER}`, 'REGDEV', 'Phone']);
    expect(devIns[0].args[3]).toBe(NOW);

    const tokIns = db.inserts.filter((i) => i.sql.includes('INSERT INTO access_tokens'));
    expect(tokIns).toHaveLength(1);
    expect(tokIns[0].args[2]).toBe(`@bindme:${SERVER}`);
    expect(tokIns[0].args[3]).toBe('REGDEV');

    expect(sessions.puts).toHaveLength(1);
    expect(sessions.puts[0].key.startsWith('refresh:')).toBe(true);
    expect(sessions.puts[0].options?.expirationTtl).toBe(7 * 24 * 60 * 60);
    const payload = JSON.parse(sessions.puts[0].value);
    expect(payload.userId).toBe(`@bindme:${SERVER}`);
    expect(payload.deviceId).toBe('REGDEV');
    expect(payload.accessTokenId).toBeTruthy();
    expect(payload.createdAt).toBe(NOW);
  });

  it('inhibit_login true skips device/token/refresh', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: 'nologin', inhibit_login: true }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user_id: `@nologin:${SERVER}`, home_server: SERVER });
    expect(db.inserts.filter((i) => i.sql.includes('INSERT INTO devices'))).toHaveLength(0);
    expect(db.inserts.filter((i) => i.sql.includes('INSERT INTO access_tokens'))).toHaveLength(0);
    expect(sessions.puts).toHaveLength(0);
  });

  it('inhibit_login truthiness matrix', async () => {
    // Clarify: skipTokens = Boolean(inhibit_login)
    // true / 1 / 'true' → skip; false / 0 / null / '' / undefined → issue tokens
    const expectedSkip: Record<string, boolean> = {
      true: true,
      false: false,
      '1': true,
      '0': false,
      null: false,
      'undefined-omit': false,
      'empty-string': false,
      'string-true': true,
    };
    let i = 0;
    for (const [label, value] of [
      ['true', true],
      ['false', false],
      ['1', 1],
      ['0', 0],
      ['null', null],
      ['undefined-omit', undefined],
      ['empty-string', ''],
      ['string-true', 'true'],
    ] as Array<[string, unknown]>) {
      const db = createLoginDb();
      const sessions = mockKv();
      const env = loginEnv(db, sessions);
      const body = registerBody({ username: `inh${i}` });
      if (label !== 'undefined-omit') body.inhibit_login = value;
      else delete body.inhibit_login;
      const res = await loginRequest(env, '/_matrix/client/v3/register', jsonInit('POST', body, ''));
      expect(res.status).toBe(200);
      const skip = expectedSkip[label];
      if (skip) {
        expect(res.body.access_token).toBeUndefined();
        expect(sessions.puts).toHaveLength(0);
      } else {
        expect(res.body.access_token).toMatch(/^syt_/);
        expect(sessions.puts).toHaveLength(1);
      }
      i += 1;
    }
  });

  it('generates device_id when omitted or falsy', async () => {
    for (const [label, deviceId] of [
      ['omit', undefined],
      ['empty', ''],
      ['null', null],
    ] as Array<[string, unknown]>) {
      const env = loginEnv(createLoginDb());
      const body = registerBody({ username: `dev${label}` });
      if (label === 'omit') delete body.device_id;
      else body.device_id = deviceId;
      const res = await loginRequest(env, '/_matrix/client/v3/register', jsonInit('POST', body, ''));
      expect(res.status).toBe(200);
      expect(res.body.device_id).toMatch(/^GENDEV/);
    }
  });

  it('rejects existing user_id with M_USER_IN_USE', async () => {
    const existing = userRow({ user_id: `@taken:${SERVER}`, localpart: 'taken', password_hash: 'mockok:x' });
    const db = createLoginDb({ users: new Map([[existing.user_id, existing]]) });
    const env = loginEnv(db);
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: 'taken' }), '')
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_USER_IN_USE');
  });

  it('requires username and password after UIA for non-guest', async () => {
    const env = loginEnv(createLoginDb());
    const r1 = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', { auth: { type: 'm.login.dummy' }, password: STRONG_PW }, '')
    );
    expect(r1.status).toBe(400);
    expect(r1.body.errcode).toBe('M_MISSING_PARAM');

    const r2 = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', { auth: { type: 'm.login.dummy' }, username: 'nopw' }, '')
    );
    expect(r2.status).toBe(400);
    expect(r2.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('rejects invalid username after UIA', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: 'Bad Name' }), '')
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_USERNAME');
  });

  it('guest with provided password hashes without strength check', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', { password: 'x', device_id: 'G1' }, '')
    );
    expect(res.status).toBe(200);
    const userIns = db.inserts.find((i) => i.sql.includes('INSERT INTO users'))!;
    expect(userIns.args[2]).toBe('mockok:x');
    expect(userIns.args[3]).toBe(1);
  });

  it('guest inhibit_login returns only user_id and home_server', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', { inhibit_login: true }, '')
    );
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeUndefined();
    expect(res.body.home_server).toBe(SERVER);
    expect(res.body.user_id).toMatch(/^@opaque/);
  });

  it('guest ignores username and uses opaque localpart', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', { username: 'ignored', password: STRONG_PW, device_id: 'G2' }, '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).not.toBe(`@ignored:${SERVER}`);
    const userIns = db.inserts.find((i) => i.sql.includes('INSERT INTO users'))!;
    expect(userIns.args[1]).not.toBe('ignored');
  });

  it('uses SERVER_NAME from env for formatted user id', async () => {
    const db = createLoginDb();
    const env = loginEnv(db, mockKv(), 'matrix.fuzzy.test');
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: 'domainuser' }), '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe('@domainuser:matrix.fuzzy.test');
    expect(res.body.home_server).toBe('matrix.fuzzy.test');
  });

  it('hashes password via hashPassword mock', async () => {
    const env = loginEnv(createLoginDb());
    await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: 'hashchk', password: 'Secure9!' }), '')
    );
    expect(vi.mocked(hashPassword)).toHaveBeenCalledWith('Secure9!');
  });
});


describe('register leftovers whoami account surface', () => {
  it('returns user_id device_id is_guest for existing user', async () => {
    const db = createLoginDb({
      users: new Map([[USER, userRow({ user_id: USER, localpart: 'alice', is_guest: 0 })]]),
    });
    const env = loginEnv(db);
    const res = await loginRequest(env, '/_matrix/client/v3/account/whoami');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user_id: USER, device_id: DEVICE, is_guest: false });
  });

  it('returns is_guest true for guest accounts', async () => {
    const db = createLoginDb({
      users: new Map([[USER, userRow({ user_id: USER, localpart: 'alice', is_guest: 1 })]]),
    });
    const env = loginEnv(db);
    const res = await loginRequest(env, '/_matrix/client/v3/account/whoami');
    expect(res.status).toBe(200);
    expect(res.body.is_guest).toBe(true);
  });

  it('returns M_UNKNOWN_TOKEN when user row missing', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(env, '/_matrix/client/v3/account/whoami');
    expect(res.status).toBe(401);
    expect(res.body.errcode).toBe('M_UNKNOWN_TOKEN');
  });

  it('passes through null device_id from middleware', async () => {
    authState.deviceId = null;
    const db = createLoginDb({
      users: new Map([[USER, userRow({ user_id: USER, localpart: 'alice' })]]),
    });
    const env = loginEnv(db);
    const res = await loginRequest(env, '/_matrix/client/v3/account/whoami');
    expect(res.status).toBe(200);
    expect(res.body.device_id).toBeNull();
  });
});


describe('register leftovers available→register→login lifecycle', () => {
  it('available then register then password login', async () => {
    const db = createLoginDb();
    const sessions = mockKv();
    const env = loginEnv(db, sessions);

    const avail = await loginRequest(env, '/_matrix/client/v3/register/available?username=lifecycle');
    expect(avail.body).toEqual({ available: true });

    const reg = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: 'lifecycle', password: 'LifeCycle1!', device_id: 'L1' }), '')
    );
    expect(reg.status).toBe(200);
    expect(reg.body.user_id).toBe(`@lifecycle:${SERVER}`);

    const avail2 = await loginRequest(env, '/_matrix/client/v3/register/available?username=lifecycle');
    expect(avail2.body.errcode).toBe('M_USER_IN_USE');

    const loginRes = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'lifecycle' },
          password: 'LifeCycle1!',
          device_id: 'L2',
        },
        ''
      )
    );
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user_id).toBe(`@lifecycle:${SERVER}`);
    expect(loginRes.body.access_token).toMatch(/^syt_/);
  });

  it('register with inhibit_login then password login works', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        registerBody({ username: 'laterlogin', password: 'LaterLogin1!', inhibit_login: true }),
        ''
      )
    );
    const loginRes = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'laterlogin' },
          password: 'LaterLogin1!',
        },
        ''
      )
    );
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.device_id).toMatch(/^GENDEV/);
  });
});


describe('account leftovers registration_token validity', () => {
  it('requires token query param', async () => {
    const env = accountEnv();
    const res = await accountRequest(env, '/_matrix/client/v1/register/m.login.registration_token/validity');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('empty token is missing', async () => {
    const env = accountEnv();
    const res = await accountRequest(
      env,
      '/_matrix/client/v1/register/m.login.registration_token/validity?token='
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });


  it('always returns valid:false for token case-0', async () => {
    const env = accountEnv();
    const res = await accountRequest(
      env,
      `/_matrix/client/v1/register/m.login.registration_token/validity?token=${encodeURIComponent("abc")}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false });
  });

  it('always returns valid:false for token case-1', async () => {
    const env = accountEnv();
    const res = await accountRequest(
      env,
      `/_matrix/client/v1/register/m.login.registration_token/validity?token=${encodeURIComponent("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false });
  });

  it('always returns valid:false for token case-2', async () => {
    const env = accountEnv();
    const res = await accountRequest(
      env,
      `/_matrix/client/v1/register/m.login.registration_token/validity?token=${encodeURIComponent("tok with space")}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false });
  });

  it('always returns valid:false for token case-3', async () => {
    const env = accountEnv();
    const res = await accountRequest(
      env,
      `/_matrix/client/v1/register/m.login.registration_token/validity?token=${encodeURIComponent("\ud83c\udfab")}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false });
  });

  it('always returns valid:false for token case-4', async () => {
    const env = accountEnv();
    const res = await accountRequest(
      env,
      `/_matrix/client/v1/register/m.login.registration_token/validity?token=${encodeURIComponent("null")}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false });
  });

  it('always returns valid:false for token case-5', async () => {
    const env = accountEnv();
    const res = await accountRequest(
      env,
      `/_matrix/client/v1/register/m.login.registration_token/validity?token=${encodeURIComponent("0")}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false });
  });

  it('always returns valid:false for token case-6', async () => {
    const env = accountEnv();
    const res = await accountRequest(
      env,
      `/_matrix/client/v1/register/m.login.registration_token/validity?token=${encodeURIComponent("true")}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false });
  });

  it('always returns valid:false for token case-7', async () => {
    const env = accountEnv();
    const res = await accountRequest(
      env,
      `/_matrix/client/v1/register/m.login.registration_token/validity?token=${encodeURIComponent("../etc")}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false });
  });

  it('always returns valid:false for token case-8', async () => {
    const env = accountEnv();
    const res = await accountRequest(
      env,
      `/_matrix/client/v1/register/m.login.registration_token/validity?token=${encodeURIComponent("%00")}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false });
  });

  it('always returns valid:false for token case-9', async () => {
    const env = accountEnv();
    const res = await accountRequest(
      env,
      `/_matrix/client/v1/register/m.login.registration_token/validity?token=${encodeURIComponent("a/b")}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false });
  });

});


describe('account leftovers password UIA and logout_devices', () => {
  it('rejects weak new passwords before UIA', async () => {
    const env = accountEnv();
    for (const pw of ['short', '12345678!', 'OnlyLetters', 'A1' + 'x'.repeat(999)]) {
      const res = await accountRequest(
        env,
        '/_matrix/client/v3/account/password',
        jsonInit('POST', { new_password: pw })
      );
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_WEAK_PASSWORD');
    }
  });

  it('returns UIA challenge shape when auth missing', async () => {
    const env = accountEnv();
    const res = await accountRequest(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', { new_password: STRONG_PW })
    );
    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.password'] }]);
    expect(res.body.params).toEqual({});
    expect(typeof res.body.session).toBe('string');
  });

  it('updates hash and deletes tokens by default', async () => {
    const db = createAccountDb();
    const env = accountEnv(db);
    const res = await accountRequest(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', { new_password: STRONG_PW, auth: passwordAuth() })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.users.get(USER)!.password_hash).toBe(`mockok:${STRONG_PW}`);
    expect(db.tokens).toHaveLength(0);
  });

  it('retains tokens when logout_devices is false', async () => {
    const db = createAccountDb();
    const env = accountEnv(db);
    const res = await accountRequest(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', { new_password: STRONG_PW, logout_devices: false, auth: passwordAuth() })
    );
    expect(res.status).toBe(200);
    expect(db.tokens).toHaveLength(2);
  });

  it('logout_devices truthiness: 0 keeps tokens, 1 deletes', async () => {
    const db0 = createAccountDb();
    const env0 = accountEnv(db0);
    await accountRequest(
      env0,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', { new_password: STRONG_PW, logout_devices: 0, auth: passwordAuth() })
    );
    expect(db0.tokens).toHaveLength(2);

    const db1 = createAccountDb();
    const env1 = accountEnv(db1);
    await accountRequest(
      env1,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', { new_password: 'OtherPass1!', logout_devices: 1, auth: passwordAuth() })
    );
    expect(db1.tokens).toHaveLength(0);
  });

  it('forbids wrong current password', async () => {
    const env = accountEnv();
    const res = await accountRequest(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', { new_password: STRONG_PW, auth: passwordAuth('wrong') })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('password email/msisdn stubs return M_THREEPID_NOT_FOUND', async () => {
    const env = accountEnv();
    const email = await accountRequest(
      env,
      '/_matrix/client/v3/account/password/email/requestToken',
      jsonInit('POST', { email: 'a@b.co', client_secret: 's', send_attempt: 1 }, '')
    );
    expect(email.status).toBe(400);
    expect(email.body.errcode).toBe('M_THREEPID_NOT_FOUND');
    const phone = await accountRequest(
      env,
      '/_matrix/client/v3/account/password/msisdn/requestToken',
      jsonInit('POST', { phone: '+1', client_secret: 's', send_attempt: 1 }, '')
    );
    expect(phone.status).toBe(400);
    expect(phone.body.errcode).toBe('M_THREEPID_NOT_FOUND');
  });
});


describe('account leftovers deactivate erase matrix', () => {
  it('deactivates without erase leaves profile and rooms', async () => {
    const db = createAccountDb({
      memberships: [
        { room_id: '!r1:example.com', user_id: USER, membership: 'join' },
        { room_id: '!r2:example.com', user_id: USER, membership: 'invite' },
      ],
    });
    const env = accountEnv(db);
    const res = await accountRequest(
      env,
      '/_matrix/client/v3/account/deactivate',
      jsonInit('POST', { erase: false, auth: passwordAuth() })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id_server_unbind_result: 'no-support' });
    expect(db.users.get(USER)!.is_deactivated).toBe(1);
    expect(db.users.get(USER)!.display_name).toBe('Alice');
    expect(db.memberships[0].membership).toBe('join');
    expect(db.tokens).toHaveLength(0);
  });

  it('erase clears profile and leaves joined rooms only', async () => {
    const db = createAccountDb({
      memberships: [
        { room_id: '!r1:example.com', user_id: USER, membership: 'join' },
        { room_id: '!r2:example.com', user_id: USER, membership: 'invite' },
        { room_id: '!r3:example.com', user_id: USER, membership: 'leave' },
      ],
    });
    const env = accountEnv(db);
    const res = await accountRequest(
      env,
      '/_matrix/client/v3/account/deactivate',
      jsonInit('POST', { erase: true, auth: passwordAuth() })
    );
    expect(res.status).toBe(200);
    expect(db.users.get(USER)!.display_name).toBeNull();
    expect(db.users.get(USER)!.avatar_url).toBeNull();
    expect(db.memberships.find((m) => m.room_id === '!r1:example.com')!.membership).toBe('leave');
    expect(db.memberships.find((m) => m.room_id === '!r2:example.com')!.membership).toBe('invite');
  });

  it('erase:0 is falsy and does not erase', async () => {
    const db = createAccountDb();
    const env = accountEnv(db);
    await accountRequest(
      env,
      '/_matrix/client/v3/account/deactivate',
      jsonInit('POST', { erase: 0, auth: passwordAuth() })
    );
    expect(db.users.get(USER)!.display_name).toBe('Alice');
  });

  it('invalid JSON body treated as empty → UIA', async () => {
    const env = accountEnv();
    const res = await accountRequest(env, '/_matrix/client/v3/account/deactivate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: '{bad',
    });
    expect(res.status).toBe(401);
    expect(res.body.flows[0].stages).toEqual(['m.login.password']);
  });

  it('allows deactivate when no password hash set', async () => {
    const db = createAccountDb({
      users: new Map([
        [USER, { user_id: USER, password_hash: null, is_deactivated: 0, display_name: 'A', avatar_url: null }],
      ]),
    });
    const env = accountEnv(db);
    const res = await accountRequest(
      env,
      '/_matrix/client/v3/account/deactivate',
      jsonInit('POST', { auth: { type: 'm.login.password', session: 's' } })
    );
    expect(res.status).toBe(200);
    expect(db.users.get(USER)!.is_deactivated).toBe(1);
  });
});


describe('account leftovers 3pid list/add/delete', () => {
  it('lists empty threepids', async () => {
    const env = accountEnv();
    const res = await accountRequest(env, '/_matrix/client/v3/account/3pid');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ threepids: [] });
  });

  it('maps threepid rows for authenticated user only', async () => {
    const db = createAccountDb({
      threepids: [
        { user_id: USER, medium: 'email', address: 'a@ex.com', validated_at: 1, added_at: 2 },
        { user_id: '@bob:example.com', medium: 'email', address: 'b@ex.com', validated_at: 3, added_at: 4 },
        { user_id: USER, medium: 'msisdn', address: '+1555', validated_at: 5, added_at: 6 },
      ],
    });
    const env = accountEnv(db);
    const res = await accountRequest(env, '/_matrix/client/v3/account/3pid');
    expect(res.status).toBe(200);
    expect(res.body.threepids).toEqual([
      { medium: 'email', address: 'a@ex.com', validated_at: 1, added_at: 2 },
      { medium: 'msisdn', address: '+1555', validated_at: 5, added_at: 6 },
    ]);
  });

  it('add requires client_secret and sid then UIA', async () => {
    const env = accountEnv();
    const missing = await accountRequest(
      env,
      '/_matrix/client/v3/account/3pid/add',
      jsonInit('POST', { client_secret: 'sec' })
    );
    expect(missing.body.errcode).toBe('M_MISSING_PARAM');

    const uia = await accountRequest(
      env,
      '/_matrix/client/v3/account/3pid/add',
      jsonInit('POST', { client_secret: 'sec', sid: 'sid1' })
    );
    expect(uia.status).toBe(401);
    expect(uia.body.flows[0].stages).toEqual(['m.login.password']);
  });

  it('add succeeds with validated session and cleans up', async () => {
    const db = createAccountDb();
    const env = accountEnv(db);
    emailMocks.getValidatedSession.mockResolvedValueOnce({ email: 'new@example.com' });
    const res = await accountRequest(
      env,
      '/_matrix/client/v3/account/3pid/add',
      jsonInit('POST', { client_secret: 'sec', sid: 'sid1', auth: passwordAuth() })
    );
    expect(res.status).toBe(200);
    expect(db.threepids.some((t) => t.address === 'new@example.com')).toBe(true);
    expect(db.deletes.some((d) => d.sql.includes('email_verification_sessions'))).toBe(true);
  });

  it('add returns M_THREEPID_IN_USE when bound to another user', async () => {
    const db = createAccountDb({
      threepids: [
        {
          user_id: '@bob:example.com',
          medium: 'email',
          address: 'taken@example.com',
          validated_at: 1,
          added_at: 1,
        },
      ],
    });
    const env = accountEnv(db);
    emailMocks.getValidatedSession.mockResolvedValueOnce({ email: 'taken@example.com' });
    const res = await accountRequest(
      env,
      '/_matrix/client/v3/account/3pid/add',
      jsonInit('POST', { client_secret: 'sec', sid: 'sid1', auth: passwordAuth() })
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_THREEPID_IN_USE');
  });

  it('delete requires medium and address and binds DELETE', async () => {
    const db = createAccountDb({
      threepids: [
        { user_id: USER, medium: 'email', address: 'del@ex.com', validated_at: 1, added_at: 1 },
      ],
    });
    const env = accountEnv(db);
    const bad = await accountRequest(
      env,
      '/_matrix/client/v3/account/3pid/delete',
      jsonInit('POST', { medium: 'email' })
    );
    expect(bad.body.errcode).toBe('M_MISSING_PARAM');

    const ok = await accountRequest(
      env,
      '/_matrix/client/v3/account/3pid/delete',
      jsonInit('POST', { medium: 'email', address: 'del@ex.com' })
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ id_server_unbind_result: 'no-support' });
    expect(db.threepids).toHaveLength(0);
    expect(db.deletes[0].args).toEqual([USER, 'email', 'del@ex.com']);
  });

  it('bind and unbind stubs', async () => {
    const env = accountEnv();
    const bind = await accountRequest(env, '/_matrix/client/v3/account/3pid/bind', jsonInit('POST', {}));
    expect(bind.status).toBe(400);
    expect(bind.body.errcode).toBe('M_THREEPID_AUTH_FAILED');
    const unbind = await accountRequest(env, '/_matrix/client/v3/account/3pid/unbind', jsonInit('POST', {}));
    expect(unbind.status).toBe(200);
    expect(unbind.body).toEqual({ id_server_unbind_result: 'no-support' });
  });

  it('msisdn requestToken denied', async () => {
    const env = accountEnv();
    const res = await accountRequest(
      env,
      '/_matrix/client/v3/account/3pid/msisdn/requestToken',
      jsonInit('POST', {}, '')
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_THREEPID_DENIED');
  });
});


describe('account leftovers email requestToken + submit_token', () => {
  it('requires client_secret email send_attempt', async () => {
    const env = accountEnv();
    const r1 = await accountRequest(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', { email: 'a@b.co', send_attempt: 1 }, '')
    );
    expect(r1.body.errcode).toBe('M_MISSING_PARAM');
    const r2 = await accountRequest(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', { client_secret: 's', send_attempt: 1 }, '')
    );
    expect(r2.body.errcode).toBe('M_MISSING_PARAM');
    const r3 = await accountRequest(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', { client_secret: 's', email: 'a@b.co' }, '')
    );
    expect(r3.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('rejects invalid email formats', async () => {
    const env = accountEnv();
    for (const email of ['plain', 'a@', '@b.co', 'a b@c.co', 'a@b']) {
      const res = await accountRequest(
        env,
        '/_matrix/client/v3/account/3pid/email/requestToken',
        jsonInit('POST', { client_secret: 's', email, send_attempt: 0 }, '')
      );
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_INVALID_EMAIL');
    }
  });

  it('send_attempt 0 is allowed (only undefined missing)', async () => {
    const env = accountEnv();
    const res = await accountRequest(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', { client_secret: 's', email: 'ok@example.com', send_attempt: 0 }, '')
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sid: 'sid-new' });
  });

  it('returns M_THREEPID_IN_USE when email already bound', async () => {
    const db = createAccountDb({
      threepids: [
        { user_id: USER, medium: 'email', address: 'used@example.com', validated_at: 1, added_at: 1 },
      ],
    });
    const env = accountEnv(db);
    const res = await accountRequest(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', { client_secret: 's', email: 'used@example.com', send_attempt: 1 }, '')
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_THREEPID_IN_USE');
  });

  it('cleans up session when email send fails', async () => {
    const db = createAccountDb();
    const env = accountEnv(db);
    emailMocks.createVerificationSession.mockResolvedValueOnce({ sessionId: 'sid-fail', token: '111' });
    emailMocks.sendVerificationEmail.mockResolvedValueOnce({ success: false, error: 'smtp down' });
    const res = await accountRequest(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', { client_secret: 's', email: 'fail@example.com', send_attempt: 1 }, '')
    );
    expect(res.status).toBe(500);
    expect(res.body.errcode).toBe('M_THREEPID_DENIED');
    expect(db.deletes.some((d) => d.args[0] === 'sid-fail')).toBe(true);
  });

  it('retry with empty token skips send and returns sid', async () => {
    const env = accountEnv();
    emailMocks.createVerificationSession.mockResolvedValueOnce({ sessionId: 'sid-retry', token: '' });
    const res = await accountRequest(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', { client_secret: 's', email: 'retry@example.com', send_attempt: 2 }, '')
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sid: 'sid-retry' });
    expect(emailMocks.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('POST submit_token success and failure', async () => {
    const env = accountEnv();
    const ok = await accountRequest(
      env,
      '/_matrix/client/v3/account/3pid/submit_token',
      jsonInit('POST', { sid: 's', client_secret: 'c', token: 't' }, '')
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ success: true });

    emailMocks.validateEmailToken.mockResolvedValueOnce({ success: false, error: 'bad' });
    const bad = await accountRequest(
      env,
      '/_matrix/client/v3/account/3pid/submit_token',
      jsonInit('POST', { sid: 's', client_secret: 'c', token: 't' }, '')
    );
    expect(bad.status).toBe(400);
    expect(bad.body.errcode).toBe('M_THREEPID_AUTH_FAILED');
  });

  it('GET submit_token requires query params and validates', async () => {
    const env = accountEnv();
    const missing = await accountRequest(env, '/_matrix/client/v3/account/3pid/submit_token');
    expect(missing.body.errcode).toBe('M_MISSING_PARAM');
    const ok = await accountRequest(
      env,
      '/_matrix/client/v3/account/3pid/submit_token?sid=s&client_secret=c&token=t'
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ success: true });
  });
});


describe('account leftovers openid request_token', () => {
  it('forbids requesting token for another user', async () => {
    const env = accountEnv();
    const res = await accountRequest(
      env,
      '/_matrix/client/v3/user/%40bob%3Aexample.com/openid/request_token',
      jsonInit('POST', {})
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('issues openid token into CACHE with 3600 TTL', async () => {
    const cache = mockKv();
    const env = accountEnv(undefined, cache);
    const res = await accountRequest(
      env,
      `/_matrix/client/v3/user/${encodeURIComponent(USER)}/openid/request_token`,
      jsonInit('POST', {})
    );
    expect(res.status).toBe(200);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.matrix_server_name).toBe(SERVER);
    expect(res.body.expires_in).toBe(3600);
    expect(typeof res.body.access_token).toBe('string');
    expect(cache.puts).toHaveLength(1);
    expect(cache.puts[0].key).toBe(`openid_token:${res.body.access_token}`);
    expect(cache.puts[0].options?.expirationTtl).toBe(3600);
    const payload = JSON.parse(cache.puts[0].value);
    expect(payload.user_id).toBe(USER);
    expect(payload.created_at).toBe(NOW);
    expect(payload.expires_at).toBe(NOW + 3600_000);
  });

  it('issues distinct tokens on successive calls', async () => {
    const cache = mockKv();
    const env = accountEnv(undefined, cache);
    const path = `/_matrix/client/v3/user/${encodeURIComponent(USER)}/openid/request_token`;
    const a = await accountRequest(env, path, jsonInit('POST', {}));
    const b = await accountRequest(env, path, jsonInit('POST', {}));
    expect(a.body.access_token).not.toBe(b.body.access_token);
    expect(cache.puts).toHaveLength(2);
  });
});


describe('register+account leftovers soft-cap lifecycles', () => {
  it('register user then change password then whoami still works', async () => {
    const loginDb = createLoginDb();
    const sessions = mockKv();
    const lenv = loginEnv(loginDb, sessions);
    const reg = await loginRequest(
      lenv,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: 'alice', password: CURRENT_PW, device_id: DEVICE }), '')
    );
    // alice may collide if we seed — createLoginDb empty so ok, but whoami middleware is alice
    expect(reg.status).toBe(200);

    const accountDb = createAccountDb({
      users: new Map([
        [
          USER,
          {
            user_id: USER,
            password_hash: `mockok:${CURRENT_PW}`,
            is_deactivated: 0,
            display_name: 'Alice',
            avatar_url: null,
          },
        ],
      ]),
    });
    const aenv = accountEnv(accountDb);
    const pw = await accountRequest(
      aenv,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', { new_password: 'BrandNew1!', logout_devices: false, auth: passwordAuth() })
    );
    expect(pw.status).toBe(200);

    const who = await loginRequest(lenv, '/_matrix/client/v3/account/whoami');
    expect(who.status).toBe(200);
    expect(who.body.user_id).toBe(USER);
  });

  it('registration_token always false while register/available still works', async () => {
    const aenv = accountEnv();
    const tok = await accountRequest(
      aenv,
      '/_matrix/client/v1/register/m.login.registration_token/validity?token=invite'
    );
    expect(tok.body).toEqual({ valid: false });
    const lenv = loginEnv(createLoginDb());
    const avail = await loginRequest(lenv, '/_matrix/client/v3/register/available?username=stillok');
    expect(avail.body).toEqual({ available: true });
  });

  it('openid token path decodeURIComponent for userId param', async () => {
    const env = accountEnv();
    // raw @ in path without encoding — Hono may still match
    const res = await accountRequest(
      env,
      '/_matrix/client/v3/user/@alice:example.com/openid/request_token',
      jsonInit('POST', {})
    );
    expect(res.status).toBe(200);
    expect(res.body.matrix_server_name).toBe(SERVER);
  });
});


describe('register leftovers POST /register — body edge leftovers', () => {
  it('rejects empty-string username and password after UIA', async () => {
    const env = loginEnv(createLoginDb());
    const r1 = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: '' }), '')
    );
    expect(r1.body.errcode).toBe('M_MISSING_PARAM');
    const r2 = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: 'emptypw', password: '' }), '')
    );
    expect(r2.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('rejects null password as missing', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: 'nullpw', password: null }), '')
    );
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('array body yields undefined fields → UIA for non-guest', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(env, '/_matrix/client/v3/register', jsonInit('POST', [], ''));
    expect(res.status).toBe(401);
  });

  it('stores unicode initial_device_display_name', async () => {
    const db = createLoginDb();
    const env = loginEnv(db);
    const name = '📱 Element — テスト';
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: 'unicodedisp', initial_device_display_name: name }), '')
    );
    expect(res.status).toBe(200);
    expect(db.devices[0].display_name).toBe(name);
  });

  it('ignores unknown extra registration fields', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit(
        'POST',
        registerBody({ username: 'extrafields', refresh_token: 'nope', admin: true, foo: 1 }),
        ''
      )
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@extrafields:${SERVER}`);
  });
});


describe('register leftovers available query encoding', () => {

  it('query encodes localpart (dot)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a.b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });

  it('query encodes localpart (underscore)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a_b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });

  it('query encodes localpart (dash)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a-b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });

  it('query encodes localpart (slash-encoded)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a/b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });

  it('query encodes localpart (equals)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "a=b";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });

  it('query encodes localpart (digits)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "12345";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });

  it('query encodes localpart (mixed)', async () => {
    const env = loginEnv(createLoginDb());
    const username = "u.s_e-r=1/x";
    const res = await loginRequest(
      env,
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });

});
