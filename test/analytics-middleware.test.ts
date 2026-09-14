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
    res: { status: 'status' in opts ? opts.status! : 200 },
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

describe('analyticsMiddleware clock-pinned deepen after #232', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('pins large latency (1_000_000ms) without clamping', async () => {
    const writeDataPoint = vi.fn();
    const next = vi.fn(async () => {
      vi.setSystemTime(NOW + 1_000_000);
    });
    await analyticsMiddleware()(makeAnalyticsCtx({ analytics: { writeDataPoint } }), next);
    expect(writeDataPoint.mock.calls[0][0].doubles[0]).toBe(1_000_000);
  });

  it('payload shape is exactly blobs + doubles + indexes (no extras)', async () => {
    const writeDataPoint = vi.fn();
    const next = vi.fn(async () => {
      vi.setSystemTime(NOW + 3);
    });
    await analyticsMiddleware()(makeAnalyticsCtx({ analytics: { writeDataPoint } }), next);
    expect(Object.keys(writeDataPoint.mock.calls[0][0]).sort()).toEqual([
      'blobs',
      'doubles',
      'indexes',
    ]);
    expect(writeDataPoint.mock.calls[0][0].blobs).toHaveLength(3);
    expect(writeDataPoint.mock.calls[0][0].doubles).toHaveLength(1);
    expect(writeDataPoint.mock.calls[0][0].indexes).toHaveLength(1);
  });

  it('stringifies undefined / null status as blobs[2]', async () => {
    const writeDataPoint = vi.fn();
    const next = vi.fn(async () => undefined);
    await analyticsMiddleware()(
      makeAnalyticsCtx({ analytics: { writeDataPoint }, status: undefined as unknown as number }),
      next
    );
    expect(writeDataPoint.mock.calls[0][0].blobs[2]).toBe('undefined');
    writeDataPoint.mockClear();
    await analyticsMiddleware()(
      makeAnalyticsCtx({ analytics: { writeDataPoint }, status: null as unknown as number }),
      next
    );
    expect(writeDataPoint.mock.calls[0][0].blobs[2]).toBe('null');
  });

  it('rewind then forward across two sequential calls pins independently', async () => {
    const writeDataPoint = vi.fn();
    await analyticsMiddleware()(
      makeAnalyticsCtx({ analytics: { writeDataPoint } }),
      vi.fn(async () => {
        vi.setSystemTime(NOW - 5);
      })
    );
    vi.setSystemTime(NOW);
    await analyticsMiddleware()(
      makeAnalyticsCtx({ analytics: { writeDataPoint } }),
      vi.fn(async () => {
        vi.setSystemTime(NOW + 11);
      })
    );
    expect(writeDataPoint.mock.calls[0][0].doubles[0]).toBe(-5);
    expect(writeDataPoint.mock.calls[1][0].doubles[0]).toBe(11);
  });
});
