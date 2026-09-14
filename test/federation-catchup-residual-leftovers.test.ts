/**
 * TOKENMAXX HEAVY leftovers after #241 — residual *federation-catchup* only.
 *
 * Complements (does not re-flood) existing catchup coverage:
 *   - federation-catchup-workflow.test.ts (#65/#71 serial)
 *   - federation-catchup-workflow-leftovers.test.ts (#171 soft floods)
 *   - federation-media-compaction-workflow-concurrent-race (#187 2xx/malformed)
 *   - federation-catchup-consumer-device-list-concurrent-race (#231 races)
 *   - federation-catchup-consumer-device-list-sync-concurrent-race (#237 races)
 *
 * Residual gaps claimed (catchup module slice only — not consumer/device-list):
 *   - workflows/index + CatchupParams/CatchupResult surface pins
 *   - CI/vitest include pins so this file stays in `npm test`
 *   - version 3xx !ok + extra 2xx ok soft flood; backfill extra fail/ok statuses
 *   - events payload residuals: boolean/object/{length}/string-length coerce
 *   - JSON non-object roots (array/number) → catch → 0
 *   - D1 TOCTOU residual: populated→null and null→populated after SELECT barrier
 *   - D1 row missing/undefined event_id POSTs earliest_events:[null] (JSON wire)
 *   - serverName with :8448 port URL construction
 *   - SQL SELECT/bind pin under concurrent runs
 *   - success result omits error; AbortSignal 30s skipped on short-circuit∥sibling
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 * Reversible by deleting this file.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

import {
  FederationCatchupWorkflow,
  type CatchupParams,
  type CatchupResult,
} from '../src/workflows/FederationCatchupWorkflow';
import {
  FederationCatchupWorkflow as FederationCatchupWorkflowFromIndex,
  type CatchupParams as CatchupParamsFromIndex,
  type CatchupResult as CatchupResultFromIndex,
} from '../src/workflows';

const REMOTE = 'remote.example.com';
const PEER = 'peer.example.com';
const REMOTE_PORT = 'remote.example.com:8448';

type SqlBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };
type SqlCall = { sql: string; args: unknown[] };
type LatestRow = { event_id?: string | null } | null;

async function withSqlBarrier(
  barrier: SqlBarrier | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  sql: string,
  args: unknown[]
) {
  if (!barrier || !barrier.match(sql, args)) return;
  await new Promise<void>((resolveWait) => {
    waitersRef.list.push(resolveWait);
    if (waitersRef.list.length >= barrier.count) {
      const all = [...waitersRef.list];
      waitersRef.list = [];
      clear();
      for (const r of all) r();
    }
  });
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

function createCatchupEnv(opts: {
  latestByRoom?: Record<string, string | null | undefined>;
  /** When set, return this row object (including `{}` / `{event_id: undefined}`). */
  rowByRoom?: Record<string, LatestRow>;
  throwRooms?: Set<string>;
  selectBarrier?: SqlBarrier;
  mutateLatestAfterBarrier?: Record<string, string | null>;
  mutateRowAfterBarrier?: Record<string, LatestRow>;
}) {
  const waiters = { list: [] as Array<() => void> };
  let selectBarrier = opts.selectBarrier;
  const latestByRoom = { ...(opts.latestByRoom ?? {}) };
  const rowByRoom: Record<string, LatestRow> = { ...(opts.rowByRoom ?? {}) };
  const firstCalls: SqlCall[] = [];
  return {
    firstCalls,
    latestByRoom,
    rowByRoom,
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                firstCalls.push({ sql, args });
                await withSqlBarrier(
                  selectBarrier,
                  waiters,
                  () => {
                    selectBarrier = undefined;
                    if (opts.mutateLatestAfterBarrier) {
                      Object.assign(latestByRoom, opts.mutateLatestAfterBarrier);
                    }
                    if (opts.mutateRowAfterBarrier) {
                      Object.assign(rowByRoom, opts.mutateRowAfterBarrier);
                    }
                  },
                  sql,
                  args
                );
                if (sql.includes('FROM events') && sql.includes('ORDER BY stream_ordering')) {
                  const roomId = args[0] as string;
                  if (opts.throwRooms?.has(roomId)) throw new Error(`d1 boom ${roomId}`);
                  if (Object.prototype.hasOwnProperty.call(rowByRoom, roomId)) {
                    return rowByRoom[roomId] as T;
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
  env: { DB: D1Database },
  serverName: string,
  roomIds: string[]
) {
  const wf = new FederationCatchupWorkflow({} as never, env as never);
  const step = mockStep();
  const result = await wf.run({ payload: { serverName, roomIds } } as never, step as never);
  return { result, step };
}

describe('federation-catchup residual surface + CI pins after #241', () => {
  it('re-exports FederationCatchupWorkflow + CatchupParams/CatchupResult from workflows/index', () => {
    expect(FederationCatchupWorkflowFromIndex).toBe(FederationCatchupWorkflow);
    const params: CatchupParams = { serverName: REMOTE, roomIds: ['!a:example.com'] };
    const paramsIdx: CatchupParamsFromIndex = params;
    expect(paramsIdx.serverName).toBe(REMOTE);
    const ok: CatchupResult = {
      serverName: REMOTE,
      backfilledEvents: 0,
      success: true,
    };
    const okIdx: CatchupResultFromIndex = ok;
    expect(okIdx.success).toBe(true);
    const fail: CatchupResult = {
      serverName: REMOTE,
      backfilledEvents: 0,
      success: false,
      error: 'Server not reachable',
    };
    expect(fail.error).toBe('Server not reachable');
  });

  it('CI runs npm test and vitest includes test/**/*.test.ts (this file)', () => {
    const ci = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toMatch(/run:\s*npm test/);
    expect(ci).toMatch(/name:\s*Tests/);
    const vitestCfg = readFileSync(resolve(process.cwd(), 'vitest.config.ts'), 'utf8');
    expect(vitestCfg).toMatch(/include:\s*\[['"]test\/\*\*\/\*\.test\.ts['"]\]/);
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.test).toBe('vitest run');
  });
});

describe('federation-catchup residual version/backfill status soft flood after #241', () => {
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

  // resp.ok is false for redirects — unsaturated vs #171 4xx/5xx fail flood
  for (const status of [301, 302, 303, 307, 308] as const) {
    it(`version HTTP ${status} (!ok redirect) → unreachable, no backfill`, async () => {
      fetchMock.mockResolvedValueOnce(new Response('', { status }));
      const env = createCatchupEnv({ latestByRoom: { '!a:example.com': '$a' } });
      const step = mockStep();
      const wf = new FederationCatchupWorkflow({} as never, env as never);
      const out = await wf.run(
        { payload: { serverName: REMOTE, roomIds: ['!a:example.com'] } } as never,
        step as never
      );
      expect(out).toEqual({
        serverName: REMOTE,
        backfilledEvents: 0,
        success: false,
        error: 'Server not reachable',
      });
      expect(step.names).toEqual(['check-server']);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }

  for (const status of [203, 205, 206, 207, 208, 226, 299] as const) {
    it(`version HTTP ${status} (resp.ok) proceeds to backfill`, async () => {
      fetchMock
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ events: [{}, {}] }), { status: 200 })
        );
      const { result } = await runCatchup(
        createCatchupEnv({ latestByRoom: { '!a:example.com': '$a' } }) as never,
        REMOTE,
        ['!a:example.com']
      );
      expect(result).toEqual({
        serverName: REMOTE,
        backfilledEvents: 2,
        success: true,
      });
    });
  }

  for (const status of [401, 405, 406, 409, 410, 422, 501, 504, 505] as const) {
    it(`get_missing_events HTTP ${status} → 0, overall success`, async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(new Response('nope', { status }));
      const { result } = await runCatchup(
        createCatchupEnv({ latestByRoom: { '!a:example.com': '$a' } }) as never,
        REMOTE,
        ['!a:example.com']
      );
      expect(result).toEqual({
        serverName: REMOTE,
        backfilledEvents: 0,
        success: true,
      });
      expect(Object.prototype.hasOwnProperty.call(result, 'error')).toBe(false);
    });
  }

  // 205 cannot carry a body in the Fetch Response constructor — covered as version-ok above
  for (const status of [203, 206, 299] as const) {
    it(`get_missing_events HTTP ${status} with events body is counted`, async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('ok', { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ events: [1, 2, 3, 4] }), { status })
        );
      const { result } = await runCatchup(
        createCatchupEnv({ latestByRoom: { '!a:example.com': '$a' } }) as never,
        REMOTE,
        ['!a:example.com']
      );
      expect(result.backfilledEvents).toBe(4);
      expect(result.success).toBe(true);
    });
  }

  it('get_missing_events HTTP 205 (ok, empty) counts 0 via json catch', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 205 }));
    const { result } = await runCatchup(
      createCatchupEnv({ latestByRoom: { '!a:example.com': '$a' } }) as never,
      REMOTE,
      ['!a:example.com']
    );
    expect(result.backfilledEvents).toBe(0);
    expect(result.success).toBe(true);
  });
});

describe('federation-catchup residual events payload / JSON root soft flood after #241', () => {
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

  it('events false/true/{} → 0; {length:N} counted as-is', async () => {
    const cases: Array<{ payload: unknown; expected: number }> = [
      { payload: { events: false }, expected: 0 },
      { payload: { events: true }, expected: 0 },
      { payload: { events: {} }, expected: 0 },
      { payload: { events: { length: 7 } }, expected: 7 },
      { payload: { events: { length: 0 } }, expected: 0 },
    ];
    for (const { payload, expected } of cases) {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));
      const { result } = await runCatchup(
        createCatchupEnv({ latestByRoom: { '!a:example.com': '$a' } }) as never,
        REMOTE,
        ['!a:example.com']
      );
      expect(result.backfilledEvents).toBe(expected);
      expect(result.success).toBe(true);
    }
  });

  it('events {length:"3"} string coerces via += into concatenated aggregate (pinned)', async () => {
    // data.events?.length || 0 → '3'; then totalBackfilled += '3' → '03' in JS
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ events: { length: '3' } }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ events: [{}, {}] }), { status: 200 })
      );
    const { result } = await runCatchup(
      createCatchupEnv({
        latestByRoom: { '!a:example.com': '$a', '!b:example.com': '$b' },
      }) as never,
      REMOTE,
      ['!a:example.com', '!b:example.com']
    );
    expect(result.backfilledEvents).toBe('032' as unknown as number);
    expect(result.success).toBe(true);
  });

  it('JSON array/number/string roots on successful backfill → catch → 0', async () => {
    for (const body of ['[]', '42', '"x"', 'true']) {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(new Response(body, { status: 200 }));
      const { result } = await runCatchup(
        createCatchupEnv({ latestByRoom: { '!a:example.com': '$a' } }) as never,
        REMOTE,
        ['!a:example.com']
      );
      // array/number/string/bool have no .events → undefined?.length || 0 → 0
      // (accessing .events on primitives after cast is fine; length undefined)
      expect(result.backfilledEvents).toBe(0);
      expect(result.success).toBe(true);
    }
  });
});

describe('federation-catchup residual D1 TOCTOU / row shape concurrent-race after #241', () => {
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

  it('SELECT barrier TOCTOU populated→null short-circuits both POSTs', async () => {
    const room = '!toc-null:example.com';
    const posted: string[][] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/version')) return new Response('ok', { status: 200 });
      posted.push(JSON.parse(String(init?.body)).earliest_events);
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
      runCatchup(env as never, REMOTE, [room]),
      runCatchup(env as never, REMOTE, [room]),
    ]);
    expect(a.result.backfilledEvents).toBe(0);
    expect(b.result.backfilledEvents).toBe(0);
    expect(a.result.success).toBe(true);
    expect(posted).toEqual([]);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('get_missing_events'))).toHaveLength(
      0
    );
  });

  it('SELECT barrier TOCTOU null→populated both POST new earliest_events', async () => {
    const room = '!toc-fill:example.com';
    const posted: string[][] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/version')) return new Response('ok', { status: 200 });
      posted.push(JSON.parse(String(init?.body)).earliest_events);
      return new Response(JSON.stringify({ events: [{}, {}] }), { status: 200 });
    });
    const env = createCatchupEnv({
      latestByRoom: { [room]: null },
      selectBarrier: {
        match: (sql) => sql.includes('FROM events') && sql.includes('ORDER BY stream_ordering'),
        count: 2,
      },
      mutateLatestAfterBarrier: { [room]: '$new:example.com' },
    });
    const [a, b] = await Promise.all([
      runCatchup(env as never, REMOTE, [room]),
      runCatchup(env as never, REMOTE, [room]),
    ]);
    expect(a.result.backfilledEvents).toBe(2);
    expect(b.result.backfilledEvents).toBe(2);
    expect(posted).toEqual([['$new:example.com'], ['$new:example.com']]);
  });

  it('D1 row missing event_id ∥ undefined event_id still POSTs earliest as-is', async () => {
    const bodies: unknown[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/version')) return new Response('ok', { status: 200 });
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    });
    const missing = '!miss:example.com';
    const undef = '!undef:example.com';
    await Promise.all([
      runCatchup(
        createCatchupEnv({ rowByRoom: { [missing]: {} } }) as never,
        REMOTE,
        [missing]
      ),
      runCatchup(
        createCatchupEnv({ rowByRoom: { [undef]: { event_id: undefined } } }) as never,
        PEER,
        [undef]
      ),
    ]);
    // JSON.stringify turns undefined → null inside arrays (pinned wire shape)
    expect(bodies).toEqual(
      expect.arrayContaining([
        { limit: 100, earliest_events: [null], latest_events: [] },
        { limit: 100, earliest_events: [null], latest_events: [] },
      ])
    );
    expect(bodies).toHaveLength(2);
  });

  it('SQL SELECT + bind roomId pin under concurrent remotes', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify({ events: [{}] }), { status: 200 });
    });
    const roomA = '!sql-a:example.com';
    const roomB = '!sql-b:example.com';
    const envA = createCatchupEnv({ latestByRoom: { [roomA]: '$a' } });
    const envB = createCatchupEnv({ latestByRoom: { [roomB]: '$b' } });
    await Promise.all([
      runCatchup(envA as never, REMOTE, [roomA]),
      runCatchup(envB as never, PEER, [roomB]),
    ]);
    expect(envA.firstCalls).toHaveLength(1);
    expect(envB.firstCalls).toHaveLength(1);
    expect(envA.firstCalls[0].sql).toMatch(/SELECT event_id FROM events WHERE room_id = \?/);
    expect(envA.firstCalls[0].sql).toMatch(/ORDER BY stream_ordering DESC LIMIT 1/);
    expect(envA.firstCalls[0].args).toEqual([roomA]);
    expect(envB.firstCalls[0].args).toEqual([roomB]);
  });
});

describe('federation-catchup residual URL / timeout / result-shape concurrent-race after #241', () => {
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

  it('serverName with :8448 port builds https URLs for version + backfill', async () => {
    const room = '!port:example.com';
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ events: [{}] }), { status: 200 }));
    const { result, step } = await runCatchup(
      createCatchupEnv({ latestByRoom: { [room]: '$e' } }) as never,
      REMOTE_PORT,
      [room]
    );
    expect(result.serverName).toBe(REMOTE_PORT);
    expect(result.success).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://${REMOTE_PORT}/_matrix/federation/v1/version`
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      `https://${REMOTE_PORT}/_matrix/federation/v1/get_missing_events/${encodeURIComponent(room)}`
    );
    expect(step.names).toEqual(['check-server', `backfill-${room}`]);
  });

  it('port server ∥ plain host concurrent URL isolation', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify({ events: [{}] }), { status: 200 });
    });
    const room = '!iso:example.com';
    await Promise.all([
      runCatchup(
        createCatchupEnv({ latestByRoom: { [room]: '$e' } }) as never,
        REMOTE_PORT,
        [room]
      ),
      runCatchup(createCatchupEnv({ latestByRoom: { [room]: '$e' } }) as never, PEER, [room]),
    ]);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain(`https://${REMOTE_PORT}/_matrix/federation/v1/version`);
    expect(urls).toContain(`https://${PEER}/_matrix/federation/v1/version`);
    expect(urls).toContain(
      `https://${REMOTE_PORT}/_matrix/federation/v1/get_missing_events/${encodeURIComponent(room)}`
    );
    expect(urls).toContain(
      `https://${PEER}/_matrix/federation/v1/get_missing_events/${encodeURIComponent(room)}`
    );
  });

  it('AbortSignal 30s skipped on missing-latest short-circuit ∥ sibling backfill', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    });
    timeoutSpy.mockClear();
    const [empty, filled] = await Promise.all([
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!empty:example.com': null } }) as never,
        REMOTE,
        ['!empty:example.com']
      ),
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!full:example.com': '$f' } }) as never,
        PEER,
        ['!full:example.com']
      ),
    ]);
    expect(empty.result.backfilledEvents).toBe(0);
    expect(filled.result.backfilledEvents).toBe(0);
    expect(timeoutSpy.mock.calls.filter((c) => c[0] === 10_000)).toHaveLength(2);
    expect(timeoutSpy.mock.calls.filter((c) => c[0] === 30_000)).toHaveLength(1);
  });

  it('success result omits error key under overlapping 200∥404 backfill race', async () => {
    const gate = createNBarrier(2);
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) return new Response('{}', { status: 200 });
      await gate.wait();
      if (String(url).includes(encodeURIComponent('!ok:example.com'))) {
        return new Response(JSON.stringify({ events: [{}] }), { status: 200 });
      }
      return new Response('nope', { status: 404 });
    });
    const [ok, fail] = await Promise.all([
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!ok:example.com': '$o' } }) as never,
        REMOTE,
        ['!ok:example.com']
      ),
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!fail:example.com': '$f' } }) as never,
        PEER,
        ['!fail:example.com']
      ),
    ]);
    expect(gate.arrived).toBe(2);
    expect(ok.result).toEqual({
      serverName: REMOTE,
      backfilledEvents: 1,
      success: true,
    });
    expect(fail.result).toEqual({
      serverName: PEER,
      backfilledEvents: 0,
      success: true,
    });
    expect(Object.prototype.hasOwnProperty.call(ok.result, 'error')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(fail.result, 'error')).toBe(false);
  });

  it('special-char room step names + URL encode under concurrent soft flood', async () => {
    const rooms = ['!a/b:example.com', '!a#b:example.com', '!a&b:example.com'];
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) return new Response('ok', { status: 200 });
      return new Response(JSON.stringify({ events: [{}] }), { status: 200 });
    });
    const results = await Promise.all(
      rooms.map((room) =>
        runCatchup(
          createCatchupEnv({ latestByRoom: { [room]: '$x' } }) as never,
          REMOTE,
          [room]
        )
      )
    );
    for (let i = 0; i < rooms.length; i++) {
      expect(results[i].step.names).toEqual(['check-server', `backfill-${rooms[i]}`]);
      expect(results[i].result.backfilledEvents).toBe(1);
    }
    const urls = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('get_missing_events'))
      .sort();
    expect(urls).toEqual(
      rooms
        .map(
          (r) =>
            `https://${REMOTE}/_matrix/federation/v1/get_missing_events/${encodeURIComponent(r)}`
        )
        .sort()
    );
  });
});
