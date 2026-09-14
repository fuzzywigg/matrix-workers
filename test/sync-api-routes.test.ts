/**
 * TOKENMAXX HEAVY deepen after #114 — different slice: client /sync HTTP route.
 * Avoids rooms (#114), media (#109/#113), keys (#99), helpers-only sync-filters.
 * Tests-only — no product inventing.
 * Exercises initial/incremental sync, filters (inline + KV), join/invite/leave,
 * full_state, to-device + E2EE key counts, device_lists, ephemeral, DO long-poll.
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
const ROOM = '!room:example.com';
const ROOM2 = '!other:example.com';
const INVITE_ROOM = '!invite:example.com';
const LEFT_ROOM = '!left:example.com';
const NOW = 1_700_000_000_000;

type SqlCall = { sql: string; args: unknown[] };

type OtkCount = { algorithm: string; count: number };
type FallbackAlgo = { algorithm: string };
type DeviceKeyChange = { user_id: string; stream_position: number };

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

function createSyncDoStub(opts: { hasEvents?: boolean; fail?: boolean } = {}) {
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
      if (opts.fail) {
        throw new Error('sync DO boom');
      }
      return Response.json({ hasEvents: opts.hasEvents ?? false });
    },
  };
}

type SyncDoStub = ReturnType<typeof createSyncDoStub>;

function createSyncDb(opts: {
  otkCounts?: OtkCount[];
  fallbackAlgos?: FallbackAlgo[];
  deviceKeyChanges?: DeviceKeyChange[];
  sharedRoomUsers?: string[];
} = {}) {
  const otkCounts = opts.otkCounts ?? [];
  const fallbackAlgos = opts.fallbackAlgos ?? [];
  const deviceKeyChanges = opts.deviceKeyChanges ?? [];
  const sharedRoomUsers = new Set(opts.sharedRoomUsers ?? [BOB, CAROL]);
  const selects: SqlCall[] = [];

  const db = {
    otkCounts,
    fallbackAlgos,
    deviceKeyChanges,
    sharedRoomUsers,
    selects,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });

              if (
                sql.includes('FROM device_key_changes') &&
                sql.includes('COUNT(*)') &&
                sql.includes('dkc.user_id = ?')
              ) {
                const [sincePos, userId] = args as [number, string];
                const count = deviceKeyChanges.filter(
                  (c) => c.user_id === userId && c.stream_position > sincePos
                ).length;
                return { count } as T;
              }

              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 160)}`);
            },

            async all<T>() {
              selects.push({ sql, args });

              if (
                sql.includes('FROM one_time_keys') &&
                sql.includes('GROUP BY algorithm')
              ) {
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
): Promise<{ status: number; body: Record<string, unknown> }> {
  const path = `/_matrix/client/v3/sync${query ? `?${query}` : ''}`;
  const res = await syncApp.request(`http://localhost${path}`, init, env);
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

function resetMocks() {
  getUserRooms.mockReset().mockImplementation(async (_db: unknown, _userId: string, membership?: string) => {
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
  getReceiptsForRoom.mockReset().mockResolvedValue({
    type: 'm.receipt',
    content: {},
  });
  getTypingUsers.mockReset().mockResolvedValue([]);
}

beforeEach(() => {
  resetMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Empty / baseline sync
// ---------------------------------------------------------------------------

describe('GET /_matrix/client/v3/sync — empty baseline', () => {
  it('returns 200 with empty rooms and composite next_batch on initial sync', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);

    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_one_time_keys_count).toEqual({});
    expect(body.device_unused_fallback_key_types).toEqual([]);
  });

  it('includes self in device_lists.changed on initial sync (since absent)', async () => {
    const env = createEnv();
    const { body } = await syncRequest(env);
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });

  it('includes self in device_lists.changed when since=0 / legacy zero', async () => {
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=0');
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });

  it('calls getLatestStreamPosition once per request', async () => {
    const env = createEnv();
    await syncRequest(env, 'since=s10_td2');
    expect(getLatestStreamPosition).toHaveBeenCalledTimes(1);
    expect(getLatestStreamPosition).toHaveBeenCalledWith(env.DB);
  });

  it('queries join, invite, and (without filter) leave memberships on incremental', async () => {
    const env = createEnv();
    await syncRequest(env, 'since=s5_td1');
    expect(getUserRooms).toHaveBeenCalledWith(expect.anything(), USER, 'join');
    expect(getUserRooms).toHaveBeenCalledWith(expect.anything(), USER, 'invite');
    expect(getUserRooms).toHaveBeenCalledWith(expect.anything(), USER, 'leave');
  });

  it('skips leave room lookup on initial sync (sincePosition 0)', async () => {
    const env = createEnv();
    await syncRequest(env);
    const memberships = getUserRooms.mock.calls.map((c) => c[2]);
    expect(memberships).toContain('join');
    expect(memberships).toContain('invite');
    expect(memberships).not.toContain('leave');
  });
});

// ---------------------------------------------------------------------------
// Sync token / next_batch
// ---------------------------------------------------------------------------

describe('GET /sync — sync tokens and next_batch', () => {
  it('parses composite since and advances next_batch from stream + to-device', async () => {
    getLatestStreamPosition.mockResolvedValue(100);
    getToDeviceMessages.mockResolvedValue({
      events: [{ type: 'm.room_key_request', content: { a: 1 }, sender: BOB }],
      nextBatch: '55',
    });
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s84_td119');

    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '119');
    expect(body.next_batch).toBe('s100_td55');
    expect((body.to_device as { events: unknown[] }).events).toHaveLength(1);
  });

  it('treats legacy numeric since as both events and to-device positions', async () => {
    getLatestStreamPosition.mockResolvedValue(20);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '7' });
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=7');

    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '7');
    expect(body.next_batch).toBe('s20_td7');
  });

  it('falls back to zero positions for garbage since tokens', async () => {
    getLatestStreamPosition.mockResolvedValue(3);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=not-a-token');
    expect(body.next_batch).toBe('s3_td0');
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });

  it('keeps to-device position when nextBatch is non-numeric', async () => {
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: 'nope' });
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s10_td8');
    expect(body.next_batch).toBe('s42_td8');
  });

  it('uses empty to-device nextBatch as 0 via parseInt falsy path', async () => {
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '' });
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s1_td4');
    expect(body.next_batch).toBe('s42_td4');
  });
});

// ---------------------------------------------------------------------------
// E2EE key counts + device lists
// ---------------------------------------------------------------------------

describe('GET /sync — E2EE key counts and device_lists', () => {
  it('returns one-time key counts and unused fallback types from D1', async () => {
    const db = createSyncDb({
      otkCounts: [
        { algorithm: 'signed_curve25519', count: 42 },
        { algorithm: 'curve25519', count: 3 },
      ],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const env = createEnv({ db });
    const { body } = await syncRequest(env);

    expect(body.device_one_time_keys_count).toEqual({
      signed_curve25519: 42,
      curve25519: 3,
    });
    expect(body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);

    const otkSql = db.selects.find((s) => s.sql.includes('one_time_keys'));
    expect(otkSql?.args).toEqual([USER, DEVICE]);
    const fbSql = db.selects.find((s) => s.sql.includes('fallback_keys'));
    expect(fbSql?.args).toEqual([USER, DEVICE]);
  });

  it('returns empty OTK map and fallback list when D1 has none', async () => {
    const env = createEnv({ db: createSyncDb() });
    const { body } = await syncRequest(env, 'since=s5_td0');
    expect(body.device_one_time_keys_count).toEqual({});
    expect(body.device_unused_fallback_key_types).toEqual([]);
  });

  it('omits device_lists on incremental sync when nothing changed', async () => {
    const env = createEnv({
      db: createSyncDb({ deviceKeyChanges: [], sharedRoomUsers: [BOB] }),
    });
    const { body } = await syncRequest(env, 'since=s10_td0');
    expect(body.device_lists).toBeUndefined();
  });

  it('lists shared-room peers whose device keys changed since position', async () => {
    const env = createEnv({
      db: createSyncDb({
        deviceKeyChanges: [
          { user_id: BOB, stream_position: 12 },
          { user_id: CAROL, stream_position: 8 }, // before since — ignored
          { user_id: '@outsider:example.com', stream_position: 99 }, // not shared
        ],
        sharedRoomUsers: [BOB, CAROL],
      }),
    });
    const { body } = await syncRequest(env, 'since=s10_td0');
    expect(body.device_lists).toEqual({ changed: [BOB], left: [] });
  });

  it('includes self in device_lists.changed when own keys changed', async () => {
    const env = createEnv({
      db: createSyncDb({
        deviceKeyChanges: [
          { user_id: USER, stream_position: 15 },
          { user_id: BOB, stream_position: 20 },
        ],
        sharedRoomUsers: [BOB],
      }),
    });
    const { body } = await syncRequest(env, 'since=s10_td0');
    expect(body.device_lists).toEqual({ changed: [BOB, USER], left: [] });
  });

  it('includes only self when only own device_key_changes exist', async () => {
    const env = createEnv({
      db: createSyncDb({
        deviceKeyChanges: [{ user_id: USER, stream_position: 50 }],
        sharedRoomUsers: [BOB],
      }),
    });
    const { body } = await syncRequest(env, 'since=s10_td0');
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
});

// ---------------------------------------------------------------------------
// Global + room account data
// ---------------------------------------------------------------------------

describe('GET /sync — account_data', () => {
  it('loads all global account data on initial sync (no since position)', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.push_rules', content: { global: {} } },
      { type: 'm.direct', content: { [BOB]: [ROOM] } },
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env);

    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, undefined);
    expect(body.account_data).toEqual({
      events: [
        { type: 'm.push_rules', content: { global: {} } },
        { type: 'm.direct', content: { [BOB]: [ROOM] } },
      ],
    });
  });

  it('passes sincePosition for incremental global account data', async () => {
    getGlobalAccountData.mockResolvedValue([{ type: 'im.vector.setting.breadcrumbs', content: {} }]);
    const env = createEnv();
    await syncRequest(env, 'since=s9_td0');
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 9);
  });

  it('applies account_data event filter (types whitelist)', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.push_rules', content: {} },
      { type: 'm.direct', content: {} },
      { type: 'org.example.custom', content: { x: 1 } },
    ]);
    const filter = encodeURIComponent(JSON.stringify({ account_data: { types: ['m.direct'] } }));
    const env = createEnv();
    const { body } = await syncRequest(env, `filter=${filter}`);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: {} }],
    });
  });

  it('loads room account data per joined room and applies room.account_data filter', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getRoomAccountData.mockResolvedValue([
      { type: 'm.tag', content: { tags: { 'm.favourite': { order: 0.1 } } } },
      { type: 'org.example.room', content: { a: 1 } },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ room: { account_data: { types: ['m.tag'] } } })
    );
    const env = createEnv();
    const { body } = await syncRequest(env, `filter=${filter}`);
    const join = (body.rooms as { join: Record<string, { account_data: { events: unknown[] } }> })
      .join[ROOM];
    expect(getRoomAccountData).toHaveBeenCalledWith(env.DB, USER, ROOM, undefined);
    expect(join.account_data.events).toEqual([
      { type: 'm.tag', content: { tags: { 'm.favourite': { order: 0.1 } } } },
    ]);
  });

  it('passes since to getRoomAccountData on incremental joined-room sync', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    const env = createEnv();
    await syncRequest(env, 'since=s11_td0');
    expect(getRoomAccountData).toHaveBeenCalledWith(env.DB, USER, ROOM, 11);
  });
});

// ---------------------------------------------------------------------------
// Joined rooms: timeline, state, full_state, filters
// ---------------------------------------------------------------------------

describe('GET /sync — joined rooms timeline and state', () => {
  it('builds join section with timeline events and prev_batch', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg1:example.com',
        content: { body: 'hi', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s5_td0');

    const join = (body.rooms as { join: Record<string, unknown> }).join[ROOM] as {
      timeline: { events: Array<{ type: string; event_id: string }>; limited: boolean; prev_batch: string };
      state: { events: unknown[] };
    };
    expect(join.timeline.limited).toBe(false);
    expect(join.timeline.prev_batch).toBe('5');
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg1:example.com',
        sender: BOB,
        content: { body: 'hi', msgtype: 'm.text' },
        room_id: ROOM,
      }),
    ]);
    expect(join.state.events).toEqual([]);
    expect(getEventsSince).toHaveBeenCalledWith(env.DB, ROOM, 5);
  });

  it('puts state events into both state and timeline when state_key is set', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: '$join1:example.com',
        state_key: BOB,
        content: { membership: 'join' },
        sender: BOB,
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$msg2:example.com',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s1_td0');
    const join = (body.rooms as { join: Record<string, { state: { events: unknown[] }; timeline: { events: unknown[] } }> })
      .join[ROOM];
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0]).toEqual(
      expect.objectContaining({ type: 'm.room.member', state_key: BOB, event_id: '$join1:example.com' })
    );
    expect(join.timeline.events).toHaveLength(2);
  });

  it('loads full room state on initial sync and dedupes timeline state events', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    const shared = makePdu({
      type: 'm.room.create',
      event_id: '$create:example.com',
      state_key: '',
      content: { creator: USER },
    });
    getEventsSince.mockResolvedValue([shared]);
    getRoomState.mockResolvedValue([
      shared,
      makePdu({
        type: 'm.room.power_levels',
        event_id: '$pl:example.com',
        state_key: '',
        content: { users: { [USER]: 100 } },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env);
    const join = (body.rooms as { join: Record<string, { state: { events: Array<{ event_id: string }> } }> })
      .join[ROOM];
    expect(getRoomState).toHaveBeenCalledWith(env.DB, ROOM);
    const ids = join.state.events.map((e) => e.event_id).sort();
    expect(ids).toEqual(['$create:example.com', '$pl:example.com']);
  });

  it('loads full state when full_state=true on incremental sync', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.name',
        event_id: '$name:example.com',
        state_key: '',
        content: { name: 'Hall' },
      }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s20_td0&full_state=true');
    expect(getRoomState).toHaveBeenCalledWith(env.DB, ROOM);
  });

  it('does not load getRoomState on incremental sync without full_state', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    const env = createEnv();
    await syncRequest(env, 'since=s20_td0&full_state=false');
    expect(getRoomState).not.toHaveBeenCalled();
  });

  it('applies room.timeline type filter', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$m:example.com', content: { body: 'a' } }),
      makePdu({ type: 'm.reaction', event_id: '$r:example.com', content: { 'm.relates_to': {} } }),
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ room: { timeline: { types: ['m.room.message'] } } })
    );
    const env = createEnv();
    const { body } = await syncRequest(env, `since=s1_td0&filter=${filter}`);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ type: string }> } }> })
      .join[ROOM];
    expect(join.timeline.events.map((e) => e.type)).toEqual(['m.room.message']);
  });

  it('applies room.state not_types filter', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: '$mem:example.com',
        state_key: BOB,
        content: { membership: 'join' },
        sender: BOB,
      }),
      makePdu({
        type: 'm.room.topic',
        event_id: '$topic:example.com',
        state_key: '',
        content: { topic: 't' },
      }),
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ room: { state: { not_types: ['m.room.member'] } } })
    );
    const env = createEnv();
    const { body } = await syncRequest(env, `since=s1_td0&filter=${filter}`);
    const join = (body.rooms as { join: Record<string, { state: { events: Array<{ type: string }> } }> })
      .join[ROOM];
    expect(join.state.events.map((e) => e.type)).toEqual(['m.room.topic']);
  });

  it('excludes rooms via room.not_rooms filter', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM, ROOM2];
      return [];
    });
    getEventsSince.mockImplementation(async (_db, roomId: string) => [
      makePdu({
        type: 'm.room.message',
        event_id: `$m-${roomId}:example.com`,
        room_id: roomId,
        content: { body: roomId },
      }),
    ]);
    const filter = encodeURIComponent(JSON.stringify({ room: { not_rooms: [ROOM] } }));
    const env = createEnv();
    const { body } = await syncRequest(env, `since=s1_td0&filter=${filter}`);
    const join = (body.rooms as { join: Record<string, unknown> }).join;
    expect(Object.keys(join)).toEqual([ROOM2]);
  });

  it('includes only whitelisted rooms via room.rooms filter', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM, ROOM2];
      return [];
    });
    const filter = encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM2] } }));
    const env = createEnv();
    const { body } = await syncRequest(env, `filter=${filter}`);
    expect(Object.keys((body.rooms as { join: object }).join)).toEqual([ROOM2]);
  });

  it('processes multiple joined rooms independently', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM, ROOM2];
      return [];
    });
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === ROOM) {
        return [makePdu({ type: 'm.room.message', event_id: '$a:example.com', content: { body: 'a' } })];
      }
      return [makePdu({ type: 'm.room.message', event_id: '$b:example.com', room_id: ROOM2, content: { body: 'b' } })];
    });
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s2_td0');
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string }> } }> })
      .join;
    expect(join[ROOM].timeline.events[0].event_id).toBe('$a:example.com');
    expect(join[ROOM2].timeline.events[0].event_id).toBe('$b:example.com');
  });
});

// ---------------------------------------------------------------------------
// Ephemeral: receipts + typing + filters
// ---------------------------------------------------------------------------

describe('GET /sync — ephemeral receipts and typing', () => {
  it('adds m.receipt ephemeral when receipts content is non-empty', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getReceiptsForRoom.mockResolvedValue({
      type: 'm.receipt',
      content: {
        '$msg1:example.com': {
          'm.read': { [BOB]: { ts: NOW } },
        },
      },
    });
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s1_td0');
    const join = (body.rooms as { join: Record<string, { ephemeral: { events: Array<{ type: string }> } }> })
      .join[ROOM];
    expect(getReceiptsForRoom).toHaveBeenCalledWith(env, ROOM, USER);
    expect(join.ephemeral.events).toEqual([
      expect.objectContaining({ type: 'm.receipt' }),
    ]);
  });

  it('skips receipts when content is empty', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getReceiptsForRoom.mockResolvedValue({ type: 'm.receipt', content: {} });
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s1_td0');
    const join = (body.rooms as { join: Record<string, { ephemeral: { events: unknown[] } }> }).join[ROOM];
    expect(join.ephemeral.events).toEqual([]);
  });

  it('adds m.typing ephemeral when typing users exist', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getTypingUsers.mockResolvedValue([BOB, CAROL]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s1_td0');
    const join = (body.rooms as { join: Record<string, { ephemeral: { events: unknown[] } }> }).join[ROOM];
    expect(getTypingUsers).toHaveBeenCalledWith(env, ROOM);
    expect(join.ephemeral.events).toContainEqual({
      type: 'm.typing',
      content: { user_ids: [BOB, CAROL] },
    });
  });

  it('combines receipts and typing then applies ephemeral type filter', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getReceiptsForRoom.mockResolvedValue({
      type: 'm.receipt',
      content: { '$e:example.com': { 'm.read': { [USER]: { ts: NOW } } } },
    });
    getTypingUsers.mockResolvedValue([BOB]);
    const filter = encodeURIComponent(
      JSON.stringify({ room: { ephemeral: { types: ['m.typing'] } } })
    );
    const env = createEnv();
    const { body } = await syncRequest(env, `since=s1_td0&filter=${filter}`);
    const join = (body.rooms as { join: Record<string, { ephemeral: { events: Array<{ type: string }> } }> })
      .join[ROOM];
    expect(join.ephemeral.events.map((e) => e.type)).toEqual(['m.typing']);
  });

  it('filters out typing via not_types ephemeral filter', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getTypingUsers.mockResolvedValue([BOB]);
    getReceiptsForRoom.mockResolvedValue({
      type: 'm.receipt',
      content: { '$e:example.com': { 'm.read': { [USER]: { ts: NOW } } } },
    });
    const filter = encodeURIComponent(
      JSON.stringify({ room: { ephemeral: { not_types: ['m.typing'] } } })
    );
    const env = createEnv();
    const { body } = await syncRequest(env, `since=s1_td0&filter=${filter}`);
    const join = (body.rooms as { join: Record<string, { ephemeral: { events: Array<{ type: string }> } }> })
      .join[ROOM];
    expect(join.ephemeral.events.map((e) => e.type)).toEqual(['m.receipt']);
  });
});

// ---------------------------------------------------------------------------
// Invited rooms
// ---------------------------------------------------------------------------

describe('GET /sync — invited rooms', () => {
  it('returns stripped invite_state without event_id / origin_server_ts', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'invite') return [INVITE_ROOM];
      return [];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.create',
        event_id: '$c:example.com',
        room_id: INVITE_ROOM,
        state_key: '',
        content: { creator: BOB },
        sender: BOB,
      }),
      makePdu({
        type: 'm.room.member',
        event_id: '$inv:example.com',
        room_id: INVITE_ROOM,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env);
    const invite = (body.rooms as { invite: Record<string, { invite_state: { events: unknown[] } }> })
      .invite[INVITE_ROOM];
    expect(getRoomState).toHaveBeenCalledWith(env.DB, INVITE_ROOM);
    expect(invite.invite_state.events).toEqual([
      {
        type: 'm.room.create',
        state_key: '',
        content: { creator: BOB },
        sender: BOB,
      },
      {
        type: 'm.room.member',
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      },
    ]);
  });

  it('applies room.state filter to invite_state', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'invite') return [INVITE_ROOM];
      return [];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.create',
        event_id: '$c:example.com',
        room_id: INVITE_ROOM,
        state_key: '',
        content: {},
        sender: BOB,
      }),
      makePdu({
        type: 'm.room.member',
        event_id: '$inv:example.com',
        room_id: INVITE_ROOM,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ room: { state: { types: ['m.room.member'] } } })
    );
    const env = createEnv();
    const { body } = await syncRequest(env, `filter=${filter}`);
    const invite = (body.rooms as { invite: Record<string, { invite_state: { events: Array<{ type: string }> } }> })
      .invite[INVITE_ROOM];
    expect(invite.invite_state.events.map((e) => e.type)).toEqual(['m.room.member']);
  });

  it('excludes invite rooms via not_rooms', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'invite') return [INVITE_ROOM, ROOM2];
      return [];
    });
    getRoomState.mockResolvedValue([]);
    const filter = encodeURIComponent(JSON.stringify({ room: { not_rooms: [INVITE_ROOM] } }));
    const env = createEnv();
    const { body } = await syncRequest(env, `filter=${filter}`);
    expect(Object.keys((body.rooms as { invite: object }).invite)).toEqual([ROOM2]);
  });
});

// ---------------------------------------------------------------------------
// Left rooms
// ---------------------------------------------------------------------------

describe('GET /sync — left rooms', () => {
  it('includes leave rooms with membership leave event since last sync (no filter)', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'leave') return [LEFT_ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: '$leave:example.com',
        room_id: LEFT_ROOM,
        state_key: USER,
        content: { membership: 'leave' },
        sender: USER,
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$noise:example.com',
        room_id: LEFT_ROOM,
        content: { body: 'ignore' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s8_td0');
    const leave = (body.rooms as { leave: Record<string, { timeline: { events: unknown[] } }> })
      .leave[LEFT_ROOM];
    expect(leave.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.member',
        state_key: USER,
        event_id: '$leave:example.com',
        content: { membership: 'leave' },
      }),
    ]);
  });

  it('omits leave room when no leave membership event for the user is found', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'leave') return [LEFT_ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: '$other:example.com',
        room_id: LEFT_ROOM,
        state_key: BOB,
        content: { membership: 'leave' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s8_td0');
    expect((body.rooms as { leave: object }).leave).toEqual({});
  });

  it('skips leave rooms when filter.room.include_leave is false', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'leave') return [LEFT_ROOM];
      return [];
    });
    const filter = encodeURIComponent(JSON.stringify({ room: { include_leave: false } }));
    const env = createEnv();
    const { body } = await syncRequest(env, `since=s8_td0&filter=${filter}`);
    expect(getUserRooms.mock.calls.some((c) => c[2] === 'leave')).toBe(false);
    expect((body.rooms as { leave: object }).leave).toEqual({});
  });

  it('includes leave rooms when filter.room.include_leave is true', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'leave') return [LEFT_ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: '$leave2:example.com',
        room_id: LEFT_ROOM,
        state_key: USER,
        content: { membership: 'leave' },
      }),
    ]);
    const filter = encodeURIComponent(JSON.stringify({ room: { include_leave: true } }));
    const env = createEnv();
    const { body } = await syncRequest(env, `since=s8_td0&filter=${filter}`);
    expect(Object.keys((body.rooms as { leave: object }).leave)).toEqual([LEFT_ROOM]);
  });

  it('respects room whitelist for leave rooms', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'leave') return [LEFT_ROOM, ROOM2];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: '$l:example.com',
        state_key: USER,
        content: { membership: 'leave' },
      }),
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ room: { include_leave: true, rooms: [ROOM2] } })
    );
    const env = createEnv();
    const { body } = await syncRequest(env, `since=s8_td0&filter=${filter}`);
    expect(Object.keys((body.rooms as { leave: object }).leave)).toEqual([ROOM2]);
  });
});

// ---------------------------------------------------------------------------
// Filter loading (inline JSON + KV)
// ---------------------------------------------------------------------------

describe('GET /sync — filter loading', () => {
  it('loads filter by id from CACHE KV', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM, ROOM2];
      return [];
    });
    const cache = mockKv({
      [`filter:${USER}:fid1`]: JSON.stringify({ room: { rooms: [ROOM] } }),
    });
    const env = createEnv({ cache });
    const { body } = await syncRequest(env, 'filter=fid1');
    expect(Object.keys((body.rooms as { join: object }).join)).toEqual([ROOM]);
  });

  it('ignores missing filter id and syncs unfiltered', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM, ROOM2];
      return [];
    });
    const env = createEnv({ cache: mockKv() });
    const { body } = await syncRequest(env, 'filter=missing-id');
    expect(Object.keys((body.rooms as { join: object }).join).sort()).toEqual(
      [ROOM, ROOM2].sort()
    );
  });

  it('ignores invalid inline JSON filter', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${encodeURIComponent('{not-json')}`);
    expect(status).toBe(200);
    expect((body.rooms as { join: object }).join[ROOM]).toBeDefined();
  });

  it('ignores stored filter JSON that fails to parse', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM, ROOM2];
      return [];
    });
    const cache = mockKv({ [`filter:${USER}:bad`]: '{broken' });
    const env = createEnv({ cache });
    const { body } = await syncRequest(env, 'filter=bad');
    expect(Object.keys((body.rooms as { join: object }).join).sort()).toEqual(
      [ROOM, ROOM2].sort()
    );
  });

  it('parses inline filter JSON starting with {', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: {} },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { not_types: ['m.push_rules'] } })
    );
    const env = createEnv();
    const { body } = await syncRequest(env, `filter=${filter}`);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: {} }],
    });
  });

  it('applies sender whitelist on timeline via inline filter', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$1:example.com', sender: USER, content: { body: 'me' } }),
      makePdu({ type: 'm.room.message', event_id: '$2:example.com', sender: BOB, content: { body: 'bob' } }),
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ room: { timeline: { senders: [BOB] } } })
    );
    const env = createEnv();
    const { body } = await syncRequest(env, `since=s1_td0&filter=${filter}`);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ sender: string }> } }> })
      .join[ROOM];
    expect(join.timeline.events.map((e) => e.sender)).toEqual([BOB]);
  });

  it('applies limit on timeline filter', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$1:example.com', content: { body: '1' } }),
      makePdu({ type: 'm.room.message', event_id: '$2:example.com', content: { body: '2' } }),
      makePdu({ type: 'm.room.message', event_id: '$3:example.com', content: { body: '3' } }),
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ room: { timeline: { limit: 2 } } })
    );
    const env = createEnv();
    const { body } = await syncRequest(env, `since=s1_td0&filter=${filter}`);
    const join = (body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
    expect(join.timeline.events).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Long-poll / SYNC Durable Object wait
// ---------------------------------------------------------------------------

describe('GET /sync — timeout / SYNC DO long-poll', () => {
  it('enters DO wait when no changes, timeout>0, and sincePosition>0', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s10_td0&timeout=5000');

    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(1);
    expect(syncDo.fetches[0].url).toContain('/wait-for-events');
    expect(syncDo.fetches[0].method).toBe('POST');
    expect(syncDo.fetches[0].body).toEqual({ timeout: 5000 });
    expect(body.next_batch).toBe('s42_td0');
  });

  it('caps DO wait timeout at 25000 even when client asks for 30000', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    await syncRequest(env, 'since=s10_td0&timeout=60000');
    // query timeout clamped to 30000 first, then waitTimeout min(30000, 25000)=25000
    expect(syncDo.fetches[0].body).toEqual({ timeout: 25000 });
  });

  it('still returns 200 when DO reports hasEvents true', async () => {
    const syncDo = createSyncDoStub({ hasEvents: true });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s10_td0&timeout=1000');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(1);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.next_batch).toBe('s42_td0');
  });

  it('skips DO wait when timeout is 0', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    await syncRequest(env, 'since=s10_td0&timeout=0');
    expect(syncDo.fetches).toHaveLength(0);
  });

  it('skips DO wait on initial sync even with timeout', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    await syncRequest(env, 'timeout=10000');
    expect(syncDo.fetches).toHaveLength(0);
  });

  it('skips DO wait when joined room has timeline changes', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$m:example.com', content: { body: 'x' } }),
    ]);
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    await syncRequest(env, 'since=s10_td0&timeout=5000');
    expect(syncDo.fetches).toHaveLength(0);
  });

  it('skips DO wait when invites are present', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'invite') return [INVITE_ROOM];
      return [];
    });
    getRoomState.mockResolvedValue([]);
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    await syncRequest(env, 'since=s10_td0&timeout=5000');
    expect(syncDo.fetches).toHaveLength(0);
  });

  it('skips DO wait when to-device events exist', async () => {
    getToDeviceMessages.mockResolvedValue({
      events: [{ type: 'm.room_key', content: {}, sender: BOB }],
      nextBatch: '12',
    });
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    await syncRequest(env, 'since=s10_td0&timeout=5000');
    expect(syncDo.fetches).toHaveLength(0);
  });

  it('skips DO wait when global account_data changed', async () => {
    getGlobalAccountData.mockResolvedValue([{ type: 'm.direct', content: {} }]);
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    await syncRequest(env, 'since=s10_td0&timeout=5000');
    expect(syncDo.fetches).toHaveLength(0);
  });

  it('skips DO wait when leave rooms are present', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'leave') return [LEFT_ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: '$l:example.com',
        room_id: LEFT_ROOM,
        state_key: USER,
        content: { membership: 'leave' },
      }),
    ]);
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    await syncRequest(env, 'since=s10_td0&timeout=5000');
    expect(syncDo.fetches).toHaveLength(0);
  });

  it('treats invalid timeout as NaN → no wait (timeout falsy path)', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    await syncRequest(env, 'since=s10_td0&timeout=abc');
    expect(syncDo.fetches).toHaveLength(0);
  });

  it('uses SYNC.idFromName(userId) for the wait stub', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const names: string[] = [];
    const env = createEnv({ syncDo });
    (env as { SYNC: { idFromName: (n: string) => unknown; get: () => SyncDoStub } }).SYNC = {
      idFromName: (name: string) => {
        names.push(name);
        return { name, toString: () => name };
      },
      get: () => syncDo,
    };
    await syncRequest(env, 'since=s3_td0&timeout=100');
    expect(names).toEqual([USER]);
  });
});

// ---------------------------------------------------------------------------
// hasChanges edge: empty join room with only empty timeline/state
// ---------------------------------------------------------------------------

describe('GET /sync — hasChanges detection edges', () => {
  it('treats joined room with empty timeline+state as no room changes (may DO wait)', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([]);
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    await syncRequest(env, 'since=s10_td0&timeout=1000');
    expect(syncDo.fetches).toHaveLength(1);
  });

  it('counts state-only join room as hasChanges (skips DO wait)', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.topic',
        event_id: '$t:example.com',
        state_key: '',
        content: { topic: 'x' },
      }),
    ]);
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    await syncRequest(env, 'since=s10_td0&timeout=1000');
    expect(syncDo.fetches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unsigned / client event shaping
// ---------------------------------------------------------------------------

describe('GET /sync — client event shaping', () => {
  it('forwards unsigned on timeline events from getEventsSince', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$u:example.com',
        content: { body: 'x', msgtype: 'm.text' },
        unsigned: { age: 12, transaction_id: 'txn' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s1_td0');
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ unsigned?: unknown }> } }> })
      .join[ROOM];
    expect(join.timeline.events[0].unsigned).toEqual({ age: 12, transaction_id: 'txn' });
  });

  it('omits unsigned from full-state getRoomState mapping', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.name',
        event_id: '$n:example.com',
        state_key: '',
        content: { name: 'N' },
        unsigned: { age: 1 },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env); // initial → full state
    const join = (body.rooms as { join: Record<string, { state: { events: Array<Record<string, unknown>> } }> })
      .join[ROOM];
    expect(join.state.events[0]).toEqual({
      type: 'm.room.name',
      state_key: '',
      content: { name: 'N' },
      sender: USER,
      origin_server_ts: NOW,
      event_id: '$n:example.com',
      room_id: ROOM,
    });
    expect(join.state.events[0].unsigned).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Combined realistic scenarios
// ---------------------------------------------------------------------------

describe('GET /sync — combined scenarios', () => {
  it('initial sync: rooms + account data + OTKs + self device_lists', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      if (membership === 'invite') return [INVITE_ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$hello:example.com',
        content: { body: 'hello', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockImplementation(async (_db, roomId: string) => {
      if (roomId === ROOM) {
        return [
          makePdu({
            type: 'm.room.create',
            event_id: '$create:example.com',
            state_key: '',
            content: { creator: USER },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.member',
          event_id: '$inv:example.com',
          room_id: INVITE_ROOM,
          state_key: USER,
          content: { membership: 'invite' },
          sender: BOB,
        }),
      ];
    });
    getGlobalAccountData.mockResolvedValue([{ type: 'm.push_rules', content: { global: {} } }]);
    getRoomAccountData.mockResolvedValue([
      { type: 'm.tag', content: { tags: { 'm.favourite': {} } } },
    ]);
    getTypingUsers.mockResolvedValue([BOB]);
    getToDeviceMessages.mockResolvedValue({
      events: [{ type: 'm.room_key_request', content: { action: 'request' }, sender: BOB }],
      nextBatch: '3',
    });
    getLatestStreamPosition.mockResolvedValue(99);

    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 50 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const env = createEnv({ db });
    const { status, body } = await syncRequest(env);

    expect(status).toBe(200);
    expect(body.next_batch).toBe('s99_td3');
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
    expect(body.device_one_time_keys_count).toEqual({ signed_curve25519: 50 });
    expect((body.account_data as { events: unknown[] }).events).toHaveLength(1);
    expect(Object.keys((body.rooms as { join: object }).join)).toEqual([ROOM]);
    expect(Object.keys((body.rooms as { invite: object }).invite)).toEqual([INVITE_ROOM]);
    expect((body.to_device as { events: unknown[] }).events).toHaveLength(1);
  });

  it('incremental sync: filters rooms, leaves, device list peers', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM, ROOM2];
      if (membership === 'leave') return [LEFT_ROOM];
      return [];
    });
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === ROOM) {
        return [makePdu({ type: 'm.room.message', event_id: '$m:example.com', content: { body: 'x' } })];
      }
      if (roomId === LEFT_ROOM) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: '$leave:example.com',
            room_id: LEFT_ROOM,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [];
    });
    getLatestStreamPosition.mockResolvedValue(200);

    const filter = encodeURIComponent(
      JSON.stringify({
        room: {
          rooms: [ROOM, LEFT_ROOM],
          include_leave: true,
          timeline: { types: ['m.room.message'] },
        },
      })
    );
    const env = createEnv({
      db: createSyncDb({
        deviceKeyChanges: [
          { user_id: BOB, stream_position: 150 },
          { user_id: USER, stream_position: 160 },
        ],
        sharedRoomUsers: [BOB],
      }),
    });
    const { body } = await syncRequest(env, `since=s100_td5&filter=${filter}`);

    expect(body.next_batch).toBe('s200_td5');
    expect(Object.keys((body.rooms as { join: object }).join)).toEqual([ROOM]);
    expect(Object.keys((body.rooms as { leave: object }).leave)).toEqual([LEFT_ROOM]);
    expect(body.device_lists).toEqual({ changed: [BOB, USER], left: [] });
  });

  it('wildcard timeline types filter across joined room events', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$1:example.com', content: {} }),
      makePdu({ type: 'm.room.encrypted', event_id: '$2:example.com', content: {} }),
      makePdu({ type: 'm.reaction', event_id: '$3:example.com', content: {} }),
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ room: { timeline: { types: ['m.room.*'] } } })
    );
    const env = createEnv();
    const { body } = await syncRequest(env, `since=s1_td0&filter=${filter}`);
    const types = (
      body.rooms as { join: Record<string, { timeline: { events: Array<{ type: string }> } }> }
    ).join[ROOM].timeline.events.map((e) => e.type);
    expect(types).toEqual(['m.room.message', 'm.room.encrypted']);
  });
});

// ---------------------------------------------------------------------------
// Query param edges
// ---------------------------------------------------------------------------

describe('GET /sync — query parameter edges', () => {
  it('accepts empty query string', async () => {
    const { status } = await syncRequest(createEnv(), '');
    expect(status).toBe(200);
  });

  it('accepts full_state without since', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    const env = createEnv();
    await syncRequest(env, 'full_state=true');
    expect(getRoomState).toHaveBeenCalled();
  });

  it('treats full_state=1 as not true (strict === \"true\")', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=1');
    expect(getRoomState).not.toHaveBeenCalled();
  });

  it('handles very large composite token numbers', async () => {
    getLatestStreamPosition.mockResolvedValue(999999);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '888888' });
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s123456_td654321');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '654321');
    expect(body.next_batch).toBe('s999999_td888888');
  });

  it('does not treat s10 as composite without _td segment (falls to NaN→0)', async () => {
    getLatestStreamPosition.mockResolvedValue(1);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s10');
    // parseInt('s10') is NaN → zeros → initial device_lists path
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
    expect(body.next_batch).toBe('s1_td0');
  });
});

// ---------------------------------------------------------------------------
// Presence stub always empty (current implementation)
// ---------------------------------------------------------------------------

describe('GET /sync — presence section', () => {
  it('always returns empty presence.events (not yet wired)', async () => {
    const { body } = await syncRequest(createEnv());
    expect(body.presence).toEqual({ events: [] });
  });
});

// ---------------------------------------------------------------------------
// Extra leave / invite / join matrix edges
// ---------------------------------------------------------------------------

describe('GET /sync — membership matrix extras', () => {
  it('can return join + invite + leave in one incremental response', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      if (membership === 'invite') return [INVITE_ROOM];
      if (membership === 'leave') return [LEFT_ROOM];
      return [];
    });
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === ROOM) {
        return [makePdu({ type: 'm.room.message', event_id: '$j:example.com', content: { body: 'j' } })];
      }
      if (roomId === LEFT_ROOM) {
        return [
          makePdu({
            type: 'm.room.member',
            event_id: '$l:example.com',
            room_id: LEFT_ROOM,
            state_key: USER,
            content: { membership: 'leave' },
          }),
        ];
      }
      return [];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: '$i:example.com',
        room_id: INVITE_ROOM,
        state_key: USER,
        content: { membership: 'invite' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s4_td0');
    const rooms = body.rooms as {
      join: object;
      invite: object;
      leave: object;
    };
    expect(Object.keys(rooms.join)).toEqual([ROOM]);
    expect(Object.keys(rooms.invite)).toEqual([INVITE_ROOM]);
    expect(Object.keys(rooms.leave)).toEqual([LEFT_ROOM]);
  });

  it('leave path does not run when since is legacy 0', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'leave') return [LEFT_ROOM];
      return [];
    });
    const env = createEnv();
    await syncRequest(env, 'since=0');
    expect(getUserRooms.mock.calls.some((c) => c[2] === 'leave')).toBe(false);
  });

  it('invite state_key nullish becomes empty string via state_key!', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'invite') return [INVITE_ROOM];
      return [];
    });
    getRoomState.mockResolvedValue([
      {
        ...makePdu({
          type: 'm.room.create',
          event_id: '$c:example.com',
          room_id: INVITE_ROOM,
          content: { creator: BOB },
          sender: BOB,
        }),
        state_key: undefined,
      },
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env);
    const ev = (
      body.rooms as { invite: Record<string, { invite_state: { events: Array<{ state_key: unknown }> } }> }
    ).invite[INVITE_ROOM].invite_state.events[0];
    // non-null assertion on undefined yields undefined at runtime in JS
    expect(ev.state_key).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Device lists left always empty (current implementation)
// ---------------------------------------------------------------------------

describe('GET /sync — device_lists.left', () => {
  it('always returns left: [] when device_lists is present', async () => {
    const env = createEnv({
      db: createSyncDb({
        deviceKeyChanges: [{ user_id: BOB, stream_position: 99 }],
        sharedRoomUsers: [BOB],
      }),
    });
    const { body } = await syncRequest(env, 'since=s1_td0');
    expect((body.device_lists as { left: unknown[] }).left).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Account data filter wildcards on route path
// ---------------------------------------------------------------------------

describe('GET /sync — account_data filter wildcards', () => {
  it('filters global account_data with types wildcard', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: {} },
      { type: 'm.push_rules', content: {} },
      { type: 'org.matrix.msc1234', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.*'] } })
    );
    const env = createEnv();
    const { body } = await syncRequest(env, `filter=${filter}`);
    expect((body.account_data as { events: Array<{ type: string }> }).events.map((e) => e.type)).toEqual([
      'm.direct',
      'm.push_rules',
    ]);
  });

  it('filters global account_data with not_senders (events without sender pass)', async () => {
    // applyEventFilter checks event.sender; account data events typically lack sender
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { not_senders: [BOB] } })
    );
    const env = createEnv();
    const { body } = await syncRequest(env, `filter=${filter}`);
    // sender undefined → not in not_senders → kept
    expect((body.account_data as { events: unknown[] }).events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Stress: many rooms
// ---------------------------------------------------------------------------

describe('GET /sync — multi-room scale edges', () => {
  it('iterates many joined rooms and calls helpers per room', async () => {
    const rooms = Array.from({ length: 12 }, (_, i) => `!r${i}:example.com`);
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return rooms;
      return [];
    });
    getEventsSince.mockResolvedValue([]);
    const env = createEnv();
    await syncRequest(env, 'since=s2_td0');
    expect(getEventsSince).toHaveBeenCalledTimes(12);
    expect(getReceiptsForRoom).toHaveBeenCalledTimes(12);
    expect(getTypingUsers).toHaveBeenCalledTimes(12);
    expect(getRoomAccountData).toHaveBeenCalledTimes(12);
  });

  it('room whitelist of one among many only builds that join entry', async () => {
    const rooms = Array.from({ length: 8 }, (_, i) => `!r${i}:example.com`);
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return rooms;
      return [];
    });
    const target = '!r3:example.com';
    const filter = encodeURIComponent(JSON.stringify({ room: { rooms: [target] } }));
    const env = createEnv();
    const { body } = await syncRequest(env, `filter=${filter}`);
    expect(Object.keys((body.rooms as { join: object }).join)).toEqual([target]);
    expect(getEventsSince).toHaveBeenCalledTimes(1);
    expect(getEventsSince).toHaveBeenCalledWith(env.DB, target, 0);
  });
});

// ---------------------------------------------------------------------------
// More filter / token / ephemeral leftovers
// ---------------------------------------------------------------------------

describe('GET /sync — leftover filter and token edges after helpers suite', () => {
  it('applies not_senders on timeline events', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$1:example.com', sender: USER, content: { body: 'a' } }),
      makePdu({ type: 'm.room.message', event_id: '$2:example.com', sender: BOB, content: { body: 'b' } }),
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ room: { timeline: { not_senders: [USER] } } })
    );
    const env = createEnv();
    const { body } = await syncRequest(env, `since=s1_td0&filter=${filter}`);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ sender: string }> } }> })
      .join[ROOM];
    expect(join.timeline.events.map((e) => e.sender)).toEqual([BOB]);
  });

  it('applies not_types wildcard on timeline', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$1:example.com', content: {} }),
      makePdu({ type: 'm.reaction', event_id: '$2:example.com', content: {} }),
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ room: { timeline: { not_types: ['m.room.*'] } } })
    );
    const env = createEnv();
    const { body } = await syncRequest(env, `since=s1_td0&filter=${filter}`);
    const types = (
      body.rooms as { join: Record<string, { timeline: { events: Array<{ type: string }> } }> }
    ).join[ROOM].timeline.events.map((e) => e.type);
    expect(types).toEqual(['m.reaction']);
  });

  it('empty rooms whitelist in filter means unrestricted (include all)', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM, ROOM2];
      return [];
    });
    const filter = encodeURIComponent(JSON.stringify({ room: { rooms: [] } }));
    const env = createEnv();
    const { body } = await syncRequest(env, `filter=${filter}`);
    expect(Object.keys((body.rooms as { join: object }).join).sort()).toEqual(
      [ROOM, ROOM2].sort()
    );
  });

  it('empty not_rooms blacklist means unrestricted', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    const filter = encodeURIComponent(JSON.stringify({ room: { not_rooms: [] } }));
    const env = createEnv();
    const { body } = await syncRequest(env, `filter=${filter}`);
    expect((body.rooms as { join: object }).join[ROOM]).toBeDefined();
  });

  it('timeline limit 0 is ignored (non-positive)', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({ type: 'm.room.message', event_id: '$1:example.com', content: {} }),
      makePdu({ type: 'm.room.message', event_id: '$2:example.com', content: {} }),
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ room: { timeline: { limit: 0 } } })
    );
    const env = createEnv();
    const { body } = await syncRequest(env, `since=s1_td0&filter=${filter}`);
    const join = (body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
    expect(join.timeline.events).toHaveLength(2);
  });

  it('parses since with leading zeros in composite form', async () => {
    getLatestStreamPosition.mockResolvedValue(5);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '09' });
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s08_td09');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '9');
    expect(body.next_batch).toBe('s5_td9');
  });

  it('legacy since with trailing junk: parseInt accepts prefix digits', async () => {
    // parseInt('12abc') === 12 — both streams use 12
    getLatestStreamPosition.mockResolvedValue(30);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '12' });
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=12abc');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '12');
    expect(body.next_batch).toBe('s30_td12');
    expect(body.device_lists).toBeUndefined(); // sincePosition 12 > 0, no key changes
  });
});

describe('GET /sync — room account_data since + empty join scaffolding', () => {
  it('still emits join entry with empty arrays when room has no events', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s9_td0');
    expect((body.rooms as { join: Record<string, unknown> }).join[ROOM]).toEqual({
      timeline: { events: [], limited: false, prev_batch: '9' },
      state: { events: [] },
      ephemeral: { events: [] },
      account_data: { events: [] },
    });
  });

  it('filters room account_data with not_types', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getRoomAccountData.mockResolvedValue([
      { type: 'm.tag', content: { tags: {} } },
      { type: 'org.example.keep', content: { k: 1 } },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ room: { account_data: { not_types: ['m.tag'] } } })
    );
    const env = createEnv();
    const { body } = await syncRequest(env, `filter=${filter}`);
    const join = (body.rooms as { join: Record<string, { account_data: { events: Array<{ type: string }> } }> })
      .join[ROOM];
    expect(join.account_data.events.map((e) => e.type)).toEqual(['org.example.keep']);
  });
});

describe('GET /sync — device_lists SQL binding edges', () => {
  it('records device_key_changes SELECT DISTINCT query args', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [{ user_id: BOB, stream_position: 50 }],
      sharedRoomUsers: [BOB],
    });
    const env = createEnv({ db });
    await syncRequest(env, 'since=s40_td0');
    const distinct = db.selects.find((s) => s.sql.includes('SELECT DISTINCT dkc.user_id'));
    expect(distinct?.args).toEqual([40, USER, USER]);
    const selfCount = db.selects.find(
      (s) => s.sql.includes('COUNT(*)') && s.sql.includes('device_key_changes')
    );
    expect(selfCount?.args).toEqual([40, USER]);
  });

  it('excludes peer not in sharedRoomUsers even with high stream_position', async () => {
    const env = createEnv({
      db: createSyncDb({
        deviceKeyChanges: [
          { user_id: '@stranger:example.com', stream_position: 999 },
          { user_id: CAROL, stream_position: 999 },
        ],
        sharedRoomUsers: [BOB], // CAROL not shared
      }),
    });
    const { body } = await syncRequest(env, 'since=s1_td0');
    expect(body.device_lists).toBeUndefined();
  });

  it('dedupes multiple change rows for the same peer user', async () => {
    const env = createEnv({
      db: createSyncDb({
        deviceKeyChanges: [
          { user_id: BOB, stream_position: 11 },
          { user_id: BOB, stream_position: 12 },
          { user_id: BOB, stream_position: 13 },
        ],
        sharedRoomUsers: [BOB],
      }),
    });
    const { body } = await syncRequest(env, 'since=s10_td0');
    expect(body.device_lists).toEqual({ changed: [BOB], left: [] });
  });
});

describe('GET /sync — timeout clamp and hasChanges logging paths', () => {
  it('clamps client timeout query to 30000 before DO wait cap', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    await syncRequest(env, 'since=s2_td0&timeout=999999');
    expect(syncDo.fetches[0].body).toEqual({ timeout: 25000 });
  });

  it('timeout=25000 uses full 25000 wait (already at DO cap)', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    await syncRequest(env, 'since=s2_td0&timeout=25000');
    expect(syncDo.fetches[0].body).toEqual({ timeout: 25000 });
  });

  it('timeout=24999 passes through unchanged to DO', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    await syncRequest(env, 'since=s2_td0&timeout=24999');
    expect(syncDo.fetches[0].body).toEqual({ timeout: 24999 });
  });

  it('negative timeout: Math.min(NaN-or-neg, 30000) — parseInt(-5)=-5, min=-5 → falsy wait skip', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    await syncRequest(env, 'since=s2_td0&timeout=-5');
    // Math.min(-5, 30000) = -5; (-5 > 0) is false → no DO wait
    expect(syncDo.fetches).toHaveLength(0);
  });
});

describe('GET /sync — invite + join room filter interaction', () => {
  it('same rooms whitelist applies to both join and invite sections', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM, ROOM2];
      if (membership === 'invite') return [INVITE_ROOM, ROOM2];
      return [];
    });
    getRoomState.mockResolvedValue([]);
    const filter = encodeURIComponent(JSON.stringify({ room: { rooms: [ROOM2] } }));
    const env = createEnv();
    const { body } = await syncRequest(env, `filter=${filter}`);
    expect(Object.keys((body.rooms as { join: object }).join)).toEqual([ROOM2]);
    expect(Object.keys((body.rooms as { invite: object }).invite)).toEqual([ROOM2]);
  });

  it('not_rooms removes room from invite even if join still included', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      if (membership === 'invite') return [INVITE_ROOM];
      return [];
    });
    getRoomState.mockResolvedValue([]);
    const filter = encodeURIComponent(JSON.stringify({ room: { not_rooms: [INVITE_ROOM] } }));
    const env = createEnv();
    const { body } = await syncRequest(env, `filter=${filter}`);
    expect(Object.keys((body.rooms as { join: object }).join)).toEqual([ROOM]);
    expect((body.rooms as { invite: object }).invite).toEqual({});
  });
});

describe('GET /sync — full_state incremental with timeline state overlap', () => {
  it('merges full state with newer timeline state without duplicating event_ids', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    const pl = makePdu({
      type: 'm.room.power_levels',
      event_id: '$pl:example.com',
      state_key: '',
      content: { users: { [USER]: 100 } },
    });
    const name = makePdu({
      type: 'm.room.name',
      event_id: '$name:example.com',
      state_key: '',
      content: { name: 'Updated' },
    });
    getEventsSince.mockResolvedValue([name]);
    getRoomState.mockResolvedValue([pl, name]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s10_td0&full_state=true');
    const ids = (
      body.rooms as { join: Record<string, { state: { events: Array<{ event_id: string }> } }> }
    ).join[ROOM].state.events.map((e) => e.event_id).sort();
    expect(ids).toEqual(['$name:example.com', '$pl:example.com']);
  });

  it('state filter still applies after full_state merge', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.create',
        event_id: '$c:example.com',
        state_key: '',
        content: { creator: USER },
      }),
      makePdu({
        type: 'm.room.name',
        event_id: '$n:example.com',
        state_key: '',
        content: { name: 'X' },
      }),
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ room: { state: { types: ['m.room.name'] } } })
    );
    const env = createEnv();
    const { body } = await syncRequest(env, `since=s10_td0&full_state=true&filter=${filter}`);
    const types = (
      body.rooms as { join: Record<string, { state: { events: Array<{ type: string }> } }> }
    ).join[ROOM].state.events.map((e) => e.type);
    expect(types).toEqual(['m.room.name']);
  });
});

describe('GET /sync — to-device + OTK together on incremental', () => {
  it('returns to-device events alongside OTK counts without device_lists when unchanged', async () => {
    getToDeviceMessages.mockResolvedValue({
      events: [
        { type: 'm.room_key_request', content: { action: 'request_cancellation' }, sender: BOB },
        { type: 'm.room_key', content: { session_id: 's1' }, sender: BOB },
      ],
      nextBatch: '77',
    });
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 10 }],
      fallbackAlgos: [],
      deviceKeyChanges: [],
    });
    const env = createEnv({ db });
    const { body } = await syncRequest(env, 'since=s50_td40');
    expect((body.to_device as { events: unknown[] }).events).toHaveLength(2);
    expect(body.device_one_time_keys_count).toEqual({ signed_curve25519: 10 });
    expect(body.device_unused_fallback_key_types).toEqual([]);
    expect(body.device_lists).toBeUndefined();
    expect(body.next_batch).toBe('s42_td77');
  });
});

describe('GET /sync — leave event content shaping', () => {
  it('leave timeline event includes room_id and origin_server_ts', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'leave') return [LEFT_ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: '$leave:example.com',
        room_id: LEFT_ROOM,
        state_key: USER,
        content: { membership: 'leave', reason: 'bye' },
        sender: USER,
        origin_server_ts: NOW + 5,
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s1_td0');
    const ev = (
      body.rooms as { leave: Record<string, { timeline: { events: Array<Record<string, unknown>> } }> }
    ).leave[LEFT_ROOM].timeline.events[0];
    expect(ev).toEqual({
      type: 'm.room.member',
      state_key: USER,
      content: { membership: 'leave', reason: 'bye' },
      sender: USER,
      origin_server_ts: NOW + 5,
      event_id: '$leave:example.com',
      room_id: LEFT_ROOM,
    });
  });

  it('picks the first matching leave membership event (find)', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'leave') return [LEFT_ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: '$first:example.com',
        room_id: LEFT_ROOM,
        state_key: USER,
        content: { membership: 'leave' },
      }),
      makePdu({
        type: 'm.room.member',
        event_id: '$second:example.com',
        room_id: LEFT_ROOM,
        state_key: USER,
        content: { membership: 'leave' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s1_td0');
    const evs = (
      body.rooms as { leave: Record<string, { timeline: { events: Array<{ event_id: string }> } }> }
    ).leave[LEFT_ROOM].timeline.events;
    expect(evs).toHaveLength(1);
    expect(evs[0].event_id).toBe('$first:example.com');
  });
});

describe('GET /sync — ephemeral empty typing skipped', () => {
  it('does not push m.typing when typing user list is empty', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getTypingUsers.mockResolvedValue([]);
    getReceiptsForRoom.mockResolvedValue({
      type: 'm.receipt',
      content: { '$e:example.com': { 'm.read': { [BOB]: { ts: NOW } } } },
    });
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s1_td0');
    const types = (
      body.rooms as { join: Record<string, { ephemeral: { events: Array<{ type: string }> } }> }
    ).join[ROOM].ephemeral.events.map((e) => e.type);
    expect(types).toEqual(['m.receipt']);
  });
});

describe('GET /sync — KV filter keyed per user', () => {
  it('looks up filter:${userId}:${filterId} exactly', async () => {
    const cache = mockKv({
      [`filter:${BOB}:fid1`]: JSON.stringify({ room: { rooms: [ROOM] } }),
      [`filter:${USER}:fid1`]: JSON.stringify({ room: { rooms: [ROOM2] } }),
    });
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM, ROOM2];
      return [];
    });
    const env = createEnv({ cache });
    const { body } = await syncRequest(env, 'filter=fid1');
    expect(Object.keys((body.rooms as { join: object }).join)).toEqual([ROOM2]);
  });
});
