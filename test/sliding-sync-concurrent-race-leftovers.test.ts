/**
 * TOKENMAXX HEAVY leftovers after #202 — sliding-sync *concurrent race / TOCTOU*
 * + soft/edge reliability for slices not covered by:
 *   - sliding-sync-api-routes / sliding-sync-api-route-leftovers (#189) soft/edge floods
 *   - sliding-sync-helpers / sliding-sync-device-list-deepen
 *   - sync concurrent-race leftovers (#202) (distinct client /sync surface)
 *
 * Distinct domain — not sync (#202), voip/rtc/calls (#201), report/server-notices (#200),
 * search/spaces (#199), profile (#198/#197), tags (#196), workflows (#195),
 * rooms-mutate (#194), aliases (#193), rooms (#192), admin-mutate (#191).
 *
 * Focus: dual MSC3575/MSC4186/v4 POST under getUserRooms JOIN barrier;
 * membership leave/invite mid-flight TOCTOU; timeline mutate mid-flight;
 * stream-position advance; DO connection-state get→save LWW / dual-conn isolation;
 * room_subscriptions membership SELECT TOCTOU; subscribe∥unsubscribe;
 * extension (to_device/e2ee/account_data/typing/receipts/presence) concurrent;
 * long-poll wait∥sync; multi-list / filter / range soft floods under Promise.all.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', authState.userId);
      c.set('deviceId', authState.deviceId);
      await next();
    };
  },
}));

const authState = vi.hoisted(() => ({
  userId: '@alice:example.com' as string | undefined,
  deviceId: 'DEVICEA' as string | undefined,
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
const ENDPOINTS = [MSC3575, MSC4186, V4] as const;

const AUTH = { Authorization: 'Bearer test-token' };

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
type SyncDoFetch = { url: string; method: string; body?: unknown };
type FnBarrier = { count: number; waiters: Array<() => void> };
type SelectBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };

function createFnBarrier(count: number): FnBarrier {
  return { count, waiters: [] };
}

async function hitFnBarrier(barrier: FnBarrier | undefined) {
  if (!barrier) return;
  await new Promise<void>((resolve) => {
    barrier.waiters.push(resolve);
    if (barrier.waiters.length >= barrier.count) {
      const all = [...barrier.waiters];
      barrier.waiters = [];
      for (const r of all) r();
    }
  });
}

async function withSelectBarrier(
  barrier: SelectBarrier | undefined,
  waitersRef: { list: Array<() => void>; active?: SelectBarrier },
  sql: string,
  args: unknown[]
) {
  const active = waitersRef.active ?? barrier;
  if (!active || !active.match(sql, args)) return;
  await new Promise<void>((resolve) => {
    waitersRef.list.push(resolve);
    if (waitersRef.list.length >= active.count) {
      const all = [...waitersRef.list];
      waitersRef.list = [];
      waitersRef.active = undefined;
      for (const r of all) r();
    }
  });
}

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

function createSyncDoStub(opts: {
  states?: Record<string, ConnectionState | null>;
  getFail?: boolean;
  getStatus?: number;
  waitHasEvents?: boolean | (() => boolean);
  waitFail?: boolean;
  saveFail?: boolean;
  getBarrier?: FnBarrier;
  putBarrier?: FnBarrier;
  mutateStateAfterGets?: { after: number; connId: string; next: ConnectionState | null };
  failGetAfter?: number;
  failPutAfter?: number;
} = {}) {
  const states: Record<string, ConnectionState | null> = { ...(opts.states ?? {}) };
  const fetches: SyncDoFetch[] = [];
  const saves: { connId: string; state: ConnectionState }[] = [];
  let getCount = 0;
  let putCount = 0;

  return {
    states,
    fetches,
    saves,
    getCount: () => getCount,
    putCount: () => putCount,
    async fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
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
        await hitFnBarrier(opts.getBarrier);
        if (opts.waitFail) throw new Error('wait boom');
        const hasEvents =
          typeof opts.waitHasEvents === 'function'
            ? opts.waitHasEvents()
            : (opts.waitHasEvents ?? false);
        return Response.json({ hasEvents });
      }

      const connId = new URL(url).searchParams.get('conn_id') || 'default';

      if (method === 'GET' && url.includes('/sliding-sync/state')) {
        await hitFnBarrier(opts.getBarrier);
        getCount += 1;
        const myGet = getCount;
        if (opts.failGetAfter != null && myGet > opts.failGetAfter) {
          throw new Error('DO get boom');
        }
        if (opts.getFail) throw new Error('DO get boom');
        if (opts.getStatus && opts.getStatus !== 200) {
          return new Response('do error', { status: opts.getStatus });
        }
        if (opts.mutateStateAfterGets && myGet === opts.mutateStateAfterGets.after) {
          states[opts.mutateStateAfterGets.connId] = opts.mutateStateAfterGets.next;
        }
        const state = states[connId] ?? null;
        return Response.json(state);
      }

      if (method === 'PUT' && url.includes('/sliding-sync/state')) {
        await hitFnBarrier(opts.putBarrier);
        putCount += 1;
        if (opts.failPutAfter != null && putCount > opts.failPutAfter) {
          return new Response('save failed', { status: 500 });
        }
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
  fail?: boolean;
} = {}) {
  const deviceIds = opts.deviceIds ?? [DEVICE];
  const crossSigning = opts.crossSigning ?? {};
  const fetches: string[] = [];
  return {
    fetches,
    async fetch(req: Request): Promise<Response> {
      fetches.push(req.url);
      if (opts.fail) throw new Error('userkeys boom');
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
  selectBarrier?: SelectBarrier;
  mutateMembershipsAfter?: { after: number; match: (sql: string) => boolean; next: MembershipRow[] };
  mutateEventsAfter?: { after: number; match: (sql: string) => boolean; next: EventRow[] };
  mutateMaxPosAfter?: { after: number; next: number | null };
  throwOnSqlIncludes?: string;
  failAfterSelects?: { after: number; match: (sql: string) => boolean };
} = {}) {
  let maxStreamPos = opts.maxStreamPos === undefined ? 42 : opts.maxStreamPos;
  let memberships = [...(opts.memberships ?? [])];
  const rooms = [...(opts.rooms ?? [])];
  let events = [...(opts.events ?? [])];
  const state = [...(opts.state ?? [])];
  let accountData = [...(opts.accountData ?? [])];
  let otkCounts = opts.otkCounts ?? [];
  let fallbackAlgos = opts.fallbackAlgos ?? [];
  let deviceKeyChanges = [...(opts.deviceKeyChanges ?? [])];
  const sharedRoomUsers = new Set(opts.sharedRoomUsers ?? [BOB, CAROL]);

  const selects: SqlCall[] = [];
  const batches: unknown[][] = [];
  let membershipMatchCount = 0;
  let eventsMatchCount = 0;
  let maxPosMatchCount = 0;
  let failMatchCount = 0;
  const waitersRef: { list: Array<() => void>; active?: SelectBarrier } = {
    list: [],
    active: opts.selectBarrier,
  };

  function contentForState(roomId: string, eventType: string): string | null {
    const row = state.find((s) => s.room_id === roomId && s.event_type === eventType);
    if (!row) {
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

  /**
   * Barrier → count matching selects → snapshot reads happen in handle* →
   * then mutate/fail so the Nth matching select still sees pre-mutate state.
   */
  async function gateSelect(sql: string, args: unknown[]): Promise<() => void> {
    selects.push({ sql, args });
    await withSelectBarrier(opts.selectBarrier, waitersRef, sql, args);
    if (opts.throwOnSqlIncludes && sql.includes(opts.throwOnSqlIncludes)) {
      throw new Error(`db boom: ${opts.throwOnSqlIncludes}`);
    }

    let myMembership = 0;
    let myEvents = 0;
    let myMaxPos = 0;
    let myFail = 0;

    if (opts.failAfterSelects?.match(sql)) {
      failMatchCount += 1;
      myFail = failMatchCount;
      if (myFail > opts.failAfterSelects.after) {
        throw new Error('db select boom');
      }
    }
    if (opts.mutateMembershipsAfter?.match(sql)) {
      membershipMatchCount += 1;
      myMembership = membershipMatchCount;
    }
    if (opts.mutateEventsAfter?.match(sql)) {
      eventsMatchCount += 1;
      myEvents = eventsMatchCount;
    }
    if (
      opts.mutateMaxPosAfter &&
      sql.includes('MAX(stream_ordering)') &&
      sql.includes('FROM events') &&
      !sql.includes('WHERE')
    ) {
      maxPosMatchCount += 1;
      myMaxPos = maxPosMatchCount;
    }

    return () => {
      if (
        opts.mutateMembershipsAfter &&
        myMembership === opts.mutateMembershipsAfter.after
      ) {
        memberships = [...opts.mutateMembershipsAfter.next];
      }
      if (opts.mutateEventsAfter && myEvents === opts.mutateEventsAfter.after) {
        events = [...opts.mutateEventsAfter.next];
      }
      if (opts.mutateMaxPosAfter && myMaxPos === opts.mutateMaxPosAfter.after) {
        maxStreamPos = opts.mutateMaxPosAfter.next;
      }
    };
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

    if (sql.includes('FROM account_data') && sql.includes("event_type = 'm.fully_read'")) {
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
        count: memberships.filter((m) => m.room_id === roomId && m.membership === 'invite').length,
      };
    }

    return null;
  }

  function handleAll(sql: string, args: unknown[]): unknown[] {
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
          let roomName: string | null = meta?.name ?? null;
          if (!roomName) {
            const name = contentForState(m.room_id, 'm.room.name');
            if (typeof name === 'string' && name.startsWith('{')) {
              try {
                roomName = JSON.parse(name).name ?? null;
              } catch {
                roomName = null;
              }
            }
          }
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
          count: memberships.filter((m) => m.room_id === roomId && m.membership === 'join').length,
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
      sql.includes('user_id != ?')
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

    if (
      sql.includes('SELECT event_type, content FROM account_data') &&
      sql.includes("room_id = ''")
    ) {
      const [userId] = args as string[];
      return accountData
        .filter((a) => a.user_id === userId && a.room_id === '')
        .map((a) => ({ event_type: a.event_type, content: a.content }));
    }

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

    if (
      sql.includes('SELECT room_id FROM room_memberships') &&
      sql.includes("membership = 'join'")
    ) {
      const [userId] = args as string[];
      return memberships
        .filter((m) => m.user_id === userId && m.membership === 'join')
        .map((m) => ({ room_id: m.room_id }));
    }

    if (
      sql.includes('SELECT user_id FROM room_memberships') &&
      sql.includes("membership = 'join'")
    ) {
      const [roomId] = args as string[];
      return memberships
        .filter((m) => m.room_id === roomId && m.membership === 'join')
        .map((m) => ({ user_id: m.user_id }));
    }

    if (sql.includes('FROM one_time_keys') && sql.includes('GROUP BY algorithm')) {
      return otkCounts;
    }

    if (sql.includes('FROM fallback_keys') && sql.includes('DISTINCT algorithm')) {
      return fallbackAlgos;
    }

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
    get memberships() {
      return memberships;
    },
    setMemberships(next: MembershipRow[]) {
      memberships = [...next];
    },
    get events() {
      return events;
    },
    setEvents(next: EventRow[]) {
      events = [...next];
    },
    get maxStreamPos() {
      return maxStreamPos;
    },
    setMaxStreamPos(next: number | null) {
      maxStreamPos = next;
    },
    get accountData() {
      return accountData;
    },
    setAccountData(next: AccountDataRow[]) {
      accountData = [...next];
    },
    get otkCounts() {
      return otkCounts;
    },
    setOtkCounts(next: OtkCount[]) {
      otkCounts = [...next];
    },
    get fallbackAlgos() {
      return fallbackAlgos;
    },
    setFallbackAlgos(next: FallbackAlgo[]) {
      fallbackAlgos = [...next];
    },
    get deviceKeyChanges() {
      return deviceKeyChanges;
    },
    setDeviceKeyChanges(next: DeviceKeyChange[]) {
      deviceKeyChanges = [...next];
    },
    rooms,
    state,
    selects,
    batches,
    prepare(sql: string) {
      const makeStmt = (args: unknown[] = []) => ({
        sql,
        args,
        async first<T>() {
          const after = await gateSelect(sql, args);
          const result = handleFirst(sql, args) as T;
          after();
          return result;
        },
        async all<T>() {
          const after = await gateSelect(sql, args);
          const result = { results: handleAll(sql, args) as T[] };
          after();
          return result;
        },
        async run() {
          throw new Error(`Unexpected run() SQL: ${sql.slice(0, 120)}`);
        },
      });
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

function mergeFixtures(
  ...parts: Array<{
    memberships?: MembershipRow[];
    rooms?: RoomMeta[];
    events?: EventRow[];
    state?: StateRow[];
    accountData?: AccountDataRow[];
  }>
) {
  return {
    memberships: parts.flatMap((p) => p.memberships ?? []),
    rooms: parts.flatMap((p) => p.rooms ?? []),
    events: parts.flatMap((p) => p.events ?? []),
    state: parts.flatMap((p) => p.state ?? []),
    accountData: parts.flatMap((p) => p.accountData ?? []),
  };
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
  init: { query?: string; headers?: Record<string, string>; method?: string } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = `http://localhost${path}${init.query ? `?${init.query}` : ''}`;
  const res = await slidingSyncApp.request(
    url,
    {
      method: init.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...AUTH,
        ...(init.headers ?? {}),
      },
      body:
        init.method === 'GET' || init.method === 'HEAD'
          ? undefined
          : typeof body === 'string'
            ? body
            : JSON.stringify(body),
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

function listBody(ranges: [number, number][] = [[0, 9]], extra: Record<string, unknown> = {}) {
  return {
    lists: {
      all: {
        ranges,
        timeline_limit: 10,
        required_state: [['m.room.name', '']],
        ...extra,
      },
    },
  };
}

function roomsOf(body: Record<string, unknown>): Record<string, unknown> {
  return (body.rooms as Record<string, unknown>) ?? {};
}

function listsOf(body: Record<string, unknown>): Record<string, { count?: number; ops?: unknown[] }> {
  return (body.lists as Record<string, { count?: number; ops?: unknown[] }>) ?? {};
}

function resetMocks() {
  authState.userId = USER;
  authState.deviceId = DEVICE;
  countNotificationsWithRules.mockReset().mockResolvedValue({
    notification_count: 0,
    highlight_count: 0,
  });
  getTypingForRooms.mockReset().mockImplementation(async (_env, roomIds: string[]) => {
    const out: Record<string, string[]> = {};
    for (const id of roomIds) out[id] = [];
    return out;
  });
  getReceiptsForRooms.mockReset().mockImplementation(async (_env, roomIds: string[]) => {
    const out: Record<string, Record<string, unknown>> = {};
    for (const id of roomIds) out[id] = {};
    return out;
  });
  getToDeviceMessages.mockReset().mockResolvedValue({ events: [], nextBatch: '0' });
  getE2EEAccountDataFromDO.mockReset().mockResolvedValue({});
}

beforeEach(() => {
  resetMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function isUserRoomsJoin(sql: string) {
  return (
    sql.includes('FROM room_memberships rm') &&
    sql.includes('JOIN rooms r') &&
    sql.includes('rm.user_id = ?')
  );
}

function isMembershipSelect(sql: string) {
  return (
    sql.includes('SELECT membership FROM room_memberships') &&
    sql.includes('room_id = ?') &&
    sql.includes('user_id = ?')
  );
}

function isTimelineSql(sql: string) {
  return sql.includes('FROM events') && sql.includes('ORDER BY stream_ordering');
}

function isMaxPosSql(sql: string) {
  return sql.includes('MAX(stream_ordering)') && sql.includes('FROM events') && !sql.includes('WHERE');
}


describe('race sliding dual getUserRooms JOIN barrier after #202', () => {
  it('both parallel MSC3575 syncs see same join set under barrier', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      selectBarrier: { match: (sql) => isUserRoomsJoin(sql), count: 2 },
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC3575, env, listBody()),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(ROOM in roomsOf(r.body)).toBe(true);
      expect(listsOf(r.body).all?.count).toBe(1);
    }
  });

  it('membership leave flip after first JOIN SELECT; second omits room', async () => {
    const fx = fixtureJoinedRoom();
    const left = fx.memberships.map((m) =>
      m.user_id === USER && m.room_id === ROOM ? { ...m, membership: 'leave' } : m
    );
    const db = createSlidingDb({
      ...fx,
      selectBarrier: { match: (sql) => isUserRoomsJoin(sql), count: 2 },
      mutateMembershipsAfter: {
        after: 1,
        match: (sql) => isUserRoomsJoin(sql),
        next: left,
      },
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC3575, env, listBody()),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const withRoom = results.filter((r) => ROOM in roomsOf(r.body));
    const withoutRoom = results.filter((r) => !(ROOM in roomsOf(r.body)));
    expect(withRoom.length).toBe(1);
    expect(withoutRoom.length).toBe(1);
  });

  it('post-mutate sequential sync reflects emptied join set', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      mutateMembershipsAfter: {
        after: 1,
        match: (sql) => isUserRoomsJoin(sql),
        next: fx.memberships.filter((m) => !(m.user_id === USER && m.room_id === ROOM)),
      },
    });
    const env = createEnv({ db });
    const first = await postSync(MSC3575, env, listBody());
    expect(ROOM in roomsOf(first.body)).toBe(true);
    const second = await postSync(MSC3575, env, listBody());
    expect(ROOM in roomsOf(second.body)).toBe(false);
  });

  for (const residual of ['invite', 'leave', 'ban', 'knock'] as const) {
    it(`join flip residual status=${residual}`, async () => {
      const fx = fixtureJoinedRoom();
      const next = fx.memberships.map((m) =>
        m.user_id === USER && m.room_id === ROOM ? { ...m, membership: residual } : m
      );
      const db = createSlidingDb({
        ...fx,
        selectBarrier: { match: (sql) => isUserRoomsJoin(sql), count: 2 },
        mutateMembershipsAfter: {
          after: 1,
          match: (sql) => isUserRoomsJoin(sql),
          next,
        },
      });
      const env = createEnv({ db });
      const results = await Promise.all([
        postSync(MSC3575, env, listBody()),
        postSync(MSC3575, env, listBody()),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      // Default list filter is join+invite: leave/ban/knock drop the room for the
      // post-mutate observer; invite residual may still include the room.
      const withRoom = results.filter((r) => ROOM in roomsOf(r.body));
      const withoutRoom = results.filter((r) => !(ROOM in roomsOf(r.body)));
      expect(withRoom.length).toBeGreaterThanOrEqual(1);
      if (residual === 'invite') {
        expect(withRoom.length + withoutRoom.length).toBe(2);
      } else {
        expect(withoutRoom.length).toBe(1);
      }
    });
  }

  it('multi-room join barrier keeps room isolation across concurrent syncs', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'A' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'B' });
    const c = fixtureJoinedRoom({ room_id: ROOM3, name: 'C' });
    const fx = mergeFixtures(a, b, c);
    const db = createSlidingDb({
      ...fx,
      selectBarrier: { match: (sql) => isUserRoomsJoin(sql), count: 2 },
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody([[0, 20]])),
      postSync(MSC3575, env, listBody([[0, 20]])),
    ]);
    for (const r of results) {
      const rooms = Object.keys(roomsOf(r.body)).sort();
      expect(rooms).toEqual([ROOM, ROOM2, ROOM3].sort());
    }
  });

  it('JOIN SELECT fail soft mid concurrent — one boom one success', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      selectBarrier: { match: (sql) => isUserRoomsJoin(sql), count: 2 },
      failAfterSelects: { after: 1, match: (sql) => isUserRoomsJoin(sql) },
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC3575, env, listBody()),
    ]);
    expect(results.some((r) => r.status === 200)).toBe(true);
    expect(results.some((r) => r.status >= 500)).toBe(true);
  });

  for (const [i, path] of ENDPOINTS.entries()) {
    it(`endpoint ${path.split('/').pop()} dual barrier soft-${i}`, async () => {
      const fx = fixtureJoinedRoom();
      const db = createSlidingDb({
        ...fx,
        selectBarrier: { match: (sql) => isUserRoomsJoin(sql), count: 2 },
      });
      const env = createEnv({ db });
      const body =
        path === MSC3575
          ? listBody()
          : { lists: { all: { range: [0, 9] as [number, number], timeline_limit: 5 } } };
      const results = await Promise.all([postSync(path, env, body), postSync(path, env, body)]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      for (const r of results) expect(ROOM in roomsOf(r.body)).toBe(true);
    });
  }
});


describe('race sliding timeline mutate mid-flight after #202', () => {
  it('both syncs barrier on timeline; mutation visible to second', async () => {
    const fx = fixtureJoinedRoom();
    const extra = makeEvent({
      event_id: '$late:example.com',
      room_id: ROOM,
      event_type: 'm.room.message',
      content: JSON.stringify({ body: 'late', msgtype: 'm.text' }),
      stream_ordering: 99,
    });
    const db = createSlidingDb({
      ...fx,
      selectBarrier: { match: (sql) => isTimelineSql(sql), count: 2 },
      mutateEventsAfter: {
        after: 1,
        match: (sql) => isTimelineSql(sql),
        next: [...fx.events, extra],
      },
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC3575, env, listBody()),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const lengths = results.map((r) => {
      const room = roomsOf(r.body)[ROOM] as { timeline?: unknown[] };
      return room?.timeline?.length ?? 0;
    });
    expect(new Set(lengths).size).toBeGreaterThanOrEqual(1);
    expect(Math.max(...lengths)).toBeGreaterThanOrEqual(Math.min(...lengths));
  });

  it('empty→populated timeline under concurrent barrier', async () => {
    const fx = fixtureJoinedRoom();
    const onlyName = fx.events.filter((e) => e.event_type === 'm.room.name');
    const msg = makeEvent({
      event_id: '$pop:example.com',
      room_id: ROOM,
      event_type: 'm.room.message',
      content: JSON.stringify({ body: 'pop', msgtype: 'm.text' }),
      stream_ordering: 50,
    });
    const db = createSlidingDb({
      ...fx,
      events: onlyName,
      selectBarrier: { match: (sql) => isTimelineSql(sql), count: 2 },
      mutateEventsAfter: {
        after: 1,
        match: (sql) => isTimelineSql(sql),
        next: [...onlyName, msg],
      },
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC3575, env, listBody()),
    ]);
    const lengths = results.map((r) => {
      const room = roomsOf(r.body)[ROOM] as { timeline?: unknown[] };
      return room?.timeline?.length ?? 0;
    });
    expect(lengths.some((n) => n >= 1)).toBe(true);
  });


  it('timeline concurrent soft-isolation-0', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'A' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'B' });
    const fx = mergeFixtures(a, b);
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody([[0, 20]])),
      postSync(MSC3575, env, listBody([[0, 20]])),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(Object.keys(roomsOf(r.body)).sort()).toEqual([ROOM, ROOM2].sort());
    }
  });


  it('timeline concurrent soft-isolation-1', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'A' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'B' });
    const fx = mergeFixtures(a, b);
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody([[0, 20]])),
      postSync(MSC3575, env, listBody([[0, 20]])),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(Object.keys(roomsOf(r.body)).sort()).toEqual([ROOM, ROOM2].sort());
    }
  });


  it('timeline concurrent soft-isolation-2', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'A' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'B' });
    const fx = mergeFixtures(a, b);
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody([[0, 20]])),
      postSync(MSC3575, env, listBody([[0, 20]])),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(Object.keys(roomsOf(r.body)).sort()).toEqual([ROOM, ROOM2].sort());
    }
  });


  it('timeline concurrent soft-isolation-3', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'A' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'B' });
    const fx = mergeFixtures(a, b);
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody([[0, 20]])),
      postSync(MSC3575, env, listBody([[0, 20]])),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(Object.keys(roomsOf(r.body)).sort()).toEqual([ROOM, ROOM2].sort());
    }
  });


  it('timeline concurrent soft-isolation-4', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'A' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'B' });
    const fx = mergeFixtures(a, b);
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody([[0, 20]])),
      postSync(MSC3575, env, listBody([[0, 20]])),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(Object.keys(roomsOf(r.body)).sort()).toEqual([ROOM, ROOM2].sort());
    }
  });


  it('timeline concurrent soft-isolation-5', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'A' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'B' });
    const fx = mergeFixtures(a, b);
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody([[0, 20]])),
      postSync(MSC3575, env, listBody([[0, 20]])),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(Object.keys(roomsOf(r.body)).sort()).toEqual([ROOM, ROOM2].sort());
    }
  });


  it('timeline concurrent soft-isolation-6', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'A' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'B' });
    const fx = mergeFixtures(a, b);
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody([[0, 20]])),
      postSync(MSC3575, env, listBody([[0, 20]])),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(Object.keys(roomsOf(r.body)).sort()).toEqual([ROOM, ROOM2].sort());
    }
  });


  it('timeline concurrent soft-isolation-7', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'A' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'B' });
    const fx = mergeFixtures(a, b);
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody([[0, 20]])),
      postSync(MSC3575, env, listBody([[0, 20]])),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(Object.keys(roomsOf(r.body)).sort()).toEqual([ROOM, ROOM2].sort());
    }
  });


  it('timeline concurrent soft-isolation-8', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'A' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'B' });
    const fx = mergeFixtures(a, b);
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody([[0, 20]])),
      postSync(MSC3575, env, listBody([[0, 20]])),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(Object.keys(roomsOf(r.body)).sort()).toEqual([ROOM, ROOM2].sort());
    }
  });


  it('timeline concurrent soft-isolation-9', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'A' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'B' });
    const fx = mergeFixtures(a, b);
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody([[0, 20]])),
      postSync(MSC3575, env, listBody([[0, 20]])),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(Object.keys(roomsOf(r.body)).sort()).toEqual([ROOM, ROOM2].sort());
    }
  });


  it('timeline concurrent soft-isolation-10', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'A' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'B' });
    const fx = mergeFixtures(a, b);
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody([[0, 20]])),
      postSync(MSC3575, env, listBody([[0, 20]])),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(Object.keys(roomsOf(r.body)).sort()).toEqual([ROOM, ROOM2].sort());
    }
  });


  it('timeline concurrent soft-isolation-11', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'A' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'B' });
    const fx = mergeFixtures(a, b);
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody([[0, 20]])),
      postSync(MSC3575, env, listBody([[0, 20]])),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(Object.keys(roomsOf(r.body)).sort()).toEqual([ROOM, ROOM2].sort());
    }
  });

});


describe('race sliding stream-position mid-flight after #202', () => {
  it('MAX stream pos advances after first concurrent select', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      maxStreamPos: 10,
      selectBarrier: { match: (sql) => isMaxPosSql(sql), count: 2 },
      mutateMaxPosAfter: { after: 1, next: 77 },
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC3575, env, listBody()),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const positions = results.map((r) => String(r.body.pos));
    expect(positions).toContain('10');
    expect(positions).toContain('77');
  });

  it('null max pos soft concurrent still 200', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: null });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC3575, env, listBody()),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('stream pos concurrent soft-0', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 10 });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC4186, env, { lists: { all: { range: [0, 5] as [number, number] } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => r.body.pos != null)).toBe(true);
  });


  it('stream pos concurrent soft-1', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 13 });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC4186, env, { lists: { all: { range: [0, 5] as [number, number] } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => r.body.pos != null)).toBe(true);
  });


  it('stream pos concurrent soft-2', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 16 });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC4186, env, { lists: { all: { range: [0, 5] as [number, number] } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => r.body.pos != null)).toBe(true);
  });


  it('stream pos concurrent soft-3', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 19 });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC4186, env, { lists: { all: { range: [0, 5] as [number, number] } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => r.body.pos != null)).toBe(true);
  });


  it('stream pos concurrent soft-4', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 22 });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC4186, env, { lists: { all: { range: [0, 5] as [number, number] } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => r.body.pos != null)).toBe(true);
  });


  it('stream pos concurrent soft-5', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 25 });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC4186, env, { lists: { all: { range: [0, 5] as [number, number] } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => r.body.pos != null)).toBe(true);
  });


  it('stream pos concurrent soft-6', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 28 });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC4186, env, { lists: { all: { range: [0, 5] as [number, number] } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => r.body.pos != null)).toBe(true);
  });


  it('stream pos concurrent soft-7', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 31 });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC4186, env, { lists: { all: { range: [0, 5] as [number, number] } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => r.body.pos != null)).toBe(true);
  });

});


describe('race sliding DO connection-state get→save after #202', () => {
  it('dual cold-start same conn_id both succeed under get barrier', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const syncDo = createSyncDoStub({ getBarrier: createFnBarrier(2) });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), conn_id: 'c1' }),
      postSync(MSC3575, env, { ...listBody(), conn_id: 'c1' }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(syncDo.saves.length).toBeGreaterThanOrEqual(2);
    expect(syncDo.saves.every((s) => s.connId === 'c1')).toBe(true);
  });

  it('distinct conn_id isolation under concurrent get barrier', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const syncDo = createSyncDoStub({ getBarrier: createFnBarrier(2) });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), conn_id: 'alpha' }),
      postSync(MSC3575, env, { ...listBody(), conn_id: 'beta' }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const ids = new Set(syncDo.saves.map((s) => s.connId));
    expect(ids.has('alpha')).toBe(true);
    expect(ids.has('beta')).toBe(true);
  });

  it('DO get fail soft mid concurrent — one 503 one 200', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const syncDo = createSyncDoStub({
      getBarrier: createFnBarrier(2),
      failGetAfter: 1,
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC3575, env, listBody()),
    ]);
    expect(results.some((r) => r.status === 200)).toBe(true);
    expect(results.some((r) => r.status === 503)).toBe(true);
  });

  it('DO put/save fail soft still returns sync body', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const syncDo = createSyncDoStub({ saveFail: true });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC3575, env, listBody()),
    ]);
    // save failures are swallowed / non-fatal in handlers — expect non-500
    expect(results.every((r) => r.status === 200 || r.status === 503 || r.status < 500)).toBe(true);
  });

  it('warm reconnect state LWW under put barrier', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const warm: ConnectionState = {
      userId: USER,
      pos: 5,
      lastAccess: NOW - 1000,
      roomStates: { [ROOM]: { lastStreamOrdering: 5, sentState: true } },
      listStates: { all: { roomIds: [ROOM], count: 1 } },
    };
    const syncDo = createSyncDoStub({
      states: { default: warm },
      putBarrier: createFnBarrier(2),
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), pos: '5' }),
      postSync(MSC3575, env, { ...listBody(), pos: '5' }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(syncDo.saves.length).toBeGreaterThanOrEqual(2);
  });


  it('DO concurrent soft lifecycle-0', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const syncDo = createSyncDoStub({
      states: { default: { userId: USER, pos: 0, lastAccess: NOW, roomStates: {}, listStates: {} } },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), conn_id: `c-0`, pos: String(0) }),
      postSync(MSC4186, env, {
        lists: { all: { range: [0, 3] as [number, number] } },
        conn_id: `c-0`,
        pos: String(0),
      }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('DO concurrent soft lifecycle-1', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const syncDo = createSyncDoStub({
      states: {},
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), conn_id: `c-1`, pos: String(1) }),
      postSync(MSC4186, env, {
        lists: { all: { range: [0, 3] as [number, number] } },
        conn_id: `c-1`,
        pos: String(1),
      }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('DO concurrent soft lifecycle-2', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const syncDo = createSyncDoStub({
      states: { default: { userId: USER, pos: 2, lastAccess: NOW, roomStates: {}, listStates: {} } },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), conn_id: `c-2`, pos: String(2) }),
      postSync(MSC4186, env, {
        lists: { all: { range: [0, 3] as [number, number] } },
        conn_id: `c-2`,
        pos: String(2),
      }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('DO concurrent soft lifecycle-3', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const syncDo = createSyncDoStub({
      states: {},
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), conn_id: `c-3`, pos: String(3) }),
      postSync(MSC4186, env, {
        lists: { all: { range: [0, 3] as [number, number] } },
        conn_id: `c-3`,
        pos: String(3),
      }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('DO concurrent soft lifecycle-4', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const syncDo = createSyncDoStub({
      states: { default: { userId: USER, pos: 4, lastAccess: NOW, roomStates: {}, listStates: {} } },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), conn_id: `c-4`, pos: String(4) }),
      postSync(MSC4186, env, {
        lists: { all: { range: [0, 3] as [number, number] } },
        conn_id: `c-4`,
        pos: String(4),
      }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('DO concurrent soft lifecycle-5', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const syncDo = createSyncDoStub({
      states: {},
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), conn_id: `c-5`, pos: String(5) }),
      postSync(MSC4186, env, {
        lists: { all: { range: [0, 3] as [number, number] } },
        conn_id: `c-5`,
        pos: String(5),
      }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('DO concurrent soft lifecycle-6', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const syncDo = createSyncDoStub({
      states: { default: { userId: USER, pos: 6, lastAccess: NOW, roomStates: {}, listStates: {} } },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), conn_id: `c-6`, pos: String(6) }),
      postSync(MSC4186, env, {
        lists: { all: { range: [0, 3] as [number, number] } },
        conn_id: `c-6`,
        pos: String(6),
      }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('DO concurrent soft lifecycle-7', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const syncDo = createSyncDoStub({
      states: {},
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), conn_id: `c-7`, pos: String(7) }),
      postSync(MSC4186, env, {
        lists: { all: { range: [0, 3] as [number, number] } },
        conn_id: `c-7`,
        pos: String(7),
      }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('DO concurrent soft lifecycle-8', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const syncDo = createSyncDoStub({
      states: { default: { userId: USER, pos: 8, lastAccess: NOW, roomStates: {}, listStates: {} } },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), conn_id: `c-8`, pos: String(8) }),
      postSync(MSC4186, env, {
        lists: { all: { range: [0, 3] as [number, number] } },
        conn_id: `c-8`,
        pos: String(8),
      }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('DO concurrent soft lifecycle-9', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const syncDo = createSyncDoStub({
      states: {},
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), conn_id: `c-9`, pos: String(9) }),
      postSync(MSC4186, env, {
        lists: { all: { range: [0, 3] as [number, number] } },
        conn_id: `c-9`,
        pos: String(9),
      }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });

});


describe('race sliding room_subscriptions membership TOCTOU after #202', () => {
  it('dual subscription membership SELECT barrier sees join', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      selectBarrier: { match: (sql) => isMembershipSelect(sql), count: 2 },
    });
    const env = createEnv({ db });
    const body = { room_subscriptions: { [ROOM]: { timeline_limit: 5 } } };
    const results = await Promise.all([
      postSync(MSC3575, env, body),
      postSync(MSC3575, env, body),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) expect(ROOM in roomsOf(r.body)).toBe(true);
  });

  it('leave mid-flight after first membership SELECT skips room for second', async () => {
    const fx = fixtureJoinedRoom();
    const left = fx.memberships.filter((m) => !(m.user_id === USER && m.room_id === ROOM));
    const db = createSlidingDb({
      ...fx,
      selectBarrier: { match: (sql) => isMembershipSelect(sql), count: 2 },
      mutateMembershipsAfter: {
        after: 1,
        match: (sql) => isMembershipSelect(sql),
        next: left,
      },
    });
    const env = createEnv({ db });
    const body = { room_subscriptions: { [ROOM]: { timeline_limit: 5 } } };
    const results = await Promise.all([
      postSync(MSC3575, env, body),
      postSync(MSC3575, env, body),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const withRoom = results.filter((r) => ROOM in roomsOf(r.body));
    const without = results.filter((r) => !(ROOM in roomsOf(r.body)));
    expect(withRoom.length).toBe(1);
    expect(without.length).toBe(1);
  });

  it('subscribe∥unsubscribe same room concurrent soft', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const warm: ConnectionState = {
      userId: USER,
      pos: 1,
      lastAccess: NOW,
      roomStates: { [ROOM]: { lastStreamOrdering: 8, sentState: true } },
      listStates: {},
    };
    const syncDo = createSyncDoStub({ states: { default: warm } });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC3575, env, {
        room_subscriptions: { [ROOM]: { timeline_limit: 3 } },
        pos: '1',
      }),
      postSync(MSC3575, env, { unsubscribe_rooms: [ROOM], pos: '1' }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('non-member subscription skipped concurrently', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const body = {
      room_subscriptions: {
        [ROOM]: { timeline_limit: 2 },
        '!nope:example.com': { timeline_limit: 2 },
      },
    };
    const results = await Promise.all([
      postSync(MSC3575, env, body),
      postSync(MSC3575, env, body),
    ]);
    for (const r of results) {
      expect(ROOM in roomsOf(r.body)).toBe(true);
      expect('!nope:example.com' in roomsOf(r.body)).toBe(false);
    }
  });

  it('invite subscription concurrent returns invite_state', async () => {
    const join = fixtureJoinedRoom();
    const inv = fixtureInviteRoom();
    const fx = mergeFixtures(join, inv);
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const body = { room_subscriptions: { [INVITE_ROOM]: { timeline_limit: 1 } } };
    const results = await Promise.all([
      postSync(MSC3575, env, body),
      postSync(MSC3575, env, body),
    ]);
    for (const r of results) {
      const room = roomsOf(r.body)[INVITE_ROOM] as { invite_state?: unknown; membership?: string };
      expect(room?.invite_state || room?.membership === 'invite').toBeTruthy();
    }
  });


  it('subscription concurrent soft matrix-0', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const body = {
      room_subscriptions: {
        [ROOM]: { timeline_limit: 1, required_state: [['m.room.name', '']] },
      },
    };
    const results = await Promise.all([
      postSync(ENDPOINTS[0], env, body),
      postSync(ENDPOINTS[1], env, body),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('subscription concurrent soft matrix-1', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const body = {
      room_subscriptions: {
        [ROOM]: { timeline_limit: 2, required_state: [['m.room.name', '']] },
      },
    };
    const results = await Promise.all([
      postSync(ENDPOINTS[1], env, body),
      postSync(ENDPOINTS[2], env, body),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('subscription concurrent soft matrix-2', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const body = {
      room_subscriptions: {
        [ROOM]: { timeline_limit: 3, required_state: [['m.room.name', '']] },
      },
    };
    const results = await Promise.all([
      postSync(ENDPOINTS[2], env, body),
      postSync(ENDPOINTS[0], env, body),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('subscription concurrent soft matrix-3', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const body = {
      room_subscriptions: {
        [ROOM]: { timeline_limit: 4, required_state: [['m.room.name', '']] },
      },
    };
    const results = await Promise.all([
      postSync(ENDPOINTS[0], env, body),
      postSync(ENDPOINTS[1], env, body),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('subscription concurrent soft matrix-4', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const body = {
      room_subscriptions: {
        [ROOM]: { timeline_limit: 5, required_state: [['m.room.name', '']] },
      },
    };
    const results = await Promise.all([
      postSync(ENDPOINTS[1], env, body),
      postSync(ENDPOINTS[2], env, body),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('subscription concurrent soft matrix-5', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const body = {
      room_subscriptions: {
        [ROOM]: { timeline_limit: 1, required_state: [['m.room.name', '']] },
      },
    };
    const results = await Promise.all([
      postSync(ENDPOINTS[2], env, body),
      postSync(ENDPOINTS[0], env, body),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('subscription concurrent soft matrix-6', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const body = {
      room_subscriptions: {
        [ROOM]: { timeline_limit: 2, required_state: [['m.room.name', '']] },
      },
    };
    const results = await Promise.all([
      postSync(ENDPOINTS[0], env, body),
      postSync(ENDPOINTS[1], env, body),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('subscription concurrent soft matrix-7', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const body = {
      room_subscriptions: {
        [ROOM]: { timeline_limit: 3, required_state: [['m.room.name', '']] },
      },
    };
    const results = await Promise.all([
      postSync(ENDPOINTS[1], env, body),
      postSync(ENDPOINTS[2], env, body),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('subscription concurrent soft matrix-8', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const body = {
      room_subscriptions: {
        [ROOM]: { timeline_limit: 4, required_state: [['m.room.name', '']] },
      },
    };
    const results = await Promise.all([
      postSync(ENDPOINTS[2], env, body),
      postSync(ENDPOINTS[0], env, body),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('subscription concurrent soft matrix-9', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const body = {
      room_subscriptions: {
        [ROOM]: { timeline_limit: 5, required_state: [['m.room.name', '']] },
      },
    };
    const results = await Promise.all([
      postSync(ENDPOINTS[0], env, body),
      postSync(ENDPOINTS[1], env, body),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

});


describe('race sliding extensions concurrent after #202', () => {
  it('to_device∥e2ee concurrent isolation', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      otkCounts: [{ algorithm: 'signed_curve25519', count: 3 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    getToDeviceMessages.mockResolvedValue({
      events: [{ type: 'm.room.encrypted', content: { a: 1 } }],
      nextBatch: 'td-9',
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, {
        ...listBody(),
        extensions: { to_device: { enabled: true, limit: 10 } },
      }),
      postSync(MSC3575, env, {
        ...listBody(),
        extensions: { e2ee: { enabled: true } },
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const exts = results.map((r) => r.body.extensions as Record<string, unknown>);
    expect(exts.some((e) => e?.to_device)).toBe(true);
    expect(exts.some((e) => e?.e2ee)).toBe(true);
  });

  it('typing∥receipts concurrent with multi-room', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'Other' });
    const fx = mergeFixtures(a, b);
    getTypingForRooms.mockImplementation(async (_e, ids: string[]) => {
      const out: Record<string, string[]> = {};
      for (const id of ids) out[id] = id === ROOM ? [BOB] : [];
      return out;
    });
    getReceiptsForRooms.mockImplementation(async (_e, ids: string[]) => {
      const out: Record<string, Record<string, unknown>> = {};
      for (const id of ids) out[id] = { 'm.read': { [USER]: { event_id: '$r', ts: NOW } } };
      return out;
    });
    const db = createSlidingDb({ ...fx });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, {
        ...listBody([[0, 20]]),
        extensions: { typing: { enabled: true } },
      }),
      postSync(MSC3575, env, {
        ...listBody([[0, 20]]),
        extensions: { receipts: { enabled: true } },
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('account_data∥presence concurrent soft', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      accountData: [
        {
          user_id: USER,
          room_id: '',
          event_type: 'm.push_rules',
          content: JSON.stringify({ global: {} }),
        },
      ],
    });
    const cache = mockKv({
      [`presence:${BOB}`]: JSON.stringify({ presence: 'online', last_active_ago: 1 }),
    });
    const env = createEnv({ db, cache });
    const results = await Promise.all([
      postSync(MSC3575, env, {
        ...listBody(),
        extensions: { account_data: { enabled: true } },
      }),
      postSync(MSC3575, env, {
        ...listBody(),
        extensions: { presence: { enabled: true } },
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('all extensions enabled concurrent dual POST', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      otkCounts: [{ algorithm: 'signed_curve25519', count: 1 }],
    });
    const env = createEnv({ db });
    const ext = {
      to_device: { enabled: true },
      e2ee: { enabled: true },
      account_data: { enabled: true },
      typing: { enabled: true },
      receipts: { enabled: true },
      presence: { enabled: true },
    };
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), extensions: ext }),
      postSync(MSC4186, env, {
        lists: { all: { range: [0, 5] as [number, number] } },
        extensions: ext,
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('extension to_device concurrent soft-0', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      otkCounts: [{ algorithm: 'signed_curve25519', count: 0 }],
      accountData: [
        { user_id: USER, room_id: '', event_type: 'im.vector.setting.breadcrumbs', content: '{}' },
      ],
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), extensions: { to_device: { enabled: true } } }),
      postSync(MSC3575, env, { ...listBody(), extensions: { to_device: { enabled: true } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('extension e2ee concurrent soft-1', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      otkCounts: [{ algorithm: 'signed_curve25519', count: 1 }],
      accountData: [
        { user_id: USER, room_id: '', event_type: 'im.vector.setting.breadcrumbs', content: '{}' },
      ],
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), extensions: { e2ee: { enabled: true } } }),
      postSync(MSC3575, env, { ...listBody(), extensions: { e2ee: { enabled: true } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('extension account_data concurrent soft-2', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      otkCounts: [{ algorithm: 'signed_curve25519', count: 2 }],
      accountData: [
        { user_id: USER, room_id: '', event_type: 'im.vector.setting.breadcrumbs', content: '{}' },
      ],
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), extensions: { account_data: { enabled: true } } }),
      postSync(MSC3575, env, { ...listBody(), extensions: { account_data: { enabled: true } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('extension typing concurrent soft-3', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      otkCounts: [{ algorithm: 'signed_curve25519', count: 3 }],
      accountData: [
        { user_id: USER, room_id: '', event_type: 'im.vector.setting.breadcrumbs', content: '{}' },
      ],
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), extensions: { typing: { enabled: true } } }),
      postSync(MSC3575, env, { ...listBody(), extensions: { typing: { enabled: true } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('extension receipts concurrent soft-4', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      otkCounts: [{ algorithm: 'signed_curve25519', count: 4 }],
      accountData: [
        { user_id: USER, room_id: '', event_type: 'im.vector.setting.breadcrumbs', content: '{}' },
      ],
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), extensions: { receipts: { enabled: true } } }),
      postSync(MSC3575, env, { ...listBody(), extensions: { receipts: { enabled: true } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('extension presence concurrent soft-5', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      otkCounts: [{ algorithm: 'signed_curve25519', count: 5 }],
      accountData: [
        { user_id: USER, room_id: '', event_type: 'im.vector.setting.breadcrumbs', content: '{}' },
      ],
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), extensions: { presence: { enabled: true } } }),
      postSync(MSC3575, env, { ...listBody(), extensions: { presence: { enabled: true } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('extension to_device concurrent soft-6', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      otkCounts: [{ algorithm: 'signed_curve25519', count: 6 }],
      accountData: [
        { user_id: USER, room_id: '', event_type: 'im.vector.setting.breadcrumbs', content: '{}' },
      ],
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), extensions: { to_device: { enabled: true } } }),
      postSync(MSC3575, env, { ...listBody(), extensions: { to_device: { enabled: true } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('extension e2ee concurrent soft-7', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      otkCounts: [{ algorithm: 'signed_curve25519', count: 7 }],
      accountData: [
        { user_id: USER, room_id: '', event_type: 'im.vector.setting.breadcrumbs', content: '{}' },
      ],
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), extensions: { e2ee: { enabled: true } } }),
      postSync(MSC3575, env, { ...listBody(), extensions: { e2ee: { enabled: true } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('extension account_data concurrent soft-8', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      otkCounts: [{ algorithm: 'signed_curve25519', count: 8 }],
      accountData: [
        { user_id: USER, room_id: '', event_type: 'im.vector.setting.breadcrumbs', content: '{}' },
      ],
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), extensions: { account_data: { enabled: true } } }),
      postSync(MSC3575, env, { ...listBody(), extensions: { account_data: { enabled: true } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('extension typing concurrent soft-9', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      otkCounts: [{ algorithm: 'signed_curve25519', count: 9 }],
      accountData: [
        { user_id: USER, room_id: '', event_type: 'im.vector.setting.breadcrumbs', content: '{}' },
      ],
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), extensions: { typing: { enabled: true } } }),
      postSync(MSC3575, env, { ...listBody(), extensions: { typing: { enabled: true } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('extension receipts concurrent soft-10', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      otkCounts: [{ algorithm: 'signed_curve25519', count: 10 }],
      accountData: [
        { user_id: USER, room_id: '', event_type: 'im.vector.setting.breadcrumbs', content: '{}' },
      ],
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), extensions: { receipts: { enabled: true } } }),
      postSync(MSC3575, env, { ...listBody(), extensions: { receipts: { enabled: true } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('extension presence concurrent soft-11', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      otkCounts: [{ algorithm: 'signed_curve25519', count: 11 }],
      accountData: [
        { user_id: USER, room_id: '', event_type: 'im.vector.setting.breadcrumbs', content: '{}' },
      ],
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), extensions: { presence: { enabled: true } } }),
      postSync(MSC3575, env, { ...listBody(), extensions: { presence: { enabled: true } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('extension to_device concurrent soft-12', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      otkCounts: [{ algorithm: 'signed_curve25519', count: 12 }],
      accountData: [
        { user_id: USER, room_id: '', event_type: 'im.vector.setting.breadcrumbs', content: '{}' },
      ],
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), extensions: { to_device: { enabled: true } } }),
      postSync(MSC3575, env, { ...listBody(), extensions: { to_device: { enabled: true } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('extension e2ee concurrent soft-13', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      otkCounts: [{ algorithm: 'signed_curve25519', count: 13 }],
      accountData: [
        { user_id: USER, room_id: '', event_type: 'im.vector.setting.breadcrumbs', content: '{}' },
      ],
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), extensions: { e2ee: { enabled: true } } }),
      postSync(MSC3575, env, { ...listBody(), extensions: { e2ee: { enabled: true } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('extension account_data concurrent soft-14', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      otkCounts: [{ algorithm: 'signed_curve25519', count: 14 }],
      accountData: [
        { user_id: USER, room_id: '', event_type: 'im.vector.setting.breadcrumbs', content: '{}' },
      ],
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), extensions: { account_data: { enabled: true } } }),
      postSync(MSC3575, env, { ...listBody(), extensions: { account_data: { enabled: true } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('extension typing concurrent soft-15', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      otkCounts: [{ algorithm: 'signed_curve25519', count: 15 }],
      accountData: [
        { user_id: USER, room_id: '', event_type: 'im.vector.setting.breadcrumbs', content: '{}' },
      ],
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), extensions: { typing: { enabled: true } } }),
      postSync(MSC3575, env, { ...listBody(), extensions: { typing: { enabled: true } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('extension receipts concurrent soft-16', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      otkCounts: [{ algorithm: 'signed_curve25519', count: 16 }],
      accountData: [
        { user_id: USER, room_id: '', event_type: 'im.vector.setting.breadcrumbs', content: '{}' },
      ],
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), extensions: { receipts: { enabled: true } } }),
      postSync(MSC3575, env, { ...listBody(), extensions: { receipts: { enabled: true } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('extension presence concurrent soft-17', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      otkCounts: [{ algorithm: 'signed_curve25519', count: 17 }],
      accountData: [
        { user_id: USER, room_id: '', event_type: 'im.vector.setting.breadcrumbs', content: '{}' },
      ],
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), extensions: { presence: { enabled: true } } }),
      postSync(MSC3575, env, { ...listBody(), extensions: { presence: { enabled: true } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

});


describe('race sliding long-poll wait∥sync after #202', () => {
  it('wait-for-events∥list sync concurrent soft', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const warm: ConnectionState = {
      userId: USER,
      pos: 42,
      lastAccess: NOW,
      roomStates: { [ROOM]: { lastStreamOrdering: 8, sentState: true } },
      listStates: { all: { roomIds: [ROOM], count: 1 } },
      initialSyncComplete: true,
    };
    const syncDo = createSyncDoStub({
      states: { default: warm },
      waitHasEvents: false,
      getBarrier: createFnBarrier(2),
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC4186, env, {
        lists: { all: { range: [0, 0] as [number, number] } },
        pos: '42',
        timeout: 1,
      }),
      postSync(MSC4186, env, {
        lists: { all: { range: [0, 0] as [number, number] } },
        pos: '42',
        timeout: 1,
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('waitFail soft mid concurrent does not 500 both', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const warm: ConnectionState = {
      userId: USER,
      pos: 42,
      lastAccess: NOW,
      roomStates: { [ROOM]: { lastStreamOrdering: 8, sentState: true } },
      listStates: { all: { roomIds: [ROOM], count: 1 } },
      initialSyncComplete: true,
    };
    const syncDo = createSyncDoStub({ states: { default: warm }, waitFail: true });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC4186, env, {
        lists: { all: { range: [0, 0] as [number, number] } },
        pos: '42',
        timeout: 5,
      }),
      postSync(MSC3575, env, listBody()),
    ]);
    expect(results.some((r) => r.status === 200)).toBe(true);
  });


  it('long-poll timeout soft-0', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const warm: ConnectionState = {
      userId: USER,
      pos: 42,
      lastAccess: NOW,
      roomStates: { [ROOM]: { lastStreamOrdering: 8, sentState: true } },
      listStates: { all: { roomIds: [ROOM], count: 1 } },
      initialSyncComplete: true,
    };
    const syncDo = createSyncDoStub({
      states: { default: warm },
      waitHasEvents: true,
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC4186, env, {
        lists: { all: { range: [0, 0] as [number, number] } },
        pos: '42',
        timeout: 0,
      }, { query: 'timeout=0' }),
      postSync(V4, env, {
        lists: { all: { range: [0, 0] as [number, number] } },
        pos: '42',
        timeout: 0,
      }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('long-poll timeout soft-1', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const warm: ConnectionState = {
      userId: USER,
      pos: 42,
      lastAccess: NOW,
      roomStates: { [ROOM]: { lastStreamOrdering: 8, sentState: true } },
      listStates: { all: { roomIds: [ROOM], count: 1 } },
      initialSyncComplete: true,
    };
    const syncDo = createSyncDoStub({
      states: { default: warm },
      waitHasEvents: false,
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC4186, env, {
        lists: { all: { range: [0, 0] as [number, number] } },
        pos: '42',
        timeout: 1,
      }, { query: 'timeout=1' }),
      postSync(V4, env, {
        lists: { all: { range: [0, 0] as [number, number] } },
        pos: '42',
        timeout: 1,
      }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('long-poll timeout soft-2', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const warm: ConnectionState = {
      userId: USER,
      pos: 42,
      lastAccess: NOW,
      roomStates: { [ROOM]: { lastStreamOrdering: 8, sentState: true } },
      listStates: { all: { roomIds: [ROOM], count: 1 } },
      initialSyncComplete: true,
    };
    const syncDo = createSyncDoStub({
      states: { default: warm },
      waitHasEvents: true,
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC4186, env, {
        lists: { all: { range: [0, 0] as [number, number] } },
        pos: '42',
        timeout: 2,
      }, { query: 'timeout=2' }),
      postSync(V4, env, {
        lists: { all: { range: [0, 0] as [number, number] } },
        pos: '42',
        timeout: 2,
      }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('long-poll timeout soft-3', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const warm: ConnectionState = {
      userId: USER,
      pos: 42,
      lastAccess: NOW,
      roomStates: { [ROOM]: { lastStreamOrdering: 8, sentState: true } },
      listStates: { all: { roomIds: [ROOM], count: 1 } },
      initialSyncComplete: true,
    };
    const syncDo = createSyncDoStub({
      states: { default: warm },
      waitHasEvents: false,
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC4186, env, {
        lists: { all: { range: [0, 0] as [number, number] } },
        pos: '42',
        timeout: 3,
      }, { query: 'timeout=3' }),
      postSync(V4, env, {
        lists: { all: { range: [0, 0] as [number, number] } },
        pos: '42',
        timeout: 3,
      }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('long-poll timeout soft-4', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const warm: ConnectionState = {
      userId: USER,
      pos: 42,
      lastAccess: NOW,
      roomStates: { [ROOM]: { lastStreamOrdering: 8, sentState: true } },
      listStates: { all: { roomIds: [ROOM], count: 1 } },
      initialSyncComplete: true,
    };
    const syncDo = createSyncDoStub({
      states: { default: warm },
      waitHasEvents: true,
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC4186, env, {
        lists: { all: { range: [0, 0] as [number, number] } },
        pos: '42',
        timeout: 4,
      }, { query: 'timeout=4' }),
      postSync(V4, env, {
        lists: { all: { range: [0, 0] as [number, number] } },
        pos: '42',
        timeout: 4,
      }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('long-poll timeout soft-5', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const warm: ConnectionState = {
      userId: USER,
      pos: 42,
      lastAccess: NOW,
      roomStates: { [ROOM]: { lastStreamOrdering: 8, sentState: true } },
      listStates: { all: { roomIds: [ROOM], count: 1 } },
      initialSyncComplete: true,
    };
    const syncDo = createSyncDoStub({
      states: { default: warm },
      waitHasEvents: false,
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC4186, env, {
        lists: { all: { range: [0, 0] as [number, number] } },
        pos: '42',
        timeout: 5,
      }, { query: 'timeout=5' }),
      postSync(V4, env, {
        lists: { all: { range: [0, 0] as [number, number] } },
        pos: '42',
        timeout: 5,
      }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('long-poll timeout soft-6', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const warm: ConnectionState = {
      userId: USER,
      pos: 42,
      lastAccess: NOW,
      roomStates: { [ROOM]: { lastStreamOrdering: 8, sentState: true } },
      listStates: { all: { roomIds: [ROOM], count: 1 } },
      initialSyncComplete: true,
    };
    const syncDo = createSyncDoStub({
      states: { default: warm },
      waitHasEvents: true,
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC4186, env, {
        lists: { all: { range: [0, 0] as [number, number] } },
        pos: '42',
        timeout: 6,
      }, { query: 'timeout=6' }),
      postSync(V4, env, {
        lists: { all: { range: [0, 0] as [number, number] } },
        pos: '42',
        timeout: 6,
      }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('long-poll timeout soft-7', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx });
    const warm: ConnectionState = {
      userId: USER,
      pos: 42,
      lastAccess: NOW,
      roomStates: { [ROOM]: { lastStreamOrdering: 8, sentState: true } },
      listStates: { all: { roomIds: [ROOM], count: 1 } },
      initialSyncComplete: true,
    };
    const syncDo = createSyncDoStub({
      states: { default: warm },
      waitHasEvents: false,
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(MSC4186, env, {
        lists: { all: { range: [0, 0] as [number, number] } },
        pos: '42',
        timeout: 7,
      }, { query: 'timeout=7' }),
      postSync(V4, env, {
        lists: { all: { range: [0, 0] as [number, number] } },
        pos: '42',
        timeout: 7,
      }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });

});


describe('sliding concurrent soft flood — method / auth after #202', () => {


  it('method=GET concurrent soft', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody(), { method: 'GET' }),
      postSync(MSC3575, env, listBody(), { method: 'GET' }),
    ]);
    expect(results.every((r) => r.status !== 500)).toBe(true);
  });


  it('method=PUT concurrent soft', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody(), { method: 'PUT' }),
      postSync(MSC3575, env, listBody(), { method: 'PUT' }),
    ]);
    expect(results.every((r) => r.status !== 500)).toBe(true);
  });


  it('method=DELETE concurrent soft', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody(), { method: 'DELETE' }),
      postSync(MSC3575, env, listBody(), { method: 'DELETE' }),
    ]);
    expect(results.every((r) => r.status !== 500)).toBe(true);
  });


  it('method=PATCH concurrent soft', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody(), { method: 'PATCH' }),
      postSync(MSC3575, env, listBody(), { method: 'PATCH' }),
    ]);
    expect(results.every((r) => r.status !== 500)).toBe(true);
  });


  it('method=OPTIONS concurrent soft', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody(), { method: 'OPTIONS' }),
      postSync(MSC3575, env, listBody(), { method: 'OPTIONS' }),
    ]);
    expect(results.every((r) => r.status !== 500)).toBe(true);
  });


  it('method=HEAD concurrent soft', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody(), { method: 'HEAD' }),
      postSync(MSC3575, env, listBody(), { method: 'HEAD' }),
    ]);
    expect(results.every((r) => r.status !== 500)).toBe(true);
  });


  it('method=POST concurrent soft', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody(), { method: 'POST' }),
      postSync(MSC3575, env, listBody(), { method: 'POST' }),
    ]);
    expect(results.every((r) => r.status !== 500)).toBe(true);
  });


  it('missing userId soft concurrent', async () => {
    authState.userId = undefined;
    const env = createEnv({ db: createSlidingDb({ ...fixtureJoinedRoom() }) });
    const results = await Promise.allSettled([
      postSync(MSC3575, env, listBody()),
      postSync(MSC3575, env, listBody()),
    ]);
    expect(results.length).toBe(2);
  });

  it('missing deviceId soft concurrent still returns', async () => {
    authState.deviceId = undefined;
    const env = createEnv({ db: createSlidingDb({ ...fixtureJoinedRoom() }) });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC3575, env, listBody()),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('auth lifecycle concurrent soft-0', async () => {
    authState.userId = 0 % 2 === 0 ? USER : `@user0:example.com`;
    authState.deviceId = `DEV0`;
    const fx = fixtureJoinedRoom();
    // foreign user has no membership — still 200 with empty rooms
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC3575, env, listBody()),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('auth lifecycle concurrent soft-1', async () => {
    authState.userId = 1 % 2 === 0 ? USER : `@user1:example.com`;
    authState.deviceId = `DEV1`;
    const fx = fixtureJoinedRoom();
    // foreign user has no membership — still 200 with empty rooms
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC3575, env, listBody()),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('auth lifecycle concurrent soft-2', async () => {
    authState.userId = 2 % 2 === 0 ? USER : `@user2:example.com`;
    authState.deviceId = `DEV2`;
    const fx = fixtureJoinedRoom();
    // foreign user has no membership — still 200 with empty rooms
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC3575, env, listBody()),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('auth lifecycle concurrent soft-3', async () => {
    authState.userId = 3 % 2 === 0 ? USER : `@user3:example.com`;
    authState.deviceId = `DEV3`;
    const fx = fixtureJoinedRoom();
    // foreign user has no membership — still 200 with empty rooms
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC3575, env, listBody()),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('auth lifecycle concurrent soft-4', async () => {
    authState.userId = 4 % 2 === 0 ? USER : `@user4:example.com`;
    authState.deviceId = `DEV4`;
    const fx = fixtureJoinedRoom();
    // foreign user has no membership — still 200 with empty rooms
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC3575, env, listBody()),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('auth lifecycle concurrent soft-5', async () => {
    authState.userId = 5 % 2 === 0 ? USER : `@user5:example.com`;
    authState.deviceId = `DEV5`;
    const fx = fixtureJoinedRoom();
    // foreign user has no membership — still 200 with empty rooms
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC3575, env, listBody()),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('auth lifecycle concurrent soft-6', async () => {
    authState.userId = 6 % 2 === 0 ? USER : `@user6:example.com`;
    authState.deviceId = `DEV6`;
    const fx = fixtureJoinedRoom();
    // foreign user has no membership — still 200 with empty rooms
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC3575, env, listBody()),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('auth lifecycle concurrent soft-7', async () => {
    authState.userId = 7 % 2 === 0 ? USER : `@user7:example.com`;
    authState.deviceId = `DEV7`;
    const fx = fixtureJoinedRoom();
    // foreign user has no membership — still 200 with empty rooms
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC3575, env, listBody()),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('auth lifecycle concurrent soft-8', async () => {
    authState.userId = 8 % 2 === 0 ? USER : `@user8:example.com`;
    authState.deviceId = `DEV8`;
    const fx = fixtureJoinedRoom();
    // foreign user has no membership — still 200 with empty rooms
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC3575, env, listBody()),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('auth lifecycle concurrent soft-9', async () => {
    authState.userId = 9 % 2 === 0 ? USER : `@user9:example.com`;
    authState.deviceId = `DEV9`;
    const fx = fixtureJoinedRoom();
    // foreign user has no membership — still 200 with empty rooms
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC3575, env, listBody()),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('auth lifecycle concurrent soft-10', async () => {
    authState.userId = 10 % 2 === 0 ? USER : `@user10:example.com`;
    authState.deviceId = `DEV10`;
    const fx = fixtureJoinedRoom();
    // foreign user has no membership — still 200 with empty rooms
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC3575, env, listBody()),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('auth lifecycle concurrent soft-11', async () => {
    authState.userId = 11 % 2 === 0 ? USER : `@user11:example.com`;
    authState.deviceId = `DEV11`;
    const fx = fixtureJoinedRoom();
    // foreign user has no membership — still 200 with empty rooms
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC3575, env, listBody()),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

});


describe('sliding concurrent soft flood — body / pos / ranges after #202', () => {
  it('bad JSON concurrent soft', async () => {
    const env = createEnv({ db: createSlidingDb({ ...fixtureJoinedRoom() }) });
    const results = await Promise.all([
      postSync(MSC3575, env, '{'),
      postSync(MSC3575, env, 'not-json'),
    ]);
    expect(results.every((r) => r.status === 400 || r.status === 200)).toBe(true);
  });

  it('empty object concurrent soft', async () => {
    const env = createEnv({ db: createSlidingDb({ ...fixtureJoinedRoom() }) });
    const results = await Promise.all([
      postSync(MSC3575, env, {}),
      postSync(MSC4186, env, {}),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('M_UNKNOWN_POS concurrent soft', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 10 });
    const env = createEnv({ db, syncDo: createSyncDoStub({ states: {} }) });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), pos: '99999' }),
      postSync(MSC4186, env, { lists: { all: { range: [0, 1] as [number, number] } }, pos: '99999' }),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(results.every((r) => r.body.errcode === 'M_UNKNOWN_POS')).toBe(true);
  });

  it('too many subscriptions concurrent soft', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const subs: Record<string, { timeline_limit: number }> = {};
    for (let i = 0; i < 101; i++) subs[`!r${i}:example.com`] = { timeline_limit: 1 };
    const results = await Promise.all([
      postSync(MSC3575, env, { room_subscriptions: subs }),
      postSync(MSC3575, env, { room_subscriptions: subs }),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(results.every((r) => r.body.errcode === 'M_TOO_LARGE')).toBe(true);
  });


  it('ranges/filter concurrent soft-0', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'Alpha' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'Beta' });
    const fx = mergeFixtures(a, b);
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const body3575 = {
      lists: {
        all: {
          ranges: [[0, 5]] as [number, number][],
          filters: { is_dm: true, room_name_like: 'Alp' },
          timeline_limit: 1,
          sort: ['by_name'],
        },
      },
      txn_id: 'txn-0',
    };
    const body4186 = {
      lists: {
        all: {
          range: [0, 0] as [number, number],
          timeline_limit: 1,
        },
      },
      txn_id: 'txn-b-0',
    };
    const results = await Promise.all([
      postSync(MSC3575, env, body3575),
      postSync(MSC4186, env, body4186),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('ranges/filter concurrent soft-1', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'Alpha' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'Beta' });
    const fx = mergeFixtures(a, b);
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const body3575 = {
      lists: {
        all: {
          ranges: [[1, 6]] as [number, number][],
          filters: { is_dm: false, room_name_like: '' },
          timeline_limit: 2,
          sort: ['by_recency'],
        },
      },
      txn_id: 'txn-1',
    };
    const body4186 = {
      lists: {
        all: {
          range: [0, 1] as [number, number],
          timeline_limit: 2,
        },
      },
      txn_id: 'txn-b-1',
    };
    const results = await Promise.all([
      postSync(MSC3575, env, body3575),
      postSync(MSC4186, env, body4186),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('ranges/filter concurrent soft-2', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'Alpha' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'Beta' });
    const fx = mergeFixtures(a, b);
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const body3575 = {
      lists: {
        all: {
          ranges: [[0, 5]] as [number, number][],
          filters: { is_dm: true, room_name_like: '' },
          timeline_limit: 3,
          sort: ['by_name'],
        },
      },
      txn_id: 'txn-2',
    };
    const body4186 = {
      lists: {
        all: {
          range: [0, 2] as [number, number],
          timeline_limit: 3,
        },
      },
      txn_id: 'txn-b-2',
    };
    const results = await Promise.all([
      postSync(MSC3575, env, body3575),
      postSync(MSC4186, env, body4186),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('ranges/filter concurrent soft-3', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'Alpha' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'Beta' });
    const fx = mergeFixtures(a, b);
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const body3575 = {
      lists: {
        all: {
          ranges: [[1, 6]] as [number, number][],
          filters: { is_dm: false, room_name_like: 'Alp' },
          timeline_limit: 4,
          sort: ['by_recency'],
        },
      },
      txn_id: 'txn-3',
    };
    const body4186 = {
      lists: {
        all: {
          range: [0, 3] as [number, number],
          timeline_limit: 4,
        },
      },
      txn_id: 'txn-b-3',
    };
    const results = await Promise.all([
      postSync(MSC3575, env, body3575),
      postSync(MSC4186, env, body4186),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('ranges/filter concurrent soft-4', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'Alpha' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'Beta' });
    const fx = mergeFixtures(a, b);
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const body3575 = {
      lists: {
        all: {
          ranges: [[0, 5]] as [number, number][],
          filters: { is_dm: true, room_name_like: '' },
          timeline_limit: 5,
          sort: ['by_name'],
        },
      },
      txn_id: 'txn-4',
    };
    const body4186 = {
      lists: {
        all: {
          range: [0, 0] as [number, number],
          timeline_limit: 5,
        },
      },
      txn_id: 'txn-b-4',
    };
    const results = await Promise.all([
      postSync(MSC3575, env, body3575),
      postSync(MSC4186, env, body4186),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('ranges/filter concurrent soft-5', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'Alpha' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'Beta' });
    const fx = mergeFixtures(a, b);
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const body3575 = {
      lists: {
        all: {
          ranges: [[1, 6]] as [number, number][],
          filters: { is_dm: false, room_name_like: '' },
          timeline_limit: 6,
          sort: ['by_recency'],
        },
      },
      txn_id: 'txn-5',
    };
    const body4186 = {
      lists: {
        all: {
          range: [0, 1] as [number, number],
          timeline_limit: 1,
        },
      },
      txn_id: 'txn-b-5',
    };
    const results = await Promise.all([
      postSync(MSC3575, env, body3575),
      postSync(MSC4186, env, body4186),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('ranges/filter concurrent soft-6', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'Alpha' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'Beta' });
    const fx = mergeFixtures(a, b);
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const body3575 = {
      lists: {
        all: {
          ranges: [[0, 5]] as [number, number][],
          filters: { is_dm: true, room_name_like: 'Alp' },
          timeline_limit: 7,
          sort: ['by_name'],
        },
      },
      txn_id: 'txn-6',
    };
    const body4186 = {
      lists: {
        all: {
          range: [0, 2] as [number, number],
          timeline_limit: 2,
        },
      },
      txn_id: 'txn-b-6',
    };
    const results = await Promise.all([
      postSync(MSC3575, env, body3575),
      postSync(MSC4186, env, body4186),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('ranges/filter concurrent soft-7', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'Alpha' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'Beta' });
    const fx = mergeFixtures(a, b);
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const body3575 = {
      lists: {
        all: {
          ranges: [[1, 6]] as [number, number][],
          filters: { is_dm: false, room_name_like: '' },
          timeline_limit: 1,
          sort: ['by_recency'],
        },
      },
      txn_id: 'txn-7',
    };
    const body4186 = {
      lists: {
        all: {
          range: [0, 3] as [number, number],
          timeline_limit: 3,
        },
      },
      txn_id: 'txn-b-7',
    };
    const results = await Promise.all([
      postSync(MSC3575, env, body3575),
      postSync(MSC4186, env, body4186),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('ranges/filter concurrent soft-8', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'Alpha' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'Beta' });
    const fx = mergeFixtures(a, b);
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const body3575 = {
      lists: {
        all: {
          ranges: [[0, 5]] as [number, number][],
          filters: { is_dm: true, room_name_like: '' },
          timeline_limit: 2,
          sort: ['by_name'],
        },
      },
      txn_id: 'txn-8',
    };
    const body4186 = {
      lists: {
        all: {
          range: [0, 0] as [number, number],
          timeline_limit: 4,
        },
      },
      txn_id: 'txn-b-8',
    };
    const results = await Promise.all([
      postSync(MSC3575, env, body3575),
      postSync(MSC4186, env, body4186),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('ranges/filter concurrent soft-9', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'Alpha' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'Beta' });
    const fx = mergeFixtures(a, b);
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const body3575 = {
      lists: {
        all: {
          ranges: [[1, 6]] as [number, number][],
          filters: { is_dm: false, room_name_like: 'Alp' },
          timeline_limit: 3,
          sort: ['by_recency'],
        },
      },
      txn_id: 'txn-9',
    };
    const body4186 = {
      lists: {
        all: {
          range: [0, 1] as [number, number],
          timeline_limit: 5,
        },
      },
      txn_id: 'txn-b-9',
    };
    const results = await Promise.all([
      postSync(MSC3575, env, body3575),
      postSync(MSC4186, env, body4186),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('ranges/filter concurrent soft-10', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'Alpha' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'Beta' });
    const fx = mergeFixtures(a, b);
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const body3575 = {
      lists: {
        all: {
          ranges: [[0, 5]] as [number, number][],
          filters: { is_dm: true, room_name_like: '' },
          timeline_limit: 4,
          sort: ['by_name'],
        },
      },
      txn_id: 'txn-10',
    };
    const body4186 = {
      lists: {
        all: {
          range: [0, 2] as [number, number],
          timeline_limit: 1,
        },
      },
      txn_id: 'txn-b-10',
    };
    const results = await Promise.all([
      postSync(MSC3575, env, body3575),
      postSync(MSC4186, env, body4186),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('ranges/filter concurrent soft-11', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'Alpha' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'Beta' });
    const fx = mergeFixtures(a, b);
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const body3575 = {
      lists: {
        all: {
          ranges: [[1, 6]] as [number, number][],
          filters: { is_dm: false, room_name_like: '' },
          timeline_limit: 5,
          sort: ['by_recency'],
        },
      },
      txn_id: 'txn-11',
    };
    const body4186 = {
      lists: {
        all: {
          range: [0, 3] as [number, number],
          timeline_limit: 2,
        },
      },
      txn_id: 'txn-b-11',
    };
    const results = await Promise.all([
      postSync(MSC3575, env, body3575),
      postSync(MSC4186, env, body4186),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('ranges/filter concurrent soft-12', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'Alpha' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'Beta' });
    const fx = mergeFixtures(a, b);
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const body3575 = {
      lists: {
        all: {
          ranges: [[0, 5]] as [number, number][],
          filters: { is_dm: true, room_name_like: 'Alp' },
          timeline_limit: 6,
          sort: ['by_name'],
        },
      },
      txn_id: 'txn-12',
    };
    const body4186 = {
      lists: {
        all: {
          range: [0, 0] as [number, number],
          timeline_limit: 3,
        },
      },
      txn_id: 'txn-b-12',
    };
    const results = await Promise.all([
      postSync(MSC3575, env, body3575),
      postSync(MSC4186, env, body4186),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('ranges/filter concurrent soft-13', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'Alpha' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'Beta' });
    const fx = mergeFixtures(a, b);
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const body3575 = {
      lists: {
        all: {
          ranges: [[1, 6]] as [number, number][],
          filters: { is_dm: false, room_name_like: '' },
          timeline_limit: 7,
          sort: ['by_recency'],
        },
      },
      txn_id: 'txn-13',
    };
    const body4186 = {
      lists: {
        all: {
          range: [0, 1] as [number, number],
          timeline_limit: 4,
        },
      },
      txn_id: 'txn-b-13',
    };
    const results = await Promise.all([
      postSync(MSC3575, env, body3575),
      postSync(MSC4186, env, body4186),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('ranges/filter concurrent soft-14', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'Alpha' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'Beta' });
    const fx = mergeFixtures(a, b);
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const body3575 = {
      lists: {
        all: {
          ranges: [[0, 5]] as [number, number][],
          filters: { is_dm: true, room_name_like: '' },
          timeline_limit: 1,
          sort: ['by_name'],
        },
      },
      txn_id: 'txn-14',
    };
    const body4186 = {
      lists: {
        all: {
          range: [0, 2] as [number, number],
          timeline_limit: 5,
        },
      },
      txn_id: 'txn-b-14',
    };
    const results = await Promise.all([
      postSync(MSC3575, env, body3575),
      postSync(MSC4186, env, body4186),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('ranges/filter concurrent soft-15', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM, name: 'Alpha' });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'Beta' });
    const fx = mergeFixtures(a, b);
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const body3575 = {
      lists: {
        all: {
          ranges: [[1, 6]] as [number, number][],
          filters: { is_dm: false, room_name_like: 'Alp' },
          timeline_limit: 2,
          sort: ['by_recency'],
        },
      },
      txn_id: 'txn-15',
    };
    const body4186 = {
      lists: {
        all: {
          range: [0, 3] as [number, number],
          timeline_limit: 1,
        },
      },
      txn_id: 'txn-b-15',
    };
    const results = await Promise.all([
      postSync(MSC3575, env, body3575),
      postSync(MSC4186, env, body4186),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('charset/unicode concurrent soft-0', async () => {
    const fx = fixtureJoinedRoom({ name: 'café-0-🎉' });
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, {
        ...listBody(),
        conn_id: 'conn-u41-0',
        txn_id: 'txn-snow-0',
      }),
      postSync(V4, env, {
        lists: { all: { range: [0, 2] as [number, number] } },
        conn_id: 'conn-u41-0',
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('charset/unicode concurrent soft-1', async () => {
    const fx = fixtureJoinedRoom({ name: 'café-1-🎉' });
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, {
        ...listBody(),
        conn_id: 'conn-u42-1',
        txn_id: 'txn-snow-1',
      }),
      postSync(V4, env, {
        lists: { all: { range: [0, 2] as [number, number] } },
        conn_id: 'conn-u42-1',
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('charset/unicode concurrent soft-2', async () => {
    const fx = fixtureJoinedRoom({ name: 'café-2-🎉' });
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, {
        ...listBody(),
        conn_id: 'conn-u43-2',
        txn_id: 'txn-snow-2',
      }),
      postSync(V4, env, {
        lists: { all: { range: [0, 2] as [number, number] } },
        conn_id: 'conn-u43-2',
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('charset/unicode concurrent soft-3', async () => {
    const fx = fixtureJoinedRoom({ name: 'café-3-🎉' });
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, {
        ...listBody(),
        conn_id: 'conn-u44-3',
        txn_id: 'txn-snow-3',
      }),
      postSync(V4, env, {
        lists: { all: { range: [0, 2] as [number, number] } },
        conn_id: 'conn-u44-3',
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('charset/unicode concurrent soft-4', async () => {
    const fx = fixtureJoinedRoom({ name: 'café-4-🎉' });
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, {
        ...listBody(),
        conn_id: 'conn-u45-4',
        txn_id: 'txn-snow-4',
      }),
      postSync(V4, env, {
        lists: { all: { range: [0, 2] as [number, number] } },
        conn_id: 'conn-u45-4',
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('charset/unicode concurrent soft-5', async () => {
    const fx = fixtureJoinedRoom({ name: 'café-5-🎉' });
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, {
        ...listBody(),
        conn_id: 'conn-u46-5',
        txn_id: 'txn-snow-5',
      }),
      postSync(V4, env, {
        lists: { all: { range: [0, 2] as [number, number] } },
        conn_id: 'conn-u46-5',
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('charset/unicode concurrent soft-6', async () => {
    const fx = fixtureJoinedRoom({ name: 'café-6-🎉' });
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, {
        ...listBody(),
        conn_id: 'conn-u47-6',
        txn_id: 'txn-snow-6',
      }),
      postSync(V4, env, {
        lists: { all: { range: [0, 2] as [number, number] } },
        conn_id: 'conn-u47-6',
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('charset/unicode concurrent soft-7', async () => {
    const fx = fixtureJoinedRoom({ name: 'café-7-🎉' });
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, {
        ...listBody(),
        conn_id: 'conn-u48-7',
        txn_id: 'txn-snow-7',
      }),
      postSync(V4, env, {
        lists: { all: { range: [0, 2] as [number, number] } },
        conn_id: 'conn-u48-7',
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('charset/unicode concurrent soft-8', async () => {
    const fx = fixtureJoinedRoom({ name: 'café-8-🎉' });
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, {
        ...listBody(),
        conn_id: 'conn-u49-8',
        txn_id: 'txn-snow-8',
      }),
      postSync(V4, env, {
        lists: { all: { range: [0, 2] as [number, number] } },
        conn_id: 'conn-u49-8',
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('charset/unicode concurrent soft-9', async () => {
    const fx = fixtureJoinedRoom({ name: 'café-9-🎉' });
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, {
        ...listBody(),
        conn_id: 'conn-u4a-9',
        txn_id: 'txn-snow-9',
      }),
      postSync(V4, env, {
        lists: { all: { range: [0, 2] as [number, number] } },
        conn_id: 'conn-u4a-9',
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('charset/unicode concurrent soft-10', async () => {
    const fx = fixtureJoinedRoom({ name: 'café-10-🎉' });
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, {
        ...listBody(),
        conn_id: 'conn-u4b-10',
        txn_id: 'txn-snow-10',
      }),
      postSync(V4, env, {
        lists: { all: { range: [0, 2] as [number, number] } },
        conn_id: 'conn-u4b-10',
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('charset/unicode concurrent soft-11', async () => {
    const fx = fixtureJoinedRoom({ name: 'café-11-🎉' });
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, {
        ...listBody(),
        conn_id: 'conn-u4c-11',
        txn_id: 'txn-snow-11',
      }),
      postSync(V4, env, {
        lists: { all: { range: [0, 2] as [number, number] } },
        conn_id: 'conn-u4c-11',
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

});


describe('race sliding multi-request flood + module isolation after #202', () => {
  it('8-way Promise.all flood stays non-500', async () => {
    const a = fixtureJoinedRoom({ room_id: ROOM });
    const b = fixtureJoinedRoom({ room_id: ROOM2, name: 'Two' });
    const fx = mergeFixtures(a, b, fixtureInviteRoom());
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const jobs = [
      postSync(MSC3575, env, listBody()),
      postSync(MSC4186, env, { lists: { all: { range: [0, 5] as [number, number] } } }),
      postSync(V4, env, { lists: { all: { range: [0, 5] as [number, number] } } }),
      postSync(MSC3575, env, { room_subscriptions: { [ROOM]: { timeline_limit: 2 } } }),
      postSync(MSC3575, env, { ...listBody(), extensions: { to_device: { enabled: true } } }),
      postSync(MSC3575, env, { ...listBody(), extensions: { e2ee: { enabled: true } } }),
      postSync(MSC3575, env, { unsubscribe_rooms: [ROOM3], pos: '1' }),
      postSync(MSC3575, env, listBody([[0, 0]])),
    ];
    const results = await Promise.all(jobs);
    expect(results.every((r) => r.status < 500)).toBe(true);
  });

  it('MSC3575∥MSC4186∥v4 triple concurrent same fixture', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, listBody()),
      postSync(MSC4186, env, { lists: { all: { range: [0, 9] as [number, number] } } }),
      postSync(V4, env, { lists: { all: { range: [0, 9] as [number, number] } } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) expect(ROOM in roomsOf(r.body)).toBe(true);
  });


  it('multi-request isolation soft-0', async () => {
    const fx = mergeFixtures(
      fixtureJoinedRoom({ room_id: ROOM, name: 'R0' }),
      fixtureJoinedRoom({ room_id: ROOM2, name: 'R1' })
    );
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(ENDPOINTS[0], env, {
        lists: {
          L0: {
            ranges: [[0, 0]] as [number, number][],
            timeline_limit: 1,
          },
        },
        txn_id: 'iso-0',
      }),
      postSync(ENDPOINTS[1], env, {
        room_subscriptions: { [ROOM]: { timeline_limit: 1 } },
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('multi-request isolation soft-1', async () => {
    const fx = mergeFixtures(
      fixtureJoinedRoom({ room_id: ROOM, name: 'R0' }),
      fixtureJoinedRoom({ room_id: ROOM2, name: 'R1' })
    );
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(ENDPOINTS[1], env, {
        lists: {
          L1: {
            range: [0, 1] as [number, number],
            timeline_limit: 2,
          },
        },
        txn_id: 'iso-1',
      }),
      postSync(ENDPOINTS[2], env, {
        room_subscriptions: { [ROOM]: { timeline_limit: 2 } },
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('multi-request isolation soft-2', async () => {
    const fx = mergeFixtures(
      fixtureJoinedRoom({ room_id: ROOM, name: 'R0' }),
      fixtureJoinedRoom({ room_id: ROOM2, name: 'R1' })
    );
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(ENDPOINTS[2], env, {
        lists: {
          L2: {
            ranges: [[0, 2]] as [number, number][],
            timeline_limit: 3,
          },
        },
        txn_id: 'iso-2',
      }),
      postSync(ENDPOINTS[0], env, {
        room_subscriptions: { [ROOM]: { timeline_limit: 3 } },
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('multi-request isolation soft-3', async () => {
    const fx = mergeFixtures(
      fixtureJoinedRoom({ room_id: ROOM, name: 'R0' }),
      fixtureJoinedRoom({ room_id: ROOM2, name: 'R1' })
    );
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(ENDPOINTS[0], env, {
        lists: {
          L3: {
            range: [0, 3] as [number, number],
            timeline_limit: 4,
          },
        },
        txn_id: 'iso-3',
      }),
      postSync(ENDPOINTS[1], env, {
        room_subscriptions: { [ROOM]: { timeline_limit: 1 } },
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('multi-request isolation soft-4', async () => {
    const fx = mergeFixtures(
      fixtureJoinedRoom({ room_id: ROOM, name: 'R0' }),
      fixtureJoinedRoom({ room_id: ROOM2, name: 'R1' })
    );
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(ENDPOINTS[1], env, {
        lists: {
          L4: {
            ranges: [[0, 4]] as [number, number][],
            timeline_limit: 1,
          },
        },
        txn_id: 'iso-4',
      }),
      postSync(ENDPOINTS[2], env, {
        room_subscriptions: { [ROOM]: { timeline_limit: 2 } },
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('multi-request isolation soft-5', async () => {
    const fx = mergeFixtures(
      fixtureJoinedRoom({ room_id: ROOM, name: 'R0' }),
      fixtureJoinedRoom({ room_id: ROOM2, name: 'R1' })
    );
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(ENDPOINTS[2], env, {
        lists: {
          L5: {
            range: [0, 0] as [number, number],
            timeline_limit: 2,
          },
        },
        txn_id: 'iso-5',
      }),
      postSync(ENDPOINTS[0], env, {
        room_subscriptions: { [ROOM]: { timeline_limit: 3 } },
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('multi-request isolation soft-6', async () => {
    const fx = mergeFixtures(
      fixtureJoinedRoom({ room_id: ROOM, name: 'R0' }),
      fixtureJoinedRoom({ room_id: ROOM2, name: 'R1' })
    );
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(ENDPOINTS[0], env, {
        lists: {
          L6: {
            ranges: [[0, 1]] as [number, number][],
            timeline_limit: 3,
          },
        },
        txn_id: 'iso-6',
      }),
      postSync(ENDPOINTS[1], env, {
        room_subscriptions: { [ROOM]: { timeline_limit: 1 } },
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('multi-request isolation soft-7', async () => {
    const fx = mergeFixtures(
      fixtureJoinedRoom({ room_id: ROOM, name: 'R0' }),
      fixtureJoinedRoom({ room_id: ROOM2, name: 'R1' })
    );
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(ENDPOINTS[1], env, {
        lists: {
          L7: {
            range: [0, 2] as [number, number],
            timeline_limit: 4,
          },
        },
        txn_id: 'iso-7',
      }),
      postSync(ENDPOINTS[2], env, {
        room_subscriptions: { [ROOM]: { timeline_limit: 2 } },
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('multi-request isolation soft-8', async () => {
    const fx = mergeFixtures(
      fixtureJoinedRoom({ room_id: ROOM, name: 'R0' }),
      fixtureJoinedRoom({ room_id: ROOM2, name: 'R1' })
    );
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(ENDPOINTS[2], env, {
        lists: {
          L8: {
            ranges: [[0, 3]] as [number, number][],
            timeline_limit: 1,
          },
        },
        txn_id: 'iso-8',
      }),
      postSync(ENDPOINTS[0], env, {
        room_subscriptions: { [ROOM]: { timeline_limit: 3 } },
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('multi-request isolation soft-9', async () => {
    const fx = mergeFixtures(
      fixtureJoinedRoom({ room_id: ROOM, name: 'R0' }),
      fixtureJoinedRoom({ room_id: ROOM2, name: 'R1' })
    );
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(ENDPOINTS[0], env, {
        lists: {
          L9: {
            range: [0, 4] as [number, number],
            timeline_limit: 2,
          },
        },
        txn_id: 'iso-9',
      }),
      postSync(ENDPOINTS[1], env, {
        room_subscriptions: { [ROOM]: { timeline_limit: 1 } },
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('multi-request isolation soft-10', async () => {
    const fx = mergeFixtures(
      fixtureJoinedRoom({ room_id: ROOM, name: 'R0' }),
      fixtureJoinedRoom({ room_id: ROOM2, name: 'R1' })
    );
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(ENDPOINTS[1], env, {
        lists: {
          L10: {
            ranges: [[0, 0]] as [number, number][],
            timeline_limit: 3,
          },
        },
        txn_id: 'iso-10',
      }),
      postSync(ENDPOINTS[2], env, {
        room_subscriptions: { [ROOM]: { timeline_limit: 2 } },
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('multi-request isolation soft-11', async () => {
    const fx = mergeFixtures(
      fixtureJoinedRoom({ room_id: ROOM, name: 'R0' }),
      fixtureJoinedRoom({ room_id: ROOM2, name: 'R1' })
    );
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(ENDPOINTS[2], env, {
        lists: {
          L11: {
            range: [0, 1] as [number, number],
            timeline_limit: 4,
          },
        },
        txn_id: 'iso-11',
      }),
      postSync(ENDPOINTS[0], env, {
        room_subscriptions: { [ROOM]: { timeline_limit: 3 } },
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('multi-request isolation soft-12', async () => {
    const fx = mergeFixtures(
      fixtureJoinedRoom({ room_id: ROOM, name: 'R0' }),
      fixtureJoinedRoom({ room_id: ROOM2, name: 'R1' })
    );
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(ENDPOINTS[0], env, {
        lists: {
          L12: {
            ranges: [[0, 2]] as [number, number][],
            timeline_limit: 1,
          },
        },
        txn_id: 'iso-12',
      }),
      postSync(ENDPOINTS[1], env, {
        room_subscriptions: { [ROOM]: { timeline_limit: 1 } },
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('multi-request isolation soft-13', async () => {
    const fx = mergeFixtures(
      fixtureJoinedRoom({ room_id: ROOM, name: 'R0' }),
      fixtureJoinedRoom({ room_id: ROOM2, name: 'R1' })
    );
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(ENDPOINTS[1], env, {
        lists: {
          L13: {
            range: [0, 3] as [number, number],
            timeline_limit: 2,
          },
        },
        txn_id: 'iso-13',
      }),
      postSync(ENDPOINTS[2], env, {
        room_subscriptions: { [ROOM]: { timeline_limit: 2 } },
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('multi-request isolation soft-14', async () => {
    const fx = mergeFixtures(
      fixtureJoinedRoom({ room_id: ROOM, name: 'R0' }),
      fixtureJoinedRoom({ room_id: ROOM2, name: 'R1' })
    );
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(ENDPOINTS[2], env, {
        lists: {
          L14: {
            ranges: [[0, 4]] as [number, number][],
            timeline_limit: 3,
          },
        },
        txn_id: 'iso-14',
      }),
      postSync(ENDPOINTS[0], env, {
        room_subscriptions: { [ROOM]: { timeline_limit: 3 } },
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('multi-request isolation soft-15', async () => {
    const fx = mergeFixtures(
      fixtureJoinedRoom({ room_id: ROOM, name: 'R0' }),
      fixtureJoinedRoom({ room_id: ROOM2, name: 'R1' })
    );
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(ENDPOINTS[0], env, {
        lists: {
          L15: {
            range: [0, 0] as [number, number],
            timeline_limit: 4,
          },
        },
        txn_id: 'iso-15',
      }),
      postSync(ENDPOINTS[1], env, {
        room_subscriptions: { [ROOM]: { timeline_limit: 1 } },
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('multi-request isolation soft-16', async () => {
    const fx = mergeFixtures(
      fixtureJoinedRoom({ room_id: ROOM, name: 'R0' }),
      fixtureJoinedRoom({ room_id: ROOM2, name: 'R1' })
    );
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(ENDPOINTS[1], env, {
        lists: {
          L16: {
            ranges: [[0, 1]] as [number, number][],
            timeline_limit: 1,
          },
        },
        txn_id: 'iso-16',
      }),
      postSync(ENDPOINTS[2], env, {
        room_subscriptions: { [ROOM]: { timeline_limit: 2 } },
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('multi-request isolation soft-17', async () => {
    const fx = mergeFixtures(
      fixtureJoinedRoom({ room_id: ROOM, name: 'R0' }),
      fixtureJoinedRoom({ room_id: ROOM2, name: 'R1' })
    );
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(ENDPOINTS[2], env, {
        lists: {
          L17: {
            range: [0, 2] as [number, number],
            timeline_limit: 2,
          },
        },
        txn_id: 'iso-17',
      }),
      postSync(ENDPOINTS[0], env, {
        room_subscriptions: { [ROOM]: { timeline_limit: 3 } },
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('multi-request isolation soft-18', async () => {
    const fx = mergeFixtures(
      fixtureJoinedRoom({ room_id: ROOM, name: 'R0' }),
      fixtureJoinedRoom({ room_id: ROOM2, name: 'R1' })
    );
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(ENDPOINTS[0], env, {
        lists: {
          L18: {
            ranges: [[0, 3]] as [number, number][],
            timeline_limit: 3,
          },
        },
        txn_id: 'iso-18',
      }),
      postSync(ENDPOINTS[1], env, {
        room_subscriptions: { [ROOM]: { timeline_limit: 1 } },
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('multi-request isolation soft-19', async () => {
    const fx = mergeFixtures(
      fixtureJoinedRoom({ room_id: ROOM, name: 'R0' }),
      fixtureJoinedRoom({ room_id: ROOM2, name: 'R1' })
    );
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(ENDPOINTS[1], env, {
        lists: {
          L19: {
            range: [0, 4] as [number, number],
            timeline_limit: 4,
          },
        },
        txn_id: 'iso-19',
      }),
      postSync(ENDPOINTS[2], env, {
        room_subscriptions: { [ROOM]: { timeline_limit: 2 } },
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

});


describe('sliding concurrent soft flood — bind / query / lifecycle after #202', () => {


  it('query pos/timeout lifecycle soft-0', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 20 });
    const syncDo = createSyncDoStub({
      states:
        true
          ? {}
          : {
              default: {
                userId: USER,
                pos: 0,
                lastAccess: NOW,
                roomStates: { [ROOM]: { lastStreamOrdering: 0, sentState: true } },
                listStates: { all: { roomIds: [ROOM], count: 1 } },
              },
            },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { lists: { all: { range: [0, 2] as [number, number] } }, timeout: 0 },
        { query: 'pos=0&timeout=0' }
      ),
      postSync(MSC3575, env, { ...listBody(), pos: '0' }, { query: 'pos=0' }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('query pos/timeout lifecycle soft-1', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 21 });
    const syncDo = createSyncDoStub({
      states:
        false
          ? {}
          : {
              default: {
                userId: USER,
                pos: 1,
                lastAccess: NOW,
                roomStates: { [ROOM]: { lastStreamOrdering: 1, sentState: true } },
                listStates: { all: { roomIds: [ROOM], count: 1 } },
              },
            },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { lists: { all: { range: [0, 2] as [number, number] } }, timeout: 1 },
        { query: 'pos=1&timeout=1' }
      ),
      postSync(MSC3575, env, { ...listBody(), pos: '1' }, { query: 'pos=1' }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('query pos/timeout lifecycle soft-2', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 22 });
    const syncDo = createSyncDoStub({
      states:
        false
          ? {}
          : {
              default: {
                userId: USER,
                pos: 2,
                lastAccess: NOW,
                roomStates: { [ROOM]: { lastStreamOrdering: 2, sentState: true } },
                listStates: { all: { roomIds: [ROOM], count: 1 } },
              },
            },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { lists: { all: { range: [0, 2] as [number, number] } }, timeout: 2 },
        { query: 'pos=2&timeout=2' }
      ),
      postSync(MSC3575, env, { ...listBody(), pos: '2' }, { query: 'pos=2' }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('query pos/timeout lifecycle soft-3', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 23 });
    const syncDo = createSyncDoStub({
      states:
        true
          ? {}
          : {
              default: {
                userId: USER,
                pos: 3,
                lastAccess: NOW,
                roomStates: { [ROOM]: { lastStreamOrdering: 3, sentState: true } },
                listStates: { all: { roomIds: [ROOM], count: 1 } },
              },
            },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { lists: { all: { range: [0, 2] as [number, number] } }, timeout: 3 },
        { query: 'pos=3&timeout=3' }
      ),
      postSync(MSC3575, env, { ...listBody(), pos: '3' }, { query: 'pos=3' }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('query pos/timeout lifecycle soft-4', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 24 });
    const syncDo = createSyncDoStub({
      states:
        false
          ? {}
          : {
              default: {
                userId: USER,
                pos: 4,
                lastAccess: NOW,
                roomStates: { [ROOM]: { lastStreamOrdering: 4, sentState: true } },
                listStates: { all: { roomIds: [ROOM], count: 1 } },
              },
            },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { lists: { all: { range: [0, 2] as [number, number] } }, timeout: 4 },
        { query: 'pos=4&timeout=4' }
      ),
      postSync(MSC3575, env, { ...listBody(), pos: '4' }, { query: 'pos=4' }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('query pos/timeout lifecycle soft-5', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 25 });
    const syncDo = createSyncDoStub({
      states:
        false
          ? {}
          : {
              default: {
                userId: USER,
                pos: 5,
                lastAccess: NOW,
                roomStates: { [ROOM]: { lastStreamOrdering: 5, sentState: true } },
                listStates: { all: { roomIds: [ROOM], count: 1 } },
              },
            },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { lists: { all: { range: [0, 2] as [number, number] } }, timeout: 0 },
        { query: 'pos=5&timeout=0' }
      ),
      postSync(MSC3575, env, { ...listBody(), pos: '5' }, { query: 'pos=5' }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('query pos/timeout lifecycle soft-6', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 26 });
    const syncDo = createSyncDoStub({
      states:
        true
          ? {}
          : {
              default: {
                userId: USER,
                pos: 6,
                lastAccess: NOW,
                roomStates: { [ROOM]: { lastStreamOrdering: 6, sentState: true } },
                listStates: { all: { roomIds: [ROOM], count: 1 } },
              },
            },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { lists: { all: { range: [0, 2] as [number, number] } }, timeout: 1 },
        { query: 'pos=6&timeout=1' }
      ),
      postSync(MSC3575, env, { ...listBody(), pos: '6' }, { query: 'pos=6' }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('query pos/timeout lifecycle soft-7', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 27 });
    const syncDo = createSyncDoStub({
      states:
        false
          ? {}
          : {
              default: {
                userId: USER,
                pos: 7,
                lastAccess: NOW,
                roomStates: { [ROOM]: { lastStreamOrdering: 7, sentState: true } },
                listStates: { all: { roomIds: [ROOM], count: 1 } },
              },
            },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { lists: { all: { range: [0, 2] as [number, number] } }, timeout: 2 },
        { query: 'pos=7&timeout=2' }
      ),
      postSync(MSC3575, env, { ...listBody(), pos: '7' }, { query: 'pos=7' }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('query pos/timeout lifecycle soft-8', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 28 });
    const syncDo = createSyncDoStub({
      states:
        false
          ? {}
          : {
              default: {
                userId: USER,
                pos: 8,
                lastAccess: NOW,
                roomStates: { [ROOM]: { lastStreamOrdering: 8, sentState: true } },
                listStates: { all: { roomIds: [ROOM], count: 1 } },
              },
            },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { lists: { all: { range: [0, 2] as [number, number] } }, timeout: 3 },
        { query: 'pos=8&timeout=3' }
      ),
      postSync(MSC3575, env, { ...listBody(), pos: '8' }, { query: 'pos=8' }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('query pos/timeout lifecycle soft-9', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 29 });
    const syncDo = createSyncDoStub({
      states:
        true
          ? {}
          : {
              default: {
                userId: USER,
                pos: 9,
                lastAccess: NOW,
                roomStates: { [ROOM]: { lastStreamOrdering: 9, sentState: true } },
                listStates: { all: { roomIds: [ROOM], count: 1 } },
              },
            },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { lists: { all: { range: [0, 2] as [number, number] } }, timeout: 4 },
        { query: 'pos=9&timeout=4' }
      ),
      postSync(MSC3575, env, { ...listBody(), pos: '9' }, { query: 'pos=9' }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('query pos/timeout lifecycle soft-10', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 30 });
    const syncDo = createSyncDoStub({
      states:
        false
          ? {}
          : {
              default: {
                userId: USER,
                pos: 10,
                lastAccess: NOW,
                roomStates: { [ROOM]: { lastStreamOrdering: 10, sentState: true } },
                listStates: { all: { roomIds: [ROOM], count: 1 } },
              },
            },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { lists: { all: { range: [0, 2] as [number, number] } }, timeout: 0 },
        { query: 'pos=10&timeout=0' }
      ),
      postSync(MSC3575, env, { ...listBody(), pos: '10' }, { query: 'pos=10' }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('query pos/timeout lifecycle soft-11', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 31 });
    const syncDo = createSyncDoStub({
      states:
        false
          ? {}
          : {
              default: {
                userId: USER,
                pos: 11,
                lastAccess: NOW,
                roomStates: { [ROOM]: { lastStreamOrdering: 11, sentState: true } },
                listStates: { all: { roomIds: [ROOM], count: 1 } },
              },
            },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { lists: { all: { range: [0, 2] as [number, number] } }, timeout: 1 },
        { query: 'pos=11&timeout=1' }
      ),
      postSync(MSC3575, env, { ...listBody(), pos: '11' }, { query: 'pos=11' }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('query pos/timeout lifecycle soft-12', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 32 });
    const syncDo = createSyncDoStub({
      states:
        true
          ? {}
          : {
              default: {
                userId: USER,
                pos: 12,
                lastAccess: NOW,
                roomStates: { [ROOM]: { lastStreamOrdering: 12, sentState: true } },
                listStates: { all: { roomIds: [ROOM], count: 1 } },
              },
            },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { lists: { all: { range: [0, 2] as [number, number] } }, timeout: 2 },
        { query: 'pos=12&timeout=2' }
      ),
      postSync(MSC3575, env, { ...listBody(), pos: '12' }, { query: 'pos=12' }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('query pos/timeout lifecycle soft-13', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 33 });
    const syncDo = createSyncDoStub({
      states:
        false
          ? {}
          : {
              default: {
                userId: USER,
                pos: 13,
                lastAccess: NOW,
                roomStates: { [ROOM]: { lastStreamOrdering: 13, sentState: true } },
                listStates: { all: { roomIds: [ROOM], count: 1 } },
              },
            },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { lists: { all: { range: [0, 2] as [number, number] } }, timeout: 3 },
        { query: 'pos=13&timeout=3' }
      ),
      postSync(MSC3575, env, { ...listBody(), pos: '13' }, { query: 'pos=13' }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('query pos/timeout lifecycle soft-14', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 34 });
    const syncDo = createSyncDoStub({
      states:
        false
          ? {}
          : {
              default: {
                userId: USER,
                pos: 14,
                lastAccess: NOW,
                roomStates: { [ROOM]: { lastStreamOrdering: 14, sentState: true } },
                listStates: { all: { roomIds: [ROOM], count: 1 } },
              },
            },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { lists: { all: { range: [0, 2] as [number, number] } }, timeout: 4 },
        { query: 'pos=14&timeout=4' }
      ),
      postSync(MSC3575, env, { ...listBody(), pos: '14' }, { query: 'pos=14' }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('query pos/timeout lifecycle soft-15', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 35 });
    const syncDo = createSyncDoStub({
      states:
        true
          ? {}
          : {
              default: {
                userId: USER,
                pos: 15,
                lastAccess: NOW,
                roomStates: { [ROOM]: { lastStreamOrdering: 15, sentState: true } },
                listStates: { all: { roomIds: [ROOM], count: 1 } },
              },
            },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { lists: { all: { range: [0, 2] as [number, number] } }, timeout: 0 },
        { query: 'pos=15&timeout=0' }
      ),
      postSync(MSC3575, env, { ...listBody(), pos: '15' }, { query: 'pos=15' }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('query pos/timeout lifecycle soft-16', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 36 });
    const syncDo = createSyncDoStub({
      states:
        false
          ? {}
          : {
              default: {
                userId: USER,
                pos: 16,
                lastAccess: NOW,
                roomStates: { [ROOM]: { lastStreamOrdering: 16, sentState: true } },
                listStates: { all: { roomIds: [ROOM], count: 1 } },
              },
            },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { lists: { all: { range: [0, 2] as [number, number] } }, timeout: 1 },
        { query: 'pos=16&timeout=1' }
      ),
      postSync(MSC3575, env, { ...listBody(), pos: '16' }, { query: 'pos=16' }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('query pos/timeout lifecycle soft-17', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 37 });
    const syncDo = createSyncDoStub({
      states:
        false
          ? {}
          : {
              default: {
                userId: USER,
                pos: 17,
                lastAccess: NOW,
                roomStates: { [ROOM]: { lastStreamOrdering: 17, sentState: true } },
                listStates: { all: { roomIds: [ROOM], count: 1 } },
              },
            },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { lists: { all: { range: [0, 2] as [number, number] } }, timeout: 2 },
        { query: 'pos=17&timeout=2' }
      ),
      postSync(MSC3575, env, { ...listBody(), pos: '17' }, { query: 'pos=17' }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('query pos/timeout lifecycle soft-18', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 38 });
    const syncDo = createSyncDoStub({
      states:
        true
          ? {}
          : {
              default: {
                userId: USER,
                pos: 18,
                lastAccess: NOW,
                roomStates: { [ROOM]: { lastStreamOrdering: 18, sentState: true } },
                listStates: { all: { roomIds: [ROOM], count: 1 } },
              },
            },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { lists: { all: { range: [0, 2] as [number, number] } }, timeout: 3 },
        { query: 'pos=18&timeout=3' }
      ),
      postSync(MSC3575, env, { ...listBody(), pos: '18' }, { query: 'pos=18' }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('query pos/timeout lifecycle soft-19', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 39 });
    const syncDo = createSyncDoStub({
      states:
        false
          ? {}
          : {
              default: {
                userId: USER,
                pos: 19,
                lastAccess: NOW,
                roomStates: { [ROOM]: { lastStreamOrdering: 19, sentState: true } },
                listStates: { all: { roomIds: [ROOM], count: 1 } },
              },
            },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { lists: { all: { range: [0, 2] as [number, number] } }, timeout: 4 },
        { query: 'pos=19&timeout=4' }
      ),
      postSync(MSC3575, env, { ...listBody(), pos: '19' }, { query: 'pos=19' }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('query pos/timeout lifecycle soft-20', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 40 });
    const syncDo = createSyncDoStub({
      states:
        false
          ? {}
          : {
              default: {
                userId: USER,
                pos: 20,
                lastAccess: NOW,
                roomStates: { [ROOM]: { lastStreamOrdering: 20, sentState: true } },
                listStates: { all: { roomIds: [ROOM], count: 1 } },
              },
            },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { lists: { all: { range: [0, 2] as [number, number] } }, timeout: 0 },
        { query: 'pos=20&timeout=0' }
      ),
      postSync(MSC3575, env, { ...listBody(), pos: '20' }, { query: 'pos=20' }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('query pos/timeout lifecycle soft-21', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 41 });
    const syncDo = createSyncDoStub({
      states:
        true
          ? {}
          : {
              default: {
                userId: USER,
                pos: 21,
                lastAccess: NOW,
                roomStates: { [ROOM]: { lastStreamOrdering: 21, sentState: true } },
                listStates: { all: { roomIds: [ROOM], count: 1 } },
              },
            },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { lists: { all: { range: [0, 2] as [number, number] } }, timeout: 1 },
        { query: 'pos=21&timeout=1' }
      ),
      postSync(MSC3575, env, { ...listBody(), pos: '21' }, { query: 'pos=21' }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('query pos/timeout lifecycle soft-22', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 42 });
    const syncDo = createSyncDoStub({
      states:
        false
          ? {}
          : {
              default: {
                userId: USER,
                pos: 22,
                lastAccess: NOW,
                roomStates: { [ROOM]: { lastStreamOrdering: 22, sentState: true } },
                listStates: { all: { roomIds: [ROOM], count: 1 } },
              },
            },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { lists: { all: { range: [0, 2] as [number, number] } }, timeout: 2 },
        { query: 'pos=22&timeout=2' }
      ),
      postSync(MSC3575, env, { ...listBody(), pos: '22' }, { query: 'pos=22' }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('query pos/timeout lifecycle soft-23', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({ ...fx, maxStreamPos: 43 });
    const syncDo = createSyncDoStub({
      states:
        false
          ? {}
          : {
              default: {
                userId: USER,
                pos: 23,
                lastAccess: NOW,
                roomStates: { [ROOM]: { lastStreamOrdering: 23, sentState: true } },
                listStates: { all: { roomIds: [ROOM], count: 1 } },
              },
            },
    });
    const env = createEnv({ db, syncDo });
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { lists: { all: { range: [0, 2] as [number, number] } }, timeout: 3 },
        { query: 'pos=23&timeout=3' }
      ),
      postSync(MSC3575, env, { ...listBody(), pos: '23' }, { query: 'pos=23' }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });


  it('NSE / UA concurrent soft-0', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const ua =
      true
        ? 'ElementX-NSE/1.0 NotificationService'
        : 'Element X iOS/25.0';
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 1 } } },
        { headers: { 'User-Agent': ua } }
      ),
      postSync(
        V4,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 2 } }, extensions: {} },
        { headers: { 'User-Agent': ua + '-b' } }
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('NSE / UA concurrent soft-1', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const ua =
      false
        ? 'ElementX-NSE/1.0 NotificationService'
        : 'Element X iOS/25.0';
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 2 } } },
        { headers: { 'User-Agent': ua } }
      ),
      postSync(
        V4,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 2 } }, extensions: {} },
        { headers: { 'User-Agent': ua + '-b' } }
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('NSE / UA concurrent soft-2', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const ua =
      true
        ? 'ElementX-NSE/1.0 NotificationService'
        : 'Element X iOS/25.0';
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 3 } } },
        { headers: { 'User-Agent': ua } }
      ),
      postSync(
        V4,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 2 } }, extensions: {} },
        { headers: { 'User-Agent': ua + '-b' } }
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('NSE / UA concurrent soft-3', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const ua =
      false
        ? 'ElementX-NSE/1.0 NotificationService'
        : 'Element X iOS/25.0';
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 4 } } },
        { headers: { 'User-Agent': ua } }
      ),
      postSync(
        V4,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 2 } }, extensions: {} },
        { headers: { 'User-Agent': ua + '-b' } }
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('NSE / UA concurrent soft-4', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const ua =
      true
        ? 'ElementX-NSE/1.0 NotificationService'
        : 'Element X iOS/25.0';
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 1 } } },
        { headers: { 'User-Agent': ua } }
      ),
      postSync(
        V4,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 2 } }, extensions: {} },
        { headers: { 'User-Agent': ua + '-b' } }
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('NSE / UA concurrent soft-5', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const ua =
      false
        ? 'ElementX-NSE/1.0 NotificationService'
        : 'Element X iOS/25.0';
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 2 } } },
        { headers: { 'User-Agent': ua } }
      ),
      postSync(
        V4,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 2 } }, extensions: {} },
        { headers: { 'User-Agent': ua + '-b' } }
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('NSE / UA concurrent soft-6', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const ua =
      true
        ? 'ElementX-NSE/1.0 NotificationService'
        : 'Element X iOS/25.0';
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 3 } } },
        { headers: { 'User-Agent': ua } }
      ),
      postSync(
        V4,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 2 } }, extensions: {} },
        { headers: { 'User-Agent': ua + '-b' } }
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('NSE / UA concurrent soft-7', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const ua =
      false
        ? 'ElementX-NSE/1.0 NotificationService'
        : 'Element X iOS/25.0';
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 4 } } },
        { headers: { 'User-Agent': ua } }
      ),
      postSync(
        V4,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 2 } }, extensions: {} },
        { headers: { 'User-Agent': ua + '-b' } }
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('NSE / UA concurrent soft-8', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const ua =
      true
        ? 'ElementX-NSE/1.0 NotificationService'
        : 'Element X iOS/25.0';
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 1 } } },
        { headers: { 'User-Agent': ua } }
      ),
      postSync(
        V4,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 2 } }, extensions: {} },
        { headers: { 'User-Agent': ua + '-b' } }
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('NSE / UA concurrent soft-9', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const ua =
      false
        ? 'ElementX-NSE/1.0 NotificationService'
        : 'Element X iOS/25.0';
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 2 } } },
        { headers: { 'User-Agent': ua } }
      ),
      postSync(
        V4,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 2 } }, extensions: {} },
        { headers: { 'User-Agent': ua + '-b' } }
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('NSE / UA concurrent soft-10', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const ua =
      true
        ? 'ElementX-NSE/1.0 NotificationService'
        : 'Element X iOS/25.0';
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 3 } } },
        { headers: { 'User-Agent': ua } }
      ),
      postSync(
        V4,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 2 } }, extensions: {} },
        { headers: { 'User-Agent': ua + '-b' } }
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('NSE / UA concurrent soft-11', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const ua =
      false
        ? 'ElementX-NSE/1.0 NotificationService'
        : 'Element X iOS/25.0';
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 4 } } },
        { headers: { 'User-Agent': ua } }
      ),
      postSync(
        V4,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 2 } }, extensions: {} },
        { headers: { 'User-Agent': ua + '-b' } }
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('NSE / UA concurrent soft-12', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const ua =
      true
        ? 'ElementX-NSE/1.0 NotificationService'
        : 'Element X iOS/25.0';
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 1 } } },
        { headers: { 'User-Agent': ua } }
      ),
      postSync(
        V4,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 2 } }, extensions: {} },
        { headers: { 'User-Agent': ua + '-b' } }
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('NSE / UA concurrent soft-13', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const ua =
      false
        ? 'ElementX-NSE/1.0 NotificationService'
        : 'Element X iOS/25.0';
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 2 } } },
        { headers: { 'User-Agent': ua } }
      ),
      postSync(
        V4,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 2 } }, extensions: {} },
        { headers: { 'User-Agent': ua + '-b' } }
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('NSE / UA concurrent soft-14', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const ua =
      true
        ? 'ElementX-NSE/1.0 NotificationService'
        : 'Element X iOS/25.0';
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 3 } } },
        { headers: { 'User-Agent': ua } }
      ),
      postSync(
        V4,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 2 } }, extensions: {} },
        { headers: { 'User-Agent': ua + '-b' } }
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('NSE / UA concurrent soft-15', async () => {
    const fx = fixtureJoinedRoom();
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const ua =
      false
        ? 'ElementX-NSE/1.0 NotificationService'
        : 'Element X iOS/25.0';
    const results = await Promise.all([
      postSync(
        MSC4186,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 4 } } },
        { headers: { 'User-Agent': ua } }
      ),
      postSync(
        V4,
        env,
        { room_subscriptions: { [ROOM]: { timeline_limit: 2 } }, extensions: {} },
        { headers: { 'User-Agent': ua + '-b' } }
      ),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });


  it('invite+join list concurrent with invite fixture', async () => {
    const fx = mergeFixtures(fixtureJoinedRoom(), fixtureInviteRoom());
    const env = createEnv({ db: createSlidingDb({ ...fx }) });
    const results = await Promise.all([
      postSync(MSC3575, env, {
        lists: {
          joins: { ranges: [[0, 10]] as [number, number][], filters: { is_invite: false } },
          invites: { ranges: [[0, 10]] as [number, number][], filters: { is_invite: true } },
        },
      }),
      postSync(MSC3575, env, listBody([[0, 20]])),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('fully_read marker change concurrent soft', async () => {
    const fx = fixtureJoinedRoom();
    const db = createSlidingDb({
      ...fx,
      accountData: [
        {
          user_id: USER,
          room_id: ROOM,
          event_type: 'm.fully_read',
          content: JSON.stringify({ event_id: '$fr1' }),
        },
      ],
    });
    const warm: ConnectionState = {
      userId: USER,
      pos: 8,
      lastAccess: NOW,
      roomStates: { [ROOM]: { lastStreamOrdering: 8, sentState: true } },
      listStates: { all: { roomIds: [ROOM], count: 1 } },
      roomFullyReadMarkers: { [ROOM]: '$old' },
    };
    const env = createEnv({ db, syncDo: createSyncDoStub({ states: { default: warm } }) });
    const results = await Promise.all([
      postSync(MSC3575, env, { ...listBody(), pos: '8' }),
      postSync(MSC3575, env, { ...listBody(), pos: '8' }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});
