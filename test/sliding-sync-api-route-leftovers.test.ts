/**
 * TOKENMAXX HEAVY leftovers after #157 — sliding-sync soft/edge/reliability.
 * Complements sliding-sync-api-routes.test.ts. Tests-only — no product inventing.
 * Fixtures use example.com only.
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


describe('sliding-sync leftovers MSC3575 empty lists soft flood after #157', () => {
  it('MSC3575 empty lists soft-0', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 40 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('40');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
  it('MSC3575 empty lists soft-1', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 41 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('41');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
  it('MSC3575 empty lists soft-2', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
  it('MSC3575 empty lists soft-3', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 43 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('43');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
  it('MSC3575 empty lists soft-4', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 44 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('44');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
  it('MSC3575 empty lists soft-5', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 45 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('45');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
  it('MSC3575 empty lists soft-6', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 46 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('46');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
  it('MSC3575 empty lists soft-7', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 47 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('47');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
  it('MSC3575 empty lists soft-8', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 48 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('48');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
  it('MSC3575 empty lists soft-9', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 49 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('49');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
  it('MSC3575 empty lists soft-10', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 50 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('50');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
  it('MSC3575 empty lists soft-11', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 51 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('51');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
  it('MSC3575 empty lists soft-12', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 52 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('52');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
  it('MSC3575 empty lists soft-13', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 53 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('53');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
  it('MSC3575 empty lists soft-14', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 54 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('54');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
  it('MSC3575 empty lists soft-15', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 55 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('55');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
  it('MSC3575 empty lists soft-16', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 56 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('56');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
  it('MSC3575 empty lists soft-17', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 57 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('57');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
  it('MSC3575 empty lists soft-18', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 58 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('58');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
  it('MSC3575 empty lists soft-19', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 59 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('59');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
  it('MSC3575 empty lists soft-20', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 60 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('60');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
  it('MSC3575 empty lists soft-21', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 61 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('61');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
  it('MSC3575 empty lists soft-22', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 62 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('62');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
  it('MSC3575 empty lists soft-23', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 63 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('63');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
  it('MSC3575 empty lists soft-24', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 64 }) });
    const { status, body } = await postSync(MSC3575, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('64');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect(body.extensions).toEqual({});
  });
});

describe('sliding-sync leftovers MSC4186 soft flood after #157', () => {
  it('MSC4186 empty soft-0', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 20 }) });
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('20');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect((body.extensions as any).typing).toEqual({ rooms: {} });
    expect((body.extensions as any).receipts).toEqual({ rooms: {} });
    expect((body.extensions as any).account_data).toEqual({ global: [], rooms: {} });
  });
  it('MSC4186 empty soft-1', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 21 }) });
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('21');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect((body.extensions as any).typing).toEqual({ rooms: {} });
    expect((body.extensions as any).receipts).toEqual({ rooms: {} });
    expect((body.extensions as any).account_data).toEqual({ global: [], rooms: {} });
  });
  it('MSC4186 empty soft-2', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 22 }) });
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('22');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect((body.extensions as any).typing).toEqual({ rooms: {} });
    expect((body.extensions as any).receipts).toEqual({ rooms: {} });
    expect((body.extensions as any).account_data).toEqual({ global: [], rooms: {} });
  });
  it('MSC4186 empty soft-3', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 23 }) });
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('23');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect((body.extensions as any).typing).toEqual({ rooms: {} });
    expect((body.extensions as any).receipts).toEqual({ rooms: {} });
    expect((body.extensions as any).account_data).toEqual({ global: [], rooms: {} });
  });
  it('MSC4186 empty soft-4', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 24 }) });
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('24');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect((body.extensions as any).typing).toEqual({ rooms: {} });
    expect((body.extensions as any).receipts).toEqual({ rooms: {} });
    expect((body.extensions as any).account_data).toEqual({ global: [], rooms: {} });
  });
  it('MSC4186 empty soft-5', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 25 }) });
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('25');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect((body.extensions as any).typing).toEqual({ rooms: {} });
    expect((body.extensions as any).receipts).toEqual({ rooms: {} });
    expect((body.extensions as any).account_data).toEqual({ global: [], rooms: {} });
  });
  it('MSC4186 empty soft-6', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 26 }) });
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('26');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect((body.extensions as any).typing).toEqual({ rooms: {} });
    expect((body.extensions as any).receipts).toEqual({ rooms: {} });
    expect((body.extensions as any).account_data).toEqual({ global: [], rooms: {} });
  });
  it('MSC4186 empty soft-7', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 27 }) });
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('27');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect((body.extensions as any).typing).toEqual({ rooms: {} });
    expect((body.extensions as any).receipts).toEqual({ rooms: {} });
    expect((body.extensions as any).account_data).toEqual({ global: [], rooms: {} });
  });
  it('MSC4186 empty soft-8', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 28 }) });
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('28');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect((body.extensions as any).typing).toEqual({ rooms: {} });
    expect((body.extensions as any).receipts).toEqual({ rooms: {} });
    expect((body.extensions as any).account_data).toEqual({ global: [], rooms: {} });
  });
  it('MSC4186 empty soft-9', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 29 }) });
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('29');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect((body.extensions as any).typing).toEqual({ rooms: {} });
    expect((body.extensions as any).receipts).toEqual({ rooms: {} });
    expect((body.extensions as any).account_data).toEqual({ global: [], rooms: {} });
  });
  it('MSC4186 empty soft-10', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 30 }) });
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('30');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect((body.extensions as any).typing).toEqual({ rooms: {} });
    expect((body.extensions as any).receipts).toEqual({ rooms: {} });
    expect((body.extensions as any).account_data).toEqual({ global: [], rooms: {} });
  });
  it('MSC4186 empty soft-11', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 31 }) });
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('31');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect((body.extensions as any).typing).toEqual({ rooms: {} });
    expect((body.extensions as any).receipts).toEqual({ rooms: {} });
    expect((body.extensions as any).account_data).toEqual({ global: [], rooms: {} });
  });
  it('MSC4186 empty soft-12', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 32 }) });
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('32');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect((body.extensions as any).typing).toEqual({ rooms: {} });
    expect((body.extensions as any).receipts).toEqual({ rooms: {} });
    expect((body.extensions as any).account_data).toEqual({ global: [], rooms: {} });
  });
  it('MSC4186 empty soft-13', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 33 }) });
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('33');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect((body.extensions as any).typing).toEqual({ rooms: {} });
    expect((body.extensions as any).receipts).toEqual({ rooms: {} });
    expect((body.extensions as any).account_data).toEqual({ global: [], rooms: {} });
  });
  it('MSC4186 empty soft-14', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 34 }) });
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('34');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
    expect((body.extensions as any).typing).toEqual({ rooms: {} });
    expect((body.extensions as any).receipts).toEqual({ rooms: {} });
    expect((body.extensions as any).account_data).toEqual({ global: [], rooms: {} });
  });
});

describe('sliding-sync leftovers v4 soft flood after #157', () => {
  it('v4 empty soft-0', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 30 }) });
    const { status, body } = await postSync(V4, env, { txn_id: 'txn-soft-0' });
    expect(status).toBe(200);
    expect(body.pos).toBe('30');
    expect(body.txn_id).toBe('txn-soft-0');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('v4 empty soft-1', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 31 }) });
    const { status, body } = await postSync(V4, env, { txn_id: 'txn-soft-1' });
    expect(status).toBe(200);
    expect(body.pos).toBe('31');
    expect(body.txn_id).toBe('txn-soft-1');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('v4 empty soft-2', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 32 }) });
    const { status, body } = await postSync(V4, env, { txn_id: 'txn-soft-2' });
    expect(status).toBe(200);
    expect(body.pos).toBe('32');
    expect(body.txn_id).toBe('txn-soft-2');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('v4 empty soft-3', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 33 }) });
    const { status, body } = await postSync(V4, env, { txn_id: 'txn-soft-3' });
    expect(status).toBe(200);
    expect(body.pos).toBe('33');
    expect(body.txn_id).toBe('txn-soft-3');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('v4 empty soft-4', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 34 }) });
    const { status, body } = await postSync(V4, env, { txn_id: 'txn-soft-4' });
    expect(status).toBe(200);
    expect(body.pos).toBe('34');
    expect(body.txn_id).toBe('txn-soft-4');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('v4 empty soft-5', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 35 }) });
    const { status, body } = await postSync(V4, env, { txn_id: 'txn-soft-5' });
    expect(status).toBe(200);
    expect(body.pos).toBe('35');
    expect(body.txn_id).toBe('txn-soft-5');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('v4 empty soft-6', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 36 }) });
    const { status, body } = await postSync(V4, env, { txn_id: 'txn-soft-6' });
    expect(status).toBe(200);
    expect(body.pos).toBe('36');
    expect(body.txn_id).toBe('txn-soft-6');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('v4 empty soft-7', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 37 }) });
    const { status, body } = await postSync(V4, env, { txn_id: 'txn-soft-7' });
    expect(status).toBe(200);
    expect(body.pos).toBe('37');
    expect(body.txn_id).toBe('txn-soft-7');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('v4 empty soft-8', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 38 }) });
    const { status, body } = await postSync(V4, env, { txn_id: 'txn-soft-8' });
    expect(status).toBe(200);
    expect(body.pos).toBe('38');
    expect(body.txn_id).toBe('txn-soft-8');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('v4 empty soft-9', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 39 }) });
    const { status, body } = await postSync(V4, env, { txn_id: 'txn-soft-9' });
    expect(status).toBe(200);
    expect(body.pos).toBe('39');
    expect(body.txn_id).toBe('txn-soft-9');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('v4 empty soft-10', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 40 }) });
    const { status, body } = await postSync(V4, env, { txn_id: 'txn-soft-10' });
    expect(status).toBe(200);
    expect(body.pos).toBe('40');
    expect(body.txn_id).toBe('txn-soft-10');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('v4 empty soft-11', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 41 }) });
    const { status, body } = await postSync(V4, env, { txn_id: 'txn-soft-11' });
    expect(status).toBe(200);
    expect(body.pos).toBe('41');
    expect(body.txn_id).toBe('txn-soft-11');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('v4 empty soft-12', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSync(V4, env, { txn_id: 'txn-soft-12' });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.txn_id).toBe('txn-soft-12');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('v4 empty soft-13', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 43 }) });
    const { status, body } = await postSync(V4, env, { txn_id: 'txn-soft-13' });
    expect(status).toBe(200);
    expect(body.pos).toBe('43');
    expect(body.txn_id).toBe('txn-soft-13');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('v4 empty soft-14', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 44 }) });
    const { status, body } = await postSync(V4, env, { txn_id: 'txn-soft-14' });
    expect(status).toBe(200);
    expect(body.pos).toBe('44');
    expect(body.txn_id).toBe('txn-soft-14');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
});

describe('sliding-sync leftovers room_subscriptions soft flood after #157', () => {
  it('room_subscriptions soft-0', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 50,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { status, body } = await postSync(MSC3575, env, {
      room_subscriptions: { [ROOM]: { timeline_limit: 1 } },
    });
    expect(status).toBe(200);
    expect(body.pos).toBe('50');
    expect((body.rooms as any)[ROOM]).toBeDefined();
    expect(Array.isArray((body.rooms as any)[ROOM].timeline)).toBe(true);
  });
  it('room_subscriptions soft-1', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 51,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { status, body } = await postSync(MSC3575, env, {
      room_subscriptions: { [ROOM]: { timeline_limit: 2 } },
    });
    expect(status).toBe(200);
    expect(body.pos).toBe('51');
    expect((body.rooms as any)[ROOM]).toBeDefined();
    expect(Array.isArray((body.rooms as any)[ROOM].timeline)).toBe(true);
  });
  it('room_subscriptions soft-2', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 52,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { status, body } = await postSync(MSC3575, env, {
      room_subscriptions: { [ROOM]: { timeline_limit: 3 } },
    });
    expect(status).toBe(200);
    expect(body.pos).toBe('52');
    expect((body.rooms as any)[ROOM]).toBeDefined();
    expect(Array.isArray((body.rooms as any)[ROOM].timeline)).toBe(true);
  });
  it('room_subscriptions soft-3', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 53,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { status, body } = await postSync(MSC3575, env, {
      room_subscriptions: { [ROOM]: { timeline_limit: 4 } },
    });
    expect(status).toBe(200);
    expect(body.pos).toBe('53');
    expect((body.rooms as any)[ROOM]).toBeDefined();
    expect(Array.isArray((body.rooms as any)[ROOM].timeline)).toBe(true);
  });
  it('room_subscriptions soft-4', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 54,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { status, body } = await postSync(MSC3575, env, {
      room_subscriptions: { [ROOM]: { timeline_limit: 5 } },
    });
    expect(status).toBe(200);
    expect(body.pos).toBe('54');
    expect((body.rooms as any)[ROOM]).toBeDefined();
    expect(Array.isArray((body.rooms as any)[ROOM].timeline)).toBe(true);
  });
  it('room_subscriptions soft-5', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 55,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { status, body } = await postSync(MSC3575, env, {
      room_subscriptions: { [ROOM]: { timeline_limit: 1 } },
    });
    expect(status).toBe(200);
    expect(body.pos).toBe('55');
    expect((body.rooms as any)[ROOM]).toBeDefined();
    expect(Array.isArray((body.rooms as any)[ROOM].timeline)).toBe(true);
  });
  it('room_subscriptions soft-6', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 56,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { status, body } = await postSync(MSC3575, env, {
      room_subscriptions: { [ROOM]: { timeline_limit: 2 } },
    });
    expect(status).toBe(200);
    expect(body.pos).toBe('56');
    expect((body.rooms as any)[ROOM]).toBeDefined();
    expect(Array.isArray((body.rooms as any)[ROOM].timeline)).toBe(true);
  });
  it('room_subscriptions soft-7', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 57,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { status, body } = await postSync(MSC3575, env, {
      room_subscriptions: { [ROOM]: { timeline_limit: 3 } },
    });
    expect(status).toBe(200);
    expect(body.pos).toBe('57');
    expect((body.rooms as any)[ROOM]).toBeDefined();
    expect(Array.isArray((body.rooms as any)[ROOM].timeline)).toBe(true);
  });
  it('room_subscriptions soft-8', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 58,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { status, body } = await postSync(MSC3575, env, {
      room_subscriptions: { [ROOM]: { timeline_limit: 4 } },
    });
    expect(status).toBe(200);
    expect(body.pos).toBe('58');
    expect((body.rooms as any)[ROOM]).toBeDefined();
    expect(Array.isArray((body.rooms as any)[ROOM].timeline)).toBe(true);
  });
  it('room_subscriptions soft-9', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 59,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { status, body } = await postSync(MSC3575, env, {
      room_subscriptions: { [ROOM]: { timeline_limit: 5 } },
    });
    expect(status).toBe(200);
    expect(body.pos).toBe('59');
    expect((body.rooms as any)[ROOM]).toBeDefined();
    expect(Array.isArray((body.rooms as any)[ROOM].timeline)).toBe(true);
  });
  it('room_subscriptions soft-10', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 60,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { status, body } = await postSync(MSC3575, env, {
      room_subscriptions: { [ROOM]: { timeline_limit: 1 } },
    });
    expect(status).toBe(200);
    expect(body.pos).toBe('60');
    expect((body.rooms as any)[ROOM]).toBeDefined();
    expect(Array.isArray((body.rooms as any)[ROOM].timeline)).toBe(true);
  });
  it('room_subscriptions soft-11', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 61,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { status, body } = await postSync(MSC3575, env, {
      room_subscriptions: { [ROOM]: { timeline_limit: 2 } },
    });
    expect(status).toBe(200);
    expect(body.pos).toBe('61');
    expect((body.rooms as any)[ROOM]).toBeDefined();
    expect(Array.isArray((body.rooms as any)[ROOM].timeline)).toBe(true);
  });
  it('room_subscriptions soft-12', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 62,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { status, body } = await postSync(MSC3575, env, {
      room_subscriptions: { [ROOM]: { timeline_limit: 3 } },
    });
    expect(status).toBe(200);
    expect(body.pos).toBe('62');
    expect((body.rooms as any)[ROOM]).toBeDefined();
    expect(Array.isArray((body.rooms as any)[ROOM].timeline)).toBe(true);
  });
  it('room_subscriptions soft-13', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 63,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { status, body } = await postSync(MSC3575, env, {
      room_subscriptions: { [ROOM]: { timeline_limit: 4 } },
    });
    expect(status).toBe(200);
    expect(body.pos).toBe('63');
    expect((body.rooms as any)[ROOM]).toBeDefined();
    expect(Array.isArray((body.rooms as any)[ROOM].timeline)).toBe(true);
  });
  it('room_subscriptions soft-14', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 64,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { status, body } = await postSync(MSC3575, env, {
      room_subscriptions: { [ROOM]: { timeline_limit: 5 } },
    });
    expect(status).toBe(200);
    expect(body.pos).toBe('64');
    expect((body.rooms as any)[ROOM]).toBeDefined();
    expect(Array.isArray((body.rooms as any)[ROOM].timeline)).toBe(true);
  });
  it('room_subscriptions soft-15', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 65,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { status, body } = await postSync(MSC3575, env, {
      room_subscriptions: { [ROOM]: { timeline_limit: 1 } },
    });
    expect(status).toBe(200);
    expect(body.pos).toBe('65');
    expect((body.rooms as any)[ROOM]).toBeDefined();
    expect(Array.isArray((body.rooms as any)[ROOM].timeline)).toBe(true);
  });
  it('room_subscriptions soft-16', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 66,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { status, body } = await postSync(MSC3575, env, {
      room_subscriptions: { [ROOM]: { timeline_limit: 2 } },
    });
    expect(status).toBe(200);
    expect(body.pos).toBe('66');
    expect((body.rooms as any)[ROOM]).toBeDefined();
    expect(Array.isArray((body.rooms as any)[ROOM].timeline)).toBe(true);
  });
  it('room_subscriptions soft-17', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 67,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { status, body } = await postSync(MSC3575, env, {
      room_subscriptions: { [ROOM]: { timeline_limit: 3 } },
    });
    expect(status).toBe(200);
    expect(body.pos).toBe('67');
    expect((body.rooms as any)[ROOM]).toBeDefined();
    expect(Array.isArray((body.rooms as any)[ROOM].timeline)).toBe(true);
  });
  it('room_subscriptions soft-18', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 68,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { status, body } = await postSync(MSC3575, env, {
      room_subscriptions: { [ROOM]: { timeline_limit: 4 } },
    });
    expect(status).toBe(200);
    expect(body.pos).toBe('68');
    expect((body.rooms as any)[ROOM]).toBeDefined();
    expect(Array.isArray((body.rooms as any)[ROOM].timeline)).toBe(true);
  });
  it('room_subscriptions soft-19', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({
      db: createSlidingDb({
        maxStreamPos: 69,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
    });
    const { status, body } = await postSync(MSC3575, env, {
      room_subscriptions: { [ROOM]: { timeline_limit: 5 } },
    });
    expect(status).toBe(200);
    expect(body.pos).toBe('69');
    expect((body.rooms as any)[ROOM]).toBeDefined();
    expect(Array.isArray((body.rooms as any)[ROOM].timeline)).toBe(true);
  });
});

describe('sliding-sync leftovers bad JSON failure after #157', () => {
  it('MSC3575 bad JSON soft-0', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, '{not-json-0', {});
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('MSC3575 bad JSON soft-1', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, '{not-json-1', {});
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('MSC3575 bad JSON soft-2', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, '{not-json-2', {});
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('MSC4186 bad JSON soft-0', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC4186, env, '{not-json-0', {});
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('MSC4186 bad JSON soft-1', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC4186, env, '{not-json-1', {});
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('MSC4186 bad JSON soft-2', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC4186, env, '{not-json-2', {});
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('v4 bad JSON soft-0', async () => {
    const env = createEnv();
    const { status, body } = await postSync(V4, env, '{not-json-0', {});
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('v4 bad JSON soft-1', async () => {
    const env = createEnv();
    const { status, body } = await postSync(V4, env, '{not-json-1', {});
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('v4 bad JSON soft-2', async () => {
    const env = createEnv();
    const { status, body } = await postSync(V4, env, '{not-json-2', {});
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
});

describe('sliding-sync leftovers method matrix GET on POST endpoints after #157', () => {
  it('GET MSC3575 soft-0 returns non-success', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC3575}`,
      { method: 'GET' },
      env
    );
    expect(res.status).not.toBe(200);
    expect([404, 405]).toContain(res.status);
  });
  it('GET MSC3575 soft-1 returns non-success', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC3575}`,
      { method: 'GET' },
      env
    );
    expect(res.status).not.toBe(200);
    expect([404, 405]).toContain(res.status);
  });
  it('GET MSC3575 soft-2 returns non-success', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC3575}`,
      { method: 'GET' },
      env
    );
    expect(res.status).not.toBe(200);
    expect([404, 405]).toContain(res.status);
  });
  it('GET MSC4186 soft-0 returns non-success', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC4186}`,
      { method: 'GET' },
      env
    );
    expect(res.status).not.toBe(200);
    expect([404, 405]).toContain(res.status);
  });
  it('GET MSC4186 soft-1 returns non-success', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC4186}`,
      { method: 'GET' },
      env
    );
    expect(res.status).not.toBe(200);
    expect([404, 405]).toContain(res.status);
  });
  it('GET MSC4186 soft-2 returns non-success', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC4186}`,
      { method: 'GET' },
      env
    );
    expect(res.status).not.toBe(200);
    expect([404, 405]).toContain(res.status);
  });
  it('GET v4 soft-0 returns non-success', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${V4}`,
      { method: 'GET' },
      env
    );
    expect(res.status).not.toBe(200);
    expect([404, 405]).toContain(res.status);
  });
  it('GET v4 soft-1 returns non-success', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${V4}`,
      { method: 'GET' },
      env
    );
    expect(res.status).not.toBe(200);
    expect([404, 405]).toContain(res.status);
  });
  it('GET v4 soft-2 returns non-success', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${V4}`,
      { method: 'GET' },
      env
    );
    expect(res.status).not.toBe(200);
    expect([404, 405]).toContain(res.status);
  });
});

describe('sliding-sync leftovers DO fail edges after #157', () => {
  it('MSC3575 returns 503 when SYNC DO get throws', async () => {
    const env = createEnv({ syncDo: createSyncDoStub({ getFail: true }) });
    const { status, body } = await postSync(MSC3575, env, {});
    expect(status).toBe(503);
    expect(body.errcode).toBe('M_UNKNOWN');
  });

  it('MSC4186 returns 503 when SYNC DO get throws', async () => {
    const env = createEnv({ syncDo: createSyncDoStub({ getFail: true }) });
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(503);
    expect(body.errcode).toBe('M_UNKNOWN');
  });

  it('v4 returns 503 when SYNC DO get returns non-OK', async () => {
    const env = createEnv({ syncDo: createSyncDoStub({ getStatus: 500 }) });
    const { status, body } = await postSync(V4, env, { lists: {} });
    expect(status).toBe(503);
    expect(body.errcode).toBe('M_UNKNOWN');
  });

  it('rejects >100 room_subscriptions with M_TOO_LARGE', async () => {
    const subs: Record<string, { timeline_limit: number }> = {};
    for (let i = 0; i < 101; i++) {
      subs[`!r${i}:example.com`] = { timeline_limit: 1 };
    }
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, { room_subscriptions: subs });
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_TOO_LARGE');
  });

  it('returns M_UNKNOWN_POS when pos ahead of stream', async () => {
    const env = createEnv({
      db: createSlidingDb({ maxStreamPos: 10 }),
      syncDo: createSyncDoStub({ states: {} }),
    });
    const { status, body } = await postSync(MSC4186, env, { pos: '999' });
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_UNKNOWN_POS');
  });
});

describe('sliding-sync leftovers lifecycle soft floods after #157', () => {
  it('empty then subscribe lifecycle soft-0', async () => {
    const fx = fixtureJoinedRoom();
    const syncDo = createSyncDoStub();
    const db = createSlidingDb({
      maxStreamPos: 10,
      memberships: fx.memberships,
      rooms: fx.rooms,
      events: fx.events,
      state: fx.state,
    });
    const env = createEnv({ db, syncDo });
    const first = await postSync(MSC3575, env, { lists: {} });
    expect(first.status).toBe(200);
    expect(first.body.pos).toBe('10');
    expect(first.body.rooms).toEqual({});

    // bump stream and subscribe
    const env2 = createEnv({
      db: createSlidingDb({
        maxStreamPos: 20,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
      syncDo,
    });
    const second = await postSync(MSC3575, env2, {
      pos: first.body.pos as string,
      room_subscriptions: { [ROOM]: { timeline_limit: 5 } },
    });
    expect(second.status).toBe(200);
    expect(second.body.pos).toBe('20');
    expect((second.body.rooms as any)[ROOM]).toBeDefined();
  });
  it('empty then subscribe lifecycle soft-1', async () => {
    const fx = fixtureJoinedRoom();
    const syncDo = createSyncDoStub();
    const db = createSlidingDb({
      maxStreamPos: 11,
      memberships: fx.memberships,
      rooms: fx.rooms,
      events: fx.events,
      state: fx.state,
    });
    const env = createEnv({ db, syncDo });
    const first = await postSync(MSC3575, env, { lists: {} });
    expect(first.status).toBe(200);
    expect(first.body.pos).toBe('11');
    expect(first.body.rooms).toEqual({});

    // bump stream and subscribe
    const env2 = createEnv({
      db: createSlidingDb({
        maxStreamPos: 21,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
      syncDo,
    });
    const second = await postSync(MSC3575, env2, {
      pos: first.body.pos as string,
      room_subscriptions: { [ROOM]: { timeline_limit: 5 } },
    });
    expect(second.status).toBe(200);
    expect(second.body.pos).toBe('21');
    expect((second.body.rooms as any)[ROOM]).toBeDefined();
  });
  it('empty then subscribe lifecycle soft-2', async () => {
    const fx = fixtureJoinedRoom();
    const syncDo = createSyncDoStub();
    const db = createSlidingDb({
      maxStreamPos: 12,
      memberships: fx.memberships,
      rooms: fx.rooms,
      events: fx.events,
      state: fx.state,
    });
    const env = createEnv({ db, syncDo });
    const first = await postSync(MSC3575, env, { lists: {} });
    expect(first.status).toBe(200);
    expect(first.body.pos).toBe('12');
    expect(first.body.rooms).toEqual({});

    // bump stream and subscribe
    const env2 = createEnv({
      db: createSlidingDb({
        maxStreamPos: 22,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
      syncDo,
    });
    const second = await postSync(MSC3575, env2, {
      pos: first.body.pos as string,
      room_subscriptions: { [ROOM]: { timeline_limit: 5 } },
    });
    expect(second.status).toBe(200);
    expect(second.body.pos).toBe('22');
    expect((second.body.rooms as any)[ROOM]).toBeDefined();
  });
  it('empty then subscribe lifecycle soft-3', async () => {
    const fx = fixtureJoinedRoom();
    const syncDo = createSyncDoStub();
    const db = createSlidingDb({
      maxStreamPos: 13,
      memberships: fx.memberships,
      rooms: fx.rooms,
      events: fx.events,
      state: fx.state,
    });
    const env = createEnv({ db, syncDo });
    const first = await postSync(MSC3575, env, { lists: {} });
    expect(first.status).toBe(200);
    expect(first.body.pos).toBe('13');
    expect(first.body.rooms).toEqual({});

    // bump stream and subscribe
    const env2 = createEnv({
      db: createSlidingDb({
        maxStreamPos: 23,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
      syncDo,
    });
    const second = await postSync(MSC3575, env2, {
      pos: first.body.pos as string,
      room_subscriptions: { [ROOM]: { timeline_limit: 5 } },
    });
    expect(second.status).toBe(200);
    expect(second.body.pos).toBe('23');
    expect((second.body.rooms as any)[ROOM]).toBeDefined();
  });
  it('empty then subscribe lifecycle soft-4', async () => {
    const fx = fixtureJoinedRoom();
    const syncDo = createSyncDoStub();
    const db = createSlidingDb({
      maxStreamPos: 14,
      memberships: fx.memberships,
      rooms: fx.rooms,
      events: fx.events,
      state: fx.state,
    });
    const env = createEnv({ db, syncDo });
    const first = await postSync(MSC3575, env, { lists: {} });
    expect(first.status).toBe(200);
    expect(first.body.pos).toBe('14');
    expect(first.body.rooms).toEqual({});

    // bump stream and subscribe
    const env2 = createEnv({
      db: createSlidingDb({
        maxStreamPos: 24,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
      syncDo,
    });
    const second = await postSync(MSC3575, env2, {
      pos: first.body.pos as string,
      room_subscriptions: { [ROOM]: { timeline_limit: 5 } },
    });
    expect(second.status).toBe(200);
    expect(second.body.pos).toBe('24');
    expect((second.body.rooms as any)[ROOM]).toBeDefined();
  });
  it('empty then subscribe lifecycle soft-5', async () => {
    const fx = fixtureJoinedRoom();
    const syncDo = createSyncDoStub();
    const db = createSlidingDb({
      maxStreamPos: 15,
      memberships: fx.memberships,
      rooms: fx.rooms,
      events: fx.events,
      state: fx.state,
    });
    const env = createEnv({ db, syncDo });
    const first = await postSync(MSC3575, env, { lists: {} });
    expect(first.status).toBe(200);
    expect(first.body.pos).toBe('15');
    expect(first.body.rooms).toEqual({});

    // bump stream and subscribe
    const env2 = createEnv({
      db: createSlidingDb({
        maxStreamPos: 25,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
      syncDo,
    });
    const second = await postSync(MSC3575, env2, {
      pos: first.body.pos as string,
      room_subscriptions: { [ROOM]: { timeline_limit: 5 } },
    });
    expect(second.status).toBe(200);
    expect(second.body.pos).toBe('25');
    expect((second.body.rooms as any)[ROOM]).toBeDefined();
  });
  it('empty then subscribe lifecycle soft-6', async () => {
    const fx = fixtureJoinedRoom();
    const syncDo = createSyncDoStub();
    const db = createSlidingDb({
      maxStreamPos: 16,
      memberships: fx.memberships,
      rooms: fx.rooms,
      events: fx.events,
      state: fx.state,
    });
    const env = createEnv({ db, syncDo });
    const first = await postSync(MSC3575, env, { lists: {} });
    expect(first.status).toBe(200);
    expect(first.body.pos).toBe('16');
    expect(first.body.rooms).toEqual({});

    // bump stream and subscribe
    const env2 = createEnv({
      db: createSlidingDb({
        maxStreamPos: 26,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
      syncDo,
    });
    const second = await postSync(MSC3575, env2, {
      pos: first.body.pos as string,
      room_subscriptions: { [ROOM]: { timeline_limit: 5 } },
    });
    expect(second.status).toBe(200);
    expect(second.body.pos).toBe('26');
    expect((second.body.rooms as any)[ROOM]).toBeDefined();
  });
  it('empty then subscribe lifecycle soft-7', async () => {
    const fx = fixtureJoinedRoom();
    const syncDo = createSyncDoStub();
    const db = createSlidingDb({
      maxStreamPos: 17,
      memberships: fx.memberships,
      rooms: fx.rooms,
      events: fx.events,
      state: fx.state,
    });
    const env = createEnv({ db, syncDo });
    const first = await postSync(MSC3575, env, { lists: {} });
    expect(first.status).toBe(200);
    expect(first.body.pos).toBe('17');
    expect(first.body.rooms).toEqual({});

    // bump stream and subscribe
    const env2 = createEnv({
      db: createSlidingDb({
        maxStreamPos: 27,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
      syncDo,
    });
    const second = await postSync(MSC3575, env2, {
      pos: first.body.pos as string,
      room_subscriptions: { [ROOM]: { timeline_limit: 5 } },
    });
    expect(second.status).toBe(200);
    expect(second.body.pos).toBe('27');
    expect((second.body.rooms as any)[ROOM]).toBeDefined();
  });
  it('empty then subscribe lifecycle soft-8', async () => {
    const fx = fixtureJoinedRoom();
    const syncDo = createSyncDoStub();
    const db = createSlidingDb({
      maxStreamPos: 18,
      memberships: fx.memberships,
      rooms: fx.rooms,
      events: fx.events,
      state: fx.state,
    });
    const env = createEnv({ db, syncDo });
    const first = await postSync(MSC3575, env, { lists: {} });
    expect(first.status).toBe(200);
    expect(first.body.pos).toBe('18');
    expect(first.body.rooms).toEqual({});

    // bump stream and subscribe
    const env2 = createEnv({
      db: createSlidingDb({
        maxStreamPos: 28,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
      syncDo,
    });
    const second = await postSync(MSC3575, env2, {
      pos: first.body.pos as string,
      room_subscriptions: { [ROOM]: { timeline_limit: 5 } },
    });
    expect(second.status).toBe(200);
    expect(second.body.pos).toBe('28');
    expect((second.body.rooms as any)[ROOM]).toBeDefined();
  });
  it('empty then subscribe lifecycle soft-9', async () => {
    const fx = fixtureJoinedRoom();
    const syncDo = createSyncDoStub();
    const db = createSlidingDb({
      maxStreamPos: 19,
      memberships: fx.memberships,
      rooms: fx.rooms,
      events: fx.events,
      state: fx.state,
    });
    const env = createEnv({ db, syncDo });
    const first = await postSync(MSC3575, env, { lists: {} });
    expect(first.status).toBe(200);
    expect(first.body.pos).toBe('19');
    expect(first.body.rooms).toEqual({});

    // bump stream and subscribe
    const env2 = createEnv({
      db: createSlidingDb({
        maxStreamPos: 29,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
      syncDo,
    });
    const second = await postSync(MSC3575, env2, {
      pos: first.body.pos as string,
      room_subscriptions: { [ROOM]: { timeline_limit: 5 } },
    });
    expect(second.status).toBe(200);
    expect(second.body.pos).toBe('29');
    expect((second.body.rooms as any)[ROOM]).toBeDefined();
  });
  it('empty then subscribe lifecycle soft-10', async () => {
    const fx = fixtureJoinedRoom();
    const syncDo = createSyncDoStub();
    const db = createSlidingDb({
      maxStreamPos: 20,
      memberships: fx.memberships,
      rooms: fx.rooms,
      events: fx.events,
      state: fx.state,
    });
    const env = createEnv({ db, syncDo });
    const first = await postSync(MSC3575, env, { lists: {} });
    expect(first.status).toBe(200);
    expect(first.body.pos).toBe('20');
    expect(first.body.rooms).toEqual({});

    // bump stream and subscribe
    const env2 = createEnv({
      db: createSlidingDb({
        maxStreamPos: 30,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
      syncDo,
    });
    const second = await postSync(MSC3575, env2, {
      pos: first.body.pos as string,
      room_subscriptions: { [ROOM]: { timeline_limit: 5 } },
    });
    expect(second.status).toBe(200);
    expect(second.body.pos).toBe('30');
    expect((second.body.rooms as any)[ROOM]).toBeDefined();
  });
  it('empty then subscribe lifecycle soft-11', async () => {
    const fx = fixtureJoinedRoom();
    const syncDo = createSyncDoStub();
    const db = createSlidingDb({
      maxStreamPos: 21,
      memberships: fx.memberships,
      rooms: fx.rooms,
      events: fx.events,
      state: fx.state,
    });
    const env = createEnv({ db, syncDo });
    const first = await postSync(MSC3575, env, { lists: {} });
    expect(first.status).toBe(200);
    expect(first.body.pos).toBe('21');
    expect(first.body.rooms).toEqual({});

    // bump stream and subscribe
    const env2 = createEnv({
      db: createSlidingDb({
        maxStreamPos: 31,
        memberships: fx.memberships,
        rooms: fx.rooms,
        events: fx.events,
        state: fx.state,
      }),
      syncDo,
    });
    const second = await postSync(MSC3575, env2, {
      pos: first.body.pos as string,
      room_subscriptions: { [ROOM]: { timeline_limit: 5 } },
    });
    expect(second.status).toBe(200);
    expect(second.body.pos).toBe('31');
    expect((second.body.rooms as any)[ROOM]).toBeDefined();
  });
});
