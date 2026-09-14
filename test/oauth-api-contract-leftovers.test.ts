/**
 * TOKENMAXX HEAVY leftovers after #145 — oauth API token/userinfo/PKCE contract deepen.
 * Orthogonal to oauth-api-soft-leftovers + oauth-failure-leftovers + oauth-api-route-leftovers.
 * Tests-only — Hono app.request() against src/api/oauth.ts. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { hashClientSecret } from '../src/api/oauth';
import { hashToken } from '../src/utils/crypto';

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
  const inserts: Array<{ sql: string; args: unknown[] }> = [];
  const deletes: Array<{ sql: string; args: unknown[] }> = [];
  return {
    users,
    tokensByHash,
    inserts,
    deletes,
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
            run: async () => {
              if (sql.trimStart().toUpperCase().startsWith('INSERT')) {
                inserts.push({ sql, args });
                if (sql.includes('INTO access_tokens')) {
                  const [, tokenHash, userId, deviceId] = args as [string, string, string, string | null];
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
    users: Map<string, { user_id: string; password_hash: string | null; is_deactivated?: number }>;
    tokensByHash: Map<string, { user_id: string; device_id: string | null; created_at?: number }>;
    inserts: Array<{ sql: string; args: unknown[] }>;
    deletes: Array<{ sql: string; args: unknown[] }>;
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

function putAuthCode(
  sessions: ReturnType<typeof mockKv>,
  code: string,
  patch: Record<string, unknown> = {}
) {
  sessions.data[`oauth_code:${code}`] = JSON.stringify({
    code,
    client_id: patch.client_id ?? 'client_contract',
    user_id: patch.user_id ?? USER,
    redirect_uri: patch.redirect_uri ?? REDIRECT,
    scope: patch.scope ?? 'openid',
    created_at: NOW,
    expires_at: NOW + 600_000,
    ...patch,
  });
}

function aliceMap() {
  return new Map([
    [USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, is_deactivated: 0, display_name: 'Alice', avatar_url: null as string | null }],
  ]);
}

describe('oauth contract leftovers method matrix after #145', () => {
  const posts = ['/oauth/register', '/oauth/token', '/oauth/revoke', '/oauth/introspect'];
  for (const path of posts) {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      it(`${method} ${path} → 404`, async () => {
        const res = await request(path, { method });
        expect(res.status).toBe(404);
      });
    }
  }
});
describe('oauth contract leftovers authorization_code success soft flood after #145', () => {
  it('token auth_code soft-0', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_tok_0');
    putAuthCode(sessions, 'code_0', {
      client_id: 'client_tok_0',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEV0',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_tok_0',
          code: 'code_0',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DEV0');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(String(body.scope)).toContain('openid');
    expect(sessions.data['oauth_code:code_0']).toBeUndefined();
    expect(sessions.deletes).toContain('oauth_code:code_0');
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token auth_code soft-1', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_tok_1');
    putAuthCode(sessions, 'code_1', {
      client_id: 'client_tok_1',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEV1',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_tok_1',
          code: 'code_1',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DEV1');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(String(body.scope)).toContain('openid');
    expect(sessions.data['oauth_code:code_1']).toBeUndefined();
    expect(sessions.deletes).toContain('oauth_code:code_1');
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token auth_code soft-2', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_tok_2');
    putAuthCode(sessions, 'code_2', {
      client_id: 'client_tok_2',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEV2',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_tok_2',
          code: 'code_2',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DEV2');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(String(body.scope)).toContain('openid');
    expect(sessions.data['oauth_code:code_2']).toBeUndefined();
    expect(sessions.deletes).toContain('oauth_code:code_2');
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token auth_code soft-3', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_tok_3');
    putAuthCode(sessions, 'code_3', {
      client_id: 'client_tok_3',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEV3',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_tok_3',
          code: 'code_3',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DEV3');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(String(body.scope)).toContain('openid');
    expect(sessions.data['oauth_code:code_3']).toBeUndefined();
    expect(sessions.deletes).toContain('oauth_code:code_3');
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token auth_code soft-4', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_tok_4');
    putAuthCode(sessions, 'code_4', {
      client_id: 'client_tok_4',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEV4',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_tok_4',
          code: 'code_4',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DEV4');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(String(body.scope)).toContain('openid');
    expect(sessions.data['oauth_code:code_4']).toBeUndefined();
    expect(sessions.deletes).toContain('oauth_code:code_4');
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token auth_code soft-5', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_tok_5');
    putAuthCode(sessions, 'code_5', {
      client_id: 'client_tok_5',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEV5',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_tok_5',
          code: 'code_5',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DEV5');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(String(body.scope)).toContain('openid');
    expect(sessions.data['oauth_code:code_5']).toBeUndefined();
    expect(sessions.deletes).toContain('oauth_code:code_5');
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token auth_code soft-6', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_tok_6');
    putAuthCode(sessions, 'code_6', {
      client_id: 'client_tok_6',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEV6',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_tok_6',
          code: 'code_6',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DEV6');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(String(body.scope)).toContain('openid');
    expect(sessions.data['oauth_code:code_6']).toBeUndefined();
    expect(sessions.deletes).toContain('oauth_code:code_6');
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token auth_code soft-7', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_tok_7');
    putAuthCode(sessions, 'code_7', {
      client_id: 'client_tok_7',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEV7',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_tok_7',
          code: 'code_7',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DEV7');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(String(body.scope)).toContain('openid');
    expect(sessions.data['oauth_code:code_7']).toBeUndefined();
    expect(sessions.deletes).toContain('oauth_code:code_7');
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token auth_code soft-8', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_tok_8');
    putAuthCode(sessions, 'code_8', {
      client_id: 'client_tok_8',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEV8',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_tok_8',
          code: 'code_8',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DEV8');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(String(body.scope)).toContain('openid');
    expect(sessions.data['oauth_code:code_8']).toBeUndefined();
    expect(sessions.deletes).toContain('oauth_code:code_8');
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token auth_code soft-9', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_tok_9');
    putAuthCode(sessions, 'code_9', {
      client_id: 'client_tok_9',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEV9',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_tok_9',
          code: 'code_9',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DEV9');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(String(body.scope)).toContain('openid');
    expect(sessions.data['oauth_code:code_9']).toBeUndefined();
    expect(sessions.deletes).toContain('oauth_code:code_9');
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token auth_code soft-10', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_tok_10');
    putAuthCode(sessions, 'code_10', {
      client_id: 'client_tok_10',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEV10',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_tok_10',
          code: 'code_10',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DEV10');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(String(body.scope)).toContain('openid');
    expect(sessions.data['oauth_code:code_10']).toBeUndefined();
    expect(sessions.deletes).toContain('oauth_code:code_10');
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token auth_code soft-11', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_tok_11');
    putAuthCode(sessions, 'code_11', {
      client_id: 'client_tok_11',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEV11',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_tok_11',
          code: 'code_11',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DEV11');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(String(body.scope)).toContain('openid');
    expect(sessions.data['oauth_code:code_11']).toBeUndefined();
    expect(sessions.deletes).toContain('oauth_code:code_11');
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token auth_code soft-12', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_tok_12');
    putAuthCode(sessions, 'code_12', {
      client_id: 'client_tok_12',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEV12',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_tok_12',
          code: 'code_12',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DEV12');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(String(body.scope)).toContain('openid');
    expect(sessions.data['oauth_code:code_12']).toBeUndefined();
    expect(sessions.deletes).toContain('oauth_code:code_12');
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token auth_code soft-13', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_tok_13');
    putAuthCode(sessions, 'code_13', {
      client_id: 'client_tok_13',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEV13',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_tok_13',
          code: 'code_13',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DEV13');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(String(body.scope)).toContain('openid');
    expect(sessions.data['oauth_code:code_13']).toBeUndefined();
    expect(sessions.deletes).toContain('oauth_code:code_13');
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token auth_code soft-14', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_tok_14');
    putAuthCode(sessions, 'code_14', {
      client_id: 'client_tok_14',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEV14',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_tok_14',
          code: 'code_14',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DEV14');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(String(body.scope)).toContain('openid');
    expect(sessions.data['oauth_code:code_14']).toBeUndefined();
    expect(sessions.deletes).toContain('oauth_code:code_14');
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token auth_code soft-15', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_tok_15');
    putAuthCode(sessions, 'code_15', {
      client_id: 'client_tok_15',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEV15',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_tok_15',
          code: 'code_15',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DEV15');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(String(body.scope)).toContain('openid');
    expect(sessions.data['oauth_code:code_15']).toBeUndefined();
    expect(sessions.deletes).toContain('oauth_code:code_15');
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token auth_code soft-16', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_tok_16');
    putAuthCode(sessions, 'code_16', {
      client_id: 'client_tok_16',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEV16',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_tok_16',
          code: 'code_16',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DEV16');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(String(body.scope)).toContain('openid');
    expect(sessions.data['oauth_code:code_16']).toBeUndefined();
    expect(sessions.deletes).toContain('oauth_code:code_16');
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token auth_code soft-17', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_tok_17');
    putAuthCode(sessions, 'code_17', {
      client_id: 'client_tok_17',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEV17',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_tok_17',
          code: 'code_17',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.user_id).toBe(USER);
    expect(body.device_id).toBe('DEV17');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(String(body.scope)).toContain('openid');
    expect(sessions.data['oauth_code:code_17']).toBeUndefined();
    expect(sessions.deletes).toContain('oauth_code:code_17');
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
});
describe('oauth contract leftovers PKCE S256 soft flood after #145', () => {
  it('token PKCE S256 soft-0', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_pkce_0');
    const verifier = 'verifier_contract_0_aaaaaaaaaaaaaaaaaaaaaaaa';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    putAuthCode(sessions, 'pkce_0', {
      client_id: 'client_pkce_0',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'client_pkce_0',
          code: 'pkce_0',
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        }).toString(),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
  });
  it('token PKCE S256 soft-1', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_pkce_1');
    const verifier = 'verifier_contract_1_aaaaaaaaaaaaaaaaaaaaaaaa';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    putAuthCode(sessions, 'pkce_1', {
      client_id: 'client_pkce_1',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'client_pkce_1',
          code: 'pkce_1',
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        }).toString(),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
  });
  it('token PKCE S256 soft-2', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_pkce_2');
    const verifier = 'verifier_contract_2_aaaaaaaaaaaaaaaaaaaaaaaa';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    putAuthCode(sessions, 'pkce_2', {
      client_id: 'client_pkce_2',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'client_pkce_2',
          code: 'pkce_2',
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        }).toString(),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
  });
  it('token PKCE S256 soft-3', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_pkce_3');
    const verifier = 'verifier_contract_3_aaaaaaaaaaaaaaaaaaaaaaaa';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    putAuthCode(sessions, 'pkce_3', {
      client_id: 'client_pkce_3',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'client_pkce_3',
          code: 'pkce_3',
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        }).toString(),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
  });
  it('token PKCE S256 soft-4', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_pkce_4');
    const verifier = 'verifier_contract_4_aaaaaaaaaaaaaaaaaaaaaaaa';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    putAuthCode(sessions, 'pkce_4', {
      client_id: 'client_pkce_4',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'client_pkce_4',
          code: 'pkce_4',
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        }).toString(),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
  });
  it('token PKCE S256 soft-5', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_pkce_5');
    const verifier = 'verifier_contract_5_aaaaaaaaaaaaaaaaaaaaaaaa';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    putAuthCode(sessions, 'pkce_5', {
      client_id: 'client_pkce_5',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'client_pkce_5',
          code: 'pkce_5',
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        }).toString(),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
  });
  it('token PKCE S256 soft-6', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_pkce_6');
    const verifier = 'verifier_contract_6_aaaaaaaaaaaaaaaaaaaaaaaa';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    putAuthCode(sessions, 'pkce_6', {
      client_id: 'client_pkce_6',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'client_pkce_6',
          code: 'pkce_6',
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        }).toString(),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
  });
  it('token PKCE S256 soft-7', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_pkce_7');
    const verifier = 'verifier_contract_7_aaaaaaaaaaaaaaaaaaaaaaaa';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    putAuthCode(sessions, 'pkce_7', {
      client_id: 'client_pkce_7',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'client_pkce_7',
          code: 'pkce_7',
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        }).toString(),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
  });
  it('token PKCE S256 soft-8', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_pkce_8');
    const verifier = 'verifier_contract_8_aaaaaaaaaaaaaaaaaaaaaaaa';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    putAuthCode(sessions, 'pkce_8', {
      client_id: 'client_pkce_8',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'client_pkce_8',
          code: 'pkce_8',
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        }).toString(),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
  });
  it('token PKCE S256 soft-9', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_pkce_9');
    const verifier = 'verifier_contract_9_aaaaaaaaaaaaaaaaaaaaaaaa';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    putAuthCode(sessions, 'pkce_9', {
      client_id: 'client_pkce_9',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'client_pkce_9',
          code: 'pkce_9',
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        }).toString(),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
  });
  it('token PKCE S256 soft-10', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_pkce_10');
    const verifier = 'verifier_contract_10_aaaaaaaaaaaaaaaaaaaaaaaa';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    putAuthCode(sessions, 'pkce_10', {
      client_id: 'client_pkce_10',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'client_pkce_10',
          code: 'pkce_10',
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        }).toString(),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
  });
  it('token PKCE S256 soft-11', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_pkce_11');
    const verifier = 'verifier_contract_11_aaaaaaaaaaaaaaaaaaaaaaaa';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    putAuthCode(sessions, 'pkce_11', {
      client_id: 'client_pkce_11',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'client_pkce_11',
          code: 'pkce_11',
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        }).toString(),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
  });
});
describe('oauth contract leftovers refresh_token grant soft flood after #145', () => {
  it('token refresh soft-0', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ref_0');
    const oldRefresh = 'refresh_old_0';
    sessions.data[`oauth_refresh:${oldRefresh}`] = JSON.stringify({
      token_id: 'tid0',
      access_token_hash: 'ath0',
      refresh_token_hash: 'rth0',
      client_id: 'client_ref_0',
      user_id: USER,
      device_id: 'RDEV0',
      scope: 'openid',
      created_at: NOW - 1000,
      expires_at: NOW + 86_400_000,
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: 'client_ref_0',
          refresh_token: oldRefresh,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.scope).toBe('openid');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.refresh_token).not.toBe(oldRefresh);
    expect(sessions.deletes).toContain(`oauth_refresh:${oldRefresh}`);
    expect(sessions.data[`oauth_refresh:${oldRefresh}`]).toBeUndefined();
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token refresh soft-1', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ref_1');
    const oldRefresh = 'refresh_old_1';
    sessions.data[`oauth_refresh:${oldRefresh}`] = JSON.stringify({
      token_id: 'tid1',
      access_token_hash: 'ath1',
      refresh_token_hash: 'rth1',
      client_id: 'client_ref_1',
      user_id: USER,
      device_id: 'RDEV1',
      scope: 'openid',
      created_at: NOW - 1000,
      expires_at: NOW + 86_400_000,
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: 'client_ref_1',
          refresh_token: oldRefresh,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.scope).toBe('openid');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.refresh_token).not.toBe(oldRefresh);
    expect(sessions.deletes).toContain(`oauth_refresh:${oldRefresh}`);
    expect(sessions.data[`oauth_refresh:${oldRefresh}`]).toBeUndefined();
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token refresh soft-2', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ref_2');
    const oldRefresh = 'refresh_old_2';
    sessions.data[`oauth_refresh:${oldRefresh}`] = JSON.stringify({
      token_id: 'tid2',
      access_token_hash: 'ath2',
      refresh_token_hash: 'rth2',
      client_id: 'client_ref_2',
      user_id: USER,
      device_id: 'RDEV2',
      scope: 'openid',
      created_at: NOW - 1000,
      expires_at: NOW + 86_400_000,
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: 'client_ref_2',
          refresh_token: oldRefresh,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.scope).toBe('openid');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.refresh_token).not.toBe(oldRefresh);
    expect(sessions.deletes).toContain(`oauth_refresh:${oldRefresh}`);
    expect(sessions.data[`oauth_refresh:${oldRefresh}`]).toBeUndefined();
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token refresh soft-3', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ref_3');
    const oldRefresh = 'refresh_old_3';
    sessions.data[`oauth_refresh:${oldRefresh}`] = JSON.stringify({
      token_id: 'tid3',
      access_token_hash: 'ath3',
      refresh_token_hash: 'rth3',
      client_id: 'client_ref_3',
      user_id: USER,
      device_id: 'RDEV3',
      scope: 'openid',
      created_at: NOW - 1000,
      expires_at: NOW + 86_400_000,
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: 'client_ref_3',
          refresh_token: oldRefresh,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.scope).toBe('openid');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.refresh_token).not.toBe(oldRefresh);
    expect(sessions.deletes).toContain(`oauth_refresh:${oldRefresh}`);
    expect(sessions.data[`oauth_refresh:${oldRefresh}`]).toBeUndefined();
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token refresh soft-4', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ref_4');
    const oldRefresh = 'refresh_old_4';
    sessions.data[`oauth_refresh:${oldRefresh}`] = JSON.stringify({
      token_id: 'tid4',
      access_token_hash: 'ath4',
      refresh_token_hash: 'rth4',
      client_id: 'client_ref_4',
      user_id: USER,
      device_id: 'RDEV4',
      scope: 'openid',
      created_at: NOW - 1000,
      expires_at: NOW + 86_400_000,
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: 'client_ref_4',
          refresh_token: oldRefresh,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.scope).toBe('openid');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.refresh_token).not.toBe(oldRefresh);
    expect(sessions.deletes).toContain(`oauth_refresh:${oldRefresh}`);
    expect(sessions.data[`oauth_refresh:${oldRefresh}`]).toBeUndefined();
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token refresh soft-5', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ref_5');
    const oldRefresh = 'refresh_old_5';
    sessions.data[`oauth_refresh:${oldRefresh}`] = JSON.stringify({
      token_id: 'tid5',
      access_token_hash: 'ath5',
      refresh_token_hash: 'rth5',
      client_id: 'client_ref_5',
      user_id: USER,
      device_id: 'RDEV5',
      scope: 'openid',
      created_at: NOW - 1000,
      expires_at: NOW + 86_400_000,
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: 'client_ref_5',
          refresh_token: oldRefresh,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.scope).toBe('openid');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.refresh_token).not.toBe(oldRefresh);
    expect(sessions.deletes).toContain(`oauth_refresh:${oldRefresh}`);
    expect(sessions.data[`oauth_refresh:${oldRefresh}`]).toBeUndefined();
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token refresh soft-6', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ref_6');
    const oldRefresh = 'refresh_old_6';
    sessions.data[`oauth_refresh:${oldRefresh}`] = JSON.stringify({
      token_id: 'tid6',
      access_token_hash: 'ath6',
      refresh_token_hash: 'rth6',
      client_id: 'client_ref_6',
      user_id: USER,
      device_id: 'RDEV6',
      scope: 'openid',
      created_at: NOW - 1000,
      expires_at: NOW + 86_400_000,
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: 'client_ref_6',
          refresh_token: oldRefresh,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.scope).toBe('openid');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.refresh_token).not.toBe(oldRefresh);
    expect(sessions.deletes).toContain(`oauth_refresh:${oldRefresh}`);
    expect(sessions.data[`oauth_refresh:${oldRefresh}`]).toBeUndefined();
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token refresh soft-7', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ref_7');
    const oldRefresh = 'refresh_old_7';
    sessions.data[`oauth_refresh:${oldRefresh}`] = JSON.stringify({
      token_id: 'tid7',
      access_token_hash: 'ath7',
      refresh_token_hash: 'rth7',
      client_id: 'client_ref_7',
      user_id: USER,
      device_id: 'RDEV7',
      scope: 'openid',
      created_at: NOW - 1000,
      expires_at: NOW + 86_400_000,
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: 'client_ref_7',
          refresh_token: oldRefresh,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.scope).toBe('openid');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.refresh_token).not.toBe(oldRefresh);
    expect(sessions.deletes).toContain(`oauth_refresh:${oldRefresh}`);
    expect(sessions.data[`oauth_refresh:${oldRefresh}`]).toBeUndefined();
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token refresh soft-8', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ref_8');
    const oldRefresh = 'refresh_old_8';
    sessions.data[`oauth_refresh:${oldRefresh}`] = JSON.stringify({
      token_id: 'tid8',
      access_token_hash: 'ath8',
      refresh_token_hash: 'rth8',
      client_id: 'client_ref_8',
      user_id: USER,
      device_id: 'RDEV8',
      scope: 'openid',
      created_at: NOW - 1000,
      expires_at: NOW + 86_400_000,
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: 'client_ref_8',
          refresh_token: oldRefresh,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.scope).toBe('openid');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.refresh_token).not.toBe(oldRefresh);
    expect(sessions.deletes).toContain(`oauth_refresh:${oldRefresh}`);
    expect(sessions.data[`oauth_refresh:${oldRefresh}`]).toBeUndefined();
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token refresh soft-9', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ref_9');
    const oldRefresh = 'refresh_old_9';
    sessions.data[`oauth_refresh:${oldRefresh}`] = JSON.stringify({
      token_id: 'tid9',
      access_token_hash: 'ath9',
      refresh_token_hash: 'rth9',
      client_id: 'client_ref_9',
      user_id: USER,
      device_id: 'RDEV9',
      scope: 'openid',
      created_at: NOW - 1000,
      expires_at: NOW + 86_400_000,
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: 'client_ref_9',
          refresh_token: oldRefresh,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.scope).toBe('openid');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.refresh_token).not.toBe(oldRefresh);
    expect(sessions.deletes).toContain(`oauth_refresh:${oldRefresh}`);
    expect(sessions.data[`oauth_refresh:${oldRefresh}`]).toBeUndefined();
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token refresh soft-10', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ref_10');
    const oldRefresh = 'refresh_old_10';
    sessions.data[`oauth_refresh:${oldRefresh}`] = JSON.stringify({
      token_id: 'tid10',
      access_token_hash: 'ath10',
      refresh_token_hash: 'rth10',
      client_id: 'client_ref_10',
      user_id: USER,
      device_id: 'RDEV10',
      scope: 'openid',
      created_at: NOW - 1000,
      expires_at: NOW + 86_400_000,
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: 'client_ref_10',
          refresh_token: oldRefresh,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.scope).toBe('openid');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.refresh_token).not.toBe(oldRefresh);
    expect(sessions.deletes).toContain(`oauth_refresh:${oldRefresh}`);
    expect(sessions.data[`oauth_refresh:${oldRefresh}`]).toBeUndefined();
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token refresh soft-11', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ref_11');
    const oldRefresh = 'refresh_old_11';
    sessions.data[`oauth_refresh:${oldRefresh}`] = JSON.stringify({
      token_id: 'tid11',
      access_token_hash: 'ath11',
      refresh_token_hash: 'rth11',
      client_id: 'client_ref_11',
      user_id: USER,
      device_id: 'RDEV11',
      scope: 'openid',
      created_at: NOW - 1000,
      expires_at: NOW + 86_400_000,
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: 'client_ref_11',
          refresh_token: oldRefresh,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.scope).toBe('openid');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.refresh_token).not.toBe(oldRefresh);
    expect(sessions.deletes).toContain(`oauth_refresh:${oldRefresh}`);
    expect(sessions.data[`oauth_refresh:${oldRefresh}`]).toBeUndefined();
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token refresh soft-12', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ref_12');
    const oldRefresh = 'refresh_old_12';
    sessions.data[`oauth_refresh:${oldRefresh}`] = JSON.stringify({
      token_id: 'tid12',
      access_token_hash: 'ath12',
      refresh_token_hash: 'rth12',
      client_id: 'client_ref_12',
      user_id: USER,
      device_id: 'RDEV12',
      scope: 'openid',
      created_at: NOW - 1000,
      expires_at: NOW + 86_400_000,
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: 'client_ref_12',
          refresh_token: oldRefresh,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.scope).toBe('openid');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.refresh_token).not.toBe(oldRefresh);
    expect(sessions.deletes).toContain(`oauth_refresh:${oldRefresh}`);
    expect(sessions.data[`oauth_refresh:${oldRefresh}`]).toBeUndefined();
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token refresh soft-13', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ref_13');
    const oldRefresh = 'refresh_old_13';
    sessions.data[`oauth_refresh:${oldRefresh}`] = JSON.stringify({
      token_id: 'tid13',
      access_token_hash: 'ath13',
      refresh_token_hash: 'rth13',
      client_id: 'client_ref_13',
      user_id: USER,
      device_id: 'RDEV13',
      scope: 'openid',
      created_at: NOW - 1000,
      expires_at: NOW + 86_400_000,
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: 'client_ref_13',
          refresh_token: oldRefresh,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.scope).toBe('openid');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.refresh_token).not.toBe(oldRefresh);
    expect(sessions.deletes).toContain(`oauth_refresh:${oldRefresh}`);
    expect(sessions.data[`oauth_refresh:${oldRefresh}`]).toBeUndefined();
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
  it('token refresh soft-14', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ref_14');
    const oldRefresh = 'refresh_old_14';
    sessions.data[`oauth_refresh:${oldRefresh}`] = JSON.stringify({
      token_id: 'tid14',
      access_token_hash: 'ath14',
      refresh_token_hash: 'rth14',
      client_id: 'client_ref_14',
      user_id: USER,
      device_id: 'RDEV14',
      scope: 'openid',
      created_at: NOW - 1000,
      expires_at: NOW + 86_400_000,
    });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: 'client_ref_14',
          refresh_token: oldRefresh,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(86400);
    expect(body.scope).toBe('openid');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.refresh_token).not.toBe(oldRefresh);
    expect(sessions.deletes).toContain(`oauth_refresh:${oldRefresh}`);
    expect(sessions.data[`oauth_refresh:${oldRefresh}`]).toBeUndefined();
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_refresh:') && p.options?.expirationTtl === 30 * 24 * 60 * 60)).toBe(true);
  });
});
describe('oauth contract leftovers userinfo soft flood after #145', () => {
  it('userinfo GET soft-0', async () => {
    const token = 'userinfo_tok_0';
    const tokenHash = await hashToken(token);
    const db = createOAuthDb({
      users: new Map([
        [USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, display_name: 'Alice Soft 0', avatar_url: 'mxc://example.com/a0' }],
      ]),
      tokensByHash: new Map([[tokenHash, { user_id: USER, device_id: 'U0', created_at: NOW }]]),
    });
    const res = await request(
      '/oauth/userinfo',
      { headers: { Authorization: `Bearer ${token}` } },
      makeEnv({ DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.sub).toBe(USER);
  });

  it('userinfo POST soft-0', async () => {
    const token = 'userinfo_post_0';
    const tokenHash = await hashToken(token);
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, display_name: 'Alice' }]]),
      tokensByHash: new Map([[tokenHash, { user_id: USER, device_id: 'UP0', created_at: NOW }]]),
    });
    const res = await request(
      '/oauth/userinfo',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' },
      makeEnv({ DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.sub).toBe(USER);
  });
  it('userinfo GET soft-1', async () => {
    const token = 'userinfo_tok_1';
    const tokenHash = await hashToken(token);
    const db = createOAuthDb({
      users: new Map([
        [USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, display_name: 'Alice Soft 1', avatar_url: 'mxc://example.com/a1' }],
      ]),
      tokensByHash: new Map([[tokenHash, { user_id: USER, device_id: 'U1', created_at: NOW }]]),
    });
    const res = await request(
      '/oauth/userinfo',
      { headers: { Authorization: `Bearer ${token}` } },
      makeEnv({ DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.sub).toBe(USER);
  });

  it('userinfo POST soft-1', async () => {
    const token = 'userinfo_post_1';
    const tokenHash = await hashToken(token);
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, display_name: 'Alice' }]]),
      tokensByHash: new Map([[tokenHash, { user_id: USER, device_id: 'UP1', created_at: NOW }]]),
    });
    const res = await request(
      '/oauth/userinfo',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' },
      makeEnv({ DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.sub).toBe(USER);
  });
  it('userinfo GET soft-2', async () => {
    const token = 'userinfo_tok_2';
    const tokenHash = await hashToken(token);
    const db = createOAuthDb({
      users: new Map([
        [USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, display_name: 'Alice Soft 2', avatar_url: 'mxc://example.com/a2' }],
      ]),
      tokensByHash: new Map([[tokenHash, { user_id: USER, device_id: 'U2', created_at: NOW }]]),
    });
    const res = await request(
      '/oauth/userinfo',
      { headers: { Authorization: `Bearer ${token}` } },
      makeEnv({ DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.sub).toBe(USER);
  });

  it('userinfo POST soft-2', async () => {
    const token = 'userinfo_post_2';
    const tokenHash = await hashToken(token);
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, display_name: 'Alice' }]]),
      tokensByHash: new Map([[tokenHash, { user_id: USER, device_id: 'UP2', created_at: NOW }]]),
    });
    const res = await request(
      '/oauth/userinfo',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' },
      makeEnv({ DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.sub).toBe(USER);
  });
  it('userinfo GET soft-3', async () => {
    const token = 'userinfo_tok_3';
    const tokenHash = await hashToken(token);
    const db = createOAuthDb({
      users: new Map([
        [USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, display_name: 'Alice Soft 3', avatar_url: 'mxc://example.com/a3' }],
      ]),
      tokensByHash: new Map([[tokenHash, { user_id: USER, device_id: 'U3', created_at: NOW }]]),
    });
    const res = await request(
      '/oauth/userinfo',
      { headers: { Authorization: `Bearer ${token}` } },
      makeEnv({ DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.sub).toBe(USER);
  });

  it('userinfo POST soft-3', async () => {
    const token = 'userinfo_post_3';
    const tokenHash = await hashToken(token);
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, display_name: 'Alice' }]]),
      tokensByHash: new Map([[tokenHash, { user_id: USER, device_id: 'UP3', created_at: NOW }]]),
    });
    const res = await request(
      '/oauth/userinfo',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' },
      makeEnv({ DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.sub).toBe(USER);
  });
  it('userinfo GET soft-4', async () => {
    const token = 'userinfo_tok_4';
    const tokenHash = await hashToken(token);
    const db = createOAuthDb({
      users: new Map([
        [USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, display_name: 'Alice Soft 4', avatar_url: 'mxc://example.com/a4' }],
      ]),
      tokensByHash: new Map([[tokenHash, { user_id: USER, device_id: 'U4', created_at: NOW }]]),
    });
    const res = await request(
      '/oauth/userinfo',
      { headers: { Authorization: `Bearer ${token}` } },
      makeEnv({ DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.sub).toBe(USER);
  });

  it('userinfo POST soft-4', async () => {
    const token = 'userinfo_post_4';
    const tokenHash = await hashToken(token);
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, display_name: 'Alice' }]]),
      tokensByHash: new Map([[tokenHash, { user_id: USER, device_id: 'UP4', created_at: NOW }]]),
    });
    const res = await request(
      '/oauth/userinfo',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' },
      makeEnv({ DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.sub).toBe(USER);
  });
  it('userinfo GET soft-5', async () => {
    const token = 'userinfo_tok_5';
    const tokenHash = await hashToken(token);
    const db = createOAuthDb({
      users: new Map([
        [USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, display_name: 'Alice Soft 5', avatar_url: 'mxc://example.com/a5' }],
      ]),
      tokensByHash: new Map([[tokenHash, { user_id: USER, device_id: 'U5', created_at: NOW }]]),
    });
    const res = await request(
      '/oauth/userinfo',
      { headers: { Authorization: `Bearer ${token}` } },
      makeEnv({ DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.sub).toBe(USER);
  });

  it('userinfo POST soft-5', async () => {
    const token = 'userinfo_post_5';
    const tokenHash = await hashToken(token);
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, display_name: 'Alice' }]]),
      tokensByHash: new Map([[tokenHash, { user_id: USER, device_id: 'UP5', created_at: NOW }]]),
    });
    const res = await request(
      '/oauth/userinfo',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' },
      makeEnv({ DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.sub).toBe(USER);
  });
  it('userinfo GET soft-6', async () => {
    const token = 'userinfo_tok_6';
    const tokenHash = await hashToken(token);
    const db = createOAuthDb({
      users: new Map([
        [USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, display_name: 'Alice Soft 6', avatar_url: 'mxc://example.com/a6' }],
      ]),
      tokensByHash: new Map([[tokenHash, { user_id: USER, device_id: 'U6', created_at: NOW }]]),
    });
    const res = await request(
      '/oauth/userinfo',
      { headers: { Authorization: `Bearer ${token}` } },
      makeEnv({ DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.sub).toBe(USER);
  });

  it('userinfo POST soft-6', async () => {
    const token = 'userinfo_post_6';
    const tokenHash = await hashToken(token);
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, display_name: 'Alice' }]]),
      tokensByHash: new Map([[tokenHash, { user_id: USER, device_id: 'UP6', created_at: NOW }]]),
    });
    const res = await request(
      '/oauth/userinfo',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' },
      makeEnv({ DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.sub).toBe(USER);
  });
  it('userinfo GET soft-7', async () => {
    const token = 'userinfo_tok_7';
    const tokenHash = await hashToken(token);
    const db = createOAuthDb({
      users: new Map([
        [USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, display_name: 'Alice Soft 7', avatar_url: 'mxc://example.com/a7' }],
      ]),
      tokensByHash: new Map([[tokenHash, { user_id: USER, device_id: 'U7', created_at: NOW }]]),
    });
    const res = await request(
      '/oauth/userinfo',
      { headers: { Authorization: `Bearer ${token}` } },
      makeEnv({ DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.sub).toBe(USER);
  });

  it('userinfo POST soft-7', async () => {
    const token = 'userinfo_post_7';
    const tokenHash = await hashToken(token);
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, display_name: 'Alice' }]]),
      tokensByHash: new Map([[tokenHash, { user_id: USER, device_id: 'UP7', created_at: NOW }]]),
    });
    const res = await request(
      '/oauth/userinfo',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' },
      makeEnv({ DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.sub).toBe(USER);
  });
  it('userinfo GET soft-8', async () => {
    const token = 'userinfo_tok_8';
    const tokenHash = await hashToken(token);
    const db = createOAuthDb({
      users: new Map([
        [USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, display_name: 'Alice Soft 8', avatar_url: 'mxc://example.com/a8' }],
      ]),
      tokensByHash: new Map([[tokenHash, { user_id: USER, device_id: 'U8', created_at: NOW }]]),
    });
    const res = await request(
      '/oauth/userinfo',
      { headers: { Authorization: `Bearer ${token}` } },
      makeEnv({ DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.sub).toBe(USER);
  });

  it('userinfo POST soft-8', async () => {
    const token = 'userinfo_post_8';
    const tokenHash = await hashToken(token);
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, display_name: 'Alice' }]]),
      tokensByHash: new Map([[tokenHash, { user_id: USER, device_id: 'UP8', created_at: NOW }]]),
    });
    const res = await request(
      '/oauth/userinfo',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' },
      makeEnv({ DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.sub).toBe(USER);
  });
  it('userinfo GET soft-9', async () => {
    const token = 'userinfo_tok_9';
    const tokenHash = await hashToken(token);
    const db = createOAuthDb({
      users: new Map([
        [USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, display_name: 'Alice Soft 9', avatar_url: 'mxc://example.com/a9' }],
      ]),
      tokensByHash: new Map([[tokenHash, { user_id: USER, device_id: 'U9', created_at: NOW }]]),
    });
    const res = await request(
      '/oauth/userinfo',
      { headers: { Authorization: `Bearer ${token}` } },
      makeEnv({ DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.sub).toBe(USER);
  });

  it('userinfo POST soft-9', async () => {
    const token = 'userinfo_post_9';
    const tokenHash = await hashToken(token);
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, display_name: 'Alice' }]]),
      tokensByHash: new Map([[tokenHash, { user_id: USER, device_id: 'UP9', created_at: NOW }]]),
    });
    const res = await request(
      '/oauth/userinfo',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' },
      makeEnv({ DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.sub).toBe(USER);
  });
  it('userinfo GET soft-10', async () => {
    const token = 'userinfo_tok_10';
    const tokenHash = await hashToken(token);
    const db = createOAuthDb({
      users: new Map([
        [USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, display_name: 'Alice Soft 10', avatar_url: 'mxc://example.com/a10' }],
      ]),
      tokensByHash: new Map([[tokenHash, { user_id: USER, device_id: 'U10', created_at: NOW }]]),
    });
    const res = await request(
      '/oauth/userinfo',
      { headers: { Authorization: `Bearer ${token}` } },
      makeEnv({ DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.sub).toBe(USER);
  });

  it('userinfo POST soft-10', async () => {
    const token = 'userinfo_post_10';
    const tokenHash = await hashToken(token);
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, display_name: 'Alice' }]]),
      tokensByHash: new Map([[tokenHash, { user_id: USER, device_id: 'UP10', created_at: NOW }]]),
    });
    const res = await request(
      '/oauth/userinfo',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' },
      makeEnv({ DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.sub).toBe(USER);
  });
  it('userinfo GET soft-11', async () => {
    const token = 'userinfo_tok_11';
    const tokenHash = await hashToken(token);
    const db = createOAuthDb({
      users: new Map([
        [USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, display_name: 'Alice Soft 11', avatar_url: 'mxc://example.com/a11' }],
      ]),
      tokensByHash: new Map([[tokenHash, { user_id: USER, device_id: 'U11', created_at: NOW }]]),
    });
    const res = await request(
      '/oauth/userinfo',
      { headers: { Authorization: `Bearer ${token}` } },
      makeEnv({ DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.sub).toBe(USER);
  });

  it('userinfo POST soft-11', async () => {
    const token = 'userinfo_post_11';
    const tokenHash = await hashToken(token);
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: `mockok:${STRONG_PW}`, display_name: 'Alice' }]]),
      tokensByHash: new Map([[tokenHash, { user_id: USER, device_id: 'UP11', created_at: NOW }]]),
    });
    const res = await request(
      '/oauth/userinfo',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' },
      makeEnv({ DB: db })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.sub).toBe(USER);
  });
});
describe('oauth contract leftovers authorize HTML escape soft flood after #145', () => {
  it('authorize HTML escape soft-0', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const name = '<script>alert(1)</script>';
    seedClient(cache, 'client_xss_0', { client_name: name });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_xss_0&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s0`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script>');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });
  it('authorize HTML escape soft-1', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const name = 'Name & Co';
    seedClient(cache, 'client_xss_1', { client_name: name });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_xss_1&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s1`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script>');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });
  it('authorize HTML escape soft-2', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const name = 'A"B';
    seedClient(cache, 'client_xss_2', { client_name: name });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_xss_2&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s2`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script>');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });
  it('authorize HTML escape soft-3', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const name = "A'B";
    seedClient(cache, 'client_xss_3', { client_name: name });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_xss_3&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s3`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script>');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });
  it('authorize HTML escape soft-4', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const name = '<<>>';
    seedClient(cache, 'client_xss_4', { client_name: name });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_xss_4&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s4`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script>');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });
  it('authorize HTML escape soft-5', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const name = 'foo&bar';
    seedClient(cache, 'client_xss_5', { client_name: name });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_xss_5&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s5`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script>');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });
  it('authorize HTML escape soft-6', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const name = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    seedClient(cache, 'client_xss_6', { client_name: name });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_xss_6&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s6`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script>');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });
  it('authorize HTML escape soft-7', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const name = 'Client <b>Bold</b>';
    seedClient(cache, 'client_xss_7', { client_name: name });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_xss_7&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s7`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script>');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });
  it('authorize HTML escape soft-8', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const name = '100% pure';
    seedClient(cache, 'client_xss_8', { client_name: name });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_xss_8&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s8`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script>');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });
  it('authorize HTML escape soft-9', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const name = 'a/b\\\\c';
    seedClient(cache, 'client_xss_9', { client_name: name });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_xss_9&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s9`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script>');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });
  it('authorize HTML escape soft-10', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const name = 'emoji party';
    seedClient(cache, 'client_xss_10', { client_name: name });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_xss_10&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s10`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script>');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });
  it('authorize HTML escape soft-11', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const name = 'Name newline';
    seedClient(cache, 'client_xss_11', { client_name: name });
    const res = await request(
      `/oauth/authorize?response_type=code&client_id=client_xss_11&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s11`,
      {},
      makeEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script>');
    expect(html).toContain(SERVER);
    expect(sessions.puts.some((p) => p.key.startsWith('oauth_auth_request:') && p.options?.expirationTtl === 600)).toBe(true);
  });
});
describe('oauth contract leftovers token content-type soft flood after #145', () => {
  it('token JSON CT soft-0', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ctj_0');
    putAuthCode(sessions, 'ctj_0', { client_id: 'client_ctj_0' });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_ctj_0',
          code: 'ctj_0',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
  });

  it('token form CT soft-0', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ctf_0');
    putAuthCode(sessions, 'ctf_0', { client_id: 'client_ctf_0' });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'client_ctf_0',
          code: 'ctf_0',
          redirect_uri: REDIRECT,
        }).toString(),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
  });
  it('token JSON CT soft-1', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ctj_1');
    putAuthCode(sessions, 'ctj_1', { client_id: 'client_ctj_1' });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_ctj_1',
          code: 'ctj_1',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
  });

  it('token form CT soft-1', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ctf_1');
    putAuthCode(sessions, 'ctf_1', { client_id: 'client_ctf_1' });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'client_ctf_1',
          code: 'ctf_1',
          redirect_uri: REDIRECT,
        }).toString(),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
  });
  it('token JSON CT soft-2', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ctj_2');
    putAuthCode(sessions, 'ctj_2', { client_id: 'client_ctj_2' });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_ctj_2',
          code: 'ctj_2',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
  });

  it('token form CT soft-2', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ctf_2');
    putAuthCode(sessions, 'ctf_2', { client_id: 'client_ctf_2' });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'client_ctf_2',
          code: 'ctf_2',
          redirect_uri: REDIRECT,
        }).toString(),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
  });
  it('token JSON CT soft-3', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ctj_3');
    putAuthCode(sessions, 'ctj_3', { client_id: 'client_ctj_3' });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_ctj_3',
          code: 'ctj_3',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
  });

  it('token form CT soft-3', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ctf_3');
    putAuthCode(sessions, 'ctf_3', { client_id: 'client_ctf_3' });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'client_ctf_3',
          code: 'ctf_3',
          redirect_uri: REDIRECT,
        }).toString(),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
  });
  it('token JSON CT soft-4', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ctj_4');
    putAuthCode(sessions, 'ctj_4', { client_id: 'client_ctj_4' });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_ctj_4',
          code: 'ctj_4',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
  });

  it('token form CT soft-4', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ctf_4');
    putAuthCode(sessions, 'ctf_4', { client_id: 'client_ctf_4' });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'client_ctf_4',
          code: 'ctf_4',
          redirect_uri: REDIRECT,
        }).toString(),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
  });
  it('token JSON CT soft-5', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ctj_5');
    putAuthCode(sessions, 'ctj_5', { client_id: 'client_ctj_5' });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_ctj_5',
          code: 'ctj_5',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
  });

  it('token form CT soft-5', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ctf_5');
    putAuthCode(sessions, 'ctf_5', { client_id: 'client_ctf_5' });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'client_ctf_5',
          code: 'ctf_5',
          redirect_uri: REDIRECT,
        }).toString(),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
  });
  it('token JSON CT soft-6', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ctj_6');
    putAuthCode(sessions, 'ctj_6', { client_id: 'client_ctj_6' });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_ctj_6',
          code: 'ctj_6',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
  });

  it('token form CT soft-6', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ctf_6');
    putAuthCode(sessions, 'ctf_6', { client_id: 'client_ctf_6' });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'client_ctf_6',
          code: 'ctf_6',
          redirect_uri: REDIRECT,
        }).toString(),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
  });
  it('token JSON CT soft-7', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ctj_7');
    putAuthCode(sessions, 'ctj_7', { client_id: 'client_ctj_7' });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_ctj_7',
          code: 'ctj_7',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
  });

  it('token form CT soft-7', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ctf_7');
    putAuthCode(sessions, 'ctf_7', { client_id: 'client_ctf_7' });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'client_ctf_7',
          code: 'ctf_7',
          redirect_uri: REDIRECT,
        }).toString(),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
  });
  it('token JSON CT soft-8', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ctj_8');
    putAuthCode(sessions, 'ctj_8', { client_id: 'client_ctj_8' });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_ctj_8',
          code: 'ctj_8',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
  });

  it('token form CT soft-8', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ctf_8');
    putAuthCode(sessions, 'ctf_8', { client_id: 'client_ctf_8' });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'client_ctf_8',
          code: 'ctf_8',
          redirect_uri: REDIRECT,
        }).toString(),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
  });
  it('token JSON CT soft-9', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ctj_9');
    putAuthCode(sessions, 'ctj_9', { client_id: 'client_ctj_9' });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'client_ctj_9',
          code: 'ctj_9',
          redirect_uri: REDIRECT,
        }),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
  });

  it('token form CT soft-9', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const db = createOAuthDb({ users: aliceMap() });
    seedClient(cache, 'client_ctf_9');
    putAuthCode(sessions, 'ctf_9', { client_id: 'client_ctf_9' });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'client_ctf_9',
          code: 'ctf_9',
          redirect_uri: REDIRECT,
        }).toString(),
      },
      makeEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
  });
});
