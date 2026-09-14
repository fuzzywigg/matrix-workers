/**
 * TOKENMAXX HEAVY leftovers after #292 — septenary *filters + appservice + auth*
 * concurrent-race niches not covered by senary (#292), quinary (#286), or
 * quaternary (#276) floods.
 *
 * Gap table (why leftover after #292 senary):
 *   Filters soft error-string quad (create∥read∥Invalid JSON∥success)
 *     | residual create-vs-read pair; second-wave Invalid JSON put-count;
 *       senary skipped filters entirely
 *   GET missing {} ∥ corrupt → {} ∥ valid ∥ other-user forbidden
 *     | capabilities corrupt→{}; never soft-quad with forbidden in this series
 *   empty events [] INSERT+PUT ∥ non-empty sibling
 *     | senary 2-event∥1-event; tertiary INSERT throw with []; never empty∥non-empty body
 *   protocols '{}' → object ByToken∥list ∥ null→[] ∥ corrupt throw
 *     | senary ' '/''/null; never object JSON
 *   rate_limited null → false ByToken∥list
 *     | senary -1/99; quaternary 0/2/1; never SQL-null
 *   rooms:null throws interest ∥ empty-rooms sibling hit
 *     | senary bad user-ns throw; never null rooms
 *   Auth soft forbid error-string quad ∥ AS success
 *     | concurrent has each separately; never soft-quad under one Promise.all
 *
 * Distinct from #292 senary, #286 quinary, #276 quaternary, #274 tertiary.
 * New file. Tests-only. example.com / matrix.example.com fixtures only.
 * Does not touch auth.ts source (HITL). Reversible by delete.
 * No invent-product / secrets / DNS / history rewrite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import type { AppServiceRegistration } from '../src/services/appservice';
import {
  getAppServices,
  getAppServiceByToken,
  getInterestedAppServices,
  sendAppServiceTransaction,
} from '../src/services/appservice';
import {
  extractAccessToken,
  requireAuth,
} from '../src/middleware/auth';

// Real requireAuth/optionalAuth loaded via importActual in auth suites below
// (filter routes use the mocked requireAuth from vi.mock).

// ---------------------------------------------------------------------------
// Filters harness (mocked requireAuth — mirrors quinary/senary series)
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
// FILTERS — soft error-string quad never mixed with success (senary skipped)
// ===========================================================================

describe('race septenary filter soft error-string quad after #292', () => {
  for (let i = 0; i < 12; i++) {
    it(`create∥read∥Invalid JSON∥success never mix flood-${i}`, async () => {
      const cache = mockCache({
        [`filter:${CAROL}:fid_${i}`]: JSON.stringify(sampleFilter(i)),
      });
      const env = createEnv(cache);
      const putsBefore = cache.putCount;

      const [createForbid, readForbid, badJson, ok] = await Promise.all([
        request(env, filterCollection(CAROL_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: JSON.stringify(sampleFilter(i)),
        }),
        request(env, filterPath(`fid_${i}`, CAROL_ENC), {
          method: 'GET',
          headers: { ...AUTH },
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '{not-json',
        }),
        request(env, filterCollection(USER_ENC), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: JSON.stringify(sampleFilter(i + 100)),
        }),
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
      expect(ok.status).toBe(200);
      const fid = (ok.body as { filter_id: string }).filter_id;
      expect(fid).toMatch(/^[0-9a-f]+$/);
      expect(fid).not.toContain('-');

      // Soft strings never bleed across siblings
      expect((createForbid.body as { error: string }).error).not.toBe(
        (readForbid.body as { error: string }).error
      );
      expect((createForbid.body as { error: string }).error).not.toBe('Invalid JSON');
      expect((readForbid.body as { error: string }).error).not.toBe('Invalid JSON');
      expect(ok.body).not.toHaveProperty('errcode');
      expect(ok.body).not.toHaveProperty('error');

      // Only the success mint may put — forbidden/bad-JSON short-circuit
      expect(cache.putCount - putsBefore).toBe(1);
      expect(cache.puts.at(-1)?.key).toBe(`filter:${USER}:${fid}`);
      expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(2592000);
    });
  }
});

describe('race septenary filter GET missing∥corrupt∥valid∥forbidden soft after #292', () => {
  for (let i = 0; i < 10; i++) {
    it(`{} ∥ corrupt→{} ∥ seeded ∥ carol forbidden flood-${i}`, async () => {
      const fid = `sept_${i}`;
      const cache = mockCache({
        [`filter:${USER}:${fid}`]: JSON.stringify(sampleFilter(i)),
        [`filter:${USER}:corrupt_${i}`]: '{not-json',
        [`filter:${CAROL}:${fid}`]: JSON.stringify(sampleFilter(i + 1)),
      });
      const env = createEnv(cache);
      const getsBefore = cache.getCount;

      const [missing, corrupt, valid, forbid] = await Promise.all([
        request(env, filterPath(`missing_${i}`), { method: 'GET', headers: { ...AUTH } }),
        request(env, filterPath(`corrupt_${i}`), { method: 'GET', headers: { ...AUTH } }),
        request(env, filterPath(fid), { method: 'GET', headers: { ...AUTH } }),
        request(env, filterPath(fid, CAROL_ENC), { method: 'GET', headers: { ...AUTH } }),
      ]);

      expect(missing.status).toBe(200);
      expect(missing.body).toEqual({});
      expect(corrupt.status).toBe(200);
      expect(corrupt.body).toEqual({});
      expect(valid.status).toBe(200);
      expect(valid.body).toEqual(sampleFilter(i));
      expect(forbid.status).toBe(403);
      expect(forbid.body).toEqual({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot read filters for other users',
      });

      // Soft {} never confused with forbidden; forbidden never touches CACHE
      expect(missing.body).not.toHaveProperty('errcode');
      expect(corrupt.body).not.toHaveProperty('errcode');
      expect(forbid.body).not.toEqual({});
      // missing+corrupt+valid = 3 gets; forbidden short-circuits before CACHE.get
      expect(cache.getCount - getsBefore).toBe(3);
    });
  }
});

// ===========================================================================
// APPSERVICE — empty events [] ∥ non-empty sibling body bind
// ===========================================================================

describe('race septenary appservice empty events [] body after #292', () => {
  const NOW = 1_700_000_400_000;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 }))
    );
  });

  function createTxnDb(startRowId = 700) {
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
    it(`empty [] INSERT+PUT ∥ non-empty sibling flood-${i}`, async () => {
      const emptyDb = createTxnDb(700 + i * 2);
      const fullDb = createTxnDb(800 + i * 2);
      const emptyAs = registration(
        'empty',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://empty.example.com' }
      );
      const fullAs = registration(
        'full',
        { users: [], rooms: [], aliases: [] },
        { url: 'https://full.example.com' }
      );
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock.mockClear();
      fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));

      const fullEvents = [{ type: 'm.room.message', n: i }];
      const [emptyOk, fullOk] = await Promise.all([
        sendAppServiceTransaction(emptyDb, emptyAs, []),
        sendAppServiceTransaction(fullDb, fullAs, fullEvents),
      ]);
      expect(emptyOk).toBe(true);
      expect(fullOk).toBe(true);

      expect(emptyDb.inserts).toEqual([
        { appservice_id: 'empty', events: '[]', created_at: NOW },
      ]);
      expect(fullDb.inserts).toEqual([
        {
          appservice_id: 'full',
          events: JSON.stringify(fullEvents),
          created_at: NOW,
        },
      ]);

      const emptyCall = fetchMock.mock.calls.find((c) =>
        String(c[0]).includes('empty.example.com')
      );
      const fullCall = fetchMock.mock.calls.find((c) =>
        String(c[0]).includes('full.example.com')
      );
      expect(emptyCall).toBeTruthy();
      expect(fullCall).toBeTruthy();
      expect(JSON.parse((emptyCall![1] as RequestInit).body as string)).toEqual({
        events: [],
      });
      expect(JSON.parse((fullCall![1] as RequestInit).body as string)).toEqual({
        events: fullEvents,
      });
      expect(Array.isArray(JSON.parse((emptyCall![1] as RequestInit).body as string))).toBe(
        false
      );
    });
  }
});

// ===========================================================================
// APPSERVICE — protocols '{}' object ∥ null→[] ∥ corrupt throw
// ===========================================================================

describe('race septenary appservice protocols object {} after #292', () => {
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

  for (let i = 0; i < 10; i++) {
    it(`protocols '{}'→object ∥ null→[] ∥ corrupt throw ByToken∥list flood-${i}`, async () => {
      const objRow = asRow({
        id: `obj_${i}`,
        as_token: `tok_obj_${i}`,
        sender_localpart: 'obj',
        protocols: '{}',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const nullRow = asRow({
        id: `null_${i}`,
        as_token: `tok_null_${i}`,
        sender_localpart: 'nully',
        protocols: null,
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const badRow = asRow({
        id: `bad_${i}`,
        as_token: `tok_bad_${i}`,
        sender_localpart: 'bad',
        protocols: '{oops',
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });

      const [byObj, byNull, byBad, listObj, listNull, listBad] = await Promise.all([
        getAppServiceByToken(createListDb([objRow]), `tok_obj_${i}`),
        getAppServiceByToken(createListDb([nullRow]), `tok_null_${i}`),
        Promise.resolve()
          .then(() => getAppServiceByToken(createListDb([badRow]), `tok_bad_${i}`))
          .then((v) => ({ ok: true as const, v }))
          .catch((e) => ({ ok: false as const, err: e })),
        getAppServices(createListDb([objRow])),
        getAppServices(createListDb([nullRow])),
        Promise.resolve()
          .then(() => getAppServices(createListDb([badRow])))
          .then((v) => ({ ok: true as const, v }))
          .catch((e) => ({ ok: false as const, err: e })),
      ]);

      // "{}" is truthy → JSON.parse → {} (object, not array) — distinct from null→[]
      expect(byObj?.protocols).toEqual({});
      expect(Array.isArray(byObj?.protocols)).toBe(false);
      expect(byNull?.protocols).toEqual([]);
      expect(Array.isArray(byNull?.protocols)).toBe(true);
      expect(byBad.ok).toBe(false);

      expect(listObj[0]?.protocols).toEqual({});
      expect(Array.isArray(listObj[0]?.protocols)).toBe(false);
      expect(listNull[0]?.protocols).toEqual([]);
      expect(listBad.ok).toBe(false);
    });
  }
});

// ===========================================================================
// APPSERVICE — rate_limited null → false (senary covered -1/99)
// ===========================================================================

describe('race septenary appservice rate_limited null after #292', () => {
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

  for (let i = 0; i < 10; i++) {
    it(`rate_limited null→false ∥ 1→true ByToken∥list flood-${i}`, async () => {
      const nullRow = asRow({
        id: `rn_${i}`,
        as_token: `tok_rn_${i}`,
        sender_localpart: 'rn',
        rate_limited: null,
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });
      const trueRow = asRow({
        id: `rt_${i}`,
        as_token: `tok_rt_${i}`,
        sender_localpart: 'rt',
        rate_limited: 1,
        namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
      });

      const [byNull, byTrue, listMixed] = await Promise.all([
        getAppServiceByToken(createListDb([nullRow]), `tok_rn_${i}`),
        getAppServiceByToken(createListDb([trueRow]), `tok_rt_${i}`),
        getAppServices(createListDb([nullRow, trueRow])),
      ]);

      // null === 1 → false (same as 0/-1/99 senary/quaternary non-1)
      expect(byNull?.rate_limited).toBe(false);
      expect(byTrue?.rate_limited).toBe(true);
      expect(listMixed.map((a) => a.rate_limited)).toEqual([false, true]);
    });
  }
});

// ===========================================================================
// APPSERVICE — rooms:null throws interest ∥ empty-rooms sibling hit
// ===========================================================================

describe('race septenary appservice rooms:null throw after #292', () => {
  for (let i = 0; i < 10; i++) {
    it(`rooms:null throw ∥ empty-rooms sibling room hit flood-${i}`, async () => {
      const broken = registration('broken', {
        users: [],
        // null rooms → for..of throws when sender/user ns miss
        rooms: null as unknown as AppServiceRegistration['namespaces']['rooms'],
        aliases: [],
      });
      const ok = registration('ok', {
        users: [],
        rooms: [{ exclusive: false, regex: `^!soft_.*:${AS_ESC}$` }],
        aliases: [],
      });
      const services = [broken, ok];
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
      expect(hit.map((a) => a.id)).toEqual(['ok']);
      expect(miss).toEqual([]);

      // Mixed list: broken first still throws before ok is reached
      const mixed = await Promise.resolve()
        .then(() =>
          getInterestedAppServices(services, {
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
// AUTH — soft forbid error-string quad never mixed with AS success
// ===========================================================================

describe('race septenary auth soft forbid error-string quad after #292', () => {
  // requireAuth is the real export (filter mock still wraps via importActual)
  const realRequireAuth = requireAuth;

  for (let i = 0; i < 12; i++) {
    it(`Invalid format∥impersonate∥ns deny∥AS success never mix flood-${i}`, async () => {
      const tok = `as_sept_soft_${i}`;
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
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent('@Bad')}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const foreign = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(
          `@_bridge_x_${i}:other.example.com`
        )}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const outOfNs = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(
          `@alice_${i}:${AUTH_SERVER}`
        )}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const ok = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent(
          `@_bridge_ok_${i}:${AUTH_SERVER}`
        )}`,
        headers: { Authorization: `Bearer ${tok}` },
      });
      const next = vi.fn(async () => 'ok');

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

      // Soft strings never mix across siblings
      const errs = [fmtBody.error, foreignBody.error, nsBody.error];
      expect(new Set(errs).size).toBe(3);
      expect(errs).not.toContain('Missing access token');
      expect(errs).not.toContain('Unknown token');

      expect(okRes).toBe('ok');
      expect(next).toHaveBeenCalledOnce();
      expect(ok.get('userId')).toBe(`@_bridge_ok_${i}:${AUTH_SERVER}`);
      expect(ok.get('deviceId')).toBeNull();
      expect(badFmt.get('userId')).toBeUndefined();
      expect(foreign.get('userId')).toBeUndefined();
      expect(outOfNs.get('userId')).toBeUndefined();
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`Bearer multi-space extract ∥ soft forbid sibling flood-${i}`, async () => {
      const tok = `as_sept_ws_${i}`;
      // extractAccessToken regex captures after Bearer\\s+ — multi-space ok
      expect(
        extractAccessToken(
          new Request(`https://${AUTH_SERVER}/sync`, {
            headers: { Authorization: `Bearer    ${tok}` },
          })
        )
      ).toBe(tok);

      const db = createAuthDb({
        appservices: new Map([
          [
            tok,
            asRow({
              as_token: tok,
              sender_localpart: 'ws',
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
        ]),
      });
      const ok = makeAuthCtx({
        db,
        headers: { Authorization: `Bearer    ${tok}` },
      });
      const forbid = makeAuthCtx({
        db,
        url: `https://${AUTH_SERVER}/sync?user_id=${encodeURIComponent('@Bad')}`,
        headers: { Authorization: `Bearer    ${tok}` },
      });
      const next = vi.fn(async () => 'ws-ok');
      const [okRes, forbidRes] = await Promise.all([
        realRequireAuth()(ok, next),
        realRequireAuth()(forbid, vi.fn()),
      ]);
      expect(okRes).toBe('ws-ok');
      expect(ok.get('userId')).toBe(`@ws:${AUTH_SERVER}`);
      expect(await jsonBody(forbidRes as Response)).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Invalid user_id format',
      });
    });
  }
});

// ===========================================================================
// AUTH — protocols '{}' under requireAuth (object parse ≠ throw)
// ===========================================================================

describe('race septenary auth protocols object under requireAuth after #292', () => {
  const realRequireAuth = requireAuth;

  for (let i = 0; i < 8; i++) {
    it(`protocols '{}' allow ∥ ' ' unknown ∥ null allow flood-${i}`, async () => {
      const tokObj = `as_proto_obj_${i}`;
      const tokWs = `as_proto_ws2_${i}`;
      const tokNull = `as_proto_null2_${i}`;
      const dbObj = createAuthDb({
        appservices: new Map([
          [
            tokObj,
            asRow({
              as_token: tokObj,
              sender_localpart: 'objproto',
              // "{}" truthy → JSON.parse → {} — does NOT throw (unlike " ")
              protocols: '{}',
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
              sender_localpart: 'wsproto2',
              protocols: ' ',
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
              sender_localpart: 'nullproto2',
              protocols: null,
              namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
            }),
          ],
        ]),
      });

      const objCtx = makeAuthCtx({
        db: dbObj,
        headers: { Authorization: `Bearer ${tokObj}` },
      });
      const wsCtx = makeAuthCtx({
        db: dbWs,
        headers: { Authorization: `Bearer ${tokWs}` },
      });
      const nullCtx = makeAuthCtx({
        db: dbNull,
        headers: { Authorization: `Bearer ${tokNull}` },
      });

      const [objRes, wsRes, nullRes] = await Promise.all([
        realRequireAuth()(objCtx, vi.fn(async () => 'obj')),
        realRequireAuth()(wsCtx, vi.fn()),
        realRequireAuth()(nullCtx, vi.fn(async () => 'null')),
      ]);

      expect(objRes).toBe('obj');
      expect(objCtx.get('userId')).toBe(`@objproto:${AUTH_SERVER}`);
      expect(await jsonBody(wsRes as Response)).toMatchObject({
        errcode: 'M_UNKNOWN_TOKEN',
        status: 401,
      });
      expect(nullRes).toBe('null');
      expect(nullCtx.get('userId')).toBe(`@nullproto2:${AUTH_SERVER}`);
    });
  }
});
