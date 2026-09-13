import { describe, it, expect, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

import { StateCompactionWorkflow } from '../src/workflows/StateCompactionWorkflow';

type SqlLog = { sql: string; args: unknown[] };

function createCompactionEnv(opts: {
  deepAuthCount?: number;
  pruneChanges?: number;
  compactChanges?: number;
}) {
  const sqlLog: SqlLog[] = [];
  let lastMaxDepth: number | undefined;

  const env = {
    sqlLog,
    getLastMaxDepth: () => lastMaxDepth,
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                sqlLog.push({ sql, args });
                if (sql.includes('FROM event_auth_chain') && sql.includes('depth >')) {
                  lastMaxDepth = args[1] as number;
                  return { count: opts.deepAuthCount ?? 0 } as T;
                }
                return null as T;
              },
              async run() {
                sqlLog.push({ sql, args });
                if (sql.includes('DELETE FROM event_auth_chain')) {
                  lastMaxDepth = args[1] as number;
                  return { meta: { changes: opts.pruneChanges ?? 0 } };
                }
                if (sql.includes('DELETE FROM room_state')) {
                  return { meta: { changes: opts.compactChanges ?? 0 } };
                }
                return { meta: { changes: 0 } };
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

describe('StateCompactionWorkflow', () => {
  it('defaults maxAuthChainDepth to 100 when omitted', async () => {
    const env = createCompactionEnv({ deepAuthCount: 0, compactChanges: 0 });
    const names: string[] = [];
    const wf = new StateCompactionWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { roomId: '!r:ex.com' } } as any,
      mockStep(names) as any
    );
    expect(env.getLastMaxDepth()).toBe(100);
    expect(result).toEqual({
      roomId: '!r:ex.com',
      prunedAuthEntries: 0,
      compactedStateEvents: 0,
      success: true,
    });
    expect(names).toEqual(['find-redundant-auth', 'prune-auth-chain', 'compact-state']);
  });

  it('skips DELETE on event_auth_chain when deep count is 0', async () => {
    const env = createCompactionEnv({ deepAuthCount: 0, compactChanges: 2 });
    const wf = new StateCompactionWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { roomId: '!r:ex.com', maxAuthChainDepth: 50 } } as any,
      mockStep() as any
    );
    expect(env.getLastMaxDepth()).toBe(50);
    expect(env.sqlLog.some((l) => l.sql.includes('DELETE FROM event_auth_chain'))).toBe(
      false
    );
    expect(result.prunedAuthEntries).toBe(0);
    expect(result.compactedStateEvents).toBe(2);
  });

  it('prunes when deep auth count > 0 and returns meta.changes', async () => {
    const env = createCompactionEnv({
      deepAuthCount: 7,
      pruneChanges: 7,
      compactChanges: 3,
    });
    const wf = new StateCompactionWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { roomId: '!big:ex.com', maxAuthChainDepth: 20 } } as any,
      mockStep() as any
    );
    const prune = env.sqlLog.find((l) => l.sql.includes('DELETE FROM event_auth_chain'));
    expect(prune?.args).toEqual(['!big:ex.com', 20]);
    expect(result).toEqual({
      roomId: '!big:ex.com',
      prunedAuthEntries: 7,
      compactedStateEvents: 3,
      success: true,
    });
  });

  it('treats nullish COUNT first() as 0 (no prune)', async () => {
    const env = createCompactionEnv({});
    // Override first to return null for count
    const originalPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql: string) => {
      const stmt = originalPrepare(sql);
      return {
        bind(...args: unknown[]) {
          const bound = stmt.bind(...args);
          return {
            async first<T>() {
              if (sql.includes('COUNT(*)')) return null as T;
              return bound.first<T>();
            },
            async run() {
              return bound.run();
            },
          };
        },
      };
    };
    const wf = new StateCompactionWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { roomId: '!r:ex.com' } } as any,
      mockStep() as any
    );
    expect(result.prunedAuthEntries).toBe(0);
    expect(env.sqlLog.some((l) => l.sql.includes('DELETE FROM event_auth_chain'))).toBe(
      false
    );
  });

  it('passes roomId twice to room_state compact DELETE', async () => {
    const env = createCompactionEnv({ deepAuthCount: 0, compactChanges: 1 });
    const wf = new StateCompactionWorkflow({} as any, env as any);
    await wf.run({ payload: { roomId: '!x:ex.com' } } as any, mockStep() as any);
    const compact = env.sqlLog.find((l) => l.sql.includes('DELETE FROM room_state'));
    expect(compact?.args).toEqual(['!x:ex.com', '!x:ex.com']);
  });

  it('treats missing meta.changes as 0 for prune and compact', async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return {
                async first() {
                  if (sql.includes('COUNT(*)')) return { count: 1 };
                  return null;
                },
                async run() {
                  return { meta: {} }; // no changes field
                },
              };
            },
          };
        },
      },
    };
    const wf = new StateCompactionWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { roomId: '!r:ex.com' } } as any,
      mockStep() as any
    );
    expect(result.prunedAuthEntries).toBe(0);
    expect(result.compactedStateEvents).toBe(0);
    expect(result.success).toBe(true);
  });
});
