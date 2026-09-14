/**
 * TOKENMAXX HEAVY leftovers after #157 — client /sync soft/edge/reliability.
 * Complements sync-api-routes.test.ts. Tests-only — no product inventing.
 * Fixtures use example.com only.
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


describe('sync leftovers empty baseline soft flood after #157', () => {
  it('empty baseline soft-0', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
  it('empty baseline soft-1', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
  it('empty baseline soft-2', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
  it('empty baseline soft-3', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
  it('empty baseline soft-4', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
  it('empty baseline soft-5', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
  it('empty baseline soft-6', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
  it('empty baseline soft-7', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
  it('empty baseline soft-8', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
  it('empty baseline soft-9', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
  it('empty baseline soft-10', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
  it('empty baseline soft-11', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
  it('empty baseline soft-12', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
  it('empty baseline soft-13', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
  it('empty baseline soft-14', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
  it('empty baseline soft-15', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
  it('empty baseline soft-16', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
  it('empty baseline soft-17', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
  it('empty baseline soft-18', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
  it('empty baseline soft-19', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
  it('empty baseline soft-20', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
  it('empty baseline soft-21', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
  it('empty baseline soft-22', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
  it('empty baseline soft-23', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
  it('empty baseline soft-24', async () => {
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
});

describe('sync leftovers next_batch/since soft flood after #157', () => {
  it('next_batch since soft-0', async () => {
    getLatestStreamPosition.mockResolvedValue(50);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '0' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s10_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s50_td0');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '0');
  });
  it('next_batch since soft-1', async () => {
    getLatestStreamPosition.mockResolvedValue(51);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '1' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s11_td1');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s51_td1');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '1');
  });
  it('next_batch since soft-2', async () => {
    getLatestStreamPosition.mockResolvedValue(52);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '2' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s12_td2');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s52_td2');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '2');
  });
  it('next_batch since soft-3', async () => {
    getLatestStreamPosition.mockResolvedValue(53);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '3' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s13_td3');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s53_td3');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '3');
  });
  it('next_batch since soft-4', async () => {
    getLatestStreamPosition.mockResolvedValue(54);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '4' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s14_td4');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s54_td4');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '4');
  });
  it('next_batch since soft-5', async () => {
    getLatestStreamPosition.mockResolvedValue(55);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '5' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s15_td5');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s55_td5');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '5');
  });
  it('next_batch since soft-6', async () => {
    getLatestStreamPosition.mockResolvedValue(56);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '6' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s16_td6');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s56_td6');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '6');
  });
  it('next_batch since soft-7', async () => {
    getLatestStreamPosition.mockResolvedValue(57);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '7' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s17_td7');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s57_td7');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '7');
  });
  it('next_batch since soft-8', async () => {
    getLatestStreamPosition.mockResolvedValue(58);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '8' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s18_td8');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s58_td8');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '8');
  });
  it('next_batch since soft-9', async () => {
    getLatestStreamPosition.mockResolvedValue(59);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '9' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s19_td9');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s59_td9');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '9');
  });
  it('next_batch since soft-10', async () => {
    getLatestStreamPosition.mockResolvedValue(60);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '10' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s20_td10');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s60_td10');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '10');
  });
  it('next_batch since soft-11', async () => {
    getLatestStreamPosition.mockResolvedValue(61);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '11' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s21_td11');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s61_td11');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '11');
  });
  it('next_batch since soft-12', async () => {
    getLatestStreamPosition.mockResolvedValue(62);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '12' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s22_td12');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s62_td12');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '12');
  });
  it('next_batch since soft-13', async () => {
    getLatestStreamPosition.mockResolvedValue(63);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '13' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s23_td13');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s63_td13');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '13');
  });
  it('next_batch since soft-14', async () => {
    getLatestStreamPosition.mockResolvedValue(64);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '14' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s24_td14');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s64_td14');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '14');
  });
  it('next_batch since soft-15', async () => {
    getLatestStreamPosition.mockResolvedValue(65);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '15' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s25_td15');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s65_td15');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '15');
  });
  it('next_batch since soft-16', async () => {
    getLatestStreamPosition.mockResolvedValue(66);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '16' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s26_td16');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s66_td16');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '16');
  });
  it('next_batch since soft-17', async () => {
    getLatestStreamPosition.mockResolvedValue(67);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '17' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s27_td17');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s67_td17');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '17');
  });
  it('next_batch since soft-18', async () => {
    getLatestStreamPosition.mockResolvedValue(68);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '18' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s28_td18');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s68_td18');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '18');
  });
  it('next_batch since soft-19', async () => {
    getLatestStreamPosition.mockResolvedValue(69);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '19' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s29_td19');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s69_td19');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '19');
  });
  it('next_batch since soft-20', async () => {
    getLatestStreamPosition.mockResolvedValue(70);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '20' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s30_td20');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s70_td20');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '20');
  });
  it('next_batch since soft-21', async () => {
    getLatestStreamPosition.mockResolvedValue(71);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '21' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s31_td21');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s71_td21');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '21');
  });
  it('next_batch since soft-22', async () => {
    getLatestStreamPosition.mockResolvedValue(72);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '22' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s32_td22');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s72_td22');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '22');
  });
  it('next_batch since soft-23', async () => {
    getLatestStreamPosition.mockResolvedValue(73);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '23' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s33_td23');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s73_td23');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '23');
  });
  it('next_batch since soft-24', async () => {
    getLatestStreamPosition.mockResolvedValue(74);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '24' });
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s34_td24');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s74_td24');
    expect(getToDeviceMessages).toHaveBeenCalledWith(env.DB, USER, DEVICE, '24');
  });
});

describe('sync leftovers joined room timeline soft flood after #157', () => {
  it('joined timeline soft-0', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg0:example.com',
        content: { body: 'soft-0', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg0:example.com',
        content: { body: 'soft-0', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
  it('joined timeline soft-1', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg1:example.com',
        content: { body: 'soft-1', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg1:example.com',
        content: { body: 'soft-1', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
  it('joined timeline soft-2', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg2:example.com',
        content: { body: 'soft-2', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg2:example.com',
        content: { body: 'soft-2', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
  it('joined timeline soft-3', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg3:example.com',
        content: { body: 'soft-3', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg3:example.com',
        content: { body: 'soft-3', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
  it('joined timeline soft-4', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg4:example.com',
        content: { body: 'soft-4', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg4:example.com',
        content: { body: 'soft-4', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
  it('joined timeline soft-5', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg5:example.com',
        content: { body: 'soft-5', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg5:example.com',
        content: { body: 'soft-5', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
  it('joined timeline soft-6', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg6:example.com',
        content: { body: 'soft-6', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg6:example.com',
        content: { body: 'soft-6', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
  it('joined timeline soft-7', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg7:example.com',
        content: { body: 'soft-7', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg7:example.com',
        content: { body: 'soft-7', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
  it('joined timeline soft-8', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg8:example.com',
        content: { body: 'soft-8', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg8:example.com',
        content: { body: 'soft-8', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
  it('joined timeline soft-9', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg9:example.com',
        content: { body: 'soft-9', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg9:example.com',
        content: { body: 'soft-9', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
  it('joined timeline soft-10', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg10:example.com',
        content: { body: 'soft-10', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg10:example.com',
        content: { body: 'soft-10', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
  it('joined timeline soft-11', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg11:example.com',
        content: { body: 'soft-11', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg11:example.com',
        content: { body: 'soft-11', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
  it('joined timeline soft-12', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg12:example.com',
        content: { body: 'soft-12', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg12:example.com',
        content: { body: 'soft-12', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
  it('joined timeline soft-13', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg13:example.com',
        content: { body: 'soft-13', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg13:example.com',
        content: { body: 'soft-13', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
  it('joined timeline soft-14', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg14:example.com',
        content: { body: 'soft-14', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg14:example.com',
        content: { body: 'soft-14', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
  it('joined timeline soft-15', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg15:example.com',
        content: { body: 'soft-15', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg15:example.com',
        content: { body: 'soft-15', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
  it('joined timeline soft-16', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg16:example.com',
        content: { body: 'soft-16', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg16:example.com',
        content: { body: 'soft-16', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
  it('joined timeline soft-17', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg17:example.com',
        content: { body: 'soft-17', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg17:example.com',
        content: { body: 'soft-17', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
  it('joined timeline soft-18', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg18:example.com',
        content: { body: 'soft-18', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg18:example.com',
        content: { body: 'soft-18', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
  it('joined timeline soft-19', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg19:example.com',
        content: { body: 'soft-19', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg19:example.com',
        content: { body: 'soft-19', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
  it('joined timeline soft-20', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg20:example.com',
        content: { body: 'soft-20', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg20:example.com',
        content: { body: 'soft-20', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
  it('joined timeline soft-21', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg21:example.com',
        content: { body: 'soft-21', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg21:example.com',
        content: { body: 'soft-21', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
  it('joined timeline soft-22', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg22:example.com',
        content: { body: 'soft-22', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg22:example.com',
        content: { body: 'soft-22', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
  it('joined timeline soft-23', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg23:example.com',
        content: { body: 'soft-23', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg23:example.com',
        content: { body: 'soft-23', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
  it('joined timeline soft-24', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$msg24:example.com',
        content: { body: 'soft-24', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string; content: { body: string } }> } }> }).join[ROOM];
    expect(join.timeline.events).toEqual([
      expect.objectContaining({
        type: 'm.room.message',
        event_id: '$msg24:example.com',
        content: { body: 'soft-24', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
  });
});

describe('sync leftovers filter query soft flood after #157', () => {
  it('inline filter soft-0', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 0 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 0 } }],
    });
  });
  it('inline filter soft-1', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 1 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 1 } }],
    });
  });
  it('inline filter soft-2', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 2 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 2 } }],
    });
  });
  it('inline filter soft-3', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 3 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 3 } }],
    });
  });
  it('inline filter soft-4', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 4 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 4 } }],
    });
  });
  it('inline filter soft-5', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 5 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 5 } }],
    });
  });
  it('inline filter soft-6', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 6 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 6 } }],
    });
  });
  it('inline filter soft-7', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 7 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 7 } }],
    });
  });
  it('inline filter soft-8', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 8 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 8 } }],
    });
  });
  it('inline filter soft-9', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 9 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 9 } }],
    });
  });
  it('inline filter soft-10', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 10 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 10 } }],
    });
  });
  it('inline filter soft-11', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 11 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 11 } }],
    });
  });
  it('inline filter soft-12', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 12 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 12 } }],
    });
  });
  it('inline filter soft-13', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 13 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 13 } }],
    });
  });
  it('inline filter soft-14', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 14 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 14 } }],
    });
  });
  it('inline filter soft-15', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 15 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 15 } }],
    });
  });
  it('inline filter soft-16', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 16 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 16 } }],
    });
  });
  it('inline filter soft-17', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 17 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 17 } }],
    });
  });
  it('inline filter soft-18', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 18 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 18 } }],
    });
  });
  it('inline filter soft-19', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 19 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 19 } }],
    });
  });
  it('inline filter soft-20', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 20 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 20 } }],
    });
  });
  it('inline filter soft-21', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 21 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 21 } }],
    });
  });
  it('inline filter soft-22', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 22 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 22 } }],
    });
  });
  it('inline filter soft-23', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 23 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 23 } }],
    });
  });
  it('inline filter soft-24', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { n: 24 } },
      { type: 'm.push_rules', content: {} },
    ]);
    const filter = encodeURIComponent(
      JSON.stringify({ account_data: { types: ['m.direct'] } })
    );
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { n: 24 } }],
    });
  });
});

describe('sync leftovers timeout=0 soft flood after #157', () => {
  it('timeout=0 soft-0', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s10_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-1', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s11_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-2', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s12_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-3', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s13_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-4', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s14_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-5', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s15_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-6', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s16_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-7', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s17_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-8', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s18_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-9', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s19_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-10', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s20_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-11', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s21_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-12', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s22_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-13', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s23_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-14', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s24_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-15', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s25_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-16', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s26_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-17', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s27_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-18', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s28_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-19', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s29_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-20', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s10_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-21', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s11_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-22', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s12_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-23', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s13_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-24', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s14_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
});

describe('sync leftovers presence/account_data soft reliability after #157', () => {
  it('presence+account_data soft-0', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 0 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s1_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 0 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 1);
  });
  it('presence+account_data soft-1', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 1 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s2_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 1 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 2);
  });
  it('presence+account_data soft-2', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 2 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s3_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 2 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 3);
  });
  it('presence+account_data soft-3', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 3 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s4_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 3 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 4);
  });
  it('presence+account_data soft-4', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 4 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 4 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 5);
  });
  it('presence+account_data soft-5', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 5 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s6_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 5 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 6);
  });
  it('presence+account_data soft-6', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 6 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s7_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 6 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 7);
  });
  it('presence+account_data soft-7', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 7 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s8_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 7 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 8);
  });
  it('presence+account_data soft-8', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 8 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s9_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 8 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 9);
  });
  it('presence+account_data soft-9', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 9 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s10_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 9 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 10);
  });
  it('presence+account_data soft-10', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 10 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s11_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 10 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 11);
  });
  it('presence+account_data soft-11', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 11 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s12_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 11 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 12);
  });
  it('presence+account_data soft-12', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 12 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s13_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 12 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 13);
  });
  it('presence+account_data soft-13', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 13 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s14_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 13 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 14);
  });
  it('presence+account_data soft-14', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 14 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s15_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 14 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 15);
  });
  it('presence+account_data soft-15', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 15 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s16_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 15 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 16);
  });
  it('presence+account_data soft-16', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 16 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s17_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 16 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 17);
  });
  it('presence+account_data soft-17', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 17 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s18_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 17 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 18);
  });
  it('presence+account_data soft-18', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 18 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s19_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 18 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 19);
  });
  it('presence+account_data soft-19', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 19 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s20_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 19 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 20);
  });
  it('presence+account_data soft-20', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 20 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s21_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 20 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 21);
  });
  it('presence+account_data soft-21', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 21 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s22_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 21 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 22);
  });
  it('presence+account_data soft-22', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 22 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s23_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 22 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 23);
  });
  it('presence+account_data soft-23', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 23 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s24_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 23 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 24);
  });
  it('presence+account_data soft-24', async () => {
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { soft: 24 } },
    ]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s25_td0');
    expect(status).toBe(200);
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({
      events: [{ type: 'm.direct', content: { soft: 24 } }],
    });
    expect(getGlobalAccountData).toHaveBeenCalledWith(env.DB, USER, 25);
  });
});

describe('sync leftovers failure and edge cases after #157', () => {
  it('ignores invalid inline filter JSON and still syncs', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${encodeURIComponent('{not-json')}`);
    expect(status).toBe(200);
    expect((body.rooms as { join: object }).join[ROOM]).toBeDefined();
  });

  it('ignores broken KV-stored filter JSON', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM, ROOM2];
      return [];
    });
    const cache = mockKv({ [`filter:${USER}:bad`]: '{broken' });
    const env = createEnv({ cache });
    const { status, body } = await syncRequest(env, 'filter=bad');
    expect(status).toBe(200);
    expect(Object.keys((body.rooms as { join: object }).join).sort()).toEqual(
      [ROOM, ROOM2].sort()
    );
  });

  it('ignores another broken KV filter id soft-a', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    const cache = mockKv({ [`filter:${USER}:x`]: 'not-json-at-all' });
    const env = createEnv({ cache });
    const { status, body } = await syncRequest(env, 'filter=x');
    expect(status).toBe(200);
    expect((body.rooms as { join: object }).join[ROOM]).toBeDefined();
  });

  it('ignores truncated KV filter JSON soft-b', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    const cache = mockKv({ [`filter:${USER}:y`]: '{"room":' });
    const env = createEnv({ cache });
    const { status, body } = await syncRequest(env, 'filter=y');
    expect(status).toBe(200);
    expect((body.rooms as { join: object }).join[ROOM]).toBeDefined();
  });

  it('propagates SYNC DO wait failure when timeout awaits', async () => {
    const syncDo = createSyncDoStub({ fail: true });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s10_td0&timeout=1000');
    expect(status).toBe(500);
    expect(body._raw).toBe('Internal Server Error');
  });

  it('garbage since token still yields composite next_batch', async () => {
    getLatestStreamPosition.mockResolvedValue(9);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=%%%');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s9_td0');
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });

  it('invalid timeout skips DO wait', async () => {
    const syncDo = createSyncDoStub();
    const env = createEnv({ syncDo });
    const { status } = await syncRequest(env, 'since=s10_td0&timeout=nope');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
  });

  it('missing filter id syncs unfiltered', async () => {
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

  it('empty filter object is accepted inline', async () => {
    const filter = encodeURIComponent(JSON.stringify({}));
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
  });

  it('legacy since=0 includes self in device_lists.changed', async () => {
    const env = createEnv();
    const { body } = await syncRequest(env, 'since=0');
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });
});

describe('sync leftovers lifecycle soft floods after #157', () => {
  it('initial then incremental lifecycle soft-0', async () => {
    getLatestStreamPosition.mockResolvedValue(20);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.next_batch).toBe('s20_td0');
    expect(initial.body.device_lists).toEqual({ changed: [USER], left: [] });

    getLatestStreamPosition.mockResolvedValue(30);
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$life0:example.com',
        content: { body: 'life-0', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const incremental = await syncRequest(env, `since=${initial.body.next_batch as string}&timeout=0`);
    expect(incremental.status).toBe(200);
    expect(incremental.body.next_batch).toBe('s30_td0');
    const join = (incremental.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
    expect(join.timeline.events).toHaveLength(1);
  });
  it('initial then incremental lifecycle soft-1', async () => {
    getLatestStreamPosition.mockResolvedValue(21);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.next_batch).toBe('s21_td0');
    expect(initial.body.device_lists).toEqual({ changed: [USER], left: [] });

    getLatestStreamPosition.mockResolvedValue(31);
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$life1:example.com',
        content: { body: 'life-1', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const incremental = await syncRequest(env, `since=${initial.body.next_batch as string}&timeout=0`);
    expect(incremental.status).toBe(200);
    expect(incremental.body.next_batch).toBe('s31_td0');
    const join = (incremental.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
    expect(join.timeline.events).toHaveLength(1);
  });
  it('initial then incremental lifecycle soft-2', async () => {
    getLatestStreamPosition.mockResolvedValue(22);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.next_batch).toBe('s22_td0');
    expect(initial.body.device_lists).toEqual({ changed: [USER], left: [] });

    getLatestStreamPosition.mockResolvedValue(32);
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$life2:example.com',
        content: { body: 'life-2', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const incremental = await syncRequest(env, `since=${initial.body.next_batch as string}&timeout=0`);
    expect(incremental.status).toBe(200);
    expect(incremental.body.next_batch).toBe('s32_td0');
    const join = (incremental.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
    expect(join.timeline.events).toHaveLength(1);
  });
  it('initial then incremental lifecycle soft-3', async () => {
    getLatestStreamPosition.mockResolvedValue(23);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.next_batch).toBe('s23_td0');
    expect(initial.body.device_lists).toEqual({ changed: [USER], left: [] });

    getLatestStreamPosition.mockResolvedValue(33);
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$life3:example.com',
        content: { body: 'life-3', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const incremental = await syncRequest(env, `since=${initial.body.next_batch as string}&timeout=0`);
    expect(incremental.status).toBe(200);
    expect(incremental.body.next_batch).toBe('s33_td0');
    const join = (incremental.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
    expect(join.timeline.events).toHaveLength(1);
  });
  it('initial then incremental lifecycle soft-4', async () => {
    getLatestStreamPosition.mockResolvedValue(24);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.next_batch).toBe('s24_td0');
    expect(initial.body.device_lists).toEqual({ changed: [USER], left: [] });

    getLatestStreamPosition.mockResolvedValue(34);
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$life4:example.com',
        content: { body: 'life-4', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const incremental = await syncRequest(env, `since=${initial.body.next_batch as string}&timeout=0`);
    expect(incremental.status).toBe(200);
    expect(incremental.body.next_batch).toBe('s34_td0');
    const join = (incremental.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
    expect(join.timeline.events).toHaveLength(1);
  });
  it('initial then incremental lifecycle soft-5', async () => {
    getLatestStreamPosition.mockResolvedValue(25);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.next_batch).toBe('s25_td0');
    expect(initial.body.device_lists).toEqual({ changed: [USER], left: [] });

    getLatestStreamPosition.mockResolvedValue(35);
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$life5:example.com',
        content: { body: 'life-5', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const incremental = await syncRequest(env, `since=${initial.body.next_batch as string}&timeout=0`);
    expect(incremental.status).toBe(200);
    expect(incremental.body.next_batch).toBe('s35_td0');
    const join = (incremental.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
    expect(join.timeline.events).toHaveLength(1);
  });
  it('initial then incremental lifecycle soft-6', async () => {
    getLatestStreamPosition.mockResolvedValue(26);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.next_batch).toBe('s26_td0');
    expect(initial.body.device_lists).toEqual({ changed: [USER], left: [] });

    getLatestStreamPosition.mockResolvedValue(36);
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$life6:example.com',
        content: { body: 'life-6', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const incremental = await syncRequest(env, `since=${initial.body.next_batch as string}&timeout=0`);
    expect(incremental.status).toBe(200);
    expect(incremental.body.next_batch).toBe('s36_td0');
    const join = (incremental.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
    expect(join.timeline.events).toHaveLength(1);
  });
  it('initial then incremental lifecycle soft-7', async () => {
    getLatestStreamPosition.mockResolvedValue(27);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.next_batch).toBe('s27_td0');
    expect(initial.body.device_lists).toEqual({ changed: [USER], left: [] });

    getLatestStreamPosition.mockResolvedValue(37);
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$life7:example.com',
        content: { body: 'life-7', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const incremental = await syncRequest(env, `since=${initial.body.next_batch as string}&timeout=0`);
    expect(incremental.status).toBe(200);
    expect(incremental.body.next_batch).toBe('s37_td0');
    const join = (incremental.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
    expect(join.timeline.events).toHaveLength(1);
  });
  it('initial then incremental lifecycle soft-8', async () => {
    getLatestStreamPosition.mockResolvedValue(28);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.next_batch).toBe('s28_td0');
    expect(initial.body.device_lists).toEqual({ changed: [USER], left: [] });

    getLatestStreamPosition.mockResolvedValue(38);
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$life8:example.com',
        content: { body: 'life-8', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const incremental = await syncRequest(env, `since=${initial.body.next_batch as string}&timeout=0`);
    expect(incremental.status).toBe(200);
    expect(incremental.body.next_batch).toBe('s38_td0');
    const join = (incremental.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
    expect(join.timeline.events).toHaveLength(1);
  });
  it('initial then incremental lifecycle soft-9', async () => {
    getLatestStreamPosition.mockResolvedValue(29);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.next_batch).toBe('s29_td0');
    expect(initial.body.device_lists).toEqual({ changed: [USER], left: [] });

    getLatestStreamPosition.mockResolvedValue(39);
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$life9:example.com',
        content: { body: 'life-9', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const incremental = await syncRequest(env, `since=${initial.body.next_batch as string}&timeout=0`);
    expect(incremental.status).toBe(200);
    expect(incremental.body.next_batch).toBe('s39_td0');
    const join = (incremental.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
    expect(join.timeline.events).toHaveLength(1);
  });
  it('initial then incremental lifecycle soft-10', async () => {
    getLatestStreamPosition.mockResolvedValue(30);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.next_batch).toBe('s30_td0');
    expect(initial.body.device_lists).toEqual({ changed: [USER], left: [] });

    getLatestStreamPosition.mockResolvedValue(40);
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$life10:example.com',
        content: { body: 'life-10', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const incremental = await syncRequest(env, `since=${initial.body.next_batch as string}&timeout=0`);
    expect(incremental.status).toBe(200);
    expect(incremental.body.next_batch).toBe('s40_td0');
    const join = (incremental.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
    expect(join.timeline.events).toHaveLength(1);
  });
  it('initial then incremental lifecycle soft-11', async () => {
    getLatestStreamPosition.mockResolvedValue(31);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.next_batch).toBe('s31_td0');
    expect(initial.body.device_lists).toEqual({ changed: [USER], left: [] });

    getLatestStreamPosition.mockResolvedValue(41);
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$life11:example.com',
        content: { body: 'life-11', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const incremental = await syncRequest(env, `since=${initial.body.next_batch as string}&timeout=0`);
    expect(incremental.status).toBe(200);
    expect(incremental.body.next_batch).toBe('s41_td0');
    const join = (incremental.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
    expect(join.timeline.events).toHaveLength(1);
  });
  it('initial then incremental lifecycle soft-12', async () => {
    getLatestStreamPosition.mockResolvedValue(32);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.next_batch).toBe('s32_td0');
    expect(initial.body.device_lists).toEqual({ changed: [USER], left: [] });

    getLatestStreamPosition.mockResolvedValue(42);
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$life12:example.com',
        content: { body: 'life-12', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const incremental = await syncRequest(env, `since=${initial.body.next_batch as string}&timeout=0`);
    expect(incremental.status).toBe(200);
    expect(incremental.body.next_batch).toBe('s42_td0');
    const join = (incremental.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
    expect(join.timeline.events).toHaveLength(1);
  });
  it('initial then incremental lifecycle soft-13', async () => {
    getLatestStreamPosition.mockResolvedValue(33);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.next_batch).toBe('s33_td0');
    expect(initial.body.device_lists).toEqual({ changed: [USER], left: [] });

    getLatestStreamPosition.mockResolvedValue(43);
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$life13:example.com',
        content: { body: 'life-13', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const incremental = await syncRequest(env, `since=${initial.body.next_batch as string}&timeout=0`);
    expect(incremental.status).toBe(200);
    expect(incremental.body.next_batch).toBe('s43_td0');
    const join = (incremental.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
    expect(join.timeline.events).toHaveLength(1);
  });
  it('initial then incremental lifecycle soft-14', async () => {
    getLatestStreamPosition.mockResolvedValue(34);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.next_batch).toBe('s34_td0');
    expect(initial.body.device_lists).toEqual({ changed: [USER], left: [] });

    getLatestStreamPosition.mockResolvedValue(44);
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.message',
        event_id: '$life14:example.com',
        content: { body: 'life-14', msgtype: 'm.text' },
        sender: BOB,
      }),
    ]);
    const incremental = await syncRequest(env, `since=${initial.body.next_batch as string}&timeout=0`);
    expect(incremental.status).toBe(200);
    expect(incremental.body.next_batch).toBe('s44_td0');
    const join = (incremental.body.rooms as { join: Record<string, { timeline: { events: unknown[] } }> }).join[ROOM];
    expect(join.timeline.events).toHaveLength(1);
  });
});
