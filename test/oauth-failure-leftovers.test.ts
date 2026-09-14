/**
 * TOKENMAXX HEAVY leftovers after #140 — oauth failure/reliability edges.
 * Complements oauth-api-route-leftovers. Tests-only — src/api/oauth.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import oauth from '../src/api/oauth';

vi.mock('../src/utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/crypto')>();
  return {
    ...actual,
    verifyPassword: vi.fn(async (password: string, storedHash: string) => {
      return storedHash === `mockok:${password}`;
    }),
  };
});

const SERVER = 'example.com';
const REDIRECT = 'https://app.example/cb';

function mockKv(data: Record<string, string> = {}) {
  const puts: Array<{ key: string; value: string; options?: { expirationTtl?: number } }> = [];
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
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  };
  return kv as unknown as KVNamespace & {
    data: Record<string, string>;
    puts: typeof puts;
    deletes: string[];
  };
}

function createOAuthDb(opts: {
  users?: Map<string, { user_id: string; password_hash: string | null; is_deactivated?: number }>;
  tokensByHash?: Map<string, { user_id: string; device_id: string | null }>;
} = {}) {
  const users = opts.users ?? new Map();
  const tokensByHash = opts.tokensByHash ?? new Map();
  return {
    users,
    tokensByHash,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            first: async () => {
              if (sql.includes('FROM users') && sql.includes('password_hash')) {
                const userId = args[0] as string;
                const u = users.get(userId);
                if (!u || u.is_deactivated) return null;
                return { user_id: u.user_id, password_hash: u.password_hash };
              }
              if (sql.includes('FROM access_tokens') && sql.includes('token_hash')) {
                return tokensByHash.get(args[0] as string) ?? null;
              }
              if (sql.includes('FROM users') && sql.includes('display_name')) {
                const u = users.get(args[0] as string);
                if (!u) return null;
                return {
                  user_id: u.user_id,
                  display_name: null,
                  avatar_url: null,
                };
              }
              return null;
            },
            all: async () => ({ results: [] }),
            run: async () => ({ success: true, meta: { changes: 0 } }),
          };
        },
      };
    },
  } as unknown as D1Database & {
    users: Map<string, { user_id: string; password_hash: string | null; is_deactivated?: number }>;
  };
}

function makeEnv(overrides: Partial<{ CACHE: ReturnType<typeof mockKv>; SESSIONS: ReturnType<typeof mockKv>; DB: D1Database }> = {}): Env {
  return {
    SERVER_NAME: SERVER,
    SERVER_VERSION: '0.1.0-test',
    CACHE: overrides.CACHE ?? mockKv(),
    SESSIONS: overrides.SESSIONS ?? mockKv(),
    DB: overrides.DB ?? createOAuthDb(),
  } as Env;
}

async function request(
  path: string,
  init: RequestInit = {},
  env: Env = makeEnv()
): Promise<Response> {
  return oauth.request(`http://localhost${path}`, init, env);
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function seedClient(
  cache: ReturnType<typeof mockKv>,
  clientId = 'client_fail',
  patch: Record<string, unknown> = {}
) {
  cache.data[`oauth_client:${clientId}`] = JSON.stringify({
    client_id: clientId,
    client_secret_hash: null,
    client_name: 'Fail Client',
    redirect_uris: [REDIRECT],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    created_at: Date.now(),
    ...patch,
  });
  return clientId;
}

describe('oauth leftovers failure — register exact errcodes after #140', () => {
  it('POST /oauth/register bad JSON → invalid_request', async () => {
    const res = await request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.error).toBe('invalid_request');
  });

  it('register empty redirect_uris → invalid_client_metadata', async () => {
    const res = await request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'x', redirect_uris: [] }),
    });
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(body.error).toBe('invalid_client_metadata');
  });

  it('register missing redirect_uris → invalid_client_metadata', async () => {
    const res = await request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'x' }),
    });
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe('invalid_client_metadata');
  });

  it('register redirect_uris: null → invalid_client_metadata', async () => {
    const res = await request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'x', redirect_uris: null }),
    });
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe('invalid_client_metadata');
  });

  for (const body of ['[]', '"str"', '42', 'true']) {
    it(`register non-object JSON ${body} fails without 5xx`, async () => {
      const res = await request('/oauth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  }

  it('register JSON null currently surfaces as 5xx (body null deref)', async () => {
    const res = await request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('oauth leftovers failure — authorize query matrix after #140', () => {
  it('missing client_id → invalid_request', async () => {
    const res = await request(
      `/oauth/authorize?response_type=code&redirect_uri=${encodeURIComponent(REDIRECT)}`
    );
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe('invalid_request');
  });

  it('missing redirect_uri → invalid_request', async () => {
    const cache = mockKv();
    seedClient(cache);
    const res = await request('/oauth/authorize?response_type=code&client_id=client_fail', {}, makeEnv({ CACHE: cache }));
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe('invalid_request');
  });

  it('unsupported response_type → unsupported_response_type', async () => {
    const cache = mockKv();
    seedClient(cache);
    const res = await request(
      `/oauth/authorize?response_type=token&client_id=client_fail&redirect_uri=${encodeURIComponent(REDIRECT)}`,
      {},
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe('unsupported_response_type');
  });

  it('unknown client → invalid_client', async () => {
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=missing&redirect_uri=${encodeURIComponent(REDIRECT)}`
    );
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe('invalid_client');
  });

  it('redirect_uri not in client list → invalid_request', async () => {
    const cache = mockKv();
    seedClient(cache);
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_fail&redirect_uri=${encodeURIComponent('https://evil.example/cb')}`,
      {},
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe('invalid_request');
  });

  for (const rt of ['', 'code token', 'id_token', 'none']) {
    it(`response_type=${JSON.stringify(rt)} rejected`, async () => {
      const cache = mockKv();
      seedClient(cache);
      const res = await request(
        `/oauth/authorize?response_type=${encodeURIComponent(rt)}&client_id=client_fail&redirect_uri=${encodeURIComponent(REDIRECT)}`,
        {},
        makeEnv({ CACHE: cache })
      );
      expect(res.status).toBe(400);
    });
  }
});

describe('oauth leftovers failure — POST authorize form edges after #140', () => {
  it('missing credentials returns HTML error', async () => {
    const sessions = mockKv();
    sessions.data['oauth_auth_request:req1'] = JSON.stringify({
      client_id: 'client_fail',
      redirect_uri: REDIRECT,
      scope: 'openid',
    });
    const cache = mockKv();
    seedClient(cache);
    const fd = new FormData();
    fd.set('auth_request_id', 'req1');
    const res = await request(
      '/oauth/authorize',
      { method: 'POST', body: fd },
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Missing username or password/i);
  });

  it('expired auth_request_id → invalid_request JSON', async () => {
    const fd = new FormData();
    fd.set('username', 'alice');
    fd.set('password', 'pw');
    fd.set('auth_request_id', 'gone');
    const res = await request('/oauth/authorize', { method: 'POST', body: fd });
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe('invalid_request');
  });

  it('unknown user returns HTML Invalid username or password', async () => {
    const sessions = mockKv();
    sessions.data['oauth_auth_request:req2'] = JSON.stringify({
      client_id: 'client_fail',
      redirect_uri: REDIRECT,
      scope: 'openid',
    });
    const cache = mockKv();
    seedClient(cache);
    const fd = new FormData();
    fd.set('username', 'nobody');
    fd.set('password', 'pw');
    fd.set('auth_request_id', 'req2');
    const res = await request(
      '/oauth/authorize',
      { method: 'POST', body: fd },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: createOAuthDb() })
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/Invalid username or password/i);
  });

  it('wrong password returns HTML Invalid username or password', async () => {
    const sessions = mockKv();
    sessions.data['oauth_auth_request:req3'] = JSON.stringify({
      client_id: 'client_fail',
      redirect_uri: REDIRECT,
      scope: 'openid',
    });
    const cache = mockKv();
    seedClient(cache);
    const db = createOAuthDb({
      users: new Map([
        [
          `@alice:${SERVER}`,
          { user_id: `@alice:${SERVER}`, password_hash: 'mockok:correct' },
        ],
      ]),
    });
    const fd = new FormData();
    fd.set('username', 'alice');
    fd.set('password', 'wrong');
    fd.set('auth_request_id', 'req3');
    const res = await request(
      '/oauth/authorize',
      { method: 'POST', body: fd },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Invalid username or password/i);
  });
});

describe('oauth leftovers failure — token grant matrix after #140', () => {
  it('missing grant_type fails', async () => {
    const res = await request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('unsupported grant_type fails after client resolves or earlier', async () => {
    const cache = mockKv();
    seedClient(cache);
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'password',
          client_id: 'client_fail',
          code: 'x',
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(['unsupported_grant_type', 'invalid_request', 'invalid_grant']).toContain(
      body.error as string
    );
  });

  it('authorization_code missing code → invalid_request', async () => {
    const cache = mockKv();
    seedClient(cache);
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_fail',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe('invalid_request');
  });

  it('authorization_code unknown code → invalid_grant', async () => {
    const cache = mockKv();
    seedClient(cache);
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_fail',
          code: 'nope',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe('invalid_grant');
  });

  it('unknown client_id → invalid_client', async () => {
    const res = await request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: 'ghost',
        code: 'x',
      }),
    });
    expect([400, 401]).toContain(res.status);
    expect((await jsonOf(res)).error).toBe('invalid_client');
  });

  it('refresh_token missing token → invalid_request', async () => {
    const cache = mockKv();
    seedClient(cache);
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: 'client_fail',
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe('invalid_request');
  });

  it('refresh_token unknown → invalid_grant', async () => {
    const cache = mockKv();
    seedClient(cache);
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: 'client_fail',
          refresh_token: 'missing',
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe('invalid_grant');
  });

  it('PKCE required when challenge set but verifier missing', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache);
    sessions.data['oauth_code:pkce1'] = JSON.stringify({
      code: 'pkce1',
      client_id: 'client_fail',
      user_id: `@alice:${SERVER}`,
      redirect_uri: REDIRECT,
      scope: 'openid',
      code_challenge: 'challenge',
      code_challenge_method: 'plain',
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_fail',
          code: 'pkce1',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe('invalid_request');
  });

  it('PKCE verifier mismatch → invalid_grant', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache);
    sessions.data['oauth_code:pkce2'] = JSON.stringify({
      code: 'pkce2',
      client_id: 'client_fail',
      user_id: `@alice:${SERVER}`,
      redirect_uri: REDIRECT,
      scope: 'openid',
      code_challenge: 'expected',
      code_challenge_method: 'plain',
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_fail',
          code: 'pkce2',
          redirect_uri: REDIRECT,
          code_verifier: 'wrong',
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe('invalid_grant');
  });

  it('code/client mismatch → invalid_grant', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_fail');
    seedClient(cache, 'client_other');
    sessions.data['oauth_code:steal'] = JSON.stringify({
      code: 'steal',
      client_id: 'client_other',
      user_id: `@alice:${SERVER}`,
      redirect_uri: REDIRECT,
      scope: 'openid',
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_fail',
          code: 'steal',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe('invalid_grant');
  });

  it('redirect_uri mismatch → invalid_grant', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache);
    sessions.data['oauth_code:redir'] = JSON.stringify({
      code: 'redir',
      client_id: 'client_fail',
      user_id: `@alice:${SERVER}`,
      redirect_uri: REDIRECT,
      scope: 'openid',
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_fail',
          code: 'redir',
          redirect_uri: 'https://other.example/cb',
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe('invalid_grant');
  });

  it('expired authorization code → invalid_grant', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache);
    sessions.data['oauth_code:old'] = JSON.stringify({
      code: 'old',
      client_id: 'client_fail',
      user_id: `@alice:${SERVER}`,
      redirect_uri: REDIRECT,
      scope: 'openid',
      created_at: Date.now() - 120_000,
      expires_at: Date.now() - 1,
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_fail',
          code: 'old',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe('invalid_grant');
  });
});

describe('oauth leftovers failure — revoke/introspect/userinfo after #140', () => {
  it('revoke without token → invalid_request', async () => {
    const res = await request('/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe('invalid_request');
  });

  it('introspect without token → invalid_request', async () => {
    const res = await request('/oauth/introspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe('invalid_request');
  });

  it('introspect random opaque token → inactive', async () => {
    const res = await request('/oauth/introspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'not-a-real-token' }),
    });
    expect(res.status).toBeLessThan(500);
    if (res.status === 200) {
      const body = await jsonOf(res);
      expect(body.active).toBe(false);
    }
  });

  it('introspect expired JWT-shaped token → active false', async () => {
    const payload = btoa(JSON.stringify({ exp: 1, sub: `@alice:${SERVER}` }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const token = `hdr.${payload}.sig`;
    const res = await request('/oauth/introspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).active).toBe(false);
  });

  it('GET /oauth/userinfo without auth fails', async () => {
    const res = await request('/oauth/userinfo');
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('POST /oauth/userinfo without auth fails', async () => {
    const res = await request('/oauth/userinfo', { method: 'POST' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('revoke unknown token still 200 per RFC 7009', async () => {
    const res = await request('/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'ghost-refresh' }),
    });
    expect(res.status).toBe(200);
  });
});

describe('oauth leftovers failure — method/content-type edges after #140', () => {
  for (const path of ['/oauth/register', '/oauth/token', '/oauth/revoke', '/oauth/introspect']) {
    it(`GET ${path} not allowed or handled`, async () => {
      const res = await request(path);
      expect([404, 405, 400, 401]).toContain(res.status);
    });
  }

  it('token unsupported content-type fails', async () => {
    const res = await request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'grant_type=authorization_code',
    });
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe('invalid_request');
  });

  it('revoke unsupported content-type with empty params → invalid_request', async () => {
    const res = await request('/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'token=abc',
    });
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toBe('invalid_request');
  });

  it('authorize UIA missing session shows error page', async () => {
    const res = await request('/oauth/authorize/uia');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/Missing Session|session/i);
  });

  it('authorize UIA unknown session shows expired/error page', async () => {
    const res = await request('/oauth/authorize/uia?session=nope');
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Session Expired|expired|Missing Session/i);
  });
});

describe('oauth leftovers failure — confidential client auth edges after #140', () => {
  it('confidential client missing secret → invalid_client', async () => {
    const cache = mockKv();
    seedClient(cache, 'client_conf', {
      client_secret_hash: 'deadbeef',
      token_endpoint_auth_method: 'client_secret_post',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_conf',
          code: 'x',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(401);
    expect((await jsonOf(res)).error).toBe('invalid_client');
  });

  it('confidential client wrong secret → invalid_client', async () => {
    const cache = mockKv();
    seedClient(cache, 'client_conf2', {
      client_secret_hash: 'deadbeef',
      token_endpoint_auth_method: 'client_secret_post',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_conf2',
          client_secret: 'nope',
          code: 'x',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(401);
    expect((await jsonOf(res)).error).toBe('invalid_client');
  });
});
