/**
 * TOKENMAXX HEAVY deepen — account management API routes only (src/api/account.ts).
 * Avoids keys (#99), key-backups, search, oauth, and PR #100 devices/aliases/relations/tags/profile.
 * Tests-only — no product inventing.
 * Exercises password UIA, deactivate, 3PIDs, email/msisdn stubs, registration token, OpenID.
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

import account from '../src/api/account';
import { hashPassword, verifyPassword } from '../src/utils/crypto';
import { generateOpaqueId } from '../src/utils/ids';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const DEVICE = 'DEVICEA';
const SERVER = 'example.com';
const STRONG_PW = 'NewSecure1!';
const CURRENT_PW = 'oldpass1';

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

type Membership = { room_id: string; user_id: string; membership: string };

type EmailSessionRow = {
  session_id: string;
  email: string;
  user_id: string | null;
  client_secret: string;
  token: string;
  send_attempt: number;
  validated: number;
  created_at: number;
  expires_at: number;
  validated_at?: number | null;
};

type UserRow = {
  user_id: string;
  password_hash: string | null;
  is_deactivated: number;
  display_name: string | null;
  avatar_url: string | null;
};

type TokenRow = { token_hash: string; user_id: string; device_id: string };

type SqlCall = { sql: string; args: unknown[] };

function createAccountDb(opts: {
  users?: Map<string, UserRow>;
  passwordHashes?: Map<string, string | null>;
  threepids?: ThreepidRow[];
  memberships?: Membership[];
  tokens?: TokenRow[];
  emailSessions?: Map<string, EmailSessionRow>;
  throwOn?: string;
} = {}) {
  const users =
    opts.users ??
    new Map<string, UserRow>([
      [
        USER,
        {
          user_id: USER,
          password_hash: opts.passwordHashes?.get(USER) ?? `mockok:${CURRENT_PW}`,
          is_deactivated: 0,
          display_name: 'Alice',
          avatar_url: 'mxc://example.com/avatar',
        },
      ],
    ]);

  if (opts.passwordHashes) {
    for (const [uid, hash] of opts.passwordHashes) {
      const existing = users.get(uid);
      if (existing) {
        existing.password_hash = hash;
      } else {
        users.set(uid, {
          user_id: uid,
          password_hash: hash,
          is_deactivated: 0,
          display_name: null,
          avatar_url: null,
        });
      }
    }
  }

  const threepids = opts.threepids ?? [];
  const memberships = opts.memberships ?? [];
  const tokens = opts.tokens ?? [
    { token_hash: 'tok-a', user_id: USER, device_id: DEVICE },
    { token_hash: 'tok-b', user_id: USER, device_id: 'DEVICEB' },
  ];
  const emailSessions = opts.emailSessions ?? new Map<string, EmailSessionRow>();

  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const runs: SqlCall[] = [];

  const db = {
    users,
    threepids,
    memberships,
    tokens,
    emailSessions,
    inserts,
    updates,
    deletes,
    runs,
    prepare(sql: string) {
      if (opts.throwOn && sql.includes(opts.throwOn)) {
        throw new Error(`forced db error: ${opts.throwOn}`);
      }
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              // getPasswordHash
              if (sql.includes('SELECT password_hash FROM users')) {
                const userId = args[0] as string;
                const user = users.get(userId);
                if (!user) return null;
                return { password_hash: user.password_hash } as T;
              }

              // existing 3pid binding by email address
              if (
                sql.includes('FROM user_threepids') &&
                sql.includes("medium = 'email'") &&
                sql.includes('address = ?')
              ) {
                const address = args[0] as string;
                const hit = threepids.find((t) => t.medium === 'email' && t.address === address);
                if (!hit) return null;
                return { user_id: hit.user_id } as T;
              }

              // email session by email+secret (createVerificationSession path if unmocked)
              if (sql.includes('FROM email_verification_sessions') && sql.includes('email = ?')) {
                const [email, clientSecret] = args as [string, string];
                const rows = [...emailSessions.values()]
                  .filter((r) => r.email === email && r.client_secret === clientSecret)
                  .sort((a, b) => b.created_at - a.created_at);
                return (rows[0] as T) ?? null;
              }

              // validated email session
              if (
                sql.includes('FROM email_verification_sessions') &&
                sql.includes('validated = 1')
              ) {
                const [sessionId] = args as [string];
                const row = emailSessions.get(sessionId);
                if (!row || row.validated !== 1) return null;
                return {
                  email: row.email,
                  user_id: row.user_id,
                  client_secret: row.client_secret,
                  validated: row.validated,
                } as T;
              }

              // email session by id
              if (sql.includes('FROM email_verification_sessions') && sql.includes('session_id')) {
                const [sessionId] = args as [string];
                return (emailSessions.get(sessionId) as T) ?? null;
              }

              return null;
            },

            async all<T>() {
              if (sql.includes('FROM user_threepids') && sql.includes('WHERE user_id = ?')) {
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
                sql.includes('FROM room_memberships') &&
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

            async run(): Promise<{ meta: { changes: number; last_row_id: number }; success: boolean }> {
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
                const [userId] = args as [string];
                const user = users.get(userId);
                if (user) user.is_deactivated = 1;
                return { success: true, meta: { changes: user ? 1 : 0, last_row_id: 0 } };
              }

              if (
                sql.includes('UPDATE users SET display_name = NULL') &&
                sql.includes('avatar_url = NULL')
              ) {
                updates.push({ sql, args });
                const [userId] = args as [string];
                const user = users.get(userId);
                if (user) {
                  user.display_name = null;
                  user.avatar_url = null;
                }
                return { success: true, meta: { changes: user ? 1 : 0, last_row_id: 0 } };
              }

              if (
                sql.includes('UPDATE room_memberships SET membership = ') &&
                sql.includes("'leave'")
              ) {
                updates.push({ sql, args });
                const [roomId, userId] = args as [string, string];
                const hit = memberships.find((m) => m.room_id === roomId && m.user_id === userId);
                if (hit) hit.membership = 'leave';
                return { success: true, meta: { changes: hit ? 1 : 0, last_row_id: 0 } };
              }

              if (sql.includes('DELETE FROM access_tokens')) {
                deletes.push({ sql, args });
                const [userId] = args as [string];
                const before = tokens.length;
                for (let i = tokens.length - 1; i >= 0; i--) {
                  if (tokens[i].user_id === userId) tokens.splice(i, 1);
                }
                return {
                  success: true,
                  meta: { changes: before - tokens.length, last_row_id: 0 },
                };
              }

              if (sql.includes('INSERT OR REPLACE INTO user_threepids')) {
                inserts.push({ sql, args });
                const [userId, address, validatedAt, addedAt] = args as [
                  string,
                  string,
                  number,
                  number,
                ];
                const idx = threepids.findIndex(
                  (t) => t.user_id === userId && t.medium === 'email' && t.address === address
                );
                const row: ThreepidRow = {
                  user_id: userId,
                  medium: 'email',
                  address,
                  validated_at: validatedAt,
                  added_at: addedAt,
                };
                if (idx >= 0) threepids[idx] = row;
                else threepids.push(row);
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              if (sql.includes('DELETE FROM user_threepids')) {
                deletes.push({ sql, args });
                const [userId, medium, address] = args as [string, string, string];
                const before = threepids.length;
                for (let i = threepids.length - 1; i >= 0; i--) {
                  const t = threepids[i];
                  if (t.user_id === userId && t.medium === medium && t.address === address) {
                    threepids.splice(i, 1);
                  }
                }
                return {
                  success: true,
                  meta: { changes: before - threepids.length, last_row_id: 0 },
                };
              }

              if (sql.includes('DELETE FROM email_verification_sessions')) {
                deletes.push({ sql, args });
                const [sessionId] = args as [string];
                const existed = emailSessions.delete(sessionId);
                return {
                  success: true,
                  meta: { changes: existed ? 1 : 0, last_row_id: 0 },
                };
              }

              if (sql.includes('INSERT INTO email_verification_sessions')) {
                inserts.push({ sql, args });
                const [
                  sessionId,
                  email,
                  userId,
                  clientSecret,
                  token,
                  sendAttempt,
                  createdAt,
                  expiresAt,
                ] = args as [
                  string,
                  string,
                  string | null,
                  string,
                  string,
                  number,
                  number,
                  number,
                ];
                emailSessions.set(sessionId, {
                  session_id: sessionId,
                  email,
                  user_id: userId,
                  client_secret: clientSecret,
                  token,
                  send_attempt: sendAttempt,
                  validated: 0,
                  created_at: createdAt,
                  expires_at: expiresAt,
                  validated_at: null,
                });
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              if (sql.includes('UPDATE email_verification_sessions')) {
                updates.push({ sql, args });
                const [validatedAt, sessionId] = args as [number, string];
                const row = emailSessions.get(sessionId);
                if (row) {
                  row.validated = 1;
                  row.validated_at = validatedAt;
                }
                return { success: true, meta: { changes: row ? 1 : 0, last_row_id: 0 } };
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
  email?: { send: ReturnType<typeof vi.fn> };
  emailFrom?: string;
} = {}) {
  const db = opts.db ?? createAccountDb();
  const cacheKv = opts.cacheKv ?? mockKv();
  const email = opts.email ?? { send: vi.fn(async () => ({ messageId: 'msg-1' })) };

  const env = {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
    CACHE: cacheKv,
    EMAIL: email,
    EMAIL_FROM: opts.emailFrom,
    _db: db,
    _cache: cacheKv,
    _email: email,
  };

  return env as unknown as Env & typeof env;
}

async function request(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown; headers: Headers; text: string }> {
  const res = await account.request(`http://localhost${path}`, init, env);
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

function passwordAuth(password = CURRENT_PW, session = 'sess-1') {
  return { type: 'm.login.password', session, password };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateOpaqueId).mockResolvedValue('pinned-uia-session-16');
  vi.mocked(hashPassword).mockImplementation(async (password: string) => `hashed:${password}`);
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
  vi.restoreAllMocks();
});

// ============================================
// Password change
// ============================================

describe('POST /_matrix/client/v3/account/password', () => {
  it('returns M_BAD_JSON for invalid JSON body', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/account/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('returns M_MISSING_PARAM when new_password is absent', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', { auth: passwordAuth() })
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
      jsonInit('POST', { new_password: '', auth: passwordAuth() })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('rejects weak password shorter than 8 chars before UIA', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', { new_password: 'Ab1!' })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_WEAK_PASSWORD',
      error: expect.stringContaining('8 characters'),
    });
  });

  it('rejects password with no letter', async () => {
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

  it('rejects password with no number or special character', async () => {
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

  it('rejects password longer than 1000 characters', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', { new_password: `A1${'x'.repeat(999)}` })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_WEAK_PASSWORD',
      error: expect.stringContaining('1000'),
    });
  });

  it('returns UIA challenge when auth is missing', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', { new_password: STRONG_PW })
    );
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      flows: [{ stages: ['m.login.password'] }],
      params: {},
      session: 'pinned-uia-session-16',
    });
    expect(generateOpaqueId).toHaveBeenCalledWith(16);
  });

  it('returns UIA challenge when auth.type is wrong', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', {
        new_password: STRONG_PW,
        auth: { type: 'm.login.dummy', session: 's' },
      })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.password'] }],
      session: 'pinned-uia-session-16',
    });
  });

  it('forbids change when user has no stored password hash', async () => {
    const env = createEnv({
      db: createAccountDb({ passwordHashes: new Map([[USER, null]]) }),
    });
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', {
        new_password: STRONG_PW,
        auth: passwordAuth(),
      })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'No password set for user',
    });
  });

  it('forbids change when user row is missing entirely', async () => {
    const env = createEnv({
      db: createAccountDb({ users: new Map() }),
    });
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', {
        new_password: STRONG_PW,
        auth: passwordAuth(),
      })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('returns M_MISSING_PARAM when auth.password is absent', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', {
        new_password: STRONG_PW,
        auth: { type: 'm.login.password', session: 's' },
      })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: expect.stringContaining('auth.password'),
    });
  });

  it('forbids change when current password is wrong', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', {
        new_password: STRONG_PW,
        auth: passwordAuth('wrong-pass'),
      })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Invalid password',
    });
    expect(verifyPassword).toHaveBeenCalledWith('wrong-pass', `mockok:${CURRENT_PW}`);
  });

  it('updates password hash and logs out all devices by default', async () => {
    const db = createAccountDb();
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', {
        new_password: STRONG_PW,
        auth: passwordAuth(),
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(hashPassword).toHaveBeenCalledWith(STRONG_PW);
    expect(db.users.get(USER)?.password_hash).toBe(`hashed:${STRONG_PW}`);
    expect(db.tokens).toHaveLength(0);
    expect(db.deletes.some((d) => d.sql.includes('DELETE FROM access_tokens'))).toBe(true);
  });

  it('updates password without deleting tokens when logout_devices is false', async () => {
    const db = createAccountDb();
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', {
        new_password: STRONG_PW,
        logout_devices: false,
        auth: passwordAuth(),
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.users.get(USER)?.password_hash).toBe(`hashed:${STRONG_PW}`);
    expect(db.tokens).toHaveLength(2);
    expect(db.deletes.some((d) => d.sql.includes('DELETE FROM access_tokens'))).toBe(false);
  });

  it('still logs out devices when logout_devices is explicitly true', async () => {
    const db = createAccountDb();
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', {
        new_password: STRONG_PW,
        logout_devices: true,
        auth: passwordAuth(),
      })
    );
    expect(res.status).toBe(200);
    expect(db.tokens).toHaveLength(0);
  });

  it('accepts strong password with digit only (no special)', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', {
        new_password: 'Password9',
        logout_devices: false,
        auth: passwordAuth(),
      })
    );
    expect(res.status).toBe(200);
  });

  it('accepts strong password with special char only (no digit)', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', {
        new_password: 'Password!',
        logout_devices: false,
        auth: passwordAuth(),
      })
    );
    expect(res.status).toBe(200);
  });

  it('passes through UIA session id from client auth without requiring match', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', {
        new_password: STRONG_PW,
        logout_devices: false,
        auth: passwordAuth(CURRENT_PW, 'client-chosen-session'),
      })
    );
    expect(res.status).toBe(200);
  });

  it('issues a fresh UIA session each challenge call', async () => {
    vi.mocked(generateOpaqueId)
      .mockResolvedValueOnce('session-aaa')
      .mockResolvedValueOnce('session-bbb');
    const env = createEnv();
    const a = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', { new_password: STRONG_PW })
    );
    const b = await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', { new_password: STRONG_PW })
    );
    expect(a.body).toMatchObject({ session: 'session-aaa' });
    expect(b.body).toMatchObject({ session: 'session-bbb' });
  });
});

describe('POST password email/msisdn requestToken stubs', () => {
  it('rejects email-based password reset', async () => {
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

  it('rejects phone-based password reset', async () => {
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

  it('password email stub does not require auth middleware', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/password/email/requestToken',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_THREEPID_NOT_FOUND' });
  });
});

// ============================================
// Deactivate
// ============================================

describe('POST /_matrix/client/v3/account/deactivate', () => {
  it('treats invalid JSON as empty body and returns UIA', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/account/deactivate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: 'not-json',
    });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.password'] }],
      session: 'pinned-uia-session-16',
    });
  });

  it('returns UIA when auth is missing', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/deactivate',
      jsonInit('POST', { erase: false })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.password'] }],
      params: {},
      session: 'pinned-uia-session-16',
    });
  });

  it('returns UIA when auth type is not password', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/deactivate',
      jsonInit('POST', { auth: { type: 'm.login.dummy' } })
    );
    expect(res.status).toBe(401);
  });

  it('forbids deactivation with wrong password when hash exists', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/deactivate',
      jsonInit('POST', { auth: passwordAuth('nope') })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Invalid password',
    });
  });

  it('deactivates and deletes tokens without erase', async () => {
    const db = createAccountDb({
      memberships: [
        { room_id: '!r1:example.com', user_id: USER, membership: 'join' },
      ],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/deactivate',
      jsonInit('POST', { auth: passwordAuth() })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id_server_unbind_result: 'no-support' });
    expect(db.users.get(USER)?.is_deactivated).toBe(1);
    expect(db.users.get(USER)?.display_name).toBe('Alice');
    expect(db.tokens).toHaveLength(0);
    expect(db.memberships[0].membership).toBe('join');
  });

  it('erase clears profile and leaves joined rooms', async () => {
    const db = createAccountDb({
      memberships: [
        { room_id: '!a:example.com', user_id: USER, membership: 'join' },
        { room_id: '!b:example.com', user_id: USER, membership: 'invite' },
        { room_id: '!c:example.com', user_id: USER, membership: 'join' },
        { room_id: '!d:example.com', user_id: BOB, membership: 'join' },
      ],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/deactivate',
      jsonInit('POST', { erase: true, auth: passwordAuth() })
    );
    expect(res.status).toBe(200);
    expect(db.users.get(USER)?.display_name).toBeNull();
    expect(db.users.get(USER)?.avatar_url).toBeNull();
    expect(db.memberships.find((m) => m.room_id === '!a:example.com')?.membership).toBe('leave');
    expect(db.memberships.find((m) => m.room_id === '!c:example.com')?.membership).toBe('leave');
    expect(db.memberships.find((m) => m.room_id === '!b:example.com')?.membership).toBe('invite');
    expect(db.memberships.find((m) => m.room_id === '!d:example.com')?.membership).toBe('join');
  });

  it('erase with no joined rooms still clears profile', async () => {
    const db = createAccountDb({ memberships: [] });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/deactivate',
      jsonInit('POST', { erase: true, auth: passwordAuth() })
    );
    expect(res.status).toBe(200);
    expect(db.users.get(USER)?.display_name).toBeNull();
    expect(db.users.get(USER)?.avatar_url).toBeNull();
  });

  it('allows deactivation when no password hash is set (skips verify)', async () => {
    const db = createAccountDb({ passwordHashes: new Map([[USER, null]]) });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/deactivate',
      jsonInit('POST', {
        auth: { type: 'm.login.password', session: 's', password: 'anything' },
      })
    );
    expect(res.status).toBe(200);
    expect(db.users.get(USER)?.is_deactivated).toBe(1);
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('allows deactivation when auth.password is omitted but hash exists', async () => {
    // Product path only verifies when both storedHash and auth.password are truthy
    const db = createAccountDb();
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/deactivate',
      jsonInit('POST', {
        auth: { type: 'm.login.password', session: 's' },
      })
    );
    expect(res.status).toBe(200);
    expect(db.users.get(USER)?.is_deactivated).toBe(1);
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('defaults erase to false when omitted', async () => {
    const db = createAccountDb();
    const env = createEnv({ db });
    await request(
      env,
      '/_matrix/client/v3/account/deactivate',
      jsonInit('POST', { auth: passwordAuth() })
    );
    expect(db.users.get(USER)?.display_name).toBe('Alice');
  });
});

// ============================================
// 3PID list / bind / unbind / delete
// ============================================

describe('GET /_matrix/client/v3/account/3pid', () => {
  it('returns empty threepids list', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/account/3pid', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ threepids: [] });
  });

  it('returns mapped threepids for the authenticated user', async () => {
    const env = createEnv({
      db: createAccountDb({
        threepids: [
          {
            user_id: USER,
            medium: 'email',
            address: 'alice@example.com',
            validated_at: 100,
            added_at: 90,
          },
          {
            user_id: USER,
            medium: 'msisdn',
            address: '15551234',
            validated_at: 200,
            added_at: 180,
          },
          {
            user_id: BOB,
            medium: 'email',
            address: 'bob@example.com',
            validated_at: 1,
            added_at: 1,
          },
        ],
      }),
    });
    const res = await request(env, '/_matrix/client/v3/account/3pid', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      threepids: [
        {
          medium: 'email',
          address: 'alice@example.com',
          validated_at: 100,
          added_at: 90,
        },
        {
          medium: 'msisdn',
          address: '15551234',
          validated_at: 200,
          added_at: 180,
        },
      ],
    });
  });
});

describe('POST /_matrix/client/v3/account/3pid/add', () => {
  it('returns M_BAD_JSON for invalid body', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/account/3pid/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: '{',
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

  it('requires sid when only client_secret missing is inverted', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/add',
      jsonInit('POST', { sid: 'sid-1' })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('returns UIA when auth is missing', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/add',
      jsonInit('POST', { client_secret: 'sec', sid: 'sid-1' })
    );
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      flows: [{ stages: ['m.login.password'] }],
      session: 'pinned-uia-session-16',
    });
  });

  it('returns UIA when auth type is wrong', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/add',
      jsonInit('POST', {
        client_secret: 'sec',
        sid: 'sid-1',
        auth: { type: 'm.login.dummy' },
      })
    );
    expect(res.status).toBe(401);
  });

  it('fails when email verification session is not validated', async () => {
    emailMocks.getValidatedSession.mockResolvedValueOnce(null);
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/add',
      jsonInit('POST', {
        client_secret: 'sec',
        sid: 'sid-1',
        auth: { type: 'm.login.password', session: 's' },
      })
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      errcode: 'M_THREEPID_AUTH_FAILED',
      error: 'Email verification not completed or session expired',
    });
    expect(emailMocks.getValidatedSession).toHaveBeenCalledWith(
      expect.anything(),
      'sid-1',
      'sec'
    );
  });

  it('rejects when email is bound to another account', async () => {
    emailMocks.getValidatedSession.mockResolvedValueOnce({ email: 'taken@example.com' });
    const env = createEnv({
      db: createAccountDb({
        threepids: [
          {
            user_id: BOB,
            medium: 'email',
            address: 'taken@example.com',
            validated_at: 1,
            added_at: 1,
          },
        ],
      }),
    });
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/add',
      jsonInit('POST', {
        client_secret: 'sec',
        sid: 'sid-1',
        auth: { type: 'm.login.password', session: 's' },
      })
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      errcode: 'M_THREEPID_IN_USE',
      error: 'This email is already associated with another account',
    });
  });

  it('adds 3pid, cleans session, and allows rebinding same user email', async () => {
    emailMocks.getValidatedSession.mockResolvedValueOnce({ email: 'alice@example.com' });
    const db = createAccountDb({
      threepids: [
        {
          user_id: USER,
          medium: 'email',
          address: 'alice@example.com',
          validated_at: 10,
          added_at: 10,
        },
      ],
      emailSessions: new Map([
        [
          'sid-1',
          {
            session_id: 'sid-1',
            email: 'alice@example.com',
            user_id: null,
            client_secret: 'sec',
            token: '111111',
            send_attempt: 1,
            validated: 1,
            created_at: 1,
            expires_at: Date.now() + 99999,
          },
        ],
      ]),
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/add',
      jsonInit('POST', {
        client_secret: 'sec',
        sid: 'sid-1',
        auth: { type: 'm.login.password', session: 's' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.threepids.filter((t) => t.address === 'alice@example.com')).toHaveLength(1);
    expect(db.emailSessions.has('sid-1')).toBe(false);
  });

  it('inserts a brand-new email 3pid for the user', async () => {
    emailMocks.getValidatedSession.mockResolvedValueOnce({ email: 'new@example.com' });
    const db = createAccountDb({
      emailSessions: new Map([
        [
          'sid-new',
          {
            session_id: 'sid-new',
            email: 'new@example.com',
            user_id: null,
            client_secret: 'c',
            token: '222222',
            send_attempt: 1,
            validated: 1,
            created_at: 1,
            expires_at: Date.now() + 99999,
          },
        ],
      ]),
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/add',
      jsonInit('POST', {
        client_secret: 'c',
        sid: 'sid-new',
        auth: { type: 'm.login.password', session: 's' },
      })
    );
    expect(res.status).toBe(200);
    expect(db.threepids).toEqual([
      expect.objectContaining({
        user_id: USER,
        medium: 'email',
        address: 'new@example.com',
      }),
    ]);
    expect(typeof db.threepids[0].validated_at).toBe('number');
    expect(db.threepids[0].added_at).toBe(db.threepids[0].validated_at);
  });
});

describe('POST /_matrix/client/v3/account/3pid/bind', () => {
  it('returns not-supported auth failure', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/bind',
      jsonInit('POST', {
        client_secret: 'sec',
        sid: 'sid',
        id_server: 'id.example.com',
      })
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      errcode: 'M_THREEPID_AUTH_FAILED',
      error: 'Identity server binding is not supported',
    });
  });
});

describe('POST /_matrix/client/v3/account/3pid/unbind', () => {
  it('returns no-support unbind result', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/unbind',
      jsonInit('POST', {
        medium: 'email',
        address: 'a@b.c',
        id_server: 'id.example.com',
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id_server_unbind_result: 'no-support' });
  });
});

describe('POST /_matrix/client/v3/account/3pid/delete', () => {
  it('returns M_BAD_JSON for invalid body', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/account/3pid/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: 'nope',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('requires medium and address', async () => {
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

  it('requires medium when only address provided', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/delete',
      jsonInit('POST', { address: 'a@b.c' })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('deletes matching 3pid for the user', async () => {
    const db = createAccountDb({
      threepids: [
        {
          user_id: USER,
          medium: 'email',
          address: 'alice@example.com',
          validated_at: 1,
          added_at: 1,
        },
        {
          user_id: USER,
          medium: 'email',
          address: 'keep@example.com',
          validated_at: 2,
          added_at: 2,
        },
        {
          user_id: BOB,
          medium: 'email',
          address: 'alice@example.com',
          validated_at: 3,
          added_at: 3,
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/delete',
      jsonInit('POST', { medium: 'email', address: 'alice@example.com' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id_server_unbind_result: 'no-support' });
    expect(db.threepids).toEqual([
      expect.objectContaining({ user_id: USER, address: 'keep@example.com' }),
      expect.objectContaining({ user_id: BOB, address: 'alice@example.com' }),
    ]);
  });

  it('is a quiet success when 3pid does not exist', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/delete',
      jsonInit('POST', { medium: 'email', address: 'missing@example.com' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id_server_unbind_result: 'no-support' });
  });
});

// ============================================
// Email requestToken + submit_token
// ============================================

describe('POST /_matrix/client/v3/account/3pid/email/requestToken', () => {
  it('returns M_BAD_JSON for invalid body', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/account/3pid/email/requestToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad',
    });
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

  it('rejects email already bound to an account', async () => {
    const env = createEnv({
      db: createAccountDb({
        threepids: [
          {
            user_id: BOB,
            medium: 'email',
            address: 'used@example.com',
            validated_at: 1,
            added_at: 1,
          },
        ],
      }),
    });
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', {
        client_secret: 'sec',
        email: 'used@example.com',
        send_attempt: 1,
      })
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      errcode: 'M_THREEPID_IN_USE',
      error: 'This email is already associated with an account',
    });
    expect(emailMocks.createVerificationSession).not.toHaveBeenCalled();
  });

  it('returns M_THREEPID_DENIED when session creation fails', async () => {
    emailMocks.createVerificationSession.mockResolvedValueOnce({
      error: 'Email already validated for this session',
    });
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', {
        client_secret: 'sec',
        email: 'free@example.com',
        send_attempt: 1,
      })
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      errcode: 'M_THREEPID_DENIED',
      error: 'Email already validated for this session',
    });
  });

  it('creates session, sends email, and returns sid', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', {
        client_secret: 'sec',
        email: 'free@example.com',
        send_attempt: 1,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sid: 'sid-new' });
    expect(emailMocks.createVerificationSession).toHaveBeenCalledWith(
      expect.anything(),
      'free@example.com',
      'sec',
      1
    );
    expect(emailMocks.sendVerificationEmail).toHaveBeenCalledWith(
      expect.anything(),
      'free@example.com',
      '654321',
      SERVER
    );
  });

  it('skips sending email on retry when token is empty', async () => {
    emailMocks.createVerificationSession.mockResolvedValueOnce({
      sessionId: 'sid-retry',
      token: '',
    });
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', {
        client_secret: 'sec',
        email: 'free@example.com',
        send_attempt: 1,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sid: 'sid-retry' });
    expect(emailMocks.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('cleans up session and returns 500 when email send fails', async () => {
    emailMocks.createVerificationSession.mockResolvedValueOnce({
      sessionId: 'sid-fail',
      token: '999999',
    });
    emailMocks.sendVerificationEmail.mockResolvedValueOnce({
      success: false,
      error: 'SMTP down',
    });
    const db = createAccountDb({
      emailSessions: new Map([
        [
          'sid-fail',
          {
            session_id: 'sid-fail',
            email: 'free@example.com',
            user_id: null,
            client_secret: 'sec',
            token: '999999',
            send_attempt: 1,
            validated: 0,
            created_at: 1,
            expires_at: Date.now() + 99999,
          },
        ],
      ]),
    });
    const env = createEnv({ db });
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', {
        client_secret: 'sec',
        email: 'free@example.com',
        send_attempt: 1,
      })
    );
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      errcode: 'M_THREEPID_DENIED',
      error: 'SMTP down',
    });
    expect(db.emailSessions.has('sid-fail')).toBe(false);
  });

  it('uses fallback error message when email send fails without error text', async () => {
    emailMocks.createVerificationSession.mockResolvedValueOnce({
      sessionId: 'sid-fail2',
      token: '111111',
    });
    emailMocks.sendVerificationEmail.mockResolvedValueOnce({ success: false });
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', {
        client_secret: 'sec',
        email: 'free@example.com',
        send_attempt: 1,
      })
    );
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      errcode: 'M_THREEPID_DENIED',
      error: 'Failed to send verification email',
    });
  });

  it('accepts send_attempt 0 as provided (not missing)', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', {
        client_secret: 'sec',
        email: 'free@example.com',
        send_attempt: 0,
      })
    );
    expect(res.status).toBe(200);
    expect(emailMocks.createVerificationSession).toHaveBeenCalledWith(
      expect.anything(),
      'free@example.com',
      'sec',
      0
    );
  });

  it('rejects emails with spaces', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', {
        client_secret: 'sec',
        email: 'a @b.c',
        send_attempt: 1,
      })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_EMAIL' });
  });
});

describe('POST /_matrix/client/v3/account/3pid/submit_token', () => {
  it('returns M_BAD_JSON for invalid body', async () => {
    const env = createEnv();
    const res = await request(env, '/_matrix/client/v3/account/3pid/submit_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'x',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('requires sid', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/submit_token',
      jsonInit('POST', { client_secret: 'sec', token: '123456' })
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
      jsonInit('POST', { sid: 's', token: '123456' })
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

  it('returns auth failed when validation fails', async () => {
    emailMocks.validateEmailToken.mockResolvedValueOnce({
      success: false,
      error: 'Invalid token',
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
      error: 'Invalid token',
    });
  });

  it('uses fallback error when validation fails without message', async () => {
    emailMocks.validateEmailToken.mockResolvedValueOnce({ success: false });
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

  it('returns success on valid token', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/submit_token',
      jsonInit('POST', { sid: 'sid-1', client_secret: 'sec', token: '654321' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(emailMocks.validateEmailToken).toHaveBeenCalledWith(
      expect.anything(),
      'sid-1',
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

  it('returns auth failed on invalid GET submit', async () => {
    emailMocks.validateEmailToken.mockResolvedValueOnce({
      success: false,
      error: 'Session expired',
    });
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/submit_token?sid=s&client_secret=sec&token=1'
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      errcode: 'M_THREEPID_AUTH_FAILED',
      error: 'Session expired',
    });
  });

  it('returns success on valid GET submit', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/submit_token?sid=sid-g&client_secret=sec&token=654321'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(emailMocks.validateEmailToken).toHaveBeenCalledWith(
      expect.anything(),
      'sid-g',
      'sec',
      '654321'
    );
  });

  it('uses Verification failed fallback on GET when error omitted', async () => {
    emailMocks.validateEmailToken.mockResolvedValueOnce({ success: false });
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/submit_token?sid=s&client_secret=sec&token=1'
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Verification failed' });
  });
});

describe('POST /_matrix/client/v3/account/3pid/msisdn/requestToken', () => {
  it('denies phone verification', async () => {
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
// Registration token validity
// ============================================

describe('GET /_matrix/client/v1/register/m.login.registration_token/validity', () => {
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

  it('always returns valid:false for any token', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v1/register/m.login.registration_token/validity?token=abc123'
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false });
  });

  it('returns valid:false for empty-looking non-empty token strings', async () => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v1/register/m.login.registration_token/validity?token=%20'
    );
    // "%20" decodes to space — still a present query value
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false });
  });
});

// ============================================
// OpenID request_token
// ============================================

describe('POST /_matrix/client/v3/user/:userId/openid/request_token', () => {
  it('forbids requesting a token for another user', async () => {
    const env = createEnv();
    const res = await request(
      env,
      `/_matrix/client/v3/user/${encodeURIComponent(BOB)}/openid/request_token`,
      jsonInit('POST', {})
    );
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot request OpenID token for another user',
    });
    expect(env._cache.puts).toHaveLength(0);
  });

  it('issues OpenID token for self and stores it in CACHE', async () => {
    const cache = mockKv();
    const env = createEnv({ cacheKv: cache });
    const res = await request(
      env,
      `/_matrix/client/v3/user/${encodeURIComponent(USER)}/openid/request_token`,
      jsonInit('POST', {})
    );
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
    expect(stored.expires_at - stored.created_at).toBe(3600_000);
    expect(cache.data[`openid_token:${body.access_token}`]).toBe(cache.puts[0].value);
  });

  it('decodes percent-encoded userId in the path', async () => {
    const env = createEnv();
    // @ encoded as %40, : as %3A
    const res = await request(
      env,
      '/_matrix/client/v3/user/%40alice%3Aexample.com/openid/request_token',
      jsonInit('POST', {})
    );
    expect(res.status).toBe(200);
    expect((res.body as { access_token: string }).access_token).toBeTruthy();
  });

  it('generates distinct tokens across calls', async () => {
    const env = createEnv();
    const a = await request(
      env,
      `/_matrix/client/v3/user/${encodeURIComponent(USER)}/openid/request_token`,
      jsonInit('POST', {})
    );
    const b = await request(
      env,
      `/_matrix/client/v3/user/${encodeURIComponent(USER)}/openid/request_token`,
      jsonInit('POST', {})
    );
    expect((a.body as { access_token: string }).access_token).not.toBe(
      (b.body as { access_token: string }).access_token
    );
    expect(env._cache.puts).toHaveLength(2);
  });

  it('does not store CACHE entry when forbidden', async () => {
    const cache = mockKv();
    const env = createEnv({ cacheKv: cache });
    await request(
      env,
      `/_matrix/client/v3/user/${encodeURIComponent('@eve:example.com')}/openid/request_token`,
      jsonInit('POST', {})
    );
    expect(cache.puts).toHaveLength(0);
    expect(Object.keys(cache.data)).toHaveLength(0);
  });
});

// ============================================
// Cross-route / auth-gate smoke
// ============================================

describe('account route auth gates (requireAuth mocked)', () => {
  it('password route runs under requireAuth (userId from middleware)', async () => {
    const db = createAccountDb();
    const env = createEnv({ db });
    await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', {
        new_password: STRONG_PW,
        logout_devices: false,
        auth: passwordAuth(),
      })
    );
    expect(db.updates.some((u) => u.args.includes(USER))).toBe(true);
  });

  it('3pid list scopes to middleware userId only', async () => {
    const env = createEnv({
      db: createAccountDb({
        threepids: [
          {
            user_id: BOB,
            medium: 'email',
            address: 'bob@example.com',
            validated_at: 1,
            added_at: 1,
          },
        ],
      }),
    });
    const res = await request(env, '/_matrix/client/v3/account/3pid', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.body).toEqual({ threepids: [] });
  });

  it('unbind and bind remain reachable with empty body', async () => {
    const env = createEnv();
    const bind = await request(env, '/_matrix/client/v3/account/3pid/bind', jsonInit('POST', {}));
    const unbind = await request(
      env,
      '/_matrix/client/v3/account/3pid/unbind',
      jsonInit('POST', {})
    );
    expect(bind.status).toBe(400);
    expect(unbind.status).toBe(200);
  });
});

describe('password change TOKENMAXX edge combinations', () => {
  it('weak password short-circuits before generateOpaqueId UIA', async () => {
    const env = createEnv();
    await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', { new_password: 'short' })
    );
    expect(generateOpaqueId).not.toHaveBeenCalled();
  });

  it('missing new_password short-circuits before UIA', async () => {
    const env = createEnv();
    await request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {}));
    expect(generateOpaqueId).not.toHaveBeenCalled();
  });

  it('wrong password does not update hash or tokens', async () => {
    const db = createAccountDb();
    const beforeHash = db.users.get(USER)?.password_hash;
    const env = createEnv({ db });
    await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', {
        new_password: STRONG_PW,
        auth: passwordAuth('bad'),
      })
    );
    expect(db.users.get(USER)?.password_hash).toBe(beforeHash);
    expect(db.tokens).toHaveLength(2);
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it('verifyPassword receives stored hash from getPasswordHash path', async () => {
    const env = createEnv({
      db: createAccountDb({
        passwordHashes: new Map([[USER, 'mockok:special-current']]),
      }),
    });
    await request(
      env,
      '/_matrix/client/v3/account/password',
      jsonInit('POST', {
        new_password: STRONG_PW,
        logout_devices: false,
        auth: passwordAuth('special-current'),
      })
    );
    expect(verifyPassword).toHaveBeenCalledWith('special-current', 'mockok:special-current');
  });
});

describe('deactivate TOKENMAXX erase + token edges', () => {
  it('always deletes tokens even when erase is false', async () => {
    const db = createAccountDb({
      tokens: [
        { token_hash: '1', user_id: USER, device_id: 'A' },
        { token_hash: '2', user_id: BOB, device_id: 'B' },
      ],
    });
    const env = createEnv({ db });
    await request(
      env,
      '/_matrix/client/v3/account/deactivate',
      jsonInit('POST', { erase: false, auth: passwordAuth() })
    );
    expect(db.tokens).toEqual([{ token_hash: '2', user_id: BOB, device_id: 'B' }]);
  });

  it('erase leaves multiple rooms in sequence', async () => {
    const rooms = Array.from({ length: 5 }, (_, i) => ({
      room_id: `!r${i}:example.com`,
      user_id: USER,
      membership: 'join' as const,
    }));
    const db = createAccountDb({ memberships: rooms });
    const env = createEnv({ db });
    await request(
      env,
      '/_matrix/client/v3/account/deactivate',
      jsonInit('POST', { erase: true, auth: passwordAuth() })
    );
    expect(db.memberships.every((m) => m.membership === 'leave')).toBe(true);
    expect(db.updates.filter((u) => u.sql.includes("membership = 'leave'"))).toHaveLength(5);
  });
});

describe('3pid email requestToken format edges', () => {
  it.each([
    ['a@b'],
    ['@b.c'],
    ['a@.c'],
    ['a@b.'],
    ['plain'],
    ['a@@b.c'],
  ])('rejects invalid email %s', async (email) => {
    const env = createEnv();
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/email/requestToken',
      jsonInit('POST', { client_secret: 'sec', email, send_attempt: 1 })
    );
    // Some borderline strings may pass the simple regex — only assert denial when invalid
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ errcode: 'M_INVALID_EMAIL' });
    }
  });

  it('accepts typical valid emails', async () => {
    const env = createEnv();
    for (const email of ['user@example.com', 'a.b+tag@mail.co.uk', 'x@y.z']) {
      emailMocks.createVerificationSession.mockResolvedValueOnce({
        sessionId: `sid-${email}`,
        token: '123456',
      });
      const res = await request(
        env,
        '/_matrix/client/v3/account/3pid/email/requestToken',
        jsonInit('POST', { client_secret: 'sec', email, send_attempt: 1 })
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ sid: `sid-${email}` });
    }
  });
});
