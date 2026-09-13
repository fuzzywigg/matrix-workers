import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

type MembershipRow = { user_id: string; display_name: string | null };
type PusherRow = { pushkey: string; kind: string; app_id: string; data: string };
type PushRuleRow = { enabled: number };
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
  unreadCount?: number;
  queueThrowFor?: Set<string>;
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
                if (sql.includes('FROM room_memberships') && sql.includes("membership = 'join'") && sql.includes('user_id !=')) {
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
    roomId: '!room:example.com',
    eventType: 'm.room.message',
    sender: '@alice:example.com',
    content: { body: 'hello', msgtype: 'm.text' },
    originServerTs: NOW - 1000,
    ...overrides,
  };
}

function httpPusher(overrides: Partial<PusherRow> & { dataObj?: Record<string, unknown> } = {}): PusherRow {
  const { dataObj, ...rest } = overrides;
  return {
    pushkey: 'pk1',
    kind: 'http',
    app_id: 'app.ios',
    data: JSON.stringify(
      dataObj ?? {
        url: 'https://push.example/gateway',
        format: 'event_id_only',
        default_payload: { aps: { sound: 'default' } },
      }
    ),
    ...rest,
  };
}

describe('PushNotificationWorkflow clock/HTTP/edge paths after #65', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
    fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns zeros when no members remain after excluding sender', async () => {
    const env = createPushEnv({
      members: [{ user_id: '@alice:example.com', display_name: 'Alice' }],
    });
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
    expect(env.getLastMemberQuery()).toEqual({
      roomId: '!room:example.com',
      sender: '@alice:example.com',
    });
  });

  it('top-level catch maps Error.message and non-Error throws', async () => {
    const env = {
      DB: {
        prepare() {
          throw new Error('d1 down');
        },
      },
    };
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run({ payload: basePayload() } as any, mockStep() as any);
    expect(result).toEqual({
      success: false,
      notifiedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      error: 'd1 down',
    });

    const env2 = {
      DB: {
        prepare() {
          throw 'string-boom';
        },
      },
    };
    const wf2 = new PushNotificationWorkflow({} as any, env2 as any);
    const result2 = await wf2.run({ payload: basePayload() } as any, mockStep() as any);
    expect(result2.error).toBe('Unknown error');
  });

  it('getRoomContext: localpart fallback, invalid room-name JSON, DM name when memberCount===2', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', display_name: null },
        { user_id: '@bob:example.com', display_name: 'Bob' },
      ],
      memberCount: 2,
      senderDisplayName: null,
      roomNameContent: '{not-json',
      pushers: {
        '@bob:example.com': [httpPusher()],
      },
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    await wf.run({ payload: basePayload() } as any, mockStep() as any);

    expect(fetchMock).toHaveBeenCalled();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.notification.sender_display_name).toBe('alice');
    expect(body.notification.room_name).toBe('alice');
  });

  it('getRoomContext: uses parsed m.room.name and keeps named rooms with >2 members', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', display_name: 'Alice' },
        { user_id: '@bob:example.com', display_name: 'Bob' },
        { user_id: '@carol:example.com', display_name: 'Carol' },
      ],
      memberCount: 3,
      roomNameContent: JSON.stringify({ name: 'General' }),
      pushers: {
        '@bob:example.com': [httpPusher()],
        '@carol:example.com': [httpPusher({ pushkey: 'pk2' })],
      },
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run({ payload: basePayload() } as any, mockStep() as any);
    expect(result.notifiedCount).toBe(2);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.notification.room_name).toBe('General');
    expect(body.notification.sender_display_name).toBe('Alice');
  });

  it('getRoomContext: missing room name + memberCount!==2 falls back to Chat', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', display_name: 'Alice' },
        { user_id: '@bob:example.com', display_name: 'Bob' },
        { user_id: '@carol:example.com', display_name: null },
      ],
      memberCount: 3,
      roomNameContent: null,
      pushers: { '@bob:example.com': [httpPusher()] },
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    await wf.run({ payload: basePayload() } as any, mockStep() as any);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.notification.room_name).toBe('Chat');
  });

  it('master kill switch skips; non-message types skip; message/encrypted notify', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', display_name: 'A' },
        { user_id: '@muted:example.com', display_name: 'M' },
        { user_id: '@bob:example.com', display_name: 'B' },
      ],
      memberCount: 3,
      masterEnabled: { '@muted:example.com': 1 },
      pushers: {
        '@bob:example.com': [httpPusher()],
        '@muted:example.com': [httpPusher({ pushkey: 'pk-m' })],
      },
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);

    const reaction = await wf.run(
      { payload: basePayload({ eventType: 'm.reaction' }) } as any,
      mockStep() as any
    );
    expect(reaction).toMatchObject({
      success: true,
      notifiedCount: 0,
      skippedCount: 2,
      failedCount: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const msg = await wf.run({ payload: basePayload() } as any, mockStep() as any);
    expect(msg).toMatchObject({ notifiedCount: 1, skippedCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    const enc = await wf.run(
      { payload: basePayload({ eventType: 'm.room.encrypted', content: {} }) } as any,
      mockStep() as any
    );
    expect(enc.notifiedCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips members with no pushers without counting as failed', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', display_name: 'A' },
        { user_id: '@bob:example.com', display_name: 'B' },
      ],
      memberCount: 2,
      pushers: {},
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run({ payload: basePayload() } as any, mockStep() as any);
    expect(result).toEqual({
      success: true,
      notifiedCount: 0,
      failedCount: 0,
      skippedCount: 1,
    });
    expect(env.queued).toEqual([]);
  });

  it('sendToPusher gates: non-http, bad JSON, missing url → notified false after queue', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', display_name: 'A' },
        { user_id: '@bob:example.com', display_name: 'B' },
      ],
      memberCount: 2,
      pushers: {
        '@bob:example.com': [
          httpPusher({ kind: 'email', pushkey: 'e1' }),
          httpPusher({ pushkey: 'bad', data: '{nope' }),
          httpPusher({
            pushkey: 'nourl',
            dataObj: { format: 'full', default_payload: {} },
          }),
        ],
      },
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run({ payload: basePayload() } as any, mockStep() as any);
    expect(result).toEqual({
      success: true,
      notifiedCount: 0,
      failedCount: 0,
      skippedCount: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(env.queued).toHaveLength(1);
    expect(env.queued[0].notification_type).toBe('notify');
  });

  it('APNs alert: encrypted uses room as body; plaintext uses content.body; missing body → New message', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', display_name: 'Alice' },
        { user_id: '@bob:example.com', display_name: 'Bob' },
      ],
      memberCount: 2,
      roomNameContent: JSON.stringify({ name: 'DM' }),
      pushers: { '@bob:example.com': [httpPusher()] },
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);

    await wf.run(
      { payload: basePayload({ eventType: 'm.room.encrypted', content: {} }) } as any,
      mockStep() as any
    );
    let device = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
      .notification.devices[0].data.default_payload;
    expect(device.aps.alert).toEqual({ title: 'Alice', body: 'DM' });
    expect(device.aps['mutable-content']).toBe(1);

    fetchMock.mockClear();
    await wf.run({ payload: basePayload({ content: { body: 'hi' } }) } as any, mockStep() as any);
    device = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
      .notification.devices[0].data.default_payload;
    expect(device.aps.alert).toEqual({
      title: 'Alice',
      subtitle: 'DM',
      body: 'hi',
    });

    fetchMock.mockClear();
    await wf.run({ payload: basePayload({ content: {} }) } as any, mockStep() as any);
    device = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
      .notification.devices[0].data.default_payload;
    expect(device.aps.alert.body).toBe('New message');
  });

  it('event_id_only omits content; other formats include content; pins pushkey_ts to NOW', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', display_name: 'A' },
        { user_id: '@bob:example.com', display_name: 'B' },
      ],
      memberCount: 2,
      pushers: {
        '@bob:example.com': [
          httpPusher({
            dataObj: {
              url: 'https://push.example/gateway',
              format: 'event_id_only',
              default_payload: {},
            },
          }),
        ],
      },
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    await wf.run({ payload: basePayload() } as any, mockStep() as any);
    const n1 = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).notification;
    expect(n1.content).toBeUndefined();
    expect(n1.devices[0].pushkey_ts).toBe(NOW);

    fetchMock.mockClear();
    const env2 = createPushEnv({
      members: [
        { user_id: '@alice:example.com', display_name: 'A' },
        { user_id: '@bob:example.com', display_name: 'B' },
      ],
      memberCount: 2,
      pushers: {
        '@bob:example.com': [
          httpPusher({
            dataObj: {
              url: 'https://push.example/gateway',
              format: 'full',
              default_payload: {},
            },
          }),
        ],
      },
    });
    const wf2 = new PushNotificationWorkflow({} as any, env2 as any);
    await wf2.run(
      { payload: basePayload({ content: { body: 'x', msgtype: 'm.text' } }) } as any,
      mockStep() as any
    );
    const n2 = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).notification;
    expect(n2.content).toEqual({ body: 'x', msgtype: 'm.text' });
  });

  it('HTTP ok pins last_success=NOW; !ok pins last_failure=NOW; fetch throw pins failure and rethrows to member catch', async () => {
    const envOk = createPushEnv({
      members: [
        { user_id: '@alice:example.com', display_name: 'A' },
        { user_id: '@bob:example.com', display_name: 'B' },
      ],
      memberCount: 2,
      pushers: { '@bob:example.com': [httpPusher()] },
    });
    const wfOk = new PushNotificationWorkflow({} as any, envOk as any);
    const ok = await wfOk.run({ payload: basePayload() } as any, mockStep() as any);
    expect(ok.notifiedCount).toBe(1);
    expect(envOk.pusherUpdates).toEqual([
      {
        kind: 'success',
        ts: NOW,
        user_id: '@bob:example.com',
        pushkey: 'pk1',
        app_id: 'app.ios',
      },
    ]);

    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 502 }));
    const envFail = createPushEnv({
      members: [
        { user_id: '@alice:example.com', display_name: 'A' },
        { user_id: '@bob:example.com', display_name: 'B' },
      ],
      memberCount: 2,
      pushers: { '@bob:example.com': [httpPusher()] },
    });
    const wfFail = new PushNotificationWorkflow({} as any, envFail as any);
    const fail = await wfFail.run({ payload: basePayload() } as any, mockStep() as any);
    expect(fail).toEqual({
      success: true,
      notifiedCount: 0,
      failedCount: 0,
      skippedCount: 0,
    });
    expect(envFail.pusherUpdates[0]).toMatchObject({ kind: 'failure', ts: NOW });

    fetchMock.mockRejectedValueOnce(new Error('network'));
    const envThrow = createPushEnv({
      members: [
        { user_id: '@alice:example.com', display_name: 'A' },
        { user_id: '@bob:example.com', display_name: 'B' },
      ],
      memberCount: 2,
      pushers: { '@bob:example.com': [httpPusher()] },
    });
    const wfThrow = new PushNotificationWorkflow({} as any, envThrow as any);
    const thrown = await wfThrow.run({ payload: basePayload() } as any, mockStep() as any);
    // pusher catch swallows throw → anySuccess false → notified false, no error on member
    expect(thrown).toEqual({
      success: true,
      notifiedCount: 0,
      failedCount: 0,
      skippedCount: 0,
    });
    expect(envThrow.pusherUpdates[0]).toMatchObject({ kind: 'failure', ts: NOW });
    expect(envThrow.queued).toHaveLength(1);
  });

  it('recomputes pushkey_ts / last_success after mid-flight clock advance', async () => {
    vi.setSystemTime(NOW + 42_000);
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', display_name: 'A' },
        { user_id: '@bob:example.com', display_name: 'B' },
      ],
      memberCount: 2,
      pushers: { '@bob:example.com': [httpPusher()] },
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    await wf.run({ payload: basePayload() } as any, mockStep() as any);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.notification.devices[0].pushkey_ts).toBe(NOW + 42_000);
    expect(env.pusherUpdates[0].ts).toBe(NOW + 42_000);
  });

  it('aggregates skipped/notified/failed across a batch; member-level queue throw → failedCount', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', display_name: 'A' },
        { user_id: '@skip:example.com', display_name: 'S' },
        { user_id: '@ok:example.com', display_name: 'O' },
        { user_id: '@fail:example.com', display_name: 'F' },
      ],
      memberCount: 4,
      masterEnabled: { '@skip:example.com': 1 },
      pushers: {
        '@ok:example.com': [httpPusher({ pushkey: 'ok' })],
        '@fail:example.com': [httpPusher({ pushkey: 'fail' })],
      },
      queueThrowFor: new Set(['@fail:example.com']),
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run({ payload: basePayload() } as any, mockStep() as any);
    expect(result).toEqual({
      success: true,
      notifiedCount: 1,
      failedCount: 1,
      skippedCount: 1,
    });
  });

  it('batches members with notify-batch-0 then notify-batch-50 for >50 recipients', async () => {
    const members: MembershipRow[] = [{ user_id: '@alice:example.com', display_name: 'A' }];
    for (let i = 0; i < 51; i++) {
      members.push({ user_id: `@u${i}:example.com`, display_name: null });
    }
    const pushers: Record<string, PusherRow[]> = {};
    for (let i = 0; i < 51; i++) {
      pushers[`@u${i}:example.com`] = [];
    }
    const env = createPushEnv({ members, memberCount: 52, pushers });
    const step = mockStep();
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run({ payload: basePayload() } as any, step as any);
    expect(step.names).toContain('notify-batch-0');
    expect(step.names).toContain('notify-batch-50');
    expect(result.skippedCount).toBe(51);
  });

  it('queueNotification uses notify type; unread_count from getUnreadCount (null → 1)', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', display_name: 'A' },
        { user_id: '@bob:example.com', display_name: 'B' },
      ],
      memberCount: 2,
      pushers: { '@bob:example.com': [httpPusher()] },
      unreadCount: undefined,
    });
    // force first() for unread to return null via empty count override path
    const origPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      const stmt = origPrepare(sql);
      if (sql.includes('FROM events e')) {
        return {
          bind() {
            return {
              async first() {
                return null;
              },
            };
          },
        } as any;
      }
      return stmt;
    }) as any;

    const wf = new PushNotificationWorkflow({} as any, env as any);
    await wf.run({ payload: basePayload() } as any, mockStep() as any);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.notification.counts.unread).toBe(1);
    expect(env.queued[0]).toMatchObject({
      user_id: '@bob:example.com',
      room_id: '!room:example.com',
      event_id: '$evt:example.com',
      notification_type: 'notify',
      actions: JSON.stringify(['notify']),
    });
  });

  it('multi-pusher: one failure + one success → notified true; records both updates', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('bad', { status: 500 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', display_name: 'A' },
        { user_id: '@bob:example.com', display_name: 'B' },
      ],
      memberCount: 2,
      pushers: {
        '@bob:example.com': [
          httpPusher({ pushkey: 'bad', app_id: 'a1' }),
          httpPusher({ pushkey: 'good', app_id: 'a2' }),
        ],
      },
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run({ payload: basePayload() } as any, mockStep() as any);
    expect(result.notifiedCount).toBe(1);
    expect(env.pusherUpdates.map((u) => u.kind)).toEqual(['failure', 'success']);
  });

  it('pusher without default_payload / aps still sends device data fields', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', display_name: 'A' },
        { user_id: '@bob:example.com', display_name: 'B' },
      ],
      memberCount: 2,
      pushers: {
        '@bob:example.com': [
          httpPusher({
            dataObj: { url: 'https://push.example/gateway', format: 'full' },
          }),
        ],
      },
      unreadCount: 7,
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    await wf.run({ payload: basePayload() } as any, mockStep() as any);
    const device = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
      .notification.devices[0].data.default_payload;
    expect(device.event_id).toBe('$evt:example.com');
    expect(device.room_id).toBe('!room:example.com');
    expect(device.sender).toBe('@alice:example.com');
    expect(device.unread_count).toBe(7);
    expect(device.aps).toBeUndefined();
  });
});
