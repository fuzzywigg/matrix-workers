/**
 * TOKENMAXX HEAVY leftovers after #226 — analyticsMiddleware edges not covered by
 * test/analytics-middleware.test.ts (clock-pinned latency / 5-segment index / write throw).
 *
 * Distinct from rate-limit concurrent-race (#226), oidc-auth (#223), federation-auth (#222).
 * Tests-only. Fixtures use example.com only. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyticsMiddleware } from '../src/middleware/analytics';

const NOW = 1_700_000_000_000;

function makeAnalyticsCtx(opts: {
  url?: string;
  method?: string;
  status?: number;
  analytics?: { writeDataPoint: ReturnType<typeof vi.fn> } | Record<string, never> | undefined | null;
}) {
  const analytics = opts.analytics;
  const writeDataPoint =
    analytics && 'writeDataPoint' in analytics ? analytics.writeDataPoint : undefined;
  return {
    req: {
      url: opts.url ?? 'https://matrix.example.com/_matrix/client/v3/sync',
      method: opts.method ?? 'GET',
    },
    res: { status: opts.status ?? 200 },
    env: {
      ANALYTICS:
        analytics === undefined || analytics === null
          ? analytics
          : writeDataPoint
            ? { writeDataPoint }
            : analytics,
    },
  };
}

describe('analyticsMiddleware leftovers after #226', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('discards next() return even when ANALYTICS is absent', async () => {
    const next = vi.fn(async () => 'handler-ok');
    const ctx = makeAnalyticsCtx({ analytics: undefined });
    await expect(analyticsMiddleware()(ctx, next)).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('discards next() return when write succeeds', async () => {
    const writeDataPoint = vi.fn();
    const next = vi.fn(async () => ({ ok: true }));
    const ctx = makeAnalyticsCtx({ analytics: { writeDataPoint } });
    await expect(analyticsMiddleware()(ctx, next)).resolves.toBeUndefined();
    expect(writeDataPoint).toHaveBeenCalledOnce();
  });

  it('propagates next() throw and skips writeDataPoint (await next is outside try)', async () => {
    const writeDataPoint = vi.fn();
    const next = vi.fn(async () => {
      throw new Error('handler boom');
    });
    const ctx = makeAnalyticsCtx({ analytics: { writeDataPoint } });
    await expect(analyticsMiddleware()(ctx, next)).rejects.toThrow('handler boom');
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it('skips write when ANALYTICS is null (falsy binding)', async () => {
    const next = vi.fn(async () => undefined);
    const ctx = makeAnalyticsCtx({ analytics: null });
    await analyticsMiddleware()(ctx, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('swallows TypeError when ANALYTICS is present without writeDataPoint', async () => {
    const next = vi.fn(async () => 'ok');
    const ctx = makeAnalyticsCtx({ analytics: {} });
    await expect(analyticsMiddleware()(ctx, next)).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('swallows invalid URL via catch (relative path is not a URL)', async () => {
    const writeDataPoint = vi.fn();
    const next = vi.fn(async () => undefined);
    const ctx = makeAnalyticsCtx({
      analytics: { writeDataPoint },
      url: '/_matrix/client/v3/sync',
    });
    await expect(analyticsMiddleware()(ctx, next)).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it('swallows empty-string URL via catch', async () => {
    const writeDataPoint = vi.fn();
    const next = vi.fn(async () => undefined);
    const ctx = makeAnalyticsCtx({
      analytics: { writeDataPoint },
      url: '',
    });
    await expect(analyticsMiddleware()(ctx, next)).resolves.toBeUndefined();
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it('records pathname only — query string is stripped from blobs and indexes', async () => {
    const writeDataPoint = vi.fn();
    const next = vi.fn(async () => undefined);
    const ctx = makeAnalyticsCtx({
      analytics: { writeDataPoint },
      url: 'https://matrix.example.com/_matrix/client/v3/sync?access_token=secret&timeout=30000',
      method: 'GET',
      status: 200,
    });
    await analyticsMiddleware()(ctx, next);
    expect(writeDataPoint.mock.calls[0][0].blobs[0]).toBe('/_matrix/client/v3/sync');
    expect(writeDataPoint.mock.calls[0][0].indexes[0]).toBe('/_matrix/client/v3/sync');
    expect(JSON.stringify(writeDataPoint.mock.calls[0][0])).not.toContain('access_token');
    expect(JSON.stringify(writeDataPoint.mock.calls[0][0])).not.toContain('secret');
  });

  it('records pathname only — hash fragment is stripped', async () => {
    const writeDataPoint = vi.fn();
    const next = vi.fn(async () => undefined);
    const ctx = makeAnalyticsCtx({
      analytics: { writeDataPoint },
      url: 'https://matrix.example.com/_matrix/client/v3/login#frag',
    });
    await analyticsMiddleware()(ctx, next);
    expect(writeDataPoint.mock.calls[0][0].blobs[0]).toBe('/_matrix/client/v3/login');
  });

  it('index for root path / is "/" (split(["",""]).join("/"))', async () => {
    const writeDataPoint = vi.fn();
    const next = vi.fn(async () => undefined);
    const ctx = makeAnalyticsCtx({
      analytics: { writeDataPoint },
      url: 'https://matrix.example.com/',
    });
    await analyticsMiddleware()(ctx, next);
    expect(writeDataPoint.mock.calls[0][0].blobs[0]).toBe('/');
    expect(writeDataPoint.mock.calls[0][0].indexes[0]).toBe('/');
  });

  it('index equals full path when fewer than 5 segments', async () => {
    const writeDataPoint = vi.fn();
    const next = vi.fn(async () => undefined);
    await analyticsMiddleware()(
      makeAnalyticsCtx({
        analytics: { writeDataPoint },
        url: 'https://matrix.example.com/health',
      }),
      next
    );
    expect(writeDataPoint.mock.calls[0][0].indexes[0]).toBe('/health');

    await analyticsMiddleware()(
      makeAnalyticsCtx({
        analytics: { writeDataPoint },
        url: 'https://matrix.example.com/_matrix/client',
      }),
      next
    );
    expect(writeDataPoint.mock.calls[1][0].indexes[0]).toBe('/_matrix/client');
  });

  it('index truncates federation / media / keys prefixes at 5 segments', async () => {
    const writeDataPoint = vi.fn();
    const next = vi.fn(async () => undefined);
    const cases: Array<[string, string]> = [
      [
        'https://matrix.example.com/_matrix/federation/v1/send/txn',
        '/_matrix/federation/v1/send',
      ],
      [
        'https://matrix.example.com/_matrix/media/v3/download/example.com/mxc',
        '/_matrix/media/v3/download',
      ],
      [
        'https://matrix.example.com/_matrix/client/v3/keys/query',
        '/_matrix/client/v3/keys',
      ],
      [
        'https://matrix.example.com/_matrix/client/v3/rooms/!r:example.com/send/m.room.message/$e',
        '/_matrix/client/v3/rooms',
      ],
    ];
    for (const [url, index] of cases) {
      writeDataPoint.mockClear();
      await analyticsMiddleware()(makeAnalyticsCtx({ analytics: { writeDataPoint }, url }), next);
      expect(writeDataPoint.mock.calls[0][0].indexes).toEqual([index]);
    }
  });

  it('keeps trailing slash in blob path (not normalized)', async () => {
    const writeDataPoint = vi.fn();
    const next = vi.fn(async () => undefined);
    await analyticsMiddleware()(
      makeAnalyticsCtx({
        analytics: { writeDataPoint },
        url: 'https://matrix.example.com/_matrix/client/v3/sync/',
      }),
      next
    );
    expect(writeDataPoint.mock.calls[0][0].blobs[0]).toBe('/_matrix/client/v3/sync/');
  });

  it('stringifies status 0 / 429 / 500 as blobs[2]', async () => {
    const writeDataPoint = vi.fn();
    const next = vi.fn(async () => undefined);
    for (const status of [0, 429, 500]) {
      writeDataPoint.mockClear();
      await analyticsMiddleware()(
        makeAnalyticsCtx({ analytics: { writeDataPoint }, status }),
        next
      );
      expect(writeDataPoint.mock.calls[0][0].blobs[2]).toBe(String(status));
    }
  });

  it('pins negative latency when clock rewinds during next()', async () => {
    const writeDataPoint = vi.fn();
    const next = vi.fn(async () => {
      vi.setSystemTime(NOW - 15);
    });
    await analyticsMiddleware()(makeAnalyticsCtx({ analytics: { writeDataPoint } }), next);
    expect(writeDataPoint.mock.calls[0][0].doubles[0]).toBe(-15);
  });

  it('isolates concurrent requests (path/method/status do not mix)', async () => {
    const writeDataPoint = vi.fn();
    // Fake timers share Date.now(); do not advance the clock inside concurrent next().
    const nextA = vi.fn(async () => undefined);
    const nextB = vi.fn(async () => undefined);
    await Promise.all([
      analyticsMiddleware()(
        makeAnalyticsCtx({
          analytics: { writeDataPoint },
          url: 'https://matrix.example.com/_matrix/client/v3/login',
          method: 'POST',
          status: 200,
        }),
        nextA
      ),
      analyticsMiddleware()(
        makeAnalyticsCtx({
          analytics: { writeDataPoint },
          url: 'https://matrix.example.com/_matrix/client/v3/logout',
          method: 'POST',
          status: 401,
        }),
        nextB
      ),
    ]);
    const payloads = writeDataPoint.mock.calls.map((c) => c[0]);
    expect(payloads).toHaveLength(2);
    const paths = payloads.map((p: { blobs: string[] }) => p.blobs[0]).sort();
    expect(paths).toEqual(['/_matrix/client/v3/login', '/_matrix/client/v3/logout']);
    const statuses = payloads.map((p: { blobs: string[] }) => p.blobs[2]).sort();
    expect(statuses).toEqual(['200', '401']);
    expect(payloads.every((p: { doubles: number[] }) => p.doubles[0] === 0)).toBe(true);
  });

  it('swallows TypeError from writeDataPoint distinctly from Error', async () => {
    const writeDataPoint = vi.fn(() => {
      throw new TypeError('not a function');
    });
    const next = vi.fn(async () => 'ok');
    await expect(
      analyticsMiddleware()(makeAnalyticsCtx({ analytics: { writeDataPoint } }), next)
    ).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('swallows writeDataPoint throw after next already completed (does not rethrow)', async () => {
    const writeDataPoint = vi.fn(() => {
      throw new Error('engine full');
    });
    let nextFinished = false;
    const next = vi.fn(async () => {
      nextFinished = true;
    });
    await analyticsMiddleware()(makeAnalyticsCtx({ analytics: { writeDataPoint } }), next);
    expect(nextFinished).toBe(true);
  });

  it('percent-encoded room ids stay encoded in blob path', async () => {
    const writeDataPoint = vi.fn();
    const next = vi.fn(async () => undefined);
    await analyticsMiddleware()(
      makeAnalyticsCtx({
        analytics: { writeDataPoint },
        url: 'https://matrix.example.com/_matrix/client/v3/rooms/%21r%3Aexample.com/messages',
        method: 'GET',
        status: 200,
      }),
      next
    );
    expect(writeDataPoint.mock.calls[0][0].blobs[0]).toBe(
      '/_matrix/client/v3/rooms/%21r%3Aexample.com/messages'
    );
    expect(writeDataPoint.mock.calls[0][0].indexes[0]).toBe('/_matrix/client/v3/rooms');
  });

  it('records PUT/DELETE/OPTIONS methods as blob[1]', async () => {
    const writeDataPoint = vi.fn();
    const next = vi.fn(async () => undefined);
    for (const method of ['PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
      writeDataPoint.mockClear();
      await analyticsMiddleware()(
        makeAnalyticsCtx({ analytics: { writeDataPoint }, method }),
        next
      );
      expect(writeDataPoint.mock.calls[0][0].blobs[1]).toBe(method);
    }
  });

  it('Promise.all mixed: absent binding ∥ write throw ∥ success isolation', async () => {
    const writeOk = vi.fn();
    const writeBoom = vi.fn(() => {
      throw new Error('down');
    });
    const results = await Promise.allSettled([
      analyticsMiddleware()(makeAnalyticsCtx({ analytics: undefined }), vi.fn(async () => 'a')),
      analyticsMiddleware()(
        makeAnalyticsCtx({ analytics: { writeDataPoint: writeBoom } }),
        vi.fn(async () => 'b')
      ),
      analyticsMiddleware()(
        makeAnalyticsCtx({ analytics: { writeDataPoint: writeOk } }),
        vi.fn(async () => 'c')
      ),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(writeOk).toHaveBeenCalledOnce();
    expect(writeBoom).toHaveBeenCalledOnce();
  });
});
