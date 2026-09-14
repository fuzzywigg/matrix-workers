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
 *   empty sender_localpart → @:SERVER; invalid+good users .some OR allow;
 *   optionalAuth ignores AS; wave-2: excludeAsId NaN; first exclusive wins;
 *   sender+state_key multi-AS; protocols ' '/'' ; users:{}; dup access_token;
 *   retry_count UPDATE throw; last_row_id 0.
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
  getAppServiceByToken,
  getInterestedAppServices,
  isExclusiveAppServiceAlias,
  isExclusiveAppServiceUser,
  sendAppServiceTransaction,
} from '../src/services/appservice';
import { extractAccessToken } from '../src/middleware/auth';
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

  describe('protocols whitespace throws under race', () => {
    for (let i = 0; i < 8; i++) {
      it(`protocols ' ' → unknown ∥ ''→[] ∥ null→[] flood-${i}`, async () => {
        const tokWs = `as_proto_ws_${i}`;
        const tokEmpty = `as_proto_empty_${i}`;
        const tokNull = `as_proto_null_${i}`;
        const dbWs = createAuthDb({
          appservices: new Map([
            [
              tokWs,
              asRow({
                as_token: tokWs,
                sender_localpart: 'wsproto',
                // " " is truthy → JSON.parse(" ") throws → swallowed to unknown
                protocols: ' ',
                namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
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
                sender_localpart: 'emptyproto',
                // "" is falsy → [] (same as null), not throw
                protocols: '',
                namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
              }),
            ],
          ]),
        });
        const dbNull = createAuthDb({
          appservices: new Map([
            [
              tokNull,
              asRow({
                as_token: tokNull,
                sender_localpart: 'nullproto',
                protocols: null,
                namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
              }),
            ],
          ]),
        });

        const wsCtx = makeAuthCtx({
          db: dbWs,
          headers: { Authorization: `Bearer ${tokWs}` },
        });
        const emptyCtx = makeAuthCtx({
          db: dbEmpty,
          headers: { Authorization: `Bearer ${tokEmpty}` },
        });
        const nullCtx = makeAuthCtx({
          db: dbNull,
          headers: { Authorization: `Bearer ${tokNull}` },
        });

        const [wsRes, emptyRes, nullRes] = await Promise.all([
          realRequireAuth()(wsCtx, vi.fn()),
          realRequireAuth()(emptyCtx, vi.fn(async () => 'empty')),
          realRequireAuth()(nullCtx, vi.fn(async () => 'ok')),
        ]);

        expect(await jsonBody(wsRes as Response)).toMatchObject({
          errcode: 'M_UNKNOWN_TOKEN',
          status: 401,
        });
        expect(emptyRes).toBe('empty');
        expect(emptyCtx.get('userId')).toBe(`@emptyproto:${AUTH_SERVER}`);
        expect(nullRes).toBe('ok');
        expect(nullCtx.get('userId')).toBe(`@nullproto:${AUTH_SERVER}`);
      });
    }
  });

  describe('namespaces.users {} skips gate', () => {
    for (let i = 0; i < 8; i++) {
      it(`users:{} allows any local ∥ foreign forbid ∥ array deny flood-${i}`, async () => {
        const tokObj = `as_users_obj_${i}`;
        const tokArr = `as_users_arr_${i}`;
        const dbObj = createAuthDb({
          appservices: new Map([
            [
              tokObj,
              asRow({
                as_token: tokObj,
                sender_localpart: 'objbot',
                // {}.length is undefined → gate skipped
                namespaces: JSON.stringify({
                  users: {},
                  rooms: [],
                  aliases: [],
                }),
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
                sender_localpart: 'arrbot',
                namespaces: JSON.stringify({
                  users: [
                    {
                      exclusive: true,
                      regex: `@arr_only_.*:${AUTH_SERVER.replace(/\./g, '\\.')}`,
                    },
                  ],
                  rooms: [],
                  aliases: [],
                }),
              }),
            ],
          ]),
        });

        const localAny = `@anyone_${i}:${AUTH_SERVER}`;
        const foreign = `@anyone_${i}:other.example.com`;
        const denied = `@anyone_${i}:${AUTH_SERVER}`;

        const [localRes, foreignRes, denyRes] = await Promise.all([
          realRequireAuth()(
            makeAuthCtx({
              db: dbObj,
              url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(localAny)}`,
              headers: { Authorization: `Bearer ${tokObj}` },
            }),
            vi.fn(async () => 'local')
          ),
          realRequireAuth()(
            makeAuthCtx({
              db: dbObj,
              url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(foreign)}`,
              headers: { Authorization: `Bearer ${tokObj}` },
            }),
            vi.fn()
          ),
          realRequireAuth()(
            makeAuthCtx({
              db: dbArr,
              url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(denied)}`,
              headers: { Authorization: `Bearer ${tokArr}` },
            }),
            vi.fn()
          ),
        ]);

        expect(localRes).toBe('local');
        expect(await jsonBody(foreignRes as Response)).toMatchObject({
          errcode: 'M_FORBIDDEN',
          error: 'Cannot impersonate users on other servers',
          status: 403,
        });
        expect(await jsonBody(denyRes as Response)).toMatchObject({
          errcode: 'M_FORBIDDEN',
          error: 'User not in application service namespace',
          status: 403,
        });
      });
    }
  });

  describe('duplicate access_token query first-wins', () => {
    for (let i = 0; i < 8; i++) {
      it(`good&bad → good ∥ bad&good → unknown under race flood-${i}`, async () => {
        const good = `syt_dup_good_${i}`;
        const bad = `syt_dup_bad_${i}`;
        const goodHash = await hashToken(good);
        const db = createAuthDb({
          tokens: new Map([
            [goodHash, { user_id: `@dup_${i}:${AUTH_SERVER}`, device_id: 'D' }],
          ]),
        });

        // URLSearchParams.get returns first value only
        const goodFirst = makeAuthCtx({
          db,
          url: `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(good)}&access_token=${encodeURIComponent(bad)}`,
        });
        const badFirst = makeAuthCtx({
          db,
          url: `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(bad)}&access_token=${encodeURIComponent(good)}`,
        });

        expect(
          extractAccessToken(
            new Request(
              `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(good)}&access_token=${encodeURIComponent(bad)}`
            )
          )
        ).toBe(good);
        expect(
          extractAccessToken(
            new Request(
              `https://${AUTH_SERVER}/sync?access_token=${encodeURIComponent(bad)}&access_token=${encodeURIComponent(good)}`
            )
          )
        ).toBe(bad);

        const [goodRes, badRes] = await Promise.all([
          realRequireAuth()(goodFirst, vi.fn(async () => 'good')),
          realRequireAuth()(badFirst, vi.fn()),
        ]);

        expect(goodRes).toBe('good');
        expect(goodFirst.get('userId')).toBe(`@dup_${i}:${AUTH_SERVER}`);
        expect(await jsonBody(badRes as Response)).toMatchObject({
          errcode: 'M_UNKNOWN_TOKEN',
          status: 401,
        });
      });
    }
  });
});

// ===========================================================================
// Quinary deepen wave-2 — appservice NaN / retry-throw / first-wins / cross-axis
// ===========================================================================

describe('race quinary appservice excludeAsId NaN after #276', () => {
  for (let i = 0; i < 10; i++) {
    it(`excludeAsId NaN still matches exclusive user∥alias flood-${i}`, async () => {
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
      const falsyNan = NaN as unknown as string;

      const [uNan, uBridge, aNan, aBridge] = await Promise.all([
        Promise.resolve(isExclusiveAppServiceUser(services, uid, falsyNan)),
        Promise.resolve(isExclusiveAppServiceUser(services, uid, 'bridge')),
        Promise.resolve(isExclusiveAppServiceAlias(services, alias, falsyNan)),
        Promise.resolve(isExclusiveAppServiceAlias(services, alias, 'bridge')),
      ]);
      expect(uNan?.id).toBe('bridge');
      expect(uBridge).toBeNull();
      expect(aNan?.id).toBe('bridge');
      expect(aBridge).toBeNull();
    });
  }
});

describe('race quinary appservice first exclusive wins under race after #276', () => {
  for (let i = 0; i < 10; i++) {
    it(`[first,second] same regex → first ∥ exclude first → second flood-${i}`, async () => {
      const first = registration('first', {
        users: [{ exclusive: true, regex: `^@_shared_.*:${AS_ESC}$` }],
        rooms: [],
        aliases: [{ exclusive: true, regex: `^#_shared_.*:${AS_ESC}$` }],
      });
      const second = registration('second', {
        users: [{ exclusive: true, regex: `^@_shared_.*:${AS_ESC}$` }],
        rooms: [],
        aliases: [{ exclusive: true, regex: `^#_shared_.*:${AS_ESC}$` }],
      });
      const services = [first, second];
      const uid = `@_shared_bot_${i}:${AS_SERVER}`;
      const alias = `#_shared_room_${i}:${AS_SERVER}`;

      const [uFirst, uExcl, aFirst, aExcl] = await Promise.all([
        Promise.resolve(isExclusiveAppServiceUser(services, uid)),
        Promise.resolve(isExclusiveAppServiceUser(services, uid, 'first')),
        Promise.resolve(isExclusiveAppServiceAlias(services, alias)),
        Promise.resolve(isExclusiveAppServiceAlias(services, alias, 'first')),
      ]);
      expect(uFirst?.id).toBe('first');
      expect(uExcl?.id).toBe('second');
      expect(aFirst?.id).toBe('first');
      expect(aExcl?.id).toBe('second');
    });
  }
});

describe('race quinary appservice cross-axis sender+state_key multi-AS after #276', () => {
  for (let i = 0; i < 10; i++) {
    it(`bridge sender + soft state_key → ['bridge','soft'] flood-${i}`, async () => {
      const bridge = registration('bridge', {
        users: [{ exclusive: false, regex: `^@_bridge_.*:${AS_ESC}$` }],
        rooms: [],
        aliases: [],
      });
      const soft = registration('soft', {
        users: [{ exclusive: false, regex: `^@_soft_.*:${AS_ESC}$` }],
        rooms: [],
        aliases: [],
      });
      const services = [bridge, soft];

      const [both, senderOnly, skOnly, neither] = await Promise.all([
        Promise.resolve(
          getInterestedAppServices(services, {
            room_id: `!plain_${i}:${AS_SERVER}`,
            sender: `@_bridge_bot_${i}:${AS_SERVER}`,
            state_key: `@_soft_ghost_${i}:${AS_SERVER}`,
            type: 'm.room.member',
          })
        ),
        Promise.resolve(
          getInterestedAppServices(services, {
            room_id: `!plain_${i}:${AS_SERVER}`,
            sender: `@_bridge_bot_${i}:${AS_SERVER}`,
            state_key: `@alice_${i}:${AS_SERVER}`,
            type: 'm.room.member',
          })
        ),
        Promise.resolve(
          getInterestedAppServices(services, {
            room_id: `!plain_${i}:${AS_SERVER}`,
            sender: `@alice_${i}:${AS_SERVER}`,
            state_key: `@_soft_ghost_${i}:${AS_SERVER}`,
            type: 'm.room.member',
          })
        ),
        Promise.resolve(
          getInterestedAppServices(services, {
            room_id: `!plain_${i}:${AS_SERVER}`,
            sender: `@alice_${i}:${AS_SERVER}`,
            state_key: `@bob_${i}:${AS_SERVER}`,
            type: 'm.room.member',
          })
        ),
      ]);
      expect(both.map((a) => a.id)).toEqual(['bridge', 'soft']);
      expect(senderOnly.map((a) => a.id)).toEqual(['bridge']);
      expect(skOnly.map((a) => a.id)).toEqual(['soft']);
      expect(neither).toEqual([]);
    });
  }
});

describe('race quinary appservice protocols whitespace∥empty list/ByToken after #276', () => {
  function createAsDb(rows: Map<string, Record<string, unknown>>) {
    return {
      prepare(_sql: string) {
        return {
          bind(asToken: string) {
            return {
              async first<T>() {
                return (rows.get(asToken) as T) ?? null;
              },
            };
          },
        };
      },
    } as unknown as D1Database;
  }

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

  for (let i = 0; i < 8; i++) {
    it(`protocols ' ' throw ∥ ''→[] ∥ null→[] ByToken∥list flood-${i}`, async () => {
      const tokWs = `tok-ws-${i}`;
      const tokEmpty = `tok-empty-${i}`;
      const tokNull = `tok-null-${i}`;
      const wsRow = {
        id: `ws_${i}`,
        url: 'https://ws.example.com',
        as_token: tokWs,
        hs_token: 'hs',
        sender_localpart: 'bot',
        rate_limited: 0,
        protocols: ' ',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      };
      const emptyRow = {
        id: `empty_${i}`,
        url: 'https://empty.example.com',
        as_token: tokEmpty,
        hs_token: 'hs',
        sender_localpart: 'bot',
        rate_limited: 0,
        protocols: '',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      };
      const nullRow = {
        id: `null_${i}`,
        url: 'https://null.example.com',
        as_token: tokNull,
        hs_token: 'hs',
        sender_localpart: 'bot',
        rate_limited: 0,
        protocols: null,
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      };

      const [byWs, byEmpty, byNull, listWs, listEmpty, listNull] = await Promise.all([
        Promise.resolve()
          .then(() => getAppServiceByToken(createAsDb(new Map([[tokWs, wsRow]])), tokWs))
          .then((v) => ({ ok: true as const, v }))
          .catch((e) => ({ ok: false as const, err: e })),
        getAppServiceByToken(createAsDb(new Map([[tokEmpty, emptyRow]])), tokEmpty),
        getAppServiceByToken(createAsDb(new Map([[tokNull, nullRow]])), tokNull),
        Promise.resolve()
          .then(() => getAppServices(createListDb([wsRow])))
          .then((v) => ({ ok: true as const, v }))
          .catch((e) => ({ ok: false as const, err: e })),
        getAppServices(createListDb([emptyRow])),
        getAppServices(createListDb([nullRow])),
      ]);

      expect(byWs.ok).toBe(false);
      expect(byEmpty).toMatchObject({ id: `empty_${i}`, protocols: [] });
      expect(byNull).toMatchObject({ id: `null_${i}`, protocols: [] });
      expect(listWs.ok).toBe(false);
      expect(listEmpty[0]).toMatchObject({ id: `empty_${i}`, protocols: [] });
      expect(listNull[0]).toMatchObject({ id: `null_${i}`, protocols: [] });
    });
  }
});

describe('race quinary appservice retry_count UPDATE throw after #276', () => {
  const NOW = 1_700_000_200_000;

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

  function createTxnDb(opts: { throwOnRetry?: boolean; startRowId?: number } = {}) {
    const inserts: Array<{ appservice_id: string; events: string; created_at: number }> = [];
    const updates: Array<{ kind: 'sent' | 'retry'; args: unknown[] }> = [];
    let nextRowId = opts.startRowId ?? 100;

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
                  if (opts.throwOnRetry) {
                    throw new Error('retry_count update failed');
                  }
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
    it(`500 + retry throw rejects ∥ sibling 200 sent_at ok flood-${i}`, async () => {
      const failDb = createTxnDb({ throwOnRetry: true });
      const okDb = createTxnDb();
      // Distinct URLs so fetch mock is race-safe under Promise.all
      const failAs = registration(
        'fail',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://fail.example.com' }
      );
      const okAs = registration(
        'ok',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://ok.example.com' }
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (String(url).includes('fail.example.com')) {
            return new Response('boom', { status: 500 });
          }
          return new Response('{}', { status: 200 });
        })
      );

      const [failed, ok] = await Promise.all([
        Promise.resolve()
          .then(() =>
            sendAppServiceTransaction(failDb, failAs, [{ type: 'm.room.message', n: i }])
          )
          .then((v) => ({ ok: true as const, v }))
          .catch((e) => ({ ok: false as const, err: e })),
        sendAppServiceTransaction(okDb, okAs, [{ type: 'm.room.message', n: i }]),
      ]);

      // retry_count UPDATE is outside try — throw propagates (unlike sent_at)
      expect(failed.ok).toBe(false);
      expect(ok).toBe(true);
      expect(failDb.updates.some((u) => u.kind === 'sent')).toBe(false);
      expect(okDb.updates).toEqual([{ kind: 'sent', args: [NOW, 100] }]);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`last_row_id 0 → …/transactions/0 under parallel flood-${i}`, async () => {
      const db = createTxnDb({ startRowId: 0 });
      const bridge = registration('bridge', { users: [], rooms: [], aliases: [] });
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response('{}', { status: 200 })
      );

      const ok = await sendAppServiceTransaction(db, bridge, [
        { type: 'm.room.message', n: i },
      ]);
      expect(ok).toBe(true);
      const calledUrl = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toBe(
        'https://bridge.example.com/_matrix/app/v1/transactions/0'
      );
      expect(db.updates).toEqual([{ kind: 'sent', args: [NOW, 0] }]);
    });
  }
});
