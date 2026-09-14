/**
 * TOKENMAXX HEAVY leftovers after #210 — client *filters + capabilities*
 * concurrent race / TOCTOU + soft/edge reliability for slices with zero prior
 * concurrent-race coverage.
 *
 * Live handlers live inline on `src/index.ts` (capabilities GET; POST/GET
 * user filter KV). Orthogonal to open MERGEABLE #211 (directory/user_directory/
 * thirdparty/dehydrated — leave that niche alone). Sync only *consumes*
 * `filter:` KV keys (#202); never races the create/read filter endpoints or
 * capabilities coherency under Promise.all.
 *
 * Distinct from saturated keys/devices/to-device/media/receipts/threads/spaces/
 * aliases/power-levels/redact/voip concurrent-race files and from relations
 * (#210), account (#209), rooms-read-upgrade (#208), push (#207), typing
 * (#206), sliding-sync (#205), presence (#204), sync (#202), voip (#201).
 *
 * Focus: parallel POST filter distinct IDs; CACHE put barrier TOCTOU;
 * POST∥GET mid-flight empty-vs-body; corrupt/missing KV → {}; forbidden
 * other-user; capabilities parallel coherency; method/JSON/charset soft
 * floods; TTL bind contracts; cross-endpoint filter∥capabilities isolation.
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
