/**
 * Deep route coverage for src/api/oauth.ts (OAuth 2.0 / OIDC-native provider).
 * Tests-only deepen — no product changes. Exercises register, authorize, token,
 * revoke, introspect, userinfo, and UIA approval HTML flows via Hono app.request().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { hashToken } from '../src/utils/crypto';

const SERVER = 'matrix.example.com';
const USER_ID = `@alice:${SERVER}`;
const REDIRECT = 'https://element.example.com/callback';

vi.mock('../src/utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/crypto')>();
  return {
    ...actual,
    // Avoid 100k-iter PBKDF2 in authorize/UIA loops; product paths still call it.
    verifyPassword: vi.fn(async (password: string, storedHash: string) => {
      return storedHash === `mockok:${password}`;
    }),
  };
});

import oauth from '../src/api/oauth';

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
      // Match Workers KV: Promise<void> → undefined
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

function base64UrlEncode(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function s256Challenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(hash));
}

function b64urlJson(obj: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

function fakeJwt(payload: Record<string, unknown>): string {
  return `${b64urlJson({ alg: 'none', typ: 'JWT' })}.${b64urlJson(payload)}.sig`;
}

describe('POST /oauth/register (RFC 7591)', () => {
  it('rejects invalid JSON body', async () => {
    const res = await request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Invalid JSON body',
    });
  });

  it('requires redirect_uris non-empty', async () => {
    const env = makeEnv();
    const empty = await registerClient(env, { client_name: 'x', redirect_uris: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe('invalid_client_metadata');

    const missing = await registerClient(env, { client_name: 'x' });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('invalid_client_metadata');
  });

  it('registers confidential client with secret and defaults', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const { status, body } = await registerClient(env, {
      redirect_uris: [REDIRECT, 'https://other.example/cb'],
    });
    expect(status).toBe(201);
    expect(body.client_id).toMatch(/^client_[0-9a-f]{32}$/);
    expect(typeof body.client_secret).toBe('string');
    expect((body.client_secret as string).length).toBe(64);
    expect(body.client_secret_expires_at).toBe(0);
    expect(body.client_name).toBe('Unknown Client');
    expect(body.redirect_uris).toEqual([REDIRECT, 'https://other.example/cb']);
    expect(body.grant_types).toEqual(['authorization_code']);
    expect(body.response_types).toEqual(['code']);
    expect(body.token_endpoint_auth_method).toBe('client_secret_basic');
    expect(typeof body.client_id_issued_at).toBe('number');

    const stored = JSON.parse(cache.data[`oauth_client:${body.client_id}`]);
    expect(stored.client_secret_hash).toBeTruthy();
    expect(stored.client_secret_hash).not.toBe(body.client_secret);
    expect(cache.puts[0].options?.expirationTtl).toBe(365 * 24 * 60 * 60);
  });

  it('omits client_secret when token_endpoint_auth_method is none', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const { status, body } = await registerClient(env, {
      client_name: 'Public SPA',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    expect(status).toBe(201);
    expect(body.client_secret).toBeUndefined();
    expect(body.client_secret_expires_at).toBeUndefined();
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.grant_types).toEqual(['authorization_code', 'refresh_token']);

    const stored = JSON.parse(cache.data[`oauth_client:${body.client_id}`]);
    expect(stored.client_secret_hash).toBeNull();
    expect(stored.client_name).toBe('Public SPA');
  });
});

describe('GET /oauth/authorize', () => {
  it('validates required query params and response_type', async () => {
    expect((await request('/oauth/authorize')).status).toBe(400);
    expect(await (await request('/oauth/authorize')).json()).toMatchObject({
      error: 'invalid_request',
      error_description: 'client_id is required',
    });

    const noRedirect = await request(`/oauth/authorize?client_id=c1`);
    expect(await noRedirect.json()).toMatchObject({
      error_description: 'redirect_uri is required',
    });

    const badType = await request(
      `/oauth/authorize?client_id=c1&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=token`
    );
    expect(await badType.json()).toMatchObject({
      error: 'unsupported_response_type',
    });
  });

  it('rejects unknown client and redirect_uri not registered', async () => {
    const env = makeEnv();
    const { body: client } = await registerClient(env);

    const unknown = await request(
      `/oauth/authorize?client_id=nope&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
      {},
      env
    );
    expect(await unknown.json()).toMatchObject({ error: 'invalid_client' });

    const badRedirect = await request(
      `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent('https://evil.example/')}&response_type=code`,
      {},
      env
    );
    expect(await badRedirect.json()).toMatchObject({
      error: 'invalid_request',
      error_description: 'Invalid redirect_uri',
    });
  });

  it('stores auth request in SESSIONS and returns HTML login page', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions });
    const { body: client } = await registerClient(env, {
      client_name: 'My <App> & "Co"',
      redirect_uris: [REDIRECT],
    });

    const qs = new URLSearchParams({
      client_id: String(client.client_id),
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:api:*',
      state: 'state-xyz',
      nonce: 'nonce-abc',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
    });
    const res = await request(`/oauth/authorize?${qs}`, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('Sign in');
    expect(html).toContain(SERVER);
    // escapeHtml on client name
    expect(html).toContain('My &lt;App&gt; &amp; &quot;Co&quot;');
    expect(html).not.toContain('My <App>');

    const authKeys = Object.keys(sessions.data).filter((k) =>
      k.startsWith('oauth_auth_request:')
    );
    expect(authKeys).toHaveLength(1);
    const stored = JSON.parse(sessions.data[authKeys[0]]);
    expect(stored).toMatchObject({
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      scope: 'openid urn:matrix:org.matrix.msc2967.client:api:*',
      state: 'state-xyz',
      nonce: 'nonce-abc',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
    });
    expect(sessions.puts[0].options?.expirationTtl).toBe(600);
    expect(html).toContain(`value="${authKeys[0].replace('oauth_auth_request:', '')}"`);
  });

  it('defaults scope to openid and code_challenge_method to plain', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions });
    const { body: client } = await registerClient(env);
    const qs = new URLSearchParams({
      client_id: String(client.client_id),
      redirect_uri: REDIRECT,
      response_type: 'code',
    });
    await request(`/oauth/authorize?${qs}`, {}, env);
    const key = Object.keys(sessions.data)[0];
    const stored = JSON.parse(sessions.data[key]);
    expect(stored.scope).toBe('openid');
    expect(stored.code_challenge_method).toBe('plain');
  });
});

describe('POST /oauth/authorize', () => {
  const NOW = 1_730_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function seededAuth(env: Env, authRequest: Record<string, unknown>, id = 'req123') {
    await env.SESSIONS.put(`oauth_auth_request:${id}`, JSON.stringify(authRequest), {
      expirationTtl: 600,
    });
    return id;
  }

  it('returns login HTML when username/password/auth_request_id missing', async () => {
    const env = makeEnv();
    const form = new FormData();
    form.set('username', 'alice');
    const res = await request('/oauth/authorize', { method: 'POST', body: form }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Missing username or password');
  });

  it('returns invalid_request when auth request expired', async () => {
    const env = makeEnv();
    const form = new FormData();
    form.set('username', 'alice');
    form.set('password', 'pw');
    form.set('auth_request_id', 'gone');
    const res = await request('/oauth/authorize', { method: 'POST', body: form }, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'invalid_request',
      error_description: 'Authorization request expired',
    });
  });

  it('rejects unknown user and recreates auth request for retry', async () => {
    const sessions = mockKv();
    const cache = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, cache, db });
    const { body: client } = await registerClient(env, {
      client_name: 'Retry Client',
      redirect_uris: [REDIRECT],
    });
    const id = await seededAuth(env, {
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      scope: 'openid',
      state: 's1',
    });

    const form = new FormData();
    form.set('username', 'alice');
    form.set('password', 'secret');
    form.set('auth_request_id', id);
    const res = await request('/oauth/authorize', { method: 'POST', body: form }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Invalid username or password');
    expect(html).toContain('Retry Client');
    expect(sessions.data[`oauth_auth_request:${id}`]).toBeUndefined();
    const newKeys = Object.keys(sessions.data).filter((k) =>
      k.startsWith('oauth_auth_request:')
    );
    expect(newKeys).toHaveLength(1);
  });

  it('rejects bad password via mocked verifyPassword', async () => {
    const sessions = mockKv();
    const db = createOAuthDb({
      users: new Map([
        [
          USER_ID,
          userRow({
            user_id: USER_ID,
            localpart: 'alice',
            password_hash: 'mockok:other',
          }),
        ],
      ]),
    });
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env);
    const id = await seededAuth(env, {
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      scope: 'openid',
    });

    const form = new FormData();
    form.set('username', 'alice');
    form.set('password', 'wrong');
    form.set('auth_request_id', id);
    const res = await request('/oauth/authorize', { method: 'POST', body: form }, env);
    expect(await res.text()).toContain('Invalid username or password');
  });

  it('issues authorization code and redirects with state', async () => {
    const sessions = mockKv();
    const db = createOAuthDb({
      users: new Map([
        [
          USER_ID,
          userRow({
            user_id: USER_ID,
            localpart: 'alice',
            password_hash: 'mockok:correct',
          }),
        ],
      ]),
    });
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env);
    const id = await seededAuth(env, {
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      scope: 'openid profile',
      state: 'return-me',
      nonce: 'n1',
      code_challenge: 'plain-chal',
      code_challenge_method: 'plain',
    });

    const form = new FormData();
    form.set('username', 'alice');
    form.set('password', 'correct');
    form.set('auth_request_id', id);
    const res = await request('/oauth/authorize', { method: 'POST', body: form }, env);
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location.startsWith(REDIRECT)).toBe(true);
    const url = new URL(location);
    expect(url.searchParams.get('state')).toBe('return-me');
    const code = url.searchParams.get('code')!;
    expect(code).toMatch(/^[0-9a-f]{64}$/);

    const authCode = JSON.parse(sessions.data[`oauth_code:${code}`]);
    expect(authCode).toMatchObject({
      code,
      client_id: client.client_id,
      user_id: USER_ID,
      redirect_uri: REDIRECT,
      scope: 'openid profile',
      code_challenge: 'plain-chal',
      code_challenge_method: 'plain',
      nonce: 'n1',
      created_at: NOW,
      expires_at: NOW + 10 * 60 * 1000,
    });
  });

  it('omits state query param when auth request had no state', async () => {
    const sessions = mockKv();
    const db = createOAuthDb({
      users: new Map([
        [
          USER_ID,
          userRow({
            user_id: USER_ID,
            localpart: 'alice',
            password_hash: 'mockok:correct',
          }),
        ],
      ]),
    });
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env);
    const id = await seededAuth(env, {
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      scope: 'openid',
    });
    const form = new FormData();
    form.set('username', 'alice');
    form.set('password', 'correct');
    form.set('auth_request_id', id);
    const res = await request('/oauth/authorize', { method: 'POST', body: form }, env);
    const url = new URL(res.headers.get('Location')!);
    expect(url.searchParams.has('state')).toBe(false);
  });
});

describe('POST /oauth/token', () => {
  const NOW = 1_730_100_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function setupConfidential(env: Env) {
    return registerClient(env, {
      client_name: 'Confidential',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
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
      created_at: NOW,
      expires_at: patch.expires_at ?? NOW + 600_000,
    };
    await env.SESSIONS.put(`oauth_code:${code}`, JSON.stringify(authCode), {
      expirationTtl: 600,
    });
  }

  it('rejects unsupported content type and missing client_id', async () => {
    const env = makeEnv();
    const badCt = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'grant_type=authorization_code',
      },
      env
    );
    expect(await badCt.json()).toMatchObject({ error: 'invalid_request' });

    const noClient = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'authorization_code', code: 'x' }),
      },
      env
    );
    expect(await noClient.json()).toMatchObject({
      error: 'invalid_client',
      error_description: 'client_id is required',
    });
  });

  it('rejects unknown client and wrong client_secret', async () => {
    const env = makeEnv();
    const { body: client } = await setupConfidential(env);

    const unknown = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'missing',
          client_secret: 'x',
          code: 'c',
        }),
      },
      env
    );
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toMatchObject({ error: 'invalid_client' });

    const noSecret = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code: 'c',
        }),
      },
      env
    );
    expect(noSecret.status).toBe(401);
    expect(await noSecret.json()).toMatchObject({
      error_description: 'client_secret is required',
    });

    const badSecret = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          client_secret: 'wrong-secret-value',
          code: 'c',
        }),
      },
      env
    );
    expect(badSecret.status).toBe(401);
    expect(await badSecret.json()).toMatchObject({
      error_description: 'Invalid client credentials',
    });
  });

  it('accepts client_secret_basic Authorization header', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { body: client } = await setupConfidential(env);
    await putAuthCode(env, 'code1', { client_id: String(client.client_id) });

    const basic = btoa(
      `${encodeURIComponent(String(client.client_id))}:${encodeURIComponent(String(client.client_secret))}`
    );
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'code1',
          redirect_uri: REDIRECT,
        }),
      },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.user_id).toBe(USER_ID);
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    expect(body.device_id).toBeTruthy();
    expect(sessions.data[`oauth_code:code1`]).toBeUndefined();
    expect(sessions.data[`oauth_refresh:${body.refresh_token}`]).toBeTruthy();
    expect(db.inserts.some((i) => i.sql.includes('INTO devices'))).toBe(true);
    expect(db.inserts.some((i) => i.sql.includes('INTO access_tokens'))).toBe(true);
  });

  it('authorization_code grant validates code, expiry, client, redirect, PKCE plain/S256', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { body: client } = await setupConfidential(env);
    const cid = String(client.client_id);
    const secret = String(client.client_secret);

    // missing code
    expect(
      await (
        await request(
          '/oauth/token',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              grant_type: 'authorization_code',
              client_id: cid,
              client_secret: secret,
            }),
          },
          env
        )
      ).json()
    ).toMatchObject({ error_description: 'code is required' });

    // invalid code
    expect(
      await (
        await request(
          '/oauth/token',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              grant_type: 'authorization_code',
              client_id: cid,
              client_secret: secret,
              code: 'missing',
            }),
          },
          env
        )
      ).json()
    ).toMatchObject({ error: 'invalid_grant' });

    // wrong client
    await putAuthCode(env, 'c-wrong-client', { client_id: 'other' });
    expect(
      await (
        await request(
          '/oauth/token',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              grant_type: 'authorization_code',
              client_id: cid,
              client_secret: secret,
              code: 'c-wrong-client',
            }),
          },
          env
        )
      ).json()
    ).toMatchObject({ error_description: 'Code was not issued to this client' });

    // expired
    await putAuthCode(env, 'c-expired', {
      client_id: cid,
      expires_at: NOW - 1,
    });
    expect(
      await (
        await request(
          '/oauth/token',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              grant_type: 'authorization_code',
              client_id: cid,
              client_secret: secret,
              code: 'c-expired',
            }),
          },
          env
        )
      ).json()
    ).toMatchObject({ error_description: 'Authorization code has expired' });

    // redirect mismatch
    await putAuthCode(env, 'c-redir', { client_id: cid });
    expect(
      await (
        await request(
          '/oauth/token',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              grant_type: 'authorization_code',
              client_id: cid,
              client_secret: secret,
              code: 'c-redir',
              redirect_uri: 'https://evil.example/',
            }),
          },
          env
        )
      ).json()
    ).toMatchObject({ error_description: 'redirect_uri mismatch' });

    // PKCE plain missing verifier
    await putAuthCode(env, 'c-pkce-plain', {
      client_id: cid,
      code_challenge: 'verifier-value',
      code_challenge_method: 'plain',
    });
    expect(
      await (
        await request(
          '/oauth/token',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              grant_type: 'authorization_code',
              client_id: cid,
              client_secret: secret,
              code: 'c-pkce-plain',
            }),
          },
          env
        )
      ).json()
    ).toMatchObject({ error_description: 'code_verifier is required' });

    // PKCE plain wrong verifier
    await putAuthCode(env, 'c-pkce-plain2', {
      client_id: cid,
      code_challenge: 'verifier-value',
      code_challenge_method: 'plain',
    });
    expect(
      await (
        await request(
          '/oauth/token',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              grant_type: 'authorization_code',
              client_id: cid,
              client_secret: secret,
              code: 'c-pkce-plain2',
              code_verifier: 'nope',
            }),
          },
          env
        )
      ).json()
    ).toMatchObject({ error_description: 'Invalid code_verifier' });

    // PKCE S256 success + device from MSC2967 scope
    const verifier = 's256-verifier-abcdefghijklmnopqrstuvwxyz012345';
    const challenge = await s256Challenge(verifier);
    await putAuthCode(env, 'c-s256', {
      client_id: cid,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope:
        'openid urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:DEVICEABC',
    });
    const ok = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: cid,
          client_secret: secret,
          code: 'c-s256',
          code_verifier: verifier,
          redirect_uri: REDIRECT,
        }),
      },
      env
    );
    expect(ok.status).toBe(200);
    const tok = await ok.json();
    expect(tok.device_id).toBe('DEVICEABC');
    expect(tok.scope).toContain('urn:matrix:org.matrix.msc2967.client:device:DEVICEABC');
  });

  it('treats device scope * as fallback to generateDeviceId', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { body: client } = await setupConfidential(env);
    await putAuthCode(env, 'c-star', {
      client_id: String(client.client_id),
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:*',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          client_secret: client.client_secret,
          code: 'c-star',
        }),
      },
      env
    );
    const body = await res.json();
    expect(body.device_id).toBeTruthy();
    expect(body.device_id).not.toBe('*');
  });

  it('refresh_token grant rotates tokens and rejects wrong client', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { body: client } = await setupConfidential(env);
    const refresh = 'refresh-old-token';
    await sessions.put(
      `oauth_refresh:${refresh}`,
      JSON.stringify({
        token_id: 'tid1',
        access_token_hash: 'h1',
        refresh_token_hash: 'rh1',
        client_id: client.client_id,
        user_id: USER_ID,
        device_id: 'DEV1',
        scope: 'openid',
        created_at: NOW,
        expires_at: NOW + 86400_000,
      })
    );

    const missing = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: client.client_id,
          client_secret: client.client_secret,
        }),
      },
      env
    );
    expect(await missing.json()).toMatchObject({
      error_description: 'refresh_token is required',
    });

    const bad = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: client.client_id,
          client_secret: client.client_secret,
          refresh_token: 'nope',
        }),
      },
      env
    );
    expect(await bad.json()).toMatchObject({ error: 'invalid_grant' });

    // wrong client ownership
    await sessions.put(
      `oauth_refresh:owned-elsewhere`,
      JSON.stringify({
        token_id: 'tid2',
        access_token_hash: 'h2',
        client_id: 'other-client',
        user_id: USER_ID,
        device_id: 'DEV1',
        scope: 'openid',
        created_at: NOW,
        expires_at: NOW + 86400_000,
      })
    );
    expect(
      await (
        await request(
          '/oauth/token',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              grant_type: 'refresh_token',
              client_id: client.client_id,
              client_secret: client.client_secret,
              refresh_token: 'owned-elsewhere',
            }),
          },
          env
        )
      ).json()
    ).toMatchObject({ error_description: 'Token was not issued to this client' });

    const ok = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: client.client_id,
          client_secret: client.client_secret,
          refresh_token: refresh,
        }),
      },
      env
    );
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    expect(body.refresh_token).not.toBe(refresh);
    expect(sessions.data[`oauth_refresh:${refresh}`]).toBeUndefined();
    expect(sessions.data[`oauth_refresh:${body.refresh_token}`]).toBeTruthy();
    expect(body.scope).toBe('openid');
  });

  it('rejects unsupported grant_type', async () => {
    const env = makeEnv();
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: client.client_id,
        }),
      },
      env
    );
    expect(await res.json()).toMatchObject({ error: 'unsupported_grant_type' });
  });

  it('skips secret check for public clients (auth method none)', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'pub-code', { client_id: String(client.client_id) });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code: 'pub-code',
        }),
      },
      env
    );
    expect(res.status).toBe(200);
  });
});

describe('POST /oauth/revoke', () => {
  it('requires token parameter', async () => {
    const res = await request('/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('returns 200 for refresh_token hint and deletes session key', async () => {
    const sessions = mockKv({ 'oauth_refresh:rt1': '{"client_id":"c"}' });
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: 'rt1',
          token_type_hint: 'refresh_token',
        }),
      },
      env
    );
    // Workers KV delete returns undefined, so path falls through to access_token DELETE then 200
    expect(res.status).toBe(200);
    expect(sessions.data['oauth_refresh:rt1']).toBeUndefined();
  });

  it('deletes access token hash from DB when hint is access_token', async () => {
    const db = createOAuthDb();
    const env = makeEnv({ db });
    const token = 'access-token-value';
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, {
      user_id: USER_ID,
      device_id: 'D1',
      created_at: Date.now(),
    });

    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, token_type_hint: 'access_token' }),
      },
      env
    );
    expect(res.status).toBe(200);
    expect(db.tokensByHash.has(hash)).toBe(false);
    expect(db.deletes.some((d) => d.sql.includes('DELETE FROM access_tokens'))).toBe(true);
  });

  it('returns 200 even when token does not exist (RFC 7009)', async () => {
    const res = await request('/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'never-existed' }),
    });
    expect(res.status).toBe(200);
  });
});

describe('POST /oauth/introspect', () => {
  const NOW = 1_730_200_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('requires token', async () => {
    const res = await request('/oauth/introspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('introspects active and expired JWTs', async () => {
    const active = fakeJwt({
      sub: USER_ID,
      client_id: 'c1',
      exp: Math.floor(NOW / 1000) + 3600,
      iat: Math.floor(NOW / 1000),
      scope: 'openid',
      iss: `https://${SERVER}`,
    });
    const activeRes = await request('/oauth/introspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: active }),
    });
    expect(await activeRes.json()).toMatchObject({
      active: true,
      sub: USER_ID,
      client_id: 'c1',
      token_type: 'Bearer',
      scope: 'openid',
      iss: `https://${SERVER}`,
    });

    const expired = fakeJwt({
      sub: USER_ID,
      exp: Math.floor(NOW / 1000) - 10,
    });
    expect(
      await (
        await request('/oauth/introspect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: expired }),
        })
      ).json()
    ).toEqual({ active: false });
  });

  it('uses azp as client_id when client_id claim absent', async () => {
    const jwt = fakeJwt({
      sub: USER_ID,
      azp: 'azp-client',
      exp: Math.floor(NOW / 1000) + 60,
    });
    const body = await (
      await request('/oauth/introspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: jwt }),
      })
    ).json();
    expect(body.client_id).toBe('azp-client');
  });

  it('falls through malformed JWT-shaped tokens to DB / inactive', async () => {
    // three segments but invalid base64 payload
    const bad = 'aaa.!!!notb64!!!.ccc';
    expect(
      await (
        await request('/oauth/introspect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: bad }),
        })
      ).json()
    ).toEqual({ active: false });
  });

  it('reports active for access tokens present in DB', async () => {
    const db = createOAuthDb();
    const env = makeEnv({ db });
    const token = 'opaque-access';
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, {
      user_id: USER_ID,
      device_id: 'D9',
      created_at: NOW,
    });
    const body = await (
      await request(
        '/oauth/introspect',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token }),
        },
        env
      )
    ).json();
    expect(body).toEqual({
      active: true,
      sub: USER_ID,
      client_id: 'unknown',
      token_type: 'Bearer',
      iat: Math.floor(NOW / 1000),
    });
  });

  it('returns active:false for unknown opaque token', async () => {
    expect(
      await (
        await request('/oauth/introspect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: 'unknown-opaque' }),
        })
      ).json()
    ).toEqual({ active: false });
  });
});

describe('GET/POST /oauth/userinfo', () => {
  it('requires authentication', async () => {
    const getRes = await request('/oauth/userinfo');
    expect(getRes.status).toBe(401);
    const postRes = await request('/oauth/userinfo', { method: 'POST' });
    expect(postRes.status).toBe(401);
  });

  it('returns OIDC claims for authenticated user (GET and POST)', async () => {
    const db = createOAuthDb({
      users: new Map([
        [
          USER_ID,
          userRow({
            user_id: USER_ID,
            localpart: 'alice',
            display_name: 'Alice',
            avatar_url: 'mxc://example/av',
          }),
        ],
      ]),
    });
    const token = 'userinfo-token';
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, {
      user_id: USER_ID,
      device_id: 'D1',
      created_at: Date.now(),
    });
    const env = makeEnv({ db });

    const getRes = await request(
      '/oauth/userinfo',
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({
      sub: USER_ID,
      name: 'Alice',
      picture: 'mxc://example/av',
      'urn:matrix:user_id': USER_ID,
    });

    const postRes = await request(
      '/oauth/userinfo',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      },
      env
    );
    expect(postRes.status).toBe(200);
    expect(await postRes.json()).toMatchObject({ sub: USER_ID });
  });

  it('returns invalid_token when user row missing after auth', async () => {
    const db = createOAuthDb();
    const token = 'orphan-token';
    const hash = await hashToken(token);
    // Token validates but getUserById finds nothing
    db.tokensByHash.set(hash, {
      user_id: USER_ID,
      device_id: 'D1',
      created_at: Date.now(),
    });
    const env = makeEnv({ db });
    const res = await request(
      '/oauth/userinfo',
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'invalid_token' });
  });
});

describe('OAuth UIA /oauth/authorize/uia', () => {
  const NOW = 1_730_300_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('GET shows error pages for missing/expired session', async () => {
    const env = makeEnv();
    const missing = await request('/oauth/authorize/uia', {}, env);
    expect(await missing.text()).toContain('Missing Session');

    const expired = await request('/oauth/authorize/uia?session=gone', {}, env);
    expect(await expired.text()).toContain('Session Expired');
  });

  it('GET shows cross-signing reset approval page with escaped content', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    await cache.put(
      'uia_session:sess1',
      JSON.stringify({ user_id: USER_ID, completed_stages: [] }),
      { expirationTtl: 300 }
    );
    const res = await request(
      '/oauth/authorize/uia?session=sess1&action=org.matrix.cross_signing_reset',
      {},
      env
    );
    const html = await res.text();
    expect(html).toContain('Reset Encryption Keys');
    expect(html).toContain('reset your encryption identity');
    expect(html).toContain('alice'); // localpart prefill
    expect(html).toContain(SERVER);
  });

  it('GET shows generic approval title when action unspecified', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    await cache.put(
      'uia_session:sess2',
      JSON.stringify({ user_id: USER_ID }),
      { expirationTtl: 300 }
    );
    const html = await (
      await request('/oauth/authorize/uia?session=sess2', {}, env)
    ).text();
    expect(html).toContain('Approve Request');
  });

  it('POST cancel deletes session and shows cancelled page', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    await cache.put(
      'uia_session:sess3',
      JSON.stringify({ user_id: USER_ID }),
      { expirationTtl: 300 }
    );
    const form = new FormData();
    form.set('session', 'sess3');
    form.set('action', 'cancel');
    const res = await request('/oauth/authorize/uia', { method: 'POST', body: form }, env);
    const html = await res.text();
    expect(html).toMatch(/cancel/i);
    expect(cache.data['uia_session:sess3']).toBeUndefined();
  });

  it('POST requires credentials and rejects wrong password', async () => {
    const cache = mockKv();
    const db = createOAuthDb({
      users: new Map([
        [
          USER_ID,
          userRow({
            user_id: USER_ID,
            localpart: 'alice',
            password_hash: 'mockok:good',
          }),
        ],
      ]),
    });
    const env = makeEnv({ cache, db });
    await cache.put(
      'uia_session:sess4',
      JSON.stringify({ user_id: USER_ID, completed_stages: [] }),
      { expirationTtl: 300 }
    );

    const missingCreds = new FormData();
    missingCreds.set('session', 'sess4');
    expect(
      await (
        await request('/oauth/authorize/uia', { method: 'POST', body: missingCreds }, env)
      ).text()
    ).toContain('Username and password are required');

    const badPw = new FormData();
    badPw.set('session', 'sess4');
    badPw.set('username', 'alice');
    badPw.set('password', 'bad');
    expect(
      await (
        await request('/oauth/authorize/uia', { method: 'POST', body: badPw }, env)
      ).text()
    ).toContain('Invalid username or password');
  });

  it('POST rejects unknown user', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache, db: createOAuthDb() });
    await cache.put(
      'uia_session:sess5',
      JSON.stringify({ user_id: USER_ID }),
      { expirationTtl: 300 }
    );
    const form = new FormData();
    form.set('session', 'sess5');
    form.set('username', 'alice');
    form.set('password', 'x');
    expect(
      await (
        await request('/oauth/authorize/uia', { method: 'POST', body: form }, env)
      ).text()
    ).toContain('Invalid username or password');
  });

  it('POST allows OIDC-only user when idp link exists and user matches session', async () => {
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
      idpLinkCounts: new Map([[USER_ID, 1]]),
    });
    const env = makeEnv({ cache, db });
    await cache.put(
      'uia_session:sess6',
      JSON.stringify({ user_id: USER_ID, completed_stages: [] }),
      { expirationTtl: 300 }
    );
    const form = new FormData();
    form.set('session', 'sess6');
    form.set('username', 'alice');
    form.set('password', 'ignored');
    const html = await (
      await request('/oauth/authorize/uia', { method: 'POST', body: form }, env)
    ).text();
    expect(html).toMatch(/success|approved|complete/i);
    const updated = JSON.parse(cache.data['uia_session:sess6']);
    expect(updated.completed_stages).toEqual(
      expect.arrayContaining([
        'org.matrix.cross_signing_reset',
        'm.oauth',
        'm.login.oauth',
      ])
    );
    expect(updated.oauth_completed_at).toBe(NOW);
  });

  it('POST rejects OIDC-only user when username does not match session', async () => {
    const cache = mockKv();
    const other = `@bob:${SERVER}`;
    const db = createOAuthDb({
      users: new Map([
        [
          other,
          userRow({
            user_id: other,
            localpart: 'bob',
            password_hash: null,
          }),
        ],
      ]),
      idpLinkCounts: new Map([[other, 2]]),
    });
    const env = makeEnv({ cache, db });
    await cache.put(
      'uia_session:sess7',
      JSON.stringify({ user_id: USER_ID }),
      { expirationTtl: 300 }
    );
    const form = new FormData();
    form.set('session', 'sess7');
    form.set('username', 'bob');
    form.set('password', 'x');
    expect(
      await (
        await request('/oauth/authorize/uia', { method: 'POST', body: form }, env)
      ).text()
    ).toContain('same account that started this request');
  });

  it('POST rejects passwordless user with no IdP link', async () => {
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
      idpLinkCounts: new Map([[USER_ID, 0]]),
    });
    const env = makeEnv({ cache, db });
    await cache.put(
      'uia_session:sess8',
      JSON.stringify({ user_id: USER_ID }),
      { expirationTtl: 300 }
    );
    const form = new FormData();
    form.set('session', 'sess8');
    form.set('username', 'alice');
    form.set('password', 'x');
    expect(
      await (
        await request('/oauth/authorize/uia', { method: 'POST', body: form }, env)
      ).text()
    ).toContain('Invalid username or password');
  });

  it('POST password success marks stages and shows success page', async () => {
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
      ]),
    });
    const env = makeEnv({ cache, db });
    await cache.put(
      'uia_session:sess9',
      JSON.stringify({
        user_id: USER_ID,
        completed_stages: ['m.oauth'], // already has one; should not duplicate
      }),
      { expirationTtl: 300 }
    );
    const form = new FormData();
    form.set('session', 'sess9');
    form.set('username', 'alice');
    form.set('password', 'secret');
    const html = await (
      await request('/oauth/authorize/uia', { method: 'POST', body: form }, env)
    ).text();
    expect(html).toMatch(/success|approved|complete/i);
    const updated = JSON.parse(cache.data['uia_session:sess9']);
    expect(updated.completed_stages.filter((s: string) => s === 'm.oauth')).toHaveLength(1);
    expect(updated.completed_stages).toContain('org.matrix.cross_signing_reset');
    expect(updated.completed_stages).toContain('m.login.oauth');
  });

  it('POST rejects password user approving as different account', async () => {
    const cache = mockKv();
    const bob = `@bob:${SERVER}`;
    const db = createOAuthDb({
      users: new Map([
        [
          bob,
          userRow({
            user_id: bob,
            localpart: 'bob',
            password_hash: 'mockok:secret',
          }),
        ],
      ]),
    });
    const env = makeEnv({ cache, db });
    await cache.put(
      'uia_session:sess10',
      JSON.stringify({ user_id: USER_ID }),
      { expirationTtl: 300 }
    );
    const form = new FormData();
    form.set('session', 'sess10');
    form.set('username', 'bob');
    form.set('password', 'secret');
    expect(
      await (
        await request('/oauth/authorize/uia', { method: 'POST', body: form }, env)
      ).text()
    ).toContain('same account that started this request');
  });

  it('POST expired session returns Session Expired HTML', async () => {
    const env = makeEnv();
    const form = new FormData();
    form.set('session', 'missing');
    form.set('username', 'alice');
    form.set('password', 'x');
    expect(
      await (
        await request('/oauth/authorize/uia', { method: 'POST', body: form }, env)
      ).text()
    ).toContain('Session Expired');
  });

  it('POST missing session id returns Missing Session', async () => {
    const form = new FormData();
    form.set('username', 'alice');
    expect(
      await (
        await request('/oauth/authorize/uia', { method: 'POST', body: form }, makeEnv())
      ).text()
    ).toContain('Missing Session');
  });
});
