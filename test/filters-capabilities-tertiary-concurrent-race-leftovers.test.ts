/**
 * TOKENMAXX HEAVY leftovers after #266 — tertiary *filters + capabilities*
 * concurrent-race / soft niches not covered by residual (#266) or #214/#218/#236.
 *
 * Distinct from #266 residual:
 *   non-object GET (42/true/[]/0); same-key put-swap LWW; encoded filterId;
 *   enabled∥failPut/failGet; TTL Object.keys; forbidden zero-get; CT soft.
 *
 * Tertiary deepen after #266 tip:
 *   stored JSON `""` GET coherency ∥ caps; POST body Object.keys === [filter_id];
 *   mint path getCountΔ=0 ∥ seeded GET; null/primitive POST body persist;
 *   putBarrier stampede still zero gets; dual-GET getBarrier empty-string.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 * Reversible by deleting this file.
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
const CAROL = '@carol:example.com';
const USER_ENC = encodeURIComponent(USER);
const CAROL_ENC = encodeURIComponent(CAROL);
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
// Tertiary: stored JSON empty-string "" GET coherency (not #266 scalars/arrays)
// ---------------------------------------------------------------------------

describe('race tertiary filter stored empty-string GET coherency after #266', () => {
  for (let i = 0; i < 12; i++) {
    it(`dual-GET stored "" coherency ∥ caps flood-${i}`, async () => {
      const fid = `es${i}`;
      const cache = mockCache({ [`filter:${USER}:${fid}`]: '""' });
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterPath(fid), authGet()),
        request(env, filterPath(fid), authGet()),
        request(env, capabilitiesPath(), { method: 'GET' }),
        request(env, filterPath(`missing-${i}`), authGet()),
      ]);
      expect(results[0].status).toBe(200);
      expect(results[1].status).toBe(200);
      // JSON.parse('""') → "" — distinct from missing → {} and from '"str"'
      expect(results[0].body).toBe('');
      expect(results[1].body).toBe('');
      expect(results[0].body).toEqual(results[1].body);
      expect(results[2].status).toBe(200);
      expect(results[3].status).toBe(200);
      expect(results[3].body).toEqual({});
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`stored "" ∥ stored "str" ∥ missing {} isolation flood-${i}`, async () => {
      const cache = mockCache({
        [`filter:${USER}:empty${i}`]: '""',
        [`filter:${USER}:str${i}`]: '"str"',
      });
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterPath(`empty${i}`), authGet()),
        request(env, filterPath(`str${i}`), authGet()),
        request(env, filterPath(`gone${i}`), authGet()),
        request(env, capabilitiesPath(), { method: 'GET' }),
      ]);
      expect(results[0].body).toBe('');
      expect(results[1].body).toBe('str');
      expect(results[2].body).toEqual({});
      expect(results[3].status).toBe(200);
      expect(results[0].body).not.toEqual(results[1].body);
      expect(results[0].body).not.toEqual(results[2].body);
    });
  }
});

// ---------------------------------------------------------------------------
// Tertiary: POST success body exclusive key-bind Object.keys === [filter_id]
// ---------------------------------------------------------------------------

describe('race tertiary filter POST Object.keys exactly [filter_id] after #266', () => {
  for (let i = 0; i < 12; i++) {
    it(`N-way POST Object.keys exactly [filter_id] ∥ caps flood-${i}`, async () => {
      const n = 4;
      const cache = mockCache();
      const env = createEnv(cache);
      const results = await Promise.all([
        ...Array.from({ length: n }, (_, j) =>
          request(env, filterCollection(), jsonInit('POST', sampleFilter(i * 10 + j)))
        ),
        request(env, capabilitiesPath(), { method: 'GET' }),
      ]);
      const posts = results.slice(0, n);
      expect(posts.every((r) => r.status === 200)).toBe(true);
      expect(results[n].status).toBe(200);
      for (const r of posts) {
        const body = r.body as Record<string, unknown>;
        expect(Object.keys(body).sort()).toEqual(['filter_id']);
        expect(typeof body.filter_id).toBe('string');
        expect(body.filter_id).toBeTruthy();
      }
      const ids = new Set(posts.map((r) => (r.body as { filter_id: string }).filter_id));
      expect(ids.size).toBe(n);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`POST ok key-bind ∥ forbidden ∥ bad-JSON shape isolation flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i))),
        request(env, filterCollection(CAROL_ENC), jsonInit('POST', sampleFilter(i))),
        request(env, filterCollection(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '{not-json',
        }),
        request(env, capabilitiesPath(), { method: 'GET' }),
      ]);
      expect(results[0].status).toBe(200);
      expect(Object.keys(results[0].body as object).sort()).toEqual(['filter_id']);
      expect(results[1].status).toBe(403);
      expect(results[1].body).toMatchObject({ errcode: 'M_FORBIDDEN' });
      expect(results[2].status).toBe(400);
      expect(results[2].body).toMatchObject({ errcode: 'M_BAD_JSON' });
      expect(results[3].status).toBe(200);
      // Forbidden / bad-JSON must not invent filter_id or poison ok put
      expect((results[1].body as any).filter_id).toBeUndefined();
      expect((results[2].body as any).filter_id).toBeUndefined();
      expect(cache.puts.length).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Tertiary: successful mint path never touches CACHE.get
// ---------------------------------------------------------------------------

describe('race tertiary filter mint zero CACHE gets after #266', () => {
  for (let i = 0; i < 12; i++) {
    it(`POST mint getCountΔ=0 ∥ seeded GET getCountΔ=1 flood-${i}`, async () => {
      const fid = `seed${i}`;
      const cache = mockCache({
        [`filter:${USER}:${fid}`]: JSON.stringify(sampleFilter(i)),
      });
      const env = createEnv(cache);
      const beforeGets = cache.getCount;
      const results = await Promise.all([
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i + 1))),
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i + 2))),
        request(env, filterPath(fid), authGet()),
        request(env, capabilitiesPath(), { method: 'GET' }),
      ]);
      expect(statusesOf(results.slice(0, 2))).toEqual([200, 200]);
      expect(results[2].status).toBe(200);
      expect(results[2].body).toEqual(sampleFilter(i));
      expect(results[3].status).toBe(200);
      // Caps + mint never get; only the seeded GET increments
      expect(cache.getCount).toBe(beforeGets + 1);
      expect(cache.gets).toEqual([`filter:${USER}:${fid}`]);
      expect(cache.puts.length).toBe(2);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`quad POST under putBarrier still zero gets flood-${i}`, async () => {
      const cache = mockCache(
        {},
        {
          putBarrier: { count: 4, match: (key) => key.startsWith(`filter:${USER}:`) },
        }
      );
      const env = createEnv(cache);
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, j) =>
          request(env, filterCollection(), jsonInit('POST', sampleFilter(i * 4 + j)))
        )
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(cache.getCount).toBe(0);
      expect(cache.puts.length).toBe(4);
      for (const p of cache.puts) {
        expect(p.options).toEqual({ expirationTtl: TTL });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Tertiary: dual-GET getBarrier on stored "" (hibernation-style hold)
// ---------------------------------------------------------------------------

describe('race tertiary filter getBarrier empty-string dual-GET after #266', () => {
  for (let i = 0; i < 10; i++) {
    it(`getBarrier dual-GET "" coherency flood-${i}`, async () => {
      const fid = `gb${i}`;
      const cache = mockCache(
        { [`filter:${USER}:${fid}`]: '""' },
        {
          getBarrier: {
            count: 2,
            match: (key) => key === `filter:${USER}:${fid}`,
          },
        }
      );
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterPath(fid), authGet()),
        request(env, filterPath(fid), authGet()),
        request(env, capabilitiesPath(), { method: 'GET' }),
      ]);
      expect(results[0].status).toBe(200);
      expect(results[1].status).toBe(200);
      expect(results[0].body).toBe('');
      expect(results[1].body).toBe('');
      expect(results[2].status).toBe(200);
      expect(cache.getCount).toBe(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Tertiary: primitive / nested-null POST body persist under race
// ---------------------------------------------------------------------------

describe('race tertiary filter primitive POST body persist after #266', () => {
  const bodies: Array<{ name: string; body: unknown }> = [
    { name: 'number', body: 7 },
    { name: 'bool-true', body: true },
    { name: 'bool-false', body: false },
    { name: 'empty-array', body: [] },
    { name: 'nested-null', body: { a: null, b: { c: null } } },
  ];

  for (let i = 0; i < bodies.length; i++) {
    it(`${bodies[i].name} POST→GET coherency ∥ caps flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const payload = bodies[i].body;
      const [postA, postB, caps] = await Promise.all([
        request(env, filterCollection(), jsonInit('POST', payload)),
        request(env, filterCollection(), jsonInit('POST', payload)),
        request(env, capabilitiesPath(), { method: 'GET' }),
      ]);
      expect(postA.status).toBe(200);
      expect(postB.status).toBe(200);
      expect(caps.status).toBe(200);
      const idA = (postA.body as { filter_id: string }).filter_id;
      const idB = (postB.body as { filter_id: string }).filter_id;
      expect(idA).not.toBe(idB);
      const [getA, getB] = await Promise.all([
        request(env, filterPath(idA), authGet()),
        request(env, filterPath(idB), authGet()),
      ]);
      expect(getA.status).toBe(200);
      expect(getB.status).toBe(200);
      expect(getA.body).toEqual(payload);
      expect(getB.body).toEqual(payload);
      for (const p of cache.puts) {
        expect(JSON.parse(p.value)).toEqual(payload);
      }
    });
  }
});
