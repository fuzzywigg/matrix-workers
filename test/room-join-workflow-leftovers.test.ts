/**
 * TOKENMAXX HEAVY leftovers after #170/#171 — RoomJoinWorkflow soft/edge/reliability.
 * Complements room-join-workflow.test.ts + join-template-validation.test.ts.
 * Focus: make_join/send_join status matrices, validation soft floods through the
 * workflow catch path, persist failures, notify-batch races, URL encoding,
 * content field matrices, and isRemote/remoteServer gate edges.
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

const storeEvent = vi.fn(async () => 1);
const updateMembership = vi.fn(async () => undefined);
const getRoomMembers = vi.fn(async () => [] as Array<{ userId: string }>);
const getStateEvent = vi.fn(async () => null as { event_id: string } | null);
const getRoomEvents = vi.fn(async () => ({ events: [] as Array<{ event_id: string; depth: number }> }));
const getMembership = vi.fn(async () => null as { membership: string; eventId: string } | null);
const federationGet = vi.fn();
const federationPut = vi.fn();
const generateEventId = vi.fn(async () => '$generated:example.com');

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
const ROOM = '!room:example.com';
const USER = '@alice:example.com';
const REMOTE = 'remote.example.com';

const MAKE_JOIN_STATUSES = [400, 401, 403, 404, 408, 429, 500, 502, 503, 504] as const;
const SEND_JOIN_STATUSES = [400, 403, 404, 429, 500, 502, 503] as const;

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

function createSyncEnv(opts?: { failUsers?: Set<string>; throwNonError?: boolean }) {
  const notified: Array<{ userId: string; body: unknown }> = [];
  return {
    SERVER_NAME: 'example.com',
    DB: {} as D1Database,
    CACHE: {} as KVNamespace,
    notified,
    SYNC: {
      idFromName(name: string) {
        return { name };
      },
      get(id: { name: string }) {
        return {
          async fetch(req: Request) {
            if (opts?.failUsers?.has(id.name)) {
              if (opts.throwNonError) throw 'sync-string-fail';
              throw new Error(`sync fail ${id.name}`);
            }
            notified.push({ userId: id.name, body: await req.json() });
            return new Response('ok');
          },
        };
      },
    },
  };
}

function validRemoteTemplate(overrides: Record<string, unknown> = {}) {
  return {
    room_version: '10',
    event: {
      room_id: ROOM,
      sender: USER,
      state_key: USER,
      type: 'm.room.member',
      content: { membership: 'join' },
      auth_events: ['$auth1:example.com'],
      prev_events: ['$prev1:example.com'],
      depth: 7,
      ...overrides,
    },
  };
}

function resetMocks() {
  storeEvent.mockReset();
  storeEvent.mockResolvedValue(1);
  updateMembership.mockReset();
  updateMembership.mockResolvedValue(undefined);
  getRoomMembers.mockReset();
  getRoomMembers.mockResolvedValue([]);
  getStateEvent.mockReset();
  getStateEvent.mockResolvedValue(null);
  getRoomEvents.mockReset();
  getRoomEvents.mockResolvedValue({ events: [] });
  getMembership.mockReset();
  getMembership.mockResolvedValue(null);
  federationGet.mockReset();
  federationPut.mockReset();
  generateEventId.mockReset();
  generateEventId.mockResolvedValue('$generated:example.com');
}

describe('room-join leftovers make_join status soft flood after #171', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const status of MAKE_JOIN_STATUSES) {
    it(`make_join ${status} → success false; no persist`, async () => {
      federationGet.mockResolvedValue(new Response(`err-${status}`, { status }));
      const env = createSyncEnv();
      const wf = new RoomJoinWorkflow({} as any, env as any);
      const result = await wf.run(
        {
          payload: {
            roomId: ROOM,
            userId: USER,
            isRemote: true,
            remoteServer: REMOTE,
          },
        } as any,
        mockStep() as any
      );
      expect(result.success).toBe(false);
      expect(result.eventId).toBe('');
      expect(result.roomId).toBe(ROOM);
      expect(result.error).toBe(`make_join failed: ${status} err-${status}`);
      expect(storeEvent).not.toHaveBeenCalled();
      expect(federationPut).not.toHaveBeenCalled();
    });
  }

  it('make_join status soft flood sequential keeps isolation', async () => {
    for (const status of MAKE_JOIN_STATUSES) {
      resetMocks();
      federationGet.mockResolvedValue(new Response(`body-${status}`, { status }));
      const env = createSyncEnv();
      const wf = new RoomJoinWorkflow({} as any, env as any);
      const result = await wf.run(
        {
          payload: {
            roomId: ROOM,
            userId: USER,
            isRemote: true,
            remoteServer: REMOTE,
          },
        } as any,
        mockStep() as any
      );
      expect(result.error).toContain(String(status));
      expect(storeEvent).not.toHaveBeenCalled();
    }
  });
});

describe('room-join leftovers send_join status soft flood after #171', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const status of SEND_JOIN_STATUSES) {
    it(`send_join ${status} after valid make_join → success false`, async () => {
      federationGet.mockResolvedValue(
        new Response(JSON.stringify(validRemoteTemplate()), { status: 200 })
      );
      federationPut.mockResolvedValue(new Response(`sj-${status}`, { status }));
      const env = createSyncEnv();
      const wf = new RoomJoinWorkflow({} as any, env as any);
      const result = await wf.run(
        {
          payload: {
            roomId: ROOM,
            userId: USER,
            isRemote: true,
            remoteServer: REMOTE,
          },
        } as any,
        mockStep() as any
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe(`send_join failed: ${status} sj-${status}`);
      expect(storeEvent).not.toHaveBeenCalled();
    });
  }
});

describe('room-join leftovers validation soft flood through workflow catch after #171', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const cases: Array<{ name: string; patch: Record<string, unknown>; match: RegExp }> = [
    {
      name: 'room_id mismatch',
      patch: { room_id: '!evil:other.example.com' },
      match: /room_id mismatch/,
    },
    {
      name: 'sender mismatch',
      patch: { sender: '@eve:example.com' },
      match: /sender mismatch/,
    },
    {
      name: 'state_key mismatch',
      patch: { state_key: '@eve:example.com' },
      match: /state_key mismatch/,
    },
    {
      name: 'wrong type',
      patch: { type: 'm.room.message' },
      match: /type must be m\.room\.member/,
    },
    {
      name: 'membership invite',
      patch: { content: { membership: 'invite' } },
      match: /content\.membership must be "join"/,
    },
    {
      name: 'empty auth_events',
      patch: { auth_events: [] },
      match: /auth_events must be a non-empty array/,
    },
    {
      name: 'invalid auth event id',
      patch: { auth_events: ['not-an-event-id'] },
      match: /invalid event ID in auth_events/,
    },
    {
      name: 'empty prev_events',
      patch: { prev_events: [] },
      match: /prev_events must be a non-empty array/,
    },
    {
      name: 'invalid prev event id',
      patch: { prev_events: ['#bad'] },
      match: /invalid event ID in prev_events/,
    },
    {
      name: 'depth 0',
      patch: { depth: 0 },
      match: /depth must be a positive integer/,
    },
    {
      name: 'depth negative',
      patch: { depth: -3 },
      match: /depth must be a positive integer/,
    },
    {
      name: 'depth float',
      patch: { depth: 1.5 },
      match: /depth must be a positive integer/,
    },
  ];

  for (const c of cases) {
    it(`invalid template: ${c.name}`, async () => {
      federationGet.mockResolvedValue(
        new Response(JSON.stringify(validRemoteTemplate(c.patch)), { status: 200 })
      );
      const env = createSyncEnv();
      const wf = new RoomJoinWorkflow({} as any, env as any);
      const result = await wf.run(
        {
          payload: {
            roomId: ROOM,
            userId: USER,
            isRemote: true,
            remoteServer: REMOTE,
          },
        } as any,
        mockStep() as any
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(c.match);
      expect(storeEvent).not.toHaveBeenCalled();
      expect(federationPut).not.toHaveBeenCalled();
    });
  }

  it('unsupported room_version soft flood', async () => {
    for (const ver of ['0', '13', '99', 'abc', '']) {
      resetMocks();
      federationGet.mockResolvedValue(
        new Response(
          JSON.stringify({
            room_version: ver,
            event: validRemoteTemplate().event,
          }),
          { status: 200 }
        )
      );
      const env = createSyncEnv();
      const wf = new RoomJoinWorkflow({} as any, env as any);
      const result = await wf.run(
        {
          payload: {
            roomId: ROOM,
            userId: USER,
            isRemote: true,
            remoteServer: REMOTE,
          },
        } as any,
        mockStep() as any
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/unsupported room_version/);
    }
  });

  it('supported room_version soft flood still joins', async () => {
    for (const ver of ['1', '6', '9', '10', '11', '12']) {
      resetMocks();
      federationGet.mockResolvedValue(
        new Response(
          JSON.stringify({
            room_version: ver,
            event: validRemoteTemplate().event,
          }),
          { status: 200 }
        )
      );
      federationPut.mockResolvedValue(new Response('{}', { status: 200 }));
      const env = createSyncEnv();
      const wf = new RoomJoinWorkflow({} as any, env as any);
      const result = await wf.run(
        {
          payload: {
            roomId: ROOM,
            userId: USER,
            isRemote: true,
            remoteServer: REMOTE,
          },
        } as any,
        mockStep() as any
      );
      expect(result.success).toBe(true);
      expect(storeEvent).toHaveBeenCalledTimes(1);
    }
  });
});

describe('room-join leftovers persist / non-Error catch soft flood after #171', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('storeEvent Error → success false with message', async () => {
    storeEvent.mockRejectedValue(new Error('d1 store boom'));
    const env = createSyncEnv();
    const wf = new RoomJoinWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { roomId: ROOM, userId: USER, isRemote: false } } as any,
      mockStep() as any
    );
    expect(result).toEqual({
      eventId: '',
      roomId: ROOM,
      success: false,
      error: 'd1 store boom',
    });
  });

  it('updateMembership Error → success false', async () => {
    updateMembership.mockRejectedValue(new Error('membership boom'));
    const env = createSyncEnv();
    const wf = new RoomJoinWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { roomId: ROOM, userId: USER, isRemote: false } } as any,
      mockStep() as any
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('membership boom');
  });

  it('storeEvent non-Error soft flood → Unknown error', async () => {
    for (const bad of [null, undefined, 42, { x: 1 }, 'plain']) {
      resetMocks();
      storeEvent.mockRejectedValue(bad);
      const env = createSyncEnv();
      const wf = new RoomJoinWorkflow({} as any, env as any);
      const result = await wf.run(
        { payload: { roomId: ROOM, userId: USER, isRemote: false } } as any,
        mockStep() as any
      );
      expect(result.error).toBe('Unknown error');
      expect(result.success).toBe(false);
    }
  });

  it('getRoomMembers throw after persist → success false (join already stored)', async () => {
    getRoomMembers.mockRejectedValue(new Error('members boom'));
    const env = createSyncEnv();
    const wf = new RoomJoinWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { roomId: ROOM, userId: USER, isRemote: false } } as any,
      mockStep() as any
    );
    expect(storeEvent).toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toBe('members boom');
  });
});

describe('room-join leftovers notify-batch races / soft flood after #171', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const batchSizes = [0, 1, 2, 10, 49, 50, 51, 99, 100, 101, 150];

  for (const n of batchSizes) {
    it(`notify batch sizing for ${n} other members`, async () => {
      const others = Array.from({ length: n }, (_, i) => ({
        userId: `@u${i}:example.com`,
      }));
      getRoomMembers.mockResolvedValue([{ userId: USER }, ...others]);
      const env = createSyncEnv();
      const step = mockStep();
      const wf = new RoomJoinWorkflow({} as any, env as any);
      const result = await wf.run(
        { payload: { roomId: ROOM, userId: USER, isRemote: false } } as any,
        step as any
      );
      expect(result.success).toBe(true);
      expect(env.notified).toHaveLength(n);
      const expectedBatches = Math.ceil(n / 50);
      const notifySteps = step.names.filter((s) => s.startsWith('notify-batch-'));
      expect(notifySteps).toHaveLength(expectedBatches);
      for (let i = 0; i < expectedBatches; i++) {
        expect(notifySteps).toContain(`notify-batch-${i * 50}`);
      }
    });
  }

  it('concurrent-ish multi-fail Sync DO soft flood still succeeds', async () => {
    const others = Array.from({ length: 24 }, (_, i) => ({
      userId: `@u${i}:example.com`,
    }));
    const failUsers = new Set(
      others.filter((_, i) => i % 3 === 0).map((m) => m.userId)
    );
    getRoomMembers.mockResolvedValue([{ userId: USER }, ...others]);
    const env = createSyncEnv({ failUsers });
    const wf = new RoomJoinWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { roomId: ROOM, userId: USER, isRemote: false } } as any,
      mockStep() as any
    );
    expect(result.success).toBe(true);
    expect(env.notified).toHaveLength(24 - failUsers.size);
    for (const n of env.notified) {
      expect(failUsers.has(n.userId)).toBe(false);
      expect(n.body).toEqual({
        roomId: ROOM,
        eventId: '$generated:example.com',
        eventType: 'm.room.member',
      });
    }
  });

  it('non-Error Sync DO throws are swallowed (soft flood)', async () => {
    getRoomMembers.mockResolvedValue([
      { userId: USER },
      { userId: '@bob:example.com' },
      { userId: '@fail:example.com' },
      { userId: '@carol:example.com' },
    ]);
    const env = createSyncEnv({
      failUsers: new Set(['@fail:example.com']),
      throwNonError: true,
    });
    const wf = new RoomJoinWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: { roomId: ROOM, userId: USER, isRemote: false } } as any,
      mockStep() as any
    );
    expect(result.success).toBe(true);
    expect(env.notified.map((n) => n.userId).sort()).toEqual([
      '@bob:example.com',
      '@carol:example.com',
    ]);
  });

  it('excludes joiner even when listed many times in member list soft flood', async () => {
    getRoomMembers.mockResolvedValue([
      { userId: USER },
      { userId: USER },
      { userId: '@bob:example.com' },
      { userId: USER },
    ]);
    const env = createSyncEnv();
    const wf = new RoomJoinWorkflow({} as any, env as any);
    await wf.run(
      { payload: { roomId: ROOM, userId: USER, isRemote: false } } as any,
      mockStep() as any
    );
    expect(env.notified.map((n) => n.userId)).toEqual(['@bob:example.com']);
  });
});

describe('room-join leftovers content / clock / gate soft flood after #171', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const contentCases: Array<{
    label: string;
    payload: Record<string, unknown>;
    content: Record<string, unknown>;
  }> = [
    {
      label: 'displayname only',
      payload: { displayName: 'Alice' },
      content: { membership: 'join', displayname: 'Alice' },
    },
    {
      label: 'avatar only',
      payload: { avatarUrl: 'mxc://example.com/a' },
      content: { membership: 'join', avatar_url: 'mxc://example.com/a' },
    },
    {
      label: 'reason only',
      payload: { reason: 'hi' },
      content: { membership: 'join', reason: 'hi' },
    },
    {
      label: 'all three',
      payload: {
        displayName: 'Alice',
        avatarUrl: 'mxc://example.com/a',
        reason: 'welcome',
      },
      content: {
        membership: 'join',
        displayname: 'Alice',
        avatar_url: 'mxc://example.com/a',
        reason: 'welcome',
      },
    },
    {
      label: 'empty strings omitted by truthy guards',
      payload: { displayName: '', avatarUrl: '', reason: '' },
      content: { membership: 'join' },
    },
  ];

  for (const c of contentCases) {
    it(`content matrix: ${c.label}`, async () => {
      const env = createSyncEnv();
      const wf = new RoomJoinWorkflow({} as any, env as any);
      await wf.run(
        {
          payload: { roomId: ROOM, userId: USER, isRemote: false, ...c.payload },
        } as any,
        mockStep() as any
      );
      expect(storeEvent.mock.calls[0][1].content).toEqual(c.content);
    });
  }

  it('origin_server_ts soft flood across clock advances', async () => {
    const offsets = [0, 1, 999, 60_000, 86_400_000];
    for (const off of offsets) {
      resetMocks();
      vi.setSystemTime(NOW + off);
      const env = createSyncEnv();
      const wf = new RoomJoinWorkflow({} as any, env as any);
      await wf.run(
        { payload: { roomId: ROOM, userId: USER, isRemote: false } } as any,
        mockStep() as any
      );
      expect(storeEvent.mock.calls[0][1].origin_server_ts).toBe(NOW + off);
    }
  });

  it('isRemote gate soft flood: missing/empty remoteServer skips federation', async () => {
    for (const remoteServer of [undefined, '', undefined]) {
      resetMocks();
      const env = createSyncEnv();
      const step = mockStep();
      const wf = new RoomJoinWorkflow({} as any, env as any);
      await wf.run(
        {
          payload: {
            roomId: ROOM,
            userId: USER,
            isRemote: true,
            ...(remoteServer !== undefined ? { remoteServer } : {}),
          },
        } as any,
        step as any
      );
      expect(step.names).toEqual(['create-event', 'persist', 'get-members']);
      expect(federationGet).not.toHaveBeenCalled();
    }
  });

  it('URL-encodes roomId and userId in make_join path soft flood', async () => {
    const pairs: Array<[string, string]> = [
      ['!a:example.com', '@alice:example.com'],
      ['!r/x:example.com', '@bob:example.com'],
      ['!weird#1:example.com', '@carol+x:example.com'],
      ['!space room:example.com', '@dave:example.com'],
    ];
    for (const [roomId, userId] of pairs) {
      resetMocks();
      federationGet.mockResolvedValue(
        new Response(
          JSON.stringify({
            room_version: '10',
            event: {
              room_id: roomId,
              sender: userId,
              state_key: userId,
              type: 'm.room.member',
              content: { membership: 'join' },
              auth_events: ['$a:example.com'],
              prev_events: ['$p:example.com'],
              depth: 2,
            },
          }),
          { status: 200 }
        )
      );
      federationPut.mockResolvedValue(new Response('{}', { status: 200 }));
      const env = createSyncEnv();
      const wf = new RoomJoinWorkflow({} as any, env as any);
      await wf.run(
        {
          payload: {
            roomId,
            userId,
            isRemote: true,
            remoteServer: REMOTE,
          },
        } as any,
        mockStep() as any
      );
      expect(federationGet.mock.calls[0][1]).toBe(
        `/_matrix/federation/v1/make_join/${encodeURIComponent(roomId)}/${encodeURIComponent(userId)}`
      );
      expect(federationPut.mock.calls[0][1]).toContain(encodeURIComponent(roomId));
      expect(federationPut.mock.calls[0][1]).toContain(
        encodeURIComponent('$generated:example.com')
      );
    }
  });

  it('local auth event soft flood: sparse state subsets', async () => {
    const subsets: Array<Array<'create' | 'join_rules' | 'power_levels' | 'membership'>> = [
      [],
      ['create'],
      ['create', 'join_rules'],
      ['create', 'power_levels'],
      ['join_rules', 'power_levels'],
      ['create', 'join_rules', 'power_levels'],
      ['create', 'join_rules', 'power_levels', 'membership'],
    ];
    for (const keys of subsets) {
      resetMocks();
      getStateEvent.mockImplementation(async (_db, _room, type: string) => {
        const map: Record<string, { event_id: string }> = {
          'm.room.create': { event_id: '$create' },
          'm.room.join_rules': { event_id: '$jr' },
          'm.room.power_levels': { event_id: '$pl' },
        };
        if (type === 'm.room.create' && keys.includes('create')) return map[type];
        if (type === 'm.room.join_rules' && keys.includes('join_rules')) return map[type];
        if (type === 'm.room.power_levels' && keys.includes('power_levels')) return map[type];
        return null;
      });
      if (keys.includes('membership')) {
        getMembership.mockResolvedValue({ membership: 'invite', eventId: '$invite' });
      }
      getRoomEvents.mockResolvedValue({ events: [{ event_id: '$latest', depth: 4 }] });
      const env = createSyncEnv();
      const wf = new RoomJoinWorkflow({} as any, env as any);
      await wf.run(
        { payload: { roomId: ROOM, userId: USER, isRemote: false } } as any,
        mockStep() as any
      );
      const auth = storeEvent.mock.calls[0][1].auth_events as string[];
      const expected: string[] = [];
      if (keys.includes('create')) expected.push('$create');
      if (keys.includes('join_rules')) expected.push('$jr');
      if (keys.includes('power_levels')) expected.push('$pl');
      if (keys.includes('membership')) expected.push('$invite');
      expect(auth).toEqual(expected);
      expect(storeEvent.mock.calls[0][1].depth).toBe(5);
    }
  });
});
