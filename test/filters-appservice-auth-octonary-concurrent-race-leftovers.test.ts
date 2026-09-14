/**
 * TOKENMAXX HEAVY leftovers after #304 — octonary *filters + appservice + auth*
 * concurrent-race niches not covered by septenary (#304), senary (#292), or
 * quinary (#286) floods.
 *
 * Gap table (why leftover after #304 septenary):
 *   Filters empty {} ∥ array [] ∥ nested mint ∥ carol create-forbid
 *     | septenary soft-quad used sampleFilter objects only; never body-shape mix
 *   Dual-mint distinct IDs ∥ Invalid JSON ∥ carol GET forbid
 *     | septenary soft-quad had single mint; never dual-mint uniqueness under forbid
 *   POST→GET same-flight roundtrip ∥ corrupt→{} ∥ missing→{}
 *     | septenary GET suite pre-seeded only; never mint-then-read under race
 *   users:null throws interest ∥ empty-users sibling hit
 *     | septenary rooms:null; never users:null
 *   aliases:null exclusive throw ∥ interest ignores aliases:null
 *     | residual alias-ns ignored; never null aliases under exclusive∥interest
 *   protocols 'null'/'[]'/'false' ByToken∥list quirks
 *     | septenary '{}'; senary ' '/''; quinary ['irc']; never JSON-null/false/[]
 *   HTTP 299 ok ∥ 300 retry under race
 *     | quaternary appservice-api series; never this filters+appservice+auth file
 *   Auth AS query access_token soft forbid quad
 *     | septenary Bearer-only soft-quad
 *   Auth protocols 'null'/'[]' allow ∥ ' ' unknown
 *     | septenary '{}' object under requireAuth
 *   Auth special localpart _=.+/- allow ∥ @Bot uppercase forbid
 *     | auth-middleware series; never this niche file under race
 *   Auth users:null gate skip ∥ users:[] skip ∥ array deny
 *     | auth residual; never under filters-appservice octonary flood
 *
 * Distinct from #304 septenary, #292 senary, #286 quinary, #276 quaternary.
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

// Real requireAuth/optionalAuth loaded via importActual in auth suites below
// (filter routes use the mocked requireAuth from vi.mock).

// ---------------------------------------------------------------------------
// Filters harness (mocked requireAuth — mirrors septenary/quinary series)
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
// FILTERS — empty {} ∥ array [] ∥ nested mint ∥ carol create-forbid
// ===========================================================================

describe('race octonary filter body-shape soft after #304', () => {
  for (let i = 0; i < 12; i++) {
    it(`{} ∥ [] ∥ nested ∥ carol forbid never mix flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const putsBefore = cache.putCount;
      const nested = { room: { timeline: { limit: i }, state: { types: [`m.room.member_${i}`] } } };

      const [emptyOk, arrOk, nestedOk, forbid] = await Promise.all([
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '{}',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '[]',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: JSON.stringify(nested),
        }),
        request(env, filterCollection(CAROL_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: JSON.stringify(sampleFilter(i)),
        }),
      ]);

      expect(emptyOk.status).toBe(200);
      expect(arrOk.status).toBe(200);
      expect(nestedOk.status).toBe(200);
      expect(forbid.status).toBe(403);
      expect(forbid.body).toEqual({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot create filters for other users',
      });

      const emptyFid = (emptyOk.body as { filter_id: string }).filter_id;
      const arrFid = (arrOk.body as { filter_id: string }).filter_id;
      const nestedFid = (nestedOk.body as { filter_id: string }).filter_id;
      expect(new Set([emptyFid, arrFid, nestedFid]).size).toBe(3);
      for (const fid of [emptyFid, arrFid, nestedFid]) {
        expect(fid).toMatch(/^[0-9a-f]+$/);
        expect(fid).not.toContain('-');
      }

      // Only three self-mints put; carol forbid short-circuits
      expect(cache.putCount - putsBefore).toBe(3);
      expect(JSON.parse(cache.data[`filter:${USER}:${emptyFid}`]!)).toEqual({});
      expect(JSON.parse(cache.data[`filter:${USER}:${arrFid}`]!)).toEqual([]);
      expect(JSON.parse(cache.data[`filter:${USER}:${nestedFid}`]!)).toEqual(nested);
      expect(Object.keys(cache.data).some((k) => k.includes(CAROL))).toBe(false);
    });
  }
});

describe('race octonary filter dual-mint ∥ bad-JSON ∥ read-forbid after #304', () => {
  for (let i = 0; i < 10; i++) {
    it(`2 distinct mints ∥ Invalid JSON ∥ carol GET forbid flood-${i}`, async () => {
      const cache = mockCache({
        [`filter:${CAROL}:seed_${i}`]: JSON.stringify(sampleFilter(i)),
      });
      const env = createEnv(cache);
      const putsBefore = cache.putCount;

      const [a, b, badJson, forbid] = await Promise.all([
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: JSON.stringify(sampleFilter(i)),
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: JSON.stringify(sampleFilter(i + 50)),
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '{not-json',
        }),
        request(env, filterPath(`seed_${i}`, CAROL_ENC), {
          method: 'GET',
          headers: { ...AUTH },
        }),
      ]);

      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(badJson.status).toBe(400);
      expect(badJson.body).toEqual({
        errcode: 'M_BAD_JSON',
        error: 'Invalid JSON',
      });
      expect(forbid.status).toBe(403);
      expect(forbid.body).toEqual({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot read filters for other users',
      });

      const idA = (a.body as { filter_id: string }).filter_id;
      const idB = (b.body as { filter_id: string }).filter_id;
      expect(idA).not.toBe(idB);
      expect(cache.putCount - putsBefore).toBe(2);
      expect((forbid.body as { error: string }).error).not.toBe('Invalid JSON');
      expect(a.body).not.toHaveProperty('errcode');
      expect(b.body).not.toHaveProperty('errcode');
    });
  }
});

describe('race octonary filter POST→GET same-flight after #304', () => {
  for (let i = 0; i < 10; i++) {
    it(`mint→GET roundtrip ∥ corrupt→{} ∥ missing→{} flood-${i}`, async () => {
      const cache = mockCache({
        [`filter:${USER}:corrupt_${i}`]: '{not-json',
      });
      const env = createEnv(cache);
      const payload = sampleFilter(i + 7);

      const mint = await request(env, filterCollection(USER_ENC), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: JSON.stringify(payload),
      });
      expect(mint.status).toBe(200);
      const fid = (mint.body as { filter_id: string }).filter_id;

      const getsBefore = cache.getCount;
      const [roundtrip, corrupt, missing] = await Promise.all([
        request(env, filterPath(fid), { method: 'GET', headers: { ...AUTH } }),
        request(env, filterPath(`corrupt_${i}`), { method: 'GET', headers: { ...AUTH } }),
        request(env, filterPath(`missing_oct_${i}`), { method: 'GET', headers: { ...AUTH } }),
      ]);

      expect(roundtrip.status).toBe(200);
      expect(roundtrip.body).toEqual(payload);
      expect(corrupt.status).toBe(200);
      expect(corrupt.body).toEqual({});
      expect(missing.status).toBe(200);
      expect(missing.body).toEqual({});
      expect(cache.getCount - getsBefore).toBe(3);
      // Soft {} never gains errcode from siblings
      expect(corrupt.body).not.toHaveProperty('errcode');
      expect(missing.body).not.toHaveProperty('errcode');
      expect(roundtrip.body).not.toHaveProperty('errcode');
    });
  }
});

// ===========================================================================
// APPSERVICE — users:null throw ∥ empty-users sibling hit
// ===========================================================================

describe('race octonary appservice users:null throw after #304', () => {
  for (let i = 0; i < 10; i++) {
    it(`users:null throw ∥ empty-users room sibling hit flood-${i}`, async () => {
      const broken = registration('broken_u', {
        users: null as unknown as AppServiceRegistration['namespaces']['users'],
        rooms: [{ exclusive: false, regex: `^!soft_.*:${AS_ESC}$` }],
        aliases: [],
      });
      const ok = registration('ok_u', {
        users: [],
        rooms: [{ exclusive: false, regex: `^!soft_.*:${AS_ESC}$` }],
        aliases: [],
      });
      const roomId = `!soft_room_${i}:${AS_SERVER}`;

      const [thrown, hit, miss] = await Promise.all([
        Promise.resolve()
          .then(() =>
            getInterestedAppServices([broken], {
              room_id: roomId,
              sender: `@alice_${i}:${AS_SERVER}`,
              type: 'm.room.message',
            })
          )
          .then((v) => ({ ok: true as const, v }))
          .catch((e) => ({ ok: false as const, err: e })),
        Promise.resolve(
          getInterestedAppServices([ok], {
            room_id: roomId,
            sender: `@alice_${i}:${AS_SERVER}`,
            type: 'm.room.message',
          })
        ),
        Promise.resolve(
          getInterestedAppServices([ok], {
            room_id: `!plain_${i}:${AS_SERVER}`,
            sender: `@alice_${i}:${AS_SERVER}`,
            type: 'm.room.message',
          })
        ),
      ]);

      expect(thrown.ok).toBe(false);
      expect(hit.map((a) => a.id)).toEqual(['ok_u']);
      expect(miss).toEqual([]);

      // Mixed list: broken first still throws before ok is reached
      const mixed = await Promise.resolve()
        .then(() =>
          getInterestedAppServices([broken, ok], {
            room_id: roomId,
            sender: `@alice_${i}:${AS_SERVER}`,
            type: 'm.room.message',
          })
        )
        .then((v) => ({ ok: true as const, v }))
        .catch((e) => ({ ok: false as const, err: e }));
      expect(mixed.ok).toBe(false);
    });
  }
});

// ===========================================================================
// APPSERVICE — aliases:null exclusive throw ∥ interest ignores aliases
// ===========================================================================

describe('race octonary appservice aliases:null exclusive∥interest after #304', () => {
  for (let i = 0; i < 10; i++) {
    it(`exclusive aliases:null throw ∥ interest ignores aliases:null flood-${i}`, async () => {
      const brokenAlias = registration('broken_a', {
        users: [],
        rooms: [],
        aliases: null as unknown as AppServiceRegistration['namespaces']['aliases'],
      });
      const roomHit = registration('room_hit', {
        users: [],
        rooms: [{ exclusive: false, regex: `^!portal_.*:${AS_ESC}$` }],
        aliases: null as unknown as AppServiceRegistration['namespaces']['aliases'],
      });
      const alias = `#_bridge_${i}:${AS_SERVER}`;
      const roomId = `!portal_${i}:${AS_SERVER}`;

      const [exclThrown, interestOk, interestMiss] = await Promise.all([
        Promise.resolve()
          .then(() => isExclusiveAppServiceAlias([brokenAlias], alias))
          .then((v) => ({ ok: true as const, v }))
          .catch((e) => ({ ok: false as const, err: e })),
        Promise.resolve(
          getInterestedAppServices([roomHit], {
            room_id: roomId,
            sender: `@alice_${i}:${AS_SERVER}`,
            type: 'm.room.message',
          })
        ),
        Promise.resolve(
          getInterestedAppServices([brokenAlias], {
            room_id: `!plain_${i}:${AS_SERVER}`,
            sender: `@alice_${i}:${AS_SERVER}`,
            type: 'm.room.message',
          })
        ),
      ]);

      expect(exclThrown.ok).toBe(false);
      // getInterested never walks aliases — aliases:null is fine when users/rooms ok
      expect(interestOk.map((a) => a.id)).toEqual(['room_hit']);
      expect(interestMiss).toEqual([]);
    });
  }
});

// ===========================================================================
// APPSERVICE — protocols 'null' / '[]' / 'false' ByToken∥list
// ===========================================================================

describe('race octonary appservice protocols null/[]/false JSON after #304', () => {
  for (let i = 0; i < 10; i++) {
    it(`'null'→null ∥ '[]'→[] ∥ 'false'→false ByToken∥list flood-${i}`, async () => {
      const nullJson = asRow({
        id: `pn_${i}`,
        as_token: `tok_pn_${i}`,
        sender_localpart: 'pn',
        // truthy string "null" → JSON.parse → null (≠ SQL-null → [])
        protocols: 'null',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const emptyArr = asRow({
        id: `pa_${i}`,
        as_token: `tok_pa_${i}`,
        sender_localpart: 'pa',
        protocols: '[]',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const falsy = asRow({
        id: `pf_${i}`,
        as_token: `tok_pf_${i}`,
        sender_localpart: 'pf',
        protocols: 'false',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const sqlNull = asRow({
        id: `ps_${i}`,
        as_token: `tok_ps_${i}`,
        sender_localpart: 'ps',
        protocols: null,
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });

      const [byNull, byArr, byFalse, bySql, list] = await Promise.all([
        getAppServiceByToken(createListDb([nullJson]), `tok_pn_${i}`),
        getAppServiceByToken(createListDb([emptyArr]), `tok_pa_${i}`),
        getAppServiceByToken(createListDb([falsy]), `tok_pf_${i}`),
        getAppServiceByToken(createListDb([sqlNull]), `tok_ps_${i}`),
        getAppServices(createListDb([nullJson, emptyArr, falsy, sqlNull])),
      ]);

      expect(byNull?.protocols).toBeNull();
      expect(byArr?.protocols).toEqual([]);
      expect(Array.isArray(byArr?.protocols)).toBe(true);
      expect(byFalse?.protocols).toBe(false);
      expect(bySql?.protocols).toEqual([]);

      expect(list.map((a) => a.protocols)).toEqual([null, [], false, []]);
    });
  }
});

// ===========================================================================
// APPSERVICE — HTTP 299 ok ∥ 300 retry under race
// ===========================================================================

describe('race octonary appservice HTTP 299∥300 after #304', () => {
  const NOW = 1_700_000_500_000;

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
    it(`299 → sent_at ∥ 300 → retry under parallel flood-${i}`, async () => {
      const okDb = createTxnDb(900 + i * 2);
      const retryDb = createTxnDb(950 + i * 2);
      const okAs = registration(
        'ok299',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://ok299.example.com' }
      );
      const retryAs = registration(
        'retry300',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://retry300.example.com' }
      );

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (String(url).includes('ok299.example.com')) {
            return new Response('{}', { status: 299 });
          }
          return new Response('redirect', { status: 300 });
        })
      );

      const [ok, retry] = await Promise.all([
        sendAppServiceTransaction(okDb, okAs, [{ n: i }]),
        sendAppServiceTransaction(retryDb, retryAs, [{ n: i }]),
      ]);

      expect(ok).toBe(true);
      expect(retry).toBe(false);
      expect(okDb.updates.map((u) => u.kind)).toEqual(['sent']);
      expect(retryDb.updates.map((u) => u.kind)).toEqual(['retry']);
      expect(okDb.updates.some((u) => u.kind === 'retry')).toBe(false);
      expect(retryDb.updates.some((u) => u.kind === 'sent')).toBe(false);
    });
  }
});

// ===========================================================================
// AUTH — AS query access_token soft forbid quad (septenary was Bearer-only)
// ===========================================================================

describe('race octonary auth AS query soft forbid quad after #304', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 12; i++) {
    it(`query Invalid format∥impersonate∥ns deny∥AS success flood-${i}`, async () => {
      const tok = `as_oct_q_${i}`;
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

      const badFmt = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(tok)}&user_id=${encodeURIComponent('@Bad')}`,
        headers: {},
      });
      const foreign = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(tok)}&user_id=${encodeURIComponent(
          `@_bridge_x_${i}:other.example.com`
        )}`,
        headers: {},
      });
      const outOfNs = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(tok)}&user_id=${encodeURIComponent(
          `@alice_${i}:${AUTH_SERVER}`
        )}`,
        headers: {},
      });
      const ok = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(tok)}&user_id=${encodeURIComponent(
          `@_bridge_ok_${i}:${AUTH_SERVER}`
        )}`,
        headers: {},
      });
      const next = vi.fn(async () => 'ok');

      // extractAccessToken falls through to query when no Authorization
      expect(
        extractAccessToken(
          new Request(
            `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(tok)}`
          )
        )
      ).toBe(tok);

      const [fmtRes, foreignRes, nsRes, okRes] = await Promise.all([
        realRequireAuth()(badFmt, vi.fn()),
        realRequireAuth()(foreign, vi.fn()),
        realRequireAuth()(outOfNs, vi.fn()),
        realRequireAuth()(ok, next),
      ]);

      const fmtBody = await jsonBody(fmtRes as Response);
      const foreignBody = await jsonBody(foreignRes as Response);
      const nsBody = await jsonBody(nsRes as Response);

      expect(fmtBody).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Invalid user_id format',
        status: 403,
      });
      expect(foreignBody).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot impersonate users on other servers',
        status: 403,
      });
      expect(nsBody).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'User not in application service namespace',
        status: 403,
      });

      const errs = [fmtBody.error, foreignBody.error, nsBody.error];
      expect(new Set(errs).size).toBe(3);

      expect(okRes).toBe('ok');
      expect(next).toHaveBeenCalledOnce();
      expect(ok.get('userId')).toBe(`@_bridge_ok_${i}:${AUTH_SERVER}`);
      expect(ok.get('deviceId')).toBeNull();
      expect(badFmt.get('userId')).toBeUndefined();
      expect(foreign.get('userId')).toBeUndefined();
      expect(outOfNs.get('userId')).toBeUndefined();
    });
  }
});

// ===========================================================================
// AUTH — protocols 'null'/'[]' allow ∥ ' ' unknown
// ===========================================================================

describe('race octonary auth protocols null/[] JSON under requireAuth after #304', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 8; i++) {
    it(`protocols 'null'∥'[]' allow ∥ ' ' unknown flood-${i}`, async () => {
      const tokNull = `as_proto_n_${i}`;
      const tokArr = `as_proto_a_${i}`;
      const tokWs = `as_proto_w_${i}`;
      const dbNull = createAuthDb({
        appservices: new Map([
          [
            tokNull,
            asRow({
              as_token: tokNull,
              sender_localpart: 'nullproto',
              protocols: 'null',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
        ]),
      });
      const dbArr = createAuthDb({
        appservices: new Map([
          [
            tokArr,
            asRow({
              as_token: tokArr,
              sender_localpart: 'arrproto',
              protocols: '[]',
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

      const nullCtx = makeAuthCtx({
        db: dbNull,
        headers: { Authorization: `Bearer ${tokNull}` },
      });
      const arrCtx = makeAuthCtx({
        db: dbArr,
        headers: { Authorization: `Bearer ${tokArr}` },
      });
      const wsCtx = makeAuthCtx({
        db: dbWs,
        headers: { Authorization: `Bearer ${tokWs}` },
      });

      const [nullRes, arrRes, wsRes] = await Promise.all([
        realRequireAuth()(nullCtx, vi.fn(async () => 'null')),
        realRequireAuth()(arrCtx, vi.fn(async () => 'arr')),
        realRequireAuth()(wsCtx, vi.fn()),
      ]);

      expect(nullRes).toBe('null');
      expect(nullCtx.get('userId')).toBe(`@nullproto:${AUTH_SERVER}`);
      expect(arrRes).toBe('arr');
      expect(arrCtx.get('userId')).toBe(`@arrproto:${AUTH_SERVER}`);
      expect(await jsonBody(wsRes as Response)).toMatchObject({
        errcode: 'M_UNKNOWN_TOKEN',
        status: 401,
      });
    });
  }
});

// ===========================================================================
// AUTH — special localpart _=.+/- allow ∥ @Bot uppercase forbid
// ===========================================================================

describe('race octonary auth special localpart ∥ uppercase forbid after #304', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 8; i++) {
    it(`_=.+/- allow ∥ @Bot: forbid under race flood-${i}`, async () => {
      const tok = `as_oct_lp_${i}`;
      const special = `@_bridge_x_${i}=/+:${AUTH_SERVER}`;
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

      const ok = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(special)}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const upper = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(
          `@Bot_${i}:${AUTH_SERVER}`
        )}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const next = vi.fn(async () => 'lp-ok');

      const [okRes, upperRes] = await Promise.all([
        realRequireAuth()(ok, next),
        realRequireAuth()(upper, vi.fn()),
      ]);

      expect(okRes).toBe('lp-ok');
      expect(ok.get('userId')).toBe(special);
      expect(await jsonBody(upperRes as Response)).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Invalid user_id format',
        status: 403,
      });
      expect(upper.get('userId')).toBeUndefined();
    });
  }
});

// ===========================================================================
// AUTH — users:null ∥ users:[] gate skip ∥ array deny
// ===========================================================================

describe('race octonary auth users:null∥[] skip ∥ array deny after #304', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
  });

  for (let i = 0; i < 10; i++) {
    it(`users:null∥[] allow any local ∥ array deny flood-${i}`, async () => {
      const tokNull = `as_oct_un_${i}`;
      const tokEmpty = `as_oct_ue_${i}`;
      const tokArr = `as_oct_ua_${i}`;
      const localUser = `@anyone_${i}:${AUTH_SERVER}`;

      const dbNull = createAuthDb({
        appservices: new Map([
          [
            tokNull,
            asRow({
              as_token: tokNull,
              sender_localpart: 'nully',
              // users:null → ?.length undefined → gate skipped
              namespaces: JSON.stringify({ users: null, rooms: [], aliases: [] }),
            }),
          ],
        ]),
      });
      const dbEmpty = createAuthDb({
        appservices: new Map([
          [
            tokEmpty,
            asRow({
              as_token: tokEmpty,
              sender_localpart: 'empty',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
        ]),
      });
      const dbArr = createAuthDb({
        appservices: new Map([
          [
            tokArr,
            asRow({
              as_token: tokArr,
              sender_localpart: 'arr',
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
      const emptyCtx = makeAuthCtx({
        db: dbEmpty,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${tokEmpty}` },
      });
      const denyCtx = makeAuthCtx({
        db: dbArr,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localUser)}`,
        headers: { Authorization: `Bearer ${tokArr}` },
      });

      const [nullRes, emptyRes, denyRes] = await Promise.all([
        realRequireAuth()(nullCtx, vi.fn(async () => 'null')),
        realRequireAuth()(emptyCtx, vi.fn(async () => 'empty')),
        realRequireAuth()(denyCtx, vi.fn()),
      ]);

      expect(nullRes).toBe('null');
      expect(nullCtx.get('userId')).toBe(localUser);
      expect(emptyRes).toBe('empty');
      expect(emptyCtx.get('userId')).toBe(localUser);
      expect(await jsonBody(denyRes as Response)).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'User not in application service namespace',
        status: 403,
      });
      expect(denyCtx.get('userId')).toBeUndefined();
    });
  }
});
