import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

const storeEvent = vi.fn(async () => undefined);
const updateMembership = vi.fn(async () => undefined);
const getRoomMembers = vi.fn(async () => [] as Array<{ userId: string }>);
const getStateEvent = vi.fn(async () => null as { event_id: string } | null);
const getRoomEvents = vi.fn(
  async () => ({ events: [] as Array<{ event_id: string; depth: number }> })
);
const getMembership = vi.fn(async () => null as { eventId: string } | null);
const federationGet = vi.fn();
const federationPut = vi.fn();
const generateEventId = vi.fn(async () => '$join:example.com');

vi.mock('../src/services/database', () => ({
  storeEvent: (...args: unknown[]) => storeEvent(...args),
  updateMembership: (...args: unknown[]) => updateMembership(...args),
  getRoomMembers: (...args: unknown[]) => getRoomMembers(...args),
  getStateEvent: (...args: unknown[]) => getStateEvent(...args),
  getRoomEvents: (...args: unknown[]) => getRoomEvents(...args),
  getMembership: (...args: unknown[]) => getMembership(...args),
}));

vi.mock('../src/services/federation-keys', () => ({
  federationGet: (...args: unknown[]) => federationGet(...args),
  federationPut: (...args: unknown[]) => federationPut(...args),
}));

vi.mock('../src/utils/ids', () => ({
  generateEventId: (...args: unknown[]) => generateEventId(...args),
}));

import { RoomJoinWorkflow } from '../src/workflows/RoomJoinWorkflow';

const NOW = 1_700_000_000_000;

function mockStep(opts?: { throwOnStep?: string; recordNames?: string[] }) {
  return {
    async do(name: string, a: unknown, b?: unknown) {
      opts?.recordNames?.push(name);
      if (opts?.throwOnStep === name) {
        throw new Error(`step failed: ${name}`);
      }
      const fn = (typeof a === 'function' ? a : b) as () => Promise<unknown>;
      return fn();
    },
  };
}

function createEnv(opts?: {
  notifyFailUsers?: Set<string>;
  notified?: Array<{ userId: string; body: unknown }>;
}) {
  const notified = opts?.notified ?? [];
  return {
    SERVER_NAME: 'example.com',
    DB: {} as D1Database,
    CACHE: {} as KVNamespace,
    SYNC: {
      idFromName(name: string) {
        return { name } as unknown as DurableObjectId;
      },
      get(id: DurableObjectId) {
        const userId = (id as unknown as { name: string }).name;
        return {
          async fetch(req: Request) {
            if (opts?.notifyFailUsers?.has(userId)) {
              throw new Error('notify fail');
            }
            notified.push({ userId, body: await req.json() });
            return new Response('ok');
          },
        };
      },
    },
    notified,
  };
}

describe('RoomJoinWorkflow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    storeEvent.mockClear();
    updateMembership.mockClear();
    getRoomMembers.mockReset();
    getStateEvent.mockReset();
    getRoomEvents.mockReset();
    getMembership.mockReset();
    federationGet.mockReset();
    federationPut.mockReset();
    generateEventId.mockClear();
    generateEventId.mockResolvedValue('$join:example.com');
    getRoomMembers.mockResolvedValue([]);
    getStateEvent.mockResolvedValue(null);
    getRoomEvents.mockResolvedValue({ events: [] });
    getMembership.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('local join: creates event from empty room state, persists, succeeds', async () => {
    const env = createEnv();
    const names: string[] = [];
    const wf = new RoomJoinWorkflow({} as any, env as any);
    const result = await wf.run(
      {
        payload: {
          roomId: '!r:example.com',
          userId: '@alice:example.com',
          isRemote: false,
        },
      } as any,
      mockStep({ recordNames: names }) as any
    );

    expect(result).toEqual({
      eventId: '$join:example.com',
      roomId: '!r:example.com',
      success: true,
    });
    expect(names).toEqual(['create-event', 'persist', 'get-members']);
    expect(federationGet).not.toHaveBeenCalled();
    expect(federationPut).not.toHaveBeenCalled();
    expect(storeEvent).toHaveBeenCalledTimes(1);
    const stored = storeEvent.mock.calls[0][1] as {
      depth: number;
      origin_server_ts: number;
      content: Record<string, unknown>;
      auth_events: string[];
      prev_events: string[];
    };
    expect(stored.depth).toBe(1);
    expect(stored.origin_server_ts).toBe(NOW);
    expect(stored.content).toEqual({ membership: 'join' });
    expect(stored.auth_events).toEqual([]);
    expect(stored.prev_events).toEqual([]);
    expect(updateMembership).toHaveBeenCalledWith(
      env.DB,
      '!r:example.com',
      '@alice:example.com',
      'join',
      '$join:example.com'
    );
  });

  it('local join: includes displayName/avatar/reason and auth/prev from state', async () => {
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.create') return { event_id: '$create' };
      if (type === 'm.room.join_rules') return { event_id: '$jr' };
      if (type === 'm.room.power_levels') return { event_id: '$pl' };
      return null;
    });
    getMembership.mockResolvedValue({ eventId: '$invite' });
    getRoomEvents.mockResolvedValue({
      events: [{ event_id: '$prev', depth: 4 }],
    });

    const env = createEnv();
    const wf = new RoomJoinWorkflow({} as any, env as any);
    await wf.run(
      {
        payload: {
          roomId: '!r:example.com',
          userId: '@alice:example.com',
          isRemote: false,
          displayName: 'Alice',
          avatarUrl: 'mxc://example.com/a',
          reason: 'hi',
        },
      } as any,
      mockStep() as any
    );

    const stored = storeEvent.mock.calls[0][1] as {
      depth: number;
      content: Record<string, unknown>;
      auth_events: string[];
      prev_events: string[];
    };
    expect(stored.depth).toBe(5);
    expect(stored.prev_events).toEqual(['$prev']);
    expect(stored.auth_events).toEqual(['$create', '$jr', '$pl', '$invite']);
    expect(stored.content).toEqual({
      membership: 'join',
      displayname: 'Alice',
      avatar_url: 'mxc://example.com/a',
      reason: 'hi',
    });
  });

  it('local join: notifies other members via Sync DO; swallows per-member failures', async () => {
    getRoomMembers.mockResolvedValue([
      { userId: '@alice:example.com' },
      { userId: '@bob:example.com' },
      { userId: '@carol:example.com' },
    ]);
    const env = createEnv({ notifyFailUsers: new Set(['@bob:example.com']) });
    const names: string[] = [];
    const wf = new RoomJoinWorkflow({} as any, env as any);
    const result = await wf.run(
      {
        payload: {
          roomId: '!r:example.com',
          userId: '@alice:example.com',
          isRemote: false,
        },
      } as any,
      mockStep({ recordNames: names }) as any
    );
    expect(result.success).toBe(true);
    expect(names).toContain('notify-batch-0');
    // joiner excluded
    expect(env.notified.map((n) => n.userId).sort()).toEqual(['@carol:example.com']);
    expect(env.notified[0].body).toEqual({
      roomId: '!r:example.com',
      eventId: '$join:example.com',
      eventType: 'm.room.member',
    });
  });

  it('local join: batches notifications at 50', async () => {
    const members = Array.from({ length: 51 }, (_, i) => ({
      userId: `@u${i}:example.com`,
    }));
    getRoomMembers.mockResolvedValue([
      { userId: '@alice:example.com' },
      ...members,
    ]);
    const names: string[] = [];
    const env = createEnv();
    const wf = new RoomJoinWorkflow({} as any, env as any);
    await wf.run(
      {
        payload: {
          roomId: '!r:example.com',
          userId: '@alice:example.com',
          isRemote: false,
        },
      } as any,
      mockStep({ recordNames: names }) as any
    );
    expect(names).toContain('notify-batch-0');
    expect(names).toContain('notify-batch-50');
    expect(env.notified).toHaveLength(51);
  });

  it('outer step failure returns success:false with error', async () => {
    const env = createEnv();
    const wf = new RoomJoinWorkflow({} as any, env as any);
    const result = await wf.run(
      {
        payload: {
          roomId: '!r:example.com',
          userId: '@alice:example.com',
          isRemote: false,
        },
      } as any,
      mockStep({ throwOnStep: 'create-event' }) as any
    );
    expect(result).toEqual({
      eventId: '',
      roomId: '!r:example.com',
      success: false,
      error: 'step failed: create-event',
    });
  });

  it('remote make_join !ok throws → workflow failure', async () => {
    federationGet.mockResolvedValue(
      new Response('denied', { status: 403 })
    );
    const env = createEnv();
    const wf = new RoomJoinWorkflow({} as any, env as any);
    const result = await wf.run(
      {
        payload: {
          roomId: '!r:example.com',
          userId: '@alice:example.com',
          isRemote: true,
          remoteServer: 'remote.example',
        },
      } as any,
      mockStep() as any
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/make_join failed: 403/);
    expect(storeEvent).not.toHaveBeenCalled();
  });

  it('remote make_join invalid template fails validation before persist', async () => {
    federationGet.mockResolvedValue(
      new Response(
        JSON.stringify({
          room_version: '10',
          event: {
            room_id: '!other:example.com',
            sender: '@alice:example.com',
            state_key: '@alice:example.com',
            type: 'm.room.member',
            content: { membership: 'join' },
            auth_events: ['$a'],
            prev_events: ['$p'],
            depth: 2,
          },
        }),
        { status: 200 }
      )
    );
    const env = createEnv();
    const wf = new RoomJoinWorkflow({} as any, env as any);
    const result = await wf.run(
      {
        payload: {
          roomId: '!r:example.com',
          userId: '@alice:example.com',
          isRemote: true,
          remoteServer: 'remote.example',
        },
      } as any,
      mockStep() as any
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/room_id mismatch/);
    expect(federationPut).not.toHaveBeenCalled();
  });

  it('remote join success: uses template auth/prev/depth, send_join, persist', async () => {
    federationGet.mockResolvedValue(
      new Response(
        JSON.stringify({
          room_version: '10',
          event: {
            room_id: '!r:example.com',
            sender: '@alice:example.com',
            state_key: '@alice:example.com',
            type: 'm.room.member',
            content: { membership: 'join' },
            auth_events: ['$auth'],
            prev_events: ['$prev'],
            depth: 9,
          },
        }),
        { status: 200 }
      )
    );
    federationPut.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    const names: string[] = [];
    const env = createEnv();
    const wf = new RoomJoinWorkflow({} as any, env as any);
    const result = await wf.run(
      {
        payload: {
          roomId: '!r:example.com',
          userId: '@alice:example.com',
          isRemote: true,
          remoteServer: 'remote.example',
        },
      } as any,
      mockStep({ recordNames: names }) as any
    );
    expect(result.success).toBe(true);
    expect(names).toEqual([
      'make-join',
      'create-event',
      'send-join',
      'persist',
      'get-members',
    ]);
    const stored = storeEvent.mock.calls[0][1] as {
      depth: number;
      auth_events: string[];
      prev_events: string[];
    };
    expect(stored.depth).toBe(9);
    expect(stored.auth_events).toEqual(['$auth']);
    expect(stored.prev_events).toEqual(['$prev']);
    expect(federationPut).toHaveBeenCalled();
    const putPath = federationPut.mock.calls[0][1] as string;
    expect(putPath).toContain('send_join');
    expect(putPath).toContain(encodeURIComponent('$join:example.com'));
  });

  it('remote send_join !ok fails workflow', async () => {
    federationGet.mockResolvedValue(
      new Response(
        JSON.stringify({
          room_version: '10',
          event: {
            room_id: '!r:example.com',
            sender: '@alice:example.com',
            state_key: '@alice:example.com',
            type: 'm.room.member',
            content: { membership: 'join' },
            auth_events: ['$a'],
            prev_events: ['$p'],
            depth: 2,
          },
        }),
        { status: 200 }
      )
    );
    federationPut.mockResolvedValue(new Response('nope', { status: 500 }));
    const env = createEnv();
    const wf = new RoomJoinWorkflow({} as any, env as any);
    const result = await wf.run(
      {
        payload: {
          roomId: '!r:example.com',
          userId: '@alice:example.com',
          isRemote: true,
          remoteServer: 'remote.example',
        },
      } as any,
      mockStep() as any
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/send_join failed: 500/);
    expect(storeEvent).not.toHaveBeenCalled();
  });

  it('isRemote without remoteServer skips federation steps (local-like)', async () => {
    const names: string[] = [];
    const env = createEnv();
    const wf = new RoomJoinWorkflow({} as any, env as any);
    const result = await wf.run(
      {
        payload: {
          roomId: '!r:example.com',
          userId: '@alice:example.com',
          isRemote: true,
          // no remoteServer
        },
      } as any,
      mockStep({ recordNames: names }) as any
    );
    expect(result.success).toBe(true);
    expect(names).not.toContain('make-join');
    expect(names).not.toContain('send-join');
    expect(federationGet).not.toHaveBeenCalled();
  });
});
