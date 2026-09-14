/**
 * TOKENMAXX HEAVY leftovers after #139 — oauth failure/reliability edges.
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

function mockKv(data: Record<string, string> = {}) {
  const puts: Array<{ key: string; value: string; options?: { expirationTtl?: number } }> = [];
  const kv = {
    data,
    puts,
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
      delete data[key];
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  };
  return kv as unknown as KVNamespace & { data: Record<string, string>; puts: typeof puts };
}

function createOAuthDb() {
  return {
    prepare(_sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            first: async () => null,
            all: async () => ({ results: [] }),
            run: async () => ({ success: true, meta: { changes: 0 } }),
          };
        },
      };
    },
  } as unknown as D1Database;
}

function makeEnv(): Env {
  return {
    SERVER_NAME: SERVER,
    SERVER_VERSION: '0.1.0-test',
    CACHE: mockKv(),
    SESSIONS: mockKv(),
    DB: createOAuthDb(),
  } as Env;
}

async function request(
  path: string,
  init: RequestInit = {},
  env: Env = makeEnv()
): Promise<Response> {
  return oauth.request(`http://localhost${path}`, init, env);
}

describe('oauth leftovers failure — register/authorize/token after #139', () => {
  it('POST /oauth/register bad JSON → 400+', async () => {
    const env = makeEnv();
    const res = await request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    }, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('GET /oauth/authorize missing client_id fails', async () => {
    const env = makeEnv();
    const res = await request(
      '/oauth/authorize?response_type=code&redirect_uri=https://app.example/cb',
      {},
      env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('POST /oauth/token missing grant_type fails', async () => {
    const env = makeEnv();
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('POST /oauth/revoke without token fails', async () => {
    const env = makeEnv();
    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('POST /oauth/introspect without token fails', async () => {
    const env = makeEnv();
    const res = await request(
      '/oauth/introspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('GET /oauth/userinfo without auth fails', async () => {
    const env = makeEnv();
    const res = await request('/oauth/userinfo', {}, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('oauth leftovers failure — method edges after #139', () => {
  for (const path of ['/oauth/register', '/oauth/token', '/oauth/revoke', '/oauth/introspect']) {
    it(`GET ${path} not allowed or handled`, async () => {
      const env = makeEnv();
      const res = await request(path, {}, env);
      expect([404, 405, 400, 401]).toContain(res.status);
    });
  }
});

describe('oauth leftovers failure — register validation edges after #139', () => {
  it('register with empty redirect_uris fails', async () => {
    const env = makeEnv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: 'x', redirect_uris: [] }),
      },
      env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('register with missing redirect_uris fails', async () => {
    const env = makeEnv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: 'x' }),
      },
      env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('authorize unknown client fails', async () => {
    const env = makeEnv();
    const res = await request(
      '/oauth/authorize?response_type=code&client_id=missing&redirect_uri=https://app.example/cb',
      {},
      env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('token with garbage grant_type fails', async () => {
    const env = makeEnv();
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'password', code: 'x' }),
      },
      env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('introspect random token returns inactive or error', async () => {
    const env = makeEnv();
    const res = await request(
      '/oauth/introspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'not-a-real-token' }),
      },
      env
    );
    expect(res.status).toBeLessThan(500);
    if (res.status === 200) {
      const body = await res.json();
      expect(body.active === false || body.errcode).toBeTruthy();
    }
  });
});
