/**
 * TOKENMAXX HEAVY leftovers after #170/#171 — MediaCleanup + StateCompaction workflows.
 * Complements media-cleanup-workflow.test.ts + state-compaction-workflow.test.ts.
 * Focus: maxAgeDays/cutoff soft floods, dry-run vs delete parity, R2/D1 fail-continue
 * races, nullish file_size, auth-chain depth soft floods, nullish meta.changes,
 * and roomId binding soft floods.
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

import { MediaCleanupWorkflow } from '../src/workflows/MediaCleanupWorkflow';
import { StateCompactionWorkflow } from '../src/workflows/StateCompactionWorkflow';

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
  return {
    names,
    async do(name: string, optsOrFn: unknown, maybeFn?: unknown) {
      names.push(name);
      const fn = typeof optsOrFn === 'function' ? optsOrFn : maybeFn;
      return (fn as () => Promise<unknown>)();
    },
  };
}

function createCleanupEnv(opts: {
  media?: MediaRow[];
  deleteFailIds?: Set<string>;
  d1FailIds?: Set<string>;
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
                  return { meta: { changes: 1 } };
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
  deepCount?: number | null;
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
                  if (opts.deepCount === null) return { count: null } as T;
                  return { count: opts.deepCount ?? 0 } as T;
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

describe('media-cleanup leftovers maxAgeDays / cutoff soft flood after #171', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const ages = [0, 1, 7, 14, 30, 60, 90, 180, 365];

  for (const maxAgeDays of ages) {
    it(`cutoff for maxAgeDays=${maxAgeDays}`, async () => {
      const env = createCleanupEnv({
        media: [
          {
            media_id: 'old',
            content_type: 'image/png',
            file_size: 10,
            created_at: NOW - maxAgeDays * DAY_MS - 1,
          },
          {
            media_id: 'edge',
            content_type: 'image/png',
            file_size: 20,
            created_at: NOW - maxAgeDays * DAY_MS,
          },
          {
            media_id: 'fresh',
            content_type: 'image/png',
            file_size: 30,
            created_at: NOW - Math.max(0, maxAgeDays - 1) * DAY_MS,
          },
        ],
      });
      const wf = new MediaCleanupWorkflow({} as any, env as any);
      const result = await wf.run(
        { payload: { maxAgeDays, dryRun: true } } as any,
        mockStep() as any
      );
      expect(env.getLastCutoff()).toBe(NOW - maxAgeDays * DAY_MS);
      // only created_at < cutoff
      expect(result.deletedCount).toBe(1);
      expect(result.freedBytes).toBe(10);
      expect(result.dryRun).toBe(true);
      expect(env.deletedR2).toHaveLength(0);
    });
  }

  it('default maxAgeDays=90 when omitted soft flood across dryRun flags', async () => {
    for (const dryRun of [true, false, undefined]) {
      const env = createCleanupEnv({
        media: [
          {
            media_id: 'old90',
            content_type: 'x',
            file_size: 5,
            created_at: NOW - 91 * DAY_MS,
          },
        ],
      });
      const wf = new MediaCleanupWorkflow({} as any, env as any);
      const result = await wf.run(
        { payload: dryRun === undefined ? {} : { dryRun } } as any,
        mockStep() as any
      );
      expect(env.getLastCutoff()).toBe(NOW - 90 * DAY_MS);
      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(dryRun ?? false);
      if (dryRun) {
        expect(env.deletedR2).toHaveLength(0);
      } else {
        expect(env.deletedR2).toEqual(['old90']);
      }
    }
  });
});

describe('media-cleanup leftovers dry-run / delete / fail-continue soft flood after #171', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('dryRun vs delete parity soft flood across media sets', async () => {
    for (const n of [0, 1, 3, 8, 16]) {
      const media: MediaRow[] = Array.from({ length: n }, (_, i) => ({
        media_id: `m${i}`,
        content_type: 'x',
        file_size: (i + 1) * 10,
        created_at: NOW - 100 * DAY_MS,
      }));
      const dryEnv = createCleanupEnv({ media: [...media] });
      const delEnv = createCleanupEnv({ media: [...media] });
      const dry = await new MediaCleanupWorkflow({} as any, dryEnv as any).run(
        { payload: { maxAgeDays: 30, dryRun: true } } as any,
        mockStep() as any
      );
      const del = await new MediaCleanupWorkflow({} as any, delEnv as any).run(
        { payload: { maxAgeDays: 30, dryRun: false } } as any,
        mockStep() as any
      );
      const expectedBytes = media.reduce((s, m) => s + m.file_size, 0);
      expect(dry).toEqual({
        deletedCount: n,
        freedBytes: expectedBytes,
        dryRun: true,
        success: true,
      });
      expect(del).toEqual({
        deletedCount: n,
        freedBytes: expectedBytes,
        dryRun: false,
        success: true,
      });
      expect(dryEnv.deletedR2).toHaveLength(0);
      expect(delEnv.deletedR2).toEqual(media.map((m) => m.media_id));
      expect(delEnv.deletedDb).toEqual(media.map((m) => m.media_id));
    }
  });

  it('nullish file_size soft flood treated as 0', async () => {
    for (const file_size of [undefined, null, 0, Number.NaN] as unknown as number[]) {
      const env = createCleanupEnv({
        media: [
          {
            media_id: `fs-${String(file_size)}`,
            content_type: 'x',
            file_size,
            created_at: NOW - 100 * DAY_MS,
          },
        ],
      });
      const wf = new MediaCleanupWorkflow({} as any, env as any);
      const dry = await wf.run(
        { payload: { maxAgeDays: 1, dryRun: true } } as any,
        mockStep() as any
      );
      expect(dry.freedBytes).toBe(0);
      const env2 = createCleanupEnv({
        media: [
          {
            media_id: `fs2-${String(file_size)}`,
            content_type: 'x',
            file_size,
            created_at: NOW - 100 * DAY_MS,
          },
        ],
      });
      const del = await new MediaCleanupWorkflow({} as any, env2 as any).run(
        { payload: { maxAgeDays: 1, dryRun: false } } as any,
        mockStep() as any
      );
      expect(del.freedBytes).toBe(0);
      expect(del.deletedCount).toBe(1);
    }
  });

  it('R2 fail-continue soft flood across interleaved failures', async () => {
    const media: MediaRow[] = Array.from({ length: 12 }, (_, i) => ({
      media_id: `id-${i}`,
      content_type: 'x',
      file_size: 5,
      created_at: NOW - 100 * DAY_MS,
    }));
    const fail = new Set(media.filter((_, i) => i % 4 === 0).map((m) => m.media_id));
    const env = createCleanupEnv({ media, deleteFailIds: fail });
    const step = mockStep();
    const wf = new MediaCleanupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { maxAgeDays: 1, dryRun: false } } as any,
      step as any
    );
    expect(result.deletedCount).toBe(12 - fail.size);
    expect(result.freedBytes).toBe((12 - fail.size) * 5);
    expect(env.deletedR2).toEqual(
      media.filter((m) => !fail.has(m.media_id)).map((m) => m.media_id)
    );
    expect(step.names[0]).toBe('find-expired');
    expect(step.names.filter((n) => n.startsWith('delete-'))).toHaveLength(12);
  });

  it('D1 fail after R2 ok soft flood continues', async () => {
    const media: MediaRow[] = Array.from({ length: 6 }, (_, i) => ({
      media_id: `d1-${i}`,
      content_type: 'x',
      file_size: 8,
      created_at: NOW - 100 * DAY_MS,
    }));
    const d1Fail = new Set(['d1-1', 'd1-4']);
    const env = createCleanupEnv({ media, d1FailIds: d1Fail });
    const wf = new MediaCleanupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { maxAgeDays: 1, dryRun: false } } as any,
      mockStep() as any
    );
    expect(result.deletedCount).toBe(4);
    expect(env.deletedR2).toEqual(media.map((m) => m.media_id)); // R2 attempted all
    expect(env.deletedDb).toEqual(
      media.filter((m) => !d1Fail.has(m.media_id)).map((m) => m.media_id)
    );
  });

  it('empty expired soft flood with various ages', async () => {
    for (const maxAgeDays of [0, 1, 90]) {
      const env = createCleanupEnv({
        media: [
          {
            media_id: 'fresh',
            content_type: 'x',
            file_size: 1,
            created_at: NOW,
          },
        ],
      });
      const step = mockStep();
      const wf = new MediaCleanupWorkflow({} as any, env as any);
      const result = await wf.run(
        { payload: { maxAgeDays, dryRun: false } } as any,
        step as any
      );
      expect(result).toEqual({
        deletedCount: 0,
        freedBytes: 0,
        dryRun: false,
        success: true,
      });
      expect(step.names).toEqual(['find-expired']);
    }
  });

  it('delete step names include media_id soft flood', async () => {
    const ids = ['a', 'b/c', 'd:e', 'f g', 'mxc-like'];
    const env = createCleanupEnv({
      media: ids.map((media_id) => ({
        media_id,
        content_type: 'x',
        file_size: 1,
        created_at: NOW - 100 * DAY_MS,
      })),
    });
    const step = mockStep();
    const wf = new MediaCleanupWorkflow({} as any, env as any);
    await wf.run({ payload: { maxAgeDays: 1, dryRun: false } } as any, step as any);
    for (const id of ids) {
      expect(step.names).toContain(`delete-${id}`);
    }
  });
});

describe('state-compaction leftovers depth / nullish / room soft flood after #171', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const depths = [0, 1, 10, 50, 99, 100, 101, 250];

  for (const maxAuthChainDepth of depths) {
    it(`binds maxAuthChainDepth=${maxAuthChainDepth} for find+prune`, async () => {
      const env = createCompactionEnv({
        deepCount: 5,
        pruneChanges: 5,
        compactChanges: 2,
      });
      const step = mockStep();
      const wf = new StateCompactionWorkflow({} as any, env as any);
      const result = await wf.run(
        { payload: { roomId: ROOM, maxAuthChainDepth } } as any,
        step as any
      );
      expect(result).toEqual({
        roomId: ROOM,
        prunedAuthEntries: 5,
        compactedStateEvents: 2,
        success: true,
      });
      expect(step.names).toEqual([
        'find-redundant-auth',
        'prune-auth-chain',
        'compact-state',
      ]);
      const findBind = env.binds.find((b) => b.sql.includes('SELECT COUNT(*)'));
      const pruneBind = env.binds.find((b) => b.sql.includes('DELETE FROM event_auth_chain'));
      expect(findBind?.args).toEqual([ROOM, maxAuthChainDepth]);
      expect(pruneBind?.args).toEqual([ROOM, maxAuthChainDepth]);
    });
  }

  it('defaults maxAuthChainDepth=100 when omitted soft flood', async () => {
    for (const deepCount of [0, 1, 10]) {
      const env = createCompactionEnv({
        deepCount,
        pruneChanges: deepCount,
        compactChanges: 3,
      });
      const wf = new StateCompactionWorkflow({} as any, env as any);
      const result = await wf.run({ payload: { roomId: ROOM } } as any, mockStep() as any);
      expect(result.prunedAuthEntries).toBe(deepCount === 0 ? 0 : deepCount);
      const findBind = env.binds.find((b) => b.sql.includes('SELECT COUNT(*)'));
      expect(findBind?.args[1]).toBe(100);
      if (deepCount === 0) {
        expect(env.binds.some((b) => b.sql.includes('DELETE FROM event_auth_chain'))).toBe(
          false
        );
      }
    }
  });

  it('nullish count / meta.changes soft flood → 0', async () => {
    const cases: Array<{
      deepCount: number | null;
      pruneChanges?: number | null;
      compactChanges?: number | null;
      expectPruned: number;
      expectCompact: number;
    }> = [
      { deepCount: null, compactChanges: null, expectPruned: 0, expectCompact: 0 },
      { deepCount: 0, compactChanges: undefined, expectPruned: 0, expectCompact: 0 },
      {
        deepCount: 3,
        pruneChanges: null,
        compactChanges: null,
        expectPruned: 0,
        expectCompact: 0,
      },
      {
        deepCount: 3,
        pruneChanges: undefined,
        compactChanges: undefined,
        expectPruned: 0,
        expectCompact: 0,
      },
      {
        deepCount: 2,
        pruneChanges: 2,
        compactChanges: 0,
        expectPruned: 2,
        expectCompact: 0,
      },
    ];

    for (const c of cases) {
      const env = createCompactionEnv({
        deepCount: c.deepCount,
        pruneChanges: c.pruneChanges,
        compactChanges: c.compactChanges,
      });
      const wf = new StateCompactionWorkflow({} as any, env as any);
      const result = await wf.run(
        { payload: { roomId: ROOM, maxAuthChainDepth: 10 } } as any,
        mockStep() as any
      );
      expect(result.prunedAuthEntries).toBe(c.expectPruned);
      expect(result.compactedStateEvents).toBe(c.expectCompact);
      expect(result.success).toBe(true);
    }
  });

  it('roomId soft flood binds both compact placeholders', async () => {
    const rooms = [
      '!a:example.com',
      '!b/c:example.com',
      '!space:example.com',
      '!r:example.com',
    ];
    for (const roomId of rooms) {
      const env = createCompactionEnv({
        deepCount: 0,
        compactChanges: 1,
      });
      const wf = new StateCompactionWorkflow({} as any, env as any);
      const result = await wf.run({ payload: { roomId } } as any, mockStep() as any);
      expect(result.roomId).toBe(roomId);
      const compact = env.binds.find((b) => b.sql.includes('DELETE FROM room_state'));
      expect(compact?.args).toEqual([roomId, roomId]);
    }
  });

  it('skips prune SQL when deepCount===0 soft flood across depths', async () => {
    for (const maxAuthChainDepth of [0, 1, 100]) {
      const env = createCompactionEnv({ deepCount: 0, compactChanges: 4 });
      const wf = new StateCompactionWorkflow({} as any, env as any);
      await wf.run(
        { payload: { roomId: ROOM, maxAuthChainDepth } } as any,
        mockStep() as any
      );
      expect(env.binds.some((b) => b.sql.includes('DELETE FROM event_auth_chain'))).toBe(
        false
      );
      expect(env.binds.some((b) => b.sql.includes('DELETE FROM room_state'))).toBe(true);
    }
  });

  it('compact GROUP BY SQL shape soft flood', async () => {
    const env = createCompactionEnv({ deepCount: 0, compactChanges: 7 });
    const wf = new StateCompactionWorkflow({} as any, env as any);
    await wf.run({ payload: { roomId: ROOM } } as any, mockStep() as any);
    const compact = env.binds.find((b) => b.sql.includes('DELETE FROM room_state'));
    expect(compact?.sql).toMatch(/GROUP BY event_type, state_key/);
    expect(compact?.sql).toMatch(/SELECT MAX\(rowid\)/);
  });
});
