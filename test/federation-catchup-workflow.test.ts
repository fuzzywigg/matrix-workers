import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

import { FederationCatchupWorkflow } from '../src/workflows/FederationCatchupWorkflow';

function createCatchupEnv(opts: {
  latestByRoom?: Record<string, string | null>;
}) {
  const sqlLog: { sql: string; args: unknown[] }[] = [];
  const env = {
    sqlLog,
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                sqlLog.push({ sql, args });
                if (sql.includes('FROM events') && sql.includes('stream_ordering DESC')) {
                  const roomId = args[0] as string;
                  const id = opts.latestByRoom?.[roomId];
                  if (id === null || id === undefined) return null as T;
                  return { event_id: id } as T;
                }
                return null as T;
              },
            };
          },
        };
      },
    },
  };
  return env;
}

function mockStep(recordNames?: string[]) {
  return {
    async do(name: string, a: unknown, b?: unknown) {
      recordNames?.push(name);
      const fn = (typeof a === 'function' ? a : b) as () => Promise<unknown>;
      return fn();
    },
  };
}

describe('FederationCatchupWorkflow', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns success:false when version probe is not ok', async () => {
    fetchSpy.mockResolvedValue(new Response('down', { status: 503 }));
    const env = createCatchupEnv({});
    const names: string[] = [];
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { serverName: 'remote.example', roomIds: ['!a:ex.com'] } } as any,
      mockStep(names) as any
    );
    expect(result).toEqual({
      serverName: 'remote.example',
      backfilledEvents: 0,
      success: false,
      error: 'Server not reachable',
    });
    expect(names).toEqual(['check-server']);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://remote.example/_matrix/federation/v1/version',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('returns success:false when version probe throws', async () => {
    fetchSpy.mockRejectedValue(new Error('dns fail'));
    const env = createCatchupEnv({});
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { serverName: 'gone.example', roomIds: [] } } as any,
      mockStep() as any
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('Server not reachable');
    expect(result.backfilledEvents).toBe(0);
  });

  it('skips backfill when room has no latest event', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));
    const env = createCatchupEnv({ latestByRoom: { '!empty:ex.com': null } });
    const names: string[] = [];
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    const result = await wf.run(
      {
        payload: { serverName: 'remote.example', roomIds: ['!empty:ex.com'] },
      } as any,
      mockStep(names) as any
    );
    expect(result).toEqual({
      serverName: 'remote.example',
      backfilledEvents: 0,
      success: true,
    });
    expect(names).toContain('backfill-!empty:ex.com');
    // only version fetch
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('sums event counts across rooms on successful get_missing_events', async () => {
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/version')) return new Response('{}', { status: 200 });
      if (u.includes('get_missing_events')) {
        const room = decodeURIComponent(u.split('/').pop()!);
        const n = room.includes('r1') ? 3 : 2;
        return new Response(JSON.stringify({ events: Array(n).fill({}) }), {
          status: 200,
        });
      }
      return new Response('nope', { status: 404 });
    });

    const env = createCatchupEnv({
      latestByRoom: {
        '!r1:ex.com': '$e1',
        '!r2:ex.com': '$e2',
      },
    });
    const names: string[] = [];
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    const result = await wf.run(
      {
        payload: {
          serverName: 'remote.example',
          roomIds: ['!r1:ex.com', '!r2:ex.com'],
        },
      } as any,
      mockStep(names) as any
    );
    expect(result).toEqual({
      serverName: 'remote.example',
      backfilledEvents: 5,
      success: true,
    });
    expect(names).toEqual([
      'check-server',
      'backfill-!r1:ex.com',
      'backfill-!r2:ex.com',
    ]);

    const backfillCall = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes('get_missing_events')
    )!;
    expect(String(backfillCall[0])).toContain(
      encodeURIComponent('!r1:ex.com')
    );
    const body = JSON.parse((backfillCall[1] as RequestInit).body as string);
    expect(body).toEqual({
      limit: 100,
      earliest_events: ['$e1'],
      latest_events: [],
    });
  });

  it('returns 0 for a room when get_missing_events is not ok', async () => {
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/version')) return new Response('{}', { status: 200 });
      return new Response('err', { status: 500 });
    });
    const env = createCatchupEnv({ latestByRoom: { '!r:ex.com': '$e' } });
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { serverName: 'remote.example', roomIds: ['!r:ex.com'] } } as any,
      mockStep() as any
    );
    expect(result.success).toBe(true);
    expect(result.backfilledEvents).toBe(0);
  });

  it('returns 0 when get_missing_events throws or omits events array', async () => {
    let call = 0;
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/version')) return new Response('{}', { status: 200 });
      call++;
      if (call === 1) throw new Error('timeout');
      return new Response(JSON.stringify({}), { status: 200 }); // no events key
    });
    const env = createCatchupEnv({
      latestByRoom: { '!a:ex.com': '$a', '!b:ex.com': '$b' },
    });
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    const result = await wf.run(
      {
        payload: {
          serverName: 'remote.example',
          roomIds: ['!a:ex.com', '!b:ex.com'],
        },
      } as any,
      mockStep() as any
    );
    expect(result.backfilledEvents).toBe(0);
    expect(result.success).toBe(true);
  });

  it('handles empty roomIds after reachable check', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }));
    const env = createCatchupEnv({});
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { serverName: 'remote.example', roomIds: [] } } as any,
      mockStep() as any
    );
    expect(result).toEqual({
      serverName: 'remote.example',
      backfilledEvents: 0,
      success: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
