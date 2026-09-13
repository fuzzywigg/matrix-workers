import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

import { StateCompactionWorkflow } from '../src/workflows/StateCompactionWorkflow';

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

function createCompactionEnv(opts: {
  deepCount?: number;
  pruneChanges?: number;
  compactChanges?: number;
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
                  return { count: opts.deepCount ?? 0 } as T;
                }
                return null;
              },
              async run() {
                if (sql.includes('DELETE FROM event_auth_chain')) {
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
  return env as unknown as {
    DB: D1Database;
    binds: Array<{ sql: string; args: unknown[] }>;
  };
}

describe('StateCompactionWorkflow prune/compact edge paths after #65', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults maxAuthChainDepth to 100; skips prune when count===0; still compacts state', async () => {
    const env = createCompactionEnv({ deepCount: 0, compactChanges: 3 });
    const step = mockStep();
    const wf = new StateCompactionWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { roomId: '!r:example.com' } } as any,
      step as any
    );
    expect(result).toEqual({
      roomId: '!r:example.com',
      prunedAuthEntries: 0,
      compactedStateEvents: 3,
      success: true,
    });
    expect(step.names).toEqual([
      'find-redundant-auth',
      'prune-auth-chain',
      'compact-state',
    ]);
    const countBind = env.binds.find((b) => b.sql.includes('SELECT COUNT(*)'));
    expect(countBind?.args).toEqual(['!r:example.com', 100]);
    expect(env.binds.some((b) => b.sql.includes('DELETE FROM event_auth_chain'))).toBe(false);
    const compactBind = env.binds.find((b) => b.sql.includes('DELETE FROM room_state'));
    expect(compactBind?.args).toEqual(['!r:example.com', '!r:example.com']);
  });

  it('prunes when deepCount>0 using explicit maxAuthChainDepth; returns meta.changes', async () => {
    const env = createCompactionEnv({
      deepCount: 12,
      pruneChanges: 12,
      compactChanges: 0,
    });
    const wf = new StateCompactionWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { roomId: '!r:example.com', maxAuthChainDepth: 50 } } as any,
      mockStep() as any
    );
    expect(result).toEqual({
      roomId: '!r:example.com',
      prunedAuthEntries: 12,
      compactedStateEvents: 0,
      success: true,
    });
    const countBind = env.binds.find((b) => b.sql.includes('SELECT COUNT(*)'));
    expect(countBind?.args).toEqual(['!r:example.com', 50]);
    const pruneBind = env.binds.find((b) => b.sql.includes('DELETE FROM event_auth_chain'));
    expect(pruneBind?.args).toEqual(['!r:example.com', 50]);
  });

  it('treats nullish count / meta.changes as 0', async () => {
    const binds: Array<{ sql: string; args: unknown[] }> = [];
    const env = {
      binds,
      DB: {
        prepare(sql: string) {
          return {
            bind(...args: unknown[]) {
              binds.push({ sql, args });
              return {
                async first() {
                  if (sql.includes('SELECT COUNT(*)')) return { count: undefined };
                  return null;
                },
                async run() {
                  return { meta: {} };
                },
              };
            },
          };
        },
      },
    };
    const wf = new StateCompactionWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { roomId: '!r:example.com', maxAuthChainDepth: 1 } } as any,
      mockStep() as any
    );
    expect(result.prunedAuthEntries).toBe(0);
    expect(result.compactedStateEvents).toBe(0);
    expect(result.success).toBe(true);
  });

  it('boundary: depth > maxDepth counted; maxDepth=0 still binds 0', async () => {
    const env = createCompactionEnv({ deepCount: 1, pruneChanges: 1, compactChanges: 2 });
    const wf = new StateCompactionWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { roomId: '!r:example.com', maxAuthChainDepth: 0 } } as any,
      mockStep() as any
    );
    expect(env.binds[0].args[1]).toBe(0);
    expect(result.prunedAuthEntries).toBe(1);
    expect(result.compactedStateEvents).toBe(2);
  });
});
