/**
 * TOKENMAXX HEAVY leftovers after #338 — undecenary *filters + appservice + auth*
 * concurrent-race niches not covered by denary (#338), nonary (#319),
 * octonary (#312), septenary (#304), or senary (#292) floods.
 *
 * Gap table (why leftover after #338 denary):
 *   Filters 1e2/1.5/[true] mint + TTL ∥ carol forbid
 *     | denary false/0/""/-1; nonary null/true/42/"str"; never scientific/float/bool-array
 *   Filters stored null∥false GET ∥ missing {} ∥ carol read-forbid soft
 *     | denary stored ""; never null/false GET soft under race
 *   isExclusiveAppServiceUser excludeAsId skip → next exclusive hit
 *     | nonary excludeAsId ''; never matching-id skip under this series tip
 *   users-only interest sender hit ∥ rooms-only miss twin
 *     | denary aliases-only ignore; never users-only interest twin
 *   protocols '["irc"]'/'{ "a":1 }' ByToken∥list quirks
 *     | septenary '{}'; denary 42/-1/str; never array-JSON / non-empty object
 *   HTTP 203 ok ∥ 401/403/502 retry under race
 *     | denary 202/302/404/500; nonary 201/100/199/301; never 203/401/403/502
 *   Auth protocols '-1'/'"irc"' under requireAuth
 *     | denary 0/1/42; never -1/JSON-string under requireAuth
 *   Auth namespaces 'false'/'0' skip ∥ restrictive deny
 *     | denary null/{}; nonary []; never boolean/number JSON skip
 *   Auth Bearer wins over conflicting query access_token
 *     | senary duplicate query first-wins; never Bearer-vs-query conflict
 *   Auth all-bad-regex ns catch→deny ∥ good regex allow soft
 *     | quinary invalid+good .some OR; never all-bad → deny under tip
 *
 * Distinct from #338 denary, #319 nonary, #312 octonary, #304 septenary.
 * New file. Tests-only. example.com / matrix.example.com fixtures only.
 * Does not touch auth.ts source (HITL). Reversible by delete.
 * No invent-product / secrets / DNS / history rewrite.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import type { AppServiceRegistration } from '../src/services/appservice';
import {
  getAppServices,
  getAppServiceByToken,
  getInterestedAppServices,
  isExclusiveAppServiceUser,
  sendAppServiceTransaction,
} from '../src/services/appservice';
import { extractAccessToken } from '../src/middleware/auth';

// Real requireAuth loaded via importActual in auth suites below
// (filter routes use the mocked requireAuth from vi.mock).

// ---------------------------------------------------------------------------
// Filters harness (mocked requireAuth — mirrors denary/nonary series)
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
const CAROL = '@carol:example.com';
const USER_ENC = encodeURIComponent(USER);
const CAROL_ENC = encodeURIComponent(CAROL);
const AUTH = { Authorization: 'Bearer test-token' };
const FILTER_SERVER = 'example.com';
const AS_SERVER = 'example.com';
const AS_ESC = AS_SERVER.replace(/\./g, '\\.');
const AUTH_SERVER = 'matrix.example.com';
const FILTER_TTL = 30 * 24 * 60 * 60; // 2592000

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };

function mockCache(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial };
  const puts: KvPut[] = [];
  let putCount = 0;
  let getCount = 0;
  return {
    data,
    puts,
    get putCount() {
      return putCount;
    },
    get getCount() {
      return getCount;
    },
    get: async (key: string) => {
      getCount += 1;
      return data[key] ?? null;
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      putCount += 1;
      data[key] = value;
      puts.push({ key, value, options });
    },
    delete: async (key: string) => {
      delete data[key];
    },
  };
}

type RaceCache = ReturnType<typeof mockCache>;

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

function createEnv(cache?: RaceCache) {
  const kv = cache ?? mockCache();
  return {
    SERVER_NAME: FILTER_SERVER,
    SERVER_VERSION: 'test',
    DB: stubDb() as unknown as D1Database,
    CACHE: kv,
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
    _cache: kv,
  } as unknown as Env & { _cache: RaceCache };
}

async function request(env: Env, path: string, init: RequestInit = {}) {
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
  return { status: res.status, body, headers: res.headers };
}

function filterCollection(userEnc = USER_ENC) {
  return `/_matrix/client/v3/user/${userEnc}/filter`;
}

function filterPath(filterId: string, userEnc = USER_ENC) {
  return `/_matrix/client/v3/user/${userEnc}/filter/${filterId}`;
}

function sampleFilter(n: number) {
  return { room: { timeline: { limit: n } } };
}

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
    sender_localpart: id,
    rate_limited: false,
    protocols: [],
    namespaces,
    ...extras,
  };
}

// Auth harness (real requireAuth via partial mock above)
type TokenRow = { user_id: string; device_id: string | null };
type AsRow = {
  id: string;
  url: string;
  as_token: string;
  hs_token: string;
  sender_localpart: string;
  rate_limited: number | null;
  protocols: string | null;
  namespaces: string;
};

function createAuthDb(
  opts: {
    tokens?: Map<string, TokenRow>;
    appservices?: Map<string, AsRow>;
    throwOnAs?: boolean;
  } = {}
) {
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
                if (opts.throwOnAs) throw new Error('as lookup failed');
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

async function jsonBody(
  res: Response
): Promise<{ errcode: string; error: string; status: number }> {
  const body = (await res.json()) as { errcode: string; error: string };
  return { ...body, status: res.status };
}

function createListDb(rows: AsRow[]) {
  return {
    prepare(_sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async all() {
              return { results: rows };
            },
            async first() {
              return rows[0] ?? null;
            },
          };
        },
        async all() {
          return { results: rows };
        },
      };
    },
  } as unknown as D1Database;
}

beforeEach(() => {
  authState.userId = USER;
  authState.deviceId = 'DEVICEA';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ===========================================================================
// FILTERS — 1e2 / 1.5 / [true] bodies + TTL ∥ carol create-forbid
// ===========================================================================

describe('race undecenary filter 1e2/1.5/[true] body + TTL soft after #338', () => {
  for (let i = 0; i < 12; i++) {
    it(`1e2∥1.5∥[true] mint + TTL ∥ carol forbid flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const putsBefore = cache.putCount;

      const [sciOk, floatOk, arrOk, forbid] = await Promise.all([
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '1e2',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '1.5',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '[true]',
        }),
        request(env, filterCollection(CAROL_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: JSON.stringify(sampleFilter(i)),
        }),
      ]);

      expect(sciOk.status).toBe(200);
      expect(floatOk.status).toBe(200);
      expect(arrOk.status).toBe(200);
      expect(forbid.status).toBe(403);
      expect(forbid.body).toEqual({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot create filters for other users',
      });

      const ids = [
        (sciOk.body as { filter_id: string }).filter_id,
        (floatOk.body as { filter_id: string }).filter_id,
        (arrOk.body as { filter_id: string }).filter_id,
      ];
      expect(new Set(ids).size).toBe(3);
      expect(cache.putCount - putsBefore).toBe(3);

      expect(JSON.parse(cache.data[`filter:${USER}:${ids[0]}`]!)).toBe(100);
      expect(JSON.parse(cache.data[`filter:${USER}:${ids[1]}`]!)).toBe(1.5);
      expect(JSON.parse(cache.data[`filter:${USER}:${ids[2]}`]!)).toEqual([true]);

      for (const p of cache.puts.slice(putsBefore)) {
        expect(p.options?.expirationTtl).toBe(FILTER_TTL);
        expect(p.key.startsWith(`filter:${USER}:`)).toBe(true);
      }
      expect(Object.keys(cache.data).some((k) => k.includes(CAROL))).toBe(false);
    });
  }
});

// ===========================================================================
// FILTERS — stored null∥false GET ∥ missing {} ∥ carol read-forbid soft
// ===========================================================================

describe('race undecenary filter null/false GET soft after #338', () => {
  for (let i = 0; i < 10; i++) {
    it(`stored null∥false ∥ missing {} ∥ carol forbid never mix flood-${i}`, async () => {
      const nullId = `null_${i}`;
      const falseId = `false_${i}`;
      const cache = mockCache({
        [`filter:${USER}:${nullId}`]: 'null',
        [`filter:${USER}:${falseId}`]: 'false',
        [`filter:${CAROL}:seed_${i}`]: JSON.stringify(sampleFilter(i)),
      });
      const env = createEnv(cache);
      const getsBefore = cache.getCount;

      const [nullGet, falseGet, missing, readForbid] = await Promise.all([
        request(env, filterPath(nullId), { method: 'GET', headers: { ...AUTH } }),
        request(env, filterPath(falseId), { method: 'GET', headers: { ...AUTH } }),
        request(env, filterPath(`missing_${i}`), { method: 'GET', headers: { ...AUTH } }),
        request(env, filterPath(`seed_${i}`, CAROL_ENC), {
          method: 'GET',
          headers: { ...AUTH },
        }),
      ]);

      expect(nullGet.status).toBe(200);
      expect(nullGet.body).toBeNull();
      expect(falseGet.status).toBe(200);
      expect(falseGet.body).toBe(false);
      expect(missing.status).toBe(200);
      expect(missing.body).toEqual({});
      expect(readForbid.status).toBe(403);
      expect(readForbid.body).toEqual({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot read filters for other users',
      });

      // Soft shapes never bleed; forbid never touches CACHE
      expect(nullGet.body).not.toEqual({});
      expect(falseGet.body).not.toBeNull();
      expect(missing.body).not.toBeNull();
      expect(missing.body).not.toBe(false);
      expect((readForbid.body as { error: string }).error).not.toBe('Invalid JSON');
      expect(cache.getCount - getsBefore).toBe(3);
      expect(cache.putCount).toBe(0);
    });
  }
});

// ===========================================================================
// APPSERVICE — excludeAsId matching id skips → next exclusive user hit
// ===========================================================================

describe('race undecenary appservice excludeAsId skip→next after #338', () => {
  for (let i = 0; i < 10; i++) {
    it(`exclude first exclusive → second hit ∥ full exclude miss flood-${i}`, async () => {
      const first = registration('ex_first', {
        users: [
          {
            exclusive: true,
            regex: `^@_bot_.*:${AS_ESC}$`,
          },
        ],
        rooms: [],
        aliases: [],
      });
      const second = registration('ex_second', {
        users: [
          {
            exclusive: true,
            regex: `^@_bot_.*:${AS_ESC}$`,
          },
        ],
        rooms: [],
        aliases: [],
      });
      const userId = `@_bot_undecenary_${i}:${AS_SERVER}`;

      const [skipFirst, skipBoth, noExclude] = await Promise.all([
        Promise.resolve(isExclusiveAppServiceUser([first, second], userId, 'ex_first')),
        Promise.resolve(isExclusiveAppServiceUser([first, second], userId, 'ex_second')),
        Promise.resolve(isExclusiveAppServiceUser([first, second], userId)),
      ]);

      expect(skipFirst?.id).toBe('ex_second');
      expect(skipBoth?.id).toBe('ex_first');
      expect(noExclude?.id).toBe('ex_first');

      // excluding both via wrong-then-right still needs a third miss
      const onlyFirst = isExclusiveAppServiceUser([first], userId, 'ex_first');
      expect(onlyFirst).toBeNull();
    });
  }
});

// ===========================================================================
// APPSERVICE — users-only interest sender hit ∥ rooms-only miss twin
// ===========================================================================

describe('race undecenary appservice users-only interest twin after #338', () => {
  for (let i = 0; i < 10; i++) {
    it(`users-only interests ∥ rooms-only miss ∥ both flood-${i}`, async () => {
      const usersOnly = registration('users_only', {
        users: [
          {
            exclusive: false,
            regex: `^@_ghost_.*:${AS_ESC}$`,
          },
        ],
        rooms: [],
        aliases: [],
      });
      const roomsOnly = registration('rooms_only', {
        users: [],
        rooms: [
          {
            exclusive: false,
            regex: `^!other_.*:${AS_ESC}$`,
          },
        ],
        aliases: [],
      });
      const roomId = `!soft_undecenary_${i}:${AS_SERVER}`;
      const event = {
        room_id: roomId,
        sender: `@_ghost_u_${i}:${AS_SERVER}`,
        type: 'm.room.message',
      };

      const [userInterest, roomInterest, both] = await Promise.all([
        Promise.resolve(getInterestedAppServices([usersOnly], event)),
        Promise.resolve(getInterestedAppServices([roomsOnly], event)),
        Promise.resolve(getInterestedAppServices([usersOnly, roomsOnly], event)),
      ]);

      expect(userInterest.map((a) => a.id)).toEqual(['users_only']);
      expect(roomInterest).toEqual([]);
      expect(both.map((a) => a.id)).toEqual(['users_only']);
    });
  }
});

// ===========================================================================
// APPSERVICE — protocols '["irc"]' / '{"a":1}' ByToken∥list
// ===========================================================================

describe('race undecenary appservice protocols array/object JSON after #338', () => {
  for (let i = 0; i < 10; i++) {
    it(`'["irc"]'→arr ∥ '{"a":1}'→obj ∥ null→[] ByToken∥list flood-${i}`, async () => {
      const arrProto = asRow({
        id: `parr_${i}`,
        as_token: `tok_parr_${i}`,
        sender_localpart: 'parr',
        protocols: '["irc"]',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const objProto = asRow({
        id: `pobj_${i}`,
        as_token: `tok_pobj_${i}`,
        sender_localpart: 'pobj',
        protocols: '{"a":1}',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const sqlNull = asRow({
        id: `pz_${i}`,
        as_token: `tok_pz_${i}`,
        sender_localpart: 'pz',
        protocols: null,
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });

      const [byArr, byObj, bySql, list] = await Promise.all([
        getAppServiceByToken(createListDb([arrProto]), `tok_parr_${i}`),
        getAppServiceByToken(createListDb([objProto]), `tok_pobj_${i}`),
        getAppServiceByToken(createListDb([sqlNull]), `tok_pz_${i}`),
        getAppServices(createListDb([arrProto, objProto, sqlNull])),
      ]);

      expect(byArr?.protocols).toEqual(['irc']);
      expect(byObj?.protocols).toEqual({ a: 1 });
      expect(bySql?.protocols).toEqual([]);
      expect(list.map((a) => a.protocols)).toEqual([['irc'], { a: 1 }, []]);
    });
  }
});

// ===========================================================================
// APPSERVICE — HTTP 203 ok ∥ 401/403/502 retry under race
// ===========================================================================

describe('race undecenary appservice HTTP 203∥401/403/502 after #338', () => {
  const NOW = 1_700_000_800_000;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  function createTxnDb(startRowId = 1100) {
    const inserts: Array<{ appservice_id: string; events: string; created_at: number }> = [];
    const updates: Array<{ kind: 'sent' | 'retry'; args: unknown[] }> = [];
    let nextRowId = startRowId;
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

  for (let i = 0; i < 10; i++) {
    it(`203 → sent_at ∥ 401∥403∥502 → retry under parallel flood-${i}`, async () => {
      const okDb = createTxnDb(1100 + i * 4);
      const r401 = createTxnDb(1110 + i * 4);
      const r403 = createTxnDb(1120 + i * 4);
      const r502 = createTxnDb(1130 + i * 4);
      const okAs = registration(
        'ok203',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://ok203.example.com' }
      );
      const as401 = registration(
        'r401',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r401.example.com' }
      );
      const as403 = registration(
        'r403',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r403.example.com' }
      );
      const as502 = registration(
        'r502',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r502.example.com' }
      );

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const u = String(url);
          if (u.includes('ok203.example.com')) return new Response('{}', { status: 203 });
          if (u.includes('r401.example.com')) return new Response('auth', { status: 401 });
          if (u.includes('r403.example.com')) return new Response('forbid', { status: 403 });
          return new Response('badgw', { status: 502 });
        })
      );

      const [ok, a, b, c] = await Promise.all([
        sendAppServiceTransaction(okDb, okAs, [{ n: i }]),
        sendAppServiceTransaction(r401, as401, [{ n: i }]),
        sendAppServiceTransaction(r403, as403, [{ n: i }]),
        sendAppServiceTransaction(r502, as502, [{ n: i }]),
      ]);

      expect(ok).toBe(true);
      expect(a).toBe(false);
      expect(b).toBe(false);
      expect(c).toBe(false);
      expect(okDb.updates.map((u) => u.kind)).toEqual(['sent']);
      expect(r401.updates.map((u) => u.kind)).toEqual(['retry']);
      expect(r403.updates.map((u) => u.kind)).toEqual(['retry']);
      expect(r502.updates.map((u) => u.kind)).toEqual(['retry']);
      expect(okDb.updates.some((u) => u.kind === 'retry')).toBe(false);
    });
  }
});

// ===========================================================================
// AUTH — protocols '-1'/'"irc"' under requireAuth
// ===========================================================================

describe('race undecenary auth protocols -1/str JSON under requireAuth after #338', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 8; i++) {
    it(`protocols '-1'∥'"irc"' allow ∥ ' ' unknown flood-${i}`, async () => {
      const tokNeg = `as_proto_neg_${i}`;
      const tokStr = `as_proto_str_${i}`;
      const tokWs = `as_proto_w_${i}`;
      const dbNeg = createAuthDb({
        appservices: new Map([
          [
            tokNeg,
            asRow({
              as_token: tokNeg,
              sender_localpart: 'negone',
              protocols: '-1',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
        ]),
      });
      const dbStr = createAuthDb({
        appservices: new Map([
          [
            tokStr,
            asRow({
              as_token: tokStr,
              sender_localpart: 'ircproto',
              protocols: '"irc"',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
        ]),
      });
      const dbWs = createAuthDb({
        appservices: new Map([
          [
            tokWs,
            asRow({
              as_token: tokWs,
              sender_localpart: 'wsproto',
              protocols: ' ',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
        ]),
      });

      const ctxNeg = makeAuthCtx({
        db: dbNeg,
        headers: { Authorization: `Bearer ${tokNeg}` },
      });
      const ctxStr = makeAuthCtx({
        db: dbStr,
        headers: { Authorization: `Bearer ${tokStr}` },
      });
      const ctxWs = makeAuthCtx({
        db: dbWs,
        headers: { Authorization: `Bearer ${tokWs}` },
      });

      const [resNeg, resStr, wsRes] = await Promise.all([
        realRequireAuth()(ctxNeg, vi.fn(async () => 'neg')),
        realRequireAuth()(ctxStr, vi.fn(async () => 'str')),
        realRequireAuth()(ctxWs, vi.fn()),
      ]);

      expect(resNeg).toBe('neg');
      expect(ctxNeg.get('userId')).toBe(`@negone:${AUTH_SERVER}`);
      expect(resStr).toBe('str');
      expect(ctxStr.get('userId')).toBe(`@ircproto:${AUTH_SERVER}`);
      expect(await jsonBody(wsRes as Response)).toMatchObject({
        errcode: 'M_UNKNOWN_TOKEN',
        status: 401,
      });
    });
  }
});

// ===========================================================================
// AUTH — namespaces JSON 'false'/'0' skip gate ∥ restrictive deny
// ===========================================================================

describe('race undecenary auth namespaces false/0 skip after #338', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`namespaces 'false'∥'0' skip ∥ restrictive deny flood-${i}`, async () => {
      const tokFalse = `as_ns_false_${i}`;
      const tokZero = `as_ns_zero_${i}`;
      const tokDeny = `as_ns_deny_${i}`;
      const localUser = `@anyone_${i}:${AUTH_SERVER}`;

      const dbFalse = createAuthDb({
        appservices: new Map([
          [
            tokFalse,
            asRow({
              as_token: tokFalse,
              sender_localpart: 'falsens',
              // JSON.parse('false') → false → namespaces?.users → undefined → gate skipped
              namespaces: 'false',
            }),
          ],
        ]),
      });
      const dbZero = createAuthDb({
        appservices: new Map([
          [
            tokZero,
            asRow({
              as_token: tokZero,
              sender_localpart: 'zerons',
              // JSON.parse('0') → 0 → users undefined → gate skipped
              namespaces: '0',
            }),
          ],
        ]),
      });
      const dbDeny = createAuthDb({
        appservices: new Map([
          [
            tokDeny,
            asRow({
              as_token: tokDeny,
              sender_localpart: 'deny',
              namespaces: JSON.stringify({
                users: [
                  {
                    exclusive: true,
                    regex: `^@_only_.*:${AUTH_SERVER.replace(/\./g, '\\.')}$`,
                  },
                ],
                rooms: [],
                aliases: [],
              }),
            }),
          ],
        ]),
      });

      const falseCtx = makeAuthCtx({
        db: dbFalse,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${tokFalse}` },
      });
      const zeroCtx = makeAuthCtx({
        db: dbZero,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${tokZero}` },
      });
      const denyCtx = makeAuthCtx({
        db: dbDeny,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${tokDeny}` },
      });

      const [falseRes, zeroRes, denyRes] = await Promise.all([
        realRequireAuth()(falseCtx, vi.fn(async () => 'false-skip')),
        realRequireAuth()(zeroCtx, vi.fn(async () => 'zero-skip')),
        realRequireAuth()(denyCtx, vi.fn()),
      ]);

      expect(falseRes).toBe('false-skip');
      expect(falseCtx.get('userId')).toBe(localUser);
      expect(zeroRes).toBe('zero-skip');
      expect(zeroCtx.get('userId')).toBe(localUser);
      expect(await jsonBody(denyRes as Response)).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'User not in application service namespace',
        status: 403,
      });
      expect(denyCtx.get('userId')).toBeUndefined();
    });
  }
});

// ===========================================================================
// AUTH — Bearer wins over conflicting query access_token under race
// ===========================================================================

describe('race undecenary auth Bearer-over-query conflict after #338', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`Bearer AS wins ∥ query-only AS ∥ Bearer unknown ignores query flood-${i}`, async () => {
      const bearerTok = `as_bearer_${i}`;
      const queryTok = `as_query_${i}`;
      const db = createAuthDb({
        appservices: new Map([
          [
            bearerTok,
            asRow({
              as_token: bearerTok,
              sender_localpart: 'bearer',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
          [
            queryTok,
            asRow({
              as_token: queryTok,
              sender_localpart: 'query',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
        ]),
      });

      const conflict = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(queryTok)}`,
        headers: { Authorization: `Bearer ${bearerTok}` },
      });
      const queryOnly = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(queryTok)}`,
      });
      const bearerUnknown = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(queryTok)}`,
        headers: { Authorization: `Bearer not_real_${i}` },
      });

      expect(
        extractAccessToken(
          new Request(
            `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(queryTok)}`,
            { headers: { Authorization: `Bearer ${bearerTok}` } }
          )
        )
      ).toBe(bearerTok);

      const [conflictRes, queryRes, unkRes] = await Promise.all([
        realRequireAuth()(conflict, vi.fn(async () => 'bearer-win')),
        realRequireAuth()(queryOnly, vi.fn(async () => 'query-ok')),
        realRequireAuth()(bearerUnknown, vi.fn()),
      ]);

      expect(conflictRes).toBe('bearer-win');
      expect(conflict.get('userId')).toBe(`@bearer:${AUTH_SERVER}`);
      expect(queryRes).toBe('query-ok');
      expect(queryOnly.get('userId')).toBe(`@query:${AUTH_SERVER}`);
      expect(await jsonBody(unkRes as Response)).toMatchObject({
        errcode: 'M_UNKNOWN_TOKEN',
        status: 401,
      });
      expect(bearerUnknown.get('userId')).toBeUndefined();
    });
  }
});

// ===========================================================================
// AUTH — all-bad-regex ns catch→deny ∥ good regex allow soft
// ===========================================================================

describe('race undecenary auth all-bad-regex ns deny soft after #338', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`all-bad-regex deny ∥ good regex allow never mix flood-${i}`, async () => {
      const tokBad = `as_bad_re_${i}`;
      const tokGood = `as_good_re_${i}`;
      const localUser = `@_bridge_ok_${i}:${AUTH_SERVER}`;
      const esc = AUTH_SERVER.replace(/\./g, '\\.');

      const dbBad = createAuthDb({
        appservices: new Map([
          [
            tokBad,
            asRow({
              as_token: tokBad,
              sender_localpart: 'badre',
              namespaces: JSON.stringify({
                users: [
                  { exclusive: true, regex: '[' },
                  { exclusive: true, regex: '(?P<bad>)' },
                ],
                rooms: [],
                aliases: [],
              }),
            }),
          ],
        ]),
      });
      const dbGood = createAuthDb({
        appservices: new Map([
          [
            tokGood,
            asRow({
              as_token: tokGood,
              sender_localpart: 'goodre',
              namespaces: JSON.stringify({
                users: [
                  { exclusive: true, regex: '[' },
                  {
                    exclusive: true,
                    regex: `^@_bridge_.*:${esc}$`,
                  },
                ],
                rooms: [],
                aliases: [],
              }),
            }),
          ],
        ]),
      });

      const badCtx = makeAuthCtx({
        db: dbBad,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${tokBad}` },
      });
      const goodCtx = makeAuthCtx({
        db: dbGood,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${tokGood}` },
      });
      const goodNext = vi.fn(async () => 'good-ok');

      const [badRes, goodRes] = await Promise.all([
        realRequireAuth()(badCtx, vi.fn()),
        realRequireAuth()(goodCtx, goodNext),
      ]);

      const badBody = await jsonBody(badRes as Response);
      expect(badBody).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'User not in application service namespace',
        status: 403,
      });
      expect(badCtx.get('userId')).toBeUndefined();
      expect(goodRes).toBe('good-ok');
      expect(goodNext).toHaveBeenCalledOnce();
      expect(goodCtx.get('userId')).toBe(localUser);
      // Soft strings never bleed
      expect(badBody.error).not.toBe('Invalid user_id format');
      expect(badBody.error).not.toContain('other servers');
    });
  }
});
