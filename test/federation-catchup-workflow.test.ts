import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

import { FederationCatchupWorkflow } from '../src/workflows/FederationCatchupWorkflow';

function createCatchupEnv(opts: { latestByRoom?: Record<string, string | null> }) {
  const latestByRoom = { ...(opts.latestByRoom ?? {}) };
  const queries: Array<{ sql: string; args: unknown[] }> = [];

  const env = {
    queries,
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            queries.push({ sql, args });
            return {
              async first<T>() {
                if (
                  sql.includes('FROM events') &&
                  sql.includes('ORDER BY stream_ordering DESC')
                ) {
                  const [roomId] = args as [string];
                  const eventId = latestByRoom[roomId];
                  if (!eventId) return null;
                  return { event_id: eventId } as T;
                }
                return null;
              },
            };
          },
        };
      },
    },
  };

  return env as unknown as {
    DB: D1Database;
    queries: typeof queries;
  };
}

function mockStep() {
  const names: string[] = [];
  return {
    names,
    async do(name: string, fn: () => Promise<unknown>) {
      names.push(name);
      return fn();
    },
  };
}

describe('FederationCatchupWorkflow', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns success:false when version check is non-OK', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/_matrix/federation/v1/version')) {
        return new Response('down', { status: 502 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const env = createCatchupEnv({ latestByRoom: { '!r:ex': '$e' } });
    const step = mockStep();
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { serverName: 'remote.ex', roomIds: ['!r:ex'] } } as any,
      step as any
    );

    expect(result).toEqual({
      serverName: 'remote.ex',
      backfilledEvents: 0,
      success: false,
      error: 'Server not reachable',
    });
    expect(step.names).toEqual(['check-server']);
    expect(env.queries).toHaveLength(0);
  });

  it('returns success:false when version fetch throws (timeout/network)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as typeof fetch;

    const env = createCatchupEnv({});
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { serverName: 'offline.ex', roomIds: ['!a:ex'] } } as any,
      mockStep() as any
    );

    expect(result).toEqual({
      serverName: 'offline.ex',
      backfilledEvents: 0,
      success: false,
      error: 'Server not reachable',
    });
  });

  it('backfills 0 when roomIds is empty but server is reachable', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/version')) {
        return new Response(JSON.stringify({ server: {} }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const env = createCatchupEnv({});
    const step = mockStep();
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { serverName: 'peer.ex', roomIds: [] } } as any,
      step as any
    );

    expect(result).toEqual({
      serverName: 'peer.ex',
      backfilledEvents: 0,
      success: true,
    });
    expect(step.names).toEqual(['check-server']);
  });

  it('returns 0 for a room with no latest event (null first())', async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/version')) {
        return new Response('{}', { status: 200 });
      }
      if (url.includes('/get_missing_events/')) {
        posts.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
        return new Response(JSON.stringify({ events: [{}, {}] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const env = createCatchupEnv({ latestByRoom: { '!empty:ex': null } });
    const step = mockStep();
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { serverName: 'peer.ex', roomIds: ['!empty:ex'] } } as any,
      step as any
    );

    expect(result).toEqual({
      serverName: 'peer.ex',
      backfilledEvents: 0,
      success: true,
    });
    expect(posts).toHaveLength(0);
    expect(step.names).toEqual(['check-server', 'backfill-!empty:ex']);
  });

  it('sums events across rooms; encodes roomId in path; posts earliest_events', async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/version')) {
        return new Response('{}', { status: 200 });
      }
      if (url.includes('/get_missing_events/')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<
          string,
          unknown
        >;
        posts.push({ url, body });
        const earliest = body.earliest_events as string[];
        const count = earliest[0] === '$a' ? 3 : earliest[0] === '$b' ? 2 : 0;
        return new Response(JSON.stringify({ events: Array(count).fill({}) }), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const env = createCatchupEnv({
      latestByRoom: {
        '!a:ex': '$a',
        '!b:ex': '$b',
      },
    });
    const step = mockStep();
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    const result = await wf.run(
      {
        payload: {
          serverName: 'peer.ex',
          roomIds: ['!a:ex', '!b:ex'],
        },
      } as any,
      step as any
    );

    expect(result).toEqual({
      serverName: 'peer.ex',
      backfilledEvents: 5,
      success: true,
    });
    expect(step.names).toEqual([
      'check-server',
      'backfill-!a:ex',
      'backfill-!b:ex',
    ]);
    expect(posts[0].url).toBe(
      `https://peer.ex/_matrix/federation/v1/get_missing_events/${encodeURIComponent('!a:ex')}`
    );
    expect(posts[0].body).toEqual({
      limit: 100,
      earliest_events: ['$a'],
      latest_events: [],
    });
    expect(posts[1].body).toEqual({
      limit: 100,
      earliest_events: ['$b'],
      latest_events: [],
    });
  });

  it('treats missing events array / non-OK / thrown fetch as 0 per room', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/version')) {
        return new Response('{}', { status: 200 });
      }
      if (url.includes(encodeURIComponent('!ok:ex'))) {
        return new Response(JSON.stringify({ events: [{}, {}] }), { status: 200 });
      }
      if (url.includes(encodeURIComponent('!noevents:ex'))) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.includes(encodeURIComponent('!httpfail:ex'))) {
        return new Response('nope', { status: 404 });
      }
      if (url.includes(encodeURIComponent('!throw:ex'))) {
        throw new Error('timeout');
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const env = createCatchupEnv({
      latestByRoom: {
        '!ok:ex': '$1',
        '!noevents:ex': '$2',
        '!httpfail:ex': '$3',
        '!throw:ex': '$4',
      },
    });
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    const result = await wf.run(
      {
        payload: {
          serverName: 'peer.ex',
          roomIds: ['!ok:ex', '!noevents:ex', '!httpfail:ex', '!throw:ex'],
        },
      } as any,
      mockStep() as any
    );

    // only !ok:ex contributes 2; others 0
    expect(result).toEqual({
      serverName: 'peer.ex',
      backfilledEvents: 2,
      success: true,
    });
  });

  it('treats events: undefined length via || 0 when events is empty array', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/version')) {
        return new Response('{}', { status: 200 });
      }
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }) as typeof fetch;

    const env = createCatchupEnv({ latestByRoom: { '!r:ex': '$e' } });
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { serverName: 'peer.ex', roomIds: ['!r:ex'] } } as any,
      mockStep() as any
    );
    expect(result.backfilledEvents).toBe(0);
    expect(result.success).toBe(true);
  });

  it('encodes special characters in roomId path segment', async () => {
    const roomId = '!weird/room:ex';
    let captured = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/version')) {
        return new Response('{}', { status: 200 });
      }
      captured = url;
      return new Response(JSON.stringify({ events: [{}] }), { status: 200 });
    }) as typeof fetch;

    const env = createCatchupEnv({ latestByRoom: { [roomId]: '$e' } });
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    await wf.run(
      { payload: { serverName: 'peer.ex', roomIds: [roomId] } } as any,
      mockStep() as any
    );
    expect(captured).toBe(
      `https://peer.ex/_matrix/federation/v1/get_missing_events/${encodeURIComponent(roomId)}`
    );
  });
});
