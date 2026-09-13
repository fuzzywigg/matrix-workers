import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

import { MediaCleanupWorkflow } from '../src/workflows/MediaCleanupWorkflow';

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

type MediaRow = {
  media_id: string;
  content_type: string;
  file_size: number;
  created_at: number;
};

function createCleanupEnv(opts: {
  media?: MediaRow[];
  deleteFailIds?: Set<string>;
}) {
  const media = [...(opts.media ?? [])];
  const deletedR2: string[] = [];
  const deletedDb: string[] = [];
  let lastCutoff: number | undefined;

  const env = {
    deletedR2,
    deletedDb,
    getLastCutoff: () => lastCutoff,
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
    getLastCutoff: () => number | undefined;
  };
}

function mockStep() {
  return {
    async do(_name: string, fn: () => Promise<unknown>) {
      return fn();
    },
  };
}

describe('MediaCleanupWorkflow cutoff clock boundaries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults maxAgeDays=90 and dryRun=false; cutoff = NOW − 90d', async () => {
    const env = createCleanupEnv({ media: [] });
    const wf = new MediaCleanupWorkflow({} as any, env as any);
    const result = await wf.run({ payload: {} } as any, mockStep() as any);
    expect(env.getLastCutoff()).toBe(NOW - 90 * DAY_MS);
    expect(result).toEqual({
      deletedCount: 0,
      freedBytes: 0,
      dryRun: false,
      success: true,
    });
  });

  it('pins cutoff at created_at === cutoff − 1 (kept for delete) vs === cutoff (excluded)', async () => {
    const maxAgeDays = 30;
    const cutoff = NOW - maxAgeDays * DAY_MS;
    const env = createCleanupEnv({
      media: [
        {
          media_id: 'old',
          content_type: 'image/png',
          file_size: 100,
          created_at: cutoff - 1,
        },
        {
          media_id: 'boundary',
          content_type: 'image/png',
          file_size: 50,
          created_at: cutoff,
        },
        {
          media_id: 'fresh',
          content_type: 'image/png',
          file_size: 25,
          created_at: cutoff + 1,
        },
      ],
    });
    const wf = new MediaCleanupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { maxAgeDays, dryRun: false } } as any,
      mockStep() as any
    );
    expect(env.getLastCutoff()).toBe(cutoff);
    expect(result).toEqual({
      deletedCount: 1,
      freedBytes: 100,
      dryRun: false,
      success: true,
    });
    expect(env.deletedR2).toEqual(['old']);
    expect(env.deletedDb).toEqual(['old']);
  });

  it('dryRun returns counts without deleting; uses default 90d when maxAgeDays omitted', async () => {
    const cutoff = NOW - 90 * DAY_MS;
    const env = createCleanupEnv({
      media: [
        {
          media_id: 'a',
          content_type: 'a/b',
          file_size: 10,
          created_at: cutoff - 1,
        },
        {
          media_id: 'b',
          content_type: 'a/b',
          file_size: 20,
          created_at: cutoff - 5,
        },
      ],
    });
    const wf = new MediaCleanupWorkflow({} as any, env as any);
    const result = await wf.run({ payload: { dryRun: true } } as any, mockStep() as any);
    expect(result).toEqual({
      deletedCount: 2,
      freedBytes: 30,
      dryRun: true,
      success: true,
    });
    expect(env.deletedR2).toEqual([]);
    expect(env.deletedDb).toEqual([]);
  });

  it('treats nullish file_size as 0 when summing freedBytes in dryRun', async () => {
    const cutoff = NOW - 1 * DAY_MS;
    const env = createCleanupEnv({
      media: [
        {
          media_id: 'n',
          content_type: 'x',
          file_size: undefined as unknown as number,
          created_at: cutoff - 1,
        },
      ],
    });
    const wf = new MediaCleanupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { maxAgeDays: 1, dryRun: true } } as any,
      mockStep() as any
    );
    expect(result).toEqual({
      deletedCount: 1,
      freedBytes: 0,
      dryRun: true,
      success: true,
    });
  });

  it('skips failed R2/D1 deletes and continues; only successful ones count', async () => {
    const cutoff = NOW - 7 * DAY_MS;
    const env = createCleanupEnv({
      media: [
        {
          media_id: 'fail',
          content_type: 'x',
          file_size: 99,
          created_at: cutoff - 1,
        },
        {
          media_id: 'ok',
          content_type: 'x',
          file_size: 11,
          created_at: cutoff - 2,
        },
      ],
      deleteFailIds: new Set(['fail']),
    });
    const wf = new MediaCleanupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { maxAgeDays: 7, dryRun: false } } as any,
      mockStep() as any
    );
    expect(result).toEqual({
      deletedCount: 1,
      freedBytes: 11,
      dryRun: false,
      success: true,
    });
    expect(env.deletedR2).toEqual(['ok']);
    expect(env.deletedDb).toEqual(['ok']);
  });

  it('recomputes cutoff after mid-flight clock advance before run', async () => {
    vi.setSystemTime(NOW + DAY_MS);
    const env = createCleanupEnv({ media: [] });
    const wf = new MediaCleanupWorkflow({} as any, env as any);
    await wf.run({ payload: { maxAgeDays: 1 } } as any, mockStep() as any);
    expect(env.getLastCutoff()).toBe(NOW + DAY_MS - 1 * DAY_MS);
  });
});

describe('MediaCleanupWorkflow delete/cutoff edges after #71', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function mockStepWithNames() {
    const names: string[] = [];
    return {
      names,
      async do(name: string, fn: () => Promise<unknown>) {
        names.push(name);
        return fn();
      },
    };
  }

  it('maxAgeDays:0 sets cutoff === NOW; only created_at < NOW selected', async () => {
    const env = createCleanupEnv({
      media: [
        {
          media_id: 'eq',
          content_type: 'x',
          file_size: 5,
          created_at: NOW,
        },
        {
          media_id: 'old',
          content_type: 'x',
          file_size: 7,
          created_at: NOW - 1,
        },
      ],
    });
    const step = mockStepWithNames();
    const wf = new MediaCleanupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { maxAgeDays: 0, dryRun: false } } as any,
      step as any
    );
    expect(env.getLastCutoff()).toBe(NOW);
    expect(result).toEqual({
      deletedCount: 1,
      freedBytes: 7,
      dryRun: false,
      success: true,
    });
    expect(step.names).toEqual(['find-expired', 'delete-old']);
    expect(env.deletedR2).toEqual(['old']);
  });

  it('treats nullish file_size as 0 on successful non-dryRun delete', async () => {
    const env = createCleanupEnv({
      media: [
        {
          media_id: 'n',
          content_type: 'x',
          file_size: undefined as unknown as number,
          created_at: NOW - DAY_MS - 1,
        },
      ],
    });
    const wf = new MediaCleanupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { maxAgeDays: 1, dryRun: false } } as any,
      mockStep() as any
    );
    expect(result).toEqual({
      deletedCount: 1,
      freedBytes: 0,
      dryRun: false,
      success: true,
    });
    expect(env.deletedR2).toEqual(['n']);
    expect(env.deletedDb).toEqual(['n']);
  });

  it('skips when D1 DELETE throws after R2 ok and continues with later ids', async () => {
    const media: MediaRow[] = [
      {
        media_id: 'fail-db',
        content_type: 'x',
        file_size: 50,
        created_at: NOW - 2 * DAY_MS,
      },
      {
        media_id: 'ok',
        content_type: 'x',
        file_size: 10,
        created_at: NOW - 2 * DAY_MS,
      },
    ];
    const deletedR2: string[] = [];
    const deletedDb: string[] = [];
    let lastCutoff: number | undefined;

    const env = {
      deletedR2,
      deletedDb,
      getLastCutoff: () => lastCutoff,
      DB: {
        prepare(sql: string) {
          return {
            bind(...args: unknown[]) {
              return {
                async all<T>() {
                  if (sql.includes('FROM media') && sql.includes('created_at <')) {
                    lastCutoff = args[0] as number;
                    return {
                      results: media.filter((m) => m.created_at < lastCutoff!) as T[],
                    };
                  }
                  return { results: [] };
                },
                async run() {
                  if (sql.includes('DELETE FROM media')) {
                    const id = args[0] as string;
                    if (id === 'fail-db') throw new Error('d1 fail');
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
          deletedR2.push(id);
        },
      },
    };

    const wf = new MediaCleanupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { maxAgeDays: 1, dryRun: false } } as any,
      mockStep() as any
    );
    expect(result).toEqual({
      deletedCount: 1,
      freedBytes: 10,
      dryRun: false,
      success: true,
    });
    // R2 delete still attempted for fail-db before D1 throws
    expect(deletedR2).toEqual(['fail-db', 'ok']);
    expect(deletedDb).toEqual(['ok']);
  });

  it('empty expired set with dryRun:false returns zeros and success', async () => {
    const step = mockStepWithNames();
    const env = createCleanupEnv({ media: [] });
    const wf = new MediaCleanupWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { maxAgeDays: 30, dryRun: false } } as any,
      step as any
    );
    expect(result).toEqual({
      deletedCount: 0,
      freedBytes: 0,
      dryRun: false,
      success: true,
    });
    expect(step.names).toEqual(['find-expired']);
  });
});
