/**
 * TOKENMAXX HEAVY deepen after #114/#115 — different slice: sliding-sync HTTP routes.
 * Avoids rooms (#114), oidc-auth/qr-login (#115), media (#109/#113), client /sync (#117).
 * Helpers already covered in sliding-sync-helpers.test.ts — this file focuses on routes.
 * Tests-only — no product inventing.
 * Exercises MSC3575 + MSC4186/v4 endpoints: lists/ranges, room subscriptions,
 * invites, extensions (to_device/e2ee/account_data/typing/receipts/presence),
 * connection-state DO, long-poll wait, M_UNKNOWN_POS, subscription caps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICEA');
      await next();
    };
  },
}));

const countNotificationsWithRules = vi.fn(
  async (): Promise<{ notification_count: number; highlight_count: number }> => ({
    notification_count: 0,
    highlight_count: 0,
  })
);

vi.mock('../src/services/push-rule-evaluator', () => ({
  countNotificationsWithRules: (...args: unknown[]) => countNotificationsWithRules(...args),
  evaluatePushRules: vi.fn(),
}));

const getTypingForRooms = vi.fn(
  async (_env: unknown, roomIds: string[]): Promise<Record<string, string[]>> => {
    const out: Record<string, string[]> = {};
    for (const id of roomIds) out[id] = [];
    return out;
  }
);

vi.mock('../src/api/typing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/typing')>();
  return {
    ...actual,
    getTypingForRooms: (...args: unknown[]) =>
      getTypingForRooms(...(args as [unknown, string[]])),
  };
});

const getReceiptsForRooms = vi.fn(
  async (
    _env: unknown,
    roomIds: string[],
    _userId?: string
  ): Promise<Record<string, Record<string, unknown>>> => {
    const out: Record<string, Record<string, unknown>> = {};
    for (const id of roomIds) out[id] = {};
    return out;
  }
);

vi.mock('../src/api/receipts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/receipts')>();
  return {
    ...actual,
    getReceiptsForRooms: (...args: unknown[]) =>
      getReceiptsForRooms(...(args as [unknown, string[], string?])),
  };
});

const getToDeviceMessages = vi.fn(
  async (): Promise<{ events: unknown[]; nextBatch: string }> => ({
    events: [],
    nextBatch: '0',
  })
);

vi.mock('../src/api/to-device', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/to-device')>();
  return {
    ...actual,
    getToDeviceMessages: (...args: unknown[]) => getToDeviceMessages(...args),
  };
});

const getE2EEAccountDataFromDO = vi.fn(async (): Promise<Record<string, unknown>> => ({}));

vi.mock('../src/api/account-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/account-data')>();
  return {
    ...actual,
    getE2EEAccountDataFromDO: (...args: unknown[]) => getE2EEAccountDataFromDO(...args),
  };
});

import slidingSyncApp from '../src/api/sliding-sync';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const DEVICE = 'DEVICEA';
const ROOM = '!room:example.com';
const ROOM2 = '!other:example.com';
const ROOM3 = '!third:example.com';
const INVITE_ROOM = '!invite:example.com';
const NOW = 1_700_000_000_000;

const MSC3575 = '/_matrix/client/unstable/org.matrix.msc3575/sync';
const MSC4186 = '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync';
const V4 = '/_matrix/client/v4/sync';

type SqlCall = { sql: string; args: unknown[] };

type MembershipRow = {
  room_id: string;
  user_id: string;
  membership: string;
  display_name?: string | null;
  avatar_url?: string | null;
};

type RoomMeta = {
  room_id: string;
  created_at: number;
  name?: string | null;
  avatar?: string | null;
  topic?: string | null;
  alias?: string | null;
};

type EventRow = {
  event_id: string;
  room_id: string;
  event_type: string;
  state_key?: string | null;
  content: string;
  sender: string;
  origin_server_ts: number;
  unsigned?: string | null;
  depth?: number;
  stream_ordering: number;
};

type StateRow = {
  room_id: string;
  event_type: string;
  state_key: string;
  event_id: string;
};

type AccountDataRow = {
  user_id: string;
  room_id: string;
  event_type: string;
  content: string;
};

type OtkCount = { algorithm: string; count: number };
type FallbackAlgo = { algorithm: string };
type DeviceKeyChange = { user_id: string; stream_position: number };

type ConnectionState = {
  userId: string;
  pos: number;
  lastAccess: number;
  roomStates: Record<string, { lastStreamOrdering: number; sentState: boolean }>;
  listStates: Record<string, { roomIds: string[]; count: number }>;
  roomNotificationCounts?: Record<string, number>;
  roomFullyReadMarkers?: Record<string, string>;
  initialSyncComplete?: boolean;
  roomSentAsRead?: Record<string, boolean>;
};

type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };

function mockKv(data: Record<string, string> = {}) {
  const puts: KvPut[] = [];
  const deletes: string[] = [];
  const kv = {
    data,
    puts,
    deletes,
    get: async (key: string, type?: string) => {
      const raw = data[key];
      if (raw == null) return null;
      if (type === 'json') {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
      return raw;
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      data[key] = value;
      puts.push({ key, value, options });
    },
    delete: async (key: string) => {
      deletes.push(key);
      delete data[key];
    },
  };
  return kv as unknown as KVNamespace & {
    data: Record<string, string>;
    puts: KvPut[];
    deletes: string[];
  };
}

type SyncDoFetch = { url: string; method: string; body?: unknown };

function createSyncDoStub(opts: {
  states?: Record<string, ConnectionState | null>;
  getFail?: boolean;
  getStatus?: number;
  waitHasEvents?: boolean;
  waitFail?: boolean;
  saveFail?: boolean;
} = {}) {
  const states: Record<string, ConnectionState | null> = { ...(opts.states ?? {}) };
  const fetches: SyncDoFetch[] = [];
  const saves: { connId: string; state: ConnectionState }[] = [];

  return {
    states,
    fetches,
    saves,
    async fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
      // Real DO stubs accept Request | string | URL + optional init (sliding-sync uses URL)
      const req = input instanceof Request ? input : new Request(input, init);
      let body: unknown;
      const method = req.method;
      const url = req.url;
      try {
        if (method !== 'GET' && method !== 'HEAD') body = await req.json();
      } catch {
        body = undefined;
      }
      fetches.push({ url, method, body });

      if (url.includes('/wait-for-events')) {
        if (opts.waitFail) throw new Error('wait boom');
        return Response.json({ hasEvents: opts.waitHasEvents ?? false });
      }

      const connId = new URL(url).searchParams.get('conn_id') || 'default';

      if (method === 'GET' && url.includes('/sliding-sync/state')) {
        if (opts.getFail) throw new Error('DO get boom');
        if (opts.getStatus && opts.getStatus !== 200) {
          return new Response('do error', { status: opts.getStatus });
        }
        const state = states[connId] ?? null;
        return Response.json(state);
      }

      if (method === 'PUT' && url.includes('/sliding-sync/state')) {
        if (opts.saveFail) {
          return new Response('save failed', { status: 500 });
        }
        const state = body as ConnectionState;
        states[connId] = state;
        saves.push({ connId, state });
        return Response.json({ ok: true });
      }

      return new Response('not found', { status: 404 });
    },
  };
}

type SyncDoStub = ReturnType<typeof createSyncDoStub>;

function createUserKeysStub(opts: {
  deviceIds?: string[];
  crossSigning?: Record<string, unknown>;
} = {}) {
  const deviceIds = opts.deviceIds ?? [DEVICE];
  const crossSigning = opts.crossSigning ?? {};
  const fetches: string[] = [];
  return {
    fetches,
    async fetch(req: Request): Promise<Response> {
      fetches.push(req.url);
      if (req.url.includes('/device-keys/list')) {
        return Response.json(deviceIds);
      }
      if (req.url.includes('/cross-signing/get')) {
        return Response.json(crossSigning);
      }
      return Response.json({});
    },
  };
}

type UserKeysStub = ReturnType<typeof createUserKeysStub>;

function makeEvent(
  partial: Partial<EventRow> & { event_id: string; room_id: string; event_type: string }
): EventRow {
  return {
    content: JSON.stringify({ body: 'hi', msgtype: 'm.text' }),
    sender: BOB,
    origin_server_ts: NOW,
    state_key: null,
    unsigned: null,
    depth: 1,
    stream_ordering: 10,
    ...partial,
  };
}

function createSlidingDb(opts: {
  maxStreamPos?: number | null;
  memberships?: MembershipRow[];
  rooms?: RoomMeta[];
  events?: EventRow[];
  state?: StateRow[];
  accountData?: AccountDataRow[];
  otkCounts?: OtkCount[];
  fallbackAlgos?: FallbackAlgo[];
  deviceKeyChanges?: DeviceKeyChange[];
  sharedRoomUsers?: string[];
} = {}) {
  const maxStreamPos = opts.maxStreamPos === undefined ? 42 : opts.maxStreamPos;
  const memberships = [...(opts.memberships ?? [])];
  const rooms = [...(opts.rooms ?? [])];
  const events = [...(opts.events ?? [])];
  const state = [...(opts.state ?? [])];
  const accountData = [...(opts.accountData ?? [])];
  const otkCounts = opts.otkCounts ?? [];
  const fallbackAlgos = opts.fallbackAlgos ?? [];
  const deviceKeyChanges = opts.deviceKeyChanges ?? [];
  const sharedRoomUsers = new Set(opts.sharedRoomUsers ?? [BOB, CAROL]);

  const selects: SqlCall[] = [];
  const batches: unknown[][] = [];

  function contentForState(roomId: string, eventType: string): string | null {
    const row = state.find((s) => s.room_id === roomId && s.event_type === eventType);
    if (!row) {
      // Fall back to RoomMeta convenience fields
      const meta = rooms.find((r) => r.room_id === roomId);
      if (!meta) return null;
      if (eventType === 'm.room.name' && meta.name) {
        return JSON.stringify({ name: meta.name });
      }
      if (eventType === 'm.room.avatar' && meta.avatar) {
        return JSON.stringify({ url: meta.avatar });
      }
      if (eventType === 'm.room.topic' && meta.topic) {
        return JSON.stringify({ topic: meta.topic });
      }
      if (eventType === 'm.room.canonical_alias' && meta.alias) {
        return JSON.stringify({ alias: meta.alias });
      }
      return null;
    }
    const ev = events.find((e) => e.event_id === row.event_id);
    return ev?.content ?? null;
  }

  function handleFirst(sql: string, args: unknown[]): unknown {
    if (sql.includes('MAX(stream_ordering)') && sql.includes('FROM events') && !sql.includes('WHERE')) {
      return { max_pos: maxStreamPos };
    }

    if (
      sql.includes('SELECT membership FROM room_memberships') &&
      sql.includes('room_id = ?') &&
      sql.includes('user_id = ?')
    ) {
      const [roomId, userId] = args as string[];
      const row = memberships.find((m) => m.room_id === roomId && m.user_id === userId);
      return row ? { membership: row.membership } : null;
    }

    if (
      sql.includes('FROM account_data') &&
      sql.includes("event_type = 'm.fully_read'")
    ) {
      const [userId, roomId] = args as string[];
      const row = accountData.find(
        (a) => a.user_id === userId && a.room_id === roomId && a.event_type === 'm.fully_read'
      );
      return row ? { content: row.content } : null;
    }

    if (sql.includes('MAX(origin_server_ts)') && sql.includes('FROM events WHERE room_id')) {
      const [roomId] = args as string[];
      const ts = events
        .filter((e) => e.room_id === roomId)
        .reduce((max, e) => Math.max(max, e.origin_server_ts), 0);
      return ts > 0 ? { ts } : null;
    }

    if (
      sql.includes('COUNT(*) as count FROM room_memberships') &&
      sql.includes("membership = 'join'")
    ) {
      const [roomId] = args as string[];
      return {
        count: memberships.filter((m) => m.room_id === roomId && m.membership === 'join').length,
      };
    }

    if (
      sql.includes('COUNT(*) as count FROM room_memberships') &&
      sql.includes("membership = 'invite'")
    ) {
      const [roomId] = args as string[];
      return {
        count: memberships.filter((m) => m.room_id === roomId && m.membership === 'invite')
          .length,
      };
    }

    return null;
  }

  function handleAll(sql: string, args: unknown[]): unknown[] {
    // getUserRooms consolidated query
    if (
      sql.includes('FROM room_memberships rm') &&
      sql.includes('JOIN rooms r') &&
      sql.includes('rm.user_id = ?')
    ) {
      const [userId] = args as string[];
      let rows = memberships
        .filter((m) => m.user_id === userId)
        .map((m) => {
          const meta = rooms.find((r) => r.room_id === m.room_id);
          const roomEvents = events.filter((e) => e.room_id === m.room_id);
          const lastActivity =
            roomEvents.reduce((max, e) => Math.max(max, e.origin_server_ts), 0) ||
            meta?.created_at ||
            NOW;
          const name = meta?.name ?? contentForState(m.room_id, 'm.room.name');
          let roomName: string | null = null;
          if (typeof name === 'string' && name.startsWith('{')) {
            try {
              roomName = JSON.parse(name).name ?? null;
            } catch {
              roomName = null;
            }
          } else if (typeof name === 'string') {
            roomName = name;
          }
          // Prefer meta.name
          if (meta?.name) roomName = meta.name;
          const memberCount = memberships.filter(
            (x) => x.room_id === m.room_id && x.membership === 'join'
          ).length;
          return {
            room_id: m.room_id,
            membership: m.membership,
            last_activity: lastActivity,
            room_name: roomName,
            member_count: memberCount,
          };
        });

      if (sql.includes("rm.membership = 'invite'")) {
        rows = rows.filter((r) => r.membership === 'invite');
      } else if (sql.includes('m.room.tombstone')) {
        rows = rows.filter((r) =>
          state.some((s) => s.room_id === r.room_id && s.event_type === 'm.room.tombstone')
        );
      } else if (sql.includes("membership IN ('join', 'invite')")) {
        rows = rows.filter((r) => r.membership === 'join' || r.membership === 'invite');
      }

      if (sql.includes('ORDER BY COALESCE(room_name')) {
        rows = [...rows].sort((a, b) =>
          (a.room_name || a.room_id).localeCompare(b.room_name || b.room_id)
        );
      } else {
        rows = [...rows].sort((a, b) => b.last_activity - a.last_activity);
      }

      return rows;
    }

    // Room metadata singles used in batch via all()
    if (sql.includes('SELECT room_id, created_at FROM rooms WHERE room_id = ?')) {
      const [roomId] = args as string[];
      const meta = rooms.find((r) => r.room_id === roomId);
      return meta ? [{ room_id: meta.room_id, created_at: meta.created_at }] : [];
    }

    if (sql.includes("rs.event_type = 'm.room.name'") && sql.includes('SELECT e.content')) {
      const [roomId] = args as string[];
      const content = contentForState(roomId, 'm.room.name');
      return content ? [{ content }] : [];
    }
    if (sql.includes("rs.event_type = 'm.room.avatar'") && sql.includes('SELECT e.content')) {
      const [roomId] = args as string[];
      const content = contentForState(roomId, 'm.room.avatar');
      return content ? [{ content }] : [];
    }
    if (sql.includes("rs.event_type = 'm.room.topic'") && sql.includes('SELECT e.content')) {
      const [roomId] = args as string[];
      const content = contentForState(roomId, 'm.room.topic');
      return content ? [{ content }] : [];
    }
    if (
      sql.includes("rs.event_type = 'm.room.canonical_alias'") &&
      sql.includes('SELECT e.content')
    ) {
      const [roomId] = args as string[];
      const content = contentForState(roomId, 'm.room.canonical_alias');
      return content ? [{ content }] : [];
    }

    if (
      sql.includes('SELECT COUNT(*) as count FROM room_memberships') &&
      sql.includes("membership = 'join'")
    ) {
      const [roomId] = args as string[];
      return [
        {
          count: memberships.filter((m) => m.room_id === roomId && m.membership === 'join')
            .length,
        },
      ];
    }

    if (
      sql.includes('SELECT COUNT(*) as count FROM room_memberships') &&
      sql.includes("membership = 'invite'")
    ) {
      const [roomId] = args as string[];
      return [
        {
          count: memberships.filter((m) => m.room_id === roomId && m.membership === 'invite')
            .length,
        },
      ];
    }

    if (
      sql.includes('SELECT user_id, display_name, avatar_url') &&
      sql.includes('FROM room_memberships') &&
      sql.includes("user_id != ?")
    ) {
      const [roomId, userId] = args as string[];
      return memberships
        .filter((m) => m.room_id === roomId && m.membership === 'join' && m.user_id !== userId)
        .slice(0, 5)
        .map((m) => ({
          user_id: m.user_id,
          display_name: m.display_name ?? null,
          avatar_url: m.avatar_url ?? null,
        }));
    }

    // required_state query
    if (
      sql.includes('FROM room_state rs') &&
      sql.includes('JOIN events e') &&
      sql.includes('SELECT e.event_id, e.event_type')
    ) {
      const roomId = args[0] as string;
      const stateRows = state.filter((s) => s.room_id === roomId);
      return stateRows
        .map((s) => {
          const ev = events.find((e) => e.event_id === s.event_id);
          if (!ev) return null;
          // Soft filter: if SQL mentions specific event_type binds, keep matching
          return {
            event_id: ev.event_id,
            event_type: ev.event_type,
            state_key: ev.state_key ?? s.state_key,
            content: ev.content,
            sender: ev.sender,
            origin_server_ts: ev.origin_server_ts,
            unsigned: ev.unsigned,
          };
        })
        .filter(Boolean) as unknown[];
    }

    // invite stripped state
    if (
      sql.includes('SELECT e.event_type, e.state_key, e.content, e.sender') &&
      sql.includes('FROM room_state rs')
    ) {
      const [roomId, eventType, maybeStateKey] = args as string[];
      return state
        .filter((s) => {
          if (s.room_id !== roomId || s.event_type !== eventType) return false;
          if (eventType === 'm.room.member' && maybeStateKey) {
            return s.state_key === maybeStateKey;
          }
          return true;
        })
        .map((s) => {
          const ev = events.find((e) => e.event_id === s.event_id);
          return {
            event_type: s.event_type,
            state_key: s.state_key,
            content: ev?.content ?? '{}',
            sender: ev?.sender ?? USER,
          };
        });
    }

    // timeline incremental
    if (
      sql.includes('FROM events') &&
      sql.includes('stream_ordering > ?') &&
      sql.includes('ORDER BY stream_ordering ASC')
    ) {
      const [roomId, since, limit] = args as [string, number, number];
      return events
        .filter((e) => e.room_id === roomId && e.stream_ordering > since)
        .sort((a, b) => a.stream_ordering - b.stream_ordering)
        .slice(0, limit);
    }

    // timeline initial (DESC)
    if (
      sql.includes('FROM events') &&
      sql.includes('WHERE room_id = ?') &&
      sql.includes('ORDER BY stream_ordering DESC') &&
      !sql.includes('sender !=')
    ) {
      const [roomId, limit] = args as [string, number];
      return events
        .filter((e) => e.room_id === roomId)
        .sort((a, b) => b.stream_ordering - a.stream_ordering)
        .slice(0, limit);
    }

    // global account data
    if (
      sql.includes('SELECT event_type, content FROM account_data') &&
      sql.includes("room_id = ''")
    ) {
      const [userId] = args as string[];
      return accountData
        .filter((a) => a.user_id === userId && a.room_id === '')
        .map((a) => ({ event_type: a.event_type, content: a.content }));
    }

    // room account data
    if (
      sql.includes('SELECT event_type, content FROM account_data') &&
      sql.includes('room_id = ?') &&
      !sql.includes("room_id = ''")
    ) {
      const [userId, roomId] = args as string[];
      return accountData
        .filter((a) => a.user_id === userId && a.room_id === roomId)
        .map((a) => ({ event_type: a.event_type, content: a.content }));
    }

    // joined room ids for account_data / typing fallback
    if (
      sql.includes('SELECT room_id FROM room_memberships') &&
      sql.includes("membership = 'join'")
    ) {
      const [userId] = args as string[];
      return memberships
        .filter((m) => m.user_id === userId && m.membership === 'join')
        .map((m) => ({ room_id: m.room_id }));
    }

    // presence members
    if (
      sql.includes('SELECT user_id FROM room_memberships') &&
      sql.includes("membership = 'join'")
    ) {
      const [roomId] = args as string[];
      return memberships
        .filter((m) => m.room_id === roomId && m.membership === 'join')
        .map((m) => ({ user_id: m.user_id }));
    }

    // OTK counts
    if (sql.includes('FROM one_time_keys') && sql.includes('GROUP BY algorithm')) {
      const [userId, deviceId] = args as string[];
      expect(userId).toBe(USER);
      expect(deviceId).toBe(DEVICE);
      return otkCounts;
    }

    // fallback keys
    if (sql.includes('FROM fallback_keys') && sql.includes('DISTINCT algorithm')) {
      const [userId, deviceId] = args as string[];
      expect(userId).toBe(USER);
      expect(deviceId).toBe(DEVICE);
      return fallbackAlgos;
    }

    // device key changes
    if (
      sql.includes('FROM device_key_changes dkc') &&
      sql.includes('SELECT DISTINCT dkc.user_id')
    ) {
      const [sincePos] = args as [number, string, string];
      const users = [
        ...new Set(
          deviceKeyChanges
            .filter(
              (c) =>
                c.stream_position > sincePos &&
                (c.user_id === USER || sharedRoomUsers.has(c.user_id))
            )
            .map((c) => c.user_id)
        ),
      ];
      return users.map((user_id) => ({ user_id }));
    }

    return [];
  }

  const db = {
    memberships,
    rooms,
    events,
    state,
    accountData,
    selects,
    batches,
    prepare(sql: string) {
      const makeStmt = (args: unknown[] = []) => ({
        sql,
        args,
        async first<T>() {
          selects.push({ sql, args });
          return handleFirst(sql, args) as T;
        },
        async all<T>() {
          selects.push({ sql, args });
          return { results: handleAll(sql, args) as T[] };
        },
        async run() {
          throw new Error(`Unexpected run() SQL: ${sql.slice(0, 120)}`);
        },
      });
      // D1 allows .first()/.all() without .bind() when there are no params
      return {
        ...makeStmt([]),
        bind(...args: unknown[]) {
          return makeStmt(args);
        },
      };
    },
    async batch(
      stmts: Array<{ sql: string; args: unknown[]; all: () => Promise<{ results: unknown[] }> }>
    ) {
      batches.push(stmts);
      const out = [];
      for (const stmt of stmts) {
        out.push(await stmt.all());
      }
      return out;
    },
  };

  return db;
}

type SlidingDb = ReturnType<typeof createSlidingDb>;

function fixtureJoinedRoom(overrides: Partial<RoomMeta> = {}): {
  memberships: MembershipRow[];
  rooms: RoomMeta[];
  events: EventRow[];
  state: StateRow[];
} {
  const roomId = overrides.room_id ?? ROOM;
  const name = overrides.name ?? 'General';
  const rooms: RoomMeta[] = [
    {
      room_id: roomId,
      created_at: NOW - 10_000,
      name,
      avatar: overrides.avatar ?? 'mxc://example.com/ava',
      topic: overrides.topic ?? 'hello topic',
      alias: overrides.alias ?? '#general:example.com',
    },
  ];
  const memberships: MembershipRow[] = [
    { room_id: roomId, user_id: USER, membership: 'join', display_name: 'Alice' },
    {
      room_id: roomId,
      user_id: BOB,
      membership: 'join',
      display_name: 'Bob',
      avatar_url: 'mxc://example.com/bob',
    },
    { room_id: roomId, user_id: CAROL, membership: 'join', display_name: 'Carol' },
  ];
  const events: EventRow[] = [
    makeEvent({
      event_id: `$name-${roomId}`,
      room_id: roomId,
      event_type: 'm.room.name',
      state_key: '',
      content: JSON.stringify({ name }),
      sender: USER,
      stream_ordering: 1,
    }),
    makeEvent({
      event_id: `$msg1-${roomId}`,
      room_id: roomId,
      event_type: 'm.room.message',
      content: JSON.stringify({ body: 'one', msgtype: 'm.text' }),
      sender: BOB,
      stream_ordering: 5,
      origin_server_ts: NOW - 1000,
    }),
    makeEvent({
      event_id: `$msg2-${roomId}`,
      room_id: roomId,
      event_type: 'm.room.message',
      content: JSON.stringify({ body: 'two', msgtype: 'm.text' }),
      sender: CAROL,
      stream_ordering: 8,
      origin_server_ts: NOW,
    }),
  ];
  const state: StateRow[] = [
    { room_id: roomId, event_type: 'm.room.name', state_key: '', event_id: `$name-${roomId}` },
  ];
  return { memberships, rooms, events, state };
}

function fixtureInviteRoom(): {
  memberships: MembershipRow[];
  rooms: RoomMeta[];
  events: EventRow[];
  state: StateRow[];
} {
  const rooms: RoomMeta[] = [
    { room_id: INVITE_ROOM, created_at: NOW - 5000, name: 'Secret Party' },
  ];
  const memberships: MembershipRow[] = [
    { room_id: INVITE_ROOM, user_id: USER, membership: 'invite' },
    { room_id: INVITE_ROOM, user_id: BOB, membership: 'join', display_name: 'Bob' },
  ];
  const events: EventRow[] = [
    makeEvent({
      event_id: '$inv-create',
      room_id: INVITE_ROOM,
      event_type: 'm.room.create',
      state_key: '',
      content: JSON.stringify({ creator: BOB }),
      sender: BOB,
      stream_ordering: 1,
    }),
    makeEvent({
      event_id: '$inv-name',
      room_id: INVITE_ROOM,
      event_type: 'm.room.name',
      state_key: '',
      content: JSON.stringify({ name: 'Secret Party' }),
      sender: BOB,
      stream_ordering: 2,
    }),
    makeEvent({
      event_id: '$inv-member',
      room_id: INVITE_ROOM,
      event_type: 'm.room.member',
      state_key: USER,
      content: JSON.stringify({ membership: 'invite', displayname: 'Alice' }),
      sender: BOB,
      stream_ordering: 3,
    }),
  ];
  const state: StateRow[] = [
    {
      room_id: INVITE_ROOM,
      event_type: 'm.room.create',
      state_key: '',
      event_id: '$inv-create',
    },
    { room_id: INVITE_ROOM, event_type: 'm.room.name', state_key: '', event_id: '$inv-name' },
    {
      room_id: INVITE_ROOM,
      event_type: 'm.room.member',
      state_key: USER,
      event_id: '$inv-member',
    },
  ];
  return { memberships, rooms, events, state };
}

function createEnv(
  opts: {
    db?: SlidingDb;
    cache?: ReturnType<typeof mockKv>;
    syncDo?: SyncDoStub;
    userKeys?: UserKeysStub;
  } = {}
) {
  const db = opts.db ?? createSlidingDb();
  const cache = opts.cache ?? mockKv();
  const syncDo = opts.syncDo ?? createSyncDoStub();
  const userKeys = opts.userKeys ?? createUserKeysStub();
  const env = {
    DB: db as unknown as D1Database,
    CACHE: cache,
    SERVER_NAME: 'example.com',
    SYNC: {
      idFromName: (name: string) => ({ name, toString: () => `id:${name}` }),
      get: () => syncDo,
    },
    USER_KEYS: {
      idFromName: (name: string) => ({ name, toString: () => `uk:${name}` }),
      get: () => userKeys,
    },
    _db: db,
    _cache: cache,
    _syncDo: syncDo,
    _userKeys: userKeys,
  };
  return env as unknown as Env & typeof env;
}

async function postSync(
  path: string,
  env: Env,
  body: unknown,
  init: { query?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = `http://localhost${path}${init.query ? `?${init.query}` : ''}`;
  const res = await slidingSyncApp.request(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    env
  );
  let parsed: Record<string, unknown> = {};
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { _raw: text };
    }
  }
  return { status: res.status, body: parsed };
}

function resetMocks() {
  countNotificationsWithRules.mockReset().mockResolvedValue({
    notification_count: 0,
    highlight_count: 0,
  });
  getTypingForRooms.mockReset().mockImplementation(async (_env, roomIds: string[]) => {
    const out: Record<string, string[]> = {};
    for (const id of roomIds) out[id] = [];
    return out;
  });
  getReceiptsForRooms
    .mockReset()
    .mockImplementation(async (_env, roomIds: string[]) => {
      const out: Record<string, Record<string, unknown>> = {};
      for (const id of roomIds) out[id] = {};
      return out;
    });
  getToDeviceMessages.mockReset().mockResolvedValue({ events: [], nextBatch: '0' });
  getE2EEAccountDataFromDO.mockReset().mockResolvedValue({});
}

beforeEach(() => {
  resetMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Request validation / DO availability
// ---------------------------------------------------------------------------

describe.each([
  ['MSC3575', MSC3575],
  ['MSC4186', MSC4186],
  ['v4', V4],
] as const)('%s — request validation', (_label, path) => {
  it('returns M_BAD_JSON for invalid JSON body', async () => {
    const env = createEnv();
    const { status, body } = await postSync(path, env, '{not-json', {});
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });

  it('returns 503 when SYNC DO get throws', async () => {
    const env = createEnv({ syncDo: createSyncDoStub({ getFail: true }) });
    const { status, body } = await postSync(path, env, {});
    expect(status).toBe(503);
    expect(body.errcode).toBe('M_UNKNOWN');
    expect(String(body.error)).toMatch(/temporarily unavailable/i);
  });

  it('returns 503 when SYNC DO get returns non-OK status', async () => {
    const env = createEnv({ syncDo: createSyncDoStub({ getStatus: 500 }) });
    const { status, body } = await postSync(path, env, { lists: {} });
    expect(status).toBe(503);
    expect(body.errcode).toBe('M_UNKNOWN');
  });

  it('returns M_UNKNOWN_POS when pos is ahead of current stream', async () => {
    const env = createEnv({
      db: createSlidingDb({ maxStreamPos: 10 }),
      syncDo: createSyncDoStub({ states: {} }),
    });
    const { status, body } = await postSync(path, env, { pos: '999' });
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_UNKNOWN_POS');
  });

  it('rejects >100 room_subscriptions with M_TOO_LARGE', async () => {
    const subs: Record<string, { timeline_limit: number }> = {};
    for (let i = 0; i < 101; i++) {
      subs[`!r${i}:example.com`] = { timeline_limit: 1 };
    }
    const env = createEnv();
    const { status, body } = await postSync(path, env, { room_subscriptions: subs });
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_TOO_LARGE');
  });
});

// ---------------------------------------------------------------------------
// Empty / baseline responses
// ---------------------------------------------------------------------------

describe.each([
  ['MSC3575', MSC3575],
  ['MSC4186', MSC4186],
  ['v4', V4],
] as const)('%s — empty baseline', (_label, path) => {
  it('returns pos from stream and empty lists/rooms/extensions', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSync(path, env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    // MSC3575 leaves extensions empty; MSC4186/v4 run ephemeral fallback on first sync
    if (path === MSC3575) {
      expect(body.extensions).toEqual({});
    } else {
      expect((body.extensions as any).typing).toEqual({ rooms: {} });
      expect((body.extensions as any).receipts).toEqual({ rooms: {} });
      expect((body.extensions as any).account_data).toEqual({ global: [], rooms: {} });
    }
  });

  it('echoes txn_id when provided', async () => {
    const env = createEnv();
    const { body } = await postSync(path, env, { txn_id: 'txn-abc' });
    expect(body.txn_id).toBe('txn-abc');
  });

  it('uses default conn_id and persists connection state to SYNC DO', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 7 }) });
    await postSync(path, env, {});
    expect(syncDo.saves.length).toBeGreaterThanOrEqual(1);
    expect(syncDo.saves[0].connId).toBe('default');
    expect(syncDo.saves[0].state.pos).toBe(7);
    expect(syncDo.saves[0].state.userId).toBe(USER);
  });

  it('honors custom conn_id', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    await postSync(path, env, { conn_id: 'phone' });
    expect(syncDo.fetches.some((f) => f.url.includes('conn_id=phone'))).toBe(true);
    expect(syncDo.saves[0].connId).toBe('phone');
  });

  it('treats null max_pos as stream position 0', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: null }) });
    const { body } = await postSync(path, env, {});
    expect(body.pos).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// Reconnect / pos handling
// ---------------------------------------------------------------------------

describe.each([
  ['MSC3575', MSC3575],
  ['MSC4186', MSC4186],
] as const)('%s — pos reconnect', (_label, path) => {
  it('reconnects with valid body pos when DO has no state', async () => {
    const syncDo = createSyncDoStub({ states: {} });
    const env = createEnv({
      syncDo,
      db: createSlidingDb({ maxStreamPos: 50 }),
    });
    const { status, body } = await postSync(path, env, { pos: '20' });
    expect(status).toBe(200);
    expect(body.pos).toBe('50');
    expect(syncDo.saves[0].state.pos).toBe(50);
  });

  it('accepts pos from query string over body', async () => {
    const syncDo = createSyncDoStub({ states: {} });
    const env = createEnv({
      syncDo,
      db: createSlidingDb({ maxStreamPos: 30 }),
    });
    const { status } = await postSync(path, env, { pos: '999' }, { query: 'pos=10' });
    expect(status).toBe(200);
  });

  it('reuses existing connection state when present', async () => {
    const existing: ConnectionState = {
      userId: USER,
      pos: 5,
      lastAccess: NOW - 1000,
      roomStates: {
        [ROOM]: { sentState: true, lastStreamOrdering: 5 },
      },
      listStates: {
        all: { roomIds: [ROOM], count: 1 },
      },
      initialSyncComplete: true,
    };
    const syncDo = createSyncDoStub({ states: { default: existing } });
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      syncDo,
      db: createSlidingDb({
        maxStreamPos: 20,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { status, body } = await postSync(path, env, {
      pos: '5',
      lists: {
        all: { ranges: [[0, 9]], timeline_limit: 2 },
      },
    });
    expect(status).toBe(200);
    // Unchanged list → count without ops
    const lists = body.lists as Record<string, { count: number; ops?: unknown[] }>;
    expect(lists.all.count).toBe(1);
    expect(lists.all.ops).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Lists + ranges (MSC3575)
// ---------------------------------------------------------------------------

describe('MSC3575 — lists and room data', () => {
  it('returns SYNC op with room_ids for initial list', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 8,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { body } = await postSync(MSC3575, env, {
      lists: {
        all: {
          ranges: [[0, 9]],
          timeline_limit: 10,
          required_state: [['m.room.name', '']],
        },
      },
    });

    const lists = body.lists as Record<
      string,
      { count: number; ops: { op: string; range: number[]; room_ids: string[] }[] }
    >;
    expect(lists.all.count).toBe(1);
    expect(lists.all.ops[0].op).toBe('SYNC');
    expect(lists.all.ops[0].room_ids).toEqual([ROOM]);

    const rooms = body.rooms as Record<string, Record<string, unknown>>;
    expect(rooms[ROOM].name).toBe('General');
    expect(rooms[ROOM].membership).toBe('join');
    expect(rooms[ROOM].initial).toBe(true);
    expect(Array.isArray(rooms[ROOM].timeline)).toBe(true);
    expect((rooms[ROOM].timeline as unknown[]).length).toBeGreaterThan(0);
    expect(countNotificationsWithRules).toHaveBeenCalled();
  });

  it('applies MSC3575 ranges window (first range only)', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'A' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'B' });
    const c = fixtureJoinedRoom({ room_id: ROOM3, name: 'C' });
    // Force recency order: C newest, then B, then A
    a.events.forEach((e) => {
      e.origin_server_ts = NOW - 3000;
    });
    b.events.forEach((e) => {
      e.origin_server_ts = NOW - 2000;
    });
    c.events.forEach((e) => {
      e.origin_server_ts = NOW - 1000;
    });

    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 30,
        memberships: [...a.memberships, ...b.memberships, ...c.memberships],
        rooms: [...a.rooms, ...b.rooms, ...c.rooms],
        events: [...a.events, ...b.events, ...c.events],
        state: [...a.state, ...b.state, ...c.state],
      }),
    });

    const { body } = await postSync(MSC3575, env, {
      lists: {
        window: { ranges: [[0, 1]], timeline_limit: 1 },
      },
    });
    const op = (body.lists as any).window.ops[0];
    expect(op.range).toEqual([0, 1]);
    expect(op.room_ids).toHaveLength(2);
    expect(op.room_ids[0]).toBe(ROOM3);
    expect(op.room_ids[1]).toBe(ROOM2);
  });

  it('filters lists with is_dm and room_name_like', async () => {
    const named = fixtureJoinedRoom({ room_id: ROOM, name: 'Public Hall' });
    // DM: 2 members, no name
    const dmMemberships: MembershipRow[] = [
      { room_id: ROOM2, user_id: USER, membership: 'join' },
      { room_id: ROOM2, user_id: BOB, membership: 'join' },
    ];
    const dmRooms: RoomMeta[] = [{ room_id: ROOM2, created_at: NOW, name: null }];
    const dmEvents = [
      makeEvent({
        event_id: '$dm1',
        room_id: ROOM2,
        event_type: 'm.room.message',
        stream_ordering: 3,
      }),
    ];

    const env = createEnv({
      db: createSlidingDb({
        memberships: [...named.memberships, ...dmMemberships],
        rooms: [...named.rooms, ...dmRooms],
        events: [...named.events, ...dmEvents],
        state: named.state,
      }),
    });

    const dmOnly = await postSync(MSC3575, env, {
      lists: { dms: { ranges: [[0, 99]], filters: { is_dm: true }, timeline_limit: 5 } },
    });
    expect((dmOnly.body.lists as any).dms.ops[0].room_ids).toEqual([ROOM2]);

    // room_name_like only filters rooms that have a name; unnamed DMs pass through.
    // Pair with is_dm:false to isolate named rooms matching "hall".
    const nameFilter = await postSync(MSC3575, env, {
      lists: {
        pub: {
          ranges: [[0, 99]],
          filters: { room_name_like: 'hall', is_dm: false },
          timeline_limit: 5,
        },
      },
    });
    expect((nameFilter.body.lists as any).pub.ops[0].room_ids).toEqual([ROOM]);
  });

  it('filters invite-only list via is_invite', async () => {
    const joined = fixtureJoinedRoom();
    const invite = fixtureInviteRoom();
    const env = createEnv({
      db: createSlidingDb({
        memberships: [...joined.memberships, ...invite.memberships],
        rooms: [...joined.rooms, ...invite.rooms],
        events: [...joined.events, ...invite.events],
        state: [...joined.state, ...invite.state],
      }),
    });
    const { body } = await postSync(MSC3575, env, {
      lists: {
        invites: { ranges: [[0, 9]], filters: { is_invite: true }, timeline_limit: 1 },
      },
    });
    expect((body.lists as any).invites.ops[0].room_ids).toEqual([INVITE_ROOM]);
    const rooms = body.rooms as Record<string, any>;
    expect(rooms[INVITE_ROOM].membership).toBe('invite');
    expect(rooms[INVITE_ROOM].invite_state).toBeTruthy();
    expect(rooms[INVITE_ROOM].name).toBe('Secret Party');
  });

  it('sorts by_name when requested', async () => {
    const zebra = fixtureJoinedRoom({ room_id: ROOM, name: 'Zebra' });
    const apple = fixtureJoinedRoom({ room_id: ROOM2, name: 'Apple' });
    zebra.events.forEach((e) => {
      e.origin_server_ts = NOW;
    });
    apple.events.forEach((e) => {
      e.origin_server_ts = NOW - 1;
    });
    const env = createEnv({
      db: createSlidingDb({
        memberships: [...zebra.memberships, ...apple.memberships],
        rooms: [...zebra.rooms, ...apple.rooms],
        events: [...zebra.events, ...apple.events],
        state: [...zebra.state, ...apple.state],
      }),
    });
    const { body } = await postSync(MSC3575, env, {
      lists: {
        named: { ranges: [[0, 9]], sort: ['by_name'], timeline_limit: 1 },
      },
    });
    expect((body.lists as any).named.ops[0].room_ids).toEqual([ROOM2, ROOM]);
  });

  it('includes heroes when room has no name', async () => {
    const memberships: MembershipRow[] = [
      { room_id: ROOM, user_id: USER, membership: 'join' },
      {
        room_id: ROOM,
        user_id: BOB,
        membership: 'join',
        display_name: 'Bob',
        avatar_url: 'mxc://b',
      },
    ];
    const rooms: RoomMeta[] = [{ room_id: ROOM, created_at: NOW, name: null }];
    const events = [
      makeEvent({
        event_id: '$m1',
        room_id: ROOM,
        event_type: 'm.room.message',
        stream_ordering: 2,
      }),
    ];
    const env = createEnv({
      db: createSlidingDb({ memberships, rooms, events }),
    });
    const { body } = await postSync(MSC3575, env, {
      lists: { all: { ranges: [[0, 0]], timeline_limit: 5 } },
    });
    const room = (body.rooms as any)[ROOM];
    expect(room.heroes).toEqual([
      { user_id: BOB, displayname: 'Bob', avatar_url: 'mxc://b' },
    ]);
    expect(room.is_dm).toBe(true);
  });

  it('sets limited=true when timeline exceeds limit', async () => {
    const events: EventRow[] = [];
    for (let i = 1; i <= 5; i++) {
      events.push(
        makeEvent({
          event_id: `$e${i}`,
          room_id: ROOM,
          event_type: 'm.room.message',
          stream_ordering: i,
          content: JSON.stringify({ body: String(i), msgtype: 'm.text' }),
        })
      );
    }
    const memberships: MembershipRow[] = [
      { room_id: ROOM, user_id: USER, membership: 'join' },
      { room_id: ROOM, user_id: BOB, membership: 'join' },
    ];
    const rooms: RoomMeta[] = [{ room_id: ROOM, created_at: NOW, name: 'Busy' }];
    const env = createEnv({
      db: createSlidingDb({ memberships, rooms, events, maxStreamPos: 5 }),
    });
    const { body } = await postSync(MSC3575, env, {
      lists: { all: { ranges: [[0, 0]], timeline_limit: 2 } },
    });
    const room = (body.rooms as any)[ROOM];
    expect(room.timeline).toHaveLength(2);
    expect(room.limited).toBe(true);
    expect(room.prev_batch).toMatch(/^s/);
  });

  it('returns required_state events including $ME expansion', async () => {
    const fx = fixtureJoinedRoom();
    fx.events.push(
      makeEvent({
        event_id: '$me-member',
        room_id: ROOM,
        event_type: 'm.room.member',
        state_key: USER,
        content: JSON.stringify({ membership: 'join', displayname: 'Alice' }),
        sender: USER,
        stream_ordering: 2,
      })
    );
    fx.state.push({
      room_id: ROOM,
      event_type: 'm.room.member',
      state_key: USER,
      event_id: '$me-member',
    });
    const env = createEnv({
      db: createSlidingDb({
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { body } = await postSync(MSC3575, env, {
      lists: {
        all: {
          ranges: [[0, 0]],
          timeline_limit: 1,
          required_state: [
            ['m.room.name', ''],
            ['m.room.member', '$ME'],
          ],
        },
      },
    });
    const required = (body.rooms as any)[ROOM].required_state as any[];
    expect(required.some((e) => e.type === 'm.room.name')).toBe(true);
    expect(required.some((e) => e.type === 'm.room.member' && e.state_key === USER)).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// MSC4186 / v4 lists prefer range over ranges
// ---------------------------------------------------------------------------

describe('MSC4186 / v4 — range preference and always-include subscriptions', () => {
  it('prefers MSC4186 range over ranges on simplified endpoints', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'A' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'B' });
    const c = fixtureJoinedRoom({ room_id: ROOM3, name: 'C' });
    a.events.forEach((e) => {
      e.origin_server_ts = NOW - 300;
    });
    b.events.forEach((e) => {
      e.origin_server_ts = NOW - 200;
    });
    c.events.forEach((e) => {
      e.origin_server_ts = NOW - 100;
    });
    const env = createEnv({
      db: createSlidingDb({
        memberships: [...a.memberships, ...b.memberships, ...c.memberships],
        rooms: [...a.rooms, ...b.rooms, ...c.rooms],
        events: [...a.events, ...b.events, ...c.events],
        state: [...a.state, ...b.state, ...c.state],
      }),
    });

    const { body } = await postSync(MSC4186, env, {
      lists: {
        // ranges would take [0,2] on MSC3575; range takes [1,1] on MSC4186
        all: { ranges: [[0, 2]], range: [1, 1], timeline_limit: 1 },
      },
    });
    const op = (body.lists as any).all.ops[0];
    expect(op.range).toEqual([1, 1]);
    expect(op.room_ids).toEqual([ROOM2]);
  });

  it('always includes room_subscriptions rooms on MSC4186 even without new events', async () => {
    const fx = fixtureJoinedRoom();
    const existing: ConnectionState = {
      userId: USER,
      pos: 8,
      lastAccess: NOW,
      roomStates: {
        [ROOM]: { sentState: true, lastStreamOrdering: 8 },
      },
      listStates: {},
      roomNotificationCounts: { [ROOM]: 0 },
      roomSentAsRead: { [ROOM]: true },
      roomFullyReadMarkers: { [ROOM]: '$msg2' },
      initialSyncComplete: true,
    };
    const syncDo = createSyncDoStub({ states: { default: existing } });
    const env = createEnv({
      syncDo,
      db: createSlidingDb({
        maxStreamPos: 8,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { body } = await postSync(V4, env, {
      pos: '8',
      room_subscriptions: {
        [ROOM]: { timeline_limit: 2, required_state: [['m.room.name', '']] },
      },
    });
    expect((body.rooms as any)[ROOM]).toBeTruthy();
    expect((body.rooms as any)[ROOM].membership).toBe('join');
  });

  it('v4 and simplified unstable share the same handler behavior for empty body', async () => {
    const envA = createEnv({ db: createSlidingDb({ maxStreamPos: 11 }) });
    const envB = createEnv({ db: createSlidingDb({ maxStreamPos: 11 }) });
    const a = await postSync(MSC4186, envA, { txn_id: 'x' });
    const b = await postSync(V4, envB, { txn_id: 'x' });
    expect(a.body.pos).toBe(b.body.pos);
    expect(a.body.txn_id).toBe(b.body.txn_id);
    expect(a.body.lists).toEqual(b.body.lists);
  });
});

// ---------------------------------------------------------------------------
// Room subscriptions + unsubscribe
// ---------------------------------------------------------------------------

describe('room_subscriptions and unsubscribe_rooms', () => {
  it('skips subscriptions for rooms the user is not in', async () => {
    const env = createEnv({
      db: createSlidingDb({
        memberships: [],
        rooms: [{ room_id: ROOM, created_at: NOW }],
      }),
    });
    const { body } = await postSync(MSC3575, env, {
      room_subscriptions: { [ROOM]: { timeline_limit: 5 } },
    });
    expect(body.rooms).toEqual({});
  });

  it('returns invite_state for subscribed invite rooms', async () => {
    const invite = fixtureInviteRoom();
    const env = createEnv({
      db: createSlidingDb({
        memberships: invite.memberships,
        rooms: invite.rooms,
        events: invite.events,
        state: invite.state,
      }),
    });
    const { body } = await postSync(MSC3575, env, {
      room_subscriptions: { [INVITE_ROOM]: { timeline_limit: 1 } },
    });
    const room = (body.rooms as any)[INVITE_ROOM];
    expect(room.membership).toBe('invite');
    expect(room.invite_state.length).toBeGreaterThan(0);
  });

  it('unsubscribes rooms from connection state', async () => {
    const existing: ConnectionState = {
      userId: USER,
      pos: 1,
      lastAccess: NOW,
      roomStates: {
        [ROOM]: { sentState: true, lastStreamOrdering: 1 },
        [ROOM2]: { sentState: true, lastStreamOrdering: 1 },
      },
      listStates: {},
    };
    const syncDo = createSyncDoStub({ states: { default: existing } });
    const env = createEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 2 }) });
    await postSync(MSC3575, env, {
      pos: '1',
      unsubscribe_rooms: [ROOM],
    });
    const saved = syncDo.saves[0].state;
    expect(saved.roomStates[ROOM]).toBeUndefined();
    expect(saved.roomStates[ROOM2]).toBeTruthy();
  });

  it('allows exactly 100 room_subscriptions', async () => {
    const memberships: MembershipRow[] = [];
    const rooms: RoomMeta[] = [];
    const events: EventRow[] = [];
    const subs: Record<string, { timeline_limit: number }> = {};
    for (let i = 0; i < 100; i++) {
      const id = `!r${i}:example.com`;
      subs[id] = { timeline_limit: 1 };
      memberships.push({ room_id: id, user_id: USER, membership: 'join' });
      rooms.push({ room_id: id, created_at: NOW, name: `R${i}` });
      events.push(
        makeEvent({
          event_id: `$e${i}`,
          room_id: id,
          event_type: 'm.room.message',
          stream_ordering: i + 1,
        })
      );
    }
    const env = createEnv({
      db: createSlidingDb({ memberships, rooms, events, maxStreamPos: 100 }),
    });
    const { status, body } = await postSync(MSC3575, env, { room_subscriptions: subs });
    expect(status).toBe(200);
    expect(Object.keys(body.rooms as object).length).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Incremental room inclusion gates
// ---------------------------------------------------------------------------

describe('incremental room inclusion gates', () => {
  it('includes room when notification_count changes', async () => {
    const fx = fixtureJoinedRoom();
    const existing: ConnectionState = {
      userId: USER,
      pos: 8,
      lastAccess: NOW,
      roomStates: { [ROOM]: { sentState: true, lastStreamOrdering: 8 } },
      listStates: { all: { roomIds: [ROOM], count: 1 } },
      roomNotificationCounts: { [ROOM]: 3 },
      roomSentAsRead: {},
      initialSyncComplete: true,
    };
    countNotificationsWithRules.mockResolvedValue({
      notification_count: 0,
      highlight_count: 0,
    });
    const syncDo = createSyncDoStub({ states: { default: existing } });
    const env = createEnv({
      syncDo,
      db: createSlidingDb({
        maxStreamPos: 8,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { body } = await postSync(MSC3575, env, {
      pos: '8',
      lists: { all: { ranges: [[0, 0]], timeline_limit: 2 } },
    });
    expect((body.rooms as any)[ROOM]).toBeTruthy();
    expect(syncDo.saves[0].state.roomSentAsRead?.[ROOM]).toBe(true);
  });

  it('includes room when m.fully_read marker changes', async () => {
    const fx = fixtureJoinedRoom();
    const existing: ConnectionState = {
      userId: USER,
      pos: 8,
      lastAccess: NOW,
      roomStates: { [ROOM]: { sentState: true, lastStreamOrdering: 8 } },
      listStates: { all: { roomIds: [ROOM], count: 1 } },
      roomNotificationCounts: { [ROOM]: 0 },
      roomFullyReadMarkers: { [ROOM]: '$old' },
      roomSentAsRead: { [ROOM]: true },
      initialSyncComplete: true,
    };
    const syncDo = createSyncDoStub({ states: { default: existing } });
    const env = createEnv({
      syncDo,
      db: createSlidingDb({
        maxStreamPos: 8,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
        accountData: [
          {
            user_id: USER,
            room_id: ROOM,
            event_type: 'm.fully_read',
            content: JSON.stringify({ event_id: '$msg2-!room:example.com' }),
          },
        ],
      }),
    });
    const { body } = await postSync(MSC3575, env, {
      pos: '8',
      lists: { all: { ranges: [[0, 0]], timeline_limit: 2 } },
    });
    expect((body.rooms as any)[ROOM]).toBeTruthy();
    expect(syncDo.saves[0].state.roomFullyReadMarkers?.[ROOM]).toBe(
      '$msg2-!room:example.com'
    );
  });

  it('includes incremental timeline events with num_live', async () => {
    const fx = fixtureJoinedRoom();
    fx.events.push(
      makeEvent({
        event_id: '$new',
        room_id: ROOM,
        event_type: 'm.room.message',
        stream_ordering: 12,
        content: JSON.stringify({ body: 'new', msgtype: 'm.text' }),
        sender: BOB,
      })
    );
    const existing: ConnectionState = {
      userId: USER,
      pos: 8,
      lastAccess: NOW,
      roomStates: { [ROOM]: { sentState: true, lastStreamOrdering: 8 } },
      listStates: { all: { roomIds: [ROOM], count: 1 } },
      roomNotificationCounts: { [ROOM]: 1 },
      roomSentAsRead: {},
      initialSyncComplete: true,
    };
    countNotificationsWithRules.mockResolvedValue({
      notification_count: 1,
      highlight_count: 0,
    });
    const syncDo = createSyncDoStub({ states: { default: existing } });
    const env = createEnv({
      syncDo,
      db: createSlidingDb({
        maxStreamPos: 12,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { body } = await postSync(MSC3575, env, {
      pos: '8',
      lists: { all: { ranges: [[0, 0]], timeline_limit: 10 } },
    });
    const room = (body.rooms as any)[ROOM];
    expect(room.timeline.some((e: any) => e.event_id === '$new')).toBe(true);
    expect(room.num_live).toBeGreaterThanOrEqual(1);
    expect(syncDo.saves[0].state.roomStates[ROOM].lastStreamOrdering).toBe(12);
  });

  it('omits joined room on incremental when nothing changed', async () => {
    const fx = fixtureJoinedRoom();
    const existing: ConnectionState = {
      userId: USER,
      pos: 8,
      lastAccess: NOW,
      roomStates: { [ROOM]: { sentState: true, lastStreamOrdering: 8 } },
      listStates: { all: { roomIds: [ROOM], count: 1 } },
      roomNotificationCounts: { [ROOM]: 0 },
      roomFullyReadMarkers: { [ROOM]: '' },
      roomSentAsRead: { [ROOM]: true },
      initialSyncComplete: true,
    };
    const syncDo = createSyncDoStub({ states: { default: existing } });
    const env = createEnv({
      syncDo,
      db: createSlidingDb({
        maxStreamPos: 8,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { body } = await postSync(MSC3575, env, {
      pos: '8',
      lists: { all: { ranges: [[0, 0]], timeline_limit: 2 } },
    });
    expect((body.rooms as any)[ROOM]).toBeUndefined();
    expect((body.lists as any).all.ops).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Extensions — MSC3575
// ---------------------------------------------------------------------------

describe('MSC3575 — extensions', () => {
  it('returns to_device events via getToDeviceMessages', async () => {
    getToDeviceMessages.mockResolvedValue({
      events: [{ type: 'm.room_key_request', sender: BOB, content: { a: 1 } }],
      nextBatch: '77',
    });
    const env = createEnv();
    const { body } = await postSync(MSC3575, env, {
      extensions: { to_device: { since: '10', limit: 5 } },
    });
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '10', 5);
    expect((body.extensions as any).to_device).toEqual({
      next_batch: '77',
      events: [{ type: 'm.room_key_request', sender: BOB, content: { a: 1 } }],
    });
  });

  it('defaults to_device limit to 100', async () => {
    const env = createEnv();
    await postSync(MSC3575, env, { extensions: { to_device: {} } });
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, undefined, 100);
  });

  it('e2ee extension: OTK counts, fallback types, and self on initial pos', async () => {
    const userKeys = createUserKeysStub({
      deviceIds: [DEVICE],
      crossSigning: { master_key: { keys: {} } },
    });
    const env = createEnv({
      userKeys,
      db: createSlidingDb({
        otkCounts: [
          { algorithm: 'signed_curve25519', count: 12 },
          { algorithm: 'curve25519', count: 3 },
        ],
        fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
      }),
    });
    const { body } = await postSync(MSC3575, env, {
      extensions: { e2ee: {} },
    });
    const e2ee = (body.extensions as any).e2ee;
    expect(e2ee.device_one_time_keys_count).toEqual({
      signed_curve25519: 12,
      curve25519: 3,
    });
    expect(e2ee.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
    expect(e2ee.device_lists.changed).toContain(USER);
    expect(e2ee.device_lists.left).toEqual([]);
  });

  it('e2ee extension: device_lists from D1 changes when pos > 0', async () => {
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 50,
        deviceKeyChanges: [
          { user_id: BOB, stream_position: 20 },
          { user_id: CAROL, stream_position: 5 },
          { user_id: USER, stream_position: 25 },
        ],
        sharedRoomUsers: [BOB],
      }),
    });
    const { body } = await postSync(MSC3575, env, {
      pos: '10',
      extensions: { e2ee: { enabled: true } },
    });
    const changed = (body.extensions as any).e2ee.device_lists.changed as string[];
    expect(changed).toContain(BOB);
    expect(changed).toContain(USER);
    expect(changed).not.toContain(CAROL); // before since + not shared if filtered — carol pos 5 <= 10
  });

  it('e2ee initial sync skips self when no device/cross-signing keys', async () => {
    const userKeys = createUserKeysStub({ deviceIds: [], crossSigning: {} });
    const env = createEnv({ userKeys });
    const { body } = await postSync(MSC3575, env, { extensions: { e2ee: {} } });
    expect((body.extensions as any).e2ee.device_lists.changed).toEqual([]);
  });

  it('account_data merges D1 global + E2EE DO and room account data', async () => {
    getE2EEAccountDataFromDO.mockResolvedValue({
      'm.secret_storage.default_key': { key: 'k1' },
    });
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
        accountData: [
          {
            user_id: USER,
            room_id: '',
            event_type: 'm.push_rules',
            content: JSON.stringify({ global: {} }),
          },
          {
            user_id: USER,
            room_id: '',
            event_type: 'bad.json',
            content: '{broken',
          },
          {
            user_id: USER,
            room_id: ROOM,
            event_type: 'm.tag',
            content: JSON.stringify({ tags: { 'm.favourite': {} } }),
          },
        ],
      }),
    });
    const { body } = await postSync(MSC3575, env, {
      lists: { all: { ranges: [[0, 0]], timeline_limit: 1 } },
      extensions: { account_data: {} },
    });
    const ad = (body.extensions as any).account_data;
    const types = ad.global.map((e: any) => e.type);
    expect(types).toContain('m.push_rules');
    expect(types).toContain('m.secret_storage.default_key');
    expect(types).toContain('bad.json');
    expect(ad.global.find((e: any) => e.type === 'bad.json').content).toEqual({});
    expect(ad.rooms[ROOM]).toEqual([
      { type: 'm.tag', content: { tags: { 'm.favourite': {} } } },
    ]);
  });

  it('account_data continues when E2EE DO throws', async () => {
    getE2EEAccountDataFromDO.mockRejectedValue(new Error('do down'));
    const env = createEnv({
      db: createSlidingDb({
        accountData: [
          {
            user_id: USER,
            room_id: '',
            event_type: 'im.vector.setting.breadcrumbs',
            content: JSON.stringify({ recent_rooms: [] }),
          },
        ],
      }),
    });
    const { status, body } = await postSync(MSC3575, env, {
      extensions: { account_data: { enabled: true } },
    });
    expect(status).toBe(200);
    expect((body.extensions as any).account_data.global).toHaveLength(1);
  });

  it('typing extension fetches for response + subscription rooms', async () => {
    getTypingForRooms.mockResolvedValue({ [ROOM]: [BOB], [ROOM2]: [] });
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        memberships: [
          ...fx.memberships,
          { room_id: ROOM2, user_id: USER, membership: 'join' },
        ],
        rooms: [...fx.rooms, { room_id: ROOM2, created_at: NOW, name: 'Other' }],
        events: fx.events,
        state: fx.state,
      }),
    });
    const { body } = await postSync(MSC3575, env, {
      lists: { all: { ranges: [[0, 0]], timeline_limit: 1 } },
      room_subscriptions: { [ROOM2]: { timeline_limit: 1 } },
      extensions: { typing: {} },
    });
    expect(getTypingForRooms).toHaveBeenCalled();
    const typing = (body.extensions as any).typing.rooms;
    expect(typing[ROOM].content.user_ids).toEqual([BOB]);
    expect(typing[ROOM2].type).toBe('m.typing');
  });

  it('receipts extension passes userId for private receipt filtering', async () => {
    getReceiptsForRooms.mockResolvedValue({
      [ROOM]: { '$e': { 'm.read': { [BOB]: { ts: NOW } } } },
    });
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { body } = await postSync(MSC3575, env, {
      lists: { all: { ranges: [[0, 0]], timeline_limit: 1 } },
      extensions: { receipts: {} },
    });
    expect(getReceiptsForRooms).toHaveBeenCalledWith(expect.anything(), expect.any(Array), USER);
    expect((body.extensions as any).receipts.rooms[ROOM].type).toBe('m.receipt');
  });

  it('presence extension loads KV presence for other room members', async () => {
    const fx = fixtureJoinedRoom();
    const cache = mockKv({
      [`presence:${BOB}`]: JSON.stringify({ presence: 'online', status_msg: 'hi' }),
      [`presence:${CAROL}`]: JSON.stringify({ presence: 'unavailable' }),
    });
    const env = createEnv({
      cache,
      db: createSlidingDb({
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { body } = await postSync(MSC3575, env, {
      lists: { all: { ranges: [[0, 0]], timeline_limit: 1 } },
      extensions: { presence: {} },
    });
    const events = (body.extensions as any).presence.events as any[];
    expect(events.every((e) => e.sender !== USER)).toBe(true);
    expect(events.some((e) => e.sender === BOB && e.content.presence === 'online')).toBe(
      true
    );
    expect(events.some((e) => e.sender === CAROL)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Extensions — MSC4186 specifics (typing fallback, empty presence, ephemeral)
// ---------------------------------------------------------------------------

describe('MSC4186 — extension edges and ephemeral fallback', () => {
  it('typing with no rooms falls back to all joined rooms', async () => {
    getTypingForRooms.mockResolvedValue({ [ROOM]: [CAROL] });
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { body } = await postSync(MSC4186, env, {
      extensions: { typing: {} },
    });
    expect(getTypingForRooms).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([ROOM])
    );
    expect((body.extensions as any).typing.rooms[ROOM].content.user_ids).toEqual([CAROL]);
  });

  it('receipts with no rooms falls back to all joined rooms', async () => {
    getReceiptsForRooms.mockResolvedValue({ [ROOM]: { x: 1 } });
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { body } = await postSync(MSC4186, env, {
      extensions: { receipts: { enabled: true } },
    });
    expect((body.extensions as any).receipts.rooms[ROOM]).toEqual({
      type: 'm.receipt',
      content: { x: 1 },
    });
  });

  it('presence extension returns empty events array on MSC4186', async () => {
    const env = createEnv();
    const { body } = await postSync(V4, env, { extensions: { presence: {} } });
    expect((body.extensions as any).presence).toEqual({ events: [] });
  });

  it('account_data on MSC4186 loads room data for all joined rooms', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
        accountData: [
          {
            user_id: USER,
            room_id: ROOM,
            event_type: 'm.fully_read',
            content: JSON.stringify({ event_id: '$msg1' }),
          },
        ],
      }),
    });
    const { body } = await postSync(MSC4186, env, {
      extensions: { account_data: {} },
    });
    expect((body.extensions as any).account_data.rooms[ROOM][0].type).toBe('m.fully_read');
  });

  it('ephemeral fallback on first sync without extensions includes typing/receipts/account_data', async () => {
    getTypingForRooms.mockResolvedValue({ [ROOM]: [BOB] });
    getReceiptsForRooms.mockResolvedValue({
      [ROOM]: { '$m': { 'm.read': { [USER]: { ts: NOW } } } },
    });
    const fx = fixtureJoinedRoom();
    const syncDo = createSyncDoStub();
    const env = createEnv({
      syncDo,
      db: createSlidingDb({
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
        accountData: [
          {
            user_id: USER,
            room_id: ROOM,
            event_type: 'm.fully_read',
            content: JSON.stringify({ event_id: '$msg1' }),
          },
        ],
      }),
    });
    const { body } = await postSync(MSC4186, env, {
      lists: { all: { range: [0, 0], timeline_limit: 1 } },
    });
    expect((body.extensions as any).typing.rooms[ROOM].content.user_ids).toEqual([BOB]);
    expect((body.extensions as any).receipts.rooms[ROOM].type).toBe('m.receipt');
    expect((body.extensions as any).account_data.rooms[ROOM]).toBeTruthy();
    expect(syncDo.saves[0].state.initialSyncComplete).toBe(true);
  });

  it('skips ephemeral fallback when initialSyncComplete is already set', async () => {
    const existing: ConnectionState = {
      userId: USER,
      pos: 1,
      lastAccess: NOW,
      roomStates: {},
      listStates: {},
      initialSyncComplete: true,
    };
    const syncDo = createSyncDoStub({ states: { default: existing } });
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      syncDo,
      db: createSlidingDb({
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { body } = await postSync(MSC4186, env, {
      pos: '1',
      lists: { all: { range: [0, 0], timeline_limit: 1 } },
    });
    // No extensions key for typing from fallback — may still have typing if rooms in response
    // Actually MSC4186 includes typing when roomsInResponse.length > 0 even without typing extension!
    // So typing may be present. But account_data fallback and receipts fallback from needsEphemeralFallback should not run.
    // When rooms in response and no extensions, typing still gets included via `typingRequested || roomsInResponse.length > 0`.
    expect((body.extensions as any).account_data).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Long-poll wait (MSC4186 only)
// ---------------------------------------------------------------------------

describe('MSC4186 — long-poll wait-for-events', () => {
  it('waits via SYNC DO when no changes and timeout > 0', async () => {
    const existing: ConnectionState = {
      userId: USER,
      pos: 5,
      lastAccess: NOW,
      roomStates: {},
      listStates: { all: { roomIds: [], count: 0 } },
      initialSyncComplete: true,
    };
    const syncDo = createSyncDoStub({
      states: { default: existing },
      waitHasEvents: true,
    });
    const env = createEnv({
      syncDo,
      db: createSlidingDb({ maxStreamPos: 5, memberships: [] }),
    });
    const { status, body } = await postSync(MSC4186, env, {
      pos: '5',
      timeout: 5000,
      lists: { all: { range: [0, 0] } },
    });
    expect(status).toBe(200);
    expect(body.pos).toBe('5');
    expect(
      syncDo.fetches.some((f) => f.url.includes('/wait-for-events') && f.method === 'POST')
    ).toBe(true);
    const wait = syncDo.fetches.find((f) => f.url.includes('/wait-for-events'));
    expect((wait?.body as any).timeout).toBe(5000);
  });

  it('clamps timeout to 25s (query string preferred)', async () => {
    const existing: ConnectionState = {
      userId: USER,
      pos: 1,
      lastAccess: NOW,
      roomStates: {},
      listStates: {},
      initialSyncComplete: true,
    };
    const syncDo = createSyncDoStub({ states: { default: existing } });
    const env = createEnv({
      syncDo,
      db: createSlidingDb({ maxStreamPos: 1 }),
    });
    await postSync(
      V4,
      env,
      { pos: '1', timeout: 99999 },
      { query: 'timeout=60000' }
    );
    const wait = syncDo.fetches.find((f) => f.url.includes('/wait-for-events'));
    expect((wait?.body as any).timeout).toBe(25000);
  });

  it('swallows wait-for-events failures and still returns 200', async () => {
    const existing: ConnectionState = {
      userId: USER,
      pos: 3,
      lastAccess: NOW,
      roomStates: {},
      listStates: {},
      initialSyncComplete: true,
    };
    const syncDo = createSyncDoStub({
      states: { default: existing },
      waitFail: true,
    });
    const env = createEnv({
      syncDo,
      db: createSlidingDb({ maxStreamPos: 3 }),
    });
    const { status } = await postSync(MSC4186, env, { pos: '3', timeout: 1000 });
    expect(status).toBe(200);
  });

  it('does not wait when timeout is 0', async () => {
    const existing: ConnectionState = {
      userId: USER,
      pos: 3,
      lastAccess: NOW,
      roomStates: {},
      listStates: {},
      initialSyncComplete: true,
    };
    const syncDo = createSyncDoStub({ states: { default: existing } });
    const env = createEnv({
      syncDo,
      db: createSlidingDb({ maxStreamPos: 3 }),
    });
    await postSync(MSC4186, env, { pos: '3', timeout: 0 });
    expect(syncDo.fetches.some((f) => f.url.includes('/wait-for-events'))).toBe(false);
  });

  it('does not wait on initial sync (hasChanges)', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 9 }) });
    await postSync(MSC4186, env, { timeout: 5000 });
    expect(syncDo.fetches.some((f) => f.url.includes('/wait-for-events'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NSE detection path (logging only — exercises detectNSERequest via handler)
// ---------------------------------------------------------------------------

describe('MSC4186 — NSE request shape path', () => {
  it('accepts NSE-like single-room subscription with small timeline', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { status, body } = await postSync(
      MSC4186,
      env,
      {
        room_subscriptions: { [ROOM]: { timeline_limit: 3 } },
      },
      { headers: { 'User-Agent': 'ElementX-NSE/1.0 iOS' } }
    );
    expect(status).toBe(200);
    expect((body.rooms as any)[ROOM]).toBeTruthy();
  });

  it('accepts Element X main-app User-Agent with lists', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { status } = await postSync(
      V4,
      env,
      {
        lists: { all: { range: [0, 20], timeline_limit: 20 } },
        extensions: { to_device: {}, e2ee: {}, account_data: {}, typing: {}, receipts: {} },
      },
      { headers: { 'User-Agent': 'Element X iOS/25.01' } }
    );
    expect(status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Save failure tolerance + malformed content edges
// ---------------------------------------------------------------------------

describe('resilience and parse edges', () => {
  it('still returns 200 when connection state save fails', async () => {
    const syncDo = createSyncDoStub({ saveFail: true });
    const env = createEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 4 }) });
    const { status, body } = await postSync(MSC3575, env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('4');
  });

  it('tolerates malformed room name/avatar/topic JSON in metadata', async () => {
    const memberships: MembershipRow[] = [
      { room_id: ROOM, user_id: USER, membership: 'join' },
      { room_id: ROOM, user_id: BOB, membership: 'join' },
    ];
    const rooms: RoomMeta[] = [{ room_id: ROOM, created_at: NOW }];
    const events: EventRow[] = [
      makeEvent({
        event_id: '$bad-name',
        room_id: ROOM,
        event_type: 'm.room.name',
        state_key: '',
        content: '{not-json',
        stream_ordering: 1,
      }),
      makeEvent({
        event_id: '$msg',
        room_id: ROOM,
        event_type: 'm.room.message',
        content: '{bad',
        stream_ordering: 2,
      }),
    ];
    const state: StateRow[] = [
      { room_id: ROOM, event_type: 'm.room.name', state_key: '', event_id: '$bad-name' },
    ];
    const env = createEnv({
      db: createSlidingDb({ memberships, rooms, events, state }),
    });
    const { status, body } = await postSync(MSC3575, env, {
      lists: { all: { ranges: [[0, 0]], timeline_limit: 5 } },
    });
    expect(status).toBe(200);
    const room = (body.rooms as any)[ROOM];
    expect(room.name).toBeUndefined();
    // malformed timeline content becomes {}
    expect(room.timeline.some((e: any) => e.event_id === '$msg' && e.content)).toBe(true);
  });

  it('returns empty room shell when subscribed room row is missing from rooms table', async () => {
    const memberships: MembershipRow[] = [
      { room_id: ROOM, user_id: USER, membership: 'join' },
    ];
    const env = createEnv({
      db: createSlidingDb({ memberships, rooms: [], events: [] }),
    });
    const { body } = await postSync(MSC3575, env, {
      room_subscriptions: { [ROOM]: { timeline_limit: 5 } },
    });
    // getRoomData returns membership:join shell without metadata when room missing
    expect((body.rooms as any)[ROOM].membership).toBe('join');
    expect((body.rooms as any)[ROOM].timeline).toBeUndefined();
  });

  it('handles malformed fully_read JSON without throwing', async () => {
    const fx = fixtureJoinedRoom();
    const existing: ConnectionState = {
      userId: USER,
      pos: 8,
      lastAccess: NOW,
      roomStates: { [ROOM]: { sentState: true, lastStreamOrdering: 8 } },
      listStates: { all: { roomIds: [ROOM], count: 1 } },
      roomNotificationCounts: { [ROOM]: 0 },
      roomFullyReadMarkers: { [ROOM]: '$old' },
      roomSentAsRead: { [ROOM]: true },
      initialSyncComplete: true,
    };
    const syncDo = createSyncDoStub({ states: { default: existing } });
    const env = createEnv({
      syncDo,
      db: createSlidingDb({
        maxStreamPos: 8,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
        accountData: [
          {
            user_id: USER,
            room_id: ROOM,
            event_type: 'm.fully_read',
            content: 'not-json',
          },
        ],
      }),
    });
    const { status } = await postSync(MSC3575, env, {
      pos: '8',
      lists: { all: { ranges: [[0, 0]], timeline_limit: 1 } },
    });
    expect(status).toBe(200);
  });

  it('clears roomSentAsRead when notification_count becomes unread again', async () => {
    const fx = fixtureJoinedRoom();
    const existing: ConnectionState = {
      userId: USER,
      pos: 8,
      lastAccess: NOW,
      roomStates: { [ROOM]: { sentState: true, lastStreamOrdering: 8 } },
      listStates: { all: { roomIds: [ROOM], count: 1 } },
      roomNotificationCounts: { [ROOM]: 0 },
      roomSentAsRead: { [ROOM]: true },
      initialSyncComplete: true,
    };
    countNotificationsWithRules.mockResolvedValue({
      notification_count: 2,
      highlight_count: 1,
    });
    const syncDo = createSyncDoStub({ states: { default: existing } });
    const env = createEnv({
      syncDo,
      db: createSlidingDb({
        maxStreamPos: 8,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    await postSync(MSC3575, env, {
      pos: '8',
      lists: { all: { ranges: [[0, 0]], timeline_limit: 1 } },
    });
    expect(syncDo.saves[0].state.roomSentAsRead?.[ROOM]).toBeUndefined();
    expect(syncDo.saves[0].state.roomNotificationCounts?.[ROOM]).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Multi-list + multi-endpoint scale
// ---------------------------------------------------------------------------

describe('multi-list and cross-endpoint scale', () => {
  it('processes multiple lists independently on MSC3575', async () => {
    const joined = fixtureJoinedRoom();
    const invite = fixtureInviteRoom();
    const env = createEnv({
      db: createSlidingDb({
        memberships: [...joined.memberships, ...invite.memberships],
        rooms: [...joined.rooms, ...invite.rooms],
        events: [...joined.events, ...invite.events],
        state: [...joined.state, ...invite.state],
      }),
    });
    const { body } = await postSync(MSC3575, env, {
      lists: {
        joins: { ranges: [[0, 50]], filters: { is_dm: false }, timeline_limit: 2 },
        invites: { ranges: [[0, 10]], filters: { is_invite: true }, timeline_limit: 1 },
      },
    });
    expect((body.lists as any).joins.ops[0].room_ids).toContain(ROOM);
    expect((body.lists as any).invites.ops[0].room_ids).toEqual([INVITE_ROOM]);
    expect((body.rooms as any)[ROOM]).toBeTruthy();
    expect((body.rooms as any)[INVITE_ROOM].membership).toBe('invite');
  });

  it('MSC3575 with all extensions combined', async () => {
    getToDeviceMessages.mockResolvedValue({
      events: [{ type: 'm.dummy', content: {}, sender: BOB }],
      nextBatch: '9',
    });
    getTypingForRooms.mockResolvedValue({ [ROOM]: [] });
    getReceiptsForRooms.mockResolvedValue({ [ROOM]: {} });
    getE2EEAccountDataFromDO.mockResolvedValue({ 'm.megolm_backup.v1': { v: 1 } });
    const fx = fixtureJoinedRoom();
    const cache = mockKv({
      [`presence:${BOB}`]: JSON.stringify({ presence: 'online' }),
    });
    const env = createEnv({
      cache,
      db: createSlidingDb({
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
        otkCounts: [{ algorithm: 'signed_curve25519', count: 1 }],
        fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
        accountData: [
          {
            user_id: USER,
            room_id: '',
            event_type: 'm.push_rules',
            content: JSON.stringify({}),
          },
        ],
      }),
    });
    const { status, body } = await postSync(MSC3575, env, {
      txn_id: 'combo',
      lists: { all: { ranges: [[0, 0]], timeline_limit: 5 } },
      room_subscriptions: { [ROOM]: { timeline_limit: 5 } },
      extensions: {
        to_device: {},
        e2ee: {},
        account_data: {},
        typing: {},
        receipts: {},
        presence: {},
      },
    });
    expect(status).toBe(200);
    expect(body.txn_id).toBe('combo');
    const ext = body.extensions as any;
    expect(ext.to_device.events).toHaveLength(1);
    expect(ext.e2ee.device_one_time_keys_count.signed_curve25519).toBe(1);
    expect(ext.account_data.global.some((e: any) => e.type === 'm.megolm_backup.v1')).toBe(
      true
    );
    expect(ext.typing.rooms[ROOM]).toBeTruthy();
    expect(ext.receipts.rooms[ROOM]).toBeTruthy();
    expect(ext.presence.events.length).toBeGreaterThanOrEqual(1);
  });

  it('MSC4186 with lists + subscriptions + extensions + timeout no-wait on changes', async () => {
    const fx = fixtureJoinedRoom();
    const syncDo = createSyncDoStub();
    const env = createEnv({
      syncDo,
      db: createSlidingDb({
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
        otkCounts: [{ algorithm: 'signed_curve25519', count: 4 }],
      }),
    });
    const { status, body } = await postSync(V4, env, {
      timeout: 10000,
      lists: { all: { range: [0, 10], timeline_limit: 3 } },
      room_subscriptions: { [ROOM]: { timeline_limit: 3 } },
      extensions: { to_device: {}, e2ee: {}, account_data: {}, receipts: {} },
    });
    expect(status).toBe(200);
    expect((body.rooms as any)[ROOM]).toBeTruthy();
    expect(syncDo.fetches.some((f) => f.url.includes('/wait-for-events'))).toBe(false);
  });

  it('scales to many joined rooms in a list range', async () => {
    const memberships: MembershipRow[] = [];
    const rooms: RoomMeta[] = [];
    const events: EventRow[] = [];
    for (let i = 0; i < 25; i++) {
      const id = `!scale${i}:example.com`;
      memberships.push(
        { room_id: id, user_id: USER, membership: 'join' },
        { room_id: id, user_id: BOB, membership: 'join' }
      );
      rooms.push({ room_id: id, created_at: NOW - i, name: `Room ${i}` });
      events.push(
        makeEvent({
          event_id: `$s${i}`,
          room_id: id,
          event_type: 'm.room.message',
          stream_ordering: i + 1,
          origin_server_ts: NOW - i,
        })
      );
    }
    const env = createEnv({
      db: createSlidingDb({ memberships, rooms, events, maxStreamPos: 25 }),
    });
    const { body } = await postSync(MSC3575, env, {
      lists: { all: { ranges: [[0, 9]], timeline_limit: 1 } },
    });
    expect((body.lists as any).all.count).toBe(25);
    expect((body.lists as any).all.ops[0].room_ids).toHaveLength(10);
    expect(Object.keys(body.rooms as object).length).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// required_state wildcard / empty-key edges
// ---------------------------------------------------------------------------

describe('required_state query shapes', () => {
  it('supports wildcard * / * required_state (needsAll path)', async () => {
    const fx = fixtureJoinedRoom();
    fx.events.push(
      makeEvent({
        event_id: '$topic',
        room_id: ROOM,
        event_type: 'm.room.topic',
        state_key: '',
        content: JSON.stringify({ topic: 't' }),
        stream_ordering: 3,
      })
    );
    fx.state.push({
      room_id: ROOM,
      event_type: 'm.room.topic',
      state_key: '',
      event_id: '$topic',
    });
    const env = createEnv({
      db: createSlidingDb({
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { body } = await postSync(MSC3575, env, {
      lists: {
        all: {
          ranges: [[0, 0]],
          timeline_limit: 1,
          required_state: [['*', '*']],
        },
      },
    });
    const required = (body.rooms as any)[ROOM].required_state as any[];
    expect(required.length).toBeGreaterThanOrEqual(1);
  });

  it('dedupes required_state by event_id', async () => {
    const fx = fixtureJoinedRoom();
    // Same event referenced twice in state table shouldn't duplicate in response
    // (seenIds set). Our mock returns unique state rows; ensure length stable.
    const env = createEnv({
      db: createSlidingDb({
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { body } = await postSync(MSC4186, env, {
      room_subscriptions: {
        [ROOM]: {
          timeline_limit: 1,
          required_state: [
            ['m.room.name', ''],
            ['m.room.name', ''],
          ],
        },
      },
    });
    const required = (body.rooms as any)[ROOM].required_state as any[];
    const nameEvents = required.filter((e) => e.type === 'm.room.name');
    expect(nameEvents.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tombstone filter + invite always-include on reconnect
// ---------------------------------------------------------------------------

describe('tombstone filter and invite reconnect', () => {
  it('filters is_tombstoned rooms via EXISTS tombstone state', async () => {
    const live = fixtureJoinedRoom({ room_id: ROOM, name: 'Live' });
    const dead = fixtureJoinedRoom({ room_id: ROOM2, name: 'Dead' });
    dead.state.push({
      room_id: ROOM2,
      event_type: 'm.room.tombstone',
      state_key: '',
      event_id: '$tomb',
    });
    dead.events.push(
      makeEvent({
        event_id: '$tomb',
        room_id: ROOM2,
        event_type: 'm.room.tombstone',
        state_key: '',
        content: JSON.stringify({ body: 'replaced' }),
        stream_ordering: 99,
      })
    );
    const env = createEnv({
      db: createSlidingDb({
        memberships: [...live.memberships, ...dead.memberships],
        rooms: [...live.rooms, ...dead.rooms],
        events: [...live.events, ...dead.events],
        state: [...live.state, ...dead.state],
      }),
    });
    const { body } = await postSync(MSC3575, env, {
      lists: {
        dead: { ranges: [[0, 9]], filters: { is_tombstoned: true }, timeline_limit: 1 },
      },
    });
    expect((body.lists as any).dead.ops[0].room_ids).toEqual([ROOM2]);
  });

  it('always re-sends invite rooms even when already sentState', async () => {
    const invite = fixtureInviteRoom();
    const existing: ConnectionState = {
      userId: USER,
      pos: 3,
      lastAccess: NOW,
      roomStates: {
        [INVITE_ROOM]: { sentState: true, lastStreamOrdering: 0 },
      },
      listStates: { invites: { roomIds: [INVITE_ROOM], count: 1 } },
      initialSyncComplete: true,
    };
    const syncDo = createSyncDoStub({ states: { default: existing } });
    const env = createEnv({
      syncDo,
      db: createSlidingDb({
        maxStreamPos: 3,
        memberships: invite.memberships,
        rooms: invite.rooms,
        events: invite.events,
        state: invite.state,
      }),
    });
    const { body } = await postSync(MSC3575, env, {
      pos: '3',
      lists: {
        invites: { ranges: [[0, 0]], filters: { is_invite: true }, timeline_limit: 1 },
      },
    });
    expect((body.rooms as any)[INVITE_ROOM].membership).toBe('invite');
  });
});
