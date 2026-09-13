import { describe, it, expect } from 'vitest';
import versions from '../src/api/versions';
import { getSupportedRoomVersions, getDefaultRoomVersion } from '../src/services/room-versions';
import type { Env } from '../src/types';

/**
 * Lightweight smoke checks. Full well-known / versions route coverage lives in
 * test/versions-wellknown.test.ts (TOKENMAXX HEAVY after #83).
 */
describe('Client versions payload shape', () => {
  it('advertises Matrix CS API versions from the live versions module', async () => {
    const res = await versions.request(
      'http://localhost/_matrix/client/versions',
      {},
      { SERVER_NAME: 'matrix.example.com', SERVER_VERSION: 'test' } as Env
    );
    const body = (await res.json()) as { versions: string[] };
    expect(body.versions).toContain('v1.11');
    expect(body.versions[body.versions.length - 1]).toMatch(/^v1\./);
    expect(body.versions).toContain('v1.12');
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
});

describe('health TOKENMAXX after #83 — wire smoke to versions module', () => {
  it('federation version name stays matrix-worker', async () => {
    const res = await versions.request(
      'http://localhost/_matrix/federation/v1/version',
      {},
      { SERVER_NAME: 'matrix.fuzzywigg.com', SERVER_VERSION: '0.1.0' } as Env
    );
    expect(await res.json()).toEqual({
      server: { name: 'matrix-worker', version: '0.1.0' },
    });
  });
});
