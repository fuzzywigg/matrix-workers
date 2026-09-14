/**
 * TOKENMAXX HEAVY leftovers after #283 quinary / tip past #277 — oauth
 * *senary* concurrent-race niches: authorize POST HTML login soft-fails +
 * UIA Missing Session / Session Expired / cancel HTML binds under
 * Promise.all that quaternary (#277) + quinary (#283) never claimed
 * (grep Missing username or password / Invalid username or password /
 * Missing Session / Session Expired / Request Cancelled in
 * *oauth*quaternary* / *oauth*quinary* = 0).
 *
 * Soft/route leftovers bind these sequentially (oauth-api-routes / soft);
 * numbered wave races never asserted exact HTML under sibling success.
 * Senary deepen:
 *   POST authorize `Missing username or password` ∥ 302 success;
 *   `Invalid username or password` (unknown / wrong / deactivated /
 *   null password_hash) ∥ 302; `Unknown Client` wipe fallback ∥ ok;
 *   UIA GET/POST `Missing Session` / `Session Expired` ∥ approval /
 *   Request Approved; cancel `Request Cancelled` ∥ approve;
 *   UIA `Username and password are required.` ∥ approve success.
 *
 * Distinct from #283 oauth quinary (JSON error_description binds),
 * #277 quaternary (code/PKCE/parse/introspect), #268 megaflood.
 * New file. Tests-only. example.com fixtures only. Reversible by delete.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const SERVER = 'example.com';
const USER_ID = `@alice:${SERVER}`;
const BOB_ID = `@bob:${SERVER}`;
const REDIRECT = 'https://element.example.com/callback';
const NOW = 1_730_000_000_000;

vi.mock('../src/utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/crypto')>();
  return {
    ...actual,
    verifyPassword: vi.fn(async (password: string, storedHash: string) => {
      return storedHash === `mockok:${password}`;
    }),
  };
});

import oauth from '../src/api/oauth';

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };
type KvBarrier = { match: (key: string) => boolean; count: number };

async function withBarrier(
  barrier: KvBarrier | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  key: string
) {
  if (!barrier || !barrier.match(key)) return;
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
  opts: {
    putBarrier?: KvBarrier;
    getBarrier?: KvBarrier;
    deleteBarrier?: KvBarrier;
    mutateAfterGets?: { after: number; next: Record<string, string> };
    failGetAfter?: number;
    failPutAfter?: number;
    failDeleteAfter?: number;
  } = {}
) {
  const data: Record<string, string> = { ...initial };
  const puts: KvPut[] = [];
  const gets: string[] = [];
  const deletes: string[] = [];
  const events: string[] = [];
  let putBarrier = opts.putBarrier;
  let getBarrier = opts.getBarrier;
  let deleteBarrier = opts.deleteBarrier;
  const putWaiters = { list: [] as Array<() => void> };
  const getWaiters = { list: [] as Array<() => void> };
  const deleteWaiters = { list: [] as Array<() => void> };
  let putCount = 0;
  let getCount = 0;
  let deleteCount = 0;

  return {
    data,
    puts,
    gets,
    deletes,
    events,
    get putCount() {
      return putCount;
    },
    get getCount() {
      return getCount;
    },
    get deleteCount() {
      return deleteCount;
    },
    get: async (key: string, type?: string) => {
      await withBarrier(getBarrier, getWaiters, () => {
        getBarrier = undefined;
      }, key);
      getCount += 1;
      gets.push(key);
      events.push(`get:${key}`);
      if (opts.failGetAfter !== undefined && getCount > opts.failGetAfter) {
        throw new Error('kv-get-fail');
      }
      const raw = data[key];
      if (opts.mutateAfterGets && getCount === opts.mutateAfterGets.after) {
        for (const k of Object.keys(data)) delete data[k];
        Object.assign(data, opts.mutateAfterGets.next);
        events.push('mutate:after-get');
      }
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
      await withBarrier(putBarrier, putWaiters, () => {
        putBarrier = undefined;
      }, key);
      putCount += 1;
      if (opts.failPutAfter !== undefined && putCount > opts.failPutAfter) {
        throw new Error('kv-put-fail');
      }
      data[key] = value;
      puts.push({ key, value, options });
      events.push(`put:${key}`);
    },
    delete: async (key: string) => {
      await withBarrier(deleteBarrier, deleteWaiters, () => {
        deleteBarrier = undefined;
      }, key);
      deleteCount += 1;
      if (opts.failDeleteAfter !== undefined && deleteCount > opts.failDeleteAfter) {
        throw new Error('kv-delete-fail');
      }
      deletes.push(key);
      delete data[key];
      events.push(`delete:${key}`);
      return undefined;
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  };
}

type RaceKv = ReturnType<typeof mockKv>;

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

type TokenRow = { user_id: string; device_id: string | null; created_at: number };

function userRow(partial: Partial<UserRow> & Pick<UserRow, 'user_id' | 'localpart'>): UserRow {
  return {
    // Allow explicit null display_name (?? would coerce null → localpart)
    display_name: partial.display_name !== undefined ? partial.display_name : partial.localpart,
    avatar_url: partial.avatar_url !== undefined ? partial.avatar_url : null,
    password_hash: partial.password_hash ?? null,
    is_guest: partial.is_guest ?? 0,
    is_deactivated: partial.is_deactivated ?? 0,
    admin: partial.admin ?? 0,
    created_at: partial.created_at ?? NOW,
    user_id: partial.user_id,
    localpart: partial.localpart,
  };
}

function createOAuthDb(opts: {
  users?: Map<string, UserRow>;
  tokensByHash?: Map<string, TokenRow>;
  idpLinkUserIds?: string[];
} = {}) {
  const users = opts.users ?? new Map<string, UserRow>();
  const tokensByHash = opts.tokensByHash ?? new Map<string, TokenRow>();
  const idpLinkUserIds = opts.idpLinkUserIds ?? [];
  const inserts: Array<{ sql: string; args: unknown[] }> = [];
  const deletes: Array<{ sql: string; args: unknown[] }> = [];
  const devices: Array<{ user_id: string; device_id: string; display_name: string | null }> = [];

  return {
    users,
    tokensByHash,
    inserts,
    deletes,
    devices,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('FROM users') && sql.includes('password_hash') && sql.includes('is_deactivated')) {
                const userId = args[0] as string;
                const u = users.get(userId);
                if (!u || u.is_deactivated) return null;
                return { user_id: u.user_id, password_hash: u.password_hash } as T;
              }
              if (sql.includes('SELECT password_hash FROM users')) {
                const userId = args[0] as string;
                const u = users.get(userId);
                return (u ? { password_hash: u.password_hash } : null) as T;
              }
              if (
                sql.includes('FROM users WHERE user_id') &&
                sql.includes('display_name') &&
                !sql.includes('password_hash')
              ) {
                const userId = args[0] as string;
                const u = users.get(userId);
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
              if (sql.includes('FROM access_tokens') && sql.includes('token_hash') && sql.includes('SELECT')) {
                const hash = args[0] as string;
                const row = tokensByHash.get(hash);
                if (!row) return null;
                if (sql.includes('created_at')) {
                  return {
                    user_id: row.user_id,
                    device_id: row.device_id,
                    created_at: row.created_at,
                  } as T;
                }
                return { user_id: row.user_id, device_id: row.device_id } as T;
              }
              if (sql.includes('FROM idp_user_links') && sql.includes('COUNT')) {
                const userId = args[0] as string;
                const count = idpLinkUserIds.filter((id) => id === userId).length;
                return { count } as T;
              }
              if (sql.includes('FROM appservice_registrations')) {
                return null;
              }
              return null;
            },
            async run() {
              if (sql.trimStart().toUpperCase().startsWith('INSERT')) {
                inserts.push({ sql, args });
                if (sql.includes('INTO access_tokens')) {
                  const [, tokenHash, userId, deviceId] = args as [
                    string,
                    string,
                    string,
                    string | null,
                  ];
                  tokensByHash.set(tokenHash, {
                    user_id: userId,
                    device_id: deviceId,
                    created_at: Date.now(),
                  });
                }
                if (sql.includes('INTO devices')) {
                  devices.push({
                    user_id: args[0] as string,
                    device_id: args[1] as string,
                    display_name: (args[2] as string | null) ?? null,
                  });
                }
              }
              if (sql.trimStart().toUpperCase().startsWith('DELETE')) {
                deletes.push({ sql, args });
                if (sql.includes('FROM access_tokens') && sql.includes('token_hash')) {
                  tokensByHash.delete(args[0] as string);
                }
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database & {
    users: Map<string, UserRow>;
    tokensByHash: Map<string, TokenRow>;
    inserts: Array<{ sql: string; args: unknown[] }>;
    deletes: Array<{ sql: string; args: unknown[] }>;
    devices: Array<{ user_id: string; device_id: string; display_name: string | null }>;
  };
}

function aliceDb(extra?: Map<string, UserRow>) {
  const users = new Map([
    [
      USER_ID,
      userRow({
        user_id: USER_ID,
        localpart: 'alice',
        password_hash: 'mockok:secret',
        display_name: 'Alice',
        avatar_url: 'mxc://example.com/alice',
      }),
    ],
    [
      BOB_ID,
      userRow({
        user_id: BOB_ID,
        localpart: 'bob',
        password_hash: 'mockok:bobpass',
        display_name: 'Bob',
      }),
    ],
  ]);
  if (extra) for (const [k, v] of extra) users.set(k, v);
  return createOAuthDb({ users });
}

function makeEnv(opts: {
  cache?: RaceKv;
  sessions?: RaceKv;
  db?: ReturnType<typeof createOAuthDb>;
} = {}): Env & { _cache: RaceKv; _sessions: RaceKv; _db: ReturnType<typeof createOAuthDb> } {
  const cache = opts.cache ?? mockKv();
  const sessions = opts.sessions ?? mockKv();
  const db = opts.db ?? aliceDb();
  return {
    SERVER_NAME: SERVER,
    SERVER_VERSION: '0.1.0-test',
    CACHE: cache,
    SESSIONS: sessions,
    DB: db,
    _cache: cache,
    _sessions: sessions,
    _db: db,
  } as unknown as Env & {
    _cache: RaceKv;
    _sessions: RaceKv;
    _db: ReturnType<typeof createOAuthDb>;
  };
}

async function request(path: string, init: RequestInit = {}, env: Env = makeEnv()): Promise<{
  status: number;
  body: any;
  headers: Headers;
  text: string;
}> {
  const res = await oauth.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, headers: res.headers, text };
}

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
}

function formInit(fields: Record<string, string>): RequestInit {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return { method: 'POST', body: fd };
}

function seedClient(cache: RaceKv, clientId: string, patch: Record<string, unknown> = {}) {
  const client = {
    client_id: clientId,
    client_secret_hash: null,
    client_name: 'Element Web',
    redirect_uris: [REDIRECT],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    created_at: NOW,
    ...patch,
  };
  cache.data[`oauth_client:${clientId}`] = JSON.stringify(client);
  return client;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function seedAuthRequest(
  sessions: RaceKv,
  id: string,
  patch: Record<string, unknown> = {}
) {
  const req = {
    client_id: 'cid-1',
    redirect_uri: REDIRECT,
    scope: 'openid',
    state: 'st',
    nonce: 'n',
    ...patch,
  };
  sessions.data[`oauth_auth_request:${id}`] = JSON.stringify(req);
  return req;
}

function seedUiaSession(cache: RaceKv, id: string, patch: Record<string, unknown> = {}) {
  const session = { user_id: USER_ID, completed_stages: [] as string[], ...patch };
  cache.data[`uia_session:${id}`] = JSON.stringify(session);
  return session;
}

// ---------------------------------------------------------------------------
// POST authorize Missing username or password HTML ∥ success 302
// ---------------------------------------------------------------------------

describe('senary oauth Missing username or password ∥ success after #283 tip', () => {
  it('missing password ∥ valid — binds Missing username or password; sibling 302', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-miss');
    seedAuthRequest(sessions, 'ar-ok', { state: 'ok-st' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/authorize',
        formInit({ username: 'alice', auth_request_id: 'ar-miss' }),
        env
      ),
      request(
        '/oauth/authorize',
        formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-ok' }),
        env
      ),
    ]);
    const bad = results.find((r) => r.status === 200)!;
    const ok = results.find((r) => r.status === 302)!;
    expect(String(bad.body)).toContain('Missing username or password');
    expect(ok.headers.get('Location')).toContain('code=');
    // missing password must not burn the soft auth_request
    expect(sessions.data['oauth_auth_request:ar-miss']).toBeTruthy();
  });

  it('missing username ∥ missing auth_request_id — both Missing username or password', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-keep');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request('/oauth/authorize', formInit({ password: 'secret', auth_request_id: 'ar-keep' }), env),
      request('/oauth/authorize', formInit({ username: 'alice', password: 'secret' }), env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => String(r.body).includes('Missing username or password'))).toBe(
      true
    );
    expect(sessions.data['oauth_auth_request:ar-keep']).toBeTruthy();
  });

  for (let i = 0; i < 10; i++) {
    it(`Missing username or password ∥ success flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const sessions = mockKv();
      seedAuthRequest(sessions, `ar-m-${i}`);
      seedAuthRequest(sessions, `ar-ok-${i}`, { state: `st${i}` });
      const env = makeEnv({ cache, sessions, db: aliceDb() });
      const soft =
        i % 2 === 0
          ? formInit({ username: 'alice', auth_request_id: `ar-m-${i}` })
          : formInit({ password: 'secret', auth_request_id: `ar-m-${i}` });
      const results = await Promise.all([
        request('/oauth/authorize', soft, env),
        request(
          '/oauth/authorize',
          formInit({ username: 'alice', password: 'secret', auth_request_id: `ar-ok-${i}` }),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 302]);
      expect(String(results.find((r) => r.status === 200)!.body)).toContain(
        'Missing username or password'
      );
      expect(results.find((r) => r.status === 302)!.headers.get('Location')).toContain('code=');
    });
  }
});

// ---------------------------------------------------------------------------
// POST authorize Invalid username or password HTML ∥ success 302
// ---------------------------------------------------------------------------

describe('senary oauth Invalid username or password ∥ success after #283 tip', () => {
  it('unknown user ∥ valid — binds Invalid username or password; re-seeds auth request', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1', { client_name: 'Element Web' });
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-bad');
    seedAuthRequest(sessions, 'ar-ok', { state: 'ok' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/authorize',
        formInit({ username: 'nobody', password: 'secret', auth_request_id: 'ar-bad' }),
        env
      ),
      request(
        '/oauth/authorize',
        formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-ok' }),
        env
      ),
    ]);
    const bad = results.find((r) => r.status === 200)!;
    const ok = results.find((r) => r.status === 302)!;
    expect(String(bad.body)).toContain('Invalid username or password');
    expect(String(bad.body)).toContain('Element Web');
    expect(ok.headers.get('Location')).toContain('code=');
    expect(sessions.data['oauth_auth_request:ar-bad']).toBeUndefined();
    expect(Object.keys(sessions.data).some((k) => k.startsWith('oauth_auth_request:'))).toBe(true);
  });

  it('wrong password ∥ deactivated ∥ valid under race', async () => {
    const deactivated = userRow({
      user_id: `@deact:${SERVER}`,
      localpart: 'deact',
      password_hash: 'mockok:secret',
      is_deactivated: 1,
    });
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-wp');
    seedAuthRequest(sessions, 'ar-deact');
    seedAuthRequest(sessions, 'ar-ok', { state: 'ok3' });
    const env = makeEnv({
      cache,
      sessions,
      db: aliceDb(new Map([[deactivated.user_id, deactivated]])),
    });
    const results = await Promise.all([
      request(
        '/oauth/authorize',
        formInit({ username: 'alice', password: 'wrong', auth_request_id: 'ar-wp' }),
        env
      ),
      request(
        '/oauth/authorize',
        formInit({ username: 'deact', password: 'secret', auth_request_id: 'ar-deact' }),
        env
      ),
      request(
        '/oauth/authorize',
        formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-ok' }),
        env
      ),
    ]);
    const softs = results.filter((r) => r.status === 200);
    const ok = results.find((r) => r.status === 302)!;
    expect(softs.length).toBe(2);
    expect(softs.every((r) => String(r.body).includes('Invalid username or password'))).toBe(true);
    expect(ok.headers.get('Location')).toContain('code=');
  });

  it('null password_hash ∥ valid — Invalid username or password under race', async () => {
    const oidcOnly = userRow({
      user_id: `@oidconly:${SERVER}`,
      localpart: 'oidconly',
      password_hash: null,
    });
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-null');
    seedAuthRequest(sessions, 'ar-ok', { state: 'ok-null' });
    const env = makeEnv({
      cache,
      sessions,
      db: aliceDb(new Map([[oidcOnly.user_id, oidcOnly]])),
    });
    const results = await Promise.all([
      request(
        '/oauth/authorize',
        formInit({ username: 'oidconly', password: 'anything', auth_request_id: 'ar-null' }),
        env
      ),
      request(
        '/oauth/authorize',
        formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-ok' }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 302]);
    expect(String(results.find((r) => r.status === 200)!.body)).toContain(
      'Invalid username or password'
    );
  });

  it('client wipe → Unknown Client fallback ∥ valid sibling under race', async () => {
    const cache = mockKv();
    // no client seeded — bad login falls back to Unknown Client
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-wipe', { client_id: 'gone-client' });
    seedAuthRequest(sessions, 'ar-ok', { state: 'ok-wipe' });
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/authorize',
        formInit({ username: 'nobody', password: 'x', auth_request_id: 'ar-wipe' }),
        env
      ),
      request(
        '/oauth/authorize',
        formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-ok' }),
        env
      ),
    ]);
    const bad = results.find((r) => r.status === 200)!;
    expect(String(bad.body)).toContain('Invalid username or password');
    expect(String(bad.body)).toContain('Unknown Client');
    expect(results.find((r) => r.status === 302)!.headers.get('Location')).toContain('code=');
  });

  for (let i = 0; i < 10; i++) {
    it(`Invalid username or password ∥ success flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const sessions = mockKv();
      seedAuthRequest(sessions, `ar-bad-${i}`);
      seedAuthRequest(sessions, `ar-ok-${i}`, { state: `okf${i}` });
      const env = makeEnv({ cache, sessions, db: aliceDb() });
      const soft =
        i % 2 === 0
          ? formInit({ username: 'ghost', password: 'x', auth_request_id: `ar-bad-${i}` })
          : formInit({ username: 'alice', password: 'nope', auth_request_id: `ar-bad-${i}` });
      const results = await Promise.all([
        request('/oauth/authorize', soft, env),
        request(
          '/oauth/authorize',
          formInit({ username: 'alice', password: 'secret', auth_request_id: `ar-ok-${i}` }),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 302]);
      expect(String(results.find((r) => r.status === 200)!.body)).toContain(
        'Invalid username or password'
      );
    });
  }
});

// ---------------------------------------------------------------------------
// UIA Missing Session / Session Expired ∥ approval / Request Approved
// ---------------------------------------------------------------------------

describe('senary oauth UIA Missing Session / Session Expired under race after #283 tip', () => {
  it('GET Missing Session ∥ Session Expired ∥ valid approval under race', async () => {
    const cache = mockKv();
    seedUiaSession(cache, 'uia-ok');
    const env = makeEnv({ cache, db: aliceDb() });
    const results = await Promise.all([
      request('/oauth/authorize/uia', {}, env),
      request('/oauth/authorize/uia?session=gone', {}, env),
      request('/oauth/authorize/uia?session=uia-ok&action=org.matrix.cross_signing_reset', {}, env),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.some((r) => String(r.body).includes('Missing Session'))).toBe(true);
    expect(results.some((r) => String(r.body).includes('Session Expired'))).toBe(true);
    expect(results.some((r) => String(r.body).includes('Reset Encryption Keys'))).toBe(true);
  });

  it('POST Missing Session ∥ Session Expired ∥ Request Approved under race', async () => {
    const cache = mockKv();
    seedUiaSession(cache, 'uia-ap');
    const env = makeEnv({ cache, db: aliceDb() });
    const results = await Promise.all([
      request('/oauth/authorize/uia', formInit({ username: 'alice', password: 'secret' }), env),
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'gone', username: 'alice', password: 'secret' }),
        env
      ),
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-ap', username: 'alice', password: 'secret' }),
        env
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.some((r) => String(r.body).includes('Missing Session'))).toBe(true);
    expect(results.some((r) => String(r.body).includes('Session Expired'))).toBe(true);
    expect(results.some((r) => String(r.body).includes('Request Approved'))).toBe(true);
    const session = JSON.parse(cache.data['uia_session:uia-ap']);
    expect(session.completed_stages).toEqual(
      expect.arrayContaining(['org.matrix.cross_signing_reset', 'm.oauth', 'm.login.oauth'])
    );
  });

  it('cancel Request Cancelled ∥ Request Approved under race (distinct sessions)', async () => {
    const cache = mockKv();
    seedUiaSession(cache, 'uia-cancel');
    seedUiaSession(cache, 'uia-approve');
    const env = makeEnv({ cache, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-cancel', action: 'cancel' }),
        env
      ),
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-approve', username: 'alice', password: 'secret' }),
        env
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.some((r) => String(r.body).includes('Request Cancelled'))).toBe(true);
    expect(results.some((r) => String(r.body).includes('Request Approved'))).toBe(true);
    expect(cache.data['uia_session:uia-cancel']).toBeUndefined();
    expect(cache.data['uia_session:uia-approve']).toBeTruthy();
  });

  it('Username and password are required. ∥ Request Approved under race', async () => {
    const cache = mockKv();
    seedUiaSession(cache, 'uia-cred');
    seedUiaSession(cache, 'uia-ok2');
    const env = makeEnv({ cache, db: aliceDb() });
    const results = await Promise.all([
      request('/oauth/authorize/uia', formInit({ session: 'uia-cred' }), env),
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-ok2', username: 'alice', password: 'secret' }),
        env
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.some((r) => String(r.body).includes('Username and password are required.'))).toBe(
      true
    );
    expect(results.some((r) => String(r.body).includes('Request Approved'))).toBe(true);
    // soft path must not burn session
    expect(cache.data['uia_session:uia-cred']).toBeTruthy();
  });

  for (let i = 0; i < 8; i++) {
    it(`UIA Missing Session / Session Expired ∥ approve flood-${i}`, async () => {
      const cache = mockKv();
      seedUiaSession(cache, `uia-ok-${i}`);
      const env = makeEnv({ cache, db: aliceDb() });
      const soft =
        i % 2 === 0
          ? request('/oauth/authorize/uia', {}, env)
          : request(`/oauth/authorize/uia?session=miss-${i}`, {}, env);
      const results = await Promise.all([
        soft,
        request(
          '/oauth/authorize/uia',
          formInit({ session: `uia-ok-${i}`, username: 'alice', password: 'secret' }),
          env
        ),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(
        results.some(
          (r) =>
            String(r.body).includes('Missing Session') || String(r.body).includes('Session Expired')
        )
      ).toBe(true);
      expect(results.some((r) => String(r.body).includes('Request Approved'))).toBe(true);
    });
  }
});
