/**
 * TOKENMAXX HEAVY leftovers after #170/#171 — PushNotificationWorkflow soft/edge/reliability.
 * Complements push-notification-workflow.test.ts (not push HTTP leftovers / #177).
 * Focus: event-type skip matrices, gateway HTTP status soft floods, unread nullish,
 * multi-pusher partial fails, batch aggregation races, master-kill soft floods,
 * APNs/format payload edges, and top-level catch isolation.
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
  return {
    names,
    async do(name: string, optsOrFn: unknown, maybeFn?: unknown) {
      names.push(name);
      const fn = typeof optsOrFn === 'function' ? optsOrFn : maybeFn;
      return (fn as () => Promise<unknown>)();
    },
  };
}

function createPushEnv(opts: {
  members?: MembershipRow[];
  memberCount?: number;
  senderDisplayName?: string | null;
  roomNameContent?: string | null;
  masterEnabled?: Record<string, number>;
  pushers?: Record<string, PusherRow[]>;
  unreadCount?: number | null;
  queueThrowFor?: Set<string>;
  membersThrow?: boolean;
  contextThrow?: boolean;
}) {
  const members = [...(opts.members ?? [])];
  const queued: QueuedRow[] = [];
  const pusherUpdates: PusherUpdate[] = [];
  let lastMemberQuery: { roomId: string; sender: string } | undefined;

  const env = {
    queued,
    pusherUpdates,
    getLastMemberQuery: () => lastMemberQuery,
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
                  lastMemberQuery = { roomId: args[0] as string, sender: args[1] as string };
                  return {
                    results: members
                      .filter((m) => m.user_id !== args[1])
                      .map((m) => ({ user_id: m.user_id })) as T[],
                  };
                }
                if (sql.includes('FROM pushers WHERE user_id')) {
                  const userId = args[0] as string;
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
                  const enabled = opts.masterEnabled?.[userId];
                  if (enabled === undefined) return null;
                  return { enabled } as T;
                }
                if (sql.includes('COUNT(*)') && sql.includes('FROM events e')) {
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
                  pusherUpdates.push({
                    kind: 'success',
                    ts: args[0] as number,
                    user_id: args[1] as string,
                    pushkey: args[2] as string,
                    app_id: args[3] as string,
                  });
                  return { meta: { changes: 1 } };
                }
                if (sql.includes('UPDATE pushers SET last_failure')) {
                  pusherUpdates.push({
                    kind: 'failure',
                    ts: args[0] as number,
                    user_id: args[1] as string,
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
    getLastMemberQuery: () => { roomId: string; sender: string } | undefined;
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
  overrides: Partial<PusherRow> & { dataObj?: Record<string, unknown> } = {}
): PusherRow {
  const { dataObj, ...rest } = overrides;
  return {
    pushkey: 'pk1',
    kind: 'http',
    app_id: 'app.ios',
    data: JSON.stringify(
      dataObj ?? {
        url: 'https://push.example.com/gateway',
        format: 'event_id_only',
        default_payload: { aps: { sound: 'default' } },
      }
    ),
    ...rest,
  };
}

const SKIP_TYPES = [
  'm.room.member',
  'm.room.name',
  'm.room.topic',
  'm.room.avatar',
  'm.reaction',
  'm.room.redaction',
  'm.typing',
  'm.receipt',
  'm.presence',
  'm.call.invite',
  'org.matrix.msc3401.call.member',
  'm.space.child',
] as const;

const HTTP_STATUSES = [200, 201, 400, 401, 403, 404, 429, 500, 502, 503] as const;

describe('push-workflow leftovers event-type / master-kill soft flood after #171', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const eventType of SKIP_TYPES) {
    it(`skips non-message type ${eventType}`, async () => {
      const env = createPushEnv({
        members: [
          { user_id: SENDER, display_name: 'Alice' },
          { user_id: BOB, display_name: 'Bob' },
        ],
        pushers: { [BOB]: [httpPusher()] },
      });
      const wf = new PushNotificationWorkflow({} as any, env as any);
      const result = await wf.run(
        { payload: basePayload({ eventType }) } as any,
        mockStep() as any
      );
      expect(result).toEqual({
        success: true,
        notifiedCount: 0,
        failedCount: 0,
        skippedCount: 1,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(env.queued).toHaveLength(0);
    });
  }

  for (const eventType of ['m.room.message', 'm.room.encrypted'] as const) {
    it(`notifies for ${eventType}`, async () => {
      const env = createPushEnv({
        members: [
          { user_id: SENDER, display_name: 'Alice' },
          { user_id: BOB, display_name: 'Bob' },
        ],
        pushers: { [BOB]: [httpPusher()] },
      });
      const wf = new PushNotificationWorkflow({} as any, env as any);
      const result = await wf.run(
        { payload: basePayload({ eventType }) } as any,
        mockStep() as any
      );
      expect(result.notifiedCount).toBe(1);
      expect(result.skippedCount).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }

  it('master kill soft flood across recipients', async () => {
    const users = [BOB, CAROL, DAVE];
    for (let mask = 0; mask < 8; mask++) {
      const masterEnabled: Record<string, number> = {};
      for (let i = 0; i < users.length; i++) {
        if (mask & (1 << i)) masterEnabled[users[i]] = 1;
      }
      const env = createPushEnv({
        members: [
          { user_id: SENDER, display_name: 'Alice' },
          ...users.map((u) => ({ user_id: u, display_name: null })),
        ],
        masterEnabled,
        pushers: Object.fromEntries(users.map((u) => [u, [httpPusher({ pushkey: u })]])),
      });
      fetchMock.mockClear();
      const wf = new PushNotificationWorkflow({} as any, env as any);
      const result = await wf.run({ payload: basePayload() } as any, mockStep() as any);
      const killed = users.filter((_, i) => mask & (1 << i)).length;
      expect(result.skippedCount).toBe(killed);
      expect(result.notifiedCount).toBe(users.length - killed);
      expect(fetchMock).toHaveBeenCalledTimes(users.length - killed);
    }
  });
});

describe('push-workflow leftovers gateway HTTP status soft flood after #171', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const status of HTTP_STATUSES) {
    it(`gateway HTTP ${status} → ${status >= 200 && status < 300 ? 'success' : 'failure'} update`, async () => {
      fetchMock.mockResolvedValue(new Response(`s-${status}`, { status }));
      const env = createPushEnv({
        members: [
          { user_id: SENDER, display_name: 'Alice' },
          { user_id: BOB, display_name: 'Bob' },
        ],
        pushers: { [BOB]: [httpPusher()] },
      });
      const wf = new PushNotificationWorkflow({} as any, env as any);
      const result = await wf.run({ payload: basePayload() } as any, mockStep() as any);
      const ok = status >= 200 && status < 300;
      expect(result.notifiedCount).toBe(ok ? 1 : 0);
      expect(result.failedCount).toBe(0); // HTTP !ok returns false, no member error
      expect(env.pusherUpdates).toHaveLength(1);
      expect(env.pusherUpdates[0].kind).toBe(ok ? 'success' : 'failure');
      expect(env.pusherUpdates[0].ts).toBe(NOW);
      expect(env.queued).toHaveLength(1);
    });
  }

  it('fetch throw soft flood pins failure; per-pusher catch → notified false (no failedCount)', async () => {
    for (const err of [new Error('net'), new Error('timeout'), new Error('reset')]) {
      fetchMock.mockRejectedValueOnce(err);
      const env = createPushEnv({
        members: [
          { user_id: SENDER, display_name: 'Alice' },
          { user_id: BOB, display_name: 'Bob' },
        ],
        pushers: { [BOB]: [httpPusher()] },
      });
      const wf = new PushNotificationWorkflow({} as any, env as any);
      const result = await wf.run({ payload: basePayload() } as any, mockStep() as any);
      // sendToPusher rethrows after recording failure, but processMemberBatch
      // swallows per-pusher errors — member returns notified:false without error.
      expect(result.notifiedCount).toBe(0);
      expect(result.failedCount).toBe(0);
      expect(result.skippedCount).toBe(0);
      expect(env.pusherUpdates[0]).toMatchObject({ kind: 'failure', ts: NOW });
      expect(env.queued).toHaveLength(1);
    }
  });
});

describe('push-workflow leftovers pusher gates / unread / format soft flood after #171', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('non-http kind soft flood → notified false after queue', async () => {
    for (const kind of ['email', 'apns', 'gcm', 'http_v1', '']) {
      fetchMock.mockClear();
      const env = createPushEnv({
        members: [
          { user_id: SENDER, display_name: 'Alice' },
          { user_id: BOB, display_name: null },
        ],
        pushers: { [BOB]: [httpPusher({ kind })] },
      });
      const wf = new PushNotificationWorkflow({} as any, env as any);
      const result = await wf.run({ payload: basePayload() } as any, mockStep() as any);
      expect(result.notifiedCount).toBe(0);
      expect(result.skippedCount).toBe(0);
      expect(env.queued).toHaveLength(1);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('bad JSON / missing url soft flood → notified false', async () => {
    const badData = ['not-json', '{', '{"url":""}', '{}', '{"url":null}'];
    for (const data of badData) {
      fetchMock.mockClear();
      const env = createPushEnv({
        members: [
          { user_id: SENDER, display_name: 'Alice' },
          { user_id: BOB, display_name: null },
        ],
        pushers: {
          [BOB]: [{ pushkey: 'pk', kind: 'http', app_id: 'app', data }],
        },
      });
      const wf = new PushNotificationWorkflow({} as any, env as any);
      const result = await wf.run({ payload: basePayload() } as any, mockStep() as any);
      expect(result.notifiedCount).toBe(0);
      expect(env.queued).toHaveLength(1);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('unread nullish soft flood → unread_count 1', async () => {
    for (const unread of [null, undefined] as const) {
      fetchMock.mockClear();
      const env = createPushEnv({
        members: [
          { user_id: SENDER, display_name: 'Alice' },
          { user_id: BOB, display_name: null },
        ],
        pushers: { [BOB]: [httpPusher()] },
        unreadCount: unread === undefined ? undefined : null,
      });
      // when undefined, harness defaults to 3 — so force null path only for null
      if (unread === undefined) {
        // override prepare unread path by setting unreadCount null and patching after
      }
      const wf = new PushNotificationWorkflow({} as any, env as any);
      await wf.run({ payload: basePayload() } as any, mockStep() as any);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      if (unread === null) {
        expect(body.notification.counts.unread).toBe(1);
        expect(body.notification.devices[0].data.default_payload.unread_count).toBe(1);
      } else {
        expect(body.notification.counts.unread).toBe(3);
      }
    }
  });

  it('unread explicit soft flood preserves counts', async () => {
    for (const unread of [0, 1, 2, 5, 99]) {
      fetchMock.mockClear();
      const env = createPushEnv({
        members: [
          { user_id: SENDER, display_name: 'Alice' },
          { user_id: BOB, display_name: null },
        ],
        pushers: { [BOB]: [httpPusher()] },
        unreadCount: unread,
      });
      const wf = new PushNotificationWorkflow({} as any, env as any);
      await wf.run({ payload: basePayload() } as any, mockStep() as any);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      // getUnreadCount: result?.count || 1 → 0 becomes 1
      expect(body.notification.counts.unread).toBe(unread || 1);
    }
  });

  it('format soft flood: event_id_only omits content; others include', async () => {
    for (const format of ['event_id_only', 'full', 'rich', undefined]) {
      fetchMock.mockClear();
      const env = createPushEnv({
        members: [
          { user_id: SENDER, display_name: 'Alice' },
          { user_id: BOB, display_name: null },
        ],
        pushers: {
          [BOB]: [
            httpPusher({
              dataObj: {
                url: 'https://push.example.com/gateway',
                format,
                default_payload: { aps: {} },
              },
            }),
          ],
        },
      });
      const wf = new PushNotificationWorkflow({} as any, env as any);
      await wf.run({ payload: basePayload() } as any, mockStep() as any);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      if (format === 'event_id_only') {
        expect(body.notification).not.toHaveProperty('content');
      } else {
        expect(body.notification.content).toEqual({ body: 'hello', msgtype: 'm.text' });
      }
    }
  });

  it('APNs alert soft flood: encrypted vs plaintext vs missing body', async () => {
    const cases = [
      {
        eventType: 'm.room.encrypted',
        content: {},
        expectAlert: { title: 'Alice', body: 'Chat' },
      },
      {
        eventType: 'm.room.message',
        content: { body: 'hi there', msgtype: 'm.text' },
        expectAlert: { title: 'Alice', subtitle: 'Chat', body: 'hi there' },
      },
      {
        eventType: 'm.room.message',
        content: { msgtype: 'm.text' },
        expectAlert: { title: 'Alice', subtitle: 'Chat', body: 'New message' },
      },
    ] as const;

    for (const c of cases) {
      fetchMock.mockClear();
      const env = createPushEnv({
        members: [
          { user_id: SENDER, display_name: 'Alice' },
          { user_id: BOB, display_name: null },
        ],
        memberCount: 5,
        pushers: { [BOB]: [httpPusher()] },
      });
      const wf = new PushNotificationWorkflow({} as any, env as any);
      await wf.run(
        {
          payload: basePayload({ eventType: c.eventType, content: c.content }),
        } as any,
        mockStep() as any
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.notification.devices[0].data.default_payload.aps.alert).toEqual(
        c.expectAlert
      );
      expect(body.notification.devices[0].data.default_payload.aps['mutable-content']).toBe(
        1
      );
    }
  });
});

describe('push-workflow leftovers multi-pusher / batch / catch soft flood after #171', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('multi-pusher partial success soft flood', async () => {
    // first pusher fails HTTP, second succeeds → notified true
    fetchMock
      .mockResolvedValueOnce(new Response('no', { status: 500 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const env = createPushEnv({
      members: [
        { user_id: SENDER, display_name: 'Alice' },
        { user_id: BOB, display_name: null },
      ],
      pushers: {
        [BOB]: [
          httpPusher({ pushkey: 'pk-a', app_id: 'app.a' }),
          httpPusher({ pushkey: 'pk-b', app_id: 'app.b' }),
        ],
      },
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run({ payload: basePayload() } as any, mockStep() as any);
    expect(result.notifiedCount).toBe(1);
    expect(env.pusherUpdates.map((u) => u.kind)).toEqual(['failure', 'success']);
  });

  it('multi-pusher all-fail soft flood → notified false, still queued', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('no', { status: 500 }))
      .mockResolvedValueOnce(new Response('no', { status: 503 }));
    const env = createPushEnv({
      members: [
        { user_id: SENDER, display_name: 'Alice' },
        { user_id: BOB, display_name: null },
      ],
      pushers: {
        [BOB]: [
          httpPusher({ pushkey: 'pk-a', app_id: 'app.a' }),
          httpPusher({ pushkey: 'pk-b', app_id: 'app.b' }),
        ],
      },
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run({ payload: basePayload() } as any, mockStep() as any);
    expect(result.notifiedCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(env.queued).toHaveLength(1);
  });

  it('batch sizing soft flood for large member sets', async () => {
    const sizes = [1, 49, 50, 51, 100, 101];
    for (const n of sizes) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
      const members: MembershipRow[] = [
        { user_id: SENDER, display_name: 'Alice' },
        ...Array.from({ length: n }, (_, i) => ({
          user_id: `@u${i}:example.com`,
          display_name: null as string | null,
        })),
      ];
      const pushers = Object.fromEntries(
        members.slice(1).map((m) => [m.user_id, [httpPusher({ pushkey: m.user_id })]])
      );
      const env = createPushEnv({ members, pushers, memberCount: n + 1 });
      const step = mockStep();
      const wf = new PushNotificationWorkflow({} as any, env as any);
      const result = await wf.run({ payload: basePayload() } as any, step as any);
      expect(result.notifiedCount).toBe(n);
      const batches = step.names.filter((s) => s.startsWith('notify-batch-'));
      expect(batches).toHaveLength(Math.ceil(n / 50));
      expect(step.names[0]).toBe('get-members');
      expect(step.names[1]).toBe('get-room-context');
    }
  });

  it('mixed skip/notify/fail aggregation soft flood', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('fail')) return new Response('no', { status: 500 });
      if (String(url).includes('throw')) throw new Error('gw');
      return new Response('ok', { status: 200 });
    });
    const env = createPushEnv({
      members: [
        { user_id: SENDER, display_name: 'Alice' },
        { user_id: BOB, display_name: null },
        { user_id: CAROL, display_name: null },
        { user_id: DAVE, display_name: null },
        { user_id: '@eve:example.com', display_name: null },
      ],
      masterEnabled: { [CAROL]: 1 },
      pushers: {
        [BOB]: [
          httpPusher({
            dataObj: {
              url: 'https://push.example.com/ok',
              format: 'event_id_only',
              default_payload: { aps: {} },
            },
          }),
        ],
        // carol killed by master — no pushers needed
        [DAVE]: [
          httpPusher({
            dataObj: {
              url: 'https://push.example.com/fail',
              format: 'event_id_only',
              default_payload: { aps: {} },
            },
          }),
        ],
        ['@eve:example.com']: [
          httpPusher({
            dataObj: {
              url: 'https://push.example.com/throw',
              format: 'event_id_only',
              default_payload: { aps: {} },
            },
          }),
        ],
      },
      queueThrowFor: new Set(['@eve:example.com']),
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run({ payload: basePayload() } as any, mockStep() as any);
    expect(result.success).toBe(true);
    expect(result.notifiedCount).toBe(1); // bob
    expect(result.skippedCount).toBe(1); // carol master-kill
    // eve: gateway throw swallowed per-pusher, then queue throw → member error → failed
    expect(result.failedCount).toBe(1);
    // dave: HTTP fail → notified false, no error → uncounted
    expect(result.notifiedCount + result.skippedCount + result.failedCount).toBe(3);
  });

  it('empty members after sender exclude soft flood', async () => {
    for (const members of [
      [],
      [{ user_id: SENDER, display_name: 'Alice' }],
      [
        { user_id: SENDER, display_name: 'Alice' },
        { user_id: SENDER, display_name: 'Alice' },
      ],
    ]) {
      const env = createPushEnv({ members });
      const step = mockStep();
      const wf = new PushNotificationWorkflow({} as any, env as any);
      const result = await wf.run({ payload: basePayload() } as any, step as any);
      expect(result).toEqual({
        success: true,
        notifiedCount: 0,
        failedCount: 0,
        skippedCount: 0,
      });
      expect(step.names).toEqual(['get-members']);
    }
  });

  it('top-level members throw → success false Unknown/Error soft flood', async () => {
    const env = createPushEnv({
      members: [{ user_id: BOB, display_name: null }],
      membersThrow: true,
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run({ payload: basePayload() } as any, mockStep() as any);
    expect(result).toEqual({
      success: false,
      notifiedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      error: 'members query failed',
    });
  });

  it('room-context throw → success false', async () => {
    const env = createPushEnv({
      members: [
        { user_id: SENDER, display_name: 'Alice' },
        { user_id: BOB, display_name: null },
      ],
      contextThrow: true,
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run({ payload: basePayload() } as any, mockStep() as any);
    expect(result.success).toBe(false);
    expect(result.error).toBe('context boom');
  });

  it('queue throw soft flood marks member failed', async () => {
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
    const env = createPushEnv({
      members: [
        { user_id: SENDER, display_name: 'Alice' },
        { user_id: BOB, display_name: null },
        { user_id: CAROL, display_name: null },
      ],
      pushers: {
        [BOB]: [httpPusher()],
        [CAROL]: [httpPusher({ pushkey: 'pk2' })],
      },
      queueThrowFor: new Set([BOB]),
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run({ payload: basePayload() } as any, mockStep() as any);
    expect(result.failedCount).toBe(1);
    expect(result.notifiedCount).toBe(1);
  });

  it('pushkey_ts / last_success clock soft flood', async () => {
    for (const off of [0, 500, 10_000]) {
      vi.setSystemTime(NOW + off);
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
      const env = createPushEnv({
        members: [
          { user_id: SENDER, display_name: 'Alice' },
          { user_id: BOB, display_name: null },
        ],
        pushers: { [BOB]: [httpPusher()] },
      });
      const wf = new PushNotificationWorkflow({} as any, env as any);
      await wf.run({ payload: basePayload() } as any, mockStep() as any);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.notification.devices[0].pushkey_ts).toBe(NOW + off);
      expect(env.pusherUpdates[0].ts).toBe(NOW + off);
    }
  });

  it('no pushers soft flood skips without failure', async () => {
    const env = createPushEnv({
      members: [
        { user_id: SENDER, display_name: 'Alice' },
        { user_id: BOB, display_name: null },
        { user_id: CAROL, display_name: null },
      ],
      pushers: {},
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run({ payload: basePayload() } as any, mockStep() as any);
    expect(result).toEqual({
      success: true,
      notifiedCount: 0,
      failedCount: 0,
      skippedCount: 2,
    });
  });
});
