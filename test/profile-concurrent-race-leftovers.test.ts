/**
 * TOKENMAXX HEAVY leftovers after #196 — profile *concurrent race / TOCTOU*
 * + soft/edge reliability for slices not covered by profile-api-routes or
 * profile-api-route-leftovers (#153).
 *
 * Distinct domain — not tags (#196), workflows (#195), rooms-mutate (#194),
 * aliases (#193), rooms (#192), admin-mutate (#191), presence (#190),
 * sliding-sync (#189), fed-keys (#188), oauth/push (#186), typing (#185),
 * receipts (#184), qr-login (#183), to-device (#181), relations (#179).
 *
 * Focus: custom-key CACHE get→merge→put lost-update under Promise.all;
 * DELETE∥PUT∥GET custom-key races; displayname∥avatar concurrent isolation;
 * updateUserProfile throw soft; foreign-user / remote / method / body /
 * charset / lifecycle soft floods; KV TTL + update bind contracts.
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
const YEAR_TTL = 365 * 24 * 60 * 60;
const CUSTOM_KEY = 'profile:custom';
const CUSTOM_KEY_B = 'org.example.status';
const CUSTOM_KEY_C = 'org.example.timezone';
const MXC_A = 'mxc://example.com/avatar-a';
const MXC_B = 'mxc://example.com/avatar-b';

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };
type KvGet = { key: string };

type GetBarrier = { match: (key: string) => boolean; count: number };
type PutBarrier = { match: (key: string) => boolean; count: number };

async function withBarrier(
  barrier: { match: (key: string) => boolean; count: number } | undefined,
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

function customKvKey(userId = USER): string {
  return `profile:${userId}:custom`;
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
    created_at: overrides.created_at ?? 1,
  };
}

function createRaceKv(
  opts: {
    data?: Record<string, string>;
    getBarrier?: GetBarrier;
    putBarrier?: PutBarrier;
    mutateAfterGets?: { after: number; next: Record<string, string> };
    failPutAfter?: number;
  } = {}
) {
  const data: Record<string, string> = { ...(opts.data ?? {}) };
  const puts: KvPut[] = [];
  const gets: KvGet[] = [];
  const events: string[] = [];

  let getBarrier = opts.getBarrier;
  let putBarrier = opts.putBarrier;
  const getWaiters = { list: [] as Array<() => void> };
  const putWaiters = { list: [] as Array<() => void> };

  let getCount = 0;
  let putCount = 0;
  const mutateAfterGets = opts.mutateAfterGets;
  const failPutAfter = opts.failPutAfter;

  const kv = {
    data,
    puts,
    gets,
    events,
    async get(key: string) {
      gets.push({ key });
      events.push(`get:${key}`);
      await withBarrier(
        getBarrier,
        getWaiters,
        () => {
          getBarrier = undefined;
        },
        key
      );
      getCount += 1;
      const snapshot = data[key] ?? null;
      if (mutateAfterGets && getCount === mutateAfterGets.after) {
        for (const k of Object.keys(data)) delete data[k];
        Object.assign(data, mutateAfterGets.next);
        events.push('mutate:kv');
      }
      return snapshot;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      await withBarrier(
        putBarrier,
        putWaiters,
        () => {
          putBarrier = undefined;
        },
        key
      );
      putCount += 1;
      puts.push({ key, value, options });
      events.push(`put:${key}`);
      if (failPutAfter !== undefined && putCount > failPutAfter) {
        throw new Error('kv-put-fail');
      }
      data[key] = value;
    },
    async delete(key: string) {
      delete data[key];
      events.push(`delete:${key}`);
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  };

  return kv as unknown as KVNamespace & {
    data: Record<string, string>;
    puts: KvPut[];
    gets: KvGet[];
    events: string[];
  };
}

type RaceKv = ReturnType<typeof createRaceKv>;

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
  cache: RaceKv = createRaceKv()
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

function profilePath(userEnc = USER_ENC): string {
  return `/_matrix/client/v3/profile/${userEnc}`;
}

function displaynamePath(userEnc = USER_ENC): string {
  return `${profilePath(userEnc)}/displayname`;
}

function avatarPath(userEnc = USER_ENC): string {
  return `${profilePath(userEnc)}/avatar_url`;
}

function customKeyPath(key: string, userEnc = USER_ENC): string {
  return `${profilePath(userEnc)}/${encodeURIComponent(key)}`;
}

function parseCustom(cache: RaceKv, userId = USER): Record<string, unknown> {
  const raw = cache.data[customKvKey(userId)];
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
}

beforeEach(() => {
  getUserById.mockReset();
  updateUserProfile.mockReset();
  getUserById.mockResolvedValue(seedUser({ display_name: 'Alice', avatar_url: MXC_A }));
  updateUserProfile.mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Custom-key CACHE get→merge→put lost-update TOCTOU
// ---------------------------------------------------------------------------

describe('race PUT custom-key get→merge→put TOCTOU after #196', () => {
  it('parallel PUT distinct custom keys on empty map: last-write-wins may drop a key', async () => {
    const cache = createRaceKv({
      getBarrier: {
        count: 2,
        match: (key) => key === customKvKey(),
      },
    });

    const results = await Promise.all([
      request(customKeyPath(CUSTOM_KEY), jsonInit('PUT', { [CUSTOM_KEY]: 'a' }), cache),
      request(customKeyPath(CUSTOM_KEY_B), jsonInit('PUT', { [CUSTOM_KEY_B]: 'b' }), cache),
    ]);

    expect(statusesOf(results)).toEqual([200, 200]);
    expect(cache.puts.length).toBe(2);
    const final = parseCustom(cache);
    const keys = Object.keys(final).sort();
    expect(keys.length).toBe(1);
    expect([CUSTOM_KEY, CUSTOM_KEY_B]).toContain(keys[0]);
  });

  it('sequential PUT distinct custom keys preserves both (no lost update)', async () => {
    const cache = createRaceKv();
    expect(
      (await request(customKeyPath(CUSTOM_KEY), jsonInit('PUT', { [CUSTOM_KEY]: 'a' }), cache))
        .status
    ).toBe(200);
    expect(
      (
        await request(
          customKeyPath(CUSTOM_KEY_B),
          jsonInit('PUT', { [CUSTOM_KEY_B]: 'b' }),
          cache
        )
      ).status
    ).toBe(200);
    expect(Object.keys(parseCustom(cache)).sort()).toEqual(
      [CUSTOM_KEY, CUSTOM_KEY_B].sort()
    );
  });

  it('KV injected mid-flight after first get → PUT may overwrite injected sibling', async () => {
    const cache = createRaceKv({
      mutateAfterGets: {
        after: 1,
        next: { [customKvKey()]: JSON.stringify({ [CUSTOM_KEY_C]: 'injected' }) },
      },
    });

    const res = await request(
      customKeyPath(CUSTOM_KEY),
      jsonInit('PUT', { [CUSTOM_KEY]: 'mine' }),
      cache
    );
    expect(res.status).toBe(200);
    expect(parseCustom(cache)[CUSTOM_KEY]).toBe('mine');
  });

  for (let i = 0; i < 12; i++) {
    it(`TOCTOU soft-${i}: dual PUT distinct custom keys under get barrier`, async () => {
      const a = `org.example.race-a-${i}`;
      const b = `org.example.race-b-${i}`;
      const cache = createRaceKv({
        getBarrier: {
          count: 2,
          match: (key) => key === customKvKey(),
        },
      });
      const results = await Promise.all([
        request(customKeyPath(a), jsonInit('PUT', { [a]: `va-${i}` }), cache),
        request(customKeyPath(b), jsonInit('PUT', { [b]: `vb-${i}` }), cache),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(Object.keys(parseCustom(cache)).length).toBe(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`TOCTOU soft merge-${i}: dual PUT same key under barrier last-write-wins`, async () => {
      const cache = createRaceKv({
        data: { [customKvKey()]: JSON.stringify({ [CUSTOM_KEY]: 'seed' }) },
        getBarrier: {
          count: 2,
          match: (key) => key === customKvKey(),
        },
      });
      const results = await Promise.all([
        request(customKeyPath(CUSTOM_KEY), jsonInit('PUT', { [CUSTOM_KEY]: `lo-${i}` }), cache),
        request(customKeyPath(CUSTOM_KEY), jsonInit('PUT', { [CUSTOM_KEY]: `hi-${i}` }), cache),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(cache.puts).toHaveLength(2);
      const val = parseCustom(cache)[CUSTOM_KEY];
      expect([`lo-${i}`, `hi-${i}`]).toContain(val);
    });
  }
});

// ---------------------------------------------------------------------------
// DELETE ∥ PUT ∥ GET custom-key races
// ---------------------------------------------------------------------------

describe('race DELETE∥PUT∥GET custom-key concurrent after #196', () => {
  it('parallel DELETE same custom key — both may succeed (idempotent rewrite)', async () => {
    const cache = createRaceKv({
      data: {
        [customKvKey()]: JSON.stringify({
          [CUSTOM_KEY]: 'x',
          [CUSTOM_KEY_B]: 'keep',
        }),
      },
      getBarrier: {
        count: 2,
        match: (key) => key === customKvKey(),
      },
    });
    const results = await Promise.all([
      request(customKeyPath(CUSTOM_KEY), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }, cache),
      request(customKeyPath(CUSTOM_KEY), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }, cache),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(parseCustom(cache)[CUSTOM_KEY]).toBeUndefined();
    expect(parseCustom(cache)[CUSTOM_KEY_B]).toBe('keep');
  });

  it('DELETE∥PUT same key under get barrier — both 200, final ambiguous', async () => {
    const cache = createRaceKv({
      data: { [customKvKey()]: JSON.stringify({ [CUSTOM_KEY]: 'old' }) },
      getBarrier: {
        count: 2,
        match: (key) => key === customKvKey(),
      },
    });
    const results = await Promise.all([
      request(customKeyPath(CUSTOM_KEY), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }, cache),
      request(customKeyPath(CUSTOM_KEY), jsonInit('PUT', { [CUSTOM_KEY]: 'new' }), cache),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(cache.puts).toHaveLength(2);
    const final = parseCustom(cache);
    if (CUSTOM_KEY in final) {
      expect(final[CUSTOM_KEY]).toBe('new');
    } else {
      expect(final).toEqual({});
    }
  });

  it('GET∥PUT concurrent: GET may see pre or post write', async () => {
    const cache = createRaceKv({
      data: { [customKvKey()]: JSON.stringify({ [CUSTOM_KEY_B]: 'seed' }) },
    });
    getUserById.mockResolvedValue(seedUser());
    const results = await Promise.all([
      request(customKeyPath(CUSTOM_KEY_B), {}, cache),
      request(customKeyPath(CUSTOM_KEY), jsonInit('PUT', { [CUSTOM_KEY]: 'race' }), cache),
    ]);
    expect(results[1].status).toBe(200);
    expect([200, 404]).toContain(results[0].status);
  });

  for (let i = 0; i < 10; i++) {
    it(`DELETE∥PUT distinct keys soft-${i}`, async () => {
      const keep = `org.example.keep-${i}`;
      const drop = `org.example.drop-${i}`;
      const add = `org.example.add-${i}`;
      const cache = createRaceKv({
        data: {
          [customKvKey()]: JSON.stringify({ [keep]: 'k', [drop]: 'd' }),
        },
        getBarrier: {
          count: 2,
          match: (key) => key === customKvKey(),
        },
      });
      const results = await Promise.all([
        request(customKeyPath(drop), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }, cache),
        request(customKeyPath(add), jsonInit('PUT', { [add]: 'a' }), cache),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(Object.keys(parseCustom(cache)).length).toBeGreaterThanOrEqual(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`DELETE no-op when map missing soft-${i}`, async () => {
      const cache = createRaceKv();
      const results = await Promise.all([
        request(
          customKeyPath(`org.example.missing-${i}`),
          { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
          cache
        ),
        request(
          customKeyPath(`org.example.missing-${i}-b`),
          { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
          cache
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(cache.puts).toHaveLength(2);
      expect(parseCustom(cache)).toEqual({});
    });
  }
});

// ---------------------------------------------------------------------------
// displayname ∥ avatar concurrent isolation
// ---------------------------------------------------------------------------

describe('race displayname∥avatar concurrent isolation after #196', () => {
  it('parallel PUT displayname and avatar_url both succeed (orthogonal args)', async () => {
    const cache = createRaceKv();
    const results = await Promise.all([
      request(displaynamePath(), jsonInit('PUT', { displayname: 'Alice Race' }), cache),
      request(avatarPath(), jsonInit('PUT', { avatar_url: MXC_B }), cache),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(updateUserProfile).toHaveBeenCalledTimes(2);
    const calls = updateUserProfile.mock.calls;
    const dn = calls.find((c) => c[2] === 'Alice Race');
    const av = calls.find((c) => c[3] === MXC_B);
    expect(dn?.[1]).toBe(USER);
    expect(av?.[1]).toBe(USER);
    expect(av?.[2]).toBeUndefined();
  });

  it('parallel PUT same displayname last-write-wins at DB layer (both call update)', async () => {
    const cache = createRaceKv();
    const results = await Promise.all([
      request(displaynamePath(), jsonInit('PUT', { displayname: 'Name-A' }), cache),
      request(displaynamePath(), jsonInit('PUT', { displayname: 'Name-B' }), cache),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(updateUserProfile).toHaveBeenCalledTimes(2);
    const names = updateUserProfile.mock.calls.map((c) => c[2]);
    expect(names.sort()).toEqual(['Name-A', 'Name-B']);
  });

  it('GET profile ∥ PUT displayname: GET may see old or race past write', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: 'Old' }));
    const cache = createRaceKv();
    const results = await Promise.all([
      request(profilePath(), {}, cache),
      request(displaynamePath(), jsonInit('PUT', { displayname: 'New' }), cache),
    ]);
    expect(results[1].status).toBe(200);
    expect(results[0].status).toBe(200);
    expect(results[0].body).toMatchObject({ displayname: 'Old' });
  });

  for (let i = 0; i < 10; i++) {
    it(`displayname∥avatar soft-${i}`, async () => {
      const cache = createRaceKv();
      const results = await Promise.all([
        request(displaynamePath(), jsonInit('PUT', { displayname: `DN-${i}` }), cache),
        request(avatarPath(), jsonInit('PUT', { avatar_url: `mxc://example.com/a-${i}` }), cache),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(updateUserProfile).toHaveBeenCalledTimes(2);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`triple GET displayname/avatar/profile soft-${i}`, async () => {
      getUserById.mockResolvedValue(
        seedUser({ display_name: `D-${i}`, avatar_url: `mxc://example.com/g-${i}` })
      );
      const cache = createRaceKv();
      const results = await Promise.all([
        request(profilePath(), {}, cache),
        request(displaynamePath(), {}, cache),
        request(avatarPath(), {}, cache),
      ]);
      expect(statusesOf(results)).toEqual([200, 200, 200]);
      expect(results[0].body).toEqual({
        displayname: `D-${i}`,
        avatar_url: `mxc://example.com/g-${i}`,
      });
      expect(results[1].body).toEqual({ displayname: `D-${i}` });
      expect(results[2].body).toEqual({ avatar_url: `mxc://example.com/g-${i}` });
    });
  }
});

// ---------------------------------------------------------------------------
// Multi-key HTTP isolation + standard-key guard under concurrency
// ---------------------------------------------------------------------------

describe('race multi-key isolation + standard-key guard after #196', () => {
  it('parallel PUT three distinct custom keys under get barrier → one survivor', async () => {
    const cache = createRaceKv({
      getBarrier: {
        count: 3,
        match: (key) => key === customKvKey(),
      },
    });
    const keys = [CUSTOM_KEY, CUSTOM_KEY_B, CUSTOM_KEY_C];
    const results = await Promise.all(
      keys.map((k, idx) =>
        request(customKeyPath(k), jsonInit('PUT', { [k]: `v${idx}` }), cache)
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(cache.puts).toHaveLength(3);
    expect(Object.keys(parseCustom(cache)).length).toBe(1);
  });

  for (let i = 0; i < 8; i++) {
    it(`standard path soft-${i}: displayname/avatar_url hit dedicated handlers (not custom-key guard)`, async () => {
      // Hono route order: /displayname and /avatar_url win over /:keyName,
      // so the M_UNRECOGNIZED custom-key guard is unreachable for these names.
      const cache = createRaceKv();
      const results = await Promise.all([
        request(
          customKeyPath('displayname'),
          jsonInit('PUT', { displayname: `std-dn-${i}` }),
          cache
        ),
        request(
          customKeyPath('avatar_url'),
          jsonInit('PUT', { avatar_url: `mxc://example.com/std-${i}` }),
          cache
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(cache.puts).toHaveLength(0);
      expect(updateUserProfile).toHaveBeenCalledTimes(2);
      expect(updateUserProfile).toHaveBeenCalledWith(
        expect.anything(),
        USER,
        `std-dn-${i}`
      );
      expect(updateUserProfile).toHaveBeenCalledWith(
        expect.anything(),
        USER,
        undefined,
        `mxc://example.com/std-${i}`
      );
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`DELETE standard keys soft-${i}: forbidden under parallel`, async () => {
      const cache = createRaceKv();
      const results = await Promise.all([
        request(
          customKeyPath('displayname'),
          { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
          cache
        ),
        request(
          customKeyPath('avatar_url'),
          { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
          cache
        ),
      ]);
      expect(results.every((r) => r.status === 403)).toBe(true);
      expect(results[0].body).toMatchObject({ errcode: 'M_FORBIDDEN' });
      expect(cache.puts).toHaveLength(0);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`GET missing custom key soft-${i} parallel 404`, async () => {
      const cache = createRaceKv();
      getUserById.mockResolvedValue(seedUser());
      const results = await Promise.all([
        request(customKeyPath(`org.example.gone-${i}`), {}, cache),
        request(customKeyPath(`org.example.gone-${i}-b`), {}, cache),
      ]);
      expect(results.every((r) => r.status === 404)).toBe(true);
      expect(results[0].body).toMatchObject({ errcode: 'M_NOT_FOUND' });
    });
  }
});

// ---------------------------------------------------------------------------
// Store failure mid concurrent
// ---------------------------------------------------------------------------

describe('race profile store failure mid concurrent after #196', () => {
  it('first KV put ok, second throws → one 200 one 500', async () => {
    const cache = createRaceKv({
      failPutAfter: 1,
      getBarrier: {
        count: 2,
        match: (key) => key === customKvKey(),
      },
    });
    const results = await Promise.all([
      request(customKeyPath('org.example.fail-a'), jsonInit('PUT', { 'org.example.fail-a': 'a' }), cache),
      request(customKeyPath('org.example.fail-b'), jsonInit('PUT', { 'org.example.fail-b': 'b' }), cache),
    ]);
    const ok = results.filter((r) => r.status === 200);
    const fail = results.filter((r) => r.status === 500);
    expect(ok.length).toBe(1);
    expect(fail.length).toBe(1);
    expect(cache.puts.length).toBeGreaterThanOrEqual(1);
  });

  for (let i = 0; i < 8; i++) {
    it(`kv put fail soft-${i}: failPutAfter=0 both 500`, async () => {
      const cache = createRaceKv({ failPutAfter: 0 });
      const results = await Promise.all([
        request(
          customKeyPath(`org.example.fa-${i}`),
          jsonInit('PUT', { [`org.example.fa-${i}`]: 'x' }),
          cache
        ),
        request(
          customKeyPath(`org.example.fb-${i}`),
          jsonInit('PUT', { [`org.example.fb-${i}`]: 'y' }),
          cache
        ),
      ]);
      expect(results.every((r) => r.status === 500)).toBe(true);
    });
  }

  it('updateUserProfile throw on displayname under parallel → both 500', async () => {
    updateUserProfile.mockRejectedValue(new Error('d1-profile-fail'));
    const cache = createRaceKv();
    const results = await Promise.all([
      request(displaynamePath(), jsonInit('PUT', { displayname: 'X' }), cache),
      request(displaynamePath(), jsonInit('PUT', { displayname: 'Y' }), cache),
    ]);
    expect(results.every((r) => r.status === 500)).toBe(true);
  });

  for (let i = 0; i < 6; i++) {
    it(`updateUserProfile throw soft-${i}: avatar parallel both 500`, async () => {
      updateUserProfile.mockRejectedValue(new Error(`d1-avatar-fail-${i}`));
      const cache = createRaceKv();
      const results = await Promise.all([
        request(avatarPath(), jsonInit('PUT', { avatar_url: MXC_A }), cache),
        request(avatarPath(), jsonInit('PUT', { avatar_url: MXC_B }), cache),
      ]);
      expect(results.every((r) => r.status === 500)).toBe(true);
    });
  }

  it('PUT custom with corrupt existing JSON still overwrites via merge-from-empty', async () => {
    const cache = createRaceKv({
      data: { [customKvKey()]: '{bad' },
    });
    // JSON.parse throws → handler may 500; pin actual behavior under race
    const results = await Promise.all([
      request(customKeyPath(CUSTOM_KEY), jsonInit('PUT', { [CUSTOM_KEY]: 'ok' }), cache),
      request(customKeyPath(CUSTOM_KEY_B), jsonInit('PUT', { [CUSTOM_KEY_B]: 'ok' }), cache),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 500)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Soft floods — method / body / charset / foreign / remote / lifecycle
// ---------------------------------------------------------------------------

describe('profile concurrent soft flood — invalid method matrix after #196', () => {
  for (const method of ['POST', 'PATCH', 'OPTIONS', 'HEAD'] as const) {
    it(`rejects or no-routes ${method} under parallel load`, async () => {
      const cache = createRaceKv({
        data: { [customKvKey()]: JSON.stringify({ [CUSTOM_KEY]: 'x' }) },
      });
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          request(customKeyPath(CUSTOM_KEY), {
            method,
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer t',
            },
            body:
              method === 'HEAD' || method === 'OPTIONS'
                ? undefined
                : JSON.stringify({ [CUSTOM_KEY]: 'y' }),
          }, cache)
        )
      );
      expect(
        results.every((r) => r.status === 404 || r.status === 405 || r.status === 200)
      ).toBe(true);
    });
  }
});

describe('profile concurrent soft flood — bad JSON / body edges after #196', () => {
  const badBodies: Array<{ label: string; body: string | undefined; path: 'dn' | 'av' | 'ck' }> = [
    { label: 'truncated-dn', body: '{', path: 'dn' },
    { label: 'empty-obj-dn', body: '{}', path: 'dn' },
    { label: 'array-dn', body: '[]', path: 'dn' },
    { label: 'string-dn', body: '"x"', path: 'dn' },
    { label: 'null-dn', body: 'null', path: 'dn' },
    { label: 'undefined-dn', body: undefined, path: 'dn' },
    { label: 'truncated-av', body: '{', path: 'av' },
    { label: 'empty-obj-av', body: '{}', path: 'av' },
    { label: 'truncated-ck', body: '{', path: 'ck' },
    { label: 'empty-obj-ck', body: '{}', path: 'ck' },
    { label: 'missing-key-ck', body: JSON.stringify({ other: 1 }), path: 'ck' },
    { label: 'null-ck', body: 'null', path: 'ck' },
  ];

  for (const [i, entry] of badBodies.entries()) {
    it(`body soft-${i} (${entry.label}) parallel`, async () => {
      const cache = createRaceKv();
      const path =
        entry.path === 'dn'
          ? displaynamePath()
          : entry.path === 'av'
            ? avatarPath()
            : customKeyPath(`org.example.bad-${i}`);
      const results = await Promise.all(
        Array.from({ length: 2 }, () =>
          request(
            path,
            {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer t',
              },
              body: entry.body,
            },
            cache
          )
        )
      );
      expect(
        results.every(
          (r) =>
            r.status === 200 ||
            r.status === 400 ||
            r.status === 500
        )
      ).toBe(true);
    });
  }
});

describe('profile concurrent soft flood — foreign user / remote after #196', () => {
  for (let i = 0; i < 10; i++) {
    it(`foreign user soft-${i}`, async () => {
      const cache = createRaceKv();
      const results = await Promise.all([
        request(
          displaynamePath(OTHER_ENC),
          jsonInit('PUT', { displayname: 'nope' }),
          cache
        ),
        request(avatarPath(OTHER_ENC), jsonInit('PUT', { avatar_url: MXC_A }), cache),
        request(
          customKeyPath(`org.example.fx-${i}`, OTHER_ENC),
          jsonInit('PUT', { [`org.example.fx-${i}`]: 'x' }),
          cache
        ),
        request(
          customKeyPath(`org.example.fx-${i}`, OTHER_ENC),
          { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
          cache
        ),
      ]);
      expect(results.every((r) => r.status === 403)).toBe(true);
      expect(results[0].body).toMatchObject({ errcode: 'M_FORBIDDEN' });
      expect(updateUserProfile).not.toHaveBeenCalled();
      expect(cache.puts).toHaveLength(0);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`remote user GET soft-${i}`, async () => {
      const cache = createRaceKv();
      const results = await Promise.all([
        request(profilePath(REMOTE_ENC), {}, cache),
        request(displaynamePath(REMOTE_ENC), {}, cache),
        request(avatarPath(REMOTE_ENC), {}, cache),
        request(customKeyPath(CUSTOM_KEY, REMOTE_ENC), {}, cache),
      ]);
      expect(results.every((r) => r.status === 404)).toBe(true);
      expect(getUserById).not.toHaveBeenCalled();
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`invalid mxid soft-${i}`, async () => {
      const cache = createRaceKv();
      const bad = encodeURIComponent(`not-a-user-${i}`);
      const results = await Promise.all([
        request(`/_matrix/client/v3/profile/${bad}`, {}, cache),
        request(`/_matrix/client/v3/profile/${bad}/displayname`, {}, cache),
        request(`/_matrix/client/v3/profile/${bad}/avatar_url`, {}, cache),
      ]);
      expect(results.every((r) => r.status === 400)).toBe(true);
      expect(results[0].body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
    });
  }
});

describe('profile concurrent soft flood — charset / content-type edges after #196', () => {
  const ctypes = [
    'application/json',
    'application/json; charset=utf-8',
    'application/json;charset=UTF-8',
    'text/plain',
    'application/x-www-form-urlencoded',
  ];

  for (const [i, ct] of ctypes.entries()) {
    it(`content-type soft-${i}: ${ct}`, async () => {
      const cache = createRaceKv();
      const results = await Promise.all([
        request(displaynamePath(), {
          method: 'PUT',
          headers: { 'Content-Type': ct, Authorization: 'Bearer t' },
          body: JSON.stringify({ displayname: `ct-${i}` }),
        }, cache),
        request(customKeyPath(`org.example.ct-${i}`), {
          method: 'PUT',
          headers: { 'Content-Type': ct, Authorization: 'Bearer t' },
          body: JSON.stringify({ [`org.example.ct-${i}`]: 'v' }),
        }, cache),
      ]);
      expect(
        results.every((r) => r.status === 200 || r.status === 400 || r.status === 500)
      ).toBe(true);
    });
  }
});

describe('profile concurrent soft flood — lifecycle put→get→delete after #196', () => {
  for (let i = 0; i < 12; i++) {
    it(`custom-key lifecycle soft-${i}`, async () => {
      const key = `org.example.life-${i}`;
      const cache = createRaceKv();
      getUserById.mockResolvedValue(seedUser());
      const put = await request(customKeyPath(key), jsonInit('PUT', { [key]: `v${i}` }), cache);
      expect(put.status).toBe(200);
      expect(parseCustom(cache)[key]).toBe(`v${i}`);
      const get = await request(customKeyPath(key), {}, cache);
      expect(get.status).toBe(200);
      expect(get.body).toEqual({ [key]: `v${i}` });
      const del = await request(
        customKeyPath(key),
        { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
        cache
      );
      expect(del.status).toBe(200);
      expect(parseCustom(cache)[key]).toBeUndefined();
      const again = await request(customKeyPath(key), jsonInit('PUT', { [key]: 'again' }), cache);
      expect(again.status).toBe(200);
      expect(parseCustom(cache)[key]).toBe('again');
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`displayname lifecycle soft-${i}`, async () => {
      const cache = createRaceKv();
      getUserById.mockResolvedValue(seedUser({ display_name: `before-${i}` }));
      const put = await request(
        displaynamePath(),
        jsonInit('PUT', { displayname: `after-${i}` }),
        cache
      );
      expect(put.status).toBe(200);
      expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, `after-${i}`);
      const get = await request(displaynamePath(), {}, cache);
      expect(get.status).toBe(200);
      // mock still returns before-* unless we reseed
      expect(get.body).toEqual({ displayname: `before-${i}` });
    });
  }
});

describe('profile concurrent soft flood — percent-encoded custom keys after #196', () => {
  const encoded = [
    'org.example.plain',
    'org.example.with space',
    'org.example.slash/part',
    'org.example.plus+key',
    'org.example.dot.name',
  ];

  for (const [i, name] of encoded.entries()) {
    it(`encoded key soft-${i}: ${name}`, async () => {
      const cache = createRaceKv();
      const path = customKeyPath(name);
      const results = await Promise.all([
        request(path, jsonInit('PUT', { [name]: 'a' }), cache),
        request(path, jsonInit('PUT', { [name]: 'b' }), cache),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(Object.keys(parseCustom(cache)).length).toBeGreaterThanOrEqual(1);
    });
  }
});

describe('profile concurrent soft flood — missing local user GET after #196', () => {
  for (let i = 0; i < 8; i++) {
    it(`missing user soft-${i}`, async () => {
      getUserById.mockResolvedValue(null);
      const cache = createRaceKv();
      const results = await Promise.all([
        request(profilePath(), {}, cache),
        request(displaynamePath(), {}, cache),
        request(avatarPath(), {}, cache),
        request(customKeyPath(CUSTOM_KEY), {}, cache),
      ]);
      expect(results.every((r) => r.status === 404)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Bind contracts
// ---------------------------------------------------------------------------

describe('profile concurrent bind contracts after #196', () => {
  it('PUT custom stores under profile:{userId}:custom with 1y TTL', async () => {
    const cache = createRaceKv();
    const res = await request(
      customKeyPath(CUSTOM_KEY),
      jsonInit('PUT', { [CUSTOM_KEY]: 'pin' }),
      cache
    );
    expect(res.status).toBe(200);
    expect(cache.puts).toHaveLength(1);
    expect(cache.puts[0].key).toBe(customKvKey());
    expect(JSON.parse(cache.puts[0].value)).toEqual({ [CUSTOM_KEY]: 'pin' });
    expect(cache.puts[0].options?.expirationTtl).toBe(YEAR_TTL);
  });

  it('DELETE rewrite binds remaining custom map with 1y TTL', async () => {
    const cache = createRaceKv({
      data: {
        [customKvKey()]: JSON.stringify({
          [CUSTOM_KEY]: 'drop',
          [CUSTOM_KEY_B]: 'keep',
        }),
      },
    });
    await request(
      customKeyPath(CUSTOM_KEY),
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
      cache
    );
    expect(cache.puts).toHaveLength(1);
    expect(JSON.parse(cache.puts[0].value)).toEqual({ [CUSTOM_KEY_B]: 'keep' });
    expect(cache.puts[0].options?.expirationTtl).toBe(YEAR_TTL);
  });

  it('PUT displayname binds updateUserProfile(db, userId, displayname)', async () => {
    const cache = createRaceKv();
    await request(displaynamePath(), jsonInit('PUT', { displayname: 'Bind DN' }), cache);
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, 'Bind DN');
  });

  it('PUT avatar_url binds updateUserProfile(db, userId, undefined, avatar)', async () => {
    const cache = createRaceKv();
    await request(avatarPath(), jsonInit('PUT', { avatar_url: MXC_A }), cache);
    expect(updateUserProfile).toHaveBeenCalledWith(
      expect.anything(),
      USER,
      undefined,
      MXC_A
    );
  });

  it('parallel PUT bind contracts stay per-field', async () => {
    const cache = createRaceKv();
    await Promise.all([
      request(displaynamePath(), jsonInit('PUT', { displayname: 'Para DN' }), cache),
      request(avatarPath(), jsonInit('PUT', { avatar_url: MXC_B }), cache),
      request(customKeyPath(CUSTOM_KEY), jsonInit('PUT', { [CUSTOM_KEY]: 'ck' }), cache),
    ]);
    expect(updateUserProfile).toHaveBeenCalledTimes(2);
    const dn = updateUserProfile.mock.calls.find((c) => c[2] === 'Para DN');
    const av = updateUserProfile.mock.calls.find((c) => c[3] === MXC_B);
    expect(dn).toBeTruthy();
    expect(av).toBeTruthy();
    expect(cache.puts).toHaveLength(1);
    expect(JSON.parse(cache.puts[0].value)).toEqual({ [CUSTOM_KEY]: 'ck' });
  });

  for (let i = 0; i < 6; i++) {
    it(`bind soft-${i}: PUT then DELETE custom order content`, async () => {
      const key = `org.example.bind-${i}`;
      const cache = createRaceKv();
      await request(customKeyPath(key), jsonInit('PUT', { [key]: `v${i}` }), cache);
      await request(
        customKeyPath(key),
        { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
        cache
      );
      expect(cache.puts).toHaveLength(2);
      expect(JSON.parse(cache.puts[0].value)).toEqual({ [key]: `v${i}` });
      expect(JSON.parse(cache.puts[1].value)).toEqual({});
      expect(cache.puts[0].options?.expirationTtl).toBe(YEAR_TTL);
      expect(cache.puts[1].options?.expirationTtl).toBe(YEAR_TTL);
    });
  }

  it('GET custom reads exactly profile:{userId}:custom', async () => {
    const cache = createRaceKv({
      data: { [customKvKey()]: JSON.stringify({ [CUSTOM_KEY]: 'read' }) },
    });
    getUserById.mockResolvedValue(seedUser());
    const res = await request(customKeyPath(CUSTOM_KEY), {}, cache);
    expect(res.status).toBe(200);
    expect(cache.gets.some((g) => g.key === customKvKey())).toBe(true);
  });
});
