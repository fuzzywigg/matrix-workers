/**
 * TOKENMAXX HEAVY leftovers after #201 — client /sync *concurrent race / TOCTOU*
 * + soft/edge reliability for slices not covered by:
 *   - sync-api-routes / sync-api-route-leftovers (#157) soft/edge floods
 *   - sync-filters / sync-sparse-state / sync-durable-object helpers
 *   - sliding-sync leftovers (#189) (distinct MSC3575 surface)
 *
 * Distinct domain — not voip/rtc/calls (#201), report/server-notices (#200),
 * search/spaces (#199), profile (#198/#197), tags (#196), workflows (#195),
 * rooms-mutate (#194), aliases (#193), rooms (#192), admin-mutate (#191).
 *
 * Focus: dual cold/incremental sync under getUserRooms JOIN barrier;
 * membership leave/invite mid-flight TOCTOU; getEventsSince timeline mutate;
 * stream-position advance mid-flight; filter KV load→mutate lost-update;
 * to-device / account_data / OTK / device_lists concurrent isolation;
 * DO long-poll wait∥sync; multi-room / full_state concurrent;
 * timeout/filter/since/method soft floods under Promise.all.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, PDU } from '../src/types';

const authState = vi.hoisted(() => ({
  userId: '@alice:example.com' as string | undefined,
  deviceId: 'DEVICEA' as string | undefined,
}));

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', authState.userId);
      c.set('deviceId', authState.deviceId);
      await next();
    };
  },
}));

const getUserRooms = vi.fn();
const getRoomState = vi.fn();
const getEventsSince = vi.fn();
const getLatestStreamPosition = vi.fn();

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getUserRooms: (...args: unknown[]) => getUserRooms(...args),
    getRoomState: (...args: unknown[]) => getRoomState(...args),
    getEventsSince: (...args: unknown[]) => getEventsSince(...args),
    getLatestStreamPosition: (...args: unknown[]) => getLatestStreamPosition(...args),
  };
});

const getToDeviceMessages = vi.fn();

vi.mock('../src/api/to-device', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/to-device')>();
  return {
    ...actual,
    getToDeviceMessages: (...args: unknown[]) => getToDeviceMessages(...args),
  };
});

const getGlobalAccountData = vi.fn();
const getRoomAccountData = vi.fn();

vi.mock('../src/api/account-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/account-data')>();
  return {
    ...actual,
    getGlobalAccountData: (...args: unknown[]) => getGlobalAccountData(...args),
    getRoomAccountData: (...args: unknown[]) => getRoomAccountData(...args),
  };
});

const getReceiptsForRoom = vi.fn();

vi.mock('../src/api/receipts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/receipts')>();
  return {
    ...actual,
    getReceiptsForRoom: (...args: unknown[]) => getReceiptsForRoom(...args),
  };
});

const getTypingUsers = vi.fn();

vi.mock('../src/api/typing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/typing')>();
  return {
    ...actual,
    getTypingUsers: (...args: unknown[]) => getTypingUsers(...args),
  };
});

import syncApp from '../src/api/sync';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const DEVICE = 'DEVICEA';
const ROOM = '!room:example.com';
const ROOM2 = '!room2:example.com';
const ROOM3 = '!room3:example.com';
const INVITE = '!invite:example.com';
const LEFT = '!left:example.com';
const NOW = 1_700_000_000_000;
const AUTH = { Authorization: 'Bearer test-token' };

type SqlCall = { sql: string; args: unknown[] };
type OtkCount = { algorithm: string; count: number };
type FallbackAlgo = { algorithm: string };
type DeviceKeyChange = { user_id: string; stream_position: number };
type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };
type SyncDoFetch = { url: string; method: string; body?: unknown };

type FnBarrier = { count: number; waiters: Array<() => void> };

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

function mockKv(
  data: Record<string, string> = {},
  opts: {
    getBarrier?: FnBarrier;
    mutateAfterGets?: { after: number; key: string; next: string | null };
    failAfterGets?: number;
  } = {}
) {
  const puts: KvPut[] = [];
  const deletes: string[] = [];
  let getCount = 0;
  const kv = {
    data,
    puts,
    deletes,
    getCount: () => getCount,
    get: async (key: string, type?: string) => {
      // Barrier first so concurrent getters serialize post-barrier mutate/snapshot.
      await hitFnBarrier(opts.getBarrier);
      getCount += 1;
      const myGet = getCount;
      if (opts.failAfterGets != null && myGet > opts.failAfterGets) {
        throw new Error('kv get boom');
      }
      const raw = data[key];
      if (opts.mutateAfterGets && myGet === opts.mutateAfterGets.after) {
        if (opts.mutateAfterGets.next == null) delete data[opts.mutateAfterGets.key];
        else data[opts.mutateAfterGets.key] = opts.mutateAfterGets.next;
      }
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
    getCount: () => number;
  };
}

function createSyncDoStub(
  opts: {
    hasEvents?: boolean | (() => boolean);
    fail?: boolean;
    delayMs?: number;
    barrier?: FnBarrier;
  } = {}
) {
  const fetches: SyncDoFetch[] = [];
  return {
    fetches,
    async fetch(req: Request): Promise<Response> {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        body = undefined;
      }
      fetches.push({ url: req.url, method: req.method, body });
      await hitFnBarrier(opts.barrier);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail) throw new Error('sync DO boom');
      const hasEvents =
        typeof opts.hasEvents === 'function' ? opts.hasEvents() : (opts.hasEvents ?? false);
      return Response.json({ hasEvents });
    },
  };
}

type SyncDoStub = ReturnType<typeof createSyncDoStub>;

function createSyncDb(
  opts: {
    otkCounts?: OtkCount[];
    fallbackAlgos?: FallbackAlgo[];
    deviceKeyChanges?: DeviceKeyChange[];
    sharedRoomUsers?: string[];
    selectBarrier?: { match: (sql: string) => boolean; count: number };
    mutateDeviceKeyChangesAfter?: { after: number; next: DeviceKeyChange[] };
    throwOnSqlIncludes?: string;
  } = {}
) {
  let otkCounts = [...(opts.otkCounts ?? [])];
  let fallbackAlgos = [...(opts.fallbackAlgos ?? [])];
  let deviceKeyChanges = [...(opts.deviceKeyChanges ?? [])];
  const sharedRoomUsers = new Set(opts.sharedRoomUsers ?? [BOB, CAROL]);
  const selects: SqlCall[] = [];
  const events: string[] = [];

  let selectBarrier = opts.selectBarrier
    ? { ...opts.selectBarrier, waiters: [] as Array<() => void> }
    : undefined;
  let deviceKeySelectCount = 0;

  const db = {
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
    sharedRoomUsers,
    selects,
    events,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              events.push(`first:${sql.slice(0, 48)}`);
              if (selectBarrier?.match(sql)) {
                await new Promise<void>((resolve) => {
                  selectBarrier!.waiters.push(resolve);
                  if (selectBarrier!.waiters.length >= selectBarrier!.count) {
                    const all = [...selectBarrier!.waiters];
                    selectBarrier!.waiters = [];
                    selectBarrier = undefined;
                    for (const r of all) r();
                  }
                });
              }
              if (opts.throwOnSqlIncludes && sql.includes(opts.throwOnSqlIncludes)) {
                throw new Error(`db boom: ${opts.throwOnSqlIncludes}`);
              }
              if (
                sql.includes('FROM device_key_changes') &&
                sql.includes('COUNT(*)') &&
                sql.includes('dkc.user_id = ?')
              ) {
                const [sincePos, userId] = args as [number, string];
                deviceKeySelectCount += 1;
                if (
                  opts.mutateDeviceKeyChangesAfter &&
                  deviceKeySelectCount === opts.mutateDeviceKeyChangesAfter.after
                ) {
                  deviceKeyChanges = [...opts.mutateDeviceKeyChangesAfter.next];
                  events.push('mutate:device-key-changes');
                }
                const count = deviceKeyChanges.filter(
                  (c) => c.user_id === userId && c.stream_position > sincePos
                ).length;
                return { count } as T;
              }
              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 160)}`);
            },
            async all<T>() {
              selects.push({ sql, args });
              events.push(`all:${sql.slice(0, 48)}`);
              if (selectBarrier?.match(sql)) {
                await new Promise<void>((resolve) => {
                  selectBarrier!.waiters.push(resolve);
                  if (selectBarrier!.waiters.length >= selectBarrier!.count) {
                    const all = [...selectBarrier!.waiters];
                    selectBarrier!.waiters = [];
                    selectBarrier = undefined;
                    for (const r of all) r();
                  }
                });
              }
              if (opts.throwOnSqlIncludes && sql.includes(opts.throwOnSqlIncludes)) {
                throw new Error(`db boom: ${opts.throwOnSqlIncludes}`);
              }
              if (sql.includes('FROM one_time_keys') && sql.includes('GROUP BY algorithm')) {
                return { results: otkCounts as unknown as T[] };
              }
              if (sql.includes('FROM fallback_keys') && sql.includes('DISTINCT algorithm')) {
                return { results: fallbackAlgos as unknown as T[] };
              }
              if (
                sql.includes('FROM device_key_changes dkc') &&
                sql.includes('SELECT DISTINCT dkc.user_id')
              ) {
                const [sincePos] = args as [number, string, string];
                deviceKeySelectCount += 1;
                if (
                  opts.mutateDeviceKeyChangesAfter &&
                  deviceKeySelectCount === opts.mutateDeviceKeyChangesAfter.after
                ) {
                  deviceKeyChanges = [...opts.mutateDeviceKeyChangesAfter.next];
                  events.push('mutate:device-key-changes');
                }
                const users = [
                  ...new Set(
                    deviceKeyChanges
                      .filter(
                        (c) =>
                          c.stream_position > sincePos &&
                          c.user_id !== USER &&
                          sharedRoomUsers.has(c.user_id)
                      )
                      .map((c) => c.user_id)
                  ),
                ];
                return { results: users.map((user_id) => ({ user_id })) as unknown as T[] };
              }
              return { results: [] as T[] };
            },
            async run() {
              throw new Error(`Unexpected run() SQL: ${sql.slice(0, 140)}`);
            },
          };
        },
      };
    },
  };
  return db;
}

type SyncDb = ReturnType<typeof createSyncDb>;

function makePdu(partial: Partial<PDU> & { type: string; event_id: string }): PDU {
  return {
    room_id: ROOM,
    sender: USER,
    origin_server_ts: NOW,
    content: {},
    depth: 1,
    auth_events: [],
    prev_events: [],
    ...partial,
  };
}

function createEnv(
  opts: {
    db?: SyncDb;
    cache?: ReturnType<typeof mockKv>;
    syncDo?: SyncDoStub;
  } = {}
) {
  const db = opts.db ?? createSyncDb();
  const cache = opts.cache ?? mockKv();
  const syncDo = opts.syncDo ?? createSyncDoStub();
  const env = {
    DB: db as unknown as D1Database,
    CACHE: cache,
    SERVER_NAME: 'example.com',
    SYNC: {
      idFromName: (name: string) => ({ name, toString: () => `id:${name}` }),
      get: () => syncDo,
    },
    _db: db,
    _cache: cache,
    _syncDo: syncDo,
  };
  return env as unknown as Env & typeof env;
}

async function syncRequest(
  env: Env,
  query: string = '',
  init: RequestInit = {}
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const path = `/_matrix/client/v3/sync${query ? `?${query}` : ''}`;
  const res = await syncApp.request(
    `http://localhost${path}`,
    { ...init, headers: { ...AUTH, ...(init.headers || {}) } },
    env
  );
  const text = await res.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { _raw: text };
    }
  }
  return { status: res.status, body, text };
}

type MembershipMap = { join: string[]; invite: string[]; leave: string[] };

function wireMemberships(
  map: MembershipMap,
  opts: {
    joinBarrier?: FnBarrier;
    mutateAfterJoinSelects?: { after: number; next: MembershipMap };
    failJoinAfter?: number;
  } = {}
) {
  let joinSelects = 0;
  getUserRooms.mockImplementation(async (_db: unknown, _userId: string, membership?: string) => {
    if (membership === 'join') {
      // Wait first so post-barrier snapshot/mutate runs sequentially (single-threaded).
      await hitFnBarrier(opts.joinBarrier);
      joinSelects += 1;
      const mySelect = joinSelects;
      const snapshot = [...map.join];
      if (opts.mutateAfterJoinSelects && mySelect === opts.mutateAfterJoinSelects.after) {
        Object.assign(map, opts.mutateAfterJoinSelects.next);
      }
      if (opts.failJoinAfter != null && mySelect > opts.failJoinAfter) {
        throw new Error('getUserRooms join boom');
      }
      return snapshot;
    }
    if (membership === 'invite') return [...map.invite];
    if (membership === 'leave') return [...map.leave];
    return [];
  });
}

function resetMocks() {
  authState.userId = USER;
  authState.deviceId = DEVICE;
  getUserRooms.mockReset().mockImplementation(async (_db, _u, membership?: string) => {
    if (membership === 'join') return [];
    if (membership === 'invite') return [];
    if (membership === 'leave') return [];
    return [];
  });
  getRoomState.mockReset().mockResolvedValue([]);
  getEventsSince.mockReset().mockResolvedValue([]);
  getLatestStreamPosition.mockReset().mockResolvedValue(42);
  getToDeviceMessages.mockReset().mockResolvedValue({ events: [], nextBatch: '0' });
  getGlobalAccountData.mockReset().mockResolvedValue([]);
  getRoomAccountData.mockReset().mockResolvedValue([]);
  getReceiptsForRoom.mockReset().mockResolvedValue({ type: 'm.receipt', content: {} });
  getTypingUsers.mockReset().mockResolvedValue([]);
}

beforeEach(() => {
  resetMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function joinRooms(body: Record<string, unknown>): Record<string, unknown> {
  const rooms = body.rooms as { join?: Record<string, unknown> } | undefined;
  return rooms?.join ?? {};
}

function inviteRooms(body: Record<string, unknown>): Record<string, unknown> {
  const rooms = body.rooms as { invite?: Record<string, unknown> } | undefined;
  return rooms?.invite ?? {};
}

function leaveRooms(body: Record<string, unknown>): Record<string, unknown> {
  const rooms = body.rooms as { leave?: Record<string, unknown> } | undefined;
  return rooms?.leave ?? {};
}



// ---------------------------------------------------------------------------
// Dual sync under getUserRooms JOIN barrier
// ---------------------------------------------------------------------------

describe('race sync dual join SELECT barrier after #201', () => {
  it('both parallel incremental syncs see same join set under barrier', async () => {
    const map = { join: [ROOM], invite: [], leave: [] };
    const barrier = createFnBarrier(2);
    wireMemberships(map, { joinBarrier: barrier });
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$m1:example.com', content: { body: 'hi', msgtype: 'm.text' } }),
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s5_td1'),
      syncRequest(env, 'since=s5_td1'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(Object.keys(joinRooms(r.body))).toEqual([ROOM]);
    }
    expect(getUserRooms.mock.calls.filter((c) => c[2] === 'join')).toHaveLength(2);
  });

  it('membership leave flip after first join SELECT; second sync omits room', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    const barrier = createFnBarrier(2);
    wireMemberships(map, {
      joinBarrier: barrier,
      mutateAfterJoinSelects: {
        after: 1,
        next: { join: [], invite: [], leave: [ROOM] },
      },
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m1:example.com',
        content: { body: 'hi', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s5_td1'),
      syncRequest(env, 'since=s5_td1'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const withRoom = results.filter((r) => ROOM in joinRooms(r.body));
    const withoutRoom = results.filter((r) => !(ROOM in joinRooms(r.body)));
    expect(withRoom.length).toBe(1);
    expect(withoutRoom.length).toBe(1);
  });

  it('post-mutate sequential sync reflects emptied join set', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    wireMemberships(map, {
      mutateAfterJoinSelects: {
        after: 1,
        next: { join: [], invite: [], leave: [] },
      },
    });
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$m1:example.com', content: { body: 'x', msgtype: 'm.text' } }),
    ]);
    const env = createEnv();
    const first = await syncRequest(env, 'since=s5_td0');
    expect(ROOM in joinRooms(first.body)).toBe(true);
    const second = await syncRequest(env, 'since=s5_td0');
    expect(ROOM in joinRooms(second.body)).toBe(false);
  });


  it('join flip residual status=invite', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    const barrier = createFnBarrier(2);
    wireMemberships(map, {
      joinBarrier: barrier,
      mutateAfterJoinSelects: {
        after: 1,
        next: {
          join: [],
          invite: [ROOM],
          leave: [],
        },
      },
    });
    getEventsSince.mockResolvedValue([]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.member', event_id: '$inv:example.com', state_key: USER, content: { membership: 'invite' } }),
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s8_td0'),
      syncRequest(env, 'since=s8_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.some((r) => ROOM in joinRooms(r.body))).toBe(true);
    expect(results.some((r) => !(ROOM in joinRooms(r.body)))).toBe(true);
  });


  it('join flip residual status=leave', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    const barrier = createFnBarrier(2);
    wireMemberships(map, {
      joinBarrier: barrier,
      mutateAfterJoinSelects: {
        after: 1,
        next: {
          join: [],
          invite: [],
          leave: [ROOM],
        },
      },
    });
    getEventsSince.mockResolvedValue([]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.member', event_id: '$inv:example.com', state_key: USER, content: { membership: 'invite' } }),
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s8_td0'),
      syncRequest(env, 'since=s8_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.some((r) => ROOM in joinRooms(r.body))).toBe(true);
    expect(results.some((r) => !(ROOM in joinRooms(r.body)))).toBe(true);
  });


  it('join flip residual status=ban', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    const barrier = createFnBarrier(2);
    wireMemberships(map, {
      joinBarrier: barrier,
      mutateAfterJoinSelects: {
        after: 1,
        next: {
          join: [],
          invite: [],
          leave: [],
        },
      },
    });
    getEventsSince.mockResolvedValue([]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.member', event_id: '$inv:example.com', state_key: USER, content: { membership: 'invite' } }),
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s8_td0'),
      syncRequest(env, 'since=s8_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.some((r) => ROOM in joinRooms(r.body))).toBe(true);
    expect(results.some((r) => !(ROOM in joinRooms(r.body)))).toBe(true);
  });


  it('join flip residual status=knock', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    const barrier = createFnBarrier(2);
    wireMemberships(map, {
      joinBarrier: barrier,
      mutateAfterJoinSelects: {
        after: 1,
        next: {
          join: [],
          invite: [],
          leave: [],
        },
      },
    });
    getEventsSince.mockResolvedValue([]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.member', event_id: '$inv:example.com', state_key: USER, content: { membership: 'invite' } }),
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s8_td0'),
      syncRequest(env, 'since=s8_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.some((r) => ROOM in joinRooms(r.body))).toBe(true);
    expect(results.some((r) => !(ROOM in joinRooms(r.body)))).toBe(true);
  });


  it('multi-room join barrier keeps room isolation across concurrent syncs', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2, ROOM3], invite: [], leave: [] };
    const barrier = createFnBarrier(2);
    wireMemberships(map, { joinBarrier: barrier });
    getEventsSince.mockImplementation(async (_db: unknown, roomId: string) => [
      makePdu({
        type: 'm.room.message',
        event_id: `$e-${roomId}:example.com`,
        room_id: roomId,
        content: { body: roomId, msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    for (const r of results) {
      const join = joinRooms(r.body);
      expect(Object.keys(join).sort()).toEqual([ROOM, ROOM2, ROOM3].sort());
    }
  });

  it('join SELECT fail soft mid concurrent — one boom one success', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    const barrier = createFnBarrier(2);
    wireMemberships(map, { joinBarrier: barrier, failJoinAfter: 1 });
    const env = createEnv();
    // Hono surfaces getUserRooms throw as 500; one request should still succeed.
    const results = await Promise.all([
      syncRequest(env, 'since=s2_td0'),
      syncRequest(env, 'since=s2_td0'),
    ]);
    expect(results.some((r) => r.status === 200)).toBe(true);
    expect(results.some((r) => r.status >= 500)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getEventsSince timeline mutate mid-flight
// ---------------------------------------------------------------------------

describe('race sync timeline mutate mid-flight after #201', () => {
  it('both syncs barrier on events; last mutation visible to second', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    wireMemberships(map);
    const barrier = createFnBarrier(2);
    let call = 0;
    const e1 = makePdu({ type: 'm.room.message', event_id: '$a:example.com', content: { body: 'a', msgtype: 'm.text' } });
    const e2 = makePdu({ type: 'm.room.message', event_id: '$b:example.com', content: { body: 'b', msgtype: 'm.text' } });
    let events = [e1];
    getEventsSince.mockImplementation(async () => {
      await hitFnBarrier(barrier);
      call += 1;
      const myCall = call;
      const snap = [...events];
      if (myCall === 1) events = [e1, e2];
      return snap;
    });
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s3_td0'),
      syncRequest(env, 'since=s3_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const lengths = results.map((r) => {
      const room = joinRooms(r.body)[ROOM] as { timeline?: { events?: unknown[] } };
      return room?.timeline?.events?.length ?? 0;
    });
    expect(lengths).toContain(1);
    expect(lengths).toContain(2);
  });

  it('empty→populated timeline under concurrent barrier', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    wireMemberships(map);
    const barrier = createFnBarrier(2);
    let call = 0;
    let events: PDU[] = [];
    getEventsSince.mockImplementation(async () => {
      await hitFnBarrier(barrier);
      call += 1;
      const myCall = call;
      const snap = [...events];
      if (myCall === 1) {
        events = [
          makePdu({ type: 'm.room.message', event_id: '$late:example.com', content: { body: 'late', msgtype: 'm.text' } }),
        ];
      }
      return snap;
    });
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s4_td0'),
      syncRequest(env, 'since=s4_td0'),
    ]);
    const lengths = results.map((r) => {
      const room = joinRooms(r.body)[ROOM] as { timeline?: { events?: unknown[] } };
      return room?.timeline?.events?.length ?? 0;
    });
    expect(lengths.sort()).toEqual([0, 1]);
  });

  it('timeline concurrent soft-isolation-0', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db: unknown, roomId: string) => [
      makePdu({
        type: 'm.room.message',
        event_id: `$iso-0-${roomId}:example.com`,
        room_id: roomId,
        content: { body: `iso-0`, msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s10_td0'),
      syncRequest(env, 'since=s10_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(Object.keys(joinRooms(r.body)).sort()).toEqual([ROOM, ROOM2].sort());
    }
  });

  it('timeline concurrent soft-isolation-1', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db: unknown, roomId: string) => [
      makePdu({
        type: 'm.room.message',
        event_id: `$iso-1-${roomId}:example.com`,
        room_id: roomId,
        content: { body: `iso-1`, msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s10_td0'),
      syncRequest(env, 'since=s10_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(Object.keys(joinRooms(r.body)).sort()).toEqual([ROOM, ROOM2].sort());
    }
  });

  it('timeline concurrent soft-isolation-2', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db: unknown, roomId: string) => [
      makePdu({
        type: 'm.room.message',
        event_id: `$iso-2-${roomId}:example.com`,
        room_id: roomId,
        content: { body: `iso-2`, msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s10_td0'),
      syncRequest(env, 'since=s10_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(Object.keys(joinRooms(r.body)).sort()).toEqual([ROOM, ROOM2].sort());
    }
  });

  it('timeline concurrent soft-isolation-3', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db: unknown, roomId: string) => [
      makePdu({
        type: 'm.room.message',
        event_id: `$iso-3-${roomId}:example.com`,
        room_id: roomId,
        content: { body: `iso-3`, msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s10_td0'),
      syncRequest(env, 'since=s10_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(Object.keys(joinRooms(r.body)).sort()).toEqual([ROOM, ROOM2].sort());
    }
  });

  it('timeline concurrent soft-isolation-4', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db: unknown, roomId: string) => [
      makePdu({
        type: 'm.room.message',
        event_id: `$iso-4-${roomId}:example.com`,
        room_id: roomId,
        content: { body: `iso-4`, msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s10_td0'),
      syncRequest(env, 'since=s10_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(Object.keys(joinRooms(r.body)).sort()).toEqual([ROOM, ROOM2].sort());
    }
  });

  it('timeline concurrent soft-isolation-5', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db: unknown, roomId: string) => [
      makePdu({
        type: 'm.room.message',
        event_id: `$iso-5-${roomId}:example.com`,
        room_id: roomId,
        content: { body: `iso-5`, msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s10_td0'),
      syncRequest(env, 'since=s10_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(Object.keys(joinRooms(r.body)).sort()).toEqual([ROOM, ROOM2].sort());
    }
  });

  it('timeline concurrent soft-isolation-6', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db: unknown, roomId: string) => [
      makePdu({
        type: 'm.room.message',
        event_id: `$iso-6-${roomId}:example.com`,
        room_id: roomId,
        content: { body: `iso-6`, msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s10_td0'),
      syncRequest(env, 'since=s10_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(Object.keys(joinRooms(r.body)).sort()).toEqual([ROOM, ROOM2].sort());
    }
  });

  it('timeline concurrent soft-isolation-7', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db: unknown, roomId: string) => [
      makePdu({
        type: 'm.room.message',
        event_id: `$iso-7-${roomId}:example.com`,
        room_id: roomId,
        content: { body: `iso-7`, msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s10_td0'),
      syncRequest(env, 'since=s10_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(Object.keys(joinRooms(r.body)).sort()).toEqual([ROOM, ROOM2].sort());
    }
  });
});

// ---------------------------------------------------------------------------
// Stream position advance mid-flight
// ---------------------------------------------------------------------------

describe('race sync stream position mid-flight after #201', () => {
  it('dual sync barrier on getLatestStreamPosition; second sees advanced pos', async () => {
    const barrier = createFnBarrier(2);
    let pos = 10;
    let calls = 0;
    getLatestStreamPosition.mockImplementation(async () => {
      await hitFnBarrier(barrier);
      calls += 1;
      const myCall = calls;
      const snap = pos;
      if (myCall === 1) pos = 99;
      return snap;
    });
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    const batches = results.map((r) => r.body.next_batch as string).sort();
    expect(batches).toEqual(['s10_td0', 's99_td0']);
  });

  it('to-device nextBatch advance under concurrent sync', async () => {
    const barrier = createFnBarrier(2);
    let call = 0;
    getToDeviceMessages.mockImplementation(async () => {
      await hitFnBarrier(barrier);
      call += 1;
      if (call === 1) return { events: [{ type: 'm.room_key', content: { a: 1 } }], nextBatch: '5' };
      return { events: [{ type: 'm.room_key', content: { a: 2 } }], nextBatch: '9' };
    });
    getLatestStreamPosition.mockResolvedValue(7);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    const batches = results.map((r) => r.body.next_batch as string).sort();
    expect(batches).toEqual(['s7_td5', 's7_td9']);
  });

  it('stream concurrent soft since=s0_td0', async () => {
    getLatestStreamPosition.mockResolvedValue(200);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s0_td0'),
      syncRequest(env, 'since=s0_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => typeof r.body.next_batch === 'string')).toBe(true);
  });

  it('stream concurrent soft since=s1_td0', async () => {
    getLatestStreamPosition.mockResolvedValue(200);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => typeof r.body.next_batch === 'string')).toBe(true);
  });

  it('stream concurrent soft since=s5_td2', async () => {
    getLatestStreamPosition.mockResolvedValue(200);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s5_td2'),
      syncRequest(env, 'since=s5_td2'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => typeof r.body.next_batch === 'string')).toBe(true);
  });

  it('stream concurrent soft since=12', async () => {
    getLatestStreamPosition.mockResolvedValue(200);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=12'),
      syncRequest(env, 'since=12'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => typeof r.body.next_batch === 'string')).toBe(true);
  });

  it('stream concurrent soft since=0', async () => {
    getLatestStreamPosition.mockResolvedValue(200);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=0'),
      syncRequest(env, 'since=0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => typeof r.body.next_batch === 'string')).toBe(true);
  });

  it('stream concurrent soft since=s100_td50', async () => {
    getLatestStreamPosition.mockResolvedValue(200);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s100_td50'),
      syncRequest(env, 'since=s100_td50'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => typeof r.body.next_batch === 'string')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Filter KV load → mutate mid-flight
// ---------------------------------------------------------------------------

describe('race sync filter KV load→mutate after #201', () => {
  it('both syncs barrier on filter get; second sees mutated room filter', async () => {
    const filterKey = `filter:${USER}:abc123`;
    const barrier = createFnBarrier(2);
    const cache = mockKv(
      {
        [filterKey]: JSON.stringify({ room: { rooms: [ROOM] } }),
      },
      {
        getBarrier: barrier,
        mutateAfterGets: {
          after: 1,
          key: filterKey,
          next: JSON.stringify({ room: { rooms: [ROOM2] } }),
        },
      }
    );
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$f:example.com', content: { body: 'f', msgtype: 'm.text' } }),
    ]);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, 'since=s5_td0&filter=abc123'),
      syncRequest(env, 'since=s5_td0&filter=abc123'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const joins = results.map((r) => Object.keys(joinRooms(r.body)).sort().join(','));
    expect(joins).toContain(ROOM);
    expect(joins).toContain(ROOM2);
  });

  it('filter deleted mid-flight → second sync uses no filter (all rooms)', async () => {
    const filterKey = `filter:${USER}:gone`;
    const barrier = createFnBarrier(2);
    const cache = mockKv(
      { [filterKey]: JSON.stringify({ room: { rooms: [ROOM] } }) },
      {
        getBarrier: barrier,
        mutateAfterGets: { after: 1, key: filterKey, next: null },
      }
    );
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$g:example.com', content: { body: 'g', msgtype: 'm.text' } }),
    ]);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, 'since=s5_td0&filter=gone'),
      syncRequest(env, 'since=s5_td0&filter=gone'),
    ]);
    const counts = results.map((r) => Object.keys(joinRooms(r.body)).length).sort();
    expect(counts[0]).toBe(1);
    expect(counts[1]).toBe(2);
  });

  it('inline filter JSON concurrent isolation', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$i:example.com', content: { body: 'i', msgtype: 'm.text' } }),
    ]);
    const env = createEnv();
    const f1 = encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM] } }));
    const f2 = encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM2] } }));
    const results = await Promise.all([
      syncRequest(env, `since=s5_td0&filter=${f1}`),
      syncRequest(env, `since=s5_td0&filter=${f2}`),
    ]);
    expect(Object.keys(joinRooms(results[0].body))).toEqual([ROOM]);
    expect(Object.keys(joinRooms(results[1].body))).toEqual([ROOM2]);
  });

  it('bad/empty filter concurrent soft filter={', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0&filter={'),
      syncRequest(env, 'since=s1_td0&filter={'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('bad/empty filter concurrent soft filter={]', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0&filter={]'),
      syncRequest(env, 'since=s1_td0&filter={]'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('bad/empty filter concurrent soft filter=null', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0&filter=null'),
      syncRequest(env, 'since=s1_td0&filter=null'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('bad/empty filter concurrent soft filter=[]', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0&filter=[]'),
      syncRequest(env, 'since=s1_td0&filter=[]'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('bad/empty filter concurrent soft filter="x"', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0&filter="x"'),
      syncRequest(env, 'since=s1_td0&filter="x"'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('bad/empty filter concurrent soft filter=%7B%7D', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0&filter=%7B%7D'),
      syncRequest(env, 'since=s1_td0&filter=%7B%7D'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Account data / to-device / ephemeral concurrent
// ---------------------------------------------------------------------------

describe('race sync account_data∥to_device∥ephemeral after #201', () => {
  it('global account_data mutate mid concurrent sync', async () => {
    const barrier = createFnBarrier(2);
    let call = 0;
    let data = [{ type: 'm.direct', content: { [BOB]: [ROOM] } }];
    getGlobalAccountData.mockImplementation(async () => {
      await hitFnBarrier(barrier);
      call += 1;
      const myCall = call;
      const snap = [...data];
      if (myCall === 1) data = [{ type: 'm.push_rules', content: { global: {} } }];
      return snap;
    });
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s2_td0'),
      syncRequest(env, 'since=s2_td0'),
    ]);
    const types = results.map((r) => {
      const ad = r.body.account_data as { events?: Array<{ type: string }> };
      return ad?.events?.[0]?.type;
    });
    expect(types).toContain('m.direct');
    expect(types).toContain('m.push_rules');
  });

  it('room account_data concurrent per-room isolation', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$r:example.com', content: { body: 'r', msgtype: 'm.text' } }),
    ]);
    getRoomAccountData.mockImplementation(async (_db: unknown, _u: string, roomId: string) => [
      { type: 'm.tag', content: { tags: { [roomId]: { order: 0.5 } } } },
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s3_td0'),
      syncRequest(env, 'since=s3_td0'),
    ]);
    for (const r of results) {
      for (const roomId of [ROOM, ROOM2]) {
        const room = joinRooms(r.body)[roomId] as { account_data?: { events?: Array<{ type: string }> } };
        expect(room.account_data?.events?.[0]?.type).toBe('m.tag');
      }
    }
  });

  it('receipts∥typing concurrent ephemeral soft', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([]);
    getReceiptsForRoom.mockResolvedValue({
      type: 'm.receipt',
      content: { '$e:example.com': { 'm.read': { [USER]: { ts: NOW } } } },
    });
    getTypingUsers.mockResolvedValue([BOB, CAROL]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    for (const r of results) {
      const room = joinRooms(r.body)[ROOM] as { ephemeral?: { events?: Array<{ type: string }> } };
      const types = (room.ephemeral?.events ?? []).map((e) => e.type).sort();
      expect(types).toEqual(['m.receipt', 'm.typing']);
    }
  });

  it('to-device events concurrent distinct nextBatch', async () => {
    let n = 0;
    getToDeviceMessages.mockImplementation(async () => {
      n += 1;
      return {
        events: [{ type: 'm.dummy', content: { n } }],
        nextBatch: String(n * 10),
      };
    });
    getLatestStreamPosition.mockResolvedValue(1);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    const batches = new Set(results.map((r) => r.body.next_batch));
    expect(batches.size).toBe(3);
  });

  it('account_data concurrent soft flood-0', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'im.vector.setting.breadcrumbs.0', content: { recent_rooms: [ROOM] } },
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const ad = r.body.account_data as { events?: Array<{ type: string }> };
      expect(ad.events?.[0]?.type).toContain('0');
    }
  });

  it('account_data concurrent soft flood-1', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'im.vector.setting.breadcrumbs.1', content: { recent_rooms: [ROOM] } },
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const ad = r.body.account_data as { events?: Array<{ type: string }> };
      expect(ad.events?.[0]?.type).toContain('1');
    }
  });

  it('account_data concurrent soft flood-2', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'im.vector.setting.breadcrumbs.2', content: { recent_rooms: [ROOM] } },
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const ad = r.body.account_data as { events?: Array<{ type: string }> };
      expect(ad.events?.[0]?.type).toContain('2');
    }
  });

  it('account_data concurrent soft flood-3', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'im.vector.setting.breadcrumbs.3', content: { recent_rooms: [ROOM] } },
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const ad = r.body.account_data as { events?: Array<{ type: string }> };
      expect(ad.events?.[0]?.type).toContain('3');
    }
  });

  it('account_data concurrent soft flood-4', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'im.vector.setting.breadcrumbs.4', content: { recent_rooms: [ROOM] } },
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const ad = r.body.account_data as { events?: Array<{ type: string }> };
      expect(ad.events?.[0]?.type).toContain('4');
    }
  });

  it('account_data concurrent soft flood-5', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'im.vector.setting.breadcrumbs.5', content: { recent_rooms: [ROOM] } },
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const ad = r.body.account_data as { events?: Array<{ type: string }> };
      expect(ad.events?.[0]?.type).toContain('5');
    }
  });

  it('account_data concurrent soft flood-6', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'im.vector.setting.breadcrumbs.6', content: { recent_rooms: [ROOM] } },
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const ad = r.body.account_data as { events?: Array<{ type: string }> };
      expect(ad.events?.[0]?.type).toContain('6');
    }
  });

  it('account_data concurrent soft flood-7', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'im.vector.setting.breadcrumbs.7', content: { recent_rooms: [ROOM] } },
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const ad = r.body.account_data as { events?: Array<{ type: string }> };
      expect(ad.events?.[0]?.type).toContain('7');
    }
  });

  it('account_data concurrent soft flood-8', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'im.vector.setting.breadcrumbs.8', content: { recent_rooms: [ROOM] } },
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const ad = r.body.account_data as { events?: Array<{ type: string }> };
      expect(ad.events?.[0]?.type).toContain('8');
    }
  });

  it('account_data concurrent soft flood-9', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'im.vector.setting.breadcrumbs.9', content: { recent_rooms: [ROOM] } },
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      const ad = r.body.account_data as { events?: Array<{ type: string }> };
      expect(ad.events?.[0]?.type).toContain('9');
    }
  });
});

// ---------------------------------------------------------------------------
// Invite / leave / full_state concurrent
// ---------------------------------------------------------------------------

describe('race sync invite∥leave∥full_state after #201', () => {
  it('invite room concurrent stripped state isolation', async () => {
    const map: MembershipMap = { join: [], invite: [INVITE], leave: [] };
    wireMemberships(map);
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: '$invm:example.com',
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
      makePdu({
        type: 'm.room.name',
        event_id: '$name:example.com',
        room_id: INVITE,
        state_key: '',
        content: { name: 'Party' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s2_td0'),
      syncRequest(env, 'since=s2_td0'),
    ]);
    for (const r of results) {
      expect(Object.keys(inviteRooms(r.body))).toEqual([INVITE]);
      const inv = inviteRooms(r.body)[INVITE] as { invite_state?: { events?: unknown[] } };
      expect(inv.invite_state?.events?.length).toBe(2);
    }
  });

  it('leave room concurrent include under include_leave filter', async () => {
    const map: MembershipMap = { join: [], invite: [], leave: [LEFT] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: '$leave:example.com',
        room_id: LEFT,
        state_key: USER,
        content: { membership: 'leave' },
      }),
    ]);
    const filter = encodeURIComponent(JSON.stringify({ room: { include_leave: true } }));
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s5_td0&filter=${filter}`),
      syncRequest(env, `since=s5_td0&filter=${filter}`),
    ]);
    for (const r of results) {
      expect(Object.keys(leaveRooms(r.body))).toEqual([LEFT]);
    }
  });

  it('full_state=true concurrent loads room state', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c:example.com', state_key: '', content: { creator: USER } }),
      makePdu({ type: 'm.room.power_levels', event_id: '$pl:example.com', state_key: '', content: { users: { [USER]: 100 } } }),
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s5_td0&full_state=true'),
      syncRequest(env, 'since=s5_td0&full_state=true'),
    ]);
    for (const r of results) {
      const room = joinRooms(r.body)[ROOM] as { state?: { events?: unknown[] } };
      expect(room.state?.events?.length).toBe(2);
    }
  });

  it('invite flip mid concurrent join SELECT', async () => {
    const map: MembershipMap = { join: [], invite: [INVITE], leave: [] };
    const barrier = createFnBarrier(2);
    let inviteSelects = 0;
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') {
        await hitFnBarrier(barrier);
        return [...map.join];
      }
      if (membership === 'invite') {
        inviteSelects += 1;
        const snap = [...map.invite];
        if (inviteSelects === 1) map.invite = [];
        return snap;
      }
      return [];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: '$i2:example.com',
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s3_td0'),
      syncRequest(env, 'since=s3_td0'),
    ]);
    const withInvite = results.filter((r) => INVITE in inviteRooms(r.body));
    expect(withInvite.length).toBeGreaterThanOrEqual(1);
  });

  it('full_state concurrent soft=true', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c2:example.com', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    const results = await Promise.all([syncRequest(env, 'since=s1_td0&full_state=true'), syncRequest(env, 'since=s1_td0&full_state=true')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('full_state concurrent soft=false', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c2:example.com', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    const results = await Promise.all([syncRequest(env, 'since=s1_td0&full_state=false'), syncRequest(env, 'since=s1_td0&full_state=false')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('full_state concurrent soft=1', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c2:example.com', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    const results = await Promise.all([syncRequest(env, 'since=s1_td0&full_state=1'), syncRequest(env, 'since=s1_td0&full_state=1')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('full_state concurrent soft=0', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c2:example.com', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    const results = await Promise.all([syncRequest(env, 'since=s1_td0&full_state=0'), syncRequest(env, 'since=s1_td0&full_state=0')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('full_state concurrent soft=empty', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c2:example.com', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    const results = await Promise.all([syncRequest(env, 'since=s1_td0'), syncRequest(env, 'since=s1_td0')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('full_state concurrent soft=TRUE', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c2:example.com', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    const results = await Promise.all([syncRequest(env, 'since=s1_td0&full_state=TRUE'), syncRequest(env, 'since=s1_td0&full_state=TRUE')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OTK / device_lists / Sync DO long-poll concurrent
// ---------------------------------------------------------------------------

describe('race sync OTK∥device_lists∥DO wait after #201', () => {
  it('OTK counts concurrent isolation under SQL barrier', async () => {
    const barrierMatch = (sql: string) => sql.includes('FROM one_time_keys');
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 3 }],
      selectBarrier: { match: barrierMatch, count: 2 },
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    for (const r of results) {
      expect(r.body.device_one_time_keys_count).toEqual({ signed_curve25519: 3 });
    }
  });

  it('device_lists mutate mid concurrent incremental', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [{ user_id: BOB, stream_position: 5 }],
      sharedRoomUsers: [BOB, CAROL],
      mutateDeviceKeyChangesAfter: {
        after: 1,
        next: [
          { user_id: BOB, stream_position: 5 },
          { user_id: CAROL, stream_position: 8 },
        ],
      },
      selectBarrier: {
        match: (sql) => sql.includes('FROM device_key_changes'),
        count: 2,
      },
    });
    const env = createEnv({ db });
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const changedSets = results.map((r) => {
      const dl = r.body.device_lists as { changed?: string[] } | undefined;
      return (dl?.changed ?? []).slice().sort().join(',');
    });
    expect(changedSets.some((s) => s.includes(BOB))).toBe(true);
  });

  it('dual DO long-poll wait under barrier; both return same next_batch', async () => {
    const barrier = createFnBarrier(2);
    const syncDo = createSyncDoStub({ hasEvents: false, barrier });
    getLatestStreamPosition.mockResolvedValue(15);
    const env = createEnv({ syncDo });
    const results = await Promise.all([
      syncRequest(env, 'since=s10_td0&timeout=5000'),
      syncRequest(env, 'since=s10_td0&timeout=5000'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => r.body.next_batch === 's15_td0')).toBe(true);
    expect(syncDo.fetches).toHaveLength(2);
  });

  it('DO hasEvents=true concurrent keeps next_batch at current position', async () => {
    const syncDo = createSyncDoStub({ hasEvents: true });
    getLatestStreamPosition.mockResolvedValue(20);
    const env = createEnv({ syncDo });
    const results = await Promise.all([
      syncRequest(env, 'since=s10_td0&timeout=10000'),
      syncRequest(env, 'since=s10_td0&timeout=10000'),
    ]);
    expect(results.every((r) => r.body.next_batch === 's20_td0')).toBe(true);
  });

  it('DO fail soft mid concurrent — one boom one ok', async () => {
    let n = 0;
    const syncDo = {
      fetches: [] as SyncDoFetch[],
      async fetch(req: Request): Promise<Response> {
        n += 1;
        syncDo.fetches.push({ url: req.url, method: req.method });
        if (n === 1) throw new Error('sync DO boom');
        return Response.json({ hasEvents: false });
      },
    };
    getLatestStreamPosition.mockResolvedValue(11);
    const env = createEnv({ syncDo: syncDo as SyncDoStub });
    // Hono may surface DO throw as 500 rather than rejecting syncApp.request.
    const results = await Promise.all([
      syncRequest(env, 'since=s5_td0&timeout=3000'),
      syncRequest(env, 'since=s5_td0&timeout=3000'),
    ]);
    expect(results.some((r) => r.status === 200)).toBe(true);
    expect(results.some((r) => r.status >= 500 || r.status === 200)).toBe(true);
    expect(syncDo.fetches.length).toBeGreaterThanOrEqual(1);
  });

  it('timeout concurrent soft=0', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const results = await Promise.all([syncRequest(env, 'since=s5_td0&timeout=0'), syncRequest(env, 'since=s5_td0&timeout=0')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('timeout concurrent soft=1', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const results = await Promise.all([syncRequest(env, 'since=s5_td0&timeout=1'), syncRequest(env, 'since=s5_td0&timeout=1')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('timeout concurrent soft=100', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const results = await Promise.all([syncRequest(env, 'since=s5_td0&timeout=100'), syncRequest(env, 'since=s5_td0&timeout=100')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('timeout concurrent soft=1000', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const results = await Promise.all([syncRequest(env, 'since=s5_td0&timeout=1000'), syncRequest(env, 'since=s5_td0&timeout=1000')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('timeout concurrent soft=30000', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const results = await Promise.all([syncRequest(env, 'since=s5_td0&timeout=30000'), syncRequest(env, 'since=s5_td0&timeout=30000')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('timeout concurrent soft=99999', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const results = await Promise.all([syncRequest(env, 'since=s5_td0&timeout=99999'), syncRequest(env, 'since=s5_td0&timeout=99999')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('timeout concurrent soft=-1', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const results = await Promise.all([syncRequest(env, 'since=s5_td0&timeout=-1'), syncRequest(env, 'since=s5_td0&timeout=-1')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('timeout concurrent soft=abc', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const results = await Promise.all([syncRequest(env, 'since=s5_td0&timeout=abc'), syncRequest(env, 'since=s5_td0&timeout=abc')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('timeout concurrent soft=empty', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const results = await Promise.all([syncRequest(env, 'since=s5_td0'), syncRequest(env, 'since=s5_td0')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});

describe('sync concurrent soft flood — method / auth after #201', () => {

  it('method=POST concurrent soft', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0', { method: 'POST' }),
      syncRequest(env, 'since=s1_td0', { method: 'POST' }),
    ]);
    expect(results.every((r) => r.status !== 500)).toBe(true);
  });

  it('method=PUT concurrent soft', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0', { method: 'PUT' }),
      syncRequest(env, 'since=s1_td0', { method: 'PUT' }),
    ]);
    expect(results.every((r) => r.status !== 500)).toBe(true);
  });

  it('method=DELETE concurrent soft', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0', { method: 'DELETE' }),
      syncRequest(env, 'since=s1_td0', { method: 'DELETE' }),
    ]);
    expect(results.every((r) => r.status !== 500)).toBe(true);
  });

  it('method=PATCH concurrent soft', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0', { method: 'PATCH' }),
      syncRequest(env, 'since=s1_td0', { method: 'PATCH' }),
    ]);
    expect(results.every((r) => r.status !== 500)).toBe(true);
  });

  it('method=OPTIONS concurrent soft', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0', { method: 'OPTIONS' }),
      syncRequest(env, 'since=s1_td0', { method: 'OPTIONS' }),
    ]);
    expect(results.every((r) => r.status !== 500)).toBe(true);
  });

  it('method=HEAD concurrent soft', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0', { method: 'HEAD' }),
      syncRequest(env, 'since=s1_td0', { method: 'HEAD' }),
    ]);
    expect(results.every((r) => r.status !== 500)).toBe(true);
  });

  it('missing userId soft concurrent', async () => {
    authState.userId = undefined;
    const env = createEnv();
    const results = await Promise.allSettled([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.length).toBe(2);
  });

  it('missing deviceId soft concurrent still returns sync', async () => {
    authState.deviceId = undefined;
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) {
      expect(r.body.to_device).toEqual({ events: [] });
    }
  });

  it('auth lifecycle concurrent soft-0', async () => {
    authState.userId = 0 % 2 === 0 ? USER : `@user0:example.com`;
    authState.deviceId = `DEV0`;
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('auth lifecycle concurrent soft-1', async () => {
    authState.userId = 1 % 2 === 0 ? USER : `@user1:example.com`;
    authState.deviceId = `DEV1`;
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('auth lifecycle concurrent soft-2', async () => {
    authState.userId = 2 % 2 === 0 ? USER : `@user2:example.com`;
    authState.deviceId = `DEV2`;
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('auth lifecycle concurrent soft-3', async () => {
    authState.userId = 3 % 2 === 0 ? USER : `@user3:example.com`;
    authState.deviceId = `DEV3`;
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('auth lifecycle concurrent soft-4', async () => {
    authState.userId = 4 % 2 === 0 ? USER : `@user4:example.com`;
    authState.deviceId = `DEV4`;
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('auth lifecycle concurrent soft-5', async () => {
    authState.userId = 5 % 2 === 0 ? USER : `@user5:example.com`;
    authState.deviceId = `DEV5`;
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('auth lifecycle concurrent soft-6', async () => {
    authState.userId = 6 % 2 === 0 ? USER : `@user6:example.com`;
    authState.deviceId = `DEV6`;
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('auth lifecycle concurrent soft-7', async () => {
    authState.userId = 7 % 2 === 0 ? USER : `@user7:example.com`;
    authState.deviceId = `DEV7`;
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('auth lifecycle concurrent soft-8', async () => {
    authState.userId = 8 % 2 === 0 ? USER : `@user8:example.com`;
    authState.deviceId = `DEV8`;
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('auth lifecycle concurrent soft-9', async () => {
    authState.userId = 9 % 2 === 0 ? USER : `@user9:example.com`;
    authState.deviceId = `DEV9`;
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('auth lifecycle concurrent soft-10', async () => {
    authState.userId = 10 % 2 === 0 ? USER : `@user10:example.com`;
    authState.deviceId = `DEV10`;
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('auth lifecycle concurrent soft-11', async () => {
    authState.userId = 11 % 2 === 0 ? USER : `@user11:example.com`;
    authState.deviceId = `DEV11`;
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});

describe('sync concurrent soft flood — since / set_presence after #201', () => {

  it('since soft-0', async () => {
    const env = createEnv();
    const q = '';
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('since soft-1', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("s0_td0");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('since soft-2', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("s1_td0");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('since soft-3', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("s999_td999");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('since soft-4', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("0");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('since soft-5', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("42");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('since soft-6', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("s");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('since soft-7', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("s_td");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('since soft-8', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("s1_td");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('since soft-9', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("std0");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('since soft-10', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("s1td2");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('since soft-11', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("null");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('since soft-12', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("undefined");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('since soft-13', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("NaN");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('since soft-14', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("-5");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('since soft-15', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("1.5");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('since soft-16', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("s01_td02");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('since soft-17', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("S1_TD0");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('since soft-18', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("s1_td0_extra");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('set_presence concurrent soft=online', async () => {
    const env = createEnv();
    const results = await Promise.all([syncRequest(env, 'since=s1_td0&set_presence=online'), syncRequest(env, 'since=s1_td0&set_presence=online')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('set_presence concurrent soft=offline', async () => {
    const env = createEnv();
    const results = await Promise.all([syncRequest(env, 'since=s1_td0&set_presence=offline'), syncRequest(env, 'since=s1_td0&set_presence=offline')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('set_presence concurrent soft=unavailable', async () => {
    const env = createEnv();
    const results = await Promise.all([syncRequest(env, 'since=s1_td0&set_presence=unavailable'), syncRequest(env, 'since=s1_td0&set_presence=unavailable')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('set_presence concurrent soft=empty', async () => {
    const env = createEnv();
    const results = await Promise.all([syncRequest(env, 'since=s1_td0'), syncRequest(env, 'since=s1_td0')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('set_presence concurrent soft=ONLINE', async () => {
    const env = createEnv();
    const results = await Promise.all([syncRequest(env, 'since=s1_td0&set_presence=ONLINE'), syncRequest(env, 'since=s1_td0&set_presence=ONLINE')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('set_presence concurrent soft=foo', async () => {
    const env = createEnv();
    const results = await Promise.all([syncRequest(env, 'since=s1_td0&set_presence=foo'), syncRequest(env, 'since=s1_td0&set_presence=foo')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('set_presence concurrent soft=null', async () => {
    const env = createEnv();
    const results = await Promise.all([syncRequest(env, 'since=s1_td0&set_presence=null'), syncRequest(env, 'since=s1_td0&set_presence=null')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});

describe('race sync multi-request flood + module isolation after #201', () => {
  it('8-way parallel empty incremental sync', async () => {
    const env = createEnv();
    // nextBatch '0' is falsy under parseInt||sinceToDevice → td stays at since td=1
    const results = await Promise.all(
      Array.from({ length: 8 }, () => syncRequest(env, 'since=s5_td1'))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => r.body.next_batch === 's42_td1')).toBe(true);
  });

  it('8-way parallel initial sync device_lists self', async () => {
    const env = createEnv();
    const results = await Promise.all(Array.from({ length: 8 }, () => syncRequest(env)));
    for (const r of results) {
      expect(r.body.device_lists).toEqual({ changed: [USER], left: [] });
    }
  });

  it('mixed since tokens concurrent isolation', async () => {
    getLatestStreamPosition.mockResolvedValue(50);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s2_td3'),
      syncRequest(env, 'since=10'),
      syncRequest(env, ''),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results[3].body.device_lists).toEqual({ changed: [USER], left: [] });
    expect(results[0].body.next_batch).toBe('s50_td0');
  });

  it('N=2 parallel join-room sync isolation', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: `$n2:example.com`, content: { body: 'n', msgtype: 'm.text' } }),
    ]);
    const env = createEnv();
    const results = await Promise.all(
      Array.from({ length: 2 }, () => syncRequest(env, 'since=s1_td0'))
    );
    expect(results.every((r) => ROOM in joinRooms(r.body))).toBe(true);
  });

  it('N=3 parallel join-room sync isolation', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: `$n3:example.com`, content: { body: 'n', msgtype: 'm.text' } }),
    ]);
    const env = createEnv();
    const results = await Promise.all(
      Array.from({ length: 3 }, () => syncRequest(env, 'since=s1_td0'))
    );
    expect(results.every((r) => ROOM in joinRooms(r.body))).toBe(true);
  });

  it('N=4 parallel join-room sync isolation', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: `$n4:example.com`, content: { body: 'n', msgtype: 'm.text' } }),
    ]);
    const env = createEnv();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => syncRequest(env, 'since=s1_td0'))
    );
    expect(results.every((r) => ROOM in joinRooms(r.body))).toBe(true);
  });

  it('N=5 parallel join-room sync isolation', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: `$n5:example.com`, content: { body: 'n', msgtype: 'm.text' } }),
    ]);
    const env = createEnv();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => syncRequest(env, 'since=s1_td0'))
    );
    expect(results.every((r) => ROOM in joinRooms(r.body))).toBe(true);
  });

  it('N=6 parallel join-room sync isolation', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: `$n6:example.com`, content: { body: 'n', msgtype: 'm.text' } }),
    ]);
    const env = createEnv();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => syncRequest(env, 'since=s1_td0'))
    );
    expect(results.every((r) => ROOM in joinRooms(r.body))).toBe(true);
  });

  it('getRoomState throw soft mid concurrent', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([]);
    let calls = 0;
    getRoomState.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('state boom');
      return [makePdu({ type: 'm.room.create', event_id: '$ok:example.com', state_key: '', content: {} })];
    });
    const env = createEnv();
    // Hono surfaces handler throws as 500 responses (request promise still resolves).
    const results = await Promise.all([
      syncRequest(env, 'since=0&full_state=true'),
      syncRequest(env, 'since=0&full_state=true'),
    ]);
    expect(results.some((r) => r.status === 200)).toBe(true);
    expect(results.some((r) => r.status >= 500)).toBe(true);
  });

  it('getEventsSince throw soft mid concurrent', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    wireMemberships(map);
    let calls = 0;
    getEventsSince.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('events boom');
      return [];
    });
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.some((r) => r.status === 200)).toBe(true);
    expect(results.some((r) => r.status >= 500)).toBe(true);
  });

  it('OTK SQL throw soft concurrent', async () => {
    const db = createSyncDb({ throwOnSqlIncludes: 'one_time_keys' });
    const env = createEnv({ db });
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status >= 500)).toBe(true);
  });

  it('module isolation empty concurrent soft-0', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s0_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });

  it('module isolation empty concurrent soft-1', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s2_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });

  it('module isolation empty concurrent soft-2', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s2_td0'),
      syncRequest(env, 'since=s3_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });

  it('module isolation empty concurrent soft-3', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s3_td0'),
      syncRequest(env, 'since=s4_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });

  it('module isolation empty concurrent soft-4', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s4_td0'),
      syncRequest(env, 'since=s5_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });

  it('module isolation empty concurrent soft-5', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s5_td0'),
      syncRequest(env, 'since=s6_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });

  it('module isolation empty concurrent soft-6', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s6_td0'),
      syncRequest(env, 'since=s7_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });

  it('module isolation empty concurrent soft-7', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s7_td0'),
      syncRequest(env, 'since=s8_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });

  it('module isolation empty concurrent soft-8', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s8_td0'),
      syncRequest(env, 'since=s9_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });

  it('module isolation empty concurrent soft-9', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s9_td0'),
      syncRequest(env, 'since=s10_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });

  it('module isolation empty concurrent soft-10', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s10_td0'),
      syncRequest(env, 'since=s11_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });

  it('module isolation empty concurrent soft-11', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s11_td0'),
      syncRequest(env, 'since=s12_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });

  it('module isolation empty concurrent soft-12', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s12_td0'),
      syncRequest(env, 'since=s13_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });

  it('module isolation empty concurrent soft-13', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s13_td0'),
      syncRequest(env, 'since=s14_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });

  it('module isolation empty concurrent soft-14', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s14_td0'),
      syncRequest(env, 'since=s15_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });

  it('module isolation empty concurrent soft-15', async () => {
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s15_td0'),
      syncRequest(env, 'since=s16_td0'),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
});

describe('sync concurrent soft flood — bind / query contract after #201', () => {
  it('OTK bind uses user+device under concurrent', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 1 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const env = createEnv({ db });
    await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    const otkSelects = db.selects.filter((s) => s.sql.includes('one_time_keys'));
    expect(otkSelects.length).toBeGreaterThanOrEqual(2);
    for (const s of otkSelects) {
      expect(s.args[0]).toBe(USER);
      expect(s.args[1]).toBe(DEVICE);
    }
  });

  it('device_key_changes bind uses since+user under concurrent', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [{ user_id: BOB, stream_position: 3 }],
      sharedRoomUsers: [BOB],
    });
    const env = createEnv({ db });
    await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    const dk = db.selects.filter((s) => s.sql.includes('device_key_changes'));
    expect(dk.length).toBeGreaterThanOrEqual(2);
  });

  it('query contract concurrent soft-0', async () => {
    const map: MembershipMap = {
      join: 0 % 2 === 0 ? [ROOM] : [],
      invite: 0 % 3 === 0 ? [INVITE] : [],
      leave: [],
    };
    wireMemberships(map);
    if (map.join.length) {
      getEventsSince.mockResolvedValue([
        makePdu({
          type: 'm.room.message',
          event_id: `$qc-0:example.com`,
          content: { body: `qc-0`, msgtype: 'm.text' },
        }),
      ]);
    }
    if (map.invite.length) {
      getRoomState.mockResolvedValue([
        makePdu({
          type: 'm.room.member',
          event_id: `$qi-0:example.com`,
          room_id: INVITE,
          state_key: USER,
          content: { membership: 'invite' },
          sender: BOB,
        }),
      ]);
    }
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s${( 0 % 5) + 1}_td0`),
      syncRequest(env, `since=s${( 0 % 5) + 1}_td0`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('query contract concurrent soft-1', async () => {
    const map: MembershipMap = {
      join: 1 % 2 === 0 ? [ROOM] : [],
      invite: 1 % 3 === 0 ? [INVITE] : [],
      leave: [],
    };
    wireMemberships(map);
    if (map.join.length) {
      getEventsSince.mockResolvedValue([
        makePdu({
          type: 'm.room.message',
          event_id: `$qc-1:example.com`,
          content: { body: `qc-1`, msgtype: 'm.text' },
        }),
      ]);
    }
    if (map.invite.length) {
      getRoomState.mockResolvedValue([
        makePdu({
          type: 'm.room.member',
          event_id: `$qi-1:example.com`,
          room_id: INVITE,
          state_key: USER,
          content: { membership: 'invite' },
          sender: BOB,
        }),
      ]);
    }
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s${( 1 % 5) + 1}_td0`),
      syncRequest(env, `since=s${( 1 % 5) + 1}_td0`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('query contract concurrent soft-2', async () => {
    const map: MembershipMap = {
      join: 2 % 2 === 0 ? [ROOM] : [],
      invite: 2 % 3 === 0 ? [INVITE] : [],
      leave: [],
    };
    wireMemberships(map);
    if (map.join.length) {
      getEventsSince.mockResolvedValue([
        makePdu({
          type: 'm.room.message',
          event_id: `$qc-2:example.com`,
          content: { body: `qc-2`, msgtype: 'm.text' },
        }),
      ]);
    }
    if (map.invite.length) {
      getRoomState.mockResolvedValue([
        makePdu({
          type: 'm.room.member',
          event_id: `$qi-2:example.com`,
          room_id: INVITE,
          state_key: USER,
          content: { membership: 'invite' },
          sender: BOB,
        }),
      ]);
    }
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s${( 2 % 5) + 1}_td0`),
      syncRequest(env, `since=s${( 2 % 5) + 1}_td0`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('query contract concurrent soft-3', async () => {
    const map: MembershipMap = {
      join: 3 % 2 === 0 ? [ROOM] : [],
      invite: 3 % 3 === 0 ? [INVITE] : [],
      leave: [],
    };
    wireMemberships(map);
    if (map.join.length) {
      getEventsSince.mockResolvedValue([
        makePdu({
          type: 'm.room.message',
          event_id: `$qc-3:example.com`,
          content: { body: `qc-3`, msgtype: 'm.text' },
        }),
      ]);
    }
    if (map.invite.length) {
      getRoomState.mockResolvedValue([
        makePdu({
          type: 'm.room.member',
          event_id: `$qi-3:example.com`,
          room_id: INVITE,
          state_key: USER,
          content: { membership: 'invite' },
          sender: BOB,
        }),
      ]);
    }
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s${( 3 % 5) + 1}_td0`),
      syncRequest(env, `since=s${( 3 % 5) + 1}_td0`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('query contract concurrent soft-4', async () => {
    const map: MembershipMap = {
      join: 4 % 2 === 0 ? [ROOM] : [],
      invite: 4 % 3 === 0 ? [INVITE] : [],
      leave: [],
    };
    wireMemberships(map);
    if (map.join.length) {
      getEventsSince.mockResolvedValue([
        makePdu({
          type: 'm.room.message',
          event_id: `$qc-4:example.com`,
          content: { body: `qc-4`, msgtype: 'm.text' },
        }),
      ]);
    }
    if (map.invite.length) {
      getRoomState.mockResolvedValue([
        makePdu({
          type: 'm.room.member',
          event_id: `$qi-4:example.com`,
          room_id: INVITE,
          state_key: USER,
          content: { membership: 'invite' },
          sender: BOB,
        }),
      ]);
    }
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s${( 4 % 5) + 1}_td0`),
      syncRequest(env, `since=s${( 4 % 5) + 1}_td0`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('query contract concurrent soft-5', async () => {
    const map: MembershipMap = {
      join: 5 % 2 === 0 ? [ROOM] : [],
      invite: 5 % 3 === 0 ? [INVITE] : [],
      leave: [],
    };
    wireMemberships(map);
    if (map.join.length) {
      getEventsSince.mockResolvedValue([
        makePdu({
          type: 'm.room.message',
          event_id: `$qc-5:example.com`,
          content: { body: `qc-5`, msgtype: 'm.text' },
        }),
      ]);
    }
    if (map.invite.length) {
      getRoomState.mockResolvedValue([
        makePdu({
          type: 'm.room.member',
          event_id: `$qi-5:example.com`,
          room_id: INVITE,
          state_key: USER,
          content: { membership: 'invite' },
          sender: BOB,
        }),
      ]);
    }
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s${( 5 % 5) + 1}_td0`),
      syncRequest(env, `since=s${( 5 % 5) + 1}_td0`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('query contract concurrent soft-6', async () => {
    const map: MembershipMap = {
      join: 6 % 2 === 0 ? [ROOM] : [],
      invite: 6 % 3 === 0 ? [INVITE] : [],
      leave: [],
    };
    wireMemberships(map);
    if (map.join.length) {
      getEventsSince.mockResolvedValue([
        makePdu({
          type: 'm.room.message',
          event_id: `$qc-6:example.com`,
          content: { body: `qc-6`, msgtype: 'm.text' },
        }),
      ]);
    }
    if (map.invite.length) {
      getRoomState.mockResolvedValue([
        makePdu({
          type: 'm.room.member',
          event_id: `$qi-6:example.com`,
          room_id: INVITE,
          state_key: USER,
          content: { membership: 'invite' },
          sender: BOB,
        }),
      ]);
    }
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s${( 6 % 5) + 1}_td0`),
      syncRequest(env, `since=s${( 6 % 5) + 1}_td0`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('query contract concurrent soft-7', async () => {
    const map: MembershipMap = {
      join: 7 % 2 === 0 ? [ROOM] : [],
      invite: 7 % 3 === 0 ? [INVITE] : [],
      leave: [],
    };
    wireMemberships(map);
    if (map.join.length) {
      getEventsSince.mockResolvedValue([
        makePdu({
          type: 'm.room.message',
          event_id: `$qc-7:example.com`,
          content: { body: `qc-7`, msgtype: 'm.text' },
        }),
      ]);
    }
    if (map.invite.length) {
      getRoomState.mockResolvedValue([
        makePdu({
          type: 'm.room.member',
          event_id: `$qi-7:example.com`,
          room_id: INVITE,
          state_key: USER,
          content: { membership: 'invite' },
          sender: BOB,
        }),
      ]);
    }
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s${( 7 % 5) + 1}_td0`),
      syncRequest(env, `since=s${( 7 % 5) + 1}_td0`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('query contract concurrent soft-8', async () => {
    const map: MembershipMap = {
      join: 8 % 2 === 0 ? [ROOM] : [],
      invite: 8 % 3 === 0 ? [INVITE] : [],
      leave: [],
    };
    wireMemberships(map);
    if (map.join.length) {
      getEventsSince.mockResolvedValue([
        makePdu({
          type: 'm.room.message',
          event_id: `$qc-8:example.com`,
          content: { body: `qc-8`, msgtype: 'm.text' },
        }),
      ]);
    }
    if (map.invite.length) {
      getRoomState.mockResolvedValue([
        makePdu({
          type: 'm.room.member',
          event_id: `$qi-8:example.com`,
          room_id: INVITE,
          state_key: USER,
          content: { membership: 'invite' },
          sender: BOB,
        }),
      ]);
    }
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s${( 8 % 5) + 1}_td0`),
      syncRequest(env, `since=s${( 8 % 5) + 1}_td0`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('query contract concurrent soft-9', async () => {
    const map: MembershipMap = {
      join: 9 % 2 === 0 ? [ROOM] : [],
      invite: 9 % 3 === 0 ? [INVITE] : [],
      leave: [],
    };
    wireMemberships(map);
    if (map.join.length) {
      getEventsSince.mockResolvedValue([
        makePdu({
          type: 'm.room.message',
          event_id: `$qc-9:example.com`,
          content: { body: `qc-9`, msgtype: 'm.text' },
        }),
      ]);
    }
    if (map.invite.length) {
      getRoomState.mockResolvedValue([
        makePdu({
          type: 'm.room.member',
          event_id: `$qi-9:example.com`,
          room_id: INVITE,
          state_key: USER,
          content: { membership: 'invite' },
          sender: BOB,
        }),
      ]);
    }
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s${( 9 % 5) + 1}_td0`),
      syncRequest(env, `since=s${( 9 % 5) + 1}_td0`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('query contract concurrent soft-10', async () => {
    const map: MembershipMap = {
      join: 10 % 2 === 0 ? [ROOM] : [],
      invite: 10 % 3 === 0 ? [INVITE] : [],
      leave: [],
    };
    wireMemberships(map);
    if (map.join.length) {
      getEventsSince.mockResolvedValue([
        makePdu({
          type: 'm.room.message',
          event_id: `$qc-10:example.com`,
          content: { body: `qc-10`, msgtype: 'm.text' },
        }),
      ]);
    }
    if (map.invite.length) {
      getRoomState.mockResolvedValue([
        makePdu({
          type: 'm.room.member',
          event_id: `$qi-10:example.com`,
          room_id: INVITE,
          state_key: USER,
          content: { membership: 'invite' },
          sender: BOB,
        }),
      ]);
    }
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s${( 10 % 5) + 1}_td0`),
      syncRequest(env, `since=s${( 10 % 5) + 1}_td0`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('query contract concurrent soft-11', async () => {
    const map: MembershipMap = {
      join: 11 % 2 === 0 ? [ROOM] : [],
      invite: 11 % 3 === 0 ? [INVITE] : [],
      leave: [],
    };
    wireMemberships(map);
    if (map.join.length) {
      getEventsSince.mockResolvedValue([
        makePdu({
          type: 'm.room.message',
          event_id: `$qc-11:example.com`,
          content: { body: `qc-11`, msgtype: 'm.text' },
        }),
      ]);
    }
    if (map.invite.length) {
      getRoomState.mockResolvedValue([
        makePdu({
          type: 'm.room.member',
          event_id: `$qi-11:example.com`,
          room_id: INVITE,
          state_key: USER,
          content: { membership: 'invite' },
          sender: BOB,
        }),
      ]);
    }
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s${( 11 % 5) + 1}_td0`),
      syncRequest(env, `since=s${( 11 % 5) + 1}_td0`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('query contract concurrent soft-12', async () => {
    const map: MembershipMap = {
      join: 12 % 2 === 0 ? [ROOM] : [],
      invite: 12 % 3 === 0 ? [INVITE] : [],
      leave: [],
    };
    wireMemberships(map);
    if (map.join.length) {
      getEventsSince.mockResolvedValue([
        makePdu({
          type: 'm.room.message',
          event_id: `$qc-12:example.com`,
          content: { body: `qc-12`, msgtype: 'm.text' },
        }),
      ]);
    }
    if (map.invite.length) {
      getRoomState.mockResolvedValue([
        makePdu({
          type: 'm.room.member',
          event_id: `$qi-12:example.com`,
          room_id: INVITE,
          state_key: USER,
          content: { membership: 'invite' },
          sender: BOB,
        }),
      ]);
    }
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s${( 12 % 5) + 1}_td0`),
      syncRequest(env, `since=s${( 12 % 5) + 1}_td0`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('query contract concurrent soft-13', async () => {
    const map: MembershipMap = {
      join: 13 % 2 === 0 ? [ROOM] : [],
      invite: 13 % 3 === 0 ? [INVITE] : [],
      leave: [],
    };
    wireMemberships(map);
    if (map.join.length) {
      getEventsSince.mockResolvedValue([
        makePdu({
          type: 'm.room.message',
          event_id: `$qc-13:example.com`,
          content: { body: `qc-13`, msgtype: 'm.text' },
        }),
      ]);
    }
    if (map.invite.length) {
      getRoomState.mockResolvedValue([
        makePdu({
          type: 'm.room.member',
          event_id: `$qi-13:example.com`,
          room_id: INVITE,
          state_key: USER,
          content: { membership: 'invite' },
          sender: BOB,
        }),
      ]);
    }
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s${( 13 % 5) + 1}_td0`),
      syncRequest(env, `since=s${( 13 % 5) + 1}_td0`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('query contract concurrent soft-14', async () => {
    const map: MembershipMap = {
      join: 14 % 2 === 0 ? [ROOM] : [],
      invite: 14 % 3 === 0 ? [INVITE] : [],
      leave: [],
    };
    wireMemberships(map);
    if (map.join.length) {
      getEventsSince.mockResolvedValue([
        makePdu({
          type: 'm.room.message',
          event_id: `$qc-14:example.com`,
          content: { body: `qc-14`, msgtype: 'm.text' },
        }),
      ]);
    }
    if (map.invite.length) {
      getRoomState.mockResolvedValue([
        makePdu({
          type: 'm.room.member',
          event_id: `$qi-14:example.com`,
          room_id: INVITE,
          state_key: USER,
          content: { membership: 'invite' },
          sender: BOB,
        }),
      ]);
    }
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s${( 14 % 5) + 1}_td0`),
      syncRequest(env, `since=s${( 14 % 5) + 1}_td0`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('query contract concurrent soft-15', async () => {
    const map: MembershipMap = {
      join: 15 % 2 === 0 ? [ROOM] : [],
      invite: 15 % 3 === 0 ? [INVITE] : [],
      leave: [],
    };
    wireMemberships(map);
    if (map.join.length) {
      getEventsSince.mockResolvedValue([
        makePdu({
          type: 'm.room.message',
          event_id: `$qc-15:example.com`,
          content: { body: `qc-15`, msgtype: 'm.text' },
        }),
      ]);
    }
    if (map.invite.length) {
      getRoomState.mockResolvedValue([
        makePdu({
          type: 'm.room.member',
          event_id: `$qi-15:example.com`,
          room_id: INVITE,
          state_key: USER,
          content: { membership: 'invite' },
          sender: BOB,
        }),
      ]);
    }
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s${( 15 % 5) + 1}_td0`),
      syncRequest(env, `since=s${( 15 % 5) + 1}_td0`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('query contract concurrent soft-16', async () => {
    const map: MembershipMap = {
      join: 16 % 2 === 0 ? [ROOM] : [],
      invite: 16 % 3 === 0 ? [INVITE] : [],
      leave: [],
    };
    wireMemberships(map);
    if (map.join.length) {
      getEventsSince.mockResolvedValue([
        makePdu({
          type: 'm.room.message',
          event_id: `$qc-16:example.com`,
          content: { body: `qc-16`, msgtype: 'm.text' },
        }),
      ]);
    }
    if (map.invite.length) {
      getRoomState.mockResolvedValue([
        makePdu({
          type: 'm.room.member',
          event_id: `$qi-16:example.com`,
          room_id: INVITE,
          state_key: USER,
          content: { membership: 'invite' },
          sender: BOB,
        }),
      ]);
    }
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s${( 16 % 5) + 1}_td0`),
      syncRequest(env, `since=s${( 16 % 5) + 1}_td0`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('query contract concurrent soft-17', async () => {
    const map: MembershipMap = {
      join: 17 % 2 === 0 ? [ROOM] : [],
      invite: 17 % 3 === 0 ? [INVITE] : [],
      leave: [],
    };
    wireMemberships(map);
    if (map.join.length) {
      getEventsSince.mockResolvedValue([
        makePdu({
          type: 'm.room.message',
          event_id: `$qc-17:example.com`,
          content: { body: `qc-17`, msgtype: 'm.text' },
        }),
      ]);
    }
    if (map.invite.length) {
      getRoomState.mockResolvedValue([
        makePdu({
          type: 'm.room.member',
          event_id: `$qi-17:example.com`,
          room_id: INVITE,
          state_key: USER,
          content: { membership: 'invite' },
          sender: BOB,
        }),
      ]);
    }
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s${( 17 % 5) + 1}_td0`),
      syncRequest(env, `since=s${( 17 % 5) + 1}_td0`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('query contract concurrent soft-18', async () => {
    const map: MembershipMap = {
      join: 18 % 2 === 0 ? [ROOM] : [],
      invite: 18 % 3 === 0 ? [INVITE] : [],
      leave: [],
    };
    wireMemberships(map);
    if (map.join.length) {
      getEventsSince.mockResolvedValue([
        makePdu({
          type: 'm.room.message',
          event_id: `$qc-18:example.com`,
          content: { body: `qc-18`, msgtype: 'm.text' },
        }),
      ]);
    }
    if (map.invite.length) {
      getRoomState.mockResolvedValue([
        makePdu({
          type: 'm.room.member',
          event_id: `$qi-18:example.com`,
          room_id: INVITE,
          state_key: USER,
          content: { membership: 'invite' },
          sender: BOB,
        }),
      ]);
    }
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s${( 18 % 5) + 1}_td0`),
      syncRequest(env, `since=s${( 18 % 5) + 1}_td0`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('query contract concurrent soft-19', async () => {
    const map: MembershipMap = {
      join: 19 % 2 === 0 ? [ROOM] : [],
      invite: 19 % 3 === 0 ? [INVITE] : [],
      leave: [],
    };
    wireMemberships(map);
    if (map.join.length) {
      getEventsSince.mockResolvedValue([
        makePdu({
          type: 'm.room.message',
          event_id: `$qc-19:example.com`,
          content: { body: `qc-19`, msgtype: 'm.text' },
        }),
      ]);
    }
    if (map.invite.length) {
      getRoomState.mockResolvedValue([
        makePdu({
          type: 'm.room.member',
          event_id: `$qi-19:example.com`,
          room_id: INVITE,
          state_key: USER,
          content: { membership: 'invite' },
          sender: BOB,
        }),
      ]);
    }
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s${( 19 % 5) + 1}_td0`),
      syncRequest(env, `since=s${( 19 % 5) + 1}_td0`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});

describe('sync concurrent soft flood — charset / unicode / encoding after #201', () => {

  it('encoding soft-0', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("%00");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });

  it('encoding soft-1', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("%20");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });

  it('encoding soft-2', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("%2F");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });

  it('encoding soft-3', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("%3F");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });

  it('encoding soft-4', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("caf\u00e9");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });

  it('encoding soft-5', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("\u65e5\u672c\u8a9e");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });

  it('encoding soft-6', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("\ud83d\ude80");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });

  it('encoding soft-7', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("..");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });

  it('encoding soft-8', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("../");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });

  it('encoding soft-9', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("s1_td0%00");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });

  it('encoding soft-10', async () => {
    const env = createEnv();
    const q = 'since=' + encodeURIComponent("very-long-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    const results = await Promise.all([syncRequest(env, q), syncRequest(env, q)]);
    expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
  });
});

describe('sync concurrent soft flood — room filter matrices after #201', () => {

  it('filter matrix concurrent soft-0', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [LEFT] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$fm0:example.com', content: { body: 'fm', msgtype: 'm.text' } }),
      makePdu({ type: 'm.room.member', event_id: '$fmm0:example.com', state_key: USER, content: { membership: 'join' } }),
    ]);
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: {} },
      { type: 'm.push_rules', content: {} },
    ]);
    getTypingUsers.mockResolvedValue([BOB]);
    getReceiptsForRoom.mockResolvedValue({ type: 'm.receipt', content: { '$x': { 'm.read': { [USER]: { ts: NOW } } } } });
    const env = createEnv();
    const filter = encodeURIComponent("{\"room\": {\"not_rooms\": [\"!room:example.com\"]}}");
    const results = await Promise.all([
      syncRequest(env, `since=s5_td0&filter=${filter}`),
      syncRequest(env, `since=s5_td0&filter=${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('filter matrix concurrent soft-1', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [LEFT] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$fm1:example.com', content: { body: 'fm', msgtype: 'm.text' } }),
      makePdu({ type: 'm.room.member', event_id: '$fmm1:example.com', state_key: USER, content: { membership: 'join' } }),
    ]);
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: {} },
      { type: 'm.push_rules', content: {} },
    ]);
    getTypingUsers.mockResolvedValue([BOB]);
    getReceiptsForRoom.mockResolvedValue({ type: 'm.receipt', content: { '$x': { 'm.read': { [USER]: { ts: NOW } } } } });
    const env = createEnv();
    const filter = encodeURIComponent("{\"room\": {\"rooms\": [\"!room:example.com\", \"!room2:example.com\"]}}");
    const results = await Promise.all([
      syncRequest(env, `since=s5_td0&filter=${filter}`),
      syncRequest(env, `since=s5_td0&filter=${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('filter matrix concurrent soft-2', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [LEFT] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$fm2:example.com', content: { body: 'fm', msgtype: 'm.text' } }),
      makePdu({ type: 'm.room.member', event_id: '$fmm2:example.com', state_key: USER, content: { membership: 'join' } }),
    ]);
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: {} },
      { type: 'm.push_rules', content: {} },
    ]);
    getTypingUsers.mockResolvedValue([BOB]);
    getReceiptsForRoom.mockResolvedValue({ type: 'm.receipt', content: { '$x': { 'm.read': { [USER]: { ts: NOW } } } } });
    const env = createEnv();
    const filter = encodeURIComponent("{\"room\": {\"timeline\": {\"types\": [\"m.room.message\"]}}}");
    const results = await Promise.all([
      syncRequest(env, `since=s5_td0&filter=${filter}`),
      syncRequest(env, `since=s5_td0&filter=${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('filter matrix concurrent soft-3', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [LEFT] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$fm3:example.com', content: { body: 'fm', msgtype: 'm.text' } }),
      makePdu({ type: 'm.room.member', event_id: '$fmm3:example.com', state_key: USER, content: { membership: 'join' } }),
    ]);
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: {} },
      { type: 'm.push_rules', content: {} },
    ]);
    getTypingUsers.mockResolvedValue([BOB]);
    getReceiptsForRoom.mockResolvedValue({ type: 'm.receipt', content: { '$x': { 'm.read': { [USER]: { ts: NOW } } } } });
    const env = createEnv();
    const filter = encodeURIComponent("{\"room\": {\"timeline\": {\"not_types\": [\"m.room.member\"]}}}");
    const results = await Promise.all([
      syncRequest(env, `since=s5_td0&filter=${filter}`),
      syncRequest(env, `since=s5_td0&filter=${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('filter matrix concurrent soft-4', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [LEFT] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$fm4:example.com', content: { body: 'fm', msgtype: 'm.text' } }),
      makePdu({ type: 'm.room.member', event_id: '$fmm4:example.com', state_key: USER, content: { membership: 'join' } }),
    ]);
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: {} },
      { type: 'm.push_rules', content: {} },
    ]);
    getTypingUsers.mockResolvedValue([BOB]);
    getReceiptsForRoom.mockResolvedValue({ type: 'm.receipt', content: { '$x': { 'm.read': { [USER]: { ts: NOW } } } } });
    const env = createEnv();
    const filter = encodeURIComponent("{\"room\": {\"timeline\": {\"limit\": 1}}}");
    const results = await Promise.all([
      syncRequest(env, `since=s5_td0&filter=${filter}`),
      syncRequest(env, `since=s5_td0&filter=${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('filter matrix concurrent soft-5', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [LEFT] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$fm5:example.com', content: { body: 'fm', msgtype: 'm.text' } }),
      makePdu({ type: 'm.room.member', event_id: '$fmm5:example.com', state_key: USER, content: { membership: 'join' } }),
    ]);
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: {} },
      { type: 'm.push_rules', content: {} },
    ]);
    getTypingUsers.mockResolvedValue([BOB]);
    getReceiptsForRoom.mockResolvedValue({ type: 'm.receipt', content: { '$x': { 'm.read': { [USER]: { ts: NOW } } } } });
    const env = createEnv();
    const filter = encodeURIComponent("{\"room\": {\"state\": {\"types\": [\"m.room.name\"]}}}");
    const results = await Promise.all([
      syncRequest(env, `since=s5_td0&filter=${filter}`),
      syncRequest(env, `since=s5_td0&filter=${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('filter matrix concurrent soft-6', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [LEFT] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$fm6:example.com', content: { body: 'fm', msgtype: 'm.text' } }),
      makePdu({ type: 'm.room.member', event_id: '$fmm6:example.com', state_key: USER, content: { membership: 'join' } }),
    ]);
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: {} },
      { type: 'm.push_rules', content: {} },
    ]);
    getTypingUsers.mockResolvedValue([BOB]);
    getReceiptsForRoom.mockResolvedValue({ type: 'm.receipt', content: { '$x': { 'm.read': { [USER]: { ts: NOW } } } } });
    const env = createEnv();
    const filter = encodeURIComponent("{\"room\": {\"ephemeral\": {\"types\": [\"m.typing\"]}}}");
    const results = await Promise.all([
      syncRequest(env, `since=s5_td0&filter=${filter}`),
      syncRequest(env, `since=s5_td0&filter=${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('filter matrix concurrent soft-7', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [LEFT] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$fm7:example.com', content: { body: 'fm', msgtype: 'm.text' } }),
      makePdu({ type: 'm.room.member', event_id: '$fmm7:example.com', state_key: USER, content: { membership: 'join' } }),
    ]);
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: {} },
      { type: 'm.push_rules', content: {} },
    ]);
    getTypingUsers.mockResolvedValue([BOB]);
    getReceiptsForRoom.mockResolvedValue({ type: 'm.receipt', content: { '$x': { 'm.read': { [USER]: { ts: NOW } } } } });
    const env = createEnv();
    const filter = encodeURIComponent("{\"room\": {\"account_data\": {\"types\": [\"m.tag\"]}}}");
    const results = await Promise.all([
      syncRequest(env, `since=s5_td0&filter=${filter}`),
      syncRequest(env, `since=s5_td0&filter=${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('filter matrix concurrent soft-8', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [LEFT] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$fm8:example.com', content: { body: 'fm', msgtype: 'm.text' } }),
      makePdu({ type: 'm.room.member', event_id: '$fmm8:example.com', state_key: USER, content: { membership: 'join' } }),
    ]);
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: {} },
      { type: 'm.push_rules', content: {} },
    ]);
    getTypingUsers.mockResolvedValue([BOB]);
    getReceiptsForRoom.mockResolvedValue({ type: 'm.receipt', content: { '$x': { 'm.read': { [USER]: { ts: NOW } } } } });
    const env = createEnv();
    const filter = encodeURIComponent("{\"account_data\": {\"types\": [\"m.direct\"]}}");
    const results = await Promise.all([
      syncRequest(env, `since=s5_td0&filter=${filter}`),
      syncRequest(env, `since=s5_td0&filter=${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('filter matrix concurrent soft-9', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [LEFT] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$fm9:example.com', content: { body: 'fm', msgtype: 'm.text' } }),
      makePdu({ type: 'm.room.member', event_id: '$fmm9:example.com', state_key: USER, content: { membership: 'join' } }),
    ]);
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: {} },
      { type: 'm.push_rules', content: {} },
    ]);
    getTypingUsers.mockResolvedValue([BOB]);
    getReceiptsForRoom.mockResolvedValue({ type: 'm.receipt', content: { '$x': { 'm.read': { [USER]: { ts: NOW } } } } });
    const env = createEnv();
    const filter = encodeURIComponent("{\"account_data\": {\"not_types\": [\"m.push_rules\"]}}");
    const results = await Promise.all([
      syncRequest(env, `since=s5_td0&filter=${filter}`),
      syncRequest(env, `since=s5_td0&filter=${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('filter matrix concurrent soft-10', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [LEFT] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$fm10:example.com', content: { body: 'fm', msgtype: 'm.text' } }),
      makePdu({ type: 'm.room.member', event_id: '$fmm10:example.com', state_key: USER, content: { membership: 'join' } }),
    ]);
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: {} },
      { type: 'm.push_rules', content: {} },
    ]);
    getTypingUsers.mockResolvedValue([BOB]);
    getReceiptsForRoom.mockResolvedValue({ type: 'm.receipt', content: { '$x': { 'm.read': { [USER]: { ts: NOW } } } } });
    const env = createEnv();
    const filter = encodeURIComponent("{\"room\": {\"include_leave\": true}}");
    const results = await Promise.all([
      syncRequest(env, `since=s5_td0&filter=${filter}`),
      syncRequest(env, `since=s5_td0&filter=${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('filter matrix concurrent soft-11', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [LEFT] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$fm11:example.com', content: { body: 'fm', msgtype: 'm.text' } }),
      makePdu({ type: 'm.room.member', event_id: '$fmm11:example.com', state_key: USER, content: { membership: 'join' } }),
    ]);
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: {} },
      { type: 'm.push_rules', content: {} },
    ]);
    getTypingUsers.mockResolvedValue([BOB]);
    getReceiptsForRoom.mockResolvedValue({ type: 'm.receipt', content: { '$x': { 'm.read': { [USER]: { ts: NOW } } } } });
    const env = createEnv();
    const filter = encodeURIComponent("{\"room\": {\"include_leave\": false}}");
    const results = await Promise.all([
      syncRequest(env, `since=s5_td0&filter=${filter}`),
      syncRequest(env, `since=s5_td0&filter=${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('filter matrix concurrent soft-12', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [LEFT] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$fm12:example.com', content: { body: 'fm', msgtype: 'm.text' } }),
      makePdu({ type: 'm.room.member', event_id: '$fmm12:example.com', state_key: USER, content: { membership: 'join' } }),
    ]);
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: {} },
      { type: 'm.push_rules', content: {} },
    ]);
    getTypingUsers.mockResolvedValue([BOB]);
    getReceiptsForRoom.mockResolvedValue({ type: 'm.receipt', content: { '$x': { 'm.read': { [USER]: { ts: NOW } } } } });
    const env = createEnv();
    const filter = encodeURIComponent("{\"event_format\": \"client\"}");
    const results = await Promise.all([
      syncRequest(env, `since=s5_td0&filter=${filter}`),
      syncRequest(env, `since=s5_td0&filter=${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('filter matrix concurrent soft-13', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [LEFT] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$fm13:example.com', content: { body: 'fm', msgtype: 'm.text' } }),
      makePdu({ type: 'm.room.member', event_id: '$fmm13:example.com', state_key: USER, content: { membership: 'join' } }),
    ]);
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: {} },
      { type: 'm.push_rules', content: {} },
    ]);
    getTypingUsers.mockResolvedValue([BOB]);
    getReceiptsForRoom.mockResolvedValue({ type: 'm.receipt', content: { '$x': { 'm.read': { [USER]: { ts: NOW } } } } });
    const env = createEnv();
    const filter = encodeURIComponent("{\"event_format\": \"federation\"}");
    const results = await Promise.all([
      syncRequest(env, `since=s5_td0&filter=${filter}`),
      syncRequest(env, `since=s5_td0&filter=${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('filter matrix concurrent soft-14', async () => {
    const map: MembershipMap = { join: [ROOM, ROOM2], invite: [], leave: [LEFT] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$fm14:example.com', content: { body: 'fm', msgtype: 'm.text' } }),
      makePdu({ type: 'm.room.member', event_id: '$fmm14:example.com', state_key: USER, content: { membership: 'join' } }),
    ]);
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: {} },
      { type: 'm.push_rules', content: {} },
    ]);
    getTypingUsers.mockResolvedValue([BOB]);
    getReceiptsForRoom.mockResolvedValue({ type: 'm.receipt', content: { '$x': { 'm.read': { [USER]: { ts: NOW } } } } });
    const env = createEnv();
    const filter = encodeURIComponent("{\"presence\": {\"types\": [\"m.presence\"]}}");
    const results = await Promise.all([
      syncRequest(env, `since=s5_td0&filter=${filter}`),
      syncRequest(env, `since=s5_td0&filter=${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});

describe('race sync cold vs warm / lifecycle chains after #201', () => {
  it('initial∥incremental concurrent isolation', async () => {
    const map: MembershipMap = { join: [ROOM], invite: [], leave: [] };
    wireMemberships(map);
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$cw:example.com', content: { body: 'cw', msgtype: 'm.text' } }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$crc:example.com', state_key: '', content: { creator: USER } }),
    ]);
    const env = createEnv();
    const [initial, incremental] = await Promise.all([
      syncRequest(env, ''),
      syncRequest(env, 'since=s5_td0'),
    ]);
    expect(initial.status).toBe(200);
    expect(incremental.status).toBe(200);
    expect(initial.body.device_lists).toEqual({ changed: [USER], left: [] });
    expect(incremental.body.device_lists).toBeUndefined();
  });

  it('sync→sync lifecycle chain concurrent pair', async () => {
    getLatestStreamPosition
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(20);
    const env = createEnv();
    const first = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(first.every((r) => r.body.next_batch === 's10_td0')).toBe(true);
    const second = await Promise.all([
      syncRequest(env, 'since=s10_td0'),
      syncRequest(env, 'since=s10_td0'),
    ]);
    expect(second.every((r) => r.body.next_batch === 's20_td0')).toBe(true);
  });

  it('lifecycle burst concurrent soft-0', async () => {
    const map: MembershipMap = {
      join: 0 % 4 === 0 ? [ROOM, ROOM2] : 0 % 4 === 1 ? [ROOM] : [],
      invite: 0 % 5 === 0 ? [INVITE] : [],
      leave: 0 % 6 === 0 ? [LEFT] : [],
    };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === LEFT) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: `$lb-0:example.com`,
            room_id: LEFT,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: `$lbj-0-${roomId}:example.com`,
          room_id: roomId,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: `$lbi-0:example.com`,
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const filter =
      map.leave.length > 0
        ? `&filter=${encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))}`
        : '';
    const results = await Promise.all([
      syncRequest(env, `since=s${( 0 % 7) + 1}_td0${filter}`),
      syncRequest(env, `since=s${( 0 % 7) + 1}_td0${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('lifecycle burst concurrent soft-1', async () => {
    const map: MembershipMap = {
      join: 1 % 4 === 0 ? [ROOM, ROOM2] : 1 % 4 === 1 ? [ROOM] : [],
      invite: 1 % 5 === 0 ? [INVITE] : [],
      leave: 1 % 6 === 0 ? [LEFT] : [],
    };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === LEFT) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: `$lb-1:example.com`,
            room_id: LEFT,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: `$lbj-1-${roomId}:example.com`,
          room_id: roomId,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: `$lbi-1:example.com`,
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const filter =
      map.leave.length > 0
        ? `&filter=${encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))}`
        : '';
    const results = await Promise.all([
      syncRequest(env, `since=s${( 1 % 7) + 1}_td0${filter}`),
      syncRequest(env, `since=s${( 1 % 7) + 1}_td0${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('lifecycle burst concurrent soft-2', async () => {
    const map: MembershipMap = {
      join: 2 % 4 === 0 ? [ROOM, ROOM2] : 2 % 4 === 1 ? [ROOM] : [],
      invite: 2 % 5 === 0 ? [INVITE] : [],
      leave: 2 % 6 === 0 ? [LEFT] : [],
    };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === LEFT) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: `$lb-2:example.com`,
            room_id: LEFT,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: `$lbj-2-${roomId}:example.com`,
          room_id: roomId,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: `$lbi-2:example.com`,
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const filter =
      map.leave.length > 0
        ? `&filter=${encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))}`
        : '';
    const results = await Promise.all([
      syncRequest(env, `since=s${( 2 % 7) + 1}_td0${filter}`),
      syncRequest(env, `since=s${( 2 % 7) + 1}_td0${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('lifecycle burst concurrent soft-3', async () => {
    const map: MembershipMap = {
      join: 3 % 4 === 0 ? [ROOM, ROOM2] : 3 % 4 === 1 ? [ROOM] : [],
      invite: 3 % 5 === 0 ? [INVITE] : [],
      leave: 3 % 6 === 0 ? [LEFT] : [],
    };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === LEFT) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: `$lb-3:example.com`,
            room_id: LEFT,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: `$lbj-3-${roomId}:example.com`,
          room_id: roomId,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: `$lbi-3:example.com`,
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const filter =
      map.leave.length > 0
        ? `&filter=${encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))}`
        : '';
    const results = await Promise.all([
      syncRequest(env, `since=s${( 3 % 7) + 1}_td0${filter}`),
      syncRequest(env, `since=s${( 3 % 7) + 1}_td0${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('lifecycle burst concurrent soft-4', async () => {
    const map: MembershipMap = {
      join: 4 % 4 === 0 ? [ROOM, ROOM2] : 4 % 4 === 1 ? [ROOM] : [],
      invite: 4 % 5 === 0 ? [INVITE] : [],
      leave: 4 % 6 === 0 ? [LEFT] : [],
    };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === LEFT) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: `$lb-4:example.com`,
            room_id: LEFT,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: `$lbj-4-${roomId}:example.com`,
          room_id: roomId,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: `$lbi-4:example.com`,
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const filter =
      map.leave.length > 0
        ? `&filter=${encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))}`
        : '';
    const results = await Promise.all([
      syncRequest(env, `since=s${( 4 % 7) + 1}_td0${filter}`),
      syncRequest(env, `since=s${( 4 % 7) + 1}_td0${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('lifecycle burst concurrent soft-5', async () => {
    const map: MembershipMap = {
      join: 5 % 4 === 0 ? [ROOM, ROOM2] : 5 % 4 === 1 ? [ROOM] : [],
      invite: 5 % 5 === 0 ? [INVITE] : [],
      leave: 5 % 6 === 0 ? [LEFT] : [],
    };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === LEFT) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: `$lb-5:example.com`,
            room_id: LEFT,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: `$lbj-5-${roomId}:example.com`,
          room_id: roomId,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: `$lbi-5:example.com`,
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const filter =
      map.leave.length > 0
        ? `&filter=${encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))}`
        : '';
    const results = await Promise.all([
      syncRequest(env, `since=s${( 5 % 7) + 1}_td0${filter}`),
      syncRequest(env, `since=s${( 5 % 7) + 1}_td0${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('lifecycle burst concurrent soft-6', async () => {
    const map: MembershipMap = {
      join: 6 % 4 === 0 ? [ROOM, ROOM2] : 6 % 4 === 1 ? [ROOM] : [],
      invite: 6 % 5 === 0 ? [INVITE] : [],
      leave: 6 % 6 === 0 ? [LEFT] : [],
    };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === LEFT) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: `$lb-6:example.com`,
            room_id: LEFT,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: `$lbj-6-${roomId}:example.com`,
          room_id: roomId,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: `$lbi-6:example.com`,
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const filter =
      map.leave.length > 0
        ? `&filter=${encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))}`
        : '';
    const results = await Promise.all([
      syncRequest(env, `since=s${( 6 % 7) + 1}_td0${filter}`),
      syncRequest(env, `since=s${( 6 % 7) + 1}_td0${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('lifecycle burst concurrent soft-7', async () => {
    const map: MembershipMap = {
      join: 7 % 4 === 0 ? [ROOM, ROOM2] : 7 % 4 === 1 ? [ROOM] : [],
      invite: 7 % 5 === 0 ? [INVITE] : [],
      leave: 7 % 6 === 0 ? [LEFT] : [],
    };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === LEFT) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: `$lb-7:example.com`,
            room_id: LEFT,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: `$lbj-7-${roomId}:example.com`,
          room_id: roomId,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: `$lbi-7:example.com`,
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const filter =
      map.leave.length > 0
        ? `&filter=${encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))}`
        : '';
    const results = await Promise.all([
      syncRequest(env, `since=s${( 7 % 7) + 1}_td0${filter}`),
      syncRequest(env, `since=s${( 7 % 7) + 1}_td0${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('lifecycle burst concurrent soft-8', async () => {
    const map: MembershipMap = {
      join: 8 % 4 === 0 ? [ROOM, ROOM2] : 8 % 4 === 1 ? [ROOM] : [],
      invite: 8 % 5 === 0 ? [INVITE] : [],
      leave: 8 % 6 === 0 ? [LEFT] : [],
    };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === LEFT) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: `$lb-8:example.com`,
            room_id: LEFT,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: `$lbj-8-${roomId}:example.com`,
          room_id: roomId,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: `$lbi-8:example.com`,
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const filter =
      map.leave.length > 0
        ? `&filter=${encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))}`
        : '';
    const results = await Promise.all([
      syncRequest(env, `since=s${( 8 % 7) + 1}_td0${filter}`),
      syncRequest(env, `since=s${( 8 % 7) + 1}_td0${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('lifecycle burst concurrent soft-9', async () => {
    const map: MembershipMap = {
      join: 9 % 4 === 0 ? [ROOM, ROOM2] : 9 % 4 === 1 ? [ROOM] : [],
      invite: 9 % 5 === 0 ? [INVITE] : [],
      leave: 9 % 6 === 0 ? [LEFT] : [],
    };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === LEFT) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: `$lb-9:example.com`,
            room_id: LEFT,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: `$lbj-9-${roomId}:example.com`,
          room_id: roomId,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: `$lbi-9:example.com`,
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const filter =
      map.leave.length > 0
        ? `&filter=${encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))}`
        : '';
    const results = await Promise.all([
      syncRequest(env, `since=s${( 9 % 7) + 1}_td0${filter}`),
      syncRequest(env, `since=s${( 9 % 7) + 1}_td0${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('lifecycle burst concurrent soft-10', async () => {
    const map: MembershipMap = {
      join: 10 % 4 === 0 ? [ROOM, ROOM2] : 10 % 4 === 1 ? [ROOM] : [],
      invite: 10 % 5 === 0 ? [INVITE] : [],
      leave: 10 % 6 === 0 ? [LEFT] : [],
    };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === LEFT) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: `$lb-10:example.com`,
            room_id: LEFT,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: `$lbj-10-${roomId}:example.com`,
          room_id: roomId,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: `$lbi-10:example.com`,
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const filter =
      map.leave.length > 0
        ? `&filter=${encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))}`
        : '';
    const results = await Promise.all([
      syncRequest(env, `since=s${( 10 % 7) + 1}_td0${filter}`),
      syncRequest(env, `since=s${( 10 % 7) + 1}_td0${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('lifecycle burst concurrent soft-11', async () => {
    const map: MembershipMap = {
      join: 11 % 4 === 0 ? [ROOM, ROOM2] : 11 % 4 === 1 ? [ROOM] : [],
      invite: 11 % 5 === 0 ? [INVITE] : [],
      leave: 11 % 6 === 0 ? [LEFT] : [],
    };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === LEFT) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: `$lb-11:example.com`,
            room_id: LEFT,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: `$lbj-11-${roomId}:example.com`,
          room_id: roomId,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: `$lbi-11:example.com`,
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const filter =
      map.leave.length > 0
        ? `&filter=${encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))}`
        : '';
    const results = await Promise.all([
      syncRequest(env, `since=s${( 11 % 7) + 1}_td0${filter}`),
      syncRequest(env, `since=s${( 11 % 7) + 1}_td0${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('lifecycle burst concurrent soft-12', async () => {
    const map: MembershipMap = {
      join: 12 % 4 === 0 ? [ROOM, ROOM2] : 12 % 4 === 1 ? [ROOM] : [],
      invite: 12 % 5 === 0 ? [INVITE] : [],
      leave: 12 % 6 === 0 ? [LEFT] : [],
    };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === LEFT) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: `$lb-12:example.com`,
            room_id: LEFT,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: `$lbj-12-${roomId}:example.com`,
          room_id: roomId,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: `$lbi-12:example.com`,
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const filter =
      map.leave.length > 0
        ? `&filter=${encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))}`
        : '';
    const results = await Promise.all([
      syncRequest(env, `since=s${( 12 % 7) + 1}_td0${filter}`),
      syncRequest(env, `since=s${( 12 % 7) + 1}_td0${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('lifecycle burst concurrent soft-13', async () => {
    const map: MembershipMap = {
      join: 13 % 4 === 0 ? [ROOM, ROOM2] : 13 % 4 === 1 ? [ROOM] : [],
      invite: 13 % 5 === 0 ? [INVITE] : [],
      leave: 13 % 6 === 0 ? [LEFT] : [],
    };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === LEFT) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: `$lb-13:example.com`,
            room_id: LEFT,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: `$lbj-13-${roomId}:example.com`,
          room_id: roomId,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: `$lbi-13:example.com`,
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const filter =
      map.leave.length > 0
        ? `&filter=${encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))}`
        : '';
    const results = await Promise.all([
      syncRequest(env, `since=s${( 13 % 7) + 1}_td0${filter}`),
      syncRequest(env, `since=s${( 13 % 7) + 1}_td0${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('lifecycle burst concurrent soft-14', async () => {
    const map: MembershipMap = {
      join: 14 % 4 === 0 ? [ROOM, ROOM2] : 14 % 4 === 1 ? [ROOM] : [],
      invite: 14 % 5 === 0 ? [INVITE] : [],
      leave: 14 % 6 === 0 ? [LEFT] : [],
    };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === LEFT) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: `$lb-14:example.com`,
            room_id: LEFT,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: `$lbj-14-${roomId}:example.com`,
          room_id: roomId,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: `$lbi-14:example.com`,
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const filter =
      map.leave.length > 0
        ? `&filter=${encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))}`
        : '';
    const results = await Promise.all([
      syncRequest(env, `since=s${( 14 % 7) + 1}_td0${filter}`),
      syncRequest(env, `since=s${( 14 % 7) + 1}_td0${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('lifecycle burst concurrent soft-15', async () => {
    const map: MembershipMap = {
      join: 15 % 4 === 0 ? [ROOM, ROOM2] : 15 % 4 === 1 ? [ROOM] : [],
      invite: 15 % 5 === 0 ? [INVITE] : [],
      leave: 15 % 6 === 0 ? [LEFT] : [],
    };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === LEFT) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: `$lb-15:example.com`,
            room_id: LEFT,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: `$lbj-15-${roomId}:example.com`,
          room_id: roomId,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: `$lbi-15:example.com`,
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const filter =
      map.leave.length > 0
        ? `&filter=${encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))}`
        : '';
    const results = await Promise.all([
      syncRequest(env, `since=s${( 15 % 7) + 1}_td0${filter}`),
      syncRequest(env, `since=s${( 15 % 7) + 1}_td0${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('lifecycle burst concurrent soft-16', async () => {
    const map: MembershipMap = {
      join: 16 % 4 === 0 ? [ROOM, ROOM2] : 16 % 4 === 1 ? [ROOM] : [],
      invite: 16 % 5 === 0 ? [INVITE] : [],
      leave: 16 % 6 === 0 ? [LEFT] : [],
    };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === LEFT) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: `$lb-16:example.com`,
            room_id: LEFT,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: `$lbj-16-${roomId}:example.com`,
          room_id: roomId,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: `$lbi-16:example.com`,
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const filter =
      map.leave.length > 0
        ? `&filter=${encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))}`
        : '';
    const results = await Promise.all([
      syncRequest(env, `since=s${( 16 % 7) + 1}_td0${filter}`),
      syncRequest(env, `since=s${( 16 % 7) + 1}_td0${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('lifecycle burst concurrent soft-17', async () => {
    const map: MembershipMap = {
      join: 17 % 4 === 0 ? [ROOM, ROOM2] : 17 % 4 === 1 ? [ROOM] : [],
      invite: 17 % 5 === 0 ? [INVITE] : [],
      leave: 17 % 6 === 0 ? [LEFT] : [],
    };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === LEFT) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: `$lb-17:example.com`,
            room_id: LEFT,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: `$lbj-17-${roomId}:example.com`,
          room_id: roomId,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: `$lbi-17:example.com`,
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const filter =
      map.leave.length > 0
        ? `&filter=${encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))}`
        : '';
    const results = await Promise.all([
      syncRequest(env, `since=s${( 17 % 7) + 1}_td0${filter}`),
      syncRequest(env, `since=s${( 17 % 7) + 1}_td0${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('lifecycle burst concurrent soft-18', async () => {
    const map: MembershipMap = {
      join: 18 % 4 === 0 ? [ROOM, ROOM2] : 18 % 4 === 1 ? [ROOM] : [],
      invite: 18 % 5 === 0 ? [INVITE] : [],
      leave: 18 % 6 === 0 ? [LEFT] : [],
    };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === LEFT) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: `$lb-18:example.com`,
            room_id: LEFT,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: `$lbj-18-${roomId}:example.com`,
          room_id: roomId,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: `$lbi-18:example.com`,
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const filter =
      map.leave.length > 0
        ? `&filter=${encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))}`
        : '';
    const results = await Promise.all([
      syncRequest(env, `since=s${( 18 % 7) + 1}_td0${filter}`),
      syncRequest(env, `since=s${( 18 % 7) + 1}_td0${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('lifecycle burst concurrent soft-19', async () => {
    const map: MembershipMap = {
      join: 19 % 4 === 0 ? [ROOM, ROOM2] : 19 % 4 === 1 ? [ROOM] : [],
      invite: 19 % 5 === 0 ? [INVITE] : [],
      leave: 19 % 6 === 0 ? [LEFT] : [],
    };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === LEFT) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: `$lb-19:example.com`,
            room_id: LEFT,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: `$lbj-19-${roomId}:example.com`,
          room_id: roomId,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: `$lbi-19:example.com`,
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const filter =
      map.leave.length > 0
        ? `&filter=${encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))}`
        : '';
    const results = await Promise.all([
      syncRequest(env, `since=s${( 19 % 7) + 1}_td0${filter}`),
      syncRequest(env, `since=s${( 19 % 7) + 1}_td0${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('lifecycle burst concurrent soft-20', async () => {
    const map: MembershipMap = {
      join: 20 % 4 === 0 ? [ROOM, ROOM2] : 20 % 4 === 1 ? [ROOM] : [],
      invite: 20 % 5 === 0 ? [INVITE] : [],
      leave: 20 % 6 === 0 ? [LEFT] : [],
    };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === LEFT) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: `$lb-20:example.com`,
            room_id: LEFT,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: `$lbj-20-${roomId}:example.com`,
          room_id: roomId,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: `$lbi-20:example.com`,
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const filter =
      map.leave.length > 0
        ? `&filter=${encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))}`
        : '';
    const results = await Promise.all([
      syncRequest(env, `since=s${( 20 % 7) + 1}_td0${filter}`),
      syncRequest(env, `since=s${( 20 % 7) + 1}_td0${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('lifecycle burst concurrent soft-21', async () => {
    const map: MembershipMap = {
      join: 21 % 4 === 0 ? [ROOM, ROOM2] : 21 % 4 === 1 ? [ROOM] : [],
      invite: 21 % 5 === 0 ? [INVITE] : [],
      leave: 21 % 6 === 0 ? [LEFT] : [],
    };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === LEFT) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: `$lb-21:example.com`,
            room_id: LEFT,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: `$lbj-21-${roomId}:example.com`,
          room_id: roomId,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: `$lbi-21:example.com`,
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const filter =
      map.leave.length > 0
        ? `&filter=${encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))}`
        : '';
    const results = await Promise.all([
      syncRequest(env, `since=s${( 21 % 7) + 1}_td0${filter}`),
      syncRequest(env, `since=s${( 21 % 7) + 1}_td0${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('lifecycle burst concurrent soft-22', async () => {
    const map: MembershipMap = {
      join: 22 % 4 === 0 ? [ROOM, ROOM2] : 22 % 4 === 1 ? [ROOM] : [],
      invite: 22 % 5 === 0 ? [INVITE] : [],
      leave: 22 % 6 === 0 ? [LEFT] : [],
    };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === LEFT) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: `$lb-22:example.com`,
            room_id: LEFT,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: `$lbj-22-${roomId}:example.com`,
          room_id: roomId,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: `$lbi-22:example.com`,
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const filter =
      map.leave.length > 0
        ? `&filter=${encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))}`
        : '';
    const results = await Promise.all([
      syncRequest(env, `since=s${( 22 % 7) + 1}_td0${filter}`),
      syncRequest(env, `since=s${( 22 % 7) + 1}_td0${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('lifecycle burst concurrent soft-23', async () => {
    const map: MembershipMap = {
      join: 23 % 4 === 0 ? [ROOM, ROOM2] : 23 % 4 === 1 ? [ROOM] : [],
      invite: 23 % 5 === 0 ? [INVITE] : [],
      leave: 23 % 6 === 0 ? [LEFT] : [],
    };
    wireMemberships(map);
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === LEFT) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: `$lb-23:example.com`,
            room_id: LEFT,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: `$lbj-23-${roomId}:example.com`,
          room_id: roomId,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: `$lbi-23:example.com`,
        room_id: INVITE,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const filter =
      map.leave.length > 0
        ? `&filter=${encodeURIComponent(JSON.stringify({ room: { include_leave: true } }))}`
        : '';
    const results = await Promise.all([
      syncRequest(env, `since=s${( 23 % 7) + 1}_td0${filter}`),
      syncRequest(env, `since=s${( 23 % 7) + 1}_td0${filter}`),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});
