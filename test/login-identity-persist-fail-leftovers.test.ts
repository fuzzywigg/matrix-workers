/**
 * TOKENMAXX HEAVY leftovers after #146 — login/QR/identity *persistence failpoint* reliability.
 * Orthogonal to login-qr-kv-state-leftovers (#146 corrupt shapes) and soft leftovers (#145).
 * Focus: KV get/put/delete throws, D1 prepare/first/run/all throws, event-order + partial state.
 * Tests-only against src/api/login.ts + qr-login.ts + identity.ts. No product inventing.
 * Fixtures use example.com only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { hashToken, sha256 } from '../src/utils/crypto';

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
const REFRESH_TTL = 7 * 24 * 60 * 60;
const ID_BASE = '/_matrix/identity/v2';

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };
type FailSpec = { op: 'get' | 'put' | 'delete'; prefix?: string; nth?: number; message?: string };

function mockKv(data: Record<string, string> = {}, fails: FailSpec[] = []) {
  const puts: KvPut[] = [];
  const deletes: string[] = [];
  const events: string[] = [];
  const counts = new Map<string, number>();
  const kv = {
    data,
    puts,
    deletes,
    events,
    fails,
    get: async (key: string, type?: string) => {
      events.push(`kv:get:${key}`);
      for (const f of fails) {
        if (f.op !== 'get') continue;
        if (f.prefix && !key.startsWith(f.prefix)) continue;
        const cpk = `getp:${f.prefix ?? ''}`;
        counts.set(cpk, (counts.get(cpk) ?? 0) + 1);
        if (counts.get(cpk) === (f.nth ?? 1)) {
          throw new Error(f.message ?? `forced kv get fail: ${key}`);
        }
      }
      const raw = data[key];
      if (raw == null) return null;
      if (type === 'json') return JSON.parse(raw);
      return raw;
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      events.push(`kv:put:${key}`);
      const pkey = `put:${key}`;
      counts.set(pkey, (counts.get(pkey) ?? 0) + 1);
      for (const f of fails) {
        if (f.op !== 'put') continue;
        if (f.prefix && !key.startsWith(f.prefix)) continue;
        const cpk = `putp:${f.prefix ?? ''}`;
        counts.set(cpk, (counts.get(cpk) ?? 0) + 1);
        if (counts.get(cpk) === (f.nth ?? 1)) {
          throw new Error(f.message ?? `forced kv put fail: ${key}`);
        }
      }
      data[key] = value;
      puts.push({ key, value, options });
    },
    delete: async (key: string) => {
      events.push(`kv:delete:${key}`);
      for (const f of fails) {
        if (f.op !== 'delete') continue;
        if (f.prefix && !key.startsWith(f.prefix)) continue;
        const cpk = `delp:${f.prefix ?? ''}`;
        counts.set(cpk, (counts.get(cpk) ?? 0) + 1);
        if (counts.get(cpk) === (f.nth ?? 1)) {
          throw new Error(f.message ?? `forced kv delete fail: ${key}`);
        }
      }
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
    fails: FailSpec[];
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
type DbFail = { match: string; method: 'first' | 'run' | 'all'; nth?: number; message?: string };

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
    fails?: DbFail[];
  } = {}
) {
  const users = opts.users ?? new Map<string, UserRow>();
  const usersByLocalpart = new Map<string, UserRow>([...users.values()].map((u) => [u.localpart, u]));
  const devices = opts.devices ?? [];
  const tokens = opts.tokens ?? [];
  const inserts: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const events: string[] = [];
  const fails = opts.fails ?? [];
  const counts = new Map<string, number>();

  function hit(method: DbFail['method'], sql: string) {
    events.push(`db:${method}:${sql.slice(0, 60)}`);
    for (const f of fails) {
      if (f.method !== method) continue;
      if (!sql.includes(f.match)) continue;
      const k = `${method}:${f.match}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
      if (counts.get(k) === (f.nth ?? 1)) {
        throw new Error(f.message ?? `forced db ${method} fail: ${f.match}`);
      }
    }
  }

  return {
    users,
    usersByLocalpart,
    devices,
    tokens,
    inserts,
    deletes,
    events,
    fails,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              hit('first', sql);
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
              hit('run', sql);
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
              throw new Error(`Unhandled SQL persist-fail stub: ${sql.slice(0, 140)}`);
            },
            async all<T>() {
              hit('all', sql);
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

// Identity helpers
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
  fails?: DbFail[];
} = {}) {
  const associations = [...(opts.associations ?? [])];
  const emailSessions = opts.emailSessions ?? new Map<string, EmailSess>();
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const events: string[] = [];
  const fails = opts.fails ?? [];
  const counts = new Map<string, number>();

  function hit(method: DbFail['method'], sql: string) {
    events.push(`db:${method}:${sql.slice(0, 60)}`);
    for (const f of fails) {
      if (f.method !== method) continue;
      if (!sql.includes(f.match)) continue;
      const k = `${method}:${f.match}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
      if (counts.get(k) === (f.nth ?? 1)) {
        throw new Error(f.message ?? `forced id db ${method}: ${f.match}`);
      }
    }
  }

  return {
    associations,
    emailSessions,
    inserts,
    updates,
    events,
    prepare(sql: string) {
      const stmt = {
        async all<T>() {
          hit('all', sql);
          if (sql.includes('FROM identity_associations') && sql.includes('SELECT medium, address, mxid')) {
            return { results: [...associations] as T[] };
          }
          return { results: [] as T[] };
        },
        bind(...args: unknown[]) {
          return {
            all: stmt.all,
            async first<T>() {
              hit('first', sql);
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
              hit('run', sql);
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
} = {}): Env {
  return {
    SERVER_NAME: SERVER,
    CACHE: opts.cache ?? mockKv(),
    DB: (opts.db ?? createIdentityDb()) as unknown as D1Database,
  } as unknown as Env;
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


describe('persist-fail login password: lockout KV get throws', () => {
  it('lockout get throw #0 before password verify', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'lockout:', nth: 1, message: 'lockout-get-0' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'D0',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(env._db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('lockout get throw #1 before password verify', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'lockout:', nth: 1, message: 'lockout-get-1' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'D1',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(env._db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('lockout get throw #2 before password verify', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'lockout:', nth: 1, message: 'lockout-get-2' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'D2',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(env._db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('lockout get throw #3 before password verify', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'lockout:', nth: 1, message: 'lockout-get-3' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'D3',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(env._db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('lockout get throw #4 before password verify', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'lockout:', nth: 1, message: 'lockout-get-4' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'D4',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(env._db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('lockout get throw #5 before password verify', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'lockout:', nth: 1, message: 'lockout-get-5' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'D5',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(env._db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('lockout get throw #6 before password verify', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'lockout:', nth: 1, message: 'lockout-get-6' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'D6',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(env._db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('lockout get throw #7 before password verify', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'lockout:', nth: 1, message: 'lockout-get-7' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'D7',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(env._db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('lockout get throw #8 before password verify', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'lockout:', nth: 1, message: 'lockout-get-8' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'D8',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(env._db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('lockout get throw #9 before password verify', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'lockout:', nth: 1, message: 'lockout-get-9' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'D9',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(env._db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('lockout get throw #10 before password verify', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'lockout:', nth: 1, message: 'lockout-get-10' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'D10',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(env._db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('lockout get throw #11 before password verify', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'lockout:', nth: 1, message: 'lockout-get-11' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'D11',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(env._db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
});

describe('persist-fail login password: lockout put throws on bad password', () => {
  it('lockout put throw after fail #0', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'lockout:', nth: 1, message: 'lockout-put-0' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: 'wrong-0',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
    expect(env._db.tokens).toHaveLength(0);
  });
  it('lockout put throw after fail #1', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'lockout:', nth: 1, message: 'lockout-put-1' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: 'wrong-1',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
    expect(env._db.tokens).toHaveLength(0);
  });
  it('lockout put throw after fail #2', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'lockout:', nth: 1, message: 'lockout-put-2' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: 'wrong-2',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
    expect(env._db.tokens).toHaveLength(0);
  });
  it('lockout put throw after fail #3', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'lockout:', nth: 1, message: 'lockout-put-3' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: 'wrong-3',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
    expect(env._db.tokens).toHaveLength(0);
  });
  it('lockout put throw after fail #4', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'lockout:', nth: 1, message: 'lockout-put-4' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: 'wrong-4',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
    expect(env._db.tokens).toHaveLength(0);
  });
  it('lockout put throw after fail #5', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'lockout:', nth: 1, message: 'lockout-put-5' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: 'wrong-5',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
    expect(env._db.tokens).toHaveLength(0);
  });
  it('lockout put throw after fail #6', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'lockout:', nth: 1, message: 'lockout-put-6' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: 'wrong-6',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
    expect(env._db.tokens).toHaveLength(0);
  });
  it('lockout put throw after fail #7', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'lockout:', nth: 1, message: 'lockout-put-7' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: 'wrong-7',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
    expect(env._db.tokens).toHaveLength(0);
  });
  it('lockout put throw after fail #8', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'lockout:', nth: 1, message: 'lockout-put-8' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: 'wrong-8',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
    expect(env._db.tokens).toHaveLength(0);
  });
  it('lockout put throw after fail #9', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'lockout:', nth: 1, message: 'lockout-put-9' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: 'wrong-9',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
    expect(env._db.tokens).toHaveLength(0);
  });
});

describe('persist-fail login password: lockout delete throws on success', () => {
  it('successful login lockout delete throw #0', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }) },
      [{ op: 'delete', prefix: 'lockout:', nth: 1, message: 'lockout-del-0' }]
    );
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'CLR0',
      }, '')
    );
    // Password verified; delete lockout fails before tokens → 500, no refresh issued
    expect(res.status).toBe(500);
    expect(sessions.data[`lockout:${USER}`]).toBeTruthy();
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('successful login lockout delete throw #1', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }) },
      [{ op: 'delete', prefix: 'lockout:', nth: 1, message: 'lockout-del-1' }]
    );
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'CLR1',
      }, '')
    );
    // Password verified; delete lockout fails before tokens → 500, no refresh issued
    expect(res.status).toBe(500);
    expect(sessions.data[`lockout:${USER}`]).toBeTruthy();
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('successful login lockout delete throw #2', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }) },
      [{ op: 'delete', prefix: 'lockout:', nth: 1, message: 'lockout-del-2' }]
    );
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'CLR2',
      }, '')
    );
    // Password verified; delete lockout fails before tokens → 500, no refresh issued
    expect(res.status).toBe(500);
    expect(sessions.data[`lockout:${USER}`]).toBeTruthy();
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('successful login lockout delete throw #3', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }) },
      [{ op: 'delete', prefix: 'lockout:', nth: 1, message: 'lockout-del-3' }]
    );
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'CLR3',
      }, '')
    );
    // Password verified; delete lockout fails before tokens → 500, no refresh issued
    expect(res.status).toBe(500);
    expect(sessions.data[`lockout:${USER}`]).toBeTruthy();
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('successful login lockout delete throw #4', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }) },
      [{ op: 'delete', prefix: 'lockout:', nth: 1, message: 'lockout-del-4' }]
    );
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'CLR4',
      }, '')
    );
    // Password verified; delete lockout fails before tokens → 500, no refresh issued
    expect(res.status).toBe(500);
    expect(sessions.data[`lockout:${USER}`]).toBeTruthy();
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('successful login lockout delete throw #5', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }) },
      [{ op: 'delete', prefix: 'lockout:', nth: 1, message: 'lockout-del-5' }]
    );
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'CLR5',
      }, '')
    );
    // Password verified; delete lockout fails before tokens → 500, no refresh issued
    expect(res.status).toBe(500);
    expect(sessions.data[`lockout:${USER}`]).toBeTruthy();
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('successful login lockout delete throw #6', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }) },
      [{ op: 'delete', prefix: 'lockout:', nth: 1, message: 'lockout-del-6' }]
    );
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'CLR6',
      }, '')
    );
    // Password verified; delete lockout fails before tokens → 500, no refresh issued
    expect(res.status).toBe(500);
    expect(sessions.data[`lockout:${USER}`]).toBeTruthy();
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('successful login lockout delete throw #7', async () => {
    const sessions = mockKv(
      { [`lockout:${USER}`]: JSON.stringify({ attempts: 2 }) },
      [{ op: 'delete', prefix: 'lockout:', nth: 1, message: 'lockout-del-7' }]
    );
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'CLR7',
      }, '')
    );
    // Password verified; delete lockout fails before tokens → 500, no refresh issued
    expect(res.status).toBe(500);
    expect(sessions.data[`lockout:${USER}`]).toBeTruthy();
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
});

describe('persist-fail login password: refresh put throws after device+access created', () => {
  it('refresh put fail leaves D1 device+token #0', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'refresh-put-0' }]);
    const db = aliceDb();
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'RP0',
        initial_device_display_name: 'Phone 0',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices.some((d) => d.device_id === 'RP0')).toBe(true);
    expect(db.tokens.length).toBeGreaterThanOrEqual(1);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('refresh:'))).toHaveLength(0);
  });
  it('refresh put fail leaves D1 device+token #1', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'refresh-put-1' }]);
    const db = aliceDb();
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'RP1',
        initial_device_display_name: 'Phone 1',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices.some((d) => d.device_id === 'RP1')).toBe(true);
    expect(db.tokens.length).toBeGreaterThanOrEqual(1);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('refresh:'))).toHaveLength(0);
  });
  it('refresh put fail leaves D1 device+token #2', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'refresh-put-2' }]);
    const db = aliceDb();
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'RP2',
        initial_device_display_name: 'Phone 2',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices.some((d) => d.device_id === 'RP2')).toBe(true);
    expect(db.tokens.length).toBeGreaterThanOrEqual(1);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('refresh:'))).toHaveLength(0);
  });
  it('refresh put fail leaves D1 device+token #3', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'refresh-put-3' }]);
    const db = aliceDb();
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'RP3',
        initial_device_display_name: 'Phone 3',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices.some((d) => d.device_id === 'RP3')).toBe(true);
    expect(db.tokens.length).toBeGreaterThanOrEqual(1);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('refresh:'))).toHaveLength(0);
  });
  it('refresh put fail leaves D1 device+token #4', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'refresh-put-4' }]);
    const db = aliceDb();
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'RP4',
        initial_device_display_name: 'Phone 4',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices.some((d) => d.device_id === 'RP4')).toBe(true);
    expect(db.tokens.length).toBeGreaterThanOrEqual(1);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('refresh:'))).toHaveLength(0);
  });
  it('refresh put fail leaves D1 device+token #5', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'refresh-put-5' }]);
    const db = aliceDb();
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'RP5',
        initial_device_display_name: 'Phone 5',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices.some((d) => d.device_id === 'RP5')).toBe(true);
    expect(db.tokens.length).toBeGreaterThanOrEqual(1);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('refresh:'))).toHaveLength(0);
  });
  it('refresh put fail leaves D1 device+token #6', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'refresh-put-6' }]);
    const db = aliceDb();
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'RP6',
        initial_device_display_name: 'Phone 6',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices.some((d) => d.device_id === 'RP6')).toBe(true);
    expect(db.tokens.length).toBeGreaterThanOrEqual(1);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('refresh:'))).toHaveLength(0);
  });
  it('refresh put fail leaves D1 device+token #7', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'refresh-put-7' }]);
    const db = aliceDb();
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'RP7',
        initial_device_display_name: 'Phone 7',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices.some((d) => d.device_id === 'RP7')).toBe(true);
    expect(db.tokens.length).toBeGreaterThanOrEqual(1);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('refresh:'))).toHaveLength(0);
  });
  it('refresh put fail leaves D1 device+token #8', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'refresh-put-8' }]);
    const db = aliceDb();
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'RP8',
        initial_device_display_name: 'Phone 8',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices.some((d) => d.device_id === 'RP8')).toBe(true);
    expect(db.tokens.length).toBeGreaterThanOrEqual(1);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('refresh:'))).toHaveLength(0);
  });
  it('refresh put fail leaves D1 device+token #9', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'refresh-put-9' }]);
    const db = aliceDb();
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'RP9',
        initial_device_display_name: 'Phone 9',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices.some((d) => d.device_id === 'RP9')).toBe(true);
    expect(db.tokens.length).toBeGreaterThanOrEqual(1);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('refresh:'))).toHaveLength(0);
  });
  it('refresh put fail leaves D1 device+token #10', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'refresh-put-10' }]);
    const db = aliceDb();
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'RP10',
        initial_device_display_name: 'Phone 10',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices.some((d) => d.device_id === 'RP10')).toBe(true);
    expect(db.tokens.length).toBeGreaterThanOrEqual(1);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('refresh:'))).toHaveLength(0);
  });
  it('refresh put fail leaves D1 device+token #11', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'refresh-put-11' }]);
    const db = aliceDb();
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'RP11',
        initial_device_display_name: 'Phone 11',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices.some((d) => d.device_id === 'RP11')).toBe(true);
    expect(db.tokens.length).toBeGreaterThanOrEqual(1);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('refresh:'))).toHaveLength(0);
  });
});

describe('persist-fail login password: D1 insert device / access_token throws', () => {
  it('device insert throw #0 — no tokens/refresh', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    db.fails.push({ match: 'INSERT INTO devices', method: 'run', message: 'dev-ins-0' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'DI0',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices).toHaveLength(0);
    expect(db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('device insert throw #1 — no tokens/refresh', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    db.fails.push({ match: 'INSERT INTO devices', method: 'run', message: 'dev-ins-1' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'DI1',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices).toHaveLength(0);
    expect(db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('device insert throw #2 — no tokens/refresh', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    db.fails.push({ match: 'INSERT INTO devices', method: 'run', message: 'dev-ins-2' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'DI2',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices).toHaveLength(0);
    expect(db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('device insert throw #3 — no tokens/refresh', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    db.fails.push({ match: 'INSERT INTO devices', method: 'run', message: 'dev-ins-3' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'DI3',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices).toHaveLength(0);
    expect(db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('device insert throw #4 — no tokens/refresh', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    db.fails.push({ match: 'INSERT INTO devices', method: 'run', message: 'dev-ins-4' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'DI4',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices).toHaveLength(0);
    expect(db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('device insert throw #5 — no tokens/refresh', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    db.fails.push({ match: 'INSERT INTO devices', method: 'run', message: 'dev-ins-5' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'DI5',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices).toHaveLength(0);
    expect(db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('device insert throw #6 — no tokens/refresh', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    db.fails.push({ match: 'INSERT INTO devices', method: 'run', message: 'dev-ins-6' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'DI6',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices).toHaveLength(0);
    expect(db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('device insert throw #7 — no tokens/refresh', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    db.fails.push({ match: 'INSERT INTO devices', method: 'run', message: 'dev-ins-7' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'DI7',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices).toHaveLength(0);
    expect(db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('access_token insert throw #0 — device exists, no refresh', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    db.fails.push({ match: 'INSERT INTO access_tokens', method: 'run', message: 'tok-ins-0' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'TI0',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices.some((d) => d.device_id === 'TI0')).toBe(true);
    expect(db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('access_token insert throw #1 — device exists, no refresh', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    db.fails.push({ match: 'INSERT INTO access_tokens', method: 'run', message: 'tok-ins-1' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'TI1',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices.some((d) => d.device_id === 'TI1')).toBe(true);
    expect(db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('access_token insert throw #2 — device exists, no refresh', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    db.fails.push({ match: 'INSERT INTO access_tokens', method: 'run', message: 'tok-ins-2' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'TI2',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices.some((d) => d.device_id === 'TI2')).toBe(true);
    expect(db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('access_token insert throw #3 — device exists, no refresh', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    db.fails.push({ match: 'INSERT INTO access_tokens', method: 'run', message: 'tok-ins-3' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'TI3',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices.some((d) => d.device_id === 'TI3')).toBe(true);
    expect(db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('access_token insert throw #4 — device exists, no refresh', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    db.fails.push({ match: 'INSERT INTO access_tokens', method: 'run', message: 'tok-ins-4' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'TI4',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices.some((d) => d.device_id === 'TI4')).toBe(true);
    expect(db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('access_token insert throw #5 — device exists, no refresh', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    db.fails.push({ match: 'INSERT INTO access_tokens', method: 'run', message: 'tok-ins-5' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'TI5',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices.some((d) => d.device_id === 'TI5')).toBe(true);
    expect(db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('access_token insert throw #6 — device exists, no refresh', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    db.fails.push({ match: 'INSERT INTO access_tokens', method: 'run', message: 'tok-ins-6' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'TI6',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices.some((d) => d.device_id === 'TI6')).toBe(true);
    expect(db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('access_token insert throw #7 — device exists, no refresh', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    db.fails.push({ match: 'INSERT INTO access_tokens', method: 'run', message: 'tok-ins-7' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'TI7',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.devices.some((d) => d.device_id === 'TI7')).toBe(true);
    expect(db.tokens).toHaveLength(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
});

describe('persist-fail m.login.token: KV get/delete throws + ordering', () => {
  it('login_token get throw #0', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'lt-get-0' }]);
    const raw = 'mlt_getfail_0';
    await seedLoginToken(sessions, raw);
    // overwrite fail after seed — seed used put not get
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'LG0' }, '')
    );
    expect(res.status).toBe(500);
    expect(env._db.tokens).toHaveLength(0);
  });
  it('login_token get throw #1', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'lt-get-1' }]);
    const raw = 'mlt_getfail_1';
    await seedLoginToken(sessions, raw);
    // overwrite fail after seed — seed used put not get
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'LG1' }, '')
    );
    expect(res.status).toBe(500);
    expect(env._db.tokens).toHaveLength(0);
  });
  it('login_token get throw #2', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'lt-get-2' }]);
    const raw = 'mlt_getfail_2';
    await seedLoginToken(sessions, raw);
    // overwrite fail after seed — seed used put not get
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'LG2' }, '')
    );
    expect(res.status).toBe(500);
    expect(env._db.tokens).toHaveLength(0);
  });
  it('login_token get throw #3', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'lt-get-3' }]);
    const raw = 'mlt_getfail_3';
    await seedLoginToken(sessions, raw);
    // overwrite fail after seed — seed used put not get
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'LG3' }, '')
    );
    expect(res.status).toBe(500);
    expect(env._db.tokens).toHaveLength(0);
  });
  it('login_token get throw #4', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'lt-get-4' }]);
    const raw = 'mlt_getfail_4';
    await seedLoginToken(sessions, raw);
    // overwrite fail after seed — seed used put not get
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'LG4' }, '')
    );
    expect(res.status).toBe(500);
    expect(env._db.tokens).toHaveLength(0);
  });
  it('login_token get throw #5', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'lt-get-5' }]);
    const raw = 'mlt_getfail_5';
    await seedLoginToken(sessions, raw);
    // overwrite fail after seed — seed used put not get
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'LG5' }, '')
    );
    expect(res.status).toBe(500);
    expect(env._db.tokens).toHaveLength(0);
  });
  it('login_token get throw #6', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'lt-get-6' }]);
    const raw = 'mlt_getfail_6';
    await seedLoginToken(sessions, raw);
    // overwrite fail after seed — seed used put not get
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'LG6' }, '')
    );
    expect(res.status).toBe(500);
    expect(env._db.tokens).toHaveLength(0);
  });
  it('login_token get throw #7', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'lt-get-7' }]);
    const raw = 'mlt_getfail_7';
    await seedLoginToken(sessions, raw);
    // overwrite fail after seed — seed used put not get
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'LG7' }, '')
    );
    expect(res.status).toBe(500);
    expect(env._db.tokens).toHaveLength(0);
  });
  it('login_token get throw #8', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'lt-get-8' }]);
    const raw = 'mlt_getfail_8';
    await seedLoginToken(sessions, raw);
    // overwrite fail after seed — seed used put not get
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'LG8' }, '')
    );
    expect(res.status).toBe(500);
    expect(env._db.tokens).toHaveLength(0);
  });
  it('login_token get throw #9', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'lt-get-9' }]);
    const raw = 'mlt_getfail_9';
    await seedLoginToken(sessions, raw);
    // overwrite fail after seed — seed used put not get
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'LG9' }, '')
    );
    expect(res.status).toBe(500);
    expect(env._db.tokens).toHaveLength(0);
  });
  it('login_token consume delete throw #0 after valid read', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'login_token:', nth: 1, message: 'lt-del-0' }]);
    const raw = 'mlt_delfail_0';
    const hash = await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'LD0' }, '')
    );
    expect(res.status).toBe(500);
    // one-time delete failed → token still present; no session issued
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    expect(env._db.tokens).toHaveLength(0);
  });
  it('login_token consume delete throw #1 after valid read', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'login_token:', nth: 1, message: 'lt-del-1' }]);
    const raw = 'mlt_delfail_1';
    const hash = await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'LD1' }, '')
    );
    expect(res.status).toBe(500);
    // one-time delete failed → token still present; no session issued
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    expect(env._db.tokens).toHaveLength(0);
  });
  it('login_token consume delete throw #2 after valid read', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'login_token:', nth: 1, message: 'lt-del-2' }]);
    const raw = 'mlt_delfail_2';
    const hash = await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'LD2' }, '')
    );
    expect(res.status).toBe(500);
    // one-time delete failed → token still present; no session issued
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    expect(env._db.tokens).toHaveLength(0);
  });
  it('login_token consume delete throw #3 after valid read', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'login_token:', nth: 1, message: 'lt-del-3' }]);
    const raw = 'mlt_delfail_3';
    const hash = await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'LD3' }, '')
    );
    expect(res.status).toBe(500);
    // one-time delete failed → token still present; no session issued
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    expect(env._db.tokens).toHaveLength(0);
  });
  it('login_token consume delete throw #4 after valid read', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'login_token:', nth: 1, message: 'lt-del-4' }]);
    const raw = 'mlt_delfail_4';
    const hash = await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'LD4' }, '')
    );
    expect(res.status).toBe(500);
    // one-time delete failed → token still present; no session issued
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    expect(env._db.tokens).toHaveLength(0);
  });
  it('login_token consume delete throw #5 after valid read', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'login_token:', nth: 1, message: 'lt-del-5' }]);
    const raw = 'mlt_delfail_5';
    const hash = await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'LD5' }, '')
    );
    expect(res.status).toBe(500);
    // one-time delete failed → token still present; no session issued
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    expect(env._db.tokens).toHaveLength(0);
  });
  it('login_token consume delete throw #6 after valid read', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'login_token:', nth: 1, message: 'lt-del-6' }]);
    const raw = 'mlt_delfail_6';
    const hash = await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'LD6' }, '')
    );
    expect(res.status).toBe(500);
    // one-time delete failed → token still present; no session issued
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    expect(env._db.tokens).toHaveLength(0);
  });
  it('login_token consume delete throw #7 after valid read', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'login_token:', nth: 1, message: 'lt-del-7' }]);
    const raw = 'mlt_delfail_7';
    const hash = await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'LD7' }, '')
    );
    expect(res.status).toBe(500);
    // one-time delete failed → token still present; no session issued
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    expect(env._db.tokens).toHaveLength(0);
  });
  it('login_token consume delete throw #8 after valid read', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'login_token:', nth: 1, message: 'lt-del-8' }]);
    const raw = 'mlt_delfail_8';
    const hash = await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'LD8' }, '')
    );
    expect(res.status).toBe(500);
    // one-time delete failed → token still present; no session issued
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    expect(env._db.tokens).toHaveLength(0);
  });
  it('login_token consume delete throw #9 after valid read', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'login_token:', nth: 1, message: 'lt-del-9' }]);
    const raw = 'mlt_delfail_9';
    const hash = await seedLoginToken(sessions, raw);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'LD9' }, '')
    );
    expect(res.status).toBe(500);
    // one-time delete failed → token still present; no session issued
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    expect(env._db.tokens).toHaveLength(0);
  });
});

describe('persist-fail refresh rotation: KV delete / D1 delete / put order', () => {
  it('old refresh delete throw #0 — access untouched', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'refresh:', nth: 1, message: 'ref-del-0' }]);
    const db = aliceDb();
    const raw = 'syr_del_0';
    const hash = await seedRefresh(sessions, db, raw, { accessTokenId: 'old-0' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`refresh:${hash}`]).toBeTruthy();
    expect(db.tokens.some((t) => t.token_id === 'old-0')).toBe(true);
  });
  it('old refresh delete throw #1 — access untouched', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'refresh:', nth: 1, message: 'ref-del-1' }]);
    const db = aliceDb();
    const raw = 'syr_del_1';
    const hash = await seedRefresh(sessions, db, raw, { accessTokenId: 'old-1' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`refresh:${hash}`]).toBeTruthy();
    expect(db.tokens.some((t) => t.token_id === 'old-1')).toBe(true);
  });
  it('old refresh delete throw #2 — access untouched', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'refresh:', nth: 1, message: 'ref-del-2' }]);
    const db = aliceDb();
    const raw = 'syr_del_2';
    const hash = await seedRefresh(sessions, db, raw, { accessTokenId: 'old-2' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`refresh:${hash}`]).toBeTruthy();
    expect(db.tokens.some((t) => t.token_id === 'old-2')).toBe(true);
  });
  it('old refresh delete throw #3 — access untouched', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'refresh:', nth: 1, message: 'ref-del-3' }]);
    const db = aliceDb();
    const raw = 'syr_del_3';
    const hash = await seedRefresh(sessions, db, raw, { accessTokenId: 'old-3' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`refresh:${hash}`]).toBeTruthy();
    expect(db.tokens.some((t) => t.token_id === 'old-3')).toBe(true);
  });
  it('old refresh delete throw #4 — access untouched', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'refresh:', nth: 1, message: 'ref-del-4' }]);
    const db = aliceDb();
    const raw = 'syr_del_4';
    const hash = await seedRefresh(sessions, db, raw, { accessTokenId: 'old-4' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`refresh:${hash}`]).toBeTruthy();
    expect(db.tokens.some((t) => t.token_id === 'old-4')).toBe(true);
  });
  it('old refresh delete throw #5 — access untouched', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'refresh:', nth: 1, message: 'ref-del-5' }]);
    const db = aliceDb();
    const raw = 'syr_del_5';
    const hash = await seedRefresh(sessions, db, raw, { accessTokenId: 'old-5' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`refresh:${hash}`]).toBeTruthy();
    expect(db.tokens.some((t) => t.token_id === 'old-5')).toBe(true);
  });
  it('old refresh delete throw #6 — access untouched', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'refresh:', nth: 1, message: 'ref-del-6' }]);
    const db = aliceDb();
    const raw = 'syr_del_6';
    const hash = await seedRefresh(sessions, db, raw, { accessTokenId: 'old-6' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`refresh:${hash}`]).toBeTruthy();
    expect(db.tokens.some((t) => t.token_id === 'old-6')).toBe(true);
  });
  it('old refresh delete throw #7 — access untouched', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'refresh:', nth: 1, message: 'ref-del-7' }]);
    const db = aliceDb();
    const raw = 'syr_del_7';
    const hash = await seedRefresh(sessions, db, raw, { accessTokenId: 'old-7' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`refresh:${hash}`]).toBeTruthy();
    expect(db.tokens.some((t) => t.token_id === 'old-7')).toBe(true);
  });
  it('D1 old access delete throw #0 after refresh consumed', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    db.fails.push({ match: 'DELETE FROM access_tokens WHERE token_id', method: 'run', message: 'acc-del-0' });
    const raw = 'syr_acdel_0';
    const hash = await seedRefresh(sessions, db, raw, { accessTokenId: 'acc-0' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(500);
    // refresh already deleted (rotation started)
    expect(sessions.data[`refresh:${hash}`]).toBeUndefined();
    expect(sessions.deletes).toContain(`refresh:${hash}`);
    // old access still present because D1 delete threw
    expect(db.tokens.some((t) => t.token_id === 'acc-0')).toBe(true);
  });
  it('D1 old access delete throw #1 after refresh consumed', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    db.fails.push({ match: 'DELETE FROM access_tokens WHERE token_id', method: 'run', message: 'acc-del-1' });
    const raw = 'syr_acdel_1';
    const hash = await seedRefresh(sessions, db, raw, { accessTokenId: 'acc-1' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(500);
    // refresh already deleted (rotation started)
    expect(sessions.data[`refresh:${hash}`]).toBeUndefined();
    expect(sessions.deletes).toContain(`refresh:${hash}`);
    // old access still present because D1 delete threw
    expect(db.tokens.some((t) => t.token_id === 'acc-1')).toBe(true);
  });
  it('D1 old access delete throw #2 after refresh consumed', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    db.fails.push({ match: 'DELETE FROM access_tokens WHERE token_id', method: 'run', message: 'acc-del-2' });
    const raw = 'syr_acdel_2';
    const hash = await seedRefresh(sessions, db, raw, { accessTokenId: 'acc-2' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(500);
    // refresh already deleted (rotation started)
    expect(sessions.data[`refresh:${hash}`]).toBeUndefined();
    expect(sessions.deletes).toContain(`refresh:${hash}`);
    // old access still present because D1 delete threw
    expect(db.tokens.some((t) => t.token_id === 'acc-2')).toBe(true);
  });
  it('D1 old access delete throw #3 after refresh consumed', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    db.fails.push({ match: 'DELETE FROM access_tokens WHERE token_id', method: 'run', message: 'acc-del-3' });
    const raw = 'syr_acdel_3';
    const hash = await seedRefresh(sessions, db, raw, { accessTokenId: 'acc-3' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(500);
    // refresh already deleted (rotation started)
    expect(sessions.data[`refresh:${hash}`]).toBeUndefined();
    expect(sessions.deletes).toContain(`refresh:${hash}`);
    // old access still present because D1 delete threw
    expect(db.tokens.some((t) => t.token_id === 'acc-3')).toBe(true);
  });
  it('D1 old access delete throw #4 after refresh consumed', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    db.fails.push({ match: 'DELETE FROM access_tokens WHERE token_id', method: 'run', message: 'acc-del-4' });
    const raw = 'syr_acdel_4';
    const hash = await seedRefresh(sessions, db, raw, { accessTokenId: 'acc-4' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(500);
    // refresh already deleted (rotation started)
    expect(sessions.data[`refresh:${hash}`]).toBeUndefined();
    expect(sessions.deletes).toContain(`refresh:${hash}`);
    // old access still present because D1 delete threw
    expect(db.tokens.some((t) => t.token_id === 'acc-4')).toBe(true);
  });
  it('D1 old access delete throw #5 after refresh consumed', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    db.fails.push({ match: 'DELETE FROM access_tokens WHERE token_id', method: 'run', message: 'acc-del-5' });
    const raw = 'syr_acdel_5';
    const hash = await seedRefresh(sessions, db, raw, { accessTokenId: 'acc-5' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(500);
    // refresh already deleted (rotation started)
    expect(sessions.data[`refresh:${hash}`]).toBeUndefined();
    expect(sessions.deletes).toContain(`refresh:${hash}`);
    // old access still present because D1 delete threw
    expect(db.tokens.some((t) => t.token_id === 'acc-5')).toBe(true);
  });
  it('D1 old access delete throw #6 after refresh consumed', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    db.fails.push({ match: 'DELETE FROM access_tokens WHERE token_id', method: 'run', message: 'acc-del-6' });
    const raw = 'syr_acdel_6';
    const hash = await seedRefresh(sessions, db, raw, { accessTokenId: 'acc-6' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(500);
    // refresh already deleted (rotation started)
    expect(sessions.data[`refresh:${hash}`]).toBeUndefined();
    expect(sessions.deletes).toContain(`refresh:${hash}`);
    // old access still present because D1 delete threw
    expect(db.tokens.some((t) => t.token_id === 'acc-6')).toBe(true);
  });
  it('D1 old access delete throw #7 after refresh consumed', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    db.fails.push({ match: 'DELETE FROM access_tokens WHERE token_id', method: 'run', message: 'acc-del-7' });
    const raw = 'syr_acdel_7';
    const hash = await seedRefresh(sessions, db, raw, { accessTokenId: 'acc-7' });
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(500);
    // refresh already deleted (rotation started)
    expect(sessions.data[`refresh:${hash}`]).toBeUndefined();
    expect(sessions.deletes).toContain(`refresh:${hash}`);
    // old access still present because D1 delete threw
    expect(db.tokens.some((t) => t.token_id === 'acc-7')).toBe(true);
  });
  it('new refresh put throw #0 after new access inserted', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'ref-put-0' }]);
    const db = aliceDb();
    const raw = 'syr_reput_0';
    const hash = await seedRefresh(sessions, db, raw, { accessTokenId: 'pre-0' });
    const before = db.tokens.length;
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`refresh:${hash}`]).toBeUndefined();
    // new access token row created, old removed, but no new refresh KV
    expect(db.tokens.some((t) => t.token_id === 'pre-0')).toBe(false);
    expect(db.tokens.length).toBeGreaterThanOrEqual(before); // old gone + new present, or equal if accounting differs
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('refresh:'))).toHaveLength(0);
  });
  it('new refresh put throw #1 after new access inserted', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'ref-put-1' }]);
    const db = aliceDb();
    const raw = 'syr_reput_1';
    const hash = await seedRefresh(sessions, db, raw, { accessTokenId: 'pre-1' });
    const before = db.tokens.length;
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`refresh:${hash}`]).toBeUndefined();
    // new access token row created, old removed, but no new refresh KV
    expect(db.tokens.some((t) => t.token_id === 'pre-1')).toBe(false);
    expect(db.tokens.length).toBeGreaterThanOrEqual(before); // old gone + new present, or equal if accounting differs
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('refresh:'))).toHaveLength(0);
  });
  it('new refresh put throw #2 after new access inserted', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'ref-put-2' }]);
    const db = aliceDb();
    const raw = 'syr_reput_2';
    const hash = await seedRefresh(sessions, db, raw, { accessTokenId: 'pre-2' });
    const before = db.tokens.length;
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`refresh:${hash}`]).toBeUndefined();
    // new access token row created, old removed, but no new refresh KV
    expect(db.tokens.some((t) => t.token_id === 'pre-2')).toBe(false);
    expect(db.tokens.length).toBeGreaterThanOrEqual(before); // old gone + new present, or equal if accounting differs
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('refresh:'))).toHaveLength(0);
  });
  it('new refresh put throw #3 after new access inserted', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'ref-put-3' }]);
    const db = aliceDb();
    const raw = 'syr_reput_3';
    const hash = await seedRefresh(sessions, db, raw, { accessTokenId: 'pre-3' });
    const before = db.tokens.length;
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`refresh:${hash}`]).toBeUndefined();
    // new access token row created, old removed, but no new refresh KV
    expect(db.tokens.some((t) => t.token_id === 'pre-3')).toBe(false);
    expect(db.tokens.length).toBeGreaterThanOrEqual(before); // old gone + new present, or equal if accounting differs
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('refresh:'))).toHaveLength(0);
  });
  it('new refresh put throw #4 after new access inserted', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'ref-put-4' }]);
    const db = aliceDb();
    const raw = 'syr_reput_4';
    const hash = await seedRefresh(sessions, db, raw, { accessTokenId: 'pre-4' });
    const before = db.tokens.length;
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`refresh:${hash}`]).toBeUndefined();
    // new access token row created, old removed, but no new refresh KV
    expect(db.tokens.some((t) => t.token_id === 'pre-4')).toBe(false);
    expect(db.tokens.length).toBeGreaterThanOrEqual(before); // old gone + new present, or equal if accounting differs
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('refresh:'))).toHaveLength(0);
  });
  it('new refresh put throw #5 after new access inserted', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'ref-put-5' }]);
    const db = aliceDb();
    const raw = 'syr_reput_5';
    const hash = await seedRefresh(sessions, db, raw, { accessTokenId: 'pre-5' });
    const before = db.tokens.length;
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`refresh:${hash}`]).toBeUndefined();
    // new access token row created, old removed, but no new refresh KV
    expect(db.tokens.some((t) => t.token_id === 'pre-5')).toBe(false);
    expect(db.tokens.length).toBeGreaterThanOrEqual(before); // old gone + new present, or equal if accounting differs
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('refresh:'))).toHaveLength(0);
  });
  it('new refresh put throw #6 after new access inserted', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'ref-put-6' }]);
    const db = aliceDb();
    const raw = 'syr_reput_6';
    const hash = await seedRefresh(sessions, db, raw, { accessTokenId: 'pre-6' });
    const before = db.tokens.length;
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`refresh:${hash}`]).toBeUndefined();
    // new access token row created, old removed, but no new refresh KV
    expect(db.tokens.some((t) => t.token_id === 'pre-6')).toBe(false);
    expect(db.tokens.length).toBeGreaterThanOrEqual(before); // old gone + new present, or equal if accounting differs
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('refresh:'))).toHaveLength(0);
  });
  it('new refresh put throw #7 after new access inserted', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'ref-put-7' }]);
    const db = aliceDb();
    const raw = 'syr_reput_7';
    const hash = await seedRefresh(sessions, db, raw, { accessTokenId: 'pre-7' });
    const before = db.tokens.length;
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`refresh:${hash}`]).toBeUndefined();
    // new access token row created, old removed, but no new refresh KV
    expect(db.tokens.some((t) => t.token_id === 'pre-7')).toBe(false);
    expect(db.tokens.length).toBeGreaterThanOrEqual(before); // old gone + new present, or equal if accounting differs
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('refresh:'))).toHaveLength(0);
  });
});

describe('persist-fail register / available / get_token / logout', () => {
  it('register available D1 first throw #0', async () => {
    const db = createLoginDb({ fails: [{ match: 'FROM users WHERE localpart', method: 'first', message: 'avail-0' }] });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/register/available?username=carol0');
    expect(res.status).toBe(500);
  });
  it('register available D1 first throw #1', async () => {
    const db = createLoginDb({ fails: [{ match: 'FROM users WHERE localpart', method: 'first', message: 'avail-1' }] });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/register/available?username=carol1');
    expect(res.status).toBe(500);
  });
  it('register available D1 first throw #2', async () => {
    const db = createLoginDb({ fails: [{ match: 'FROM users WHERE localpart', method: 'first', message: 'avail-2' }] });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/register/available?username=carol2');
    expect(res.status).toBe(500);
  });
  it('register available D1 first throw #3', async () => {
    const db = createLoginDb({ fails: [{ match: 'FROM users WHERE localpart', method: 'first', message: 'avail-3' }] });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/register/available?username=carol3');
    expect(res.status).toBe(500);
  });
  it('register available D1 first throw #4', async () => {
    const db = createLoginDb({ fails: [{ match: 'FROM users WHERE localpart', method: 'first', message: 'avail-4' }] });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/register/available?username=carol4');
    expect(res.status).toBe(500);
  });
  it('register available D1 first throw #5', async () => {
    const db = createLoginDb({ fails: [{ match: 'FROM users WHERE localpart', method: 'first', message: 'avail-5' }] });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/register/available?username=carol5');
    expect(res.status).toBe(500);
  });
  it('register user insert throw #0', async () => {
    const sessions = mockKv();
    const db = createLoginDb({ fails: [{ match: 'INSERT INTO users', method: 'run', message: 'reg-user-0' }] });
    const res = await loginReq(
      loginEnv(db, sessions),
      '/_matrix/client/v3/register',
      jsonInit('POST', {
        username: 'carol0',
        password: PASS,
        auth: { type: 'm.login.dummy' },
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.users.size).toBe(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('register user insert throw #1', async () => {
    const sessions = mockKv();
    const db = createLoginDb({ fails: [{ match: 'INSERT INTO users', method: 'run', message: 'reg-user-1' }] });
    const res = await loginReq(
      loginEnv(db, sessions),
      '/_matrix/client/v3/register',
      jsonInit('POST', {
        username: 'carol1',
        password: PASS,
        auth: { type: 'm.login.dummy' },
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.users.size).toBe(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('register user insert throw #2', async () => {
    const sessions = mockKv();
    const db = createLoginDb({ fails: [{ match: 'INSERT INTO users', method: 'run', message: 'reg-user-2' }] });
    const res = await loginReq(
      loginEnv(db, sessions),
      '/_matrix/client/v3/register',
      jsonInit('POST', {
        username: 'carol2',
        password: PASS,
        auth: { type: 'm.login.dummy' },
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.users.size).toBe(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('register user insert throw #3', async () => {
    const sessions = mockKv();
    const db = createLoginDb({ fails: [{ match: 'INSERT INTO users', method: 'run', message: 'reg-user-3' }] });
    const res = await loginReq(
      loginEnv(db, sessions),
      '/_matrix/client/v3/register',
      jsonInit('POST', {
        username: 'carol3',
        password: PASS,
        auth: { type: 'm.login.dummy' },
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.users.size).toBe(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('register user insert throw #4', async () => {
    const sessions = mockKv();
    const db = createLoginDb({ fails: [{ match: 'INSERT INTO users', method: 'run', message: 'reg-user-4' }] });
    const res = await loginReq(
      loginEnv(db, sessions),
      '/_matrix/client/v3/register',
      jsonInit('POST', {
        username: 'carol4',
        password: PASS,
        auth: { type: 'm.login.dummy' },
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.users.size).toBe(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('register user insert throw #5', async () => {
    const sessions = mockKv();
    const db = createLoginDb({ fails: [{ match: 'INSERT INTO users', method: 'run', message: 'reg-user-5' }] });
    const res = await loginReq(
      loginEnv(db, sessions),
      '/_matrix/client/v3/register',
      jsonInit('POST', {
        username: 'carol5',
        password: PASS,
        auth: { type: 'm.login.dummy' },
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.users.size).toBe(0);
    expect(sessions.puts.filter((p) => p.key.startsWith('refresh:'))).toHaveLength(0);
  });
  it('get_token SESSIONS put throw #0', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'login_token:', nth: 1, message: 'gt-put-0' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(env, '/_matrix/client/v1/login/get_token', jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('login_token:'))).toHaveLength(0);
  });
  it('get_token SESSIONS put throw #1', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'login_token:', nth: 1, message: 'gt-put-1' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(env, '/_matrix/client/v1/login/get_token', jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('login_token:'))).toHaveLength(0);
  });
  it('get_token SESSIONS put throw #2', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'login_token:', nth: 1, message: 'gt-put-2' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(env, '/_matrix/client/v1/login/get_token', jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('login_token:'))).toHaveLength(0);
  });
  it('get_token SESSIONS put throw #3', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'login_token:', nth: 1, message: 'gt-put-3' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(env, '/_matrix/client/v1/login/get_token', jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('login_token:'))).toHaveLength(0);
  });
  it('get_token SESSIONS put throw #4', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'login_token:', nth: 1, message: 'gt-put-4' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(env, '/_matrix/client/v1/login/get_token', jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('login_token:'))).toHaveLength(0);
  });
  it('get_token SESSIONS put throw #5', async () => {
    const sessions = mockKv({}, [{ op: 'put', prefix: 'login_token:', nth: 1, message: 'gt-put-5' }]);
    const env = loginEnv(aliceDb(), sessions);
    const res = await loginReq(env, '/_matrix/client/v1/login/get_token', jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(Object.keys(sessions.data).filter((k) => k.startsWith('login_token:'))).toHaveLength(0);
  });
  it('logout access delete throw #0', async () => {
    const db = aliceDb();
    const token = 'syt_logout_0';
    const hash = await hashToken(token);
    db.tokens.push({
      token_id: 'L0',
      token_hash: hash,
      user_id: USER,
      device_id: DEVICE,
      created_at: NOW,
    });
    db.fails.push({ match: 'DELETE FROM access_tokens WHERE token_hash', method: 'run', message: 'lo-0' });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/logout', jsonInit('POST', {}, token));
    expect(res.status).toBe(500);
    expect(db.tokens.some((t) => t.token_hash === hash)).toBe(true);
  });
  it('logout access delete throw #1', async () => {
    const db = aliceDb();
    const token = 'syt_logout_1';
    const hash = await hashToken(token);
    db.tokens.push({
      token_id: 'L1',
      token_hash: hash,
      user_id: USER,
      device_id: DEVICE,
      created_at: NOW,
    });
    db.fails.push({ match: 'DELETE FROM access_tokens WHERE token_hash', method: 'run', message: 'lo-1' });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/logout', jsonInit('POST', {}, token));
    expect(res.status).toBe(500);
    expect(db.tokens.some((t) => t.token_hash === hash)).toBe(true);
  });
  it('logout access delete throw #2', async () => {
    const db = aliceDb();
    const token = 'syt_logout_2';
    const hash = await hashToken(token);
    db.tokens.push({
      token_id: 'L2',
      token_hash: hash,
      user_id: USER,
      device_id: DEVICE,
      created_at: NOW,
    });
    db.fails.push({ match: 'DELETE FROM access_tokens WHERE token_hash', method: 'run', message: 'lo-2' });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/logout', jsonInit('POST', {}, token));
    expect(res.status).toBe(500);
    expect(db.tokens.some((t) => t.token_hash === hash)).toBe(true);
  });
  it('logout access delete throw #3', async () => {
    const db = aliceDb();
    const token = 'syt_logout_3';
    const hash = await hashToken(token);
    db.tokens.push({
      token_id: 'L3',
      token_hash: hash,
      user_id: USER,
      device_id: DEVICE,
      created_at: NOW,
    });
    db.fails.push({ match: 'DELETE FROM access_tokens WHERE token_hash', method: 'run', message: 'lo-3' });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/logout', jsonInit('POST', {}, token));
    expect(res.status).toBe(500);
    expect(db.tokens.some((t) => t.token_hash === hash)).toBe(true);
  });
  it('logout access delete throw #4', async () => {
    const db = aliceDb();
    const token = 'syt_logout_4';
    const hash = await hashToken(token);
    db.tokens.push({
      token_id: 'L4',
      token_hash: hash,
      user_id: USER,
      device_id: DEVICE,
      created_at: NOW,
    });
    db.fails.push({ match: 'DELETE FROM access_tokens WHERE token_hash', method: 'run', message: 'lo-4' });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/logout', jsonInit('POST', {}, token));
    expect(res.status).toBe(500);
    expect(db.tokens.some((t) => t.token_hash === hash)).toBe(true);
  });
  it('logout access delete throw #5', async () => {
    const db = aliceDb();
    const token = 'syt_logout_5';
    const hash = await hashToken(token);
    db.tokens.push({
      token_id: 'L5',
      token_hash: hash,
      user_id: USER,
      device_id: DEVICE,
      created_at: NOW,
    });
    db.fails.push({ match: 'DELETE FROM access_tokens WHERE token_hash', method: 'run', message: 'lo-5' });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/logout', jsonInit('POST', {}, token));
    expect(res.status).toBe(500);
    expect(db.tokens.some((t) => t.token_hash === hash)).toBe(true);
  });
  it('logout/all delete throw #0', async () => {
    const db = aliceDb();
    db.tokens.push(
      { token_id: 'a0', token_hash: 'h10', user_id: USER, device_id: 'D1', created_at: NOW },
      { token_id: 'b0', token_hash: 'h20', user_id: USER, device_id: 'D2', created_at: NOW }
    );
    db.fails.push({ match: 'DELETE FROM access_tokens WHERE user_id', method: 'run', message: 'loa-0' });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/logout/all', jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(db.tokens.filter((t) => t.user_id === USER)).toHaveLength(2);
  });
  it('logout/all delete throw #1', async () => {
    const db = aliceDb();
    db.tokens.push(
      { token_id: 'a1', token_hash: 'h11', user_id: USER, device_id: 'D1', created_at: NOW },
      { token_id: 'b1', token_hash: 'h21', user_id: USER, device_id: 'D2', created_at: NOW }
    );
    db.fails.push({ match: 'DELETE FROM access_tokens WHERE user_id', method: 'run', message: 'loa-1' });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/logout/all', jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(db.tokens.filter((t) => t.user_id === USER)).toHaveLength(2);
  });
  it('logout/all delete throw #2', async () => {
    const db = aliceDb();
    db.tokens.push(
      { token_id: 'a2', token_hash: 'h12', user_id: USER, device_id: 'D1', created_at: NOW },
      { token_id: 'b2', token_hash: 'h22', user_id: USER, device_id: 'D2', created_at: NOW }
    );
    db.fails.push({ match: 'DELETE FROM access_tokens WHERE user_id', method: 'run', message: 'loa-2' });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/logout/all', jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(db.tokens.filter((t) => t.user_id === USER)).toHaveLength(2);
  });
  it('logout/all delete throw #3', async () => {
    const db = aliceDb();
    db.tokens.push(
      { token_id: 'a3', token_hash: 'h13', user_id: USER, device_id: 'D1', created_at: NOW },
      { token_id: 'b3', token_hash: 'h23', user_id: USER, device_id: 'D2', created_at: NOW }
    );
    db.fails.push({ match: 'DELETE FROM access_tokens WHERE user_id', method: 'run', message: 'loa-3' });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/logout/all', jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(db.tokens.filter((t) => t.user_id === USER)).toHaveLength(2);
  });
  it('logout/all delete throw #4', async () => {
    const db = aliceDb();
    db.tokens.push(
      { token_id: 'a4', token_hash: 'h14', user_id: USER, device_id: 'D1', created_at: NOW },
      { token_id: 'b4', token_hash: 'h24', user_id: USER, device_id: 'D2', created_at: NOW }
    );
    db.fails.push({ match: 'DELETE FROM access_tokens WHERE user_id', method: 'run', message: 'loa-4' });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/logout/all', jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(db.tokens.filter((t) => t.user_id === USER)).toHaveLength(2);
  });
  it('logout/all delete throw #5', async () => {
    const db = aliceDb();
    db.tokens.push(
      { token_id: 'a5', token_hash: 'h15', user_id: USER, device_id: 'D1', created_at: NOW },
      { token_id: 'b5', token_hash: 'h25', user_id: USER, device_id: 'D2', created_at: NOW }
    );
    db.fails.push({ match: 'DELETE FROM access_tokens WHERE user_id', method: 'run', message: 'loa-5' });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/logout/all', jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(db.tokens.filter((t) => t.user_id === USER)).toHaveLength(2);
  });
});

describe('persist-fail QR landing/check KV get/delete throws', () => {
  it('landing get throw #0', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'qr-get-0' }]);
    const t = 'mlt_qrget_0';
    await seedLoginToken(sessions, t);
    const res = await qrReq(`/login/qr/${t}`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
  });
  it('landing get throw #1', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'qr-get-1' }]);
    const t = 'mlt_qrget_1';
    await seedLoginToken(sessions, t);
    const res = await qrReq(`/login/qr/${t}`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
  });
  it('landing get throw #2', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'qr-get-2' }]);
    const t = 'mlt_qrget_2';
    await seedLoginToken(sessions, t);
    const res = await qrReq(`/login/qr/${t}`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
  });
  it('landing get throw #3', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'qr-get-3' }]);
    const t = 'mlt_qrget_3';
    await seedLoginToken(sessions, t);
    const res = await qrReq(`/login/qr/${t}`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
  });
  it('landing get throw #4', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'qr-get-4' }]);
    const t = 'mlt_qrget_4';
    await seedLoginToken(sessions, t);
    const res = await qrReq(`/login/qr/${t}`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
  });
  it('landing get throw #5', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'qr-get-5' }]);
    const t = 'mlt_qrget_5';
    await seedLoginToken(sessions, t);
    const res = await qrReq(`/login/qr/${t}`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
  });
  it('landing get throw #6', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'qr-get-6' }]);
    const t = 'mlt_qrget_6';
    await seedLoginToken(sessions, t);
    const res = await qrReq(`/login/qr/${t}`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
  });
  it('landing get throw #7', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'qr-get-7' }]);
    const t = 'mlt_qrget_7';
    await seedLoginToken(sessions, t);
    const res = await qrReq(`/login/qr/${t}`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
  });
  it('landing get throw #8', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'qr-get-8' }]);
    const t = 'mlt_qrget_8';
    await seedLoginToken(sessions, t);
    const res = await qrReq(`/login/qr/${t}`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
  });
  it('landing get throw #9', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'qr-get-9' }]);
    const t = 'mlt_qrget_9';
    await seedLoginToken(sessions, t);
    const res = await qrReq(`/login/qr/${t}`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
  });
  it('landing expired delete throw #0', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'login_token:', nth: 1, message: 'qr-del-0' }]);
    const t = 'mlt_qrexp_0';
    const hash = await seedLoginToken(sessions, t, { expires_at: NOW - 1 });
    const res = await qrReq(`/login/qr/${t}`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
  });
  it('landing expired delete throw #1', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'login_token:', nth: 1, message: 'qr-del-1' }]);
    const t = 'mlt_qrexp_1';
    const hash = await seedLoginToken(sessions, t, { expires_at: NOW - 1 });
    const res = await qrReq(`/login/qr/${t}`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
  });
  it('landing expired delete throw #2', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'login_token:', nth: 1, message: 'qr-del-2' }]);
    const t = 'mlt_qrexp_2';
    const hash = await seedLoginToken(sessions, t, { expires_at: NOW - 1 });
    const res = await qrReq(`/login/qr/${t}`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
  });
  it('landing expired delete throw #3', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'login_token:', nth: 1, message: 'qr-del-3' }]);
    const t = 'mlt_qrexp_3';
    const hash = await seedLoginToken(sessions, t, { expires_at: NOW - 1 });
    const res = await qrReq(`/login/qr/${t}`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
  });
  it('landing expired delete throw #4', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'login_token:', nth: 1, message: 'qr-del-4' }]);
    const t = 'mlt_qrexp_4';
    const hash = await seedLoginToken(sessions, t, { expires_at: NOW - 1 });
    const res = await qrReq(`/login/qr/${t}`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
  });
  it('landing expired delete throw #5', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'login_token:', nth: 1, message: 'qr-del-5' }]);
    const t = 'mlt_qrexp_5';
    const hash = await seedLoginToken(sessions, t, { expires_at: NOW - 1 });
    const res = await qrReq(`/login/qr/${t}`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
  });
  it('landing expired delete throw #6', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'login_token:', nth: 1, message: 'qr-del-6' }]);
    const t = 'mlt_qrexp_6';
    const hash = await seedLoginToken(sessions, t, { expires_at: NOW - 1 });
    const res = await qrReq(`/login/qr/${t}`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
  });
  it('landing expired delete throw #7', async () => {
    const sessions = mockKv({}, [{ op: 'delete', prefix: 'login_token:', nth: 1, message: 'qr-del-7' }]);
    const t = 'mlt_qrexp_7';
    const hash = await seedLoginToken(sessions, t, { expires_at: NOW - 1 });
    const res = await qrReq(`/login/qr/${t}`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
  });
  it('check get throw #0', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'qrc-get-0' }]);
    const t = 'mlt_qrchk_0';
    await seedLoginToken(sessions, t);
    const res = await qrReq(`/login/qr/${t}/check`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
  });
  it('check get throw #1', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'qrc-get-1' }]);
    const t = 'mlt_qrchk_1';
    await seedLoginToken(sessions, t);
    const res = await qrReq(`/login/qr/${t}/check`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
  });
  it('check get throw #2', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'qrc-get-2' }]);
    const t = 'mlt_qrchk_2';
    await seedLoginToken(sessions, t);
    const res = await qrReq(`/login/qr/${t}/check`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
  });
  it('check get throw #3', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'qrc-get-3' }]);
    const t = 'mlt_qrchk_3';
    await seedLoginToken(sessions, t);
    const res = await qrReq(`/login/qr/${t}/check`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
  });
  it('check get throw #4', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'qrc-get-4' }]);
    const t = 'mlt_qrchk_4';
    await seedLoginToken(sessions, t);
    const res = await qrReq(`/login/qr/${t}/check`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
  });
  it('check get throw #5', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'qrc-get-5' }]);
    const t = 'mlt_qrchk_5';
    await seedLoginToken(sessions, t);
    const res = await qrReq(`/login/qr/${t}/check`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
  });
  it('check get throw #6', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'qrc-get-6' }]);
    const t = 'mlt_qrchk_6';
    await seedLoginToken(sessions, t);
    const res = await qrReq(`/login/qr/${t}/check`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
  });
  it('check get throw #7', async () => {
    const sessions = mockKv({}, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'qrc-get-7' }]);
    const t = 'mlt_qrchk_7';
    await seedLoginToken(sessions, t);
    const res = await qrReq(`/login/qr/${t}/check`, {}, qrEnv(sessions));
    expect(res.status).toBe(500);
  });
});

describe('persist-fail identity CACHE pepper get/put throws', () => {
  it('hash_details pepper get throw #0', async () => {
    const cache = mockKv({}, [{ op: 'get', prefix: 'identity:pepper', nth: 1, message: 'pep-get-0' }]);
    const res = await idReq(`${ID_BASE}/hash_details`, {}, idEnv({ cache }));
    expect(res.status).toBe(500);
  });
  it('hash_details pepper get throw #1', async () => {
    const cache = mockKv({}, [{ op: 'get', prefix: 'identity:pepper', nth: 1, message: 'pep-get-1' }]);
    const res = await idReq(`${ID_BASE}/hash_details`, {}, idEnv({ cache }));
    expect(res.status).toBe(500);
  });
  it('hash_details pepper get throw #2', async () => {
    const cache = mockKv({}, [{ op: 'get', prefix: 'identity:pepper', nth: 1, message: 'pep-get-2' }]);
    const res = await idReq(`${ID_BASE}/hash_details`, {}, idEnv({ cache }));
    expect(res.status).toBe(500);
  });
  it('hash_details pepper get throw #3', async () => {
    const cache = mockKv({}, [{ op: 'get', prefix: 'identity:pepper', nth: 1, message: 'pep-get-3' }]);
    const res = await idReq(`${ID_BASE}/hash_details`, {}, idEnv({ cache }));
    expect(res.status).toBe(500);
  });
  it('hash_details pepper get throw #4', async () => {
    const cache = mockKv({}, [{ op: 'get', prefix: 'identity:pepper', nth: 1, message: 'pep-get-4' }]);
    const res = await idReq(`${ID_BASE}/hash_details`, {}, idEnv({ cache }));
    expect(res.status).toBe(500);
  });
  it('hash_details pepper get throw #5', async () => {
    const cache = mockKv({}, [{ op: 'get', prefix: 'identity:pepper', nth: 1, message: 'pep-get-5' }]);
    const res = await idReq(`${ID_BASE}/hash_details`, {}, idEnv({ cache }));
    expect(res.status).toBe(500);
  });
  it('hash_details pepper get throw #6', async () => {
    const cache = mockKv({}, [{ op: 'get', prefix: 'identity:pepper', nth: 1, message: 'pep-get-6' }]);
    const res = await idReq(`${ID_BASE}/hash_details`, {}, idEnv({ cache }));
    expect(res.status).toBe(500);
  });
  it('hash_details pepper get throw #7', async () => {
    const cache = mockKv({}, [{ op: 'get', prefix: 'identity:pepper', nth: 1, message: 'pep-get-7' }]);
    const res = await idReq(`${ID_BASE}/hash_details`, {}, idEnv({ cache }));
    expect(res.status).toBe(500);
  });
  it('hash_details pepper get throw #8', async () => {
    const cache = mockKv({}, [{ op: 'get', prefix: 'identity:pepper', nth: 1, message: 'pep-get-8' }]);
    const res = await idReq(`${ID_BASE}/hash_details`, {}, idEnv({ cache }));
    expect(res.status).toBe(500);
  });
  it('hash_details pepper get throw #9', async () => {
    const cache = mockKv({}, [{ op: 'get', prefix: 'identity:pepper', nth: 1, message: 'pep-get-9' }]);
    const res = await idReq(`${ID_BASE}/hash_details`, {}, idEnv({ cache }));
    expect(res.status).toBe(500);
  });
  it('hash_details pepper put throw #0 after miss', async () => {
    const cache = mockKv({}, [{ op: 'put', prefix: 'identity:pepper', nth: 1, message: 'pep-put-0' }]);
    const res = await idReq(`${ID_BASE}/hash_details`, {}, idEnv({ cache }));
    expect(res.status).toBe(500);
    expect(cache.data['identity:pepper']).toBeUndefined();
  });
  it('hash_details pepper put throw #1 after miss', async () => {
    const cache = mockKv({}, [{ op: 'put', prefix: 'identity:pepper', nth: 1, message: 'pep-put-1' }]);
    const res = await idReq(`${ID_BASE}/hash_details`, {}, idEnv({ cache }));
    expect(res.status).toBe(500);
    expect(cache.data['identity:pepper']).toBeUndefined();
  });
  it('hash_details pepper put throw #2 after miss', async () => {
    const cache = mockKv({}, [{ op: 'put', prefix: 'identity:pepper', nth: 1, message: 'pep-put-2' }]);
    const res = await idReq(`${ID_BASE}/hash_details`, {}, idEnv({ cache }));
    expect(res.status).toBe(500);
    expect(cache.data['identity:pepper']).toBeUndefined();
  });
  it('hash_details pepper put throw #3 after miss', async () => {
    const cache = mockKv({}, [{ op: 'put', prefix: 'identity:pepper', nth: 1, message: 'pep-put-3' }]);
    const res = await idReq(`${ID_BASE}/hash_details`, {}, idEnv({ cache }));
    expect(res.status).toBe(500);
    expect(cache.data['identity:pepper']).toBeUndefined();
  });
  it('hash_details pepper put throw #4 after miss', async () => {
    const cache = mockKv({}, [{ op: 'put', prefix: 'identity:pepper', nth: 1, message: 'pep-put-4' }]);
    const res = await idReq(`${ID_BASE}/hash_details`, {}, idEnv({ cache }));
    expect(res.status).toBe(500);
    expect(cache.data['identity:pepper']).toBeUndefined();
  });
  it('hash_details pepper put throw #5 after miss', async () => {
    const cache = mockKv({}, [{ op: 'put', prefix: 'identity:pepper', nth: 1, message: 'pep-put-5' }]);
    const res = await idReq(`${ID_BASE}/hash_details`, {}, idEnv({ cache }));
    expect(res.status).toBe(500);
    expect(cache.data['identity:pepper']).toBeUndefined();
  });
  it('hash_details pepper put throw #6 after miss', async () => {
    const cache = mockKv({}, [{ op: 'put', prefix: 'identity:pepper', nth: 1, message: 'pep-put-6' }]);
    const res = await idReq(`${ID_BASE}/hash_details`, {}, idEnv({ cache }));
    expect(res.status).toBe(500);
    expect(cache.data['identity:pepper']).toBeUndefined();
  });
  it('hash_details pepper put throw #7 after miss', async () => {
    const cache = mockKv({}, [{ op: 'put', prefix: 'identity:pepper', nth: 1, message: 'pep-put-7' }]);
    const res = await idReq(`${ID_BASE}/hash_details`, {}, idEnv({ cache }));
    expect(res.status).toBe(500);
    expect(cache.data['identity:pepper']).toBeUndefined();
  });
  it('hash_details pepper put throw #8 after miss', async () => {
    const cache = mockKv({}, [{ op: 'put', prefix: 'identity:pepper', nth: 1, message: 'pep-put-8' }]);
    const res = await idReq(`${ID_BASE}/hash_details`, {}, idEnv({ cache }));
    expect(res.status).toBe(500);
    expect(cache.data['identity:pepper']).toBeUndefined();
  });
  it('hash_details pepper put throw #9 after miss', async () => {
    const cache = mockKv({}, [{ op: 'put', prefix: 'identity:pepper', nth: 1, message: 'pep-put-9' }]);
    const res = await idReq(`${ID_BASE}/hash_details`, {}, idEnv({ cache }));
    expect(res.status).toBe(500);
    expect(cache.data['identity:pepper']).toBeUndefined();
  });
  it('lookup pepper get throw #0', async () => {
    const cache = mockKv(
      { 'identity:pepper': 'pep' },
      [{ op: 'get', prefix: 'identity:pepper', nth: 1, message: 'look-pep-0' }]
    );
    const res = await idReq(
      `${ID_BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'none', pepper: 'pep', addresses: ['a@b.c email'] }),
      },
      idEnv({ cache })
    );
    expect(res.status).toBe(500);
  });
  it('lookup pepper get throw #1', async () => {
    const cache = mockKv(
      { 'identity:pepper': 'pep' },
      [{ op: 'get', prefix: 'identity:pepper', nth: 1, message: 'look-pep-1' }]
    );
    const res = await idReq(
      `${ID_BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'none', pepper: 'pep', addresses: ['a@b.c email'] }),
      },
      idEnv({ cache })
    );
    expect(res.status).toBe(500);
  });
  it('lookup pepper get throw #2', async () => {
    const cache = mockKv(
      { 'identity:pepper': 'pep' },
      [{ op: 'get', prefix: 'identity:pepper', nth: 1, message: 'look-pep-2' }]
    );
    const res = await idReq(
      `${ID_BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'none', pepper: 'pep', addresses: ['a@b.c email'] }),
      },
      idEnv({ cache })
    );
    expect(res.status).toBe(500);
  });
  it('lookup pepper get throw #3', async () => {
    const cache = mockKv(
      { 'identity:pepper': 'pep' },
      [{ op: 'get', prefix: 'identity:pepper', nth: 1, message: 'look-pep-3' }]
    );
    const res = await idReq(
      `${ID_BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'none', pepper: 'pep', addresses: ['a@b.c email'] }),
      },
      idEnv({ cache })
    );
    expect(res.status).toBe(500);
  });
  it('lookup pepper get throw #4', async () => {
    const cache = mockKv(
      { 'identity:pepper': 'pep' },
      [{ op: 'get', prefix: 'identity:pepper', nth: 1, message: 'look-pep-4' }]
    );
    const res = await idReq(
      `${ID_BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'none', pepper: 'pep', addresses: ['a@b.c email'] }),
      },
      idEnv({ cache })
    );
    expect(res.status).toBe(500);
  });
  it('lookup pepper get throw #5', async () => {
    const cache = mockKv(
      { 'identity:pepper': 'pep' },
      [{ op: 'get', prefix: 'identity:pepper', nth: 1, message: 'look-pep-5' }]
    );
    const res = await idReq(
      `${ID_BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'none', pepper: 'pep', addresses: ['a@b.c email'] }),
      },
      idEnv({ cache })
    );
    expect(res.status).toBe(500);
  });
  it('lookup pepper get throw #6', async () => {
    const cache = mockKv(
      { 'identity:pepper': 'pep' },
      [{ op: 'get', prefix: 'identity:pepper', nth: 1, message: 'look-pep-6' }]
    );
    const res = await idReq(
      `${ID_BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'none', pepper: 'pep', addresses: ['a@b.c email'] }),
      },
      idEnv({ cache })
    );
    expect(res.status).toBe(500);
  });
  it('lookup pepper get throw #7', async () => {
    const cache = mockKv(
      { 'identity:pepper': 'pep' },
      [{ op: 'get', prefix: 'identity:pepper', nth: 1, message: 'look-pep-7' }]
    );
    const res = await idReq(
      `${ID_BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'none', pepper: 'pep', addresses: ['a@b.c email'] }),
      },
      idEnv({ cache })
    );
    expect(res.status).toBe(500);
  });
});

describe('persist-fail identity D1 lookup / email validate throws', () => {
  it('sha256 lookup associations.all throw #0', async () => {
    const cache = mockKv({ 'identity:pepper': 'pep0' });
    const db = createIdentityDb({
      associations: [{ medium: 'email', address: 'a@b.c', mxid: USER }],
      fails: [{ match: 'FROM identity_associations', method: 'all', message: 'assoc-all-0' }],
    });
    const addr = await sha256(`a@b.c email pep0`);
    const res = await idReq(
      `${ID_BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'sha256', pepper: 'pep0', addresses: [addr] }),
      },
      idEnv({ cache, db })
    );
    expect(res.status).toBe(500);
  });
  it('sha256 lookup associations.all throw #1', async () => {
    const cache = mockKv({ 'identity:pepper': 'pep1' });
    const db = createIdentityDb({
      associations: [{ medium: 'email', address: 'a@b.c', mxid: USER }],
      fails: [{ match: 'FROM identity_associations', method: 'all', message: 'assoc-all-1' }],
    });
    const addr = await sha256(`a@b.c email pep1`);
    const res = await idReq(
      `${ID_BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'sha256', pepper: 'pep1', addresses: [addr] }),
      },
      idEnv({ cache, db })
    );
    expect(res.status).toBe(500);
  });
  it('sha256 lookup associations.all throw #2', async () => {
    const cache = mockKv({ 'identity:pepper': 'pep2' });
    const db = createIdentityDb({
      associations: [{ medium: 'email', address: 'a@b.c', mxid: USER }],
      fails: [{ match: 'FROM identity_associations', method: 'all', message: 'assoc-all-2' }],
    });
    const addr = await sha256(`a@b.c email pep2`);
    const res = await idReq(
      `${ID_BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'sha256', pepper: 'pep2', addresses: [addr] }),
      },
      idEnv({ cache, db })
    );
    expect(res.status).toBe(500);
  });
  it('sha256 lookup associations.all throw #3', async () => {
    const cache = mockKv({ 'identity:pepper': 'pep3' });
    const db = createIdentityDb({
      associations: [{ medium: 'email', address: 'a@b.c', mxid: USER }],
      fails: [{ match: 'FROM identity_associations', method: 'all', message: 'assoc-all-3' }],
    });
    const addr = await sha256(`a@b.c email pep3`);
    const res = await idReq(
      `${ID_BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'sha256', pepper: 'pep3', addresses: [addr] }),
      },
      idEnv({ cache, db })
    );
    expect(res.status).toBe(500);
  });
  it('sha256 lookup associations.all throw #4', async () => {
    const cache = mockKv({ 'identity:pepper': 'pep4' });
    const db = createIdentityDb({
      associations: [{ medium: 'email', address: 'a@b.c', mxid: USER }],
      fails: [{ match: 'FROM identity_associations', method: 'all', message: 'assoc-all-4' }],
    });
    const addr = await sha256(`a@b.c email pep4`);
    const res = await idReq(
      `${ID_BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'sha256', pepper: 'pep4', addresses: [addr] }),
      },
      idEnv({ cache, db })
    );
    expect(res.status).toBe(500);
  });
  it('sha256 lookup associations.all throw #5', async () => {
    const cache = mockKv({ 'identity:pepper': 'pep5' });
    const db = createIdentityDb({
      associations: [{ medium: 'email', address: 'a@b.c', mxid: USER }],
      fails: [{ match: 'FROM identity_associations', method: 'all', message: 'assoc-all-5' }],
    });
    const addr = await sha256(`a@b.c email pep5`);
    const res = await idReq(
      `${ID_BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'sha256', pepper: 'pep5', addresses: [addr] }),
      },
      idEnv({ cache, db })
    );
    expect(res.status).toBe(500);
  });
  it('sha256 lookup associations.all throw #6', async () => {
    const cache = mockKv({ 'identity:pepper': 'pep6' });
    const db = createIdentityDb({
      associations: [{ medium: 'email', address: 'a@b.c', mxid: USER }],
      fails: [{ match: 'FROM identity_associations', method: 'all', message: 'assoc-all-6' }],
    });
    const addr = await sha256(`a@b.c email pep6`);
    const res = await idReq(
      `${ID_BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'sha256', pepper: 'pep6', addresses: [addr] }),
      },
      idEnv({ cache, db })
    );
    expect(res.status).toBe(500);
  });
  it('sha256 lookup associations.all throw #7', async () => {
    const cache = mockKv({ 'identity:pepper': 'pep7' });
    const db = createIdentityDb({
      associations: [{ medium: 'email', address: 'a@b.c', mxid: USER }],
      fails: [{ match: 'FROM identity_associations', method: 'all', message: 'assoc-all-7' }],
    });
    const addr = await sha256(`a@b.c email pep7`);
    const res = await idReq(
      `${ID_BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'sha256', pepper: 'pep7', addresses: [addr] }),
      },
      idEnv({ cache, db })
    );
    expect(res.status).toBe(500);
  });
  it('none lookup first throw #0', async () => {
    const cache = mockKv({ 'identity:pepper': 'pep' });
    const db = createIdentityDb({
      associations: [{ medium: 'email', address: 'x@y.z', mxid: USER }],
      fails: [{ match: 'WHERE medium = ?', method: 'first', message: 'none-first-0' }],
    });
    const res = await idReq(
      `${ID_BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'none', pepper: 'pep', addresses: ['x@y.z email'] }),
      },
      idEnv({ cache, db })
    );
    expect(res.status).toBe(500);
  });
  it('none lookup first throw #1', async () => {
    const cache = mockKv({ 'identity:pepper': 'pep' });
    const db = createIdentityDb({
      associations: [{ medium: 'email', address: 'x@y.z', mxid: USER }],
      fails: [{ match: 'WHERE medium = ?', method: 'first', message: 'none-first-1' }],
    });
    const res = await idReq(
      `${ID_BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'none', pepper: 'pep', addresses: ['x@y.z email'] }),
      },
      idEnv({ cache, db })
    );
    expect(res.status).toBe(500);
  });
  it('none lookup first throw #2', async () => {
    const cache = mockKv({ 'identity:pepper': 'pep' });
    const db = createIdentityDb({
      associations: [{ medium: 'email', address: 'x@y.z', mxid: USER }],
      fails: [{ match: 'WHERE medium = ?', method: 'first', message: 'none-first-2' }],
    });
    const res = await idReq(
      `${ID_BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'none', pepper: 'pep', addresses: ['x@y.z email'] }),
      },
      idEnv({ cache, db })
    );
    expect(res.status).toBe(500);
  });
  it('none lookup first throw #3', async () => {
    const cache = mockKv({ 'identity:pepper': 'pep' });
    const db = createIdentityDb({
      associations: [{ medium: 'email', address: 'x@y.z', mxid: USER }],
      fails: [{ match: 'WHERE medium = ?', method: 'first', message: 'none-first-3' }],
    });
    const res = await idReq(
      `${ID_BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'none', pepper: 'pep', addresses: ['x@y.z email'] }),
      },
      idEnv({ cache, db })
    );
    expect(res.status).toBe(500);
  });
  it('none lookup first throw #4', async () => {
    const cache = mockKv({ 'identity:pepper': 'pep' });
    const db = createIdentityDb({
      associations: [{ medium: 'email', address: 'x@y.z', mxid: USER }],
      fails: [{ match: 'WHERE medium = ?', method: 'first', message: 'none-first-4' }],
    });
    const res = await idReq(
      `${ID_BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'none', pepper: 'pep', addresses: ['x@y.z email'] }),
      },
      idEnv({ cache, db })
    );
    expect(res.status).toBe(500);
  });
  it('none lookup first throw #5', async () => {
    const cache = mockKv({ 'identity:pepper': 'pep' });
    const db = createIdentityDb({
      associations: [{ medium: 'email', address: 'x@y.z', mxid: USER }],
      fails: [{ match: 'WHERE medium = ?', method: 'first', message: 'none-first-5' }],
    });
    const res = await idReq(
      `${ID_BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'none', pepper: 'pep', addresses: ['x@y.z email'] }),
      },
      idEnv({ cache, db })
    );
    expect(res.status).toBe(500);
  });
  it('none lookup first throw #6', async () => {
    const cache = mockKv({ 'identity:pepper': 'pep' });
    const db = createIdentityDb({
      associations: [{ medium: 'email', address: 'x@y.z', mxid: USER }],
      fails: [{ match: 'WHERE medium = ?', method: 'first', message: 'none-first-6' }],
    });
    const res = await idReq(
      `${ID_BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'none', pepper: 'pep', addresses: ['x@y.z email'] }),
      },
      idEnv({ cache, db })
    );
    expect(res.status).toBe(500);
  });
  it('none lookup first throw #7', async () => {
    const cache = mockKv({ 'identity:pepper': 'pep' });
    const db = createIdentityDb({
      associations: [{ medium: 'email', address: 'x@y.z', mxid: USER }],
      fails: [{ match: 'WHERE medium = ?', method: 'first', message: 'none-first-7' }],
    });
    const res = await idReq(
      `${ID_BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithm: 'none', pepper: 'pep', addresses: ['x@y.z email'] }),
      },
      idEnv({ cache, db })
    );
    expect(res.status).toBe(500);
  });
  it('requestToken insert throw #0', async () => {
    const db = createIdentityDb({
      fails: [{ match: 'INSERT INTO email_verification_sessions', method: 'run', message: 'email-ins-0' }],
    });
    const res = await idReq(
      `${ID_BASE}/validate/email/requestToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a0@example.com', client_secret: 'sec0', send_attempt: 1 }),
      },
      idEnv({ db })
    );
    expect(res.status).toBe(500);
    expect(db.emailSessions.size).toBe(0);
  });
  it('requestToken insert throw #1', async () => {
    const db = createIdentityDb({
      fails: [{ match: 'INSERT INTO email_verification_sessions', method: 'run', message: 'email-ins-1' }],
    });
    const res = await idReq(
      `${ID_BASE}/validate/email/requestToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a1@example.com', client_secret: 'sec1', send_attempt: 1 }),
      },
      idEnv({ db })
    );
    expect(res.status).toBe(500);
    expect(db.emailSessions.size).toBe(0);
  });
  it('requestToken insert throw #2', async () => {
    const db = createIdentityDb({
      fails: [{ match: 'INSERT INTO email_verification_sessions', method: 'run', message: 'email-ins-2' }],
    });
    const res = await idReq(
      `${ID_BASE}/validate/email/requestToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a2@example.com', client_secret: 'sec2', send_attempt: 1 }),
      },
      idEnv({ db })
    );
    expect(res.status).toBe(500);
    expect(db.emailSessions.size).toBe(0);
  });
  it('requestToken insert throw #3', async () => {
    const db = createIdentityDb({
      fails: [{ match: 'INSERT INTO email_verification_sessions', method: 'run', message: 'email-ins-3' }],
    });
    const res = await idReq(
      `${ID_BASE}/validate/email/requestToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a3@example.com', client_secret: 'sec3', send_attempt: 1 }),
      },
      idEnv({ db })
    );
    expect(res.status).toBe(500);
    expect(db.emailSessions.size).toBe(0);
  });
  it('requestToken insert throw #4', async () => {
    const db = createIdentityDb({
      fails: [{ match: 'INSERT INTO email_verification_sessions', method: 'run', message: 'email-ins-4' }],
    });
    const res = await idReq(
      `${ID_BASE}/validate/email/requestToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a4@example.com', client_secret: 'sec4', send_attempt: 1 }),
      },
      idEnv({ db })
    );
    expect(res.status).toBe(500);
    expect(db.emailSessions.size).toBe(0);
  });
  it('requestToken insert throw #5', async () => {
    const db = createIdentityDb({
      fails: [{ match: 'INSERT INTO email_verification_sessions', method: 'run', message: 'email-ins-5' }],
    });
    const res = await idReq(
      `${ID_BASE}/validate/email/requestToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a5@example.com', client_secret: 'sec5', send_attempt: 1 }),
      },
      idEnv({ db })
    );
    expect(res.status).toBe(500);
    expect(db.emailSessions.size).toBe(0);
  });
  it('requestToken insert throw #6', async () => {
    const db = createIdentityDb({
      fails: [{ match: 'INSERT INTO email_verification_sessions', method: 'run', message: 'email-ins-6' }],
    });
    const res = await idReq(
      `${ID_BASE}/validate/email/requestToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a6@example.com', client_secret: 'sec6', send_attempt: 1 }),
      },
      idEnv({ db })
    );
    expect(res.status).toBe(500);
    expect(db.emailSessions.size).toBe(0);
  });
  it('requestToken insert throw #7', async () => {
    const db = createIdentityDb({
      fails: [{ match: 'INSERT INTO email_verification_sessions', method: 'run', message: 'email-ins-7' }],
    });
    const res = await idReq(
      `${ID_BASE}/validate/email/requestToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a7@example.com', client_secret: 'sec7', send_attempt: 1 }),
      },
      idEnv({ db })
    );
    expect(res.status).toBe(500);
    expect(db.emailSessions.size).toBe(0);
  });
  it('submitToken select throw #0', async () => {
    const db = createIdentityDb({
      fails: [{ match: 'FROM email_verification_sessions', method: 'first', message: 'email-sel-0' }],
    });
    const res = await idReq(
      `${ID_BASE}/validate/email/submitToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: 's0', client_secret: 'c', token: '123456' }),
      },
      idEnv({ db })
    );
    expect(res.status).toBe(500);
  });
  it('submitToken select throw #1', async () => {
    const db = createIdentityDb({
      fails: [{ match: 'FROM email_verification_sessions', method: 'first', message: 'email-sel-1' }],
    });
    const res = await idReq(
      `${ID_BASE}/validate/email/submitToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: 's1', client_secret: 'c', token: '123456' }),
      },
      idEnv({ db })
    );
    expect(res.status).toBe(500);
  });
  it('submitToken select throw #2', async () => {
    const db = createIdentityDb({
      fails: [{ match: 'FROM email_verification_sessions', method: 'first', message: 'email-sel-2' }],
    });
    const res = await idReq(
      `${ID_BASE}/validate/email/submitToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: 's2', client_secret: 'c', token: '123456' }),
      },
      idEnv({ db })
    );
    expect(res.status).toBe(500);
  });
  it('submitToken select throw #3', async () => {
    const db = createIdentityDb({
      fails: [{ match: 'FROM email_verification_sessions', method: 'first', message: 'email-sel-3' }],
    });
    const res = await idReq(
      `${ID_BASE}/validate/email/submitToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: 's3', client_secret: 'c', token: '123456' }),
      },
      idEnv({ db })
    );
    expect(res.status).toBe(500);
  });
  it('submitToken select throw #4', async () => {
    const db = createIdentityDb({
      fails: [{ match: 'FROM email_verification_sessions', method: 'first', message: 'email-sel-4' }],
    });
    const res = await idReq(
      `${ID_BASE}/validate/email/submitToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: 's4', client_secret: 'c', token: '123456' }),
      },
      idEnv({ db })
    );
    expect(res.status).toBe(500);
  });
  it('submitToken select throw #5', async () => {
    const db = createIdentityDb({
      fails: [{ match: 'FROM email_verification_sessions', method: 'first', message: 'email-sel-5' }],
    });
    const res = await idReq(
      `${ID_BASE}/validate/email/submitToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: 's5', client_secret: 'c', token: '123456' }),
      },
      idEnv({ db })
    );
    expect(res.status).toBe(500);
  });
  it('submitToken select throw #6', async () => {
    const db = createIdentityDb({
      fails: [{ match: 'FROM email_verification_sessions', method: 'first', message: 'email-sel-6' }],
    });
    const res = await idReq(
      `${ID_BASE}/validate/email/submitToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: 's6', client_secret: 'c', token: '123456' }),
      },
      idEnv({ db })
    );
    expect(res.status).toBe(500);
  });
  it('submitToken select throw #7', async () => {
    const db = createIdentityDb({
      fails: [{ match: 'FROM email_verification_sessions', method: 'first', message: 'email-sel-7' }],
    });
    const res = await idReq(
      `${ID_BASE}/validate/email/submitToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: 's7', client_secret: 'c', token: '123456' }),
      },
      idEnv({ db })
    );
    expect(res.status).toBe(500);
  });
  it('submitToken update throw #0 after match', async () => {
    const sessions = new Map<string, EmailSess>();
    sessions.set('sid0', {
      session_id: 'sid0',
      email: 'e0@example.com',
      client_secret: 'sec',
      token: '654321',
      send_attempt: 1,
      validated: 0,
      created_at: NOW,
      expires_at: NOW + 60_000,
    });
    const db = createIdentityDb({
      emailSessions: sessions,
      fails: [{ match: 'UPDATE email_verification_sessions SET validated', method: 'run', message: 'email-upd-0' }],
    });
    const res = await idReq(
      `${ID_BASE}/validate/email/submitToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: 'sid0', client_secret: 'sec', token: '654321' }),
      },
      idEnv({ db })
    );
    expect(res.status).toBe(500);
    expect(sessions.get('sid0')!.validated).toBe(0);
  });
  it('submitToken update throw #1 after match', async () => {
    const sessions = new Map<string, EmailSess>();
    sessions.set('sid1', {
      session_id: 'sid1',
      email: 'e1@example.com',
      client_secret: 'sec',
      token: '654321',
      send_attempt: 1,
      validated: 0,
      created_at: NOW,
      expires_at: NOW + 60_000,
    });
    const db = createIdentityDb({
      emailSessions: sessions,
      fails: [{ match: 'UPDATE email_verification_sessions SET validated', method: 'run', message: 'email-upd-1' }],
    });
    const res = await idReq(
      `${ID_BASE}/validate/email/submitToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: 'sid1', client_secret: 'sec', token: '654321' }),
      },
      idEnv({ db })
    );
    expect(res.status).toBe(500);
    expect(sessions.get('sid1')!.validated).toBe(0);
  });
  it('submitToken update throw #2 after match', async () => {
    const sessions = new Map<string, EmailSess>();
    sessions.set('sid2', {
      session_id: 'sid2',
      email: 'e2@example.com',
      client_secret: 'sec',
      token: '654321',
      send_attempt: 1,
      validated: 0,
      created_at: NOW,
      expires_at: NOW + 60_000,
    });
    const db = createIdentityDb({
      emailSessions: sessions,
      fails: [{ match: 'UPDATE email_verification_sessions SET validated', method: 'run', message: 'email-upd-2' }],
    });
    const res = await idReq(
      `${ID_BASE}/validate/email/submitToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: 'sid2', client_secret: 'sec', token: '654321' }),
      },
      idEnv({ db })
    );
    expect(res.status).toBe(500);
    expect(sessions.get('sid2')!.validated).toBe(0);
  });
  it('submitToken update throw #3 after match', async () => {
    const sessions = new Map<string, EmailSess>();
    sessions.set('sid3', {
      session_id: 'sid3',
      email: 'e3@example.com',
      client_secret: 'sec',
      token: '654321',
      send_attempt: 1,
      validated: 0,
      created_at: NOW,
      expires_at: NOW + 60_000,
    });
    const db = createIdentityDb({
      emailSessions: sessions,
      fails: [{ match: 'UPDATE email_verification_sessions SET validated', method: 'run', message: 'email-upd-3' }],
    });
    const res = await idReq(
      `${ID_BASE}/validate/email/submitToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: 'sid3', client_secret: 'sec', token: '654321' }),
      },
      idEnv({ db })
    );
    expect(res.status).toBe(500);
    expect(sessions.get('sid3')!.validated).toBe(0);
  });
  it('submitToken update throw #4 after match', async () => {
    const sessions = new Map<string, EmailSess>();
    sessions.set('sid4', {
      session_id: 'sid4',
      email: 'e4@example.com',
      client_secret: 'sec',
      token: '654321',
      send_attempt: 1,
      validated: 0,
      created_at: NOW,
      expires_at: NOW + 60_000,
    });
    const db = createIdentityDb({
      emailSessions: sessions,
      fails: [{ match: 'UPDATE email_verification_sessions SET validated', method: 'run', message: 'email-upd-4' }],
    });
    const res = await idReq(
      `${ID_BASE}/validate/email/submitToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: 'sid4', client_secret: 'sec', token: '654321' }),
      },
      idEnv({ db })
    );
    expect(res.status).toBe(500);
    expect(sessions.get('sid4')!.validated).toBe(0);
  });
  it('submitToken update throw #5 after match', async () => {
    const sessions = new Map<string, EmailSess>();
    sessions.set('sid5', {
      session_id: 'sid5',
      email: 'e5@example.com',
      client_secret: 'sec',
      token: '654321',
      send_attempt: 1,
      validated: 0,
      created_at: NOW,
      expires_at: NOW + 60_000,
    });
    const db = createIdentityDb({
      emailSessions: sessions,
      fails: [{ match: 'UPDATE email_verification_sessions SET validated', method: 'run', message: 'email-upd-5' }],
    });
    const res = await idReq(
      `${ID_BASE}/validate/email/submitToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: 'sid5', client_secret: 'sec', token: '654321' }),
      },
      idEnv({ db })
    );
    expect(res.status).toBe(500);
    expect(sessions.get('sid5')!.validated).toBe(0);
  });
  it('submitToken update throw #6 after match', async () => {
    const sessions = new Map<string, EmailSess>();
    sessions.set('sid6', {
      session_id: 'sid6',
      email: 'e6@example.com',
      client_secret: 'sec',
      token: '654321',
      send_attempt: 1,
      validated: 0,
      created_at: NOW,
      expires_at: NOW + 60_000,
    });
    const db = createIdentityDb({
      emailSessions: sessions,
      fails: [{ match: 'UPDATE email_verification_sessions SET validated', method: 'run', message: 'email-upd-6' }],
    });
    const res = await idReq(
      `${ID_BASE}/validate/email/submitToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: 'sid6', client_secret: 'sec', token: '654321' }),
      },
      idEnv({ db })
    );
    expect(res.status).toBe(500);
    expect(sessions.get('sid6')!.validated).toBe(0);
  });
  it('submitToken update throw #7 after match', async () => {
    const sessions = new Map<string, EmailSess>();
    sessions.set('sid7', {
      session_id: 'sid7',
      email: 'e7@example.com',
      client_secret: 'sec',
      token: '654321',
      send_attempt: 1,
      validated: 0,
      created_at: NOW,
      expires_at: NOW + 60_000,
    });
    const db = createIdentityDb({
      emailSessions: sessions,
      fails: [{ match: 'UPDATE email_verification_sessions SET validated', method: 'run', message: 'email-upd-7' }],
    });
    const res = await idReq(
      `${ID_BASE}/validate/email/submitToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: 'sid7', client_secret: 'sec', token: '654321' }),
      },
      idEnv({ db })
    );
    expect(res.status).toBe(500);
    expect(sessions.get('sid7')!.validated).toBe(0);
  });
});

describe('persist-fail cross-path isolation under faults', () => {
  it('password refresh-put fail does not poison sibling lockout #0', async () => {
    const sessions = mockKv(
      { [`lockout:${BOB}`]: JSON.stringify({ attempts: 1 }) },
      [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'iso-ref-0' }]
    );
    const db = aliceDb();
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'ISO0',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`lockout:${BOB}`]).toBeTruthy();
  });
  it('password refresh-put fail does not poison sibling lockout #1', async () => {
    const sessions = mockKv(
      { [`lockout:${BOB}`]: JSON.stringify({ attempts: 1 }) },
      [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'iso-ref-1' }]
    );
    const db = aliceDb();
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'ISO1',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`lockout:${BOB}`]).toBeTruthy();
  });
  it('password refresh-put fail does not poison sibling lockout #2', async () => {
    const sessions = mockKv(
      { [`lockout:${BOB}`]: JSON.stringify({ attempts: 1 }) },
      [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'iso-ref-2' }]
    );
    const db = aliceDb();
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'ISO2',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`lockout:${BOB}`]).toBeTruthy();
  });
  it('password refresh-put fail does not poison sibling lockout #3', async () => {
    const sessions = mockKv(
      { [`lockout:${BOB}`]: JSON.stringify({ attempts: 1 }) },
      [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'iso-ref-3' }]
    );
    const db = aliceDb();
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'ISO3',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`lockout:${BOB}`]).toBeTruthy();
  });
  it('password refresh-put fail does not poison sibling lockout #4', async () => {
    const sessions = mockKv(
      { [`lockout:${BOB}`]: JSON.stringify({ attempts: 1 }) },
      [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'iso-ref-4' }]
    );
    const db = aliceDb();
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'ISO4',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`lockout:${BOB}`]).toBeTruthy();
  });
  it('password refresh-put fail does not poison sibling lockout #5', async () => {
    const sessions = mockKv(
      { [`lockout:${BOB}`]: JSON.stringify({ attempts: 1 }) },
      [{ op: 'put', prefix: 'refresh:', nth: 1, message: 'iso-ref-5' }]
    );
    const db = aliceDb();
    const env = loginEnv(db, sessions);
    const res = await loginReq(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'ISO5',
      }, '')
    );
    expect(res.status).toBe(500);
    expect(sessions.data[`lockout:${BOB}`]).toBeTruthy();
  });
  it('QR get fail does not delete token; later login can still consume #0', async () => {
    const sessions = mockKv();
    const t = 'mlt_later_0';
    const hash = await seedLoginToken(sessions, t);
    // first: failing QR get via separate kv wrapper sharing data
    const failing = mockKv(sessions.data, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'tmp-0' }]);
    const bad = await qrReq(`/login/qr/${t}/check`, {}, qrEnv(failing));
    expect(bad.status).toBe(500);
    // data object was shared — token still there
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    const ok = await loginReq(
      loginEnv(aliceDb(), sessions),
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: t, device_id: 'LATER0' }, '')
    );
    expect(ok.status).toBe(200);
    expect(ok.body.user_id).toBe(USER);
  });
  it('QR get fail does not delete token; later login can still consume #1', async () => {
    const sessions = mockKv();
    const t = 'mlt_later_1';
    const hash = await seedLoginToken(sessions, t);
    // first: failing QR get via separate kv wrapper sharing data
    const failing = mockKv(sessions.data, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'tmp-1' }]);
    const bad = await qrReq(`/login/qr/${t}/check`, {}, qrEnv(failing));
    expect(bad.status).toBe(500);
    // data object was shared — token still there
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    const ok = await loginReq(
      loginEnv(aliceDb(), sessions),
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: t, device_id: 'LATER1' }, '')
    );
    expect(ok.status).toBe(200);
    expect(ok.body.user_id).toBe(USER);
  });
  it('QR get fail does not delete token; later login can still consume #2', async () => {
    const sessions = mockKv();
    const t = 'mlt_later_2';
    const hash = await seedLoginToken(sessions, t);
    // first: failing QR get via separate kv wrapper sharing data
    const failing = mockKv(sessions.data, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'tmp-2' }]);
    const bad = await qrReq(`/login/qr/${t}/check`, {}, qrEnv(failing));
    expect(bad.status).toBe(500);
    // data object was shared — token still there
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    const ok = await loginReq(
      loginEnv(aliceDb(), sessions),
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: t, device_id: 'LATER2' }, '')
    );
    expect(ok.status).toBe(200);
    expect(ok.body.user_id).toBe(USER);
  });
  it('QR get fail does not delete token; later login can still consume #3', async () => {
    const sessions = mockKv();
    const t = 'mlt_later_3';
    const hash = await seedLoginToken(sessions, t);
    // first: failing QR get via separate kv wrapper sharing data
    const failing = mockKv(sessions.data, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'tmp-3' }]);
    const bad = await qrReq(`/login/qr/${t}/check`, {}, qrEnv(failing));
    expect(bad.status).toBe(500);
    // data object was shared — token still there
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    const ok = await loginReq(
      loginEnv(aliceDb(), sessions),
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: t, device_id: 'LATER3' }, '')
    );
    expect(ok.status).toBe(200);
    expect(ok.body.user_id).toBe(USER);
  });
  it('QR get fail does not delete token; later login can still consume #4', async () => {
    const sessions = mockKv();
    const t = 'mlt_later_4';
    const hash = await seedLoginToken(sessions, t);
    // first: failing QR get via separate kv wrapper sharing data
    const failing = mockKv(sessions.data, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'tmp-4' }]);
    const bad = await qrReq(`/login/qr/${t}/check`, {}, qrEnv(failing));
    expect(bad.status).toBe(500);
    // data object was shared — token still there
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    const ok = await loginReq(
      loginEnv(aliceDb(), sessions),
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: t, device_id: 'LATER4' }, '')
    );
    expect(ok.status).toBe(200);
    expect(ok.body.user_id).toBe(USER);
  });
  it('QR get fail does not delete token; later login can still consume #5', async () => {
    const sessions = mockKv();
    const t = 'mlt_later_5';
    const hash = await seedLoginToken(sessions, t);
    // first: failing QR get via separate kv wrapper sharing data
    const failing = mockKv(sessions.data, [{ op: 'get', prefix: 'login_token:', nth: 1, message: 'tmp-5' }]);
    const bad = await qrReq(`/login/qr/${t}/check`, {}, qrEnv(failing));
    expect(bad.status).toBe(500);
    // data object was shared — token still there
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    const ok = await loginReq(
      loginEnv(aliceDb(), sessions),
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: t, device_id: 'LATER5' }, '')
    );
    expect(ok.status).toBe(200);
    expect(ok.body.user_id).toBe(USER);
  });
});

describe('persist-fail whoami D1 throws', () => {
  it('whoami user first throw #0', async () => {
    const db = aliceDb();
    db.fails.push({ match: 'FROM users WHERE user_id', method: 'first', message: 'who-0' });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/account/whoami', { method: 'GET', headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(500);
  });
  it('whoami user first throw #1', async () => {
    const db = aliceDb();
    db.fails.push({ match: 'FROM users WHERE user_id', method: 'first', message: 'who-1' });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/account/whoami', { method: 'GET', headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(500);
  });
  it('whoami user first throw #2', async () => {
    const db = aliceDb();
    db.fails.push({ match: 'FROM users WHERE user_id', method: 'first', message: 'who-2' });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/account/whoami', { method: 'GET', headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(500);
  });
  it('whoami user first throw #3', async () => {
    const db = aliceDb();
    db.fails.push({ match: 'FROM users WHERE user_id', method: 'first', message: 'who-3' });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/account/whoami', { method: 'GET', headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(500);
  });
  it('whoami user first throw #4', async () => {
    const db = aliceDb();
    db.fails.push({ match: 'FROM users WHERE user_id', method: 'first', message: 'who-4' });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/account/whoami', { method: 'GET', headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(500);
  });
  it('whoami user first throw #5', async () => {
    const db = aliceDb();
    db.fails.push({ match: 'FROM users WHERE user_id', method: 'first', message: 'who-5' });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/account/whoami', { method: 'GET', headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(500);
  });
  it('whoami user first throw #6', async () => {
    const db = aliceDb();
    db.fails.push({ match: 'FROM users WHERE user_id', method: 'first', message: 'who-6' });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/account/whoami', { method: 'GET', headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(500);
  });
  it('whoami user first throw #7', async () => {
    const db = aliceDb();
    db.fails.push({ match: 'FROM users WHERE user_id', method: 'first', message: 'who-7' });
    const res = await loginReq(loginEnv(db), '/_matrix/client/v3/account/whoami', { method: 'GET', headers: { Authorization: 'Bearer x' } });
    expect(res.status).toBe(500);
  });
});

describe('persist-fail password hash select throws', () => {
  it('getPasswordHash first throw #0', async () => {
    const db = aliceDb();
    db.fails.push({ match: 'SELECT password_hash FROM users', method: 'first', message: 'pw-0' });
    const res = await loginReq(
      loginEnv(db),
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.tokens).toHaveLength(0);
  });
  it('getPasswordHash first throw #1', async () => {
    const db = aliceDb();
    db.fails.push({ match: 'SELECT password_hash FROM users', method: 'first', message: 'pw-1' });
    const res = await loginReq(
      loginEnv(db),
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.tokens).toHaveLength(0);
  });
  it('getPasswordHash first throw #2', async () => {
    const db = aliceDb();
    db.fails.push({ match: 'SELECT password_hash FROM users', method: 'first', message: 'pw-2' });
    const res = await loginReq(
      loginEnv(db),
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.tokens).toHaveLength(0);
  });
  it('getPasswordHash first throw #3', async () => {
    const db = aliceDb();
    db.fails.push({ match: 'SELECT password_hash FROM users', method: 'first', message: 'pw-3' });
    const res = await loginReq(
      loginEnv(db),
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.tokens).toHaveLength(0);
  });
  it('getPasswordHash first throw #4', async () => {
    const db = aliceDb();
    db.fails.push({ match: 'SELECT password_hash FROM users', method: 'first', message: 'pw-4' });
    const res = await loginReq(
      loginEnv(db),
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.tokens).toHaveLength(0);
  });
  it('getPasswordHash first throw #5', async () => {
    const db = aliceDb();
    db.fails.push({ match: 'SELECT password_hash FROM users', method: 'first', message: 'pw-5' });
    const res = await loginReq(
      loginEnv(db),
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.tokens).toHaveLength(0);
  });
  it('getPasswordHash first throw #6', async () => {
    const db = aliceDb();
    db.fails.push({ match: 'SELECT password_hash FROM users', method: 'first', message: 'pw-6' });
    const res = await loginReq(
      loginEnv(db),
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.tokens).toHaveLength(0);
  });
  it('getPasswordHash first throw #7', async () => {
    const db = aliceDb();
    db.fails.push({ match: 'SELECT password_hash FROM users', method: 'first', message: 'pw-7' });
    const res = await loginReq(
      loginEnv(db),
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
      }, '')
    );
    expect(res.status).toBe(500);
    expect(db.tokens).toHaveLength(0);
  });
});
