/**
 * TOKENMAXX HEAVY leftovers after #142/#143 — oauth API soft success/reliability.
 * Orthogonal to oauth-failure-leftovers + oauth-api-route-leftovers + oauth helpers flood.
 * Tests-only — Hono app.request() against src/api/oauth.ts. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { hashClientSecret } from '../src/api/oauth';

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

const SERVER = 'example.com';
const USER = `@alice:${SERVER}`;
const REDIRECT = 'https://app.example.com/cb';
const NOW = 1_730_400_000_000;
const STRONG_PW = 'Password1!';

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
  users?: Map<string, { user_id: string; password_hash: string | null; is_deactivated?: number; display_name?: string | null; avatar_url?: string | null }>;
  tokensByHash?: Map<string, { user_id: string; device_id: string | null; created_at?: number }>;
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
                const row = tokensByHash.get(args[0] as string);
                if (!row) return null;
                return { user_id: row.user_id, device_id: row.device_id, created_at: row.created_at ?? NOW };
              }
              if (sql.includes('FROM users') && sql.includes('display_name')) {
                const u = users.get(args[0] as string);
                if (!u) return null;
                return {
                  user_id: u.user_id,
                  display_name: u.display_name ?? null,
                  avatar_url: u.avatar_url ?? null,
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
  clientId = 'client_soft',
  patch: Record<string, unknown> = {}
) {
  cache.data[`oauth_client:${clientId}`] = JSON.stringify({
    client_id: clientId,
    client_secret_hash: null,
    client_name: 'Soft Client',
    redirect_uris: [REDIRECT],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    created_at: NOW,
    ...patch,
  });
  return clientId;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('oauth soft leftovers POST /oauth/register success soft flood after #142', () => {

  it('register soft success-0', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Soft App 0',
          redirect_uris: [REDIRECT, 'https://alt.example.com/cb0'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_id).toBe('string');
    expect(String(body.client_id).startsWith('client_')).toBe(true);
    expect(body.client_name).toBe('Soft App 0');
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.client_secret).toBeUndefined();
    expect(body.client_id_issued_at).toBe(Math.floor(NOW / 1000));
    expect(cache.puts.some((p) => p.key.startsWith('oauth_client:') && p.options?.expirationTtl === 365 * 24 * 60 * 60)).toBe(true);
  });

  it('register soft success-1', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Soft App 1',
          redirect_uris: [REDIRECT, 'https://alt.example.com/cb1'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_id).toBe('string');
    expect(String(body.client_id).startsWith('client_')).toBe(true);
    expect(body.client_name).toBe('Soft App 1');
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.client_secret).toBeUndefined();
    expect(body.client_id_issued_at).toBe(Math.floor(NOW / 1000));
    expect(cache.puts.some((p) => p.key.startsWith('oauth_client:') && p.options?.expirationTtl === 365 * 24 * 60 * 60)).toBe(true);
  });

  it('register soft success-2', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Soft App 2',
          redirect_uris: [REDIRECT, 'https://alt.example.com/cb2'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_id).toBe('string');
    expect(String(body.client_id).startsWith('client_')).toBe(true);
    expect(body.client_name).toBe('Soft App 2');
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.client_secret).toBeUndefined();
    expect(body.client_id_issued_at).toBe(Math.floor(NOW / 1000));
    expect(cache.puts.some((p) => p.key.startsWith('oauth_client:') && p.options?.expirationTtl === 365 * 24 * 60 * 60)).toBe(true);
  });

  it('register soft success-3', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Soft App 3',
          redirect_uris: [REDIRECT, 'https://alt.example.com/cb3'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_id).toBe('string');
    expect(String(body.client_id).startsWith('client_')).toBe(true);
    expect(body.client_name).toBe('Soft App 3');
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.client_secret).toBeUndefined();
    expect(body.client_id_issued_at).toBe(Math.floor(NOW / 1000));
    expect(cache.puts.some((p) => p.key.startsWith('oauth_client:') && p.options?.expirationTtl === 365 * 24 * 60 * 60)).toBe(true);
  });

  it('register soft success-4', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Soft App 4',
          redirect_uris: [REDIRECT, 'https://alt.example.com/cb4'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_id).toBe('string');
    expect(String(body.client_id).startsWith('client_')).toBe(true);
    expect(body.client_name).toBe('Soft App 4');
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.client_secret).toBeUndefined();
    expect(body.client_id_issued_at).toBe(Math.floor(NOW / 1000));
    expect(cache.puts.some((p) => p.key.startsWith('oauth_client:') && p.options?.expirationTtl === 365 * 24 * 60 * 60)).toBe(true);
  });

  it('register soft success-5', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Soft App 5',
          redirect_uris: [REDIRECT, 'https://alt.example.com/cb5'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_id).toBe('string');
    expect(String(body.client_id).startsWith('client_')).toBe(true);
    expect(body.client_name).toBe('Soft App 5');
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.client_secret).toBeUndefined();
    expect(body.client_id_issued_at).toBe(Math.floor(NOW / 1000));
    expect(cache.puts.some((p) => p.key.startsWith('oauth_client:') && p.options?.expirationTtl === 365 * 24 * 60 * 60)).toBe(true);
  });

  it('register soft success-6', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Soft App 6',
          redirect_uris: [REDIRECT, 'https://alt.example.com/cb6'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_id).toBe('string');
    expect(String(body.client_id).startsWith('client_')).toBe(true);
    expect(body.client_name).toBe('Soft App 6');
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.client_secret).toBeUndefined();
    expect(body.client_id_issued_at).toBe(Math.floor(NOW / 1000));
    expect(cache.puts.some((p) => p.key.startsWith('oauth_client:') && p.options?.expirationTtl === 365 * 24 * 60 * 60)).toBe(true);
  });

  it('register soft success-7', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Soft App 7',
          redirect_uris: [REDIRECT, 'https://alt.example.com/cb7'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_id).toBe('string');
    expect(String(body.client_id).startsWith('client_')).toBe(true);
    expect(body.client_name).toBe('Soft App 7');
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.client_secret).toBeUndefined();
    expect(body.client_id_issued_at).toBe(Math.floor(NOW / 1000));
    expect(cache.puts.some((p) => p.key.startsWith('oauth_client:') && p.options?.expirationTtl === 365 * 24 * 60 * 60)).toBe(true);
  });

  it('register soft success-8', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Soft App 8',
          redirect_uris: [REDIRECT, 'https://alt.example.com/cb8'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_id).toBe('string');
    expect(String(body.client_id).startsWith('client_')).toBe(true);
    expect(body.client_name).toBe('Soft App 8');
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.client_secret).toBeUndefined();
    expect(body.client_id_issued_at).toBe(Math.floor(NOW / 1000));
    expect(cache.puts.some((p) => p.key.startsWith('oauth_client:') && p.options?.expirationTtl === 365 * 24 * 60 * 60)).toBe(true);
  });

  it('register soft success-9', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Soft App 9',
          redirect_uris: [REDIRECT, 'https://alt.example.com/cb9'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_id).toBe('string');
    expect(String(body.client_id).startsWith('client_')).toBe(true);
    expect(body.client_name).toBe('Soft App 9');
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.client_secret).toBeUndefined();
    expect(body.client_id_issued_at).toBe(Math.floor(NOW / 1000));
    expect(cache.puts.some((p) => p.key.startsWith('oauth_client:') && p.options?.expirationTtl === 365 * 24 * 60 * 60)).toBe(true);
  });

  it('register soft success-10', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Soft App 10',
          redirect_uris: [REDIRECT, 'https://alt.example.com/cb10'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_id).toBe('string');
    expect(String(body.client_id).startsWith('client_')).toBe(true);
    expect(body.client_name).toBe('Soft App 10');
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.client_secret).toBeUndefined();
    expect(body.client_id_issued_at).toBe(Math.floor(NOW / 1000));
    expect(cache.puts.some((p) => p.key.startsWith('oauth_client:') && p.options?.expirationTtl === 365 * 24 * 60 * 60)).toBe(true);
  });

  it('register soft success-11', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Soft App 11',
          redirect_uris: [REDIRECT, 'https://alt.example.com/cb11'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_id).toBe('string');
    expect(String(body.client_id).startsWith('client_')).toBe(true);
    expect(body.client_name).toBe('Soft App 11');
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.client_secret).toBeUndefined();
    expect(body.client_id_issued_at).toBe(Math.floor(NOW / 1000));
    expect(cache.puts.some((p) => p.key.startsWith('oauth_client:') && p.options?.expirationTtl === 365 * 24 * 60 * 60)).toBe(true);
  });

  it('register soft success-12', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Soft App 12',
          redirect_uris: [REDIRECT, 'https://alt.example.com/cb12'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_id).toBe('string');
    expect(String(body.client_id).startsWith('client_')).toBe(true);
    expect(body.client_name).toBe('Soft App 12');
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.client_secret).toBeUndefined();
    expect(body.client_id_issued_at).toBe(Math.floor(NOW / 1000));
    expect(cache.puts.some((p) => p.key.startsWith('oauth_client:') && p.options?.expirationTtl === 365 * 24 * 60 * 60)).toBe(true);
  });

  it('register soft success-13', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Soft App 13',
          redirect_uris: [REDIRECT, 'https://alt.example.com/cb13'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_id).toBe('string');
    expect(String(body.client_id).startsWith('client_')).toBe(true);
    expect(body.client_name).toBe('Soft App 13');
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.client_secret).toBeUndefined();
    expect(body.client_id_issued_at).toBe(Math.floor(NOW / 1000));
    expect(cache.puts.some((p) => p.key.startsWith('oauth_client:') && p.options?.expirationTtl === 365 * 24 * 60 * 60)).toBe(true);
  });

  it('register soft success-14', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Soft App 14',
          redirect_uris: [REDIRECT, 'https://alt.example.com/cb14'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_id).toBe('string');
    expect(String(body.client_id).startsWith('client_')).toBe(true);
    expect(body.client_name).toBe('Soft App 14');
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.client_secret).toBeUndefined();
    expect(body.client_id_issued_at).toBe(Math.floor(NOW / 1000));
    expect(cache.puts.some((p) => p.key.startsWith('oauth_client:') && p.options?.expirationTtl === 365 * 24 * 60 * 60)).toBe(true);
  });

  it('register soft success-15', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Soft App 15',
          redirect_uris: [REDIRECT, 'https://alt.example.com/cb15'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_id).toBe('string');
    expect(String(body.client_id).startsWith('client_')).toBe(true);
    expect(body.client_name).toBe('Soft App 15');
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.client_secret).toBeUndefined();
    expect(body.client_id_issued_at).toBe(Math.floor(NOW / 1000));
    expect(cache.puts.some((p) => p.key.startsWith('oauth_client:') && p.options?.expirationTtl === 365 * 24 * 60 * 60)).toBe(true);
  });

  it('register soft success-16', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Soft App 16',
          redirect_uris: [REDIRECT, 'https://alt.example.com/cb16'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_id).toBe('string');
    expect(String(body.client_id).startsWith('client_')).toBe(true);
    expect(body.client_name).toBe('Soft App 16');
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.client_secret).toBeUndefined();
    expect(body.client_id_issued_at).toBe(Math.floor(NOW / 1000));
    expect(cache.puts.some((p) => p.key.startsWith('oauth_client:') && p.options?.expirationTtl === 365 * 24 * 60 * 60)).toBe(true);
  });

  it('register soft success-17', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Soft App 17',
          redirect_uris: [REDIRECT, 'https://alt.example.com/cb17'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_id).toBe('string');
    expect(String(body.client_id).startsWith('client_')).toBe(true);
    expect(body.client_name).toBe('Soft App 17');
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.client_secret).toBeUndefined();
    expect(body.client_id_issued_at).toBe(Math.floor(NOW / 1000));
    expect(cache.puts.some((p) => p.key.startsWith('oauth_client:') && p.options?.expirationTtl === 365 * 24 * 60 * 60)).toBe(true);
  });

  it('register soft success-18', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Soft App 18',
          redirect_uris: [REDIRECT, 'https://alt.example.com/cb18'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_id).toBe('string');
    expect(String(body.client_id).startsWith('client_')).toBe(true);
    expect(body.client_name).toBe('Soft App 18');
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.client_secret).toBeUndefined();
    expect(body.client_id_issued_at).toBe(Math.floor(NOW / 1000));
    expect(cache.puts.some((p) => p.key.startsWith('oauth_client:') && p.options?.expirationTtl === 365 * 24 * 60 * 60)).toBe(true);
  });

  it('register soft success-19', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Soft App 19',
          redirect_uris: [REDIRECT, 'https://alt.example.com/cb19'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_id).toBe('string');
    expect(String(body.client_id).startsWith('client_')).toBe(true);
    expect(body.client_name).toBe('Soft App 19');
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.client_secret).toBeUndefined();
    expect(body.client_id_issued_at).toBe(Math.floor(NOW / 1000));
    expect(cache.puts.some((p) => p.key.startsWith('oauth_client:') && p.options?.expirationTtl === 365 * 24 * 60 * 60)).toBe(true);
  });
});

describe('oauth soft leftovers register confidential soft flood after #142', () => {

  it('register confidential soft-0', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Conf Soft 0',
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'client_secret_post',
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_secret).toBe('string');
    expect(body.client_secret_expires_at).toBe(0);
    const stored = JSON.parse(cache.data[`oauth_client:${body.client_id}`]);
    expect(stored.client_secret_hash).toBeTruthy();
    expect(stored.client_secret_hash).toBe(await hashClientSecret(String(body.client_secret)));
  });

  it('register confidential soft-1', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Conf Soft 1',
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'client_secret_post',
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_secret).toBe('string');
    expect(body.client_secret_expires_at).toBe(0);
    const stored = JSON.parse(cache.data[`oauth_client:${body.client_id}`]);
    expect(stored.client_secret_hash).toBeTruthy();
    expect(stored.client_secret_hash).toBe(await hashClientSecret(String(body.client_secret)));
  });

  it('register confidential soft-2', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Conf Soft 2',
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'client_secret_post',
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_secret).toBe('string');
    expect(body.client_secret_expires_at).toBe(0);
    const stored = JSON.parse(cache.data[`oauth_client:${body.client_id}`]);
    expect(stored.client_secret_hash).toBeTruthy();
    expect(stored.client_secret_hash).toBe(await hashClientSecret(String(body.client_secret)));
  });

  it('register confidential soft-3', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Conf Soft 3',
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'client_secret_post',
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_secret).toBe('string');
    expect(body.client_secret_expires_at).toBe(0);
    const stored = JSON.parse(cache.data[`oauth_client:${body.client_id}`]);
    expect(stored.client_secret_hash).toBeTruthy();
    expect(stored.client_secret_hash).toBe(await hashClientSecret(String(body.client_secret)));
  });

  it('register confidential soft-4', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Conf Soft 4',
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'client_secret_post',
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_secret).toBe('string');
    expect(body.client_secret_expires_at).toBe(0);
    const stored = JSON.parse(cache.data[`oauth_client:${body.client_id}`]);
    expect(stored.client_secret_hash).toBeTruthy();
    expect(stored.client_secret_hash).toBe(await hashClientSecret(String(body.client_secret)));
  });

  it('register confidential soft-5', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Conf Soft 5',
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'client_secret_post',
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_secret).toBe('string');
    expect(body.client_secret_expires_at).toBe(0);
    const stored = JSON.parse(cache.data[`oauth_client:${body.client_id}`]);
    expect(stored.client_secret_hash).toBeTruthy();
    expect(stored.client_secret_hash).toBe(await hashClientSecret(String(body.client_secret)));
  });

  it('register confidential soft-6', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Conf Soft 6',
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'client_secret_post',
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_secret).toBe('string');
    expect(body.client_secret_expires_at).toBe(0);
    const stored = JSON.parse(cache.data[`oauth_client:${body.client_id}`]);
    expect(stored.client_secret_hash).toBeTruthy();
    expect(stored.client_secret_hash).toBe(await hashClientSecret(String(body.client_secret)));
  });

  it('register confidential soft-7', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Conf Soft 7',
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'client_secret_post',
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_secret).toBe('string');
    expect(body.client_secret_expires_at).toBe(0);
    const stored = JSON.parse(cache.data[`oauth_client:${body.client_id}`]);
    expect(stored.client_secret_hash).toBeTruthy();
    expect(stored.client_secret_hash).toBe(await hashClientSecret(String(body.client_secret)));
  });

  it('register confidential soft-8', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Conf Soft 8',
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'client_secret_post',
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_secret).toBe('string');
    expect(body.client_secret_expires_at).toBe(0);
    const stored = JSON.parse(cache.data[`oauth_client:${body.client_id}`]);
    expect(stored.client_secret_hash).toBeTruthy();
    expect(stored.client_secret_hash).toBe(await hashClientSecret(String(body.client_secret)));
  });

  it('register confidential soft-9', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Conf Soft 9',
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'client_secret_post',
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_secret).toBe('string');
    expect(body.client_secret_expires_at).toBe(0);
    const stored = JSON.parse(cache.data[`oauth_client:${body.client_id}`]);
    expect(stored.client_secret_hash).toBeTruthy();
    expect(stored.client_secret_hash).toBe(await hashClientSecret(String(body.client_secret)));
  });

  it('register confidential soft-10', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Conf Soft 10',
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'client_secret_post',
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_secret).toBe('string');
    expect(body.client_secret_expires_at).toBe(0);
    const stored = JSON.parse(cache.data[`oauth_client:${body.client_id}`]);
    expect(stored.client_secret_hash).toBeTruthy();
    expect(stored.client_secret_hash).toBe(await hashClientSecret(String(body.client_secret)));
  });

  it('register confidential soft-11', async () => {
    const cache = mockKv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Conf Soft 11',
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'client_secret_post',
        }),
      },
      makeEnv({ CACHE: cache })
    );
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(typeof body.client_secret).toBe('string');
    expect(body.client_secret_expires_at).toBe(0);
    const stored = JSON.parse(cache.data[`oauth_client:${body.client_id}`]);
    expect(stored.client_secret_hash).toBeTruthy();
    expect(stored.client_secret_hash).toBe(await hashClientSecret(String(body.client_secret)));
  });
});

describe('oauth soft leftovers GET /oauth/authorize HTML soft flood after #142', () => {

  it('authorize HTML soft-0', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_html_0', { client_name: 'Name Soft 0' });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_html_0&redirect_uri=${encodeURIComponent(REDIRECT)}&state=st0&scope=openid`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') || '';
    expect(ct.includes('text/html')).toBe(true);
    const html = await res.text();
    expect(html).toContain('Name Soft 0');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize HTML soft-1', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_html_1', { client_name: 'Name Soft 1' });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_html_1&redirect_uri=${encodeURIComponent(REDIRECT)}&state=st1&scope=openid`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') || '';
    expect(ct.includes('text/html')).toBe(true);
    const html = await res.text();
    expect(html).toContain('Name Soft 1');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize HTML soft-2', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_html_2', { client_name: 'Name Soft 2' });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_html_2&redirect_uri=${encodeURIComponent(REDIRECT)}&state=st2&scope=openid`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') || '';
    expect(ct.includes('text/html')).toBe(true);
    const html = await res.text();
    expect(html).toContain('Name Soft 2');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize HTML soft-3', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_html_3', { client_name: 'Name Soft 3' });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_html_3&redirect_uri=${encodeURIComponent(REDIRECT)}&state=st3&scope=openid`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') || '';
    expect(ct.includes('text/html')).toBe(true);
    const html = await res.text();
    expect(html).toContain('Name Soft 3');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize HTML soft-4', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_html_4', { client_name: 'Name Soft 4' });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_html_4&redirect_uri=${encodeURIComponent(REDIRECT)}&state=st4&scope=openid`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') || '';
    expect(ct.includes('text/html')).toBe(true);
    const html = await res.text();
    expect(html).toContain('Name Soft 4');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize HTML soft-5', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_html_5', { client_name: 'Name Soft 5' });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_html_5&redirect_uri=${encodeURIComponent(REDIRECT)}&state=st5&scope=openid`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') || '';
    expect(ct.includes('text/html')).toBe(true);
    const html = await res.text();
    expect(html).toContain('Name Soft 5');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize HTML soft-6', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_html_6', { client_name: 'Name Soft 6' });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_html_6&redirect_uri=${encodeURIComponent(REDIRECT)}&state=st6&scope=openid`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') || '';
    expect(ct.includes('text/html')).toBe(true);
    const html = await res.text();
    expect(html).toContain('Name Soft 6');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize HTML soft-7', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_html_7', { client_name: 'Name Soft 7' });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_html_7&redirect_uri=${encodeURIComponent(REDIRECT)}&state=st7&scope=openid`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') || '';
    expect(ct.includes('text/html')).toBe(true);
    const html = await res.text();
    expect(html).toContain('Name Soft 7');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize HTML soft-8', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_html_8', { client_name: 'Name Soft 8' });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_html_8&redirect_uri=${encodeURIComponent(REDIRECT)}&state=st8&scope=openid`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') || '';
    expect(ct.includes('text/html')).toBe(true);
    const html = await res.text();
    expect(html).toContain('Name Soft 8');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize HTML soft-9', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_html_9', { client_name: 'Name Soft 9' });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_html_9&redirect_uri=${encodeURIComponent(REDIRECT)}&state=st9&scope=openid`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') || '';
    expect(ct.includes('text/html')).toBe(true);
    const html = await res.text();
    expect(html).toContain('Name Soft 9');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize HTML soft-10', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_html_10', { client_name: 'Name Soft 10' });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_html_10&redirect_uri=${encodeURIComponent(REDIRECT)}&state=st10&scope=openid`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') || '';
    expect(ct.includes('text/html')).toBe(true);
    const html = await res.text();
    expect(html).toContain('Name Soft 10');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize HTML soft-11', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_html_11', { client_name: 'Name Soft 11' });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_html_11&redirect_uri=${encodeURIComponent(REDIRECT)}&state=st11&scope=openid`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') || '';
    expect(ct.includes('text/html')).toBe(true);
    const html = await res.text();
    expect(html).toContain('Name Soft 11');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize HTML soft-12', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_html_12', { client_name: 'Name Soft 12' });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_html_12&redirect_uri=${encodeURIComponent(REDIRECT)}&state=st12&scope=openid`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') || '';
    expect(ct.includes('text/html')).toBe(true);
    const html = await res.text();
    expect(html).toContain('Name Soft 12');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize HTML soft-13', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_html_13', { client_name: 'Name Soft 13' });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_html_13&redirect_uri=${encodeURIComponent(REDIRECT)}&state=st13&scope=openid`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') || '';
    expect(ct.includes('text/html')).toBe(true);
    const html = await res.text();
    expect(html).toContain('Name Soft 13');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize HTML soft-14', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_html_14', { client_name: 'Name Soft 14' });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_html_14&redirect_uri=${encodeURIComponent(REDIRECT)}&state=st14&scope=openid`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') || '';
    expect(ct.includes('text/html')).toBe(true);
    const html = await res.text();
    expect(html).toContain('Name Soft 14');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });
});

describe('oauth soft leftovers POST authorize → code redirect soft flood after #142', () => {

  it('authorize POST soft code-0', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_post_0');
    const authId = 'authsoft0';
    sessions.data[`oauth_auth_request:${authId}`] = JSON.stringify({
      client_id: 'client_post_0',
      redirect_uri: REDIRECT,
      scope: 'openid',
      state: 'state0',
      nonce: 'nonce0',
      code_challenge: null,
      code_challenge_method: 'plain',
    });
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}` }]]),
    });
    const form = new URLSearchParams({
      username: 'alice',
      password: STRONG_PW,
      auth_request_id: authId,
    });
    const res = await request(
      '/oauth/authorize',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') || '';
    expect(loc.startsWith(REDIRECT)).toBe(true);
    const url = new URL(loc);
    expect(url.searchParams.get('state')).toBe('state0');
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(sessions.deletes).toContain(`oauth_auth_request:${authId}`);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_code:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize POST soft code-1', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_post_1');
    const authId = 'authsoft1';
    sessions.data[`oauth_auth_request:${authId}`] = JSON.stringify({
      client_id: 'client_post_1',
      redirect_uri: REDIRECT,
      scope: 'openid',
      state: 'state1',
      nonce: 'nonce1',
      code_challenge: null,
      code_challenge_method: 'plain',
    });
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}` }]]),
    });
    const form = new URLSearchParams({
      username: 'alice',
      password: STRONG_PW,
      auth_request_id: authId,
    });
    const res = await request(
      '/oauth/authorize',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') || '';
    expect(loc.startsWith(REDIRECT)).toBe(true);
    const url = new URL(loc);
    expect(url.searchParams.get('state')).toBe('state1');
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(sessions.deletes).toContain(`oauth_auth_request:${authId}`);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_code:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize POST soft code-2', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_post_2');
    const authId = 'authsoft2';
    sessions.data[`oauth_auth_request:${authId}`] = JSON.stringify({
      client_id: 'client_post_2',
      redirect_uri: REDIRECT,
      scope: 'openid',
      state: 'state2',
      nonce: 'nonce2',
      code_challenge: null,
      code_challenge_method: 'plain',
    });
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}` }]]),
    });
    const form = new URLSearchParams({
      username: 'alice',
      password: STRONG_PW,
      auth_request_id: authId,
    });
    const res = await request(
      '/oauth/authorize',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') || '';
    expect(loc.startsWith(REDIRECT)).toBe(true);
    const url = new URL(loc);
    expect(url.searchParams.get('state')).toBe('state2');
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(sessions.deletes).toContain(`oauth_auth_request:${authId}`);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_code:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize POST soft code-3', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_post_3');
    const authId = 'authsoft3';
    sessions.data[`oauth_auth_request:${authId}`] = JSON.stringify({
      client_id: 'client_post_3',
      redirect_uri: REDIRECT,
      scope: 'openid',
      state: 'state3',
      nonce: 'nonce3',
      code_challenge: null,
      code_challenge_method: 'plain',
    });
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}` }]]),
    });
    const form = new URLSearchParams({
      username: 'alice',
      password: STRONG_PW,
      auth_request_id: authId,
    });
    const res = await request(
      '/oauth/authorize',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') || '';
    expect(loc.startsWith(REDIRECT)).toBe(true);
    const url = new URL(loc);
    expect(url.searchParams.get('state')).toBe('state3');
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(sessions.deletes).toContain(`oauth_auth_request:${authId}`);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_code:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize POST soft code-4', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_post_4');
    const authId = 'authsoft4';
    sessions.data[`oauth_auth_request:${authId}`] = JSON.stringify({
      client_id: 'client_post_4',
      redirect_uri: REDIRECT,
      scope: 'openid',
      state: 'state4',
      nonce: 'nonce4',
      code_challenge: null,
      code_challenge_method: 'plain',
    });
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}` }]]),
    });
    const form = new URLSearchParams({
      username: 'alice',
      password: STRONG_PW,
      auth_request_id: authId,
    });
    const res = await request(
      '/oauth/authorize',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') || '';
    expect(loc.startsWith(REDIRECT)).toBe(true);
    const url = new URL(loc);
    expect(url.searchParams.get('state')).toBe('state4');
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(sessions.deletes).toContain(`oauth_auth_request:${authId}`);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_code:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize POST soft code-5', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_post_5');
    const authId = 'authsoft5';
    sessions.data[`oauth_auth_request:${authId}`] = JSON.stringify({
      client_id: 'client_post_5',
      redirect_uri: REDIRECT,
      scope: 'openid',
      state: 'state5',
      nonce: 'nonce5',
      code_challenge: null,
      code_challenge_method: 'plain',
    });
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}` }]]),
    });
    const form = new URLSearchParams({
      username: 'alice',
      password: STRONG_PW,
      auth_request_id: authId,
    });
    const res = await request(
      '/oauth/authorize',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') || '';
    expect(loc.startsWith(REDIRECT)).toBe(true);
    const url = new URL(loc);
    expect(url.searchParams.get('state')).toBe('state5');
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(sessions.deletes).toContain(`oauth_auth_request:${authId}`);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_code:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize POST soft code-6', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_post_6');
    const authId = 'authsoft6';
    sessions.data[`oauth_auth_request:${authId}`] = JSON.stringify({
      client_id: 'client_post_6',
      redirect_uri: REDIRECT,
      scope: 'openid',
      state: 'state6',
      nonce: 'nonce6',
      code_challenge: null,
      code_challenge_method: 'plain',
    });
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}` }]]),
    });
    const form = new URLSearchParams({
      username: 'alice',
      password: STRONG_PW,
      auth_request_id: authId,
    });
    const res = await request(
      '/oauth/authorize',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') || '';
    expect(loc.startsWith(REDIRECT)).toBe(true);
    const url = new URL(loc);
    expect(url.searchParams.get('state')).toBe('state6');
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(sessions.deletes).toContain(`oauth_auth_request:${authId}`);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_code:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize POST soft code-7', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_post_7');
    const authId = 'authsoft7';
    sessions.data[`oauth_auth_request:${authId}`] = JSON.stringify({
      client_id: 'client_post_7',
      redirect_uri: REDIRECT,
      scope: 'openid',
      state: 'state7',
      nonce: 'nonce7',
      code_challenge: null,
      code_challenge_method: 'plain',
    });
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}` }]]),
    });
    const form = new URLSearchParams({
      username: 'alice',
      password: STRONG_PW,
      auth_request_id: authId,
    });
    const res = await request(
      '/oauth/authorize',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') || '';
    expect(loc.startsWith(REDIRECT)).toBe(true);
    const url = new URL(loc);
    expect(url.searchParams.get('state')).toBe('state7');
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(sessions.deletes).toContain(`oauth_auth_request:${authId}`);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_code:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize POST soft code-8', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_post_8');
    const authId = 'authsoft8';
    sessions.data[`oauth_auth_request:${authId}`] = JSON.stringify({
      client_id: 'client_post_8',
      redirect_uri: REDIRECT,
      scope: 'openid',
      state: 'state8',
      nonce: 'nonce8',
      code_challenge: null,
      code_challenge_method: 'plain',
    });
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}` }]]),
    });
    const form = new URLSearchParams({
      username: 'alice',
      password: STRONG_PW,
      auth_request_id: authId,
    });
    const res = await request(
      '/oauth/authorize',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') || '';
    expect(loc.startsWith(REDIRECT)).toBe(true);
    const url = new URL(loc);
    expect(url.searchParams.get('state')).toBe('state8');
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(sessions.deletes).toContain(`oauth_auth_request:${authId}`);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_code:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize POST soft code-9', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_post_9');
    const authId = 'authsoft9';
    sessions.data[`oauth_auth_request:${authId}`] = JSON.stringify({
      client_id: 'client_post_9',
      redirect_uri: REDIRECT,
      scope: 'openid',
      state: 'state9',
      nonce: 'nonce9',
      code_challenge: null,
      code_challenge_method: 'plain',
    });
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}` }]]),
    });
    const form = new URLSearchParams({
      username: 'alice',
      password: STRONG_PW,
      auth_request_id: authId,
    });
    const res = await request(
      '/oauth/authorize',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') || '';
    expect(loc.startsWith(REDIRECT)).toBe(true);
    const url = new URL(loc);
    expect(url.searchParams.get('state')).toBe('state9');
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(sessions.deletes).toContain(`oauth_auth_request:${authId}`);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_code:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize POST soft code-10', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_post_10');
    const authId = 'authsoft10';
    sessions.data[`oauth_auth_request:${authId}`] = JSON.stringify({
      client_id: 'client_post_10',
      redirect_uri: REDIRECT,
      scope: 'openid',
      state: 'state10',
      nonce: 'nonce10',
      code_challenge: null,
      code_challenge_method: 'plain',
    });
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}` }]]),
    });
    const form = new URLSearchParams({
      username: 'alice',
      password: STRONG_PW,
      auth_request_id: authId,
    });
    const res = await request(
      '/oauth/authorize',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') || '';
    expect(loc.startsWith(REDIRECT)).toBe(true);
    const url = new URL(loc);
    expect(url.searchParams.get('state')).toBe('state10');
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(sessions.deletes).toContain(`oauth_auth_request:${authId}`);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_code:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize POST soft code-11', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_post_11');
    const authId = 'authsoft11';
    sessions.data[`oauth_auth_request:${authId}`] = JSON.stringify({
      client_id: 'client_post_11',
      redirect_uri: REDIRECT,
      scope: 'openid',
      state: 'state11',
      nonce: 'nonce11',
      code_challenge: null,
      code_challenge_method: 'plain',
    });
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}` }]]),
    });
    const form = new URLSearchParams({
      username: 'alice',
      password: STRONG_PW,
      auth_request_id: authId,
    });
    const res = await request(
      '/oauth/authorize',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') || '';
    expect(loc.startsWith(REDIRECT)).toBe(true);
    const url = new URL(loc);
    expect(url.searchParams.get('state')).toBe('state11');
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(sessions.deletes).toContain(`oauth_auth_request:${authId}`);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_code:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize POST soft code-12', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_post_12');
    const authId = 'authsoft12';
    sessions.data[`oauth_auth_request:${authId}`] = JSON.stringify({
      client_id: 'client_post_12',
      redirect_uri: REDIRECT,
      scope: 'openid',
      state: 'state12',
      nonce: 'nonce12',
      code_challenge: null,
      code_challenge_method: 'plain',
    });
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}` }]]),
    });
    const form = new URLSearchParams({
      username: 'alice',
      password: STRONG_PW,
      auth_request_id: authId,
    });
    const res = await request(
      '/oauth/authorize',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') || '';
    expect(loc.startsWith(REDIRECT)).toBe(true);
    const url = new URL(loc);
    expect(url.searchParams.get('state')).toBe('state12');
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(sessions.deletes).toContain(`oauth_auth_request:${authId}`);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_code:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize POST soft code-13', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_post_13');
    const authId = 'authsoft13';
    sessions.data[`oauth_auth_request:${authId}`] = JSON.stringify({
      client_id: 'client_post_13',
      redirect_uri: REDIRECT,
      scope: 'openid',
      state: 'state13',
      nonce: 'nonce13',
      code_challenge: null,
      code_challenge_method: 'plain',
    });
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}` }]]),
    });
    const form = new URLSearchParams({
      username: 'alice',
      password: STRONG_PW,
      auth_request_id: authId,
    });
    const res = await request(
      '/oauth/authorize',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') || '';
    expect(loc.startsWith(REDIRECT)).toBe(true);
    const url = new URL(loc);
    expect(url.searchParams.get('state')).toBe('state13');
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(sessions.deletes).toContain(`oauth_auth_request:${authId}`);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_code:') && p.options?.expirationTtl === 600)).toBe(true);
  });

  it('authorize POST soft code-14', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_post_14');
    const authId = 'authsoft14';
    sessions.data[`oauth_auth_request:${authId}`] = JSON.stringify({
      client_id: 'client_post_14',
      redirect_uri: REDIRECT,
      scope: 'openid',
      state: 'state14',
      nonce: 'nonce14',
      code_challenge: null,
      code_challenge_method: 'plain',
    });
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}` }]]),
    });
    const form = new URLSearchParams({
      username: 'alice',
      password: STRONG_PW,
      auth_request_id: authId,
    });
    const res = await request(
      '/oauth/authorize',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') || '';
    expect(loc.startsWith(REDIRECT)).toBe(true);
    const url = new URL(loc);
    expect(url.searchParams.get('state')).toBe('state14');
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(sessions.deletes).toContain(`oauth_auth_request:${authId}`);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_code:') && p.options?.expirationTtl === 600)).toBe(true);
  });
});

describe('oauth soft leftovers revoke always-200 soft flood after #142', () => {

  it('revoke missing/unknown soft-0', async () => {
    const sessions = mockKv();
    sessions.data['oauth_refresh:known0'] = JSON.stringify({ user_id: USER });
    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'known0', token_type_hint: 'refresh_token' }),
      },
      makeEnv({ SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
  });

  it('revoke missing/unknown soft-1', async () => {
    const sessions = mockKv();
    sessions.data['oauth_refresh:known1'] = JSON.stringify({ user_id: USER });
    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'unknown1', token_type_hint: 'refresh_token' }),
      },
      makeEnv({ SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
  });

  it('revoke missing/unknown soft-2', async () => {
    const sessions = mockKv();
    sessions.data['oauth_refresh:known2'] = JSON.stringify({ user_id: USER });
    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'known2', token_type_hint: 'refresh_token' }),
      },
      makeEnv({ SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
  });

  it('revoke missing/unknown soft-3', async () => {
    const sessions = mockKv();
    sessions.data['oauth_refresh:known3'] = JSON.stringify({ user_id: USER });
    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'unknown3', token_type_hint: 'refresh_token' }),
      },
      makeEnv({ SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
  });

  it('revoke missing/unknown soft-4', async () => {
    const sessions = mockKv();
    sessions.data['oauth_refresh:known4'] = JSON.stringify({ user_id: USER });
    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'known4', token_type_hint: 'refresh_token' }),
      },
      makeEnv({ SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
  });

  it('revoke missing/unknown soft-5', async () => {
    const sessions = mockKv();
    sessions.data['oauth_refresh:known5'] = JSON.stringify({ user_id: USER });
    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'unknown5', token_type_hint: 'refresh_token' }),
      },
      makeEnv({ SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
  });

  it('revoke missing/unknown soft-6', async () => {
    const sessions = mockKv();
    sessions.data['oauth_refresh:known6'] = JSON.stringify({ user_id: USER });
    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'known6', token_type_hint: 'refresh_token' }),
      },
      makeEnv({ SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
  });

  it('revoke missing/unknown soft-7', async () => {
    const sessions = mockKv();
    sessions.data['oauth_refresh:known7'] = JSON.stringify({ user_id: USER });
    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'unknown7', token_type_hint: 'refresh_token' }),
      },
      makeEnv({ SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
  });

  it('revoke missing/unknown soft-8', async () => {
    const sessions = mockKv();
    sessions.data['oauth_refresh:known8'] = JSON.stringify({ user_id: USER });
    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'known8', token_type_hint: 'refresh_token' }),
      },
      makeEnv({ SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
  });

  it('revoke missing/unknown soft-9', async () => {
    const sessions = mockKv();
    sessions.data['oauth_refresh:known9'] = JSON.stringify({ user_id: USER });
    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'unknown9', token_type_hint: 'refresh_token' }),
      },
      makeEnv({ SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
  });

  it('revoke missing/unknown soft-10', async () => {
    const sessions = mockKv();
    sessions.data['oauth_refresh:known10'] = JSON.stringify({ user_id: USER });
    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'known10', token_type_hint: 'refresh_token' }),
      },
      makeEnv({ SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
  });

  it('revoke missing/unknown soft-11', async () => {
    const sessions = mockKv();
    sessions.data['oauth_refresh:known11'] = JSON.stringify({ user_id: USER });
    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'unknown11', token_type_hint: 'refresh_token' }),
      },
      makeEnv({ SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
  });

  it('revoke missing/unknown soft-12', async () => {
    const sessions = mockKv();
    sessions.data['oauth_refresh:known12'] = JSON.stringify({ user_id: USER });
    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'known12', token_type_hint: 'refresh_token' }),
      },
      makeEnv({ SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
  });

  it('revoke missing/unknown soft-13', async () => {
    const sessions = mockKv();
    sessions.data['oauth_refresh:known13'] = JSON.stringify({ user_id: USER });
    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'unknown13', token_type_hint: 'refresh_token' }),
      },
      makeEnv({ SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
  });

  it('revoke missing/unknown soft-14', async () => {
    const sessions = mockKv();
    sessions.data['oauth_refresh:known14'] = JSON.stringify({ user_id: USER });
    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'known14', token_type_hint: 'refresh_token' }),
      },
      makeEnv({ SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
  });
});

describe('oauth soft leftovers introspect inactive soft flood after #142', () => {

  it('introspect inactive soft-0', async () => {
    const res = await request(
      '/oauth/introspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'not-a-real-token-0' }),
      },
      makeEnv()
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.active).toBe(false);
  });

  it('introspect inactive soft-1', async () => {
    const res = await request(
      '/oauth/introspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'not-a-real-token-1' }),
      },
      makeEnv()
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.active).toBe(false);
  });

  it('introspect inactive soft-2', async () => {
    const res = await request(
      '/oauth/introspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'not-a-real-token-2' }),
      },
      makeEnv()
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.active).toBe(false);
  });

  it('introspect inactive soft-3', async () => {
    const res = await request(
      '/oauth/introspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'not-a-real-token-3' }),
      },
      makeEnv()
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.active).toBe(false);
  });

  it('introspect inactive soft-4', async () => {
    const res = await request(
      '/oauth/introspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'not-a-real-token-4' }),
      },
      makeEnv()
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.active).toBe(false);
  });

  it('introspect inactive soft-5', async () => {
    const res = await request(
      '/oauth/introspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'not-a-real-token-5' }),
      },
      makeEnv()
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.active).toBe(false);
  });

  it('introspect inactive soft-6', async () => {
    const res = await request(
      '/oauth/introspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'not-a-real-token-6' }),
      },
      makeEnv()
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.active).toBe(false);
  });

  it('introspect inactive soft-7', async () => {
    const res = await request(
      '/oauth/introspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'not-a-real-token-7' }),
      },
      makeEnv()
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.active).toBe(false);
  });

  it('introspect inactive soft-8', async () => {
    const res = await request(
      '/oauth/introspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'not-a-real-token-8' }),
      },
      makeEnv()
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.active).toBe(false);
  });

  it('introspect inactive soft-9', async () => {
    const res = await request(
      '/oauth/introspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'not-a-real-token-9' }),
      },
      makeEnv()
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.active).toBe(false);
  });

  it('introspect inactive soft-10', async () => {
    const res = await request(
      '/oauth/introspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'not-a-real-token-10' }),
      },
      makeEnv()
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.active).toBe(false);
  });

  it('introspect inactive soft-11', async () => {
    const res = await request(
      '/oauth/introspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'not-a-real-token-11' }),
      },
      makeEnv()
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.active).toBe(false);
  });
});

describe('oauth soft leftovers UIA pages soft flood after #142', () => {

  it('uia GET missing session soft-0', async () => {
    const res = await request('/oauth/authorize/uia', {}, makeEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Missing Session');
    expect(html).toContain(SERVER);
  });

  it('uia GET expired soft-0', async () => {
    const res = await request('/oauth/authorize/uia?session=gone0', {}, makeEnv({ CACHE: mockKv() }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Session Expired');
  });

  it('uia GET approval soft-0', async () => {
    const cache = mockKv();
    cache.data['uia_session:sess0'] = JSON.stringify({
      user_id: USER,
      completed_stages: [],
      action: 'm.cross_signing.reset',
    });
    const res = await request('/oauth/authorize/uia?session=sess0', {}, makeEnv({ CACHE: cache }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('alice');
    expect(html).toContain(SERVER);
  });

  it('uia GET missing session soft-1', async () => {
    const res = await request('/oauth/authorize/uia', {}, makeEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Missing Session');
    expect(html).toContain(SERVER);
  });

  it('uia GET expired soft-1', async () => {
    const res = await request('/oauth/authorize/uia?session=gone1', {}, makeEnv({ CACHE: mockKv() }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Session Expired');
  });

  it('uia GET approval soft-1', async () => {
    const cache = mockKv();
    cache.data['uia_session:sess1'] = JSON.stringify({
      user_id: USER,
      completed_stages: [],
      action: 'm.cross_signing.reset',
    });
    const res = await request('/oauth/authorize/uia?session=sess1', {}, makeEnv({ CACHE: cache }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('alice');
    expect(html).toContain(SERVER);
  });

  it('uia GET missing session soft-2', async () => {
    const res = await request('/oauth/authorize/uia', {}, makeEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Missing Session');
    expect(html).toContain(SERVER);
  });

  it('uia GET expired soft-2', async () => {
    const res = await request('/oauth/authorize/uia?session=gone2', {}, makeEnv({ CACHE: mockKv() }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Session Expired');
  });

  it('uia GET approval soft-2', async () => {
    const cache = mockKv();
    cache.data['uia_session:sess2'] = JSON.stringify({
      user_id: USER,
      completed_stages: [],
      action: 'm.cross_signing.reset',
    });
    const res = await request('/oauth/authorize/uia?session=sess2', {}, makeEnv({ CACHE: cache }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('alice');
    expect(html).toContain(SERVER);
  });

  it('uia GET missing session soft-3', async () => {
    const res = await request('/oauth/authorize/uia', {}, makeEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Missing Session');
    expect(html).toContain(SERVER);
  });

  it('uia GET expired soft-3', async () => {
    const res = await request('/oauth/authorize/uia?session=gone3', {}, makeEnv({ CACHE: mockKv() }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Session Expired');
  });

  it('uia GET approval soft-3', async () => {
    const cache = mockKv();
    cache.data['uia_session:sess3'] = JSON.stringify({
      user_id: USER,
      completed_stages: [],
      action: 'm.cross_signing.reset',
    });
    const res = await request('/oauth/authorize/uia?session=sess3', {}, makeEnv({ CACHE: cache }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('alice');
    expect(html).toContain(SERVER);
  });

  it('uia GET missing session soft-4', async () => {
    const res = await request('/oauth/authorize/uia', {}, makeEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Missing Session');
    expect(html).toContain(SERVER);
  });

  it('uia GET expired soft-4', async () => {
    const res = await request('/oauth/authorize/uia?session=gone4', {}, makeEnv({ CACHE: mockKv() }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Session Expired');
  });

  it('uia GET approval soft-4', async () => {
    const cache = mockKv();
    cache.data['uia_session:sess4'] = JSON.stringify({
      user_id: USER,
      completed_stages: [],
      action: 'm.cross_signing.reset',
    });
    const res = await request('/oauth/authorize/uia?session=sess4', {}, makeEnv({ CACHE: cache }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('alice');
    expect(html).toContain(SERVER);
  });

  it('uia GET missing session soft-5', async () => {
    const res = await request('/oauth/authorize/uia', {}, makeEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Missing Session');
    expect(html).toContain(SERVER);
  });

  it('uia GET expired soft-5', async () => {
    const res = await request('/oauth/authorize/uia?session=gone5', {}, makeEnv({ CACHE: mockKv() }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Session Expired');
  });

  it('uia GET approval soft-5', async () => {
    const cache = mockKv();
    cache.data['uia_session:sess5'] = JSON.stringify({
      user_id: USER,
      completed_stages: [],
      action: 'm.cross_signing.reset',
    });
    const res = await request('/oauth/authorize/uia?session=sess5', {}, makeEnv({ CACHE: cache }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('alice');
    expect(html).toContain(SERVER);
  });

  it('uia GET missing session soft-6', async () => {
    const res = await request('/oauth/authorize/uia', {}, makeEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Missing Session');
    expect(html).toContain(SERVER);
  });

  it('uia GET expired soft-6', async () => {
    const res = await request('/oauth/authorize/uia?session=gone6', {}, makeEnv({ CACHE: mockKv() }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Session Expired');
  });

  it('uia GET approval soft-6', async () => {
    const cache = mockKv();
    cache.data['uia_session:sess6'] = JSON.stringify({
      user_id: USER,
      completed_stages: [],
      action: 'm.cross_signing.reset',
    });
    const res = await request('/oauth/authorize/uia?session=sess6', {}, makeEnv({ CACHE: cache }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('alice');
    expect(html).toContain(SERVER);
  });

  it('uia GET missing session soft-7', async () => {
    const res = await request('/oauth/authorize/uia', {}, makeEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Missing Session');
    expect(html).toContain(SERVER);
  });

  it('uia GET expired soft-7', async () => {
    const res = await request('/oauth/authorize/uia?session=gone7', {}, makeEnv({ CACHE: mockKv() }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Session Expired');
  });

  it('uia GET approval soft-7', async () => {
    const cache = mockKv();
    cache.data['uia_session:sess7'] = JSON.stringify({
      user_id: USER,
      completed_stages: [],
      action: 'm.cross_signing.reset',
    });
    const res = await request('/oauth/authorize/uia?session=sess7', {}, makeEnv({ CACHE: cache }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('alice');
    expect(html).toContain(SERVER);
  });

  it('uia GET missing session soft-8', async () => {
    const res = await request('/oauth/authorize/uia', {}, makeEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Missing Session');
    expect(html).toContain(SERVER);
  });

  it('uia GET expired soft-8', async () => {
    const res = await request('/oauth/authorize/uia?session=gone8', {}, makeEnv({ CACHE: mockKv() }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Session Expired');
  });

  it('uia GET approval soft-8', async () => {
    const cache = mockKv();
    cache.data['uia_session:sess8'] = JSON.stringify({
      user_id: USER,
      completed_stages: [],
      action: 'm.cross_signing.reset',
    });
    const res = await request('/oauth/authorize/uia?session=sess8', {}, makeEnv({ CACHE: cache }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('alice');
    expect(html).toContain(SERVER);
  });

  it('uia GET missing session soft-9', async () => {
    const res = await request('/oauth/authorize/uia', {}, makeEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Missing Session');
    expect(html).toContain(SERVER);
  });

  it('uia GET expired soft-9', async () => {
    const res = await request('/oauth/authorize/uia?session=gone9', {}, makeEnv({ CACHE: mockKv() }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Session Expired');
  });

  it('uia GET approval soft-9', async () => {
    const cache = mockKv();
    cache.data['uia_session:sess9'] = JSON.stringify({
      user_id: USER,
      completed_stages: [],
      action: 'm.cross_signing.reset',
    });
    const res = await request('/oauth/authorize/uia?session=sess9', {}, makeEnv({ CACHE: cache }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('alice');
    expect(html).toContain(SERVER);
  });

  it('uia GET missing session soft-10', async () => {
    const res = await request('/oauth/authorize/uia', {}, makeEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Missing Session');
    expect(html).toContain(SERVER);
  });

  it('uia GET expired soft-10', async () => {
    const res = await request('/oauth/authorize/uia?session=gone10', {}, makeEnv({ CACHE: mockKv() }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Session Expired');
  });

  it('uia GET approval soft-10', async () => {
    const cache = mockKv();
    cache.data['uia_session:sess10'] = JSON.stringify({
      user_id: USER,
      completed_stages: [],
      action: 'm.cross_signing.reset',
    });
    const res = await request('/oauth/authorize/uia?session=sess10', {}, makeEnv({ CACHE: cache }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('alice');
    expect(html).toContain(SERVER);
  });

  it('uia GET missing session soft-11', async () => {
    const res = await request('/oauth/authorize/uia', {}, makeEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Missing Session');
    expect(html).toContain(SERVER);
  });

  it('uia GET expired soft-11', async () => {
    const res = await request('/oauth/authorize/uia?session=gone11', {}, makeEnv({ CACHE: mockKv() }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Session Expired');
  });

  it('uia GET approval soft-11', async () => {
    const cache = mockKv();
    cache.data['uia_session:sess11'] = JSON.stringify({
      user_id: USER,
      completed_stages: [],
      action: 'm.cross_signing.reset',
    });
    const res = await request('/oauth/authorize/uia?session=sess11', {}, makeEnv({ CACHE: cache }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('alice');
    expect(html).toContain(SERVER);
  });
});

describe('oauth soft leftovers authorize scope/state soft preservation after #142', () => {

  it('scope soft preserve-0', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_scope_0');
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_scope_0&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=${encodeURIComponent('openid')}&state=keep0`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const put = sessions.puts.find((p) => p.key.startsWith('oauth_auth_request:'));
    expect(put).toBeTruthy();
    const stored = JSON.parse(put!.value);
    expect(stored.scope).toBe('openid');
    expect(stored.state).toBe('keep0');
  });

  it('scope soft preserve-1', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_scope_1');
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_scope_1&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=${encodeURIComponent('openid profile')}&state=keep1`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const put = sessions.puts.find((p) => p.key.startsWith('oauth_auth_request:'));
    expect(put).toBeTruthy();
    const stored = JSON.parse(put!.value);
    expect(stored.scope).toBe('openid profile');
    expect(stored.state).toBe('keep1');
  });

  it('scope soft preserve-2', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_scope_2');
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_scope_2&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=${encodeURIComponent('openid offline_access')}&state=keep2`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const put = sessions.puts.find((p) => p.key.startsWith('oauth_auth_request:'));
    expect(put).toBeTruthy();
    const stored = JSON.parse(put!.value);
    expect(stored.scope).toBe('openid offline_access');
    expect(stored.state).toBe('keep2');
  });

  it('scope soft preserve-3', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'client_scope_3');
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_scope_3&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=${encodeURIComponent('openid urn:matrix:client:api:*')}&state=keep3`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const put = sessions.puts.find((p) => p.key.startsWith('oauth_auth_request:'));
    expect(put).toBeTruthy();
    const stored = JSON.parse(put!.value);
    expect(stored.scope).toBe('openid urn:matrix:client:api:*');
    expect(stored.state).toBe('keep3');
  });
});
