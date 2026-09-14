/**
 * TOKENMAXX HEAVY leftovers after #319 — denary *filters + appservice + auth*
 * concurrent-race niches not covered by nonary (#319), octonary (#312),
 * septenary (#304), senary (#292), or quinary (#286) floods.
 *
 * Gap table (why leftover after #319 nonary):
 *   Filters false/0/""/-1 mint + TTL ∥ carol forbid
 *     | nonary null∥true∥42∥"str"; never false/0/empty-string/-1 in this series
 *   Filters empty-string GET ∥ missing {} ∥ carol read-forbid soft
 *     | nonary mega POST→GET object; never stored "" under forbid race
 *   isExclusiveAppServiceAlias empty miss ∥ exclusive hit
 *     | nonary exclusive USER users:null; never exclusive ALIAS race twin
 *   aliases-only interest never matches (aliases ignored by getInterested)
 *     | octonary aliases:null exclusive; never interest-path aliases-only
 *   protocols '42'/'-1'/'"str"' ByToken∥list quirks
 *     | nonary true/0/1; octonary null/[]/false; never number/-1/JSON-string
 *   HTTP 202 ok ∥ 302/404/500 retry under race
 *     | nonary 201∥100/199/301; octonary 299∥300; never 202/302/404/500 here
 *   Auth protocols '0'/'1'/'42' under requireAuth
 *     | nonary false/true; octonary null/[]; never numeric JSON strings
 *   Auth namespaces 'null'/'{}' skip gate ∥ restrictive deny
 *     | nonary '[]'; never JSON-null / empty-object under this series
 *   Auth AS deviceId null ∥ user-token deviceId set under race
 *     | nonary throwOnAs∥user success never pinned AS deviceId:null
 *   Auth M_UNKNOWN_TOKEN ∥ AS default sender (no user_id) soft
 *     | nonary missing-token∥AS-with-user_id; never unknown∥default-sender
 *
 * Distinct from #319 nonary, #312 octonary, #304 septenary, #292 senary.
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
  isExclusiveAppServiceAlias,
  sendAppServiceTransaction,
} from '../src/services/appservice';
import { extractAccessToken } from '../src/middleware/auth';
import { hashToken } from '../src/utils/crypto';

// Real requireAuth loaded via importActual in auth suites below
// (filter routes use the mocked requireAuth from vi.mock).

// ---------------------------------------------------------------------------
// Filters harness (mocked requireAuth — mirrors nonary/octonary series)
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
// FILTERS — false / 0 / "" / -1 primitive bodies + TTL ∥ carol create-forbid
// ===========================================================================

describe('race denary filter false/0/empty/-1 body + TTL soft after #319', () => {
  for (let i = 0; i < 12; i++) {
    it(`false∥0∥""∥-1 mint + TTL ∥ carol forbid flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const putsBefore = cache.putCount;

      const [falseOk, zeroOk, emptyOk, negOk, forbid] = await Promise.all([
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: 'false',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '0',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '""',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '-1',
        }),
        request(env, filterCollection(CAROL_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: JSON.stringify(sampleFilter(i)),
        }),
      ]);

      expect(falseOk.status).toBe(200);
      expect(zeroOk.status).toBe(200);
      expect(emptyOk.status).toBe(200);
      expect(negOk.status).toBe(200);
      expect(forbid.status).toBe(403);
      expect(forbid.body).toEqual({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot create filters for other users',
      });

      const ids = [
        (falseOk.body as { filter_id: string }).filter_id,
        (zeroOk.body as { filter_id: string }).filter_id,
        (emptyOk.body as { filter_id: string }).filter_id,
        (negOk.body as { filter_id: string }).filter_id,
      ];
      expect(new Set(ids).size).toBe(4);
      expect(cache.putCount - putsBefore).toBe(4);

      expect(JSON.parse(cache.data[`filter:${USER}:${ids[0]}`]!)).toBe(false);
      expect(JSON.parse(cache.data[`filter:${USER}:${ids[1]}`]!)).toBe(0);
      expect(JSON.parse(cache.data[`filter:${USER}:${ids[2]}`]!)).toBe('');
      expect(JSON.parse(cache.data[`filter:${USER}:${ids[3]}`]!)).toBe(-1);

      for (const p of cache.puts.slice(putsBefore)) {
        expect(p.options?.expirationTtl).toBe(FILTER_TTL);
        expect(p.key.startsWith(`filter:${USER}:`)).toBe(true);
      }
      expect(Object.keys(cache.data).some((k) => k.includes(CAROL))).toBe(false);
    });
  }
});

// ===========================================================================
// FILTERS — empty-string GET ∥ missing {} ∥ carol read-forbid soft
// ===========================================================================

describe('race denary filter empty-string GET soft after #319', () => {
  for (let i = 0; i < 10; i++) {
    it(`stored "" ∥ missing {} ∥ carol forbid never mix flood-${i}`, async () => {
      const emptyId = `empty_${i}`;
      const cache = mockCache({
        [`filter:${USER}:${emptyId}`]: '""',
        [`filter:${CAROL}:seed_${i}`]: JSON.stringify(sampleFilter(i)),
      });
      const env = createEnv(cache);
      const getsBefore = cache.getCount;

      const [emptyGet, missing, readForbid] = await Promise.all([
        request(env, filterPath(emptyId), { method: 'GET', headers: { ...AUTH } }),
        request(env, filterPath(`missing_${i}`), { method: 'GET', headers: { ...AUTH } }),
        request(env, filterPath(`seed_${i}`, CAROL_ENC), {
          method: 'GET',
          headers: { ...AUTH },
        }),
      ]);

      expect(emptyGet.status).toBe(200);
      expect(emptyGet.body).toBe('');
      expect(missing.status).toBe(200);
      expect(missing.body).toEqual({});
      expect(readForbid.status).toBe(403);
      expect(readForbid.body).toEqual({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot read filters for other users',
      });

      // Soft shapes never bleed; forbid never touches CACHE
      expect(emptyGet.body).not.toEqual({});
      expect(missing.body).not.toBe('');
      expect((readForbid.body as { error: string }).error).not.toBe('Invalid JSON');
      expect(cache.getCount - getsBefore).toBe(2);
      expect(cache.putCount).toBe(0);
    });
  }
});

// ===========================================================================
// APPSERVICE — exclusive ALIAS empty miss ∥ hit
// ===========================================================================

describe('race denary appservice exclusive alias miss∥hit after #319', () => {
  for (let i = 0; i < 10; i++) {
    it(`empty miss ∥ plain miss ∥ exclusive alias hit flood-${i}`, async () => {
      const empty = registration('empty_ea', {
        users: [],
        rooms: [],
        aliases: [],
      });
      const hit = registration('hit_ea', {
        users: [],
        rooms: [],
        aliases: [
          {
            exclusive: true,
            regex: `^#_bot_.*:${AS_ESC}$`,
          },
        ],
      });
      const alias = `#_bot_denary_${i}:${AS_SERVER}`;
      const plain = `#room_${i}:${AS_SERVER}`;

      const [missEmpty, missPlain, matched] = await Promise.all([
        Promise.resolve(isExclusiveAppServiceAlias([empty], alias)),
        Promise.resolve(isExclusiveAppServiceAlias([hit], plain)),
        Promise.resolve(isExclusiveAppServiceAlias([hit], alias)),
      ]);

      expect(missEmpty).toBeNull();
      expect(missPlain).toBeNull();
      expect(matched?.id).toBe('hit_ea');

      // empty first then hit still matches
      const mixed = isExclusiveAppServiceAlias([empty, hit], alias);
      expect(mixed?.id).toBe('hit_ea');
    });
  }
});

// ===========================================================================
// APPSERVICE — aliases-only interest never matches
// ===========================================================================

describe('race denary appservice aliases-only interest ignore after #319', () => {
  for (let i = 0; i < 10; i++) {
    it(`aliases-only never interests ∥ room ns does flood-${i}`, async () => {
      const aliasOnly = registration('alias_only', {
        users: [],
        rooms: [],
        aliases: [
          {
            exclusive: true,
            regex: `^#_bridge_.*:${AS_ESC}$`,
          },
        ],
      });
      const roomHit = registration('room_hit', {
        users: [],
        rooms: [
          {
            exclusive: false,
            regex: `^!soft_.*:${AS_ESC}$`,
          },
        ],
        aliases: [],
      });
      const roomId = `!soft_denary_${i}:${AS_SERVER}`;
      const event = {
        room_id: roomId,
        sender: `@alice_${i}:${AS_SERVER}`,
        type: 'm.room.message',
      };

      const [aliasInterest, roomInterest, both] = await Promise.all([
        Promise.resolve(getInterestedAppServices([aliasOnly], event)),
        Promise.resolve(getInterestedAppServices([roomHit], event)),
        Promise.resolve(getInterestedAppServices([aliasOnly, roomHit], event)),
      ]);

      expect(aliasInterest).toEqual([]);
      expect(roomInterest.map((a) => a.id)).toEqual(['room_hit']);
      expect(both.map((a) => a.id)).toEqual(['room_hit']);
    });
  }
});

// ===========================================================================
// APPSERVICE — protocols '42' / '-1' / '"str"' ByToken∥list
// ===========================================================================

describe('race denary appservice protocols 42/-1/str JSON after #319', () => {
  for (let i = 0; i < 10; i++) {
    it(`'42'→42 ∥ '-1'→-1 ∥ '"str"'→str ByToken∥list flood-${i}`, async () => {
      const fortyTwo = asRow({
        id: `p42_${i}`,
        as_token: `tok_p42_${i}`,
        sender_localpart: 'p42',
        protocols: '42',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const negOne = asRow({
        id: `pn_${i}`,
        as_token: `tok_pn_${i}`,
        sender_localpart: 'pn',
        protocols: '-1',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const strProto = asRow({
        id: `ps_${i}`,
        as_token: `tok_ps_${i}`,
        sender_localpart: 'ps',
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

      const [by42, byNeg, byStr, bySql, list] = await Promise.all([
        getAppServiceByToken(createListDb([fortyTwo]), `tok_p42_${i}`),
        getAppServiceByToken(createListDb([negOne]), `tok_pn_${i}`),
        getAppServiceByToken(createListDb([strProto]), `tok_ps_${i}`),
        getAppServiceByToken(createListDb([sqlNull]), `tok_pz_${i}`),
        getAppServices(createListDb([fortyTwo, negOne, strProto, sqlNull])),
      ]);

      expect(by42?.protocols).toBe(42);
      expect(byNeg?.protocols).toBe(-1);
      expect(byStr?.protocols).toBe('irc');
      expect(bySql?.protocols).toEqual([]);
      expect(list.map((a) => a.protocols)).toEqual([42, -1, 'irc', []]);
    });
  }
});

// ===========================================================================
// APPSERVICE — HTTP 202 ok ∥ 302/404/500 retry under race
// ===========================================================================

describe('race denary appservice HTTP 202∥302/404/500 after #319', () => {
  const NOW = 1_700_000_700_000;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  function createTxnDb(startRowId = 900) {
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
    it(`202 → sent_at ∥ 302∥404∥500 → retry under parallel flood-${i}`, async () => {
      const okDb = createTxnDb(900 + i * 4);
      const r302 = createTxnDb(910 + i * 4);
      const r404 = createTxnDb(920 + i * 4);
      const r500 = createTxnDb(930 + i * 4);
      const okAs = registration(
        'ok202',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://ok202.example.com' }
      );
      const as302 = registration(
        'r302',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r302.example.com' }
      );
      const as404 = registration(
        'r404',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r404.example.com' }
      );
      const as500 = registration(
        'r500',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://r500.example.com' }
      );

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const u = String(url);
          if (u.includes('ok202.example.com')) return new Response('{}', { status: 202 });
          if (u.includes('r302.example.com')) return new Response('redirect', { status: 302 });
          if (u.includes('r404.example.com')) return new Response('missing', { status: 404 });
          return new Response('boom', { status: 500 });
        })
      );

      const [ok, a, b, c] = await Promise.all([
        sendAppServiceTransaction(okDb, okAs, [{ n: i }]),
        sendAppServiceTransaction(r302, as302, [{ n: i }]),
        sendAppServiceTransaction(r404, as404, [{ n: i }]),
        sendAppServiceTransaction(r500, as500, [{ n: i }]),
      ]);

      expect(ok).toBe(true);
      expect(a).toBe(false);
      expect(b).toBe(false);
      expect(c).toBe(false);
      expect(okDb.updates.map((u) => u.kind)).toEqual(['sent']);
      expect(r302.updates.map((u) => u.kind)).toEqual(['retry']);
      expect(r404.updates.map((u) => u.kind)).toEqual(['retry']);
      expect(r500.updates.map((u) => u.kind)).toEqual(['retry']);
      expect(okDb.updates.some((u) => u.kind === 'retry')).toBe(false);
    });
  }
});

// ===========================================================================
// AUTH — protocols '0'/'1'/'42' under requireAuth
// ===========================================================================

describe('race denary auth protocols 0/1/42 JSON under requireAuth after #319', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 8; i++) {
    it(`protocols '0'∥'1'∥'42' allow ∥ ' ' unknown flood-${i}`, async () => {
      const tok0 = `as_proto_0_${i}`;
      const tok1 = `as_proto_1_${i}`;
      const tok42 = `as_proto_42_${i}`;
      const tokWs = `as_proto_w_${i}`;
      const db0 = createAuthDb({
        appservices: new Map([
          [
            tok0,
            asRow({
              as_token: tok0,
              sender_localpart: 'zero',
              protocols: '0',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
        ]),
      });
      const db1 = createAuthDb({
        appservices: new Map([
          [
            tok1,
            asRow({
              as_token: tok1,
              sender_localpart: 'one',
              protocols: '1',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
        ]),
      });
      const db42 = createAuthDb({
        appservices: new Map([
          [
            tok42,
            asRow({
              as_token: tok42,
              sender_localpart: 'fortytwo',
              protocols: '42',
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

      const ctx0 = makeAuthCtx({
        db: db0,
        headers: { Authorization: `Bearer ${tok0}` },
      });
      const ctx1 = makeAuthCtx({
        db: db1,
        headers: { Authorization: `Bearer ${tok1}` },
      });
      const ctx42 = makeAuthCtx({
        db: db42,
        headers: { Authorization: `Bearer ${tok42}` },
      });
      const ctxWs = makeAuthCtx({
        db: dbWs,
        headers: { Authorization: `Bearer ${tokWs}` },
      });

      const [res0, res1, res42, wsRes] = await Promise.all([
        realRequireAuth()(ctx0, vi.fn(async () => 'zero')),
        realRequireAuth()(ctx1, vi.fn(async () => 'one')),
        realRequireAuth()(ctx42, vi.fn(async () => 'fortytwo')),
        realRequireAuth()(ctxWs, vi.fn()),
      ]);

      expect(res0).toBe('zero');
      expect(ctx0.get('userId')).toBe(`@zero:${AUTH_SERVER}`);
      expect(res1).toBe('one');
      expect(ctx1.get('userId')).toBe(`@one:${AUTH_SERVER}`);
      expect(res42).toBe('fortytwo');
      expect(ctx42.get('userId')).toBe(`@fortytwo:${AUTH_SERVER}`);
      expect(await jsonBody(wsRes as Response)).toMatchObject({
        errcode: 'M_UNKNOWN_TOKEN',
        status: 401,
      });
    });
  }
});

// ===========================================================================
// AUTH — namespaces JSON 'null'/'{}' skip gate ∥ restrictive deny
// ===========================================================================

describe('race denary auth namespaces null/{} skip after #319', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`namespaces 'null'∥'{}' skip ∥ restrictive deny flood-${i}`, async () => {
      const tokNull = `as_ns_null_${i}`;
      const tokObj = `as_ns_obj_${i}`;
      const tokDeny = `as_ns_deny_${i}`;
      const localUser = `@anyone_${i}:${AUTH_SERVER}`;

      const dbNull = createAuthDb({
        appservices: new Map([
          [
            tokNull,
            asRow({
              as_token: tokNull,
              sender_localpart: 'nullns',
              // JSON.parse('null') → null → namespaces?.users → undefined → gate skipped
              namespaces: 'null',
            }),
          ],
        ]),
      });
      const dbObj = createAuthDb({
        appservices: new Map([
          [
            tokObj,
            asRow({
              as_token: tokObj,
              sender_localpart: 'objns',
              // JSON.parse('{}') → {} → users undefined → gate skipped
              namespaces: '{}',
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

      const nullCtx = makeAuthCtx({
        db: dbNull,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${tokNull}` },
      });
      const objCtx = makeAuthCtx({
        db: dbObj,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${tokObj}` },
      });
      const denyCtx = makeAuthCtx({
        db: dbDeny,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${tokDeny}` },
      });

      const [nullRes, objRes, denyRes] = await Promise.all([
        realRequireAuth()(nullCtx, vi.fn(async () => 'null-skip')),
        realRequireAuth()(objCtx, vi.fn(async () => 'obj-skip')),
        realRequireAuth()(denyCtx, vi.fn()),
      ]);

      expect(nullRes).toBe('null-skip');
      expect(nullCtx.get('userId')).toBe(localUser);
      expect(objRes).toBe('obj-skip');
      expect(objCtx.get('userId')).toBe(localUser);
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
// AUTH — AS deviceId null ∥ user-token deviceId set under race
// ===========================================================================

describe('race denary auth AS deviceId null ∥ user deviceId after #319', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`AS deviceId null ∥ user deviceId set under race flood-${i}`, async () => {
      const asTok = `as_devnull_${i}`;
      const userTok = `syt_denary_user_${i}`;
      const hash = await hashToken(userTok);
      const asDb = createAuthDb({
        appservices: new Map([
          [
            asTok,
            asRow({
              as_token: asTok,
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
      const userDb = createAuthDb({
        tokens: new Map([
          [hash, { user_id: `@alice_${i}:${AUTH_SERVER}`, device_id: `DEV_${i}` }],
        ]),
      });

      const asCtx = makeAuthCtx({
        db: asDb,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(
          `@_bridge_ok_${i}:${AUTH_SERVER}`
        )}`,
        headers: { Authorization: `Bearer ${asTok}` },
      });
      const userCtx = makeAuthCtx({
        db: userDb,
        headers: { Authorization: `Bearer ${userTok}` },
      });
      const asNext = vi.fn(async () => 'as-ok');
      const userNext = vi.fn(async () => 'user-ok');

      const [asRes, userRes] = await Promise.all([
        realRequireAuth()(asCtx, asNext),
        realRequireAuth()(userCtx, userNext),
      ]);

      expect(asRes).toBe('as-ok');
      expect(asNext).toHaveBeenCalledOnce();
      expect(asCtx.get('userId')).toBe(`@_bridge_ok_${i}:${AUTH_SERVER}`);
      expect(asCtx.get('deviceId')).toBeNull();
      expect(userRes).toBe('user-ok');
      expect(userNext).toHaveBeenCalledOnce();
      expect(userCtx.get('userId')).toBe(`@alice_${i}:${AUTH_SERVER}`);
      expect(userCtx.get('deviceId')).toBe(`DEV_${i}`);
    });
  }
});

// ===========================================================================
// AUTH — M_UNKNOWN_TOKEN ∥ AS default sender (no user_id) soft
// ===========================================================================

describe('race denary auth unknown-token ∥ AS default sender soft after #319', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`M_UNKNOWN_TOKEN ∥ AS default sender never mix flood-${i}`, async () => {
      const tok = `as_den_default_${i}`;
      const db = createAuthDb({
        appservices: new Map([
          [
            tok,
            asRow({
              as_token: tok,
              sender_localpart: 'bridge',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
        ]),
      });

      const unknown = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer not_a_real_token_${i}` },
      });
      const ok = makeAuthCtx({
        db,
        // no user_id → default `@${sender_localpart}:${server}`
        url: `https://${AUTH_SERVER}/sync`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const next = vi.fn(async () => 'ok');

      expect(
        extractAccessToken(
          new Request(`https://${AUTH_SERVER}/sync`, {
            headers: { Authorization: `Bearer not_a_real_token_${i}` },
          })
        )
      ).toBe(`not_a_real_token_${i}`);

      const [unkRes, okRes] = await Promise.all([
        realRequireAuth()(unknown, vi.fn()),
        realRequireAuth()(ok, next),
      ]);

      const unkBody = await jsonBody(unkRes as Response);
      expect(unkBody).toMatchObject({
        errcode: 'M_UNKNOWN_TOKEN',
        status: 401,
      });
      expect(okRes).toBe('ok');
      expect(next).toHaveBeenCalledOnce();
      expect(ok.get('userId')).toBe(`@bridge:${AUTH_SERVER}`);
      expect(ok.get('deviceId')).toBeNull();
      expect(unknown.get('userId')).toBeUndefined();
      // Soft strings never bleed
      expect(unkBody.error).not.toBe('Missing access token');
      expect(unkBody.error).not.toContain('application service');
    });
  }
});
