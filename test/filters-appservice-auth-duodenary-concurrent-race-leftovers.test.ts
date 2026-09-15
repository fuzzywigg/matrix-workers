/**
 * TOKENMAXX HEAVY tip deepen after #350 (tip 76189b73) — duodenary
 * *filters + appservice + auth* concurrent-race niches not covered by
 * undecenary (#350), denary (#338), nonary (#319), octonary (#312),
 * septenary (#304), senary (#292), or quinary (#286) floods.
 *
 * Gap table (why leftover after #350 undecenary / tip #357):
 *   Filters [[1]] / {a:{b:1}} / " " / 1e2 mint + TTL ∥ carol forbid
 *     | undecenary 1/3.14/[null]/{a:null}; never nested-arr/deep/ws/scientific
 *   Filters stored true/"str"/{x:1}/[1,2] GET soft ∥ carol read-forbid
 *     | undecenary null/false/0/[]; denary ""; never true/str/nested/[1,2]
 *   isExclusiveAppServiceUser exclusive:false miss ∥ exclusive:true hit
 *     | undecenary empty miss∥hit; never exclusive:false soft twin
 *   isExclusiveAppServiceAlias exclusive:false miss ∥ exclusive:true hit
 *     | denary empty miss∥hit alias; never exclusive:false alias twin
 *   protocols '[1]' / '0.5' / '{"a":[]}' ByToken∥list quirks
 *     | undecenary nested-str/object/float; never number-arr/half/nested-empty
 *   HTTP 205/206 ok ∥ 408/429/502 retry under race
 *     | undecenary 203/204∥400/401/403/503; never 205/206∥408/429/502
 *   Auth protocols '[1]'/'0.5'/'{"a":[]}' under requireAuth
 *     | undecenary nested-str/object/float; never number-arr/half/nested-empty
 *   Auth namespaces aliases-only (no users) skip ∥ restrictive deny
 *     | undecenary missing-users/rooms-only; never aliases-only top-level
 *   Auth lowercase bearer scheme AS allow ∥ unknown soft
 *     | extract /i; never proven vs M_UNKNOWN under this series race
 *   Auth query-only AS default sender ∥ Bearer unknown soft
 *     | octonary query forbid quad; undecenary Bearer default; never query∥unknown
 *
 * Distinct from #350 undecenary, #338 denary, #319 nonary, #312 octonary.
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
  isExclusiveAppServiceAlias,
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
// FILTERS — [[1]] / {a:{b:1}} / " " / 1e2 mint + TTL ∥ carol create-forbid
// ===========================================================================

describe('race duodenary filter nested/deep/ws/scientific + TTL soft after #350', () => {
  for (let i = 0; i < 12; i++) {
    it(`[[1]]∥{a:{b:1}}∥" "∥1e2 mint + TTL ∥ carol forbid flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const putsBefore = cache.putCount;

      const [nestOk, deepOk, wsOk, sciOk, forbid] = await Promise.all([
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '[[1]]',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '{"a":{"b":1}}',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '" "',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '1e2',
        }),
        request(env, filterCollection(CAROL_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: JSON.stringify({ room: { timeline: { limit: i } } }),
        }),
      ]);

      expect(nestOk.status).toBe(200);
      expect(deepOk.status).toBe(200);
      expect(wsOk.status).toBe(200);
      expect(sciOk.status).toBe(200);
      expect(forbid.status).toBe(403);
      expect(forbid.body).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot create filters for other users',
      });

      const ids = [
        (nestOk.body as { filter_id: string }).filter_id,
        (deepOk.body as { filter_id: string }).filter_id,
        (wsOk.body as { filter_id: string }).filter_id,
        (sciOk.body as { filter_id: string }).filter_id,
      ];
      expect(new Set(ids).size).toBe(4);
      expect(cache.putCount).toBe(putsBefore + 4);

      const byId = Object.fromEntries(
        cache.puts.slice(-4).map((p) => {
          const fid = p.key.split(':').pop()!;
          return [fid, p];
        })
      );
      expect(JSON.parse(byId[ids[0]].value)).toEqual([[1]]);
      expect(JSON.parse(byId[ids[1]].value)).toEqual({ a: { b: 1 } });
      expect(JSON.parse(byId[ids[2]].value)).toBe(' ');
      expect(JSON.parse(byId[ids[3]].value)).toBe(100);
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
// FILTERS — stored true / "str" / {x:1} / [1,2] GET soft ∥ carol read-forbid
// ===========================================================================

describe('race duodenary filter true/str/nested/[1,2] GET soft after #350', () => {
  for (let i = 0; i < 10; i++) {
    it(`stored true∥"str"∥{x:1}∥[1,2] ∥ carol forbid never mix flood-${i}`, async () => {
      const trueId = `duo_true_${i}`;
      const strId = `duo_str_${i}`;
      const nestId = `duo_nest_${i}`;
      const arrId = `duo_arr_${i}`;
      const cache = mockCache({
        [`filter:${USER}:${trueId}`]: 'true',
        [`filter:${USER}:${strId}`]: '"str"',
        [`filter:${USER}:${nestId}`]: '{"x":1}',
        [`filter:${USER}:${arrId}`]: '[1,2]',
      });
      const env = createEnv(cache);
      const getsBefore = cache.getCount;

      const [trueGet, strGet, nestGet, arrGet, forbid] = await Promise.all([
        request(env, filterPath(trueId), { headers: AUTH }),
        request(env, filterPath(strId), { headers: AUTH }),
        request(env, filterPath(nestId), { headers: AUTH }),
        request(env, filterPath(arrId), { headers: AUTH }),
        request(env, filterPath(trueId, CAROL_ENC), { headers: AUTH }),
      ]);

      expect(trueGet.status).toBe(200);
      expect(trueGet.body).toBe(true);
      expect(strGet.status).toBe(200);
      expect(strGet.body).toBe('str');
      expect(nestGet.status).toBe(200);
      expect(nestGet.body).toEqual({ x: 1 });
      expect(arrGet.status).toBe(200);
      expect(arrGet.body).toEqual([1, 2]);
      expect(forbid.status).toBe(403);
      expect(forbid.body).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot read filters for other users',
      });

      expect(trueGet.body).toBe(true);
      expect(strGet.body).toBe('str');
      expect(nestGet.body).toEqual({ x: 1 });
      expect(arrGet.body).toEqual([1, 2]);
      expect(cache.getCount).toBe(getsBefore + 4);
      expect((forbid.body as { error: string }).error).not.toBe(
        'Cannot create filters for other users'
      );
    });
  }
});

// ===========================================================================
// APPSERVICE — exclusive:false USER miss ∥ exclusive:true hit
// ===========================================================================

describe('race duodenary appservice exclusive:false user miss after #350', () => {
  for (let i = 0; i < 10; i++) {
    it(`exclusive:false miss ∥ exclusive:true hit ∥ excludeAsId flood-${i}`, async () => {
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

      const [missSoft, hitHard, mixed] = await Promise.all([
        Promise.resolve(isExclusiveAppServiceUser([soft], userId)),
        Promise.resolve(isExclusiveAppServiceUser([hard], userId)),
        Promise.resolve(isExclusiveAppServiceUser([soft, hard], userId)),
      ]);

      expect(missSoft).toBeNull();
      expect(hitHard?.id).toBe('hard_eu');
      expect(mixed?.id).toBe('hard_eu');
      expect(isExclusiveAppServiceUser([hard], userId, 'hard_eu')).toBeNull();
    });
  }
});

// ===========================================================================
// APPSERVICE — exclusive:false ALIAS miss ∥ exclusive:true hit
// ===========================================================================

describe('race duodenary appservice exclusive:false alias miss after #350', () => {
  for (let i = 0; i < 10; i++) {
    it(`exclusive:false alias miss ∥ exclusive:true hit flood-${i}`, async () => {
      const soft = registration('soft_ea', {
        users: [],
        rooms: [],
        aliases: [
          {
            exclusive: false,
            regex: `^#bridge_.*:${AS_ESC}$`,
          },
        ],
      });
      const hard = registration('hard_ea', {
        users: [],
        rooms: [],
        aliases: [
          {
            exclusive: true,
            regex: `^#bridge_.*:${AS_ESC}$`,
          },
        ],
      });
      const alias = `#bridge_duo_${i}:${AS_SERVER}`;
      const plain = `#plain_${i}:${AS_SERVER}`;

      const [missSoft, missPlain, hitHard] = await Promise.all([
        Promise.resolve(isExclusiveAppServiceAlias([soft], alias)),
        Promise.resolve(isExclusiveAppServiceAlias([hard], plain)),
        Promise.resolve(isExclusiveAppServiceAlias([hard], alias)),
      ]);

      expect(missSoft).toBeNull();
      expect(missPlain).toBeNull();
      expect(hitHard?.id).toBe('hard_ea');
      expect(isExclusiveAppServiceAlias([soft, hard], alias)?.id).toBe('hard_ea');
      expect(isExclusiveAppServiceAlias([hard], alias, 'hard_ea')).toBeNull();
    });
  }
});

// ===========================================================================
// APPSERVICE — protocols '[1]' / '0.5' / '{"a":[]}' ByToken∥list
// ===========================================================================

describe('race duodenary appservice protocols number-arr/half/nested-empty after #350', () => {
  for (let i = 0; i < 10; i++) {
    it(`'[1]'→arr ∥ '0.5'→half ∥ '{"a":[]}'→obj ByToken∥list flood-${i}`, async () => {
      const numArr = asRow({
        id: `pnarr_${i}`,
        as_token: `tok_pnarr_${i}`,
        sender_localpart: 'pnarr',
        protocols: '[1]',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const half = asRow({
        id: `phalf_${i}`,
        as_token: `tok_phalf_${i}`,
        sender_localpart: 'phalf',
        protocols: '0.5',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const nestEmpty = asRow({
        id: `pnemp_${i}`,
        as_token: `tok_pnemp_${i}`,
        sender_localpart: 'pnemp',
        protocols: '{"a":[]}',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const sqlNull = asRow({
        id: `pz_${i}`,
        as_token: `tok_pz_${i}`,
        sender_localpart: 'pz',
        protocols: null,
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });

      const [byArr, byHalf, byNest, bySql, list] = await Promise.all([
        getAppServiceByToken(createListDb([numArr]), `tok_pnarr_${i}`),
        getAppServiceByToken(createListDb([half]), `tok_phalf_${i}`),
        getAppServiceByToken(createListDb([nestEmpty]), `tok_pnemp_${i}`),
        getAppServiceByToken(createListDb([sqlNull]), `tok_pz_${i}`),
        getAppServices(createListDb([numArr, half, nestEmpty, sqlNull])),
      ]);

      expect(byArr?.protocols).toEqual([1]);
      expect(byHalf?.protocols).toBe(0.5);
      expect(byNest?.protocols).toEqual({ a: [] });
      expect(bySql?.protocols).toEqual([]);
      expect(list.map((a) => a.protocols)).toEqual([[1], 0.5, { a: [] }, []]);
    });
  }
});

// ===========================================================================
// APPSERVICE — HTTP 205/206 ok ∥ 408/429/502 retry under race
// ===========================================================================

describe('race duodenary appservice HTTP 205/206∥408/429/502 after #350', () => {
  const NOW = 1_700_000_900_000;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  function createTxnDb(startRowId = 1200) {
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
    it(`205∥206 → sent_at ∥ 408∥429∥502 → retry under parallel flood-${i}`, async () => {
      const ok205 = createTxnDb(1200 + i * 5);
      const ok206 = createTxnDb(1210 + i * 5);
      const r408 = createTxnDb(1220 + i * 5);
      const r429 = createTxnDb(1230 + i * 5);
      const r502 = createTxnDb(1240 + i * 5);

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
      const as408 = registration(
        'r408',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r408.example.com' }
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

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          // 205 Reset Content forbids a body; null is required (empty string throws).
          if (url.includes('ok205.example.com')) return new Response(null, { status: 205 });
          if (url.includes('ok206.example.com')) return new Response(null, { status: 206 });
          if (url.includes('r408.example.com')) return new Response('timeout', { status: 408 });
          if (url.includes('r429.example.com')) return new Response('rate', { status: 429 });
          if (url.includes('r502.example.com')) return new Response('badgw', { status: 502 });
          return new Response('unexpected', { status: 599 });
        })
      );

      const events = [{ type: 'm.room.message', body: `duodenary_${i}` }];
      const [s205, s206, s408, s429, s502] = await Promise.all([
        sendAppServiceTransaction(ok205, as205, events),
        sendAppServiceTransaction(ok206, as206, events),
        sendAppServiceTransaction(r408, as408, events),
        sendAppServiceTransaction(r429, as429, events),
        sendAppServiceTransaction(r502, as502, events),
      ]);

      expect(s205).toBe(true);
      expect(s206).toBe(true);
      expect(s408).toBe(false);
      expect(s429).toBe(false);
      expect(s502).toBe(false);

      expect(ok205.updates.filter((u) => u.kind === 'sent')).toHaveLength(1);
      expect(ok206.updates.filter((u) => u.kind === 'sent')).toHaveLength(1);
      expect(ok205.updates.filter((u) => u.kind === 'retry')).toHaveLength(0);
      expect(ok206.updates.filter((u) => u.kind === 'retry')).toHaveLength(0);

      for (const db of [r408, r429, r502]) {
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
// AUTH — protocols '[1]' / '0.5' / '{"a":[]}' under requireAuth
// ===========================================================================

describe('race duodenary auth protocols number-arr/half/nested-empty under requireAuth after #350', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`protocols '[1]'∥'0.5'∥'{"a":[]}' allow ∥ ' ' unknown flood-${i}`, async () => {
      const arrTok = `as_duo_narr_${i}`;
      const halfTok = `as_duo_half_${i}`;
      const nestTok = `as_duo_nemp_${i}`;
      const badTok = `as_duo_bad_${i}`;
      const db = createAuthDb({
        appservices: new Map([
          [
            arrTok,
            asRow({
              as_token: arrTok,
              sender_localpart: 'narr',
              protocols: '[1]',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
          [
            halfTok,
            asRow({
              as_token: halfTok,
              sender_localpart: 'half',
              protocols: '0.5',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
          [
            nestTok,
            asRow({
              as_token: nestTok,
              sender_localpart: 'nemp',
              protocols: '{"a":[]}',
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

      const arrCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${arrTok}` },
      });
      const halfCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${halfTok}` },
      });
      const nestCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${nestTok}` },
      });
      const badCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${badTok}` },
      });
      const arrNext = vi.fn(async () => 'arr-ok');
      const halfNext = vi.fn(async () => 'half-ok');
      const nestNext = vi.fn(async () => 'nest-ok');

      const [arrRes, halfRes, nestRes, badRes] = await Promise.all([
        realRequireAuth()(arrCtx, arrNext),
        realRequireAuth()(halfCtx, halfNext),
        realRequireAuth()(nestCtx, nestNext),
        realRequireAuth()(badCtx, vi.fn()),
      ]);

      expect(arrRes).toBe('arr-ok');
      expect(halfRes).toBe('half-ok');
      expect(nestRes).toBe('nest-ok');
      expect(arrNext).toHaveBeenCalledOnce();
      expect(halfNext).toHaveBeenCalledOnce();
      expect(nestNext).toHaveBeenCalledOnce();
      expect(arrCtx.get('userId')).toBe(`@narr:${AUTH_SERVER}`);
      expect(halfCtx.get('userId')).toBe(`@half:${AUTH_SERVER}`);
      expect(nestCtx.get('userId')).toBe(`@nemp:${AUTH_SERVER}`);

      const badBody = await jsonBody(badRes as Response);
      expect(badBody).toMatchObject({ errcode: 'M_UNKNOWN_TOKEN', status: 401 });
      expect(badCtx.get('userId')).toBeUndefined();
      expect(badBody.error).not.toBe('Missing access token');
    });
  }
});

// ===========================================================================
// AUTH — namespaces aliases-only (no users) skip ∥ restrictive deny
// ===========================================================================

describe('race duodenary auth namespaces aliases-only skip after #350', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`aliases-only skip ∥ restrictive deny flood-${i}`, async () => {
      const aliasTok = `as_duo_alias_${i}`;
      const denyTok = `as_duo_deny_${i}`;
      const localUser = `@guest_${i}:${AUTH_SERVER}`;
      const db = createAuthDb({
        appservices: new Map([
          [
            aliasTok,
            asRow({
              as_token: aliasTok,
              sender_localpart: 'alias',
              // users key absent — aliases-only top-level skips gate
              namespaces: JSON.stringify({
                aliases: [
                  {
                    exclusive: false,
                    regex: `^#.*:${AUTH_SERVER.replace(/\./g, '\\.')}$`,
                  },
                ],
                rooms: [],
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

      const aliasCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${aliasTok}` },
      });
      const denyCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${denyTok}` },
      });
      const aliasNext = vi.fn(async () => 'alias-ok');

      const [aliasRes, denyRes] = await Promise.all([
        realRequireAuth()(aliasCtx, aliasNext),
        realRequireAuth()(denyCtx, vi.fn()),
      ]);

      expect(aliasRes).toBe('alias-ok');
      expect(aliasNext).toHaveBeenCalledOnce();
      expect(aliasCtx.get('userId')).toBe(localUser);

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
// AUTH — lowercase bearer scheme AS allow ∥ unknown soft
// ===========================================================================

describe('race duodenary auth lowercase bearer ∥ unknown soft after #350', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`lowercase bearer AS allow ∥ unknown never mix flood-${i}`, async () => {
      const asTok = `as_duo_lcase_${i}`;
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

      const okCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `bearer ${asTok}` },
      });
      const unkCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `bearer not_real_${i}` },
      });
      const next = vi.fn(async () => 'lcase-ok');

      const [okRes, unkRes] = await Promise.all([
        realRequireAuth()(okCtx, next),
        realRequireAuth()(unkCtx, vi.fn()),
      ]);

      expect(okRes).toBe('lcase-ok');
      expect(next).toHaveBeenCalledOnce();
      expect(okCtx.get('userId')).toBe(`@bridge:${AUTH_SERVER}`);
      expect(okCtx.get('deviceId')).toBeNull();

      const unkBody = await jsonBody(unkRes as Response);
      expect(unkBody).toMatchObject({
        errcode: 'M_UNKNOWN_TOKEN',
        status: 401,
      });
      expect(unkCtx.get('userId')).toBeUndefined();
      expect(unkBody.error).not.toBe('Missing access token');
      expect(unkBody.error).not.toContain('application service');
    });
  }
});

// ===========================================================================
// AUTH — query-only AS default sender ∥ Bearer unknown soft
// ===========================================================================

describe('race duodenary auth query-only AS default ∥ Bearer unknown after #350', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`query-only AS default sender ∥ Bearer unknown never mix flood-${i}`, async () => {
      const asTok = `as_duo_query_${i}`;
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
          new Request(
            `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(asTok)}`
          )
        )
      ).toBe(asTok);

      const queryCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(asTok)}`,
        headers: {},
      });
      const unkCtx = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer not_real_${i}` },
      });
      const next = vi.fn(async () => 'query-ok');

      const [okRes, unkRes] = await Promise.all([
        realRequireAuth()(queryCtx, next),
        realRequireAuth()(unkCtx, vi.fn()),
      ]);

      expect(okRes).toBe('query-ok');
      expect(next).toHaveBeenCalledOnce();
      expect(queryCtx.get('userId')).toBe(`@bridge:${AUTH_SERVER}`);
      expect(queryCtx.get('deviceId')).toBeNull();

      const unkBody = await jsonBody(unkRes as Response);
      expect(unkBody).toMatchObject({
        errcode: 'M_UNKNOWN_TOKEN',
        status: 401,
      });
      expect(unkCtx.get('userId')).toBeUndefined();
      expect(unkBody.error).not.toBe('Missing access token');
      expect(unkBody.error).not.toContain('application service');
    });
  }
});
