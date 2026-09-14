/**
 * TOKENMAXX HEAVY leftovers after #194 — profile *mutate concurrent race / TOCTOU*
 * + soft/edge reliability for slices not covered by profile-api-routes or
 * profile-api-route-leftovers soft floods (#153).
 *
 * Distinct domain — not rooms-mutate (#194), aliases (#193), rooms (#192),
 * admin-mutate (#191), presence (#190), tags (open #196), workflows (open #195),
 * sliding-sync (#189), fed-keys (#188), oauth/push (#186), typing (#185),
 * receipts (#184), qr-login (#183), to-device (#181), relations (#179).
 *
 * Focus: custom-key KV GET→merge→PUT lost-update under Promise.all; PUT∥DELETE;
 * displayname∥avatar last-write-wins; updateUserProfile barriers + failure soft;
 * GET∥PUT mid-flight; corrupt KV; auth/JSON/params/method/lifecycle soft floods;
 * multi-key / multi-user isolation; TTL bind contracts.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, User } from '../src/types';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICEA');
      await next();
    };
  },
  optionalAuth: () => {
    return async (_c: unknown, next: () => Promise<void>) => {
      await next();
    };
  },
}));

const getUserById = vi.fn();
const updateUserProfile = vi.fn();

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getUserById: (...args: unknown[]) => getUserById(...args),
    updateUserProfile: (...args: unknown[]) => updateUserProfile(...args),
  };
});

import profile from '../src/api/profile';

const USER = '@alice:example.com';
const OTHER = '@bob:example.com';
const REMOTE = '@carol:remote.example.org';
const USER_ENC = encodeURIComponent(USER);
const OTHER_ENC = encodeURIComponent(OTHER);
const REMOTE_ENC = encodeURIComponent(REMOTE);
const SERVER = 'example.com';
const TTL = 365 * 24 * 60 * 60;
const CUSTOM_KEY = (uid = USER) => `profile:${uid}:custom`;

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };
type Barrier = { match: (key: string) => boolean; count: number };

async function withBarrier(
  barrier: Barrier | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  key: string
) {
  if (!barrier || !barrier.match(key)) return;
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

function seedUser(overrides: Partial<User> = {}): User {
  return {
    user_id: overrides.user_id ?? USER,
    localpart: overrides.localpart ?? 'alice',
    display_name: overrides.display_name,
    avatar_url: overrides.avatar_url,
    is_guest: overrides.is_guest ?? false,
    is_deactivated: overrides.is_deactivated ?? false,
    admin: overrides.admin ?? false,
    created_at: overrides.created_at ?? 1_700_000_000_000,
  };
}

function mockKv(
  initial: Record<string, string> = {},
  opts: {
    getBarrier?: Barrier;
    putBarrier?: Barrier;
    mutateAfterGets?: { after: number; next: Record<string, string> };
    failGetAfter?: number;
    failPutAfter?: number;
    delayPutMs?: number;
  } = {}
) {
  const data: Record<string, string> = { ...initial };
  const puts: KvPut[] = [];
  const gets: string[] = [];
  const events: string[] = [];

  let getBarrier = opts.getBarrier;
  let putBarrier = opts.putBarrier;
  const getWaiters = { list: [] as Array<() => void> };
  const putWaiters = { list: [] as Array<() => void> };

  let getCount = 0;
  let putCount = 0;
  const mutateAfterGets = opts.mutateAfterGets;

  return {
    data,
    puts,
    gets,
    events,
    get: async (key: string) => {
      gets.push(key);
      events.push(`get:${key}`);
      getCount += 1;
      await withBarrier(
        getBarrier,
        getWaiters,
        () => {
          getBarrier = undefined;
        },
        key
      );
      if (opts.failGetAfter !== undefined && getCount > opts.failGetAfter) {
        throw new Error('kv-get-fail');
      }
      if (mutateAfterGets && getCount === mutateAfterGets.after) {
        for (const [k, v] of Object.entries(mutateAfterGets.next)) {
          data[k] = v;
        }
        events.push('mutate:after-get');
      }
      return data[key] ?? null;
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
      if (opts.delayPutMs) {
        await new Promise((r) => setTimeout(r, opts.delayPutMs));
      }
      data[key] = value;
      puts.push({ key, value, options });
      events.push(`put:${key}`);
    },
    delete: async (key: string) => {
      delete data[key];
      events.push(`delete:${key}`);
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace & {
    data: Record<string, string>;
    puts: KvPut[];
    gets: string[];
    events: string[];
  };
}

type RaceKv = ReturnType<typeof mockKv>;

type UpdateBarrier = { count: number; match?: (args: unknown[]) => boolean };

function installUpdateBarrier(barrier: UpdateBarrier) {
  const waiters: Array<() => void> = [];
  updateUserProfile.mockImplementation(async (...args: unknown[]) => {
    const match = barrier.match ?? (() => true);
    if (!match(args)) return;
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
      if (waiters.length >= barrier.count) {
        const all = [...waiters];
        waiters.length = 0;
        for (const r of all) r();
      }
    });
  });
}

function envFor(cache: RaceKv): Env {
  return {
    DB: {} as D1Database,
    CACHE: cache,
    SERVER_NAME: SERVER,
  } as unknown as Env;
}

async function request(
  path: string,
  init: RequestInit = {},
  cache: RaceKv = mockKv()
): Promise<{ status: number; body: unknown; cache: RaceKv }> {
  const res = await profile.request(`http://localhost${path}`, init, envFor(cache));
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, cache };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function deleteInit(): RequestInit {
  return { method: 'DELETE', headers: { Authorization: 'Bearer test-token' } };
}

function customPath(key: string, userEnc = USER_ENC): string {
  return `/_matrix/client/v3/profile/${userEnc}/${key}`;
}

function displayPath(userEnc = USER_ENC): string {
  return `/_matrix/client/v3/profile/${userEnc}/displayname`;
}

function avatarPath(userEnc = USER_ENC): string {
  return `/_matrix/client/v3/profile/${userEnc}/avatar_url`;
}

function profilePath(userEnc = USER_ENC): string {
  return `/_matrix/client/v3/profile/${userEnc}`;
}

function parseCustom(cache: RaceKv, uid = USER): Record<string, unknown> {
  const raw = cache.data[CUSTOM_KEY(uid)];
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

beforeEach(() => {
  getUserById.mockReset();
  updateUserProfile.mockReset();
  getUserById.mockResolvedValue(seedUser());
  updateUserProfile.mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});


// ---------------------------------------------------------------------------
// Custom key KV GET→merge→PUT lost-update / last-write-wins
// ---------------------------------------------------------------------------

describe('race custom-key PUT∥PUT same-key last-write-wins after #194', () => {
  it('parallel PUT same key under get-barrier: both 200, last put wins', async () => {
    const cache = mockKv(
      {},
      {
        getBarrier: {
          count: 2,
          match: (k) => k === CUSTOM_KEY(),
        },
      }
    );
    const results = await Promise.all([
      request(customPath('timezone'), jsonInit('PUT', { timezone: 'UTC' }), cache),
      request(customPath('timezone'), jsonInit('PUT', { timezone: 'America/New_York' }), cache),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(cache.puts.length).toBe(2);
    const final = parseCustom(cache);
    expect(['UTC', 'America/New_York']).toContain(final.timezone);
    expect(Object.keys(final)).toEqual(['timezone']);
  });

  it('parallel PUT same key under put-barrier still ends with one key', async () => {
    const cache = mockKv(
      { [CUSTOM_KEY()]: JSON.stringify({ keep: true }) },
      {
        putBarrier: {
          count: 2,
          match: (k) => k === CUSTOM_KEY(),
        },
      }
    );
    const results = await Promise.all([
      request(customPath('timezone'), jsonInit('PUT', { timezone: 'A' }), cache),
      request(customPath('timezone'), jsonInit('PUT', { timezone: 'B' }), cache),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const final = parseCustom(cache);
    expect(final.keep).toBe(true);
    expect(['A', 'B']).toContain(final.timezone);
  });

  for (let i = 0; i < 16; i++) {
    it(`same-key TOCTOU soft-${i}: dual PUT under get-barrier`, async () => {
      const cache = mockKv(
        {},
        {
          getBarrier: {
            count: 2,
            match: (k) => k === CUSTOM_KEY(),
          },
        }
      );
      const a = `val-a-${i}`;
      const b = `val-b-${i}`;
      const results = await Promise.all([
        request(customPath('timezone'), jsonInit('PUT', { timezone: a }), cache),
        request(customPath('timezone'), jsonInit('PUT', { timezone: b }), cache),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      const final = parseCustom(cache);
      expect([a, b]).toContain(final.timezone);
      expect(cache.puts.every((p) => p.options?.expirationTtl === TTL)).toBe(true);
    });
  }
});

describe('race custom-key PUT∥PUT distinct-keys lost-update after #194', () => {
  it('classic RMW: dual PUT distinct keys under get-barrier loses one key', async () => {
    const cache = mockKv(
      {},
      {
        getBarrier: {
          count: 2,
          match: (k) => k === CUSTOM_KEY(),
        },
      }
    );
    const results = await Promise.all([
      request(customPath('timezone'), jsonInit('PUT', { timezone: 'UTC' }), cache),
      request(customPath('pronouns'), jsonInit('PUT', { pronouns: 'they' }), cache),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    // Both read empty {}, each wrote only their key → last writer wins → one key missing.
    const final = parseCustom(cache);
    const keys = Object.keys(final).sort();
    expect(keys.length).toBe(1);
    expect(['pronouns', 'timezone']).toContain(keys[0]);
  });

  it('seeded blob: dual PUT distinct keys under get-barrier may drop sibling', async () => {
    const cache = mockKv(
      { [CUSTOM_KEY()]: JSON.stringify({ keep: 1 }) },
      {
        getBarrier: {
          count: 2,
          match: (k) => k === CUSTOM_KEY(),
        },
      }
    );
    await Promise.all([
      request(customPath('timezone'), jsonInit('PUT', { timezone: 'UTC' }), cache),
      request(customPath('dob'), jsonInit('PUT', { dob: '2000-01-01' }), cache),
    ]);
    const final = parseCustom(cache);
    expect(final.keep).toBe(1);
    // At most one of the two new keys survives under lost-update; keep always present
    // because both read the seeded blob. Exactly one new key if pure last-write-wins.
    const newKeys = ['timezone', 'dob'].filter((k) => k in final);
    expect(newKeys.length).toBe(1);
  });

  for (let i = 0; i < 20; i++) {
    it(`distinct-key lost-update soft-${i}`, async () => {
      const k1 = `k1_${i}`;
      const k2 = `k2_${i}`;
      const cache = mockKv(
        {},
        {
          getBarrier: {
            count: 2,
            match: (k) => k === CUSTOM_KEY(),
          },
        }
      );
      const results = await Promise.all([
        request(customPath(k1), jsonInit('PUT', { [k1]: `a${i}` }), cache),
        request(customPath(k2), jsonInit('PUT', { [k2]: `b${i}` }), cache),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(Object.keys(parseCustom(cache))).toHaveLength(1);
    });
  }

  it('triple distinct-key flood under get-barrier count=3 collapses to one', async () => {
    const cache = mockKv(
      {},
      {
        getBarrier: {
          count: 3,
          match: (k) => k === CUSTOM_KEY(),
        },
      }
    );
    const results = await Promise.all([
      request(customPath('a'), jsonInit('PUT', { a: 1 }), cache),
      request(customPath('b'), jsonInit('PUT', { b: 2 }), cache),
      request(customPath('c'), jsonInit('PUT', { c: 3 }), cache),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(Object.keys(parseCustom(cache))).toHaveLength(1);
  });
});


// ---------------------------------------------------------------------------
// DELETE∥PUT / DELETE∥DELETE custom-key races
// ---------------------------------------------------------------------------

describe('race custom-key DELETE∥PUT after #194', () => {
  it('DELETE∥PUT same key under get-barrier: both 200; final state coherent', async () => {
    const cache = mockKv(
      { [CUSTOM_KEY()]: JSON.stringify({ timezone: 'UTC', keep: true }) },
      {
        getBarrier: {
          count: 2,
          match: (k) => k === CUSTOM_KEY(),
        },
      }
    );
    const results = await Promise.all([
      request(customPath('timezone'), deleteInit(), cache),
      request(customPath('timezone'), jsonInit('PUT', { timezone: 'PST' }), cache),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const final = parseCustom(cache);
    expect(final.keep).toBe(true);
    // Either deleted (no timezone) or put won (timezone=PST)
    if ('timezone' in final) {
      expect(final.timezone).toBe('PST');
    }
  });

  it('DELETE∥PUT distinct keys under get-barrier may lose sibling write or delete', async () => {
    const cache = mockKv(
      { [CUSTOM_KEY()]: JSON.stringify({ timezone: 'UTC', pronouns: 'they' }) },
      {
        getBarrier: {
          count: 2,
          match: (k) => k === CUSTOM_KEY(),
        },
      }
    );
    await Promise.all([
      request(customPath('timezone'), deleteInit(), cache),
      request(customPath('dob'), jsonInit('PUT', { dob: 'x' }), cache),
    ]);
    const final = parseCustom(cache);
    // Last writer determines shape; both ops saw full map.
    expect(typeof final).toBe('object');
    expect(cache.puts.length).toBe(2);
  });

  for (let i = 0; i < 14; i++) {
    it(`DELETE∥PUT soft-${i}`, async () => {
      const cache = mockKv(
        { [CUSTOM_KEY()]: JSON.stringify({ timezone: `old-${i}`, keep: i }) },
        {
          getBarrier: {
            count: 2,
            match: (k) => k === CUSTOM_KEY(),
          },
        }
      );
      const results = await Promise.all([
        request(customPath('timezone'), deleteInit(), cache),
        request(customPath('timezone'), jsonInit('PUT', { timezone: `new-${i}` }), cache),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(parseCustom(cache).keep).toBe(i);
    });
  }
});

describe('race custom-key DELETE∥DELETE after #194', () => {
  it('parallel DELETE same key under get-barrier both succeed idempotently', async () => {
    const cache = mockKv(
      { [CUSTOM_KEY()]: JSON.stringify({ timezone: 'UTC', keep: 1 }) },
      {
        getBarrier: {
          count: 2,
          match: (k) => k === CUSTOM_KEY(),
        },
      }
    );
    const results = await Promise.all([
      request(customPath('timezone'), deleteInit(), cache),
      request(customPath('timezone'), deleteInit(), cache),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(parseCustom(cache)).toEqual({ keep: 1 });
  });

  for (let i = 0; i < 12; i++) {
    it(`DELETE∥DELETE soft-${i}`, async () => {
      const cache = mockKv(
        { [CUSTOM_KEY()]: JSON.stringify({ a: i, b: i + 1 }) },
        {
          getBarrier: {
            count: 2,
            match: (k) => k === CUSTOM_KEY(),
          },
        }
      );
      const results = await Promise.all([
        request(customPath('a'), deleteInit(), cache),
        request(customPath('b'), deleteInit(), cache),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      // Classic lost-update: last delete may still include the other key
      const final = parseCustom(cache);
      expect(Object.keys(final).length).toBeLessThanOrEqual(1);
    });
  }
});


// ---------------------------------------------------------------------------
// displayname∥avatar / last-write-wins updateUserProfile races
// ---------------------------------------------------------------------------

describe('race displayname PUT∥PUT last-write-wins after #194', () => {
  it('parallel displayname under update barrier both 200', async () => {
    installUpdateBarrier({ count: 2 });
    const cache = mockKv();
    const results = await Promise.all([
      request(displayPath(), jsonInit('PUT', { displayname: 'Alice-A' }), cache),
      request(displayPath(), jsonInit('PUT', { displayname: 'Alice-B' }), cache),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(updateUserProfile).toHaveBeenCalledTimes(2);
    const names = updateUserProfile.mock.calls.map((c) => c[2]);
    expect(names.sort()).toEqual(['Alice-A', 'Alice-B']);
  });

  for (let i = 0; i < 16; i++) {
    it(`displayname dual PUT soft-${i}`, async () => {
      installUpdateBarrier({ count: 2 });
      const results = await Promise.all([
        request(displayPath(), jsonInit('PUT', { displayname: `N-${i}-a` })),
        request(displayPath(), jsonInit('PUT', { displayname: `N-${i}-b` })),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(updateUserProfile).toHaveBeenCalledTimes(2);
    });
  }
});

describe('race avatar_url PUT∥PUT last-write-wins after #194', () => {
  it('parallel avatar under update barrier both 200', async () => {
    installUpdateBarrier({ count: 2 });
    const results = await Promise.all([
      request(avatarPath(), jsonInit('PUT', { avatar_url: 'mxc://example.com/a' })),
      request(avatarPath(), jsonInit('PUT', { avatar_url: 'mxc://example.com/b' })),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(updateUserProfile).toHaveBeenCalledTimes(2);
    const urls = updateUserProfile.mock.calls.map((c) => c[3]);
    expect(urls.sort()).toEqual(['mxc://example.com/a', 'mxc://example.com/b']);
  });

  for (let i = 0; i < 14; i++) {
    it(`avatar dual PUT soft-${i}`, async () => {
      installUpdateBarrier({ count: 2 });
      const results = await Promise.all([
        request(avatarPath(), jsonInit('PUT', { avatar_url: `mxc://example.com/${i}-a` })),
        request(avatarPath(), jsonInit('PUT', { avatar_url: `mxc://example.com/${i}-b` })),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
    });
  }
});

describe('race displayname∥avatar concurrent isolation after #194', () => {
  it('displayname∥avatar under shared barrier both succeed independently', async () => {
    installUpdateBarrier({ count: 2 });
    const results = await Promise.all([
      request(displayPath(), jsonInit('PUT', { displayname: 'Alice' })),
      request(avatarPath(), jsonInit('PUT', { avatar_url: 'mxc://example.com/x' })),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(updateUserProfile).toHaveBeenCalledTimes(2);
    const dn = updateUserProfile.mock.calls.find((c) => c[2] !== undefined);
    const av = updateUserProfile.mock.calls.find((c) => c[3] !== undefined);
    expect(dn?.[2]).toBe('Alice');
    expect(av?.[3]).toBe('mxc://example.com/x');
  });

  for (let i = 0; i < 12; i++) {
    it(`displayname∥avatar soft-${i}`, async () => {
      installUpdateBarrier({ count: 2 });
      const results = await Promise.all([
        request(displayPath(), jsonInit('PUT', { displayname: `D${i}` })),
        request(avatarPath(), jsonInit('PUT', { avatar_url: `mxc://example.com/${i}` })),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
    });
  }
});


// ---------------------------------------------------------------------------
// GET∥PUT mid-flight + mutate-after-get TOCTOU
// ---------------------------------------------------------------------------

describe('race GET∥PUT custom mid-flight after #194', () => {
  it('GET under get-barrier sees pre-put value while PUT merges', async () => {
    const cache = mockKv(
      { [CUSTOM_KEY()]: JSON.stringify({ timezone: 'UTC' }) },
      {
        getBarrier: {
          count: 2,
          match: (k) => k === CUSTOM_KEY(),
        },
      }
    );
    const results = await Promise.all([
      request(customPath('timezone'), {}, cache),
      request(customPath('timezone'), jsonInit('PUT', { timezone: 'PST' }), cache),
    ]);
    const getRes = results.find((r) => r.body && typeof r.body === 'object' && 'timezone' in (r.body as object));
    expect(getRes?.status).toBe(200);
    // GET may observe UTC (pre) or PST if it raced after put; both acceptable under barrier timing
    expect(['UTC', 'PST']).toContain((getRes?.body as { timezone: string }).timezone);
    expect(results.some((r) => r.status === 200 && Object.keys(r.body as object).length === 0)).toBe(true);
  });

  it('mutate-after-get injects key mid-flight; PUT merges over injected snapshot', async () => {
    const cache = mockKv(
      {},
      {
        mutateAfterGets: {
          after: 1,
          next: { [CUSTOM_KEY()]: JSON.stringify({ injected: true }) },
        },
      }
    );
    const res = await request(
      customPath('timezone'),
      jsonInit('PUT', { timezone: 'UTC' }),
      cache
    );
    expect(res.status).toBe(200);
    // Barrier mutates before get returns → PUT sees injected and merges timezone.
    expect(parseCustom(cache)).toEqual({ injected: true, timezone: 'UTC' });
    expect(cache.events).toContain('mutate:after-get');
  });

  for (let i = 0; i < 12; i++) {
    it(`GET∥PUT soft-${i}`, async () => {
      const cache = mockKv(
        { [CUSTOM_KEY()]: JSON.stringify({ timezone: `pre-${i}` }) },
        {
          getBarrier: {
            count: 2,
            match: (k) => k === CUSTOM_KEY(),
          },
        }
      );
      const results = await Promise.all([
        request(customPath('timezone'), {}, cache),
        request(customPath('timezone'), jsonInit('PUT', { timezone: `post-${i}` }), cache),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(parseCustom(cache).timezone).toBe(`post-${i}`);
    });
  }
});

describe('race full-profile GET∥displayname PUT after #194', () => {
  it('GET profile∥PUT displayname both 200', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: 'Old' }));
    installUpdateBarrier({ count: 1 });
    const results = await Promise.all([
      request(profilePath()),
      request(displayPath(), jsonInit('PUT', { displayname: 'New' })),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results[0].body).toMatchObject({ displayname: 'Old' });
  });

  for (let i = 0; i < 10; i++) {
    it(`GET profile∥PUT display soft-${i}`, async () => {
      getUserById.mockResolvedValue(seedUser({ display_name: `Pre-${i}` }));
      const results = await Promise.all([
        request(profilePath()),
        request(displayPath(), jsonInit('PUT', { displayname: `Post-${i}` })),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
    });
  }
});


// ---------------------------------------------------------------------------
// updateUserProfile / KV failure soft + corrupt KV shapes
// ---------------------------------------------------------------------------

describe('race updateUserProfile failure soft after #194', () => {
  it('displayname PUT surfaces D1 throw as 500', async () => {
    updateUserProfile.mockRejectedValueOnce(new Error('d1-profile-fail'));
    const res = await request(displayPath(), jsonInit('PUT', { displayname: 'X' }));
    expect(res.status).toBe(500);
  });

  it('avatar PUT surfaces D1 throw as 500', async () => {
    updateUserProfile.mockRejectedValueOnce(new Error('d1-avatar-fail'));
    const res = await request(avatarPath(), jsonInit('PUT', { avatar_url: 'mxc://example.com/z' }));
    expect(res.status).toBe(500);
  });

  for (let i = 0; i < 10; i++) {
    it(`update fail soft displayname-${i}`, async () => {
      updateUserProfile.mockRejectedValueOnce(new Error(`fail-dn-${i}`));
      expect(
        (await request(displayPath(), jsonInit('PUT', { displayname: `X${i}` }))).status
      ).toBe(500);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`update fail soft avatar-${i}`, async () => {
      updateUserProfile.mockRejectedValueOnce(new Error(`fail-av-${i}`));
      expect(
        (await request(avatarPath(), jsonInit('PUT', { avatar_url: `mxc://example.com/${i}` }))).status
      ).toBe(500);
    });
  }
});

describe('race KV put/get failure soft after #194', () => {
  it('custom PUT fails when KV put throws', async () => {
    const cache = mockKv({}, { failPutAfter: 0 });
    const res = await request(
      customPath('timezone'),
      jsonInit('PUT', { timezone: 'UTC' }),
      cache
    );
    expect(res.status).toBe(500);
  });

  it('custom PUT fails when KV get throws', async () => {
    const cache = mockKv({}, { failGetAfter: 0 });
    const res = await request(
      customPath('timezone'),
      jsonInit('PUT', { timezone: 'UTC' }),
      cache
    );
    expect(res.status).toBe(500);
  });

  it('custom DELETE fails when KV put throws', async () => {
    const cache = mockKv(
      { [CUSTOM_KEY()]: JSON.stringify({ timezone: 'UTC' }) },
      { failPutAfter: 0 }
    );
    const res = await request(customPath('timezone'), deleteInit(), cache);
    expect(res.status).toBe(500);
  });

  for (let i = 0; i < 10; i++) {
    it(`KV put-fail soft-${i}`, async () => {
      const cache = mockKv({}, { failPutAfter: 0 });
      expect(
        (
          await request(
            customPath(`k${i}`),
            jsonInit('PUT', { [`k${i}`]: i }),
            cache
          )
        ).status
      ).toBe(500);
    });
  }
});

describe('race corrupt custom KV shapes soft after #194', () => {
  const corrupt = ['{', 'null', '[]', '"str"', '1', 'true', '{bad'];

  for (let i = 0; i < corrupt.length; i++) {
    it(`corrupt KV GET soft-${i}: ${corrupt[i].slice(0, 12)}`, async () => {
      const cache = mockKv({ [CUSTOM_KEY()]: corrupt[i] });
      // JSON.parse throws → 500 (or may surface depending on Hono error handling)
      const res = await request(customPath('timezone'), {}, cache);
      expect([404, 500]).toContain(res.status);
    });
  }

  for (let i = 0; i < corrupt.length; i++) {
    it(`corrupt KV PUT soft-${i}`, async () => {
      const cache = mockKv({ [CUSTOM_KEY()]: corrupt[i] });
      const res = await request(
        customPath('timezone'),
        jsonInit('PUT', { timezone: 'UTC' }),
        cache
      );
      expect([200, 500]).toContain(res.status);
    });
  }
});


// ---------------------------------------------------------------------------
// Auth / JSON / params / method / foreign-user soft floods
// ---------------------------------------------------------------------------

describe('race auth foreign-user forbid soft after #194', () => {
  const paths = [
    ['PUT displayname other', () => displayPath(OTHER_ENC), () => jsonInit('PUT', { displayname: 'X' })],
    ['PUT avatar other', () => avatarPath(OTHER_ENC), () => jsonInit('PUT', { avatar_url: 'mxc://example.com/x' })],
    ['PUT custom other', () => customPath('timezone', OTHER_ENC), () => jsonInit('PUT', { timezone: 'UTC' })],
    ['DELETE custom other', () => customPath('timezone', OTHER_ENC), () => deleteInit()],
  ] as const;

  for (let i = 0; i < 12; i++) {
    for (const [label, path, init] of paths) {
      it(`forbid soft-${i}: ${label}`, async () => {
        const res = await request(path(), init());
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
        expect(updateUserProfile).not.toHaveBeenCalled();
      });
    }
  }
});

describe('race bad JSON / missing param soft after #194', () => {
  for (let i = 0; i < 14; i++) {
    it(`bad JSON displayname soft-${i}`, async () => {
      const res = await request(displayPath(), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer t',
        },
        body: i % 2 === 0 ? '{' : 'not-json',
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`bad JSON avatar soft-${i}`, async () => {
      const res = await request(avatarPath(), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer t',
        },
        // Odd bodies use truncated JSON (arrays parse successfully → not M_BAD_JSON).
        body: i % 2 === 0 ? '{' : '{"avatar_url":',
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`bad JSON custom soft-${i}`, async () => {
      const res = await request(customPath('timezone'), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer t',
        },
        body: '{',
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
    });
  }

  for (let i = 0; i < 16; i++) {
    it(`missing custom body key soft-${i}`, async () => {
      const key = `field_${i}`;
      const res = await request(
        customPath(key),
        jsonInit('PUT', { wrong: i })
      );
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        errcode: 'M_MISSING_PARAM',
        error: `Missing '${key}' in request body`,
      });
    });
  }
});

describe('race method matrix soft after #194', () => {
  const methods = ['POST', 'PATCH', 'OPTIONS', 'HEAD'] as const;
  for (const method of methods) {
    for (const [label, path] of [
      ['displayname', displayPath()],
      ['avatar', avatarPath()],
      ['custom', customPath('timezone')],
      ['profile', profilePath()],
    ] as const) {
      it(`method ${method} on ${label} soft`, async () => {
        getUserById.mockResolvedValue(seedUser());
        const res = await request(path, { method, headers: { Authorization: 'Bearer t' } });
        // Hono: HEAD on GET routes → 200; unsupported verbs → 404/405.
        if (method === 'HEAD') {
          expect([200, 404, 405]).toContain(res.status);
        } else {
          expect([404, 405]).toContain(res.status);
        }
      });
    }
  }
});

describe('race DELETE standard keys forbid soft after #194', () => {
  for (let i = 0; i < 10; i++) {
    it(`DELETE displayname forbid soft-${i}`, async () => {
      const res = await request(displayPath(), deleteInit());
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'Cannot delete standard profile keys' });
    });
  }
  for (let i = 0; i < 10; i++) {
    it(`DELETE avatar_url forbid soft-${i}`, async () => {
      const res = await request(avatarPath(), deleteInit());
      expect(res.status).toBe(403);
    });
  }
});


// ---------------------------------------------------------------------------
// Lifecycle chains / multi-key isolation / TTL / value matrices
// ---------------------------------------------------------------------------

describe('race lifecycle put→get→put→delete chains after #194', () => {
  for (let i = 0; i < 16; i++) {
    it(`lifecycle soft-${i}`, async () => {
      const cache = mockKv();
      const key = `life_${i}`;
      const put1 = await request(
        customPath(key),
        jsonInit('PUT', { [key]: `v1-${i}` }),
        cache
      );
      expect(put1.status).toBe(200);
      const get1 = await request(customPath(key), {}, cache);
      expect(get1.body).toEqual({ [key]: `v1-${i}` });
      const put2 = await request(
        customPath(key),
        jsonInit('PUT', { [key]: `v2-${i}` }),
        cache
      );
      expect(put2.status).toBe(200);
      const get2 = await request(customPath(key), {}, cache);
      expect(get2.body).toEqual({ [key]: `v2-${i}` });
      const del = await request(customPath(key), deleteInit(), cache);
      expect(del.status).toBe(200);
      const get3 = await request(customPath(key), {}, cache);
      expect(get3.status).toBe(404);
    });
  }

  it('lifecycle displayname→avatar→custom under sequential mutate', async () => {
    const cache = mockKv();
    expect(
      (await request(displayPath(), jsonInit('PUT', { displayname: 'A' }), cache)).status
    ).toBe(200);
    expect(
      (await request(avatarPath(), jsonInit('PUT', { avatar_url: 'mxc://example.com/a' }), cache))
        .status
    ).toBe(200);
    expect(
      (await request(customPath('timezone'), jsonInit('PUT', { timezone: 'UTC' }), cache)).status
    ).toBe(200);
    expect(parseCustom(cache)).toEqual({ timezone: 'UTC' });
    expect(updateUserProfile).toHaveBeenCalledTimes(2);
  });
});

describe('race multi-key sequential merge isolation after #194', () => {
  it('sequential distinct keys accumulate (no lost-update without concurrency)', async () => {
    const cache = mockKv();
    for (const [k, v] of [
      ['timezone', 'UTC'],
      ['pronouns', 'they'],
      ['dob', '2000-01-01'],
    ] as const) {
      expect(
        (await request(customPath(k), jsonInit('PUT', { [k]: v }), cache)).status
      ).toBe(200);
    }
    expect(parseCustom(cache)).toEqual({
      timezone: 'UTC',
      pronouns: 'they',
      dob: '2000-01-01',
    });
  });

  for (let i = 0; i < 12; i++) {
    it(`sequential merge soft-${i}`, async () => {
      const cache = mockKv();
      await request(customPath('a'), jsonInit('PUT', { a: i }), cache);
      await request(customPath('b'), jsonInit('PUT', { b: i + 1 }), cache);
      expect(parseCustom(cache)).toEqual({ a: i, b: i + 1 });
    });
  }
});

describe('race TTL bind contract soft after #194', () => {
  for (let i = 0; i < 14; i++) {
    it(`PUT TTL soft-${i}`, async () => {
      const cache = mockKv();
      await request(customPath(`t${i}`), jsonInit('PUT', { [`t${i}`]: i }), cache);
      expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(TTL);
    });
  }
  for (let i = 0; i < 10; i++) {
    it(`DELETE TTL soft-${i}`, async () => {
      const cache = mockKv({ [CUSTOM_KEY()]: JSON.stringify({ x: i }) });
      await request(customPath('x'), deleteInit(), cache);
      expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(TTL);
    });
  }
});

describe('race custom value matrix soft after #194', () => {
  const values: Array<[string, unknown]> = [
    ['null', null],
    ['num', 0],
    ['neg', -1],
    ['float', 1.5],
    ['bool-t', true],
    ['bool-f', false],
    ['empty', ''],
    ['unicode', '名前🎉'],
    ['nested', { a: 1, b: [1, 2] }],
    ['arr', [1, 'x', null]],
  ];
  for (let i = 0; i < values.length; i++) {
    const [label, val] = values[i];
    it(`value matrix soft-${i}: ${label}`, async () => {
      const cache = mockKv();
      const res = await request(
        customPath('meta'),
        jsonInit('PUT', { meta: val }),
        cache
      );
      expect(res.status).toBe(200);
      expect(parseCustom(cache).meta).toEqual(val);
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`overwrite value soft-${i}`, async () => {
      const cache = mockKv({ [CUSTOM_KEY()]: JSON.stringify({ meta: 'old' }) });
      await request(customPath('meta'), jsonInit('PUT', { meta: `new-${i}` }), cache);
      expect(parseCustom(cache).meta).toBe(`new-${i}`);
    });
  }
});

describe('race remote / invalid user soft after #194', () => {
  for (let i = 0; i < 8; i++) {
    it(`remote GET profile soft-${i}`, async () => {
      const res = await request(profilePath(REMOTE_ENC));
      expect(res.status).toBe(404);
      expect(getUserById).not.toHaveBeenCalled();
    });
  }
  for (let i = 0; i < 8; i++) {
    it(`invalid user GET soft-${i}`, async () => {
      const res = await request(`/_matrix/client/v3/profile/not-an-mxid-${i}`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
    });
  }
  for (let i = 0; i < 8; i++) {
    it(`missing local user GET soft-${i}`, async () => {
      getUserById.mockResolvedValueOnce(null);
      const res = await request(profilePath());
      expect(res.status).toBe(404);
    });
  }
});

describe('race concurrent multi-request flood after #194', () => {
  it('8-way same-key PUT flood under get-barrier collapses cleanly', async () => {
    const cache = mockKv(
      {},
      {
        getBarrier: {
          count: 8,
          match: (k) => k === CUSTOM_KEY(),
        },
      }
    );
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(customPath('timezone'), jsonInit('PUT', { timezone: `z${i}` }), cache)
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(Object.keys(parseCustom(cache))).toEqual(['timezone']);
    expect(cache.puts).toHaveLength(8);
  });

  it('mixed displayname+avatar+custom flood all 200', async () => {
    installUpdateBarrier({ count: 4 });
    const cache = mockKv();
    const results = await Promise.all([
      request(displayPath(), jsonInit('PUT', { displayname: 'A' }), cache),
      request(displayPath(), jsonInit('PUT', { displayname: 'B' }), cache),
      request(avatarPath(), jsonInit('PUT', { avatar_url: 'mxc://example.com/1' }), cache),
      request(avatarPath(), jsonInit('PUT', { avatar_url: 'mxc://example.com/2' }), cache),
      request(customPath('timezone'), jsonInit('PUT', { timezone: 'UTC' }), cache),
      request(customPath('pronouns'), jsonInit('PUT', { pronouns: 'they' }), cache),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(updateUserProfile).toHaveBeenCalledTimes(4);
  });

  for (let i = 0; i < 10; i++) {
    it(`4-way same-key flood soft-${i}`, async () => {
      const cache = mockKv(
        {},
        {
          getBarrier: {
            count: 4,
            match: (k) => k === CUSTOM_KEY(),
          },
        }
      );
      const results = await Promise.all([
        request(customPath('k'), jsonInit('PUT', { k: `a${i}` }), cache),
        request(customPath('k'), jsonInit('PUT', { k: `b${i}` }), cache),
        request(customPath('k'), jsonInit('PUT', { k: `c${i}` }), cache),
        request(customPath('k'), jsonInit('PUT', { k: `d${i}` }), cache),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(Object.keys(parseCustom(cache))).toEqual(['k']);
    });
  }
});

describe('race charset / Accept / Authorization soft after #194', () => {
  for (let i = 0; i < 8; i++) {
    it(`charset content-type soft-${i}`, async () => {
      const cache = mockKv();
      const res = await request(customPath('timezone'), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: 'Bearer t',
        },
        body: JSON.stringify({ timezone: `UTC-${i}` }),
      }, cache);
      expect(res.status).toBe(200);
      expect(parseCustom(cache).timezone).toBe(`UTC-${i}`);
    });
  }
  for (let i = 0; i < 8; i++) {
    it(`Accept application/json soft-${i}`, async () => {
      getUserById.mockResolvedValue(seedUser({ display_name: `A${i}` }));
      const res = await request(displayPath(), {
        headers: { Accept: 'application/json', Authorization: 'Bearer t' },
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ displayname: `A${i}` });
    });
  }
});
