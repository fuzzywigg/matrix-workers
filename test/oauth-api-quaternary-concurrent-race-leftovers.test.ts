/**
 * TOKENMAXX HEAVY leftovers after #268 / tip after #274 — oauth *quaternary*
 * concurrent-race niches: soft `error_description` / HTML / exclusive key-set
 * binds under Promise.all that prior oauth concurrent megafloods never asserted
 * (grep `error_description` in oauth-concurrent-race = 0).
 *
 * Soft/contract leftovers bind these strings sequentially (#90/#147/#157 routes);
 * concurrent races only assert status/`error` codes. Quaternary deepen:
 *   Register `Invalid JSON body` ∥ success; token `Unsupported content type` ∥ form ok;
 *   Redeem `Authorization code has expired` / `Code was not issued to this client`
 *   under deleteBarrier; PKCE `code_verifier is required` / `Invalid code_verifier`;
 *   Refresh `Token was not issued to this client` ∥ ok rotate; UIA `Could not parse
 *   request.` under race; userinfo null-field omit ∥ orphan `invalid_token`;
 *   introspect inactive `Object.keys === ['active']` ∥ active full set.
 *
 * Distinct from tip #274 (filters+appservice+auth tertiary), #273 room-cache
 * quinary, #272 crypto/db residual, #268 oauth+oidc deleteBarrier tip, and
 * open #275 admin+federation. New file (not append to 5k megaflood).
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 * Reversible by deleting this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HonoRequest } from 'hono/request';
import type { Env } from '../src/types';
import { hashToken } from '../src/utils/crypto';

const SERVER = 'example.com';
const USER_ID = `@alice:${SERVER}`;
const BOB_ID = `@bob:${SERVER}`;
const ORPHAN_ID = `@ghost:${SERVER}`;
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

function jsonInit(method: string, body?: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function urlencoded(fields: Record<string, string>): RequestInit {
  const body = new URLSearchParams(fields).toString();
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  };
}

async function registerClient(
  env: Env,
  body: Record<string, unknown> = {
    client_name: 'Element Web',
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: 'none',
  }
) {
  return request('/oauth/register', jsonInit('POST', body), env);
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

function seedAuthCode(sessions: RaceKv, code: string, patch: Record<string, unknown> = {}) {
  const authCode = {
    code,
    client_id: 'cid-1',
    user_id: USER_ID,
    redirect_uri: REDIRECT,
    scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEVICEA',
    created_at: NOW,
    expires_at: NOW + 600_000,
    ...patch,
  };
  sessions.data[`oauth_code:${code}`] = JSON.stringify(authCode);
  return authCode;
}

function seedRefresh(sessions: RaceKv, refresh: string, patch: Record<string, unknown> = {}) {
  const token = {
    token_id: 'tid-1',
    access_token_hash: 'hash-a',
    refresh_token_hash: 'hash-r',
    client_id: 'cid-1',
    user_id: USER_ID,
    device_id: 'DEVICEA',
    scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEVICEA',
    created_at: NOW,
    expires_at: NOW + 86400_000,
    ...patch,
  };
  sessions.data[`oauth_refresh:${refresh}`] = JSON.stringify(token);
  return token;
}

function base64UrlEncode(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlJson(obj: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

function fakeJwt(payload: Record<string, unknown>): string {
  return `${b64urlJson({ alg: 'none', typ: 'JWT' })}.${b64urlJson(payload)}.sig`;
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
// Register Invalid JSON body ∥ success — exact error_description under race
// ---------------------------------------------------------------------------

describe('quaternary oauth register Invalid JSON body ∥ success after #274 tip', () => {
  it('bad JSON ∥ valid register — binds Invalid JSON body; sibling 201', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request(
        '/oauth/register',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' },
        env
      ),
      registerClient(env, {
        client_name: 'Good',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
      }),
    ]);
    const bad = results.find((r) => r.status === 400)!;
    const ok = results.find((r) => r.status === 201)!;
    expect(bad.body).toEqual({
      error: 'invalid_request',
      error_description: 'Invalid JSON body',
    });
    expect(ok.body.client_id).toMatch(/^client_/);
    expect(Object.keys(bad.body).sort()).toEqual(['error', 'error_description']);
  });

  for (let i = 0; i < 12; i++) {
    it(`Invalid JSON body ∥ success flood-${i}`, async () => {
      const env = makeEnv({ cache: mockKv() });
      const results = await Promise.all([
        request(
          '/oauth/register',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: i % 2 === 0 ? '{oops' : 'not-json',
          },
          env
        ),
        registerClient(env, {
          client_name: `F${i}`,
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
        }),
        request(
          '/oauth/register',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: `{"unterminated":`,
          },
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([201, 400, 400]);
      const bads = results.filter((r) => r.status === 400);
      expect(
        bads.every((r) => r.body.error_description === 'Invalid JSON body')
      ).toBe(true);
      expect(results.filter((r) => r.status === 201)[0].body.client_id).toBeTruthy();
    });
  }
});

// ---------------------------------------------------------------------------
// Token Unsupported content type ∥ form success
// ---------------------------------------------------------------------------

describe('quaternary oauth token Unsupported content type ∥ form ok after #274 tip', () => {
  it('text/plain ∥ form redeem — binds Unsupported content type; sibling 200', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-ct-ok', {
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:CTOK',
    });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'grant_type=x' },
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'code-ct-ok',
        }),
        env
      ),
    ]);
    const bad = results.find((r) => r.status === 400)!;
    const ok = results.find((r) => r.status === 200)!;
    expect(bad.body).toEqual({
      error: 'invalid_request',
      error_description: 'Unsupported content type',
    });
    expect(ok.body.access_token).toBeTruthy();
    expect(ok.body.device_id).toBe('CTOK');
  });

  for (let i = 0; i < 12; i++) {
    it(`Unsupported content type ∥ form flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const sessions = mockKv();
      seedAuthCode(sessions, `code-ct-f-${i}`, {
        scope: `openid urn:matrix:org.matrix.msc2967.client:device:CTF${i}`,
      });
      const env = makeEnv({ cache, sessions, db: aliceDb() });
      const badCt = i % 2 === 0 ? 'text/plain' : 'application/xml';
      const results = await Promise.all([
        request(
          '/oauth/token',
          { method: 'POST', headers: { 'Content-Type': badCt }, body: 'x=1' },
          env
        ),
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'authorization_code',
            client_id: 'cid-1',
            code: `code-ct-f-${i}`,
          }),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(
        results.find((r) => r.status === 400)!.body.error_description
      ).toBe('Unsupported content type');
      expect(results.find((r) => r.status === 200)!.body.device_id).toBe(`CTF${i}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Redeem expired / wrong-client — exact error_description under deleteBarrier
// ---------------------------------------------------------------------------

describe('quaternary oauth redeem expired/wrong-client description after #274 tip', () => {
  it('expired code under deleteBarrier dual — both bind Authorization code has expired', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv(
      {},
      { deleteBarrier: { count: 2, match: (k) => k === 'oauth_code:code-exp-q' } }
    );
    seedAuthCode(sessions, 'code-exp-q', {
      expires_at: NOW - 1,
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:EXPQ',
    });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'code-exp-q',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'code-exp-q',
        }),
        env
      ),
    ]);
    // First delete-wins may get expired; loser gets Invalid or expired authorization code
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(
      results.some((r) => r.body.error_description === 'Authorization code has expired')
    ).toBe(true);
    expect(sessions.data['oauth_code:code-exp-q']).toBeUndefined();
  });

  it('expired ∥ valid sibling codes — expired binds exact description; sibling 200', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-exp-sib', {
      expires_at: NOW - 5_000,
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:EXPS',
    });
    seedAuthCode(sessions, 'code-ok-sib', {
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:OKSIB',
    });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'code-exp-sib',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'code-ok-sib',
        }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 400]);
    expect(results.find((r) => r.status === 400)!.body).toMatchObject({
      error: 'invalid_grant',
      error_description: 'Authorization code has expired',
    });
    expect(results.find((r) => r.status === 200)!.body.device_id).toBe('OKSIB');
  });

  it('wrong client_id ∥ right — binds Code was not issued to this client; code burned', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    seedClient(cache, 'cid-2');
    const sessions = mockKv(
      {},
      { deleteBarrier: { count: 2, match: (k) => k === 'oauth_code:code-wc-q' } }
    );
    seedAuthCode(sessions, 'code-wc-q', {
      client_id: 'cid-1',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:WCQ',
    });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-2',
          code: 'code-wc-q',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'code-wc-q',
        }),
        env
      ),
    ]);
    expect(
      results.some(
        (r) =>
          r.status === 400 &&
          r.body.error_description === 'Code was not issued to this client'
      )
    ).toBe(true);
    expect(sessions.data['oauth_code:code-wc-q']).toBeUndefined();
  });

  it('wrong-client solo under parallel with introspect inactive — exact description', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    seedClient(cache, 'cid-2');
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-wc-solo', {
      client_id: 'cid-1',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:WCS',
    });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-2',
          code: 'code-wc-solo',
        }),
        env
      ),
      request('/oauth/introspect', urlencoded({ token: 'missing-wc' }), env),
    ]);
    expect(results[0].status).toBe(400);
    expect(results[0].body).toEqual({
      error: 'invalid_grant',
      error_description: 'Code was not issued to this client',
    });
    expect(results[1].body).toEqual({ active: false });
    expect(Object.keys(results[1].body)).toEqual(['active']);
  });

  for (let i = 0; i < 12; i++) {
    it(`expired∥ok description flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const sessions = mockKv();
      seedAuthCode(sessions, `code-exf-${i}`, {
        expires_at: NOW - (i + 1) * 1000,
        scope: `openid urn:matrix:org.matrix.msc2967.client:device:EXF${i}`,
      });
      seedAuthCode(sessions, `code-okf-${i}`, {
        scope: `openid urn:matrix:org.matrix.msc2967.client:device:OKF${i}`,
      });
      const env = makeEnv({ cache, sessions, db: aliceDb() });
      const results = await Promise.all([
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'authorization_code',
            client_id: 'cid-1',
            code: `code-exf-${i}`,
          }),
          env
        ),
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'authorization_code',
            client_id: 'cid-1',
            code: `code-okf-${i}`,
          }),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(results.find((r) => r.status === 400)!.body.error_description).toBe(
        'Authorization code has expired'
      );
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`wrong-client description flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      seedClient(cache, 'cid-2');
      const sessions = mockKv();
      seedAuthCode(sessions, `code-wcf-${i}`, {
        client_id: 'cid-1',
        scope: `openid urn:matrix:org.matrix.msc2967.client:device:WCF${i}`,
      });
      const env = makeEnv({ cache, sessions, db: aliceDb() });
      const results = await Promise.all([
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'authorization_code',
            client_id: 'cid-2',
            code: `code-wcf-${i}`,
          }),
          env
        ),
        request('/oauth/introspect', urlencoded({ token: `miss-wcf-${i}` }), env),
      ]);
      expect(results[0].body.error_description).toBe('Code was not issued to this client');
      expect(Object.keys(results[1].body)).toEqual(['active']);
    });
  }
});

// ---------------------------------------------------------------------------
// PKCE code_verifier required / Invalid code_verifier
// ---------------------------------------------------------------------------

describe('quaternary oauth PKCE verifier descriptions after #274 tip', () => {
  it('missing verifier ∥ valid sibling — binds code_verifier is required', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-pkce-miss', {
      code_challenge: 'verifier-ok',
      code_challenge_method: 'plain',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:PKMISS',
    });
    seedAuthCode(sessions, 'code-pkce-ok', {
      code_challenge: 'verifier-ok',
      code_challenge_method: 'plain',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:PKOK',
    });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'code-pkce-miss',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'code-pkce-ok',
          code_verifier: 'verifier-ok',
        }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 400]);
    expect(results.find((r) => r.status === 400)!.body).toEqual({
      error: 'invalid_request',
      error_description: 'code_verifier is required',
    });
    expect(results.find((r) => r.status === 200)!.body.device_id).toBe('PKOK');
  });

  it('bad verifier ∥ good verifier siblings — binds Invalid code_verifier', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-pkce-bad', {
      code_challenge: 'expected-plain',
      code_challenge_method: 'plain',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:PKBAD',
    });
    seedAuthCode(sessions, 'code-pkce-good', {
      code_challenge: 'expected-plain',
      code_challenge_method: 'plain',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:PKGOOD',
    });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'code-pkce-bad',
          code_verifier: 'wrong-plain',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'code-pkce-good',
          code_verifier: 'expected-plain',
        }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 400]);
    expect(results.find((r) => r.status === 400)!.body).toEqual({
      error: 'invalid_grant',
      error_description: 'Invalid code_verifier',
    });
    expect(results.find((r) => r.status === 200)!.body.device_id).toBe('PKGOOD');
  });

  for (let i = 0; i < 12; i++) {
    it(`PKCE required∥ok flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const sessions = mockKv();
      const ver = `ver-plain-${i}`;
      seedAuthCode(sessions, `code-pkr-${i}`, {
        code_challenge: ver,
        code_challenge_method: 'plain',
        scope: `openid urn:matrix:org.matrix.msc2967.client:device:PKR${i}`,
      });
      seedAuthCode(sessions, `code-pko-${i}`, {
        code_challenge: ver,
        code_challenge_method: 'plain',
        scope: `openid urn:matrix:org.matrix.msc2967.client:device:PKO${i}`,
      });
      const env = makeEnv({ cache, sessions, db: aliceDb() });
      const results = await Promise.all([
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'authorization_code',
            client_id: 'cid-1',
            code: `code-pkr-${i}`,
          }),
          env
        ),
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'authorization_code',
            client_id: 'cid-1',
            code: `code-pko-${i}`,
            code_verifier: ver,
          }),
          env
        ),
      ]);
      expect(results.find((r) => r.status === 400)!.body.error_description).toBe(
        'code_verifier is required'
      );
      expect(results.find((r) => r.status === 200)!.body.device_id).toBe(`PKO${i}`);
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`Invalid code_verifier∥ok flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const sessions = mockKv();
      const ver = `good-ver-${i}`;
      seedAuthCode(sessions, `code-pkb-${i}`, {
        code_challenge: ver,
        code_challenge_method: 'plain',
        scope: `openid urn:matrix:org.matrix.msc2967.client:device:PKB${i}`,
      });
      seedAuthCode(sessions, `code-pkg-${i}`, {
        code_challenge: ver,
        code_challenge_method: 'plain',
        scope: `openid urn:matrix:org.matrix.msc2967.client:device:PKG${i}`,
      });
      const env = makeEnv({ cache, sessions, db: aliceDb() });
      const results = await Promise.all([
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'authorization_code',
            client_id: 'cid-1',
            code: `code-pkb-${i}`,
            code_verifier: `bad-${i}`,
          }),
          env
        ),
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'authorization_code',
            client_id: 'cid-1',
            code: `code-pkg-${i}`,
            code_verifier: ver,
          }),
          env
        ),
      ]);
      expect(results.find((r) => r.status === 400)!.body.error_description).toBe(
        'Invalid code_verifier'
      );
      expect(results.find((r) => r.status === 200)!.body.device_id).toBe(`PKG${i}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Refresh Token was not issued to this client ∥ ok rotate
// ---------------------------------------------------------------------------

describe('quaternary oauth refresh wrong-client description after #274 tip', () => {
  it('wrong client_id ∥ right rotate — binds Token was not issued; key preserved then rotated', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    seedClient(cache, 'cid-2');
    const sessions = mockKv();
    seedRefresh(sessions, 'rt-wc-q', { client_id: 'cid-1' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const wrong = await request(
      '/oauth/token',
      urlencoded({
        grant_type: 'refresh_token',
        client_id: 'cid-2',
        refresh_token: 'rt-wc-q',
      }),
      env
    );
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual({
      error: 'invalid_grant',
      error_description: 'Token was not issued to this client',
    });
    expect(sessions.data['oauth_refresh:rt-wc-q']).toBeTruthy();
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'refresh_token',
          client_id: 'cid-2',
          refresh_token: 'rt-wc-q',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'refresh_token',
          client_id: 'cid-1',
          refresh_token: 'rt-wc-q',
        }),
        env
      ),
    ]);
    expect(
      results.some(
        (r) =>
          r.status === 400 &&
          r.body.error_description === 'Token was not issued to this client'
      )
    ).toBe(true);
    expect(results.some((r) => r.status === 200 && r.body.refresh_token)).toBe(true);
  });

  for (let i = 0; i < 12; i++) {
    it(`refresh wrong-client description flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      seedClient(cache, 'cid-2');
      const sessions = mockKv();
      seedRefresh(sessions, `rt-wcf-${i}`, { client_id: 'cid-1', device_id: `D${i}` });
      const env = makeEnv({ cache, sessions, db: aliceDb() });
      const results = await Promise.all([
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'refresh_token',
            client_id: 'cid-2',
            refresh_token: `rt-wcf-${i}`,
          }),
          env
        ),
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'refresh_token',
            client_id: 'cid-1',
            refresh_token: `rt-wcf-${i}`,
          }),
          env
        ),
      ]);
      expect(
        results.some(
          (r) => r.body.error_description === 'Token was not issued to this client'
        )
      ).toBe(true);
      expect(results.some((r) => r.status === 200)).toBe(true);
      expect(sessions.data[`oauth_refresh:rt-wcf-${i}`]).toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------------
// UIA Could not parse request. under race
// ---------------------------------------------------------------------------

describe('quaternary oauth UIA Could not parse request under race after #274 tip', () => {
  it('dual parseBody reject — both HTML bind Could not parse request.', async () => {
    const spy = vi
      .spyOn(HonoRequest.prototype, 'parseBody')
      .mockRejectedValue(new Error('parse boom'));
    const cache = mockKv();
    cache.data['uia_session:parse-q'] = JSON.stringify({
      user_id: USER_ID,
      completed_stages: [],
    });
    const env = makeEnv({ cache, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'parse-q', username: 'alice', password: 'secret' }),
        env
      ),
      request(
        '/oauth/authorize/uia',
        formInit({ session: 'parse-q', username: 'alice', password: 'secret' }),
        env
      ),
    ]);
    spy.mockRestore();
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => String(r.body).includes('Could not parse request.'))).toBe(
      true
    );
    expect(results.every((r) => String(r.body).includes('Invalid Request'))).toBe(true);
  });

  for (let i = 0; i < 12; i++) {
    it(`UIA parse fail HTML flood-${i}`, async () => {
      const spy = vi
        .spyOn(HonoRequest.prototype, 'parseBody')
        .mockRejectedValue(new Error(`boom-${i}`));
      const env = makeEnv({ cache: mockKv(), db: aliceDb() });
      const results = await Promise.all([
        request(
          '/oauth/authorize/uia',
          formInit({ session: `pf-${i}`, username: 'alice', password: 'secret' }),
          env
        ),
        request(
          '/oauth/authorize/uia',
          formInit({ session: `pf-${i}b`, username: 'bob', password: 'x' }),
          env
        ),
      ]);
      spy.mockRestore();
      expect(
        results.every((r) => String(r.body).includes('Could not parse request.'))
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// userinfo null name/picture omit ∥ orphan invalid_token
// ---------------------------------------------------------------------------

describe('quaternary oauth userinfo null-field ∥ orphan invalid_token after #274 tip', () => {
  it('null profile fields omit name/picture ∥ orphan User not found under race', async () => {
    const nullUser = userRow({
      user_id: USER_ID,
      localpart: 'alice',
      display_name: null,
      avatar_url: null,
      password_hash: 'mockok:secret',
    });
    const db = createOAuthDb({
      users: new Map([[USER_ID, nullUser]]),
    });
    const tokOk = 'ui-null-ok';
    const tokOrphan = 'ui-orphan';
    db.tokensByHash.set(await hashToken(tokOk), {
      user_id: USER_ID,
      device_id: 'D1',
      created_at: NOW,
    });
    db.tokensByHash.set(await hashToken(tokOrphan), {
      user_id: ORPHAN_ID,
      device_id: 'D2',
      created_at: NOW,
    });
    const env = makeEnv({ db });
    const results = await Promise.all([
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${tokOk}` } }, env),
      request('/oauth/userinfo', { headers: { Authorization: `Bearer ${tokOrphan}` } }, env),
      request(
        '/oauth/userinfo',
        { method: 'POST', headers: { Authorization: `Bearer ${tokOk}` } },
        env
      ),
    ]);
    const oks = results.filter((r) => r.status === 200);
    const bad = results.find((r) => r.status === 401)!;
    expect(oks).toHaveLength(2);
    for (const r of oks) {
      expect(r.body).toEqual({
        sub: USER_ID,
        'urn:matrix:user_id': USER_ID,
      });
      expect(r.body).not.toHaveProperty('name');
      expect(r.body).not.toHaveProperty('picture');
    }
    expect(bad.body).toEqual({
      error: 'invalid_token',
      error_description: 'User not found',
    });
  });

  for (let i = 0; i < 12; i++) {
    it(`userinfo null∥orphan flood-${i}`, async () => {
      const db = createOAuthDb({
        users: new Map([
          [
            USER_ID,
            userRow({
              user_id: USER_ID,
              localpart: 'alice',
              display_name: null,
              avatar_url: null,
              password_hash: 'mockok:secret',
            }),
          ],
        ]),
      });
      const tokOk = `ui-n-${i}`;
      const tokOrphan = `ui-o-${i}`;
      db.tokensByHash.set(await hashToken(tokOk), {
        user_id: USER_ID,
        device_id: `N${i}`,
        created_at: NOW,
      });
      db.tokensByHash.set(await hashToken(tokOrphan), {
        user_id: ORPHAN_ID,
        device_id: `O${i}`,
        created_at: NOW,
      });
      const env = makeEnv({ db });
      const results = await Promise.all([
        request('/oauth/userinfo', { headers: { Authorization: `Bearer ${tokOk}` } }, env),
        request('/oauth/userinfo', { headers: { Authorization: `Bearer ${tokOrphan}` } }, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 401]);
      expect(results.find((r) => r.status === 200)!.body).not.toHaveProperty('name');
      expect(results.find((r) => r.status === 401)!.body.error_description).toBe(
        'User not found'
      );
    });
  }
});

// ---------------------------------------------------------------------------
// introspect inactive exclusive key-set ∥ active full set
// ---------------------------------------------------------------------------

describe('quaternary oauth introspect inactive key-set ∥ active after #274 tip', () => {
  it('inactive Object.keys===["active"] ∥ DB active full set under race', async () => {
    const db = aliceDb();
    const tok = 'intro-active-q';
    const hash = await hashToken(tok);
    db.tokensByHash.set(hash, {
      user_id: USER_ID,
      device_id: 'INTRO',
      created_at: NOW,
    });
    const env = makeEnv({ db });
    const results = await Promise.all([
      request('/oauth/introspect', urlencoded({ token: 'missing-intro-q' }), env),
      request('/oauth/introspect', urlencoded({ token: tok }), env),
      request(
        '/oauth/introspect',
        urlencoded({
          token: fakeJwt({
            sub: USER_ID,
            exp: Math.floor(NOW / 1000) + 3600,
            iat: Math.floor(NOW / 1000),
            client_id: 'cid-1',
            scope: 'openid',
            iss: `https://${SERVER}/`,
          }),
        }),
        env
      ),
    ]);
    const inactive = results.find((r) => r.body.active === false)!;
    expect(inactive.body).toEqual({ active: false });
    expect(Object.keys(inactive.body)).toEqual(['active']);
    const actives = results.filter((r) => r.body.active === true);
    expect(actives.length).toBe(2);
    for (const a of actives) {
      expect(a.body).toMatchObject({ active: true, token_type: 'Bearer' });
      expect(Object.keys(a.body).length).toBeGreaterThan(1);
    }
  });

  for (let i = 0; i < 12; i++) {
    it(`introspect inactive key-set flood-${i}`, async () => {
      const db = aliceDb();
      const tok = `intro-a-${i}`;
      db.tokensByHash.set(await hashToken(tok), {
        user_id: USER_ID,
        device_id: `IA${i}`,
        created_at: NOW,
      });
      const env = makeEnv({ db });
      const results = await Promise.all([
        request('/oauth/introspect', urlencoded({ token: `miss-${i}` }), env),
        request('/oauth/introspect', urlencoded({ token: tok }), env),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      const inactive = results.find((r) => r.body.active === false)!;
      const active = results.find((r) => r.body.active === true)!;
      expect(Object.keys(inactive.body)).toEqual(['active']);
      expect(active.body.sub).toBe(USER_ID);
      expect(Object.keys(active.body).sort()).toEqual(
        ['active', 'client_id', 'iat', 'sub', 'token_type'].sort()
      );
    });
  }
});
