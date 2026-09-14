/**
 * TOKENMAXX HEAVY leftovers — oauth helpers + push delivery/helpers +
 * account-data helpers + register/available soft edges AFTER #139.
 * Orthogonal to oauth-helpers / oauth-api-route-leftovers / push-delivery /
 * push-rules / account-data-helpers / register-account leftovers /
 * identity-account-register leftovers. Tests only. No product inventing.
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
import login from '../src/api/login';

const SERVER = 'example.com';
const USER = `@alice:${SERVER}`;
const NOW = 1_700_000_000_000;
const PUSH_USER = '@bob:example.com';

type PusherRow = { pushkey: string; kind: string; app_id: string; data: string };
type Queued = {
  user_id: string;
  room_id: string;
  event_id: string;
  notification_type: string;
  actions: string;
};
type Update = { kind: 'success' | 'failure'; ts: number; user_id: string; pushkey: string; app_id: string };

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
}) {
  const rows = [...(opts.rows ?? [])];
  const changes = [...(opts.changes ?? [])];
  const streamPosition = opts.streamPosition === undefined ? 42 : opts.streamPosition;
  const prepares: string[] = [];
  const binds: unknown[][] = [];

  function latestChangePos(userId: string, roomId: string, eventType: string): number {
    return changes
      .filter(
        (c) => c.user_id === userId && c.room_id === roomId && c.event_type === eventType
      )
      .reduce((max, c) => Math.max(max, c.stream_position), -Infinity);
  }

  function stmt(sql: string, args: unknown[] = []) {
    return {
      bind(...bindArgs: unknown[]) {
        binds.push(bindArgs);
        return stmt(sql, bindArgs);
      },
      async all<T>() {
        const isChangeJoin = sql.includes('account_data_changes');
        const isGlobal = sql.includes("room_id = ''");
        const isSingleRoom = !isGlobal && sql.includes('room_id = ?') && !sql.includes('IN (');
        const isMultiRoom = sql.includes('IN (');

        if (sql.includes('FROM account_data') || sql.includes('FROM account_data ad')) {
          if (isMultiRoom) {
            const userId = args[0] as string;
            const since = isChangeJoin ? (args[args.length - 1] as number) : undefined;
            const roomIds = (isChangeJoin ? args.slice(1, -1) : args.slice(1)) as string[];
            const results: Array<{ room_id: string; event_type: string; content: string | null }> =
              [];
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
    get(id: { name: string }) {
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

function createAvailableDb(opts: { usersByLocalpart?: Map<string, UserRow> } = {}) {
  const usersByLocalpart = opts.usersByLocalpart ?? new Map<string, UserRow>();
  const selects: Array<{ sql: string; args: unknown[] }> = [];
  return {
    selects,
    usersByLocalpart,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              if (sql.includes('FROM users WHERE localpart = ?')) {
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
            async all() {
              return { results: [] };
            },
            async run() {
              return { success: true, meta: { changes: 0 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database & {
    selects: Array<{ sql: string; args: unknown[] }>;
    usersByLocalpart: Map<string, UserRow>;
  };
}

function availableEnv(db: ReturnType<typeof createAvailableDb>, serverName = SERVER): Env {
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: serverName,
  } as Env;
}

async function availableRequest(
  env: Env,
  path: string
): Promise<{ status: number; body: any }> {
  const res = await login.request(`http://localhost${path}`, {}, env);
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

const msg = {
  type: 'm.room.message',
  sender: '@bob:example.com',
  content: { body: 'Hello Alice there', msgtype: 'm.text' },
  room_id: '!r:example.com',
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// =============================================================================
// OAuth helper leftovers — generateRandomString reliability
// =============================================================================

describe('oauth leftovers generateRandomString reliability', () => {
  it('length 0 yields empty string deterministically', () => {
    expect(generateRandomString(0)).toBe('');
    expect(generateRandomString(0)).toBe('');
  });

  it('length 1 always yields two lowercase hex digits', () => {
    for (let i = 0; i < 30; i++) {
      expect(generateRandomString(1)).toMatch(/^[0-9a-f]{2}$/);
    }
  });

  it('large length 64 → 128 hex chars without separators', () => {
    const s = generateRandomString(64);
    expect(s.length).toBe(128);
    expect(s).toMatch(/^[0-9a-f]+$/);
  });

  it('successive default calls differ (collision smoke)', () => {
    const a = generateRandomString();
    const b = generateRandomString();
    expect(a).not.toBe(b);
    expect(a.length).toBe(64);
  });

  it('never emits +/= or URL-unsafe punctuation', () => {
    const joined = Array.from({ length: 25 }, () => generateRandomString(24)).join('');
    expect(joined).not.toMatch(/[^0-9a-f]/);
  });
});

// =============================================================================
// OAuth helper leftovers — base64Url encode/decode failure & boundary
// =============================================================================

describe('oauth leftovers base64Url encode/decode failure edges', () => {
  it('round-trips all-zero and all-0xff blocks of length 3..6', () => {
    for (const len of [3, 4, 5, 6]) {
      const z = new Uint8Array(len);
      const f = new Uint8Array(len).fill(255);
      expect(Array.from(base64UrlDecode(base64UrlEncode(z)))).toEqual(Array.from(z));
      expect(Array.from(base64UrlDecode(base64UrlEncode(f)))).toEqual(Array.from(f));
    }
  });

  it('decode rejects invalid alphabet characters with atob Invalid character', () => {
    expect(() => base64UrlDecode('!!!!')).toThrow(/Invalid character/);
    expect(() => base64UrlDecode('@@@@')).toThrow(/Invalid character/);
    expect(() => base64UrlDecode('====')).toThrow();
  });

  it('decode accepts empty string → empty Uint8Array', () => {
    expect(Array.from(base64UrlDecode(''))).toEqual([]);
  });

  it('decode remaps -/_ to +/ before padding', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf]);
    const enc = base64UrlEncode(bytes);
    expect(enc).toContain('-');
    expect(Array.from(base64UrlDecode(enc))).toEqual(Array.from(bytes));
  });

  it('encode strips = padding for lengths that would pad in std base64', () => {
    expect(base64UrlEncode(new Uint8Array([1]))).not.toMatch(/=/);
    expect(base64UrlEncode(new Uint8Array([1, 2]))).not.toMatch(/=/);
    expect(base64UrlEncode(new Uint8Array([1, 2, 3]))).not.toMatch(/=/);
  });

  it('decode of truncated-but-valid short string does not throw', () => {
    const out = base64UrlDecode('abc');
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBeGreaterThan(0);
  });

  it('round-trips unicode text as UTF-8 bytes', () => {
    const bytes = new TextEncoder().encode('пароль-🔐-日本語');
    expect(Array.from(base64UrlDecode(base64UrlEncode(bytes)))).toEqual(Array.from(bytes));
  });
});

// =============================================================================
// OAuth helper leftovers — PKCE method case / whitespace matrix
// =============================================================================

describe('oauth leftovers PKCE method case and whitespace edges', () => {
  it('rejects method casing variants of plain', async () => {
    for (const method of ['Plain', 'PLAIN', 'pLain', ' plain', 'plain ', 'plain\n', 'plain\t']) {
      expect(await verifyCodeChallenge('a', 'a', method)).toBe(false);
    }
  });

  it('rejects method casing variants of S256', async () => {
    const verifier = 'pkce-verifier-case-matrix-0123456789';
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = base64UrlEncode(new Uint8Array(hash));
    for (const method of ['s256', 'S256 ', ' S256', 's256 ', 'Sha256', 'SHA256', 'S-256']) {
      expect(await verifyCodeChallenge(verifier, challenge, method)).toBe(false);
    }
    expect(await verifyCodeChallenge(verifier, challenge, 'S256')).toBe(true);
  });

  it('plain equality is strict; unicode lookalikes fail', async () => {
    expect(await verifyCodeChallenge('café', 'café', 'plain')).toBe(true);
    expect(await verifyCodeChallenge('cafe', 'café', 'plain')).toBe(false);
    expect(await verifyCodeChallenge('a\u0000b', 'a\u0000b', 'plain')).toBe(true);
    expect(await verifyCodeChallenge('a\u0000b', 'ab', 'plain')).toBe(false);
  });

  it('S256 rejects padded / standard-base64 challenge forms', async () => {
    // Verifier chosen so SHA-256 base64url contains - and/or _ (differs from std base64).
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = base64UrlEncode(new Uint8Array(hash));
    expect(challenge).toMatch(/[-_]/);
    const padded = challenge + '=';
    const std = challenge.replace(/-/g, '+').replace(/_/g, '/');
    expect(std).not.toBe(challenge);
    expect(await verifyCodeChallenge(verifier, padded, 'S256')).toBe(false);
    expect(await verifyCodeChallenge(verifier, std, 'S256')).toBe(false);
  });

  it('unknown methods always false even when verifier equals challenge', async () => {
    for (const method of ['', 'none', 'plaintext', 'S512', 'HS256', 'pkce', 'PLAIN ']) {
      expect(await verifyCodeChallenge('same', 'same', method)).toBe(false);
    }
  });

  it('S256 empty verifier has a stable nonempty challenge', async () => {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(''));
    const challenge = base64UrlEncode(new Uint8Array(hash));
    expect(challenge.length).toBe(43);
    expect(await verifyCodeChallenge('', challenge, 'S256')).toBe(true);
    expect(await verifyCodeChallenge('', '', 'S256')).toBe(false);
  });
});

// =============================================================================
// OAuth helper leftovers — hashClientSecret reliability
// =============================================================================

describe('oauth leftovers hashClientSecret reliability', () => {
  it('empty secret hashes to 43-char base64url', async () => {
    const h = await hashClientSecret('');
    expect(h.length).toBe(43);
    expect(h).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('leading/trailing whitespace secrets differ from trimmed', async () => {
    const a = await hashClientSecret('secret');
    const b = await hashClientSecret(' secret');
    const c = await hashClientSecret('secret ');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it('long secret (8KB) hashes without throw', async () => {
    const h = await hashClientSecret('x'.repeat(8192));
    expect(h.length).toBe(43);
  });

  it('null-byte inside secret affects digest', async () => {
    const a = await hashClientSecret('a\0b');
    const b = await hashClientSecret('ab');
    expect(a).not.toBe(b);
  });
});

// =============================================================================
// OAuth helper leftovers — escapeHtml XSS matrix deepen
// =============================================================================

describe('oauth leftovers escapeHtml XSS matrix', () => {
  it('escapes payload (script-tag)', () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
  it('escapes payload (img-onerror)', () => {
    expect(escapeHtml("<img src=x onerror=alert(1)>")).toBe("&lt;img src=x onerror=alert(1)&gt;");
  });
  it('escapes payload (svg-onload)', () => {
    expect(escapeHtml("<svg onload=alert(1)>")).toBe("&lt;svg onload=alert(1)&gt;");
  });
  it('escapes payload (quote-attr)', () => {
    expect(escapeHtml("\" autofocus onfocus=\"alert(1)")).toBe("&quot; autofocus onfocus=&quot;alert(1)");
  });
  it('escapes payload (squote-attr)', () => {
    expect(escapeHtml("' autofocus onfocus='alert(1)")).toBe("&#039; autofocus onfocus=&#039;alert(1)");
  });
  it('escapes payload (amp-entity)', () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
  it('escapes payload (lt-entity)', () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
  it('escapes payload (gt-entity)', () => {
    expect(escapeHtml("&gt;")).toBe("&amp;gt;");
  });
  it('escapes payload (mixed-amp-lt)', () => {
    expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });
  it('escapes payload (javascript-uri)', () => {
    expect(escapeHtml("javascript:alert(1)")).toBe("javascript:alert(1)");
  });
  it('escapes payload (data-uri)', () => {
    expect(escapeHtml("data:text/html,<b>x</b>")).toBe("data:text/html,&lt;b&gt;x&lt;/b&gt;");
  });
  it('escapes payload (template-expr)', () => {
    expect(escapeHtml("${alert(1)}")).toBe("${alert(1)}");
  });
  it('escapes payload (backslash-quote)', () => {
    expect(escapeHtml("\\\"onclick=")).toBe("\\&quot;onclick=");
  });
  it('escapes payload (html-comment)', () => {
    expect(escapeHtml("<!--xss-->")).toBe("&lt;!--xss--&gt;");
  });
  it('escapes payload (meta-refresh)', () => {
    expect(escapeHtml("<meta http-equiv=refresh>")).toBe("&lt;meta http-equiv=refresh&gt;");
  });
  it('escapes payload (iframe)', () => {
    expect(escapeHtml("<iframe src=//x>")).toBe("&lt;iframe src=//x&gt;");
  });
  it('escapes payload (object)', () => {
    expect(escapeHtml("<object data=x>")).toBe("&lt;object data=x&gt;");
  });
  it('escapes payload (embed)', () => {
    expect(escapeHtml("<embed src=x>")).toBe("&lt;embed src=x&gt;");
  });
  it('escapes payload (style-expr)', () => {
    expect(escapeHtml("<style>@import\"x\"")).toBe("&lt;style&gt;@import&quot;x&quot;");
  });
  it('escapes payload (math-ml)', () => {
    expect(escapeHtml("<math><mi>x")).toBe("&lt;math&gt;&lt;mi&gt;x");
  });
  it('escapes payload (full-five)', () => {
    expect(escapeHtml("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#039;");
  });
  it('escapes payload (nullish-looking)', () => {
    expect(escapeHtml("null")).toBe("null");
  });
  it('escapes payload (undefined-looking)', () => {
    expect(escapeHtml("undefined")).toBe("undefined");
  });
  it('escapes repeated mixed metachar runs', () => {
    expect(escapeHtml('<<&>>"\'\'"')).toBe(
      '&lt;&lt;&amp;&gt;&gt;&quot;&#039;&#039;&quot;'
    );
  });

  it('leaves CJK and emoji unchanged while escaping tags around them', () => {
    expect(escapeHtml('你好<script>🚀</script>')).toBe(
      '你好&lt;script&gt;🚀&lt;/script&gt;'
    );
  });

  it('double-escape deepens ampersands each pass', () => {
    const once = escapeHtml('<a>');
    expect(once).toBe('&lt;a&gt;');
    expect(escapeHtml(once)).toBe('&amp;lt;a&amp;gt;');
  });
});

// =============================================================================
// OAuth helper leftovers — HTML page generators soft edges
// =============================================================================

describe('oauth leftovers generateLoginPage soft edges', () => {
  it('truthy whitespace-only error still renders error banner', () => {
    const html = generateLoginPage('C', 'id', 'srv', ' ');
    expect(html).toContain('class="error"');
    expect(html).toContain('<div class="error"> </div>');
  });

  it('long clientName is escaped and embedded', () => {
    const name = 'Client' + '<x>'.repeat(40);
    const html = generateLoginPage(name, 'req', 'srv');
    expect(html).toContain('&lt;x&gt;');
    expect(html).not.toContain('<x>');
  });

  it('authRequestId with ampersand is attribute-safe', () => {
    const html = generateLoginPage('C', 'a&b="c"', 'srv');
    expect(html).toContain('value="a&amp;b=&quot;c&quot;"');
  });

  it('serverName with quotes appears escaped in footer span', () => {
    const html = generateLoginPage('C', 'id', 'srv"onclick=x');
    expect(html).toContain('srv&quot;onclick=x');
  });

  it('omits error div for undefined but not for non-empty zero-width space', () => {
    expect(generateLoginPage('C', 'id', 'srv')).not.toContain('class="error"');
    const zws = generateLoginPage('C', 'id', 'srv', '\u200b');
    expect(zws).toContain('class="error"');
  });
});

describe('oauth leftovers generateUiaApprovalPage soft edges', () => {
  it('userId without @ still yields substring after first char as localpart default', () => {
    const html = generateUiaApprovalPage('s', 'alice:example.com', 'T', 'D', 'srv');
    expect(html).toContain('value="lice"');
  });

  it('userId with only @ yields empty username default', () => {
    const html = generateUiaApprovalPage('s', '@:example.com', 'T', 'D', 'srv');
    expect(html).toMatch(/name="username"[^>]*value=""/);
  });

  it('escapes ampersands in title used in both title tag and h1', () => {
    const html = generateUiaApprovalPage('s', '@a:b', 'A & B', 'D', 'ex.com');
    expect(html).toContain('<title>A &amp; B - ex.com</title>');
    expect(html).toContain('<h1>A &amp; B</h1>');
  });

  it('empty error string is falsy → no error banner', () => {
    const html = generateUiaApprovalPage('s', '@a:b', 'T', 'D', 'srv', '');
    expect(html).not.toContain('class="error"');
  });

  it('description XSS is neutralized in body', () => {
    const html = generateUiaApprovalPage('s', '@a:b', 'T', '<img src=x onerror=1>', 'srv');
    expect(html).toContain('&lt;img src=x onerror=1&gt;');
    expect(html).not.toContain('<img src=x');
  });
});

describe('oauth leftovers generateUiaSuccessPage soft edges', () => {
  it('escapes double-quote session breakouts in script literal', () => {
    const html = generateUiaSuccessPage('x";alert(1)//', 'srv');
    expect(html).toContain('&quot;');
    expect(html).not.toContain('x";alert(1)//');
  });

  it('escapes backtick session ids', () => {
    const html = generateUiaSuccessPage('ab`cd', 'srv');
    expect(html).toContain("session: 'ab`cd'");
  });

  it('serverName XSS neutralized in title', () => {
    const html = generateUiaSuccessPage('s', '<svg/onload=1>');
    expect(html).toContain('&lt;svg/onload=1&gt;');
  });
});

describe('oauth leftovers generateUiaCancelledPage and error page soft edges', () => {
  it('cancelled page always posts uia_cancelled and closes', () => {
    const html = generateUiaCancelledPage('srv');
    expect(html).toContain("type: 'uia_cancelled'");
    expect(html).toContain('window.close()');
  });

  it('cancelled escapes ampersand server names', () => {
    expect(generateUiaCancelledPage('a&b')).toContain('Cancelled - a&amp;b');
  });

  it('error page escapes title and message independently', () => {
    const html = generateUiaErrorPage('<T>', 'msg<script>', 'srv"');
    expect(html).toContain('<h1>&lt;T&gt;</h1>');
    expect(html).toContain('<p>msg&lt;script&gt;</p>');
    expect(html).toContain('srv&quot;');
  });

  it('error page with empty title/message still renders chrome', () => {
    const html = generateUiaErrorPage('', '', 'srv');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<h1></h1>');
    expect(html).toContain('<p></p>');
  });
});

// =============================================================================
// Push leftovers — getNestedValue exotic paths
// =============================================================================

describe('push leftovers getNestedValue exotic paths', () => {
  it('returns undefined walking through boolean/number primitives', () => {
    expect(getNestedValue({ a: true }, 'a.b')).toBeUndefined();
    expect(getNestedValue({ a: 1 }, 'a.b')).toBeUndefined();
    expect(getNestedValue({ a: 'str' }, 'a.b')).toBeUndefined();
  });

  it('reads array-like object keys and numeric string indices', () => {
    expect(getNestedValue({ list: ['a', 'b'] }, 'list.1')).toBe('b');
    expect(getNestedValue({ list: ['a', 'b'] }, 'list.9')).toBeUndefined();
  });

  it('treats consecutive dots as empty-string key segments', () => {
    const obj = { a: { '': { b: 7 } } };
    expect(getNestedValue(obj, 'a..b')).toBe(7);
  });

  it('returns root when path is a single existing key', () => {
    expect(getNestedValue({ type: 'm.room.message' }, 'type')).toBe('m.room.message');
  });

  it('handles deeply nested paths of depth 8', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: 99 } } } } } } } };
    expect(getNestedValue(deep, 'a.b.c.d.e.f.g.h')).toBe(99);
    expect(getNestedValue(deep, 'a.b.c.d.e.f.g.missing')).toBeUndefined();
  });

  it('null root yields undefined for any non-empty path', () => {
    expect(getNestedValue(null, 'a')).toBeUndefined();
    expect(getNestedValue(undefined, 'a')).toBeUndefined();
  });
});

// =============================================================================
// Push leftovers — matchesCondition exotic failure paths
// =============================================================================

describe('push leftovers matchesCondition exotic failure paths', () => {
  it('event_match coerces number values via String()', () => {
    const ev = { ...msg, content: { body: 42 } };
    expect(
      matchesCondition({ kind: 'event_match', key: 'content.body', pattern: '42' }, ev, USER, 2)
    ).toBe(true);
    expect(
      matchesCondition({ kind: 'event_match', key: 'content.body', pattern: '4*' }, ev, USER, 2)
    ).toBe(true);
  });

  it('event_match fails for missing nested key', () => {
    expect(
      matchesCondition(
        { kind: 'event_match', key: 'content.nope', pattern: '*' },
        msg,
        USER,
        2
      )
    ).toBe(false);
  });

  it('room_member_count rejects floats and trailing junk', () => {
    expect(matchesCondition({ kind: 'room_member_count', is: '==2.5' }, msg, USER, 2)).toBe(
      false
    );
    expect(matchesCondition({ kind: 'room_member_count', is: '==2x' }, msg, USER, 2)).toBe(
      false
    );
    expect(matchesCondition({ kind: 'room_member_count', is: '===2' }, msg, USER, 2)).toBe(
      false
    );
  });

  it('room_member_count handles zero and large counts', () => {
    expect(matchesCondition({ kind: 'room_member_count', is: '==0' }, msg, USER, 0)).toBe(true);
    expect(matchesCondition({ kind: 'room_member_count', is: '>0' }, msg, USER, 0)).toBe(false);
    expect(matchesCondition({ kind: 'room_member_count', is: '>=1000' }, msg, USER, 1000)).toBe(
      true
    );
  });

  it('contains_display_name is case-insensitive and substring', () => {
    expect(matchesCondition({ kind: 'contains_display_name' }, msg, USER, 2, 'ALICE')).toBe(
      true
    );
    expect(matchesCondition({ kind: 'contains_display_name' }, msg, USER, 2, 'lice')).toBe(
      true
    );
    expect(
      matchesCondition(
        { kind: 'contains_display_name' },
        { ...msg, content: { body: '' } },
        USER,
        2,
        'alice'
      )
    ).toBe(false);
  });

  it('event_property_is uses strict equality (no coercion)', () => {
    expect(
      matchesCondition(
        { kind: 'event_property_is', key: 'content.msgtype', value: 'm.text' },
        msg,
        USER,
        2
      )
    ).toBe(true);
    expect(
      matchesCondition(
        { kind: 'event_property_is', key: 'content.msgtype', value: true as unknown as string },
        msg,
        USER,
        2
      )
    ).toBe(false);
  });

  it('event_property_contains requires array values', () => {
    expect(
      matchesCondition(
        { kind: 'event_property_contains', key: 'content.body', value: 'Hello' },
        msg,
        USER,
        2
      )
    ).toBe(false);
    const withArr = { ...msg, content: { ...msg.content, tags: ['a', 'b'] } };
    expect(
      matchesCondition(
        { kind: 'event_property_contains', key: 'content.tags', value: 'b' },
        withArr,
        USER,
        2
      )
    ).toBe(true);
  });

  it('unknown condition kinds vacuous-match true', () => {
    expect(matchesCondition({ kind: 'future_kind_xyz' as 'event_match' }, msg, USER, 2)).toBe(
      true
    );
  });
});

describe('push leftovers matchesRule reliability edges', () => {
  it('pattern rules ignore conditions entirely', () => {
    const rule: PushRule = {
      rule_id: 'x',
      default: false,
      enabled: true,
      pattern: 'hello*',
      conditions: [{ kind: 'room_member_count', is: '==999' }],
      actions: ['notify'],
    };
    expect(matchesRule(rule, { content: { body: 'hello world' } }, USER, 2)).toBe(true);
  });

  it('empty conditions array is vacuous every() → true', () => {
    const rule: PushRule = {
      rule_id: 'x',
      default: false,
      enabled: true,
      conditions: [],
      actions: ['notify'],
    };
    expect(matchesRule(rule, msg, USER, 2)).toBe(true);
  });

  it('glob escaping treats regex metachar as literals except *', () => {
    const rule: PushRule = {
      rule_id: 'x',
      default: false,
      enabled: true,
      pattern: 'a(b)',
      actions: ['notify'],
    };
    expect(matchesRule(rule, { content: { body: 'a(b)' } }, USER, 2)).toBe(true);
    expect(matchesRule(rule, { content: { body: 'ab' } }, USER, 2)).toBe(false);
  });

  it('no pattern and no conditions → true', () => {
    const rule: PushRule = {
      rule_id: 'x',
      default: false,
      enabled: true,
      actions: ['dont_notify'],
    };
    expect(matchesRule(rule, msg, USER, 2)).toBe(true);
  });
});

describe('push leftovers evaluatePushRules corrupt JSON reliability', () => {
  it('malformed conditions JSON becomes undefined → vacuous match', async () => {
    const result = await evaluatePushRules(
      pushRulesDb([
        {
          kind: 'override',
          rule_id: 'bad-cond',
          conditions: '{not-json',
          actions: JSON.stringify(['dont_notify']),
          enabled: 1,
        },
      ]),
      USER,
      { type: 'm.room.message', sender: '@x:y', room_id: '!r:y', content: { body: 'hi' } },
      5
    );
    expect(result.notify).toBe(false);
    expect(result.actions).toEqual(['dont_notify']);
  });

  it('malformed actions JSON becomes [] → notify false even if matched', async () => {
    const result = await evaluatePushRules(
      pushRulesDb([
        {
          kind: 'override',
          rule_id: 'bad-act',
          conditions: null,
          actions: 'not-json',
          enabled: 1,
        },
      ]),
      USER,
      { type: 'm.room.message', sender: '@x:y', room_id: '!r:y', content: { body: 'hi' } },
      5
    );
    expect(result.notify).toBe(false);
    expect(result.actions).toEqual([]);
  });

  it('disabled custom override is skipped so defaults still notify', async () => {
    const result = await evaluatePushRules(
      pushRulesDb([
        {
          kind: 'override',
          rule_id: 'quiet',
          conditions: null,
          actions: JSON.stringify(['dont_notify']),
          enabled: 0,
        },
      ]),
      USER,
      {
        type: 'm.room.message',
        sender: '@bob:example.com',
        room_id: '!r:example.com',
        content: { body: 'hi', msgtype: 'm.text' },
      },
      5
    );
    expect(result.notify).toBe(true);
  });
});

// =============================================================================
// Push leftovers — queueNotification / sendPushNotification reliability
// =============================================================================

describe('push leftovers queueNotification edges', () => {
  it('stringifies empty actions array', async () => {
    const db = createPushDb({});
    await queueNotification(db, PUSH_USER, '!r:x', '$e:x', 'notify', []);
    expect(db.queued[0].actions).toBe('[]');
  });

  it('stringifies nested action objects', async () => {
    const db = createPushDb({});
    await queueNotification(db, PUSH_USER, '!r:x', '$e:x', 'highlight', [
      'notify',
      { set_tweak: 'sound', value: 'default' },
    ]);
    expect(JSON.parse(db.queued[0].actions)).toEqual([
      'notify',
      { set_tweak: 'sound', value: 'default' },
    ]);
  });

  it('propagates DB throw from INSERT', async () => {
    const db = createPushDb({ queueThrow: true });
    await expect(
      queueNotification(db, PUSH_USER, '!r:x', '$e:x', 'notify', ['notify'])
    ).rejects.toThrow('queue fail');
  });
});

describe('push leftovers sendPushNotification malformed pusher / kind edges', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ rejected: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('skips non-http kinds and http without url; does not fetch', async () => {
    const db = createPushDb({
      pushers: {
        [PUSH_USER]: [
          { pushkey: '1', kind: 'HTTP', app_id: 'a', data: JSON.stringify({ url: 'https://x' }) },
          { pushkey: '2', kind: 'email', app_id: 'mail', data: '{}' },
          { pushkey: '3', kind: 'http', app_id: 'a', data: '{bad' },
          {
            pushkey: '4',
            kind: 'http',
            app_id: 'a',
            data: JSON.stringify({ format: 'full' }),
          },
          {
            pushkey: '5',
            kind: 'http',
            app_id: 'a',
            data: JSON.stringify({ url: '', format: 'full' }),
          },
          {
            pushkey: '6',
            kind: 'http',
            app_id: 'a',
            data: JSON.stringify({ url: null, format: 'full' }),
          },
        ],
      },
    });
    await sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.updates).toEqual([]);
  });

  it('records failure for gateway 500 / 502 / 503 / 429 / 400 matrix', async () => {
    for (const status of [500, 502, 503, 429, 400]) {
      fetchMock.mockResolvedValueOnce(new Response('err', { status }));
      const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
      await sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 1 });
      expect(db.updates.at(-1)).toMatchObject({ kind: 'failure', ts: NOW });
    }
  });

  it('records failure when fetch rejects with TypeError network down', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Network down'));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 2 });
    expect(db.updates).toEqual([
      expect.objectContaining({ kind: 'failure', user_id: PUSH_USER, pushkey: 'pk' }),
    ]);
  });

  it('continues to next pusher after one malformed JSON', async () => {
    const db = createPushDb({
      pushers: {
        [PUSH_USER]: [
          { pushkey: 'bad', kind: 'http', app_id: 'a', data: '{oops' },
          httpPusher({}, { pushkey: 'good', app_id: 'b' }),
        ],
      },
    });
    await sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.updates).toEqual([
      expect.objectContaining({ kind: 'success', pushkey: 'good', app_id: 'b' }),
    ]);
  });

  it('includes full content when format is absent (not event_id_only)', async () => {
    const db2 = createPushDb({
      pushers: {
        [PUSH_USER]: [
          {
            pushkey: 'pk',
            kind: 'http',
            app_id: 'app',
            data: JSON.stringify({ url: 'https://push.example/g', default_payload: {} }),
          },
        ],
      },
    });
    await sendPushNotification(db2, PUSH_USER, baseEvent({ content: { body: 'full' } }), {
      unread: 1,
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.notification.content).toEqual({ body: 'full' });
  });

  it('uses New message when unencrypted body missing and aps present', async () => {
    const db = createPushDb({
      pushers: { [PUSH_USER]: [httpPusher()] },
    });
    await sendPushNotification(
      db,
      PUSH_USER,
      baseEvent({ content: { msgtype: 'm.text' } }),
      { unread: 1 }
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.notification.devices[0].data.default_payload.aps.alert.body).toBe('New message');
  });

  it('encrypted type sets alert body to room name without content field for event_id_only', async () => {
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(
      db,
      PUSH_USER,
      baseEvent({
        type: 'm.room.encrypted',
        content: { ciphertext: 'x' },
        room_name: 'Secret Room',
        sender_display_name: 'Alice',
      }),
      { unread: 3 }
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.notification.devices[0].data.default_payload.aps.alert).toEqual({
      title: 'Alice',
      body: 'Secret Room',
    });
    expect(body.notification.content).toBeUndefined();
  });

  it('multiple http pushers each get a fetch and success update', async () => {
    const db = createPushDb({
      pushers: {
        [PUSH_USER]: [
          httpPusher({}, { pushkey: 'a', app_id: 'app.a' }),
          httpPusher({}, { pushkey: 'b', app_id: 'app.b' }),
        ],
      },
    });
    await sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(db.updates).toHaveLength(2);
  });

  it('partial APNs env (missing private key) does not take direct path', async () => {
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 1 }, {
      APNS_KEY_ID: 'kid',
      APNS_TEAM_ID: 'team',
    } as Env);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('https://push.example/gateway');
  });
});

describe('push leftovers notifyRoomMembersOfMessage reliability', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ rejected: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('dont_notify override suppresses gateway fetch for members', async () => {
    const db = createPushDb({
      members: ['@c1:example.com', '@c2:example.com'],
      memberCount: 3,
      senderDisplayName: 'Alice',
      roomNameContent: JSON.stringify({ name: 'Room' }),
      pushRules: [
        {
          kind: 'override',
          rule_id: 'quiet',
          conditions: JSON.stringify([
            { kind: 'event_match', key: 'type', pattern: 'm.room.message' },
          ]),
          actions: JSON.stringify(['dont_notify']),
          enabled: 1,
        },
      ],
    });
    await notifyRoomMembersOfMessage(db, {} as Env, baseEvent());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses localpart when display_name null and non-DM room has no name', async () => {
    const db = createPushDb({
      members: [PUSH_USER],
      memberCount: 5,
      senderDisplayName: null,
      roomNameContent: null,
      pushers: { [PUSH_USER]: [httpPusher()] },
    });
    await notifyRoomMembersOfMessage(db, {} as Env, baseEvent({ sender: '@alice:example.com' }));
    expect(fetchMock).toHaveBeenCalled();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.notification.sender_display_name).toBe('alice');
    expect(body.notification.room_name).toBe('Chat');
  });

  it('DM (memberCount===2) uses sender display name as room name', async () => {
    const db = createPushDb({
      members: [PUSH_USER],
      memberCount: 2,
      senderDisplayName: 'Alice Display',
      roomNameContent: null,
      pushers: { [PUSH_USER]: [httpPusher()] },
    });
    await notifyRoomMembersOfMessage(db, {} as Env, baseEvent());
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.notification.room_name).toBe('Alice Display');
  });

  it('invalid room-name JSON is ignored without throwing', async () => {
    const db = createPushDb({
      members: [PUSH_USER],
      memberCount: 4,
      senderDisplayName: 'A',
      roomNameContent: '{not-json',
      pushers: { [PUSH_USER]: [httpPusher()] },
    });
    await notifyRoomMembersOfMessage(db, {} as Env, baseEvent());
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.notification.room_name).toBe('Chat');
  });

  it('queues highlight when matching highlight rule fires', async () => {
    const db = createPushDb({
      members: [PUSH_USER],
      memberCount: 3,
      senderDisplayName: 'A',
      roomNameContent: JSON.stringify({ name: 'R' }),
      pushers: { [PUSH_USER]: [httpPusher()] },
      pushRules: [
        {
          kind: 'override',
          rule_id: 'hl',
          conditions: JSON.stringify([
            { kind: 'event_match', key: 'type', pattern: 'm.room.message' },
          ]),
          actions: JSON.stringify(['notify', { set_tweak: 'highlight', value: true }]),
          enabled: 1,
        },
      ],
    });
    await notifyRoomMembersOfMessage(db, {} as Env, baseEvent());
    expect(db.queued[0].notification_type).toBe('highlight');
  });
});

// =============================================================================
// Account-data leftovers — corrupt JSON / DO failure / since boundaries
// =============================================================================

describe('account-data leftovers corrupt content JSON reliability', () => {
  it('getGlobalAccountData throws on truncated JSON content', async () => {
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.direct', content: '{"a":' }],
    });
    await expect(getGlobalAccountData(db, USER)).rejects.toThrow();
  });

  it('getRoomAccountData throws on invalid JSON content', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '!r:example.com',
          event_type: 'm.fully_read',
          content: 'not-json',
        },
      ],
    });
    await expect(getRoomAccountData(db, USER, '!r:example.com')).rejects.toThrow();
  });

  it('getAllRoomAccountData throws when any room row has corrupt JSON', async () => {
    const db = createAccountDataDb({
      rows: [
        {
          user_id: USER,
          room_id: '!a:example.com',
          event_type: 'm.tag',
          content: '{',
        },
      ],
    });
    await expect(getAllRoomAccountData(db, USER, ['!a:example.com'])).rejects.toThrow();
  });

  it('null content still parses as {} for global full dump', async () => {
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.direct', content: null }],
    });
    const rows = await getGlobalAccountData(db, USER);
    expect(rows).toEqual([{ type: 'm.direct', content: {} }]);
  });

  it('empty string content parses as {}', async () => {
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.direct', content: '' }],
    });
    expect(await getGlobalAccountData(db, USER)).toEqual([
      { type: 'm.direct', content: {} },
    ]);
  });
});

describe('account-data leftovers DO failure reliability', () => {
  it('surfaces 500 with body text', async () => {
    const USER_KEYS = mockUserKeysNamespace({
      responses: new Map([['__all__', new Response('boom', { status: 500 })]]),
    });
    await expect(
      getE2EEAccountDataFromDO({ USER_KEYS } as unknown as Env, USER)
    ).rejects.toThrow(/DO get failed: 500 - boom/);
  });

  it('surfaces 503 and 404 distinctly', async () => {
    for (const status of [503, 404, 502]) {
      const USER_KEYS = mockUserKeysNamespace({
        responses: new Map([
          ['m.secret_storage.default_key', new Response(`e${status}`, { status })],
        ]),
      });
      await expect(
        getE2EEAccountDataFromDO(
          { USER_KEYS } as unknown as Env,
          USER,
          'm.secret_storage.default_key'
        )
      ).rejects.toThrow(new RegExp(`DO get failed: ${status}`));
    }
  });

  it('uses unknown error when text() rejects on non-OK', async () => {
    const USER_KEYS = mockUserKeysNamespace({
      responses: new Map([
        [
          '__all__',
          () =>
            ({
              ok: false,
              status: 500,
              text: async () => {
                throw new Error('read fail');
              },
            }) as unknown as Response,
        ],
      ]),
    });
    await expect(
      getE2EEAccountDataFromDO({ USER_KEYS } as unknown as Env, USER)
    ).rejects.toThrow(/unknown error/);
  });

  it('propagates stub fetch network errors', async () => {
    const USER_KEYS = mockUserKeysNamespace({
      throwOnFetch: new Error('DO offline'),
    });
    await expect(
      getE2EEAccountDataFromDO({ USER_KEYS } as unknown as Env, USER)
    ).rejects.toThrow('DO offline');
  });

  it('returns parsed JSON null body as null', async () => {
    const USER_KEYS = mockUserKeysNamespace({
      responses: new Map([['__all__', new Response('null', { status: 200 })]]),
    });
    expect(await getE2EEAccountDataFromDO({ USER_KEYS } as unknown as Env, USER)).toBeNull();
  });

  it('encodes plus and space in eventType query', async () => {
    const USER_KEYS = mockUserKeysNamespace({ responses: new Map() });
    await getE2EEAccountDataFromDO(
      { USER_KEYS } as unknown as Env,
      USER,
      'm.type with spaces+plus'
    );
    expect(USER_KEYS.fetches[0].url).toContain(encodeURIComponent('m.type with spaces+plus'));
  });
});

describe('account-data leftovers since / stream boundary reliability', () => {
  it('since equal to change pos excludes; since-1 includes', async () => {
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.direct', content: '{}' }],
      changes: [
        { user_id: USER, room_id: '', event_type: 'm.direct', stream_position: 10 },
      ],
    });
    expect(await getGlobalAccountData(db, USER, 10)).toEqual([]);
    expect(await getGlobalAccountData(db, USER, 9)).toEqual([
      { type: 'm.direct', content: {} },
    ]);
  });

  it('since 0 incremental includes pos>0 only', async () => {
    const db = createAccountDataDb({
      rows: [
        { user_id: USER, room_id: '', event_type: 'm.direct', content: '{}' },
        { user_id: USER, room_id: '', event_type: 'm.ignored_user_list', content: '{}' },
      ],
      changes: [
        { user_id: USER, room_id: '', event_type: 'm.direct', stream_position: 0 },
        { user_id: USER, room_id: '', event_type: 'm.ignored_user_list', stream_position: 1 },
      ],
    });
    const rows = await getGlobalAccountData(db, USER, 0);
    expect(rows.map((r) => r.type)).toEqual(['m.ignored_user_list']);
  });

  it('getAccountDataStreamPosition treats null and 0 as 0', async () => {
    expect(await getAccountDataStreamPosition(createAccountDataDb({ streamPosition: null }))).toBe(
      0
    );
    expect(await getAccountDataStreamPosition(createAccountDataDb({ streamPosition: 0 }))).toBe(0);
    expect(await getAccountDataStreamPosition(createAccountDataDb({ streamPosition: 999 }))).toBe(
      999
    );
  });

  it('prepare throw propagates from getGlobalAccountData', async () => {
    const db = createAccountDataDb({ throwOnPrepare: true });
    await expect(getGlobalAccountData(db, USER)).rejects.toThrow('prepare boom');
  });

  it('getAllRoomAccountData empty roomIds never prepares', async () => {
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '!r:x', event_type: 'm.tag', content: '{}' }],
    });
    expect(await getAllRoomAccountData(db, USER, [])).toEqual({});
    expect(db.prepares).toEqual([]);
  });

  it('room incremental respects strict > at boundary', async () => {
    const room = '!r:example.com';
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: room, event_type: 'm.tag', content: '{"tags":{}}' }],
      changes: [{ user_id: USER, room_id: room, event_type: 'm.tag', stream_position: 5 }],
    });
    expect(await getRoomAccountData(db, USER, room, 5)).toEqual([]);
    expect(await getRoomAccountData(db, USER, room, 4)).toEqual([
      { type: 'm.tag', content: { tags: {} } },
    ]);
  });
});

describe('account-data leftovers multi-room soft edges', () => {
  it('groups two rooms independently on full dump', async () => {
    const db = createAccountDataDb({
      rows: [
        { user_id: USER, room_id: '!a:x', event_type: 'm.tag', content: '{"tags":{"a":{}}}' },
        { user_id: USER, room_id: '!b:x', event_type: 'm.tag', content: '{"tags":{"b":{}}}' },
      ],
    });
    const byRoom = await getAllRoomAccountData(db, USER, ['!a:x', '!b:x', '!quiet:x']);
    expect(Object.keys(byRoom).sort()).toEqual(['!a:x', '!b:x']);
    expect(byRoom['!a:x'][0].content).toEqual({ tags: { a: {} } });
  });

  it('incremental multi-room excludes equal since', async () => {
    const db = createAccountDataDb({
      rows: [
        { user_id: USER, room_id: '!a:x', event_type: 'm.tag', content: '{}' },
      ],
      changes: [
        { user_id: USER, room_id: '!a:x', event_type: 'm.tag', stream_position: 7 },
      ],
    });
    expect(await getAllRoomAccountData(db, USER, ['!a:x'], 7)).toEqual({});
    expect(await getAllRoomAccountData(db, USER, ['!a:x'], 6)).toEqual({
      '!a:x': [{ type: 'm.tag', content: {} }],
    });
  });
});

// =============================================================================
// Register leftovers — /register/available soft query & charset edges
// =============================================================================

describe('register leftovers available soft query edges', () => {
  it('missing username → M_MISSING_PARAM', async () => {
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      '/_matrix/client/v3/register/available'
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_MISSING_PARAM');
  });

  it('empty username → M_MISSING_PARAM (falsy)', async () => {
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      '/_matrix/client/v3/register/available?username='
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_MISSING_PARAM');
  });

  it('duplicate username query uses first value', async () => {
    const db = createAvailableDb();
    const { status, body } = await availableRequest(
      availableEnv(db),
      '/_matrix/client/v3/register/available?username=first&username=second'
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
    expect(db.selects[0].args).toEqual(['first']);
  });

  it('taken localpart → M_USER_IN_USE', async () => {
    const db = createAvailableDb({
      usersByLocalpart: new Map([
        ['alice', userRow({ user_id: USER, localpart: 'alice' })],
      ]),
    });
    const { status, body } = await availableRequest(
      availableEnv(db),
      '/_matrix/client/v3/register/available?username=alice'
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_USER_IN_USE');
  });

  it('255 boundary accepted; 256 rejected', async () => {
    const env = availableEnv(createAvailableDb());
    const ok = await availableRequest(
      env,
      `/_matrix/client/v3/register/available?username=${'a'.repeat(255)}`
    );
    expect(ok.status).toBe(200);
    const bad = await availableRequest(
      env,
      `/_matrix/client/v3/register/available?username=${'a'.repeat(256)}`
    );
    expect(bad.status).toBe(400);
    expect(bad.body.errcode).toBe('M_INVALID_USERNAME');
  });
});

describe('register leftovers available soft charset edges', () => {
  it('rejects soft-invalid localpart (upper-mid)', async () => {
    const username = "alIce";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (upper-all)', async () => {
    const username = "ALICE";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (space-mid)', async () => {
    const username = "a b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (at-full)', async () => {
    const username = "@alice:example.com";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (colon-mid)', async () => {
    const username = "a:b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (plus)', async () => {
    const username = "a+b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (bang)', async () => {
    const username = "a!b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (hash)', async () => {
    const username = "a#b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (dollar)', async () => {
    const username = "a$b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (percent)', async () => {
    const username = "a%b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (amp)', async () => {
    const username = "a&b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (star)', async () => {
    const username = "a*b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (qmark)', async () => {
    const username = "a?b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (caret)', async () => {
    const username = "a^b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (pipe)', async () => {
    const username = "a|b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (tilde)', async () => {
    const username = "a~b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (backtick)', async () => {
    const username = "a`b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (brace-l)', async () => {
    const username = "a{b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (brace-r)', async () => {
    const username = "a}b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (bracket-l)', async () => {
    const username = "a[b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (bracket-r)', async () => {
    const username = "a]b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (paren-l)', async () => {
    const username = "a(b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (paren-r)', async () => {
    const username = "a)b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (comma)', async () => {
    const username = "a,b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (semi)', async () => {
    const username = "a;b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (squote)', async () => {
    const username = "a'b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (dquote)', async () => {
    const username = "a\"b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (backslash)', async () => {
    const username = "a\\b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (lt)', async () => {
    const username = "a<b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (gt)', async () => {
    const username = "a>b";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (unicode-umlaut)', async () => {
    const username = "\u00e4";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (unicode-cjk)', async () => {
    const username = "\u7528\u6237";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (emoji)', async () => {
    const username = "user\ud83d\ude00";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (newline)', async () => {
    const username = "a\nb";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (tab)', async () => {
    const username = "a\tb";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
  it('rejects soft-invalid localpart (cr)', async () => {
    const username = "a\rb";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_USERNAME');
  });
});

describe('register leftovers available soft valid charset edges', () => {
  it('accepts soft-valid localpart (digits-only)', async () => {
    const username = "12345";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('accepts soft-valid localpart (leading-digit)', async () => {
    const username = "0alice";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('accepts soft-valid localpart (all-allowed-specials)', async () => {
    const username = "a.b_c-d=e/f";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('accepts soft-valid localpart (single-slash)', async () => {
    const username = "/";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('accepts soft-valid localpart (single-eq)', async () => {
    const username = "=";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('accepts soft-valid localpart (single-dot)', async () => {
    const username = ".";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('accepts soft-valid localpart (single-underscore)', async () => {
    const username = "_";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('accepts soft-valid localpart (single-hyphen)', async () => {
    const username = "-";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('accepts soft-valid localpart (mixed-long)', async () => {
    const username = "user.name_1-2=3/4";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('accepts soft-valid localpart (trailing-slash)', async () => {
    const username = "alice/";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
  it('accepts soft-valid localpart (leading-underscore)', async () => {
    const username = "_alice";
    const { status, body } = await availableRequest(
      availableEnv(createAvailableDb()),
      `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });
});

describe('register leftovers available bind reliability', () => {
  it('binds exact localpart without lowercasing (uppercase already invalid)', async () => {
    const db = createAvailableDb();
    await availableRequest(
      availableEnv(db),
      '/_matrix/client/v3/register/available?username=good.user_1'
    );
    const localpartSelects = db.selects.filter((s) => s.sql.includes('localpart = ?'));
    expect(localpartSelects).toHaveLength(1);
    expect(localpartSelects[0].args).toEqual(['good.user_1']);
  });

  it('does not query DB when charset invalid', async () => {
    const db = createAvailableDb();
    await availableRequest(
      availableEnv(db),
      '/_matrix/client/v3/register/available?username=Bad'
    );
    expect(db.selects.filter((s) => s.sql.includes('localpart'))).toHaveLength(0);
  });

  it('SERVER_NAME is unused for available true response shape', async () => {
    const { body } = await availableRequest(
      availableEnv(createAvailableDb(), 'other.server'),
      '/_matrix/client/v3/register/available?username=fresh'
    );
    expect(body).toEqual({ available: true });
  });
});

// =============================================================================
// Soft-cap flood — oauth page XSS field matrix
// =============================================================================

describe('oauth leftovers login page XSS field matrix flood', () => {
  it('login XSS client matrix #0', () => {
    const html = generateLoginPage("client<script>", 'req', 'srv');
    expect(html).toContain(escapeHtml("client<script>"));
    expect(html).not.toContain('<script>');
  });
  it('login XSS client matrix #1', () => {
    const html = generateLoginPage("client\"onmouseover=x", 'req', 'srv');
    expect(html).toContain(escapeHtml("client\"onmouseover=x"));
    expect(html).not.toContain('<script>');
  });
  it('login XSS client matrix #2', () => {
    const html = generateLoginPage("client'onfocus=x", 'req', 'srv');
    expect(html).toContain(escapeHtml("client'onfocus=x"));
    expect(html).not.toContain('<script>');
  });
  it('login XSS client matrix #3', () => {
    const html = generateLoginPage("client&amp;", 'req', 'srv');
    expect(html).toContain(escapeHtml("client&amp;"));
    expect(html).not.toContain('<script>');
  });
  it('login XSS client matrix #4', () => {
    const html = generateLoginPage("client<>&\"'", 'req', 'srv');
    expect(html).toContain(escapeHtml("client<>&\"'"));
    expect(html).not.toContain('<script>');
  });
  it('login XSS error matrix #0', () => {
    const html = generateLoginPage('C', 'id', 'srv', "<b>e</b>");
    expect(html).toContain('class="error"');
    expect(html).toContain(escapeHtml("<b>e</b>"));
  });
  it('login XSS error matrix #1', () => {
    const html = generateLoginPage('C', 'id', 'srv', "e&f");
    expect(html).toContain('class="error"');
    expect(html).toContain(escapeHtml("e&f"));
  });
  it('login XSS error matrix #2', () => {
    const html = generateLoginPage('C', 'id', 'srv', "\"e\"");
    expect(html).toContain('class="error"');
    expect(html).toContain(escapeHtml("\"e\""));
  });
  it('login XSS error matrix #3', () => {
    const html = generateLoginPage('C', 'id', 'srv', "'e'");
    expect(html).toContain('class="error"');
    expect(html).toContain(escapeHtml("'e'"));
  });
  it('login XSS error matrix #4', () => {
    const html = generateLoginPage('C', 'id', 'srv', "e<>");
    expect(html).toContain('class="error"');
    expect(html).toContain(escapeHtml("e<>"));
  });
});

describe('oauth leftovers uia pages XSS flood', () => {
  it('uia approval session XSS #0', () => {
    const html = generateUiaApprovalPage("s<script>", '@a:b', 'T', 'D', 'srv');
    expect(html).toContain(escapeHtml("s<script>"));
  });
  it('uia approval session XSS #1', () => {
    const html = generateUiaApprovalPage("s\"x", '@a:b', 'T', 'D', 'srv');
    expect(html).toContain(escapeHtml("s\"x"));
  });
  it('uia approval session XSS #2', () => {
    const html = generateUiaApprovalPage("s'x", '@a:b', 'T', 'D', 'srv');
    expect(html).toContain(escapeHtml("s'x"));
  });
  it('uia approval session XSS #3', () => {
    const html = generateUiaApprovalPage("s&x", '@a:b', 'T', 'D', 'srv');
    expect(html).toContain(escapeHtml("s&x"));
  });
  it('uia approval session XSS #4', () => {
    const html = generateUiaApprovalPage("s<>", '@a:b', 'T', 'D', 'srv');
    expect(html).toContain(escapeHtml("s<>"));
  });
  it('uia success session XSS #0', () => {
    const html = generateUiaSuccessPage("ok", 'srv');
    expect(html).toContain('Request Approved');
    expect(html).toContain(escapeHtml("ok"));
  });
  it('uia success session XSS #1', () => {
    const html = generateUiaSuccessPage("x'y", 'srv');
    expect(html).toContain('Request Approved');
    expect(html).toContain(escapeHtml("x'y"));
  });
  it('uia success session XSS #2', () => {
    const html = generateUiaSuccessPage("x\"y", 'srv');
    expect(html).toContain('Request Approved');
    expect(html).toContain(escapeHtml("x\"y"));
  });
  it('uia success session XSS #3', () => {
    const html = generateUiaSuccessPage("x&y", 'srv');
    expect(html).toContain('Request Approved');
    expect(html).toContain(escapeHtml("x&y"));
  });
  it('uia success session XSS #4', () => {
    const html = generateUiaSuccessPage("<x>", 'srv');
    expect(html).toContain('Request Approved');
    expect(html).toContain(escapeHtml("<x>"));
  });
  it('uia cancelled server XSS #0', () => {
    const html = generateUiaCancelledPage("s");
    expect(html).toContain(escapeHtml("s"));
  });
  it('uia cancelled server XSS #1', () => {
    const html = generateUiaCancelledPage("s&");
    expect(html).toContain(escapeHtml("s&"));
  });
  it('uia cancelled server XSS #2', () => {
    const html = generateUiaCancelledPage("s<");
    expect(html).toContain(escapeHtml("s<"));
  });
  it('uia cancelled server XSS #3', () => {
    const html = generateUiaCancelledPage("s\"");
    expect(html).toContain(escapeHtml("s\""));
  });
  it('uia cancelled server XSS #4', () => {
    const html = generateUiaCancelledPage("s'");
    expect(html).toContain(escapeHtml("s'"));
  });
  it('uia error title/message XSS #0', () => {
    const html = generateUiaErrorPage("T<script>", "M", 'srv');
    expect(html).toContain(escapeHtml("T<script>"));
    expect(html).toContain(escapeHtml("M"));
  });
  it('uia error title/message XSS #1', () => {
    const html = generateUiaErrorPage("T", "M<script>", 'srv');
    expect(html).toContain(escapeHtml("T"));
    expect(html).toContain(escapeHtml("M<script>"));
  });
  it('uia error title/message XSS #2', () => {
    const html = generateUiaErrorPage("T&", "M&", 'srv');
    expect(html).toContain(escapeHtml("T&"));
    expect(html).toContain(escapeHtml("M&"));
  });
  it('uia error title/message XSS #3', () => {
    const html = generateUiaErrorPage("T\"", "M\"", 'srv');
    expect(html).toContain(escapeHtml("T\""));
    expect(html).toContain(escapeHtml("M\""));
  });
  it('uia error title/message XSS #4', () => {
    const html = generateUiaErrorPage("T'", "M'", 'srv');
    expect(html).toContain(escapeHtml("T'"));
    expect(html).toContain(escapeHtml("M'"));
  });
});

describe('push leftovers gateway status soft-cap flood', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  it('gateway status 401 pins last_failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 401 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 1 });
    expect(db.updates[0]).toMatchObject({ kind: 'failure', ts: NOW, user_id: PUSH_USER });
  });
  it('gateway status 403 pins last_failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 403 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 1 });
    expect(db.updates[0]).toMatchObject({ kind: 'failure', ts: NOW, user_id: PUSH_USER });
  });
  it('gateway status 404 pins last_failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 1 });
    expect(db.updates[0]).toMatchObject({ kind: 'failure', ts: NOW, user_id: PUSH_USER });
  });
  it('gateway status 408 pins last_failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 408 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 1 });
    expect(db.updates[0]).toMatchObject({ kind: 'failure', ts: NOW, user_id: PUSH_USER });
  });
  it('gateway status 413 pins last_failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 413 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 1 });
    expect(db.updates[0]).toMatchObject({ kind: 'failure', ts: NOW, user_id: PUSH_USER });
  });
  it('gateway status 500 pins last_failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 1 });
    expect(db.updates[0]).toMatchObject({ kind: 'failure', ts: NOW, user_id: PUSH_USER });
  });
  it('gateway status 502 pins last_failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 502 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 1 });
    expect(db.updates[0]).toMatchObject({ kind: 'failure', ts: NOW, user_id: PUSH_USER });
  });
  it('gateway status 503 pins last_failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 503 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 1 });
    expect(db.updates[0]).toMatchObject({ kind: 'failure', ts: NOW, user_id: PUSH_USER });
  });
  it('gateway status 504 pins last_failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 504 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 1 });
    expect(db.updates[0]).toMatchObject({ kind: 'failure', ts: NOW, user_id: PUSH_USER });
  });
  it('gateway status 520 pins last_failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 520 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 1 });
    expect(db.updates[0]).toMatchObject({ kind: 'failure', ts: NOW, user_id: PUSH_USER });
  });
  it('gateway 200 with rejected tokens still counts as success path', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ rejected: ['pk'] }), { status: 200 })
    );
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 1 });
    expect(db.updates[0].kind).toBe('success');
  });
});

describe('oauth leftovers PKCE soft-cap method flood', () => {
  it('rejects PKCE method "PLAIN"', async () => {
    expect(await verifyCodeChallenge('v', 'v', "PLAIN")).toBe(false);
  });
  it('rejects PKCE method "Plain"', async () => {
    expect(await verifyCodeChallenge('v', 'v', "Plain")).toBe(false);
  });
  it('rejects PKCE method "pLAIN"', async () => {
    expect(await verifyCodeChallenge('v', 'v', "pLAIN")).toBe(false);
  });
  it('rejects PKCE method " plain"', async () => {
    expect(await verifyCodeChallenge('v', 'v', " plain")).toBe(false);
  });
  it('rejects PKCE method "plain\r"', async () => {
    expect(await verifyCodeChallenge('v', 'v', "plain\r")).toBe(false);
  });
  it('rejects PKCE method "S256\n"', async () => {
    expect(await verifyCodeChallenge('v', 'v', "S256\n")).toBe(false);
  });
  it('rejects PKCE method "s256"', async () => {
    expect(await verifyCodeChallenge('v', 'v', "s256")).toBe(false);
  });
  it('rejects PKCE method "S 256"', async () => {
    expect(await verifyCodeChallenge('v', 'v', "S 256")).toBe(false);
  });
  it('rejects PKCE method "sha-256"', async () => {
    expect(await verifyCodeChallenge('v', 'v', "sha-256")).toBe(false);
  });
  it('rejects PKCE method "SHA-256"', async () => {
    expect(await verifyCodeChallenge('v', 'v', "SHA-256")).toBe(false);
  });
  it('rejects PKCE method "pkce-s256"', async () => {
    expect(await verifyCodeChallenge('v', 'v', "pkce-s256")).toBe(false);
  });
  it('rejects PKCE method "none"', async () => {
    expect(await verifyCodeChallenge('v', 'v', "none")).toBe(false);
  });
  it('rejects PKCE method "implicit"', async () => {
    expect(await verifyCodeChallenge('v', 'v', "implicit")).toBe(false);
  });
  it('rejects PKCE method "HS256"', async () => {
    expect(await verifyCodeChallenge('v', 'v', "HS256")).toBe(false);
  });
});

describe('push leftovers getNestedValue soft-cap flood', () => {
  it('nested soft case #1', () => {
    expect(getNestedValue({ a: 1 }, 'a')).toBe(1);
  });
  it('nested soft case #2', () => {
    expect(getNestedValue({ a: { b: 2 } }, 'a.b')).toBe(2);
  });
  it('nested soft case #3', () => {
    expect(getNestedValue({ a: { b: null } }, 'a.b')).toBe(null);
  });
  it('nested soft case #4', () => {
    expect(getNestedValue({ a: { b: null } }, 'a.b.c')).toBeUndefined();
  });
  it('nested soft case #5', () => {
    expect(getNestedValue({ a: [10, 20] }, 'a.0')).toBe(10);
  });
  it('nested soft case #6', () => {
    expect(getNestedValue({ a: [10, 20] }, 'a.2')).toBeUndefined();
  });
  it('nested soft case #7', () => {
    expect(getNestedValue({ '': 5 }, '')).toBe(5);
  });
  it('nested soft case #8', () => {
    expect(getNestedValue({ x: { y: { z: 'ok' } } }, 'x.y.z')).toBe('ok');
  });
  it('nested soft case #9', () => {
    expect(getNestedValue(null, 'a')).toBeUndefined();
  });
  it('nested soft case #10', () => {
    expect(getNestedValue({ a: false }, 'a.x')).toBeUndefined();
  });
});

describe('oauth leftovers hash/random soft-cap flood', () => {
  it('hashClientSecret soft #0 length stable', async () => {
    const h = await hashClientSecret("0");
    expect(h.length).toBe(43);
    expect(await hashClientSecret("0")).toBe(h);
  });
  it('hashClientSecret soft #1 length stable', async () => {
    const h = await hashClientSecret("1");
    expect(h.length).toBe(43);
    expect(await hashClientSecret("1")).toBe(h);
  });
  it('hashClientSecret soft #2 length stable', async () => {
    const h = await hashClientSecret("a");
    expect(h.length).toBe(43);
    expect(await hashClientSecret("a")).toBe(h);
  });
  it('hashClientSecret soft #3 length stable', async () => {
    const h = await hashClientSecret("A");
    expect(h.length).toBe(43);
    expect(await hashClientSecret("A")).toBe(h);
  });
  it('hashClientSecret soft #4 length stable', async () => {
    const h = await hashClientSecret(" ");
    expect(h.length).toBe(43);
    expect(await hashClientSecret(" ")).toBe(h);
  });
  it('hashClientSecret soft #5 length stable', async () => {
    const h = await hashClientSecret("\t");
    expect(h.length).toBe(43);
    expect(await hashClientSecret("\t")).toBe(h);
  });
  it('hashClientSecret soft #6 length stable', async () => {
    const h = await hashClientSecret("\ud83d\udd10");
    expect(h.length).toBe(43);
    expect(await hashClientSecret("\ud83d\udd10")).toBe(h);
  });
  it('hashClientSecret soft #7 length stable', async () => {
    const h = await hashClientSecret("\u00e4\u00e4");
    expect(h.length).toBe(43);
    expect(await hashClientSecret("\u00e4\u00e4")).toBe(h);
  });
  it('hashClientSecret soft #8 length stable', async () => {
    const h = await hashClientSecret("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(h.length).toBe(43);
    expect(await hashClientSecret("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toBe(h);
  });
  it('generateRandomString length 2 → 4 hex', () => {
    const s = generateRandomString(2);
    expect(s.length).toBe(4);
    expect(s).toMatch(/^[0-9a-f]+$/);
  });
  it('generateRandomString length 3 → 6 hex', () => {
    const s = generateRandomString(3);
    expect(s.length).toBe(6);
    expect(s).toMatch(/^[0-9a-f]+$/);
  });
  it('generateRandomString length 7 → 14 hex', () => {
    const s = generateRandomString(7);
    expect(s.length).toBe(14);
    expect(s).toMatch(/^[0-9a-f]+$/);
  });
  it('generateRandomString length 15 → 30 hex', () => {
    const s = generateRandomString(15);
    expect(s.length).toBe(30);
    expect(s).toMatch(/^[0-9a-f]+$/);
  });
  it('generateRandomString length 31 → 62 hex', () => {
    const s = generateRandomString(31);
    expect(s.length).toBe(62);
    expect(s).toMatch(/^[0-9a-f]+$/);
  });
  it('generateRandomString length 33 → 66 hex', () => {
    const s = generateRandomString(33);
    expect(s.length).toBe(66);
    expect(s).toMatch(/^[0-9a-f]+$/);
  });
});

// =============================================================================
// Soft-cap flood continuation — oauth / push / account-data / register edges
// =============================================================================

describe('oauth leftovers base64Url decode soft failure flood', () => {
  it('decode rejects space in middle', () => {
    expect(() => base64UrlDecode('ab cd')).toThrow();
  });
  it('decode rejects newline', () => {
    expect(() => base64UrlDecode('abcd\n')).toThrow();
  });
  it('decode rejects tab', () => {
    expect(() => base64UrlDecode('ab\tcd')).toThrow();
  });
  it('decode rejects curly braces', () => {
    expect(() => base64UrlDecode('{abc}')).toThrow();
  });
  it('decode rejects percent encoding literal', () => {
    expect(() => base64UrlDecode('%2B%2F')).toThrow();
  });
  it('encode empty Uint8Array → empty string', () => {
    expect(base64UrlEncode(new Uint8Array(0))).toBe('');
  });
  it('round-trip length 1 and 2 soft', () => {
    for (const len of [1, 2]) {
      const src = new Uint8Array(len).map((_, i) => (i + 7) & 0xff);
      expect(Array.from(base64UrlDecode(base64UrlEncode(src)))).toEqual(Array.from(src));
    }
  });
  it('encode never emits + or / for high bytes', () => {
    const enc = base64UrlEncode(new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]));
    expect(enc).not.toMatch(/[+/]/);
    expect(enc).toMatch(/[-_A-Za-z0-9]+/);
  });
});

describe('oauth leftovers PKCE plain/S256 soft verifier edges', () => {
  it('plain rejects unequal verifier/challenge', async () => {
    expect(await verifyCodeChallenge('aaa', 'bbb', 'plain')).toBe(false);
  });
  it('plain accepts identical empty strings', async () => {
    expect(await verifyCodeChallenge('', '', 'plain')).toBe(true);
  });
  it('plain is case-sensitive on verifier', async () => {
    expect(await verifyCodeChallenge('AbC', 'abc', 'plain')).toBe(false);
    expect(await verifyCodeChallenge('abc', 'abc', 'plain')).toBe(true);
  });
  it('S256 rejects wrong challenge for known verifier', async () => {
    expect(await verifyCodeChallenge('verifier-1', 'not-the-hash', 'S256')).toBe(false);
  });
  it('S256 accepts recomputed challenge', async () => {
    const verifier = 'soft-cap-verifier-xyz';
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = base64UrlEncode(new Uint8Array(hash));
    expect(await verifyCodeChallenge(verifier, challenge, 'S256')).toBe(true);
  });
  it('S256 rejects challenge with trailing padding = leftover', async () => {
    const verifier = 'pad-check';
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = base64UrlEncode(new Uint8Array(hash)) + '=';
    expect(await verifyCodeChallenge(verifier, challenge, 'S256')).toBe(false);
  });
  it('empty method always fails even when plain would match', async () => {
    expect(await verifyCodeChallenge('x', 'x', '')).toBe(false);
  });
});

describe('oauth leftovers escapeHtml compound reliability flood', () => {
  it('escapes ampersand before other entities (order soft)', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#039;');
  });
  it('double-escape of already-escaped amp stays literal amp entity text', () => {
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });
  it('empty string stays empty', () => {
    expect(escapeHtml('')).toBe('');
  });
  it('no-op for alphanumeric', () => {
    expect(escapeHtml('Alice123')).toBe('Alice123');
  });
  it('escapes each quote independently in sequence', () => {
    expect(escapeHtml('""\'\'')).toBe('&quot;&quot;&#039;&#039;');
  });
  it('login page embeds escaped error without raw angle brackets', () => {
    const html = generateLoginPage('c', 'r', 's', '<img src=x onerror=1>');
    expect(html).toContain(escapeHtml('<img src=x onerror=1>'));
    expect(html).not.toContain('<img src=x onerror=1>');
  });
  it('uia cancelled page embeds escaped server name', () => {
    const html = generateUiaCancelledPage('srv<script>');
    expect(html).toContain(escapeHtml('srv<script>'));
    expect(html).not.toContain('srv<script>');
    expect(html).toContain('<title>Cancelled - srv&lt;script&gt;</title>');
  });
});

describe('push leftovers room_member_count operator soft edges', () => {
  const base = { type: 'm.room.message', content: {}, sender: '@a:x', room_id: '!r:x' };

  it('== exact match', () => {
    expect(
      matchesCondition({ kind: 'room_member_count', is: '==3' }, base, USER, 3)
    ).toBe(true);
    expect(
      matchesCondition({ kind: 'room_member_count', is: '==3' }, base, USER, 2)
    ).toBe(false);
  });
  it('bare number defaults to ==', () => {
    expect(matchesCondition({ kind: 'room_member_count', is: '2' }, base, USER, 2)).toBe(true);
    expect(matchesCondition({ kind: 'room_member_count', is: '2' }, base, USER, 3)).toBe(false);
  });
  it('< and > boundaries', () => {
    expect(matchesCondition({ kind: 'room_member_count', is: '<5' }, base, USER, 4)).toBe(true);
    expect(matchesCondition({ kind: 'room_member_count', is: '<5' }, base, USER, 5)).toBe(false);
    expect(matchesCondition({ kind: 'room_member_count', is: '>1' }, base, USER, 2)).toBe(true);
    expect(matchesCondition({ kind: 'room_member_count', is: '>1' }, base, USER, 1)).toBe(false);
  });
  it('<= and >= boundaries', () => {
    expect(matchesCondition({ kind: 'room_member_count', is: '<=2' }, base, USER, 2)).toBe(true);
    expect(matchesCondition({ kind: 'room_member_count', is: '<=2' }, base, USER, 3)).toBe(false);
    expect(matchesCondition({ kind: 'room_member_count', is: '>=10' }, base, USER, 10)).toBe(true);
    expect(matchesCondition({ kind: 'room_member_count', is: '>=10' }, base, USER, 9)).toBe(false);
  });
  it('rejects malformed is strings', () => {
    for (const is of ['', 'abc', '==', '===3', '<>3', '3==', ' 2', '2 ']) {
      expect(matchesCondition({ kind: 'room_member_count', is }, base, USER, 2)).toBe(false);
    }
  });
  it('missing is → false', () => {
    expect(matchesCondition({ kind: 'room_member_count' }, base, USER, 1)).toBe(false);
  });
});

describe('push leftovers event_property soft failure flood', () => {
  it('event_property_is false when key missing', () => {
    expect(
      matchesCondition(
        { kind: 'event_property_is', value: 1 },
        { content: { a: 1 } },
        USER,
        1
      )
    ).toBe(false);
  });
  it('event_property_is strict equality (no coercion)', () => {
    const ev = { content: { n: 1, s: '1', b: true } };
    expect(
      matchesCondition({ kind: 'event_property_is', key: 'content.n', value: '1' }, ev, USER, 1)
    ).toBe(false);
    expect(
      matchesCondition({ kind: 'event_property_is', key: 'content.n', value: 1 }, ev, USER, 1)
    ).toBe(true);
    expect(
      matchesCondition({ kind: 'event_property_is', key: 'content.b', value: true }, ev, USER, 1)
    ).toBe(true);
  });
  it('event_property_contains requires array', () => {
    expect(
      matchesCondition(
        { kind: 'event_property_contains', key: 'content.tags', value: 'a' },
        { content: { tags: 'a' } },
        USER,
        1
      )
    ).toBe(false);
    expect(
      matchesCondition(
        { kind: 'event_property_contains', key: 'content.tags', value: 'a' },
        { content: { tags: ['a', 'b'] } },
        USER,
        1
      )
    ).toBe(true);
  });
  it('event_property_contains false when value absent', () => {
    expect(
      matchesCondition(
        { kind: 'event_property_contains', key: 'content.tags', value: 'z' },
        { content: { tags: ['a'] } },
        USER,
        1
      )
    ).toBe(false);
  });
  it('event_match missing key/pattern → false', () => {
    expect(
      matchesCondition({ kind: 'event_match', key: 'type' }, msg, USER, 2)
    ).toBe(false);
    expect(
      matchesCondition({ kind: 'event_match', pattern: 'x' }, msg, USER, 2)
    ).toBe(false);
  });
  it('contains_display_name false without body or displayName', () => {
    expect(
      matchesCondition(
        { kind: 'contains_display_name' },
        { content: {} },
        USER,
        2,
        'Alice'
      )
    ).toBe(false);
    expect(
      matchesCondition(
        { kind: 'contains_display_name' },
        { content: { body: 'hi Alice' } },
        USER,
        2
      )
    ).toBe(false);
  });
});

describe('push leftovers gateway response body soft reliability', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('200 with empty body still records last_success', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 1 });
    expect(db.updates[0]).toMatchObject({ kind: 'success', ts: NOW });
  });

  it('200 with non-JSON body still records last_success', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not-json{{{', { status: 200 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 1 });
    expect(db.updates[0].kind).toBe('success');
  });

  it('204 no-content treated as success path (ok)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 1 });
    expect(db.updates[0].kind).toBe('success');
  });

  it('continues second pusher after first network failure', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rejected: [] }), { status: 200 }));
    const db = createPushDb({
      pushers: {
        [PUSH_USER]: [
          httpPusher({}, { pushkey: 'bad', app_id: 'a' }),
          httpPusher({}, { pushkey: 'good', app_id: 'b' }),
        ],
      },
    });
    await sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 1 });
    expect(db.updates).toEqual([
      expect.objectContaining({ kind: 'failure', pushkey: 'bad' }),
      expect.objectContaining({ kind: 'success', pushkey: 'good' }),
    ]);
  });

  it('missed_calls count is forwarded in payload', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const db = createPushDb({ pushers: { [PUSH_USER]: [httpPusher()] } });
    await sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 4, missed_calls: 2 });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.notification.counts).toEqual({ unread: 4, missed_calls: 2 });
  });
});

describe('push leftovers updateThrow / empty pushers reliability', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('empty pushers → no fetch and no updates', async () => {
    const db = createPushDb({ pushers: { [PUSH_USER]: [] } });
    await sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.updates).toEqual([]);
  });

  it('unknown user with no pusher rows is quiet', async () => {
    const db = createPushDb({});
    await sendPushNotification(db, '@nobody:example.com', baseEvent(), { unread: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('updateThrow on success path propagates', async () => {
    const db = createPushDb({
      pushers: { [PUSH_USER]: [httpPusher()] },
      updateThrow: true,
    });
    await expect(
      sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 1 })
    ).rejects.toThrow('update fail');
  });

  it('updateThrow on failure path propagates', async () => {
    fetchMock.mockResolvedValueOnce(new Response('err', { status: 500 }));
    const db = createPushDb({
      pushers: { [PUSH_USER]: [httpPusher()] },
      updateThrow: true,
    });
    await expect(
      sendPushNotification(db, PUSH_USER, baseEvent(), { unread: 1 })
    ).rejects.toThrow('update fail');
  });
});

describe('account-data leftovers prepare/empty soft reliability flood', () => {
  it('throwOnPrepare surfaces for getGlobalAccountData', async () => {
    const db = createAccountDataDb({ throwOnPrepare: true });
    await expect(getGlobalAccountData(db, USER)).rejects.toThrow('prepare boom');
  });

  it('throwOnPrepare surfaces for getRoomAccountData', async () => {
    const db = createAccountDataDb({ throwOnPrepare: true });
    await expect(getRoomAccountData(db, USER, '!r:x')).rejects.toThrow('prepare boom');
  });

  it('throwOnPrepare surfaces for getAccountDataStreamPosition', async () => {
    const db = createAccountDataDb({ throwOnPrepare: true });
    await expect(getAccountDataStreamPosition(db)).rejects.toThrow('prepare boom');
  });

  it('getAllRoomAccountData empty roomIds → {} without prepare', async () => {
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '!r:x', event_type: 'm.tag', content: '{}' }],
    });
    expect(await getAllRoomAccountData(db, USER, [])).toEqual({});
    expect(db.prepares).toHaveLength(0);
  });

  it('stream position null → 0', async () => {
    const db = createAccountDataDb({ streamPosition: null });
    expect(await getAccountDataStreamPosition(db)).toBe(0);
  });

  it('stream position 0 is preserved (not coerced via ||)', async () => {
    const db = createAccountDataDb({ streamPosition: 0 });
    expect(await getAccountDataStreamPosition(db)).toBe(0);
  });

  it('since filter excludes rows at exactly since boundary', async () => {
    const db = createAccountDataDb({
      rows: [{ user_id: USER, room_id: '', event_type: 'm.direct', content: '{"a":1}' }],
      changes: [{ user_id: USER, room_id: '', event_type: 'm.direct', stream_position: 10 }],
    });
    expect(await getGlobalAccountData(db, USER, 10)).toEqual([]);
    expect(await getGlobalAccountData(db, USER, 9)).toEqual([
      { type: 'm.direct', content: { a: 1 } },
    ]);
  });
});

describe('register leftovers available unicode/whitespace soft reject flood', () => {
  const rejectCases = [
    ['leading-space', ' alice'],
    ['trailing-space', 'alice '],
    ['tab', 'a\tb'],
    ['newline', 'a\nb'],
    ['cr', 'a\rb'],
    ['nbsp', 'a\u00a0b'],
    ['emoji', 'alice😀'],
    ['cyrillic', 'алиса'],
    ['fullwidth-a', 'ａlice'],
    ['null-byte', 'a\0b'],
    ['backslash', 'a\\b'],
    ['comma', 'a,b'],
    ['semicolon', 'a;b'],
    ['parens', 'a(b)'],
    ['brackets', 'a[b]'],
  ] as const;

  for (const [label, username] of rejectCases) {
    it(`rejects soft-invalid localpart (${label})`, async () => {
      const { status, body } = await availableRequest(
        availableEnv(createAvailableDb()),
        `/_matrix/client/v3/register/available?username=${encodeURIComponent(username)}`
      );
      expect(status).toBe(400);
      expect(body.errcode).toBe('M_INVALID_USERNAME');
    });
  }
});
