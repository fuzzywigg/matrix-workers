import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  queueNotification,
  sendPushNotification,
  notifyRoomMembersOfMessage,
} from '../src/api/push';

const NOW = 1_700_000_000_000;

type PusherRow = { pushkey: string; kind: string; app_id: string; data: string };
type Queued = {
  user_id: string;
  room_id: string;
  event_id: string;
  notification_type: string;
  actions: string;
};
type Update = { kind: 'success' | 'failure'; ts: number; user_id: string; pushkey: string; app_id: string };

function createDb(opts: {
  pushers?: Record<string, PusherRow[]>;
  members?: string[];
  memberCount?: number;
  senderDisplayName?: string | null;
  roomNameContent?: string | null;
  pushRules?: Array<{
    kind: string;
    rule_id: string;
    conditions: string | null;
    actions: string;
    enabled: number;
  }>;
  unreadCount?: number | null;
  queueThrow?: boolean;
}) {
  const queued: Queued[] = [];
  const updates: Update[] = [];

  const db = {
    queued,
    updates,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async all<T>() {
              if (sql.includes('FROM pushers WHERE user_id')) {
                const userId = args[0] as string;
                return { results: (opts.pushers?.[userId] ?? []) as T[] };
              }
              if (sql.includes('FROM room_memberships') && sql.includes('user_id !=')) {
                return {
                  results: (opts.members ?? [])
                    .filter((u) => u !== args[1])
                    .map((user_id) => ({ user_id })) as T[],
                };
              }
              if (sql.includes('FROM push_rules')) {
                return { results: (opts.pushRules ?? []) as T[] };
              }
              return { results: [] };
            },
            async first<T>() {
              if (sql.includes('COUNT(*)') && sql.includes('FROM room_memberships')) {
                return { count: opts.memberCount ?? (opts.members?.length ?? 0) + 1 } as T;
              }
              if (sql.includes('SELECT display_name FROM room_memberships')) {
                return { display_name: opts.senderDisplayName ?? null } as T;
              }
              if (sql.includes("event_type = 'm.room.name'")) {
                if (opts.roomNameContent == null) return null;
                return { content: opts.roomNameContent } as T;
              }
              if (sql.includes('COUNT(*)') && sql.includes('FROM events e')) {
                if (opts.unreadCount === null) return null;
                return { count: opts.unreadCount ?? 2 } as T;
              }
              return null;
            },
            async run() {
              if (sql.includes('INSERT INTO notification_queue')) {
                if (opts.queueThrow) throw new Error('queue fail');
                queued.push({
                  user_id: args[0] as string,
                  room_id: args[1] as string,
                  event_id: args[2] as string,
                  notification_type: args[3] as string,
                  actions: args[4] as string,
                });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE pushers SET last_success')) {
                updates.push({
                  kind: 'success',
                  ts: args[0] as number,
                  user_id: args[1] as string,
                  pushkey: args[2] as string,
                  app_id: args[3] as string,
                });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE pushers SET last_failure')) {
                updates.push({
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
  };

  return db as unknown as D1Database & { queued: Queued[]; updates: Update[] };
}

function httpPusher(data: Record<string, unknown> = {}): PusherRow {
  return {
    pushkey: 'pk',
    kind: 'http',
    app_id: 'io.element.elementx.ios',
    data: JSON.stringify({
      url: 'https://push.example/gateway',
      format: 'event_id_only',
      default_payload: { aps: { sound: 'default' } },
      ...data,
    }),
  };
}

function baseEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: '$e:example.com',
    room_id: '!r:example.com',
    type: 'm.room.message',
    sender: '@alice:example.com',
    content: { body: 'hi', msgtype: 'm.text' },
    origin_server_ts: NOW - 10,
    ...overrides,
  };
}

describe('push.ts delivery/queue clock paths after #65', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ rejected: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('queueNotification', () => {
    it('INSERT binds user/room/event/type and JSON-stringifies actions', async () => {
      const db = createDb({});
      await queueNotification(
        db,
        '@bob:example.com',
        '!r:example.com',
        '$e:example.com',
        'highlight',
        ['notify', { set_tweak: 'highlight' }]
      );
      expect(db.queued).toEqual([
        {
          user_id: '@bob:example.com',
          room_id: '!r:example.com',
          event_id: '$e:example.com',
          notification_type: 'highlight',
          actions: JSON.stringify(['notify', { set_tweak: 'highlight' }]),
        },
      ]);
    });
  });

  describe('sendPushNotification', () => {
    it('returns early when no pushers', async () => {
      const db = createDb({ pushers: {} });
      await sendPushNotification(db, '@bob:example.com', baseEvent(), { unread: 1 });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(db.updates).toEqual([]);
    });

    it('skips non-http, bad JSON, and missing url pushers', async () => {
      const db = createDb({
        pushers: {
          '@bob:example.com': [
            { pushkey: 'e', kind: 'email', app_id: 'mail', data: '{}' },
            { pushkey: 'b', kind: 'http', app_id: 'app', data: '{bad' },
            {
              pushkey: 'n',
              kind: 'http',
              app_id: 'app',
              data: JSON.stringify({ format: 'full', default_payload: {} }),
            },
          ],
        },
      });
      await sendPushNotification(db, '@bob:example.com', baseEvent(), { unread: 1 });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('localpart fallback for sender_display_name; room defaults to Chat; pins pushkey_ts', async () => {
      const db = createDb({
        pushers: { '@bob:example.com': [httpPusher()] },
      });
      await sendPushNotification(
        db,
        '@bob:example.com',
        baseEvent({ sender: '@alice:example.com' }),
        { unread: 4 }
      );
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.notification.sender_display_name).toBe('alice');
      expect(body.notification.room_name).toBe('Chat');
      expect(body.notification.devices[0].pushkey_ts).toBe(NOW);
      expect(body.notification.content).toBeUndefined();
      expect(body.notification.counts).toEqual({ unread: 4 });
    });

    it('includes content when format !== event_id_only', async () => {
      const db = createDb({
        pushers: {
          '@bob:example.com': [httpPusher({ format: 'full' })],
        },
      });
      await sendPushNotification(
        db,
        '@bob:example.com',
        baseEvent({ content: { body: 'x' } }),
        { unread: 1 }
      );
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.notification.content).toEqual({ body: 'x' });
    });

    it('APNs encrypted vs plaintext vs missing body', async () => {
      const db = createDb({
        pushers: {
          '@bob:example.com': [httpPusher()],
        },
      });
      await sendPushNotification(
        db,
        '@bob:example.com',
        baseEvent({
          type: 'm.room.encrypted',
          content: {},
          sender_display_name: 'Alice',
          room_name: 'Room',
        }),
        { unread: 1 }
      );
      let device = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
        .notification.devices[0].data.default_payload;
      expect(device.aps.alert).toEqual({ title: 'Alice', body: 'Room' });

      fetchMock.mockClear();
      await sendPushNotification(
        db,
        '@bob:example.com',
        baseEvent({
          content: { body: 'hello' },
          sender_display_name: 'Alice',
          room_name: 'Room',
        }),
        { unread: 1 }
      );
      device = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
        .notification.devices[0].data.default_payload;
      expect(device.aps.alert).toEqual({
        title: 'Alice',
        subtitle: 'Room',
        body: 'hello',
      });

      fetchMock.mockClear();
      await sendPushNotification(
        db,
        '@bob:example.com',
        baseEvent({ content: {}, sender_display_name: 'Alice', room_name: 'Room' }),
        { unread: 1 }
      );
      device = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
        .notification.devices[0].data.default_payload;
      expect(device.aps.alert.body).toBe('New message');
    });

    it('gateway ok with non-JSON body still records last_success=NOW', async () => {
      fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));
      const db = createDb({
        pushers: { '@bob:example.com': [httpPusher()] },
      });
      await sendPushNotification(db, '@bob:example.com', baseEvent(), { unread: 1 });
      expect(db.updates).toEqual([
        {
          kind: 'success',
          ts: NOW,
          user_id: '@bob:example.com',
          pushkey: 'pk',
          app_id: 'io.element.elementx.ios',
        },
      ]);
    });

    it('gateway !ok pins last_failure=NOW; fetch throw also pins failure', async () => {
      fetchMock.mockResolvedValueOnce(new Response('bad', { status: 500 }));
      const db = createDb({
        pushers: { '@bob:example.com': [httpPusher()] },
      });
      await sendPushNotification(db, '@bob:example.com', baseEvent(), { unread: 1 });
      expect(db.updates[0]).toMatchObject({ kind: 'failure', ts: NOW });

      fetchMock.mockRejectedValueOnce(new Error('net'));
      const db2 = createDb({
        pushers: { '@bob:example.com': [httpPusher()] },
      });
      await sendPushNotification(db2, '@bob:example.com', baseEvent(), { unread: 1 });
      expect(db2.updates[0]).toMatchObject({ kind: 'failure', ts: NOW });
    });

    it('recomputes pushkey_ts after clock advance', async () => {
      vi.setSystemTime(NOW + 5_000);
      const db = createDb({
        pushers: { '@bob:example.com': [httpPusher()] },
      });
      await sendPushNotification(db, '@bob:example.com', baseEvent(), { unread: 1 });
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.notification.devices[0].pushkey_ts).toBe(NOW + 5_000);
      expect(db.updates[0].ts).toBe(NOW + 5_000);
    });

    it('direct APNs success skips Sygnal and pins last_success', async () => {
      const apnsCalls: unknown[] = [];
      const env = {
        APNS_KEY_ID: 'kid',
        APNS_TEAM_ID: 'team',
        APNS_PRIVATE_KEY: 'key',
        PUSH: {
          idFromName(name: string) {
            return { name };
          },
          get() {
            return {
              async fetch(req: Request) {
                apnsCalls.push(await req.json());
                return Response.json({ success: true, apnsId: 'apns-1' });
              },
            };
          },
        },
      };
      const db = createDb({
        pushers: { '@bob:example.com': [httpPusher()] },
      });
      await sendPushNotification(
        db,
        '@bob:example.com',
        baseEvent({
          sender_display_name: 'Alice',
          room_name: 'General',
          content: { body: 'yo' },
        }),
        { unread: 3 },
        env as any
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(apnsCalls).toHaveLength(1);
      expect(apnsCalls[0]).toMatchObject({
        pushkey: 'pk',
        topic: 'io.element.elementx',
        priority: 10,
        payload: {
          aps: {
            'mutable-content': 1,
            sound: 'default',
            badge: 3,
            alert: { title: 'Alice', subtitle: 'General', body: 'yo' },
          },
          room_id: '!r:example.com',
          event_id: '$e:example.com',
          sender: '@alice:example.com',
          unread_count: 3,
        },
      });
      expect(db.updates[0].kind).toBe('success');
    });

    it('direct APNs encrypted alert + unread 0 omits badge; failure falls through to Sygnal', async () => {
      const envFail = {
        APNS_KEY_ID: 'kid',
        APNS_TEAM_ID: 'team',
        APNS_PRIVATE_KEY: 'key',
        PUSH: {
          idFromName() {
            return { name: 'apns' };
          },
          get() {
            return {
              async fetch() {
                return Response.json({ success: false, error: 'bad token' });
              },
            };
          },
        },
      };
      const db = createDb({
        pushers: { '@bob:example.com': [httpPusher()] },
      });
      await sendPushNotification(
        db,
        '@bob:example.com',
        baseEvent({ type: 'm.room.encrypted', content: {}, room_name: 'DM' }),
        { unread: 0 },
        envFail as any
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(db.updates[0].kind).toBe('success'); // Sygnal ok

      // APNs throw → fallthrough
      fetchMock.mockClear();
      const envThrow = {
        APNS_KEY_ID: 'kid',
        APNS_TEAM_ID: 'team',
        APNS_PRIVATE_KEY: 'key',
        PUSH: {
          idFromName() {
            return { name: 'apns' };
          },
          get() {
            return {
              async fetch() {
                throw new Error('do down');
              },
            };
          },
        },
      };
      const db2 = createDb({
        pushers: { '@bob:example.com': [httpPusher()] },
      });
      await sendPushNotification(
        db2,
        '@bob:example.com',
        baseEvent({ type: 'm.room.encrypted', content: {}, sender_display_name: 'A', room_name: 'R' }),
        { unread: 0 },
        envThrow as any
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('direct APNs success with encrypted + badge; topic strips trailing .dev/.prod/.ios once each', async () => {
      let payload: any;
      const env = {
        APNS_KEY_ID: 'kid',
        APNS_TEAM_ID: 'team',
        APNS_PRIVATE_KEY: 'key',
        PUSH: {
          idFromName() {
            return { name: 'apns' };
          },
          get() {
            return {
              async fetch(req: Request) {
                payload = await req.json();
                return Response.json({ success: true });
              },
            };
          },
        },
      };
      // app_id ends with .ios.dev → only .dev stripped (chain is single-pass)
      const dbDev = createDb({
        pushers: {
          '@bob:example.com': [
            {
              pushkey: 'pk',
              kind: 'http',
              app_id: 'io.element.elementx.ios.dev',
              data: JSON.stringify({
                url: 'https://x',
                format: 'event_id_only',
                default_payload: { aps: {} },
              }),
            },
          ],
        },
      });
      await sendPushNotification(
        dbDev,
        '@bob:example.com',
        baseEvent({
          type: 'm.room.encrypted',
          content: {},
          sender_display_name: 'Alice',
          room_name: 'Secret',
        }),
        { unread: 2 },
        env as any
      );
      expect(payload.topic).toBe('io.element.elementx.ios');
      expect(payload.payload.aps.alert).toEqual({ title: 'Alice', body: 'Secret' });
      expect(payload.payload.aps.badge).toBe(2);
      expect(fetchMock).not.toHaveBeenCalled();

      // trailing .ios alone strips to base
      payload = undefined;
      const dbIos = createDb({
        pushers: {
          '@bob:example.com': [
            {
              pushkey: 'pk',
              kind: 'http',
              app_id: 'io.element.elementx.ios',
              data: JSON.stringify({
                url: 'https://x',
                format: 'event_id_only',
                default_payload: { aps: {} },
              }),
            },
          ],
        },
      });
      await sendPushNotification(
        dbIos,
        '@bob:example.com',
        baseEvent({
          type: 'm.room.encrypted',
          content: {},
          sender_display_name: 'Alice',
          room_name: 'Secret',
        }),
        { unread: 2 },
        env as any
      );
      expect(payload.topic).toBe('io.element.elementx');
    });

    it('non-iOS pusher with APNs env still uses Sygnal (no default_payload.aps)', async () => {
      const env = {
        APNS_KEY_ID: 'kid',
        APNS_TEAM_ID: 'team',
        APNS_PRIVATE_KEY: 'key',
        PUSH: {
          idFromName() {
            return { name: 'apns' };
          },
          get() {
            throw new Error('should not call');
          },
        },
      };
      const db = createDb({
        pushers: {
          '@bob:example.com': [
            {
              pushkey: 'pk',
              kind: 'http',
              app_id: 'android.app',
              data: JSON.stringify({
                url: 'https://push.example/gateway',
                format: 'full',
                default_payload: {},
              }),
            },
          ],
        },
      });
      await sendPushNotification(db, '@bob:example.com', baseEvent(), { unread: 1 }, env as any);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('notifyRoomMembersOfMessage', () => {
    it('DM naming when memberCount===2; queues notify; sends push', async () => {
      const db = createDb({
        members: ['@alice:example.com', '@bob:example.com'],
        memberCount: 2,
        senderDisplayName: null,
        roomNameContent: null,
        pushers: { '@bob:example.com': [httpPusher()] },
        unreadCount: 5,
      });
      const env = {} as any;
      await notifyRoomMembersOfMessage(db, env, baseEvent());
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.notification.sender_display_name).toBe('alice');
      expect(body.notification.room_name).toBe('alice');
      expect(body.notification.counts.unread).toBe(5);
      expect(db.queued[0]).toMatchObject({
        user_id: '@bob:example.com',
        notification_type: 'notify',
      });
    });

    it('invalid room-name JSON ignored; named room used when present', async () => {
      const db = createDb({
        members: ['@bob:example.com'],
        memberCount: 3,
        senderDisplayName: 'Alice',
        roomNameContent: '{bad',
        pushers: { '@bob:example.com': [httpPusher()] },
      });
      await notifyRoomMembersOfMessage(db, {} as any, baseEvent());
      let body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.notification.room_name).toBe('Chat');

      fetchMock.mockClear();
      const db2 = createDb({
        members: ['@bob:example.com'],
        memberCount: 3,
        senderDisplayName: 'Alice',
        roomNameContent: JSON.stringify({ name: 'Lounge' }),
        pushers: { '@bob:example.com': [httpPusher()] },
      });
      await notifyRoomMembersOfMessage(db2, {} as any, baseEvent());
      body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.notification.room_name).toBe('Lounge');
    });

    it('dont_notify override skips push and queue for that member', async () => {
      const db = createDb({
        members: ['@bob:example.com'],
        memberCount: 2,
        pushRules: [
          {
            kind: 'override',
            rule_id: '.m.rule.master',
            conditions: null,
            actions: JSON.stringify(['dont_notify']),
            enabled: 1,
          },
        ],
        pushers: { '@bob:example.com': [httpPusher()] },
      });
      await notifyRoomMembersOfMessage(db, {} as any, baseEvent());
      expect(fetchMock).not.toHaveBeenCalled();
      expect(db.queued).toEqual([]);
    });

    it('highlight rule queues notification_type=highlight', async () => {
      const db = createDb({
        members: ['@bob:example.com'],
        memberCount: 2,
        pushRules: [
          {
            kind: 'override',
            rule_id: 'custom.highlight',
            conditions: JSON.stringify([{ kind: 'event_match', key: 'type', pattern: 'm.room.message' }]),
            actions: JSON.stringify(['notify', { set_tweak: 'highlight', value: true }]),
            enabled: 1,
          },
        ],
        pushers: { '@bob:example.com': [httpPusher()] },
      });
      await notifyRoomMembersOfMessage(db, {} as any, baseEvent());
      expect(db.queued[0].notification_type).toBe('highlight');
    });

    it('null unread count falls back to 1; per-member errors are isolated', async () => {
      const db = createDb({
        members: ['@ok:example.com', '@fail:example.com'],
        memberCount: 3,
        pushers: {
          '@ok:example.com': [httpPusher({ url: 'https://ok.example' })],
        },
        unreadCount: null,
      });
      const orig = db.prepare.bind(db);
      (db as any).prepare = (sql: string) => {
        const stmt = orig(sql);
        if (sql.includes('FROM pushers')) {
          return {
            bind(userId: string) {
              if (userId === '@fail:example.com') {
                throw new Error('pusher lookup fail');
              }
              return stmt.bind(userId);
            },
          };
        }
        return stmt;
      };

      await notifyRoomMembersOfMessage(db, {} as any, baseEvent());
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.notification.counts.unread).toBe(1);
      expect(db.queued.some((q) => q.user_id === '@ok:example.com')).toBe(true);
      expect(db.queued.some((q) => q.user_id === '@fail:example.com')).toBe(false);
    });

    it('no members → no fetch', async () => {
      const db = createDb({ members: [], memberCount: 1 });
      await notifyRoomMembersOfMessage(db, {} as any, baseEvent());
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
