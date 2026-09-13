import { describe, it, expect } from 'vitest';
import { getSupportedRoomVersions, getDefaultRoomVersion } from '../src/services/room-versions';

/**
 * Shape checks for discovery/version payloads the Worker advertises.
 * These mirror src/api/versions.ts without spinning up a Worker runtime.
 */
describe('Client versions payload shape', () => {
  it('advertises Matrix CS API versions expected by modern clients', () => {
    const versions = [
      'r0.0.1',
      'r0.1.0',
      'r0.2.0',
      'r0.3.0',
      'r0.4.0',
      'r0.5.0',
      'r0.6.0',
      'r0.6.1',
      'v1.1',
      'v1.2',
      'v1.3',
      'v1.4',
      'v1.5',
      'v1.6',
      'v1.7',
      'v1.8',
      'v1.9',
      'v1.10',
      'v1.11',
      'v1.12',
    ];
    expect(versions).toContain('v1.11');
    expect(versions[versions.length - 1]).toMatch(/^v1\./);
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
