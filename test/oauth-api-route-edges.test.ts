/**
 * TOKENMAXX HEAVY deepen after #102/#103 — oauth route edges beyond merged #90.
 * Orthogonal to #100 devices/aliases, #93/#96 key-backups, #94 search, #101 login.
 * Tests-only companion to oauth-helpers.test.ts (export-only src for helpers).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { hashToken } from '../src/utils/crypto';
import {
  base64UrlEncode,
  hashClientSecret,
  verifyCodeChallenge,
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

function b64urlJson(obj: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

function fakeJwt(payload: Record<string, unknown>): string {
  return `${b64urlJson({ alg: 'none', typ: 'JWT' })}.${b64urlJson(payload)}.sig`;
}

async function s256Challenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(hash));
}

// ---------------------------------------------------------------------------
// Register edges
// ---------------------------------------------------------------------------

describe('oauth register edges after #90', () => {
  it('persists custom grant_types, response_types, and client_name', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const { status, body } = await registerClient(env, {
      client_name: 'Custom Native',
      redirect_uris: [REDIRECT, 'https://app.example/cb'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      application_type: 'native',
      contacts: ['admin@example.com'],
      logo_uri: 'https://example.com/logo.png',
      client_uri: 'https://example.com',
      policy_uri: 'https://example.com/policy',
      tos_uri: 'https://example.com/tos',
    });
    expect(status).toBe(201);
    expect(body.client_name).toBe('Custom Native');
    expect(body.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(body.response_types).toEqual(['code']);
    expect(body.token_endpoint_auth_method).toBe('client_secret_post');
    expect(body.client_secret).toBeTruthy();
    const stored = JSON.parse(cache.data[`oauth_client:${body.client_id}`]);
    expect(stored.client_name).toBe('Custom Native');
    expect(stored.redirect_uris).toEqual([REDIRECT, 'https://app.example/cb']);
    expect(stored.client_secret_hash).toBe(await hashClientSecret(String(body.client_secret)));
  });

  it('rejects empty redirect_uris array distinctly from missing field', async () => {
    const res = await request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'X', redirect_uris: [] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'invalid_client_metadata',
      error_description: 'redirect_uris is required',
    });
  });

  it('issues client_id with client_ prefix and 32 hex chars (16 random bytes)', async () => {
    const { body } = await registerClient(makeEnv());
    expect(String(body.client_id)).toMatch(/^client_[0-9a-f]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// Authorize GET / POST edges
// ---------------------------------------------------------------------------

describe('oauth authorize GET edges after #90', () => {
  it('stores nonce, state, and S256 challenge on the auth request', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions });
    const { body: client } = await registerClient(env);
    const qs = new URLSearchParams({
      client_id: String(client.client_id),
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'openid profile',
      state: 'st-1',
      nonce: 'n-9',
      code_challenge: 'chal-value',
      code_challenge_method: 'S256',
    });
    const res = await request(`/oauth/authorize?${qs}`, {}, env);
    expect(res.status).toBe(200);
    const keys = Object.keys(sessions.data).filter((k) => k.startsWith('oauth_auth_request:'));
    expect(keys).toHaveLength(1);
    const stored = JSON.parse(sessions.data[keys[0]]);
    expect(stored).toMatchObject({
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      scope: 'openid profile',
      state: 'st-1',
      nonce: 'n-9',
      code_challenge: 'chal-value',
      code_challenge_method: 'S256',
    });
    expect(sessions.puts[0].options?.expirationTtl).toBe(600);
  });

  it('escapes client_name from registration into login HTML', async () => {
    const env = makeEnv();
    const { body: client } = await registerClient(env, {
      client_name: `<b>Evil</b>`,
      redirect_uris: [REDIRECT],
    });
    const qs = new URLSearchParams({
      client_id: String(client.client_id),
      redirect_uri: REDIRECT,
      response_type: 'code',
    });
    const html = await (await request(`/oauth/authorize?${qs}`, {}, env)).text();
    expect(html).toContain('&lt;b&gt;Evil&lt;/b&gt;');
    expect(html).not.toContain('<b>Evil</b>');
  });
});

describe('oauth authorize POST edges after #90', () => {
  const NOW = 1_731_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function seededAuth(env: Env, authRequest: Record<string, unknown>, id = 'req-edge') {
    await env.SESSIONS.put(`oauth_auth_request:${id}`, JSON.stringify(authRequest), {
      expirationTtl: 600,
    });
    return id;
  }

  it('treats null password_hash user as invalid credentials (OIDC-only gate on authorize)', async () => {
    const sessions = mockKv();
    const db = createOAuthDb({
      users: new Map([
        [USER_ID, userRow({ user_id: USER_ID, localpart: 'alice', password_hash: null })],
      ]),
    });
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env, {
      client_name: 'OIDC App',
      redirect_uris: [REDIRECT],
    });
    const id = await seededAuth(env, {
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      scope: 'openid',
    });
    const form = new FormData();
    form.set('username', 'alice');
    form.set('password', 'anything');
    form.set('auth_request_id', id);
    const res = await request('/oauth/authorize', { method: 'POST', body: form }, env);
    const html = await res.text();
    expect(html).toContain('Invalid username or password');
    expect(html).toContain('OIDC App');
  });

  it('ignores deactivated users (is_deactivated filter) as unknown', async () => {
    const sessions = mockKv();
    const db = createOAuthDb({
      users: new Map([
        [
          USER_ID,
          userRow({
            user_id: USER_ID,
            localpart: 'alice',
            password_hash: 'mockok:pw',
            is_deactivated: 1,
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
    form.set('password', 'pw');
    form.set('auth_request_id', id);
    const html = await (
      await request('/oauth/authorize', { method: 'POST', body: form }, env)
    ).text();
    expect(html).toContain('Invalid username or password');
  });

  it('uses Unknown Client when client record missing during retry HTML', async () => {
    const sessions = mockKv();
    const cache = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, cache, db });
    const id = await seededAuth(env, {
      client_id: 'missing-client',
      redirect_uri: REDIRECT,
      scope: 'openid',
    });
    const form = new FormData();
    form.set('username', 'alice');
    form.set('password', 'pw');
    form.set('auth_request_id', id);
    const html = await (
      await request('/oauth/authorize', { method: 'POST', body: form }, env)
    ).text();
    expect(html).toContain('Unknown Client');
  });

  it('sets code expiry to NOW + 10 minutes on successful login', async () => {
    const sessions = mockKv();
    const db = createOAuthDb({
      users: new Map([
        [USER_ID, userRow({ user_id: USER_ID, localpart: 'alice', password_hash: 'mockok:ok' })],
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
    form.set('password', 'ok');
    form.set('auth_request_id', id);
    const res = await request('/oauth/authorize', { method: 'POST', body: form }, env);
    const code = new URL(res.headers.get('Location')!).searchParams.get('code')!;
    const authCode = JSON.parse(sessions.data[`oauth_code:${code}`]);
    expect(authCode.expires_at).toBe(NOW + 10 * 60 * 1000);
    expect(authCode.created_at).toBe(NOW);
  });
});

// ---------------------------------------------------------------------------
// Token endpoint edges
// ---------------------------------------------------------------------------

describe('oauth token edges after #90', () => {
  const NOW = 1_731_100_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('accepts application/x-www-form-urlencoded token exchange', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
    });
    await putAuthCode(env, 'form-code', { client_id: String(client.client_id) });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: String(client.client_id),
          client_secret: String(client.client_secret),
          code: 'form-code',
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
  });

  it('rejects unsupported content types before parsing body', async () => {
    const res = await request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'grant_type=authorization_code',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error_description: 'Unsupported content type',
    });
  });

  it('requires client_secret for confidential clients and rejects wrong secret', async () => {
    const env = makeEnv();
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_basic',
    });

    const missing = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code: 'x',
        }),
      },
      env
    );
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({
      error_description: 'client_secret is required',
    });

    const wrong = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          client_secret: 'not-the-secret',
          code: 'x',
        }),
      },
      env
    );
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({
      error_description: 'Invalid client credentials',
    });
  });

  it('decodes URL-encoded Basic auth client_id:client_secret', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_basic',
    });
    await putAuthCode(env, 'basic-code', { client_id: String(client.client_id) });

    const id = encodeURIComponent(String(client.client_id));
    const secret = encodeURIComponent(String(client.client_secret));
    const basic = btoa(`${id}:${secret}`);

    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${basic}`,
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: 'basic-code',
        }),
      },
      env
    );
    expect(res.status).toBe(200);
    expect((await res.json()).access_token).toBeTruthy();
  });

  it('prefers body client_id over Basic header when both present', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const a = await registerClient(env, {
      client_name: 'A',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
    });
    const b = await registerClient(env, {
      client_name: 'B',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
    });
    await putAuthCode(env, 'pref-code', { client_id: String(a.body.client_id) });

    const basic = btoa(`${b.body.client_id}:${b.body.client_secret}`);
    // Body says A (correct owner of code); header says B — body wins for client_id,
    // but secret comes from body too when provided.
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${basic}`,
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: a.body.client_id,
          client_secret: a.body.client_secret,
          code: 'pref-code',
        }),
      },
      env
    );
    expect(res.status).toBe(200);
  });

  it('skips PKCE when auth code has no code_challenge', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'no-pkce', { client_id: String(client.client_id) });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code: 'no-pkce',
          // no code_verifier — should still succeed
        }),
      },
      env
    );
    expect(res.status).toBe(200);
  });

  it('rejects unknown PKCE method via verifyCodeChallenge false', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'bad-method', {
      client_id: String(client.client_id),
      code_challenge: 'anything',
      code_challenge_method: 'S512',
    });
    expect(await verifyCodeChallenge('anything', 'anything', 'S512')).toBe(false);
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code: 'bad-method',
          code_verifier: 'anything',
        }),
      },
      env
    );
    expect(await res.json()).toMatchObject({
      error_description: 'Invalid code_verifier',
    });
  });

  it('defaults missing code_challenge_method to plain during verification', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    // Put code with challenge but omit method field entirely
    await env.SESSIONS.put(
      'oauth_code:plain-default',
      JSON.stringify({
        code: 'plain-default',
        client_id: client.client_id,
        user_id: USER_ID,
        redirect_uri: REDIRECT,
        scope: 'openid',
        code_challenge: 'verifier-xyz',
        created_at: NOW,
        expires_at: NOW + 600_000,
      }),
      { expirationTtl: 600 }
    );
    const bad = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code: 'plain-default',
          code_verifier: 'wrong',
        }),
      },
      env
    );
    expect(await bad.json()).toMatchObject({ error_description: 'Invalid code_verifier' });

    await env.SESSIONS.put(
      'oauth_code:plain-default2',
      JSON.stringify({
        code: 'plain-default2',
        client_id: client.client_id,
        user_id: USER_ID,
        redirect_uri: REDIRECT,
        scope: 'openid',
        code_challenge: 'verifier-xyz',
        created_at: NOW,
        expires_at: NOW + 600_000,
      }),
      { expirationTtl: 600 }
    );
    const ok = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code: 'plain-default2',
          code_verifier: 'verifier-xyz',
        }),
      },
      env
    );
    expect(ok.status).toBe(200);
  });

  it('allows matching redirect_uri and omits check when redirect_uri absent', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'redir-ok', { client_id: String(client.client_id) });
    const withMatch = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code: 'redir-ok',
          redirect_uri: REDIRECT,
        }),
      },
      env
    );
    expect(withMatch.status).toBe(200);

    await putAuthCode(env, 'redir-omit', { client_id: String(client.client_id) });
    const omit = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code: 'redir-omit',
        }),
      },
      env
    );
    expect(omit.status).toBe(200);
  });

  it('generates device id when MSC2967 device scope absent', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'no-device-scope', {
      client_id: String(client.client_id),
      scope: 'openid urn:matrix:org.matrix.msc2967.client:api:*',
    });
    const body = await (
      await request(
        '/oauth/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            client_id: client.client_id,
            code: 'no-device-scope',
          }),
        },
        env
      )
    ).json();
    expect(body.device_id).toBeTruthy();
    expect(String(body.device_id).length).toBeGreaterThan(0);
    expect(db.inserts.some((i) => i.sql.includes('INTO devices'))).toBe(true);
    const deviceInsert = db.inserts.find((i) => i.sql.includes('INTO devices'))!;
    expect(deviceInsert.args[2]).toContain('OAuth Client');
  });

  it('extracts first MSC2967 device scope when multiple scopes present', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'multi-device', {
      client_id: String(client.client_id),
      scope:
        'openid urn:matrix:org.matrix.msc2967.client:device:FIRSTDEV urn:matrix:org.matrix.msc2967.client:device:SECOND',
    });
    const body = await (
      await request(
        '/oauth/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            client_id: client.client_id,
            code: 'multi-device',
          }),
        },
        env
      )
    ).json();
    expect(body.device_id).toBe('FIRSTDEV');
  });

  it('stores refresh token with 30-day TTL and hashes refresh secret', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'ttl-code', {
      client_id: String(client.client_id),
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEVTTL',
    });
    const body = await (
      await request(
        '/oauth/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            client_id: client.client_id,
            code: 'ttl-code',
          }),
        },
        env
      )
    ).json();
    const refreshKey = `oauth_refresh:${body.refresh_token}`;
    const put = sessions.puts.find((p) => p.key === refreshKey);
    expect(put?.options?.expirationTtl).toBe(30 * 24 * 60 * 60);
    const stored = JSON.parse(sessions.data[refreshKey]);
    expect(stored.device_id).toBe('DEVTTL');
    expect(stored.user_id).toBe(USER_ID);
    expect(stored.client_id).toBe(client.client_id);
    expect(stored.refresh_token_hash).toBe(await hashClientSecret(String(body.refresh_token)));
    expect(stored.expires_at).toBe(NOW + 24 * 60 * 60 * 1000);
  });

  it('consumes authorization code (one-time use) on success', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'once', { client_id: String(client.client_id) });
    const first = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code: 'once',
        }),
      },
      env
    );
    expect(first.status).toBe(200);
    expect(sessions.data['oauth_code:once']).toBeUndefined();

    const second = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code: 'once',
        }),
      },
      env
    );
    expect(await second.json()).toMatchObject({
      error_description: 'Invalid or expired authorization code',
    });
  });

  it('S256 PKCE end-to-end via exported helpers matching route verification', async () => {
    const verifier = 'edge-s256-verifier-abcdefghijklmnopqrstuv';
    const challenge = await s256Challenge(verifier);
    expect(await verifyCodeChallenge(verifier, challenge, 'S256')).toBe(true);

    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 's256-edge', {
      client_id: String(client.client_id),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:S256DEV',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code: 's256-edge',
          code_verifier: verifier,
        }),
      },
      env
    );
    expect(res.status).toBe(200);
    expect((await res.json()).device_id).toBe('S256DEV');
  });
});

// ---------------------------------------------------------------------------
// Revoke / introspect edges
// ---------------------------------------------------------------------------

describe('oauth revoke edges after #90', () => {
  it('without token_type_hint tries refresh then access_token paths', async () => {
    const sessions = mockKv({ 'oauth_refresh:rt-hintless': '{"x":1}' });
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'rt-hintless' }),
      },
      env
    );
    expect(res.status).toBe(200);
    expect(sessions.data['oauth_refresh:rt-hintless']).toBeUndefined();
  });

  it('access_token hint skips refresh deletion and still returns 200', async () => {
    const sessions = mockKv({ 'oauth_refresh:keep-me': '{"x":1}' });
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const token = 'at-1';
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, { user_id: USER_ID, device_id: 'D', created_at: 1 });
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
    expect(sessions.data['oauth_refresh:keep-me']).toBe('{"x":1}');
    expect(db.tokensByHash.has(hash)).toBe(false);
  });

  it('returns 400 when content-type is neither form nor json (token never parsed)', async () => {
    const res = await request('/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'token=abc',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error_description: 'token is required',
    });
  });
});

describe('oauth introspect edges after #90', () => {
  const NOW = 1_731_200_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats JWT without exp as active (exp check is truthy-gated)', async () => {
    const jwt = fakeJwt({
      sub: USER_ID,
      client_id: 'c-no-exp',
      scope: 'openid',
      iat: Math.floor(NOW / 1000),
    });
    const body = await (
      await request('/oauth/introspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: jwt }),
      })
    ).json();
    expect(body.active).toBe(true);
    expect(body.client_id).toBe('c-no-exp');
    expect(body.exp).toBeUndefined();
  });

  it('falls through non-JWT (≠3 segments) to opaque DB lookup', async () => {
    const db = createOAuthDb();
    const env = makeEnv({ db });
    const token = 'not.a.jwt.because.five.parts.extra';
    // 5 segments → not treated as JWT
    expect(token.split('.').length).not.toBe(3);
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, {
      user_id: BOB_ID,
      device_id: 'BX',
      created_at: NOW,
    });
    const body = await (
      await request(
        '/oauth/introspect',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        },
        env
      )
    ).json();
    expect(body).toEqual({
      active: true,
      sub: BOB_ID,
      client_id: 'unknown',
      token_type: 'Bearer',
      iat: Math.floor(NOW / 1000),
    });
  });

  it('two-segment tokens are not JWTs and miss DB → inactive', async () => {
    expect(
      await (
        await request('/oauth/introspect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: 'only.two' }),
        })
      ).json()
    ).toEqual({ active: false });
  });

  it('prefers client_id over azp when both present', async () => {
    const jwt = fakeJwt({
      sub: USER_ID,
      client_id: 'primary',
      azp: 'secondary',
      exp: Math.floor(NOW / 1000) + 100,
    });
    const body = await (
      await request('/oauth/introspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: jwt }),
      })
    ).json();
    expect(body.client_id).toBe('primary');
  });

  it('exp exactly equal to now is still active (strict < check)', async () => {
    const exp = Math.floor(NOW / 1000);
    const jwt = fakeJwt({ sub: USER_ID, exp });
    const body = await (
      await request('/oauth/introspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: jwt }),
      })
    ).json();
    expect(body.active).toBe(true);
    expect(body.exp).toBe(exp);
  });
});

// ---------------------------------------------------------------------------
// Userinfo + UIA stage edges
// ---------------------------------------------------------------------------

describe('oauth userinfo edges after #90', () => {
  it('returns null name/picture when profile fields are null in DB', async () => {
    const db = createOAuthDb({
      users: new Map([
        [
          USER_ID,
          {
            user_id: USER_ID,
            localpart: 'alice',
            display_name: null,
            avatar_url: null,
            password_hash: 'mockok:x',
            is_guest: 0,
            is_deactivated: 0,
            admin: 0,
            created_at: 1_700_000_000_000,
          },
        ],
      ]),
    });
    const token = 'userinfo-token';
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, {
      user_id: USER_ID,
      device_id: 'U1',
      created_at: Date.now(),
    });
    const env = makeEnv({ db });
    const res = await request(
      '/oauth/userinfo',
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // getUserById maps null display_name/avatar_url → undefined; JSON omits them
    expect(body).toEqual({
      sub: USER_ID,
      'urn:matrix:user_id': USER_ID,
    });
    expect(body).not.toHaveProperty('name');
    expect(body).not.toHaveProperty('picture');
  });

  it('returns display_name and avatar_url when present (POST userinfo)', async () => {
    const db = createOAuthDb({
      users: new Map([
        [
          USER_ID,
          userRow({
            user_id: USER_ID,
            localpart: 'alice',
            display_name: 'Alice Example',
            avatar_url: 'mxc://example.com/av',
            password_hash: 'mockok:x',
          }),
        ],
      ]),
    });
    const token = 'userinfo-token-2';
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, {
      user_id: USER_ID,
      device_id: 'U2',
      created_at: Date.now(),
    });
    const env = makeEnv({ db });
    const res = await request(
      '/oauth/userinfo',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sub: USER_ID,
      name: 'Alice Example',
      picture: 'mxc://example.com/av',
      'urn:matrix:user_id': USER_ID,
    });
  });
});

describe('oauth UIA completed_stages edges after #90', () => {
  it('idempotently marks org.matrix.cross_signing_reset / m.oauth / m.login.oauth', async () => {
    const cache = mockKv();
    const db = createOAuthDb({
      users: new Map([
        [USER_ID, userRow({ user_id: USER_ID, localpart: 'alice', password_hash: 'mockok:pw' })],
      ]),
    });
    const env = makeEnv({ cache, db });
    const sessionId = 'uia-stages-1';
    await cache.put(
      `uia_session:${sessionId}`,
      JSON.stringify({
        user_id: USER_ID,
        completed_stages: ['m.oauth'], // already has one
      }),
      { expirationTtl: 300 }
    );

    const form = new FormData();
    form.set('session', sessionId);
    form.set('username', 'alice');
    form.set('password', 'pw');
    form.set('action', 'approve');
    const res = await request('/oauth/authorize/uia', { method: 'POST', body: form }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Request Approved');

    const updated = JSON.parse(cache.data[`uia_session:${sessionId}`]);
    expect(updated.completed_stages).toEqual([
      'm.oauth',
      'org.matrix.cross_signing_reset',
      'm.login.oauth',
    ]);
    expect(updated.oauth_completed_at).toBeTruthy();
  });

  it('GET uia with cross_signing_reset action uses reset copy', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    await cache.put(
      'uia_session:uia-get-1',
      JSON.stringify({ user_id: USER_ID }),
      { expirationTtl: 300 }
    );
    const res = await request(
      '/oauth/authorize/uia?session=uia-get-1&action=org.matrix.cross_signing_reset',
      {},
      env
    );
    const html = await res.text();
    expect(html).toContain('Reset Encryption Keys');
    expect(html).toContain('reset your encryption identity');
  });

  it('GET uia without action uses generic Approve Request copy', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    await cache.put(
      'uia_session:uia-get-2',
      JSON.stringify({ user_id: USER_ID }),
      { expirationTtl: 300 }
    );
    const html = await (
      await request('/oauth/authorize/uia?session=uia-get-2', {}, env)
    ).text();
    expect(html).toContain('Approve Request');
    expect(html).toContain('An application is requesting your approval.');
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: helpers ↔ routes consistency
// ---------------------------------------------------------------------------

describe('oauth helpers/routes consistency', () => {
  it('registered client_secret hashes with exported hashClientSecret', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const { body } = await registerClient(env);
    const stored = JSON.parse(cache.data[`oauth_client:${body.client_id}`]);
    expect(stored.client_secret_hash).toBe(await hashClientSecret(String(body.client_secret)));
  });

  it('login page from authorize GET matches generateLoginPage structure markers', async () => {
    const env = makeEnv();
    const { body: client } = await registerClient(env, {
      client_name: 'Marker Client',
      redirect_uris: [REDIRECT],
    });
    const qs = new URLSearchParams({
      client_id: String(client.client_id),
      redirect_uri: REDIRECT,
      response_type: 'code',
    });
    const html = await (await request(`/oauth/authorize?${qs}`, {}, env)).text();
    expect(html).toContain('Sign in');
    expect(html).toContain('Marker Client');
    expect(html).toContain('action="/oauth/authorize"');
    expect(html).toContain(`Signing in to`);
  });
});
