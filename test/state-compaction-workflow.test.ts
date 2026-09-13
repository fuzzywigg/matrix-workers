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

type AuthChainRow = { room_id: string; depth: number };
type RoomStateRow = {
  room_id: string;
  rowid: number;
  event_type: string;
  state_key: string;
};

function createCompactionEnv(opts: {
  authChain?: AuthChainRow[];
  roomState?: RoomStateRow[];
}) {
  const authChain = [...(opts.authChain ?? [])];
  const roomState = [...(opts.roomState ?? [])];
  const queries: Array<{ sql: string; args: unknown[] }> = [];
  let lastCountDepth: number | undefined;
  let lastDeleteDepth: number | undefined;

  const env = {
    queries,
    getLastCountDepth: () => lastCountDepth,
    getLastDeleteDepth: () => lastDeleteDepth,
    authChain,
    roomState,
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            queries.push({ sql, args });
            return {
              async first<T>() {
                if (
                  sql.includes('COUNT(*)') &&
                  sql.includes('event_auth_chain') &&
                  sql.includes('depth >')
                ) {
                  const [roomId, maxDepth] = args as [string, number];
                  lastCountDepth = maxDepth;
                  const count = authChain.filter(
                    (r) => r.room_id === roomId && r.depth > maxDepth
                  ).length;
                  return { count } as T;
                }
                return null;
              },
              async run() {
                if (sql.includes('DELETE FROM event_auth_chain')) {
                  const [roomId, maxDepth] = args as [string, number];
                  lastDeleteDepth = maxDepth;
                  let changes = 0;
                  for (let i = authChain.length - 1; i >= 0; i--) {
                    const row = authChain[i];
                    if (row.room_id === roomId && row.depth > maxDepth) {
                      authChain.splice(i, 1);
                      changes++;
                    }
                  }
                  return { meta: { changes } };
                }
                if (sql.includes('DELETE FROM room_state')) {
                  const [roomId] = args as [string];
                  // Keep MAX(rowid) per (event_type, state_key) for room
                  const keep = new Map<string, number>();
                  for (const row of roomState) {
                    if (row.room_id !== roomId) continue;
                    const key = `${row.event_type}\0${row.state_key}`;
                    const prev = keep.get(key);
                    if (prev === undefined || row.rowid > prev) {
                      keep.set(key, row.rowid);
                    }
                  }
                  const keepIds = new Set(keep.values());
                  let changes = 0;
                  for (let i = roomState.length - 1; i >= 0; i--) {
                    const row = roomState[i];
                    if (row.room_id === roomId && !keepIds.has(row.rowid)) {
                      roomState.splice(i, 1);
                      changes++;
                    }
                  }
                  return { meta: { changes } };
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
    queries: typeof queries;
    getLastCountDepth: () => number | undefined;
    getLastDeleteDepth: () => number | undefined;
    authChain: AuthChainRow[];
    roomState: RoomStateRow[];
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

describe('StateCompactionWorkflow', () => {
  it('defaults maxAuthChainDepth to 100 when omitted', async () => {
    const env = createCompactionEnv({ authChain: [], roomState: [] });
    const step = mockStep();
    const wf = new StateCompactionWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { roomId: '!r:ex' } } as any,
      step as any
    );

    expect(env.getLastCountDepth()).toBe(100);
    expect(env.getLastDeleteDepth()).toBeUndefined(); // prune skipped
    expect(step.names).toEqual([
      'find-redundant-auth',
      'prune-auth-chain',
      'compact-state',
    ]);
    expect(result).toEqual({
      roomId: '!r:ex',
      prunedAuthEntries: 0,
      compactedStateEvents: 0,
      success: true,
    });
  });

  it('skips DELETE when count of depth>maxDepth is 0; still runs compact-state', async () => {
    const env = createCompactionEnv({
      authChain: [
        { room_id: '!r:ex', depth: 50 },
        { room_id: '!r:ex', depth: 100 }, // depth > 100 is false at exact boundary
      ],
      roomState: [],
    });
    const wf = new StateCompactionWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { roomId: '!r:ex', maxAuthChainDepth: 100 } } as any,
      mockStep() as any
    );

    expect(env.getLastCountDepth()).toBe(100);
    expect(env.getLastDeleteDepth()).toBeUndefined();
    expect(env.authChain).toHaveLength(2);
    expect(result.prunedAuthEntries).toBe(0);
    expect(result.success).toBe(true);
  });

  it('prunes only depth > maxDepth (strict); keeps depth == maxDepth', async () => {
    const env = createCompactionEnv({
      authChain: [
        { room_id: '!r:ex', depth: 10 },
        { room_id: '!r:ex', depth: 20 },
        { room_id: '!r:ex', depth: 21 },
        { room_id: '!other:ex', depth: 99 },
      ],
      roomState: [],
    });
    const wf = new StateCompactionWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { roomId: '!r:ex', maxAuthChainDepth: 20 } } as any,
      mockStep() as any
    );

    expect(env.getLastCountDepth()).toBe(20);
    expect(env.getLastDeleteDepth()).toBe(20);
    expect(result.prunedAuthEntries).toBe(1);
    expect(env.authChain).toEqual([
      { room_id: '!r:ex', depth: 10 },
      { room_id: '!r:ex', depth: 20 },
      { room_id: '!other:ex', depth: 99 },
    ]);
  });

  it('treats missing COUNT result as 0 (result?.count || 0)', async () => {
    const env = createCompactionEnv({ authChain: [], roomState: [] });
    // Override first() to return null (no row)
    env.DB.prepare = ((sql: string) => ({
      bind(..._args: unknown[]) {
        return {
          async first() {
            if (sql.includes('COUNT(*)')) return null;
            return null;
          },
          async run() {
            return { meta: { changes: 0 } };
          },
        };
      },
    })) as any;

    const wf = new StateCompactionWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { roomId: '!r:ex' } } as any,
      mockStep() as any
    );
    expect(result.prunedAuthEntries).toBe(0);
    expect(result.success).toBe(true);
  });

  it('compacts room_state keeping MAX(rowid) per (event_type, state_key)', async () => {
    const env = createCompactionEnv({
      authChain: [],
      roomState: [
        {
          room_id: '!r:ex',
          rowid: 1,
          event_type: 'm.room.member',
          state_key: '@a:ex',
        },
        {
          room_id: '!r:ex',
          rowid: 5,
          event_type: 'm.room.member',
          state_key: '@a:ex',
        },
        {
          room_id: '!r:ex',
          rowid: 2,
          event_type: 'm.room.member',
          state_key: '@b:ex',
        },
        {
          room_id: '!r:ex',
          rowid: 3,
          event_type: 'm.room.name',
          state_key: '',
        },
        {
          room_id: '!r:ex',
          rowid: 4,
          event_type: 'm.room.name',
          state_key: '',
        },
        {
          room_id: '!other:ex',
          rowid: 9,
          event_type: 'm.room.name',
          state_key: '',
        },
      ],
    });
    const wf = new StateCompactionWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { roomId: '!r:ex' } } as any,
      mockStep() as any
    );

    expect(result.compactedStateEvents).toBe(2); // rowids 1 and 3 removed
    expect(env.roomState.map((r) => r.rowid).sort((a, b) => a - b)).toEqual([
      2, 4, 5, 9,
    ]);
    expect(result).toMatchObject({
      roomId: '!r:ex',
      prunedAuthEntries: 0,
      success: true,
    });
  });

  it('returns meta.changes || 0 when DELETE reports undefined changes', async () => {
    const env = createCompactionEnv({
      authChain: [{ room_id: '!r:ex', depth: 200 }],
      roomState: [
        {
          room_id: '!r:ex',
          rowid: 1,
          event_type: 'm.room.name',
          state_key: '',
        },
        {
          room_id: '!r:ex',
          rowid: 2,
          event_type: 'm.room.name',
          state_key: '',
        },
      ],
    });
    const origPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      const stmt = origPrepare(sql);
      return {
        bind(...args: unknown[]) {
          const bound = stmt.bind(...args);
          return {
            first: bound.first.bind(bound),
            async run() {
              await bound.run();
              // Simulate D1 occasionally omitting changes
              return { meta: { changes: undefined as unknown as number } };
            },
          };
        },
      };
    }) as any;

    const wf = new StateCompactionWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { roomId: '!r:ex', maxAuthChainDepth: 100 } } as any,
      mockStep() as any
    );
    expect(result.prunedAuthEntries).toBe(0);
    expect(result.compactedStateEvents).toBe(0);
    expect(result.success).toBe(true);
  });

  it('honors custom maxAuthChainDepth for count and prune', async () => {
    const env = createCompactionEnv({
      authChain: [
        { room_id: '!r:ex', depth: 5 },
        { room_id: '!r:ex', depth: 6 },
        { room_id: '!r:ex', depth: 7 },
      ],
      roomState: [],
    });
    const wf = new StateCompactionWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { roomId: '!r:ex', maxAuthChainDepth: 5 } } as any,
      mockStep() as any
    );
    expect(env.getLastCountDepth()).toBe(5);
    expect(env.getLastDeleteDepth()).toBe(5);
    expect(result.prunedAuthEntries).toBe(2);
    expect(env.authChain).toEqual([{ room_id: '!r:ex', depth: 5 }]);
  });
});
