import { describe, it, expect } from 'vitest';
import { getRateLimitType, RATE_LIMITS } from '../src/middleware/rate-limit';

describe('getRateLimitType', () => {
  it('classifies login POST correctly', () => {
    expect(getRateLimitType('/_matrix/client/v3/login', 'POST')).toBe('login');
  });

  it('does not classify login GET as login', () => {
    expect(getRateLimitType('/_matrix/client/v3/login', 'GET')).toBe('default');
  });

  it('classifies register POST correctly', () => {
    expect(getRateLimitType('/_matrix/client/v3/register', 'POST')).toBe('register');
  });

  it('classifies sync endpoint', () => {
    expect(getRateLimitType('/_matrix/client/v3/sync', 'GET')).toBe('sync');
  });

  it('classifies e2ee key upload', () => {
    expect(getRateLimitType('/_matrix/client/v3/keys/upload', 'POST')).toBe('e2ee');
  });

  it('classifies media upload vs download', () => {
    expect(getRateLimitType('/_matrix/media/v3/upload', 'POST')).toBe('media_upload');
    expect(getRateLimitType('/_matrix/media/v3/download/server/media', 'GET')).toBe('media_download');
  });

  it('classifies search', () => {
    expect(getRateLimitType('/_matrix/client/v3/search', 'POST')).toBe('search');
  });

  it('classifies federation routes', () => {
    expect(getRateLimitType('/_matrix/federation/v1/send', 'PUT')).toBe('federation');
    expect(getRateLimitType('/_matrix/key/v2/server', 'GET')).toBe('federation');
  });

  it('classifies room creation', () => {
    expect(getRateLimitType('/_matrix/client/v3/createRoom', 'POST')).toBe('create_room');
  });

  it('classifies room message send', () => {
    expect(
      getRateLimitType('/_matrix/client/v3/rooms/!abc:example.com/send/m.room.message/1', 'PUT')
    ).toBe('send_message');
  });

  it('falls back to default for unknown routes', () => {
    expect(getRateLimitType('/_matrix/client/v3/profile/@user:example.com', 'GET')).toBe('default');
  });
});

describe('RATE_LIMITS', () => {
  it('defines every classifier bucket', () => {
    const paths: Array<[string, string]> = [
      ['/_matrix/client/v3/login', 'POST'],
      ['/_matrix/client/v3/register', 'POST'],
      ['/_matrix/client/v3/sync', 'GET'],
      ['/_matrix/client/v3/keys/upload', 'POST'],
      ['/_matrix/media/v3/upload', 'POST'],
      ['/_matrix/media/v3/download/x/y', 'GET'],
      ['/_matrix/client/v3/search', 'POST'],
      ['/_matrix/federation/v1/send', 'PUT'],
      ['/_matrix/client/v3/createRoom', 'POST'],
      ['/_matrix/client/v3/rooms/!r:s/send/m.room.message/1', 'PUT'],
      ['/_matrix/client/v3/profile/@u:s', 'GET'],
    ];
    for (const [path, method] of paths) {
      const type = getRateLimitType(path, method);
      expect(RATE_LIMITS[type]).toBeDefined();
      expect(RATE_LIMITS[type].requests).toBeGreaterThan(0);
      expect(RATE_LIMITS[type].windowMs).toBeGreaterThan(0);
    }
  });

  it('keeps auth endpoints stricter than default', () => {
    expect(RATE_LIMITS.login.requests).toBeLessThan(RATE_LIMITS.default.requests);
    expect(RATE_LIMITS.register.requests).toBeLessThan(RATE_LIMITS.login.requests);
  });
});
