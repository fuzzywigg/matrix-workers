/**
 * TOKENMAXX HEAVY leftovers after #157 — sync + sliding-sync soft/edge/reliability.
 * Complements sync-api-routes + sliding-sync-api-routes. Tests-only — no product inventing.
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

const getToDeviceMessages = vi.fn();
const getGlobalAccountData = vi.fn();
const getRoomAccountData = vi.fn();
const getE2EEAccountDataFromDO = vi.fn(async (): Promise<Record<string, unknown>> => ({}));
const getReceiptsForRoom = vi.fn();
const getReceiptsForRooms = vi.fn(
  async (_env: unknown, roomIds: string[]): Promise<Record<string, Record<string, unknown>>> => {
    const out: Record<string, Record<string, unknown>> = {};
    for (const id of roomIds) out[id] = {};
    return out;
  }
);
const getTypingUsers = vi.fn();
const getTypingForRooms = vi.fn(
  async (_env: unknown, roomIds: string[]): Promise<Record<string, string[]>> => {
    const out: Record<string, string[]> = {};
    for (const id of roomIds) out[id] = [];
    return out;
  }
);

vi.mock('../src/api/to-device', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/to-device')>();
  return {
    ...actual,
    getToDeviceMessages: (...args: unknown[]) => getToDeviceMessages(...args),
  };
});

vi.mock('../src/api/account-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/account-data')>();
  return {
    ...actual,
    getGlobalAccountData: (...args: unknown[]) => getGlobalAccountData(...args),
    getRoomAccountData: (...args: unknown[]) => getRoomAccountData(...args),
    getE2EEAccountDataFromDO: (...args: unknown[]) => getE2EEAccountDataFromDO(...args),
  };
});

vi.mock('../src/api/receipts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/receipts')>();
  return {
    ...actual,
    getReceiptsForRoom: (...args: unknown[]) => getReceiptsForRoom(...args),
    getReceiptsForRooms: (...args: unknown[]) =>
      getReceiptsForRooms(...(args as [unknown, string[], string?])),
  };
});

vi.mock('../src/api/typing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/typing')>();
  return {
    ...actual,
    getTypingUsers: (...args: unknown[]) => getTypingUsers(...args),
    getTypingForRooms: (...args: unknown[]) =>
      getTypingForRooms(...(args as [unknown, string[]])),
  };
});

import syncApp from '../src/api/sync';
import slidingSyncApp from '../src/api/sliding-sync';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const DEVICE = 'DEVICEA';

const MSC3575 = '/_matrix/client/unstable/org.matrix.msc3575/sync';
const MSC4186 = '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync';
const V4 = '/_matrix/client/v4/sync';

type SqlCall = { sql: string; args: unknown[] };
type OtkCount = { algorithm: string; count: number };
type FallbackAlgo = { algorithm: string };
type DeviceKeyChange = { user_id: string; stream_position: number };
type KvPut = { key: string; value: string; options?: { expirationTtl?: number } };

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

function createClientSyncDoStub(opts: { hasEvents?: boolean; fail?: boolean } = {}) {
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

type ClientSyncDoStub = ReturnType<typeof createClientSyncDoStub>;

function createSlidingSyncDoStub(
  opts: {
    states?: Record<string, ConnectionState | null>;
    getFail?: boolean;
    getStatus?: number;
    waitHasEvents?: boolean;
    waitFail?: boolean;
    saveFail?: boolean;
  } = {}
) {
  const states: Record<string, ConnectionState | null> = { ...(opts.states ?? {}) };
  const fetches: SyncDoFetch[] = [];
  const saves: { connId: string; state: ConnectionState }[] = [];

  return {
    states,
    fetches,
    saves,
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

type SlidingSyncDoStub = ReturnType<typeof createSlidingSyncDoStub>;

function createUserKeysStub(opts: { deviceIds?: string[]; crossSigning?: Record<string, unknown> } = {}) {
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

function createSlidingDb(opts: { maxStreamPos?: number | null } = {}) {
  const maxStreamPos = opts.maxStreamPos === undefined ? 42 : opts.maxStreamPos;
  const selects: SqlCall[] = [];

  const db = {
    selects,
    prepare(sql: string) {
      const makeStmt = (args: unknown[] = []) => ({
        sql,
        args,
        async first<T>() {
          selects.push({ sql, args });
          if (sql.includes('MAX(stream_ordering)') && sql.includes('FROM events') && !sql.includes('WHERE')) {
            return { max_pos: maxStreamPos } as T;
          }
          return null as T;
        },
        async all<T>() {
          selects.push({ sql, args });
          if (
            sql.includes('FROM room_memberships rm') &&
            sql.includes('JOIN rooms r') &&
            sql.includes('rm.user_id = ?')
          ) {
            return { results: [] as T[] };
          }
          if (
            sql.includes('SELECT room_id FROM room_memberships') &&
            sql.includes("membership = 'join'")
          ) {
            return { results: [] as T[] };
          }
          if (sql.includes('FROM one_time_keys') && sql.includes('GROUP BY algorithm')) {
            return { results: [] as T[] };
          }
          if (sql.includes('FROM fallback_keys') && sql.includes('DISTINCT algorithm')) {
            return { results: [] as T[] };
          }
          if (
            sql.includes('FROM device_key_changes dkc') &&
            sql.includes('SELECT DISTINCT dkc.user_id')
          ) {
            return { results: [] as T[] };
          }
          if (
            sql.includes('SELECT event_type, content FROM account_data') &&
            sql.includes("room_id = ''")
          ) {
            return { results: [] as T[] };
          }
          return { results: [] as T[] };
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

function createSyncEnv(opts: {
  db?: SyncDb;
  cache?: ReturnType<typeof mockKv>;
  syncDo?: ClientSyncDoStub;
} = {}) {
  const db = opts.db ?? createSyncDb();
  const cache = opts.cache ?? mockKv();
  const syncDo = opts.syncDo ?? createClientSyncDoStub();
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

function createSlidingEnv(opts: {
  db?: SlidingDb;
  cache?: ReturnType<typeof mockKv>;
  syncDo?: SlidingSyncDoStub;
  userKeys?: UserKeysStub;
} = {}) {
  const db = opts.db ?? createSlidingDb();
  const cache = opts.cache ?? mockKv();
  const syncDo = opts.syncDo ?? createSlidingSyncDoStub();
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

async function postSliding(
  path: string,
  env: Env,
  body: unknown,
  init: { query?: string; headers?: Record<string, string>; method?: string } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = `http://localhost${path}${init.query ? `?${init.query}` : ''}`;
  const method = init.method ?? 'POST';
  const res = await slidingSyncApp.request(
    url,
    {
      method,
      headers: {
        ...(body !== undefined && method !== 'GET' && method !== 'DELETE'
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(init.headers ?? {}),
      },
      body:
        body === undefined
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
  getReceiptsForRoom.mockReset().mockResolvedValue({ type: 'm.receipt', content: {} });
  getTypingUsers.mockReset().mockResolvedValue([]);
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
  getE2EEAccountDataFromDO.mockReset().mockResolvedValue({});
}

beforeEach(() => {
  resetMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});


describe('sync leftovers GET /v3/sync empty rooms soft flood after #157', () => {
  it('empty rooms soft-0', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.next_batch).toBe('s42_td0');
  });
  it('empty rooms soft-1', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.next_batch).toBe('s42_td0');
  });
  it('empty rooms soft-2', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.next_batch).toBe('s42_td0');
  });
  it('empty rooms soft-3', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.next_batch).toBe('s42_td0');
  });
  it('empty rooms soft-4', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.next_batch).toBe('s42_td0');
  });
  it('empty rooms soft-5', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.next_batch).toBe('s42_td0');
  });
  it('empty rooms soft-6', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.next_batch).toBe('s42_td0');
  });
  it('empty rooms soft-7', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.next_batch).toBe('s42_td0');
  });
  it('empty rooms soft-8', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.next_batch).toBe('s42_td0');
  });
  it('empty rooms soft-9', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.next_batch).toBe('s42_td0');
  });
  it('empty rooms soft-10', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.next_batch).toBe('s42_td0');
  });
  it('empty rooms soft-11', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.next_batch).toBe('s42_td0');
  });
  it('empty rooms soft-12', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.next_batch).toBe('s42_td0');
  });
  it('empty rooms soft-13', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.next_batch).toBe('s42_td0');
  });
  it('empty rooms soft-14', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.next_batch).toBe('s42_td0');
  });
  it('empty rooms soft-15', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.next_batch).toBe('s42_td0');
  });
  it('empty rooms soft-16', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.next_batch).toBe('s42_td0');
  });
  it('empty rooms soft-17', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.next_batch).toBe('s42_td0');
  });
  it('empty rooms soft-18', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.next_batch).toBe('s42_td0');
  });
  it('empty rooms soft-19', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env);
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
    expect(body.next_batch).toBe('s42_td0');
  });
});

describe('sync leftovers timeout=0 query soft flood after #157', () => {
  it('timeout=0 soft-0', async () => {
    const syncDo = createClientSyncDoStub();
    const env = createSyncEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s10_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-1', async () => {
    const syncDo = createClientSyncDoStub();
    const env = createSyncEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s10_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-2', async () => {
    const syncDo = createClientSyncDoStub();
    const env = createSyncEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s10_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-3', async () => {
    const syncDo = createClientSyncDoStub();
    const env = createSyncEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s10_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-4', async () => {
    const syncDo = createClientSyncDoStub();
    const env = createSyncEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s10_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-5', async () => {
    const syncDo = createClientSyncDoStub();
    const env = createSyncEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s10_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-6', async () => {
    const syncDo = createClientSyncDoStub();
    const env = createSyncEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s10_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-7', async () => {
    const syncDo = createClientSyncDoStub();
    const env = createSyncEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s10_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-8', async () => {
    const syncDo = createClientSyncDoStub();
    const env = createSyncEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s10_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-9', async () => {
    const syncDo = createClientSyncDoStub();
    const env = createSyncEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s10_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-10', async () => {
    const syncDo = createClientSyncDoStub();
    const env = createSyncEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s10_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-11', async () => {
    const syncDo = createClientSyncDoStub();
    const env = createSyncEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s10_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-12', async () => {
    const syncDo = createClientSyncDoStub();
    const env = createSyncEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s10_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-13', async () => {
    const syncDo = createClientSyncDoStub();
    const env = createSyncEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s10_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-14', async () => {
    const syncDo = createClientSyncDoStub();
    const env = createSyncEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s10_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
  it('timeout=0 soft-15', async () => {
    const syncDo = createClientSyncDoStub();
    const env = createSyncEnv({ syncDo });
    const { status, body } = await syncRequest(env, 'since=s10_td0&timeout=0');
    expect(status).toBe(200);
    expect(syncDo.fetches).toHaveLength(0);
    expect(body.next_batch).toBe('s42_td0');
  });
});

describe('sync leftovers full_state=true soft flood after #157', () => {
  it('full_state=true soft-0', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td1&full_state=true');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('full_state=true soft-1', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td1&full_state=true');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('full_state=true soft-2', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td1&full_state=true');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('full_state=true soft-3', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td1&full_state=true');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('full_state=true soft-4', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td1&full_state=true');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('full_state=true soft-5', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td1&full_state=true');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('full_state=true soft-6', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td1&full_state=true');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('full_state=true soft-7', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td1&full_state=true');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('full_state=true soft-8', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td1&full_state=true');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('full_state=true soft-9', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td1&full_state=true');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('full_state=true soft-10', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td1&full_state=true');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('full_state=true soft-11', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td1&full_state=true');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
});

describe('sync leftovers full_state=false soft flood after #157', () => {
  it('full_state=false soft-0', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td1&full_state=false');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('full_state=false soft-1', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td1&full_state=false');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('full_state=false soft-2', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td1&full_state=false');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('full_state=false soft-3', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td1&full_state=false');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('full_state=false soft-4', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td1&full_state=false');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('full_state=false soft-5', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td1&full_state=false');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('full_state=false soft-6', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td1&full_state=false');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('full_state=false soft-7', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td1&full_state=false');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('full_state=false soft-8', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td1&full_state=false');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('full_state=false soft-9', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td1&full_state=false');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('full_state=false soft-10', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td1&full_state=false');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('full_state=false soft-11', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s5_td1&full_state=false');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
});

describe('sync leftovers since= query variants soft flood after #157', () => {
  it('since variant soft-0', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, '');
    expect(status).toBe(200);
    expect(typeof body.next_batch).toBe('string');
    expect((body.next_batch as string).length).toBeGreaterThan(0);
  });
  it('since variant soft-1', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=0');
    expect(status).toBe(200);
    expect(typeof body.next_batch).toBe('string');
    expect((body.next_batch as string).length).toBeGreaterThan(0);
  });
  it('since variant soft-2', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s0_td0');
    expect(status).toBe(200);
    expect(typeof body.next_batch).toBe('string');
    expect((body.next_batch as string).length).toBeGreaterThan(0);
  });
  it('since variant soft-3', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s10_td2');
    expect(status).toBe(200);
    expect(typeof body.next_batch).toBe('string');
    expect((body.next_batch as string).length).toBeGreaterThan(0);
  });
  it('since variant soft-4', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=7');
    expect(status).toBe(200);
    expect(typeof body.next_batch).toBe('string');
    expect((body.next_batch as string).length).toBeGreaterThan(0);
  });
  it('since variant soft-5', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=not-a-token');
    expect(status).toBe(200);
    expect(typeof body.next_batch).toBe('string');
    expect((body.next_batch as string).length).toBeGreaterThan(0);
  });
  it('since variant soft-6', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s999_td0');
    expect(status).toBe(200);
    expect(typeof body.next_batch).toBe('string');
    expect((body.next_batch as string).length).toBeGreaterThan(0);
  });
  it('since variant soft-7', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s0_td999');
    expect(status).toBe(200);
    expect(typeof body.next_batch).toBe('string');
    expect((body.next_batch as string).length).toBeGreaterThan(0);
  });
  it('since variant soft-8', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s42_td42');
    expect(status).toBe(200);
    expect(typeof body.next_batch).toBe('string');
    expect((body.next_batch as string).length).toBeGreaterThan(0);
  });
  it('since variant soft-9', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s1_td0');
    expect(status).toBe(200);
    expect(typeof body.next_batch).toBe('string');
    expect((body.next_batch as string).length).toBeGreaterThan(0);
  });
  it('since variant soft-10', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s0_td1');
    expect(status).toBe(200);
    expect(typeof body.next_batch).toBe('string');
    expect((body.next_batch as string).length).toBeGreaterThan(0);
  });
  it('since variant soft-11', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=S10_TD2');
    expect(status).toBe(200);
    expect(typeof body.next_batch).toBe('string');
    expect((body.next_batch as string).length).toBeGreaterThan(0);
  });
  it('since variant soft-12', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s10');
    expect(status).toBe(200);
    expect(typeof body.next_batch).toBe('string');
    expect((body.next_batch as string).length).toBeGreaterThan(0);
  });
  it('since variant soft-13', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=_td0');
    expect(status).toBe(200);
    expect(typeof body.next_batch).toBe('string');
    expect((body.next_batch as string).length).toBeGreaterThan(0);
  });
  it('since variant soft-14', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s10_td');
    expect(status).toBe(200);
    expect(typeof body.next_batch).toBe('string');
    expect((body.next_batch as string).length).toBeGreaterThan(0);
  });
  it('since variant soft-15', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'since=s_td5');
    expect(status).toBe(200);
    expect(typeof body.next_batch).toBe('string');
    expect((body.next_batch as string).length).toBeGreaterThan(0);
  });
});

describe('sync leftovers filter id missing soft flood after #157', () => {
  it('filter missing soft-0', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'filter=missing-filter-0');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('filter missing soft-1', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'filter=missing-filter-1');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('filter missing soft-2', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'filter=missing-filter-2');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('filter missing soft-3', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'filter=missing-filter-3');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('filter missing soft-4', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'filter=missing-filter-4');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('filter missing soft-5', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'filter=missing-filter-5');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('filter missing soft-6', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'filter=missing-filter-6');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('filter missing soft-7', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'filter=missing-filter-7');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('filter missing soft-8', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'filter=missing-filter-8');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('filter missing soft-9', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'filter=missing-filter-9');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('filter missing soft-10', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'filter=missing-filter-10');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('filter missing soft-11', async () => {
    const env = createSyncEnv();
    const { status, body } = await syncRequest(env, 'filter=missing-filter-11');
    expect(status).toBe(200);
    expect(body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
});

describe('sync leftovers wrong HTTP method matrix after #157', () => {
  it('POST soft-0', async () => {
    const env = createSyncEnv();
    const { status } = await syncRequest(env, '', { method: 'POST' });
    expect(status).toBe(404);
  });
  it('POST soft-1', async () => {
    const env = createSyncEnv();
    const { status } = await syncRequest(env, '', { method: 'POST' });
    expect(status).toBe(404);
  });
  it('POST soft-2', async () => {
    const env = createSyncEnv();
    const { status } = await syncRequest(env, '', { method: 'POST' });
    expect(status).toBe(404);
  });
  it('PUT soft-0', async () => {
    const env = createSyncEnv();
    const { status } = await syncRequest(env, '', { method: 'PUT' });
    expect(status).toBe(404);
  });
  it('PUT soft-1', async () => {
    const env = createSyncEnv();
    const { status } = await syncRequest(env, '', { method: 'PUT' });
    expect(status).toBe(404);
  });
  it('PUT soft-2', async () => {
    const env = createSyncEnv();
    const { status } = await syncRequest(env, '', { method: 'PUT' });
    expect(status).toBe(404);
  });
  it('DELETE soft-0', async () => {
    const env = createSyncEnv();
    const { status } = await syncRequest(env, '', { method: 'DELETE' });
    expect(status).toBe(404);
  });
  it('DELETE soft-1', async () => {
    const env = createSyncEnv();
    const { status } = await syncRequest(env, '', { method: 'DELETE' });
    expect(status).toBe(404);
  });
  it('DELETE soft-2', async () => {
    const env = createSyncEnv();
    const { status } = await syncRequest(env, '', { method: 'DELETE' });
    expect(status).toBe(404);
  });
  it('PATCH soft-0', async () => {
    const env = createSyncEnv();
    const { status } = await syncRequest(env, '', { method: 'PATCH' });
    expect(status).toBe(404);
  });
  it('PATCH soft-1', async () => {
    const env = createSyncEnv();
    const { status } = await syncRequest(env, '', { method: 'PATCH' });
    expect(status).toBe(404);
  });
  it('PATCH soft-2', async () => {
    const env = createSyncEnv();
    const { status } = await syncRequest(env, '', { method: 'PATCH' });
    expect(status).toBe(404);
  });
});

describe('sync leftovers DO fail soft when timeout>0 long-poll after #157', () => {
  it('DO fail soft-0', async () => {
    const syncDo = createClientSyncDoStub({ fail: true });
    const env = createSyncEnv({ syncDo });
    const { status } = await syncRequest(env, 'since=s10_td0&timeout=1000');
    expect(status).toBe(500);
    expect(syncDo.fetches.length).toBeGreaterThanOrEqual(1);
  });
  it('DO fail soft-1', async () => {
    const syncDo = createClientSyncDoStub({ fail: true });
    const env = createSyncEnv({ syncDo });
    const { status } = await syncRequest(env, 'since=s10_td0&timeout=1100');
    expect(status).toBe(500);
    expect(syncDo.fetches.length).toBeGreaterThanOrEqual(1);
  });
  it('DO fail soft-2', async () => {
    const syncDo = createClientSyncDoStub({ fail: true });
    const env = createSyncEnv({ syncDo });
    const { status } = await syncRequest(env, 'since=s10_td0&timeout=1200');
    expect(status).toBe(500);
    expect(syncDo.fetches.length).toBeGreaterThanOrEqual(1);
  });
  it('DO fail soft-3', async () => {
    const syncDo = createClientSyncDoStub({ fail: true });
    const env = createSyncEnv({ syncDo });
    const { status } = await syncRequest(env, 'since=s10_td0&timeout=1300');
    expect(status).toBe(500);
    expect(syncDo.fetches.length).toBeGreaterThanOrEqual(1);
  });
  it('DO fail soft-4', async () => {
    const syncDo = createClientSyncDoStub({ fail: true });
    const env = createSyncEnv({ syncDo });
    const { status } = await syncRequest(env, 'since=s10_td0&timeout=1400');
    expect(status).toBe(500);
    expect(syncDo.fetches.length).toBeGreaterThanOrEqual(1);
  });
  it('DO fail soft-5', async () => {
    const syncDo = createClientSyncDoStub({ fail: true });
    const env = createSyncEnv({ syncDo });
    const { status } = await syncRequest(env, 'since=s10_td0&timeout=1500');
    expect(status).toBe(500);
    expect(syncDo.fetches.length).toBeGreaterThanOrEqual(1);
  });
  it('DO fail soft-6', async () => {
    const syncDo = createClientSyncDoStub({ fail: true });
    const env = createSyncEnv({ syncDo });
    const { status } = await syncRequest(env, 'since=s10_td0&timeout=1600');
    expect(status).toBe(500);
    expect(syncDo.fetches.length).toBeGreaterThanOrEqual(1);
  });
  it('DO fail soft-7', async () => {
    const syncDo = createClientSyncDoStub({ fail: true });
    const env = createSyncEnv({ syncDo });
    const { status } = await syncRequest(env, 'since=s10_td0&timeout=1700');
    expect(status).toBe(500);
    expect(syncDo.fetches.length).toBeGreaterThanOrEqual(1);
  });
  it('DO fail soft-8', async () => {
    const syncDo = createClientSyncDoStub({ fail: true });
    const env = createSyncEnv({ syncDo });
    const { status } = await syncRequest(env, 'since=s10_td0&timeout=1800');
    expect(status).toBe(500);
    expect(syncDo.fetches.length).toBeGreaterThanOrEqual(1);
  });
  it('DO fail soft-9', async () => {
    const syncDo = createClientSyncDoStub({ fail: true });
    const env = createSyncEnv({ syncDo });
    const { status } = await syncRequest(env, 'since=s10_td0&timeout=1900');
    expect(status).toBe(500);
    expect(syncDo.fetches.length).toBeGreaterThanOrEqual(1);
  });
  it('DO fail soft-10', async () => {
    const syncDo = createClientSyncDoStub({ fail: true });
    const env = createSyncEnv({ syncDo });
    const { status } = await syncRequest(env, 'since=s10_td0&timeout=2000');
    expect(status).toBe(500);
    expect(syncDo.fetches.length).toBeGreaterThanOrEqual(1);
  });
  it('DO fail soft-11', async () => {
    const syncDo = createClientSyncDoStub({ fail: true });
    const env = createSyncEnv({ syncDo });
    const { status } = await syncRequest(env, 'since=s10_td0&timeout=2100');
    expect(status).toBe(500);
    expect(syncDo.fetches.length).toBeGreaterThanOrEqual(1);
  });
});

describe('sync leftovers lifecycle repeated empty sync after #157', () => {
  it('lifecycle empty soft-0', async () => {
    const env = createSyncEnv();
    const r1 = await syncRequest(env);
    expect(r1.status).toBe(200);
    const token = r1.body.next_batch as string;
    const r2 = await syncRequest(env, `since=${encodeURIComponent(token)}`);
    expect(r2.status).toBe(200);
    expect(r2.body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('lifecycle empty soft-1', async () => {
    const env = createSyncEnv();
    const r1 = await syncRequest(env);
    expect(r1.status).toBe(200);
    const token = r1.body.next_batch as string;
    const r2 = await syncRequest(env, `since=${encodeURIComponent(token)}`);
    expect(r2.status).toBe(200);
    expect(r2.body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('lifecycle empty soft-2', async () => {
    const env = createSyncEnv();
    const r1 = await syncRequest(env);
    expect(r1.status).toBe(200);
    const token = r1.body.next_batch as string;
    const r2 = await syncRequest(env, `since=${encodeURIComponent(token)}`);
    expect(r2.status).toBe(200);
    expect(r2.body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('lifecycle empty soft-3', async () => {
    const env = createSyncEnv();
    const r1 = await syncRequest(env);
    expect(r1.status).toBe(200);
    const token = r1.body.next_batch as string;
    const r2 = await syncRequest(env, `since=${encodeURIComponent(token)}`);
    expect(r2.status).toBe(200);
    expect(r2.body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('lifecycle empty soft-4', async () => {
    const env = createSyncEnv();
    const r1 = await syncRequest(env);
    expect(r1.status).toBe(200);
    const token = r1.body.next_batch as string;
    const r2 = await syncRequest(env, `since=${encodeURIComponent(token)}`);
    expect(r2.status).toBe(200);
    expect(r2.body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('lifecycle empty soft-5', async () => {
    const env = createSyncEnv();
    const r1 = await syncRequest(env);
    expect(r1.status).toBe(200);
    const token = r1.body.next_batch as string;
    const r2 = await syncRequest(env, `since=${encodeURIComponent(token)}`);
    expect(r2.status).toBe(200);
    expect(r2.body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('lifecycle empty soft-6', async () => {
    const env = createSyncEnv();
    const r1 = await syncRequest(env);
    expect(r1.status).toBe(200);
    const token = r1.body.next_batch as string;
    const r2 = await syncRequest(env, `since=${encodeURIComponent(token)}`);
    expect(r2.status).toBe(200);
    expect(r2.body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('lifecycle empty soft-7', async () => {
    const env = createSyncEnv();
    const r1 = await syncRequest(env);
    expect(r1.status).toBe(200);
    const token = r1.body.next_batch as string;
    const r2 = await syncRequest(env, `since=${encodeURIComponent(token)}`);
    expect(r2.status).toBe(200);
    expect(r2.body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('lifecycle empty soft-8', async () => {
    const env = createSyncEnv();
    const r1 = await syncRequest(env);
    expect(r1.status).toBe(200);
    const token = r1.body.next_batch as string;
    const r2 = await syncRequest(env, `since=${encodeURIComponent(token)}`);
    expect(r2.status).toBe(200);
    expect(r2.body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('lifecycle empty soft-9', async () => {
    const env = createSyncEnv();
    const r1 = await syncRequest(env);
    expect(r1.status).toBe(200);
    const token = r1.body.next_batch as string;
    const r2 = await syncRequest(env, `since=${encodeURIComponent(token)}`);
    expect(r2.status).toBe(200);
    expect(r2.body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('lifecycle empty soft-10', async () => {
    const env = createSyncEnv();
    const r1 = await syncRequest(env);
    expect(r1.status).toBe(200);
    const token = r1.body.next_batch as string;
    const r2 = await syncRequest(env, `since=${encodeURIComponent(token)}`);
    expect(r2.status).toBe(200);
    expect(r2.body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('lifecycle empty soft-11', async () => {
    const env = createSyncEnv();
    const r1 = await syncRequest(env);
    expect(r1.status).toBe(200);
    const token = r1.body.next_batch as string;
    const r2 = await syncRequest(env, `since=${encodeURIComponent(token)}`);
    expect(r2.status).toBe(200);
    expect(r2.body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('lifecycle empty soft-12', async () => {
    const env = createSyncEnv();
    const r1 = await syncRequest(env);
    expect(r1.status).toBe(200);
    const token = r1.body.next_batch as string;
    const r2 = await syncRequest(env, `since=${encodeURIComponent(token)}`);
    expect(r2.status).toBe(200);
    expect(r2.body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('lifecycle empty soft-13', async () => {
    const env = createSyncEnv();
    const r1 = await syncRequest(env);
    expect(r1.status).toBe(200);
    const token = r1.body.next_batch as string;
    const r2 = await syncRequest(env, `since=${encodeURIComponent(token)}`);
    expect(r2.status).toBe(200);
    expect(r2.body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('lifecycle empty soft-14', async () => {
    const env = createSyncEnv();
    const r1 = await syncRequest(env);
    expect(r1.status).toBe(200);
    const token = r1.body.next_batch as string;
    const r2 = await syncRequest(env, `since=${encodeURIComponent(token)}`);
    expect(r2.status).toBe(200);
    expect(r2.body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
  it('lifecycle empty soft-15', async () => {
    const env = createSyncEnv();
    const r1 = await syncRequest(env);
    expect(r1.status).toBe(200);
    const token = r1.body.next_batch as string;
    const r2 = await syncRequest(env, `since=${encodeURIComponent(token)}`);
    expect(r2.status).toBe(200);
    expect(r2.body.rooms).toEqual({ join: {}, invite: {}, leave: {} });
  });
});

describe('sliding leftovers MSC3575 empty body soft flood after #157', () => {
  it('empty {} soft-0', async () => {
    const env = createSlidingEnv({ db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding('/_matrix/client/unstable/org.matrix.msc3575/sync', env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('empty {} soft-1', async () => {
    const env = createSlidingEnv({ db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding('/_matrix/client/unstable/org.matrix.msc3575/sync', env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('empty {} soft-2', async () => {
    const env = createSlidingEnv({ db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding('/_matrix/client/unstable/org.matrix.msc3575/sync', env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('empty {} soft-3', async () => {
    const env = createSlidingEnv({ db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding('/_matrix/client/unstable/org.matrix.msc3575/sync', env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('empty {} soft-4', async () => {
    const env = createSlidingEnv({ db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding('/_matrix/client/unstable/org.matrix.msc3575/sync', env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('empty {} soft-5', async () => {
    const env = createSlidingEnv({ db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding('/_matrix/client/unstable/org.matrix.msc3575/sync', env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
});

describe('sliding leftovers MSC4186 empty body soft flood after #157', () => {
  it('empty {} soft-0', async () => {
    const env = createSlidingEnv({ db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('empty {} soft-1', async () => {
    const env = createSlidingEnv({ db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('empty {} soft-2', async () => {
    const env = createSlidingEnv({ db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('empty {} soft-3', async () => {
    const env = createSlidingEnv({ db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('empty {} soft-4', async () => {
    const env = createSlidingEnv({ db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('empty {} soft-5', async () => {
    const env = createSlidingEnv({ db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
});

describe('sliding leftovers v4 empty body soft flood after #157', () => {
  it('empty {} soft-0', async () => {
    const env = createSlidingEnv({ db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding('/_matrix/client/v4/sync', env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('empty {} soft-1', async () => {
    const env = createSlidingEnv({ db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding('/_matrix/client/v4/sync', env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('empty {} soft-2', async () => {
    const env = createSlidingEnv({ db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding('/_matrix/client/v4/sync', env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('empty {} soft-3', async () => {
    const env = createSlidingEnv({ db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding('/_matrix/client/v4/sync', env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('empty {} soft-4', async () => {
    const env = createSlidingEnv({ db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding('/_matrix/client/v4/sync', env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('empty {} soft-5', async () => {
    const env = createSlidingEnv({ db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding('/_matrix/client/v4/sync', env, {});
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
});

describe('sliding leftovers MSC3575 lists+subs empty soft flood after #157', () => {
  it('lists subs empty soft-0', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding('/_matrix/client/unstable/org.matrix.msc3575/sync', env, { lists: {}, room_subscriptions: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('lists subs empty soft-1', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding('/_matrix/client/unstable/org.matrix.msc3575/sync', env, { lists: {}, room_subscriptions: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('lists subs empty soft-2', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding('/_matrix/client/unstable/org.matrix.msc3575/sync', env, { lists: {}, room_subscriptions: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('lists subs empty soft-3', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding('/_matrix/client/unstable/org.matrix.msc3575/sync', env, { lists: {}, room_subscriptions: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('lists subs empty soft-4', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding('/_matrix/client/unstable/org.matrix.msc3575/sync', env, { lists: {}, room_subscriptions: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('lists subs empty soft-5', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding('/_matrix/client/unstable/org.matrix.msc3575/sync', env, { lists: {}, room_subscriptions: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
});

describe('sliding leftovers MSC4186 lists+subs empty soft flood after #157', () => {
  it('lists subs empty soft-0', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', env, { lists: {}, room_subscriptions: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('lists subs empty soft-1', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', env, { lists: {}, room_subscriptions: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('lists subs empty soft-2', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', env, { lists: {}, room_subscriptions: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('lists subs empty soft-3', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', env, { lists: {}, room_subscriptions: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('lists subs empty soft-4', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', env, { lists: {}, room_subscriptions: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('lists subs empty soft-5', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', env, { lists: {}, room_subscriptions: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
});

describe('sliding leftovers v4 lists+subs empty soft flood after #157', () => {
  it('lists subs empty soft-0', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding('/_matrix/client/v4/sync', env, { lists: {}, room_subscriptions: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('lists subs empty soft-1', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding('/_matrix/client/v4/sync', env, { lists: {}, room_subscriptions: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('lists subs empty soft-2', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding('/_matrix/client/v4/sync', env, { lists: {}, room_subscriptions: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('lists subs empty soft-3', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding('/_matrix/client/v4/sync', env, { lists: {}, room_subscriptions: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('lists subs empty soft-4', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding('/_matrix/client/v4/sync', env, { lists: {}, room_subscriptions: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
  it('lists subs empty soft-5', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding('/_matrix/client/v4/sync', env, { lists: {}, room_subscriptions: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
    expect(body.lists).toEqual({});
    expect(body.rooms).toEqual({});
  });
});

describe('sliding leftovers Content-Type charset soft grid after #157', () => {
  it('charset soft-0', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding(MSC3575, env, {}, { headers: { 'Content-Type': 'application/json' } });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
  });
  it('charset soft-1', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding(MSC3575, env, {}, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
  });
  it('charset soft-2', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding(MSC3575, env, {}, { headers: { 'Content-Type': 'application/json;charset=UTF-8' } });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
  });
  it('charset soft-3', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding(MSC3575, env, {}, { headers: { 'Content-Type': 'application/json; charset="utf-8"' } });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
  });
  it('charset soft-4', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding(MSC3575, env, {}, { headers: { 'Content-Type': 'application/json; charset=iso-8859-1' } });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
  });
  it('charset soft-5', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding(MSC3575, env, {}, { headers: { 'Content-Type': 'text/json' } });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
  });
  it('charset soft-6', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding(MSC3575, env, {}, { headers: { 'Content-Type': 'application/json; boundary=something' } });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
  });
  it('charset soft-7', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding(MSC3575, env, {}, { headers: { 'Content-Type': 'application/json; charset=utf-8; profile=matrix' } });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
  });
  it('charset soft-8', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding(MSC3575, env, {}, { headers: { 'Content-Type': 'application/JSON' } });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
  });
  it('charset soft-9', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding(MSC3575, env, {}, { headers: { 'Content-Type': 'application/json ' } });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
  });
  it('charset soft-10', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding(MSC3575, env, {}, { headers: { 'Content-Type': 'application/json; charset=us-ascii' } });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
  });
  it('charset soft-11', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding(MSC3575, env, {}, { headers: { 'Content-Type': 'application/vnd.matrix+json' } });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
  });
});

describe('sliding leftovers corrupt JSON soft flood after #157', () => {
  it('corrupt JSON soft-0', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding(MSC3575, env, "{not-json");
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('corrupt JSON soft-1', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding(MSC3575, env, "{\"lists\":");
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('corrupt JSON soft-2', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding(MSC3575, env, "{\"unclosed\":");
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('corrupt JSON soft-3', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding(MSC3575, env, "{");
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('corrupt JSON soft-4', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding(MSC3575, env, "}");
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('corrupt JSON soft-5', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding(MSC3575, env, "undefined");
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('corrupt JSON soft-6', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding(MSC3575, env, "not json at all");
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('corrupt JSON soft-7', async () => {
    const env = createSlidingEnv();
    const { status, body } = await postSliding(MSC3575, env, "{\"trailing\":,}");
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
});

describe('sliding leftovers MSC3575 wrong HTTP methods after #157', () => {
  it('GET soft-0', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/unstable/org.matrix.msc3575/sync', env, undefined, { method: 'GET' });
    expect(status).toBe(404);
  });
  it('GET soft-1', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/unstable/org.matrix.msc3575/sync', env, undefined, { method: 'GET' });
    expect(status).toBe(404);
  });
  it('GET soft-2', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/unstable/org.matrix.msc3575/sync', env, undefined, { method: 'GET' });
    expect(status).toBe(404);
  });
  it('GET soft-3', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/unstable/org.matrix.msc3575/sync', env, undefined, { method: 'GET' });
    expect(status).toBe(404);
  });
  it('PUT soft-0', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/unstable/org.matrix.msc3575/sync', env, undefined, { method: 'PUT' });
    expect(status).toBe(404);
  });
  it('PUT soft-1', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/unstable/org.matrix.msc3575/sync', env, undefined, { method: 'PUT' });
    expect(status).toBe(404);
  });
  it('PUT soft-2', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/unstable/org.matrix.msc3575/sync', env, undefined, { method: 'PUT' });
    expect(status).toBe(404);
  });
  it('PUT soft-3', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/unstable/org.matrix.msc3575/sync', env, undefined, { method: 'PUT' });
    expect(status).toBe(404);
  });
  it('DELETE soft-0', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/unstable/org.matrix.msc3575/sync', env, undefined, { method: 'DELETE' });
    expect(status).toBe(404);
  });
  it('DELETE soft-1', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/unstable/org.matrix.msc3575/sync', env, undefined, { method: 'DELETE' });
    expect(status).toBe(404);
  });
  it('DELETE soft-2', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/unstable/org.matrix.msc3575/sync', env, undefined, { method: 'DELETE' });
    expect(status).toBe(404);
  });
  it('DELETE soft-3', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/unstable/org.matrix.msc3575/sync', env, undefined, { method: 'DELETE' });
    expect(status).toBe(404);
  });
});

describe('sliding leftovers MSC4186 wrong HTTP methods after #157', () => {
  it('GET soft-0', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', env, undefined, { method: 'GET' });
    expect(status).toBe(404);
  });
  it('GET soft-1', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', env, undefined, { method: 'GET' });
    expect(status).toBe(404);
  });
  it('GET soft-2', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', env, undefined, { method: 'GET' });
    expect(status).toBe(404);
  });
  it('GET soft-3', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', env, undefined, { method: 'GET' });
    expect(status).toBe(404);
  });
  it('PUT soft-0', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', env, undefined, { method: 'PUT' });
    expect(status).toBe(404);
  });
  it('PUT soft-1', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', env, undefined, { method: 'PUT' });
    expect(status).toBe(404);
  });
  it('PUT soft-2', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', env, undefined, { method: 'PUT' });
    expect(status).toBe(404);
  });
  it('PUT soft-3', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', env, undefined, { method: 'PUT' });
    expect(status).toBe(404);
  });
  it('DELETE soft-0', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', env, undefined, { method: 'DELETE' });
    expect(status).toBe(404);
  });
  it('DELETE soft-1', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', env, undefined, { method: 'DELETE' });
    expect(status).toBe(404);
  });
  it('DELETE soft-2', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', env, undefined, { method: 'DELETE' });
    expect(status).toBe(404);
  });
  it('DELETE soft-3', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', env, undefined, { method: 'DELETE' });
    expect(status).toBe(404);
  });
});

describe('sliding leftovers v4 wrong HTTP methods after #157', () => {
  it('GET soft-0', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/v4/sync', env, undefined, { method: 'GET' });
    expect(status).toBe(404);
  });
  it('GET soft-1', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/v4/sync', env, undefined, { method: 'GET' });
    expect(status).toBe(404);
  });
  it('GET soft-2', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/v4/sync', env, undefined, { method: 'GET' });
    expect(status).toBe(404);
  });
  it('GET soft-3', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/v4/sync', env, undefined, { method: 'GET' });
    expect(status).toBe(404);
  });
  it('PUT soft-0', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/v4/sync', env, undefined, { method: 'PUT' });
    expect(status).toBe(404);
  });
  it('PUT soft-1', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/v4/sync', env, undefined, { method: 'PUT' });
    expect(status).toBe(404);
  });
  it('PUT soft-2', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/v4/sync', env, undefined, { method: 'PUT' });
    expect(status).toBe(404);
  });
  it('PUT soft-3', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/v4/sync', env, undefined, { method: 'PUT' });
    expect(status).toBe(404);
  });
  it('DELETE soft-0', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/v4/sync', env, undefined, { method: 'DELETE' });
    expect(status).toBe(404);
  });
  it('DELETE soft-1', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/v4/sync', env, undefined, { method: 'DELETE' });
    expect(status).toBe(404);
  });
  it('DELETE soft-2', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/v4/sync', env, undefined, { method: 'DELETE' });
    expect(status).toBe(404);
  });
  it('DELETE soft-3', async () => {
    const env = createSlidingEnv();
    const { status } = await postSliding('/_matrix/client/v4/sync', env, undefined, { method: 'DELETE' });
    expect(status).toBe(404);
  });
});

describe('sliding leftovers conn_id and pos happy-path soft variants after #157', () => {
  it('conn_id pos soft-0', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding(MSC4186, env, { conn_id: "phone" });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
  });
  it('conn_id pos soft-1', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding(MSC4186, env, { conn_id: "web" });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
  });
  it('conn_id pos soft-2', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding(MSC4186, env, { conn_id: "tablet" });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
  });
  it('conn_id pos soft-3', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding(MSC4186, env, { pos: "0" });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
  });
  it('conn_id pos soft-4', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding(MSC4186, env, { pos: "42" });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
  });
  it('conn_id pos soft-5', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding(MSC4186, env, { pos: "10", conn_id: "a" });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
  });
  it('conn_id pos soft-6', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding(MSC4186, env, { pos: "5", conn_id: "b" });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
  });
  it('conn_id pos soft-7', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding(MSC4186, env, { txn_id: "t1" });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
  });
  it('conn_id pos soft-8', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding(MSC4186, env, { txn_id: "t2", conn_id: "c" });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
  });
  it('conn_id pos soft-9', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding(MSC4186, env, {}, { query: 'conn_id=legacy' });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
  });
  it('conn_id pos soft-10', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding(MSC4186, env, { lists: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
  });
  it('conn_id pos soft-11', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 42 }) });
    const { status, body } = await postSliding(MSC4186, env, { room_subscriptions: {} });
    expect(status).toBe(200);
    expect(body.pos).toBe('42');
  });
});

describe('sliding leftovers lifecycle soft across three endpoints after #157', () => {
  it('lifecycle soft-0', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 11 }) });
    const paths = ['/_matrix/client/unstable/org.matrix.msc3575/sync', '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', '/_matrix/client/v4/sync'];
    let pos = '';
    for (const p of paths) {
      const r = await postSliding(p, env, pos ? { pos } : {});
      expect(r.status).toBe(200);
      pos = r.body.pos as string;
    }
    expect(pos).toBe('11');
    expect(syncDo.saves.length).toBeGreaterThanOrEqual(1);
  });
  it('lifecycle soft-1', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 11 }) });
    const paths = ['/_matrix/client/unstable/org.matrix.msc3575/sync', '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', '/_matrix/client/v4/sync'];
    let pos = '';
    for (const p of paths) {
      const r = await postSliding(p, env, pos ? { pos } : {});
      expect(r.status).toBe(200);
      pos = r.body.pos as string;
    }
    expect(pos).toBe('11');
    expect(syncDo.saves.length).toBeGreaterThanOrEqual(1);
  });
  it('lifecycle soft-2', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 11 }) });
    const paths = ['/_matrix/client/unstable/org.matrix.msc3575/sync', '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', '/_matrix/client/v4/sync'];
    let pos = '';
    for (const p of paths) {
      const r = await postSliding(p, env, pos ? { pos } : {});
      expect(r.status).toBe(200);
      pos = r.body.pos as string;
    }
    expect(pos).toBe('11');
    expect(syncDo.saves.length).toBeGreaterThanOrEqual(1);
  });
  it('lifecycle soft-3', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 11 }) });
    const paths = ['/_matrix/client/unstable/org.matrix.msc3575/sync', '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', '/_matrix/client/v4/sync'];
    let pos = '';
    for (const p of paths) {
      const r = await postSliding(p, env, pos ? { pos } : {});
      expect(r.status).toBe(200);
      pos = r.body.pos as string;
    }
    expect(pos).toBe('11');
    expect(syncDo.saves.length).toBeGreaterThanOrEqual(1);
  });
  it('lifecycle soft-4', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 11 }) });
    const paths = ['/_matrix/client/unstable/org.matrix.msc3575/sync', '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', '/_matrix/client/v4/sync'];
    let pos = '';
    for (const p of paths) {
      const r = await postSliding(p, env, pos ? { pos } : {});
      expect(r.status).toBe(200);
      pos = r.body.pos as string;
    }
    expect(pos).toBe('11');
    expect(syncDo.saves.length).toBeGreaterThanOrEqual(1);
  });
  it('lifecycle soft-5', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 11 }) });
    const paths = ['/_matrix/client/unstable/org.matrix.msc3575/sync', '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', '/_matrix/client/v4/sync'];
    let pos = '';
    for (const p of paths) {
      const r = await postSliding(p, env, pos ? { pos } : {});
      expect(r.status).toBe(200);
      pos = r.body.pos as string;
    }
    expect(pos).toBe('11');
    expect(syncDo.saves.length).toBeGreaterThanOrEqual(1);
  });
  it('lifecycle soft-6', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 11 }) });
    const paths = ['/_matrix/client/unstable/org.matrix.msc3575/sync', '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', '/_matrix/client/v4/sync'];
    let pos = '';
    for (const p of paths) {
      const r = await postSliding(p, env, pos ? { pos } : {});
      expect(r.status).toBe(200);
      pos = r.body.pos as string;
    }
    expect(pos).toBe('11');
    expect(syncDo.saves.length).toBeGreaterThanOrEqual(1);
  });
  it('lifecycle soft-7', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 11 }) });
    const paths = ['/_matrix/client/unstable/org.matrix.msc3575/sync', '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', '/_matrix/client/v4/sync'];
    let pos = '';
    for (const p of paths) {
      const r = await postSliding(p, env, pos ? { pos } : {});
      expect(r.status).toBe(200);
      pos = r.body.pos as string;
    }
    expect(pos).toBe('11');
    expect(syncDo.saves.length).toBeGreaterThanOrEqual(1);
  });
  it('lifecycle soft-8', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 11 }) });
    const paths = ['/_matrix/client/unstable/org.matrix.msc3575/sync', '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', '/_matrix/client/v4/sync'];
    let pos = '';
    for (const p of paths) {
      const r = await postSliding(p, env, pos ? { pos } : {});
      expect(r.status).toBe(200);
      pos = r.body.pos as string;
    }
    expect(pos).toBe('11');
    expect(syncDo.saves.length).toBeGreaterThanOrEqual(1);
  });
  it('lifecycle soft-9', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 11 }) });
    const paths = ['/_matrix/client/unstable/org.matrix.msc3575/sync', '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', '/_matrix/client/v4/sync'];
    let pos = '';
    for (const p of paths) {
      const r = await postSliding(p, env, pos ? { pos } : {});
      expect(r.status).toBe(200);
      pos = r.body.pos as string;
    }
    expect(pos).toBe('11');
    expect(syncDo.saves.length).toBeGreaterThanOrEqual(1);
  });
  it('lifecycle soft-10', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 11 }) });
    const paths = ['/_matrix/client/unstable/org.matrix.msc3575/sync', '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', '/_matrix/client/v4/sync'];
    let pos = '';
    for (const p of paths) {
      const r = await postSliding(p, env, pos ? { pos } : {});
      expect(r.status).toBe(200);
      pos = r.body.pos as string;
    }
    expect(pos).toBe('11');
    expect(syncDo.saves.length).toBeGreaterThanOrEqual(1);
  });
  it('lifecycle soft-11', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 11 }) });
    const paths = ['/_matrix/client/unstable/org.matrix.msc3575/sync', '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', '/_matrix/client/v4/sync'];
    let pos = '';
    for (const p of paths) {
      const r = await postSliding(p, env, pos ? { pos } : {});
      expect(r.status).toBe(200);
      pos = r.body.pos as string;
    }
    expect(pos).toBe('11');
    expect(syncDo.saves.length).toBeGreaterThanOrEqual(1);
  });
  it('lifecycle soft-12', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 11 }) });
    const paths = ['/_matrix/client/unstable/org.matrix.msc3575/sync', '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', '/_matrix/client/v4/sync'];
    let pos = '';
    for (const p of paths) {
      const r = await postSliding(p, env, pos ? { pos } : {});
      expect(r.status).toBe(200);
      pos = r.body.pos as string;
    }
    expect(pos).toBe('11');
    expect(syncDo.saves.length).toBeGreaterThanOrEqual(1);
  });
  it('lifecycle soft-13', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 11 }) });
    const paths = ['/_matrix/client/unstable/org.matrix.msc3575/sync', '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', '/_matrix/client/v4/sync'];
    let pos = '';
    for (const p of paths) {
      const r = await postSliding(p, env, pos ? { pos } : {});
      expect(r.status).toBe(200);
      pos = r.body.pos as string;
    }
    expect(pos).toBe('11');
    expect(syncDo.saves.length).toBeGreaterThanOrEqual(1);
  });
  it('lifecycle soft-14', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 11 }) });
    const paths = ['/_matrix/client/unstable/org.matrix.msc3575/sync', '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', '/_matrix/client/v4/sync'];
    let pos = '';
    for (const p of paths) {
      const r = await postSliding(p, env, pos ? { pos } : {});
      expect(r.status).toBe(200);
      pos = r.body.pos as string;
    }
    expect(pos).toBe('11');
    expect(syncDo.saves.length).toBeGreaterThanOrEqual(1);
  });
  it('lifecycle soft-15', async () => {
    const syncDo = createSlidingSyncDoStub();
    const env = createSlidingEnv({ syncDo, db: createSlidingDb({ maxStreamPos: 11 }) });
    const paths = ['/_matrix/client/unstable/org.matrix.msc3575/sync', '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync', '/_matrix/client/v4/sync'];
    let pos = '';
    for (const p of paths) {
      const r = await postSliding(p, env, pos ? { pos } : {});
      expect(r.status).toBe(200);
      pos = r.body.pos as string;
    }
    expect(pos).toBe('11');
    expect(syncDo.saves.length).toBeGreaterThanOrEqual(1);
  });
});
