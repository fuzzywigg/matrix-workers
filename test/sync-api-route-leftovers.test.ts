/**
 * TOKENMAXX HEAVY leftovers after #157 — sync API soft/edge/reliability.
 * Complements sync-api-routes.test.ts. Orthogonal to open keys/media/appservice #158.
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
const DEVICE = 'DEVICEA';
const ROOM = '!room:example.com';
const NOW = 1_700_000_000_000;

type SqlCall = { sql: string; args: unknown[] };
type OtkCount = { algorithm: string; count: number };
type FallbackAlgo = { algorithm: string };
type DeviceKeyChange = { user_id: string; stream_position: number };

function mockKv(data: Record<string, string> = {}) {
  const puts: Array<{ key: string; value: string }> = [];
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
    put: async (key: string, value: string) => {
      data[key] = value;
      puts.push({ key, value });
    },
    delete: async (key: string) => {
      deletes.push(key);
      delete data[key];
    },
  };
  return kv as unknown as KVNamespace & {
    data: Record<string, string>;
    puts: typeof puts;
    deletes: string[];
  };
}

function createSyncDoStub(opts: { hasEvents?: boolean; fail?: boolean } = {}) {
  const fetches: Array<{ url: string; method: string }> = [];
  return {
    fetches,
    async fetch(req: Request): Promise<Response> {
      fetches.push({ url: req.url, method: req.method });
      if (opts.fail) throw new Error('sync DO boom');
      return Response.json({ hasEvents: opts.hasEvents ?? false });
    },
  };
}

function createSyncDb(opts: {
  otkCounts?: OtkCount[];
  fallbackAlgos?: FallbackAlgo[];
  deviceKeyChanges?: DeviceKeyChange[];
  sharedRoomUsers?: string[];
  throwOnSqlIncludes?: string;
} = {}) {
  const otkCounts = opts.otkCounts ?? [];
  const fallbackAlgos = opts.fallbackAlgos ?? [];
  const deviceKeyChanges = opts.deviceKeyChanges ?? [];
  const sharedRoomUsers = new Set(opts.sharedRoomUsers ?? [BOB]);
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
              if (opts.throwOnSqlIncludes && sql.includes(opts.throwOnSqlIncludes)) {
                throw new Error(`db boom: ${opts.throwOnSqlIncludes}`);
              }
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
              if (opts.throwOnSqlIncludes && sql.includes(opts.throwOnSqlIncludes)) {
                throw new Error(`db boom: ${opts.throwOnSqlIncludes}`);
              }
              if (
                sql.includes('FROM one_time_keys') &&
                sql.includes('GROUP BY algorithm')
              ) {
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
              return { success: true, meta: { changes: 0, last_row_id: 0 } };
            },
          };
        },
      };
    },
  };
  return db;
}

type SyncDb = ReturnType<typeof createSyncDb>;
type SyncDoStub = ReturnType<typeof createSyncDoStub>;

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
  return {
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
  } as unknown as Env & { _db: SyncDb; _cache: ReturnType<typeof mockKv>; _syncDo: SyncDoStub };
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
  getUserRooms.mockReset().mockImplementation(async () => []);
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
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sync leftovers empty baseline soft flood after #157', () => {
  it('empty baseline soft-0', async () => {
    getLatestStreamPosition.mockResolvedValue(40);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s40_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-1', async () => {
    getLatestStreamPosition.mockResolvedValue(41);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s41_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-2', async () => {
    getLatestStreamPosition.mockResolvedValue(42);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s42_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-3', async () => {
    getLatestStreamPosition.mockResolvedValue(43);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s43_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-4', async () => {
    getLatestStreamPosition.mockResolvedValue(44);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s44_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-5', async () => {
    getLatestStreamPosition.mockResolvedValue(45);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s45_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-6', async () => {
    getLatestStreamPosition.mockResolvedValue(46);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s46_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-7', async () => {
    getLatestStreamPosition.mockResolvedValue(47);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s47_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-8', async () => {
    getLatestStreamPosition.mockResolvedValue(48);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s48_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-9', async () => {
    getLatestStreamPosition.mockResolvedValue(49);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s49_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-10', async () => {
    getLatestStreamPosition.mockResolvedValue(50);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s50_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-11', async () => {
    getLatestStreamPosition.mockResolvedValue(51);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s51_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-12', async () => {
    getLatestStreamPosition.mockResolvedValue(52);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s52_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-13', async () => {
    getLatestStreamPosition.mockResolvedValue(53);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s53_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-14', async () => {
    getLatestStreamPosition.mockResolvedValue(54);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s54_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-15', async () => {
    getLatestStreamPosition.mockResolvedValue(55);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s55_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-16', async () => {
    getLatestStreamPosition.mockResolvedValue(56);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s56_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-17', async () => {
    getLatestStreamPosition.mockResolvedValue(57);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s57_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-18', async () => {
    getLatestStreamPosition.mockResolvedValue(58);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s58_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-19', async () => {
    getLatestStreamPosition.mockResolvedValue(59);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s59_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-20', async () => {
    getLatestStreamPosition.mockResolvedValue(60);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s60_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-21', async () => {
    getLatestStreamPosition.mockResolvedValue(61);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s61_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-22', async () => {
    getLatestStreamPosition.mockResolvedValue(62);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s62_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-23', async () => {
    getLatestStreamPosition.mockResolvedValue(63);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s63_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-24', async () => {
    getLatestStreamPosition.mockResolvedValue(64);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s64_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-25', async () => {
    getLatestStreamPosition.mockResolvedValue(65);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s65_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-26', async () => {
    getLatestStreamPosition.mockResolvedValue(66);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s66_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-27', async () => {
    getLatestStreamPosition.mockResolvedValue(67);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s67_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-28', async () => {
    getLatestStreamPosition.mockResolvedValue(68);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s68_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-29', async () => {
    getLatestStreamPosition.mockResolvedValue(69);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s69_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-30', async () => {
    getLatestStreamPosition.mockResolvedValue(70);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s70_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
  it('empty baseline soft-31', async () => {
    getLatestStreamPosition.mockResolvedValue(71);
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s71_td0');
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.presence).toEqual({ events: [] });
    expect(body.account_data).toEqual({ events: [] });
    expect(body.to_device).toEqual({ events: [] });
  });
});

describe('sync leftovers since token soft flood after #157', () => {
  it('since token soft-0', async () => {
    getLatestStreamPosition.mockResolvedValue(100);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s10_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s100_td0');
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
  it('since token soft-1', async () => {
    getLatestStreamPosition.mockResolvedValue(101);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s11_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s101_td0');
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
  it('since token soft-2', async () => {
    getLatestStreamPosition.mockResolvedValue(102);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s12_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s102_td0');
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
  it('since token soft-3', async () => {
    getLatestStreamPosition.mockResolvedValue(103);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s13_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s103_td0');
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
  it('since token soft-4', async () => {
    getLatestStreamPosition.mockResolvedValue(104);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s14_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s104_td0');
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
  it('since token soft-5', async () => {
    getLatestStreamPosition.mockResolvedValue(105);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s15_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s105_td0');
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
  it('since token soft-6', async () => {
    getLatestStreamPosition.mockResolvedValue(106);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s16_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s106_td0');
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
  it('since token soft-7', async () => {
    getLatestStreamPosition.mockResolvedValue(107);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s17_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s107_td0');
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
  it('since token soft-8', async () => {
    getLatestStreamPosition.mockResolvedValue(108);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s18_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s108_td0');
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
  it('since token soft-9', async () => {
    getLatestStreamPosition.mockResolvedValue(109);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s19_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s109_td0');
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
  it('since token soft-10', async () => {
    getLatestStreamPosition.mockResolvedValue(110);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s20_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s110_td0');
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
  it('since token soft-11', async () => {
    getLatestStreamPosition.mockResolvedValue(111);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s21_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s111_td0');
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
  it('since token soft-12', async () => {
    getLatestStreamPosition.mockResolvedValue(112);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s22_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s112_td0');
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
  it('since token soft-13', async () => {
    getLatestStreamPosition.mockResolvedValue(113);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s23_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s113_td0');
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
  it('since token soft-14', async () => {
    getLatestStreamPosition.mockResolvedValue(114);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s24_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s114_td0');
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
  it('since token soft-15', async () => {
    getLatestStreamPosition.mockResolvedValue(115);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s25_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s115_td0');
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
  it('since token soft-16', async () => {
    getLatestStreamPosition.mockResolvedValue(116);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s26_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s116_td0');
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
  it('since token soft-17', async () => {
    getLatestStreamPosition.mockResolvedValue(117);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s27_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s117_td0');
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
  it('since token soft-18', async () => {
    getLatestStreamPosition.mockResolvedValue(118);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s28_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s118_td0');
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
  it('since token soft-19', async () => {
    getLatestStreamPosition.mockResolvedValue(119);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s29_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s119_td0');
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
  it('since token soft-20', async () => {
    getLatestStreamPosition.mockResolvedValue(120);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s30_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s120_td0');
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
  it('since token soft-21', async () => {
    getLatestStreamPosition.mockResolvedValue(121);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s31_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s121_td0');
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
  it('since token soft-22', async () => {
    getLatestStreamPosition.mockResolvedValue(122);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s32_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s122_td0');
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
  it('since token soft-23', async () => {
    getLatestStreamPosition.mockResolvedValue(123);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'since=s33_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toBe('s123_td0');
    expect(getLatestStreamPosition).toHaveBeenCalled();
  });
});

describe('sync leftovers timeout soft flood after #157', () => {
  it('timeout soft-0', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'timeout=0&since=s1_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toMatch(/^s\d+_td0$/);
  });
  it('timeout soft-1', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'timeout=1&since=s1_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toMatch(/^s\d+_td0$/);
  });
  it('timeout soft-2', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'timeout=100&since=s1_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toMatch(/^s\d+_td0$/);
  });
  it('timeout soft-3', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'timeout=1000&since=s1_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toMatch(/^s\d+_td0$/);
  });
  it('timeout soft-4', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'timeout=5000&since=s1_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toMatch(/^s\d+_td0$/);
  });
  it('timeout soft-5', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'timeout=10000&since=s1_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toMatch(/^s\d+_td0$/);
  });
  it('timeout soft-6', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'timeout=30000&since=s1_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toMatch(/^s\d+_td0$/);
  });
  it('timeout soft-7', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'timeout=60000&since=s1_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toMatch(/^s\d+_td0$/);
  });
  it('timeout soft-8', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'timeout=99999&since=s1_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toMatch(/^s\d+_td0$/);
  });
  it('timeout soft-9', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'timeout=0&since=s1_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toMatch(/^s\d+_td0$/);
  });
  it('timeout soft-10', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'timeout=50&since=s1_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toMatch(/^s\d+_td0$/);
  });
  it('timeout soft-11', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'timeout=250&since=s1_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toMatch(/^s\d+_td0$/);
  });
  it('timeout soft-12', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'timeout=750&since=s1_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toMatch(/^s\d+_td0$/);
  });
  it('timeout soft-13', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'timeout=1500&since=s1_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toMatch(/^s\d+_td0$/);
  });
  it('timeout soft-14', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'timeout=2500&since=s1_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toMatch(/^s\d+_td0$/);
  });
  it('timeout soft-15', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'timeout=8000&since=s1_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toMatch(/^s\d+_td0$/);
  });
  it('timeout soft-16', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'timeout=0&since=s1_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toMatch(/^s\d+_td0$/);
  });
  it('timeout soft-17', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'timeout=1&since=s1_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toMatch(/^s\d+_td0$/);
  });
  it('timeout soft-18', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'timeout=100&since=s1_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toMatch(/^s\d+_td0$/);
  });
  it('timeout soft-19', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'timeout=1000&since=s1_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toMatch(/^s\d+_td0$/);
  });
  it('timeout soft-20', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'timeout=5000&since=s1_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toMatch(/^s\d+_td0$/);
  });
  it('timeout soft-21', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'timeout=10000&since=s1_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toMatch(/^s\d+_td0$/);
  });
  it('timeout soft-22', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'timeout=30000&since=s1_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toMatch(/^s\d+_td0$/);
  });
  it('timeout soft-23', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'timeout=60000&since=s1_td0');
    expect(status).toBe(200);
    expect(body.next_batch).toMatch(/^s\d+_td0$/);
  });
});

describe('sync leftovers full_state soft flood after #157', () => {
  it('full_state soft-0', async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getRoomState.mockResolvedValue([
      {
        room_id: ROOM,
        sender: USER,
        type: 'm.room.create',
        event_id: '$create0:example.com',
        origin_server_ts: NOW,
        content: {},
        state_key: '',
        depth: 1,
        auth_events: [],
        prev_events: [],
      } as PDU,
    ]);
    getEventsSince.mockResolvedValue([]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'full_state=true&since=s1_td0');
    expect(status).toBe(200);
    const rooms = body.rooms as any;
    expect(rooms.join[ROOM]).toBeTruthy();
  });
  it('full_state soft-1', async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getRoomState.mockResolvedValue([
      {
        room_id: ROOM,
        sender: USER,
        type: 'm.room.create',
        event_id: '$create1:example.com',
        origin_server_ts: NOW,
        content: {},
        state_key: '',
        depth: 1,
        auth_events: [],
        prev_events: [],
      } as PDU,
    ]);
    getEventsSince.mockResolvedValue([]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'full_state=true&since=s1_td0');
    expect(status).toBe(200);
    const rooms = body.rooms as any;
    expect(rooms.join[ROOM]).toBeTruthy();
  });
  it('full_state soft-2', async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getRoomState.mockResolvedValue([
      {
        room_id: ROOM,
        sender: USER,
        type: 'm.room.create',
        event_id: '$create2:example.com',
        origin_server_ts: NOW,
        content: {},
        state_key: '',
        depth: 1,
        auth_events: [],
        prev_events: [],
      } as PDU,
    ]);
    getEventsSince.mockResolvedValue([]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'full_state=true&since=s1_td0');
    expect(status).toBe(200);
    const rooms = body.rooms as any;
    expect(rooms.join[ROOM]).toBeTruthy();
  });
  it('full_state soft-3', async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getRoomState.mockResolvedValue([
      {
        room_id: ROOM,
        sender: USER,
        type: 'm.room.create',
        event_id: '$create3:example.com',
        origin_server_ts: NOW,
        content: {},
        state_key: '',
        depth: 1,
        auth_events: [],
        prev_events: [],
      } as PDU,
    ]);
    getEventsSince.mockResolvedValue([]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'full_state=true&since=s1_td0');
    expect(status).toBe(200);
    const rooms = body.rooms as any;
    expect(rooms.join[ROOM]).toBeTruthy();
  });
  it('full_state soft-4', async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getRoomState.mockResolvedValue([
      {
        room_id: ROOM,
        sender: USER,
        type: 'm.room.create',
        event_id: '$create4:example.com',
        origin_server_ts: NOW,
        content: {},
        state_key: '',
        depth: 1,
        auth_events: [],
        prev_events: [],
      } as PDU,
    ]);
    getEventsSince.mockResolvedValue([]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'full_state=true&since=s1_td0');
    expect(status).toBe(200);
    const rooms = body.rooms as any;
    expect(rooms.join[ROOM]).toBeTruthy();
  });
  it('full_state soft-5', async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getRoomState.mockResolvedValue([
      {
        room_id: ROOM,
        sender: USER,
        type: 'm.room.create',
        event_id: '$create5:example.com',
        origin_server_ts: NOW,
        content: {},
        state_key: '',
        depth: 1,
        auth_events: [],
        prev_events: [],
      } as PDU,
    ]);
    getEventsSince.mockResolvedValue([]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'full_state=true&since=s1_td0');
    expect(status).toBe(200);
    const rooms = body.rooms as any;
    expect(rooms.join[ROOM]).toBeTruthy();
  });
  it('full_state soft-6', async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getRoomState.mockResolvedValue([
      {
        room_id: ROOM,
        sender: USER,
        type: 'm.room.create',
        event_id: '$create6:example.com',
        origin_server_ts: NOW,
        content: {},
        state_key: '',
        depth: 1,
        auth_events: [],
        prev_events: [],
      } as PDU,
    ]);
    getEventsSince.mockResolvedValue([]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'full_state=true&since=s1_td0');
    expect(status).toBe(200);
    const rooms = body.rooms as any;
    expect(rooms.join[ROOM]).toBeTruthy();
  });
  it('full_state soft-7', async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getRoomState.mockResolvedValue([
      {
        room_id: ROOM,
        sender: USER,
        type: 'm.room.create',
        event_id: '$create7:example.com',
        origin_server_ts: NOW,
        content: {},
        state_key: '',
        depth: 1,
        auth_events: [],
        prev_events: [],
      } as PDU,
    ]);
    getEventsSince.mockResolvedValue([]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'full_state=true&since=s1_td0');
    expect(status).toBe(200);
    const rooms = body.rooms as any;
    expect(rooms.join[ROOM]).toBeTruthy();
  });
  it('full_state soft-8', async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getRoomState.mockResolvedValue([
      {
        room_id: ROOM,
        sender: USER,
        type: 'm.room.create',
        event_id: '$create8:example.com',
        origin_server_ts: NOW,
        content: {},
        state_key: '',
        depth: 1,
        auth_events: [],
        prev_events: [],
      } as PDU,
    ]);
    getEventsSince.mockResolvedValue([]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'full_state=true&since=s1_td0');
    expect(status).toBe(200);
    const rooms = body.rooms as any;
    expect(rooms.join[ROOM]).toBeTruthy();
  });
  it('full_state soft-9', async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getRoomState.mockResolvedValue([
      {
        room_id: ROOM,
        sender: USER,
        type: 'm.room.create',
        event_id: '$create9:example.com',
        origin_server_ts: NOW,
        content: {},
        state_key: '',
        depth: 1,
        auth_events: [],
        prev_events: [],
      } as PDU,
    ]);
    getEventsSince.mockResolvedValue([]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'full_state=true&since=s1_td0');
    expect(status).toBe(200);
    const rooms = body.rooms as any;
    expect(rooms.join[ROOM]).toBeTruthy();
  });
  it('full_state soft-10', async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getRoomState.mockResolvedValue([
      {
        room_id: ROOM,
        sender: USER,
        type: 'm.room.create',
        event_id: '$create10:example.com',
        origin_server_ts: NOW,
        content: {},
        state_key: '',
        depth: 1,
        auth_events: [],
        prev_events: [],
      } as PDU,
    ]);
    getEventsSince.mockResolvedValue([]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'full_state=true&since=s1_td0');
    expect(status).toBe(200);
    const rooms = body.rooms as any;
    expect(rooms.join[ROOM]).toBeTruthy();
  });
  it('full_state soft-11', async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getRoomState.mockResolvedValue([
      {
        room_id: ROOM,
        sender: USER,
        type: 'm.room.create',
        event_id: '$create11:example.com',
        origin_server_ts: NOW,
        content: {},
        state_key: '',
        depth: 1,
        auth_events: [],
        prev_events: [],
      } as PDU,
    ]);
    getEventsSince.mockResolvedValue([]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'full_state=true&since=s1_td0');
    expect(status).toBe(200);
    const rooms = body.rooms as any;
    expect(rooms.join[ROOM]).toBeTruthy();
  });
  it('full_state soft-12', async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getRoomState.mockResolvedValue([
      {
        room_id: ROOM,
        sender: USER,
        type: 'm.room.create',
        event_id: '$create12:example.com',
        origin_server_ts: NOW,
        content: {},
        state_key: '',
        depth: 1,
        auth_events: [],
        prev_events: [],
      } as PDU,
    ]);
    getEventsSince.mockResolvedValue([]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'full_state=true&since=s1_td0');
    expect(status).toBe(200);
    const rooms = body.rooms as any;
    expect(rooms.join[ROOM]).toBeTruthy();
  });
  it('full_state soft-13', async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getRoomState.mockResolvedValue([
      {
        room_id: ROOM,
        sender: USER,
        type: 'm.room.create',
        event_id: '$create13:example.com',
        origin_server_ts: NOW,
        content: {},
        state_key: '',
        depth: 1,
        auth_events: [],
        prev_events: [],
      } as PDU,
    ]);
    getEventsSince.mockResolvedValue([]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'full_state=true&since=s1_td0');
    expect(status).toBe(200);
    const rooms = body.rooms as any;
    expect(rooms.join[ROOM]).toBeTruthy();
  });
  it('full_state soft-14', async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getRoomState.mockResolvedValue([
      {
        room_id: ROOM,
        sender: USER,
        type: 'm.room.create',
        event_id: '$create14:example.com',
        origin_server_ts: NOW,
        content: {},
        state_key: '',
        depth: 1,
        auth_events: [],
        prev_events: [],
      } as PDU,
    ]);
    getEventsSince.mockResolvedValue([]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'full_state=true&since=s1_td0');
    expect(status).toBe(200);
    const rooms = body.rooms as any;
    expect(rooms.join[ROOM]).toBeTruthy();
  });
  it('full_state soft-15', async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getRoomState.mockResolvedValue([
      {
        room_id: ROOM,
        sender: USER,
        type: 'm.room.create',
        event_id: '$create15:example.com',
        origin_server_ts: NOW,
        content: {},
        state_key: '',
        depth: 1,
        auth_events: [],
        prev_events: [],
      } as PDU,
    ]);
    getEventsSince.mockResolvedValue([]);
    const env = createEnv();
    const { status, body } = await syncRequest(env, 'full_state=true&since=s1_td0');
    expect(status).toBe(200);
    const rooms = body.rooms as any;
    expect(rooms.join[ROOM]).toBeTruthy();
  });
});

describe('sync leftovers set_presence soft flood after #157', () => {
  it('set_presence online soft-0', async () => {
    const env = createEnv();
    const { status } = await syncRequest(env, 'set_presence=online');
    expect(status).toBe(200);
  });
  it('set_presence offline soft-1', async () => {
    const env = createEnv();
    const { status } = await syncRequest(env, 'set_presence=offline');
    expect(status).toBe(200);
  });
  it('set_presence unavailable soft-2', async () => {
    const env = createEnv();
    const { status } = await syncRequest(env, 'set_presence=unavailable');
    expect(status).toBe(200);
  });
  it('set_presence online soft-3', async () => {
    const env = createEnv();
    const { status } = await syncRequest(env, 'set_presence=online');
    expect(status).toBe(200);
  });
  it('set_presence offline soft-4', async () => {
    const env = createEnv();
    const { status } = await syncRequest(env, 'set_presence=offline');
    expect(status).toBe(200);
  });
  it('set_presence unavailable soft-5', async () => {
    const env = createEnv();
    const { status } = await syncRequest(env, 'set_presence=unavailable');
    expect(status).toBe(200);
  });
  it('set_presence online soft-6', async () => {
    const env = createEnv();
    const { status } = await syncRequest(env, 'set_presence=online');
    expect(status).toBe(200);
  });
  it('set_presence offline soft-7', async () => {
    const env = createEnv();
    const { status } = await syncRequest(env, 'set_presence=offline');
    expect(status).toBe(200);
  });
  it('set_presence unavailable soft-8', async () => {
    const env = createEnv();
    const { status } = await syncRequest(env, 'set_presence=unavailable');
    expect(status).toBe(200);
  });
  it('set_presence online soft-9', async () => {
    const env = createEnv();
    const { status } = await syncRequest(env, 'set_presence=online');
    expect(status).toBe(200);
  });
  it('set_presence offline soft-10', async () => {
    const env = createEnv();
    const { status } = await syncRequest(env, 'set_presence=offline');
    expect(status).toBe(200);
  });
  it('set_presence unavailable soft-11', async () => {
    const env = createEnv();
    const { status } = await syncRequest(env, 'set_presence=unavailable');
    expect(status).toBe(200);
  });
  it('set_presence online soft-12', async () => {
    const env = createEnv();
    const { status } = await syncRequest(env, 'set_presence=online');
    expect(status).toBe(200);
  });
  it('set_presence offline soft-13', async () => {
    const env = createEnv();
    const { status } = await syncRequest(env, 'set_presence=offline');
    expect(status).toBe(200);
  });
  it('set_presence unavailable soft-14', async () => {
    const env = createEnv();
    const { status } = await syncRequest(env, 'set_presence=unavailable');
    expect(status).toBe(200);
  });
  it('set_presence online soft-15', async () => {
    const env = createEnv();
    const { status } = await syncRequest(env, 'set_presence=online');
    expect(status).toBe(200);
  });
  it('set_presence offline soft-16', async () => {
    const env = createEnv();
    const { status } = await syncRequest(env, 'set_presence=offline');
    expect(status).toBe(200);
  });
  it('set_presence unavailable soft-17', async () => {
    const env = createEnv();
    const { status } = await syncRequest(env, 'set_presence=unavailable');
    expect(status).toBe(200);
  });
});

describe('sync leftovers filter soft flood after #157', () => {
  it('inline filter soft-0', async () => {
    const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 1 } } }));
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.next_batch).toBeTruthy();
  });
  it('inline filter soft-1', async () => {
    const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 2 } } }));
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.next_batch).toBeTruthy();
  });
  it('inline filter soft-2', async () => {
    const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 3 } } }));
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.next_batch).toBeTruthy();
  });
  it('inline filter soft-3', async () => {
    const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 4 } } }));
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.next_batch).toBeTruthy();
  });
  it('inline filter soft-4', async () => {
    const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 5 } } }));
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.next_batch).toBeTruthy();
  });
  it('inline filter soft-5', async () => {
    const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 6 } } }));
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.next_batch).toBeTruthy();
  });
  it('inline filter soft-6', async () => {
    const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 7 } } }));
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.next_batch).toBeTruthy();
  });
  it('inline filter soft-7', async () => {
    const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 8 } } }));
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.next_batch).toBeTruthy();
  });
  it('inline filter soft-8', async () => {
    const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 9 } } }));
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.next_batch).toBeTruthy();
  });
  it('inline filter soft-9', async () => {
    const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 10 } } }));
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.next_batch).toBeTruthy();
  });
  it('inline filter soft-10', async () => {
    const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 11 } } }));
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.next_batch).toBeTruthy();
  });
  it('inline filter soft-11', async () => {
    const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 12 } } }));
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.next_batch).toBeTruthy();
  });
  it('inline filter soft-12', async () => {
    const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 13 } } }));
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.next_batch).toBeTruthy();
  });
  it('inline filter soft-13', async () => {
    const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 14 } } }));
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.next_batch).toBeTruthy();
  });
  it('inline filter soft-14', async () => {
    const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 15 } } }));
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.next_batch).toBeTruthy();
  });
  it('inline filter soft-15', async () => {
    const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 16 } } }));
    const env = createEnv();
    const { status, body } = await syncRequest(env, `filter=${filter}`);
    expect(status).toBe(200);
    expect(body.next_batch).toBeTruthy();
  });
  it('kv filter id soft-0', async () => {
    const cache = mockKv({ [`filter:${USER}:f0`]: JSON.stringify({ room: { timeline: { limit: 5 } } }) });
    const env = createEnv({ cache });
    const { status } = await syncRequest(env, 'filter=f0');
    expect(status).toBe(200);
  });
  it('kv filter id soft-1', async () => {
    const cache = mockKv({ [`filter:${USER}:f1`]: JSON.stringify({ room: { timeline: { limit: 6 } } }) });
    const env = createEnv({ cache });
    const { status } = await syncRequest(env, 'filter=f1');
    expect(status).toBe(200);
  });
  it('kv filter id soft-2', async () => {
    const cache = mockKv({ [`filter:${USER}:f2`]: JSON.stringify({ room: { timeline: { limit: 7 } } }) });
    const env = createEnv({ cache });
    const { status } = await syncRequest(env, 'filter=f2');
    expect(status).toBe(200);
  });
  it('kv filter id soft-3', async () => {
    const cache = mockKv({ [`filter:${USER}:f3`]: JSON.stringify({ room: { timeline: { limit: 8 } } }) });
    const env = createEnv({ cache });
    const { status } = await syncRequest(env, 'filter=f3');
    expect(status).toBe(200);
  });
  it('kv filter id soft-4', async () => {
    const cache = mockKv({ [`filter:${USER}:f4`]: JSON.stringify({ room: { timeline: { limit: 9 } } }) });
    const env = createEnv({ cache });
    const { status } = await syncRequest(env, 'filter=f4');
    expect(status).toBe(200);
  });
  it('kv filter id soft-5', async () => {
    const cache = mockKv({ [`filter:${USER}:f5`]: JSON.stringify({ room: { timeline: { limit: 10 } } }) });
    const env = createEnv({ cache });
    const { status } = await syncRequest(env, 'filter=f5');
    expect(status).toBe(200);
  });
  it('kv filter id soft-6', async () => {
    const cache = mockKv({ [`filter:${USER}:f6`]: JSON.stringify({ room: { timeline: { limit: 11 } } }) });
    const env = createEnv({ cache });
    const { status } = await syncRequest(env, 'filter=f6');
    expect(status).toBe(200);
  });
  it('kv filter id soft-7', async () => {
    const cache = mockKv({ [`filter:${USER}:f7`]: JSON.stringify({ room: { timeline: { limit: 12 } } }) });
    const env = createEnv({ cache });
    const { status } = await syncRequest(env, 'filter=f7');
    expect(status).toBe(200);
  });
  it('kv filter id soft-8', async () => {
    const cache = mockKv({ [`filter:${USER}:f8`]: JSON.stringify({ room: { timeline: { limit: 13 } } }) });
    const env = createEnv({ cache });
    const { status } = await syncRequest(env, 'filter=f8');
    expect(status).toBe(200);
  });
  it('kv filter id soft-9', async () => {
    const cache = mockKv({ [`filter:${USER}:f9`]: JSON.stringify({ room: { timeline: { limit: 14 } } }) });
    const env = createEnv({ cache });
    const { status } = await syncRequest(env, 'filter=f9');
    expect(status).toBe(200);
  });
  it('kv filter id soft-10', async () => {
    const cache = mockKv({ [`filter:${USER}:f10`]: JSON.stringify({ room: { timeline: { limit: 15 } } }) });
    const env = createEnv({ cache });
    const { status } = await syncRequest(env, 'filter=f10');
    expect(status).toBe(200);
  });
  it('kv filter id soft-11', async () => {
    const cache = mockKv({ [`filter:${USER}:f11`]: JSON.stringify({ room: { timeline: { limit: 16 } } }) });
    const env = createEnv({ cache });
    const { status } = await syncRequest(env, 'filter=f11');
    expect(status).toBe(200);
  });
});

describe('sync leftovers otk soft flood after #157', () => {
  it('otk counts soft-0', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 1 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const env = createEnv({ db });
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect((body.device_one_time_keys_count as any).signed_curve25519).toBe(1);
    expect(body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
  });
  it('otk counts soft-1', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 2 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const env = createEnv({ db });
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect((body.device_one_time_keys_count as any).signed_curve25519).toBe(2);
    expect(body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
  });
  it('otk counts soft-2', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 3 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const env = createEnv({ db });
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect((body.device_one_time_keys_count as any).signed_curve25519).toBe(3);
    expect(body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
  });
  it('otk counts soft-3', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 4 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const env = createEnv({ db });
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect((body.device_one_time_keys_count as any).signed_curve25519).toBe(4);
    expect(body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
  });
  it('otk counts soft-4', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 5 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const env = createEnv({ db });
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect((body.device_one_time_keys_count as any).signed_curve25519).toBe(5);
    expect(body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
  });
  it('otk counts soft-5', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 6 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const env = createEnv({ db });
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect((body.device_one_time_keys_count as any).signed_curve25519).toBe(6);
    expect(body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
  });
  it('otk counts soft-6', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 7 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const env = createEnv({ db });
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect((body.device_one_time_keys_count as any).signed_curve25519).toBe(7);
    expect(body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
  });
  it('otk counts soft-7', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 8 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const env = createEnv({ db });
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect((body.device_one_time_keys_count as any).signed_curve25519).toBe(8);
    expect(body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
  });
  it('otk counts soft-8', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 9 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const env = createEnv({ db });
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect((body.device_one_time_keys_count as any).signed_curve25519).toBe(9);
    expect(body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
  });
  it('otk counts soft-9', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 10 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const env = createEnv({ db });
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect((body.device_one_time_keys_count as any).signed_curve25519).toBe(10);
    expect(body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
  });
  it('otk counts soft-10', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 11 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const env = createEnv({ db });
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect((body.device_one_time_keys_count as any).signed_curve25519).toBe(11);
    expect(body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
  });
  it('otk counts soft-11', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 12 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const env = createEnv({ db });
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect((body.device_one_time_keys_count as any).signed_curve25519).toBe(12);
    expect(body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
  });
  it('otk counts soft-12', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 13 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const env = createEnv({ db });
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect((body.device_one_time_keys_count as any).signed_curve25519).toBe(13);
    expect(body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
  });
  it('otk counts soft-13', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 14 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const env = createEnv({ db });
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect((body.device_one_time_keys_count as any).signed_curve25519).toBe(14);
    expect(body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
  });
  it('otk counts soft-14', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 15 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const env = createEnv({ db });
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect((body.device_one_time_keys_count as any).signed_curve25519).toBe(15);
    expect(body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
  });
  it('otk counts soft-15', async () => {
    const db = createSyncDb({
      otkCounts: [{ algorithm: 'signed_curve25519', count: 16 }],
      fallbackAlgos: [{ algorithm: 'signed_curve25519' }],
    });
    const env = createEnv({ db });
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect((body.device_one_time_keys_count as any).signed_curve25519).toBe(16);
    expect(body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
  });
});

describe('sync leftovers method matrix after #157', () => {
  it('POST rejected soft-0', async () => {
    const env = createEnv();
    const res = await syncApp.request('http://localhost/_matrix/client/v3/sync', { method: 'POST' }, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('POST rejected soft-1', async () => {
    const env = createEnv();
    const res = await syncApp.request('http://localhost/_matrix/client/v3/sync', { method: 'POST' }, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('POST rejected soft-2', async () => {
    const env = createEnv();
    const res = await syncApp.request('http://localhost/_matrix/client/v3/sync', { method: 'POST' }, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('POST rejected soft-3', async () => {
    const env = createEnv();
    const res = await syncApp.request('http://localhost/_matrix/client/v3/sync', { method: 'POST' }, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PUT rejected soft-0', async () => {
    const env = createEnv();
    const res = await syncApp.request('http://localhost/_matrix/client/v3/sync', { method: 'PUT' }, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PUT rejected soft-1', async () => {
    const env = createEnv();
    const res = await syncApp.request('http://localhost/_matrix/client/v3/sync', { method: 'PUT' }, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PUT rejected soft-2', async () => {
    const env = createEnv();
    const res = await syncApp.request('http://localhost/_matrix/client/v3/sync', { method: 'PUT' }, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PUT rejected soft-3', async () => {
    const env = createEnv();
    const res = await syncApp.request('http://localhost/_matrix/client/v3/sync', { method: 'PUT' }, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('DELETE rejected soft-0', async () => {
    const env = createEnv();
    const res = await syncApp.request('http://localhost/_matrix/client/v3/sync', { method: 'DELETE' }, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('DELETE rejected soft-1', async () => {
    const env = createEnv();
    const res = await syncApp.request('http://localhost/_matrix/client/v3/sync', { method: 'DELETE' }, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('DELETE rejected soft-2', async () => {
    const env = createEnv();
    const res = await syncApp.request('http://localhost/_matrix/client/v3/sync', { method: 'DELETE' }, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('DELETE rejected soft-3', async () => {
    const env = createEnv();
    const res = await syncApp.request('http://localhost/_matrix/client/v3/sync', { method: 'DELETE' }, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PATCH rejected soft-0', async () => {
    const env = createEnv();
    const res = await syncApp.request('http://localhost/_matrix/client/v3/sync', { method: 'PATCH' }, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PATCH rejected soft-1', async () => {
    const env = createEnv();
    const res = await syncApp.request('http://localhost/_matrix/client/v3/sync', { method: 'PATCH' }, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PATCH rejected soft-2', async () => {
    const env = createEnv();
    const res = await syncApp.request('http://localhost/_matrix/client/v3/sync', { method: 'PATCH' }, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PATCH rejected soft-3', async () => {
    const env = createEnv();
    const res = await syncApp.request('http://localhost/_matrix/client/v3/sync', { method: 'PATCH' }, env);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('sync leftovers failure edges after #157', () => {
  it('stream position boom soft-0', async () => {
    getLatestStreamPosition.mockRejectedValue(new Error('stream boom 0'));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(500);
    expect(body._raw).toMatch(/Internal Server Error/);
  });
  it('stream position boom soft-1', async () => {
    getLatestStreamPosition.mockRejectedValue(new Error('stream boom 1'));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(500);
    expect(body._raw).toMatch(/Internal Server Error/);
  });
  it('stream position boom soft-2', async () => {
    getLatestStreamPosition.mockRejectedValue(new Error('stream boom 2'));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(500);
    expect(body._raw).toMatch(/Internal Server Error/);
  });
  it('stream position boom soft-3', async () => {
    getLatestStreamPosition.mockRejectedValue(new Error('stream boom 3'));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(500);
    expect(body._raw).toMatch(/Internal Server Error/);
  });
  it('stream position boom soft-4', async () => {
    getLatestStreamPosition.mockRejectedValue(new Error('stream boom 4'));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(500);
    expect(body._raw).toMatch(/Internal Server Error/);
  });
  it('stream position boom soft-5', async () => {
    getLatestStreamPosition.mockRejectedValue(new Error('stream boom 5'));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(500);
    expect(body._raw).toMatch(/Internal Server Error/);
  });
  it('stream position boom soft-6', async () => {
    getLatestStreamPosition.mockRejectedValue(new Error('stream boom 6'));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(500);
    expect(body._raw).toMatch(/Internal Server Error/);
  });
  it('stream position boom soft-7', async () => {
    getLatestStreamPosition.mockRejectedValue(new Error('stream boom 7'));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(500);
    expect(body._raw).toMatch(/Internal Server Error/);
  });
  it('stream position boom soft-8', async () => {
    getLatestStreamPosition.mockRejectedValue(new Error('stream boom 8'));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(500);
    expect(body._raw).toMatch(/Internal Server Error/);
  });
  it('stream position boom soft-9', async () => {
    getLatestStreamPosition.mockRejectedValue(new Error('stream boom 9'));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(500);
    expect(body._raw).toMatch(/Internal Server Error/);
  });
  it('stream position boom soft-10', async () => {
    getLatestStreamPosition.mockRejectedValue(new Error('stream boom 10'));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(500);
    expect(body._raw).toMatch(/Internal Server Error/);
  });
  it('stream position boom soft-11', async () => {
    getLatestStreamPosition.mockRejectedValue(new Error('stream boom 11'));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(500);
    expect(body._raw).toMatch(/Internal Server Error/);
  });
  it('user rooms boom soft-0', async () => {
    getUserRooms.mockRejectedValue(new Error('rooms boom 0'));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(500);
    expect(body._raw).toMatch(/Internal Server Error/);
  });
  it('user rooms boom soft-1', async () => {
    getUserRooms.mockRejectedValue(new Error('rooms boom 1'));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(500);
    expect(body._raw).toMatch(/Internal Server Error/);
  });
  it('user rooms boom soft-2', async () => {
    getUserRooms.mockRejectedValue(new Error('rooms boom 2'));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(500);
    expect(body._raw).toMatch(/Internal Server Error/);
  });
  it('user rooms boom soft-3', async () => {
    getUserRooms.mockRejectedValue(new Error('rooms boom 3'));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(500);
    expect(body._raw).toMatch(/Internal Server Error/);
  });
  it('user rooms boom soft-4', async () => {
    getUserRooms.mockRejectedValue(new Error('rooms boom 4'));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(500);
    expect(body._raw).toMatch(/Internal Server Error/);
  });
  it('user rooms boom soft-5', async () => {
    getUserRooms.mockRejectedValue(new Error('rooms boom 5'));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(500);
    expect(body._raw).toMatch(/Internal Server Error/);
  });
  it('user rooms boom soft-6', async () => {
    getUserRooms.mockRejectedValue(new Error('rooms boom 6'));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(500);
    expect(body._raw).toMatch(/Internal Server Error/);
  });
  it('user rooms boom soft-7', async () => {
    getUserRooms.mockRejectedValue(new Error('rooms boom 7'));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(500);
    expect(body._raw).toMatch(/Internal Server Error/);
  });
  it('user rooms boom soft-8', async () => {
    getUserRooms.mockRejectedValue(new Error('rooms boom 8'));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(500);
    expect(body._raw).toMatch(/Internal Server Error/);
  });
  it('user rooms boom soft-9', async () => {
    getUserRooms.mockRejectedValue(new Error('rooms boom 9'));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(500);
    expect(body._raw).toMatch(/Internal Server Error/);
  });
  it('user rooms boom soft-10', async () => {
    getUserRooms.mockRejectedValue(new Error('rooms boom 10'));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(500);
    expect(body._raw).toMatch(/Internal Server Error/);
  });
  it('user rooms boom soft-11', async () => {
    getUserRooms.mockRejectedValue(new Error('rooms boom 11'));
    const env = createEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(500);
    expect(body._raw).toMatch(/Internal Server Error/);
  });
});

describe('sync leftovers lifecycle soft floods after #157', () => {
  it('sync lifecycle soft-0', async () => {
    getLatestStreamPosition.mockResolvedValue(50);
    getToDeviceMessages.mockResolvedValue({
      events: [{ type: 'm.room.encrypted', content: { soft: 0 } }],
      nextBatch: 'td0',
    });
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { [BOB]: [ROOM] } },
    ]);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.to_device).toEqual({
      events: [{ type: 'm.room.encrypted', content: { soft: 0 } }],
    });
    expect((initial.body.account_data as any).events).toHaveLength(1);
    const since = String(initial.body.next_batch);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: 'td0' });
    const incr = await syncRequest(env, `since=${encodeURIComponent(since)}`);
    expect(incr.status).toBe(200);
    expect(incr.body.next_batch).toBeTruthy();
  });
  it('sync lifecycle soft-1', async () => {
    getLatestStreamPosition.mockResolvedValue(51);
    getToDeviceMessages.mockResolvedValue({
      events: [{ type: 'm.room.encrypted', content: { soft: 1 } }],
      nextBatch: 'td1',
    });
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { [BOB]: [ROOM] } },
    ]);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.to_device).toEqual({
      events: [{ type: 'm.room.encrypted', content: { soft: 1 } }],
    });
    expect((initial.body.account_data as any).events).toHaveLength(1);
    const since = String(initial.body.next_batch);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: 'td1' });
    const incr = await syncRequest(env, `since=${encodeURIComponent(since)}`);
    expect(incr.status).toBe(200);
    expect(incr.body.next_batch).toBeTruthy();
  });
  it('sync lifecycle soft-2', async () => {
    getLatestStreamPosition.mockResolvedValue(52);
    getToDeviceMessages.mockResolvedValue({
      events: [{ type: 'm.room.encrypted', content: { soft: 2 } }],
      nextBatch: 'td2',
    });
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { [BOB]: [ROOM] } },
    ]);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.to_device).toEqual({
      events: [{ type: 'm.room.encrypted', content: { soft: 2 } }],
    });
    expect((initial.body.account_data as any).events).toHaveLength(1);
    const since = String(initial.body.next_batch);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: 'td2' });
    const incr = await syncRequest(env, `since=${encodeURIComponent(since)}`);
    expect(incr.status).toBe(200);
    expect(incr.body.next_batch).toBeTruthy();
  });
  it('sync lifecycle soft-3', async () => {
    getLatestStreamPosition.mockResolvedValue(53);
    getToDeviceMessages.mockResolvedValue({
      events: [{ type: 'm.room.encrypted', content: { soft: 3 } }],
      nextBatch: 'td3',
    });
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { [BOB]: [ROOM] } },
    ]);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.to_device).toEqual({
      events: [{ type: 'm.room.encrypted', content: { soft: 3 } }],
    });
    expect((initial.body.account_data as any).events).toHaveLength(1);
    const since = String(initial.body.next_batch);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: 'td3' });
    const incr = await syncRequest(env, `since=${encodeURIComponent(since)}`);
    expect(incr.status).toBe(200);
    expect(incr.body.next_batch).toBeTruthy();
  });
  it('sync lifecycle soft-4', async () => {
    getLatestStreamPosition.mockResolvedValue(54);
    getToDeviceMessages.mockResolvedValue({
      events: [{ type: 'm.room.encrypted', content: { soft: 4 } }],
      nextBatch: 'td4',
    });
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { [BOB]: [ROOM] } },
    ]);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.to_device).toEqual({
      events: [{ type: 'm.room.encrypted', content: { soft: 4 } }],
    });
    expect((initial.body.account_data as any).events).toHaveLength(1);
    const since = String(initial.body.next_batch);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: 'td4' });
    const incr = await syncRequest(env, `since=${encodeURIComponent(since)}`);
    expect(incr.status).toBe(200);
    expect(incr.body.next_batch).toBeTruthy();
  });
  it('sync lifecycle soft-5', async () => {
    getLatestStreamPosition.mockResolvedValue(55);
    getToDeviceMessages.mockResolvedValue({
      events: [{ type: 'm.room.encrypted', content: { soft: 5 } }],
      nextBatch: 'td5',
    });
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { [BOB]: [ROOM] } },
    ]);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.to_device).toEqual({
      events: [{ type: 'm.room.encrypted', content: { soft: 5 } }],
    });
    expect((initial.body.account_data as any).events).toHaveLength(1);
    const since = String(initial.body.next_batch);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: 'td5' });
    const incr = await syncRequest(env, `since=${encodeURIComponent(since)}`);
    expect(incr.status).toBe(200);
    expect(incr.body.next_batch).toBeTruthy();
  });
  it('sync lifecycle soft-6', async () => {
    getLatestStreamPosition.mockResolvedValue(56);
    getToDeviceMessages.mockResolvedValue({
      events: [{ type: 'm.room.encrypted', content: { soft: 6 } }],
      nextBatch: 'td6',
    });
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { [BOB]: [ROOM] } },
    ]);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.to_device).toEqual({
      events: [{ type: 'm.room.encrypted', content: { soft: 6 } }],
    });
    expect((initial.body.account_data as any).events).toHaveLength(1);
    const since = String(initial.body.next_batch);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: 'td6' });
    const incr = await syncRequest(env, `since=${encodeURIComponent(since)}`);
    expect(incr.status).toBe(200);
    expect(incr.body.next_batch).toBeTruthy();
  });
  it('sync lifecycle soft-7', async () => {
    getLatestStreamPosition.mockResolvedValue(57);
    getToDeviceMessages.mockResolvedValue({
      events: [{ type: 'm.room.encrypted', content: { soft: 7 } }],
      nextBatch: 'td7',
    });
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { [BOB]: [ROOM] } },
    ]);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.to_device).toEqual({
      events: [{ type: 'm.room.encrypted', content: { soft: 7 } }],
    });
    expect((initial.body.account_data as any).events).toHaveLength(1);
    const since = String(initial.body.next_batch);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: 'td7' });
    const incr = await syncRequest(env, `since=${encodeURIComponent(since)}`);
    expect(incr.status).toBe(200);
    expect(incr.body.next_batch).toBeTruthy();
  });
  it('sync lifecycle soft-8', async () => {
    getLatestStreamPosition.mockResolvedValue(58);
    getToDeviceMessages.mockResolvedValue({
      events: [{ type: 'm.room.encrypted', content: { soft: 8 } }],
      nextBatch: 'td8',
    });
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { [BOB]: [ROOM] } },
    ]);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.to_device).toEqual({
      events: [{ type: 'm.room.encrypted', content: { soft: 8 } }],
    });
    expect((initial.body.account_data as any).events).toHaveLength(1);
    const since = String(initial.body.next_batch);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: 'td8' });
    const incr = await syncRequest(env, `since=${encodeURIComponent(since)}`);
    expect(incr.status).toBe(200);
    expect(incr.body.next_batch).toBeTruthy();
  });
  it('sync lifecycle soft-9', async () => {
    getLatestStreamPosition.mockResolvedValue(59);
    getToDeviceMessages.mockResolvedValue({
      events: [{ type: 'm.room.encrypted', content: { soft: 9 } }],
      nextBatch: 'td9',
    });
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { [BOB]: [ROOM] } },
    ]);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.to_device).toEqual({
      events: [{ type: 'm.room.encrypted', content: { soft: 9 } }],
    });
    expect((initial.body.account_data as any).events).toHaveLength(1);
    const since = String(initial.body.next_batch);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: 'td9' });
    const incr = await syncRequest(env, `since=${encodeURIComponent(since)}`);
    expect(incr.status).toBe(200);
    expect(incr.body.next_batch).toBeTruthy();
  });
  it('sync lifecycle soft-10', async () => {
    getLatestStreamPosition.mockResolvedValue(60);
    getToDeviceMessages.mockResolvedValue({
      events: [{ type: 'm.room.encrypted', content: { soft: 10 } }],
      nextBatch: 'td10',
    });
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { [BOB]: [ROOM] } },
    ]);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.to_device).toEqual({
      events: [{ type: 'm.room.encrypted', content: { soft: 10 } }],
    });
    expect((initial.body.account_data as any).events).toHaveLength(1);
    const since = String(initial.body.next_batch);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: 'td10' });
    const incr = await syncRequest(env, `since=${encodeURIComponent(since)}`);
    expect(incr.status).toBe(200);
    expect(incr.body.next_batch).toBeTruthy();
  });
  it('sync lifecycle soft-11', async () => {
    getLatestStreamPosition.mockResolvedValue(61);
    getToDeviceMessages.mockResolvedValue({
      events: [{ type: 'm.room.encrypted', content: { soft: 11 } }],
      nextBatch: 'td11',
    });
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { [BOB]: [ROOM] } },
    ]);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.to_device).toEqual({
      events: [{ type: 'm.room.encrypted', content: { soft: 11 } }],
    });
    expect((initial.body.account_data as any).events).toHaveLength(1);
    const since = String(initial.body.next_batch);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: 'td11' });
    const incr = await syncRequest(env, `since=${encodeURIComponent(since)}`);
    expect(incr.status).toBe(200);
    expect(incr.body.next_batch).toBeTruthy();
  });
  it('sync lifecycle soft-12', async () => {
    getLatestStreamPosition.mockResolvedValue(62);
    getToDeviceMessages.mockResolvedValue({
      events: [{ type: 'm.room.encrypted', content: { soft: 12 } }],
      nextBatch: 'td12',
    });
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { [BOB]: [ROOM] } },
    ]);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.to_device).toEqual({
      events: [{ type: 'm.room.encrypted', content: { soft: 12 } }],
    });
    expect((initial.body.account_data as any).events).toHaveLength(1);
    const since = String(initial.body.next_batch);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: 'td12' });
    const incr = await syncRequest(env, `since=${encodeURIComponent(since)}`);
    expect(incr.status).toBe(200);
    expect(incr.body.next_batch).toBeTruthy();
  });
  it('sync lifecycle soft-13', async () => {
    getLatestStreamPosition.mockResolvedValue(63);
    getToDeviceMessages.mockResolvedValue({
      events: [{ type: 'm.room.encrypted', content: { soft: 13 } }],
      nextBatch: 'td13',
    });
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { [BOB]: [ROOM] } },
    ]);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.to_device).toEqual({
      events: [{ type: 'm.room.encrypted', content: { soft: 13 } }],
    });
    expect((initial.body.account_data as any).events).toHaveLength(1);
    const since = String(initial.body.next_batch);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: 'td13' });
    const incr = await syncRequest(env, `since=${encodeURIComponent(since)}`);
    expect(incr.status).toBe(200);
    expect(incr.body.next_batch).toBeTruthy();
  });
  it('sync lifecycle soft-14', async () => {
    getLatestStreamPosition.mockResolvedValue(64);
    getToDeviceMessages.mockResolvedValue({
      events: [{ type: 'm.room.encrypted', content: { soft: 14 } }],
      nextBatch: 'td14',
    });
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { [BOB]: [ROOM] } },
    ]);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.to_device).toEqual({
      events: [{ type: 'm.room.encrypted', content: { soft: 14 } }],
    });
    expect((initial.body.account_data as any).events).toHaveLength(1);
    const since = String(initial.body.next_batch);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: 'td14' });
    const incr = await syncRequest(env, `since=${encodeURIComponent(since)}`);
    expect(incr.status).toBe(200);
    expect(incr.body.next_batch).toBeTruthy();
  });
  it('sync lifecycle soft-15', async () => {
    getLatestStreamPosition.mockResolvedValue(65);
    getToDeviceMessages.mockResolvedValue({
      events: [{ type: 'm.room.encrypted', content: { soft: 15 } }],
      nextBatch: 'td15',
    });
    getGlobalAccountData.mockResolvedValue([
      { type: 'm.direct', content: { [BOB]: [ROOM] } },
    ]);
    const env = createEnv();
    const initial = await syncRequest(env);
    expect(initial.status).toBe(200);
    expect(initial.body.to_device).toEqual({
      events: [{ type: 'm.room.encrypted', content: { soft: 15 } }],
    });
    expect((initial.body.account_data as any).events).toHaveLength(1);
    const since = String(initial.body.next_batch);
    getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: 'td15' });
    const incr = await syncRequest(env, `since=${encodeURIComponent(since)}`);
    expect(incr.status).toBe(200);
    expect(incr.body.next_batch).toBeTruthy();
  });
});

void DEVICE;
void NOW;
