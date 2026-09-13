import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { analyticsMiddleware } from '../src/middleware/analytics';

const NOW = 1_700_000_000_000;

function makeAnalyticsCtx(opts: {
  url?: string;
  method?: string;
  status?: number;
  analytics?: { writeDataPoint: ReturnType<typeof vi.fn> } | undefined;
}) {
  const writeDataPoint = opts.analytics?.writeDataPoint;
  return {
    req: {
      url: opts.url ?? 'https://matrix.example.com/_matrix/client/v3/sync?access_token=x',
      method: opts.method ?? 'GET',
    },
    res: { status: opts.status ?? 200 },
    env: {
      ANALYTICS: writeDataPoint ? { writeDataPoint } : undefined,
    },
  } as any;
}

describe('analyticsMiddleware clock-pinned latency', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('skips writeDataPoint when ANALYTICS binding is absent', async () => {
    const next = vi.fn(async () => {
      vi.setSystemTime(NOW + 25);
    });
    const ctx = makeAnalyticsCtx({ analytics: undefined });
    await analyticsMiddleware()(ctx, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('pins doubles[0] latency to end−start with mid-flight clock advance', async () => {
    const writeDataPoint = vi.fn();
    const next = vi.fn(async () => {
      vi.setSystemTime(NOW + 42);
    });
    const ctx = makeAnalyticsCtx({
      analytics: { writeDataPoint },
      url: 'https://matrix.example.com/_matrix/client/v3/rooms/!r:s/messages',
      method: 'GET',
      status: 200,
    });

    await analyticsMiddleware()(ctx, next);

    expect(writeDataPoint).toHaveBeenCalledOnce();
    expect(writeDataPoint.mock.calls[0][0]).toEqual({
      blobs: ['/_matrix/client/v3/rooms/!r:s/messages', 'GET', '200'],
      doubles: [42],
      indexes: ['/_matrix/client/v3/rooms'],
    });
  });

  it('pins zero latency when next returns without advancing the clock', async () => {
    const writeDataPoint = vi.fn();
    const next = vi.fn(async () => undefined);
    const ctx = makeAnalyticsCtx({
      analytics: { writeDataPoint },
      status: 204,
      method: 'OPTIONS',
      url: 'https://matrix.example.com/_matrix/client/v3/login',
    });
    await analyticsMiddleware()(ctx, next);
    expect(writeDataPoint.mock.calls[0][0].doubles).toEqual([0]);
    expect(writeDataPoint.mock.calls[0][0].blobs).toEqual([
      '/_matrix/client/v3/login',
      'OPTIONS',
      '204',
    ]);
  });

  it('index truncates path to first 5 segments (join /)', async () => {
    const writeDataPoint = vi.fn();
    const next = vi.fn(async () => {
      vi.setSystemTime(NOW + 1);
    });
    // '', '_matrix', 'client', 'v3', 'rooms', '!r:s', 'event', '$e' → first 5 joined
    const ctx = makeAnalyticsCtx({
      analytics: { writeDataPoint },
      url: 'https://matrix.example.com/_matrix/client/v3/rooms/!r:s/event/$e',
      method: 'PUT',
      status: 201,
    });
    await analyticsMiddleware()(ctx, next);
    expect(writeDataPoint.mock.calls[0][0].indexes).toEqual(['/_matrix/client/v3/rooms']);
    expect(writeDataPoint.mock.calls[0][0].blobs[2]).toBe('201');
  });

  it('does not fail the request when writeDataPoint throws', async () => {
    const writeDataPoint = vi.fn(() => {
      throw new Error('analytics down');
    });
    const next = vi.fn(async () => {
      vi.setSystemTime(NOW + 7);
      return 'handler-ok';
    });
    const ctx = makeAnalyticsCtx({ analytics: { writeDataPoint } });
    await expect(analyticsMiddleware()(ctx, next)).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
    expect(writeDataPoint).toHaveBeenCalledOnce();
  });

  it('records mid-flight advance across the DEFAULT vs +1ms boundary distinctly', async () => {
    const writeDataPoint = vi.fn();
    const nextFast = vi.fn(async () => {
      vi.setSystemTime(NOW + 99);
    });
    const nextSlow = vi.fn(async () => {
      vi.setSystemTime(NOW + 100);
    });

    vi.setSystemTime(NOW);
    await analyticsMiddleware()(makeAnalyticsCtx({ analytics: { writeDataPoint } }), nextFast);
    vi.setSystemTime(NOW);
    await analyticsMiddleware()(makeAnalyticsCtx({ analytics: { writeDataPoint } }), nextSlow);

    expect(writeDataPoint.mock.calls[0][0].doubles[0]).toBe(99);
    expect(writeDataPoint.mock.calls[1][0].doubles[0]).toBe(100);
  });
});


describe('analyticsMiddleware TOKENMAXX path/status/method matrix after #82', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('indexes root path "/" as "/" (split yields ["",""] → join "/")', async () => {
    const writeDataPoint = vi.fn();
    const next = vi.fn(async () => {
      vi.setSystemTime(NOW + 3);
    });
    const ctx = makeAnalyticsCtx({
      analytics: { writeDataPoint },
      url: 'https://matrix.example.com/',
      method: 'GET',
      status: 200,
    });
    await analyticsMiddleware()(ctx, next);
    // '/'.split('/') → ['', '']; slice(0,5).join('/') → '/'
    expect(writeDataPoint.mock.calls[0][0]).toEqual({
      blobs: ['/', 'GET', '200'],
      doubles: [3],
      indexes: ['/'],
    });
  });

  it('strips query and hash via pathname before indexing', async () => {
    const writeDataPoint = vi.fn();
    await analyticsMiddleware()(
      makeAnalyticsCtx({
        analytics: { writeDataPoint },
        url: 'https://matrix.example.com/_matrix/client/v3/sync?filter=1#frag',
        method: 'GET',
        status: 200,
      }),
      vi.fn(async () => {
        vi.setSystemTime(NOW + 1);
      })
    );
    expect(writeDataPoint.mock.calls[0][0].blobs[0]).toBe('/_matrix/client/v3/sync');
    expect(writeDataPoint.mock.calls[0][0].indexes).toEqual(['/_matrix/client/v3/sync']);
  });

  it('keeps short paths (1–4 segments) intact in the index', async () => {
    const writeDataPoint = vi.fn();
    const cases: Array<{ url: string; index: string }> = [
      { url: 'https://matrix.example.com/a', index: '/a' },
      { url: 'https://matrix.example.com/a/b', index: '/a/b' },
      { url: 'https://matrix.example.com/a/b/c', index: '/a/b/c' },
      { url: 'https://matrix.example.com/a/b/c/d', index: '/a/b/c/d' },
    ];
    for (const { url, index } of cases) {
      writeDataPoint.mockClear();
      vi.setSystemTime(NOW);
      await analyticsMiddleware()(
        makeAnalyticsCtx({ analytics: { writeDataPoint }, url, status: 200 }),
        vi.fn(async () => undefined)
      );
      expect(writeDataPoint.mock.calls[0][0].indexes).toEqual([index]);
    }
  });

  it('truncates paths with 6+ segments to the first 5', async () => {
    const writeDataPoint = vi.fn();
    await analyticsMiddleware()(
      makeAnalyticsCtx({
        analytics: { writeDataPoint },
        url: 'https://matrix.example.com/one/two/three/four/five/six/seven',
        status: 200,
      }),
      vi.fn(async () => undefined)
    );
    // '', one, two, three, four → join first 5
    expect(writeDataPoint.mock.calls[0][0].indexes).toEqual(['/one/two/three/four']);
    expect(writeDataPoint.mock.calls[0][0].blobs[0]).toBe('/one/two/three/four/five/six/seven');
  });

  it('records status matrix 401 / 429 / 500 / 204 as string blobs', async () => {
    const writeDataPoint = vi.fn();
    for (const status of [401, 429, 500, 204]) {
      writeDataPoint.mockClear();
      vi.setSystemTime(NOW);
      await analyticsMiddleware()(
        makeAnalyticsCtx({
          analytics: { writeDataPoint },
          url: 'https://matrix.example.com/_matrix/client/v3/login',
          status,
        }),
        vi.fn(async () => undefined)
      );
      expect(writeDataPoint.mock.calls[0][0].blobs[2]).toBe(String(status));
    }
  });

  it('records method matrix POST / PUT / DELETE / PATCH', async () => {
    const writeDataPoint = vi.fn();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      writeDataPoint.mockClear();
      vi.setSystemTime(NOW);
      await analyticsMiddleware()(
        makeAnalyticsCtx({
          analytics: { writeDataPoint },
          method,
          url: 'https://matrix.example.com/_matrix/client/v3/rooms/!r:s/send/m.room.message/t',
          status: 200,
        }),
        vi.fn(async () => undefined)
      );
      expect(writeDataPoint.mock.calls[0][0].blobs[1]).toBe(method);
    }
  });

  it('swallows invalid URL throws and still completes after next()', async () => {
    const writeDataPoint = vi.fn();
    const next = vi.fn(async () => 'handler-ok');
    const ctx = makeAnalyticsCtx({
      analytics: { writeDataPoint },
      url: 'not a url',
      status: 200,
    });
    await expect(analyticsMiddleware()(ctx, next)).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it('swallows non-Error throws from writeDataPoint', async () => {
    const writeDataPoint = vi.fn(() => {
      throw 'analytics-string-throw';
    });
    const next = vi.fn(async () => {
      vi.setSystemTime(NOW + 5);
      return 'ok';
    });
    await expect(
      analyticsMiddleware()(makeAnalyticsCtx({ analytics: { writeDataPoint } }), next)
    ).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
    expect(writeDataPoint).toHaveBeenCalledOnce();
  });

  it('still invokes next when ANALYTICS is present even if write is a no-op', async () => {
    const writeDataPoint = vi.fn();
    const next = vi.fn(async () => 'done');
    await analyticsMiddleware()(
      makeAnalyticsCtx({ analytics: { writeDataPoint }, status: 304 }),
      next
    );
    expect(next).toHaveBeenCalledOnce();
    expect(writeDataPoint.mock.calls[0][0].blobs[2]).toBe('304');
  });

  it('indexes federation paths using the same 5-segment prefix rule', async () => {
    const writeDataPoint = vi.fn();
    await analyticsMiddleware()(
      makeAnalyticsCtx({
        analytics: { writeDataPoint },
        url: 'https://matrix.example.com/_matrix/federation/v1/send/txn123',
        method: 'PUT',
        status: 200,
      }),
      vi.fn(async () => undefined)
    );
    expect(writeDataPoint.mock.calls[0][0].indexes).toEqual(['/_matrix/federation/v1/send']);
  });

  it('indexes admin paths truncated at five segments', async () => {
    const writeDataPoint = vi.fn();
    await analyticsMiddleware()(
      makeAnalyticsCtx({
        analytics: { writeDataPoint },
        url: 'https://matrix.example.com/admin/api/v1/users/@a:s/devices',
        method: 'GET',
        status: 200,
      }),
      vi.fn(async () => undefined)
    );
    expect(writeDataPoint.mock.calls[0][0].indexes).toEqual(['/admin/api/v1/users']);
  });

  it('records latency after a slow next() that advances far past start', async () => {
    const writeDataPoint = vi.fn();
    await analyticsMiddleware()(
      makeAnalyticsCtx({ analytics: { writeDataPoint } }),
      vi.fn(async () => {
        vi.setSystemTime(NOW + 12_345);
      })
    );
    expect(writeDataPoint.mock.calls[0][0].doubles[0]).toBe(12_345);
  });
});
