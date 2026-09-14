/**
 * TOKENMAXX HEAVY leftovers after #139 — identity lookup / hash_details / email validate edges.
 * Complements identity-api-routes + identity-account-register-leftovers.
 * Prefer failure/reliability paths. Tests-only — Hono app.request() on src/api/identity.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { sha256 } from '../src/utils/crypto';
import identity from '../src/api/identity';

const SERVER_NAME = 'example.com';
const BASE = '/_matrix/identity/v2';
const FIXED_NOW = 1_700_000_000_000;
const SEVEN_DAY_TTL = 7 * 24 * 60 * 60;

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

type IdentityAssociation = { medium: string; address: string; mxid: string };
type EmailVerificationSession = {
  session_id: string;
  email: string;
  client_secret: string;
  token: string;
  send_attempt: number;
  validated: number;
  created_at: number;
  expires_at: number;
  validated_at?: number | null;
};
type SqlCall = { sql: string; args: unknown[] };

function createIdentityDb(opts: {
  associations?: IdentityAssociation[];
  emailSessions?: Map<string, EmailVerificationSession>;
  throwOn?: string;
} = {}) {
  const associations = [...(opts.associations ?? [])];
  const emailSessions = opts.emailSessions ?? new Map<string, EmailVerificationSession>();
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];

  const db = {
    associations,
    emailSessions,
    inserts,
    updates,
    prepare(sql: string) {
      if (opts.throwOn && sql.includes(opts.throwOn)) {
        throw new Error(`forced db error: ${opts.throwOn}`);
      }
      const stmt = {
        async all<T>() {
          if (sql.includes('FROM identity_associations') && sql.includes('SELECT medium, address, mxid')) {
            return { results: [...associations] } as { results: T[] };
          }
          return { results: [] as T[] };
        },
        bind(...args: unknown[]) {
          return {
            all: stmt.all,
            async first<T>() {
              if (
                sql.includes('FROM identity_associations') &&
                sql.includes('WHERE medium = ?') &&
                sql.includes('AND address = ?')
              ) {
                const [medium, address] = args as [string, string];
                const row = associations.find((a) => a.medium === medium && a.address === address);
                return (row ? { mxid: row.mxid } : null) as T;
              }
              if (
                sql.includes('FROM email_verification_sessions') &&
                sql.includes('WHERE session_id = ?') &&
                sql.includes('client_secret = ?')
              ) {
                const [sessionId, clientSecret] = args as [string, string];
                const session = emailSessions.get(sessionId);
                if (!session || session.client_secret !== clientSecret) return null;
                return {
                  session_id: session.session_id,
                  email: session.email,
                  client_secret: session.client_secret,
                  token: session.token,
                  validated: session.validated,
                  expires_at: session.expires_at,
                } as T;
              }
              return null;
            },
            async run() {
              if (sql.includes('INSERT INTO email_verification_sessions')) {
                inserts.push({ sql, args });
                const [sessionId, email, clientSecret, token, sendAttempt, createdAt, expiresAt] =
                  args as [string, string, string, string, number, number, number];
                emailSessions.set(sessionId, {
                  session_id: sessionId,
                  email,
                  client_secret: clientSecret,
                  token,
                  send_attempt: sendAttempt,
                  validated: 0,
                  created_at: createdAt,
                  expires_at: expiresAt,
                  validated_at: null,
                });
              }
              if (sql.includes('UPDATE email_verification_sessions SET validated = 1')) {
                updates.push({ sql, args });
                const [validatedAt, sessionId] = args as [number, string];
                const session = emailSessions.get(sessionId);
                if (session) {
                  session.validated = 1;
                  session.validated_at = validatedAt;
                }
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
      return stmt;
    },
  };
  return db as unknown as D1Database & {
    associations: IdentityAssociation[];
    emailSessions: Map<string, EmailVerificationSession>;
    inserts: SqlCall[];
    updates: SqlCall[];
  };
}

function makeEnv(opts: {
  cache?: ReturnType<typeof mockKv>;
  db?: ReturnType<typeof createIdentityDb>;
} = {}): Env {
  return {
    SERVER_NAME,
    CACHE: opts.cache ?? mockKv(),
    DB: opts.db ?? createIdentityDb(),
  } as Env;
}

async function jsonRequest(
  path: string,
  init: RequestInit = {},
  env: Env = makeEnv()
): Promise<{ status: number; body: any }> {
  const res = await identity.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

function postJson(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  vi.spyOn(Math, 'random').mockReturnValue(0.123456);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('identity leftovers GET /hash_details', () => {
  it('creates pepper with exact 7-day TTL and uuid-without-dashes shape', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, env);
    expect(status).toBe(200);
    expect(body.algorithms).toEqual(['sha256', 'none']);
    expect(body.lookup_pepper).toBe('aaaaaaaabbbbccccddddeeeeeeeeeeee');
    expect(cache.puts).toHaveLength(1);
    expect(cache.puts[0].key).toBe('identity:pepper');
    expect(cache.puts[0].options?.expirationTtl).toBe(SEVEN_DAY_TTL);
  });

  it('does not put when pepper already present', async () => {
    const cache = mockKv({ 'identity:pepper': 'existing-pepper' });
    const env = makeEnv({ cache });
    const a = await jsonRequest(`${BASE}/hash_details`, {}, env);
    const b = await jsonRequest(`${BASE}/hash_details`, {}, env);
    expect(a.body.lookup_pepper).toBe('existing-pepper');
    expect(b.body.lookup_pepper).toBe('existing-pepper');
    expect(cache.puts).toHaveLength(0);
  });

  it('GET is idempotent across many calls with same env pepper', async () => {
    const cache = mockKv({ 'identity:pepper': 'stable' });
    const env = makeEnv({ cache });
    for (let i = 0; i < 10; i++) {
      const { body } = await jsonRequest(`${BASE}/hash_details`, {}, env);
      expect(body.lookup_pepper).toBe('stable');
    }
    expect(cache.puts).toHaveLength(0);
  });
});

describe('identity leftovers POST /lookup — param failure matrix', () => {
  it('rejects empty algorithm string as missing', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: '', pepper: 'p', addresses: [] })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('rejects null addresses', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'p', addresses: null })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('rejects object addresses', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'p', addresses: { a: 1 } })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('rejects missing pepper with M_INVALID_PEPPER (pepper !== current)', async () => {
    const cache = mockKv({ 'identity:pepper': 'current' });
    const env = makeEnv({ cache });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', addresses: ['a@b.co email'] }),
      env
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe('current');
    expect(body.algorithm).toBe('sha256');
  });

  it('rejects wrong pepper even for sha256', async () => {
    const cache = mockKv({ 'identity:pepper': 'right' });
    const env = makeEnv({ cache });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper: 'wrong', addresses: ['deadbeef'] }),
      env
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe('right');
  });

  it('unknown algorithm includes algorithm name in error', async () => {
    const cache = mockKv({ 'identity:pepper': 'p' });
    const env = makeEnv({ cache });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'md5', pepper: 'p', addresses: [] }),
      env
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
    expect(body.error).toContain('md5');
  });

  it('empty addresses array returns empty mappings for sha256 and none', async () => {
    const cache = mockKv({ 'identity:pepper': 'pep' });
    const db = createIdentityDb({
      associations: [{ medium: 'email', address: 'a@ex.com', mxid: '@a:example.com' }],
    });
    const env = makeEnv({ cache, db });
    for (const algorithm of ['sha256', 'none']) {
      const { status, body } = await jsonRequest(
        `${BASE}/lookup`,
        postJson({ algorithm, pepper: 'pep', addresses: [] }),
        env
      );
      expect(status).toBe(200);
      expect(body).toEqual({ mappings: {} });
    }
  });

  it('array body is valid JSON but missing fields → M_INVALID_PARAM', async () => {
    const { status, body } = await jsonRequest(`${BASE}/lookup`, postJson([]));
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('rejects truncated JSON with M_BAD_JSON', async () => {
    const { status, body } = await jsonRequest(`${BASE}/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"algorithm":',
    });
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
});

describe('identity leftovers POST /lookup — sha256/none reliability', () => {
  it('sha256 maps subset of associations and ignores non-matching hashes', async () => {
    const pepper = 'pep1';
    const assocs: IdentityAssociation[] = [
      { medium: 'email', address: 'one@ex.com', mxid: '@one:example.com' },
      { medium: 'email', address: 'two@ex.com', mxid: '@two:example.com' },
      { medium: 'msisdn', address: '+1555', mxid: '@phone:example.com' },
    ];
    const hashOne = await sha256(`one@ex.com email ${pepper}`);
    const hashPhone = await sha256(`+1555 msisdn ${pepper}`);
    const env = makeEnv({
      cache: mockKv({ 'identity:pepper': pepper }),
      db: createIdentityDb({ associations: assocs }),
    });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({
        algorithm: 'sha256',
        pepper,
        addresses: [hashOne, 'not-a-real-hash', hashPhone],
      }),
      env
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({
      [hashOne]: '@one:example.com',
      [hashPhone]: '@phone:example.com',
    });
  });

  it('none algorithm uses first two space parts and ignores extras', async () => {
    const pepper = 'pep2';
    const env = makeEnv({
      cache: mockKv({ 'identity:pepper': pepper }),
      db: createIdentityDb({
        associations: [{ medium: 'email', address: 'x@y.co', mxid: '@x:example.com' }],
      }),
    });
    const { body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({
        algorithm: 'none',
        pepper,
        addresses: ['x@y.co email EXTRA IGNORED', 'incomplete', ''],
      }),
      env
    );
    expect(body.mappings).toEqual({ 'x@y.co email EXTRA IGNORED': '@x:example.com' });
  });

  it('none algorithm medium/address bind order is medium then address', async () => {
    const pepper = 'pep3';
    const db = createIdentityDb({
      associations: [{ medium: 'email', address: 'bind@ex.com', mxid: '@b:example.com' }],
    });
    const env = makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db });
    await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: ['bind@ex.com email'] }),
      env
    );
    // exercise path; association found via medium+address
    const { body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: ['bind@ex.com email'] }),
      env
    );
    expect(body.mappings['bind@ex.com email']).toBe('@b:example.com');
  });

  it('sha256 does not match when medium order wrong in hash input', async () => {
    const pepper = 'pep4';
    const assoc = { medium: 'email', address: 'z@ex.com', mxid: '@z:example.com' };
    const wrong = await sha256(`email z@ex.com ${pepper}`);
    const env = makeEnv({
      cache: mockKv({ 'identity:pepper': pepper }),
      db: createIdentityDb({ associations: [assoc] }),
    });
    const { body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [wrong] }),
      env
    );
    expect(body.mappings).toEqual({});
  });
});

describe('identity leftovers POST /validate/email/requestToken', () => {
  it('rejects empty email and empty client_secret', async () => {
    for (const body of [
      { email: '', client_secret: 's', send_attempt: 1 },
      { email: 'a@b.co', client_secret: '', send_attempt: 1 },
    ]) {
      const res = await jsonRequest(`${BASE}/validate/email/requestToken`, postJson(body));
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_MISSING_PARAM');
    }
  });

  it('allows missing send_attempt (binds undefined)', async () => {
    const db = createIdentityDb();
    const env = makeEnv({ db });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: 'a@b.co', client_secret: 'sec' }),
      env
    );
    expect(status).toBe(200);
    expect(body.sid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(db.inserts[0].args[4]).toBeUndefined();
  });

  it('persists send_attempt 0 distinctly from undefined', async () => {
    const db = createIdentityDb();
    const env = makeEnv({ db });
    await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: 'a@b.co', client_secret: 'sec', send_attempt: 0 }),
      env
    );
    expect(db.inserts[0].args[4]).toBe(0);
  });

  it('token is six digits from Math.random floor formula', async () => {
    // 100000 + floor(0.123456 * 900000) = 100000 + 111110 = 211110
    const db = createIdentityDb();
    const env = makeEnv({ db });
    await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: 'a@b.co', client_secret: 'sec', send_attempt: 1 }),
      env
    );
    expect(db.inserts[0].args[3]).toBe('211110');
  });

  it('expires_at is created_at + 24h using frozen clock', async () => {
    const db = createIdentityDb();
    const env = makeEnv({ db });
    await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: 'a@b.co', client_secret: 'sec', send_attempt: 1 }),
      env
    );
    expect(db.inserts[0].args[5]).toBe(FIXED_NOW);
    expect(db.inserts[0].args[6]).toBe(FIXED_NOW + 24 * 60 * 60 * 1000);
  });

  it('ignores next_link for persistence but still succeeds', async () => {
    const db = createIdentityDb();
    const env = makeEnv({ db });
    const { status } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({
        email: 'a@b.co',
        client_secret: 'sec',
        send_attempt: 2,
        next_link: 'https://evil.example/cb',
      }),
      env
    );
    expect(status).toBe(200);
    expect(db.inserts[0].args).toHaveLength(7);
  });
});

describe('identity leftovers POST /validate/email/submitToken', () => {
  function seedSession(
    overrides: Partial<EmailVerificationSession> = {}
  ): Map<string, EmailVerificationSession> {
    const session: EmailVerificationSession = {
      session_id: 'sid-1',
      email: 'a@b.co',
      client_secret: 'sec',
      token: '123456',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + 60_000,
      validated_at: null,
      ...overrides,
    };
    return new Map([[session.session_id, session]]);
  }

  it('rejects wrong token with M_INVALID_PARAM', async () => {
    const env = makeEnv({ db: createIdentityDb({ emailSessions: seedSession() }) });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid: 'sid-1', client_secret: 'sec', token: '000000' }),
      env
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('expires when expires_at is 1ms before now', async () => {
    const env = makeEnv({
      db: createIdentityDb({
        emailSessions: seedSession({ expires_at: FIXED_NOW - 1 }),
      }),
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid: 'sid-1', client_secret: 'sec', token: '123456' }),
      env
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_SESSION_EXPIRED');
  });

  it('accepts expires_at === now (strict <)', async () => {
    const db = createIdentityDb({
      emailSessions: seedSession({ expires_at: FIXED_NOW }),
    });
    const env = makeEnv({ db });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid: 'sid-1', client_secret: 'sec', token: '123456' }),
      env
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.updates[0].args[0]).toBe(FIXED_NOW);
    expect(db.updates[0].args[1]).toBe('sid-1');
  });

  it('unknown sid → M_NO_VALID_SESSION', async () => {
    const env = makeEnv({ db: createIdentityDb({ emailSessions: seedSession() }) });
    const { body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid: 'nope', client_secret: 'sec', token: '123456' }),
      env
    );
    expect(body.errcode).toBe('M_NO_VALID_SESSION');
  });

  it('wrong client_secret → M_NO_VALID_SESSION', async () => {
    const env = makeEnv({ db: createIdentityDb({ emailSessions: seedSession() }) });
    const { body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid: 'sid-1', client_secret: 'wrong', token: '123456' }),
      env
    );
    expect(body.errcode).toBe('M_NO_VALID_SESSION');
  });

  it('can validate already-validated session again (no guard)', async () => {
    const db = createIdentityDb({
      emailSessions: seedSession({ validated: 1, validated_at: FIXED_NOW - 1000 }),
    });
    const env = makeEnv({ db });
    const { status } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid: 'sid-1', client_secret: 'sec', token: '123456' }),
      env
    );
    expect(status).toBe(200);
    expect(db.emailSessions.get('sid-1')!.validated).toBe(1);
  });

  it('malformed JSON → M_BAD_JSON', async () => {
    const { status, body } = await jsonRequest(`${BASE}/validate/email/submitToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
});

describe('identity leftovers requestToken→submitToken reliability lifecycles', () => {
  it('full flow with frozen uuid/random then submit', async () => {
    const db = createIdentityDb();
    const env = makeEnv({ db });
    const req = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: 'flow@ex.com', client_secret: 'csec', send_attempt: 1 }),
      env
    );
    expect(req.body.sid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    const token = db.inserts[0].args[3] as string;
    const sub = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid: req.body.sid, client_secret: 'csec', token }),
      env
    );
    expect(sub.status).toBe(200);
    expect(sub.body).toEqual({ success: true });
  });

  it('hash_details pepper must match lookup pepper for success', async () => {
    const cache = mockKv();
    const env = makeEnv({
      cache,
      db: createIdentityDb({
        associations: [{ medium: 'email', address: 'p@ex.com', mxid: '@p:example.com' }],
      }),
    });
    const hd = await jsonRequest(`${BASE}/hash_details`, {}, env);
    const pepper = hd.body.lookup_pepper as string;
    const hash = await sha256(`p@ex.com email ${pepper}`);
    const look = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [hash] }),
      env
    );
    expect(look.body.mappings[hash]).toBe('@p:example.com');
  });
});

describe('identity leftovers lookup algorithm flood', () => {
  it('rejects algorithm "SHA256"', async () => {
    const env = makeEnv({ cache: mockKv({ 'identity:pepper': 'p' }) });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: "SHA256", pepper: 'p', addresses: [] }),
      env
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });
  it('rejects algorithm "Sha256"', async () => {
    const env = makeEnv({ cache: mockKv({ 'identity:pepper': 'p' }) });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: "Sha256", pepper: 'p', addresses: [] }),
      env
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });
  it('rejects algorithm "NONE"', async () => {
    const env = makeEnv({ cache: mockKv({ 'identity:pepper': 'p' }) });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: "NONE", pepper: 'p', addresses: [] }),
      env
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });
  it('rejects algorithm "None"', async () => {
    const env = makeEnv({ cache: mockKv({ 'identity:pepper': 'p' }) });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: "None", pepper: 'p', addresses: [] }),
      env
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });
  it('rejects algorithm "sha-256"', async () => {
    const env = makeEnv({ cache: mockKv({ 'identity:pepper': 'p' }) });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: "sha-256", pepper: 'p', addresses: [] }),
      env
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });
  it('rejects algorithm "plaintext"', async () => {
    const env = makeEnv({ cache: mockKv({ 'identity:pepper': 'p' }) });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: "plaintext", pepper: 'p', addresses: [] }),
      env
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });
  it('rejects algorithm "v2"', async () => {
    const env = makeEnv({ cache: mockKv({ 'identity:pepper': 'p' }) });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: "v2", pepper: 'p', addresses: [] }),
      env
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });
  it('rejects algorithm " "', async () => {
    const env = makeEnv({ cache: mockKv({ 'identity:pepper': 'p' }) });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: " ", pepper: 'p', addresses: [] }),
      env
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });
});

describe('identity leftovers submitToken missing-field soft matrix', () => {
  it('missing-sid yields session-not-found path', async () => {
    const env = makeEnv();
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({"client_secret": "sec", "token": "1"}),
      env
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_NO_VALID_SESSION');
  });
  it('missing-secret yields session-not-found path', async () => {
    const env = makeEnv();
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({"sid": "sid-1", "token": "1"}),
      env
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_NO_VALID_SESSION');
  });
  it('missing-token yields session-not-found path', async () => {
    const env = makeEnv();
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({"sid": "sid-1", "client_secret": "sec"}),
      env
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_NO_VALID_SESSION');
  });
  it('all-empty yields session-not-found path', async () => {
    const env = makeEnv();
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({"sid": "", "client_secret": "", "token": ""}),
      env
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_NO_VALID_SESSION');
  });
});

describe('identity leftovers none-algorithm address parse flood', () => {
  it('none parse (single-token) does not throw', async () => {
    const env = makeEnv({ cache: mockKv({ 'identity:pepper': 'p' }) });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'p', addresses: ["onlyemail"] }),
      env
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });
  it('none parse (empty) does not throw', async () => {
    const env = makeEnv({ cache: mockKv({ 'identity:pepper': 'p' }) });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'p', addresses: [""] }),
      env
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });
  it('none parse (spaces-only) does not throw', async () => {
    const env = makeEnv({ cache: mockKv({ 'identity:pepper': 'p' }) });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'p', addresses: ["   "] }),
      env
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });
  it('none parse (trailing-space-medium) does not throw', async () => {
    const env = makeEnv({ cache: mockKv({ 'identity:pepper': 'p' }) });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'p', addresses: ["a@b.co email "] }),
      env
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });
  it('none parse (leading-space) does not throw', async () => {
    const env = makeEnv({ cache: mockKv({ 'identity:pepper': 'p' }) });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'p', addresses: [" a@b.co email"] }),
      env
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });
  it('none parse (tab-sep) does not throw', async () => {
    const env = makeEnv({ cache: mockKv({ 'identity:pepper': 'p' }) });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'p', addresses: ["a@b.co\temail"] }),
      env
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });
});
