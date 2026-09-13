import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getMatrixTurnCredentials,
  getStunServers,
  getTurnStatus,
  isTurnConfigured,
  TurnError,
} from '../src/services/turn';
import type { Env } from '../src/types';

function mockKv(data: Record<string, string> = {}): KVNamespace {
  return {
    get: async (key: string, type?: string) => {
      const raw = data[key];
      if (raw == null) return null;
      if (type === 'json') return JSON.parse(raw);
      return raw;
    },
    put: async (key: string, value: string) => {
      data[key] = value;
    },
    delete: async (key: string) => {
      delete data[key];
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

function turnEnv(kv: KVNamespace, partial: Partial<Env> = {}): Env {
  return {
    TURN_KEY_ID: 'turnkey12abcdefgh',
    TURN_API_TOKEN: 'turn-token',
    CACHE: kv,
    ...partial,
  } as Env;
}

describe('TURN config helpers', () => {
  it('exposes Cloudflare STUN servers without credentials', () => {
    const stun = getStunServers();
    expect(stun).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3478'],
      ttl: 86400,
    });
  });

  it('requires both key id and token', () => {
    expect(isTurnConfigured({} as Env)).toBe(false);
    expect(isTurnConfigured({ TURN_KEY_ID: 'k' } as Env)).toBe(false);
    expect(isTurnConfigured({ TURN_API_TOKEN: 't' } as Env)).toBe(false);
    expect(isTurnConfigured({ TURN_KEY_ID: 'k', TURN_API_TOKEN: 't' } as Env)).toBe(true);
  });

  it('redacts key id in status', () => {
    expect(getTurnStatus({} as Env)).toEqual({ configured: false, keyId: undefined });
    expect(
      getTurnStatus({ TURN_KEY_ID: 'abcdefghijklmnop', TURN_API_TOKEN: 't' } as Env)
    ).toEqual({ configured: true, keyId: 'abcdefgh...' });
  });
});

describe('getMatrixTurnCredentials (clock-pinned)', () => {
  const NOW = 1_730_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('throws NOT_CONFIGURED when TURN secrets missing', async () => {
    await expect(
      getMatrixTurnCredentials({ CACHE: mockKv() } as Env)
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED', name: 'TurnError' });
  });

  it('clamps TTL below MIN_TTL (300) and above MAX_TTL (86400)', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const iceBody = {
      iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478'] },
        {
          urls: ['turn:turn.example.com:3478?transport=udp'],
          username: 'u',
          credential: 'p',
        },
      ],
    };
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify(iceBody), { status: 200 })
    );

    const low = await getMatrixTurnCredentials(turnEnv(mockKv()), 1);
    expect(low.ttl).toBe(300);
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ ttl: 300 }));

    const high = await getMatrixTurnCredentials(turnEnv(mockKv()), 999_999);
    expect(high.ttl).toBe(86400);
    expect(fetchMock.mock.calls[1][1].body).toBe(JSON.stringify({ ttl: 86400 }));
  });

  it('fetches ICE servers, maps Matrix format, and caches at 80% TTL', async () => {
    const kvData: Record<string, string> = {};
    const kv = mockKv(kvData);
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          iceServers: [
            { urls: ['stun:a'] },
            {
              urls: ['turn:b', 'turns:c'],
              username: 'user',
              credential: 'pass',
            },
          ],
        }),
        { status: 200 }
      )
    );

    const creds = await getMatrixTurnCredentials(turnEnv(kv), 1000);
    expect(creds).toEqual({
      username: 'user',
      password: 'pass',
      uris: ['stun:a', 'turn:b', 'turns:c'],
      ttl: 1000,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://rtc.live.cloudflare.com/v1/turn/keys/turnkey12abcdefgh/credentials/generate-ice-servers'
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer turn-token');

    const cacheKey = 'turn_creds:turnkey12abcdefgh:1000';
    const cached = JSON.parse(kvData[cacheKey]) as { expiresAt: number; username: string };
    expect(cached.username).toBe('user');
    expect(cached.expiresAt).toBe(NOW + 1000 * 1000 * 0.8);

    // Second call hits cache — remaining ttl recalculated from pinned clock
    const again = await getMatrixTurnCredentials(turnEnv(kv), 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(again.username).toBe('user');
    expect(again.ttl).toBe(Math.floor((cached.expiresAt - NOW) / 1000));
  });

  it('treats cache entry at exact expiresAt as expired and deletes it', async () => {
    const kvData: Record<string, string> = {
      'turn_creds:turnkey12abcdefgh:3600': JSON.stringify({
        username: 'stale',
        password: 'x',
        uris: ['turn:old'],
        ttl: 10,
        expiresAt: NOW,
      }),
    };
    const kv = mockKv(kvData);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          iceServers: [
            { urls: ['turn:new'], username: 'fresh', credential: 'pw' },
          ],
        }),
        { status: 200 }
      )
    );

    const creds = await getMatrixTurnCredentials(turnEnv(kv), 3600);
    expect(creds.username).toBe('fresh');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('throws RATE_LIMITED on 429 with Retry-After', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('', { status: 429, headers: { 'Retry-After': '30' } })
    );
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      statusCode: 429,
      message: expect.stringContaining('30'),
    });
  });

  it('throws API_ERROR on non-OK with body text', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('nope', { status: 500 })
    );
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'API_ERROR',
      statusCode: 500,
      message: expect.stringContaining('500'),
    });
  });

  it('throws API_ERROR when fetch itself fails', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('dns fail'));
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'API_ERROR',
      message: expect.stringContaining('dns fail'),
    });
  });

  it('throws INVALID_RESPONSE for bad JSON', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('not-json', { status: 200 })
    );
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('throws INVALID_RESPONSE when iceServers missing or empty', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ iceServers: [] }), { status: 200 })
    );
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: expect.stringContaining('iceServers'),
    });
  });

  it('throws INVALID_RESPONSE when no credentialed TURN server present', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({ iceServers: [{ urls: ['stun:only'] }] }),
        { status: 200 }
      )
    );
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: expect.stringContaining('credentials'),
    });
  });

  it('enforces per-user rate limit of 5 requests / 60s window', async () => {
    const kv = mockKv();
    const env = turnEnv(kv);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          iceServers: [{ urls: ['turn:x'], username: 'u', credential: 'p' }],
        }),
        { status: 200 }
      )
    );

    for (let i = 0; i < 5; i++) {
      await getMatrixTurnCredentials(env, 3600, '@alice:ex.com');
    }

    await expect(getMatrixTurnCredentials(env, 3600, '@alice:ex.com')).rejects.toMatchObject({
      code: 'USER_RATE_LIMITED',
      statusCode: 429,
      retryAfterMs: expect.any(Number),
    });
  });

  it('allows requests again after the rate-limit window advances', async () => {
    const kv = mockKv();
    const env = turnEnv(kv);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          iceServers: [{ urls: ['turn:x'], username: 'u', credential: 'p' }],
        }),
        { status: 200 }
      )
    );

    for (let i = 0; i < 5; i++) {
      await getMatrixTurnCredentials(env, 3600, '@bob:ex.com');
    }

    vi.setSystemTime(NOW + 61_000);
    await expect(getMatrixTurnCredentials(env, 3600, '@bob:ex.com')).resolves.toMatchObject({
      username: 'u',
    });
  });

  it('fails open when rate-limit KV get throws', async () => {
    const kv = {
      ...mockKv(),
      get: async () => {
        throw new Error('kv down');
      },
      put: async () => undefined,
    } as unknown as KVNamespace;
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          iceServers: [{ urls: ['turn:x'], username: 'u', credential: 'p' }],
        }),
        { status: 200 }
      )
    );
    await expect(
      getMatrixTurnCredentials(turnEnv(kv), 3600, '@carol:ex.com')
    ).resolves.toMatchObject({ username: 'u' });
  });

  it('constructs TurnError with optional fields', () => {
    const err = new TurnError('x', 'API_ERROR', 502, 1500);
    expect(err.name).toBe('TurnError');
    expect(err.code).toBe('API_ERROR');
    expect(err.statusCode).toBe(502);
    expect(err.retryAfterMs).toBe(1500);
  });
});
