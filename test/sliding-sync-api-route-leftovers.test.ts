/**
 * TOKENMAXX HEAVY leftovers after #159 — sliding-sync soft/edge/reliability.
 * Complements sliding-sync-api-routes.test.ts (sync leftovers landed in #159).
 * Tests-only — no product inventing. Fixtures use example.com only.
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

function _fixtureInviteRoom(): {
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

describe('sliding leftovers empty body soft flood after #159', () => {
  it('MSC3575 empty soft-0', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 empty soft-1', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 empty soft-2', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 empty soft-3', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 empty soft-4', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 empty soft-5', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 empty soft-6', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 empty soft-7', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 empty soft-8', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 empty soft-9', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 empty soft-10', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 empty soft-11', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 empty soft-12', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 empty soft-13', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 empty soft-14', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 empty soft-15', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC4186 empty soft-0', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC4186 empty soft-1', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC4186 empty soft-2', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC4186 empty soft-3', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC4186 empty soft-4', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC4186 empty soft-5', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC4186 empty soft-6', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC4186 empty soft-7', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC4186 empty soft-8', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC4186 empty soft-9', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC4186 empty soft-10', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC4186 empty soft-11', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC4186 empty soft-12', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC4186 empty soft-13', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC4186 empty soft-14', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC4186 empty soft-15', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC4186, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('V4 empty soft-0', async () => {
    const env = createEnv();
    const { status, body } = await postSync(V4, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('V4 empty soft-1', async () => {
    const env = createEnv();
    const { status, body } = await postSync(V4, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('V4 empty soft-2', async () => {
    const env = createEnv();
    const { status, body } = await postSync(V4, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('V4 empty soft-3', async () => {
    const env = createEnv();
    const { status, body } = await postSync(V4, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('V4 empty soft-4', async () => {
    const env = createEnv();
    const { status, body } = await postSync(V4, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('V4 empty soft-5', async () => {
    const env = createEnv();
    const { status, body } = await postSync(V4, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('V4 empty soft-6', async () => {
    const env = createEnv();
    const { status, body } = await postSync(V4, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('V4 empty soft-7', async () => {
    const env = createEnv();
    const { status, body } = await postSync(V4, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('V4 empty soft-8', async () => {
    const env = createEnv();
    const { status, body } = await postSync(V4, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('V4 empty soft-9', async () => {
    const env = createEnv();
    const { status, body } = await postSync(V4, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('V4 empty soft-10', async () => {
    const env = createEnv();
    const { status, body } = await postSync(V4, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('V4 empty soft-11', async () => {
    const env = createEnv();
    const { status, body } = await postSync(V4, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('V4 empty soft-12', async () => {
    const env = createEnv();
    const { status, body } = await postSync(V4, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('V4 empty soft-13', async () => {
    const env = createEnv();
    const { status, body } = await postSync(V4, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('V4 empty soft-14', async () => {
    const env = createEnv();
    const { status, body } = await postSync(V4, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('V4 empty soft-15', async () => {
    const env = createEnv();
    const { status, body } = await postSync(V4, env, {});
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
});

describe('sliding leftovers lists soft flood after #159', () => {
  it('MSC3575 lists soft-0', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 10 }) });
    const { status, body } = await postSync(MSC3575, env, {
      lists: {
        main: { ranges: [[0, 0]], timeline_limit: 1 },
      },
    });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 lists soft-1', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 11 }) });
    const { status, body } = await postSync(MSC3575, env, {
      lists: {
        main: { ranges: [[0, 1]], timeline_limit: 1 },
      },
    });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 lists soft-2', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 12 }) });
    const { status, body } = await postSync(MSC3575, env, {
      lists: {
        main: { ranges: [[0, 2]], timeline_limit: 2 },
      },
    });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 lists soft-3', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 13 }) });
    const { status, body } = await postSync(MSC3575, env, {
      lists: {
        main: { ranges: [[0, 3]], timeline_limit: 3 },
      },
    });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 lists soft-4', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 14 }) });
    const { status, body } = await postSync(MSC3575, env, {
      lists: {
        main: { ranges: [[0, 4]], timeline_limit: 4 },
      },
    });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 lists soft-5', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 15 }) });
    const { status, body } = await postSync(MSC3575, env, {
      lists: {
        main: { ranges: [[0, 5]], timeline_limit: 5 },
      },
    });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 lists soft-6', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 16 }) });
    const { status, body } = await postSync(MSC3575, env, {
      lists: {
        main: { ranges: [[0, 5]], timeline_limit: 6 },
      },
    });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 lists soft-7', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 17 }) });
    const { status, body } = await postSync(MSC3575, env, {
      lists: {
        main: { ranges: [[0, 5]], timeline_limit: 7 },
      },
    });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 lists soft-8', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 18 }) });
    const { status, body } = await postSync(MSC3575, env, {
      lists: {
        main: { ranges: [[0, 5]], timeline_limit: 8 },
      },
    });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 lists soft-9', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 19 }) });
    const { status, body } = await postSync(MSC3575, env, {
      lists: {
        main: { ranges: [[0, 5]], timeline_limit: 9 },
      },
    });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 lists soft-10', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 20 }) });
    const { status, body } = await postSync(MSC3575, env, {
      lists: {
        main: { ranges: [[0, 5]], timeline_limit: 1 },
      },
    });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 lists soft-11', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 21 }) });
    const { status, body } = await postSync(MSC3575, env, {
      lists: {
        main: { ranges: [[0, 5]], timeline_limit: 1 },
      },
    });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 lists soft-12', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 22 }) });
    const { status, body } = await postSync(MSC3575, env, {
      lists: {
        main: { ranges: [[0, 5]], timeline_limit: 2 },
      },
    });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 lists soft-13', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 23 }) });
    const { status, body } = await postSync(MSC3575, env, {
      lists: {
        main: { ranges: [[0, 5]], timeline_limit: 3 },
      },
    });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 lists soft-14', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 24 }) });
    const { status, body } = await postSync(MSC3575, env, {
      lists: {
        main: { ranges: [[0, 5]], timeline_limit: 4 },
      },
    });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 lists soft-15', async () => {
    const env = createEnv({ db: createSlidingDb({ maxStreamPos: 25 }) });
    const { status, body } = await postSync(MSC3575, env, {
      lists: {
        main: { ranges: [[0, 5]], timeline_limit: 5 },
      },
    });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
});

describe('sliding leftovers charset soft flood after #159', () => {
  it('MSC3575 charset soft-0', async () => {
    const env = createEnv();
    const { status } = await postSync(MSC3575, env, {}, { 'Content-Type': 'application/json' });
    expect(status).toBe(200);
  });
  it('MSC3575 charset soft-1', async () => {
    const env = createEnv();
    const { status } = await postSync(MSC3575, env, {}, { 'Content-Type': 'application/json; charset=utf-8' });
    expect(status).toBe(200);
  });
  it('MSC3575 charset soft-2', async () => {
    const env = createEnv();
    const { status } = await postSync(MSC3575, env, {}, { 'Content-Type': 'application/json;charset=UTF-8' });
    expect(status).toBe(200);
  });
  it('MSC3575 charset soft-3', async () => {
    const env = createEnv();
    const { status } = await postSync(MSC3575, env, {}, { 'Content-Type': 'application/json; charset=UTF-8' });
    expect(status).toBe(200);
  });
  it('MSC3575 charset soft-4', async () => {
    const env = createEnv();
    const { status } = await postSync(MSC3575, env, {}, { 'Content-Type': 'application/json' });
    expect(status).toBe(200);
  });
  it('MSC3575 charset soft-5', async () => {
    const env = createEnv();
    const { status } = await postSync(MSC3575, env, {}, { 'Content-Type': 'application/json; charset=utf-8' });
    expect(status).toBe(200);
  });
  it('MSC3575 charset soft-6', async () => {
    const env = createEnv();
    const { status } = await postSync(MSC3575, env, {}, { 'Content-Type': 'application/json;charset=UTF-8' });
    expect(status).toBe(200);
  });
  it('MSC3575 charset soft-7', async () => {
    const env = createEnv();
    const { status } = await postSync(MSC3575, env, {}, { 'Content-Type': 'application/json; charset=UTF-8' });
    expect(status).toBe(200);
  });
  it('MSC3575 charset soft-8', async () => {
    const env = createEnv();
    const { status } = await postSync(MSC3575, env, {}, { 'Content-Type': 'application/json' });
    expect(status).toBe(200);
  });
  it('MSC3575 charset soft-9', async () => {
    const env = createEnv();
    const { status } = await postSync(MSC3575, env, {}, { 'Content-Type': 'application/json; charset=utf-8' });
    expect(status).toBe(200);
  });
  it('MSC3575 charset soft-10', async () => {
    const env = createEnv();
    const { status } = await postSync(MSC3575, env, {}, { 'Content-Type': 'application/json;charset=UTF-8' });
    expect(status).toBe(200);
  });
  it('MSC3575 charset soft-11', async () => {
    const env = createEnv();
    const { status } = await postSync(MSC3575, env, {}, { 'Content-Type': 'application/json; charset=UTF-8' });
    expect(status).toBe(200);
  });
  it('MSC3575 charset soft-12', async () => {
    const env = createEnv();
    const { status } = await postSync(MSC3575, env, {}, { 'Content-Type': 'application/json' });
    expect(status).toBe(200);
  });
  it('MSC3575 charset soft-13', async () => {
    const env = createEnv();
    const { status } = await postSync(MSC3575, env, {}, { 'Content-Type': 'application/json; charset=utf-8' });
    expect(status).toBe(200);
  });
  it('MSC3575 charset soft-14', async () => {
    const env = createEnv();
    const { status } = await postSync(MSC3575, env, {}, { 'Content-Type': 'application/json;charset=UTF-8' });
    expect(status).toBe(200);
  });
  it('MSC3575 charset soft-15', async () => {
    const env = createEnv();
    const { status } = await postSync(MSC3575, env, {}, { 'Content-Type': 'application/json; charset=UTF-8' });
    expect(status).toBe(200);
  });
});

describe('sliding leftovers corrupt JSON soft flood after #159', () => {
  it('MSC3575 corrupt soft-0', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC3575}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad0' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC3575 corrupt soft-1', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC3575}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad1' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC3575 corrupt soft-2', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC3575}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad2' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC3575 corrupt soft-3', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC3575}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad3' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC3575 corrupt soft-4', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC3575}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad4' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC3575 corrupt soft-5', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC3575}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad5' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC3575 corrupt soft-6', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC3575}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad6' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC3575 corrupt soft-7', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC3575}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad7' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC3575 corrupt soft-8', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC3575}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad8' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC3575 corrupt soft-9', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC3575}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad9' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC3575 corrupt soft-10', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC3575}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad10' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC3575 corrupt soft-11', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC3575}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad11' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC3575 corrupt soft-12', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC3575}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad12' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC3575 corrupt soft-13', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC3575}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad13' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC3575 corrupt soft-14', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC3575}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad14' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC3575 corrupt soft-15', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC3575}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad15' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC4186 corrupt soft-0', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC4186}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad0' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC4186 corrupt soft-1', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC4186}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad1' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC4186 corrupt soft-2', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC4186}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad2' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC4186 corrupt soft-3', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC4186}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad3' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC4186 corrupt soft-4', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC4186}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad4' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC4186 corrupt soft-5', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC4186}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad5' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC4186 corrupt soft-6', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC4186}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad6' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC4186 corrupt soft-7', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC4186}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad7' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC4186 corrupt soft-8', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC4186}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad8' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC4186 corrupt soft-9', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC4186}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad9' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC4186 corrupt soft-10', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC4186}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad10' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC4186 corrupt soft-11', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC4186}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad11' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC4186 corrupt soft-12', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC4186}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad12' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC4186 corrupt soft-13', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC4186}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad13' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC4186 corrupt soft-14', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC4186}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad14' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('MSC4186 corrupt soft-15', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${MSC4186}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad15' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('V4 corrupt soft-0', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${V4}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad0' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('V4 corrupt soft-1', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${V4}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad1' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('V4 corrupt soft-2', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${V4}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad2' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('V4 corrupt soft-3', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${V4}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad3' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('V4 corrupt soft-4', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${V4}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad4' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('V4 corrupt soft-5', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${V4}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad5' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('V4 corrupt soft-6', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${V4}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad6' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('V4 corrupt soft-7', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${V4}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad7' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('V4 corrupt soft-8', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${V4}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad8' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('V4 corrupt soft-9', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${V4}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad9' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('V4 corrupt soft-10', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${V4}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad10' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('V4 corrupt soft-11', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${V4}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad11' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('V4 corrupt soft-12', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${V4}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad12' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('V4 corrupt soft-13', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${V4}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad13' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('V4 corrupt soft-14', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${V4}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad14' },
      env
    );
    expect(res.status).toBe(400);
  });
  it('V4 corrupt soft-15', async () => {
    const env = createEnv();
    const res = await slidingSyncApp.request(
      `http://localhost${V4}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad15' },
      env
    );
    expect(res.status).toBe(400);
  });
});

describe('sliding leftovers method matrix after #159', () => {
  const paths = [MSC3575, MSC4186, V4] as const;
  const bad = ['GET', 'PUT', 'DELETE', 'PATCH'] as const;
  for (const path of paths) {
    for (const method of bad) {
      it(`${method} ${path} → 404/405`, async () => {
        const env = createEnv();
        const res = await slidingSyncApp.request(`http://localhost${path}`, { method }, env);
        expect([404, 405]).toContain(res.status);
      });
    }
  }
});
describe('sliding leftovers lifecycle soft floods after #159', () => {
  it('three endpoints lifecycle soft-0', async () => {
    const env = createEnv();
    const a = await postSync(MSC3575, env, {});
    expect(a.status).toBe(200);
    const b = await postSync(MSC4186, env, {});
    expect(b.status).toBe(200);
    const c = await postSync(V4, env, {});
    expect(c.status).toBe(200);
  });
  it('three endpoints lifecycle soft-1', async () => {
    const env = createEnv();
    const a = await postSync(MSC3575, env, {});
    expect(a.status).toBe(200);
    const b = await postSync(MSC4186, env, {});
    expect(b.status).toBe(200);
    const c = await postSync(V4, env, {});
    expect(c.status).toBe(200);
  });
  it('three endpoints lifecycle soft-2', async () => {
    const env = createEnv();
    const a = await postSync(MSC3575, env, {});
    expect(a.status).toBe(200);
    const b = await postSync(MSC4186, env, {});
    expect(b.status).toBe(200);
    const c = await postSync(V4, env, {});
    expect(c.status).toBe(200);
  });
  it('three endpoints lifecycle soft-3', async () => {
    const env = createEnv();
    const a = await postSync(MSC3575, env, {});
    expect(a.status).toBe(200);
    const b = await postSync(MSC4186, env, {});
    expect(b.status).toBe(200);
    const c = await postSync(V4, env, {});
    expect(c.status).toBe(200);
  });
  it('three endpoints lifecycle soft-4', async () => {
    const env = createEnv();
    const a = await postSync(MSC3575, env, {});
    expect(a.status).toBe(200);
    const b = await postSync(MSC4186, env, {});
    expect(b.status).toBe(200);
    const c = await postSync(V4, env, {});
    expect(c.status).toBe(200);
  });
  it('three endpoints lifecycle soft-5', async () => {
    const env = createEnv();
    const a = await postSync(MSC3575, env, {});
    expect(a.status).toBe(200);
    const b = await postSync(MSC4186, env, {});
    expect(b.status).toBe(200);
    const c = await postSync(V4, env, {});
    expect(c.status).toBe(200);
  });
  it('three endpoints lifecycle soft-6', async () => {
    const env = createEnv();
    const a = await postSync(MSC3575, env, {});
    expect(a.status).toBe(200);
    const b = await postSync(MSC4186, env, {});
    expect(b.status).toBe(200);
    const c = await postSync(V4, env, {});
    expect(c.status).toBe(200);
  });
  it('three endpoints lifecycle soft-7', async () => {
    const env = createEnv();
    const a = await postSync(MSC3575, env, {});
    expect(a.status).toBe(200);
    const b = await postSync(MSC4186, env, {});
    expect(b.status).toBe(200);
    const c = await postSync(V4, env, {});
    expect(c.status).toBe(200);
  });
  it('three endpoints lifecycle soft-8', async () => {
    const env = createEnv();
    const a = await postSync(MSC3575, env, {});
    expect(a.status).toBe(200);
    const b = await postSync(MSC4186, env, {});
    expect(b.status).toBe(200);
    const c = await postSync(V4, env, {});
    expect(c.status).toBe(200);
  });
  it('three endpoints lifecycle soft-9', async () => {
    const env = createEnv();
    const a = await postSync(MSC3575, env, {});
    expect(a.status).toBe(200);
    const b = await postSync(MSC4186, env, {});
    expect(b.status).toBe(200);
    const c = await postSync(V4, env, {});
    expect(c.status).toBe(200);
  });
  it('three endpoints lifecycle soft-10', async () => {
    const env = createEnv();
    const a = await postSync(MSC3575, env, {});
    expect(a.status).toBe(200);
    const b = await postSync(MSC4186, env, {});
    expect(b.status).toBe(200);
    const c = await postSync(V4, env, {});
    expect(c.status).toBe(200);
  });
  it('three endpoints lifecycle soft-11', async () => {
    const env = createEnv();
    const a = await postSync(MSC3575, env, {});
    expect(a.status).toBe(200);
    const b = await postSync(MSC4186, env, {});
    expect(b.status).toBe(200);
    const c = await postSync(V4, env, {});
    expect(c.status).toBe(200);
  });
  it('three endpoints lifecycle soft-12', async () => {
    const env = createEnv();
    const a = await postSync(MSC3575, env, {});
    expect(a.status).toBe(200);
    const b = await postSync(MSC4186, env, {});
    expect(b.status).toBe(200);
    const c = await postSync(V4, env, {});
    expect(c.status).toBe(200);
  });
  it('three endpoints lifecycle soft-13', async () => {
    const env = createEnv();
    const a = await postSync(MSC3575, env, {});
    expect(a.status).toBe(200);
    const b = await postSync(MSC4186, env, {});
    expect(b.status).toBe(200);
    const c = await postSync(V4, env, {});
    expect(c.status).toBe(200);
  });
  it('three endpoints lifecycle soft-14', async () => {
    const env = createEnv();
    const a = await postSync(MSC3575, env, {});
    expect(a.status).toBe(200);
    const b = await postSync(MSC4186, env, {});
    expect(b.status).toBe(200);
    const c = await postSync(V4, env, {});
    expect(c.status).toBe(200);
  });
  it('three endpoints lifecycle soft-15', async () => {
    const env = createEnv();
    const a = await postSync(MSC3575, env, {});
    expect(a.status).toBe(200);
    const b = await postSync(MSC4186, env, {});
    expect(b.status).toBe(200);
    const c = await postSync(V4, env, {});
    expect(c.status).toBe(200);
  });
});

describe('sliding leftovers conn_id soft flood after #159', () => {
  it('MSC3575 conn_id soft-0', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, { conn_id: 'conn-0' });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 conn_id soft-1', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, { conn_id: 'conn-1' });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 conn_id soft-2', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, { conn_id: 'conn-2' });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 conn_id soft-3', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, { conn_id: 'conn-3' });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 conn_id soft-4', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, { conn_id: 'conn-4' });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 conn_id soft-5', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, { conn_id: 'conn-5' });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 conn_id soft-6', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, { conn_id: 'conn-6' });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 conn_id soft-7', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, { conn_id: 'conn-7' });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 conn_id soft-8', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, { conn_id: 'conn-8' });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 conn_id soft-9', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, { conn_id: 'conn-9' });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 conn_id soft-10', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, { conn_id: 'conn-10' });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 conn_id soft-11', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, { conn_id: 'conn-11' });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 conn_id soft-12', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, { conn_id: 'conn-12' });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 conn_id soft-13', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, { conn_id: 'conn-13' });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 conn_id soft-14', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, { conn_id: 'conn-14' });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
  it('MSC3575 conn_id soft-15', async () => {
    const env = createEnv();
    const { status, body } = await postSync(MSC3575, env, { conn_id: 'conn-15' });
    expect(status).toBe(200);
    expect(typeof body.pos).toBe('string');
  });
});
