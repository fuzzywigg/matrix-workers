/**
 * TOKENMAXX HEAVY leftovers after #303 octonary / tip past #300 — oauth
 * *nonary* concurrent-race niches octonary never mixed under Promise.all:
 *   authorize-login soft `Invalid username or password` (NO trailing
 *     period) ∥ UIA soft `Invalid username or password.` (WITH period),
 *   OIDC-only approve *success* ∥ parse fail ∥ Username required ∥
 *     cancel mega (septenary raced OIDC *mismatch* only),
 *   login Missing username ∥ UIA credentials description ∥ Request
 *     Approved cross-path (senary login∥302; octonary UIA-only).
 *
 * Gap table (why leftover after #303):
 *   Login no-period ∥ UIA period under same Promise.all
 *     | senary login-only; septenary/octonary UIA-only
 *   OIDC-only Request Approved ∥ parse ∥ Username required ∥ cancel
 *     | septenary OIDC mismatch; octonary password-path approve
 *   Missing username ∥ credentials-desc ∥ Approved cross authorize/UIA
 *     | never claimed across both routes under race
 *
 * Distinct from #303 oauth octonary, #300 septenary, #294 senary.
 * New file. Tests-only. example.com fixtures only. Reversible by delete.
 * No invent-product / secrets / DNS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HonoRequest } from 'hono/request';
import type { Env } from '../src/types';

const SERVER = 'example.com';
const USER_ID = `@alice:${SERVER}`;
const BOB_ID = `@bob:${SERVER}`;
const OIDC_ID = `@oidc:${SERVER}`;
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

function aliceDb(extra?: Map<string, UserRow>, idpLinkUserIds: string[] = []) {
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
    [
      OIDC_ID,
      userRow({
        user_id: OIDC_ID,
        localpart: 'oidc',
        password_hash: null,
        display_name: 'OIDC',
      }),
    ],
  ]);
  if (extra) for (const [k, v] of extra) users.set(k, v);
  return createOAuthDb({ users, idpLinkUserIds });
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
    code_challenge: null,
    code_challenge_method: null,
    nonce: null,
    created_at: NOW,
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

const LOGIN_INVALID_NO_PERIOD = 'Invalid username or password';
const UIA_INVALID_WITH_PERIOD = 'Invalid username or password.';
const UIA_USERNAME_REQUIRED = 'Username and password are required.';
const UIA_CREDENTIALS_DESC = 'Please enter your credentials to approve this request.';
const UIA_PARSE_BODY = 'Could not parse request.';

function htmlOf(results: Array<{ body: unknown }>): string[] {
  return results.map((r) => String(r.body));
}

function hasLoginNoPeriod(htmls: string[]): boolean {
  return htmls.some(
    (h) => h.includes(LOGIN_INVALID_NO_PERIOD) && !h.includes(UIA_INVALID_WITH_PERIOD)
  );
}

function hasUiaWithPeriod(htmls: string[]): boolean {
  return htmls.some((h) => h.includes(UIA_INVALID_WITH_PERIOD));
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

// ---------------------------------------------------------------------------
// Login no-period ∥ UIA period under same Promise.all
// ---------------------------------------------------------------------------

describe('nonary oauth login no-period ∥ UIA period after #303', () => {
  it('authorize Invalid (no period) ∥ UIA Invalid (period) under race', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    seedUiaSession(cache, 'uia-bad');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-bad');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/authorize',
        formInit({ username: 'alice', password: 'wrong', auth_request_id: 'ar-bad' }),
        env
      ),
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-bad', username: 'alice', password: 'nope' }),
        env
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const htmls = htmlOf(results);
    expect(hasLoginNoPeriod(htmls)).toBe(true);
    expect(hasUiaWithPeriod(htmls)).toBe(true);
    expect(htmls.some((h) => h.includes(UIA_CREDENTIALS_DESC))).toBe(true);
  });

  it('unknown-user login ∥ UIA bad-password period ∥ Missing username triple', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1', { client_name: 'Element Web' });
    seedUiaSession(cache, 'uia-bad');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-nobody');
    seedAuthRequest(sessions, 'ar-miss');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/authorize',
        formInit({ username: 'nobody', password: 'secret', auth_request_id: 'ar-nobody' }),
        env
      ),
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-bad', username: 'alice', password: 'wrong' }),
        env
      ),
      request(
        '/oauth/authorize',
        formInit({ password: 'secret', auth_request_id: 'ar-miss' }),
        env
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const htmls = htmlOf(results);
    expect(hasLoginNoPeriod(htmls)).toBe(true);
    expect(hasUiaWithPeriod(htmls)).toBe(true);
    expect(htmls.some((h) => h.includes('Missing username or password'))).toBe(true);
  });

  for (let i = 0; i < 10; i++) {
    it(`login no-period ∥ UIA period flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      seedUiaSession(cache, `uia-bad-${i}`);
      const sessions = mockKv();
      seedAuthRequest(sessions, `ar-bad-${i}`);
      const env = makeEnv({ cache, sessions, db: aliceDb() });
      const loginSoft =
        i % 2 === 0
          ? formInit({
              username: 'alice',
              password: `wrong-${i}`,
              auth_request_id: `ar-bad-${i}`,
            })
          : formInit({
              username: `nobody-${i}`,
              password: 'secret',
              auth_request_id: `ar-bad-${i}`,
            });
      const results = await Promise.all([
        request('/oauth/authorize', loginSoft, env),
        request(
          '/oauth/authorize/uia',
          formInit({
            session: `uia-bad-${i}`,
            username: 'alice',
            password: `nope-${i}`,
          }),
          env
        ),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      const htmls = htmlOf(results);
      expect(hasLoginNoPeriod(htmls)).toBe(true);
      expect(hasUiaWithPeriod(htmls)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// OIDC-only approve success ∥ parse ∥ Username required ∥ cancel
// ---------------------------------------------------------------------------

describe('nonary oauth OIDC-only approve success mega race after #303', () => {
  it('OIDC success ∥ parse fail ∥ Username required ∥ cancel under race', async () => {
    const spy = vi
      .spyOn(HonoRequest.prototype, 'parseBody')
      .mockRejectedValueOnce(new Error('nonary-parse'));
    const cache = mockKv();
    seedUiaSession(cache, 'uia-oidc', { user_id: OIDC_ID });
    seedUiaSession(cache, 'uia-cred');
    seedUiaSession(cache, 'uia-cancel');
    const env = makeEnv({
      cache,
      db: aliceDb(undefined, [OIDC_ID]),
    });
    const results = await Promise.all([
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-oidc', username: 'oidc', password: 'ignored' }),
        env
      ),
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-oidc', username: 'oidc', password: 'ignored' }),
        env
      ),
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-cred', password: 'x' }),
        env
      ),
      request(
        '/oauth/authorize/uia',
        formInit({
          session: 'uia-cancel',
          username: 'alice',
          password: 'secret',
          action: 'cancel',
        }),
        env
      ),
    ]);
    spy.mockRestore();
    expect(results.every((r) => r.status === 200)).toBe(true);
    const htmls = htmlOf(results);
    expect(htmls.some((h) => h.includes('Request Approved'))).toBe(true);
    expect(htmls.some((h) => h.includes(UIA_PARSE_BODY))).toBe(true);
    expect(htmls.some((h) => h.includes(UIA_USERNAME_REQUIRED))).toBe(true);
    expect(htmls.some((h) => h.includes(UIA_CREDENTIALS_DESC))).toBe(true);
    expect(htmls.some((h) => h.includes('Request Cancelled'))).toBe(true);
    expect(cache.data['uia_session:uia-cancel']).toBeUndefined();
    expect(JSON.parse(cache.data['uia_session:uia-oidc']).completed_stages).toEqual(
      expect.arrayContaining(['m.oauth', 'm.login.oauth', 'org.matrix.cross_signing_reset'])
    );
  });

  it('OIDC success ∥ login no-period ∥ UIA period under race', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    seedUiaSession(cache, 'uia-oidc', { user_id: OIDC_ID });
    seedUiaSession(cache, 'uia-bad');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-bad');
    const env = makeEnv({
      cache,
      sessions,
      db: aliceDb(undefined, [OIDC_ID]),
    });
    const results = await Promise.all([
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-oidc', username: 'oidc', password: 'x' }),
        env
      ),
      request(
        '/oauth/authorize',
        formInit({ username: 'alice', password: 'wrong', auth_request_id: 'ar-bad' }),
        env
      ),
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-bad', username: 'alice', password: 'wrong' }),
        env
      ),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 302)).toBe(true);
    const htmls = htmlOf(results.filter((r) => r.status === 200));
    expect(htmls.some((h) => h.includes('Request Approved'))).toBe(true);
    expect(hasLoginNoPeriod(htmls)).toBe(true);
    expect(hasUiaWithPeriod(htmls)).toBe(true);
  });

  for (let i = 0; i < 8; i++) {
    it(`OIDC success ∥ soft sibling flood-${i}`, async () => {
      const cache = mockKv();
      seedUiaSession(cache, `uia-oidc-${i}`, { user_id: OIDC_ID });
      seedUiaSession(cache, `uia-soft-${i}`);
      const env = makeEnv({
        cache,
        db: aliceDb(undefined, [OIDC_ID]),
      });
      const soft =
        i % 2 === 0
          ? formInit({ session: `uia-soft-${i}`, password: 'x' })
          : formInit({
              session: `uia-soft-${i}`,
              username: 'alice',
              password: 'secret',
              action: 'cancel',
            });
      const results = await Promise.all([
        request(
          '/oauth/authorize/uia',
          formInit({
            session: `uia-oidc-${i}`,
            username: 'oidc',
            password: `any-${i}`,
          }),
          env
        ),
        request('/oauth/authorize/uia', soft, env),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      const htmls = htmlOf(results);
      expect(htmls.some((h) => h.includes('Request Approved'))).toBe(true);
      expect(
        htmls.some(
          (h) =>
            h.includes(UIA_USERNAME_REQUIRED) ||
            h.includes('Request Cancelled') ||
            h.includes(UIA_CREDENTIALS_DESC)
        )
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Missing username ∥ UIA credentials description ∥ Request Approved cross-path
// ---------------------------------------------------------------------------

describe('nonary oauth Missing username ∥ credentials-desc ∥ Approved after #303', () => {
  it('Missing username ∥ credentials-desc ∥ Request Approved under race', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    seedUiaSession(cache, 'uia-cred');
    seedUiaSession(cache, 'uia-ok');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-miss');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/authorize',
        formInit({ password: 'secret', auth_request_id: 'ar-miss' }),
        env
      ),
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-cred', password: 'x' }),
        env
      ),
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-ok', username: 'alice', password: 'secret' }),
        env
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const htmls = htmlOf(results);
    expect(htmls.some((h) => h.includes('Missing username or password'))).toBe(true);
    expect(htmls.some((h) => h.includes(UIA_CREDENTIALS_DESC))).toBe(true);
    expect(htmls.some((h) => h.includes(UIA_USERNAME_REQUIRED))).toBe(true);
    expect(htmls.some((h) => h.includes('Request Approved'))).toBe(true);
    expect(sessions.data['oauth_auth_request:ar-miss']).toBeTruthy();
  });

  for (let i = 0; i < 8; i++) {
    it(`Missing username ∥ credentials ∥ approve flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      seedUiaSession(cache, `uia-cred-${i}`);
      seedUiaSession(cache, `uia-ok-${i}`);
      const sessions = mockKv();
      seedAuthRequest(sessions, `ar-miss-${i}`);
      const env = makeEnv({ cache, sessions, db: aliceDb() });
      const results = await Promise.all([
        request(
          '/oauth/authorize',
          formInit({ password: `p-${i}`, auth_request_id: `ar-miss-${i}` }),
          env
        ),
        request(
          '/oauth/authorize/uia',
          formInit({ session: `uia-cred-${i}`, password: 'x' }),
          env
        ),
        request(
          '/oauth/authorize/uia',
          formInit({
            session: `uia-ok-${i}`,
            username: 'alice',
            password: 'secret',
          }),
          env
        ),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      const htmls = htmlOf(results);
      expect(htmls.some((h) => h.includes('Missing username or password'))).toBe(true);
      expect(htmls.some((h) => h.includes(UIA_CREDENTIALS_DESC))).toBe(true);
      expect(htmls.some((h) => h.includes('Request Approved'))).toBe(true);
    });
  }

  it('parse∥login-no-period∥OIDC-success∥cancel mega race', async () => {
    const spy = vi
      .spyOn(HonoRequest.prototype, 'parseBody')
      .mockRejectedValueOnce(new Error('mega-nonary'));
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    seedUiaSession(cache, 'uia-oidc', { user_id: OIDC_ID });
    seedUiaSession(cache, 'uia-cancel');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'ar-bad');
    const env = makeEnv({
      cache,
      sessions,
      db: aliceDb(undefined, [OIDC_ID]),
    });
    const results = await Promise.all([
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-oidc', username: 'oidc', password: 'x' }),
        env
      ),
      request(
        '/oauth/authorize',
        formInit({ username: 'alice', password: 'wrong', auth_request_id: 'ar-bad' }),
        env
      ),
      request(
        '/oauth/authorize/uia',
        formInit({
          session: 'uia-cancel',
          username: 'alice',
          password: 'secret',
          action: 'cancel',
        }),
        env
      ),
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'uia-oidc', username: 'oidc', password: 'x' }),
        env
      ),
    ]);
    spy.mockRestore();
    expect(results.every((r) => r.status === 200)).toBe(true);
    const htmls = htmlOf(results);
    expect(htmls.some((h) => h.includes(UIA_PARSE_BODY))).toBe(true);
    expect(hasLoginNoPeriod(htmls)).toBe(true);
    expect(htmls.some((h) => h.includes('Request Approved'))).toBe(true);
    expect(htmls.some((h) => h.includes('Request Cancelled'))).toBe(true);
  });
});
