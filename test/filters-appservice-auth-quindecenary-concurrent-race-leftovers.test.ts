/**
 * TOKENMAXX HEAVY tip-relaunch after #402 (tip 1a3087f) — quindecenary
 * *filters + appservice + auth* concurrent-race niches not covered by quattuordecenary
 * (#402), tridecenary (#390), duodenary (#378), undecenary (#350), denary (#338),
 * nonary (#319), octonary (#312), septenary (#304), senary (#292), or quinary (#286) floods.
 *
 * Gap table (why leftover after #402 quattuordecenary / tip 1a3087f):
 *   Filters "Infinity" / "-Infinity" / "undefined" / "1E2" string-primitive mint + TTL ∥ carol forbid
 *     | quattuordecenary "-1"/"42"/"1e2"/"NaN"; never Infinity/-Inf/undefined/upper-sci str
 *   Filters stored "Infinity" / "-0" / "1E2" / "undefined" / [false] / {"":0} GET soft ∥ carol read-forbid
 *     | quattuordecenary "-1"/"42"/"1"/"[]"/"{}";/[0]; never Inf/-0/upper-sci/undef/[false]/{"":0}
 *   isExclusiveAppServiceAlias within-AS false→true hit ∥ all-false miss ∥ wrong exclude
 *     | quattuordecenary within-AS USER; tridecenary exclusive:false ALIAS; never within-AS ALIAS multi-ns
 *   multi room-ns first-miss second-hit room interest ∥ users-only twin
 *     | quattuordecenary multi user-ns sender; never multi room-ns first-miss second-hit
 *   protocols '"-1"' / '"Infinity"' / '"undefined"' / '"1e2"' ByToken∥list quirks
 *     | quattuordecenary "null"/"1"/"42"/"{}"; never neg/Inf/undef/lower-sci JSON-string lookalikes
 *   HTTP 210/214 ok ∥ 413/414/416/417/431 retry under race
 *     | quattuordecenary 209/218∥411+; never 210/214∥413+
 *   Auth protocols '"-1"'/'"Infinity"'/'"undefined"' under requireAuth
 *     | quattuordecenary "null"/"1"/"42"; never neg/Inf/undef string-lookalikes under AS auth
 *   Auth namespaces exclusive:true second-ns hit allow ∥ both-miss deny ∥ open
 *     | quattuordecenary exclusive:true first-ns; never second-ns hit twin under exclusive:true
 *   Auth port-suffix format forbid ∥ uppercase-server foreign ∥ valid soft under race
 *     | quattuordecenary trailing-dot∥missing-@; never port-suffix∥uppercase-server
 *   Auth HOBA→query AS ∥ SCRAM-SHA-256→query ∥ unknown soft
 *     | quattuordecenary Negotiate/NTLM; never HOBA/SCRAM fallthrough under this series
 *
 * Distinct from #402 quattuordecenary, #390 tridecenary, #378 duodenary, #350 undecenary.
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
  isExclusiveAppServiceAlias,
  sendAppServiceTransaction,
} from '../src/services/appservice';
import { extractAccessToken } from '../src/middleware/auth';

// Real requireAuth loaded via importActual in auth suites below
// (filter routes use the mocked requireAuth from vi.mock).

// ---------------------------------------------------------------------------
// Filters harness (mocked requireAuth — mirrors quattuordecenary/tridecenary series)
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
// FILTERS — "Infinity" / "-Infinity" / "undefined" / "1E2" JSON-string mint + TTL ∥ carol forbid
// ===========================================================================

describe('race quindecenary filter JSON-string Inf/-Inf/undef/upper-sci mint + TTL soft after #402', () => {
  for (let i = 0; i < 12; i++) {
    it(`"Infinity"∥"-Infinity"∥"undefined"∥"1E2" mint + TTL ∥ carol forbid flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const putsBefore = cache.putCount;

      const [infStr, ninfStr, undefStr, usciStr, forbid] = await Promise.all([
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"Infinity"',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"-Infinity"',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"undefined"',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"1E2"',
        }),
        request(env, filterCollection(CAROL_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: JSON.stringify({ room: { timeline: { limit: i } } }),
        }),
      ]);

      expect(infStr.status).toBe(200);
      expect(ninfStr.status).toBe(200);
      expect(undefStr.status).toBe(200);
      expect(usciStr.status).toBe(200);
      expect(forbid.status).toBe(403);
      expect(forbid.body).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot create filters for other users',
      });

      const ids = [
        (infStr.body as { filter_id: string }).filter_id,
        (ninfStr.body as { filter_id: string }).filter_id,
        (undefStr.body as { filter_id: string }).filter_id,
        (usciStr.body as { filter_id: string }).filter_id,
      ];
      expect(new Set(ids).size).toBe(4);
      expect(cache.putCount).toBe(putsBefore + 4);

      const byId = Object.fromEntries(
        cache.puts.slice(-4).map((p) => {
          const fid = p.key.split(':').pop()!;
          return [fid, p];
        })
      );
      // Stored as JSON strings — not Infinity/undefined primitives
      expect(JSON.parse(byId[ids[0]].value)).toBe('Infinity');
      expect(JSON.parse(byId[ids[1]].value)).toBe('-Infinity');
      expect(JSON.parse(byId[ids[2]].value)).toBe('undefined');
      expect(JSON.parse(byId[ids[3]].value)).toBe('1E2');
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
// FILTERS — stored "Infinity" / "-0" / "1E2" / "undefined" / [false] / {"":0} GET soft ∥ carol
// ===========================================================================

describe('race quindecenary filter Inf/-0/upper-sci/undef/[false]/{"":0} GET soft after #402', () => {
  for (let i = 0; i < 10; i++) {
    it(`stored "Infinity"∥"-0"∥"1E2"∥"undefined"∥[false]∥{"":0} ∥ carol forbid never mix flood-${i}`, async () => {
      const infId = `qn_inf_${i}`;
      const neg0Id = `qn_neg0_${i}`;
      const usciId = `qn_usci_${i}`;
      const undefId = `qn_undef_${i}`;
      const falsyArrId = `qn_farr_${i}`;
      const emptyKeyId = `qn_ekey_${i}`;
      const cache = mockCache({
        [`filter:${USER}:${infId}`]: '"Infinity"',
        [`filter:${USER}:${neg0Id}`]: '"-0"',
        [`filter:${USER}:${usciId}`]: '"1E2"',
        [`filter:${USER}:${undefId}`]: '"undefined"',
        [`filter:${USER}:${falsyArrId}`]: '[false]',
        [`filter:${USER}:${emptyKeyId}`]: '{"":0}',
      });
      const env = createEnv(cache);
      const getsBefore = cache.getCount;

      const [infGet, neg0Get, usciGet, undefGet, falsyArrGet, emptyKeyGet, forbid] = await Promise.all([
        request(env, filterPath(infId), { headers: AUTH }),
        request(env, filterPath(neg0Id), { headers: AUTH }),
        request(env, filterPath(usciId), { headers: AUTH }),
        request(env, filterPath(undefId), { headers: AUTH }),
        request(env, filterPath(falsyArrId), { headers: AUTH }),
        request(env, filterPath(emptyKeyId), { headers: AUTH }),
        request(env, filterPath(infId, CAROL_ENC), { headers: AUTH }),
      ]);

      expect(infGet.status).toBe(200);
      expect(infGet.body).toBe('Infinity');
      expect(neg0Get.status).toBe(200);
      expect(neg0Get.body).toBe('-0');
      expect(usciGet.status).toBe(200);
      expect(usciGet.body).toBe('1E2');
      expect(undefGet.status).toBe(200);
      expect(undefGet.body).toBe('undefined');
      expect(falsyArrGet.status).toBe(200);
      expect(falsyArrGet.body).toEqual([false]);
      expect(emptyKeyGet.status).toBe(200);
      expect(emptyKeyGet.body).toEqual({ '': 0 });
      expect(forbid.status).toBe(403);
      expect(forbid.body).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot read filters for other users',
      });

      // Soft success bodies never gain errcode; forbid never touches CACHE
      expect(infGet.body).toBe('Infinity');
      expect(neg0Get.body).toBe('-0');
      expect(usciGet.body).toBe('1E2');
      expect(undefGet.body).toBe('undefined');
      expect(falsyArrGet.body).toEqual([false]);
      expect(emptyKeyGet.body).toEqual({ '': 0 });
      expect(cache.getCount).toBe(getsBefore + 6);
      expect((forbid.body as { error: string }).error).not.toBe(
        'Cannot create filters for other users'
      );
    });
  }
});

// ===========================================================================
// APPSERVICE — within-AS exclusive:false→true ALIAS hit ∥ all-false miss
// ===========================================================================

describe('race quindecenary appservice within-AS false→true exclusive alias after #402', () => {
  for (let i = 0; i < 10; i++) {
    it(`within-AS false→true hit ∥ all-false miss ∥ wrong exclude flood-${i}`, async () => {
      const mixed = registration('mixed_ea', {
        users: [],
        rooms: [],
        aliases: [
          {
            exclusive: false,
            regex: `^#_bridge_.*:${AS_ESC}$`,
          },
          {
            exclusive: true,
            regex: `^#_bridge_.*:${AS_ESC}$`,
          },
        ],
      });
      const allSoft = registration('soft_ea', {
        users: [],
        rooms: [],
        aliases: [
          {
            exclusive: false,
            regex: `^#_bridge_.*:${AS_ESC}$`,
          },
          {
            exclusive: false,
            regex: `^#_ghost_.*:${AS_ESC}$`,
          },
        ],
      });
      const alias = `#_bridge_quin_${i}:${AS_SERVER}`;

      const [hitMixed, missSoft, wrongExclude, rightExclude] = await Promise.all([
        Promise.resolve(isExclusiveAppServiceAlias([mixed], alias)),
        Promise.resolve(isExclusiveAppServiceAlias([allSoft], alias)),
        Promise.resolve(isExclusiveAppServiceAlias([mixed], alias, 'other_as')),
        Promise.resolve(isExclusiveAppServiceAlias([mixed], alias, 'mixed_ea')),
      ]);

      expect(hitMixed?.id).toBe('mixed_ea');
      expect(missSoft).toBeNull();
      expect(wrongExclude?.id).toBe('mixed_ea');
      expect(rightExclude).toBeNull();

      // Soft all-false never shadows within-AS false→true sibling
      const both = isExclusiveAppServiceAlias([allSoft, mixed], alias);
      expect(both?.id).toBe('mixed_ea');
    });
  }
});

// ===========================================================================
// APPSERVICE — multi room-ns first-miss second-hit room ∥ users-only
// ===========================================================================

describe('race quindecenary appservice multi-room-ns first-miss second-hit interest after #402', () => {
  for (let i = 0; i < 10; i++) {
    it(`first-miss second-hit room ∥ users-only ∥ neither flood-${i}`, async () => {
      const multiRooms = registration('rooms_multi', {
        users: [],
        rooms: [
          {
            exclusive: false,
            regex: `^!qn_a_.*:${AS_ESC}$`,
          },
          {
            exclusive: false,
            regex: `^!qn_b_.*:${AS_ESC}$`,
          },
        ],
        aliases: [],
      });
      const usersOnly = registration('users_qn', {
        users: [
          {
            exclusive: false,
            regex: `^@_qn_.*:${AS_ESC}$`,
          },
        ],
        rooms: [],
        aliases: [],
      });

      const secondHitEvent = {
        room_id: `!qn_b_room_${i}:${AS_SERVER}`,
        sender: `@alice_${i}:${AS_SERVER}`,
        type: 'm.room.message',
      };
      const firstOnlyMiss = {
        room_id: `!qn_z_room_${i}:${AS_SERVER}`,
        sender: `@alice_${i}:${AS_SERVER}`,
        type: 'm.room.message',
      };
      const userHitEvent = {
        room_id: `!plain_${i}:${AS_SERVER}`,
        sender: `@_qn_bot_${i}:${AS_SERVER}`,
        type: 'm.room.message',
      };
      const neitherEvent = {
        room_id: `!plain_${i}:${AS_SERVER}`,
        sender: `@alice_${i}:${AS_SERVER}`,
        type: 'm.room.message',
      };

      const [secondHit, firstMiss, userHit, none, both] = await Promise.all([
        Promise.resolve(getInterestedAppServices([multiRooms, usersOnly], secondHitEvent)),
        Promise.resolve(getInterestedAppServices([multiRooms, usersOnly], firstOnlyMiss)),
        Promise.resolve(getInterestedAppServices([multiRooms, usersOnly], userHitEvent)),
        Promise.resolve(getInterestedAppServices([multiRooms, usersOnly], neitherEvent)),
        Promise.resolve(
          getInterestedAppServices([multiRooms, usersOnly], {
            room_id: `!qn_b_room_${i}:${AS_SERVER}`,
            sender: `@_qn_bot_${i}:${AS_SERVER}`,
            type: 'm.room.message',
          })
        ),
      ]);

      expect(secondHit.map((a) => a.id)).toEqual(['rooms_multi']);
      expect(firstMiss).toEqual([]);
      expect(userHit.map((a) => a.id)).toEqual(['users_qn']);
      expect(none).toEqual([]);
      expect(both.map((a) => a.id).sort()).toEqual(['rooms_multi', 'users_qn']);
    });
  }
});

// ===========================================================================
// APPSERVICE — protocols '"-1"' / '"Infinity"' / '"undefined"' / '"1e2"' ByToken∥list
// ===========================================================================

describe('race quindecenary appservice protocols str-lookalike JSON after #402', () => {
  for (let i = 0; i < 10; i++) {
    it(`'"-1"'→str ∥ '"Infinity"'→str ∥ '"undefined"'→str ∥ '"1e2"'→str ByToken∥list flood-${i}`, async () => {
      const negProto = asRow({
        id: `pneg_${i}`,
        as_token: `tok_pneg_${i}`,
        sender_localpart: 'pneg',
        protocols: '"-1"',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const infProto = asRow({
        id: `pinf_${i}`,
        as_token: `tok_pinf_${i}`,
        sender_localpart: 'pinf',
        protocols: '"Infinity"',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const undefProto = asRow({
        id: `pundef_${i}`,
        as_token: `tok_pundef_${i}`,
        sender_localpart: 'pundef',
        protocols: '"undefined"',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const sciProto = asRow({
        id: `psci_${i}`,
        as_token: `tok_psci_${i}`,
        sender_localpart: 'psci',
        protocols: '"1e2"',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });

      const [byNeg, byInf, byUndef, bySci, list] = await Promise.all([
        getAppServiceByToken(createListDb([negProto]), `tok_pneg_${i}`),
        getAppServiceByToken(createListDb([infProto]), `tok_pinf_${i}`),
        getAppServiceByToken(createListDb([undefProto]), `tok_pundef_${i}`),
        getAppServiceByToken(createListDb([sciProto]), `tok_psci_${i}`),
        getAppServices(createListDb([negProto, infProto, undefProto, sciProto])),
      ]);

      expect(byNeg?.protocols).toBe('-1');
      expect(byInf?.protocols).toBe('Infinity');
      expect(byUndef?.protocols).toBe('undefined');
      expect(bySci?.protocols).toBe('1e2');
      expect(list.map((a) => a.protocols)).toEqual(['-1', 'Infinity', 'undefined', '1e2']);
    });
  }
});

// ===========================================================================
// APPSERVICE — HTTP 210/214 ok ∥ 413/414/416/417/431 retry under race
// ===========================================================================

describe('race quindecenary appservice HTTP 210/214∥413/414/416/417/431 after #402', () => {
  const NOW = 1_700_000_930_000;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  function createTxnDb(startRowId = 5100) {
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
    it(`210∥214 → sent_at ∥ 413∥414∥416∥417∥431 → retry under parallel flood-${i}`, async () => {
      const ok210 = createTxnDb(5100 + i * 8);
      const ok214 = createTxnDb(5110 + i * 8);
      const r413 = createTxnDb(5120 + i * 8);
      const r414 = createTxnDb(5130 + i * 8);
      const r416 = createTxnDb(5140 + i * 8);
      const r417 = createTxnDb(5150 + i * 8);
      const r431 = createTxnDb(5160 + i * 8);

      const as210 = registration(
        'ok210',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://ok210.example.com' }
      );
      const as214 = registration(
        'ok214',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://ok214.example.com' }
      );
      const as413 = registration(
        'r413',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r413.example.com' }
      );
      const as414 = registration(
        'r414',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r414.example.com' }
      );
      const as416 = registration(
        'r416',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r416.example.com' }
      );
      const as417 = registration(
        'r417',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r417.example.com' }
      );
      const as431 = registration(
        'r431',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r431.example.com' }
      );

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url.includes('ok210.example.com')) return new Response('cont', { status: 210 });
          if (url.includes('ok214.example.com')) return new Response(null, { status: 214 });
          if (url.includes('r413.example.com')) return new Response('large', { status: 413 });
          if (url.includes('r414.example.com')) return new Response('uri', { status: 414 });
          if (url.includes('r416.example.com')) return new Response('range', { status: 416 });
          if (url.includes('r417.example.com')) return new Response('expect', { status: 417 });
          if (url.includes('r431.example.com')) return new Response('headers', { status: 431 });
          return new Response('unexpected', { status: 599 });
        })
      );

      const events = [{ type: 'm.room.message', body: `quindecenary_${i}` }];
      const [s210, s214, s413, s414, s416, s417, s431] = await Promise.all([
        sendAppServiceTransaction(ok210, as210, events),
        sendAppServiceTransaction(ok214, as214, events),
        sendAppServiceTransaction(r413, as413, events),
        sendAppServiceTransaction(r414, as414, events),
        sendAppServiceTransaction(r416, as416, events),
        sendAppServiceTransaction(r417, as417, events),
        sendAppServiceTransaction(r431, as431, events),
      ]);

      expect(s210).toBe(true);
      expect(s214).toBe(true);
      expect(s413).toBe(false);
      expect(s414).toBe(false);
      expect(s416).toBe(false);
      expect(s417).toBe(false);
      expect(s431).toBe(false);

      for (const db of [ok210, ok214]) {
        expect(db.updates.filter((u) => u.kind === 'sent')).toHaveLength(1);
        expect(db.updates.filter((u) => u.kind === 'retry')).toHaveLength(0);
      }
      for (const db of [r413, r414, r416, r417, r431]) {
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
// AUTH — protocols '"-1"' / '"Infinity"' / '"undefined"' under requireAuth
// ===========================================================================

describe('race quindecenary auth protocols str-lookalike under requireAuth after #402', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`protocols '"-1"'∥'"Infinity"'∥'"undefined"' allow ∥ ' ' unknown flood-${i}`, async () => {
      const negTok = `as_qn_neg_${i}`;
      const infTok = `as_qn_inf_${i}`;
      const undefTok = `as_qn_undef_${i}`;
      const badTok = `as_qn_bad_${i}`;
      const db = createAuthDb({
        appservices: new Map([
          [
            negTok,
            asRow({
              as_token: negTok,
              sender_localpart: 'pneg',
              protocols: '"-1"',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
          [
            infTok,
            asRow({
              as_token: infTok,
              sender_localpart: 'pinf',
              protocols: '"Infinity"',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
          [
            undefTok,
            asRow({
              as_token: undefTok,
              sender_localpart: 'pundef',
              protocols: '"undefined"',
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

      const negCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${negTok}` },
      });
      const infCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${infTok}` },
      });
      const undefCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${undefTok}` },
      });
      const badCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${badTok}` },
      });
      const negNext = vi.fn(async () => 'neg-ok');
      const infNext = vi.fn(async () => 'inf-ok');
      const undefNext = vi.fn(async () => 'undef-ok');

      const [negRes, infRes, undefRes, badRes] = await Promise.all([
        realRequireAuth()(negCtx, negNext),
        realRequireAuth()(infCtx, infNext),
        realRequireAuth()(undefCtx, undefNext),
        realRequireAuth()(badCtx, vi.fn()),
      ]);

      expect(negRes).toBe('neg-ok');
      expect(infRes).toBe('inf-ok');
      expect(undefRes).toBe('undef-ok');
      expect(negNext).toHaveBeenCalledOnce();
      expect(infNext).toHaveBeenCalledOnce();
      expect(undefNext).toHaveBeenCalledOnce();
      expect(negCtx.get('userId')).toBe(`@pneg:${AUTH_SERVER}`);
      expect(infCtx.get('userId')).toBe(`@pinf:${AUTH_SERVER}`);
      expect(undefCtx.get('userId')).toBe(`@pundef:${AUTH_SERVER}`);

      const badBody = await jsonBody(badRes as Response);
      expect(badBody).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN', status: 401 });
      expect(badCtx.get('userId')).toBeUndefined();
      expect(badBody.error).not.toBe('Missing access token');
    });
  }
});

// ===========================================================================
// AUTH — namespaces exclusive:true second-ns hit allow ∥ both-miss deny
// ===========================================================================

describe('race quindecenary auth namespaces exclusive:true second-ns after #402', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`exclusive:true second-ns hit allow ∥ both-miss deny ∥ open allow flood-${i}`, async () => {
      const multiTok = `as_qn_multi_${i}`;
      const openTok = `as_qn_open_${i}`;
      // First ns is bot_a_*; hit uses bot_b_* (second exclusive:true entry)
      const hitUser = `@bot_b_${i}:${AUTH_SERVER}`;
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
// AUTH — port-suffix format forbid ∥ uppercase-server foreign ∥ valid AS soft
// ===========================================================================

describe('race quindecenary auth port-suffix∥uppercase-server forbid∥valid soft after #402', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`port-suffix format∥uppercase-server foreign forbid ∥ valid never mix flood-${i}`, async () => {
      const tok = `as_qn_uid_${i}`;
      const localUser = `@bot_qn_${i}:${AUTH_SERVER}`;
      // Extra :port fails format regex ([a-zA-Z0-9.-]+ cannot contain ':')
      const portSuffix = `@bot_qn_${i}:${AUTH_SERVER}:8448`;
      // Format-valid but server !== SERVER_NAME (case-sensitive) → foreign
      const upperServer = `@bot_qn_${i}:Matrix.Example.Com`;
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

      const portCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(portSuffix)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const upperCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(upperServer)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const validCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const validNext = vi.fn(async () => 'valid-ok');

      const [portRes, upperRes, validRes] = await Promise.all([
        realRequireAuth()(portCtx, vi.fn()),
        realRequireAuth()(upperCtx, vi.fn()),
        realRequireAuth()(validCtx, validNext),
      ]);

      expect(validRes).toBe('valid-ok');
      expect(validNext).toHaveBeenCalledOnce();
      expect(validCtx.get('userId')).toBe(localUser);
      expect(validCtx.get('deviceId')).toBeNull();

      const portBody = await jsonBody(portRes as Response);
      expect(portBody).toMatchObject({
        errcode: 'M_FORBIDDEN',
        status: 403,
      });
      expect(portBody.error).toContain('Invalid user_id format');
      expect(portCtx.get('userId')).toBeUndefined();
      expect(portBody.error).not.toContain('other servers');

      const upperBody = await jsonBody(upperRes as Response);
      expect(upperBody).toMatchObject({
        errcode: 'M_FORBIDDEN',
        status: 403,
      });
      expect(upperBody.error).toContain('other servers');
      expect(upperCtx.get('userId')).toBeUndefined();
      expect(upperBody.error).not.toContain('Invalid user_id format');
    });
  }
});

// ===========================================================================
// AUTH — HOBA→query AS ∥ SCRAM-SHA-256→query ∥ unknown soft
// ===========================================================================

describe('race quindecenary auth HOBA∥SCRAM→query AS∥unknown soft after #402', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`HOBA∥SCRAM-SHA-256→query AS ∥ unknown never mix flood-${i}`, async () => {
      const asTok = `as_qn_scheme_${i}`;
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
            { headers: { Authorization: `HOBA ${asTok}` } }
          )
        )
      ).toBe(asTok);
      expect(
        extractAccessToken(
          new Request(
            `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(asTok)}`,
            { headers: { Authorization: `SCRAM-SHA-256 ${asTok}` } }
          )
        )
      ).toBe(asTok);

      const hobaCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(asTok)}`,
        headers: { Authorization: `HOBA ${asTok}` },
      });
      const scramCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(asTok)}`,
        headers: { Authorization: `SCRAM-SHA-256 ${asTok}` },
      });
      const unknown = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer not_real_${i}` },
      });
      const hobaNext = vi.fn(async () => 'hoba-ok');
      const scramNext = vi.fn(async () => 'scram-ok');

      const [hobaRes, scramRes, unkRes] = await Promise.all([
        realRequireAuth()(hobaCtx, hobaNext),
        realRequireAuth()(scramCtx, scramNext),
        realRequireAuth()(unknown, vi.fn()),
      ]);

      expect(hobaRes).toBe('hoba-ok');
      expect(scramRes).toBe('scram-ok');
      expect(hobaNext).toHaveBeenCalledOnce();
      expect(scramNext).toHaveBeenCalledOnce();
      expect(hobaCtx.get('userId')).toBe(`@bridge:${AUTH_SERVER}`);
      expect(scramCtx.get('userId')).toBe(`@bridge:${AUTH_SERVER}`);
      expect(hobaCtx.get('deviceId')).toBeNull();

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
