/**
 * TOKENMAXX HEAVY tip-relaunch after #364/#366 (tip c8c1af7) — duodenary
 * *filters + appservice + auth* concurrent-race niches not covered by undecenary
 * (#350), denary (#338), nonary (#319), octonary (#312), septenary (#304),
 * senary (#292), or quinary (#286) floods. Relaunch of closed #369/#375 onto
 * tip post-#364/#366.
 *
 * Gap table (why leftover after #350 undecenary / tip #366):
 *   Filters "0" / "false" / "null" / "1" string-primitive mint + TTL ∥ carol forbid
 *     | undecenary 1/3.14/[null]/{a:null}; denary false/0/""/-1; never JSON-string looks
 *   Filters stored true / 1 / 3.14 / "x" / {a:null} / [null] GET soft ∥ carol read-forbid
 *     | undecenary null/false/0/[]; never true/1/float/str/null-obj/null-arr under forbid
 *   isExclusiveAppServiceUser exclusive:false miss ∥ wrong excludeAsId still hit
 *     | undecenary exclusive USER miss∥hit + matching exclude skip; never false∥wrong-id
 *   state_key membership interest hit ∥ sender-miss rooms-only twin
 *     | undecenary users-only∥rooms-only on sender/room_id; never state_key-only interest
 *   protocols '[null]' / '{"a":null}' / '"irc"' ByToken∥list quirks
 *     | undecenary ["irc"]/{k:1}/3.14; never null-array/null-obj/JSON-string
 *   HTTP 205/206/207 ok ∥ 402/405/429/502/504 retry under race
 *     | undecenary 203/204∥400/401/403/503; denary 202∥302/404/500; never 205–207∥402+
 *   Auth protocols '[null]'/'{"a":null}'/'"irc"' under requireAuth
 *     | undecenary ["x"]/{k:1}/3.14; never null-array/null-obj/JSON-string under AS auth
 *   Auth namespaces empty-regex allow ∥ bad-regex deny ∥ valid allow
 *     | undecenary missing-users/rooms-only; octonary users:null/[]; never empty∥bad-regex gate
 *   Auth whitespace user_id ∥ foreign-server forbid ∥ valid AS soft under race
 *     | undecenary empty user_id= default; never whitespace-format∥foreign twin
 *   Auth bearer/BEARER case ∥ Basic-scheme falls to query AS ∥ unknown soft
 *     | undecenary Bearer-wins-over-stale-query; never case-fold∥Basic-fallback under race
 *
 * Distinct from #350 undecenary, #338 denary, #319 nonary, #312 octonary, #304 septenary.
 * New file. Tests-only. example.com / matrix.example.com fixtures only.
 * Does not touch auth.ts source (HITL). Reversible by delete.
 * No invent-product / secrets / DNS / history rewrite.
 * Do not edit .github/workflows (npm script alone extends canary).
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
// Filters harness (mocked requireAuth — mirrors undecenary/denary series)
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
const AUTH_ESC = AUTH_SERVER.replace(/\./g, '\\.');
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
// FILTERS — "0" / "false" / "null" / "1" JSON-string mint + TTL ∥ carol forbid
// ===========================================================================

describe('race duodenary filter JSON-string primitive mint + TTL soft after #350', () => {
  for (let i = 0; i < 12; i++) {
    it(`"0"∥"false"∥"null"∥"1" mint + TTL ∥ carol forbid flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const putsBefore = cache.putCount;

      const [zeroStr, falseStr, nullStr, oneStr, forbid] = await Promise.all([
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"0"',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"false"',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"null"',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"1"',
        }),
        request(env, filterCollection(CAROL_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: JSON.stringify({ room: { timeline: { limit: i } } }),
        }),
      ]);

      expect(zeroStr.status).toBe(200);
      expect(falseStr.status).toBe(200);
      expect(nullStr.status).toBe(200);
      expect(oneStr.status).toBe(200);
      expect(forbid.status).toBe(403);
      expect(forbid.body).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot create filters for other users',
      });

      const ids = [
        (zeroStr.body as { filter_id: string }).filter_id,
        (falseStr.body as { filter_id: string }).filter_id,
        (nullStr.body as { filter_id: string }).filter_id,
        (oneStr.body as { filter_id: string }).filter_id,
      ];
      expect(new Set(ids).size).toBe(4);
      expect(cache.putCount).toBe(putsBefore + 4);

      const byId = Object.fromEntries(
        cache.puts.slice(-4).map((p) => {
          const fid = p.key.split(':').pop()!;
          return [fid, p];
        })
      );
      // Stored as JSON strings — not boolean/null/number primitives
      expect(JSON.parse(byId[ids[0]].value)).toBe('0');
      expect(JSON.parse(byId[ids[1]].value)).toBe('false');
      expect(JSON.parse(byId[ids[2]].value)).toBe('null');
      expect(JSON.parse(byId[ids[3]].value)).toBe('1');
      for (const id of ids) {
        expect(byId[id].options?.expirationTtl).toBe(FILTER_TTL);
        expect(byId[id].key).toBe(`filter:${USER}:${id}`);
      }
      expect(Object.keys(cache.data).every((k) => !k.includes(CAROL))).toBe(true);
      expect((forbid.body as { error: string }).error).not.toContain('Invalid JSON');
    });
  }
});

// ===========================================================================
// FILTERS — stored true / 1 / 3.14 / "x" / {a:null} / [null] GET soft ∥ carol
// ===========================================================================

describe('race duodenary filter true/1/float/str/null-obj/null-arr GET soft after #350', () => {
  for (let i = 0; i < 10; i++) {
    it(`stored true∥1∥3.14∥"x"∥{a:null}∥[null] ∥ carol forbid never mix flood-${i}`, async () => {
      const trueId = `duo_true_${i}`;
      const oneId = `duo_one_${i}`;
      const floatId = `duo_float_${i}`;
      const strId = `duo_str_${i}`;
      const objId = `duo_obj_${i}`;
      const arrId = `duo_narr_${i}`;
      const cache = mockCache({
        [`filter:${USER}:${trueId}`]: 'true',
        [`filter:${USER}:${oneId}`]: '1',
        [`filter:${USER}:${floatId}`]: '3.14',
        [`filter:${USER}:${strId}`]: '"x"',
        [`filter:${USER}:${objId}`]: '{"a":null}',
        [`filter:${USER}:${arrId}`]: '[null]',
      });
      const env = createEnv(cache);
      const getsBefore = cache.getCount;

      const [trueGet, oneGet, floatGet, strGet, objGet, arrGet, forbid] = await Promise.all([
        request(env, filterPath(trueId), { headers: AUTH }),
        request(env, filterPath(oneId), { headers: AUTH }),
        request(env, filterPath(floatId), { headers: AUTH }),
        request(env, filterPath(strId), { headers: AUTH }),
        request(env, filterPath(objId), { headers: AUTH }),
        request(env, filterPath(arrId), { headers: AUTH }),
        request(env, filterPath(trueId, CAROL_ENC), { headers: AUTH }),
      ]);

      expect(trueGet.status).toBe(200);
      expect(trueGet.body).toBe(true);
      expect(oneGet.status).toBe(200);
      expect(oneGet.body).toBe(1);
      expect(floatGet.status).toBe(200);
      expect(floatGet.body).toBe(3.14);
      expect(strGet.status).toBe(200);
      expect(strGet.body).toBe('x');
      expect(objGet.status).toBe(200);
      expect(objGet.body).toEqual({ a: null });
      expect(arrGet.status).toBe(200);
      expect(arrGet.body).toEqual([null]);
      expect(forbid.status).toBe(403);
      expect(forbid.body).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot read filters for other users',
      });

      // Soft success bodies never gain errcode; forbid never touches CACHE
      expect(trueGet.body).toBe(true);
      expect(oneGet.body).toBe(1);
      expect(floatGet.body).toBe(3.14);
      expect(strGet.body).toBe('x');
      expect(objGet.body).toEqual({ a: null });
      expect(arrGet.body).toEqual([null]);
      expect(cache.getCount).toBe(getsBefore + 6);
      expect((forbid.body as { error: string }).error).not.toBe(
        'Cannot create filters for other users'
      );
    });
  }
});

// ===========================================================================
// APPSERVICE — exclusive:false never matches ∥ wrong excludeAsId still hits
// ===========================================================================

describe('race duodenary appservice exclusive:false miss∥wrong excludeAsId after #350', () => {
  for (let i = 0; i < 10; i++) {
    it(`exclusive:false miss ∥ wrong excludeAsId still hit flood-${i}`, async () => {
      const soft = registration('soft_eu', {
        users: [
          {
            exclusive: false,
            regex: `^@_bot_.*:${AS_ESC}$`,
          },
        ],
        rooms: [],
        aliases: [],
      });
      const hard = registration('hard_eu', {
        users: [
          {
            exclusive: true,
            regex: `^@_bot_.*:${AS_ESC}$`,
          },
        ],
        rooms: [],
        aliases: [],
      });
      const userId = `@_bot_duodenary_${i}:${AS_SERVER}`;

      const [missSoft, hitHard, wrongExclude, rightExclude] = await Promise.all([
        Promise.resolve(isExclusiveAppServiceUser([soft], userId)),
        Promise.resolve(isExclusiveAppServiceUser([hard], userId)),
        Promise.resolve(isExclusiveAppServiceUser([hard], userId, 'other_as')),
        Promise.resolve(isExclusiveAppServiceUser([hard], userId, 'hard_eu')),
      ]);

      expect(missSoft).toBeNull();
      expect(hitHard?.id).toBe('hard_eu');
      expect(wrongExclude?.id).toBe('hard_eu');
      expect(rightExclude).toBeNull();

      // Soft exclusive:false never shadows exclusive:true sibling
      const mixed = isExclusiveAppServiceUser([soft, hard], userId);
      expect(mixed?.id).toBe('hard_eu');
    });
  }
});

// ===========================================================================
// APPSERVICE — state_key membership interest ∥ sender-miss rooms-only
// ===========================================================================

describe('race duodenary appservice state_key interest∥rooms-only after #350', () => {
  for (let i = 0; i < 10; i++) {
    it(`state_key hit ∥ sender miss+rooms hit ∥ neither flood-${i}`, async () => {
      const usersOnly = registration('users_sk', {
        users: [
          {
            exclusive: false,
            regex: `^@_ghost_.*:${AS_ESC}$`,
          },
        ],
        rooms: [],
        aliases: [],
      });
      const roomsOnly = registration('rooms_sk', {
        users: [],
        rooms: [
          {
            exclusive: false,
            regex: `^!duo_.*:${AS_ESC}$`,
          },
        ],
        aliases: [],
      });

      const stateKeyEvent = {
        room_id: `!plain_${i}:${AS_SERVER}`,
        sender: `@alice_${i}:${AS_SERVER}`,
        state_key: `@_ghost_duo_${i}:${AS_SERVER}`,
        type: 'm.room.member',
      };
      const roomOnlyEvent = {
        room_id: `!duo_room_${i}:${AS_SERVER}`,
        sender: `@alice_${i}:${AS_SERVER}`,
        type: 'm.room.message',
      };
      const neitherEvent = {
        room_id: `!plain_${i}:${AS_SERVER}`,
        sender: `@alice_${i}:${AS_SERVER}`,
        type: 'm.room.message',
      };

      const [skHit, roomHit, none, both] = await Promise.all([
        Promise.resolve(getInterestedAppServices([usersOnly, roomsOnly], stateKeyEvent)),
        Promise.resolve(getInterestedAppServices([usersOnly, roomsOnly], roomOnlyEvent)),
        Promise.resolve(getInterestedAppServices([usersOnly, roomsOnly], neitherEvent)),
        Promise.resolve(
          getInterestedAppServices([usersOnly, roomsOnly], {
            room_id: `!duo_room_${i}:${AS_SERVER}`,
            sender: `@alice_${i}:${AS_SERVER}`,
            state_key: `@_ghost_duo_${i}:${AS_SERVER}`,
            type: 'm.room.member',
          })
        ),
      ]);

      expect(skHit.map((a) => a.id)).toEqual(['users_sk']);
      expect(roomHit.map((a) => a.id)).toEqual(['rooms_sk']);
      expect(none).toEqual([]);
      expect(both.map((a) => a.id).sort()).toEqual(['rooms_sk', 'users_sk']);
    });
  }
});

// ===========================================================================
// APPSERVICE — protocols '[null]' / '{"a":null}' / '"irc"' ByToken∥list
// ===========================================================================

describe('race duodenary appservice protocols null-array/null-obj/str JSON after #350', () => {
  for (let i = 0; i < 10; i++) {
    it(`'[null]'→arr ∥ '{"a":null}'→obj ∥ '"irc"'→str ByToken∥list flood-${i}`, async () => {
      const nullArr = asRow({
        id: `pnarr_${i}`,
        as_token: `tok_pnarr_${i}`,
        sender_localpart: 'pnarr',
        protocols: '[null]',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const nullObj = asRow({
        id: `pnobj_${i}`,
        as_token: `tok_pnobj_${i}`,
        sender_localpart: 'pnobj',
        protocols: '{"a":null}',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const strProto = asRow({
        id: `pstr_${i}`,
        as_token: `tok_pstr_${i}`,
        sender_localpart: 'pstr',
        protocols: '"irc"',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const sqlNull = asRow({
        id: `pz_${i}`,
        as_token: `tok_pz_${i}`,
        sender_localpart: 'pz',
        protocols: null,
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });

      const [byNarr, byNobj, byStr, bySql, list] = await Promise.all([
        getAppServiceByToken(createListDb([nullArr]), `tok_pnarr_${i}`),
        getAppServiceByToken(createListDb([nullObj]), `tok_pnobj_${i}`),
        getAppServiceByToken(createListDb([strProto]), `tok_pstr_${i}`),
        getAppServiceByToken(createListDb([sqlNull]), `tok_pz_${i}`),
        getAppServices(createListDb([nullArr, nullObj, strProto, sqlNull])),
      ]);

      expect(byNarr?.protocols).toEqual([null]);
      expect(byNobj?.protocols).toEqual({ a: null });
      expect(byStr?.protocols).toBe('irc');
      expect(bySql?.protocols).toEqual([]);
      expect(list.map((a) => a.protocols)).toEqual([[null], { a: null }, 'irc', []]);
    });
  }
});

// ===========================================================================
// APPSERVICE — HTTP 205/206/207 ok ∥ 402/405/429/502/504 retry under race
// ===========================================================================

describe('race duodenary appservice HTTP 205/206/207∥402/405/429/502/504 after #350', () => {
  const NOW = 1_700_000_900_000;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  function createTxnDb(startRowId = 2100) {
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
    it(`205∥206∥207 → sent_at ∥ 402∥405∥429∥502∥504 → retry under parallel flood-${i}`, async () => {
      const ok205 = createTxnDb(2100 + i * 8);
      const ok206 = createTxnDb(2110 + i * 8);
      const ok207 = createTxnDb(2120 + i * 8);
      const r402 = createTxnDb(2130 + i * 8);
      const r405 = createTxnDb(2140 + i * 8);
      const r429 = createTxnDb(2150 + i * 8);
      const r502 = createTxnDb(2160 + i * 8);
      const r504 = createTxnDb(2170 + i * 8);

      const as205 = registration(
        'ok205',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://ok205.example.com' }
      );
      const as206 = registration(
        'ok206',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://ok206.example.com' }
      );
      const as207 = registration(
        'ok207',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://ok207.example.com' }
      );
      const as402 = registration(
        'r402',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r402.example.com' }
      );
      const as405 = registration(
        'r405',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r405.example.com' }
      );
      const as429 = registration(
        'r429',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r429.example.com' }
      );
      const as502 = registration(
        'r502',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r502.example.com' }
      );
      const as504 = registration(
        'r504',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r504.example.com' }
      );

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          // Node/undici forbids a body with 205 (same as 204); use null body.
          if (url.includes('ok205.example.com')) return new Response(null, { status: 205 });
          if (url.includes('ok206.example.com')) return new Response(null, { status: 206 });
          if (url.includes('ok207.example.com')) return new Response('multi', { status: 207 });
          if (url.includes('r402.example.com')) return new Response('pay', { status: 402 });
          if (url.includes('r405.example.com')) return new Response('method', { status: 405 });
          if (url.includes('r429.example.com')) return new Response('rate', { status: 429 });
          if (url.includes('r502.example.com')) return new Response('badgw', { status: 502 });
          if (url.includes('r504.example.com')) return new Response('timeout', { status: 504 });
          return new Response('unexpected', { status: 599 });
        })
      );

      const events = [{ type: 'm.room.message', body: `duodenary_${i}` }];
      const [s205, s206, s207, s402, s405, s429, s502, s504] = await Promise.all([
        sendAppServiceTransaction(ok205, as205, events),
        sendAppServiceTransaction(ok206, as206, events),
        sendAppServiceTransaction(ok207, as207, events),
        sendAppServiceTransaction(r402, as402, events),
        sendAppServiceTransaction(r405, as405, events),
        sendAppServiceTransaction(r429, as429, events),
        sendAppServiceTransaction(r502, as502, events),
        sendAppServiceTransaction(r504, as504, events),
      ]);

      expect(s205).toBe(true);
      expect(s206).toBe(true);
      expect(s207).toBe(true);
      expect(s402).toBe(false);
      expect(s405).toBe(false);
      expect(s429).toBe(false);
      expect(s502).toBe(false);
      expect(s504).toBe(false);

      for (const db of [ok205, ok206, ok207]) {
        expect(db.updates.filter((u) => u.kind === 'sent')).toHaveLength(1);
        expect(db.updates.filter((u) => u.kind === 'retry')).toHaveLength(0);
      }
      for (const db of [r402, r405, r429, r502, r504]) {
        expect(db.updates.filter((u) => u.kind === 'retry')).toHaveLength(1);
        expect(db.updates.filter((u) => u.kind === 'sent')).toHaveLength(0);
      }

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
// AUTH — protocols '[null]' / '{"a":null}' / '"irc"' under requireAuth
// ===========================================================================

describe('race duodenary auth protocols null-array/null-obj/str under requireAuth after #350', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`protocols '[null]'∥'{"a":null}'∥'"irc"' allow ∥ ' ' unknown flood-${i}`, async () => {
      const narrTok = `as_duo_narr_${i}`;
      const nobjTok = `as_duo_nobj_${i}`;
      const strTok = `as_duo_str_${i}`;
      const badTok = `as_duo_bad_${i}`;
      const db = createAuthDb({
        appservices: new Map([
          [
            narrTok,
            asRow({
              as_token: narrTok,
              sender_localpart: 'narr',
              protocols: '[null]',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
          [
            nobjTok,
            asRow({
              as_token: nobjTok,
              sender_localpart: 'nobj',
              protocols: '{"a":null}',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
          [
            strTok,
            asRow({
              as_token: strTok,
              sender_localpart: 'pstr',
              protocols: '"irc"',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
          [
            badTok,
            asRow({
              as_token: badTok,
              sender_localpart: 'bad',
              protocols: ' ',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
        ]),
      });

      const narrCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${narrTok}` },
      });
      const nobjCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${nobjTok}` },
      });
      const strCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${strTok}` },
      });
      const badCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${badTok}` },
      });
      const narrNext = vi.fn(async () => 'narr-ok');
      const nobjNext = vi.fn(async () => 'nobj-ok');
      const strNext = vi.fn(async () => 'str-ok');

      const [narrRes, nobjRes, strRes, badRes] = await Promise.all([
        realRequireAuth()(narrCtx, narrNext),
        realRequireAuth()(nobjCtx, nobjNext),
        realRequireAuth()(strCtx, strNext),
        realRequireAuth()(badCtx, vi.fn()),
      ]);

      expect(narrRes).toBe('narr-ok');
      expect(nobjRes).toBe('nobj-ok');
      expect(strRes).toBe('str-ok');
      expect(narrNext).toHaveBeenCalledOnce();
      expect(nobjNext).toHaveBeenCalledOnce();
      expect(strNext).toHaveBeenCalledOnce();
      expect(narrCtx.get('userId')).toBe(`@narr:${AUTH_SERVER}`);
      expect(nobjCtx.get('userId')).toBe(`@nobj:${AUTH_SERVER}`);
      expect(strCtx.get('userId')).toBe(`@pstr:${AUTH_SERVER}`);

      const badBody = await jsonBody(badRes as Response);
      expect(badBody).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN', status: 401 });
      expect(badCtx.get('userId')).toBeUndefined();
      expect(badBody.error).not.toBe('Missing access token');
    });
  }
});

// ===========================================================================
// AUTH — namespaces empty-regex allow ∥ bad-regex deny ∥ valid allow
// ===========================================================================

describe('race duodenary auth namespaces empty-regex allow∥bad-regex deny after #350', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`empty-regex allow ∥ bad-regex deny ∥ valid allow flood-${i}`, async () => {
      const emptyReTok = `as_duo_emptyre_${i}`;
      const badReTok = `as_duo_badre_${i}`;
      const allowTok = `as_duo_allow_${i}`;
      const localUser = `@guest_${i}:${AUTH_SERVER}`;
      const botUser = `@bot_duo_${i}:${AUTH_SERVER}`;
      const db = createAuthDb({
        appservices: new Map([
          [
            emptyReTok,
            asRow({
              as_token: emptyReTok,
              sender_localpart: 'emptyre',
              // empty regex → /(?:)/ matches any user_id → allow
              namespaces: JSON.stringify({
                users: [{ exclusive: false, regex: '' }],
                rooms: [],
                aliases: [],
              }),
            }),
          ],
          [
            badReTok,
            asRow({
              as_token: badReTok,
              sender_localpart: 'badre',
              // invalid regex throws → catch returns false → no ns matches → deny
              namespaces: JSON.stringify({
                users: [{ exclusive: false, regex: '(' }],
                rooms: [],
                aliases: [],
              }),
            }),
          ],
          [
            allowTok,
            asRow({
              as_token: allowTok,
              sender_localpart: 'allow',
              namespaces: JSON.stringify({
                users: [
                  {
                    exclusive: false,
                    regex: `^@bot_.*:${AUTH_ESC}$`,
                  },
                ],
                rooms: [],
                aliases: [],
              }),
            }),
          ],
        ]),
      });

      const emptyReCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${emptyReTok}` },
      });
      const badReCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${badReTok}` },
      });
      const allowCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(botUser)}`,
        headers: { Authorization: `Bearer ${allowTok}` },
      });
      const emptyReNext = vi.fn(async () => 'emptyre-ok');
      const allowNext = vi.fn(async () => 'allow-ok');

      const [emptyReRes, badReRes, allowRes] = await Promise.all([
        realRequireAuth()(emptyReCtx, emptyReNext),
        realRequireAuth()(badReCtx, vi.fn()),
        realRequireAuth()(allowCtx, allowNext),
      ]);

      expect(emptyReRes).toBe('emptyre-ok');
      expect(allowRes).toBe('allow-ok');
      expect(emptyReNext).toHaveBeenCalledOnce();
      expect(allowNext).toHaveBeenCalledOnce();
      expect(emptyReCtx.get('userId')).toBe(localUser);
      expect(allowCtx.get('userId')).toBe(botUser);

      const badBody = await jsonBody(badReRes as Response);
      expect(badBody).toMatchObject({
        errcode: 'M_FORBIDDEN',
        status: 403,
      });
      expect(badBody.error).toContain('application service namespace');
      expect(badReCtx.get('userId')).toBeUndefined();
      expect(badBody.error).not.toContain('Invalid user_id format');
      expect(badBody.error).not.toContain('other servers');
    });
  }
});

// ===========================================================================
// AUTH — whitespace user_id ∥ foreign-server forbid ∥ valid AS soft
// ===========================================================================

describe('race duodenary auth whitespace∥foreign forbid∥valid soft after #350', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`whitespace format∥foreign server forbid ∥ valid never mix flood-${i}`, async () => {
      const tok = `as_duo_uid_${i}`;
      const localUser = `@bot_duo_${i}:${AUTH_SERVER}`;
      const foreignUser = `@bot_duo_${i}:other.example.com`;
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
                    regex: `^@bot_.*:${AUTH_ESC}$`,
                  },
                ],
                rooms: [],
                aliases: [],
              }),
            }),
          ],
        ]),
      });

      const wsCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(' ')}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const foreignCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(foreignUser)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const validCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const validNext = vi.fn(async () => 'valid-ok');

      const [wsRes, foreignRes, validRes] = await Promise.all([
        realRequireAuth()(wsCtx, vi.fn()),
        realRequireAuth()(foreignCtx, vi.fn()),
        realRequireAuth()(validCtx, validNext),
      ]);

      expect(validRes).toBe('valid-ok');
      expect(validNext).toHaveBeenCalledOnce();
      expect(validCtx.get('userId')).toBe(localUser);
      expect(validCtx.get('deviceId')).toBeNull();

      const wsBody = await jsonBody(wsRes as Response);
      expect(wsBody).toMatchObject({
        errcode: 'M_FORBIDDEN',
        status: 403,
      });
      expect(wsBody.error).toContain('Invalid user_id format');
      expect(wsCtx.get('userId')).toBeUndefined();

      const foreignBody = await jsonBody(foreignRes as Response);
      expect(foreignBody).toMatchObject({
        errcode: 'M_FORBIDDEN',
        status: 403,
      });
      expect(foreignBody.error).toContain('other servers');
      expect(foreignCtx.get('userId')).toBeUndefined();
      expect(foreignBody.error).not.toContain('Invalid user_id format');
      expect(wsBody.error).not.toContain('other servers');
    });
  }
});

// ===========================================================================
// AUTH — bearer/BEARER case ∥ Basic-scheme falls to query AS ∥ unknown soft
// ===========================================================================

describe('race duodenary auth bearer case∥Basic→query AS∥unknown soft after #350', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`bearer∥BEARER∥Basic→query AS ∥ unknown never mix flood-${i}`, async () => {
      const asTok = `as_duo_case_${i}`;
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

      expect(
        extractAccessToken(
          new Request(`https://${AUTH_SERVER}/sync`, {
            headers: { Authorization: `bearer ${asTok}` },
          })
        )
      ).toBe(asTok);
      expect(
        extractAccessToken(
          new Request(`https://${AUTH_SERVER}/sync`, {
            headers: { Authorization: `BEARER ${asTok}` },
          })
        )
      ).toBe(asTok);
      // Non-Bearer Authorization does not match → fall through to query
      expect(
        extractAccessToken(
          new Request(
            `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(asTok)}`,
            { headers: { Authorization: `Basic ${asTok}` } }
          )
        )
      ).toBe(asTok);

      const lowerCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `bearer ${asTok}` },
      });
      const upperCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `BEARER ${asTok}` },
      });
      const basicQueryCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(asTok)}`,
        headers: { Authorization: `Basic ${asTok}` },
      });
      const unknown = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer not_real_${i}` },
      });
      const lowerNext = vi.fn(async () => 'lower-ok');
      const upperNext = vi.fn(async () => 'upper-ok');
      const basicNext = vi.fn(async () => 'basic-ok');

      const [lowerRes, upperRes, basicRes, unkRes] = await Promise.all([
        realRequireAuth()(lowerCtx, lowerNext),
        realRequireAuth()(upperCtx, upperNext),
        realRequireAuth()(basicQueryCtx, basicNext),
        realRequireAuth()(unknown, vi.fn()),
      ]);

      expect(lowerRes).toBe('lower-ok');
      expect(upperRes).toBe('upper-ok');
      expect(basicRes).toBe('basic-ok');
      expect(lowerNext).toHaveBeenCalledOnce();
      expect(upperNext).toHaveBeenCalledOnce();
      expect(basicNext).toHaveBeenCalledOnce();
      expect(lowerCtx.get('userId')).toBe(`@bridge:${AUTH_SERVER}`);
      expect(upperCtx.get('userId')).toBe(`@bridge:${AUTH_SERVER}`);
      expect(basicQueryCtx.get('userId')).toBe(`@bridge:${AUTH_SERVER}`);
      expect(lowerCtx.get('deviceId')).toBeNull();

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
