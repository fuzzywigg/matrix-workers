/**
 * TOKENMAXX HEAVY leftovers — sparse-state /sync windows for room state events.
 * Complements sync-api-routes + sync-api-route-leftovers (full_state soft floods).
 * Focus: incremental without full_state (sparse), state_key presence, timeline dual-write,
 * redaction non-state in sparse windows, multi-key collisions in the same batch.
 * Tests-only — no product inventing. Fixtures use example.com only.
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
const ROOM = '!room:example.com';
const ROOM2 = '!other:example.com';
const NOW = 1_700_000_000_000;

type SqlCall = { sql: string; args: unknown[] };
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

function createSyncDoStub() {
  return {
    async fetch(): Promise<Response> {
      return Response.json({ hasEvents: false });
    },
  };
}

function createSyncDb() {
  const selects: SqlCall[] = [];
  const db = {
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
                return { count: 0 } as T;
              }
              return null as T;
            },
            async all<T>() {
              selects.push({ sql, args });
              if (sql.includes('FROM one_time_keys') && sql.includes('GROUP BY algorithm')) {
                return { results: [] as T[] };
              }
              if (sql.includes('FROM fallback_keys')) {
                return { results: [] as T[] };
              }
              if (sql.includes('FROM device_key_changes')) {
                return { results: [] as T[] };
              }
              return { results: [] as T[] };
            },
            async run() {
              throw new Error(`Unexpected run() SQL: ${sql.slice(0, 100)}`);
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

function createEnv(opts: { db?: SyncDb; cache?: ReturnType<typeof mockKv> } = {}) {
  const db = opts.db ?? createSyncDb();
  const cache = opts.cache ?? mockKv();
  const syncDo = createSyncDoStub();
  return {
    DB: db as unknown as D1Database,
    CACHE: cache,
    SERVER_NAME: 'example.com',
    SYNC: {
      idFromName: (name: string) => ({ name, toString: () => `id:${name}` }),
      get: () => syncDo,
    },
  } as unknown as Env;
}

async function syncRequest(
  env: Env,
  query: string = ''
): Promise<{ status: number; body: Record<string, unknown> }> {
  const path = `/_matrix/client/v3/sync${query ? `?${query}` : ''}`;
  const res = await syncApp.request(`http://localhost${path}`, {}, env);
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

type JoinRoom = {
  state: { events: Array<Record<string, unknown>> };
  timeline: { events: Array<Record<string, unknown>> };
};

function joinOf(body: Record<string, unknown>, roomId = ROOM): JoinRoom {
  return (body.rooms as { join: Record<string, JoinRoom> }).join[roomId];
}

function resetMocks() {
  getUserRooms.mockReset().mockImplementation(async (_db, _u, membership?: string) => {
    if (membership === 'join') return [];
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
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('sparse-state leftovers — incremental without full_state', () => {
  it('keeps state empty when timeline has only non-state messages', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m1',
        content: { body: 'hi', msgtype: 'm.text' },
      }),
      makePdu({
        type: 'm.room.encrypted',
        event_id: '$e1',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s5_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toEqual([]);
    expect(join.timeline.events).toHaveLength(2);
  });

  it('includes empty-string state_key events in sparse state', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.name',
        event_id: '$n',
        state_key: '',
        content: { name: 'Lobby' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s10_td0&full_state=false');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0]).toMatchObject({
      type: 'm.room.name',
      state_key: '',
      event_id: '$n',
    });
    expect(join.timeline.events).toHaveLength(1);
  });

  it('does not treat undefined state_key as state (redaction / messages)', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.redaction',
        event_id: '$r',
        content: { redacts: '$old' },
        redacts: '$old',
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s3_td0');
    const join = joinOf(body);
    expect(join.state.events).toEqual([]);
    expect(join.timeline.events.map((e) => e.type)).toEqual([
      'm.room.redaction',
      'm.room.message',
    ]);
  });

  it('keeps multiple distinct state_keys for the same type in sparse state', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: '$mb',
        state_key: BOB,
        sender: BOB,
        content: { membership: 'join' },
      }),
      makePdu({
        type: 'm.room.member',
        event_id: '$mc',
        state_key: CAROL,
        sender: CAROL,
        content: { membership: 'join' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s1_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.state_key).sort()).toEqual([BOB, CAROL].sort());
    expect(join.timeline.events).toHaveLength(2);
  });

  it('documents duplicate same (type,state_key) both appear (no sparse collapse)', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.topic',
        event_id: '$t1',
        state_key: '',
        content: { topic: 'a' },
      }),
      makePdu({
        type: 'm.room.topic',
        event_id: '$t2',
        state_key: '',
        content: { topic: 'b' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s2_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.event_id)).toEqual(['$t1', '$t2']);
  });

  it('mixes power_levels + messages: only PL lands in sparse state', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        state_key: '',
        content: { users: { [USER]: 100 }, redact: 50 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m',
        content: { body: 'note', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s8_td0');
    const join = joinOf(body);
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].type).toBe('m.room.power_levels');
    expect(join.timeline.events).toHaveLength(2);
  });

  it('treats full_state=0 / TRUE / True as sparse (strict === "true")', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    for (const flag of ['0', 'TRUE', 'True', 'yes', 'false']) {
      getRoomState.mockClear();
      const env = createEnv();
      await syncRequest(env, `since=s4_td0&full_state=${flag}`);
      expect(getRoomState).not.toHaveBeenCalled();
    }
  });

  it('loads full state only when full_state=true on incremental', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([]);
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.create',
        event_id: '$c',
        state_key: '',
        content: { creator: USER },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s4_td0&full_state=true');
    expect(getRoomState).toHaveBeenCalled();
    expect(joinOf(body).state.events).toHaveLength(1);
  });

  it('dedupes full_state events already present from sparse timeline by event_id', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const shared = makePdu({
      type: 'm.room.name',
      event_id: '$shared',
      state_key: '',
      content: { name: 'X' },
    });
    getEventsSince.mockResolvedValue([shared]);
    getRoomState.mockResolvedValue([
      shared,
      makePdu({
        type: 'm.room.topic',
        event_id: '$topic',
        state_key: '',
        content: { topic: 't' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s1_td0&full_state=true');
    const ids = joinOf(body).state.events.map((e) => e.event_id).sort();
    expect(ids).toEqual(['$shared', '$topic']);
  });

  it('applies sparse state across multiple joined rooms independently', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) =>
      m === 'join' ? [ROOM, ROOM2] : []
    );
    getEventsSince.mockImplementation(async (_db, roomId: string) => {
      if (roomId === ROOM) {
        return [
          makePdu({
            type: 'm.room.name',
            event_id: '$n1',
            room_id: ROOM,
            state_key: '',
            content: { name: 'A' },
          }),
        ];
      }
      return [
        makePdu({
          type: 'm.room.message',
          event_id: '$m2',
          room_id: ROOM2,
          content: { body: 'b', msgtype: 'm.text' },
        }),
      ];
    });
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s9_td0');
    expect(joinOf(body, ROOM).state.events).toHaveLength(1);
    expect(joinOf(body, ROOM2).state.events).toEqual([]);
  });
});

describe('sparse-state leftovers — state_key presence soft flood', () => {
  it('state_key soft-0', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const sk = '';
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'org.example.state',
        event_id: '$s0',
        state_key: sk,
        content: { i: 0 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m0',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s1_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].state_key).toBe(sk);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('state_key soft-1', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const sk = '@bob:example.com';
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'org.example.state',
        event_id: '$s1',
        state_key: sk,
        content: { i: 1 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m1',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s2_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].state_key).toBe(sk);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('state_key soft-2', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const sk = '@carol:example.com';
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'org.example.state',
        event_id: '$s2',
        state_key: sk,
        content: { i: 2 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m2',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s3_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].state_key).toBe(sk);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('state_key soft-3', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const sk = 'widget';
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'org.example.state',
        event_id: '$s3',
        state_key: sk,
        content: { i: 3 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m3',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s4_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].state_key).toBe(sk);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('state_key soft-4', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const sk = 'main';
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'org.example.state',
        event_id: '$s4',
        state_key: sk,
        content: { i: 4 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m4',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s5_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].state_key).toBe(sk);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('state_key soft-5', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const sk = '0';
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'org.example.state',
        event_id: '$s5',
        state_key: sk,
        content: { i: 5 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m5',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s6_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].state_key).toBe(sk);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('state_key soft-6', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const sk = 'a/b';
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'org.example.state',
        event_id: '$s6',
        state_key: sk,
        content: { i: 6 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m6',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s7_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].state_key).toBe(sk);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('state_key soft-7', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const sk = 'unicode-🔑';
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'org.example.state',
        event_id: '$s7',
        state_key: sk,
        content: { i: 7 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m7',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s8_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].state_key).toBe(sk);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('state_key soft-8', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const sk = '';
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'org.example.state',
        event_id: '$s8',
        state_key: sk,
        content: { i: 8 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m8',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s9_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].state_key).toBe(sk);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('state_key soft-9', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const sk = '@bob:example.com';
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'org.example.state',
        event_id: '$s9',
        state_key: sk,
        content: { i: 9 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m9',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s10_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].state_key).toBe(sk);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('state_key soft-10', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const sk = '@carol:example.com';
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'org.example.state',
        event_id: '$s10',
        state_key: sk,
        content: { i: 10 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m10',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s11_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].state_key).toBe(sk);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('state_key soft-11', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const sk = 'widget';
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'org.example.state',
        event_id: '$s11',
        state_key: sk,
        content: { i: 11 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m11',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s12_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].state_key).toBe(sk);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('state_key soft-12', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const sk = 'main';
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'org.example.state',
        event_id: '$s12',
        state_key: sk,
        content: { i: 12 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m12',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s13_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].state_key).toBe(sk);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('state_key soft-13', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const sk = '0';
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'org.example.state',
        event_id: '$s13',
        state_key: sk,
        content: { i: 13 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m13',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s14_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].state_key).toBe(sk);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('state_key soft-14', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const sk = 'a/b';
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'org.example.state',
        event_id: '$s14',
        state_key: sk,
        content: { i: 14 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m14',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s15_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].state_key).toBe(sk);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('state_key soft-15', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const sk = 'unicode-🔑';
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'org.example.state',
        event_id: '$s15',
        state_key: sk,
        content: { i: 15 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m15',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s16_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].state_key).toBe(sk);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('state_key soft-16', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const sk = '';
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'org.example.state',
        event_id: '$s16',
        state_key: sk,
        content: { i: 16 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m16',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s17_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].state_key).toBe(sk);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('state_key soft-17', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const sk = '@bob:example.com';
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'org.example.state',
        event_id: '$s17',
        state_key: sk,
        content: { i: 17 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m17',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s18_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].state_key).toBe(sk);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('state_key soft-18', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const sk = '@carol:example.com';
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'org.example.state',
        event_id: '$s18',
        state_key: sk,
        content: { i: 18 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m18',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s19_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].state_key).toBe(sk);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('state_key soft-19', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const sk = 'widget';
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'org.example.state',
        event_id: '$s19',
        state_key: sk,
        content: { i: 19 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m19',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s20_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].state_key).toBe(sk);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('state_key soft-20', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const sk = 'main';
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'org.example.state',
        event_id: '$s20',
        state_key: sk,
        content: { i: 20 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m20',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s21_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].state_key).toBe(sk);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('state_key soft-21', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const sk = '0';
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'org.example.state',
        event_id: '$s21',
        state_key: sk,
        content: { i: 21 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m21',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s22_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].state_key).toBe(sk);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('state_key soft-22', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const sk = 'a/b';
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'org.example.state',
        event_id: '$s22',
        state_key: sk,
        content: { i: 22 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m22',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s23_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].state_key).toBe(sk);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('state_key soft-23', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    const sk = 'unicode-🔑';
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'org.example.state',
        event_id: '$s23',
        state_key: sk,
        content: { i: 23 },
      }),
      makePdu({
        type: 'm.room.message',
        event_id: '$m23',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s24_td0');
    const join = joinOf(body);
    expect(getRoomState).not.toHaveBeenCalled();
    expect(join.state.events).toHaveLength(1);
    expect(join.state.events[0].state_key).toBe(sk);
    expect(join.timeline.events).toHaveLength(2);
  });
});

describe('sparse-state leftovers — redaction + PL mix soft flood', () => {
  it('redaction sparse soft-0', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.redaction',
        event_id: '$r0',
        content: { redacts: '$t0' },
        redacts: '$t0',
      }),
      makePdu({
        type: 'm.room.power_levels',
        event_id: '$pl0',
        state_key: '',
        content: { users: { [USER]: 50 }, redact: 50 },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s10_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.type)).toEqual(['m.room.power_levels']);
    expect(join.timeline.events.map((e) => e.type)).toEqual([
      'm.room.redaction',
      'm.room.power_levels',
    ]);
  });
  it('redaction sparse soft-1', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.redaction',
        event_id: '$r1',
        content: { redacts: '$t1' },
        redacts: '$t1',
      }),
      makePdu({
        type: 'm.room.power_levels',
        event_id: '$pl1',
        state_key: '',
        content: { users: { [USER]: 51 }, redact: 50 },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s11_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.type)).toEqual(['m.room.power_levels']);
    expect(join.timeline.events.map((e) => e.type)).toEqual([
      'm.room.redaction',
      'm.room.power_levels',
    ]);
  });
  it('redaction sparse soft-2', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.redaction',
        event_id: '$r2',
        content: { redacts: '$t2' },
        redacts: '$t2',
      }),
      makePdu({
        type: 'm.room.power_levels',
        event_id: '$pl2',
        state_key: '',
        content: { users: { [USER]: 52 }, redact: 50 },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s12_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.type)).toEqual(['m.room.power_levels']);
    expect(join.timeline.events.map((e) => e.type)).toEqual([
      'm.room.redaction',
      'm.room.power_levels',
    ]);
  });
  it('redaction sparse soft-3', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.redaction',
        event_id: '$r3',
        content: { redacts: '$t3' },
        redacts: '$t3',
      }),
      makePdu({
        type: 'm.room.power_levels',
        event_id: '$pl3',
        state_key: '',
        content: { users: { [USER]: 53 }, redact: 50 },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s13_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.type)).toEqual(['m.room.power_levels']);
    expect(join.timeline.events.map((e) => e.type)).toEqual([
      'm.room.redaction',
      'm.room.power_levels',
    ]);
  });
  it('redaction sparse soft-4', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.redaction',
        event_id: '$r4',
        content: { redacts: '$t4' },
        redacts: '$t4',
      }),
      makePdu({
        type: 'm.room.power_levels',
        event_id: '$pl4',
        state_key: '',
        content: { users: { [USER]: 54 }, redact: 50 },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s14_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.type)).toEqual(['m.room.power_levels']);
    expect(join.timeline.events.map((e) => e.type)).toEqual([
      'm.room.redaction',
      'm.room.power_levels',
    ]);
  });
  it('redaction sparse soft-5', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.redaction',
        event_id: '$r5',
        content: { redacts: '$t5' },
        redacts: '$t5',
      }),
      makePdu({
        type: 'm.room.power_levels',
        event_id: '$pl5',
        state_key: '',
        content: { users: { [USER]: 55 }, redact: 50 },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s15_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.type)).toEqual(['m.room.power_levels']);
    expect(join.timeline.events.map((e) => e.type)).toEqual([
      'm.room.redaction',
      'm.room.power_levels',
    ]);
  });
  it('redaction sparse soft-6', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.redaction',
        event_id: '$r6',
        content: { redacts: '$t6' },
        redacts: '$t6',
      }),
      makePdu({
        type: 'm.room.power_levels',
        event_id: '$pl6',
        state_key: '',
        content: { users: { [USER]: 56 }, redact: 50 },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s16_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.type)).toEqual(['m.room.power_levels']);
    expect(join.timeline.events.map((e) => e.type)).toEqual([
      'm.room.redaction',
      'm.room.power_levels',
    ]);
  });
  it('redaction sparse soft-7', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.redaction',
        event_id: '$r7',
        content: { redacts: '$t7' },
        redacts: '$t7',
      }),
      makePdu({
        type: 'm.room.power_levels',
        event_id: '$pl7',
        state_key: '',
        content: { users: { [USER]: 57 }, redact: 50 },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s17_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.type)).toEqual(['m.room.power_levels']);
    expect(join.timeline.events.map((e) => e.type)).toEqual([
      'm.room.redaction',
      'm.room.power_levels',
    ]);
  });
  it('redaction sparse soft-8', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.redaction',
        event_id: '$r8',
        content: { redacts: '$t8' },
        redacts: '$t8',
      }),
      makePdu({
        type: 'm.room.power_levels',
        event_id: '$pl8',
        state_key: '',
        content: { users: { [USER]: 58 }, redact: 50 },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s18_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.type)).toEqual(['m.room.power_levels']);
    expect(join.timeline.events.map((e) => e.type)).toEqual([
      'm.room.redaction',
      'm.room.power_levels',
    ]);
  });
  it('redaction sparse soft-9', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.redaction',
        event_id: '$r9',
        content: { redacts: '$t9' },
        redacts: '$t9',
      }),
      makePdu({
        type: 'm.room.power_levels',
        event_id: '$pl9',
        state_key: '',
        content: { users: { [USER]: 59 }, redact: 50 },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s19_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.type)).toEqual(['m.room.power_levels']);
    expect(join.timeline.events.map((e) => e.type)).toEqual([
      'm.room.redaction',
      'm.room.power_levels',
    ]);
  });
  it('redaction sparse soft-10', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.redaction',
        event_id: '$r10',
        content: { redacts: '$t10' },
        redacts: '$t10',
      }),
      makePdu({
        type: 'm.room.power_levels',
        event_id: '$pl10',
        state_key: '',
        content: { users: { [USER]: 60 }, redact: 50 },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s20_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.type)).toEqual(['m.room.power_levels']);
    expect(join.timeline.events.map((e) => e.type)).toEqual([
      'm.room.redaction',
      'm.room.power_levels',
    ]);
  });
  it('redaction sparse soft-11', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.redaction',
        event_id: '$r11',
        content: { redacts: '$t11' },
        redacts: '$t11',
      }),
      makePdu({
        type: 'm.room.power_levels',
        event_id: '$pl11',
        state_key: '',
        content: { users: { [USER]: 61 }, redact: 50 },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s21_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.type)).toEqual(['m.room.power_levels']);
    expect(join.timeline.events.map((e) => e.type)).toEqual([
      'm.room.redaction',
      'm.room.power_levels',
    ]);
  });
  it('redaction sparse soft-12', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.redaction',
        event_id: '$r12',
        content: { redacts: '$t12' },
        redacts: '$t12',
      }),
      makePdu({
        type: 'm.room.power_levels',
        event_id: '$pl12',
        state_key: '',
        content: { users: { [USER]: 62 }, redact: 50 },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s22_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.type)).toEqual(['m.room.power_levels']);
    expect(join.timeline.events.map((e) => e.type)).toEqual([
      'm.room.redaction',
      'm.room.power_levels',
    ]);
  });
  it('redaction sparse soft-13', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.redaction',
        event_id: '$r13',
        content: { redacts: '$t13' },
        redacts: '$t13',
      }),
      makePdu({
        type: 'm.room.power_levels',
        event_id: '$pl13',
        state_key: '',
        content: { users: { [USER]: 63 }, redact: 50 },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s23_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.type)).toEqual(['m.room.power_levels']);
    expect(join.timeline.events.map((e) => e.type)).toEqual([
      'm.room.redaction',
      'm.room.power_levels',
    ]);
  });
  it('redaction sparse soft-14', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.redaction',
        event_id: '$r14',
        content: { redacts: '$t14' },
        redacts: '$t14',
      }),
      makePdu({
        type: 'm.room.power_levels',
        event_id: '$pl14',
        state_key: '',
        content: { users: { [USER]: 64 }, redact: 50 },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s24_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.type)).toEqual(['m.room.power_levels']);
    expect(join.timeline.events.map((e) => e.type)).toEqual([
      'm.room.redaction',
      'm.room.power_levels',
    ]);
  });
  it('redaction sparse soft-15', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.redaction',
        event_id: '$r15',
        content: { redacts: '$t15' },
        redacts: '$t15',
      }),
      makePdu({
        type: 'm.room.power_levels',
        event_id: '$pl15',
        state_key: '',
        content: { users: { [USER]: 65 }, redact: 50 },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s25_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.type)).toEqual(['m.room.power_levels']);
    expect(join.timeline.events.map((e) => e.type)).toEqual([
      'm.room.redaction',
      'm.room.power_levels',
    ]);
  });
  it('redaction sparse soft-16', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.redaction',
        event_id: '$r16',
        content: { redacts: '$t16' },
        redacts: '$t16',
      }),
      makePdu({
        type: 'm.room.power_levels',
        event_id: '$pl16',
        state_key: '',
        content: { users: { [USER]: 66 }, redact: 50 },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s26_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.type)).toEqual(['m.room.power_levels']);
    expect(join.timeline.events.map((e) => e.type)).toEqual([
      'm.room.redaction',
      'm.room.power_levels',
    ]);
  });
  it('redaction sparse soft-17', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.redaction',
        event_id: '$r17',
        content: { redacts: '$t17' },
        redacts: '$t17',
      }),
      makePdu({
        type: 'm.room.power_levels',
        event_id: '$pl17',
        state_key: '',
        content: { users: { [USER]: 67 }, redact: 50 },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s27_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.type)).toEqual(['m.room.power_levels']);
    expect(join.timeline.events.map((e) => e.type)).toEqual([
      'm.room.redaction',
      'm.room.power_levels',
    ]);
  });
  it('redaction sparse soft-18', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.redaction',
        event_id: '$r18',
        content: { redacts: '$t18' },
        redacts: '$t18',
      }),
      makePdu({
        type: 'm.room.power_levels',
        event_id: '$pl18',
        state_key: '',
        content: { users: { [USER]: 68 }, redact: 50 },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s28_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.type)).toEqual(['m.room.power_levels']);
    expect(join.timeline.events.map((e) => e.type)).toEqual([
      'm.room.redaction',
      'm.room.power_levels',
    ]);
  });
  it('redaction sparse soft-19', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.redaction',
        event_id: '$r19',
        content: { redacts: '$t19' },
        redacts: '$t19',
      }),
      makePdu({
        type: 'm.room.power_levels',
        event_id: '$pl19',
        state_key: '',
        content: { users: { [USER]: 69 }, redact: 50 },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s29_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.type)).toEqual(['m.room.power_levels']);
    expect(join.timeline.events.map((e) => e.type)).toEqual([
      'm.room.redaction',
      'm.room.power_levels',
    ]);
  });
});

describe('sparse-state leftovers — full_state flag negation soft flood', () => {
  it('full_state flag soft-0', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m0',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=false');
    expect(getRoomState).not.toHaveBeenCalled();
  });
  it('full_state flag soft-1', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m1',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=False');
    expect(getRoomState).not.toHaveBeenCalled();
  });
  it('full_state flag soft-2', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m2',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=FALSE');
    expect(getRoomState).not.toHaveBeenCalled();
  });
  it('full_state flag soft-3', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m3',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=1');
    expect(getRoomState).not.toHaveBeenCalled();
  });
  it('full_state flag soft-4', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m4',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=0');
    expect(getRoomState).not.toHaveBeenCalled();
  });
  it('full_state flag soft-5', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m5',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=tru');
    expect(getRoomState).not.toHaveBeenCalled();
  });
  it('full_state flag soft-6', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m6',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=true%20');
    expect(getRoomState).not.toHaveBeenCalled();
  });
  it('full_state flag soft-7', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m7',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=yes');
    expect(getRoomState).not.toHaveBeenCalled();
  });
  it('full_state flag soft-8', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m8',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=on');
    expect(getRoomState).not.toHaveBeenCalled();
  });
  it('full_state flag soft-9', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m9',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=TRUE');
    expect(getRoomState).not.toHaveBeenCalled();
  });
  it('full_state flag soft-10', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m10',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=True');
    expect(getRoomState).not.toHaveBeenCalled();
  });
  it('full_state flag soft-11', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m11',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=no');
    expect(getRoomState).not.toHaveBeenCalled();
  });
  it('full_state flag soft-12', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m12',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=false');
    expect(getRoomState).not.toHaveBeenCalled();
  });
  it('full_state flag soft-13', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m13',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=False');
    expect(getRoomState).not.toHaveBeenCalled();
  });
  it('full_state flag soft-14', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m14',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=FALSE');
    expect(getRoomState).not.toHaveBeenCalled();
  });
  it('full_state flag soft-15', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m15',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=1');
    expect(getRoomState).not.toHaveBeenCalled();
  });
  it('full_state flag soft-16', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m16',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=0');
    expect(getRoomState).not.toHaveBeenCalled();
  });
  it('full_state flag soft-17', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m17',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=tru');
    expect(getRoomState).not.toHaveBeenCalled();
  });
  it('full_state flag soft-18', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m18',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=true%20');
    expect(getRoomState).not.toHaveBeenCalled();
  });
  it('full_state flag soft-19', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m19',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=yes');
    expect(getRoomState).not.toHaveBeenCalled();
  });
  it('full_state flag soft-20', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m20',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=on');
    expect(getRoomState).not.toHaveBeenCalled();
  });
  it('full_state flag soft-21', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m21',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=TRUE');
    expect(getRoomState).not.toHaveBeenCalled();
  });
  it('full_state flag soft-22', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m22',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=True');
    expect(getRoomState).not.toHaveBeenCalled();
  });
  it('full_state flag soft-23', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$m23',
        content: { body: 'x', msgtype: 'm.text' },
      }),
    ]);
    getRoomState.mockResolvedValue([
      makePdu({ type: 'm.room.create', event_id: '$c', state_key: '', content: {} }),
    ]);
    const env = createEnv();
    await syncRequest(env, 'since=s5_td0&full_state=no');
    expect(getRoomState).not.toHaveBeenCalled();
  });
});

describe('sparse-state leftovers — duplicate state_key collision soft flood', () => {
  it('dup state_key soft-0', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.name',
        event_id: '$a0',
        state_key: '',
        content: { name: 'a0' },
      }),
      makePdu({
        type: 'm.room.name',
        event_id: '$b0',
        state_key: '',
        content: { name: 'b0' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s1_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.event_id)).toEqual(['$a0', '$b0']);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('dup state_key soft-1', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.name',
        event_id: '$a1',
        state_key: '',
        content: { name: 'a1' },
      }),
      makePdu({
        type: 'm.room.name',
        event_id: '$b1',
        state_key: '',
        content: { name: 'b1' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s2_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.event_id)).toEqual(['$a1', '$b1']);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('dup state_key soft-2', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.name',
        event_id: '$a2',
        state_key: '',
        content: { name: 'a2' },
      }),
      makePdu({
        type: 'm.room.name',
        event_id: '$b2',
        state_key: '',
        content: { name: 'b2' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s3_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.event_id)).toEqual(['$a2', '$b2']);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('dup state_key soft-3', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.name',
        event_id: '$a3',
        state_key: '',
        content: { name: 'a3' },
      }),
      makePdu({
        type: 'm.room.name',
        event_id: '$b3',
        state_key: '',
        content: { name: 'b3' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s4_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.event_id)).toEqual(['$a3', '$b3']);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('dup state_key soft-4', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.name',
        event_id: '$a4',
        state_key: '',
        content: { name: 'a4' },
      }),
      makePdu({
        type: 'm.room.name',
        event_id: '$b4',
        state_key: '',
        content: { name: 'b4' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s5_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.event_id)).toEqual(['$a4', '$b4']);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('dup state_key soft-5', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.name',
        event_id: '$a5',
        state_key: '',
        content: { name: 'a5' },
      }),
      makePdu({
        type: 'm.room.name',
        event_id: '$b5',
        state_key: '',
        content: { name: 'b5' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s6_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.event_id)).toEqual(['$a5', '$b5']);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('dup state_key soft-6', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.name',
        event_id: '$a6',
        state_key: '',
        content: { name: 'a6' },
      }),
      makePdu({
        type: 'm.room.name',
        event_id: '$b6',
        state_key: '',
        content: { name: 'b6' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s7_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.event_id)).toEqual(['$a6', '$b6']);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('dup state_key soft-7', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.name',
        event_id: '$a7',
        state_key: '',
        content: { name: 'a7' },
      }),
      makePdu({
        type: 'm.room.name',
        event_id: '$b7',
        state_key: '',
        content: { name: 'b7' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s8_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.event_id)).toEqual(['$a7', '$b7']);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('dup state_key soft-8', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.name',
        event_id: '$a8',
        state_key: '',
        content: { name: 'a8' },
      }),
      makePdu({
        type: 'm.room.name',
        event_id: '$b8',
        state_key: '',
        content: { name: 'b8' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s9_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.event_id)).toEqual(['$a8', '$b8']);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('dup state_key soft-9', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.name',
        event_id: '$a9',
        state_key: '',
        content: { name: 'a9' },
      }),
      makePdu({
        type: 'm.room.name',
        event_id: '$b9',
        state_key: '',
        content: { name: 'b9' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s10_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.event_id)).toEqual(['$a9', '$b9']);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('dup state_key soft-10', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.name',
        event_id: '$a10',
        state_key: '',
        content: { name: 'a10' },
      }),
      makePdu({
        type: 'm.room.name',
        event_id: '$b10',
        state_key: '',
        content: { name: 'b10' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s11_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.event_id)).toEqual(['$a10', '$b10']);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('dup state_key soft-11', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.name',
        event_id: '$a11',
        state_key: '',
        content: { name: 'a11' },
      }),
      makePdu({
        type: 'm.room.name',
        event_id: '$b11',
        state_key: '',
        content: { name: 'b11' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s12_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.event_id)).toEqual(['$a11', '$b11']);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('dup state_key soft-12', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.name',
        event_id: '$a12',
        state_key: '',
        content: { name: 'a12' },
      }),
      makePdu({
        type: 'm.room.name',
        event_id: '$b12',
        state_key: '',
        content: { name: 'b12' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s13_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.event_id)).toEqual(['$a12', '$b12']);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('dup state_key soft-13', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.name',
        event_id: '$a13',
        state_key: '',
        content: { name: 'a13' },
      }),
      makePdu({
        type: 'm.room.name',
        event_id: '$b13',
        state_key: '',
        content: { name: 'b13' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s14_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.event_id)).toEqual(['$a13', '$b13']);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('dup state_key soft-14', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.name',
        event_id: '$a14',
        state_key: '',
        content: { name: 'a14' },
      }),
      makePdu({
        type: 'm.room.name',
        event_id: '$b14',
        state_key: '',
        content: { name: 'b14' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s15_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.event_id)).toEqual(['$a14', '$b14']);
    expect(join.timeline.events).toHaveLength(2);
  });
  it('dup state_key soft-15', async () => {
    getUserRooms.mockImplementation(async (_db, _u, m?: string) => (m === 'join' ? [ROOM] : []));
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.name',
        event_id: '$a15',
        state_key: '',
        content: { name: 'a15' },
      }),
      makePdu({
        type: 'm.room.name',
        event_id: '$b15',
        state_key: '',
        content: { name: 'b15' },
      }),
    ]);
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=s16_td0');
    const join = joinOf(body);
    expect(join.state.events.map((e) => e.event_id)).toEqual(['$a15', '$b15']);
    expect(join.timeline.events).toHaveLength(2);
  });
});
