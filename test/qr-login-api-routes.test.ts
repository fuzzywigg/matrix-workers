/**
 * TOKENMAXX HEAVY deepen after #113 — companion auth-login slice: QR login landing.
 * Pairs with oidc-auth-api-routes.test.ts; avoids media (#109/#113).
 * Covers src/api/qr-login.ts via Hono app.request(): HTML landing + /check JSON.
 * Tests-only — no product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { hashToken } from '../src/utils/crypto';

import qrLogin from '../src/api/qr-login';

const SERVER = 'example.com';
const USER = '@alice:example.com';
const NOW = 1_730_000_000_000;
const VALID_TOKEN = 'mlt_testtoken_abc123xyz';

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
    puts: KvPut[];
    deletes: string[];
  };
}

function envFor(sessions: ReturnType<typeof mockKv> = mockKv(), serverName = SERVER): Env {
  return {
    SESSIONS: sessions,
    SERVER_NAME: serverName,
  } as unknown as Env;
}

async function putLoginToken(
  sessions: ReturnType<typeof mockKv>,
  token: string,
  partial: { user_id?: string; expires_at?: number } = {}
): Promise<string> {
  const tokenHash = await hashToken(token);
  const key = `login_token:${tokenHash}`;
  sessions.data[key] = JSON.stringify({
    user_id: partial.user_id ?? USER,
    expires_at: partial.expires_at ?? NOW + 10 * 60_000,
  });
  return key;
}

async function request(
  path: string,
  init: RequestInit = {},
  env: Env = envFor()
): Promise<{ status: number; body: unknown; text: string; headers: Headers }> {
  const res = await qrLogin.request(`https://${SERVER}${path}`, init, env);
  const ct = res.headers.get('content-type') || '';
  let body: unknown = null;
  let text = '';
  if (ct.includes('application/json')) {
    body = await res.json();
    text = JSON.stringify(body);
  } else {
    text = await res.text();
    body = text;
  }
  return { status: res.status, body, text, headers: res.headers };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// GET /login/qr/:token — HTML landing
// ---------------------------------------------------------------------------

describe('GET /login/qr/:token', () => {
  it('returns 400 Invalid Token HTML when token lacks mlt_ prefix', async () => {
    const { status, text } = await request('/login/qr/not-a-login-token');
    expect(status).toBe(400);
    expect(text).toContain('Invalid Token');
    expect(text).toContain('invalid or has been tampered');
  });

  it('returns 400 Invalid Token for empty-looking path segment that is not mlt_', async () => {
    const { status, text } = await request('/login/qr/ml');
    expect(status).toBe(400);
    expect(text).toContain('Invalid Token');
  });

  it('returns 400 Token Expired HTML when KV entry missing', async () => {
    const { status, text } = await request(`/login/qr/${VALID_TOKEN}`, {}, envFor(mockKv()));
    expect(status).toBe(400);
    expect(text).toContain('Token Expired');
    expect(text).toContain('expired or has already been used');
  });

  it('returns 400, deletes KV, when expires_at is in the past', async () => {
    const sessions = mockKv();
    const key = await putLoginToken(sessions, VALID_TOKEN, { expires_at: NOW - 1 });
    const { status, text } = await request(`/login/qr/${VALID_TOKEN}`, {}, envFor(sessions));
    expect(status).toBe(400);
    expect(text).toContain('Token Expired');
    expect(text).toContain('This login link has expired.');
    expect(sessions.deletes).toContain(key);
    expect(sessions.data[key]).toBeUndefined();
  });

  it('treats expires_at === now as still valid (strict Date.now() > expires_at)', async () => {
    const sessions = mockKv();
    await putLoginToken(sessions, VALID_TOKEN, { expires_at: NOW });
    const { status, text } = await request(`/login/qr/${VALID_TOKEN}`, {}, envFor(sessions));
    expect(status).toBe(200);
    expect(text).toContain('Welcome!');
    // Math.max(0, ceil(0)) → 0 minutes remaining copy
    expect(text).toContain('Token expires in 0 minutes');
  });

  it('renders landing HTML with user, token, homeserver, and expiry minutes', async () => {
    const sessions = mockKv();
    await putLoginToken(sessions, VALID_TOKEN, {
      user_id: USER,
      expires_at: NOW + 5 * 60_000,
    });
    const { status, text, headers } = await request(
      `/login/qr/${VALID_TOKEN}`,
      {},
      envFor(sessions)
    );
    expect(status).toBe(200);
    expect(headers.get('content-type')).toMatch(/text\/html/);
    expect(text).toContain('Welcome!');
    expect(text).toContain(SERVER);
    expect(text).toContain(USER);
    expect(text).toContain(VALID_TOKEN);
    expect(text).toContain('https://example.com');
    expect(text).toContain('Token expires in 5 minutes');
    expect(text).toContain('Open in Element');
    expect(text).toContain('app.element.io');
  });

  it('uses singular "minute" when exactly 1 minute remains', async () => {
    const sessions = mockKv();
    await putLoginToken(sessions, VALID_TOKEN, { expires_at: NOW + 60_000 });
    const { text } = await request(`/login/qr/${VALID_TOKEN}`, {}, envFor(sessions));
    expect(text).toContain('Token expires in 1 minute');
    expect(text).not.toContain('1 minutes');
  });

  it('ceils fractional remaining minutes (90s → 2 minutes)', async () => {
    const sessions = mockKv();
    await putLoginToken(sessions, VALID_TOKEN, { expires_at: NOW + 90_000 });
    const { text } = await request(`/login/qr/${VALID_TOKEN}`, {}, envFor(sessions));
    expect(text).toContain('Token expires in 2 minutes');
  });

  it('embeds expiresAt epoch in page script for client timer', async () => {
    const sessions = mockKv();
    const expiresAt = NOW + 600_000;
    await putLoginToken(sessions, VALID_TOKEN, { expires_at: expiresAt });
    const { text } = await request(`/login/qr/${VALID_TOKEN}`, {}, envFor(sessions));
    expect(text).toContain(`const expiresAt = ${expiresAt};`);
    expect(text).toContain(`const token = "${VALID_TOKEN}";`);
  });

  it('does not delete KV on successful landing', async () => {
    const sessions = mockKv();
    const key = await putLoginToken(sessions, VALID_TOKEN);
    await request(`/login/qr/${VALID_TOKEN}`, {}, envFor(sessions));
    expect(sessions.deletes).toHaveLength(0);
    expect(sessions.data[key]).toBeDefined();
  });

  it('looks up token via SHA-256 hash key login_token:<hash>', async () => {
    const sessions = mockKv();
    const token = 'mlt_hashlookup_token';
    const expectedKey = `login_token:${await hashToken(token)}`;
    sessions.data[expectedKey] = JSON.stringify({
      user_id: '@bob:example.com',
      expires_at: NOW + 120_000,
    });
    // Wrong key must not match
    sessions.data['login_token:not-the-hash'] = JSON.stringify({
      user_id: '@eve:example.com',
      expires_at: NOW + 120_000,
    });
    const { text } = await request(`/login/qr/${token}`, {}, envFor(sessions));
    expect(text).toContain('@bob:example.com');
    expect(text).not.toContain('@eve:example.com');
  });

  it('reflects custom SERVER_NAME in title and homeserver URL', async () => {
    const sessions = mockKv();
    await putLoginToken(sessions, VALID_TOKEN);
    const { text } = await request(
      `/login/qr/${VALID_TOKEN}`,
      {},
      envFor(sessions, 'matrix.example.org')
    );
    expect(text).toContain('Login to matrix.example.org');
    expect(text).toContain('https://matrix.example.org');
  });

  it('HTML-escapes are not applied (values interpolated raw) — fixture without HTML metacharacters', async () => {
    const sessions = mockKv();
    await putLoginToken(sessions, VALID_TOKEN, { user_id: '@safe_user:example.com' });
    const { text } = await request(`/login/qr/${VALID_TOKEN}`, {}, envFor(sessions));
    expect(text).toContain('@safe_user:example.com');
  });

  it('rejects token that starts with mlt but wrong full prefix mlt_', async () => {
    // "mltX..." does not start with "mlt_"
    const { status, text } = await request('/login/qr/mltX_bad');
    expect(status).toBe(400);
    expect(text).toContain('Invalid Token');
  });

  it('accepts long mlt_ tokens that exist in KV', async () => {
    const token = `mlt_${'a'.repeat(64)}`;
    const sessions = mockKv();
    await putLoginToken(sessions, token, { user_id: USER, expires_at: NOW + 180_000 });
    const { status, text } = await request(`/login/qr/${token}`, {}, envFor(sessions));
    expect(status).toBe(200);
    expect(text).toContain(token);
  });
});

// ---------------------------------------------------------------------------
// GET /login/qr/:token/check — JSON validity
// ---------------------------------------------------------------------------

describe('GET /login/qr/:token/check', () => {
  it('returns 400 JSON for invalid token format', async () => {
    const { status, body } = await request('/login/qr/badtoken/check');
    expect(status).toBe(400);
    expect(body).toEqual({ valid: false, error: 'Invalid token format' });
  });

  it('returns 404 when token not in KV', async () => {
    const { status, body } = await request(
      `/login/qr/${VALID_TOKEN}/check`,
      {},
      envFor(mockKv())
    );
    expect(status).toBe(404);
    expect(body).toEqual({ valid: false, error: 'Token not found or expired' });
  });

  it('returns 400 when token expired (does not delete on check path)', async () => {
    const sessions = mockKv();
    const key = await putLoginToken(sessions, VALID_TOKEN, { expires_at: NOW - 1000 });
    const { status, body } = await request(
      `/login/qr/${VALID_TOKEN}/check`,
      {},
      envFor(sessions)
    );
    expect(status).toBe(400);
    expect(body).toEqual({ valid: false, error: 'Token expired' });
    expect(sessions.deletes).toHaveLength(0);
    expect(sessions.data[key]).toBeDefined();
  });

  it('treats expires_at === now as valid on check path', async () => {
    const sessions = mockKv();
    await putLoginToken(sessions, VALID_TOKEN, { expires_at: NOW });
    const { status, body } = await request(
      `/login/qr/${VALID_TOKEN}/check`,
      {},
      envFor(sessions)
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ valid: true, expires_at: NOW });
  });

  it('returns valid payload with user_id, homeserver, expires_at', async () => {
    const sessions = mockKv();
    const expiresAt = NOW + 300_000;
    await putLoginToken(sessions, VALID_TOKEN, {
      user_id: '@carol:example.com',
      expires_at: expiresAt,
    });
    const { status, body, headers } = await request(
      `/login/qr/${VALID_TOKEN}/check`,
      {},
      envFor(sessions)
    );
    expect(status).toBe(200);
    expect(headers.get('content-type')).toMatch(/application\/json/);
    expect(body).toEqual({
      valid: true,
      user_id: '@carol:example.com',
      homeserver: SERVER,
      expires_at: expiresAt,
    });
  });

  it('homeserver reflects SERVER_NAME env', async () => {
    const sessions = mockKv();
    await putLoginToken(sessions, VALID_TOKEN);
    const { body } = await request(
      `/login/qr/${VALID_TOKEN}/check`,
      {},
      envFor(sessions, 'hs.example.net')
    );
    expect(body).toMatchObject({ valid: true, homeserver: 'hs.example.net' });
  });

  it('does not expose token hash or raw KV key in response', async () => {
    const sessions = mockKv();
    await putLoginToken(sessions, VALID_TOKEN);
    const { text } = await request(`/login/qr/${VALID_TOKEN}/check`, {}, envFor(sessions));
    expect(text).not.toContain('login_token:');
    expect(text).not.toMatch(/[a-f0-9]{64}/); // sha256 hex not leaked
  });

  it('invalid format short-circuits before KV get', async () => {
    const sessions = mockKv();
    const getSpy = vi.spyOn(sessions, 'get');
    await request('/login/qr/nope/check', {}, envFor(sessions));
    expect(getSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cross-path / leftover edges
// ---------------------------------------------------------------------------

describe('qr-login TOKENMAXX leftovers after #113', () => {
  it('landing then check both succeed for same unexpired token', async () => {
    const sessions = mockKv();
    await putLoginToken(sessions, VALID_TOKEN, { expires_at: NOW + 120_000 });
    const land = await request(`/login/qr/${VALID_TOKEN}`, {}, envFor(sessions));
    const check = await request(`/login/qr/${VALID_TOKEN}/check`, {}, envFor(sessions));
    expect(land.status).toBe(200);
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({ valid: true, user_id: USER });
  });

  it('expired landing deletes token so subsequent check is 404', async () => {
    const sessions = mockKv();
    await putLoginToken(sessions, VALID_TOKEN, { expires_at: NOW - 1 });
    const land = await request(`/login/qr/${VALID_TOKEN}`, {}, envFor(sessions));
    expect(land.status).toBe(400);
    const check = await request(`/login/qr/${VALID_TOKEN}/check`, {}, envFor(sessions));
    expect(check.status).toBe(404);
  });

  it('check expired leaves token so landing can still clean it up', async () => {
    const sessions = mockKv();
    const key = await putLoginToken(sessions, VALID_TOKEN, { expires_at: NOW - 5 });
    const check = await request(`/login/qr/${VALID_TOKEN}/check`, {}, envFor(sessions));
    expect(check.status).toBe(400);
    expect(sessions.data[key]).toBeDefined();
    const land = await request(`/login/qr/${VALID_TOKEN}`, {}, envFor(sessions));
    expect(land.status).toBe(400);
    expect(sessions.data[key]).toBeUndefined();
  });

  it('different tokens do not collide under hashed keys', async () => {
    const sessions = mockKv();
    const t1 = 'mlt_token_one';
    const t2 = 'mlt_token_two';
    await putLoginToken(sessions, t1, { user_id: '@one:example.com' });
    await putLoginToken(sessions, t2, { user_id: '@two:example.com' });
    const c1 = await request(`/login/qr/${t1}/check`, {}, envFor(sessions));
    const c2 = await request(`/login/qr/${t2}/check`, {}, envFor(sessions));
    expect(c1.body).toMatchObject({ user_id: '@one:example.com' });
    expect(c2.body).toMatchObject({ user_id: '@two:example.com' });
  });

  it('POST to landing path is not allowed', async () => {
    const { status } = await request(`/login/qr/${VALID_TOKEN}`, { method: 'POST' });
    expect(status).toBeGreaterThanOrEqual(400);
  });

  it('zero remaining minutes clamps display via Math.max(0, …) when somehow future-skewed', async () => {
    // expires_at just barely after now still shows at least 1 via ceil of small positive
    const sessions = mockKv();
    await putLoginToken(sessions, VALID_TOKEN, { expires_at: NOW + 1 });
    const { text } = await request(`/login/qr/${VALID_TOKEN}`, {}, envFor(sessions));
    expect(text).toContain('Token expires in 1 minute');
  });

  it('manual login section includes Log in with token hint', async () => {
    const sessions = mockKv();
    await putLoginToken(sessions, VALID_TOKEN);
    const { text } = await request(`/login/qr/${VALID_TOKEN}`, {}, envFor(sessions));
    expect(text).toContain('Log in with token');
    expect(text).toContain('Manual Login Details');
  });
});
