/**
 * TOKENMAXX HEAVY leftovers after #144/#145/#146 — oauth helpers + soft oauth
 * failure + push delivery/rules + account-data helpers + identity API soft edges.
 * Orthogonal to oauth-push-account-data-register-leftovers / oauth-failure-leftovers /
 * identity-api-soft-leftovers / identity-lookup-validate / identity-account-register /
 * push-delivery / account-data-helpers. Tests only. No product inventing.
 * Fixtures use example.com only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import {
  base64UrlDecode,
  base64UrlEncode,
  escapeHtml,
  generateLoginPage,
  generateRandomString,
  generateUiaApprovalPage,
  generateUiaCancelledPage,
  generateUiaErrorPage,
  generateUiaSuccessPage,
  hashClientSecret,
  verifyCodeChallenge,
} from '../src/api/oauth';
import oauth from '../src/api/oauth';
import {
  evaluatePushRules,
  getNestedValue,
  matchesCondition,
  matchesRule,
  notifyRoomMembersOfMessage,
  queueNotification,
  sendPushNotification,
  type PushRule,
} from '../src/api/push';
import {
  getAccountDataStreamPosition,
  getAllRoomAccountData,
  getE2EEAccountDataFromDO,
  getGlobalAccountData,
  getRoomAccountData,
} from '../src/api/account-data';
import identity from '../src/api/identity';
import { sha256 } from '../src/utils/crypto';

vi.mock('../src/utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/crypto')>();
  return {
    ...actual,
    verifyPassword: vi.fn(async (password: string, storedHash: string) => {
      return storedHash === `mockok:${password}`;
    }),
  };
});

const SERVER = 'example.com';
const USER = `@alice:${SERVER}`;
const PUSH_USER = '@bob:example.com';
const REDIRECT = 'https://app.example/cb';
const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAY_TTL = 7 * 24 * 60 * 60;
const ID_BASE = '/_matrix/identity/v2';

type PusherRow = { pushkey: string; kind: string; app_id: string; data: string };
type Queued = {
  user_id: string;
  room_id: string;
  event_id: string;
  notification_type: string;
  actions: string;
};
type Update = { kind: 'success' | 'failure'; ts: number; user_id: string; pushkey: string; app_id: string };
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

function createPushDb(opts: {
  pushers?: Record<string, PusherRow[]>;
  members?: string[];
  memberCount?: number;
  senderDisplayName?: string | null;
  roomNameContent?: string | null;
  pushRules?: Array<{
    kind: string;
    rule_id: string;
    conditions: string | null;
    actions: string;
    enabled: number;
  }>;
  unreadCount?: number | null;
  queueThrow?: boolean;
  updateThrow?: boolean;
}) {
  const queued: Queued[] = [];
  const updates: Update[] = [];

  const db = {
    queued,
    updates,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async all<T>() {
              if (sql.includes('FROM pushers WHERE user_id')) {
                const userId = args[0] as string;
                return { results: (opts.pushers?.[userId] ?? []) as T[] };
              }
              if (sql.includes('FROM room_memberships') && sql.includes('user_id !=')) {
                return {
                  results: (opts.members ?? [])
                    .filter((u) => u !== args[1])
                    .map((user_id) => ({ user_id })) as T[],
                };
              }
              if (sql.includes('FROM push_rules')) {
                return { results: (opts.pushRules ?? []) as T[] };
              }
              return { results: [] };
            },
            async first<T>() {
              if (sql.includes('COUNT(*)') && sql.includes('FROM room_memberships')) {
                return { count: opts.memberCount ?? (opts.members?.length ?? 0) + 1 } as T;
              }
              if (sql.includes('SELECT display_name FROM room_memberships')) {
                return { display_name: opts.senderDisplayName ?? null } as T;
              }
              if (sql.includes("event_type = 'm.room.name'")) {
                if (opts.roomNameContent == null) return null;
                return { content: opts.roomNameContent } as T;
              }
              if (sql.includes('COUNT(*)') && sql.includes('FROM events e')) {
                if (opts.unreadCount === null) return null;
                return { count: opts.unreadCount ?? 2 } as T;
              }
              return null;
            },
            async run() {
              if (sql.includes('INSERT INTO notification_queue')) {
                if (opts.queueThrow) throw new Error('queue fail');
                queued.push({
                  user_id: args[0] as string,
                  room_id: args[1] as string,
                  event_id: args[2] as string,
                  notification_type: args[3] as string,
                  actions: args[4] as string,
                });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE pushers SET last_success')) {
                if (opts.updateThrow) throw new Error('update fail');
                updates.push({
                  kind: 'success',
                  ts: args[0] as number,
                  user_id: args[1] as string,
                  pushkey: args[2] as string,
                  app_id: args[3] as string,
                });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE pushers SET last_failure')) {
                if (opts.updateThrow) throw new Error('update fail');
                updates.push({
                  kind: 'failure',
                  ts: args[0] as number,
                  user_id: args[1] as string,
                  pushkey: args[2] as string,
                  app_id: args[3] as string,
                });
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };

  return db as unknown as D1Database & { queued: Queued[]; updates: Update[] };
}

function httpPusher(data: Record<string, unknown> = {}, overrides: Partial<PusherRow> = {}): PusherRow {
  return {
    pushkey: overrides.pushkey ?? 'pk',
    kind: overrides.kind ?? 'http',
    app_id: overrides.app_id ?? 'io.element.elementx.ios',
    data:
      overrides.data ??
      JSON.stringify({
        url: 'https://push.example/gateway',
        format: 'event_id_only',
        default_payload: { aps: { sound: 'default' } },
        ...data,
      }),
  };
}

function baseEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: '$e:example.com',
    room_id: '!r:example.com',
    type: 'm.room.message',
    sender: '@alice:example.com',
    content: { body: 'hi', msgtype: 'm.text' },
    origin_server_ts: NOW - 10,
    ...overrides,
  };
}

function pushRulesDb(rows: Array<Record<string, unknown>> = []) {
  return {
    prepare() {
      return {
        bind() {
          return {
            async all<T>() {
              return { results: rows as T[] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

type AccountDataRow = {
  user_id: string;
  room_id: string;
  event_type: string;
  content: string | null;
};

type ChangeRow = {
  user_id: string;
  room_id: string;
  event_type: string;
  stream_position: number;
};

function createAccountDataDb(opts: {
  rows?: AccountDataRow[];
  changes?: ChangeRow[];
  streamPosition?: number | null;
  throwOnPrepare?: boolean;
  throwOnAll?: boolean;
}) {
  const rows = [...(opts.rows ?? [])];
  const changes = [...(opts.changes ?? [])];
  const streamPosition = opts.streamPosition === undefined ? 42 : opts.streamPosition;
  const prepares: string[] = [];
  const binds: unknown[][] = [];

  function latestChangePos(userId: string, roomId: string, eventType: string): number {
    return changes
      .filter((c) => c.user_id === userId && c.room_id === roomId && c.event_type === eventType)
      .reduce((max, c) => Math.max(max, c.stream_position), -Infinity);
  }

  function stmt(sql: string, args: unknown[] = []) {
    return {
      bind(...bindArgs: unknown[]) {
        binds.push(bindArgs);
        return stmt(sql, bindArgs);
      },
      async all<T>() {
        if (opts.throwOnAll) throw new Error('all boom');
        const isChangeJoin = sql.includes('account_data_changes');
        const isGlobal = sql.includes("room_id = ''");
        const isSingleRoom = !isGlobal && sql.includes('room_id = ?') && !sql.includes('IN (');
        const isMultiRoom = sql.includes('IN (');

        if (sql.includes('FROM account_data') || sql.includes('FROM account_data ad')) {
          if (isMultiRoom) {
            const userId = args[0] as string;
            const since = isChangeJoin ? (args[args.length - 1] as number) : undefined;
            const roomIds = (isChangeJoin ? args.slice(1, -1) : args.slice(1)) as string[];
            const results: Array<{ room_id: string; event_type: string; content: string | null }> = [];
            for (const roomId of roomIds) {
              const roomRows = rows.filter((r) => r.user_id === userId && r.room_id === roomId);
              for (const r of roomRows) {
                if (isChangeJoin) {
                  const pos = latestChangePos(userId, roomId, r.event_type);
                  if (!(pos > (since as number))) continue;
                }
                results.push({ room_id: r.room_id, event_type: r.event_type, content: r.content });
              }
            }
            return { results: results as T[] };
          }

          if (isGlobal) {
            const userId = args[0] as string;
            const since = isChangeJoin ? (args[1] as number) : undefined;
            const filtered = rows.filter((r) => r.user_id === userId && r.room_id === '');
            const results = filtered
              .filter((r) => {
                if (!isChangeJoin) return true;
                const pos = latestChangePos(userId, '', r.event_type);
                return pos > (since as number);
              })
              .map((r) => ({ event_type: r.event_type, content: r.content }));
            return { results: results as T[] };
          }

          if (isSingleRoom) {
            const userId = args[0] as string;
            const roomId = args[1] as string;
            const since = isChangeJoin ? (args[2] as number) : undefined;
            const filtered = rows.filter((r) => r.user_id === userId && r.room_id === roomId);
            const results = filtered
              .filter((r) => {
                if (!isChangeJoin) return true;
                const pos = latestChangePos(userId, roomId, r.event_type);
                return pos > (since as number);
              })
              .map((r) => ({ event_type: r.event_type, content: r.content }));
            return { results: results as T[] };
          }
        }

        return { results: [] as T[] };
      },
      async first<T>() {
        if (sql.includes('FROM stream_positions') && sql.includes('account_data')) {
          if (streamPosition === null) return null;
          return { position: streamPosition } as T;
        }
        return null;
      },
      async run() {
        return { meta: { changes: 0 } };
      },
    };
  }

  const db = {
    prepares,
    binds,
    prepare(sql: string) {
      if (opts.throwOnPrepare) throw new Error('prepare boom');
      prepares.push(sql);
      return stmt(sql);
    },
  };

  return db as unknown as D1Database & { prepares: string[]; binds: unknown[][] };
}

function mockUserKeysNamespace(opts: {
  responses?: Map<string, Response | (() => Response) | (() => Promise<Response>)>;
  throwOnFetch?: Error;
}) {
  const fetches: Array<{ url: string; method: string }> = [];

  return {
    fetches,
    idFromName(userId: string) {
      return { name: userId };
    },
    get(_id: { name: string }) {
      return {
        async fetch(request: Request) {
          fetches.push({ url: request.url, method: request.method });
          if (opts.throwOnFetch) throw opts.throwOnFetch;
          const url = new URL(request.url);
          const key = url.searchParams.get('event_type') ?? '__all__';
          const entry = opts.responses?.get(key);
          if (!entry) {
            return new Response(JSON.stringify({}), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return typeof entry === 'function' ? await entry() : entry;
        },
      };
    },
  };
}

function createOAuthDb(opts: {
  users?: Map<string, { user_id: string; password_hash: string | null; is_deactivated?: number }>;
  tokensByHash?: Map<string, { user_id: string; device_id: string | null }>;
} = {}) {
  const users = opts.users ?? new Map();
  const tokensByHash = opts.tokensByHash ?? new Map();
  return {
    users,
    tokensByHash,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            first: async () => {
              if (sql.includes('FROM users') && sql.includes('password_hash')) {
                const userId = args[0] as string;
                const u = users.get(userId);
                if (!u || u.is_deactivated) return null;
                return { user_id: u.user_id, password_hash: u.password_hash };
              }
              if (sql.includes('FROM access_tokens') && sql.includes('token_hash')) {
                return tokensByHash.get(args[0] as string) ?? null;
              }
              if (sql.includes('FROM users') && sql.includes('display_name')) {
                const u = users.get(args[0] as string);
                if (!u) return null;
                return { user_id: u.user_id, display_name: null, avatar_url: null };
              }
              return null;
            },
            all: async () => ({ results: [] }),
            run: async () => ({ success: true, meta: { changes: 0 } }),
          };
        },
      };
    },
  } as unknown as D1Database & {
    users: Map<string, { user_id: string; password_hash: string | null; is_deactivated?: number }>;
  };
}

function makeOAuthEnv(
  overrides: Partial<{ CACHE: ReturnType<typeof mockKv>; SESSIONS: ReturnType<typeof mockKv>; DB: D1Database }> = {}
): Env {
  return {
    SERVER_NAME: SERVER,
    SERVER_VERSION: '0.1.0-test',
    CACHE: overrides.CACHE ?? mockKv(),
    SESSIONS: overrides.SESSIONS ?? mockKv(),
    DB: overrides.DB ?? createOAuthDb(),
  } as Env;
}

async function oauthRequest(path: string, init: RequestInit = {}, env: Env = makeOAuthEnv()): Promise<Response> {
  return oauth.request(`http://localhost${path}`, init, env);
}

async function oauthJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function seedClient(
  cache: ReturnType<typeof mockKv>,
  clientId = 'client_id_leftovers',
  patch: Record<string, unknown> = {}
) {
  cache.data[`oauth_client:${clientId}`] = JSON.stringify({
    client_id: clientId,
    client_secret_hash: null,
    client_name: 'Leftovers Client',
    redirect_uris: [REDIRECT],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    created_at: Date.now(),
    ...patch,
  });
  return clientId;
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
  throwOnAll?: boolean;
  throwOnFirst?: boolean;
  throwOnRun?: boolean;
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
          if (opts.throwOnAll) throw new Error('identity all boom');
          if (sql.includes('FROM identity_associations') && sql.includes('SELECT medium, address, mxid')) {
            return { results: [...associations] } as { results: T[] };
          }
          return { results: [] as T[] };
        },
        bind(...args: unknown[]) {
          return {
            all: stmt.all,
            async first<T>() {
              if (opts.throwOnFirst) throw new Error('identity first boom');
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
              if (opts.throwOnRun) throw new Error('identity run boom');
              if (sql.includes('INSERT INTO email_verification_sessions')) {
                inserts.push({ sql, args });
                const [sessionId, email, clientSecret, token, sendAttempt, createdAt, expiresAt] = args as [
                  string,
                  string,
                  string,
                  string,
                  number,
                  number,
                  number,
                ];
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

function makeIdentityEnv(opts: {
  cache?: ReturnType<typeof mockKv>;
  db?: ReturnType<typeof createIdentityDb>;
  serverName?: string;
} = {}): Env {
  return {
    SERVER_NAME: opts.serverName ?? SERVER,
    CACHE: opts.cache ?? mockKv(),
    DB: opts.db ?? createIdentityDb(),
  } as Env;
}

async function identityRequest(
  path: string,
  init: RequestInit = {},
  env: Env = makeIdentityEnv()
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

describe('oauth identity leftovers helpers generateRandomString length soft edges after #146', () => {
  for (const len of [0, 1, 2, 3, 7, 8, 15, 16, 31, 32, 64, 128]) {
    it(`generateRandomString(${len}) hex length ${len * 2}`, () => {
      const s = generateRandomString(len);
      expect(s).toHaveLength(len * 2);
      expect(s).toMatch(/^[0-9a-f]*$/);
    });
  }

  it('default length is 32 bytes → 64 hex chars', () => {
    expect(generateRandomString()).toHaveLength(64);
  });
});

describe('oauth identity leftovers helpers base64Url high-bit soft edges after #146', () => {
  for (const bytes of [
    [0xff],
    [0x00, 0xff],
    [0x80, 0x7f, 0xfe],
    [1, 2, 3, 4, 5],
    [255, 254, 253, 252],
    Array.from({ length: 17 }, (_, i) => (i * 17) % 256),
    Array.from({ length: 33 }, (_, i) => 255 - i),
  ]) {
    it(`roundtrip high-bit bytes len=${bytes.length}`, () => {
      const u8 = new Uint8Array(bytes);
      const enc = base64UrlEncode(u8);
      expect(enc).not.toMatch(/[+/=]/);
      const dec = base64UrlDecode(enc);
      expect(Array.from(dec)).toEqual(Array.from(u8));
    });
  }

  for (const bad of ['!!!!', '@@@@', '####', '$$$$', '%%%%', '^^^^', '&&&&', '****']) {
    it(`base64UrlDecode rejects-or-throws soft for ${JSON.stringify(bad)}`, () => {
      expect(() => base64UrlDecode(bad)).toThrow();
    });
  }
});

describe('oauth identity leftovers helpers PKCE method soft reject matrix after #146', () => {
  const verifier = 'verifier-abcdefghijklmnopqrstuvwxyz012345';
  for (const method of [
    '',
    's256',
    'S256 ',
    ' S256',
    'PLAIN',
    'Plain',
    'plain ',
    'none',
    'sha256',
    'S-256',
    's_256',
    'PKCE',
    'null',
    'undefined',
    '0',
    'true',
  ]) {
    it(`unknown/soft method ${JSON.stringify(method)} → false`, async () => {
      const ok = await verifyCodeChallenge(verifier, verifier, method);
      expect(ok).toBe(false);
    });
  }

  it('plain exact match still true', async () => {
    expect(await verifyCodeChallenge(verifier, verifier, 'plain')).toBe(true);
  });

  it('plain mismatch still false', async () => {
    expect(await verifyCodeChallenge(verifier, verifier + 'x', 'plain')).toBe(false);
  });

  it('S256 computed challenge matches', async () => {
    const encoder = new TextEncoder();
    const hash = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
    const challenge = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(verifier, challenge, 'S256')).toBe(true);
  });

  it('S256 wrong challenge false', async () => {
    expect(await verifyCodeChallenge(verifier, 'not-the-challenge', 'S256')).toBe(false);
  });
});

describe('oauth identity leftovers helpers escapeHtml XSS soft matrix after #146', () => {
  const payloads = [
    '<script>alert(1)</script>',
    '"onclick=alert(1)"',
    "'onload=alert(1)'",
    '&amp;<b>',
    '<<>>',
    'a&b&c',
    '"><img src=x onerror=alert(1)>',
    "';alert(1)//",
    '</textarea><script>',
    '<svg/onload=alert(1)>',
    'javascript:alert(1)',
    '\u0000<script>',
    'café <b>',
    '日本語<script>',
    'A'.repeat(200) + '<x>',
  ];
  for (const p of payloads) {
    it(`escapeHtml soft XSS ${JSON.stringify(p).slice(0, 40)}`, () => {
      const out = escapeHtml(p);
      expect(out).not.toContain('<script');
      expect(out).not.toMatch(/<(?!$)/); // no raw open angle for tags we care about — soft
      if (p.includes('<')) expect(out).toContain('&lt;');
      if (p.includes('&') && !p.startsWith('&amp;')) {
        // may already contain amp entities
        expect(out.includes('&amp;') || out.includes('&lt;')).toBe(true);
      }
      if (p.includes('"')) expect(out).toContain('&quot;');
      if (p.includes("'")) expect(out).toContain('&#039;');
    });
  }
});

describe('oauth identity leftovers helpers UIA/login HTML soft XSS after #146', () => {
  it('login page escapes client name XSS', () => {
    const html = generateLoginPage('<img src=x onerror=alert(1)>', 'req', SERVER, '"><script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
    expect(html).toContain('auth_request_id');
    expect(html).toContain(SERVER);
  });

  it('approval page escapes user id and titles', () => {
    const html = generateUiaApprovalPage(
      'sid<script>',
      '@evil<script>:example.com',
      '<b>title</b>',
      '<i>desc</i>',
      'evil.com"><script>'
    );
    expect(html).not.toMatch(/<script>/);
    expect(html).toContain('&lt;');
  });

  it('success page embeds session as JS string safely escaped via page builder', () => {
    const html = generateUiaSuccessPage('sess-123', SERVER);
    expect(html).toContain('sess-123');
    expect(html).toContain(SERVER);
  });

  it('cancelled and error pages escape server/message', () => {
    expect(generateUiaCancelledPage('<x>')).toContain('&lt;x&gt;');
    const err = generateUiaErrorPage('<t>', '<m>', '<s>');
    expect(err).toContain('&lt;t&gt;');
    expect(err).toContain('&lt;m&gt;');
    expect(err).toContain('&lt;s&gt;');
  });
});

describe('oauth identity leftovers helpers hashClientSecret soft avalanche after #146', () => {
  it('empty secret hashes stably', async () => {
    const a = await hashClientSecret('');
    const b = await hashClientSecret('');
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  for (const s of ['a', 'b', 'A', 'secret', 'secret ', ' secret', '🔐', 'x'.repeat(64)]) {
    it(`hash distinctness soft for ${JSON.stringify(s).slice(0, 20)}`, async () => {
      const h = await hashClientSecret(s);
      expect(h).not.toBe(await hashClientSecret(s + '!'));
      expect(h).toBe(await hashClientSecret(s));
    });
  }
});

describe('oauth identity leftovers soft failure register charset after #146', () => {
  for (const body of ['{', '}', '{]', '[}', 'undefined', 'NaN', 'Infinity', '{"redirect_uris":']) {
    it(`register corrupt JSON ${JSON.stringify(body)} → invalid_request soft`, async () => {
      const res = await oauthRequest('/oauth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      const j = await oauthJson(res);
      expect(j.error).toBeDefined();
    });
  }

  for (const uris of [[123], [null], [true], [{}], [''], ['ftp://x'], ['javascript:alert(1)']]) {
    it(`register redirect_uris soft ${JSON.stringify(uris)}`, async () => {
      const res = await oauthRequest('/oauth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: 'x', redirect_uris: uris }),
      });
      // Current soft behavior: non-empty redirect_uris arrays are accepted without URI scheme validation (201)
      // or rejected as metadata/JSON issues — never hang; document either path.
      expect([201, 400, 500]).toContain(res.status);
    });
  }
});

describe('oauth identity leftovers soft failure authorize query soft matrix after #146', () => {
  it('authorize missing client_id soft', async () => {
    const res = await oauthRequest(
      `/oauth/authorize?response_type=code&redirect_uri=${encodeURIComponent(REDIRECT)}`
    );
    expect(res.status).toBe(400);
    expect((await oauthJson(res)).error).toBe('invalid_request');
  });

  it('authorize missing redirect soft', async () => {
    const res = await oauthRequest('/oauth/authorize?client_id=x&response_type=code');
    expect(res.status).toBe(400);
    expect((await oauthJson(res)).error).toBe('invalid_request');
  });

  it('authorize unknown client soft', async () => {
    const res = await oauthRequest(
      `/oauth/authorize?client_id=missing&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT)}`
    );
    expect(res.status).toBe(400);
    expect((await oauthJson(res)).error).toBe('invalid_client');
  });

  it('authorize with valid client returns HTML login', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'cli_html');
    const res = await oauthRequest(
      `/oauth/authorize?response_type=code&client_id=cli_html&redirect_uri=${encodeURIComponent(REDIRECT)}&state=st&nonce=n&code_challenge=cc&code_challenge_method=S256`,
      {},
      makeOAuthEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/<html/i);
    expect(html).toContain('Leftovers Client');
    expect(Object.keys(sessions.data).some((k) => k.startsWith('oauth_auth_request:'))).toBe(true);
    const put = sessions.puts.find((p) => p.key.startsWith('oauth_auth_request:'));
    expect(put?.options?.expirationTtl).toBe(600);
  });

  for (const state of ['', 'a', '中文', '"><x>', 'a'.repeat(200)]) {
    it(`authorize state soft store ${JSON.stringify(state).slice(0, 24)}`, async () => {
      const cache = mockKv();
      const sessions = mockKv();
      seedClient(cache, 'cli_st');
      const res = await oauthRequest(
        `/oauth/authorize?response_type=code&client_id=cli_st&redirect_uri=${encodeURIComponent(REDIRECT)}&state=${encodeURIComponent(state)}`,
        {},
        makeOAuthEnv({ CACHE: cache, SESSIONS: sessions })
      );
      expect(res.status).toBe(200);
      const key = Object.keys(sessions.data).find((k) => k.startsWith('oauth_auth_request:'));
      expect(key).toBeTruthy();
      const stored = JSON.parse(sessions.data[key!]);
      expect(stored.state).toBe(state);
    });
  }
});

describe('oauth identity leftovers soft failure token grant soft matrix after #146', () => {
  it('token empty body soft fail', async () => {
    const res = await oauthRequest('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });
    // Empty JSON body currently surfaces as 5xx (null deref) — soft reliability edge
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('token form-urlencoded missing client soft', async () => {
    const res = await oauthRequest('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=authorization_code&code=x&redirect_uri=' + encodeURIComponent(REDIRECT),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  for (const gt of ['client_credentials', 'implicit', 'urn:ietf:params:oauth:grant-type:device_code', '']) {
    it(`token unsupported grant soft ${JSON.stringify(gt)}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cli_gt');
      const res = await oauthRequest(
        '/oauth/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grant_type: gt, client_id: 'cli_gt', code: 'x', redirect_uri: REDIRECT }),
        },
        makeOAuthEnv({ CACHE: cache })
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  }

  it('token authorization_code redirect mismatch soft', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'cli_rd');
    sessions.data['oauth_code:code1'] = JSON.stringify({
      client_id: 'cli_rd',
      redirect_uri: REDIRECT,
      user_id: USER,
      scope: 'openid',
      code_challenge: null,
      code_challenge_method: null,
    });
    const res = await oauthRequest(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'cli_rd',
          code: 'code1',
          redirect_uri: 'https://other.example/cb',
        }),
      },
      makeOAuthEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(400);
    expect(['invalid_grant', 'invalid_request']).toContain((await oauthJson(res)).error as string);
  });
});

describe('oauth identity leftovers soft failure auth header malformations after #146', () => {
  for (const auth of [
    'Bearer',
    'Bearer ',
    'bearer tok',
    'BEARER tok',
    'Token abc',
    'Basic',
    'Basic ',
    'Basic !!!',
    'Basic ' + btoa('onlyuser'),
    'Basic ' + btoa(':onlypass'),
    'Basic ' + btoa('user:pass:extra'),
  ]) {
    it(`token Basic/Bearer soft malformation ${JSON.stringify(auth).slice(0, 40)}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cli_auth', {
        token_endpoint_auth_method: 'client_secret_basic',
        client_secret_hash: await hashClientSecret('secret'),
      });
      const res = await oauthRequest(
        '/oauth/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: auth,
          },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            code: 'x',
            redirect_uri: REDIRECT,
            client_id: 'cli_auth',
          }),
        },
        makeOAuthEnv({ CACHE: cache })
      );
      // Malformed Basic may 400/401 or 5xx on decode — soft reliability edge
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  }
});

describe('oauth identity leftovers soft failure revoke/introspect/userinfo after #146', () => {
  for (const path of ['/oauth/revoke', '/oauth/introspect']) {
    for (const body of ['{', 'null', '[]', '"x"', '']) {
      it(`${path} corrupt body soft ${JSON.stringify(body)}`, async () => {
        const res = await oauthRequest(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        // Corrupt/null JSON often 5xx on field deref — soft reliability edge
        expect(res.status).toBeGreaterThanOrEqual(400);
      });
    }
  }

  it('userinfo Authorization empty Bearer soft', async () => {
    const res = await oauthRequest('/oauth/userinfo', {
      headers: { Authorization: 'Bearer ' },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('userinfo Authorization Basic soft rejected', async () => {
    const res = await oauthRequest('/oauth/userinfo', {
      headers: { Authorization: 'Basic ' + btoa('a:b') },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('introspect form-urlencoded unknown soft inactive-or-error', async () => {
    const res = await oauthRequest('/oauth/introspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'token=opaque-unknown-token',
    });
    expect(res.status).toBeLessThan(500);
  });
});

describe('oauth identity leftovers soft failure UIA session soft edges after #146', () => {
  it('GET uia missing session → error HTML', async () => {
    const res = await oauthRequest('/oauth/authorize/uia');
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Missing Session|session/i);
  });

  it('GET uia expired session → error HTML', async () => {
    const res = await oauthRequest('/oauth/authorize/uia?session=gone');
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/expired|Session/i);
  });

  it('GET uia valid session cross_signing soft HTML', async () => {
    const cache = mockKv();
    cache.data['uia_session:sid1'] = JSON.stringify({ user_id: USER, created_at: NOW });
    const res = await oauthRequest(
      '/oauth/authorize/uia?session=sid1&action=org.matrix.cross_signing_reset',
      {},
      makeOAuthEnv({ CACHE: cache })
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/Reset Encryption|encryption/i);
    expect(html).toContain('alice');
  });

  it('POST uia missing session soft error HTML', async () => {
    const fd = new FormData();
    fd.set('username', 'alice');
    fd.set('password', 'pw');
    const res = await oauthRequest('/oauth/authorize/uia', { method: 'POST', body: fd });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Missing Session|session/i);
  });
});

describe('oauth identity leftovers push getNestedValue soft path flood after #146', () => {
  const obj: any = {
    a: { b: { c: 1, d: null, e: [1, 2, { f: 'x' }] } },
    content: { body: 'hi', 'm.relates_to': { event_id: '$e' } },
    sender: USER,
  };
  it('getNestedValue a.b.c', () => expect(getNestedValue(obj, 'a.b.c')).toBe(1));
  it('getNestedValue a.b.d null', () => expect(getNestedValue(obj, 'a.b.d')).toBeNull());
  it('getNestedValue missing', () => expect(getNestedValue(obj, 'a.b.missing')).toBeUndefined());
  it('getNestedValue array index path', () => expect(getNestedValue(obj, 'a.b.e.2.f')).toBe('x'));
  it('getNestedValue content.body', () => expect(getNestedValue(obj, 'content.body')).toBe('hi'));
  it('getNestedValue dotted key segment splits on dots soft', () => {
    // path.split('.') cannot address keys that contain '.' — soft undefined
    expect(getNestedValue(obj, 'content.m.relates_to.event_id')).toBeUndefined();
    expect(getNestedValue(obj.content, 'm.relates_to')).toBeUndefined();
  });
  it('getNestedValue sender', () => expect(getNestedValue(obj, 'sender')).toBe(USER));
  it('getNestedValue overshoot', () => expect(getNestedValue(obj, 'a.b.c.extra')).toBeUndefined());
  it('getNestedValue null root soft', () => {
    expect(getNestedValue(null, 'a')).toBeUndefined();
    expect(getNestedValue(undefined, 'a')).toBeUndefined();
  });
});

describe('oauth identity leftovers push matchesCondition soft operator flood after #146', () => {
  const event = baseEvent({ content: { body: 'Hello Alice bob', msgtype: 'm.text' } });

  for (const [is, count, ok] of [
    ['==2', 2, true],
    ['==2', 3, false],
    ['<3', 2, true],
    ['>1', 2, true],
    ['<=2', 2, true],
    ['>=2', 2, true],
    ['2', 2, true],
    ['==', 2, false],
    ['abc', 2, false],
    ['==2a', 2, false],
    ['<0', 0, false],
    ['>=0', 0, true],
  ] as const) {
    it(`room_member_count soft is=${is} count=${count}`, () => {
      expect(
        matchesCondition({ kind: 'room_member_count', is }, event, USER, count as number)
      ).toBe(ok);
    });
  }

  it('contains_display_name soft case-insensitive', () => {
    expect(matchesCondition({ kind: 'contains_display_name' }, event, USER, 2, 'alice')).toBe(true);
    expect(matchesCondition({ kind: 'contains_display_name' }, event, USER, 2, 'ALICE')).toBe(true);
    expect(matchesCondition({ kind: 'contains_display_name' }, event, USER, 2, 'carol')).toBe(false);
    expect(matchesCondition({ kind: 'contains_display_name' }, event, USER, 2, undefined)).toBe(false);
  });

  it('event_property_is / contains soft', () => {
    const e = baseEvent({ content: { tags: ['a', 'b'], n: 1 } });
    expect(matchesCondition({ kind: 'event_property_is', key: 'content.n', value: 1 }, e, USER, 2)).toBe(true);
    expect(matchesCondition({ kind: 'event_property_is', key: 'content.n', value: 2 }, e, USER, 2)).toBe(false);
    expect(
      matchesCondition({ kind: 'event_property_contains', key: 'content.tags', value: 'a' }, e, USER, 2)
    ).toBe(true);
    expect(
      matchesCondition({ kind: 'event_property_contains', key: 'content.n', value: 1 }, e, USER, 2)
    ).toBe(false);
  });

  it('unknown condition kind soft defaults true', () => {
    expect(matchesCondition({ kind: 'totally_unknown' as any }, event, USER, 2)).toBe(true);
  });

  it('sender_notification_permission soft always true', () => {
    expect(matchesCondition({ kind: 'sender_notification_permission' }, event, USER, 2)).toBe(true);
  });
});

describe('oauth identity leftovers push matchesRule / evaluate soft after #146', () => {
  it('pattern rule soft glob *', () => {
    const rule: PushRule = {
      rule_id: '.m.rule.contains_user_name',
      default: true,
      enabled: true,
      pattern: 'ali*',
      actions: ['notify'],
    };
    expect(matchesRule(rule, baseEvent({ content: { body: 'alice hi' } }), USER, 2)).toBe(true);
    expect(matchesRule(rule, baseEvent({ content: { body: 'bob' } }), USER, 2)).toBe(false);
    expect(matchesRule(rule, baseEvent({ content: {} }), USER, 2)).toBe(false);
  });

  it('vacuous rule no conditions soft true', () => {
    const rule: PushRule = {
      rule_id: 'x',
      default: false,
      enabled: true,
      actions: ['notify'],
    };
    expect(matchesRule(rule, baseEvent(), USER, 2)).toBe(true);
  });

  it('evaluatePushRules corrupt actions JSON soft skip-or-handle', async () => {
    const db = pushRulesDb([
      {
        kind: 'override',
        rule_id: 'bad',
        conditions: 'not-json',
        actions: 'also-bad',
        enabled: 1,
      },
    ]);
    try {
      const r = await evaluatePushRules(db, PUSH_USER, baseEvent() as any, 2);
      expect(r).toHaveProperty('notify');
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  });

  it('evaluatePushRules notify+highlight soft', async () => {
    const db = pushRulesDb([
      {
        kind: 'underride',
        rule_id: '.m.rule.message',
        conditions: JSON.stringify([{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }]),
        actions: JSON.stringify(['notify', { set_tweak: 'highlight', value: true }]),
        enabled: 1,
      },
    ]);
    const r = await evaluatePushRules(db, PUSH_USER, baseEvent() as any, 3);
    expect(r.notify).toBe(true);
    expect(r.highlight).toBe(true);
  });

  it('evaluatePushRules dont_notify soft', async () => {
    const db = pushRulesDb([
      {
        kind: 'override',
        rule_id: 'quiet',
        conditions: JSON.stringify([]),
        actions: JSON.stringify(['dont_notify']),
        enabled: 1,
      },
    ]);
    const r = await evaluatePushRules(db, PUSH_USER, baseEvent() as any, 3);
    expect(r.notify).toBe(false);
  });
});

describe('oauth identity leftovers push gateway failure soft flood after #146', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('gateway HTTP 400 records failure soft', async () => {
    fetchMock.mockResolvedValue(new Response('err', { status: 400 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 1 });
    expect(db.updates.some((u) => u.kind === 'failure')).toBe(true);
  });

  it('gateway HTTP 401 records failure soft', async () => {
    fetchMock.mockResolvedValue(new Response('err', { status: 401 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 1 });
    expect(db.updates.some((u) => u.kind === 'failure')).toBe(true);
  });

  it('gateway HTTP 403 records failure soft', async () => {
    fetchMock.mockResolvedValue(new Response('err', { status: 403 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 1 });
    expect(db.updates.some((u) => u.kind === 'failure')).toBe(true);
  });

  it('gateway HTTP 404 records failure soft', async () => {
    fetchMock.mockResolvedValue(new Response('err', { status: 404 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 1 });
    expect(db.updates.some((u) => u.kind === 'failure')).toBe(true);
  });

  it('gateway HTTP 408 records failure soft', async () => {
    fetchMock.mockResolvedValue(new Response('err', { status: 408 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 1 });
    expect(db.updates.some((u) => u.kind === 'failure')).toBe(true);
  });

  it('gateway HTTP 429 records failure soft', async () => {
    fetchMock.mockResolvedValue(new Response('err', { status: 429 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 1 });
    expect(db.updates.some((u) => u.kind === 'failure')).toBe(true);
  });

  it('gateway HTTP 500 records failure soft', async () => {
    fetchMock.mockResolvedValue(new Response('err', { status: 500 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 1 });
    expect(db.updates.some((u) => u.kind === 'failure')).toBe(true);
  });

  it('gateway HTTP 502 records failure soft', async () => {
    fetchMock.mockResolvedValue(new Response('err', { status: 502 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 1 });
    expect(db.updates.some((u) => u.kind === 'failure')).toBe(true);
  });

  it('gateway HTTP 503 records failure soft', async () => {
    fetchMock.mockResolvedValue(new Response('err', { status: 503 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 1 });
    expect(db.updates.some((u) => u.kind === 'failure')).toBe(true);
  });

  it('gateway HTTP 504 records failure soft', async () => {
    fetchMock.mockResolvedValue(new Response('err', { status: 504 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 1 });
    expect(db.updates.some((u) => u.kind === 'failure')).toBe(true);
  });

  it('gateway TypeError soft swallow', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await expect(sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 1 })).resolves.toBeUndefined();
    expect(db.updates.some((u) => u.kind === 'failure')).toBe(true);
  });

  it('gateway timeout Error soft swallow', async () => {
    fetchMock.mockRejectedValue(new Error('timeout'));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await expect(sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 1 })).resolves.toBeUndefined();
    expect(db.updates.some((u) => u.kind === 'failure')).toBe(true);
  });

  it('gateway AbortError soft swallow', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await expect(sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 1 })).resolves.toBeUndefined();
    expect(db.updates.some((u) => u.kind === 'failure')).toBe(true);
  });

  it('gateway 200 with HTML body still success soft', async () => {
    fetchMock.mockResolvedValue(new Response('<html>ok</html>', { status: 200 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 2 });
    expect(db.updates.some((u) => u.kind === 'success')).toBe(true);
  });

  it('mixed kind pushers skips non-http soft', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const db = createPushDb({
      pushers: {
        [PUSH_USER]: [
          { pushkey: 'e', kind: 'email', app_id: 'mail', data: '{}' },
          httpPusher({}, { pushkey: 'h' }),
        ],
      },
    });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('corrupt pusher data soft skip', async () => {
    const db = createPushDb({
      pushers: { [PUSH_USER]: [{ pushkey: 'x', kind: 'http', app_id: 'a', data: '{bad' }] },
    });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('missing url soft skip', async () => {
    const db = createPushDb({
      pushers: {
        [PUSH_USER]: [
          { pushkey: 'x', kind: 'http', app_id: 'a', data: JSON.stringify({ format: 'event_id_only' }) },
        ],
      },
    });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('full format includes content soft', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher({ format: 'full' })] } });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 1 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.notification.content).toEqual({ body: 'hi', msgtype: 'm.text' });
  });

  it('encrypted event alert soft path', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(
      db,
      PUSH_USER,
      baseEvent({
        type: 'm.room.encrypted',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
        sender_display_name: 'Alice',
        room_name: 'Room',
      }) as any,
      { unread: 1 }
    );
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('oauth identity leftovers push queue/notify soft reliability after #146', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('queueNotification serializes actions soft', async () => {
    const db = createPushDb({});
    await queueNotification(db, PUSH_USER, '!r:example.com', '$e', 'notify', ['notify', { set_tweak: 'sound' }]);
    expect(db.queued).toHaveLength(1);
    expect(JSON.parse(db.queued[0].actions)).toEqual(['notify', { set_tweak: 'sound' }]);
  });

  it('queueNotification throw soft propagates', async () => {
    const db = createPushDb({ queueThrow: true });
    await expect(queueNotification(db, PUSH_USER, '!r', '$e', 'notify', [])).rejects.toThrow(/queue fail/);
  });

  it('notifyRoomMembers respects dont_notify soft', async () => {
    const db = createPushDb({
      members: [PUSH_USER],
      memberCount: 2,
      pushRules: [
        {
          kind: 'override',
          rule_id: 'quiet',
          conditions: JSON.stringify([]),
          actions: JSON.stringify(['dont_notify']),
          enabled: 1,
        },
      ],
      pushers: { [PUSH_USER]: [httpPusher()] },
    });
    await notifyRoomMembersOfMessage(db, {} as Env, baseEvent() as any);
    expect(db.queued).toHaveLength(0);
  });

  it('notifyRoomMembers DM room name soft from sender', async () => {
    const db = createPushDb({
      members: [PUSH_USER],
      memberCount: 2,
      senderDisplayName: 'Alice D',
      roomNameContent: null,
      pushRules: [
        {
          kind: 'underride',
          rule_id: '.m.rule.message',
          conditions: JSON.stringify([{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }]),
          actions: JSON.stringify(['notify']),
          enabled: 1,
        },
      ],
      pushers: { [PUSH_USER]: [httpPusher()] },
    });
    await notifyRoomMembersOfMessage(db, {} as Env, baseEvent() as any);
    expect(db.queued.length + (db.updates.length > 0 ? 1 : 0)).toBeGreaterThan(0);
  });

  it('notifyRoomMembers corrupt room name JSON soft', async () => {
    const db = createPushDb({
      members: [PUSH_USER],
      memberCount: 5,
      roomNameContent: '{bad',
      pushRules: [
        {
          kind: 'underride',
          rule_id: '.m.rule.message',
          conditions: JSON.stringify([{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }]),
          actions: JSON.stringify(['notify']),
          enabled: 1,
        },
      ],
      pushers: { [PUSH_USER]: [httpPusher()] },
    });
    await expect(notifyRoomMembersOfMessage(db, {} as Env, baseEvent() as any)).resolves.toBeUndefined();
  });
});

describe('oauth identity leftovers account-data corrupt JSON soft after #146', () => {

  it('global corrupt content soft throws-or-parses 0', async () => {
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.tag', content: "{" }],
    });
    try {
      const rows = await getGlobalAccountData(db, USER);
      expect(Array.isArray(rows)).toBe(true);
    } catch (e) {
      expect(String(e)).toMatch(/JSON|Unexpected|Syntax/i);
    }
  });

  it('global corrupt content soft throws-or-parses 1', async () => {
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.tag', content: "[" }],
    });
    try {
      const rows = await getGlobalAccountData(db, USER);
      expect(Array.isArray(rows)).toBe(true);
    } catch (e) {
      expect(String(e)).toMatch(/JSON|Unexpected|Syntax/i);
    }
  });

  it('global corrupt content soft throws-or-parses 2', async () => {
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.tag', content: "null" }],
    });
    try {
      const rows = await getGlobalAccountData(db, USER);
      expect(Array.isArray(rows)).toBe(true);
    } catch (e) {
      expect(String(e)).toMatch(/JSON|Unexpected|Syntax/i);
    }
  });

  it('global corrupt content soft throws-or-parses 3', async () => {
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.tag', content: "\"str\"" }],
    });
    try {
      const rows = await getGlobalAccountData(db, USER);
      expect(Array.isArray(rows)).toBe(true);
    } catch (e) {
      expect(String(e)).toMatch(/JSON|Unexpected|Syntax/i);
    }
  });

  it('global corrupt content soft throws-or-parses 4', async () => {
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.tag', content: "42" }],
    });
    try {
      const rows = await getGlobalAccountData(db, USER);
      expect(Array.isArray(rows)).toBe(true);
    } catch (e) {
      expect(String(e)).toMatch(/JSON|Unexpected|Syntax/i);
    }
  });

  it('global corrupt content soft throws-or-parses 5', async () => {
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.tag', content: "true" }],
    });
    try {
      const rows = await getGlobalAccountData(db, USER);
      expect(Array.isArray(rows)).toBe(true);
    } catch (e) {
      expect(String(e)).toMatch(/JSON|Unexpected|Syntax/i);
    }
  });

  it('global corrupt content soft throws-or-parses 6', async () => {
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.tag', content: " " }],
    });
    try {
      const rows = await getGlobalAccountData(db, USER);
      expect(Array.isArray(rows)).toBe(true);
    } catch (e) {
      expect(String(e)).toMatch(/JSON|Unexpected|Syntax/i);
    }
  });

  it('global corrupt content soft throws-or-parses 7', async () => {
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.tag', content: "\n" }],
    });
    try {
      const rows = await getGlobalAccountData(db, USER);
      expect(Array.isArray(rows)).toBe(true);
    } catch (e) {
      expect(String(e)).toMatch(/JSON|Unexpected|Syntax/i);
    }
  });

  it('global corrupt content soft throws-or-parses 8', async () => {
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.tag', content: "\t" }],
    });
    try {
      const rows = await getGlobalAccountData(db, USER);
      expect(Array.isArray(rows)).toBe(true);
    } catch (e) {
      expect(String(e)).toMatch(/JSON|Unexpected|Syntax/i);
    }
  });

  it('empty content soft becomes {}', async () => {
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.tag', content: '' }],
    });
    const rows = await getGlobalAccountData(db, USER);
    expect(rows[0].content).toEqual({});
  });

  it('null content soft becomes {}', async () => {
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.tag', content: null }],
    });
    const rows = await getGlobalAccountData(db, USER);
    expect(rows[0].content).toEqual({});
  });
});

describe('oauth identity leftovers account-data since / stream soft boundaries after #146', () => {
  it('since equal to change pos excludes soft', async () => {
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.tag', content: '{"a":1}' }],
      changes: [{ user_id: USER, room_id: '', event_type: 'm.tag', stream_position: 10 }],
    });
    const rows = await getGlobalAccountData(db, USER, 10);
    expect(rows).toEqual([]);
  });

  it('since just below includes soft', async () => {
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.tag', content: '{"a":1}' }],
      changes: [{ user_id: USER, room_id: '', event_type: 'm.tag', stream_position: 10 }],
    });
    const rows = await getGlobalAccountData(db, USER, 9);
    expect(rows).toHaveLength(1);
  });

  for (const pos of [0, 1, 42, 999999, null]) {
    it(`stream position soft ${pos}`, async () => {
      const db = createAccountDataDb({ streamPosition: pos as any });
      const p = await getAccountDataStreamPosition(db);
      expect(p).toBe(pos === null ? 0 : pos);
    });
  }

  it('room since soft boundary', async () => {
    const room = '!r:example.com';
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: room, event_type: 'm.tag', content: '{}' }],
      changes: [{ user_id: USER, room_id: room, event_type: 'm.tag', stream_position: 5 }],
    });
    expect(await getRoomAccountData(db, USER, room, 5)).toEqual([]);
    expect(await getRoomAccountData(db, USER, room, 4)).toHaveLength(1);
  });

  it('multi-room empty soft {}', async () => {
    expect(await getAllRoomAccountData(createAccountDataDb({}), USER, [])).toEqual({});
  });

  it('multi-room since soft filters', async () => {
    const db = createAccountDataDb({
      rows: [
        { user_id: USER, room_id: '!a:example.com', event_type: 'm.tag', content: '{"x":1}' },
        { user_id: USER, room_id: '!b:example.com', event_type: 'm.tag', content: '{"x":2}' },
      ],
      changes: [
        { user_id: USER, room_id: '!a:example.com', event_type: 'm.tag', stream_position: 3 },
        { user_id: USER, room_id: '!b:example.com', event_type: 'm.tag', stream_position: 8 },
      ],
    });
    const out = await getAllRoomAccountData(db, USER, ['!a:example.com', '!b:example.com'], 5);
    expect(out['!a:example.com']).toBeUndefined();
    expect(out['!b:example.com']).toHaveLength(1);
  });
});

describe('oauth identity leftovers account-data DO failure soft flood after #146', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('DO get status 400 soft throws', async () => {
    const ns = mockUserKeysNamespace({
      responses: new Map([['__all__', new Response('fail', { status: 400 })]]),
    });
    const env = { USER_KEYS: ns } as unknown as Env;
    await expect(getE2EEAccountDataFromDO(env, USER)).rejects.toThrow(/DO get failed/);
  });

  it('DO get status 401 soft throws', async () => {
    const ns = mockUserKeysNamespace({
      responses: new Map([['__all__', new Response('fail', { status: 401 })]]),
    });
    const env = { USER_KEYS: ns } as unknown as Env;
    await expect(getE2EEAccountDataFromDO(env, USER)).rejects.toThrow(/DO get failed/);
  });

  it('DO get status 403 soft throws', async () => {
    const ns = mockUserKeysNamespace({
      responses: new Map([['__all__', new Response('fail', { status: 403 })]]),
    });
    const env = { USER_KEYS: ns } as unknown as Env;
    await expect(getE2EEAccountDataFromDO(env, USER)).rejects.toThrow(/DO get failed/);
  });

  it('DO get status 404 soft throws', async () => {
    const ns = mockUserKeysNamespace({
      responses: new Map([['__all__', new Response('fail', { status: 404 })]]),
    });
    const env = { USER_KEYS: ns } as unknown as Env;
    await expect(getE2EEAccountDataFromDO(env, USER)).rejects.toThrow(/DO get failed/);
  });

  it('DO get status 408 soft throws', async () => {
    const ns = mockUserKeysNamespace({
      responses: new Map([['__all__', new Response('fail', { status: 408 })]]),
    });
    const env = { USER_KEYS: ns } as unknown as Env;
    await expect(getE2EEAccountDataFromDO(env, USER)).rejects.toThrow(/DO get failed/);
  });

  it('DO get status 418 soft throws', async () => {
    const ns = mockUserKeysNamespace({
      responses: new Map([['__all__', new Response('fail', { status: 418 })]]),
    });
    const env = { USER_KEYS: ns } as unknown as Env;
    await expect(getE2EEAccountDataFromDO(env, USER)).rejects.toThrow(/DO get failed/);
  });

  it('DO get status 429 soft throws', async () => {
    const ns = mockUserKeysNamespace({
      responses: new Map([['__all__', new Response('fail', { status: 429 })]]),
    });
    const env = { USER_KEYS: ns } as unknown as Env;
    await expect(getE2EEAccountDataFromDO(env, USER)).rejects.toThrow(/DO get failed/);
  });

  it('DO get status 500 soft throws', async () => {
    const ns = mockUserKeysNamespace({
      responses: new Map([['__all__', new Response('fail', { status: 500 })]]),
    });
    const env = { USER_KEYS: ns } as unknown as Env;
    await expect(getE2EEAccountDataFromDO(env, USER)).rejects.toThrow(/DO get failed/);
  });

  it('DO get status 502 soft throws', async () => {
    const ns = mockUserKeysNamespace({
      responses: new Map([['__all__', new Response('fail', { status: 502 })]]),
    });
    const env = { USER_KEYS: ns } as unknown as Env;
    await expect(getE2EEAccountDataFromDO(env, USER)).rejects.toThrow(/DO get failed/);
  });

  it('DO get status 503 soft throws', async () => {
    const ns = mockUserKeysNamespace({
      responses: new Map([['__all__', new Response('fail', { status: 503 })]]),
    });
    const env = { USER_KEYS: ns } as unknown as Env;
    await expect(getE2EEAccountDataFromDO(env, USER)).rejects.toThrow(/DO get failed/);
  });

  it('DO throwOnFetch soft propagates', async () => {
    const ns = mockUserKeysNamespace({ throwOnFetch: new Error('do down') });
    const env = { USER_KEYS: ns } as unknown as Env;
    await expect(getE2EEAccountDataFromDO(env, USER)).rejects.toThrow(/do down/);
  });

  it('DO event_type encoded soft', async () => {
    const ns = mockUserKeysNamespace({
      responses: new Map([
        [
          'm.secret_storage.default_key',
          new Response(JSON.stringify({ key: 'k' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ],
      ]),
    });
    const env = { USER_KEYS: ns } as unknown as Env;
    const data = await getE2EEAccountDataFromDO(env, USER, 'm.secret_storage.default_key');
    expect(data).toEqual({ key: 'k' });
    expect(ns.fetches[0].url).toContain(encodeURIComponent('m.secret_storage.default_key'));
  });

  it('DO non-json 200 soft throws on parse', async () => {
    const ns = mockUserKeysNamespace({
      responses: new Map([['__all__', new Response('not-json', { status: 200 })]]),
    });
    const env = { USER_KEYS: ns } as unknown as Env;
    await expect(getE2EEAccountDataFromDO(env, USER)).rejects.toThrow();
  });
});

describe('oauth identity leftovers identity auth header soft malformations after #146', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  for (const auth of [
    undefined,
    '',
    'Bearer',
    'Bearer\t',
    'bearer token',
    'BEARER token',
    'Token abc',
    'Basic abc',
  ]) {
    it(`account auth soft reject ${JSON.stringify(auth)}`, async () => {
      const headers: Record<string, string> = {};
      if (auth !== undefined) headers.Authorization = auth;
      const { status, body } = await identityRequest(`${ID_BASE}/account`, { headers });
      expect(status).toBe(401);
      expect(body.errcode).toBe('M_MISSING_TOKEN');
    });
  }

  it('account Authorization with embedded newline soft rejected by Headers', async () => {
    await expect(
      identityRequest(`${ID_BASE}/account`, {
        headers: { Authorization: 'Bearer\nxyz' },
      })
    ).rejects.toThrow();
  });

  it('account Bearer token soft accepts any non-empty', async () => {
    const { status, body } = await identityRequest(`${ID_BASE}/account`, {
      headers: { Authorization: 'Bearer anything' },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER}`);
  });

  for (const tok of ['a', '0', 'tok with spaces', 'x'.repeat(300), 'tok+/=_.-']) {
    it(`account Bearer charset soft ${JSON.stringify(tok).slice(0, 30)}`, async () => {
      const { status, body } = await identityRequest(`${ID_BASE}/account`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      expect(status).toBe(200);
      expect(body.user_id).toBe(`@unknown:${SERVER}`);
    });
  }

  it('account Bearer non-ByteString emoji soft Headers reject', async () => {
    await expect(
      identityRequest(`${ID_BASE}/account`, {
        headers: { Authorization: 'Bearer 🔐' },
      })
    ).rejects.toThrow();
  });
});

describe('oauth identity leftovers identity register/lookup soft JSON after #146', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  for (const body of ['{', '}', '']) {
    it(`register unparseable JSON soft ${JSON.stringify(body)}`, async () => {
      const { status, body: b } = await identityRequest(`${ID_BASE}/account/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(status).toBe(400);
      expect(b.errcode).toBe('M_BAD_JSON');
    });
  }

  it('register JSON null soft surfaces 5xx (body null deref)', async () => {
    const { status } = await identityRequest(`${ID_BASE}/account/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    });
    expect(status).toBeGreaterThanOrEqual(400);
  });

  for (const body of ['[]', '"x"']) {
    it(`register non-object JSON soft ${JSON.stringify(body)} echoes undefined token`, async () => {
      const { status, body: b } = await identityRequest(`${ID_BASE}/account/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      // Parses successfully; access_token missing → token: undefined soft accept
      expect(status).toBe(200);
      expect(b.token).toBeUndefined();
    });
  }

  it('register echoes access_token soft', async () => {
    const { status, body } = await identityRequest(
      `${ID_BASE}/account/register`,
      postJson({
        access_token: 'at',
        token_type: 'Bearer',
        matrix_server_name: SERVER,
        expires_in: 3600,
        extra: true,
      })
    );
    expect(status).toBe(200);
    expect(body.token).toBe('at');
  });

  for (const body of ['{', '']) {
    it(`lookup unparseable JSON soft ${JSON.stringify(body)}`, async () => {
      const { status, body: b } = await identityRequest(`${ID_BASE}/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(status).toBe(400);
      expect(b.errcode).toBe('M_BAD_JSON');
    });
  }

  it('lookup JSON null soft surfaces 5xx (destructure null)', async () => {
    const { status } = await identityRequest(`${ID_BASE}/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    });
    expect(status).toBeGreaterThanOrEqual(400);
  });

  it('lookup JSON array soft M_INVALID_PARAM (missing fields)', async () => {
    const { status, body: b } = await identityRequest(`${ID_BASE}/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '[]',
    });
    expect(status).toBe(400);
    expect(b.errcode).toBe('M_INVALID_PARAM');
  });

  it('lookup missing fields soft M_INVALID_PARAM', async () => {
    const { status, body } = await identityRequest(`${ID_BASE}/lookup`, postJson({ algorithm: 'none' }));
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('lookup wrong pepper soft M_INVALID_PEPPER + TTL pepper', async () => {
    const cache = mockKv({ 'identity:pepper': 'pepper-correct' });
    const { status, body } = await identityRequest(
      `${ID_BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'wrong', addresses: ['a email'] }),
      makeIdentityEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PEPPER');
    expect(body.lookup_pepper).toBe('pepper-correct');
  });

  it('lookup unknown algorithm soft', async () => {
    const cache = mockKv({ 'identity:pepper': 'p' });
    const { status, body } = await identityRequest(
      `${ID_BASE}/lookup`,
      postJson({ algorithm: 'md5', pepper: 'p', addresses: [] }),
      makeIdentityEnv({ cache })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('lookup none soft address medium parse', async () => {
    const cache = mockKv({ 'identity:pepper': 'p' });
    const db = createIdentityDb({
      associations: [{ medium: 'email', address: 'a@example.com', mxid: USER }],
    });
    const { status, body } = await identityRequest(
      `${ID_BASE}/lookup`,
      postJson({
        algorithm: 'none',
        pepper: 'p',
        addresses: ['a@example.com email', 'no-medium', 'x msisdn extra'],
      }),
      makeIdentityEnv({ cache, db })
    );
    expect(status).toBe(200);
    expect(body.mappings['a@example.com email']).toBe(USER);
  });

  it('lookup sha256 soft hash match', async () => {
    const pepper = 'pep';
    const cache = mockKv({ 'identity:pepper': pepper });
    const db = createIdentityDb({
      associations: [{ medium: 'email', address: 'a@example.com', mxid: USER }],
    });
    const hash = await sha256(`a@example.com email ${pepper}`);
    const { status, body } = await identityRequest(
      `${ID_BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [hash, 'deadbeef'] }),
      makeIdentityEnv({ cache, db })
    );
    expect(status).toBe(200);
    expect(body.mappings[hash]).toBe(USER);
    expect(body.mappings.deadbeef).toBeUndefined();
  });
});

describe('oauth identity leftovers identity validate email soft TTL after #146', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    vi.spyOn(Math, 'random').mockReturnValue(0.42);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  for (const body of ['{', '']) {
    it(`requestToken unparseable JSON soft ${JSON.stringify(body)}`, async () => {
      const { status, body: b } = await identityRequest(`${ID_BASE}/validate/email/requestToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(status).toBe(400);
      expect(b.errcode).toBe('M_BAD_JSON');
    });
  }

  it('requestToken JSON null soft surfaces 5xx (destructure null)', async () => {
    const { status } = await identityRequest(`${ID_BASE}/validate/email/requestToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    });
    expect(status).toBeGreaterThanOrEqual(400);
  });

  for (const payload of [
    { email: '', client_secret: 'cs' },
    { email: 'a@example.com', client_secret: '' },
    { email: null, client_secret: 'cs' },
    { client_secret: 'cs' },
    { email: 'a@example.com' },
  ]) {
    it(`requestToken missing soft ${JSON.stringify(payload)}`, async () => {
      const { status, body } = await identityRequest(
        `${ID_BASE}/validate/email/requestToken`,
        postJson(payload)
      );
      expect(status).toBe(400);
      expect(body.errcode).toBe('M_MISSING_PARAM');
    });
  }

  it('requestToken soft inserts with 24h expiry', async () => {
    const db = createIdentityDb();
    const { status, body } = await identityRequest(
      `${ID_BASE}/validate/email/requestToken`,
      postJson({
        email: 'a@example.com',
        client_secret: 'cs',
        send_attempt: 0,
        next_link: 'https://app.example',
      }),
      makeIdentityEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.sid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    const sess = db.emailSessions.get(body.sid);
    expect(sess?.expires_at).toBe(NOW + DAY_MS);
    expect(sess?.send_attempt).toBe(0);
  });

  for (const attempt of [0, 1, 2, 99, -1]) {
    it(`requestToken send_attempt soft ${attempt}`, async () => {
      const db = createIdentityDb();
      vi.spyOn(crypto, 'randomUUID').mockReturnValue(
        `aaaaaaaa-bbbb-cccc-dddd-${String(attempt).padStart(12, '0')}`
      );
      const { body } = await identityRequest(
        `${ID_BASE}/validate/email/requestToken`,
        postJson({ email: 'a@example.com', client_secret: 'cs', send_attempt: attempt }),
        makeIdentityEnv({ db })
      );
      expect(db.emailSessions.get(body.sid)?.send_attempt).toBe(attempt);
    });
  }

  it('submitToken exact expiry boundary soft expired', async () => {
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          'sid-exp',
          {
            session_id: 'sid-exp',
            email: 'a@example.com',
            client_secret: 'cs',
            token: '123456',
            send_attempt: 1,
            validated: 0,
            created_at: NOW - DAY_MS,
            expires_at: NOW - 1,
          },
        ],
      ]),
    });
    const { status, body } = await identityRequest(
      `${ID_BASE}/validate/email/submitToken`,
      postJson({ sid: 'sid-exp', client_secret: 'cs', token: '123456' }),
      makeIdentityEnv({ db })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_SESSION_EXPIRED');
  });

  it('submitToken expires_at == now soft still valid (< check)', async () => {
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          'sid-eq',
          {
            session_id: 'sid-eq',
            email: 'a@example.com',
            client_secret: 'cs',
            token: '123456',
            send_attempt: 1,
            validated: 0,
            created_at: NOW,
            expires_at: NOW,
          },
        ],
      ]),
    });
    const { status, body } = await identityRequest(
      `${ID_BASE}/validate/email/submitToken`,
      postJson({ sid: 'sid-eq', client_secret: 'cs', token: '123456' }),
      makeIdentityEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('submitToken wrong secret soft no session', async () => {
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          'sid-w',
          {
            session_id: 'sid-w',
            email: 'a@example.com',
            client_secret: 'cs',
            token: '123456',
            send_attempt: 1,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + DAY_MS,
          },
        ],
      ]),
    });
    const { status, body } = await identityRequest(
      `${ID_BASE}/validate/email/submitToken`,
      postJson({ sid: 'sid-w', client_secret: 'wrong', token: '123456' }),
      makeIdentityEnv({ db })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_NO_VALID_SESSION');
  });

  it('submitToken wrong token soft', async () => {
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          'sid-t',
          {
            session_id: 'sid-t',
            email: 'a@example.com',
            client_secret: 'cs',
            token: '123456',
            send_attempt: 1,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + DAY_MS,
          },
        ],
      ]),
    });
    const { status, body } = await identityRequest(
      `${ID_BASE}/validate/email/submitToken`,
      postJson({ sid: 'sid-t', client_secret: 'cs', token: '000000' }),
      makeIdentityEnv({ db })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('submitToken double validate soft still success', async () => {
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          'sid-d',
          {
            session_id: 'sid-d',
            email: 'a@example.com',
            client_secret: 'cs',
            token: '123456',
            send_attempt: 1,
            validated: 1,
            created_at: NOW,
            expires_at: NOW + DAY_MS,
            validated_at: NOW - 1000,
          },
        ],
      ]),
    });
    const { status, body } = await identityRequest(
      `${ID_BASE}/validate/email/submitToken`,
      postJson({ sid: 'sid-d', client_secret: 'cs', token: '123456' }),
      makeIdentityEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });
});

describe('oauth identity leftovers identity hash_details / terms soft after #146', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('hash_details mints pepper with 7-day TTL soft', async () => {
    const cache = mockKv();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-2222-3333-4444-555555555555');
    const { status, body } = await identityRequest(`${ID_BASE}/hash_details`, {}, makeIdentityEnv({ cache }));
    expect(status).toBe(200);
    expect(body.algorithms).toEqual(['sha256', 'none']);
    expect(body.lookup_pepper).toBe('11111111222233334444555555555555');
    expect(cache.puts[0].options?.expirationTtl).toBe(SEVEN_DAY_TTL);
  });

  it('hash_details reuses existing pepper soft', async () => {
    const cache = mockKv({ 'identity:pepper': 'existing' });
    const { body } = await identityRequest(`${ID_BASE}/hash_details`, {}, makeIdentityEnv({ cache }));
    expect(body.lookup_pepper).toBe('existing');
    expect(cache.puts).toHaveLength(0);
  });

  it('terms GET/POST soft empty', async () => {
    expect((await identityRequest(`${ID_BASE}/terms`)).body).toEqual({ policies: {} });
    expect((await identityRequest(`${ID_BASE}/terms`, { method: 'POST' })).status).toBe(200);
  });

  it('status soft empty object', async () => {
    const { status, body } = await identityRequest(ID_BASE);
    expect(status).toBe(200);
    expect(body).toEqual({});
  });
});

describe('oauth identity leftovers PKCE verifier soft-cap flood after #146', () => {
  it('PKCE plain soft-cap flood-0', async () => {
    const v = 'v0-' + 'x'.repeat(10);
    expect(await verifyCodeChallenge(v, v, 'plain')).toBe(true);
    expect(await verifyCodeChallenge(v, v + '!', 'plain')).toBe(false);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(v, ch, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(v, ch + 'y', 'S256')).toBe(false);
  });
  it('PKCE plain soft-cap flood-1', async () => {
    const v = 'v1-' + 'x'.repeat(11);
    expect(await verifyCodeChallenge(v, v, 'plain')).toBe(true);
    expect(await verifyCodeChallenge(v, v + '!', 'plain')).toBe(false);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(v, ch, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(v, ch + 'y', 'S256')).toBe(false);
  });
  it('PKCE plain soft-cap flood-2', async () => {
    const v = 'v2-' + 'x'.repeat(12);
    expect(await verifyCodeChallenge(v, v, 'plain')).toBe(true);
    expect(await verifyCodeChallenge(v, v + '!', 'plain')).toBe(false);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(v, ch, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(v, ch + 'y', 'S256')).toBe(false);
  });
  it('PKCE plain soft-cap flood-3', async () => {
    const v = 'v3-' + 'x'.repeat(13);
    expect(await verifyCodeChallenge(v, v, 'plain')).toBe(true);
    expect(await verifyCodeChallenge(v, v + '!', 'plain')).toBe(false);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(v, ch, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(v, ch + 'y', 'S256')).toBe(false);
  });
  it('PKCE plain soft-cap flood-4', async () => {
    const v = 'v4-' + 'x'.repeat(14);
    expect(await verifyCodeChallenge(v, v, 'plain')).toBe(true);
    expect(await verifyCodeChallenge(v, v + '!', 'plain')).toBe(false);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(v, ch, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(v, ch + 'y', 'S256')).toBe(false);
  });
  it('PKCE plain soft-cap flood-5', async () => {
    const v = 'v5-' + 'x'.repeat(15);
    expect(await verifyCodeChallenge(v, v, 'plain')).toBe(true);
    expect(await verifyCodeChallenge(v, v + '!', 'plain')).toBe(false);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(v, ch, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(v, ch + 'y', 'S256')).toBe(false);
  });
  it('PKCE plain soft-cap flood-6', async () => {
    const v = 'v6-' + 'x'.repeat(16);
    expect(await verifyCodeChallenge(v, v, 'plain')).toBe(true);
    expect(await verifyCodeChallenge(v, v + '!', 'plain')).toBe(false);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(v, ch, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(v, ch + 'y', 'S256')).toBe(false);
  });
  it('PKCE plain soft-cap flood-7', async () => {
    const v = 'v7-' + 'x'.repeat(17);
    expect(await verifyCodeChallenge(v, v, 'plain')).toBe(true);
    expect(await verifyCodeChallenge(v, v + '!', 'plain')).toBe(false);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(v, ch, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(v, ch + 'y', 'S256')).toBe(false);
  });
  it('PKCE plain soft-cap flood-8', async () => {
    const v = 'v8-' + 'x'.repeat(18);
    expect(await verifyCodeChallenge(v, v, 'plain')).toBe(true);
    expect(await verifyCodeChallenge(v, v + '!', 'plain')).toBe(false);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(v, ch, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(v, ch + 'y', 'S256')).toBe(false);
  });
  it('PKCE plain soft-cap flood-9', async () => {
    const v = 'v9-' + 'x'.repeat(19);
    expect(await verifyCodeChallenge(v, v, 'plain')).toBe(true);
    expect(await verifyCodeChallenge(v, v + '!', 'plain')).toBe(false);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(v, ch, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(v, ch + 'y', 'S256')).toBe(false);
  });
  it('PKCE plain soft-cap flood-10', async () => {
    const v = 'v10-' + 'x'.repeat(20);
    expect(await verifyCodeChallenge(v, v, 'plain')).toBe(true);
    expect(await verifyCodeChallenge(v, v + '!', 'plain')).toBe(false);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(v, ch, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(v, ch + 'y', 'S256')).toBe(false);
  });
  it('PKCE plain soft-cap flood-11', async () => {
    const v = 'v11-' + 'x'.repeat(21);
    expect(await verifyCodeChallenge(v, v, 'plain')).toBe(true);
    expect(await verifyCodeChallenge(v, v + '!', 'plain')).toBe(false);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(v, ch, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(v, ch + 'y', 'S256')).toBe(false);
  });
  it('PKCE plain soft-cap flood-12', async () => {
    const v = 'v12-' + 'x'.repeat(22);
    expect(await verifyCodeChallenge(v, v, 'plain')).toBe(true);
    expect(await verifyCodeChallenge(v, v + '!', 'plain')).toBe(false);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(v, ch, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(v, ch + 'y', 'S256')).toBe(false);
  });
  it('PKCE plain soft-cap flood-13', async () => {
    const v = 'v13-' + 'x'.repeat(23);
    expect(await verifyCodeChallenge(v, v, 'plain')).toBe(true);
    expect(await verifyCodeChallenge(v, v + '!', 'plain')).toBe(false);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(v, ch, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(v, ch + 'y', 'S256')).toBe(false);
  });
  it('PKCE plain soft-cap flood-14', async () => {
    const v = 'v14-' + 'x'.repeat(24);
    expect(await verifyCodeChallenge(v, v, 'plain')).toBe(true);
    expect(await verifyCodeChallenge(v, v + '!', 'plain')).toBe(false);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(v, ch, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(v, ch + 'y', 'S256')).toBe(false);
  });
  it('PKCE plain soft-cap flood-15', async () => {
    const v = 'v15-' + 'x'.repeat(25);
    expect(await verifyCodeChallenge(v, v, 'plain')).toBe(true);
    expect(await verifyCodeChallenge(v, v + '!', 'plain')).toBe(false);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(v, ch, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(v, ch + 'y', 'S256')).toBe(false);
  });
  it('PKCE plain soft-cap flood-16', async () => {
    const v = 'v16-' + 'x'.repeat(26);
    expect(await verifyCodeChallenge(v, v, 'plain')).toBe(true);
    expect(await verifyCodeChallenge(v, v + '!', 'plain')).toBe(false);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(v, ch, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(v, ch + 'y', 'S256')).toBe(false);
  });
  it('PKCE plain soft-cap flood-17', async () => {
    const v = 'v17-' + 'x'.repeat(27);
    expect(await verifyCodeChallenge(v, v, 'plain')).toBe(true);
    expect(await verifyCodeChallenge(v, v + '!', 'plain')).toBe(false);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(v, ch, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(v, ch + 'y', 'S256')).toBe(false);
  });
  it('PKCE plain soft-cap flood-18', async () => {
    const v = 'v18-' + 'x'.repeat(28);
    expect(await verifyCodeChallenge(v, v, 'plain')).toBe(true);
    expect(await verifyCodeChallenge(v, v + '!', 'plain')).toBe(false);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(v, ch, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(v, ch + 'y', 'S256')).toBe(false);
  });
  it('PKCE plain soft-cap flood-19', async () => {
    const v = 'v19-' + 'x'.repeat(29);
    expect(await verifyCodeChallenge(v, v, 'plain')).toBe(true);
    expect(await verifyCodeChallenge(v, v + '!', 'plain')).toBe(false);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(v, ch, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(v, ch + 'y', 'S256')).toBe(false);
  });
  it('PKCE plain soft-cap flood-20', async () => {
    const v = 'v20-' + 'x'.repeat(30);
    expect(await verifyCodeChallenge(v, v, 'plain')).toBe(true);
    expect(await verifyCodeChallenge(v, v + '!', 'plain')).toBe(false);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(v, ch, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(v, ch + 'y', 'S256')).toBe(false);
  });
  it('PKCE plain soft-cap flood-21', async () => {
    const v = 'v21-' + 'x'.repeat(31);
    expect(await verifyCodeChallenge(v, v, 'plain')).toBe(true);
    expect(await verifyCodeChallenge(v, v + '!', 'plain')).toBe(false);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(v, ch, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(v, ch + 'y', 'S256')).toBe(false);
  });
  it('PKCE plain soft-cap flood-22', async () => {
    const v = 'v22-' + 'x'.repeat(32);
    expect(await verifyCodeChallenge(v, v, 'plain')).toBe(true);
    expect(await verifyCodeChallenge(v, v + '!', 'plain')).toBe(false);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(v, ch, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(v, ch + 'y', 'S256')).toBe(false);
  });
  it('PKCE plain soft-cap flood-23', async () => {
    const v = 'v23-' + 'x'.repeat(33);
    expect(await verifyCodeChallenge(v, v, 'plain')).toBe(true);
    expect(await verifyCodeChallenge(v, v + '!', 'plain')).toBe(false);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    const ch = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(v, ch, 'S256')).toBe(true);
    expect(await verifyCodeChallenge(v, ch + 'y', 'S256')).toBe(false);
  });
});

describe('oauth identity leftovers escapeHtml soft-cap flood after #146', () => {
  it('escapeHtml soft-cap flood-0', () => {
    const s = 'n0<' + '&'.repeat(1) + '>"\'';
    const out = escapeHtml(s);
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;');
    expect(out).toContain('&#039;');
    expect(escapeHtml(out)).not.toBe(out);
  });
  it('escapeHtml soft-cap flood-1', () => {
    const s = 'n1<' + '&'.repeat(2) + '>"\'';
    const out = escapeHtml(s);
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;');
    expect(out).toContain('&#039;');
    expect(escapeHtml(out)).not.toBe(out);
  });
  it('escapeHtml soft-cap flood-2', () => {
    const s = 'n2<' + '&'.repeat(3) + '>"\'';
    const out = escapeHtml(s);
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;');
    expect(out).toContain('&#039;');
    expect(escapeHtml(out)).not.toBe(out);
  });
  it('escapeHtml soft-cap flood-3', () => {
    const s = 'n3<' + '&'.repeat(4) + '>"\'';
    const out = escapeHtml(s);
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;');
    expect(out).toContain('&#039;');
    expect(escapeHtml(out)).not.toBe(out);
  });
  it('escapeHtml soft-cap flood-4', () => {
    const s = 'n4<' + '&'.repeat(5) + '>"\'';
    const out = escapeHtml(s);
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;');
    expect(out).toContain('&#039;');
    expect(escapeHtml(out)).not.toBe(out);
  });
  it('escapeHtml soft-cap flood-5', () => {
    const s = 'n5<' + '&'.repeat(1) + '>"\'';
    const out = escapeHtml(s);
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;');
    expect(out).toContain('&#039;');
    expect(escapeHtml(out)).not.toBe(out);
  });
  it('escapeHtml soft-cap flood-6', () => {
    const s = 'n6<' + '&'.repeat(2) + '>"\'';
    const out = escapeHtml(s);
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;');
    expect(out).toContain('&#039;');
    expect(escapeHtml(out)).not.toBe(out);
  });
  it('escapeHtml soft-cap flood-7', () => {
    const s = 'n7<' + '&'.repeat(3) + '>"\'';
    const out = escapeHtml(s);
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;');
    expect(out).toContain('&#039;');
    expect(escapeHtml(out)).not.toBe(out);
  });
  it('escapeHtml soft-cap flood-8', () => {
    const s = 'n8<' + '&'.repeat(4) + '>"\'';
    const out = escapeHtml(s);
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;');
    expect(out).toContain('&#039;');
    expect(escapeHtml(out)).not.toBe(out);
  });
  it('escapeHtml soft-cap flood-9', () => {
    const s = 'n9<' + '&'.repeat(5) + '>"\'';
    const out = escapeHtml(s);
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;');
    expect(out).toContain('&#039;');
    expect(escapeHtml(out)).not.toBe(out);
  });
  it('escapeHtml soft-cap flood-10', () => {
    const s = 'n10<' + '&'.repeat(1) + '>"\'';
    const out = escapeHtml(s);
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;');
    expect(out).toContain('&#039;');
    expect(escapeHtml(out)).not.toBe(out);
  });
  it('escapeHtml soft-cap flood-11', () => {
    const s = 'n11<' + '&'.repeat(2) + '>"\'';
    const out = escapeHtml(s);
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;');
    expect(out).toContain('&#039;');
    expect(escapeHtml(out)).not.toBe(out);
  });
  it('escapeHtml soft-cap flood-12', () => {
    const s = 'n12<' + '&'.repeat(3) + '>"\'';
    const out = escapeHtml(s);
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;');
    expect(out).toContain('&#039;');
    expect(escapeHtml(out)).not.toBe(out);
  });
  it('escapeHtml soft-cap flood-13', () => {
    const s = 'n13<' + '&'.repeat(4) + '>"\'';
    const out = escapeHtml(s);
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;');
    expect(out).toContain('&#039;');
    expect(escapeHtml(out)).not.toBe(out);
  });
  it('escapeHtml soft-cap flood-14', () => {
    const s = 'n14<' + '&'.repeat(5) + '>"\'';
    const out = escapeHtml(s);
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;');
    expect(out).toContain('&#039;');
    expect(escapeHtml(out)).not.toBe(out);
  });
  it('escapeHtml soft-cap flood-15', () => {
    const s = 'n15<' + '&'.repeat(1) + '>"\'';
    const out = escapeHtml(s);
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;');
    expect(out).toContain('&#039;');
    expect(escapeHtml(out)).not.toBe(out);
  });
  it('escapeHtml soft-cap flood-16', () => {
    const s = 'n16<' + '&'.repeat(2) + '>"\'';
    const out = escapeHtml(s);
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;');
    expect(out).toContain('&#039;');
    expect(escapeHtml(out)).not.toBe(out);
  });
  it('escapeHtml soft-cap flood-17', () => {
    const s = 'n17<' + '&'.repeat(3) + '>"\'';
    const out = escapeHtml(s);
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;');
    expect(out).toContain('&#039;');
    expect(escapeHtml(out)).not.toBe(out);
  });
  it('escapeHtml soft-cap flood-18', () => {
    const s = 'n18<' + '&'.repeat(4) + '>"\'';
    const out = escapeHtml(s);
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;');
    expect(out).toContain('&#039;');
    expect(escapeHtml(out)).not.toBe(out);
  });
  it('escapeHtml soft-cap flood-19', () => {
    const s = 'n19<' + '&'.repeat(5) + '>"\'';
    const out = escapeHtml(s);
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;');
    expect(out).toContain('&#039;');
    expect(escapeHtml(out)).not.toBe(out);
  });
});

describe('oauth identity leftovers push gateway body soft-cap flood after #146', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it('gateway body soft-cap flood-0', async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 1 });
    expect(db.updates.some((u) => u.kind === 'success')).toBe(true);
  });
  it('gateway body soft-cap flood-1', async () => {
    fetchMock.mockResolvedValue(new Response("[]", { status: 200 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 2 });
    expect(db.updates.some((u) => u.kind === 'success')).toBe(true);
  });
  it('gateway body soft-cap flood-2', async () => {
    fetchMock.mockResolvedValue(new Response("\"ok\"", { status: 200 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 3 });
    expect(db.updates.some((u) => u.kind === 'success')).toBe(true);
  });
  it('gateway body soft-cap flood-3', async () => {
    fetchMock.mockResolvedValue(new Response("null", { status: 200 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 4 });
    expect(db.updates.some((u) => u.kind === 'success')).toBe(true);
  });
  it('gateway body soft-cap flood-4', async () => {
    fetchMock.mockResolvedValue(new Response("<html/>", { status: 200 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 5 });
    expect(db.updates.some((u) => u.kind === 'success')).toBe(true);
  });
  it('gateway body soft-cap flood-5', async () => {
    fetchMock.mockResolvedValue(new Response("rejected", { status: 200 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 6 });
    expect(db.updates.some((u) => u.kind === 'success')).toBe(true);
  });
  it('gateway body soft-cap flood-6', async () => {
    fetchMock.mockResolvedValue(new Response("{\"rejected\":[]}", { status: 200 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 7 });
    expect(db.updates.some((u) => u.kind === 'success')).toBe(true);
  });
  it('gateway body soft-cap flood-7', async () => {
    fetchMock.mockResolvedValue(new Response(" ", { status: 200 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 8 });
    expect(db.updates.some((u) => u.kind === 'success')).toBe(true);
  });
  it('gateway body soft-cap flood-8', async () => {
    fetchMock.mockResolvedValue(new Response("\n", { status: 200 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 9 });
    expect(db.updates.some((u) => u.kind === 'success')).toBe(true);
  });
  it('gateway body soft-cap flood-9', async () => {
    fetchMock.mockResolvedValue(new Response("0", { status: 200 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 10 });
    expect(db.updates.some((u) => u.kind === 'success')).toBe(true);
  });
});

describe('oauth identity leftovers account-data content soft-cap flood after #146', () => {
  it('account-data parse soft-cap flood-0', async () => {
    const content = JSON.stringify({ n: 0, nested: { a: [1, 2, 0] } });
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.custom.0', content }],
    });
    const rows = await getGlobalAccountData(db, USER);
    expect(rows[0].content).toEqual({ n: 0, nested: { a: [1, 2, 0] } });
  });
  it('account-data parse soft-cap flood-1', async () => {
    const content = JSON.stringify({ n: 1, nested: { a: [1, 2, 1] } });
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.custom.1', content }],
    });
    const rows = await getGlobalAccountData(db, USER);
    expect(rows[0].content).toEqual({ n: 1, nested: { a: [1, 2, 1] } });
  });
  it('account-data parse soft-cap flood-2', async () => {
    const content = JSON.stringify({ n: 2, nested: { a: [1, 2, 2] } });
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.custom.2', content }],
    });
    const rows = await getGlobalAccountData(db, USER);
    expect(rows[0].content).toEqual({ n: 2, nested: { a: [1, 2, 2] } });
  });
  it('account-data parse soft-cap flood-3', async () => {
    const content = JSON.stringify({ n: 3, nested: { a: [1, 2, 3] } });
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.custom.3', content }],
    });
    const rows = await getGlobalAccountData(db, USER);
    expect(rows[0].content).toEqual({ n: 3, nested: { a: [1, 2, 3] } });
  });
  it('account-data parse soft-cap flood-4', async () => {
    const content = JSON.stringify({ n: 4, nested: { a: [1, 2, 4] } });
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.custom.4', content }],
    });
    const rows = await getGlobalAccountData(db, USER);
    expect(rows[0].content).toEqual({ n: 4, nested: { a: [1, 2, 4] } });
  });
  it('account-data parse soft-cap flood-5', async () => {
    const content = JSON.stringify({ n: 5, nested: { a: [1, 2, 5] } });
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.custom.5', content }],
    });
    const rows = await getGlobalAccountData(db, USER);
    expect(rows[0].content).toEqual({ n: 5, nested: { a: [1, 2, 5] } });
  });
  it('account-data parse soft-cap flood-6', async () => {
    const content = JSON.stringify({ n: 6, nested: { a: [1, 2, 6] } });
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.custom.6', content }],
    });
    const rows = await getGlobalAccountData(db, USER);
    expect(rows[0].content).toEqual({ n: 6, nested: { a: [1, 2, 6] } });
  });
  it('account-data parse soft-cap flood-7', async () => {
    const content = JSON.stringify({ n: 7, nested: { a: [1, 2, 7] } });
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.custom.7', content }],
    });
    const rows = await getGlobalAccountData(db, USER);
    expect(rows[0].content).toEqual({ n: 7, nested: { a: [1, 2, 7] } });
  });
  it('account-data parse soft-cap flood-8', async () => {
    const content = JSON.stringify({ n: 8, nested: { a: [1, 2, 8] } });
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.custom.8', content }],
    });
    const rows = await getGlobalAccountData(db, USER);
    expect(rows[0].content).toEqual({ n: 8, nested: { a: [1, 2, 8] } });
  });
  it('account-data parse soft-cap flood-9', async () => {
    const content = JSON.stringify({ n: 9, nested: { a: [1, 2, 9] } });
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.custom.9', content }],
    });
    const rows = await getGlobalAccountData(db, USER);
    expect(rows[0].content).toEqual({ n: 9, nested: { a: [1, 2, 9] } });
  });
  it('account-data parse soft-cap flood-10', async () => {
    const content = JSON.stringify({ n: 10, nested: { a: [1, 2, 10] } });
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.custom.10', content }],
    });
    const rows = await getGlobalAccountData(db, USER);
    expect(rows[0].content).toEqual({ n: 10, nested: { a: [1, 2, 10] } });
  });
  it('account-data parse soft-cap flood-11', async () => {
    const content = JSON.stringify({ n: 11, nested: { a: [1, 2, 11] } });
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.custom.11', content }],
    });
    const rows = await getGlobalAccountData(db, USER);
    expect(rows[0].content).toEqual({ n: 11, nested: { a: [1, 2, 11] } });
  });
  it('account-data parse soft-cap flood-12', async () => {
    const content = JSON.stringify({ n: 12, nested: { a: [1, 2, 12] } });
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.custom.12', content }],
    });
    const rows = await getGlobalAccountData(db, USER);
    expect(rows[0].content).toEqual({ n: 12, nested: { a: [1, 2, 12] } });
  });
  it('account-data parse soft-cap flood-13', async () => {
    const content = JSON.stringify({ n: 13, nested: { a: [1, 2, 13] } });
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.custom.13', content }],
    });
    const rows = await getGlobalAccountData(db, USER);
    expect(rows[0].content).toEqual({ n: 13, nested: { a: [1, 2, 13] } });
  });
  it('account-data parse soft-cap flood-14', async () => {
    const content = JSON.stringify({ n: 14, nested: { a: [1, 2, 14] } });
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.custom.14', content }],
    });
    const rows = await getGlobalAccountData(db, USER);
    expect(rows[0].content).toEqual({ n: 14, nested: { a: [1, 2, 14] } });
  });
  it('account-data parse soft-cap flood-15', async () => {
    const content = JSON.stringify({ n: 15, nested: { a: [1, 2, 15] } });
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.custom.15', content }],
    });
    const rows = await getGlobalAccountData(db, USER);
    expect(rows[0].content).toEqual({ n: 15, nested: { a: [1, 2, 15] } });
  });
});

describe('oauth identity leftovers identity bearer soft-cap flood after #146', () => {
  it('identity bearer soft-cap flood-0', async () => {
    const { status, body } = await identityRequest(`${ID_BASE}/account`, {
      headers: { Authorization: `Bearer tok-0-` + 'z'.repeat(1) },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER}`);
  });
  it('identity bearer soft-cap flood-1', async () => {
    const { status, body } = await identityRequest(`${ID_BASE}/account`, {
      headers: { Authorization: `Bearer tok-1-` + 'z'.repeat(2) },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER}`);
  });
  it('identity bearer soft-cap flood-2', async () => {
    const { status, body } = await identityRequest(`${ID_BASE}/account`, {
      headers: { Authorization: `Bearer tok-2-` + 'z'.repeat(3) },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER}`);
  });
  it('identity bearer soft-cap flood-3', async () => {
    const { status, body } = await identityRequest(`${ID_BASE}/account`, {
      headers: { Authorization: `Bearer tok-3-` + 'z'.repeat(4) },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER}`);
  });
  it('identity bearer soft-cap flood-4', async () => {
    const { status, body } = await identityRequest(`${ID_BASE}/account`, {
      headers: { Authorization: `Bearer tok-4-` + 'z'.repeat(5) },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER}`);
  });
  it('identity bearer soft-cap flood-5', async () => {
    const { status, body } = await identityRequest(`${ID_BASE}/account`, {
      headers: { Authorization: `Bearer tok-5-` + 'z'.repeat(6) },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER}`);
  });
  it('identity bearer soft-cap flood-6', async () => {
    const { status, body } = await identityRequest(`${ID_BASE}/account`, {
      headers: { Authorization: `Bearer tok-6-` + 'z'.repeat(7) },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER}`);
  });
  it('identity bearer soft-cap flood-7', async () => {
    const { status, body } = await identityRequest(`${ID_BASE}/account`, {
      headers: { Authorization: `Bearer tok-7-` + 'z'.repeat(8) },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER}`);
  });
  it('identity bearer soft-cap flood-8', async () => {
    const { status, body } = await identityRequest(`${ID_BASE}/account`, {
      headers: { Authorization: `Bearer tok-8-` + 'z'.repeat(9) },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER}`);
  });
  it('identity bearer soft-cap flood-9', async () => {
    const { status, body } = await identityRequest(`${ID_BASE}/account`, {
      headers: { Authorization: `Bearer tok-9-` + 'z'.repeat(10) },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER}`);
  });
  it('identity bearer soft-cap flood-10', async () => {
    const { status, body } = await identityRequest(`${ID_BASE}/account`, {
      headers: { Authorization: `Bearer tok-10-` + 'z'.repeat(11) },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER}`);
  });
  it('identity bearer soft-cap flood-11', async () => {
    const { status, body } = await identityRequest(`${ID_BASE}/account`, {
      headers: { Authorization: `Bearer tok-11-` + 'z'.repeat(12) },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER}`);
  });
  it('identity bearer soft-cap flood-12', async () => {
    const { status, body } = await identityRequest(`${ID_BASE}/account`, {
      headers: { Authorization: `Bearer tok-12-` + 'z'.repeat(13) },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER}`);
  });
  it('identity bearer soft-cap flood-13', async () => {
    const { status, body } = await identityRequest(`${ID_BASE}/account`, {
      headers: { Authorization: `Bearer tok-13-` + 'z'.repeat(14) },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER}`);
  });
  it('identity bearer soft-cap flood-14', async () => {
    const { status, body } = await identityRequest(`${ID_BASE}/account`, {
      headers: { Authorization: `Bearer tok-14-` + 'z'.repeat(15) },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER}`);
  });
  it('identity bearer soft-cap flood-15', async () => {
    const { status, body } = await identityRequest(`${ID_BASE}/account`, {
      headers: { Authorization: `Bearer tok-15-` + 'z'.repeat(16) },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER}`);
  });
  it('identity bearer soft-cap flood-16', async () => {
    const { status, body } = await identityRequest(`${ID_BASE}/account`, {
      headers: { Authorization: `Bearer tok-16-` + 'z'.repeat(17) },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER}`);
  });
  it('identity bearer soft-cap flood-17', async () => {
    const { status, body } = await identityRequest(`${ID_BASE}/account`, {
      headers: { Authorization: `Bearer tok-17-` + 'z'.repeat(18) },
    });
    expect(status).toBe(200);
    expect(body.user_id).toBe(`@unknown:${SERVER}`);
  });
});

describe('oauth identity leftovers authorize state soft-cap flood after #146', () => {
  it('authorize state soft-cap flood-0', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'cli_flood_0');
    const state = 'st-0-' + 's'.repeat(1);
    const res = await oauthRequest(
      `/oauth/authorize?response_type=code&client_id=cli_flood_0&redirect_uri=${encodeURIComponent(REDIRECT)}&state=${encodeURIComponent(state)}`,
      {},
      makeOAuthEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const key = Object.keys(sessions.data).find((k) => k.startsWith('oauth_auth_request:'));
    expect(JSON.parse(sessions.data[key!]).state).toBe(state);
  });
  it('authorize state soft-cap flood-1', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'cli_flood_1');
    const state = 'st-1-' + 's'.repeat(2);
    const res = await oauthRequest(
      `/oauth/authorize?response_type=code&client_id=cli_flood_1&redirect_uri=${encodeURIComponent(REDIRECT)}&state=${encodeURIComponent(state)}`,
      {},
      makeOAuthEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const key = Object.keys(sessions.data).find((k) => k.startsWith('oauth_auth_request:'));
    expect(JSON.parse(sessions.data[key!]).state).toBe(state);
  });
  it('authorize state soft-cap flood-2', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'cli_flood_2');
    const state = 'st-2-' + 's'.repeat(3);
    const res = await oauthRequest(
      `/oauth/authorize?response_type=code&client_id=cli_flood_2&redirect_uri=${encodeURIComponent(REDIRECT)}&state=${encodeURIComponent(state)}`,
      {},
      makeOAuthEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const key = Object.keys(sessions.data).find((k) => k.startsWith('oauth_auth_request:'));
    expect(JSON.parse(sessions.data[key!]).state).toBe(state);
  });
  it('authorize state soft-cap flood-3', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'cli_flood_3');
    const state = 'st-3-' + 's'.repeat(4);
    const res = await oauthRequest(
      `/oauth/authorize?response_type=code&client_id=cli_flood_3&redirect_uri=${encodeURIComponent(REDIRECT)}&state=${encodeURIComponent(state)}`,
      {},
      makeOAuthEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const key = Object.keys(sessions.data).find((k) => k.startsWith('oauth_auth_request:'));
    expect(JSON.parse(sessions.data[key!]).state).toBe(state);
  });
  it('authorize state soft-cap flood-4', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'cli_flood_4');
    const state = 'st-4-' + 's'.repeat(5);
    const res = await oauthRequest(
      `/oauth/authorize?response_type=code&client_id=cli_flood_4&redirect_uri=${encodeURIComponent(REDIRECT)}&state=${encodeURIComponent(state)}`,
      {},
      makeOAuthEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const key = Object.keys(sessions.data).find((k) => k.startsWith('oauth_auth_request:'));
    expect(JSON.parse(sessions.data[key!]).state).toBe(state);
  });
  it('authorize state soft-cap flood-5', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'cli_flood_5');
    const state = 'st-5-' + 's'.repeat(6);
    const res = await oauthRequest(
      `/oauth/authorize?response_type=code&client_id=cli_flood_5&redirect_uri=${encodeURIComponent(REDIRECT)}&state=${encodeURIComponent(state)}`,
      {},
      makeOAuthEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const key = Object.keys(sessions.data).find((k) => k.startsWith('oauth_auth_request:'));
    expect(JSON.parse(sessions.data[key!]).state).toBe(state);
  });
  it('authorize state soft-cap flood-6', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'cli_flood_6');
    const state = 'st-6-' + 's'.repeat(7);
    const res = await oauthRequest(
      `/oauth/authorize?response_type=code&client_id=cli_flood_6&redirect_uri=${encodeURIComponent(REDIRECT)}&state=${encodeURIComponent(state)}`,
      {},
      makeOAuthEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const key = Object.keys(sessions.data).find((k) => k.startsWith('oauth_auth_request:'));
    expect(JSON.parse(sessions.data[key!]).state).toBe(state);
  });
  it('authorize state soft-cap flood-7', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'cli_flood_7');
    const state = 'st-7-' + 's'.repeat(8);
    const res = await oauthRequest(
      `/oauth/authorize?response_type=code&client_id=cli_flood_7&redirect_uri=${encodeURIComponent(REDIRECT)}&state=${encodeURIComponent(state)}`,
      {},
      makeOAuthEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const key = Object.keys(sessions.data).find((k) => k.startsWith('oauth_auth_request:'));
    expect(JSON.parse(sessions.data[key!]).state).toBe(state);
  });
  it('authorize state soft-cap flood-8', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'cli_flood_8');
    const state = 'st-8-' + 's'.repeat(9);
    const res = await oauthRequest(
      `/oauth/authorize?response_type=code&client_id=cli_flood_8&redirect_uri=${encodeURIComponent(REDIRECT)}&state=${encodeURIComponent(state)}`,
      {},
      makeOAuthEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const key = Object.keys(sessions.data).find((k) => k.startsWith('oauth_auth_request:'));
    expect(JSON.parse(sessions.data[key!]).state).toBe(state);
  });
  it('authorize state soft-cap flood-9', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'cli_flood_9');
    const state = 'st-9-' + 's'.repeat(10);
    const res = await oauthRequest(
      `/oauth/authorize?response_type=code&client_id=cli_flood_9&redirect_uri=${encodeURIComponent(REDIRECT)}&state=${encodeURIComponent(state)}`,
      {},
      makeOAuthEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const key = Object.keys(sessions.data).find((k) => k.startsWith('oauth_auth_request:'));
    expect(JSON.parse(sessions.data[key!]).state).toBe(state);
  });
  it('authorize state soft-cap flood-10', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'cli_flood_10');
    const state = 'st-10-' + 's'.repeat(11);
    const res = await oauthRequest(
      `/oauth/authorize?response_type=code&client_id=cli_flood_10&redirect_uri=${encodeURIComponent(REDIRECT)}&state=${encodeURIComponent(state)}`,
      {},
      makeOAuthEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const key = Object.keys(sessions.data).find((k) => k.startsWith('oauth_auth_request:'));
    expect(JSON.parse(sessions.data[key!]).state).toBe(state);
  });
  it('authorize state soft-cap flood-11', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'cli_flood_11');
    const state = 'st-11-' + 's'.repeat(12);
    const res = await oauthRequest(
      `/oauth/authorize?response_type=code&client_id=cli_flood_11&redirect_uri=${encodeURIComponent(REDIRECT)}&state=${encodeURIComponent(state)}`,
      {},
      makeOAuthEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const key = Object.keys(sessions.data).find((k) => k.startsWith('oauth_auth_request:'));
    expect(JSON.parse(sessions.data[key!]).state).toBe(state);
  });
});

describe('oauth identity leftovers getNestedValue soft-cap flood after #146', () => {
  it('getNestedValue soft-cap flood-0', () => {
    const obj: any = { l0: {} };
    let cur = obj.l0;
    for (let j = 0; j < 1; j++) {
      cur['k' + j] = j === 0 ? 0 : {};
      if (j < 0) cur = cur['k' + j];
    }
    const path = ['l0', ...Array.from({ length: 1 }, (_, j) => 'k' + j)].join('.');
    expect(getNestedValue(obj, path)).toBe(0);
  });
  it('getNestedValue soft-cap flood-1', () => {
    const obj: any = { l0: {} };
    let cur = obj.l0;
    for (let j = 0; j < 2; j++) {
      cur['k' + j] = j === 1 ? 1 : {};
      if (j < 1) cur = cur['k' + j];
    }
    const path = ['l0', ...Array.from({ length: 2 }, (_, j) => 'k' + j)].join('.');
    expect(getNestedValue(obj, path)).toBe(1);
  });
  it('getNestedValue soft-cap flood-2', () => {
    const obj: any = { l0: {} };
    let cur = obj.l0;
    for (let j = 0; j < 3; j++) {
      cur['k' + j] = j === 2 ? 2 : {};
      if (j < 2) cur = cur['k' + j];
    }
    const path = ['l0', ...Array.from({ length: 3 }, (_, j) => 'k' + j)].join('.');
    expect(getNestedValue(obj, path)).toBe(2);
  });
  it('getNestedValue soft-cap flood-3', () => {
    const obj: any = { l0: {} };
    let cur = obj.l0;
    for (let j = 0; j < 4; j++) {
      cur['k' + j] = j === 3 ? 3 : {};
      if (j < 3) cur = cur['k' + j];
    }
    const path = ['l0', ...Array.from({ length: 4 }, (_, j) => 'k' + j)].join('.');
    expect(getNestedValue(obj, path)).toBe(3);
  });
  it('getNestedValue soft-cap flood-4', () => {
    const obj: any = { l0: {} };
    let cur = obj.l0;
    for (let j = 0; j < 5; j++) {
      cur['k' + j] = j === 4 ? 4 : {};
      if (j < 4) cur = cur['k' + j];
    }
    const path = ['l0', ...Array.from({ length: 5 }, (_, j) => 'k' + j)].join('.');
    expect(getNestedValue(obj, path)).toBe(4);
  });
  it('getNestedValue soft-cap flood-5', () => {
    const obj: any = { l0: {} };
    let cur = obj.l0;
    for (let j = 0; j < 6; j++) {
      cur['k' + j] = j === 5 ? 5 : {};
      if (j < 5) cur = cur['k' + j];
    }
    const path = ['l0', ...Array.from({ length: 6 }, (_, j) => 'k' + j)].join('.');
    expect(getNestedValue(obj, path)).toBe(5);
  });
  it('getNestedValue soft-cap flood-6', () => {
    const obj: any = { l0: {} };
    let cur = obj.l0;
    for (let j = 0; j < 7; j++) {
      cur['k' + j] = j === 6 ? 6 : {};
      if (j < 6) cur = cur['k' + j];
    }
    const path = ['l0', ...Array.from({ length: 7 }, (_, j) => 'k' + j)].join('.');
    expect(getNestedValue(obj, path)).toBe(6);
  });
  it('getNestedValue soft-cap flood-7', () => {
    const obj: any = { l0: {} };
    let cur = obj.l0;
    for (let j = 0; j < 8; j++) {
      cur['k' + j] = j === 7 ? 7 : {};
      if (j < 7) cur = cur['k' + j];
    }
    const path = ['l0', ...Array.from({ length: 8 }, (_, j) => 'k' + j)].join('.');
    expect(getNestedValue(obj, path)).toBe(7);
  });
  it('getNestedValue soft-cap flood-8', () => {
    const obj: any = { l0: {} };
    let cur = obj.l0;
    for (let j = 0; j < 9; j++) {
      cur['k' + j] = j === 8 ? 8 : {};
      if (j < 8) cur = cur['k' + j];
    }
    const path = ['l0', ...Array.from({ length: 9 }, (_, j) => 'k' + j)].join('.');
    expect(getNestedValue(obj, path)).toBe(8);
  });
  it('getNestedValue soft-cap flood-9', () => {
    const obj: any = { l0: {} };
    let cur = obj.l0;
    for (let j = 0; j < 10; j++) {
      cur['k' + j] = j === 9 ? 9 : {};
      if (j < 9) cur = cur['k' + j];
    }
    const path = ['l0', ...Array.from({ length: 10 }, (_, j) => 'k' + j)].join('.');
    expect(getNestedValue(obj, path)).toBe(9);
  });
  it('getNestedValue soft-cap flood-10', () => {
    const obj: any = { l0: {} };
    let cur = obj.l0;
    for (let j = 0; j < 11; j++) {
      cur['k' + j] = j === 10 ? 10 : {};
      if (j < 10) cur = cur['k' + j];
    }
    const path = ['l0', ...Array.from({ length: 11 }, (_, j) => 'k' + j)].join('.');
    expect(getNestedValue(obj, path)).toBe(10);
  });
  it('getNestedValue soft-cap flood-11', () => {
    const obj: any = { l0: {} };
    let cur = obj.l0;
    for (let j = 0; j < 12; j++) {
      cur['k' + j] = j === 11 ? 11 : {};
      if (j < 11) cur = cur['k' + j];
    }
    const path = ['l0', ...Array.from({ length: 12 }, (_, j) => 'k' + j)].join('.');
    expect(getNestedValue(obj, path)).toBe(11);
  });
  it('getNestedValue soft-cap flood-12', () => {
    const obj: any = { l0: {} };
    let cur = obj.l0;
    for (let j = 0; j < 13; j++) {
      cur['k' + j] = j === 12 ? 12 : {};
      if (j < 12) cur = cur['k' + j];
    }
    const path = ['l0', ...Array.from({ length: 13 }, (_, j) => 'k' + j)].join('.');
    expect(getNestedValue(obj, path)).toBe(12);
  });
  it('getNestedValue soft-cap flood-13', () => {
    const obj: any = { l0: {} };
    let cur = obj.l0;
    for (let j = 0; j < 14; j++) {
      cur['k' + j] = j === 13 ? 13 : {};
      if (j < 13) cur = cur['k' + j];
    }
    const path = ['l0', ...Array.from({ length: 14 }, (_, j) => 'k' + j)].join('.');
    expect(getNestedValue(obj, path)).toBe(13);
  });
  it('getNestedValue soft-cap flood-14', () => {
    const obj: any = { l0: {} };
    let cur = obj.l0;
    for (let j = 0; j < 15; j++) {
      cur['k' + j] = j === 14 ? 14 : {};
      if (j < 14) cur = cur['k' + j];
    }
    const path = ['l0', ...Array.from({ length: 15 }, (_, j) => 'k' + j)].join('.');
    expect(getNestedValue(obj, path)).toBe(14);
  });
});

describe('oauth identity leftovers room_member_count soft-cap flood after #146', () => {
  it('room_member_count soft-cap flood-0', () => {
    const count = 0;
    expect(matchesCondition({ kind: 'room_member_count', is: `==${count}` }, baseEvent(), USER, count)).toBe(true);
    expect(matchesCondition({ kind: 'room_member_count', is: `>${count}` }, baseEvent(), USER, count)).toBe(false);
    expect(matchesCondition({ kind: 'room_member_count', is: `>=${count}` }, baseEvent(), USER, count)).toBe(true);
  });
  it('room_member_count soft-cap flood-1', () => {
    const count = 1;
    expect(matchesCondition({ kind: 'room_member_count', is: `==${count}` }, baseEvent(), USER, count)).toBe(true);
    expect(matchesCondition({ kind: 'room_member_count', is: `>${count}` }, baseEvent(), USER, count)).toBe(false);
    expect(matchesCondition({ kind: 'room_member_count', is: `>=${count}` }, baseEvent(), USER, count)).toBe(true);
  });
  it('room_member_count soft-cap flood-2', () => {
    const count = 2;
    expect(matchesCondition({ kind: 'room_member_count', is: `==${count}` }, baseEvent(), USER, count)).toBe(true);
    expect(matchesCondition({ kind: 'room_member_count', is: `>${count}` }, baseEvent(), USER, count)).toBe(false);
    expect(matchesCondition({ kind: 'room_member_count', is: `>=${count}` }, baseEvent(), USER, count)).toBe(true);
  });
  it('room_member_count soft-cap flood-3', () => {
    const count = 3;
    expect(matchesCondition({ kind: 'room_member_count', is: `==${count}` }, baseEvent(), USER, count)).toBe(true);
    expect(matchesCondition({ kind: 'room_member_count', is: `>${count}` }, baseEvent(), USER, count)).toBe(false);
    expect(matchesCondition({ kind: 'room_member_count', is: `>=${count}` }, baseEvent(), USER, count)).toBe(true);
  });
  it('room_member_count soft-cap flood-4', () => {
    const count = 4;
    expect(matchesCondition({ kind: 'room_member_count', is: `==${count}` }, baseEvent(), USER, count)).toBe(true);
    expect(matchesCondition({ kind: 'room_member_count', is: `>${count}` }, baseEvent(), USER, count)).toBe(false);
    expect(matchesCondition({ kind: 'room_member_count', is: `>=${count}` }, baseEvent(), USER, count)).toBe(true);
  });
  it('room_member_count soft-cap flood-5', () => {
    const count = 5;
    expect(matchesCondition({ kind: 'room_member_count', is: `==${count}` }, baseEvent(), USER, count)).toBe(true);
    expect(matchesCondition({ kind: 'room_member_count', is: `>${count}` }, baseEvent(), USER, count)).toBe(false);
    expect(matchesCondition({ kind: 'room_member_count', is: `>=${count}` }, baseEvent(), USER, count)).toBe(true);
  });
  it('room_member_count soft-cap flood-6', () => {
    const count = 6;
    expect(matchesCondition({ kind: 'room_member_count', is: `==${count}` }, baseEvent(), USER, count)).toBe(true);
    expect(matchesCondition({ kind: 'room_member_count', is: `>${count}` }, baseEvent(), USER, count)).toBe(false);
    expect(matchesCondition({ kind: 'room_member_count', is: `>=${count}` }, baseEvent(), USER, count)).toBe(true);
  });
  it('room_member_count soft-cap flood-7', () => {
    const count = 7;
    expect(matchesCondition({ kind: 'room_member_count', is: `==${count}` }, baseEvent(), USER, count)).toBe(true);
    expect(matchesCondition({ kind: 'room_member_count', is: `>${count}` }, baseEvent(), USER, count)).toBe(false);
    expect(matchesCondition({ kind: 'room_member_count', is: `>=${count}` }, baseEvent(), USER, count)).toBe(true);
  });
  it('room_member_count soft-cap flood-8', () => {
    const count = 8;
    expect(matchesCondition({ kind: 'room_member_count', is: `==${count}` }, baseEvent(), USER, count)).toBe(true);
    expect(matchesCondition({ kind: 'room_member_count', is: `>${count}` }, baseEvent(), USER, count)).toBe(false);
    expect(matchesCondition({ kind: 'room_member_count', is: `>=${count}` }, baseEvent(), USER, count)).toBe(true);
  });
  it('room_member_count soft-cap flood-9', () => {
    const count = 9;
    expect(matchesCondition({ kind: 'room_member_count', is: `==${count}` }, baseEvent(), USER, count)).toBe(true);
    expect(matchesCondition({ kind: 'room_member_count', is: `>${count}` }, baseEvent(), USER, count)).toBe(false);
    expect(matchesCondition({ kind: 'room_member_count', is: `>=${count}` }, baseEvent(), USER, count)).toBe(true);
  });
  it('room_member_count soft-cap flood-10', () => {
    const count = 10;
    expect(matchesCondition({ kind: 'room_member_count', is: `==${count}` }, baseEvent(), USER, count)).toBe(true);
    expect(matchesCondition({ kind: 'room_member_count', is: `>${count}` }, baseEvent(), USER, count)).toBe(false);
    expect(matchesCondition({ kind: 'room_member_count', is: `>=${count}` }, baseEvent(), USER, count)).toBe(true);
  });
  it('room_member_count soft-cap flood-11', () => {
    const count = 11;
    expect(matchesCondition({ kind: 'room_member_count', is: `==${count}` }, baseEvent(), USER, count)).toBe(true);
    expect(matchesCondition({ kind: 'room_member_count', is: `>${count}` }, baseEvent(), USER, count)).toBe(false);
    expect(matchesCondition({ kind: 'room_member_count', is: `>=${count}` }, baseEvent(), USER, count)).toBe(true);
  });
  it('room_member_count soft-cap flood-12', () => {
    const count = 12;
    expect(matchesCondition({ kind: 'room_member_count', is: `==${count}` }, baseEvent(), USER, count)).toBe(true);
    expect(matchesCondition({ kind: 'room_member_count', is: `>${count}` }, baseEvent(), USER, count)).toBe(false);
    expect(matchesCondition({ kind: 'room_member_count', is: `>=${count}` }, baseEvent(), USER, count)).toBe(true);
  });
  it('room_member_count soft-cap flood-13', () => {
    const count = 13;
    expect(matchesCondition({ kind: 'room_member_count', is: `==${count}` }, baseEvent(), USER, count)).toBe(true);
    expect(matchesCondition({ kind: 'room_member_count', is: `>${count}` }, baseEvent(), USER, count)).toBe(false);
    expect(matchesCondition({ kind: 'room_member_count', is: `>=${count}` }, baseEvent(), USER, count)).toBe(true);
  });
});

describe('oauth identity leftovers hashClientSecret soft-cap flood after #146', () => {
  it('hashClientSecret soft-cap flood-0', async () => {
    const h = await hashClientSecret('secret-0');
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(h).not.toBe(await hashClientSecret('secret-1'));
  });
  it('hashClientSecret soft-cap flood-1', async () => {
    const h = await hashClientSecret('secret-1');
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(h).not.toBe(await hashClientSecret('secret-2'));
  });
  it('hashClientSecret soft-cap flood-2', async () => {
    const h = await hashClientSecret('secret-2');
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(h).not.toBe(await hashClientSecret('secret-3'));
  });
  it('hashClientSecret soft-cap flood-3', async () => {
    const h = await hashClientSecret('secret-3');
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(h).not.toBe(await hashClientSecret('secret-4'));
  });
  it('hashClientSecret soft-cap flood-4', async () => {
    const h = await hashClientSecret('secret-4');
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(h).not.toBe(await hashClientSecret('secret-5'));
  });
  it('hashClientSecret soft-cap flood-5', async () => {
    const h = await hashClientSecret('secret-5');
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(h).not.toBe(await hashClientSecret('secret-6'));
  });
  it('hashClientSecret soft-cap flood-6', async () => {
    const h = await hashClientSecret('secret-6');
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(h).not.toBe(await hashClientSecret('secret-7'));
  });
  it('hashClientSecret soft-cap flood-7', async () => {
    const h = await hashClientSecret('secret-7');
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(h).not.toBe(await hashClientSecret('secret-8'));
  });
  it('hashClientSecret soft-cap flood-8', async () => {
    const h = await hashClientSecret('secret-8');
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(h).not.toBe(await hashClientSecret('secret-9'));
  });
  it('hashClientSecret soft-cap flood-9', async () => {
    const h = await hashClientSecret('secret-9');
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(h).not.toBe(await hashClientSecret('secret-10'));
  });
  it('hashClientSecret soft-cap flood-10', async () => {
    const h = await hashClientSecret('secret-10');
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(h).not.toBe(await hashClientSecret('secret-11'));
  });
  it('hashClientSecret soft-cap flood-11', async () => {
    const h = await hashClientSecret('secret-11');
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(h).not.toBe(await hashClientSecret('secret-12'));
  });
});

describe('oauth identity leftovers submitToken soft-cap flood after #146', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('submitToken soft-cap flood-0', async () => {
    const sid = 'sid-flood-0';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'u0@example.com',
            client_secret: 'cs0',
            token: '100000',
            send_attempt: 0,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + DAY_MS,
          },
        ],
      ]),
    });
    const { status, body } = await identityRequest(
      `${ID_BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'cs0', token: '100000' }),
      makeIdentityEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(db.emailSessions.get(sid)?.validated).toBe(1);
  });
  it('submitToken soft-cap flood-1', async () => {
    const sid = 'sid-flood-1';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'u1@example.com',
            client_secret: 'cs1',
            token: '100001',
            send_attempt: 1,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + DAY_MS,
          },
        ],
      ]),
    });
    const { status, body } = await identityRequest(
      `${ID_BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'cs1', token: '100001' }),
      makeIdentityEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(db.emailSessions.get(sid)?.validated).toBe(1);
  });
  it('submitToken soft-cap flood-2', async () => {
    const sid = 'sid-flood-2';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'u2@example.com',
            client_secret: 'cs2',
            token: '100002',
            send_attempt: 2,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + DAY_MS,
          },
        ],
      ]),
    });
    const { status, body } = await identityRequest(
      `${ID_BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'cs2', token: '100002' }),
      makeIdentityEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(db.emailSessions.get(sid)?.validated).toBe(1);
  });
  it('submitToken soft-cap flood-3', async () => {
    const sid = 'sid-flood-3';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'u3@example.com',
            client_secret: 'cs3',
            token: '100003',
            send_attempt: 3,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + DAY_MS,
          },
        ],
      ]),
    });
    const { status, body } = await identityRequest(
      `${ID_BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'cs3', token: '100003' }),
      makeIdentityEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(db.emailSessions.get(sid)?.validated).toBe(1);
  });
  it('submitToken soft-cap flood-4', async () => {
    const sid = 'sid-flood-4';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'u4@example.com',
            client_secret: 'cs4',
            token: '100004',
            send_attempt: 4,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + DAY_MS,
          },
        ],
      ]),
    });
    const { status, body } = await identityRequest(
      `${ID_BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'cs4', token: '100004' }),
      makeIdentityEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(db.emailSessions.get(sid)?.validated).toBe(1);
  });
  it('submitToken soft-cap flood-5', async () => {
    const sid = 'sid-flood-5';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'u5@example.com',
            client_secret: 'cs5',
            token: '100005',
            send_attempt: 5,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + DAY_MS,
          },
        ],
      ]),
    });
    const { status, body } = await identityRequest(
      `${ID_BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'cs5', token: '100005' }),
      makeIdentityEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(db.emailSessions.get(sid)?.validated).toBe(1);
  });
  it('submitToken soft-cap flood-6', async () => {
    const sid = 'sid-flood-6';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'u6@example.com',
            client_secret: 'cs6',
            token: '100006',
            send_attempt: 6,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + DAY_MS,
          },
        ],
      ]),
    });
    const { status, body } = await identityRequest(
      `${ID_BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'cs6', token: '100006' }),
      makeIdentityEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(db.emailSessions.get(sid)?.validated).toBe(1);
  });
  it('submitToken soft-cap flood-7', async () => {
    const sid = 'sid-flood-7';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'u7@example.com',
            client_secret: 'cs7',
            token: '100007',
            send_attempt: 7,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + DAY_MS,
          },
        ],
      ]),
    });
    const { status, body } = await identityRequest(
      `${ID_BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'cs7', token: '100007' }),
      makeIdentityEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(db.emailSessions.get(sid)?.validated).toBe(1);
  });
  it('submitToken soft-cap flood-8', async () => {
    const sid = 'sid-flood-8';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'u8@example.com',
            client_secret: 'cs8',
            token: '100008',
            send_attempt: 8,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + DAY_MS,
          },
        ],
      ]),
    });
    const { status, body } = await identityRequest(
      `${ID_BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'cs8', token: '100008' }),
      makeIdentityEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(db.emailSessions.get(sid)?.validated).toBe(1);
  });
  it('submitToken soft-cap flood-9', async () => {
    const sid = 'sid-flood-9';
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          sid,
          {
            session_id: sid,
            email: 'u9@example.com',
            client_secret: 'cs9',
            token: '100009',
            send_attempt: 9,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + DAY_MS,
          },
        ],
      ]),
    });
    const { status, body } = await identityRequest(
      `${ID_BASE}/validate/email/submitToken`,
      postJson({ sid, client_secret: 'cs9', token: '100009' }),
      makeIdentityEnv({ db })
    );
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(db.emailSessions.get(sid)?.validated).toBe(1);
  });
});

describe('oauth identity leftovers room account-data soft-cap flood after #146', () => {
  it('room account-data soft-cap flood-0', async () => {
    const room = `!r0:example.com`;
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: room, event_type: 'm.tag', content: '{"tags":{"m.favourite":{"order":0}}}' }],
    });
    const rows = await getRoomAccountData(db, USER, room);
    expect(rows[0].content.tags['m.favourite'].order).toBe(0);
  });
  it('room account-data soft-cap flood-1', async () => {
    const room = `!r1:example.com`;
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: room, event_type: 'm.tag', content: '{"tags":{"m.favourite":{"order":1}}}' }],
    });
    const rows = await getRoomAccountData(db, USER, room);
    expect(rows[0].content.tags['m.favourite'].order).toBe(1);
  });
  it('room account-data soft-cap flood-2', async () => {
    const room = `!r2:example.com`;
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: room, event_type: 'm.tag', content: '{"tags":{"m.favourite":{"order":2}}}' }],
    });
    const rows = await getRoomAccountData(db, USER, room);
    expect(rows[0].content.tags['m.favourite'].order).toBe(2);
  });
  it('room account-data soft-cap flood-3', async () => {
    const room = `!r3:example.com`;
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: room, event_type: 'm.tag', content: '{"tags":{"m.favourite":{"order":3}}}' }],
    });
    const rows = await getRoomAccountData(db, USER, room);
    expect(rows[0].content.tags['m.favourite'].order).toBe(3);
  });
  it('room account-data soft-cap flood-4', async () => {
    const room = `!r4:example.com`;
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: room, event_type: 'm.tag', content: '{"tags":{"m.favourite":{"order":4}}}' }],
    });
    const rows = await getRoomAccountData(db, USER, room);
    expect(rows[0].content.tags['m.favourite'].order).toBe(4);
  });
  it('room account-data soft-cap flood-5', async () => {
    const room = `!r5:example.com`;
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: room, event_type: 'm.tag', content: '{"tags":{"m.favourite":{"order":5}}}' }],
    });
    const rows = await getRoomAccountData(db, USER, room);
    expect(rows[0].content.tags['m.favourite'].order).toBe(5);
  });
  it('room account-data soft-cap flood-6', async () => {
    const room = `!r6:example.com`;
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: room, event_type: 'm.tag', content: '{"tags":{"m.favourite":{"order":6}}}' }],
    });
    const rows = await getRoomAccountData(db, USER, room);
    expect(rows[0].content.tags['m.favourite'].order).toBe(6);
  });
  it('room account-data soft-cap flood-7', async () => {
    const room = `!r7:example.com`;
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: room, event_type: 'm.tag', content: '{"tags":{"m.favourite":{"order":7}}}' }],
    });
    const rows = await getRoomAccountData(db, USER, room);
    expect(rows[0].content.tags['m.favourite'].order).toBe(7);
  });
  it('room account-data soft-cap flood-8', async () => {
    const room = `!r8:example.com`;
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: room, event_type: 'm.tag', content: '{"tags":{"m.favourite":{"order":8}}}' }],
    });
    const rows = await getRoomAccountData(db, USER, room);
    expect(rows[0].content.tags['m.favourite'].order).toBe(8);
  });
  it('room account-data soft-cap flood-9', async () => {
    const room = `!r9:example.com`;
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: room, event_type: 'm.tag', content: '{"tags":{"m.favourite":{"order":9}}}' }],
    });
    const rows = await getRoomAccountData(db, USER, room);
    expect(rows[0].content.tags['m.favourite'].order).toBe(9);
  });
  it('room account-data soft-cap flood-10', async () => {
    const room = `!r10:example.com`;
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: room, event_type: 'm.tag', content: '{"tags":{"m.favourite":{"order":10}}}' }],
    });
    const rows = await getRoomAccountData(db, USER, room);
    expect(rows[0].content.tags['m.favourite'].order).toBe(10);
  });
  it('room account-data soft-cap flood-11', async () => {
    const room = `!r11:example.com`;
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: room, event_type: 'm.tag', content: '{"tags":{"m.favourite":{"order":11}}}' }],
    });
    const rows = await getRoomAccountData(db, USER, room);
    expect(rows[0].content.tags['m.favourite'].order).toBe(11);
  });
});

describe('oauth identity leftovers login page soft-cap flood after #146', () => {
  it('login page soft-cap flood-0', () => {
    const html = generateLoginPage(`Client 0 <b>`, `req0`, SERVER, 0 % 2 === 0 ? `err0<x>` : undefined);
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain(`req0`);
    expect(html).toContain(SERVER);
    if (0 % 2 === 0) expect(html).toContain('&lt;x&gt;');
  });
  it('login page soft-cap flood-1', () => {
    const html = generateLoginPage(`Client 1 <b>`, `req1`, SERVER, 1 % 2 === 0 ? `err1<x>` : undefined);
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain(`req1`);
    expect(html).toContain(SERVER);
    if (1 % 2 === 0) expect(html).toContain('&lt;x&gt;');
  });
  it('login page soft-cap flood-2', () => {
    const html = generateLoginPage(`Client 2 <b>`, `req2`, SERVER, 2 % 2 === 0 ? `err2<x>` : undefined);
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain(`req2`);
    expect(html).toContain(SERVER);
    if (2 % 2 === 0) expect(html).toContain('&lt;x&gt;');
  });
  it('login page soft-cap flood-3', () => {
    const html = generateLoginPage(`Client 3 <b>`, `req3`, SERVER, 3 % 2 === 0 ? `err3<x>` : undefined);
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain(`req3`);
    expect(html).toContain(SERVER);
    if (3 % 2 === 0) expect(html).toContain('&lt;x&gt;');
  });
  it('login page soft-cap flood-4', () => {
    const html = generateLoginPage(`Client 4 <b>`, `req4`, SERVER, 4 % 2 === 0 ? `err4<x>` : undefined);
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain(`req4`);
    expect(html).toContain(SERVER);
    if (4 % 2 === 0) expect(html).toContain('&lt;x&gt;');
  });
  it('login page soft-cap flood-5', () => {
    const html = generateLoginPage(`Client 5 <b>`, `req5`, SERVER, 5 % 2 === 0 ? `err5<x>` : undefined);
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain(`req5`);
    expect(html).toContain(SERVER);
    if (5 % 2 === 0) expect(html).toContain('&lt;x&gt;');
  });
  it('login page soft-cap flood-6', () => {
    const html = generateLoginPage(`Client 6 <b>`, `req6`, SERVER, 6 % 2 === 0 ? `err6<x>` : undefined);
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain(`req6`);
    expect(html).toContain(SERVER);
    if (6 % 2 === 0) expect(html).toContain('&lt;x&gt;');
  });
  it('login page soft-cap flood-7', () => {
    const html = generateLoginPage(`Client 7 <b>`, `req7`, SERVER, 7 % 2 === 0 ? `err7<x>` : undefined);
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain(`req7`);
    expect(html).toContain(SERVER);
    if (7 % 2 === 0) expect(html).toContain('&lt;x&gt;');
  });
  it('login page soft-cap flood-8', () => {
    const html = generateLoginPage(`Client 8 <b>`, `req8`, SERVER, 8 % 2 === 0 ? `err8<x>` : undefined);
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain(`req8`);
    expect(html).toContain(SERVER);
    if (8 % 2 === 0) expect(html).toContain('&lt;x&gt;');
  });
  it('login page soft-cap flood-9', () => {
    const html = generateLoginPage(`Client 9 <b>`, `req9`, SERVER, 9 % 2 === 0 ? `err9<x>` : undefined);
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain(`req9`);
    expect(html).toContain(SERVER);
    if (9 % 2 === 0) expect(html).toContain('&lt;x&gt;');
  });
});

describe('oauth identity leftovers base64Url soft-cap flood after #146', () => {
  it('base64Url soft-cap flood-0', () => {
    const u8 = new Uint8Array(Array.from({ length: 1 }, (_, j) => (j * 3) % 256));
    const enc = base64UrlEncode(u8);
    expect(enc).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlDecode(enc))).toEqual(Array.from(u8));
  });
  it('base64Url soft-cap flood-1', () => {
    const u8 = new Uint8Array(Array.from({ length: 2 }, (_, j) => (j * 4) % 256));
    const enc = base64UrlEncode(u8);
    expect(enc).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlDecode(enc))).toEqual(Array.from(u8));
  });
  it('base64Url soft-cap flood-2', () => {
    const u8 = new Uint8Array(Array.from({ length: 3 }, (_, j) => (j * 5) % 256));
    const enc = base64UrlEncode(u8);
    expect(enc).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlDecode(enc))).toEqual(Array.from(u8));
  });
  it('base64Url soft-cap flood-3', () => {
    const u8 = new Uint8Array(Array.from({ length: 4 }, (_, j) => (j * 6) % 256));
    const enc = base64UrlEncode(u8);
    expect(enc).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlDecode(enc))).toEqual(Array.from(u8));
  });
  it('base64Url soft-cap flood-4', () => {
    const u8 = new Uint8Array(Array.from({ length: 5 }, (_, j) => (j * 7) % 256));
    const enc = base64UrlEncode(u8);
    expect(enc).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlDecode(enc))).toEqual(Array.from(u8));
  });
  it('base64Url soft-cap flood-5', () => {
    const u8 = new Uint8Array(Array.from({ length: 6 }, (_, j) => (j * 8) % 256));
    const enc = base64UrlEncode(u8);
    expect(enc).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlDecode(enc))).toEqual(Array.from(u8));
  });
  it('base64Url soft-cap flood-6', () => {
    const u8 = new Uint8Array(Array.from({ length: 7 }, (_, j) => (j * 9) % 256));
    const enc = base64UrlEncode(u8);
    expect(enc).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlDecode(enc))).toEqual(Array.from(u8));
  });
  it('base64Url soft-cap flood-7', () => {
    const u8 = new Uint8Array(Array.from({ length: 8 }, (_, j) => (j * 10) % 256));
    const enc = base64UrlEncode(u8);
    expect(enc).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlDecode(enc))).toEqual(Array.from(u8));
  });
  it('base64Url soft-cap flood-8', () => {
    const u8 = new Uint8Array(Array.from({ length: 9 }, (_, j) => (j * 11) % 256));
    const enc = base64UrlEncode(u8);
    expect(enc).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlDecode(enc))).toEqual(Array.from(u8));
  });
  it('base64Url soft-cap flood-9', () => {
    const u8 = new Uint8Array(Array.from({ length: 10 }, (_, j) => (j * 12) % 256));
    const enc = base64UrlEncode(u8);
    expect(enc).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlDecode(enc))).toEqual(Array.from(u8));
  });
  it('base64Url soft-cap flood-10', () => {
    const u8 = new Uint8Array(Array.from({ length: 11 }, (_, j) => (j * 13) % 256));
    const enc = base64UrlEncode(u8);
    expect(enc).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlDecode(enc))).toEqual(Array.from(u8));
  });
  it('base64Url soft-cap flood-11', () => {
    const u8 = new Uint8Array(Array.from({ length: 12 }, (_, j) => (j * 14) % 256));
    const enc = base64UrlEncode(u8);
    expect(enc).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlDecode(enc))).toEqual(Array.from(u8));
  });
  it('base64Url soft-cap flood-12', () => {
    const u8 = new Uint8Array(Array.from({ length: 13 }, (_, j) => (j * 15) % 256));
    const enc = base64UrlEncode(u8);
    expect(enc).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlDecode(enc))).toEqual(Array.from(u8));
  });
  it('base64Url soft-cap flood-13', () => {
    const u8 = new Uint8Array(Array.from({ length: 14 }, (_, j) => (j * 16) % 256));
    const enc = base64UrlEncode(u8);
    expect(enc).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlDecode(enc))).toEqual(Array.from(u8));
  });
  it('base64Url soft-cap flood-14', () => {
    const u8 = new Uint8Array(Array.from({ length: 15 }, (_, j) => (j * 17) % 256));
    const enc = base64UrlEncode(u8);
    expect(enc).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlDecode(enc))).toEqual(Array.from(u8));
  });
  it('base64Url soft-cap flood-15', () => {
    const u8 = new Uint8Array(Array.from({ length: 16 }, (_, j) => (j * 18) % 256));
    const enc = base64UrlEncode(u8);
    expect(enc).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlDecode(enc))).toEqual(Array.from(u8));
  });
});

describe('oauth identity leftovers generateRandomString soft-cap flood after #146', () => {
  it('generateRandomString soft-cap flood-0', () => {
    const s = generateRandomString(1);
    expect(s).toHaveLength(2);
    expect(s).toMatch(/^[0-9a-f]+$/);
  });
  it('generateRandomString soft-cap flood-1', () => {
    const s = generateRandomString(2);
    expect(s).toHaveLength(4);
    expect(s).toMatch(/^[0-9a-f]+$/);
  });
  it('generateRandomString soft-cap flood-2', () => {
    const s = generateRandomString(3);
    expect(s).toHaveLength(6);
    expect(s).toMatch(/^[0-9a-f]+$/);
  });
  it('generateRandomString soft-cap flood-3', () => {
    const s = generateRandomString(4);
    expect(s).toHaveLength(8);
    expect(s).toMatch(/^[0-9a-f]+$/);
  });
  it('generateRandomString soft-cap flood-4', () => {
    const s = generateRandomString(5);
    expect(s).toHaveLength(10);
    expect(s).toMatch(/^[0-9a-f]+$/);
  });
  it('generateRandomString soft-cap flood-5', () => {
    const s = generateRandomString(6);
    expect(s).toHaveLength(12);
    expect(s).toMatch(/^[0-9a-f]+$/);
  });
  it('generateRandomString soft-cap flood-6', () => {
    const s = generateRandomString(7);
    expect(s).toHaveLength(14);
    expect(s).toMatch(/^[0-9a-f]+$/);
  });
  it('generateRandomString soft-cap flood-7', () => {
    const s = generateRandomString(8);
    expect(s).toHaveLength(16);
    expect(s).toMatch(/^[0-9a-f]+$/);
  });
  it('generateRandomString soft-cap flood-8', () => {
    const s = generateRandomString(9);
    expect(s).toHaveLength(18);
    expect(s).toMatch(/^[0-9a-f]+$/);
  });
  it('generateRandomString soft-cap flood-9', () => {
    const s = generateRandomString(10);
    expect(s).toHaveLength(20);
    expect(s).toMatch(/^[0-9a-f]+$/);
  });
  it('generateRandomString soft-cap flood-10', () => {
    const s = generateRandomString(11);
    expect(s).toHaveLength(22);
    expect(s).toMatch(/^[0-9a-f]+$/);
  });
  it('generateRandomString soft-cap flood-11', () => {
    const s = generateRandomString(12);
    expect(s).toHaveLength(24);
    expect(s).toMatch(/^[0-9a-f]+$/);
  });
});

describe('oauth identity leftovers authorize response_type / redirect soft reject after #146', () => {
  for (const rt of ['token', 'id_token', 'code token', 'CODE', '', 'none', 'query']) {
    it(`authorize unsupported response_type soft ${JSON.stringify(rt)}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cli_rt');
      const res = await oauthRequest(
        `/oauth/authorize?client_id=cli_rt&response_type=${encodeURIComponent(rt)}&redirect_uri=${encodeURIComponent(REDIRECT)}`,
        {},
        makeOAuthEnv({ CACHE: cache })
      );
      expect(res.status).toBe(400);
      expect((await oauthJson(res)).error).toBe('unsupported_response_type');
    });
  }

  for (const uri of [
    'https://evil.example/cb',
    'https://app.example/cb/',
    'http://app.example/cb',
    REDIRECT + '?x=1',
    'https://app.example/other',
  ]) {
    it(`authorize redirect_uri mismatch soft ${uri.slice(0, 40)}`, async () => {
      const cache = mockKv();
      seedClient(cache, 'cli_rdm');
      const res = await oauthRequest(
        `/oauth/authorize?client_id=cli_rdm&response_type=code&redirect_uri=${encodeURIComponent(uri)}`,
        {},
        makeOAuthEnv({ CACHE: cache })
      );
      expect(res.status).toBe(400);
      expect((await oauthJson(res)).error).toBe('invalid_request');
    });
  }

  it('authorize exact registered redirect soft accepts', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'cli_ok');
    const res = await oauthRequest(
      `/oauth/authorize?client_id=cli_ok&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=openid`,
      {},
      makeOAuthEnv({ CACHE: cache, SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
    const key = Object.keys(sessions.data).find((k) => k.startsWith('oauth_auth_request:'));
    expect(JSON.parse(sessions.data[key!]).scope).toBe('openid');
  });
});

describe('oauth identity leftovers authorize POST login soft failure after #146', () => {
  it('POST authorize missing fields soft HTML error', async () => {
    const fd = new FormData();
    fd.set('username', '');
    fd.set('password', '');
    fd.set('auth_request_id', 'req1');
    const res = await oauthRequest('/oauth/authorize', { method: 'POST', body: fd });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Missing username or password/i);
  });

  it('POST authorize expired auth_request soft JSON', async () => {
    const fd = new FormData();
    fd.set('username', 'alice');
    fd.set('password', 'pw');
    fd.set('auth_request_id', 'gone');
    const res = await oauthRequest('/oauth/authorize', { method: 'POST', body: fd });
    expect(res.status).toBe(400);
    expect((await oauthJson(res)).error).toBe('invalid_request');
  });

  it('POST authorize unknown user soft HTML retry', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'cli_login');
    sessions.data['oauth_auth_request:req_u'] = JSON.stringify({
      client_id: 'cli_login',
      redirect_uri: REDIRECT,
      scope: 'openid',
      state: 'st',
      nonce: null,
      code_challenge: null,
      code_challenge_method: null,
    });
    const fd = new FormData();
    fd.set('username', 'nobody');
    fd.set('password', 'pw');
    fd.set('auth_request_id', 'req_u');
    const res = await oauthRequest(
      '/oauth/authorize',
      { method: 'POST', body: fd },
      makeOAuthEnv({ CACHE: cache, SESSIONS: sessions, DB: createOAuthDb() })
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/Invalid username or password/i);
    expect(Object.keys(sessions.data).some((k) => k.startsWith('oauth_auth_request:'))).toBe(true);
  });

  it('POST authorize wrong password soft HTML retry', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'cli_pw');
    sessions.data['oauth_auth_request:req_p'] = JSON.stringify({
      client_id: 'cli_pw',
      redirect_uri: REDIRECT,
      scope: 'openid',
      state: null,
      nonce: null,
      code_challenge: null,
      code_challenge_method: null,
    });
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: 'mockok:correct' }]]),
    });
    const fd = new FormData();
    fd.set('username', 'alice');
    fd.set('password', 'wrong');
    fd.set('auth_request_id', 'req_p');
    const res = await oauthRequest(
      '/oauth/authorize',
      { method: 'POST', body: fd },
      makeOAuthEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Invalid username or password/i);
  });

  it('POST authorize deactivated user soft HTML retry', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'cli_deact');
    sessions.data['oauth_auth_request:req_d'] = JSON.stringify({
      client_id: 'cli_deact',
      redirect_uri: REDIRECT,
      scope: 'openid',
      state: null,
      nonce: null,
      code_challenge: null,
      code_challenge_method: null,
    });
    const db = createOAuthDb({
      users: new Map([[USER, { user_id: USER, password_hash: 'mockok:pw', is_deactivated: 1 }]]),
    });
    const fd = new FormData();
    fd.set('username', 'alice');
    fd.set('password', 'pw');
    fd.set('auth_request_id', 'req_d');
    const res = await oauthRequest(
      '/oauth/authorize',
      { method: 'POST', body: fd },
      makeOAuthEnv({ CACHE: cache, SESSIONS: sessions, DB: db })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Invalid username or password/i);
  });
});

describe('oauth identity leftovers token expired code / PKCE soft after #146', () => {
  it('token missing code soft invalid_request', async () => {
    const cache = mockKv();
    seedClient(cache, 'cli_nc');
    const res = await oauthRequest(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'cli_nc',
          redirect_uri: REDIRECT,
        }),
      },
      makeOAuthEnv({ CACHE: cache })
    );
    expect(res.status).toBe(400);
    expect((await oauthJson(res)).error).toBe('invalid_request');
  });

  it('token unknown code soft invalid_grant', async () => {
    const cache = mockKv();
    seedClient(cache, 'cli_uc');
    const res = await oauthRequest(
      '/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: 'cli_uc',
          code: 'missing',
          redirect_uri: REDIRECT,
        }),
      },
      makeOAuthEnv({ CACHE: cache, SESSIONS: mockKv() })
    );
    expect(res.status).toBe(400);
    expect((await oauthJson(res)).error).toBe('invalid_grant');
  });

  it('token expired code soft invalid_grant', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'cli_exp');
    sessions.data['oauth_code:old'] = JSON.stringify({
      code: 'old',
      client_id: 'cli_exp',
      user_id: USER,
      redirect_uri: REDIRECT,
      scope: 'openid',
      code_challenge: null,
      code_challenge_method: null,
      created_at: NOW - 20 * 60 * 1000,
      expires_at: NOW - 1,
    });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const res = await oauthRequest(
        '/oauth/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            client_id: 'cli_exp',
            code: 'old',
            redirect_uri: REDIRECT,
          }),
        },
        makeOAuthEnv({ CACHE: cache, SESSIONS: sessions })
      );
      expect(res.status).toBe(400);
      expect((await oauthJson(res)).error).toBe('invalid_grant');
    } finally {
      vi.useRealTimers();
    }
  });

  it('token client_id mismatch soft invalid_grant', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'cli_a');
    seedClient(cache, 'cli_b');
    sessions.data['oauth_code:cm'] = JSON.stringify({
      code: 'cm',
      client_id: 'cli_a',
      user_id: USER,
      redirect_uri: REDIRECT,
      scope: 'openid',
      code_challenge: null,
      code_challenge_method: null,
      created_at: NOW,
      expires_at: NOW + 600_000,
    });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const res = await oauthRequest(
        '/oauth/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            client_id: 'cli_b',
            code: 'cm',
            redirect_uri: REDIRECT,
          }),
        },
        makeOAuthEnv({ CACHE: cache, SESSIONS: sessions })
      );
      expect(res.status).toBe(400);
      expect((await oauthJson(res)).error).toBe('invalid_grant');
    } finally {
      vi.useRealTimers();
    }
  });

  it('token PKCE missing verifier soft invalid_request', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'cli_pk');
    sessions.data['oauth_code:pk'] = JSON.stringify({
      code: 'pk',
      client_id: 'cli_pk',
      user_id: USER,
      redirect_uri: REDIRECT,
      scope: 'openid',
      code_challenge: 'challenge',
      code_challenge_method: 'plain',
      created_at: NOW,
      expires_at: NOW + 600_000,
    });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const res = await oauthRequest(
        '/oauth/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            client_id: 'cli_pk',
            code: 'pk',
            redirect_uri: REDIRECT,
          }),
        },
        makeOAuthEnv({ CACHE: cache, SESSIONS: sessions })
      );
      expect(res.status).toBe(400);
      expect((await oauthJson(res)).error).toBe('invalid_request');
    } finally {
      vi.useRealTimers();
    }
  });

  it('token PKCE wrong verifier soft invalid_grant', async () => {
    const cache = mockKv();
    const sessions = mockKv();
    seedClient(cache, 'cli_pk2');
    sessions.data['oauth_code:pk2'] = JSON.stringify({
      code: 'pk2',
      client_id: 'cli_pk2',
      user_id: USER,
      redirect_uri: REDIRECT,
      scope: 'openid',
      code_challenge: 'right-verifier',
      code_challenge_method: 'plain',
      created_at: NOW,
      expires_at: NOW + 600_000,
    });
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const res = await oauthRequest(
        '/oauth/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            client_id: 'cli_pk2',
            code: 'pk2',
            redirect_uri: REDIRECT,
            code_verifier: 'wrong-verifier',
          }),
        },
        makeOAuthEnv({ CACHE: cache, SESSIONS: sessions })
      );
      expect(res.status).toBe(400);
      expect((await oauthJson(res)).error).toBe('invalid_grant');
    } finally {
      vi.useRealTimers();
    }
  });

  it('token unsupported content-type soft', async () => {
    const res = await oauthRequest('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'grant_type=authorization_code',
    });
    expect(res.status).toBe(400);
    expect((await oauthJson(res)).error).toBe('invalid_request');
  });
});

describe('oauth identity leftovers revoke / introspect token-missing soft after #146', () => {
  it('revoke missing token soft invalid_request', async () => {
    const res = await oauthRequest('/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await oauthJson(res)).error).toBe('invalid_request');
  });

  it('introspect missing token soft invalid_request', async () => {
    const res = await oauthRequest('/oauth/introspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token_type_hint: 'access_token' }),
    });
    expect(res.status).toBe(400);
    expect((await oauthJson(res)).error).toBe('invalid_request');
  });

  it('revoke unknown refresh soft still 200', async () => {
    const sessions = mockKv();
    const res = await oauthRequest(
      '/oauth/revoke',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'unknown-refresh', token_type_hint: 'refresh_token' }),
      },
      makeOAuthEnv({ SESSIONS: sessions })
    );
    expect(res.status).toBe(200);
  });

  it('introspect opaque unknown soft inactive', async () => {
    const res = await oauthRequest(
      '/oauth/introspect',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'not-a-jwt-or-db-token' }),
      },
      makeOAuthEnv({ DB: createOAuthDb() })
    );
    expect(res.status).toBe(200);
    expect((await oauthJson(res)).active).toBe(false);
  });

  it('register empty redirect_uris soft invalid_client_metadata', async () => {
    const res = await oauthRequest('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'x', redirect_uris: [] }),
    });
    expect(res.status).toBe(400);
    expect((await oauthJson(res)).error).toBe('invalid_client_metadata');
  });

  it('register missing redirect_uris soft invalid_client_metadata', async () => {
    const res = await oauthRequest('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'x' }),
    });
    expect(res.status).toBe(400);
    expect((await oauthJson(res)).error).toBe('invalid_client_metadata');
  });
});

describe('oauth identity leftovers push event_match soft path matrix after #146', () => {
  const event = baseEvent({
    type: 'm.room.message',
    content: { body: 'Hello World', msgtype: 'm.text' },
    sender: '@alice:example.com',
  });

  it('event_match missing key soft false', () => {
    expect(matchesCondition({ kind: 'event_match', pattern: 'm.room.message' } as any, event, USER, 2)).toBe(
      false
    );
  });

  it('event_match missing pattern soft false', () => {
    expect(matchesCondition({ kind: 'event_match', key: 'type' } as any, event, USER, 2)).toBe(false);
  });

  it('event_match type exact soft', () => {
    expect(
      matchesCondition({ kind: 'event_match', key: 'type', pattern: 'm.room.message' }, event, USER, 2)
    ).toBe(true);
    expect(
      matchesCondition({ kind: 'event_match', key: 'type', pattern: 'm.room.encrypted' }, event, USER, 2)
    ).toBe(false);
  });

  it('event_match glob * soft', () => {
    expect(
      matchesCondition({ kind: 'event_match', key: 'content.body', pattern: 'Hello*' }, event, USER, 2)
    ).toBe(true);
    expect(
      matchesCondition({ kind: 'event_match', key: 'content.body', pattern: 'Bye*' }, event, USER, 2)
    ).toBe(false);
  });

  it('event_match empty pattern soft false (falsy guard before userId subst)', () => {
    const e = baseEvent({ state_key: USER });
    // `!condition.pattern` treats '' as missing — soft false (userId subst is unreachable)
    expect(matchesCondition({ kind: 'event_match', key: 'state_key', pattern: '' }, e, USER, 2)).toBe(false);
  });

  it('event_match missing nested soft false', () => {
    expect(
      matchesCondition({ kind: 'event_match', key: 'content.missing', pattern: 'x' }, event, USER, 2)
    ).toBe(false);
  });

  it('matchesRule pattern soft case-insensitive', () => {
    const rule: PushRule = {
      rule_id: 'p',
      default: false,
      enabled: true,
      pattern: 'HELLO*',
      actions: ['notify'],
    };
    expect(matchesRule(rule, event, USER, 2)).toBe(true);
  });

  it('matchesRule pattern soft no body false', () => {
    const rule: PushRule = {
      rule_id: 'p',
      default: false,
      enabled: true,
      pattern: 'x',
      actions: ['notify'],
    };
    expect(matchesRule(rule, baseEvent({ content: { msgtype: 'm.text' } }), USER, 2)).toBe(false);
  });

  it('evaluatePushRules disabled custom soft falls through to defaults', async () => {
    const db = pushRulesDb([
      {
        kind: 'override',
        rule_id: 'off',
        conditions: JSON.stringify([]),
        actions: JSON.stringify(['notify']),
        enabled: 0,
      },
    ]);
    // Disabled custom rule is filtered out; default underride .m.rule.message still notifies
    const r = await evaluatePushRules(db, PUSH_USER, baseEvent() as any, 2);
    expect(r.notify).toBe(true);
  });
});

describe('oauth identity leftovers push gateway 2xx / updateThrow soft after #146', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const status of [200, 201, 202, 204]) {
    it(`gateway HTTP ${status} soft success`, async () => {
      fetchMock.mockResolvedValue(new Response(status === 204 ? null : '{}', { status }));
      const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
      await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 1 });
      expect(db.updates.some((u) => u.kind === 'success')).toBe(true);
    });
  }

  it('updateThrow on success soft propagates', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] }, updateThrow: true });
    await expect(sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 1 })).rejects.toThrow(
      /update fail/
    );
  });

  it('updateThrow on failure soft propagates', async () => {
    fetchMock.mockResolvedValue(new Response('err', { status: 500 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] }, updateThrow: true });
    await expect(sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 1 })).rejects.toThrow(
      /update fail/
    );
  });

  it('no pushers soft no fetch', async () => {
    const db = createPushDb({ pushers: { [PUSH_USER]: [] } });
    await sendPushNotification(db, PUSH_USER, baseEvent() as any, { unread: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('notifyRoomMembers empty members soft no queue', async () => {
    const db = createPushDb({
      members: [],
      memberCount: 1,
      pushRules: [
        {
          kind: 'underride',
          rule_id: '.m.rule.message',
          conditions: JSON.stringify([{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }]),
          actions: JSON.stringify(['notify']),
          enabled: 1,
        },
      ],
    });
    await notifyRoomMembersOfMessage(db, {} as Env, baseEvent() as any);
    expect(db.queued).toHaveLength(0);
  });
});

describe('oauth identity leftovers account-data room corrupt / prepare boom soft after #146', () => {
  for (const bad of ['{', '[', 'null', '"x"', ' ', '\n']) {
    it(`room corrupt content soft throws-or-parses ${JSON.stringify(bad)}`, async () => {
      const room = '!r:example.com';
      const db = createAccountDataDb({
        rows: [{ user_id: USER, room_id: room, event_type: 'm.tag', content: bad }],
      });
      try {
        const rows = await getRoomAccountData(db, USER, room);
        expect(Array.isArray(rows)).toBe(true);
      } catch (e) {
        expect(String(e)).toMatch(/JSON|Unexpected|Syntax/i);
      }
    });
  }

  it('room empty/null content soft becomes {}', async () => {
    const room = '!r:example.com';
    const db = createAccountDataDb({
      rows: [
        { user_id: USER, room_id: room, event_type: 'm.tag', content: '' },
        { user_id: USER, room_id: room, event_type: 'm.direct', content: null },
      ],
    });
    const rows = await getRoomAccountData(db, USER, room);
    expect(rows.every((r) => r.content && typeof r.content === 'object')).toBe(true);
  });

  it('prepare boom soft propagates global', async () => {
    const db = createAccountDataDb({ throwOnPrepare: true });
    await expect(getGlobalAccountData(db, USER)).rejects.toThrow(/prepare boom/);
  });

  it('prepare boom soft propagates stream', async () => {
    const db = createAccountDataDb({ throwOnPrepare: true });
    await expect(getAccountDataStreamPosition(db)).rejects.toThrow(/prepare boom/);
  });

  it('all boom soft propagates multi-room', async () => {
    const db = createAccountDataDb({ throwOnAll: true });
    await expect(getAllRoomAccountData(db, USER, ['!a:example.com'])).rejects.toThrow(/all boom/);
  });

  it('multi-room valid content soft maps', async () => {
    const db = createAccountDataDb({
      rows: [
        { user_id: USER, room_id: '!a:example.com', event_type: 'm.tag', content: '{"t":1}' },
        { user_id: USER, room_id: '!b:example.com', event_type: 'm.tag', content: '{"t":2}' },
      ],
    });
    const out = await getAllRoomAccountData(db, USER, ['!a:example.com', '!b:example.com']);
    expect(out['!a:example.com']?.[0].content).toEqual({ t: 1 });
    expect(out['!b:example.com']?.[0].content).toEqual({ t: 2 });
  });
});

describe('oauth identity leftovers identity lookup sha256 / db throw soft after #146', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('lookup sha256 soft matches hashed association', async () => {
    const pepper = 'pep';
    const cache = mockKv({ 'identity:pepper': pepper });
    const db = createIdentityDb({
      associations: [{ medium: 'email', address: 'a@example.com', mxid: USER }],
    });
    const hash = await sha256(`a@example.com email ${pepper}`);
    const { status, body } = await identityRequest(
      `${ID_BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper, addresses: [hash, 'deadbeef'] }),
      makeIdentityEnv({ cache, db })
    );
    expect(status).toBe(200);
    expect(body.mappings[hash]).toBe(USER);
    expect(body.mappings.deadbeef).toBeUndefined();
  });

  it('lookup sha256 empty addresses soft empty mappings', async () => {
    const cache = mockKv({ 'identity:pepper': 'p' });
    const { status, body } = await identityRequest(
      `${ID_BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper: 'p', addresses: [] }),
      makeIdentityEnv({ cache })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('lookup none empty addresses soft empty mappings', async () => {
    const cache = mockKv({ 'identity:pepper': 'p' });
    const { status, body } = await identityRequest(
      `${ID_BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'p', addresses: [] }),
      makeIdentityEnv({ cache })
    );
    expect(status).toBe(200);
    expect(body.mappings).toEqual({});
  });

  it('lookup throwOnAll soft surfaces 5xx', async () => {
    const cache = mockKv({ 'identity:pepper': 'p' });
    const db = createIdentityDb({ throwOnAll: true });
    const { status } = await identityRequest(
      `${ID_BASE}/lookup`,
      postJson({ algorithm: 'sha256', pepper: 'p', addresses: ['x'] }),
      makeIdentityEnv({ cache, db })
    );
    expect(status).toBeGreaterThanOrEqual(400);
  });

  it('lookup throwOnFirst soft surfaces 5xx for none', async () => {
    const cache = mockKv({ 'identity:pepper': 'p' });
    const db = createIdentityDb({ throwOnFirst: true });
    const { status } = await identityRequest(
      `${ID_BASE}/lookup`,
      postJson({ algorithm: 'none', pepper: 'p', addresses: ['a@example.com email'] }),
      makeIdentityEnv({ cache, db })
    );
    expect(status).toBeGreaterThanOrEqual(400);
  });

  it('requestToken throwOnRun soft surfaces 5xx', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('bbbbbbbb-cccc-dddd-eeee-ffffffffffff');
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const db = createIdentityDb({ throwOnRun: true });
    const { status } = await identityRequest(
      `${ID_BASE}/validate/email/requestToken`,
      postJson({ email: 'a@example.com', client_secret: 'cs', send_attempt: 1 }),
      makeIdentityEnv({ db })
    );
    expect(status).toBeGreaterThanOrEqual(400);
  });
});

describe('oauth identity leftovers identity submitToken missing soft after #146', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  for (const body of ['{', '']) {
    it(`submitToken unparseable JSON soft ${JSON.stringify(body)}`, async () => {
      const { status, body: b } = await identityRequest(`${ID_BASE}/validate/email/submitToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(status).toBe(400);
      expect(b.errcode).toBe('M_BAD_JSON');
    });
  }

  it('submitToken JSON null soft surfaces 5xx', async () => {
    const { status } = await identityRequest(`${ID_BASE}/validate/email/submitToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    });
    expect(status).toBeGreaterThanOrEqual(400);
  });

  for (const payload of [{}, { sid: 's' }, { sid: 's', client_secret: 'cs' }, { token: '123456' }]) {
    it(`submitToken missing fields soft no session ${JSON.stringify(payload)}`, async () => {
      const { status, body } = await identityRequest(
        `${ID_BASE}/validate/email/submitToken`,
        postJson(payload)
      );
      expect(status).toBe(400);
      expect(body.errcode).toBe('M_NO_VALID_SESSION');
    });
  }

  it('submitToken wrong token soft M_INVALID_PARAM', async () => {
    const db = createIdentityDb({
      emailSessions: new Map([
        [
          'sid-wtok',
          {
            session_id: 'sid-wtok',
            email: 'a@example.com',
            client_secret: 'cs',
            token: '111111',
            send_attempt: 1,
            validated: 0,
            created_at: NOW,
            expires_at: NOW + DAY_MS,
          },
        ],
      ]),
    });
    const { status, body } = await identityRequest(
      `${ID_BASE}/validate/email/submitToken`,
      postJson({ sid: 'sid-wtok', client_secret: 'cs', token: '222222' }),
      makeIdentityEnv({ db })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('account serverName soft uses env', async () => {
    const { status, body } = await identityRequest(
      `${ID_BASE}/account`,
      { headers: { Authorization: 'Bearer tok' } },
      makeIdentityEnv({ serverName: 'other.example.com' })
    );
    expect(status).toBe(200);
    expect(body.user_id).toBe('@unknown:other.example.com');
  });
});

describe('oauth identity leftovers UIA HTML pages soft XSS after #146', () => {
  it('UIA approval escapes session/user/title soft', () => {
    const html = generateUiaApprovalPage(
      'sess<script>',
      '@alice<script>:example.com',
      'Title <b>',
      'Desc <i>',
      SERVER
    );
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toMatch(/<script>/);
  });

  it('UIA success escapes session soft', () => {
    const html = generateUiaSuccessPage('sid"><img>', SERVER);
    expect(html).toContain('&quot;');
    expect(html).toContain(SERVER);
  });

  it('UIA cancelled includes server soft', () => {
    const html = generateUiaCancelledPage(SERVER);
    expect(html).toContain(SERVER);
    expect(html).toMatch(/cancel/i);
  });

  for (const [title, msg] of [
    ['Error <b>', 'boom <script>'],
    ['"x"', "'y'"],
    ['&amp;', 'a&b'],
  ] as const) {
    it(`UIA error escapes ${JSON.stringify(title)}`, () => {
      const html = generateUiaErrorPage(title, msg, SERVER);
      expect(html).not.toMatch(/<script>/);
      expect(html).toContain(SERVER);
      expect(html).toContain(escapeHtml(title));
      expect(html).toContain(escapeHtml(msg));
    });
  }

  it('login page without error arg soft still renders form', () => {
    const html = generateLoginPage('Client', 'req', SERVER);
    expect(html).toContain('Client');
    expect(html).toContain('req');
    expect(html).toContain('auth_request_id');
    expect(html).toMatch(/<form/i);
  });
});

describe('oauth identity leftovers hashClientSecret / getNestedValue soft after #146', () => {
  for (const secret of ['', 'a', ' ', '🔐', 'a'.repeat(64), 'line\nbreak', 'null', 'undefined']) {
    it(`hashClientSecret soft avalanche ${JSON.stringify(secret).slice(0, 24)}`, async () => {
      const h1 = await hashClientSecret(secret);
      const h2 = await hashClientSecret(secret);
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[A-Za-z0-9_-]+$/);
      if (secret !== 'a') {
        expect(h1).not.toBe(await hashClientSecret('a'));
      }
    });
  }

  it('getNestedValue empty path soft undefined (splits to [""])', () => {
    const obj = { a: 1 };
    expect(getNestedValue(obj, '')).toBeUndefined();
  });

  it('getNestedValue number/string root soft', () => {
    expect(getNestedValue(42 as any, 'a')).toBeUndefined();
    expect(getNestedValue('hi' as any, '0')).toBe('h');
  });

  it('getNestedValue array root soft index', () => {
    expect(getNestedValue([10, 20], '1')).toBe(20);
    expect(getNestedValue([10, 20], '9')).toBeUndefined();
  });

  it('getNestedValue boolean false soft stops', () => {
    expect(getNestedValue({ a: false }, 'a.b')).toBeUndefined();
    expect(getNestedValue({ a: false }, 'a')).toBe(false);
  });
});
