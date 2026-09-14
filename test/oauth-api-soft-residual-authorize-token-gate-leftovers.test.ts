/**
 * TOKENMAXX HEAVY leftovers after #277 — residual *oauth* soft
 * `error_description` binds unsaturated by:
 *   #277 oauth quaternary concurrent-race (exact descriptions for Invalid JSON /
 *        Unsupported content type / expired code / wrong-client / PKCE /
 *        refresh wrong-client / userinfo orphan — never authorize GET gates,
 *        never `Unknown client`, never unsupported_grant_type description,
 *        never revoke/introspect `token is required` soft flood),
 *   #268 oauth concurrent megafloods (status/`error` only; grep
 *        `Only code response` / `Unknown client` /
 *        `Only authorization_code and refresh_token` across test/ = 0),
 *   soft leftovers (#142) success HTML / revoke-200 / introspect-inactive floods
 *        without authorize param-gate or confidential-client description binds,
 *   routes/edges/leftovers one-shots for register redirect_uris / token gates.
 *
 * Gap table (why leftover after #277):
 *   Only code response type is supported     | never asserted anywhere
 *   Unknown client (authorize 400 + token 401)| never asserted anywhere
 *   Only authorization_code… grants supported | concurrent binds error code only
 *   Authorization request expired soft flood  | routes once; quaternary=0
 *   redirect_uris is required soft flood      | edges once; soft leftovers never
 *   authorize client_id/redirect_uri required | routes once; no soft residual flood
 *   Invalid redirect_uri soft flood           | leftovers once
 *   token client_id / code / refresh required | leftovers once; quaternary skipped
 *   client_secret / Invalid client credentials| edges once; public-client quaternary
 *   Invalid refresh token soft flood          | leftovers once
 *   revoke+introspect token is required soft  | leftovers once; exclusive key soft
 *   Invalid or expired authorization code soft| quaternary raced expired sibling
 *
 * Distinct from tip #280 devices+keys soft second-wave, #279 admin IdP+invite,
 * #278 federation knock, open #281 room-cache senary. New file (not append).
 *
 * Tests-only. Fixtures use example.com only. Reversible by deleting this file.
 * No product inventing / secrets / DNS.
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
const USER_ID = `@alice:${SERVER}`;
const REDIRECT = 'https://app.example.com/cb';
const NOW = 1_730_500_000_000;
const PASS = 's3cret';

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };

type UserRow = {
  user_id: string;
  localpart: string;
  password_hash: string | null;
  display_name: string | null;
  avatar_url: string | null;
  is_guest: number;
  is_deactivated: number;
  admin: number;
  created_at: number;
};

type TokenRow = {
  user_id: string;
  device_id: string | null;
  created_at: number;
};

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
    puts: KvPut[];
    deletes: string[];
  };
}

type SoftKv = ReturnType<typeof mockKv>;

function userRow(patch: Partial<UserRow> & Pick<UserRow, 'user_id' | 'localpart'>): UserRow {
  return {
    password_hash: `mockok:${PASS}`,
    display_name: 'Alice',
    avatar_url: null,
    is_guest: 0,
    is_deactivated: 0,
    admin: 0,
    created_at: NOW,
    ...patch,
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

  return {
    users,
    tokensByHash,
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
                return {
                  user_id: row.user_id,
                  device_id: row.device_id,
                  created_at: row.created_at,
                } as T;
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
    inserts: Array<{ sql: string; args: unknown[] }>;
    deletes: Array<{ sql: string; args: unknown[] }>;
  };
}

function aliceDb() {
  return createOAuthDb({
    users: new Map([
      [
        USER_ID,
        userRow({
          user_id: USER_ID,
          localpart: 'alice',
          password_hash: `mockok:${PASS}`,
          display_name: 'Alice',
        }),
      ],
    ]),
  });
}

function makeEnv(opts: {
  cache?: SoftKv;
  sessions?: SoftKv;
  db?: ReturnType<typeof createOAuthDb>;
} = {}): Env & { _cache: SoftKv; _sessions: SoftKv; _db: ReturnType<typeof createOAuthDb> } {
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
    _cache: SoftKv;
    _sessions: SoftKv;
    _db: ReturnType<typeof createOAuthDb>;
  };
}

async function request(
  path: string,
  init: RequestInit = {},
  env: Env = makeEnv()
): Promise<{ status: number; body: any; headers: Headers; text: string }> {
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

function formInit(fields: Record<string, string>): RequestInit {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return { method: 'POST', body: fd };
}

function seedClient(cache: SoftKv, clientId: string, patch: Record<string, unknown> = {}) {
  const client = {
    client_id: clientId,
    client_secret_hash: null,
    client_name: 'Soft Residual App',
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

async function seedConfidentialClient(
  cache: SoftKv,
  clientId: string,
  secret: string,
  patch: Record<string, unknown> = {}
) {
  const hash = await hashClientSecret(secret);
  return seedClient(cache, clientId, {
    client_secret_hash: hash,
    token_endpoint_auth_method: 'client_secret_post',
    ...patch,
  });
}

function seedAuthCode(sessions: SoftKv, code: string, patch: Record<string, unknown> = {}) {
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

function seedRefresh(sessions: SoftKv, refresh: string, patch: Record<string, unknown> = {}) {
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

function seedAuthRequest(sessions: SoftKv, id: string, patch: Record<string, unknown> = {}) {
  const req = {
    client_id: 'cid-1',
    redirect_uri: REDIRECT,
    scope: 'openid',
    state: 'st',
    ...patch,
  };
  sessions.data[`oauth_auth_request:${id}`] = JSON.stringify(req);
  return req;
}

const ONLY_CODE_RESPONSE = {
  error: 'unsupported_response_type',
  error_description: 'Only code response type is supported',
} as const;

const UNKNOWN_CLIENT_AUTHORIZE = {
  error: 'invalid_client',
  error_description: 'Unknown client',
} as const;

const UNKNOWN_CLIENT_TOKEN = {
  error: 'invalid_client',
  error_description: 'Unknown client',
} as const;

const UNSUPPORTED_GRANT = {
  error: 'unsupported_grant_type',
  error_description: 'Only authorization_code and refresh_token grants are supported',
} as const;

const AUTH_EXPIRED = {
  error: 'invalid_request',
  error_description: 'Authorization request expired',
} as const;

const REDIRECT_URIS_REQUIRED = {
  error: 'invalid_client_metadata',
  error_description: 'redirect_uris is required',
} as const;

const CLIENT_ID_REQUIRED = {
  error: 'invalid_request',
  error_description: 'client_id is required',
} as const;

const REDIRECT_URI_REQUIRED = {
  error: 'invalid_request',
  error_description: 'redirect_uri is required',
} as const;

const INVALID_REDIRECT_URI = {
  error: 'invalid_request',
  error_description: 'Invalid redirect_uri',
} as const;

const TOKEN_CLIENT_ID_REQUIRED = {
  error: 'invalid_client',
  error_description: 'client_id is required',
} as const;

const CODE_REQUIRED = {
  error: 'invalid_request',
  error_description: 'code is required',
} as const;

const REFRESH_REQUIRED = {
  error: 'invalid_request',
  error_description: 'refresh_token is required',
} as const;

const INVALID_REFRESH = {
  error: 'invalid_grant',
  error_description: 'Invalid refresh token',
} as const;

const CLIENT_SECRET_REQUIRED = {
  error: 'invalid_client',
  error_description: 'client_secret is required',
} as const;

const INVALID_CLIENT_CREDS = {
  error: 'invalid_client',
  error_description: 'Invalid client credentials',
} as const;

const TOKEN_REQUIRED = {
  error: 'invalid_request',
  error_description: 'token is required',
} as const;

const INVALID_OR_EXPIRED_CODE = {
  error: 'invalid_grant',
  error_description: 'Invalid or expired authorization code',
} as const;

const REDIRECT_URI_MISMATCH = {
  error: 'invalid_grant',
  error_description: 'redirect_uri mismatch',
} as const;

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
// Authorize GET — never-bound response_type / Unknown client / param gates
// ---------------------------------------------------------------------------

describe('oauth soft residual Only code response type after #277', () => {
  for (let i = 0; i < 10; i++) {
    it(`authorize unsupported response_type binds Only code response soft-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, `cid-rt-${i}`);
      const env = makeEnv({ cache });
      const res = await request(
        `/oauth/authorize?client_id=cid-rt-${i}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=token`,
        {},
        env
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual(ONLY_CODE_RESPONSE);
      expect(Object.keys(res.body).sort()).toEqual(['error', 'error_description']);
    });
  }

  it('authorize response_type=id_token∥code∥missing — only non-code binds Only code response', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-rt-mix');
    const env = makeEnv({ cache });
    const [bad, ok, missing] = await Promise.all([
      request(
        `/oauth/authorize?client_id=cid-rt-mix&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=id_token`,
        {},
        env
      ),
      request(
        `/oauth/authorize?client_id=cid-rt-mix&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
        {},
        env
      ),
      request(
        `/oauth/authorize?client_id=cid-rt-mix&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=`,
        {},
        env
      ),
    ]);
    expect(bad.body).toEqual(ONLY_CODE_RESPONSE);
    expect(ok.status).toBe(200);
    expect(typeof ok.body === 'string' && ok.body.includes('Soft Residual App')).toBe(true);
    expect(missing.body).toEqual(ONLY_CODE_RESPONSE);
  });
});

describe('oauth soft residual Unknown client authorize+token after #277', () => {
  for (let i = 0; i < 8; i++) {
    it(`authorize unknown client_id binds Unknown client soft-${i}`, async () => {
      const env = makeEnv({ cache: mockKv() });
      const res = await request(
        `/oauth/authorize?client_id=ghost-${i}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
        {},
        env
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual(UNKNOWN_CLIENT_AUTHORIZE);
      expect(Object.keys(res.body).sort()).toEqual(['error', 'error_description']);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`token unknown client_id binds Unknown client 401 soft-${i}`, async () => {
      const env = makeEnv({ cache: mockKv() });
      const res = await request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: `missing-tok-${i}`,
          code: `code-${i}`,
          redirect_uri: REDIRECT,
        }),
        env
      );
      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNKNOWN_CLIENT_TOKEN);
      expect(Object.keys(res.body).sort()).toEqual(['error', 'error_description']);
    });
  }

  it('authorize Unknown client ∥ valid HTML sibling under Promise.all', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-ok');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request(
        `/oauth/authorize?client_id=ghost-race&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
        {},
        env
      ),
      request(
        `/oauth/authorize?client_id=cid-ok&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
        {},
        env
      ),
    ]);
    expect(results.find((r) => r.status === 400)!.body).toEqual(UNKNOWN_CLIENT_AUTHORIZE);
    expect(results.find((r) => r.status === 200)!.text).toContain('Soft Residual App');
  });
});

describe('oauth soft residual authorize param gates after #277', () => {
  for (let i = 0; i < 6; i++) {
    it(`authorize missing client_id binds client_id is required soft-${i}`, async () => {
      const res = await request(
        `/oauth/authorize?redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
        {},
        makeEnv()
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual(CLIENT_ID_REQUIRED);
      expect(Object.keys(res.body).sort()).toEqual(['error', 'error_description']);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`authorize missing redirect_uri binds redirect_uri is required soft-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, `cid-ru-${i}`);
      const res = await request(
        `/oauth/authorize?client_id=cid-ru-${i}&response_type=code`,
        {},
        makeEnv({ cache })
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual(REDIRECT_URI_REQUIRED);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`authorize mismatched redirect_uri binds Invalid redirect_uri soft-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, `cid-bad-${i}`);
      const res = await request(
        `/oauth/authorize?client_id=cid-bad-${i}&redirect_uri=${encodeURIComponent(`https://evil.example/cb-${i}`)}&response_type=code`,
        {},
        makeEnv({ cache })
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual(INVALID_REDIRECT_URI);
    });
  }

  it('authorize missing-client_id∥missing-redirect∥invalid-redirect∥ok under Promise.all', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-gate');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request(`/oauth/authorize?redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`, {}, env),
      request(`/oauth/authorize?client_id=cid-gate&response_type=code`, {}, env),
      request(
        `/oauth/authorize?client_id=cid-gate&redirect_uri=${encodeURIComponent('https://evil.example/x')}&response_type=code`,
        {},
        env
      ),
      request(
        `/oauth/authorize?client_id=cid-gate&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
        {},
        env
      ),
    ]);
    expect(results[0].body).toEqual(CLIENT_ID_REQUIRED);
    expect(results[1].body).toEqual(REDIRECT_URI_REQUIRED);
    expect(results[2].body).toEqual(INVALID_REDIRECT_URI);
    expect(results[3].status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST authorize — Authorization request expired soft flood
// ---------------------------------------------------------------------------

describe('oauth soft residual Authorization request expired after #277', () => {
  for (let i = 0; i < 10; i++) {
    it(`POST authorize missing auth_request binds Authorization request expired soft-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, `cid-exp-${i}`);
      const env = makeEnv({ cache, sessions: mockKv() });
      const res = await request(
        '/oauth/authorize',
        formInit({
          username: 'alice',
          password: PASS,
          auth_request_id: `gone-${i}`,
        }),
        env
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual(AUTH_EXPIRED);
      expect(Object.keys(res.body).sort()).toEqual(['error', 'error_description']);
    });
  }

  it('expired∥valid login redirect under Promise.all', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-exp-ok');
    const sessions = mockKv();
    seedAuthRequest(sessions, 'alive-1', { client_id: 'cid-exp-ok' });
    const env = makeEnv({ cache, sessions });
    const [expired, ok] = await Promise.all([
      request(
        '/oauth/authorize',
        formInit({ username: 'alice', password: PASS, auth_request_id: 'dead' }),
        env
      ),
      request(
        '/oauth/authorize',
        formInit({ username: 'alice', password: PASS, auth_request_id: 'alive-1' }),
        env
      ),
    ]);
    expect(expired.body).toEqual(AUTH_EXPIRED);
    expect(ok.status).toBe(302);
    expect(ok.headers.get('Location')).toContain('code=');
  });
});

// ---------------------------------------------------------------------------
// Register — redirect_uris is required soft flood
// ---------------------------------------------------------------------------

describe('oauth soft residual redirect_uris is required after #277', () => {
  for (let i = 0; i < 8; i++) {
    it(`register missing redirect_uris binds redirect_uris is required soft-${i}`, async () => {
      const res = await request(
        '/oauth/register',
        jsonInit('POST', { client_name: `NoUri-${i}` }),
        makeEnv()
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual(REDIRECT_URIS_REQUIRED);
      expect(Object.keys(res.body).sort()).toEqual(['error', 'error_description']);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`register empty redirect_uris array binds redirect_uris is required soft-${i}`, async () => {
      const res = await request(
        '/oauth/register',
        jsonInit('POST', { client_name: `Empty-${i}`, redirect_uris: [] }),
        makeEnv()
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual(REDIRECT_URIS_REQUIRED);
    });
  }

  it('empty redirect_uris ∥ valid register under Promise.all', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request('/oauth/register', jsonInit('POST', { client_name: 'Bad', redirect_uris: [] }), env),
      request(
        '/oauth/register',
        jsonInit('POST', {
          client_name: 'Good',
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
        }),
        env
      ),
    ]);
    expect(results.find((r) => r.status === 400)!.body).toEqual(REDIRECT_URIS_REQUIRED);
    expect(results.find((r) => r.status === 201)!.body.client_id).toMatch(/^client_/);
  });
});

// ---------------------------------------------------------------------------
// Token — unsupported_grant_type exact description (never bound)
// ---------------------------------------------------------------------------

describe('oauth soft residual unsupported_grant_type description after #277', () => {
  for (let i = 0; i < 10; i++) {
    it(`token unknown grant_type binds Only authorization_code… soft-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, `cid-ug-${i}`);
      const res = await request(
        '/oauth/token',
        urlencoded({
          grant_type: i % 2 === 0 ? 'client_credentials' : 'password',
          client_id: `cid-ug-${i}`,
        }),
        makeEnv({ cache })
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual(UNSUPPORTED_GRANT);
      expect(Object.keys(res.body).sort()).toEqual(['error', 'error_description']);
    });
  }

  it('unsupported_grant ∥ authorization_code missing-code under Promise.all', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-ug-mix');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: 'cid-ug-mix' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-ug-mix' }),
        env
      ),
    ]);
    expect(results[0].body).toEqual(UNSUPPORTED_GRANT);
    expect(results[1].body).toEqual(CODE_REQUIRED);
  });
});

// ---------------------------------------------------------------------------
// Token — client_id / code / refresh / confidential secret gates
// ---------------------------------------------------------------------------

describe('oauth soft residual token client_id/code/refresh gates after #277', () => {
  for (let i = 0; i < 6; i++) {
    it(`token missing client_id binds client_id is required soft-${i}`, async () => {
      const res = await request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', code: `c-${i}` }),
        makeEnv()
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual(TOKEN_CLIENT_ID_REQUIRED);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`authorization_code missing code binds code is required soft-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, `cid-code-${i}`);
      const res = await request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: `cid-code-${i}` }),
        makeEnv({ cache })
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual(CODE_REQUIRED);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`refresh_token missing refresh binds refresh_token is required soft-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, `cid-ref-${i}`);
      const res = await request(
        '/oauth/token',
        urlencoded({ grant_type: 'refresh_token', client_id: `cid-ref-${i}` }),
        makeEnv({ cache })
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual(REFRESH_REQUIRED);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`refresh unknown token binds Invalid refresh token soft-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, `cid-ir-${i}`);
      const res = await request(
        '/oauth/token',
        urlencoded({
          grant_type: 'refresh_token',
          client_id: `cid-ir-${i}`,
          refresh_token: `nope-${i}`,
        }),
        makeEnv({ cache })
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual(INVALID_REFRESH);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`authorization_code missing KV code binds Invalid or expired soft-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, `cid-ie-${i}`);
      const res = await request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: `cid-ie-${i}`,
          code: `missing-${i}`,
          redirect_uri: REDIRECT,
        }),
        makeEnv({ cache, sessions: mockKv() })
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual(INVALID_OR_EXPIRED_CODE);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`authorization_code redirect_uri mismatch soft-${i}`, async () => {
      const cache = mockKv();
      const sessions = mockKv();
      seedClient(cache, `cid-mm-${i}`);
      seedAuthCode(sessions, `code-mm-${i}`, { client_id: `cid-mm-${i}` });
      const res = await request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: `cid-mm-${i}`,
          code: `code-mm-${i}`,
          redirect_uri: `https://other.example/cb-${i}`,
        }),
        makeEnv({ cache, sessions })
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual(REDIRECT_URI_MISMATCH);
    });
  }
});

describe('oauth soft residual confidential client_secret gates after #277', () => {
  for (let i = 0; i < 8; i++) {
    it(`confidential missing secret binds client_secret is required soft-${i}`, async () => {
      const cache = mockKv();
      await seedConfidentialClient(cache, `cid-sec-${i}`, `secret-${i}`);
      const res = await request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: `cid-sec-${i}`,
          code: `c-${i}`,
        }),
        makeEnv({ cache })
      );
      expect(res.status).toBe(401);
      expect(res.body).toEqual(CLIENT_SECRET_REQUIRED);
      expect(Object.keys(res.body).sort()).toEqual(['error', 'error_description']);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`confidential wrong secret binds Invalid client credentials soft-${i}`, async () => {
      const cache = mockKv();
      await seedConfidentialClient(cache, `cid-badsec-${i}`, `real-${i}`);
      const res = await request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: `cid-badsec-${i}`,
          client_secret: `wrong-${i}`,
          code: `c-${i}`,
        }),
        makeEnv({ cache })
      );
      expect(res.status).toBe(401);
      expect(res.body).toEqual(INVALID_CLIENT_CREDS);
    });
  }

  it('missing-secret∥wrong-secret∥public-ok under Promise.all', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    await seedConfidentialClient(cache, 'cid-conf-a', 'real-a');
    await seedConfidentialClient(cache, 'cid-conf-b', 'real-b');
    seedClient(cache, 'cid-pub');
    seedAuthCode(sessions, 'ok-code', { client_id: 'cid-pub' });
    const env = makeEnv({ cache, sessions });
    const results = await Promise.all([
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'authorization_code', client_id: 'cid-conf-a', code: 'x' }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-conf-b',
          client_secret: 'nope',
          code: 'y',
        }),
        env
      ),
      request(
        '/oauth/token',
        urlencoded({
          grant_type: 'authorization_code',
          client_id: 'cid-pub',
          code: 'ok-code',
          redirect_uri: REDIRECT,
        }),
        env
      ),
    ]);
    expect(results[0].body).toEqual(CLIENT_SECRET_REQUIRED);
    expect(results[1].body).toEqual(INVALID_CLIENT_CREDS);
    expect(results[2].status).toBe(200);
    expect(results[2].body.access_token).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Revoke + introspect — token is required soft flood + exclusive keys
// ---------------------------------------------------------------------------

describe('oauth soft residual revoke/introspect token is required after #277', () => {
  for (let i = 0; i < 8; i++) {
    it(`revoke missing token binds token is required soft-${i}`, async () => {
      const res = await request('/oauth/revoke', urlencoded({}), makeEnv());
      expect(res.status).toBe(400);
      expect(res.body).toEqual(TOKEN_REQUIRED);
      expect(Object.keys(res.body).sort()).toEqual(['error', 'error_description']);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`introspect missing token binds token is required soft-${i}`, async () => {
      const res = await request('/oauth/introspect', urlencoded({}), makeEnv());
      expect(res.status).toBe(400);
      expect(res.body).toEqual(TOKEN_REQUIRED);
      expect(Object.keys(res.body).sort()).toEqual(['error', 'error_description']);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`revoke empty-string token binds token is required soft-${i}`, async () => {
      const res = await request('/oauth/revoke', urlencoded({ token: '' }), makeEnv());
      expect(res.status).toBe(400);
      expect(res.body).toEqual(TOKEN_REQUIRED);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`introspect empty-string token binds token is required soft-${i}`, async () => {
      const res = await request('/oauth/introspect', urlencoded({ token: '' }), makeEnv());
      expect(res.status).toBe(400);
      expect(res.body).toEqual(TOKEN_REQUIRED);
    });
  }

  it('revoke missing∥introspect missing∥revoke ok∥introspect inactive under Promise.all', async () => {
    const sessions = mockKv();
    seedRefresh(sessions, 'alive-refresh');
    const env = makeEnv({ sessions });
    const results = await Promise.all([
      request('/oauth/revoke', urlencoded({}), env),
      request('/oauth/introspect', urlencoded({}), env),
      request('/oauth/revoke', urlencoded({ token: 'alive-refresh' }), env),
      request('/oauth/introspect', urlencoded({ token: 'ghost' }), env),
    ]);
    expect(results[0].body).toEqual(TOKEN_REQUIRED);
    expect(results[1].body).toEqual(TOKEN_REQUIRED);
    expect(results[2].status).toBe(200);
    expect(results[2].body).toBeNull();
    expect(results[3].status).toBe(200);
    expect(results[3].body).toEqual({ active: false });
    expect(Object.keys(results[3].body).sort()).toEqual(['active']);
  });
});

// ---------------------------------------------------------------------------
// Cross-gate soft residual matrix under Promise.all
// ---------------------------------------------------------------------------

describe('oauth soft residual cross-gate matrix after #277', () => {
  it('Only-code∥Unknown-client∥unsupported-grant∥token-required exclusive binds', async () => {
    const cache = mockKv();
    seedClient(cache, 'cid-x');
    const env = makeEnv({ cache });
    const results = await Promise.all([
      request(
        `/oauth/authorize?client_id=cid-x&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=token`,
        {},
        env
      ),
      request(
        `/oauth/authorize?client_id=nope&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`,
        {},
        env
      ),
      request(
        '/oauth/token',
        urlencoded({ grant_type: 'implicit', client_id: 'cid-x' }),
        env
      ),
      request('/oauth/introspect', urlencoded({}), env),
    ]);
    expect(results[0].body).toEqual(ONLY_CODE_RESPONSE);
    expect(results[1].body).toEqual(UNKNOWN_CLIENT_AUTHORIZE);
    expect(results[2].body).toEqual(UNSUPPORTED_GRANT);
    expect(results[3].body).toEqual(TOKEN_REQUIRED);
  });

  for (let i = 0; i < 6; i++) {
    it(`cross-gate flood Only-code∥Unknown-token∥expired-auth∥redirect_uris soft-${i}`, async () => {
      const cache = mockKv();
      seedClient(cache, `cid-xf-${i}`);
      const env = makeEnv({ cache, sessions: mockKv() });
      const results = await Promise.all([
        request(
          `/oauth/authorize?client_id=cid-xf-${i}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code%20id_token`,
          {},
          env
        ),
        request(
          '/oauth/token',
          urlencoded({
            grant_type: 'authorization_code',
            client_id: `ghost-xf-${i}`,
            code: 'x',
          }),
          env
        ),
        request(
          '/oauth/authorize',
          formInit({ username: 'alice', password: PASS, auth_request_id: `miss-${i}` }),
          env
        ),
        request('/oauth/register', jsonInit('POST', { client_name: `x-${i}` }), env),
      ]);
      expect(results[0].body).toEqual(ONLY_CODE_RESPONSE);
      expect(results[1].body).toEqual(UNKNOWN_CLIENT_TOKEN);
      expect(results[2].body).toEqual(AUTH_EXPIRED);
      expect(results[3].body).toEqual(REDIRECT_URIS_REQUIRED);
    });
  }
});
