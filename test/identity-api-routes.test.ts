/**
 * TOKENMAXX HEAVY deepen after #101/#102/#103 — identity email/3PID lookup (email-fed slice).
 * Deep route coverage for src/api/identity.ts via Hono app.request().
 * Tests-only — no product changes. Fixtures use example.com only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { sha256 } from '../src/utils/crypto';

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

type IdentityAssociation = {
  medium: string;
  address: string;
  mxid: string;
};

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
} = {}) {
  const associations = [...(opts.associations ?? [])];
  const emailSessions = opts.emailSessions ?? new Map<string, EmailVerificationSession>();
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];

  function matchIdentityAssociationsAll() {
    return { results: [...associations] };
  }

  const db = {
    associations,
    emailSessions,
    inserts,
    updates,
    prepare(sql: string) {
      const stmt = {
        async all<T>() {
          if (sql.includes('FROM identity_associations') && sql.includes('SELECT medium, address, mxid')) {
            return matchIdentityAssociationsAll() as { results: T[] };
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
                const [
                  sessionId,
                  email,
                  clientSecret,
                  token,
                  sendAttempt,
                  createdAt,
                  expiresAt,
                ] = args as [string, string, string, string, number, number, number];
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
): Promise<{ status: number; body: unknown; res: Response }> {
  const res = await identity.request(`http://localhost${path}`, init, env);
  let body: unknown = null;
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

const FIXED_NOW = 1_700_000_000_000;
const SEVEN_DAY_TTL = 7 * 24 * 60 * 60;

const sampleAssociations: IdentityAssociation[] = [
  { medium: 'email', address: 'alice@example.com', mxid: `@alice:${SERVER_NAME}` },
  { medium: 'email', address: 'bob@example.com', mxid: `@bob:${SERVER_NAME}` },
  { medium: 'msisdn', address: '+15551234567', mxid: `@carol:${SERVER_NAME}` },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-2222-3333-4444-555555555555');
  vi.spyOn(Math, 'random').mockReturnValue(0.42);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('GET /_matrix/identity/v2 — status', () => {
  it('returns empty JSON object', async () => {
    const { status, body } = await jsonRequest(BASE);
    expect(status).toBe(200);
    expect(body).toEqual({});
  });
});

describe('GET /_matrix/identity/v2/account', () => {
  it('returns M_MISSING_TOKEN when Authorization header is absent', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`);
    expect(status).toBe(401);
    expect(body).toMatchObject({
      errcode: 'M_MISSING_TOKEN',
      error: 'Missing access token',
    });
  });

  it('returns M_MISSING_TOKEN for non-Bearer Authorization schemes', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: 'Basic abc123' },
    });
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('returns M_MISSING_TOKEN when Authorization is exactly "Bearer" without trailing space', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: 'Bearer' },
    });
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('accepts Bearer token and returns unknown user_id for this server', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: 'Bearer hs-access-token-abc' },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ user_id: `@unknown:${SERVER_NAME}` });
  });

  it('"Bearer " yields empty slice(7) token — falsy guard still returns M_MISSING_TOKEN', async () => {
    // extractBearerToken("Bearer ") returns "" (not null); `if (!token)` rejects empty string
    const { status, body } = await jsonRequest(`${BASE}/account`, {
      headers: { Authorization: 'Bearer ' },
    });
    expect(status).toBe(401);
    expect(body).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });
});

describe('POST /_matrix/identity/v2/account/register', () => {
  it('returns M_BAD_JSON for malformed JSON body', async () => {
    const { status, body } = await jsonRequest(`${BASE}/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    expect(status).toBe(400);
    expect(body).toMatchObject({
      errcode: 'M_BAD_JSON',
      error: 'Could not parse request body as JSON',
    });
  });

  it('echoes access_token as token on successful registration', async () => {
    const payload = {
      access_token: 'matrix-hs-token-xyz',
      token_type: 'Bearer',
      matrix_server_name: SERVER_NAME,
      expires_in: 3600,
    };
    const { status, body } = await jsonRequest(`${BASE}/account/register`, postJson(payload));
    expect(status).toBe(200);
    expect(body).toEqual({ token: payload.access_token });
  });
});

describe('GET+POST /_matrix/identity/v2/terms', () => {
  it('GET returns empty policies object', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`);
    expect(status).toBe(200);
    expect(body).toEqual({ policies: {} });
  });

  it('POST accept terms returns empty JSON object', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_acceptance: {} }),
    });
    expect(status).toBe(200);
    expect(body).toEqual({});
  });
});

describe('GET /_matrix/identity/v2/hash_details — lookup pepper', () => {
  it('creates identity:pepper in CACHE with 7-day TTL on first call', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, env);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      lookup_pepper: '11111111222233334444555555555555',
      algorithms: ['sha256', 'none'],
    });
    expect(cache.puts).toHaveLength(1);
    expect(cache.puts[0]).toEqual({
      key: 'identity:pepper',
      value: '11111111222233334444555555555555',
      options: { expirationTtl: SEVEN_DAY_TTL },
    });
  });

  it('returns existing pepper on second call without additional CACHE put', async () => {
    const cache = mockKv({ 'identity:pepper': 'preexisting-pepper-value' });
    const env = makeEnv({ cache });

    const first = await jsonRequest(`${BASE}/hash_details`, {}, env);
    const second = await jsonRequest(`${BASE}/hash_details`, {}, env);

    expect(first.body).toMatchObject({ lookup_pepper: 'preexisting-pepper-value' });
    expect(second.body).toMatchObject({ lookup_pepper: 'preexisting-pepper-value' });
    expect(cache.puts).toHaveLength(0);
  });

  it('reuses pepper created on first request for subsequent hash_details and lookup', async () => {
    const cache = mockKv();
    const db = createIdentityDb({ associations: sampleAssociations });
    const env = makeEnv({ cache, db });

    const details = await jsonRequest(`${BASE}/hash_details`, {}, env);
    const pepper = (details.body as { lookup_pepper: string }).lookup_pepper;
    expect(cache.puts).toHaveLength(1);

    const aliceHash = await sha256(`alice@example.com email ${pepper}`);
    const lookup = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [aliceHash] }),
      env
    );
    expect(lookup.status).toBe(200);
    expect(lookup.body).toEqual({ mappings: { [aliceHash]: `@alice:${SERVER_NAME}` } });
    expect(cache.puts).toHaveLength(1);
  });
});

describe('POST /_matrix/identity/v2/lookup', () => {
  async function lookupWithPepper(
    body: Record<string, unknown>,
    env: Env,
    pepper: string
  ) {
    return jsonRequest(`${BASE}/lookup`, postJson({ pepper, ...body }), env);
  }

  it('returns M_BAD_JSON for malformed JSON', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-a' });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{broken',
      },
      makeEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('returns M_INVALID_PARAM when algorithm is missing', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-a' });
    const { status, body } = await lookupWithPepper(
      { addresses: ['hash1'] },
      makeEnv({ cache }),
      'pepper-a'
    );
    expect(status).toBe(400);
    expect(body).toEqual({ errcode: 'M_INVALID_PARAM', error: 'Missing required fields' });
  });

  it('returns M_INVALID_PARAM when addresses is missing', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-a' });
    const { status, body } = await lookupWithPepper(
      { algorithm: 'sha256' },
      makeEnv({ cache }),
      'pepper-a'
    );
    expect(status).toBe(400);
    expect(body).toEqual({ errcode: 'M_INVALID_PARAM', error: 'Missing required fields' });
  });

  it('returns M_INVALID_PARAM when addresses is not an array', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-a' });
    const { status, body } = await lookupWithPepper(
      { algorithm: 'sha256', addresses: 'not-an-array' },
      makeEnv({ cache }),
      'pepper-a'
    );
    expect(status).toBe(400);
    expect(body).toEqual({ errcode: 'M_INVALID_PARAM', error: 'Missing required fields' });
  });

  it('returns M_INVALID_PEPPER with current lookup_pepper when pepper mismatches', async () => {
    const cache = mockKv({ 'identity:pepper': 'correct-pepper' });
    const { status, body } = await lookupWithPepper(
      { algorithm: 'sha256', addresses: [] },
      makeEnv({ cache }),
      'wrong-pepper'
    );
    expect(status).toBe(400);
    expect(body).toEqual({
      errcode: 'M_INVALID_PEPPER',
      error: 'Pepper does not match',
      algorithm: 'sha256',
      lookup_pepper: 'correct-pepper',
    });
  });

  it('sha256 algorithm maps hashed addresses via identity_associations SELECT all', async () => {
    const pepper = 'lookup-pepper-sha';
    const cache = mockKv({ 'identity:pepper': pepper });
    const db = createIdentityDb({ associations: sampleAssociations });
    const env = makeEnv({ cache, db });

    const aliceHash = await sha256(`alice@example.com email ${pepper}`);
    const bobHash = await sha256(`bob@example.com email ${pepper}`);
    const missHash = await sha256(`nobody@example.com email ${pepper}`);

    const { status, body } = await lookupWithPepper(
      { algorithm: 'sha256', addresses: [aliceHash, bobHash, missHash] },
      env,
      pepper
    );

    expect(status).toBe(200);
    expect(body).toEqual({
      mappings: {
        [aliceHash]: `@alice:${SERVER_NAME}`,
        [bobHash]: `@bob:${SERVER_NAME}`,
      },
    });
  });

  it('sha256 hash input order is address, medium, pepper separated by spaces', async () => {
    const pepper = 'order-pepper';
    const cache = mockKv({ 'identity:pepper': pepper });
    const db = createIdentityDb({
      associations: [{ medium: 'email', address: 'test@example.com', mxid: `@test:${SERVER_NAME}` }],
    });
    const env = makeEnv({ cache, db });

    const correctHash = await sha256(`test@example.com email ${pepper}`);
    const wrongOrderHash = await sha256(`email test@example.com ${pepper}`);

    const hit = await lookupWithPepper(
      { algorithm: 'sha256', addresses: [correctHash] },
      env,
      pepper
    );
    const miss = await lookupWithPepper(
      { algorithm: 'sha256', addresses: [wrongOrderHash] },
      env,
      pepper
    );

    expect(hit.body).toEqual({ mappings: { [correctHash]: `@test:${SERVER_NAME}` } });
    expect(miss.body).toEqual({ mappings: {} });
  });

  it('none algorithm resolves "address medium" pairs via medium+address SELECT', async () => {
    const pepper = 'none-pepper';
    const cache = mockKv({ 'identity:pepper': pepper });
    const db = createIdentityDb({ associations: sampleAssociations });
    const env = makeEnv({ cache, db });

    const { status, body } = await lookupWithPepper(
      {
        algorithm: 'none',
        addresses: [
          'alice@example.com email',
          'bob@example.com email',
          '+15551234567 msisdn',
          'missing@example.com email',
        ],
      },
      env,
      pepper
    );

    expect(status).toBe(200);
    expect(body).toEqual({
      mappings: {
        'alice@example.com email': `@alice:${SERVER_NAME}`,
        'bob@example.com email': `@bob:${SERVER_NAME}`,
        '+15551234567 msisdn': `@carol:${SERVER_NAME}`,
      },
    });
  });

  it('none algorithm skips entries with fewer than two space-separated parts', async () => {
    const pepper = 'none-pepper';
    const cache = mockKv({ 'identity:pepper': pepper });
    const db = createIdentityDb({ associations: sampleAssociations });
    const env = makeEnv({ cache, db });

    const { status, body } = await lookupWithPepper(
      {
        algorithm: 'none',
        addresses: ['only-address', 'alice@example.com', ''],
      },
      env,
      pepper
    );

    expect(status).toBe(200);
    expect(body).toEqual({ mappings: {} });
  });

  it('none algorithm returns empty mappings for unknown address/medium pairs', async () => {
    const pepper = 'none-pepper';
    const cache = mockKv({ 'identity:pepper': pepper });
    const db = createIdentityDb({ associations: [] });
    const env = makeEnv({ cache, db });

    const { status, body } = await lookupWithPepper(
      { algorithm: 'none', addresses: ['ghost@example.com email'] },
      env,
      pepper
    );

    expect(status).toBe(200);
    expect(body).toEqual({ mappings: {} });
  });

  it('returns M_INVALID_PARAM for unknown algorithm', async () => {
    const pepper = 'pepper-x';
    const cache = mockKv({ 'identity:pepper': pepper });
    const { status, body } = await lookupWithPepper(
      { algorithm: 'md5', addresses: [] },
      makeEnv({ cache }),
      pepper
    );
    expect(status).toBe(400);
    expect(body).toEqual({
      errcode: 'M_INVALID_PARAM',
      error: 'Unknown algorithm: md5',
    });
  });
});

describe('POST /_matrix/identity/v2/validate/email/requestToken', () => {
  it('returns M_BAD_JSON for malformed JSON', async () => {
    const { status, body } = await jsonRequest(`${BASE}/validate/email/requestToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(status).toBe(400);
    expect(body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('returns M_MISSING_PARAM when email is absent', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ client_secret: 'secret', send_attempt: 1 })
    );
    expect(status).toBe(400);
    expect(body).toEqual({
      errcode: 'M_MISSING_PARAM',
      error: 'Missing email or client_secret',
    });
  });

  it('returns M_MISSING_PARAM when client_secret is absent', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: 'user@example.com', send_attempt: 1 })
    );
    expect(status).toBe(400);
    expect(body).toEqual({
      errcode: 'M_MISSING_PARAM',
      error: 'Missing email or client_secret',
    });
  });

  it('inserts email_verification_sessions row and returns sid without sending email', async () => {
    const db = createIdentityDb();
    const env = makeEnv({ db });

    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({
        email: 'newuser@example.com',
        client_secret: 'client-secret-abc',
        send_attempt: 2,
      }),
      env
    );

    expect(status).toBe(200);
    expect(body).toEqual({ sid: '11111111-2222-3333-4444-555555555555' });

    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].sql).toContain('INSERT INTO email_verification_sessions');
    expect(db.inserts[0].args).toEqual([
      '11111111-2222-3333-4444-555555555555',
      'newuser@example.com',
      'client-secret-abc',
      '478000',
      2,
      FIXED_NOW,
      FIXED_NOW + 24 * 60 * 60 * 1000,
    ]);

    const session = db.emailSessions.get('11111111-2222-3333-4444-555555555555');
    expect(session).toMatchObject({
      email: 'newuser@example.com',
      client_secret: 'client-secret-abc',
      token: '478000',
      send_attempt: 2,
      validated: 0,
      expires_at: FIXED_NOW + 86_400_000,
    });
  });

  it('generates six-digit token from Math.random floor range', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const db = createIdentityDb();
    const env = makeEnv({ db });

    await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({
        email: 'a@example.com',
        client_secret: 'sec',
        send_attempt: 0,
      }),
      env
    );

    expect(db.inserts[0].args[3]).toBe('100000');
  });
});

describe('POST /_matrix/identity/v2/validate/email/submitToken', () => {
  const SID = 'sess-1111-2222-3333-444455556666';
  const CLIENT_SECRET = 'submit-client-secret';
  const EMAIL = 'verify@example.com';
  const TOKEN = '654321';

  function seedSession(
    db: ReturnType<typeof createIdentityDb>,
    overrides: Partial<EmailVerificationSession> = {}
  ) {
    db.emailSessions.set(SID, {
      session_id: SID,
      email: EMAIL,
      client_secret: CLIENT_SECRET,
      token: TOKEN,
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW - 60_000,
      expires_at: FIXED_NOW + 60_000,
      validated_at: null,
      ...overrides,
    });
  }

  it('returns M_BAD_JSON for malformed JSON', async () => {
    const { status, body } = await jsonRequest(`${BASE}/validate/email/submitToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(status).toBe(400);
    expect(body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('returns M_NO_VALID_SESSION when session_id/client_secret pair is unknown', async () => {
    const db = createIdentityDb();
    const env = makeEnv({ db });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid: SID, client_secret: 'wrong-secret', token: TOKEN }),
      env
    );
    expect(status).toBe(400);
    expect(body).toEqual({
      errcode: 'M_NO_VALID_SESSION',
      error: 'Session not found',
    });
  });

  it('returns M_SESSION_EXPIRED when expires_at is strictly before Date.now()', async () => {
    const db = createIdentityDb();
    seedSession(db, { expires_at: FIXED_NOW - 1 });
    const env = makeEnv({ db });

    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid: SID, client_secret: CLIENT_SECRET, token: TOKEN }),
      env
    );
    expect(status).toBe(400);
    expect(body).toEqual({
      errcode: 'M_SESSION_EXPIRED',
      error: 'Session expired',
    });
  });

  it('does NOT treat expires_at === Date.now() as expired (uses < not <=)', async () => {
    const db = createIdentityDb();
    seedSession(db, { expires_at: FIXED_NOW });
    const env = makeEnv({ db });

    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid: SID, client_secret: CLIENT_SECRET, token: TOKEN }),
      env
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.updates).toHaveLength(1);
    expect(db.emailSessions.get(SID)?.validated).toBe(1);
  });

  it('returns M_INVALID_PARAM when submitted token does not match session token', async () => {
    const db = createIdentityDb();
    seedSession(db);
    const env = makeEnv({ db });

    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid: SID, client_secret: CLIENT_SECRET, token: '000000' }),
      env
    );
    expect(status).toBe(400);
    expect(body).toEqual({
      errcode: 'M_INVALID_PARAM',
      error: 'Invalid token',
    });
    expect(db.updates).toHaveLength(0);
  });

  it('marks session validated=1 and returns success on correct token', async () => {
    const db = createIdentityDb();
    seedSession(db, { expires_at: FIXED_NOW + 3_600_000 });
    const env = makeEnv({ db });

    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid: SID, client_secret: CLIENT_SECRET, token: TOKEN }),
      env
    );

    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].sql).toContain('UPDATE email_verification_sessions SET validated = 1');
    expect(db.updates[0].args).toEqual([FIXED_NOW, SID]);

    const session = db.emailSessions.get(SID);
    expect(session?.validated).toBe(1);
    expect(session?.validated_at).toBe(FIXED_NOW);
  });

  it('rejects when sid exists but client_secret mismatches (session not found)', async () => {
    const db = createIdentityDb();
    seedSession(db);
    const env = makeEnv({ db });

    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid: SID, client_secret: 'other-secret', token: TOKEN }),
      env
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ errcode: 'M_NO_VALID_SESSION' });
  });
});

describe('identity routes — cross-endpoint integration', () => {
  it('full email validation flow: requestToken then submitToken', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('flow-session-uuid-0001');
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const db = createIdentityDb();
    const env = makeEnv({ db });

    const request = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({
        email: 'flow@example.com',
        client_secret: 'flow-secret',
        send_attempt: 1,
      }),
      env
    );
    expect(request.status).toBe(200);
    const sid = (request.body as { sid: string }).sid;

    const session = db.emailSessions.get(sid);
    expect(session).toBeDefined();
    const token = session!.token;

    const submit = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'flow-secret', token }),
      env
    );
    expect(submit.status).toBe(200);
    expect(submit.body).toEqual({ success: true });
    expect(db.emailSessions.get(sid)?.validated).toBe(1);
  });

  it('lookup sha256 + none algorithms agree for same association', async () => {
    const pepper = 'shared-pepper';
    const cache = mockKv({ 'identity:pepper': pepper });
    const associations: IdentityAssociation[] = [
      { medium: 'email', address: 'same@example.com', mxid: `@same:${SERVER_NAME}` },
    ];
    const db = createIdentityDb({ associations });
    const env = makeEnv({ cache, db });

    const hash = await sha256(`same@example.com email ${pepper}`);

    const sha = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [hash] }),
      env
    );
    const none = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: ['same@example.com email'] }),
      env
    );

    expect(sha.body).toEqual({ mappings: { [hash]: `@same:${SERVER_NAME}` } });
    expect(none.body).toEqual({ mappings: { 'same@example.com email': `@same:${SERVER_NAME}` } });
  });
});
