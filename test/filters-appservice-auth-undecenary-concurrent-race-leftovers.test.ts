/**
 * TOKENMAXX HEAVY tip-relaunch after #342 (tip 9065fa5) — undecenary
 * *filters + appservice + auth* concurrent-race niches not covered by denary
 * (#338), nonary (#319), octonary (#312), septenary (#304), senary (#292),
 * or quinary (#286) floods. Relaunch of closed #345 onto tip post-#342.
 *
 * Gap table (why leftover after #338 denary / tip #342):
 *   Filters 1 / 3.14 / [null] / {a:null} mint + TTL ∥ carol forbid
 *     | denary false/0/""/-1; nonary null/true/42/"str"; never 1/float/null-array/null-obj
 *   Filters stored null/false/0/[] GET soft ∥ carol read-forbid
 *     | denary stored "" only; never null/false/0/[] under forbid race
 *   isExclusiveAppServiceUser empty miss ∥ exclusive hit
 *     | denary exclusive ALIAS twin; nonary users:null throw; never USER miss∥hit soft
 *   users-only interest hit ∥ rooms-only hit under race
 *     | denary aliases-only ignore; never users-only∥rooms-only interest twin
 *   protocols '["irc"]' / '{"k":1}' / '3.14' ByToken∥list quirks
 *     | denary 42/-1/"str"; octonary null/[]/false; never nested-array/object/float
 *   HTTP 203/204 ok ∥ 400/401/403/503 retry under race
 *     | denary 202∥302/404/500; nonary 201∥100/199/301; never 203/204∥4xx/503
 *   Auth protocols '["x"]'/'{"k":1}'/'3.14' under requireAuth
 *     | denary 0/1/42; nonary false/true; never nested-array/object/float JSON
 *   Auth namespaces missing-users / rooms-only skip ∥ restrictive deny
 *     | denary 'null'/'{}'; nonary '[]'; never users-absent / rooms-only top-level
 *   Auth empty user_id= ∥ valid AS user_id soft under race
 *     | denary default-sender (no param); never empty-string query user_id
 *   Auth Bearer-wins-over-query ∥ M_UNKNOWN_TOKEN soft under race
 *     | extract prefers Authorization; never proven vs stale query under this series
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
// FILTERS — 1 / 3.14 / [null] / {a:null} mint + TTL ∥ carol create-forbid
// ===========================================================================

describe('race undecenary filter 1/float/null-array/null-obj + TTL soft after #338', () => {
  for (let i = 0; i < 12; i++) {
    it(`1∥3.14∥[null]∥{a:null} mint + TTL ∥ carol forbid flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const putsBefore = cache.putCount;

      const [oneOk, floatOk, arrOk, objOk, forbid] = await Promise.all([
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '1',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '3.14',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '[null]',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '{"a":null}',
        }),
        request(env, filterCollection(CAROL_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: JSON.stringify({ room: { timeline: { limit: i } } }),
        }),
      ]);

      expect(oneOk.status).toBe(200);
      expect(floatOk.status).toBe(200);
      expect(arrOk.status).toBe(200);
      expect(objOk.status).toBe(200);
      expect(forbid.status).toBe(403);
      expect(forbid.body).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot create filters for other users',
      });

      const ids = [
        (oneOk.body as { filter_id: string }).filter_id,
        (floatOk.body as { filter_id: string }).filter_id,
        (arrOk.body as { filter_id: string }).filter_id,
        (objOk.body as { filter_id: string }).filter_id,
      ];
      expect(new Set(ids).size).toBe(4);
      expect(cache.putCount).toBe(putsBefore + 4);

      const byId = Object.fromEntries(
        cache.puts.slice(-4).map((p) => {
          const fid = p.key.split(':').pop()!;
          return [fid, p];
        })
      );
      expect(JSON.parse(byId[ids[0]].value)).toBe(1);
      expect(JSON.parse(byId[ids[1]].value)).toBe(3.14);
      expect(JSON.parse(byId[ids[2]].value)).toEqual([null]);
      expect(JSON.parse(byId[ids[3]].value)).toEqual({ a: null });
      for (const id of ids) {
        expect(byId[id].options?.expirationTtl).toBe(FILTER_TTL);
        expect(byId[id].key).toBe(`filter:${USER}:${id}`);
      }
      // Soft forbid never wrote carol keys
      expect(Object.keys(cache.data).every((k) => !k.includes(CAROL))).toBe(true);
      expect((forbid.body as { error: string }).error).not.toContain('Invalid JSON');
    });
  }
});

// ===========================================================================
// FILTERS — stored null / false / 0 / [] GET soft ∥ carol read-forbid
// ===========================================================================

describe('race undecenary filter null/false/0/[] GET soft after #338', () => {
  for (let i = 0; i < 10; i++) {
    it(`stored null∥false∥0∥[] ∥ carol forbid never mix flood-${i}`, async () => {
      const nullId = `und_null_${i}`;
      const falseId = `und_false_${i}`;
      const zeroId = `und_zero_${i}`;
      const arrId = `und_arr_${i}`;
      const cache = mockCache({
        [`filter:${USER}:${nullId}`]: 'null',
        [`filter:${USER}:${falseId}`]: 'false',
        [`filter:${USER}:${zeroId}`]: '0',
        [`filter:${USER}:${arrId}`]: '[]',
      });
      const env = createEnv(cache);
      const getsBefore = cache.getCount;

      const [nullGet, falseGet, zeroGet, arrGet, forbid] = await Promise.all([
        request(env, filterPath(nullId), { headers: AUTH }),
        request(env, filterPath(falseId), { headers: AUTH }),
        request(env, filterPath(zeroId), { headers: AUTH }),
        request(env, filterPath(arrId), { headers: AUTH }),
        request(env, filterPath(nullId, CAROL_ENC), { headers: AUTH }),
      ]);

      expect(nullGet.status).toBe(200);
      expect(nullGet.body).toBeNull();
      expect(falseGet.status).toBe(200);
      expect(falseGet.body).toBe(false);
      expect(zeroGet.status).toBe(200);
      expect(zeroGet.body).toBe(0);
      expect(arrGet.status).toBe(200);
      expect(arrGet.body).toEqual([]);
      expect(forbid.status).toBe(403);
      expect(forbid.body).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot read filters for other users',
      });

      // Soft success bodies never gain errcode; forbid never touches CACHE
      expect(nullGet.body).toBeNull();
      expect(falseGet.body).toBe(false);
      expect(zeroGet.body).toBe(0);
      expect(arrGet.body).toEqual([]);
      expect(cache.getCount).toBe(getsBefore + 4);
      expect((forbid.body as { error: string }).error).not.toBe(
        'Cannot create filters for other users'
      );
    });
  }
});

// ===========================================================================
// APPSERVICE — exclusive USER empty miss ∥ hit (denary did ALIAS twin)
// ===========================================================================

describe('race undecenary appservice exclusive user miss∥hit after #338', () => {
  for (let i = 0; i < 10; i++) {
    it(`empty miss ∥ plain miss ∥ exclusive user hit flood-${i}`, async () => {
      const empty = registration('empty_eu', {
        users: [],
        rooms: [],
        aliases: [],
      });
      const hit = registration('hit_eu', {
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
      const plain = `@alice_${i}:${AS_SERVER}`;

      const [missEmpty, missPlain, matched] = await Promise.all([
        Promise.resolve(isExclusiveAppServiceUser([empty], userId)),
        Promise.resolve(isExclusiveAppServiceUser([hit], plain)),
        Promise.resolve(isExclusiveAppServiceUser([hit], userId)),
      ]);

      expect(missEmpty).toBeNull();
      expect(missPlain).toBeNull();
      expect(matched?.id).toBe('hit_eu');

      const mixed = isExclusiveAppServiceUser([empty, hit], userId);
      expect(mixed?.id).toBe('hit_eu');

      // excludeAsId matching id skips exclusive owner
      expect(isExclusiveAppServiceUser([hit], userId, 'hit_eu')).toBeNull();
    });
  }
});

// ===========================================================================
// APPSERVICE — users-only interest hit ∥ rooms-only hit
// ===========================================================================

describe('race undecenary appservice users-only∥rooms-only interest after #338', () => {
  for (let i = 0; i < 10; i++) {
    it(`users-only hit ∥ rooms-only hit ∥ neither flood-${i}`, async () => {
      const usersOnly = registration('users_only', {
        users: [
          {
            exclusive: false,
            regex: `^@bridge_.*:${AS_ESC}$`,
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
            regex: `^!soft_.*:${AS_ESC}$`,
          },
        ],
        aliases: [],
      });
      const neither = registration('neither', {
        users: [
          {
            exclusive: false,
            regex: `^@other_.*:${AS_ESC}$`,
          },
        ],
        rooms: [
          {
            exclusive: false,
            regex: `^!other_.*:${AS_ESC}$`,
          },
        ],
        aliases: [],
      });

      const userEvent = {
        room_id: `!plain_${i}:${AS_SERVER}`,
        sender: `@bridge_und_${i}:${AS_SERVER}`,
        type: 'm.room.message',
      };
      const roomEvent = {
        room_id: `!soft_und_${i}:${AS_SERVER}`,
        sender: `@alice_${i}:${AS_SERVER}`,
        type: 'm.room.message',
      };
      const neitherEvent = {
        room_id: `!plain_${i}:${AS_SERVER}`,
        sender: `@alice_${i}:${AS_SERVER}`,
        type: 'm.room.message',
      };

      const [uHit, rHit, none, bothAxes] = await Promise.all([
        Promise.resolve(getInterestedAppServices([usersOnly, roomsOnly, neither], userEvent)),
        Promise.resolve(getInterestedAppServices([usersOnly, roomsOnly, neither], roomEvent)),
        Promise.resolve(getInterestedAppServices([usersOnly, roomsOnly, neither], neitherEvent)),
        Promise.resolve(
          getInterestedAppServices([usersOnly, roomsOnly], {
            room_id: `!soft_und_${i}:${AS_SERVER}`,
            sender: `@bridge_und_${i}:${AS_SERVER}`,
            type: 'm.room.message',
          })
        ),
      ]);

      expect(uHit.map((a) => a.id)).toEqual(['users_only']);
      expect(rHit.map((a) => a.id)).toEqual(['rooms_only']);
      expect(none).toEqual([]);
      expect(bothAxes.map((a) => a.id).sort()).toEqual(['rooms_only', 'users_only']);
    });
  }
});

// ===========================================================================
// APPSERVICE — protocols '["irc"]' / '{"k":1}' / '3.14' ByToken∥list
// ===========================================================================

describe('race undecenary appservice protocols nested/object/float JSON after #338', () => {
  for (let i = 0; i < 10; i++) {
    it(`'["irc"]'→arr ∥ '{"k":1}'→obj ∥ '3.14'→float ByToken∥list flood-${i}`, async () => {
      const nested = asRow({
        id: `pnest_${i}`,
        as_token: `tok_pnest_${i}`,
        sender_localpart: 'pnest',
        protocols: '["irc"]',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const objProto = asRow({
        id: `pobj_${i}`,
        as_token: `tok_pobj_${i}`,
        sender_localpart: 'pobj',
        protocols: '{"k":1}',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const floatProto = asRow({
        id: `pfl_${i}`,
        as_token: `tok_pfl_${i}`,
        sender_localpart: 'pfl',
        protocols: '3.14',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const sqlNull = asRow({
        id: `pz_${i}`,
        as_token: `tok_pz_${i}`,
        sender_localpart: 'pz',
        protocols: null,
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });

      const [byNest, byObj, byFloat, bySql, list] = await Promise.all([
        getAppServiceByToken(createListDb([nested]), `tok_pnest_${i}`),
        getAppServiceByToken(createListDb([objProto]), `tok_pobj_${i}`),
        getAppServiceByToken(createListDb([floatProto]), `tok_pfl_${i}`),
        getAppServiceByToken(createListDb([sqlNull]), `tok_pz_${i}`),
        getAppServices(createListDb([nested, objProto, floatProto, sqlNull])),
      ]);

      expect(byNest?.protocols).toEqual(['irc']);
      expect(byObj?.protocols).toEqual({ k: 1 });
      expect(byFloat?.protocols).toBe(3.14);
      expect(bySql?.protocols).toEqual([]);
      expect(list.map((a) => a.protocols)).toEqual([['irc'], { k: 1 }, 3.14, []]);
    });
  }
});

// ===========================================================================
// APPSERVICE — HTTP 203/204 ok ∥ 400/401/403/503 retry under race
// ===========================================================================

describe('race undecenary appservice HTTP 203/204∥400/401/403/503 after #338', () => {
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
    it(`203∥204 → sent_at ∥ 400∥401∥403∥503 → retry under parallel flood-${i}`, async () => {
      const ok203 = createTxnDb(1100 + i * 6);
      const ok204 = createTxnDb(1110 + i * 6);
      const r400 = createTxnDb(1120 + i * 6);
      const r401 = createTxnDb(1130 + i * 6);
      const r403 = createTxnDb(1140 + i * 6);
      const r503 = createTxnDb(1150 + i * 6);

      const as203 = registration(
        'ok203',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://ok203.example.com' }
      );
      const as204 = registration(
        'ok204',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://ok204.example.com' }
      );
      const as400 = registration(
        'r400',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r400.example.com' }
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
      const as503 = registration(
        'r503',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r503.example.com' }
      );

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url.includes('ok203.example.com')) return new Response('', { status: 203 });
          if (url.includes('ok204.example.com')) return new Response(null, { status: 204 });
          if (url.includes('r400.example.com')) return new Response('bad', { status: 400 });
          if (url.includes('r401.example.com')) return new Response('auth', { status: 401 });
          if (url.includes('r403.example.com')) return new Response('forbid', { status: 403 });
          if (url.includes('r503.example.com')) return new Response('unavail', { status: 503 });
          return new Response('unexpected', { status: 599 });
        })
      );

      const events = [{ type: 'm.room.message', body: `undecenary_${i}` }];
      const [s203, s204, s400, s401, s403, s503] = await Promise.all([
        sendAppServiceTransaction(ok203, as203, events),
        sendAppServiceTransaction(ok204, as204, events),
        sendAppServiceTransaction(r400, as400, events),
        sendAppServiceTransaction(r401, as401, events),
        sendAppServiceTransaction(r403, as403, events),
        sendAppServiceTransaction(r503, as503, events),
      ]);

      expect(s203).toBe(true);
      expect(s204).toBe(true);
      expect(s400).toBe(false);
      expect(s401).toBe(false);
      expect(s403).toBe(false);
      expect(s503).toBe(false);

      expect(ok203.updates.filter((u) => u.kind === 'sent')).toHaveLength(1);
      expect(ok204.updates.filter((u) => u.kind === 'sent')).toHaveLength(1);
      expect(ok203.updates.filter((u) => u.kind === 'retry')).toHaveLength(0);
      expect(ok204.updates.filter((u) => u.kind === 'retry')).toHaveLength(0);

      for (const db of [r400, r401, r403, r503]) {
        expect(db.updates.filter((u) => u.kind === 'retry')).toHaveLength(1);
        expect(db.updates.filter((u) => u.kind === 'sent')).toHaveLength(0);
      }

      // Path uses last_row_id; Authorization Bearer hs_token
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      expect(fetchMock).toHaveBeenCalled();
      const firstCall = fetchMock.mock.calls[0];
      expect(String(firstCall[0])).toMatch(/\/_matrix\/app\/v1\/transactions\/\d+$/);
      expect((firstCall[1] as RequestInit).headers).toMatchObject({
        Authorization: expect.stringMatching(/^Bearer hs-/),
      });
    });
  }
});

// ===========================================================================
// AUTH — protocols '["x"]' / '{"k":1}' / '3.14' under requireAuth
// ===========================================================================

describe('race undecenary auth protocols nested/object/float under requireAuth after #338', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`protocols '["x"]'∥'{"k":1}'∥'3.14' allow ∥ ' ' unknown flood-${i}`, async () => {
      const nestTok = `as_und_nest_${i}`;
      const objTok = `as_und_obj_${i}`;
      const floatTok = `as_und_fl_${i}`;
      const badTok = `as_und_bad_${i}`;
      const db = createAuthDb({
        appservices: new Map([
          [
            nestTok,
            asRow({
              as_token: nestTok,
              sender_localpart: 'nest',
              protocols: '["x"]',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
          [
            objTok,
            asRow({
              as_token: objTok,
              sender_localpart: 'obj',
              protocols: '{"k":1}',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
          [
            floatTok,
            asRow({
              as_token: floatTok,
              sender_localpart: 'fl',
              protocols: '3.14',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
          [
            badTok,
            asRow({
              as_token: badTok,
              sender_localpart: 'bad',
              // whitespace-only protocols JSON throws on parse → AS lookup fails → unknown
              protocols: ' ',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
        ]),
      });

      const nestCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${nestTok}` },
      });
      const objCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${objTok}` },
      });
      const floatCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${floatTok}` },
      });
      const badCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${badTok}` },
      });
      const nestNext = vi.fn(async () => 'nest-ok');
      const objNext = vi.fn(async () => 'obj-ok');
      const floatNext = vi.fn(async () => 'float-ok');

      const [nestRes, objRes, floatRes, badRes] = await Promise.all([
        realRequireAuth()(nestCtx, nestNext),
        realRequireAuth()(objCtx, objNext),
        realRequireAuth()(floatCtx, floatNext),
        realRequireAuth()(badCtx, vi.fn()),
      ]);

      expect(nestRes).toBe('nest-ok');
      expect(objRes).toBe('obj-ok');
      expect(floatRes).toBe('float-ok');
      expect(nestNext).toHaveBeenCalledOnce();
      expect(objNext).toHaveBeenCalledOnce();
      expect(floatNext).toHaveBeenCalledOnce();
      expect(nestCtx.get('userId')).toBe(`@nest:${AUTH_SERVER}`);
      expect(objCtx.get('userId')).toBe(`@obj:${AUTH_SERVER}`);
      expect(floatCtx.get('userId')).toBe(`@fl:${AUTH_SERVER}`);

      const badBody = await jsonBody(badRes as Response);
      expect(badBody).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN', status: 401 });
      expect(badCtx.get('userId')).toBeUndefined();
      expect(badBody.error).not.toBe('Missing access token');
    });
  }
});

// ===========================================================================
// AUTH — namespaces missing-users / rooms-only skip ∥ restrictive deny
// ===========================================================================

describe('race undecenary auth namespaces missing-users/rooms-only skip after #338', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`missing-users∥rooms-only skip ∥ restrictive deny flood-${i}`, async () => {
      const missTok = `as_und_miss_${i}`;
      const roomsTok = `as_und_rooms_${i}`;
      const denyTok = `as_und_deny_${i}`;
      const localUser = `@guest_${i}:${AUTH_SERVER}`;
      const db = createAuthDb({
        appservices: new Map([
          [
            missTok,
            asRow({
              as_token: missTok,
              sender_localpart: 'miss',
              // users key absent → namespaces?.users?.length is undefined → skip gate
              namespaces: JSON.stringify({ rooms: [], aliases: [] }),
            }),
          ],
          [
            roomsTok,
            asRow({
              as_token: roomsTok,
              sender_localpart: 'rooms',
              namespaces: JSON.stringify({
                rooms: [{ exclusive: false, regex: `^!.*:${AUTH_SERVER.replace(/\./g, '\\.')}$` }],
                aliases: [],
              }),
            }),
          ],
          [
            denyTok,
            asRow({
              as_token: denyTok,
              sender_localpart: 'deny',
              namespaces: JSON.stringify({
                users: [
                  {
                    exclusive: true,
                    regex: `^@bot_.*:${AUTH_SERVER.replace(/\./g, '\\.')}$`,
                  },
                ],
                rooms: [],
                aliases: [],
              }),
            }),
          ],
        ]),
      });

      const missCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${missTok}` },
      });
      const roomsCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${roomsTok}` },
      });
      const denyCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${denyTok}` },
      });
      const missNext = vi.fn(async () => 'miss-ok');
      const roomsNext = vi.fn(async () => 'rooms-ok');

      const [missRes, roomsRes, denyRes] = await Promise.all([
        realRequireAuth()(missCtx, missNext),
        realRequireAuth()(roomsCtx, roomsNext),
        realRequireAuth()(denyCtx, vi.fn()),
      ]);

      expect(missRes).toBe('miss-ok');
      expect(roomsRes).toBe('rooms-ok');
      expect(missNext).toHaveBeenCalledOnce();
      expect(roomsNext).toHaveBeenCalledOnce();
      expect(missCtx.get('userId')).toBe(localUser);
      expect(roomsCtx.get('userId')).toBe(localUser);

      const denyBody = await jsonBody(denyRes as Response);
      expect(denyBody).toMatchObject({
        errcode: 'M_FORBIDDEN',
        status: 403,
      });
      expect(denyBody.error).toContain('application service namespace');
      expect(denyCtx.get('userId')).toBeUndefined();
      expect(denyBody.error).not.toContain('Invalid user_id format');
      expect(denyBody.error).not.toContain('other servers');
    });
  }
});

// ===========================================================================
// AUTH — empty user_id= ∥ valid AS user_id soft under race
// ===========================================================================

describe('race undecenary auth empty user_id= ∥ valid AS soft after #338', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`empty user_id= → default sender ∥ valid user_id under race flood-${i}`, async () => {
      const tok = `as_und_emptyuid_${i}`;
      const localUser = `@bot_und_${i}:${AUTH_SERVER}`;
      const db = createAuthDb({
        appservices: new Map([
          [
            tok,
            asRow({
              as_token: tok,
              sender_localpart: 'bridge',
              namespaces: JSON.stringify({
                users: [
                  {
                    exclusive: false,
                    regex: `^@bot_.*:${AUTH_SERVER.replace(/\./g, '\\.')}$`,
                  },
                ],
                rooms: [],
                aliases: [],
              }),
            }),
          ],
        ]),
      });

      // empty string is falsy → asUserId || default sender
      const emptyCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const validCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const emptyNext = vi.fn(async () => 'empty-ok');
      const validNext = vi.fn(async () => 'valid-ok');

      const [emptyRes, validRes] = await Promise.all([
        realRequireAuth()(emptyCtx, emptyNext),
        realRequireAuth()(validCtx, validNext),
      ]);

      expect(emptyRes).toBe('empty-ok');
      expect(validRes).toBe('valid-ok');
      expect(emptyNext).toHaveBeenCalledOnce();
      expect(validNext).toHaveBeenCalledOnce();
      expect(emptyCtx.get('userId')).toBe(`@bridge:${AUTH_SERVER}`);
      expect(emptyCtx.get('deviceId')).toBeNull();
      expect(validCtx.get('userId')).toBe(localUser);
      expect(validCtx.get('deviceId')).toBeNull();
    });
  }
});

// ===========================================================================
// AUTH — Bearer wins over stale query ∥ M_UNKNOWN_TOKEN soft
// ===========================================================================

describe('race undecenary auth Bearer-wins-over-query ∥ unknown soft after #338', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`Bearer AS wins over stale query ∥ unknown never mix flood-${i}`, async () => {
      const asTok = `as_und_bearer_${i}`;
      const staleQuery = `stale_query_${i}`;
      const db = createAuthDb({
        appservices: new Map([
          [
            asTok,
            asRow({
              as_token: asTok,
              sender_localpart: 'bridge',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
        ]),
      });

      // Authorization preferred over access_token query (even if query is garbage)
      const bearerWins = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(staleQuery)}`,
        headers: { Authorization: `Bearer ${asTok}` },
      });
      const unknown = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer not_real_${i}` },
      });
      const next = vi.fn(async () => 'bearer-ok');

      expect(
        extractAccessToken(
          new Request(
            `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(staleQuery)}`,
            { headers: { Authorization: `Bearer ${asTok}` } }
          )
        )
      ).toBe(asTok);

      const [okRes, unkRes] = await Promise.all([
        realRequireAuth()(bearerWins, next),
        realRequireAuth()(unknown, vi.fn()),
      ]);

      expect(okRes).toBe('bearer-ok');
      expect(next).toHaveBeenCalledOnce();
      expect(bearerWins.get('userId')).toBe(`@bridge:${AUTH_SERVER}`);
      expect(bearerWins.get('deviceId')).toBeNull();

      const unkBody = await jsonBody(unkRes as Response);
      expect(unkBody).toMatchObject({
        errcode: 'M_UNKNOWN_TOKEN',
        status: 401,
      });
      expect(unknown.get('userId')).toBeUndefined();
      expect(unkBody.error).not.toBe('Missing access token');
      expect(unkBody.error).not.toContain('application service');
    });
  }
});
