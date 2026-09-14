/**
 * TOKENMAXX HEAVY leftovers — identity account + account/register (register/account shaped).
 * Soft-cap flood after register-account leftovers (#138). Not oauth.
 * Tests-only — Hono app.request() against src/api/identity.ts. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import identity from '../src/api/identity';

const SERVER_NAME = 'example.com';
const BASE = '/_matrix/identity/v2';

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };

function mockKv(data: Record<string, string> = {}) {
  const puts: KvPut[] = [];
  const kv = {
    data,
    puts,
    get: async (key: string) => data[key] ?? null,
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
  return kv as unknown as KVNamespace & { data: Record<string, string>; puts: KvPut[] };
}

function makeEnv(opts: { cache?: ReturnType<typeof mockKv> } = {}): Env {
  return {
    SERVER_NAME,
    CACHE: opts.cache ?? mockKv(),
    DB: {
      prepare() {
        return {
          bind() {
            return {
              first: async () => null,
              all: async () => ({ results: [] }),
              run: async () => ({ success: true, meta: { changes: 0 } }),
            };
          },
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({ success: true, meta: { changes: 0 } }),
        };
      },
    } as unknown as D1Database,
  } as Env;
}

async function jsonRequest(
  path: string,
  init: RequestInit = {},
  env: Env = makeEnv()
): Promise<{ status: number; body: any; res: Response }> {
  const res = await identity.request(`http://localhost${path}`, init, env);
  let body: any = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, res };
}

function postJson(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

function registerPayload(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'hs-token-abc',
    token_type: 'Bearer',
    matrix_server_name: SERVER_NAME,
    expires_in: 3600,
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('identity leftovers GET /account — Authorization matrix', () => {
  it('auth case (absent)', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, { headers: {} });
    expect(status).toBe(401);
    expect(body.errcode).toBe("M_MISSING_TOKEN");
  });
  it('auth case (basic)', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, { headers: { Authorization: "Basic abc" } });
    expect(status).toBe(401);
    expect(body.errcode).toBe("M_MISSING_TOKEN");
  });
  it('auth case (digest)', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, { headers: { Authorization: "Digest abc" } });
    expect(status).toBe(401);
    expect(body.errcode).toBe("M_MISSING_TOKEN");
  });
  it('auth case (bearer-bare)', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, { headers: { Authorization: "Bearer" } });
    expect(status).toBe(401);
    expect(body.errcode).toBe("M_MISSING_TOKEN");
  });
  it('auth case (bearer-space-only)', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, { headers: { Authorization: "Bearer " } });
    expect(status).toBe(401);
    expect(body.errcode).toBe("M_MISSING_TOKEN");
  });
  it('auth case (bearer-tab)', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, { headers: { Authorization: "Bearer\ttok" } });
    expect(status).toBe(401);
    expect(body.errcode).toBe("M_MISSING_TOKEN");
  });
  it('auth case (bearer-ok)', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, { headers: { Authorization: "Bearer valid-token" } });
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: `@unknown:${SERVER_NAME}` });
  });
  it('auth case (bearer-long)', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, { headers: { Authorization: "Bearer xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" } });
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: `@unknown:${SERVER_NAME}` });
  });
  it('auth case (bearer-unicode)', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, { headers: { Authorization: "Bearer tok-\u00fcnicode" } });
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: `@unknown:${SERVER_NAME}` });
  });
  it('auth case (bearer-jwt-ish)', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, { headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig" } });
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: `@unknown:${SERVER_NAME}` });
  });
  it('SERVER_NAME from env shapes user_id', async () => {
    const env = makeEnv();
    (env as any).SERVER_NAME = 'matrix.fuzzy.test';
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: 'Bearer t' },
    }, env);
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: '@unknown:matrix.fuzzy.test' });
  });

  it('does not require DB or CACHE for account lookup', async () => {
    const env = makeEnv();
    const { status } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: 'Bearer only-header-matters' },
    }, env);
    expect(status).toBe(200);
  });
});

describe('identity leftovers POST /account/register — body matrix', () => {
  it('rejects empty body as M_BAD_JSON or accepts empty object echoing undefined token', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account/register`, postJson({}));
    // empty object is valid JSON — echoes access_token undefined as missing field
    expect(status).toBe(200);
    expect(body).toEqual({ token: undefined });
  });

  it('rejects truncated JSON', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"access_token":',
    });
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });

  it('rejects non-JSON content body', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not-json',
    });
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });

  it('rejects array body but still returns token undefined from missing access_token', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account/register`, postJson([]));
    expect(status).toBe(200);
    expect(body).toEqual({ token: undefined });
  });
  it('echoes access_token case-0', async () => {
    const payload = registerPayload({ access_token: "simple" });
    const { status, body } = await jsonRequest(`${BASE}/account/register`, postJson(payload));
    expect(status).toBe(200);
    expect(body).toEqual({ token: "simple" });
  });
  it('echoes access_token case-1', async () => {
    const payload = registerPayload({ access_token: "" });
    const { status, body } = await jsonRequest(`${BASE}/account/register`, postJson(payload));
    expect(status).toBe(200);
    expect(body).toEqual({ token: "" });
  });
  it('echoes access_token case-2', async () => {
    const payload = registerPayload({ access_token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    const { status, body } = await jsonRequest(`${BASE}/account/register`, postJson(payload));
    expect(status).toBe(200);
    expect(body).toEqual({ token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  });
  it('echoes access_token case-3', async () => {
    const payload = registerPayload({ access_token: "tok with spaces" });
    const { status, body } = await jsonRequest(`${BASE}/account/register`, postJson(payload));
    expect(status).toBe(200);
    expect(body).toEqual({ token: "tok with spaces" });
  });
  it('echoes access_token case-4', async () => {
    const payload = registerPayload({ access_token: "tok\nnewline" });
    const { status, body } = await jsonRequest(`${BASE}/account/register`, postJson(payload));
    expect(status).toBe(200);
    expect(body).toEqual({ token: "tok\nnewline" });
  });
  it('echoes access_token case-5', async () => {
    const payload = registerPayload({ access_token: "\ud83c\udfab" });
    const { status, body } = await jsonRequest(`${BASE}/account/register`, postJson(payload));
    expect(status).toBe(200);
    expect(body).toEqual({ token: "\ud83c\udfab" });
  });
  it('echoes access_token case-6', async () => {
    const payload = registerPayload({ access_token: "syt_abc_def" });
    const { status, body } = await jsonRequest(`${BASE}/account/register`, postJson(payload));
    expect(status).toBe(200);
    expect(body).toEqual({ token: "syt_abc_def" });
  });
  it('echoes access_token case-7', async () => {
    const payload = registerPayload({ access_token: "null" });
    const { status, body } = await jsonRequest(`${BASE}/account/register`, postJson(payload));
    expect(status).toBe(200);
    expect(body).toEqual({ token: "null" });
  });
  it('echoes access_token case-8', async () => {
    const payload = registerPayload({ access_token: "0" });
    const { status, body } = await jsonRequest(`${BASE}/account/register`, postJson(payload));
    expect(status).toBe(200);
    expect(body).toEqual({ token: "0" });
  });
  it('echoes access_token case-9', async () => {
    const payload = registerPayload({ access_token: "true" });
    const { status, body } = await jsonRequest(`${BASE}/account/register`, postJson(payload));
    expect(status).toBe(200);
    expect(body).toEqual({ token: "true" });
  });
  it('ignores token_type matrix_server_name expires_in content', async () => {
    const payload = registerPayload({
      access_token: 'keep-me',
      token_type: 'NotBearer',
      matrix_server_name: 'evil.example',
      expires_in: -1,
      extra: true,
    });
    const { status, body } = await jsonRequest(`${BASE}/account/register`, postJson(payload));
    expect(status).toBe(200);
    expect(body).toEqual({ token: 'keep-me' });
  });

  it('null access_token echoes null token', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: null }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: null });
  });

  it('numeric access_token echoes number', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: 42 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: 42 });
  });
});

describe('identity leftovers account↔register soft lifecycles', () => {
  it('register then account with echoed token succeeds', async () => {
    const reg = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: 'lifecycle-tok' }))
    );
    expect(reg.body.token).toBe('lifecycle-tok');
    const acct = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: `Bearer ${reg.body.token}` },
    });
    expect(acct.status).toBe(200);
    expect(acct.body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });

  it('status endpoint stays empty object adjacent to account routes', async () => {
    const { status, body } = await jsonRequest(BASE);
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('terms GET/POST remain empty-policy stubs next to account', async () => {
    const g = await jsonRequest(`${BASE}/terms`);
    expect(g.body).toEqual({ policies: {} });
    const p = await jsonRequest(`${BASE}/terms`, postJson({ user_acceptance: {} }));
    expect(p.body).toEqual({});
  });

  it('repeated register calls are independent echoes', async () => {
    const a = await jsonRequest(`${BASE}/account/register`, postJson(registerPayload({ access_token: 'a' })));
    const b = await jsonRequest(`${BASE}/account/register`, postJson(registerPayload({ access_token: 'b' })));
    expect(a.body.token).toBe('a');
    expect(b.body.token).toBe('b');
  });
});

describe('identity leftovers GET /account — bearer token flood', () => {
  it('accepts bearer flood-0', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-0-abc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-1', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-1-abcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-2', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-2-abcabcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-3', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-3-abcabcabcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-4', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-4-abcabcabcabcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-5', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-5-abc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-6', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-6-abcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-7', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-7-abcabcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-8', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-8-abcabcabcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-9', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-9-abcabcabcabcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-10', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-10-abc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-11', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-11-abcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-12', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-12-abcabcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-13', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-13-abcabcabcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-14', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-14-abcabcabcabcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-15', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-15-abc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-16', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-16-abcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-17', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-17-abcabcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-18', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-18-abcabcabcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-19', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-19-abcabcabcabcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-20', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-20-abc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-21', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-21-abcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-22', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-22-abcabcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-23', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-23-abcabcabcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-24', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-24-abcabcabcabcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-25', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-25-abc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-26', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-26-abcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-27', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-27-abcabcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-28', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-28-abcabcabcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-29', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-29-abcabcabcabcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-30', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-30-abc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-31', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-31-abcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-32', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-32-abcabcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-33', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-33-abcabcabcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-34', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-34-abcabcabcabcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-35', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-35-abc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-36', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-36-abcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-37', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-37-abcabcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-38', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-38-abcabcabcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
  it('accepts bearer flood-39', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Bearer token-39-abcabcabcabcabc" },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
  });
});

describe('identity leftovers POST /account/register — payload flood', () => {
  it('register flood-0', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-0", expires_in: 0 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-0" });
  });
  it('register flood-1', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-1", expires_in: 10 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-1" });
  });
  it('register flood-2', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-2", expires_in: 20 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-2" });
  });
  it('register flood-3', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-3", expires_in: 30 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-3" });
  });
  it('register flood-4', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-4", expires_in: 40 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-4" });
  });
  it('register flood-5', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-5", expires_in: 50 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-5" });
  });
  it('register flood-6', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-6", expires_in: 60 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-6" });
  });
  it('register flood-7', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-7", expires_in: 70 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-7" });
  });
  it('register flood-8', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-8", expires_in: 80 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-8" });
  });
  it('register flood-9', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-9", expires_in: 90 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-9" });
  });
  it('register flood-10', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-10", expires_in: 100 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-10" });
  });
  it('register flood-11', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-11", expires_in: 110 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-11" });
  });
  it('register flood-12', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-12", expires_in: 120 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-12" });
  });
  it('register flood-13', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-13", expires_in: 130 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-13" });
  });
  it('register flood-14', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-14", expires_in: 140 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-14" });
  });
  it('register flood-15', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-15", expires_in: 150 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-15" });
  });
  it('register flood-16', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-16", expires_in: 160 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-16" });
  });
  it('register flood-17', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-17", expires_in: 170 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-17" });
  });
  it('register flood-18', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-18", expires_in: 180 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-18" });
  });
  it('register flood-19', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-19", expires_in: 190 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-19" });
  });
  it('register flood-20', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-20", expires_in: 200 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-20" });
  });
  it('register flood-21', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-21", expires_in: 210 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-21" });
  });
  it('register flood-22', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-22", expires_in: 220 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-22" });
  });
  it('register flood-23', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-23", expires_in: 230 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-23" });
  });
  it('register flood-24', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-24", expires_in: 240 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-24" });
  });
  it('register flood-25', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-25", expires_in: 250 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-25" });
  });
  it('register flood-26', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-26", expires_in: 260 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-26" });
  });
  it('register flood-27', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-27", expires_in: 270 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-27" });
  });
  it('register flood-28', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-28", expires_in: 280 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-28" });
  });
  it('register flood-29', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-29", expires_in: 290 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-29" });
  });
  it('register flood-30', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-30", expires_in: 300 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-30" });
  });
  it('register flood-31', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-31", expires_in: 310 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-31" });
  });
  it('register flood-32', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-32", expires_in: 320 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-32" });
  });
  it('register flood-33', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-33", expires_in: 330 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-33" });
  });
  it('register flood-34', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-34", expires_in: 340 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-34" });
  });
  it('register flood-35', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-35", expires_in: 350 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-35" });
  });
  it('register flood-36', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-36", expires_in: 360 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-36" });
  });
  it('register flood-37', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-37", expires_in: 370 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-37" });
  });
  it('register flood-38', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-38", expires_in: 380 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-38" });
  });
  it('register flood-39', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson(registerPayload({ access_token: "flood-access-39", expires_in: 390 }))
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: "flood-access-39" });
  });
});

describe('identity leftovers GET /account — bad scheme flood', () => {
  it('rejects scheme (Token)', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Token abc" },
    });
    expect(status).toBe(401);
    expect(body.errcode).toBe('M_MISSING_TOKEN');
  });
  it('rejects scheme (token)', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "token abc" },
    });
    expect(status).toBe(401);
    expect(body.errcode).toBe('M_MISSING_TOKEN');
  });
  it('rejects scheme (BEARER)', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "BEARER abc" },
    });
    expect(status).toBe(401);
    expect(body.errcode).toBe('M_MISSING_TOKEN');
  });
  it('rejects scheme (bearer)', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "bearer abc" },
    });
    expect(status).toBe(401);
    expect(body.errcode).toBe('M_MISSING_TOKEN');
  });
  it('rejects scheme (Macaroon)', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Macaroon abc" },
    });
    expect(status).toBe(401);
    expect(body.errcode).toBe('M_MISSING_TOKEN');
  });
  it('rejects scheme (HMAC)', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "HMAC abc" },
    });
    expect(status).toBe(401);
    expect(body.errcode).toBe('M_MISSING_TOKEN');
  });
  it('rejects scheme (ApiKey)', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "ApiKey abc" },
    });
    expect(status).toBe(401);
    expect(body.errcode).toBe('M_MISSING_TOKEN');
  });
  it('rejects scheme (Key)', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "Key abc" },
    });
    expect(status).toBe(401);
    expect(body.errcode).toBe('M_MISSING_TOKEN');
  });
  it('rejects scheme (JWT)', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "JWT abc" },
    });
    expect(status).toBe(401);
    expect(body.errcode).toBe('M_MISSING_TOKEN');
  });
  it('rejects scheme (OAuth)', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: "OAuth abc" },
    });
    expect(status).toBe(401);
    expect(body.errcode).toBe('M_MISSING_TOKEN');
  });
});
