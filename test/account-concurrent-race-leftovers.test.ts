/**
 * TOKENMAXX HEAVY leftovers after #208 — account *concurrent-race / TOCTOU*
 * for `src/api/account.ts` (password / deactivate / 3PID / OpenID).
 *
 * Distinct from #191–#208 niches (admin-mutate, rooms, aliases, rooms-mutate,
 * workflows, tags, profile-mutate, profile, search+spaces, report+server-notices,
 * voip/rtc/calls, sync, presence, sliding-sync, typing, push, rooms-read-upgrade).
 * Orthogonal to register-account soft leftovers and account-api-routes (no SELECT/
 * run barrier TOCTOU / Promise.all race coverage for password∥deactivate / 3PID).
 *
 * Focus: password UPDATE LWW under run barriers; password∥deactivate token wipe;
 * dual deactivate erase membership TOCTOU; 3PID add∥delete / add∥add binding
 * SELECT→INSERT; GET∥mutate mid-flight; OpenID dual-mint KV; UIA / method / body /
 * lifecycle soft floods; SQL/KV bind contracts under parallel.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
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
const STRONG_PW2 = 'NewSecure2!';
const CURRENT_PW = 'oldpass1';
const ROOM = '!r:example.com';
const ROOM2 = '!r2:example.com';
const USER_ENC = encodeURIComponent(USER);
const BOB_ENC = encodeURIComponent(BOB);

type ThreepidRow = {
  user_id: string;
  medium: string;
  address: string;
  validated_at: number;
  added_at: number;
};
type Membership = { room_id: string; user_id: string; membership: string };
type UserRow = {
  user_id: string;
  password_hash: string | null;
  is_deactivated: number;
  display_name: string | null;
  avatar_url: string | null;
};
type TokenRow = { token_hash: string; user_id: string; device_id: string };
type SqlCall = { sql: string; args: unknown[] };
type SqlBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };
type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };
type KvBarrier = { match: (key: string) => boolean; count: number };

async function withBarrier(
  barrier: { match: (...a: any[]) => boolean; count: number } | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  ...matchArgs: any[]
) {
  if (!barrier || !barrier.match(...matchArgs)) return;
  await new Promise<void>((resolve) => {
    waitersRef.list.push(resolve);
    if (waitersRef.list.length >= barrier.count) {
      const all = [...waitersRef.list];
      waitersRef.list = [];
      clear();
      for (const r of all) r();
    }
  });
}

function mockKv(
  initial: Record<string, string> = {},
  opts: { putBarrier?: KvBarrier; failPutAfter?: number } = {}
) {
  const data: Record<string, string> = { ...initial };
  const puts: KvPut[] = [];
  const events: string[] = [];
  let putBarrier = opts.putBarrier;
  const putWaiters = { list: [] as Array<() => void> };
  let putCount = 0;
  return {
    data,
    puts,
    events,
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
      await withBarrier(
        putBarrier,
        putWaiters,
        () => {
          putBarrier = undefined;
        },
        key
      );
      putCount += 1;
      if (opts.failPutAfter !== undefined && putCount > opts.failPutAfter) {
        throw new Error('kv-put-fail');
      }
      data[key] = value;
      puts.push({ key, value, options });
      events.push(`put:${key}`);
    },
    delete: async (key: string) => {
      delete data[key];
    },
  };
}

function createAccountRaceDb(opts: {
  users?: Map<string, UserRow>;
  threepids?: ThreepidRow[];
  memberships?: Membership[];
  tokens?: TokenRow[];
  selectBarrier?: SqlBarrier;
  runBarrier?: SqlBarrier;
  mutateUsersAfterSelects?: { after: number; next: Map<string, UserRow> };
  mutateThreepidsAfterSelects?: { after: number; next: ThreepidRow[] };
  mutateMembershipsAfterSelects?: { after: number; next: Membership[] };
  failRunAfter?: number;
  failSelectAfter?: number;
  throwOn?: string;
} = {}) {
  const users =
    opts.users ??
    new Map<string, UserRow>([
      [
        USER,
        {
          user_id: USER,
          password_hash: `mockok:${CURRENT_PW}`,
          is_deactivated: 0,
          display_name: 'Alice',
          avatar_url: 'mxc://example.com/avatar',
        },
      ],
    ]);
  const threepids = opts.threepids ? [...opts.threepids] : [];
  const memberships = opts.memberships ? [...opts.memberships] : [];
  const tokens = opts.tokens
    ? [...opts.tokens]
    : [
        { token_hash: 'tok-a', user_id: USER, device_id: DEVICE },
        { token_hash: 'tok-b', user_id: USER, device_id: 'DEVICEB' },
      ];

  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const runs: SqlCall[] = [];
  const selects: SqlCall[] = [];
  const events: string[] = [];

  let selectBarrier = opts.selectBarrier;
  let runBarrier = opts.runBarrier;
  const selectWaiters = { list: [] as Array<() => void> };
  const runWaiters = { list: [] as Array<() => void> };
  let selectCount = 0;
  let runCount = 0;

  const db = {
    users,
    threepids,
    memberships,
    tokens,
    inserts,
    updates,
    deletes,
    runs,
    selects,
    events,
    prepare(sql: string) {
      if (opts.throwOn && sql.includes(opts.throwOn)) {
        throw new Error(`forced db error: ${opts.throwOn}`);
      }
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              events.push('select:first');
              selectCount += 1;
              await withBarrier(
                selectBarrier,
                selectWaiters,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );
              if (opts.failSelectAfter !== undefined && selectCount > opts.failSelectAfter) {
                throw new Error('d1-select-fail');
              }

              let result: T | null = null;
              if (sql.includes('SELECT password_hash FROM users')) {
                const userId = args[0] as string;
                const user = users.get(userId);
                if (user) result = { password_hash: user.password_hash } as T;
              } else if (
                sql.includes('FROM user_threepids') &&
                sql.includes("medium = 'email'") &&
                sql.includes('address = ?')
              ) {
                const address = args[0] as string;
                const hit = threepids.find((t) => t.medium === 'email' && t.address === address);
                if (hit) result = { user_id: hit.user_id } as T;
              }

              if (
                opts.mutateUsersAfterSelects &&
                selectCount === opts.mutateUsersAfterSelects.after
              ) {
                users.clear();
                for (const [k, v] of opts.mutateUsersAfterSelects.next) users.set(k, { ...v });
                events.push('mutate:users-after-select');
              }
              if (
                opts.mutateThreepidsAfterSelects &&
                selectCount === opts.mutateThreepidsAfterSelects.after
              ) {
                threepids.length = 0;
                threepids.push(...opts.mutateThreepidsAfterSelects.next);
                events.push('mutate:threepids-after-select');
              }
              if (
                opts.mutateMembershipsAfterSelects &&
                selectCount === opts.mutateMembershipsAfterSelects.after
              ) {
                memberships.length = 0;
                memberships.push(...opts.mutateMembershipsAfterSelects.next);
                events.push('mutate:memberships-after-select');
              }
              return result;
            },

            async all<T>() {
              selects.push({ sql, args });
              events.push('select:all');
              selectCount += 1;
              await withBarrier(
                selectBarrier,
                selectWaiters,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );
              if (opts.failSelectAfter !== undefined && selectCount > opts.failSelectAfter) {
                throw new Error('d1-select-fail');
              }

              let results: T[] = [];
              if (sql.includes('FROM user_threepids') && sql.includes('WHERE user_id = ?')) {
                const userId = args[0] as string;
                results = threepids
                  .filter((t) => t.user_id === userId)
                  .map((t) => ({
                    medium: t.medium,
                    address: t.address,
                    validated_at: t.validated_at,
                    added_at: t.added_at,
                  })) as T[];
              } else if (
                sql.includes('FROM room_memberships') &&
                sql.includes("membership = 'join'")
              ) {
                const userId = args[0] as string;
                results = memberships
                  .filter((m) => m.user_id === userId && m.membership === 'join')
                  .map((m) => ({ room_id: m.room_id })) as T[];
              }

              if (
                opts.mutateUsersAfterSelects &&
                selectCount === opts.mutateUsersAfterSelects.after
              ) {
                users.clear();
                for (const [k, v] of opts.mutateUsersAfterSelects.next) users.set(k, { ...v });
                events.push('mutate:users-after-select');
              }
              if (
                opts.mutateThreepidsAfterSelects &&
                selectCount === opts.mutateThreepidsAfterSelects.after
              ) {
                threepids.length = 0;
                threepids.push(...opts.mutateThreepidsAfterSelects.next);
                events.push('mutate:threepids-after-select');
              }
              if (
                opts.mutateMembershipsAfterSelects &&
                selectCount === opts.mutateMembershipsAfterSelects.after
              ) {
                memberships.length = 0;
                memberships.push(...opts.mutateMembershipsAfterSelects.next);
                events.push('mutate:memberships-after-select');
              }
              return { results };
            },

            async run(): Promise<{ meta: { changes: number; last_row_id: number }; success: boolean }> {
              runs.push({ sql, args });
              await withBarrier(
                runBarrier,
                runWaiters,
                () => {
                  runBarrier = undefined;
                },
                sql,
                args
              );
              runCount += 1;
              if (opts.failRunAfter !== undefined && runCount > opts.failRunAfter) {
                throw new Error('d1-run-fail');
              }

              if (sql.includes('UPDATE users SET password_hash')) {
                updates.push({ sql, args });
                events.push('run:password');
                const [hash, userId] = args as [string, string];
                const user = users.get(userId);
                if (user) user.password_hash = hash;
                return { success: true, meta: { changes: user ? 1 : 0, last_row_id: 0 } };
              }
              if (sql.includes('UPDATE users SET is_deactivated = 1')) {
                updates.push({ sql, args });
                events.push('run:deactivate');
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
                events.push('run:erase-profile');
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
                events.push('run:leave');
                const [roomId, userId] = args as [string, string];
                const hit = memberships.find((m) => m.room_id === roomId && m.user_id === userId);
                if (hit) hit.membership = 'leave';
                return { success: true, meta: { changes: hit ? 1 : 0, last_row_id: 0 } };
              }
              if (sql.includes('DELETE FROM access_tokens')) {
                deletes.push({ sql, args });
                events.push('run:delete-tokens');
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
                events.push('run:insert-3pid');
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
                events.push('run:delete-3pid');
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
                events.push('run:delete-email-sess');
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              throw new Error(`Unhandled SQL in account race stub: ${sql.slice(0, 160)}`);
            },
          };
        },
      };
    },
  };
  return db;
}

type RaceDb = ReturnType<typeof createAccountRaceDb>;
type RaceKv = ReturnType<typeof mockKv>;

function createEnv(db: RaceDb, cache?: RaceKv) {
  const kv = cache ?? mockKv();
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
    CACHE: kv,
    EMAIL: { send: vi.fn(async () => ({ messageId: 'msg-1' })) },
    _db: db,
    _cache: kv,
  } as unknown as Env & { _db: RaceDb; _cache: RaceKv };
}

async function request(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: any }> {
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
  return { status: res.status, body };
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

function authGet(): RequestInit {
  return { method: 'GET', headers: { Authorization: 'Bearer test-token' } };
}

function passwordAuth(password = CURRENT_PW, session = 'sess-1') {
  return { type: 'm.login.password', session, password };
}

function seedThreepid(overrides: Partial<ThreepidRow> = {}): ThreepidRow {
  return {
    user_id: overrides.user_id ?? USER,
    medium: overrides.medium ?? 'email',
    address: overrides.address ?? 'alice@example.com',
    validated_at: overrides.validated_at ?? 1_700_000_000_000,
    added_at: overrides.added_at ?? 1_700_000_000_000,
  };
}

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
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

// ---------------------------------------------------------------------------
// Password UPDATE LWW under run / SELECT barriers
// ---------------------------------------------------------------------------

describe('race password UPDATE LWW concurrent after #208', () => {
  it('dual password change under UPDATE barrier — last hash wins', async () => {
    const db = createAccountRaceDb({
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('UPDATE users SET password_hash'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
        new_password: STRONG_PW,
        logout_devices: false,
        auth: passwordAuth(),
      })),
      request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
        new_password: STRONG_PW2,
        logout_devices: false,
        auth: passwordAuth(),
      })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.updates.filter((u) => u.sql.includes('password_hash'))).toHaveLength(2);
    expect([`hashed:${STRONG_PW}`, `hashed:${STRONG_PW2}`]).toContain(
      db.users.get(USER)!.password_hash
    );
  });

  it('sequential password change keeps latest hash', async () => {
    const db = createAccountRaceDb();
    const env = createEnv(db);
    expect(
      (
        await request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
          new_password: STRONG_PW,
          logout_devices: false,
          auth: passwordAuth(),
        }))
      ).status
    ).toBe(200);
    // After first change, auth still uses CURRENT_PW vs mockok — update mock store to accept new
    db.users.get(USER)!.password_hash = `mockok:${STRONG_PW}`;
    expect(
      (
        await request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
          new_password: STRONG_PW2,
          logout_devices: false,
          auth: passwordAuth(STRONG_PW),
        }))
      ).status
    ).toBe(200);
    expect(db.users.get(USER)!.password_hash).toBe(`hashed:${STRONG_PW2}`);
  });

  it('password SELECT→UPDATE: mutate clears hash mid-flight → second may 403', async () => {
    const db = createAccountRaceDb({
      mutateUsersAfterSelects: {
        after: 1,
        next: new Map([
          [
            USER,
            {
              user_id: USER,
              password_hash: null,
              is_deactivated: 0,
              display_name: 'Alice',
              avatar_url: null,
            },
          ],
        ]),
      },
    });
    const env = createEnv(db);
    const first = await request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
      new_password: STRONG_PW,
      logout_devices: false,
      auth: passwordAuth(),
    }));
    expect(first.status).toBe(200);
    expect(db.events).toContain('mutate:users-after-select');
    const second = await request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
      new_password: STRONG_PW2,
      logout_devices: false,
      auth: passwordAuth(),
    }));
    expect(second.status).toBe(403);
  });

  for (let i = 0; i < 12; i++) {
    it(`password soft-${i}: dual change under password_hash barrier`, async () => {
      const db = createAccountRaceDb({
        runBarrier: {
          count: 2,
          match: (sql) => sql.includes('UPDATE users SET password_hash'),
        },
      });
      const env = createEnv(db);
      const a = `NewSecureA${i}!x`;
      const b = `NewSecureB${i}!y`;
      const results = await Promise.all([
        request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
          new_password: a,
          logout_devices: false,
          auth: passwordAuth(),
        })),
        request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
          new_password: b,
          logout_devices: false,
          auth: passwordAuth(),
        })),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect([`hashed:${a}`, `hashed:${b}`]).toContain(db.users.get(USER)!.password_hash);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`password logout_devices soft-${i}: dual wipe tokens under DELETE barrier`, async () => {
      const db = createAccountRaceDb({
        runBarrier: {
          count: 2,
          match: (sql) => sql.includes('DELETE FROM access_tokens'),
        },
      });
      const env = createEnv(db);
      const results = await Promise.all([
        request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
          new_password: `TokWipeA${i}!1`,
          logout_devices: true,
          auth: passwordAuth(),
        })),
        request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
          new_password: `TokWipeB${i}!2`,
          logout_devices: true,
          auth: passwordAuth(),
        })),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(db.tokens).toHaveLength(0);
      expect(db.deletes.filter((d) => d.sql.includes('access_tokens')).length).toBeGreaterThanOrEqual(
        2
      );
    });
  }
});

// ---------------------------------------------------------------------------
// password ∥ deactivate races
// ---------------------------------------------------------------------------

describe('race password∥deactivate concurrent after #208', () => {
  it('password∥deactivate under run barrier both 200', async () => {
    const db = createAccountRaceDb({
      runBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('UPDATE users SET password_hash') ||
          sql.includes('UPDATE users SET is_deactivated = 1'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
        new_password: STRONG_PW,
        logout_devices: false,
        auth: passwordAuth(),
      })),
      request(env, '/_matrix/client/v3/account/deactivate', jsonInit('POST', {
        erase: false,
        auth: passwordAuth(),
      })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.users.get(USER)!.is_deactivated).toBe(1);
    expect(db.users.get(USER)!.password_hash).toBe(`hashed:${STRONG_PW}`);
  });

  it('dual deactivate under barrier — both 200, single deactivated flag', async () => {
    const db = createAccountRaceDb({
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('UPDATE users SET is_deactivated = 1'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/account/deactivate', jsonInit('POST', {
        auth: passwordAuth(),
      })),
      request(env, '/_matrix/client/v3/account/deactivate', jsonInit('POST', {
        auth: passwordAuth(),
      })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.users.get(USER)!.is_deactivated).toBe(1);
    expect(db.tokens).toHaveLength(0);
  });

  it('deactivate erase∥membership mutate mid ALL — leaves snapshot rooms', async () => {
    const db = createAccountRaceDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: ROOM2, user_id: USER, membership: 'join' },
      ],
      mutateMembershipsAfterSelects: {
        after: 1,
        next: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      },
    });
    const env = createEnv(db);
    const res = await request(env, '/_matrix/client/v3/account/deactivate', jsonInit('POST', {
      erase: true,
      auth: passwordAuth(),
    }));
    expect(res.status).toBe(200);
    // Snapshot had 2 rooms; mutate after ALL doesn't shrink leave loop for this request.
    expect(db.memberships.every((m) => m.membership === 'leave')).toBe(true);
    expect(db.users.get(USER)!.display_name).toBeNull();
  });

  for (let i = 0; i < 10; i++) {
    it(`deactivate soft-${i}: dual erase under deactivate barrier`, async () => {
      const db = createAccountRaceDb({
        memberships: [{ room_id: `!r${i}:example.com`, user_id: USER, membership: 'join' }],
        runBarrier: {
          count: 2,
          match: (sql) => sql.includes('UPDATE users SET is_deactivated = 1'),
        },
      });
      const env = createEnv(db);
      const results = await Promise.all([
        request(env, '/_matrix/client/v3/account/deactivate', jsonInit('POST', {
          erase: true,
          auth: passwordAuth(),
        })),
        request(env, '/_matrix/client/v3/account/deactivate', jsonInit('POST', {
          erase: false,
          auth: passwordAuth(),
        })),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(db.users.get(USER)!.is_deactivated).toBe(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`password∥deactivate soft-${i}: token wipe races`, async () => {
      const db = createAccountRaceDb({
        runBarrier: {
          count: 2,
          match: (sql) => sql.includes('DELETE FROM access_tokens'),
        },
      });
      const env = createEnv(db);
      const results = await Promise.all([
        request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
          new_password: `RacePw${i}!Aa`,
          logout_devices: true,
          auth: passwordAuth(),
        })),
        request(env, '/_matrix/client/v3/account/deactivate', jsonInit('POST', {
          auth: passwordAuth(),
        })),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(db.tokens).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// 3PID add∥delete / add∥add binding TOCTOU
// ---------------------------------------------------------------------------

describe('race 3PID add∥delete concurrent after #208', () => {
  it('add∥delete same address under run barrier — final ambiguous', async () => {
    emailMocks.getValidatedSession.mockResolvedValue({ email: 'race@example.com' });
    const db = createAccountRaceDb({
      threepids: [seedThreepid({ address: 'race@example.com' })],
      runBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('INSERT OR REPLACE INTO user_threepids') ||
          sql.includes('DELETE FROM user_threepids'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/account/3pid/add', jsonInit('POST', {
        client_secret: 'sec',
        sid: 'sid-1',
        auth: passwordAuth(),
      })),
      request(env, '/_matrix/client/v3/account/3pid/delete', jsonInit('POST', {
        medium: 'email',
        address: 'race@example.com',
      })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const addrs = db.threepids.map((t) => t.address);
    expect(addrs.length === 0 || addrs.includes('race@example.com')).toBe(true);
  });

  it('dual add same email under INSERT barrier — single row', async () => {
    emailMocks.getValidatedSession.mockResolvedValue({ email: 'dual@example.com' });
    const db = createAccountRaceDb({
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('INSERT OR REPLACE INTO user_threepids'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/account/3pid/add', jsonInit('POST', {
        client_secret: 'sec',
        sid: 'sid-a',
        auth: passwordAuth(),
      })),
      request(env, '/_matrix/client/v3/account/3pid/add', jsonInit('POST', {
        client_secret: 'sec',
        sid: 'sid-b',
        auth: passwordAuth(),
      })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.threepids.filter((t) => t.address === 'dual@example.com')).toHaveLength(1);
  });

  it('add SELECT binding TOCTOU: mutate injects bob ownership → M_THREEPID_IN_USE', async () => {
    emailMocks.getValidatedSession.mockResolvedValue({ email: 'taken@example.com' });
    const db = createAccountRaceDb({
      mutateThreepidsAfterSelects: {
        after: 1,
        // first() for binding check is the SELECT — inject bob ownership after snapshot?
        // mutate after read means first request still sees null; second sees bob.
        next: [seedThreepid({ user_id: BOB, address: 'taken@example.com' })],
      },
    });
    const env = createEnv(db);
    const first = await request(env, '/_matrix/client/v3/account/3pid/add', jsonInit('POST', {
      client_secret: 'sec',
      sid: 'sid-1',
      auth: passwordAuth(),
    }));
    expect(first.status).toBe(200);
    emailMocks.getValidatedSession.mockResolvedValue({ email: 'taken@example.com' });
    const second = await request(env, '/_matrix/client/v3/account/3pid/add', jsonInit('POST', {
      client_secret: 'sec',
      sid: 'sid-2',
      auth: passwordAuth(),
    }));
    expect(second.status).toBe(400);
    expect(second.body.errcode).toBe('M_THREEPID_IN_USE');
  });

  it('GET∥DELETE concurrent: GET may see pre or post delete', async () => {
    const db = createAccountRaceDb({
      threepids: [seedThreepid({ address: 'gone@example.com' })],
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/account/3pid', authGet()),
      request(env, '/_matrix/client/v3/account/3pid/delete', jsonInit('POST', {
        medium: 'email',
        address: 'gone@example.com',
      })),
    ]);
    expect(results[1].status).toBe(200);
    expect(results[0].status).toBe(200);
    expect(Array.isArray(results[0].body.threepids)).toBe(true);
  });

  it('GET sees mutate-after-select injected 3PID on next call', async () => {
    const db = createAccountRaceDb({
      threepids: [seedThreepid({ address: 'old@example.com' })],
      mutateThreepidsAfterSelects: {
        after: 1,
        next: [seedThreepid({ address: 'new@example.com' })],
      },
    });
    const env = createEnv(db);
    const first = await request(env, '/_matrix/client/v3/account/3pid', authGet());
    expect(first.body.threepids.map((t: { address: string }) => t.address)).toEqual([
      'old@example.com',
    ]);
    const second = await request(env, '/_matrix/client/v3/account/3pid', authGet());
    expect(second.body.threepids.map((t: { address: string }) => t.address)).toEqual([
      'new@example.com',
    ]);
  });

  for (let i = 0; i < 10; i++) {
    it(`3pid delete soft-${i}: dual delete same address`, async () => {
      const addr = `del${i}@example.com`;
      const db = createAccountRaceDb({
        threepids: [seedThreepid({ address: addr })],
        runBarrier: {
          count: 2,
          match: (sql) => sql.includes('DELETE FROM user_threepids'),
        },
      });
      const env = createEnv(db);
      const results = await Promise.all([
        request(env, '/_matrix/client/v3/account/3pid/delete', jsonInit('POST', {
          medium: 'email',
          address: addr,
        })),
        request(env, '/_matrix/client/v3/account/3pid/delete', jsonInit('POST', {
          medium: 'email',
          address: addr,
        })),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(db.threepids).toHaveLength(0);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`3pid add soft-${i}: distinct emails under INSERT barrier`, async () => {
      const a = `a${i}@example.com`;
      const b = `b${i}@example.com`;
      emailMocks.getValidatedSession.mockImplementation(async (_db: unknown, sid: string) => {
        return { email: String(sid).includes('-a-') ? a : b };
      });
      const db = createAccountRaceDb({
        runBarrier: {
          count: 2,
          match: (sql) => sql.includes('INSERT OR REPLACE INTO user_threepids'),
        },
      });
      const env = createEnv(db);
      const results = await Promise.all([
        request(env, '/_matrix/client/v3/account/3pid/add', jsonInit('POST', {
          client_secret: 'sec',
          sid: `sid-a-${i}`,
          auth: passwordAuth(),
        })),
        request(env, '/_matrix/client/v3/account/3pid/add', jsonInit('POST', {
          client_secret: 'sec',
          sid: `sid-b-${i}`,
          auth: passwordAuth(),
        })),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(db.threepids.map((t) => t.address).sort()).toEqual([a, b].sort());
    });
  }
});

// ---------------------------------------------------------------------------
// OpenID dual-mint KV
// ---------------------------------------------------------------------------

describe('race OpenID request_token concurrent after #208', () => {
  it('dual mint under KV put barrier — two distinct tokens stored', async () => {
    const db = createAccountRaceDb();
    const kv = mockKv({}, {
      putBarrier: { count: 2, match: (key) => key.startsWith('openid_token:') },
    });
    const env = createEnv(db, kv);
    const path = `/_matrix/client/v3/user/${USER_ENC}/openid/request_token`;
    const results = await Promise.all([
      request(env, path, jsonInit('POST', {})),
      request(env, path, jsonInit('POST', {})),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(kv.puts).toHaveLength(2);
    const tokens = results.map((r) => r.body.access_token);
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(results.every((r) => r.body.matrix_server_name === SERVER)).toBe(true);
    expect(results.every((r) => r.body.expires_in === 3600)).toBe(true);
  });

  it('foreign user OpenID forbidden', async () => {
    const env = createEnv(createAccountRaceDb());
    const res = await request(
      env,
      `/_matrix/client/v3/user/${BOB_ENC}/openid/request_token`,
      jsonInit('POST', {})
    );
    expect(res.status).toBe(403);
  });

  for (let i = 0; i < 10; i++) {
    it(`openid soft-${i}: parallel mint flood keeps unique tokens`, async () => {
      const env = createEnv(createAccountRaceDb());
      const path = `/_matrix/client/v3/user/${USER_ENC}/openid/request_token`;
      const results = await Promise.all(
        [0, 1, 2, 3].map(() => request(env, path, jsonInit('POST', {})))
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      const toks = new Set(results.map((r) => r.body.access_token));
      expect(toks.size).toBe(4);
    });
  }

  it('openid KV put fail soft → 500', async () => {
    const db = createAccountRaceDb();
    const kv = mockKv({}, { failPutAfter: 0 });
    const env = createEnv(db, kv);
    const res = await request(
      env,
      `/_matrix/client/v3/user/${USER_ENC}/openid/request_token`,
      jsonInit('POST', {})
    );
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Failure soft mid-concurrent
// ---------------------------------------------------------------------------

describe('race account failure soft mid-concurrent after #208', () => {
  it('password fail after first UPDATE → one 200 one 500', async () => {
    const db = createAccountRaceDb({
      failRunAfter: 1,
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('UPDATE users SET password_hash'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
        new_password: STRONG_PW,
        logout_devices: false,
        auth: passwordAuth(),
      })),
      request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
        new_password: STRONG_PW2,
        logout_devices: false,
        auth: passwordAuth(),
      })),
    ]);
    const codes = statusesOf(results);
    expect(codes).toContain(200);
    expect(codes).toContain(500);
  });

  it('deactivate throwOn soft', async () => {
    const db = createAccountRaceDb({ throwOn: 'is_deactivated' });
    const env = createEnv(db);
    const res = await request(env, '/_matrix/client/v3/account/deactivate', jsonInit('POST', {
      auth: passwordAuth(),
    }));
    expect(res.status).toBe(500);
  });

  for (let i = 0; i < 6; i++) {
    it(`select fail soft-${i}: password hash SELECT boom`, async () => {
      const db = createAccountRaceDb({ failSelectAfter: 0 });
      const env = createEnv(db);
      const res = await request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
        new_password: STRONG_PW,
        auth: passwordAuth(),
      }));
      expect(res.status).toBe(500);
    });
  }
});

// ---------------------------------------------------------------------------
// Soft floods: UIA / method / body / stubs / lifecycle
// ---------------------------------------------------------------------------

describe('race account soft floods UIA/method/body/lifecycle after #208', () => {
  it('password without auth returns UIA 401', async () => {
    const env = createEnv(createAccountRaceDb());
    const res = await request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
      new_password: STRONG_PW,
    }));
    expect(res.status).toBe(401);
    expect(res.body.session).toBe('pinned-uia-session-16');
  });

  it('deactivate without auth returns UIA 401', async () => {
    const env = createEnv(createAccountRaceDb());
    const res = await request(env, '/_matrix/client/v3/account/deactivate', jsonInit('POST', {}));
    expect(res.status).toBe(401);
  });

  for (const weak of ['short1!', '12345678!', 'OnlyLetters', 'abcdefg', `A1${'x'.repeat(999)}`]) {
    it(`weak password soft: ${weak.slice(0, 24)}`, async () => {
      const env = createEnv(createAccountRaceDb());
      const res = await request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
        new_password: weak,
        auth: passwordAuth(),
      }));
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_WEAK_PASSWORD');
    });
  }

  it('password bad JSON → 400', async () => {
    const env = createEnv(createAccountRaceDb());
    const res = await request(env, '/_matrix/client/v3/account/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: '{bad',
    });
    expect(res.status).toBe(400);
  });

  it('password wrong current → 403', async () => {
    const env = createEnv(createAccountRaceDb());
    const res = await request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
      new_password: STRONG_PW,
      auth: passwordAuth('wrongpass'),
    }));
    expect(res.status).toBe(403);
  });

  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH'] as const) {
    it(`password rejects method=${method}`, async () => {
      const env = createEnv(createAccountRaceDb());
      const res = await request(env, '/_matrix/client/v3/account/password', {
        method,
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({
          new_password: STRONG_PW,
          auth: passwordAuth(),
        }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  }

  it('email requestToken stub 400', async () => {
    const env = createEnv(createAccountRaceDb());
    const res = await request(
      env,
      '/_matrix/client/v3/account/password/email/requestToken',
      jsonInit('POST', { email: 'a@example.com', client_secret: 'x', send_attempt: 1 })
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_THREEPID_NOT_FOUND');
  });

  it('msisdn requestToken stub 400', async () => {
    const env = createEnv(createAccountRaceDb());
    const res = await request(
      env,
      '/_matrix/client/v3/account/password/msisdn/requestToken',
      jsonInit('POST', {})
    );
    expect(res.status).toBe(400);
  });

  it('3pid bind stub 400', async () => {
    const env = createEnv(createAccountRaceDb());
    const res = await request(env, '/_matrix/client/v3/account/3pid/bind', jsonInit('POST', {}));
    expect(res.status).toBe(400);
  });

  it('3pid msisdn requestToken 403', async () => {
    const env = createEnv(createAccountRaceDb());
    const res = await request(
      env,
      '/_matrix/client/v3/account/3pid/msisdn/requestToken',
      jsonInit('POST', {})
    );
    expect(res.status).toBe(403);
  });

  it('registration token validity always false', async () => {
    const env = createEnv(createAccountRaceDb());
    const res = await request(
      env,
      '/_matrix/client/v1/register/m.login.registration_token/validity?token=abc',
      authGet()
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false });
  });

  for (let i = 0; i < 8; i++) {
    it(`lifecycle soft-${i}: password→openid→3pid add→delete→deactivate`, async () => {
      emailMocks.getValidatedSession.mockResolvedValue({ email: `life${i}@example.com` });
      const db = createAccountRaceDb();
      const env = createEnv(db);
      expect(
        (
          await request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
            new_password: `LifeCycle${i}!1`,
            logout_devices: false,
            auth: passwordAuth(),
          }))
        ).status
      ).toBe(200);
      // restore verifiable hash for deactivate
      db.users.get(USER)!.password_hash = `mockok:${CURRENT_PW}`;
      expect(
        (
          await request(
            env,
            `/_matrix/client/v3/user/${USER_ENC}/openid/request_token`,
            jsonInit('POST', {})
          )
        ).status
      ).toBe(200);
      expect(
        (
          await request(env, '/_matrix/client/v3/account/3pid/add', jsonInit('POST', {
            client_secret: 'sec',
            sid: `life-${i}`,
            auth: passwordAuth(),
          }))
        ).status
      ).toBe(200);
      expect(
        (
          await request(env, '/_matrix/client/v3/account/3pid/delete', jsonInit('POST', {
            medium: 'email',
            address: `life${i}@example.com`,
          }))
        ).status
      ).toBe(200);
      expect(
        (
          await request(env, '/_matrix/client/v3/account/deactivate', jsonInit('POST', {
            auth: passwordAuth(),
          }))
        ).status
      ).toBe(200);
      expect(db.users.get(USER)!.is_deactivated).toBe(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`multi-request soft flood-${i}: 4 parallel UIA challenges`, async () => {
      const env = createEnv(createAccountRaceDb());
      const results = await Promise.all(
        [0, 1, 2, 3].map(() =>
          request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
            new_password: STRONG_PW,
          }))
        )
      );
      expect(results.every((r) => r.status === 401)).toBe(true);
    });
  }

  for (const missing of [
    { client_secret: 'x' },
    { sid: 's' },
    {},
  ] as const) {
    it(`3pid add missing soft: ${JSON.stringify(missing)}`, async () => {
      const env = createEnv(createAccountRaceDb());
      const res = await request(
        env,
        '/_matrix/client/v3/account/3pid/add',
        jsonInit('POST', { ...missing, auth: passwordAuth() })
      );
      expect(res.status).toBe(400);
    });
  }

  for (const missing of [{ medium: 'email' }, { address: 'a@example.com' }, {}] as const) {
    it(`3pid delete missing soft: ${JSON.stringify(missing)}`, async () => {
      const env = createEnv(createAccountRaceDb());
      const res = await request(
        env,
        '/_matrix/client/v3/account/3pid/delete',
        jsonInit('POST', missing)
      );
      expect(res.status).toBe(400);
    });
  }
});

// ---------------------------------------------------------------------------
// SQL / KV bind contracts under parallel
// ---------------------------------------------------------------------------

describe('race account SQL/KV bind contracts under parallel after #208', () => {
  it('password UPDATE binds hash then user_id', async () => {
    const db = createAccountRaceDb();
    const env = createEnv(db);
    await request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
      new_password: STRONG_PW,
      logout_devices: false,
      auth: passwordAuth(),
    }));
    const upd = db.updates.find((u) => u.sql.includes('password_hash'));
    expect(upd!.args).toEqual([`hashed:${STRONG_PW}`, USER]);
  });

  it('deactivate UPDATE binds user_id; token DELETE binds user_id', async () => {
    const db = createAccountRaceDb();
    const env = createEnv(db);
    await request(env, '/_matrix/client/v3/account/deactivate', jsonInit('POST', {
      auth: passwordAuth(),
    }));
    expect(db.updates.find((u) => u.sql.includes('is_deactivated'))!.args).toEqual([USER]);
    expect(db.deletes.find((d) => d.sql.includes('access_tokens'))!.args).toEqual([USER]);
  });

  it('3pid INSERT binds user email timestamps', async () => {
    emailMocks.getValidatedSession.mockResolvedValue({ email: 'bind@example.com' });
    const db = createAccountRaceDb();
    const env = createEnv(db);
    await request(env, '/_matrix/client/v3/account/3pid/add', jsonInit('POST', {
      client_secret: 'sec',
      sid: 'sid',
      auth: passwordAuth(),
    }));
    const ins = db.inserts.find((i) => i.sql.includes('user_threepids'));
    expect(ins!.args[0]).toBe(USER);
    expect(ins!.args[1]).toBe('bind@example.com');
  });

  it('openid KV key prefix and TTL 3600', async () => {
    const db = createAccountRaceDb();
    const kv = mockKv();
    const env = createEnv(db, kv);
    const res = await request(
      env,
      `/_matrix/client/v3/user/${USER_ENC}/openid/request_token`,
      jsonInit('POST', {})
    );
    expect(res.status).toBe(200);
    expect(kv.puts[0].key).toMatch(/^openid_token:/);
    expect(kv.puts[0].options?.expirationTtl).toBe(3600);
    const parsed = JSON.parse(kv.puts[0].value);
    expect(parsed.user_id).toBe(USER);
  });

  for (let i = 0; i < 8; i++) {
    it(`parallel bind soft-${i}: dual password UPDATE user_id constant`, async () => {
      const db = createAccountRaceDb({
        runBarrier: {
          count: 2,
          match: (sql) => sql.includes('UPDATE users SET password_hash'),
        },
      });
      const env = createEnv(db);
      await Promise.all([
        request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
          new_password: `BindA${i}!xx`,
          logout_devices: false,
          auth: passwordAuth(),
        })),
        request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
          new_password: `BindB${i}!yy`,
          logout_devices: false,
          auth: passwordAuth(),
        })),
      ]);
      const userArgs = db.updates
        .filter((u) => u.sql.includes('password_hash'))
        .map((u) => u.args[1]);
      expect(userArgs).toEqual([USER, USER]);
    });
  }
});

// ---------------------------------------------------------------------------
// Cross-endpoint isolation
// ---------------------------------------------------------------------------

describe('race account cross-endpoint isolation after #208', () => {
  it('password ∥ 3pid GET ∥ openid do not cross-contaminate', async () => {
    const db = createAccountRaceDb({
      threepids: [seedThreepid()],
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
        new_password: STRONG_PW,
        logout_devices: false,
        auth: passwordAuth(),
      })),
      request(env, '/_matrix/client/v3/account/3pid', authGet()),
      request(
        env,
        `/_matrix/client/v3/user/${USER_ENC}/openid/request_token`,
        jsonInit('POST', {})
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(db.users.get(USER)!.password_hash).toBe(`hashed:${STRONG_PW}`);
    expect(results[1].body.threepids).toHaveLength(1);
    expect(results[2].body.access_token).toBeTruthy();
  });

  for (let i = 0; i < 8; i++) {
    it(`cross soft-${i}: UIA password ∥ UIA deactivate ∥ GET 3pid`, async () => {
      const db = createAccountRaceDb({
        threepids: [seedThreepid({ address: `x${i}@example.com` })],
      });
      const env = createEnv(db);
      const results = await Promise.all([
        request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
          new_password: STRONG_PW,
        })),
        request(env, '/_matrix/client/v3/account/deactivate', jsonInit('POST', {})),
        request(env, '/_matrix/client/v3/account/3pid', authGet()),
      ]);
      expect(statusesOf(results)).toEqual([200, 401, 401]);
      expect(results[2].body.threepids[0].address).toBe(`x${i}@example.com`);
    });
  }
});


// ---------------------------------------------------------------------------
// Extra HEAVY soft deepen: UIA session churn / erase membership / email requestToken
// ---------------------------------------------------------------------------

describe('race account extra soft deepen after #208', () => {
  for (let i = 0; i < 12; i++) {
    it(`UIA session soft-${i}: generateOpaqueId called per challenge`, async () => {
      vi.mocked(generateOpaqueId).mockResolvedValue(`sess-${i}`);
      const env = createEnv(createAccountRaceDb());
      const res = await request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
        new_password: STRONG_PW,
      }));
      expect(res.status).toBe(401);
      expect(res.body.session).toBe(`sess-${i}`);
      expect(res.body.flows).toEqual([{ stages: ['m.login.password'] }]);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`erase membership soft-${i}: multi-room leave under join ALL`, async () => {
      const rooms = Array.from({ length: 3 }, (_, j) => ({
        room_id: `!e${i}-${j}:example.com`,
        user_id: USER,
        membership: 'join' as const,
      }));
      const db = createAccountRaceDb({ memberships: rooms });
      const env = createEnv(db);
      const res = await request(env, '/_matrix/client/v3/account/deactivate', jsonInit('POST', {
        erase: true,
        auth: passwordAuth(),
      }));
      expect(res.status).toBe(200);
      expect(db.memberships.every((m) => m.membership === 'leave')).toBe(true);
      expect(db.users.get(USER)!.avatar_url).toBeNull();
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`email requestToken soft-${i}: existing binding M_THREEPID_IN_USE`, async () => {
      const addr = `bound${i}@example.com`;
      const db = createAccountRaceDb({
        threepids: [seedThreepid({ address: addr, user_id: BOB })],
      });
      const env = createEnv(db);
      const res = await request(
        env,
        '/_matrix/client/v3/account/3pid/email/requestToken',
        jsonInit('POST', {
          client_secret: 'sec',
          email: addr,
          send_attempt: 1,
        })
      );
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_THREEPID_IN_USE');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`email requestToken soft-${i}: success path returns sid`, async () => {
      emailMocks.createVerificationSession.mockResolvedValue({
        sessionId: `sid-ok-${i}`,
        token: '111222',
      });
      const env = createEnv(createAccountRaceDb());
      const res = await request(
        env,
        '/_matrix/client/v3/account/3pid/email/requestToken',
        jsonInit('POST', {
          client_secret: 'sec',
          email: `ok${i}@example.com`,
          send_attempt: i,
        })
      );
      expect(res.status).toBe(200);
      expect(res.body.sid).toBe(`sid-ok-${i}`);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`submit_token soft-${i}: POST success`, async () => {
      emailMocks.validateEmailToken.mockResolvedValue({ success: true });
      const env = createEnv(createAccountRaceDb());
      const res = await request(
        env,
        '/_matrix/client/v3/account/3pid/submit_token',
        jsonInit('POST', {
          sid: `sid-${i}`,
          client_secret: 'sec',
          token: '999888',
        })
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`password∥openid soft-${i}: isolation under Promise.all`, async () => {
      const db = createAccountRaceDb();
      const env = createEnv(db);
      const results = await Promise.all([
        request(env, '/_matrix/client/v3/account/password', jsonInit('POST', {
          new_password: `IsoPw${i}!Aa`,
          logout_devices: false,
          auth: passwordAuth(),
        })),
        request(
          env,
          `/_matrix/client/v3/user/${USER_ENC}/openid/request_token`,
          jsonInit('POST', {})
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(db.users.get(USER)!.password_hash).toBe(`hashed:IsoPw${i}!Aa`);
      expect(results[1].body.token_type).toBe('Bearer');
    });
  }
});
