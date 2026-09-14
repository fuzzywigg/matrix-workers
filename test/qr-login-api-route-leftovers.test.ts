/**
 * TOKENMAXX HEAVY leftovers after #140 — QR login landing/check failure + reliability edges.
 * Complements qr-login-api-routes.test.ts. Tests-only — src/api/qr-login.ts via Hono app.request().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { hashToken } from '../src/utils/crypto';
import qrLogin from '../src/api/qr-login';

const SERVER = 'example.com';
const USER = '@alice:example.com';
const NOW = 1_730_000_000_000;
const TOKEN = 'mlt_leftover_token_xyz';

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };

function mockKv(data: Record<string, string> = {}) {
  const puts: KvPut[] = [];
  const deletes: string[] = [];
  const gets: string[] = [];
  const kv = {
    data,
    puts,
    deletes,
    gets,
    get: async (key: string, type?: string) => {
      gets.push(key);
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
    gets: string[];
  };
}

function envFor(sessions: ReturnType<typeof mockKv> = mockKv(), serverName = SERVER): Env {
  return { SESSIONS: sessions, SERVER_NAME: serverName } as unknown as Env;
}

async function putLoginToken(
  sessions: ReturnType<typeof mockKv>,
  token: string,
  partial: { user_id?: string; expires_at?: number } = {}
) {
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
): Promise<{ status: number; body: any; text: string; headers: Headers }> {
  const res = await qrLogin.request(`https://${SERVER}${path}`, init, env);
  const text = await res.text();
  let body: any = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json') && text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  } else if (text.startsWith('{')) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: res.status, body, text, headers: res.headers };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('qr leftovers landing — invalid token format matrix', () => {
  const bad = ['mlt', 'mlt-', 'MLT_abc', 'mlt abc', 'xlt_abc', 'token', 'notmlt_token', 'Mlt_token'];
  for (const [i, tok] of bad.entries()) {
    it(`rejects bad format case-${i} (${tok})`, async () => {
      const { status, text } = await request(`/login/qr/${encodeURIComponent(tok)}`);
      expect(status).toBe(400);
      expect(text).toContain('Invalid Token');
    });
  }

  it('mlt_ alone is valid prefix but missing KV → Token Expired', async () => {
    const { status, text } = await request('/login/qr/mlt_');
    expect(status).toBe(400);
    expect(text).toContain('Token Expired');
  });
});

describe('qr leftovers check — invalid token format matrix', () => {
  for (const tok of ['nope', 'mlt', 'MLT_x', 'mlt-x', 'abc']) {
    it(`check rejects ${tok}`, async () => {
      const sessions = mockKv();
      const { status, body } = await request(
        `/login/qr/${encodeURIComponent(tok)}/check`,
        {},
        envFor(sessions)
      );
      expect(status).toBe(400);
      expect(body).toMatchObject({ valid: false, error: 'Invalid token format' });
      expect(sessions.gets).toHaveLength(0);
    });
  }
});

describe('qr leftovers expiry boundaries', () => {
  it('landing expires at now-1 deletes token', async () => {
    const sessions = mockKv();
    const key = await putLoginToken(sessions, TOKEN, { expires_at: NOW - 1 });
    const { status, text } = await request(`/login/qr/${TOKEN}`, {}, envFor(sessions));
    expect(status).toBe(400);
    expect(text).toContain('Token Expired');
    expect(sessions.deletes).toContain(key);
    expect(sessions.data[key]).toBeUndefined();
  });

  it('check expired does not delete', async () => {
    const sessions = mockKv();
    const key = await putLoginToken(sessions, TOKEN, { expires_at: NOW - 1 });
    const { status, body } = await request(`/login/qr/${TOKEN}/check`, {}, envFor(sessions));
    expect(status).toBe(400);
    expect(body).toMatchObject({ valid: false, error: 'Token expired' });
    expect(sessions.deletes).toHaveLength(0);
    expect(sessions.data[key]).toBeTruthy();
  });

  it('expires_at === now still valid on both paths', async () => {
    const sessions = mockKv();
    await putLoginToken(sessions, TOKEN, { expires_at: NOW });
    const land = await request(`/login/qr/${TOKEN}`, {}, envFor(sessions));
    expect(land.status).toBe(200);
    expect(land.text).toContain(USER);
    const check = await request(`/login/qr/${TOKEN}/check`, {}, envFor(sessions));
    expect(check.status).toBe(200);
    expect(check.body.valid).toBe(true);
  });

  it('1ms remaining displays as 1 minute', async () => {
    const sessions = mockKv();
    await putLoginToken(sessions, TOKEN, { expires_at: NOW + 1 });
    const { text } = await request(`/login/qr/${TOKEN}`, {}, envFor(sessions));
    expect(text).toContain('Token expires in 1 minute');
    expect(text).not.toContain('1 minutes');
  });

  it('minute pluralization boundary grid', async () => {
    const cases: Array<[number, string]> = [
      [59_999, 'Token expires in 1 minute'],
      [60_000, 'Token expires in 1 minute'],
      [60_001, 'Token expires in 2 minutes'],
      [120_000, 'Token expires in 2 minutes'],
      [120_001, 'Token expires in 3 minutes'],
    ];
    for (const [delta, expected] of cases) {
      const sessions = mockKv();
      await putLoginToken(sessions, TOKEN, { expires_at: NOW + delta });
      const { text } = await request(`/login/qr/${TOKEN}`, {}, envFor(sessions));
      expect(text).toContain(expected);
    }
  });
});

describe('qr leftovers SERVER_NAME / user_id reflection', () => {
  it('embeds custom SERVER_NAME in title and homeserver URL', async () => {
    const sessions = mockKv();
    await putLoginToken(sessions, TOKEN);
    const env = envFor(sessions, 'matrix.fuzzy.test');
    const { text } = await request(`/login/qr/${TOKEN}`, {}, env);
    expect(text).toContain('Login to matrix.fuzzy.test');
    expect(text).toContain('https://matrix.fuzzy.test');
  });

  it('check homeserver is bare SERVER_NAME', async () => {
    const sessions = mockKv();
    await putLoginToken(sessions, TOKEN);
    const { body } = await request(`/login/qr/${TOKEN}/check`, {}, envFor(sessions, 'hs.example'));
    expect(body.homeserver).toBe('hs.example');
    expect(body.user_id).toBe(USER);
    expect(body.expires_at).toBe(NOW + 10 * 60_000);
  });

  it('reflects alternate user_id from KV', async () => {
    const sessions = mockKv();
    await putLoginToken(sessions, TOKEN, { user_id: '@bob:example.com' });
    const land = await request(`/login/qr/${TOKEN}`, {}, envFor(sessions));
    expect(land.text).toContain('@bob:example.com');
    const check = await request(`/login/qr/${TOKEN}/check`, {}, envFor(sessions));
    expect(check.body.user_id).toBe('@bob:example.com');
  });
});

describe('qr leftovers method and path reliability', () => {
  it('POST/PUT/DELETE landing not allowed', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const { status } = await request(`/login/qr/${TOKEN}`, { method });
      expect(status).toBe(404);
    }
  });

  it('POST check not allowed', async () => {
    const { status } = await request(`/login/qr/${TOKEN}/check`, { method: 'POST' });
    expect(status).toBe(404);
  });

  it('missing KV → landing expired HTML; check 404 JSON', async () => {
    const land = await request(`/login/qr/${TOKEN}`);
    expect(land.status).toBe(400);
    expect(land.text).toContain('Token Expired');
    const check = await request(`/login/qr/${TOKEN}/check`);
    expect(check.status).toBe(404);
    expect(check.body).toMatchObject({ valid: false, error: 'Token not found or expired' });
  });

  it('hashed key lookup uses hashToken of raw path token', async () => {
    const sessions = mockKv();
    const key = await putLoginToken(sessions, TOKEN);
    expect(key).toBe(`login_token:${await hashToken(TOKEN)}`);
    await request(`/login/qr/${TOKEN}`, {}, envFor(sessions));
    expect(sessions.gets[0]).toBe(key);
  });
});

describe('qr leftovers lifecycle reliability', () => {
  it('landing success then check success then expire deletes', async () => {
    const sessions = mockKv();
    const key = await putLoginToken(sessions, TOKEN, { expires_at: NOW + 5_000 });
    expect((await request(`/login/qr/${TOKEN}`, {}, envFor(sessions))).status).toBe(200);
    expect((await request(`/login/qr/${TOKEN}/check`, {}, envFor(sessions))).body.valid).toBe(true);
    vi.setSystemTime(NOW + 5_001);
    const expired = await request(`/login/qr/${TOKEN}`, {}, envFor(sessions));
    expect(expired.status).toBe(400);
    expect(sessions.deletes).toContain(key);
    expect((await request(`/login/qr/${TOKEN}/check`, {}, envFor(sessions))).status).toBe(404);
  });

  it('distinct tokens remain isolated under hash keys', async () => {
    const sessions = mockKv();
    const a = 'mlt_token_aaa';
    const b = 'mlt_token_bbb';
    await putLoginToken(sessions, a, { user_id: '@a:example.com' });
    await putLoginToken(sessions, b, { user_id: '@b:example.com' });
    const ra = await request(`/login/qr/${a}/check`, {}, envFor(sessions));
    const rb = await request(`/login/qr/${b}/check`, {}, envFor(sessions));
    expect(ra.body.user_id).toBe('@a:example.com');
    expect(rb.body.user_id).toBe('@b:example.com');
  });

  it('check-expired then landing still cleans up', async () => {
    const sessions = mockKv();
    const key = await putLoginToken(sessions, TOKEN, { expires_at: NOW - 5 });
    const check = await request(`/login/qr/${TOKEN}/check`, {}, envFor(sessions));
    expect(check.status).toBe(400);
    expect(sessions.data[key]).toBeTruthy();
    const land = await request(`/login/qr/${TOKEN}`, {}, envFor(sessions));
    expect(land.status).toBe(400);
    expect(sessions.deletes).toContain(key);
  });
});

describe('qr leftovers token charset / length flood', () => {
  const samples = [
    'mlt_' + 'a'.repeat(8),
    'mlt_' + 'a'.repeat(64),
    'mlt_' + 'a'.repeat(128),
    'mlt_.-_~',
    'mlt_1234567890',
    'mlt_MiXeDcAsE',
  ];
  for (const [i, tok] of samples.entries()) {
    it(`valid-prefix missing KV flood-${i}`, async () => {
      const { status, text } = await request(`/login/qr/${encodeURIComponent(tok)}`);
      expect(status).toBe(400);
      expect(text).toContain('Token Expired');
    });
  }

  for (const [i, tok] of ['', 'x', 'ml', 'mlt', 'MLT_', ' token'].entries()) {
    it(`invalid-prefix flood-${i}`, async () => {
      const pathTok = tok === '' ? ' ' : tok;
      const { status, text } = await request(`/login/qr/${encodeURIComponent(pathTok)}`);
      expect(status).toBe(400);
      expect(text).toMatch(/Invalid Token|Token Expired/);
    });
  }
});
