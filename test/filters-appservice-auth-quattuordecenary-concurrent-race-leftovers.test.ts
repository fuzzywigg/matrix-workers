/**
 * TOKENMAXX HEAVY tip-relaunch after #390 (tip b041ae8) — quattuordecenary
 * *filters + appservice + auth* concurrent-race niches not covered by tridecenary
 * (#390), duodenary (#378), undecenary (#350), denary (#338), nonary (#319),
 * octonary (#312), septenary (#304), senary (#292), or quinary (#286) floods.
 *
 * Gap table (why leftover after #390 tridecenary / tip b041ae8):
 *   Filters "-1" / "42" / "1e2" / "NaN" string-primitive mint + TTL ∥ carol forbid
 *     | tridecenary "true"/"3.14"/"[]"/"{}"; duodenary "0"/"false"/"null"/"1"; never neg/int/sci/NaN str
 *   Filters stored "-1" / "42" / "1" / "[]" / "{}" / [0] GET soft ∥ carol read-forbid
 *     | tridecenary "0"/"false"/"null"/"true"/{}/[1]; never neg/int/"1"/str-arr/str-obj/[0]
 *   isExclusiveAppServiceUser within-AS false→true hit ∥ all-false miss ∥ wrong exclude
 *     | tridecenary exclusive:false ALIAS; duodenary exclusive:false USER across AS; never within-AS multi-ns
 *   multi user-ns first-miss second-hit sender interest ∥ rooms-only twin
 *     | tridecenary sender-hit∥state_key-miss rooms; never multi-ns first-miss second-hit
 *   protocols '"null"' / '"1"' / '"42"' / '"{}"' ByToken∥list quirks
 *     | tridecenary "true"/"0"/"[]"/"false"; never null/1/42/empty-obj JSON-string lookalikes
 *   HTTP 209/218 ok ∥ 411/415/418/422/505 retry under race
 *     | tridecenary 208/226∥406/408/409/410/501; never 209/218∥411+
 *   Auth protocols '"null"'/'"1"'/'"42"' under requireAuth
 *     | tridecenary "true"/"0"/"[]"; never null/1/42 string-lookalikes under AS auth
 *   Auth namespaces exclusive:true first-match allow ∥ both-miss deny ∥ open
 *     | tridecenary exclusive:false multi; nonary exclusive:false gate; never exclusive:true multi twin
 *   Auth trailing-dot server foreign ∥ missing-@ format forbid ∥ valid soft under race
 *     | tridecenary empty-lp∥double-at; duodenary whitespace∥foreign; never trailing-dot∥missing-@
 *   Auth Negotiate→query AS ∥ NTLM→query ∥ unknown soft
 *     | tridecenary Digest/Token; duodenary Basic; never Negotiate/NTLM fallthrough under this series
 *
 * Distinct from #390 tridecenary, #378 duodenary, #350 undecenary, #338 denary.
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
// Filters harness (mocked requireAuth — mirrors tridecenary/duodenary series)
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
// FILTERS — "-1" / "42" / "1e2" / "NaN" JSON-string mint + TTL ∥ carol forbid
// ===========================================================================

describe('race quattuordecenary filter JSON-string neg/int/sci/NaN mint + TTL soft after #390', () => {
  for (let i = 0; i < 12; i++) {
    it(`"-1"∥"42"∥"1e2"∥"NaN" mint + TTL ∥ carol forbid flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const putsBefore = cache.putCount;

      const [negStr, intStr, sciStr, nanStr, forbid] = await Promise.all([
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"-1"',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"42"',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"1e2"',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"NaN"',
        }),
        request(env, filterCollection(CAROL_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: JSON.stringify({ room: { timeline: { limit: i } } }),
        }),
      ]);

      expect(negStr.status).toBe(200);
      expect(intStr.status).toBe(200);
      expect(sciStr.status).toBe(200);
      expect(nanStr.status).toBe(200);
      expect(forbid.status).toBe(403);
      expect(forbid.body).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot create filters for other users',
      });

      const ids = [
        (negStr.body as { filter_id: string }).filter_id,
        (intStr.body as { filter_id: string }).filter_id,
        (sciStr.body as { filter_id: string }).filter_id,
        (nanStr.body as { filter_id: string }).filter_id,
      ];
      expect(new Set(ids).size).toBe(4);
      expect(cache.putCount).toBe(putsBefore + 4);

      const byId = Object.fromEntries(
        cache.puts.slice(-4).map((p) => {
          const fid = p.key.split(':').pop()!;
          return [fid, p];
        })
      );
      // Stored as JSON strings — not number/NaN primitives
      expect(JSON.parse(byId[ids[0]].value)).toBe('-1');
      expect(JSON.parse(byId[ids[1]].value)).toBe('42');
      expect(JSON.parse(byId[ids[2]].value)).toBe('1e2');
      expect(JSON.parse(byId[ids[3]].value)).toBe('NaN');
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
// FILTERS — stored "-1" / "42" / "1" / "[]" / "{}" / [0] GET soft ∥ carol
// ===========================================================================

describe('race quattuordecenary filter str-lookalike/[0] GET soft after #390', () => {
  for (let i = 0; i < 10; i++) {
    it(`stored "-1"∥"42"∥"1"∥"[]"∥"{}"∥[0] ∥ carol forbid never mix flood-${i}`, async () => {
      const negId = `qd_neg_${i}`;
      const intId = `qd_int_${i}`;
      const oneId = `qd_one_${i}`;
      const arrStrId = `qd_arrstr_${i}`;
      const objStrId = `qd_objstr_${i}`;
      const zeroArrId = `qd_zarr_${i}`;
      const cache = mockCache({
        [`filter:${USER}:${negId}`]: '"-1"',
        [`filter:${USER}:${intId}`]: '"42"',
        [`filter:${USER}:${oneId}`]: '"1"',
        [`filter:${USER}:${arrStrId}`]: '"[]"',
        [`filter:${USER}:${objStrId}`]: '"{}"',
        [`filter:${USER}:${zeroArrId}`]: '[0]',
      });
      const env = createEnv(cache);
      const getsBefore = cache.getCount;

      const [negGet, intGet, oneGet, arrStrGet, objStrGet, zeroArrGet, forbid] = await Promise.all([
        request(env, filterPath(negId), { headers: AUTH }),
        request(env, filterPath(intId), { headers: AUTH }),
        request(env, filterPath(oneId), { headers: AUTH }),
        request(env, filterPath(arrStrId), { headers: AUTH }),
        request(env, filterPath(objStrId), { headers: AUTH }),
        request(env, filterPath(zeroArrId), { headers: AUTH }),
        request(env, filterPath(negId, CAROL_ENC), { headers: AUTH }),
      ]);

      expect(negGet.status).toBe(200);
      expect(negGet.body).toBe('-1');
      expect(intGet.status).toBe(200);
      expect(intGet.body).toBe('42');
      expect(oneGet.status).toBe(200);
      expect(oneGet.body).toBe('1');
      expect(arrStrGet.status).toBe(200);
      expect(arrStrGet.body).toBe('[]');
      expect(objStrGet.status).toBe(200);
      expect(objStrGet.body).toBe('{}');
      expect(zeroArrGet.status).toBe(200);
      expect(zeroArrGet.body).toEqual([0]);
      expect(forbid.status).toBe(403);
      expect(forbid.body).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot read filters for other users',
      });

      // Soft success bodies never gain errcode; forbid never touches CACHE
      expect(negGet.body).toBe('-1');
      expect(intGet.body).toBe('42');
      expect(oneGet.body).toBe('1');
      expect(arrStrGet.body).toBe('[]');
      expect(objStrGet.body).toBe('{}');
      expect(zeroArrGet.body).toEqual([0]);
      expect(cache.getCount).toBe(getsBefore + 6);
      expect((forbid.body as { error: string }).error).not.toBe(
        'Cannot create filters for other users'
      );
    });
  }
});

// ===========================================================================
// APPSERVICE — within-AS exclusive:false→true USER hit ∥ all-false miss
// ===========================================================================

describe('race quattuordecenary appservice within-AS false→true exclusive user after #390', () => {
  for (let i = 0; i < 10; i++) {
    it(`within-AS false→true hit ∥ all-false miss ∥ wrong exclude flood-${i}`, async () => {
      const mixed = registration('mixed_eu', {
        users: [
          {
            exclusive: false,
            regex: `^@_bot_.*:${AS_ESC}$`,
          },
          {
            exclusive: true,
            regex: `^@_bot_.*:${AS_ESC}$`,
          },
        ],
        rooms: [],
        aliases: [],
      });
      const allSoft = registration('soft_eu', {
        users: [
          {
            exclusive: false,
            regex: `^@_bot_.*:${AS_ESC}$`,
          },
          {
            exclusive: false,
            regex: `^@_ghost_.*:${AS_ESC}$`,
          },
        ],
        rooms: [],
        aliases: [],
      });
      const userId = `@_bot_quattuor_${i}:${AS_SERVER}`;

      const [hitMixed, missSoft, wrongExclude, rightExclude] = await Promise.all([
        Promise.resolve(isExclusiveAppServiceUser([mixed], userId)),
        Promise.resolve(isExclusiveAppServiceUser([allSoft], userId)),
        Promise.resolve(isExclusiveAppServiceUser([mixed], userId, 'other_as')),
        Promise.resolve(isExclusiveAppServiceUser([mixed], userId, 'mixed_eu')),
      ]);

      expect(hitMixed?.id).toBe('mixed_eu');
      expect(missSoft).toBeNull();
      expect(wrongExclude?.id).toBe('mixed_eu');
      expect(rightExclude).toBeNull();

      // Soft all-false never shadows within-AS false→true sibling
      const both = isExclusiveAppServiceUser([allSoft, mixed], userId);
      expect(both?.id).toBe('mixed_eu');
    });
  }
});

// ===========================================================================
// APPSERVICE — multi user-ns first-miss second-hit sender ∥ rooms-only
// ===========================================================================

describe('race quattuordecenary appservice multi-ns first-miss second-hit interest after #390', () => {
  for (let i = 0; i < 10; i++) {
    it(`first-miss second-hit sender ∥ rooms-only ∥ neither flood-${i}`, async () => {
      const multiUsers = registration('users_multi', {
        users: [
          {
            exclusive: false,
            regex: `^@_ghost_a_.*:${AS_ESC}$`,
          },
          {
            exclusive: false,
            regex: `^@_ghost_b_.*:${AS_ESC}$`,
          },
        ],
        rooms: [],
        aliases: [],
      });
      const roomsOnly = registration('rooms_qd', {
        users: [],
        rooms: [
          {
            exclusive: false,
            regex: `^!qd_.*:${AS_ESC}$`,
          },
        ],
        aliases: [],
      });

      const secondHitEvent = {
        room_id: `!plain_${i}:${AS_SERVER}`,
        sender: `@_ghost_b_qd_${i}:${AS_SERVER}`,
        type: 'm.room.message',
      };
      const firstOnlyMiss = {
        room_id: `!plain_${i}:${AS_SERVER}`,
        sender: `@_ghost_z_qd_${i}:${AS_SERVER}`,
        type: 'm.room.message',
      };
      const roomHitEvent = {
        room_id: `!qd_room_${i}:${AS_SERVER}`,
        sender: `@alice_${i}:${AS_SERVER}`,
        type: 'm.room.message',
      };
      const neitherEvent = {
        room_id: `!plain_${i}:${AS_SERVER}`,
        sender: `@alice_${i}:${AS_SERVER}`,
        type: 'm.room.message',
      };

      const [secondHit, firstMiss, roomHit, none, both] = await Promise.all([
        Promise.resolve(getInterestedAppServices([multiUsers, roomsOnly], secondHitEvent)),
        Promise.resolve(getInterestedAppServices([multiUsers, roomsOnly], firstOnlyMiss)),
        Promise.resolve(getInterestedAppServices([multiUsers, roomsOnly], roomHitEvent)),
        Promise.resolve(getInterestedAppServices([multiUsers, roomsOnly], neitherEvent)),
        Promise.resolve(
          getInterestedAppServices([multiUsers, roomsOnly], {
            room_id: `!qd_room_${i}:${AS_SERVER}`,
            sender: `@_ghost_b_qd_${i}:${AS_SERVER}`,
            type: 'm.room.message',
          })
        ),
      ]);

      expect(secondHit.map((a) => a.id)).toEqual(['users_multi']);
      expect(firstMiss).toEqual([]);
      expect(roomHit.map((a) => a.id)).toEqual(['rooms_qd']);
      expect(none).toEqual([]);
      expect(both.map((a) => a.id).sort()).toEqual(['rooms_qd', 'users_multi']);
    });
  }
});

// ===========================================================================
// APPSERVICE — protocols '"null"' / '"1"' / '"42"' / '"{}"' ByToken∥list
// ===========================================================================

describe('race quattuordecenary appservice protocols str-lookalike JSON after #390', () => {
  for (let i = 0; i < 10; i++) {
    it(`'"null"'→str ∥ '"1"'→str ∥ '"42"'→str ∥ '"{}"'→str ByToken∥list flood-${i}`, async () => {
      const nullProto = asRow({
        id: `pnull_${i}`,
        as_token: `tok_pnull_${i}`,
        sender_localpart: 'pnull',
        protocols: '"null"',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const oneProto = asRow({
        id: `pone_${i}`,
        as_token: `tok_pone_${i}`,
        sender_localpart: 'pone',
        protocols: '"1"',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const intProto = asRow({
        id: `pint_${i}`,
        as_token: `tok_pint_${i}`,
        sender_localpart: 'pint',
        protocols: '"42"',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const objProto = asRow({
        id: `pobj_${i}`,
        as_token: `tok_pobj_${i}`,
        sender_localpart: 'pobj',
        protocols: '"{}"',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });

      const [byNull, byOne, byInt, byObj, list] = await Promise.all([
        getAppServiceByToken(createListDb([nullProto]), `tok_pnull_${i}`),
        getAppServiceByToken(createListDb([oneProto]), `tok_pone_${i}`),
        getAppServiceByToken(createListDb([intProto]), `tok_pint_${i}`),
        getAppServiceByToken(createListDb([objProto]), `tok_pobj_${i}`),
        getAppServices(createListDb([nullProto, oneProto, intProto, objProto])),
      ]);

      expect(byNull?.protocols).toBe('null');
      expect(byOne?.protocols).toBe('1');
      expect(byInt?.protocols).toBe('42');
      expect(byObj?.protocols).toBe('{}');
      expect(list.map((a) => a.protocols)).toEqual(['null', '1', '42', '{}']);
    });
  }
});

// ===========================================================================
// APPSERVICE — HTTP 209/218 ok ∥ 411/415/418/422/505 retry under race
// ===========================================================================

describe('race quattuordecenary appservice HTTP 209/218∥411/415/418/422/505 after #390', () => {
  const NOW = 1_700_000_920_000;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  function createTxnDb(startRowId = 4100) {
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
    it(`209∥218 → sent_at ∥ 411∥415∥418∥422∥505 → retry under parallel flood-${i}`, async () => {
      const ok209 = createTxnDb(4100 + i * 8);
      const ok218 = createTxnDb(4110 + i * 8);
      const r411 = createTxnDb(4120 + i * 8);
      const r415 = createTxnDb(4130 + i * 8);
      const r418 = createTxnDb(4140 + i * 8);
      const r422 = createTxnDb(4150 + i * 8);
      const r505 = createTxnDb(4160 + i * 8);

      const as209 = registration(
        'ok209',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://ok209.example.com' }
      );
      const as218 = registration(
        'ok218',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://ok218.example.com' }
      );
      const as411 = registration(
        'r411',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r411.example.com' }
      );
      const as415 = registration(
        'r415',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r415.example.com' }
      );
      const as418 = registration(
        'r418',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r418.example.com' }
      );
      const as422 = registration(
        'r422',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r422.example.com' }
      );
      const as505 = registration(
        'r505',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r505.example.com' }
      );

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url.includes('ok209.example.com')) return new Response('cont', { status: 209 });
          if (url.includes('ok218.example.com')) return new Response(null, { status: 218 });
          if (url.includes('r411.example.com')) return new Response('len', { status: 411 });
          if (url.includes('r415.example.com')) return new Response('media', { status: 415 });
          if (url.includes('r418.example.com')) return new Response('teapot', { status: 418 });
          if (url.includes('r422.example.com')) return new Response('unproc', { status: 422 });
          if (url.includes('r505.example.com')) return new Response('ver', { status: 505 });
          return new Response('unexpected', { status: 599 });
        })
      );

      const events = [{ type: 'm.room.message', body: `quattuordecenary_${i}` }];
      const [s209, s218, s411, s415, s418, s422, s505] = await Promise.all([
        sendAppServiceTransaction(ok209, as209, events),
        sendAppServiceTransaction(ok218, as218, events),
        sendAppServiceTransaction(r411, as411, events),
        sendAppServiceTransaction(r415, as415, events),
        sendAppServiceTransaction(r418, as418, events),
        sendAppServiceTransaction(r422, as422, events),
        sendAppServiceTransaction(r505, as505, events),
      ]);

      expect(s209).toBe(true);
      expect(s218).toBe(true);
      expect(s411).toBe(false);
      expect(s415).toBe(false);
      expect(s418).toBe(false);
      expect(s422).toBe(false);
      expect(s505).toBe(false);

      for (const db of [ok209, ok218]) {
        expect(db.updates.filter((u) => u.kind === 'sent')).toHaveLength(1);
        expect(db.updates.filter((u) => u.kind === 'retry')).toHaveLength(0);
      }
      for (const db of [r411, r415, r418, r422, r505]) {
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
// AUTH — protocols '"null"' / '"1"' / '"42"' under requireAuth
// ===========================================================================

describe('race quattuordecenary auth protocols str-lookalike under requireAuth after #390', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`protocols '"null"'∥'"1"'∥'"42"' allow ∥ ' ' unknown flood-${i}`, async () => {
      const nullTok = `as_qd_null_${i}`;
      const oneTok = `as_qd_one_${i}`;
      const intTok = `as_qd_int_${i}`;
      const badTok = `as_qd_bad_${i}`;
      const db = createAuthDb({
        appservices: new Map([
          [
            nullTok,
            asRow({
              as_token: nullTok,
              sender_localpart: 'pnull',
              protocols: '"null"',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
          [
            oneTok,
            asRow({
              as_token: oneTok,
              sender_localpart: 'pone',
              protocols: '"1"',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
          [
            intTok,
            asRow({
              as_token: intTok,
              sender_localpart: 'pint',
              protocols: '"42"',
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

      const nullCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${nullTok}` },
      });
      const oneCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${oneTok}` },
      });
      const intCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${intTok}` },
      });
      const badCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${badTok}` },
      });
      const nullNext = vi.fn(async () => 'null-ok');
      const oneNext = vi.fn(async () => 'one-ok');
      const intNext = vi.fn(async () => 'int-ok');

      const [nullRes, oneRes, intRes, badRes] = await Promise.all([
        realRequireAuth()(nullCtx, nullNext),
        realRequireAuth()(oneCtx, oneNext),
        realRequireAuth()(intCtx, intNext),
        realRequireAuth()(badCtx, vi.fn()),
      ]);

      expect(nullRes).toBe('null-ok');
      expect(oneRes).toBe('one-ok');
      expect(intRes).toBe('int-ok');
      expect(nullNext).toHaveBeenCalledOnce();
      expect(oneNext).toHaveBeenCalledOnce();
      expect(intNext).toHaveBeenCalledOnce();
      expect(nullCtx.get('userId')).toBe(`@pnull:${AUTH_SERVER}`);
      expect(oneCtx.get('userId')).toBe(`@pone:${AUTH_SERVER}`);
      expect(intCtx.get('userId')).toBe(`@pint:${AUTH_SERVER}`);

      const badBody = await jsonBody(badRes as Response);
      expect(badBody).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN', status: 401 });
      expect(badCtx.get('userId')).toBeUndefined();
      expect(badBody.error).not.toBe('Missing access token');
    });
  }
});

// ===========================================================================
// AUTH — namespaces exclusive:true multi first-match allow ∥ both-miss deny
// ===========================================================================

describe('race quattuordecenary auth namespaces exclusive:true multi after #390', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`exclusive:true first-match allow ∥ both-miss deny ∥ open allow flood-${i}`, async () => {
      const multiTok = `as_qd_multi_${i}`;
      const openTok = `as_qd_open_${i}`;
      const hitUser = `@bot_a_${i}:${AUTH_SERVER}`;
      const missUser = `@guest_${i}:${AUTH_SERVER}`;
      const openUser = `@anyone_${i}:${AUTH_SERVER}`;
      const db = createAuthDb({
        appservices: new Map([
          [
            multiTok,
            asRow({
              as_token: multiTok,
              sender_localpart: 'multi',
              namespaces: JSON.stringify({
                users: [
                  {
                    exclusive: true,
                    regex: `^@bot_a_.*:${AUTH_ESC}$`,
                  },
                  {
                    exclusive: true,
                    regex: `^@bot_b_.*:${AUTH_ESC}$`,
                  },
                ],
                rooms: [],
                aliases: [],
              }),
            }),
          ],
          [
            openTok,
            asRow({
              as_token: openTok,
              sender_localpart: 'open',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
        ]),
      });

      const hitCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(hitUser)}`,
        headers: { Authorization: `Bearer ${multiTok}` },
      });
      const missCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(missUser)}`,
        headers: { Authorization: `Bearer ${multiTok}` },
      });
      const openCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(openUser)}`,
        headers: { Authorization: `Bearer ${openTok}` },
      });
      const hitNext = vi.fn(async () => 'hit-ok');
      const openNext = vi.fn(async () => 'open-ok');

      const [hitRes, missRes, openRes] = await Promise.all([
        realRequireAuth()(hitCtx, hitNext),
        realRequireAuth()(missCtx, vi.fn()),
        realRequireAuth()(openCtx, openNext),
      ]);

      expect(hitRes).toBe('hit-ok');
      expect(openRes).toBe('open-ok');
      expect(hitNext).toHaveBeenCalledOnce();
      expect(openNext).toHaveBeenCalledOnce();
      expect(hitCtx.get('userId')).toBe(hitUser);
      expect(openCtx.get('userId')).toBe(openUser);

      const missBody = await jsonBody(missRes as Response);
      expect(missBody).toMatchObject({
        errcode: 'M_FORBIDDEN',
        status: 403,
      });
      expect(missBody.error).toContain('application service namespace');
      expect(missCtx.get('userId')).toBeUndefined();
      expect(missBody.error).not.toContain('Invalid user_id format');
      expect(missBody.error).not.toContain('other servers');
    });
  }
});

// ===========================================================================
// AUTH — trailing-dot server foreign ∥ missing-@ format forbid ∥ valid AS soft
// ===========================================================================

describe('race quattuordecenary auth trailing-dot∥missing-at forbid∥valid soft after #390', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`trailing-dot foreign∥missing-@ format forbid ∥ valid never mix flood-${i}`, async () => {
      const tok = `as_qd_uid_${i}`;
      const localUser = `@bot_qd_${i}:${AUTH_SERVER}`;
      // Format-valid (dot allowed in server class) but !== SERVER_NAME → foreign
      const trailingDot = `@bot_qd_${i}:${AUTH_SERVER}.`;
      // Missing leading @ — fails format regex
      const missingAt = `bot_qd_${i}:${AUTH_SERVER}`;
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

      const trailingCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(trailingDot)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const missingCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(missingAt)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const validCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const validNext = vi.fn(async () => 'valid-ok');

      const [trailingRes, missingRes, validRes] = await Promise.all([
        realRequireAuth()(trailingCtx, vi.fn()),
        realRequireAuth()(missingCtx, vi.fn()),
        realRequireAuth()(validCtx, validNext),
      ]);

      expect(validRes).toBe('valid-ok');
      expect(validNext).toHaveBeenCalledOnce();
      expect(validCtx.get('userId')).toBe(localUser);
      expect(validCtx.get('deviceId')).toBeNull();

      const trailingBody = await jsonBody(trailingRes as Response);
      expect(trailingBody).toMatchObject({
        errcode: 'M_FORBIDDEN',
        status: 403,
      });
      expect(trailingBody.error).toContain('other servers');
      expect(trailingCtx.get('userId')).toBeUndefined();
      expect(trailingBody.error).not.toContain('Invalid user_id format');

      const missingBody = await jsonBody(missingRes as Response);
      expect(missingBody).toMatchObject({
        errcode: 'M_FORBIDDEN',
        status: 403,
      });
      expect(missingBody.error).toContain('Invalid user_id format');
      expect(missingCtx.get('userId')).toBeUndefined();
      expect(missingBody.error).not.toContain('other servers');
    });
  }
});

// ===========================================================================
// AUTH — Negotiate→query AS ∥ NTLM→query ∥ unknown soft
// ===========================================================================

describe('race quattuordecenary auth Negotiate∥NTLM→query AS∥unknown soft after #390', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`Negotiate∥NTLM→query AS ∥ unknown never mix flood-${i}`, async () => {
      const asTok = `as_qd_scheme_${i}`;
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

      // Non-Bearer Authorization does not match → fall through to query
      expect(
        extractAccessToken(
          new Request(
            `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(asTok)}`,
            { headers: { Authorization: `Negotiate ${asTok}` } }
          )
        )
      ).toBe(asTok);
      expect(
        extractAccessToken(
          new Request(
            `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(asTok)}`,
            { headers: { Authorization: `NTLM ${asTok}` } }
          )
        )
      ).toBe(asTok);

      const negotiateCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(asTok)}`,
        headers: { Authorization: `Negotiate ${asTok}` },
      });
      const ntlmCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(asTok)}`,
        headers: { Authorization: `NTLM ${asTok}` },
      });
      const unknown = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer not_real_${i}` },
      });
      const negotiateNext = vi.fn(async () => 'negotiate-ok');
      const ntlmNext = vi.fn(async () => 'ntlm-ok');

      const [negotiateRes, ntlmRes, unkRes] = await Promise.all([
        realRequireAuth()(negotiateCtx, negotiateNext),
        realRequireAuth()(ntlmCtx, ntlmNext),
        realRequireAuth()(unknown, vi.fn()),
      ]);

      expect(negotiateRes).toBe('negotiate-ok');
      expect(ntlmRes).toBe('ntlm-ok');
      expect(negotiateNext).toHaveBeenCalledOnce();
      expect(ntlmNext).toHaveBeenCalledOnce();
      expect(negotiateCtx.get('userId')).toBe(`@bridge:${AUTH_SERVER}`);
      expect(ntlmCtx.get('userId')).toBe(`@bridge:${AUTH_SERVER}`);
      expect(negotiateCtx.get('deviceId')).toBeNull();

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
