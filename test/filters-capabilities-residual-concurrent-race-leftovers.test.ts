/**
 * TOKENMAXX HEAVY leftovers after #236 / tip after #253 — residual
 * *filters + capabilities* concurrent-race / TOCTOU niches not covered by
 * filters-capabilities-concurrent-race leftovers (#214/#218/#236).
 *
 * Distinct from #236 (post-#232 appends): mutateAfterGets dual-GET wipe;
 * failPut∥caps; room_versions 1–12; double-encode userId; hex filter_id;
 * query access_token ignored (auth mocked); oversized nested; collection
 * wrong-method; cross-user wipe inject.
 *
 * Residual deepen after #253 tip:
 *   stored non-object GET coherency (42/true/[]); same-key put-swap LWW;
 *   encoded filterId path segments; enabled∥failPut/failGet isolation;
 *   TTL options Object.keys shape; forbidden short-circuit get-count=0;
 *   missing/wrong Content-Type POST isolation.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
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
    mutateAfterPuts?: { after: number; next: Record<string, string> };
    mutateAfterGets?: { after: number; next: Record<string, string> };
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
      if (opts.mutateAfterGets && getCount === opts.mutateAfterGets.after) {
        for (const k of Object.keys(data)) delete data[k];
        Object.assign(data, opts.mutateAfterGets.next);
        events.push('mutate:after-get');
      }
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
      if (opts.mutateAfterPuts && putCount === opts.mutateAfterPuts.after) {
        for (const k of Object.keys(data)) delete data[k];
        Object.assign(data, opts.mutateAfterPuts.next);
        events.push('mutate:after-put');
      }
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

const ENABLED_CAPS = [
  'm.change_password',
  'm.set_displayname',
  'm.set_avatar_url',
  'm.3pid_changes',
] as const;

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
// Residual: stored non-object GET coherency under dual-GET
// ---------------------------------------------------------------------------

describe('race residual filter non-object GET coherency after #236', () => {
  const variants: Array<{ raw: string; expect: unknown }> = [
    { raw: '42', expect: 42 },
    { raw: 'true', expect: true },
    { raw: 'false', expect: false },
    { raw: '[]', expect: [] },
    { raw: '[1,2]', expect: [1, 2] },
    { raw: '0', expect: 0 },
  ];

  for (let i = 0; i < variants.length; i++) {
    it(`dual-GET non-object coherency flood-${i}`, async () => {
      const v = variants[i];
      const fid = `no${i}`;
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
      expect(results[2].status).toBe(200);
      expect(results[0].body).toEqual(results[1].body);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual: same-key put-swap LWW (not wipe) via mutateAfterPuts
// ---------------------------------------------------------------------------

describe('race residual filter same-key put-swap LWW after #236', () => {
  for (let i = 0; i < 10; i++) {
    it(`same-key overwrite LWW after dual POST flood-${i}`, async () => {
      const swapped = sampleFilter(80 + i);
      const cache = mockCache(
        {},
        {
          putBarrier: { count: 2, match: (key) => key.startsWith(`filter:${USER}:`) },
        }
      );
      const origPut = cache.put.bind(cache);
      let localPutCount = 0;
      let firstKey = '';
      cache.put = async (key: string, value: string, options?: { expirationTtl?: number }) => {
        localPutCount += 1;
        if (localPutCount === 1) firstKey = key;
        await origPut(key, value, options);
        if (localPutCount === 2 && firstKey) {
          // Same-key LWW: overwrite first minted filter (not wipe / foreign inject)
          cache.data[firstKey] = JSON.stringify(swapped);
          cache.events.push('mutate:same-key-swap');
        }
      };

      const env = createEnv(cache);
      const postResults = await Promise.all([
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i))),
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i + 1))),
      ]);
      expect(statusesOf(postResults)).toEqual([200, 200]);
      const ids = postResults.map((r) => (r.body as { filter_id: string }).filter_id);
      expect(ids[0]).not.toBe(ids[1]);
      expect(firstKey).toMatch(new RegExp(`^filter:${USER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`));

      // Same-key LWW overwrote whichever put landed first (firstKey), not a wipe
      const swappedId = firstKey.slice(`filter:${USER}:`.length);
      const swappedGet = await request(env, filterPath(swappedId), authGet());
      expect(swappedGet.status).toBe(200);
      expect(swappedGet.body).toEqual(swapped);

      for (const p of cache.puts) {
        expect(p.options).toEqual({ expirationTtl: TTL });
        expect(Object.keys(p.options ?? {}).sort()).toEqual(['expirationTtl']);
      }
      expect(cache.events).toContain('mutate:same-key-swap');
    });
  }
});

// ---------------------------------------------------------------------------
// Residual: encoded filterId path segments ∥ capabilities
// ---------------------------------------------------------------------------

describe('race residual filterId path encoding after #236', () => {
  const ids = ['a:b', 'a@b', 'x y', 'p%q', 'id.with.dots', 'under_score'];

  for (let i = 0; i < ids.length; i++) {
    it(`encoded filterId path ∥ caps flood-${i}`, async () => {
      const fid = ids[i];
      const body = sampleFilter(i);
      const cache = mockCache({ [`filter:${USER}:${fid}`]: JSON.stringify(body) });
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterPath(fid), authGet()),
        request(env, filterPath(fid), authGet()),
        request(env, capabilitiesPath(), { method: 'GET' }),
        request(env, filterPath(`other-${i}`), authGet()),
      ]);
      expect(results[0].status).toBe(200);
      expect(results[0].body).toEqual(body);
      expect(results[1].body).toEqual(body);
      expect(results[2].status).toBe(200);
      expect(results[3].status).toBe(200);
      expect(results[3].body).toEqual({});
      expect(cache.gets.filter((k) => k === `filter:${USER}:${fid}`).length).toBeGreaterThanOrEqual(2);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`slash-containing filterId encoded soft flood-${i}`, async () => {
      const fid = `seg/${i}/tail`;
      const body = sampleFilter(50 + i);
      const cache = mockCache({ [`filter:${USER}:${fid}`]: JSON.stringify(body) });
      const env = createEnv(cache);
      // encodeURIComponent turns / into %2F — Hono param may decode back
      const path = filterPath(fid);
      const results = await Promise.all([
        request(env, path, authGet()),
        request(env, capabilitiesPath(), { method: 'GET' }),
      ]);
      expect(results[1].status).toBe(200);
      // Either finds the key (decoded) or returns {} — both must be 200, caps isolated
      expect(results[0].status).toBe(200);
      if (cache.gets.includes(`filter:${USER}:${fid}`)) {
        expect(results[0].body).toEqual(body);
      } else {
        expect(results[0].body).toEqual({});
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Residual: enabled:true bind ∥ failPut / failGet isolation
// ---------------------------------------------------------------------------

describe('race residual capabilities enabled∥fail isolation after #236', () => {
  for (let i = 0; i < 12; i++) {
    it(`enabled flags stable under failPut flood-${i}`, async () => {
      const cache = mockCache({}, { failPutAfter: 0 });
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i))),
        request(env, capabilitiesPath(), { method: 'GET' }),
        request(env, capabilitiesPath(), authGet()),
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i + 1))),
      ]);
      const caps = results.filter((r) => r.status === 200 && (r.body as any)?.capabilities);
      expect(caps.length).toBe(2);
      for (const c of caps) {
        const body = c.body as { capabilities: Record<string, { enabled?: boolean }> };
        for (const k of ENABLED_CAPS) {
          expect(body.capabilities[k]).toEqual({ enabled: true });
        }
      }
      expect(results.some((r) => r.status >= 500)).toBe(true);
      expect(cache.getCount).toBe(0);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`enabled flags stable under failGet flood-${i}`, async () => {
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
      expect(results[0].status).toBeGreaterThanOrEqual(500);
      expect(results[1].status).toBe(200);
      expect(results[2].status).toBe(200);
      for (const r of [results[1], results[2]]) {
        const caps = (r.body as { capabilities: Record<string, { enabled?: boolean }> }).capabilities;
        for (const k of ENABLED_CAPS) {
          expect(caps[k]).toEqual({ enabled: true });
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Residual: TTL options Object.keys shape under N-way mint
// ---------------------------------------------------------------------------

describe('race residual filter TTL options shape after #236', () => {
  for (let i = 0; i < 10; i++) {
    it(`N-way POST options keys only expirationTtl flood-${i}`, async () => {
      const n = 4;
      const cache = mockCache();
      const env = createEnv(cache);
      const results = await Promise.all(
        Array.from({ length: n }, (_, j) =>
          request(env, filterCollection(), jsonInit('POST', sampleFilter(i * 10 + j)))
        )
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(cache.puts.length).toBe(n);
      for (const p of cache.puts) {
        expect(p.options).toEqual({ expirationTtl: TTL });
        expect(Object.keys(p.options ?? {})).toEqual(['expirationTtl']);
        expect(p.key.startsWith(`filter:${USER}:`)).toBe(true);
      }
      const ids = new Set(results.map((r) => (r.body as { filter_id: string }).filter_id));
      expect(ids.size).toBe(n);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual: forbidden short-circuit → get-count=0 under caps race
// ---------------------------------------------------------------------------

describe('race residual filter forbidden short-circuit after #236', () => {
  for (let i = 0; i < 12; i++) {
    it(`carol path forbidden zero gets ∥ caps flood-${i}`, async () => {
      authState.userId = USER;
      const fid = `forb${i}`;
      const cache = mockCache({
        [`filter:${CAROL}:${fid}`]: JSON.stringify(sampleFilter(i)),
        [`filter:${USER}:${fid}`]: JSON.stringify(sampleFilter(i + 1)),
      });
      const env = createEnv(cache);
      const beforeGets = cache.getCount;
      const results = await Promise.all([
        request(env, filterPath(fid, CAROL_ENC), authGet()),
        request(env, filterCollection(CAROL_ENC), jsonInit('POST', sampleFilter(i))),
        request(env, capabilitiesPath(), { method: 'GET' }),
        request(env, filterPath(fid, USER_ENC), authGet()),
      ]);
      expect(results[0].status).toBe(403);
      expect(results[0].body).toMatchObject({ errcode: 'M_FORBIDDEN' });
      expect(results[1].status).toBe(403);
      expect(results[2].status).toBe(200);
      expect(results[3].status).toBe(200);
      expect(results[3].body).toEqual(sampleFilter(i + 1));
      // Forbidden paths must not touch CACHE; only the allowed GET does
      expect(cache.getCount).toBe(beforeGets + 1);
      expect(cache.gets.every((k) => k.startsWith(`filter:${USER}:`))).toBe(true);
      expect(cache.puts.length).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual: missing / wrong Content-Type POST isolation
// ---------------------------------------------------------------------------

describe('race residual filter Content-Type soft after #236', () => {
  for (let i = 0; i < 10; i++) {
    it(`text/plain∥missing CT∥ok JSON flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const body = sampleFilter(i);
      const results = await Promise.all([
        request(env, filterCollection(), {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain', ...AUTH },
          body: JSON.stringify(body),
        }),
        request(env, filterCollection(), {
          method: 'POST',
          headers: { ...AUTH },
          body: JSON.stringify(body),
        }),
        request(env, filterCollection(), jsonInit('POST', body)),
        request(env, capabilitiesPath(), { method: 'GET' }),
      ]);
      expect(results[3].status).toBe(200);
      // Hono may still parse JSON without CT or with text/plain — assert ok path puts
      const ok = results.filter((r) => r.status === 200 && (r.body as any)?.filter_id);
      expect(ok.length).toBeGreaterThanOrEqual(1);
      for (const p of cache.puts) {
        expect(p.options?.expirationTtl).toBe(TTL);
        expect(JSON.parse(p.value)).toEqual(body);
      }
      // Soft rejects must not poison ok puts or caps
      const soft = results.filter((r) => r.status >= 400 && r.status < 500);
      for (const s of soft) {
        expect(s.body).toMatchObject({ errcode: expect.any(String) });
      }
    });
  }
});
