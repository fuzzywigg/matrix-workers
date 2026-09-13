import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveKitRoom,
  generateLiveKitToken,
  getLiveKitConfig,
  listLiveKitRooms,
} from '../src/services/livekit';
import type { Env } from '../src/types';

function decodePart(part: string): Record<string, unknown> {
  const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4);
  return JSON.parse(atob(padded));
}

describe('generateLiveKitToken', () => {
  const NOW_MS = 1_740_000_000_000;
  const NOW_SEC = Math.floor(NOW_MS / 1000);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
    expect(claims.nbf).toBe(NOW_SEC);
    expect(claims.exp).toBe(NOW_SEC + 120);
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

describe('livekit room API + config after #59', () => {
  it('getLiveKitConfig returns null unless all three fields are set', () => {
    expect(getLiveKitConfig({} as Env)).toBeNull();
    expect(
      getLiveKitConfig({
        LIVEKIT_API_KEY: 'k',
        LIVEKIT_API_SECRET: 's',
        LIVEKIT_URL: 'wss://lk',
      } as Env)
    ).toEqual({ apiKey: 'k', apiSecret: 's', wsUrl: 'wss://lk' });
  });

  it('createLiveKitRoom posts Twirp CreateRoom and returns JSON', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/twirp/livekit.RoomService/CreateRoom');
      expect(init?.method).toBe('POST');
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

  it('createLiveKitRoom returns null on non-OK and on throw', async () => {
    const envFail = {
      LIVEKIT_API: {
        fetch: async () => new Response('nope', { status: 500 }),
      },
    } as unknown as Env;
    expect(await createLiveKitRoom(envFail, 'r')).toBeNull();

    const envThrow = {
      LIVEKIT_API: {
        fetch: async () => {
          throw new Error('network');
        },
      },
    } as unknown as Env;
    expect(await createLiveKitRoom(envThrow, 'r')).toBeNull();
  });

  it('listLiveKitRooms posts Twirp ListRooms and returns JSON', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/twirp/livekit.RoomService/ListRooms');
      expect(JSON.parse(String(init?.body))).toEqual({});
      return new Response(JSON.stringify({ rooms: [{ name: 'a' }] }), { status: 200 });
    });
    const env = { LIVEKIT_API: { fetch: fetchFn } } as unknown as Env;
    await expect(listLiveKitRooms(env)).resolves.toEqual({ rooms: [{ name: 'a' }] });
  });

  it('listLiveKitRooms returns null on non-OK and on throw', async () => {
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
  });
});
