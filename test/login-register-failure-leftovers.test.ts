/**
 * TOKENMAXX HEAVY leftovers after #139 — login/register/whoami failure + reliability edges.
 * Complements register-account-api-route-leftovers + login-api-routes. Tests-only.
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


describe('login leftovers register/available failure matrix after #139', () => {
  it('missing username → M_MISSING_PARAM', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(env, '/_matrix/client/v3/register/available');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('empty username → M_MISSING_PARAM', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(env, '/_matrix/client/v3/register/available?username=');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  for (const u of ['Alice', 'a b', 'a@b', 'a:b', 'a+b', 'üser', '😀']) {
    it(`invalid username ${JSON.stringify(u)}`, async () => {
      const env = loginEnv(createLoginDb());
      const res = await loginRequest(
        env,
        `/_matrix/client/v3/register/available?username=${encodeURIComponent(u)}`
      );
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_INVALID_USERNAME');
    });
  }

  it('existing localpart → M_USER_IN_USE', async () => {
    const db = createLoginDb({
      users: new Map([[USER, userRow({ user_id: USER, localpart: 'alice' })]]),
    });
    const res = await loginRequest(loginEnv(db), '/_matrix/client/v3/register/available?username=alice');
    expect(res.body.errcode).toBe('M_USER_IN_USE');
  });
});

describe('login leftovers POST /register failure matrix after #139', () => {
  it('bad JSON → M_BAD_JSON', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(env, '/_matrix/client/v3/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('invalid kind → M_INVALID_PARAM', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register?kind=admin',
      jsonInit('POST', registerBody({ username: 'x' }), '')
    );
    expect(res.body.errcode).toBe('M_INVALID_PARAM');
  });

  it('missing auth → UIA 401', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', { username: 'newuser', password: STRONG_PW }, '')
    );
    expect(res.status).toBe(401);
    expect(res.body.flows[0].stages).toEqual(['m.login.dummy']);
  });

  it('weak password → M_WEAK_PASSWORD', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: 'weakling', password: 'short' }), '')
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_WEAK_PASSWORD');
  });

  it('duplicate user → M_USER_IN_USE', async () => {
    const db = createLoginDb({
      users: new Map([[USER, userRow({ user_id: USER, localpart: 'alice' })]]),
    });
    const res = await loginRequest(
      loginEnv(db),
      '/_matrix/client/v3/register',
      jsonInit('POST', registerBody({ username: 'alice' }), '')
    );
    expect(res.body.errcode).toBe('M_USER_IN_USE');
  });
});

describe('login leftovers whoami failure/reliability after #139', () => {
  it('missing user row → M_UNKNOWN_TOKEN', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(env, '/_matrix/client/v3/account/whoami');
    expect(res.status).toBe(401);
    expect(res.body.errcode).toBe('M_UNKNOWN_TOKEN');
  });

  it('returns is_guest false/true correctly', async () => {
    const db = createLoginDb({
      users: new Map([[USER, userRow({ user_id: USER, localpart: 'alice', is_guest: 0 })]]),
    });
    let res = await loginRequest(loginEnv(db), '/_matrix/client/v3/account/whoami');
    expect(res.body).toEqual({ user_id: USER, device_id: DEVICE, is_guest: false });
    db.users.set(USER, userRow({ user_id: USER, localpart: 'alice', is_guest: 1 }));
    res = await loginRequest(loginEnv(db), '/_matrix/client/v3/account/whoami');
    expect(res.body.is_guest).toBe(true);
  });

  it('null deviceId from middleware passes through', async () => {
    authState.deviceId = null;
    const db = createLoginDb({
      users: new Map([[USER, userRow({ user_id: USER, localpart: 'alice' })]]),
    });
    const res = await loginRequest(loginEnv(db), '/_matrix/client/v3/account/whoami');
    expect(res.body.device_id).toBeNull();
    authState.deviceId = DEVICE;
  });
});

describe('login leftovers password login failure edges after #139', () => {
  it('unknown type → M_UNRECOGNIZED', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.sso' }, '')
    );
    expect(res.body.errcode).toBe('M_UNRECOGNIZED');
  });

  it('missing password → M_MISSING_PARAM', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.password', identifier: { type: 'm.id.user', user: 'alice' } }, '')
    );
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('wrong password increments lockout', async () => {
    const db = createLoginDb({
      users: new Map([
        [USER, userRow({ user_id: USER, localpart: 'alice', password_hash: 'mockok:secret' })],
      ]),
    });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'alice' },
          password: 'wrong',
        },
        ''
      )
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    const lockKey = Object.keys(sessions.data).find((k) => k.startsWith('lockout:'));
    expect(lockKey).toBeTruthy();
    expect(JSON.parse(sessions.data[lockKey!]).attempts).toBe(1);
  });
});

describe('login leftovers refresh failure edges after #139', () => {
  it('missing refresh_token → M_MISSING_PARAM', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(env, '/_matrix/client/v3/refresh', jsonInit('POST', {}, ''));
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('unknown refresh_token → M_UNKNOWN_TOKEN', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: 'syr_missing' }, '')
    );
    expect(res.body.errcode).toBe('M_UNKNOWN_TOKEN');
  });
});


describe('login leftovers get_token + token login failures after #139', () => {
  it('get_token stores hashed login_token with 120s TTL', async () => {
    const db = createLoginDb({
      users: new Map([[USER, userRow({ user_id: USER, localpart: 'alice' })]]),
    });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    const res = await loginRequest(env, '/_matrix/client/v1/login/get_token', jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body.expires_in_ms).toBe(120_000);
    expect(sessions.puts).toHaveLength(1);
    expect(sessions.puts[0].key.startsWith('login_token:')).toBe(true);
    expect(sessions.puts[0].options?.expirationTtl).toBe(120);
  });

  it('token login missing token → M_MISSING_PARAM', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token' }, '')
    );
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('token login unknown token → M_FORBIDDEN', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: 'nope' }, '')
    );
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });
});

describe('login leftovers lockout reliability after #139', () => {
  it('locks after 5 failures with M_LIMIT_EXCEEDED', async () => {
    const db = createLoginDb({
      users: new Map([
        [USER, userRow({ user_id: USER, localpart: 'alice', password_hash: 'mockok:secret' })],
      ]),
    });
    const sessions = mockKv();
    const env = loginEnv(db, sessions);
    for (let i = 0; i < 5; i++) {
      await loginRequest(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: 'bad',
          },
          ''
        )
      );
    }
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'alice' },
          password: 'secret',
        },
        ''
      )
    );
    expect(res.status).toBe(429);
    expect(res.body.errcode).toBe('M_LIMIT_EXCEEDED');
    expect(typeof res.body.retry_after_ms).toBe('number');
  });

  it('deactivated user → M_USER_DEACTIVATED', async () => {
    const db = createLoginDb({
      users: new Map([
        [
          USER,
          userRow({
            user_id: USER,
            localpart: 'alice',
            password_hash: 'mockok:secret',
            is_deactivated: 1,
          }),
        ],
      ]),
    });
    const res = await loginRequest(
      loginEnv(db),
      '/_matrix/client/v3/login',
      jsonInit(
        'POST',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'alice' },
          password: 'secret',
        },
        ''
      )
    );
    expect(res.body.errcode).toBe('M_USER_DEACTIVATED');
  });
});

describe('login leftovers guest register reliability after #139', () => {
  it('guest skips UIA and issues tokens', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', {}, '')
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toMatch(/^@opaque/);
    expect(res.body.access_token).toMatch(/^syt_/);
    expect(res.body.refresh_token).toMatch(/^syr_/);
  });

  it('guest inhibit_login returns only user_id/home_server', async () => {
    const env = loginEnv(createLoginDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register?kind=guest',
      jsonInit('POST', { inhibit_login: true }, '')
    );
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeUndefined();
    expect(res.body.home_server).toBe(SERVER);
  });
});
