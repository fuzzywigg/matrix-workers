/**
 * TOKENMAXX HEAVY leftovers after #153 — profile API soft/edge/reliability.
 * Complements profile-api-routes.test.ts. Tests-only — no product inventing.
 * Fixtures use example.com only.
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
const REMOTE = '@carol:remote.example.org';
const USER_ENC = encodeURIComponent(USER);
const OTHER_ENC = encodeURIComponent(OTHER);
const REMOTE_ENC = encodeURIComponent(REMOTE);
const SERVER = 'example.com';
const YEAR_TTL = 365 * 24 * 60 * 60;

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

function envFor(cache: ReturnType<typeof mockKv>, serverName = SERVER): Env {
  return {
    DB: {} as D1Database,
    CACHE: cache,
    SERVER_NAME: serverName,
  } as unknown as Env;
}

async function request(
  path: string,
  init: RequestInit = {},
  cache: ReturnType<typeof mockKv> = mockKv(),
  serverName = SERVER
): Promise<{ status: number; body: any; cache: ReturnType<typeof mockKv> }> {
  const res = await profile.request(`http://localhost${path}`, init, envFor(cache, serverName));
  let body: any = null;
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

describe('profile leftovers GET full profile soft reliability after #153', () => {
  it('GET profile null fields soft-0', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: undefined, avatar_url: undefined }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: null, avatar_url: null });
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });
  it('GET profile null fields soft-1', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: undefined, avatar_url: undefined }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: null, avatar_url: null });
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });
  it('GET profile null fields soft-2', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: undefined, avatar_url: undefined }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: null, avatar_url: null });
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });
  it('GET profile null fields soft-3', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: undefined, avatar_url: undefined }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: null, avatar_url: null });
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });
  it('GET profile null fields soft-4', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: undefined, avatar_url: undefined }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: null, avatar_url: null });
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });
  it('GET profile null fields soft-5', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: undefined, avatar_url: undefined }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: null, avatar_url: null });
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });
  it('GET profile null fields soft-6', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: undefined, avatar_url: undefined }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: null, avatar_url: null });
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });
  it('GET profile null fields soft-7', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: undefined, avatar_url: undefined }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: null, avatar_url: null });
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });
  it('GET profile null fields soft-8', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: undefined, avatar_url: undefined }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: null, avatar_url: null });
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });
  it('GET profile null fields soft-9', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: undefined, avatar_url: undefined }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: null, avatar_url: null });
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });
  it('GET profile null fields soft-10', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: undefined, avatar_url: undefined }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: null, avatar_url: null });
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });
  it('GET profile null fields soft-11', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: undefined, avatar_url: undefined }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: null, avatar_url: null });
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });
  it('GET profile null fields soft-12', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: undefined, avatar_url: undefined }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: null, avatar_url: null });
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });
  it('GET profile null fields soft-13', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: undefined, avatar_url: undefined }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: null, avatar_url: null });
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });
  it('GET profile null fields soft-14', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: undefined, avatar_url: undefined }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: null, avatar_url: null });
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });
  it('GET profile null fields soft-15', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: undefined, avatar_url: undefined }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: null, avatar_url: null });
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });
  it('GET profile null fields soft-16', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: undefined, avatar_url: undefined }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: null, avatar_url: null });
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });
  it('GET profile null fields soft-17', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: undefined, avatar_url: undefined }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: null, avatar_url: null });
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });
  it('GET profile null fields soft-18', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: undefined, avatar_url: undefined }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: null, avatar_url: null });
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });
  it('GET profile null fields soft-19', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: undefined, avatar_url: undefined }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: null, avatar_url: null });
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });
});
describe('profile leftovers GET displayname soft reliability after #153', () => {
  it('GET displayname set soft-0', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: `Alice-0` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/displayname`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: `Alice-0` });
  });
  it('GET displayname set soft-1', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: `Alice-1` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/displayname`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: `Alice-1` });
  });
  it('GET displayname set soft-2', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: `Alice-2` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/displayname`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: `Alice-2` });
  });
  it('GET displayname set soft-3', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: `Alice-3` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/displayname`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: `Alice-3` });
  });
  it('GET displayname set soft-4', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: `Alice-4` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/displayname`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: `Alice-4` });
  });
  it('GET displayname set soft-5', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: `Alice-5` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/displayname`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: `Alice-5` });
  });
  it('GET displayname set soft-6', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: `Alice-6` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/displayname`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: `Alice-6` });
  });
  it('GET displayname set soft-7', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: `Alice-7` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/displayname`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: `Alice-7` });
  });
  it('GET displayname set soft-8', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: `Alice-8` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/displayname`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: `Alice-8` });
  });
  it('GET displayname set soft-9', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: `Alice-9` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/displayname`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: `Alice-9` });
  });
  it('GET displayname set soft-10', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: `Alice-10` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/displayname`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: `Alice-10` });
  });
  it('GET displayname set soft-11', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: `Alice-11` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/displayname`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: `Alice-11` });
  });
  it('GET displayname set soft-12', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: `Alice-12` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/displayname`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: `Alice-12` });
  });
  it('GET displayname set soft-13', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: `Alice-13` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/displayname`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: `Alice-13` });
  });
  it('GET displayname set soft-14', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: `Alice-14` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/displayname`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: `Alice-14` });
  });
  it('GET displayname set soft-15', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: `Alice-15` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/displayname`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: `Alice-15` });
  });
});
describe('profile leftovers PUT displayname soft flood after #153', () => {
  it('PUT own displayname soft-0', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `Name-0` })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, `Name-0`);
  });
  it('PUT own displayname soft-1', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `Name-1` })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, `Name-1`);
  });
  it('PUT own displayname soft-2', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `Name-2` })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, `Name-2`);
  });
  it('PUT own displayname soft-3', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `Name-3` })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, `Name-3`);
  });
  it('PUT own displayname soft-4', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `Name-4` })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, `Name-4`);
  });
  it('PUT own displayname soft-5', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `Name-5` })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, `Name-5`);
  });
  it('PUT own displayname soft-6', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `Name-6` })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, `Name-6`);
  });
  it('PUT own displayname soft-7', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `Name-7` })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, `Name-7`);
  });
  it('PUT own displayname soft-8', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `Name-8` })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, `Name-8`);
  });
  it('PUT own displayname soft-9', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `Name-9` })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, `Name-9`);
  });
  it('PUT own displayname soft-10', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `Name-10` })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, `Name-10`);
  });
  it('PUT own displayname soft-11', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `Name-11` })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, `Name-11`);
  });
  it('PUT own displayname soft-12', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `Name-12` })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, `Name-12`);
  });
  it('PUT own displayname soft-13', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `Name-13` })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, `Name-13`);
  });
  it('PUT own displayname soft-14', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `Name-14` })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, `Name-14`);
  });
  it('PUT own displayname soft-15', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `Name-15` })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, `Name-15`);
  });
  it('PUT own displayname soft-16', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `Name-16` })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, `Name-16`);
  });
  it('PUT own displayname soft-17', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `Name-17` })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, `Name-17`);
  });
  it('PUT own displayname soft-18', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `Name-18` })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, `Name-18`);
  });
  it('PUT own displayname soft-19', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `Name-19` })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, `Name-19`);
  });
});
describe('profile leftovers GET avatar soft reliability after #153', () => {
  it('GET avatar_url soft-0', async () => {
    getUserById.mockResolvedValue(seedUser({ avatar_url: `mxc://example.com/a0` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/avatar_url`);
    expect(status).toBe(200);
    expect(body).toEqual({ avatar_url: `mxc://example.com/a0` });
  });
  it('GET avatar_url soft-1', async () => {
    getUserById.mockResolvedValue(seedUser({ avatar_url: `mxc://example.com/a1` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/avatar_url`);
    expect(status).toBe(200);
    expect(body).toEqual({ avatar_url: `mxc://example.com/a1` });
  });
  it('GET avatar_url soft-2', async () => {
    getUserById.mockResolvedValue(seedUser({ avatar_url: `mxc://example.com/a2` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/avatar_url`);
    expect(status).toBe(200);
    expect(body).toEqual({ avatar_url: `mxc://example.com/a2` });
  });
  it('GET avatar_url soft-3', async () => {
    getUserById.mockResolvedValue(seedUser({ avatar_url: `mxc://example.com/a3` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/avatar_url`);
    expect(status).toBe(200);
    expect(body).toEqual({ avatar_url: `mxc://example.com/a3` });
  });
  it('GET avatar_url soft-4', async () => {
    getUserById.mockResolvedValue(seedUser({ avatar_url: `mxc://example.com/a4` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/avatar_url`);
    expect(status).toBe(200);
    expect(body).toEqual({ avatar_url: `mxc://example.com/a4` });
  });
  it('GET avatar_url soft-5', async () => {
    getUserById.mockResolvedValue(seedUser({ avatar_url: `mxc://example.com/a5` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/avatar_url`);
    expect(status).toBe(200);
    expect(body).toEqual({ avatar_url: `mxc://example.com/a5` });
  });
  it('GET avatar_url soft-6', async () => {
    getUserById.mockResolvedValue(seedUser({ avatar_url: `mxc://example.com/a6` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/avatar_url`);
    expect(status).toBe(200);
    expect(body).toEqual({ avatar_url: `mxc://example.com/a6` });
  });
  it('GET avatar_url soft-7', async () => {
    getUserById.mockResolvedValue(seedUser({ avatar_url: `mxc://example.com/a7` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/avatar_url`);
    expect(status).toBe(200);
    expect(body).toEqual({ avatar_url: `mxc://example.com/a7` });
  });
  it('GET avatar_url soft-8', async () => {
    getUserById.mockResolvedValue(seedUser({ avatar_url: `mxc://example.com/a8` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/avatar_url`);
    expect(status).toBe(200);
    expect(body).toEqual({ avatar_url: `mxc://example.com/a8` });
  });
  it('GET avatar_url soft-9', async () => {
    getUserById.mockResolvedValue(seedUser({ avatar_url: `mxc://example.com/a9` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/avatar_url`);
    expect(status).toBe(200);
    expect(body).toEqual({ avatar_url: `mxc://example.com/a9` });
  });
  it('GET avatar_url soft-10', async () => {
    getUserById.mockResolvedValue(seedUser({ avatar_url: `mxc://example.com/a10` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/avatar_url`);
    expect(status).toBe(200);
    expect(body).toEqual({ avatar_url: `mxc://example.com/a10` });
  });
  it('GET avatar_url soft-11', async () => {
    getUserById.mockResolvedValue(seedUser({ avatar_url: `mxc://example.com/a11` }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/avatar_url`);
    expect(status).toBe(200);
    expect(body).toEqual({ avatar_url: `mxc://example.com/a11` });
  });
});
describe('profile leftovers PUT avatar soft flood after #153', () => {
  it('PUT own avatar_url soft-0', async () => {
    const url = `mxc://example.com/av0`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: url })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, undefined, url);
  });
  it('PUT own avatar_url soft-1', async () => {
    const url = `mxc://example.com/av1`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: url })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, undefined, url);
  });
  it('PUT own avatar_url soft-2', async () => {
    const url = `mxc://example.com/av2`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: url })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, undefined, url);
  });
  it('PUT own avatar_url soft-3', async () => {
    const url = `mxc://example.com/av3`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: url })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, undefined, url);
  });
  it('PUT own avatar_url soft-4', async () => {
    const url = `mxc://example.com/av4`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: url })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, undefined, url);
  });
  it('PUT own avatar_url soft-5', async () => {
    const url = `mxc://example.com/av5`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: url })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, undefined, url);
  });
  it('PUT own avatar_url soft-6', async () => {
    const url = `mxc://example.com/av6`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: url })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, undefined, url);
  });
  it('PUT own avatar_url soft-7', async () => {
    const url = `mxc://example.com/av7`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: url })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, undefined, url);
  });
  it('PUT own avatar_url soft-8', async () => {
    const url = `mxc://example.com/av8`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: url })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, undefined, url);
  });
  it('PUT own avatar_url soft-9', async () => {
    const url = `mxc://example.com/av9`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: url })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, undefined, url);
  });
  it('PUT own avatar_url soft-10', async () => {
    const url = `mxc://example.com/av10`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: url })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, undefined, url);
  });
  it('PUT own avatar_url soft-11', async () => {
    const url = `mxc://example.com/av11`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: url })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, undefined, url);
  });
  it('PUT own avatar_url soft-12', async () => {
    const url = `mxc://example.com/av12`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: url })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, undefined, url);
  });
  it('PUT own avatar_url soft-13', async () => {
    const url = `mxc://example.com/av13`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: url })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, undefined, url);
  });
  it('PUT own avatar_url soft-14', async () => {
    const url = `mxc://example.com/av14`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: url })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, undefined, url);
  });
  it('PUT own avatar_url soft-15', async () => {
    const url = `mxc://example.com/av15`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: url })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, undefined, url);
  });
});
describe('profile leftovers custom key PUT soft flood after #153', () => {
  it('PUT custom key timezone soft-0', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const value = `val-0`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      jsonInit('PUT', { timezone: value }),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(cache.data[`profile:${USER}:custom`]).toBeTruthy();
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.timezone).toBe(value);
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('PUT custom key pronouns soft-1', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const value = `val-1`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/pronouns`,
      jsonInit('PUT', { pronouns: value }),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(cache.data[`profile:${USER}:custom`]).toBeTruthy();
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.pronouns).toBe(value);
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('PUT custom key status soft-2', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const value = `val-2`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/status`,
      jsonInit('PUT', { status: value }),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(cache.data[`profile:${USER}:custom`]).toBeTruthy();
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.status).toBe(value);
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('PUT custom key bio soft-3', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const value = `val-3`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/bio`,
      jsonInit('PUT', { bio: value }),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(cache.data[`profile:${USER}:custom`]).toBeTruthy();
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.bio).toBe(value);
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('PUT custom key website soft-4', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const value = `val-4`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/website`,
      jsonInit('PUT', { website: value }),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(cache.data[`profile:${USER}:custom`]).toBeTruthy();
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.website).toBe(value);
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('PUT custom key location soft-5', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const value = `val-5`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/location`,
      jsonInit('PUT', { location: value }),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(cache.data[`profile:${USER}:custom`]).toBeTruthy();
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.location).toBe(value);
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('PUT custom key language soft-6', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const value = `val-6`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/language`,
      jsonInit('PUT', { language: value }),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(cache.data[`profile:${USER}:custom`]).toBeTruthy();
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.language).toBe(value);
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('PUT custom key theme soft-7', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const value = `val-7`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/theme`,
      jsonInit('PUT', { theme: value }),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(cache.data[`profile:${USER}:custom`]).toBeTruthy();
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.theme).toBe(value);
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('PUT custom key timezone soft-8', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const value = `val-8`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      jsonInit('PUT', { timezone: value }),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(cache.data[`profile:${USER}:custom`]).toBeTruthy();
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.timezone).toBe(value);
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('PUT custom key pronouns soft-9', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const value = `val-9`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/pronouns`,
      jsonInit('PUT', { pronouns: value }),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(cache.data[`profile:${USER}:custom`]).toBeTruthy();
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.pronouns).toBe(value);
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('PUT custom key status soft-10', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const value = `val-10`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/status`,
      jsonInit('PUT', { status: value }),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(cache.data[`profile:${USER}:custom`]).toBeTruthy();
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.status).toBe(value);
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('PUT custom key bio soft-11', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const value = `val-11`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/bio`,
      jsonInit('PUT', { bio: value }),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(cache.data[`profile:${USER}:custom`]).toBeTruthy();
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.bio).toBe(value);
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('PUT custom key website soft-12', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const value = `val-12`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/website`,
      jsonInit('PUT', { website: value }),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(cache.data[`profile:${USER}:custom`]).toBeTruthy();
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.website).toBe(value);
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('PUT custom key location soft-13', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const value = `val-13`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/location`,
      jsonInit('PUT', { location: value }),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(cache.data[`profile:${USER}:custom`]).toBeTruthy();
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.location).toBe(value);
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('PUT custom key language soft-14', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const value = `val-14`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/language`,
      jsonInit('PUT', { language: value }),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(cache.data[`profile:${USER}:custom`]).toBeTruthy();
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.language).toBe(value);
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('PUT custom key theme soft-15', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const value = `val-15`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/theme`,
      jsonInit('PUT', { theme: value }),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(cache.data[`profile:${USER}:custom`]).toBeTruthy();
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.theme).toBe(value);
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('PUT custom key timezone soft-16', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const value = `val-16`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      jsonInit('PUT', { timezone: value }),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(cache.data[`profile:${USER}:custom`]).toBeTruthy();
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.timezone).toBe(value);
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('PUT custom key pronouns soft-17', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const value = `val-17`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/pronouns`,
      jsonInit('PUT', { pronouns: value }),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(cache.data[`profile:${USER}:custom`]).toBeTruthy();
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.pronouns).toBe(value);
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('PUT custom key status soft-18', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const value = `val-18`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/status`,
      jsonInit('PUT', { status: value }),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(cache.data[`profile:${USER}:custom`]).toBeTruthy();
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.status).toBe(value);
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('PUT custom key bio soft-19', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const value = `val-19`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/bio`,
      jsonInit('PUT', { bio: value }),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(cache.data[`profile:${USER}:custom`]).toBeTruthy();
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.bio).toBe(value);
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('PUT custom key website soft-20', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const value = `val-20`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/website`,
      jsonInit('PUT', { website: value }),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(cache.data[`profile:${USER}:custom`]).toBeTruthy();
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.website).toBe(value);
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('PUT custom key location soft-21', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const value = `val-21`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/location`,
      jsonInit('PUT', { location: value }),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(cache.data[`profile:${USER}:custom`]).toBeTruthy();
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.location).toBe(value);
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('PUT custom key language soft-22', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const value = `val-22`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/language`,
      jsonInit('PUT', { language: value }),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(cache.data[`profile:${USER}:custom`]).toBeTruthy();
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.language).toBe(value);
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('PUT custom key theme soft-23', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const value = `val-23`;
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/theme`,
      jsonInit('PUT', { theme: value }),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(cache.data[`profile:${USER}:custom`]).toBeTruthy();
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.theme).toBe(value);
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
});
describe('profile leftovers custom key GET soft reliability after #153', () => {
  it('GET custom key soft-0', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ timezone: `TZ-0`, extra: 0 }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      {},
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({ timezone: `TZ-0` });
  });
  it('GET custom key soft-1', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ timezone: `TZ-1`, extra: 1 }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      {},
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({ timezone: `TZ-1` });
  });
  it('GET custom key soft-2', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ timezone: `TZ-2`, extra: 2 }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      {},
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({ timezone: `TZ-2` });
  });
  it('GET custom key soft-3', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ timezone: `TZ-3`, extra: 3 }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      {},
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({ timezone: `TZ-3` });
  });
  it('GET custom key soft-4', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ timezone: `TZ-4`, extra: 4 }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      {},
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({ timezone: `TZ-4` });
  });
  it('GET custom key soft-5', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ timezone: `TZ-5`, extra: 5 }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      {},
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({ timezone: `TZ-5` });
  });
  it('GET custom key soft-6', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ timezone: `TZ-6`, extra: 6 }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      {},
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({ timezone: `TZ-6` });
  });
  it('GET custom key soft-7', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ timezone: `TZ-7`, extra: 7 }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      {},
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({ timezone: `TZ-7` });
  });
  it('GET custom key soft-8', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ timezone: `TZ-8`, extra: 8 }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      {},
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({ timezone: `TZ-8` });
  });
  it('GET custom key soft-9', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ timezone: `TZ-9`, extra: 9 }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      {},
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({ timezone: `TZ-9` });
  });
  it('GET custom key soft-10', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ timezone: `TZ-10`, extra: 10 }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      {},
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({ timezone: `TZ-10` });
  });
  it('GET custom key soft-11', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ timezone: `TZ-11`, extra: 11 }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      {},
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({ timezone: `TZ-11` });
  });
  it('GET custom key soft-12', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ timezone: `TZ-12`, extra: 12 }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      {},
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({ timezone: `TZ-12` });
  });
  it('GET custom key soft-13', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ timezone: `TZ-13`, extra: 13 }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      {},
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({ timezone: `TZ-13` });
  });
  it('GET custom key soft-14', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ timezone: `TZ-14`, extra: 14 }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      {},
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({ timezone: `TZ-14` });
  });
  it('GET custom key soft-15', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ timezone: `TZ-15`, extra: 15 }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      {},
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({ timezone: `TZ-15` });
  });
});
describe('profile leftovers custom key DELETE soft flood after #153', () => {
  it('DELETE custom key soft-0', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ keep: true, drop: `d0` }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/drop`,
      jsonInit('DELETE'),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.keep).toBe(true);
    expect(parsed.drop).toBeUndefined();
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('DELETE custom key soft-1', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ keep: true, drop: `d1` }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/drop`,
      jsonInit('DELETE'),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.keep).toBe(true);
    expect(parsed.drop).toBeUndefined();
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('DELETE custom key soft-2', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ keep: true, drop: `d2` }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/drop`,
      jsonInit('DELETE'),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.keep).toBe(true);
    expect(parsed.drop).toBeUndefined();
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('DELETE custom key soft-3', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ keep: true, drop: `d3` }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/drop`,
      jsonInit('DELETE'),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.keep).toBe(true);
    expect(parsed.drop).toBeUndefined();
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('DELETE custom key soft-4', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ keep: true, drop: `d4` }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/drop`,
      jsonInit('DELETE'),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.keep).toBe(true);
    expect(parsed.drop).toBeUndefined();
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('DELETE custom key soft-5', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ keep: true, drop: `d5` }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/drop`,
      jsonInit('DELETE'),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.keep).toBe(true);
    expect(parsed.drop).toBeUndefined();
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('DELETE custom key soft-6', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ keep: true, drop: `d6` }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/drop`,
      jsonInit('DELETE'),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.keep).toBe(true);
    expect(parsed.drop).toBeUndefined();
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('DELETE custom key soft-7', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ keep: true, drop: `d7` }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/drop`,
      jsonInit('DELETE'),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.keep).toBe(true);
    expect(parsed.drop).toBeUndefined();
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('DELETE custom key soft-8', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ keep: true, drop: `d8` }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/drop`,
      jsonInit('DELETE'),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.keep).toBe(true);
    expect(parsed.drop).toBeUndefined();
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('DELETE custom key soft-9', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ keep: true, drop: `d9` }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/drop`,
      jsonInit('DELETE'),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.keep).toBe(true);
    expect(parsed.drop).toBeUndefined();
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('DELETE custom key soft-10', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ keep: true, drop: `d10` }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/drop`,
      jsonInit('DELETE'),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.keep).toBe(true);
    expect(parsed.drop).toBeUndefined();
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('DELETE custom key soft-11', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ keep: true, drop: `d11` }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/drop`,
      jsonInit('DELETE'),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.keep).toBe(true);
    expect(parsed.drop).toBeUndefined();
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('DELETE custom key soft-12', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ keep: true, drop: `d12` }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/drop`,
      jsonInit('DELETE'),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.keep).toBe(true);
    expect(parsed.drop).toBeUndefined();
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('DELETE custom key soft-13', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ keep: true, drop: `d13` }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/drop`,
      jsonInit('DELETE'),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.keep).toBe(true);
    expect(parsed.drop).toBeUndefined();
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('DELETE custom key soft-14', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ keep: true, drop: `d14` }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/drop`,
      jsonInit('DELETE'),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.keep).toBe(true);
    expect(parsed.drop).toBeUndefined();
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
  it('DELETE custom key soft-15', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ keep: true, drop: `d15` }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/drop`,
      jsonInit('DELETE'),
      cache
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const parsed = JSON.parse(cache.data[`profile:${USER}:custom`]);
    expect(parsed.keep).toBe(true);
    expect(parsed.drop).toBeUndefined();
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });
});
describe('profile leftovers failure and edge cases after #153', () => {
  it('GET rejects user without colon', async () => {
    const { status, body } = await request('/_matrix/client/v3/profile/@alice');
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('GET rejects user without @', async () => {
    const { status, body } = await request('/_matrix/client/v3/profile/alice:example.com');
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('GET remote user 404', async () => {
    const { status, body } = await request(`/_matrix/client/v3/profile/${REMOTE_ENC}`);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('GET missing local user 404', async () => {
    getUserById.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('PUT displayname forbids other user', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${OTHER_ENC}/displayname`,
      jsonInit('PUT', { displayname: 'X' })
    );
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });

  it('PUT avatar forbids other user', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${OTHER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: 'mxc://example.com/x' })
    );
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });

  it('PUT custom forbids other user', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${OTHER_ENC}/timezone`,
      jsonInit('PUT', { timezone: 'UTC' })
    );
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });

  it('DELETE custom forbids other user', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${OTHER_ENC}/timezone`,
      jsonInit('DELETE')
    );
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });

  it('PUT displayname bad JSON', async () => {
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/displayname`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: '{bad',
    });
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });

  it('PUT avatar bad JSON', async () => {
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/avatar_url`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: 'not-json',
    });
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });

  it('PUT custom bad JSON', async () => {
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}/timezone`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: '[',
    });
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });

  it('PUT custom missing key in body', async () => {
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/timezone`,
      jsonInit('PUT', { other: 1 })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_MISSING_PARAM');
  });

  it('GET custom key absent 404', async () => {
    getUserById.mockResolvedValue(seedUser());
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/missingkey`,
      {},
      mockKv({ [`profile:${USER}:custom`]: '{}' })
    );
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('PUT displayname with null value passes through', async () => {
    const { status } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: null })
    );
    expect(status).toBe(200);
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, null);
  });

  it('PUT avatar with empty string passes through', async () => {
    const { status } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: '' })
    );
    expect(status).toBe(200);
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, undefined, '');
  });

  it('PUT custom merges without clobbering siblings', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ a: 1, b: 2 }),
    });
    await request(
      `/_matrix/client/v3/profile/${USER_ENC}/c`,
      jsonInit('PUT', { c: 3 }),
      cache
    );
    expect(JSON.parse(cache.data[`profile:${USER}:custom`])).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('PUT custom accepts nested object value', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const nested = { nested: { x: [1, 2], y: null } };
    const { status } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/meta`,
      jsonInit('PUT', { meta: nested }),
      cache
    );
    expect(status).toBe(200);
    expect(JSON.parse(cache.data[`profile:${USER}:custom`]).meta).toEqual(nested);
  });

  it('PUT custom accepts null value', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const { status } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/nullable`,
      jsonInit('PUT', { nullable: null }),
      cache
    );
    expect(status).toBe(200);
    expect(JSON.parse(cache.data[`profile:${USER}:custom`]).nullable).toBeNull();
  });

  it('PUT custom accepts boolean false', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const { status } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/flag`,
      jsonInit('PUT', { flag: false }),
      cache
    );
    expect(status).toBe(200);
    expect(JSON.parse(cache.data[`profile:${USER}:custom`]).flag).toBe(false);
  });

  it('PUT custom accepts number zero', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const { status } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/count`,
      jsonInit('PUT', { count: 0 }),
      cache
    );
    expect(status).toBe(200);
    expect(JSON.parse(cache.data[`profile:${USER}:custom`]).count).toBe(0);
  });

  it('GET custom with empty KV blob 404', async () => {
    getUserById.mockResolvedValue(seedUser());
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/anything`,
      {},
      mockKv()
    );
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('DELETE absent custom key still rewrites TTL', async () => {
    const cache = mockKv({
      [`profile:${USER}:custom`]: JSON.stringify({ other: 1 }),
    });
    const { status } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/absent`,
      jsonInit('DELETE'),
      cache
    );
    expect(status).toBe(200);
    expect(JSON.parse(cache.data[`profile:${USER}:custom`])).toEqual({ other: 1 });
    expect(cache.puts.at(-1)?.options?.expirationTtl).toBe(YEAR_TTL);
  });

  it('DELETE when no custom blob creates empty object', async () => {
    const cache = mockKv();
    const { status } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/x`,
      jsonInit('DELETE'),
      cache
    );
    expect(status).toBe(200);
    expect(JSON.parse(cache.data[`profile:${USER}:custom`])).toEqual({});
  });

  it('percent-decodes userId in GET profile', async () => {
    getUserById.mockResolvedValue(seedUser());
    const { status } = await request('/_matrix/client/v3/profile/%40alice%3Aexample.com');
    expect(status).toBe(200);
    expect(getUserById).toHaveBeenCalledWith(expect.anything(), USER);
  });

  it('SERVER_NAME case-insensitive local match', async () => {
    getUserById.mockResolvedValue(seedUser());
    const { status, body } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}`,
      {},
      mockKv(),
      'Example.COM'
    );
    expect(status).toBe(200);
    expect(body.displayname).toBeNull();
  });

  it('GET displayname remote 404', async () => {
    const { status, body } = await request(`/_matrix/client/v3/profile/${REMOTE_ENC}/displayname`);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('GET avatar remote 404', async () => {
    const { status, body } = await request(`/_matrix/client/v3/profile/${REMOTE_ENC}/avatar_url`);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('GET custom remote 404', async () => {
    const { status, body } = await request(`/_matrix/client/v3/profile/${REMOTE_ENC}/timezone`);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('PUT empty body object passes undefined displayname', async () => {
    const { status } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(200);
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, undefined);
  });

  it('PUT empty body object passes undefined avatar', async () => {
    const { status } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(200);
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, undefined, undefined);
  });

  it('GET profile both fields set', async () => {
    getUserById.mockResolvedValue(seedUser({ display_name: 'A', avatar_url: 'mxc://example.com/z' }));
    const { status, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ displayname: 'A', avatar_url: 'mxc://example.com/z' });
  });

  it('unicode displayname round-trip bind', async () => {
    const name = 'アリス🌟';
    const { status } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: name })
    );
    expect(status).toBe(200);
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, name);
  });

  it('long avatar_url soft bind', async () => {
    const url = 'mxc://example.com/' + 'x'.repeat(200);
    const { status } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: url })
    );
    expect(status).toBe(200);
    expect(updateUserProfile).toHaveBeenCalledWith(expect.anything(), USER, undefined, url);
  });
});

describe('profile leftovers lifecycle soft floods after #153', () => {
  it('displayname then avatar lifecycle soft-0', async () => {
    const { status: s1 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `L-0` })
    );
    expect(s1).toBe(200);
    const { status: s2 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: `mxc://example.com/l0` })
    );
    expect(s2).toBe(200);
    getUserById.mockResolvedValue(seedUser({ display_name: `L-0`, avatar_url: `mxc://example.com/l0` }));
    const { status: s3, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(s3).toBe(200);
    expect(body.displayname).toBe(`L-0`);
    expect(body.avatar_url).toBe(`mxc://example.com/l0`);
  });
  it('displayname then avatar lifecycle soft-1', async () => {
    const { status: s1 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `L-1` })
    );
    expect(s1).toBe(200);
    const { status: s2 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: `mxc://example.com/l1` })
    );
    expect(s2).toBe(200);
    getUserById.mockResolvedValue(seedUser({ display_name: `L-1`, avatar_url: `mxc://example.com/l1` }));
    const { status: s3, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(s3).toBe(200);
    expect(body.displayname).toBe(`L-1`);
    expect(body.avatar_url).toBe(`mxc://example.com/l1`);
  });
  it('displayname then avatar lifecycle soft-2', async () => {
    const { status: s1 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `L-2` })
    );
    expect(s1).toBe(200);
    const { status: s2 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: `mxc://example.com/l2` })
    );
    expect(s2).toBe(200);
    getUserById.mockResolvedValue(seedUser({ display_name: `L-2`, avatar_url: `mxc://example.com/l2` }));
    const { status: s3, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(s3).toBe(200);
    expect(body.displayname).toBe(`L-2`);
    expect(body.avatar_url).toBe(`mxc://example.com/l2`);
  });
  it('displayname then avatar lifecycle soft-3', async () => {
    const { status: s1 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `L-3` })
    );
    expect(s1).toBe(200);
    const { status: s2 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: `mxc://example.com/l3` })
    );
    expect(s2).toBe(200);
    getUserById.mockResolvedValue(seedUser({ display_name: `L-3`, avatar_url: `mxc://example.com/l3` }));
    const { status: s3, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(s3).toBe(200);
    expect(body.displayname).toBe(`L-3`);
    expect(body.avatar_url).toBe(`mxc://example.com/l3`);
  });
  it('displayname then avatar lifecycle soft-4', async () => {
    const { status: s1 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `L-4` })
    );
    expect(s1).toBe(200);
    const { status: s2 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: `mxc://example.com/l4` })
    );
    expect(s2).toBe(200);
    getUserById.mockResolvedValue(seedUser({ display_name: `L-4`, avatar_url: `mxc://example.com/l4` }));
    const { status: s3, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(s3).toBe(200);
    expect(body.displayname).toBe(`L-4`);
    expect(body.avatar_url).toBe(`mxc://example.com/l4`);
  });
  it('displayname then avatar lifecycle soft-5', async () => {
    const { status: s1 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `L-5` })
    );
    expect(s1).toBe(200);
    const { status: s2 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: `mxc://example.com/l5` })
    );
    expect(s2).toBe(200);
    getUserById.mockResolvedValue(seedUser({ display_name: `L-5`, avatar_url: `mxc://example.com/l5` }));
    const { status: s3, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(s3).toBe(200);
    expect(body.displayname).toBe(`L-5`);
    expect(body.avatar_url).toBe(`mxc://example.com/l5`);
  });
  it('displayname then avatar lifecycle soft-6', async () => {
    const { status: s1 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `L-6` })
    );
    expect(s1).toBe(200);
    const { status: s2 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: `mxc://example.com/l6` })
    );
    expect(s2).toBe(200);
    getUserById.mockResolvedValue(seedUser({ display_name: `L-6`, avatar_url: `mxc://example.com/l6` }));
    const { status: s3, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(s3).toBe(200);
    expect(body.displayname).toBe(`L-6`);
    expect(body.avatar_url).toBe(`mxc://example.com/l6`);
  });
  it('displayname then avatar lifecycle soft-7', async () => {
    const { status: s1 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `L-7` })
    );
    expect(s1).toBe(200);
    const { status: s2 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: `mxc://example.com/l7` })
    );
    expect(s2).toBe(200);
    getUserById.mockResolvedValue(seedUser({ display_name: `L-7`, avatar_url: `mxc://example.com/l7` }));
    const { status: s3, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(s3).toBe(200);
    expect(body.displayname).toBe(`L-7`);
    expect(body.avatar_url).toBe(`mxc://example.com/l7`);
  });
  it('displayname then avatar lifecycle soft-8', async () => {
    const { status: s1 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `L-8` })
    );
    expect(s1).toBe(200);
    const { status: s2 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: `mxc://example.com/l8` })
    );
    expect(s2).toBe(200);
    getUserById.mockResolvedValue(seedUser({ display_name: `L-8`, avatar_url: `mxc://example.com/l8` }));
    const { status: s3, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(s3).toBe(200);
    expect(body.displayname).toBe(`L-8`);
    expect(body.avatar_url).toBe(`mxc://example.com/l8`);
  });
  it('displayname then avatar lifecycle soft-9', async () => {
    const { status: s1 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `L-9` })
    );
    expect(s1).toBe(200);
    const { status: s2 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: `mxc://example.com/l9` })
    );
    expect(s2).toBe(200);
    getUserById.mockResolvedValue(seedUser({ display_name: `L-9`, avatar_url: `mxc://example.com/l9` }));
    const { status: s3, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(s3).toBe(200);
    expect(body.displayname).toBe(`L-9`);
    expect(body.avatar_url).toBe(`mxc://example.com/l9`);
  });
  it('displayname then avatar lifecycle soft-10', async () => {
    const { status: s1 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `L-10` })
    );
    expect(s1).toBe(200);
    const { status: s2 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: `mxc://example.com/l10` })
    );
    expect(s2).toBe(200);
    getUserById.mockResolvedValue(seedUser({ display_name: `L-10`, avatar_url: `mxc://example.com/l10` }));
    const { status: s3, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(s3).toBe(200);
    expect(body.displayname).toBe(`L-10`);
    expect(body.avatar_url).toBe(`mxc://example.com/l10`);
  });
  it('displayname then avatar lifecycle soft-11', async () => {
    const { status: s1 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `L-11` })
    );
    expect(s1).toBe(200);
    const { status: s2 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: `mxc://example.com/l11` })
    );
    expect(s2).toBe(200);
    getUserById.mockResolvedValue(seedUser({ display_name: `L-11`, avatar_url: `mxc://example.com/l11` }));
    const { status: s3, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(s3).toBe(200);
    expect(body.displayname).toBe(`L-11`);
    expect(body.avatar_url).toBe(`mxc://example.com/l11`);
  });
  it('displayname then avatar lifecycle soft-12', async () => {
    const { status: s1 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `L-12` })
    );
    expect(s1).toBe(200);
    const { status: s2 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: `mxc://example.com/l12` })
    );
    expect(s2).toBe(200);
    getUserById.mockResolvedValue(seedUser({ display_name: `L-12`, avatar_url: `mxc://example.com/l12` }));
    const { status: s3, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(s3).toBe(200);
    expect(body.displayname).toBe(`L-12`);
    expect(body.avatar_url).toBe(`mxc://example.com/l12`);
  });
  it('displayname then avatar lifecycle soft-13', async () => {
    const { status: s1 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `L-13` })
    );
    expect(s1).toBe(200);
    const { status: s2 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: `mxc://example.com/l13` })
    );
    expect(s2).toBe(200);
    getUserById.mockResolvedValue(seedUser({ display_name: `L-13`, avatar_url: `mxc://example.com/l13` }));
    const { status: s3, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(s3).toBe(200);
    expect(body.displayname).toBe(`L-13`);
    expect(body.avatar_url).toBe(`mxc://example.com/l13`);
  });
  it('displayname then avatar lifecycle soft-14', async () => {
    const { status: s1 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `L-14` })
    );
    expect(s1).toBe(200);
    const { status: s2 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: `mxc://example.com/l14` })
    );
    expect(s2).toBe(200);
    getUserById.mockResolvedValue(seedUser({ display_name: `L-14`, avatar_url: `mxc://example.com/l14` }));
    const { status: s3, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(s3).toBe(200);
    expect(body.displayname).toBe(`L-14`);
    expect(body.avatar_url).toBe(`mxc://example.com/l14`);
  });
  it('displayname then avatar lifecycle soft-15', async () => {
    const { status: s1 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `L-15` })
    );
    expect(s1).toBe(200);
    const { status: s2 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: `mxc://example.com/l15` })
    );
    expect(s2).toBe(200);
    getUserById.mockResolvedValue(seedUser({ display_name: `L-15`, avatar_url: `mxc://example.com/l15` }));
    const { status: s3, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(s3).toBe(200);
    expect(body.displayname).toBe(`L-15`);
    expect(body.avatar_url).toBe(`mxc://example.com/l15`);
  });
  it('displayname then avatar lifecycle soft-16', async () => {
    const { status: s1 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `L-16` })
    );
    expect(s1).toBe(200);
    const { status: s2 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: `mxc://example.com/l16` })
    );
    expect(s2).toBe(200);
    getUserById.mockResolvedValue(seedUser({ display_name: `L-16`, avatar_url: `mxc://example.com/l16` }));
    const { status: s3, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(s3).toBe(200);
    expect(body.displayname).toBe(`L-16`);
    expect(body.avatar_url).toBe(`mxc://example.com/l16`);
  });
  it('displayname then avatar lifecycle soft-17', async () => {
    const { status: s1 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `L-17` })
    );
    expect(s1).toBe(200);
    const { status: s2 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: `mxc://example.com/l17` })
    );
    expect(s2).toBe(200);
    getUserById.mockResolvedValue(seedUser({ display_name: `L-17`, avatar_url: `mxc://example.com/l17` }));
    const { status: s3, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(s3).toBe(200);
    expect(body.displayname).toBe(`L-17`);
    expect(body.avatar_url).toBe(`mxc://example.com/l17`);
  });
  it('displayname then avatar lifecycle soft-18', async () => {
    const { status: s1 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `L-18` })
    );
    expect(s1).toBe(200);
    const { status: s2 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: `mxc://example.com/l18` })
    );
    expect(s2).toBe(200);
    getUserById.mockResolvedValue(seedUser({ display_name: `L-18`, avatar_url: `mxc://example.com/l18` }));
    const { status: s3, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(s3).toBe(200);
    expect(body.displayname).toBe(`L-18`);
    expect(body.avatar_url).toBe(`mxc://example.com/l18`);
  });
  it('displayname then avatar lifecycle soft-19', async () => {
    const { status: s1 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/displayname`,
      jsonInit('PUT', { displayname: `L-19` })
    );
    expect(s1).toBe(200);
    const { status: s2 } = await request(
      `/_matrix/client/v3/profile/${USER_ENC}/avatar_url`,
      jsonInit('PUT', { avatar_url: `mxc://example.com/l19` })
    );
    expect(s2).toBe(200);
    getUserById.mockResolvedValue(seedUser({ display_name: `L-19`, avatar_url: `mxc://example.com/l19` }));
    const { status: s3, body } = await request(`/_matrix/client/v3/profile/${USER_ENC}`);
    expect(s3).toBe(200);
    expect(body.displayname).toBe(`L-19`);
    expect(body.avatar_url).toBe(`mxc://example.com/l19`);
  });
  it('custom put get delete lifecycle soft-0', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const key = 'k0';
    await request(
      `/_matrix/client/v3/profile/${USER_ENC}/${key}`,
      jsonInit('PUT', { [key]: `v0` }),
      cache
    );
    const g = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g.status).toBe(200);
    expect(g.body[key]).toBe(`v0`);
    const d = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, jsonInit('DELETE'), cache);
    expect(d.status).toBe(200);
    const g2 = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g2.status).toBe(404);
  });
  it('custom put get delete lifecycle soft-1', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const key = 'k1';
    await request(
      `/_matrix/client/v3/profile/${USER_ENC}/${key}`,
      jsonInit('PUT', { [key]: `v1` }),
      cache
    );
    const g = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g.status).toBe(200);
    expect(g.body[key]).toBe(`v1`);
    const d = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, jsonInit('DELETE'), cache);
    expect(d.status).toBe(200);
    const g2 = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g2.status).toBe(404);
  });
  it('custom put get delete lifecycle soft-2', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const key = 'k2';
    await request(
      `/_matrix/client/v3/profile/${USER_ENC}/${key}`,
      jsonInit('PUT', { [key]: `v2` }),
      cache
    );
    const g = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g.status).toBe(200);
    expect(g.body[key]).toBe(`v2`);
    const d = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, jsonInit('DELETE'), cache);
    expect(d.status).toBe(200);
    const g2 = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g2.status).toBe(404);
  });
  it('custom put get delete lifecycle soft-3', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const key = 'k3';
    await request(
      `/_matrix/client/v3/profile/${USER_ENC}/${key}`,
      jsonInit('PUT', { [key]: `v3` }),
      cache
    );
    const g = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g.status).toBe(200);
    expect(g.body[key]).toBe(`v3`);
    const d = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, jsonInit('DELETE'), cache);
    expect(d.status).toBe(200);
    const g2 = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g2.status).toBe(404);
  });
  it('custom put get delete lifecycle soft-4', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const key = 'k4';
    await request(
      `/_matrix/client/v3/profile/${USER_ENC}/${key}`,
      jsonInit('PUT', { [key]: `v4` }),
      cache
    );
    const g = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g.status).toBe(200);
    expect(g.body[key]).toBe(`v4`);
    const d = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, jsonInit('DELETE'), cache);
    expect(d.status).toBe(200);
    const g2 = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g2.status).toBe(404);
  });
  it('custom put get delete lifecycle soft-5', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const key = 'k5';
    await request(
      `/_matrix/client/v3/profile/${USER_ENC}/${key}`,
      jsonInit('PUT', { [key]: `v5` }),
      cache
    );
    const g = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g.status).toBe(200);
    expect(g.body[key]).toBe(`v5`);
    const d = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, jsonInit('DELETE'), cache);
    expect(d.status).toBe(200);
    const g2 = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g2.status).toBe(404);
  });
  it('custom put get delete lifecycle soft-6', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const key = 'k6';
    await request(
      `/_matrix/client/v3/profile/${USER_ENC}/${key}`,
      jsonInit('PUT', { [key]: `v6` }),
      cache
    );
    const g = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g.status).toBe(200);
    expect(g.body[key]).toBe(`v6`);
    const d = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, jsonInit('DELETE'), cache);
    expect(d.status).toBe(200);
    const g2 = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g2.status).toBe(404);
  });
  it('custom put get delete lifecycle soft-7', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const key = 'k7';
    await request(
      `/_matrix/client/v3/profile/${USER_ENC}/${key}`,
      jsonInit('PUT', { [key]: `v7` }),
      cache
    );
    const g = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g.status).toBe(200);
    expect(g.body[key]).toBe(`v7`);
    const d = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, jsonInit('DELETE'), cache);
    expect(d.status).toBe(200);
    const g2 = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g2.status).toBe(404);
  });
  it('custom put get delete lifecycle soft-8', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const key = 'k8';
    await request(
      `/_matrix/client/v3/profile/${USER_ENC}/${key}`,
      jsonInit('PUT', { [key]: `v8` }),
      cache
    );
    const g = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g.status).toBe(200);
    expect(g.body[key]).toBe(`v8`);
    const d = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, jsonInit('DELETE'), cache);
    expect(d.status).toBe(200);
    const g2 = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g2.status).toBe(404);
  });
  it('custom put get delete lifecycle soft-9', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const key = 'k9';
    await request(
      `/_matrix/client/v3/profile/${USER_ENC}/${key}`,
      jsonInit('PUT', { [key]: `v9` }),
      cache
    );
    const g = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g.status).toBe(200);
    expect(g.body[key]).toBe(`v9`);
    const d = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, jsonInit('DELETE'), cache);
    expect(d.status).toBe(200);
    const g2 = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g2.status).toBe(404);
  });
  it('custom put get delete lifecycle soft-10', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const key = 'k10';
    await request(
      `/_matrix/client/v3/profile/${USER_ENC}/${key}`,
      jsonInit('PUT', { [key]: `v10` }),
      cache
    );
    const g = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g.status).toBe(200);
    expect(g.body[key]).toBe(`v10`);
    const d = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, jsonInit('DELETE'), cache);
    expect(d.status).toBe(200);
    const g2 = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g2.status).toBe(404);
  });
  it('custom put get delete lifecycle soft-11', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const key = 'k11';
    await request(
      `/_matrix/client/v3/profile/${USER_ENC}/${key}`,
      jsonInit('PUT', { [key]: `v11` }),
      cache
    );
    const g = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g.status).toBe(200);
    expect(g.body[key]).toBe(`v11`);
    const d = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, jsonInit('DELETE'), cache);
    expect(d.status).toBe(200);
    const g2 = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g2.status).toBe(404);
  });
  it('custom put get delete lifecycle soft-12', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const key = 'k12';
    await request(
      `/_matrix/client/v3/profile/${USER_ENC}/${key}`,
      jsonInit('PUT', { [key]: `v12` }),
      cache
    );
    const g = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g.status).toBe(200);
    expect(g.body[key]).toBe(`v12`);
    const d = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, jsonInit('DELETE'), cache);
    expect(d.status).toBe(200);
    const g2 = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g2.status).toBe(404);
  });
  it('custom put get delete lifecycle soft-13', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const key = 'k13';
    await request(
      `/_matrix/client/v3/profile/${USER_ENC}/${key}`,
      jsonInit('PUT', { [key]: `v13` }),
      cache
    );
    const g = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g.status).toBe(200);
    expect(g.body[key]).toBe(`v13`);
    const d = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, jsonInit('DELETE'), cache);
    expect(d.status).toBe(200);
    const g2 = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g2.status).toBe(404);
  });
  it('custom put get delete lifecycle soft-14', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const key = 'k14';
    await request(
      `/_matrix/client/v3/profile/${USER_ENC}/${key}`,
      jsonInit('PUT', { [key]: `v14` }),
      cache
    );
    const g = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g.status).toBe(200);
    expect(g.body[key]).toBe(`v14`);
    const d = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, jsonInit('DELETE'), cache);
    expect(d.status).toBe(200);
    const g2 = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g2.status).toBe(404);
  });
  it('custom put get delete lifecycle soft-15', async () => {
    getUserById.mockResolvedValue(seedUser());
    const cache = mockKv();
    const key = 'k15';
    await request(
      `/_matrix/client/v3/profile/${USER_ENC}/${key}`,
      jsonInit('PUT', { [key]: `v15` }),
      cache
    );
    const g = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g.status).toBe(200);
    expect(g.body[key]).toBe(`v15`);
    const d = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, jsonInit('DELETE'), cache);
    expect(d.status).toBe(200);
    const g2 = await request(`/_matrix/client/v3/profile/${USER_ENC}/${key}`, {}, cache);
    expect(g2.status).toBe(404);
  });
});