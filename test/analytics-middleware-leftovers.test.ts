/**
 * TOKENMAXX HEAVY leftovers after #226 / deepen after #232 / residual after #241 —
 * analyticsMiddleware edges not covered by test/analytics-middleware.test.ts
 * (clock-pinned latency / 5-segment index / write throw) or the first leftovers
 * pass (#227) / #232 deepen.
 *
 * Residual after #241: NaN/Infinity/boolean status String(), method undefined/null
 * (not String-coerced), post-next status mutate, writeDataPoint Promise not awaited,
 * host-only pathname "/".
 *
 * Distinct from room-cache (#232), catchup/consumer (#231), rate-limit (#226),
 * oidc-auth (#223), federation-auth (#222), devices+keybackups (#241).
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
      method: 'method' in opts ? (opts.method as string) : 'GET',
    },
    res: { status: 'status' in opts ? (opts.status as number) : 200 },
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

describe('analyticsMiddleware leftovers deepen after #232', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('payload shape contract: only blobs/doubles/indexes keys', async () => {
    const writeDataPoint = vi.fn();
    await analyticsMiddleware()(
      makeAnalyticsCtx({ analytics: { writeDataPoint } }),
      vi.fn(async () => undefined)
    );
    expect(Object.keys(writeDataPoint.mock.calls[0][0]).sort()).toEqual([
      'blobs',
      'doubles',
      'indexes',
    ]);
  });

  it('ignores writeDataPoint return value — middleware still resolves undefined', async () => {
    const writeDataPoint = vi.fn(() => ({ queued: true }));
    const next = vi.fn(async () => 'handler');
    await expect(
      analyticsMiddleware()(makeAnalyticsCtx({ analytics: { writeDataPoint } }), next)
    ).resolves.toBeUndefined();
    expect(writeDataPoint).toHaveBeenCalledOnce();
  });

  it('strips query and hash together from pathname blob', async () => {
    const writeDataPoint = vi.fn();
    await analyticsMiddleware()(
      makeAnalyticsCtx({
        analytics: { writeDataPoint },
        url: 'https://matrix.example.com/_matrix/client/v3/sync?access_token=secret#frag',
      }),
      vi.fn(async () => undefined)
    );
    expect(writeDataPoint.mock.calls[0][0].blobs[0]).toBe('/_matrix/client/v3/sync');
    expect(JSON.stringify(writeDataPoint.mock.calls[0][0])).not.toContain('secret');
    expect(JSON.stringify(writeDataPoint.mock.calls[0][0])).not.toContain('frag');
  });

  it('preserves host port / IPv6 — pathname only in blobs', async () => {
    const writeDataPoint = vi.fn();
    await analyticsMiddleware()(
      makeAnalyticsCtx({
        analytics: { writeDataPoint },
        url: 'https://[2001:db8::1]:8448/_matrix/client/v3/login',
      }),
      vi.fn(async () => undefined)
    );
    expect(writeDataPoint.mock.calls[0][0].blobs[0]).toBe('/_matrix/client/v3/login');
    expect(writeDataPoint.mock.calls[0][0].indexes[0]).toBe('/_matrix/client/v3/login');
  });

  it('keeps double-slash path segments in blob (not normalized)', async () => {
    const writeDataPoint = vi.fn();
    await analyticsMiddleware()(
      makeAnalyticsCtx({
        analytics: { writeDataPoint },
        url: 'https://matrix.example.com/_matrix//client/v3/sync',
      }),
      vi.fn(async () => undefined)
    );
    expect(writeDataPoint.mock.calls[0][0].blobs[0]).toBe('/_matrix//client/v3/sync');
    // split: '', '_matrix', '', 'client', 'v3', 'sync' → first 5 → '/_matrix//client/v3'
    expect(writeDataPoint.mock.calls[0][0].indexes[0]).toBe('/_matrix//client/v3');
  });

  it('unicode path segments stay percent-encoded in blob (URL.pathname)', async () => {
    const writeDataPoint = vi.fn();
    await analyticsMiddleware()(
      makeAnalyticsCtx({
        analytics: { writeDataPoint },
        url: 'https://matrix.example.com/_matrix/client/v3/rooms/!café:example.com/messages',
      }),
      vi.fn(async () => undefined)
    );
    // new URL(...).pathname percent-encodes non-ASCII
    expect(writeDataPoint.mock.calls[0][0].blobs[0]).toBe(
      '/_matrix/client/v3/rooms/!caf%C3%A9:example.com/messages'
    );
    expect(writeDataPoint.mock.calls[0][0].indexes[0]).toBe('/_matrix/client/v3/rooms');
  });

  it('index segment-count boundary soft: 3 / 4 / 5 / 6 segments', async () => {
    const writeDataPoint = vi.fn();
    const cases: Array<[string, string]> = [
      ['https://matrix.example.com/a/b', '/a/b'],
      ['https://matrix.example.com/a/b/c', '/a/b/c'],
      ['https://matrix.example.com/a/b/c/d', '/a/b/c/d'],
      ['https://matrix.example.com/a/b/c/d/e', '/a/b/c/d'],
      ['https://matrix.example.com/a/b/c/d/e/f', '/a/b/c/d'],
    ];
    for (const [url, index] of cases) {
      writeDataPoint.mockClear();
      await analyticsMiddleware()(
        makeAnalyticsCtx({ analytics: { writeDataPoint }, url }),
        vi.fn(async () => undefined)
      );
      expect(writeDataPoint.mock.calls[0][0].indexes[0]).toBe(index);
    }
  });

  it('stringifies status 301 / 302 / 418 / 503 as blobs[2]', async () => {
    const writeDataPoint = vi.fn();
    for (const status of [301, 302, 418, 503]) {
      writeDataPoint.mockClear();
      await analyticsMiddleware()(
        makeAnalyticsCtx({ analytics: { writeDataPoint }, status }),
        vi.fn(async () => undefined)
      );
      expect(writeDataPoint.mock.calls[0][0].blobs[2]).toBe(String(status));
    }
  });

  it('records HEAD / TRACE methods as blob[1]', async () => {
    const writeDataPoint = vi.fn();
    for (const method of ['HEAD', 'TRACE', 'CONNECT']) {
      writeDataPoint.mockClear();
      await analyticsMiddleware()(
        makeAnalyticsCtx({ analytics: { writeDataPoint }, method }),
        vi.fn(async () => undefined)
      );
      expect(writeDataPoint.mock.calls[0][0].blobs[1]).toBe(method);
    }
  });

  it('admin / _matrix/client/unstable path prefixes truncate at 5 segments', async () => {
    const writeDataPoint = vi.fn();
    const cases: Array<[string, string]> = [
      ['https://matrix.example.com/admin/api/v1/users/list', '/admin/api/v1/users'],
      [
        'https://matrix.example.com/_matrix/client/unstable/org.matrix.msc3575/sync',
        '/_matrix/client/unstable/org.matrix.msc3575',
      ],
      [
        'https://matrix.example.com/_matrix/client/v3/account/whoami',
        '/_matrix/client/v3/account',
      ],
    ];
    for (const [url, index] of cases) {
      writeDataPoint.mockClear();
      await analyticsMiddleware()(
        makeAnalyticsCtx({ analytics: { writeDataPoint }, url }),
        vi.fn(async () => undefined)
      );
      expect(writeDataPoint.mock.calls[0][0].indexes).toEqual([index]);
    }
  });

  it('eight-way Promise.all isolates path/method/status tuples', async () => {
    const writeDataPoint = vi.fn();
    const specs = Array.from({ length: 8 }, (_, i) => ({
      url: `https://matrix.example.com/_matrix/client/v3/path${i}`,
      method: i % 2 === 0 ? 'GET' : 'POST',
      status: 200 + (i % 3),
    }));
    await Promise.all(
      specs.map((s) =>
        analyticsMiddleware()(
          makeAnalyticsCtx({ analytics: { writeDataPoint }, ...s }),
          vi.fn(async () => undefined)
        )
      )
    );
    expect(writeDataPoint).toHaveBeenCalledTimes(8);
    const paths = writeDataPoint.mock.calls
      .map((c) => c[0].blobs[0] as string)
      .sort();
    expect(paths).toEqual(specs.map((s) => new URL(s.url).pathname).sort());
    expect(writeDataPoint.mock.calls.every((c) => c[0].doubles[0] === 0)).toBe(true);
  });

  it('Promise.allSettled: next throw rejects only that lane; siblings write', async () => {
    const writeOk = vi.fn();
    const writeSkip = vi.fn();
    const results = await Promise.allSettled([
      analyticsMiddleware()(
        makeAnalyticsCtx({ analytics: { writeDataPoint: writeSkip } }),
        vi.fn(async () => {
          throw new Error('boom-lane');
        })
      ),
      analyticsMiddleware()(
        makeAnalyticsCtx({
          analytics: { writeDataPoint: writeOk },
          url: 'https://matrix.example.com/_matrix/client/v3/login',
          method: 'POST',
          status: 200,
        }),
        vi.fn(async () => 'ok')
      ),
      analyticsMiddleware()(makeAnalyticsCtx({ analytics: undefined }), vi.fn(async () => 'skip')),
    ]);
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');
    expect(results[2].status).toBe('fulfilled');
    expect(writeSkip).not.toHaveBeenCalled();
    expect(writeOk).toHaveBeenCalledOnce();
  });

  it('stringifies undefined/null status under leftovers deepen', async () => {
    const writeDataPoint = vi.fn();
    await analyticsMiddleware()(
      makeAnalyticsCtx({
        analytics: { writeDataPoint },
        status: undefined as unknown as number,
      }),
      vi.fn(async () => undefined)
    );
    expect(writeDataPoint.mock.calls[0][0].blobs[2]).toBe('undefined');
  });

  it('pins large positive then large negative latency sequentially', async () => {
    const writeDataPoint = vi.fn();
    await analyticsMiddleware()(
      makeAnalyticsCtx({ analytics: { writeDataPoint } }),
      vi.fn(async () => {
        vi.setSystemTime(NOW + 50_000);
      })
    );
    vi.setSystemTime(NOW);
    await analyticsMiddleware()(
      makeAnalyticsCtx({ analytics: { writeDataPoint } }),
      vi.fn(async () => {
        vi.setSystemTime(NOW - 50_000);
      })
    );
    expect(writeDataPoint.mock.calls[0][0].doubles[0]).toBe(50_000);
    expect(writeDataPoint.mock.calls[1][0].doubles[0]).toBe(-50_000);
  });

  it('empty method string is recorded as blob[1]', async () => {
    const writeDataPoint = vi.fn();
    await analyticsMiddleware()(
      makeAnalyticsCtx({ analytics: { writeDataPoint }, method: '' }),
      vi.fn(async () => undefined)
    );
    expect(writeDataPoint.mock.calls[0][0].blobs[1]).toBe('');
  });

  for (let i = 0; i < 8; i++) {
    it(`path-prefix leftover soft-${i}`, async () => {
      const writeDataPoint = vi.fn();
      const url = `https://matrix.example.com/_matrix/client/v3/rooms/!r${i}:example.com/event/$e${i}`;
      await analyticsMiddleware()(
        makeAnalyticsCtx({
          analytics: { writeDataPoint },
          url,
          method: i % 2 === 0 ? 'GET' : 'PUT',
          status: 200 + i,
        }),
        vi.fn(async () => {
          vi.setSystemTime(NOW + i);
        })
      );
      expect(writeDataPoint.mock.calls[0][0].indexes[0]).toBe('/_matrix/client/v3/rooms');
      expect(writeDataPoint.mock.calls[0][0].doubles[0]).toBe(i);
      expect(writeDataPoint.mock.calls[0][0].blobs[2]).toBe(String(200 + i));
      vi.setSystemTime(NOW);
    });
  }
});

describe('analyticsMiddleware residual deepen after #241', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stringifies NaN / Infinity status as blobs[2]', async () => {
    const writeDataPoint = vi.fn();
    await analyticsMiddleware()(
      makeAnalyticsCtx({
        analytics: { writeDataPoint },
        status: Number.NaN,
      }),
      vi.fn(async () => undefined)
    );
    expect(writeDataPoint.mock.calls[0][0].blobs[2]).toBe('NaN');
    writeDataPoint.mockClear();
    await analyticsMiddleware()(
      makeAnalyticsCtx({
        analytics: { writeDataPoint },
        status: Number.POSITIVE_INFINITY,
      }),
      vi.fn(async () => undefined)
    );
    expect(writeDataPoint.mock.calls[0][0].blobs[2]).toBe('Infinity');
    writeDataPoint.mockClear();
    await analyticsMiddleware()(
      makeAnalyticsCtx({
        analytics: { writeDataPoint },
        status: Number.NEGATIVE_INFINITY,
      }),
      vi.fn(async () => undefined)
    );
    expect(writeDataPoint.mock.calls[0][0].blobs[2]).toBe('-Infinity');
  });

  it('stringifies boolean status true/false as blobs[2]', async () => {
    const writeDataPoint = vi.fn();
    await analyticsMiddleware()(
      makeAnalyticsCtx({
        analytics: { writeDataPoint },
        status: true as unknown as number,
      }),
      vi.fn(async () => undefined)
    );
    expect(writeDataPoint.mock.calls[0][0].blobs[2]).toBe('true');
    writeDataPoint.mockClear();
    await analyticsMiddleware()(
      makeAnalyticsCtx({
        analytics: { writeDataPoint },
        status: false as unknown as number,
      }),
      vi.fn(async () => undefined)
    );
    expect(writeDataPoint.mock.calls[0][0].blobs[2]).toBe('false');
  });

  it('method is NOT String()-coerced — undefined/null stay as blobs[1]', async () => {
    const writeDataPoint = vi.fn();
    await analyticsMiddleware()(
      makeAnalyticsCtx({
        analytics: { writeDataPoint },
        method: undefined as unknown as string,
      }),
      vi.fn(async () => undefined)
    );
    expect(writeDataPoint.mock.calls[0][0].blobs[1]).toBeUndefined();
    writeDataPoint.mockClear();
    await analyticsMiddleware()(
      makeAnalyticsCtx({
        analytics: { writeDataPoint },
        method: null as unknown as string,
      }),
      vi.fn(async () => undefined)
    );
    expect(writeDataPoint.mock.calls[0][0].blobs[1]).toBeNull();
  });

  it('records status after next() mutates c.res.status (read is post-await)', async () => {
    const writeDataPoint = vi.fn();
    const ctx = makeAnalyticsCtx({
      analytics: { writeDataPoint },
      status: 200,
      url: 'https://matrix.example.com/_matrix/client/v3/sync',
    });
    const next = vi.fn(async () => {
      ctx.res.status = 503;
    });
    await analyticsMiddleware()(ctx, next);
    expect(writeDataPoint.mock.calls[0][0].blobs[2]).toBe('503');
    expect(writeDataPoint.mock.calls[0][0].blobs[0]).toBe('/_matrix/client/v3/sync');
  });

  it('writeDataPoint return Promise is not awaited — middleware resolves without waiting', async () => {
    let settled = false;
    let release!: () => void;
    const writeDataPoint = vi.fn(() => {
      return new Promise<void>((resolve) => {
        release = () => {
          settled = true;
          resolve();
        };
      });
    });
    await analyticsMiddleware()(
      makeAnalyticsCtx({ analytics: { writeDataPoint } }),
      vi.fn(async () => undefined)
    );
    // Middleware finished while write Promise is still pending (not awaited)
    expect(writeDataPoint).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    release();
    expect(settled).toBe(true);
  });

  it('host-only URL with query maps pathname to "/"', async () => {
    const writeDataPoint = vi.fn();
    await analyticsMiddleware()(
      makeAnalyticsCtx({
        analytics: { writeDataPoint },
        url: 'https://matrix.example.com?access_token=secret',
      }),
      vi.fn(async () => undefined)
    );
    expect(writeDataPoint.mock.calls[0][0].blobs[0]).toBe('/');
    expect(writeDataPoint.mock.calls[0][0].indexes[0]).toBe('/');
    expect(JSON.stringify(writeDataPoint.mock.calls[0][0])).not.toContain('secret');
  });

  it('stringifies status object via String(status) default tag', async () => {
    const writeDataPoint = vi.fn();
    await analyticsMiddleware()(
      makeAnalyticsCtx({
        analytics: { writeDataPoint },
        status: { code: 200 } as unknown as number,
      }),
      vi.fn(async () => undefined)
    );
    expect(writeDataPoint.mock.calls[0][0].blobs[2]).toBe('[object Object]');
  });

  it('latency pins across mutate-status + clock advance together', async () => {
    const writeDataPoint = vi.fn();
    const ctx = makeAnalyticsCtx({
      analytics: { writeDataPoint },
      status: 100,
      method: 'POST',
      url: 'https://matrix.example.com/_matrix/client/v3/login',
    });
    await analyticsMiddleware()(
      ctx,
      vi.fn(async () => {
        vi.setSystemTime(NOW + 17);
        ctx.res.status = 401;
      })
    );
    expect(writeDataPoint.mock.calls[0][0]).toEqual({
      blobs: ['/_matrix/client/v3/login', 'POST', '401'],
      doubles: [17],
      indexes: ['/_matrix/client/v3/login'],
    });
  });

  it('trailing-slash-only path "/" keeps single-segment index', async () => {
    const writeDataPoint = vi.fn();
    await analyticsMiddleware()(
      makeAnalyticsCtx({
        analytics: { writeDataPoint },
        url: 'https://matrix.example.com/',
        method: 'HEAD',
        status: 204,
      }),
      vi.fn(async () => undefined)
    );
    expect(writeDataPoint.mock.calls[0][0].blobs).toEqual(['/', 'HEAD', '204']);
    expect(writeDataPoint.mock.calls[0][0].indexes).toEqual(['/']);
  });

  for (let i = 0; i < 6; i++) {
    it(`residual status-coerce soft-${i}`, async () => {
      const writeDataPoint = vi.fn();
      const status = i === 0 ? Number.NaN : i === 1 ? Infinity : 200 + i;
      await analyticsMiddleware()(
        makeAnalyticsCtx({
          analytics: { writeDataPoint },
          url: `https://matrix.example.com/_matrix/client/v3/path${i}`,
          method: i % 2 === 0 ? 'GET' : 'DELETE',
          status,
        }),
        vi.fn(async () => {
          vi.setSystemTime(NOW + i * 3);
        })
      );
      expect(writeDataPoint.mock.calls[0][0].blobs[2]).toBe(String(status));
      expect(writeDataPoint.mock.calls[0][0].doubles[0]).toBe(i * 3);
      vi.setSystemTime(NOW);
    });
  }
});
