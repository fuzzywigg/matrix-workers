import { describe, it, expect, vi } from 'vitest';
import {
  getRateLimitType,
  getClientId,
  RATE_LIMITS,
  rateLimitMiddleware,
  strictRateLimit,
} from '../src/middleware/rate-limit';
import type { Context } from 'hono';
import type { AppEnv } from '../src/types';

function makeContext(
  opts: {
    userId?: string;
    headers?: Record<string, string>;
    env?: Partial<AppEnv['Bindings']>;
    path?: string;
    method?: string;
  } = {}
): Context<AppEnv> {
  const headers = opts.headers ?? {};
  const setHeaders: Record<string, string> = {};
  return {
    get: (key: string) => (key === 'userId' ? opts.userId : undefined),
    req: {
      header: (name: string) => headers[name] ?? headers[name.toLowerCase()],
      path: opts.path ?? '/_matrix/client/v3/login',
      method: opts.method ?? 'POST',
    },
    env: opts.env ?? {},
    header: (name: string, value: string) => {
      setHeaders[name] = value;
    },
    json: (body: unknown, status?: number) => ({ body, status: status ?? 200, headers: setHeaders }),
    _headers: setHeaders,
  } as unknown as Context<AppEnv> & { _headers: Record<string, string> };
}

function mockRateLimitBinding(fetchImpl: (req: Request) => Promise<Response>) {
  const idFromName = vi.fn((name: string) => ({ name }));
  const get = vi.fn(() => ({
    fetch: fetchImpl,
  }));
  return { idFromName, get };
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


describe('rate-limit TOKENMAXX edge paths after #57', () => {
  it('does not classify sendToDevice as send_message (rooms/send regex only)', () => {
    expect(
      getRateLimitType('/_matrix/client/v3/sendToDevice/m.room.message/t1', 'PUT')
    ).toBe('default');
    expect(
      getRateLimitType('/_matrix/client/v3/rooms/!r:s/send/m.room.message/t1', 'PUT')
    ).toBe('send_message');
  });
});

describe('rateLimitMiddleware / strictRateLimit TOKENMAXX after #60', () => {
  it('skips OPTIONS and /sync without touching the rate-limit DO', async () => {
    const binding = mockRateLimitBinding(async () => new Response('{}'));
    const next = vi.fn(async () => 'next');

    const optsCtx = makeContext({
      method: 'OPTIONS',
      path: '/_matrix/client/v3/login',
      env: { RATE_LIMIT: binding } as Partial<AppEnv['Bindings']>,
    });
    await expect(rateLimitMiddleware(optsCtx, next)).resolves.toBe('next');
    expect(binding.idFromName).not.toHaveBeenCalled();

    const syncCtx = makeContext({
      method: 'GET',
      path: '/_matrix/client/v3/sync',
      env: { RATE_LIMIT: binding } as Partial<AppEnv['Bindings']>,
    });
    await expect(rateLimitMiddleware(syncCtx, next)).resolves.toBe('next');
    expect(binding.idFromName).not.toHaveBeenCalled();
  });

  it('sets X-RateLimit headers and calls next when the DO allows', async () => {
    const resetAt = 1_700_000_060_000;
    const binding = mockRateLimitBinding(async () =>
      Response.json({ allowed: true, remaining: 9, resetAt })
    );
    const next = vi.fn(async () => 'ok');
    const ctx = makeContext({
      path: '/_matrix/client/v3/login',
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.1' },
      env: { RATE_LIMIT: binding } as Partial<AppEnv['Bindings']>,
    });

    await expect(rateLimitMiddleware(ctx, next)).resolves.toBe('ok');
    expect(binding.idFromName).toHaveBeenCalledWith('login');
    const headers = (ctx as unknown as { _headers: Record<string, string> })._headers;
    expect(headers['X-RateLimit-Limit']).toBe('10');
    expect(headers['X-RateLimit-Remaining']).toBe('9');
    expect(headers['X-RateLimit-Reset']).toBe(String(Math.ceil(resetAt / 1000)));
    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 429 with Retry-After ceil(retryAfterMs/1000) when denied', async () => {
    const binding = mockRateLimitBinding(async () =>
      Response.json({
        allowed: false,
        remaining: 0,
        retryAfterMs: 1500,
        resetAt: 1_700_000_061_500,
      })
    );
    const next = vi.fn();
    const ctx = makeContext({
      path: '/_matrix/client/v3/register',
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.2' },
      env: { RATE_LIMIT: binding } as Partial<AppEnv['Bindings']>,
    });

    const result = (await rateLimitMiddleware(ctx, next)) as {
      body: unknown;
      status: number;
      headers: Record<string, string>;
    };
    expect(result.status).toBe(429);
    expect(result.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Too many requests',
      retry_after_ms: 1500,
    });
    expect(result.headers['Retry-After']).toBe('2'); // ceil(1.5s)
    expect(binding.idFromName).toHaveBeenCalledWith('register');
    expect(next).not.toHaveBeenCalled();
  });

  it('fails open when the DO fetch throws', async () => {
    const binding = mockRateLimitBinding(async () => {
      throw new Error('do down');
    });
    const next = vi.fn(async () => 'allowed');
    const ctx = makeContext({
      path: '/_matrix/client/v3/login',
      method: 'POST',
      env: { RATE_LIMIT: binding } as Partial<AppEnv['Bindings']>,
    });
    await expect(rateLimitMiddleware(ctx, next)).resolves.toBe('allowed');
    expect(next).toHaveBeenCalledOnce();
  });

  it('strictRateLimit uses strict:path DO id and denies with fallback windowMs', async () => {
    const binding = mockRateLimitBinding(async (req) => {
      const body = (await req.json()) as { limit: number; windowMs: number; clientId: string };
      expect(body).toMatchObject({ limit: 2, windowMs: 30_000, clientId: 'ip:203.0.113.9' });
      return Response.json({ allowed: false, remaining: 0 });
    });
    const next = vi.fn();
    const mw = strictRateLimit(2, 30_000);
    const ctx = makeContext({
      path: '/_matrix/client/v3/register',
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.9' },
      env: { RATE_LIMIT: binding } as Partial<AppEnv['Bindings']>,
    });

    const result = (await mw(ctx, next)) as {
      body: unknown;
      status: number;
      headers: Record<string, string>;
    };
    expect(binding.idFromName).toHaveBeenCalledWith('strict:/_matrix/client/v3/register');
    expect(result.status).toBe(429);
    expect(result.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Too many requests',
      retry_after_ms: 30_000,
    });
    expect(result.headers['Retry-After']).toBe('30');
    expect(next).not.toHaveBeenCalled();
  });

  it('strictRateLimit fails open on DO errors and allows when DO permits', async () => {
    const failBinding = mockRateLimitBinding(async () => {
      throw new Error('boom');
    });
    const next = vi.fn(async () => 'ok');
    const failCtx = makeContext({
      path: '/strict',
      method: 'POST',
      env: { RATE_LIMIT: failBinding } as Partial<AppEnv['Bindings']>,
    });
    await expect(strictRateLimit(1, 1000)(failCtx, next)).resolves.toBe('ok');

    const allowBinding = mockRateLimitBinding(async () =>
      Response.json({ allowed: true, remaining: 0 })
    );
    const allowCtx = makeContext({
      path: '/strict',
      method: 'POST',
      env: { RATE_LIMIT: allowBinding } as Partial<AppEnv['Bindings']>,
    });
    await expect(strictRateLimit(1, 1000)(allowCtx, next)).resolves.toBe('ok');
    expect(next).toHaveBeenCalledTimes(2);
  });
});

describe('rateLimitMiddleware fallback headers TOKENMAXX after #64', () => {
  it('denies without retryAfterMs using RATE_LIMITS[type].windowMs', async () => {
    const binding = mockRateLimitBinding(async () =>
      Response.json({ allowed: false, remaining: 0 })
    );
    const next = vi.fn();
    const ctx = makeContext({
      path: '/_matrix/client/v3/login',
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.40' },
      env: { RATE_LIMIT: binding } as Partial<AppEnv['Bindings']>,
    });

    const result = (await rateLimitMiddleware(ctx, next)) as {
      body: unknown;
      status: number;
      headers: Record<string, string>;
    };
    expect(result.status).toBe(429);
    expect(result.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Too many requests',
      retry_after_ms: RATE_LIMITS.login.windowMs,
    });
    expect(result.headers['Retry-After']).toBe(String(RATE_LIMITS.login.windowMs / 1000));
    expect(result.headers['X-RateLimit-Limit']).toBe(String(RATE_LIMITS.login.requests));
    expect(result.headers['X-RateLimit-Remaining']).toBe('0');
    expect(result.headers['X-RateLimit-Reset']).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
  });

  it('allows without resetAt and omits X-RateLimit-Reset', async () => {
    const binding = mockRateLimitBinding(async () =>
      Response.json({ allowed: true, remaining: 3 })
    );
    const next = vi.fn(async () => 'ok');
    const ctx = makeContext({
      path: '/_matrix/media/v3/upload',
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.41' },
      env: { RATE_LIMIT: binding } as Partial<AppEnv['Bindings']>,
    });

    await expect(rateLimitMiddleware(ctx, next)).resolves.toBe('ok');
    const headers = (ctx as unknown as { _headers: Record<string, string> })._headers;
    expect(headers['X-RateLimit-Limit']).toBe(String(RATE_LIMITS.media_upload.requests));
    expect(headers['X-RateLimit-Remaining']).toBe('3');
    expect(headers['X-RateLimit-Reset']).toBeUndefined();
    expect(binding.idFromName).toHaveBeenCalledWith('media_upload');
  });

  it('uses federation windowMs fallback for federation bucket denies', async () => {
    const binding = mockRateLimitBinding(async () =>
      Response.json({ allowed: false, remaining: 0 })
    );
    const next = vi.fn();
    const ctx = makeContext({
      path: '/_matrix/federation/v1/send/txn',
      method: 'PUT',
      headers: { 'CF-Connecting-IP': '203.0.113.42' },
      env: { RATE_LIMIT: binding } as Partial<AppEnv['Bindings']>,
    });

    const result = (await rateLimitMiddleware(ctx, next)) as {
      body: { retry_after_ms: number };
      status: number;
    };
    expect(result.status).toBe(429);
    expect(result.body.retry_after_ms).toBe(RATE_LIMITS.federation.windowMs);
    expect(binding.idFromName).toHaveBeenCalledWith('federation');
  });
});
