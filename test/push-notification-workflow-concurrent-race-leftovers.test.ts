/**
 * TOKENMAXX HEAVY concurrent-race leftovers after #187 — PushNotificationWorkflow.
 * Complements push-notification-workflow.test.ts + push-notification-workflow-leftovers.test.ts.
 * Distinct edges: exact notify-batch retry descriptors, proven member fan-out,
 * concurrent-run isolation, room-context shape matrix, master/unread D1 fail
 * isolation, pusher JSON null/primitive/default_payload/aps edges, highlight
 * queue helper, body falsy APNs fallback, last_success/failure write fails.
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

import { PushNotificationWorkflow } from '../src/workflows/PushNotificationWorkflow';

const NOW = 1_700_000_000_000;
const ROOM = '!room:example.com';
const SENDER = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const DAVE = '@dave:example.com';
const EVE = '@eve:example.com';

type MembershipRow = { user_id: string; display_name: string | null };
type PusherRow = { pushkey: string; kind: string; app_id: string; data: string };
type QueuedRow = {
  user_id: string;
  room_id: string;
  event_id: string;
  notification_type: string;
  actions: string;
};
type PusherUpdate = {
  kind: 'success' | 'failure';
  ts: number;
  user_id: string;
  pushkey: string;
  app_id: string;
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

function createPushEnv(opts: {
  members?: MembershipRow[];
  memberCount?: number;
  senderDisplayName?: string | null;
  senderMembershipMissing?: boolean;
  roomNameContent?: string | null;
  masterEnabled?: Record<string, number | boolean>;
  masterThrowFor?: Set<string>;
  unreadCount?: number | null;
  unreadThrowFor?: Set<string>;
  pushers?: Record<string, PusherRow[]>;
  queueThrowFor?: Set<string>;
  successUpdateThrowFor?: Set<string>;
  failureUpdateThrowFor?: Set<string>;
  membersThrow?: boolean;
  contextThrow?: boolean;
  deferredMembers?: Set<string>;
  memberStarted?: string[];
  memberRelease?: Map<string, () => void>;
}) {
  const members = [...(opts.members ?? [])];
  const queued: QueuedRow[] = [];
  const pusherUpdates: PusherUpdate[] = [];
  const memberStarted = opts.memberStarted ?? [];
  const memberRelease = opts.memberRelease ?? new Map<string, () => void>();

  const env = {
    queued,
    pusherUpdates,
    memberStarted,
    memberRelease,
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async all<T>() {
                if (
                  sql.includes('FROM room_memberships') &&
                  sql.includes("membership = 'join'") &&
                  sql.includes('user_id !=')
                ) {
                  if (opts.membersThrow) throw new Error('members query failed');
                  return {
                    results: members
                      .filter((m) => m.user_id !== args[1])
                      .map((m) => ({ user_id: m.user_id })) as T[],
                  };
                }
                if (sql.includes('FROM pushers WHERE user_id')) {
                  const userId = args[0] as string;
                  memberStarted.push(userId);
                  if (opts.deferredMembers?.has(userId)) {
                    await new Promise<void>((resolve) => {
                      memberRelease.set(userId, resolve);
                    });
                  }
                  return { results: (opts.pushers?.[userId] ?? []) as T[] };
                }
                return { results: [] };
              },
              async first<T>() {
                if (opts.contextThrow && sql.includes('COUNT(*)') && sql.includes('FROM room_memberships')) {
                  throw new Error('context boom');
                }
                if (sql.includes('COUNT(*)') && sql.includes('FROM room_memberships')) {
                  return { count: opts.memberCount ?? members.length } as T;
                }
                if (sql.includes('SELECT display_name FROM room_memberships')) {
                  if (opts.senderMembershipMissing) return null;
                  const sender = args[1] as string;
                  const row = members.find((m) => m.user_id === sender);
                  const name =
                    opts.senderDisplayName !== undefined
                      ? opts.senderDisplayName
                      : (row?.display_name ?? null);
                  return { display_name: name } as T;
                }
                if (sql.includes("event_type = 'm.room.name'")) {
                  if (opts.roomNameContent === null || opts.roomNameContent === undefined) {
                    return null;
                  }
                  return { content: opts.roomNameContent } as T;
                }
                if (sql.includes("rule_id = '.m.rule.master'")) {
                  const userId = args[0] as string;
                  if (opts.masterThrowFor?.has(userId)) throw new Error(`master boom ${userId}`);
                  const enabled = opts.masterEnabled?.[userId];
                  if (enabled === undefined) return null;
                  return { enabled } as T;
                }
                if (sql.includes('COUNT(*)') && sql.includes('FROM events e')) {
                  const userId = args[1] as string;
                  if (opts.unreadThrowFor?.has(userId)) throw new Error(`unread boom ${userId}`);
                  if (opts.unreadCount === null) return { count: null } as T;
                  return { count: opts.unreadCount ?? 3 } as T;
                }
                return null;
              },
              async run() {
                if (sql.includes('INSERT INTO notification_queue')) {
                  const userId = args[0] as string;
                  if (opts.queueThrowFor?.has(userId)) {
                    throw new Error('queue insert failed');
                  }
                  queued.push({
                    user_id: userId,
                    room_id: args[1] as string,
                    event_id: args[2] as string,
                    notification_type: args[3] as string,
                    actions: args[4] as string,
                  });
                  return { meta: { changes: 1 } };
                }
                if (sql.includes('UPDATE pushers SET last_success')) {
                  const userId = args[1] as string;
                  if (opts.successUpdateThrowFor?.has(userId)) {
                    throw new Error('success update fail');
                  }
                  pusherUpdates.push({
                    kind: 'success',
                    ts: args[0] as number,
                    user_id: userId,
                    pushkey: args[2] as string,
                    app_id: args[3] as string,
                  });
                  return { meta: { changes: 1 } };
                }
                if (sql.includes('UPDATE pushers SET last_failure')) {
                  const userId = args[1] as string;
                  if (opts.failureUpdateThrowFor?.has(userId)) {
                    throw new Error('failure update fail');
                  }
                  pusherUpdates.push({
                    kind: 'failure',
                    ts: args[0] as number,
                    user_id: userId,
                    pushkey: args[2] as string,
                    app_id: args[3] as string,
                  });
                  return { meta: { changes: 1 } };
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
    queued: QueuedRow[];
    pusherUpdates: PusherUpdate[];
    memberStarted: string[];
    memberRelease: Map<string, () => void>;
  };
}

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    eventId: '$evt:example.com',
    roomId: ROOM,
    eventType: 'm.room.message',
    sender: SENDER,
    content: { body: 'hello', msgtype: 'm.text' },
    originServerTs: NOW - 1000,
    ...overrides,
  };
}

function httpPusher(
  overrides: Partial<PusherRow> & { dataObj?: unknown; dataRaw?: string } = {}
): PusherRow {
  const { dataObj, dataRaw, ...rest } = overrides;
  return {
    pushkey: 'pk1',
    kind: 'http',
    app_id: 'app.ios',
    data:
      dataRaw ??
      JSON.stringify(
        dataObj ?? {
          url: 'https://push.example.com/gateway',
          format: 'event_id_only',
          default_payload: { aps: { sound: 'default' } },
        }
      ),
    ...rest,
  };
}

const EXPECTED_BATCH_RETRY = {
  retries: { limit: 2, delay: 5000, backoff: 'exponential' },
  timeout: 60000,
};

describe('push-workflow after #187: durable retry-step contracts', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
    fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('pins exact notify-batch-0 retry descriptor', async () => {
    const env = createPushEnv({
      members: [
        { user_id: SENDER, display_name: 'Alice' },
        { user_id: BOB, display_name: 'Bob' },
      ],
      pushers: { [BOB]: [httpPusher()] },
    });
    const step = mockStep();
    await new PushNotificationWorkflow({} as never, env as never).run(
      { payload: basePayload() } as never,
      step as never
    );
    expect(step.optsLog).toEqual([{ name: 'notify-batch-0', opts: EXPECTED_BATCH_RETRY }]);
  });

  it('retains exact retry descriptor for notify-batch-0 and notify-batch-50', async () => {
    const members: MembershipRow[] = [{ user_id: SENDER, display_name: 'Alice' }];
    const pushers: Record<string, PusherRow[]> = {};
    for (let i = 0; i < 51; i++) {
      const uid = `@u${i}:example.com`;
      members.push({ user_id: uid, display_name: `U${i}` });
      pushers[uid] = [httpPusher({ pushkey: `pk${i}`, app_id: `app${i}` })];
    }
    const env = createPushEnv({ members, pushers, memberCount: members.length });
    const step = mockStep();
    await new PushNotificationWorkflow({} as never, env as never).run(
      { payload: basePayload() } as never,
      step as never
    );
    expect(step.names.filter((n) => n.startsWith('notify-batch-'))).toEqual([
      'notify-batch-0',
      'notify-batch-50',
    ]);
    expect(step.optsLog).toEqual([
      { name: 'notify-batch-0', opts: EXPECTED_BATCH_RETRY },
      { name: 'notify-batch-50', opts: EXPECTED_BATCH_RETRY },
    ]);
  });
});

describe('push-workflow after #187: proven parallel member fan-out', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
    fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('starts all member pusher lookups before any deferred member resolves', async () => {
    const members = [
      { user_id: SENDER, display_name: 'Alice' },
      { user_id: BOB, display_name: 'Bob' },
      { user_id: CAROL, display_name: 'Carol' },
      { user_id: DAVE, display_name: 'Dave' },
    ];
    const pushers = {
      [BOB]: [httpPusher({ pushkey: 'b' })],
      [CAROL]: [httpPusher({ pushkey: 'c' })],
      [DAVE]: [httpPusher({ pushkey: 'd' })],
    };
    const memberStarted: string[] = [];
    const memberRelease = new Map<string, () => void>();
    const env = createPushEnv({
      members,
      pushers,
      deferredMembers: new Set([BOB, CAROL, DAVE]),
      memberStarted,
      memberRelease,
    });

    const runPromise = new PushNotificationWorkflow({} as never, env as never).run(
      { payload: basePayload() } as never,
      mockStep() as never
    );

    // Allow microtasks to schedule all map() callbacks until they park on deferred pushers.
    for (let i = 0; i < 20 && memberStarted.length < 3; i++) {
      await Promise.resolve();
    }
    expect(memberStarted.sort()).toEqual([BOB, CAROL, DAVE].sort());

    for (const uid of [BOB, CAROL, DAVE]) {
      memberRelease.get(uid)?.();
    }
    const result = await runPromise;
    expect(result.success).toBe(true);
    expect(result.notifiedCount).toBe(3);
  });
});

describe('push-workflow after #187: concurrent-run aggregation isolation', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
    fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('two concurrent runs with separate event IDs do not cross-contaminate queues', async () => {
    const envA = createPushEnv({
      members: [
        { user_id: SENDER, display_name: 'Alice' },
        { user_id: BOB, display_name: 'Bob' },
      ],
      pushers: { [BOB]: [httpPusher({ pushkey: 'a' })] },
    });
    const envB = createPushEnv({
      members: [
        { user_id: SENDER, display_name: 'Alice' },
        { user_id: CAROL, display_name: 'Carol' },
      ],
      pushers: { [CAROL]: [httpPusher({ pushkey: 'b' })] },
    });
    const [ra, rb] = await Promise.all([
      new PushNotificationWorkflow({} as never, envA as never).run(
        { payload: basePayload({ eventId: '$a:example.com' }) } as never,
        mockStep() as never
      ),
      new PushNotificationWorkflow({} as never, envB as never).run(
        { payload: basePayload({ eventId: '$b:example.com' }) } as never,
        mockStep() as never
      ),
    ]);
    expect(ra.notifiedCount).toBe(1);
    expect(rb.notifiedCount).toBe(1);
    expect(envA.queued.map((q) => q.event_id)).toEqual(['$a:example.com']);
    expect(envB.queued.map((q) => q.event_id)).toEqual(['$b:example.com']);
    expect(envA.pusherUpdates.every((u) => u.pushkey === 'a')).toBe(true);
    expect(envB.pusherUpdates.every((u) => u.pushkey === 'b')).toBe(true);
  });
});

describe('push-workflow after #187: room-context shape matrix', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
    fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('missing sender membership falls back to Matrix localpart', async () => {
    const env = createPushEnv({
      members: [{ user_id: BOB, display_name: 'Bob' }],
      senderMembershipMissing: true,
      memberCount: 3,
      pushers: { [BOB]: [httpPusher()] },
    });
    await new PushNotificationWorkflow({} as never, env as never).run(
      { payload: basePayload() } as never,
      mockStep() as never
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.notification.sender_display_name).toBe('alice');
  });

  it('empty-string display_name falls back to localpart', async () => {
    const env = createPushEnv({
      members: [
        { user_id: SENDER, display_name: '' },
        { user_id: BOB, display_name: 'Bob' },
      ],
      senderDisplayName: '',
      memberCount: 3,
      pushers: { [BOB]: [httpPusher()] },
    });
    await new PushNotificationWorkflow({} as never, env as never).run(
      { payload: basePayload() } as never,
      mockStep() as never
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.notification.sender_display_name).toBe('alice');
  });

  for (const [label, content] of [
    ['empty object', '{}'],
    ['empty name', JSON.stringify({ name: '' })],
    ['null name', JSON.stringify({ name: null })],
    ['primitive string JSON', JSON.stringify('Lobby')],
    ['primitive number JSON', '42'],
    ['null JSON', 'null'],
  ] as const) {
    it(`room name content ${label} follows DM/Chat fallback`, async () => {
      const env = createPushEnv({
        members: [
          { user_id: SENDER, display_name: 'Alice' },
          { user_id: BOB, display_name: 'Bob' },
        ],
        memberCount: 2,
        roomNameContent: content,
        pushers: { [BOB]: [httpPusher()] },
      });
      await new PushNotificationWorkflow({} as never, env as never).run(
        { payload: basePayload() } as never,
        mockStep() as never
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      // falsy/non-string parsed.name → DM fallback to senderDisplayName
      expect(body.notification.room_name).toBe('Alice');
    });
  }

  it('named room with >2 members keeps parsed name', async () => {
    const env = createPushEnv({
      members: [
        { user_id: SENDER, display_name: 'Alice' },
        { user_id: BOB, display_name: 'Bob' },
        { user_id: CAROL, display_name: 'Carol' },
      ],
      memberCount: 3,
      roomNameContent: JSON.stringify({ name: 'General' }),
      pushers: { [BOB]: [httpPusher()] },
    });
    await new PushNotificationWorkflow({} as never, env as never).run(
      { payload: basePayload() } as never,
      mockStep() as never
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.notification.room_name).toBe('General');
  });
});

describe('push-workflow after #187: master / unread fail isolation', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
    fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const enabled of [0, 2, true] as const) {
    it(`master enabled=${String(enabled)} does not suppress (only === 1 kills)`, async () => {
      const env = createPushEnv({
        members: [
          { user_id: SENDER, display_name: 'Alice' },
          { user_id: BOB, display_name: 'Bob' },
        ],
        masterEnabled: { [BOB]: enabled },
        pushers: { [BOB]: [httpPusher()] },
      });
      const result = await new PushNotificationWorkflow({} as never, env as never).run(
        { payload: basePayload() } as never,
        mockStep() as never
      );
      expect(result.notifiedCount).toBe(1);
      expect(result.skippedCount).toBe(0);
    });
  }

  it('master D1 throw fails one member; siblings still notify', async () => {
    const env = createPushEnv({
      members: [
        { user_id: SENDER, display_name: 'Alice' },
        { user_id: BOB, display_name: 'Bob' },
        { user_id: CAROL, display_name: 'Carol' },
      ],
      masterThrowFor: new Set([BOB]),
      pushers: {
        [BOB]: [httpPusher({ pushkey: 'b' })],
        [CAROL]: [httpPusher({ pushkey: 'c' })],
      },
    });
    const result = await new PushNotificationWorkflow({} as never, env as never).run(
      { payload: basePayload() } as never,
      mockStep() as never
    );
    expect(result.failedCount).toBe(1);
    expect(result.notifiedCount).toBe(1);
    expect(env.queued.map((q) => q.user_id)).toEqual([CAROL]);
  });

  it('unread D1 throw fails one member; siblings still notify', async () => {
    const env = createPushEnv({
      members: [
        { user_id: SENDER, display_name: 'Alice' },
        { user_id: BOB, display_name: 'Bob' },
        { user_id: CAROL, display_name: 'Carol' },
      ],
      unreadThrowFor: new Set([CAROL]),
      pushers: {
        [BOB]: [httpPusher({ pushkey: 'b' })],
        [CAROL]: [httpPusher({ pushkey: 'c' })],
      },
    });
    const result = await new PushNotificationWorkflow({} as never, env as never).run(
      { payload: basePayload() } as never,
      mockStep() as never
    );
    expect(result.failedCount).toBe(1);
    expect(result.notifiedCount).toBe(1);
    expect(env.queued.map((q) => q.user_id)).toEqual([BOB]);
  });
});

describe('push-workflow after #187: pusher JSON / APNs / update-fail edges', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
    fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const [label, dataRaw] of [
    ['JSON null', 'null'],
    ['JSON number', '42'],
    ['JSON string', '"https://push.example.com"'],
    ['JSON true', 'true'],
  ] as const) {
    it(`pusher data ${label} throws before URL; swallowed; still queues`, async () => {
      const env = createPushEnv({
        members: [
          { user_id: SENDER, display_name: 'Alice' },
          { user_id: BOB, display_name: 'Bob' },
        ],
        pushers: { [BOB]: [httpPusher({ dataRaw })] },
      });
      const result = await new PushNotificationWorkflow({} as never, env as never).run(
        { payload: basePayload() } as never,
        mockStep() as never
      );
      // anySuccess false but not skipped; queue still happens
      expect(result.notifiedCount).toBe(0);
      expect(result.skippedCount).toBe(0);
      expect(result.failedCount).toBe(0);
      expect(env.queued).toHaveLength(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it('default_payload:null uses {} via || and still delivers Matrix device fields', async () => {
    const env = createPushEnv({
      members: [
        { user_id: SENDER, display_name: 'Alice' },
        { user_id: BOB, display_name: 'Bob' },
      ],
      pushers: {
        [BOB]: [
          httpPusher({
            dataObj: {
              url: 'https://push.example.com/gateway',
              format: 'full',
              default_payload: null,
            },
          }),
        ],
      },
    });
    const result = await new PushNotificationWorkflow({} as never, env as never).run(
      { payload: basePayload() } as never,
      mockStep() as never
    );
    expect(result.notifiedCount).toBe(1);
    expect(env.queued).toHaveLength(1);
    const deviceData = JSON.parse(fetchMock.mock.calls[0][1].body as string).notification
      .devices[0].data.default_payload;
    expect(deviceData.event_id).toBe('$evt:example.com');
    expect(deviceData.aps).toBeUndefined();
  });

  it('aps:null skips APNs mutation but continues with Matrix device fields', async () => {
    const env = createPushEnv({
      members: [
        { user_id: SENDER, display_name: 'Alice' },
        { user_id: BOB, display_name: 'Bob' },
      ],
      pushers: {
        [BOB]: [
          httpPusher({
            dataObj: {
              url: 'https://push.example.com/gateway',
              format: 'full',
              default_payload: { aps: null, custom: 1 },
            },
          }),
        ],
      },
    });
    const result = await new PushNotificationWorkflow({} as never, env as never).run(
      { payload: basePayload() } as never,
      mockStep() as never
    );
    expect(result.notifiedCount).toBe(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const deviceData = body.notification.devices[0].data.default_payload;
    expect(deviceData.aps).toBeNull();
    expect(deviceData.event_id).toBe('$evt:example.com');
    expect(deviceData.room_id).toBe(ROOM);
    expect(deviceData.custom).toBe(1);
  });

  it('success-status with last_success D1 fail → failure update attempted then swallowed; still queues', async () => {
    const env = createPushEnv({
      members: [
        { user_id: SENDER, display_name: 'Alice' },
        { user_id: BOB, display_name: 'Bob' },
      ],
      pushers: { [BOB]: [httpPusher()] },
      successUpdateThrowFor: new Set([BOB]),
    });
    const result = await new PushNotificationWorkflow({} as never, env as never).run(
      { payload: basePayload() } as never,
      mockStep() as never
    );
    // success update throws → catch path updates failure → if that works, throw rethrown → per-pusher catch
    expect(result.notifiedCount).toBe(0);
    expect(env.queued).toHaveLength(1);
    expect(env.pusherUpdates.some((u) => u.kind === 'failure')).toBe(true);
  });

  it('failure-status with failure-update write fail is swallowed; still queues', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    const env = createPushEnv({
      members: [
        { user_id: SENDER, display_name: 'Alice' },
        { user_id: BOB, display_name: 'Bob' },
      ],
      pushers: { [BOB]: [httpPusher()] },
      failureUpdateThrowFor: new Set([BOB]),
    });
    const result = await new PushNotificationWorkflow({} as never, env as never).run(
      { payload: basePayload() } as never,
      mockStep() as never
    );
    // !ok path awaits failure update which throws → outer catch tries failure update again → throws → per-pusher catch
    expect(result.notifiedCount).toBe(0);
    expect(env.queued).toHaveLength(1);
  });

  for (const [label, content] of [
    ['null content', null],
    ['empty body', { body: '', msgtype: 'm.text' }],
    ['numeric zero body', { body: 0, msgtype: 'm.text' }],
  ] as const) {
    it(`${label} → APNs "New message" fallback`, async () => {
      const env = createPushEnv({
        members: [
          { user_id: SENDER, display_name: 'Alice' },
          { user_id: BOB, display_name: 'Bob' },
        ],
        roomNameContent: JSON.stringify({ name: 'Lobby' }),
        memberCount: 3,
        pushers: {
          [BOB]: [
            httpPusher({
              dataObj: {
                url: 'https://push.example.com/gateway',
                format: 'full',
                default_payload: { aps: { sound: 'default' } },
              },
            }),
          ],
        },
      });
      await new PushNotificationWorkflow({} as never, env as never).run(
        { payload: basePayload({ content }) } as never,
        mockStep() as never
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.notification.devices[0].data.default_payload.aps.alert.body).toBe(
        'New message'
      );
    });
  }

  it('custom non-APNs fields survive while aps.alert is overwritten', async () => {
    const env = createPushEnv({
      members: [
        { user_id: SENDER, display_name: 'Alice' },
        { user_id: BOB, display_name: 'Bob' },
      ],
      roomNameContent: JSON.stringify({ name: 'Lobby' }),
      memberCount: 3,
      pushers: {
        [BOB]: [
          httpPusher({
            dataObj: {
              url: 'https://push.example.com/gateway',
              format: 'full',
              default_payload: {
                aps: { sound: 'ping', badge: 3, 'thread-id': 't1' },
                foo: 'bar',
                nested: { x: 1 },
              },
            },
          }),
        ],
      },
    });
    await new PushNotificationWorkflow({} as never, env as never).run(
      { payload: basePayload({ content: { body: 'hi' } }) } as never,
      mockStep() as never
    );
    const deviceData = JSON.parse(fetchMock.mock.calls[0][1].body as string).notification
      .devices[0].data.default_payload;
    expect(deviceData.foo).toBe('bar');
    expect(deviceData.nested).toEqual({ x: 1 });
    expect(deviceData.aps.sound).toBe('ping');
    expect(deviceData.aps.badge).toBe(3);
    expect(deviceData.aps['thread-id']).toBe('t1');
    expect(deviceData.aps['mutable-content']).toBe(1);
    expect(deviceData.aps.alert).toEqual({
      title: 'Alice',
      subtitle: 'Lobby',
      body: 'hi',
    });
  });

  it('queueNotification highlight:true via private helper writes notification_type highlight', async () => {
    const env = createPushEnv({
      members: [{ user_id: BOB, display_name: 'Bob' }],
    });
    const wf = new PushNotificationWorkflow({} as never, env as never);
    await (
      wf as unknown as {
        queueNotification: (
          userId: string,
          ctx: { eventId: string; roomId: string },
          pushResult: { notify: boolean; actions: unknown[]; highlight: boolean }
        ) => Promise<void>;
      }
    ).queueNotification(
      BOB,
      { eventId: '$h:example.com', roomId: ROOM },
      { notify: true, actions: ['notify', 'highlight'], highlight: true }
    );
    expect(env.queued).toEqual([
      {
        user_id: BOB,
        room_id: ROOM,
        event_id: '$h:example.com',
        notification_type: 'highlight',
        actions: JSON.stringify(['notify', 'highlight']),
      },
    ]);
  });

  it('multi-recipient soft flood: mixed master/unread/update fails stay isolated', async () => {
    const env = createPushEnv({
      members: [
        { user_id: SENDER, display_name: 'Alice' },
        { user_id: BOB, display_name: 'Bob' },
        { user_id: CAROL, display_name: 'Carol' },
        { user_id: DAVE, display_name: 'Dave' },
        { user_id: EVE, display_name: 'Eve' },
      ],
      masterEnabled: { [BOB]: 1 },
      unreadThrowFor: new Set([CAROL]),
      successUpdateThrowFor: new Set([DAVE]),
      pushers: {
        [BOB]: [httpPusher({ pushkey: 'b' })],
        [CAROL]: [httpPusher({ pushkey: 'c' })],
        [DAVE]: [httpPusher({ pushkey: 'd' })],
        [EVE]: [httpPusher({ pushkey: 'e' })],
      },
    });
    const result = await new PushNotificationWorkflow({} as never, env as never).run(
      { payload: basePayload() } as never,
      mockStep() as never
    );
    expect(result.skippedCount).toBe(1); // BOB master
    expect(result.failedCount).toBe(1); // CAROL unread
    expect(result.notifiedCount).toBe(1); // EVE only (DAVE success-update fail → notified false)
    expect(env.queued.map((q) => q.user_id).sort()).toEqual([DAVE, EVE].sort());
  });
});

describe('push-workflow after #187: soft flood concurrent matrices', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
    fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const status of [200, 201, 202, 203, 204, 299] as const) {
    it(`gateway 2xx status ${status} pins last_success`, async () => {
      if (status === 204) {
        fetchMock.mockResolvedValue(new Response(null, { status }));
      } else {
        fetchMock.mockResolvedValue(new Response('ok', { status }));
      }
      const env = createPushEnv({
        members: [
          { user_id: SENDER, display_name: 'Alice' },
          { user_id: BOB, display_name: 'Bob' },
        ],
        pushers: { [BOB]: [httpPusher()] },
      });
      const result = await new PushNotificationWorkflow({} as never, env as never).run(
        { payload: basePayload() } as never,
        mockStep() as never
      );
      expect(result.notifiedCount).toBe(1);
      expect(env.pusherUpdates.map((u) => u.kind)).toEqual(['success']);
    });
  }

  it('Promise.all event-id soft flood keeps queue/update isolation across 8 runs', async () => {
    const runs = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const uid = `@u${i}:example.com`;
        const env = createPushEnv({
          members: [
            { user_id: SENDER, display_name: 'Alice' },
            { user_id: uid, display_name: `U${i}` },
          ],
          pushers: { [uid]: [httpPusher({ pushkey: `pk${i}`, app_id: `app${i}` })] },
        });
        const eventId = `$e${i}:example.com`;
        const r = await new PushNotificationWorkflow({} as never, env as never).run(
          { payload: basePayload({ eventId }) } as never,
          mockStep() as never
        );
        return { r, env, eventId, uid };
      })
    );
    for (const row of runs) {
      expect(row.r.notifiedCount).toBe(1);
      expect(row.env.queued).toEqual([
        expect.objectContaining({ event_id: row.eventId, user_id: row.uid }),
      ]);
      expect(row.env.pusherUpdates).toEqual([
        expect.objectContaining({ pushkey: expect.stringMatching(/^pk\d$/), kind: 'success' }),
      ]);
    }
  });
});
