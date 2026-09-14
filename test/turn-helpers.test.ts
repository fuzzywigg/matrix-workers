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


describe('TURN helpers TOKENMAXX after #77/#78 (clock-pinned edges)', () => {
  const NOW = 1_730_000_000_000;

  function iceOk(extra: Record<string, unknown> = {}) {
    return {
      iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478'] },
        {
          urls: ['turn:turn.example.com:3478?transport=udp'],
          username: 'u',
          credential: 'p',
          ...extra,
        },
      ],
    };
  }

  function putCapturingKv(data: Record<string, string> = {}) {
    const puts: Array<{ key: string; value: string; options?: { expirationTtl?: number } }> = [];
    const kv = {
      get: async (key: string, type?: string) => {
        const raw = data[key];
        if (raw == null) return null;
        if (type === 'json') return JSON.parse(raw);
        return raw;
      },
      put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
        puts.push({ key, value, options });
        data[key] = value;
      },
      delete: async (key: string) => {
        delete data[key];
      },
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
      getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
    } as unknown as KVNamespace;
    return { kv, data, puts };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('treats empty-string TURN secrets as NOT_CONFIGURED', async () => {
    await expect(
      getMatrixTurnCredentials(
        turnEnv(mockKv(), { TURN_KEY_ID: '', TURN_API_TOKEN: 't' })
      )
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await expect(
      getMatrixTurnCredentials(
        turnEnv(mockKv(), { TURN_KEY_ID: 'k', TURN_API_TOKEN: '' })
      )
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(isTurnConfigured(turnEnv(mockKv(), { TURN_KEY_ID: '', TURN_API_TOKEN: 't' }))).toBe(
      false
    );
  });

  it('defaults TTL to 3600 when omitted and clamps boundary matrix', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify(iceOk()), { status: 200 })
    );

    const def = await getMatrixTurnCredentials(turnEnv(mockKv()));
    expect(def.ttl).toBe(3600);
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ ttl: 3600 }));

    const cases: Array<[number, number]> = [
      [299, 300],
      [300, 300],
      [301, 301],
      [86399, 86399],
      [86400, 86400],
      [86401, 86400],
    ];
    for (const [input, expected] of cases) {
      fetchMock.mockClear();
      const creds = await getMatrixTurnCredentials(turnEnv(mockKv()), input);
      expect(creds.ttl).toBe(expected);
      expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ ttl: expected }));
    }
  });

  it('uses clamped TTL in cache key and stores expirationTtl at 80%', async () => {
    const { kv, data, puts } = putCapturingKv();
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response(JSON.stringify(iceOk()), { status: 200 }));

    await getMatrixTurnCredentials(turnEnv(kv), 50); // clamps to 300
    expect(data['turn_creds:turnkey12abcdefgh:300']).toBeDefined();
    expect(puts.some((p) => p.key === 'turn_creds:turnkey12abcdefgh:300')).toBe(true);
    const credPut = puts.find((p) => p.key === 'turn_creds:turnkey12abcdefgh:300')!;
    expect(credPut.options?.expirationTtl).toBe(Math.floor(300 * 0.8));

    const cached = JSON.parse(credPut.value) as { expiresAt: number };
    expect(cached.expiresAt).toBe(NOW + 300 * 1000 * 0.8);
  });

  it('sends Content-Type application/json and POST body with ttl', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response(JSON.stringify(iceOk()), { status: 200 }));
    await getMatrixTurnCredentials(turnEnv(mockKv()), 1200);
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(fetchMock.mock.calls[0][1].headers['Content-Type']).toBe('application/json');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer turn-token');
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ ttl: 1200 }));
  });

  it('treats cache get throw as miss and still fetches', async () => {
    const kv = {
      ...mockKv(),
      get: async () => {
        throw new Error('cache read boom');
      },
      put: async () => undefined,
    } as unknown as KVNamespace;
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response(JSON.stringify(iceOk()), { status: 200 }));
    await expect(getMatrixTurnCredentials(turnEnv(kv), 3600)).resolves.toMatchObject({
      username: 'u',
      password: 'p',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('warns and still returns when cache put throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const kv = {
      get: async () => null,
      put: async () => {
        throw new Error('cache write boom');
      },
      delete: async () => undefined,
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
      getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
    } as unknown as KVNamespace;
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(iceOk()), { status: 200 })
    );
    await expect(getMatrixTurnCredentials(turnEnv(kv), 3600)).resolves.toMatchObject({
      username: 'u',
    });
    expect(warn).toHaveBeenCalledWith('Failed to cache TURN credentials');
  });

  it('maps non-Error fetch rejection to Unknown error', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue('socket-reset');
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'API_ERROR',
      message: expect.stringContaining('Unknown error'),
    });
  });

  it('uses unknown seconds when 429 lacks Retry-After', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('', { status: 429 })
    );
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      statusCode: 429,
      message: expect.stringContaining('unknown'),
    });
  });

  it('omits body suffix on non-OK empty body and swallows text() throw', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('', { status: 502 })
    );
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'API_ERROR',
      statusCode: 502,
      message: 'TURN API returned 502',
    });

    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Unavailable',
      headers: new Headers(),
      text: async () => {
        throw new Error('body unreadable');
      },
      json: async () => {
        throw new Error('no json');
      },
    } as unknown as Response);
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'API_ERROR',
      statusCode: 503,
      message: 'TURN API returned 503',
    });
  });

  it.each([
    [{}, 'iceServers'],
    [{ iceServers: null }, 'iceServers'],
    [{ iceServers: {} }, 'iceServers'],
    [{ iceServers: 'x' }, 'iceServers'],
  ])('rejects invalid iceServers shape %#', async (body, needle) => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 })
    );
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: expect.stringContaining(needle),
    });
  });

  it('rejects username-only or credential-only ICE entries', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          iceServers: [{ urls: ['turn:a'], username: 'only-user' }],
        }),
        { status: 200 }
      )
    );
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: expect.stringContaining('credentials'),
    });

    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          iceServers: [{ urls: ['turn:a'], credential: 'only-cred' }],
        }),
        { status: 200 }
      )
    );
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: expect.stringContaining('credentials'),
    });
  });

  it('picks first credentialed server and flattens missing urls to []', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          iceServers: [
            { urls: ['stun:a'] },
            { username: 'first', credential: 'one' }, // no urls
            {
              urls: ['turn:b'],
              username: 'second',
              credential: 'two',
            },
          ],
        }),
        { status: 200 }
      )
    );
    const creds = await getMatrixTurnCredentials(turnEnv(mockKv()), 3600);
    expect(creds.username).toBe('first');
    expect(creds.password).toBe('one');
    expect(creds.uris).toEqual(['stun:a', 'turn:b']);
  });

  it('shrinks remaining cached ttl as the clock advances', async () => {
    const kvData: Record<string, string> = {
      'turn_creds:turnkey12abcdefgh:3600': JSON.stringify({
        username: 'cached',
        password: 'pw',
        uris: ['turn:cached'],
        ttl: 3600,
        expiresAt: NOW + 800_000,
      }),
    };
    const first = await getMatrixTurnCredentials(turnEnv(mockKv(kvData)), 3600);
    expect(first.ttl).toBe(800);
    expect(fetch).not.toHaveBeenCalled();

    vi.setSystemTime(NOW + 250_000);
    const second = await getMatrixTurnCredentials(turnEnv(mockKv(kvData)), 3600);
    expect(second.ttl).toBe(Math.floor((NOW + 800_000 - (NOW + 250_000)) / 1000));
    expect(second.ttl).toBe(550);
  });

  it('deletes cache entries that expired strictly before now', async () => {
    const kvData: Record<string, string> = {
      'turn_creds:turnkey12abcdefgh:3600': JSON.stringify({
        username: 'old',
        password: 'x',
        uris: ['turn:old'],
        ttl: 10,
        expiresAt: NOW - 1,
      }),
    };
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(iceOk()), { status: 200 })
    );
    const creds = await getMatrixTurnCredentials(turnEnv(mockKv(kvData)), 3600);
    expect(creds.username).toBe('u');
    expect(kvData['turn_creds:turnkey12abcdefgh:3600']).toBeDefined(); // rewritten by put
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('floors USER_RATE_LIMITED retryAfterMs at 1000 near window end', async () => {
    const { kv, data, puts } = putCapturingKv();
    const env = turnEnv(kv);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(iceOk()), { status: 200 })
    );

    for (let i = 0; i < 5; i++) {
      await getMatrixTurnCredentials(env, 3600, '@near:ex.com');
    }
    const rlPut = puts.find((p) => p.key === 'turn_ratelimit:@near:ex.com');
    expect(rlPut?.options?.expirationTtl).toBe(70);

    // Window started at NOW; advance to 100ms before expiry → raw retry is 100ms → floor 1000
    vi.setSystemTime(NOW + 59_900);
    await expect(getMatrixTurnCredentials(env, 3600, '@near:ex.com')).rejects.toMatchObject({
      code: 'USER_RATE_LIMITED',
      statusCode: 429,
      retryAfterMs: 1000,
    });
    expect(data['turn_ratelimit:@near:ex.com']).toBeDefined();
  });

  it('isolates per-user rate limits and treats malformed KV as empty', async () => {
    const { kv, data } = putCapturingKv();
    const env = turnEnv(kv);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(iceOk()), { status: 200 })
    );

    for (let i = 0; i < 5; i++) {
      await getMatrixTurnCredentials(env, 3600, '@alice:ex.com');
    }
    await expect(getMatrixTurnCredentials(env, 3600, '@alice:ex.com')).rejects.toMatchObject({
      code: 'USER_RATE_LIMITED',
    });
    // Bob still allowed
    await expect(getMatrixTurnCredentials(env, 3600, '@bob:ex.com')).resolves.toMatchObject({
      username: 'u',
    });

    // Malformed / missing requests → treated as []
    data['turn_ratelimit:@mallory:ex.com'] = JSON.stringify({ requests: 'nope' });
    await expect(
      getMatrixTurnCredentials(env, 3600, '@mallory:ex.com')
    ).resolves.toMatchObject({ username: 'u' });

    data['turn_ratelimit:@ned:ex.com'] = JSON.stringify({});
    await expect(getMatrixTurnCredentials(env, 3600, '@ned:ex.com')).resolves.toMatchObject({
      username: 'u',
    });
  });

  it('fails open when rate-limit KV put throws', async () => {
    let rateGets = 0;
    const kv = {
      get: async (key: string, type?: string) => {
        if (String(key).startsWith('turn_ratelimit:')) {
          rateGets += 1;
          return type === 'json' ? { requests: [] } : JSON.stringify({ requests: [] });
        }
        return null; // credential cache miss
      },
      put: async (key: string) => {
        if (String(key).startsWith('turn_ratelimit:')) {
          throw new Error('put fail');
        }
        // allow credential cache puts
      },
      delete: async () => undefined,
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
      getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
    } as unknown as KVNamespace;
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => new Response(JSON.stringify(iceOk()), { status: 200 })
    );
    await expect(
      getMatrixTurnCredentials(turnEnv(kv), 3600, '@putfail:ex.com')
    ).resolves.toMatchObject({ username: 'u' });
    expect(rateGets).toBeGreaterThan(0);
  });

  it('redacts short and long key ids in getTurnStatus', () => {
    expect(getTurnStatus({ TURN_KEY_ID: 'abcd', TURN_API_TOKEN: 't' } as Env)).toEqual({
      configured: true,
      keyId: 'abcd...',
    });
    expect(
      getTurnStatus({ TURN_KEY_ID: 'abcdefghijklmnop', TURN_API_TOKEN: 't' } as Env)
    ).toEqual({ configured: true, keyId: 'abcdefgh...' });
  });
});

// ---------------------------------------------------------------------------
// TOKENMAXX HEAVY after #87 — TURN exact messages / TTL quirks / rate-limit put TTL
// ---------------------------------------------------------------------------

describe('TURN helpers TOKENMAXX HEAVY after #87 (exact messages + TTL quirks)', () => {
  const NOW = 1_730_000_000_000;

  function iceOk() {
    return {
      iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478'] },
        {
          urls: ['turn:turn.example.com:3478?transport=udp'],
          username: 'u',
          credential: 'p',
        },
      ],
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('pins exact NOT_CONFIGURED message', async () => {
    await expect(getMatrixTurnCredentials({ CACHE: mockKv() } as Env)).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
      message: 'TURN server not configured. Set TURN_KEY_ID and TURN_API_TOKEN.',
    });
  });

  it('pins exact USER_RATE_LIMITED message including retryAfterMs', async () => {
    const kv = mockKv();
    const env = turnEnv(kv);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(iceOk()), { status: 200 })
    );
    for (let i = 0; i < 5; i++) {
      await getMatrixTurnCredentials(env, 3600, '@exact:ex.com');
    }
    try {
      await getMatrixTurnCredentials(env, 3600, '@exact:ex.com');
      expect.unreachable('expected USER_RATE_LIMITED');
    } catch (err) {
      expect(err).toBeInstanceOf(TurnError);
      const te = err as TurnError;
      expect(te.code).toBe('USER_RATE_LIMITED');
      expect(te.statusCode).toBe(429);
      expect(te.retryAfterMs).toBeGreaterThanOrEqual(1000);
      expect(te.message).toBe(`Rate limited. Try again in ${te.retryAfterMs}ms.`);
    }
  });

  it('pins exact connect-failure messages for Error and non-Error rejects', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('dns fail'));
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'API_ERROR',
      message: 'Failed to connect to TURN API: dns fail',
    });

    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue('boom');
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'API_ERROR',
      message: 'Failed to connect to TURN API: Unknown error',
    });
  });

  it('includes Got: JSON.stringify(data) in INVALID_RESPONSE for missing iceServers', async () => {
    const payload = { iceServers: null };
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200 })
    );
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: `TURN API response missing iceServers array. Got: ${JSON.stringify(payload)}`,
    });
  });

  it('includes Got: payload when no credentialed TURN server present', async () => {
    const payload = { iceServers: [{ urls: ['stun:only'] }] };
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200 })
    );
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: `TURN API response has no server with credentials. Got: ${JSON.stringify(payload)}`,
    });
  });

  it('documents TTL NaN / -1 / Infinity clamp quirks', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify(iceOk()), { status: 200 })
    );

    await getMatrixTurnCredentials(turnEnv(mockKv()), -1);
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ ttl: 300 }));

    fetchMock.mockClear();
    await getMatrixTurnCredentials(turnEnv(mockKv()), Number.POSITIVE_INFINITY);
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ ttl: 86400 }));

    fetchMock.mockClear();
    await getMatrixTurnCredentials(turnEnv(mockKv()), Number.NaN);
    // Math.max/min with NaN propagates NaN → JSON null
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ ttl: null }));
  });

  it('writes rate-limit KV with expirationTtl 70 and skips ratelimit when userId omitted', async () => {
    const puts: Array<{ key: string; options?: { expirationTtl?: number } }> = [];
    const data: Record<string, string> = {};
    const kv = {
      get: async (key: string, type?: string) => {
        const raw = data[key];
        if (raw == null) return null;
        if (type === 'json') return JSON.parse(raw);
        return raw;
      },
      put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
        puts.push({ key, options });
        data[key] = value;
      },
      delete: async (key: string) => {
        delete data[key];
      },
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
      getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
    } as unknown as KVNamespace;

    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(iceOk()), { status: 200 })
    );

    await getMatrixTurnCredentials(turnEnv(kv), 3600, '@ttl70:ex.com');
    const rlPut = puts.find((p) => p.key === 'turn_ratelimit:@ttl70:ex.com');
    expect(rlPut?.options?.expirationTtl).toBe(70);

    puts.length = 0;
    await getMatrixTurnCredentials(turnEnv(kv), 3600); // no userId
    expect(puts.every((p) => !String(p.key).startsWith('turn_ratelimit:'))).toBe(true);
  });

  it('treats cache delete throw on expiry as miss and refetches', async () => {
    const kv = {
      get: async () => ({
        username: 'stale',
        password: 'x',
        uris: ['turn:old'],
        ttl: 10,
        expiresAt: NOW, // expired at exact now
      }),
      put: async () => undefined,
      delete: async () => {
        throw new Error('delete fail');
      },
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
      getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
    } as unknown as KVNamespace;
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(iceOk()), { status: 200 })
    );
    await expect(getMatrixTurnCredentials(turnEnv(kv), 3600)).resolves.toMatchObject({
      username: 'u',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
