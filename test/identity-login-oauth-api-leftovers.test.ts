/**
 * TOKENMAXX HEAVY leftovers after #147 — identity / login / oauth / account-data
 * residual edge+failure branches still unexercised by soft/failure/KV leftovers.
 * Orthogonal to identity-api-soft / login-api-soft / oauth-api-soft /
 * oauth-failure / login-register-failure / account-data-api-routes /
 * oidc-auth-api-route-leftovers / login-qr-kv-state.
 * Tests-only — Hono app.request() against existing modules. No product inventing.
 * Fixtures use example.com only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HonoRequest } from 'hono/request';
import type { Env } from '../src/types';
import { hashToken } from '../src/utils/crypto';

const authState = vi.hoisted(() => ({
  userId: '@alice:example.com',
  deviceId: 'DEVICE' as string | null,
}));

vi.mock('../src/middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/middleware/auth')>();
  return {
    ...actual,
    requireAuth: () => {
      return async (
        c: { set: (k: string, v: unknown) => void },
        next: () => Promise<void>
      ) => {
        c.set('userId', authState.userId);
        c.set('deviceId', authState.deviceId);
        await next();
      };
    },
  };
});

vi.mock('../src/utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/crypto')>();
  return {
    ...actual,
    verifyPassword: vi.fn(async (password: string, storedHash: string) => {
      return storedHash === `mockok:${password}`;
    }),
    hashPassword: vi.fn(async (password: string) => `mockok:${password}`),
  };
});

vi.mock('../src/utils/ids', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ids')>();
  let opaqueSeq = 0;
  let deviceSeq = 0;
  return {
    ...actual,
    generateOpaqueId: vi.fn(async (len?: number) => {
      opaqueSeq += 1;
      const base = `opaque${opaqueSeq}`.padEnd(len ?? 16, '0');
      return base.slice(0, len ?? 16);
    }),
    generateDeviceId: vi.fn(async () => {
      deviceSeq += 1;
      return `GENDEV${deviceSeq}`;
    }),
    generateAccessToken: vi.fn(async () => {
      opaqueSeq += 1;
      return `syt_access_${opaqueSeq}`;
    }),
    generateRefreshToken: vi.fn(async () => {
      opaqueSeq += 1;
      return `syr_refresh_${opaqueSeq}`;
    }),
  };
});

import oauth, { hashClientSecret } from '../src/api/oauth';
import login from '../src/api/login';
import identity from '../src/api/identity';
import accountDataApp from '../src/api/account-data';

const SERVER = 'example.com';
const USER = `@alice:${SERVER}`;
const DEVICE = 'DEVICE';
const PASS = 'Password1!';
const REDIRECT = 'https://app.example.com/cb';
const NOW = 1_730_500_000_000;
const ID_BASE = '/_matrix/identity/v2';
const USER_ENC = encodeURIComponent(USER);

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };

function mockKv(
  data: Record<string, string> = {},
  opts: {
    throwOnGet?: boolean;
    throwOnPut?: boolean;
    deleteReturn?: unknown;
  } = {}
) {
  const puts: KvPut[] = [];
  const deletes: string[] = [];
  const kv = {
    data,
    puts,
    deletes,
    get: async (key: string, type?: string) => {
      if (opts.throwOnGet) throw new Error('KV get failed');
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
      if (opts.throwOnPut) throw new Error('KV put failed');
      data[key] = value;
      puts.push({ key, value, options });
    },
    delete: async (key: string) => {
      deletes.push(key);
      delete data[key];
      if ('deleteReturn' in opts) return opts.deleteReturn;
      return undefined;
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

// ---------------------------------------------------------------------------
// Shared user / oauth DB stubs
// ---------------------------------------------------------------------------

type UserRow = {
  user_id: string;
  localpart: string;
  display_name: string | null;
  avatar_url: string | null;
  password_hash: string | null;
  is_guest: number;
  is_deactivated: number;
  admin: number;
  created_at: number;
};

type TokenRow = {
  token_id?: string;
  token_hash?: string;
  user_id: string;
  device_id: string | null;
  created_at: number;
};

type SqlCall = { sql: string; args: unknown[] };

function userRow(partial: Partial<UserRow> & Pick<UserRow, 'user_id' | 'localpart'>): UserRow {
  return {
    display_name: partial.display_name ?? partial.localpart,
    avatar_url: partial.avatar_url ?? null,
    password_hash: partial.password_hash ?? null,
    is_guest: partial.is_guest ?? 0,
    is_deactivated: partial.is_deactivated ?? 0,
    admin: partial.admin ?? 0,
    created_at: partial.created_at ?? NOW,
    user_id: partial.user_id,
    localpart: partial.localpart,
  };
}

function createOAuthDb(opts: {
  users?: Map<string, UserRow>;
  tokensByHash?: Map<string, TokenRow>;
} = {}) {
  const users = opts.users ?? new Map<string, UserRow>();
  const tokensByHash = opts.tokensByHash ?? new Map<string, TokenRow>();
  const inserts: SqlCall[] = [];
  const deletes: SqlCall[] = [];

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
                const u = users.get(args[0] as string);
                if (!u || u.is_deactivated) return null;
                return { user_id: u.user_id, password_hash: u.password_hash } as T;
              }
              if (sql.includes('SELECT password_hash FROM users')) {
                const u = users.get(args[0] as string);
                return (u ? { password_hash: u.password_hash } : null) as T;
              }
              if (
                sql.includes('FROM users WHERE user_id') &&
                sql.includes('display_name') &&
                !sql.includes('password_hash')
              ) {
                const u = users.get(args[0] as string);
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
                const row = tokensByHash.get(args[0] as string);
                if (!row) return null;
                if (sql.includes('created_at')) {
                  return {
                    user_id: row.user_id,
                    device_id: row.device_id,
                    created_at: row.created_at,
                  } as T;
                }
                return { user_id: row.user_id, device_id: row.device_id } as T;
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
    inserts: SqlCall[];
    deletes: SqlCall[];
  };
}

function aliceOAuthDb() {
  return createOAuthDb({
    users: new Map([
      [
        USER,
        userRow({
          user_id: USER,
          localpart: 'alice',
          password_hash: `mockok:${PASS}`,
        }),
      ],
    ]),
  });
}

function oauthEnv(opts: {
  cache?: ReturnType<typeof mockKv>;
  sessions?: ReturnType<typeof mockKv>;
  db?: ReturnType<typeof createOAuthDb>;
} = {}): Env {
  return {
    SERVER_NAME: SERVER,
    SERVER_VERSION: '0.1.0-test',
    CACHE: opts.cache ?? mockKv(),
    SESSIONS: opts.sessions ?? mockKv(),
    DB: opts.db ?? createOAuthDb(),
  } as Env;
}

async function oauthRequest(
  path: string,
  init: RequestInit = {},
  env: Env = oauthEnv()
): Promise<Response> {
  return oauth.request(`http://localhost${path}`, init, env);
}

async function oauthJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function seedClient(
  cache: ReturnType<typeof mockKv>,
  clientId = 'client_left',
  patch: Record<string, unknown> = {}
) {
  cache.data[`oauth_client:${clientId}`] = JSON.stringify({
    client_id: clientId,
    client_secret_hash: null,
    client_name: 'Leftover Client',
    redirect_uris: [REDIRECT],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    created_at: NOW,
    ...patch,
  });
  return clientId;
}

async function seedAuthCode(
  sessions: ReturnType<typeof mockKv>,
  code: string,
  patch: Record<string, unknown> = {}
) {
  sessions.data[`oauth_code:${code}`] = JSON.stringify({
    code,
    client_id: 'client_left',
    redirect_uri: REDIRECT,
    user_id: USER,
    scope: 'openid urn:matrix:org.matrix.msc2967.client:device:DEV1',
    code_challenge: null,
    code_challenge_method: null,
    expires_at: NOW + 600_000,
    created_at: NOW,
    ...patch,
  });
}

// ---------------------------------------------------------------------------
// Login DB stub
// ---------------------------------------------------------------------------

function createLoginDb(opts: {
  users?: Map<string, UserRow>;
  tokens?: Array<{
    token_id: string;
    token_hash: string;
    user_id: string;
    device_id: string | null;
    created_at: number;
  }>;
} = {}) {
  const users = opts.users ?? new Map<string, UserRow>();
  const usersByLocalpart = new Map<string, UserRow>(
    [...users.values()].map((u) => [u.localpart, u])
  );
  const tokens = opts.tokens ?? [];
  const devices: Array<{
    user_id: string;
    device_id: string;
    display_name: string | null;
    created_at: number;
  }> = [];
  const inserts: SqlCall[] = [];
  const deletes: SqlCall[] = [];

  return {
    users,
    usersByLocalpart,
    tokens,
    devices,
    inserts,
    deletes,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT password_hash FROM users')) {
                const u = users.get(args[0] as string);
                return (u ? { password_hash: u.password_hash } : null) as T;
              }
              if (
                sql.includes('FROM users WHERE user_id = ?') &&
                sql.includes('SELECT user_id, localpart')
              ) {
                const u = users.get(args[0] as string);
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
              if (
                sql.includes('FROM users WHERE localpart = ?') &&
                sql.includes('SELECT user_id, localpart')
              ) {
                const u = usersByLocalpart.get(args[0] as string);
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
              return null;
            },
            async run() {
              if (sql.includes('INSERT INTO devices')) {
                inserts.push({ sql, args });
                const [userId, deviceId, displayName] = args as [string, string, string | null];
                devices.push({
                  user_id: userId,
                  device_id: deviceId,
                  display_name: displayName,
                  created_at: Date.now(),
                });
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO access_tokens')) {
                inserts.push({ sql, args });
                const [tokenId, tokenHash, userId, deviceId] = args as [
                  string,
                  string,
                  string,
                  string | null,
                ];
                tokens.push({
                  token_id: tokenId,
                  token_hash: tokenHash,
                  user_id: userId,
                  device_id: deviceId,
                  created_at: Date.now(),
                });
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes('DELETE FROM access_tokens WHERE token_hash = ?')) {
                deletes.push({ sql, args });
                const hash = args[0] as string;
                for (let i = tokens.length - 1; i >= 0; i--) {
                  if (tokens[i].token_hash === hash) tokens.splice(i, 1);
                }
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes('DELETE FROM access_tokens WHERE token_id = ?')) {
                deletes.push({ sql, args });
                const tokenId = args[0] as string;
                for (let i = tokens.length - 1; i >= 0; i--) {
                  if (tokens[i].token_id === tokenId) tokens.splice(i, 1);
                }
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes('DELETE FROM access_tokens WHERE user_id = ?')) {
                deletes.push({ sql, args });
                const userId = args[0] as string;
                for (let i = tokens.length - 1; i >= 0; i--) {
                  if (tokens[i].user_id === userId) tokens.splice(i, 1);
                }
                return { success: true, meta: { changes: 1 } };
              }
              throw new Error(`Unhandled SQL in login leftovers stub: ${sql.slice(0, 140)}`);
            },
          };
        },
      };
    },
  };
}

function loginEnv(
  db: ReturnType<typeof createLoginDb> = createLoginDb(),
  sessions: ReturnType<typeof mockKv> = mockKv()
): Env {
  return {
    SERVER_NAME: SERVER,
    SERVER_VERSION: '0.1.0-test',
    DB: db as unknown as D1Database,
    SESSIONS: sessions,
    CACHE: mockKv(),
  } as Env;
}

async function loginRequest(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const res = await login.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { _raw: text };
  }
  return { status: res.status, body, text };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function aliceLoginDb(extra: Partial<UserRow> = {}) {
  return createLoginDb({
    users: new Map([
      [
        USER,
        userRow({
          user_id: USER,
          localpart: 'alice',
          password_hash: `mockok:${PASS}`,
          ...extra,
        }),
      ],
    ]),
  });
}

// ---------------------------------------------------------------------------
// Identity DB stub
// ---------------------------------------------------------------------------

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

function createIdentityDb(opts: {
  emailSessions?: Map<string, EmailVerificationSession>;
} = {}) {
  const emailSessions = opts.emailSessions ?? new Map<string, EmailVerificationSession>();
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];

  return {
    emailSessions,
    inserts,
    updates,
    prepare(sql: string) {
      const stmt = {
        async all<T>() {
          return { results: [] as T[] };
        },
        bind(...args: unknown[]) {
          return {
            all: stmt.all,
            async first<T>() {
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
              if (sql.includes('UPDATE email_verification_sessions SET validated = 1')) {
                updates.push({ sql, args });
                const [validatedAt, sessionId] = args as [number, string];
                const session = emailSessions.get(sessionId);
                if (session) {
                  session.validated = 1;
                  session.validated_at = validatedAt;
                }
              }
              if (sql.includes('INSERT INTO email_verification_sessions')) {
                inserts.push({ sql, args });
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
      return stmt;
    },
  };
}

function identityEnv(db: ReturnType<typeof createIdentityDb> = createIdentityDb()): Env {
  return {
    SERVER_NAME: SERVER,
    CACHE: mockKv(),
    DB: db as unknown as D1Database,
  } as Env;
}

async function identityJson(
  path: string,
  init: RequestInit = {},
  env: Env = identityEnv()
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await identity.request(`http://localhost${path}`, init, env);
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Account-data stubs
// ---------------------------------------------------------------------------

type AccountDataRow = {
  user_id: string;
  room_id: string;
  event_type: string;
  content: string;
};

function createUserKeysStub(opts: {
  accountData?: Record<string, unknown | null>;
  failGet?: boolean;
  failPut?: boolean;
  putTextReject?: boolean;
} = {}) {
  const accountData: Record<string, unknown | null> = { ...(opts.accountData ?? {}) };
  const fetches: Array<{ url: string; method: string; body?: unknown }> = [];

  return {
    fetches,
    accountData,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      let body: unknown;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        try {
          body = await req.json();
        } catch {
          body = undefined;
        }
      }
      fetches.push({ url: req.url, method: req.method, body });

      if (opts.failGet && path.endsWith('/account-data/get')) {
        return new Response('boom', { status: 500 });
      }
      if (opts.failPut && path.endsWith('/account-data/put')) {
        if (opts.putTextReject) {
          return new Response(null, {
            status: 502,
            // force text() rejection via a broken body stream when possible
          });
        }
        return new Response('boom', { status: 500 });
      }

      if (path === '/account-data/get') {
        const eventType = url.searchParams.get('event_type');
        if (eventType) {
          if (!(eventType in accountData)) return Response.json(null);
          return Response.json(accountData[eventType]);
        }
        return Response.json(accountData);
      }

      if (path === '/account-data/put') {
        const b = body as { event_type: string; content: unknown };
        accountData[b.event_type] = b.content;
        return Response.json({ success: true });
      }

      return new Response('not found', { status: 404 });
    },
  };
}

function createAccountDataDb(opts: { rows?: AccountDataRow[] } = {}) {
  const rows = [...(opts.rows ?? [])];
  const changes: Array<{
    user_id: string;
    room_id: string;
    event_type: string;
    stream_position: number;
  }> = [];
  const inserts: SqlCall[] = [];
  let streamPos = 10;

  return {
    rows,
    changes,
    inserts,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (
                sql.includes('SELECT content FROM account_data') &&
                sql.includes("room_id = ''")
              ) {
                const [userId, eventType] = args as [string, string];
                const hit = rows.find(
                  (r) =>
                    r.user_id === userId && r.event_type === eventType && r.room_id === ''
                );
                return (hit ? { content: hit.content } : null) as T;
              }
              if (sql.includes('SELECT position FROM stream_positions')) {
                return { position: streamPos } as T;
              }
              return null;
            },
            async run() {
              if (sql.includes('UPDATE stream_positions SET position = position + 1')) {
                streamPos += 1;
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('INSERT INTO account_data_changes')) {
                inserts.push({ sql, args });
                const [userId, roomId, eventType, streamPosition] = args as [
                  string,
                  string,
                  string,
                  number,
                ];
                changes.push({
                  user_id: userId,
                  room_id: roomId,
                  event_type: eventType,
                  stream_position: streamPosition,
                });
                return { success: true, meta: { changes: 1, last_row_id: changes.length } };
              }
              if (sql.includes('INSERT INTO account_data')) {
                inserts.push({ sql, args });
                const isGlobalLiteral =
                  sql.includes("VALUES (?, '', ?, ?)") || sql.includes("VALUES (?, '',?,?)");
                let userId: string;
                let roomId: string;
                let eventType: string;
                let content: string;
                if (isGlobalLiteral) {
                  [userId, eventType, content] = args as [string, string, string];
                  roomId = '';
                } else {
                  [userId, roomId, eventType, content] = args as [
                    string,
                    string,
                    string,
                    string,
                  ];
                }
                const existing = rows.find(
                  (r) =>
                    r.user_id === userId &&
                    r.room_id === roomId &&
                    r.event_type === eventType
                );
                if (existing) existing.content = content;
                else rows.push({ user_id: userId, room_id: roomId, event_type: eventType, content });
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              throw new Error(`Unhandled SQL in account-data leftovers: ${sql.slice(0, 140)}`);
            },
          };
        },
      };
    },
  };
}

function accountDataEnv(opts: {
  db?: ReturnType<typeof createAccountDataDb>;
  accountDataKv?: ReturnType<typeof mockKv>;
  userKeys?: ReturnType<typeof createUserKeysStub>;
} = {}) {
  const db = opts.db ?? createAccountDataDb();
  const accountDataKv = opts.accountDataKv ?? mockKv();
  const userKeys = opts.userKeys ?? createUserKeysStub();
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
    ACCOUNT_DATA: accountDataKv,
    USER_KEYS: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => userKeys,
    },
    _db: db,
    _accountData: accountDataKv,
    _userKeys: userKeys,
  } as unknown as Env & {
    _db: ReturnType<typeof createAccountDataDb>;
    _accountData: ReturnType<typeof mockKv>;
    _userKeys: ReturnType<typeof createUserKeysStub>;
  };
}

async function accountDataRequest(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown; text: string }> {
  const res = await accountDataApp.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, text };
}

function globalPath(type: string): string {
  return `/_matrix/client/v3/user/${USER_ENC}/account_data/${encodeURIComponent(type)}`;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  authState.userId = USER;
  authState.deviceId = DEVICE;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// =============================================================================
// OAuth — residual failure / reliability leftovers after #147
// =============================================================================

describe('oauth leftovers after #147 — UIA parseBody catch', () => {
  it('POST /oauth/authorize/uia when parseBody rejects → Invalid Request HTML', async () => {
    const spy = vi
      .spyOn(HonoRequest.prototype, 'parseBody')
      .mockRejectedValueOnce(new Error('parse boom'));
    const env = oauthEnv();
    const res = await oauthRequest(
      '/oauth/authorize/uia',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'session=x',
      },
      env
    );
    spy.mockRestore();
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Invalid Request');
    expect(html).toContain('Could not parse request.');
  });

  it('POST /oauth/authorize/uia truncated multipart → Invalid Request or missing session HTML', async () => {
    const env = oauthEnv();
    const res = await oauthRequest(
      '/oauth/authorize/uia',
      {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=----x' },
        body: '------x\r\nContent-Disposition: form-data; name="session"\r\n\r\n',
      },
      env
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // Either parseBody catch or missing-session path — never 5xx
    expect(html).toMatch(/Invalid Request|Missing Session|Could not parse|No UIA session/);
  });
});

describe('oauth leftovers after #147 — Basic auth hostility', () => {
  it('invalid base64 Basic header surfaces without inventing client', async () => {
    const cache = mockKv();
    seedClient(cache);
    const env = oauthEnv({ cache, db: aliceOAuthDb() });
    const res = await oauthRequest(
      '/oauth/token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic !!!',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'x',
          redirect_uri: REDIRECT,
          client_id: 'client_left',
        }),
      },
      env
    );
    // atob throws → uncaught 500 documents current behavior
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('Basic without colon (secret undefined) does not invent credentials', async () => {
    const cache = mockKv();
    seedClient(cache);
    const env = oauthEnv({ cache, db: aliceOAuthDb() });
    const res = await oauthRequest(
      '/oauth/token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${btoa('onlyclient')}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'x',
          redirect_uri: REDIRECT,
        }),
      },
      env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('Basic with multiple colons truncates secret to first segment → invalid_client for confidential', async () => {
    const cache = mockKv();
    const secretHash = await hashClientSecret('sec');
    seedClient(cache, 'conf', {
      client_secret_hash: secretHash,
      token_endpoint_auth_method: 'client_secret_basic',
    });
    const env = oauthEnv({ cache, db: aliceOAuthDb() });
    // id:sec:ret → secret becomes "sec" only if split on first colon... actually split(':') gives ['id','sec','ret'] and [id,secret]=['id','sec']
    // Wait: const [id, secret] = decoded.split(':') → id='id', secret='sec' — so multi-colon with correct first segment succeeds.
    // Use wrong first segment:
    const basic = btoa('conf:wrong:sec');
    const res = await oauthRequest(
      '/oauth/token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'x',
          redirect_uri: REDIRECT,
        }),
      },
      env
    );
    expect(res.status).toBe(401);
    expect(await oauthJson(res)).toMatchObject({ error: 'invalid_client' });
  });
});

describe('oauth leftovers after #147 — auth code scope null / omitted / empty challenge', () => {
  it('seeded oauth_code with omitted scope generates device_id', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache);
    const code = 'code-noscope';
    // Build payload without scope key
    sessions.data[`oauth_code:${code}`] = JSON.stringify({
      code,
      client_id: 'client_left',
      redirect_uri: REDIRECT,
      user_id: USER,
      code_challenge: null,
      code_challenge_method: null,
      expires_at: NOW + 600_000,
      created_at: NOW,
    });
    const env = oauthEnv({ cache, sessions, db: aliceOAuthDb() });
    const res = await oauthRequest(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          client_id: 'client_left',
        }),
      },
      env
    );
    expect(res.status).toBe(200);
    const body = await oauthJson(res);
    expect(typeof body.device_id).toBe('string');
    expect(String(body.device_id).length).toBeGreaterThan(0);
  });

  it('seeded oauth_code with scope: null generates device_id', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache);
    await seedAuthCode(sessions, 'code-null-scope', { scope: null });
    const env = oauthEnv({ cache, sessions, db: aliceOAuthDb() });
    const res = await oauthRequest(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'code-null-scope',
          redirect_uri: REDIRECT,
          client_id: 'client_left',
        }),
      },
      env
    );
    expect(res.status).toBe(200);
    expect((await oauthJson(res)).device_id).toBeTruthy();
  });

  it('empty-string code_challenge skips PKCE (falsy) without verifier', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache);
    await seedAuthCode(sessions, 'code-empty-chal', {
      code_challenge: '',
      code_challenge_method: 'S256',
      scope: 'openid urn:matrix:org.matrix.msc2967.client:device:EMPTYCHAL',
    });
    const env = oauthEnv({ cache, sessions, db: aliceOAuthDb() });
    const res = await oauthRequest(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'code-empty-chal',
          redirect_uri: REDIRECT,
          client_id: 'client_left',
          // no code_verifier
        }),
      },
      env
    );
    expect(res.status).toBe(200);
    expect((await oauthJson(res)).device_id).toBe('EMPTYCHAL');
  });
});

describe('oauth leftovers after #147 — code delete-before-validate burns code', () => {
  const failureCases: Array<{ name: string; patch: Record<string, unknown>; bodyExtra?: Record<string, string> }> = [
    {
      name: 'client mismatch',
      patch: { client_id: 'other_client' },
    },
    {
      name: 'expired code',
      patch: { expires_at: NOW - 1 },
    },
    {
      name: 'redirect mismatch',
      patch: { redirect_uri: 'https://evil.example/cb' },
    },
    {
      name: 'PKCE fail',
      patch: {
        code_challenge: 'abc',
        code_challenge_method: 'plain',
      },
      bodyExtra: { code_verifier: 'wrong' },
    },
  ];

  for (const row of failureCases) {
    it(`${row.name}: code deleted before invalid_grant`, async () => {
      const cache = mockKv();
      const sessions = mockKv();
      seedClient(cache);
      seedClient(cache, 'other_client');
      const code = `burn-${row.name.replace(/\s+/g, '-')}`;
      await seedAuthCode(sessions, code, row.patch);
      const env = oauthEnv({ cache, sessions, db: aliceOAuthDb() });
      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: 'client_left',
        ...(row.bodyExtra ?? {}),
      });
      const res = await oauthRequest(
        '/oauth/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params,
        },
        env
      );
      expect(res.status).toBe(400);
      const body = await oauthJson(res);
      expect(['invalid_grant', 'invalid_request']).toContain(body.error);
      expect(sessions.data[`oauth_code:${code}`]).toBeUndefined();
      expect(sessions.deletes).toContain(`oauth_code:${code}`);

      // Second attempt — code already burned
      const again = await oauthRequest(
        '/oauth/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params,
        },
        env
      );
      expect(again.status).toBe(400);
      expect((await oauthJson(again)).error).toBe('invalid_grant');
    });
  }
});

describe('oauth leftovers after #147 — revoke delete short-circuit', () => {
  it('when SESSIONS.delete returns non-undefined, skips access_token DB delete', async () => {
    const sessions = mockKv({}, { deleteReturn: true });
    sessions.data['oauth_refresh:rt-short'] = JSON.stringify({ token_id: 't' });
    const db = createOAuthDb();
    const token = 'rt-short';
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, { user_id: USER, device_id: 'D', created_at: NOW });
    const env = oauthEnv({ sessions, db });
    const res = await oauthRequest(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, token_type_hint: 'refresh_token' }),
      },
      env
    );
    expect(res.status).toBe(200);
    expect(sessions.deletes).toContain('oauth_refresh:rt-short');
    // Short-circuit: access token row must remain
    expect(db.tokensByHash.has(hash)).toBe(true);
    expect(db.deletes).toHaveLength(0);
  });

  it('deleteReturn undefined still falls through to access_token path (Workers KV shape)', async () => {
    const sessions = mockKv({}, { deleteReturn: undefined });
    sessions.data['oauth_refresh:rt-fall'] = '{}';
    const db = createOAuthDb();
    const token = 'rt-fall';
    const hash = await hashToken(token);
    db.tokensByHash.set(hash, { user_id: USER, device_id: 'D', created_at: NOW });
    const env = oauthEnv({ sessions, db });
    const res = await oauthRequest(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      },
      env
    );
    expect(res.status).toBe(200);
    expect(db.tokensByHash.has(hash)).toBe(false);
  });
});

describe('oauth leftovers after #147 — corrupt KV JSON hostility', () => {
  const corruptSamples = ['{bad', '{', 'null', '"str"', '[1]', 'undefined'];

  for (const sample of corruptSamples) {
    it(`corrupt oauth_client ${JSON.stringify(sample)} on token → non-200`, async () => {
      const cache = mockKv();
      cache.data['oauth_client:client_left'] = sample;
      const env = oauthEnv({ cache, db: aliceOAuthDb() });
      const res = await oauthRequest(
        '/oauth/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: 'x',
            client_id: 'client_left',
            redirect_uri: REDIRECT,
          }),
        },
        env
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  }

  it('corrupt oauth_code JSON after get → non-200 and documents burn-or-crash', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache);
    sessions.data['oauth_code:corrupt'] = '{not-json';
    const env = oauthEnv({ cache, sessions, db: aliceOAuthDb() });
    const res = await oauthRequest(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'corrupt',
          client_id: 'client_left',
          redirect_uri: REDIRECT,
        }),
      },
      env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('corrupt uia_session JSON on GET → non-200', async () => {
    const cache = mockKv();
    cache.data['uia_session:bad'] = '{bad';
    const env = oauthEnv({ cache });
    const res = await oauthRequest('/oauth/authorize/uia?session=bad', {}, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('corrupt oauth_auth_request on POST authorize → non-200', async () => {
    const sessions = mockKv();
    sessions.data['oauth_auth_request:badreq'] = '{bad';
    const env = oauthEnv({ sessions, db: aliceOAuthDb() });
    const fd = new FormData();
    fd.set('username', 'alice');
    fd.set('password', PASS);
    fd.set('auth_request_id', 'badreq');
    const res = await oauthRequest('/oauth/authorize', { method: 'POST', body: fd }, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('oauth leftovers after #147 — token/revoke/introspect bad JSON', () => {
  for (const path of ['/oauth/token', '/oauth/revoke', '/oauth/introspect'] as const) {
    it(`${path} application/json with '{' → uncaught or 4xx (no invent)`, async () => {
      const env = oauthEnv();
      const res = await oauthRequest(
        path,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        },
        env
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  }
});

describe('oauth leftovers after #147 — refresh ignores stored expires_at', () => {
  it('refresh with past expires_at still succeeds (documents current behavior)', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache);
    const refresh = 'rt-expired-left';
    sessions.data[`oauth_refresh:${refresh}`] = JSON.stringify({
      token_id: 'tid',
      access_token_hash: 'h',
      refresh_token_hash: 'rh',
      client_id: 'client_left',
      user_id: USER,
      device_id: 'DEV',
      scope: 'openid',
      created_at: NOW - 86_400_000,
      expires_at: NOW - 1,
    });
    const env = oauthEnv({ cache, sessions, db: aliceOAuthDb() });
    const res = await oauthRequest(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refresh,
          client_id: 'client_left',
        }),
      },
      env
    );
    expect(res.status).toBe(200);
    const body = await oauthJson(res);
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    expect(sessions.data[`oauth_refresh:${refresh}`]).toBeUndefined();
  });
});

describe('oauth leftovers after #147 — introspect missing created_at → iat NaN', () => {
  it('access token row without created_at yields non-finite iat', async () => {
    const db = createOAuthDb();
    const token = 'iat-nan-token';
    const hash = await hashToken(token);
    // Intentionally omit created_at on the row object; SQL path returns undefined
    db.tokensByHash.set(hash, {
      user_id: USER,
      device_id: 'D',
      created_at: undefined as unknown as number,
    });
    const env = oauthEnv({ db });
    const res = await oauthRequest(
      '/oauth/introspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      },
      env
    );
    expect(res.status).toBe(200);
    const body = await oauthJson(res);
    expect(body.active).toBe(true);
    expect(Number.isFinite(body.iat as number)).toBe(false);
  });
});

// =============================================================================
// Login — residual leftovers after #147
// =============================================================================

describe('login leftovers after #147 — whoami deactivated quirk', () => {
  it('deactivated user with valid middleware principal still returns 200', async () => {
    const db = aliceLoginDb({ is_deactivated: 1 });
    const res = await loginRequest(loginEnv(db), '/_matrix/client/v3/account/whoami');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user_id: USER,
      device_id: DEVICE,
      is_guest: false,
    });
  });

  it('whoami guest + deactivated still returns is_guest true', async () => {
    const db = aliceLoginDb({ is_deactivated: 1, is_guest: 1 });
    const res = await loginRequest(loginEnv(db), '/_matrix/client/v3/account/whoami');
    expect(res.status).toBe(200);
    expect(res.body.is_guest).toBe(true);
  });
});

describe('login leftovers after #147 — m.login.dummy missing user field', () => {
  it('identifier type m.id.user without user → non-200 (may throw)', async () => {
    const env = loginEnv(aliceLoginDb());
    let status = 0;
    let errcode = '';
    try {
      const res = await loginRequest(
        env,
        '/_matrix/client/v3/login',
        jsonInit('POST', {
          type: 'm.login.dummy',
          identifier: { type: 'm.id.user' },
        })
      );
      status = res.status;
      errcode = String(res.body.errcode ?? '');
    } catch {
      status = 500;
      errcode = 'THROWN';
    }
    expect(status).not.toBe(200);
    if (status !== 500) {
      expect(errcode.length).toBeGreaterThan(0);
    }
  });

  it('dummy missing identifier → M_MISSING_PARAM', async () => {
    const res = await loginRequest(
      loginEnv(aliceLoginDb()),
      '/_matrix/client/v3/login',
      jsonInit('POST', { type: 'm.login.dummy' })
    );
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('dummy with deactivated user → M_USER_DEACTIVATED', async () => {
    const res = await loginRequest(
      loginEnv(aliceLoginDb({ is_deactivated: 1 })),
      '/_matrix/client/v3/login',
      jsonInit('POST', {
        type: 'm.login.dummy',
        identifier: { type: 'm.id.user', user: 'alice' },
      })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_USER_DEACTIVATED');
  });
});

describe('login leftovers after #147 — refresh without deactivated gate', () => {
  it('valid refresh for deactivated user still rotates tokens (documents gap)', async () => {
    const db = aliceLoginDb({ is_deactivated: 1 });
    const sessions = mockKv();
    const refresh = 'syr_refresh_deact';
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: DEVICE,
      accessTokenId: 'old-tid',
      createdAt: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh })
    );
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.refresh_token).toBeTruthy();
    expect(sessions.data[`refresh:${refreshHash}`]).toBeUndefined();
  });

  it('refresh for missing user row still rotates (no getUserById gate)', async () => {
    const db = createLoginDb(); // empty users
    const sessions = mockKv();
    const refresh = 'syr_refresh_nouser';
    const refreshHash = await hashToken(refresh);
    sessions.data[`refresh:${refreshHash}`] = JSON.stringify({
      userId: USER,
      deviceId: DEVICE,
      accessTokenId: 'old-tid',
      createdAt: NOW - 1000,
    });
    const env = loginEnv(db, sessions);
    const res = await loginRequest(
      env,
      '/_matrix/client/v3/refresh',
      jsonInit('POST', { refresh_token: refresh })
    );
    expect(res.status).toBe(200);
    // refresh response has no user_id field — documents rotation without user lookup
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.refresh_token).toBeTruthy();
    expect(db.tokens.some((t) => t.user_id === USER)).toBe(true);
  });
});

// =============================================================================
// Identity — submitToken omit / empty field leftovers after #147
// =============================================================================

describe('identity leftovers after #147 — submitToken omitted/empty fields', () => {
  const SID = 'sid-left-aaaa-bbbb-cccc-ddddeeeeffff';
  const SECRET = 'client-secret-left';
  const TOKEN = '654321';

  function seed(db: ReturnType<typeof createIdentityDb>) {
    db.emailSessions.set(SID, {
      session_id: SID,
      email: 'left@example.com',
      client_secret: SECRET,
      token: TOKEN,
      send_attempt: 1,
      validated: 0,
      created_at: NOW - 1000,
      expires_at: NOW + 60_000,
      validated_at: null,
    });
  }

  const omitCases: Array<{ name: string; body: Record<string, unknown>; expectCode: string }> = [
    { name: 'empty object', body: {}, expectCode: 'M_NO_VALID_SESSION' },
    {
      name: 'missing sid',
      body: { client_secret: SECRET, token: TOKEN },
      expectCode: 'M_NO_VALID_SESSION',
    },
    {
      name: 'missing client_secret',
      body: { sid: SID, token: TOKEN },
      expectCode: 'M_NO_VALID_SESSION',
    },
    {
      name: 'missing token',
      body: { sid: SID, client_secret: SECRET },
      expectCode: 'M_INVALID_PARAM',
    },
    {
      name: 'empty sid',
      body: { sid: '', client_secret: SECRET, token: TOKEN },
      expectCode: 'M_NO_VALID_SESSION',
    },
    {
      name: 'empty client_secret',
      body: { sid: SID, client_secret: '', token: TOKEN },
      expectCode: 'M_NO_VALID_SESSION',
    },
    {
      name: 'empty token',
      body: { sid: SID, client_secret: SECRET, token: '' },
      expectCode: 'M_INVALID_PARAM',
    },
    {
      name: 'null sid',
      body: { sid: null, client_secret: SECRET, token: TOKEN },
      expectCode: 'M_NO_VALID_SESSION',
    },
    {
      name: 'null token',
      body: { sid: SID, client_secret: SECRET, token: null },
      expectCode: 'M_INVALID_PARAM',
    },
  ];

  for (const row of omitCases) {
    it(`${row.name} → ${row.expectCode} without 5xx / UPDATE`, async () => {
      const db = createIdentityDb();
      seed(db);
      const { status, body } = await identityJson(
        `${ID_BASE}/validate/email/submitToken`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(row.body),
        },
        identityEnv(db)
      );
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
      expect(body.errcode).toBe(row.expectCode);
      expect(db.updates).toHaveLength(0);
    });
  }

  it('valid submitToken still succeeds (control)', async () => {
    const db = createIdentityDb();
    seed(db);
    const { status, body } = await identityJson(
      `${ID_BASE}/validate/email/submitToken`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: SID, client_secret: SECRET, token: TOKEN }),
      },
      identityEnv(db)
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.updates).toHaveLength(1);
  });
});

// =============================================================================
// Account-data — KV corrupt parse + put throw leftovers after #147
// =============================================================================

describe('account-data leftovers after #147 — E2EE KV corrupt JSON → D1 fallback', () => {
  const e2eeTypes = [
    'm.cross_signing.master',
    'm.secret_storage.default_key',
    'm.megolm_backup.v1',
    'm.secret_storage.key.ABC',
  ];

  for (const type of e2eeTypes) {
    it(`${type}: DO miss + corrupt KV falls through to D1`, async () => {
      const userKeys = createUserKeysStub({ accountData: {} });
      const accountDataKv = mockKv({
        [`global:${USER}:${type}`]: '{not-json',
      });
      const db = createAccountDataDb({
        rows: [
          {
            user_id: USER,
            room_id: '',
            event_type: type,
            content: JSON.stringify({ via: 'd1', type }),
          },
        ],
      });
      const env = accountDataEnv({ userKeys, accountDataKv, db });
      const res = await accountDataRequest(env, globalPath(type));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ via: 'd1', type });
    });
  }

  it('corrupt KV with no D1 → 404 (catch then miss)', async () => {
    const userKeys = createUserKeysStub({ accountData: {} });
    const accountDataKv = mockKv({
      [`global:${USER}:m.cross_signing.master`]: '{bad',
    });
    const env = accountDataEnv({
      userKeys,
      accountDataKv,
      db: createAccountDataDb(),
    });
    const res = await accountDataRequest(env, globalPath('m.cross_signing.master'));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('DO throw + corrupt KV + D1 hit still returns D1', async () => {
    const userKeys = createUserKeysStub({ failGet: true });
    const type = 'm.cross_signing.self_signing';
    const accountDataKv = mockKv({
      [`global:${USER}:${type}`]: '{',
    });
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '',
          event_type: type,
          content: JSON.stringify({ keys: { a: 1 } }),
        },
      ],
    });
    const env = accountDataEnv({ userKeys, accountDataKv, db });
    const res = await accountDataRequest(env, globalPath(type));
    expect(res.body).toEqual({ keys: { a: 1 } });
  });
});

describe('account-data leftovers after #147 — PUT E2EE ACCOUNT_DATA.put throw after DO', () => {
  it('DO success + KV put throw → 5xx and D1 not written', async () => {
    const type = 'm.secret_storage.default_key';
    const userKeys = createUserKeysStub();
    const accountDataKv = mockKv({}, { throwOnPut: true });
    const db = createAccountDataDb();
    const env = accountDataEnv({ userKeys, accountDataKv, db });
    const res = await accountDataRequest(
      env,
      globalPath(type),
      jsonInit('PUT', { key: 'k1' })
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    // DO wrote successfully before KV throw
    expect(userKeys.accountData[type]).toEqual({ key: 'k1' });
    // D1 never reached
    expect(db.rows).toHaveLength(0);
    expect(db.changes).toHaveLength(0);
  });

  for (const type of [
    'm.cross_signing.master',
    'm.megolm_backup.v1',
    'm.secret_storage.key.X',
  ]) {
    it(`put throw matrix ${type}`, async () => {
      const userKeys = createUserKeysStub();
      const accountDataKv = mockKv({}, { throwOnPut: true });
      const db = createAccountDataDb();
      const env = accountDataEnv({ userKeys, accountDataKv, db });
      const res = await accountDataRequest(
        env,
        globalPath(type),
        jsonInit('PUT', { v: type })
      );
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(db.rows).toHaveLength(0);
    });
  }
});

describe('account-data leftovers after #147 — DO put text() reject → unknown error → 503', () => {
  it('non-ok DO put with unread body maps to 503 Failed to store E2EE data', async () => {
    const type = 'm.cross_signing.user_signing';
    // Custom stub: ok:false and text() rejects
    const fetches: Array<{ url: string }> = [];
    const stub = {
      fetches,
      accountData: {} as Record<string, unknown>,
      async fetch(req: Request): Promise<Response> {
        fetches.push({ url: req.url });
        const path = new URL(req.url).pathname;
        if (path.endsWith('/account-data/put')) {
          const stream = new ReadableStream({
            start(controller) {
              controller.error(new Error('read fail'));
            },
          });
          return new Response(stream, { status: 502 });
        }
        return Response.json(null);
      },
    };
    const accountDataKv = mockKv();
    const db = createAccountDataDb();
    const env = {
      DB: db as unknown as D1Database,
      SERVER_NAME: SERVER,
      ACCOUNT_DATA: accountDataKv,
      USER_KEYS: {
        idFromName: (name: string) => ({ name, toString: () => name }),
        get: () => stub,
      },
    } as unknown as Env;

    const res = await accountDataRequest(
      env,
      globalPath(type),
      jsonInit('PUT', { keys: {} })
    );
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      errcode: 'M_UNKNOWN',
      error: 'Failed to store E2EE data',
    });
    expect(accountDataKv.puts).toHaveLength(0);
    expect(db.rows).toHaveLength(0);
  });
});

// =============================================================================
// Soft reliability floods — residual matrices (TOKENMAXX)
// =============================================================================

describe('oauth leftovers soft flood — authorize/uia session charset after #147', () => {
  const sessionIds = [
    'plain',
    'with-dash',
    'with_under',
    'ABC123',
    'a'.repeat(64),
    'sess.dot',
    'sess:colon',
  ];

  for (const [i, sessionId] of sessionIds.entries()) {
    it(`GET uia missing session soft-${i} (${sessionId.slice(0, 12)})`, async () => {
      const env = oauthEnv();
      const res = await oauthRequest(
        `/oauth/authorize/uia?session=${encodeURIComponent(sessionId)}`,
        {},
        env
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('Session Expired');
    });
  }
});

describe('identity leftovers soft flood — submitToken bad JSON after #147', () => {
  // Truly unparseable → M_BAD_JSON (<500). JSON null/true/1 parse then crash on destructure → 500.
  const badBodies: Array<{ body: string; maxExclusive?: number }> = [
    { body: '{' },
    { body: '{]' },
    { body: '' },
    { body: '[]', maxExclusive: 600 },
    { body: '"x"', maxExclusive: 600 },
    { body: 'null', maxExclusive: 600 },
    { body: 'true', maxExclusive: 600 },
    { body: '1', maxExclusive: 600 },
  ];

  for (const [i, row] of badBodies.entries()) {
    it(`submitToken bad JSON soft-${i}`, async () => {
      const res = await identity.request(
        `http://localhost${ID_BASE}/validate/email/submitToken`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: row.body,
        },
        identityEnv()
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(row.maxExclusive ?? 500);
    });
  }
});

describe('login leftovers soft flood — whoami deviceId matrix after #147', () => {
  const devices: Array<string | null> = [
    'DEVICE',
    'A',
    'device_with_underscore',
    'DEV-1',
    null,
  ];

  for (const [i, deviceId] of devices.entries()) {
    it(`whoami device soft-${i}`, async () => {
      authState.deviceId = deviceId;
      const res = await loginRequest(
        loginEnv(aliceLoginDb()),
        '/_matrix/client/v3/account/whoami'
      );
      expect(res.status).toBe(200);
      expect(res.body.device_id).toBe(deviceId);
      expect(res.body.user_id).toBe(USER);
    });
  }
});

describe('account-data leftovers soft flood — corrupt KV samples after #147', () => {
  // Only samples that throw on JSON.parse (valid JSON would return as KV hit)
  const samples = ['{', '{bad', 'undefined', '{]', ',\n', '{ok:', '[1,2,', "'"];

  for (const [i, sample] of samples.entries()) {
    it(`corrupt KV soft-${i} falls to D1`, async () => {
      const type = 'm.cross_signing.master';
      const userKeys = createUserKeysStub({ accountData: {} });
      const accountDataKv = mockKv({ [`global:${USER}:${type}`]: sample });
      const db = createAccountDataDb({
        rows: [
          {
            user_id: USER,
            room_id: '',
            event_type: type,
            content: JSON.stringify({ ok: i }),
          },
        ],
      });
      const env = accountDataEnv({ userKeys, accountDataKv, db });
      const res = await accountDataRequest(env, globalPath(type));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: i });
    });
  }
});
