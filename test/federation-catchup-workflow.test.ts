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

function mockStep() {
  const names: string[] = [];
  return {
    names,
    async do(name: string, optsOrFn: unknown, maybeFn?: unknown) {
      names.push(name);
      const fn = typeof optsOrFn === 'function' ? optsOrFn : maybeFn;
      return (fn as () => Promise<unknown>)();
    },
  };
}

function createCatchupEnv(latestByRoom: Record<string, string | null>) {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                if (sql.includes('FROM events') && sql.includes('ORDER BY stream_ordering')) {
                  const roomId = args[0] as string;
                  const id = latestByRoom[roomId];
                  if (!id) return null;
                  return { event_id: id } as T;
                }
                return null;
              },
            };
          },
        };
      },
    },
  } as unknown as { DB: D1Database };
}

describe('FederationCatchupWorkflow reachability/backfill edge paths after #65', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('unreachable server (version !ok) → success false, no backfill steps', async () => {
    fetchMock.mockResolvedValueOnce(new Response('down', { status: 503 }));
    const env = createCatchupEnv({});
    const step = mockStep();
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    const result = await wf.run(
      {
        payload: { serverName: 'remote.example', roomIds: ['!a:example.com'] },
      } as any,
      step as any
    );
    expect(result).toEqual({
      serverName: 'remote.example',
      backfilledEvents: 0,
      success: false,
      error: 'Server not reachable',
    });
    expect(step.names).toEqual(['check-server']);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://remote.example/_matrix/federation/v1/version',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('version fetch throw → unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('dns'));
    const env = createCatchupEnv({});
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { serverName: 'remote.example', roomIds: [] } } as any,
      mockStep() as any
    );
    expect(result).toMatchObject({ success: false, error: 'Server not reachable' });
  });

  it('missing latest event for room → 0; aggregates successful backfills across rooms', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 })) // version
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ events: [{}, {}, {}] }), { status: 200 })
      ) // room a
      .mockResolvedValueOnce(new Response('nope', { status: 404 })); // room c

    const env = createCatchupEnv({
      '!a:example.com': '$latest-a',
      '!b:example.com': null,
      '!c:example.com': '$latest-c',
    });
    const step = mockStep();
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    const result = await wf.run(
      {
        payload: {
          serverName: 'remote.example',
          roomIds: ['!a:example.com', '!b:example.com', '!c:example.com'],
        },
      } as any,
      step as any
    );

    expect(result).toEqual({
      serverName: 'remote.example',
      backfilledEvents: 3,
      success: true,
    });
    expect(step.names).toEqual([
      'check-server',
      'backfill-!a:example.com',
      'backfill-!b:example.com',
      'backfill-!c:example.com',
    ]);

    const backfillCall = fetchMock.mock.calls[1];
    expect(backfillCall[0]).toBe(
      `https://remote.example/_matrix/federation/v1/get_missing_events/${encodeURIComponent('!a:example.com')}`
    );
    const init = backfillCall[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      limit: 100,
      earliest_events: ['$latest-a'],
      latest_events: [],
    });
  });

  it('get_missing_events throw / missing events array → counts as 0', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    const env = createCatchupEnv({
      '!a:example.com': '$a',
      '!b:example.com': '$b',
    });
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    const result = await wf.run(
      {
        payload: {
          serverName: 'remote.example',
          roomIds: ['!a:example.com', '!b:example.com'],
        },
      } as any,
      mockStep() as any
    );
    expect(result).toEqual({
      serverName: 'remote.example',
      backfilledEvents: 0,
      success: true,
    });
  });

  it('empty roomIds after reachable check → success with 0 backfilled', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const env = createCatchupEnv({});
    const step = mockStep();
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { serverName: 'remote.example', roomIds: [] } } as any,
      step as any
    );
    expect(result).toEqual({
      serverName: 'remote.example',
      backfilledEvents: 0,
      success: true,
    });
    expect(step.names).toEqual(['check-server']);
  });
});
