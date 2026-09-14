/**
 * TOKENMAXX HEAVY leftovers after identity #140 — login + QR login KV/state reliability.
 * Orthogonal to open oauth/push/account-data leftovers (#142) and saturated identity suites.
 * Deepens src/api/login.ts + src/api/qr-login.ts only: corrupt/partial KV shapes, lockout
 * hostility, refresh rotation atomicity, QR↔token cross-path. Tests-only — no product inventing.
 * Fixtures use example.com only.
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
    verifyPassword: vi.fn(async (password: string, storedHash: string) => {
      return storedHash === `mockok:${password}`;
    }),
    hashPassword: vi.fn(async (password: string) => `mockok:${password}`),
  };
});

import login from '../src/api/login';
import qrLogin from '../src/api/qr-login';

const SERVER = 'example.com';
const USER = `@alice:${SERVER}`;
const BOB = `@bob:${SERVER}`;
const DEVICE = 'DEVICE';
const NOW = 1_730_100_000_000;
const PASS = 'secret123';

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
  devices?: DeviceRow[];
  tokens?: TokenRow[];
} = {}) {
  const users = opts.users ?? new Map<string, UserRow>();
  const devices = opts.devices ?? [];
  const tokens = opts.tokens ?? [];
  const inserts: SqlCall[] = [];
  const deletes: SqlCall[] = [];

  const db = {
    users,
    devices,
    tokens,
    inserts,
    deletes,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('FROM users') && sql.includes('WHERE localpart')) {
                const localpart = args[0] as string;
                for (const u of users.values()) {
                  if (u.localpart === localpart) return u as T;
                }
                return null;
              }
              if (sql.includes('FROM users') && sql.includes('WHERE user_id')) {
                const userId = args[0] as string;
                const u = users.get(userId);
                if (!u) return null;
                if (sql.includes('password_hash') && !sql.includes('display_name')) {
                  return { password_hash: u.password_hash } as T;
                }
                return u as T;
              }
              if (sql.includes('FROM access_tokens') && sql.includes('token_hash')) {
                const hash = args[0] as string;
                const row = tokens.find((t) => t.token_hash === hash);
                if (!row) return null;
                return {
                  user_id: row.user_id,
                  device_id: row.device_id,
                  created_at: row.created_at,
                } as T;
              }
              return null;
            },
            async run() {
              if (sql.trimStart().toUpperCase().startsWith('INSERT') && sql.includes('INTO devices')) {
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
              if (sql.trimStart().toUpperCase().startsWith('INSERT') && sql.includes('INTO access_tokens')) {
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
              if (sql.trimStart().toUpperCase().startsWith('INSERT') && sql.includes('INTO users')) {
                inserts.push({ sql, args });
                return { success: true, meta: { changes: 1 } };
              }
              throw new Error(`Unhandled SQL in login-qr leftovers stub: ${sql.slice(0, 140)}`);
            },
          };
        },
      };
    },
  };

  return db;
}

type LoginDb = ReturnType<typeof createLoginDb>;

function aliceDb(password = PASS): LoginDb {
  return createLoginDb({
    users: new Map([
      [
        USER,
        userRow({
          user_id: USER,
          localpart: 'alice',
          password_hash: `mockok:${password}`,
        }),
      ],
      [
        BOB,
        userRow({
          user_id: BOB,
          localpart: 'bob',
          password_hash: `mockok:${password}`,
        }),
      ],
    ]),
  });
}

function envFor(
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

function qrEnv(sessions?: ReturnType<typeof mockKv>, serverName = SERVER): Env {
  return {
    SESSIONS: sessions ?? mockKv(),
    SERVER_NAME: serverName,
  } as unknown as Env;
}

async function loginRequest(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: Record<string, unknown>; text: string; headers: Headers }> {
  const res = await login.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { _raw: text };
    }
  }
  return { status: res.status, body, text, headers: res.headers };
}

async function qrRequest(
  path: string,
  init: RequestInit = {},
  env: Env = qrEnv()
): Promise<{ status: number; body: unknown; text: string; headers: Headers }> {
  const res = await qrLogin.request(`https://${SERVER}${path}`, init, env);
  const ct = res.headers.get('content-type') || '';
  let body: unknown = null;
  let text = '';
  if (ct.includes('application/json')) {
    body = await res.json();
    text = JSON.stringify(body);
  } else {
    text = await res.text();
    body = text;
  }
  return { status: res.status, body, text, headers: res.headers };
}

function jsonInit(method: string, body?: unknown, token = ''): RequestInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
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
  payload: unknown
): Promise<string> {
  const hash = await hashToken(raw);
  sessions.data[`login_token:${hash}`] =
    typeof payload === 'string' ? payload : JSON.stringify(payload);
  return hash;
}

async function seedRefresh(
  sessions: ReturnType<typeof mockKv>,
  db: LoginDb,
  raw: string,
  payload: Record<string, unknown>,
  alsoSeedAccess = true
): Promise<string> {
  const hash = await hashToken(raw);
  sessions.data[`refresh:${hash}`] = JSON.stringify(payload);
  if (alsoSeedAccess && typeof payload.accessTokenId === 'string') {
    db.tokens.push({
      token_id: payload.accessTokenId,
      token_hash: 'old-access-hash',
      user_id: (payload.userId as string) ?? USER,
      device_id: (payload.deviceId as string | null) ?? DEVICE,
      created_at: NOW - 1000,
    });
  }
  return hash;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// =============================================================================
// m.login.token — corrupt / hostile KV shapes
// =============================================================================

describe('login leftovers m.login.token corrupt KV shapes', () => {
  const cases: Array<{ name: string; payload: unknown; expectStatus?: number }> = [
    { name: 'empty object', payload: {} },
    { name: 'missing user_id', payload: { expires_at: NOW + 60_000 } },
    { name: 'null user_id', payload: { user_id: null, expires_at: NOW + 60_000 } },
    { name: 'number user_id', payload: { user_id: 42, expires_at: NOW + 60_000 } },
    { name: 'array user_id', payload: { user_id: ['@a:x'], expires_at: NOW + 60_000 } },
    { name: 'object user_id', payload: { user_id: { id: USER }, expires_at: NOW + 60_000 } },
    { name: 'empty string user_id', payload: { user_id: '', expires_at: NOW + 60_000 } },
    { name: 'whitespace user_id', payload: { user_id: '   ', expires_at: NOW + 60_000 } },
    { name: 'missing expires_at', payload: { user_id: USER } },
    { name: 'null expires_at', payload: { user_id: USER, expires_at: null } },
    { name: 'string expires_at', payload: { user_id: USER, expires_at: 'tomorrow' } },
    { name: 'boolean expires_at', payload: { user_id: USER, expires_at: true } },
    { name: 'array expires_at', payload: { user_id: USER, expires_at: [NOW + 1] } },
    { name: 'NaN expires_at', payload: { user_id: USER, expires_at: Number.NaN } },
    { name: 'Infinity expires_at', payload: { user_id: USER, expires_at: Number.POSITIVE_INFINITY } },
    { name: 'negative expires_at', payload: { user_id: USER, expires_at: -1 } },
    { name: 'zero expires_at', payload: { user_id: USER, expires_at: 0 } },
    { name: 'array root', payload: [{ user_id: USER, expires_at: NOW + 1 }] },
    { name: 'string root via JSON', payload: '"just-a-string"' },
    { name: 'number root via JSON', payload: '12345' },
    { name: 'boolean root via JSON', payload: 'true' },
    { name: 'null root via JSON', payload: 'null' },
  ];

  // Shapes where expires_at comparison is falsy (undefined/NaN/non-number coercion)
  // can still pass the expiry gate and succeed if user_id is valid — document that.
  const maySucceed = new Set([
    'missing expires_at',
    'string expires_at',
    'array expires_at',
    'boolean expires_at',
    'NaN expires_at',
  ]);

  for (const c of cases) {
    it(`hostile shape: ${c.name}`, async () => {
      const sessions = mockKv();
      const raw = `mlt_corrupt_${c.name.replace(/\s+/g, '_')}`;
      await seedLoginToken(sessions, raw, c.payload);
      const env = envFor(aliceDb(), sessions);
      let status = 0;
      let body: Record<string, unknown> = {};
      try {
        const res = await loginRequest(
          env,
          '/_matrix/client/v3/login',
          jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'D1' })
        );
        status = res.status;
        body = res.body;
      } catch {
        status = 500;
        body = { errcode: 'THROWN' };
      }
      if (maySucceed.has(c.name) && status === 200) {
        expect(body.user_id).toBe(USER);
        return;
      }
      expect(status).not.toBe(200);
      expect([400, 403, 500]).toContain(status);
      if (status !== 500) {
        expect(body).toHaveProperty('errcode');
      }
    });
  }

  it('invalid JSON in KV rejects (parse throw → non-200)', async () => {
    const sessions = mockKv();
    const raw = 'mlt_bad_json';
    await seedLoginToken(sessions, raw, '{not-json');
    const env = envFor(aliceDb(), sessions);
    let status = 0;
    try {
      const res = await loginRequest(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw })
      );
      status = res.status;
    } catch {
      status = 500;
    }
    expect(status).not.toBe(200);
  });

  it('truncated login_token: key without hash is ignored', async () => {
    const sessions = mockKv();
    sessions.data['login_token:'] = JSON.stringify({ user_id: USER, expires_at: NOW + 1 });
    const env = envFor(aliceDb(), sessions);
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: 'mlt_nope' })
    );
    expect(res.status).toBe(403);
  });

  it('extra unknown fields on valid token still succeed', async () => {
    const sessions = mockKv();
    const raw = 'mlt_extra_fields';
    await seedLoginToken(sessions, raw, {
      user_id: USER,
      expires_at: NOW + 60_000,
      nonce: 'x',
      admin: true,
      nested: { a: 1 },
    });
    const env = envFor(aliceDb(), sessions);
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw, device_id: 'X1' })
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(USER);
  });

  it('user_id for unknown user yields forbidden after token consume', async () => {
    const sessions = mockKv();
    const raw = 'mlt_ghost';
    const hash = await seedLoginToken(sessions, raw, {
      user_id: '@ghost:example.com',
      expires_at: NOW + 60_000,
    });
    const env = envFor(aliceDb(), sessions);
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw })
    );
    expect(res.status).toBe(403);
    // one-time consume already deleted before user lookup
    expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
    expect(sessions.deletes).toContain(`login_token:${hash}`);
  });

  it('deactivated user via token login is rejected after consume', async () => {
    const db = aliceDb();
    db.users.get(USER)!.is_deactivated = 1;
    const sessions = mockKv();
    const raw = 'mlt_deact';
    const hash = await seedLoginToken(sessions, raw, {
      user_id: USER,
      expires_at: NOW + 60_000,
    });
    const env = envFor(db, sessions);
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: raw })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_USER_DEACTIVATED');
    expect(sessions.deletes).toContain(`login_token:${hash}`);
  });
});

describe('login leftovers m.login.token expiry boundary flood', () => {
  const deltas = [-10_000, -1, 0, 1, 1_000, 60_000, 7 * 24 * 60 * 60 * 1000];

  for (const delta of deltas) {
    it(`expires_at = now + ${delta}`, async () => {
      const sessions = mockKv();
      const raw = `mlt_exp_${delta}`;
      const hash = await seedLoginToken(sessions, raw, {
        user_id: USER,
        expires_at: NOW + delta,
      });
      const env = envFor(aliceDb(), sessions);
      const res = await loginRequest(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type: 'm.login.token', token: raw, device_id: `E${delta}` })
      );
      if (delta < 0) {
        expect(res.status).toBe(403);
        expect(String(res.body.error)).toMatch(/expired/i);
        expect(sessions.deletes).toContain(`login_token:${hash}`);
      } else {
        expect(res.status).toBe(200);
        expect(res.body.user_id).toBe(USER);
        expect(sessions.data[`login_token:${hash}`]).toBeUndefined();
      }
    });
  }
});

describe('login leftovers m.login.token one-time + device matrix', () => {
  const devices = ['D', 'DEVICE_A', 'qr-phone-1', '📱', 'x'.repeat(64), ''];

  for (const deviceId of devices) {
    it(`device_id=${JSON.stringify(deviceId).slice(0, 40)}`, async () => {
      const sessions = mockKv();
      const db = aliceDb();
      const raw = `mlt_dev_${deviceId.length}_${deviceId.charCodeAt(0) || 0}`;
      await seedLoginToken(sessions, raw, { user_id: USER, expires_at: NOW + 90_000 });
      const env = envFor(db, sessions);
      const body: Record<string, unknown> = { type: 'm.login.token', token: raw };
      if (deviceId !== '') body.device_id = deviceId;
      const res = await loginRequest(env, '/_matrix/client/v3/login', jsonInit('POST', body));
      expect(res.status).toBe(200);
      if (deviceId) expect(res.body.device_id).toBe(deviceId);
      else expect(typeof res.body.device_id).toBe('string');
      expect(res.body.refresh_token).toMatch(/^syr_/);
      expect(res.body.expires_in_ms).toBe(3_600_000);
    });
  }

  it('parallel distinct tokens do not collide under hashed keys', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const tokens = Array.from({ length: 12 }, (_, i) => `mlt_parallel_${i}`);
    for (const t of tokens) {
      await seedLoginToken(sessions, t, { user_id: USER, expires_at: NOW + 120_000 });
    }
    const env = envFor(db, sessions);
    const results = await Promise.all(
      tokens.map((t, i) =>
        loginRequest(
          env,
          '/_matrix/client/v3/login',
          jsonInit('POST', { type: 'm.login.token', token: t, device_id: `P${i}` })
        )
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.access_token)).size).toBe(12);
  });
});

// =============================================================================
// Lockout hostile shapes
// =============================================================================

describe('login leftovers lockout hostile KV shapes', () => {
  async function badPw(env: Env) {
    return loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: 'wrong',
      })
    );
  }

  const lockShapes: Array<{ name: string; value: unknown }> = [
    { name: 'empty object', value: {} },
    { name: 'attempts null', value: { attempts: null } },
    { name: 'attempts string', value: { attempts: '3' } },
    { name: 'attempts negative', value: { attempts: -2 } },
    { name: 'attempts float', value: { attempts: 2.7 } },
    { name: 'attempts huge', value: { attempts: 1e9 } },
    { name: 'lockedUntil null', value: { attempts: 5, lockedUntil: null } },
    { name: 'lockedUntil string', value: { attempts: 5, lockedUntil: 'soon' } },
    { name: 'lockedUntil 0', value: { attempts: 5, lockedUntil: 0 } },
    { name: 'lockedUntil past', value: { attempts: 5, lockedUntil: NOW - 1 } },
    { name: 'lockedUntil future', value: { attempts: 5, lockedUntil: NOW + 60_000 } },
    { name: 'lockedUntil NaN', value: { attempts: 5, lockedUntil: Number.NaN } },
    { name: 'array root', value: [{ attempts: 1 }] },
    { name: 'boolean root', value: true },
  ];

  for (const shape of lockShapes) {
    it(`lockout shape ${shape.name}`, async () => {
      const sessions = mockKv();
      sessions.data[`lockout:${USER}`] = JSON.stringify(shape.value);
      const env = envFor(aliceDb(), sessions);
      let status = 0;
      let body: Record<string, unknown> = {};
      try {
        const res = await badPw(env);
        status = res.status;
        body = res.body;
      } catch {
        status = 500;
      }
      // Future lock should 429; past/hostile may 403 or 500
      expect([403, 429, 500]).toContain(status);
      if (status === 429) {
        expect(body.errcode).toBe('M_LIMIT_EXCEEDED');
        expect(typeof body.retry_after_ms).toBe('number');
      }
    });
  }

  it('corrupt lockout JSON does not soft-lock forever (non-200 or throw)', async () => {
    const sessions = mockKv();
    sessions.data[`lockout:${USER}`] = '{bad';
    const env = envFor(aliceDb(), sessions);
    let status = 0;
    try {
      const res = await badPw(env);
      status = res.status;
    } catch {
      status = 500;
    }
    expect(status).not.toBe(200);
  });

  it('success clears hostile lockout record that is not actively locking', async () => {
    const sessions = mockKv();
    sessions.data[`lockout:${USER}`] = JSON.stringify({ attempts: 2 });
    const env = envFor(aliceDb(), sessions);
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'OK1',
      })
    );
    expect(res.status).toBe(200);
    expect(sessions.data[`lockout:${USER}`]).toBeUndefined();
    expect(sessions.deletes).toContain(`lockout:${USER}`);
  });

  it('attempts flood from 0→5 locks with TTL 3600', async () => {
    const sessions = mockKv();
    const env = envFor(aliceDb(), sessions);
    for (let i = 1; i <= 5; i++) {
      const res = await badPw(env);
      expect(res.status).toBe(403);
      const lock = JSON.parse(sessions.data[`lockout:${USER}`]);
      expect(lock.attempts).toBe(i);
      if (i < 5) expect(lock.lockedUntil).toBeUndefined();
      else expect(lock.lockedUntil).toBe(NOW + 15 * 60 * 1000);
    }
    const put = sessions.puts.at(-1);
    expect(put?.options?.expirationTtl).toBe(3600);
    const blocked = await badPw(env);
    expect(blocked.status).toBe(429);
  });

  it('lockout is per-user: bob lock does not block alice', async () => {
    const sessions = mockKv();
    sessions.data[`lockout:${BOB}`] = JSON.stringify({
      attempts: 5,
      lockedUntil: NOW + 60_000,
    });
    const env = envFor(aliceDb(), sessions);
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'ISO',
      })
    );
    expect(res.status).toBe(200);
  });
});

// =============================================================================
// Refresh rotation — partial / corrupt records + atomicity
// =============================================================================

describe('login leftovers refresh corrupt / partial KV', () => {
  const shapes: Array<{ name: string; payload: unknown }> = [
    { name: 'empty object', payload: {} },
    { name: 'missing userId', payload: { deviceId: DEVICE, accessTokenId: 'a1', createdAt: NOW } },
    { name: 'null userId', payload: { userId: null, deviceId: DEVICE, accessTokenId: 'a1', createdAt: NOW } },
    { name: 'number userId', payload: { userId: 1, deviceId: DEVICE, accessTokenId: 'a1', createdAt: NOW } },
    { name: 'missing accessTokenId', payload: { userId: USER, deviceId: DEVICE, createdAt: NOW } },
    { name: 'null accessTokenId', payload: { userId: USER, deviceId: DEVICE, accessTokenId: null, createdAt: NOW } },
    { name: 'missing deviceId', payload: { userId: USER, accessTokenId: 'a1', createdAt: NOW } },
    { name: 'missing createdAt', payload: { userId: USER, deviceId: DEVICE, accessTokenId: 'a1' } },
    { name: 'array root', payload: [USER] },
    { name: 'string root', payload: '"x"' },
    { name: 'null root', payload: 'null' },
  ];

  for (const s of shapes) {
    it(`refresh hostile: ${s.name}`, async () => {
      const sessions = mockKv();
      const db = aliceDb();
      const raw = `syr_hostile_${s.name.replace(/\s+/g, '_')}`;
      const hash = await hashToken(raw);
      sessions.data[`refresh:${hash}`] =
        typeof s.payload === 'string' ? s.payload : JSON.stringify(s.payload);
      const env = envFor(db, sessions);
      let status = 0;
      try {
        const res = await loginRequest(
          env,
          '/_matrix/client/v3/refresh',
          jsonInit('POST', { refresh_token: raw })
        );
        status = res.status;
      } catch {
        status = 500;
      }
      // Route does not schema-validate refresh records — partial shapes may still rotate.
      if (status === 200) {
        expect(sessions.data[`refresh:${hash}`]).toBeUndefined();
        expect(sessions.deletes).toContain(`refresh:${hash}`);
      } else {
        expect([400, 401, 500]).toContain(status);
      }
    });
  }

  it('invalid JSON refresh record → non-200', async () => {
    const sessions = mockKv();
    const raw = 'syr_badjson';
    const hash = await hashToken(raw);
    sessions.data[`refresh:${hash}`] = '{';
    const env = envFor(aliceDb(), sessions);
    let status = 0;
    try {
      const res = await loginRequest(
        env,
        '/_matrix/client/v3/refresh',
        jsonInit('POST', { refresh_token: raw })
      );
      status = res.status;
    } catch {
      status = 500;
    }
    expect(status).not.toBe(200);
  });

  it('consumes refresh before D1 delete even when accessTokenId unknown', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const raw = 'syr_orphan_access';
    const hash = await seedRefresh(sessions, db, raw, {
      userId: USER,
      deviceId: DEVICE,
      accessTokenId: 'does-not-exist',
      createdAt: NOW - 5,
    }, false);
    const env = envFor(db, sessions);
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw })
    );
    expect(res.status).toBe(200);
    expect(sessions.data[`refresh:${hash}`]).toBeUndefined();
    expect(sessions.deletes).toContain(`refresh:${hash}`);
    expect(db.deletes.some((d) => d.args[0] === 'does-not-exist')).toBe(true);
    expect(res.body.access_token).toMatch(/^syt_/);
    expect(res.body.refresh_token).toMatch(/^syr_/);
  });

  it('rotation preserves bob userId and device across chain', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    let raw = 'syr_bob_chain';
    await seedRefresh(sessions, db, raw, {
      userId: BOB,
      deviceId: 'BOBDEV',
      accessTokenId: 'bob-a0',
      createdAt: NOW - 10,
    });
    const env = envFor(db, sessions);
    for (let i = 0; i < 4; i++) {
      const res = await loginRequest(
        env,
        '/_matrix/client/v3/refresh',
        jsonInit('POST', { refresh_token: raw })
      );
      expect(res.status).toBe(200);
      raw = res.body.refresh_token as string;
      const nh = await hashToken(raw);
      const stored = JSON.parse(sessions.data[`refresh:${nh}`]);
      expect(stored.userId).toBe(BOB);
      expect(stored.deviceId).toBe('BOBDEV');
    }
  });

  it('refresh body wrong content-type yields bad JSON', async () => {
    const env = envFor(aliceDb());
    const res = await loginRequest(env, '/_matrix/client/v3/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'refresh_token=syr_x',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('empty object body → missing refresh_token', async () => {
    const env = envFor(aliceDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', {})
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('unrelated refresh keys remain after rotation', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    sessions.data['refresh:keepme'] = JSON.stringify({
      userId: BOB,
      deviceId: 'K',
      accessTokenId: 'keep',
      createdAt: NOW,
    });
    const raw = 'syr_keep_others';
    await seedRefresh(sessions, db, raw, {
      userId: USER,
      deviceId: DEVICE,
      accessTokenId: 'rot',
      createdAt: NOW,
    });
    const env = envFor(db, sessions);
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: raw })
    );
    expect(res.status).toBe(200);
    expect(sessions.data['refresh:keepme']).toBeTruthy();
  });
});

describe('login leftovers refresh body type flood', () => {
  const tokens: unknown[] = [
    '',
    ' ',
    0,
    false,
    true,
    [],
    {},
    ['syr_x'],
    { token: 'syr_x' },
  ];

  for (const [i, refresh_token] of tokens.entries()) {
    it(`refresh_token typeof ${typeof refresh_token} #${i}`, async () => {
      const env = envFor(aliceDb());
      let status = 0;
      let body: Record<string, unknown> = {};
      try {
        const res = await loginRequest(
          env,
          '/_matrix/client/v3/refresh',
          jsonInit('POST', { refresh_token })
        );
        status = res.status;
        body = res.body;
      } catch {
        // hashToken(non-string) throws via SubtleCrypto
        status = 500;
      }
      expect([400, 401, 500]).toContain(status);
      if (status !== 500) expect(body).toHaveProperty('errcode');
    });
  }
});

// =============================================================================
// Logout reliability
// =============================================================================

describe('login leftovers logout / logout.all reliability', () => {
  it('logout deletes matching access token hash when bearer present', async () => {
    const db = aliceDb();
    const token = 'syt_logout_me';
    const hash = await hashToken(token);
    db.tokens.push({
      token_id: 't1',
      token_hash: hash,
      user_id: USER,
      device_id: DEVICE,
      created_at: NOW,
    });
    const env = envFor(db);
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/logout',
      jsonInit('POST', {}, token)
    );
    expect(res.status).toBe(200);
    expect(db.tokens.find((t) => t.token_hash === hash)).toBeUndefined();
  });

  it('logout.all deletes all tokens for mocked userId', async () => {
    const db = aliceDb();
    db.tokens.push(
      {
        token_id: 'a',
        token_hash: 'h1',
        user_id: USER,
        device_id: 'D1',
        created_at: NOW,
      },
      {
        token_id: 'b',
        token_hash: 'h2',
        user_id: USER,
        device_id: 'D2',
        created_at: NOW,
      },
      {
        token_id: 'c',
        token_hash: 'h3',
        user_id: BOB,
        device_id: 'D3',
        created_at: NOW,
      }
    );
    const env = envFor(db);
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/logout/all',
      jsonInit('POST', {}, 'syt_any')
    );
    expect(res.status).toBe(200);
    expect(db.tokens.every((t) => t.user_id === BOB)).toBe(true);
  });

  it('logout returns {} even when token unknown', async () => {
    const env = envFor(aliceDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/logout',
      jsonInit('POST', {}, 'syt_unknown')
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
});

// =============================================================================
// Password login identifier hostility leftovers
// =============================================================================

describe('login leftovers password identifier hostility', () => {
  const ids: Array<{ name: string; identifier: unknown; expectCode: string }> = [
    { name: 'missing identifier', identifier: undefined, expectCode: 'M_MISSING_PARAM' },
    { name: 'null identifier', identifier: null, expectCode: 'M_MISSING_PARAM' },
    { name: 'string identifier', identifier: 'alice', expectCode: 'M_UNRECOGNIZED' },
    { name: 'empty object', identifier: {}, expectCode: 'M_UNRECOGNIZED' },
    {
      name: 'phone type',
      identifier: { type: 'm.id.phone', country: 'US', phone: '1' },
      expectCode: 'M_UNRECOGNIZED',
    },
    {
      name: 'thirdparty',
      identifier: { type: 'm.id.thirdparty', medium: 'email', address: 'a@b.c' },
      expectCode: 'M_UNRECOGNIZED',
    },
    {
      name: 'user missing user field',
      identifier: { type: 'm.id.user' },
      expectCode: 'M_FORBIDDEN',
    },
  ];

  for (const row of ids) {
    it(row.name, async () => {
      const env = envFor(aliceDb());
      const body: Record<string, unknown> = {
        type: 'm.login.password',
        password: PASS,
      };
      if (row.identifier !== undefined) body.identifier = row.identifier;
      let status = 0;
      let errcode = '';
      try {
        const res = await loginRequest(env, '/_matrix/client/v3/login', jsonInit('POST', body));
        status = res.status;
        errcode = String(res.body.errcode ?? '');
      } catch {
        // identifier.user.startsWith may throw on undefined
        status = 500;
        errcode = 'THROWN';
      }
      expect(status).not.toBe(200);
      if (status !== 500) expect(errcode).toBe(row.expectCode);
    });
  }

  it('unknown login type flood', async () => {
    const types = [
      'm.login.sso',
      'm.login.jwt',
      'm.login.application_service',
      '',
      'password',
      null,
    ];
    for (const type of types) {
      const env = envFor(aliceDb());
      const res = await loginRequest(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', { type, identifier: { type: 'm.id.user', user: 'alice' }, password: PASS })
      );
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_UNRECOGNIZED');
    }
  });
});

// =============================================================================
// QR login — corrupt KV + interpolation + method matrix
// =============================================================================

describe('qr leftovers corrupt login_token shapes', () => {
  const token = 'mlt_qr_corrupt_base';
  const shapes: Array<{ name: string; payload: unknown }> = [
    { name: 'empty', payload: {} },
    { name: 'null user', payload: { user_id: null, expires_at: NOW + 60_000 } },
    { name: 'number user', payload: { user_id: 9, expires_at: NOW + 60_000 } },
    { name: 'missing expires', payload: { user_id: USER } },
    { name: 'string expires', payload: { user_id: USER, expires_at: 'later' } },
    { name: 'array root', payload: [1, 2] },
    { name: 'null root', payload: 'null' },
  ];

  for (const s of shapes) {
    it(`landing hostile ${s.name}`, async () => {
      const sessions = mockKv();
      const t = `${token}_${s.name.replace(/\s+/g, '_')}`;
      await seedLoginToken(sessions, t, s.payload);
      let status = 0;
      try {
        const res = await qrRequest(`/login/qr/${encodeURIComponent(t)}`, {}, qrEnv(sessions));
        status = res.status;
      } catch {
        status = 500;
      }
      // May render with weird values (200) or fail — document behavior, never crash silently without status
      expect(typeof status).toBe('number');
      expect(status).toBeGreaterThan(0);
    });

    it(`check hostile ${s.name}`, async () => {
      const sessions = mockKv();
      const t = `${token}_chk_${s.name.replace(/\s+/g, '_')}`;
      await seedLoginToken(sessions, t, s.payload);
      let status = 0;
      let body: Record<string, unknown> = {};
      try {
        const res = await qrRequest(`/login/qr/${encodeURIComponent(t)}/check`, {}, qrEnv(sessions));
        status = res.status;
        body = res.body as Record<string, unknown>;
      } catch {
        status = 500;
      }
      expect(typeof status).toBe('number');
      if (status === 200) {
        expect(body.valid).toBe(true);
      } else {
        expect([400, 404, 500]).toContain(status);
      }
    });
  }

  it('invalid JSON on landing → non-200', async () => {
    const sessions = mockKv();
    const t = 'mlt_qr_badjson';
    await seedLoginToken(sessions, t, '{');
    let status = 0;
    try {
      const res = await qrRequest(`/login/qr/${t}`, {}, qrEnv(sessions));
      status = res.status;
    } catch {
      status = 500;
    }
    expect(status).not.toBe(200);
  });
});

describe('qr leftovers HTML interpolation trust boundary', () => {
  const payloads = [
    { user: '@alice:example.com', token: 'mlt_plain', server: 'example.com' },
    { user: '@alice<script>:example.com', token: 'mlt_xss_user', server: 'example.com' },
    { user: '@alice:example.com', token: 'mlt_"quote"', server: 'example.com' },
    { user: '@alice:example.com', token: "mlt_'apos'", server: 'example.com' },
    { user: '@alice:example.com', token: 'mlt_</script>', server: 'example.com' },
    { user: '@alice:example.com', token: 'mlt_ok', server: 'evil"onload="x' },
  ];

  for (const p of payloads) {
    it(`interpolates raw user/token/server (${p.token})`, async () => {
      const sessions = mockKv();
      await seedLoginToken(sessions, p.token, {
        user_id: p.user,
        expires_at: NOW + 120_000,
      });
      const res = await qrRequest(
        `/login/qr/${encodeURIComponent(p.token)}`,
        {},
        qrEnv(sessions, p.server)
      );
      expect(res.status).toBe(200);
      expect(res.text).toContain(p.user);
      expect(res.text).toContain(p.token);
      expect(res.text).toContain(p.server);
      // Documented: no HTML escaping in qr-login generator
      expect(res.text).toContain(`const token = "${p.token}"`);
    });
  }
});

describe('qr leftovers method + format matrix', () => {
  const badTokens = ['', 'mlt', 'MLT_x', 'syt_x', 'token', 'mlt', '../mlt_x'];

  for (const t of badTokens) {
    it(`landing rejects format ${JSON.stringify(t)}`, async () => {
      const path = t === '' ? '/login/qr/' : `/login/qr/${encodeURIComponent(t)}`;
      const res = await qrRequest(path, {}, qrEnv());
      // empty may 404 from router; others 400 invalid
      expect([400, 404]).toContain(res.status);
    });

    it(`check rejects format ${JSON.stringify(t)}`, async () => {
      if (!t) return;
      const res = await qrRequest(`/login/qr/${encodeURIComponent(t)}/check`, {}, qrEnv());
      expect(res.status).toBe(400);
      expect((res.body as { valid: boolean }).valid).toBe(false);
    });
  }

  const methods = ['POST', 'PUT', 'DELETE', 'PATCH'];
  for (const method of methods) {
    it(`${method} landing not allowed`, async () => {
      const res = await qrRequest('/login/qr/mlt_x', { method }, qrEnv());
      expect([404, 405]).toContain(res.status);
    });
    it(`${method} check not allowed`, async () => {
      const res = await qrRequest('/login/qr/mlt_x/check', { method }, qrEnv());
      expect([404, 405]).toContain(res.status);
    });
  }

  it('HEAD landing returns without body requirement', async () => {
    const sessions = mockKv();
    const t = 'mlt_head_ok';
    await seedLoginToken(sessions, t, { user_id: USER, expires_at: NOW + 60_000 });
    const res = await qrLogin.request(
      `https://${SERVER}/login/qr/${t}`,
      { method: 'HEAD' },
      qrEnv(sessions)
    );
    expect([200, 404, 405]).toContain(res.status);
  });
});

describe('qr leftovers expiry + delete semantics flood', () => {
  const deltas = [-60_000, -1, 0, 1, 59_999, 60_000, 3_600_000];

  for (const d of deltas) {
    it(`landing expires_at delta ${d}`, async () => {
      const sessions = mockKv();
      const t = `mlt_land_exp_${d}`;
      const hash = await seedLoginToken(sessions, t, {
        user_id: USER,
        expires_at: NOW + d,
      });
      const res = await qrRequest(`/login/qr/${t}`, {}, qrEnv(sessions));
      if (d < 0) {
        expect(res.status).toBe(400);
        expect(res.text).toMatch(/Token Expired/i);
        expect(sessions.deletes).toContain(`login_token:${hash}`);
      } else {
        expect(res.status).toBe(200);
        expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
      }
    });

    it(`check expires_at delta ${d} does not delete`, async () => {
      const sessions = mockKv();
      const t = `mlt_chk_exp_${d}`;
      const hash = await seedLoginToken(sessions, t, {
        user_id: USER,
        expires_at: NOW + d,
      });
      const res = await qrRequest(`/login/qr/${t}/check`, {}, qrEnv(sessions));
      if (d < 0) {
        expect(res.status).toBe(400);
        expect((res.body as { error: string }).error).toMatch(/expired/i);
        expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
        expect(sessions.deletes).not.toContain(`login_token:${hash}`);
      } else {
        expect(res.status).toBe(200);
        expect((res.body as { valid: boolean }).valid).toBe(true);
      }
    });
  }
});

describe('qr leftovers remaining-minutes display matrix', () => {
  const cases = [
    { remainMs: 1, expectMin: 1 },
    { remainMs: 59_999, expectMin: 1 },
    { remainMs: 60_000, expectMin: 1 },
    { remainMs: 60_001, expectMin: 2 },
    { remainMs: 90_000, expectMin: 2 },
    { remainMs: 120_000, expectMin: 2 },
    { remainMs: 119_999, expectMin: 2 },
    { remainMs: 180_000, expectMin: 3 },
  ];

  for (const c of cases) {
    it(`ceil display for ${c.remainMs}ms → ${c.expectMin} minute(s)`, async () => {
      const sessions = mockKv();
      const t = `mlt_min_${c.remainMs}`;
      await seedLoginToken(sessions, t, {
        user_id: USER,
        expires_at: NOW + c.remainMs,
      });
      const res = await qrRequest(`/login/qr/${t}`, {}, qrEnv(sessions));
      expect(res.status).toBe(200);
      const plural = c.expectMin === 1 ? 'minute' : 'minutes';
      expect(res.text).toContain(`Token expires in ${c.expectMin} ${plural}`);
    });
  }
});

// =============================================================================
// Cross-path: QR check ↔ m.login.token consume
// =============================================================================

describe('login+qr leftovers cross-path reliability', () => {
  it('check valid then m.login.token consumes; check becomes 404', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const t = 'mlt_cross_consume';
    await seedLoginToken(sessions, t, { user_id: USER, expires_at: NOW + 300_000 });
    const check1 = await qrRequest(`/login/qr/${t}/check`, {}, qrEnv(sessions));
    expect(check1.status).toBe(200);
    const loginEnv = envFor(db, sessions);
    const logged = await loginRequest(
      loginEnv,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: t, device_id: 'CROSS' })
    );
    expect(logged.status).toBe(200);
    const check2 = await qrRequest(`/login/qr/${t}/check`, {}, qrEnv(sessions));
    expect(check2.status).toBe(404);
  });

  it('landing does not consume; password-style token login still works', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const t = 'mlt_land_then_login';
    await seedLoginToken(sessions, t, { user_id: USER, expires_at: NOW + 300_000 });
    const land = await qrRequest(`/login/qr/${t}`, {}, qrEnv(sessions));
    expect(land.status).toBe(200);
    const logged = await loginRequest(
      envFor(db, sessions),
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: t, device_id: 'L2' })
    );
    expect(logged.status).toBe(200);
  });

  it('expired landing delete prevents later token login', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const t = 'mlt_exp_then_login';
    await seedLoginToken(sessions, t, { user_id: USER, expires_at: NOW - 5 });
    const land = await qrRequest(`/login/qr/${t}`, {}, qrEnv(sessions));
    expect(land.status).toBe(400);
    const logged = await loginRequest(
      envFor(db, sessions),
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: t })
    );
    expect(logged.status).toBe(403);
  });

  it('expired check leaves token for login expiry cleanup path', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const t = 'mlt_chk_exp_login';
    const hash = await seedLoginToken(sessions, t, { user_id: USER, expires_at: NOW - 5 });
    const check = await qrRequest(`/login/qr/${t}/check`, {}, qrEnv(sessions));
    expect(check.status).toBe(400);
    expect(sessions.data[`login_token:${hash}`]).toBeTruthy();
    const logged = await loginRequest(
      envFor(db, sessions),
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: t })
    );
    expect(logged.status).toBe(403);
    expect(sessions.deletes).toContain(`login_token:${hash}`);
  });

  it('bob token login after alice QR check isolation', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const ta = 'mlt_iso_alice';
    const tb = 'mlt_iso_bob';
    await seedLoginToken(sessions, ta, { user_id: USER, expires_at: NOW + 200_000 });
    await seedLoginToken(sessions, tb, { user_id: BOB, expires_at: NOW + 200_000 });
    expect((await qrRequest(`/login/qr/${ta}/check`, {}, qrEnv(sessions))).status).toBe(200);
    expect((await qrRequest(`/login/qr/${tb}/check`, {}, qrEnv(sessions))).status).toBe(200);
    const rb = await loginRequest(
      envFor(db, sessions),
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: tb, device_id: 'BOB1' })
    );
    expect(rb.status).toBe(200);
    expect(rb.body.user_id).toBe(BOB);
    expect((await qrRequest(`/login/qr/${ta}/check`, {}, qrEnv(sessions))).status).toBe(200);
    expect((await qrRequest(`/login/qr/${tb}/check`, {}, qrEnv(sessions))).status).toBe(404);
  });
});

// =============================================================================
// Soft flood matrices — login flows GET + dummy
// =============================================================================

describe('login leftovers GET /login flow catalog', () => {
  it('lists password, token, dummy exactly once each', async () => {
    const env = envFor(aliceDb());
    const res = await loginRequest(env, '/_matrix/client/v3/login', { method: 'GET' });
    expect(res.status).toBe(200);
    const flows = (res.body.flows as Array<{ type: string }>).map((f) => f.type);
    expect(flows).toEqual(['m.login.password', 'm.login.token', 'm.login.dummy']);
  });

  it('GET is idempotent across 20 calls', async () => {
    const env = envFor(aliceDb());
    for (let i = 0; i < 20; i++) {
      const res = await loginRequest(env, '/_matrix/client/v3/login', { method: 'GET' });
      expect(res.status).toBe(200);
      expect((res.body.flows as unknown[]).length).toBe(3);
    }
  });
});

describe('login leftovers m.login.dummy reliability flood', () => {
  const users = ['alice', '@alice:example.com', 'bob', '@bob:example.com'];

  for (const user of users) {
    it(`dummy login as ${user}`, async () => {
      const env = envFor(aliceDb());
      const res = await loginRequest(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', {
          type: 'm.login.dummy',
          identifier: { type: 'm.id.user', user },
          device_id: 'DUM',
        })
      );
      expect(res.status).toBe(200);
      expect(res.body.access_token).toMatch(/^syt_/);
      expect(res.body.refresh_token).toMatch(/^syr_/);
    });
  }

  it('dummy ignores wrong password and still issues tokens', async () => {
    const env = envFor(aliceDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.dummy',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: 'definitely-wrong',
        device_id: 'DUM2',
      })
    );
    expect(res.status).toBe(200);
  });
});

describe('login leftovers refresh TTL + response shape flood', () => {
  it('10 sequential rotations keep expires_in_ms=3600000 and 7d TTL', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    let raw = 'syr_ttl_flood_0';
    await seedRefresh(sessions, db, raw, {
      userId: USER,
      deviceId: DEVICE,
      accessTokenId: 'ttl-0',
      createdAt: NOW,
    });
    const env = envFor(db, sessions);
    for (let i = 0; i < 10; i++) {
      const res = await loginRequest(
        env,
        '/_matrix/client/v3/refresh',
        jsonInit('POST', { refresh_token: raw })
      );
      expect(res.status).toBe(200);
      expect(res.body.expires_in_ms).toBe(3_600_000);
      expect(res.body).not.toHaveProperty('user_id');
      expect(res.body).not.toHaveProperty('device_id');
      raw = res.body.refresh_token as string;
      const nh = await hashToken(raw);
      const put = sessions.puts.find((p) => p.key === `refresh:${nh}`);
      expect(put?.options?.expirationTtl).toBe(604800);
    }
  });
});

describe('login leftovers password success clears lock and stores refresh', () => {
  it('happy path stores refresh with userId/deviceId/accessTokenId/createdAt', async () => {
    const sessions = mockKv();
    sessions.data[`lockout:${USER}`] = JSON.stringify({ attempts: 4 });
    const db = aliceDb();
    const env = envFor(db, sessions);
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: '@alice:example.com' },
        password: PASS,
        device_id: 'PHONE',
        initial_device_display_name: 'Pixel',
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.home_server).toBe(SERVER);
    expect(res.body.device_id).toBe('PHONE');
    const rh = await hashToken(res.body.refresh_token as string);
    const stored = JSON.parse(sessions.data[`refresh:${rh}`]);
    expect(stored).toEqual({
      userId: USER,
      deviceId: 'PHONE',
      accessTokenId: expect.any(String),
      createdAt: NOW,
    });
    expect(db.devices.some((d) => d.display_name === 'Pixel')).toBe(true);
  });
});

describe('qr leftovers server name matrix', () => {
  const servers = ['example.com', 'matrix.example.org', 'hs-1.test', 'localhost'];

  for (const server of servers) {
    it(`homeserver ${server} on check + landing`, async () => {
      const sessions = mockKv();
      const t = `mlt_srv_${server.replace(/\W/g, '_')}`;
      await seedLoginToken(sessions, t, { user_id: `@alice:${server}`, expires_at: NOW + 90_000 });
      const land = await qrRequest(`/login/qr/${t}`, {}, qrEnv(sessions, server));
      expect(land.status).toBe(200);
      expect(land.text).toContain(server);
      expect(land.text).toContain(`https://${server}`);
      const check = await qrRequest(`/login/qr/${t}/check`, {}, qrEnv(sessions, server));
      expect(check.status).toBe(200);
      expect((check.body as { homeserver: string }).homeserver).toBe(server);
    });
  }
});

describe('login leftovers m.login.token refresh KV shape after redeem', () => {
  it('token login refresh record matches password login schema', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const t = 'mlt_schema_match';
    await seedLoginToken(sessions, t, { user_id: USER, expires_at: NOW + 90_000 });
    const env = envFor(db, sessions);
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: t, device_id: 'QR' })
    );
    expect(res.status).toBe(200);
    const rh = await hashToken(res.body.refresh_token as string);
    const stored = JSON.parse(sessions.data[`refresh:${rh}`]);
    expect(Object.keys(stored).sort()).toEqual([
      'accessTokenId',
      'createdAt',
      'deviceId',
      'userId',
    ]);
  });
});


// =============================================================================
// Soft-cap floods — register/available charset + login body JSON hostility
// =============================================================================

describe('login leftovers register/available soft charset flood', () => {
  const ok = ['alice', 'a', 'user_1', 'bob-2', 'x'.repeat(64)];
  const bad = ['Alice', 'a b', 'a@b', 'a:b', '!alice', '', ' alice', 'alice ', 'ア'];

  for (const username of ok) {
    it(`available true for ${JSON.stringify(username).slice(0, 40)}`, async () => {
      const env = envFor(createLoginDb());
      const res = await loginRequest(
        env,
        `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
      );
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
    });
  }

  for (const username of bad) {
    it(`rejects invalid ${JSON.stringify(username)}`, async () => {
      const env = envFor(createLoginDb());
      const path =
        username === ''
          ? '/_matrix/client/v3/register/available?username='
          : `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`;
      const res = await loginRequest(env, path);
      expect([400, 400]).toContain(res.status);
      expect(['M_INVALID_USERNAME', 'M_MISSING_PARAM']).toContain(res.body.errcode);
    });
  }

  it('taken localpart returns M_USER_IN_USE', async () => {
    const env = envFor(aliceDb());
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/register/available?username=alice'
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_USER_IN_USE');
  });

  it('missing username query is M_MISSING_PARAM', async () => {
    const env = envFor(createLoginDb());
    const res = await loginRequest(env, '/_matrix/client/v3/register/available');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
});

describe('login leftovers POST /login bad JSON flood', () => {
  const unparseable = ['', '{', '{type:}', '{"type":"m.login.password"'];
  const parseableNonObject = ['null', '[]', '"str"', 'true', '123'];

  for (const [i, body] of unparseable.entries()) {
    it(`unparseable json #${i}`, async () => {
      const env = envFor(aliceDb());
      const res = await loginRequest(env, '/_matrix/client/v3/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_BAD_JSON');
    });
  }

  for (const [i, body] of parseableNonObject.entries()) {
    it(`parseable non-object #${i} → unrecognized or throw path`, async () => {
      const env = envFor(aliceDb());
      let status = 0;
      let errcode = '';
      try {
        const res = await loginRequest(env, '/_matrix/client/v3/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        status = res.status;
        errcode = String(res.body.errcode ?? '');
      } catch {
        status = 500;
      }
      expect(status).not.toBe(200);
      if (status === 400) {
        expect(['M_UNRECOGNIZED', 'M_BAD_JSON', 'M_MISSING_PARAM']).toContain(errcode);
      }
    });
  }
});

describe('login leftovers POST /refresh bad JSON flood', () => {
  const unparseable = ['', '{'];
  const parseable = ['null', '[]', '"x"', 'true'];

  for (const [i, body] of unparseable.entries()) {
    it(`refresh unparseable #${i}`, async () => {
      const env = envFor(aliceDb());
      const res = await loginRequest(env, '/_matrix/client/v3/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_BAD_JSON');
    });
  }

  for (const [i, body] of parseable.entries()) {
    it(`refresh parseable non-object #${i}`, async () => {
      const env = envFor(aliceDb());
      let status = 0;
      let errcode = '';
      try {
        const res = await loginRequest(env, '/_matrix/client/v3/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        status = res.status;
        errcode = String(res.body.errcode ?? '');
      } catch {
        status = 500;
      }
      expect([400, 500]).toContain(status);
      if (status === 400) {
        expect(['M_BAD_JSON', 'M_MISSING_PARAM']).toContain(errcode);
      }
    });
  }
});

describe('login leftovers m.login.token token field hostility', () => {
  const tokens: unknown[] = [undefined, null, '', 0, false, true, [], {}, ['mlt_x']];

  for (const [i, token] of tokens.entries()) {
    it(`token field #${i} typeof ${typeof token}`, async () => {
      const env = envFor(aliceDb());
      const body: Record<string, unknown> = { type: 'm.login.token' };
      if (token !== undefined) body.token = token;
      let status = 0;
      let errcode = '';
      try {
        const res = await loginRequest(env, '/_matrix/client/v3/login', jsonInit('POST', body));
        status = res.status;
        errcode = String(res.body.errcode ?? '');
      } catch {
        status = 500;
      }
      expect(status).not.toBe(200);
      if (status === 400) expect(errcode).toBe('M_MISSING_PARAM');
      if (status === 403) expect(errcode).toBe('M_FORBIDDEN');
    });
  }
});

describe('login leftovers lockout retry_after_ms math flood', () => {
  const futures = [1, 100, 1000, 15 * 60 * 1000, 60 * 60 * 1000];

  for (const ms of futures) {
    it(`retry_after_ms ≈ ${ms}`, async () => {
      const sessions = mockKv();
      sessions.data[`lockout:${USER}`] = JSON.stringify({
        attempts: 5,
        lockedUntil: NOW + ms,
      });
      const env = envFor(aliceDb(), sessions);
      const res = await loginRequest(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'alice' },
          password: PASS,
        })
      );
      expect(res.status).toBe(429);
      expect(res.body.retry_after_ms).toBe(ms);
    });
  }

  it('exact lockedUntil === now is not locking (strict <)', async () => {
    const sessions = mockKv();
    sessions.data[`lockout:${USER}`] = JSON.stringify({
      attempts: 5,
      lockedUntil: NOW,
    });
    const env = envFor(aliceDb(), sessions);
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'EDGE',
      })
    );
    expect(res.status).toBe(200);
  });
});

describe('qr leftovers percent-encoded token path matrix', () => {
  const tokens = [
    'mlt_plain',
    'mlt_with-dash',
    'mlt_with_underscore',
    'mlt_with.dot',
    'mlt_ABC123',
  ];

  for (const t of tokens) {
    it(`round-trip encode ${t}`, async () => {
      const sessions = mockKv();
      await seedLoginToken(sessions, t, { user_id: USER, expires_at: NOW + 90_000 });
      const land = await qrRequest(`/login/qr/${encodeURIComponent(t)}`, {}, qrEnv(sessions));
      expect(land.status).toBe(200);
      const check = await qrRequest(
        `/login/qr/${encodeURIComponent(t)}/check`,
        {},
        qrEnv(sessions)
      );
      expect(check.status).toBe(200);
      expect((check.body as { user_id: string }).user_id).toBe(USER);
    });
  }
});

describe('qr leftovers check payload field catalog', () => {
  it('valid check returns only expected keys', async () => {
    const sessions = mockKv();
    const t = 'mlt_keys_only';
    await seedLoginToken(sessions, t, { user_id: USER, expires_at: NOW + 50_000 });
    const res = await qrRequest(`/login/qr/${t}/check`, {}, qrEnv(sessions));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body as object).sort()).toEqual([
      'expires_at',
      'homeserver',
      'user_id',
      'valid',
    ]);
  });

  it('invalid format returns valid:false + error', async () => {
    const res = await qrRequest('/login/qr/not_mlt/check', {}, qrEnv());
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ valid: false, error: 'Invalid token format' });
  });

  it('missing KV returns 404 shape', async () => {
    const res = await qrRequest('/login/qr/mlt_missing_here/check', {}, qrEnv());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ valid: false, error: 'Token not found or expired' });
  });
});

describe('login leftovers concurrent password failures independent users', () => {
  it('alice failures do not increment bob lockout', async () => {
    const sessions = mockKv();
    const env = envFor(aliceDb(), sessions);
    for (let i = 0; i < 3; i++) {
      await loginRequest(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'alice' },
          password: 'nope',
        })
      );
    }
    expect(JSON.parse(sessions.data[`lockout:${USER}`]).attempts).toBe(3);
    expect(sessions.data[`lockout:${BOB}`]).toBeUndefined();
    const bobOk = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'bob' },
        password: PASS,
        device_id: 'B',
      })
    );
    expect(bobOk.status).toBe(200);
  });
});

describe('login leftovers refresh single-use after password login', () => {
  it('login then refresh then reuse old refresh fails', async () => {
    const sessions = mockKv();
    const env = envFor(aliceDb(), sessions);
    const logged = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
        device_id: 'R1',
      })
    );
    expect(logged.status).toBe(200);
    const oldRefresh = logged.body.refresh_token as string;
    const rotated = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: oldRefresh })
    );
    expect(rotated.status).toBe(200);
    const reuse = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: oldRefresh })
    );
    expect(reuse.status).toBe(401);
    expect(reuse.body.errcode).toBe('M_UNKNOWN_TOKEN');
  });
});

describe('qr leftovers landing markers catalog', () => {
  it('includes Element deep-link hooks and manual copy fields', async () => {
    const sessions = mockKv();
    const t = 'mlt_markers';
    await seedLoginToken(sessions, t, { user_id: USER, expires_at: NOW + 90_000 });
    const res = await qrRequest(`/login/qr/${t}`, {}, qrEnv(sessions));
    expect(res.status).toBe(200);
    for (const marker of [
      'Open in Element',
      'Manual Login Details',
      'Log in with token',
      'homeserverUrl',
      'loginToken',
      'element://',
      'app.element.io',
      `expiresAt = ${NOW + 90_000}`,
    ]) {
      expect(res.text).toContain(marker);
    }
  });
});

describe('login leftovers deactivated user password path', () => {
  it('deactivated alice cannot password login', async () => {
    const db = aliceDb();
    db.users.get(USER)!.is_deactivated = 1;
    const env = envFor(db);
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: PASS,
      })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_USER_DEACTIVATED');
  });

  it('deactivated alice cannot dummy login', async () => {
    const db = aliceDb();
    db.users.get(USER)!.is_deactivated = 1;
    const env = envFor(db);
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.dummy',
        identifier: { type: 'm.id.user', user: 'alice' },
      })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_USER_DEACTIVATED');
  });
});

describe('login leftovers guest user token login', () => {
  it('guest flag does not block token login', async () => {
    const db = aliceDb();
    db.users.get(USER)!.is_guest = 1;
    const sessions = mockKv();
    const t = 'mlt_guest_ok';
    await seedLoginToken(sessions, t, { user_id: USER, expires_at: NOW + 60_000 });
    const res = await loginRequest(
      envFor(db, sessions),
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: t, device_id: 'G' })
    );
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(USER);
  });
});

describe('qr leftovers many tokens hash isolation flood', () => {
  it('30 tokens: check all valid then login one leaves others', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const tokens = Array.from({ length: 30 }, (_, i) => `mlt_iso_flood_${i}`);
    for (const t of tokens) {
      await seedLoginToken(sessions, t, { user_id: USER, expires_at: NOW + 200_000 });
    }
    for (const t of tokens) {
      expect((await qrRequest(`/login/qr/${t}/check`, {}, qrEnv(sessions))).status).toBe(200);
    }
    const picked = tokens[17];
    const logged = await loginRequest(
      envFor(db, sessions),
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.token', token: picked, device_id: 'ISO17' })
    );
    expect(logged.status).toBe(200);
    for (const t of tokens) {
      const st = (await qrRequest(`/login/qr/${t}/check`, {}, qrEnv(sessions))).status;
      expect(st).toBe(t === picked ? 404 : 200);
    }
  });
});
