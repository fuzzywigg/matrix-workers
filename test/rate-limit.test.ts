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

describe('getRateLimitType method / path failure edges', () => {
  it('does not classify register GET or createRoom GET as write buckets', () => {
    expect(getRateLimitType('/_matrix/client/v3/register', 'GET')).toBe('default');
    expect(getRateLimitType('/_matrix/client/v3/createRoom', 'GET')).toBe('default');
  });

  it('requires PUT for send_message classification', () => {
    const path = '/_matrix/client/v3/rooms/!r:s/send/m.room.message/1';
    expect(getRateLimitType(path, 'PUT')).toBe('send_message');
    expect(getRateLimitType(path, 'POST')).toBe('default');
  });

  it('classifies media PUT uploads and DELETE downloads path as download bucket', () => {
    expect(getRateLimitType('/_matrix/media/v3/upload', 'PUT')).toBe('media_upload');
    expect(getRateLimitType('/_matrix/media/v3/download/x/y', 'DELETE')).toBe('media_download');
  });

  it('classifies federation media paths as media_download before federation', () => {
    // `/media` is checked before `/_matrix/federation`
    expect(getRateLimitType('/_matrix/federation/v1/media/download/server/mediaid', 'GET')).toBe(
      'media_download'
    );
    expect(getRateLimitType('/_matrix/federation/v1/media/download/server/mediaid', 'POST')).toBe(
      'media_upload'
    );
  });
});


describe('rate-limit TOKENMAXX edge paths after #49', () => {
  it('prefers CF-Connecting-IP over trusted X-Forwarded-For', () => {
    expect(
      getClientId(
        makeContext({
          headers: {
            'CF-Connecting-IP': '203.0.113.9',
            'X-Forwarded-For': '198.51.100.9',
          },
          env: { TRUST_FORWARDED_FOR: 'true' },
        })
      )
    ).toBe('ip:203.0.113.9');
  });

  it('requires exact lowercase true for TRUST_FORWARDED_FOR', () => {
    expect(
      getClientId(
        makeContext({
          headers: { 'X-Forwarded-For': '198.51.100.1' },
          env: { TRUST_FORWARDED_FOR: 'TRUE' },
        })
      )
    ).toBe('ip:unknown');
    expect(
      getClientId(
        makeContext({
          headers: { 'X-Forwarded-For': '198.51.100.1' },
          env: { TRUST_FORWARDED_FOR: '1' },
        })
      )
    ).toBe('ip:unknown');
  });

  it('falls through blank CF-Connecting-IP to trusted XFF', () => {
    expect(
      getClientId(
        makeContext({
          headers: { 'CF-Connecting-IP': '', 'X-Forwarded-For': '198.51.100.7' },
          env: { TRUST_FORWARDED_FOR: 'true' },
        })
      )
    ).toBe('ip:198.51.100.7');
  });

  it('treats login method comparison as case-sensitive', () => {
    expect(getRateLimitType('/_matrix/client/v3/login', 'post')).toBe('default');
    expect(getRateLimitType('/_matrix/client/v3/login', 'POST')).toBe('login');
  });
});

describe('rate-limit TOKENMAXX edge paths after #50', () => {
  it('treats empty-string userId as absent and falls through to CF IP', () => {
    expect(
      getClientId(
        makeContext({
          userId: '',
          headers: { 'CF-Connecting-IP': '203.0.113.50' },
        })
      )
    ).toBe('ip:203.0.113.50');
  });

  it('classifies URL-encoded room send paths as send_message', () => {
    expect(
      getRateLimitType('/_matrix/client/v3/rooms/%21r%3Aexample.com/send/m.room.message/1', 'PUT')
    ).toBe('send_message');
  });

  it('classifies /keys/ substring mid-path as e2ee', () => {
    expect(getRateLimitType('/_matrix/client/v3/keys/changes', 'GET')).toBe('e2ee');
  });

  it('uses a single trusted XFF hop without spaces', () => {
    expect(
      getClientId(
        makeContext({
          headers: { 'X-Forwarded-For': '198.51.100.1' },
          env: { TRUST_FORWARDED_FOR: 'true' },
        })
      )
    ).toBe('ip:198.51.100.1');
  });
});


describe('rate-limit TOKENMAXX edge paths after #52', () => {
  it('pins exact RATE_LIMITS request counts and 60s windows', () => {
    expect(RATE_LIMITS.login).toEqual({ requests: 10, windowMs: 60_000 });
    expect(RATE_LIMITS.register).toEqual({ requests: 5, windowMs: 60_000 });
    expect(RATE_LIMITS.default).toEqual({ requests: 100, windowMs: 60_000 });
    expect(RATE_LIMITS.sync).toEqual({ requests: 300, windowMs: 60_000 });
    expect(RATE_LIMITS.e2ee).toEqual({ requests: 500, windowMs: 60_000 });
    expect(RATE_LIMITS.media_upload).toEqual({ requests: 30, windowMs: 60_000 });
    expect(RATE_LIMITS.media_download).toEqual({ requests: 200, windowMs: 60_000 });
    expect(RATE_LIMITS.search).toEqual({ requests: 30, windowMs: 60_000 });
    expect(RATE_LIMITS.federation).toEqual({ requests: 500, windowMs: 60_000 });
    expect(RATE_LIMITS.send_message).toEqual({ requests: 60, windowMs: 60_000 });
    expect(RATE_LIMITS.create_room).toEqual({ requests: 10, windowMs: 60_000 });
  });

  it('classifies mid-path /login /register /search substrings (document traps)', () => {
    expect(getRateLimitType('/_matrix/client/v3/profile/login', 'POST')).toBe('login');
    expect(getRateLimitType('/_matrix/client/v3/users/register/foo', 'POST')).toBe('register');
    expect(getRateLimitType('/_matrix/client/v3/rooms/!r:s/search', 'POST')).toBe('search');
  });

  it('classifies /_matrix/key/v2/query as federation', () => {
    expect(getRateLimitType('/_matrix/key/v2/query', 'POST')).toBe('federation');
    expect(getRateLimitType('/_matrix/key/v2/query', 'GET')).toBe('federation');
  });
});

describe('rate-limit TOKENMAXX edge paths after #53', () => {
  it('prefers /login over /media when both substrings are present (POST)', () => {
    expect(getRateLimitType('/_matrix/media/v3/login', 'POST')).toBe('login');
    expect(getRateLimitType('/_matrix/media/v3/login', 'GET')).toBe('media_download');
  });

  it('classifies key/v2/server/<keyId> paths as federation', () => {
    expect(getRateLimitType('/_matrix/key/v2/server/ed25519:abcd', 'GET')).toBe('federation');
  });

  it('treats whitespace-only userId as truthy for the user bucket', () => {
    expect(getClientId(makeContext({ userId: ' ' }))).toBe('user: ');
  });
});


describe('rate-limit TOKENMAXX edge paths after #54', () => {
  it('does not classify /keys without trailing slash as e2ee', () => {
    expect(getRateLimitType('/_matrix/client/v3/keys', 'POST')).toBe('default');
    expect(getRateLimitType('/_matrix/client/v3/keys/upload', 'POST')).toBe('e2ee');
  });

  it('classifies HEAD/PATCH media as media_download (non-POST/PUT)', () => {
    expect(getRateLimitType('/_matrix/media/v3/download/s/m', 'HEAD')).toBe('media_download');
    expect(getRateLimitType('/_matrix/media/v3/upload', 'PATCH')).toBe('media_download');
  });

  it('requires POST for createRoom; PUT falls through to default', () => {
    expect(getRateLimitType('/_matrix/client/v3/createRoom', 'POST')).toBe('create_room');
    expect(getRateLimitType('/_matrix/client/v3/createRoom', 'PUT')).toBe('default');
  });

  it('prefers /sync over /_matrix/federation when both substrings appear', () => {
    expect(getRateLimitType('/_matrix/federation/v1/sync', 'GET')).toBe('sync');
  });
});


describe('rate-limit TOKENMAXX edge paths after #55', () => {
  it('classifies federation user/keys paths as e2ee (/keys/ checked before federation)', () => {
    expect(getRateLimitType('/_matrix/federation/v1/user/keys/claim', 'POST')).toBe('e2ee');
    expect(getRateLimitType('/_matrix/federation/v1/user/keys/query', 'POST')).toBe('e2ee');
  });

  it('does not classify /redact/ or /state/ room writes as send_message', () => {
    expect(
      getRateLimitType('/_matrix/client/v3/rooms/!r:s/redact/$e/t1', 'PUT')
    ).toBe('default');
    expect(
      getRateLimitType('/_matrix/client/v3/rooms/!r:s/state/m.room.name/', 'PUT')
    ).toBe('default');
  });

  it('trims whitespace on the first trusted X-Forwarded-For hop', () => {
    expect(
      getClientId(
        makeContext({
          headers: { 'X-Forwarded-For': ' 198.51.100.1 , 10.0.0.1' },
          env: { TRUST_FORWARDED_FOR: 'true' },
        })
      )
    ).toBe('ip:198.51.100.1');
  });
});
