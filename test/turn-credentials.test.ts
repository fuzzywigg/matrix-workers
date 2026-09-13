import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  getMatrixTurnCredentials,
  TurnError,
  getStunServers,
} from '../src/services/turn';
import type { Env } from '../src/types';

function mockKv(store: Record<string, string> = {}): KVNamespace {
  return {
    get: async (key: string, type?: string) => {
      const v = store[key];
      if (v === undefined) return null;
      if (type === 'json') return JSON.parse(v);
      return v;
    },
    put: async (key: string, value: string) => {
      store[key] = value;
    },
    delete: async (key: string) => {
      delete store[key];
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

function envWith(cache: KVNamespace, extras: Partial<Env> = {}): Env {
  return {
    TURN_KEY_ID: 'turn-key-abc',
    TURN_API_TOKEN: 'turn-token',
    CACHE: cache,
    ...extras,
  } as unknown as Env;
}

const iceOk = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    {
      urls: ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349'],
      username: 'u1',
      credential: 'p1',
    },
  ],
};

describe('getMatrixTurnCredentials', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('throws NOT_CONFIGURED when key/token missing', async () => {
    const cache = mockKv();
    await expect(
      getMatrixTurnCredentials({ CACHE: cache } as unknown as Env)
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED', name: 'TurnError' });
  });

  it('clamps TTL to [300, 86400] in the API request body', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify(iceOk), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    const cache = mockKv();
    const e = envWith(cache);

    await getMatrixTurnCredentials(e, 0);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      ttl: 300,
    });

    fetchMock.mockClear();
    await getMatrixTurnCredentials(e, 999999);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      ttl: 86400,
    });

    fetchMock.mockClear();
    await getMatrixTurnCredentials(e, 3600);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      ttl: 3600,
    });
  });

  it('maps iceServers into Matrix TURN shape and flattens URLs', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(iceOk), { status: 200 })
    );
    const result = await getMatrixTurnCredentials(envWith(mockKv()), 3600);
    expect(result).toEqual({
      username: 'u1',
      password: 'p1',
      uris: [
        'stun:stun.cloudflare.com:3478',
        'turn:turn.example.com:3478?transport=udp',
        'turns:turn.example.com:5349',
      ],
      ttl: 3600,
    });
  });

  it('throws INVALID_RESPONSE for empty iceServers or missing credentials', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ iceServers: [] }), { status: 200 })
    );
    await expect(getMatrixTurnCredentials(envWith(mockKv()))).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ iceServers: [{ urls: ['stun:x'] }] }),
        { status: 200 }
      )
    );
    await expect(getMatrixTurnCredentials(envWith(mockKv()))).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('maps HTTP 429 to RATE_LIMITED and network errors to API_ERROR', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('slow down', { status: 429, headers: { 'Retry-After': '10' } })
    );
    await expect(getMatrixTurnCredentials(envWith(mockKv()))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      statusCode: 429,
    });

    vi.mocked(fetch).mockRejectedValueOnce(new Error('dns fail'));
    await expect(getMatrixTurnCredentials(envWith(mockKv()))).rejects.toMatchObject({
      code: 'API_ERROR',
    });
  });

  it('serves cache hits without refetch and deletes expired entries', async () => {
    const store: Record<string, string> = {};
    const cache = mockKv(store);
    const e = envWith(cache);
    const key = 'turn_creds:turn-key-abc:3600';

    store[key] = JSON.stringify({
      username: 'cached-u',
      password: 'cached-p',
      uris: ['turn:c'],
      ttl: 3600,
      expiresAt: Date.now() + 60_000,
    });

    const fetchMock = vi.mocked(fetch);
    const hit = await getMatrixTurnCredentials(e, 3600);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hit.username).toBe('cached-u');
    expect(hit.ttl).toBeGreaterThan(0);
    expect(hit.ttl).toBeLessThanOrEqual(60);

    store[key] = JSON.stringify({
      username: 'old',
      password: 'old',
      uris: ['turn:old'],
      ttl: 3600,
      expiresAt: Date.now() - 1,
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify(iceOk), { status: 200 }));
    const refreshed = await getMatrixTurnCredentials(e, 3600);
    expect(fetchMock).toHaveBeenCalled();
    expect(refreshed.username).toBe('u1');
  });

  it('enforces per-user rate limit of 5 requests/minute', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(iceOk), { status: 200 })
    );
    const cache = mockKv();
    const e = envWith(cache);
    const userId = '@alice:example.com';

    for (let i = 0; i < 5; i++) {
      await getMatrixTurnCredentials(e, 3600, userId);
    }

    try {
      await getMatrixTurnCredentials(e, 3600, userId);
      expect.fail('expected USER_RATE_LIMITED');
    } catch (err) {
      expect(err).toBeInstanceOf(TurnError);
      const te = err as TurnError;
      expect(te.code).toBe('USER_RATE_LIMITED');
      expect(te.retryAfterMs).toBeGreaterThanOrEqual(1000);
    }
  });

  it('fails open when rate-limit KV get throws', async () => {
    const cache = mockKv();
    cache.get = async () => {
      throw new Error('kv down');
    };
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(iceOk), { status: 200 })
    );
    const result = await getMatrixTurnCredentials(envWith(cache), 3600, '@alice:example.com');
    expect(result.username).toBe('u1');
  });

  it('still returns credentials when cache put throws', async () => {
    const cache = mockKv();
    cache.put = async () => {
      throw new Error('put fail');
    };
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(iceOk), { status: 200 })
    );
    const result = await getMatrixTurnCredentials(envWith(cache), 3600);
    expect(result.password).toBe('p1');
  });
});

describe('getStunServers', () => {
  it('returns Cloudflare STUN without credentials', () => {
    expect(getStunServers()).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3478'],
      ttl: 86400,
    });
  });
});
