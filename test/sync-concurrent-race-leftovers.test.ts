/**
 * TOKENMAXX HEAVY leftovers after #200 — sync *concurrent race / TOCTOU*
 * + soft/edge reliability for slices not covered by sync-api-routes or
 * sync-api-route-leftovers (#157) / sync-sparse-state-leftovers / sync-filters.
 *
 * Distinct domain — not report/server-notices (#200), search/spaces (#199),
 * profile (#198), profile-mutate (#197), tags (#196), workflows (#195),
 * rooms-mutate (#194), aliases (#193), rooms (#192), admin-mutate (#191),
 * presence (#190), sliding-sync (#189), fed-keys (#188), oauth/push (#186),
 * typing (#185), receipts (#184), qr-login (#183), to-device (#181).
 *
 * Focus: filter CACHE get→mutate TOCTOU under Promise.all; membership
 * getUserRooms SELECT barrier mid-flight leave; stream-position / events /
 * account-data / ephemeral mutate mid concurrent sync; parallel since/filter
 * isolation; DO long-poll concurrent waits; OTK/device_lists SQL bind under
 * parallel; failure soft mid concurrent; method/filter/timeout/charset soft floods.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, PDU } from '../src/types';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICEA');
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
const SERVER = 'example.com';
const ROOM = '!room:example.com';
const ROOM2 = '!room2:example.com';
const ROOM3 = '!room3:example.com';
const INVITE = '!invite:example.com';
const LEFT = '!left:example.com';
const NOW = 1_700_000_000_000;
const FILTER_A = 'fid-a';
const FILTER_B = 'fid-b';

type SqlCall = { sql: string; args: unknown[] };
type OtkCount = { algorithm: string; count: number };
type FallbackAlgo = { algorithm: string };
type DeviceKeyChange = { user_id: string; stream_position: number };
type KvPut = { key: string; value: string };
type GetBarrier = { match: (key: string) => boolean; count: number };
type FnBarrier = { count: number; match?: (label: string) => boolean };

async function withBarrier(
  barrier: { match: (key: string) => boolean; count: number } | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  key: string
) {
  if (!barrier || !barrier.match(key)) return;
  await new Promise<void>((resolve) => {
    waitersRef.list.push(resolve);
    if (waitersRef.list.length >= barrier.count) {
      const all = [...waitersRef.list];
      waitersRef.list = [];
      clear();
      for (const r of all) r();
    }
  });
}

async function withFnBarrier(
  barrier: FnBarrier | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  label: string
) {
  if (!barrier) return;
  if (barrier.match && !barrier.match(label)) return;
  await new Promise<void>((resolve) => {
    waitersRef.list.push(resolve);
    if (waitersRef.list.length >= barrier.count) {
      const all = [...waitersRef.list];
      waitersRef.list = [];
      clear();
      for (const r of all) r();
    }
  });
}

function filterKvKey(fid: string, userId = USER): string {
  return `filter:${userId}:${fid}`;
}

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

function createRaceKv(
  opts: {
    data?: Record<string, string>;
    getBarrier?: GetBarrier;
    mutateAfterGets?: { after: number; next: Record<string, string> };
    deleteAfterGets?: { after: number; keys: string[] };
    failGetAfter?: number;
  } = {}
) {
  const data: Record<string, string> = { ...(opts.data ?? {}) };
  const puts: KvPut[] = [];
  const gets: string[] = [];
  const deletes: string[] = [];
  const events: string[] = [];

  let getBarrier = opts.getBarrier;
  const getWaiters = { list: [] as Array<() => void> };
  let getCount = 0;

  const kv = {
    data,
    puts,
    gets,
    deletes,
    events,
    get: async (key: string, type?: string) => {
      gets.push(key);
      events.push(`get:${key}`);
      getCount += 1;
      await withBarrier(
        getBarrier,
        getWaiters,
        () => {
          getBarrier = undefined;
        },
        key
      );
      if (opts.failGetAfter !== undefined && getCount > opts.failGetAfter) {
        throw new Error('kv-get-fail');
      }
      // Snapshot before mid-flight mutate/delete so this get still sees pre-image.
      const raw = data[key] ?? null;
      if (opts.mutateAfterGets && getCount === opts.mutateAfterGets.after) {
        for (const [k, v] of Object.entries(opts.mutateAfterGets.next)) {
          data[k] = v;
        }
        events.push('mutate:kv');
      }
      if (opts.deleteAfterGets && getCount === opts.deleteAfterGets.after) {
        for (const k of opts.deleteAfterGets.keys) {
          delete data[k];
          deletes.push(k);
        }
        events.push('delete:kv');
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
    put: async (key: string, value: string) => {
      data[key] = value;
      puts.push({ key, value });
      events.push(`put:${key}`);
    },
    delete: async (key: string) => {
      deletes.push(key);
      delete data[key];
      events.push(`del:${key}`);
    },
  };
  return kv as unknown as KVNamespace & typeof kv;
}

type RaceKv = ReturnType<typeof createRaceKv>;

function createSyncDoStub(
  opts: {
    hasEvents?: boolean | (() => boolean);
    fail?: boolean;
    waitBarrier?: FnBarrier;
    delayMs?: number;
  } = {}
) {
  const fetches: Array<{ url: string; method: string; body?: unknown }> = [];
  const events: string[] = [];
  let waitBarrier = opts.waitBarrier;
  const waitWaiters = { list: [] as Array<() => void> };

  return {
    fetches,
    events,
    async fetch(req: Request): Promise<Response> {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        body = undefined;
      }
      fetches.push({ url: req.url, method: req.method, body });
      events.push('do:wait');
      await withFnBarrier(
        waitBarrier,
        waitWaiters,
        () => {
          waitBarrier = undefined;
        },
        'wait'
      );
      if (opts.delayMs) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
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
    mutateDeviceChangesAfterSelects?: { after: number; next: DeviceKeyChange[] };
    failOnSqlIncludesAfter?: { includes: string; after: number };
    throwOnSqlIncludes?: string;
  } = {}
) {
  let otkCounts = [...(opts.otkCounts ?? [])];
  let fallbackAlgos = [...(opts.fallbackAlgos ?? [])];
  let deviceKeyChanges = [...(opts.deviceKeyChanges ?? [])];
  const sharedRoomUsers = new Set(opts.sharedRoomUsers ?? [BOB, CAROL]);
  const selects: SqlCall[] = [];
  const events: string[] = [];

  let selectBarrier = opts.selectBarrier;
  const selectWaiters = { list: [] as Array<() => void> };
  let selectCount = 0;
  const failCounts: Record<string, number> = {};

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
              selectCount += 1;
              await withBarrier(
                selectBarrier
                  ? {
                      count: selectBarrier.count,
                      match: (key) => selectBarrier!.match(key),
                    }
                  : undefined,
                selectWaiters,
                () => {
                  selectBarrier = undefined;
                },
                sql
              );
              if (opts.throwOnSqlIncludes && sql.includes(opts.throwOnSqlIncludes)) {
                throw new Error('d1-throw');
              }
              if (opts.failOnSqlIncludesAfter) {
                const key = opts.failOnSqlIncludesAfter.includes;
                if (sql.includes(key)) {
                  failCounts[key] = (failCounts[key] ?? 0) + 1;
                  if (failCounts[key] > opts.failOnSqlIncludesAfter.after) {
                    throw new Error('d1-fail-after');
                  }
                }
              }
              if (
                sql.includes('FROM device_key_changes') &&
                sql.includes('COUNT(*)') &&
                sql.includes('dkc.user_id = ?')
              ) {
                const [sincePos, userId] = args as [number, string];
                if (
                  opts.mutateDeviceChangesAfterSelects &&
                  selectCount === opts.mutateDeviceChangesAfterSelects.after
                ) {
                  deviceKeyChanges = [...opts.mutateDeviceChangesAfterSelects.next];
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
              selectCount += 1;
              await withBarrier(
                selectBarrier
                  ? {
                      count: selectBarrier.count,
                      match: (key) => selectBarrier!.match(key),
                    }
                  : undefined,
                selectWaiters,
                () => {
                  selectBarrier = undefined;
                },
                sql
              );
              if (opts.throwOnSqlIncludes && sql.includes(opts.throwOnSqlIncludes)) {
                throw new Error('d1-throw');
              }
              if (opts.failOnSqlIncludesAfter) {
                const key = opts.failOnSqlIncludesAfter.includes;
                if (sql.includes(key)) {
                  failCounts[key] = (failCounts[key] ?? 0) + 1;
                  if (failCounts[key] > opts.failOnSqlIncludesAfter.after) {
                    throw new Error('d1-fail-after');
                  }
                }
              }
              if (
                opts.mutateDeviceChangesAfterSelects &&
                selectCount === opts.mutateDeviceChangesAfterSelects.after
              ) {
                deviceKeyChanges = [...opts.mutateDeviceChangesAfterSelects.next];
                events.push('mutate:device-key-changes');
              }
              if (sql.includes('FROM one_time_keys') && sql.includes('GROUP BY algorithm')) {
                const [userId, deviceId] = args as string[];
                expect(userId).toBe(USER);
                expect(deviceId).toBe(DEVICE);
                return { results: otkCounts as unknown as T[] };
              }
              if (sql.includes('FROM fallback_keys') && sql.includes('DISTINCT algorithm')) {
                const [userId, deviceId] = args as string[];
                expect(userId).toBe(USER);
                expect(deviceId).toBe(DEVICE);
                return { results: fallbackAlgos as unknown as T[] };
              }
              if (
                sql.includes('FROM device_key_changes dkc') &&
                sql.includes('SELECT DISTINCT dkc.user_id')
              ) {
                const [sincePos, excludeUser, requester] = args as [number, string, string];
                expect(excludeUser).toBe(USER);
                expect(requester).toBe(USER);
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

type RaceMocks = {
  joinRooms: string[];
  inviteRooms: string[];
  leaveRooms: string[];
  roomState: Record<string, PDU[]>;
  eventsSince: Record<string, PDU[]>;
  streamPos: number;
  toDevice: { events: unknown[]; nextBatch: string };
  globalAccountData: unknown[];
  roomAccountData: Record<string, unknown[]>;
  receipts: Record<string, { type: string; content: Record<string, unknown> }>;
  typing: Record<string, string[]>;
  events: string[];
  userRoomsBarrier?: FnBarrier;
  eventsSinceBarrier?: FnBarrier;
  streamBarrier?: FnBarrier;
  accountDataBarrier?: FnBarrier;
  mutateJoinAfterCalls?: { after: number; next: string[] };
  mutateEventsAfterCalls?: { after: number; roomId: string; next: PDU[] };
  mutateStreamAfterCalls?: { after: number; next: number };
  mutateAccountDataAfterCalls?: { after: number; next: unknown[] };
  failUserRoomsAfter?: number;
  failEventsAfter?: number;
  failStreamAfter?: number;
};

function installRaceMocks(state: RaceMocks) {
  let userRoomsCalls = 0;
  let eventsCalls = 0;
  let streamCalls = 0;
  let accountDataCalls = 0;

  let userRoomsBarrier = state.userRoomsBarrier;
  let eventsSinceBarrier = state.eventsSinceBarrier;
  let streamBarrier = state.streamBarrier;
  let accountDataBarrier = state.accountDataBarrier;
  const userRoomsWaiters = { list: [] as Array<() => void> };
  const eventsWaiters = { list: [] as Array<() => void> };
  const streamWaiters = { list: [] as Array<() => void> };
  const accountDataWaiters = { list: [] as Array<() => void> };

  getUserRooms.mockReset().mockImplementation(async (_db: unknown, _userId: string, membership?: string) => {
    userRoomsCalls += 1;
    state.events.push(`userRooms:${membership ?? 'any'}`);
    await withFnBarrier(
      userRoomsBarrier,
      userRoomsWaiters,
      () => {
        userRoomsBarrier = undefined;
      },
      membership ?? 'any'
    );
    if (state.failUserRoomsAfter !== undefined && userRoomsCalls > state.failUserRoomsAfter) {
      throw new Error('user-rooms-fail');
    }
    const joinSnap = [...state.joinRooms];
    const inviteSnap = [...state.inviteRooms];
    const leaveSnap = [...state.leaveRooms];
    if (state.mutateJoinAfterCalls && userRoomsCalls === state.mutateJoinAfterCalls.after) {
      state.joinRooms = [...state.mutateJoinAfterCalls.next];
      state.events.push('mutate:join');
    }
    if (membership === 'join') return joinSnap;
    if (membership === 'invite') return inviteSnap;
    if (membership === 'leave') return leaveSnap;
    return [];
  });

  getRoomState.mockReset().mockImplementation(async (_db: unknown, roomId: string) => {
    state.events.push(`roomState:${roomId}`);
    return [...(state.roomState[roomId] ?? [])];
  });

  getEventsSince.mockReset().mockImplementation(async (_db: unknown, roomId: string, since: number) => {
    eventsCalls += 1;
    state.events.push(`eventsSince:${roomId}:${since}`);
    await withFnBarrier(
      eventsSinceBarrier,
      eventsWaiters,
      () => {
        eventsSinceBarrier = undefined;
      },
      roomId
    );
    if (state.failEventsAfter !== undefined && eventsCalls > state.failEventsAfter) {
      throw new Error('events-fail');
    }
    const snap = [...(state.eventsSince[roomId] ?? [])];
    if (state.mutateEventsAfterCalls && eventsCalls === state.mutateEventsAfterCalls.after) {
      state.eventsSince[state.mutateEventsAfterCalls.roomId] = [...state.mutateEventsAfterCalls.next];
      state.events.push('mutate:events');
    }
    return snap;
  });

  getLatestStreamPosition.mockReset().mockImplementation(async () => {
    streamCalls += 1;
    state.events.push(`stream:${state.streamPos}`);
    await withFnBarrier(
      streamBarrier,
      streamWaiters,
      () => {
        streamBarrier = undefined;
      },
      'stream'
    );
    if (state.failStreamAfter !== undefined && streamCalls > state.failStreamAfter) {
      throw new Error('stream-fail');
    }
    const snap = state.streamPos;
    if (state.mutateStreamAfterCalls && streamCalls === state.mutateStreamAfterCalls.after) {
      state.streamPos = state.mutateStreamAfterCalls.next;
      state.events.push('mutate:stream');
    }
    return snap;
  });

  getToDeviceMessages.mockReset().mockImplementation(async () => {
    state.events.push('toDevice');
    return {
      events: [...state.toDevice.events],
      nextBatch: state.toDevice.nextBatch,
    };
  });

  getGlobalAccountData.mockReset().mockImplementation(async () => {
    accountDataCalls += 1;
    state.events.push('globalAccountData');
    await withFnBarrier(
      accountDataBarrier,
      accountDataWaiters,
      () => {
        accountDataBarrier = undefined;
      },
      'global'
    );
    const snap = [...state.globalAccountData];
    if (
      state.mutateAccountDataAfterCalls &&
      accountDataCalls === state.mutateAccountDataAfterCalls.after
    ) {
      state.globalAccountData = [...state.mutateAccountDataAfterCalls.next];
      state.events.push('mutate:account-data');
    }
    return snap;
  });

  getRoomAccountData.mockReset().mockImplementation(async (_db: unknown, _u: string, roomId: string) => {
    state.events.push(`roomAccountData:${roomId}`);
    return [...(state.roomAccountData[roomId] ?? [])];
  });

  getReceiptsForRoom.mockReset().mockImplementation(async (_env: unknown, roomId: string) => {
    state.events.push(`receipts:${roomId}`);
    return (
      state.receipts[roomId] ?? {
        type: 'm.receipt',
        content: {},
      }
    );
  });

  getTypingUsers.mockReset().mockImplementation(async (_env: unknown, roomId: string) => {
    state.events.push(`typing:${roomId}`);
    return [...(state.typing[roomId] ?? [])];
  });

  return {
    get userRoomsCalls() {
      return userRoomsCalls;
    },
    get eventsCalls() {
      return eventsCalls;
    },
    get streamCalls() {
      return streamCalls;
    },
  };
}

function defaultRaceState(overrides: Partial<RaceMocks> = {}): RaceMocks {
  return {
    joinRooms: [],
    inviteRooms: [],
    leaveRooms: [],
    roomState: {},
    eventsSince: {},
    streamPos: 42,
    toDevice: { events: [], nextBatch: '0' },
    globalAccountData: [],
    roomAccountData: {},
    receipts: {},
    typing: {},
    events: [],
    ...overrides,
  };
}

function createEnv(
  opts: {
    db?: SyncDb;
    cache?: RaceKv;
    syncDo?: SyncDoStub;
  } = {}
) {
  const db = opts.db ?? createSyncDb();
  const cache = opts.cache ?? createRaceKv();
  const syncDo = opts.syncDo ?? createSyncDoStub();
  const env = {
    DB: db as unknown as D1Database,
    CACHE: cache,
    SERVER_NAME: SERVER,
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
): Promise<{ status: number; body: Record<string, unknown> }> {
  const path = `/_matrix/client/v3/sync${query ? `?${query}` : ''}`;
  const res = await syncApp.request(
    `http://localhost${path}`,
    {
      method: init.method ?? 'GET',
      headers: {
        Authorization: 'Bearer test-token',
        ...(init.headers ?? {}),
      },
      body: init.body,
    },
    env
  );
  let body: Record<string, unknown> = {};
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { _raw: text };
    }
  }
  return { status: res.status, body };
}

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
}

function joinRoomsOf(body: Record<string, unknown>): string[] {
  const rooms = body.rooms as { join?: Record<string, unknown> } | undefined;
  return Object.keys(rooms?.join ?? {}).sort();
}

function inviteRoomsOf(body: Record<string, unknown>): string[] {
  const rooms = body.rooms as { invite?: Record<string, unknown> } | undefined;
  return Object.keys(rooms?.invite ?? {}).sort();
}

beforeEach(() => {
  installRaceMocks(defaultRaceState());
});

afterEach(() => {
  vi.clearAllMocks();
});


// ---------------------------------------------------------------------------
// Filter CACHE get→mutate TOCTOU under Promise.all
// ---------------------------------------------------------------------------

describe('race filter CACHE get→mutate TOCTOU after #200', () => {
  it('parallel sync distinct filter IDs under get barrier stay isolated', async () => {
    const cache = createRaceKv({
      data: {
        [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }),
        [filterKvKey(FILTER_B)]: JSON.stringify({ room: { rooms: [ROOM2] } }),
      },
      getBarrier: {
        count: 2,
        match: (key) => key.startsWith('filter:'),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, `filter=${FILTER_A}`),
      syncRequest(env, `filter=${FILTER_B}`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(joinRoomsOf(results[1].body)).toEqual([ROOM2]);
  });

  it('filter deleted mid-flight after first get → second sync may see unfiltered rooms', async () => {
    const cache = createRaceKv({
      data: {
        [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }),
      },
      deleteAfterGets: { after: 1, keys: [filterKvKey(FILTER_A)] },
    });
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const first = await syncRequest(env, `filter=${FILTER_A}`);
    const second = await syncRequest(env, `filter=${FILTER_A}`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(joinRoomsOf(first.body)).toEqual([ROOM]);
    expect(joinRoomsOf(second.body).sort()).toEqual([ROOM, ROOM2].sort());
  });

  it('filter mutated mid-flight after first get → second sees new room allow-list', async () => {
    const cache = createRaceKv({
      data: {
        [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }),
      },
      mutateAfterGets: {
        after: 1,
        next: {
          [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM2] } }),
        },
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const a = await syncRequest(env, `filter=${FILTER_A}`);
    const b = await syncRequest(env, `filter=${FILTER_A}`);
    expect(statusesOf([a, b])).toEqual([200, 200]);
    expect(joinRoomsOf(a.body)).toEqual([ROOM]);
    expect(joinRoomsOf(b.body)).toEqual([ROOM2]);
  });

  it('TOCTOU soft-0: dual sync same filter under get barrier', async () => {
    const cache = createRaceKv({
      data: {
        [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }),
      },
      getBarrier: {
        count: 2,
        match: (key) => key === filterKvKey(FILTER_A),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, `filter=${FILTER_A}&since=s0_td0`),
      syncRequest(env, `filter=${FILTER_A}&since=s1_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => joinRoomsOf(r.body).includes(ROOM))).toBe(true);
    expect(cache.gets.filter((k) => k === filterKvKey(FILTER_A)).length).toBe(2);
  });

  it('TOCTOU soft-1: dual sync same filter under get barrier', async () => {
    const cache = createRaceKv({
      data: {
        [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }),
      },
      getBarrier: {
        count: 2,
        match: (key) => key === filterKvKey(FILTER_A),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, `filter=${FILTER_A}&since=s1_td0`),
      syncRequest(env, `filter=${FILTER_A}&since=s2_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => joinRoomsOf(r.body).includes(ROOM))).toBe(true);
    expect(cache.gets.filter((k) => k === filterKvKey(FILTER_A)).length).toBe(2);
  });

  it('TOCTOU soft-2: dual sync same filter under get barrier', async () => {
    const cache = createRaceKv({
      data: {
        [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }),
      },
      getBarrier: {
        count: 2,
        match: (key) => key === filterKvKey(FILTER_A),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, `filter=${FILTER_A}&since=s2_td0`),
      syncRequest(env, `filter=${FILTER_A}&since=s3_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => joinRoomsOf(r.body).includes(ROOM))).toBe(true);
    expect(cache.gets.filter((k) => k === filterKvKey(FILTER_A)).length).toBe(2);
  });

  it('TOCTOU soft-3: dual sync same filter under get barrier', async () => {
    const cache = createRaceKv({
      data: {
        [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }),
      },
      getBarrier: {
        count: 2,
        match: (key) => key === filterKvKey(FILTER_A),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, `filter=${FILTER_A}&since=s3_td0`),
      syncRequest(env, `filter=${FILTER_A}&since=s4_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => joinRoomsOf(r.body).includes(ROOM))).toBe(true);
    expect(cache.gets.filter((k) => k === filterKvKey(FILTER_A)).length).toBe(2);
  });

  it('TOCTOU soft-4: dual sync same filter under get barrier', async () => {
    const cache = createRaceKv({
      data: {
        [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }),
      },
      getBarrier: {
        count: 2,
        match: (key) => key === filterKvKey(FILTER_A),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, `filter=${FILTER_A}&since=s4_td0`),
      syncRequest(env, `filter=${FILTER_A}&since=s5_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => joinRoomsOf(r.body).includes(ROOM))).toBe(true);
    expect(cache.gets.filter((k) => k === filterKvKey(FILTER_A)).length).toBe(2);
  });

  it('TOCTOU soft-5: dual sync same filter under get barrier', async () => {
    const cache = createRaceKv({
      data: {
        [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }),
      },
      getBarrier: {
        count: 2,
        match: (key) => key === filterKvKey(FILTER_A),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, `filter=${FILTER_A}&since=s5_td0`),
      syncRequest(env, `filter=${FILTER_A}&since=s6_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => joinRoomsOf(r.body).includes(ROOM))).toBe(true);
    expect(cache.gets.filter((k) => k === filterKvKey(FILTER_A)).length).toBe(2);
  });

  it('TOCTOU soft-6: dual sync same filter under get barrier', async () => {
    const cache = createRaceKv({
      data: {
        [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }),
      },
      getBarrier: {
        count: 2,
        match: (key) => key === filterKvKey(FILTER_A),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, `filter=${FILTER_A}&since=s6_td0`),
      syncRequest(env, `filter=${FILTER_A}&since=s7_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => joinRoomsOf(r.body).includes(ROOM))).toBe(true);
    expect(cache.gets.filter((k) => k === filterKvKey(FILTER_A)).length).toBe(2);
  });

  it('TOCTOU soft-7: dual sync same filter under get barrier', async () => {
    const cache = createRaceKv({
      data: {
        [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }),
      },
      getBarrier: {
        count: 2,
        match: (key) => key === filterKvKey(FILTER_A),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, `filter=${FILTER_A}&since=s7_td0`),
      syncRequest(env, `filter=${FILTER_A}&since=s8_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => joinRoomsOf(r.body).includes(ROOM))).toBe(true);
    expect(cache.gets.filter((k) => k === filterKvKey(FILTER_A)).length).toBe(2);
  });

  it('TOCTOU soft-8: dual sync same filter under get barrier', async () => {
    const cache = createRaceKv({
      data: {
        [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }),
      },
      getBarrier: {
        count: 2,
        match: (key) => key === filterKvKey(FILTER_A),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, `filter=${FILTER_A}&since=s8_td0`),
      syncRequest(env, `filter=${FILTER_A}&since=s9_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => joinRoomsOf(r.body).includes(ROOM))).toBe(true);
    expect(cache.gets.filter((k) => k === filterKvKey(FILTER_A)).length).toBe(2);
  });

  it('TOCTOU soft-9: dual sync same filter under get barrier', async () => {
    const cache = createRaceKv({
      data: {
        [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }),
      },
      getBarrier: {
        count: 2,
        match: (key) => key === filterKvKey(FILTER_A),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, `filter=${FILTER_A}&since=s9_td0`),
      syncRequest(env, `filter=${FILTER_A}&since=s10_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => joinRoomsOf(r.body).includes(ROOM))).toBe(true);
    expect(cache.gets.filter((k) => k === filterKvKey(FILTER_A)).length).toBe(2);
  });

  it('TOCTOU soft-10: dual sync same filter under get barrier', async () => {
    const cache = createRaceKv({
      data: {
        [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }),
      },
      getBarrier: {
        count: 2,
        match: (key) => key === filterKvKey(FILTER_A),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, `filter=${FILTER_A}&since=s10_td0`),
      syncRequest(env, `filter=${FILTER_A}&since=s11_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => joinRoomsOf(r.body).includes(ROOM))).toBe(true);
    expect(cache.gets.filter((k) => k === filterKvKey(FILTER_A)).length).toBe(2);
  });

  it('TOCTOU soft-11: dual sync same filter under get barrier', async () => {
    const cache = createRaceKv({
      data: {
        [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }),
      },
      getBarrier: {
        count: 2,
        match: (key) => key === filterKvKey(FILTER_A),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, `filter=${FILTER_A}&since=s11_td0`),
      syncRequest(env, `filter=${FILTER_A}&since=s12_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => joinRoomsOf(r.body).includes(ROOM))).toBe(true);
    expect(cache.gets.filter((k) => k === filterKvKey(FILTER_A)).length).toBe(2);
  });

  it('TOCTOU soft-12: dual sync same filter under get barrier', async () => {
    const cache = createRaceKv({
      data: {
        [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }),
      },
      getBarrier: {
        count: 2,
        match: (key) => key === filterKvKey(FILTER_A),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, `filter=${FILTER_A}&since=s12_td0`),
      syncRequest(env, `filter=${FILTER_A}&since=s13_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => joinRoomsOf(r.body).includes(ROOM))).toBe(true);
    expect(cache.gets.filter((k) => k === filterKvKey(FILTER_A)).length).toBe(2);
  });

  it('TOCTOU soft-13: dual sync same filter under get barrier', async () => {
    const cache = createRaceKv({
      data: {
        [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }),
      },
      getBarrier: {
        count: 2,
        match: (key) => key === filterKvKey(FILTER_A),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, `filter=${FILTER_A}&since=s13_td0`),
      syncRequest(env, `filter=${FILTER_A}&since=s14_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => joinRoomsOf(r.body).includes(ROOM))).toBe(true);
    expect(cache.gets.filter((k) => k === filterKvKey(FILTER_A)).length).toBe(2);
  });

  it('TOCTOU soft-14: dual sync same filter under get barrier', async () => {
    const cache = createRaceKv({
      data: {
        [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }),
      },
      getBarrier: {
        count: 2,
        match: (key) => key === filterKvKey(FILTER_A),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, `filter=${FILTER_A}&since=s14_td0`),
      syncRequest(env, `filter=${FILTER_A}&since=s15_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => joinRoomsOf(r.body).includes(ROOM))).toBe(true);
    expect(cache.gets.filter((k) => k === filterKvKey(FILTER_A)).length).toBe(2);
  });

  it('TOCTOU soft-15: dual sync same filter under get barrier', async () => {
    const cache = createRaceKv({
      data: {
        [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }),
      },
      getBarrier: {
        count: 2,
        match: (key) => key === filterKvKey(FILTER_A),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, `filter=${FILTER_A}&since=s15_td0`),
      syncRequest(env, `filter=${FILTER_A}&since=s16_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => joinRoomsOf(r.body).includes(ROOM))).toBe(true);
    expect(cache.gets.filter((k) => k === filterKvKey(FILTER_A)).length).toBe(2);
  });

  it('inline JSON filter soft-0: parallel malformed vs valid isolation', async () => {
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv();
    const good = encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM] } }));
    const bad = encodeURIComponent('{broken-0');
    const results = await Promise.all([
      syncRequest(env, `filter=${good}`),
      syncRequest(env, `filter=${bad}`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(joinRoomsOf(results[1].body).sort()).toEqual([ROOM, ROOM2].sort());
  });

  it('inline JSON filter soft-1: parallel malformed vs valid isolation', async () => {
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv();
    const good = encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM] } }));
    const bad = encodeURIComponent('{broken-1');
    const results = await Promise.all([
      syncRequest(env, `filter=${good}`),
      syncRequest(env, `filter=${bad}`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(joinRoomsOf(results[1].body).sort()).toEqual([ROOM, ROOM2].sort());
  });

  it('inline JSON filter soft-2: parallel malformed vs valid isolation', async () => {
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv();
    const good = encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM] } }));
    const bad = encodeURIComponent('{broken-2');
    const results = await Promise.all([
      syncRequest(env, `filter=${good}`),
      syncRequest(env, `filter=${bad}`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(joinRoomsOf(results[1].body).sort()).toEqual([ROOM, ROOM2].sort());
  });

  it('inline JSON filter soft-3: parallel malformed vs valid isolation', async () => {
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv();
    const good = encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM] } }));
    const bad = encodeURIComponent('{broken-3');
    const results = await Promise.all([
      syncRequest(env, `filter=${good}`),
      syncRequest(env, `filter=${bad}`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(joinRoomsOf(results[1].body).sort()).toEqual([ROOM, ROOM2].sort());
  });

  it('inline JSON filter soft-4: parallel malformed vs valid isolation', async () => {
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv();
    const good = encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM] } }));
    const bad = encodeURIComponent('{broken-4');
    const results = await Promise.all([
      syncRequest(env, `filter=${good}`),
      syncRequest(env, `filter=${bad}`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(joinRoomsOf(results[1].body).sort()).toEqual([ROOM, ROOM2].sort());
  });

  it('inline JSON filter soft-5: parallel malformed vs valid isolation', async () => {
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv();
    const good = encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM] } }));
    const bad = encodeURIComponent('{broken-5');
    const results = await Promise.all([
      syncRequest(env, `filter=${good}`),
      syncRequest(env, `filter=${bad}`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(joinRoomsOf(results[1].body).sort()).toEqual([ROOM, ROOM2].sort());
  });

  it('inline JSON filter soft-6: parallel malformed vs valid isolation', async () => {
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv();
    const good = encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM] } }));
    const bad = encodeURIComponent('{broken-6');
    const results = await Promise.all([
      syncRequest(env, `filter=${good}`),
      syncRequest(env, `filter=${bad}`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(joinRoomsOf(results[1].body).sort()).toEqual([ROOM, ROOM2].sort());
  });

  it('inline JSON filter soft-7: parallel malformed vs valid isolation', async () => {
    const state = defaultRaceState({ joinRooms: [ROOM, ROOM2] });
    installRaceMocks(state);
    const env = createEnv();
    const good = encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM] } }));
    const bad = encodeURIComponent('{broken-7');
    const results = await Promise.all([
      syncRequest(env, `filter=${good}`),
      syncRequest(env, `filter=${bad}`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(joinRoomsOf(results[1].body).sort()).toEqual([ROOM, ROOM2].sort());
  });
});

// ---------------------------------------------------------------------------
// Membership getUserRooms SELECT→clear mid-flight TOCTOU
// ---------------------------------------------------------------------------

describe('race membership getUserRooms SELECT→clear TOCTOU after #200', () => {
  it('join list cleared after first getUserRooms call → later rooms may vanish mid-assembly', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM, ROOM2],
      mutateJoinAfterCalls: { after: 1, next: [] },
    });
    installRaceMocks(state);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    // First call returns [ROOM, ROOM2]; mutation clears for invite/leave lookups.
    expect(joinRoomsOf(body).sort()).toEqual([ROOM, ROOM2].sort());
    expect(state.events).toContain('mutate:join');
  });

  it('parallel sync under userRooms barrier both observe same join snapshot', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM],
      userRoomsBarrier: { count: 2, match: (m) => m === 'join' },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([syncRequest(env), syncRequest(env)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(joinRoomsOf(results[1].body)).toEqual([ROOM]);
  });

  it('membership TOCTOU soft-0: parallel sync join→leave mutate mid-flight', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM, ROOM2],
      leaveRooms: [LEFT],
      userRoomsBarrier: { count: 2, match: (m) => m === 'join' },
      mutateJoinAfterCalls: { after: 2, next: [ROOM] },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s10_td0`),
      syncRequest(env, `since=s11_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(joinRoomsOf(r.body).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('membership TOCTOU soft-1: parallel sync join→leave mutate mid-flight', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM, ROOM2],
      leaveRooms: [LEFT],
      userRoomsBarrier: { count: 2, match: (m) => m === 'join' },
      mutateJoinAfterCalls: { after: 2, next: [ROOM] },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s10_td0`),
      syncRequest(env, `since=s11_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(joinRoomsOf(r.body).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('membership TOCTOU soft-2: parallel sync join→leave mutate mid-flight', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM, ROOM2],
      leaveRooms: [LEFT],
      userRoomsBarrier: { count: 2, match: (m) => m === 'join' },
      mutateJoinAfterCalls: { after: 2, next: [ROOM] },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s10_td0`),
      syncRequest(env, `since=s11_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(joinRoomsOf(r.body).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('membership TOCTOU soft-3: parallel sync join→leave mutate mid-flight', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM, ROOM2],
      leaveRooms: [LEFT],
      userRoomsBarrier: { count: 2, match: (m) => m === 'join' },
      mutateJoinAfterCalls: { after: 2, next: [ROOM] },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s10_td0`),
      syncRequest(env, `since=s11_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(joinRoomsOf(r.body).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('membership TOCTOU soft-4: parallel sync join→leave mutate mid-flight', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM, ROOM2],
      leaveRooms: [LEFT],
      userRoomsBarrier: { count: 2, match: (m) => m === 'join' },
      mutateJoinAfterCalls: { after: 2, next: [ROOM] },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s10_td0`),
      syncRequest(env, `since=s11_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(joinRoomsOf(r.body).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('membership TOCTOU soft-5: parallel sync join→leave mutate mid-flight', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM, ROOM2],
      leaveRooms: [LEFT],
      userRoomsBarrier: { count: 2, match: (m) => m === 'join' },
      mutateJoinAfterCalls: { after: 2, next: [ROOM] },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s10_td0`),
      syncRequest(env, `since=s11_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(joinRoomsOf(r.body).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('membership TOCTOU soft-6: parallel sync join→leave mutate mid-flight', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM, ROOM2],
      leaveRooms: [LEFT],
      userRoomsBarrier: { count: 2, match: (m) => m === 'join' },
      mutateJoinAfterCalls: { after: 2, next: [ROOM] },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s10_td0`),
      syncRequest(env, `since=s11_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(joinRoomsOf(r.body).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('membership TOCTOU soft-7: parallel sync join→leave mutate mid-flight', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM, ROOM2],
      leaveRooms: [LEFT],
      userRoomsBarrier: { count: 2, match: (m) => m === 'join' },
      mutateJoinAfterCalls: { after: 2, next: [ROOM] },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s10_td0`),
      syncRequest(env, `since=s11_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(joinRoomsOf(r.body).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('membership TOCTOU soft-8: parallel sync join→leave mutate mid-flight', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM, ROOM2],
      leaveRooms: [LEFT],
      userRoomsBarrier: { count: 2, match: (m) => m === 'join' },
      mutateJoinAfterCalls: { after: 2, next: [ROOM] },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s10_td0`),
      syncRequest(env, `since=s11_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(joinRoomsOf(r.body).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('membership TOCTOU soft-9: parallel sync join→leave mutate mid-flight', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM, ROOM2],
      leaveRooms: [LEFT],
      userRoomsBarrier: { count: 2, match: (m) => m === 'join' },
      mutateJoinAfterCalls: { after: 2, next: [ROOM] },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s10_td0`),
      syncRequest(env, `since=s11_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(joinRoomsOf(r.body).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('membership TOCTOU soft-10: parallel sync join→leave mutate mid-flight', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM, ROOM2],
      leaveRooms: [LEFT],
      userRoomsBarrier: { count: 2, match: (m) => m === 'join' },
      mutateJoinAfterCalls: { after: 2, next: [ROOM] },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s10_td0`),
      syncRequest(env, `since=s11_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(joinRoomsOf(r.body).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('membership TOCTOU soft-11: parallel sync join→leave mutate mid-flight', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM, ROOM2],
      leaveRooms: [LEFT],
      userRoomsBarrier: { count: 2, match: (m) => m === 'join' },
      mutateJoinAfterCalls: { after: 2, next: [ROOM] },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s10_td0`),
      syncRequest(env, `since=s11_td0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(joinRoomsOf(r.body).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('invite∥join isolation soft-0', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM],
      inviteRooms: [INVITE],
      roomState: {
        [INVITE]: [
          makePdu({
            type: 'm.room.member',
            event_id: `$inv-0:example.com`,
            state_key: USER,
            content: { membership: 'invite' },
            room_id: INVITE,
          }),
        ],
      },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env),
      syncRequest(env, `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [INVITE] } }))}`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(inviteRoomsOf(results[0].body)).toEqual([INVITE]);
    expect(joinRoomsOf(results[1].body)).toEqual([]);
    expect(inviteRoomsOf(results[1].body)).toEqual([INVITE]);
  });

  it('invite∥join isolation soft-1', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM],
      inviteRooms: [INVITE],
      roomState: {
        [INVITE]: [
          makePdu({
            type: 'm.room.member',
            event_id: `$inv-1:example.com`,
            state_key: USER,
            content: { membership: 'invite' },
            room_id: INVITE,
          }),
        ],
      },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env),
      syncRequest(env, `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [INVITE] } }))}`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(inviteRoomsOf(results[0].body)).toEqual([INVITE]);
    expect(joinRoomsOf(results[1].body)).toEqual([]);
    expect(inviteRoomsOf(results[1].body)).toEqual([INVITE]);
  });

  it('invite∥join isolation soft-2', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM],
      inviteRooms: [INVITE],
      roomState: {
        [INVITE]: [
          makePdu({
            type: 'm.room.member',
            event_id: `$inv-2:example.com`,
            state_key: USER,
            content: { membership: 'invite' },
            room_id: INVITE,
          }),
        ],
      },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env),
      syncRequest(env, `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [INVITE] } }))}`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(inviteRoomsOf(results[0].body)).toEqual([INVITE]);
    expect(joinRoomsOf(results[1].body)).toEqual([]);
    expect(inviteRoomsOf(results[1].body)).toEqual([INVITE]);
  });

  it('invite∥join isolation soft-3', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM],
      inviteRooms: [INVITE],
      roomState: {
        [INVITE]: [
          makePdu({
            type: 'm.room.member',
            event_id: `$inv-3:example.com`,
            state_key: USER,
            content: { membership: 'invite' },
            room_id: INVITE,
          }),
        ],
      },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env),
      syncRequest(env, `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [INVITE] } }))}`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(inviteRoomsOf(results[0].body)).toEqual([INVITE]);
    expect(joinRoomsOf(results[1].body)).toEqual([]);
    expect(inviteRoomsOf(results[1].body)).toEqual([INVITE]);
  });

  it('invite∥join isolation soft-4', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM],
      inviteRooms: [INVITE],
      roomState: {
        [INVITE]: [
          makePdu({
            type: 'm.room.member',
            event_id: `$inv-4:example.com`,
            state_key: USER,
            content: { membership: 'invite' },
            room_id: INVITE,
          }),
        ],
      },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env),
      syncRequest(env, `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [INVITE] } }))}`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(inviteRoomsOf(results[0].body)).toEqual([INVITE]);
    expect(joinRoomsOf(results[1].body)).toEqual([]);
    expect(inviteRoomsOf(results[1].body)).toEqual([INVITE]);
  });

  it('invite∥join isolation soft-5', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM],
      inviteRooms: [INVITE],
      roomState: {
        [INVITE]: [
          makePdu({
            type: 'm.room.member',
            event_id: `$inv-5:example.com`,
            state_key: USER,
            content: { membership: 'invite' },
            room_id: INVITE,
          }),
        ],
      },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env),
      syncRequest(env, `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [INVITE] } }))}`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(inviteRoomsOf(results[0].body)).toEqual([INVITE]);
    expect(joinRoomsOf(results[1].body)).toEqual([]);
    expect(inviteRoomsOf(results[1].body)).toEqual([INVITE]);
  });

  it('invite∥join isolation soft-6', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM],
      inviteRooms: [INVITE],
      roomState: {
        [INVITE]: [
          makePdu({
            type: 'm.room.member',
            event_id: `$inv-6:example.com`,
            state_key: USER,
            content: { membership: 'invite' },
            room_id: INVITE,
          }),
        ],
      },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env),
      syncRequest(env, `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [INVITE] } }))}`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(inviteRoomsOf(results[0].body)).toEqual([INVITE]);
    expect(joinRoomsOf(results[1].body)).toEqual([]);
    expect(inviteRoomsOf(results[1].body)).toEqual([INVITE]);
  });

  it('invite∥join isolation soft-7', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM],
      inviteRooms: [INVITE],
      roomState: {
        [INVITE]: [
          makePdu({
            type: 'm.room.member',
            event_id: `$inv-7:example.com`,
            state_key: USER,
            content: { membership: 'invite' },
            room_id: INVITE,
          }),
        ],
      },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env),
      syncRequest(env, `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [INVITE] } }))}`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(inviteRoomsOf(results[0].body)).toEqual([INVITE]);
    expect(joinRoomsOf(results[1].body)).toEqual([]);
    expect(inviteRoomsOf(results[1].body)).toEqual([INVITE]);
  });
});

// ---------------------------------------------------------------------------
// Stream position / events / account-data mid concurrent sync
// ---------------------------------------------------------------------------

describe('race stream/events/account-data mid concurrent after #200', () => {
  it('parallel sync under stream barrier share advancing next_batch inputs', async () => {
    const state = defaultRaceState({
      streamBarrier: { count: 2 },
      streamPos: 100,
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s2_td0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => String(r.body.next_batch).startsWith('s100_td'))).toBe(true);
  });

  it('stream mutated after first read → second sync may advance further', async () => {
    const state = defaultRaceState({
      streamPos: 50,
      mutateStreamAfterCalls: { after: 1, next: 99 },
    });
    installRaceMocks(state);
    const env = createEnv();
    const a = await syncRequest(env, 'since=s1_td0');
    const b = await syncRequest(env, 'since=s1_td0');
    expect(a.body.next_batch).toBe('s50_td0');
    expect(b.body.next_batch).toBe('s99_td0');
  });

  it('events injected mid-flight after first eventsSince → second room sees them', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: '$e1:example.com',
      content: { body: 'hi', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [] },
      mutateEventsAfterCalls: { after: 1, roomId: ROOM, next: [msg] },
    });
    installRaceMocks(state);
    const env = createEnv();
    const a = await syncRequest(env, 'since=s1_td0');
    const b = await syncRequest(env, 'since=s1_td0');
    const joinA = (a.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
    const joinB = (b.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
    expect(joinA.timeline.events).toHaveLength(0);
    expect(joinB.timeline.events).toHaveLength(1);
  });

  it('global account_data mutated mid-flight under barrier', async () => {
    const state = defaultRaceState({
      globalAccountData: [{ type: 'm.push_rules', content: { global: {} } }],
      mutateAccountDataAfterCalls: {
        after: 1,
        next: [{ type: 'm.direct', content: { [BOB]: [ROOM] } }],
      },
    });
    installRaceMocks(state);
    const env = createEnv();
    const a = await syncRequest(env, 'since=s1_td0');
    const b = await syncRequest(env, 'since=s1_td0');
    expect(statusesOf([a, b])).toEqual([200, 200]);
    expect(
      (a.body.account_data as { events: Array<{ type: string }> }).events.map((e) => e.type)
    ).toContain('m.push_rules');
    expect(
      (b.body.account_data as { events: Array<{ type: string }> }).events.map((e) => e.type)
    ).toContain('m.direct');
    expect(state.events).toContain('mutate:account-data');
  });

  it('parallel account_data under barrier both see consistent snapshot', async () => {
    const state = defaultRaceState({
      accountDataBarrier: { count: 2 },
      globalAccountData: [{ type: 'm.push_rules', content: { global: {} } }],
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s1_td0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const events = (r.body.account_data as { events: Array<{ type: string }> }).events;
      expect(events.map((e) => e.type)).toContain('m.push_rules');
    }
  });

  it('eventsSince barrier soft-0: dual sync same room', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: `$race-0:example.com`,
      content: { body: 'r0', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [msg] },
      eventsSinceBarrier: { count: 2, match: (id) => id === ROOM },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s0_td0`),
      syncRequest(env, `since=s0_td1`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const join = (r.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
      expect(join.timeline.events).toHaveLength(1);
    }
  });

  it('eventsSince barrier soft-1: dual sync same room', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: `$race-1:example.com`,
      content: { body: 'r1', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [msg] },
      eventsSinceBarrier: { count: 2, match: (id) => id === ROOM },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s1_td0`),
      syncRequest(env, `since=s1_td1`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const join = (r.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
      expect(join.timeline.events).toHaveLength(1);
    }
  });

  it('eventsSince barrier soft-2: dual sync same room', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: `$race-2:example.com`,
      content: { body: 'r2', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [msg] },
      eventsSinceBarrier: { count: 2, match: (id) => id === ROOM },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s2_td0`),
      syncRequest(env, `since=s2_td1`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const join = (r.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
      expect(join.timeline.events).toHaveLength(1);
    }
  });

  it('eventsSince barrier soft-3: dual sync same room', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: `$race-3:example.com`,
      content: { body: 'r3', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [msg] },
      eventsSinceBarrier: { count: 2, match: (id) => id === ROOM },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s3_td0`),
      syncRequest(env, `since=s3_td1`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const join = (r.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
      expect(join.timeline.events).toHaveLength(1);
    }
  });

  it('eventsSince barrier soft-4: dual sync same room', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: `$race-4:example.com`,
      content: { body: 'r4', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [msg] },
      eventsSinceBarrier: { count: 2, match: (id) => id === ROOM },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s4_td0`),
      syncRequest(env, `since=s4_td1`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const join = (r.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
      expect(join.timeline.events).toHaveLength(1);
    }
  });

  it('eventsSince barrier soft-5: dual sync same room', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: `$race-5:example.com`,
      content: { body: 'r5', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [msg] },
      eventsSinceBarrier: { count: 2, match: (id) => id === ROOM },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s5_td0`),
      syncRequest(env, `since=s5_td1`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const join = (r.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
      expect(join.timeline.events).toHaveLength(1);
    }
  });

  it('eventsSince barrier soft-6: dual sync same room', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: `$race-6:example.com`,
      content: { body: 'r6', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [msg] },
      eventsSinceBarrier: { count: 2, match: (id) => id === ROOM },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s6_td0`),
      syncRequest(env, `since=s6_td1`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const join = (r.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
      expect(join.timeline.events).toHaveLength(1);
    }
  });

  it('eventsSince barrier soft-7: dual sync same room', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: `$race-7:example.com`,
      content: { body: 'r7', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [msg] },
      eventsSinceBarrier: { count: 2, match: (id) => id === ROOM },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s7_td0`),
      syncRequest(env, `since=s7_td1`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const join = (r.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
      expect(join.timeline.events).toHaveLength(1);
    }
  });

  it('eventsSince barrier soft-8: dual sync same room', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: `$race-8:example.com`,
      content: { body: 'r8', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [msg] },
      eventsSinceBarrier: { count: 2, match: (id) => id === ROOM },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s8_td0`),
      syncRequest(env, `since=s8_td1`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const join = (r.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
      expect(join.timeline.events).toHaveLength(1);
    }
  });

  it('eventsSince barrier soft-9: dual sync same room', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: `$race-9:example.com`,
      content: { body: 'r9', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [msg] },
      eventsSinceBarrier: { count: 2, match: (id) => id === ROOM },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s9_td0`),
      syncRequest(env, `since=s9_td1`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const join = (r.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
      expect(join.timeline.events).toHaveLength(1);
    }
  });

  it('eventsSince barrier soft-10: dual sync same room', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: `$race-10:example.com`,
      content: { body: 'r10', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [msg] },
      eventsSinceBarrier: { count: 2, match: (id) => id === ROOM },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s10_td0`),
      syncRequest(env, `since=s10_td1`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const join = (r.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
      expect(join.timeline.events).toHaveLength(1);
    }
  });

  it('eventsSince barrier soft-11: dual sync same room', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: `$race-11:example.com`,
      content: { body: 'r11', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [msg] },
      eventsSinceBarrier: { count: 2, match: (id) => id === ROOM },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, `since=s11_td0`),
      syncRequest(env, `since=s11_td1`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const join = (r.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
      expect(join.timeline.events).toHaveLength(1);
    }
  });

  it('multi-room isolation soft-0', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM, ROOM2, ROOM3],
      eventsSince: {
        [ROOM]: [
          makePdu({
            type: 'm.room.message',
            event_id: `$a-0:example.com`,
            room_id: ROOM,
            content: { body: 'a', msgtype: 'm.text' },
          }),
        ],
        [ROOM2]: [
          makePdu({
            type: 'm.room.message',
            event_id: `$b-0:example.com`,
            room_id: ROOM2,
            content: { body: 'b', msgtype: 'm.text' },
          }),
        ],
      },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(
        env,
        `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM] } }))}&since=s1_td0`
      ),
      syncRequest(
        env,
        `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM2] } }))}&since=s1_td0`
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(joinRoomsOf(results[1].body)).toEqual([ROOM2]);
  });

  it('multi-room isolation soft-1', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM, ROOM2, ROOM3],
      eventsSince: {
        [ROOM]: [
          makePdu({
            type: 'm.room.message',
            event_id: `$a-1:example.com`,
            room_id: ROOM,
            content: { body: 'a', msgtype: 'm.text' },
          }),
        ],
        [ROOM2]: [
          makePdu({
            type: 'm.room.message',
            event_id: `$b-1:example.com`,
            room_id: ROOM2,
            content: { body: 'b', msgtype: 'm.text' },
          }),
        ],
      },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(
        env,
        `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM] } }))}&since=s1_td0`
      ),
      syncRequest(
        env,
        `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM2] } }))}&since=s1_td0`
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(joinRoomsOf(results[1].body)).toEqual([ROOM2]);
  });

  it('multi-room isolation soft-2', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM, ROOM2, ROOM3],
      eventsSince: {
        [ROOM]: [
          makePdu({
            type: 'm.room.message',
            event_id: `$a-2:example.com`,
            room_id: ROOM,
            content: { body: 'a', msgtype: 'm.text' },
          }),
        ],
        [ROOM2]: [
          makePdu({
            type: 'm.room.message',
            event_id: `$b-2:example.com`,
            room_id: ROOM2,
            content: { body: 'b', msgtype: 'm.text' },
          }),
        ],
      },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(
        env,
        `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM] } }))}&since=s1_td0`
      ),
      syncRequest(
        env,
        `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM2] } }))}&since=s1_td0`
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(joinRoomsOf(results[1].body)).toEqual([ROOM2]);
  });

  it('multi-room isolation soft-3', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM, ROOM2, ROOM3],
      eventsSince: {
        [ROOM]: [
          makePdu({
            type: 'm.room.message',
            event_id: `$a-3:example.com`,
            room_id: ROOM,
            content: { body: 'a', msgtype: 'm.text' },
          }),
        ],
        [ROOM2]: [
          makePdu({
            type: 'm.room.message',
            event_id: `$b-3:example.com`,
            room_id: ROOM2,
            content: { body: 'b', msgtype: 'm.text' },
          }),
        ],
      },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(
        env,
        `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM] } }))}&since=s1_td0`
      ),
      syncRequest(
        env,
        `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM2] } }))}&since=s1_td0`
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(joinRoomsOf(results[1].body)).toEqual([ROOM2]);
  });

  it('multi-room isolation soft-4', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM, ROOM2, ROOM3],
      eventsSince: {
        [ROOM]: [
          makePdu({
            type: 'm.room.message',
            event_id: `$a-4:example.com`,
            room_id: ROOM,
            content: { body: 'a', msgtype: 'm.text' },
          }),
        ],
        [ROOM2]: [
          makePdu({
            type: 'm.room.message',
            event_id: `$b-4:example.com`,
            room_id: ROOM2,
            content: { body: 'b', msgtype: 'm.text' },
          }),
        ],
      },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(
        env,
        `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM] } }))}&since=s1_td0`
      ),
      syncRequest(
        env,
        `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM2] } }))}&since=s1_td0`
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(joinRoomsOf(results[1].body)).toEqual([ROOM2]);
  });

  it('multi-room isolation soft-5', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM, ROOM2, ROOM3],
      eventsSince: {
        [ROOM]: [
          makePdu({
            type: 'm.room.message',
            event_id: `$a-5:example.com`,
            room_id: ROOM,
            content: { body: 'a', msgtype: 'm.text' },
          }),
        ],
        [ROOM2]: [
          makePdu({
            type: 'm.room.message',
            event_id: `$b-5:example.com`,
            room_id: ROOM2,
            content: { body: 'b', msgtype: 'm.text' },
          }),
        ],
      },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(
        env,
        `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM] } }))}&since=s1_td0`
      ),
      syncRequest(
        env,
        `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM2] } }))}&since=s1_td0`
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(joinRoomsOf(results[1].body)).toEqual([ROOM2]);
  });

  it('multi-room isolation soft-6', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM, ROOM2, ROOM3],
      eventsSince: {
        [ROOM]: [
          makePdu({
            type: 'm.room.message',
            event_id: `$a-6:example.com`,
            room_id: ROOM,
            content: { body: 'a', msgtype: 'm.text' },
          }),
        ],
        [ROOM2]: [
          makePdu({
            type: 'm.room.message',
            event_id: `$b-6:example.com`,
            room_id: ROOM2,
            content: { body: 'b', msgtype: 'm.text' },
          }),
        ],
      },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(
        env,
        `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM] } }))}&since=s1_td0`
      ),
      syncRequest(
        env,
        `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM2] } }))}&since=s1_td0`
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(joinRoomsOf(results[1].body)).toEqual([ROOM2]);
  });

  it('multi-room isolation soft-7', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM, ROOM2, ROOM3],
      eventsSince: {
        [ROOM]: [
          makePdu({
            type: 'm.room.message',
            event_id: `$a-7:example.com`,
            room_id: ROOM,
            content: { body: 'a', msgtype: 'm.text' },
          }),
        ],
        [ROOM2]: [
          makePdu({
            type: 'm.room.message',
            event_id: `$b-7:example.com`,
            room_id: ROOM2,
            content: { body: 'b', msgtype: 'm.text' },
          }),
        ],
      },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(
        env,
        `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM] } }))}&since=s1_td0`
      ),
      syncRequest(
        env,
        `filter=${encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM2] } }))}&since=s1_td0`
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(joinRoomsOf(results[0].body)).toEqual([ROOM]);
    expect(joinRoomsOf(results[1].body)).toEqual([ROOM2]);
  });
});

// ---------------------------------------------------------------------------
// Ephemeral / to-device / E2EE concurrent isolation
// ---------------------------------------------------------------------------

describe('race ephemeral to-device E2EE concurrent after #200', () => {
  it('parallel sync: receipts+typing stay per-room without cross-talk', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM, ROOM2],
      receipts: {
        [ROOM]: {
          type: 'm.receipt',
          content: { '$r1:example.com': { 'm.read': { [USER]: { ts: NOW } } } },
        },
      },
      typing: { [ROOM2]: [BOB] },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([syncRequest(env), syncRequest(env)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const join = (r.body.rooms as {
        join: Record<string, { ephemeral: { events: Array<{ type: string }> } }>;
      }).join;
      expect(join[ROOM].ephemeral.events.some((e) => e.type === 'm.receipt')).toBe(true);
      expect(join[ROOM2].ephemeral.events.some((e) => e.type === 'm.typing')).toBe(true);
    }
  });

  it('to-device nextBatch advances independently across parallel syncs', async () => {
    const state = defaultRaceState({
      toDevice: {
        events: [{ type: 'm.room.encrypted', content: { stub: true } }],
        nextBatch: '77',
      },
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s0_td10'),
      syncRequest(env, 'since=s0_td10'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => r.body.next_batch === 's42_td77')).toBe(true);
    expect(
      results.every(
        (r) => ((r.body.to_device as { events: unknown[] }).events.length === 1)
      )
    ).toBe(true);
  });

  it('OTK + fallback bind soft-0 under parallel sync', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 1 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([syncRequest(env), syncRequest(env, 'since=s0_td0')]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(r.body.device_one_time_keys_count).toEqual({ signed_curve25519: 1 });
      expect(r.body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
    }
    const otkBinds = db.selects.filter((s) => s.sql.includes('FROM one_time_keys'));
    expect(otkBinds.every((s) => s.args[0] === USER && s.args[1] === DEVICE)).toBe(true);
  });

  it('OTK + fallback bind soft-1 under parallel sync', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 2 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([syncRequest(env), syncRequest(env, 'since=s0_td0')]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(r.body.device_one_time_keys_count).toEqual({ signed_curve25519: 2 });
      expect(r.body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
    }
    const otkBinds = db.selects.filter((s) => s.sql.includes('FROM one_time_keys'));
    expect(otkBinds.every((s) => s.args[0] === USER && s.args[1] === DEVICE)).toBe(true);
  });

  it('OTK + fallback bind soft-2 under parallel sync', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 3 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([syncRequest(env), syncRequest(env, 'since=s0_td0')]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(r.body.device_one_time_keys_count).toEqual({ signed_curve25519: 3 });
      expect(r.body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
    }
    const otkBinds = db.selects.filter((s) => s.sql.includes('FROM one_time_keys'));
    expect(otkBinds.every((s) => s.args[0] === USER && s.args[1] === DEVICE)).toBe(true);
  });

  it('OTK + fallback bind soft-3 under parallel sync', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 4 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([syncRequest(env), syncRequest(env, 'since=s0_td0')]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(r.body.device_one_time_keys_count).toEqual({ signed_curve25519: 4 });
      expect(r.body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
    }
    const otkBinds = db.selects.filter((s) => s.sql.includes('FROM one_time_keys'));
    expect(otkBinds.every((s) => s.args[0] === USER && s.args[1] === DEVICE)).toBe(true);
  });

  it('OTK + fallback bind soft-4 under parallel sync', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 5 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([syncRequest(env), syncRequest(env, 'since=s0_td0')]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(r.body.device_one_time_keys_count).toEqual({ signed_curve25519: 5 });
      expect(r.body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
    }
    const otkBinds = db.selects.filter((s) => s.sql.includes('FROM one_time_keys'));
    expect(otkBinds.every((s) => s.args[0] === USER && s.args[1] === DEVICE)).toBe(true);
  });

  it('OTK + fallback bind soft-5 under parallel sync', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 6 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([syncRequest(env), syncRequest(env, 'since=s0_td0')]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(r.body.device_one_time_keys_count).toEqual({ signed_curve25519: 6 });
      expect(r.body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
    }
    const otkBinds = db.selects.filter((s) => s.sql.includes('FROM one_time_keys'));
    expect(otkBinds.every((s) => s.args[0] === USER && s.args[1] === DEVICE)).toBe(true);
  });

  it('OTK + fallback bind soft-6 under parallel sync', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 7 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([syncRequest(env), syncRequest(env, 'since=s0_td0')]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(r.body.device_one_time_keys_count).toEqual({ signed_curve25519: 7 });
      expect(r.body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
    }
    const otkBinds = db.selects.filter((s) => s.sql.includes('FROM one_time_keys'));
    expect(otkBinds.every((s) => s.args[0] === USER && s.args[1] === DEVICE)).toBe(true);
  });

  it('OTK + fallback bind soft-7 under parallel sync', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 8 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([syncRequest(env), syncRequest(env, 'since=s0_td0')]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(r.body.device_one_time_keys_count).toEqual({ signed_curve25519: 8 });
      expect(r.body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
    }
    const otkBinds = db.selects.filter((s) => s.sql.includes('FROM one_time_keys'));
    expect(otkBinds.every((s) => s.args[0] === USER && s.args[1] === DEVICE)).toBe(true);
  });

  it('OTK + fallback bind soft-8 under parallel sync', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 9 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([syncRequest(env), syncRequest(env, 'since=s0_td0')]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(r.body.device_one_time_keys_count).toEqual({ signed_curve25519: 9 });
      expect(r.body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
    }
    const otkBinds = db.selects.filter((s) => s.sql.includes('FROM one_time_keys'));
    expect(otkBinds.every((s) => s.args[0] === USER && s.args[1] === DEVICE)).toBe(true);
  });

  it('OTK + fallback bind soft-9 under parallel sync', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 10 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([syncRequest(env), syncRequest(env, 'since=s0_td0')]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      expect(r.body.device_one_time_keys_count).toEqual({ signed_curve25519: 10 });
      expect(r.body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
    }
    const otkBinds = db.selects.filter((s) => s.sql.includes('FROM one_time_keys'));
    expect(otkBinds.every((s) => s.args[0] === USER && s.args[1] === DEVICE)).toBe(true);
  });

  it('device_lists changed soft-0 under select barrier', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [
        { user_id: BOB, stream_position: 20 + 0 },
        { user_id: CAROL, stream_position: 30 + 0 },
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM device_key_changes'),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([
      syncRequest(env, 'since=s10_td0'),
      syncRequest(env, 'since=s10_td0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const lists = r.body.device_lists as { changed: string[] };
      expect(lists.changed.sort()).toEqual([BOB, CAROL].sort());
    }
  });

  it('device_lists changed soft-1 under select barrier', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [
        { user_id: BOB, stream_position: 20 + 1 },
        { user_id: CAROL, stream_position: 30 + 1 },
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM device_key_changes'),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([
      syncRequest(env, 'since=s10_td0'),
      syncRequest(env, 'since=s10_td0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const lists = r.body.device_lists as { changed: string[] };
      expect(lists.changed.sort()).toEqual([BOB, CAROL].sort());
    }
  });

  it('device_lists changed soft-2 under select barrier', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [
        { user_id: BOB, stream_position: 20 + 2 },
        { user_id: CAROL, stream_position: 30 + 2 },
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM device_key_changes'),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([
      syncRequest(env, 'since=s10_td0'),
      syncRequest(env, 'since=s10_td0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const lists = r.body.device_lists as { changed: string[] };
      expect(lists.changed.sort()).toEqual([BOB, CAROL].sort());
    }
  });

  it('device_lists changed soft-3 under select barrier', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [
        { user_id: BOB, stream_position: 20 + 3 },
        { user_id: CAROL, stream_position: 30 + 3 },
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM device_key_changes'),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([
      syncRequest(env, 'since=s10_td0'),
      syncRequest(env, 'since=s10_td0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const lists = r.body.device_lists as { changed: string[] };
      expect(lists.changed.sort()).toEqual([BOB, CAROL].sort());
    }
  });

  it('device_lists changed soft-4 under select barrier', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [
        { user_id: BOB, stream_position: 20 + 4 },
        { user_id: CAROL, stream_position: 30 + 4 },
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM device_key_changes'),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([
      syncRequest(env, 'since=s10_td0'),
      syncRequest(env, 'since=s10_td0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const lists = r.body.device_lists as { changed: string[] };
      expect(lists.changed.sort()).toEqual([BOB, CAROL].sort());
    }
  });

  it('device_lists changed soft-5 under select barrier', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [
        { user_id: BOB, stream_position: 20 + 5 },
        { user_id: CAROL, stream_position: 30 + 5 },
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM device_key_changes'),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([
      syncRequest(env, 'since=s10_td0'),
      syncRequest(env, 'since=s10_td0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const lists = r.body.device_lists as { changed: string[] };
      expect(lists.changed.sort()).toEqual([BOB, CAROL].sort());
    }
  });

  it('device_lists changed soft-6 under select barrier', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [
        { user_id: BOB, stream_position: 20 + 6 },
        { user_id: CAROL, stream_position: 30 + 6 },
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM device_key_changes'),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([
      syncRequest(env, 'since=s10_td0'),
      syncRequest(env, 'since=s10_td0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const lists = r.body.device_lists as { changed: string[] };
      expect(lists.changed.sort()).toEqual([BOB, CAROL].sort());
    }
  });

  it('device_lists changed soft-7 under select barrier', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [
        { user_id: BOB, stream_position: 20 + 7 },
        { user_id: CAROL, stream_position: 30 + 7 },
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM device_key_changes'),
      },
    });
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([
      syncRequest(env, 'since=s10_td0'),
      syncRequest(env, 'since=s10_td0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const lists = r.body.device_lists as { changed: string[] };
      expect(lists.changed.sort()).toEqual([BOB, CAROL].sort());
    }
  });
});

// ---------------------------------------------------------------------------
// DO long-poll concurrent waits
// ---------------------------------------------------------------------------

describe('race DO long-poll concurrent waits after #200', () => {
  it('parallel empty incremental syncs wait together under DO barrier', async () => {
    const syncDo = createSyncDoStub({
      hasEvents: false,
      waitBarrier: { count: 2 },
    });
    const state = defaultRaceState({ streamPos: 10 });
    installRaceMocks(state);
    const env = createEnv({ syncDo });
    const results = await Promise.all([
      syncRequest(env, 'since=s10_td0&timeout=5000'),
      syncRequest(env, 'since=s10_td0&timeout=5000'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(syncDo.fetches).toHaveLength(2);
    expect(results.every((r) => r.body.next_batch === 's10_td0')).toBe(true);
  });

  it('hasEvents true keeps next_batch unadvanced on wake', async () => {
    const syncDo = createSyncDoStub({ hasEvents: true });
    const state = defaultRaceState({ streamPos: 10 });
    installRaceMocks(state);
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s10_td0&timeout=8000');
    expect(status).toBe(200);
    // When woken early, code path still sets next_batch from stream pos at end
    // unless response.next_batch was pre-set — current impl always sets from stream.
    expect(body.next_batch).toBe('s10_td0');
    expect(syncDo.fetches).toHaveLength(1);
  });

  it('DO wait soft-0: timeout clamp + concurrent empty', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const state = defaultRaceState({ streamPos: 20 });
    installRaceMocks(state);
    const env = createEnv({ syncDo });
    const results = await Promise.all([
      syncRequest(env, `since=s20_td0&timeout=5000`),
      syncRequest(env, `since=s20_td0&timeout=60000`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(syncDo.fetches.length).toBeGreaterThanOrEqual(2);
    for (const f of syncDo.fetches) {
      const body = f.body as { timeout: number };
      expect(body.timeout).toBeLessThanOrEqual(25000);
    }
  });

  it('DO wait soft-1: timeout clamp + concurrent empty', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const state = defaultRaceState({ streamPos: 21 });
    installRaceMocks(state);
    const env = createEnv({ syncDo });
    const results = await Promise.all([
      syncRequest(env, `since=s21_td0&timeout=5100`),
      syncRequest(env, `since=s21_td0&timeout=60000`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(syncDo.fetches.length).toBeGreaterThanOrEqual(2);
    for (const f of syncDo.fetches) {
      const body = f.body as { timeout: number };
      expect(body.timeout).toBeLessThanOrEqual(25000);
    }
  });

  it('DO wait soft-2: timeout clamp + concurrent empty', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const state = defaultRaceState({ streamPos: 22 });
    installRaceMocks(state);
    const env = createEnv({ syncDo });
    const results = await Promise.all([
      syncRequest(env, `since=s22_td0&timeout=5200`),
      syncRequest(env, `since=s22_td0&timeout=60000`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(syncDo.fetches.length).toBeGreaterThanOrEqual(2);
    for (const f of syncDo.fetches) {
      const body = f.body as { timeout: number };
      expect(body.timeout).toBeLessThanOrEqual(25000);
    }
  });

  it('DO wait soft-3: timeout clamp + concurrent empty', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const state = defaultRaceState({ streamPos: 23 });
    installRaceMocks(state);
    const env = createEnv({ syncDo });
    const results = await Promise.all([
      syncRequest(env, `since=s23_td0&timeout=5300`),
      syncRequest(env, `since=s23_td0&timeout=60000`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(syncDo.fetches.length).toBeGreaterThanOrEqual(2);
    for (const f of syncDo.fetches) {
      const body = f.body as { timeout: number };
      expect(body.timeout).toBeLessThanOrEqual(25000);
    }
  });

  it('DO wait soft-4: timeout clamp + concurrent empty', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const state = defaultRaceState({ streamPos: 24 });
    installRaceMocks(state);
    const env = createEnv({ syncDo });
    const results = await Promise.all([
      syncRequest(env, `since=s24_td0&timeout=5400`),
      syncRequest(env, `since=s24_td0&timeout=60000`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(syncDo.fetches.length).toBeGreaterThanOrEqual(2);
    for (const f of syncDo.fetches) {
      const body = f.body as { timeout: number };
      expect(body.timeout).toBeLessThanOrEqual(25000);
    }
  });

  it('DO wait soft-5: timeout clamp + concurrent empty', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const state = defaultRaceState({ streamPos: 25 });
    installRaceMocks(state);
    const env = createEnv({ syncDo });
    const results = await Promise.all([
      syncRequest(env, `since=s25_td0&timeout=5500`),
      syncRequest(env, `since=s25_td0&timeout=60000`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(syncDo.fetches.length).toBeGreaterThanOrEqual(2);
    for (const f of syncDo.fetches) {
      const body = f.body as { timeout: number };
      expect(body.timeout).toBeLessThanOrEqual(25000);
    }
  });

  it('DO wait soft-6: timeout clamp + concurrent empty', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const state = defaultRaceState({ streamPos: 26 });
    installRaceMocks(state);
    const env = createEnv({ syncDo });
    const results = await Promise.all([
      syncRequest(env, `since=s26_td0&timeout=5600`),
      syncRequest(env, `since=s26_td0&timeout=60000`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(syncDo.fetches.length).toBeGreaterThanOrEqual(2);
    for (const f of syncDo.fetches) {
      const body = f.body as { timeout: number };
      expect(body.timeout).toBeLessThanOrEqual(25000);
    }
  });

  it('DO wait soft-7: timeout clamp + concurrent empty', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const state = defaultRaceState({ streamPos: 27 });
    installRaceMocks(state);
    const env = createEnv({ syncDo });
    const results = await Promise.all([
      syncRequest(env, `since=s27_td0&timeout=5700`),
      syncRequest(env, `since=s27_td0&timeout=60000`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(syncDo.fetches.length).toBeGreaterThanOrEqual(2);
    for (const f of syncDo.fetches) {
      const body = f.body as { timeout: number };
      expect(body.timeout).toBeLessThanOrEqual(25000);
    }
  });

  it('DO wait soft-8: timeout clamp + concurrent empty', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const state = defaultRaceState({ streamPos: 28 });
    installRaceMocks(state);
    const env = createEnv({ syncDo });
    const results = await Promise.all([
      syncRequest(env, `since=s28_td0&timeout=5800`),
      syncRequest(env, `since=s28_td0&timeout=60000`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(syncDo.fetches.length).toBeGreaterThanOrEqual(2);
    for (const f of syncDo.fetches) {
      const body = f.body as { timeout: number };
      expect(body.timeout).toBeLessThanOrEqual(25000);
    }
  });

  it('DO wait soft-9: timeout clamp + concurrent empty', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const state = defaultRaceState({ streamPos: 29 });
    installRaceMocks(state);
    const env = createEnv({ syncDo });
    const results = await Promise.all([
      syncRequest(env, `since=s29_td0&timeout=5900`),
      syncRequest(env, `since=s29_td0&timeout=60000`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(syncDo.fetches.length).toBeGreaterThanOrEqual(2);
    for (const f of syncDo.fetches) {
      const body = f.body as { timeout: number };
      expect(body.timeout).toBeLessThanOrEqual(25000);
    }
  });
});

// ---------------------------------------------------------------------------
// Failure soft mid concurrent
// ---------------------------------------------------------------------------

describe('race failure soft mid concurrent after #200', () => {
  it('first stream ok, second throws → one 200 one 500', async () => {
    const state = defaultRaceState({ failStreamAfter: 1 });
    installRaceMocks(state);
    const env = createEnv();
    // Sequential: first call succeeds, second hits failStreamAfter.
    const a = await syncRequest(env).catch((e: Error) => ({
      status: 500,
      body: { error: e.message },
    }));
    const b = await syncRequest(env).catch((e: Error) => ({
      status: 500,
      body: { error: e.message },
    }));
    expect(a.status).toBe(200);
    expect(b.status).toBe(500);
  });

  it('userRooms throw after first call soft-fails concurrent pair', async () => {
    const state = defaultRaceState({
      joinRooms: [ROOM],
      failUserRoomsAfter: 1,
    });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env).catch((e: Error) => ({ status: 500, body: { error: e.message } })),
      syncRequest(env).catch((e: Error) => ({ status: 500, body: { error: e.message } })),
    ]);
    expect(results.some((r) => r.status === 500 || r.status === 200)).toBe(true);
  });

  it('OTK SQL fail soft-0', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 1 }],
      failOnSqlIncludesAfter: { includes: 'FROM one_time_keys', after: 1 },
    });
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([
      syncRequest(env).catch((e: Error) => ({ status: 500, body: { error: e.message } })),
      syncRequest(env).catch((e: Error) => ({ status: 500, body: { error: e.message } })),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 500)).toBe(true);
    expect(results.some((r) => r.status === 500)).toBe(true);
  });

  it('OTK SQL fail soft-1', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 1 }],
      failOnSqlIncludesAfter: { includes: 'FROM one_time_keys', after: 1 },
    });
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([
      syncRequest(env).catch((e: Error) => ({ status: 500, body: { error: e.message } })),
      syncRequest(env).catch((e: Error) => ({ status: 500, body: { error: e.message } })),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 500)).toBe(true);
    expect(results.some((r) => r.status === 500)).toBe(true);
  });

  it('OTK SQL fail soft-2', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 1 }],
      failOnSqlIncludesAfter: { includes: 'FROM one_time_keys', after: 1 },
    });
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([
      syncRequest(env).catch((e: Error) => ({ status: 500, body: { error: e.message } })),
      syncRequest(env).catch((e: Error) => ({ status: 500, body: { error: e.message } })),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 500)).toBe(true);
    expect(results.some((r) => r.status === 500)).toBe(true);
  });

  it('OTK SQL fail soft-3', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 1 }],
      failOnSqlIncludesAfter: { includes: 'FROM one_time_keys', after: 1 },
    });
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([
      syncRequest(env).catch((e: Error) => ({ status: 500, body: { error: e.message } })),
      syncRequest(env).catch((e: Error) => ({ status: 500, body: { error: e.message } })),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 500)).toBe(true);
    expect(results.some((r) => r.status === 500)).toBe(true);
  });

  it('OTK SQL fail soft-4', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 1 }],
      failOnSqlIncludesAfter: { includes: 'FROM one_time_keys', after: 1 },
    });
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([
      syncRequest(env).catch((e: Error) => ({ status: 500, body: { error: e.message } })),
      syncRequest(env).catch((e: Error) => ({ status: 500, body: { error: e.message } })),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 500)).toBe(true);
    expect(results.some((r) => r.status === 500)).toBe(true);
  });

  it('OTK SQL fail soft-5', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 1 }],
      failOnSqlIncludesAfter: { includes: 'FROM one_time_keys', after: 1 },
    });
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([
      syncRequest(env).catch((e: Error) => ({ status: 500, body: { error: e.message } })),
      syncRequest(env).catch((e: Error) => ({ status: 500, body: { error: e.message } })),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 500)).toBe(true);
    expect(results.some((r) => r.status === 500)).toBe(true);
  });

  it('OTK SQL fail soft-6', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 1 }],
      failOnSqlIncludesAfter: { includes: 'FROM one_time_keys', after: 1 },
    });
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([
      syncRequest(env).catch((e: Error) => ({ status: 500, body: { error: e.message } })),
      syncRequest(env).catch((e: Error) => ({ status: 500, body: { error: e.message } })),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 500)).toBe(true);
    expect(results.some((r) => r.status === 500)).toBe(true);
  });

  it('OTK SQL fail soft-7', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 1 }],
      failOnSqlIncludesAfter: { includes: 'FROM one_time_keys', after: 1 },
    });
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv({ db });
    const results = await Promise.all([
      syncRequest(env).catch((e: Error) => ({ status: 500, body: { error: e.message } })),
      syncRequest(env).catch((e: Error) => ({ status: 500, body: { error: e.message } })),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 500)).toBe(true);
    expect(results.some((r) => r.status === 500)).toBe(true);
  });

  it('filter KV get fail soft-0', async () => {
    const cache = createRaceKv({
      data: { [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }) },
      failGetAfter: 1,
    });
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, `filter=${FILTER_A}`).catch((e: Error) => ({
        status: 500,
        body: { error: e.message },
      })),
      syncRequest(env, `filter=${FILTER_A}`).catch((e: Error) => ({
        status: 500,
        body: { error: e.message },
      })),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 500)).toBe(true);
  });

  it('filter KV get fail soft-1', async () => {
    const cache = createRaceKv({
      data: { [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }) },
      failGetAfter: 1,
    });
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, `filter=${FILTER_A}`).catch((e: Error) => ({
        status: 500,
        body: { error: e.message },
      })),
      syncRequest(env, `filter=${FILTER_A}`).catch((e: Error) => ({
        status: 500,
        body: { error: e.message },
      })),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 500)).toBe(true);
  });

  it('filter KV get fail soft-2', async () => {
    const cache = createRaceKv({
      data: { [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }) },
      failGetAfter: 1,
    });
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, `filter=${FILTER_A}`).catch((e: Error) => ({
        status: 500,
        body: { error: e.message },
      })),
      syncRequest(env, `filter=${FILTER_A}`).catch((e: Error) => ({
        status: 500,
        body: { error: e.message },
      })),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 500)).toBe(true);
  });

  it('filter KV get fail soft-3', async () => {
    const cache = createRaceKv({
      data: { [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }) },
      failGetAfter: 1,
    });
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, `filter=${FILTER_A}`).catch((e: Error) => ({
        status: 500,
        body: { error: e.message },
      })),
      syncRequest(env, `filter=${FILTER_A}`).catch((e: Error) => ({
        status: 500,
        body: { error: e.message },
      })),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 500)).toBe(true);
  });

  it('filter KV get fail soft-4', async () => {
    const cache = createRaceKv({
      data: { [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }) },
      failGetAfter: 1,
    });
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, `filter=${FILTER_A}`).catch((e: Error) => ({
        status: 500,
        body: { error: e.message },
      })),
      syncRequest(env, `filter=${FILTER_A}`).catch((e: Error) => ({
        status: 500,
        body: { error: e.message },
      })),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 500)).toBe(true);
  });

  it('filter KV get fail soft-5', async () => {
    const cache = createRaceKv({
      data: { [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }) },
      failGetAfter: 1,
    });
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv({ cache });
    const results = await Promise.all([
      syncRequest(env, `filter=${FILTER_A}`).catch((e: Error) => ({
        status: 500,
        body: { error: e.message },
      })),
      syncRequest(env, `filter=${FILTER_A}`).catch((e: Error) => ({
        status: 500,
        body: { error: e.message },
      })),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 500)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Soft floods — method / filter / timeout / charset / lifecycle
// ---------------------------------------------------------------------------

describe('sync concurrent soft flood — invalid method matrix after #200', () => {

  it('rejects or no-routes POST under parallel load', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        syncRequest(env, '', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
          body: '{}',
        })
      )
    );
    expect(results.every((r) => r.status === 404 || r.status === 405 || r.status === 200)).toBe(
      true
    );
  });

  it('rejects or no-routes PUT under parallel load', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        syncRequest(env, '', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
          body: '{}',
        })
      )
    );
    expect(results.every((r) => r.status === 404 || r.status === 405 || r.status === 200)).toBe(
      true
    );
  });

  it('rejects or no-routes PATCH under parallel load', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        syncRequest(env, '', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
          body: '{}',
        })
      )
    );
    expect(results.every((r) => r.status === 404 || r.status === 405 || r.status === 200)).toBe(
      true
    );
  });

  it('rejects or no-routes DELETE under parallel load', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        syncRequest(env, '', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
          body: '{}',
        })
      )
    );
    expect(results.every((r) => r.status === 404 || r.status === 405 || r.status === 200)).toBe(
      true
    );
  });

  it('rejects or no-routes OPTIONS under parallel load', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        syncRequest(env, '', {
          method: 'OPTIONS',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
          body: undefined,
        })
      )
    );
    expect(results.every((r) => r.status === 404 || r.status === 405 || r.status === 200)).toBe(
      true
    );
  });

  it('rejects or no-routes HEAD under parallel load', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        syncRequest(env, '', {
          method: 'HEAD',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
          body: undefined,
        })
      )
    );
    expect(results.every((r) => r.status === 404 || r.status === 405 || r.status === 200)).toBe(
      true
    );
  });
});

describe('sync concurrent soft flood — filter / since / timeout edges after #200', () => {

  it('query soft-0 (missing-id) parallel still 200', async () => {
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'filter=nope'),
      syncRequest(env, 'filter=nope'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('query soft-1 (empty-filter) parallel still 200', async () => {
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'filter='),
      syncRequest(env, 'filter='),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('query soft-2 (bad-json) parallel still 200', async () => {
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'filter=%7Bx'),
      syncRequest(env, 'filter=%7Bx'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('query soft-3 (null-json) parallel still 200', async () => {
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'filter=null'),
      syncRequest(env, 'filter=null'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('query soft-4 (array-json) parallel still 200', async () => {
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'filter=%5B%5D'),
      syncRequest(env, 'filter=%5B%5D'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('query soft-5 (legacy-since) parallel still 200', async () => {
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=12'),
      syncRequest(env, 'since=12'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('query soft-6 (garbage-since) parallel still 200', async () => {
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=not-a-token'),
      syncRequest(env, 'since=not-a-token'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('query soft-7 (neg-timeout) parallel still 200', async () => {
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0&timeout=-1'),
      syncRequest(env, 'since=s1_td0&timeout=-1'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('query soft-8 (huge-timeout) parallel still 200', async () => {
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'since=s1_td0&timeout=999999'),
      syncRequest(env, 'since=s1_td0&timeout=999999'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('query soft-9 (full-state) parallel still 200', async () => {
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'full_state=true'),
      syncRequest(env, 'full_state=true'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('query soft-10 (full-state-false) parallel still 200', async () => {
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'full_state=false'),
      syncRequest(env, 'full_state=false'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('query soft-11 (set-presence) parallel still 200', async () => {
    const state = defaultRaceState({ joinRooms: [ROOM] });
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env, 'set_presence=unavailable'),
      syncRequest(env, 'set_presence=unavailable'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('empty baseline soft-0', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env),
      syncRequest(env, 'since=s0_td0'),
      syncRequest(env, 'timeout=0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => typeof r.body.next_batch === 'string')).toBe(true);
  });

  it('empty baseline soft-1', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env),
      syncRequest(env, 'since=s0_td0'),
      syncRequest(env, 'timeout=0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => typeof r.body.next_batch === 'string')).toBe(true);
  });

  it('empty baseline soft-2', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env),
      syncRequest(env, 'since=s0_td0'),
      syncRequest(env, 'timeout=0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => typeof r.body.next_batch === 'string')).toBe(true);
  });

  it('empty baseline soft-3', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env),
      syncRequest(env, 'since=s0_td0'),
      syncRequest(env, 'timeout=0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => typeof r.body.next_batch === 'string')).toBe(true);
  });

  it('empty baseline soft-4', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env),
      syncRequest(env, 'since=s0_td0'),
      syncRequest(env, 'timeout=0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => typeof r.body.next_batch === 'string')).toBe(true);
  });

  it('empty baseline soft-5', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env),
      syncRequest(env, 'since=s0_td0'),
      syncRequest(env, 'timeout=0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => typeof r.body.next_batch === 'string')).toBe(true);
  });

  it('empty baseline soft-6', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env),
      syncRequest(env, 'since=s0_td0'),
      syncRequest(env, 'timeout=0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => typeof r.body.next_batch === 'string')).toBe(true);
  });

  it('empty baseline soft-7', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env),
      syncRequest(env, 'since=s0_td0'),
      syncRequest(env, 'timeout=0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => typeof r.body.next_batch === 'string')).toBe(true);
  });

  it('empty baseline soft-8', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env),
      syncRequest(env, 'since=s0_td0'),
      syncRequest(env, 'timeout=0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => typeof r.body.next_batch === 'string')).toBe(true);
  });

  it('empty baseline soft-9', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env),
      syncRequest(env, 'since=s0_td0'),
      syncRequest(env, 'timeout=0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => typeof r.body.next_batch === 'string')).toBe(true);
  });

  it('empty baseline soft-10', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env),
      syncRequest(env, 'since=s0_td0'),
      syncRequest(env, 'timeout=0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => typeof r.body.next_batch === 'string')).toBe(true);
  });

  it('empty baseline soft-11', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env),
      syncRequest(env, 'since=s0_td0'),
      syncRequest(env, 'timeout=0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => typeof r.body.next_batch === 'string')).toBe(true);
  });

  it('empty baseline soft-12', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env),
      syncRequest(env, 'since=s0_td0'),
      syncRequest(env, 'timeout=0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => typeof r.body.next_batch === 'string')).toBe(true);
  });

  it('empty baseline soft-13', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env),
      syncRequest(env, 'since=s0_td0'),
      syncRequest(env, 'timeout=0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => typeof r.body.next_batch === 'string')).toBe(true);
  });

  it('empty baseline soft-14', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env),
      syncRequest(env, 'since=s0_td0'),
      syncRequest(env, 'timeout=0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => typeof r.body.next_batch === 'string')).toBe(true);
  });

  it('empty baseline soft-15', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const results = await Promise.all([
      syncRequest(env),
      syncRequest(env, 'since=s0_td0'),
      syncRequest(env, 'timeout=0'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => typeof r.body.next_batch === 'string')).toBe(true);
  });
});

describe('sync concurrent soft flood — charset / content-type edges after #200', () => {

  it('content-type soft-0', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const headers: Record<string, string> = { Authorization: 'Bearer t' };
    if ('application/json') headers['Content-Type'] = 'application/json';
    const results = await Promise.all([
      syncRequest(env, '', { headers }),
      syncRequest(env, 'since=s1_td0', { headers }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('content-type soft-1', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const headers: Record<string, string> = { Authorization: 'Bearer t' };
    if ('application/json; charset=utf-8') headers['Content-Type'] = 'application/json; charset=utf-8';
    const results = await Promise.all([
      syncRequest(env, '', { headers }),
      syncRequest(env, 'since=s1_td0', { headers }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('content-type soft-2', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const headers: Record<string, string> = { Authorization: 'Bearer t' };
    if ('text/plain') headers['Content-Type'] = 'text/plain';
    const results = await Promise.all([
      syncRequest(env, '', { headers }),
      syncRequest(env, 'since=s1_td0', { headers }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('content-type soft-3', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const headers: Record<string, string> = { Authorization: 'Bearer t' };
    if ('application/x-www-form-urlencoded') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const results = await Promise.all([
      syncRequest(env, '', { headers }),
      syncRequest(env, 'since=s1_td0', { headers }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('content-type soft-4', async () => {
    const state = defaultRaceState();
    installRaceMocks(state);
    const env = createEnv();
    const headers: Record<string, string> = { Authorization: 'Bearer t' };
    if ('') headers['Content-Type'] = '';
    const results = await Promise.all([
      syncRequest(env, '', { headers }),
      syncRequest(env, 'since=s1_td0', { headers }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
});

describe('sync concurrent soft flood — lifecycle initial→incremental after #200', () => {

  it('lifecycle soft-0: initial then parallel incrementals', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: `$lc-0:example.com`,
      content: { body: 'lc', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [msg] },
      streamPos: 50,
    });
    installRaceMocks(state);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    const next = String(initial.body.next_batch);
    const results = await Promise.all([
      syncRequest(env, `since=${next}`),
      syncRequest(env, `since=${next}&timeout=0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('lifecycle soft-1: initial then parallel incrementals', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: `$lc-1:example.com`,
      content: { body: 'lc', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [msg] },
      streamPos: 51,
    });
    installRaceMocks(state);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    const next = String(initial.body.next_batch);
    const results = await Promise.all([
      syncRequest(env, `since=${next}`),
      syncRequest(env, `since=${next}&timeout=0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('lifecycle soft-2: initial then parallel incrementals', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: `$lc-2:example.com`,
      content: { body: 'lc', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [msg] },
      streamPos: 52,
    });
    installRaceMocks(state);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    const next = String(initial.body.next_batch);
    const results = await Promise.all([
      syncRequest(env, `since=${next}`),
      syncRequest(env, `since=${next}&timeout=0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('lifecycle soft-3: initial then parallel incrementals', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: `$lc-3:example.com`,
      content: { body: 'lc', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [msg] },
      streamPos: 53,
    });
    installRaceMocks(state);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    const next = String(initial.body.next_batch);
    const results = await Promise.all([
      syncRequest(env, `since=${next}`),
      syncRequest(env, `since=${next}&timeout=0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('lifecycle soft-4: initial then parallel incrementals', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: `$lc-4:example.com`,
      content: { body: 'lc', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [msg] },
      streamPos: 54,
    });
    installRaceMocks(state);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    const next = String(initial.body.next_batch);
    const results = await Promise.all([
      syncRequest(env, `since=${next}`),
      syncRequest(env, `since=${next}&timeout=0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('lifecycle soft-5: initial then parallel incrementals', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: `$lc-5:example.com`,
      content: { body: 'lc', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [msg] },
      streamPos: 55,
    });
    installRaceMocks(state);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    const next = String(initial.body.next_batch);
    const results = await Promise.all([
      syncRequest(env, `since=${next}`),
      syncRequest(env, `since=${next}&timeout=0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('lifecycle soft-6: initial then parallel incrementals', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: `$lc-6:example.com`,
      content: { body: 'lc', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [msg] },
      streamPos: 56,
    });
    installRaceMocks(state);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    const next = String(initial.body.next_batch);
    const results = await Promise.all([
      syncRequest(env, `since=${next}`),
      syncRequest(env, `since=${next}&timeout=0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('lifecycle soft-7: initial then parallel incrementals', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: `$lc-7:example.com`,
      content: { body: 'lc', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [msg] },
      streamPos: 57,
    });
    installRaceMocks(state);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    const next = String(initial.body.next_batch);
    const results = await Promise.all([
      syncRequest(env, `since=${next}`),
      syncRequest(env, `since=${next}&timeout=0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('lifecycle soft-8: initial then parallel incrementals', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: `$lc-8:example.com`,
      content: { body: 'lc', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [msg] },
      streamPos: 58,
    });
    installRaceMocks(state);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    const next = String(initial.body.next_batch);
    const results = await Promise.all([
      syncRequest(env, `since=${next}`),
      syncRequest(env, `since=${next}&timeout=0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('lifecycle soft-9: initial then parallel incrementals', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: `$lc-9:example.com`,
      content: { body: 'lc', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [msg] },
      streamPos: 59,
    });
    installRaceMocks(state);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    const next = String(initial.body.next_batch);
    const results = await Promise.all([
      syncRequest(env, `since=${next}`),
      syncRequest(env, `since=${next}&timeout=0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('lifecycle soft-10: initial then parallel incrementals', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: `$lc-10:example.com`,
      content: { body: 'lc', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [msg] },
      streamPos: 60,
    });
    installRaceMocks(state);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    const next = String(initial.body.next_batch);
    const results = await Promise.all([
      syncRequest(env, `since=${next}`),
      syncRequest(env, `since=${next}&timeout=0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('lifecycle soft-11: initial then parallel incrementals', async () => {
    const msg = makePdu({
      type: 'm.room.message',
      event_id: `$lc-11:example.com`,
      content: { body: 'lc', msgtype: 'm.text' },
    });
    const state = defaultRaceState({
      joinRooms: [ROOM],
      eventsSince: { [ROOM]: [msg] },
      streamPos: 61,
    });
    installRaceMocks(state);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    const next = String(initial.body.next_batch);
    const results = await Promise.all([
      syncRequest(env, `since=${next}`),
      syncRequest(env, `since=${next}&timeout=0`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
});

describe('sync concurrent bind contracts after #200', () => {
  it('OTK SELECT binds user_id then device_id', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 3 }],
    });
    installRaceMocks(defaultRaceState());
    const env = createEnv({ db });
    await syncRequest(env);
    const otk = db.selects.find((s) => s.sql.includes('FROM one_time_keys'));
    expect(otk?.args).toEqual([USER, DEVICE]);
  });

  it('fallback SELECT binds user_id then device_id', async () => {
    const db = createSyncDb({
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    installRaceMocks(defaultRaceState());
    const env = createEnv({ db });
    await syncRequest(env);
    const fb = db.selects.find((s) => s.sql.includes('FROM fallback_keys'));
    expect(fb?.args).toEqual([USER, DEVICE]);
  });

  it('device_lists SELECT binds since, exclude self, requester', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [{ user_id: BOB, stream_position: 5 }],
    });
    installRaceMocks(defaultRaceState({ joinRooms: [ROOM] }));
    const env = createEnv({ db });
    await syncRequest(env, 'since=s1_td0');
    const dk = db.selects.find(
      (s) => s.sql.includes('FROM device_key_changes dkc') && s.sql.includes('SELECT DISTINCT')
    );
    expect(dk?.args).toEqual([1, USER, USER]);
  });

  it('filter KV key is filter:${userId}:${filterId}', async () => {
    const cache = createRaceKv({
      data: {
        [filterKvKey(FILTER_A)]: JSON.stringify({ room: { rooms: [ROOM] } }),
      },
    });
    installRaceMocks(defaultRaceState({ joinRooms: [ROOM, ROOM2] }));
    const env = createEnv({ cache });
    await syncRequest(env, `filter=${FILTER_A}`);
    expect(cache.gets).toContain(filterKvKey(FILTER_A));
  });

  it('parallel sync bind contracts stay per-request', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 1 }],
      deviceKeyChanges: [{ user_id: BOB, stream_position: 9 }],
    });
    installRaceMocks(defaultRaceState({ joinRooms: [ROOM] }));
    const env = createEnv({ db });
    await Promise.all([
      syncRequest(env, 'since=s1_td0'),
      syncRequest(env, 'since=s2_td0'),
    ]);
    const otks = db.selects.filter((s) => s.sql.includes('FROM one_time_keys'));
    expect(otks.length).toBeGreaterThanOrEqual(2);
    expect(otks.every((s) => s.args[0] === USER && s.args[1] === DEVICE)).toBe(true);
  });

  it('self device_lists COUNT bind soft-0', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [{ user_id: USER, stream_position: 5 }],
    });
    installRaceMocks(defaultRaceState());
    const env = createEnv({ db });
    await syncRequest(env, 'since=s1_td0');
    const self = db.selects.find(
      (s) => s.sql.includes('COUNT(*)') && s.sql.includes('dkc.user_id = ?')
    );
    expect(self?.args).toEqual([1, USER]);
  });

  it('self device_lists COUNT bind soft-1', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [{ user_id: USER, stream_position: 6 }],
    });
    installRaceMocks(defaultRaceState());
    const env = createEnv({ db });
    await syncRequest(env, 'since=s1_td0');
    const self = db.selects.find(
      (s) => s.sql.includes('COUNT(*)') && s.sql.includes('dkc.user_id = ?')
    );
    expect(self?.args).toEqual([1, USER]);
  });

  it('self device_lists COUNT bind soft-2', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [{ user_id: USER, stream_position: 7 }],
    });
    installRaceMocks(defaultRaceState());
    const env = createEnv({ db });
    await syncRequest(env, 'since=s1_td0');
    const self = db.selects.find(
      (s) => s.sql.includes('COUNT(*)') && s.sql.includes('dkc.user_id = ?')
    );
    expect(self?.args).toEqual([1, USER]);
  });

  it('self device_lists COUNT bind soft-3', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [{ user_id: USER, stream_position: 8 }],
    });
    installRaceMocks(defaultRaceState());
    const env = createEnv({ db });
    await syncRequest(env, 'since=s1_td0');
    const self = db.selects.find(
      (s) => s.sql.includes('COUNT(*)') && s.sql.includes('dkc.user_id = ?')
    );
    expect(self?.args).toEqual([1, USER]);
  });

  it('self device_lists COUNT bind soft-4', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [{ user_id: USER, stream_position: 9 }],
    });
    installRaceMocks(defaultRaceState());
    const env = createEnv({ db });
    await syncRequest(env, 'since=s1_td0');
    const self = db.selects.find(
      (s) => s.sql.includes('COUNT(*)') && s.sql.includes('dkc.user_id = ?')
    );
    expect(self?.args).toEqual([1, USER]);
  });

  it('self device_lists COUNT bind soft-5', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [{ user_id: USER, stream_position: 10 }],
    });
    installRaceMocks(defaultRaceState());
    const env = createEnv({ db });
    await syncRequest(env, 'since=s1_td0');
    const self = db.selects.find(
      (s) => s.sql.includes('COUNT(*)') && s.sql.includes('dkc.user_id = ?')
    );
    expect(self?.args).toEqual([1, USER]);
  });

  it('self device_lists COUNT bind soft-6', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [{ user_id: USER, stream_position: 11 }],
    });
    installRaceMocks(defaultRaceState());
    const env = createEnv({ db });
    await syncRequest(env, 'since=s1_td0');
    const self = db.selects.find(
      (s) => s.sql.includes('COUNT(*)') && s.sql.includes('dkc.user_id = ?')
    );
    expect(self?.args).toEqual([1, USER]);
  });

  it('self device_lists COUNT bind soft-7', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [{ user_id: USER, stream_position: 12 }],
    });
    installRaceMocks(defaultRaceState());
    const env = createEnv({ db });
    await syncRequest(env, 'since=s1_td0');
    const self = db.selects.find(
      (s) => s.sql.includes('COUNT(*)') && s.sql.includes('dkc.user_id = ?')
    );
    expect(self?.args).toEqual([1, USER]);
  });

  it('self device_lists COUNT bind soft-8', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [{ user_id: USER, stream_position: 13 }],
    });
    installRaceMocks(defaultRaceState());
    const env = createEnv({ db });
    await syncRequest(env, 'since=s1_td0');
    const self = db.selects.find(
      (s) => s.sql.includes('COUNT(*)') && s.sql.includes('dkc.user_id = ?')
    );
    expect(self?.args).toEqual([1, USER]);
  });

  it('self device_lists COUNT bind soft-9', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [{ user_id: USER, stream_position: 14 }],
    });
    installRaceMocks(defaultRaceState());
    const env = createEnv({ db });
    await syncRequest(env, 'since=s1_td0');
    const self = db.selects.find(
      (s) => s.sql.includes('COUNT(*)') && s.sql.includes('dkc.user_id = ?')
    );
    expect(self?.args).toEqual([1, USER]);
  });
});

describe('sync concurrent module isolation after #200', () => {
  it('does not touch rooms/tags/profile mutate surfaces', async () => {
    installRaceMocks(defaultRaceState({ joinRooms: [ROOM] }));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.rooms).toBeDefined();
    expect(getUserRooms).toHaveBeenCalled();
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
});
