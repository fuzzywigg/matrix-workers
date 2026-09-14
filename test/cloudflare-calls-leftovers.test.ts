/**
 * TOKENMAXX HEAVY leftovers after #226 — src/services/cloudflare-calls.ts edges not
 * covered by test/cloudflare-calls.test.ts (config, API_ERROR body, push/pull track errors).
 *
 * Distinct from voip-rtc-calls concurrent-race (#200) which races Matrix call routes,
 * not the SFU HTTP helper. Tests-only. No live Cloudflare Calls network. No product inventing.
 */
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

const OK_TRACKS = {
  sessionDescription: { type: 'answer' as const, sdp: 'v=0' },
  tracks: [{ mid: '0', trackName: 't1' }],
  requiresImmediateRenegotiation: false,
};

describe('Cloudflare Calls leftovers after #226', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('CloudflareCallsError is an Error with custom statusCode pin', () => {
    const err = new CloudflareCallsError('nope', 'CUSTOM', 418);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CloudflareCallsError);
    expect(err.statusCode).toBe(418);
    expect(err.code).toBe('CUSTOM');
    expect(err.message).toBe('nope');
    expect(err.name).toBe('CloudflareCallsError');
  });

  it('whitespace-only secrets are truthy so isCallsConfigured returns true', () => {
    expect(
      isCallsConfigured({ CALLS_APP_ID: ' ', CALLS_APP_SECRET: ' ' } as Env)
    ).toBe(true);
  });

  it('interpolates CALLS_APP_ID into the request URL (not a hardcoded app id)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sessionId: 's' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await createSession(callsEnv({ CALLS_APP_ID: 'other-app' }));
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://rtc.live.cloudflare.com/v1/apps/other-app/sessions/new'
    );
  });

  it('GET still sends Content-Type: application/json with no body', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ tracks: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await getSessionState(callsEnv(), 'sess-hdr');
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer secret-xyz',
      'Content-Type': 'application/json',
    });
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });

  it('treats HTTP 201 as ok (response.ok) and returns JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ sessionId: 'created' }), { status: 201 }))
    );
    await expect(createSession(callsEnv())).resolves.toEqual({ sessionId: 'created' });
  });

  it('surfaces SyntaxError from response.json() on 200 non-JSON (not wrapped)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', { status: 200 })));
    await expect(createSession(callsEnv())).rejects.toBeInstanceOf(SyntaxError);
  });

  it('surfaces json() throw on empty 204 body (not CloudflareCallsError)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await expect(getSessionState(callsEnv(), 's1')).rejects.toSatisfy((err: unknown) => {
      return err instanceof Error && !(err instanceof CloudflareCallsError);
    });
  });

  it('pins addTracks request body including remote sessionId', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(OK_TRACKS), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await addTracks(callsEnv(), 'local-s', {
      sessionDescription: { type: 'offer', sdp: 'offer-sdp' },
      tracks: [{ location: 'remote', sessionId: 'remote-s', trackName: 'cam' }],
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://rtc.live.cloudflare.com/v1/apps/app-123/sessions/local-s/tracks/new'
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      sessionDescription: { type: 'offer', sdp: 'offer-sdp' },
      tracks: [{ location: 'remote', sessionId: 'remote-s', trackName: 'cam' }],
    });
  });

  it('pins renegotiate PUT body', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await renegotiate(callsEnv(), 's1', {
      sessionDescription: { type: 'answer', sdp: 'ans' },
    });
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      sessionDescription: { type: 'answer', sdp: 'ans' },
    });
  });

  it('closeTracks with empty mids sends tracks:[] and default force false', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await closeTracks(callsEnv(), 's1', []);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      tracks: [],
      force: false,
    });
  });

  it('does not URL-encode sessionId path segments (slash stays in URL)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ tracks: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await getSessionState(callsEnv(), 'sess/with/slash');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://rtc.live.cloudflare.com/v1/apps/app-123/sessions/sess/with/slash'
    );
  });

  it('pushLocalTrack ignores errorCode on tracks[1] (only tracks[0] is inspected)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            sessionDescription: { type: 'answer', sdp: 'ans' },
            tracks: [
              { mid: '0', trackName: 'cam' },
              { mid: '1', trackName: 'mic', errorCode: 'ignored', errorDescription: 'nope' },
            ],
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
      mid: '0',
    });
  });

  it('pullRemoteTrack ignores errorCode on tracks[1]', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            sessionDescription: { type: 'offer', sdp: 'off' },
            tracks: [
              { mid: '7', trackName: 'remote-cam' },
              { mid: '8', trackName: 'x', errorCode: 'ignored' },
            ],
            requiresImmediateRenegotiation: true,
          }),
          { status: 200 }
        )
      )
    );
    await expect(
      pullRemoteTrack(callsEnv(), 'local', 'remote', 'remote-cam')
    ).resolves.toEqual({
      offer: { type: 'offer', sdp: 'off' },
      mid: '7',
      requiresRenegotiation: true,
    });
  });

  it('TypeError when tracks is omitted (tracks[0] on undefined)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            sessionDescription: { type: 'answer', sdp: 'ans' },
            requiresImmediateRenegotiation: false,
          }),
          { status: 200 }
        )
      )
    );
    await expect(
      pushLocalTrack(callsEnv(), 's1', { type: 'offer', sdp: 'off' }, 'cam')
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('API_ERROR on 404 with JSON error body suffix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"missing"}', { status: 404 }))
    );
    await expect(getSessionState(callsEnv(), 'nope')).rejects.toMatchObject({
      code: 'API_ERROR',
      statusCode: 404,
      message: 'Calls API error: 404 - {"error":"missing"}',
    });
  });

  it('does not fetch when only APP_ID is set (NOT_CONFIGURED before fetch)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(createSession({ CALLS_APP_ID: 'a' } as Env)).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fetch when only APP_SECRET is set', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(createSession({ CALLS_APP_SECRET: 's' } as Env)).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('isolates concurrent getSessionState URLs under Promise.all', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ tracks: [] }), { status: 200 });
      })
    );
    await Promise.all([
      getSessionState(callsEnv(), 'sess-a'),
      getSessionState(callsEnv(), 'sess-b'),
      getSessionState(callsEnv(), 'sess-c'),
    ]);
    expect(urls.sort()).toEqual([
      'https://rtc.live.cloudflare.com/v1/apps/app-123/sessions/sess-a',
      'https://rtc.live.cloudflare.com/v1/apps/app-123/sessions/sess-b',
      'https://rtc.live.cloudflare.com/v1/apps/app-123/sessions/sess-c',
    ]);
  });

  it('isolates concurrent API_ERROR vs success (reject does not poison sibling)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('sess-fail')) {
          return new Response('nope', { status: 500 });
        }
        return new Response(JSON.stringify({ tracks: [] }), { status: 200 });
      })
    );
    const results = await Promise.allSettled([
      getSessionState(callsEnv(), 'sess-ok'),
      getSessionState(callsEnv(), 'sess-fail'),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    if (results[1].status === 'rejected') {
      expect(results[1].reason).toMatchObject({ code: 'API_ERROR', statusCode: 500 });
    }
  });

  it('pushLocalTrack pins tracks payload location=local + trackName', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(OK_TRACKS), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await pushLocalTrack(callsEnv(), 's1', { type: 'offer', sdp: 'off' }, 'mic-name');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      sessionDescription: { type: 'offer', sdp: 'off' },
      tracks: [{ location: 'local', trackName: 'mic-name' }],
    });
  });

  it('pullRemoteTrack pins tracks payload location=remote + sessionId + trackName', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            sessionDescription: { type: 'offer', sdp: 'off' },
            tracks: [{ mid: '1', trackName: 'cam' }],
            requiresImmediateRenegotiation: false,
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal('fetch', fetchMock);
    await pullRemoteTrack(callsEnv(), 'local-s', 'remote-s', 'cam');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      tracks: [{ location: 'remote', sessionId: 'remote-s', trackName: 'cam' }],
    });
  });

  it('Bearer token is the CALLS_APP_SECRET value (fixture secret, not a live cred)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sessionId: 'x' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await createSession(callsEnv({ CALLS_APP_SECRET: 'fixture-secret' }));
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer fixture-secret');
  });

  it('Promise.all addTracks∥closeTracks∥renegotiate hit distinct paths', async () => {
    const methods: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        methods.push(`${init?.method} ${url}`);
        return new Response(JSON.stringify(OK_TRACKS), { status: 200 });
      })
    );
    await Promise.all([
      addTracks(callsEnv(), 's1', { tracks: [{ location: 'local', trackName: 'a' }] }),
      closeTracks(callsEnv(), 's1', ['0'], true),
      renegotiate(callsEnv(), 's1', { sessionDescription: { type: 'answer', sdp: 'x' } }),
    ]);
    expect(methods.sort()).toEqual([
      'POST https://rtc.live.cloudflare.com/v1/apps/app-123/sessions/s1/tracks/new',
      'PUT https://rtc.live.cloudflare.com/v1/apps/app-123/sessions/s1/renegotiate',
      'PUT https://rtc.live.cloudflare.com/v1/apps/app-123/sessions/s1/tracks/close',
    ]);
  });
});
