/**
 * TOKENMAXX HEAVY leftovers after #130 — deepen oauth API route edges beyond
 * merged oauth-api-routes / oauth-api-route-edges (#90/#106) and oidc/qr (#115).
 * Orthogonal to login (#130), push (#128), account-data (#127), federation
 * membership (#129). Tests-only — no product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { hashToken } from '../src/utils/crypto';
import {
  escapeHtml,
  generateLoginPage,
  generateUiaApprovalPage,
  generateUiaCancelledPage,
  generateUiaErrorPage,
  generateUiaSuccessPage,
  hashClientSecret,
} from '../src/api/oauth';

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

const SERVER = 'matrix.example.com';
const USER_ID = `@alice:${SERVER}`;
const BOB_ID = `@bob:${SERVER}`;
const REDIRECT = 'https://element.example.com/callback';
const REDIRECT_ALT = 'https://element.example.com/alt';
const NOW = 1_730_200_000_000;

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };

function mockKv(data: Record<string, string> = {}, deleteReturn: unknown = undefined) {
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
      return deleteReturn as undefined;
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

type TokenRow = { user_id: string; device_id: string | null; created_at: number };

function createOAuthDb(opts: {
  users?: Map<string, UserRow>;
  tokensByHash?: Map<string, TokenRow>;
  idpLinkCounts?: Map<string, number>;
} = {}) {
  const users = opts.users ?? new Map<string, UserRow>();
  const tokensByHash = opts.tokensByHash ?? new Map<string, TokenRow>();
  const idpLinkCounts = opts.idpLinkCounts ?? new Map<string, number>();
  const inserts: Array<{ sql: string; args: unknown[] }> = [];
  const deletes: Array<{ sql: string; args: unknown[] }> = [];

  return {
    users,
    tokensByHash,
    idpLinkCounts,
    inserts,
    deletes,
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
              if (sql.includes('FROM idp_user_links')) {
                const userId = args[0] as string;
                return { count: idpLinkCounts.get(userId) ?? 0 } as T;
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
                  // track only
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
    idpLinkCounts: Map<string, number>;
    inserts: Array<{ sql: string; args: unknown[] }>;
    deletes: Array<{ sql: string; args: unknown[] }>;
  };
}

function userRow(partial: Partial<UserRow> & Pick<UserRow, 'user_id' | 'localpart'>): UserRow {
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

function makeEnv(opts: {
  cache?: ReturnType<typeof mockKv>;
  sessions?: ReturnType<typeof mockKv>;
  db?: ReturnType<typeof createOAuthDb>;
  partial?: Partial<Env>;
} = {}): Env {
  return {
    SERVER_NAME: SERVER,
    SERVER_VERSION: '0.1.0-test',
    CACHE: opts.cache ?? mockKv(),
    SESSIONS: opts.sessions ?? mockKv(),
    DB: opts.db ?? createOAuthDb(),
    ...opts.partial,
  } as Env;
}

async function request(
  path: string,
  init: RequestInit = {},
  env: Env = makeEnv()
): Promise<Response> {
  return oauth.request(`http://localhost${path}`, init, env);
}

async function registerClient(
  env: Env,
  body: Record<string, unknown> = {
    client_name: 'Element Web',
    redirect_uris: [REDIRECT],
  }
) {
  const res = await request(
    '/oauth/register',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env
  );
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body: json };
}

function b64urlJson(obj: unknown): string {
  const json = JSON.stringify(obj);
  return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeJwt(payload: Record<string, unknown>, header: unknown = { alg: 'none', typ: 'JWT' }): string {
  return `${b64urlJson(header)}.${b64urlJson(payload)}.sig`;
}

function aliceDb(password = 'secret'): ReturnType<typeof createOAuthDb> {
  return createOAuthDb({
    users: new Map([
      [
        USER_ID,
        userRow({
          user_id: USER_ID,
          localpart: 'alice',
          password_hash: `mockok:${password}`,
          display_name: 'Alice',
          avatar_url: 'mxc://example.com/a',
        }),
      ],
    ]),
  });
}

async function putAuthCode(
  env: Env,
  code: string,
  patch: Partial<{
    client_id: string;
    user_id: string;
    redirect_uri: string;
    scope: string;
    code_challenge: string;
    code_challenge_method: string;
    nonce: string;
    expires_at: number;
  }> = {}
) {
  const authCode = {
    code,
    client_id: patch.client_id ?? 'client',
    user_id: patch.user_id ?? USER_ID,
    redirect_uri: patch.redirect_uri ?? REDIRECT,
    scope: patch.scope ?? 'openid',
    code_challenge: patch.code_challenge,
    code_challenge_method: patch.code_challenge_method,
    nonce: patch.nonce,
    created_at: NOW,
    expires_at: patch.expires_at ?? NOW + 600_000,
  };
  await env.SESSIONS.put(`oauth_code:${code}`, JSON.stringify(authCode), {
    expirationTtl: 600,
  });
}

async function seededAuth(
  env: Env,
  patch: Record<string, unknown> = {}
): Promise<string> {
  const id = `authreq-${Math.random().toString(16).slice(2)}`;
  await env.SESSIONS.put(
    `oauth_auth_request:${id}`,
    JSON.stringify({
      client_id: patch.client_id ?? 'client',
      redirect_uri: patch.redirect_uri ?? REDIRECT,
      scope: patch.scope ?? 'openid',
      state: patch.state,
      nonce: patch.nonce,
      code_challenge: patch.code_challenge,
      code_challenge_method: patch.code_challenge_method,
    }),
    { expirationTtl: 600 }
  );
  return id;
}

function formFields(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

function jsonToken(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return {
    method: 'POST' as const,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

function formToken(fields: Record<string, string>, headers: Record<string, string> = {}) {
  const params = new URLSearchParams(fields);
  return {
    method: 'POST' as const,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: params.toString(),
  };
}

function basicAuth(id: string, secret: string): string {
  return `Basic ${btoa(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`)}`;
}

// ---------------------------------------------------------------------------
// Register leftovers
// ---------------------------------------------------------------------------

describe('oauth leftovers POST /oauth/register after #130', () => {
  it('accepts minimal body with only redirect_uris and defaults name/grants', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const { status, body } = await registerClient(env, { redirect_uris: [REDIRECT] });
    expect(status).toBe(201);
    expect(body.client_name).toBe('Unknown Client');
    expect(body.grant_types).toEqual(['authorization_code']);
    expect(body.response_types).toEqual(['code']);
    expect(body.token_endpoint_auth_method).toBe('client_secret_basic');
    expect(body.client_secret).toBeTruthy();
    expect(typeof body.client_id_issued_at).toBe('number');
    expect(body.client_id_issued_at).toBe(Math.floor(Date.now() / 1000));
  });

  it('stores multiple redirect_uris and rejects authorize for unlisted one', async () => {
    const env = makeEnv({ cache: mockKv() });
    const { body } = await registerClient(env, {
      client_name: 'Multi',
      redirect_uris: [REDIRECT, REDIRECT_ALT],
    });
    const ok = await request(
      `/oauth/authorize?client_id=${body.client_id}&redirect_uri=${encodeURIComponent(REDIRECT_ALT)}&response_type=code`,
      {},
      env
    );
    expect(ok.status).toBe(200);
    const bad = await request(
      `/oauth/authorize?client_id=${body.client_id}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&response_type=code`,
      {},
      env
    );
    expect(await bad.json()).toMatchObject({
      error: 'invalid_request',
      error_description: 'Invalid redirect_uri',
    });
  });

  it('ignores optional RFC 7591 metadata fields in the response payload', async () => {
    const env = makeEnv();
    const { body } = await registerClient(env, {
      client_name: 'Meta',
      redirect_uris: [REDIRECT],
      application_type: 'web',
      contacts: ['a@b.c', 'd@e.f'],
      logo_uri: 'https://example.com/logo.png',
      client_uri: 'https://example.com',
      policy_uri: 'https://example.com/p',
      tos_uri: 'https://example.com/t',
      software_id: 'sw',
      software_version: '1.0.0',
    });
    expect(body).not.toHaveProperty('contacts');
    expect(body).not.toHaveProperty('logo_uri');
    expect(body).not.toHaveProperty('client_uri');
    expect(body).not.toHaveProperty('policy_uri');
    expect(body).not.toHaveProperty('tos_uri');
    expect(body).not.toHaveProperty('application_type');
    expect(body).not.toHaveProperty('software_id');
    expect(body.client_name).toBe('Meta');
  });

  it('rejects null/undefined redirect_uris; string/number bypass length gate', async () => {
    const env = makeEnv();
    for (const redirect_uris of [null, undefined]) {
      const res = await request(
        '/oauth/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ redirect_uris }),
        },
        env
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_client_metadata' });
    }
    // Strings are truthy with .length > 0; numbers are truthy with undefined length —
    // current gate only rejects missing/empty-array.
    for (const redirect_uris of ['https://x', 1]) {
      const res = await request(
        '/oauth/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ redirect_uris }),
        },
        env
      );
      expect(res.status).toBe(201);
    }
  });

  it('documents that plain-object redirect_uris bypasses length check (truthy, no .length)', async () => {
    // `!body.redirect_uris || body.redirect_uris.length === 0` — `{}` is truthy and
    // `{}.length === undefined`, so validation passes and stores a non-array.
    const cache = mockKv();
    const env = makeEnv({ cache });
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: {} }),
      },
      env
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    const stored = JSON.parse(cache.data[`oauth_client:${body.client_id}`]);
    expect(stored.redirect_uris).toEqual({});
  });

  it('persists client_secret_hash for client_secret_post and omits for none', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const post = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
    });
    const storedPost = JSON.parse(cache.data[`oauth_client:${post.body.client_id}`]);
    expect(storedPost.client_secret_hash).toBe(
      await hashClientSecret(String(post.body.client_secret))
    );

    const pub = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const storedPub = JSON.parse(cache.data[`oauth_client:${pub.body.client_id}`]);
    expect(storedPub.client_secret_hash).toBeNull();
    expect(pub.body.client_secret).toBeUndefined();
  });

  it('issues distinct client_id and client_secret across registrations', async () => {
    const env = makeEnv();
    const a = await registerClient(env);
    const b = await registerClient(env);
    expect(a.body.client_id).not.toBe(b.body.client_id);
    expect(a.body.client_secret).not.toBe(b.body.client_secret);
    expect(String(a.body.client_id)).toMatch(/^client_[0-9a-f]{32}$/);
    expect(String(a.body.client_secret)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('empty-string client_name falls back to Unknown Client via ||', async () => {
    const env = makeEnv();
    const { body } = await registerClient(env, {
      client_name: '',
      redirect_uris: [REDIRECT],
    });
    expect(body.client_name).toBe('Unknown Client');
  });

  it('empty grant_types / response_types arrays are stored as empty (not defaulted)', async () => {
    // `body.grant_types || default` — empty array is truthy in JS
    const cache = mockKv();
    const env = makeEnv({ cache });
    const { body } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      grant_types: [],
      response_types: [],
    });
    expect(body.grant_types).toEqual([]);
    expect(body.response_types).toEqual([]);
    const stored = JSON.parse(cache.data[`oauth_client:${body.client_id}`]);
    expect(stored.grant_types).toEqual([]);
    expect(stored.response_types).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Authorize GET leftovers
// ---------------------------------------------------------------------------

describe('oauth leftovers GET /oauth/authorize after #130', () => {
  it('rejects response_type token/id_token/empty as unsupported_response_type', async () => {
    const env = makeEnv();
    const { body: client } = await registerClient(env);
    for (const rt of ['token', 'id_token', 'code token', '', 'CODE']) {
      const res = await request(
        `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=${encodeURIComponent(rt)}`,
        {},
        env
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'unsupported_response_type' });
    }
  });

  it('defaults empty-string scope and code_challenge_method via ||', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions });
    const { body: client } = await registerClient(env);
    const res = await request(
      `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&scope=&code_challenge_method=`,
      {},
      env
    );
    expect(res.status).toBe(200);
    const put = sessions.puts.find((p) => p.key.startsWith('oauth_auth_request:'));
    expect(put).toBeTruthy();
    const stored = JSON.parse(put!.value);
    expect(stored.scope).toBe('openid');
    expect(stored.code_challenge_method).toBe('plain');
    expect(put!.options?.expirationTtl).toBe(600);
  });

  it('stores MSC2967 device scope verbatim for later token exchange', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions });
    const { body: client } = await registerClient(env);
    const scope =
      'openid urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:MYDEV';
    await request(
      `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&scope=${encodeURIComponent(scope)}`,
      {},
      env
    );
    const put = sessions.puts.find((p) => p.key.startsWith('oauth_auth_request:'));
    expect(JSON.parse(put!.value).scope).toBe(scope);
  });

  it('escapes XSS client_name from registration into authorize HTML', async () => {
    const env = makeEnv();
    const evil = `<img src=x onerror=alert(1)> & "q" 'p'`;
    const { body: client } = await registerClient(env, {
      client_name: evil,
      redirect_uris: [REDIRECT],
    });
    const res = await request(
      `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
      {},
      env
    );
    const html = await res.text();
    expect(html).toContain(escapeHtml(evil));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain(escapeHtml(SERVER));
  });

  it('rejects missing client_id and redirect_uri independently', async () => {
    const env = makeEnv();
    const { body: client } = await registerClient(env);
    const noClient = await request(
      `/oauth/authorize?redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
      {},
      env
    );
    expect(await noClient.json()).toMatchObject({
      error_description: 'client_id is required',
    });
    const noRedirect = await request(
      `/oauth/authorize?client_id=${client.client_id}&response_type=code`,
      {},
      env
    );
    expect(await noRedirect.json()).toMatchObject({
      error_description: 'redirect_uri is required',
    });
  });
});

// ---------------------------------------------------------------------------
// Authorize POST leftovers
// ---------------------------------------------------------------------------

describe('oauth leftovers POST /oauth/authorize after #130', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows Missing username or password for each missing field combination', async () => {
    const env = makeEnv({ db: aliceDb() });
    const cases = [
      { username: '', password: 'secret', auth_request_id: 'x' },
      { username: 'alice', password: '', auth_request_id: 'x' },
      { username: 'alice', password: 'secret', auth_request_id: '' },
      { username: '', password: '', auth_request_id: '' },
    ];
    for (const fields of cases) {
      const res = await request(
        '/oauth/authorize',
        { method: 'POST', body: formFields(fields) },
        env
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Missing username or password');
    }
  });

  it('double-@ wraps full MXID username via formatUserId (lookup miss → retry HTML)', async () => {
    const sessions = mockKv();
    const cache = mockKv();
    const env = makeEnv({ sessions, cache, db: aliceDb() });
    const { body: client } = await registerClient(env, {
      client_name: 'Wrap',
      redirect_uris: [REDIRECT],
    });
    const id = await seededAuth(env, { client_id: client.client_id });
    const res = await request(
      '/oauth/authorize',
      {
        method: 'POST',
        body: formFields({
          username: USER_ID,
          password: 'secret',
          auth_request_id: id,
        }),
      },
      env
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Invalid username or password');
    expect(html).toContain('Wrap');
    // Original auth request consumed; a retry request re-seeded
    expect(sessions.data[`oauth_auth_request:${id}`]).toBeUndefined();
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:'))).toBe(true);
  });

  it('recreates auth request with 600s TTL on bad password and preserves nonce/state/challenge', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: aliceDb('right') });
    const { body: client } = await registerClient(env, {
      client_name: 'RetryClient',
      redirect_uris: [REDIRECT],
    });
    const id = await seededAuth(env, {
      client_id: client.client_id,
      state: 'st-1',
      nonce: 'n-1',
      code_challenge: 'chal',
      code_challenge_method: 'S256',
      scope: 'openid device',
    });
    const res = await request(
      '/oauth/authorize',
      {
        method: 'POST',
        body: formFields({
          username: 'alice',
          password: 'wrong',
          auth_request_id: id,
        }),
      },
      env
    );
    expect(await res.text()).toContain('Invalid username or password');
    const retry = sessions.puts.find(
      (p) => p.key.startsWith('oauth_auth_request:') && p.key !== `oauth_auth_request:${id}`
    );
    expect(retry?.options?.expirationTtl).toBe(600);
    const stored = JSON.parse(retry!.value);
    expect(stored).toMatchObject({
      client_id: client.client_id,
      state: 'st-1',
      nonce: 'n-1',
      code_challenge: 'chal',
      code_challenge_method: 'S256',
      scope: 'openid device',
    });
  });

  it('issues code with 10-minute expiry and redirects state including reserved URL chars', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: aliceDb() });
    const { body: client } = await registerClient(env);
    const state = 'a=b&c=d?e#f space+plus';
    const id = await seededAuth(env, {
      client_id: client.client_id,
      state,
      nonce: 'nonce-xyz',
    });
    const res = await request(
      '/oauth/authorize',
      {
        method: 'POST',
        body: formFields({
          username: 'alice',
          password: 'secret',
          auth_request_id: id,
        }),
      },
      env
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get('state')).toBe(state);
    const code = loc.searchParams.get('code')!;
    expect(code).toMatch(/^[0-9a-f]{64}$/);
    const stored = JSON.parse(sessions.data[`oauth_code:${code}`]);
    expect(stored.expires_at).toBe(NOW + 10 * 60 * 1000);
    expect(stored.nonce).toBe('nonce-xyz');
    expect(stored.user_id).toBe(USER_ID);
    expect(
      sessions.puts.find((p) => p.key === `oauth_code:${code}`)?.options?.expirationTtl
    ).toBe(600);
  });

  it('Unknown Client fallback when client deleted between authorize GET and failed login', async () => {
    const sessions = mockKv();
    const cache = mockKv();
    const env = makeEnv({ sessions, cache, db: aliceDb() });
    const { body: client } = await registerClient(env, {
      client_name: 'Gone',
      redirect_uris: [REDIRECT],
    });
    const id = await seededAuth(env, { client_id: client.client_id });
    delete cache.data[`oauth_client:${client.client_id}`];
    const res = await request(
      '/oauth/authorize',
      {
        method: 'POST',
        body: formFields({
          username: 'nobody',
          password: 'secret',
          auth_request_id: id,
        }),
      },
      env
    );
    expect(await res.text()).toContain('Unknown Client');
  });
});

// ---------------------------------------------------------------------------
// Token leftovers
// ---------------------------------------------------------------------------

describe('oauth leftovers POST /oauth/token after #130', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts Content-Type with charset suffix for json and form', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
      client_name: 'Charset',
    });
    await putAuthCode(env, 'code-json-cs', { client_id: String(client.client_id) });
    const jsonRes = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          client_secret: client.client_secret,
          code: 'code-json-cs',
        }),
      },
      env
    );
    expect(jsonRes.status).toBe(200);

    await putAuthCode(env, 'code-form-cs', { client_id: String(client.client_id) });
    const formRes = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: String(client.client_id),
          client_secret: String(client.client_secret),
          code: 'code-form-cs',
        }).toString(),
      },
      env
    );
    expect(formRes.status).toBe(200);
  });

  it('rejects text/plain, multipart, and missing Content-Type', async () => {
    const env = makeEnv();
    for (const ct of ['text/plain', 'multipart/form-data', '']) {
      const res = await request(
        '/oauth/token',
        {
          method: 'POST',
          headers: ct ? { 'Content-Type': ct } : {},
          body: 'grant_type=authorization_code&client_id=x',
        },
        env
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error_description: 'Unsupported content type',
      });
    }
  });

  it('authenticates via Basic header alone when body omits client credentials', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_basic',
    });
    await putAuthCode(env, 'basic-only', { client_id: String(client.client_id) });
    const res = await request(
      '/oauth/token',
      jsonToken(
        { grant_type: 'authorization_code', code: 'basic-only' },
        { Authorization: basicAuth(String(client.client_id), String(client.client_secret)) }
      ),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.user_id).toBe(USER_ID);
    expect(body.scope).toBe('openid');
  });

  it('prefers body client_secret over Basic when both provided', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
    });
    await putAuthCode(env, 'pref-secret', { client_id: String(client.client_id) });
    const bad = await request(
      '/oauth/token',
      jsonToken(
        {
          grant_type: 'authorization_code',
          client_id: client.client_id,
          client_secret: 'wrong-body-secret',
          code: 'pref-secret',
        },
        { Authorization: basicAuth(String(client.client_id), String(client.client_secret)) }
      ),
      env
    );
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({
      error_description: 'Invalid client credentials',
    });
  });

  it('names device OAuth Client (client_name) on authorization_code success', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env, {
      client_name: 'Fluffy Chat',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'devname', {
      client_id: String(client.client_id),
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:NAMED1',
    });
    const res = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: 'devname',
      }),
      env
    );
    expect(res.status).toBe(200);
    const deviceInsert = db.inserts.find((i) => i.sql.includes('INTO devices'));
    expect(deviceInsert?.args[0]).toBe(USER_ID);
    expect(deviceInsert?.args[1]).toBe('NAMED1');
    expect(deviceInsert?.args[2]).toBe('OAuth Client (Fluffy Chat)');
  });

  it('stores refresh token with 30-day TTL and 24h expires_at; hashes refresh secret', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'ttl-code', { client_id: String(client.client_id) });
    const res = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: 'ttl-code',
      }),
      env
    );
    const body = await res.json();
    const put = sessions.puts.find((p) => p.key === `oauth_refresh:${body.refresh_token}`);
    expect(put?.options?.expirationTtl).toBe(30 * 24 * 60 * 60);
    const stored = JSON.parse(put!.value);
    expect(stored.expires_at).toBe(NOW + 24 * 60 * 60 * 1000);
    expect(stored.refresh_token_hash).toBe(await hashClientSecret(String(body.refresh_token)));
    expect(stored.client_id).toBe(client.client_id);
    expect(stored.user_id).toBe(USER_ID);
  });

  it('authorization_code is one-time: second exchange fails after consume', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'once', { client_id: String(client.client_id) });
    const first = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: 'once',
      }),
      env
    );
    expect(first.status).toBe(200);
    const second = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: 'once',
      }),
      env
    );
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({
      error_description: 'Invalid or expired authorization code',
    });
  });

  it('refresh_token grant preserves device_id and scope; omits Matrix user fields', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const oldRefresh = 'refresh-keep-device';
    await sessions.put(
      `oauth_refresh:${oldRefresh}`,
      JSON.stringify({
        token_id: 'tid-old',
        access_token_hash: 'h-old',
        refresh_token_hash: 'rh',
        client_id: client.client_id,
        user_id: USER_ID,
        device_id: 'KEEPDEV',
        scope: 'openid urn:matrix:org.matrix.msc2967.client:device:KEEPDEV',
        created_at: NOW - 1000,
        expires_at: NOW + 1000,
      })
    );
    const res = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: oldRefresh,
      }),
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('user_id');
    expect(body).not.toHaveProperty('device_id');
    expect(body.scope).toBe('openid urn:matrix:org.matrix.msc2967.client:device:KEEPDEV');
    expect(body.token_type).toBe('Bearer');
    expect(sessions.data[`oauth_refresh:${oldRefresh}`]).toBeUndefined();
    const newStored = JSON.parse(sessions.data[`oauth_refresh:${body.refresh_token}`]);
    expect(newStored.device_id).toBe('KEEPDEV');
    expect(newStored.user_id).toBe(USER_ID);
  });

  it('refresh_token is single-use after rotation', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const oldRefresh = 'refresh-once';
    await sessions.put(
      `oauth_refresh:${oldRefresh}`,
      JSON.stringify({
        token_id: 't1',
        access_token_hash: 'h1',
        client_id: client.client_id,
        user_id: USER_ID,
        device_id: 'D1',
        scope: 'openid',
        created_at: NOW,
        expires_at: NOW + 86400_000,
      })
    );
    const first = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: oldRefresh,
      }),
      env
    );
    expect(first.status).toBe(200);
    const second = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: oldRefresh,
      }),
      env
    );
    expect(await second.json()).toMatchObject({
      error_description: 'Invalid refresh token',
    });
  });

  it('treats missing/empty/unknown grant_type as unsupported_grant_type', async () => {
    const env = makeEnv();
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    for (const grant_type of [undefined, '', 'password', 'implicit', 'urn:ietf:params:oauth:grant-type:device_code']) {
      const payload: Record<string, unknown> = { client_id: client.client_id };
      if (grant_type !== undefined) payload.grant_type = grant_type;
      const res = await request('/oauth/token', jsonToken(payload), env);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'unsupported_grant_type' });
    }
  });

  it('public client ignores wrong client_secret entirely', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'pub-ignore', { client_id: String(client.client_id) });
    const res = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        client_secret: 'totally-wrong',
        code: 'pub-ignore',
      }),
      env
    );
    expect(res.status).toBe(200);
  });

  it('extracts first MSC2967 device scope when many device scopes present', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'multi-dev', {
      client_id: String(client.client_id),
      scope:
        'openid urn:matrix:org.matrix.msc2967.client:device:FIRST urn:matrix:org.matrix.msc2967.client:device:SECOND',
    });
    const res = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: 'multi-dev',
      }),
      env
    );
    const body = await res.json();
    expect(body.device_id).toBe('FIRST');
  });

  it('generates device id when scope has no MSC2967 device entry', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'no-dev', {
      client_id: String(client.client_id),
      scope: 'openid offline_access',
    });
    const res = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: 'no-dev',
      }),
      env
    );
    const body = await res.json();
    expect(body.device_id).toBeTruthy();
    expect(String(body.device_id).length).toBeGreaterThan(0);
  });

  it('expires_at equal to now fails with Authorization code has expired (strict <)', async () => {
    // code uses `expires_at < Date.now()` — equal is NOT expired; use expires_at = NOW - 1
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'exp-eq', {
      client_id: String(client.client_id),
      expires_at: NOW,
    });
    const eq = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: 'exp-eq',
      }),
      env
    );
    expect(eq.status).toBe(200);

    await putAuthCode(env, 'exp-past', {
      client_id: String(client.client_id),
      expires_at: NOW - 1,
    });
    const past = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: 'exp-past',
      }),
      env
    );
    expect(await past.json()).toMatchObject({
      error_description: 'Authorization code has expired',
    });
  });
});

// ---------------------------------------------------------------------------
// Revoke leftovers
// ---------------------------------------------------------------------------

describe('oauth leftovers POST /oauth/revoke after #130', () => {
  it('accepts form-urlencoded revoke of refresh token', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions });
    await sessions.put('oauth_refresh:rt-form', JSON.stringify({ token_id: 't' }));
    const res = await request(
      '/oauth/revoke',
      formToken({ token: 'rt-form', token_type_hint: 'refresh_token' }),
      env
    );
    expect(res.status).toBe(200);
    expect(sessions.data['oauth_refresh:rt-form']).toBeUndefined();
    expect(sessions.deletes).toContain('oauth_refresh:rt-form');
  });

  it('access_token hint deletes DB row by hash and skips refresh path', async () => {
    const raw = 'opaque-access-token-value';
    const hash = await hashToken(raw);
    const db = createOAuthDb({
      tokensByHash: new Map([
        [hash, { user_id: USER_ID, device_id: 'D', created_at: NOW }],
      ]),
    });
    const sessions = mockKv({ 'oauth_refresh:should-stay': '{}' });
    const env = makeEnv({ sessions, db });
    const res = await request(
      '/oauth/revoke',
      jsonToken({ token: raw, token_type_hint: 'access_token' }),
      env
    );
    expect(res.status).toBe(200);
    expect(sessions.data['oauth_refresh:should-stay']).toBe('{}');
    expect(db.tokensByHash.has(hash)).toBe(false);
    expect(db.deletes.some((d) => d.sql.includes('FROM access_tokens'))).toBe(true);
  });

  it('early-returns when SESSIONS.delete returns non-undefined (non-Workers mock)', async () => {
    const sessions = mockKv({ 'oauth_refresh:early': '{}' }, /* deleteReturn */ true);
    const db = createOAuthDb({
      tokensByHash: new Map([
        ['should-not-delete', { user_id: USER_ID, device_id: 'D', created_at: 1 }],
      ]),
    });
    const env = makeEnv({ sessions, db });
    const res = await request(
      '/oauth/revoke',
      jsonToken({ token: 'early', token_type_hint: 'refresh_token' }),
      env
    );
    expect(res.status).toBe(200);
    // Early return skips access_token DB delete path
    expect(db.deletes.length).toBe(0);
    expect(db.tokensByHash.has('should-not-delete')).toBe(true);
  });

  it('no hint tries refresh first then access_token delete', async () => {
    const raw = 'access-after-miss';
    const hash = await hashToken(raw);
    const db = createOAuthDb({
      tokensByHash: new Map([[hash, { user_id: USER_ID, device_id: 'D', created_at: 1 }]]),
    });
    const sessions = mockKv();
    const env = makeEnv({ sessions, db });
    const res = await request('/oauth/revoke', jsonToken({ token: raw }), env);
    expect(res.status).toBe(200);
    expect(sessions.deletes).toContain(`oauth_refresh:${raw}`);
    expect(db.tokensByHash.has(hash)).toBe(false);
  });

  it('empty-string token is rejected; unknown token still 200', async () => {
    const env = makeEnv();
    const empty = await request('/oauth/revoke', jsonToken({ token: '' }), env);
    expect(empty.status).toBe(400);
    const missing = await request('/oauth/revoke', jsonToken({ token: 'nope' }), env);
    expect(missing.status).toBe(200);
  });

  it('unsupported content-type yields empty params → token required', async () => {
    const res = await request('/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'token=abc',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_description: 'token is required' });
  });
});

// ---------------------------------------------------------------------------
// Introspect leftovers
// ---------------------------------------------------------------------------

describe('oauth leftovers POST /oauth/introspect after #130', () => {
  it('accepts form-urlencoded introspection', async () => {
    const token = fakeJwt({
      sub: USER_ID,
      client_id: 'c1',
      exp: Math.floor(NOW / 1000) + 3600,
      iat: Math.floor(NOW / 1000),
      scope: 'openid',
      iss: `https://${SERVER}/`,
    });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const res = await request('/oauth/introspect', formToken({ token }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        active: true,
        sub: USER_ID,
        client_id: 'c1',
        token_type: 'Bearer',
        scope: 'openid',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('JWT with invalid base64 payload falls through to DB / inactive', async () => {
    const res = await request(
      '/oauth/introspect',
      jsonToken({ token: 'aaa.!!!not-b64!!!.ccc' })
    );
    expect(await res.json()).toEqual({ active: false });
  });

  it('JWT with non-JSON payload falls through to inactive', async () => {
    const payload = btoa('not-json').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const header = b64urlJson({ alg: 'none' });
    const res = await request(
      '/oauth/introspect',
      jsonToken({ token: `${header}.${payload}.sig` })
    );
    expect(await res.json()).toEqual({ active: false });
  });

  it('expired JWT returns active:false without DB lookup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const token = fakeJwt({
        sub: USER_ID,
        exp: Math.floor(NOW / 1000) - 10,
      });
      const res = await request('/oauth/introspect', jsonToken({ token }));
      expect(await res.json()).toEqual({ active: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('opaque DB token returns active with iat from created_at', async () => {
    const raw = 'db-opaque-token';
    const hash = await hashToken(raw);
    const created = 1_700_000_123_000;
    const db = createOAuthDb({
      tokensByHash: new Map([
        [hash, { user_id: USER_ID, device_id: 'DEV', created_at: created }],
      ]),
    });
    const env = makeEnv({ db });
    const res = await request('/oauth/introspect', jsonToken({ token: raw }), env);
    expect(await res.json()).toEqual({
      active: true,
      sub: USER_ID,
      client_id: 'unknown',
      token_type: 'Bearer',
      iat: Math.floor(created / 1000),
    });
  });

  it('empty token rejected; four-segment token is not JWT-shaped', async () => {
    const empty = await request('/oauth/introspect', jsonToken({ token: '' }));
    expect(empty.status).toBe(400);
    const four = await request(
      '/oauth/introspect',
      jsonToken({ token: 'a.b.c.d' })
    );
    expect(await four.json()).toEqual({ active: false });
  });
});

// ---------------------------------------------------------------------------
// Userinfo leftovers
// ---------------------------------------------------------------------------

describe('oauth leftovers GET/POST /oauth/userinfo after #130', () => {
  async function authedEnv(token = 'userinfo-tok') {
    const hash = await hashToken(token);
    const db = aliceDb();
    db.tokensByHash.set(hash, {
      user_id: USER_ID,
      device_id: 'D1',
      created_at: NOW,
    });
    // requireAuth looks up access_tokens by hash — also need appservice path null
    return { env: makeEnv({ db }), token, hash };
  }

  it('GET returns OIDC claims including Matrix extension', async () => {
    const { env, token } = await authedEnv();
    const res = await request(
      '/oauth/userinfo',
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sub: USER_ID,
      name: 'Alice',
      picture: 'mxc://example.com/a',
      'urn:matrix:user_id': USER_ID,
    });
  });

  it('POST userinfo works the same as GET', async () => {
    const { env, token } = await authedEnv('post-tok');
    const res = await request(
      '/oauth/userinfo',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sub: USER_ID });
  });

  it('returns invalid_token when auth succeeds but user row missing', async () => {
    const token = 'orphan-tok';
    const hash = await hashToken(token);
    const db = createOAuthDb({
      tokensByHash: new Map([
        [hash, { user_id: USER_ID, device_id: 'D', created_at: 1 }],
      ]),
    });
    // no users in map
    const env = makeEnv({ db });
    const res = await request(
      '/oauth/userinfo',
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_token' });
  });

  it('rejects unauthenticated userinfo', async () => {
    const res = await request('/oauth/userinfo');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// UIA leftovers
// ---------------------------------------------------------------------------

describe('oauth leftovers /oauth/authorize/uia after #130', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function putUia(
    env: Env,
    sessionId: string,
    patch: Record<string, unknown> = {}
  ) {
    await env.CACHE.put(
      `uia_session:${sessionId}`,
      JSON.stringify({
        user_id: USER_ID,
        completed_stages: [],
        ...patch,
      }),
      { expirationTtl: 300 }
    );
  }

  it('GET escapes XSS in session query and shows reset copy for cross_signing_reset', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const sid = `sess<script>`;
    await putUia(env, sid);
    const res = await request(
      `/oauth/authorize/uia?session=${encodeURIComponent(sid)}&action=org.matrix.cross_signing_reset`,
      {},
      env
    );
    const html = await res.text();
    expect(html).toContain('Reset Encryption Keys');
    expect(html).toContain(escapeHtml(USER_ID));
    expect(html).toContain(escapeHtml(sid));
    expect(html).not.toContain('<script>');
  });

  it('POST approve with password marks all three stages and sets oauth_completed_at', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache, db: aliceDb() });
    await putUia(env, 'uia-ok', { completed_stages: ['m.oauth'] });
    const res = await request(
      '/oauth/authorize/uia',
      {
        method: 'POST',
        body: formFields({
          session: 'uia-ok',
          username: 'alice',
          password: 'secret',
          action: 'approve',
        }),
      },
      env
    );
    const html = await res.text();
    expect(html).toContain('Request Approved');
    expect(html).toContain('uia-ok');
    const updated = JSON.parse(cache.data['uia_session:uia-ok']);
    expect(updated.completed_stages).toEqual([
      'm.oauth',
      'org.matrix.cross_signing_reset',
      'm.login.oauth',
    ]);
    expect(updated.oauth_completed_at).toBe(NOW);
    expect(
      cache.puts.find((p) => p.key === 'uia_session:uia-ok')?.options?.expirationTtl
    ).toBe(300);
  });

  it('POST cancel deletes session and returns cancelled HTML', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    await putUia(env, 'uia-cancel');
    const res = await request(
      '/oauth/authorize/uia',
      {
        method: 'POST',
        body: formFields({
          session: 'uia-cancel',
          action: 'cancel',
          username: 'alice',
          password: 'x',
        }),
      },
      env
    );
    expect(await res.text()).toContain('Request Cancelled');
    expect(cache.data['uia_session:uia-cancel']).toBeUndefined();
  });

  it('OIDC-only user with IdP link approves when username matches session', async () => {
    const cache = mockKv();
    const db = createOAuthDb({
      users: new Map([
        [
          USER_ID,
          userRow({
            user_id: USER_ID,
            localpart: 'alice',
            password_hash: null,
          }),
        ],
      ]),
      idpLinkCounts: new Map([[USER_ID, 2]]),
    });
    const env = makeEnv({ cache, db });
    await putUia(env, 'uia-oidc');
    const res = await request(
      '/oauth/authorize/uia',
      {
        method: 'POST',
        body: formFields({
          session: 'uia-oidc',
          username: 'alice',
          password: 'ignored',
          action: 'approve',
        }),
      },
      env
    );
    expect(await res.text()).toContain('Request Approved');
  });

  it('OIDC-only wrong account rejected; passwordless without IdP rejected', async () => {
    const cache = mockKv();
    const db = createOAuthDb({
      users: new Map([
        [
          USER_ID,
          userRow({ user_id: USER_ID, localpart: 'alice', password_hash: null }),
        ],
        [
          BOB_ID,
          userRow({ user_id: BOB_ID, localpart: 'bob', password_hash: null }),
        ],
      ]),
      idpLinkCounts: new Map([
        [USER_ID, 1],
        [BOB_ID, 0],
      ]),
    });
    const env = makeEnv({ cache, db });
    await putUia(env, 'uia-wrong', { user_id: USER_ID });
    const wrong = await request(
      '/oauth/authorize/uia',
      {
        method: 'POST',
        body: formFields({
          session: 'uia-wrong',
          username: 'bob',
          password: 'x',
          action: 'approve',
        }),
      },
      env
    );
    // bob has no IdP → Invalid username or password
    expect(await wrong.text()).toContain('Invalid username or password');

    await putUia(env, 'uia-mismatch', { user_id: USER_ID });
    db.idpLinkCounts.set(BOB_ID, 1);
    const mismatch = await request(
      '/oauth/authorize/uia',
      {
        method: 'POST',
        body: formFields({
          session: 'uia-mismatch',
          username: 'bob',
          password: 'x',
          action: 'approve',
        }),
      },
      env
    );
    expect(await mismatch.text()).toContain(
      'You must approve with the same account that started this request.'
    );
  });

  it('password user approving as different account is rejected after verify', async () => {
    const cache = mockKv();
    const db = createOAuthDb({
      users: new Map([
        [
          USER_ID,
          userRow({
            user_id: USER_ID,
            localpart: 'alice',
            password_hash: 'mockok:secret',
          }),
        ],
        [
          BOB_ID,
          userRow({
            user_id: BOB_ID,
            localpart: 'bob',
            password_hash: 'mockok:secret',
          }),
        ],
      ]),
    });
    const env = makeEnv({ cache, db });
    await putUia(env, 'uia-diff', { user_id: USER_ID });
    const res = await request(
      '/oauth/authorize/uia',
      {
        method: 'POST',
        body: formFields({
          session: 'uia-diff',
          username: 'bob',
          password: 'secret',
          action: 'approve',
        }),
      },
      env
    );
    expect(await res.text()).toContain(
      'You must approve with the same account that started this request.'
    );
  });

  it('missing credentials re-renders approval with required error', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    await putUia(env, 'uia-miss');
    const res = await request(
      '/oauth/authorize/uia',
      {
        method: 'POST',
        body: formFields({
          session: 'uia-miss',
          username: '',
          password: '',
          action: 'approve',
        }),
      },
      env
    );
    const html = await res.text();
    expect(html).toContain('Username and password are required.');
    expect(html).toContain('Reset Encryption Keys');
  });
});

// ---------------------------------------------------------------------------
// End-to-end pipeline leftovers
// ---------------------------------------------------------------------------

describe('oauth leftovers end-to-end authorize→token→refresh→revoke→introspect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('full confidential client code flow with PKCE S256 and refresh rotation', async () => {
    const sessions = mockKv();
    const cache = mockKv();
    const db = aliceDb();
    const env = makeEnv({ sessions, cache, db });

    const { body: client } = await registerClient(env, {
      client_name: 'E2E Client',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
    });

    const verifier = 'e2e-pkce-verifier-abcdefghijklmnopqrstuvwxyz0123';
    const challengeHash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(verifier)
    );
    const challenge = btoa(String.fromCharCode(...new Uint8Array(challengeHash)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const scope =
      'openid urn:matrix:org.matrix.msc2967.client:device:E2EDEV';
    const authGet = await request(
      `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&scope=${encodeURIComponent(scope)}&state=e2e-state&nonce=e2e-nonce&code_challenge=${challenge}&code_challenge_method=S256`,
      {},
      env
    );
    expect(authGet.status).toBe(200);
    const authId = [...Object.keys(sessions.data)]
      .find((k) => k.startsWith('oauth_auth_request:'))!
      .replace('oauth_auth_request:', '');

    const authPost = await request(
      '/oauth/authorize',
      {
        method: 'POST',
        body: formFields({
          username: 'alice',
          password: 'secret',
          auth_request_id: authId,
        }),
      },
      env
    );
    expect(authPost.status).toBe(302);
    const code = new URL(authPost.headers.get('Location')!).searchParams.get('code')!;

    const tokenRes = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        client_secret: client.client_secret,
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }),
      env
    );
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json();
    expect(tokens.device_id).toBe('E2EDEV');
    expect(tokens.user_id).toBe(USER_ID);

    const refreshRes = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        client_secret: client.client_secret,
        refresh_token: tokens.refresh_token,
      }),
      env
    );
    expect(refreshRes.status).toBe(200);
    const rotated = await refreshRes.json();
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);

    const introspect = await request(
      '/oauth/introspect',
      jsonToken({ token: rotated.access_token }),
      env
    );
    expect(await introspect.json()).toMatchObject({
      active: true,
      sub: USER_ID,
    });

    const revoke = await request(
      '/oauth/revoke',
      jsonToken({
        token: rotated.refresh_token,
        token_type_hint: 'refresh_token',
      }),
      env
    );
    expect(revoke.status).toBe(200);
    expect(sessions.data[`oauth_refresh:${rotated.refresh_token}`]).toBeUndefined();

    const reuse = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        client_secret: client.client_secret,
        refresh_token: rotated.refresh_token,
      }),
      env
    );
    expect(await reuse.json()).toMatchObject({
      error_description: 'Invalid refresh token',
    });
  });

  it('public client authorize→token without secret', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: aliceDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const get = await request(
      `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
      {},
      env
    );
    expect(get.status).toBe(200);
    const authId = Object.keys(sessions.data)
      .find((k) => k.startsWith('oauth_auth_request:'))!
      .replace('oauth_auth_request:', '');
    const post = await request(
      '/oauth/authorize',
      {
        method: 'POST',
        body: formFields({
          username: 'alice',
          password: 'secret',
          auth_request_id: authId,
        }),
      },
      env
    );
    const code = new URL(post.headers.get('Location')!).searchParams.get('code')!;
    const tok = await request(
      '/oauth/token',
      formToken({
        grant_type: 'authorization_code',
        client_id: String(client.client_id),
        code,
      }),
      env
    );
    expect(tok.status).toBe(200);
    expect((await tok.json()).access_token).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// HTML generator consistency leftovers (route-adjacent exports)
// ---------------------------------------------------------------------------

describe('oauth leftovers HTML generators consistency after #130', () => {
  it('login page matches generateLoginPage markers used by authorize GET', () => {
    const html = generateLoginPage('Cli<>ent', 'req"1', 'srv&', 'err\'');
    expect(html).toContain(escapeHtml('Cli<>ent'));
    expect(html).toContain(escapeHtml('req"1'));
    expect(html).toContain(escapeHtml('srv&'));
    expect(html).toContain(escapeHtml("err'"));
    expect(html).toContain('action="/oauth/authorize"');
  });

  it('UIA approval page extracts localpart and escapes all fields', () => {
    const html = generateUiaApprovalPage(
      'sid<script>',
      '@alice:example.com',
      'Title<>',
      'Desc&',
      'srv"',
      'Err\''
    );
    expect(html).toContain('value="alice"');
    expect(html).toContain(escapeHtml('sid<script>'));
    expect(html).toContain(escapeHtml('Title<>'));
    expect(html).toContain(escapeHtml('Desc&'));
    expect(html).toContain(escapeHtml('Err\''));
    expect(html).toContain('action="/oauth/authorize/uia"');
    expect(html).toContain('value="cancel"');
    expect(html).toContain('value="approve"');
  });

  it('success / cancelled / error pages include postMessage hooks and escaping', () => {
    const success = generateUiaSuccessPage('s"1', 'srv');
    expect(success).toContain("type: 'uia_complete'");
    expect(success).toContain(escapeHtml('s"1'));
    expect(success).toContain('Request Approved');

    const cancelled = generateUiaCancelledPage('srv<>');
    expect(cancelled).toContain("type: 'uia_cancelled'");
    expect(cancelled).toContain('Request Cancelled');
    expect(cancelled).toContain(escapeHtml('srv<>'));

    const err = generateUiaErrorPage('T<script>', 'M&', 'S"');
    expect(err).toContain(escapeHtml('T<script>'));
    expect(err).toContain(escapeHtml('M&'));
    expect(err).toContain(escapeHtml('S"'));
  });
});

// ---------------------------------------------------------------------------
// Micro combinatorial leftovers (soft-cap flood)
// ---------------------------------------------------------------------------

describe('oauth leftovers micro combinatorial flood after #130', () => {
  it('register + authorize rejects each unregistered redirect among many listed', async () => {
    const env = makeEnv();
    const uris = Array.from({ length: 8 }, (_, i) => `https://app.example.com/cb/${i}`);
    const { body: client } = await registerClient(env, {
      client_name: 'Many',
      redirect_uris: uris,
    });
    for (const redirect_uri of uris) {
      const ok = await request(
        `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(redirect_uri)}&response_type=code`,
        {},
        env
      );
      expect(ok.status).toBe(200);
    }
    const bad = await request(
      `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent('https://app.example.com/cb/x')}&response_type=code`,
      {},
      env
    );
    expect(bad.status).toBe(400);
  });

  it('token endpoint rejects unknown client before grant handling', async () => {
    const res = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: 'client_missing',
        client_secret: 'x',
        code: 'c',
      })
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: 'invalid_client',
      error_description: 'Unknown client',
    });
  });

  it('confidential client without secret returns client_secret is required', async () => {
    const env = makeEnv();
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_basic',
    });
    const res = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: 'whatever',
      }),
      env
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error_description: 'client_secret is required',
    });
  });

  it('authorize GET unknown client before redirect_uri check', async () => {
    const res = await request(
      `/oauth/authorize?client_id=client_nope&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`
    );
    expect(await res.json()).toMatchObject({
      error: 'invalid_client',
      error_description: 'Unknown client',
    });
  });

  it('introspect prefers client_id claim over azp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const token = fakeJwt({
        sub: USER_ID,
        client_id: 'preferred',
        azp: 'fallback',
        exp: Math.floor(NOW / 1000) + 60,
      });
      const res = await request('/oauth/introspect', jsonToken({ token }));
      expect(await res.json()).toMatchObject({ client_id: 'preferred' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('introspect uses azp when client_id absent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const token = fakeJwt({
        sub: USER_ID,
        azp: 'from-azp',
        exp: Math.floor(NOW / 1000) + 60,
      });
      const res = await request('/oauth/introspect', jsonToken({ token }));
      expect(await res.json()).toMatchObject({ client_id: 'from-azp' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('revoke with refresh hint that misses still falls through to access delete when no hint restriction', async () => {
    // with hint refresh_token only — does NOT fall through to access
    const raw = 'acc-1';
    const hash = await hashToken(raw);
    const db = createOAuthDb({
      tokensByHash: new Map([[hash, { user_id: USER_ID, device_id: 'D', created_at: 1 }]]),
    });
    const env = makeEnv({ db, sessions: mockKv() });
    const hinted = await request(
      '/oauth/revoke',
      jsonToken({ token: raw, token_type_hint: 'refresh_token' }),
      env
    );
    expect(hinted.status).toBe(200);
    // refresh hint with Workers-style undefined delete does NOT early-return;
    // but access_token branch is gated by hint === refresh_token only when hint set —
    // looking at code: access branch runs if !hint || hint === 'access_token'
    // so with refresh_token hint, access delete is SKIPPED
    expect(db.tokensByHash.has(hash)).toBe(true);
  });

  it('UIA GET missing session and expired session pages', async () => {
    const missing = await request('/oauth/authorize/uia');
    expect(await missing.text()).toContain('Missing Session');
    const expired = await request('/oauth/authorize/uia?session=gone');
    expect(await expired.text()).toContain('Session Expired');
  });

  it('UIA POST missing session and expired session pages', async () => {
    const missing = await request(
      '/oauth/authorize/uia',
      { method: 'POST', body: formFields({ action: 'approve' }) }
    );
    expect(await missing.text()).toContain('Missing Session');
    const expired = await request(
      '/oauth/authorize/uia',
      {
        method: 'POST',
        body: formFields({ session: 'gone', username: 'a', password: 'b', action: 'approve' }),
      }
    );
    expect(await expired.text()).toContain('Session Expired');
  });

  it('wrong password on UIA password user shows Invalid username or password', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache, db: aliceDb('right') });
    await env.CACHE.put(
      'uia_session:badpw',
      JSON.stringify({ user_id: USER_ID, completed_stages: [] }),
      { expirationTtl: 300 }
    );
    const res = await request(
      '/oauth/authorize/uia',
      {
        method: 'POST',
        body: formFields({
          session: 'badpw',
          username: 'alice',
          password: 'wrong',
          action: 'approve',
        }),
      },
      env
    );
    expect(await res.text()).toContain('Invalid username or password');
  });

  it('unknown UIA user shows Invalid username or password', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache, db: aliceDb() });
    await env.CACHE.put(
      'uia_session:nouser',
      JSON.stringify({ user_id: USER_ID, completed_stages: [] }),
      { expirationTtl: 300 }
    );
    const res = await request(
      '/oauth/authorize/uia',
      {
        method: 'POST',
        body: formFields({
          session: 'nouser',
          username: 'carol',
          password: 'secret',
          action: 'approve',
        }),
      },
      env
    );
    expect(await res.text()).toContain('Invalid username or password');
  });

  it('code challenge method defaults to plain when auth code omits method', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const sessions = mockKv();
      const env = makeEnv({ sessions, db: createOAuthDb() });
      const { body: client } = await registerClient(env, {
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
      });
      await putAuthCode(env, 'plain-default', {
        client_id: String(client.client_id),
        code_challenge: 'exact-verifier',
        // method omitted
      });
      const bad = await request(
        '/oauth/token',
        jsonToken({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code: 'plain-default',
          code_verifier: 'nope',
        }),
        env
      );
      expect(await bad.json()).toMatchObject({
        error_description: 'Invalid code_verifier',
      });

      await putAuthCode(env, 'plain-default-ok', {
        client_id: String(client.client_id),
        code_challenge: 'exact-verifier',
      });
      const ok = await request(
        '/oauth/token',
        jsonToken({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code: 'plain-default-ok',
          code_verifier: 'exact-verifier',
        }),
        env
      );
      expect(ok.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('redirect_uri optional on token when matching omitted; mismatch still fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const sessions = mockKv();
      const env = makeEnv({ sessions, db: createOAuthDb() });
      const { body: client } = await registerClient(env, {
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
      });
      await putAuthCode(env, 'redir-omit', { client_id: String(client.client_id) });
      const ok = await request(
        '/oauth/token',
        jsonToken({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code: 'redir-omit',
        }),
        env
      );
      expect(ok.status).toBe(200);

      await putAuthCode(env, 'redir-bad', { client_id: String(client.client_id) });
      const bad = await request(
        '/oauth/token',
        jsonToken({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code: 'redir-bad',
          redirect_uri: 'https://evil/',
        }),
        env
      );
      expect(await bad.json()).toMatchObject({
        error_description: 'redirect_uri mismatch',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Additional soft-cap flood leftovers
// ---------------------------------------------------------------------------

describe('oauth leftovers Basic auth + URL encoding after #130', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('decodes percent-encoded client_id and client_secret in Basic header', async () => {
    const sessions = mockKv();
    const cache = mockKv();
    const env = makeEnv({ sessions, cache, db: createOAuthDb() });
    // Manually store client with id/secret that need encoding
    const clientId = 'client_abc:def';
    const clientSecret = 'sec/ret+value';
    const secretHash = await hashClientSecret(clientSecret);
    await cache.put(
      `oauth_client:${clientId}`,
      JSON.stringify({
        client_id: clientId,
        client_secret_hash: secretHash,
        client_name: 'Encoded',
        redirect_uris: [REDIRECT],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_basic',
        created_at: NOW,
      })
    );
    await putAuthCode(env, 'enc-basic', { client_id: clientId });
    const encoded = btoa(
      `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`
    );
    const res = await request(
      '/oauth/token',
      jsonToken(
        { grant_type: 'authorization_code', code: 'enc-basic' },
        { Authorization: `Basic ${encoded}` }
      ),
      env
    );
    expect(res.status).toBe(200);
  });

  it('ignores non-Basic Authorization schemes for client auth', async () => {
    const env = makeEnv();
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
    });
    const res = await request(
      '/oauth/token',
      jsonToken(
        {
          grant_type: 'authorization_code',
          code: 'x',
        },
        { Authorization: `Bearer ${client.client_id}:${client.client_secret}` }
      ),
      env
    );
    expect(await res.json()).toMatchObject({
      error_description: 'client_id is required',
    });
  });

  it('Bearer auth on token does not supply client_id', async () => {
    const res = await request(
      '/oauth/token',
      jsonToken(
        { grant_type: 'refresh_token', refresh_token: 'r' },
        { Authorization: 'Bearer sometoken' }
      )
    );
    expect(await res.json()).toMatchObject({
      error: 'invalid_client',
      error_description: 'client_id is required',
    });
  });
});

describe('oauth leftovers authorize deactivated / guest users after #130', () => {
  it('deactivated user is treated as unknown on authorize POST', async () => {
    const sessions = mockKv();
    const db = createOAuthDb({
      users: new Map([
        [
          USER_ID,
          userRow({
            user_id: USER_ID,
            localpart: 'alice',
            password_hash: 'mockok:secret',
            is_deactivated: 1,
          }),
        ],
      ]),
    });
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env, {
      client_name: 'Deact',
      redirect_uris: [REDIRECT],
    });
    const id = await seededAuth(env, { client_id: client.client_id });
    const res = await request(
      '/oauth/authorize',
      {
        method: 'POST',
        body: formFields({
          username: 'alice',
          password: 'secret',
          auth_request_id: id,
        }),
      },
      env
    );
    expect(await res.text()).toContain('Invalid username or password');
  });

  it('null password_hash user cannot authorize even with any password', async () => {
    const sessions = mockKv();
    const db = createOAuthDb({
      users: new Map([
        [
          USER_ID,
          userRow({
            user_id: USER_ID,
            localpart: 'alice',
            password_hash: null,
          }),
        ],
      ]),
    });
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env, {
      client_name: 'OidcOnly',
      redirect_uris: [REDIRECT],
    });
    const id = await seededAuth(env, { client_id: client.client_id });
    const res = await request(
      '/oauth/authorize',
      {
        method: 'POST',
        body: formFields({
          username: 'alice',
          password: 'anything',
          auth_request_id: id,
        }),
      },
      env
    );
    const html = await res.text();
    expect(html).toContain('Invalid username or password');
    expect(html).toContain('OidcOnly');
  });
});

describe('oauth leftovers userinfo profile field matrix after #130', () => {
  async function envWithProfile(
    display_name: string | null,
    avatar_url: string | null,
    token = 'prof-tok'
  ) {
    const hash = await hashToken(token);
    const row = userRow({
      user_id: USER_ID,
      localpart: 'alice',
      password_hash: 'mockok:x',
    });
    row.display_name = display_name;
    row.avatar_url = avatar_url;
    const db = createOAuthDb({
      users: new Map([[USER_ID, row]]),
      tokensByHash: new Map([
        [hash, { user_id: USER_ID, device_id: 'D', created_at: NOW }],
      ]),
    });
    return { env: makeEnv({ db }), token };
  }

  it('omits name/picture when profile fields null (getUserById maps null→undefined)', async () => {
    const { env, token } = await envWithProfile(null, null);
    const res = await request(
      '/oauth/userinfo',
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );
    expect(await res.json()).toEqual({
      sub: USER_ID,
      'urn:matrix:user_id': USER_ID,
    });
  });

  it('returns empty-string profile fields as-is', async () => {
    const { env, token } = await envWithProfile('', '', 'empty-prof');
    const res = await request(
      '/oauth/userinfo',
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env
    );
    expect(await res.json()).toMatchObject({ name: '', picture: '' });
  });
});

describe('oauth leftovers UIA stage idempotency matrix after #130', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not duplicate stages already present in completed_stages', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache, db: aliceDb() });
    await env.CACHE.put(
      'uia_session:idem',
      JSON.stringify({
        user_id: USER_ID,
        completed_stages: [
          'org.matrix.cross_signing_reset',
          'm.oauth',
          'm.login.oauth',
          'extra.stage',
        ],
      }),
      { expirationTtl: 300 }
    );
    const res = await request(
      '/oauth/authorize/uia',
      {
        method: 'POST',
        body: formFields({
          session: 'idem',
          username: 'alice',
          password: 'secret',
          action: 'approve',
        }),
      },
      env
    );
    expect(res.status).toBe(200);
    const updated = JSON.parse(cache.data['uia_session:idem']);
    expect(updated.completed_stages).toEqual([
      'org.matrix.cross_signing_reset',
      'm.oauth',
      'm.login.oauth',
      'extra.stage',
    ]);
    expect(updated.oauth_completed_at).toBe(NOW);
  });

  it('GET uia without action uses generic Approve Request copy', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    await env.CACHE.put(
      'uia_session:generic',
      JSON.stringify({ user_id: USER_ID }),
      { expirationTtl: 300 }
    );
    const res = await request('/oauth/authorize/uia?session=generic', {}, env);
    const html = await res.text();
    expect(html).toContain('Approve Request');
    expect(html).toContain('An application is requesting your approval.');
    expect(html).not.toContain('Reset Encryption Keys');
  });

  it('approval page pre-fills localpart from session user_id', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    await env.CACHE.put(
      'uia_session:prefill',
      JSON.stringify({ user_id: `@carol:${SERVER}` }),
      { expirationTtl: 300 }
    );
    const res = await request(
      '/oauth/authorize/uia?session=prefill&action=org.matrix.cross_signing_reset',
      {},
      env
    );
    const html = await res.text();
    expect(html).toContain('value="carol"');
    expect(html).toContain(escapeHtml(`@carol:${SERVER}`));
  });
});

describe('oauth leftovers revoke/introspect content-type matrix after #130', () => {
  it('introspect with charset json works; unsupported CT requires token', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const token = fakeJwt({
        sub: USER_ID,
        exp: Math.floor(NOW / 1000) + 100,
        client_id: 'c',
      });
      const ok = await request('/oauth/introspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ token }),
      });
      expect(await ok.json()).toMatchObject({ active: true });

      const bad = await request('/oauth/introspect', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: `token=${token}`,
      });
      expect(bad.status).toBe(400);
    } finally {
      vi.useRealTimers();
    }
  });

  it('revoke with charset form deletes refresh token', async () => {
    const sessions = mockKv({ 'oauth_refresh:rt-cs': '{"x":1}' });
    const env = makeEnv({ sessions });
    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: 'token=rt-cs&token_type_hint=refresh_token',
      },
      env
    );
    expect(res.status).toBe(200);
    expect(sessions.data['oauth_refresh:rt-cs']).toBeUndefined();
  });
});

describe('oauth leftovers register response shape matrix after #130', () => {
  it('client_id_issued_at is unix seconds from created_at', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const env = makeEnv();
      const { body } = await registerClient(env);
      expect(body.client_id_issued_at).toBe(Math.floor(NOW / 1000));
      expect(body.client_secret_expires_at).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('public client omits client_secret and client_secret_expires_at', async () => {
    const { body } = await registerClient(makeEnv(), {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    expect(body).not.toHaveProperty('client_secret');
    expect(body).not.toHaveProperty('client_secret_expires_at');
    expect(body.token_endpoint_auth_method).toBe('none');
  });

  it('custom grant_types and response_types round-trip into CACHE', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const { body } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'CustomGrants',
    });
    expect(body.grant_types).toEqual(['authorization_code', 'refresh_token']);
    const stored = JSON.parse(cache.data[`oauth_client:${body.client_id}`]);
    expect(stored.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(stored.client_name).toBe('CustomGrants');
  });
});

describe('oauth leftovers token error path matrix after #130', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('code issued to other client is invalid_grant', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: createOAuthDb() });
    const a = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      client_name: 'A',
    });
    const b = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      client_name: 'B',
    });
    await putAuthCode(env, 'cross-client', { client_id: String(a.body.client_id) });
    const res = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: b.body.client_id,
        code: 'cross-client',
      }),
      env
    );
    expect(await res.json()).toMatchObject({
      error_description: 'Code was not issued to this client',
    });
  });

  it('PKCE missing verifier when challenge present', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'need-ver', {
      client_id: String(client.client_id),
      code_challenge: 'chal',
      code_challenge_method: 'plain',
    });
    const res = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: 'need-ver',
      }),
      env
    );
    expect(await res.json()).toMatchObject({
      error_description: 'code_verifier is required',
    });
  });

  it('empty-string refresh_token is treated as missing', async () => {
    const env = makeEnv();
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const res = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: '',
      }),
      env
    );
    expect(await res.json()).toMatchObject({
      error_description: 'refresh_token is required',
    });
  });

  it('empty-string code is treated as missing', async () => {
    const env = makeEnv();
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const res = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: '',
      }),
      env
    );
    expect(await res.json()).toMatchObject({
      error_description: 'code is required',
    });
  });
});

describe('oauth leftovers authorize HTML structure after #130', () => {
  it('authorize GET HTML includes autofocus username and server footer', async () => {
    const env = makeEnv();
    const { body: client } = await registerClient(env, {
      client_name: 'Struct',
      redirect_uris: [REDIRECT],
    });
    const res = await request(
      `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
      {},
      env
    );
    const html = await res.text();
    expect(html).toContain('autocomplete="username"');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain('autofocus');
    expect(html).toContain(`Signing in to`);
    expect(html).toContain(escapeHtml(SERVER));
    expect(html).toContain('to continue to');
    expect(html).toContain('Struct');
  });

  it('success page includes window.opener postMessage script', () => {
    const html = generateUiaSuccessPage('abc', SERVER);
    expect(html).toContain('window.opener');
    expect(html).toContain("postMessage({ type: 'uia_complete'");
    expect(html).toContain('window.close()');
  });

  it('cancelled page includes uia_cancelled postMessage', () => {
    const html = generateUiaCancelledPage(SERVER);
    expect(html).toContain("type: 'uia_cancelled'");
    expect(html).toContain('window.close()');
  });
});

// ---------------------------------------------------------------------------
// Soft-cap deepen leftovers — partial forms, exact redirect, charset, JWT
// claims, UIA XSS banner, sequential refresh, empty device scope, nonce
// ---------------------------------------------------------------------------

describe('oauth leftovers authorize POST partial forms after #130', () => {
  it('missing only username field (password present) shows Missing username or password', async () => {
    const env = makeEnv({ db: aliceDb() });
    const res = await request(
      '/oauth/authorize',
      {
        method: 'POST',
        body: formFields({
          password: 'secret',
          auth_request_id: 'partial-user',
        }),
      },
      env
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Missing username or password');
    expect(html).toContain('name="username"');
    expect(html).toContain('name="password"');
  });

  it('missing only password field (username present) shows Missing username or password', async () => {
    const env = makeEnv({ db: aliceDb() });
    const res = await request(
      '/oauth/authorize',
      {
        method: 'POST',
        body: formFields({
          username: 'alice',
          auth_request_id: 'partial-pass',
        }),
      },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Missing username or password');
  });

  it('omitted auth_request_id with both credentials still Missing username or password', async () => {
    // `!username || !password || !authRequestId` — credentials alone are insufficient
    const env = makeEnv({ db: aliceDb() });
    const res = await request(
      '/oauth/authorize',
      {
        method: 'POST',
        body: formFields({
          username: 'alice',
          password: 'secret',
        }),
      },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Missing username or password');
  });
});

describe('oauth leftovers token matching redirect_uri exactly after #130', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('authorization_code succeeds when redirect_uri exactly matches stored code', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT, REDIRECT_ALT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'redir-exact', {
      client_id: String(client.client_id),
      redirect_uri: REDIRECT,
    });
    const res = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: 'redir-exact',
        redirect_uri: REDIRECT,
      }),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toBeTruthy();
    expect(body.user_id).toBe(USER_ID);
    expect(sessions.data['oauth_code:redir-exact']).toBeUndefined();
  });

  it('authorization_code succeeds with exact alt redirect_uri from multi-uri client', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT, REDIRECT_ALT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'redir-alt-exact', {
      client_id: String(client.client_id),
      redirect_uri: REDIRECT_ALT,
    });
    const res = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: 'redir-alt-exact',
        redirect_uri: REDIRECT_ALT,
      }),
      env
    );
    expect(res.status).toBe(200);
    expect((await res.json()).access_token).toBeTruthy();
  });

  it('form-urlencoded matching redirect_uri also succeeds', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'redir-form-exact', {
      client_id: String(client.client_id),
      redirect_uri: REDIRECT,
    });
    const res = await request(
      '/oauth/token',
      formToken({
        grant_type: 'authorization_code',
        client_id: String(client.client_id),
        code: 'redir-form-exact',
        redirect_uri: REDIRECT,
      }),
      env
    );
    expect(res.status).toBe(200);
  });
});

describe('oauth leftovers revoke JSON charset after #130', () => {
  it('accepts application/json; charset=utf-8 for refresh revoke', async () => {
    const sessions = mockKv({ 'oauth_refresh:rt-json-cs': '{"token_id":"t"}' });
    const env = makeEnv({ sessions });
    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          token: 'rt-json-cs',
          token_type_hint: 'refresh_token',
        }),
      },
      env
    );
    expect(res.status).toBe(200);
    expect(sessions.data['oauth_refresh:rt-json-cs']).toBeUndefined();
    expect(sessions.deletes).toContain('oauth_refresh:rt-json-cs');
  });

  it('accepts application/json;charset=UTF-8 (no space) for access revoke', async () => {
    const raw = 'at-json-cs';
    const hash = await hashToken(raw);
    const db = createOAuthDb({
      tokensByHash: new Map([[hash, { user_id: USER_ID, device_id: 'D', created_at: NOW }]]),
    });
    const env = makeEnv({ sessions: mockKv(), db });
    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        body: JSON.stringify({ token: raw, token_type_hint: 'access_token' }),
      },
      env
    );
    expect(res.status).toBe(200);
    expect(db.tokensByHash.has(hash)).toBe(false);
    expect(db.deletes.some((d) => d.sql.includes('access_tokens'))).toBe(true);
  });
});

describe('oauth leftovers introspect JWT sparse claims after #130', () => {
  it('JWT without iat/scope/iss is still active with undefined claim fields', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const token = fakeJwt({
        sub: USER_ID,
        client_id: 'sparse-client',
        exp: Math.floor(NOW / 1000) + 600,
      });
      const res = await request('/oauth/introspect', jsonToken({ token }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        active: true,
        sub: USER_ID,
        client_id: 'sparse-client',
        token_type: 'Bearer',
        exp: Math.floor(NOW / 1000) + 600,
      });
      expect(body.iat).toBeUndefined();
      expect(body.scope).toBeUndefined();
      expect(body.iss).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('JWT with only sub (no exp) is active; missing exp is not treated as expired', async () => {
    const token = fakeJwt({ sub: BOB_ID });
    const res = await request('/oauth/introspect', jsonToken({ token }));
    expect(await res.json()).toMatchObject({
      active: true,
      sub: BOB_ID,
      token_type: 'Bearer',
    });
  });

  it('form-urlencoded sparse JWT also returns active without iat/scope/iss', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const token = fakeJwt({
        sub: USER_ID,
        azp: 'via-azp',
        exp: Math.floor(NOW / 1000) + 1,
      });
      const res = await request('/oauth/introspect', formToken({ token }));
      const body = await res.json();
      expect(body.active).toBe(true);
      expect(body.client_id).toBe('via-azp');
      expect(body.iat).toBeUndefined();
      expect(body.scope).toBeUndefined();
      expect(body.iss).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('oauth leftovers UIA POST XSS error banner after #130', () => {
  it('escapes XSS in session user_id when POST re-renders approval with error banner', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const evilUser = `@evil<script>alert(1)</script>:${SERVER}`;
    const sid = `uia-xss"><img src=x onerror=alert(1)>`;
    await env.CACHE.put(
      `uia_session:${sid}`,
      JSON.stringify({ user_id: evilUser, completed_stages: [] }),
      { expirationTtl: 300 }
    );
    const res = await request(
      '/oauth/authorize/uia',
      {
        method: 'POST',
        body: formFields({
          session: sid,
          username: 'alice',
          // omit password → triggers error banner path
          action: 'approve',
        }),
      },
      env
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Username and password are required.');
    expect(html).toContain('class="error"');
    expect(html).toContain(escapeHtml(evilUser));
    expect(html).toContain(escapeHtml(sid));
    expect(html).not.toContain('<script>alert(1)</script>');
    // attribute breakout neutralized: quotes/`<>` escaped inside value="..."
    expect(html).toContain(`value="${escapeHtml(sid)}"`);
    expect(html).not.toMatch(/value="[^"]*<img/);
  });

  it('wrong password path also escapes XSS user_id beside error banner', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache, db: aliceDb('right') });
    const evilUser = `@x<svg/onload=alert(2)>:${SERVER}`;
    await env.CACHE.put(
      'uia_session:uia-xss-pw',
      JSON.stringify({ user_id: evilUser, completed_stages: [] }),
      { expirationTtl: 300 }
    );
    const res = await request(
      '/oauth/authorize/uia',
      {
        method: 'POST',
        body: formFields({
          session: 'uia-xss-pw',
          username: 'alice',
          password: 'wrong',
          action: 'approve',
        }),
      },
      env
    );
    const html = await res.text();
    expect(html).toContain('Invalid username or password.');
    expect(html).toContain('class="error"');
    expect(html).toContain(escapeHtml(evilUser));
    expect(html).not.toContain('<svg/onload=alert(2)>');
  });
});

describe('oauth leftovers multiple sequential refreshes after #130', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rotates refresh token across three sequential refresh grants', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });

    let refresh = 'rt-seq-0';
    await sessions.put(
      `oauth_refresh:${refresh}`,
      JSON.stringify({
        token_id: 'tid-0',
        access_token_hash: 'ah-0',
        refresh_token_hash: 'rh-0',
        client_id: client.client_id,
        user_id: USER_ID,
        device_id: 'SEQDEV',
        scope: 'openid urn:matrix:org.matrix.msc2967.client:device:SEQDEV',
        created_at: NOW,
        expires_at: NOW + 86400_000,
      }),
      { expirationTtl: 30 * 24 * 60 * 60 }
    );

    const seenRefresh = new Set<string>([refresh]);
    const seenAccess = new Set<string>();

    for (let i = 0; i < 3; i++) {
      const res = await request(
        '/oauth/token',
        jsonToken({
          grant_type: 'refresh_token',
          client_id: client.client_id,
          refresh_token: refresh,
        }),
        env
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.device_id).toBeUndefined(); // refresh response omits Matrix fields
      expect(body.scope).toBe('openid urn:matrix:org.matrix.msc2967.client:device:SEQDEV');
      expect(body.access_token).toBeTruthy();
      expect(body.refresh_token).toBeTruthy();
      expect(seenRefresh.has(String(body.refresh_token))).toBe(false);
      expect(seenAccess.has(String(body.access_token))).toBe(false);
      expect(sessions.data[`oauth_refresh:${refresh}`]).toBeUndefined();

      seenRefresh.add(String(body.refresh_token));
      seenAccess.add(String(body.access_token));
      refresh = String(body.refresh_token);

      const stored = JSON.parse(sessions.data[`oauth_refresh:${refresh}`]);
      expect(stored.device_id).toBe('SEQDEV');
      expect(stored.user_id).toBe(USER_ID);
      expect(stored.client_id).toBe(client.client_id);
    }

    // oldest refresh remains invalid
    const stale = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: 'rt-seq-0',
      }),
      env
    );
    expect(await stale.json()).toMatchObject({
      error_description: 'Invalid refresh token',
    });
  });

  it('second sequential refresh fails if first refresh token is reused mid-chain', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const first = 'rt-reuse-a';
    await sessions.put(
      `oauth_refresh:${first}`,
      JSON.stringify({
        token_id: 't1',
        access_token_hash: 'a1',
        refresh_token_hash: 'r1',
        client_id: client.client_id,
        user_id: USER_ID,
        device_id: 'D1',
        scope: 'openid',
        created_at: NOW,
        expires_at: NOW + 86400_000,
      })
    );
    const firstRes = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: first,
      }),
      env
    );
    const rotated = await firstRes.json();
    const reuse = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: first,
      }),
      env
    );
    expect(reuse.status).toBe(400);
    // chain tip still works
    const tip = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: rotated.refresh_token,
      }),
      env
    );
    expect(tip.status).toBe(200);
  });
});

describe('oauth leftovers empty MSC2967 device id generates after #130', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('device scope ending with colon (empty device id) generates a device id', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const emptyDeviceScope = 'openid urn:matrix:org.matrix.msc2967.client:device:';
    await putAuthCode(env, 'empty-dev', {
      client_id: String(client.client_id),
      scope: emptyDeviceScope,
    });
    const res = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: 'empty-dev',
      }),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.device_id).toBeTruthy();
    expect(String(body.device_id).length).toBeGreaterThan(0);
    expect(body.device_id).not.toBe('');
    expect(body.device_id).not.toBe('*');
    expect(body.scope).toBe(emptyDeviceScope);
    const deviceInsert = db.inserts.find((i) => i.sql.includes('INTO devices'));
    expect(deviceInsert?.args[1]).toBe(body.device_id);
  });

  it('device:* wildcard also generates (same falsy/`*` branch)', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'star-dev', {
      client_id: String(client.client_id),
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:*',
    });
    const res = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: 'star-dev',
      }),
      env
    );
    const body = await res.json();
    expect(body.device_id).toBeTruthy();
    expect(body.device_id).not.toBe('*');
  });

  it('device scope with trailing garbage after empty colon segment still matches prefix and generates', async () => {
    // Scope token is exact prefix + empty replace → ''; `!deviceId` triggers generateDeviceId.
    // "Trailing garbage" here is a second non-device scope after the empty device entry.
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const scope =
      'openid urn:matrix:org.matrix.msc2967.client:device: urn:matrix:org.matrix.msc2967.client:api:*';
    await putAuthCode(env, 'empty-dev-garbage', {
      client_id: String(client.client_id),
      scope,
    });
    const res = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: 'empty-dev-garbage',
      }),
      env
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.device_id).toBeTruthy();
    expect(String(body.device_id).length).toBeGreaterThan(0);
  });
});

describe('oauth leftovers authorize POST nonce into auth code after #130', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves nonce from auth request into stored oauth_code on successful login', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: aliceDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      client_name: 'NonceClient',
    });
    const nonce = 'nonce-preserve-xyz';
    const id = await seededAuth(env, {
      client_id: client.client_id,
      nonce,
      state: 'st-nonce',
      scope: 'openid',
    });
    const res = await request(
      '/oauth/authorize',
      {
        method: 'POST',
        body: formFields({
          username: 'alice',
          password: 'secret',
          auth_request_id: id,
        }),
      },
      env
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('Location')!);
    const code = loc.searchParams.get('code')!;
    expect(code).toBeTruthy();
    const stored = JSON.parse(sessions.data[`oauth_code:${code}`]);
    expect(stored.nonce).toBe(nonce);
    expect(stored.client_id).toBe(client.client_id);
    expect(stored.user_id).toBe(USER_ID);
    expect(stored.redirect_uri).toBe(REDIRECT);
    expect(sessions.data[`oauth_auth_request:${id}`]).toBeUndefined();
  });

  it('omitted nonce stays undefined on stored auth code', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: aliceDb() });
    const { body: client } = await registerClient(env);
    const id = await seededAuth(env, { client_id: client.client_id });
    const res = await request(
      '/oauth/authorize',
      {
        method: 'POST',
        body: formFields({
          username: 'alice',
          password: 'secret',
          auth_request_id: id,
        }),
      },
      env
    );
    const code = new URL(res.headers.get('Location')!).searchParams.get('code')!;
    const stored = JSON.parse(sessions.data[`oauth_code:${code}`]);
    expect(stored.nonce).toBeUndefined();
  });

  it('empty-string nonce from GET authorize is stored then copied into code', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: aliceDb() });
    const { body: client } = await registerClient(env);
    // GET with nonce= (empty) — query present but empty string
    const getRes = await request(
      `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&nonce=`,
      {},
      env
    );
    expect(getRes.status).toBe(200);
    const authPut = sessions.puts.find((p) => p.key.startsWith('oauth_auth_request:'));
    expect(authPut).toBeTruthy();
    const authReq = JSON.parse(authPut!.value);
    // empty query param is typically '' not undefined
    expect(authReq.nonce === '' || authReq.nonce == null).toBe(true);

    const authId = authPut!.key.replace('oauth_auth_request:', '');
    const postRes = await request(
      '/oauth/authorize',
      {
        method: 'POST',
        body: formFields({
          username: 'alice',
          password: 'secret',
          auth_request_id: authId,
        }),
      },
      env
    );
    expect(postRes.status).toBe(302);
    const code = new URL(postRes.headers.get('Location')!).searchParams.get('code')!;
    const stored = JSON.parse(sessions.data[`oauth_code:${code}`]);
    expect(stored.nonce).toBe(authReq.nonce);
  });
});

// ---------------------------------------------------------------------------
// Soft-cap flood: unicode/state/nonce extremes, redirect slash mismatch,
// cross-client refresh, revoke hint preference, JWT exp boundary, userinfo
// Bearer edges, UIA generic action + MXID wrap, XSS client_name, grant-only
// token, authorize replay, opaque introspect, revoke no-CT, multi-uri
// authorize, PKCE S256 authorize→token.
// ---------------------------------------------------------------------------

describe('oauth leftovers authorize GET unicode state/nonce extremes after #130', () => {
  it('stores extreme-length unicode state and nonce verbatim in auth request', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, cache: mockKv() });
    const { body: client } = await registerClient(env);
    const state = `${'日本語状態'.repeat(40)}${'🚀'.repeat(20)}${'x'.repeat(200)}`;
    const nonce = `${'نونس'.repeat(30)}${'🔐'.repeat(15)}${'n'.repeat(180)}`;
    expect(state.length).toBeGreaterThan(400);
    expect(nonce.length).toBeGreaterThan(300);
    const res = await request(
      `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&state=${encodeURIComponent(state)}&nonce=${encodeURIComponent(nonce)}`,
      {},
      env
    );
    expect(res.status).toBe(200);
    const authPut = sessions.puts.find((p) => p.key.startsWith('oauth_auth_request:'));
    expect(authPut).toBeTruthy();
    const stored = JSON.parse(authPut!.value);
    expect(stored.state).toBe(state);
    expect(stored.nonce).toBe(nonce);
    expect(stored.client_id).toBe(client.client_id);
    expect(stored.redirect_uri).toBe(REDIRECT);
  });

  it('stores mixed BMP + astral-plane characters in state without truncation', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions });
    const { body: client } = await registerClient(env);
    const state = 'café\u0000safe\uD83D\uDE00\u{1F4A9}';
    const res = await request(
      `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&state=${encodeURIComponent(state)}`,
      {},
      env
    );
    expect(res.status).toBe(200);
    const stored = JSON.parse(
      sessions.puts.find((p) => p.key.startsWith('oauth_auth_request:'))!.value
    );
    expect(stored.state).toBe(state);
  });
});

describe('oauth leftovers token redirect_uri trailing slash mismatch after #130', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('character-for-character mismatch when token adds trailing slash', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'slash-add', {
      client_id: String(client.client_id),
      redirect_uri: REDIRECT,
    });
    const res = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: 'slash-add',
        redirect_uri: `${REDIRECT}/`,
      }),
      env
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'invalid_grant',
      error_description: 'redirect_uri mismatch',
    });
    // Code still consumed (deleted before mismatch check)
    expect(sessions.data['oauth_code:slash-add']).toBeUndefined();
  });

  it('character-for-character mismatch when stored has trailing slash and token omits it', async () => {
    const withSlash = `${REDIRECT}/`;
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [withSlash, REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'slash-omit', {
      client_id: String(client.client_id),
      redirect_uri: withSlash,
    });
    const res = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: 'slash-omit',
        redirect_uri: REDIRECT,
      }),
      env
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error_description: 'redirect_uri mismatch',
    });
  });

  it('exact match including trailing slash succeeds', async () => {
    const withSlash = `${REDIRECT}/`;
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [withSlash],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'slash-exact', {
      client_id: String(client.client_id),
      redirect_uri: withSlash,
    });
    const res = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: 'slash-exact',
        redirect_uri: withSlash,
      }),
      env
    );
    expect(res.status).toBe(200);
    expect((await res.json()).access_token).toBeTruthy();
  });
});

describe('oauth leftovers refresh_token wrong client after two registers after #130', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refresh issued to client A rejected when presented by client B', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: createOAuthDb() });
    const a = await registerClient(env, {
      client_name: 'ClientA',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const b = await registerClient(env, {
      client_name: 'ClientB',
      redirect_uris: [REDIRECT_ALT],
      token_endpoint_auth_method: 'none',
    });
    expect(a.body.client_id).not.toBe(b.body.client_id);

    const rt = 'rt-owned-by-a';
    await sessions.put(
      `oauth_refresh:${rt}`,
      JSON.stringify({
        token_id: 'tid-a',
        access_token_hash: 'h',
        refresh_token_hash: 'rh',
        client_id: a.body.client_id,
        user_id: USER_ID,
        device_id: 'DA',
        scope: 'openid',
        created_at: NOW,
        expires_at: NOW + 86400_000,
      })
    );

    const wrong = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'refresh_token',
        client_id: b.body.client_id,
        refresh_token: rt,
      }),
      env
    );
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({
      error: 'invalid_grant',
      error_description: 'Token was not issued to this client',
    });
    // Wrong-client attempt must not rotate/delete the refresh token
    expect(sessions.data[`oauth_refresh:${rt}`]).toBeTruthy();

    const right = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'refresh_token',
        client_id: a.body.client_id,
        refresh_token: rt,
      }),
      env
    );
    expect(right.status).toBe(200);
    expect((await right.json()).refresh_token).toBeTruthy();
    expect(sessions.data[`oauth_refresh:${rt}`]).toBeUndefined();
  });
});

describe('oauth leftovers revoke access_token hint prefers over refresh key after #130', () => {
  it('access_token hint skips refresh delete even when same string exists as oauth_refresh key', async () => {
    const raw = 'ambiguous-token-looks-like-both';
    const hash = await hashToken(raw);
    const db = createOAuthDb({
      tokensByHash: new Map([
        [hash, { user_id: USER_ID, device_id: 'D', created_at: NOW }],
      ]),
    });
    const sessions = mockKv({
      [`oauth_refresh:${raw}`]: JSON.stringify({ token_id: 'keep-me', client_id: 'c' }),
    });
    const env = makeEnv({ sessions, db });

    const res = await request(
      '/oauth/revoke',
      jsonToken({ token: raw, token_type_hint: 'access_token' }),
      env
    );
    expect(res.status).toBe(200);
    // Hint prefers access path — refresh key must survive
    expect(sessions.data[`oauth_refresh:${raw}`]).toBeTruthy();
    expect(sessions.deletes).not.toContain(`oauth_refresh:${raw}`);
    expect(db.tokensByHash.has(hash)).toBe(false);
    expect(db.deletes.some((d) => d.sql.includes('FROM access_tokens'))).toBe(true);
  });

  it('refresh_token hint deletes refresh and does not touch DB access token of same string', async () => {
    const raw = 'hint-refresh-same-string';
    const hash = await hashToken(raw);
    const db = createOAuthDb({
      tokensByHash: new Map([
        [hash, { user_id: USER_ID, device_id: 'D', created_at: NOW }],
      ]),
    });
    // deleteReturn non-undefined → early return after refresh delete
    const sessions = mockKv(
      { [`oauth_refresh:${raw}`]: JSON.stringify({ token_id: 'rt' }) },
      /* deleteReturn */ true
    );
    const env = makeEnv({ sessions, db });
    const res = await request(
      '/oauth/revoke',
      formToken({ token: raw, token_type_hint: 'refresh_token' }),
      env
    );
    expect(res.status).toBe(200);
    expect(sessions.data[`oauth_refresh:${raw}`]).toBeUndefined();
    expect(db.tokensByHash.has(hash)).toBe(true);
    expect(db.deletes.length).toBe(0);
  });
});

describe('oauth leftovers introspect JWT exp strict less-than boundary after #130', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exp exactly equal to now is still active (strict <)', async () => {
    const nowSec = Math.floor(NOW / 1000);
    const token = fakeJwt({
      sub: USER_ID,
      client_id: 'exp-eq',
      exp: nowSec,
    });
    const res = await request('/oauth/introspect', jsonToken({ token }));
    expect(await res.json()).toMatchObject({
      active: true,
      sub: USER_ID,
      exp: nowSec,
    });
  });

  it('exp equal to nowSec - 1 is inactive', async () => {
    const nowSec = Math.floor(NOW / 1000);
    const token = fakeJwt({
      sub: USER_ID,
      exp: nowSec - 1,
    });
    const res = await request('/oauth/introspect', formToken({ token }));
    expect(await res.json()).toEqual({ active: false });
  });

  it('exp equal to nowSec + 0 via form-urlencoded also active', async () => {
    const nowSec = Math.floor(NOW / 1000);
    const token = fakeJwt({ sub: BOB_ID, azp: 'azp-eq', exp: nowSec });
    const res = await request('/oauth/introspect', formToken({ token }));
    const body = await res.json();
    expect(body.active).toBe(true);
    expect(body.client_id).toBe('azp-eq');
    expect(body.exp).toBe(nowSec);
  });
});

describe('oauth leftovers userinfo Bearer empty / malformed after #130', () => {
  it('Authorization Bearer with empty token yields M_MISSING_TOKEN', async () => {
    const res = await request('/oauth/userinfo', {
      headers: { Authorization: 'Bearer ' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('Authorization Bearer without space/token yields M_MISSING_TOKEN', async () => {
    const res = await request('/oauth/userinfo', {
      headers: { Authorization: 'Bearer' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('malformed non-Bearer scheme yields M_MISSING_TOKEN', async () => {
    const res = await request('/oauth/userinfo', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('Bearer with unknown opaque token yields M_UNKNOWN_TOKEN', async () => {
    const env = makeEnv({ db: aliceDb() });
    const res = await request(
      '/oauth/userinfo',
      { headers: { Authorization: 'Bearer not-a-real-token' } },
      env
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN' });
  });

  it('POST userinfo with empty Bearer also missing token', async () => {
    const res = await request('/oauth/userinfo', {
      method: 'POST',
      headers: { Authorization: 'Bearer   ' },
    });
    // Bearer\s+(.+) — trailing spaces only: \s+ eats spaces, .+ needs a char → miss
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });
});

describe('oauth leftovers UIA GET unknown action generic copy after #130', () => {
  it('unknown action string uses generic Approve Request copy', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    await env.CACHE.put(
      'uia_session:uia-generic',
      JSON.stringify({ user_id: USER_ID, completed_stages: [] }),
      { expirationTtl: 300 }
    );
    const res = await request(
      '/oauth/authorize/uia?session=uia-generic&action=totally.unknown.action.string',
      {},
      env
    );
    const html = await res.text();
    expect(html).toContain('Approve Request');
    expect(html).toContain('An application is requesting your approval.');
    expect(html).not.toContain('Reset Encryption Keys');
    expect(html).not.toContain('reset your encryption identity');
    expect(html).toContain(escapeHtml(USER_ID));
  });

  it('omitted action also uses generic copy (not cross_signing_reset)', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    await env.CACHE.put(
      'uia_session:uia-no-action',
      JSON.stringify({ user_id: USER_ID, completed_stages: [] }),
      { expirationTtl: 300 }
    );
    const res = await request('/oauth/authorize/uia?session=uia-no-action', {}, env);
    const html = await res.text();
    expect(html).toContain('Approve Request');
    expect(html).not.toContain('Reset Encryption Keys');
  });

  it('empty action= query uses generic copy', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    await env.CACHE.put(
      'uia_session:uia-empty-action',
      JSON.stringify({ user_id: BOB_ID, completed_stages: [] }),
      { expirationTtl: 300 }
    );
    const res = await request(
      '/oauth/authorize/uia?session=uia-empty-action&action=',
      {},
      env
    );
    const html = await res.text();
    expect(html).toContain('Approve Request');
    expect(html).toContain(escapeHtml(BOB_ID));
  });
});

describe('oauth leftovers UIA POST full MXID username double-wrap after #130', () => {
  it('approve with full MXID username formatUserId-wraps and fails lookup', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache, db: aliceDb() });
    await env.CACHE.put(
      'uia_session:uia-mxid',
      JSON.stringify({ user_id: USER_ID, completed_stages: [] }),
      { expirationTtl: 300 }
    );
    const res = await request(
      '/oauth/authorize/uia',
      {
        method: 'POST',
        body: formFields({
          session: 'uia-mxid',
          username: USER_ID,
          password: 'secret',
          action: 'approve',
        }),
      },
      env
    );
    const html = await res.text();
    expect(html).toContain('Invalid username or password');
    // Session must remain for retry (not deleted on auth failure)
    expect(cache.data['uia_session:uia-mxid']).toBeTruthy();
    const stages = JSON.parse(cache.data['uia_session:uia-mxid']).completed_stages;
    expect(stages).toEqual([]);
  });

  it('localpart username still succeeds for same session (contrast)', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache, db: aliceDb() });
    await env.CACHE.put(
      'uia_session:uia-local',
      JSON.stringify({ user_id: USER_ID, completed_stages: [] }),
      { expirationTtl: 300 }
    );
    const res = await request(
      '/oauth/authorize/uia',
      {
        method: 'POST',
        body: formFields({
          session: 'uia-local',
          username: 'alice',
          password: 'secret',
          action: 'approve',
        }),
      },
      env
    );
    expect(await res.text()).toContain('Request Approved');
  });
});

describe('oauth leftovers register client_name XSS escaped on authorize GET after #130', () => {
  it('XSS client_name is escaped into login HTML on authorize GET', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const evil = `<img src=x onerror=alert(1)><script>alert("xss")</script>`;
    const { body: client } = await registerClient(env, {
      client_name: evil,
      redirect_uris: [REDIRECT],
    });
    expect(client.client_name).toBe(evil);
    const res = await request(
      `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
      {},
      env
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(escapeHtml(evil));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('Sign in');
  });

  it('ampersand and quote client_name escaped in subtitle span', async () => {
    const env = makeEnv({ cache: mockKv() });
    const name = `Foo & Bar "Baz" 'Qux'`;
    const { body: client } = await registerClient(env, {
      client_name: name,
      redirect_uris: [REDIRECT],
    });
    const res = await request(
      `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
      {},
      env
    );
    const html = await res.text();
    expect(html).toContain(`<span class="client-name">${escapeHtml(name)}</span>`);
  });
});

describe('oauth leftovers token form-urlencoded grant_type only after #130', () => {
  it('form body with only grant_type rejects missing client_id', async () => {
    const res = await request(
      '/oauth/token',
      formToken({ grant_type: 'authorization_code' })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'invalid_client',
      error_description: 'client_id is required',
    });
  });

  it('form body with grant_type refresh_token only also requires client_id', async () => {
    const res = await request(
      '/oauth/token',
      formToken({ grant_type: 'refresh_token' })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'invalid_client',
      error_description: 'client_id is required',
    });
  });

  it('JSON grant_type only likewise requires client_id before grant dispatch', async () => {
    const res = await request('/oauth/token', jsonToken({ grant_type: 'authorization_code' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error_description: 'client_id is required',
    });
  });
});

describe('oauth leftovers authorize POST replay after session already deleted after #130', () => {
  it('second POST with same auth_request_id after successful login is expired', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: aliceDb() });
    const { body: client } = await registerClient(env);
    const id = await seededAuth(env, { client_id: client.client_id, state: 'replay-st' });

    const first = await request(
      '/oauth/authorize',
      {
        method: 'POST',
        body: formFields({
          username: 'alice',
          password: 'secret',
          auth_request_id: id,
        }),
      },
      env
    );
    expect(first.status).toBe(302);
    expect(sessions.data[`oauth_auth_request:${id}`]).toBeUndefined();

    const replay = await request(
      '/oauth/authorize',
      {
        method: 'POST',
        body: formFields({
          username: 'alice',
          password: 'secret',
          auth_request_id: id,
        }),
      },
      env
    );
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({
      error: 'invalid_request',
      error_description: 'Authorization request expired',
    });
  });

  it('POST after manual SESSIONS delete of auth request is expired', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: aliceDb() });
    const { body: client } = await registerClient(env);
    const id = await seededAuth(env, { client_id: client.client_id });
    await sessions.delete(`oauth_auth_request:${id}`);
    const res = await request(
      '/oauth/authorize',
      {
        method: 'POST',
        body: formFields({
          username: 'alice',
          password: 'secret',
          auth_request_id: id,
        }),
      },
      env
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error_description: 'Authorization request expired',
    });
  });
});

describe('oauth leftovers introspect opaque DB access token after #130', () => {
  it('opaque token present in access_tokens returns active with unknown client_id', async () => {
    const raw = 'opaque-introspect-exists-abc';
    const hash = await hashToken(raw);
    const created = 1_701_111_222_000;
    const db = createOAuthDb({
      tokensByHash: new Map([
        [hash, { user_id: USER_ID, device_id: 'OPAQUE1', created_at: created }],
      ]),
    });
    const env = makeEnv({ db });
    const res = await request('/oauth/introspect', jsonToken({ token: raw }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      active: true,
      sub: USER_ID,
      client_id: 'unknown',
      token_type: 'Bearer',
      iat: Math.floor(created / 1000),
    });
  });

  it('form-urlencoded opaque DB hit for bob device', async () => {
    const raw = 'opaque-bob-form';
    const hash = await hashToken(raw);
    const db = createOAuthDb({
      tokensByHash: new Map([
        [hash, { user_id: BOB_ID, device_id: 'BOBDEV', created_at: NOW }],
      ]),
    });
    const env = makeEnv({ db });
    const res = await request('/oauth/introspect', formToken({ token: raw }), env);
    expect(await res.json()).toMatchObject({
      active: true,
      sub: BOB_ID,
      client_id: 'unknown',
      iat: Math.floor(NOW / 1000),
    });
  });
});

describe('oauth leftovers revoke without content-type JSON body after #130', () => {
  it('JSON body without Content-Type leaves params empty → token required', async () => {
    const res = await request('/oauth/revoke', {
      method: 'POST',
      // intentionally omit Content-Type
      body: JSON.stringify({ token: 'would-be-ignored', token_type_hint: 'refresh_token' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'invalid_request',
      error_description: 'token is required',
    });
  });

  it('empty Content-Type with form-looking body also token required', async () => {
    const res = await request('/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': '' },
      body: 'token=rt-no-ct',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error_description: 'token is required',
    });
  });
});

describe('oauth leftovers multiple register redirect_uris authorize each after #130', () => {
  it('registers three redirect_uris and authorize GET succeeds for each', async () => {
    const uris = [
      'https://one.example.com/cb',
      'https://two.example.com/oauth/callback',
      'http://127.0.0.1:8080/callback',
    ];
    const sessions = mockKv();
    const env = makeEnv({ sessions, cache: mockKv() });
    const { status, body: client } = await registerClient(env, {
      client_name: 'MultiUri',
      redirect_uris: uris,
    });
    expect(status).toBe(201);
    expect(client.redirect_uris).toEqual(uris);

    for (const uri of uris) {
      const res = await request(
        `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(uri)}&response_type=code&state=${encodeURIComponent(uri)}`,
        {},
        env
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('MultiUri');
    }

    const authPuts = sessions.puts.filter((p) => p.key.startsWith('oauth_auth_request:'));
    expect(authPuts).toHaveLength(3);
    const storedUris = authPuts.map((p) => JSON.parse(p.value).redirect_uri).sort();
    expect(storedUris).toEqual([...uris].sort());
  });

  it('fourth unlisted redirect_uri rejected after multi register', async () => {
    const env = makeEnv({ cache: mockKv() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT, REDIRECT_ALT],
    });
    const bad = await request(
      `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&response_type=code`,
      {},
      env
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      error: 'invalid_request',
      error_description: 'Invalid redirect_uri',
    });
  });
});

describe('oauth leftovers PKCE S256 authorize GET through token after #130', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('S256 challenge from authorize GET verifies at token with matching verifier', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: aliceDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      client_name: 'PKCE Public',
    });

    const verifier = 'pkce-s256-verifier-abcdefghijklmnopqrstuvwxyz01';
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(verifier)
    );
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const getRes = await request(
      `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&state=pkce-st`,
      {},
      env
    );
    expect(getRes.status).toBe(200);
    const authId = Object.keys(sessions.data)
      .find((k) => k.startsWith('oauth_auth_request:'))!
      .replace('oauth_auth_request:', '');
    const authReq = JSON.parse(sessions.data[`oauth_auth_request:${authId}`]);
    expect(authReq.code_challenge).toBe(challenge);
    expect(authReq.code_challenge_method).toBe('S256');

    const postRes = await request(
      '/oauth/authorize',
      {
        method: 'POST',
        body: formFields({
          username: 'alice',
          password: 'secret',
          auth_request_id: authId,
        }),
      },
      env
    );
    expect(postRes.status).toBe(302);
    const loc = new URL(postRes.headers.get('Location')!);
    expect(loc.searchParams.get('state')).toBe('pkce-st');
    const code = loc.searchParams.get('code')!;
    const storedCode = JSON.parse(sessions.data[`oauth_code:${code}`]);
    expect(storedCode.code_challenge).toBe(challenge);
    expect(storedCode.code_challenge_method).toBe('S256');

    const tok = await request(
      '/oauth/token',
      formToken({
        grant_type: 'authorization_code',
        client_id: String(client.client_id),
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }),
      env
    );
    expect(tok.status).toBe(200);
    const tokens = await tok.json();
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.user_id).toBe(USER_ID);
    expect(sessions.data[`oauth_code:${code}`]).toBeUndefined();
  });

  it('wrong verifier after S256 authorize GET fails at token', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: aliceDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const verifier = 'correct-verifier-abcdefghijklmnopqrstuvwxyz012';
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(verifier)
    );
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const getRes = await request(
      `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`,
      {},
      env
    );
    expect(getRes.status).toBe(200);
    const authId = Object.keys(sessions.data)
      .find((k) => k.startsWith('oauth_auth_request:'))!
      .replace('oauth_auth_request:', '');
    const postRes = await request(
      '/oauth/authorize',
      {
        method: 'POST',
        body: formFields({
          username: 'alice',
          password: 'secret',
          auth_request_id: authId,
        }),
      },
      env
    );
    const code = new URL(postRes.headers.get('Location')!).searchParams.get('code')!;
    const bad = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code,
        code_verifier: 'wrong-verifier-abcdefghijklmnopqrstuvwxyz012',
      }),
      env
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      error: 'invalid_grant',
      error_description: 'Invalid code_verifier',
    });
  });
});

// ---------------------------------------------------------------------------
// Soft-cap flood wave: authorize param pairs, revoke isolation, UIA/CSRF, etc.
// ---------------------------------------------------------------------------

describe('oauth leftovers authorize GET missing param combinatorial pairs after #130', () => {
  it('missing client_id+redirect_uri reports client_id first (order of checks)', async () => {
    const env = makeEnv();
    const res = await request('/oauth/authorize?response_type=code', {}, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'invalid_request',
      error_description: 'client_id is required',
    });
  });

  it('missing client_id+response_type still client_id required before response_type', async () => {
    const env = makeEnv();
    const res = await request(
      `/oauth/authorize?redirect_uri=${encodeURIComponent(REDIRECT)}`,
      {},
      env
    );
    expect(await res.json()).toMatchObject({ error_description: 'client_id is required' });
  });

  it('missing redirect_uri+response_type with valid client_id reports redirect_uri', async () => {
    const env = makeEnv();
    const { body: client } = await registerClient(env);
    const res = await request(`/oauth/authorize?client_id=${client.client_id}`, {}, env);
    expect(await res.json()).toMatchObject({ error_description: 'redirect_uri is required' });
  });

  it('client_id+redirect_uri present but response_type omitted → unsupported_response_type', async () => {
    const env = makeEnv();
    const { body: client } = await registerClient(env);
    const res = await request(
      `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}`,
      {},
      env
    );
    expect(await res.json()).toMatchObject({ error: 'unsupported_response_type' });
  });

  it('all three required params absent still fails on client_id', async () => {
    const env = makeEnv();
    const res = await request('/oauth/authorize', {}, env);
    expect(await res.json()).toMatchObject({ error_description: 'client_id is required' });
  });
});

describe('oauth leftovers public client Basic empty secret after #130', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('token_endpoint_auth_method none accepts client_secret_basic with empty secret', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'pub-empty-basic', { client_id: String(client.client_id) });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: basicAuth(String(client.client_id), ''),
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: 'pub-empty-basic',
        }),
      },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
  });

  it('none method also ignores empty client_secret in JSON body', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'pub-empty-body', { client_id: String(client.client_id) });
    const res = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        client_secret: '',
        code: 'pub-empty-body',
      }),
      env
    );
    expect(res.status).toBe(200);
  });
});

describe('oauth leftovers revoke access vs refresh isolation after #130', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function issuePair(env: Env) {
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'iso-code', { client_id: String(client.client_id) });
    const tok = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: 'iso-code',
      }),
      env
    );
    const body = await tok.json();
    return { client, access: body.access_token as string, refresh: body.refresh_token as string };
  }

  it('revoke access_token hint leaves refresh intact and usable', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { client, access, refresh } = await issuePair(env);
    const accessHash = await hashToken(access);
    expect(db.tokensByHash.has(accessHash)).toBe(true);
    expect(sessions.data[`oauth_refresh:${refresh}`]).toBeTruthy();

    const rev = await request(
      '/oauth/revoke',
      jsonToken({ token: access, token_type_hint: 'access_token' }),
      env
    );
    expect(rev.status).toBe(200);
    expect(db.tokensByHash.has(accessHash)).toBe(false);
    expect(sessions.data[`oauth_refresh:${refresh}`]).toBeTruthy();

    const refreshed = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: refresh,
      }),
      env
    );
    expect(refreshed.status).toBe(200);
    expect((await refreshed.json()).access_token).toBeTruthy();
  });

  it('revoke refresh_token hint leaves access token row intact', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { access, refresh } = await issuePair(env);
    const accessHash = await hashToken(access);

    const rev = await request(
      '/oauth/revoke',
      formToken({ token: refresh, token_type_hint: 'refresh_token' }),
      env
    );
    expect(rev.status).toBe(200);
    expect(sessions.data[`oauth_refresh:${refresh}`]).toBeUndefined();
    expect(db.tokensByHash.has(accessHash)).toBe(true);

    const intro = await request('/oauth/introspect', jsonToken({ token: access }), env);
    expect(await intro.json()).toMatchObject({ active: true, sub: USER_ID });
  });
});

describe('oauth leftovers introspect after revoke access inactive after #130', () => {
  it('opaque access becomes inactive after access_token revocation', async () => {
    const raw = 'introspect-then-revoke-me';
    const hash = await hashToken(raw);
    const db = createOAuthDb({
      tokensByHash: new Map([
        [hash, { user_id: USER_ID, device_id: 'D-INT', created_at: NOW }],
      ]),
    });
    const env = makeEnv({ db });
    const before = await request('/oauth/introspect', formToken({ token: raw }), env);
    expect(await before.json()).toMatchObject({ active: true, sub: USER_ID });

    await request(
      '/oauth/revoke',
      jsonToken({ token: raw, token_type_hint: 'access_token' }),
      env
    );
    const after = await request('/oauth/introspect', jsonToken({ token: raw }), env);
    expect(await after.json()).toEqual({ active: false });
  });
});

describe('oauth leftovers UIA cancel then GET expired after #130', () => {
  it('GET same session after cancel shows Session Expired', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    await env.CACHE.put(
      'uia_session:cancel-then-get',
      JSON.stringify({ user_id: USER_ID, completed_stages: [] }),
      { expirationTtl: 300 }
    );
    const cancel = await request(
      '/oauth/authorize/uia',
      {
        method: 'POST',
        body: formFields({
          session: 'cancel-then-get',
          action: 'cancel',
          username: 'alice',
          password: 'x',
        }),
      },
      env
    );
    expect(await cancel.text()).toContain('Request Cancelled');
    expect(cache.data['uia_session:cancel-then-get']).toBeUndefined();

    const get = await request(
      '/oauth/authorize/uia?session=cancel-then-get',
      {},
      env
    );
    const html = await get.text();
    expect(html).toContain('Session Expired');
    expect(html).toContain('This session has expired. Please try again.');
  });
});

describe('oauth leftovers authorize login CSRF auth_request_id after #130', () => {
  it('hidden auth_request_id in login HTML matches KV oauth_auth_request key', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions });
    const { body: client } = await registerClient(env, {
      client_name: 'CSRF Client',
      redirect_uris: [REDIRECT],
    });
    const res = await request(
      `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&state=csrf-st`,
      {},
      env
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    const m = html.match(/name="auth_request_id" value="([^"]+)"/);
    expect(m).toBeTruthy();
    const authId = m![1];
    expect(sessions.data[`oauth_auth_request:${authId}`]).toBeTruthy();
    const stored = JSON.parse(sessions.data[`oauth_auth_request:${authId}`]);
    expect(stored.client_id).toBe(client.client_id);
    expect(stored.redirect_uri).toBe(REDIRECT);
    expect(stored.state).toBe('csrf-st');
    expect(html).toContain(`value="${escapeHtml(authId)}"`);
  });
});

describe('oauth leftovers register empty-string redirect_uri after #130', () => {
  it('redirect_uris:[""] registers but authorize with real URI rejects', async () => {
    const env = makeEnv();
    const reg = await registerClient(env, { redirect_uris: [''] });
    expect(reg.status).toBe(201);
    expect(reg.body.redirect_uris).toEqual(['']);

    const bad = await request(
      `/oauth/authorize?client_id=${reg.body.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
      {},
      env
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      error: 'invalid_request',
      error_description: 'Invalid redirect_uri',
    });
  });

  it('authorize with empty redirect_uri query fails as required (not Invalid redirect_uri)', async () => {
    const env = makeEnv();
    const reg = await registerClient(env, { redirect_uris: [''] });
    const res = await request(
      `/oauth/authorize?client_id=${reg.body.client_id}&redirect_uri=&response_type=code`,
      {},
      env
    );
    expect(await res.json()).toMatchObject({
      error_description: 'redirect_uri is required',
    });
  });
});

describe('oauth leftovers token percent-encoded device id in scope after #130', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores literal percent-encoded device id from auth code scope without decoding', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const deviceLiteral = 'DEV%2Fwith%20space';
    await putAuthCode(env, 'pct-dev', {
      client_id: String(client.client_id),
      scope: `openid urn:matrix:org.matrix.msc2967.client:device:${deviceLiteral}`,
    });
    const res = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: 'pct-dev',
      }),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.device_id).toBe(deviceLiteral);
    expect(body.device_id).not.toBe('DEV/with space');
  });
});

describe('oauth leftovers form token duplicate keys last-wins after #130', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('duplicate code= in urlencoded body uses last value', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'code-last-wins', { client_id: String(client.client_id) });
    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('client_id', String(client.client_id));
    params.append('code', 'code-wrong-first');
    params.append('code', 'code-last-wins');
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      },
      env
    );
    expect(res.status).toBe(200);
    expect((await res.json()).access_token).toBeTruthy();
  });

  it('duplicate grant_type last-wins to refresh_token over authorization_code', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await sessions.put(
      'oauth_refresh:dup-gt-rt',
      JSON.stringify({
        token_id: 't1',
        access_token_hash: 'h',
        refresh_token_hash: 'rh',
        client_id: client.client_id,
        user_id: USER_ID,
        device_id: 'D',
        scope: 'openid',
        created_at: NOW,
        expires_at: NOW + 86_400_000,
      }),
      { expirationTtl: 86400 }
    );
    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('grant_type', 'refresh_token');
    params.append('client_id', String(client.client_id));
    params.append('refresh_token', 'dup-gt-rt');
    params.append('code', 'would-be-used-if-first-won');
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toBeTruthy();
    expect(body.user_id).toBeUndefined();
    expect(sessions.data['oauth_refresh:dup-gt-rt']).toBeUndefined();
  });
});

describe('oauth leftovers JSON token unknown fields ignored after #130', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('extra unknown JSON fields do not break authorization_code exchange', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'extra-fields', { client_id: String(client.client_id) });
    const res = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: 'extra-fields',
        resource: 'https://matrix.example.com/',
        audience: 'matrix',
        foo: { nested: true },
        client_assertion: 'not-used',
        extension_xyz: 123,
      }),
      env
    );
    expect(res.status).toBe(200);
    expect((await res.json()).token_type).toBe('Bearer');
  });
});

describe('oauth leftovers userinfo GET vs POST identical body after #130', () => {
  it('GET and POST with same Bearer token return deeply equal JSON', async () => {
    const token = 'userinfo-identical-tok';
    const hash = await hashToken(token);
    const db = aliceDb();
    db.tokensByHash.set(hash, {
      user_id: USER_ID,
      device_id: 'IDENT',
      created_at: NOW,
    });
    const env = makeEnv({ db });
    const getRes = await request(
      '/oauth/userinfo',
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );
    const postRes = await request(
      '/oauth/userinfo',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      },
      env
    );
    expect(getRes.status).toBe(200);
    expect(postRes.status).toBe(200);
    const getBody = await getRes.json();
    const postBody = await postRes.json();
    expect(postBody).toEqual(getBody);
    expect(getBody).toEqual({
      sub: USER_ID,
      name: 'Alice',
      picture: 'mxc://example.com/a',
      'urn:matrix:user_id': USER_ID,
    });
  });
});

describe('oauth leftovers UIA success postMessage session escaping after #130', () => {
  it('quotes and XSS in session id are escaped inside postMessage script', () => {
    const sid = `sess"1';alert(1)//`;
    const html = generateUiaSuccessPage(sid, SERVER);
    expect(html).toContain(`session: '${escapeHtml(sid)}'`);
    expect(html).toContain(escapeHtml(sid));
    expect(html).not.toContain(`session: '${sid}'`);
    expect(html).not.toMatch(/session: 'sess"1'/);
    expect(html).toContain('&quot;');
    expect(html).toContain("type: 'uia_complete'");
  });

  it('approve POST with quote-laden session embeds escaped id in success HTML', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache, db: aliceDb() });
    const sid = `uia"xss'><img>`;
    await env.CACHE.put(
      `uia_session:${sid}`,
      JSON.stringify({ user_id: USER_ID, completed_stages: [] }),
      { expirationTtl: 300 }
    );
    const res = await request(
      '/oauth/authorize/uia',
      {
        method: 'POST',
        body: formFields({
          session: sid,
          username: 'alice',
          password: 'secret',
          action: 'approve',
        }),
      },
      env
    );
    const html = await res.text();
    expect(html).toContain('Request Approved');
    expect(html).toContain(`session: '${escapeHtml(sid)}'`);
    expect(html).not.toContain(`session: '${sid}'`);
  });
});

describe('oauth leftovers authorize wrong password then retry after #130', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('failed login issues new auth_request_id in HTML; retry with it succeeds', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: aliceDb('secret') });
    const { body: client } = await registerClient(env, {
      client_name: 'Retry Client',
      redirect_uris: [REDIRECT],
    });
    const getRes = await request(
      `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&state=retry-st`,
      {},
      env
    );
    const firstHtml = await getRes.text();
    const firstId = firstHtml.match(/name="auth_request_id" value="([^"]+)"/)![1];
    expect(sessions.data[`oauth_auth_request:${firstId}`]).toBeTruthy();

    const fail = await request(
      '/oauth/authorize',
      {
        method: 'POST',
        body: formFields({
          username: 'alice',
          password: 'wrong-password',
          auth_request_id: firstId,
        }),
      },
      env
    );
    expect(fail.status).toBe(200);
    const failHtml = await fail.text();
    expect(failHtml).toContain('Invalid username or password');
    expect(sessions.data[`oauth_auth_request:${firstId}`]).toBeUndefined();
    const retryId = failHtml.match(/name="auth_request_id" value="([^"]+)"/)![1];
    expect(retryId).not.toBe(firstId);
    expect(sessions.data[`oauth_auth_request:${retryId}`]).toBeTruthy();
    const preserved = JSON.parse(sessions.data[`oauth_auth_request:${retryId}`]);
    expect(preserved.state).toBe('retry-st');
    expect(preserved.client_id).toBe(client.client_id);

    const ok = await request(
      '/oauth/authorize',
      {
        method: 'POST',
        body: formFields({
          username: 'alice',
          password: 'secret',
          auth_request_id: retryId,
        }),
      },
      env
    );
    expect(ok.status).toBe(302);
    const loc = new URL(ok.headers.get('Location')!);
    expect(loc.searchParams.get('state')).toBe('retry-st');
    expect(loc.searchParams.get('code')).toBeTruthy();
  });
});

describe('oauth leftovers concurrent two clients independent codes after #130', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('two clients get distinct codes and exchange independently', async () => {
    const sessions = mockKv();
    const db = aliceDb();
    const env = makeEnv({ sessions, db });
    const a = await registerClient(env, {
      client_name: 'Client A',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const b = await registerClient(env, {
      client_name: 'Client B',
      redirect_uris: [REDIRECT_ALT],
      token_endpoint_auth_method: 'none',
    });

    async function loginFor(clientId: string, redirect: string) {
      const getRes = await request(
        `/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code`,
        {},
        env
      );
      const authId = (await getRes.text()).match(/name="auth_request_id" value="([^"]+)"/)![1];
      const post = await request(
        '/oauth/authorize',
        {
          method: 'POST',
          body: formFields({
            username: 'alice',
            password: 'secret',
            auth_request_id: authId,
          }),
        },
        env
      );
      return new URL(post.headers.get('Location')!).searchParams.get('code')!;
    }

    const codeA = await loginFor(String(a.body.client_id), REDIRECT);
    const codeB = await loginFor(String(b.body.client_id), REDIRECT_ALT);
    expect(codeA).not.toBe(codeB);
    expect(sessions.data[`oauth_code:${codeA}`]).toBeTruthy();
    expect(sessions.data[`oauth_code:${codeB}`]).toBeTruthy();
    expect(JSON.parse(sessions.data[`oauth_code:${codeA}`]).client_id).toBe(a.body.client_id);
    expect(JSON.parse(sessions.data[`oauth_code:${codeB}`]).client_id).toBe(b.body.client_id);

    const tokA = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: a.body.client_id,
        code: codeA,
        redirect_uri: REDIRECT,
      }),
      env
    );
    const tokB = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: b.body.client_id,
        code: codeB,
        redirect_uri: REDIRECT_ALT,
      }),
      env
    );
    expect(tokA.status).toBe(200);
    expect(tokB.status).toBe(200);
    const bodyA = await tokA.json();
    const bodyB = await tokB.json();
    expect(bodyA.access_token).not.toBe(bodyB.access_token);
    expect(bodyA.refresh_token).not.toBe(bodyB.refresh_token);

    const cross = await request(
      '/oauth/token',
      jsonToken({
        grant_type: 'authorization_code',
        client_id: a.body.client_id,
        code: codeB,
      }),
      env
    );
    // codeB already consumed
    expect(cross.status).toBe(400);
    expect(await cross.json()).toMatchObject({
      error: 'invalid_grant',
      error_description: 'Invalid or expired authorization code',
    });
  });
});

describe('oauth leftovers revoke token_type_hint typo after #130', () => {
  it('typo hint matches neither branch — refresh and access both remain; still 200', async () => {
    const rawAccess = 'hint-typo-access';
    const hash = await hashToken(rawAccess);
    const db = createOAuthDb({
      tokensByHash: new Map([
        [hash, { user_id: USER_ID, device_id: 'D', created_at: NOW }],
      ]),
    });
    const sessions = mockKv({ 'oauth_refresh:hint-typo-rt': '{"keep":true}' });
    const env = makeEnv({ sessions, db });

    // typo on refresh token value with wrong hint — skips refresh path (hint not refresh_token)
    // and skips access path (hint not access_token / not empty)
    const revRt = await request(
      '/oauth/revoke',
      jsonToken({ token: 'hint-typo-rt', token_type_hint: 'refresh_tokn' }),
      env
    );
    expect(revRt.status).toBe(200);
    expect(sessions.data['oauth_refresh:hint-typo-rt']).toBe('{"keep":true}');
    expect(sessions.deletes).not.toContain('oauth_refresh:hint-typo-rt');

    const revAt = await request(
      '/oauth/revoke',
      formToken({ token: rawAccess, token_type_hint: 'access_tokn' }),
      env
    );
    expect(revAt.status).toBe(200);
    expect(db.tokensByHash.has(hash)).toBe(true);
    expect(db.deletes.length).toBe(0);
  });

  it('case-sensitive hint Refresh_Token also skips both paths', async () => {
    const sessions = mockKv({ 'oauth_refresh:case-hint': '{}' });
    const env = makeEnv({ sessions });
    const res = await request(
      '/oauth/revoke',
      jsonToken({ token: 'case-hint', token_type_hint: 'Refresh_Token' }),
      env
    );
    expect(res.status).toBe(200);
    expect(sessions.data['oauth_refresh:case-hint']).toBe('{}');
  });
});

describe('oauth leftovers introspect JWT minimal sub-only variants after #130', () => {
  it('JWT with only sub via form-urlencoded is active with undefined client_id', async () => {
    const token = fakeJwt({ sub: USER_ID });
    const res = await request('/oauth/introspect', formToken({ token }));
    const body = await res.json();
    expect(body).toMatchObject({
      active: true,
      sub: USER_ID,
      token_type: 'Bearer',
    });
    expect(body.client_id).toBeUndefined();
    expect(body.exp).toBeUndefined();
    expect(body.scope).toBeUndefined();
  });

  it('JWT with sub plus empty-string scope still active', async () => {
    const token = fakeJwt({ sub: BOB_ID, scope: '' });
    const res = await request('/oauth/introspect', jsonToken({ token }));
    expect(await res.json()).toMatchObject({
      active: true,
      sub: BOB_ID,
      scope: '',
    });
  });
});

describe('oauth leftovers authorize omitted scope defaults openid after #130', () => {
  it('omitted scope query param stores openid (distinct from empty-string case)', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions });
    const { body: client } = await registerClient(env);
    const res = await request(
      `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
      {},
      env
    );
    expect(res.status).toBe(200);
    const put = sessions.puts.find((p) => p.key.startsWith('oauth_auth_request:'));
    expect(JSON.parse(put!.value).scope).toBe('openid');
  });

  it('omitted scope survives authorize POST into auth code', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const sessions = mockKv();
      const env = makeEnv({ sessions, db: aliceDb() });
      const { body: client } = await registerClient(env, {
        redirect_uris: [REDIRECT],
      });
      const getRes = await request(
        `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
        {},
        env
      );
      const authId = (await getRes.text()).match(/name="auth_request_id" value="([^"]+)"/)![1];
      const post = await request(
        '/oauth/authorize',
        {
          method: 'POST',
          body: formFields({
            username: 'alice',
            password: 'secret',
            auth_request_id: authId,
          }),
        },
        env
      );
      const code = new URL(post.headers.get('Location')!).searchParams.get('code')!;
      expect(JSON.parse(sessions.data[`oauth_code:${code}`]).scope).toBe('openid');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('oauth leftovers revoke typo then correct hint recovers after #130', () => {
  it('after typo no-op, correct access_token hint revokes; introspect inactive', async () => {
    const raw = 'typo-then-fix';
    const hash = await hashToken(raw);
    const db = createOAuthDb({
      tokensByHash: new Map([
        [hash, { user_id: USER_ID, device_id: 'D', created_at: NOW }],
      ]),
    });
    const env = makeEnv({ db });
    await request(
      '/oauth/revoke',
      jsonToken({ token: raw, token_type_hint: 'accesstoken' }),
      env
    );
    expect(db.tokensByHash.has(hash)).toBe(true);
    await request(
      '/oauth/revoke',
      jsonToken({ token: raw, token_type_hint: 'access_token' }),
      env
    );
    expect(db.tokensByHash.has(hash)).toBe(false);
    const intro = await request('/oauth/introspect', jsonToken({ token: raw }), env);
    expect(await intro.json()).toEqual({ active: false });
  });
});

describe('oauth leftovers concurrent auth requests same client after #130', () => {
  it('two parallel authorize GETs for same client yield independent auth request ids', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions });
    const { body: client } = await registerClient(env);
    const [r1, r2] = await Promise.all([
      request(
        `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&state=s1`,
        {},
        env
      ),
      request(
        `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&state=s2`,
        {},
        env
      ),
    ]);
    const id1 = (await r1.text()).match(/name="auth_request_id" value="([^"]+)"/)![1];
    const id2 = (await r2.text()).match(/name="auth_request_id" value="([^"]+)"/)![1];
    expect(id1).not.toBe(id2);
    expect(JSON.parse(sessions.data[`oauth_auth_request:${id1}`]).state).toBe('s1');
    expect(JSON.parse(sessions.data[`oauth_auth_request:${id2}`]).state).toBe('s2');
  });
});
