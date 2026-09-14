/**
 * TOKENMAXX HEAVY leftovers after #277 quaternary / tip past #276 — oauth
 * *quinary* concurrent-race niches: soft `error_description` binds under
 * Promise.all that quaternary (#277) never claimed (grep of these strings in
 * *oauth*concurrent* / *oauth*quaternary* race files = 0).
 *
 * Soft/route leftovers bind these sequentially (oauth-api-routes / edges);
 * concurrent races never asserted exact descriptions. Quinary deepen:
 *   Register `redirect_uris is required` ∥ success;
 *   Authorize GET `client_id`/`redirect_uri`/`response_type`/`Unknown client`/
 *   `Invalid redirect_uri` under race;
 *   POST authorize `Authorization request expired` ∥ success sibling;
 *   Token `client_id is required` / `Unknown client` / `client_secret is
 *   required` / `Invalid client credentials` ∥ ok;
 *   Redeem `code is required` / `Invalid or expired authorization code` /
 *   `redirect_uri mismatch` ∥ ok sibling;
 *   Refresh `refresh_token is required` / `Invalid refresh token` /
 *   unsupported grant exact description ∥ ok;
 *   Revoke/introspect `token is required` ∥ sibling ok.
 *
 * Distinct from #277 oauth quaternary (Invalid JSON / Unsupported CT /
 * expired/wrong-client/PKCE/UIA/userinfo/introspect key-set), #268
 * deleteBarrier tip, #276 appservice quaternary. New file (not append to
 * megaflood). Tests-only. Fixtures use example.com only. No product inventing.
 * Reversible by deleting this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { hashToken } from '../src/utils/crypto';

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

import oauth, { hashClientSecret } from '../src/api/oauth';

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
// Register redirect_uris is required ∥ success
// ---------------------------------------------------------------------------

describe('quinary oauth register redirect_uris required ∥ success after #277/#276 tip', () => {
  it('empty redirect_uris ∥ valid — binds redirect_uris is required; sibling 201', async () => {
    const env = makeEnv({ cache: mockKv() });
    const results = await Promise.all([
      registerClient(env, {
        client_name: 'Bad',
        redirect_uris: [],
        token_endpoint_auth_method: 'none',
      }),
      registerClient(env, {
        client_name: 'Good',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
      }),
    ]);
    const bad = results.find((r) => r.status === 400)!;
    const ok = results.find((r) => r.status === 201)!;
    expect(bad.body).toEqual({
      error: 'invalid_client_metadata',
      error_description: 'redirect_uris is required',
    });
    expect(ok.body.client_id).toMatch(/^client_/);
    expect(Object.keys(bad.body).sort()).toEqual(['error', 'error_description']);
  });

  it('omitted redirect_uris ∥ valid — same exact description under race', async () => {
    const env = makeEnv({ cache: mockKv() });
    const results = await Promise.all([
      request(
        '/oauth/register',
        jsonInit('POST', { client_name: 'NoUris', token_endpoint_auth_method: 'none' }),
        env
      ),
      registerClient(env, {
        client_name: 'Ok',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
      }),
    ]);
    expect(statusesOf(results)).toEqual([201, 400]);
    expect(results.find((r) => r.status === 400)!.body.error_description).toBe(
      'redirect_uris is required'
    );
  });

  for (let i = 0; i < 12; i++) {
    it(`redirect_uris is required ∥ success flood-${i}`, async () => {
      const env = makeEnv({ cache: mockKv() });
      const badBody =
        i % 2 === 0
          ? { client_name: `B${i}`, redirect_uris: [], token_endpoint_auth_method: 'none' }
          : { client_name: `B${i}`, token_endpoint_auth_method: 'none' };
      const results = await Promise.all([
        request('/oauth/register', jsonInit('POST', badBody), env),
        registerClient(env, {
          client_name: `G${i}`,
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
        }),
      ]);
      expect(statusesOf(results)).toEqual([201, 400]);
      expect(results.find((r) => r.status === 400)!.body).toEqual({
        error: 'invalid_client_metadata',
        error_description: 'redirect_uris is required',
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Authorize GET soft param matrix under race
// ---------------------------------------------------------------------------

describe('quinary oauth authorize GET soft descriptions under race after #277/#276 tip', () => {
  it('missing client_id ∥ missing redirect_uri ∥ bad response_type under race', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache, sessions: mockKv() });
    const results = await Promise.all([
      request('/oauth/authorize?redirect_uri=' + encodeURIComponent(REDIRECT) + '&response_type=code', {}, env),
      request('/oauth/authorize?client_id=cid-1&response_type=code', {}, env),
      request(
        `/oauth/authorize?client_id=cid-1&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=token`,
        {},
        env
      ),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(results.map((r) => r.body.error_description).sort()).toEqual([
      'Only code response type is supported',
      'client_id is required',
      'redirect_uri is required',
    ]);
  });

  it('Unknown client ∥ Invalid redirect_uri ∥ valid HTML login under race', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    const env = makeEnv({ cache, sessions });
    const results = await Promise.all([
      request(
        `/oauth/authorize?client_id=ghost&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
        {},
        env
      ),
      request(
        `/oauth/authorize?client_id=cid-1&redirect_uri=${encodeURIComponent('https://evil.example.com/cb')}&response_type=code`,
        {},
        env
      ),
      request(
        `/oauth/authorize?client_id=cid-1&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&state=ok`,
        {},
        env
      ),
    ]);
    const unknown = results.find((r) => r.body?.error_description === 'Unknown client')!;
    const badUri = results.find((r) => r.body?.error_description === 'Invalid redirect_uri')!;
    const ok = results.find((r) => r.status === 200 && typeof r.body === 'string')!;
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('invalid_client');
    expect(badUri.status).toBe(400);
    expect(badUri.body.error).toBe('invalid_request');
    expect(ok.text).toContain('auth_request_id');
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:'))).toBe(true);
  });

  for (let i = 0; i < 12; i++) {
    it(`authorize GET soft matrix flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const env = makeEnv({ cache, sessions: mockKv() });
      const soft =
        i % 4 === 0
          ? {
              path: `/oauth/authorize?redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
              desc: 'client_id is required',
            }
          : i % 4 === 1
            ? {
                path: `/oauth/authorize?client_id=cid-1&response_type=code`,
                desc: 'redirect_uri is required',
              }
            : i % 4 === 2
              ? {
                  path: `/oauth/authorize?client_id=cid-1&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=id_token`,
                  desc: 'Only code response type is supported',
                }
              : {
                  path: `/oauth/authorize?client_id=missing&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
                  desc: 'Unknown client',
                };
      const results = await Promise.all([
        request(soft.path, {}, env),
        request(
          `/oauth/authorize?client_id=cid-1&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&state=f${i}`,
          {},
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(results.find((r) => r.status === 400)!.body.error_description).toBe(soft.desc);
      expect(results.find((r) => r.status === 200)!.text).toContain('auth_request_id');
    });
  }
});

// ---------------------------------------------------------------------------
// Authorization request expired ∥ success authorize
// ---------------------------------------------------------------------------

describe('quinary oauth Authorization request expired under race after #277/#276 tip', () => {
  it('missing auth_request ∥ valid sibling — binds Authorization request expired', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    sessions.data['oauth_auth_request:ar-ok'] = JSON.stringify({
      client_id: 'cid-1',
      redirect_uri: REDIRECT,
      scope: 'openid',
      state: 'st',
      nonce: 'n',
    });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/authorize',
        formInit({ username: 'alice', password: 'secret', auth_request_id: 'gone' }),
        env
      ),
      request(
        '/oauth/authorize',
        formInit({ username: 'alice', password: 'secret', auth_request_id: 'ar-ok' }),
        env
      ),
    ]);
    const bad = results.find((r) => r.status === 400)!;
    const ok = results.find((r) => r.status === 302)!;
    expect(bad.body).toEqual({
      error: 'invalid_request',
      error_description: 'Authorization request expired',
    });
    expect(ok.headers.get('Location')).toContain('code=');
  });

  for (let i = 0; i < 12; i++) {
    it(`Authorization request expired ∥ success flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const sessions = mockKv();
      sessions.data[`oauth_auth_request:ar-ok-${i}`] = JSON.stringify({
        client_id: 'cid-1',
        redirect_uri: REDIRECT,
        scope: 'openid',
        state: `st${i}`,
      });
      const env = makeEnv({ cache, sessions, db: aliceDb() });
      const results = await Promise.all([
        request(
          '/oauth/authorize',
          formInit({ username: 'alice', password: 'secret', auth_request_id: `miss-${i}` }),
          env
        ),
        request(
          '/oauth/authorize',
          formInit({ username: 'alice', password: 'secret', auth_request_id: `ar-ok-${i}` }),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([302, 400]);
      expect(results.find((r) => r.status === 400)!.body.error_description).toBe(
        'Authorization request expired'
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Token client auth soft descriptions under race
// ---------------------------------------------------------------------------

describe('quinary oauth token client auth soft descriptions after #277/#276 tip', () => {
  it('missing client_id ∥ Unknown client ∥ form redeem ok under race', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-cli-ok', {
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:CLIOK',
    });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', code: 'x' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'ghost',
          code: 'x',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'code-cli-ok',
        }),
        env
      ),
    ]);
    expect(
      results.some(
        (r) => r.status === 400 && r.body.error_description === 'client_id is required'
      )
    ).toBe(true);
    expect(
      results.some(
        (r) => r.status === 401 && r.body.error_description === 'Unknown client'
      )
    ).toBe(true);
    expect(results.find((r) => r.status === 200)!.body.device_id).toBe('CLIOK');
  });

  it('client_secret required ∥ Invalid credentials ∥ valid Basic under race', async () => {
    const secret = 's3cret-value';
    const hash = await hashClientSecret(secret);
    const cache = mockKv();
    seedClient(cache, 'cid-conf', {
      client_secret_hash: hash,
      token_endpoint_auth_method: 'client_secret_post',
    });
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-sec-ok', {
      client_id: 'cid-conf',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:SECOK',
    });
    seedAuthCode(sessions, 'code-sec-bad', {
      client_id: 'cid-conf',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:SECBAD',
    });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-conf',
          code: 'code-sec-bad',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-conf',
          client_secret: 'WRONG',
          code: 'code-sec-bad',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-conf',
          client_secret: secret,
          code: 'code-sec-ok',
        }),
        env
      ),
    ]);
    expect(
      results.some(
        (r) => r.status === 401 && r.body.error_description === 'client_secret is required'
      )
    ).toBe(true);
    expect(
      results.some(
        (r) => r.status === 401 && r.body.error_description === 'Invalid client credentials'
      )
    ).toBe(true);
    expect(results.find((r) => r.status === 200)!.body.device_id).toBe('SECOK');
  });

  for (let i = 0; i < 12; i++) {
    it(`token client auth soft flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const sessions = mockKv();
      seedAuthCode(sessions, `code-cli-f-${i}`, {
        scope: `openid urn:matrix:org.matrix.msc2967.client:device:CLIF${i}`,
      });
      const env = makeEnv({ cache, sessions, db: aliceDb() });
      const soft =
        i % 2 === 0
          ? {
              body: { grant_type: 'authorization_code', code: 'x' },
              status: 400,
              desc: 'client_id is required',
            }
          : {
              body: {
                grant_type: 'authorization_code',
                client_id: 'ghost',
                code: 'x',
              },
              status: 401,
              desc: 'Unknown client',
            };
      const results = await Promise.all([
        request('/oauth/token', urlencoded(soft.body), env),
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'authorization_code',
            client_id: 'cid-1',
            code: `code-cli-f-${i}`,
          }),
          env
        ),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, soft.status].sort());
      expect(results.find((r) => r.status === soft.status)!.body.error_description).toBe(
        soft.desc
      );
      expect(results.find((r) => r.status === 200)!.body.device_id).toBe(`CLIF${i}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Redeem code required / invalid-or-expired / redirect_uri mismatch
// ---------------------------------------------------------------------------

describe('quinary oauth redeem code/redirect soft descriptions after #277/#276 tip', () => {
  it('code is required ∥ Invalid or expired ∥ redirect_uri mismatch ∥ ok under race', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-ok-q5', {
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:OKQ5',
    });
    seedAuthCode(sessions, 'code-mismatch', {
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:MISM',
    });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'missing-code',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'code-mismatch',
          redirect_uri: 'https://other.example.com/cb',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'code-ok-q5',
        }),
        env
      ),
    ]);
    expect(
      results.some(
        (r) => r.status === 400 && r.body.error_description === 'code is required'
      )
    ).toBe(true);
    expect(
      results.some(
        (r) =>
          r.status === 400 &&
          r.body.error_description === 'Invalid or expired authorization code'
      )
    ).toBe(true);
    expect(
      results.some(
        (r) => r.status === 400 && r.body.error_description === 'redirect_uri mismatch'
      )
    ).toBe(true);
    expect(results.find((r) => r.status === 200)!.body.device_id).toBe('OKQ5');
  });

  for (let i = 0; i < 12; i++) {
    it(`redeem soft description ∥ ok flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const sessions = mockKv();
      seedAuthCode(sessions, `code-ok-f-${i}`, {
        scope: `openid urn:matrix:org.matrix.msc2967.client:device:RF${i}`,
      });
      if (i % 3 === 2) {
        seedAuthCode(sessions, `code-mis-f-${i}`, {
          scope: `openid urn:matrix:org.matrix.msc2967.client:device:MF${i}`,
        });
      }
      const env = makeEnv({ cache, sessions, db: aliceDb() });
      const soft =
        i % 3 === 0
          ? {
              body: { grant_type: 'authorization_code', client_id: 'cid-1' },
              desc: 'code is required',
            }
          : i % 3 === 1
            ? {
                body: {
                  grant_type: 'authorization_code',
                  client_id: 'cid-1',
                  code: `gone-${i}`,
                },
                desc: 'Invalid or expired authorization code',
              }
            : {
                body: {
                  grant_type: 'authorization_code',
                  client_id: 'cid-1',
                  code: `code-mis-f-${i}`,
                  redirect_uri: 'https://evil.example.com/cb',
                },
                desc: 'redirect_uri mismatch',
              };
      const results = await Promise.all([
        request('/oauth/token', urlencoded(soft.body), env),
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'authorization_code',
            client_id: 'cid-1',
            code: `code-ok-f-${i}`,
          }),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(results.find((r) => r.status === 400)!.body.error_description).toBe(soft.desc);
      expect(results.find((r) => r.status === 200)!.body.device_id).toBe(`RF${i}`);
    });
  }
});

// ---------------------------------------------------------------------------
// Refresh / grant soft descriptions under race
// ---------------------------------------------------------------------------

describe('quinary oauth refresh/grant soft descriptions after #277/#276 tip', () => {
  it('refresh_token required ∥ Invalid refresh ∥ unsupported grant ∥ ok rotate', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedRefresh(sessions, 'rt-ok', {
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEVICEA',
    });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: 'cid-1' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'refresh_token',
          client_id: 'cid-1',
          refresh_token: 'gone',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'password', client_id: 'cid-1' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'refresh_token',
          client_id: 'cid-1',
          refresh_token: 'rt-ok',
        }),
        env
      ),
    ]);
    expect(
      results.some(
        (r) => r.status === 400 && r.body.error_description === 'refresh_token is required'
      )
    ).toBe(true);
    expect(
      results.some(
        (r) => r.status === 400 && r.body.error_description === 'Invalid refresh token'
      )
    ).toBe(true);
    expect(
      results.some(
        (r) =>
          r.status === 400 &&
          r.body.error_description ===
            'Only authorization_code and refresh_token grants are supported'
      )
    ).toBe(true);
    expect(results.find((r) => r.status === 200)!.body.access_token).toBeTruthy();
    expect(sessions.data['oauth_refresh:rt-ok']).toBeUndefined();
  });

  for (let i = 0; i < 12; i++) {
    it(`refresh/grant soft ∥ ok flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const sessions = mockKv();
      seedRefresh(sessions, `rt-ok-${i}`, {
        scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEVICEA',
      });
      const env = makeEnv({ cache, sessions, db: aliceDb() });
      const soft =
        i % 3 === 0
          ? {
              body: { grant_type: 'refresh_token', client_id: 'cid-1' },
              desc: 'refresh_token is required',
            }
          : i % 3 === 1
            ? {
                body: {
                  grant_type: 'refresh_token',
                  client_id: 'cid-1',
                  refresh_token: `gone-${i}`,
                },
                desc: 'Invalid refresh token',
              }
            : {
                body: { grant_type: 'client_credentials', client_id: 'cid-1' },
                desc: 'Only authorization_code and refresh_token grants are supported',
              };
      const results = await Promise.all([
        request('/oauth/token', urlencoded(soft.body), env),
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'refresh_token',
            client_id: 'cid-1',
            refresh_token: `rt-ok-${i}`,
          }),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(results.find((r) => r.status === 400)!.body.error_description).toBe(soft.desc);
      expect(results.find((r) => r.status === 200)!.body.refresh_token).toBeTruthy();
    });
  }
});

// ---------------------------------------------------------------------------
// Revoke / introspect token is required under race
// ---------------------------------------------------------------------------

describe('quinary oauth revoke/introspect token is required after #277/#276 tip', () => {
  it('revoke missing token ∥ introspect missing ∥ introspect active under race', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const tokenHash = await hashToken('opaque-active');
    const db = aliceDb();
    db.tokensByHash.set(tokenHash, {
      user_id: USER_ID,
      device_id: 'DEVICEA',
      created_at: NOW,
    });
    const env = makeEnv({ cache, sessions, db });
    const jwt = fakeJwt({
      sub: USER_ID,
      exp: Math.floor(NOW / 1000) + 3600,
      iat: Math.floor(NOW / 1000),
    });
    const results = await Promise.all([
      request('/oauth/revoke', jsonInit('POST', {}), env),
      request('/oauth/introspect', jsonInit('POST', {}), env),
      request('/oauth/introspect', jsonInit('POST', { token: jwt }), env),
      request('/oauth/revoke', jsonInit('POST', { token: 'missing-rt' }), env),
    ]);
    const required = results.filter(
      (r) => r.status === 400 && r.body.error_description === 'token is required'
    );
    expect(required.length).toBe(2);
    expect(required.every((r) => r.body.error === 'invalid_request')).toBe(true);
    expect(results.some((r) => r.status === 200 && r.body?.active === true)).toBe(true);
    expect(results.some((r) => r.status === 200 && r.body == null)).toBe(true);
  });

  for (let i = 0; i < 12; i++) {
    it(`token is required revoke/introspect flood-${i}`, async () => {
      const env = makeEnv({ cache: mockKv(), sessions: mockKv(), db: aliceDb() });
      const jwt = fakeJwt({
        sub: USER_ID,
        exp: Math.floor(NOW / 1000) + 3600,
        iat: Math.floor(NOW / 1000),
      });
      const path = i % 2 === 0 ? '/oauth/revoke' : '/oauth/introspect';
      const results = await Promise.all([
        request(path, jsonInit('POST', {}), env),
        request('/oauth/introspect', jsonInit('POST', { token: jwt }), env),
      ]);
      expect(results.find((r) => r.status === 400)!.body).toEqual({
        error: 'invalid_request',
        error_description: 'token is required',
      });
      expect(results.find((r) => r.status === 200)!.body.active).toBe(true);
    });
  }
});
