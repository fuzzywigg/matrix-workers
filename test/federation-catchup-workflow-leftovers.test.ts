/**
 * TOKENMAXX HEAVY leftovers after #170/#171 — FederationCatchupWorkflow soft/edge/reliability.
 * Complements federation-catchup-workflow.test.ts (not federation HTTP leftovers).
 * Focus: version reachability status soft floods, get_missing_events status/empty/
 * length matrices, multi-room aggregation soft floods, URL encoding, AbortSignal
 * timeout wiring, and serverName URL construction.
 * Tests-only — no product inventing. Fixtures use example.com / remote.example.com only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

import { FederationCatchupWorkflow } from '../src/workflows/FederationCatchupWorkflow';

const REMOTE = 'remote.example.com';

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

const VERSION_FAIL_STATUSES = [400, 401, 403, 404, 429, 500, 502, 503, 504] as const;
const BACKFILL_FAIL_STATUSES = [400, 403, 404, 408, 429, 500, 502, 503] as const;

describe('federation-catchup leftovers version reachability soft flood after #171', () => {
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

  for (const status of VERSION_FAIL_STATUSES) {
    it(`version HTTP ${status} → unreachable, no backfill`, async () => {
      fetchMock.mockResolvedValueOnce(new Response('down', { status }));
      const env = createCatchupEnv({ '!a:example.com': '$a' });
      const step = mockStep();
      const wf = new FederationCatchupWorkflow({} as any, env as any);
      const result = await wf.run(
        {
          payload: { serverName: REMOTE, roomIds: ['!a:example.com'] },
        } as any,
        step as any
      );
      expect(result).toEqual({
        serverName: REMOTE,
        backfilledEvents: 0,
        success: false,
        error: 'Server not reachable',
      });
      expect(step.names).toEqual(['check-server']);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(
        `https://${REMOTE}/_matrix/federation/v1/version`
      );
    });
  }

  it('version throw soft flood → unreachable', async () => {
    for (const err of [new Error('dns'), new Error('timeout'), 'string-fail', null]) {
      fetchMock.mockReset();
      fetchMock.mockRejectedValueOnce(err);
      const env = createCatchupEnv({});
      const wf = new FederationCatchupWorkflow({} as any, env as any);
      const result = await wf.run(
        { payload: { serverName: REMOTE, roomIds: ['!a:example.com'] } } as any,
        mockStep() as any
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe('Server not reachable');
    }
  });

  it('version 200 soft flood proceeds to backfill', async () => {
    for (let i = 0; i < 5; i++) {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ events: [{}, {}] }), { status: 200 })
        );
      const env = createCatchupEnv({ '!a:example.com': '$a' });
      const wf = new FederationCatchupWorkflow({} as any, env as any);
      const result = await wf.run(
        { payload: { serverName: REMOTE, roomIds: ['!a:example.com'] } } as any,
        mockStep() as any
      );
      expect(result).toEqual({
        serverName: REMOTE,
        backfilledEvents: 2,
        success: true,
      });
    }
  });
});

describe('federation-catchup leftovers get_missing_events status/empty soft flood after #171', () => {
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

  for (const status of BACKFILL_FAIL_STATUSES) {
    it(`get_missing_events HTTP ${status} → counts 0, overall success`, async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(new Response('nope', { status }));
      const env = createCatchupEnv({ '!a:example.com': '$a' });
      const wf = new FederationCatchupWorkflow({} as any, env as any);
      const result = await wf.run(
        { payload: { serverName: REMOTE, roomIds: ['!a:example.com'] } } as any,
        mockStep() as any
      );
      expect(result).toEqual({
        serverName: REMOTE,
        backfilledEvents: 0,
        success: true,
      });
    });
  }

  it('events payload soft flood: missing/null/empty → 0; string length counted as-is', async () => {
    const zeroCases = [{}, { events: null }, { events: [] }, { events: undefined }, { events: 5 }];
    for (const payload of zeroCases) {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));
      const env = createCatchupEnv({ '!a:example.com': '$a' });
      const wf = new FederationCatchupWorkflow({} as any, env as any);
      const result = await wf.run(
        { payload: { serverName: REMOTE, roomIds: ['!a:example.com'] } } as any,
        mockStep() as any
      );
      expect(result.backfilledEvents).toBe(0);
      expect(result.success).toBe(true);
    }

    // Current implementation uses events?.length — string "nope" has length 4
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ events: 'nope' }), { status: 200 })
      );
    const env = createCatchupEnv({ '!a:example.com': '$a' });
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { serverName: REMOTE, roomIds: ['!a:example.com'] } } as any,
      mockStep() as any
    );
    expect(result.backfilledEvents).toBe(4);
  });

  it('events length soft flood aggregates exact counts', async () => {
    for (const n of [1, 2, 5, 10, 50, 100]) {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ events: Array.from({ length: n }, () => ({})) }), {
            status: 200,
          })
        );
      const env = createCatchupEnv({ '!a:example.com': '$a' });
      const wf = new FederationCatchupWorkflow({} as any, env as any);
      const result = await wf.run(
        { payload: { serverName: REMOTE, roomIds: ['!a:example.com'] } } as any,
        mockStep() as any
      );
      expect(result.backfilledEvents).toBe(n);
    }
  });

  it('get_missing_events throw soft flood → 0', async () => {
    for (const err of [new Error('timeout'), new Error('reset'), 'x']) {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockRejectedValueOnce(err);
      const env = createCatchupEnv({ '!a:example.com': '$a' });
      const wf = new FederationCatchupWorkflow({} as any, env as any);
      const result = await wf.run(
        { payload: { serverName: REMOTE, roomIds: ['!a:example.com'] } } as any,
        mockStep() as any
      );
      expect(result).toEqual({
        serverName: REMOTE,
        backfilledEvents: 0,
        success: true,
      });
    }
  });
});

describe('federation-catchup leftovers multi-room aggregation soft flood after #171', () => {
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

  it('aggregates mixed missing/fail/success rooms soft flood', async () => {
    const roomIds = Array.from({ length: 8 }, (_, i) => `!r${i}:example.com`);
    const latest: Record<string, string | null> = {};
    for (let i = 0; i < roomIds.length; i++) {
      latest[roomIds[i]] = i === 2 || i === 5 ? null : `$e${i}`;
    }

    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 })); // version
    // rooms with latest: 0,1,3,4,6,7 → 6 backfill calls
    // pattern: success 3, fail 404, success 1, throw, success 2, empty
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ events: [{}, {}, {}] }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response('no', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ events: [{}] }), { status: 200 }))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ events: [{}, {}] }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ events: [] }), { status: 200 }));

    const env = createCatchupEnv(latest);
    const step = mockStep();
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { serverName: REMOTE, roomIds } } as any,
      step as any
    );
    expect(result.success).toBe(true);
    expect(result.backfilledEvents).toBe(3 + 1 + 2);
    expect(step.names[0]).toBe('check-server');
    for (const roomId of roomIds) {
      expect(step.names).toContain(`backfill-${roomId}`);
    }
  });

  it('empty roomIds soft flood still checks server', async () => {
    for (const serverName of [REMOTE, 'peer.example.com', 'matrix.example.com']) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const env = createCatchupEnv({});
      const step = mockStep();
      const wf = new FederationCatchupWorkflow({} as any, env as any);
      const result = await wf.run(
        { payload: { serverName, roomIds: [] } } as any,
        step as any
      );
      expect(result).toEqual({
        serverName,
        backfilledEvents: 0,
        success: true,
      });
      expect(step.names).toEqual(['check-server']);
      expect(fetchMock.mock.calls[0][0]).toBe(
        `https://${serverName}/_matrix/federation/v1/version`
      );
    }
  });

  it('many rooms all-zero soft flood', async () => {
    const roomIds = Array.from({ length: 20 }, (_, i) => `!z${i}:example.com`);
    const latest = Object.fromEntries(roomIds.map((r) => [r, `$l-${r}`]));
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    for (let i = 0; i < 20; i++) {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ events: [] }), { status: 200 })
      );
    }
    const env = createCatchupEnv(latest);
    const step = mockStep();
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { serverName: REMOTE, roomIds } } as any,
      step as any
    );
    expect(result.backfilledEvents).toBe(0);
    expect(result.success).toBe(true);
    expect(step.names).toHaveLength(21);
  });

  it('many rooms uniform count soft flood', async () => {
    const roomIds = Array.from({ length: 10 }, (_, i) => `!u${i}:example.com`);
    const latest = Object.fromEntries(roomIds.map((r) => [r, `$l-${r}`]));
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    for (let i = 0; i < 10; i++) {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ events: [{}, {}, {}, {}] }), { status: 200 })
      );
    }
    const env = createCatchupEnv(latest);
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { serverName: REMOTE, roomIds } } as any,
      mockStep() as any
    );
    expect(result.backfilledEvents).toBe(40);
  });
});

describe('federation-catchup leftovers URL encoding / timeout / body soft flood after #171', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let timeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('encodes reserved room id characters soft flood', async () => {
    const rooms = [
      '!a:example.com',
      '!a/b:example.com',
      '!a b:example.com',
      '!a#b:example.com',
      '!a+b:example.com',
      '!a&b:example.com',
    ];
    for (const roomId of rooms) {
      fetchMock.mockReset();
      timeoutSpy.mockClear();
      fetchMock
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ events: [{}] }), { status: 200 }));
      const env = createCatchupEnv({ [roomId]: '$x' });
      const wf = new FederationCatchupWorkflow({} as any, env as any);
      await wf.run(
        { payload: { serverName: REMOTE, roomIds: [roomId] } } as any,
        mockStep() as any
      );
      expect(fetchMock.mock.calls[1][0]).toBe(
        `https://${REMOTE}/_matrix/federation/v1/get_missing_events/${encodeURIComponent(roomId)}`
      );
    }
  });

  it('POST body soft flood pins limit/earliest/latest shape', async () => {
    const eventIds = ['$a', '$b:example.com', '$long-event-id-xyz'];
    for (const eventId of eventIds) {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ events: [] }), { status: 200 }));
      const env = createCatchupEnv({ '!r:example.com': eventId });
      const wf = new FederationCatchupWorkflow({} as any, env as any);
      await wf.run(
        { payload: { serverName: REMOTE, roomIds: ['!r:example.com'] } } as any,
        mockStep() as any
      );
      const init = fetchMock.mock.calls[1][1] as RequestInit;
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(JSON.parse(init.body as string)).toEqual({
        limit: 100,
        earliest_events: [eventId],
        latest_events: [],
      });
    }
  });

  it('AbortSignal.timeout wiring soft flood: 10s version + 30s per room', async () => {
    const roomIds = ['!a:example.com', '!b:example.com', '!c:example.com'];
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    for (let i = 0; i < 3; i++) {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ events: [] }), { status: 200 })
      );
    }
    const env = createCatchupEnv({
      '!a:example.com': '$a',
      '!b:example.com': '$b',
      '!c:example.com': '$c',
    });
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    await wf.run({ payload: { serverName: REMOTE, roomIds } } as any, mockStep() as any);
    expect(timeoutSpy.mock.calls.filter((c) => c[0] === 10_000)).toHaveLength(1);
    expect(timeoutSpy.mock.calls.filter((c) => c[0] === 30_000)).toHaveLength(3);
  });

  it('missing latest event short-circuits without fetch soft flood', async () => {
    const roomIds = Array.from({ length: 5 }, (_, i) => `!m${i}:example.com`);
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const env = createCatchupEnv(Object.fromEntries(roomIds.map((r) => [r, null])));
    const step = mockStep();
    const wf = new FederationCatchupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { serverName: REMOTE, roomIds } } as any,
      step as any
    );
    expect(result.backfilledEvents).toBe(0);
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // version only
    expect(step.names).toHaveLength(6);
  });

  it('serverName soft flood builds https URLs', async () => {
    for (const serverName of [
      'remote.example.com',
      'peer.example.com',
      'fed.example.com',
    ]) {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ events: [{}] }), { status: 200 }));
      const env = createCatchupEnv({ '!r:example.com': '$e' });
      const wf = new FederationCatchupWorkflow({} as any, env as any);
      const result = await wf.run(
        { payload: { serverName, roomIds: ['!r:example.com'] } } as any,
        mockStep() as any
      );
      expect(result.serverName).toBe(serverName);
      expect(fetchMock.mock.calls[0][0]).toBe(
        `https://${serverName}/_matrix/federation/v1/version`
      );
      expect(String(fetchMock.mock.calls[1][0])).toContain(`https://${serverName}/`);
    }
  });
});
