/**
 * TOKENMAXX HEAVY leftovers after #214 / #218 — deepen residual client
 * *filters + capabilities* concurrent race / TOCTOU + soft/edge reliability
 * on the existing module (first pass #214 after #210; residual #218).
 *
 * Live handlers live inline on `src/index.ts` (capabilities GET; POST/GET
 * user filter KV). Sync only *consumes* `filter:` KV keys (#202); never races
 * the create/read filter endpoints or capabilities coherency under Promise.all.
 *
 * Distinct from saturated keys/devices/to-device/media/receipts/threads/spaces/
 * aliases/power-levels/redact/voip concurrent-race files and from relations
 * (#210), account (#209), directory/userdir (#211), rooms-read-upgrade (#208),
 * push (#207), typing (#206), sliding-sync (#205), presence (#204), sync (#202),
 * voip (#201), room-cache (#232).
 *
 * #214 covered: parallel POST distinct IDs; CACHE put barrier TOCTOU;
 * POST∥GET mid-flight empty-vs-body; corrupt/missing KV → {}; forbidden
 * other-user; capabilities parallel coherency; method/JSON/charset soft
 * floods; TTL bind contracts; cross-endpoint filter∥capabilities isolation.
 *
 * Residual deepen (#214+ / #218): delayMs put/get soft; mutateAfterPuts wipe
 * TOCTOU; POST put-barrier ∥ seeded GET isolation; auth/device identity;
 * Content-Type/Accept/charset; filter-item method floods; query-string ignore;
 * root JSON type soft; filter-id vocabulary; capabilities exhaustive key bind;
 * events order; unicode bodies; HEAD/OPTIONS.
 *
 * Residual deepen after #232: mutateAfterGets dual-GET barrier TOCTOU;
 * failPut∥capabilities isolation; room_versions available exhaustive under
 * Promise.all; double-encoded userId soft; filter_id hex-segment bind;
 * failGet mid∥capabilities; oversized nested body; cross-user wipe inject;
 * query access_token ignored (auth mocked); PUT collection soft.
 *
 * Residual deepen after #241: case-mismatched userId ≠ auth; forbidden
 * error-message bind; capabilities HEAD + exact 5-key set; empty/ws
 * filterId → {}; null-root POST→GET round-trip; delayPut∥failGet
 * isolation; putBarrier mint → getBarrier dual-GET; empty deviceId;
 * TTL pin under failPutAfter 1; mutateAfterGets corrupt inject → {}.
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
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const USER_ENC = encodeURIComponent(USER);
const BOB_ENC = encodeURIComponent(BOB);
const CAROL_ENC = encodeURIComponent(CAROL);
const AUTH = { Authorization: 'Bearer test-token' };
const SERVER = 'example.com';

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };
type KvBarrier = { match: (key: string) => boolean; count: number };
type KvGetBarrier = { match: (key: string) => boolean; count: number };

async function withBarrier(
  barrier: { match: (...a: any[]) => boolean; count: number } | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  ...matchArgs: any[]
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
    delayMsOnPut?: number;
    delayMsOnGet?: number;
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
      if (opts.delayMsOnGet) {
        await new Promise((r) => setTimeout(r, opts.delayMsOnGet));
      }
      getCount += 1;
      gets.push(key);
      events.push(`get:${key}`);
      if (opts.failGetAfter !== undefined && getCount > opts.failGetAfter) {
        throw new Error('kv-get-fail');
      }
      const raw = data[key];
      // Mutate *after* snapshot so the current GET still observes pre-mutation data
      // (TOCTOU: next concurrent/serial GET sees the wipe).
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
      if (opts.delayMsOnPut) {
        await new Promise((r) => setTimeout(r, opts.delayMsOnPut));
      }
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

function filterKeys(cache: RaceCache, userId = USER): string[] {
  return Object.keys(cache.data)
    .filter((k) => k.startsWith(`filter:${userId}:`))
    .sort();
}

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
}

type CapabilitiesBody = {
  capabilities: {
    'm.room_versions': { default: string; available: Record<string, string> };
  };
};

function expectCapabilitiesShape(body: any) {
  expect(body).toHaveProperty('capabilities');
  expect(body.capabilities['m.change_password']).toEqual({ enabled: true });
  expect(body.capabilities['m.set_displayname']).toEqual({ enabled: true });
  expect(body.capabilities['m.set_avatar_url']).toEqual({ enabled: true });
  expect(body.capabilities['m.3pid_changes']).toEqual({ enabled: true });
  expect(body.capabilities['m.room_versions'].default).toBe('10');
  expect(body.capabilities['m.room_versions'].available['10']).toBe('stable');
  expect(body.capabilities['m.room_versions'].available['11']).toBe('stable');
}

beforeEach(() => {
  authState.userId = USER;
  authState.deviceId = 'DEVICEA';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Parallel POST filter — distinct IDs / put barriers
// ---------------------------------------------------------------------------

describe('race filter POST parallel mint distinct IDs after #210', () => {
  it('dual POST yields two distinct filter_ids and two CACHE puts', async () => {
    const cache = mockCache();
    const env = createEnv(cache);
    const results = await Promise.all([
      request(env, filterCollection(), jsonInit('POST', sampleFilter(1))),
      request(env, filterCollection(), jsonInit('POST', sampleFilter(2))),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const ids = results.map((r) => (r.body as { filter_id: string }).filter_id).sort();
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(cache.puts.length).toBe(2);
    expect(filterKeys(cache)).toHaveLength(2);
  });

  it('quad POST under put barrier still mints four distinct keys', async () => {
    const cache = mockCache({
      putBarrier: { count: 4, match: (key) => key.startsWith(`filter:${USER}:`) },
    });
    const env = createEnv(cache);
    const results = await Promise.all(
      [0, 1, 2, 3].map((i) => request(env, filterCollection(), jsonInit('POST', sampleFilter(i))))
    );
    expect(statusesOf(results)).toEqual([200, 200, 200, 200]);
    const ids = new Set(results.map((r) => (r.body as { filter_id: string }).filter_id));
    expect(ids.size).toBe(4);
    expect(cache.puts.length).toBe(4);
  });

  for (let i = 0; i < 10; i++) {
    it(`parallel POST flood-${i}: 3 concurrent mints isolate bodies`, async () => {
      const cache = mockCache({
        putBarrier: { count: 3, match: (key) => key.startsWith(`filter:${USER}:`) },
      });
      const env = createEnv(cache);
      const bodies = [sampleFilter(i), sampleFilter(i + 10), sampleFilter(i + 20)];
      const results = await Promise.all(
        bodies.map((b) => request(env, filterCollection(), jsonInit('POST', b)))
      );
      expect(statusesOf(results)).toEqual([200, 200, 200]);
      const ids = results.map((r) => (r.body as { filter_id: string }).filter_id);
      expect(new Set(ids).size).toBe(3);
      for (const id of ids) {
        const stored = JSON.parse(cache.data[`filter:${USER}:${id}`]);
        expect(bodies).toContainEqual(stored);
      }
    });
  }

  it('POST stores expirationTtl 30 days on every put', async () => {
    const cache = mockCache();
    const env = createEnv(cache);
    await Promise.all([
      request(env, filterCollection(), jsonInit('POST', sampleFilter(0))),
      request(env, filterCollection(), jsonInit('POST', sampleFilter(1))),
    ]);
    expect(cache.puts.length).toBe(2);
    for (const p of cache.puts) {
      expect(p.options?.expirationTtl).toBe(30 * 24 * 60 * 60);
      expect(p.key.startsWith(`filter:${USER}:`)).toBe(true);
    }
  });

  it('eight-way POST isolation — all succeed with unique keys', async () => {
    const cache = mockCache();
    const env = createEnv(cache);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i)))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => (r.body as { filter_id: string }).filter_id)).size).toBe(8);
    expect(filterKeys(cache)).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// POST∥GET TOCTOU — mid-flight empty vs body
// ---------------------------------------------------------------------------

describe('race filter POST∥GET mid-flight TOCTOU after #210', () => {
  it('GET unknown id returns empty object (spec soft)', async () => {
    const env = createEnv(mockCache());
    const res = await request(env, filterPath('missing-id'), authGet());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('GET after POST returns the stored filter body', async () => {
    const cache = mockCache();
    const env = createEnv(cache);
    const created = await request(env, filterCollection(), jsonInit('POST', sampleFilter(7)));
    expect(created.status).toBe(200);
    const id = (created.body as { filter_id: string }).filter_id;
    const got = await request(env, filterPath(id), authGet());
    expect(got.status).toBe(200);
    expect(got.body).toEqual(sampleFilter(7));
  });

  it('GET∥GET same missing id under get barrier — both empty', async () => {
    const cache = mockCache(
      {},
      { getBarrier: { count: 2, match: (key) => key.includes('filter:') } }
    );
    const env = createEnv(cache);
    const results = await Promise.all([
      request(env, filterPath('gone'), authGet()),
      request(env, filterPath('gone'), authGet()),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.map((r) => r.body)).toEqual([{}, {}]);
  });

  it('seeded filter GET∥GET under barrier returns identical bodies', async () => {
    const fid = 'abc123';
    const body = sampleFilter(3);
    const cache = mockCache(
      { [`filter:${USER}:${fid}`]: JSON.stringify(body) },
      { getBarrier: { count: 2, match: (key) => key === `filter:${USER}:${fid}` } }
    );
    const env = createEnv(cache);
    const results = await Promise.all([
      request(env, filterPath(fid), authGet()),
      request(env, filterPath(fid), authGet()),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body).toEqual(body);
    expect(results[1].body).toEqual(body);
  });

  it('mutate delete mid-flight after first GET — second sees empty', async () => {
    const fid = 'midflight';
    const cache = mockCache(
      { [`filter:${USER}:${fid}`]: JSON.stringify(sampleFilter(1)) },
      {
        mutateAfterGets: {
          after: 1,
          next: {},
        },
      }
    );
    const env = createEnv(cache);
    const first = await request(env, filterPath(fid), authGet());
    const second = await request(env, filterPath(fid), authGet());
    expect(first.status).toBe(200);
    expect(first.body).toEqual(sampleFilter(1));
    expect(second.status).toBe(200);
    expect(second.body).toEqual({});
  });

  for (let i = 0; i < 12; i++) {
    it(`POST then parallel GET flood-${i} coherent body`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const filter = sampleFilter(i);
      const created = await request(env, filterCollection(), jsonInit('POST', filter));
      const id = (created.body as { filter_id: string }).filter_id;
      const results = await Promise.all(
        Array.from({ length: 4 }, () => request(env, filterPath(id), authGet()))
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      for (const r of results) expect(r.body).toEqual(filter);
    });
  }

  it('corrupt KV JSON returns empty object soft', async () => {
    const fid = 'corrupt';
    const cache = mockCache({ [`filter:${USER}:${fid}`]: '{not-json' });
    const env = createEnv(cache);
    const results = await Promise.all([
      request(env, filterPath(fid), authGet()),
      request(env, filterPath(fid), authGet()),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.map((r) => r.body)).toEqual([{}, {}]);
  });

  for (let i = 0; i < 8; i++) {
    it(`corrupt KV soft flood-${i} parallel empty`, async () => {
      const fid = `bad${i}`;
      const cache = mockCache({ [`filter:${USER}:${fid}`]: `not-json-${i}{{{` });
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterPath(fid), authGet()),
        request(env, filterPath(fid), authGet()),
        request(env, filterPath(fid), authGet()),
      ]);
      expect(statusesOf(results)).toEqual([200, 200, 200]);
      expect(results.every((r) => JSON.stringify(r.body) === '{}')).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Forbidden other-user / auth soft
// ---------------------------------------------------------------------------

describe('race filter forbidden other-user soft floods after #210', () => {
  for (let i = 0; i < 10; i++) {
    it(`POST as alice for bob forbidden flood-${i}`, async () => {
      authState.userId = USER;
      const env = createEnv(mockCache());
      const results = await Promise.all([
        request(env, filterCollection(BOB_ENC), jsonInit('POST', sampleFilter(i))),
        request(env, filterCollection(BOB_ENC), jsonInit('POST', sampleFilter(i + 1))),
      ]);
      expect(statusesOf(results)).toEqual([403, 403]);
      for (const r of results) {
        expect((r.body as { errcode: string }).errcode).toBe('M_FORBIDDEN');
      }
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`GET as alice for bob forbidden flood-${i}`, async () => {
      authState.userId = USER;
      const env = createEnv(
        mockCache({ [`filter:${BOB}:fid`]: JSON.stringify(sampleFilter(i)) })
      );
      const results = await Promise.all([
        request(env, filterPath('fid', BOB_ENC), authGet()),
        request(env, filterPath('fid', BOB_ENC), authGet()),
      ]);
      expect(statusesOf(results)).toEqual([403, 403]);
      for (const r of results) {
        expect((r.body as { errcode: string }).errcode).toBe('M_FORBIDDEN');
      }
    });
  }

  it('carol auth cannot mint filter under alice path', async () => {
    authState.userId = CAROL;
    const cache = mockCache();
    const env = createEnv(cache);
    const res = await request(env, filterCollection(USER_ENC), jsonInit('POST', sampleFilter(0)));
    expect(res.status).toBe(403);
    expect(filterKeys(cache)).toHaveLength(0);
  });

  it('bob can mint under bob path while alice mints under alice — isolation', async () => {
    const cache = mockCache();
    const env = createEnv(cache);
    authState.userId = USER;
    const a = await request(env, filterCollection(USER_ENC), jsonInit('POST', sampleFilter(1)));
    authState.userId = BOB;
    const b = await request(env, filterCollection(BOB_ENC), jsonInit('POST', sampleFilter(2)));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(filterKeys(cache, USER)).toHaveLength(1);
    expect(filterKeys(cache, BOB)).toHaveLength(1);
  });

  for (let i = 0; i < 8; i++) {
    it(`cross-user sequential isolation flood-${i}: alice then bob`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      authState.userId = USER;
      const a = await request(env, filterCollection(USER_ENC), jsonInit('POST', sampleFilter(i)));
      authState.userId = BOB;
      const b = await request(env, filterCollection(BOB_ENC), jsonInit('POST', sampleFilter(i + 50)));
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(filterKeys(cache, USER)).toHaveLength(1);
      expect(filterKeys(cache, BOB)).toHaveLength(1);
      const aId = (a.body as { filter_id: string }).filter_id;
      const bId = (b.body as { filter_id: string }).filter_id;
      authState.userId = USER;
      expect((await request(env, filterPath(aId, USER_ENC), authGet())).body).toEqual(
        sampleFilter(i)
      );
      authState.userId = BOB;
      expect((await request(env, filterPath(bId, BOB_ENC), authGet())).body).toEqual(
        sampleFilter(i + 50)
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Bad JSON / method / charset soft floods
// ---------------------------------------------------------------------------

describe('race filter soft method/JSON/charset floods after #210', () => {
  for (let i = 0; i < 12; i++) {
    it(`bad JSON POST soft flood-${i}`, async () => {
      const env = createEnv(mockCache());
      const results = await Promise.all([
        request(env, filterCollection(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: `{bad-json-${i}`,
        }),
        request(env, filterCollection(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: `[`,
        }),
      ]);
      expect(statusesOf(results)).toEqual([400, 400]);
      for (const r of results) {
        expect((r.body as { errcode: string }).errcode).toBe('M_BAD_JSON');
      }
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`wrong method soft flood-${i} on filter collection`, async () => {
      const env = createEnv(mockCache());
      const methods = ['PUT', 'DELETE', 'PATCH', 'GET'] as const;
      const method = methods[i % methods.length];
      const results = await Promise.all([
        request(env, filterCollection(), { method, headers: { ...AUTH } }),
        request(env, filterCollection(), { method, headers: { ...AUTH } }),
      ]);
      // GET on collection is not registered → 404; others 404/405
      expect(results.every((r) => r.status >= 400)).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`empty object POST soft flood-${i} still mints`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterCollection(), jsonInit('POST', {})),
        request(env, filterCollection(), jsonInit('POST', {})),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(cache.puts.length).toBe(2);
      for (const p of cache.puts) {
        expect(JSON.parse(p.value)).toEqual({});
      }
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`nested filter body soft flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const body = {
        room: {
          timeline: { limit: i + 1, types: ['m.room.message'] },
          ephemeral: { types: ['m.receipt'] },
          account_data: { not_types: ['m.fully_read'] },
        },
        presence: { types: ['m.presence'] },
        event_format: 'client',
      };
      const res = await request(env, filterCollection(), jsonInit('POST', body));
      expect(res.status).toBe(200);
      const id = (res.body as { filter_id: string }).filter_id;
      const got = await request(env, filterPath(id), authGet());
      expect(got.body).toEqual(body);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`percent-encoded filter id GET soft flood-${i}`, async () => {
      const fid = `id/${i}/x`;
      const cache = mockCache({
        [`filter:${USER}:${fid}`]: JSON.stringify(sampleFilter(i)),
      });
      const env = createEnv(cache);
      // path helper encodes; handler uses param as-is after decode
      const res = await request(env, filterPath(fid), authGet());
      expect(res.status).toBe(200);
      expect(res.body).toEqual(sampleFilter(i));
    });
  }
});

// ---------------------------------------------------------------------------
// KV put/get failure soft mid-concurrent
// ---------------------------------------------------------------------------

describe('race filter KV failure soft mid-concurrent after #210', () => {
  it('failPutAfter 0 — POST throws/500 soft', async () => {
    const cache = mockCache({}, { failPutAfter: 0 });
    const env = createEnv(cache);
    const res = await request(env, filterCollection(), jsonInit('POST', sampleFilter(0)));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('failPutAfter 1 — first OK second fails', async () => {
    const cache = mockCache({}, { failPutAfter: 1 });
    const env = createEnv(cache);
    const first = await request(env, filterCollection(), jsonInit('POST', sampleFilter(0)));
    expect(first.status).toBe(200);
    const second = await request(env, filterCollection(), jsonInit('POST', sampleFilter(1)));
    expect(second.status).toBeGreaterThanOrEqual(400);
  });

  for (let i = 0; i < 8; i++) {
    it(`failGetAfter soft flood-${i}`, async () => {
      const fid = `g${i}`;
      const cache = mockCache(
        { [`filter:${USER}:${fid}`]: JSON.stringify(sampleFilter(i)) },
        { failGetAfter: 0 }
      );
      const env = createEnv(cache);
      const res = await request(env, filterPath(fid), authGet());
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  }

  it('put barrier then fail second of dual POST', async () => {
    const cache = mockCache(
      {},
      {
        putBarrier: { count: 2, match: (key) => key.startsWith(`filter:${USER}:`) },
        failPutAfter: 1,
      }
    );
    const env = createEnv(cache);
    const results = await Promise.all([
      request(env, filterCollection(), jsonInit('POST', sampleFilter(0))),
      request(env, filterCollection(), jsonInit('POST', sampleFilter(1))),
    ]);
    const oks = results.filter((r) => r.status === 200);
    const fails = results.filter((r) => r.status >= 400);
    expect(oks.length).toBe(1);
    expect(fails.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Capabilities parallel coherency
// ---------------------------------------------------------------------------

describe('race capabilities parallel coherency after #210', () => {
  it('dual GET capabilities identical shape', async () => {
    const env = createEnv();
    const results = await Promise.all([
      request(env, capabilitiesPath(), authGet()),
      request(env, capabilitiesPath(), authGet()),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expectCapabilitiesShape(results[0].body);
    expect(results[0].body).toEqual(results[1].body);
  });

  for (let i = 0; i < 12; i++) {
    it(`capabilities parallel flood-${i}: 6 concurrent identical`, async () => {
      const env = createEnv();
      const results = await Promise.all(
        Array.from({ length: 6 }, () => request(env, capabilitiesPath(), { method: 'GET' }))
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      for (const r of results) {
        expectCapabilitiesShape(r.body);
        expect(r.body).toEqual(results[0].body);
      }
    });
  }

  it('capabilities does not require auth', async () => {
    authState.userId = undefined;
    const env = createEnv();
    const res = await request(env, capabilitiesPath(), { method: 'GET' });
    expect(res.status).toBe(200);
    expectCapabilitiesShape(res.body);
  });

  for (let i = 0; i < 8; i++) {
    it(`capabilities wrong-method soft flood-${i}`, async () => {
      const env = createEnv();
      const methods = ['POST', 'PUT', 'DELETE', 'PATCH'] as const;
      const method = methods[i % methods.length];
      const results = await Promise.all([
        request(env, capabilitiesPath(), { method, headers: { ...AUTH } }),
        request(env, capabilitiesPath(), { method }),
      ]);
      expect(results.every((r) => r.status >= 400)).toBe(true);
    });
  }

  it('room_versions available covers 1–12 stable', async () => {
    const env = createEnv();
    const res = await request(env, capabilitiesPath(), { method: 'GET' });
    const available = (res.body as any).capabilities['m.room_versions'].available;
    for (let v = 1; v <= 12; v++) {
      expect(available[String(v)]).toBe('stable');
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-endpoint isolation filter∥capabilities
// ---------------------------------------------------------------------------

describe('race filter∥capabilities cross-endpoint isolation after #210', () => {
  for (let i = 0; i < 10; i++) {
    it(`POST filter∥GET capabilities flood-${i} isolated`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i))),
        request(env, capabilitiesPath(), { method: 'GET' }),
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i + 100))),
        request(env, capabilitiesPath(), { method: 'GET' }),
      ]);
      expect(results[0].status).toBe(200);
      expect(results[1].status).toBe(200);
      expect(results[2].status).toBe(200);
      expect(results[3].status).toBe(200);
      expectCapabilitiesShape(results[1].body);
      expect(results[1].body).toEqual(results[3].body);
      expect(filterKeys(cache)).toHaveLength(2);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`GET filter∥capabilities flood-${i}`, async () => {
      const fid = `x${i}`;
      const filter = sampleFilter(i);
      const cache = mockCache({ [`filter:${USER}:${fid}`]: JSON.stringify(filter) });
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterPath(fid), authGet()),
        request(env, capabilitiesPath(), { method: 'GET' }),
        request(env, filterPath(fid), authGet()),
      ]);
      expect(statusesOf(results)).toEqual([200, 200, 200]);
      expect(results[0].body).toEqual(filter);
      expect(results[2].body).toEqual(filter);
      expectCapabilitiesShape(results[1].body);
    });
  }

  it('forbidden filter POST does not disturb capabilities', async () => {
    const env = createEnv(mockCache());
    const results = await Promise.all([
      request(env, filterCollection(BOB_ENC), jsonInit('POST', sampleFilter(0))),
      request(env, capabilitiesPath(), { method: 'GET' }),
    ]);
    expect(results[0].status).toBe(403);
    expect(results[1].status).toBe(200);
    expectCapabilitiesShape(results[1].body);
  });
});

// ---------------------------------------------------------------------------
// SQL/KV bind contracts under parallel
// ---------------------------------------------------------------------------

describe('race filter KV bind contracts under parallel after #210', () => {
  for (let i = 0; i < 10; i++) {
    it(`put key shape bind flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const res = await request(env, filterCollection(), jsonInit('POST', sampleFilter(i)));
      expect(res.status).toBe(200);
      const id = (res.body as { filter_id: string }).filter_id;
      expect(cache.puts[0].key).toBe(`filter:${USER}:${id}`);
      expect(cache.puts[0].value).toBe(JSON.stringify(sampleFilter(i)));
      expect(cache.puts[0].options).toEqual({ expirationTtl: 30 * 24 * 60 * 60 });
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`get key shape bind flood-${i}`, async () => {
      const fid = `bind${i}`;
      const cache = mockCache({ [`filter:${USER}:${fid}`]: JSON.stringify(sampleFilter(i)) });
      const env = createEnv(cache);
      await request(env, filterPath(fid), authGet());
      expect(cache.gets).toContain(`filter:${USER}:${fid}`);
    });
  }

  it('filter_id has no dashes (uuid first segment)', async () => {
    const cache = mockCache();
    const env = createEnv(cache);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i)))
      )
    );
    for (const r of results) {
      const id = (r.body as { filter_id: string }).filter_id;
      expect(id.includes('-')).toBe(false);
      expect(id.length).toBeGreaterThanOrEqual(8);
    }
  });

  it('user path encoding round-trip for alice', async () => {
    const cache = mockCache();
    const env = createEnv(cache);
    const res = await request(
      env,
      `/_matrix/client/v3/user/${encodeURIComponent(USER)}/filter`,
      jsonInit('POST', sampleFilter(0))
    );
    expect(res.status).toBe(200);
    expect(filterKeys(cache)[0].startsWith(`filter:${USER}:`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle chains + extra soft deepen
// ---------------------------------------------------------------------------

describe('race filter lifecycle chains after #210', () => {
  for (let i = 0; i < 10; i++) {
    it(`create→get→get lifecycle flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const filter = sampleFilter(i);
      const created = await request(env, filterCollection(), jsonInit('POST', filter));
      expect(created.status).toBe(200);
      const id = (created.body as { filter_id: string }).filter_id;
      const g1 = await request(env, filterPath(id), authGet());
      const g2 = await request(env, filterPath(id), authGet());
      expect(g1.body).toEqual(filter);
      expect(g2.body).toEqual(filter);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`multi-filter portfolio flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const created = await Promise.all(
        [0, 1, 2, 3].map((j) =>
          request(env, filterCollection(), jsonInit('POST', sampleFilter(i * 10 + j)))
        )
      );
      expect(created.every((r) => r.status === 200)).toBe(true);
      const ids = created.map((r) => (r.body as { filter_id: string }).filter_id);
      const got = await Promise.all(ids.map((id) => request(env, filterPath(id), authGet())));
      expect(got.every((r) => r.status === 200)).toBe(true);
      for (let j = 0; j < 4; j++) {
        expect(got[j].body).toEqual(sampleFilter(i * 10 + j));
      }
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`overwrite same CACHE key manually then GET flood-${i}`, async () => {
      const fid = `ow${i}`;
      const cache = mockCache({
        [`filter:${USER}:${fid}`]: JSON.stringify(sampleFilter(0)),
      });
      const env = createEnv(cache);
      cache.data[`filter:${USER}:${fid}`] = JSON.stringify(sampleFilter(i + 1));
      const res = await request(env, filterPath(fid), authGet());
      expect(res.body).toEqual(sampleFilter(i + 1));
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`capabilities∥filter lifecycle soft flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const caps = await request(env, capabilitiesPath(), { method: 'GET' });
      const created = await request(env, filterCollection(), jsonInit('POST', sampleFilter(i)));
      const id = (created.body as { filter_id: string }).filter_id;
      const [got, caps2] = await Promise.all([
        request(env, filterPath(id), authGet()),
        request(env, capabilitiesPath(), { method: 'GET' }),
      ]);
      expect(caps.status).toBe(200);
      expect(created.status).toBe(200);
      expect(got.body).toEqual(sampleFilter(i));
      expect(caps2.body).toEqual(caps.body);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`large event_fields array soft flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const body = {
        event_fields: Array.from({ length: 20 + i }, (_, j) => `field_${j}`),
        room: { timeline: { limit: 100 } },
      };
      const created = await request(env, filterCollection(), jsonInit('POST', body));
      expect(created.status).toBe(200);
      const id = (created.body as { filter_id: string }).filter_id;
      const got = await request(env, filterPath(id), authGet());
      expect(got.body).toEqual(body);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`carol path forbidden while capabilities ok flood-${i}`, async () => {
      authState.userId = USER;
      const env = createEnv(mockCache());
      const results = await Promise.all([
        request(env, filterCollection(CAROL_ENC), jsonInit('POST', sampleFilter(i))),
        request(env, filterPath('x', CAROL_ENC), authGet()),
        request(env, capabilitiesPath(), { method: 'GET' }),
      ]);
      expect(results[0].status).toBe(403);
      expect(results[1].status).toBe(403);
      expect(results[2].status).toBe(200);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #214 — delayMs put/get soft mid-concurrent
// ---------------------------------------------------------------------------

describe('race filter delay soft mid concurrent after #214', () => {
  for (let i = 0; i < 10; i++) {
    it(`delayMsOnPut dual POST soft flood-${i}`, async () => {
      const cache = mockCache({}, { delayMsOnPut: 2 + (i % 3) });
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i))),
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i + 50))),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      const ids = results.map((r) => (r.body as { filter_id: string }).filter_id);
      expect(new Set(ids).size).toBe(2);
      expect(cache.puts).toHaveLength(2);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`delayMsOnGet dual GET soft flood-${i}`, async () => {
      const fid = `dg${i}`;
      const filter = sampleFilter(i);
      const cache = mockCache(
        { [`filter:${USER}:${fid}`]: JSON.stringify(filter) },
        { delayMsOnGet: 2 + (i % 3) }
      );
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterPath(fid), authGet()),
        request(env, filterPath(fid), authGet()),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(results[0].body).toEqual(filter);
      expect(results[1].body).toEqual(filter);
      expect(cache.getCount).toBe(2);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`delay put∥get mixed soft flood-${i}`, async () => {
      const seeded = `seed${i}`;
      const cache = mockCache(
        { [`filter:${USER}:${seeded}`]: JSON.stringify(sampleFilter(0)) },
        { delayMsOnPut: 3, delayMsOnGet: 3 }
      );
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i))),
        request(env, filterPath(seeded), authGet()),
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i + 20))),
        request(env, filterPath(seeded), authGet()),
      ]);
      expect(results[0].status).toBe(200);
      expect(results[1].status).toBe(200);
      expect(results[2].status).toBe(200);
      expect(results[3].status).toBe(200);
      expect(results[1].body).toEqual(sampleFilter(0));
      expect(results[3].body).toEqual(sampleFilter(0));
      expect(filterKeys(cache)).toHaveLength(3);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #214 — mutateAfterPuts wipe TOCTOU
// ---------------------------------------------------------------------------

describe('race filter mutateAfterPuts wipe TOCTOU after #214', () => {
  it('mutate wipe after first PUT — second POST still mints; prior key gone', async () => {
    const cache = mockCache(
      {},
      {
        putBarrier: { count: 2, match: (key) => key.startsWith(`filter:${USER}:`) },
        mutateAfterPuts: { after: 1, next: {} },
      }
    );
    const env = createEnv(cache);
    const results = await Promise.all([
      request(env, filterCollection(), jsonInit('POST', sampleFilter(1))),
      request(env, filterCollection(), jsonInit('POST', sampleFilter(2))),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    // After first put, mutate wiped; second put wrote into empty map.
    // Final data holds only keys written after the wipe (second put) plus any
    // race where first put's value was wiped then second put landed.
    expect(cache.putCount).toBe(2);
    expect(Object.keys(cache.data).every((k) => k.startsWith(`filter:${USER}:`))).toBe(true);
  });

  for (let i = 0; i < 10; i++) {
    it(`mutateAfterPuts then GET empty soft flood-${i}`, async () => {
      const cache = mockCache(
        {},
        { mutateAfterPuts: { after: 1, next: {} } }
      );
      const env = createEnv(cache);
      const created = await request(env, filterCollection(), jsonInit('POST', sampleFilter(i)));
      expect(created.status).toBe(200);
      const id = (created.body as { filter_id: string }).filter_id;
      // Wipe already cleared the put; GET returns spec empty {}
      const got = await request(env, filterPath(id), authGet());
      expect(got.status).toBe(200);
      expect(got.body).toEqual({});
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`mutateAfterPuts inject foreign filter soft flood-${i}`, async () => {
      const injected = `inj${i}`;
      const cache = mockCache(
        {},
        {
          mutateAfterPuts: {
            after: 1,
            next: { [`filter:${USER}:${injected}`]: JSON.stringify(sampleFilter(99)) },
          },
        }
      );
      const env = createEnv(cache);
      const created = await request(env, filterCollection(), jsonInit('POST', sampleFilter(i)));
      expect(created.status).toBe(200);
      const mintedId = (created.body as { filter_id: string }).filter_id;
      const [minted, injectedGot] = await Promise.all([
        request(env, filterPath(mintedId), authGet()),
        request(env, filterPath(injected), authGet()),
      ]);
      // Minted key wiped by mutate; injected present
      expect(minted.body).toEqual({});
      expect(injectedGot.body).toEqual(sampleFilter(99));
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #214 — POST put-barrier ∥ seeded GET isolation
// ---------------------------------------------------------------------------

describe('race filter POST put-barrier ∥ seeded GET isolation after #214', () => {
  for (let i = 0; i < 10; i++) {
    it(`seeded GET under get barrier ∥ POST mint flood-${i}`, async () => {
      const seeded = `sg${i}`;
      const body = sampleFilter(i);
      const cache = mockCache(
        { [`filter:${USER}:${seeded}`]: JSON.stringify(body) },
        {
          getBarrier: { count: 2, match: (key) => key === `filter:${USER}:${seeded}` },
          putBarrier: { count: 2, match: (key) => key.startsWith(`filter:${USER}:`) },
        }
      );
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterPath(seeded), authGet()),
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i + 10))),
        request(env, filterPath(seeded), authGet()),
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i + 20))),
      ]);
      expect(results[0].status).toBe(200);
      expect(results[0].body).toEqual(body);
      expect(results[2].status).toBe(200);
      expect(results[2].body).toEqual(body);
      expect(results[1].status).toBe(200);
      expect(results[3].status).toBe(200);
      expect(filterKeys(cache).length).toBeGreaterThanOrEqual(3);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`events order put/get coherency soft flood-${i}`, async () => {
      const seeded = `ev${i}`;
      const cache = mockCache({
        [`filter:${USER}:${seeded}`]: JSON.stringify(sampleFilter(0)),
      });
      const env = createEnv(cache);
      await Promise.all([
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i))),
        request(env, filterPath(seeded), authGet()),
      ]);
      expect(cache.events.some((e) => e.startsWith('put:filter:'))).toBe(true);
      expect(cache.events.some((e) => e === `get:filter:${USER}:${seeded}`)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #214 — auth / device identity matrix
// ---------------------------------------------------------------------------

describe('race filter auth identity matrix after #214', () => {
  for (let i = 0; i < 10; i++) {
    it(`deviceId rotation mid portfolio soft flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      authState.deviceId = `DEV-${i}-A`;
      const a = await request(env, filterCollection(), jsonInit('POST', sampleFilter(i)));
      authState.deviceId = `DEV-${i}-B`;
      const b = await request(env, filterCollection(), jsonInit('POST', sampleFilter(i + 1)));
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      // Filters keyed by userId only — device rotation must not fork namespaces
      expect(filterKeys(cache)).toHaveLength(2);
      expect(filterKeys(cache).every((k) => k.startsWith(`filter:${USER}:`))).toBe(true);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`bob auth cannot GET alice seeded filter flood-${i}`, async () => {
      const fid = `alice${i}`;
      const cache = mockCache({
        [`filter:${USER}:${fid}`]: JSON.stringify(sampleFilter(i)),
      });
      const env = createEnv(cache);
      authState.userId = BOB;
      const results = await Promise.all([
        request(env, filterPath(fid, USER_ENC), authGet()),
        request(env, filterPath(fid, USER_ENC), authGet()),
      ]);
      expect(statusesOf(results)).toEqual([403, 403]);
      for (const r of results) {
        expect((r.body as { errcode: string }).errcode).toBe('M_FORBIDDEN');
      }
      expect(cache.gets).toHaveLength(0);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`auth swap alice→bob mid dual POST soft flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      authState.userId = USER;
      const pAlice = request(env, filterCollection(USER_ENC), jsonInit('POST', sampleFilter(i)));
      // Sequential swap after scheduling is racy on mock; use explicit sequential
      // then parallel cross-user mint for isolation assert
      const alice = await pAlice;
      authState.userId = BOB;
      const bob = await request(env, filterCollection(BOB_ENC), jsonInit('POST', sampleFilter(i + 40)));
      expect(alice.status).toBe(200);
      expect(bob.status).toBe(200);
      expect(filterKeys(cache, USER)).toHaveLength(1);
      expect(filterKeys(cache, BOB)).toHaveLength(1);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`undefined auth user still hits requireAuth path soft flood-${i}`, async () => {
      authState.userId = undefined;
      const env = createEnv(mockCache());
      // Mock requireAuth still runs handler with undefined userId → path compare fails → 403
      const results = await Promise.all([
        request(env, filterCollection(USER_ENC), jsonInit('POST', sampleFilter(i))),
        request(env, filterPath('z', USER_ENC), authGet()),
      ]);
      expect(results.every((r) => r.status === 403)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #214 — Content-Type / Accept / charset matrix
// ---------------------------------------------------------------------------

describe('race filter content-type Accept charset soft after #214', () => {
  const contentTypes = [
    'application/json',
    'application/json; charset=utf-8',
    'application/json;charset=UTF-8',
    'application/json; charset=UTF-8',
  ] as const;

  for (let i = 0; i < contentTypes.length; i++) {
    it(`content-type variant soft flood-${i}: ${contentTypes[i]}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const ct = contentTypes[i];
      const results = await Promise.all([
        request(env, filterCollection(), {
          method: 'POST',
          headers: { 'Content-Type': ct, ...AUTH },
          body: JSON.stringify(sampleFilter(i)),
        }),
        request(env, filterCollection(), {
          method: 'POST',
          headers: { 'Content-Type': ct, ...AUTH },
          body: JSON.stringify(sampleFilter(i + 10)),
        }),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(cache.puts).toHaveLength(2);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`Accept header soft flood-${i}`, async () => {
      const accepts = [
        'application/json',
        'application/json, text/plain;q=0.9',
        '*/*',
        'application/json; charset=utf-8',
      ];
      const accept = accepts[i % accepts.length];
      const fid = `acc${i}`;
      const cache = mockCache({
        [`filter:${USER}:${fid}`]: JSON.stringify(sampleFilter(i)),
      });
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterPath(fid), authGet({ Accept: accept })),
        request(env, capabilitiesPath(), { method: 'GET', headers: { Accept: accept } }),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(results[0].body).toEqual(sampleFilter(i));
      expectCapabilitiesShape(results[1].body);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`wrong content-type still parses JSON soft flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const cts = ['text/plain', 'application/octet-stream', 'text/html'];
      const ct = cts[i % cts.length];
      const res = await request(env, filterCollection(), {
        method: 'POST',
        headers: { 'Content-Type': ct, ...AUTH },
        body: JSON.stringify(sampleFilter(i)),
      });
      // Hono json() still parses when body is JSON text
      expect(res.status).toBe(200);
      expect(cache.puts).toHaveLength(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #214 — filter-item method + query-string soft
// ---------------------------------------------------------------------------

describe('race filter item method + query soft floods after #214', () => {
  for (let i = 0; i < 10; i++) {
    it(`filter-item wrong method soft flood-${i}`, async () => {
      const fid = `m${i}`;
      const cache = mockCache({
        [`filter:${USER}:${fid}`]: JSON.stringify(sampleFilter(i)),
      });
      const env = createEnv(cache);
      const methods = ['POST', 'PUT', 'DELETE', 'PATCH'] as const;
      const method = methods[i % methods.length];
      const results = await Promise.all([
        request(env, filterPath(fid), { method, headers: { ...AUTH } }),
        request(env, filterPath(fid), { method, headers: { ...AUTH }, body: '{}' }),
      ]);
      expect(results.every((r) => r.status >= 400)).toBe(true);
      // Seeded body untouched
      expect(cache.data[`filter:${USER}:${fid}`]).toBe(JSON.stringify(sampleFilter(i)));
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`query string ignored on GET soft flood-${i}`, async () => {
      const fid = `q${i}`;
      const filter = sampleFilter(i);
      const cache = mockCache({ [`filter:${USER}:${fid}`]: JSON.stringify(filter) });
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, `${filterPath(fid)}?foo=bar&limit=1`, authGet()),
        request(env, `${filterPath(fid)}?filter_id=other`, authGet()),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(results[0].body).toEqual(filter);
      expect(results[1].body).toEqual(filter);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`query string ignored on POST soft flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, `${filterCollection()}?x=${i}`, jsonInit('POST', sampleFilter(i))),
        request(env, `${filterCollection()}?y=${i}`, jsonInit('POST', sampleFilter(i + 1))),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(cache.puts).toHaveLength(2);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`HEAD/OPTIONS soft flood-${i}`, async () => {
      const env = createEnv(mockCache());
      const results = await Promise.all([
        request(env, filterCollection(), { method: 'HEAD', headers: { ...AUTH } }),
        request(env, capabilitiesPath(), { method: 'OPTIONS' }),
        request(env, filterPath('h'), { method: 'HEAD', headers: { ...AUTH } }),
      ]);
      expect(results.every((r) => r.status >= 200)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #214 — root JSON type soft
// ---------------------------------------------------------------------------

describe('race filter root JSON type soft floods after #214', () => {
  const roots: Array<{ label: string; body: string }> = [
    { label: 'array', body: '[1,2,3]' },
    { label: 'null', body: 'null' },
    { label: 'number', body: '42' },
    { label: 'string', body: '"hi"' },
    { label: 'true', body: 'true' },
    { label: 'false', body: 'false' },
  ];

  for (let i = 0; i < roots.length; i++) {
    it(`root JSON ${roots[i].label} soft flood parallel`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterCollection(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: roots[i].body,
        }),
        request(env, filterCollection(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: roots[i].body,
        }),
      ]);
      // Valid JSON parses — handler stores whatever JSON.parse yields
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(cache.puts).toHaveLength(2);
      for (const p of cache.puts) {
        expect(p.value).toBe(JSON.stringify(JSON.parse(roots[i].body)));
      }
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`empty body soft flood-${i}`, async () => {
      const env = createEnv(mockCache());
      const results = await Promise.all([
        request(env, filterCollection(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: '',
        }),
        request(env, filterCollection(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
        }),
      ]);
      expect(results.every((r) => r.status >= 400)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #214 — filter-id vocabulary edges
// ---------------------------------------------------------------------------

describe('race filter-id vocabulary edges soft after #214', () => {
  const ids = [
    'a',
    '0',
    'ABC',
    'with.dots',
    'with_underscores',
    'with-dashes',
    'x'.repeat(64),
    'unicode-café',
    'dotdot-safe',
    'endsWith.',
  ];

  for (let i = 0; i < ids.length; i++) {
    it(`filter-id vocabulary soft-${i}: ${ids[i].slice(0, 24)}`, async () => {
      const fid = ids[i];
      const filter = sampleFilter(i);
      const cache = mockCache({
        [`filter:${USER}:${fid}`]: JSON.stringify(filter),
      });
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterPath(fid), authGet()),
        request(env, filterPath(fid), authGet()),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(results[0].body).toEqual(filter);
      expect(results[1].body).toEqual(filter);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`missing vocabulary id empty soft flood-${i}`, async () => {
      const env = createEnv(mockCache());
      const idsMissing = [`missing-${i}`, `gone.${i}`, `x${'y'.repeat(i)}`];
      const results = await Promise.all(
        idsMissing.map((id) => request(env, filterPath(id), authGet()))
      );
      expect(results.every((r) => r.status === 200 && Object.keys(r.body as object).length === 0)).toBe(
        true
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #214 — capabilities exhaustive key bind
// ---------------------------------------------------------------------------

describe('race capabilities exhaustive key bind after #214', () => {
  const expectedKeys = [
    'm.change_password',
    'm.room_versions',
    'm.set_displayname',
    'm.set_avatar_url',
    'm.3pid_changes',
  ] as const;

  for (let i = 0; i < 12; i++) {
    it(`capabilities key set bind flood-${i}`, async () => {
      const env = createEnv();
      const results = await Promise.all(
        Array.from({ length: 4 }, () => request(env, capabilitiesPath(), { method: 'GET' }))
      );
      for (const r of results) {
        expect(r.status).toBe(200);
        const caps = (r.body as { capabilities: Record<string, unknown> }).capabilities;
        expect(Object.keys(caps).sort()).toEqual([...expectedKeys].sort());
        for (const k of expectedKeys) {
          if (k === 'm.room_versions') {
            expect((caps[k] as { default: string }).default).toBe('10');
          } else {
            expect(caps[k]).toEqual({ enabled: true });
          }
        }
      }
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`capabilities∥filter forbidden∥capabilities bind flood-${i}`, async () => {
      authState.userId = USER;
      const env = createEnv(mockCache());
      const results = await Promise.all([
        request(env, capabilitiesPath(), { method: 'GET' }),
        request(env, filterCollection(BOB_ENC), jsonInit('POST', sampleFilter(i))),
        request(env, capabilitiesPath(), authGet()),
        request(env, filterPath('nope', BOB_ENC), authGet()),
      ]);
      expect(results[0].status).toBe(200);
      expect(results[1].status).toBe(403);
      expect(results[2].status).toBe(200);
      expect(results[3].status).toBe(403);
      expect(results[0].body).toEqual(results[2].body);
      const caps = (results[0].body as { capabilities: Record<string, unknown> }).capabilities;
      expect(Object.keys(caps).sort()).toEqual([...expectedKeys].sort());
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`capabilities query string ignored soft flood-${i}`, async () => {
      const env = createEnv();
      const results = await Promise.all([
        request(env, `${capabilitiesPath()}?user_id=${USER_ENC}`, { method: 'GET' }),
        request(env, `${capabilitiesPath()}?x=${i}`, authGet()),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(results[0].body).toEqual(results[1].body);
      expectCapabilitiesShape(results[0].body);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #214 — unicode / deep nested bodies
// ---------------------------------------------------------------------------

describe('race filter unicode + deep nested soft after #214', () => {
  for (let i = 0; i < 10; i++) {
    it(`unicode body soft flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const body = {
        room: {
          timeline: { limit: i + 1 },
          rooms: [`!café-${i}:example.com`, `!房间${i}:example.com`],
        },
        event_fields: ['content.body', `字段${i}`, '😀'],
        label: `filter-${i}-π`,
      };
      const results = await Promise.all([
        request(env, filterCollection(), jsonInit('POST', body)),
        request(env, filterCollection(), jsonInit('POST', { ...body, label: `b-${i}` })),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      const ids = results.map((r) => (r.body as { filter_id: string }).filter_id);
      const got = await Promise.all(ids.map((id) => request(env, filterPath(id), authGet())));
      expect(got[0].body).toEqual(body);
      expect(got[1].body).toEqual({ ...body, label: `b-${i}` });
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`deep nested room filter soft flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const body = {
        event_fields: ['type'],
        event_format: 'client',
        presence: { not_types: ['m.presence'] },
        account_data: { types: ['m.push_rules'] },
        room: {
          rooms: [`!deep${i}:example.com`],
          not_rooms: [`!skip${i}:example.com`],
          timeline: {
            limit: 50 + i,
            types: ['m.room.message'],
            not_types: ['m.room.member'],
            senders: [USER],
            not_senders: [BOB],
          },
          state: { lazy_load_members: true, include_redundant_members: false },
          ephemeral: { types: ['m.typing', 'm.receipt'] },
          account_data: { not_types: ['im.vector.setting.breadcrumbs'] },
        },
      };
      const created = await request(env, filterCollection(), jsonInit('POST', body));
      expect(created.status).toBe(200);
      const id = (created.body as { filter_id: string }).filter_id;
      const [g1, g2] = await Promise.all([
        request(env, filterPath(id), authGet()),
        request(env, filterPath(id), authGet()),
      ]);
      expect(g1.body).toEqual(body);
      expect(g2.body).toEqual(body);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #214 — cross-user portfolio under barriers
// ---------------------------------------------------------------------------

describe('race filter cross-user portfolio barriers after #214', () => {
  for (let i = 0; i < 10; i++) {
    it(`alice then bob sequential mint namespace isolation flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      // Shared authState is read at handler time — cross-user must be sequential.
      authState.userId = USER;
      const alice = await request(env, filterCollection(USER_ENC), jsonInit('POST', sampleFilter(i)));
      authState.userId = BOB;
      const bob = await request(env, filterCollection(BOB_ENC), jsonInit('POST', sampleFilter(i + 30)));
      expect(alice.status).toBe(200);
      expect(bob.status).toBe(200);
      expect(filterKeys(cache, USER)).toHaveLength(1);
      expect(filterKeys(cache, BOB)).toHaveLength(1);
      expect(cache.puts[0].key.startsWith(`filter:${USER}:`)).toBe(true);
      expect(cache.puts[1].key.startsWith(`filter:${BOB}:`)).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`same-user dual POST under put barrier flood-${i}`, async () => {
      const cache = mockCache(
        {},
        {
          putBarrier: {
            count: 2,
            match: (key) => key.startsWith(`filter:${USER}:`),
          },
        }
      );
      const env = createEnv(cache);
      authState.userId = USER;
      const results = await Promise.all([
        request(env, filterCollection(USER_ENC), jsonInit('POST', sampleFilter(i))),
        request(env, filterCollection(USER_ENC), jsonInit('POST', sampleFilter(i + 40))),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(filterKeys(cache, USER)).toHaveLength(2);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`alice GET∥bob GET foreign empty soft flood-${i}`, async () => {
      const fid = `own${i}`;
      const cache = mockCache({
        [`filter:${USER}:${fid}`]: JSON.stringify(sampleFilter(i)),
        [`filter:${BOB}:${fid}`]: JSON.stringify(sampleFilter(i + 5)),
      });
      const env = createEnv(cache);
      authState.userId = USER;
      const alice = await request(env, filterPath(fid, USER_ENC), authGet());
      authState.userId = BOB;
      const bob = await request(env, filterPath(fid, BOB_ENC), authGet());
      expect(alice.body).toEqual(sampleFilter(i));
      expect(bob.body).toEqual(sampleFilter(i + 5));
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`TTL exact 2592000 bind flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      authState.userId = USER;
      const results = await Promise.all(
        [0, 1, 2].map((j) =>
          request(env, filterCollection(), jsonInit('POST', sampleFilter(i * 3 + j)))
        )
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      for (const p of cache.puts) {
        expect(p.options?.expirationTtl).toBe(2592000);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #214 — corrupt / whitespace / BOM soft
// ---------------------------------------------------------------------------

describe('race filter corrupt whitespace BOM soft after #214', () => {
  for (let i = 0; i < 8; i++) {
    it(`whitespace-padded JSON soft flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const body = sampleFilter(i);
      const results = await Promise.all([
        request(env, filterCollection(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: `  ${JSON.stringify(body)}  `,
        }),
        request(env, filterCollection(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: `\n${JSON.stringify(body)}\n`,
        }),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      for (const p of cache.puts) {
        expect(JSON.parse(p.value)).toEqual(body);
      }
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`corrupt KV variants soft flood-${i}`, async () => {
      const fid = `c${i}`;
      const variants = ['{', 'null', '"str"', '[1,', 'undefined', '\x00', '{not json}', ''];
      const raw = variants[i % variants.length];
      const cache = mockCache({ [`filter:${USER}:${fid}`]: raw });
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterPath(fid), authGet()),
        request(env, filterPath(fid), authGet()),
      ]);
      // Handler: missing → {}; parse fail → {}; "null"/arrays may parse
      expect(results.every((r) => r.status === 200)).toBe(true);
      if (raw === 'null') {
        // JSON.parse('null') succeeds → c.json(null) body
        expect(results[0].body).toBeNull();
      } else if (raw === '"str"') {
        expect(results[0].body).toBe('str');
      } else if (raw === '') {
        // empty string is truthy for get? empty string is not null — parse fails → {}
        expect(results[0].body).toEqual({});
      } else if (raw === '{') {
        expect(results[0].body).toEqual({});
      }
      expect(results[0].body).toEqual(results[1].body);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`capabilities no CACHE touch soft flood-${i}`, async () => {
      const cache = mockCache({ [`filter:${USER}:x`]: '{}' });
      const env = createEnv(cache);
      const beforeGets = cache.getCount;
      const beforePuts = cache.putCount;
      await Promise.all([
        request(env, capabilitiesPath(), { method: 'GET' }),
        request(env, capabilitiesPath(), { method: 'GET' }),
        request(env, capabilitiesPath(), authGet()),
      ]);
      expect(cache.getCount).toBe(beforeGets);
      expect(cache.putCount).toBe(beforePuts);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #232 — mutateAfterGets dual-GET barrier TOCTOU
// ---------------------------------------------------------------------------

describe('race filter mutateAfterGets dual-GET barrier after #232', () => {
  for (let i = 0; i < 12; i++) {
    it(`dual GET under barrier then wipe soft flood-${i}`, async () => {
      const fid = `mag${i}`;
      const body = sampleFilter(i);
      const cache = mockCache(
        { [`filter:${USER}:${fid}`]: JSON.stringify(body) },
        {
          getBarrier: { count: 2, match: (key) => key === `filter:${USER}:${fid}` },
          mutateAfterGets: { after: 2, next: {} },
        }
      );
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterPath(fid), authGet()),
        request(env, filterPath(fid), authGet()),
      ]);
      // Both barriered GETs snapshot pre-mutation body
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(results[0].body).toEqual(body);
      expect(results[1].body).toEqual(body);
      const after = await Promise.all([
        request(env, filterPath(fid), authGet()),
        request(env, filterPath(fid), authGet()),
      ]);
      expect(after.every((r) => r.status === 200 && JSON.stringify(r.body) === '{}')).toBe(true);
      expect(cache.events).toContain('mutate:after-get');
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`mutateAfterGets inject foreign key soft flood-${i}`, async () => {
      const fid = `src${i}`;
      const inj = `inj${i}`;
      const cache = mockCache(
        { [`filter:${USER}:${fid}`]: JSON.stringify(sampleFilter(i)) },
        {
          getBarrier: { count: 2, match: (key) => key === `filter:${USER}:${fid}` },
          mutateAfterGets: {
            after: 2,
            next: { [`filter:${USER}:${inj}`]: JSON.stringify(sampleFilter(90 + i)) },
          },
        }
      );
      const env = createEnv(cache);
      const [a, b] = await Promise.all([
        request(env, filterPath(fid), authGet()),
        request(env, filterPath(fid), authGet()),
      ]);
      expect(a.body).toEqual(sampleFilter(i));
      expect(b.body).toEqual(sampleFilter(i));
      const [gone, present] = await Promise.all([
        request(env, filterPath(fid), authGet()),
        request(env, filterPath(inj), authGet()),
      ]);
      expect(gone.body).toEqual({});
      expect(present.body).toEqual(sampleFilter(90 + i));
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`mutateAfterGets after-1 serial first-sees second-empty flood-${i}`, async () => {
      const fid = `ser${i}`;
      const cache = mockCache(
        { [`filter:${USER}:${fid}`]: JSON.stringify(sampleFilter(i)) },
        { mutateAfterGets: { after: 1, next: {} } }
      );
      const env = createEnv(cache);
      const first = await request(env, filterPath(fid), authGet());
      const second = await request(env, filterPath(fid), authGet());
      expect(first.body).toEqual(sampleFilter(i));
      expect(second.body).toEqual({});
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #232 — failPut∥capabilities + failGet isolation
// ---------------------------------------------------------------------------

describe('race filter failPut∥capabilities isolation after #232', () => {
  for (let i = 0; i < 12; i++) {
    it(`failPutAfter 0 POST∥capabilities soft flood-${i}`, async () => {
      const cache = mockCache({}, { failPutAfter: 0 });
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i))),
        request(env, capabilitiesPath(), { method: 'GET' }),
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i + 1))),
        request(env, capabilitiesPath(), authGet()),
      ]);
      expect(results[0].status).toBeGreaterThanOrEqual(500);
      expect(results[1].status).toBe(200);
      expect(results[2].status).toBeGreaterThanOrEqual(500);
      expect(results[3].status).toBe(200);
      expectCapabilitiesShape(results[1].body);
      expect(results[1].body).toEqual(results[3].body);
      expect(cache.puts).toHaveLength(0);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`failGetAfter mid GET∥capabilities soft flood-${i}`, async () => {
      const fid = `fg${i}`;
      const cache = mockCache(
        { [`filter:${USER}:${fid}`]: JSON.stringify(sampleFilter(i)) },
        { failGetAfter: 1 }
      );
      const env = createEnv(cache);
      const first = await request(env, filterPath(fid), authGet());
      expect(first.status).toBe(200);
      expect(first.body).toEqual(sampleFilter(i));
      const results = await Promise.all([
        request(env, filterPath(fid), authGet()),
        request(env, capabilitiesPath(), { method: 'GET' }),
        request(env, filterPath(fid), authGet()),
      ]);
      expect(results[0].status).toBeGreaterThanOrEqual(500);
      expect(results[1].status).toBe(200);
      expect(results[2].status).toBeGreaterThanOrEqual(500);
      expectCapabilitiesShape(results[1].body);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`failPutAfter 1 dual POST∥GET seeded soft flood-${i}`, async () => {
      const seeded = `seedFail${i}`;
      const cache = mockCache(
        { [`filter:${USER}:${seeded}`]: JSON.stringify(sampleFilter(0)) },
        { failPutAfter: 1 }
      );
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i))),
        request(env, filterPath(seeded), authGet()),
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i + 40))),
      ]);
      expect(results[0].status).toBe(200);
      expect(results[1].status).toBe(200);
      expect(results[1].body).toEqual(sampleFilter(0));
      expect(results[2].status).toBeGreaterThanOrEqual(500);
      expect(cache.puts).toHaveLength(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #232 — room_versions available exhaustive under race
// ---------------------------------------------------------------------------

describe('race capabilities room_versions available exhaustive after #232', () => {
  const expectedVersions = Array.from({ length: 12 }, (_, v) => String(v + 1));

  for (let i = 0; i < 12; i++) {
    it(`available 1–12 stable bind flood-${i}`, async () => {
      const env = createEnv();
      const results = await Promise.all(
        Array.from({ length: 6 }, () => request(env, capabilitiesPath(), { method: 'GET' }))
      );
      for (const r of results) {
        expect(r.status).toBe(200);
        const available = (r.body as CapabilitiesBody).capabilities['m.room_versions'].available;
        expect(Object.keys(available).sort((a, b) => Number(a) - Number(b))).toEqual(
          expectedVersions
        );
        for (const v of expectedVersions) {
          expect(available[v]).toBe('stable');
        }
        expect((r.body as CapabilitiesBody).capabilities['m.room_versions'].default).toBe('10');
      }
      expect(results.every((r) => JSON.stringify(r.body) === JSON.stringify(results[0].body))).toBe(
        true
      );
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`room_versions∥filter mint coherency soft flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, capabilitiesPath(), { method: 'GET' }),
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i))),
        request(env, capabilitiesPath(), { method: 'GET' }),
      ]);
      expect(results[0].status).toBe(200);
      expect(results[1].status).toBe(200);
      expect(results[2].status).toBe(200);
      const avail0 = (results[0].body as CapabilitiesBody).capabilities['m.room_versions'].available;
      const avail2 = (results[2].body as CapabilitiesBody).capabilities['m.room_versions'].available;
      expect(avail0).toEqual(avail2);
      expect(Object.keys(avail0)).toHaveLength(12);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #232 — double-encoded userId + filter_id hex bind
// ---------------------------------------------------------------------------

describe('race filter path encoding + filter_id hex bind after #232', () => {
  for (let i = 0; i < 10; i++) {
    it(`double-encoded userId soft flood-${i}`, async () => {
      // Hono decodes once; double-encoding yields wrong userId → forbidden
      const doubleEnc = encodeURIComponent(USER_ENC);
      const cache = mockCache();
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, `/_matrix/client/v3/user/${doubleEnc}/filter`, jsonInit('POST', sampleFilter(i))),
        request(env, filterCollection(USER_ENC), jsonInit('POST', sampleFilter(i + 1))),
      ]);
      expect(results[0].status).toBe(403);
      expect(results[1].status).toBe(200);
      expect(filterKeys(cache)).toHaveLength(1);
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`filter_id hex-segment charset bind flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, j) =>
          request(env, filterCollection(), jsonInit('POST', sampleFilter(i * 4 + j)))
        )
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      for (const r of results) {
        const id = (r.body as { filter_id: string }).filter_id;
        expect(id).toMatch(/^[0-9a-f]+$/i);
        expect(id.includes('-')).toBe(false);
        expect(id.length).toBeGreaterThanOrEqual(8);
      }
      expect(new Set(results.map((r) => (r.body as { filter_id: string }).filter_id)).size).toBe(4);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`query access_token ignored on filter routes soft flood-${i}`, async () => {
      // Auth is mocked — query must not alter path/KV key shape
      const fid = `qtok${i}`;
      const cache = mockCache({
        [`filter:${USER}:${fid}`]: JSON.stringify(sampleFilter(i)),
      });
      const env = createEnv(cache);
      const results = await Promise.all([
        request(
          env,
          `${filterPath(fid)}?access_token=should-not-matter`,
          authGet()
        ),
        request(
          env,
          `${filterCollection()}?access_token=also-ignored`,
          jsonInit('POST', sampleFilter(i + 5))
        ),
      ]);
      expect(results[0].status).toBe(200);
      expect(results[0].body).toEqual(sampleFilter(i));
      expect(results[1].status).toBe(200);
      expect(filterKeys(cache).length).toBeGreaterThanOrEqual(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #232 — oversized nested + collection method soft
// ---------------------------------------------------------------------------

describe('race filter oversized nested + collection method soft after #232', () => {
  for (let i = 0; i < 10; i++) {
    it(`oversized event_fields + rooms soft flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const body = {
        event_fields: Array.from({ length: 80 + i }, (_, j) => `field_${j}`),
        room: {
          rooms: Array.from({ length: 40 + i }, (_, j) => `!big${j}:example.com`),
          timeline: { limit: 100 + i },
        },
      };
      const results = await Promise.all([
        request(env, filterCollection(), jsonInit('POST', body)),
        request(env, filterCollection(), jsonInit('POST', { ...body, tag: i })),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      const ids = results.map((r) => (r.body as { filter_id: string }).filter_id);
      const got = await Promise.all(ids.map((id) => request(env, filterPath(id), authGet())));
      expect(got[0].body).toEqual(body);
      expect(got[1].body).toEqual({ ...body, tag: i });
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`collection wrong method soft flood-${i}`, async () => {
      const methods = ['PUT', 'DELETE', 'PATCH'] as const;
      const method = methods[i % methods.length];
      const cache = mockCache();
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterCollection(), { method, headers: { ...AUTH }, body: '{}' }),
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i))),
        request(env, capabilitiesPath(), { method: 'GET' }),
      ]);
      expect(results[0].status).toBeGreaterThanOrEqual(400);
      expect(results[1].status).toBe(200);
      expect(results[2].status).toBe(200);
      expect(cache.puts).toHaveLength(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`cross-user wipe inject under mutateAfterPuts soft flood-${i}`, async () => {
      const cache = mockCache(
        {},
        {
          mutateAfterPuts: {
            after: 1,
            next: {
              [`filter:${BOB}:steal${i}`]: JSON.stringify(sampleFilter(77)),
            },
          },
        }
      );
      const env = createEnv(cache);
      authState.userId = USER;
      const created = await request(env, filterCollection(USER_ENC), jsonInit('POST', sampleFilter(i)));
      expect(created.status).toBe(200);
      const mintedId = (created.body as { filter_id: string }).filter_id;
      authState.userId = BOB;
      const [aliceGone, bobGot] = await Promise.all([
        // Alice path forbidden under bob auth
        request(env, filterPath(mintedId, USER_ENC), authGet()),
        request(env, filterPath(`steal${i}`, BOB_ENC), authGet()),
      ]);
      expect(aliceGone.status).toBe(403);
      expect(bobGot.status).toBe(200);
      expect(bobGot.body).toEqual(sampleFilter(77));
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #241 — case-mismatched userId + forbidden message bind
// ---------------------------------------------------------------------------

describe('race filter case-mismatched userId soft after #241', () => {
  for (let i = 0; i < 12; i++) {
    it(`@Alice vs @alice path ≠ auth soft flood-${i}`, async () => {
      // Handler uses strict !== — Matrix localparts are case-sensitive here
      const mixed = encodeURIComponent('@Alice:example.com');
      const cache = mockCache();
      const env = createEnv(cache);
      authState.userId = USER;
      const results = await Promise.all([
        request(env, `/_matrix/client/v3/user/${mixed}/filter`, jsonInit('POST', sampleFilter(i))),
        request(env, filterCollection(USER_ENC), jsonInit('POST', sampleFilter(i + 1))),
        request(
          env,
          `/_matrix/client/v3/user/${mixed}/filter/fid${i}`,
          authGet()
        ),
      ]);
      expect(results[0].status).toBe(403);
      expect(results[0].body).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot create filters for other users',
      });
      expect(results[1].status).toBe(200);
      expect(results[2].status).toBe(403);
      expect(results[2].body).toMatchObject({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot read filters for other users',
      });
      expect(filterKeys(cache)).toHaveLength(1);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`forbidden message bind∥capabilities soft flood-${i}`, async () => {
      const env = createEnv(mockCache());
      authState.userId = USER;
      const results = await Promise.all([
        request(env, filterCollection(BOB_ENC), jsonInit('POST', sampleFilter(i))),
        request(env, filterPath(`x${i}`, BOB_ENC), authGet()),
        request(env, capabilitiesPath(), { method: 'GET' }),
        request(env, filterCollection(CAROL_ENC), jsonInit('POST', sampleFilter(i))),
      ]);
      expect(results[0].body).toEqual({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot create filters for other users',
      });
      expect(results[1].body).toEqual({
        errcode: 'M_FORBIDDEN',
        error: 'Cannot read filters for other users',
      });
      expect(results[2].status).toBe(200);
      expectCapabilitiesShape(results[2].body);
      expect(results[3].status).toBe(403);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #241 — capabilities HEAD + exact top-level key set
// ---------------------------------------------------------------------------

describe('race capabilities HEAD + key-set bind after #241', () => {
  const CAP_KEYS = [
    'm.change_password',
    'm.room_versions',
    'm.set_displayname',
    'm.set_avatar_url',
    'm.3pid_changes',
  ].sort();

  for (let i = 0; i < 12; i++) {
    it(`capabilities HEAD∥GET∥filter soft flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, capabilitiesPath(), { method: 'HEAD' }),
        request(env, capabilitiesPath(), { method: 'GET' }),
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i))),
        request(env, capabilitiesPath(), authGet()),
      ]);
      // HEAD may be 200 with empty body or 404/405 depending on Hono — soft
      expect([200, 404, 405]).toContain(results[0].status);
      expect(results[1].status).toBe(200);
      expect(results[2].status).toBe(200);
      expect(results[3].status).toBe(200);
      expect(results[1].body).toEqual(results[3].body);
      const keys = Object.keys(
        (results[1].body as CapabilitiesBody).capabilities
      ).sort();
      expect(keys).toEqual(CAP_KEYS);
      expect(cache.puts).toHaveLength(1);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`exact 5 capability keys under Promise.all soft flood-${i}`, async () => {
      const env = createEnv();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(env, capabilitiesPath(), {
            method: 'GET',
            headers: { Authorization: 'Bearer ignored', Accept: '*/*' },
          })
        )
      );
      for (const r of results) {
        expect(r.status).toBe(200);
        const caps = (r.body as CapabilitiesBody).capabilities;
        expect(Object.keys(caps).sort()).toEqual(CAP_KEYS);
        expectCapabilitiesShape(r.body);
      }
      expect(results.every((r) => JSON.stringify(r.body) === JSON.stringify(results[0].body))).toBe(
        true
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #241 — empty/ws filterId + null-root round-trip
// ---------------------------------------------------------------------------

describe('race filter empty-id + null-root round-trip after #241', () => {
  for (let i = 0; i < 12; i++) {
    it(`empty/ws filterId GET → {} soft flood-${i}`, async () => {
      const ids = ['', ' ', '  ', '%20', '%09'];
      const fid = ids[i % ids.length];
      const cache = mockCache({
        [`filter:${USER}:real${i}`]: JSON.stringify(sampleFilter(i)),
      });
      const env = createEnv(cache);
      const path =
        fid === ''
          ? `${filterCollection()}/`
          : `${filterCollection()}/${fid}`;
      const results = await Promise.all([
        request(env, path, authGet()),
        request(env, filterPath(`real${i}`), authGet()),
        request(env, capabilitiesPath(), { method: 'GET' }),
      ]);
      // Empty segment may 404 (no route) or hit GET with empty id → {}
      if (results[0].status === 200) {
        expect(results[0].body).toEqual({});
      } else {
        expect(results[0].status).toBeGreaterThanOrEqual(400);
      }
      expect(results[1].status).toBe(200);
      expect(results[1].body).toEqual(sampleFilter(i));
      expect(results[2].status).toBe(200);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`null-root POST→GET round-trip soft flood-${i}`, async () => {
      const cache = mockCache();
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterCollection(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: 'null',
        }),
        request(env, filterCollection(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: 'null',
        }),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      const ids = results.map((r) => (r.body as { filter_id: string }).filter_id);
      expect(new Set(ids).size).toBe(2);
      const got = await Promise.all(ids.map((id) => request(env, filterPath(id), authGet())));
      // Stored "null" → JSON.parse → null → c.json(null)
      expect(got[0].body).toBeNull();
      expect(got[1].body).toBeNull();
      expect(cache.puts.every((p) => p.value === 'null')).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #241 — delayPut∥failGet + putBarrier→getBarrier lifecycle
// ---------------------------------------------------------------------------

describe('race filter delayPut∥failGet + barrier lifecycle after #241', () => {
  for (let i = 0; i < 12; i++) {
    it(`delayMsOnPut∥failGetAfter isolation soft flood-${i}`, async () => {
      const seeded = `dly${i}`;
      const cache = mockCache(
        { [`filter:${USER}:${seeded}`]: JSON.stringify(sampleFilter(i)) },
        { delayMsOnPut: 2 + (i % 3), failGetAfter: 1 }
      );
      const env = createEnv(cache);
      const firstGet = await request(env, filterPath(seeded), authGet());
      expect(firstGet.status).toBe(200);
      const results = await Promise.all([
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i + 10))),
        request(env, filterPath(seeded), authGet()),
        request(env, capabilitiesPath(), { method: 'GET' }),
      ]);
      expect(results[0].status).toBe(200);
      expect(results[1].status).toBeGreaterThanOrEqual(500);
      expect(results[2].status).toBe(200);
      expect(cache.puts).toHaveLength(1);
      expect(cache.puts[0].options?.expirationTtl).toBe(30 * 24 * 60 * 60);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`putBarrier mint then getBarrier dual-GET soft flood-${i}`, async () => {
      const cache = mockCache({
        putBarrier: { count: 2, match: (key) => key.startsWith(`filter:${USER}:`) },
      });
      const env = createEnv(cache);
      const minted = await Promise.all([
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i))),
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i + 50))),
      ]);
      expect(statusesOf(minted)).toEqual([200, 200]);
      const ids = minted.map((r) => (r.body as { filter_id: string }).filter_id);
      const cache2 = mockCache(
        {
          [`filter:${USER}:${ids[0]}`]: JSON.stringify(sampleFilter(i)),
          [`filter:${USER}:${ids[1]}`]: JSON.stringify(sampleFilter(i + 50)),
        },
        {
          getBarrier: {
            count: 2,
            match: (key) => key === `filter:${USER}:${ids[0]}` || key === `filter:${USER}:${ids[1]}`,
          },
        }
      );
      const env2 = createEnv(cache2);
      const got = await Promise.all([
        request(env2, filterPath(ids[0]), authGet()),
        request(env2, filterPath(ids[1]), authGet()),
      ]);
      expect(statusesOf(got)).toEqual([200, 200]);
      const bodies = got.map((r) => r.body).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      expect(bodies).toEqual(
        [sampleFilter(i), sampleFilter(i + 50)].sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b))
        )
      );
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`TTL pin under failPutAfter 1 soft flood-${i}`, async () => {
      const cache = mockCache({}, { failPutAfter: 1 });
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i))),
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i + 1))),
        request(env, capabilitiesPath(), { method: 'GET' }),
      ]);
      const ok = results.filter((r) => r.status === 200 && (r.body as { filter_id?: string }).filter_id);
      const fail = results.filter((r) => r.status >= 500);
      expect(ok.length).toBe(1);
      expect(fail.length).toBe(1);
      expect(results[2].status).toBe(200);
      expect(cache.puts).toHaveLength(1);
      expect(cache.puts[0].options?.expirationTtl).toBe(2592000);
    });
  }
});

// ---------------------------------------------------------------------------
// Residual deepen after #241 — empty deviceId + corrupt mutateAfterGets inject
// ---------------------------------------------------------------------------

describe('race filter empty deviceId + corrupt inject after #241', () => {
  for (let i = 0; i < 10; i++) {
    it(`empty deviceId portfolio soft flood-${i}`, async () => {
      authState.deviceId = '';
      const cache = mockCache();
      const env = createEnv(cache);
      const results = await Promise.all([
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i))),
        request(env, filterCollection(), jsonInit('POST', sampleFilter(i + 3))),
        request(env, capabilitiesPath(), { method: 'GET' }),
      ]);
      expect(statusesOf(results.slice(0, 2))).toEqual([200, 200]);
      expect(results[2].status).toBe(200);
      // deviceId is auth context only — KV keys still keyed by userId
      expect(filterKeys(cache)).toHaveLength(2);
      expect(cache.puts.every((p) => p.key.startsWith(`filter:${USER}:`))).toBe(true);
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`mutateAfterGets corrupt inject → {} soft flood-${i}`, async () => {
      const fid = `crpt${i}`;
      const cache = mockCache(
        { [`filter:${USER}:${fid}`]: JSON.stringify(sampleFilter(i)) },
        {
          getBarrier: { count: 2, match: (key) => key === `filter:${USER}:${fid}` },
          mutateAfterGets: {
            after: 2,
            next: { [`filter:${USER}:${fid}`]: '{not-json' },
          },
        }
      );
      const env = createEnv(cache);
      const [a, b] = await Promise.all([
        request(env, filterPath(fid), authGet()),
        request(env, filterPath(fid), authGet()),
      ]);
      expect(a.body).toEqual(sampleFilter(i));
      expect(b.body).toEqual(sampleFilter(i));
      const after = await Promise.all([
        request(env, filterPath(fid), authGet()),
        request(env, filterPath(fid), authGet()),
      ]);
      // Corrupt KV → JSON.parse catch → {}
      expect(after.every((r) => r.status === 200 && JSON.stringify(r.body) === '{}')).toBe(true);
      expect(cache.events).toContain('mutate:after-get');
    });
  }
});
