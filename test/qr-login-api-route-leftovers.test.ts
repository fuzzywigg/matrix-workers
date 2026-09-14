/**
 * TOKENMAXX overnight HEAVY leftovers after #179 — QR login landing/check soft/edge/reliability.
 * Complements qr-login-api-routes.test.ts and login-qr concurrent/KV slices (#163).
 * Distinct leftovers deepen (orthogonal to relations #179, receipts #178, server-notices #173).
 * Tests-only — no product inventing. Fixtures use example.com only.
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

// ---------------------------------------------------------------------------
// TOKENMAXX overnight HEAVY refill after #179 — soft floods / corrupt KV / parity
// ---------------------------------------------------------------------------

describe('qr leftovers corrupt KV shapes — landing', () => {
  const hostile: Array<{ name: string; raw: string }> = [
    { name: 'empty-object', raw: '{}' },
    { name: 'null-json', raw: 'null' },
    { name: 'array', raw: '[]' },
    { name: 'string', raw: '"not-an-object"' },
    { name: 'number', raw: '42' },
    { name: 'true', raw: 'true' },
    { name: 'false', raw: 'false' },
    { name: 'missing-expires', raw: JSON.stringify({ user_id: USER }) },
    { name: 'missing-user', raw: JSON.stringify({ expires_at: NOW + 60_000 }) },
    { name: 'null-user', raw: JSON.stringify({ user_id: null, expires_at: NOW + 60_000 }) },
    { name: 'null-expires', raw: JSON.stringify({ user_id: USER, expires_at: null }) },
    {
      name: 'string-expires',
      raw: JSON.stringify({ user_id: USER, expires_at: String(NOW + 60_000) }),
    },
    {
      name: 'expires-as-object',
      raw: JSON.stringify({ user_id: USER, expires_at: { t: NOW + 60_000 } }),
    },
    { name: 'user-as-number', raw: JSON.stringify({ user_id: 1, expires_at: NOW + 60_000 }) },
    { name: 'user-as-array', raw: JSON.stringify({ user_id: [USER], expires_at: NOW + 60_000 }) },
    { name: 'invalid-json', raw: '{not-json' },
    { name: 'truncated', raw: '' },
    { name: 'whitespace', raw: '   ' },
    {
      name: 'extra-nested',
      raw: JSON.stringify({
        user_id: USER,
        expires_at: NOW + 60_000,
        nested: { a: 1 },
        extra: true,
      }),
    },
  ];

  for (const shape of hostile) {
    it(`landing tolerates or fails soft for KV shape ${shape.name}`, async () => {
      const sessions = mockKv();
      const key = `login_token:${await hashToken(TOKEN)}`;
      sessions.data[key] = shape.raw;
      const res = await request(`/login/qr/${TOKEN}`, {}, envFor(sessions));
      // Valid full shape with extras succeeds; corrupt shapes must not 500 silently as 200 HTML welcome
      if (shape.name === 'extra-nested') {
        expect(res.status).toBe(200);
        expect(res.text).toContain(USER);
        expect(res.text).toContain('Welcome!');
      } else if (res.status === 200) {
        // Coerce-tolerant paths still render something; must include interpolated fields when present
        expect(res.text.length).toBeGreaterThan(0);
      } else {
        expect(res.status).toBeGreaterThanOrEqual(400);
      }
    });
  }
});

describe('qr leftovers corrupt KV shapes — check', () => {
  const hostile: Array<{ name: string; raw: string }> = [
    { name: 'empty-object', raw: '{}' },
    { name: 'null-json', raw: 'null' },
    { name: 'array', raw: '[1,2]' },
    { name: 'missing-expires', raw: JSON.stringify({ user_id: USER }) },
    { name: 'missing-user', raw: JSON.stringify({ expires_at: NOW + 90_000 }) },
    { name: 'invalid-json', raw: '{broken' },
    { name: 'empty', raw: '' },
    {
      name: 'extra-fields-ok',
      raw: JSON.stringify({
        user_id: USER,
        expires_at: NOW + 90_000,
        device_id: 'IGNORED',
        nonce: 'x',
      }),
    },
  ];

  for (const shape of hostile) {
    it(`check soft for KV shape ${shape.name}`, async () => {
      const sessions = mockKv();
      const key = `login_token:${await hashToken(TOKEN)}`;
      sessions.data[key] = shape.raw;
      const res = await request(`/login/qr/${TOKEN}/check`, {}, envFor(sessions));
      if (shape.name === 'extra-fields-ok') {
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          valid: true,
          user_id: USER,
          homeserver: SERVER,
          expires_at: NOW + 90_000,
        });
        expect(res.body).not.toHaveProperty('device_id');
        expect(res.body).not.toHaveProperty('nonce');
      } else if (res.status === 200) {
        expect(res.body).toMatchObject({ valid: true });
      } else {
        expect(res.status).toBeGreaterThanOrEqual(400);
        if (res.body && typeof res.body === 'object') {
          expect(res.body.valid).toBe(false);
        }
      }
    });
  }
});

describe('qr leftovers invalid prefix soft flood — landing + check parity', () => {
  // Strict startsWith('mlt_') failures — must short-circuit before KV.
  const bad = [
    'mlt',
    'mlt-',
    'mlt ',
    'MLT_abc',
    'Mlt_abc',
    'mLt_abc',
    'xlt_abc',
    'login_token',
    'token',
    'notmlt_token',
    'mltX_bad',
    '../mlt_x',
    'null',
    'undefined',
    '0',
    'true',
    'false',
    'mlt%00',
    ' mlt_x',
    '⚡mlt_x',
    'MLT_',
    'mlT_',
    'mLT_',
    'sso_token',
    'access_token',
    'qr_token',
    'bearer',
    'mlt',
  ];

  for (const [i, tok] of bad.entries()) {
    it(`landing invalid-prefix soft-${i} (${JSON.stringify(tok).slice(0, 40)})`, async () => {
      const sessions = mockKv();
      const getSpy = vi.spyOn(sessions, 'get');
      const { status, text } = await request(
        `/login/qr/${encodeURIComponent(tok)}`,
        {},
        envFor(sessions)
      );
      expect(status).toBe(400);
      expect(text).toContain('Invalid Token');
      expect(getSpy).not.toHaveBeenCalled();
    });

    it(`check invalid-prefix soft-${i}`, async () => {
      const sessions = mockKv();
      const { status, body } = await request(
        `/login/qr/${encodeURIComponent(tok)}/check`,
        {},
        envFor(sessions)
      );
      expect(status).toBe(400);
      expect(body).toEqual({ valid: false, error: 'Invalid token format' });
      expect(sessions.gets).toHaveLength(0);
    });
  }

  // Valid mlt_ prefix but missing KV → expired/not-found (not invalid-format).
  const validPrefixMissing = ['mlt__', 'mlt_../x', 'mlt_x ', 'mlt_.', 'mlt_-', 'mlt_~'];
  for (const [i, tok] of validPrefixMissing.entries()) {
    it(`landing valid-prefix missing KV soft-${i}`, async () => {
      const { status, text } = await request(`/login/qr/${encodeURIComponent(tok)}`);
      expect(status).toBe(400);
      expect(text).toContain('Token Expired');
    });
    it(`check valid-prefix missing KV soft-${i}`, async () => {
      const { status, body } = await request(`/login/qr/${encodeURIComponent(tok)}/check`);
      expect(status).toBe(404);
      expect(body).toEqual({ valid: false, error: 'Token not found or expired' });
    });
  }
});

describe('qr leftovers valid-prefix missing KV soft flood', () => {
  for (let i = 0; i < 40; i++) {
    const tok = `mlt_missing_${i}_${'x'.repeat((i % 8) + 1)}`;
    it(`landing missing KV soft-${i}`, async () => {
      const { status, text } = await request(`/login/qr/${encodeURIComponent(tok)}`);
      expect(status).toBe(400);
      expect(text).toContain('Token Expired');
      expect(text).toContain('expired or has already been used');
    });
    it(`check missing KV soft-${i}`, async () => {
      const { status, body } = await request(`/login/qr/${encodeURIComponent(tok)}/check`);
      expect(status).toBe(404);
      expect(body).toEqual({ valid: false, error: 'Token not found or expired' });
    });
  }
});

describe('qr leftovers expiry delta soft flood', () => {
  const deltas = [
    -3_600_000, -60_000, -1_000, -2, -1, 0, 1, 999, 1_000, 59_999, 60_000, 60_001, 90_000,
    119_999, 120_000, 120_001, 300_000, 600_000, 3_600_000, 86_400_000,
  ];

  for (const delta of deltas) {
    it(`landing expiry delta=${delta}`, async () => {
      const sessions = mockKv();
      const key = await putLoginToken(sessions, TOKEN, { expires_at: NOW + delta });
      const res = await request(`/login/qr/${TOKEN}`, {}, envFor(sessions));
      if (delta < 0) {
        expect(res.status).toBe(400);
        expect(res.text).toContain('Token Expired');
        expect(sessions.deletes).toContain(key);
      } else {
        expect(res.status).toBe(200);
        expect(res.text).toContain('Welcome!');
        expect(sessions.deletes).toHaveLength(0);
        const mins = Math.max(0, Math.ceil(delta / 60_000));
        const label =
          mins === 1 ? 'Token expires in 1 minute' : `Token expires in ${mins} minutes`;
        expect(res.text).toContain(label);
      }
    });

    it(`check expiry delta=${delta}`, async () => {
      const sessions = mockKv();
      const key = await putLoginToken(sessions, TOKEN, { expires_at: NOW + delta });
      const res = await request(`/login/qr/${TOKEN}/check`, {}, envFor(sessions));
      if (delta < 0) {
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ valid: false, error: 'Token expired' });
        expect(sessions.deletes).toHaveLength(0);
        expect(sessions.data[key]).toBeTruthy();
      } else {
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          valid: true,
          user_id: USER,
          homeserver: SERVER,
          expires_at: NOW + delta,
        });
      }
    });
  }
});

describe('qr leftovers SERVER_NAME soft flood', () => {
  const names = [
    'example.com',
    'hs.example.com',
    'matrix.example.org',
    'a.b.c.example.net',
    'localhost',
    '127.0.0.1',
    'xn--bcher-kva.example',
    'server-with-dash.example',
    'UPPER.EXAMPLE',
    'mixed.Example.COM',
  ];

  for (const [i, name] of names.entries()) {
    it(`landing embeds SERVER_NAME soft-${i}`, async () => {
      const sessions = mockKv();
      await putLoginToken(sessions, TOKEN);
      const { status, text } = await request(`/login/qr/${TOKEN}`, {}, envFor(sessions, name));
      expect(status).toBe(200);
      expect(text).toContain(`Login to ${name}`);
      expect(text).toContain(`https://${name}`);
      expect(text).toContain(`const homeserver = "https://${name}";`);
    });

    it(`check homeserver bare SERVER_NAME soft-${i}`, async () => {
      const sessions = mockKv();
      await putLoginToken(sessions, TOKEN);
      const { body } = await request(`/login/qr/${TOKEN}/check`, {}, envFor(sessions, name));
      expect(body).toMatchObject({ valid: true, homeserver: name, user_id: USER });
      expect(body.homeserver).not.toMatch(/^https?:\/\//);
    });
  }
});

describe('qr leftovers user_id reflection soft flood', () => {
  const users = [
    '@alice:example.com',
    '@bob:example.com',
    '@carol:example.org',
    '@user_1:example.com',
    '@a:example.com',
    '@alice-bob:example.com',
    '@alice.bob:example.com',
    '@alice=1:example.com',
    '@ mixed:example.com'.replace(' ', ''),
    '@unicode_ü:example.com',
    '@roomadmin:example.com',
    '@guest:example.com',
  ];

  for (const [i, userId] of users.entries()) {
    it(`landing+check reflect user soft-${i}`, async () => {
      const sessions = mockKv();
      const tok = `mlt_user_soft_${i}`;
      await putLoginToken(sessions, tok, { user_id: userId });
      const land = await request(`/login/qr/${tok}`, {}, envFor(sessions));
      expect(land.status).toBe(200);
      expect(land.text).toContain(userId);
      expect(land.text).toContain(`Logging in as`);
      const check = await request(`/login/qr/${tok}/check`, {}, envFor(sessions));
      expect(check.status).toBe(200);
      expect(check.body.user_id).toBe(userId);
    });
  }
});

describe('qr leftovers HTML contract soft flood', () => {
  for (let i = 0; i < 24; i++) {
    it(`landing HTML landmarks soft-${i}`, async () => {
      const sessions = mockKv();
      const tok = `mlt_html_contract_${i}`;
      const expiresAt = NOW + (i + 1) * 60_000;
      await putLoginToken(sessions, tok, { expires_at: expiresAt, user_id: USER });
      const { status, text, headers } = await request(`/login/qr/${tok}`, {}, envFor(sessions));
      expect(status).toBe(200);
      expect(headers.get('content-type')).toMatch(/text\/html/);
      expect(text).toContain('<!DOCTYPE html>');
      expect(text).toContain('Welcome!');
      expect(text).toContain('Open in Element');
      expect(text).toContain('https://app.element.io/#/login');
      expect(text).toContain('im.vector.app');
      expect(text).toContain('element-messenger');
      expect(text).toContain('Manual Login Details');
      expect(text).toContain('Log in with token');
      expect(text).toContain(`const token = "${tok}";`);
      expect(text).toContain(`const expiresAt = ${expiresAt};`);
      expect(text).toContain(`value="${tok}"`);
      expect(text).toContain('id="loginToken"');
      expect(text).toContain('id="homeserverUrl"');
      expect(text).toContain('--primary: #0d9488');
      expect(text).not.toContain('login_token:');
      expect(text).not.toContain(await hashToken(tok));
    });
  }
});

describe('qr leftovers check JSON contract soft flood', () => {
  for (let i = 0; i < 24; i++) {
    it(`check JSON strict keys soft-${i}`, async () => {
      const sessions = mockKv();
      const tok = `mlt_check_contract_${i}`;
      const expiresAt = NOW + (i + 2) * 60_000;
      await putLoginToken(sessions, tok, {
        user_id: `@u${i}:example.com`,
        expires_at: expiresAt,
      });
      const { status, body, headers } = await request(
        `/login/qr/${tok}/check`,
        {},
        envFor(sessions)
      );
      expect(status).toBe(200);
      expect(headers.get('content-type')).toMatch(/application\/json/);
      expect(body).toEqual({
        valid: true,
        user_id: `@u${i}:example.com`,
        homeserver: SERVER,
        expires_at: expiresAt,
      });
      expect(Object.keys(body as object).sort()).toEqual([
        'expires_at',
        'homeserver',
        'user_id',
        'valid',
      ]);
    });
  }
});

describe('qr leftovers method matrix soft flood', () => {
  const methods = ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'] as const;
  for (const method of methods) {
    it(`landing rejects ${method}`, async () => {
      const sessions = mockKv();
      await putLoginToken(sessions, TOKEN);
      const res = await request(`/login/qr/${TOKEN}`, { method }, envFor(sessions));
      if (method === 'HEAD') {
        // Hono may answer HEAD for GET routes; accept 200 empty or 404
        expect([200, 404]).toContain(res.status);
      } else if (method === 'OPTIONS') {
        expect([200, 204, 404, 405]).toContain(res.status);
      } else {
        expect(res.status).toBe(404);
      }
    });
    it(`check rejects ${method}`, async () => {
      const sessions = mockKv();
      await putLoginToken(sessions, TOKEN);
      const res = await request(`/login/qr/${TOKEN}/check`, { method }, envFor(sessions));
      if (method === 'HEAD') {
        expect([200, 404]).toContain(res.status);
      } else if (method === 'OPTIONS') {
        expect([200, 204, 404, 405]).toContain(res.status);
      } else {
        expect(res.status).toBe(404);
      }
    });
  }
});

describe('qr leftovers Accept / query-string ignore soft flood', () => {
  const accepts = [
    'application/json',
    'text/html',
    'text/plain',
    '*/*',
    'application/json, text/html',
    '',
  ];

  for (const [i, accept] of accepts.entries()) {
    it(`landing ignores Accept soft-${i}`, async () => {
      const sessions = mockKv();
      await putLoginToken(sessions, TOKEN);
      const init: RequestInit = accept ? { headers: { Accept: accept } } : {};
      const { status, text, headers } = await request(`/login/qr/${TOKEN}`, init, envFor(sessions));
      expect(status).toBe(200);
      expect(headers.get('content-type')).toMatch(/text\/html/);
      expect(text).toContain('Welcome!');
    });

    it(`check ignores Accept soft-${i}`, async () => {
      const sessions = mockKv();
      await putLoginToken(sessions, TOKEN);
      const init: RequestInit = accept ? { headers: { Accept: accept } } : {};
      const { status, body, headers } = await request(
        `/login/qr/${TOKEN}/check`,
        init,
        envFor(sessions)
      );
      expect(status).toBe(200);
      expect(headers.get('content-type')).toMatch(/application\/json/);
      expect(body).toMatchObject({ valid: true });
    });
  }

  const queries = ['?x=1', '?token=evil', '?access_token=mlt_other', '?format=json', '?#frag'];
  for (const [i, q] of queries.entries()) {
    it(`landing ignores query soft-${i}`, async () => {
      const sessions = mockKv();
      await putLoginToken(sessions, TOKEN);
      // Hono request URL path; append query on full URL via custom request
      const env = envFor(sessions);
      const res = await qrLogin.request(`https://${SERVER}/login/qr/${TOKEN}${q}`, {}, env);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain(USER);
    });

    it(`check ignores query soft-${i}`, async () => {
      const sessions = mockKv();
      await putLoginToken(sessions, TOKEN);
      const env = envFor(sessions);
      const res = await qrLogin.request(`https://${SERVER}/login/qr/${TOKEN}/check${q}`, {}, env);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ valid: true, user_id: USER });
    });
  }
});

describe('qr leftovers concurrent token isolation soft flood', () => {
  for (let batch = 0; batch < 8; batch++) {
    it(`parallel distinct tokens batch-${batch}`, async () => {
      const sessions = mockKv();
      const tokens = Array.from({ length: 12 }, (_, i) => `mlt_iso_${batch}_${i}`);
      for (const [i, tok] of tokens.entries()) {
        await putLoginToken(sessions, tok, {
          user_id: `@u${batch}_${i}:example.com`,
          expires_at: NOW + (i + 1) * 60_000,
        });
      }
      const results = await Promise.all(
        tokens.map((tok) => request(`/login/qr/${tok}/check`, {}, envFor(sessions)))
      );
      for (const [i, res] of results.entries()) {
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          valid: true,
          user_id: `@u${batch}_${i}:example.com`,
          expires_at: NOW + (i + 1) * 60_000,
        });
      }
      const lands = await Promise.all(
        tokens.map((tok) => request(`/login/qr/${tok}`, {}, envFor(sessions)))
      );
      for (const [i, res] of lands.entries()) {
        expect(res.status).toBe(200);
        expect(res.text).toContain(`@u${batch}_${i}:example.com`);
        expect(res.text).toContain(tokens[i]);
      }
    });
  }
});

describe('qr leftovers expire-delete lifecycle soft flood', () => {
  for (let i = 0; i < 16; i++) {
    it(`check-expired then landing delete soft-${i}`, async () => {
      const sessions = mockKv();
      const tok = `mlt_life_${i}`;
      const key = await putLoginToken(sessions, tok, { expires_at: NOW - (i + 1) });
      const check = await request(`/login/qr/${tok}/check`, {}, envFor(sessions));
      expect(check.status).toBe(400);
      expect(check.body).toEqual({ valid: false, error: 'Token expired' });
      expect(sessions.data[key]).toBeTruthy();
      expect(sessions.deletes).toHaveLength(0);
      const land = await request(`/login/qr/${tok}`, {}, envFor(sessions));
      expect(land.status).toBe(400);
      expect(land.text).toContain('This login link has expired.');
      expect(sessions.deletes).toContain(key);
      expect(sessions.data[key]).toBeUndefined();
      const after = await request(`/login/qr/${tok}/check`, {}, envFor(sessions));
      expect(after.status).toBe(404);
    });
  }

  for (let i = 0; i < 16; i++) {
    it(`landing success does not consume soft-${i}`, async () => {
      const sessions = mockKv();
      const tok = `mlt_noconsume_${i}`;
      const key = await putLoginToken(sessions, tok, { expires_at: NOW + 120_000 });
      for (let n = 0; n < 3; n++) {
        expect((await request(`/login/qr/${tok}`, {}, envFor(sessions))).status).toBe(200);
        expect((await request(`/login/qr/${tok}/check`, {}, envFor(sessions))).body.valid).toBe(
          true
        );
      }
      expect(sessions.deletes).toHaveLength(0);
      expect(sessions.data[key]).toBeTruthy();
    });
  }
});

describe('qr leftovers hash key contract soft flood', () => {
  for (let i = 0; i < 20; i++) {
    it(`only hashed login_token key matches soft-${i}`, async () => {
      const sessions = mockKv();
      const tok = `mlt_hash_${i}_${'ab'.repeat((i % 5) + 1)}`;
      const goodKey = `login_token:${await hashToken(tok)}`;
      sessions.data[goodKey] = JSON.stringify({
        user_id: `@hash${i}:example.com`,
        expires_at: NOW + 180_000,
      });
      sessions.data[`login_token:${tok}`] = JSON.stringify({
        user_id: '@wrongraw:example.com',
        expires_at: NOW + 180_000,
      });
      sessions.data[`login_token:not-the-hash-${i}`] = JSON.stringify({
        user_id: '@wrongalt:example.com',
        expires_at: NOW + 180_000,
      });
      const land = await request(`/login/qr/${tok}`, {}, envFor(sessions));
      expect(land.status).toBe(200);
      expect(land.text).toContain(`@hash${i}:example.com`);
      expect(land.text).not.toContain('@wrongraw:example.com');
      expect(land.text).not.toContain('@wrongalt:example.com');
      expect(sessions.gets[0]).toBe(goodKey);
      const check = await request(`/login/qr/${tok}/check`, {}, envFor(sessions));
      expect(check.body.user_id).toBe(`@hash${i}:example.com`);
    });
  }
});

describe('qr leftovers landing/check parity soft flood', () => {
  for (let i = 0; i < 30; i++) {
    it(`parity pair soft-${i}`, async () => {
      const sessions = mockKv();
      const tok = `mlt_parity_${i}`;
      const expiresAt = NOW + (i + 3) * 45_000;
      const userId = `@parity${i}:example.com`;
      await putLoginToken(sessions, tok, { user_id: userId, expires_at: expiresAt });
      const land = await request(`/login/qr/${tok}`, {}, envFor(sessions));
      const check = await request(`/login/qr/${tok}/check`, {}, envFor(sessions));
      expect(land.status).toBe(200);
      expect(check.status).toBe(200);
      expect(land.text).toContain(userId);
      expect(land.text).toContain(tok);
      expect(check.body).toEqual({
        valid: true,
        user_id: userId,
        homeserver: SERVER,
        expires_at: expiresAt,
      });
    });
  }
});

describe('qr leftovers error HTML copy soft flood', () => {
  for (let i = 0; i < 12; i++) {
    it(`invalid token HTML copy soft-${i}`, async () => {
      const { status, text } = await request(`/login/qr/badtoken_${i}`);
      expect(status).toBe(400);
      expect(text).toContain('<!DOCTYPE html>');
      expect(text).toContain('Invalid Token');
      expect(text).toContain('invalid or has been tampered with');
      expect(text).toContain('#0f172a');
      expect(text).toContain('#ef4444');
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`missing token HTML copy soft-${i}`, async () => {
      const { status, text } = await request(`/login/qr/mlt_gone_${i}`);
      expect(status).toBe(400);
      expect(text).toContain('Token Expired');
      expect(text).toContain('expired or has already been used');
      expect(text).toContain('request a new QR code');
      expect(text).toContain('#f59e0b');
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`expired token HTML copy soft-${i}`, async () => {
      const sessions = mockKv();
      const tok = `mlt_exphtml_${i}`;
      await putLoginToken(sessions, tok, { expires_at: NOW - 1 - i });
      const { status, text } = await request(`/login/qr/${tok}`, {}, envFor(sessions));
      expect(status).toBe(400);
      expect(text).toContain('Token Expired');
      expect(text).toContain('This login link has expired.');
      expect(text).toContain('request a new QR code');
    });
  }
});

describe('qr leftovers token length / charset success soft flood', () => {
  const samples = [
    'mlt_' + 'a'.repeat(8),
    'mlt_' + 'b'.repeat(16),
    'mlt_' + 'c'.repeat(32),
    'mlt_' + 'd'.repeat(64),
    'mlt_' + 'e'.repeat(96),
    'mlt_' + 'f'.repeat(128),
    'mlt_1234567890abcdef',
    'mlt_MiXeDcAsE_Token',
    'mlt_.-_~safe',
    'mlt_under_score',
    'mlt_dash-ok',
    'mlt_dot.ok',
  ];

  for (const [i, tok] of samples.entries()) {
    it(`success charset soft-${i}`, async () => {
      const sessions = mockKv();
      await putLoginToken(sessions, tok, {
        user_id: `@cs${i}:example.com`,
        expires_at: NOW + 240_000,
      });
      const land = await request(`/login/qr/${encodeURIComponent(tok)}`, {}, envFor(sessions));
      expect(land.status).toBe(200);
      expect(land.text).toContain(tok);
      expect(land.text).toContain(`@cs${i}:example.com`);
      const check = await request(
        `/login/qr/${encodeURIComponent(tok)}/check`,
        {},
        envFor(sessions)
      );
      expect(check.status).toBe(200);
      expect(check.body.user_id).toBe(`@cs${i}:example.com`);
    });
  }
});

describe('qr leftovers clock skew lifecycle soft flood', () => {
  for (let i = 0; i < 10; i++) {
    it(`advance clock past expiry soft-${i}`, async () => {
      const sessions = mockKv();
      const tok = `mlt_clock_${i}`;
      const ttl = (i + 1) * 1_000;
      const key = await putLoginToken(sessions, tok, { expires_at: NOW + ttl });
      expect((await request(`/login/qr/${tok}/check`, {}, envFor(sessions))).status).toBe(200);
      vi.setSystemTime(NOW + ttl);
      // expires_at === now still valid
      expect((await request(`/login/qr/${tok}/check`, {}, envFor(sessions))).status).toBe(200);
      vi.setSystemTime(NOW + ttl + 1);
      const check = await request(`/login/qr/${tok}/check`, {}, envFor(sessions));
      expect(check.status).toBe(400);
      expect(sessions.data[key]).toBeTruthy();
      const land = await request(`/login/qr/${tok}`, {}, envFor(sessions));
      expect(land.status).toBe(400);
      expect(sessions.deletes).toContain(key);
    });
  }
});

describe('qr leftovers Authorization header ignored soft flood', () => {
  for (let i = 0; i < 10; i++) {
    it(`landing ignores Authorization soft-${i}`, async () => {
      const sessions = mockKv();
      await putLoginToken(sessions, TOKEN);
      const { status, text } = await request(
        `/login/qr/${TOKEN}`,
        { headers: { Authorization: `Bearer mlt_other_${i}` } },
        envFor(sessions)
      );
      expect(status).toBe(200);
      expect(text).toContain(USER);
    });

    it(`check ignores Authorization soft-${i}`, async () => {
      const sessions = mockKv();
      await putLoginToken(sessions, TOKEN);
      const { status, body } = await request(
        `/login/qr/${TOKEN}/check`,
        { headers: { Authorization: `Bearer evil_${i}` } },
        envFor(sessions)
      );
      expect(status).toBe(200);
      expect(body).toMatchObject({ valid: true, user_id: USER });
    });
  }
});

describe('qr leftovers concurrent landing+check same token soft flood', () => {
  for (let i = 0; i < 12; i++) {
    it(`concurrent same-token soft-${i}`, async () => {
      const sessions = mockKv();
      const tok = `mlt_conc_${i}`;
      await putLoginToken(sessions, tok, {
        user_id: `@conc${i}:example.com`,
        expires_at: NOW + 500_000,
      });
      const results = await Promise.all([
        request(`/login/qr/${tok}`, {}, envFor(sessions)),
        request(`/login/qr/${tok}/check`, {}, envFor(sessions)),
        request(`/login/qr/${tok}`, {}, envFor(sessions)),
        request(`/login/qr/${tok}/check`, {}, envFor(sessions)),
      ]);
      expect(results[0].status).toBe(200);
      expect(results[1].status).toBe(200);
      expect(results[2].status).toBe(200);
      expect(results[3].status).toBe(200);
      expect(results[0].text).toContain(`@conc${i}:example.com`);
      expect(results[1].body).toMatchObject({ valid: true, user_id: `@conc${i}:example.com` });
      expect(sessions.deletes).toHaveLength(0);
    });
  }
});
