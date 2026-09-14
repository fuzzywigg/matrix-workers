/**
 * TOKENMAXX HEAVY deepen — different slice: profile API routes (+ custom keys).
 * Avoids search (#94), key-backups (#96), oauth (#90), spaces (#89).
 * Companion to devices/aliases/relations/tags route deepen.
 * Tests-only — no product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, User } from '../src/types';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICE');
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
const REMOTE = '@carol:remote.org';
const USER_ENC = encodeURIComponent(USER);
const OTHER_ENC = encodeURIComponent(OTHER);
const REMOTE_ENC = encodeURIComponent(REMOTE);
const SERVER = 'example.com';

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };

function mockKv(data: Record<string, string> = {}) {
  const puts: KvPut[] = [];
  return {
    data,
    puts,
    get: async (key: string) => data[key] ?? null,
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      data[key] = value;
      puts.push({ key, value, options });
    },
    delete: async (key: string) => {
      delete data[key];
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace & { data: Record<string, string>; puts: KvPut[] };
}

function envFor(cache: ReturnType<typeof mockKv>): Env {
  return {
    DB: {} as D1Database,
    CACHE: cache,
    SERVER_NAME: SERVER,
  } as unknown as Env;
}

async function request(
  path: string,
  init: RequestInit = {},
  cache: ReturnType<typeof mockKv> = mockKv()
): Promise<{ status: number; body: unknown; cache: ReturnType<typeof mockKv> }> {
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

beforeEach(() => {
  getUserById.mockReset();
  updateUserProfile.mockReset();
  updateUserProfile.mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('profile GET /profile/:userId', () => {
  it('rejects invalid user id format', async () => {
    const res = await request('/_matrix/client/v3/profile/not-a-mxid');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('returns 404 for remote (non-local) users without federation lookup', async () => {
    const res = await request(`/_matrix/client/v3/profile/${REMOTE_ENC}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('returns 404 when local user missing', async () => {
    getUserById.mockResolvedValue(null);
    const res = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(res.status).toBe(404);
  });

  it('returns displayname/avatar_url nulls when unset (Element X directory probe)', async () => {
    getUserById.mockResolvedValue(seedUser({}));
    const res = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ displayname: null, avatar_url: null });
  });

  it('returns both fields when set', async () => {
    getUserById.mockResolvedValue(
      seedUser({ display_name: 'Alice', avatar_url: 'mxc://example.com/a' })
    );
    const res = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      displayname: 'Alice',
      avatar_url: 'mxc://example.com/a',
    });
  });

  it('accepts case-insensitive local server name', async () => {
    getUserById.mockResolvedValue(seedUser({ user_id: '@alice:Example.COM' }));
    const res = await request(
      `/_matrix/client/v3/profile/${encodeURIComponent('@alice:Example.COM')}`
    );
    expect(res.status).toBe(200);
    expect(getUserById).toHaveBeenCalled();
  });
});

describe('profile GET/PUT displayname', () => {
  it('GET rejects invalid / remote / missing same as profile', async () => {
    const a = await request('/_matrix/client/v3/profile/bad/displayname');
    expect(a.status).toBe(400);

    const b = await request(`/_matrix/client/v3/profile/${REMOTE_ENC}/displayname`);
    expect(b.status).toBe(404);

    getUserById.mockResolvedValue(null);
    const c = await request(`/_matrix/client/v3/profile/${USER_ENC}/displayname`);
    expect(c.status).toBe(404);
  });

  it('GET returns displayname null or string', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: undefined }));
    const a = await request(`/_matrix/client/v3/profile/${USER_ENC}/displayname`);
    expect(a.body).toEqual({ displayname: null });

    getUserById.mockResolvedValue(seedUser({ display_name: 'A' }));
    const b = await request(`/_matrix/client/v3/profile/${USER_ENC}/displayname`);
    expect(b.body).toEqual({ displayname: 'A' });
  });

  it('PUT forbids modifying another user', async () => {
    const res = await request(
      `/_matrix/client/v3/profile/${OTHER_ENC}/displayname`,
      jsonInit('PUT', { displayname: 'X' })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
    expect(updateUserProfile).not.toHaveBeenCalled();
  });

  it('PUT rejects bad JSON', async () => {
    const res = await request(`/_matrix/client/v3/profile/${USER_ENC}/displayname`, {
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

  it('PUT updates own displayname (including undefined field → still calls)', async () => {
    const res = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: 'Alice Wonder' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(
      expect.anything(),
      USER,
      'Alice Wonder'
    );
  });

  it('PUT with empty body object passes undefined displayname through', async () => {
    const res = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', {})
    );
    expect(res.status).toBe(200);
    expect(updateUserProfile).toHaveBeenCalledWith(
      expect.anything(),
      USER,
      undefined
    );
  });
});

describe('profile GET/PUT avatar_url', () => {
  it('GET invalid / remote / missing', async () => {
    expect(
      (await request('/_matrix/client/v3/profile/x/avatar_url')).status
    ).toBe(400);
    expect(
      (await request(`/_matrix/client/v3/profile/${REMOTE_ENC}/avatar_url`)).status
    ).toBe(404);
    getUserById.mockResolvedValue(null);
    expect(
      (await request(`/_matrix/client/v3/profile/${USER_ENC}/avatar_url`)).status
    ).toBe(404);
  });

  it('GET returns avatar_url null or value', async () => {
    getUserById.mockResolvedValue(seedUser({}));
    expect(
      (await request(`/_matrix/client/v3/profile/${USER_ENC}/avatar_url`)).body
    ).toEqual({ avatar_url: null });

    getUserById.mockResolvedValue(seedUser({ avatar_url: 'mxc://e/x' }));
    expect(
      (await request(`/_matrix/client/v3/profile/${USER_ENC}/avatar_url`)).body
    ).toEqual({ avatar_url: 'mxc://e/x' });
  });

  it('PUT forbids other user + bad JSON', async () => {
    const a = await request(
      `/_matrix/client/v3/profile/${OTHER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: 'mxc://e/x' })
    );
    expect(a.status).toBe(403);

    const b = await request(`/_matrix/client/v3/profile/${USER_ENC}/avatar_url`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer t',
      },
      body: 'nope',
    });
    expect(b.status).toBe(400);
    expect(b.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('PUT updates own avatar via updateUserProfile(undefined, avatar)', async () => {
    const res = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: 'mxc://example.com/av' })
    );
    expect(res.status).toBe(200);
    expect(updateUserProfile).toHaveBeenCalledWith(
      expect.anything(),
      USER,
      undefined,
      'mxc://example.com/av'
    );
  });
});

describe('profile custom keys GET/PUT/DELETE', () => {
  it('GET: invalid user / remote / missing user', async () => {
    expect(
      (await request('/_matrix/client/v3/profile/bad/timezone')).status
    ).toBe(400);
    expect(
      (await request(`/_matrix/client/v3/profile/${REMOTE_ENC}/timezone`)).status
    ).toBe(404);
    getUserById.mockResolvedValue(null);
    expect(
      (await request(`/_matrix/client/v3/profile/${USER_ENC}/timezone`)).status
    ).toBe(404);
  });

  it('GET: 404 when custom key absent (empty or missing map entry)', async () => {
    getUserById.mockResolvedValue(seedUser());
    const a = await request(`/_matrix/client/v3/profile/${USER_ENC}/timezone`);
    expect(a.status).toBe(404);
    expect(a.body).toMatchObject({
      errcode: 'M_NOT_FOUND',
      error: "Profile key 'timezone' not found",
    });

    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ other: 1 }),
    });
    const b = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      {},
      cache
    );
    expect(b.status).toBe(404);
  });

  it('GET: returns custom key value', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ timezone: 'UTC', extra: true }),
    });
    const res = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      {},
      cache
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ timezone: 'UTC' });
  });

  it('PUT: forbids other user', async () => {
    const res = await request(
      `/_matrix/client/v3/profile/${OTHER_ENC}/timezone`,
      jsonInit('PUT', { timezone: 'UTC' })
    );
    expect(res.status).toBe(403);
  });

  it('PUT displayname path is shadowed by dedicated route (not :keyName)', async () => {
    const res = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: 'X' })
    );
    // Specific PUT /displayname wins over :keyName — not M_UNRECOGNIZED.
    expect(res.status).toBe(200);
    expect(updateUserProfile).toHaveBeenCalledWith(
      expect.anything(),
      USER,
      'X'
    );
  });

  it('PUT avatar_url path is shadowed by dedicated route', async () => {
    const res = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: 'mxc://e/y' })
    );
    expect(res.status).toBe(200);
    expect(updateUserProfile).toHaveBeenCalledWith(
      expect.anything(),
      USER,
      undefined,
      'mxc://e/y'
    );
  });

  it('PUT: bad JSON / missing key in body', async () => {
    const a = await request(`/_matrix/client/v3/profile/${USER_ENC}/timezone`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer t',
      },
      body: '{',
    });
    expect(a.status).toBe(400);
    expect(a.body).toMatchObject({ errcode: 'M_BAD_JSON' });

    const b = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      jsonInit('PUT', { wrong: 1 })
    );
    expect(b.status).toBe(400);
    expect(b.body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: "Missing 'timezone' in request body",
    });
  });

  it('PUT: creates custom profile blob with 1-year TTL', async () => {
    const cache = mockKv();
    const res = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      jsonInit('PUT', { timezone: 'America/New_York' }),
      cache
    );
    expect(res.status).toBe(200);
    expect(cache.data[`profile:${USER}:custom`]).toBe(
      JSON.stringify({ timezone: 'America/New_York' })
    );
    expect(cache.puts[0].options?.expirationTtl).toBe(365 * 24 * 60 * 60);
  });

  it('PUT: merges into existing custom keys', async () => {
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ timezone: 'UTC' }),
    });
    await request(
      `/_matrix/client/v3/profile/${USER_ENC}/dob`,
      jsonInit('PUT', { dob: '2000-01-01' }),
      cache
    );
    expect(JSON.parse(cache.data[`profile:${USER}:custom`])).toEqual({
      timezone: 'UTC',
      dob: '2000-01-01',
    });
  });

  it('PUT: allows null / nested / numeric custom values', async () => {
    const cache = mockKv();
    await request(
      `/_matrix/client/v3/profile/${USER_ENC}/meta`,
      jsonInit('PUT', { meta: { n: 1, z: null } }),
      cache
    );
    expect(JSON.parse(cache.data[`profile:${USER}:custom`])).toEqual({
      meta: { n: 1, z: null },
    });
  });

  it('DELETE: forbids other user', async () => {
    const res = await request(
      `/_matrix/client/v3/profile/${OTHER_ENC}/timezone`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(403);
  });

  it('DELETE: forbids deleting standard keys via generic endpoint', async () => {
    const a = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(a.status).toBe(403);
    expect(a.body).toMatchObject({
      error: 'Cannot delete standard profile keys',
    });

    const b = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(b.status).toBe(403);
  });

  it('DELETE: removes key and rewrites KV (idempotent if absent)', async () => {
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({
        timezone: 'UTC',
        keep: true,
      }),
    });
    const res = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
      cache
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(cache.data[`profile:${USER}:custom`])).toEqual({ keep: true });
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(365 * 24 * 60 * 60);

    const res2 = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/missing`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
      cache
    );
    expect(res2.status).toBe(200);
    expect(JSON.parse(cache.data[`profile:${USER}:custom`])).toEqual({ keep: true });
  });

  it('DELETE: when no custom blob exists, writes empty object', async () => {
    const cache = mockKv();
    const res = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
      cache
    );
    expect(res.status).toBe(200);
    expect(cache.data[`profile:${USER}:custom`]).toBe('{}');
  });
});
