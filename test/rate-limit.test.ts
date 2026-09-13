import { describe, it, expect } from 'vitest';
import { getRateLimitType, getClientId, RATE_LIMITS } from '../src/middleware/rate-limit';
import type { Context } from 'hono';
import type { AppEnv } from '../src/types';

function makeContext(
  opts: {
    userId?: string;
    headers?: Record<string, string>;
    env?: Partial<AppEnv['Bindings']>;
  } = {}
): Context<AppEnv> {
  const headers = opts.headers ?? {};
  return {
    get: (key: string) => (key === 'userId' ? opts.userId : undefined),
    req: {
      header: (name: string) => headers[name] ?? headers[name.toLowerCase()],
    },
    env: opts.env ?? {},
  } as unknown as Context<AppEnv>;
}

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

  it('classifies /upload without /media as media_upload for write methods', () => {
    expect(getRateLimitType('/_matrix/client/v3/upload', 'POST')).toBe('media_upload');
    expect(getRateLimitType('/_matrix/client/v3/upload', 'GET')).toBe('media_download');
  });

  it('prefers login classification over overlapping path segments', () => {
    // /login is checked before /media|/upload patterns
    expect(getRateLimitType('/_matrix/client/v3/login', 'POST')).toBe('login');
  });
});

describe('getClientId', () => {
  it('prefers authenticated user id', () => {
    expect(
      getClientId(
        makeContext({
          userId: '@alice:example.com',
          headers: { 'CF-Connecting-IP': '203.0.113.1' },
        })
      )
    ).toBe('user:@alice:example.com');
  });

  it('uses CF-Connecting-IP for anonymous clients', () => {
    expect(getClientId(makeContext({ headers: { 'CF-Connecting-IP': '203.0.113.2' } }))).toBe(
      'ip:203.0.113.2'
    );
  });

  it('only trusts X-Forwarded-For when opted in', () => {
    expect(getClientId(makeContext({ headers: { 'X-Forwarded-For': '198.51.100.1' } }))).toBe(
      'ip:unknown'
    );
    expect(
      getClientId(
        makeContext({
          headers: { 'X-Forwarded-For': '198.51.100.1, 10.0.0.1' },
          env: { TRUST_FORWARDED_FOR: 'true' },
        })
      )
    ).toBe('ip:198.51.100.1');
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

  it('gives sync and federation higher throughput than default', () => {
    expect(RATE_LIMITS.sync.requests).toBeGreaterThan(RATE_LIMITS.default.requests);
    expect(RATE_LIMITS.federation.requests).toBeGreaterThan(RATE_LIMITS.default.requests);
  });
});

describe('getRateLimitType sliding sync and keys query', () => {
  it('classifies sliding sync under the sync bucket', () => {
    expect(getRateLimitType('/_matrix/client/unstable/org.matrix.msc3575/sync', 'POST')).toBe(
      'sync'
    );
    expect(getRateLimitType('/_matrix/client/v3/sync', 'POST')).toBe('sync');
  });

  it('classifies keys claim/query as e2ee', () => {
    expect(getRateLimitType('/_matrix/client/v3/keys/claim', 'POST')).toBe('e2ee');
    expect(getRateLimitType('/_matrix/client/v3/keys/query', 'POST')).toBe('e2ee');
  });
});

describe('getClientId edge cases', () => {
  it('falls back to unknown when opted-in XFF is empty', () => {
    expect(
      getClientId(
        makeContext({
          headers: { 'X-Forwarded-For': '  , 10.0.0.1' },
          env: { TRUST_FORWARDED_FOR: 'true' },
        })
      )
    ).toBe('ip:unknown');
  });
});
