/**
 * TOKENMAXX HEAVY deepen — different slice: account management API routes.
 * Avoids keys (#94/#96), oauth (#90), spaces (#89), devices/aliases siblings.
 * Tests-only — no product inventing.
 * Exercises password change, deactivate, 3PID CRUD, email verify, openid tokens.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    hashPassword: vi.fn(async (password: string) => `hashed:${password}`),
  };
});

vi.mock('../src/utils/ids', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ids')>();
  return {
    ...actual,
    generateOpaqueId: vi.fn(async () => 'pinned-uia-session-16'),
  };
});

const {
  sendVerificationEmail,
  createVerificationSession,
  validateEmailToken,
  getValidatedSession,
} = vi.hoisted(() => ({
  sendVerificationEmail: vi.fn(),
  createVerificationSession: vi.fn(),
  validateEmailToken: vi.fn(),
  getValidatedSession: vi.fn(),
}));

vi.mock('../src/services/email', () => ({
  sendVerificationEmail,
  createVerificationSession,
  validateEmailToken,
  getValidatedSession,
}));

import accountApp from '../src/api/account';
import { hashPassword, verifyPassword } from '../src/utils/crypto';
import { generateOpaqueId } from '../src/utils/ids';

const USER = '@alice:example.com';
const SERVER = 'example.com';
const BOB = '@bob:example.com';
const DEVICE = 'DEVICEA';
const UIA_SESSION = 'pinned-uia-session-16';
const STRONG_NEW = 'NewPass99!';
const CURRENT_PW = 'OldPass99!';
const CURRENT_HASH = `mockok:${CURRENT_PW}`;

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
    },
  };
  return kv as unknown as KVNamespace & {
    data: Record<string, string>;
    puts: KvPut[];
    deletes: string[];
  };
}

type ThreepidRow = {
  user_id: string;
  medium: string;
  address: string;
  validated_at: number;
  added_at: number;
};

type MembershipRow = { room_id: string; user_id: string; membership: string };

type UserRow = {
  user_id: string;
  password_hash: string | null;
  is_deactivated: number;
  display_name: string | null;
  avatar_url: string | null;
};

type SqlCall = { sql: string; args: unknown[] };

function createAccountDb(opts: {
  passwordHash?: string | null;
  missingUser?: boolean;
  users?: UserRow[];
  threepids?: ThreepidRow[];
  memberships?: MembershipRow[];
  deletedTokens?: string[];
} = {}) {
  const passwordHash =
    opts.passwordHash === undefined ? CURRENT_HASH : opts.passwordHash;
  const missingUser = opts.missingUser ?? false;

  const users: UserRow[] =
    opts.users ??
    (missingUser
      ? []
      : [
          {
            user_id: USER,
            password_hash: passwordHash,
            is_deactivated: 0,
            display_name: 'Alice',
            avatar_url: 'mxc://example.com/avatar',
          },
        ]);

  const threepids = opts.threepids ?? [];
  const memberships = opts.memberships ?? [];
  const deletedTokens = opts.deletedTokens ?? [];

  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const runs: SqlCall[] = [];
  const selects: SqlCall[] = [];

  const db = {
    users,
    threepids,
    memberships,
    deletedTokens,
    inserts,
    updates,
    deletes,
    runs,
    selects,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });

              if (sql.includes('SELECT password_hash FROM users')) {
                const userId = args[0] as string;
                const row = users.find((u) => u.user_id === userId);
                if (!row) return null as T;
                return { password_hash: row.password_hash } as T;
              }

              if (
                sql.includes('SELECT user_id FROM user_threepids') &&
                sql.includes("medium = 'email'")
              ) {
                const address = args[0] as string;
                const hit = threepids.find(
                  (t) => t.medium === 'email' && t.address === address
                );
                if (!hit) return null as T;
                return { user_id: hit.user_id } as T;
              }

              return null as T;
            },

            async all<T>() {
              selects.push({ sql, args });

              if (
                sql.includes('FROM user_threepids') &&
                sql.includes('SELECT medium, address, validated_at, added_at')
              ) {
                const userId = args[0] as string;
                const results = threepids
                  .filter((t) => t.user_id === userId)
                  .map((t) => ({
                    medium: t.medium,
                    address: t.address,
                    validated_at: t.validated_at,
                    added_at: t.added_at,
                  }));
                return { results } as { results: T[] };
              }

              if (
                sql.includes('SELECT room_id FROM room_memberships') &&
                sql.includes("membership = 'join'")
              ) {
                const userId = args[0] as string;
                const results = memberships
                  .filter((m) => m.user_id === userId && m.membership === 'join')
                  .map((m) => ({ room_id: m.room_id }));
                return { results } as { results: T[] };
              }

              return { results: [] as T[] };
            },

            async run(): Promise<{
              meta: { changes: number; last_row_id: number };
              success: boolean;
            }> {
              runs.push({ sql, args });

              if (sql.includes('UPDATE users SET password_hash = ?')) {
                updates.push({ sql, args });
                const [newHash, userId] = args as [string, string];
                const row = users.find((u) => u.user_id === userId);
                if (row) row.password_hash = newHash;
                return { success: true, meta: { changes: row ? 1 : 0, last_row_id: 0 } };
              }

              if (sql.includes('DELETE FROM access_tokens WHERE user_id = ?')) {
                deletes.push({ sql, args });
                deletedTokens.push(args[0] as string);
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              if (sql.includes('UPDATE users SET is_deactivated = 1')) {
                updates.push({ sql, args });
                const userId = args[0] as string;
                const row = users.find((u) => u.user_id === userId);
                if (row) row.is_deactivated = 1;
                return { success: true, meta: { changes: row ? 1 : 0, last_row_id: 0 } };
              }

              if (
                sql.includes('UPDATE users SET display_name = NULL') &&
                sql.includes('avatar_url = NULL')
              ) {
                updates.push({ sql, args });
                const userId = args[0] as string;
                const row = users.find((u) => u.user_id === userId);
                if (row) {
                  row.display_name = null;
                  row.avatar_url = null;
                }
                return { success: true, meta: { changes: row ? 1 : 0, last_row_id: 0 } };
              }

              if (
                sql.includes("UPDATE room_memberships SET membership = 'leave'")
              ) {
                updates.push({ sql, args });
                const [roomId, userId] = args as [string, string];
                const hit = memberships.find(
                  (m) => m.room_id === roomId && m.user_id === userId
                );
                if (hit) hit.membership = 'leave';
                return { success: true, meta: { changes: hit ? 1 : 0, last_row_id: 0 } };
              }

              if (sql.includes('INSERT OR REPLACE INTO user_threepids')) {
                inserts.push({ sql, args });
                const [userId, address, validatedAt, addedAt] = args as [
                  string,
                  string,
                  number,
                  number,
                ];
                const existing = threepids.find(
                  (t) =>
                    t.user_id === userId &&
                    t.medium === 'email' &&
                    t.address === address
                );
                if (existing) {
                  existing.validated_at = validatedAt;
                  existing.added_at = addedAt;
                } else {
                  threepids.push({
                    user_id: userId,
                    medium: 'email',
                    address,
                    validated_at: validatedAt,
                    added_at: addedAt,
                  });
                }
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              if (sql.includes('DELETE FROM email_verification_sessions')) {
                deletes.push({ sql, args });
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              if (sql.includes('DELETE FROM user_threepids')) {
                deletes.push({ sql, args });
                const [userId, medium, address] = args as [string, string, string];
                const idx = threepids.findIndex(
                  (t) =>
                    t.user_id === userId &&
                    t.medium === medium &&
                    t.address === address
                );
                if (idx >= 0) threepids.splice(idx, 1);
                return {
                  success: true,
                  meta: { changes: idx >= 0 ? 1 : 0, last_row_id: 0 },
                };
              }

              throw new Error(`Unhandled SQL in account test stub: ${sql.slice(0, 160)}`);
            },
          };
        },
      };
    },
  };

  return db;
}

type AccountDb = ReturnType<typeof createAccountDb>;

function createEnv(opts: {
  db?: AccountDb;
  cacheKv?: ReturnType<typeof mockKv>;
} = {}) {
  const db = opts.db ?? createAccountDb();
  const cacheKv = opts.cacheKv ?? mockKv();

  const env = {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
    CACHE: cacheKv,
    _db: db,
    _cache: cacheKv,
  };

  return env as unknown as Env & typeof env;
}

async function request(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown; headers: Headers; text: string }> {
  const res = await accountApp.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, headers: res.headers, text };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function resetEmailMocks() {
  sendVerificationEmail.mockReset();
  createVerificationSession.mockReset();
  validateEmailToken.mockReset();
  getValidatedSession.mockReset();
  sendVerificationEmail.mockResolvedValue({ success: true });
  createVerificationSession.mockResolvedValue({
    sessionId: 'sid-default',
    token: '123456',
  });
  validateEmailToken.mockResolvedValue({ success: true });
  getValidatedSession.mockResolvedValue(null);
}

afterEach(() => {
  vi.clearAllMocks();
  resetEmailMocks();
});

resetEmailMocks();

const UIA_CHALLENGE = {
  flows: [{ stages: ['m.login.password'] }],
  params: {},
  session: UIA_SESSION,
};

// ============================================
// POST /account/password
// ============================================

describe('POST /_matrix/client/v3/account/password', () => {
  it('returns M_BAD_JSON for invalid JSON body', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/account/password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('returns M_MISSING_PARAM when new_password absent', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', { auth: { type: 'm.login.password', password: CURRENT_PW } })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: expect.stringContaining('new_password'),
    });
  });

  it('returns M_MISSING_PARAM when new_password is empty string', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', { new_password: '' })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('rejects weak password (too short)', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', { new_password: 'Ab1' })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_WEAK_PASSWORD',
      error: expect.stringContaining('8 characters'),
    });
  });

  it('rejects weak password (no letter)', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', { new_password: '12345678!' })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_WEAK_PASSWORD',
      error: expect.stringContaining('letter'),
    });
  });

  it('rejects weak password (no number/symbol)', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', { new_password: 'OnlyLetters' })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_WEAK_PASSWORD',
      error: expect.stringContaining('number or special'),
    });
  });

  it('returns UIA challenge when auth missing', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', { new_password: STRONG_NEW })
    );
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UIA_CHALLENGE);
    expect(generateOpaqueId).toHaveBeenCalledWith(16);
  });

  it('returns UIA challenge when auth.type is wrong', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', {
        new_password: STRONG_NEW,
        auth: { type: 'm.login.dummy', password: CURRENT_PW },
      })
    );
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UIA_CHALLENGE);
  });

  it('forbids when user has no password set', async () => {
    const env = createEnv({
      db: createAccountDb({ passwordHash: null }),
    });
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', {
        new_password: STRONG_NEW,
        auth: { type: 'm.login.password', password: CURRENT_PW },
      })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'No password set for user',
    });
  });

  it('forbids when user row missing (getPasswordHash null)', async () => {
    const env = createEnv({
      db: createAccountDb({ missingUser: true }),
    });
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', {
        new_password: STRONG_NEW,
        auth: { type: 'm.login.password', password: CURRENT_PW },
      })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('returns M_MISSING_PARAM when auth.password missing', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', {
        new_password: STRONG_NEW,
        auth: { type: 'm.login.password' },
      })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: expect.stringContaining('auth.password'),
    });
  });

  it('forbids invalid current password', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', {
        new_password: STRONG_NEW,
        auth: { type: 'm.login.password', password: 'WrongPass99!' },
      })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Invalid password',
    });
    expect(verifyPassword).toHaveBeenCalledWith('WrongPass99!', CURRENT_HASH);
  });

  it('succeeds and logs out devices by default (logout_devices true)', async () => {
    const db = createAccountDb();
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', {
        new_password: STRONG_NEW,
        auth: { type: 'm.login.password', password: CURRENT_PW },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(hashPassword).toHaveBeenCalledWith(STRONG_NEW);
    expect(db.users[0].password_hash).toBe(`hashed:${STRONG_NEW}`);
    expect(db.deletedTokens).toContain(USER);
    expect(
      db.updates.some((u) => u.sql.includes('UPDATE users SET password_hash'))
    ).toBe(true);
  });

  it('succeeds with logout_devices true explicitly', async () => {
    const db = createAccountDb();
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', {
        new_password: STRONG_NEW,
        logout_devices: true,
        auth: { type: 'm.login.password', password: CURRENT_PW },
      })
    );
    expect(res.status).toBe(200);
    expect(db.deletedTokens).toEqual([USER]);
  });

  it('succeeds with logout_devices false and keeps tokens', async () => {
    const db = createAccountDb();
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', {
        new_password: STRONG_NEW,
        logout_devices: false,
        auth: { type: 'm.login.password', password: CURRENT_PW, session: 's1' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.deletedTokens).toEqual([]);
    expect(db.users[0].password_hash).toBe(`hashed:${STRONG_NEW}`);
  });
});

// ============================================
// Password reset requestToken (unsupported)
// ============================================

describe('POST password email/msisdn requestToken (unsupported)', () => {
  it('email requestToken returns M_THREEPID_NOT_FOUND', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/password/email/requestToken',
      jsonInit('POST', {
        client_secret: 'sec',
        email: 'a@b.c',
        send_attempt: 1,
      })
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      errcode: 'M_THREEPID_NOT_FOUND',
      error: 'Email-based password reset is not supported',
    });
  });

  it('msisdn requestToken returns M_THREEPID_NOT_FOUND', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/password/msisdn/requestToken',
      jsonInit('POST', {
        client_secret: 'sec',
        country: 'US',
        phone_number: '5551234',
        send_attempt: 1,
      })
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      errcode: 'M_THREEPID_NOT_FOUND',
      error: 'Phone-based password reset is not supported',
    });
  });
});

// ============================================
// POST /account/deactivate
// ============================================

describe('POST /_matrix/client/v3/account/deactivate', () => {
  it('returns UIA challenge when auth missing', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/deactivate',
      jsonInit('POST', {})
    );
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UIA_CHALLENGE);
  });

  it('returns UIA on empty/invalid JSON body (treated as {})', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/account/deactivate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: 'not-json',
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UIA_CHALLENGE);
  });

  it('returns UIA when auth.type wrong', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/deactivate',
      jsonInit('POST', { auth: { type: 'm.login.token', password: CURRENT_PW } })
    );
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UIA_CHALLENGE);
  });

  it('forbids invalid password when hash+password present', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/deactivate',
      jsonInit('POST', {
        auth: { type: 'm.login.password', password: 'Nope99!' },
      })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Invalid password',
    });
  });

  it('deactivates successfully and deletes tokens', async () => {
    const db = createAccountDb();
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/deactivate',
      jsonInit('POST', {
        auth: { type: 'm.login.password', password: CURRENT_PW },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id_server_unbind_result: 'no-support' });
    expect(db.users[0].is_deactivated).toBe(1);
    expect(db.deletedTokens).toContain(USER);
    // erase=false: profile retained
    expect(db.users[0].display_name).toBe('Alice');
    expect(db.users[0].avatar_url).toBe('mxc://example.com/avatar');
  });

  it('erase=true clears profile and leaves joined rooms', async () => {
    const db = createAccountDb({
      memberships: [
        { room_id: '!a:example.com', user_id: USER, membership: 'join' },
        { room_id: '!b:example.com', user_id: USER, membership: 'join' },
        { room_id: '!c:example.com', user_id: USER, membership: 'invite' },
        { room_id: '!d:example.com', user_id: BOB, membership: 'join' },
      ],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/deactivate',
      jsonInit('POST', {
        erase: true,
        auth: { type: 'm.login.password', password: CURRENT_PW },
      })
    );
    expect(res.status).toBe(200);
    expect(db.users[0].display_name).toBeNull();
    expect(db.users[0].avatar_url).toBeNull();
    expect(db.memberships.find((m) => m.room_id === '!a:example.com')?.membership).toBe(
      'leave'
    );
    expect(db.memberships.find((m) => m.room_id === '!b:example.com')?.membership).toBe(
      'leave'
    );
    // invite not touched
    expect(db.memberships.find((m) => m.room_id === '!c:example.com')?.membership).toBe(
      'invite'
    );
    // other user's room untouched
    expect(db.memberships.find((m) => m.room_id === '!d:example.com')?.membership).toBe(
      'join'
    );
  });

  it('erase=false does not leave rooms or clear profile', async () => {
    const db = createAccountDb({
      memberships: [
        { room_id: '!keep:example.com', user_id: USER, membership: 'join' },
      ],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/deactivate',
      jsonInit('POST', {
        erase: false,
        auth: { type: 'm.login.password', password: CURRENT_PW },
      })
    );
    expect(res.status).toBe(200);
    expect(db.users[0].display_name).toBe('Alice');
    expect(db.memberships[0].membership).toBe('join');
  });

  it('succeeds without password check when no password set', async () => {
    const db = createAccountDb({ passwordHash: null });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/deactivate',
      jsonInit('POST', {
        auth: { type: 'm.login.password' },
      })
    );
    expect(res.status).toBe(200);
    expect(db.users[0].is_deactivated).toBe(1);
  });

  it('succeeds when auth.password omitted but password hash exists (skips verify)', async () => {
    const db = createAccountDb();
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/deactivate',
      jsonInit('POST', {
        auth: { type: 'm.login.password' },
      })
    );
    expect(res.status).toBe(200);
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(db.users[0].is_deactivated).toBe(1);
  });
});

// ============================================
// GET /account/3pid
// ============================================

describe('GET /_matrix/client/v3/account/3pid', () => {
  it('returns empty threepids list', async () => {
    const env = createEnv({ db: createAccountDb({ threepids: [] }) });
    const res = await request(env, '/_matrix/client/v3/account/3pid');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ threepids: [] });
  });

  it('returns populated threepids for current user only', async () => {
    const env = createEnv({
      db: createAccountDb({
        threepids: [
          {
            user_id: USER,
            medium: 'email',
            address: 'alice@ex.com',
            validated_at: 100,
            added_at: 200,
          },
          {
            user_id: USER,
            medium: 'msisdn',
            address: '15551234',
            validated_at: 300,
            added_at: 400,
          },
          {
            user_id: BOB,
            medium: 'email',
            address: 'bob@ex.com',
            validated_at: 1,
            added_at: 2,
          },
        ],
      }),
    });
    const res = await request(env, '/_matrix/client/v3/account/3pid');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      threepids: [
        {
          medium: 'email',
          address: 'alice@ex.com',
          validated_at: 100,
          added_at: 200,
        },
        {
          medium: 'msisdn',
          address: '15551234',
          validated_at: 300,
          added_at: 400,
        },
      ],
    });
  });
});

// ============================================
// POST /account/3pid/add
// ============================================

describe('POST /_matrix/client/v3/account/3pid/add', () => {
  it('returns M_BAD_JSON for invalid body', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/account/3pid/add', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: 'nope',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('requires client_secret and sid', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/add',
      jsonInit('POST', { client_secret: 'sec' })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: expect.stringContaining('client_secret and sid'),
    });
  });

  it('requires both params when sid only', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/add',
      jsonInit('POST', { sid: 'sid1' })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('returns UIA when auth missing', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/add',
      jsonInit('POST', { client_secret: 'sec', sid: 'sid1' })
    );
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UIA_CHALLENGE);
  });

  it('returns M_THREEPID_AUTH_FAILED when session not validated', async () => {
    getValidatedSession.mockResolvedValueOnce(null);
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/add',
      jsonInit('POST', {
        client_secret: 'sec',
        sid: 'sid1',
        auth: { type: 'm.login.password' },
      })
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      errcode: 'M_THREEPID_AUTH_FAILED',
      error: 'Email verification not completed or session expired',
    });
    expect(getValidatedSession).toHaveBeenCalled();
  });

  it('returns M_THREEPID_IN_USE when email bound to another user', async () => {
    getValidatedSession.mockResolvedValueOnce({
      email: 'taken@ex.com',
      userId: null,
    });
    const db = createAccountDb({
      threepids: [
        {
          user_id: BOB,
          medium: 'email',
          address: 'taken@ex.com',
          validated_at: 1,
          added_at: 1,
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/add',
      jsonInit('POST', {
        client_secret: 'sec',
        sid: 'sid-taken',
        auth: { type: 'm.login.password', session: 'x' },
      })
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      errcode: 'M_THREEPID_IN_USE',
      error: 'This email is already associated with another account',
    });
  });

  it('succeeds, inserts threepid, and cleans verification session', async () => {
    getValidatedSession.mockResolvedValueOnce({
      email: 'new@ex.com',
      userId: null,
    });
    const db = createAccountDb({ threepids: [] });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/add',
      jsonInit('POST', {
        client_secret: 'mysecret',
        sid: 'sid-ok',
        auth: { type: 'm.login.password' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.threepids).toHaveLength(1);
    expect(db.threepids[0]).toMatchObject({
      user_id: USER,
      medium: 'email',
      address: 'new@ex.com',
    });
    expect(
      db.deletes.some(
        (d) =>
          d.sql.includes('DELETE FROM email_verification_sessions') &&
          d.args[0] === 'sid-ok'
      )
    ).toBe(true);
    expect(getValidatedSession).toHaveBeenCalledWith(
      expect.anything(),
      'sid-ok',
      'mysecret'
    );
  });

  it('allows re-binding email already owned by same user (REPLACE)', async () => {
    getValidatedSession.mockResolvedValueOnce({
      email: 'mine@ex.com',
      userId: USER,
    });
    const db = createAccountDb({
      threepids: [
        {
          user_id: USER,
          medium: 'email',
          address: 'mine@ex.com',
          validated_at: 10,
          added_at: 10,
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/add',
      jsonInit('POST', {
        client_secret: 'sec',
        sid: 'sid-rebind',
        auth: { type: 'm.login.password' },
      })
    );
    expect(res.status).toBe(200);
    expect(db.threepids).toHaveLength(1);
    expect(db.threepids[0].address).toBe('mine@ex.com');
  });
});

// ============================================
// bind / delete / unbind
// ============================================

describe('POST 3pid bind/delete/unbind', () => {
  it('bind returns M_THREEPID_AUTH_FAILED unsupported', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/bind',
      jsonInit('POST', {})
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      errcode: 'M_THREEPID_AUTH_FAILED',
      error: 'Identity server binding is not supported',
    });
  });

  it('unbind returns no-support', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/unbind',
      jsonInit('POST', { medium: 'email', address: 'a@b.c' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id_server_unbind_result: 'no-support' });
  });

  it('delete returns M_BAD_JSON for bad body', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/account/3pid/delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: '{',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('delete requires medium and address', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/delete',
      jsonInit('POST', { medium: 'email' })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: expect.stringContaining('medium or address'),
    });
  });

  it('delete requires medium when only address sent', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/delete',
      jsonInit('POST', { address: 'a@b.c' })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('delete succeeds and removes matching threepid', async () => {
    const db = createAccountDb({
      threepids: [
        {
          user_id: USER,
          medium: 'email',
          address: 'gone@ex.com',
          validated_at: 1,
          added_at: 1,
        },
        {
          user_id: USER,
          medium: 'email',
          address: 'keep@ex.com',
          validated_at: 2,
          added_at: 2,
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/delete',
      jsonInit('POST', { medium: 'email', address: 'gone@ex.com' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id_server_unbind_result: 'no-support' });
    expect(db.threepids.map((t) => t.address)).toEqual(['keep@ex.com']);
  });

  it('delete succeeds even when threepid not present (idempotent)', async () => {
    const env = createEnv({ db: createAccountDb({ threepids: [] }) });
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/delete',
      jsonInit('POST', { medium: 'email', address: 'missing@ex.com' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id_server_unbind_result: 'no-support' });
  });
});

// ============================================
// POST email/requestToken
// ============================================

describe('POST /_matrix/client/v3/account/3pid/email/requestToken', () => {
  it('returns M_BAD_JSON for invalid body', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'x',
      }
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('requires client_secret', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', { email: 'a@b.c', send_attempt: 1 })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: expect.stringContaining('client_secret'),
    });
  });

  it('requires email', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', { client_secret: 'sec', send_attempt: 1 })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: expect.stringContaining('email'),
    });
  });

  it('requires send_attempt', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', { client_secret: 'sec', email: 'a@b.c' })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: expect.stringContaining('send_attempt'),
    });
  });

  it('rejects invalid email format', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', {
        client_secret: 'sec',
        email: 'not-an-email',
        send_attempt: 1,
      })
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      errcode: 'M_INVALID_EMAIL',
      error: 'Invalid email address format',
    });
  });

  it('rejects email already in use', async () => {
    const db = createAccountDb({
      threepids: [
        {
          user_id: BOB,
          medium: 'email',
          address: 'used@ex.com',
          validated_at: 1,
          added_at: 1,
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', {
        client_secret: 'sec',
        email: 'used@ex.com',
        send_attempt: 1,
      })
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      errcode: 'M_THREEPID_IN_USE',
      error: 'This email is already associated with an account',
    });
    expect(createVerificationSession).not.toHaveBeenCalled();
  });

  it('returns M_THREEPID_DENIED when createVerificationSession errors', async () => {
    createVerificationSession.mockResolvedValueOnce({ error: 'rate limited' });
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', {
        client_secret: 'sec',
        email: 'ok@ex.com',
        send_attempt: 1,
      })
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      errcode: 'M_THREEPID_DENIED',
      error: 'rate limited',
    });
  });

  it('cleans session when email send fails', async () => {
    createVerificationSession.mockResolvedValueOnce({
      sessionId: 'sid-fail',
      token: '999999',
    });
    sendVerificationEmail.mockResolvedValueOnce({
      success: false,
      error: 'SMTP down',
    });
    const db = createAccountDb();
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', {
        client_secret: 'sec',
        email: 'ok@ex.com',
        send_attempt: 1,
      })
    );
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      errcode: 'M_THREEPID_DENIED',
      error: 'SMTP down',
    });
    expect(
      db.deletes.some(
        (d) =>
          d.sql.includes('DELETE FROM email_verification_sessions') &&
          d.args[0] === 'sid-fail'
      )
    ).toBe(true);
  });

  it('uses default error message when email send fails without error text', async () => {
    createVerificationSession.mockResolvedValueOnce({
      sessionId: 'sid-fail2',
      token: '111111',
    });
    sendVerificationEmail.mockResolvedValueOnce({ success: false });
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', {
        client_secret: 'sec',
        email: 'ok@ex.com',
        send_attempt: 1,
      })
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      errcode: 'M_THREEPID_DENIED',
      error: 'Failed to send verification email',
    });
  });

  it('skips send on retry when token is empty string', async () => {
    createVerificationSession.mockResolvedValueOnce({
      sessionId: 'sid-retry',
      token: '',
    });
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', {
        client_secret: 'sec',
        email: 'ok@ex.com',
        send_attempt: 2,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sid: 'sid-retry' });
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('succeeds and sends verification email', async () => {
    createVerificationSession.mockResolvedValueOnce({
      sessionId: 'sid-ok',
      token: '654321',
    });
    sendVerificationEmail.mockResolvedValueOnce({ success: true });
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', {
        client_secret: 'client-sec',
        email: 'fresh@ex.com',
        send_attempt: 1,
        next_link: 'https://app.example/verify',
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sid: 'sid-ok' });
    expect(createVerificationSession).toHaveBeenCalledWith(
      expect.anything(),
      'fresh@ex.com',
      'client-sec',
      1
    );
    expect(sendVerificationEmail).toHaveBeenCalledWith(
      expect.anything(),
      'fresh@ex.com',
      '654321',
      SERVER
    );
  });

  it('accepts send_attempt 0 as present', async () => {
    createVerificationSession.mockResolvedValueOnce({
      sessionId: 'sid-zero',
      token: '000000',
    });
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', {
        client_secret: 'sec',
        email: 'z@ex.com',
        send_attempt: 0,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sid: 'sid-zero' });
  });
});

// ============================================
// submit_token POST + GET
// ============================================

describe('POST /_matrix/client/v3/account/3pid/submit_token', () => {
  it('returns M_BAD_JSON for invalid body', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/account/3pid/submit_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'bad',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('requires sid', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/submit_token',
      jsonInit('POST', { client_secret: 'sec', token: '123' })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: expect.stringContaining('sid'),
    });
  });

  it('requires client_secret', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/submit_token',
      jsonInit('POST', { sid: 's', token: '123' })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: expect.stringContaining('client_secret'),
    });
  });

  it('requires token', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/submit_token',
      jsonInit('POST', { sid: 's', client_secret: 'sec' })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: expect.stringContaining('token'),
    });
  });

  it('returns M_THREEPID_AUTH_FAILED on validate failure', async () => {
    validateEmailToken.mockResolvedValueOnce({
      success: false,
      error: 'bad token',
    });
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/submit_token',
      jsonInit('POST', { sid: 's', client_secret: 'sec', token: '000000' })
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      errcode: 'M_THREEPID_AUTH_FAILED',
      error: 'bad token',
    });
  });

  it('uses default error when validate fails without message', async () => {
    validateEmailToken.mockResolvedValueOnce({ success: false });
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/submit_token',
      jsonInit('POST', { sid: 's', client_secret: 'sec', token: '000000' })
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      errcode: 'M_THREEPID_AUTH_FAILED',
      error: 'Verification failed',
    });
  });

  it('succeeds when token validates', async () => {
    validateEmailToken.mockResolvedValueOnce({ success: true });
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/submit_token',
      jsonInit('POST', { sid: 'sid1', client_secret: 'sec', token: '654321' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(validateEmailToken).toHaveBeenCalledWith(
      expect.anything(),
      'sid1',
      'sec',
      '654321'
    );
  });
});

describe('GET /_matrix/client/v3/account/3pid/submit_token', () => {
  it('requires sid query param', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/submit_token?client_secret=sec&token=1'
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: expect.stringContaining('sid'),
    });
  });

  it('requires client_secret query param', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/submit_token?sid=s&token=1'
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: expect.stringContaining('client_secret'),
    });
  });

  it('requires token query param', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/submit_token?sid=s&client_secret=sec'
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: expect.stringContaining('token'),
    });
  });

  it('fails when validateEmailToken fails', async () => {
    validateEmailToken.mockResolvedValueOnce({
      success: false,
      error: 'expired',
    });
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/submit_token?sid=s&client_secret=sec&token=bad'
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      errcode: 'M_THREEPID_AUTH_FAILED',
      error: 'expired',
    });
  });

  it('succeeds via GET', async () => {
    validateEmailToken.mockResolvedValueOnce({ success: true });
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/submit_token?sid=sidG&client_secret=csec&token=111111'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(validateEmailToken).toHaveBeenCalledWith(
      expect.anything(),
      'sidG',
      'csec',
      '111111'
    );
  });
});

// ============================================
// msisdn requestToken denied
// ============================================

describe('POST /_matrix/client/v3/account/3pid/msisdn/requestToken', () => {
  it('denies phone verification with 403', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/msisdn/requestToken',
      jsonInit('POST', {
        client_secret: 'sec',
        country: 'US',
        phone_number: '555',
        send_attempt: 1,
      })
    );
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      errcode: 'M_THREEPID_DENIED',
      error: 'Phone verification is not supported',
    });
  });
});

// ============================================
// registration token validity
// ============================================

describe('GET registration_token/validity', () => {
  it('requires token query param', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v1/register/m.login.registration_token/validity'
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: expect.stringContaining('token'),
    });
  });

  it('always returns valid: false', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v1/register/m.login.registration_token/validity?token=any-token'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false });
  });

  it('returns valid: false for empty-looking but present token', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v1/register/m.login.registration_token/validity?token=0'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false });
  });
});

// ============================================
// OpenID request_token
// ============================================

describe('POST /_matrix/client/v3/user/:userId/openid/request_token', () => {
  it('forbids requesting token for another user', async () => {
    const env = createEnv();
    const bobEnc = encodeURIComponent(BOB);
    const res = await request(
      env,
      `/_matrix/client/v3/user/${bobEnc}/openid/request_token`,
      jsonInit('POST', {})
    );
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot request OpenID token for another user',
    });
    expect(env._cache.puts).toHaveLength(0);
  });

  it('succeeds for self and stores token in CACHE with TTL 3600', async () => {
    const cache = mockKv();
    const env = createEnv({ cacheKv: cache });
    const userEnc = encodeURIComponent(USER);
    const before = Date.now();
    const res = await request(
      env,
      `/_matrix/client/v3/user/${userEnc}/openid/request_token`,
      jsonInit('POST', {})
    );
    const after = Date.now();

    expect(res.status).toBe(200);
    const body = res.body as {
      access_token: string;
      token_type: string;
      matrix_server_name: string;
      expires_in: number;
    };
    expect(body.token_type).toBe('Bearer');
    expect(body.matrix_server_name).toBe(SERVER);
    expect(body.expires_in).toBe(3600);
    expect(body.access_token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.access_token.length).toBeGreaterThan(20);

    expect(cache.puts).toHaveLength(1);
    expect(cache.puts[0].key).toBe(`openid_token:${body.access_token}`);
    expect(cache.puts[0].options).toEqual({ expirationTtl: 3600 });

    const stored = JSON.parse(cache.puts[0].value) as {
      user_id: string;
      created_at: number;
      expires_at: number;
    };
    expect(stored.user_id).toBe(USER);
    expect(stored.created_at).toBeGreaterThanOrEqual(before);
    expect(stored.created_at).toBeLessThanOrEqual(after);
    expect(stored.expires_at).toBe(stored.created_at + 3600 * 1000);
  });

  it('decodes percent-encoded userId path param', async () => {
    const cache = mockKv();
    const env = createEnv({ cacheKv: cache });
    // %40alice%3Aexample.com
    const res = await request(
      env,
      '/_matrix/client/v3/user/%40alice%3Aexample.com/openid/request_token',
      jsonInit('POST', {})
    );
    expect(res.status).toBe(200);
    expect((res.body as { matrix_server_name: string }).matrix_server_name).toBe(
      SERVER
    );
    expect(cache.puts).toHaveLength(1);
  });

  it('issues distinct tokens across calls', async () => {
    const cache = mockKv();
    const env = createEnv({ cacheKv: cache });
    const path = `/_matrix/client/v3/user/${encodeURIComponent(USER)}/openid/request_token`;
    const a = await request(env, path, jsonInit('POST', {}));
    const b = await request(env, path, jsonInit('POST', {}));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.body as { access_token: string }).access_token).not.toBe(
      (b.body as { access_token: string }).access_token
    );
    expect(cache.puts).toHaveLength(2);
  });
});

// ============================================
// Misc / auth mock sanity
// ============================================

describe('account route auth + mock wiring', () => {
  it('requireAuth mock injects USER and DEVICE for protected routes', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/account/3pid');
    expect(res.status).toBe(200);
    // Device constant documented for parity with keys suite
    expect(DEVICE).toBe('DEVICEA');
    expect(USER).toBe('@alice:example.com');
    expect(BOB).toBe('@bob:example.com');
  });

  it('password change uses mocked verifyPassword convention mockok:pw', async () => {
    const db = createAccountDb({
      passwordHash: 'mockok:CorrectHorse99!',
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', {
        new_password: STRONG_NEW,
        logout_devices: false,
        auth: { type: 'm.login.password', password: 'CorrectHorse99!' },
      })
    );
    expect(res.status).toBe(200);
    expect(verifyPassword).toHaveBeenCalledWith(
      'CorrectHorse99!',
      'mockok:CorrectHorse99!'
    );
  });
});
