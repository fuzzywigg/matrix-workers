import { describe, it, expect } from 'vitest';
import { generateLiveKitToken } from '../src/services/livekit';

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
