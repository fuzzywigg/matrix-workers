/**
 * TOKENMAXX HEAVY device-list-sync deepen — client /sync device_lists.
 * Existing module: src/api/sync.ts getDeviceListChanges. Tests-only.
 * Covers added peer deltas, stale stream positions, empty shared maps,
 * and partial long-poll DO failures already coded. Fixtures: example.com.
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
const DAVE = '@dave:example.com';

type SqlCall = { sql: string; args: unknown[] };
type DeviceKeyChange = { user_id: string; stream_position: number };

function mockKv(data: Record<string, string> = {}) {
  return {
    data,
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
    },
    delete: async (key: string) => {
      delete data[key];
    },
  } as unknown as KVNamespace;
}

function createSyncDoStub(opts: { hasEvents?: boolean; fail?: boolean } = {}) {
  const fetches: Array<{ url: string; body?: unknown }> = [];
  return {
    fetches,
    async fetch(req: Request): Promise<Response> {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        body = undefined;
      }
      fetches.push({ url: req.url, body });
      if (opts.fail) throw new Error('sync DO boom');
      return Response.json({ hasEvents: opts.hasEvents ?? false });
    },
  };
}

function createSyncDb(opts: {
  deviceKeyChanges?: DeviceKeyChange[];
  sharedRoomUsers?: string[];
} = {}) {
  const deviceKeyChanges = opts.deviceKeyChanges ?? [];
  const sharedRoomUsers = new Set(opts.sharedRoomUsers ?? [BOB, CAROL]);
  const selects: SqlCall[] = [];

  const db = {
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
              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 120)}`);
            },
            async all<T>() {
              selects.push({ sql, args });
              if (
                sql.includes('FROM one_time_keys') &&
                sql.includes('GROUP BY algorithm')
              ) {
                return { results: [] as T[] };
              }
              if (sql.includes('FROM fallback_keys') && sql.includes('DISTINCT algorithm')) {
                return { results: [] as T[] };
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
              throw new Error(`Unexpected run() SQL: ${sql.slice(0, 80)}`);
            },
          };
        },
      };
    },
  };
  return db;
}

function createEnv(
  opts: {
    db?: ReturnType<typeof createSyncDb>;
    syncDo?: ReturnType<typeof createSyncDoStub>;
  } = {}
) {
  const db = opts.db ?? createSyncDb();
  const syncDo = opts.syncDo ?? createSyncDoStub();
  return {
    DB: db as unknown as D1Database,
    CACHE: mockKv(),
    SERVER_NAME: 'example.com',
    SYNC: {
      idFromName: (name: string) => ({ name, toString: () => `id:${name}` }),
      get: () => syncDo,
    },
    _db: db,
    _syncDo: syncDo,
  } as unknown as Env & { _db: ReturnType<typeof createSyncDb>; _syncDo: ReturnType<typeof createSyncDoStub> };
}

async function syncRequest(env: Env, query = '') {
  const path = `/_matrix/client/v3/sync${query ? `?${query}` : ''}`;
  const res = await syncApp.request(`http://localhost${path}`, {}, env);
  const text = await res.text();
  let body: Record<string, unknown> = {};
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
  getUserRooms.mockReset().mockImplementation(async (_db: unknown, _u: string, membership?: string) => {
    if (membership === 'join') return [];
    if (membership === 'invite') return [];
    if (membership === 'leave') return [];
    return [];
  });
  getRoomState.mockReset().mockResolvedValue({});
  getEventsSince.mockReset().mockResolvedValue([] as PDU[]);
  getLatestStreamPosition.mockReset().mockResolvedValue(42);
  getToDeviceMessages.mockReset().mockResolvedValue({ events: [], nextBatch: '0' });
  getGlobalAccountData.mockReset().mockResolvedValue([]);
  getRoomAccountData.mockReset().mockResolvedValue([]);
  getReceiptsForRoom.mockReset().mockResolvedValue({});
  getTypingUsers.mockReset().mockResolvedValue([]);
}

beforeEach(() => {
  resetMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Device added deltas (peers / self appearing in changed)
// ---------------------------------------------------------------------------

describe('GET /sync device_lists — added deltas', () => {
  it('surfaces a newly changed shared-room peer as changed', async () => {
    const env = createEnv({
      db: createSyncDb({
        deviceKeyChanges: [{ user_id: BOB, stream_position: 15 }],
        sharedRoomUsers: [BOB],
      }),
    });
    const { body } = await syncRequest(env, 'since=s10_td0');
    expect(body.device_lists).toEqual({ changed: [BOB], left: [] });
  });

  it('accumulates multiple newly added peer deltas without duplicates', async () => {
    const env = createEnv({
      db: createSyncDb({
        deviceKeyChanges: [
          { user_id: BOB, stream_position: 11 },
          { user_id: CAROL, stream_position: 12 },
          { user_id: BOB, stream_position: 13 },
          { user_id: DAVE, stream_position: 14 },
        ],
        sharedRoomUsers: [BOB, CAROL, DAVE],
      }),
    });
    const { body } = await syncRequest(env, 'since=s10_td0');
    expect(body.device_lists).toEqual({
      changed: expect.arrayContaining([BOB, CAROL, DAVE]),
      left: [],
    });
    expect((body.device_lists as { changed: string[] }).changed).toHaveLength(3);
  });

  it('adds self when own keys updated alongside peer adds', async () => {
    const env = createEnv({
      db: createSyncDb({
        deviceKeyChanges: [
          { user_id: USER, stream_position: 20 },
          { user_id: BOB, stream_position: 21 },
        ],
        sharedRoomUsers: [BOB],
      }),
    });
    const { body } = await syncRequest(env, 'since=s10_td0');
    expect(body.device_lists).toEqual({ changed: [BOB, USER], left: [] });
  });

  it('never puts deleted peers into left (implementation returns left:[])', async () => {
    // Sync path does not read change_type — even if peers "left", left stays empty
    const env = createEnv({
      db: createSyncDb({
        deviceKeyChanges: [{ user_id: BOB, stream_position: 50 }],
        sharedRoomUsers: [BOB],
      }),
    });
    const { body } = await syncRequest(env, 'since=s1_td0');
    expect((body.device_lists as { left: string[] }).left).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stale device lists (stream_position <= since ignored)
// ---------------------------------------------------------------------------

describe('GET /sync device_lists — stale positions', () => {
  it('omits peers whose only changes are at or before since', async () => {
    const env = createEnv({
      db: createSyncDb({
        deviceKeyChanges: [
          { user_id: BOB, stream_position: 10 }, // equal — stale
          { user_id: CAROL, stream_position: 9 }, // older — stale
          { user_id: DAVE, stream_position: 11 }, // fresh
        ],
        sharedRoomUsers: [BOB, CAROL, DAVE],
      }),
    });
    const { body } = await syncRequest(env, 'since=s10_td0');
    expect(body.device_lists).toEqual({ changed: [DAVE], left: [] });
  });

  it('omits device_lists entirely when all peer/self changes are stale', async () => {
    const env = createEnv({
      db: createSyncDb({
        deviceKeyChanges: [
          { user_id: BOB, stream_position: 5 },
          { user_id: USER, stream_position: 5 },
        ],
        sharedRoomUsers: [BOB],
      }),
    });
    const { body } = await syncRequest(env, 'since=s10_td0');
    expect(body.device_lists).toBeUndefined();
  });

  it('treats boundary stream_position === since as stale for peers and self', async () => {
    const env = createEnv({
      db: createSyncDb({
        deviceKeyChanges: [
          { user_id: BOB, stream_position: 40 },
          { user_id: USER, stream_position: 40 },
        ],
        sharedRoomUsers: [BOB],
      }),
    });
    const { body } = await syncRequest(env, 'since=s40_td0');
    expect(body.device_lists).toBeUndefined();
  });

  it('ignores stale outsider with high stream when not in shared rooms', async () => {
    const env = createEnv({
      db: createSyncDb({
        deviceKeyChanges: [
          { user_id: '@outsider:example.com', stream_position: 999 },
          { user_id: BOB, stream_position: 5 },
        ],
        sharedRoomUsers: [BOB],
      }),
    });
    const { body } = await syncRequest(env, 'since=s10_td0');
    expect(body.device_lists).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Empty user / shared-room device maps
// ---------------------------------------------------------------------------

describe('GET /sync device_lists — empty maps', () => {
  it('omits device_lists when shared room set is empty and no self changes', async () => {
    const env = createEnv({
      db: createSyncDb({
        deviceKeyChanges: [{ user_id: BOB, stream_position: 99 }],
        sharedRoomUsers: [],
      }),
    });
    const { body } = await syncRequest(env, 'since=s1_td0');
    expect(body.device_lists).toBeUndefined();
  });

  it('includes only self when shared map empty but own keys changed', async () => {
    const env = createEnv({
      db: createSyncDb({
        deviceKeyChanges: [
          { user_id: USER, stream_position: 99 },
          { user_id: BOB, stream_position: 99 },
        ],
        sharedRoomUsers: [],
      }),
    });
    const { body } = await syncRequest(env, 'since=s1_td0');
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });

  it('initial sync always seeds self even with empty change table', async () => {
    const env = createEnv({
      db: createSyncDb({ deviceKeyChanges: [], sharedRoomUsers: [] }),
    });
    const { body } = await syncRequest(env);
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
  });

  it('empty deviceKeyChanges on incremental omits device_lists', async () => {
    const env = createEnv({
      db: createSyncDb({ deviceKeyChanges: [], sharedRoomUsers: [BOB, CAROL] }),
    });
    const { body } = await syncRequest(env, 'since=s5_td0');
    expect(body.device_lists).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Partial sync behavior already coded (device_lists ≠ hasChanges)
// ---------------------------------------------------------------------------

describe('GET /sync device_lists — partial change semantics', () => {
  it('device_lists-only changes do not skip DO wait (hasChanges ignores device_lists)', async () => {
    const syncDo = createSyncDoStub({ hasEvents: false });
    const env = createEnv({
      syncDo,
      db: createSyncDb({
        deviceKeyChanges: [{ user_id: BOB, stream_position: 20 }],
        sharedRoomUsers: [BOB],
      }),
    });
    const { status, body } = await syncRequest(env, 'since=s10_td0&timeout=5000');
    expect(status).toBe(200);
    expect(body.device_lists).toEqual({ changed: [BOB], left: [] });
    // hasChanges excludes device_lists → DO wait still runs
    expect(syncDo.fetches).toHaveLength(1);
  });

  it('to-device events skip DO wait even when device_lists also present', async () => {
    getToDeviceMessages.mockResolvedValue({
      events: [{ type: 'm.room_key_request', content: {}, sender: BOB }],
      nextBatch: '9',
    });
    const syncDo = createSyncDoStub();
    const env = createEnv({
      syncDo,
      db: createSyncDb({
        deviceKeyChanges: [{ user_id: BOB, stream_position: 20 }],
        sharedRoomUsers: [BOB],
      }),
    });
    const { body } = await syncRequest(env, 'since=s10_td0&timeout=5000');
    expect(body.device_lists).toEqual({ changed: [BOB], left: [] });
    expect(syncDo.fetches).toHaveLength(0);
  });

  it('account_data changes skip DO wait alongside device_lists', async () => {
    getGlobalAccountData.mockResolvedValue([{ type: 'm.direct', content: {} }]);
    const syncDo = createSyncDoStub();
    const env = createEnv({
      syncDo,
      db: createSyncDb({
        deviceKeyChanges: [{ user_id: USER, stream_position: 20 }],
        sharedRoomUsers: [],
      }),
    });
    const { body } = await syncRequest(env, 'since=s10_td0&timeout=8000');
    expect(body.device_lists).toEqual({ changed: [USER], left: [] });
    expect(syncDo.fetches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SQL binding / since token edges for device list stream
// ---------------------------------------------------------------------------

describe('GET /sync device_lists — since token + SQL args', () => {
  it('binds composite since event position into device_key_changes queries', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [{ user_id: BOB, stream_position: 100 }],
      sharedRoomUsers: [BOB],
    });
    const env = createEnv({ db });
    await syncRequest(env, 'since=s77_td3');
    const distinct = db.selects.find((s) => s.sql.includes('SELECT DISTINCT dkc.user_id'));
    expect(distinct?.args).toEqual([77, USER, USER]);
    const selfCount = db.selects.find(
      (s) => s.sql.includes('COUNT(*)') && s.sql.includes('device_key_changes')
    );
    expect(selfCount?.args).toEqual([77, USER]);
  });

  it('legacy numeric since drives device list sincePosition', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [{ user_id: BOB, stream_position: 8 }],
      sharedRoomUsers: [BOB],
    });
    const env = createEnv({ db });
    const { body } = await syncRequest(env, 'since=7');
    expect(body.device_lists).toEqual({ changed: [BOB], left: [] });
    const distinct = db.selects.find((s) => s.sql.includes('SELECT DISTINCT dkc.user_id'));
    expect(distinct?.args?.[0]).toBe(7);
  });

  for (const since of ['s1_td0', 's2_td0', 's3_td0', 's4_td0', 's5_td0']) {
    it(`fresh peer delta with since=${since}`, async () => {
      const sincePos = Number(since.match(/^s(\d+)/)?.[1]);
      const env = createEnv({
        db: createSyncDb({
          deviceKeyChanges: [{ user_id: BOB, stream_position: sincePos + 1 }],
          sharedRoomUsers: [BOB],
        }),
      });
      const { body } = await syncRequest(env, `since=${since}`);
      expect(body.device_lists).toEqual({ changed: [BOB], left: [] });
    });
  }
});
