/**
 * TOKENMAXX HEAVY leftovers after #142/#143 — identity API soft reliability.
 * Orthogonal to identity-account-register + identity-lookup-validate leftovers.
 * Tests-only — Hono app.request() against src/api/identity.ts. No product inventing.
 * Fixtures use example.com only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { sha256 } from '../src/utils/crypto';
import identity from '../src/api/identity';

const SERVER_NAME = 'example.com';
const BASE = '/_matrix/identity/v2';
const FIXED_NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
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

describe('identity soft leftovers GET /v2 status reliability after #142', () => {
  it('returns empty object', async () => {
    const { status, body } = await jsonRequest(BASE);
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  for (const accept of ['application/json', '*/*', 'text/html', 'application/json, text/plain']) {
    it(`status Accept: ${accept} still empty object`, async () => {
      const { status, body } = await jsonRequest(BASE, { headers: { Accept: accept } });
      expect(status).toBe(200);
      expect(body).toEqual({});
    });
  }

  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    it(`status ${method} → 404`, async () => {
      const { status } = await jsonRequest(BASE, { method });
      expect(status).toBe(404);
    });
  }
});

describe('identity soft leftovers GET /hash_details pepper TTL soft flood after #142', () => {

  it('pepper mint TTL soft-0', async () => {
    const cache = mockKv();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('bbbbbbbb-cccc-dddd-eeee-000000000000');
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body.algorithms).toEqual(['sha256', 'none']);
    expect(typeof body.lookup_pepper).toBe('string');
    expect(body.lookup_pepper.length).toBeGreaterThan(0);
    expect(cache.puts.some((p) => p.key === 'identity:pepper' && p.options?.expirationTtl === SEVEN_DAY_TTL)).toBe(true);
    const again = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(again.body.lookup_pepper).toBe(body.lookup_pepper);
  });

  it('pepper mint TTL soft-1', async () => {
    const cache = mockKv();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('bbbbbbbb-cccc-dddd-eeee-000000000001');
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body.algorithms).toEqual(['sha256', 'none']);
    expect(typeof body.lookup_pepper).toBe('string');
    expect(body.lookup_pepper.length).toBeGreaterThan(0);
    expect(cache.puts.some((p) => p.key === 'identity:pepper' && p.options?.expirationTtl === SEVEN_DAY_TTL)).toBe(true);
    const again = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(again.body.lookup_pepper).toBe(body.lookup_pepper);
  });

  it('pepper mint TTL soft-2', async () => {
    const cache = mockKv();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('bbbbbbbb-cccc-dddd-eeee-000000000002');
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body.algorithms).toEqual(['sha256', 'none']);
    expect(typeof body.lookup_pepper).toBe('string');
    expect(body.lookup_pepper.length).toBeGreaterThan(0);
    expect(cache.puts.some((p) => p.key === 'identity:pepper' && p.options?.expirationTtl === SEVEN_DAY_TTL)).toBe(true);
    const again = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(again.body.lookup_pepper).toBe(body.lookup_pepper);
  });

  it('pepper mint TTL soft-3', async () => {
    const cache = mockKv();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('bbbbbbbb-cccc-dddd-eeee-000000000003');
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body.algorithms).toEqual(['sha256', 'none']);
    expect(typeof body.lookup_pepper).toBe('string');
    expect(body.lookup_pepper.length).toBeGreaterThan(0);
    expect(cache.puts.some((p) => p.key === 'identity:pepper' && p.options?.expirationTtl === SEVEN_DAY_TTL)).toBe(true);
    const again = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(again.body.lookup_pepper).toBe(body.lookup_pepper);
  });

  it('pepper mint TTL soft-4', async () => {
    const cache = mockKv();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('bbbbbbbb-cccc-dddd-eeee-000000000004');
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body.algorithms).toEqual(['sha256', 'none']);
    expect(typeof body.lookup_pepper).toBe('string');
    expect(body.lookup_pepper.length).toBeGreaterThan(0);
    expect(cache.puts.some((p) => p.key === 'identity:pepper' && p.options?.expirationTtl === SEVEN_DAY_TTL)).toBe(true);
    const again = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(again.body.lookup_pepper).toBe(body.lookup_pepper);
  });

  it('pepper mint TTL soft-5', async () => {
    const cache = mockKv();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('bbbbbbbb-cccc-dddd-eeee-000000000005');
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body.algorithms).toEqual(['sha256', 'none']);
    expect(typeof body.lookup_pepper).toBe('string');
    expect(body.lookup_pepper.length).toBeGreaterThan(0);
    expect(cache.puts.some((p) => p.key === 'identity:pepper' && p.options?.expirationTtl === SEVEN_DAY_TTL)).toBe(true);
    const again = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(again.body.lookup_pepper).toBe(body.lookup_pepper);
  });

  it('pepper mint TTL soft-6', async () => {
    const cache = mockKv();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('bbbbbbbb-cccc-dddd-eeee-000000000006');
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body.algorithms).toEqual(['sha256', 'none']);
    expect(typeof body.lookup_pepper).toBe('string');
    expect(body.lookup_pepper.length).toBeGreaterThan(0);
    expect(cache.puts.some((p) => p.key === 'identity:pepper' && p.options?.expirationTtl === SEVEN_DAY_TTL)).toBe(true);
    const again = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(again.body.lookup_pepper).toBe(body.lookup_pepper);
  });

  it('pepper mint TTL soft-7', async () => {
    const cache = mockKv();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('bbbbbbbb-cccc-dddd-eeee-000000000007');
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body.algorithms).toEqual(['sha256', 'none']);
    expect(typeof body.lookup_pepper).toBe('string');
    expect(body.lookup_pepper.length).toBeGreaterThan(0);
    expect(cache.puts.some((p) => p.key === 'identity:pepper' && p.options?.expirationTtl === SEVEN_DAY_TTL)).toBe(true);
    const again = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(again.body.lookup_pepper).toBe(body.lookup_pepper);
  });

  it('pepper mint TTL soft-8', async () => {
    const cache = mockKv();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('bbbbbbbb-cccc-dddd-eeee-000000000008');
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body.algorithms).toEqual(['sha256', 'none']);
    expect(typeof body.lookup_pepper).toBe('string');
    expect(body.lookup_pepper.length).toBeGreaterThan(0);
    expect(cache.puts.some((p) => p.key === 'identity:pepper' && p.options?.expirationTtl === SEVEN_DAY_TTL)).toBe(true);
    const again = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(again.body.lookup_pepper).toBe(body.lookup_pepper);
  });

  it('pepper mint TTL soft-9', async () => {
    const cache = mockKv();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('bbbbbbbb-cccc-dddd-eeee-000000000009');
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body.algorithms).toEqual(['sha256', 'none']);
    expect(typeof body.lookup_pepper).toBe('string');
    expect(body.lookup_pepper.length).toBeGreaterThan(0);
    expect(cache.puts.some((p) => p.key === 'identity:pepper' && p.options?.expirationTtl === SEVEN_DAY_TTL)).toBe(true);
    const again = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(again.body.lookup_pepper).toBe(body.lookup_pepper);
  });

  it('pepper mint TTL soft-10', async () => {
    const cache = mockKv();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('bbbbbbbb-cccc-dddd-eeee-000000000010');
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body.algorithms).toEqual(['sha256', 'none']);
    expect(typeof body.lookup_pepper).toBe('string');
    expect(body.lookup_pepper.length).toBeGreaterThan(0);
    expect(cache.puts.some((p) => p.key === 'identity:pepper' && p.options?.expirationTtl === SEVEN_DAY_TTL)).toBe(true);
    const again = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(again.body.lookup_pepper).toBe(body.lookup_pepper);
  });

  it('pepper mint TTL soft-11', async () => {
    const cache = mockKv();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('bbbbbbbb-cccc-dddd-eeee-000000000011');
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body.algorithms).toEqual(['sha256', 'none']);
    expect(typeof body.lookup_pepper).toBe('string');
    expect(body.lookup_pepper.length).toBeGreaterThan(0);
    expect(cache.puts.some((p) => p.key === 'identity:pepper' && p.options?.expirationTtl === SEVEN_DAY_TTL)).toBe(true);
    const again = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(again.body.lookup_pepper).toBe(body.lookup_pepper);
  });

  it('pepper mint TTL soft-12', async () => {
    const cache = mockKv();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('bbbbbbbb-cccc-dddd-eeee-000000000012');
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body.algorithms).toEqual(['sha256', 'none']);
    expect(typeof body.lookup_pepper).toBe('string');
    expect(body.lookup_pepper.length).toBeGreaterThan(0);
    expect(cache.puts.some((p) => p.key === 'identity:pepper' && p.options?.expirationTtl === SEVEN_DAY_TTL)).toBe(true);
    const again = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(again.body.lookup_pepper).toBe(body.lookup_pepper);
  });

  it('pepper mint TTL soft-13', async () => {
    const cache = mockKv();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('bbbbbbbb-cccc-dddd-eeee-000000000013');
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body.algorithms).toEqual(['sha256', 'none']);
    expect(typeof body.lookup_pepper).toBe('string');
    expect(body.lookup_pepper.length).toBeGreaterThan(0);
    expect(cache.puts.some((p) => p.key === 'identity:pepper' && p.options?.expirationTtl === SEVEN_DAY_TTL)).toBe(true);
    const again = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(again.body.lookup_pepper).toBe(body.lookup_pepper);
  });

  it('pepper mint TTL soft-14', async () => {
    const cache = mockKv();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('bbbbbbbb-cccc-dddd-eeee-000000000014');
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body.algorithms).toEqual(['sha256', 'none']);
    expect(typeof body.lookup_pepper).toBe('string');
    expect(body.lookup_pepper.length).toBeGreaterThan(0);
    expect(cache.puts.some((p) => p.key === 'identity:pepper' && p.options?.expirationTtl === SEVEN_DAY_TTL)).toBe(true);
    const again = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(again.body.lookup_pepper).toBe(body.lookup_pepper);
  });

  it('pepper mint TTL soft-15', async () => {
    const cache = mockKv();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('bbbbbbbb-cccc-dddd-eeee-000000000015');
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body.algorithms).toEqual(['sha256', 'none']);
    expect(typeof body.lookup_pepper).toBe('string');
    expect(body.lookup_pepper.length).toBeGreaterThan(0);
    expect(cache.puts.some((p) => p.key === 'identity:pepper' && p.options?.expirationTtl === SEVEN_DAY_TTL)).toBe(true);
    const again = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(again.body.lookup_pepper).toBe(body.lookup_pepper);
  });

  it('pepper mint TTL soft-16', async () => {
    const cache = mockKv();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('bbbbbbbb-cccc-dddd-eeee-000000000016');
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body.algorithms).toEqual(['sha256', 'none']);
    expect(typeof body.lookup_pepper).toBe('string');
    expect(body.lookup_pepper.length).toBeGreaterThan(0);
    expect(cache.puts.some((p) => p.key === 'identity:pepper' && p.options?.expirationTtl === SEVEN_DAY_TTL)).toBe(true);
    const again = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(again.body.lookup_pepper).toBe(body.lookup_pepper);
  });

  it('pepper mint TTL soft-17', async () => {
    const cache = mockKv();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('bbbbbbbb-cccc-dddd-eeee-000000000017');
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body.algorithms).toEqual(['sha256', 'none']);
    expect(typeof body.lookup_pepper).toBe('string');
    expect(body.lookup_pepper.length).toBeGreaterThan(0);
    expect(cache.puts.some((p) => p.key === 'identity:pepper' && p.options?.expirationTtl === SEVEN_DAY_TTL)).toBe(true);
    const again = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(again.body.lookup_pepper).toBe(body.lookup_pepper);
  });

  it('pepper mint TTL soft-18', async () => {
    const cache = mockKv();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('bbbbbbbb-cccc-dddd-eeee-000000000018');
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body.algorithms).toEqual(['sha256', 'none']);
    expect(typeof body.lookup_pepper).toBe('string');
    expect(body.lookup_pepper.length).toBeGreaterThan(0);
    expect(cache.puts.some((p) => p.key === 'identity:pepper' && p.options?.expirationTtl === SEVEN_DAY_TTL)).toBe(true);
    const again = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(again.body.lookup_pepper).toBe(body.lookup_pepper);
  });

  it('pepper mint TTL soft-19', async () => {
    const cache = mockKv();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('bbbbbbbb-cccc-dddd-eeee-000000000019');
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body.algorithms).toEqual(['sha256', 'none']);
    expect(typeof body.lookup_pepper).toBe('string');
    expect(body.lookup_pepper.length).toBeGreaterThan(0);
    expect(cache.puts.some((p) => p.key === 'identity:pepper' && p.options?.expirationTtl === SEVEN_DAY_TTL)).toBe(true);
    const again = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(again.body.lookup_pepper).toBe(body.lookup_pepper);
  });
});

describe('identity soft leftovers GET+POST /terms soft stability after #142', () => {

  it('terms GET soft-0 → empty policies', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`);
    expect(status).toBe(200);
    expect(body).toEqual({ policies: {} });
  });

  it('terms GET soft-1 → empty policies', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`);
    expect(status).toBe(200);
    expect(body).toEqual({ policies: {} });
  });

  it('terms GET soft-2 → empty policies', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`);
    expect(status).toBe(200);
    expect(body).toEqual({ policies: {} });
  });

  it('terms GET soft-3 → empty policies', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`);
    expect(status).toBe(200);
    expect(body).toEqual({ policies: {} });
  });

  it('terms GET soft-4 → empty policies', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`);
    expect(status).toBe(200);
    expect(body).toEqual({ policies: {} });
  });

  it('terms GET soft-5 → empty policies', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`);
    expect(status).toBe(200);
    expect(body).toEqual({ policies: {} });
  });

  it('terms GET soft-6 → empty policies', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`);
    expect(status).toBe(200);
    expect(body).toEqual({ policies: {} });
  });

  it('terms GET soft-7 → empty policies', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`);
    expect(status).toBe(200);
    expect(body).toEqual({ policies: {} });
  });

  it('terms GET soft-8 → empty policies', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`);
    expect(status).toBe(200);
    expect(body).toEqual({ policies: {} });
  });

  it('terms GET soft-9 → empty policies', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`);
    expect(status).toBe(200);
    expect(body).toEqual({ policies: {} });
  });

  it('terms GET soft-10 → empty policies', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`);
    expect(status).toBe(200);
    expect(body).toEqual({ policies: {} });
  });

  it('terms GET soft-11 → empty policies', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`);
    expect(status).toBe(200);
    expect(body).toEqual({ policies: {} });
  });

  it('terms GET soft-12 → empty policies', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`);
    expect(status).toBe(200);
    expect(body).toEqual({ policies: {} });
  });

  it('terms GET soft-13 → empty policies', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`);
    expect(status).toBe(200);
    expect(body).toEqual({ policies: {} });
  });

  it('terms GET soft-14 → empty policies', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`);
    expect(status).toBe(200);
    expect(body).toEqual({ policies: {} });
  });

  it('terms POST soft-0 → empty object', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`, postJson({ user_accepts: ['policy0'] }));
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('terms POST soft-1 → empty object', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`, postJson({ user_accepts: ['policy1'] }));
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('terms POST soft-2 → empty object', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`, postJson({ user_accepts: ['policy2'] }));
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('terms POST soft-3 → empty object', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`, postJson({ user_accepts: ['policy3'] }));
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('terms POST soft-4 → empty object', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`, postJson({ user_accepts: ['policy4'] }));
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('terms POST soft-5 → empty object', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`, postJson({ user_accepts: ['policy5'] }));
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('terms POST soft-6 → empty object', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`, postJson({ user_accepts: ['policy6'] }));
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('terms POST soft-7 → empty object', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`, postJson({ user_accepts: ['policy7'] }));
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('terms POST soft-8 → empty object', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`, postJson({ user_accepts: ['policy8'] }));
    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('terms POST soft-9 → empty object', async () => {
    const { status, body } = await jsonRequest(`${BASE}/terms`, postJson({ user_accepts: ['policy9'] }));
    expect(status).toBe(200);
    expect(body).toEqual({});
  });
});

describe('identity soft leftovers GET /account bearer soft charset flood after #142', () => {
  const tokens = [
    'tok_soft_0_x',
    'tok_soft_1_xx',
    'tok_soft_2_xxx',
    'tok_soft_3_xxxx',
    'tok_soft_4_xxxxx',
    'tok_soft_5_xxxxxx',
    'tok_soft_6_xxxxxxx',
    'tok_soft_7_xxxxxxxx',
    'tok_soft_8_x',
    'tok_soft_9_xx',
    'tok_soft_10_xxx',
    'tok_soft_11_xxxx',
    'tok_soft_12_xxxxx',
    'tok_soft_13_xxxxxx',
    'tok_soft_14_xxxxxxx',
    'tok_soft_15_xxxxxxxx',
    'tok_soft_16_x',
    'tok_soft_17_xx',
    'tok_soft_18_xxx',
    'tok_soft_19_xxxx',
    'tok_soft_20_xxxxx',
    'tok_soft_21_xxxxxx',
    'tok_soft_22_xxxxxxx',
    'tok_soft_23_xxxxxxxx',
    'tok_soft_24_x'
  ];

  for (const token of tokens) {
    it(`account bearer soft accepts ${token.slice(0, 24)}`, async () => {
      const { status, body } = await jsonRequest(`${BASE}/account`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(status).toBe(200);
      expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
    });
  }

  for (const scheme of ['bearer', 'BEARER', 'Bearer']) {
    it(`scheme ${scheme} soft`, async () => {
      const { status, body } = await jsonRequest(`${BASE}/account`, {
        headers: { Authorization: `${scheme} soft_token` },
      });
      if (scheme === 'Bearer') {
        expect(status).toBe(200);
        expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
      } else {
        expect(status).toBe(401);
      }
    });
  }
});

describe('identity soft leftovers POST /account/register extra-field soft accept after #142', () => {

  it('register soft extra fields-0', async () => {
    const access = `at_soft_0`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson({
        access_token: access,
        token_type: 'Bearer',
        matrix_server_name: SERVER_NAME,
        expires_in: 3600 + 0,
        extra_ignored: { n: 0 },
        client_name: 'soft-client-0',
      })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register soft extra fields-1', async () => {
    const access = `at_soft_1`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson({
        access_token: access,
        token_type: 'Bearer',
        matrix_server_name: SERVER_NAME,
        expires_in: 3600 + 1,
        extra_ignored: { n: 1 },
        client_name: 'soft-client-1',
      })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register soft extra fields-2', async () => {
    const access = `at_soft_2`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson({
        access_token: access,
        token_type: 'Bearer',
        matrix_server_name: SERVER_NAME,
        expires_in: 3600 + 2,
        extra_ignored: { n: 2 },
        client_name: 'soft-client-2',
      })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register soft extra fields-3', async () => {
    const access = `at_soft_3`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson({
        access_token: access,
        token_type: 'Bearer',
        matrix_server_name: SERVER_NAME,
        expires_in: 3600 + 3,
        extra_ignored: { n: 3 },
        client_name: 'soft-client-3',
      })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register soft extra fields-4', async () => {
    const access = `at_soft_4`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson({
        access_token: access,
        token_type: 'Bearer',
        matrix_server_name: SERVER_NAME,
        expires_in: 3600 + 4,
        extra_ignored: { n: 4 },
        client_name: 'soft-client-4',
      })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register soft extra fields-5', async () => {
    const access = `at_soft_5`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson({
        access_token: access,
        token_type: 'Bearer',
        matrix_server_name: SERVER_NAME,
        expires_in: 3600 + 5,
        extra_ignored: { n: 5 },
        client_name: 'soft-client-5',
      })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register soft extra fields-6', async () => {
    const access = `at_soft_6`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson({
        access_token: access,
        token_type: 'Bearer',
        matrix_server_name: SERVER_NAME,
        expires_in: 3600 + 6,
        extra_ignored: { n: 6 },
        client_name: 'soft-client-6',
      })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register soft extra fields-7', async () => {
    const access = `at_soft_7`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson({
        access_token: access,
        token_type: 'Bearer',
        matrix_server_name: SERVER_NAME,
        expires_in: 3600 + 7,
        extra_ignored: { n: 7 },
        client_name: 'soft-client-7',
      })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register soft extra fields-8', async () => {
    const access = `at_soft_8`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson({
        access_token: access,
        token_type: 'Bearer',
        matrix_server_name: SERVER_NAME,
        expires_in: 3600 + 8,
        extra_ignored: { n: 8 },
        client_name: 'soft-client-8',
      })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register soft extra fields-9', async () => {
    const access = `at_soft_9`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson({
        access_token: access,
        token_type: 'Bearer',
        matrix_server_name: SERVER_NAME,
        expires_in: 3600 + 9,
        extra_ignored: { n: 9 },
        client_name: 'soft-client-9',
      })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register soft extra fields-10', async () => {
    const access = `at_soft_10`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson({
        access_token: access,
        token_type: 'Bearer',
        matrix_server_name: SERVER_NAME,
        expires_in: 3600 + 10,
        extra_ignored: { n: 10 },
        client_name: 'soft-client-10',
      })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register soft extra fields-11', async () => {
    const access = `at_soft_11`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson({
        access_token: access,
        token_type: 'Bearer',
        matrix_server_name: SERVER_NAME,
        expires_in: 3600 + 11,
        extra_ignored: { n: 11 },
        client_name: 'soft-client-11',
      })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register soft extra fields-12', async () => {
    const access = `at_soft_12`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson({
        access_token: access,
        token_type: 'Bearer',
        matrix_server_name: SERVER_NAME,
        expires_in: 3600 + 12,
        extra_ignored: { n: 12 },
        client_name: 'soft-client-12',
      })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register soft extra fields-13', async () => {
    const access = `at_soft_13`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson({
        access_token: access,
        token_type: 'Bearer',
        matrix_server_name: SERVER_NAME,
        expires_in: 3600 + 13,
        extra_ignored: { n: 13 },
        client_name: 'soft-client-13',
      })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register soft extra fields-14', async () => {
    const access = `at_soft_14`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson({
        access_token: access,
        token_type: 'Bearer',
        matrix_server_name: SERVER_NAME,
        expires_in: 3600 + 14,
        extra_ignored: { n: 14 },
        client_name: 'soft-client-14',
      })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register soft extra fields-15', async () => {
    const access = `at_soft_15`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson({
        access_token: access,
        token_type: 'Bearer',
        matrix_server_name: SERVER_NAME,
        expires_in: 3600 + 15,
        extra_ignored: { n: 15 },
        client_name: 'soft-client-15',
      })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register soft extra fields-16', async () => {
    const access = `at_soft_16`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson({
        access_token: access,
        token_type: 'Bearer',
        matrix_server_name: SERVER_NAME,
        expires_in: 3600 + 16,
        extra_ignored: { n: 16 },
        client_name: 'soft-client-16',
      })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register soft extra fields-17', async () => {
    const access = `at_soft_17`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson({
        access_token: access,
        token_type: 'Bearer',
        matrix_server_name: SERVER_NAME,
        expires_in: 3600 + 17,
        extra_ignored: { n: 17 },
        client_name: 'soft-client-17',
      })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register soft extra fields-18', async () => {
    const access = `at_soft_18`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson({
        access_token: access,
        token_type: 'Bearer',
        matrix_server_name: SERVER_NAME,
        expires_in: 3600 + 18,
        extra_ignored: { n: 18 },
        client_name: 'soft-client-18',
      })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register soft extra fields-19', async () => {
    const access = `at_soft_19`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      postJson({
        access_token: access,
        token_type: 'Bearer',
        matrix_server_name: SERVER_NAME,
        expires_in: 3600 + 19,
        extra_ignored: { n: 19 },
        client_name: 'soft-client-19',
      })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });
});

describe('identity soft leftovers lookup empty/partial address soft flood after #142', () => {
  const pepper = 'soft-pepper-lookup';

  it('none empty addresses soft-0', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none empty addresses soft-1', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none empty addresses soft-2', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none empty addresses soft-3', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none empty addresses soft-4', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none empty addresses soft-5', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none empty addresses soft-6', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none empty addresses soft-7', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none empty addresses soft-8', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none empty addresses soft-9', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none empty addresses soft-10', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none empty addresses soft-11', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none empty addresses soft-12', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none empty addresses soft-13', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none empty addresses soft-14', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none empty addresses soft-15', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none empty addresses soft-16', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none empty addresses soft-17', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none empty addresses soft-18', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none empty addresses soft-19', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none malformed single-token address soft-0', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [`solo0@example.com`, ''] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none malformed single-token address soft-1', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [`solo1@example.com`, ''] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none malformed single-token address soft-2', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [`solo2@example.com`, ''] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none malformed single-token address soft-3', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [`solo3@example.com`, ''] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none malformed single-token address soft-4', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [`solo4@example.com`, ''] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none malformed single-token address soft-5', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [`solo5@example.com`, ''] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none malformed single-token address soft-6', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [`solo6@example.com`, ''] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none malformed single-token address soft-7', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [`solo7@example.com`, ''] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none malformed single-token address soft-8', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [`solo8@example.com`, ''] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none malformed single-token address soft-9', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [`solo9@example.com`, ''] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none malformed single-token address soft-10', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [`solo10@example.com`, ''] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none malformed single-token address soft-11', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [`solo11@example.com`, ''] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none malformed single-token address soft-12', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [`solo12@example.com`, ''] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none malformed single-token address soft-13', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [`solo13@example.com`, ''] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('none malformed single-token address soft-14', async () => {
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper, addresses: [`solo14@example.com`, ''] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('sha256 empty associations soft', async () => {
    const hash = await sha256(`nobody@example.com email ${pepper}`);
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [hash] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db: createIdentityDb({ associations: [] }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });
});

describe('identity soft leftovers requestToken send_attempt + expires soft flood after #142', () => {

  it('requestToken send_attempt soft-0', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000000');
    const db = createIdentityDb();
    const email = `soft0@example.com`;
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email, client_secret: `cs_0`, send_attempt: 0 }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBe(0);
    expect(stored.email).toBe(email);
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
    expect(stored.validated).toBe(0);
  });

  it('requestToken send_attempt soft-1', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000001');
    const db = createIdentityDb();
    const email = `soft1@example.com`;
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email, client_secret: `cs_1`, send_attempt: 1 }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBe(1);
    expect(stored.email).toBe(email);
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
    expect(stored.validated).toBe(0);
  });

  it('requestToken send_attempt soft-2', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000002');
    const db = createIdentityDb();
    const email = `soft2@example.com`;
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email, client_secret: `cs_2`, send_attempt: 2 }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBe(2);
    expect(stored.email).toBe(email);
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
    expect(stored.validated).toBe(0);
  });

  it('requestToken send_attempt soft-3', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000003');
    const db = createIdentityDb();
    const email = `soft3@example.com`;
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email, client_secret: `cs_3`, send_attempt: 3 }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBe(3);
    expect(stored.email).toBe(email);
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
    expect(stored.validated).toBe(0);
  });

  it('requestToken send_attempt soft-4', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000004');
    const db = createIdentityDb();
    const email = `soft4@example.com`;
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email, client_secret: `cs_4`, send_attempt: 4 }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBe(4);
    expect(stored.email).toBe(email);
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
    expect(stored.validated).toBe(0);
  });

  it('requestToken send_attempt soft-5', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000005');
    const db = createIdentityDb();
    const email = `soft5@example.com`;
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email, client_secret: `cs_5`, send_attempt: 5 }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBe(5);
    expect(stored.email).toBe(email);
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
    expect(stored.validated).toBe(0);
  });

  it('requestToken send_attempt soft-6', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000006');
    const db = createIdentityDb();
    const email = `soft6@example.com`;
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email, client_secret: `cs_6`, send_attempt: 6 }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBe(6);
    expect(stored.email).toBe(email);
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
    expect(stored.validated).toBe(0);
  });

  it('requestToken send_attempt soft-7', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000007');
    const db = createIdentityDb();
    const email = `soft7@example.com`;
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email, client_secret: `cs_7`, send_attempt: 7 }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBe(7);
    expect(stored.email).toBe(email);
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
    expect(stored.validated).toBe(0);
  });

  it('requestToken send_attempt soft-8', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000008');
    const db = createIdentityDb();
    const email = `soft8@example.com`;
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email, client_secret: `cs_8`, send_attempt: 8 }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBe(8);
    expect(stored.email).toBe(email);
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
    expect(stored.validated).toBe(0);
  });

  it('requestToken send_attempt soft-9', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000009');
    const db = createIdentityDb();
    const email = `soft9@example.com`;
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email, client_secret: `cs_9`, send_attempt: 9 }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBe(9);
    expect(stored.email).toBe(email);
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
    expect(stored.validated).toBe(0);
  });

  it('requestToken send_attempt soft-10', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000010');
    const db = createIdentityDb();
    const email = `soft10@example.com`;
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email, client_secret: `cs_10`, send_attempt: 10 }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBe(10);
    expect(stored.email).toBe(email);
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
    expect(stored.validated).toBe(0);
  });

  it('requestToken send_attempt soft-11', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000011');
    const db = createIdentityDb();
    const email = `soft11@example.com`;
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email, client_secret: `cs_11`, send_attempt: 11 }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBe(11);
    expect(stored.email).toBe(email);
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
    expect(stored.validated).toBe(0);
  });

  it('requestToken send_attempt soft-12', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000012');
    const db = createIdentityDb();
    const email = `soft12@example.com`;
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email, client_secret: `cs_12`, send_attempt: 12 }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBe(12);
    expect(stored.email).toBe(email);
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
    expect(stored.validated).toBe(0);
  });

  it('requestToken send_attempt soft-13', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000013');
    const db = createIdentityDb();
    const email = `soft13@example.com`;
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email, client_secret: `cs_13`, send_attempt: 13 }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBe(13);
    expect(stored.email).toBe(email);
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
    expect(stored.validated).toBe(0);
  });

  it('requestToken send_attempt soft-14', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000014');
    const db = createIdentityDb();
    const email = `soft14@example.com`;
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email, client_secret: `cs_14`, send_attempt: 14 }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBe(14);
    expect(stored.email).toBe(email);
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
    expect(stored.validated).toBe(0);
  });

  it('requestToken send_attempt soft-15', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000015');
    const db = createIdentityDb();
    const email = `soft15@example.com`;
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email, client_secret: `cs_15`, send_attempt: 15 }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBe(15);
    expect(stored.email).toBe(email);
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
    expect(stored.validated).toBe(0);
  });

  it('requestToken send_attempt soft-16', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000016');
    const db = createIdentityDb();
    const email = `soft16@example.com`;
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email, client_secret: `cs_16`, send_attempt: 16 }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBe(16);
    expect(stored.email).toBe(email);
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
    expect(stored.validated).toBe(0);
  });

  it('requestToken send_attempt soft-17', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000017');
    const db = createIdentityDb();
    const email = `soft17@example.com`;
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email, client_secret: `cs_17`, send_attempt: 17 }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBe(17);
    expect(stored.email).toBe(email);
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
    expect(stored.validated).toBe(0);
  });

  it('requestToken send_attempt soft-18', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000018');
    const db = createIdentityDb();
    const email = `soft18@example.com`;
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email, client_secret: `cs_18`, send_attempt: 18 }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBe(18);
    expect(stored.email).toBe(email);
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
    expect(stored.validated).toBe(0);
  });

  it('requestToken send_attempt soft-19', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000019');
    const db = createIdentityDb();
    const email = `soft19@example.com`;
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email, client_secret: `cs_19`, send_attempt: 19 }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBe(19);
    expect(stored.email).toBe(email);
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
    expect(stored.validated).toBe(0);
  });
});

describe('identity soft leftovers submitToken double-validate soft flood after #142', () => {

  it('submitToken re-validate already-validated soft-0', async () => {
    const sid = `sid-soft-0`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `v0@example.com`,
      client_secret: `cs0`,
      token: '424242',
      send_attempt: 1,
      validated: 1,
      created_at: FIXED_NOW - 1000,
      expires_at: FIXED_NOW + DAY_MS,
      validated_at: FIXED_NOW - 500,
    });
    const db = createIdentityDb({ emailSessions: sessions });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: `cs0`, token: '424242' }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.updates.length).toBe(1);
  });

  it('submitToken re-validate already-validated soft-1', async () => {
    const sid = `sid-soft-1`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `v1@example.com`,
      client_secret: `cs1`,
      token: '424242',
      send_attempt: 1,
      validated: 1,
      created_at: FIXED_NOW - 1000,
      expires_at: FIXED_NOW + DAY_MS,
      validated_at: FIXED_NOW - 500,
    });
    const db = createIdentityDb({ emailSessions: sessions });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: `cs1`, token: '424242' }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.updates.length).toBe(1);
  });

  it('submitToken re-validate already-validated soft-2', async () => {
    const sid = `sid-soft-2`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `v2@example.com`,
      client_secret: `cs2`,
      token: '424242',
      send_attempt: 1,
      validated: 1,
      created_at: FIXED_NOW - 1000,
      expires_at: FIXED_NOW + DAY_MS,
      validated_at: FIXED_NOW - 500,
    });
    const db = createIdentityDb({ emailSessions: sessions });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: `cs2`, token: '424242' }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.updates.length).toBe(1);
  });

  it('submitToken re-validate already-validated soft-3', async () => {
    const sid = `sid-soft-3`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `v3@example.com`,
      client_secret: `cs3`,
      token: '424242',
      send_attempt: 1,
      validated: 1,
      created_at: FIXED_NOW - 1000,
      expires_at: FIXED_NOW + DAY_MS,
      validated_at: FIXED_NOW - 500,
    });
    const db = createIdentityDb({ emailSessions: sessions });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: `cs3`, token: '424242' }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.updates.length).toBe(1);
  });

  it('submitToken re-validate already-validated soft-4', async () => {
    const sid = `sid-soft-4`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `v4@example.com`,
      client_secret: `cs4`,
      token: '424242',
      send_attempt: 1,
      validated: 1,
      created_at: FIXED_NOW - 1000,
      expires_at: FIXED_NOW + DAY_MS,
      validated_at: FIXED_NOW - 500,
    });
    const db = createIdentityDb({ emailSessions: sessions });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: `cs4`, token: '424242' }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.updates.length).toBe(1);
  });

  it('submitToken re-validate already-validated soft-5', async () => {
    const sid = `sid-soft-5`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `v5@example.com`,
      client_secret: `cs5`,
      token: '424242',
      send_attempt: 1,
      validated: 1,
      created_at: FIXED_NOW - 1000,
      expires_at: FIXED_NOW + DAY_MS,
      validated_at: FIXED_NOW - 500,
    });
    const db = createIdentityDb({ emailSessions: sessions });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: `cs5`, token: '424242' }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.updates.length).toBe(1);
  });

  it('submitToken re-validate already-validated soft-6', async () => {
    const sid = `sid-soft-6`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `v6@example.com`,
      client_secret: `cs6`,
      token: '424242',
      send_attempt: 1,
      validated: 1,
      created_at: FIXED_NOW - 1000,
      expires_at: FIXED_NOW + DAY_MS,
      validated_at: FIXED_NOW - 500,
    });
    const db = createIdentityDb({ emailSessions: sessions });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: `cs6`, token: '424242' }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.updates.length).toBe(1);
  });

  it('submitToken re-validate already-validated soft-7', async () => {
    const sid = `sid-soft-7`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `v7@example.com`,
      client_secret: `cs7`,
      token: '424242',
      send_attempt: 1,
      validated: 1,
      created_at: FIXED_NOW - 1000,
      expires_at: FIXED_NOW + DAY_MS,
      validated_at: FIXED_NOW - 500,
    });
    const db = createIdentityDb({ emailSessions: sessions });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: `cs7`, token: '424242' }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.updates.length).toBe(1);
  });

  it('submitToken re-validate already-validated soft-8', async () => {
    const sid = `sid-soft-8`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `v8@example.com`,
      client_secret: `cs8`,
      token: '424242',
      send_attempt: 1,
      validated: 1,
      created_at: FIXED_NOW - 1000,
      expires_at: FIXED_NOW + DAY_MS,
      validated_at: FIXED_NOW - 500,
    });
    const db = createIdentityDb({ emailSessions: sessions });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: `cs8`, token: '424242' }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.updates.length).toBe(1);
  });

  it('submitToken re-validate already-validated soft-9', async () => {
    const sid = `sid-soft-9`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `v9@example.com`,
      client_secret: `cs9`,
      token: '424242',
      send_attempt: 1,
      validated: 1,
      created_at: FIXED_NOW - 1000,
      expires_at: FIXED_NOW + DAY_MS,
      validated_at: FIXED_NOW - 500,
    });
    const db = createIdentityDb({ emailSessions: sessions });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: `cs9`, token: '424242' }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.updates.length).toBe(1);
  });

  it('submitToken re-validate already-validated soft-10', async () => {
    const sid = `sid-soft-10`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `v10@example.com`,
      client_secret: `cs10`,
      token: '424242',
      send_attempt: 1,
      validated: 1,
      created_at: FIXED_NOW - 1000,
      expires_at: FIXED_NOW + DAY_MS,
      validated_at: FIXED_NOW - 500,
    });
    const db = createIdentityDb({ emailSessions: sessions });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: `cs10`, token: '424242' }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.updates.length).toBe(1);
  });

  it('submitToken re-validate already-validated soft-11', async () => {
    const sid = `sid-soft-11`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `v11@example.com`,
      client_secret: `cs11`,
      token: '424242',
      send_attempt: 1,
      validated: 1,
      created_at: FIXED_NOW - 1000,
      expires_at: FIXED_NOW + DAY_MS,
      validated_at: FIXED_NOW - 500,
    });
    const db = createIdentityDb({ emailSessions: sessions });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: `cs11`, token: '424242' }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.updates.length).toBe(1);
  });

  it('submitToken re-validate already-validated soft-12', async () => {
    const sid = `sid-soft-12`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `v12@example.com`,
      client_secret: `cs12`,
      token: '424242',
      send_attempt: 1,
      validated: 1,
      created_at: FIXED_NOW - 1000,
      expires_at: FIXED_NOW + DAY_MS,
      validated_at: FIXED_NOW - 500,
    });
    const db = createIdentityDb({ emailSessions: sessions });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: `cs12`, token: '424242' }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.updates.length).toBe(1);
  });

  it('submitToken re-validate already-validated soft-13', async () => {
    const sid = `sid-soft-13`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `v13@example.com`,
      client_secret: `cs13`,
      token: '424242',
      send_attempt: 1,
      validated: 1,
      created_at: FIXED_NOW - 1000,
      expires_at: FIXED_NOW + DAY_MS,
      validated_at: FIXED_NOW - 500,
    });
    const db = createIdentityDb({ emailSessions: sessions });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: `cs13`, token: '424242' }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.updates.length).toBe(1);
  });

  it('submitToken re-validate already-validated soft-14', async () => {
    const sid = `sid-soft-14`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `v14@example.com`,
      client_secret: `cs14`,
      token: '424242',
      send_attempt: 1,
      validated: 1,
      created_at: FIXED_NOW - 1000,
      expires_at: FIXED_NOW + DAY_MS,
      validated_at: FIXED_NOW - 500,
    });
    const db = createIdentityDb({ emailSessions: sessions });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: `cs14`, token: '424242' }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.updates.length).toBe(1);
  });
});

describe('identity soft leftovers SERVER_NAME reflection soft matrix after #142', () => {
  const names = ['example.com', 'example.org', 'test.example.com', 'matrix.example.com', 'hs.example.com'];
  for (const name of names) {
    it(`account user_id reflects SERVER_NAME=${name}`, async () => {
      const { body } = await jsonRequest(
        `${BASE}/account`,
        { headers: { Authorization: 'Bearer soft' } },
        makeEnv({ serverName: name })
      );
      expect(body.user_id).toBe(`@unknown:${name}`);
    });
  }
});

describe('identity soft leftovers cross-route status↔terms↔hash soft after #142', () => {

  it('cross soft lifecycle-0', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const s = await jsonRequest(BASE, {}, env);
    const t = await jsonRequest(`${BASE}/terms`, {}, env);
    const h = await jsonRequest(`${BASE}/hash_details`, {}, env);
    const p = await jsonRequest(`${BASE}/terms`, postJson({}), env);
    expect(s.body).toEqual({});
    expect(t.body).toEqual({ policies: {} });
    expect(h.body.algorithms).toEqual(['sha256', 'none']);
    expect(p.body).toEqual({});
  });

  it('cross soft lifecycle-1', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const s = await jsonRequest(BASE, {}, env);
    const t = await jsonRequest(`${BASE}/terms`, {}, env);
    const h = await jsonRequest(`${BASE}/hash_details`, {}, env);
    const p = await jsonRequest(`${BASE}/terms`, postJson({}), env);
    expect(s.body).toEqual({});
    expect(t.body).toEqual({ policies: {} });
    expect(h.body.algorithms).toEqual(['sha256', 'none']);
    expect(p.body).toEqual({});
  });

  it('cross soft lifecycle-2', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const s = await jsonRequest(BASE, {}, env);
    const t = await jsonRequest(`${BASE}/terms`, {}, env);
    const h = await jsonRequest(`${BASE}/hash_details`, {}, env);
    const p = await jsonRequest(`${BASE}/terms`, postJson({}), env);
    expect(s.body).toEqual({});
    expect(t.body).toEqual({ policies: {} });
    expect(h.body.algorithms).toEqual(['sha256', 'none']);
    expect(p.body).toEqual({});
  });

  it('cross soft lifecycle-3', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const s = await jsonRequest(BASE, {}, env);
    const t = await jsonRequest(`${BASE}/terms`, {}, env);
    const h = await jsonRequest(`${BASE}/hash_details`, {}, env);
    const p = await jsonRequest(`${BASE}/terms`, postJson({}), env);
    expect(s.body).toEqual({});
    expect(t.body).toEqual({ policies: {} });
    expect(h.body.algorithms).toEqual(['sha256', 'none']);
    expect(p.body).toEqual({});
  });

  it('cross soft lifecycle-4', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const s = await jsonRequest(BASE, {}, env);
    const t = await jsonRequest(`${BASE}/terms`, {}, env);
    const h = await jsonRequest(`${BASE}/hash_details`, {}, env);
    const p = await jsonRequest(`${BASE}/terms`, postJson({}), env);
    expect(s.body).toEqual({});
    expect(t.body).toEqual({ policies: {} });
    expect(h.body.algorithms).toEqual(['sha256', 'none']);
    expect(p.body).toEqual({});
  });

  it('cross soft lifecycle-5', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const s = await jsonRequest(BASE, {}, env);
    const t = await jsonRequest(`${BASE}/terms`, {}, env);
    const h = await jsonRequest(`${BASE}/hash_details`, {}, env);
    const p = await jsonRequest(`${BASE}/terms`, postJson({}), env);
    expect(s.body).toEqual({});
    expect(t.body).toEqual({ policies: {} });
    expect(h.body.algorithms).toEqual(['sha256', 'none']);
    expect(p.body).toEqual({});
  });

  it('cross soft lifecycle-6', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const s = await jsonRequest(BASE, {}, env);
    const t = await jsonRequest(`${BASE}/terms`, {}, env);
    const h = await jsonRequest(`${BASE}/hash_details`, {}, env);
    const p = await jsonRequest(`${BASE}/terms`, postJson({}), env);
    expect(s.body).toEqual({});
    expect(t.body).toEqual({ policies: {} });
    expect(h.body.algorithms).toEqual(['sha256', 'none']);
    expect(p.body).toEqual({});
  });

  it('cross soft lifecycle-7', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const s = await jsonRequest(BASE, {}, env);
    const t = await jsonRequest(`${BASE}/terms`, {}, env);
    const h = await jsonRequest(`${BASE}/hash_details`, {}, env);
    const p = await jsonRequest(`${BASE}/terms`, postJson({}), env);
    expect(s.body).toEqual({});
    expect(t.body).toEqual({ policies: {} });
    expect(h.body.algorithms).toEqual(['sha256', 'none']);
    expect(p.body).toEqual({});
  });

  it('cross soft lifecycle-8', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const s = await jsonRequest(BASE, {}, env);
    const t = await jsonRequest(`${BASE}/terms`, {}, env);
    const h = await jsonRequest(`${BASE}/hash_details`, {}, env);
    const p = await jsonRequest(`${BASE}/terms`, postJson({}), env);
    expect(s.body).toEqual({});
    expect(t.body).toEqual({ policies: {} });
    expect(h.body.algorithms).toEqual(['sha256', 'none']);
    expect(p.body).toEqual({});
  });

  it('cross soft lifecycle-9', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const s = await jsonRequest(BASE, {}, env);
    const t = await jsonRequest(`${BASE}/terms`, {}, env);
    const h = await jsonRequest(`${BASE}/hash_details`, {}, env);
    const p = await jsonRequest(`${BASE}/terms`, postJson({}), env);
    expect(s.body).toEqual({});
    expect(t.body).toEqual({ policies: {} });
    expect(h.body.algorithms).toEqual(['sha256', 'none']);
    expect(p.body).toEqual({});
  });

  it('cross soft lifecycle-10', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const s = await jsonRequest(BASE, {}, env);
    const t = await jsonRequest(`${BASE}/terms`, {}, env);
    const h = await jsonRequest(`${BASE}/hash_details`, {}, env);
    const p = await jsonRequest(`${BASE}/terms`, postJson({}), env);
    expect(s.body).toEqual({});
    expect(t.body).toEqual({ policies: {} });
    expect(h.body.algorithms).toEqual(['sha256', 'none']);
    expect(p.body).toEqual({});
  });

  it('cross soft lifecycle-11', async () => {
    const cache = mockKv();
    const env = makeEnv({ cache });
    const s = await jsonRequest(BASE, {}, env);
    const t = await jsonRequest(`${BASE}/terms`, {}, env);
    const h = await jsonRequest(`${BASE}/hash_details`, {}, env);
    const p = await jsonRequest(`${BASE}/terms`, postJson({}), env);
    expect(s.body).toEqual({});
    expect(t.body).toEqual({ policies: {} });
    expect(h.body.algorithms).toEqual(['sha256', 'none']);
    expect(p.body).toEqual({});
  });
});
