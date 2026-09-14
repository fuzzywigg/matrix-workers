/**
 * TOKENMAXX HEAVY leftovers after #236 / deepen after #241 — residual
 * *filters + appservice + auth* slices not covered by #214/#217/#218/#236.
 *
 * Distinct from #236 concurrent-race deepen:
 *   filters — errcode-only forbidden/bad-JSON floods; no `error` string bind
 *   appservice API races — Bearer/thirdparty/query soft; not service interest/
 *     transaction fetch contract
 *   auth races — Bearer-wins-when-both-valid, bare Bearer→query, throwOnAs;
 *     not invalid-Bearer+valid-query, omitted `users` key, namespaces parse throw
 *
 * Coverage:
 *   filters — create vs read forbidden `error` strings; Invalid JSON bind
 *   appservice — alias ns ignored by getInterestedAppServices; empty getAppServices;
 *     sendAppServiceTransaction Content-Type + `{ events }` body; 204 → ok
 *   auth — invalid Bearer does not fall through to valid query (require + optional);
 *     namespaces without `users` skips gate; malformed namespaces JSON → unknown token
 *
 * Tests-only. Fixtures use example.com / matrix.example.com only. No product inventing.
 * Reversible by reverting this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import {
  getAppServices,
  getInterestedAppServices,
  sendAppServiceTransaction,
  type AppServiceRegistration,
} from '../src/services/appservice';
import { extractAccessToken } from '../src/middleware/auth';
import { hashToken } from '../src/utils/crypto';

// ---------------------------------------------------------------------------
// Filters — inline handlers on src/index.ts (mock harness mirrors #236 file)
// ---------------------------------------------------------------------------

vi.mock('../src/middleware/rate-limit', () => ({
  rateLimitMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  getRateLimitType: () => 'default',
  getClientId: () => 'unknown',
  RATE_LIMITS: {},
}));

vi.mock('hono/logger', () => ({
  logger: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../src/middleware/analytics', () => ({
  analyticsMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const authState = vi.hoisted(() => ({
  userId: '@alice:example.com' as string | undefined,
  deviceId: 'DEVICEA' as string,
}));

vi.mock('../src/middleware/auth', async (importOriginal) => {
  // Keep real extractAccessToken / requireAuth / optionalAuth available for the
  // auth residual suite below; filter routes still use the mocked requireAuth.
  const actual = await importOriginal<typeof import('../src/middleware/auth')>();
  return {
    ...actual,
    requireAuth: () => {
      return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
        c.set('userId', authState.userId);
        c.set('deviceId', authState.deviceId);
        await next();
      };
    },
    optionalAuth: () => {
      return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
        if (authState.userId) c.set('userId', authState.userId);
        c.set('deviceId', authState.deviceId);
        await next();
      };
    },
  };
});

vi.mock('../src/durable-objects', () => ({
  RoomDurableObject: class {},
  SyncDurableObject: class {},
  FederationDurableObject: class {},
  CallRoomDurableObject: class {},
  AdminDurableObject: class {},
  UserKeysDurableObject: class {},
  PushDurableObject: class {},
  RateLimitDurableObject: class {},
}));

vi.mock('../src/workflows', () => ({
  RoomJoinWorkflow: class {},
  PushNotificationWorkflow: class {},
  FederationCatchupWorkflow: class {},
  MediaCleanupWorkflow: class {},
  StateCompactionWorkflow: class {},
}));

import app from '../src/index';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const USER_ENC = encodeURIComponent(USER);
const BOB_ENC = encodeURIComponent(BOB);
const AUTH = { Authorization: 'Bearer test-token' };
const SERVER = 'example.com';
const AUTH_SERVER = 'matrix.example.com';

function mockCache(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    get: async (key: string) => data[key] ?? null,
    put: async (key: string, value: string) => {
      data[key] = value;
    },
    delete: async (key: string) => {
      delete data[key];
    },
  };
}

function stubDb() {
  return {
    prepare(_sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first() {
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
  };
}

function createFilterEnv(cache = mockCache()) {
  return {
    SERVER_NAME: SERVER,
    SERVER_VERSION: 'test',
    DB: stubDb() as unknown as D1Database,
    CACHE: cache,
    SESSIONS: mockCache(),
    DEVICE_KEYS: mockCache(),
    ONE_TIME_KEYS: mockCache(),
    CROSS_SIGNING_KEYS: mockCache(),
    ACCOUNT_DATA: mockCache(),
    MEDIA: {
      put: async () => {},
      get: async () => null,
      delete: async () => {},
    },
  } as unknown as Env;
}

async function filterRequest(env: Env, path: string, init: RequestInit = {}) {
  const res = await app.request(`http://localhost${path}`, init, env);
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

function filterCollection(userEnc = USER_ENC): string {
  return `/_matrix/client/v3/user/${userEnc}/filter`;
}

function filterPath(filterId: string, userEnc = USER_ENC): string {
  return `${filterCollection(userEnc)}/${encodeURIComponent(filterId)}`;
}

describe('filters residual error-string binds after #236', () => {
  beforeEach(() => {
    authState.userId = USER;
    authState.deviceId = 'DEVICEA';
  });

  it('POST other-user forbidden binds create-specific error string', async () => {
    const env = createFilterEnv();
    const res = await filterRequest(env, filterCollection(BOB_ENC), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ room: { timeline: { limit: 1 } } }),
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot create filters for other users',
    });
  });

  it('GET other-user forbidden binds read-specific error string (distinct from create)', async () => {
    const env = createFilterEnv(
      mockCache({ [`filter:${BOB}:fid`]: JSON.stringify({ room: {} }) })
    );
    const res = await filterRequest(env, filterPath('fid', BOB_ENC), {
      method: 'GET',
      headers: { ...AUTH },
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot read filters for other users',
    });
  });

  it('create vs read forbidden error strings differ under parallel bind', async () => {
    const env = createFilterEnv(
      mockCache({ [`filter:${BOB}:fid`]: JSON.stringify({ room: {} }) })
    );
    const [createRes, readRes] = await Promise.all([
      filterRequest(env, filterCollection(BOB_ENC), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: JSON.stringify({ room: {} }),
      }),
      filterRequest(env, filterPath('fid', BOB_ENC), {
        method: 'GET',
        headers: { ...AUTH },
      }),
    ]);
    expect(createRes.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot create filters for other users',
    });
    expect(readRes.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot read filters for other users',
    });
    expect((createRes.body as { error: string }).error).not.toBe(
      (readRes.body as { error: string }).error
    );
  });

  it('bad JSON POST binds Invalid JSON error string (not default M_BAD_JSON message)', async () => {
    const env = createFilterEnv();
    const res = await filterRequest(env, filterCollection(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      errcode: 'M_BAD_JSON',
      error: 'Invalid JSON',
    });
  });
});

// ---------------------------------------------------------------------------
// Appservice service residuals
// ---------------------------------------------------------------------------

function registration(
  id: string,
  namespaces: AppServiceRegistration['namespaces'],
  extras: Partial<AppServiceRegistration> = {}
): AppServiceRegistration {
  return {
    id,
    url: `https://${id}.example.com`,
    as_token: `as-${id}`,
    hs_token: `hs-${id}`,
    sender_localpart: `${id}_bot`,
    rate_limited: false,
    protocols: [],
    namespaces,
    ...extras,
  };
}

describe('appservice residual interest + mapping after #236', () => {
  it('alias-only namespaces never make getInterestedAppServices return a hit', () => {
    const aliasOnly = registration('aliasy', {
      users: [],
      rooms: [],
      aliases: [{ exclusive: true, regex: '^!portal_.*:example\\.com$' }],
    });
    // room_id would match the alias regex if aliases were consulted — they are not.
    expect(
      getInterestedAppServices([aliasOnly], {
        room_id: '!portal_1:example.com',
        sender: '@alice:example.com',
        type: 'm.room.message',
      })
    ).toEqual([]);
  });

  it('alias-only AS stays uninterested even when sender looks like an alias pattern', () => {
    const aliasOnly = registration('aliasy2', {
      users: [],
      rooms: [],
      aliases: [{ exclusive: false, regex: '^@_alias_.*:example\\.com$' }],
    });
    expect(
      getInterestedAppServices([aliasOnly], {
        room_id: '!r:example.com',
        sender: '@_alias_ghost:example.com',
        type: 'm.room.message',
      })
    ).toEqual([]);
  });

  it('getAppServices maps empty result set to []', async () => {
    const db = {
      prepare(_sql: string) {
        return {
          bind(..._args: unknown[]) {
            return this;
          },
          async all() {
            return { results: [] };
          },
        };
      },
    } as unknown as D1Database;

    await expect(getAppServices(db)).resolves.toEqual([]);
  });
});

describe('appservice residual sendAppServiceTransaction fetch contract after #236', () => {
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function createTxnDb() {
    const inserts: Array<{ appservice_id: string; events: string; created_at: number }> = [];
    const updates: Array<{ kind: 'sent' | 'retry'; args: unknown[] }> = [];
    let nextRowId = 7;

    const db = {
      inserts,
      updates,
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async run() {
                if (sql.includes('INSERT INTO appservice_transactions')) {
                  const [appservice_id, events, created_at] = args as [string, string, number];
                  inserts.push({ appservice_id, events, created_at });
                  return { meta: { last_row_id: nextRowId++ } };
                }
                if (sql.includes('SET sent_at')) {
                  updates.push({ kind: 'sent', args });
                  return { meta: { changes: 1 } };
                }
                if (sql.includes('retry_count')) {
                  updates.push({ kind: 'retry', args });
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              },
            };
          },
        };
      },
    };

    return db as unknown as D1Database & {
      inserts: typeof inserts;
      updates: typeof updates;
    };
  }

  it('PUT binds Content-Type application/json and body wrapped as { events }', async () => {
    const db = createTxnDb();
    const bridge = registration('bridge', {
      users: [],
      rooms: [],
      aliases: [],
    });
    const events = [{ type: 'm.room.message', room_id: '!r:example.com' }];
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('{}', { status: 200 })
    );

    const ok = await sendAppServiceTransaction(db, bridge, events);
    expect(ok).toBe(true);

    expect(fetch).toHaveBeenCalledWith(
      'https://bridge.example.com/_matrix/app/v1/transactions/7',
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer hs-bridge',
        },
        body: JSON.stringify({ events }),
      }
    );
    // Body is wrapped object, not a bare array
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      body: string;
    };
    expect(JSON.parse(call.body)).toEqual({ events });
    expect(Array.isArray(JSON.parse(call.body))).toBe(false);
  });

  it('treats HTTP 204 as response.ok → marks sent_at', async () => {
    const db = createTxnDb();
    const bridge = registration('bridge', { users: [], rooms: [], aliases: [] });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(null, { status: 204 })
    );

    const ok = await sendAppServiceTransaction(db, bridge, [{ type: 'm.room.member' }]);
    expect(ok).toBe(true);
    expect(db.updates).toEqual([{ kind: 'sent', args: [NOW, 7] }]);
  });

  it('concatenates transaction path even when appservice.url has a trailing slash', async () => {
    const db = createTxnDb();
    const bridge = registration(
      'slashy',
      { users: [], rooms: [], aliases: [] },
      { url: 'https://slashy.example.com/' }
    );
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('{}', { status: 200 })
    );

    await sendAppServiceTransaction(db, bridge, []);
    expect(fetch).toHaveBeenCalledWith(
      'https://slashy.example.com//_matrix/app/v1/transactions/7',
      expect.objectContaining({ method: 'PUT' })
    );
  });
});

// ---------------------------------------------------------------------------
// Auth middleware residuals — use REAL requireAuth/optionalAuth via unmock path
// ---------------------------------------------------------------------------

// The vi.mock above wraps requireAuth for filter routes. For auth residuals we
// import the real implementations through a dynamic re-bind that bypasses the
// filter mock by calling the original functions stored before the mock applied.
// Simpler approach: exercise extractAccessToken (real, re-exported) and use
// vi.importActual for requireAuth/optionalAuth inside this suite.

type TokenRow = { user_id: string; device_id: string | null };
type AsRow = {
  id: string;
  url: string;
  as_token: string;
  hs_token: string;
  sender_localpart: string;
  rate_limited: number;
  protocols: string | null;
  namespaces: string;
};

function createAuthDb(opts: {
  tokens?: Map<string, TokenRow>;
  appservices?: Map<string, AsRow>;
} = {}) {
  const tokens = opts.tokens ?? new Map<string, TokenRow>();
  const appservices = opts.appservices ?? new Map<string, AsRow>();
  return {
    tokens,
    appservices,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('FROM access_tokens') && sql.includes('token_hash')) {
                const hash = args[0] as string;
                return (tokens.get(hash) as T) ?? null;
              }
              if (sql.includes('FROM appservice_registrations') && sql.includes('as_token')) {
                const token = args[0] as string;
                return (appservices.get(token) as T) ?? null;
              }
              return null;
            },
          };
        },
      };
    },
  } as unknown as D1Database & {
    tokens: Map<string, TokenRow>;
    appservices: Map<string, AsRow>;
  };
}

function asRow(
  partial: Partial<AsRow> & Pick<AsRow, 'as_token' | 'sender_localpart'>
): AsRow {
  return {
    id: partial.id ?? 'as1',
    url: partial.url ?? 'https://as.example.com',
    as_token: partial.as_token,
    hs_token: partial.hs_token ?? 'hs',
    sender_localpart: partial.sender_localpart,
    rate_limited: partial.rate_limited ?? 0,
    protocols: partial.protocols ?? null,
    namespaces:
      partial.namespaces ??
      JSON.stringify({
        users: [{ exclusive: true, regex: '@bot_.*:matrix\\.example\\.com' }],
        rooms: [],
        aliases: [],
      }),
  };
}

function makeAuthCtx(opts: {
  url?: string;
  headers?: Record<string, string>;
  db: D1Database;
  serverName?: string;
}) {
  const url = opts.url ?? `https://${AUTH_SERVER}/_matrix/client/v3/sync`;
  const headers = new Headers(opts.headers ?? {});
  const raw = new Request(url, { headers });
  const store = new Map<string, unknown>();
  return {
    req: {
      raw,
      url,
      header: (name: string) => headers.get(name),
    },
    env: { DB: opts.db, SERVER_NAME: opts.serverName ?? AUTH_SERVER },
    set: (k: string, v: unknown) => store.set(k, v),
    get: (k: string) => store.get(k),
    _store: store,
  } as any;
}

async function jsonBody(res: Response): Promise<{ errcode: string; error: string; status: number }> {
  const body = (await res.json()) as { errcode: string; error: string };
  return { ...body, status: res.status };
}

describe('auth residual Bearer/query + AS namespace edges after #236', () => {
  let realRequireAuth: () => ReturnType<
    typeof import('../src/middleware/auth').requireAuth
  >;
  let realOptionalAuth: () => ReturnType<
    typeof import('../src/middleware/auth').optionalAuth
  >;

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
    realOptionalAuth = actual.optionalAuth;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extractAccessToken prefers invalid Bearer over a valid query token', () => {
    const req = new Request(
      `https://${AUTH_SERVER}/sync?access_token=syt_valid_query`,
      { headers: { Authorization: 'Bearer garbage_header' } }
    );
    expect(extractAccessToken(req)).toBe('garbage_header');
  });

  it('requireAuth: invalid Bearer + valid query access_token → M_UNKNOWN_TOKEN (no fallthrough)', async () => {
    const valid = 'syt_query_ok';
    const hash = await hashToken(valid);
    const db = createAuthDb({
      tokens: new Map([[hash, { user_id: `@alice:${AUTH_SERVER}`, device_id: 'DQ' }]]),
    });
    const next = vi.fn();
    const res = (await realRequireAuth()(
      makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/_matrix/client/v3/sync?access_token=${valid}`,
        headers: { Authorization: 'Bearer garbage_header' },
      }),
      next
    )) as Response;
    expect(await jsonBody(res)).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN', status: 401 });
    expect(next).not.toHaveBeenCalled();
  });

  it('optionalAuth: invalid Bearer + valid query leaves context unset (query ignored)', async () => {
    const valid = 'syt_opt_query';
    const hash = await hashToken(valid);
    const db = createAuthDb({
      tokens: new Map([[hash, { user_id: `@alice:${AUTH_SERVER}`, device_id: 'D' }]]),
    });
    const ctx = makeAuthCtx({
      db,
      url: `https://${AUTH_SERVER}/sync?access_token=${valid}`,
      headers: { Authorization: 'Bearer bad_bearer' },
    });
    const next = vi.fn(async () => 'cont');
    await expect(realOptionalAuth()(ctx, next)).resolves.toBe('cont');
    expect(ctx.get('userId')).toBeUndefined();
    expect(ctx.get('auth')).toBeUndefined();
  });

  it('AS namespaces omitting users key skips namespace gate (any local user_id allowed)', async () => {
    // Distinct from users: [] — the `users` property is absent entirely.
    const namespaces = JSON.stringify({ rooms: [], aliases: [] });
    const db = createAuthDb({
      appservices: new Map([
        [
          'as_tok',
          asRow({
            as_token: 'as_tok',
            sender_localpart: 'bridge',
            namespaces,
          }),
        ],
      ]),
    });
    const ctx = makeAuthCtx({
      db,
      url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent('@anyone:' + AUTH_SERVER)}`,
      headers: { Authorization: 'Bearer as_tok' },
    });
    const next = vi.fn(async () => 'ok');
    await expect(realRequireAuth()(ctx, next)).resolves.toBe('ok');
    expect(ctx.get('userId')).toBe(`@anyone:${AUTH_SERVER}`);
  });

  it('malformed namespaces JSON from D1 throws inside getAppServiceByToken → M_UNKNOWN_TOKEN', async () => {
    const db = createAuthDb({
      appservices: new Map([
        [
          'as_bad_ns',
          asRow({
            as_token: 'as_bad_ns',
            sender_localpart: 'bot',
            namespaces: '{not-json',
          }),
        ],
      ]),
    });
    const next = vi.fn();
    const res = (await realRequireAuth()(
      makeAuthCtx({
        db,
        headers: { Authorization: 'Bearer as_bad_ns' },
      }),
      next
    )) as Response;
    expect(await jsonBody(res)).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN', status: 401 });
    expect(next).not.toHaveBeenCalled();
  });

  it('malformed protocols JSON from D1 also swallows to M_UNKNOWN_TOKEN', async () => {
    const db = createAuthDb({
      appservices: new Map([
        [
          'as_bad_proto',
          asRow({
            as_token: 'as_bad_proto',
            sender_localpart: 'bot',
            protocols: '{bad',
            namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
          }),
        ],
      ]),
    });
    const next = vi.fn();
    const res = (await realRequireAuth()(
      makeAuthCtx({
        db,
        headers: { Authorization: 'Bearer as_bad_proto' },
      }),
      next
    )) as Response;
    expect(await jsonBody(res)).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN', status: 401 });
    expect(next).not.toHaveBeenCalled();
  });
});
