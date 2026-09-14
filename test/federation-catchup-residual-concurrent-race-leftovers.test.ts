/**
 * TOKENMAXX HEAVY leftovers after #241 — residual FederationCatchupWorkflow
 * edges not saturated by #171 / #187 / #231 / #237.
 *
 * Complements (does not re-flood):
 *   - federation-catchup-workflow.test.ts + leftovers (#171 serial)
 *   - federation-media-compaction-workflow-concurrent-race (#187 2xx/malformed)
 *   - federation-catchup-consumer-device-list-concurrent-race (#231)
 *   - federation-catchup-consumer-device-list-sync-concurrent-race (#237)
 *
 * Residual focus (existing behavior only):
 *   - resp.ok status boundaries (206/299 vs 3xx) for version + backfill
 *   - events length quirks: {length:N}, boolean/0, JSON non-object roots
 *   - D1 prepare/bind throw → catch 0; first() missing/null event_id POST shape
 *   - SQL SELECT shape + bind(roomId); version GET has no method/body
 *   - serverName:8448 URL construction; events.length > request limit counted
 *   - success:true omits error; TOCTOU mutate latest→null short-circuits POST
 *   - concurrent: throw∥success, object-length∥array, 301∥206, prepare-throw∥ok
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 * Reversible by deleting this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatchupParams, CatchupResult } from '../src/workflows/FederationCatchupWorkflow';

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
const PEER = 'peer.example.com';
const PORT_HOST = 'remote.example.com:8448';

type SqlCall = { sql: string; args: unknown[] };

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

function createNBarrier(n: number) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return {
    async wait() {
      arrived += 1;
      if (arrived >= n) release();
      await gate;
    },
    get arrived() {
      return arrived;
    },
  };
}

type CatchupEnvOpts = {
  latestByRoom?: Record<string, string | null | undefined>;
  throwRooms?: Set<string>;
  throwOnPrepare?: boolean;
  throwOnBind?: boolean;
  firstOverride?: Record<string, unknown | null>;
  selectBarrier?: {
    match: (sql: string, args: unknown[]) => boolean;
    count: number;
  };
  mutateLatestAfterBarrier?: Record<string, string | null>;
};

function createCatchupEnv(opts: CatchupEnvOpts = {}) {
  const waiters = { list: [] as Array<() => void> };
  let selectBarrier = opts.selectBarrier;
  const latestByRoom = { ...(opts.latestByRoom ?? {}) };
  const firstCalls: SqlCall[] = [];
  const prepareCalls: string[] = [];

  return {
    firstCalls,
    prepareCalls,
    latestByRoom,
    DB: {
      prepare(sql: string) {
        prepareCalls.push(sql);
        if (opts.throwOnPrepare) throw new Error('d1 prepare boom');
        return {
          bind(...args: unknown[]) {
            if (opts.throwOnBind) throw new Error('d1 bind boom');
            return {
              async first<T>() {
                firstCalls.push({ sql, args });
                if (
                  selectBarrier &&
                  selectBarrier.match(sql, args)
                ) {
                  await new Promise<void>((resolve) => {
                    waiters.list.push(resolve);
                    if (waiters.list.length >= (selectBarrier?.count ?? 0)) {
                      const all = [...waiters.list];
                      waiters.list = [];
                      selectBarrier = undefined;
                      if (opts.mutateLatestAfterBarrier) {
                        Object.assign(latestByRoom, opts.mutateLatestAfterBarrier);
                      }
                      for (const r of all) r();
                    }
                  });
                }
                if (sql.includes('FROM events') && sql.includes('ORDER BY stream_ordering')) {
                  const roomId = args[0] as string;
                  if (opts.throwRooms?.has(roomId)) throw new Error(`d1 boom ${roomId}`);
                  if (opts.firstOverride && Object.prototype.hasOwnProperty.call(opts.firstOverride, roomId)) {
                    return opts.firstOverride[roomId] as T;
                  }
                  const id = latestByRoom[roomId];
                  if (id === undefined || id === null) return null;
                  return { event_id: id } as T;
                }
                return null;
              },
            };
          },
        };
      },
    },
  };
}

async function runCatchup(
  env: { DB: unknown },
  serverName: string,
  roomIds: string[]
) {
  const wf = new FederationCatchupWorkflow({} as never, env as never);
  const step = mockStep();
  const result = (await wf.run(
    { payload: { serverName, roomIds } satisfies CatchupParams } as never,
    step as never
  )) as CatchupResult;
  return { result, step };
}

describe('federation-catchup residual resp.ok boundaries after #241', () => {
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

  for (const status of [206, 299] as const) {
    it(`version HTTP ${status} (resp.ok) proceeds to backfill`, async () => {
      const room = `!vok${status}:example.com`;
      fetchMock
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ events: [{}, {}] }), { status: 200 })
        );
      const { result, step } = await runCatchup(
        createCatchupEnv({ latestByRoom: { [room]: `$e${status}` } }),
        REMOTE,
        [room]
      );
      expect(result).toEqual({
        serverName: REMOTE,
        backfilledEvents: 2,
        success: true,
      });
      expect(step.names).toEqual(['check-server', `backfill-${room}`]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  }

  for (const status of [300, 301, 302, 303, 304, 307, 308] as const) {
    it(`version HTTP ${status} (!ok) → unreachable, no backfill`, async () => {
      // 304 must be body-less in the Response constructor
      fetchMock.mockResolvedValueOnce(
        status === 304
          ? new Response(null, { status })
          : new Response('redirect', { status })
      );
      const room = `!vfail${status}:example.com`;
      const { result, step } = await runCatchup(
        createCatchupEnv({ latestByRoom: { [room]: '$e' } }),
        REMOTE,
        [room]
      );
      expect(result).toEqual({
        serverName: REMOTE,
        backfilledEvents: 0,
        success: false,
        error: 'Server not reachable',
      });
      expect(step.names).toEqual(['check-server']);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }

  for (const status of [206, 299] as const) {
    it(`get_missing_events HTTP ${status} with events body is counted`, async () => {
      const room = `!bok${status}:example.com`;
      fetchMock
        .mockResolvedValueOnce(new Response('ok', { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ events: [1, 2, 3, 4] }), { status })
        );
      const { result } = await runCatchup(
        createCatchupEnv({ latestByRoom: { [room]: '$e' } }),
        REMOTE,
        [room]
      );
      expect(result.backfilledEvents).toBe(4);
      expect(result.success).toBe(true);
    });
  }

  for (const status of [300, 301, 304] as const) {
    it(`get_missing_events HTTP ${status} (!ok) counts 0, overall success`, async () => {
      const room = `!bfail${status}:example.com`;
      fetchMock
        .mockResolvedValueOnce(new Response('ok', { status: 200 }))
        .mockResolvedValueOnce(
          status === 304
            ? new Response(null, { status })
            : new Response('redir', { status })
        );
      const { result } = await runCatchup(
        createCatchupEnv({ latestByRoom: { [room]: '$e' } }),
        REMOTE,
        [room]
      );
      expect(result).toEqual({
        serverName: REMOTE,
        backfilledEvents: 0,
        success: true,
      });
    });
  }
});

describe('federation-catchup residual events length / JSON root quirks after #241', () => {
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

  it('events object with length property counted via events?.length', async () => {
    const room = '!objlen:example.com';
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ events: { length: 7 } }), { status: 200 })
      );
    const { result } = await runCatchup(
      createCatchupEnv({ latestByRoom: { [room]: '$e' } }),
      REMOTE,
      [room]
    );
    expect(result.backfilledEvents).toBe(7);
    expect(result.success).toBe(true);
  });

  it('events boolean/0 soft flood → 0', async () => {
    for (const events of [false, true, 0] as const) {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ events }), { status: 200 }));
      const { result } = await runCatchup(
        createCatchupEnv({ latestByRoom: { '!z:example.com': '$e' } }),
        REMOTE,
        ['!z:example.com']
      );
      expect(result.backfilledEvents).toBe(0);
      expect(result.success).toBe(true);
    }
  });

  it('JSON non-object roots on successful backfill → 0', async () => {
    const roots = ['[]', '[{}]', '42', '"hi"', 'true', 'false'];
    for (const body of roots) {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(new Response(body, { status: 200 }));
      const { result } = await runCatchup(
        createCatchupEnv({ latestByRoom: { '!r:example.com': '$e' } }),
        REMOTE,
        ['!r:example.com']
      );
      expect(result.backfilledEvents).toBe(0);
      expect(result.success).toBe(true);
    }
  });

  it('events array longer than request limit 100 still counted as-is', async () => {
    const room = '!over:example.com';
    const n = 150;
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ events: Array.from({ length: n }, () => ({})) }), {
          status: 200,
        })
      );
    const { result } = await runCatchup(
      createCatchupEnv({ latestByRoom: { [room]: '$e' } }),
      REMOTE,
      [room]
    );
    expect(result.backfilledEvents).toBe(150);
  });

  it('events sparse-ish array length (null holes) counted by .length', async () => {
    const room = '!holes:example.com';
    // JSON cannot encode holes; pin explicit null slots (length 3)
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ events: [null, null, null] }), { status: 200 })
      );
    const { result } = await runCatchup(
      createCatchupEnv({ latestByRoom: { [room]: '$e' } }),
      REMOTE,
      [room]
    );
    expect(result.backfilledEvents).toBe(3);
  });
});

describe('federation-catchup residual D1 prepare/bind/first shape after #241', () => {
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

  it('prepare throw zeros room; overall success', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const env = createCatchupEnv({
      latestByRoom: { '!a:example.com': '$a' },
      throwOnPrepare: true,
    });
    const { result, step } = await runCatchup(env, REMOTE, ['!a:example.com']);
    expect(result).toEqual({
      serverName: REMOTE,
      backfilledEvents: 0,
      success: true,
    });
    expect(step.names).toEqual(['check-server', 'backfill-!a:example.com']);
    expect(fetchMock).toHaveBeenCalledTimes(1); // version only
  });

  it('bind throw zeros room; overall success', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const env = createCatchupEnv({
      latestByRoom: { '!a:example.com': '$a' },
      throwOnBind: true,
    });
    const { result } = await runCatchup(env, REMOTE, ['!a:example.com']);
    expect(result.backfilledEvents).toBe(0);
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('pins SELECT event_id … ORDER BY stream_ordering DESC LIMIT 1 + bind(roomId)', async () => {
    const room = '!sql:example.com';
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ events: [] }), { status: 200 }));
    const env = createCatchupEnv({ latestByRoom: { [room]: '$sql' } });
    await runCatchup(env, REMOTE, [room]);
    expect(env.prepareCalls.some((sql) => sql.includes('SELECT event_id FROM events'))).toBe(
      true
    );
    expect(
      env.prepareCalls.some(
        (sql) =>
          sql.includes('WHERE room_id = ?') &&
          sql.includes('ORDER BY stream_ordering DESC') &&
          sql.includes('LIMIT 1')
      )
    ).toBe(true);
    expect(env.firstCalls).toEqual([
      expect.objectContaining({
        args: [room],
      }),
    ]);
  });

  it('first() missing event_id / null / undefined still POSTs earliest_events shape', async () => {
    const cases: Array<{ room: string; row: unknown; expected: unknown }> = [
      { room: '!miss:example.com', row: {}, expected: [null] },
      { room: '!undef:example.com', row: { event_id: undefined }, expected: [null] },
      { room: '!nul:example.com', row: { event_id: null }, expected: [null] },
      { room: '!num:example.com', row: { event_id: 0 }, expected: [0] },
    ];
    for (const c of cases) {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ events: [] }), { status: 200 }));
      const env = createCatchupEnv({
        latestByRoom: { [c.room]: '$ignored' },
        firstOverride: { [c.room]: c.row },
      });
      await runCatchup(env, REMOTE, [c.room]);
      const init = fetchMock.mock.calls[1][1] as RequestInit;
      expect(JSON.parse(String(init.body)).earliest_events).toEqual(c.expected);
    }
  });

  it('whitespace-only event_id still POSTs earliest_events verbatim', async () => {
    const room = '!ws:example.com';
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ events: [{}] }), { status: 200 }));
    await runCatchup(
      createCatchupEnv({ latestByRoom: { [room]: '   ' } }),
      REMOTE,
      [room]
    );
    const init = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      limit: 100,
      earliest_events: ['   '],
      latest_events: [],
    });
  });
});

describe('federation-catchup residual URL / result contract after #241', () => {
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

  it('version fetch is default GET (no method/body) with only signal', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ events: [] }), { status: 200 }));
    await runCatchup(
      createCatchupEnv({ latestByRoom: { '!r:example.com': '$e' } }),
      REMOTE,
      ['!r:example.com']
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe(`https://${REMOTE}/_matrix/federation/v1/version`);
    expect(init?.method).toBeUndefined();
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('serverName with :8448 builds https URLs including port', async () => {
    const room = '!port:example.com';
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ events: [{}] }), { status: 200 }));
    const { result } = await runCatchup(
      createCatchupEnv({ latestByRoom: { [room]: '$e' } }),
      PORT_HOST,
      [room]
    );
    expect(result.serverName).toBe(PORT_HOST);
    expect(result.success).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://${PORT_HOST}/_matrix/federation/v1/version`
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      `https://${PORT_HOST}/_matrix/federation/v1/get_missing_events/${encodeURIComponent(room)}`
    );
  });

  it('encodes unicode / ? / = room ids in get_missing_events URL', async () => {
    const rooms = ['!café:example.com', '!a?b=c:example.com', '!百分号%xx:example.com'];
    for (const roomId of rooms) {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ events: [{}] }), { status: 200 }));
      await runCatchup(
        createCatchupEnv({ latestByRoom: { [roomId]: '$x' } }),
        REMOTE,
        [roomId]
      );
      expect(fetchMock.mock.calls[1][0]).toBe(
        `https://${REMOTE}/_matrix/federation/v1/get_missing_events/${encodeURIComponent(roomId)}`
      );
    }
  });

  it('success:true result omits error key', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ events: [{}] }), { status: 200 }));
    const { result } = await runCatchup(
      createCatchupEnv({ latestByRoom: { '!r:example.com': '$e' } }),
      REMOTE,
      ['!r:example.com']
    );
    expect(result.success).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result, 'error')).toBe(false);
  });
});

describe('federation-catchup residual concurrent-race leftovers after #241', () => {
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

  it('TOCTOU mutate latest→null after SELECT barrier short-circuits both POSTs', async () => {
    const room = '!tocnull:example.com';
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify({ events: [{}] }), { status: 200 });
    });
    const env = createCatchupEnv({
      latestByRoom: { [room]: '$old:example.com' },
      selectBarrier: {
        match: (sql) => sql.includes('FROM events') && sql.includes('ORDER BY stream_ordering'),
        count: 2,
      },
      mutateLatestAfterBarrier: { [room]: null },
    });
    const [a, b] = await Promise.all([
      runCatchup(env, REMOTE, [room]),
      runCatchup(env, REMOTE, [room]),
    ]);
    expect(a.result.success).toBe(true);
    expect(b.result.success).toBe(true);
    expect(a.result.backfilledEvents).toBe(0);
    expect(b.result.backfilledEvents).toBe(0);
    const posts = fetchMock.mock.calls.filter((c) => String(c[0]).includes('get_missing_events'));
    expect(posts).toHaveLength(0);
  });

  it('get_missing_events throw ∥ success isolation', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/version')) return new Response('ok', { status: 200 });
      if (u.includes(encodeURIComponent('!boom:example.com'))) {
        throw new Error('reset');
      }
      return new Response(JSON.stringify({ events: [{}, {}, {}] }), { status: 200 });
    });
    const [boom, ok] = await Promise.all([
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!boom:example.com': '$b' } }),
        REMOTE,
        ['!boom:example.com']
      ),
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!ok:example.com': '$o' } }),
        PEER,
        ['!ok:example.com']
      ),
    ]);
    expect(boom.result).toEqual({
      serverName: REMOTE,
      backfilledEvents: 0,
      success: true,
    });
    expect(ok.result.backfilledEvents).toBe(3);
  });

  it('events object-with-length ∥ array length isolation', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) return new Response('{}', { status: 200 });
      if (String(url).includes(encodeURIComponent('!obj:example.com'))) {
        return new Response(JSON.stringify({ events: { length: 9 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ events: [{}, {}] }), { status: 200 });
    });
    const [obj, arr] = await Promise.all([
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!obj:example.com': '$o' } }),
        REMOTE,
        ['!obj:example.com']
      ),
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!arr:example.com': '$a' } }),
        PEER,
        ['!arr:example.com']
      ),
    ]);
    expect(obj.result.backfilledEvents).toBe(9);
    expect(arr.result.backfilledEvents).toBe(2);
  });

  it('version 301 ∥ 206 isolation under Promise.all', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes(`${REMOTE}/`) && u.includes('/version')) {
        return new Response('redir', { status: 301 });
      }
      if (u.includes(`${PEER}/`) && u.includes('/version')) {
        return new Response(null, { status: 206 });
      }
      return new Response(JSON.stringify({ events: [{}] }), { status: 200 });
    });
    const room = '!iso:example.com';
    const [fail, ok] = await Promise.all([
      runCatchup(createCatchupEnv({ latestByRoom: { [room]: '$e' } }), REMOTE, [room]),
      runCatchup(createCatchupEnv({ latestByRoom: { [room]: '$e' } }), PEER, [room]),
    ]);
    expect(fail.result.error).toBe('Server not reachable');
    expect(ok.result.success).toBe(true);
    expect(ok.result.backfilledEvents).toBe(1);
  });

  it('prepare throw ∥ populated backfill isolation', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ events: [{}, {}] }), { status: 200 });
    });
    const [thrown, ok] = await Promise.all([
      runCatchup(
        createCatchupEnv({
          latestByRoom: { '!bad:example.com': '$b' },
          throwOnPrepare: true,
        }),
        REMOTE,
        ['!bad:example.com']
      ),
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!good:example.com': '$g' } }),
        PEER,
        ['!good:example.com']
      ),
    ]);
    expect(thrown.result.backfilledEvents).toBe(0);
    expect(thrown.result.success).toBe(true);
    expect(ok.result.backfilledEvents).toBe(2);
  });

  it('get_missing_events POST barrier: both in-flight then throw∥200', async () => {
    const gate = createNBarrier(2);
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) return new Response('{}', { status: 200 });
      await gate.wait();
      if (String(url).includes(encodeURIComponent('!ok:example.com'))) {
        return new Response(JSON.stringify({ events: [{}, {}] }), { status: 200 });
      }
      throw new Error('peer reset');
    });
    const [ok, fail] = await Promise.all([
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!ok:example.com': '$o' } }),
        REMOTE,
        ['!ok:example.com']
      ),
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!fail:example.com': '$f' } }),
        PEER,
        ['!fail:example.com']
      ),
    ]);
    expect(gate.arrived).toBe(2);
    expect(ok.result.backfilledEvents).toBe(2);
    expect(fail.result.backfilledEvents).toBe(0);
    expect(fail.result.success).toBe(true);
  });

  it('port-host ∥ plain-host URL isolation under concurrent runs', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ events: [{}] }), { status: 200 });
    });
    const room = '!p:example.com';
    const [ported, plain] = await Promise.all([
      runCatchup(createCatchupEnv({ latestByRoom: { [room]: '$e' } }), PORT_HOST, [room]),
      runCatchup(createCatchupEnv({ latestByRoom: { [room]: '$e' } }), REMOTE, [room]),
    ]);
    expect(ported.result.serverName).toBe(PORT_HOST);
    expect(plain.result.serverName).toBe(REMOTE);
    const versionUrls = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/version'))
      .sort();
    expect(versionUrls).toEqual(
      [
        `https://${PORT_HOST}/_matrix/federation/v1/version`,
        `https://${REMOTE}/_matrix/federation/v1/version`,
      ].sort()
    );
  });

  it('AbortSignal wiring: port-host backfill still uses 10s + 30s', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    });
    timeoutSpy.mockClear();
    await Promise.all([
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!a:example.com': '$a' } }),
        PORT_HOST,
        ['!a:example.com']
      ),
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!b:example.com': '$b' } }),
        REMOTE,
        ['!b:example.com']
      ),
    ]);
    expect(timeoutSpy.mock.calls.filter((c) => c[0] === 10_000)).toHaveLength(2);
    expect(timeoutSpy.mock.calls.filter((c) => c[0] === 30_000)).toHaveLength(2);
  });

  it('JSON root array ∥ events object-length concurrent soft flood', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) return new Response('{}', { status: 200 });
      if (String(url).includes(encodeURIComponent('!root:example.com'))) {
        return new Response('[{"a":1}]', { status: 200 });
      }
      return new Response(JSON.stringify({ events: { length: 5 } }), { status: 200 });
    });
    const results = await Promise.all([
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!root:example.com': '$r' } }),
        'root.example.com',
        ['!root:example.com']
      ),
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!len:example.com': '$l' } }),
        'len.example.com',
        ['!len:example.com']
      ),
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!len2:example.com': '$l2' } }),
        'len2.example.com',
        ['!len2:example.com']
      ),
    ]);
    expect(results[0].result.backfilledEvents).toBe(0);
    expect(results[1].result.backfilledEvents).toBe(5);
    expect(results[2].result.backfilledEvents).toBe(5);
  });

  it('eight remotes mix 3xx-version / object-length / array soft flood', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/version')) {
        if (u.includes('redir')) return new Response('no', { status: 302 });
        return new Response('ok', { status: 200 });
      }
      if (u.includes('obj')) {
        const n = Number(u.match(/obj(\d)/)?.[1] ?? 0);
        return new Response(JSON.stringify({ events: { length: n } }), { status: 200 });
      }
      const n = Number(u.match(/arr(\d)/)?.[1] ?? 0);
      return new Response(
        JSON.stringify({ events: Array.from({ length: n }, () => ({})) }),
        { status: 200 }
      );
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => {
        const kind = i % 3;
        const host =
          kind === 0
            ? `redir${i}.example.com`
            : kind === 1
              ? `obj${i}.example.com`
              : `arr${i}.example.com`;
        const room = `!${kind === 1 ? 'obj' : kind === 2 ? 'arr' : 'r'}${i}:example.com`;
        return runCatchup(
          createCatchupEnv({ latestByRoom: { [room]: `$e${i}` } }),
          host,
          [room]
        );
      })
    );
    for (let i = 0; i < 8; i++) {
      const kind = i % 3;
      if (kind === 0) {
        expect(results[i].result.success).toBe(false);
        expect(results[i].result.error).toBe('Server not reachable');
      } else {
        expect(results[i].result.success).toBe(true);
        expect(results[i].result.backfilledEvents).toBe(i);
      }
    }
  });
});
