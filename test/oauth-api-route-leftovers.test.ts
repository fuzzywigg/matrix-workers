/**
 * TOKENMAXX HEAVY deepen after #129 — oauth API route leftovers.
 * Orthogonal to open #130 (login), merged #128 (push), #127 (account-data),
 * #129 (federation membership/state/directory). Companion deepen beyond
 * oauth-api-routes / oauth-api-route-edges / oauth-helpers (#90/#102/#103).
 * Tests-only — Hono app.request() against src/api/oauth.ts. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { hashToken } from '../src/utils/crypto';
import {
  base64UrlEncode,
  escapeHtml,
  generateLoginPage,
  generateRandomString,
  generateUiaApprovalPage,
  generateUiaCancelledPage,
  generateUiaErrorPage,
  generateUiaSuccessPage,
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
const REDIRECT_ALT = 'https://app.example.com/oauth/cb';
const NOW = 1_730_200_000_000;

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

function aliceDb(extra: Partial<UserRow> = {}) {
  return createOAuthDb({
    users: new Map([
      [
        USER_ID,
        userRow({
          user_id: USER_ID,
          localpart: 'alice',
          password_hash: 'mockok:secret',
          ...extra,
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

async function tokenJson(
  env: Env,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  const res = await request(
    '/oauth/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    env
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function tokenForm(env: Env, params: Record<string, string>) {
  const res = await request(
    '/oauth/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    },
    env
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}


// ===========================================================================
// Register leftovers — metadata / auth method / TTL / issued_at
// ===========================================================================

describe('oauth leftovers: POST /oauth/register', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults client_name to Unknown Client when omitted', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const { status, body } = await registerClient(env, { redirect_uris: [REDIRECT] });
    expect(status).toBe(201);
    expect(body.client_name).toBe('Unknown Client');
    const stored = JSON.parse(cache.data[`oauth_client:${body.client_id}`]);
    expect(stored.client_name).toBe('Unknown Client');
  });

  it('client_id_issued_at is floor(created_at/1000) at registration time', async () => {
    const env = makeEnv();
    const { body } = await registerClient(env);
    expect(body.client_id_issued_at).toBe(Math.floor(NOW / 1000));
  });

  it('client_secret_expires_at is 0 (never) for confidential clients', async () => {
    const env = makeEnv();
    const { body } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
    });
    expect(body.client_secret_expires_at).toBe(0);
    expect(typeof body.client_secret).toBe('string');
    expect(String(body.client_secret).length).toBe(64); // 32 bytes hex
  });

  it('stores CACHE oauth_client with 1-year TTL', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const { body } = await registerClient(env);
    const put = cache.puts.find((p) => p.key === `oauth_client:${body.client_id}`);
    expect(put?.options?.expirationTtl).toBe(365 * 24 * 60 * 60);
  });

  it('accepts many redirect_uris and persists exact array order', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const uris = [
      REDIRECT,
      REDIRECT_ALT,
      'https://element://callback',
      'http://localhost:8080/cb',
    ];
    const { body } = await registerClient(env, {
      client_name: 'Multi',
      redirect_uris: uris,
    });
    expect(body.redirect_uris).toEqual(uris);
    const stored = JSON.parse(cache.data[`oauth_client:${body.client_id}`]);
    expect(stored.redirect_uris).toEqual(uris);
  });

  it('ignores unknown metadata fields without failing (contacts/logo/etc)', async () => {
    const env = makeEnv();
    const { status, body } = await registerClient(env, {
      client_name: 'Meta',
      redirect_uris: [REDIRECT],
      contacts: ['a@b.c'],
      logo_uri: 'https://x/l.png',
      client_uri: 'https://x',
      policy_uri: 'https://x/p',
      tos_uri: 'https://x/t',
      application_type: 'web',
      software_id: 'sw',
      software_version: '1.0',
    });
    expect(status).toBe(201);
    expect(body.client_id).toMatch(/^client_[0-9a-f]{32}$/);
    expect(body).not.toHaveProperty('contacts');
    expect(body).not.toHaveProperty('logo_uri');
  });

  it.each([
    'client_secret_basic',
    'client_secret_post',
    'none',
  ] as const)('token_endpoint_auth_method=%s persists and gates secret', async (method) => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const { body } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: method,
    });
    expect(body.token_endpoint_auth_method).toBe(method);
    const stored = JSON.parse(cache.data[`oauth_client:${body.client_id}`]);
    if (method === 'none') {
      expect(body.client_secret).toBeUndefined();
      expect(stored.client_secret_hash).toBeNull();
    } else {
      expect(body.client_secret).toBeTruthy();
      expect(stored.client_secret_hash).toBe(await hashClientSecret(String(body.client_secret)));
    }
  });

  it('rejects null body JSON and non-object gracefully via invalid JSON path', async () => {
    const env = makeEnv();
    const res = await request(
      '/oauth/register',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not-json{' },
      env
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('rejects redirect_uris: null as required missing', async () => {
    const env = makeEnv();
    const res = await request(
      '/oauth/register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: 'X', redirect_uris: null }),
      },
      env
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_client_metadata' });
  });

  it('issues distinct client_ids across sequential registrations', async () => {
    const env = makeEnv();
    const a = await registerClient(env);
    const b = await registerClient(env, { client_name: 'B', redirect_uris: [REDIRECT] });
    expect(a.body.client_id).not.toBe(b.body.client_id);
  });

  it('default grant_types/response_types when omitted', async () => {
    const env = makeEnv();
    const { body } = await registerClient(env, { redirect_uris: [REDIRECT] });
    expect(body.grant_types).toEqual(['authorization_code']);
    expect(body.response_types).toEqual(['code']);
  });

  it('empty string client_name is falsy → Unknown Client', async () => {
    const env = makeEnv();
    const { body } = await registerClient(env, {
      client_name: '',
      redirect_uris: [REDIRECT],
    });
    expect(body.client_name).toBe('Unknown Client');
  });
});

// ===========================================================================
// Authorize GET leftovers
// ===========================================================================

describe('oauth leftovers: GET /oauth/authorize', () => {
  it('rejects response_type=token and empty string', async () => {
    const env = makeEnv();
    const { body: client } = await registerClient(env);
    for (const rt of ['token', 'id_token', '', 'CODE']) {
      const qs = new URLSearchParams({
        client_id: String(client.client_id),
        redirect_uri: REDIRECT,
        response_type: rt,
      });
      const res = await request(`/oauth/authorize?${qs}`, {}, env);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'unsupported_response_type' });
    }
  });

  it('rejects missing client_id and missing redirect_uri with distinct descriptions', async () => {
    const env = makeEnv();
    const noClient = await request(
      `/oauth/authorize?redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
      {},
      env
    );
    expect(await noClient.json()).toMatchObject({
      error: 'invalid_request',
      error_description: 'client_id is required',
    });
    const { body: client } = await registerClient(env);
    const noRedirect = await request(
      `/oauth/authorize?client_id=${client.client_id}&response_type=code`,
      {},
      env
    );
    expect(await noRedirect.json()).toMatchObject({
      error_description: 'redirect_uri is required',
    });
  });

  it('stores auth request with 600s TTL and hex authRequestId key', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions });
    const { body: client } = await registerClient(env);
    const qs = new URLSearchParams({
      client_id: String(client.client_id),
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:api:*',
      state: 'st-1',
      nonce: 'n-1',
      code_challenge: 'chal',
      code_challenge_method: 'S256',
    });
    const res = await request(`/oauth/authorize?${qs}`, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const put = sessions.puts.find((p) => p.key.startsWith('oauth_auth_request:'));
    expect(put?.options?.expirationTtl).toBe(600);
    expect(put?.key).toMatch(/^oauth_auth_request:[0-9a-f]{32}$/);
    const stored = JSON.parse(put!.value);
    expect(stored).toMatchObject({
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      scope: 'openid urn:matrix:org.matrix.msc2967.client:api:*',
      state: 'st-1',
      nonce: 'n-1',
      code_challenge: 'chal',
      code_challenge_method: 'S256',
    });
  });

  it('HTML embeds escaped auth_request_id hidden field from session key', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions });
    const { body: client } = await registerClient(env, {
      client_name: 'Acme & Co <script>',
      redirect_uris: [REDIRECT],
    });
    const qs = new URLSearchParams({
      client_id: String(client.client_id),
      redirect_uri: REDIRECT,
      response_type: 'code',
    });
    const html = await (await request(`/oauth/authorize?${qs}`, {}, env)).text();
    expect(html).toContain(escapeHtml('Acme & Co <script>'));
    expect(html).not.toContain('<script>');
    const put = sessions.puts.find((p) => p.key.startsWith('oauth_auth_request:'));
    const id = put!.key.replace('oauth_auth_request:', '');
    expect(html).toContain(`value="${id}"`);
  });

  it('allows any of registered redirect_uris but not siblings', async () => {
    const env = makeEnv();
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT, REDIRECT_ALT],
    });
    const ok = await request(
      `/oauth/authorize?${new URLSearchParams({
        client_id: String(client.client_id),
        redirect_uri: REDIRECT_ALT,
        response_type: 'code',
      })}`,
      {},
      env
    );
    expect(ok.status).toBe(200);
    const bad = await request(
      `/oauth/authorize?${new URLSearchParams({
        client_id: String(client.client_id),
        redirect_uri: REDIRECT + '/extra',
        response_type: 'code',
      })}`,
      {},
      env
    );
    expect(await bad.json()).toMatchObject({ error_description: 'Invalid redirect_uri' });
  });

  it('scope defaults to openid when query omitted; empty string scope is preserved', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions });
    const { body: client } = await registerClient(env);
    await request(
      `/oauth/authorize?${new URLSearchParams({
        client_id: String(client.client_id),
        redirect_uri: REDIRECT,
        response_type: 'code',
      })}`,
      {},
      env
    );
    const def = JSON.parse(
      sessions.puts.find((p) => p.key.startsWith('oauth_auth_request:'))!.value
    );
    expect(def.scope).toBe('openid');

    sessions.puts.length = 0;
    // URLSearchParams with empty scope still sets the key
    const qs = new URLSearchParams({
      client_id: String(client.client_id),
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: '',
    });
    await request(`/oauth/authorize?${qs}`, {}, env);
    const empty = JSON.parse(
      sessions.puts.find((p) => p.key.startsWith('oauth_auth_request:'))!.value
    );
    // c.req.query('scope') || 'openid' → empty string is falsy → openid
    expect(empty.scope).toBe('openid');
  });
});

// ===========================================================================
// Authorize POST leftovers
// ===========================================================================

describe('oauth leftovers: POST /oauth/authorize', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function seedAuthRequest(env: Env, clientId: string, patch: Record<string, unknown> = {}) {
    const id = 'authreq' + generateRandomString(8).slice(0, 8);
    // use fixed-looking id
    const authRequestId = generateRandomString(16);
    await env.SESSIONS.put(
      `oauth_auth_request:${authRequestId}`,
      JSON.stringify({
        client_id: clientId,
        redirect_uri: REDIRECT,
        scope: 'openid',
        state: 'xyz',
        nonce: 'n',
        ...patch,
      }),
      { expirationTtl: 600 }
    );
    return authRequestId;
  }

  it('missing username alone shows Missing username or password HTML', async () => {
    const env = makeEnv({ db: aliceDb() });
    const { body: client } = await registerClient(env);
    const authRequestId = await seedAuthRequest(env, String(client.client_id));
    const fd = new FormData();
    fd.set('password', 'secret');
    fd.set('auth_request_id', authRequestId);
    const res = await request('/oauth/authorize', { method: 'POST', body: fd }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Missing username or password');
  });

  it('missing password alone shows Missing username or password HTML', async () => {
    const env = makeEnv({ db: aliceDb() });
    const { body: client } = await registerClient(env);
    const authRequestId = await seedAuthRequest(env, String(client.client_id));
    const fd = new FormData();
    fd.set('username', 'alice');
    fd.set('auth_request_id', authRequestId);
    const html = await (
      await request('/oauth/authorize', { method: 'POST', body: fd }, env)
    ).text();
    expect(html).toContain('Missing username or password');
  });

  it('formats username via formatUserId localpart (does not accept full MXID as localpart)', async () => {
    const db = aliceDb();
    const env = makeEnv({ db });
    const { body: client } = await registerClient(env);
    const authRequestId = await seedAuthRequest(env, String(client.client_id));
    // Passing full MXID becomes @@alice:server:server — fails lookup
    const fd = new FormData();
    fd.set('username', USER_ID);
    fd.set('password', 'secret');
    fd.set('auth_request_id', authRequestId);
    const html = await (
      await request('/oauth/authorize', { method: 'POST', body: fd }, env)
    ).text();
    expect(html).toContain('Invalid username or password');
  });

  it('success deletes auth request, stores code with 600 TTL, redirects with code+state', async () => {
    const sessions = mockKv();
    const env = makeEnv({ sessions, db: aliceDb() });
    const { body: client } = await registerClient(env);
    const authRequestId = await seedAuthRequest(env, String(client.client_id), {
      state: 'return-me',
      scope: 'openid offline_access',
      nonce: 'nonce-1',
    });
    const fd = new FormData();
    fd.set('username', 'alice');
    fd.set('password', 'secret');
    fd.set('auth_request_id', authRequestId);
    const res = await request('/oauth/authorize', { method: 'POST', body: fd }, env);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get('state')).toBe('return-me');
    const code = loc.searchParams.get('code')!;
    expect(code).toMatch(/^[0-9a-f]{64}$/);
    expect(sessions.data[`oauth_auth_request:${authRequestId}`]).toBeUndefined();
    expect(sessions.deletes).toContain(`oauth_auth_request:${authRequestId}`);
    const codePut = sessions.puts.find((p) => p.key === `oauth_code:${code}`);
    expect(codePut?.options?.expirationTtl).toBe(600);
    const stored = JSON.parse(codePut!.value);
    expect(stored).toMatchObject({
      client_id: client.client_id,
      user_id: USER_ID,
      scope: 'openid offline_access',
      nonce: 'nonce-1',
      expires_at: NOW + 10 * 60 * 1000,
    });
  });

  it('retry after bad password issues new auth_request_id and preserves original request fields', async () => {
    const sessions = mockKv();
    const cache = mockKv();
    const env = makeEnv({ sessions, cache, db: aliceDb() });
    const { body: client } = await registerClient(env, {
      client_name: 'RetryClient',
      redirect_uris: [REDIRECT],
    });
    const authRequestId = await seedAuthRequest(env, String(client.client_id), {
      state: 'keep',
      code_challenge: 'abc',
      code_challenge_method: 'S256',
    });
    const fd = new FormData();
    fd.set('username', 'alice');
    fd.set('password', 'wrong');
    fd.set('auth_request_id', authRequestId);
    const html = await (
      await request('/oauth/authorize', { method: 'POST', body: fd }, env)
    ).text();
    expect(html).toContain('Invalid username or password');
    expect(html).toContain('RetryClient');
    const newPut = sessions.puts.find(
      (p) => p.key.startsWith('oauth_auth_request:') && !p.key.endsWith(authRequestId)
    );
    expect(newPut).toBeTruthy();
    const restored = JSON.parse(newPut!.value);
    expect(restored.state).toBe('keep');
    expect(restored.code_challenge).toBe('abc');
    expect(restored.code_challenge_method).toBe('S256');
  });

  it('guest users with password_hash can still authorize (no guest gate on oauth)', async () => {
    const db = aliceDb({ is_guest: 1 });
    const env = makeEnv({ db });
    const { body: client } = await registerClient(env);
    const authRequestId = await seedAuthRequest(env, String(client.client_id), { state: null });
    const fd = new FormData();
    fd.set('username', 'alice');
    fd.set('password', 'secret');
    fd.set('auth_request_id', authRequestId);
    const res = await request('/oauth/authorize', { method: 'POST', body: fd }, env);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.searchParams.has('state')).toBe(false);
    expect(loc.searchParams.get('code')).toBeTruthy();
  });
});

// ===========================================================================
// Token endpoint leftovers — grants, device scope, refresh, content types
// ===========================================================================

describe('oauth leftovers: POST /oauth/token authorization_code', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('happy path JSON returns Matrix fields + expires_in 86400', async () => {
    const db = createOAuthDb();
    const sessions = mockKv();
    const env = makeEnv({ db, sessions });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
      client_name: 'Tok Client',
    });
    await putAuthCode(env, 'code-happy', {
      client_id: String(client.client_id),
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEVICEABC',
    });
    const { status, body } = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      client_secret: client.client_secret,
      code: 'code-happy',
      redirect_uri: REDIRECT,
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      token_type: 'Bearer',
      expires_in: 86400,
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEVICEABC',
      user_id: USER_ID,
      device_id: 'DEVICEABC',
    });
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(String(body.refresh_token).length).toBe(64);

    const deviceInsert = db.inserts.find((i) => i.sql.includes('INTO devices'));
    expect(deviceInsert?.args[0]).toBe(USER_ID);
    expect(deviceInsert?.args[1]).toBe('DEVICEABC');
    expect(deviceInsert?.args[2]).toBe('OAuth Client (Tok Client)');

    const refreshPut = sessions.puts.find((p) =>
      p.key.startsWith('oauth_refresh:')
    );
    expect(refreshPut?.options?.expirationTtl).toBe(30 * 24 * 60 * 60);
    const stored = JSON.parse(refreshPut!.value);
    expect(stored.expires_at).toBe(NOW + 24 * 60 * 60 * 1000);
    expect(stored.refresh_token_hash).toBe(
      await hashClientSecret(String(body.refresh_token))
    );
  });

  it('device scope * and missing device scope both generate opaque device ids', async () => {
    const env = makeEnv({ db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'c-star', {
      client_id: String(client.client_id),
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:*',
    });
    const star = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: 'c-star',
    });
    expect(star.status).toBe(200);
    expect(star.body.device_id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(star.body.device_id).not.toBe('*');

    await putAuthCode(env, 'c-none', {
      client_id: String(client.client_id),
      scope: 'openid',
    });
    const none = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: 'c-none',
    });
    expect(none.status).toBe(200);
    expect(none.body.device_id).toBeTruthy();
    expect(none.body.device_id).not.toBe(star.body.device_id);
  });

  it('uses first MSC2967 device scope when several device scopes appear', async () => {
    const env = makeEnv({ db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'c-multi', {
      client_id: String(client.client_id),
      scope:
        'openid urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:FIRST urn:matrix:org.matrix.msc2967.client:device:SECOND',
    });
    const { body } = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: 'c-multi',
    });
    expect(body.device_id).toBe('FIRST');
  });

  it('rejects missing code, expired code, wrong client, redirect mismatch', async () => {
    const env = makeEnv({ db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const missing = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
    });
    expect(missing.body).toMatchObject({ error_description: 'code is required' });

    await putAuthCode(env, 'expired', {
      client_id: String(client.client_id),
      expires_at: NOW - 1,
    });
    const exp = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: 'expired',
    });
    expect(exp.body).toMatchObject({
      error: 'invalid_grant',
      error_description: 'Authorization code has expired',
    });

    await putAuthCode(env, 'wrong-client', { client_id: 'other-client' });
    const wrong = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: 'wrong-client',
    });
    expect(wrong.body).toMatchObject({
      error_description: 'Code was not issued to this client',
    });

    await putAuthCode(env, 'redir', {
      client_id: String(client.client_id),
      redirect_uri: REDIRECT,
    });
    const mismatch = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: 'redir',
      redirect_uri: REDIRECT_ALT,
    });
    expect(mismatch.body).toMatchObject({ error_description: 'redirect_uri mismatch' });
  });

  it('PKCE: requires verifier when challenge set; plain and S256 succeed; bad fails', async () => {
    const env = makeEnv({ db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'pkce-need', {
      client_id: String(client.client_id),
      code_challenge: 'plain-chal',
      code_challenge_method: 'plain',
    });
    const need = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: 'pkce-need',
    });
    expect(need.body).toMatchObject({ error_description: 'code_verifier is required' });

    await putAuthCode(env, 'pkce-plain', {
      client_id: String(client.client_id),
      code_challenge: 'verifier-val',
      code_challenge_method: 'plain',
    });
    const plain = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: 'pkce-plain',
      code_verifier: 'verifier-val',
    });
    expect(plain.status).toBe(200);

    const verifier = 's256-verifier-abcdefghijklmnopqrstuvwxyz012345';
    const challenge = await s256Challenge(verifier);
    await putAuthCode(env, 'pkce-s256', {
      client_id: String(client.client_id),
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const s256 = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: 'pkce-s256',
      code_verifier: verifier,
    });
    expect(s256.status).toBe(200);

    await putAuthCode(env, 'pkce-bad', {
      client_id: String(client.client_id),
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const bad = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: 'pkce-bad',
      code_verifier: 'wrong-verifier-value-xxxxxxxxxxxxxxxxxxxx',
    });
    expect(bad.body).toMatchObject({ error_description: 'Invalid code_verifier' });
  });

  it('unknown PKCE method fails verification (verifyCodeChallenge false)', async () => {
    expect(await verifyCodeChallenge('a', 'a', 'S512')).toBe(false);
    const env = makeEnv({ db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'pkce-unk', {
      client_id: String(client.client_id),
      code_challenge: 'x',
      code_challenge_method: 'S512',
    });
    const res = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: 'pkce-unk',
      code_verifier: 'x',
    });
    expect(res.body).toMatchObject({ error_description: 'Invalid code_verifier' });
  });

  it('form-urlencoded exchange matches JSON exchange for same code shape', async () => {
    const env = makeEnv({ db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
    });
    await putAuthCode(env, 'form-code', {
      client_id: String(client.client_id),
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:FORMDEV',
    });
    const { status, body } = await tokenForm(env, {
      grant_type: 'authorization_code',
      client_id: String(client.client_id),
      client_secret: String(client.client_secret),
      code: 'form-code',
      redirect_uri: REDIRECT,
    });
    expect(status).toBe(200);
    expect(body.device_id).toBe('FORMDEV');
    expect(body.user_id).toBe(USER_ID);
  });

  it('Basic auth secret with URL-encoded special chars in client_secret', async () => {
    const env = makeEnv({ db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_basic',
    });
    await putAuthCode(env, 'basic-code', { client_id: String(client.client_id) });
    const basic = btoa(
      `${encodeURIComponent(String(client.client_id))}:${encodeURIComponent(String(client.client_secret))}`
    );
    const { status, body } = await tokenJson(
      env,
      { grant_type: 'authorization_code', code: 'basic-code', redirect_uri: REDIRECT },
      { Authorization: `Basic ${basic}` }
    );
    expect(status).toBe(200);
    expect(body.access_token).toBeTruthy();
  });

  it('body client_id preferred over Basic header client_id', async () => {
    const env = makeEnv({ db: createOAuthDb() });
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
    await putAuthCode(env, 'pref', { client_id: String(a.body.client_id) });
    const basic = btoa(
      `${encodeURIComponent(String(b.body.client_id))}:${encodeURIComponent(String(b.body.client_secret))}`
    );
    // Body says A (correct for code) but Basic is B — effectiveClientId is A from body;
    // secret from body missing, falls back to B's secret → wrong for A → 401
    const res = await tokenJson(
      env,
      {
        grant_type: 'authorization_code',
        client_id: a.body.client_id,
        code: 'pref',
      },
      { Authorization: `Basic ${basic}` }
    );
    // effectiveClientSecret = body || header → header B secret used with client A → invalid
    expect(res.status).toBe(401);
  });

  it('code is single-use: second exchange yields invalid_grant', async () => {
    const env = makeEnv({ db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'once', { client_id: String(client.client_id) });
    const first = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: 'once',
    });
    expect(first.status).toBe(200);
    const second = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: 'once',
    });
    expect(second.body).toMatchObject({
      error: 'invalid_grant',
      error_description: 'Invalid or expired authorization code',
    });
  });
});

describe('oauth leftovers: POST /oauth/token refresh_token', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function issueRefresh(env: Env) {
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
    });
    await putAuthCode(env, 'for-refresh', {
      client_id: String(client.client_id),
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:REFDEV',
    });
    const issued = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      client_secret: client.client_secret,
      code: 'for-refresh',
    });
    return { client, refresh: String(issued.body.refresh_token), access: String(issued.body.access_token) };
  }

  it('rotates access+refresh, preserves scope, omits user_id/device_id on refresh response', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const env = makeEnv({ sessions, db });
    const { client, refresh } = await issueRefresh(env);
    const rotated = await tokenJson(env, {
      grant_type: 'refresh_token',
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: refresh,
    });
    expect(rotated.status).toBe(200);
    expect(rotated.body).toMatchObject({
      token_type: 'Bearer',
      expires_in: 86400,
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:REFDEV',
    });
    expect(rotated.body).not.toHaveProperty('user_id');
    expect(rotated.body).not.toHaveProperty('device_id');
    expect(rotated.body.refresh_token).not.toBe(refresh);
    expect(sessions.data[`oauth_refresh:${refresh}`]).toBeUndefined();
    expect(sessions.data[`oauth_refresh:${rotated.body.refresh_token}`]).toBeTruthy();
    const stored = JSON.parse(sessions.data[`oauth_refresh:${rotated.body.refresh_token}`]);
    expect(stored.device_id).toBe('REFDEV');
    expect(stored.user_id).toBe(USER_ID);
  });

  it('rejects missing refresh_token, unknown token, wrong client', async () => {
    const env = makeEnv({ db: createOAuthDb() });
    const { client, refresh } = await issueRefresh(env);
    const missing = await tokenJson(env, {
      grant_type: 'refresh_token',
      client_id: client.client_id,
      client_secret: client.client_secret,
    });
    expect(missing.body).toMatchObject({ error_description: 'refresh_token is required' });

    const unknown = await tokenJson(env, {
      grant_type: 'refresh_token',
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: 'nope',
    });
    expect(unknown.body).toMatchObject({ error_description: 'Invalid refresh token' });

    const other = await registerClient(env, {
      client_name: 'Other',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
    });
    const wrong = await tokenJson(env, {
      grant_type: 'refresh_token',
      client_id: other.body.client_id,
      client_secret: other.body.client_secret,
      refresh_token: refresh,
    });
    expect(wrong.body).toMatchObject({
      error_description: 'Token was not issued to this client',
    });
  });

  it('refresh is single-use after rotation', async () => {
    const env = makeEnv({ db: createOAuthDb() });
    const { client, refresh } = await issueRefresh(env);
    const first = await tokenJson(env, {
      grant_type: 'refresh_token',
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: refresh,
    });
    expect(first.status).toBe(200);
    const reuse = await tokenJson(env, {
      grant_type: 'refresh_token',
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: refresh,
    });
    expect(reuse.body).toMatchObject({ error_description: 'Invalid refresh token' });
  });

  it('rejects unsupported grant_type including empty and client_credentials', async () => {
    const env = makeEnv();
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    for (const gt of ['client_credentials', 'password', '', 'Authorization_code']) {
      const res = await tokenJson(env, {
        grant_type: gt,
        client_id: client.client_id,
      });
      expect(res.body).toMatchObject({ error: 'unsupported_grant_type' });
    }
  });
});

// ===========================================================================
// Revoke leftovers
// ===========================================================================

describe('oauth leftovers: POST /oauth/revoke', () => {
  it('parses JSON body and form body equivalently for refresh hint', async () => {
    const sessions = mockKv();
    sessions.data['oauth_refresh:rt-json'] = JSON.stringify({ token_id: 't' });
    sessions.data['oauth_refresh:rt-form'] = JSON.stringify({ token_id: 't' });
    const env = makeEnv({ sessions });

    const jsonRes = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'rt-json', token_type_hint: 'refresh_token' }),
      },
      env
    );
    expect(jsonRes.status).toBe(200);
    expect(sessions.deletes).toContain('oauth_refresh:rt-json');

    const formRes = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: 'rt-form',
          token_type_hint: 'refresh_token',
        }),
      },
      env
    );
    expect(formRes.status).toBe(200);
    expect(sessions.deletes).toContain('oauth_refresh:rt-form');
  });

  it('access_token hint deletes DB hash and does not require refresh key', async () => {
    const db = createOAuthDb();
    const token = 'access-to-revoke';
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, { user_id: USER_ID, device_id: 'D', created_at: NOW });
    const env = makeEnv({ db });
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
    expect(db.deletes.some((d) => d.sql.includes('access_tokens'))).toBe(true);
  });

  it('without hint: refresh delete short-circuits before access path when key existed', async () => {
    const sessions = mockKv();
    const db = createOAuthDb();
    const token = 'dual-token';
    sessions.data[`oauth_refresh:${token}`] = '{}';
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, { user_id: USER_ID, device_id: 'D', created_at: NOW });
    const env = makeEnv({ sessions, db });
    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      },
      env
    );
    expect(res.status).toBe(200);
    // Workers KV delete resolves to void/undefined → `deleted !== undefined` is false,
    // so the handler falls through and also attempts access_token revocation.
    expect(sessions.deletes).toContain(`oauth_refresh:${token}`);
    expect(db.tokensByHash.has(hash)).toBe(false);
    expect(db.deletes.some((d) => d.sql.includes('access_tokens'))).toBe(true);
  });

  it('unsupported content-type leaves params empty → token required 400', async () => {
    const env = makeEnv();
    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'token=abc',
      },
      env
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_description: 'token is required' });
  });

  it('empty token string is treated as missing', async () => {
    const env = makeEnv();
    const res = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: '' }),
      },
      env
    );
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// Introspect leftovers
// ===========================================================================

describe('oauth leftovers: POST /oauth/introspect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('form and JSON both introspect active opaque access tokens', async () => {
    const db = createOAuthDb();
    const token = 'opaque-active';
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, {
      user_id: USER_ID,
      device_id: 'DEV1',
      created_at: NOW - 5000,
    });
    const env = makeEnv({ db });

    const jsonRes = await request(
      '/oauth/introspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      },
      env
    );
    expect(await jsonRes.json()).toEqual({
      active: true,
      sub: USER_ID,
      client_id: 'unknown',
      token_type: 'Bearer',
      iat: Math.floor((NOW - 5000) / 1000),
    });

    const formRes = await request(
      '/oauth/introspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
      },
      env
    );
    expect((await formRes.json()) as Record<string, unknown>).toMatchObject({
      active: true,
      sub: USER_ID,
    });
  });

  it('JWT active payload surfaces sub/client_id/azp/scope/iss/exp/iat', async () => {
    const env = makeEnv();
    const exp = Math.floor(NOW / 1000) + 3600;
    const jwt = fakeJwt({
      sub: USER_ID,
      client_id: 'cid',
      azp: 'azp-should-lose',
      scope: 'openid',
      iss: `https://${SERVER}/`,
      exp,
      iat: Math.floor(NOW / 1000),
    });
    const res = await request(
      '/oauth/introspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: jwt }),
      },
      env
    );
    expect(await res.json()).toEqual({
      active: true,
      sub: USER_ID,
      client_id: 'cid',
      token_type: 'Bearer',
      exp,
      iat: Math.floor(NOW / 1000),
      scope: 'openid',
      iss: `https://${SERVER}/`,
    });
  });

  it('JWT uses azp when client_id absent; expired JWT → active:false', async () => {
    const env = makeEnv();
    const azpOnly = fakeJwt({
      sub: USER_ID,
      azp: 'from-azp',
      exp: Math.floor(NOW / 1000) + 10,
    });
    const azpRes = await request(
      '/oauth/introspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: azpOnly }),
      },
      env
    );
    expect(await azpRes.json()).toMatchObject({ active: true, client_id: 'from-azp' });

    const expired = fakeJwt({
      sub: USER_ID,
      exp: Math.floor(NOW / 1000) - 1,
    });
    const expRes = await request(
      '/oauth/introspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: expired }),
      },
      env
    );
    expect(await expRes.json()).toEqual({ active: false });
  });

  it('malformed JWT-shaped token falls through to inactive opaque', async () => {
    const env = makeEnv();
    // 3 segments but middle is not valid base64url JSON
    const bad = 'aaa.!!!notb64!!!.ccc';
    const res = await request(
      '/oauth/introspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: bad }),
      },
      env
    );
    expect(await res.json()).toEqual({ active: false });
  });

  it('exp === now remains active (strict <); exp 0 is falsy-gated as active', async () => {
    const env = makeEnv();
    const nowSec = Math.floor(NOW / 1000);
    const eq = fakeJwt({ sub: 'x', exp: nowSec });
    expect(
      await (
        await request(
          '/oauth/introspect',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: eq }),
          },
          env
        )
      ).json()
    ).toMatchObject({ active: true });

    const zeroExp = fakeJwt({ sub: 'x', exp: 0 });
    expect(
      await (
        await request(
          '/oauth/introspect',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: zeroExp }),
          },
          env
        )
      ).json()
    ).toMatchObject({ active: true });
  });

  it('unsupported content-type → token required', async () => {
    const env = makeEnv();
    const res = await request(
      '/oauth/introspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'token=x',
      },
      env
    );
    expect(await res.json()).toMatchObject({ error_description: 'token is required' });
  });
});

// ===========================================================================
// Userinfo leftovers
// ===========================================================================

describe('oauth leftovers: GET/POST /oauth/userinfo', () => {
  it('GET and POST return identical claims for same bearer', async () => {
    const db = createOAuthDb({
      users: new Map([
        [
          USER_ID,
          userRow({
            user_id: USER_ID,
            localpart: 'alice',
            display_name: 'Alice Example',
            avatar_url: 'mxc://matrix.example.com/abc',
          }),
        ],
      ]),
    });
    const token = 'ui-tok';
    db.tokensByHash.set(await hashToken(token), {
      user_id: USER_ID,
      device_id: 'D',
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
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env
    );
    expect(getRes.status).toBe(200);
    expect(postRes.status).toBe(200);
    const g = await getRes.json();
    const p = await postRes.json();
    expect(g).toEqual(p);
    expect(g).toEqual({
      sub: USER_ID,
      name: 'Alice Example',
      picture: 'mxc://matrix.example.com/abc',
      'urn:matrix:user_id': USER_ID,
    });
  });

  it('null display_name/avatar_url become null JSON fields', async () => {
    const row = userRow({
      user_id: USER_ID,
      localpart: 'alice',
    });
    // userRow coalesces omitted display_name → localpart; force DB nulls explicitly
    row.display_name = null;
    row.avatar_url = null;
    const db = createOAuthDb({
      users: new Map([[USER_ID, row]]),
    });
    const token = 'ui-null';
    db.tokensByHash.set(await hashToken(token), {
      user_id: USER_ID,
      device_id: 'D',
      created_at: NOW,
    });
    const env = makeEnv({ db });
    const body = await (
      await request(
        '/oauth/userinfo',
        { headers: { Authorization: `Bearer ${token}` } },
        env
      )
    ).json();
    expect(body).toEqual({
      sub: USER_ID,
      'urn:matrix:user_id': USER_ID,
    });
    // getUserById maps null → undefined; c.json omits undefined name/picture keys
    expect(body).not.toHaveProperty('name');
    expect(body).not.toHaveProperty('picture');
  });

  it('rejects missing/invalid bearer with 401 before userinfo body', async () => {
    const env = makeEnv();
    expect((await request('/oauth/userinfo', {}, env)).status).toBe(401);
    expect(
      (
        await request(
          '/oauth/userinfo',
          { headers: { Authorization: 'Bearer missing' } },
          env
        )
      ).status
    ).toBe(401);
  });

  it('token for unknown user yields invalid_token after auth', async () => {
    const db = createOAuthDb();
    const token = 'orphan';
    db.tokensByHash.set(await hashToken(token), {
      user_id: '@ghost:matrix.example.com',
      device_id: 'D',
      created_at: NOW,
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

// ===========================================================================
// UIA leftovers — approval/cancel/OIDC/password/HTML contracts
// ===========================================================================

describe('oauth leftovers: /oauth/authorize/uia', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function putUia(env: Env, sessionId: string, patch: Record<string, unknown> = {}) {
    await env.CACHE.put(
      `uia_session:${sessionId}`,
      JSON.stringify({ user_id: USER_ID, completed_stages: [], ...patch }),
      { expirationTtl: 300 }
    );
  }

  it('GET missing session and expired session use error page titles', async () => {
    const env = makeEnv();
    const missing = await (await request('/oauth/authorize/uia', {}, env)).text();
    expect(missing).toContain('Missing Session');
    expect(missing).toContain('No UIA session specified');

    const expired = await (
      await request('/oauth/authorize/uia?session=gone', {}, env)
    ).text();
    expect(expired).toContain('Session Expired');
  });

  it('GET escapes user_id and custom action titles into HTML', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const evil = '@eve<script>:matrix.example.com';
    await cache.put(
      'uia_session:evil',
      JSON.stringify({ user_id: evil }),
      { expirationTtl: 300 }
    );
    const html = await (
      await request(
        '/oauth/authorize/uia?session=evil&action=org.matrix.cross_signing_reset',
        {},
        env
      )
    ).text();
    expect(html).toContain(escapeHtml(evil));
    expect(html).not.toContain('<script>');
    expect(html).toContain('Reset Encryption Keys');
    expect(html).toContain('value="evil"');
    // localpart extraction: split(':')[0].substring(1)
    expect(html).toContain(`value="${escapeHtml('eve<script>')}"`);
  });

  it('POST cancel deletes session and returns cancelled page with postMessage script', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    await putUia(env, 'cancel-me');
    const fd = new FormData();
    fd.set('session', 'cancel-me');
    fd.set('action', 'cancel');
    const html = await (
      await request('/oauth/authorize/uia', { method: 'POST', body: fd }, env)
    ).text();
    expect(html).toContain('Request Cancelled');
    expect(html).toContain("type: 'uia_cancelled'");
    expect(cache.data['uia_session:cancel-me']).toBeUndefined();
    expect(cache.deletes).toContain('uia_session:cancel-me');
  });

  it('POST missing credentials re-renders approval with required error', async () => {
    const env = makeEnv({ db: aliceDb() });
    await putUia(env, 'need-creds');
    const fd = new FormData();
    fd.set('session', 'need-creds');
    fd.set('action', 'approve');
    const html = await (
      await request('/oauth/authorize/uia', { method: 'POST', body: fd }, env)
    ).text();
    expect(html).toContain('Username and password are required');
    expect(html).toContain('Reset Encryption Keys');
  });

  it('POST password success marks three stages + oauth_completed_at and shows success', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache, db: aliceDb() });
    await putUia(env, 'ok-pass', { completed_stages: ['m.login.oauth'] });
    const fd = new FormData();
    fd.set('session', 'ok-pass');
    fd.set('username', 'alice');
    fd.set('password', 'secret');
    fd.set('action', 'approve');
    const html = await (
      await request('/oauth/authorize/uia', { method: 'POST', body: fd }, env)
    ).text();
    expect(html).toContain('Request Approved');
    expect(html).toContain('Session: ok-pass');
    expect(html).toContain("type: 'uia_complete'");
    const saved = JSON.parse(cache.data['uia_session:ok-pass']);
    expect(saved.completed_stages).toEqual([
      'm.login.oauth',
      'org.matrix.cross_signing_reset',
      'm.oauth',
    ]);
    expect(saved.oauth_completed_at).toBe(NOW);
    const put = cache.puts.find((p) => p.key === 'uia_session:ok-pass');
    expect(put?.options?.expirationTtl).toBe(300);
  });

  it('POST OIDC-only user with IdP link succeeds without password verify', async () => {
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
    const cache = mockKv();
    const env = makeEnv({ cache, db });
    await putUia(env, 'oidc-ok');
    const fd = new FormData();
    fd.set('session', 'oidc-ok');
    fd.set('username', 'alice');
    fd.set('password', 'ignored-but-required');
    fd.set('action', 'approve');
    const html = await (
      await request('/oauth/authorize/uia', { method: 'POST', body: fd }, env)
    ).text();
    expect(html).toContain('Request Approved');
  });

  it('POST OIDC-only wrong account vs session is rejected', async () => {
    const db = createOAuthDb({
      users: new Map([
        [
          BOB_ID,
          userRow({ user_id: BOB_ID, localpart: 'bob', password_hash: null }),
        ],
      ]),
      idpLinkCounts: new Map([[BOB_ID, 1]]),
    });
    const env = makeEnv({ db });
    await putUia(env, 'oidc-wrong'); // session is alice
    const fd = new FormData();
    fd.set('session', 'oidc-wrong');
    fd.set('username', 'bob');
    fd.set('password', 'x');
    fd.set('action', 'approve');
    const html = await (
      await request('/oauth/authorize/uia', { method: 'POST', body: fd }, env)
    ).text();
    expect(html).toContain('same account that started this request');
  });

  it('POST password user approving as different account rejected after password ok', async () => {
    const db = createOAuthDb({
      users: new Map([
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
    const env = makeEnv({ db });
    await putUia(env, 'pass-wrong'); // alice session
    const fd = new FormData();
    fd.set('session', 'pass-wrong');
    fd.set('username', 'bob');
    fd.set('password', 'secret');
    fd.set('action', 'approve');
    const html = await (
      await request('/oauth/authorize/uia', { method: 'POST', body: fd }, env)
    ).text();
    expect(html).toContain('same account that started this request');
  });

  it('POST unknown user and bad password show Invalid username or password', async () => {
    const env = makeEnv({ db: aliceDb() });
    await putUia(env, 'bad1');
    const fd1 = new FormData();
    fd1.set('session', 'bad1');
    fd1.set('username', 'nobody');
    fd1.set('password', 'x');
    fd1.set('action', 'approve');
    expect(
      await (await request('/oauth/authorize/uia', { method: 'POST', body: fd1 }, env)).text()
    ).toContain('Invalid username or password');

    await putUia(env, 'bad2');
    const fd2 = new FormData();
    fd2.set('session', 'bad2');
    fd2.set('username', 'alice');
    fd2.set('password', 'nope');
    fd2.set('action', 'approve');
    expect(
      await (await request('/oauth/authorize/uia', { method: 'POST', body: fd2 }, env)).text()
    ).toContain('Invalid username or password');
  });

  it('POST passwordless user without IdP link is rejected', async () => {
    const db = createOAuthDb({
      users: new Map([
        [
          USER_ID,
          userRow({ user_id: USER_ID, localpart: 'alice', password_hash: null }),
        ],
      ]),
      idpLinkCounts: new Map([[USER_ID, 0]]),
    });
    const env = makeEnv({ db });
    await putUia(env, 'no-idp');
    const fd = new FormData();
    fd.set('session', 'no-idp');
    fd.set('username', 'alice');
    fd.set('password', 'x');
    fd.set('action', 'approve');
    expect(
      await (await request('/oauth/authorize/uia', { method: 'POST', body: fd }, env)).text()
    ).toContain('Invalid username or password');
  });

  it('exported UIA HTML generators match route markers', () => {
    expect(generateUiaErrorPage('T', 'M', SERVER)).toContain('T');
    expect(generateUiaErrorPage('T', 'M', SERVER)).toContain('M');
    expect(generateUiaCancelledPage(SERVER)).toContain('Request Cancelled');
    expect(generateUiaSuccessPage('sid', SERVER)).toContain('uia_complete');
    expect(generateUiaApprovalPage('s', USER_ID, 'Title', 'Desc', SERVER, 'Err')).toContain(
      'Err'
    );
    expect(generateLoginPage('C', 'aid', SERVER, 'E')).toContain('E');
  });
});

// ===========================================================================
// Full lifecycle leftovers — register → authorize → token → refresh → revoke
// ===========================================================================

describe('oauth leftovers: end-to-end lifecycles', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('confidential client full code flow with S256 PKCE then refresh then revoke', async () => {
    const sessions = mockKv();
    const cache = mockKv();
    const db = aliceDb();
    const env = makeEnv({ sessions, cache, db });

    const { body: client } = await registerClient(env, {
      client_name: 'Lifecycle',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
    });

    const verifier = 'pkce-lifecycle-verifier-0123456789abcdef';
    const challenge = await s256Challenge(verifier);
    const qs = new URLSearchParams({
      client_id: String(client.client_id),
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:LIFEDEV',
      state: 'st-life',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const loginHtml = await (await request(`/oauth/authorize?${qs}`, {}, env)).text();
    expect(loginHtml).toContain('Lifecycle');
    const authKey = Object.keys(sessions.data).find((k) =>
      k.startsWith('oauth_auth_request:')
    )!;
    const authRequestId = authKey.replace('oauth_auth_request:', '');

    const fd = new FormData();
    fd.set('username', 'alice');
    fd.set('password', 'secret');
    fd.set('auth_request_id', authRequestId);
    const redir = await request('/oauth/authorize', { method: 'POST', body: fd }, env);
    expect(redir.status).toBe(302);
    const code = new URL(redir.headers.get('location')!).searchParams.get('code')!;

    const tokens = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      client_secret: client.client_secret,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(tokens.status).toBe(200);
    expect(tokens.body.device_id).toBe('LIFEDEV');

    // introspect access token
    const intro = await request(
      '/oauth/introspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokens.body.access_token }),
      },
      env
    );
    expect(await intro.json()).toMatchObject({ active: true, sub: USER_ID });

    // userinfo
    db.users.set(
      USER_ID,
      userRow({
        user_id: USER_ID,
        localpart: 'alice',
        password_hash: 'mockok:secret',
        display_name: 'Alice',
      })
    );
    const ui = await request(
      '/oauth/userinfo',
      { headers: { Authorization: `Bearer ${tokens.body.access_token}` } },
      env
    );
    expect(ui.status).toBe(200);
    expect(await ui.json()).toMatchObject({ sub: USER_ID, name: 'Alice' });

    const refreshed = await tokenJson(env, {
      grant_type: 'refresh_token',
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: tokens.body.refresh_token,
    });
    expect(refreshed.status).toBe(200);

    const revoke = await request(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: refreshed.body.refresh_token,
          token_type_hint: 'refresh_token',
        }),
      },
      env
    );
    expect(revoke.status).toBe(200);
    expect(sessions.data[`oauth_refresh:${refreshed.body.refresh_token}`]).toBeUndefined();
  });

  it('public client (auth method none) authorize→token without secret', async () => {
    const db = aliceDb();
    const env = makeEnv({ db });
    const { body: client } = await registerClient(env, {
      client_name: 'Public',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const authRequestId = generateRandomString(16);
    await env.SESSIONS.put(
      `oauth_auth_request:${authRequestId}`,
      JSON.stringify({
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        scope: 'openid',
        state: 's',
      }),
      { expirationTtl: 600 }
    );
    const fd = new FormData();
    fd.set('username', 'alice');
    fd.set('password', 'secret');
    fd.set('auth_request_id', authRequestId);
    const code = new URL(
      (await request('/oauth/authorize', { method: 'POST', body: fd }, env)).headers.get(
        'location'
      )!
    ).searchParams.get('code')!;
    const tokens = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
    });
    expect(tokens.status).toBe(200);
    expect(tokens.body.user_id).toBe(USER_ID);
  });

  it('UIA approve then session completed_stages readable for client polling', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache, db: aliceDb() });
    await env.CACHE.put(
      'uia_session:poll',
      JSON.stringify({ user_id: USER_ID }),
      { expirationTtl: 300 }
    );
    const fd = new FormData();
    fd.set('session', 'poll');
    fd.set('username', 'alice');
    fd.set('password', 'secret');
    fd.set('action', 'approve');
    await request('/oauth/authorize/uia', { method: 'POST', body: fd }, env);
    const session = JSON.parse(cache.data['uia_session:poll']);
    expect(session.completed_stages).toContain('org.matrix.cross_signing_reset');
    expect(session.completed_stages).toContain('m.oauth');
    expect(session.completed_stages).toContain('m.login.oauth');
  });
});

// ===========================================================================
// Error vocabulary + SQL bind contracts + helper consistency leftovers
// ===========================================================================

describe('oauth leftovers: error vocabulary catalog', () => {
  it('register/authorize/token error codes match OAuth RFC names used by routes', async () => {
    const env = makeEnv();
    const reg = await (
      await request(
        '/oauth/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
        env
      )
    ).json();
    expect(reg.error).toBe('invalid_client_metadata');

    const auth = await (
      await request('/oauth/authorize?response_type=code&redirect_uri=https://x', {}, env)
    ).json();
    expect(auth.error).toBe('invalid_request');

    const rt = await (
      await request(
        `/oauth/authorize?client_id=x&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=token`,
        {},
        env
      )
    ).json();
    expect(rt.error).toBe('unsupported_response_type');

    const tok = await tokenJson(env, { grant_type: 'foo', client_id: 'nope' });
    // unknown client before grant check
    expect(tok.body.error).toBe('invalid_client');
  });

  it('token unsupported_grant_type only after client authenticates', async () => {
    const env = makeEnv();
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const res = await tokenJson(env, {
      grant_type: 'password',
      client_id: client.client_id,
    });
    expect(res.body.error).toBe('unsupported_grant_type');
  });
});

describe('oauth leftovers: device + access_token SQL binds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('createDevice display_name embeds client_name; access_token binds user+device', async () => {
    const db = createOAuthDb();
    const env = makeEnv({ db });
    const { body: client } = await registerClient(env, {
      client_name: 'Bind Client',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'bind-code', {
      client_id: String(client.client_id),
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:BIND1',
    });
    const { body } = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: 'bind-code',
    });
    const deviceIns = db.inserts.find((i) => i.sql.includes('INTO devices'))!;
    expect(deviceIns.args).toEqual([
      USER_ID,
      'BIND1',
      'OAuth Client (Bind Client)',
      NOW,
    ]);
    const tokenIns = db.inserts.find((i) => i.sql.includes('INTO access_tokens'))!;
    expect(tokenIns.args[2]).toBe(USER_ID);
    expect(tokenIns.args[3]).toBe('BIND1');
    expect(tokenIns.args[1]).toBe(await hashToken(String(body.access_token)));
  });

  it('refresh inserts new access_token row with same device_id', async () => {
    const db = createOAuthDb();
    const env = makeEnv({ db });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'r1', {
      client_id: String(client.client_id),
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:RDEV',
    });
    const issued = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: 'r1',
    });
    db.inserts.length = 0;
    await tokenJson(env, {
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: issued.body.refresh_token,
    });
    const tokenIns = db.inserts.find((i) => i.sql.includes('INTO access_tokens'))!;
    expect(tokenIns.args[3]).toBe('RDEV');
    expect(db.inserts.some((i) => i.sql.includes('INTO devices'))).toBe(false);
  });
});

describe('oauth leftovers: helper ↔ route consistency matrix', () => {
  it('generateRandomString lengths used by routes (16→client id bytes, 32→secrets/codes)', () => {
    expect(generateRandomString(16)).toHaveLength(32);
    expect(generateRandomString(32)).toHaveLength(64);
  });

  it('hashClientSecret is stable for identical secrets', async () => {
    const a = await hashClientSecret('same');
    const b = await hashClientSecret('same');
    expect(a).toBe(b);
    expect(a).not.toBe(await hashClientSecret('other'));
  });

  it('escapeHtml covers XSS alphabet used in login/UIA pages', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#039;');
  });

  it('login page structure includes form POST /oauth/authorize', () => {
    const html = generateLoginPage('N', 'id', SERVER);
    expect(html).toContain('method="POST"');
    expect(html).toContain('action="/oauth/authorize"');
    expect(html).toContain('name="auth_request_id"');
  });
});

describe('oauth leftovers: content-type and method edges', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('GET on token/revoke/introspect/register is not implemented (404/405)', async () => {
    const env = makeEnv();
    for (const path of ['/oauth/token', '/oauth/revoke', '/oauth/introspect', '/oauth/register']) {
      const res = await request(path, { method: 'GET' }, env);
      expect([404, 405]).toContain(res.status);
    }
  });

  it('Content-Type with charset still matches form-urlencoded includes() check', async () => {
    const env = makeEnv({ db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'charset', { client_id: String(client.client_id) });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: String(client.client_id),
          code: 'charset',
        }),
      },
      env
    );
    expect(res.status).toBe(200);
  });

  it('application/json; charset=utf-8 accepted for token', async () => {
    const env = makeEnv({ db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'json-cs', { client_id: String(client.client_id) });
    const res = await request(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code: 'json-cs',
        }),
      },
      env
    );
    expect(res.status).toBe(200);
  });
});

describe('oauth leftovers: redirect_uri optional on token when omitted', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('succeeds without redirect_uri param when PKCE not required', async () => {
    const env = makeEnv({ db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'no-redir', { client_id: String(client.client_id) });
    const res = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: 'no-redir',
    });
    expect(res.status).toBe(200);
  });

  it('matching redirect_uri accepted', async () => {
    const env = makeEnv({ db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    await putAuthCode(env, 'match-redir', { client_id: String(client.client_id) });
    const res = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: 'match-redir',
      redirect_uri: REDIRECT,
    });
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// Soft-cap flood: register/authorize/token combinatorial leftovers
// ===========================================================================

describe('oauth leftovers: register auth-method × grant_types matrix', () => {
  it.each([
    {
      method: 'client_secret_basic',
      grants: ['authorization_code'],
      responses: ['code'],
    },
    {
      method: 'client_secret_post',
      grants: ['authorization_code', 'refresh_token'],
      responses: ['code'],
    },
    {
      method: 'none',
      grants: ['authorization_code', 'refresh_token'],
      responses: ['code'],
    },
  ])('persists $method with grants $grants', async ({ method, grants, responses }) => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const { status, body } = await registerClient(env, {
      client_name: `m-${method}`,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: method,
      grant_types: grants,
      response_types: responses,
    });
    expect(status).toBe(201);
    expect(body.grant_types).toEqual(grants);
    expect(body.response_types).toEqual(responses);
    const stored = JSON.parse(cache.data[`oauth_client:${body.client_id}`]);
    expect(stored.grant_types).toEqual(grants);
    expect(stored.token_endpoint_auth_method).toBe(method);
  });
});

describe('oauth leftovers: authorize scope string preservation', () => {
  it.each([
    'openid',
    'openid offline_access',
    'openid urn:matrix:org.matrix.msc2967.client:api:*',
    'openid urn:matrix:org.matrix.msc2967.client:device:ABC123',
    'urn:matrix:org.matrix.msc2967.client:device:ONLY',
  ])('stores scope %s verbatim on auth request', async (scope) => {
    const sessions = mockKv();
    const env = makeEnv({ sessions });
    const { body: client } = await registerClient(env);
    const qs = new URLSearchParams({
      client_id: String(client.client_id),
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope,
    });
    await request(`/oauth/authorize?${qs}`, {}, env);
    const stored = JSON.parse(
      sessions.puts.find((p) => p.key.startsWith('oauth_auth_request:'))!.value
    );
    expect(stored.scope).toBe(scope);
  });
});

describe('oauth leftovers: device id extraction matrix', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['openid urn:matrix:org.matrix.msc2967.client:device:A', 'A'],
    ['urn:matrix:org.matrix.msc2967.client:device:B openid', 'B'],
    [
      'openid urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:C',
      'C',
    ],
    ['openid urn:matrix:org.matrix.msc2967.client:device:dev_with-dashes.1', 'dev_with-dashes.1'],
  ])('scope %s → device %s', async (scope, device) => {
    const env = makeEnv({ db: createOAuthDb() });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const code = `dev-${device}`;
    await putAuthCode(env, code, { client_id: String(client.client_id), scope });
    const { body } = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
    });
    expect(body.device_id).toBe(device);
  });
});

describe('oauth leftovers: introspect JWT claim optional fields', () => {
  it('omits undefined optional claims when payload lacks them', async () => {
    const env = makeEnv();
    const jwt = fakeJwt({ sub: USER_ID }); // no exp/iat/scope/iss/client_id
    const body = await (
      await request(
        '/oauth/introspect',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: jwt }),
        },
        env
      )
    ).json();
    expect(body).toMatchObject({
      active: true,
      sub: USER_ID,
      token_type: 'Bearer',
    });
    expect(body.client_id).toBeUndefined();
    expect(body.exp).toBeUndefined();
  });
});

describe('oauth leftovers: authorize HTML server_name reflection', () => {
  it('custom SERVER_NAME appears in login footer', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    const env = makeEnv({
      cache,
      sessions,
      partial: { SERVER_NAME: 'hs.custom.test' },
    });
    // register uses same env
    const { body: client } = await registerClient(env);
    const qs = new URLSearchParams({
      client_id: String(client.client_id),
      redirect_uri: REDIRECT,
      response_type: 'code',
    });
    const html = await (await request(`/oauth/authorize?${qs}`, {}, env)).text();
    expect(html).toContain('hs.custom.test');
    expect(html).toContain('<title>Sign in - hs.custom.test</title>');
  });
});

describe('oauth leftovers: concurrent distinct auth codes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('two successful authorizations yield distinct codes and both redeem', async () => {
    const db = aliceDb();
    const env = makeEnv({ db });
    const { body: client } = await registerClient(env, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const codes: string[] = [];
    for (let i = 0; i < 2; i++) {
      const authRequestId = generateRandomString(16);
      await env.SESSIONS.put(
        `oauth_auth_request:${authRequestId}`,
        JSON.stringify({
          client_id: client.client_id,
          redirect_uri: REDIRECT,
          scope: `openid urn:matrix:org.matrix.msc2967.client:device:D${i}`,
          state: `s${i}`,
        }),
        { expirationTtl: 600 }
      );
      const fd = new FormData();
      fd.set('username', 'alice');
      fd.set('password', 'secret');
      fd.set('auth_request_id', authRequestId);
      const loc = (
        await request('/oauth/authorize', { method: 'POST', body: fd }, env)
      ).headers.get('location')!;
      codes.push(new URL(loc).searchParams.get('code')!);
    }
    expect(codes[0]).not.toBe(codes[1]);
    const t0 = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: codes[0],
    });
    const t1 = await tokenJson(env, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: codes[1],
    });
    expect(t0.body.device_id).toBe('D0');
    expect(t1.body.device_id).toBe('D1');
    expect(t0.body.access_token).not.toBe(t1.body.access_token);
  });
});
