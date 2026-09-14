/**
 * TOKENMAXX HEAVY leftovers after #277 / tip after #278+#279+#280 — oauth *quinary*
 * concurrent-race niches: authorize GET/POST + token client-auth / grant / revoke
 * soft `error_description` binds under Promise.all that #277 quaternary never claimed.
 *
 * #277 quaternary claimed: Invalid JSON body, Unsupported content type, expired code /
 * wrong client / PKCE / refresh wrong-client / UIA parse / userinfo orphan / introspect
 * inactive key-set. Concurrent megafloods still only assert status/`error` for authorize
 * validation + confidential client auth + grant missing-param descriptions.
 *
 * Quinary deepen (new file — not append to quaternary or 5k megaflood):
 *   GET authorize `client_id is required` / `redirect_uri is required` /
 *   `Only code response type is supported` / `Unknown client` / `Invalid redirect_uri`
 *   ∥ 200 HTML login; POST `Authorization request expired` ∥ valid redeem;
 *   register `redirect_uris is required` ∥ 201; token `client_id is required` /
 *   `Unknown client` (401) / `client_secret is required` / `Invalid client credentials`;
 *   auth_code `code is required` / `Invalid or expired authorization code`;
 *   refresh `refresh_token is required` / `Invalid refresh token`;
 *   unsupported grant exact description; revoke+introspect `token is required`.
 *
 * Distinct from tip #277 oauth+oidc quaternary, #278 knock, #279 admin IdP+invite,
 * #280 devices+keys, open #281 room-cache senary. Appservice/#276 left alone.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 * Reversible by deleting this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const SERVER = 'example.com';
const USER_ID = `@alice:${SERVER}`;
const BOB_ID = `@bob:${SERVER}`;
const REDIRECT = 'https://element.example.com/callback';
const EVIL_REDIRECT = 'https://evil.example.com/phish';
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
import { hashToken } from '../src/utils/crypto';

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
      await withBarrier(putBarrier, putWaiters, () => {
        putBarrier = undefined;
      }, key);
      putCount += 1;
      data[key] = value;
      puts.push({ key, value, options });
      events.push(`put:${key}`);
    },
    delete: async (key: string) => {
      await withBarrier(deleteBarrier, deleteWaiters, () => {
        deleteBarrier = undefined;
      }, key);
      deleteCount += 1;
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
} = {}) {
  const users = opts.users ?? new Map<string, UserRow>();
  const tokensByHash = opts.tokensByHash ?? new Map<string, TokenRow>();
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

async function request(
  path: string,
  init: RequestInit = {},
  env: Env = makeEnv()
): Promise<{
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  headers: Headers;
  text: string;
}> {
  const res = await oauth.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

async function seedConfidentialClient(cache: RaceKv, clientId: string, secret: string) {
  const hash = await hashClientSecret(secret);
  return seedClient(cache, clientId, {
    client_secret_hash: hash,
    token_endpoint_auth_method: 'client_secret_post',
    client_name: 'Confidential App',
  });
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

function seedAuthRequest(sessions: RaceKv, id: string, patch: Record<string, unknown> = {}) {
  const req = {
    client_id: 'cid-1',
    redirect_uri: REDIRECT,
    scope: 'openid',
    state: 'st-1',
    nonce: null,
    code_challenge: null,
    code_challenge_method: 'plain',
    ...patch,
  };
  sessions.data[`oauth_auth_request:${id}`] = JSON.stringify(req);
  return req;
}

function authorizeQs(params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString();
  return `/oauth/authorize?${qs}`;
}

function expectErrDesc(
  body: { error?: string; error_description?: string },
  error: string,
  description: string
) {
  expect(body).toEqual({ error, error_description: description });
  expect(Object.keys(body).sort()).toEqual(['error', 'error_description']);
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
// GET authorize missing client_id ∥ success HTML
// ---------------------------------------------------------------------------

describe('quinary oauth authorize client_id is required ∥ HTML ok after #277 tip', () => {
  it('missing client_id ∥ valid qs — binds client_id is required; sibling 200 HTML', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request(
        authorizeQs({
          redirect_uri: REDIRECT,
          response_type: 'code',
        }),
        {},
        env
      ),
      request(
        authorizeQs({
          client_id: 'cid-1',
          redirect_uri: REDIRECT,
          response_type: 'code',
        }),
        {},
        env
      ),
    ]);
    const bad = results.find((r) => r.status === 400)!;
    const ok = results.find((r) => r.status === 200)!;
    expectErrDesc(bad.body, 'invalid_request', 'client_id is required');
    expect(typeof ok.body).toBe('string');
    expect(ok.text).toContain('Element Web');
    expect(ok.text).toContain('auth_request_id');
  });

  for (let i = 0; i < 12; i++) {
    it(`client_id is required ∥ HTML flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const env = makeEnv({ cache });
      const results = await Promise.all([
        request(authorizeQs({ redirect_uri: REDIRECT, response_type: 'code' }), {}, env),
        request(
          authorizeQs({
            client_id: 'cid-1',
            redirect_uri: REDIRECT,
            response_type: 'code',
            state: `s-${i}`,
          }),
          {},
          env
        ),
        request(authorizeQs({ redirect_uri: REDIRECT, response_type: 'code' }), {}, env),
      ]);
      expect(statusesOf(results)).toEqual([200, 400, 400]);
      const bads = results.filter((r) => r.status === 400);
      expect(bads.every((r) => r.body.error_description === 'client_id is required')).toBe(true);
      expect(results.find((r) => r.status === 200)!.text).toContain('Element Web');
    });
  }
});

// ---------------------------------------------------------------------------
// GET authorize missing redirect_uri ∥ success HTML
// ---------------------------------------------------------------------------

describe('quinary oauth authorize redirect_uri is required ∥ HTML ok after #277 tip', () => {
  it('missing redirect_uri ∥ valid — binds redirect_uri is required; sibling 200', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request(authorizeQs({ client_id: 'cid-1', response_type: 'code' }), {}, env),
      request(
        authorizeQs({
          client_id: 'cid-1',
          redirect_uri: REDIRECT,
          response_type: 'code',
        }),
        {},
        env
      ),
    ]);
    const bad = results.find((r) => r.status === 400)!;
    const ok = results.find((r) => r.status === 200)!;
    expectErrDesc(bad.body, 'invalid_request', 'redirect_uri is required');
    expect(ok.text).toContain('auth_request_id');
  });

  for (let i = 0; i < 12; i++) {
    it(`redirect_uri is required ∥ HTML flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const env = makeEnv({ cache });
      const results = await Promise.all([
        request(authorizeQs({ client_id: 'cid-1', response_type: 'code' }), {}, env),
        request(
          authorizeQs({
            client_id: 'cid-1',
            redirect_uri: REDIRECT,
            response_type: 'code',
          }),
          {},
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(results.find((r) => r.status === 400)!.body.error_description).toBe(
        'redirect_uri is required'
      );
    });
  }
});

// ---------------------------------------------------------------------------
// GET authorize unsupported response_type — description never in any test/
// ---------------------------------------------------------------------------

describe('quinary oauth authorize Only code response type is supported after #277 tip', () => {
  it('response_type=token ∥ code — binds Only code response type is supported', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request(
        authorizeQs({
          client_id: 'cid-1',
          redirect_uri: REDIRECT,
          response_type: 'token',
        }),
        {},
        env
      ),
      request(
        authorizeQs({
          client_id: 'cid-1',
          redirect_uri: REDIRECT,
          response_type: 'code',
        }),
        {},
        env
      ),
    ]);
    const bad = results.find((r) => r.status === 400)!;
    const ok = results.find((r) => r.status === 200)!;
    expectErrDesc(bad.body, 'unsupported_response_type', 'Only code response type is supported');
    expect(ok.text).toContain('Element Web');
  });

  for (let i = 0; i < 12; i++) {
    it(`Only code response type flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const env = makeEnv({ cache });
      const rt = i % 3 === 0 ? 'token' : i % 3 === 1 ? 'id_token' : 'none';
      const results = await Promise.all([
        request(
          authorizeQs({
            client_id: 'cid-1',
            redirect_uri: REDIRECT,
            response_type: rt,
          }),
          {},
          env
        ),
        request(
          authorizeQs({
            client_id: 'cid-1',
            redirect_uri: REDIRECT,
            response_type: 'code',
          }),
          {},
          env
        ),
        request(
          authorizeQs({
            client_id: 'cid-1',
            redirect_uri: REDIRECT,
            response_type: 'code token',
          }),
          {},
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400, 400]);
      const bads = results.filter((r) => r.status === 400);
      expect(
        bads.every(
          (r) => r.body.error_description === 'Only code response type is supported'
        )
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// GET authorize Unknown client — description never asserted in test/
// ---------------------------------------------------------------------------

describe('quinary oauth authorize Unknown client ∥ HTML ok after #277 tip', () => {
  it('unknown client_id ∥ known — binds Unknown client; sibling 200', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request(
        authorizeQs({
          client_id: 'no-such-client',
          redirect_uri: REDIRECT,
          response_type: 'code',
        }),
        {},
        env
      ),
      request(
        authorizeQs({
          client_id: 'cid-1',
          redirect_uri: REDIRECT,
          response_type: 'code',
        }),
        {},
        env
      ),
    ]);
    const bad = results.find((r) => r.status === 400)!;
    const ok = results.find((r) => r.status === 200)!;
    expectErrDesc(bad.body, 'invalid_client', 'Unknown client');
    expect(ok.text).toContain('auth_request_id');
  });

  for (let i = 0; i < 12; i++) {
    it(`Unknown client authorize flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const env = makeEnv({ cache });
      const results = await Promise.all([
        request(
          authorizeQs({
            client_id: `ghost-${i}`,
            redirect_uri: REDIRECT,
            response_type: 'code',
          }),
          {},
          env
        ),
        request(
          authorizeQs({
            client_id: 'cid-1',
            redirect_uri: REDIRECT,
            response_type: 'code',
          }),
          {},
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(results.find((r) => r.status === 400)!.body).toEqual({
        error: 'invalid_client',
        error_description: 'Unknown client',
      });
    });
  }
});

// ---------------------------------------------------------------------------
// GET authorize Invalid redirect_uri ∥ HTML ok
// ---------------------------------------------------------------------------

describe('quinary oauth authorize Invalid redirect_uri ∥ HTML ok after #277 tip', () => {
  it('evil redirect ∥ valid — binds Invalid redirect_uri; sibling 200', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request(
        authorizeQs({
          client_id: 'cid-1',
          redirect_uri: EVIL_REDIRECT,
          response_type: 'code',
        }),
        {},
        env
      ),
      request(
        authorizeQs({
          client_id: 'cid-1',
          redirect_uri: REDIRECT,
          response_type: 'code',
        }),
        {},
        env
      ),
    ]);
    const bad = results.find((r) => r.status === 400)!;
    const ok = results.find((r) => r.status === 200)!;
    expectErrDesc(bad.body, 'invalid_request', 'Invalid redirect_uri');
    expect(ok.text).toContain('Element Web');
  });

  for (let i = 0; i < 12; i++) {
    it(`Invalid redirect_uri flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const env = makeEnv({ cache });
      const results = await Promise.all([
        request(
          authorizeQs({
            client_id: 'cid-1',
            redirect_uri: `https://evil-${i}.example.com/cb`,
            response_type: 'code',
          }),
          {},
          env
        ),
        request(
          authorizeQs({
            client_id: 'cid-1',
            redirect_uri: REDIRECT,
            response_type: 'code',
          }),
          {},
          env
        ),
        request(
          authorizeQs({
            client_id: 'cid-1',
            redirect_uri: EVIL_REDIRECT,
            response_type: 'code',
          }),
          {},
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400, 400]);
      expect(
        results
          .filter((r) => r.status === 400)
          .every((r) => r.body.error_description === 'Invalid redirect_uri')
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// POST authorize Authorization request expired ∥ success login redirect
// ---------------------------------------------------------------------------

describe('quinary oauth authorize Authorization request expired after #277 tip', () => {
  it('expired auth_request ∥ valid login — binds Authorization request expired', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'aid-ok');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/authorize',
        formInit({
          username: 'alice',
          password: 'secret',
          auth_request_id: 'aid-missing',
        }),
        env
      ),
      request(
        '/oauth/authorize',
        formInit({
          username: 'alice',
          password: 'secret',
          auth_request_id: 'aid-ok',
        }),
        env
      ),
    ]);
    const bad = results.find((r) => r.status === 400)!;
    const ok = results.find((r) => r.status === 302 || r.status === 200)!;
    expectErrDesc(bad.body, 'invalid_request', 'Authorization request expired');
    // Valid path redirects 302 to client with code
    expect([200, 302]).toContain(ok.status);
    if (ok.status === 302) {
      expect(ok.headers.get('Location') || '').toContain('code=');
    }
  });

  for (let i = 0; i < 12; i++) {
    it(`Authorization request expired flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const sessions = mockKv();
      seedAuthRequest(sessions, `aid-ok-${i}`);
      const env = makeEnv({ cache, sessions, db: aliceDb() });
      const results = await Promise.all([
        request(
          '/oauth/authorize',
          formInit({
            username: 'alice',
            password: 'secret',
            auth_request_id: `gone-${i}`,
          }),
          env
        ),
        request(
          '/oauth/authorize',
          formInit({
            username: 'alice',
            password: 'secret',
            auth_request_id: `aid-ok-${i}`,
          }),
          env
        ),
        request(
          '/oauth/authorize',
          formInit({
            username: 'alice',
            password: 'secret',
            auth_request_id: `also-gone-${i}`,
          }),
          env
        ),
      ]);
      const bads = results.filter((r) => r.status === 400);
      expect(bads.length).toBe(2);
      expect(
        bads.every((r) => r.body.error_description === 'Authorization request expired')
      ).toBe(true);
      const ok = results.find((r) => r.status === 302 || r.status === 200)!;
      expect(ok).toBeTruthy();
    });
  }
});

// ---------------------------------------------------------------------------
// Register redirect_uris is required ∥ 201
// ---------------------------------------------------------------------------

describe('quinary oauth register redirect_uris is required ∥ 201 after #277 tip', () => {
  it('empty redirect_uris ∥ valid — binds redirect_uris is required', async () => {
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
    expectErrDesc(bad.body, 'invalid_client_metadata', 'redirect_uris is required');
    expect(ok.body.client_id).toMatch(/^client_/);
  });

  for (let i = 0; i < 12; i++) {
    it(`redirect_uris is required flood-${i}`, async () => {
      const env = makeEnv({ cache: mockKv() });
      const results = await Promise.all([
        registerClient(env, {
          client_name: `B${i}`,
          redirect_uris: i % 2 === 0 ? [] : undefined,
          token_endpoint_auth_method: 'none',
        }),
        registerClient(env, {
          client_name: `G${i}`,
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
        }),
      ]);
      expect(statusesOf(results)).toEqual([201, 400]);
      expect(results.find((r) => r.status === 400)!.body.error_description).toBe(
        'redirect_uris is required'
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Token client_id is required ∥ redeem ok
// ---------------------------------------------------------------------------

describe('quinary oauth token client_id is required ∥ redeem after #277 tip', () => {
  it('missing client_id ∥ redeem — binds client_id is required', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-cid-ok');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          code: 'unused-no-client',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'code-cid-ok',
        }),
        env
      ),
    ]);
    const bad = results.find((r) => r.status === 400)!;
    const ok = results.find((r) => r.status === 200)!;
    expectErrDesc(bad.body, 'invalid_client', 'client_id is required');
    expect(ok.body.access_token).toBeTruthy();
    expect(ok.body.user_id).toBe(USER_ID);
  });

  for (let i = 0; i < 12; i++) {
    it(`token client_id is required flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const sessions = mockKv();
      seedAuthCode(sessions, `code-cid-f-${i}`);
      const env = makeEnv({ cache, sessions, db: aliceDb() });
      const results = await Promise.all([
        request(
          '/oauth/token',
          urlencoded({ grant_type: 'authorization_code', code: `x-${i}` }),
          env
        ),
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'authorization_code',
            client_id: 'cid-1',
            code: `code-cid-f-${i}`,
          }),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400]);
      expect(results.find((r) => r.status === 400)!.body.error_description).toBe(
        'client_id is required'
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Token Unknown client (401) — description never in tests; distinct from authorize 400
// ---------------------------------------------------------------------------

describe('quinary oauth token Unknown client 401 ∥ redeem after #277 tip', () => {
  it('unknown client_id ∥ known redeem — binds Unknown client at 401', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-unk-ok');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'nope-client',
          code: 'whatever',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'code-unk-ok',
        }),
        env
      ),
    ]);
    const bad = results.find((r) => r.status === 401)!;
    const ok = results.find((r) => r.status === 200)!;
    expectErrDesc(bad.body, 'invalid_client', 'Unknown client');
    expect(ok.body.access_token).toBeTruthy();
  });

  for (let i = 0; i < 12; i++) {
    it(`token Unknown client 401 flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const sessions = mockKv();
      seedAuthCode(sessions, `code-unk-f-${i}`);
      const env = makeEnv({ cache, sessions, db: aliceDb() });
      const results = await Promise.all([
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'authorization_code',
            client_id: `ghost-tok-${i}`,
            code: 'x',
          }),
          env
        ),
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'authorization_code',
            client_id: 'cid-1',
            code: `code-unk-f-${i}`,
          }),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 401]);
      expect(results.find((r) => r.status === 401)!.body).toEqual({
        error: 'invalid_client',
        error_description: 'Unknown client',
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Confidential: client_secret is required / Invalid client credentials ∥ ok
// ---------------------------------------------------------------------------

describe('quinary oauth confidential client_secret races after #277 tip', () => {
  it('miss-secret ∥ wrong-secret ∥ ok redeem — exclusive descriptions', async () => {
    const cache = mockKv();
    await seedConfidentialClient(cache, 'cid-conf', 'super-secret');
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-conf-ok', { client_id: 'cid-conf' });
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-conf',
          code: 'unused-miss',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-conf',
          client_secret: 'wrong-secret',
          code: 'unused-wrong',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-conf',
          client_secret: 'super-secret',
          code: 'code-conf-ok',
        }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 401, 401]);
    const miss = results.find((r) => r.body?.error_description === 'client_secret is required')!;
    const wrong = results.find(
      (r) => r.body?.error_description === 'Invalid client credentials'
    )!;
    const ok = results.find((r) => r.status === 200)!;
    expectErrDesc(miss.body, 'invalid_client', 'client_secret is required');
    expectErrDesc(wrong.body, 'invalid_client', 'Invalid client credentials');
    expect(ok.body.access_token).toBeTruthy();
  });

  for (let i = 0; i < 12; i++) {
    it(`confidential secret ladder flood-${i}`, async () => {
      const cache = mockKv();
      await seedConfidentialClient(cache, 'cid-conf', 'super-secret');
      const sessions = mockKv();
      seedAuthCode(sessions, `code-conf-f-${i}`, { client_id: 'cid-conf' });
      const env = makeEnv({ cache, sessions, db: aliceDb() });
      const results = await Promise.all([
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'authorization_code',
            client_id: 'cid-conf',
            code: `m-${i}`,
          }),
          env
        ),
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'authorization_code',
            client_id: 'cid-conf',
            client_secret: `bad-${i}`,
            code: `w-${i}`,
          }),
          env
        ),
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'authorization_code',
            client_id: 'cid-conf',
            client_secret: 'super-secret',
            code: `code-conf-f-${i}`,
          }),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 401, 401]);
      expect(
        results.some((r) => r.body?.error_description === 'client_secret is required')
      ).toBe(true);
      expect(
        results.some((r) => r.body?.error_description === 'Invalid client credentials')
      ).toBe(true);
      expect(results.find((r) => r.status === 200)!.body.access_token).toBeTruthy();
    });
  }
});

// ---------------------------------------------------------------------------
// Auth-code grant: code is required / Invalid or expired authorization code
// ---------------------------------------------------------------------------

describe('quinary oauth token code is required ∥ Invalid or expired after #277 tip', () => {
  it('miss-code ∥ missing-KV ∥ ok redeem — distinct descriptions', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-grant-ok');
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
          code: 'not-in-kv',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'code-grant-ok',
        }),
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 400, 400]);
    const miss = results.find((r) => r.body?.error_description === 'code is required')!;
    const invalid = results.find(
      (r) => r.body?.error_description === 'Invalid or expired authorization code'
    )!;
    const ok = results.find((r) => r.status === 200)!;
    expectErrDesc(miss.body, 'invalid_request', 'code is required');
    expectErrDesc(invalid.body, 'invalid_grant', 'Invalid or expired authorization code');
    expect(ok.body.access_token).toBeTruthy();
  });

  for (let i = 0; i < 12; i++) {
    it(`code required / invalid flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const sessions = mockKv();
      seedAuthCode(sessions, `code-grant-f-${i}`);
      const env = makeEnv({ cache, sessions, db: aliceDb() });
      const results = await Promise.all([
        request(
          '/oauth/token',
          urlencoded({ grant_type: 'authorization_code', client_id: 'cid-1' }),
          env
        ),
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'authorization_code',
            client_id: 'cid-1',
            code: `missing-${i}`,
          }),
          env
        ),
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'authorization_code',
            client_id: 'cid-1',
            code: `code-grant-f-${i}`,
          }),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400, 400]);
      expect(results.some((r) => r.body?.error_description === 'code is required')).toBe(true);
      expect(
        results.some(
          (r) => r.body?.error_description === 'Invalid or expired authorization code'
        )
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Refresh: refresh_token is required / Invalid refresh token
// ---------------------------------------------------------------------------

describe('quinary oauth refresh_token is required ∥ Invalid refresh after #277 tip', () => {
  it('miss ∥ invalid ∥ ok rotate — distinct descriptions', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedRefresh(sessions, 'rt-ok');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'refresh_token',
          client_id: 'cid-1',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'refresh_token',
          client_id: 'cid-1',
          refresh_token: 'not-a-token',
        }),
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
    expect(statusesOf(results)).toEqual([200, 400, 400]);
    const miss = results.find((r) => r.body?.error_description === 'refresh_token is required')!;
    const invalid = results.find((r) => r.body?.error_description === 'Invalid refresh token')!;
    const ok = results.find((r) => r.status === 200)!;
    expectErrDesc(miss.body, 'invalid_request', 'refresh_token is required');
    expectErrDesc(invalid.body, 'invalid_grant', 'Invalid refresh token');
    expect(ok.body.access_token).toBeTruthy();
    expect(ok.body.refresh_token).toBeTruthy();
  });

  for (let i = 0; i < 12; i++) {
    it(`refresh required / invalid flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const sessions = mockKv();
      seedRefresh(sessions, `rt-ok-${i}`);
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
            refresh_token: `bad-${i}`,
          }),
          env
        ),
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
      expect(statusesOf(results)).toEqual([200, 400, 400]);
      expect(
        results.some((r) => r.body?.error_description === 'refresh_token is required')
      ).toBe(true);
      expect(results.some((r) => r.body?.error_description === 'Invalid refresh token')).toBe(
        true
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Unsupported grant — description never in any test/
// ---------------------------------------------------------------------------

describe('quinary oauth unsupported_grant_type exact description after #277 tip', () => {
  it('client_credentials ∥ auth_code ok — binds Only authorization_code and refresh_token…', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const sessions = mockKv();
    seedAuthCode(sessions, 'code-ug-ok');
    const env = makeEnv({ cache, sessions, db: aliceDb() });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'client_credentials',
          client_id: 'cid-1',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-1',
          code: 'code-ug-ok',
        }),
        env
      ),
    ]);
    const bad = results.find((r) => r.status === 400)!;
    const ok = results.find((r) => r.status === 200)!;
    expectErrDesc(
      bad.body,
      'unsupported_grant_type',
      'Only authorization_code and refresh_token grants are supported'
    );
    expect(ok.body.access_token).toBeTruthy();
  });

  for (let i = 0; i < 12; i++) {
    it(`unsupported grant description flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const sessions = mockKv();
      seedAuthCode(sessions, `code-ug-f-${i}`);
      const env = makeEnv({ cache, sessions, db: aliceDb() });
      const gt =
        i % 4 === 0
          ? 'client_credentials'
          : i % 4 === 1
            ? 'password'
            : i % 4 === 2
              ? 'implicit'
              : 'urn:ietf:params:oauth:grant-type:device_code';
      const results = await Promise.all([
        request(
          '/oauth/token',
          urlencoded({ grant_type: gt, client_id: 'cid-1' }),
          env
        ),
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'authorization_code',
            client_id: 'cid-1',
            code: `code-ug-f-${i}`,
          }),
          env
        ),
        request(
          '/oauth/token',
          urlencoded({ grant_type: 'foo', client_id: 'cid-1' }),
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400, 400]);
      const bads = results.filter((r) => r.status === 400);
      expect(
        bads.every(
          (r) =>
            r.body.error_description ===
            'Only authorization_code and refresh_token grants are supported'
        )
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Revoke + introspect token is required ∥ active introspect
// ---------------------------------------------------------------------------

describe('quinary oauth revoke+introspect token is required after #277 tip', () => {
  it('revoke miss ∥ introspect miss ∥ active introspect — binds token is required', async () => {
    const db = aliceDb();
    const tok = 'at-intro-active';
    db.tokensByHash.set(await hashToken(tok), {
      user_id: USER_ID,
      device_id: 'INTRO',
      created_at: NOW,
    });
    const env = makeEnv({ db });
    const results = await Promise.all([
      request('/oauth/revoke', urlencoded({}), env),
      request('/oauth/introspect', urlencoded({}), env),
      request('/oauth/introspect', urlencoded({ token: tok }), env),
    ]);
    const bads = results.filter((r) => r.status === 400);
    const ok = results.find((r) => r.status === 200)!;
    expect(bads.length).toBe(2);
    expect(bads.every((r) => r.body.error_description === 'token is required')).toBe(true);
    expect(bads.every((r) => r.body.error === 'invalid_request')).toBe(true);
    expect(Object.keys(bads[0].body).sort()).toEqual(['error', 'error_description']);
    expect(ok.body.active).toBe(true);
    expect(ok.body.sub).toBe(USER_ID);
  });

  for (let i = 0; i < 12; i++) {
    it(`token is required revoke+introspect flood-${i}`, async () => {
      const db = aliceDb();
      const tok = `at-intro-f-${i}`;
      db.tokensByHash.set(await hashToken(tok), {
        user_id: USER_ID,
        device_id: `IF${i}`,
        created_at: NOW,
      });
      const env = makeEnv({ db });
      const results = await Promise.all([
        request('/oauth/revoke', urlencoded({ token_type_hint: 'refresh_token' }), env),
        request('/oauth/introspect', jsonInit('POST', {}), env),
        request('/oauth/introspect', urlencoded({ token: tok }), env),
        request('/oauth/revoke', jsonInit('POST', { token_type_hint: 'access_token' }), env),
      ]);
      const bads = results.filter((r) => r.status === 400);
      expect(bads.length).toBe(3);
      expect(bads.every((r) => r.body.error_description === 'token is required')).toBe(true);
      expect(results.find((r) => r.status === 200)!.body.active).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Cross-niche authorize matrix under single Promise.all
// ---------------------------------------------------------------------------

describe('quinary oauth authorize description matrix under race after #277 tip', () => {
  it('five distinct authorize descriptions ∥ one HTML success', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-1');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request(authorizeQs({ redirect_uri: REDIRECT, response_type: 'code' }), {}, env),
      request(authorizeQs({ client_id: 'cid-1', response_type: 'code' }), {}, env),
      request(
        authorizeQs({
          client_id: 'cid-1',
          redirect_uri: REDIRECT,
          response_type: 'token',
        }),
        {},
        env
      ),
      request(
        authorizeQs({
          client_id: 'ghost',
          redirect_uri: REDIRECT,
          response_type: 'code',
        }),
        {},
        env
      ),
      request(
        authorizeQs({
          client_id: 'cid-1',
          redirect_uri: EVIL_REDIRECT,
          response_type: 'code',
        }),
        {},
        env
      ),
      request(
        authorizeQs({
          client_id: 'cid-1',
          redirect_uri: REDIRECT,
          response_type: 'code',
        }),
        {},
        env
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 400, 400, 400, 400, 400]);
    const descs = results
      .filter((r) => r.status === 400)
      .map((r) => r.body.error_description)
      .sort();
    expect(descs).toEqual([
      'Invalid redirect_uri',
      'Only code response type is supported',
      'Unknown client',
      'client_id is required',
      'redirect_uri is required',
    ]);
    expect(results.find((r) => r.status === 200)!.text).toContain('Element Web');
  });

  for (let i = 0; i < 8; i++) {
    it(`authorize description matrix flood-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cid-1');
      const env = makeEnv({ cache });
      const results = await Promise.all([
        request(authorizeQs({ redirect_uri: REDIRECT, response_type: 'code' }), {}, env),
        request(
          authorizeQs({
            client_id: 'cid-1',
            redirect_uri: REDIRECT,
            response_type: 'id_token',
          }),
          {},
          env
        ),
        request(
          authorizeQs({
            client_id: `g-${i}`,
            redirect_uri: REDIRECT,
            response_type: 'code',
          }),
          {},
          env
        ),
        request(
          authorizeQs({
            client_id: 'cid-1',
            redirect_uri: REDIRECT,
            response_type: 'code',
          }),
          {},
          env
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 400, 400, 400]);
      const descs = new Set(
        results.filter((r) => r.status === 400).map((r) => r.body.error_description)
      );
      expect(descs.has('client_id is required')).toBe(true);
      expect(descs.has('Only code response type is supported')).toBe(true);
      expect(descs.has('Unknown client')).toBe(true);
    });
  }
});
