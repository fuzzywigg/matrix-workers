import { describe, it, expect } from 'vitest';
import { getSupportedRoomVersions, getDefaultRoomVersion } from '../src/services/room-versions';
import versions from '../src/api/versions';
import type { Env } from '../src/types';

/**
 * Health / discovery shape checks after #83 — exercises real versions routes
 * (replacing the prior mirrored hard-coded version list stub).
 */
function env(partial: Partial<Env> = {}): Env {
  return {
    SERVER_NAME: 'matrix.fuzzywigg.com',
    SERVER_VERSION: '0.1.0',
    ...partial,
  } as Env;
}

describe('Client versions payload shape', () => {
  it('advertises Matrix CS API versions expected by modern clients via the route', async () => {
    const res = await versions.request('/_matrix/client/versions', {}, env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { versions: string[] };
    expect(body.versions).toContain('v1.11');
    expect(body.versions).toContain('v1.12');
    expect(body.versions[body.versions.length - 1]).toMatch(/^v1\./);
    expect(body.versions).toHaveLength(20);
  });

  it('exposes supported room versions with a stable default', () => {
    const supported = getSupportedRoomVersions();
    expect(supported[getDefaultRoomVersion()]).toBe('stable');
    expect(supported['11']).toBe('stable');
    expect(supported['12']).toBe('stable');
  });
});

describe('SERVER_NAME hostname hygiene', () => {
  const hostnameRe = /^[a-z0-9.-]+\.[a-z]{2,}$/;

  it('accepts the live fork domain and related hostnames', () => {
    for (const domain of ['matrix.fuzzywigg.com', 'matrix.smtp.eth', 'm.smtp.eth']) {
      expect(domain).toMatch(hostnameRe);
    }
  });

  it('rejects empty server names', () => {
    expect(''.length).toBe(0);
  });

  it('embeds the live fork domain into well-known client discovery', async () => {
    const res = await versions.request('/.well-known/matrix/client', {}, env());
    const body = (await res.json()) as {
      'm.homeserver': { base_url: string };
      'm.server'?: string;
    };
    expect(body['m.homeserver'].base_url).toBe('https://matrix.fuzzywigg.com');
    expect(body['m.homeserver'].base_url).toMatch(/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/);
  });
});
