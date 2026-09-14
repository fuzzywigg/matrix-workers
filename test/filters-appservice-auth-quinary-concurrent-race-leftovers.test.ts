/**
 * TOKENMAXX HEAVY leftovers after #276 — quinary *filters + appservice + auth*
 * concurrent-race niches not covered by quaternary appservice (#276), tertiary
 * (#274), or residual (#266/#271) floods.
 *
 * Distinct from #276 quaternary (appservice service interest/exclusive/txn):
 *   state_key non-member; empty state_key; dual-match single push; exclusive
 *   after soft miss; excludeAsId false/0; fetch reject; HTTP 200/500; invalid
 *   regex throw; type-agnostic; trailing-slash url; ByToken protocols/rate.
 *
 * Quinary deepen after #276 tip (filters + appservice list/null/sent_at + auth):
 *   other-user POST + bad JSON → 403 before parse, zero puts;
 *   getAppServices list rate_limited 0/2/1 + protocols null under parallel;
 *   excludeAsId null falsy skip; exclusive:true room ns still interests;
 *   multi-AS interest → both IDs; room-shaped state_key ≠ room ns;
 *   HTTP 200 + sent_at UPDATE throw → retry; whitespace state_key ' ';
 *   malformed protocols → M_UNKNOWN_TOKEN under race; SERVER_NAME case;
 *   empty sender_localpart → @:SERVER; invalid+good users .some OR allow.
 *
 * Tests-only. Fixtures use example.com / matrix.example.com only.
 * No product inventing. Does not touch auth.ts source (HITL).
 * Reversible by deleting this file.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import type { AppServiceRegistration } from '../src/services/appservice';
import {
  getAppServices,
  getInterestedAppServices,
  isExclusiveAppServiceAlias,
  isExclusiveAppServiceUser,
  sendAppServiceTransaction,
} from '../src/services/appservice';
import { hashToken } from '../src/utils/crypto';

// Real requireAuth/optionalAuth loaded via importActual in auth suites below
// (filter routes use the mocked requireAuth from vi.mock).

// ---------------------------------------------------------------------------
// Filters harness (mocked requireAuth — mirrors tertiary/second-wave)
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
const BOB = '@bob:example.com';
const USER_ENC = encodeURIComponent(USER);
const CAROL_ENC = encodeURIComponent(CAROL);
const BOB_ENC = encodeURIComponent(BOB);
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
  rate_limited: number;
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
// FILTERS — other-user POST + bad JSON → 403 before parse, zero puts
// ===========================================================================

describe('race quinary filter other-user bad-JSON 403 before parse after #276', () => {
  const badBodies = ['{', '[1,', 'undefined', 'not-json', '', '{not json}', '{,'];

  for (let i = 0; i < badBodies.length; i++) {
    it(`carol path + bad JSON stays 403 zero puts ∥ self mint flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      authState.userId = USER;
      const badInit: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: badBodies[i],
      };
      const goodInit: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: JSON.stringify(sampleFilter(i)),
      };

      const results = await Promise.all([
        // Forbidden short-circuits before c.req.json() — must not become M_BAD_JSON
        request(env, filterCollection(CAROL_ENC), badInit),
        request(env, filterCollection(BOB_ENC), badInit),
        request(env, filterCollection(USER_ENC), goodInit),
        request(env, filterCollection(CAROL_ENC), goodInit),
      ]);

      expect(results[0].status).toBe(403);
      expect(results[0].body).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot create filters for other users',
      });
      expect(results[1].status).toBe(403);
      expect(results[1].body).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot create filters for other users',
      });
      expect(results[2].status).toBe(200);
      expect((results[2].body as { filter_id: string }).filter_id).toMatch(/^[0-9a-f]+$/);
      expect(results[3].status).toBe(403);
      // Only the successful self-mint may put
      expect(cache.putCount).toBe(1);
      expect(cache.puts).toHaveLength(1);
      expect(cache.puts[0].key).toMatch(
        new RegExp(`^filter:${USER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`)
      );
    });
  }
});

describe('race quinary filter other-user GET forbidden zero gets after #276', () => {
  for (let i = 0; i < 10; i++) {
    it(`carol/bob GET forbidden never touches CACHE ∥ self GET flood-${i}`, async () => {
      const fid = `q5f${i}`;
      const cache = mockCache({
        [`filter:${USER}:${fid}`]: JSON.stringify(sampleFilter(i)),
      });
      const env = createEnv(cache);
      authState.userId = USER;

      const results = await Promise.all([
        request(env, `/_matrix/client/v3/user/${CAROL_ENC}/filter/${fid}`, {
          method: 'GET',
          headers: AUTH,
        }),
        request(env, `/_matrix/client/v3/user/${BOB_ENC}/filter/${fid}`, {
          method: 'GET',
          headers: AUTH,
        }),
        request(env, `/_matrix/client/v3/user/${USER_ENC}/filter/${fid}`, {
          method: 'GET',
          headers: AUTH,
        }),
      ]);

      expect(results[0].status).toBe(403);
      expect(results[0].body).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot read filters for other users',
      });
      expect(results[1].status).toBe(403);
      expect(results[2].status).toBe(200);
      expect(results[2].body).toEqual(sampleFilter(i));
      // Forbidden paths never call CACHE.get
      expect(cache.getCount).toBe(1);
    });
  }
});

// ===========================================================================
// APPSERVICE — getAppServices list coercion under parallel
// ===========================================================================

describe('race quinary appservice getAppServices list coercion after #276', () => {
  function createListDb(rows: Record<string, unknown>[]) {
    return {
      prepare(_sql: string) {
        return {
          bind(..._args: unknown[]) {
            return this;
          },
          async all<T>() {
            return { results: rows as T[] };
          },
        };
      },
    } as unknown as D1Database;
  }

  for (let i = 0; i < 10; i++) {
    it(`list rate_limited 0/2/1 + protocols null under parallel flood-${i}`, async () => {
      const offRows = [
        {
          id: `off_${i}`,
          url: 'https://off.example.com',
          as_token: `as-off-${i}`,
          hs_token: 'hs',
          sender_localpart: 'off',
          rate_limited: 0,
          protocols: null,
          namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
        },
      ];
      const onRows = [
        {
          id: `on_${i}`,
          url: 'https://on.example.com',
          as_token: `as-on-${i}`,
          hs_token: 'hs',
          sender_localpart: 'on',
          rate_limited: 1,
          protocols: JSON.stringify(['irc']),
          namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
        },
      ];
      const weirdRows = [
        {
          id: `weird_${i}`,
          url: 'https://weird.example.com',
          as_token: `as-weird-${i}`,
          hs_token: 'hs',
          sender_localpart: 'weird',
          rate_limited: 2,
          protocols: null,
          namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
        },
      ];
      const mixedRows = [...offRows, ...onRows, ...weirdRows];

      const [off, on, weird, mixed, empty] = await Promise.all([
        getAppServices(createListDb(offRows)),
        getAppServices(createListDb(onRows)),
        getAppServices(createListDb(weirdRows)),
        getAppServices(createListDb(mixedRows)),
        getAppServices(createListDb([])),
      ]);

      expect(off).toHaveLength(1);
      expect(off[0]).toMatchObject({
        id: `off_${i}`,
        rate_limited: false,
        protocols: [],
      });
      expect(on[0]).toMatchObject({
        id: `on_${i}`,
        rate_limited: true,
        protocols: ['irc'],
      });
      // rate_limited !== 1 → false (ByToken raced in #276; list path leftover)
      expect(weird[0]).toMatchObject({
        id: `weird_${i}`,
        rate_limited: false,
        protocols: [],
      });
      expect(mixed.map((a) => a.id)).toEqual([`off_${i}`, `on_${i}`, `weird_${i}`]);
      expect(mixed.map((a) => a.rate_limited)).toEqual([false, true, false]);
      expect(empty).toEqual([]);
    });
  }
});

// ===========================================================================
// APPSERVICE — excludeAsId null falsy skip
// ===========================================================================

describe('race quinary appservice excludeAsId null after #276', () => {
  for (let i = 0; i < 12; i++) {
    it(`excludeAsId null still matches exclusive user∥alias flood-${i}`, async () => {
      const bridge = registration('bridge', {
        users: [{ exclusive: true, regex: `^@_bridge_.*:${AS_ESC}$` }],
        rooms: [],
        aliases: [{ exclusive: true, regex: `^#_bridge_.*:${AS_ESC}$` }],
      });
      const other = registration('other', {
        users: [{ exclusive: true, regex: `^@_other_.*:${AS_ESC}$` }],
        rooms: [],
        aliases: [{ exclusive: true, regex: `^#_other_.*:${AS_ESC}$` }],
      });
      const services = [bridge, other];
      const uid = `@_bridge_u_${i}:${AS_SERVER}`;
      const alias = `#_bridge_a_${i}:${AS_SERVER}`;
      const falsyNull = null as unknown as string | undefined;

      const [uNull, uUndef, uBridge, aNull, aUndef, aBridge] = await Promise.all([
        Promise.resolve(isExclusiveAppServiceUser(services, uid, falsyNull)),
        Promise.resolve(isExclusiveAppServiceUser(services, uid, undefined)),
        Promise.resolve(isExclusiveAppServiceUser(services, uid, 'bridge')),
        Promise.resolve(isExclusiveAppServiceAlias(services, alias, falsyNull)),
        Promise.resolve(isExclusiveAppServiceAlias(services, alias, undefined)),
        Promise.resolve(isExclusiveAppServiceAlias(services, alias, 'bridge')),
      ]);
      // null is falsy → skip gate → still matches (tertiary ''/undef; quaternary false/0)
      expect(uNull?.id).toBe('bridge');
      expect(uUndef?.id).toBe('bridge');
      expect(uBridge).toBeNull();
      expect(aNull?.id).toBe('bridge');
      expect(aUndef?.id).toBe('bridge');
      expect(aBridge).toBeNull();
    });
  }
});

// ===========================================================================
// APPSERVICE — exclusive:true room ns still interests (exclusive ignored)
// ===========================================================================

describe('race quinary appservice exclusive room ns interest after #276', () => {
  for (let i = 0; i < 10; i++) {
    it(`exclusive:true room hit ∥ miss under Promise.all flood-${i}`, async () => {
      const bridge = registration('bridge', {
        users: [],
        rooms: [{ exclusive: true, regex: `^!secret_.*:${AS_ESC}$` }],
        aliases: [],
      });
      const soft = registration('soft', {
        users: [],
        rooms: [{ exclusive: false, regex: `^!soft_.*:${AS_ESC}$` }],
        aliases: [],
      });

      const [exHit, exMiss, softHit, softMiss] = await Promise.all([
        Promise.resolve(
          getInterestedAppServices([bridge], {
            room_id: `!secret_room_${i}:${AS_SERVER}`,
            sender: `@alice_${i}:${AS_SERVER}`,
            type: 'm.room.message',
          })
        ),
        Promise.resolve(
          getInterestedAppServices([bridge], {
            room_id: `!plain_${i}:${AS_SERVER}`,
            sender: `@alice_${i}:${AS_SERVER}`,
            type: 'm.room.message',
          })
        ),
        Promise.resolve(
          getInterestedAppServices([soft], {
            room_id: `!soft_room_${i}:${AS_SERVER}`,
            sender: `@alice_${i}:${AS_SERVER}`,
            type: 'm.room.message',
          })
        ),
        Promise.resolve(
          getInterestedAppServices([soft], {
            room_id: `!plain_${i}:${AS_SERVER}`,
            sender: `@alice_${i}:${AS_SERVER}`,
            type: 'm.room.message',
          })
        ),
      ]);
      // Room loop ignores exclusive — only regex matters
      expect(exHit.map((a) => a.id)).toEqual(['bridge']);
      expect(exMiss).toEqual([]);
      expect(softHit.map((a) => a.id)).toEqual(['soft']);
      expect(softMiss).toEqual([]);
    });
  }
});

// ===========================================================================
// APPSERVICE — multi-AS interest → both IDs under race
// ===========================================================================

describe('race quinary appservice multi-AS interest both IDs after #276', () => {
  for (let i = 0; i < 10; i++) {
    it(`bridge sender + soft room → ['bridge','soft'] flood-${i}`, async () => {
      const bridge = registration('bridge', {
        users: [{ exclusive: false, regex: `^@_bridge_.*:${AS_ESC}$` }],
        rooms: [],
        aliases: [],
      });
      const soft = registration('soft', {
        users: [],
        rooms: [{ exclusive: false, regex: `^!soft_.*:${AS_ESC}$` }],
        aliases: [],
      });
      const aliasOnly = registration('aliasy', {
        users: [],
        rooms: [],
        aliases: [{ exclusive: true, regex: `^#_alias_.*:${AS_ESC}$` }],
      });
      const services = [bridge, soft, aliasOnly];

      const [both, senderOnly, roomOnly, neither] = await Promise.all([
        Promise.resolve(
          getInterestedAppServices(services, {
            room_id: `!soft_room_${i}:${AS_SERVER}`,
            sender: `@_bridge_bot_${i}:${AS_SERVER}`,
            type: 'm.room.message',
          })
        ),
        Promise.resolve(
          getInterestedAppServices(services, {
            room_id: `!plain_${i}:${AS_SERVER}`,
            sender: `@_bridge_bot_${i}:${AS_SERVER}`,
            type: 'm.room.message',
          })
        ),
        Promise.resolve(
          getInterestedAppServices(services, {
            room_id: `!soft_room_${i}:${AS_SERVER}`,
            sender: `@alice_${i}:${AS_SERVER}`,
            type: 'm.room.message',
          })
        ),
        Promise.resolve(
          getInterestedAppServices(services, {
            room_id: `!plain_${i}:${AS_SERVER}`,
            sender: `@alice_${i}:${AS_SERVER}`,
            type: 'm.room.message',
          })
        ),
      ]);
      expect(both.map((a) => a.id)).toEqual(['bridge', 'soft']);
      expect(senderOnly.map((a) => a.id)).toEqual(['bridge']);
      expect(roomOnly.map((a) => a.id)).toEqual(['soft']);
      expect(neither).toEqual([]);
    });
  }
});

// ===========================================================================
// APPSERVICE — room-shaped state_key does not match room namespaces
// ===========================================================================

describe('race quinary appservice room-shaped state_key ≠ room ns after #276', () => {
  for (let i = 0; i < 10; i++) {
    it(`state_key '!bridge_…' with room ns → [] ∥ real room_id hit flood-${i}`, async () => {
      const bridge = registration('bridge', {
        users: [],
        rooms: [{ exclusive: false, regex: `^!bridge_.*:${AS_ESC}$` }],
        aliases: [],
      });
      const withUser = registration('withuser', {
        users: [{ exclusive: false, regex: `^!bridge_.*:${AS_ESC}$` }],
        rooms: [],
        aliases: [],
      });

      const [skMiss, roomHit, skUserHit] = await Promise.all([
        Promise.resolve(
          getInterestedAppServices([bridge], {
            room_id: `!plain_${i}:${AS_SERVER}`,
            sender: `@alice_${i}:${AS_SERVER}`,
            state_key: `!bridge_ghost_${i}:${AS_SERVER}`,
            type: 'm.room.member',
          })
        ),
        Promise.resolve(
          getInterestedAppServices([bridge], {
            room_id: `!bridge_room_${i}:${AS_SERVER}`,
            sender: `@alice_${i}:${AS_SERVER}`,
            type: 'm.room.message',
          })
        ),
        // state_key only tested against user ns — room-shaped pattern in users hits
        Promise.resolve(
          getInterestedAppServices([withUser], {
            room_id: `!plain_${i}:${AS_SERVER}`,
            sender: `@alice_${i}:${AS_SERVER}`,
            state_key: `!bridge_ghost_${i}:${AS_SERVER}`,
            type: 'm.room.member',
          })
        ),
      ]);
      expect(skMiss).toEqual([]);
      expect(roomHit.map((a) => a.id)).toEqual(['bridge']);
      expect(skUserHit.map((a) => a.id)).toEqual(['withuser']);
    });
  }
});

// ===========================================================================
// APPSERVICE — whitespace state_key ' ' vs '' falsy skip
// ===========================================================================

describe('race quinary appservice whitespace state_key after #276', () => {
  for (let i = 0; i < 10; i++) {
    it(`' ' enters user-ns test ∥ '' skips under race flood-${i}`, async () => {
      // Pattern matches a single space (truthy state_key that is not empty)
      const spacey = registration('spacey', {
        users: [{ exclusive: false, regex: '^ $' }],
        rooms: [],
        aliases: [],
      });
      const bridge = registration('bridge', {
        users: [{ exclusive: false, regex: `^@_bridge_.*:${AS_ESC}$` }],
        rooms: [],
        aliases: [],
      });

      const [spaceHit, emptySkip, spaceMissBridge, bridgeHit] = await Promise.all([
        Promise.resolve(
          getInterestedAppServices([spacey], {
            room_id: `!plain_${i}:${AS_SERVER}`,
            sender: `@alice_${i}:${AS_SERVER}`,
            state_key: ' ',
            type: 'm.room.member',
          })
        ),
        Promise.resolve(
          getInterestedAppServices([spacey], {
            room_id: `!plain_${i}:${AS_SERVER}`,
            sender: `@alice_${i}:${AS_SERVER}`,
            state_key: '',
            type: 'm.room.member',
          })
        ),
        Promise.resolve(
          getInterestedAppServices([bridge], {
            room_id: `!plain_${i}:${AS_SERVER}`,
            sender: `@alice_${i}:${AS_SERVER}`,
            state_key: ' ',
            type: 'm.room.member',
          })
        ),
        Promise.resolve(
          getInterestedAppServices([bridge], {
            room_id: `!plain_${i}:${AS_SERVER}`,
            sender: `@alice_${i}:${AS_SERVER}`,
            state_key: `@_bridge_ghost_${i}:${AS_SERVER}`,
            type: 'm.room.member',
          })
        ),
      ]);
      expect(spaceHit.map((a) => a.id)).toEqual(['spacey']);
      expect(emptySkip).toEqual([]);
      expect(spaceMissBridge).toEqual([]);
      expect(bridgeHit.map((a) => a.id)).toEqual(['bridge']);
    });
  }
});

// ===========================================================================
// APPSERVICE — HTTP 200 + sent_at UPDATE throw → retry_count++, false
// ===========================================================================

describe('race quinary appservice sent_at UPDATE throw after #276', () => {
  const NOW = 1_700_000_100_000;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 }))
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function createTxnDb(opts: { throwOnSentAt?: boolean } = {}) {
    const inserts: Array<{ appservice_id: string; events: string; created_at: number }> = [];
    const updates: Array<{ kind: 'sent' | 'retry'; args: unknown[] }> = [];
    let nextRowId = 90;

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
                  if (opts.throwOnSentAt) {
                    throw new Error('sent_at update failed');
                  }
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
    it(`200 + sent_at throw → retry ∥ sibling sent_at ok flood-${i}`, async () => {
      const failDb = createTxnDb({ throwOnSentAt: true });
      const okDb = createTxnDb();
      const bridge = registration('bridge', { users: [], rooms: [], aliases: [] });

      const [failed, ok] = await Promise.all([
        sendAppServiceTransaction(failDb, bridge, [{ type: 'm.room.message', n: i }]),
        sendAppServiceTransaction(okDb, bridge, [{ type: 'm.room.message', n: i }]),
      ]);

      // UPDATE sent_at is inside fetch try — throw → catch → retry, return false
      expect(failed).toBe(false);
      expect(ok).toBe(true);
      expect(failDb.updates).toEqual([{ kind: 'retry', args: [90] }]);
      expect(failDb.updates.some((u) => u.kind === 'sent')).toBe(false);
      expect(okDb.updates).toEqual([{ kind: 'sent', args: [NOW, 90] }]);
      expect(okDb.updates.some((u) => u.kind === 'retry')).toBe(false);
    });
  }
});

// ===========================================================================
// AUTH suites — real requireAuth/optionalAuth via importActual
// ===========================================================================

describe('race quinary auth after #276 (real requireAuth)', () => {
  let realRequireAuth: typeof import('../src/middleware/auth').requireAuth;
  let realOptionalAuth: typeof import('../src/middleware/auth').optionalAuth;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../src/middleware/auth')>(
      '../src/middleware/auth'
    );
    realRequireAuth = actual.requireAuth;
    realOptionalAuth = actual.optionalAuth;
  });

  describe('malformed protocols under race', () => {
    for (let i = 0; i < 10; i++) {
      it(`bad protocols → unknown ∥ valid AS sibling parallel flood-${i}`, async () => {
        const tokBad = `as_bad_proto_${i}`;
        const tokGood = `as_good_proto_${i}`;
        const dbBad = createAuthDb({
          appservices: new Map([
            [
              tokBad,
              asRow({
                as_token: tokBad,
                sender_localpart: 'badproto',
                protocols: '{bad',
                namespaces: JSON.stringify({
                  users: [],
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
                sender_localpart: 'goodproto',
                protocols: JSON.stringify(['irc']),
                namespaces: JSON.stringify({
                  users: [],
                  rooms: [],
                  aliases: [],
                }),
              }),
            ],
          ]),
        });

        const badCtx = makeAuthCtx({
          db: dbBad,
          headers: { Authorization: `Bearer ${tokBad}` },
        });
        const goodCtx = makeAuthCtx({
          db: dbGood,
          headers: { Authorization: `Bearer ${tokGood}` },
        });
        const nextBad = vi.fn(async () => 'nope');
        const nextGood = vi.fn(async () => 'ok');

        const [badRes, goodRes] = await Promise.all([
          realRequireAuth()(badCtx, nextBad),
          realRequireAuth()(goodCtx, nextGood),
        ]);

        expect(await jsonBody(badRes as Response)).toMatchObject({
          errcode: 'M_UNKNOWN_TOKEN',
          status: 401,
        });
        expect(nextBad).not.toHaveBeenCalled();
        expect(goodRes).toBe('ok');
        expect(goodCtx.get('userId')).toBe(`@goodproto:${AUTH_SERVER}`);
        expect(nextGood).toHaveBeenCalledOnce();
      });
    }
  });

  describe('SERVER_NAME case-sensitive', () => {
    for (let i = 0; i < 10; i++) {
      it(`@bot:Matrix.example.com forbid ∥ exact-case allow flood-${i}`, async () => {
        const tok = `as_case_${i}`;
        const db = createAuthDb({
          appservices: new Map([
            [
              tok,
              asRow({
                as_token: tok,
                sender_localpart: 'bot',
                namespaces: JSON.stringify({ users: [] }),
              }),
            ],
          ]),
        });
        // Format regex allows [a-zA-Z0-9.-]+ so Mixed case passes format, fails ===
        const mixed = `@bot_case_${i}:Matrix.example.com`;
        const exact = `@bot_case_${i}:${AUTH_SERVER}`;

        const [mixedRes, exactRes] = await Promise.all([
          realRequireAuth()(
            makeAuthCtx({
              db,
              url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(mixed)}`,
              headers: { Authorization: `Bearer ${tok}` },
            }),
            vi.fn()
          ),
          realRequireAuth()(
            makeAuthCtx({
              db,
              url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(exact)}`,
              headers: { Authorization: `Bearer ${tok}` },
            }),
            vi.fn(async () => 'local')
          ),
        ]);

        expect(await jsonBody(mixedRes as Response)).toMatchObject({
          errcode: 'M_FORBIDDEN',
          error: 'Cannot impersonate users on other servers',
          status: 403,
        });
        expect(exactRes).toBe('local');
      });
    }
  });

  describe('empty sender_localpart', () => {
    for (let i = 0; i < 10; i++) {
      it(`empty sender → @:SERVER ∥ normal sender ∥ explicit user_id flood-${i}`, async () => {
        const tokEmpty = `as_empty_sender_${i}`;
        const tokNorm = `as_norm_sender_${i}`;
        const dbEmpty = createAuthDb({
          appservices: new Map([
            [
              tokEmpty,
              asRow({
                as_token: tokEmpty,
                sender_localpart: '',
                namespaces: JSON.stringify({ users: [] }),
              }),
            ],
          ]),
        });
        const dbNorm = createAuthDb({
          appservices: new Map([
            [
              tokNorm,
              asRow({
                as_token: tokNorm,
                sender_localpart: 'bridge',
                namespaces: JSON.stringify({ users: [] }),
              }),
            ],
          ]),
        });

        const emptyCtx = makeAuthCtx({
          db: dbEmpty,
          headers: { Authorization: `Bearer ${tokEmpty}` },
        });
        const normCtx = makeAuthCtx({
          db: dbNorm,
          headers: { Authorization: `Bearer ${tokNorm}` },
        });
        const explicitUid = `@ghost_${i}:${AUTH_SERVER}`;
        const explicitCtx = makeAuthCtx({
          db: dbNorm,
          url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(explicitUid)}`,
          headers: { Authorization: `Bearer ${tokNorm}` },
        });

        const [emptyRes, normRes, explicitRes] = await Promise.all([
          realRequireAuth()(emptyCtx, vi.fn(async () => 'empty')),
          realRequireAuth()(normCtx, vi.fn(async () => 'norm')),
          realRequireAuth()(explicitCtx, vi.fn(async () => 'explicit')),
        ]);

        expect(emptyRes).toBe('empty');
        // No user_id → `@${sender_localpart}:${server}` with empty localpart
        expect(emptyCtx.get('userId')).toBe(`@:${AUTH_SERVER}`);
        expect(normRes).toBe('norm');
        expect(normCtx.get('userId')).toBe(`@bridge:${AUTH_SERVER}`);
        expect(explicitRes).toBe('explicit');
        expect(explicitCtx.get('userId')).toBe(explicitUid);
      });
    }
  });

  describe('invalid+good users .some OR', () => {
    for (let i = 0; i < 10; i++) {
      it(`[{regex:'['},{regex:good}] allow ∥ invalid-only forbid flood-${i}`, async () => {
        const esc = AUTH_SERVER.replace(/\./g, '\\.');
        const tokOr = `as_or_${i}`;
        const tokInv = `as_inv_only_${i}`;
        const dbOr = createAuthDb({
          appservices: new Map([
            [
              tokOr,
              asRow({
                as_token: tokOr,
                sender_localpart: 'orbot',
                namespaces: JSON.stringify({
                  users: [
                    { exclusive: true, regex: '[' },
                    { exclusive: true, regex: `@or_bot_.*:${esc}` },
                  ],
                  rooms: [],
                  aliases: [],
                }),
              }),
            ],
          ]),
        });
        const dbInv = createAuthDb({
          appservices: new Map([
            [
              tokInv,
              asRow({
                as_token: tokInv,
                sender_localpart: 'invbot',
                namespaces: JSON.stringify({
                  users: [{ exclusive: true, regex: '[' }],
                  rooms: [],
                  aliases: [],
                }),
              }),
            ],
          ]),
        });

        const uid = `@or_bot_${i}:${AUTH_SERVER}`;
        const orCtx = makeAuthCtx({
          db: dbOr,
          url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(uid)}`,
          headers: { Authorization: `Bearer ${tokOr}` },
        });
        const invCtx = makeAuthCtx({
          db: dbInv,
          url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(uid)}`,
          headers: { Authorization: `Bearer ${tokInv}` },
        });

        const [orRes, invRes] = await Promise.all([
          realRequireAuth()(orCtx, vi.fn(async () => 'allowed')),
          realRequireAuth()(invCtx, vi.fn()),
        ]);

        // .some: invalid catch→false, then good regex matches → allow
        expect(orRes).toBe('allowed');
        expect(orCtx.get('userId')).toBe(uid);
        expect(await jsonBody(invRes as Response)).toMatchObject({
          errcode: 'M_FORBIDDEN',
          error: 'User not in application service namespace',
          status: 403,
        });
      });
    }
  });

  describe('optionalAuth ignores AS under race', () => {
    for (let i = 0; i < 8; i++) {
      it(`optionalAuth AS noop ∥ user token sets userId flood-${i}`, async () => {
        const asTok = `as_opt_${i}`;
        const userTok = `syt_opt_${i}`;
        const hash = await hashToken(userTok);
        const db = createAuthDb({
          tokens: new Map([[hash, { user_id: `@alice_${i}:${AUTH_SERVER}`, device_id: 'D' }]]),
          appservices: new Map([
            [
              asTok,
              asRow({
                as_token: asTok,
                sender_localpart: 'optbot',
                namespaces: JSON.stringify({ users: [] }),
              }),
            ],
          ]),
        });

        const asCtx = makeAuthCtx({
          db,
          headers: { Authorization: `Bearer ${asTok}` },
        });
        const userCtx = makeAuthCtx({
          db,
          headers: { Authorization: `Bearer ${userTok}` },
        });
        const missingCtx = makeAuthCtx({ db, headers: {} });

        const [asOut, userOut, missOut] = await Promise.all([
          realOptionalAuth()(asCtx, vi.fn(async () => 'as')),
          realOptionalAuth()(userCtx, vi.fn(async () => 'user')),
          realOptionalAuth()(missingCtx, vi.fn(async () => 'miss')),
        ]);

        expect(asOut).toBe('as');
        // optionalAuth only validates access_tokens — AS tokens leave userId unset
        expect(asCtx.get('userId')).toBeUndefined();
        expect(userOut).toBe('user');
        expect(userCtx.get('userId')).toBe(`@alice_${i}:${AUTH_SERVER}`);
        expect(missOut).toBe('miss');
        expect(missingCtx.get('userId')).toBeUndefined();
      });
    }
  });
});
