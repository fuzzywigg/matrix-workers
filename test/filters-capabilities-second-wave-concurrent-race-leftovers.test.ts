/**
 * TOKENMAXX HEAVY leftovers after tip #266 — second-wave residual
 * *filters + capabilities* concurrent-race niches not covered by
 * filters-capabilities-residual-concurrent-race leftovers (#266).
 *
 * Distinct from #266 residual:
 *   seeded dual-GET non-object (42/true/[]); same-key put-swap LWW;
 *   encoded filterId; enabled∥failPut/failGet; TTL keys-only;
 *   forbidden get-count=0; Content-Type soft.
 *
 * Second-wave deepen after #266 tip:
 *   scalar/array POST→GET round-trip under parallel mint;
 *   string-root dual-GET coherency (`"str"`) ∥ caps;
 *   bad-JSON POST → zero CACHE puts ∥ caps isolation;
 *   POST success key-set Object.keys===['filter_id'];
 *   room_versions default+'stable' under failPut/failGet.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 * Reversible by reverting this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

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

vi.mock('../src/middleware/auth', () => ({
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
  extractAccessToken: () => 'test-token',
  validateAccessToken: async () =>
    authState.userId
      ? { userId: authState.userId, deviceId: authState.deviceId }
      : null,
}));

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
const USER_ENC = encodeURIComponent(USER);
const AUTH = { Authorization: 'Bearer test-token' };
const SERVER = 'example.com';
const TTL = 30 * 24 * 60 * 60;

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };
type KvBarrier = { match: (key: string) => boolean; count: number };
type KvGetBarrier = { match: (key: string) => boolean; count: number };

async function withBarrier(
  barrier: { match: (...a: unknown[]) => boolean; count: number } | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  ...matchArgs: unknown[]
) {
  if (!barrier || !barrier.match(...matchArgs)) return;
  await new Promise<void>((resolve) => {
    waitersRef.list.push(resolve);
    if (waitersRef.list.length >= barrier.count) {
      const all = [...waitersRef.list];
      waitersRef.list = [];
      clear();
      for (const r of all) r();
    }
  });
}

function mockCache(
  initial: Record<string, string> = {},
  opts: {
    putBarrier?: KvBarrier;
    getBarrier?: KvGetBarrier;
    failPutAfter?: number;
    failGetAfter?: number;
  } = {}
) {
  const data: Record<string, string> = { ...initial };
  const puts: KvPut[] = [];
  const gets: string[] = [];
  const events: string[] = [];
  let putBarrier = opts.putBarrier;
  let getBarrier = opts.getBarrier;
  const putWaiters = { list: [] as Array<() => void> };
  const getWaiters = { list: [] as Array<() => void> };
  let putCount = 0;
  let getCount = 0;

  return {
    data,
    puts,
    gets,
    events,
    get putCount() {
      return putCount;
    },
    get getCount() {
      return getCount;
    },
    get: async (key: string, type?: string) => {
      await withBarrier(
        getBarrier,
        getWaiters,
        () => {
          getBarrier = undefined;
        },
        key
      );
      getCount += 1;
      gets.push(key);
      events.push(`get:${key}`);
      if (opts.failGetAfter !== undefined && getCount > opts.failGetAfter) {
        throw new Error('kv-get-fail');
      }
      const raw = data[key];
      if (raw == null) return null;
      if (type === 'json') {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
      return raw;
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      await withBarrier(
        putBarrier,
        putWaiters,
        () => {
          putBarrier = undefined;
        },
        key
      );
      putCount += 1;
      if (opts.failPutAfter !== undefined && putCount > opts.failPutAfter) {
        throw new Error('kv-put-fail');
      }
      data[key] = value;
      puts.push({ key, value, options });
      events.push(`put:${key}`);
    },
    delete: async (key: string) => {
      delete data[key];
      events.push(`delete:${key}`);
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
    SERVER_NAME: SERVER,
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

function jsonInit(method: string, body?: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...AUTH,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function authGet(headers: Record<string, string> = {}): RequestInit {
  return { method: 'GET', headers: { ...AUTH, ...headers } };
}

function filterCollection(userEnc = USER_ENC): string {
  return `/_matrix/client/v3/user/${userEnc}/filter`;
}

function filterPath(filterId: string, userEnc = USER_ENC): string {
  return `${filterCollection(userEnc)}/${encodeURIComponent(filterId)}`;
}

function capabilitiesPath(): string {
  return '/_matrix/client/v3/capabilities';
}

function sampleFilter(n = 0): Record<string, unknown> {
  return {
    room: {
      timeline: { limit: 10 + n },
      rooms: [`!r${n}:example.com`],
    },
    event_fields: ['type', 'content', `f${n}`],
  };
}

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
}

function expectRoomVersionsStable(capsBody: unknown) {
  const caps = (capsBody as { capabilities: Record<string, unknown> }).capabilities;
  const rv = caps['m.room_versions'] as {
    default: string;
    available: Record<string, string>;
  };
  expect(rv.default).toBe('10');
  const keys = Object.keys(rv.available).sort((a, b) => Number(a) - Number(b));
  expect(keys).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
  for (const k of keys) {
    expect(rv.available[k]).toBe('stable');
  }
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
});

// ---------------------------------------------------------------------------
// Second-wave: scalar/array POST→GET round-trip under parallel mint
// (#266 only seeded dual-GET; #241 only null-root RT)
// ---------------------------------------------------------------------------

describe('race second-wave filter scalar/array POST→GET round-trip after #266', () => {
  const roots: unknown[] = [true, false, 42, 0, [], [1, 'x'], ''];

  for (let i = 0; i < roots.length; i++) {
    it(`scalar/array root POST→GET round-trip flood-${i}`, async () => {
      const root = roots[i];
      const cache = mockCache(
        {},
        {
          putBarrier: { count: 2, match: (key) => key.startsWith(`filter:${USER}:`) },
        }
      );
      const env = createEnv(cache);
      const postResults = await Promise.all([
        request(env, filterCollection(), jsonInit('POST', root)),
        request(env, filterCollection(), jsonInit('POST', root)),
        request(env, capabilitiesPath(), { method: 'GET' }),
      ]);
      expect(statusesOf(postResults.slice(0, 2))).toEqual([200, 200]);
      expect(postResults[2].status).toBe(200);
      const ids = postResults
        .slice(0, 2)
        .map((r) => (r.body as { filter_id: string }).filter_id);
      expect(ids[0]).not.toBe(ids[1]);
      expect(cache.putCount).toBe(2);

      const gets = await Promise.all([
        request(env, filterPath(ids[0]), authGet()),
        request(env, filterPath(ids[1]), authGet()),
      ]);
      expect(gets[0].status).toBe(200);
      expect(gets[1].status).toBe(200);
      expect(gets[0].body).toEqual(root);
      expect(gets[1].body).toEqual(root);
      for (const p of cache.puts) {
        expect(p.value).toBe(JSON.stringify(root));
        expect(p.options).toEqual({ expirationTtl: TTL });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Second-wave: string-root dual-GET coherency (`"str"`) ∥ caps
// (#266 non-object list intentionally omitted strings)
// ---------------------------------------------------------------------------

describe('race second-wave filter string-root dual-GET after #266', () => {
  const variants: Array<{ raw: string; expect: unknown }> = [
    { raw: '"str"', expect: 'str' },
    { raw: '""', expect: '' },
    { raw: '"a:b@c"', expect: 'a:b@c' },
    { raw: '"null"', expect: 'null' },
    { raw: '"42"', expect: '42' },
    { raw: '"true"', expect: 'true' },
  ];

  for (let i = 0; i < variants.length; i++) {
    it(`string-root dual-GET coherency ∥ caps flood-${i}`, async () => {
      const v = variants[i];
      const fid = `str${i}`;
      const cache = mockCache({ [`filter:${USER}:${fid}`]: v.raw });
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterPath(fid), authGet()),
        request(env, filterPath(fid), authGet()),
        request(env, capabilitiesPath(), { method: 'GET' }),
      ]);
      expect(results[0].status).toBe(200);
      expect(results[1].status).toBe(200);
      expect(results[0].body).toEqual(v.expect);
      expect(results[1].body).toEqual(v.expect);
      expect(results[0].body).toEqual(results[1].body);
      expect(results[2].status).toBe(200);
      expectRoomVersionsStable(results[2].body);
    });
  }
});

// ---------------------------------------------------------------------------
// Second-wave: bad-JSON POST → zero CACHE puts ∥ caps isolation
// (#266 forbidden short-circuits gets; #257 Invalid JSON string — no put-count)
// ---------------------------------------------------------------------------

describe('race second-wave filter bad-JSON zero puts after #266', () => {
  const badBodies = ['{', '[1,', 'undefined', 'not-json', '', '{not json}'];

  for (let i = 0; i < badBodies.length; i++) {
    it(`bad-JSON zero puts ∥ caps ok flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const badInit: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AUTH },
        body: badBodies[i],
      };
      const results = await Promise.all([
        request(env, filterCollection(), badInit),
        request(env, filterCollection(), badInit),
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i))),
        request(env, capabilitiesPath(), { method: 'GET' }),
      ]);
      expect(results[0].status).toBe(400);
      expect(results[1].status).toBe(400);
      expect(results[0].body).toMatchObject({
        errcode: 'M_BAD_JSON',
        error: 'Invalid JSON',
      });
      expect(results[1].body).toMatchObject({
        errcode: 'M_BAD_JSON',
        error: 'Invalid JSON',
      });
      expect(results[2].status).toBe(200);
      expect((results[2].body as { filter_id: string }).filter_id).toMatch(/^[0-9a-f]+$/);
      expect(results[3].status).toBe(200);
      // Only the successful mint may put — bad JSON never reaches CACHE.put
      expect(cache.putCount).toBe(1);
      expect(cache.puts).toHaveLength(1);
      expect(cache.puts[0].key).toMatch(new RegExp(`^filter:${USER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`));
    });
  }
});

// ---------------------------------------------------------------------------
// Second-wave: POST success key-set Object.keys(body)===['filter_id']
// ---------------------------------------------------------------------------

describe('race second-wave filter POST singleton key-set after #266', () => {
  for (let i = 0; i < 12; i++) {
    it(`N-way mint key-set only filter_id flood-${i}`, async () => {
      const cache = mockCache(
        {},
        {
          putBarrier: { count: 4, match: (key) => key.startsWith(`filter:${USER}:`) },
        }
      );
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i))),
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i + 1))),
        request(env, filterCollection(), jsonInit('POST', true)),
        request(env, filterCollection(), jsonInit('POST', [])),
        request(env, capabilitiesPath(), { method: 'GET' }),
      ]);
      const minted = results.slice(0, 4);
      expect(statusesOf(minted)).toEqual([200, 200, 200, 200]);
      const ids = new Set<string>();
      for (const r of minted) {
        const body = r.body as Record<string, unknown>;
        expect(Object.keys(body).sort()).toEqual(['filter_id']);
        expect(typeof body.filter_id).toBe('string');
        expect(body.filter_id as string).toMatch(/^[0-9a-f]+$/);
        ids.add(body.filter_id as string);
      }
      expect(ids.size).toBe(4);
      expect(results[4].status).toBe(200);
      expect(cache.putCount).toBe(4);
    });
  }
});

// ---------------------------------------------------------------------------
// Second-wave: room_versions default+'stable' under failPut/failGet
// (#266 only enabled flags under fail)
// ---------------------------------------------------------------------------

describe('race second-wave caps room_versions under fail after #266', () => {
  for (let i = 0; i < 10; i++) {
    it(`room_versions stable under failPut flood-${i}`, async () => {
      const cache = mockCache({}, { failPutAfter: 0 });
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i))),
        request(env, capabilitiesPath(), { method: 'GET' }),
        request(env, capabilitiesPath(), { method: 'GET' }),
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i + 1))),
      ]);
      // failPutAfter:0 → first put throws; caps must stay coherent
      expect(results[1].status).toBe(200);
      expect(results[2].status).toBe(200);
      expectRoomVersionsStable(results[1].body);
      expectRoomVersionsStable(results[2].body);
      expect(results[1].body).toEqual(results[2].body);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`room_versions stable under failGet flood-${i}`, async () => {
      const fid = `fg${i}`;
      const cache = mockCache(
        { [`filter:${USER}:${fid}`]: JSON.stringify(sampleFilter(i)) },
        { failGetAfter: 0 }
      );
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterPath(fid), authGet()),
        request(env, capabilitiesPath(), { method: 'GET' }),
        request(env, capabilitiesPath(), { method: 'GET' }),
      ]);
      expect(results[1].status).toBe(200);
      expect(results[2].status).toBe(200);
      expectRoomVersionsStable(results[1].body);
      expectRoomVersionsStable(results[2].body);
    });
  }
});
