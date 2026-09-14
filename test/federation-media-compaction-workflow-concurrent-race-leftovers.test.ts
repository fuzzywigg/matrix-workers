/**
 * TOKENMAXX HEAVY concurrent-race leftovers after #187 — FederationCatchup /
 * MediaCleanup / StateCompaction workflows.
 * Complements *-workflow.test.ts + *-workflow-leftovers.test.ts (#187).
 * Distinct edges: 2xx non-200 reachability, malformed-success JSON, D1 throw
 * isolation, duplicate room/media ids, nullish payload defaults, numeric
 * cutoff/depth matrices, stage-failure ordering, Promise.all run isolation.
 * Tests-only — no product inventing. Fixtures use example.com only.
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
import { MediaCleanupWorkflow } from '../src/workflows/MediaCleanupWorkflow';
import { StateCompactionWorkflow } from '../src/workflows/StateCompactionWorkflow';

const REMOTE = 'remote.example.com';
const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ROOM = '!room:example.com';

type MediaRow = {
  media_id: string;
  content_type: string;
  file_size: number;
  created_at: number;
};

function mockStep() {
  const names: string[] = [];
  const optsLog: Array<{ name: string; opts: unknown }> = [];
  return {
    names,
    optsLog,
    async do(name: string, optsOrFn: unknown, maybeFn?: unknown) {
      names.push(name);
      if (typeof optsOrFn !== 'function') {
        optsLog.push({ name, opts: optsOrFn });
      }
      const fn = typeof optsOrFn === 'function' ? optsOrFn : maybeFn;
      return (fn as () => Promise<unknown>)();
    },
  };
}

function createCatchupEnv(opts: {
  latestByRoom?: Record<string, string | null | undefined>;
  throwRooms?: Set<string>;
}) {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                if (sql.includes('FROM events') && sql.includes('ORDER BY stream_ordering')) {
                  const roomId = args[0] as string;
                  if (opts.throwRooms?.has(roomId)) throw new Error(`d1 boom ${roomId}`);
                  const id = opts.latestByRoom?.[roomId];
                  // Preserve empty-string event_id (falsy but valid row) for contract tests.
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
  } as unknown as { DB: D1Database };
}

function createCleanupEnv(opts: {
  media?: MediaRow[];
  deleteFailIds?: Set<string>;
  d1FailIds?: Set<string>;
  d1Changes?: number;
  findThrow?: boolean;
}) {
  const media = [...(opts.media ?? [])];
  const deletedR2: string[] = [];
  const deletedDb: string[] = [];
  let lastCutoff: number | undefined;

  const env = {
    deletedR2,
    deletedDb,
    getLastCutoff: () => lastCutoff,
    media,
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async all<T>() {
                if (sql.includes('FROM media') && sql.includes('created_at <')) {
                  if (opts.findThrow) throw new Error('find-expired boom');
                  lastCutoff = args[0] as number;
                  const cutoff = lastCutoff!;
                  return {
                    results: media.filter((m) => m.created_at < cutoff) as T[],
                  };
                }
                return { results: [] };
              },
              async run() {
                if (sql.includes('DELETE FROM media')) {
                  const id = args[0] as string;
                  if (opts.d1FailIds?.has(id)) throw new Error('d1 fail');
                  deletedDb.push(id);
                  const idx = media.findIndex((m) => m.media_id === id);
                  if (idx >= 0) media.splice(idx, 1);
                  return { meta: { changes: opts.d1Changes ?? 1 } };
                }
                return { meta: { changes: 0 } };
              },
            };
          },
        };
      },
    },
    MEDIA: {
      async delete(id: string) {
        if (opts.deleteFailIds?.has(id)) throw new Error('r2 fail');
        deletedR2.push(id);
      },
    },
  };

  return env as unknown as {
    DB: D1Database;
    MEDIA: R2Bucket;
    deletedR2: string[];
    deletedDb: string[];
    media: MediaRow[];
    getLastCutoff: () => number | undefined;
  };
}

function createCompactionEnv(opts: {
  deepCount?: number | null | undefined;
  returnNullFirst?: boolean;
  pruneChanges?: number | null | undefined;
  compactChanges?: number | null | undefined;
  throwOn?: 'find' | 'prune' | 'compact';
}) {
  const binds: Array<{ sql: string; args: unknown[] }> = [];
  const env = {
    binds,
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            binds.push({ sql, args });
            return {
              async first<T>() {
                if (sql.includes('SELECT COUNT(*)') && sql.includes('event_auth_chain')) {
                  if (opts.throwOn === 'find') throw new Error('find boom');
                  if (opts.returnNullFirst) return null;
                  if (opts.deepCount === null) return { count: null } as T;
                  if (opts.deepCount === undefined && !('deepCount' in opts)) {
                    return { count: 0 } as T;
                  }
                  return { count: opts.deepCount as number } as T;
                }
                return null;
              },
              async run() {
                if (sql.includes('DELETE FROM event_auth_chain')) {
                  if (opts.throwOn === 'prune') throw new Error('prune boom');
                  return { meta: { changes: opts.pruneChanges as number } };
                }
                if (sql.includes('DELETE FROM room_state')) {
                  if (opts.throwOn === 'compact') throw new Error('compact boom');
                  return { meta: { changes: opts.compactChanges as number } };
                }
                return { meta: { changes: 0 } };
              },
            };
          },
        };
      },
    },
  };
  return env as unknown as {
    DB: D1Database;
    binds: Array<{ sql: string; args: unknown[] }>;
  };
}

function mediaRow(id: string, created_at: number, file_size = 100): MediaRow {
  return { media_id: id, content_type: 'image/png', file_size, created_at };
}

describe('federation-catchup after #187: 2xx / malformed-success / D1 isolation', () => {
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

  for (const status of [201, 202, 204] as const) {
    it(`version HTTP ${status} (resp.ok) proceeds to backfill`, async () => {
      const room = `!ok${status}:example.com`;
      fetchMock
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ events: [{}, {}] }), { status: 200 })
        );
      const env = createCatchupEnv({ latestByRoom: { [room]: `$e${status}:example.com` } });
      const wf = new FederationCatchupWorkflow({} as never, env as never);
      const step = mockStep();
      const result = await wf.run(
        { payload: { serverName: REMOTE, roomIds: [room] } } as never,
        step as never
      );
      expect(result).toEqual({
        serverName: REMOTE,
        backfilledEvents: 2,
        success: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  }

  for (const status of [201, 202] as const) {
    it(`get_missing_events HTTP ${status} with events body is counted`, async () => {
      const room = `!bf${status}:example.com`;
      fetchMock
        .mockResolvedValueOnce(new Response('ok', { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ events: [1, 2, 3] }), { status })
        );
      const env = createCatchupEnv({ latestByRoom: { [room]: '$e:example.com' } });
      const wf = new FederationCatchupWorkflow({} as never, env as never);
      const result = await wf.run(
        { payload: { serverName: REMOTE, roomIds: [room] } } as never,
        mockStep() as never
      );
      expect(result.backfilledEvents).toBe(3);
      expect(result.success).toBe(true);
    });
  }

  it('get_missing_events HTTP 204 (ok, empty) counts 0', async () => {
    const room = '!bf204:example.com';
    fetchMock
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const env = createCatchupEnv({ latestByRoom: { [room]: '$e:example.com' } });
    const wf = new FederationCatchupWorkflow({} as never, env as never);
    const result = await wf.run(
      { payload: { serverName: REMOTE, roomIds: [room] } } as never,
      mockStep() as never
    );
    // 204 is ok but json() on empty body fails → catch → 0
    expect(result.backfilledEvents).toBe(0);
    expect(result.success).toBe(true);
  });

  it('malformed JSON on successful backfill → 0 for that room', async () => {
    const room = '!badjson:example.com';
    fetchMock
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockResolvedValueOnce(new Response('not-json{', { status: 200 }));
    const env = createCatchupEnv({ latestByRoom: { [room]: '$e:example.com' } });
    const wf = new FederationCatchupWorkflow({} as never, env as never);
    const result = await wf.run(
      { payload: { serverName: REMOTE, roomIds: [room] } } as never,
      mockStep() as never
    );
    expect(result).toEqual({
      serverName: REMOTE,
      backfilledEvents: 0,
      success: true,
    });
  });

  it('JSON null root on successful backfill is caught as 0', async () => {
    const room = '!nullroot:example.com';
    fetchMock
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockResolvedValueOnce(new Response('null', { status: 200 }));
    const env = createCatchupEnv({ latestByRoom: { [room]: '$e:example.com' } });
    const wf = new FederationCatchupWorkflow({} as never, env as never);
    const result = await wf.run(
      { payload: { serverName: REMOTE, roomIds: [room] } } as never,
      mockStep() as never
    );
    expect(result.backfilledEvents).toBe(0);
    expect(result.success).toBe(true);
  });

  it('latest-event D1 throw for one room zeros that room; later rooms still aggregate', async () => {
    const bad = '!bad:example.com';
    const good = '!good:example.com';
    fetchMock
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ events: [{}, {}, {}, {}] }), { status: 200 })
      );
    const env = createCatchupEnv({
      latestByRoom: { [bad]: '$x:example.com', [good]: '$y:example.com' },
      throwRooms: new Set([bad]),
    });
    const wf = new FederationCatchupWorkflow({} as never, env as never);
    const step = mockStep();
    const result = await wf.run(
      { payload: { serverName: REMOTE, roomIds: [bad, good] } } as never,
      step as never
    );
    expect(result.backfilledEvents).toBe(4);
    expect(result.success).toBe(true);
    expect(step.names).toEqual(['check-server', `backfill-${bad}`, `backfill-${good}`]);
    // version + one backfill (bad short-circuited before fetch)
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('empty-string latest event_id still POSTs earliest_events=[""]', async () => {
    const room = '!emptyid:example.com';
    fetchMock
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ events: [{}] }), { status: 200 }));
    const env = createCatchupEnv({ latestByRoom: { [room]: '' } });
    const wf = new FederationCatchupWorkflow({} as never, env as never);
    await wf.run(
      { payload: { serverName: REMOTE, roomIds: [room] } } as never,
      mockStep() as never
    );
    const backfillCall = fetchMock.mock.calls[1];
    expect(backfillCall[1].body).toBe(
      JSON.stringify({ limit: 100, earliest_events: [''], latest_events: [] })
    );
  });

  it('duplicate roomIds create separate backfill steps and sum independently', async () => {
    const room = '!dup:example.com';
    fetchMock
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ events: [{}, {}] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ events: [{}, {}, {}] }), { status: 200 })
      );
    const env = createCatchupEnv({ latestByRoom: { [room]: '$e:example.com' } });
    const wf = new FederationCatchupWorkflow({} as never, env as never);
    const step = mockStep();
    const result = await wf.run(
      { payload: { serverName: REMOTE, roomIds: [room, room] } } as never,
      step as never
    );
    expect(result.backfilledEvents).toBe(5);
    expect(step.names.filter((n) => n === `backfill-${room}`)).toHaveLength(2);
  });

  it('Promise.all concurrent runs keep counts and fetch sequences isolated', async () => {
    const roomA = '!a:example.com';
    const roomB = '!b:example.com';
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('a.example.com') && u.includes('/version')) {
        return new Response('ok', { status: 200 });
      }
      if (u.includes('b.example.com') && u.includes('/version')) {
        return new Response('ok', { status: 200 });
      }
      if (u.includes('a.example.com') && u.includes('get_missing_events')) {
        return new Response(JSON.stringify({ events: [{}] }), { status: 200 });
      }
      if (u.includes('b.example.com') && u.includes('get_missing_events')) {
        return new Response(JSON.stringify({ events: [{}, {}, {}] }), { status: 200 });
      }
      return new Response('nope', { status: 500 });
    });
    const envA = createCatchupEnv({ latestByRoom: { [roomA]: '$a:example.com' } });
    const envB = createCatchupEnv({ latestByRoom: { [roomB]: '$b:example.com' } });
    const wfA = new FederationCatchupWorkflow({} as never, envA as never);
    const wfB = new FederationCatchupWorkflow({} as never, envB as never);
    const [ra, rb] = await Promise.all([
      wfA.run(
        { payload: { serverName: 'a.example.com', roomIds: [roomA] } } as never,
        mockStep() as never
      ),
      wfB.run(
        { payload: { serverName: 'b.example.com', roomIds: [roomB] } } as never,
        mockStep() as never
      ),
    ]);
    expect(ra).toEqual({ serverName: 'a.example.com', backfilledEvents: 1, success: true });
    expect(rb).toEqual({ serverName: 'b.example.com', backfilledEvents: 3, success: true });
  });

  it('unreachable with null roomIds still returns before iteration', async () => {
    fetchMock.mockResolvedValueOnce(new Response('down', { status: 503 }));
    const env = createCatchupEnv({});
    const wf = new FederationCatchupWorkflow({} as never, env as never);
    const result = await wf.run(
      { payload: { serverName: REMOTE, roomIds: null as unknown as string[] } } as never,
      mockStep() as never
    );
    expect(result).toEqual({
      serverName: REMOTE,
      backfilledEvents: 0,
      success: false,
      error: 'Server not reachable',
    });
  });

  it('reachable with null roomIds rejects from for...of (pinned existing behavior)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const env = createCatchupEnv({});
    const wf = new FederationCatchupWorkflow({} as never, env as never);
    await expect(
      wf.run(
        { payload: { serverName: REMOTE, roomIds: null as unknown as string[] } } as never,
        mockStep() as never
      )
    ).rejects.toThrow();
  });
});

describe('media-cleanup after #187: nullish / numeric cutoff / delete contracts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('explicit maxAgeDays:null selects 90-day default', async () => {
    const env = createCleanupEnv({
      media: [mediaRow('m1', NOW - 91 * DAY_MS, 10)],
    });
    const wf = new MediaCleanupWorkflow({} as never, env as never);
    await wf.run(
      { payload: { maxAgeDays: null as unknown as number, dryRun: true } } as never,
      mockStep() as never
    );
    expect(env.getLastCutoff()).toBe(NOW - 90 * DAY_MS);
  });

  it('explicit dryRun:null selects false and deletes', async () => {
    const env = createCleanupEnv({
      media: [mediaRow('m-del', NOW - 100 * DAY_MS, 42)],
    });
    const wf = new MediaCleanupWorkflow({} as never, env as never);
    const result = await wf.run(
      { payload: { maxAgeDays: 30, dryRun: null as unknown as boolean } } as never,
      mockStep() as never
    );
    expect(result).toEqual({
      deletedCount: 1,
      freedBytes: 42,
      dryRun: false,
      success: true,
    });
    expect(env.deletedR2).toEqual(['m-del']);
    expect(env.deletedDb).toEqual(['m-del']);
  });

  for (const maxAgeDays of [-1, -7, -90] as const) {
    it(`negative maxAgeDays=${maxAgeDays} binds future cutoff; selection uses created_at < cutoff`, async () => {
      const futureCutoff = NOW - maxAgeDays * DAY_MS;
      expect(futureCutoff).toBeGreaterThan(NOW);
      const env = createCleanupEnv({
        media: [
          mediaRow('old', NOW - DAY_MS, 1),
          mediaRow('mid', NOW + Math.floor((-maxAgeDays * DAY_MS) / 2), 1),
          mediaRow('beyond', futureCutoff + 1, 1),
        ],
      });
      const wf = new MediaCleanupWorkflow({} as never, env as never);
      const result = await wf.run(
        { payload: { maxAgeDays, dryRun: true } } as never,
        mockStep() as never
      );
      expect(env.getLastCutoff()).toBe(futureCutoff);
      // old + mid are before cutoff; beyond is after
      expect(result.deletedCount).toBe(2);
    });
  }

  for (const maxAgeDays of [0.5, 1.25, 2.75] as const) {
    it(`fractional maxAgeDays=${maxAgeDays} preserves fractional-ms cutoff`, async () => {
      const env = createCleanupEnv({ media: [] });
      const wf = new MediaCleanupWorkflow({} as never, env as never);
      await wf.run({ payload: { maxAgeDays, dryRun: true } } as never, mockStep() as never);
      expect(env.getLastCutoff()).toBe(NOW - maxAgeDays * DAY_MS);
    });
  }

  it('maxAgeDays:NaN binds NaN cutoff; NaN comparisons select nothing', async () => {
    const env = createCleanupEnv({
      media: [mediaRow('any', NOW - DAY_MS, 1)],
    });
    const result = await new MediaCleanupWorkflow({} as never, env as never).run(
      { payload: { maxAgeDays: Number.NaN, dryRun: true } } as never,
      mockStep() as never
    );
    expect(Number.isNaN(env.getLastCutoff())).toBe(true);
    expect(result.deletedCount).toBe(0);
  });

  it('D1 DELETE meta.changes:0 still counts deleted after R2 ok', async () => {
    const env = createCleanupEnv({
      media: [mediaRow('zero-chg', NOW - 100 * DAY_MS, 9)],
      d1Changes: 0,
    });
    const wf = new MediaCleanupWorkflow({} as never, env as never);
    const result = await wf.run(
      { payload: { maxAgeDays: 1, dryRun: false } } as never,
      mockStep() as never
    );
    expect(result.deletedCount).toBe(1);
    expect(result.freedBytes).toBe(9);
    expect(env.deletedR2).toEqual(['zero-chg']);
    expect(env.deletedDb).toEqual(['zero-chg']);
  });

  it('duplicate media_id rows run independent delete steps (including duplicate names)', async () => {
    const env = createCleanupEnv({
      media: [
        mediaRow('dup', NOW - 100 * DAY_MS, 3),
        mediaRow('dup', NOW - 100 * DAY_MS, 5),
      ],
    });
    // force find-expired to return both rows even if filter would collapse
    const raw = env as unknown as { media: MediaRow[] };
    raw.media = [
      mediaRow('dup', NOW - 100 * DAY_MS, 3),
      mediaRow('dup', NOW - 100 * DAY_MS, 5),
    ];
    const wf = new MediaCleanupWorkflow({} as never, env as never);
    const step = mockStep();
    const result = await wf.run(
      { payload: { maxAgeDays: 1, dryRun: false } } as never,
      step as never
    );
    expect(step.names.filter((n) => n === 'delete-dup')).toHaveLength(2);
    expect(result.deletedCount).toBe(2);
    expect(result.freedBytes).toBe(8);
    expect(env.deletedR2).toEqual(['dup', 'dup']);
  });

  for (const file_size of [-1, -100, -999] as const) {
    it(`negative file_size=${file_size} preserved in freedBytes (truthy || 0)`, async () => {
      const env = createCleanupEnv({
        media: [mediaRow(`neg${file_size}`, NOW - 100 * DAY_MS, file_size)],
      });
      const wf = new MediaCleanupWorkflow({} as never, env as never);
      const dry = await wf.run(
        { payload: { maxAgeDays: 1, dryRun: true } } as never,
        mockStep() as never
      );
      expect(dry.freedBytes).toBe(file_size);
      const del = await new MediaCleanupWorkflow(
        {} as never,
        createCleanupEnv({
          media: [mediaRow(`neg${file_size}`, NOW - 100 * DAY_MS, file_size)],
        }) as never
      ).run({ payload: { maxAgeDays: 1, dryRun: false } } as never, mockStep() as never);
      expect(del.freedBytes).toBe(file_size);
    });
  }

  it('Promise.all concurrent runs over same discovered media both delete independently', async () => {
    const sharedMedia = [mediaRow('shared', NOW - 100 * DAY_MS, 11)];
    const envA = createCleanupEnv({ media: [...sharedMedia] });
    const envB = createCleanupEnv({ media: [...sharedMedia] });
    const wfA = new MediaCleanupWorkflow({} as never, envA as never);
    const wfB = new MediaCleanupWorkflow({} as never, envB as never);
    const [a, b] = await Promise.all([
      wfA.run({ payload: { maxAgeDays: 1, dryRun: false } } as never, mockStep() as never),
      wfB.run({ payload: { maxAgeDays: 1, dryRun: false } } as never, mockStep() as never),
    ]);
    expect(a.deletedCount).toBe(1);
    expect(b.deletedCount).toBe(1);
    expect(envA.deletedR2).toEqual(['shared']);
    expect(envB.deletedR2).toEqual(['shared']);
  });

  it('find-expired D1 rejection propagates (no top-level catch)', async () => {
    const env = createCleanupEnv({ findThrow: true });
    const wf = new MediaCleanupWorkflow({} as never, env as never);
    await expect(
      wf.run({ payload: { maxAgeDays: 1, dryRun: true } } as never, mockStep() as never)
    ).rejects.toThrow(/find-expired boom/);
  });
});

describe('state-compaction after #187: threshold / stage-failure / isolation', () => {
  it('explicit maxAuthChainDepth:null uses 100', async () => {
    const env = createCompactionEnv({ deepCount: 2, pruneChanges: 2, compactChanges: 1 });
    const wf = new StateCompactionWorkflow({} as never, env as never);
    await wf.run(
      { payload: { roomId: ROOM, maxAuthChainDepth: null as unknown as number } } as never,
      mockStep() as never
    );
    const findBind = env.binds.find((b) => b.sql.includes('SELECT COUNT(*)'));
    const pruneBind = env.binds.find((b) => b.sql.includes('DELETE FROM event_auth_chain'));
    expect(findBind?.args).toEqual([ROOM, 100]);
    expect(pruneBind?.args).toEqual([ROOM, 100]);
  });

  for (const depth of [-1, -50, 0.5, 1.75, Number.NaN] as const) {
    it(`binds maxAuthChainDepth=${String(depth)} exactly when prune invoked`, async () => {
      const env = createCompactionEnv({
        deepCount: 3,
        pruneChanges: 3,
        compactChanges: 0,
      });
      const wf = new StateCompactionWorkflow({} as never, env as never);
      await wf.run(
        { payload: { roomId: ROOM, maxAuthChainDepth: depth } } as never,
        mockStep() as never
      );
      const findBind = env.binds.find((b) => b.sql.includes('SELECT COUNT(*)'));
      const pruneBind = env.binds.find((b) => b.sql.includes('DELETE FROM event_auth_chain'));
      expect(findBind?.args[1]).toEqual(depth);
      expect(pruneBind?.args[1]).toEqual(depth);
    });
  }

  it('first() returning null bypasses prune (count fallback 0)', async () => {
    const env = createCompactionEnv({ returnNullFirst: true, compactChanges: 4 });
    const wf = new StateCompactionWorkflow({} as never, env as never);
    const step = mockStep();
    const result = await wf.run({ payload: { roomId: ROOM } } as never, step as never);
    expect(result.prunedAuthEntries).toBe(0);
    expect(result.compactedStateEvents).toBe(4);
    expect(env.binds.some((b) => b.sql.includes('DELETE FROM event_auth_chain'))).toBe(false);
  });

  it('negative deep-count is truthy → prune invoked', async () => {
    const env = createCompactionEnv({
      deepCount: -3,
      pruneChanges: 7,
      compactChanges: 0,
    });
    const wf = new StateCompactionWorkflow({} as never, env as never);
    const result = await wf.run({ payload: { roomId: ROOM } } as never, mockStep() as never);
    expect(result.prunedAuthEntries).toBe(7);
    expect(env.binds.some((b) => b.sql.includes('DELETE FROM event_auth_chain'))).toBe(true);
  });

  it('NaN deep-count falls back to 0 via || and skips prune', async () => {
    const env = createCompactionEnv({
      deepCount: Number.NaN,
      compactChanges: 1,
    });
    const wf = new StateCompactionWorkflow({} as never, env as never);
    const result = await wf.run({ payload: { roomId: ROOM } } as never, mockStep() as never);
    expect(result.prunedAuthEntries).toBe(0);
    expect(env.binds.some((b) => b.sql.includes('DELETE FROM event_auth_chain'))).toBe(false);
  });

  it('negative meta.changes preserved; NaN meta.changes → 0', async () => {
    const negEnv = createCompactionEnv({
      deepCount: 1,
      pruneChanges: -2,
      compactChanges: -5,
    });
    const negResult = await new StateCompactionWorkflow({} as never, negEnv as never).run(
      { payload: { roomId: ROOM } } as never,
      mockStep() as never
    );
    expect(negResult.prunedAuthEntries).toBe(-2);
    expect(negResult.compactedStateEvents).toBe(-5);

    const nanEnv = createCompactionEnv({
      deepCount: 1,
      pruneChanges: Number.NaN,
      compactChanges: Number.NaN,
    });
    const nanResult = await new StateCompactionWorkflow({} as never, nanEnv as never).run(
      { payload: { roomId: ROOM } } as never,
      mockStep() as never
    );
    expect(nanResult.prunedAuthEntries).toBe(0);
    expect(nanResult.compactedStateEvents).toBe(0);
  });

  for (const stage of ['find', 'prune', 'compact'] as const) {
    it(`throwOn=${stage} propagates at that stage`, async () => {
      const env = createCompactionEnv({
        deepCount: stage === 'find' ? 0 : 2,
        pruneChanges: 1,
        compactChanges: 1,
        throwOn: stage,
      });
      const wf = new StateCompactionWorkflow({} as never, env as never);
      await expect(
        wf.run({ payload: { roomId: ROOM } } as never, mockStep() as never)
      ).rejects.toThrow(new RegExp(`${stage} boom`));
    });
  }

  it('Promise.all concurrent runs for distinct rooms preserve bind/result isolation', async () => {
    const roomA = '!a:example.com';
    const roomB = '!b:example.com';
    const envA = createCompactionEnv({ deepCount: 2, pruneChanges: 2, compactChanges: 1 });
    const envB = createCompactionEnv({ deepCount: 0, compactChanges: 9 });
    const [ra, rb] = await Promise.all([
      new StateCompactionWorkflow({} as never, envA as never).run(
        { payload: { roomId: roomA, maxAuthChainDepth: 10 } } as never,
        mockStep() as never
      ),
      new StateCompactionWorkflow({} as never, envB as never).run(
        { payload: { roomId: roomB, maxAuthChainDepth: 50 } } as never,
        mockStep() as never
      ),
    ]);
    expect(ra).toEqual({
      roomId: roomA,
      prunedAuthEntries: 2,
      compactedStateEvents: 1,
      success: true,
    });
    expect(rb).toEqual({
      roomId: roomB,
      prunedAuthEntries: 0,
      compactedStateEvents: 9,
      success: true,
    });
    expect(envA.binds.every((b) => b.args[0] === roomA)).toBe(true);
    expect(envB.binds.every((b) => b.args[0] === roomB)).toBe(true);
  });

  it('roomId soft flood with stage-failure mid concurrent matrix stays isolated', async () => {
    const rooms = [
      '!r0:example.com',
      '!r1:example.com',
      '!r2:example.com',
      '!r3:example.com',
      '!r4:example.com',
    ];
    const results = await Promise.all(
      rooms.map(async (roomId, i) => {
        const throwOn = i === 2 ? ('prune' as const) : undefined;
        const env = createCompactionEnv({
          deepCount: 1,
          pruneChanges: i + 1,
          compactChanges: i,
          throwOn,
        });
        try {
          const r = await new StateCompactionWorkflow({} as never, env as never).run(
            { payload: { roomId } } as never,
            mockStep() as never
          );
          return { roomId, ok: true as const, r };
        } catch (e) {
          return { roomId, ok: false as const, error: (e as Error).message };
        }
      })
    );
    expect(results.filter((x) => x.ok)).toHaveLength(4);
    expect(results.find((x) => x.roomId === '!r2:example.com')).toEqual({
      roomId: '!r2:example.com',
      ok: false,
      error: 'prune boom',
    });
  });
});

describe('federation-catchup after #187: soft flood matrices', () => {
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

  it('mixed malformed/success/throw rooms soft flood aggregates only successes', async () => {
    const rooms = [
      '!ok:example.com',
      '!badjson:example.com',
      '!throw:example.com',
      '!empty:example.com',
      '!nullroot:example.com',
    ];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/version')) return new Response('ok', { status: 200 });
      if (u.includes('badjson')) return new Response('nope{', { status: 200 });
      if (u.includes('nullroot')) return new Response('null', { status: 200 });
      if (u.includes('empty')) return new Response(JSON.stringify({ events: [] }), { status: 200 });
      if (u.includes('ok')) {
        return new Response(JSON.stringify({ events: [{}, {}] }), { status: 200 });
      }
      void init;
      return new Response(JSON.stringify({ events: [{}] }), { status: 200 });
    });
    const env = createCatchupEnv({
      latestByRoom: {
        '!ok:example.com': '$a:example.com',
        '!badjson:example.com': '$b:example.com',
        '!throw:example.com': '$c:example.com',
        '!empty:example.com': '$d:example.com',
        '!nullroot:example.com': '$e:example.com',
      },
      throwRooms: new Set(['!throw:example.com']),
    });
    const result = await new FederationCatchupWorkflow({} as never, env as never).run(
      { payload: { serverName: REMOTE, roomIds: rooms } } as never,
      mockStep() as never
    );
    expect(result.backfilledEvents).toBe(2);
    expect(result.success).toBe(true);
  });

  for (const n of [0, 1, 3, 8, 16] as const) {
    it(`duplicate-room soft flood n=${n} sums independent step results`, async () => {
      const room = `!dup${n}:example.com`;
      fetchMock.mockImplementation(async (url: string) => {
        if (String(url).includes('/version')) return new Response('ok', { status: 200 });
        return new Response(JSON.stringify({ events: new Array(2).fill({}) }), { status: 200 });
      });
      const env = createCatchupEnv({ latestByRoom: { [room]: `$e${n}:example.com` } });
      const step = mockStep();
      const result = await new FederationCatchupWorkflow({} as never, env as never).run(
        { payload: { serverName: REMOTE, roomIds: Array(n).fill(room) } } as never,
        step as never
      );
      expect(result.backfilledEvents).toBe(n * 2);
      expect(step.names.filter((name) => name === `backfill-${room}`)).toHaveLength(n);
    });
  }
});

describe('media-cleanup after #187: concurrent soft flood matrices', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('dryRun vs delete concurrent soft flood across ages stays isolated', async () => {
    const ages = [1, 7, 30, 90];
    const results = await Promise.all(
      ages.map(async (maxAgeDays) => {
        const env = createCleanupEnv({
          media: [
            mediaRow(`m-${maxAgeDays}`, NOW - (maxAgeDays + 1) * DAY_MS, maxAgeDays),
            mediaRow(`keep-${maxAgeDays}`, NOW - 1, 1),
          ],
        });
        const dry = await new MediaCleanupWorkflow({} as never, env as never).run(
          { payload: { maxAgeDays, dryRun: true } } as never,
          mockStep() as never
        );
        const env2 = createCleanupEnv({
          media: [
            mediaRow(`m-${maxAgeDays}`, NOW - (maxAgeDays + 1) * DAY_MS, maxAgeDays),
            mediaRow(`keep-${maxAgeDays}`, NOW - 1, 1),
          ],
        });
        const del = await new MediaCleanupWorkflow({} as never, env2 as never).run(
          { payload: { maxAgeDays, dryRun: false } } as never,
          mockStep() as never
        );
        return { maxAgeDays, dry, del, deletedR2: env2.deletedR2 };
      })
    );
    for (const r of results) {
      expect(r.dry.deletedCount).toBe(1);
      expect(r.dry.freedBytes).toBe(r.maxAgeDays);
      expect(r.del.deletedCount).toBe(1);
      expect(r.del.freedBytes).toBe(r.maxAgeDays);
      expect(r.deletedR2).toEqual([`m-${r.maxAgeDays}`]);
    }
  });

  it('R2/D1 interleaved fail soft flood under Promise.all keeps per-run tallies', async () => {
    const configs = [
      { id: 'ok', deleteFailIds: undefined, d1FailIds: undefined, expectDeleted: 1 },
      { id: 'r2', deleteFailIds: new Set(['x']), d1FailIds: undefined, expectDeleted: 0 },
      { id: 'd1', deleteFailIds: undefined, d1FailIds: new Set(['x']), expectDeleted: 0 },
    ] as const;
    const results = await Promise.all(
      configs.map(async (c) => {
        const env = createCleanupEnv({
          media: [mediaRow('x', NOW - 100 * DAY_MS, 5)],
          deleteFailIds: c.deleteFailIds,
          d1FailIds: c.d1FailIds,
        });
        const r = await new MediaCleanupWorkflow({} as never, env as never).run(
          { payload: { maxAgeDays: 1, dryRun: false } } as never,
          mockStep() as never
        );
        return { id: c.id, r, expectDeleted: c.expectDeleted };
      })
    );
    for (const row of results) {
      expect(row.r.deletedCount).toBe(row.expectDeleted);
    }
  });
});

describe('state-compaction after #187: depth soft flood with throwOn harness', () => {
  for (const depth of [0, 1, 10, 100, 1000] as const) {
    it(`depth=${depth} find-throw soft flood never reaches prune/compact`, async () => {
      const env = createCompactionEnv({ deepCount: 5, throwOn: 'find' });
      await expect(
        new StateCompactionWorkflow({} as never, env as never).run(
          { payload: { roomId: ROOM, maxAuthChainDepth: depth } } as never,
          mockStep() as never
        )
      ).rejects.toThrow(/find boom/);
      expect(env.binds.filter((b) => b.sql.includes('DELETE'))).toHaveLength(0);
    });
  }
});
