/**
 * TOKENMAXX HEAVY concurrent-race leftovers after #187 — RoomJoinWorkflow +
 * join-template-validation edges not landed in #187 leftovers.
 * Complements room-join-workflow.test.ts + room-join-workflow-leftovers.test.ts
 * + join-template-validation.test.ts.
 * Distinct edges: exact make/send-join retry descriptors, federation transport/
 * parse failures, event:null / JSON-null templates, isRemote:false+remoteServer,
 * omitted optional template fields, depth missing fallback, generateEventId /
 * state-accessor failure ordering, duplicate notify members, Sync DO idFromName/
 * get throws, non-OK Sync treated as success, proven notify-batch parallelism /
 * sequential batch gating.
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
const getRoomEvents = vi.fn(async () => ({
  events: [] as Array<{ event_id: string; depth?: number }>,
}));
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
import { validateRemoteJoinTemplate } from '../src/workflows/join-template-validation';

const NOW = 1_700_000_000_000;
const ROOM = '!room:example.com';
const USER = '@alice:example.com';
const REMOTE = 'remote.example.com';

const EXPECTED_FED_RETRY = {
  retries: { limit: 3, delay: 5000, backoff: 'exponential' },
  timeout: 30000,
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

function createSyncEnv(opts?: {
  failUsers?: Set<string>;
  throwNonError?: boolean;
  nonOkUsers?: Set<string>;
  idFromNameThrow?: Set<string>;
  getThrow?: Set<string>;
  deferredUsers?: Set<string>;
  started?: string[];
  release?: Map<string, () => void>;
}) {
  const notified: Array<{ userId: string; body: unknown; status?: number }> = [];
  const started = opts?.started ?? [];
  const release = opts?.release ?? new Map<string, () => void>();
  return {
    SERVER_NAME: 'example.com',
    DB: {} as D1Database,
    CACHE: {} as KVNamespace,
    notified,
    started,
    release,
    SYNC: {
      idFromName(name: string) {
        if (opts?.idFromNameThrow?.has(name)) throw new Error(`idFromName boom ${name}`);
        return { name };
      },
      get(id: { name: string }) {
        if (opts?.getThrow?.has(id.name)) throw new Error(`get boom ${id.name}`);
        return {
          async fetch(req: Request) {
            started.push(id.name);
            if (opts?.deferredUsers?.has(id.name)) {
              await new Promise<void>((resolve) => {
                release.set(id.name, resolve);
              });
            }
            if (opts?.failUsers?.has(id.name)) {
              if (opts.throwNonError) throw 'sync-string-fail';
              throw new Error(`sync fail ${id.name}`);
            }
            if (opts?.nonOkUsers?.has(id.name)) {
              notified.push({ userId: id.name, body: await req.json(), status: 500 });
              return new Response('nope', { status: 500 });
            }
            notified.push({ userId: id.name, body: await req.json(), status: 200 });
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

describe('room-join after #187: durable retry-step contracts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pins exact make-join and send-join retry descriptors', async () => {
    federationGet.mockResolvedValue(
      new Response(JSON.stringify(validRemoteTemplate()), { status: 200 })
    );
    federationPut.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const env = createSyncEnv();
    const step = mockStep();
    const result = await new RoomJoinWorkflow({} as never, env as never).run(
      {
        payload: {
          roomId: ROOM,
          userId: USER,
          isRemote: true,
          remoteServer: REMOTE,
        },
      } as never,
      step as never
    );
    expect(result.success).toBe(true);
    expect(step.optsLog).toEqual([
      { name: 'make-join', opts: EXPECTED_FED_RETRY },
      { name: 'send-join', opts: EXPECTED_FED_RETRY },
    ]);
  });
});

describe('room-join after #187: remote transport and parse failures', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const err of [new Error('fed get boom'), 'string-fail', null, 42] as const) {
    it(`federationGet rejection (${String(err)}) maps through outer catch`, async () => {
      federationGet.mockRejectedValue(err);
      const env = createSyncEnv();
      const result = await new RoomJoinWorkflow({} as never, env as never).run(
        {
          payload: { roomId: ROOM, userId: USER, isRemote: true, remoteServer: REMOTE },
        } as never,
        mockStep() as never
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe(err instanceof Error ? err.message : 'Unknown error');
      expect(storeEvent).not.toHaveBeenCalled();
    });
  }

  it('2xx make_join with invalid JSON maps through outer catch', async () => {
    federationGet.mockResolvedValue(new Response('not-json{', { status: 200 }));
    const env = createSyncEnv();
    const result = await new RoomJoinWorkflow({} as never, env as never).run(
      {
        payload: { roomId: ROOM, userId: USER, isRemote: true, remoteServer: REMOTE },
      } as never,
      mockStep() as never
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(storeEvent).not.toHaveBeenCalled();
    expect(federationPut).not.toHaveBeenCalled();
  });

  it('2xx make_join JSON null falls through local create then still send_join (pinned)', async () => {
    federationGet.mockResolvedValue(new Response('null', { status: 200 }));
    federationPut.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    getStateEvent.mockResolvedValue({ event_id: '$create:example.com' });
    getRoomEvents.mockResolvedValue({ events: [{ event_id: '$prev:example.com', depth: 4 }] });
    const env = createSyncEnv();
    const step = mockStep();
    const result = await new RoomJoinWorkflow({} as never, env as never).run(
      {
        payload: { roomId: ROOM, userId: USER, isRemote: true, remoteServer: REMOTE },
      } as never,
      step as never
    );
    // remoteEventTemplate is null → validation skipped → local create → send_join still runs
    expect(result.success).toBe(true);
    expect(federationPut).toHaveBeenCalledTimes(1);
    expect(step.names).toContain('send-join');
    expect(storeEvent).toHaveBeenCalled();
  });

  it('template with event:null stops before create/send/persist', async () => {
    federationGet.mockResolvedValue(
      new Response(JSON.stringify({ room_version: '10', event: null }), { status: 200 })
    );
    const env = createSyncEnv();
    const result = await new RoomJoinWorkflow({} as never, env as never).run(
      {
        payload: { roomId: ROOM, userId: USER, isRemote: true, remoteServer: REMOTE },
      } as never,
      mockStep() as never
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/missing event/);
    expect(federationPut).not.toHaveBeenCalled();
    expect(storeEvent).not.toHaveBeenCalled();
  });

  it('2xx send_join with invalid JSON stops before persistence', async () => {
    federationGet.mockResolvedValue(
      new Response(JSON.stringify(validRemoteTemplate()), { status: 200 })
    );
    federationPut.mockResolvedValue(new Response('bad{', { status: 200 }));
    const env = createSyncEnv();
    const result = await new RoomJoinWorkflow({} as never, env as never).run(
      {
        payload: { roomId: ROOM, userId: USER, isRemote: true, remoteServer: REMOTE },
      } as never,
      mockStep() as never
    );
    expect(result.success).toBe(false);
    expect(storeEvent).not.toHaveBeenCalled();
  });

  for (const err of [new Error('put boom'), 'put-string'] as const) {
    it(`federationPut rejection (${String(err)}) maps before persistence`, async () => {
      federationGet.mockResolvedValue(
        new Response(JSON.stringify(validRemoteTemplate()), { status: 200 })
      );
      federationPut.mockRejectedValue(err);
      const env = createSyncEnv();
      const result = await new RoomJoinWorkflow({} as never, env as never).run(
        {
          payload: { roomId: ROOM, userId: USER, isRemote: true, remoteServer: REMOTE },
        } as never,
        mockStep() as never
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe(err instanceof Error ? err.message : 'Unknown error');
      expect(storeEvent).not.toHaveBeenCalled();
    });
  }
});

describe('room-join after #187: local construction / gate / notify edges', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('isRemote:false with supplied remoteServer still takes local path', async () => {
    const env = createSyncEnv();
    const step = mockStep();
    const result = await new RoomJoinWorkflow({} as never, env as never).run(
      {
        payload: {
          roomId: ROOM,
          userId: USER,
          isRemote: false,
          remoteServer: REMOTE,
        },
      } as never,
      step as never
    );
    expect(result.success).toBe(true);
    expect(federationGet).not.toHaveBeenCalled();
    expect(federationPut).not.toHaveBeenCalled();
    expect(step.names).not.toContain('make-join');
    expect(step.names).not.toContain('send-join');
  });

  it('valid remote template omitting optional room_id/sender/state_key/type still joins', async () => {
    const template = validRemoteTemplate({
      room_id: undefined,
      sender: undefined,
      state_key: undefined,
      type: undefined,
    });
    federationGet.mockResolvedValue(new Response(JSON.stringify(template), { status: 200 }));
    federationPut.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const env = createSyncEnv();
    const result = await new RoomJoinWorkflow({} as never, env as never).run(
      {
        payload: { roomId: ROOM, userId: USER, isRemote: true, remoteServer: REMOTE },
      } as never,
      mockStep() as never
    );
    expect(result.success).toBe(true);
    const stored = storeEvent.mock.calls[0][1] as {
      room_id: string;
      sender: string;
      state_key: string;
      type: string;
      depth: number;
    };
    expect(stored.room_id).toBe(ROOM);
    expect(stored.sender).toBe(USER);
    expect(stored.state_key).toBe(USER);
    expect(stored.type).toBe('m.room.member');
    expect(stored.depth).toBe(7);
  });

  it('local latest event missing depth uses 0+1 fallback', async () => {
    getRoomEvents.mockResolvedValue({
      events: [{ event_id: '$latest:example.com' }],
    });
    const env = createSyncEnv();
    await new RoomJoinWorkflow({} as never, env as never).run(
      { payload: { roomId: ROOM, userId: USER, isRemote: false } } as never,
      mockStep() as never
    );
    const stored = storeEvent.mock.calls[0][1] as { depth: number; prev_events: string[] };
    expect(stored.depth).toBe(1);
    expect(stored.prev_events).toEqual(['$latest:example.com']);
  });

  it('generateEventId rejection prevents persistence', async () => {
    generateEventId.mockRejectedValue(new Error('id boom'));
    const env = createSyncEnv();
    const result = await new RoomJoinWorkflow({} as never, env as never).run(
      { payload: { roomId: ROOM, userId: USER, isRemote: false } } as never,
      mockStep() as never
    );
    expect(result).toEqual({
      eventId: '',
      roomId: ROOM,
      success: false,
      error: 'id boom',
    });
    expect(storeEvent).not.toHaveBeenCalled();
  });

  for (const [label, setup] of [
    [
      'getStateEvent',
      () => {
        getStateEvent.mockRejectedValue(new Error('state boom'));
      },
    ],
    [
      'getMembership',
      () => {
        getMembership.mockRejectedValue(new Error('membership boom'));
      },
    ],
    [
      'getRoomEvents',
      () => {
        getRoomEvents.mockRejectedValue(new Error('events boom'));
      },
    ],
  ] as const) {
    it(`${label} failure stops before persist`, async () => {
      setup();
      const env = createSyncEnv();
      const result = await new RoomJoinWorkflow({} as never, env as never).run(
        { payload: { roomId: ROOM, userId: USER, isRemote: false } } as never,
        mockStep() as never
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/boom/);
      expect(storeEvent).not.toHaveBeenCalled();
    });
  }

  it('duplicate non-joining members are notified twice; joiner filtered only', async () => {
    getRoomMembers.mockResolvedValue([
      { userId: USER },
      { userId: '@bob:example.com' },
      { userId: '@bob:example.com' },
      { userId: '@carol:example.com' },
    ]);
    const env = createSyncEnv();
    await new RoomJoinWorkflow({} as never, env as never).run(
      { payload: { roomId: ROOM, userId: USER, isRemote: false } } as never,
      mockStep() as never
    );
    expect(env.notified.map((n) => n.userId).sort()).toEqual(
      ['@bob:example.com', '@bob:example.com', '@carol:example.com'].sort()
    );
  });

  it('SYNC.idFromName / get exceptions are swallowed per member', async () => {
    getRoomMembers.mockResolvedValue([
      { userId: '@bob:example.com' },
      { userId: '@carol:example.com' },
      { userId: '@dave:example.com' },
    ]);
    const env = createSyncEnv({
      idFromNameThrow: new Set(['@bob:example.com']),
      getThrow: new Set(['@carol:example.com']),
    });
    const result = await new RoomJoinWorkflow({} as never, env as never).run(
      { payload: { roomId: ROOM, userId: USER, isRemote: false } } as never,
      mockStep() as never
    );
    expect(result.success).toBe(true);
    expect(env.notified.map((n) => n.userId)).toEqual(['@dave:example.com']);
  });

  it('non-OK Sync DO fetch is treated as successful notification (status ignored)', async () => {
    getRoomMembers.mockResolvedValue([
      { userId: '@bob:example.com' },
      { userId: '@carol:example.com' },
    ]);
    const env = createSyncEnv({ nonOkUsers: new Set(['@bob:example.com']) });
    const result = await new RoomJoinWorkflow({} as never, env as never).run(
      { payload: { roomId: ROOM, userId: USER, isRemote: false } } as never,
      mockStep() as never
    );
    expect(result.success).toBe(true);
    expect(env.notified).toHaveLength(2);
    expect(env.notified.find((n) => n.userId === '@bob:example.com')?.status).toBe(500);
  });

  it('deferred Sync DO fetches prove true parallelism inside one notify batch', async () => {
    getRoomMembers.mockResolvedValue([
      { userId: '@bob:example.com' },
      { userId: '@carol:example.com' },
      { userId: '@dave:example.com' },
    ]);
    const started: string[] = [];
    const release = new Map<string, () => void>();
    const env = createSyncEnv({
      deferredUsers: new Set(['@bob:example.com', '@carol:example.com', '@dave:example.com']),
      started,
      release,
    });
    const runPromise = new RoomJoinWorkflow({} as never, env as never).run(
      { payload: { roomId: ROOM, userId: USER, isRemote: false } } as never,
      mockStep() as never
    );
    for (let i = 0; i < 30 && started.length < 3; i++) {
      await Promise.resolve();
    }
    expect(started.sort()).toEqual(
      ['@bob:example.com', '@carol:example.com', '@dave:example.com'].sort()
    );
    for (const uid of ['@bob:example.com', '@carol:example.com', '@dave:example.com']) {
      release.get(uid)?.();
    }
    const result = await runPromise;
    expect(result.success).toBe(true);
    expect(env.notified).toHaveLength(3);
  });

  it('second notify-batch does not begin until first Promise.all completes', async () => {
    const members = Array.from({ length: 51 }, (_, i) => ({
      userId: `@u${i}:example.com`,
    }));
    getRoomMembers.mockResolvedValue(members);
    const started: string[] = [];
    const release = new Map<string, () => void>();
    // Hold only the first batch member so batch-0 parks; batch-50 must not start.
    const env = createSyncEnv({
      deferredUsers: new Set(['@u0:example.com']),
      started,
      release,
    });
    const step = mockStep();
    const runPromise = new RoomJoinWorkflow({} as never, env as never).run(
      { payload: { roomId: ROOM, userId: USER, isRemote: false } } as never,
      step as never
    );
    for (let i = 0; i < 40 && started.length < 1; i++) {
      await Promise.resolve();
    }
    expect(started).toContain('@u0:example.com');
    // While batch-0 is deferred, notify-batch-50 must not have been scheduled yet.
    expect(step.names.filter((n) => n.startsWith('notify-batch-'))).toEqual(['notify-batch-0']);
    expect(started.some((u) => u === '@u50:example.com')).toBe(false);

    release.get('@u0:example.com')?.();
    const result = await runPromise;
    expect(result.success).toBe(true);
    expect(step.names.filter((n) => n.startsWith('notify-batch-'))).toEqual([
      'notify-batch-0',
      'notify-batch-50',
    ]);
    expect(started).toContain('@u50:example.com');
  });
});

describe('join-template-validation after #187: root/event / explicit-null leftovers', () => {
  const roomId = ROOM;
  const userId = USER;

  function validTemplate(overrides: Record<string, unknown> = {}) {
    return {
      room_version: '10',
      event: {
        room_id: roomId,
        sender: userId,
        state_key: userId,
        type: 'm.room.member',
        content: { membership: 'join' },
        auth_events: ['$auth1'],
        prev_events: ['$prev1'],
        depth: 3,
        ...overrides,
      },
    };
  }

  it('root array follows unsupported room_version path (typeof object)', () => {
    expect(() =>
      validateRemoteJoinTemplate([] as unknown as { room_version?: unknown }, roomId, userId)
    ).toThrow(/unsupported room_version/);
  });

  for (const root of ['str', 7, true, false] as const) {
    it(`root ${typeof root}=${String(root)} → not an object`, () => {
      expect(() =>
        validateRemoteJoinTemplate(root as unknown as { room_version?: unknown }, roomId, userId)
      ).toThrow(/not an object/);
    });
  }

  it('event:null → missing event template', () => {
    expect(() =>
      validateRemoteJoinTemplate({ room_version: '10', event: null }, roomId, userId)
    ).toThrow(/missing event/);
  });

  for (const field of ['room_id', 'sender', 'state_key', 'type'] as const) {
    it(`explicit null ${field} is rejected (not omitted)`, () => {
      expect(() =>
        validateRemoteJoinTemplate(validTemplate({ [field]: null }), roomId, userId)
      ).toThrow();
    });
  }

  it('whitespace-padded supported version is rejected', () => {
    expect(() =>
      validateRemoteJoinTemplate({ ...validTemplate(), room_version: ' 10 ' }, roomId, userId)
    ).toThrow(/unsupported room_version/);
  });

  for (const content of [false, true, 0, 1] as const) {
    it(`content=${String(content)} rejected`, () => {
      expect(() =>
        validateRemoteJoinTemplate(validTemplate({ content }), roomId, userId)
      ).toThrow(/membership/);
    });
  }

  it('auth_events:null rejected', () => {
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ auth_events: null }), roomId, userId)
    ).toThrow(/auth_events/);
  });

  it('prev_events string rejected', () => {
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ prev_events: '$only' }), roomId, userId)
    ).toThrow(/prev_events/);
  });

  it('sparse prev_events with hole yields invalid event ID', () => {
    const sparse: string[] = [];
    sparse[1] = '$ok';
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ prev_events: sparse }), roomId, userId)
    ).toThrow(/invalid event ID/);
  });

  for (const bad of ['$id\n', '$id\r', '$id\t', '$id\0'] as const) {
    it(`event ID with control char rejected: ${JSON.stringify(bad)}`, () => {
      expect(() =>
        validateRemoteJoinTemplate(
          validTemplate({ auth_events: [bad], prev_events: ['$p'] }),
          roomId,
          userId
        )
      ).toThrow(/invalid event ID/);
    });
  }

  it('Number.MAX_VALUE depth passes finite/integer/positive predicate', () => {
    // Number.isInteger(Number.MAX_VALUE) is true in JS
    expect(Number.isInteger(Number.MAX_VALUE)).toBe(true);
    expect(() =>
      validateRemoteJoinTemplate(validTemplate({ depth: Number.MAX_VALUE }), roomId, userId)
    ).not.toThrow();
  });
});

describe('room-join after #187: soft flood concurrent matrices', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Promise.all local joins across rooms isolate store/notify', async () => {
    const rooms = ['!a:example.com', '!b:example.com', '!c:example.com', '!d:example.com'];
    const results = await Promise.all(
      rooms.map(async (roomId, i) => {
        // Each run shares module mocks — serialize store captures via per-call inspection after all settle
        const env = createSyncEnv();
        getRoomMembers.mockResolvedValueOnce([{ userId: `@bob${i}:example.com` }]);
        const r = await new RoomJoinWorkflow({} as never, env as never).run(
          { payload: { roomId, userId: `@alice${i}:example.com`, isRemote: false } } as never,
          mockStep() as never
        );
        return { r, notified: env.notified, roomId };
      })
    );
    for (const row of results) {
      expect(row.r.success).toBe(true);
      expect(row.r.roomId).toBe(row.roomId);
      expect(row.notified).toHaveLength(1);
    }
    expect(storeEvent).toHaveBeenCalledTimes(4);
  });

  for (const status of [400, 401, 403, 404, 429, 500, 502, 503] as const) {
    it(`make_join text soft flood status=${status} preserves status in error`, async () => {
      federationGet.mockResolvedValue(new Response(`err-${status}`, { status }));
      const result = await new RoomJoinWorkflow({} as never, createSyncEnv() as never).run(
        {
          payload: { roomId: ROOM, userId: USER, isRemote: true, remoteServer: REMOTE },
        } as never,
        mockStep() as never
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe(`make_join failed: ${status} err-${status}`);
    });
  }
});
