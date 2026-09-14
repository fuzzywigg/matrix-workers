/**
 * TOKENMAXX HEAVY leftovers after #145 — identity API contract/method/binding deepen.
 * Orthogonal to identity-api-soft-leftovers + account-register + lookup-validate leftovers.
 * Tests-only — Hono app.request() against src/api/identity.ts. No product inventing.
 * Fixtures use example.com only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { sha256 } from '../src/utils/crypto';
import identity from '../src/api/identity';

const SERVER_NAME = 'example.com';
const BASE = '/_matrix/identity/v2';
const FIXED_NOW = 1_700_100_000_000;
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

describe('identity contract leftovers POST-route method matrix after #145', () => {
  const postRoutes = [
    `${BASE}/lookup`,
    `${BASE}/account/register`,
    `${BASE}/validate/email/requestToken`,
    `${BASE}/validate/email/submitToken`,
  ];
  for (const route of postRoutes) {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      it(`${method} ${route} → 404`, async () => {
        const { status } = await jsonRequest(route, { method });
        expect(status).toBe(404);
      });
    }
  }
});


describe('identity contract leftovers terms non-GET method matrix after #145', () => {
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    it(`terms ${method} → 404`, async () => {
      const { status } = await jsonRequest(`${BASE}/terms`, { method });
      expect(status).toBe(404);
    });
  }
});

describe('identity contract leftovers Content-Type charset soft flood after #145', () => {
  const ctypes = [
    'application/json',
    'application/json; charset=utf-8',
    'application/json;charset=UTF-8',
    'application/json; charset=UTF-8; boundary=x',
  ];

  it('register CT soft-0', async () => {
    const ct = ctypes[0];
    const access = `at_ct_0`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      {
        method: 'POST',
        headers: { 'Content-Type': ct },
        body: JSON.stringify({
          access_token: access,
          token_type: 'Bearer',
          matrix_server_name: SERVER_NAME,
          expires_in: 3600,
        }),
      }
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register CT soft-1', async () => {
    const ct = ctypes[1];
    const access = `at_ct_1`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      {
        method: 'POST',
        headers: { 'Content-Type': ct },
        body: JSON.stringify({
          access_token: access,
          token_type: 'Bearer',
          matrix_server_name: SERVER_NAME,
          expires_in: 3600,
        }),
      }
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register CT soft-2', async () => {
    const ct = ctypes[2];
    const access = `at_ct_2`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      {
        method: 'POST',
        headers: { 'Content-Type': ct },
        body: JSON.stringify({
          access_token: access,
          token_type: 'Bearer',
          matrix_server_name: SERVER_NAME,
          expires_in: 3600,
        }),
      }
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register CT soft-3', async () => {
    const ct = ctypes[3];
    const access = `at_ct_3`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      {
        method: 'POST',
        headers: { 'Content-Type': ct },
        body: JSON.stringify({
          access_token: access,
          token_type: 'Bearer',
          matrix_server_name: SERVER_NAME,
          expires_in: 3600,
        }),
      }
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register CT soft-4', async () => {
    const ct = ctypes[0];
    const access = `at_ct_4`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      {
        method: 'POST',
        headers: { 'Content-Type': ct },
        body: JSON.stringify({
          access_token: access,
          token_type: 'Bearer',
          matrix_server_name: SERVER_NAME,
          expires_in: 3600,
        }),
      }
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register CT soft-5', async () => {
    const ct = ctypes[1];
    const access = `at_ct_5`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      {
        method: 'POST',
        headers: { 'Content-Type': ct },
        body: JSON.stringify({
          access_token: access,
          token_type: 'Bearer',
          matrix_server_name: SERVER_NAME,
          expires_in: 3600,
        }),
      }
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register CT soft-6', async () => {
    const ct = ctypes[2];
    const access = `at_ct_6`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      {
        method: 'POST',
        headers: { 'Content-Type': ct },
        body: JSON.stringify({
          access_token: access,
          token_type: 'Bearer',
          matrix_server_name: SERVER_NAME,
          expires_in: 3600,
        }),
      }
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register CT soft-7', async () => {
    const ct = ctypes[3];
    const access = `at_ct_7`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      {
        method: 'POST',
        headers: { 'Content-Type': ct },
        body: JSON.stringify({
          access_token: access,
          token_type: 'Bearer',
          matrix_server_name: SERVER_NAME,
          expires_in: 3600,
        }),
      }
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register CT soft-8', async () => {
    const ct = ctypes[0];
    const access = `at_ct_8`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      {
        method: 'POST',
        headers: { 'Content-Type': ct },
        body: JSON.stringify({
          access_token: access,
          token_type: 'Bearer',
          matrix_server_name: SERVER_NAME,
          expires_in: 3600,
        }),
      }
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register CT soft-9', async () => {
    const ct = ctypes[1];
    const access = `at_ct_9`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      {
        method: 'POST',
        headers: { 'Content-Type': ct },
        body: JSON.stringify({
          access_token: access,
          token_type: 'Bearer',
          matrix_server_name: SERVER_NAME,
          expires_in: 3600,
        }),
      }
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register CT soft-10', async () => {
    const ct = ctypes[2];
    const access = `at_ct_10`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      {
        method: 'POST',
        headers: { 'Content-Type': ct },
        body: JSON.stringify({
          access_token: access,
          token_type: 'Bearer',
          matrix_server_name: SERVER_NAME,
          expires_in: 3600,
        }),
      }
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register CT soft-11', async () => {
    const ct = ctypes[3];
    const access = `at_ct_11`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      {
        method: 'POST',
        headers: { 'Content-Type': ct },
        body: JSON.stringify({
          access_token: access,
          token_type: 'Bearer',
          matrix_server_name: SERVER_NAME,
          expires_in: 3600,
        }),
      }
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register CT soft-12', async () => {
    const ct = ctypes[0];
    const access = `at_ct_12`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      {
        method: 'POST',
        headers: { 'Content-Type': ct },
        body: JSON.stringify({
          access_token: access,
          token_type: 'Bearer',
          matrix_server_name: SERVER_NAME,
          expires_in: 3600,
        }),
      }
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register CT soft-13', async () => {
    const ct = ctypes[1];
    const access = `at_ct_13`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      {
        method: 'POST',
        headers: { 'Content-Type': ct },
        body: JSON.stringify({
          access_token: access,
          token_type: 'Bearer',
          matrix_server_name: SERVER_NAME,
          expires_in: 3600,
        }),
      }
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register CT soft-14', async () => {
    const ct = ctypes[2];
    const access = `at_ct_14`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      {
        method: 'POST',
        headers: { 'Content-Type': ct },
        body: JSON.stringify({
          access_token: access,
          token_type: 'Bearer',
          matrix_server_name: SERVER_NAME,
          expires_in: 3600,
        }),
      }
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });

  it('register CT soft-15', async () => {
    const ct = ctypes[3];
    const access = `at_ct_15`;
    const { status, body } = await jsonRequest(
      `${BASE}/account/register`,
      {
        method: 'POST',
        headers: { 'Content-Type': ct },
        body: JSON.stringify({
          access_token: access,
          token_type: 'Bearer',
          matrix_server_name: SERVER_NAME,
          expires_in: 3600,
        }),
      }
    );
    expect(status).toBe(200);
    expect(body).toEqual({ token: access });
  });
});

describe('identity contract leftovers hash_details algorithms shape flood after #145', () => {

  it('hash_details algorithms contract-0', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-contract-0' });
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body).toEqual({
      lookup_pepper: 'pepper-contract-0',
      algorithms: ['sha256', 'none'],
    });
    expect(Object.keys(body).sort()).toEqual(['algorithms', 'lookup_pepper']);
  });

  it('hash_details algorithms contract-1', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-contract-1' });
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body).toEqual({
      lookup_pepper: 'pepper-contract-1',
      algorithms: ['sha256', 'none'],
    });
    expect(Object.keys(body).sort()).toEqual(['algorithms', 'lookup_pepper']);
  });

  it('hash_details algorithms contract-2', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-contract-2' });
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body).toEqual({
      lookup_pepper: 'pepper-contract-2',
      algorithms: ['sha256', 'none'],
    });
    expect(Object.keys(body).sort()).toEqual(['algorithms', 'lookup_pepper']);
  });

  it('hash_details algorithms contract-3', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-contract-3' });
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body).toEqual({
      lookup_pepper: 'pepper-contract-3',
      algorithms: ['sha256', 'none'],
    });
    expect(Object.keys(body).sort()).toEqual(['algorithms', 'lookup_pepper']);
  });

  it('hash_details algorithms contract-4', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-contract-4' });
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body).toEqual({
      lookup_pepper: 'pepper-contract-4',
      algorithms: ['sha256', 'none'],
    });
    expect(Object.keys(body).sort()).toEqual(['algorithms', 'lookup_pepper']);
  });

  it('hash_details algorithms contract-5', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-contract-5' });
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body).toEqual({
      lookup_pepper: 'pepper-contract-5',
      algorithms: ['sha256', 'none'],
    });
    expect(Object.keys(body).sort()).toEqual(['algorithms', 'lookup_pepper']);
  });

  it('hash_details algorithms contract-6', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-contract-6' });
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body).toEqual({
      lookup_pepper: 'pepper-contract-6',
      algorithms: ['sha256', 'none'],
    });
    expect(Object.keys(body).sort()).toEqual(['algorithms', 'lookup_pepper']);
  });

  it('hash_details algorithms contract-7', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-contract-7' });
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body).toEqual({
      lookup_pepper: 'pepper-contract-7',
      algorithms: ['sha256', 'none'],
    });
    expect(Object.keys(body).sort()).toEqual(['algorithms', 'lookup_pepper']);
  });

  it('hash_details algorithms contract-8', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-contract-8' });
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body).toEqual({
      lookup_pepper: 'pepper-contract-8',
      algorithms: ['sha256', 'none'],
    });
    expect(Object.keys(body).sort()).toEqual(['algorithms', 'lookup_pepper']);
  });

  it('hash_details algorithms contract-9', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-contract-9' });
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body).toEqual({
      lookup_pepper: 'pepper-contract-9',
      algorithms: ['sha256', 'none'],
    });
    expect(Object.keys(body).sort()).toEqual(['algorithms', 'lookup_pepper']);
  });

  it('hash_details algorithms contract-10', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-contract-10' });
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body).toEqual({
      lookup_pepper: 'pepper-contract-10',
      algorithms: ['sha256', 'none'],
    });
    expect(Object.keys(body).sort()).toEqual(['algorithms', 'lookup_pepper']);
  });

  it('hash_details algorithms contract-11', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-contract-11' });
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body).toEqual({
      lookup_pepper: 'pepper-contract-11',
      algorithms: ['sha256', 'none'],
    });
    expect(Object.keys(body).sort()).toEqual(['algorithms', 'lookup_pepper']);
  });

  it('hash_details algorithms contract-12', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-contract-12' });
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body).toEqual({
      lookup_pepper: 'pepper-contract-12',
      algorithms: ['sha256', 'none'],
    });
    expect(Object.keys(body).sort()).toEqual(['algorithms', 'lookup_pepper']);
  });

  it('hash_details algorithms contract-13', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-contract-13' });
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body).toEqual({
      lookup_pepper: 'pepper-contract-13',
      algorithms: ['sha256', 'none'],
    });
    expect(Object.keys(body).sort()).toEqual(['algorithms', 'lookup_pepper']);
  });

  it('hash_details algorithms contract-14', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-contract-14' });
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body).toEqual({
      lookup_pepper: 'pepper-contract-14',
      algorithms: ['sha256', 'none'],
    });
    expect(Object.keys(body).sort()).toEqual(['algorithms', 'lookup_pepper']);
  });

  it('hash_details algorithms contract-15', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-contract-15' });
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body).toEqual({
      lookup_pepper: 'pepper-contract-15',
      algorithms: ['sha256', 'none'],
    });
    expect(Object.keys(body).sort()).toEqual(['algorithms', 'lookup_pepper']);
  });

  it('hash_details algorithms contract-16', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-contract-16' });
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body).toEqual({
      lookup_pepper: 'pepper-contract-16',
      algorithms: ['sha256', 'none'],
    });
    expect(Object.keys(body).sort()).toEqual(['algorithms', 'lookup_pepper']);
  });

  it('hash_details algorithms contract-17', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-contract-17' });
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body).toEqual({
      lookup_pepper: 'pepper-contract-17',
      algorithms: ['sha256', 'none'],
    });
    expect(Object.keys(body).sort()).toEqual(['algorithms', 'lookup_pepper']);
  });

  it('hash_details algorithms contract-18', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-contract-18' });
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body).toEqual({
      lookup_pepper: 'pepper-contract-18',
      algorithms: ['sha256', 'none'],
    });
    expect(Object.keys(body).sort()).toEqual(['algorithms', 'lookup_pepper']);
  });

  it('hash_details algorithms contract-19', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-contract-19' });
    const { status, body } = await jsonRequest(`${BASE}/hash_details`, {}, makeEnv({ cache }));
    expect(status).toBe(200);
    expect(body).toEqual({
      lookup_pepper: 'pepper-contract-19',
      algorithms: ['sha256', 'none'],
    });
    expect(Object.keys(body).sort()).toEqual(['algorithms', 'lookup_pepper']);
  });
});

describe('identity contract leftovers lookup pepper mismatch errcode flood after #145', () => {

  it('pepper mismatch contract-0', async () => {
    const current = 'current-pepper-0';
    const cache = mockKv({ 'identity:pepper': current });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'wrong-0', addresses: ['a@example.com email'] }),
      makeEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe(current);
    expect(body.algorithm).toBe('sha256');
  });

  it('pepper mismatch contract-1', async () => {
    const current = 'current-pepper-1';
    const cache = mockKv({ 'identity:pepper': current });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'wrong-1', addresses: ['a@example.com email'] }),
      makeEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe(current);
    expect(body.algorithm).toBe('sha256');
  });

  it('pepper mismatch contract-2', async () => {
    const current = 'current-pepper-2';
    const cache = mockKv({ 'identity:pepper': current });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'wrong-2', addresses: ['a@example.com email'] }),
      makeEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe(current);
    expect(body.algorithm).toBe('sha256');
  });

  it('pepper mismatch contract-3', async () => {
    const current = 'current-pepper-3';
    const cache = mockKv({ 'identity:pepper': current });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'wrong-3', addresses: ['a@example.com email'] }),
      makeEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe(current);
    expect(body.algorithm).toBe('sha256');
  });

  it('pepper mismatch contract-4', async () => {
    const current = 'current-pepper-4';
    const cache = mockKv({ 'identity:pepper': current });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'wrong-4', addresses: ['a@example.com email'] }),
      makeEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe(current);
    expect(body.algorithm).toBe('sha256');
  });

  it('pepper mismatch contract-5', async () => {
    const current = 'current-pepper-5';
    const cache = mockKv({ 'identity:pepper': current });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'wrong-5', addresses: ['a@example.com email'] }),
      makeEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe(current);
    expect(body.algorithm).toBe('sha256');
  });

  it('pepper mismatch contract-6', async () => {
    const current = 'current-pepper-6';
    const cache = mockKv({ 'identity:pepper': current });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'wrong-6', addresses: ['a@example.com email'] }),
      makeEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe(current);
    expect(body.algorithm).toBe('sha256');
  });

  it('pepper mismatch contract-7', async () => {
    const current = 'current-pepper-7';
    const cache = mockKv({ 'identity:pepper': current });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'wrong-7', addresses: ['a@example.com email'] }),
      makeEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe(current);
    expect(body.algorithm).toBe('sha256');
  });

  it('pepper mismatch contract-8', async () => {
    const current = 'current-pepper-8';
    const cache = mockKv({ 'identity:pepper': current });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'wrong-8', addresses: ['a@example.com email'] }),
      makeEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe(current);
    expect(body.algorithm).toBe('sha256');
  });

  it('pepper mismatch contract-9', async () => {
    const current = 'current-pepper-9';
    const cache = mockKv({ 'identity:pepper': current });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'wrong-9', addresses: ['a@example.com email'] }),
      makeEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe(current);
    expect(body.algorithm).toBe('sha256');
  });

  it('pepper mismatch contract-10', async () => {
    const current = 'current-pepper-10';
    const cache = mockKv({ 'identity:pepper': current });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'wrong-10', addresses: ['a@example.com email'] }),
      makeEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe(current);
    expect(body.algorithm).toBe('sha256');
  });

  it('pepper mismatch contract-11', async () => {
    const current = 'current-pepper-11';
    const cache = mockKv({ 'identity:pepper': current });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'wrong-11', addresses: ['a@example.com email'] }),
      makeEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe(current);
    expect(body.algorithm).toBe('sha256');
  });

  it('pepper mismatch contract-12', async () => {
    const current = 'current-pepper-12';
    const cache = mockKv({ 'identity:pepper': current });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'wrong-12', addresses: ['a@example.com email'] }),
      makeEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe(current);
    expect(body.algorithm).toBe('sha256');
  });

  it('pepper mismatch contract-13', async () => {
    const current = 'current-pepper-13';
    const cache = mockKv({ 'identity:pepper': current });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'wrong-13', addresses: ['a@example.com email'] }),
      makeEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe(current);
    expect(body.algorithm).toBe('sha256');
  });

  it('pepper mismatch contract-14', async () => {
    const current = 'current-pepper-14';
    const cache = mockKv({ 'identity:pepper': current });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'wrong-14', addresses: ['a@example.com email'] }),
      makeEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe(current);
    expect(body.algorithm).toBe('sha256');
  });

  it('pepper mismatch contract-15', async () => {
    const current = 'current-pepper-15';
    const cache = mockKv({ 'identity:pepper': current });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'wrong-15', addresses: ['a@example.com email'] }),
      makeEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe(current);
    expect(body.algorithm).toBe('sha256');
  });

  it('pepper mismatch contract-16', async () => {
    const current = 'current-pepper-16';
    const cache = mockKv({ 'identity:pepper': current });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'wrong-16', addresses: ['a@example.com email'] }),
      makeEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe(current);
    expect(body.algorithm).toBe('sha256');
  });

  it('pepper mismatch contract-17', async () => {
    const current = 'current-pepper-17';
    const cache = mockKv({ 'identity:pepper': current });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'wrong-17', addresses: ['a@example.com email'] }),
      makeEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe(current);
    expect(body.algorithm).toBe('sha256');
  });

  it('pepper mismatch contract-18', async () => {
    const current = 'current-pepper-18';
    const cache = mockKv({ 'identity:pepper': current });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'wrong-18', addresses: ['a@example.com email'] }),
      makeEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe(current);
    expect(body.algorithm).toBe('sha256');
  });

  it('pepper mismatch contract-19', async () => {
    const current = 'current-pepper-19';
    const cache = mockKv({ 'identity:pepper': current });
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'wrong-19', addresses: ['a@example.com email'] }),
      makeEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe(current);
    expect(body.algorithm).toBe('sha256');
  });
});

describe('identity contract leftovers Bearer edge charset soft flood after #145', () => {
  const headers = [
    { auth: 'Bearer ', expectStatus: 401, label: 'empty-after-bearer-0' },
    { auth: 'Bearer ', expectStatus: 401, label: 'empty-after-bearer-1' },
    { auth: 'Bearer ', expectStatus: 401, label: 'empty-after-bearer-2' },
    { auth: 'Bearer ', expectStatus: 401, label: 'empty-after-bearer-3' },
    { auth: 'Bearer ', expectStatus: 401, label: 'empty-after-bearer-4' },
    { auth: 'Bearer ', expectStatus: 401, label: 'empty-after-bearer-5' },
    { auth: 'Bearer ', expectStatus: 401, label: 'empty-after-bearer-6' },
    { auth: 'Bearer ', expectStatus: 401, label: 'empty-after-bearer-7' },
    { auth: 'Bearer ', expectStatus: 401, label: 'empty-after-bearer-8' },
    { auth: 'Bearer ', expectStatus: 401, label: 'empty-after-bearer-9' },
    { auth: 'Bearer ', expectStatus: 401, label: 'empty-after-bearer-10' },
    { auth: 'Bearer ', expectStatus: 401, label: 'empty-after-bearer-11' },
    { auth: 'Bearer tok', expectStatus: 200, label: 'ok-tok' },
    { auth: 'Bearer tok with spaces', expectStatus: 200, label: 'ok-tok with spa' },
    { auth: 'Bearer tok\\ttab', expectStatus: 200, label: 'ok-tok\ttab' },
    { auth: 'Bearer tok\\nline', expectStatus: 200, label: 'ok-tok\nline' },
    { auth: 'Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', expectStatus: 200, label: 'ok-aaaaaaaaaaaa' },
    { auth: 'Bearer xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', expectStatus: 200, label: 'ok-xxxxxxxxxxxx' },
    { auth: 'Bearer', expectStatus: 401, label: 'bad-Bearer' },
    { auth: 'bearer x', expectStatus: 401, label: 'bad-bearer x' },
    { auth: 'Basic x', expectStatus: 401, label: 'bad-Basic x' },
    { auth: 'Token x', expectStatus: 401, label: 'bad-Token x' },
    { auth: '', expectStatus: 401, label: 'bad-empty' }
  ];

  for (const c of headers) {
    it(`account Authorization ${c.label}`, async () => {
      const init: RequestInit = c.auth === '' ? {} : { headers: { Authorization: c.auth } };
      const { status, body } = await jsonRequest(`${BASE}/account`, init);
      expect(status).toBe(c.expectStatus);
      if (c.expectStatus === 200) {
        expect(body.user_id).toBe(`@unknown:${SERVER_NAME}`);
      } else {
        expect(body.errcode).toBe('M_MISSING_TOKEN');
      }
    });
  }
});

describe('identity contract leftovers sha256 multi-hit lookup soft flood after #145', () => {

  it('sha256 multi-hit soft-0', async () => {
    const pepper = 'multi-pepper-0';
    const a1 = `a0@example.com`;
    const a2 = `b0@example.com`;
    const mx1 = `@a0:${SERVER_NAME}`;
    const mx2 = `@b0:${SERVER_NAME}`;
    const associations: IdentityAssociation[] = [
      { medium: 'email', address: a1, mxid: mx1 },
      { medium: 'email', address: a2, mxid: mx2 },
      { medium: 'email', address: `c0@example.com`, mxid: `@c0:${SERVER_NAME}` },
    ];
    const h1 = await sha256(`${a1} email ${pepper}`);
    const h2 = await sha256(`${a2} email ${pepper}`);
    const miss = await sha256(`ghost0@example.com email ${pepper}`);
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [h1, miss, h2] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db: createIdentityDb({ associations }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({ [h1]: mx1, [h2]: mx2 });
  });

  it('sha256 multi-hit soft-1', async () => {
    const pepper = 'multi-pepper-1';
    const a1 = `a1@example.com`;
    const a2 = `b1@example.com`;
    const mx1 = `@a1:${SERVER_NAME}`;
    const mx2 = `@b1:${SERVER_NAME}`;
    const associations: IdentityAssociation[] = [
      { medium: 'email', address: a1, mxid: mx1 },
      { medium: 'email', address: a2, mxid: mx2 },
      { medium: 'email', address: `c1@example.com`, mxid: `@c1:${SERVER_NAME}` },
    ];
    const h1 = await sha256(`${a1} email ${pepper}`);
    const h2 = await sha256(`${a2} email ${pepper}`);
    const miss = await sha256(`ghost1@example.com email ${pepper}`);
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [h1, miss, h2] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db: createIdentityDb({ associations }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({ [h1]: mx1, [h2]: mx2 });
  });

  it('sha256 multi-hit soft-2', async () => {
    const pepper = 'multi-pepper-2';
    const a1 = `a2@example.com`;
    const a2 = `b2@example.com`;
    const mx1 = `@a2:${SERVER_NAME}`;
    const mx2 = `@b2:${SERVER_NAME}`;
    const associations: IdentityAssociation[] = [
      { medium: 'email', address: a1, mxid: mx1 },
      { medium: 'email', address: a2, mxid: mx2 },
      { medium: 'email', address: `c2@example.com`, mxid: `@c2:${SERVER_NAME}` },
    ];
    const h1 = await sha256(`${a1} email ${pepper}`);
    const h2 = await sha256(`${a2} email ${pepper}`);
    const miss = await sha256(`ghost2@example.com email ${pepper}`);
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [h1, miss, h2] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db: createIdentityDb({ associations }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({ [h1]: mx1, [h2]: mx2 });
  });

  it('sha256 multi-hit soft-3', async () => {
    const pepper = 'multi-pepper-3';
    const a1 = `a3@example.com`;
    const a2 = `b3@example.com`;
    const mx1 = `@a3:${SERVER_NAME}`;
    const mx2 = `@b3:${SERVER_NAME}`;
    const associations: IdentityAssociation[] = [
      { medium: 'email', address: a1, mxid: mx1 },
      { medium: 'email', address: a2, mxid: mx2 },
      { medium: 'email', address: `c3@example.com`, mxid: `@c3:${SERVER_NAME}` },
    ];
    const h1 = await sha256(`${a1} email ${pepper}`);
    const h2 = await sha256(`${a2} email ${pepper}`);
    const miss = await sha256(`ghost3@example.com email ${pepper}`);
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [h1, miss, h2] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db: createIdentityDb({ associations }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({ [h1]: mx1, [h2]: mx2 });
  });

  it('sha256 multi-hit soft-4', async () => {
    const pepper = 'multi-pepper-4';
    const a1 = `a4@example.com`;
    const a2 = `b4@example.com`;
    const mx1 = `@a4:${SERVER_NAME}`;
    const mx2 = `@b4:${SERVER_NAME}`;
    const associations: IdentityAssociation[] = [
      { medium: 'email', address: a1, mxid: mx1 },
      { medium: 'email', address: a2, mxid: mx2 },
      { medium: 'email', address: `c4@example.com`, mxid: `@c4:${SERVER_NAME}` },
    ];
    const h1 = await sha256(`${a1} email ${pepper}`);
    const h2 = await sha256(`${a2} email ${pepper}`);
    const miss = await sha256(`ghost4@example.com email ${pepper}`);
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [h1, miss, h2] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db: createIdentityDb({ associations }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({ [h1]: mx1, [h2]: mx2 });
  });

  it('sha256 multi-hit soft-5', async () => {
    const pepper = 'multi-pepper-5';
    const a1 = `a5@example.com`;
    const a2 = `b5@example.com`;
    const mx1 = `@a5:${SERVER_NAME}`;
    const mx2 = `@b5:${SERVER_NAME}`;
    const associations: IdentityAssociation[] = [
      { medium: 'email', address: a1, mxid: mx1 },
      { medium: 'email', address: a2, mxid: mx2 },
      { medium: 'email', address: `c5@example.com`, mxid: `@c5:${SERVER_NAME}` },
    ];
    const h1 = await sha256(`${a1} email ${pepper}`);
    const h2 = await sha256(`${a2} email ${pepper}`);
    const miss = await sha256(`ghost5@example.com email ${pepper}`);
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [h1, miss, h2] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db: createIdentityDb({ associations }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({ [h1]: mx1, [h2]: mx2 });
  });

  it('sha256 multi-hit soft-6', async () => {
    const pepper = 'multi-pepper-6';
    const a1 = `a6@example.com`;
    const a2 = `b6@example.com`;
    const mx1 = `@a6:${SERVER_NAME}`;
    const mx2 = `@b6:${SERVER_NAME}`;
    const associations: IdentityAssociation[] = [
      { medium: 'email', address: a1, mxid: mx1 },
      { medium: 'email', address: a2, mxid: mx2 },
      { medium: 'email', address: `c6@example.com`, mxid: `@c6:${SERVER_NAME}` },
    ];
    const h1 = await sha256(`${a1} email ${pepper}`);
    const h2 = await sha256(`${a2} email ${pepper}`);
    const miss = await sha256(`ghost6@example.com email ${pepper}`);
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [h1, miss, h2] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db: createIdentityDb({ associations }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({ [h1]: mx1, [h2]: mx2 });
  });

  it('sha256 multi-hit soft-7', async () => {
    const pepper = 'multi-pepper-7';
    const a1 = `a7@example.com`;
    const a2 = `b7@example.com`;
    const mx1 = `@a7:${SERVER_NAME}`;
    const mx2 = `@b7:${SERVER_NAME}`;
    const associations: IdentityAssociation[] = [
      { medium: 'email', address: a1, mxid: mx1 },
      { medium: 'email', address: a2, mxid: mx2 },
      { medium: 'email', address: `c7@example.com`, mxid: `@c7:${SERVER_NAME}` },
    ];
    const h1 = await sha256(`${a1} email ${pepper}`);
    const h2 = await sha256(`${a2} email ${pepper}`);
    const miss = await sha256(`ghost7@example.com email ${pepper}`);
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [h1, miss, h2] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db: createIdentityDb({ associations }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({ [h1]: mx1, [h2]: mx2 });
  });

  it('sha256 multi-hit soft-8', async () => {
    const pepper = 'multi-pepper-8';
    const a1 = `a8@example.com`;
    const a2 = `b8@example.com`;
    const mx1 = `@a8:${SERVER_NAME}`;
    const mx2 = `@b8:${SERVER_NAME}`;
    const associations: IdentityAssociation[] = [
      { medium: 'email', address: a1, mxid: mx1 },
      { medium: 'email', address: a2, mxid: mx2 },
      { medium: 'email', address: `c8@example.com`, mxid: `@c8:${SERVER_NAME}` },
    ];
    const h1 = await sha256(`${a1} email ${pepper}`);
    const h2 = await sha256(`${a2} email ${pepper}`);
    const miss = await sha256(`ghost8@example.com email ${pepper}`);
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [h1, miss, h2] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db: createIdentityDb({ associations }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({ [h1]: mx1, [h2]: mx2 });
  });

  it('sha256 multi-hit soft-9', async () => {
    const pepper = 'multi-pepper-9';
    const a1 = `a9@example.com`;
    const a2 = `b9@example.com`;
    const mx1 = `@a9:${SERVER_NAME}`;
    const mx2 = `@b9:${SERVER_NAME}`;
    const associations: IdentityAssociation[] = [
      { medium: 'email', address: a1, mxid: mx1 },
      { medium: 'email', address: a2, mxid: mx2 },
      { medium: 'email', address: `c9@example.com`, mxid: `@c9:${SERVER_NAME}` },
    ];
    const h1 = await sha256(`${a1} email ${pepper}`);
    const h2 = await sha256(`${a2} email ${pepper}`);
    const miss = await sha256(`ghost9@example.com email ${pepper}`);
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [h1, miss, h2] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db: createIdentityDb({ associations }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({ [h1]: mx1, [h2]: mx2 });
  });

  it('sha256 multi-hit soft-10', async () => {
    const pepper = 'multi-pepper-10';
    const a1 = `a10@example.com`;
    const a2 = `b10@example.com`;
    const mx1 = `@a10:${SERVER_NAME}`;
    const mx2 = `@b10:${SERVER_NAME}`;
    const associations: IdentityAssociation[] = [
      { medium: 'email', address: a1, mxid: mx1 },
      { medium: 'email', address: a2, mxid: mx2 },
      { medium: 'email', address: `c10@example.com`, mxid: `@c10:${SERVER_NAME}` },
    ];
    const h1 = await sha256(`${a1} email ${pepper}`);
    const h2 = await sha256(`${a2} email ${pepper}`);
    const miss = await sha256(`ghost10@example.com email ${pepper}`);
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [h1, miss, h2] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db: createIdentityDb({ associations }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({ [h1]: mx1, [h2]: mx2 });
  });

  it('sha256 multi-hit soft-11', async () => {
    const pepper = 'multi-pepper-11';
    const a1 = `a11@example.com`;
    const a2 = `b11@example.com`;
    const mx1 = `@a11:${SERVER_NAME}`;
    const mx2 = `@b11:${SERVER_NAME}`;
    const associations: IdentityAssociation[] = [
      { medium: 'email', address: a1, mxid: mx1 },
      { medium: 'email', address: a2, mxid: mx2 },
      { medium: 'email', address: `c11@example.com`, mxid: `@c11:${SERVER_NAME}` },
    ];
    const h1 = await sha256(`${a1} email ${pepper}`);
    const h2 = await sha256(`${a2} email ${pepper}`);
    const miss = await sha256(`ghost11@example.com email ${pepper}`);
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [h1, miss, h2] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db: createIdentityDb({ associations }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({ [h1]: mx1, [h2]: mx2 });
  });

  it('sha256 multi-hit soft-12', async () => {
    const pepper = 'multi-pepper-12';
    const a1 = `a12@example.com`;
    const a2 = `b12@example.com`;
    const mx1 = `@a12:${SERVER_NAME}`;
    const mx2 = `@b12:${SERVER_NAME}`;
    const associations: IdentityAssociation[] = [
      { medium: 'email', address: a1, mxid: mx1 },
      { medium: 'email', address: a2, mxid: mx2 },
      { medium: 'email', address: `c12@example.com`, mxid: `@c12:${SERVER_NAME}` },
    ];
    const h1 = await sha256(`${a1} email ${pepper}`);
    const h2 = await sha256(`${a2} email ${pepper}`);
    const miss = await sha256(`ghost12@example.com email ${pepper}`);
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [h1, miss, h2] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db: createIdentityDb({ associations }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({ [h1]: mx1, [h2]: mx2 });
  });

  it('sha256 multi-hit soft-13', async () => {
    const pepper = 'multi-pepper-13';
    const a1 = `a13@example.com`;
    const a2 = `b13@example.com`;
    const mx1 = `@a13:${SERVER_NAME}`;
    const mx2 = `@b13:${SERVER_NAME}`;
    const associations: IdentityAssociation[] = [
      { medium: 'email', address: a1, mxid: mx1 },
      { medium: 'email', address: a2, mxid: mx2 },
      { medium: 'email', address: `c13@example.com`, mxid: `@c13:${SERVER_NAME}` },
    ];
    const h1 = await sha256(`${a1} email ${pepper}`);
    const h2 = await sha256(`${a2} email ${pepper}`);
    const miss = await sha256(`ghost13@example.com email ${pepper}`);
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [h1, miss, h2] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db: createIdentityDb({ associations }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({ [h1]: mx1, [h2]: mx2 });
  });

  it('sha256 multi-hit soft-14', async () => {
    const pepper = 'multi-pepper-14';
    const a1 = `a14@example.com`;
    const a2 = `b14@example.com`;
    const mx1 = `@a14:${SERVER_NAME}`;
    const mx2 = `@b14:${SERVER_NAME}`;
    const associations: IdentityAssociation[] = [
      { medium: 'email', address: a1, mxid: mx1 },
      { medium: 'email', address: a2, mxid: mx2 },
      { medium: 'email', address: `c14@example.com`, mxid: `@c14:${SERVER_NAME}` },
    ];
    const h1 = await sha256(`${a1} email ${pepper}`);
    const h2 = await sha256(`${a2} email ${pepper}`);
    const miss = await sha256(`ghost14@example.com email ${pepper}`);
    const { status, body } = await jsonRequest(
      `${BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [h1, miss, h2] }),
      makeEnv({ cache: mockKv({ 'identity:pepper': pepper }), db: createIdentityDb({ associations }) })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({ [h1]: mx1, [h2]: mx2 });
  });
});

describe('identity contract leftovers requestToken send_attempt undefined soft flood after #145', () => {

  it('requestToken omit send_attempt soft-0', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000000');
    const db = createIdentityDb();
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: `omit0@example.com`, client_secret: `cs_0` }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBeUndefined();
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
  });

  it('requestToken omit send_attempt soft-1', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000001');
    const db = createIdentityDb();
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: `omit1@example.com`, client_secret: `cs_1` }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBeUndefined();
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
  });

  it('requestToken omit send_attempt soft-2', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000002');
    const db = createIdentityDb();
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: `omit2@example.com`, client_secret: `cs_2` }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBeUndefined();
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
  });

  it('requestToken omit send_attempt soft-3', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000003');
    const db = createIdentityDb();
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: `omit3@example.com`, client_secret: `cs_3` }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBeUndefined();
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
  });

  it('requestToken omit send_attempt soft-4', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000004');
    const db = createIdentityDb();
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: `omit4@example.com`, client_secret: `cs_4` }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBeUndefined();
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
  });

  it('requestToken omit send_attempt soft-5', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000005');
    const db = createIdentityDb();
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: `omit5@example.com`, client_secret: `cs_5` }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBeUndefined();
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
  });

  it('requestToken omit send_attempt soft-6', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000006');
    const db = createIdentityDb();
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: `omit6@example.com`, client_secret: `cs_6` }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBeUndefined();
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
  });

  it('requestToken omit send_attempt soft-7', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000007');
    const db = createIdentityDb();
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: `omit7@example.com`, client_secret: `cs_7` }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBeUndefined();
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
  });

  it('requestToken omit send_attempt soft-8', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000008');
    const db = createIdentityDb();
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: `omit8@example.com`, client_secret: `cs_8` }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBeUndefined();
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
  });

  it('requestToken omit send_attempt soft-9', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000009');
    const db = createIdentityDb();
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: `omit9@example.com`, client_secret: `cs_9` }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBeUndefined();
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
  });

  it('requestToken omit send_attempt soft-10', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000010');
    const db = createIdentityDb();
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: `omit10@example.com`, client_secret: `cs_10` }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBeUndefined();
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
  });

  it('requestToken omit send_attempt soft-11', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000011');
    const db = createIdentityDb();
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: `omit11@example.com`, client_secret: `cs_11` }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBeUndefined();
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
  });

  it('requestToken omit send_attempt soft-12', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000012');
    const db = createIdentityDb();
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: `omit12@example.com`, client_secret: `cs_12` }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBeUndefined();
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
  });

  it('requestToken omit send_attempt soft-13', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000013');
    const db = createIdentityDb();
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: `omit13@example.com`, client_secret: `cs_13` }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBeUndefined();
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
  });

  it('requestToken omit send_attempt soft-14', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('cccccccc-dddd-eeee-ffff-000000000014');
    const db = createIdentityDb();
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/requestToken`,
      postJson({ email: `omit14@example.com`, client_secret: `cs_14` }),
      makeEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBeTruthy();
    const stored = [...db.emailSessions.values()][0];
    expect(stored.send_attempt).toBeUndefined();
    expect(stored.expires_at - stored.created_at).toBe(DAY_MS);
  });
});

describe('identity contract leftovers submitToken wrong-secret vs wrong-token after #145', () => {

  it('wrong secret → M_NO_VALID_SESSION soft-0', async () => {
    const sid = `sid-ws-0`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `ws0@example.com`,
      client_secret: 'right',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + DAY_MS,
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'wrong', token: '111111' }),
      makeEnv({ db: createIdentityDb({ emailSessions: sessions }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_NO_VALID_SESSION');
  });

  it('wrong token → M_INVALID_PARAM soft-0', async () => {
    const sid = `sid-wt-0`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `wt0@example.com`,
      client_secret: 'right',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + DAY_MS,
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'right', token: '000000' }),
      makeEnv({ db: createIdentityDb({ emailSessions: sessions }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('wrong secret → M_NO_VALID_SESSION soft-1', async () => {
    const sid = `sid-ws-1`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `ws1@example.com`,
      client_secret: 'right',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + DAY_MS,
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'wrong', token: '111111' }),
      makeEnv({ db: createIdentityDb({ emailSessions: sessions }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_NO_VALID_SESSION');
  });

  it('wrong token → M_INVALID_PARAM soft-1', async () => {
    const sid = `sid-wt-1`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `wt1@example.com`,
      client_secret: 'right',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + DAY_MS,
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'right', token: '000000' }),
      makeEnv({ db: createIdentityDb({ emailSessions: sessions }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('wrong secret → M_NO_VALID_SESSION soft-2', async () => {
    const sid = `sid-ws-2`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `ws2@example.com`,
      client_secret: 'right',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + DAY_MS,
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'wrong', token: '111111' }),
      makeEnv({ db: createIdentityDb({ emailSessions: sessions }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_NO_VALID_SESSION');
  });

  it('wrong token → M_INVALID_PARAM soft-2', async () => {
    const sid = `sid-wt-2`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `wt2@example.com`,
      client_secret: 'right',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + DAY_MS,
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'right', token: '000000' }),
      makeEnv({ db: createIdentityDb({ emailSessions: sessions }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('wrong secret → M_NO_VALID_SESSION soft-3', async () => {
    const sid = `sid-ws-3`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `ws3@example.com`,
      client_secret: 'right',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + DAY_MS,
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'wrong', token: '111111' }),
      makeEnv({ db: createIdentityDb({ emailSessions: sessions }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_NO_VALID_SESSION');
  });

  it('wrong token → M_INVALID_PARAM soft-3', async () => {
    const sid = `sid-wt-3`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `wt3@example.com`,
      client_secret: 'right',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + DAY_MS,
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'right', token: '000000' }),
      makeEnv({ db: createIdentityDb({ emailSessions: sessions }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('wrong secret → M_NO_VALID_SESSION soft-4', async () => {
    const sid = `sid-ws-4`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `ws4@example.com`,
      client_secret: 'right',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + DAY_MS,
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'wrong', token: '111111' }),
      makeEnv({ db: createIdentityDb({ emailSessions: sessions }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_NO_VALID_SESSION');
  });

  it('wrong token → M_INVALID_PARAM soft-4', async () => {
    const sid = `sid-wt-4`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `wt4@example.com`,
      client_secret: 'right',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + DAY_MS,
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'right', token: '000000' }),
      makeEnv({ db: createIdentityDb({ emailSessions: sessions }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('wrong secret → M_NO_VALID_SESSION soft-5', async () => {
    const sid = `sid-ws-5`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `ws5@example.com`,
      client_secret: 'right',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + DAY_MS,
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'wrong', token: '111111' }),
      makeEnv({ db: createIdentityDb({ emailSessions: sessions }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_NO_VALID_SESSION');
  });

  it('wrong token → M_INVALID_PARAM soft-5', async () => {
    const sid = `sid-wt-5`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `wt5@example.com`,
      client_secret: 'right',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + DAY_MS,
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'right', token: '000000' }),
      makeEnv({ db: createIdentityDb({ emailSessions: sessions }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('wrong secret → M_NO_VALID_SESSION soft-6', async () => {
    const sid = `sid-ws-6`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `ws6@example.com`,
      client_secret: 'right',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + DAY_MS,
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'wrong', token: '111111' }),
      makeEnv({ db: createIdentityDb({ emailSessions: sessions }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_NO_VALID_SESSION');
  });

  it('wrong token → M_INVALID_PARAM soft-6', async () => {
    const sid = `sid-wt-6`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `wt6@example.com`,
      client_secret: 'right',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + DAY_MS,
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'right', token: '000000' }),
      makeEnv({ db: createIdentityDb({ emailSessions: sessions }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('wrong secret → M_NO_VALID_SESSION soft-7', async () => {
    const sid = `sid-ws-7`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `ws7@example.com`,
      client_secret: 'right',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + DAY_MS,
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'wrong', token: '111111' }),
      makeEnv({ db: createIdentityDb({ emailSessions: sessions }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_NO_VALID_SESSION');
  });

  it('wrong token → M_INVALID_PARAM soft-7', async () => {
    const sid = `sid-wt-7`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `wt7@example.com`,
      client_secret: 'right',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + DAY_MS,
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'right', token: '000000' }),
      makeEnv({ db: createIdentityDb({ emailSessions: sessions }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('wrong secret → M_NO_VALID_SESSION soft-8', async () => {
    const sid = `sid-ws-8`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `ws8@example.com`,
      client_secret: 'right',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + DAY_MS,
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'wrong', token: '111111' }),
      makeEnv({ db: createIdentityDb({ emailSessions: sessions }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_NO_VALID_SESSION');
  });

  it('wrong token → M_INVALID_PARAM soft-8', async () => {
    const sid = `sid-wt-8`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `wt8@example.com`,
      client_secret: 'right',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + DAY_MS,
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'right', token: '000000' }),
      makeEnv({ db: createIdentityDb({ emailSessions: sessions }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('wrong secret → M_NO_VALID_SESSION soft-9', async () => {
    const sid = `sid-ws-9`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `ws9@example.com`,
      client_secret: 'right',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + DAY_MS,
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'wrong', token: '111111' }),
      makeEnv({ db: createIdentityDb({ emailSessions: sessions }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_NO_VALID_SESSION');
  });

  it('wrong token → M_INVALID_PARAM soft-9', async () => {
    const sid = `sid-wt-9`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `wt9@example.com`,
      client_secret: 'right',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + DAY_MS,
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'right', token: '000000' }),
      makeEnv({ db: createIdentityDb({ emailSessions: sessions }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('wrong secret → M_NO_VALID_SESSION soft-10', async () => {
    const sid = `sid-ws-10`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `ws10@example.com`,
      client_secret: 'right',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + DAY_MS,
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'wrong', token: '111111' }),
      makeEnv({ db: createIdentityDb({ emailSessions: sessions }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_NO_VALID_SESSION');
  });

  it('wrong token → M_INVALID_PARAM soft-10', async () => {
    const sid = `sid-wt-10`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `wt10@example.com`,
      client_secret: 'right',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + DAY_MS,
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'right', token: '000000' }),
      makeEnv({ db: createIdentityDb({ emailSessions: sessions }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('wrong secret → M_NO_VALID_SESSION soft-11', async () => {
    const sid = `sid-ws-11`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `ws11@example.com`,
      client_secret: 'right',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + DAY_MS,
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'wrong', token: '111111' }),
      makeEnv({ db: createIdentityDb({ emailSessions: sessions }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_NO_VALID_SESSION');
  });

  it('wrong token → M_INVALID_PARAM soft-11', async () => {
    const sid = `sid-wt-11`;
    const sessions = new Map<string, EmailVerificationSession>();
    sessions.set(sid, {
      session_id: sid,
      email: `wt11@example.com`,
      client_secret: 'right',
      token: '111111',
      send_attempt: 1,
      validated: 0,
      created_at: FIXED_NOW,
      expires_at: FIXED_NOW + DAY_MS,
    });
    const { status, body } = await jsonRequest(
      `${BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'right', token: '000000' }),
      makeEnv({ db: createIdentityDb({ emailSessions: sessions }) })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });
});

describe('identity contract leftovers terms GET/POST method pairing soft after #145', () => {

  it('terms GET then POST soft-0', async () => {
    const env = makeEnv();
    const g = await jsonRequest(`${BASE}/terms`, {}, env);
    expect(g.status).toBe(200);
    expect(g.body).toEqual({ policies: {} });
    const p = await jsonRequest(`${BASE}/terms`, postJson({ user_accepts: ['p0'] }), env);
    expect(p.status).toBe(200);
    expect(p.body).toEqual({});
  });

  it('terms GET then POST soft-1', async () => {
    const env = makeEnv();
    const g = await jsonRequest(`${BASE}/terms`, {}, env);
    expect(g.status).toBe(200);
    expect(g.body).toEqual({ policies: {} });
    const p = await jsonRequest(`${BASE}/terms`, postJson({ user_accepts: ['p1'] }), env);
    expect(p.status).toBe(200);
    expect(p.body).toEqual({});
  });

  it('terms GET then POST soft-2', async () => {
    const env = makeEnv();
    const g = await jsonRequest(`${BASE}/terms`, {}, env);
    expect(g.status).toBe(200);
    expect(g.body).toEqual({ policies: {} });
    const p = await jsonRequest(`${BASE}/terms`, postJson({ user_accepts: ['p2'] }), env);
    expect(p.status).toBe(200);
    expect(p.body).toEqual({});
  });

  it('terms GET then POST soft-3', async () => {
    const env = makeEnv();
    const g = await jsonRequest(`${BASE}/terms`, {}, env);
    expect(g.status).toBe(200);
    expect(g.body).toEqual({ policies: {} });
    const p = await jsonRequest(`${BASE}/terms`, postJson({ user_accepts: ['p3'] }), env);
    expect(p.status).toBe(200);
    expect(p.body).toEqual({});
  });

  it('terms GET then POST soft-4', async () => {
    const env = makeEnv();
    const g = await jsonRequest(`${BASE}/terms`, {}, env);
    expect(g.status).toBe(200);
    expect(g.body).toEqual({ policies: {} });
    const p = await jsonRequest(`${BASE}/terms`, postJson({ user_accepts: ['p4'] }), env);
    expect(p.status).toBe(200);
    expect(p.body).toEqual({});
  });

  it('terms GET then POST soft-5', async () => {
    const env = makeEnv();
    const g = await jsonRequest(`${BASE}/terms`, {}, env);
    expect(g.status).toBe(200);
    expect(g.body).toEqual({ policies: {} });
    const p = await jsonRequest(`${BASE}/terms`, postJson({ user_accepts: ['p5'] }), env);
    expect(p.status).toBe(200);
    expect(p.body).toEqual({});
  });

  it('terms GET then POST soft-6', async () => {
    const env = makeEnv();
    const g = await jsonRequest(`${BASE}/terms`, {}, env);
    expect(g.status).toBe(200);
    expect(g.body).toEqual({ policies: {} });
    const p = await jsonRequest(`${BASE}/terms`, postJson({ user_accepts: ['p6'] }), env);
    expect(p.status).toBe(200);
    expect(p.body).toEqual({});
  });

  it('terms GET then POST soft-7', async () => {
    const env = makeEnv();
    const g = await jsonRequest(`${BASE}/terms`, {}, env);
    expect(g.status).toBe(200);
    expect(g.body).toEqual({ policies: {} });
    const p = await jsonRequest(`${BASE}/terms`, postJson({ user_accepts: ['p7'] }), env);
    expect(p.status).toBe(200);
    expect(p.body).toEqual({});
  });

  it('terms GET then POST soft-8', async () => {
    const env = makeEnv();
    const g = await jsonRequest(`${BASE}/terms`, {}, env);
    expect(g.status).toBe(200);
    expect(g.body).toEqual({ policies: {} });
    const p = await jsonRequest(`${BASE}/terms`, postJson({ user_accepts: ['p8'] }), env);
    expect(p.status).toBe(200);
    expect(p.body).toEqual({});
  });

  it('terms GET then POST soft-9', async () => {
    const env = makeEnv();
    const g = await jsonRequest(`${BASE}/terms`, {}, env);
    expect(g.status).toBe(200);
    expect(g.body).toEqual({ policies: {} });
    const p = await jsonRequest(`${BASE}/terms`, postJson({ user_accepts: ['p9'] }), env);
    expect(p.status).toBe(200);
    expect(p.body).toEqual({});
  });

  it('terms GET then POST soft-10', async () => {
    const env = makeEnv();
    const g = await jsonRequest(`${BASE}/terms`, {}, env);
    expect(g.status).toBe(200);
    expect(g.body).toEqual({ policies: {} });
    const p = await jsonRequest(`${BASE}/terms`, postJson({ user_accepts: ['p10'] }), env);
    expect(p.status).toBe(200);
    expect(p.body).toEqual({});
  });

  it('terms GET then POST soft-11', async () => {
    const env = makeEnv();
    const g = await jsonRequest(`${BASE}/terms`, {}, env);
    expect(g.status).toBe(200);
    expect(g.body).toEqual({ policies: {} });
    const p = await jsonRequest(`${BASE}/terms`, postJson({ user_accepts: ['p11'] }), env);
    expect(p.status).toBe(200);
    expect(p.body).toEqual({});
  });
});
