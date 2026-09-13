import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  generateLiveKitToken,
  createLiveKitRoom,
  listLiveKitRooms,
  getLiveKitConfig,
} from '../src/services/livekit';
import type { Env } from '../src/types';

function decodePart(part: string): Record<string, unknown> {
  const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4);
  return JSON.parse(atob(padded));
}

describe('generateLiveKitToken', () => {
  it('returns a three-part HS256 JWT with expected claims', async () => {
    const token = await generateLiveKitToken(
      'APIkey',
      'super-secret',
      'room-1',
      '@alice:example.com',
      'Alice',
      120
    );
    const [headerB64, claimsB64, sig] = token.split('.');
    expect(sig.length).toBeGreaterThan(10);

    const header = decodePart(headerB64);
    const claims = decodePart(claimsB64) as {
      iss: string;
      sub: string;
      nbf: number;
      exp: number;
      name: string;
      video: { room: string; roomJoin: boolean };
    };

    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(claims.iss).toBe('APIkey');
    expect(claims.sub).toBe('@alice:example.com');
    expect(claims.name).toBe('Alice');
    expect(claims.video.room).toBe('room-1');
    expect(claims.video.roomJoin).toBe(true);
    expect(claims.exp - claims.nbf).toBe(120);
  });

  it('defaults participant name to identity', async () => {
    const token = await generateLiveKitToken('k', 's', 'r', 'id-only');
    const claims = decodePart(token.split('.')[1]) as { name: string };
    expect(claims.name).toBe('id-only');
  });

  it('defaults TTL to 3600 seconds when omitted', async () => {
    const token = await generateLiveKitToken('k', 's', 'room', 'id', 'Name');
    const claims = decodePart(token.split('.')[1]) as { nbf: number; exp: number };
    expect(claims.exp - claims.nbf).toBe(3600);
  });
});


describe('livekit TOKENMAXX edge paths after #49', () => {
  it('falls back empty participant names to identity and allows zero TTL', async () => {
    const token = await generateLiveKitToken('k', 's', 'room', 'id-only', '', 0);
    const claims = decodePart(token.split('.')[1]) as {
      name: string;
      nbf: number;
      exp: number;
    };
    expect(claims.name).toBe('id-only');
    expect(claims.exp).toBe(claims.nbf);
  });
});

describe('livekit TOKENMAXX edge paths after #50', () => {
  it('includes canPublish / canSubscribe / canPublishData grants', async () => {
    const token = await generateLiveKitToken('k', 's', 'room', 'id', 'Name', 60);
    const claims = decodePart(token.split('.')[1]) as {
      video: { canPublish: boolean; canSubscribe: boolean; canPublishData: boolean };
    };
    expect(claims.video.canPublish).toBe(true);
    expect(claims.video.canSubscribe).toBe(true);
    expect(claims.video.canPublishData).toBe(true);
  });

  it('produces different signatures for different secrets', async () => {
    const a = await generateLiveKitToken('k', 'secret-a', 'room', 'id', 'Name', 60);
    const b = await generateLiveKitToken('k', 'secret-b', 'room', 'id', 'Name', 60);
    expect(a.split('.')[2]).not.toBe(b.split('.')[2]);
  });

  it('allows negative TTL producing exp before nbf', async () => {
    const token = await generateLiveKitToken('k', 's', 'room', 'id', 'Name', -10);
    const claims = decodePart(token.split('.')[1]) as { nbf: number; exp: number };
    expect(claims.exp).toBe(claims.nbf - 10);
  });
});


describe('createLiveKitRoom / listLiveKitRooms / getLiveKitConfig', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function envWithApi(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): Env {
    return {
      LIVEKIT_API: { fetch: fetchImpl },
      LIVEKIT_API_KEY: 'k',
      LIVEKIT_API_SECRET: 's',
      LIVEKIT_URL: 'wss://livekit.example.com',
    } as unknown as Env;
  }

  it('getLiveKitConfig requires key, secret, and url', () => {
    expect(getLiveKitConfig({} as Env)).toBeNull();
    expect(
      getLiveKitConfig({ LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' } as unknown as Env)
    ).toBeNull();
    expect(
      getLiveKitConfig({
        LIVEKIT_API_KEY: 'k',
        LIVEKIT_API_SECRET: 's',
        LIVEKIT_URL: 'wss://x',
      } as unknown as Env)
    ).toEqual({ apiKey: 'k', apiSecret: 's', wsUrl: 'wss://x' });
  });

  it('createLiveKitRoom returns JSON on ok and null on !ok or throw', async () => {
    const ok = await createLiveKitRoom(
      envWithApi(async () => new Response(JSON.stringify({ room: { name: 'r', sid: 's1' } }), { status: 200 })),
      'r'
    );
    expect(ok).toEqual({ room: { name: 'r', sid: 's1' } });

    const bad = await createLiveKitRoom(
      envWithApi(async () => new Response('nope', { status: 500 })),
      'r'
    );
    expect(bad).toBeNull();

    const boom = await createLiveKitRoom(
      envWithApi(async () => {
        throw new Error('vpc down');
      }),
      'r'
    );
    expect(boom).toBeNull();
  });

  it('listLiveKitRooms returns rooms on ok and null on !ok or throw', async () => {
    const ok = await listLiveKitRooms(
      envWithApi(async () => new Response(JSON.stringify({ rooms: [{ name: 'a' }] }), { status: 200 }))
    );
    expect(ok).toEqual({ rooms: [{ name: 'a' }] });

    expect(
      await listLiveKitRooms(envWithApi(async () => new Response('x', { status: 404 })))
    ).toBeNull();
    expect(
      await listLiveKitRooms(
        envWithApi(async () => {
          throw new Error('fail');
        })
      )
    ).toBeNull();
  });
});
