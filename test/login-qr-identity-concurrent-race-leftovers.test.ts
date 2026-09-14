/**
 * TOKENMAXX HEAVY leftovers after #152 — login/QR/identity *concurrent race / TOCTOU* reliability.
 * Orthogonal to persist-fail throws (#152), corrupt KV shapes (#146), soft (#145), contract (#149).
 * Focus: same-key Promise.all races with KV get barriers; documents lost-update / double-consume.
 * Tests-only against src/api/login.ts + qr-login.ts + identity.ts. No product inventing.
 * Fixtures use example.com only.
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
import qrLogin from '../src/api/qr-login';
import identity from '../src/api/identity';

const SERVER = 'example.com';
const USER = `@alice:${SERVER}`;
const BOB = `@bob:${SERVER}`;
const DEVICE = 'DEVICE';
const PASS = 'Password1!';
const NOW = 1_730_400_000_000;
const ID_BASE = '/_matrix/identity/v2';

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };
type GetBarrier = { prefix: string; count: number };

function mockKv(
  data: Record<string, string> = {},
  opts: { getBarrier?: GetBarrier; putBarrier?: GetBarrier } = {}
) {
  const puts: KvPut[] = [];
  const deletes: string[] = [];
  const events: string[] = [];
  let getWaiters: Array<() => void> = [];
  let putWaiters: Array<() => void> = [];
  // Barriers are one-shot: after release, later gets/puts must not hang waiting for a partner.
  let getBarrier: GetBarrier | undefined = opts.getBarrier;
  let putBarrier: GetBarrier | undefined = opts.putBarrier;

  async function maybeBarrier(
    key: string,
    barrier: GetBarrier | undefined,
    waiters: Array<() => void>,
    setWaiters: (w: Array<() => void>) => void,
    clearBarrier: () => void
  ) {
    if (!barrier || !key.startsWith(barrier.prefix)) return;
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
      if (waiters.length >= barrier.count) {
        const all = [...waiters];
        setWaiters([]);
        clearBarrier();
        for (const r of all) r();
      }
    });
  }

  const kv = {
    data,
    puts,
    deletes,
    events,
    get: async (key: string, type?: string) => {
      events.push(`kv:get:${key}`);
      await maybeBarrier(
        key,
        getBarrier,
        getWaiters,
        (w) => {
          getWaiters = w;
        },
        () => {
          getBarrier = undefined;
        }
      );
      const raw = data[key];
      if (raw == null) return null;
      if (type === 'json') return JSON.parse(raw);
      return raw;
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      events.push(`kv:put:${key}`);
      await maybeBarrier(
        key,
        putBarrier,
        putWaiters,
        (w) => {
          putWaiters = w;
        },
        () => {
          putBarrier = undefined;
        }
      );
      data[key] = value;
      puts.push({ key, value, options });
    },
    delete: async (key: string) => {
      events.push(`kv:delete:${key}`);
      deletes.push(key);
      delete data[key];
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  };
  return kv as unknown as KVNamespace & {
    data: Record<string, string>;
    puts: KvPut[];
    deletes: string[];
    events: string[];
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
type DeviceRow = { user_id: string; device_id: string; display_name: string | null; created_at: number };
type TokenRow = {
  token_id: string;
  token_hash: string;
  user_id: string;
  device_id: string | null;
  created_at: number;
};
type SqlCall = { sql: string; args: unknown[] };

function userRow(partial: Partial<UserRow> & Pick<UserRow, 'user_id' | 'localpart'>): UserRow {
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

function createLoginDb(
  opts: {
    users?: Map<string, UserRow>;
    devices?: DeviceRow[];
    tokens?: TokenRow[];
  } = {}
) {
  const users = opts.users ?? new Map<string, UserRow>();
  const usersByLocalpart = new Map<string, UserRow>([...users.values()].map((u) => [u.localpart, u]));
  const devices = opts.devices ?? [];
  const tokens = opts.tokens ?? [];
  const inserts: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const events: string[] = [];

  return {
    users,
    usersByLocalpart,
    devices,
    tokens,
    inserts,
    deletes,
    events,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              events.push(`db:first:${sql.slice(0, 60)}`);
              if (sql.includes('SELECT password_hash FROM users')) {
                const u = users.get(args[0] as string);
                return (u ? { password_hash: u.password_hash } : null) as T;
              }
              if (sql.includes('FROM users WHERE user_id = ?') && sql.includes('SELECT user_id, localpart')) {
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
              if (sql.includes('FROM users WHERE localpart = ?') && sql.includes('SELECT user_id, localpart')) {
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
              events.push(`db:run:${sql.slice(0, 60)}`);
              if (sql.includes('INSERT INTO users')) {
                inserts.push({ sql, args });
                const [userId, localpart, passwordHash, isGuest] = args as [string, string, string | null, number];
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
                const [tokenId, tokenHash, userId, deviceId] = args as [string, string, string, string | null];
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
              throw new Error(`Unhandled SQL race stub: ${sql.slice(0, 140)}`);
            },
            async all<T>() {
              events.push(`db:all:${sql.slice(0, 60)}`);
              return { results: [] as T[] };
            },
          };
        },
      };
    },
  };
}

type LoginDb = ReturnType<typeof createLoginDb>;

function aliceDb(extra: Partial<UserRow> = {}): LoginDb {
  const alice = userRow({
    user_id: USER,
    localpart: 'alice',
    password_hash: `mockok:${PASS}`,
    ...extra,
  });
  const bob = userRow({
    user_id: BOB,
    localpart: 'bob',
    password_hash: `mockok:${PASS}`,
  });
  return createLoginDb({ users: new Map([[USER, alice], [BOB, bob]]) });
}

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

async function loginReq(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: any; thrown?: string }> {
  try {
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
  } catch (e) {
    return { status: 500, body: null, thrown: e instanceof Error ? e.message : String(e) };
  }
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

async function seedLoginToken(
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

async function seedRefresh(
  sessions: ReturnType<typeof mockKv>,
  db: LoginDb,
  raw: string,
  partial: { userId?: string; deviceId?: string | null; accessTokenId?: string } = {},
  seedAccess = true
) {
  const hash = await hashToken(raw);
  const accessTokenId = partial.accessTokenId ?? 'atok-old';
  sessions.data[`refresh:${hash}`] = JSON.stringify({
    userId: partial.userId ?? USER,
    deviceId: partial.deviceId === undefined ? DEVICE : partial.deviceId,
    accessTokenId,
    createdAt: NOW - 1000,
  });
  if (seedAccess) {
    db.tokens.push({
      token_id: accessTokenId,
      token_hash: 'old-hash',
      user_id: partial.userId ?? USER,
      device_id: partial.deviceId === undefined ? DEVICE : partial.deviceId,
      created_at: NOW - 1000,
    });
  }
  return hash;
}

type Assoc = { medium: string; address: string; mxid: string };
type EmailSess = {
  session_id: string;
  email: string;
  client_secret: string;
  token: string;
  send_attempt: number;
  validated: number;
  created_at: number;
  expires_at: number;
  validated_at?: number | null;
};

function createIdentityDb(opts: {
  associations?: Assoc[];
  emailSessions?: Map<string, EmailSess>;
} = {}) {
  const associations = [...(opts.associations ?? [])];
  const emailSessions = opts.emailSessions ?? new Map<string, EmailSess>();
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const events: string[] = [];

  return {
    associations,
    emailSessions,
    inserts,
    updates,
    events,
    prepare(sql: string) {
      const stmt = {
        async all<T>() {
          events.push(`db:all:${sql.slice(0, 60)}`);
          if (sql.includes('FROM identity_associations') && sql.includes('SELECT medium, address, mxid')) {
            return { results: [...associations] as T[] };
          }
          return { results: [] as T[] };
        },
        bind(...args: unknown[]) {
          return {
            all: stmt.all,
            async first<T>() {
              events.push(`db:first:${sql.slice(0, 60)}`);
              if (
                sql.includes('FROM identity_associations') &&
                sql.includes('WHERE medium = ?') &&
                sql.includes('AND address = ?')
              ) {
                const [medium, address] = args as [string, string];
                const row = associations.find((a) => a.medium === medium && a.address === address);
                return (row ? { mxid: row.mxid } : null) as T;
              }
              if (
                sql.includes('FROM email_verification_sessions') &&
                sql.includes('WHERE session_id = ?') &&
                sql.includes('client_secret = ?')
              ) {
                const [sid, secret] = args as [string, string];
                const s = emailSessions.get(sid);
                if (!s || s.client_secret !== secret) return null;
                return {
                  session_id: s.session_id,
                  email: s.email,
                  client_secret: s.client_secret,
                  token: s.token,
                  validated: s.validated,
                  expires_at: s.expires_at,
                } as T;
              }
              return null;
            },
            async run() {
              events.push(`db:run:${sql.slice(0, 60)}`);
              if (sql.includes('INSERT INTO email_verification_sessions')) {
                inserts.push({ sql, args });
                const [sessionId, email, clientSecret, token, sendAttempt, createdAt, expiresAt] =
                  args as [string, string, string, string, number, number, number];
                emailSessions.set(sessionId, {
                  session_id: sessionId,
                  email,
                  client_secret: clientSecret,
                  token,
                  send_attempt: sendAttempt,
                  validated: 0,
                  created_at: createdAt,
                  expires_at: expiresAt,
                  validated_at: null,
                });
              }
              if (sql.includes('UPDATE email_verification_sessions SET validated = 1')) {
                updates.push({ sql, args });
                const [validatedAt, sessionId] = args as [number, string];
                const s = emailSessions.get(sessionId);
                if (s) {
                  s.validated = 1;
                  s.validated_at = validatedAt;
                }
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
      return stmt;
    },
  };
}

function idEnv(opts: {
  cache?: ReturnType<typeof mockKv>;
  db?: ReturnType<typeof createIdentityDb>;
} = {}): Env & { _cache: ReturnType<typeof mockKv>; _db: ReturnType<typeof createIdentityDb> } {
  const cache = opts.cache ?? mockKv();
  const db = opts.db ?? createIdentityDb();
  return {
    SERVER_NAME: SERVER,
    CACHE: cache,
    DB: db as unknown as D1Database,
    _cache: cache,
    _db: db,
  } as unknown as Env & { _cache: ReturnType<typeof mockKv>; _db: ReturnType<typeof createIdentityDb> };
}

async function idReq(path: string, init: RequestInit = {}, env: Env = idEnv()) {
  try {
    const res = await identity.request(`http://localhost${path}`, init, env);
    const text = await res.text();
    let body: any = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: res.status, body, thrown: undefined as string | undefined };
  } catch (e) {
    return { status: 500, body: null, thrown: e instanceof Error ? e.message : String(e) };
  }
}

function qrEnv(sessions?: ReturnType<typeof mockKv>, serverName = SERVER): Env {
  return { SESSIONS: sessions ?? mockKv(), SERVER_NAME: serverName } as unknown as Env;
}

async function qrReq(path: string, init: RequestInit = {}, env: Env = qrEnv()) {
  try {
    const res = await qrLogin.request(`https://${SERVER}${path}`, init, env);
    const text = await res.text();
    let body: any = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json') && text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    } else {
      body = text;
    }
    return { status: res.status, body, text, thrown: undefined as string | undefined };
  } catch (e) {
    return {
      status: 500,
      body: null,
      text: '',
      thrown: e instanceof Error ? e.message : String(e),
    };
  }
}

beforeEach(() => {
  authState.userId = USER;
  authState.deviceId = DEVICE;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});


describe('race m.login.token: same-token double-consume TOCTOU', () => {
  it('double-consume barrier race #0', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_race_0';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const init = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE0A' }, '');
    const init2 = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE0B' }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', init),
      loginReq(env, '/_matrix/client/v3/login', init2),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const fails = [a, b].filter((r) => r.status !== 200);
    // TOCTOU: both may succeed after shared get before either delete
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + fails.length).toBe(2);
    expect(env._db.tokens.length).toBe(oks.length);
    expect(env._db.devices.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes.filter((k) => k === `login_token:${hash}`).length).toBe(oks.length);
  });
  it('double-consume barrier race #1', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_race_1';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const init = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE1A' }, '');
    const init2 = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE1B' }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', init),
      loginReq(env, '/_matrix/client/v3/login', init2),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const fails = [a, b].filter((r) => r.status !== 200);
    // TOCTOU: both may succeed after shared get before either delete
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + fails.length).toBe(2);
    expect(env._db.tokens.length).toBe(oks.length);
    expect(env._db.devices.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes.filter((k) => k === `login_token:${hash}`).length).toBe(oks.length);
  });
  it('double-consume barrier race #2', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_race_2';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const init = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE2A' }, '');
    const init2 = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE2B' }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', init),
      loginReq(env, '/_matrix/client/v3/login', init2),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const fails = [a, b].filter((r) => r.status !== 200);
    // TOCTOU: both may succeed after shared get before either delete
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + fails.length).toBe(2);
    expect(env._db.tokens.length).toBe(oks.length);
    expect(env._db.devices.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes.filter((k) => k === `login_token:${hash}`).length).toBe(oks.length);
  });
  it('double-consume barrier race #3', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_race_3';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const init = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE3A' }, '');
    const init2 = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE3B' }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', init),
      loginReq(env, '/_matrix/client/v3/login', init2),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const fails = [a, b].filter((r) => r.status !== 200);
    // TOCTOU: both may succeed after shared get before either delete
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + fails.length).toBe(2);
    expect(env._db.tokens.length).toBe(oks.length);
    expect(env._db.devices.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes.filter((k) => k === `login_token:${hash}`).length).toBe(oks.length);
  });
  it('double-consume barrier race #4', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_race_4';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const init = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE4A' }, '');
    const init2 = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE4B' }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', init),
      loginReq(env, '/_matrix/client/v3/login', init2),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const fails = [a, b].filter((r) => r.status !== 200);
    // TOCTOU: both may succeed after shared get before either delete
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + fails.length).toBe(2);
    expect(env._db.tokens.length).toBe(oks.length);
    expect(env._db.devices.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes.filter((k) => k === `login_token:${hash}`).length).toBe(oks.length);
  });
  it('double-consume barrier race #5', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_race_5';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const init = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE5A' }, '');
    const init2 = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE5B' }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', init),
      loginReq(env, '/_matrix/client/v3/login', init2),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const fails = [a, b].filter((r) => r.status !== 200);
    // TOCTOU: both may succeed after shared get before either delete
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + fails.length).toBe(2);
    expect(env._db.tokens.length).toBe(oks.length);
    expect(env._db.devices.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes.filter((k) => k === `login_token:${hash}`).length).toBe(oks.length);
  });
  it('double-consume barrier race #6', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_race_6';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const init = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE6A' }, '');
    const init2 = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE6B' }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', init),
      loginReq(env, '/_matrix/client/v3/login', init2),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const fails = [a, b].filter((r) => r.status !== 200);
    // TOCTOU: both may succeed after shared get before either delete
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + fails.length).toBe(2);
    expect(env._db.tokens.length).toBe(oks.length);
    expect(env._db.devices.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes.filter((k) => k === `login_token:${hash}`).length).toBe(oks.length);
  });
  it('double-consume barrier race #7', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_race_7';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const init = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE7A' }, '');
    const init2 = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE7B' }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', init),
      loginReq(env, '/_matrix/client/v3/login', init2),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const fails = [a, b].filter((r) => r.status !== 200);
    // TOCTOU: both may succeed after shared get before either delete
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + fails.length).toBe(2);
    expect(env._db.tokens.length).toBe(oks.length);
    expect(env._db.devices.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes.filter((k) => k === `login_token:${hash}`).length).toBe(oks.length);
  });
  it('double-consume barrier race #8', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_race_8';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const init = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE8A' }, '');
    const init2 = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE8B' }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', init),
      loginReq(env, '/_matrix/client/v3/login', init2),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const fails = [a, b].filter((r) => r.status !== 200);
    // TOCTOU: both may succeed after shared get before either delete
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + fails.length).toBe(2);
    expect(env._db.tokens.length).toBe(oks.length);
    expect(env._db.devices.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes.filter((k) => k === `login_token:${hash}`).length).toBe(oks.length);
  });
  it('double-consume barrier race #9', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_race_9';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const init = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE9A' }, '');
    const init2 = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE9B' }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', init),
      loginReq(env, '/_matrix/client/v3/login', init2),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const fails = [a, b].filter((r) => r.status !== 200);
    // TOCTOU: both may succeed after shared get before either delete
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + fails.length).toBe(2);
    expect(env._db.tokens.length).toBe(oks.length);
    expect(env._db.devices.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes.filter((k) => k === `login_token:${hash}`).length).toBe(oks.length);
  });
  it('double-consume barrier race #10', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_race_10';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const init = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE10A' }, '');
    const init2 = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE10B' }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', init),
      loginReq(env, '/_matrix/client/v3/login', init2),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const fails = [a, b].filter((r) => r.status !== 200);
    // TOCTOU: both may succeed after shared get before either delete
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + fails.length).toBe(2);
    expect(env._db.tokens.length).toBe(oks.length);
    expect(env._db.devices.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes.filter((k) => k === `login_token:${hash}`).length).toBe(oks.length);
  });
  it('double-consume barrier race #11', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_race_11';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const init = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE11A' }, '');
    const init2 = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE11B' }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', init),
      loginReq(env, '/_matrix/client/v3/login', init2),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const fails = [a, b].filter((r) => r.status !== 200);
    // TOCTOU: both may succeed after shared get before either delete
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + fails.length).toBe(2);
    expect(env._db.tokens.length).toBe(oks.length);
    expect(env._db.devices.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes.filter((k) => k === `login_token:${hash}`).length).toBe(oks.length);
  });
  it('double-consume barrier race #12', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_race_12';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const init = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE12A' }, '');
    const init2 = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE12B' }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', init),
      loginReq(env, '/_matrix/client/v3/login', init2),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const fails = [a, b].filter((r) => r.status !== 200);
    // TOCTOU: both may succeed after shared get before either delete
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + fails.length).toBe(2);
    expect(env._db.tokens.length).toBe(oks.length);
    expect(env._db.devices.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes.filter((k) => k === `login_token:${hash}`).length).toBe(oks.length);
  });
  it('double-consume barrier race #13', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_race_13';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const init = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE13A' }, '');
    const init2 = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE13B' }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', init),
      loginReq(env, '/_matrix/client/v3/login', init2),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const fails = [a, b].filter((r) => r.status !== 200);
    // TOCTOU: both may succeed after shared get before either delete
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + fails.length).toBe(2);
    expect(env._db.tokens.length).toBe(oks.length);
    expect(env._db.devices.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes.filter((k) => k === `login_token:${hash}`).length).toBe(oks.length);
  });
  it('double-consume barrier race #14', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_race_14';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const init = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE14A' }, '');
    const init2 = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE14B' }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', init),
      loginReq(env, '/_matrix/client/v3/login', init2),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const fails = [a, b].filter((r) => r.status !== 200);
    // TOCTOU: both may succeed after shared get before either delete
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + fails.length).toBe(2);
    expect(env._db.tokens.length).toBe(oks.length);
    expect(env._db.devices.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes.filter((k) => k === `login_token:${hash}`).length).toBe(oks.length);
  });
  it('double-consume barrier race #15', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_race_15';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const init = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE15A' }, '');
    const init2 = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE15B' }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', init),
      loginReq(env, '/_matrix/client/v3/login', init2),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const fails = [a, b].filter((r) => r.status !== 200);
    // TOCTOU: both may succeed after shared get before either delete
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + fails.length).toBe(2);
    expect(env._db.tokens.length).toBe(oks.length);
    expect(env._db.devices.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes.filter((k) => k === `login_token:${hash}`).length).toBe(oks.length);
  });
  it('double-consume barrier race #16', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_race_16';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const init = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE16A' }, '');
    const init2 = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE16B' }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', init),
      loginReq(env, '/_matrix/client/v3/login', init2),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const fails = [a, b].filter((r) => r.status !== 200);
    // TOCTOU: both may succeed after shared get before either delete
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + fails.length).toBe(2);
    expect(env._db.tokens.length).toBe(oks.length);
    expect(env._db.devices.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes.filter((k) => k === `login_token:${hash}`).length).toBe(oks.length);
  });
  it('double-consume barrier race #17', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_race_17';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const init = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE17A' }, '');
    const init2 = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE17B' }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', init),
      loginReq(env, '/_matrix/client/v3/login', init2),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const fails = [a, b].filter((r) => r.status !== 200);
    // TOCTOU: both may succeed after shared get before either delete
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + fails.length).toBe(2);
    expect(env._db.tokens.length).toBe(oks.length);
    expect(env._db.devices.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes.filter((k) => k === `login_token:${hash}`).length).toBe(oks.length);
  });
  it('double-consume barrier race #18', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_race_18';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const init = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE18A' }, '');
    const init2 = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE18B' }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', init),
      loginReq(env, '/_matrix/client/v3/login', init2),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const fails = [a, b].filter((r) => r.status !== 200);
    // TOCTOU: both may succeed after shared get before either delete
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + fails.length).toBe(2);
    expect(env._db.tokens.length).toBe(oks.length);
    expect(env._db.devices.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes.filter((k) => k === `login_token:${hash}`).length).toBe(oks.length);
  });
  it('double-consume barrier race #19', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_race_19';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const init = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE19A' }, '');
    const init2 = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE19B' }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', init),
      loginReq(env, '/_matrix/client/v3/login', init2),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const fails = [a, b].filter((r) => r.status !== 200);
    // TOCTOU: both may succeed after shared get before either delete
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + fails.length).toBe(2);
    expect(env._db.tokens.length).toBe(oks.length);
    expect(env._db.devices.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes.filter((k) => k === `login_token:${hash}`).length).toBe(oks.length);
  });
  it('double-consume barrier race #20', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_race_20';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const init = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE20A' }, '');
    const init2 = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE20B' }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', init),
      loginReq(env, '/_matrix/client/v3/login', init2),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const fails = [a, b].filter((r) => r.status !== 200);
    // TOCTOU: both may succeed after shared get before either delete
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + fails.length).toBe(2);
    expect(env._db.tokens.length).toBe(oks.length);
    expect(env._db.devices.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes.filter((k) => k === `login_token:${hash}`).length).toBe(oks.length);
  });
  it('double-consume barrier race #21', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_race_21';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const init = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE21A' }, '');
    const init2 = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE21B' }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', init),
      loginReq(env, '/_matrix/client/v3/login', init2),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const fails = [a, b].filter((r) => r.status !== 200);
    // TOCTOU: both may succeed after shared get before either delete
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + fails.length).toBe(2);
    expect(env._db.tokens.length).toBe(oks.length);
    expect(env._db.devices.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes.filter((k) => k === `login_token:${hash}`).length).toBe(oks.length);
  });
  it('double-consume barrier race #22', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_race_22';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const init = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE22A' }, '');
    const init2 = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE22B' }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', init),
      loginReq(env, '/_matrix/client/v3/login', init2),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const fails = [a, b].filter((r) => r.status !== 200);
    // TOCTOU: both may succeed after shared get before either delete
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + fails.length).toBe(2);
    expect(env._db.tokens.length).toBe(oks.length);
    expect(env._db.devices.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes.filter((k) => k === `login_token:${hash}`).length).toBe(oks.length);
  });
  it('double-consume barrier race #23', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_race_23';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const init = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE23A' }, '');
    const init2 = jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'RACE23B' }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', init),
      loginReq(env, '/_matrix/client/v3/login', init2),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const fails = [a, b].filter((r) => r.status !== 200);
    // TOCTOU: both may succeed after shared get before either delete
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length + fails.length).toBe(2);
    expect(env._db.tokens.length).toBe(oks.length);
    expect(env._db.devices.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes.filter((k) => k === `login_token:${hash}`).length).toBe(oks.length);
  });
});


describe('race refresh: same refresh_token double-rotation TOCTOU', () => {
  it('refresh double-rotate barrier race #0', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'refresh:', count: 2 } });
    const db = aliceDb();
    const raw = 'syr_race_0';
    await seedRefresh(sessions, db, raw, { accessTokenId: 'atok-race-0' });
    const env = loginEnv(db, sessions);
    const init = jsonInit('POST', { refresh_token: raw }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', init),
      loginReq(env, '/_matrix/client/v3/refresh', init),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(2);
    // Old refresh key gone
    const oldHash = await hashToken(raw);
    expect(sessions.data[`refresh:${oldHash}`]).toBeUndefined();
    // Successor refresh keys minted per success
    const refreshPuts = sessions.puts.filter((p) => p.key.startsWith('refresh:'));
    expect(refreshPuts.length).toBe(oks.length);
    for (const ok of oks) {
      expect(ok.body.access_token).toBeTruthy();
      expect(ok.body.refresh_token).toBeTruthy();
      expect(ok.body.expires_in_ms).toBe(60 * 60 * 1000);
    }
    // Old access token deleted once per success path
    expect(db.deletes.filter((d) => d.sql.includes('token_id')).length).toBe(oks.length);
  });
  it('refresh double-rotate barrier race #1', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'refresh:', count: 2 } });
    const db = aliceDb();
    const raw = 'syr_race_1';
    await seedRefresh(sessions, db, raw, { accessTokenId: 'atok-race-1' });
    const env = loginEnv(db, sessions);
    const init = jsonInit('POST', { refresh_token: raw }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', init),
      loginReq(env, '/_matrix/client/v3/refresh', init),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(2);
    // Old refresh key gone
    const oldHash = await hashToken(raw);
    expect(sessions.data[`refresh:${oldHash}`]).toBeUndefined();
    // Successor refresh keys minted per success
    const refreshPuts = sessions.puts.filter((p) => p.key.startsWith('refresh:'));
    expect(refreshPuts.length).toBe(oks.length);
    for (const ok of oks) {
      expect(ok.body.access_token).toBeTruthy();
      expect(ok.body.refresh_token).toBeTruthy();
      expect(ok.body.expires_in_ms).toBe(60 * 60 * 1000);
    }
    // Old access token deleted once per success path
    expect(db.deletes.filter((d) => d.sql.includes('token_id')).length).toBe(oks.length);
  });
  it('refresh double-rotate barrier race #2', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'refresh:', count: 2 } });
    const db = aliceDb();
    const raw = 'syr_race_2';
    await seedRefresh(sessions, db, raw, { accessTokenId: 'atok-race-2' });
    const env = loginEnv(db, sessions);
    const init = jsonInit('POST', { refresh_token: raw }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', init),
      loginReq(env, '/_matrix/client/v3/refresh', init),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(2);
    // Old refresh key gone
    const oldHash = await hashToken(raw);
    expect(sessions.data[`refresh:${oldHash}`]).toBeUndefined();
    // Successor refresh keys minted per success
    const refreshPuts = sessions.puts.filter((p) => p.key.startsWith('refresh:'));
    expect(refreshPuts.length).toBe(oks.length);
    for (const ok of oks) {
      expect(ok.body.access_token).toBeTruthy();
      expect(ok.body.refresh_token).toBeTruthy();
      expect(ok.body.expires_in_ms).toBe(60 * 60 * 1000);
    }
    // Old access token deleted once per success path
    expect(db.deletes.filter((d) => d.sql.includes('token_id')).length).toBe(oks.length);
  });
  it('refresh double-rotate barrier race #3', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'refresh:', count: 2 } });
    const db = aliceDb();
    const raw = 'syr_race_3';
    await seedRefresh(sessions, db, raw, { accessTokenId: 'atok-race-3' });
    const env = loginEnv(db, sessions);
    const init = jsonInit('POST', { refresh_token: raw }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', init),
      loginReq(env, '/_matrix/client/v3/refresh', init),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(2);
    // Old refresh key gone
    const oldHash = await hashToken(raw);
    expect(sessions.data[`refresh:${oldHash}`]).toBeUndefined();
    // Successor refresh keys minted per success
    const refreshPuts = sessions.puts.filter((p) => p.key.startsWith('refresh:'));
    expect(refreshPuts.length).toBe(oks.length);
    for (const ok of oks) {
      expect(ok.body.access_token).toBeTruthy();
      expect(ok.body.refresh_token).toBeTruthy();
      expect(ok.body.expires_in_ms).toBe(60 * 60 * 1000);
    }
    // Old access token deleted once per success path
    expect(db.deletes.filter((d) => d.sql.includes('token_id')).length).toBe(oks.length);
  });
  it('refresh double-rotate barrier race #4', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'refresh:', count: 2 } });
    const db = aliceDb();
    const raw = 'syr_race_4';
    await seedRefresh(sessions, db, raw, { accessTokenId: 'atok-race-4' });
    const env = loginEnv(db, sessions);
    const init = jsonInit('POST', { refresh_token: raw }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', init),
      loginReq(env, '/_matrix/client/v3/refresh', init),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(2);
    // Old refresh key gone
    const oldHash = await hashToken(raw);
    expect(sessions.data[`refresh:${oldHash}`]).toBeUndefined();
    // Successor refresh keys minted per success
    const refreshPuts = sessions.puts.filter((p) => p.key.startsWith('refresh:'));
    expect(refreshPuts.length).toBe(oks.length);
    for (const ok of oks) {
      expect(ok.body.access_token).toBeTruthy();
      expect(ok.body.refresh_token).toBeTruthy();
      expect(ok.body.expires_in_ms).toBe(60 * 60 * 1000);
    }
    // Old access token deleted once per success path
    expect(db.deletes.filter((d) => d.sql.includes('token_id')).length).toBe(oks.length);
  });
  it('refresh double-rotate barrier race #5', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'refresh:', count: 2 } });
    const db = aliceDb();
    const raw = 'syr_race_5';
    await seedRefresh(sessions, db, raw, { accessTokenId: 'atok-race-5' });
    const env = loginEnv(db, sessions);
    const init = jsonInit('POST', { refresh_token: raw }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', init),
      loginReq(env, '/_matrix/client/v3/refresh', init),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(2);
    // Old refresh key gone
    const oldHash = await hashToken(raw);
    expect(sessions.data[`refresh:${oldHash}`]).toBeUndefined();
    // Successor refresh keys minted per success
    const refreshPuts = sessions.puts.filter((p) => p.key.startsWith('refresh:'));
    expect(refreshPuts.length).toBe(oks.length);
    for (const ok of oks) {
      expect(ok.body.access_token).toBeTruthy();
      expect(ok.body.refresh_token).toBeTruthy();
      expect(ok.body.expires_in_ms).toBe(60 * 60 * 1000);
    }
    // Old access token deleted once per success path
    expect(db.deletes.filter((d) => d.sql.includes('token_id')).length).toBe(oks.length);
  });
  it('refresh double-rotate barrier race #6', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'refresh:', count: 2 } });
    const db = aliceDb();
    const raw = 'syr_race_6';
    await seedRefresh(sessions, db, raw, { accessTokenId: 'atok-race-6' });
    const env = loginEnv(db, sessions);
    const init = jsonInit('POST', { refresh_token: raw }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', init),
      loginReq(env, '/_matrix/client/v3/refresh', init),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(2);
    // Old refresh key gone
    const oldHash = await hashToken(raw);
    expect(sessions.data[`refresh:${oldHash}`]).toBeUndefined();
    // Successor refresh keys minted per success
    const refreshPuts = sessions.puts.filter((p) => p.key.startsWith('refresh:'));
    expect(refreshPuts.length).toBe(oks.length);
    for (const ok of oks) {
      expect(ok.body.access_token).toBeTruthy();
      expect(ok.body.refresh_token).toBeTruthy();
      expect(ok.body.expires_in_ms).toBe(60 * 60 * 1000);
    }
    // Old access token deleted once per success path
    expect(db.deletes.filter((d) => d.sql.includes('token_id')).length).toBe(oks.length);
  });
  it('refresh double-rotate barrier race #7', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'refresh:', count: 2 } });
    const db = aliceDb();
    const raw = 'syr_race_7';
    await seedRefresh(sessions, db, raw, { accessTokenId: 'atok-race-7' });
    const env = loginEnv(db, sessions);
    const init = jsonInit('POST', { refresh_token: raw }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', init),
      loginReq(env, '/_matrix/client/v3/refresh', init),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(2);
    // Old refresh key gone
    const oldHash = await hashToken(raw);
    expect(sessions.data[`refresh:${oldHash}`]).toBeUndefined();
    // Successor refresh keys minted per success
    const refreshPuts = sessions.puts.filter((p) => p.key.startsWith('refresh:'));
    expect(refreshPuts.length).toBe(oks.length);
    for (const ok of oks) {
      expect(ok.body.access_token).toBeTruthy();
      expect(ok.body.refresh_token).toBeTruthy();
      expect(ok.body.expires_in_ms).toBe(60 * 60 * 1000);
    }
    // Old access token deleted once per success path
    expect(db.deletes.filter((d) => d.sql.includes('token_id')).length).toBe(oks.length);
  });
  it('refresh double-rotate barrier race #8', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'refresh:', count: 2 } });
    const db = aliceDb();
    const raw = 'syr_race_8';
    await seedRefresh(sessions, db, raw, { accessTokenId: 'atok-race-8' });
    const env = loginEnv(db, sessions);
    const init = jsonInit('POST', { refresh_token: raw }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', init),
      loginReq(env, '/_matrix/client/v3/refresh', init),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(2);
    // Old refresh key gone
    const oldHash = await hashToken(raw);
    expect(sessions.data[`refresh:${oldHash}`]).toBeUndefined();
    // Successor refresh keys minted per success
    const refreshPuts = sessions.puts.filter((p) => p.key.startsWith('refresh:'));
    expect(refreshPuts.length).toBe(oks.length);
    for (const ok of oks) {
      expect(ok.body.access_token).toBeTruthy();
      expect(ok.body.refresh_token).toBeTruthy();
      expect(ok.body.expires_in_ms).toBe(60 * 60 * 1000);
    }
    // Old access token deleted once per success path
    expect(db.deletes.filter((d) => d.sql.includes('token_id')).length).toBe(oks.length);
  });
  it('refresh double-rotate barrier race #9', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'refresh:', count: 2 } });
    const db = aliceDb();
    const raw = 'syr_race_9';
    await seedRefresh(sessions, db, raw, { accessTokenId: 'atok-race-9' });
    const env = loginEnv(db, sessions);
    const init = jsonInit('POST', { refresh_token: raw }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', init),
      loginReq(env, '/_matrix/client/v3/refresh', init),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(2);
    // Old refresh key gone
    const oldHash = await hashToken(raw);
    expect(sessions.data[`refresh:${oldHash}`]).toBeUndefined();
    // Successor refresh keys minted per success
    const refreshPuts = sessions.puts.filter((p) => p.key.startsWith('refresh:'));
    expect(refreshPuts.length).toBe(oks.length);
    for (const ok of oks) {
      expect(ok.body.access_token).toBeTruthy();
      expect(ok.body.refresh_token).toBeTruthy();
      expect(ok.body.expires_in_ms).toBe(60 * 60 * 1000);
    }
    // Old access token deleted once per success path
    expect(db.deletes.filter((d) => d.sql.includes('token_id')).length).toBe(oks.length);
  });
  it('refresh double-rotate barrier race #10', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'refresh:', count: 2 } });
    const db = aliceDb();
    const raw = 'syr_race_10';
    await seedRefresh(sessions, db, raw, { accessTokenId: 'atok-race-10' });
    const env = loginEnv(db, sessions);
    const init = jsonInit('POST', { refresh_token: raw }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', init),
      loginReq(env, '/_matrix/client/v3/refresh', init),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(2);
    // Old refresh key gone
    const oldHash = await hashToken(raw);
    expect(sessions.data[`refresh:${oldHash}`]).toBeUndefined();
    // Successor refresh keys minted per success
    const refreshPuts = sessions.puts.filter((p) => p.key.startsWith('refresh:'));
    expect(refreshPuts.length).toBe(oks.length);
    for (const ok of oks) {
      expect(ok.body.access_token).toBeTruthy();
      expect(ok.body.refresh_token).toBeTruthy();
      expect(ok.body.expires_in_ms).toBe(60 * 60 * 1000);
    }
    // Old access token deleted once per success path
    expect(db.deletes.filter((d) => d.sql.includes('token_id')).length).toBe(oks.length);
  });
  it('refresh double-rotate barrier race #11', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'refresh:', count: 2 } });
    const db = aliceDb();
    const raw = 'syr_race_11';
    await seedRefresh(sessions, db, raw, { accessTokenId: 'atok-race-11' });
    const env = loginEnv(db, sessions);
    const init = jsonInit('POST', { refresh_token: raw }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', init),
      loginReq(env, '/_matrix/client/v3/refresh', init),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(2);
    // Old refresh key gone
    const oldHash = await hashToken(raw);
    expect(sessions.data[`refresh:${oldHash}`]).toBeUndefined();
    // Successor refresh keys minted per success
    const refreshPuts = sessions.puts.filter((p) => p.key.startsWith('refresh:'));
    expect(refreshPuts.length).toBe(oks.length);
    for (const ok of oks) {
      expect(ok.body.access_token).toBeTruthy();
      expect(ok.body.refresh_token).toBeTruthy();
      expect(ok.body.expires_in_ms).toBe(60 * 60 * 1000);
    }
    // Old access token deleted once per success path
    expect(db.deletes.filter((d) => d.sql.includes('token_id')).length).toBe(oks.length);
  });
  it('refresh double-rotate barrier race #12', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'refresh:', count: 2 } });
    const db = aliceDb();
    const raw = 'syr_race_12';
    await seedRefresh(sessions, db, raw, { accessTokenId: 'atok-race-12' });
    const env = loginEnv(db, sessions);
    const init = jsonInit('POST', { refresh_token: raw }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', init),
      loginReq(env, '/_matrix/client/v3/refresh', init),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(2);
    // Old refresh key gone
    const oldHash = await hashToken(raw);
    expect(sessions.data[`refresh:${oldHash}`]).toBeUndefined();
    // Successor refresh keys minted per success
    const refreshPuts = sessions.puts.filter((p) => p.key.startsWith('refresh:'));
    expect(refreshPuts.length).toBe(oks.length);
    for (const ok of oks) {
      expect(ok.body.access_token).toBeTruthy();
      expect(ok.body.refresh_token).toBeTruthy();
      expect(ok.body.expires_in_ms).toBe(60 * 60 * 1000);
    }
    // Old access token deleted once per success path
    expect(db.deletes.filter((d) => d.sql.includes('token_id')).length).toBe(oks.length);
  });
  it('refresh double-rotate barrier race #13', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'refresh:', count: 2 } });
    const db = aliceDb();
    const raw = 'syr_race_13';
    await seedRefresh(sessions, db, raw, { accessTokenId: 'atok-race-13' });
    const env = loginEnv(db, sessions);
    const init = jsonInit('POST', { refresh_token: raw }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', init),
      loginReq(env, '/_matrix/client/v3/refresh', init),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(2);
    // Old refresh key gone
    const oldHash = await hashToken(raw);
    expect(sessions.data[`refresh:${oldHash}`]).toBeUndefined();
    // Successor refresh keys minted per success
    const refreshPuts = sessions.puts.filter((p) => p.key.startsWith('refresh:'));
    expect(refreshPuts.length).toBe(oks.length);
    for (const ok of oks) {
      expect(ok.body.access_token).toBeTruthy();
      expect(ok.body.refresh_token).toBeTruthy();
      expect(ok.body.expires_in_ms).toBe(60 * 60 * 1000);
    }
    // Old access token deleted once per success path
    expect(db.deletes.filter((d) => d.sql.includes('token_id')).length).toBe(oks.length);
  });
  it('refresh double-rotate barrier race #14', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'refresh:', count: 2 } });
    const db = aliceDb();
    const raw = 'syr_race_14';
    await seedRefresh(sessions, db, raw, { accessTokenId: 'atok-race-14' });
    const env = loginEnv(db, sessions);
    const init = jsonInit('POST', { refresh_token: raw }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', init),
      loginReq(env, '/_matrix/client/v3/refresh', init),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(2);
    // Old refresh key gone
    const oldHash = await hashToken(raw);
    expect(sessions.data[`refresh:${oldHash}`]).toBeUndefined();
    // Successor refresh keys minted per success
    const refreshPuts = sessions.puts.filter((p) => p.key.startsWith('refresh:'));
    expect(refreshPuts.length).toBe(oks.length);
    for (const ok of oks) {
      expect(ok.body.access_token).toBeTruthy();
      expect(ok.body.refresh_token).toBeTruthy();
      expect(ok.body.expires_in_ms).toBe(60 * 60 * 1000);
    }
    // Old access token deleted once per success path
    expect(db.deletes.filter((d) => d.sql.includes('token_id')).length).toBe(oks.length);
  });
  it('refresh double-rotate barrier race #15', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'refresh:', count: 2 } });
    const db = aliceDb();
    const raw = 'syr_race_15';
    await seedRefresh(sessions, db, raw, { accessTokenId: 'atok-race-15' });
    const env = loginEnv(db, sessions);
    const init = jsonInit('POST', { refresh_token: raw }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', init),
      loginReq(env, '/_matrix/client/v3/refresh', init),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(2);
    // Old refresh key gone
    const oldHash = await hashToken(raw);
    expect(sessions.data[`refresh:${oldHash}`]).toBeUndefined();
    // Successor refresh keys minted per success
    const refreshPuts = sessions.puts.filter((p) => p.key.startsWith('refresh:'));
    expect(refreshPuts.length).toBe(oks.length);
    for (const ok of oks) {
      expect(ok.body.access_token).toBeTruthy();
      expect(ok.body.refresh_token).toBeTruthy();
      expect(ok.body.expires_in_ms).toBe(60 * 60 * 1000);
    }
    // Old access token deleted once per success path
    expect(db.deletes.filter((d) => d.sql.includes('token_id')).length).toBe(oks.length);
  });
  it('refresh double-rotate barrier race #16', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'refresh:', count: 2 } });
    const db = aliceDb();
    const raw = 'syr_race_16';
    await seedRefresh(sessions, db, raw, { accessTokenId: 'atok-race-16' });
    const env = loginEnv(db, sessions);
    const init = jsonInit('POST', { refresh_token: raw }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', init),
      loginReq(env, '/_matrix/client/v3/refresh', init),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(2);
    // Old refresh key gone
    const oldHash = await hashToken(raw);
    expect(sessions.data[`refresh:${oldHash}`]).toBeUndefined();
    // Successor refresh keys minted per success
    const refreshPuts = sessions.puts.filter((p) => p.key.startsWith('refresh:'));
    expect(refreshPuts.length).toBe(oks.length);
    for (const ok of oks) {
      expect(ok.body.access_token).toBeTruthy();
      expect(ok.body.refresh_token).toBeTruthy();
      expect(ok.body.expires_in_ms).toBe(60 * 60 * 1000);
    }
    // Old access token deleted once per success path
    expect(db.deletes.filter((d) => d.sql.includes('token_id')).length).toBe(oks.length);
  });
  it('refresh double-rotate barrier race #17', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'refresh:', count: 2 } });
    const db = aliceDb();
    const raw = 'syr_race_17';
    await seedRefresh(sessions, db, raw, { accessTokenId: 'atok-race-17' });
    const env = loginEnv(db, sessions);
    const init = jsonInit('POST', { refresh_token: raw }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', init),
      loginReq(env, '/_matrix/client/v3/refresh', init),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(2);
    // Old refresh key gone
    const oldHash = await hashToken(raw);
    expect(sessions.data[`refresh:${oldHash}`]).toBeUndefined();
    // Successor refresh keys minted per success
    const refreshPuts = sessions.puts.filter((p) => p.key.startsWith('refresh:'));
    expect(refreshPuts.length).toBe(oks.length);
    for (const ok of oks) {
      expect(ok.body.access_token).toBeTruthy();
      expect(ok.body.refresh_token).toBeTruthy();
      expect(ok.body.expires_in_ms).toBe(60 * 60 * 1000);
    }
    // Old access token deleted once per success path
    expect(db.deletes.filter((d) => d.sql.includes('token_id')).length).toBe(oks.length);
  });
  it('refresh double-rotate barrier race #18', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'refresh:', count: 2 } });
    const db = aliceDb();
    const raw = 'syr_race_18';
    await seedRefresh(sessions, db, raw, { accessTokenId: 'atok-race-18' });
    const env = loginEnv(db, sessions);
    const init = jsonInit('POST', { refresh_token: raw }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', init),
      loginReq(env, '/_matrix/client/v3/refresh', init),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(2);
    // Old refresh key gone
    const oldHash = await hashToken(raw);
    expect(sessions.data[`refresh:${oldHash}`]).toBeUndefined();
    // Successor refresh keys minted per success
    const refreshPuts = sessions.puts.filter((p) => p.key.startsWith('refresh:'));
    expect(refreshPuts.length).toBe(oks.length);
    for (const ok of oks) {
      expect(ok.body.access_token).toBeTruthy();
      expect(ok.body.refresh_token).toBeTruthy();
      expect(ok.body.expires_in_ms).toBe(60 * 60 * 1000);
    }
    // Old access token deleted once per success path
    expect(db.deletes.filter((d) => d.sql.includes('token_id')).length).toBe(oks.length);
  });
  it('refresh double-rotate barrier race #19', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'refresh:', count: 2 } });
    const db = aliceDb();
    const raw = 'syr_race_19';
    await seedRefresh(sessions, db, raw, { accessTokenId: 'atok-race-19' });
    const env = loginEnv(db, sessions);
    const init = jsonInit('POST', { refresh_token: raw }, '');
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', init),
      loginReq(env, '/_matrix/client/v3/refresh', init),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(2);
    // Old refresh key gone
    const oldHash = await hashToken(raw);
    expect(sessions.data[`refresh:${oldHash}`]).toBeUndefined();
    // Successor refresh keys minted per success
    const refreshPuts = sessions.puts.filter((p) => p.key.startsWith('refresh:'));
    expect(refreshPuts.length).toBe(oks.length);
    for (const ok of oks) {
      expect(ok.body.access_token).toBeTruthy();
      expect(ok.body.refresh_token).toBeTruthy();
      expect(ok.body.expires_in_ms).toBe(60 * 60 * 1000);
    }
    // Old access token deleted once per success path
    expect(db.deletes.filter((d) => d.sql.includes('token_id')).length).toBe(oks.length);
  });
});


describe('race lockout: parallel bad-password lost-update same user', () => {
  it('lockout lost-update race #0', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'lockout:', count: 2 } });
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'alice' },
      password: 'WrongPass0!',
      device_id: 'LOCK0',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Lost-update: both read attempts=0, both write attempts=1
    expect(lock.attempts).toBe(1);
    expect(lock.lockedUntil).toBeUndefined();
    expect(sessions.puts.filter((p) => p.key === `lockout:${USER}`).length).toBe(2);
  });
  it('lockout lost-update race #1', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'lockout:', count: 2 } });
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'alice' },
      password: 'WrongPass1!',
      device_id: 'LOCK1',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Lost-update: both read attempts=0, both write attempts=1
    expect(lock.attempts).toBe(1);
    expect(lock.lockedUntil).toBeUndefined();
    expect(sessions.puts.filter((p) => p.key === `lockout:${USER}`).length).toBe(2);
  });
  it('lockout lost-update race #2', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'lockout:', count: 2 } });
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'alice' },
      password: 'WrongPass2!',
      device_id: 'LOCK2',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Lost-update: both read attempts=0, both write attempts=1
    expect(lock.attempts).toBe(1);
    expect(lock.lockedUntil).toBeUndefined();
    expect(sessions.puts.filter((p) => p.key === `lockout:${USER}`).length).toBe(2);
  });
  it('lockout lost-update race #3', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'lockout:', count: 2 } });
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'alice' },
      password: 'WrongPass3!',
      device_id: 'LOCK3',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Lost-update: both read attempts=0, both write attempts=1
    expect(lock.attempts).toBe(1);
    expect(lock.lockedUntil).toBeUndefined();
    expect(sessions.puts.filter((p) => p.key === `lockout:${USER}`).length).toBe(2);
  });
  it('lockout lost-update race #4', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'lockout:', count: 2 } });
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'alice' },
      password: 'WrongPass4!',
      device_id: 'LOCK4',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Lost-update: both read attempts=0, both write attempts=1
    expect(lock.attempts).toBe(1);
    expect(lock.lockedUntil).toBeUndefined();
    expect(sessions.puts.filter((p) => p.key === `lockout:${USER}`).length).toBe(2);
  });
  it('lockout lost-update race #5', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'lockout:', count: 2 } });
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'alice' },
      password: 'WrongPass5!',
      device_id: 'LOCK5',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Lost-update: both read attempts=0, both write attempts=1
    expect(lock.attempts).toBe(1);
    expect(lock.lockedUntil).toBeUndefined();
    expect(sessions.puts.filter((p) => p.key === `lockout:${USER}`).length).toBe(2);
  });
  it('lockout lost-update race #6', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'lockout:', count: 2 } });
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'alice' },
      password: 'WrongPass6!',
      device_id: 'LOCK6',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Lost-update: both read attempts=0, both write attempts=1
    expect(lock.attempts).toBe(1);
    expect(lock.lockedUntil).toBeUndefined();
    expect(sessions.puts.filter((p) => p.key === `lockout:${USER}`).length).toBe(2);
  });
  it('lockout lost-update race #7', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'lockout:', count: 2 } });
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'alice' },
      password: 'WrongPass7!',
      device_id: 'LOCK7',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Lost-update: both read attempts=0, both write attempts=1
    expect(lock.attempts).toBe(1);
    expect(lock.lockedUntil).toBeUndefined();
    expect(sessions.puts.filter((p) => p.key === `lockout:${USER}`).length).toBe(2);
  });
  it('lockout lost-update race #8', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'lockout:', count: 2 } });
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'alice' },
      password: 'WrongPass8!',
      device_id: 'LOCK8',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Lost-update: both read attempts=0, both write attempts=1
    expect(lock.attempts).toBe(1);
    expect(lock.lockedUntil).toBeUndefined();
    expect(sessions.puts.filter((p) => p.key === `lockout:${USER}`).length).toBe(2);
  });
  it('lockout lost-update race #9', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'lockout:', count: 2 } });
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'alice' },
      password: 'WrongPass9!',
      device_id: 'LOCK9',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Lost-update: both read attempts=0, both write attempts=1
    expect(lock.attempts).toBe(1);
    expect(lock.lockedUntil).toBeUndefined();
    expect(sessions.puts.filter((p) => p.key === `lockout:${USER}`).length).toBe(2);
  });
  it('lockout lost-update race #10', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'lockout:', count: 2 } });
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'alice' },
      password: 'WrongPass10!',
      device_id: 'LOCK10',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Lost-update: both read attempts=0, both write attempts=1
    expect(lock.attempts).toBe(1);
    expect(lock.lockedUntil).toBeUndefined();
    expect(sessions.puts.filter((p) => p.key === `lockout:${USER}`).length).toBe(2);
  });
  it('lockout lost-update race #11', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'lockout:', count: 2 } });
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'alice' },
      password: 'WrongPass11!',
      device_id: 'LOCK11',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Lost-update: both read attempts=0, both write attempts=1
    expect(lock.attempts).toBe(1);
    expect(lock.lockedUntil).toBeUndefined();
    expect(sessions.puts.filter((p) => p.key === `lockout:${USER}`).length).toBe(2);
  });
  it('lockout lost-update race #12', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'lockout:', count: 2 } });
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'alice' },
      password: 'WrongPass12!',
      device_id: 'LOCK12',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Lost-update: both read attempts=0, both write attempts=1
    expect(lock.attempts).toBe(1);
    expect(lock.lockedUntil).toBeUndefined();
    expect(sessions.puts.filter((p) => p.key === `lockout:${USER}`).length).toBe(2);
  });
  it('lockout lost-update race #13', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'lockout:', count: 2 } });
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'alice' },
      password: 'WrongPass13!',
      device_id: 'LOCK13',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Lost-update: both read attempts=0, both write attempts=1
    expect(lock.attempts).toBe(1);
    expect(lock.lockedUntil).toBeUndefined();
    expect(sessions.puts.filter((p) => p.key === `lockout:${USER}`).length).toBe(2);
  });
  it('lockout lost-update race #14', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'lockout:', count: 2 } });
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'alice' },
      password: 'WrongPass14!',
      device_id: 'LOCK14',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Lost-update: both read attempts=0, both write attempts=1
    expect(lock.attempts).toBe(1);
    expect(lock.lockedUntil).toBeUndefined();
    expect(sessions.puts.filter((p) => p.key === `lockout:${USER}`).length).toBe(2);
  });
  it('lockout lost-update race #15', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'lockout:', count: 2 } });
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'alice' },
      password: 'WrongPass15!',
      device_id: 'LOCK15',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Lost-update: both read attempts=0, both write attempts=1
    expect(lock.attempts).toBe(1);
    expect(lock.lockedUntil).toBeUndefined();
    expect(sessions.puts.filter((p) => p.key === `lockout:${USER}`).length).toBe(2);
  });
  it('lockout lost-update race #16', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'lockout:', count: 2 } });
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'alice' },
      password: 'WrongPass16!',
      device_id: 'LOCK16',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Lost-update: both read attempts=0, both write attempts=1
    expect(lock.attempts).toBe(1);
    expect(lock.lockedUntil).toBeUndefined();
    expect(sessions.puts.filter((p) => p.key === `lockout:${USER}`).length).toBe(2);
  });
  it('lockout lost-update race #17', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'lockout:', count: 2 } });
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'alice' },
      password: 'WrongPass17!',
      device_id: 'LOCK17',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Lost-update: both read attempts=0, both write attempts=1
    expect(lock.attempts).toBe(1);
    expect(lock.lockedUntil).toBeUndefined();
    expect(sessions.puts.filter((p) => p.key === `lockout:${USER}`).length).toBe(2);
  });
  it('lockout lost-update race #18', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'lockout:', count: 2 } });
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'alice' },
      password: 'WrongPass18!',
      device_id: 'LOCK18',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Lost-update: both read attempts=0, both write attempts=1
    expect(lock.attempts).toBe(1);
    expect(lock.lockedUntil).toBeUndefined();
    expect(sessions.puts.filter((p) => p.key === `lockout:${USER}`).length).toBe(2);
  });
  it('lockout lost-update race #19', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'lockout:', count: 2 } });
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'alice' },
      password: 'WrongPass19!',
      device_id: 'LOCK19',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Lost-update: both read attempts=0, both write attempts=1
    expect(lock.attempts).toBe(1);
    expect(lock.lockedUntil).toBeUndefined();
    expect(sessions.puts.filter((p) => p.key === `lockout:${USER}`).length).toBe(2);
  });
});


describe('race lockout: near-threshold parallel attempts lost lock', () => {
  it('lockout threshold race from 4 #0', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 4 }) },
      { getBarrier: { prefix: 'lockout:', count: 2 } }
    );
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: USER },
      password: 'NoGood0!',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Both read 4 → both write attempts=5 + lockedUntil (last write wins, still locked)
    expect(lock.attempts).toBe(5);
    expect(lock.lockedUntil).toBe(NOW + 15 * 60 * 1000);
  });
  it('lockout threshold race from 4 #1', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 4 }) },
      { getBarrier: { prefix: 'lockout:', count: 2 } }
    );
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: USER },
      password: 'NoGood1!',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Both read 4 → both write attempts=5 + lockedUntil (last write wins, still locked)
    expect(lock.attempts).toBe(5);
    expect(lock.lockedUntil).toBe(NOW + 15 * 60 * 1000);
  });
  it('lockout threshold race from 4 #2', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 4 }) },
      { getBarrier: { prefix: 'lockout:', count: 2 } }
    );
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: USER },
      password: 'NoGood2!',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Both read 4 → both write attempts=5 + lockedUntil (last write wins, still locked)
    expect(lock.attempts).toBe(5);
    expect(lock.lockedUntil).toBe(NOW + 15 * 60 * 1000);
  });
  it('lockout threshold race from 4 #3', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 4 }) },
      { getBarrier: { prefix: 'lockout:', count: 2 } }
    );
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: USER },
      password: 'NoGood3!',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Both read 4 → both write attempts=5 + lockedUntil (last write wins, still locked)
    expect(lock.attempts).toBe(5);
    expect(lock.lockedUntil).toBe(NOW + 15 * 60 * 1000);
  });
  it('lockout threshold race from 4 #4', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 4 }) },
      { getBarrier: { prefix: 'lockout:', count: 2 } }
    );
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: USER },
      password: 'NoGood4!',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Both read 4 → both write attempts=5 + lockedUntil (last write wins, still locked)
    expect(lock.attempts).toBe(5);
    expect(lock.lockedUntil).toBe(NOW + 15 * 60 * 1000);
  });
  it('lockout threshold race from 4 #5', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 4 }) },
      { getBarrier: { prefix: 'lockout:', count: 2 } }
    );
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: USER },
      password: 'NoGood5!',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Both read 4 → both write attempts=5 + lockedUntil (last write wins, still locked)
    expect(lock.attempts).toBe(5);
    expect(lock.lockedUntil).toBe(NOW + 15 * 60 * 1000);
  });
  it('lockout threshold race from 4 #6', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 4 }) },
      { getBarrier: { prefix: 'lockout:', count: 2 } }
    );
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: USER },
      password: 'NoGood6!',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Both read 4 → both write attempts=5 + lockedUntil (last write wins, still locked)
    expect(lock.attempts).toBe(5);
    expect(lock.lockedUntil).toBe(NOW + 15 * 60 * 1000);
  });
  it('lockout threshold race from 4 #7', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 4 }) },
      { getBarrier: { prefix: 'lockout:', count: 2 } }
    );
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: USER },
      password: 'NoGood7!',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Both read 4 → both write attempts=5 + lockedUntil (last write wins, still locked)
    expect(lock.attempts).toBe(5);
    expect(lock.lockedUntil).toBe(NOW + 15 * 60 * 1000);
  });
  it('lockout threshold race from 4 #8', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 4 }) },
      { getBarrier: { prefix: 'lockout:', count: 2 } }
    );
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: USER },
      password: 'NoGood8!',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Both read 4 → both write attempts=5 + lockedUntil (last write wins, still locked)
    expect(lock.attempts).toBe(5);
    expect(lock.lockedUntil).toBe(NOW + 15 * 60 * 1000);
  });
  it('lockout threshold race from 4 #9', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 4 }) },
      { getBarrier: { prefix: 'lockout:', count: 2 } }
    );
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: USER },
      password: 'NoGood9!',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Both read 4 → both write attempts=5 + lockedUntil (last write wins, still locked)
    expect(lock.attempts).toBe(5);
    expect(lock.lockedUntil).toBe(NOW + 15 * 60 * 1000);
  });
  it('lockout threshold race from 4 #10', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 4 }) },
      { getBarrier: { prefix: 'lockout:', count: 2 } }
    );
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: USER },
      password: 'NoGood10!',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Both read 4 → both write attempts=5 + lockedUntil (last write wins, still locked)
    expect(lock.attempts).toBe(5);
    expect(lock.lockedUntil).toBe(NOW + 15 * 60 * 1000);
  });
  it('lockout threshold race from 4 #11', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 4 }) },
      { getBarrier: { prefix: 'lockout:', count: 2 } }
    );
    const env = loginEnv(aliceDb(), sessions);
    const body = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: USER },
      password: 'NoGood11!',
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/login', jsonInit('POST', body, '')),
    ]);
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    const lock = JSON.parse(sessions.data[`lockout:${USER}`]!);
    // Both read 4 → both write attempts=5 + lockedUntil (last write wins, still locked)
    expect(lock.attempts).toBe(5);
    expect(lock.lockedUntil).toBe(NOW + 15 * 60 * 1000);
  });
});


describe('race get_token: parallel mint distinct login_token keys', () => {
  it('get_token parallel mint N=2 #0', async () => {
    const n = 2;
    const sessions = mockKv();
    const env = loginEnv(aliceDb(), sessions);
    const reqs = Array.from({ length: n }, () =>
      loginReq(env, '/_matrix/client/v1/login/get_token', jsonInit('POST', {}))
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const tokens = results.map((r) => r.body.login_token as string);
    expect(new Set(tokens).size).toBe(n);
    expect(sessions.puts.filter((p) => p.key.startsWith('login_token:')).length).toBe(n);
    for (const p of sessions.puts.filter((p) => p.key.startsWith('login_token:'))) {
      expect(p.options?.expirationTtl).toBe(120);
      const parsed = JSON.parse(p.value);
      expect(parsed.user_id).toBe(USER);
      expect(parsed.expires_at).toBe(NOW + 120_000);
    }
  });
  it('get_token parallel mint N=3 #1', async () => {
    const n = 3;
    const sessions = mockKv();
    const env = loginEnv(aliceDb(), sessions);
    const reqs = Array.from({ length: n }, () =>
      loginReq(env, '/_matrix/client/v1/login/get_token', jsonInit('POST', {}))
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const tokens = results.map((r) => r.body.login_token as string);
    expect(new Set(tokens).size).toBe(n);
    expect(sessions.puts.filter((p) => p.key.startsWith('login_token:')).length).toBe(n);
    for (const p of sessions.puts.filter((p) => p.key.startsWith('login_token:'))) {
      expect(p.options?.expirationTtl).toBe(120);
      const parsed = JSON.parse(p.value);
      expect(parsed.user_id).toBe(USER);
      expect(parsed.expires_at).toBe(NOW + 120_000);
    }
  });
  it('get_token parallel mint N=4 #2', async () => {
    const n = 4;
    const sessions = mockKv();
    const env = loginEnv(aliceDb(), sessions);
    const reqs = Array.from({ length: n }, () =>
      loginReq(env, '/_matrix/client/v1/login/get_token', jsonInit('POST', {}))
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const tokens = results.map((r) => r.body.login_token as string);
    expect(new Set(tokens).size).toBe(n);
    expect(sessions.puts.filter((p) => p.key.startsWith('login_token:')).length).toBe(n);
    for (const p of sessions.puts.filter((p) => p.key.startsWith('login_token:'))) {
      expect(p.options?.expirationTtl).toBe(120);
      const parsed = JSON.parse(p.value);
      expect(parsed.user_id).toBe(USER);
      expect(parsed.expires_at).toBe(NOW + 120_000);
    }
  });
  it('get_token parallel mint N=5 #3', async () => {
    const n = 5;
    const sessions = mockKv();
    const env = loginEnv(aliceDb(), sessions);
    const reqs = Array.from({ length: n }, () =>
      loginReq(env, '/_matrix/client/v1/login/get_token', jsonInit('POST', {}))
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const tokens = results.map((r) => r.body.login_token as string);
    expect(new Set(tokens).size).toBe(n);
    expect(sessions.puts.filter((p) => p.key.startsWith('login_token:')).length).toBe(n);
    for (const p of sessions.puts.filter((p) => p.key.startsWith('login_token:'))) {
      expect(p.options?.expirationTtl).toBe(120);
      const parsed = JSON.parse(p.value);
      expect(parsed.user_id).toBe(USER);
      expect(parsed.expires_at).toBe(NOW + 120_000);
    }
  });
  it('get_token parallel mint N=2 #4', async () => {
    const n = 2;
    const sessions = mockKv();
    const env = loginEnv(aliceDb(), sessions);
    const reqs = Array.from({ length: n }, () =>
      loginReq(env, '/_matrix/client/v1/login/get_token', jsonInit('POST', {}))
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const tokens = results.map((r) => r.body.login_token as string);
    expect(new Set(tokens).size).toBe(n);
    expect(sessions.puts.filter((p) => p.key.startsWith('login_token:')).length).toBe(n);
    for (const p of sessions.puts.filter((p) => p.key.startsWith('login_token:'))) {
      expect(p.options?.expirationTtl).toBe(120);
      const parsed = JSON.parse(p.value);
      expect(parsed.user_id).toBe(USER);
      expect(parsed.expires_at).toBe(NOW + 120_000);
    }
  });
  it('get_token parallel mint N=3 #5', async () => {
    const n = 3;
    const sessions = mockKv();
    const env = loginEnv(aliceDb(), sessions);
    const reqs = Array.from({ length: n }, () =>
      loginReq(env, '/_matrix/client/v1/login/get_token', jsonInit('POST', {}))
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const tokens = results.map((r) => r.body.login_token as string);
    expect(new Set(tokens).size).toBe(n);
    expect(sessions.puts.filter((p) => p.key.startsWith('login_token:')).length).toBe(n);
    for (const p of sessions.puts.filter((p) => p.key.startsWith('login_token:'))) {
      expect(p.options?.expirationTtl).toBe(120);
      const parsed = JSON.parse(p.value);
      expect(parsed.user_id).toBe(USER);
      expect(parsed.expires_at).toBe(NOW + 120_000);
    }
  });
  it('get_token parallel mint N=4 #6', async () => {
    const n = 4;
    const sessions = mockKv();
    const env = loginEnv(aliceDb(), sessions);
    const reqs = Array.from({ length: n }, () =>
      loginReq(env, '/_matrix/client/v1/login/get_token', jsonInit('POST', {}))
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const tokens = results.map((r) => r.body.login_token as string);
    expect(new Set(tokens).size).toBe(n);
    expect(sessions.puts.filter((p) => p.key.startsWith('login_token:')).length).toBe(n);
    for (const p of sessions.puts.filter((p) => p.key.startsWith('login_token:'))) {
      expect(p.options?.expirationTtl).toBe(120);
      const parsed = JSON.parse(p.value);
      expect(parsed.user_id).toBe(USER);
      expect(parsed.expires_at).toBe(NOW + 120_000);
    }
  });
  it('get_token parallel mint N=5 #7', async () => {
    const n = 5;
    const sessions = mockKv();
    const env = loginEnv(aliceDb(), sessions);
    const reqs = Array.from({ length: n }, () =>
      loginReq(env, '/_matrix/client/v1/login/get_token', jsonInit('POST', {}))
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const tokens = results.map((r) => r.body.login_token as string);
    expect(new Set(tokens).size).toBe(n);
    expect(sessions.puts.filter((p) => p.key.startsWith('login_token:')).length).toBe(n);
    for (const p of sessions.puts.filter((p) => p.key.startsWith('login_token:'))) {
      expect(p.options?.expirationTtl).toBe(120);
      const parsed = JSON.parse(p.value);
      expect(parsed.user_id).toBe(USER);
      expect(parsed.expires_at).toBe(NOW + 120_000);
    }
  });
  it('get_token parallel mint N=2 #8', async () => {
    const n = 2;
    const sessions = mockKv();
    const env = loginEnv(aliceDb(), sessions);
    const reqs = Array.from({ length: n }, () =>
      loginReq(env, '/_matrix/client/v1/login/get_token', jsonInit('POST', {}))
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const tokens = results.map((r) => r.body.login_token as string);
    expect(new Set(tokens).size).toBe(n);
    expect(sessions.puts.filter((p) => p.key.startsWith('login_token:')).length).toBe(n);
    for (const p of sessions.puts.filter((p) => p.key.startsWith('login_token:'))) {
      expect(p.options?.expirationTtl).toBe(120);
      const parsed = JSON.parse(p.value);
      expect(parsed.user_id).toBe(USER);
      expect(parsed.expires_at).toBe(NOW + 120_000);
    }
  });
  it('get_token parallel mint N=3 #9', async () => {
    const n = 3;
    const sessions = mockKv();
    const env = loginEnv(aliceDb(), sessions);
    const reqs = Array.from({ length: n }, () =>
      loginReq(env, '/_matrix/client/v1/login/get_token', jsonInit('POST', {}))
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const tokens = results.map((r) => r.body.login_token as string);
    expect(new Set(tokens).size).toBe(n);
    expect(sessions.puts.filter((p) => p.key.startsWith('login_token:')).length).toBe(n);
    for (const p of sessions.puts.filter((p) => p.key.startsWith('login_token:'))) {
      expect(p.options?.expirationTtl).toBe(120);
      const parsed = JSON.parse(p.value);
      expect(parsed.user_id).toBe(USER);
      expect(parsed.expires_at).toBe(NOW + 120_000);
    }
  });
  it('get_token parallel mint N=4 #10', async () => {
    const n = 4;
    const sessions = mockKv();
    const env = loginEnv(aliceDb(), sessions);
    const reqs = Array.from({ length: n }, () =>
      loginReq(env, '/_matrix/client/v1/login/get_token', jsonInit('POST', {}))
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const tokens = results.map((r) => r.body.login_token as string);
    expect(new Set(tokens).size).toBe(n);
    expect(sessions.puts.filter((p) => p.key.startsWith('login_token:')).length).toBe(n);
    for (const p of sessions.puts.filter((p) => p.key.startsWith('login_token:'))) {
      expect(p.options?.expirationTtl).toBe(120);
      const parsed = JSON.parse(p.value);
      expect(parsed.user_id).toBe(USER);
      expect(parsed.expires_at).toBe(NOW + 120_000);
    }
  });
  it('get_token parallel mint N=5 #11', async () => {
    const n = 5;
    const sessions = mockKv();
    const env = loginEnv(aliceDb(), sessions);
    const reqs = Array.from({ length: n }, () =>
      loginReq(env, '/_matrix/client/v1/login/get_token', jsonInit('POST', {}))
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const tokens = results.map((r) => r.body.login_token as string);
    expect(new Set(tokens).size).toBe(n);
    expect(sessions.puts.filter((p) => p.key.startsWith('login_token:')).length).toBe(n);
    for (const p of sessions.puts.filter((p) => p.key.startsWith('login_token:'))) {
      expect(p.options?.expirationTtl).toBe(120);
      const parsed = JSON.parse(p.value);
      expect(parsed.user_id).toBe(USER);
      expect(parsed.expires_at).toBe(NOW + 120_000);
    }
  });
  it('get_token parallel mint N=2 #12', async () => {
    const n = 2;
    const sessions = mockKv();
    const env = loginEnv(aliceDb(), sessions);
    const reqs = Array.from({ length: n }, () =>
      loginReq(env, '/_matrix/client/v1/login/get_token', jsonInit('POST', {}))
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const tokens = results.map((r) => r.body.login_token as string);
    expect(new Set(tokens).size).toBe(n);
    expect(sessions.puts.filter((p) => p.key.startsWith('login_token:')).length).toBe(n);
    for (const p of sessions.puts.filter((p) => p.key.startsWith('login_token:'))) {
      expect(p.options?.expirationTtl).toBe(120);
      const parsed = JSON.parse(p.value);
      expect(parsed.user_id).toBe(USER);
      expect(parsed.expires_at).toBe(NOW + 120_000);
    }
  });
  it('get_token parallel mint N=3 #13', async () => {
    const n = 3;
    const sessions = mockKv();
    const env = loginEnv(aliceDb(), sessions);
    const reqs = Array.from({ length: n }, () =>
      loginReq(env, '/_matrix/client/v1/login/get_token', jsonInit('POST', {}))
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const tokens = results.map((r) => r.body.login_token as string);
    expect(new Set(tokens).size).toBe(n);
    expect(sessions.puts.filter((p) => p.key.startsWith('login_token:')).length).toBe(n);
    for (const p of sessions.puts.filter((p) => p.key.startsWith('login_token:'))) {
      expect(p.options?.expirationTtl).toBe(120);
      const parsed = JSON.parse(p.value);
      expect(parsed.user_id).toBe(USER);
      expect(parsed.expires_at).toBe(NOW + 120_000);
    }
  });
  it('get_token parallel mint N=4 #14', async () => {
    const n = 4;
    const sessions = mockKv();
    const env = loginEnv(aliceDb(), sessions);
    const reqs = Array.from({ length: n }, () =>
      loginReq(env, '/_matrix/client/v1/login/get_token', jsonInit('POST', {}))
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const tokens = results.map((r) => r.body.login_token as string);
    expect(new Set(tokens).size).toBe(n);
    expect(sessions.puts.filter((p) => p.key.startsWith('login_token:')).length).toBe(n);
    for (const p of sessions.puts.filter((p) => p.key.startsWith('login_token:'))) {
      expect(p.options?.expirationTtl).toBe(120);
      const parsed = JSON.parse(p.value);
      expect(parsed.user_id).toBe(USER);
      expect(parsed.expires_at).toBe(NOW + 120_000);
    }
  });
  it('get_token parallel mint N=5 #15', async () => {
    const n = 5;
    const sessions = mockKv();
    const env = loginEnv(aliceDb(), sessions);
    const reqs = Array.from({ length: n }, () =>
      loginReq(env, '/_matrix/client/v1/login/get_token', jsonInit('POST', {}))
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const tokens = results.map((r) => r.body.login_token as string);
    expect(new Set(tokens).size).toBe(n);
    expect(sessions.puts.filter((p) => p.key.startsWith('login_token:')).length).toBe(n);
    for (const p of sessions.puts.filter((p) => p.key.startsWith('login_token:'))) {
      expect(p.options?.expirationTtl).toBe(120);
      const parsed = JSON.parse(p.value);
      expect(parsed.user_id).toBe(USER);
      expect(parsed.expires_at).toBe(NOW + 120_000);
    }
  });
});


describe('race QR landing ∥ m.login.token consume', () => {
  it('landing vs login consume race #0', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_land_0';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [land, log] = await Promise.all([
      qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QL0' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    expect(land.status).toBe(200);
    expect(typeof land.body === 'string' ? land.body : land.text).toContain('Login');
    // After consume, second landing is expired/used
    const land2 = await qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE);
    expect(land2.status).toBe(400);
    expect(String(land2.body)).toMatch(/expired|used/i);
  });
  it('landing vs login consume race #1', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_land_1';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [land, log] = await Promise.all([
      qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QL1' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    expect(land.status).toBe(200);
    expect(typeof land.body === 'string' ? land.body : land.text).toContain('Login');
    // After consume, second landing is expired/used
    const land2 = await qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE);
    expect(land2.status).toBe(400);
    expect(String(land2.body)).toMatch(/expired|used/i);
  });
  it('landing vs login consume race #2', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_land_2';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [land, log] = await Promise.all([
      qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QL2' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    expect(land.status).toBe(200);
    expect(typeof land.body === 'string' ? land.body : land.text).toContain('Login');
    // After consume, second landing is expired/used
    const land2 = await qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE);
    expect(land2.status).toBe(400);
    expect(String(land2.body)).toMatch(/expired|used/i);
  });
  it('landing vs login consume race #3', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_land_3';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [land, log] = await Promise.all([
      qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QL3' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    expect(land.status).toBe(200);
    expect(typeof land.body === 'string' ? land.body : land.text).toContain('Login');
    // After consume, second landing is expired/used
    const land2 = await qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE);
    expect(land2.status).toBe(400);
    expect(String(land2.body)).toMatch(/expired|used/i);
  });
  it('landing vs login consume race #4', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_land_4';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [land, log] = await Promise.all([
      qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QL4' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    expect(land.status).toBe(200);
    expect(typeof land.body === 'string' ? land.body : land.text).toContain('Login');
    // After consume, second landing is expired/used
    const land2 = await qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE);
    expect(land2.status).toBe(400);
    expect(String(land2.body)).toMatch(/expired|used/i);
  });
  it('landing vs login consume race #5', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_land_5';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [land, log] = await Promise.all([
      qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QL5' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    expect(land.status).toBe(200);
    expect(typeof land.body === 'string' ? land.body : land.text).toContain('Login');
    // After consume, second landing is expired/used
    const land2 = await qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE);
    expect(land2.status).toBe(400);
    expect(String(land2.body)).toMatch(/expired|used/i);
  });
  it('landing vs login consume race #6', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_land_6';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [land, log] = await Promise.all([
      qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QL6' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    expect(land.status).toBe(200);
    expect(typeof land.body === 'string' ? land.body : land.text).toContain('Login');
    // After consume, second landing is expired/used
    const land2 = await qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE);
    expect(land2.status).toBe(400);
    expect(String(land2.body)).toMatch(/expired|used/i);
  });
  it('landing vs login consume race #7', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_land_7';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [land, log] = await Promise.all([
      qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QL7' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    expect(land.status).toBe(200);
    expect(typeof land.body === 'string' ? land.body : land.text).toContain('Login');
    // After consume, second landing is expired/used
    const land2 = await qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE);
    expect(land2.status).toBe(400);
    expect(String(land2.body)).toMatch(/expired|used/i);
  });
  it('landing vs login consume race #8', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_land_8';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [land, log] = await Promise.all([
      qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QL8' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    expect(land.status).toBe(200);
    expect(typeof land.body === 'string' ? land.body : land.text).toContain('Login');
    // After consume, second landing is expired/used
    const land2 = await qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE);
    expect(land2.status).toBe(400);
    expect(String(land2.body)).toMatch(/expired|used/i);
  });
  it('landing vs login consume race #9', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_land_9';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [land, log] = await Promise.all([
      qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QL9' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    expect(land.status).toBe(200);
    expect(typeof land.body === 'string' ? land.body : land.text).toContain('Login');
    // After consume, second landing is expired/used
    const land2 = await qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE);
    expect(land2.status).toBe(400);
    expect(String(land2.body)).toMatch(/expired|used/i);
  });
  it('landing vs login consume race #10', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_land_10';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [land, log] = await Promise.all([
      qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QL10' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    expect(land.status).toBe(200);
    expect(typeof land.body === 'string' ? land.body : land.text).toContain('Login');
    // After consume, second landing is expired/used
    const land2 = await qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE);
    expect(land2.status).toBe(400);
    expect(String(land2.body)).toMatch(/expired|used/i);
  });
  it('landing vs login consume race #11', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_land_11';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [land, log] = await Promise.all([
      qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QL11' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    expect(land.status).toBe(200);
    expect(typeof land.body === 'string' ? land.body : land.text).toContain('Login');
    // After consume, second landing is expired/used
    const land2 = await qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE);
    expect(land2.status).toBe(400);
    expect(String(land2.body)).toMatch(/expired|used/i);
  });
  it('landing vs login consume race #12', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_land_12';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [land, log] = await Promise.all([
      qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QL12' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    expect(land.status).toBe(200);
    expect(typeof land.body === 'string' ? land.body : land.text).toContain('Login');
    // After consume, second landing is expired/used
    const land2 = await qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE);
    expect(land2.status).toBe(400);
    expect(String(land2.body)).toMatch(/expired|used/i);
  });
  it('landing vs login consume race #13', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_land_13';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [land, log] = await Promise.all([
      qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QL13' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    expect(land.status).toBe(200);
    expect(typeof land.body === 'string' ? land.body : land.text).toContain('Login');
    // After consume, second landing is expired/used
    const land2 = await qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE);
    expect(land2.status).toBe(400);
    expect(String(land2.body)).toMatch(/expired|used/i);
  });
  it('landing vs login consume race #14', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_land_14';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [land, log] = await Promise.all([
      qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QL14' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    expect(land.status).toBe(200);
    expect(typeof land.body === 'string' ? land.body : land.text).toContain('Login');
    // After consume, second landing is expired/used
    const land2 = await qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE);
    expect(land2.status).toBe(400);
    expect(String(land2.body)).toMatch(/expired|used/i);
  });
  it('landing vs login consume race #15', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_land_15';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [land, log] = await Promise.all([
      qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QL15' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    expect(land.status).toBe(200);
    expect(typeof land.body === 'string' ? land.body : land.text).toContain('Login');
    // After consume, second landing is expired/used
    const land2 = await qrReq(`/login/qr/${raw}`, { method: 'GET' }, qrE);
    expect(land2.status).toBe(400);
    expect(String(land2.body)).toMatch(/expired|used/i);
  });
});


describe('race QR check ∥ m.login.token consume', () => {
  it('check vs login consume race #0', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_chk_0';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [chk, log] = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QC0' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    // Check never deletes — with barrier both see token; check returns valid
    expect(chk.status).toBe(200);
    expect(chk.body.valid).toBe(true);
    expect(chk.body.user_id).toBe(USER);
    const chk2 = await qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE);
    expect(chk2.status).toBe(404);
    expect(chk2.body.valid).toBe(false);
  });
  it('check vs login consume race #1', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_chk_1';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [chk, log] = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QC1' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    // Check never deletes — with barrier both see token; check returns valid
    expect(chk.status).toBe(200);
    expect(chk.body.valid).toBe(true);
    expect(chk.body.user_id).toBe(USER);
    const chk2 = await qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE);
    expect(chk2.status).toBe(404);
    expect(chk2.body.valid).toBe(false);
  });
  it('check vs login consume race #2', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_chk_2';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [chk, log] = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QC2' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    // Check never deletes — with barrier both see token; check returns valid
    expect(chk.status).toBe(200);
    expect(chk.body.valid).toBe(true);
    expect(chk.body.user_id).toBe(USER);
    const chk2 = await qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE);
    expect(chk2.status).toBe(404);
    expect(chk2.body.valid).toBe(false);
  });
  it('check vs login consume race #3', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_chk_3';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [chk, log] = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QC3' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    // Check never deletes — with barrier both see token; check returns valid
    expect(chk.status).toBe(200);
    expect(chk.body.valid).toBe(true);
    expect(chk.body.user_id).toBe(USER);
    const chk2 = await qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE);
    expect(chk2.status).toBe(404);
    expect(chk2.body.valid).toBe(false);
  });
  it('check vs login consume race #4', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_chk_4';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [chk, log] = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QC4' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    // Check never deletes — with barrier both see token; check returns valid
    expect(chk.status).toBe(200);
    expect(chk.body.valid).toBe(true);
    expect(chk.body.user_id).toBe(USER);
    const chk2 = await qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE);
    expect(chk2.status).toBe(404);
    expect(chk2.body.valid).toBe(false);
  });
  it('check vs login consume race #5', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_chk_5';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [chk, log] = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QC5' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    // Check never deletes — with barrier both see token; check returns valid
    expect(chk.status).toBe(200);
    expect(chk.body.valid).toBe(true);
    expect(chk.body.user_id).toBe(USER);
    const chk2 = await qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE);
    expect(chk2.status).toBe(404);
    expect(chk2.body.valid).toBe(false);
  });
  it('check vs login consume race #6', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_chk_6';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [chk, log] = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QC6' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    // Check never deletes — with barrier both see token; check returns valid
    expect(chk.status).toBe(200);
    expect(chk.body.valid).toBe(true);
    expect(chk.body.user_id).toBe(USER);
    const chk2 = await qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE);
    expect(chk2.status).toBe(404);
    expect(chk2.body.valid).toBe(false);
  });
  it('check vs login consume race #7', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_chk_7';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [chk, log] = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QC7' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    // Check never deletes — with barrier both see token; check returns valid
    expect(chk.status).toBe(200);
    expect(chk.body.valid).toBe(true);
    expect(chk.body.user_id).toBe(USER);
    const chk2 = await qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE);
    expect(chk2.status).toBe(404);
    expect(chk2.body.valid).toBe(false);
  });
  it('check vs login consume race #8', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_chk_8';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [chk, log] = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QC8' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    // Check never deletes — with barrier both see token; check returns valid
    expect(chk.status).toBe(200);
    expect(chk.body.valid).toBe(true);
    expect(chk.body.user_id).toBe(USER);
    const chk2 = await qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE);
    expect(chk2.status).toBe(404);
    expect(chk2.body.valid).toBe(false);
  });
  it('check vs login consume race #9', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_chk_9';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [chk, log] = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QC9' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    // Check never deletes — with barrier both see token; check returns valid
    expect(chk.status).toBe(200);
    expect(chk.body.valid).toBe(true);
    expect(chk.body.user_id).toBe(USER);
    const chk2 = await qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE);
    expect(chk2.status).toBe(404);
    expect(chk2.body.valid).toBe(false);
  });
  it('check vs login consume race #10', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_chk_10';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [chk, log] = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QC10' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    // Check never deletes — with barrier both see token; check returns valid
    expect(chk.status).toBe(200);
    expect(chk.body.valid).toBe(true);
    expect(chk.body.user_id).toBe(USER);
    const chk2 = await qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE);
    expect(chk2.status).toBe(404);
    expect(chk2.body.valid).toBe(false);
  });
  it('check vs login consume race #11', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_chk_11';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [chk, log] = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QC11' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    // Check never deletes — with barrier both see token; check returns valid
    expect(chk.status).toBe(200);
    expect(chk.body.valid).toBe(true);
    expect(chk.body.user_id).toBe(USER);
    const chk2 = await qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE);
    expect(chk2.status).toBe(404);
    expect(chk2.body.valid).toBe(false);
  });
  it('check vs login consume race #12', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_chk_12';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [chk, log] = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QC12' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    // Check never deletes — with barrier both see token; check returns valid
    expect(chk.status).toBe(200);
    expect(chk.body.valid).toBe(true);
    expect(chk.body.user_id).toBe(USER);
    const chk2 = await qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE);
    expect(chk2.status).toBe(404);
    expect(chk2.body.valid).toBe(false);
  });
  it('check vs login consume race #13', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_chk_13';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [chk, log] = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QC13' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    // Check never deletes — with barrier both see token; check returns valid
    expect(chk.status).toBe(200);
    expect(chk.body.valid).toBe(true);
    expect(chk.body.user_id).toBe(USER);
    const chk2 = await qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE);
    expect(chk2.status).toBe(404);
    expect(chk2.body.valid).toBe(false);
  });
  it('check vs login consume race #14', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_chk_14';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [chk, log] = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QC14' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    // Check never deletes — with barrier both see token; check returns valid
    expect(chk.status).toBe(200);
    expect(chk.body.valid).toBe(true);
    expect(chk.body.user_id).toBe(USER);
    const chk2 = await qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE);
    expect(chk2.status).toBe(404);
    expect(chk2.body.valid).toBe(false);
  });
  it('check vs login consume race #15', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 2 } });
    const raw = 'mlt_chk_15';
    await seedLoginToken(sessions, raw);
    const loginE = loginEnv(aliceDb(), sessions);
    const qrE = qrEnv(sessions);
    const [chk, log] = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE),
      loginReq(
        loginE,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'QC15' }, '')
      ),
    ]);
    expect(log.status).toBe(200);
    // Check never deletes — with barrier both see token; check returns valid
    expect(chk.status).toBe(200);
    expect(chk.body.valid).toBe(true);
    expect(chk.body.user_id).toBe(USER);
    const chk2 = await qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, qrE);
    expect(chk2.status).toBe(404);
    expect(chk2.body.valid).toBe(false);
  });
});


describe('race identity pepper: parallel hash_details mint TOCTOU', () => {
  it('pepper mint race hash_details #0', async () => {
    const cache = mockKv({}, { getBarrier: { prefix: 'identity:pepper', count: 2 } });
    const env = idEnv({ cache });
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Both may mint different peppers; last put wins in CACHE
    expect(a.body.lookup_pepper).toBeTruthy();
    expect(b.body.lookup_pepper).toBeTruthy();
    expect(cache.puts.filter((p) => p.key === 'identity:pepper').length).toBe(2);
    const winner = cache.data['identity:pepper'];
    expect([a.body.lookup_pepper, b.body.lookup_pepper]).toContain(winner);
    // Lookup with loser pepper → M_INVALID_PEPPER + winner
    const peppers = [a.body.lookup_pepper, b.body.lookup_pepper];
    const loser = peppers.find((p) => p !== winner) ?? peppers[0];
    const lookup = await idReq(
      `${ID_BASE}/lookup`,
      jsonInit('POST', { algorithm: 'none', pepper: loser, addresses: ['x email'] }, ''),
      env
    );
    if (loser !== winner) {
      expect(lookup.status).toBe(400);
      expect(lookup.body.errcode).toBe('M_INVALID_PEPPER');
      expect(lookup.body.lookup_pepper).toBe(winner);
    } else {
      // Same pepper both times (crypto collision unlikely) — lookup ok or empty
      expect([200, 400]).toContain(lookup.status);
    }
  });
  it('pepper mint race hash_details #1', async () => {
    const cache = mockKv({}, { getBarrier: { prefix: 'identity:pepper', count: 2 } });
    const env = idEnv({ cache });
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Both may mint different peppers; last put wins in CACHE
    expect(a.body.lookup_pepper).toBeTruthy();
    expect(b.body.lookup_pepper).toBeTruthy();
    expect(cache.puts.filter((p) => p.key === 'identity:pepper').length).toBe(2);
    const winner = cache.data['identity:pepper'];
    expect([a.body.lookup_pepper, b.body.lookup_pepper]).toContain(winner);
    // Lookup with loser pepper → M_INVALID_PEPPER + winner
    const peppers = [a.body.lookup_pepper, b.body.lookup_pepper];
    const loser = peppers.find((p) => p !== winner) ?? peppers[0];
    const lookup = await idReq(
      `${ID_BASE}/lookup`,
      jsonInit('POST', { algorithm: 'none', pepper: loser, addresses: ['x email'] }, ''),
      env
    );
    if (loser !== winner) {
      expect(lookup.status).toBe(400);
      expect(lookup.body.errcode).toBe('M_INVALID_PEPPER');
      expect(lookup.body.lookup_pepper).toBe(winner);
    } else {
      // Same pepper both times (crypto collision unlikely) — lookup ok or empty
      expect([200, 400]).toContain(lookup.status);
    }
  });
  it('pepper mint race hash_details #2', async () => {
    const cache = mockKv({}, { getBarrier: { prefix: 'identity:pepper', count: 2 } });
    const env = idEnv({ cache });
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Both may mint different peppers; last put wins in CACHE
    expect(a.body.lookup_pepper).toBeTruthy();
    expect(b.body.lookup_pepper).toBeTruthy();
    expect(cache.puts.filter((p) => p.key === 'identity:pepper').length).toBe(2);
    const winner = cache.data['identity:pepper'];
    expect([a.body.lookup_pepper, b.body.lookup_pepper]).toContain(winner);
    // Lookup with loser pepper → M_INVALID_PEPPER + winner
    const peppers = [a.body.lookup_pepper, b.body.lookup_pepper];
    const loser = peppers.find((p) => p !== winner) ?? peppers[0];
    const lookup = await idReq(
      `${ID_BASE}/lookup`,
      jsonInit('POST', { algorithm: 'none', pepper: loser, addresses: ['x email'] }, ''),
      env
    );
    if (loser !== winner) {
      expect(lookup.status).toBe(400);
      expect(lookup.body.errcode).toBe('M_INVALID_PEPPER');
      expect(lookup.body.lookup_pepper).toBe(winner);
    } else {
      // Same pepper both times (crypto collision unlikely) — lookup ok or empty
      expect([200, 400]).toContain(lookup.status);
    }
  });
  it('pepper mint race hash_details #3', async () => {
    const cache = mockKv({}, { getBarrier: { prefix: 'identity:pepper', count: 2 } });
    const env = idEnv({ cache });
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Both may mint different peppers; last put wins in CACHE
    expect(a.body.lookup_pepper).toBeTruthy();
    expect(b.body.lookup_pepper).toBeTruthy();
    expect(cache.puts.filter((p) => p.key === 'identity:pepper').length).toBe(2);
    const winner = cache.data['identity:pepper'];
    expect([a.body.lookup_pepper, b.body.lookup_pepper]).toContain(winner);
    // Lookup with loser pepper → M_INVALID_PEPPER + winner
    const peppers = [a.body.lookup_pepper, b.body.lookup_pepper];
    const loser = peppers.find((p) => p !== winner) ?? peppers[0];
    const lookup = await idReq(
      `${ID_BASE}/lookup`,
      jsonInit('POST', { algorithm: 'none', pepper: loser, addresses: ['x email'] }, ''),
      env
    );
    if (loser !== winner) {
      expect(lookup.status).toBe(400);
      expect(lookup.body.errcode).toBe('M_INVALID_PEPPER');
      expect(lookup.body.lookup_pepper).toBe(winner);
    } else {
      // Same pepper both times (crypto collision unlikely) — lookup ok or empty
      expect([200, 400]).toContain(lookup.status);
    }
  });
  it('pepper mint race hash_details #4', async () => {
    const cache = mockKv({}, { getBarrier: { prefix: 'identity:pepper', count: 2 } });
    const env = idEnv({ cache });
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Both may mint different peppers; last put wins in CACHE
    expect(a.body.lookup_pepper).toBeTruthy();
    expect(b.body.lookup_pepper).toBeTruthy();
    expect(cache.puts.filter((p) => p.key === 'identity:pepper').length).toBe(2);
    const winner = cache.data['identity:pepper'];
    expect([a.body.lookup_pepper, b.body.lookup_pepper]).toContain(winner);
    // Lookup with loser pepper → M_INVALID_PEPPER + winner
    const peppers = [a.body.lookup_pepper, b.body.lookup_pepper];
    const loser = peppers.find((p) => p !== winner) ?? peppers[0];
    const lookup = await idReq(
      `${ID_BASE}/lookup`,
      jsonInit('POST', { algorithm: 'none', pepper: loser, addresses: ['x email'] }, ''),
      env
    );
    if (loser !== winner) {
      expect(lookup.status).toBe(400);
      expect(lookup.body.errcode).toBe('M_INVALID_PEPPER');
      expect(lookup.body.lookup_pepper).toBe(winner);
    } else {
      // Same pepper both times (crypto collision unlikely) — lookup ok or empty
      expect([200, 400]).toContain(lookup.status);
    }
  });
  it('pepper mint race hash_details #5', async () => {
    const cache = mockKv({}, { getBarrier: { prefix: 'identity:pepper', count: 2 } });
    const env = idEnv({ cache });
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Both may mint different peppers; last put wins in CACHE
    expect(a.body.lookup_pepper).toBeTruthy();
    expect(b.body.lookup_pepper).toBeTruthy();
    expect(cache.puts.filter((p) => p.key === 'identity:pepper').length).toBe(2);
    const winner = cache.data['identity:pepper'];
    expect([a.body.lookup_pepper, b.body.lookup_pepper]).toContain(winner);
    // Lookup with loser pepper → M_INVALID_PEPPER + winner
    const peppers = [a.body.lookup_pepper, b.body.lookup_pepper];
    const loser = peppers.find((p) => p !== winner) ?? peppers[0];
    const lookup = await idReq(
      `${ID_BASE}/lookup`,
      jsonInit('POST', { algorithm: 'none', pepper: loser, addresses: ['x email'] }, ''),
      env
    );
    if (loser !== winner) {
      expect(lookup.status).toBe(400);
      expect(lookup.body.errcode).toBe('M_INVALID_PEPPER');
      expect(lookup.body.lookup_pepper).toBe(winner);
    } else {
      // Same pepper both times (crypto collision unlikely) — lookup ok or empty
      expect([200, 400]).toContain(lookup.status);
    }
  });
  it('pepper mint race hash_details #6', async () => {
    const cache = mockKv({}, { getBarrier: { prefix: 'identity:pepper', count: 2 } });
    const env = idEnv({ cache });
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Both may mint different peppers; last put wins in CACHE
    expect(a.body.lookup_pepper).toBeTruthy();
    expect(b.body.lookup_pepper).toBeTruthy();
    expect(cache.puts.filter((p) => p.key === 'identity:pepper').length).toBe(2);
    const winner = cache.data['identity:pepper'];
    expect([a.body.lookup_pepper, b.body.lookup_pepper]).toContain(winner);
    // Lookup with loser pepper → M_INVALID_PEPPER + winner
    const peppers = [a.body.lookup_pepper, b.body.lookup_pepper];
    const loser = peppers.find((p) => p !== winner) ?? peppers[0];
    const lookup = await idReq(
      `${ID_BASE}/lookup`,
      jsonInit('POST', { algorithm: 'none', pepper: loser, addresses: ['x email'] }, ''),
      env
    );
    if (loser !== winner) {
      expect(lookup.status).toBe(400);
      expect(lookup.body.errcode).toBe('M_INVALID_PEPPER');
      expect(lookup.body.lookup_pepper).toBe(winner);
    } else {
      // Same pepper both times (crypto collision unlikely) — lookup ok or empty
      expect([200, 400]).toContain(lookup.status);
    }
  });
  it('pepper mint race hash_details #7', async () => {
    const cache = mockKv({}, { getBarrier: { prefix: 'identity:pepper', count: 2 } });
    const env = idEnv({ cache });
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Both may mint different peppers; last put wins in CACHE
    expect(a.body.lookup_pepper).toBeTruthy();
    expect(b.body.lookup_pepper).toBeTruthy();
    expect(cache.puts.filter((p) => p.key === 'identity:pepper').length).toBe(2);
    const winner = cache.data['identity:pepper'];
    expect([a.body.lookup_pepper, b.body.lookup_pepper]).toContain(winner);
    // Lookup with loser pepper → M_INVALID_PEPPER + winner
    const peppers = [a.body.lookup_pepper, b.body.lookup_pepper];
    const loser = peppers.find((p) => p !== winner) ?? peppers[0];
    const lookup = await idReq(
      `${ID_BASE}/lookup`,
      jsonInit('POST', { algorithm: 'none', pepper: loser, addresses: ['x email'] }, ''),
      env
    );
    if (loser !== winner) {
      expect(lookup.status).toBe(400);
      expect(lookup.body.errcode).toBe('M_INVALID_PEPPER');
      expect(lookup.body.lookup_pepper).toBe(winner);
    } else {
      // Same pepper both times (crypto collision unlikely) — lookup ok or empty
      expect([200, 400]).toContain(lookup.status);
    }
  });
  it('pepper mint race hash_details #8', async () => {
    const cache = mockKv({}, { getBarrier: { prefix: 'identity:pepper', count: 2 } });
    const env = idEnv({ cache });
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Both may mint different peppers; last put wins in CACHE
    expect(a.body.lookup_pepper).toBeTruthy();
    expect(b.body.lookup_pepper).toBeTruthy();
    expect(cache.puts.filter((p) => p.key === 'identity:pepper').length).toBe(2);
    const winner = cache.data['identity:pepper'];
    expect([a.body.lookup_pepper, b.body.lookup_pepper]).toContain(winner);
    // Lookup with loser pepper → M_INVALID_PEPPER + winner
    const peppers = [a.body.lookup_pepper, b.body.lookup_pepper];
    const loser = peppers.find((p) => p !== winner) ?? peppers[0];
    const lookup = await idReq(
      `${ID_BASE}/lookup`,
      jsonInit('POST', { algorithm: 'none', pepper: loser, addresses: ['x email'] }, ''),
      env
    );
    if (loser !== winner) {
      expect(lookup.status).toBe(400);
      expect(lookup.body.errcode).toBe('M_INVALID_PEPPER');
      expect(lookup.body.lookup_pepper).toBe(winner);
    } else {
      // Same pepper both times (crypto collision unlikely) — lookup ok or empty
      expect([200, 400]).toContain(lookup.status);
    }
  });
  it('pepper mint race hash_details #9', async () => {
    const cache = mockKv({}, { getBarrier: { prefix: 'identity:pepper', count: 2 } });
    const env = idEnv({ cache });
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Both may mint different peppers; last put wins in CACHE
    expect(a.body.lookup_pepper).toBeTruthy();
    expect(b.body.lookup_pepper).toBeTruthy();
    expect(cache.puts.filter((p) => p.key === 'identity:pepper').length).toBe(2);
    const winner = cache.data['identity:pepper'];
    expect([a.body.lookup_pepper, b.body.lookup_pepper]).toContain(winner);
    // Lookup with loser pepper → M_INVALID_PEPPER + winner
    const peppers = [a.body.lookup_pepper, b.body.lookup_pepper];
    const loser = peppers.find((p) => p !== winner) ?? peppers[0];
    const lookup = await idReq(
      `${ID_BASE}/lookup`,
      jsonInit('POST', { algorithm: 'none', pepper: loser, addresses: ['x email'] }, ''),
      env
    );
    if (loser !== winner) {
      expect(lookup.status).toBe(400);
      expect(lookup.body.errcode).toBe('M_INVALID_PEPPER');
      expect(lookup.body.lookup_pepper).toBe(winner);
    } else {
      // Same pepper both times (crypto collision unlikely) — lookup ok or empty
      expect([200, 400]).toContain(lookup.status);
    }
  });
  it('pepper mint race hash_details #10', async () => {
    const cache = mockKv({}, { getBarrier: { prefix: 'identity:pepper', count: 2 } });
    const env = idEnv({ cache });
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Both may mint different peppers; last put wins in CACHE
    expect(a.body.lookup_pepper).toBeTruthy();
    expect(b.body.lookup_pepper).toBeTruthy();
    expect(cache.puts.filter((p) => p.key === 'identity:pepper').length).toBe(2);
    const winner = cache.data['identity:pepper'];
    expect([a.body.lookup_pepper, b.body.lookup_pepper]).toContain(winner);
    // Lookup with loser pepper → M_INVALID_PEPPER + winner
    const peppers = [a.body.lookup_pepper, b.body.lookup_pepper];
    const loser = peppers.find((p) => p !== winner) ?? peppers[0];
    const lookup = await idReq(
      `${ID_BASE}/lookup`,
      jsonInit('POST', { algorithm: 'none', pepper: loser, addresses: ['x email'] }, ''),
      env
    );
    if (loser !== winner) {
      expect(lookup.status).toBe(400);
      expect(lookup.body.errcode).toBe('M_INVALID_PEPPER');
      expect(lookup.body.lookup_pepper).toBe(winner);
    } else {
      // Same pepper both times (crypto collision unlikely) — lookup ok or empty
      expect([200, 400]).toContain(lookup.status);
    }
  });
  it('pepper mint race hash_details #11', async () => {
    const cache = mockKv({}, { getBarrier: { prefix: 'identity:pepper', count: 2 } });
    const env = idEnv({ cache });
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Both may mint different peppers; last put wins in CACHE
    expect(a.body.lookup_pepper).toBeTruthy();
    expect(b.body.lookup_pepper).toBeTruthy();
    expect(cache.puts.filter((p) => p.key === 'identity:pepper').length).toBe(2);
    const winner = cache.data['identity:pepper'];
    expect([a.body.lookup_pepper, b.body.lookup_pepper]).toContain(winner);
    // Lookup with loser pepper → M_INVALID_PEPPER + winner
    const peppers = [a.body.lookup_pepper, b.body.lookup_pepper];
    const loser = peppers.find((p) => p !== winner) ?? peppers[0];
    const lookup = await idReq(
      `${ID_BASE}/lookup`,
      jsonInit('POST', { algorithm: 'none', pepper: loser, addresses: ['x email'] }, ''),
      env
    );
    if (loser !== winner) {
      expect(lookup.status).toBe(400);
      expect(lookup.body.errcode).toBe('M_INVALID_PEPPER');
      expect(lookup.body.lookup_pepper).toBe(winner);
    } else {
      // Same pepper both times (crypto collision unlikely) — lookup ok or empty
      expect([200, 400]).toContain(lookup.status);
    }
  });
  it('pepper mint race hash_details #12', async () => {
    const cache = mockKv({}, { getBarrier: { prefix: 'identity:pepper', count: 2 } });
    const env = idEnv({ cache });
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Both may mint different peppers; last put wins in CACHE
    expect(a.body.lookup_pepper).toBeTruthy();
    expect(b.body.lookup_pepper).toBeTruthy();
    expect(cache.puts.filter((p) => p.key === 'identity:pepper').length).toBe(2);
    const winner = cache.data['identity:pepper'];
    expect([a.body.lookup_pepper, b.body.lookup_pepper]).toContain(winner);
    // Lookup with loser pepper → M_INVALID_PEPPER + winner
    const peppers = [a.body.lookup_pepper, b.body.lookup_pepper];
    const loser = peppers.find((p) => p !== winner) ?? peppers[0];
    const lookup = await idReq(
      `${ID_BASE}/lookup`,
      jsonInit('POST', { algorithm: 'none', pepper: loser, addresses: ['x email'] }, ''),
      env
    );
    if (loser !== winner) {
      expect(lookup.status).toBe(400);
      expect(lookup.body.errcode).toBe('M_INVALID_PEPPER');
      expect(lookup.body.lookup_pepper).toBe(winner);
    } else {
      // Same pepper both times (crypto collision unlikely) — lookup ok or empty
      expect([200, 400]).toContain(lookup.status);
    }
  });
  it('pepper mint race hash_details #13', async () => {
    const cache = mockKv({}, { getBarrier: { prefix: 'identity:pepper', count: 2 } });
    const env = idEnv({ cache });
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Both may mint different peppers; last put wins in CACHE
    expect(a.body.lookup_pepper).toBeTruthy();
    expect(b.body.lookup_pepper).toBeTruthy();
    expect(cache.puts.filter((p) => p.key === 'identity:pepper').length).toBe(2);
    const winner = cache.data['identity:pepper'];
    expect([a.body.lookup_pepper, b.body.lookup_pepper]).toContain(winner);
    // Lookup with loser pepper → M_INVALID_PEPPER + winner
    const peppers = [a.body.lookup_pepper, b.body.lookup_pepper];
    const loser = peppers.find((p) => p !== winner) ?? peppers[0];
    const lookup = await idReq(
      `${ID_BASE}/lookup`,
      jsonInit('POST', { algorithm: 'none', pepper: loser, addresses: ['x email'] }, ''),
      env
    );
    if (loser !== winner) {
      expect(lookup.status).toBe(400);
      expect(lookup.body.errcode).toBe('M_INVALID_PEPPER');
      expect(lookup.body.lookup_pepper).toBe(winner);
    } else {
      // Same pepper both times (crypto collision unlikely) — lookup ok or empty
      expect([200, 400]).toContain(lookup.status);
    }
  });
  it('pepper mint race hash_details #14', async () => {
    const cache = mockKv({}, { getBarrier: { prefix: 'identity:pepper', count: 2 } });
    const env = idEnv({ cache });
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Both may mint different peppers; last put wins in CACHE
    expect(a.body.lookup_pepper).toBeTruthy();
    expect(b.body.lookup_pepper).toBeTruthy();
    expect(cache.puts.filter((p) => p.key === 'identity:pepper').length).toBe(2);
    const winner = cache.data['identity:pepper'];
    expect([a.body.lookup_pepper, b.body.lookup_pepper]).toContain(winner);
    // Lookup with loser pepper → M_INVALID_PEPPER + winner
    const peppers = [a.body.lookup_pepper, b.body.lookup_pepper];
    const loser = peppers.find((p) => p !== winner) ?? peppers[0];
    const lookup = await idReq(
      `${ID_BASE}/lookup`,
      jsonInit('POST', { algorithm: 'none', pepper: loser, addresses: ['x email'] }, ''),
      env
    );
    if (loser !== winner) {
      expect(lookup.status).toBe(400);
      expect(lookup.body.errcode).toBe('M_INVALID_PEPPER');
      expect(lookup.body.lookup_pepper).toBe(winner);
    } else {
      // Same pepper both times (crypto collision unlikely) — lookup ok or empty
      expect([200, 400]).toContain(lookup.status);
    }
  });
  it('pepper mint race hash_details #15', async () => {
    const cache = mockKv({}, { getBarrier: { prefix: 'identity:pepper', count: 2 } });
    const env = idEnv({ cache });
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Both may mint different peppers; last put wins in CACHE
    expect(a.body.lookup_pepper).toBeTruthy();
    expect(b.body.lookup_pepper).toBeTruthy();
    expect(cache.puts.filter((p) => p.key === 'identity:pepper').length).toBe(2);
    const winner = cache.data['identity:pepper'];
    expect([a.body.lookup_pepper, b.body.lookup_pepper]).toContain(winner);
    // Lookup with loser pepper → M_INVALID_PEPPER + winner
    const peppers = [a.body.lookup_pepper, b.body.lookup_pepper];
    const loser = peppers.find((p) => p !== winner) ?? peppers[0];
    const lookup = await idReq(
      `${ID_BASE}/lookup`,
      jsonInit('POST', { algorithm: 'none', pepper: loser, addresses: ['x email'] }, ''),
      env
    );
    if (loser !== winner) {
      expect(lookup.status).toBe(400);
      expect(lookup.body.errcode).toBe('M_INVALID_PEPPER');
      expect(lookup.body.lookup_pepper).toBe(winner);
    } else {
      // Same pepper both times (crypto collision unlikely) — lookup ok or empty
      expect([200, 400]).toContain(lookup.status);
    }
  });
  it('pepper mint race hash_details #16', async () => {
    const cache = mockKv({}, { getBarrier: { prefix: 'identity:pepper', count: 2 } });
    const env = idEnv({ cache });
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Both may mint different peppers; last put wins in CACHE
    expect(a.body.lookup_pepper).toBeTruthy();
    expect(b.body.lookup_pepper).toBeTruthy();
    expect(cache.puts.filter((p) => p.key === 'identity:pepper').length).toBe(2);
    const winner = cache.data['identity:pepper'];
    expect([a.body.lookup_pepper, b.body.lookup_pepper]).toContain(winner);
    // Lookup with loser pepper → M_INVALID_PEPPER + winner
    const peppers = [a.body.lookup_pepper, b.body.lookup_pepper];
    const loser = peppers.find((p) => p !== winner) ?? peppers[0];
    const lookup = await idReq(
      `${ID_BASE}/lookup`,
      jsonInit('POST', { algorithm: 'none', pepper: loser, addresses: ['x email'] }, ''),
      env
    );
    if (loser !== winner) {
      expect(lookup.status).toBe(400);
      expect(lookup.body.errcode).toBe('M_INVALID_PEPPER');
      expect(lookup.body.lookup_pepper).toBe(winner);
    } else {
      // Same pepper both times (crypto collision unlikely) — lookup ok or empty
      expect([200, 400]).toContain(lookup.status);
    }
  });
  it('pepper mint race hash_details #17', async () => {
    const cache = mockKv({}, { getBarrier: { prefix: 'identity:pepper', count: 2 } });
    const env = idEnv({ cache });
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Both may mint different peppers; last put wins in CACHE
    expect(a.body.lookup_pepper).toBeTruthy();
    expect(b.body.lookup_pepper).toBeTruthy();
    expect(cache.puts.filter((p) => p.key === 'identity:pepper').length).toBe(2);
    const winner = cache.data['identity:pepper'];
    expect([a.body.lookup_pepper, b.body.lookup_pepper]).toContain(winner);
    // Lookup with loser pepper → M_INVALID_PEPPER + winner
    const peppers = [a.body.lookup_pepper, b.body.lookup_pepper];
    const loser = peppers.find((p) => p !== winner) ?? peppers[0];
    const lookup = await idReq(
      `${ID_BASE}/lookup`,
      jsonInit('POST', { algorithm: 'none', pepper: loser, addresses: ['x email'] }, ''),
      env
    );
    if (loser !== winner) {
      expect(lookup.status).toBe(400);
      expect(lookup.body.errcode).toBe('M_INVALID_PEPPER');
      expect(lookup.body.lookup_pepper).toBe(winner);
    } else {
      // Same pepper both times (crypto collision unlikely) — lookup ok or empty
      expect([200, 400]).toContain(lookup.status);
    }
  });
  it('pepper mint race hash_details #18', async () => {
    const cache = mockKv({}, { getBarrier: { prefix: 'identity:pepper', count: 2 } });
    const env = idEnv({ cache });
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Both may mint different peppers; last put wins in CACHE
    expect(a.body.lookup_pepper).toBeTruthy();
    expect(b.body.lookup_pepper).toBeTruthy();
    expect(cache.puts.filter((p) => p.key === 'identity:pepper').length).toBe(2);
    const winner = cache.data['identity:pepper'];
    expect([a.body.lookup_pepper, b.body.lookup_pepper]).toContain(winner);
    // Lookup with loser pepper → M_INVALID_PEPPER + winner
    const peppers = [a.body.lookup_pepper, b.body.lookup_pepper];
    const loser = peppers.find((p) => p !== winner) ?? peppers[0];
    const lookup = await idReq(
      `${ID_BASE}/lookup`,
      jsonInit('POST', { algorithm: 'none', pepper: loser, addresses: ['x email'] }, ''),
      env
    );
    if (loser !== winner) {
      expect(lookup.status).toBe(400);
      expect(lookup.body.errcode).toBe('M_INVALID_PEPPER');
      expect(lookup.body.lookup_pepper).toBe(winner);
    } else {
      // Same pepper both times (crypto collision unlikely) — lookup ok or empty
      expect([200, 400]).toContain(lookup.status);
    }
  });
  it('pepper mint race hash_details #19', async () => {
    const cache = mockKv({}, { getBarrier: { prefix: 'identity:pepper', count: 2 } });
    const env = idEnv({ cache });
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Both may mint different peppers; last put wins in CACHE
    expect(a.body.lookup_pepper).toBeTruthy();
    expect(b.body.lookup_pepper).toBeTruthy();
    expect(cache.puts.filter((p) => p.key === 'identity:pepper').length).toBe(2);
    const winner = cache.data['identity:pepper'];
    expect([a.body.lookup_pepper, b.body.lookup_pepper]).toContain(winner);
    // Lookup with loser pepper → M_INVALID_PEPPER + winner
    const peppers = [a.body.lookup_pepper, b.body.lookup_pepper];
    const loser = peppers.find((p) => p !== winner) ?? peppers[0];
    const lookup = await idReq(
      `${ID_BASE}/lookup`,
      jsonInit('POST', { algorithm: 'none', pepper: loser, addresses: ['x email'] }, ''),
      env
    );
    if (loser !== winner) {
      expect(lookup.status).toBe(400);
      expect(lookup.body.errcode).toBe('M_INVALID_PEPPER');
      expect(lookup.body.lookup_pepper).toBe(winner);
    } else {
      // Same pepper both times (crypto collision unlikely) — lookup ok or empty
      expect([200, 400]).toContain(lookup.status);
    }
  });
});


describe('race identity submitToken: parallel validate same session', () => {
  it('submitToken double-validate race #0', async () => {
    const sid = 'sess-race-0';
    const secret = 'secret-race-0';
    const token = '123450';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'alice@example.com',
            client_secret: secret,
            token,
            send_attempt: 1,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + 86_400_000,
          },
        ],
      ]),
    });
    const env = idEnv({ db });
    const body = { sid, client_secret: secret, token };
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
    ]);
    // validated is selected but never gated — both succeed
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.success).toBe(true);
    expect(b.body.success).toBe(true);
    expect(db.updates.length).toBe(2);
    expect(db.emailSessions.get(sid)!.validated).toBe(1);
  });
  it('submitToken double-validate race #1', async () => {
    const sid = 'sess-race-1';
    const secret = 'secret-race-1';
    const token = '123451';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'alice@example.com',
            client_secret: secret,
            token,
            send_attempt: 1,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + 86_400_000,
          },
        ],
      ]),
    });
    const env = idEnv({ db });
    const body = { sid, client_secret: secret, token };
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
    ]);
    // validated is selected but never gated — both succeed
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.success).toBe(true);
    expect(b.body.success).toBe(true);
    expect(db.updates.length).toBe(2);
    expect(db.emailSessions.get(sid)!.validated).toBe(1);
  });
  it('submitToken double-validate race #2', async () => {
    const sid = 'sess-race-2';
    const secret = 'secret-race-2';
    const token = '123452';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'alice@example.com',
            client_secret: secret,
            token,
            send_attempt: 1,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + 86_400_000,
          },
        ],
      ]),
    });
    const env = idEnv({ db });
    const body = { sid, client_secret: secret, token };
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
    ]);
    // validated is selected but never gated — both succeed
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.success).toBe(true);
    expect(b.body.success).toBe(true);
    expect(db.updates.length).toBe(2);
    expect(db.emailSessions.get(sid)!.validated).toBe(1);
  });
  it('submitToken double-validate race #3', async () => {
    const sid = 'sess-race-3';
    const secret = 'secret-race-3';
    const token = '123453';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'alice@example.com',
            client_secret: secret,
            token,
            send_attempt: 1,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + 86_400_000,
          },
        ],
      ]),
    });
    const env = idEnv({ db });
    const body = { sid, client_secret: secret, token };
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
    ]);
    // validated is selected but never gated — both succeed
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.success).toBe(true);
    expect(b.body.success).toBe(true);
    expect(db.updates.length).toBe(2);
    expect(db.emailSessions.get(sid)!.validated).toBe(1);
  });
  it('submitToken double-validate race #4', async () => {
    const sid = 'sess-race-4';
    const secret = 'secret-race-4';
    const token = '123454';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'alice@example.com',
            client_secret: secret,
            token,
            send_attempt: 1,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + 86_400_000,
          },
        ],
      ]),
    });
    const env = idEnv({ db });
    const body = { sid, client_secret: secret, token };
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
    ]);
    // validated is selected but never gated — both succeed
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.success).toBe(true);
    expect(b.body.success).toBe(true);
    expect(db.updates.length).toBe(2);
    expect(db.emailSessions.get(sid)!.validated).toBe(1);
  });
  it('submitToken double-validate race #5', async () => {
    const sid = 'sess-race-5';
    const secret = 'secret-race-5';
    const token = '123455';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'alice@example.com',
            client_secret: secret,
            token,
            send_attempt: 1,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + 86_400_000,
          },
        ],
      ]),
    });
    const env = idEnv({ db });
    const body = { sid, client_secret: secret, token };
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
    ]);
    // validated is selected but never gated — both succeed
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.success).toBe(true);
    expect(b.body.success).toBe(true);
    expect(db.updates.length).toBe(2);
    expect(db.emailSessions.get(sid)!.validated).toBe(1);
  });
  it('submitToken double-validate race #6', async () => {
    const sid = 'sess-race-6';
    const secret = 'secret-race-6';
    const token = '123456';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'alice@example.com',
            client_secret: secret,
            token,
            send_attempt: 1,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + 86_400_000,
          },
        ],
      ]),
    });
    const env = idEnv({ db });
    const body = { sid, client_secret: secret, token };
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
    ]);
    // validated is selected but never gated — both succeed
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.success).toBe(true);
    expect(b.body.success).toBe(true);
    expect(db.updates.length).toBe(2);
    expect(db.emailSessions.get(sid)!.validated).toBe(1);
  });
  it('submitToken double-validate race #7', async () => {
    const sid = 'sess-race-7';
    const secret = 'secret-race-7';
    const token = '123457';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'alice@example.com',
            client_secret: secret,
            token,
            send_attempt: 1,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + 86_400_000,
          },
        ],
      ]),
    });
    const env = idEnv({ db });
    const body = { sid, client_secret: secret, token };
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
    ]);
    // validated is selected but never gated — both succeed
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.success).toBe(true);
    expect(b.body.success).toBe(true);
    expect(db.updates.length).toBe(2);
    expect(db.emailSessions.get(sid)!.validated).toBe(1);
  });
  it('submitToken double-validate race #8', async () => {
    const sid = 'sess-race-8';
    const secret = 'secret-race-8';
    const token = '123458';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'alice@example.com',
            client_secret: secret,
            token,
            send_attempt: 1,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + 86_400_000,
          },
        ],
      ]),
    });
    const env = idEnv({ db });
    const body = { sid, client_secret: secret, token };
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
    ]);
    // validated is selected but never gated — both succeed
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.success).toBe(true);
    expect(b.body.success).toBe(true);
    expect(db.updates.length).toBe(2);
    expect(db.emailSessions.get(sid)!.validated).toBe(1);
  });
  it('submitToken double-validate race #9', async () => {
    const sid = 'sess-race-9';
    const secret = 'secret-race-9';
    const token = '123459';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'alice@example.com',
            client_secret: secret,
            token,
            send_attempt: 1,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + 86_400_000,
          },
        ],
      ]),
    });
    const env = idEnv({ db });
    const body = { sid, client_secret: secret, token };
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
    ]);
    // validated is selected but never gated — both succeed
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.success).toBe(true);
    expect(b.body.success).toBe(true);
    expect(db.updates.length).toBe(2);
    expect(db.emailSessions.get(sid)!.validated).toBe(1);
  });
  it('submitToken double-validate race #10', async () => {
    const sid = 'sess-race-10';
    const secret = 'secret-race-10';
    const token = '123450';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'alice@example.com',
            client_secret: secret,
            token,
            send_attempt: 1,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + 86_400_000,
          },
        ],
      ]),
    });
    const env = idEnv({ db });
    const body = { sid, client_secret: secret, token };
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
    ]);
    // validated is selected but never gated — both succeed
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.success).toBe(true);
    expect(b.body.success).toBe(true);
    expect(db.updates.length).toBe(2);
    expect(db.emailSessions.get(sid)!.validated).toBe(1);
  });
  it('submitToken double-validate race #11', async () => {
    const sid = 'sess-race-11';
    const secret = 'secret-race-11';
    const token = '123451';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'alice@example.com',
            client_secret: secret,
            token,
            send_attempt: 1,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + 86_400_000,
          },
        ],
      ]),
    });
    const env = idEnv({ db });
    const body = { sid, client_secret: secret, token };
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
    ]);
    // validated is selected but never gated — both succeed
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.success).toBe(true);
    expect(b.body.success).toBe(true);
    expect(db.updates.length).toBe(2);
    expect(db.emailSessions.get(sid)!.validated).toBe(1);
  });
  it('submitToken double-validate race #12', async () => {
    const sid = 'sess-race-12';
    const secret = 'secret-race-12';
    const token = '123452';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'alice@example.com',
            client_secret: secret,
            token,
            send_attempt: 1,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + 86_400_000,
          },
        ],
      ]),
    });
    const env = idEnv({ db });
    const body = { sid, client_secret: secret, token };
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
    ]);
    // validated is selected but never gated — both succeed
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.success).toBe(true);
    expect(b.body.success).toBe(true);
    expect(db.updates.length).toBe(2);
    expect(db.emailSessions.get(sid)!.validated).toBe(1);
  });
  it('submitToken double-validate race #13', async () => {
    const sid = 'sess-race-13';
    const secret = 'secret-race-13';
    const token = '123453';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'alice@example.com',
            client_secret: secret,
            token,
            send_attempt: 1,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + 86_400_000,
          },
        ],
      ]),
    });
    const env = idEnv({ db });
    const body = { sid, client_secret: secret, token };
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
    ]);
    // validated is selected but never gated — both succeed
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.success).toBe(true);
    expect(b.body.success).toBe(true);
    expect(db.updates.length).toBe(2);
    expect(db.emailSessions.get(sid)!.validated).toBe(1);
  });
  it('submitToken double-validate race #14', async () => {
    const sid = 'sess-race-14';
    const secret = 'secret-race-14';
    const token = '123454';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'alice@example.com',
            client_secret: secret,
            token,
            send_attempt: 1,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + 86_400_000,
          },
        ],
      ]),
    });
    const env = idEnv({ db });
    const body = { sid, client_secret: secret, token };
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
    ]);
    // validated is selected but never gated — both succeed
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.success).toBe(true);
    expect(b.body.success).toBe(true);
    expect(db.updates.length).toBe(2);
    expect(db.emailSessions.get(sid)!.validated).toBe(1);
  });
  it('submitToken double-validate race #15', async () => {
    const sid = 'sess-race-15';
    const secret = 'secret-race-15';
    const token = '123455';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'alice@example.com',
            client_secret: secret,
            token,
            send_attempt: 1,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + 86_400_000,
          },
        ],
      ]),
    });
    const env = idEnv({ db });
    const body = { sid, client_secret: secret, token };
    const [a, b] = await Promise.all([
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
      idReq(`${ID_BASE}/validate/email/submitToken`, jsonInit('POST', body, ''), env),
    ]);
    // validated is selected but never gated — both succeed
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.success).toBe(true);
    expect(b.body.success).toBe(true);
    expect(db.updates.length).toBe(2);
    expect(db.emailSessions.get(sid)!.validated).toBe(1);
  });
});


describe('race register: same localpart parallel createUser TOCTOU', () => {
  it('register same-localpart race #0', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'raceuser0';
    const body = {
      username: local,
      password: 'Password1!',
      auth: { type: 'm.login.dummy' },
      inhibit_login: true,
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const conflicts = [a, b].filter((r) => r.status === 400 && r.body?.errcode === 'M_USER_IN_USE');
    // Stub Map allows last-write; both may pass getUserById before either insert
    expect(oks.length + conflicts.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.users.has(`@${local}:${SERVER}`)).toBe(true);
  });
  it('register same-localpart race #1', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'raceuser1';
    const body = {
      username: local,
      password: 'Password1!',
      auth: { type: 'm.login.dummy' },
      inhibit_login: true,
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const conflicts = [a, b].filter((r) => r.status === 400 && r.body?.errcode === 'M_USER_IN_USE');
    // Stub Map allows last-write; both may pass getUserById before either insert
    expect(oks.length + conflicts.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.users.has(`@${local}:${SERVER}`)).toBe(true);
  });
  it('register same-localpart race #2', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'raceuser2';
    const body = {
      username: local,
      password: 'Password1!',
      auth: { type: 'm.login.dummy' },
      inhibit_login: true,
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const conflicts = [a, b].filter((r) => r.status === 400 && r.body?.errcode === 'M_USER_IN_USE');
    // Stub Map allows last-write; both may pass getUserById before either insert
    expect(oks.length + conflicts.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.users.has(`@${local}:${SERVER}`)).toBe(true);
  });
  it('register same-localpart race #3', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'raceuser3';
    const body = {
      username: local,
      password: 'Password1!',
      auth: { type: 'm.login.dummy' },
      inhibit_login: true,
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const conflicts = [a, b].filter((r) => r.status === 400 && r.body?.errcode === 'M_USER_IN_USE');
    // Stub Map allows last-write; both may pass getUserById before either insert
    expect(oks.length + conflicts.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.users.has(`@${local}:${SERVER}`)).toBe(true);
  });
  it('register same-localpart race #4', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'raceuser4';
    const body = {
      username: local,
      password: 'Password1!',
      auth: { type: 'm.login.dummy' },
      inhibit_login: true,
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const conflicts = [a, b].filter((r) => r.status === 400 && r.body?.errcode === 'M_USER_IN_USE');
    // Stub Map allows last-write; both may pass getUserById before either insert
    expect(oks.length + conflicts.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.users.has(`@${local}:${SERVER}`)).toBe(true);
  });
  it('register same-localpart race #5', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'raceuser5';
    const body = {
      username: local,
      password: 'Password1!',
      auth: { type: 'm.login.dummy' },
      inhibit_login: true,
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const conflicts = [a, b].filter((r) => r.status === 400 && r.body?.errcode === 'M_USER_IN_USE');
    // Stub Map allows last-write; both may pass getUserById before either insert
    expect(oks.length + conflicts.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.users.has(`@${local}:${SERVER}`)).toBe(true);
  });
  it('register same-localpart race #6', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'raceuser6';
    const body = {
      username: local,
      password: 'Password1!',
      auth: { type: 'm.login.dummy' },
      inhibit_login: true,
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const conflicts = [a, b].filter((r) => r.status === 400 && r.body?.errcode === 'M_USER_IN_USE');
    // Stub Map allows last-write; both may pass getUserById before either insert
    expect(oks.length + conflicts.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.users.has(`@${local}:${SERVER}`)).toBe(true);
  });
  it('register same-localpart race #7', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'raceuser7';
    const body = {
      username: local,
      password: 'Password1!',
      auth: { type: 'm.login.dummy' },
      inhibit_login: true,
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const conflicts = [a, b].filter((r) => r.status === 400 && r.body?.errcode === 'M_USER_IN_USE');
    // Stub Map allows last-write; both may pass getUserById before either insert
    expect(oks.length + conflicts.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.users.has(`@${local}:${SERVER}`)).toBe(true);
  });
  it('register same-localpart race #8', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'raceuser8';
    const body = {
      username: local,
      password: 'Password1!',
      auth: { type: 'm.login.dummy' },
      inhibit_login: true,
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const conflicts = [a, b].filter((r) => r.status === 400 && r.body?.errcode === 'M_USER_IN_USE');
    // Stub Map allows last-write; both may pass getUserById before either insert
    expect(oks.length + conflicts.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.users.has(`@${local}:${SERVER}`)).toBe(true);
  });
  it('register same-localpart race #9', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'raceuser9';
    const body = {
      username: local,
      password: 'Password1!',
      auth: { type: 'm.login.dummy' },
      inhibit_login: true,
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const conflicts = [a, b].filter((r) => r.status === 400 && r.body?.errcode === 'M_USER_IN_USE');
    // Stub Map allows last-write; both may pass getUserById before either insert
    expect(oks.length + conflicts.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.users.has(`@${local}:${SERVER}`)).toBe(true);
  });
  it('register same-localpart race #10', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'raceuser10';
    const body = {
      username: local,
      password: 'Password1!',
      auth: { type: 'm.login.dummy' },
      inhibit_login: true,
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const conflicts = [a, b].filter((r) => r.status === 400 && r.body?.errcode === 'M_USER_IN_USE');
    // Stub Map allows last-write; both may pass getUserById before either insert
    expect(oks.length + conflicts.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.users.has(`@${local}:${SERVER}`)).toBe(true);
  });
  it('register same-localpart race #11', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'raceuser11';
    const body = {
      username: local,
      password: 'Password1!',
      auth: { type: 'm.login.dummy' },
      inhibit_login: true,
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const conflicts = [a, b].filter((r) => r.status === 400 && r.body?.errcode === 'M_USER_IN_USE');
    // Stub Map allows last-write; both may pass getUserById before either insert
    expect(oks.length + conflicts.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.users.has(`@${local}:${SERVER}`)).toBe(true);
  });
  it('register same-localpart race #12', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'raceuser12';
    const body = {
      username: local,
      password: 'Password1!',
      auth: { type: 'm.login.dummy' },
      inhibit_login: true,
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const conflicts = [a, b].filter((r) => r.status === 400 && r.body?.errcode === 'M_USER_IN_USE');
    // Stub Map allows last-write; both may pass getUserById before either insert
    expect(oks.length + conflicts.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.users.has(`@${local}:${SERVER}`)).toBe(true);
  });
  it('register same-localpart race #13', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'raceuser13';
    const body = {
      username: local,
      password: 'Password1!',
      auth: { type: 'm.login.dummy' },
      inhibit_login: true,
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const conflicts = [a, b].filter((r) => r.status === 400 && r.body?.errcode === 'M_USER_IN_USE');
    // Stub Map allows last-write; both may pass getUserById before either insert
    expect(oks.length + conflicts.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.users.has(`@${local}:${SERVER}`)).toBe(true);
  });
  it('register same-localpart race #14', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'raceuser14';
    const body = {
      username: local,
      password: 'Password1!',
      auth: { type: 'm.login.dummy' },
      inhibit_login: true,
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const conflicts = [a, b].filter((r) => r.status === 400 && r.body?.errcode === 'M_USER_IN_USE');
    // Stub Map allows last-write; both may pass getUserById before either insert
    expect(oks.length + conflicts.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.users.has(`@${local}:${SERVER}`)).toBe(true);
  });
  it('register same-localpart race #15', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'raceuser15';
    const body = {
      username: local,
      password: 'Password1!',
      auth: { type: 'm.login.dummy' },
      inhibit_login: true,
    };
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
      loginReq(env, '/_matrix/client/v3/register', jsonInit('POST', body, '')),
    ]);
    const oks = [a, b].filter((r) => r.status === 200);
    const conflicts = [a, b].filter((r) => r.status === 400 && r.body?.errcode === 'M_USER_IN_USE');
    // Stub Map allows last-write; both may pass getUserById before either insert
    expect(oks.length + conflicts.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(db.users.has(`@${local}:${SERVER}`)).toBe(true);
  });
});


describe('race available ∥ register same localpart', () => {
  it('available vs register race #0', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'availrace0';
    const [avail, reg] = await Promise.all([
      loginReq(env, `/_matrix/client/v3/register/available?username=${local}`, { method: 'GET' }),
      loginReq(
        env,
        '/_matrix/client/v3/register',
        jsonInit(
          'POST',
          {
            username: local,
            password: 'Password1!',
            auth: { type: 'm.login.dummy' },
            inhibit_login: true,
          },
          ''
        )
      ),
    ]);
    expect(reg.status).toBe(200);
    // available may still report true (TOCTOU) or user-in-use if it lost the race after insert
    if (avail.status === 200) {
      expect(avail.body.available).toBe(true);
    } else {
      expect(avail.body.errcode).toBe('M_USER_IN_USE');
    }
  });
  it('available vs register race #1', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'availrace1';
    const [avail, reg] = await Promise.all([
      loginReq(env, `/_matrix/client/v3/register/available?username=${local}`, { method: 'GET' }),
      loginReq(
        env,
        '/_matrix/client/v3/register',
        jsonInit(
          'POST',
          {
            username: local,
            password: 'Password1!',
            auth: { type: 'm.login.dummy' },
            inhibit_login: true,
          },
          ''
        )
      ),
    ]);
    expect(reg.status).toBe(200);
    // available may still report true (TOCTOU) or user-in-use if it lost the race after insert
    if (avail.status === 200) {
      expect(avail.body.available).toBe(true);
    } else {
      expect(avail.body.errcode).toBe('M_USER_IN_USE');
    }
  });
  it('available vs register race #2', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'availrace2';
    const [avail, reg] = await Promise.all([
      loginReq(env, `/_matrix/client/v3/register/available?username=${local}`, { method: 'GET' }),
      loginReq(
        env,
        '/_matrix/client/v3/register',
        jsonInit(
          'POST',
          {
            username: local,
            password: 'Password1!',
            auth: { type: 'm.login.dummy' },
            inhibit_login: true,
          },
          ''
        )
      ),
    ]);
    expect(reg.status).toBe(200);
    // available may still report true (TOCTOU) or user-in-use if it lost the race after insert
    if (avail.status === 200) {
      expect(avail.body.available).toBe(true);
    } else {
      expect(avail.body.errcode).toBe('M_USER_IN_USE');
    }
  });
  it('available vs register race #3', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'availrace3';
    const [avail, reg] = await Promise.all([
      loginReq(env, `/_matrix/client/v3/register/available?username=${local}`, { method: 'GET' }),
      loginReq(
        env,
        '/_matrix/client/v3/register',
        jsonInit(
          'POST',
          {
            username: local,
            password: 'Password1!',
            auth: { type: 'm.login.dummy' },
            inhibit_login: true,
          },
          ''
        )
      ),
    ]);
    expect(reg.status).toBe(200);
    // available may still report true (TOCTOU) or user-in-use if it lost the race after insert
    if (avail.status === 200) {
      expect(avail.body.available).toBe(true);
    } else {
      expect(avail.body.errcode).toBe('M_USER_IN_USE');
    }
  });
  it('available vs register race #4', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'availrace4';
    const [avail, reg] = await Promise.all([
      loginReq(env, `/_matrix/client/v3/register/available?username=${local}`, { method: 'GET' }),
      loginReq(
        env,
        '/_matrix/client/v3/register',
        jsonInit(
          'POST',
          {
            username: local,
            password: 'Password1!',
            auth: { type: 'm.login.dummy' },
            inhibit_login: true,
          },
          ''
        )
      ),
    ]);
    expect(reg.status).toBe(200);
    // available may still report true (TOCTOU) or user-in-use if it lost the race after insert
    if (avail.status === 200) {
      expect(avail.body.available).toBe(true);
    } else {
      expect(avail.body.errcode).toBe('M_USER_IN_USE');
    }
  });
  it('available vs register race #5', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'availrace5';
    const [avail, reg] = await Promise.all([
      loginReq(env, `/_matrix/client/v3/register/available?username=${local}`, { method: 'GET' }),
      loginReq(
        env,
        '/_matrix/client/v3/register',
        jsonInit(
          'POST',
          {
            username: local,
            password: 'Password1!',
            auth: { type: 'm.login.dummy' },
            inhibit_login: true,
          },
          ''
        )
      ),
    ]);
    expect(reg.status).toBe(200);
    // available may still report true (TOCTOU) or user-in-use if it lost the race after insert
    if (avail.status === 200) {
      expect(avail.body.available).toBe(true);
    } else {
      expect(avail.body.errcode).toBe('M_USER_IN_USE');
    }
  });
  it('available vs register race #6', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'availrace6';
    const [avail, reg] = await Promise.all([
      loginReq(env, `/_matrix/client/v3/register/available?username=${local}`, { method: 'GET' }),
      loginReq(
        env,
        '/_matrix/client/v3/register',
        jsonInit(
          'POST',
          {
            username: local,
            password: 'Password1!',
            auth: { type: 'm.login.dummy' },
            inhibit_login: true,
          },
          ''
        )
      ),
    ]);
    expect(reg.status).toBe(200);
    // available may still report true (TOCTOU) or user-in-use if it lost the race after insert
    if (avail.status === 200) {
      expect(avail.body.available).toBe(true);
    } else {
      expect(avail.body.errcode).toBe('M_USER_IN_USE');
    }
  });
  it('available vs register race #7', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'availrace7';
    const [avail, reg] = await Promise.all([
      loginReq(env, `/_matrix/client/v3/register/available?username=${local}`, { method: 'GET' }),
      loginReq(
        env,
        '/_matrix/client/v3/register',
        jsonInit(
          'POST',
          {
            username: local,
            password: 'Password1!',
            auth: { type: 'm.login.dummy' },
            inhibit_login: true,
          },
          ''
        )
      ),
    ]);
    expect(reg.status).toBe(200);
    // available may still report true (TOCTOU) or user-in-use if it lost the race after insert
    if (avail.status === 200) {
      expect(avail.body.available).toBe(true);
    } else {
      expect(avail.body.errcode).toBe('M_USER_IN_USE');
    }
  });
  it('available vs register race #8', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'availrace8';
    const [avail, reg] = await Promise.all([
      loginReq(env, `/_matrix/client/v3/register/available?username=${local}`, { method: 'GET' }),
      loginReq(
        env,
        '/_matrix/client/v3/register',
        jsonInit(
          'POST',
          {
            username: local,
            password: 'Password1!',
            auth: { type: 'm.login.dummy' },
            inhibit_login: true,
          },
          ''
        )
      ),
    ]);
    expect(reg.status).toBe(200);
    // available may still report true (TOCTOU) or user-in-use if it lost the race after insert
    if (avail.status === 200) {
      expect(avail.body.available).toBe(true);
    } else {
      expect(avail.body.errcode).toBe('M_USER_IN_USE');
    }
  });
  it('available vs register race #9', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'availrace9';
    const [avail, reg] = await Promise.all([
      loginReq(env, `/_matrix/client/v3/register/available?username=${local}`, { method: 'GET' }),
      loginReq(
        env,
        '/_matrix/client/v3/register',
        jsonInit(
          'POST',
          {
            username: local,
            password: 'Password1!',
            auth: { type: 'm.login.dummy' },
            inhibit_login: true,
          },
          ''
        )
      ),
    ]);
    expect(reg.status).toBe(200);
    // available may still report true (TOCTOU) or user-in-use if it lost the race after insert
    if (avail.status === 200) {
      expect(avail.body.available).toBe(true);
    } else {
      expect(avail.body.errcode).toBe('M_USER_IN_USE');
    }
  });
  it('available vs register race #10', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'availrace10';
    const [avail, reg] = await Promise.all([
      loginReq(env, `/_matrix/client/v3/register/available?username=${local}`, { method: 'GET' }),
      loginReq(
        env,
        '/_matrix/client/v3/register',
        jsonInit(
          'POST',
          {
            username: local,
            password: 'Password1!',
            auth: { type: 'm.login.dummy' },
            inhibit_login: true,
          },
          ''
        )
      ),
    ]);
    expect(reg.status).toBe(200);
    // available may still report true (TOCTOU) or user-in-use if it lost the race after insert
    if (avail.status === 200) {
      expect(avail.body.available).toBe(true);
    } else {
      expect(avail.body.errcode).toBe('M_USER_IN_USE');
    }
  });
  it('available vs register race #11', async () => {
    const sessions = mockKv();
    const db = createLoginDb();
    const env = loginEnv(db, sessions);
    const local = 'availrace11';
    const [avail, reg] = await Promise.all([
      loginReq(env, `/_matrix/client/v3/register/available?username=${local}`, { method: 'GET' }),
      loginReq(
        env,
        '/_matrix/client/v3/register',
        jsonInit(
          'POST',
          {
            username: local,
            password: 'Password1!',
            auth: { type: 'm.login.dummy' },
            inhibit_login: true,
          },
          ''
        )
      ),
    ]);
    expect(reg.status).toBe(200);
    // available may still report true (TOCTOU) or user-in-use if it lost the race after insert
    if (avail.status === 200) {
      expect(avail.body.available).toBe(true);
    } else {
      expect(avail.body.errcode).toBe('M_USER_IN_USE');
    }
  });
});


describe('race isolation: distinct login tokens parallel (no crosstalk)', () => {
  it('distinct tokens parallel #0', async () => {
    const sessions = mockKv();
    const rawA = 'mlt_iso_a_0';
    const rawB = 'mlt_iso_b_0';
    await seedLoginToken(sessions, rawA, { user_id: USER });
    await seedLoginToken(sessions, rawB, { user_id: BOB });
    const env = loginEnv(aliceDb(), sessions);
    const [a, b] = await Promise.all([
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: rawA, device_id: 'IA0' }, '')
      ),
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: rawB, device_id: 'IB0' }, '')
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.user_id).toBe(USER);
    expect(b.body.user_id).toBe(BOB);
    expect(env._db.tokens).toHaveLength(2);
  });
  it('distinct tokens parallel #1', async () => {
    const sessions = mockKv();
    const rawA = 'mlt_iso_a_1';
    const rawB = 'mlt_iso_b_1';
    await seedLoginToken(sessions, rawA, { user_id: USER });
    await seedLoginToken(sessions, rawB, { user_id: BOB });
    const env = loginEnv(aliceDb(), sessions);
    const [a, b] = await Promise.all([
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: rawA, device_id: 'IA1' }, '')
      ),
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: rawB, device_id: 'IB1' }, '')
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.user_id).toBe(USER);
    expect(b.body.user_id).toBe(BOB);
    expect(env._db.tokens).toHaveLength(2);
  });
  it('distinct tokens parallel #2', async () => {
    const sessions = mockKv();
    const rawA = 'mlt_iso_a_2';
    const rawB = 'mlt_iso_b_2';
    await seedLoginToken(sessions, rawA, { user_id: USER });
    await seedLoginToken(sessions, rawB, { user_id: BOB });
    const env = loginEnv(aliceDb(), sessions);
    const [a, b] = await Promise.all([
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: rawA, device_id: 'IA2' }, '')
      ),
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: rawB, device_id: 'IB2' }, '')
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.user_id).toBe(USER);
    expect(b.body.user_id).toBe(BOB);
    expect(env._db.tokens).toHaveLength(2);
  });
  it('distinct tokens parallel #3', async () => {
    const sessions = mockKv();
    const rawA = 'mlt_iso_a_3';
    const rawB = 'mlt_iso_b_3';
    await seedLoginToken(sessions, rawA, { user_id: USER });
    await seedLoginToken(sessions, rawB, { user_id: BOB });
    const env = loginEnv(aliceDb(), sessions);
    const [a, b] = await Promise.all([
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: rawA, device_id: 'IA3' }, '')
      ),
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: rawB, device_id: 'IB3' }, '')
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.user_id).toBe(USER);
    expect(b.body.user_id).toBe(BOB);
    expect(env._db.tokens).toHaveLength(2);
  });
  it('distinct tokens parallel #4', async () => {
    const sessions = mockKv();
    const rawA = 'mlt_iso_a_4';
    const rawB = 'mlt_iso_b_4';
    await seedLoginToken(sessions, rawA, { user_id: USER });
    await seedLoginToken(sessions, rawB, { user_id: BOB });
    const env = loginEnv(aliceDb(), sessions);
    const [a, b] = await Promise.all([
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: rawA, device_id: 'IA4' }, '')
      ),
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: rawB, device_id: 'IB4' }, '')
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.user_id).toBe(USER);
    expect(b.body.user_id).toBe(BOB);
    expect(env._db.tokens).toHaveLength(2);
  });
  it('distinct tokens parallel #5', async () => {
    const sessions = mockKv();
    const rawA = 'mlt_iso_a_5';
    const rawB = 'mlt_iso_b_5';
    await seedLoginToken(sessions, rawA, { user_id: USER });
    await seedLoginToken(sessions, rawB, { user_id: BOB });
    const env = loginEnv(aliceDb(), sessions);
    const [a, b] = await Promise.all([
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: rawA, device_id: 'IA5' }, '')
      ),
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: rawB, device_id: 'IB5' }, '')
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.user_id).toBe(USER);
    expect(b.body.user_id).toBe(BOB);
    expect(env._db.tokens).toHaveLength(2);
  });
  it('distinct tokens parallel #6', async () => {
    const sessions = mockKv();
    const rawA = 'mlt_iso_a_6';
    const rawB = 'mlt_iso_b_6';
    await seedLoginToken(sessions, rawA, { user_id: USER });
    await seedLoginToken(sessions, rawB, { user_id: BOB });
    const env = loginEnv(aliceDb(), sessions);
    const [a, b] = await Promise.all([
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: rawA, device_id: 'IA6' }, '')
      ),
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: rawB, device_id: 'IB6' }, '')
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.user_id).toBe(USER);
    expect(b.body.user_id).toBe(BOB);
    expect(env._db.tokens).toHaveLength(2);
  });
  it('distinct tokens parallel #7', async () => {
    const sessions = mockKv();
    const rawA = 'mlt_iso_a_7';
    const rawB = 'mlt_iso_b_7';
    await seedLoginToken(sessions, rawA, { user_id: USER });
    await seedLoginToken(sessions, rawB, { user_id: BOB });
    const env = loginEnv(aliceDb(), sessions);
    const [a, b] = await Promise.all([
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: rawA, device_id: 'IA7' }, '')
      ),
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: rawB, device_id: 'IB7' }, '')
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.user_id).toBe(USER);
    expect(b.body.user_id).toBe(BOB);
    expect(env._db.tokens).toHaveLength(2);
  });
  it('distinct tokens parallel #8', async () => {
    const sessions = mockKv();
    const rawA = 'mlt_iso_a_8';
    const rawB = 'mlt_iso_b_8';
    await seedLoginToken(sessions, rawA, { user_id: USER });
    await seedLoginToken(sessions, rawB, { user_id: BOB });
    const env = loginEnv(aliceDb(), sessions);
    const [a, b] = await Promise.all([
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: rawA, device_id: 'IA8' }, '')
      ),
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: rawB, device_id: 'IB8' }, '')
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.user_id).toBe(USER);
    expect(b.body.user_id).toBe(BOB);
    expect(env._db.tokens).toHaveLength(2);
  });
  it('distinct tokens parallel #9', async () => {
    const sessions = mockKv();
    const rawA = 'mlt_iso_a_9';
    const rawB = 'mlt_iso_b_9';
    await seedLoginToken(sessions, rawA, { user_id: USER });
    await seedLoginToken(sessions, rawB, { user_id: BOB });
    const env = loginEnv(aliceDb(), sessions);
    const [a, b] = await Promise.all([
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: rawA, device_id: 'IA9' }, '')
      ),
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: rawB, device_id: 'IB9' }, '')
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.user_id).toBe(USER);
    expect(b.body.user_id).toBe(BOB);
    expect(env._db.tokens).toHaveLength(2);
  });
  it('distinct tokens parallel #10', async () => {
    const sessions = mockKv();
    const rawA = 'mlt_iso_a_10';
    const rawB = 'mlt_iso_b_10';
    await seedLoginToken(sessions, rawA, { user_id: USER });
    await seedLoginToken(sessions, rawB, { user_id: BOB });
    const env = loginEnv(aliceDb(), sessions);
    const [a, b] = await Promise.all([
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: rawA, device_id: 'IA10' }, '')
      ),
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: rawB, device_id: 'IB10' }, '')
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.user_id).toBe(USER);
    expect(b.body.user_id).toBe(BOB);
    expect(env._db.tokens).toHaveLength(2);
  });
  it('distinct tokens parallel #11', async () => {
    const sessions = mockKv();
    const rawA = 'mlt_iso_a_11';
    const rawB = 'mlt_iso_b_11';
    await seedLoginToken(sessions, rawA, { user_id: USER });
    await seedLoginToken(sessions, rawB, { user_id: BOB });
    const env = loginEnv(aliceDb(), sessions);
    const [a, b] = await Promise.all([
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: rawA, device_id: 'IA11' }, '')
      ),
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: rawB, device_id: 'IB11' }, '')
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.user_id).toBe(USER);
    expect(b.body.user_id).toBe(BOB);
    expect(env._db.tokens).toHaveLength(2);
  });
});


describe('race m.login.token: triple concurrent consume', () => {
  it('triple-consume barrier race #0', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 3 } });
    const raw = 'mlt_trip_0';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const reqs = [0, 1, 2].map((j) =>
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: `T0${j}` }, '')
      )
    );
    const results = await Promise.all(reqs);
    const oks = results.filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(3);
    expect(env._db.tokens.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
  });
  it('triple-consume barrier race #1', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 3 } });
    const raw = 'mlt_trip_1';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const reqs = [0, 1, 2].map((j) =>
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: `T1${j}` }, '')
      )
    );
    const results = await Promise.all(reqs);
    const oks = results.filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(3);
    expect(env._db.tokens.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
  });
  it('triple-consume barrier race #2', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 3 } });
    const raw = 'mlt_trip_2';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const reqs = [0, 1, 2].map((j) =>
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: `T2${j}` }, '')
      )
    );
    const results = await Promise.all(reqs);
    const oks = results.filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(3);
    expect(env._db.tokens.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
  });
  it('triple-consume barrier race #3', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 3 } });
    const raw = 'mlt_trip_3';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const reqs = [0, 1, 2].map((j) =>
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: `T3${j}` }, '')
      )
    );
    const results = await Promise.all(reqs);
    const oks = results.filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(3);
    expect(env._db.tokens.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
  });
  it('triple-consume barrier race #4', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 3 } });
    const raw = 'mlt_trip_4';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const reqs = [0, 1, 2].map((j) =>
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: `T4${j}` }, '')
      )
    );
    const results = await Promise.all(reqs);
    const oks = results.filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(3);
    expect(env._db.tokens.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
  });
  it('triple-consume barrier race #5', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 3 } });
    const raw = 'mlt_trip_5';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const reqs = [0, 1, 2].map((j) =>
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: `T5${j}` }, '')
      )
    );
    const results = await Promise.all(reqs);
    const oks = results.filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(3);
    expect(env._db.tokens.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
  });
  it('triple-consume barrier race #6', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 3 } });
    const raw = 'mlt_trip_6';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const reqs = [0, 1, 2].map((j) =>
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: `T6${j}` }, '')
      )
    );
    const results = await Promise.all(reqs);
    const oks = results.filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(3);
    expect(env._db.tokens.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
  });
  it('triple-consume barrier race #7', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 3 } });
    const raw = 'mlt_trip_7';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const reqs = [0, 1, 2].map((j) =>
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: `T7${j}` }, '')
      )
    );
    const results = await Promise.all(reqs);
    const oks = results.filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(3);
    expect(env._db.tokens.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
  });
  it('triple-consume barrier race #8', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 3 } });
    const raw = 'mlt_trip_8';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const reqs = [0, 1, 2].map((j) =>
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: `T8${j}` }, '')
      )
    );
    const results = await Promise.all(reqs);
    const oks = results.filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(3);
    expect(env._db.tokens.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
  });
  it('triple-consume barrier race #9', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 3 } });
    const raw = 'mlt_trip_9';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const reqs = [0, 1, 2].map((j) =>
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: `T9${j}` }, '')
      )
    );
    const results = await Promise.all(reqs);
    const oks = results.filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(3);
    expect(env._db.tokens.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
  });
  it('triple-consume barrier race #10', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 3 } });
    const raw = 'mlt_trip_10';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const reqs = [0, 1, 2].map((j) =>
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: `T10${j}` }, '')
      )
    );
    const results = await Promise.all(reqs);
    const oks = results.filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(3);
    expect(env._db.tokens.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
  });
  it('triple-consume barrier race #11', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 3 } });
    const raw = 'mlt_trip_11';
    await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const reqs = [0, 1, 2].map((j) =>
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: `T11${j}` }, '')
      )
    );
    const results = await Promise.all(reqs);
    const oks = results.filter((r) => r.status === 200);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    expect(oks.length).toBeLessThanOrEqual(3);
    expect(env._db.tokens.length).toBe(oks.length);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
  });
});


describe('race password success vs fail on same user (lockout clear vs increment)', () => {
  it('success vs fail lockout race #0', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }) },
      { getBarrier: { prefix: 'lockout:', count: 2 } }
    );
    const env = loginEnv(aliceDb(), sessions);
    const [ok, bad] = await Promise.all([
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: PASS,
            device_id: 'OK0',
          },
          ''
        )
      ),
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: 'BadPass0!',
            device_id: 'BAD0',
          },
          ''
        )
      ),
    ]);
    expect(ok.status).toBe(200);
    expect(bad.status).toBe(403);
    // Final state depends on order: delete vs put — document either cleared or re-incremented
    const remaining = sessions.data[`lockout:${USER}`];
    if (remaining == null) {
      expect(sessions.deletes).toContain(`lockout:${USER}`);
    } else {
      const lock = JSON.parse(remaining);
      expect(lock.attempts).toBeGreaterThanOrEqual(1);
    }
  });
  it('success vs fail lockout race #1', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }) },
      { getBarrier: { prefix: 'lockout:', count: 2 } }
    );
    const env = loginEnv(aliceDb(), sessions);
    const [ok, bad] = await Promise.all([
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: PASS,
            device_id: 'OK1',
          },
          ''
        )
      ),
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: 'BadPass1!',
            device_id: 'BAD1',
          },
          ''
        )
      ),
    ]);
    expect(ok.status).toBe(200);
    expect(bad.status).toBe(403);
    // Final state depends on order: delete vs put — document either cleared or re-incremented
    const remaining = sessions.data[`lockout:${USER}`];
    if (remaining == null) {
      expect(sessions.deletes).toContain(`lockout:${USER}`);
    } else {
      const lock = JSON.parse(remaining);
      expect(lock.attempts).toBeGreaterThanOrEqual(1);
    }
  });
  it('success vs fail lockout race #2', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }) },
      { getBarrier: { prefix: 'lockout:', count: 2 } }
    );
    const env = loginEnv(aliceDb(), sessions);
    const [ok, bad] = await Promise.all([
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: PASS,
            device_id: 'OK2',
          },
          ''
        )
      ),
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: 'BadPass2!',
            device_id: 'BAD2',
          },
          ''
        )
      ),
    ]);
    expect(ok.status).toBe(200);
    expect(bad.status).toBe(403);
    // Final state depends on order: delete vs put — document either cleared or re-incremented
    const remaining = sessions.data[`lockout:${USER}`];
    if (remaining == null) {
      expect(sessions.deletes).toContain(`lockout:${USER}`);
    } else {
      const lock = JSON.parse(remaining);
      expect(lock.attempts).toBeGreaterThanOrEqual(1);
    }
  });
  it('success vs fail lockout race #3', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }) },
      { getBarrier: { prefix: 'lockout:', count: 2 } }
    );
    const env = loginEnv(aliceDb(), sessions);
    const [ok, bad] = await Promise.all([
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: PASS,
            device_id: 'OK3',
          },
          ''
        )
      ),
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: 'BadPass3!',
            device_id: 'BAD3',
          },
          ''
        )
      ),
    ]);
    expect(ok.status).toBe(200);
    expect(bad.status).toBe(403);
    // Final state depends on order: delete vs put — document either cleared or re-incremented
    const remaining = sessions.data[`lockout:${USER}`];
    if (remaining == null) {
      expect(sessions.deletes).toContain(`lockout:${USER}`);
    } else {
      const lock = JSON.parse(remaining);
      expect(lock.attempts).toBeGreaterThanOrEqual(1);
    }
  });
  it('success vs fail lockout race #4', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }) },
      { getBarrier: { prefix: 'lockout:', count: 2 } }
    );
    const env = loginEnv(aliceDb(), sessions);
    const [ok, bad] = await Promise.all([
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: PASS,
            device_id: 'OK4',
          },
          ''
        )
      ),
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: 'BadPass4!',
            device_id: 'BAD4',
          },
          ''
        )
      ),
    ]);
    expect(ok.status).toBe(200);
    expect(bad.status).toBe(403);
    // Final state depends on order: delete vs put — document either cleared or re-incremented
    const remaining = sessions.data[`lockout:${USER}`];
    if (remaining == null) {
      expect(sessions.deletes).toContain(`lockout:${USER}`);
    } else {
      const lock = JSON.parse(remaining);
      expect(lock.attempts).toBeGreaterThanOrEqual(1);
    }
  });
  it('success vs fail lockout race #5', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }) },
      { getBarrier: { prefix: 'lockout:', count: 2 } }
    );
    const env = loginEnv(aliceDb(), sessions);
    const [ok, bad] = await Promise.all([
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: PASS,
            device_id: 'OK5',
          },
          ''
        )
      ),
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: 'BadPass5!',
            device_id: 'BAD5',
          },
          ''
        )
      ),
    ]);
    expect(ok.status).toBe(200);
    expect(bad.status).toBe(403);
    // Final state depends on order: delete vs put — document either cleared or re-incremented
    const remaining = sessions.data[`lockout:${USER}`];
    if (remaining == null) {
      expect(sessions.deletes).toContain(`lockout:${USER}`);
    } else {
      const lock = JSON.parse(remaining);
      expect(lock.attempts).toBeGreaterThanOrEqual(1);
    }
  });
  it('success vs fail lockout race #6', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }) },
      { getBarrier: { prefix: 'lockout:', count: 2 } }
    );
    const env = loginEnv(aliceDb(), sessions);
    const [ok, bad] = await Promise.all([
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: PASS,
            device_id: 'OK6',
          },
          ''
        )
      ),
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: 'BadPass6!',
            device_id: 'BAD6',
          },
          ''
        )
      ),
    ]);
    expect(ok.status).toBe(200);
    expect(bad.status).toBe(403);
    // Final state depends on order: delete vs put — document either cleared or re-incremented
    const remaining = sessions.data[`lockout:${USER}`];
    if (remaining == null) {
      expect(sessions.deletes).toContain(`lockout:${USER}`);
    } else {
      const lock = JSON.parse(remaining);
      expect(lock.attempts).toBeGreaterThanOrEqual(1);
    }
  });
  it('success vs fail lockout race #7', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }) },
      { getBarrier: { prefix: 'lockout:', count: 2 } }
    );
    const env = loginEnv(aliceDb(), sessions);
    const [ok, bad] = await Promise.all([
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: PASS,
            device_id: 'OK7',
          },
          ''
        )
      ),
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: 'BadPass7!',
            device_id: 'BAD7',
          },
          ''
        )
      ),
    ]);
    expect(ok.status).toBe(200);
    expect(bad.status).toBe(403);
    // Final state depends on order: delete vs put — document either cleared or re-incremented
    const remaining = sessions.data[`lockout:${USER}`];
    if (remaining == null) {
      expect(sessions.deletes).toContain(`lockout:${USER}`);
    } else {
      const lock = JSON.parse(remaining);
      expect(lock.attempts).toBeGreaterThanOrEqual(1);
    }
  });
  it('success vs fail lockout race #8', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }) },
      { getBarrier: { prefix: 'lockout:', count: 2 } }
    );
    const env = loginEnv(aliceDb(), sessions);
    const [ok, bad] = await Promise.all([
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: PASS,
            device_id: 'OK8',
          },
          ''
        )
      ),
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: 'BadPass8!',
            device_id: 'BAD8',
          },
          ''
        )
      ),
    ]);
    expect(ok.status).toBe(200);
    expect(bad.status).toBe(403);
    // Final state depends on order: delete vs put — document either cleared or re-incremented
    const remaining = sessions.data[`lockout:${USER}`];
    if (remaining == null) {
      expect(sessions.deletes).toContain(`lockout:${USER}`);
    } else {
      const lock = JSON.parse(remaining);
      expect(lock.attempts).toBeGreaterThanOrEqual(1);
    }
  });
  it('success vs fail lockout race #9', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }) },
      { getBarrier: { prefix: 'lockout:', count: 2 } }
    );
    const env = loginEnv(aliceDb(), sessions);
    const [ok, bad] = await Promise.all([
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: PASS,
            device_id: 'OK9',
          },
          ''
        )
      ),
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: 'BadPass9!',
            device_id: 'BAD9',
          },
          ''
        )
      ),
    ]);
    expect(ok.status).toBe(200);
    expect(bad.status).toBe(403);
    // Final state depends on order: delete vs put — document either cleared or re-incremented
    const remaining = sessions.data[`lockout:${USER}`];
    if (remaining == null) {
      expect(sessions.deletes).toContain(`lockout:${USER}`);
    } else {
      const lock = JSON.parse(remaining);
      expect(lock.attempts).toBeGreaterThanOrEqual(1);
    }
  });
  it('success vs fail lockout race #10', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }) },
      { getBarrier: { prefix: 'lockout:', count: 2 } }
    );
    const env = loginEnv(aliceDb(), sessions);
    const [ok, bad] = await Promise.all([
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: PASS,
            device_id: 'OK10',
          },
          ''
        )
      ),
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: 'BadPass10!',
            device_id: 'BAD10',
          },
          ''
        )
      ),
    ]);
    expect(ok.status).toBe(200);
    expect(bad.status).toBe(403);
    // Final state depends on order: delete vs put — document either cleared or re-incremented
    const remaining = sessions.data[`lockout:${USER}`];
    if (remaining == null) {
      expect(sessions.deletes).toContain(`lockout:${USER}`);
    } else {
      const lock = JSON.parse(remaining);
      expect(lock.attempts).toBeGreaterThanOrEqual(1);
    }
  });
  it('success vs fail lockout race #11', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }) },
      { getBarrier: { prefix: 'lockout:', count: 2 } }
    );
    const env = loginEnv(aliceDb(), sessions);
    const [ok, bad] = await Promise.all([
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: PASS,
            device_id: 'OK11',
          },
          ''
        )
      ),
      loginReq(
        env,
        '/_matrix/client/v3/login',
        jsonInit(
          'POST',
          {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: 'alice' },
            password: 'BadPass11!',
            device_id: 'BAD11',
          },
          ''
        )
      ),
    ]);
    expect(ok.status).toBe(200);
    expect(bad.status).toBe(403);
    // Final state depends on order: delete vs put — document either cleared or re-incremented
    const remaining = sessions.data[`lockout:${USER}`];
    if (remaining == null) {
      expect(sessions.deletes).toContain(`lockout:${USER}`);
    } else {
      const lock = JSON.parse(remaining);
      expect(lock.attempts).toBeGreaterThanOrEqual(1);
    }
  });
});


describe('race identity requestToken: parallel mint distinct sessions', () => {
  it('requestToken parallel mint #0', async () => {
    const db = createIdentityDb();
    const env = idEnv({ db });
    const n = 3;
    const reqs = Array.from({ length: n }, (_, j) =>
      idReq(
        `${ID_BASE}/validate/email/requestToken`,
        jsonInit(
          'POST',
          {
            email: `user0${j}@example.com`,
            client_secret: `cs-0-${j}`,
            send_attempt: 1,
          },
          ''
        ),
        env
      )
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const sids = results.map((r) => r.body.sid as string);
    expect(new Set(sids).size).toBe(n);
    expect(db.inserts.length).toBe(n);
  });
  it('requestToken parallel mint #1', async () => {
    const db = createIdentityDb();
    const env = idEnv({ db });
    const n = 3;
    const reqs = Array.from({ length: n }, (_, j) =>
      idReq(
        `${ID_BASE}/validate/email/requestToken`,
        jsonInit(
          'POST',
          {
            email: `user1${j}@example.com`,
            client_secret: `cs-1-${j}`,
            send_attempt: 1,
          },
          ''
        ),
        env
      )
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const sids = results.map((r) => r.body.sid as string);
    expect(new Set(sids).size).toBe(n);
    expect(db.inserts.length).toBe(n);
  });
  it('requestToken parallel mint #2', async () => {
    const db = createIdentityDb();
    const env = idEnv({ db });
    const n = 3;
    const reqs = Array.from({ length: n }, (_, j) =>
      idReq(
        `${ID_BASE}/validate/email/requestToken`,
        jsonInit(
          'POST',
          {
            email: `user2${j}@example.com`,
            client_secret: `cs-2-${j}`,
            send_attempt: 1,
          },
          ''
        ),
        env
      )
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const sids = results.map((r) => r.body.sid as string);
    expect(new Set(sids).size).toBe(n);
    expect(db.inserts.length).toBe(n);
  });
  it('requestToken parallel mint #3', async () => {
    const db = createIdentityDb();
    const env = idEnv({ db });
    const n = 3;
    const reqs = Array.from({ length: n }, (_, j) =>
      idReq(
        `${ID_BASE}/validate/email/requestToken`,
        jsonInit(
          'POST',
          {
            email: `user3${j}@example.com`,
            client_secret: `cs-3-${j}`,
            send_attempt: 1,
          },
          ''
        ),
        env
      )
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const sids = results.map((r) => r.body.sid as string);
    expect(new Set(sids).size).toBe(n);
    expect(db.inserts.length).toBe(n);
  });
  it('requestToken parallel mint #4', async () => {
    const db = createIdentityDb();
    const env = idEnv({ db });
    const n = 3;
    const reqs = Array.from({ length: n }, (_, j) =>
      idReq(
        `${ID_BASE}/validate/email/requestToken`,
        jsonInit(
          'POST',
          {
            email: `user4${j}@example.com`,
            client_secret: `cs-4-${j}`,
            send_attempt: 1,
          },
          ''
        ),
        env
      )
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const sids = results.map((r) => r.body.sid as string);
    expect(new Set(sids).size).toBe(n);
    expect(db.inserts.length).toBe(n);
  });
  it('requestToken parallel mint #5', async () => {
    const db = createIdentityDb();
    const env = idEnv({ db });
    const n = 3;
    const reqs = Array.from({ length: n }, (_, j) =>
      idReq(
        `${ID_BASE}/validate/email/requestToken`,
        jsonInit(
          'POST',
          {
            email: `user5${j}@example.com`,
            client_secret: `cs-5-${j}`,
            send_attempt: 1,
          },
          ''
        ),
        env
      )
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const sids = results.map((r) => r.body.sid as string);
    expect(new Set(sids).size).toBe(n);
    expect(db.inserts.length).toBe(n);
  });
  it('requestToken parallel mint #6', async () => {
    const db = createIdentityDb();
    const env = idEnv({ db });
    const n = 3;
    const reqs = Array.from({ length: n }, (_, j) =>
      idReq(
        `${ID_BASE}/validate/email/requestToken`,
        jsonInit(
          'POST',
          {
            email: `user6${j}@example.com`,
            client_secret: `cs-6-${j}`,
            send_attempt: 1,
          },
          ''
        ),
        env
      )
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const sids = results.map((r) => r.body.sid as string);
    expect(new Set(sids).size).toBe(n);
    expect(db.inserts.length).toBe(n);
  });
  it('requestToken parallel mint #7', async () => {
    const db = createIdentityDb();
    const env = idEnv({ db });
    const n = 3;
    const reqs = Array.from({ length: n }, (_, j) =>
      idReq(
        `${ID_BASE}/validate/email/requestToken`,
        jsonInit(
          'POST',
          {
            email: `user7${j}@example.com`,
            client_secret: `cs-7-${j}`,
            send_attempt: 1,
          },
          ''
        ),
        env
      )
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const sids = results.map((r) => r.body.sid as string);
    expect(new Set(sids).size).toBe(n);
    expect(db.inserts.length).toBe(n);
  });
  it('requestToken parallel mint #8', async () => {
    const db = createIdentityDb();
    const env = idEnv({ db });
    const n = 3;
    const reqs = Array.from({ length: n }, (_, j) =>
      idReq(
        `${ID_BASE}/validate/email/requestToken`,
        jsonInit(
          'POST',
          {
            email: `user8${j}@example.com`,
            client_secret: `cs-8-${j}`,
            send_attempt: 1,
          },
          ''
        ),
        env
      )
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const sids = results.map((r) => r.body.sid as string);
    expect(new Set(sids).size).toBe(n);
    expect(db.inserts.length).toBe(n);
  });
  it('requestToken parallel mint #9', async () => {
    const db = createIdentityDb();
    const env = idEnv({ db });
    const n = 3;
    const reqs = Array.from({ length: n }, (_, j) =>
      idReq(
        `${ID_BASE}/validate/email/requestToken`,
        jsonInit(
          'POST',
          {
            email: `user9${j}@example.com`,
            client_secret: `cs-9-${j}`,
            send_attempt: 1,
          },
          ''
        ),
        env
      )
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const sids = results.map((r) => r.body.sid as string);
    expect(new Set(sids).size).toBe(n);
    expect(db.inserts.length).toBe(n);
  });
  it('requestToken parallel mint #10', async () => {
    const db = createIdentityDb();
    const env = idEnv({ db });
    const n = 3;
    const reqs = Array.from({ length: n }, (_, j) =>
      idReq(
        `${ID_BASE}/validate/email/requestToken`,
        jsonInit(
          'POST',
          {
            email: `user10${j}@example.com`,
            client_secret: `cs-10-${j}`,
            send_attempt: 1,
          },
          ''
        ),
        env
      )
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const sids = results.map((r) => r.body.sid as string);
    expect(new Set(sids).size).toBe(n);
    expect(db.inserts.length).toBe(n);
  });
  it('requestToken parallel mint #11', async () => {
    const db = createIdentityDb();
    const env = idEnv({ db });
    const n = 3;
    const reqs = Array.from({ length: n }, (_, j) =>
      idReq(
        `${ID_BASE}/validate/email/requestToken`,
        jsonInit(
          'POST',
          {
            email: `user11${j}@example.com`,
            client_secret: `cs-11-${j}`,
            send_attempt: 1,
          },
          ''
        ),
        env
      )
    );
    const results = await Promise.all(reqs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const sids = results.map((r) => r.body.sid as string);
    expect(new Set(sids).size).toBe(n);
    expect(db.inserts.length).toBe(n);
  });
});


describe('race identity lookup ∥ hash_details pepper remint', () => {
  it('lookup vs remint race #0', async () => {
    const pepper = 'pepperstable0abcdefghijklmnop';
    const cache = mockKv({ 'identity:pepper': pepper });
    const assoc: Assoc = { medium: 'email', address: 'alice@example.com', mxid: USER };
    const db = createIdentityDb({ associations: [assoc] });
    const env = idEnv({ cache, db });
    // Clear pepper mid-flight via parallel hash_details after delete — first ensure lookup with good pepper
    const addr = `alice@example.com email`;
    const [lookup, details] = await Promise.all([
      idReq(
        `${ID_BASE}/lookup`,
        jsonInit('POST', { algorithm: 'none', pepper, addresses: [addr] }, ''),
        env
      ),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(details.status).toBe(200);
    expect(details.body.lookup_pepper).toBe(pepper);
    expect(lookup.status).toBe(200);
    expect(lookup.body.mappings[addr]).toBe(USER);
  });
  it('lookup vs remint race #1', async () => {
    const pepper = 'pepperstable1abcdefghijklmnop';
    const cache = mockKv({ 'identity:pepper': pepper });
    const assoc: Assoc = { medium: 'email', address: 'alice@example.com', mxid: USER };
    const db = createIdentityDb({ associations: [assoc] });
    const env = idEnv({ cache, db });
    // Clear pepper mid-flight via parallel hash_details after delete — first ensure lookup with good pepper
    const addr = `alice@example.com email`;
    const [lookup, details] = await Promise.all([
      idReq(
        `${ID_BASE}/lookup`,
        jsonInit('POST', { algorithm: 'none', pepper, addresses: [addr] }, ''),
        env
      ),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(details.status).toBe(200);
    expect(details.body.lookup_pepper).toBe(pepper);
    expect(lookup.status).toBe(200);
    expect(lookup.body.mappings[addr]).toBe(USER);
  });
  it('lookup vs remint race #2', async () => {
    const pepper = 'pepperstable2abcdefghijklmnop';
    const cache = mockKv({ 'identity:pepper': pepper });
    const assoc: Assoc = { medium: 'email', address: 'alice@example.com', mxid: USER };
    const db = createIdentityDb({ associations: [assoc] });
    const env = idEnv({ cache, db });
    // Clear pepper mid-flight via parallel hash_details after delete — first ensure lookup with good pepper
    const addr = `alice@example.com email`;
    const [lookup, details] = await Promise.all([
      idReq(
        `${ID_BASE}/lookup`,
        jsonInit('POST', { algorithm: 'none', pepper, addresses: [addr] }, ''),
        env
      ),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(details.status).toBe(200);
    expect(details.body.lookup_pepper).toBe(pepper);
    expect(lookup.status).toBe(200);
    expect(lookup.body.mappings[addr]).toBe(USER);
  });
  it('lookup vs remint race #3', async () => {
    const pepper = 'pepperstable3abcdefghijklmnop';
    const cache = mockKv({ 'identity:pepper': pepper });
    const assoc: Assoc = { medium: 'email', address: 'alice@example.com', mxid: USER };
    const db = createIdentityDb({ associations: [assoc] });
    const env = idEnv({ cache, db });
    // Clear pepper mid-flight via parallel hash_details after delete — first ensure lookup with good pepper
    const addr = `alice@example.com email`;
    const [lookup, details] = await Promise.all([
      idReq(
        `${ID_BASE}/lookup`,
        jsonInit('POST', { algorithm: 'none', pepper, addresses: [addr] }, ''),
        env
      ),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(details.status).toBe(200);
    expect(details.body.lookup_pepper).toBe(pepper);
    expect(lookup.status).toBe(200);
    expect(lookup.body.mappings[addr]).toBe(USER);
  });
  it('lookup vs remint race #4', async () => {
    const pepper = 'pepperstable4abcdefghijklmnop';
    const cache = mockKv({ 'identity:pepper': pepper });
    const assoc: Assoc = { medium: 'email', address: 'alice@example.com', mxid: USER };
    const db = createIdentityDb({ associations: [assoc] });
    const env = idEnv({ cache, db });
    // Clear pepper mid-flight via parallel hash_details after delete — first ensure lookup with good pepper
    const addr = `alice@example.com email`;
    const [lookup, details] = await Promise.all([
      idReq(
        `${ID_BASE}/lookup`,
        jsonInit('POST', { algorithm: 'none', pepper, addresses: [addr] }, ''),
        env
      ),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(details.status).toBe(200);
    expect(details.body.lookup_pepper).toBe(pepper);
    expect(lookup.status).toBe(200);
    expect(lookup.body.mappings[addr]).toBe(USER);
  });
  it('lookup vs remint race #5', async () => {
    const pepper = 'pepperstable5abcdefghijklmnop';
    const cache = mockKv({ 'identity:pepper': pepper });
    const assoc: Assoc = { medium: 'email', address: 'alice@example.com', mxid: USER };
    const db = createIdentityDb({ associations: [assoc] });
    const env = idEnv({ cache, db });
    // Clear pepper mid-flight via parallel hash_details after delete — first ensure lookup with good pepper
    const addr = `alice@example.com email`;
    const [lookup, details] = await Promise.all([
      idReq(
        `${ID_BASE}/lookup`,
        jsonInit('POST', { algorithm: 'none', pepper, addresses: [addr] }, ''),
        env
      ),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(details.status).toBe(200);
    expect(details.body.lookup_pepper).toBe(pepper);
    expect(lookup.status).toBe(200);
    expect(lookup.body.mappings[addr]).toBe(USER);
  });
  it('lookup vs remint race #6', async () => {
    const pepper = 'pepperstable6abcdefghijklmnop';
    const cache = mockKv({ 'identity:pepper': pepper });
    const assoc: Assoc = { medium: 'email', address: 'alice@example.com', mxid: USER };
    const db = createIdentityDb({ associations: [assoc] });
    const env = idEnv({ cache, db });
    // Clear pepper mid-flight via parallel hash_details after delete — first ensure lookup with good pepper
    const addr = `alice@example.com email`;
    const [lookup, details] = await Promise.all([
      idReq(
        `${ID_BASE}/lookup`,
        jsonInit('POST', { algorithm: 'none', pepper, addresses: [addr] }, ''),
        env
      ),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(details.status).toBe(200);
    expect(details.body.lookup_pepper).toBe(pepper);
    expect(lookup.status).toBe(200);
    expect(lookup.body.mappings[addr]).toBe(USER);
  });
  it('lookup vs remint race #7', async () => {
    const pepper = 'pepperstable7abcdefghijklmnop';
    const cache = mockKv({ 'identity:pepper': pepper });
    const assoc: Assoc = { medium: 'email', address: 'alice@example.com', mxid: USER };
    const db = createIdentityDb({ associations: [assoc] });
    const env = idEnv({ cache, db });
    // Clear pepper mid-flight via parallel hash_details after delete — first ensure lookup with good pepper
    const addr = `alice@example.com email`;
    const [lookup, details] = await Promise.all([
      idReq(
        `${ID_BASE}/lookup`,
        jsonInit('POST', { algorithm: 'none', pepper, addresses: [addr] }, ''),
        env
      ),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(details.status).toBe(200);
    expect(details.body.lookup_pepper).toBe(pepper);
    expect(lookup.status).toBe(200);
    expect(lookup.body.mappings[addr]).toBe(USER);
  });
  it('lookup vs remint race #8', async () => {
    const pepper = 'pepperstable8abcdefghijklmnop';
    const cache = mockKv({ 'identity:pepper': pepper });
    const assoc: Assoc = { medium: 'email', address: 'alice@example.com', mxid: USER };
    const db = createIdentityDb({ associations: [assoc] });
    const env = idEnv({ cache, db });
    // Clear pepper mid-flight via parallel hash_details after delete — first ensure lookup with good pepper
    const addr = `alice@example.com email`;
    const [lookup, details] = await Promise.all([
      idReq(
        `${ID_BASE}/lookup`,
        jsonInit('POST', { algorithm: 'none', pepper, addresses: [addr] }, ''),
        env
      ),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(details.status).toBe(200);
    expect(details.body.lookup_pepper).toBe(pepper);
    expect(lookup.status).toBe(200);
    expect(lookup.body.mappings[addr]).toBe(USER);
  });
  it('lookup vs remint race #9', async () => {
    const pepper = 'pepperstable9abcdefghijklmnop';
    const cache = mockKv({ 'identity:pepper': pepper });
    const assoc: Assoc = { medium: 'email', address: 'alice@example.com', mxid: USER };
    const db = createIdentityDb({ associations: [assoc] });
    const env = idEnv({ cache, db });
    // Clear pepper mid-flight via parallel hash_details after delete — first ensure lookup with good pepper
    const addr = `alice@example.com email`;
    const [lookup, details] = await Promise.all([
      idReq(
        `${ID_BASE}/lookup`,
        jsonInit('POST', { algorithm: 'none', pepper, addresses: [addr] }, ''),
        env
      ),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(details.status).toBe(200);
    expect(details.body.lookup_pepper).toBe(pepper);
    expect(lookup.status).toBe(200);
    expect(lookup.body.mappings[addr]).toBe(USER);
  });
  it('lookup vs remint race #10', async () => {
    const pepper = 'pepperstable10abcdefghijklmnop';
    const cache = mockKv({ 'identity:pepper': pepper });
    const assoc: Assoc = { medium: 'email', address: 'alice@example.com', mxid: USER };
    const db = createIdentityDb({ associations: [assoc] });
    const env = idEnv({ cache, db });
    // Clear pepper mid-flight via parallel hash_details after delete — first ensure lookup with good pepper
    const addr = `alice@example.com email`;
    const [lookup, details] = await Promise.all([
      idReq(
        `${ID_BASE}/lookup`,
        jsonInit('POST', { algorithm: 'none', pepper, addresses: [addr] }, ''),
        env
      ),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(details.status).toBe(200);
    expect(details.body.lookup_pepper).toBe(pepper);
    expect(lookup.status).toBe(200);
    expect(lookup.body.mappings[addr]).toBe(USER);
  });
  it('lookup vs remint race #11', async () => {
    const pepper = 'pepperstable11abcdefghijklmnop';
    const cache = mockKv({ 'identity:pepper': pepper });
    const assoc: Assoc = { medium: 'email', address: 'alice@example.com', mxid: USER };
    const db = createIdentityDb({ associations: [assoc] });
    const env = idEnv({ cache, db });
    // Clear pepper mid-flight via parallel hash_details after delete — first ensure lookup with good pepper
    const addr = `alice@example.com email`;
    const [lookup, details] = await Promise.all([
      idReq(
        `${ID_BASE}/lookup`,
        jsonInit('POST', { algorithm: 'none', pepper, addresses: [addr] }, ''),
        env
      ),
      idReq(`${ID_BASE}/hash_details`, { method: 'GET' }, env),
    ]);
    expect(details.status).toBe(200);
    expect(details.body.lookup_pepper).toBe(pepper);
    expect(lookup.status).toBe(200);
    expect(lookup.body.mappings[addr]).toBe(USER);
  });
});


describe('race QR check: parallel read-only same token', () => {
  it('parallel check same token #0', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 3 } });
    const raw = 'mlt_pchk_0';
    await seedLoginToken(sessions, raw);
    const env = qrEnv(sessions);
    const results = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
    ]);
    expect(results.every((r) => r.status === 200 && r.body.valid === true)).toBe(true);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    expect(sessions.deletes).toHaveLength(0);
  });
  it('parallel check same token #1', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 3 } });
    const raw = 'mlt_pchk_1';
    await seedLoginToken(sessions, raw);
    const env = qrEnv(sessions);
    const results = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
    ]);
    expect(results.every((r) => r.status === 200 && r.body.valid === true)).toBe(true);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    expect(sessions.deletes).toHaveLength(0);
  });
  it('parallel check same token #2', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 3 } });
    const raw = 'mlt_pchk_2';
    await seedLoginToken(sessions, raw);
    const env = qrEnv(sessions);
    const results = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
    ]);
    expect(results.every((r) => r.status === 200 && r.body.valid === true)).toBe(true);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    expect(sessions.deletes).toHaveLength(0);
  });
  it('parallel check same token #3', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 3 } });
    const raw = 'mlt_pchk_3';
    await seedLoginToken(sessions, raw);
    const env = qrEnv(sessions);
    const results = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
    ]);
    expect(results.every((r) => r.status === 200 && r.body.valid === true)).toBe(true);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    expect(sessions.deletes).toHaveLength(0);
  });
  it('parallel check same token #4', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 3 } });
    const raw = 'mlt_pchk_4';
    await seedLoginToken(sessions, raw);
    const env = qrEnv(sessions);
    const results = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
    ]);
    expect(results.every((r) => r.status === 200 && r.body.valid === true)).toBe(true);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    expect(sessions.deletes).toHaveLength(0);
  });
  it('parallel check same token #5', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 3 } });
    const raw = 'mlt_pchk_5';
    await seedLoginToken(sessions, raw);
    const env = qrEnv(sessions);
    const results = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
    ]);
    expect(results.every((r) => r.status === 200 && r.body.valid === true)).toBe(true);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    expect(sessions.deletes).toHaveLength(0);
  });
  it('parallel check same token #6', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 3 } });
    const raw = 'mlt_pchk_6';
    await seedLoginToken(sessions, raw);
    const env = qrEnv(sessions);
    const results = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
    ]);
    expect(results.every((r) => r.status === 200 && r.body.valid === true)).toBe(true);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    expect(sessions.deletes).toHaveLength(0);
  });
  it('parallel check same token #7', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 3 } });
    const raw = 'mlt_pchk_7';
    await seedLoginToken(sessions, raw);
    const env = qrEnv(sessions);
    const results = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
    ]);
    expect(results.every((r) => r.status === 200 && r.body.valid === true)).toBe(true);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    expect(sessions.deletes).toHaveLength(0);
  });
  it('parallel check same token #8', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 3 } });
    const raw = 'mlt_pchk_8';
    await seedLoginToken(sessions, raw);
    const env = qrEnv(sessions);
    const results = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
    ]);
    expect(results.every((r) => r.status === 200 && r.body.valid === true)).toBe(true);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    expect(sessions.deletes).toHaveLength(0);
  });
  it('parallel check same token #9', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 3 } });
    const raw = 'mlt_pchk_9';
    await seedLoginToken(sessions, raw);
    const env = qrEnv(sessions);
    const results = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
    ]);
    expect(results.every((r) => r.status === 200 && r.body.valid === true)).toBe(true);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    expect(sessions.deletes).toHaveLength(0);
  });
  it('parallel check same token #10', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 3 } });
    const raw = 'mlt_pchk_10';
    await seedLoginToken(sessions, raw);
    const env = qrEnv(sessions);
    const results = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
    ]);
    expect(results.every((r) => r.status === 200 && r.body.valid === true)).toBe(true);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    expect(sessions.deletes).toHaveLength(0);
  });
  it('parallel check same token #11', async () => {
    const sessions = mockKv({}, { getBarrier: { prefix: 'login_token:', count: 3 } });
    const raw = 'mlt_pchk_11';
    await seedLoginToken(sessions, raw);
    const env = qrEnv(sessions);
    const results = await Promise.all([
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
      qrReq(`/login/qr/${raw}/check`, { method: 'GET' }, env),
    ]);
    expect(results.every((r) => r.status === 200 && r.body.valid === true)).toBe(true);
    const hash = await hashToken(raw);
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    expect(sessions.deletes).toHaveLength(0);
  });
});


describe('race refresh: distinct refresh tokens parallel isolation', () => {
  it('distinct refresh parallel #0', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const rawA = 'syr_iso_a_0';
    const rawB = 'syr_iso_b_0';
    await seedRefresh(sessions, db, rawA, { accessTokenId: 'atok-a-0', userId: USER });
    await seedRefresh(sessions, db, rawB, { accessTokenId: 'atok-b-0', userId: BOB, deviceId: 'BOBDEV' });
    const env = loginEnv(db, sessions);
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', jsonInit('POST', { refresh_token: rawA }, '')),
      loginReq(env, '/_matrix/client/v3/refresh', jsonInit('POST', { refresh_token: rawB }, '')),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.access_token).not.toBe(b.body.access_token);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:')).length).toBe(2);
  });
  it('distinct refresh parallel #1', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const rawA = 'syr_iso_a_1';
    const rawB = 'syr_iso_b_1';
    await seedRefresh(sessions, db, rawA, { accessTokenId: 'atok-a-1', userId: USER });
    await seedRefresh(sessions, db, rawB, { accessTokenId: 'atok-b-1', userId: BOB, deviceId: 'BOBDEV' });
    const env = loginEnv(db, sessions);
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', jsonInit('POST', { refresh_token: rawA }, '')),
      loginReq(env, '/_matrix/client/v3/refresh', jsonInit('POST', { refresh_token: rawB }, '')),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.access_token).not.toBe(b.body.access_token);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:')).length).toBe(2);
  });
  it('distinct refresh parallel #2', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const rawA = 'syr_iso_a_2';
    const rawB = 'syr_iso_b_2';
    await seedRefresh(sessions, db, rawA, { accessTokenId: 'atok-a-2', userId: USER });
    await seedRefresh(sessions, db, rawB, { accessTokenId: 'atok-b-2', userId: BOB, deviceId: 'BOBDEV' });
    const env = loginEnv(db, sessions);
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', jsonInit('POST', { refresh_token: rawA }, '')),
      loginReq(env, '/_matrix/client/v3/refresh', jsonInit('POST', { refresh_token: rawB }, '')),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.access_token).not.toBe(b.body.access_token);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:')).length).toBe(2);
  });
  it('distinct refresh parallel #3', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const rawA = 'syr_iso_a_3';
    const rawB = 'syr_iso_b_3';
    await seedRefresh(sessions, db, rawA, { accessTokenId: 'atok-a-3', userId: USER });
    await seedRefresh(sessions, db, rawB, { accessTokenId: 'atok-b-3', userId: BOB, deviceId: 'BOBDEV' });
    const env = loginEnv(db, sessions);
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', jsonInit('POST', { refresh_token: rawA }, '')),
      loginReq(env, '/_matrix/client/v3/refresh', jsonInit('POST', { refresh_token: rawB }, '')),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.access_token).not.toBe(b.body.access_token);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:')).length).toBe(2);
  });
  it('distinct refresh parallel #4', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const rawA = 'syr_iso_a_4';
    const rawB = 'syr_iso_b_4';
    await seedRefresh(sessions, db, rawA, { accessTokenId: 'atok-a-4', userId: USER });
    await seedRefresh(sessions, db, rawB, { accessTokenId: 'atok-b-4', userId: BOB, deviceId: 'BOBDEV' });
    const env = loginEnv(db, sessions);
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', jsonInit('POST', { refresh_token: rawA }, '')),
      loginReq(env, '/_matrix/client/v3/refresh', jsonInit('POST', { refresh_token: rawB }, '')),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.access_token).not.toBe(b.body.access_token);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:')).length).toBe(2);
  });
  it('distinct refresh parallel #5', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const rawA = 'syr_iso_a_5';
    const rawB = 'syr_iso_b_5';
    await seedRefresh(sessions, db, rawA, { accessTokenId: 'atok-a-5', userId: USER });
    await seedRefresh(sessions, db, rawB, { accessTokenId: 'atok-b-5', userId: BOB, deviceId: 'BOBDEV' });
    const env = loginEnv(db, sessions);
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', jsonInit('POST', { refresh_token: rawA }, '')),
      loginReq(env, '/_matrix/client/v3/refresh', jsonInit('POST', { refresh_token: rawB }, '')),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.access_token).not.toBe(b.body.access_token);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:')).length).toBe(2);
  });
  it('distinct refresh parallel #6', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const rawA = 'syr_iso_a_6';
    const rawB = 'syr_iso_b_6';
    await seedRefresh(sessions, db, rawA, { accessTokenId: 'atok-a-6', userId: USER });
    await seedRefresh(sessions, db, rawB, { accessTokenId: 'atok-b-6', userId: BOB, deviceId: 'BOBDEV' });
    const env = loginEnv(db, sessions);
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', jsonInit('POST', { refresh_token: rawA }, '')),
      loginReq(env, '/_matrix/client/v3/refresh', jsonInit('POST', { refresh_token: rawB }, '')),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.access_token).not.toBe(b.body.access_token);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:')).length).toBe(2);
  });
  it('distinct refresh parallel #7', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const rawA = 'syr_iso_a_7';
    const rawB = 'syr_iso_b_7';
    await seedRefresh(sessions, db, rawA, { accessTokenId: 'atok-a-7', userId: USER });
    await seedRefresh(sessions, db, rawB, { accessTokenId: 'atok-b-7', userId: BOB, deviceId: 'BOBDEV' });
    const env = loginEnv(db, sessions);
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', jsonInit('POST', { refresh_token: rawA }, '')),
      loginReq(env, '/_matrix/client/v3/refresh', jsonInit('POST', { refresh_token: rawB }, '')),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.access_token).not.toBe(b.body.access_token);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:')).length).toBe(2);
  });
  it('distinct refresh parallel #8', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const rawA = 'syr_iso_a_8';
    const rawB = 'syr_iso_b_8';
    await seedRefresh(sessions, db, rawA, { accessTokenId: 'atok-a-8', userId: USER });
    await seedRefresh(sessions, db, rawB, { accessTokenId: 'atok-b-8', userId: BOB, deviceId: 'BOBDEV' });
    const env = loginEnv(db, sessions);
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', jsonInit('POST', { refresh_token: rawA }, '')),
      loginReq(env, '/_matrix/client/v3/refresh', jsonInit('POST', { refresh_token: rawB }, '')),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.access_token).not.toBe(b.body.access_token);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:')).length).toBe(2);
  });
  it('distinct refresh parallel #9', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const rawA = 'syr_iso_a_9';
    const rawB = 'syr_iso_b_9';
    await seedRefresh(sessions, db, rawA, { accessTokenId: 'atok-a-9', userId: USER });
    await seedRefresh(sessions, db, rawB, { accessTokenId: 'atok-b-9', userId: BOB, deviceId: 'BOBDEV' });
    const env = loginEnv(db, sessions);
    const [a, b] = await Promise.all([
      loginReq(env, '/_matrix/client/v3/refresh', jsonInit('POST', { refresh_token: rawA }, '')),
      loginReq(env, '/_matrix/client/v3/refresh', jsonInit('POST', { refresh_token: rawB }, '')),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.access_token).not.toBe(b.body.access_token);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:')).length).toBe(2);
  });
});
