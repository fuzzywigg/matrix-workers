/**
 * TOKENMAXX HEAVY deepen of VoIP/RTC service helpers after #78 (worker-utils).
 * Slice: cloudflare-calls / turn / livekit — not product inventing.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  CloudflareCallsError,
  isCallsConfigured,
  createSession,
  addTracks,
  renegotiate,
  closeTracks,
  getSessionState,
  pushLocalTrack,
  pullRemoteTrack,
} from '../src/services/cloudflare-calls';
import {
  TurnError,
  getMatrixTurnCredentials,
  getStunServers,
  isTurnConfigured,
  getTurnStatus,
} from '../src/services/turn';
import {
  generateLiveKitToken,
  getLiveKitConfig,
  createLiveKitRoom,
  listLiveKitRooms,
} from '../src/services/livekit';
import type { Env } from '../src/types';

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

function callsEnv(partial: Partial<Env> = {}): Env {
  return {
    CALLS_APP_ID: 'app-abc',
    CALLS_APP_SECRET: 'secret-def',
    ...partial,
  } as Env;
}

function mockKv(
  data: Record<string, string> = {},
  opts: {
    getThrows?: boolean | ((key: string) => boolean);
    putThrows?: boolean;
    deleteThrows?: boolean;
  } = {}
): KVNamespace {
  return {
    get: async (key: string, type?: string) => {
      const shouldThrow =
        typeof opts.getThrows === 'function' ? opts.getThrows(key) : opts.getThrows;
      if (shouldThrow) throw new Error('kv get failed');
      const raw = data[key];
      if (raw == null) return null;
      if (type === 'json') return JSON.parse(raw);
      return raw;
    },
    put: async (key: string, value: string, _opts?: unknown) => {
      if (opts.putThrows) throw new Error('kv put failed');
      data[key] = value;
    },
    delete: async (key: string) => {
      if (opts.deleteThrows) throw new Error('kv delete failed');
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

function iceResponse(
  servers: Array<{ urls?: string[]; username?: string; credential?: string }>
): Response {
  return new Response(JSON.stringify({ iceServers: servers }), { status: 200 });
}

function decodeJwtPart(part: string): Record<string, unknown> {
  const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4);
  const binary = atob(padded);
  // UTF-8 decode so unicode claims round-trip correctly
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

// ===========================================================================
// Cloudflare Calls
// ===========================================================================

describe('voip-rtc HEAVY: CloudflareCallsError / isCallsConfigured', () => {
  it('sets name, code, message, and default statusCode 500', () => {
    const err = new CloudflareCallsError('msg', 'API_ERROR');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CloudflareCallsError');
    expect(err.message).toBe('msg');
    expect(err.code).toBe('API_ERROR');
    expect(err.statusCode).toBe(500);
  });

  it('honors explicit statusCode including 0 and 400', () => {
    expect(new CloudflareCallsError('a', 'X', 400).statusCode).toBe(400);
    expect(new CloudflareCallsError('b', 'Y', 0).statusCode).toBe(0);
  });

  it.each([
    [{}, false],
    [{ CALLS_APP_ID: 'a' }, false],
    [{ CALLS_APP_SECRET: 's' }, false],
    [{ CALLS_APP_ID: '', CALLS_APP_SECRET: 's' }, false],
    [{ CALLS_APP_ID: 'a', CALLS_APP_SECRET: '' }, false],
    [{ CALLS_APP_ID: 'a', CALLS_APP_SECRET: 's' }, true],
  ] as const)('isCallsConfigured(%j) → %s', (partial, expected) => {
    expect(isCallsConfigured(partial as Env)).toBe(expected);
  });
});

describe('voip-rtc HEAVY: callsRequest / endpoint matrix', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['createSession', () => createSession({} as Env)],
    ['addTracks', () => addTracks({} as Env, 's', { tracks: [] })],
    ['renegotiate', () =>
      renegotiate({} as Env, 's', { sessionDescription: { type: 'answer', sdp: 'x' } })],
    ['closeTracks', () => closeTracks({} as Env, 's', ['0'])],
    ['getSessionState', () => getSessionState({} as Env, 's')],
    [
      'pushLocalTrack',
      () => pushLocalTrack({} as Env, 's', { type: 'offer', sdp: 'o' }, 't'),
    ],
    ['pullRemoteTrack', () => pullRemoteTrack({} as Env, 's', 'r', 't')],
  ] as const)('%s throws NOT_CONFIGURED before fetch', async (_name, fn) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fn()).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
      statusCode: 500,
      message: expect.stringContaining('CALLS_APP_ID'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws NOT_CONFIGURED when only APP_ID set', async () => {
    await expect(createSession({ CALLS_APP_ID: 'only' } as Env)).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
  });

  it('throws NOT_CONFIGURED when only APP_SECRET set', async () => {
    await expect(createSession({ CALLS_APP_SECRET: 'only' } as Env)).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
  });

  it('createSession POSTs /sessions/new with bearer auth and no body', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://rtc.live.cloudflare.com/v1/apps/app-abc/sessions/new');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer secret-def',
        'Content-Type': 'application/json',
      });
      expect(init?.body).toBeUndefined();
      return new Response(JSON.stringify({ sessionId: 'S1' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(createSession(callsEnv())).resolves.toEqual({ sessionId: 'S1' });
  });

  it('addTracks POSTs tracks/new with JSON body', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(
        'https://rtc.live.cloudflare.com/v1/apps/app-abc/sessions/sess-9/tracks/new'
      );
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        sessionDescription: { type: 'offer', sdp: 'v=0' },
        tracks: [{ location: 'local', trackName: 'mic' }],
      });
      return new Response(
        JSON.stringify({
          tracks: [{ mid: '0', trackName: 'mic' }],
          requiresImmediateRenegotiation: false,
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    await addTracks(callsEnv(), 'sess-9', {
      sessionDescription: { type: 'offer', sdp: 'v=0' },
      tracks: [{ location: 'local', trackName: 'mic' }],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('renegotiate PUTs renegotiate with sessionDescription', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/sessions/s2/renegotiate');
      expect(init?.method).toBe('PUT');
      expect(JSON.parse(String(init?.body))).toEqual({
        sessionDescription: { type: 'answer', sdp: 'ans' },
      });
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await renegotiate(callsEnv(), 's2', {
      sessionDescription: { type: 'answer', sdp: 'ans' },
    });
  });

  it('getSessionState GETs /sessions/:id without body', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://rtc.live.cloudflare.com/v1/apps/app-abc/sessions/s3');
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      return new Response(
        JSON.stringify({
          tracks: [{ trackName: 'a', mid: '0', status: 'active', location: 'local' }],
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(getSessionState(callsEnv(), 's3')).resolves.toEqual({
      tracks: [{ trackName: 'a', mid: '0', status: 'active', location: 'local' }],
    });
  });

  it('closeTracks maps mids and defaults force=false', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('PUT');
      expect(JSON.parse(String(init?.body))).toEqual({
        tracks: [{ mid: '0' }, { mid: '1' }],
        force: false,
      });
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await closeTracks(callsEnv(), 's', ['0', '1']);
  });

  it('closeTracks passes force=true and empty mid list', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ tracks: [], force: true });
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await closeTracks(callsEnv(), 's', [], true);
  });

  it('API_ERROR includes status and body text when present', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('quota exceeded', { status: 403 }))
    );
    await expect(createSession(callsEnv())).rejects.toMatchObject({
      code: 'API_ERROR',
      statusCode: 403,
      message: 'Calls API error: 403 - quota exceeded',
    });
  });

  it('API_ERROR omits body suffix when response body empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })));
    await expect(createSession(callsEnv())).rejects.toMatchObject({
      code: 'API_ERROR',
      statusCode: 502,
      message: 'Calls API error: 502',
    });
  });

  it('API_ERROR still thrown when response.text() fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => {
          throw new Error('body read fail');
        },
      }))
    );
    await expect(createSession(callsEnv())).rejects.toMatchObject({
      code: 'API_ERROR',
      statusCode: 500,
      message: 'Calls API error: 500',
    });
  });
});

describe('voip-rtc HEAVY: pushLocalTrack / pullRemoteTrack edges', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pushLocalTrack sends local location + trackName and returns answer/mid', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        sessionDescription: { type: 'offer', sdp: 'offer-sdp' },
        tracks: [{ location: 'local', trackName: 'camera' }],
      });
      return new Response(
        JSON.stringify({
          sessionDescription: { type: 'answer', sdp: 'answer-sdp' },
          tracks: [{ mid: '7', trackName: 'camera' }],
          requiresImmediateRenegotiation: false,
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      pushLocalTrack(callsEnv(), 'local-sess', { type: 'offer', sdp: 'offer-sdp' }, 'camera')
    ).resolves.toEqual({
      answer: { type: 'answer', sdp: 'answer-sdp' },
      trackName: 'camera',
      mid: '7',
    });
  });

  it('pushLocalTrack prefers NO_ANSWER when sessionDescription missing even with track error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              tracks: [
                {
                  mid: '0',
                  trackName: 'x',
                  errorCode: 'track_failed',
                  errorDescription: 'nope',
                },
              ],
              requiresImmediateRenegotiation: false,
            }),
            { status: 200 }
          )
      )
    );
    await expect(
      pushLocalTrack(callsEnv(), 's', { type: 'offer', sdp: 'o' }, 'cam')
    ).rejects.toMatchObject({ code: 'NO_ANSWER', statusCode: 500 });
  });

  it('pushLocalTrack uses default Track error message when errorDescription empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              sessionDescription: { type: 'answer', sdp: 'a' },
              tracks: [
                { mid: '0', trackName: 'x', errorCode: 'bad_track', errorDescription: '' },
              ],
              requiresImmediateRenegotiation: false,
            }),
            { status: 200 }
          )
      )
    );
    await expect(
      pushLocalTrack(callsEnv(), 's', { type: 'offer', sdp: 'o' }, 'cam')
    ).rejects.toMatchObject({
      code: 'bad_track',
      statusCode: 400,
      message: 'Track error',
    });
  });

  it('pushLocalTrack surfaces track errorDescription when present', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              sessionDescription: { type: 'answer', sdp: 'a' },
              tracks: [
                {
                  mid: '0',
                  trackName: 'x',
                  errorCode: 'codec',
                  errorDescription: 'unsupported codec',
                },
              ],
              requiresImmediateRenegotiation: false,
            }),
            { status: 200 }
          )
      )
    );
    await expect(
      pushLocalTrack(callsEnv(), 's', { type: 'offer', sdp: 'o' }, 'cam')
    ).rejects.toMatchObject({
      code: 'codec',
      message: 'unsupported codec',
      statusCode: 400,
    });
  });

  it('pullRemoteTrack sends remote sessionId + trackName in body', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        tracks: [
          {
            location: 'remote',
            sessionId: 'remote-sess',
            trackName: 'remote-cam',
          },
        ],
      });
      return new Response(
        JSON.stringify({
          sessionDescription: { type: 'offer', sdp: 'off' },
          tracks: [{ mid: '2', trackName: 'remote-cam' }],
          requiresImmediateRenegotiation: false,
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      pullRemoteTrack(callsEnv(), 'local-sess', 'remote-sess', 'remote-cam')
    ).resolves.toEqual({
      offer: { type: 'offer', sdp: 'off' },
      mid: '2',
      requiresRenegotiation: false,
    });
  });

  it('pullRemoteTrack propagates requiresImmediateRenegotiation true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              sessionDescription: { type: 'offer', sdp: 'o' },
              tracks: [{ mid: '1', trackName: 't' }],
              requiresImmediateRenegotiation: true,
            }),
            { status: 200 }
          )
      )
    );
    await expect(pullRemoteTrack(callsEnv(), 'a', 'b', 't')).resolves.toMatchObject({
      requiresRenegotiation: true,
    });
  });

  it('pullRemoteTrack throws NO_OFFER when sessionDescription absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ tracks: [], requiresImmediateRenegotiation: false }),
            { status: 200 }
          )
      )
    );
    await expect(pullRemoteTrack(callsEnv(), 'a', 'b', 't')).rejects.toMatchObject({
      code: 'NO_OFFER',
      statusCode: 500,
      message: expect.stringContaining('No offer'),
    });
  });

  it('pullRemoteTrack prefers NO_OFFER over track error when SDP missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              tracks: [
                {
                  mid: '0',
                  trackName: 't',
                  errorCode: 'missing',
                  errorDescription: 'gone',
                },
              ],
              requiresImmediateRenegotiation: false,
            }),
            { status: 200 }
          )
      )
    );
    await expect(pullRemoteTrack(callsEnv(), 'a', 'b', 't')).rejects.toMatchObject({
      code: 'NO_OFFER',
    });
  });

  it('pullRemoteTrack uses Track error when errorDescription empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              sessionDescription: { type: 'offer', sdp: 'o' },
              tracks: [
                { mid: '1', trackName: 't', errorCode: 'missing', errorDescription: '' },
              ],
              requiresImmediateRenegotiation: false,
            }),
            { status: 200 }
          )
      )
    );
    await expect(pullRemoteTrack(callsEnv(), 'a', 'b', 't')).rejects.toMatchObject({
      code: 'missing',
      message: 'Track error',
      statusCode: 400,
    });
  });
});

// ===========================================================================
// TURN
// ===========================================================================

describe('voip-rtc HEAVY: TURN config / STUN / TurnError', () => {
  it('getStunServers returns fixed Cloudflare STUN URI and 86400 ttl', () => {
    expect(getStunServers()).toEqual({
      username: '',
      password: '',
      uris: ['stun:stun.cloudflare.com:3478'],
      ttl: 86400,
    });
  });

  it.each([
    [{}, false],
    [{ TURN_KEY_ID: 'k' }, false],
    [{ TURN_API_TOKEN: 't' }, false],
    [{ TURN_KEY_ID: '', TURN_API_TOKEN: 't' }, false],
    [{ TURN_KEY_ID: 'k', TURN_API_TOKEN: '' }, false],
    [{ TURN_KEY_ID: 'k', TURN_API_TOKEN: 't' }, true],
  ] as const)('isTurnConfigured(%j) → %s', (partial, expected) => {
    expect(isTurnConfigured(partial as Env)).toBe(expected);
  });

  it('getTurnStatus redacts key id to first 8 chars', () => {
    expect(getTurnStatus({} as Env)).toEqual({ configured: false, keyId: undefined });
    expect(
      getTurnStatus({ TURN_KEY_ID: 'abcdefghijklmnop', TURN_API_TOKEN: 't' } as Env)
    ).toEqual({ configured: true, keyId: 'abcdefgh...' });
  });

  it('getTurnStatus still redacts short key ids (< 8 chars)', () => {
    expect(getTurnStatus({ TURN_KEY_ID: 'short', TURN_API_TOKEN: 't' } as Env)).toEqual({
      configured: true,
      keyId: 'short...',
    });
    expect(getTurnStatus({ TURN_KEY_ID: 'exactly8', TURN_API_TOKEN: 't' } as Env)).toEqual({
      configured: true,
      keyId: 'exactly8...',
    });
  });

  it('TurnError carries optional statusCode and retryAfterMs', () => {
    const bare = new TurnError('x', 'NOT_CONFIGURED');
    expect(bare.name).toBe('TurnError');
    expect(bare.statusCode).toBeUndefined();
    expect(bare.retryAfterMs).toBeUndefined();

    const full = new TurnError('y', 'USER_RATE_LIMITED', 429, 1500);
    expect(full.statusCode).toBe(429);
    expect(full.retryAfterMs).toBe(1500);
  });
});

describe('voip-rtc HEAVY: getMatrixTurnCredentials TTL / cache / API edges', () => {
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

  function stubOkIce(
    servers: Array<{ urls?: string[]; username?: string; credential?: string }> = [
      { urls: ['turn:x'], username: 'u', credential: 'p' },
    ]
  ) {
    // Fresh Response per call — Response bodies are single-consume
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      iceResponse(servers)
    );
  }

  it('throws NOT_CONFIGURED when secrets missing', async () => {
    await expect(
      getMatrixTurnCredentials({ CACHE: mockKv() } as Env)
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED', name: 'TurnError' });
  });

  it('clamps TTL exactly at MIN_TTL (300) and MAX_TTL (86400) without change', async () => {
    stubOkIce();
    const min = await getMatrixTurnCredentials(turnEnv(mockKv()), 300);
    expect(min.ttl).toBe(300);
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body).toBe(
      JSON.stringify({ ttl: 300 })
    );

    const max = await getMatrixTurnCredentials(turnEnv(mockKv()), 86400);
    expect(max.ttl).toBe(86400);
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1][1].body).toBe(
      JSON.stringify({ ttl: 86400 })
    );
  });

  it('clamps TTL just below MIN and just above MAX', async () => {
    stubOkIce();
    expect((await getMatrixTurnCredentials(turnEnv(mockKv()), 299)).ttl).toBe(300);
    expect((await getMatrixTurnCredentials(turnEnv(mockKv()), 86401)).ttl).toBe(86400);
  });

  it('uses default TTL 3600 when omitted', async () => {
    stubOkIce();
    const creds = await getMatrixTurnCredentials(turnEnv(mockKv()));
    expect(creds.ttl).toBe(3600);
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body).toBe(
      JSON.stringify({ ttl: 3600 })
    );
  });

  it('skips per-user rate limit when userId omitted', async () => {
    const kvData: Record<string, string> = {};
    stubOkIce();
    await getMatrixTurnCredentials(turnEnv(mockKv(kvData)), 3600);
    expect(Object.keys(kvData).some((k) => k.startsWith('turn_ratelimit:'))).toBe(false);
  });

  it('cache hit when expiresAt is strictly after now (expiresAt === now+1)', async () => {
    const kvData: Record<string, string> = {
      'turn_creds:turnkey12abcdefgh:3600': JSON.stringify({
        username: 'cached',
        password: 'pw',
        uris: ['turn:cached'],
        ttl: 99,
        expiresAt: NOW + 1,
      }),
    };
    const creds = await getMatrixTurnCredentials(turnEnv(mockKv(kvData)), 3600);
    expect(creds.username).toBe('cached');
    expect(creds.ttl).toBe(0); // Math.floor(1/1000)
    expect(fetch).not.toHaveBeenCalled();
  });

  it('recalculates remaining TTL via Math.floor on cache hit', async () => {
    const expiresAt = NOW + 2500;
    const kvData: Record<string, string> = {
      'turn_creds:turnkey12abcdefgh:1000': JSON.stringify({
        username: 'u',
        password: 'p',
        uris: ['turn:a'],
        ttl: 1000,
        expiresAt,
      }),
    };
    const creds = await getMatrixTurnCredentials(turnEnv(mockKv(kvData)), 1000);
    expect(creds.ttl).toBe(2); // floor(2500/1000)
  });

  it('treats cache get throw as miss and still fetches', async () => {
    stubOkIce([{ urls: ['turn:fresh'], username: 'fresh', credential: 'pw' }]);
    const kv = mockKv({}, { getThrows: true });
    await expect(getMatrixTurnCredentials(turnEnv(kv), 3600)).resolves.toMatchObject({
      username: 'fresh',
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('swallows cache put failures (non-fatal)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubOkIce();
    const kv = mockKv({}, { putThrows: true });
    await expect(getMatrixTurnCredentials(turnEnv(kv), 3600)).resolves.toMatchObject({
      username: 'u',
    });
    expect(warn).toHaveBeenCalledWith('Failed to cache TURN credentials');
    warn.mockRestore();
  });

  it('caches at 80% of TTL (expirationTtl + expiresAt)', async () => {
    const kvData: Record<string, string> = {};
    stubOkIce([{ urls: ['turn:b'], username: 'user', credential: 'pass' }]);
    await getMatrixTurnCredentials(turnEnv(mockKv(kvData)), 1000);
    const cached = JSON.parse(kvData['turn_creds:turnkey12abcdefgh:1000']) as {
      expiresAt: number;
      username: string;
    };
    expect(cached.username).toBe('user');
    expect(cached.expiresAt).toBe(NOW + 1000 * 1000 * 0.8);
  });

  it('POSTs generate-ice-servers with Bearer and Content-Type', async () => {
    stubOkIce();
    await getMatrixTurnCredentials(turnEnv(mockKv()), 500);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(
      'https://rtc.live.cloudflare.com/v1/turn/keys/turnkey12abcdefgh/credentials/generate-ice-servers'
    );
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer turn-token',
      'Content-Type': 'application/json',
    });
  });

  it('RATE_LIMITED without Retry-After says unknown seconds', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('', { status: 429 })
    );
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      statusCode: 429,
      message: expect.stringContaining('unknown'),
    });
  });

  it('RATE_LIMITED with Retry-After includes the value', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('', { status: 429, headers: { 'Retry-After': '45' } })
    );
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      message: expect.stringContaining('45'),
    });
  });

  it('API_ERROR on non-OK without body keeps status-only message', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('', { status: 503 })
    );
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'API_ERROR',
      statusCode: 503,
      message: 'TURN API returned 503',
    });
  });

  it('API_ERROR appends body text when present', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('backend down', { status: 500 })
    );
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      message: 'TURN API returned 500: backend down',
    });
  });

  it('API_ERROR when response.text() throws still reports status', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 500,
      ok: false,
      headers: { get: () => null },
      text: async () => {
        throw new Error('read fail');
      },
    });
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'API_ERROR',
      statusCode: 500,
      message: 'TURN API returned 500',
    });
  });

  it('API_ERROR when fetch throws non-Error uses Unknown error', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue('string-fail');
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'API_ERROR',
      message: expect.stringContaining('Unknown error'),
    });
  });

  it('API_ERROR when fetch throws Error uses its message', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('dns fail'));
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      message: expect.stringContaining('dns fail'),
    });
  });

  it('INVALID_RESPONSE for bad JSON', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('not-json', { status: 200 })
    );
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: expect.stringContaining('Invalid JSON'),
    });
  });

  it.each([
    [{}, 'iceServers'],
    [{ iceServers: null }, 'iceServers'],
    [{ iceServers: 'nope' }, 'iceServers'],
    [{ iceServers: [] }, 'iceServers'],
  ])('INVALID_RESPONSE for iceServers shape %#', async (body, needle) => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 })
    );
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: expect.stringContaining(needle),
    });
  });

  it('INVALID_RESPONSE when no credentialed server among iceServers', async () => {
    stubOkIce([{ urls: ['stun:only'] }, { urls: ['turn:no-creds'] }]);
    await expect(getMatrixTurnCredentials(turnEnv(mockKv()), 3600)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: expect.stringContaining('credentials'),
    });
  });

  it('picks first credentialed server when multiple present', async () => {
    stubOkIce([
      { urls: ['stun:a'] },
      { urls: ['turn:first'], username: 'u1', credential: 'p1' },
      { urls: ['turn:second'], username: 'u2', credential: 'p2' },
    ]);
    const creds = await getMatrixTurnCredentials(turnEnv(mockKv()), 3600);
    expect(creds.username).toBe('u1');
    expect(creds.password).toBe('p1');
    expect(creds.uris).toEqual(['stun:a', 'turn:first', 'turn:second']);
  });

  it('flatMaps urls treating missing urls as empty', async () => {
    stubOkIce([
      { urls: undefined as unknown as string[] },
      { urls: ['turn:ok'], username: 'u', credential: 'p' },
      {},
    ]);
    const creds = await getMatrixTurnCredentials(turnEnv(mockKv()), 3600);
    expect(creds.uris).toEqual(['turn:ok']);
  });

  it('expires cache at expiresAt === now and deletes then refetches', async () => {
    const kvData: Record<string, string> = {
      'turn_creds:turnkey12abcdefgh:3600': JSON.stringify({
        username: 'stale',
        password: 'x',
        uris: ['turn:old'],
        ttl: 10,
        expiresAt: NOW,
      }),
    };
    stubOkIce([{ urls: ['turn:new'], username: 'fresh', credential: 'pw' }]);
    const creds = await getMatrixTurnCredentials(turnEnv(mockKv(kvData)), 3600);
    expect(creds.username).toBe('fresh');
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('voip-rtc HEAVY: TURN per-user rate limit edges', () => {
  const NOW = 1_740_100_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function stubOk() {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      iceResponse([{ urls: ['turn:x'], username: 'u', credential: 'p' }])
    );
  }

  it('allows first 5 requests and writes turn_ratelimit key', async () => {
    const kvData: Record<string, string> = {};
    stubOk();
    const env = turnEnv(mockKv(kvData));
    for (let i = 0; i < 5; i++) {
      await getMatrixTurnCredentials(env, 3600, '@alice:ex.com');
    }
    const rl = JSON.parse(kvData['turn_ratelimit:@alice:ex.com']) as { requests: number[] };
    expect(rl.requests).toHaveLength(5);
  });

  it('6th request is USER_RATE_LIMITED with retryAfterMs >= 1000', async () => {
    const kvData: Record<string, string> = {};
    stubOk();
    const env = turnEnv(mockKv(kvData));
    for (let i = 0; i < 5; i++) {
      await getMatrixTurnCredentials(env, 3600, '@bob:ex.com');
    }
    await expect(getMatrixTurnCredentials(env, 3600, '@bob:ex.com')).rejects.toMatchObject({
      code: 'USER_RATE_LIMITED',
      statusCode: 429,
      retryAfterMs: expect.any(Number),
    });
    try {
      await getMatrixTurnCredentials(env, 3600, '@bob:ex.com');
    } catch (e) {
      expect((e as TurnError).retryAfterMs!).toBeGreaterThanOrEqual(1000);
    }
  });

  it('floors retryAfterMs to at least 1000 when window almost elapsed', async () => {
    const kvData: Record<string, string> = {
      'turn_ratelimit:@carol:ex.com': JSON.stringify({
        // five requests all almost 60s ago → retryAfter would be tiny
        requests: [NOW - 59_500, NOW - 59_400, NOW - 59_300, NOW - 59_200, NOW - 59_100],
      }),
    };
    stubOk();
    await expect(
      getMatrixTurnCredentials(turnEnv(mockKv(kvData)), 3600, '@carol:ex.com')
    ).rejects.toMatchObject({
      code: 'USER_RATE_LIMITED',
      retryAfterMs: 1000,
    });
  });

  it('prunes stale timestamps outside the 60s window', async () => {
    const kvData: Record<string, string> = {
      'turn_ratelimit:@dave:ex.com': JSON.stringify({
        requests: [NOW - 120_000, NOW - 90_000, NOW - 10_000],
      }),
    };
    stubOk();
    await expect(
      getMatrixTurnCredentials(turnEnv(mockKv(kvData)), 3600, '@dave:ex.com')
    ).resolves.toMatchObject({ username: 'u' });
    const rl = JSON.parse(kvData['turn_ratelimit:@dave:ex.com']) as { requests: number[] };
    // only the in-window one + the new request
    expect(rl.requests.every((t) => t > NOW - 60_000)).toBe(true);
    expect(rl.requests).toHaveLength(2);
  });

  it('rate limits are per-user (alice full does not block eve)', async () => {
    const kvData: Record<string, string> = {};
    stubOk();
    const env = turnEnv(mockKv(kvData));
    for (let i = 0; i < 5; i++) {
      await getMatrixTurnCredentials(env, 3600, '@alice:ex.com');
    }
    await expect(
      getMatrixTurnCredentials(env, 3600, '@eve:ex.com')
    ).resolves.toMatchObject({ username: 'u' });
  });

  it('fails open when rate-limit KV get throws', async () => {
    stubOk();
    const kv = mockKv({}, { getThrows: (key) => key.startsWith('turn_ratelimit:') });
    await expect(
      getMatrixTurnCredentials(turnEnv(kv), 3600, '@open:ex.com')
    ).resolves.toMatchObject({ username: 'u' });
  });

  it('allows again after window advances past oldest request', async () => {
    const kvData: Record<string, string> = {};
    stubOk();
    const env = turnEnv(mockKv(kvData));
    for (let i = 0; i < 5; i++) {
      await getMatrixTurnCredentials(env, 3600, '@frank:ex.com');
    }
    vi.setSystemTime(NOW + 61_000);
    await expect(
      getMatrixTurnCredentials(env, 3600, '@frank:ex.com')
    ).resolves.toMatchObject({ username: 'u' });
  });
});

// ===========================================================================
// LiveKit
// ===========================================================================

describe('voip-rtc HEAVY: getLiveKitConfig matrix', () => {
  it.each([
    [{}, null],
    [{ LIVEKIT_API_KEY: 'k' }, null],
    [{ LIVEKIT_API_SECRET: 's' }, null],
    [{ LIVEKIT_URL: 'wss://x' }, null],
    [{ LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' }, null],
    [{ LIVEKIT_API_KEY: 'k', LIVEKIT_URL: 'wss://x' }, null],
    [{ LIVEKIT_API_SECRET: 's', LIVEKIT_URL: 'wss://x' }, null],
    [{ LIVEKIT_API_KEY: '', LIVEKIT_API_SECRET: 's', LIVEKIT_URL: 'wss://x' }, null],
    [
      { LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's', LIVEKIT_URL: 'wss://lk.example' },
      { apiKey: 'k', apiSecret: 's', wsUrl: 'wss://lk.example' },
    ],
  ] as const)('config %j → %j', (partial, expected) => {
    expect(getLiveKitConfig(partial as Env)).toEqual(expected);
  });
});

describe('voip-rtc HEAVY: generateLiveKitToken claims / encoding', () => {
  const NOW_MS = 1_750_000_000_000;
  const NOW_SEC = Math.floor(NOW_MS / 1000);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits HS256 JWT with pinned nbf/exp and full video grants', async () => {
    const token = await generateLiveKitToken(
      'APIKEY',
      'secret',
      'room-z',
      '@user:ex.com',
      'Display',
      90
    );
    const [h, c, sig] = token.split('.');
    expect(token.split('.')).toHaveLength(3);
    expect(sig.length).toBeGreaterThan(10);
    expect(decodeJwtPart(h)).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(decodeJwtPart(c)).toEqual({
      iss: 'APIKEY',
      sub: '@user:ex.com',
      nbf: NOW_SEC,
      exp: NOW_SEC + 90,
      video: {
        roomJoin: true,
        room: 'room-z',
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      },
      name: 'Display',
    });
  });

  it('defaults name to identity and TTL to 3600', async () => {
    const token = await generateLiveKitToken('k', 's', 'r', 'id-only');
    const claims = decodeJwtPart(token.split('.')[1]) as {
      name: string;
      nbf: number;
      exp: number;
    };
    expect(claims.name).toBe('id-only');
    expect(claims.exp - claims.nbf).toBe(3600);
  });

  it('treats empty string name as falsy → falls back to identity', async () => {
    const token = await generateLiveKitToken('k', 's', 'r', 'id', '', 10);
    expect((decodeJwtPart(token.split('.')[1]) as { name: string }).name).toBe('id');
  });

  it('allows zero and negative TTL (exp relative to nbf)', async () => {
    const zero = await generateLiveKitToken('k', 's', 'r', 'id', 'n', 0);
    const zc = decodeJwtPart(zero.split('.')[1]) as { nbf: number; exp: number };
    expect(zc.exp).toBe(zc.nbf);

    const neg = await generateLiveKitToken('k', 's', 'r', 'id', 'n', -5);
    const nc = decodeJwtPart(neg.split('.')[1]) as { nbf: number; exp: number };
    expect(nc.exp).toBe(nc.nbf - 5);
  });

  it('encodes unicode room/identity/name without padding in JWT parts', async () => {
    const token = await generateLiveKitToken(
      'k',
      's',
      '部屋-🏠',
      '@ユーザー:例え.com',
      '名前',
      60
    );
    const parts = token.split('.');
    for (const part of parts) {
      expect(part).not.toMatch(/=/);
      expect(part).not.toMatch(/[+\/]/);
    }
    const claims = decodeJwtPart(parts[1]) as {
      sub: string;
      name: string;
      video: { room: string };
    };
    expect(claims.sub).toBe('@ユーザー:例え.com');
    expect(claims.name).toBe('名前');
    expect(claims.video.room).toBe('部屋-🏠');
  });

  it('produces different signatures for different secrets and same for same inputs', async () => {
    const a = await generateLiveKitToken('k', 'secret-a', 'r', 'id', 'n', 60);
    const b = await generateLiveKitToken('k', 'secret-b', 'r', 'id', 'n', 60);
    const c = await generateLiveKitToken('k', 'secret-a', 'r', 'id', 'n', 60);
    expect(a.split('.')[2]).not.toBe(b.split('.')[2]);
    expect(a).toBe(c);
  });

  it('changes signature when room or identity changes', async () => {
    const base = await generateLiveKitToken('k', 's', 'room-a', 'id-a', 'n', 60);
    const room = await generateLiveKitToken('k', 's', 'room-b', 'id-a', 'n', 60);
    const id = await generateLiveKitToken('k', 's', 'room-a', 'id-b', 'n', 60);
    expect(base.split('.')[2]).not.toBe(room.split('.')[2]);
    expect(base.split('.')[2]).not.toBe(id.split('.')[2]);
  });

  it('empty room and identity still produce a valid three-part token', async () => {
    const token = await generateLiveKitToken('k', 's', '', '', undefined, 1);
    const claims = decodeJwtPart(token.split('.')[1]) as {
      sub: string;
      name: string;
      video: { room: string };
    };
    expect(claims.sub).toBe('');
    expect(claims.name).toBe('');
    expect(claims.video.room).toBe('');
  });
});

describe('voip-rtc HEAVY: LiveKit Twirp room API', () => {
  it('createLiveKitRoom POSTs CreateRoom with Content-Type and name body', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://localhost:7880/twirp/livekit.RoomService/CreateRoom');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
      expect(JSON.parse(String(init?.body))).toEqual({ name: 'room-a' });
      return new Response(JSON.stringify({ room: { name: 'room-a', sid: 'RM_1' } }), {
        status: 200,
      });
    });
    const env = { LIVEKIT_API: { fetch: fetchFn } } as unknown as Env;
    await expect(createLiveKitRoom(env, 'room-a')).resolves.toEqual({
      room: { name: 'room-a', sid: 'RM_1' },
    });
  });

  it('createLiveKitRoom returns null on non-OK (reads body for log)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = {
      LIVEKIT_API: {
        fetch: async () => new Response('nope', { status: 500 }),
      },
    } as unknown as Env;
    expect(await createLiveKitRoom(env, 'r')).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('createLiveKitRoom returns null when fetch throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = {
      LIVEKIT_API: {
        fetch: async () => {
          throw new Error('network');
        },
      },
    } as unknown as Env;
    expect(await createLiveKitRoom(env, 'r')).toBeNull();
    errorSpy.mockRestore();
  });

  it('listLiveKitRooms POSTs ListRooms with empty JSON body', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://localhost:7880/twirp/livekit.RoomService/ListRooms');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
      expect(JSON.parse(String(init?.body))).toEqual({});
      return new Response(JSON.stringify({ rooms: [{ name: 'a' }, { name: 'b' }] }), {
        status: 200,
      });
    });
    await expect(
      listLiveKitRooms({ LIVEKIT_API: { fetch: fetchFn } } as unknown as Env)
    ).resolves.toEqual({ rooms: [{ name: 'a' }, { name: 'b' }] });
  });

  it('listLiveKitRooms returns null on non-OK and on throw', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await listLiveKitRooms({
        LIVEKIT_API: { fetch: async () => new Response('x', { status: 404 }) },
      } as unknown as Env)
    ).toBeNull();
    expect(
      await listLiveKitRooms({
        LIVEKIT_API: {
          fetch: async () => {
            throw new Error('boom');
          },
        },
      } as unknown as Env)
    ).toBeNull();
    errorSpy.mockRestore();
  });

  it('createLiveKitRoom accepts alternate success JSON shapes', async () => {
    const env = {
      LIVEKIT_API: {
        fetch: async () =>
          new Response(JSON.stringify({ room: { name: 'x', sid: 'RM_X', empty_timeout: 0 } }), {
            status: 200,
          }),
      },
    } as unknown as Env;
    await expect(createLiveKitRoom(env, 'x')).resolves.toMatchObject({
      room: { name: 'x', sid: 'RM_X' },
    });
  });
});
