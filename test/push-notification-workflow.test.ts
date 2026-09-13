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

type MembershipRow = { user_id: string; membership: string; display_name: string | null };
type PusherRow = { user_id: string; pushkey: string; kind: string; app_id: string; data: string };
type PushRuleRow = { user_id: string; rule_id: string; enabled: number };

type SqlLog = { sql: string; args: unknown[] };

function createPushEnv(opts: {
  members?: MembershipRow[];
  pushers?: PusherRow[];
  pushRules?: PushRuleRow[];
  roomNameContent?: string | null;
  unreadCount?: number | null;
  throwOnSql?: (sql: string) => Error | null;
}) {
  const members = opts.members ?? [];
  const pushers = [...(opts.pushers ?? [])];
  const pushRules = opts.pushRules ?? [];
  const sqlLog: SqlLog[] = [];
  const updates: SqlLog[] = [];
  const queueInserts: unknown[][] = [];

  const env = {
    sqlLog,
    updates,
    queueInserts,
    pushers,
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async all<T>() {
                sqlLog.push({ sql, args });
                const err = opts.throwOnSql?.(sql);
                if (err) throw err;

                if (sql.includes('FROM room_memberships') && sql.includes("membership = 'join'") && sql.includes('user_id !=')) {
                  const roomId = args[0] as string;
                  const sender = args[1] as string;
                  return {
                    results: members
                      .filter((m) => m.membership === 'join' && m.user_id !== sender)
                      .map((m) => ({ user_id: m.user_id })) as T[],
                  };
                }

                if (sql.includes('FROM pushers WHERE user_id')) {
                  const userId = args[0] as string;
                  return {
                    results: pushers
                      .filter((p) => p.user_id === userId)
                      .map((p) => ({
                        pushkey: p.pushkey,
                        kind: p.kind,
                        app_id: p.app_id,
                        data: p.data,
                      })) as T[],
                  };
                }

                return { results: [] };
              },
              async first<T>() {
                sqlLog.push({ sql, args });
                const err = opts.throwOnSql?.(sql);
                if (err) throw err;

                if (sql.includes('COUNT(*)') && sql.includes('FROM room_memberships')) {
                  // Test fixtures are single-room; count all join rows.
                  const joinCount = members.filter((m) => m.membership === 'join').length;
                  return { count: joinCount } as T;
                }

                if (sql.includes('SELECT display_name FROM room_memberships')) {
                  const userId = args[1] as string;
                  const row = members.find((m) => m.user_id === userId);
                  return (row ? { display_name: row.display_name } : null) as T;
                }

                if (sql.includes("event_type = 'm.room.name'")) {
                  if (opts.roomNameContent === null || opts.roomNameContent === undefined) {
                    return null as T;
                  }
                  return { content: opts.roomNameContent } as T;
                }

                if (sql.includes("rule_id = '.m.rule.master'")) {
                  const userId = args[0] as string;
                  const rule = pushRules.find(
                    (r) => r.user_id === userId && r.rule_id === '.m.rule.master'
                  );
                  return (rule ? { enabled: rule.enabled } : null) as T;
                }

                if (
                  sql.includes('COUNT(*)') &&
                  sql.includes('FROM events e') &&
                  sql.includes('m.fully_read')
                ) {
                  if (opts.unreadCount === null) return null as T;
                  return { count: opts.unreadCount ?? 3 } as T;
                }

                return null as T;
              },
              async run() {
                sqlLog.push({ sql, args });
                const err = opts.throwOnSql?.(sql);
                if (err) throw err;

                if (sql.includes('UPDATE pushers SET last_success')) {
                  updates.push({ sql: 'success', args });
                  return { meta: { changes: 1 } };
                }
                if (sql.includes('UPDATE pushers SET last_failure')) {
                  updates.push({ sql: 'failure', args });
                  return { meta: { changes: 1 } };
                }
                if (sql.includes('INSERT INTO notification_queue')) {
                  queueInserts.push(args);
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

  return env;
}

/** Supports both step.do(name, fn) and step.do(name, opts, fn). */
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

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    eventId: '$evt1:example.com',
    roomId: '!room:example.com',
    eventType: 'm.room.message',
    sender: '@alice:example.com',
    content: { body: 'hello', msgtype: 'm.text' },
    originServerTs: NOW - 1000,
    ...overrides,
  };
}

function httpPusher(
  userId: string,
  data: Record<string, unknown>,
  extras: Partial<PusherRow> = {}
): PusherRow {
  return {
    user_id: userId,
    pushkey: extras.pushkey ?? 'pk1',
    kind: extras.kind ?? 'http',
    app_id: extras.app_id ?? 'im.element.app',
    data: typeof data === 'string' ? data : JSON.stringify(data),
  };
}

describe('PushNotificationWorkflow', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 })
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it('returns zeros when no join members besides sender', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', membership: 'join', display_name: 'Alice' },
      ],
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: basePayload() } as any,
      mockStep() as any
    );
    expect(result).toEqual({
      success: true,
      notifiedCount: 0,
      failedCount: 0,
      skippedCount: 0,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips member when master kill switch enabled', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', membership: 'join', display_name: 'Alice' },
        { user_id: '@bob:example.com', membership: 'join', display_name: 'Bob' },
      ],
      pushRules: [{ user_id: '@bob:example.com', rule_id: '.m.rule.master', enabled: 1 }],
      pushers: [
        httpPusher('@bob:example.com', { url: 'https://push.example/g' }),
      ],
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: basePayload() } as any,
      mockStep() as any
    );
    expect(result).toEqual({
      success: true,
      notifiedCount: 0,
      failedCount: 0,
      skippedCount: 1,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips non-message/encrypted event types (m.room.member)', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', membership: 'join', display_name: 'Alice' },
        { user_id: '@bob:example.com', membership: 'join', display_name: 'Bob' },
      ],
      pushers: [
        httpPusher('@bob:example.com', { url: 'https://push.example/g' }),
      ],
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: basePayload({ eventType: 'm.room.member' }) } as any,
      mockStep() as any
    );
    expect(result.skippedCount).toBe(1);
    expect(result.notifiedCount).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips when notify rules match but user has no pushers', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', membership: 'join', display_name: 'Alice' },
        { user_id: '@bob:example.com', membership: 'join', display_name: 'Bob' },
      ],
      pushers: [],
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: basePayload() } as any,
      mockStep() as any
    );
    expect(result).toEqual({
      success: true,
      notifiedCount: 0,
      failedCount: 0,
      skippedCount: 1,
    });
  });

  it('notifies on HTTP 200: success UPDATE, queue INSERT, notifiedCount=1', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', membership: 'join', display_name: 'Alice' },
        { user_id: '@bob:example.com', membership: 'join', display_name: 'Bob' },
      ],
      roomNameContent: JSON.stringify({ name: 'General' }),
      unreadCount: 5,
      pushers: [
        httpPusher('@bob:example.com', {
          url: 'https://push.example/gateway',
          format: 'event_id_only',
          default_payload: { aps: { sound: 'default' } },
        }),
      ],
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: basePayload() } as any,
      mockStep() as any
    );
    expect(result).toEqual({
      success: true,
      notifiedCount: 1,
      failedCount: 0,
      skippedCount: 0,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://push.example/gateway');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string);
    // event_id_only omits content
    expect(body.notification.content).toBeUndefined();
    expect(body.notification.event_id).toBe('$evt1:example.com');
    expect(body.notification.counts.unread).toBe(5);
    expect(body.notification.devices[0].pushkey_ts).toBe(NOW);
    expect(body.notification.devices[0].data.default_payload.aps.alert).toEqual({
      title: 'Alice',
      subtitle: 'General',
      body: 'hello',
    });
    expect(env.updates.some((u) => u.sql === 'success')).toBe(true);
    expect(env.queueInserts).toHaveLength(1);
    expect(env.queueInserts[0][3]).toBe('notify');
    expect(env.queueInserts[0][4]).toBe(JSON.stringify(['notify']));
  });

  it('builds encrypted APNs alert without subtitle; includes content when format != event_id_only', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', membership: 'join', display_name: null },
        { user_id: '@bob:example.com', membership: 'join', display_name: 'Bob' },
      ],
      roomNameContent: JSON.stringify({ name: 'Secret' }),
      pushers: [
        httpPusher('@bob:example.com', {
          url: 'https://push.example/g',
          format: 'full',
          default_payload: { aps: {} },
        }),
      ],
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    await wf.run(
      {
        payload: basePayload({
          eventType: 'm.room.encrypted',
          content: { ciphertext: 'x' },
        }),
      } as any,
      mockStep() as any
    );
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.notification.content).toEqual({ ciphertext: 'x' });
    expect(body.notification.devices[0].data.default_payload.aps.alert).toEqual({
      title: 'alice', // derived from MXID when display_name null
      body: 'Secret',
    });
    expect(body.notification.devices[0].data.default_payload.aps.alert.subtitle).toBeUndefined();
    expect(body.notification.devices[0].data.default_payload.aps['mutable-content']).toBe(1);
  });

  it('uses DM fallback room name when memberCount===2 and name JSON invalid', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', membership: 'join', display_name: 'Alice D' },
        { user_id: '@bob:example.com', membership: 'join', display_name: 'Bob' },
      ],
      roomNameContent: 'not-json{{{',
      pushers: [
        httpPusher('@bob:example.com', {
          url: 'https://push.example/g',
          default_payload: { aps: {} },
        }),
      ],
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    await wf.run({ payload: basePayload() } as any, mockStep() as any);
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.notification.room_name).toBe('Alice D');
    expect(body.notification.devices[0].data.default_payload.aps.alert.subtitle).toBe('Alice D');
  });

  it('defaults message body to "New message" and room to "Chat" when absent', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', membership: 'join', display_name: 'A' },
        { user_id: '@bob:example.com', membership: 'join', display_name: 'B' },
        { user_id: '@carol:example.com', membership: 'join', display_name: 'C' },
      ],
      roomNameContent: null,
      pushers: [
        httpPusher('@bob:example.com', {
          url: 'https://push.example/g',
          default_payload: { aps: {} },
        }),
      ],
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    // Only bob has pushers; carol will be skipped (no pushers)
    await wf.run(
      { payload: basePayload({ content: { msgtype: 'm.text' } }) } as any,
      mockStep() as any
    );
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.notification.room_name).toBe('Chat');
    expect(body.notification.devices[0].data.default_payload.aps.alert.body).toBe('New message');
  });

  it('treats non-http kind / bad data / missing url as failed delivery (not skipped)', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', membership: 'join', display_name: 'A' },
        { user_id: '@bob:example.com', membership: 'join', display_name: 'B' },
        { user_id: '@carol:example.com', membership: 'join', display_name: 'C' },
        { user_id: '@dave:example.com', membership: 'join', display_name: 'D' },
      ],
      pushers: [
        httpPusher('@bob:example.com', { url: 'https://x' }, { kind: 'email' }),
        { user_id: '@carol:example.com', pushkey: 'p', kind: 'http', app_id: 'a', data: 'not-json' },
        httpPusher('@dave:example.com', { format: 'full' }), // no url
      ],
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run({ payload: basePayload() } as any, mockStep() as any);
    // each member: pushers exist but all fail → notified:false, skipped:false, no error
    // Aggregation only increments failedCount when result.error is set —
    // so notified=0, skipped=0, failed=0 for these (edge of current aggregation).
    expect(result.success).toBe(true);
    expect(result.notifiedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    // queue still written for each non-skipped member
    expect(env.queueInserts).toHaveLength(3);
  });

  it('gateway non-OK updates failure_count and yields notified:false', async () => {
    fetchSpy.mockResolvedValue(new Response('fail', { status: 500 }));
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', membership: 'join', display_name: 'A' },
        { user_id: '@bob:example.com', membership: 'join', display_name: 'B' },
      ],
      pushers: [httpPusher('@bob:example.com', { url: 'https://push.example/g' })],
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run({ payload: basePayload() } as any, mockStep() as any);
    expect(result.notifiedCount).toBe(0);
    expect(env.updates.some((u) => u.sql === 'failure')).toBe(true);
    expect(env.queueInserts).toHaveLength(1);
  });

  it('fetch throw updates failure then is swallowed per-pusher; member not notified', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', membership: 'join', display_name: 'A' },
        { user_id: '@bob:example.com', membership: 'join', display_name: 'B' },
      ],
      pushers: [httpPusher('@bob:example.com', { url: 'https://push.example/g' })],
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run({ payload: basePayload() } as any, mockStep() as any);
    expect(result.success).toBe(true);
    expect(result.notifiedCount).toBe(0);
    expect(env.updates.some((u) => u.sql === 'failure')).toBe(true);
  });

  it('member-level DB throw on push rules yields failedCount with error', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', membership: 'join', display_name: 'A' },
        { user_id: '@bob:example.com', membership: 'join', display_name: 'B' },
      ],
      throwOnSql: (sql) =>
        sql.includes('FROM push_rules') ? new Error('db blow up') : null,
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run({ payload: basePayload() } as any, mockStep() as any);
    expect(result).toEqual({
      success: true,
      notifiedCount: 0,
      failedCount: 1,
      skippedCount: 0,
    });
  });

  it('outer step failure returns success:false with error message', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', membership: 'join', display_name: 'A' },
        { user_id: '@bob:example.com', membership: 'join', display_name: 'B' },
      ],
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: basePayload() } as any,
      mockStep({ throwOnStep: 'get-members' }) as any
    );
    expect(result).toEqual({
      success: false,
      notifiedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      error: 'step failed: get-members',
    });
  });

  it('aggregates mixed skip + notify across two members', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', membership: 'join', display_name: 'A' },
        { user_id: '@bob:example.com', membership: 'join', display_name: 'B' },
        { user_id: '@carol:example.com', membership: 'join', display_name: 'C' },
      ],
      pushRules: [{ user_id: '@bob:example.com', rule_id: '.m.rule.master', enabled: 1 }],
      pushers: [httpPusher('@carol:example.com', { url: 'https://push.example/g' })],
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run({ payload: basePayload() } as any, mockStep() as any);
    expect(result).toEqual({
      success: true,
      notifiedCount: 1,
      failedCount: 0,
      skippedCount: 1,
    });
  });

  it('splits >50 members into notify-batch-0 and notify-batch-50', async () => {
    const recipients = Array.from({ length: 51 }, (_, i) => ({
      user_id: `@u${i}:example.com`,
      membership: 'join' as const,
      display_name: `U${i}`,
    }));
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', membership: 'join', display_name: 'A' },
        ...recipients,
      ],
      // master enabled for all → all skipped, still exercises batching
      pushRules: recipients.map((r) => ({
        user_id: r.user_id,
        rule_id: '.m.rule.master',
        enabled: 1,
      })),
    });
    const names: string[] = [];
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run(
      { payload: basePayload() } as any,
      mockStep({ recordNames: names }) as any
    );
    expect(names).toContain('notify-batch-0');
    expect(names).toContain('notify-batch-50');
    expect(result.skippedCount).toBe(51);
    expect(result.success).toBe(true);
  });

  it('defaults unread count to 1 when query returns null', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', membership: 'join', display_name: 'A' },
        { user_id: '@bob:example.com', membership: 'join', display_name: 'B' },
      ],
      unreadCount: null,
      pushers: [httpPusher('@bob:example.com', { url: 'https://push.example/g' })],
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    await wf.run({ payload: basePayload() } as any, mockStep() as any);
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.notification.counts.unread).toBe(1);
  });

  it('master rule disabled (enabled=0) falls through to message notify', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', membership: 'join', display_name: 'A' },
        { user_id: '@bob:example.com', membership: 'join', display_name: 'B' },
      ],
      pushRules: [{ user_id: '@bob:example.com', rule_id: '.m.rule.master', enabled: 0 }],
      pushers: [httpPusher('@bob:example.com', { url: 'https://push.example/g' })],
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    const result = await wf.run({ payload: basePayload() } as any, mockStep() as any);
    expect(result.notifiedCount).toBe(1);
  });

  it('pins pushkey_ts and last_success to fake clock NOW', async () => {
    const env = createPushEnv({
      members: [
        { user_id: '@alice:example.com', membership: 'join', display_name: 'A' },
        { user_id: '@bob:example.com', membership: 'join', display_name: 'B' },
      ],
      pushers: [httpPusher('@bob:example.com', { url: 'https://push.example/g' })],
    });
    const wf = new PushNotificationWorkflow({} as any, env as any);
    await wf.run({ payload: basePayload() } as any, mockStep() as any);
    const successUpdate = env.updates.find((u) => u.sql === 'success');
    expect(successUpdate?.args[0]).toBe(NOW);
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.notification.devices[0].pushkey_ts).toBe(NOW);
  });
});
