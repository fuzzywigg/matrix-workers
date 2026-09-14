/**
 * TOKENMAXX HEAVY leftovers after #312 — nonary *filters + appservice + auth*
 * concurrent-race niches not covered by octonary (#312), septenary (#304),
 * senary (#292), or quinary (#286) floods.
 *
 * Gap table (why leftover after #312 octonary):
 *   Filters primitive JSON bodies null/true/42/"str" mint + TTL ∥ carol forbid
 *     | octonary {}∥[]∥nested objects only; never primitives under race
 *   Filters create-forbid ∥ read-forbid ∥ Invalid JSON ∥ POST→GET roundtrip mega
 *     | septenary soft-quad; octonary POST→GET separate; never same-flight mega
 *   isExclusiveAppServiceUser users:null throw ∥ empty miss ∥ exclusive hit
 *     | octonary interest users:null + exclusive aliases:null; never exclusive USER
 *   protocols 'true'/'0'/'1' ByToken∥list quirks
 *     | octonary 'null'/'[]'/'false'; never true/0/1
 *   HTTP 201 ok ∥ 100/199/301 retry under race
 *     | octonary 299∥300; appservice-api quaternary had bands; never this series
 *   excludeAsId '' falsy still matches exclusive user∥alias
 *     | quinary null / senary NaN; never '' in this series
 *   Auth protocols 'false'/'true' under requireAuth
 *     | octonary 'null'/'[]'; septenary '{}'; never boolean JSON
 *   Auth exclusive:false matching allow ∥ exclusive:false non-match deny
 *     | gate ignores exclusive flag; never proven under this series race
 *   Auth M_MISSING_TOKEN ∥ AS success soft under race
 *     | septenary/octonary soft-quads never included missing-token
 *   Auth throwOnAs ∥ valid user-token success under race
 *     | residual/auth-middleware; never this filters-appservice-auth file
 *   Auth namespaces JSON '[]' skip gate ∥ restrictive deny
 *     | octonary users:null/[]; never top-level namespaces array JSON
 *
 * Distinct from #312 octonary, #304 septenary, #292 senary, #286 quinary.
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
import { hashToken } from '../src/utils/crypto';

// Real requireAuth loaded via importActual in auth suites below
// (filter routes use the mocked requireAuth from vi.mock).

// ---------------------------------------------------------------------------
// Filters harness (mocked requireAuth — mirrors octonary/septenary series)
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
// FILTERS — primitive JSON bodies + TTL ∥ carol create-forbid
// ===========================================================================

describe('race nonary filter primitive body + TTL soft after #312', () => {
  for (let i = 0; i < 12; i++) {
    it(`null∥true∥42∥"str" mint + TTL ∥ carol forbid flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const putsBefore = cache.putCount;
      const strBody = `"nonary_${i}"`;

      const [nullOk, trueOk, numOk, strOk, forbid] = await Promise.all([
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: 'null',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: 'true',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '42',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: strBody,
        }),
        request(env, filterCollection(CAROL_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: JSON.stringify(sampleFilter(i)),
        }),
      ]);

      expect(nullOk.status).toBe(200);
      expect(trueOk.status).toBe(200);
      expect(numOk.status).toBe(200);
      expect(strOk.status).toBe(200);
      expect(forbid.status).toBe(403);
      expect(forbid.body).toEqual({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot create filters for other users',
      });

      const ids = [
        (nullOk.body as { filter_id: string }).filter_id,
        (trueOk.body as { filter_id: string }).filter_id,
        (numOk.body as { filter_id: string }).filter_id,
        (strOk.body as { filter_id: string }).filter_id,
      ];
      expect(new Set(ids).size).toBe(4);
      expect(cache.putCount - putsBefore).toBe(4);

      expect(JSON.parse(cache.data[`filter:${USER}:${ids[0]}`]!)).toBeNull();
      expect(JSON.parse(cache.data[`filter:${USER}:${ids[1]}`]!)).toBe(true);
      expect(JSON.parse(cache.data[`filter:${USER}:${ids[2]}`]!)).toBe(42);
      expect(JSON.parse(cache.data[`filter:${USER}:${ids[3]}`]!)).toBe(`nonary_${i}`);

      for (const p of cache.puts.slice(putsBefore)) {
        expect(p.options?.expirationTtl).toBe(FILTER_TTL);
        expect(p.key.startsWith(`filter:${USER}:`)).toBe(true);
      }
      expect(Object.keys(cache.data).some((k) => k.includes(CAROL))).toBe(false);
    });
  }
});

// ===========================================================================
// FILTERS — create-forbid ∥ read-forbid ∥ Invalid JSON ∥ POST→GET mega
// ===========================================================================

describe('race nonary filter soft mega + POST→GET after #312', () => {
  for (let i = 0; i < 10; i++) {
    it(`create∥read forbid ∥ bad-JSON ∥ mint→GET never mix flood-${i}`, async () => {
      const cache = mockCache({
        [`filter:${CAROL}:seed_${i}`]: JSON.stringify(sampleFilter(i)),
      });
      const env = createEnv(cache);
      const putsBefore = cache.putCount;
      const payload = sampleFilter(i + 11);

      const mint = await request(env, filterCollection(USER_ENC), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: JSON.stringify(payload),
      });
      expect(mint.status).toBe(200);
      const fid = (mint.body as { filter_id: string }).filter_id;
      expect(cache.putCount - putsBefore).toBe(1);
      expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(FILTER_TTL);

      const getsBefore = cache.getCount;
      const [createForbid, readForbid, badJson, roundtrip] = await Promise.all([
        request(env, filterCollection(CAROL_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: JSON.stringify(sampleFilter(i)),
        }),
        request(env, filterPath(`seed_${i}`, CAROL_ENC), {
          method: 'GET',
          headers: { ...AUTH },
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '{not-json',
        }),
        request(env, filterPath(fid), { method: 'GET', headers: { ...AUTH } }),
      ]);

      expect(createForbid.status).toBe(403);
      expect(createForbid.body).toEqual({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot create filters for other users',
      });
      expect(readForbid.status).toBe(403);
      expect(readForbid.body).toEqual({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot read filters for other users',
      });
      expect(badJson.status).toBe(400);
      expect(badJson.body).toEqual({
        errcode: 'M_BAD_JSON',
        error: 'Invalid JSON',
      });
      expect(roundtrip.status).toBe(200);
      expect(roundtrip.body).toEqual(payload);

      // Soft strings never bleed; forbid never touches CACHE
      expect((createForbid.body as { error: string }).error).not.toBe(
        (readForbid.body as { error: string }).error
      );
      expect((createForbid.body as { error: string }).error).not.toBe('Invalid JSON');
      expect((readForbid.body as { error: string }).error).not.toBe('Invalid JSON');
      expect(roundtrip.body).not.toHaveProperty('errcode');
      expect(cache.putCount - putsBefore).toBe(1);
      expect(cache.getCount - getsBefore).toBe(1);
    });
  }
});

// ===========================================================================
// APPSERVICE — exclusive USER users:null throw ∥ empty miss ∥ hit
// ===========================================================================

describe('race nonary appservice exclusive users:null after #312', () => {
  for (let i = 0; i < 10; i++) {
    it(`users:null exclusive throw ∥ empty miss ∥ hit flood-${i}`, async () => {
      const broken = registration('broken_eu', {
        users: null as unknown as AppServiceRegistration['namespaces']['users'],
        rooms: [],
        aliases: [],
      });
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
      const uid = `@_bot_nonary_${i}:${AS_SERVER}`;
      const plain = `@alice_${i}:${AS_SERVER}`;

      const [thrown, missEmpty, missPlain, matched] = await Promise.all([
        Promise.resolve()
          .then(() => isExclusiveAppServiceUser([broken], uid))
          .then((v) => ({ ok: true as const, v }))
          .catch((e) => ({ ok: false as const, err: e })),
        Promise.resolve(isExclusiveAppServiceUser([empty], uid)),
        Promise.resolve(isExclusiveAppServiceUser([hit], plain)),
        Promise.resolve(isExclusiveAppServiceUser([hit], uid)),
      ]);

      expect(thrown.ok).toBe(false);
      expect(missEmpty).toBeNull();
      expect(missPlain).toBeNull();
      expect(matched?.id).toBe('hit_eu');

      // Mixed list: broken first still throws before hit
      const mixed = await Promise.resolve()
        .then(() => isExclusiveAppServiceUser([broken, hit], uid))
        .then((v) => ({ ok: true as const, v }))
        .catch((e) => ({ ok: false as const, err: e }));
      expect(mixed.ok).toBe(false);
    });
  }
});

// ===========================================================================
// APPSERVICE — excludeAsId '' falsy still matches
// ===========================================================================

describe('race nonary appservice excludeAsId empty-string after #312', () => {
  for (let i = 0; i < 10; i++) {
    it(`excludeAsId '' still matches exclusive user∥alias flood-${i}`, async () => {
      const bridge = registration('bridge_ex', {
        users: [
          {
            exclusive: true,
            regex: `^@_bridge_.*:${AS_ESC}$`,
          },
        ],
        rooms: [],
        aliases: [
          {
            exclusive: true,
            regex: `^#_bridge_.*:${AS_ESC}$`,
          },
        ],
      });
      const uid = `@_bridge_x_${i}:${AS_SERVER}`;
      const alias = `#_bridge_r_${i}:${AS_SERVER}`;
      const falsyEmpty = '' as unknown as string;

      const [userHit, aliasHit, userExcl, aliasExcl] = await Promise.all([
        Promise.resolve(isExclusiveAppServiceUser([bridge], uid, falsyEmpty)),
        Promise.resolve(isExclusiveAppServiceAlias([bridge], alias, falsyEmpty)),
        Promise.resolve(isExclusiveAppServiceUser([bridge], uid, 'bridge_ex')),
        Promise.resolve(isExclusiveAppServiceAlias([bridge], alias, 'bridge_ex')),
      ]);

      // '' is falsy → `if (excludeAsId && …)` skips → still matches
      expect(userHit?.id).toBe('bridge_ex');
      expect(aliasHit?.id).toBe('bridge_ex');
      expect(userExcl).toBeNull();
      expect(aliasExcl).toBeNull();
    });
  }
});

// ===========================================================================
// APPSERVICE — protocols 'true' / '0' / '1' ByToken∥list
// ===========================================================================

describe('race nonary appservice protocols true/0/1 JSON after #312', () => {
  for (let i = 0; i < 10; i++) {
    it(`'true'→true ∥ '0'→0 ∥ '1'→1 ByToken∥list flood-${i}`, async () => {
      const truthy = asRow({
        id: `pt_${i}`,
        as_token: `tok_pt_${i}`,
        sender_localpart: 'pt',
        protocols: 'true',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const zero = asRow({
        id: `pz_${i}`,
        as_token: `tok_pz_${i}`,
        sender_localpart: 'pz',
        protocols: '0',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const one = asRow({
        id: `po_${i}`,
        as_token: `tok_po_${i}`,
        sender_localpart: 'po',
        protocols: '1',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const sqlNull = asRow({
        id: `ps_${i}`,
        as_token: `tok_ps_${i}`,
        sender_localpart: 'ps',
        protocols: null,
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });

      const [byTrue, byZero, byOne, bySql, list] = await Promise.all([
        getAppServiceByToken(createListDb([truthy]), `tok_pt_${i}`),
        getAppServiceByToken(createListDb([zero]), `tok_pz_${i}`),
        getAppServiceByToken(createListDb([one]), `tok_po_${i}`),
        getAppServiceByToken(createListDb([sqlNull]), `tok_ps_${i}`),
        getAppServices(createListDb([truthy, zero, one, sqlNull])),
      ]);

      expect(byTrue?.protocols).toBe(true);
      expect(byZero?.protocols).toBe(0);
      expect(byOne?.protocols).toBe(1);
      expect(bySql?.protocols).toEqual([]);
      expect(list.map((a) => a.protocols)).toEqual([true, 0, 1, []]);
    });
  }
});

// ===========================================================================
// APPSERVICE — HTTP 201 ok ∥ 100/199/301 retry under race
// ===========================================================================

describe('race nonary appservice HTTP 201∥100/199/301 after #312', () => {
  const NOW = 1_700_000_600_000;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  function createTxnDb(startRowId = 800) {
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
    it(`201 → sent_at ∥ 100∥199∥301 → retry under parallel flood-${i}`, async () => {
      const okDb = createTxnDb(800 + i * 4);
      const r100 = createTxnDb(810 + i * 4);
      const r199 = createTxnDb(820 + i * 4);
      const r301 = createTxnDb(830 + i * 4);
      const okAs = registration(
        'ok201',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://ok201.example.com' }
      );
      const as100 = registration(
        'r100',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r100.example.com' }
      );
      const as199 = registration(
        'r199',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r199.example.com' }
      );
      const as301 = registration(
        'r301',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r301.example.com' }
      );

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const u = String(url);
          if (u.includes('ok201.example.com')) return new Response('{}', { status: 201 });
          if (u.includes('r100.example.com')) return new Response('cont', { status: 100 });
          if (u.includes('r199.example.com')) return new Response('cont', { status: 199 });
          return new Response('redirect', { status: 301 });
        })
      );

      const [ok, a, b, c] = await Promise.all([
        sendAppServiceTransaction(okDb, okAs, [{ n: i }]),
        sendAppServiceTransaction(r100, as100, [{ n: i }]),
        sendAppServiceTransaction(r199, as199, [{ n: i }]),
        sendAppServiceTransaction(r301, as301, [{ n: i }]),
      ]);

      expect(ok).toBe(true);
      expect(a).toBe(false);
      expect(b).toBe(false);
      expect(c).toBe(false);
      expect(okDb.updates.map((u) => u.kind)).toEqual(['sent']);
      expect(r100.updates.map((u) => u.kind)).toEqual(['retry']);
      expect(r199.updates.map((u) => u.kind)).toEqual(['retry']);
      expect(r301.updates.map((u) => u.kind)).toEqual(['retry']);
      expect(okDb.updates.some((u) => u.kind === 'retry')).toBe(false);
    });
  }
});

// ===========================================================================
// AUTH — protocols 'false'/'true' under requireAuth
// ===========================================================================

describe('race nonary auth protocols false/true JSON under requireAuth after #312', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 8; i++) {
    it(`protocols 'false'∥'true' allow ∥ ' ' unknown flood-${i}`, async () => {
      const tokFalse = `as_proto_f_${i}`;
      const tokTrue = `as_proto_t_${i}`;
      const tokWs = `as_proto_w_${i}`;
      const dbFalse = createAuthDb({
        appservices: new Map([
          [
            tokFalse,
            asRow({
              as_token: tokFalse,
              sender_localpart: 'falseproto',
              protocols: 'false',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
        ]),
      });
      const dbTrue = createAuthDb({
        appservices: new Map([
          [
            tokTrue,
            asRow({
              as_token: tokTrue,
              sender_localpart: 'trueproto',
              protocols: 'true',
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

      const falseCtx = makeAuthCtx({
        db: dbFalse,
        headers: { Authorization: `Bearer ${tokFalse}` },
      });
      const trueCtx = makeAuthCtx({
        db: dbTrue,
        headers: { Authorization: `Bearer ${tokTrue}` },
      });
      const wsCtx = makeAuthCtx({
        db: dbWs,
        headers: { Authorization: `Bearer ${tokWs}` },
      });

      const [falseRes, trueRes, wsRes] = await Promise.all([
        realRequireAuth()(falseCtx, vi.fn(async () => 'false')),
        realRequireAuth()(trueCtx, vi.fn(async () => 'true')),
        realRequireAuth()(wsCtx, vi.fn()),
      ]);

      expect(falseRes).toBe('false');
      expect(falseCtx.get('userId')).toBe(`@falseproto:${AUTH_SERVER}`);
      expect(trueRes).toBe('true');
      expect(trueCtx.get('userId')).toBe(`@trueproto:${AUTH_SERVER}`);
      expect(await jsonBody(wsRes as Response)).toMatchObject({
        errcode: 'M_UNKNOWN_TOKEN',
        status: 401,
      });
    });
  }
});

// ===========================================================================
// AUTH — exclusive:false matching allow ∥ exclusive:false non-match deny
// ===========================================================================

describe('race nonary auth exclusive:false gate ignores flag after #312', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`exclusive:false match allow ∥ non-match deny flood-${i}`, async () => {
      const tokAllow = `as_non_ex_ok_${i}`;
      const tokDeny = `as_non_ex_no_${i}`;
      const localUser = `@_bridge_ok_${i}:${AUTH_SERVER}`;
      const outsider = `@alice_${i}:${AUTH_SERVER}`;
      const nsMatch = JSON.stringify({
        users: [
          {
            exclusive: false,
            regex: `^@_bridge_.*:${AUTH_SERVER.replace(/\./g, '\\.')}$`,
          },
        ],
        rooms: [],
        aliases: [],
      });

      const dbAllow = createAuthDb({
        appservices: new Map([
          [
            tokAllow,
            asRow({
              as_token: tokAllow,
              sender_localpart: 'bridge',
              namespaces: nsMatch,
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
              sender_localpart: 'bridge',
              namespaces: nsMatch,
            }),
          ],
        ]),
      });

      const allowCtx = makeAuthCtx({
        db: dbAllow,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${tokAllow}` },
      });
      const denyCtx = makeAuthCtx({
        db: dbDeny,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(outsider)}`,
        headers: { Authorization: `Bearer ${tokDeny}` },
      });

      const [allowRes, denyRes] = await Promise.all([
        realRequireAuth()(allowCtx, vi.fn(async () => 'allow')),
        realRequireAuth()(denyCtx, vi.fn()),
      ]);

      // Gate uses regex .some only — exclusive:false still allows on match
      expect(allowRes).toBe('allow');
      expect(allowCtx.get('userId')).toBe(localUser);
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
// AUTH — M_MISSING_TOKEN ∥ AS success soft under race
// ===========================================================================

describe('race nonary auth missing-token ∥ AS success soft after #312', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`M_MISSING_TOKEN ∥ AS success never mix flood-${i}`, async () => {
      const tok = `as_non_miss_${i}`;
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
                    exclusive: true,
                    regex: `^@_bridge_.*:${AUTH_SERVER.replace(/\./g, '\\.')}$`,
                  },
                ],
                rooms: [],
                aliases: [],
              }),
            }),
          ],
        ]),
      });

      const missing = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: {},
      });
      const ok = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(
          `@_bridge_ok_${i}:${AUTH_SERVER}`
        )}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const next = vi.fn(async () => 'ok');

      expect(extractAccessToken(new Request(`https://${AUTH_SERVER}/sync`))).toBeNull();

      const [missRes, okRes] = await Promise.all([
        realRequireAuth()(missing, vi.fn()),
        realRequireAuth()(ok, next),
      ]);

      const missBody = await jsonBody(missRes as Response);
      expect(missBody).toMatchObject({
        errcode: 'M_MISSING_TOKEN',
        error: 'Missing access token',
        status: 401,
      });
      expect(okRes).toBe('ok');
      expect(next).toHaveBeenCalledOnce();
      expect(ok.get('userId')).toBe(`@_bridge_ok_${i}:${AUTH_SERVER}`);
      expect(missing.get('userId')).toBeUndefined();
      // Soft strings never bleed
      expect(missBody.error).not.toBe('Unknown token');
      expect(missBody.error).not.toContain('application service');
    });
  }
});

// ===========================================================================
// AUTH — throwOnAs ∥ valid user-token success under race
// ===========================================================================

describe('race nonary auth throwOnAs ∥ user-token success after #312', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`throwOnAs → unknown ∥ user token ok under race flood-${i}`, async () => {
      const userTok = `syt_nonary_user_${i}`;
      const hash = await hashToken(userTok);
      const throwDb = createAuthDb({ throwOnAs: true });
      const userDb = createAuthDb({
        tokens: new Map([
          [hash, { user_id: `@alice_${i}:${AUTH_SERVER}`, device_id: `D${i}` }],
        ]),
      });

      const throwCtx = makeAuthCtx({
        db: throwDb,
        headers: { Authorization: `Bearer as_will_throw_${i}` },
      });
      const userCtx = makeAuthCtx({
        db: userDb,
        headers: { Authorization: `Bearer ${userTok}` },
      });
      const next = vi.fn(async () => 'user-ok');

      const [throwRes, userRes] = await Promise.all([
        realRequireAuth()(throwCtx, vi.fn()),
        realRequireAuth()(userCtx, next),
      ]);

      expect(await jsonBody(throwRes as Response)).toMatchObject({
        errcode: 'M_UNKNOWN_TOKEN',
        status: 401,
      });
      expect(userRes).toBe('user-ok');
      expect(next).toHaveBeenCalledOnce();
      expect(userCtx.get('userId')).toBe(`@alice_${i}:${AUTH_SERVER}`);
      expect(userCtx.get('deviceId')).toBe(`D${i}`);
      expect(throwCtx.get('userId')).toBeUndefined();
    });
  }
});

// ===========================================================================
// AUTH — namespaces JSON '[]' skip gate ∥ restrictive deny
// ===========================================================================

describe('race nonary auth namespaces JSON array skip after #312', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`namespaces '[]' skip ∥ restrictive deny flood-${i}`, async () => {
      const tokSkip = `as_ns_arr_${i}`;
      const tokDeny = `as_ns_deny_${i}`;
      const localUser = `@anyone_${i}:${AUTH_SERVER}`;

      const dbSkip = createAuthDb({
        appservices: new Map([
          [
            tokSkip,
            asRow({
              as_token: tokSkip,
              sender_localpart: 'arrns',
              // JSON.parse('[]') → []; namespaces?.users → undefined → gate skipped
              namespaces: '[]',
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

      const skipCtx = makeAuthCtx({
        db: dbSkip,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${tokSkip}` },
      });
      const denyCtx = makeAuthCtx({
        db: dbDeny,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${tokDeny}` },
      });

      const [skipRes, denyRes] = await Promise.all([
        realRequireAuth()(skipCtx, vi.fn(async () => 'skip')),
        realRequireAuth()(denyCtx, vi.fn()),
      ]);

      expect(skipRes).toBe('skip');
      expect(skipCtx.get('userId')).toBe(localUser);
      expect(await jsonBody(denyRes as Response)).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'User not in application service namespace',
        status: 403,
      });
      expect(denyCtx.get('userId')).toBeUndefined();
    });
  }
});
