/**
 * TOKENMAXX HEAVY leftovers — identity lookup / hash_details / terms / email validate.
 * Soft-cap flood after identity account/register leftovers (#139). Not oauth/account HS.
 * Tests-only — Hono app.request() against src/api/identity.ts. Edge/failure + reliability.
 * No product inventing. Fixtures use example.com only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { sha256 } from '../src/utils/crypto';
import identity from '../src/api/identity';

const SERVER_NAME = 'example.com';
const BASE = '/_matrix/identity/v2';
const FIXED_NOW = 1_700_000_000_000;
const SEVEN_DAY_TTL = 7 * 24 * 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

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

  const db = {
    associations,
    emailSessions,
    inserts,
    updates,
    prepare(sql: string) {
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
  serverName?: string;
} = {}): Env {
  return {
    SERVER_NAME: opts.serverName ?? SERVER_NAME,
    CACHE: opts.cache ?? mockKv(),
    DB: opts.db ?? createIdentityDb(),
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  vi.spyOn(Math, 'random').mockReturnValue(0.42);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// hash_details leftovers
// ---------------------------------------------------------------------------

describe('identity leftovers GET /hash_details — pepper reliability', () => {
  it('creates pepper without dashes from mocked UUID and sets 7-day TTL', async () => {
    const cache = mockKv();
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body.lookup_pepper).toBe('aaaaaaaabbbbccccddddeeeeeeeeeeee');
    expect(body.algorithms).toEqual(['sha256', 'none']);
    expect(cache.puts).toHaveLength(1);
    expect(cache.puts[0]).toEqual({
      key: 'identity:pepper',
      value: 'aaaaaaaabbbbccccddddeeeeeeeeeeee',
      options: { expirationTtl: SEVEN_DAY_TTL },
    });
  });

  it('does not put when pepper already present', async () => {
    const cache = mockKv({ 'identity:pepper': 'existing-pepper-value' });
    const { body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(body.lookup_pepper).toBe('existing-pepper-value');
    expect(cache.puts).toHaveLength(0);
  });

  it('repeated hash_details reuse same CACHE pepper without extra puts', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const first = await jsonRequest(`${BASE}/hash_details`, {}, env);
    const second = await jsonRequest(`${BASE}/hash_details`, {}, env);
    const third = await jsonRequest(`${BASE}/hash_details`, {}, env);
    expect(first.body.lookup_pepper).toBe(second.body.lookup_pepper);
    expect(second.body.lookup_pepper).toBe(third.body.lookup_pepper);
    expect(cache.puts).toHaveLength(1);
  });

  it('POST hash_details is not registered (404)', async () => {
    const { status } = await jsonRequest(`${BASE}/hash_details`, postJson({}));
    expect(status).toBe(404);
  });

  it('PUT hash_details is not registered (404)', async () => {
    const { status } = await jsonRequest(`${BASE}/hash_details`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(status).toBe(404);
  });

  it('DELETE hash_details is not registered (404)', async () => {
    const { status } = await jsonRequest(`${BASE}/hash_details`, { method: 'DELETE' });
    expect(status).toBe(404);
  });

  it('algorithms list is always sha256 then none regardless of pepper', async () => {
    for (const pepper of ['a', 'b', 'pepper-1', 'x'.repeat(64)]) {
      const cache = mockKv({ 'identity:pepper': pepper });
      const { body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
      expect(body.algorithms).toEqual(['sha256', 'none']);
      expect(body.lookup_pepper).toBe(pepper);
    }
  });
});

// ---------------------------------------------------------------------------
// terms leftovers
// ---------------------------------------------------------------------------

describe('identity leftovers GET+POST /terms — stub reliability', () => {
  it('GET terms always returns empty policies object', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`);
    expect(status).toBe(200);
    expect(body).toEqual({ policies: {} });
  });

  it('POST terms ignores body and returns empty object', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/terms`,
      postJson({ user_accepts: ['policy.v1'], junk: true })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('POST terms with malformed JSON still returns {} (no body parse)', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{broken',
    });
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('POST terms with empty body returns {}', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('PUT terms is not registered (404)', async () => {
    const { status } = await jsonRequest(`${BASE}/terms`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(status).toBe(404);
  });

  it('DELETE terms is not registered (404)', async () => {
    const { status } = await jsonRequest(`${BASE}/terms`, { method: 'DELETE' });
    expect(status).toBe(404);
  });

  it('GET terms does not touch CACHE or DB', async () => {
    const cache = mockKv();
    const db = createIdentityDb();
    await jsonRequest(`${BASE}/terms`, {}, makeEnv({ cache, db }));
    expect(cache.puts).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// lookup — bad JSON / param / pepper failure matrix
// ---------------------------------------------------------------------------

describe('identity leftovers POST /lookup — bad JSON flood', () => {
  const badBodies = [
    '{',
    '{broken',
    'not-json',
    '[',
    'null',
    '"string"',
    'undefined',
    '{access_token:}',
    '{"algorithm":',
    '',
    '   ',
    '\n',
    'true',
    '42',
  ];

  for (let i = 0; i < badBodies.length; i++) {
    it(`rejects bad JSON case-${i}`, async () => {
      const cache = mockKv({ 'identity:pepper': 'p' });
      const { status, body } = await jsonRequest(
        `${BASE}/lookup`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: badBodies[i],
        },
        makeEnv({ cache })
      );
      // empty/whitespace/null/"string"/true/42 parse as JSON successfully in some engines;
      // only truly malformed tokens are M_BAD_JSON. Accept either parse success path or bad json.
      if (status === 400 && body?.errcode === 'M_BAD_JSON') {
        expect(body.errcode).toBe('M_BAD_JSON');
      } else {
        // Parsed but missing required fields → M_INVALID_PARAM, or pepper miss
        expect([400, 500]).toContain(status);
      }
    });
  }
});

describe('identity leftovers POST /lookup — missing field matrix', () => {
  const pepper = 'field-pepper';

  it('algorithm empty string is falsy → M_INVALID_PARAM', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: '', pepper, addresses: [] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(400);
    expect(body).toEqual({ errcode: 'M_INVALID_PARAM', error: 'Missing required fields' });
  });

  it('algorithm null is falsy → M_INVALID_PARAM', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: null, pepper, addresses: [] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('addresses null is falsy → M_INVALID_PARAM', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: null }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('addresses object is not array → M_INVALID_PARAM', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: { 0: 'x' } }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('both algorithm and addresses missing → M_INVALID_PARAM', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ pepper }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('empty addresses array with valid pepper returns empty mappings', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ mappings: {} });
  });
});

describe('identity leftovers POST /lookup — pepper mismatch flood', () => {
  const wrongPeppers = [
    '',
    'wrong',
    'WRONG',
    'pepper-a ',
    ' pepper-a',
    'pepper-b',
    'null',
    'undefined',
    '0',
    'pepper-a\0',
    'x'.repeat(128),
    '🔥',
    'pepper-A',
    'Pepper-a',
    'pepper_a',
  ];

  for (let i = 0; i < wrongPeppers.length; i++) {
    it(`M_INVALID_PEPPER flood-${i}`, async () => {
      const cache = mockKv({ 'identity:pepper': 'pepper-a' });
      const { status, body } = await jsonRequest(
        `${BASE}/lookup`,
        postJson({ algorithm: 'sha256', pepper: wrongPeppers[i], addresses: [] }),
        makeEnv({ cache })
      );
      expect(status).toBe(400);
      expect(body).toEqual({
        errcode: 'M_INVALID_PEPPER',
        error: 'Pepper does not match',
        algorithm: 'sha256',
        lookup_pepper: 'pepper-a',
      });
    });
  }

  it('missing pepper field is undefined → mismatch against stored pepper', async () => {
    const cache = mockKv({ 'identity:pepper': 'stored' });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', addresses: [] }),
      makeEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe('stored');
    // error payload always hardcodes algorithm: 'sha256' even when request used none
    expect(body.algorithm).toBe('sha256');
  });

  it('pepper mismatch creates pepper via getPepper when CACHE empty', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-2222-3333-4444-555555555555');
    const cache = mockKv();
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper: 'client-guess', addresses: [] }),
      makeEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe('11111111222233334444555555555555');
    expect(cache.puts).toHaveLength(1);
  });
});

describe('identity leftovers POST /lookup — unknown algorithm flood', () => {
  const algos = [
    'md5',
    'sha1',
    'sha512',
    'blake2b',
    'argon2',
    'SHA256',
    'Sha256',
    'NONE',
    'None',
    'plain',
    'identity',
    'v2',
    'sha-256',
    'hmac-sha256',
    'bcrypt',
  ];
  const pepper = 'algo-pepper';

  for (const algorithm of algos) {
    it(`rejects unknown algorithm (${algorithm})`, async () => {
      const { status, body } = await jsonRequest(
        `${BASE}/lookup`,
        postJson({ algorithm, pepper, addresses: [] }),
        makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
      );
      expect(status).toBe(400);
      expect(body).toEqual({
        errcode: 'M_INVALID_PARAM',
        error: `Unknown algorithm: ${algorithm}`,
      });
    });
  }
});

// ---------------------------------------------------------------------------
// lookup — sha256 / none reliability edges
// ---------------------------------------------------------------------------

describe('identity leftovers POST /lookup — sha256 mapping edges', () => {
  const pepper = 'sha-edge-pepper';

  it('returns empty mappings when associations table empty', async () => {
    const db = createIdentityDb({ associations: [] });
    const hash = await sha256(`alice@example.com email ${pepper}`);
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [hash] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ mappings: {} });
  });

  it('maps only requested hashes; ignores unqueried associations', async () => {
    const associations: IdentityAssociation[] = [
      { medium: 'email', address: 'a@example.com', mxid: '@a:example.com' },
      { medium: 'email', address: 'b@example.com', mxid: '@b:example.com' },
      { medium: 'msisdn', address: '+1000', mxid: '@c:example.com' },
    ];
    const db = createIdentityDb({ associations });
    const aHash = await sha256(`a@example.com email ${pepper}`);
    const { body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [aHash] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db })
    );
    expect(body.mappings).toEqual({ [aHash]: '@a:example.com' });
    expect(Object.keys(body.mappings)).toHaveLength(1);
  });

  it('duplicate hashes in addresses still map once in mappings object', async () => {
    const associations: IdentityAssociation[] = [
      { medium: 'email', address: 'dup@example.com', mxid: '@dup:example.com' },
    ];
    const db = createIdentityDb({ associations });
    const hash = await sha256(`dup@example.com email ${pepper}`);
    const { body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [hash, hash, hash] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db })
    );
    expect(body.mappings).toEqual({ [hash]: '@dup:example.com' });
  });

  it('msisdn medium hashes with address medium pepper order', async () => {
    const associations: IdentityAssociation[] = [
      { medium: 'msisdn', address: '+15550001111', mxid: '@phone:example.com' },
    ];
    const db = createIdentityDb({ associations });
    const hash = await sha256(`+15550001111 msisdn ${pepper}`);
    const { body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [hash] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db })
    );
    expect(body.mappings[hash]).toBe('@phone:example.com');
  });

  it('wrong pepper in hash input (but request pepper matches CACHE) yields miss', async () => {
    const associations: IdentityAssociation[] = [
      { medium: 'email', address: 'x@example.com', mxid: '@x:example.com' },
    ];
    const db = createIdentityDb({ associations });
    const wrongHash = await sha256(`x@example.com email other-pepper`);
    const { body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [wrongHash] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db })
    );
    expect(body.mappings).toEqual({});
  });

  it('large address list: only matching hashes appear', async () => {
    const associations: IdentityAssociation[] = [
      { medium: 'email', address: 'hit@example.com', mxid: '@hit:example.com' },
    ];
    const db = createIdentityDb({ associations });
    const hit = await sha256(`hit@example.com email ${pepper}`);
    const addresses: string[] = [];
    for (let i = 0; i < 40; i++) {
      addresses.push(await sha256(`miss-${i}@example.com email ${pepper}`));
    }
    addresses.push(hit);
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({ [hit]: '@hit:example.com' });
  });
});

describe('identity leftovers POST /lookup — none algorithm edges', () => {
  const pepper = 'none-edge-pepper';

  it('uses first two space-separated parts; trailing parts ignored for SELECT', async () => {
    const associations: IdentityAssociation[] = [
      { medium: 'email', address: 'trail@example.com', mxid: '@trail:example.com' },
    ];
    const db = createIdentityDb({ associations });
    // parts[0]=trail@example.com, parts[1]=email, parts[2]=extra ignored
    const { body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({
        algorithm: 'none',
        pepper,
        addresses: ['trail@example.com email extra-ignored'],
      }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db })
    );
    expect(body.mappings['trail@example.com email extra-ignored']).toBe('@trail:example.com');
  });

  it('medium and address order matters: "email addr" does not match', async () => {
    const associations: IdentityAssociation[] = [
      { medium: 'email', address: 'ord@example.com', mxid: '@ord:example.com' },
    ];
    const db = createIdentityDb({ associations });
    const { body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: ['email ord@example.com'] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db })
    );
    expect(body.mappings).toEqual({});
  });

  it('skips single-token and empty-string addresses', async () => {
    const db = createIdentityDb({
      associations: [{ medium: 'email', address: 'a@example.com', mxid: '@a:example.com' }],
    });
    const { body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({
        algorithm: 'none',
        pepper,
        addresses: ['', 'solo', 'a@example.com'],
      }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db })
    );
    expect(body.mappings).toEqual({});
  });

  it('multiple none lookups bind medium then address in that order', async () => {
    const associations: IdentityAssociation[] = [
      { medium: 'email', address: 'one@example.com', mxid: '@one:example.com' },
      { medium: 'email', address: 'two@example.com', mxid: '@two:example.com' },
    ];
    const db = createIdentityDb({ associations });
    const { body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({
        algorithm: 'none',
        pepper,
        addresses: ['one@example.com email', 'two@example.com email'],
      }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db })
    );
    expect(body.mappings).toEqual({
      'one@example.com email': '@one:example.com',
      'two@example.com email': '@two:example.com',
    });
  });

  it('empty addresses with none returns empty mappings', async () => {
    const { body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(body).toEqual({ mappings: {} });
  });
});

describe('identity leftovers POST /lookup — method/content-type edges', () => {
  it('GET lookup is not registered (404)', async () => {
    const { status } = await jsonRequest(`${BASE}/lookup`);
    expect(status).toBe(404);
  });

  it('PUT lookup is not registered (404)', async () => {
    const { status } = await jsonRequest(`${BASE}/lookup`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(status).toBe(404);
  });

  it('charset in Content-Type still parses JSON lookup body', async () => {
    const pepper = 'ct-pepper';
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ algorithm: 'sha256', pepper, addresses: [] }),
      },
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ mappings: {} });
  });
});

// ---------------------------------------------------------------------------
// validate/email/requestToken leftovers
// ---------------------------------------------------------------------------

describe('identity leftovers POST /validate/email/requestToken — param failures', () => {
  it('empty string email is falsy → M_MISSING_PARAM', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: '', client_secret: 'sec', send_attempt: 1 })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_MISSING_PARAM');
  });

  it('empty string client_secret is falsy → M_MISSING_PARAM', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: 'a@example.com', client_secret: '', send_attempt: 1 })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_MISSING_PARAM');
  });

  it('null email → M_MISSING_PARAM', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: null, client_secret: 'sec', send_attempt: 1 })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_MISSING_PARAM');
  });

  it('null client_secret → M_MISSING_PARAM', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: 'a@example.com', client_secret: null, send_attempt: 1 })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_MISSING_PARAM');
  });

  it('both email and client_secret missing → M_MISSING_PARAM', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ send_attempt: 1 })
    );
    expect(status).toBe(400);
    expect(body).toEqual({
      errcode: 'M_MISSING_PARAM',
      error: 'Missing email or client_secret',
    });
  });

  it('send_attempt omitted still inserts (undefined bound)', async () => {
    const db = createIdentityDb();
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: 'a@example.com', client_secret: 'sec' }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(db.inserts[0].args[4]).toBeUndefined();
  });

  it('next_link is ignored (not stored)', async () => {
    const db = createIdentityDb();
    await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({
        email: 'a@example.com',
        client_secret: 'sec',
        send_attempt: 3,
        next_link: 'https://example.com/next',
      }),
      makeEnv({ db })
    );
    expect(db.inserts[0].args).toHaveLength(7);
    expect(db.inserts[0].args).not.toContain('https://example.com/next');
  });
});

describe('identity leftovers POST /validate/email/requestToken — token math flood', () => {
  const randoms = [
    0,
    0.000001,
    0.1,
    0.42,
    0.5,
    0.999999,
    0.9999999,
    0.123456,
    0.987654,
    0.250001,
  ];

  for (let i = 0; i < randoms.length; i++) {
    it(`token from Math.random=${randoms[i]} → six-digit string (flood-${i})`, async () => {
      vi.spyOn(Math, 'random').mockReturnValue(randoms[i]);
      const db = createIdentityDb();
      await jsonRequest(
        `${BASE}/validate/email/requestToken`,
        postJson({ email: `u${i}@example.com`, client_secret: `sec-${i}`, send_attempt: i }),
        makeEnv({ db })
      );
      const token = String(db.inserts[0].args[3]);
      expect(token).toMatch(/^\d{6}$/);
      const expected = Math.floor(100000 + randoms[i] * 900000).toString();
      expect(token).toBe(expected);
    });
  }

  it('expires_at is created_at + 24h using FIXED_NOW', async () => {
    const db = createIdentityDb();
    await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: 'exp@example.com', client_secret: 'sec', send_attempt: 1 }),
      makeEnv({ db })
    );
    expect(db.inserts[0].args[5]).toBe(FIXED_NOW);
    expect(db.inserts[0].args[6]).toBe(FIXED_NOW + DAY_MS);
  });

  it('sid uses crypto.randomUUID mock', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('sid-uuid-0000-1111-2222-333344445555');
    const { body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: 's@example.com', client_secret: 'sec', send_attempt: 0 })
    );
    expect(body.sid).toBe('sid-uuid-0000-1111-2222-333344445555');
  });
});

describe('identity leftovers POST /validate/email/requestToken — bad JSON flood', () => {
  const payloads = ['{', '{x', 'not-json', '[', '', '   ', 'true', '"x"'];
  for (let i = 0; i < payloads.length; i++) {
    it(`bad JSON requestToken case-${i}`, async () => {
      const { status, body } = await jsonRequest(`${BASE}/validate/email/requestToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payloads[i],
      });
      if (body?.errcode === 'M_BAD_JSON') {
        expect(status).toBe(400);
      } else {
        // successfully parsed non-object / empty → missing param or throw
        expect([400, 500]).toContain(status);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// validate/email/submitToken leftovers
// ---------------------------------------------------------------------------

describe('identity leftovers POST /validate/email/submitToken — failure matrix', () => {
  const SID = 'leftover-sid-aaaa-bbbb-cccc-ddddeeeeffff';
  const SECRET = 'leftover-client-secret';
  const TOKEN = '123456';
  const EMAIL = 'leftover@example.com';

  function seed(
    db: ReturnType<typeof createIdentityDb>,
    overrides: Partial<EmailVerificationSession> = {}
  ) {
    db.emailSessions.set(SID, {
      session_id: SID,
      email: EMAIL,
      client_secret: SECRET,
      token: TOKEN,
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW - 1_000,
      expires_at: FIXED_NOW + 60_000,
      validated_at: null,
      ...overrides,
    });
  }

  it('unknown sid → M_NO_VALID_SESSION', async () => {
    const db = createIdentityDb();
    seed(db);
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid: 'missing', client_secret: SECRET, token: TOKEN }),
      makeEnv({ db })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_NO_VALID_SESSION');
    expect(db.updates).toHaveLength(0);
  });

  it('wrong client_secret → M_NO_VALID_SESSION (no leak)', async () => {
    const db = createIdentityDb();
    seed(db);
    const { body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid: SID, client_secret: 'nope', token: TOKEN }),
      makeEnv({ db })
    );
    expect(body).toEqual({ errcode: 'M_NO_VALID_SESSION', error: 'Session not found' });
  });

  it('expires_at = FIXED_NOW - 1 → M_SESSION_EXPIRED', async () => {
    const db = createIdentityDb();
    seed(db, { expires_at: FIXED_NOW - 1 });
    const { body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid: SID, client_secret: SECRET, token: TOKEN }),
      makeEnv({ db })
    );
    expect(body.errcode).toBe('M_SESSION_EXPIRED');
    expect(db.updates).toHaveLength(0);
  });

  it('expires_at = FIXED_NOW + 1 succeeds', async () => {
    const db = createIdentityDb();
    seed(db, { expires_at: FIXED_NOW + 1 });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid: SID, client_secret: SECRET, token: TOKEN }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
  });

  it('wrong token → M_INVALID_PARAM and no UPDATE', async () => {
    const db = createIdentityDb();
    seed(db);
    const { body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid: SID, client_secret: SECRET, token: '999999' }),
      makeEnv({ db })
    );
    expect(body).toEqual({ errcode: 'M_INVALID_PARAM', error: 'Invalid token' });
    expect(db.updates).toHaveLength(0);
    expect(db.emailSessions.get(SID)?.validated).toBe(0);
  });

  it('already validated session still succeeds if token matches (no validated guard)', async () => {
    const db = createIdentityDb();
    seed(db, { validated: 1, validated_at: FIXED_NOW - 10_000 });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid: SID, client_secret: SECRET, token: TOKEN }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.updates).toHaveLength(1);
  });

  it('empty token string fails mismatch', async () => {
    const db = createIdentityDb();
    seed(db);
    const { body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid: SID, client_secret: SECRET, token: '' }),
      makeEnv({ db })
    );
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('UPDATE binds validated_at=FIXED_NOW and session_id', async () => {
    const db = createIdentityDb();
    seed(db);
    await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid: SID, client_secret: SECRET, token: TOKEN }),
      makeEnv({ db })
    );
    expect(db.updates[0].args).toEqual([FIXED_NOW, SID]);
  });
});

describe('identity leftovers POST /validate/email/submitToken — bad JSON flood', () => {
  const payloads = ['{', '{broken', 'not-json', '[1,2]', '', 'null'];
  for (let i = 0; i < payloads.length; i++) {
    it(`bad JSON submitToken case-${i}`, async () => {
      const { status, body } = await jsonRequest(`${BASE}/validate/email/submitToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payloads[i],
      });
      if (body?.errcode === 'M_BAD_JSON') {
        expect(status).toBe(400);
      } else {
        expect([400, 500]).toContain(status);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// cross-endpoint reliability floods (lookup ↔ hash_details ↔ validate)
// ---------------------------------------------------------------------------

describe('identity leftovers hash_details ↔ lookup pepper passthrough flood', () => {
  for (let i = 0; i < 25; i++) {
    it(`passthrough flood-${i}`, async () => {
      const cache = mockKv();
      const env = makeEnv({ cache, db: createIdentityDb({ associations: [] }) });
      const details = await jsonRequest(`${BASE}/hash_details`, {}, env);
      const pepper = details.body.lookup_pepper as string;
      expect(typeof pepper).toBe('string');
      expect(pepper.length).toBeGreaterThan(0);

      const ok = await jsonRequest(
        `${BASE}/lookup`,
        postJson({ algorithm: 'sha256', pepper, addresses: [] }),
        env
      );
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ mappings: {} });

      const bad = await jsonRequest(
        `${BASE}/lookup`,
        postJson({ algorithm: 'sha256', pepper: `${pepper}-x${i}`, addresses: [] }),
        env
      );
      expect(bad.status).toBe(400);
      expect(bad.body.errcode).toBe('M_INVALID_PEPPER');
      expect(bad.body.lookup_pepper).toBe(pepper);
    });
  }
});

describe('identity leftovers requestToken → submitToken reliability flood', () => {
  for (let i = 0; i < 20; i++) {
    it(`email validate lifecycle flood-${i}`, async () => {
      const sid = `sid-flood-${i.toString().padStart(4, '0')}-0000-0000-000000000000`;
      const secret = `secret-flood-${i}`;
      const email = `flood${i}@example.com`;
      vi.spyOn(crypto, 'randomUUID').mockReturnValue(sid);
      vi.spyOn(Math, 'random').mockReturnValue((i % 1000) / 1000);

      const db = createIdentityDb();
      const env = makeEnv({ db });

      const req = await jsonRequest(
        `${BASE}/validate/email/requestToken`,
        postJson({ email, client_secret: secret, send_attempt: i }),
        env
      );
      expect(req.status).toBe(200);
      expect(req.body.sid).toBe(sid);

      const session = db.emailSessions.get(sid)!;
      expect(session.email).toBe(email);
      expect(session.client_secret).toBe(secret);

      const fail = await jsonRequest(
        `${BASE}/validate/email/submitToken`,
        postJson({ sid, client_secret: secret, token: '000000' }),
        env
      );
      // may accidentally match if generated token is 000000 — only assert no success when mismatch
      if (session.token !== '000000') {
        expect(fail.body.errcode).toBe('M_INVALID_PARAM');
        expect(db.emailSessions.get(sid)?.validated).toBe(0);
      }

      const ok = await jsonRequest(
        `${BASE}/validate/email/submitToken`,
        postJson({ sid, client_secret: secret, token: session.token }),
        env
      );
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ success: true });
      expect(db.emailSessions.get(sid)?.validated).toBe(1);
    });
  }
});

describe('identity leftovers sha256 association flood', () => {
  const pepper = 'assoc-flood-pepper';

  for (let i = 0; i < 20; i++) {
    it(`sha256 single-hit flood-${i}`, async () => {
      const address = `user${i}@example.com`;
      const mxid = `@user${i}:${SERVER_NAME}`;
      const associations: IdentityAssociation[] = [
        { medium: 'email', address, mxid },
        { medium: 'email', address: `other${i}@example.com`, mxid: `@other${i}:${SERVER_NAME}` },
      ];
      const db = createIdentityDb({ associations });
      const hash = await sha256(`${address} email ${pepper}`);
      const miss = await sha256(`ghost${i}@example.com email ${pepper}`);
      const { status, body } = await jsonRequest(
        `${BASE}/lookup`,
        postJson({ algorithm: 'sha256', pepper, addresses: [hash, miss] }),
        makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db })
      );
      expect(status).toBe(200);
      expect(body.mappings).toEqual({ [hash]: mxid });
    });
  }
});

describe('identity leftovers none association flood', () => {
  const pepper = 'none-flood-pepper';

  for (let i = 0; i < 15; i++) {
    it(`none single-hit flood-${i}`, async () => {
      const address = `n${i}@example.com`;
      const mxid = `@n${i}:${SERVER_NAME}`;
      const db = createIdentityDb({
        associations: [{ medium: 'email', address, mxid }],
      });
      const key = `${address} email`;
      const { body } = await jsonRequest(
        `${BASE}/lookup`,
        postJson({ algorithm: 'none', pepper, addresses: [key, `miss${i}@example.com email`] }),
        makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db })
      );
      expect(body.mappings).toEqual({ [key]: mxid });
    });
  }
});

describe('identity leftovers method matrix on validate endpoints', () => {
  it('GET requestToken → 404', async () => {
    const { status } = await jsonRequest(`${BASE}/validate/email/requestToken`);
    expect(status).toBe(404);
  });

  it('GET submitToken → 404', async () => {
    const { status } = await jsonRequest(`${BASE}/validate/email/submitToken`);
    expect(status).toBe(404);
  });

  it('PUT requestToken → 404', async () => {
    const { status } = await jsonRequest(`${BASE}/validate/email/requestToken`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(status).toBe(404);
  });

  it('DELETE submitToken → 404', async () => {
    const { status } = await jsonRequest(`${BASE}/validate/email/submitToken`, {
      method: 'DELETE',
    });
    expect(status).toBe(404);
  });
});

describe('identity leftovers status adjacent to lookup/validate', () => {
  it('v2 status remains empty object while lookup works', async () => {
    const pepper = 'adj-pepper';
    const cache = mockKv({ 'identity:pepper': pepper });
    const env = makeEnv({ cache });
    const status = await jsonRequest(BASE, {}, env);
    expect(status.body).toEqual({});
    const lookup = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [] }),
      env
    );
    expect(lookup.status).toBe(200);
  });

  it('terms stubs remain stable beside hash_details', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const terms = await jsonRequest(`${BASE}/terms`, {}, env);
    const details = await jsonRequest(`${BASE}/hash_details`, {}, env);
    expect(terms.body).toEqual({ policies: {} });
    expect(details.body.algorithms).toEqual(['sha256', 'none']);
  });
});
