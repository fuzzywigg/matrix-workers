import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addTracks,
  closeTracks,
  CloudflareCallsError,
  createSession,
  getSessionState,
  isCallsConfigured,
  pullRemoteTrack,
  pushLocalTrack,
  renegotiate,
} from '../src/services/cloudflare-calls';
import type { Env } from '../src/types';

function callsEnv(partial: Partial<Env> = {}): Env {
  return {
    CALLS_APP_ID: 'app-123',
    CALLS_APP_SECRET: 'secret-xyz',
    ...partial,
  } as Env;
}

describe('Cloudflare Calls config / errors', () => {
  it('requires both app id and secret', () => {
    expect(isCallsConfigured({} as Env)).toBe(false);
    expect(isCallsConfigured({ CALLS_APP_ID: 'a' } as Env)).toBe(false);
    expect(isCallsConfigured({ CALLS_APP_SECRET: 's' } as Env)).toBe(false);
    expect(isCallsConfigured(callsEnv())).toBe(true);
  });

  it('defaults CloudflareCallsError statusCode to 500', () => {
    const err = new CloudflareCallsError('boom', 'API_ERROR');
    expect(err.name).toBe('CloudflareCallsError');
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe('API_ERROR');
  });
});

describe('Cloudflare Calls API helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws NOT_CONFIGURED before fetch when secrets missing', async () => {
    await expect(createSession({} as Env)).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
      statusCode: 500,
    });
  });

  it('createSession POSTs /sessions/new with bearer auth', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://rtc.live.cloudflare.com/v1/apps/app-123/sessions/new');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer secret-xyz',
        'Content-Type': 'application/json',
      });
      expect(init?.body).toBeUndefined();
      return new Response(JSON.stringify({ sessionId: 'sess-1' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(createSession(callsEnv())).resolves.toEqual({ sessionId: 'sess-1' });
  });

  it('addTracks / renegotiate / getSessionState / closeTracks hit expected paths', async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url: String(url),
          method: init?.method,
          body: init?.body as string | undefined,
        });
        return new Response(
          JSON.stringify({
            sessionDescription: { type: 'answer', sdp: 'v=0' },
            tracks: [{ mid: '0', trackName: 't1' }],
            requiresImmediateRenegotiation: false,
            tracks_state: [],
          }),
          { status: 200 }
        );
      })
    );

    await addTracks(callsEnv(), 's1', {
      tracks: [{ location: 'local', trackName: 'mic' }],
    });
    await renegotiate(callsEnv(), 's1', {
      sessionDescription: { type: 'answer', sdp: 'v=0' },
    });
    await getSessionState(callsEnv(), 's1');
    await closeTracks(callsEnv(), 's1', ['0', '1'], true);

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://rtc.live.cloudflare.com/v1/apps/app-123/sessions/s1/tracks/new',
      'PUT https://rtc.live.cloudflare.com/v1/apps/app-123/sessions/s1/renegotiate',
      'GET https://rtc.live.cloudflare.com/v1/apps/app-123/sessions/s1',
      'PUT https://rtc.live.cloudflare.com/v1/apps/app-123/sessions/s1/tracks/close',
    ]);
    expect(JSON.parse(calls[3].body!)).toEqual({
      tracks: [{ mid: '0' }, { mid: '1' }],
      force: true,
    });
  });

  it('throws API_ERROR with status and body on non-OK', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('quota', { status: 403 }))
    );
    await expect(createSession(callsEnv())).rejects.toMatchObject({
      code: 'API_ERROR',
      statusCode: 403,
      message: expect.stringContaining('quota'),
    });
  });

  it('pushLocalTrack returns answer/mid and surfaces track errors / missing answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            sessionDescription: { type: 'answer', sdp: 'ans' },
            tracks: [{ mid: '3', trackName: 'cam' }],
            requiresImmediateRenegotiation: false,
          }),
          { status: 200 }
        )
      )
    );
    await expect(
      pushLocalTrack(callsEnv(), 's1', { type: 'offer', sdp: 'off' }, 'cam')
    ).resolves.toEqual({
      answer: { type: 'answer', sdp: 'ans' },
      trackName: 'cam',
      mid: '3',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            tracks: [{ mid: '0', trackName: 'x', errorCode: 'track_failed', errorDescription: 'nope' }],
            requiresImmediateRenegotiation: false,
          }),
          { status: 200 }
        )
      )
    );
    await expect(
      pushLocalTrack(callsEnv(), 's1', { type: 'offer', sdp: 'off' }, 'cam')
    ).rejects.toMatchObject({ code: 'NO_ANSWER', statusCode: 500 });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            sessionDescription: { type: 'answer', sdp: 'ans' },
            tracks: [{ mid: '0', trackName: 'x', errorCode: 'track_failed', errorDescription: 'nope' }],
            requiresImmediateRenegotiation: false,
          }),
          { status: 200 }
        )
      )
    );
    await expect(
      pushLocalTrack(callsEnv(), 's1', { type: 'offer', sdp: 'off' }, 'cam')
    ).rejects.toMatchObject({ code: 'track_failed', statusCode: 400, message: 'nope' });
  });

  it('pullRemoteTrack returns offer/mid/requiresRenegotiation and error paths', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            sessionDescription: { type: 'offer', sdp: 'off' },
            tracks: [{ mid: '1', trackName: 'remote-cam' }],
            requiresImmediateRenegotiation: true,
          }),
          { status: 200 }
        )
      )
    );
    await expect(
      pullRemoteTrack(callsEnv(), 'local-sess', 'remote-sess', 'remote-cam')
    ).resolves.toEqual({
      offer: { type: 'offer', sdp: 'off' },
      mid: '1',
      requiresRenegotiation: true,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            tracks: [],
            requiresImmediateRenegotiation: false,
          }),
          { status: 200 }
        )
      )
    );
    await expect(
      pullRemoteTrack(callsEnv(), 'local-sess', 'remote-sess', 'remote-cam')
    ).rejects.toMatchObject({ code: 'NO_OFFER' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            sessionDescription: { type: 'offer', sdp: 'off' },
            tracks: [{ mid: '1', trackName: 'x', errorCode: 'missing', errorDescription: '' }],
            requiresImmediateRenegotiation: false,
          }),
          { status: 200 }
        )
      )
    );
    await expect(
      pullRemoteTrack(callsEnv(), 'local-sess', 'remote-sess', 'remote-cam')
    ).rejects.toMatchObject({ code: 'missing', message: 'Track error', statusCode: 400 });
  });

  it('closeTracks defaults force to false', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await closeTracks(callsEnv(), 's1', ['9']);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      tracks: [{ mid: '9' }],
      force: false,
    });
  });
});
