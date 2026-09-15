/**
 * TOKENMAXX HEAVY tip-relaunch after #378 (tip 9c5ca6b) — tridecenary
 * *filters + appservice + auth* concurrent-race niches not covered by duodenary
 * (#378), undecenary (#350), denary (#338), nonary (#319), octonary (#312),
 * septenary (#304), senary (#292), or quinary (#286) floods.
 *
 * Gap table (why leftover after #378 duodenary / tip 9c5ca6b):
 *   Filters "true" / "3.14" / "[]" / "{}" string-primitive mint + TTL ∥ carol forbid
 *     | duodenary "0"/"false"/"null"/"1"; never "true"/float-str/empty-arr/empty-obj str
 *   Filters stored "0" / "false" / "null" / "true" / {} / [1] GET soft ∥ carol read-forbid
 *     | duodenary true/1/3.14/"x"/{a:null}/[null]; never string-lookalikes/empty-obj/[1]
 *   isExclusiveAppServiceAlias exclusive:false miss ∥ wrong excludeAsId still hit
 *     | duodenary exclusive:false USER twin; denary exclusive ALIAS miss∥hit; never false∥wrong-id
 *   sender membership interest hit ∥ state_key-miss rooms-only twin
 *     | duodenary state_key hit ∥ sender-miss rooms; never sender-hit ∥ state_key-miss rooms
 *   protocols '"true"' / '"0"' / '"[]"' / '"false"' ByToken∥list quirks
 *     | duodenary [null]/{a:null}/"irc"; never JSON-string bool/0/empty-arr lookalikes
 *   HTTP 208/226 ok ∥ 406/408/409/410/501 retry under race
 *     | duodenary 205–207∥402/405/429/502/504; never 208/226∥406+
 *   Auth protocols '"true"'/'"0"'/'"[]"' under requireAuth
 *     | duodenary [null]/{a:null}/"irc"; never string-lookalikes under AS auth
 *   Auth namespaces multi-ns first-match allow ∥ both-miss deny ∥ open allow
 *     | duodenary empty-regex/bad-regex; never multi-entry first-hit∥both-miss twin
 *   Auth empty-localpart @: ∥ double-at @@x forbid ∥ valid soft under race
 *     | duodenary whitespace∥foreign; octonary uppercase; never empty-lp∥double-@
 *   Auth Digest→query AS ∥ Token-scheme→query ∥ unknown soft
 *     | duodenary Basic→query; never Digest/Token scheme fallthrough under race
 *
 * Distinct from #378 duodenary, #350 undecenary, #338 denary, #319 nonary.
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
// Filters harness (mocked requireAuth — mirrors duodenary/undecenary series)
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
// FILTERS — "true" / "3.14" / "[]" / "{}" JSON-string mint + TTL ∥ carol forbid
// ===========================================================================

describe('race tridecenary filter JSON-string true/float/arr/obj mint + TTL soft after #378', () => {
  for (let i = 0; i < 12; i++) {
    it(`"true"∥"3.14"∥"[]"∥"{}" mint + TTL ∥ carol forbid flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const putsBefore = cache.putCount;

      const [trueStr, floatStr, arrStr, objStr, forbid] = await Promise.all([
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"true"',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"3.14"',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"[]"',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '"{}"',
        }),
        request(env, filterCollection(CAROL_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: JSON.stringify({ room: { timeline: { limit: i } } }),
        }),
      ]);

      expect(trueStr.status).toBe(200);
      expect(floatStr.status).toBe(200);
      expect(arrStr.status).toBe(200);
      expect(objStr.status).toBe(200);
      expect(forbid.status).toBe(403);
      expect(forbid.body).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot create filters for other users',
      });

      const ids = [
        (trueStr.body as { filter_id: string }).filter_id,
        (floatStr.body as { filter_id: string }).filter_id,
        (arrStr.body as { filter_id: string }).filter_id,
        (objStr.body as { filter_id: string }).filter_id,
      ];
      expect(new Set(ids).size).toBe(4);
      expect(cache.putCount).toBe(putsBefore + 4);

      const byId = Object.fromEntries(
        cache.puts.slice(-4).map((p) => {
          const fid = p.key.split(':').pop()!;
          return [fid, p];
        })
      );
      // Stored as JSON strings — not boolean/number/array/object primitives
      expect(JSON.parse(byId[ids[0]].value)).toBe('true');
      expect(JSON.parse(byId[ids[1]].value)).toBe('3.14');
      expect(JSON.parse(byId[ids[2]].value)).toBe('[]');
      expect(JSON.parse(byId[ids[3]].value)).toBe('{}');
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
// FILTERS — stored "0" / "false" / "null" / "true" / {} / [1] GET soft ∥ carol
// ===========================================================================

describe('race tridecenary filter str-lookalike/empty-obj/[1] GET soft after #378', () => {
  for (let i = 0; i < 10; i++) {
    it(`stored "0"∥"false"∥"null"∥"true"∥{}∥[1] ∥ carol forbid never mix flood-${i}`, async () => {
      const zeroId = `tri_zstr_${i}`;
      const falseId = `tri_fstr_${i}`;
      const nullId = `tri_nstr_${i}`;
      const trueId = `tri_tstr_${i}`;
      const objId = `tri_eobj_${i}`;
      const arrId = `tri_onearr_${i}`;
      const cache = mockCache({
        [`filter:${USER}:${zeroId}`]: '"0"',
        [`filter:${USER}:${falseId}`]: '"false"',
        [`filter:${USER}:${nullId}`]: '"null"',
        [`filter:${USER}:${trueId}`]: '"true"',
        [`filter:${USER}:${objId}`]: '{}',
        [`filter:${USER}:${arrId}`]: '[1]',
      });
      const env = createEnv(cache);
      const getsBefore = cache.getCount;

      const [zeroGet, falseGet, nullGet, trueGet, objGet, arrGet, forbid] = await Promise.all([
        request(env, filterPath(zeroId), { headers: AUTH }),
        request(env, filterPath(falseId), { headers: AUTH }),
        request(env, filterPath(nullId), { headers: AUTH }),
        request(env, filterPath(trueId), { headers: AUTH }),
        request(env, filterPath(objId), { headers: AUTH }),
        request(env, filterPath(arrId), { headers: AUTH }),
        request(env, filterPath(zeroId, CAROL_ENC), { headers: AUTH }),
      ]);

      expect(zeroGet.status).toBe(200);
      expect(zeroGet.body).toBe('0');
      expect(falseGet.status).toBe(200);
      expect(falseGet.body).toBe('false');
      expect(nullGet.status).toBe(200);
      expect(nullGet.body).toBe('null');
      expect(trueGet.status).toBe(200);
      expect(trueGet.body).toBe('true');
      expect(objGet.status).toBe(200);
      expect(objGet.body).toEqual({});
      expect(arrGet.status).toBe(200);
      expect(arrGet.body).toEqual([1]);
      expect(forbid.status).toBe(403);
      expect(forbid.body).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot read filters for other users',
      });

      // Soft success bodies never gain errcode; forbid never touches CACHE
      expect(zeroGet.body).toBe('0');
      expect(falseGet.body).toBe('false');
      expect(nullGet.body).toBe('null');
      expect(trueGet.body).toBe('true');
      expect(objGet.body).toEqual({});
      expect(arrGet.body).toEqual([1]);
      expect(cache.getCount).toBe(getsBefore + 6);
      expect((forbid.body as { error: string }).error).not.toBe(
        'Cannot create filters for other users'
      );
    });
  }
});

// ===========================================================================
// APPSERVICE — exclusive:false alias never matches ∥ wrong excludeAsId still hits
// ===========================================================================

describe('race tridecenary appservice exclusive:false alias miss∥wrong excludeAsId after #378', () => {
  for (let i = 0; i < 10; i++) {
    it(`exclusive:false alias miss ∥ wrong excludeAsId still hit flood-${i}`, async () => {
      const soft = registration('soft_ea', {
        users: [],
        rooms: [],
        aliases: [
          {
            exclusive: false,
            regex: `^#_bot_.*:${AS_ESC}$`,
          },
        ],
      });
      const hard = registration('hard_ea', {
        users: [],
        rooms: [],
        aliases: [
          {
            exclusive: true,
            regex: `^#_bot_.*:${AS_ESC}$`,
          },
        ],
      });
      const alias = `#_bot_tridecenary_${i}:${AS_SERVER}`;

      const [missSoft, hitHard, wrongExclude, rightExclude] = await Promise.all([
        Promise.resolve(isExclusiveAppServiceAlias([soft], alias)),
        Promise.resolve(isExclusiveAppServiceAlias([hard], alias)),
        Promise.resolve(isExclusiveAppServiceAlias([hard], alias, 'other_as')),
        Promise.resolve(isExclusiveAppServiceAlias([hard], alias, 'hard_ea')),
      ]);

      expect(missSoft).toBeNull();
      expect(hitHard?.id).toBe('hard_ea');
      expect(wrongExclude?.id).toBe('hard_ea');
      expect(rightExclude).toBeNull();

      // Soft exclusive:false never shadows exclusive:true sibling
      const mixed = isExclusiveAppServiceAlias([soft, hard], alias);
      expect(mixed?.id).toBe('hard_ea');
    });
  }
});

// ===========================================================================
// APPSERVICE — sender membership interest ∥ state_key-miss rooms-only
// ===========================================================================

describe('race tridecenary appservice sender interest∥state_key-miss rooms after #378', () => {
  for (let i = 0; i < 10; i++) {
    it(`sender hit ∥ state_key miss+rooms hit ∥ neither flood-${i}`, async () => {
      const usersOnly = registration('users_snd', {
        users: [
          {
            exclusive: false,
            regex: `^@_ghost_.*:${AS_ESC}$`,
          },
        ],
        rooms: [],
        aliases: [],
      });
      const roomsOnly = registration('rooms_snd', {
        users: [],
        rooms: [
          {
            exclusive: false,
            regex: `^!tri_.*:${AS_ESC}$`,
          },
        ],
        aliases: [],
      });

      const senderEvent = {
        room_id: `!plain_${i}:${AS_SERVER}`,
        sender: `@_ghost_tri_${i}:${AS_SERVER}`,
        type: 'm.room.message',
      };
      const skMissRoomEvent = {
        room_id: `!tri_room_${i}:${AS_SERVER}`,
        sender: `@alice_${i}:${AS_SERVER}`,
        state_key: `@alice_${i}:${AS_SERVER}`,
        type: 'm.room.member',
      };
      const neitherEvent = {
        room_id: `!plain_${i}:${AS_SERVER}`,
        sender: `@alice_${i}:${AS_SERVER}`,
        state_key: `@alice_${i}:${AS_SERVER}`,
        type: 'm.room.member',
      };

      const [sndHit, roomHit, none, both] = await Promise.all([
        Promise.resolve(getInterestedAppServices([usersOnly, roomsOnly], senderEvent)),
        Promise.resolve(getInterestedAppServices([usersOnly, roomsOnly], skMissRoomEvent)),
        Promise.resolve(getInterestedAppServices([usersOnly, roomsOnly], neitherEvent)),
        Promise.resolve(
          getInterestedAppServices([usersOnly, roomsOnly], {
            room_id: `!tri_room_${i}:${AS_SERVER}`,
            sender: `@_ghost_tri_${i}:${AS_SERVER}`,
            state_key: `@alice_${i}:${AS_SERVER}`,
            type: 'm.room.member',
          })
        ),
      ]);

      expect(sndHit.map((a) => a.id)).toEqual(['users_snd']);
      expect(roomHit.map((a) => a.id)).toEqual(['rooms_snd']);
      expect(none).toEqual([]);
      expect(both.map((a) => a.id).sort()).toEqual(['rooms_snd', 'users_snd']);
    });
  }
});

// ===========================================================================
// APPSERVICE — protocols '"true"' / '"0"' / '"[]"' / '"false"' ByToken∥list
// ===========================================================================

describe('race tridecenary appservice protocols str-lookalike JSON after #378', () => {
  for (let i = 0; i < 10; i++) {
    it(`'"true"'→str ∥ '"0"'→str ∥ '"[]"'→str ∥ '"false"'→str ByToken∥list flood-${i}`, async () => {
      const trueProto = asRow({
        id: `ptrue_${i}`,
        as_token: `tok_ptrue_${i}`,
        sender_localpart: 'ptrue',
        protocols: '"true"',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const zeroProto = asRow({
        id: `pzero_${i}`,
        as_token: `tok_pzero_${i}`,
        sender_localpart: 'pzero',
        protocols: '"0"',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const arrProto = asRow({
        id: `parr_${i}`,
        as_token: `tok_parr_${i}`,
        sender_localpart: 'parr',
        protocols: '"[]"',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const falseProto = asRow({
        id: `pfalse_${i}`,
        as_token: `tok_pfalse_${i}`,
        sender_localpart: 'pfalse',
        protocols: '"false"',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });

      const [byTrue, byZero, byArr, byFalse, list] = await Promise.all([
        getAppServiceByToken(createListDb([trueProto]), `tok_ptrue_${i}`),
        getAppServiceByToken(createListDb([zeroProto]), `tok_pzero_${i}`),
        getAppServiceByToken(createListDb([arrProto]), `tok_parr_${i}`),
        getAppServiceByToken(createListDb([falseProto]), `tok_pfalse_${i}`),
        getAppServices(createListDb([trueProto, zeroProto, arrProto, falseProto])),
      ]);

      expect(byTrue?.protocols).toBe('true');
      expect(byZero?.protocols).toBe('0');
      expect(byArr?.protocols).toBe('[]');
      expect(byFalse?.protocols).toBe('false');
      expect(list.map((a) => a.protocols)).toEqual(['true', '0', '[]', 'false']);
    });
  }
});

// ===========================================================================
// APPSERVICE — HTTP 208/226 ok ∥ 406/408/409/410/501 retry under race
// ===========================================================================

describe('race tridecenary appservice HTTP 208/226∥406/408/409/410/501 after #378', () => {
  const NOW = 1_700_000_910_000;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  function createTxnDb(startRowId = 3100) {
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
    it(`208∥226 → sent_at ∥ 406∥408∥409∥410∥501 → retry under parallel flood-${i}`, async () => {
      const ok208 = createTxnDb(3100 + i * 8);
      const ok226 = createTxnDb(3110 + i * 8);
      const r406 = createTxnDb(3120 + i * 8);
      const r408 = createTxnDb(3130 + i * 8);
      const r409 = createTxnDb(3140 + i * 8);
      const r410 = createTxnDb(3150 + i * 8);
      const r501 = createTxnDb(3160 + i * 8);

      const as208 = registration(
        'ok208',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://ok208.example.com' }
      );
      const as226 = registration(
        'ok226',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://ok226.example.com' }
      );
      const as406 = registration(
        'r406',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r406.example.com' }
      );
      const as408 = registration(
        'r408',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r408.example.com' }
      );
      const as409 = registration(
        'r409',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r409.example.com' }
      );
      const as410 = registration(
        'r410',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r410.example.com' }
      );
      const as501 = registration(
        'r501',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r501.example.com' }
      );

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url.includes('ok208.example.com')) return new Response('ms', { status: 208 });
          if (url.includes('ok226.example.com')) return new Response(null, { status: 226 });
          if (url.includes('r406.example.com')) return new Response('na', { status: 406 });
          if (url.includes('r408.example.com')) return new Response('timeout', { status: 408 });
          if (url.includes('r409.example.com')) return new Response('conflict', { status: 409 });
          if (url.includes('r410.example.com')) return new Response('gone', { status: 410 });
          if (url.includes('r501.example.com')) return new Response('nyi', { status: 501 });
          return new Response('unexpected', { status: 599 });
        })
      );

      const events = [{ type: 'm.room.message', body: `tridecenary_${i}` }];
      const [s208, s226, s406, s408, s409, s410, s501] = await Promise.all([
        sendAppServiceTransaction(ok208, as208, events),
        sendAppServiceTransaction(ok226, as226, events),
        sendAppServiceTransaction(r406, as406, events),
        sendAppServiceTransaction(r408, as408, events),
        sendAppServiceTransaction(r409, as409, events),
        sendAppServiceTransaction(r410, as410, events),
        sendAppServiceTransaction(r501, as501, events),
      ]);

      expect(s208).toBe(true);
      expect(s226).toBe(true);
      expect(s406).toBe(false);
      expect(s408).toBe(false);
      expect(s409).toBe(false);
      expect(s410).toBe(false);
      expect(s501).toBe(false);

      for (const db of [ok208, ok226]) {
        expect(db.updates.filter((u) => u.kind === 'sent')).toHaveLength(1);
        expect(db.updates.filter((u) => u.kind === 'retry')).toHaveLength(0);
      }
      for (const db of [r406, r408, r409, r410, r501]) {
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
// AUTH — protocols '"true"' / '"0"' / '"[]"' under requireAuth
// ===========================================================================

describe('race tridecenary auth protocols str-lookalike under requireAuth after #378', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`protocols '"true"'∥'"0"'∥'"[]"' allow ∥ ' ' unknown flood-${i}`, async () => {
      const trueTok = `as_tri_true_${i}`;
      const zeroTok = `as_tri_zero_${i}`;
      const arrTok = `as_tri_arr_${i}`;
      const badTok = `as_tri_bad_${i}`;
      const db = createAuthDb({
        appservices: new Map([
          [
            trueTok,
            asRow({
              as_token: trueTok,
              sender_localpart: 'ptrue',
              protocols: '"true"',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
          [
            zeroTok,
            asRow({
              as_token: zeroTok,
              sender_localpart: 'pzero',
              protocols: '"0"',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
          [
            arrTok,
            asRow({
              as_token: arrTok,
              sender_localpart: 'parr',
              protocols: '"[]"',
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

      const trueCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${trueTok}` },
      });
      const zeroCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${zeroTok}` },
      });
      const arrCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${arrTok}` },
      });
      const badCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${badTok}` },
      });
      const trueNext = vi.fn(async () => 'true-ok');
      const zeroNext = vi.fn(async () => 'zero-ok');
      const arrNext = vi.fn(async () => 'arr-ok');

      const [trueRes, zeroRes, arrRes, badRes] = await Promise.all([
        realRequireAuth()(trueCtx, trueNext),
        realRequireAuth()(zeroCtx, zeroNext),
        realRequireAuth()(arrCtx, arrNext),
        realRequireAuth()(badCtx, vi.fn()),
      ]);

      expect(trueRes).toBe('true-ok');
      expect(zeroRes).toBe('zero-ok');
      expect(arrRes).toBe('arr-ok');
      expect(trueNext).toHaveBeenCalledOnce();
      expect(zeroNext).toHaveBeenCalledOnce();
      expect(arrNext).toHaveBeenCalledOnce();
      expect(trueCtx.get('userId')).toBe(`@ptrue:${AUTH_SERVER}`);
      expect(zeroCtx.get('userId')).toBe(`@pzero:${AUTH_SERVER}`);
      expect(arrCtx.get('userId')).toBe(`@parr:${AUTH_SERVER}`);

      const badBody = await jsonBody(badRes as Response);
      expect(badBody).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN', status: 401 });
      expect(badCtx.get('userId')).toBeUndefined();
      expect(badBody.error).not.toBe('Missing access token');
    });
  }
});

// ===========================================================================
// AUTH — namespaces multi-ns first-match allow ∥ both-miss deny ∥ open allow
// ===========================================================================

describe('race tridecenary auth namespaces multi-ns first-match∥both-miss after #378', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`multi-ns first-match allow ∥ both-miss deny ∥ open allow flood-${i}`, async () => {
      const multiTok = `as_tri_multi_${i}`;
      const openTok = `as_tri_open_${i}`;
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
                    exclusive: false,
                    regex: `^@bot_a_.*:${AUTH_ESC}$`,
                  },
                  {
                    exclusive: false,
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
// AUTH — empty-localpart @: ∥ double-at @@x forbid ∥ valid AS soft
// ===========================================================================

describe('race tridecenary auth empty-lp∥double-at forbid∥valid soft after #378', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`empty-localpart @:∥double-at @@x forbid ∥ valid never mix flood-${i}`, async () => {
      const tok = `as_tri_uid_${i}`;
      const localUser = `@bot_tri_${i}:${AUTH_SERVER}`;
      const emptyLocalpart = `@:${AUTH_SERVER}`;
      const doubleAt = `@@bot_${i}:${AUTH_SERVER}`;
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

      const emptyLpCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(emptyLocalpart)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const doubleAtCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(doubleAt)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const validCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const validNext = vi.fn(async () => 'valid-ok');

      const [emptyRes, doubleRes, validRes] = await Promise.all([
        realRequireAuth()(emptyLpCtx, vi.fn()),
        realRequireAuth()(doubleAtCtx, vi.fn()),
        realRequireAuth()(validCtx, validNext),
      ]);

      expect(validRes).toBe('valid-ok');
      expect(validNext).toHaveBeenCalledOnce();
      expect(validCtx.get('userId')).toBe(localUser);
      expect(validCtx.get('deviceId')).toBeNull();

      const emptyBody = await jsonBody(emptyRes as Response);
      expect(emptyBody).toMatchObject({
        errcode: 'M_FORBIDDEN',
        status: 403,
      });
      expect(emptyBody.error).toContain('Invalid user_id format');
      expect(emptyLpCtx.get('userId')).toBeUndefined();

      const doubleBody = await jsonBody(doubleRes as Response);
      expect(doubleBody).toMatchObject({
        errcode: 'M_FORBIDDEN',
        status: 403,
      });
      expect(doubleBody.error).toContain('Invalid user_id format');
      expect(doubleAtCtx.get('userId')).toBeUndefined();
      expect(emptyBody.error).not.toContain('other servers');
      expect(doubleBody.error).not.toContain('other servers');
    });
  }
});

// ===========================================================================
// AUTH — Digest→query AS ∥ Token-scheme→query ∥ unknown soft
// ===========================================================================

describe('race tridecenary auth Digest∥Token→query AS∥unknown soft after #378', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`Digest∥Token→query AS ∥ unknown never mix flood-${i}`, async () => {
      const asTok = `as_tri_scheme_${i}`;
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
            { headers: { Authorization: `Digest ${asTok}` } }
          )
        )
      ).toBe(asTok);
      expect(
        extractAccessToken(
          new Request(
            `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(asTok)}`,
            { headers: { Authorization: `Token ${asTok}` } }
          )
        )
      ).toBe(asTok);

      const digestCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(asTok)}`,
        headers: { Authorization: `Digest ${asTok}` },
      });
      const tokenCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(asTok)}`,
        headers: { Authorization: `Token ${asTok}` },
      });
      const unknown = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer not_real_${i}` },
      });
      const digestNext = vi.fn(async () => 'digest-ok');
      const tokenNext = vi.fn(async () => 'token-ok');

      const [digestRes, tokenRes, unkRes] = await Promise.all([
        realRequireAuth()(digestCtx, digestNext),
        realRequireAuth()(tokenCtx, tokenNext),
        realRequireAuth()(unknown, vi.fn()),
      ]);

      expect(digestRes).toBe('digest-ok');
      expect(tokenRes).toBe('token-ok');
      expect(digestNext).toHaveBeenCalledOnce();
      expect(tokenNext).toHaveBeenCalledOnce();
      expect(digestCtx.get('userId')).toBe(`@bridge:${AUTH_SERVER}`);
      expect(tokenCtx.get('userId')).toBe(`@bridge:${AUTH_SERVER}`);
      expect(digestCtx.get('deviceId')).toBeNull();

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
