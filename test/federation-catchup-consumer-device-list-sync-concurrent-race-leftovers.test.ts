/**
 * TOKENMAXX HEAVY leftovers after #232 — federation-catchup / federation-consumer /
 * device-list *sync* concurrent-race leftovers.
 *
 * Complements (does not re-flood):
 *   - federation-catchup-workflow.test.ts + leftovers (#171 serial)
 *   - federation-catchup-consumer-device-list-concurrent-race-leftovers (#231)
 *     version/D1/send-route races
 *   - federation-consumer.test.ts (serial ack/retry/sign)
 *   - device-list-sync-deepen / sliding-sync-device-list-deepen /
 *     keys-device-list-changes-deepen (serial device_lists — zero Promise.all)
 *
 * Distinct leftover edges: get_missing_events POST barrier + JSON/string-length
 * isolation; missing-latest ∥ backfill; in-batch dest grouping + throwOnKey;
 * SERVER_NAME / attempts-delay isolation; /sync + sliding e2ee + /keys/changes
 * concurrent since/pos/window TOCTOU.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, PDU } from '../src/types';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICEA');
      await next();
    };
  },
}));

vi.mock('../src/utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/crypto')>();
  return {
    ...actual,
    verifyPassword: vi.fn(async () => true),
  };
});

vi.mock('../src/services/push-rule-evaluator', () => ({
  countNotificationsWithRules: vi.fn(async () => ({
    notification_count: 0,
    highlight_count: 0,
  })),
  evaluatePushRules: vi.fn(),
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
const getE2EEAccountDataFromDO = vi.fn();

vi.mock('../src/api/account-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/account-data')>();
  return {
    ...actual,
    getGlobalAccountData: (...args: unknown[]) => getGlobalAccountData(...args),
    getRoomAccountData: (...args: unknown[]) => getRoomAccountData(...args),
    getE2EEAccountDataFromDO: (...args: unknown[]) => getE2EEAccountDataFromDO(...args),
  };
});

const getReceiptsForRoom = vi.fn();
const getReceiptsForRooms = vi.fn();

vi.mock('../src/api/receipts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/receipts')>();
  return {
    ...actual,
    getReceiptsForRoom: (...args: unknown[]) => getReceiptsForRoom(...args),
    getReceiptsForRooms: (...args: unknown[]) => getReceiptsForRooms(...args),
  };
});

const getTypingUsers = vi.fn();
const getTypingForRooms = vi.fn();

vi.mock('../src/api/typing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/typing')>();
  return {
    ...actual,
    getTypingUsers: (...args: unknown[]) => getTypingUsers(...args),
    getTypingForRooms: (...args: unknown[]) => getTypingForRooms(...args),
  };
});

import { FederationCatchupWorkflow } from '../src/workflows/FederationCatchupWorkflow';
import { handleFederationQueue } from '../src/consumers/federation-consumer';
import syncApp from '../src/api/sync';
import slidingSyncApp from '../src/api/sliding-sync';
import keysApp from '../src/api/keys';

const NOW = 1_700_000_000_000;
const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const DAVE = '@dave:example.com';
const DEVICE = 'DEVICEA';
const SERVER = 'example.com';
const ROOM = '!shared:example.com';
const REMOTE = 'remote.example.com';
const PEER = 'peer.example.com';

const MSC3575 = '/_matrix/client/unstable/org.matrix.msc3575/sync';
const MSC4186 = '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync';
const V4 = '/_matrix/client/v4/sync';

type SqlCall = { sql: string; args: unknown[] };
type SqlBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };
type QueueBody = {
  destination: string;
  pdu?: Record<string, unknown>;
  edu?: { edu_type: string; content: Record<string, unknown> };
  timestamp: number;
};
type DeviceKeyChange = { user_id: string; stream_position: number };
type KeyChange = {
  user_id: string;
  device_id: string | null;
  change_type: string;
  stream_position: number;
};
type Membership = { room_id: string; user_id: string; membership: string };

async function withSqlBarrier(
  barrier: SqlBarrier | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  sql: string,
  args: unknown[]
) {
  if (!barrier || !barrier.match(sql, args)) return;
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

function createNBarrier(n: number) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return {
    async wait() {
      arrived += 1;
      if (arrived >= n) release();
      await gate;
    },
    get arrived() {
      return arrived;
    },
  };
}

function mockStep() {
  const names: string[] = [];
  return {
    names,
    async do(name: string, optsOrFn: unknown, maybeFn?: unknown) {
      names.push(name);
      const fn = typeof optsOrFn === 'function' ? optsOrFn : maybeFn;
      return (fn as () => Promise<unknown>)();
    },
  };
}

function createCatchupEnv(opts: {
  latestByRoom?: Record<string, string | null | undefined>;
  throwRooms?: Set<string>;
  selectBarrier?: SqlBarrier;
  mutateLatestAfterBarrier?: Record<string, string | null>;
} = {}) {
  const waiters = { list: [] as Array<() => void> };
  let selectBarrier = opts.selectBarrier;
  const latestByRoom = { ...(opts.latestByRoom ?? {}) };
  const firstCalls: SqlCall[] = [];
  return {
    firstCalls,
    latestByRoom,
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                firstCalls.push({ sql, args });
                await withSqlBarrier(
                  selectBarrier,
                  waiters,
                  () => {
                    selectBarrier = undefined;
                    if (opts.mutateLatestAfterBarrier) {
                      Object.assign(latestByRoom, opts.mutateLatestAfterBarrier);
                    }
                  },
                  sql,
                  args
                );
                if (sql.includes('FROM events') && sql.includes('ORDER BY stream_ordering')) {
                  const roomId = args[0] as string;
                  if (opts.throwRooms?.has(roomId)) throw new Error(`d1 boom ${roomId}`);
                  const id = latestByRoom[roomId];
                  if (id === undefined || id === null) return null;
                  return { event_id: id } as T;
                }
                return null;
              },
            };
          },
        };
      },
    },
  };
}

async function runCatchup(env: { DB: D1Database }, serverName: string, roomIds: string[]) {
  const wf = new FederationCatchupWorkflow({} as never, env as never);
  const step = mockStep();
  const result = await wf.run({ payload: { serverName, roomIds } } as never, step as never);
  return { result, step };
}

function makeMessage(body: QueueBody, attempts = 0) {
  return {
    body,
    attempts,
    retry: vi.fn(),
    ack: vi.fn(),
  };
}

function makeConsumerDb(
  opts: {
    row?: { key_id: string; private_key_jwk: string | null } | null;
    selectBarrier?: SqlBarrier;
    throwOnKey?: boolean;
  } = {}
) {
  const waiters = { list: [] as Array<() => void> };
  let selectBarrier = opts.selectBarrier;
  const firstCalls: SqlCall[] = [];
  return {
    firstCalls,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              firstCalls.push({ sql, args });
              await withSqlBarrier(
                selectBarrier,
                waiters,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );
              if (opts.throwOnKey) throw new Error('d1 key boom');
              return (opts.row ?? null) as T;
            },
          };
        },
        first: async () => {
          firstCalls.push({ sql, args: [] });
          await withSqlBarrier(
            selectBarrier,
            waiters,
            () => {
              selectBarrier = undefined;
            },
            sql,
            []
          );
          if (opts.throwOnKey) throw new Error('d1 key boom');
          return opts.row ?? null;
        },
      };
    },
  } as unknown as Env['DB'] & { firstCalls: SqlCall[] };
}

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

function resetSyncMocks() {
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
  getE2EEAccountDataFromDO.mockReset().mockResolvedValue({});
  getReceiptsForRoom.mockReset().mockResolvedValue({});
  getReceiptsForRooms.mockReset().mockImplementation(async (_env: unknown, roomIds: string[]) => {
    const out: Record<string, Record<string, unknown>> = {};
    for (const id of roomIds) out[id] = {};
    return out;
  });
  getTypingUsers.mockReset().mockResolvedValue([]);
  getTypingForRooms.mockReset().mockImplementation(async (_env: unknown, roomIds: string[]) => {
    const out: Record<string, string[]> = {};
    for (const id of roomIds) out[id] = [];
    return out;
  });
}

function createSyncDoStub(opts: { hasEvents?: boolean; fail?: boolean } = {}) {
  const fetches: Array<{ url: string }> = [];
  return {
    fetches,
    async fetch(req: Request): Promise<Response> {
      fetches.push({ url: req.url });
      if (opts.fail) throw new Error('sync DO boom');
      return Response.json({ hasEvents: opts.hasEvents ?? false });
    },
  };
}

function createSyncDb(opts: {
  deviceKeyChanges?: DeviceKeyChange[];
  sharedRoomUsers?: string[];
  selectBarrier?: SqlBarrier;
  mutateAfterBarrier?: DeviceKeyChange[];
} = {}) {
  const deviceKeyChanges = [...(opts.deviceKeyChanges ?? [])];
  const sharedRoomUsers = new Set(opts.sharedRoomUsers ?? [BOB, CAROL]);
  const selects: SqlCall[] = [];
  const waiters = { list: [] as Array<() => void> };
  let selectBarrier = opts.selectBarrier;

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
              await withSqlBarrier(
                selectBarrier,
                waiters,
                () => {
                  selectBarrier = undefined;
                  if (opts.mutateAfterBarrier) {
                    deviceKeyChanges.splice(0, deviceKeyChanges.length, ...opts.mutateAfterBarrier);
                  }
                },
                sql,
                args
              );
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
              await withSqlBarrier(
                selectBarrier,
                waiters,
                () => {
                  selectBarrier = undefined;
                  if (opts.mutateAfterBarrier) {
                    deviceKeyChanges.splice(0, deviceKeyChanges.length, ...opts.mutateAfterBarrier);
                  }
                },
                sql,
                args
              );
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

function createSyncEnv(opts: {
  db?: ReturnType<typeof createSyncDb>;
  syncDo?: ReturnType<typeof createSyncDoStub>;
} = {}) {
  const db = opts.db ?? createSyncDb();
  const syncDo = opts.syncDo ?? createSyncDoStub();
  return {
    DB: db as unknown as D1Database,
    CACHE: mockKv(),
    SERVER_NAME: SERVER,
    SYNC: {
      idFromName: (name: string) => ({ name, toString: () => `id:${name}` }),
      get: () => syncDo,
    },
    _db: db,
    _syncDo: syncDo,
  } as unknown as Env & {
    _db: ReturnType<typeof createSyncDb>;
    _syncDo: ReturnType<typeof createSyncDoStub>;
  };
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

function createUserKeysStub(opts: {
  deviceIds?: string[];
  crossSigning?: Record<string, unknown>;
} = {}) {
  const deviceIds = opts.deviceIds ?? [];
  const crossSigning = opts.crossSigning ?? {};
  return {
    async fetch(req: Request): Promise<Response> {
      if (req.url.includes('/device-keys/list')) return Response.json(deviceIds);
      if (req.url.includes('/cross-signing/get')) return Response.json(crossSigning);
      if (req.url.includes('/device-keys/get')) return Response.json(null);
      if (req.url.includes('/device-keys/put')) return new Response('{}', { status: 200 });
      return Response.json({});
    },
  };
}

function createSlidingDb(opts: {
  maxStreamPos?: number | null;
  deviceKeyChanges?: DeviceKeyChange[];
  sharedRoomUsers?: string[];
  selectBarrier?: SqlBarrier;
  mutateAfterBarrier?: DeviceKeyChange[];
} = {}) {
  const maxStreamPos = opts.maxStreamPos === undefined ? 42 : opts.maxStreamPos;
  const deviceKeyChanges = [...(opts.deviceKeyChanges ?? [])];
  const sharedRoomUsers = new Set(opts.sharedRoomUsers ?? [BOB, CAROL]);
  const selects: SqlCall[] = [];
  const waiters = { list: [] as Array<() => void> };
  let selectBarrier = opts.selectBarrier;

  function handleAll(sql: string, args: unknown[]): unknown[] {
    if (sql.includes('FROM one_time_keys') && sql.includes('GROUP BY algorithm')) {
      return [];
    }
    if (sql.includes('FROM fallback_keys') && sql.includes('DISTINCT algorithm')) {
      return [];
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
    selects,
    deviceKeyChanges,
    prepare(sql: string) {
      const makeStmt = (args: unknown[] = []) => ({
        async first<T>() {
          selects.push({ sql, args });
          if (
            sql.includes('MAX(stream_ordering)') &&
            sql.includes('FROM events') &&
            !sql.includes('WHERE')
          ) {
            return { max_pos: maxStreamPos } as T;
          }
          return null as T;
        },
        async all<T>() {
          selects.push({ sql, args });
          await withSqlBarrier(
            selectBarrier,
            waiters,
            () => {
              selectBarrier = undefined;
              if (opts.mutateAfterBarrier) {
                deviceKeyChanges.splice(0, deviceKeyChanges.length, ...opts.mutateAfterBarrier);
              }
            },
            sql,
            args
          );
          return { results: handleAll(sql, args) as T[] };
        },
        async run() {
          return { success: true };
        },
      });
      return {
        ...makeStmt([]),
        bind(...args: unknown[]) {
          return makeStmt(args);
        },
      };
    },
    async batch(stmts: Array<{ all: () => Promise<{ results: unknown[] }> }>) {
      const out = [];
      for (const stmt of stmts) out.push(await stmt.all());
      return out;
    },
  };
  return db;
}

function createSlidingEnv(opts: {
  db?: ReturnType<typeof createSlidingDb>;
  userKeys?: ReturnType<typeof createUserKeysStub>;
} = {}) {
  const db = opts.db ?? createSlidingDb();
  const userKeys = opts.userKeys ?? createUserKeysStub();
  return {
    DB: db as unknown as D1Database,
    CACHE: mockKv(),
    SERVER_NAME: SERVER,
    SYNC: {
      idFromName: (name: string) => ({ name, toString: () => `id:${name}` }),
      get: () => createSyncDoStub(),
    },
    USER_KEYS: {
      idFromName: (name: string) => ({ name, toString: () => `uk:${name}` }),
      get: () => userKeys,
    },
    _db: db,
  } as unknown as Env & { _db: ReturnType<typeof createSlidingDb> };
}

async function postSliding(path: string, env: Env, body: unknown) {
  const res = await slidingSyncApp.request(
    `http://localhost${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env
  );
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { _raw: text };
    }
  }
  return { status: res.status, body: parsed };
}

function e2eeLists(body: Record<string, unknown>): { changed: string[]; left: string[] } {
  const ext = body.extensions as {
    e2ee?: { device_lists?: { changed: string[]; left: string[] } };
  };
  return ext.e2ee?.device_lists ?? { changed: [], left: [] };
}

function createKeysDb(opts: {
  keyChanges?: KeyChange[];
  memberships?: Membership[];
  selectBarrier?: SqlBarrier;
  mutateAfterBarrier?: KeyChange[];
} = {}) {
  const keyChanges = [...(opts.keyChanges ?? [])];
  const memberships = [...(opts.memberships ?? [])];
  const inserts: SqlCall[] = [];
  const waiters = { list: [] as Array<() => void> };
  let selectBarrier = opts.selectBarrier;

  const db = {
    keyChanges,
    memberships,
    inserts,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT position FROM stream_positions')) {
                return { position: 10 } as T;
              }
              if (sql.includes('SELECT COUNT(*) as count FROM cross_signing_keys')) {
                return { count: 0 } as T;
              }
              if (sql.includes('SELECT COUNT(*) as count FROM idp_user_links')) {
                return { count: 0 } as T;
              }
              if (sql.includes('SELECT password_hash FROM users')) {
                return { password_hash: 'mockok:pw' } as T;
              }
              return null as T;
            },
            async all<T>() {
              await withSqlBarrier(
                selectBarrier,
                waiters,
                () => {
                  selectBarrier = undefined;
                  if (opts.mutateAfterBarrier) {
                    keyChanges.splice(0, keyChanges.length, ...opts.mutateAfterBarrier);
                  }
                },
                sql,
                args
              );
              if (sql.includes('FROM device_key_changes dkc') && sql.includes('room_memberships')) {
                const [fromPos, toPos, requester] = args as [number, number, string];
                const joinedRooms = new Set(
                  memberships
                    .filter((m) => m.user_id === requester && m.membership === 'join')
                    .map((m) => m.room_id)
                );
                const sharedUsers = new Set(
                  memberships
                    .filter((m) => joinedRooms.has(m.room_id) && m.membership === 'join')
                    .map((m) => m.user_id)
                );
                const rows = keyChanges
                  .filter(
                    (c) =>
                      c.stream_position > fromPos &&
                      c.stream_position <= toPos &&
                      sharedUsers.has(c.user_id)
                  )
                  .map((c) => ({ user_id: c.user_id, change_type: c.change_type }));
                const seen = new Set<string>();
                const distinct = rows.filter((r) => {
                  const k = `${r.user_id}:${r.change_type}`;
                  if (seen.has(k)) return false;
                  seen.add(k);
                  return true;
                });
                return { results: distinct as unknown as T[] };
              }
              return { results: [] as T[] };
            },
            async run() {
              inserts.push({ sql, args });
              return { success: true };
            },
          };
        },
      };
    },
  };
  return db;
}

function sharedMemberships(...users: string[]): Membership[] {
  return users.map((user_id) => ({
    room_id: ROOM,
    user_id,
    membership: 'join',
  }));
}

function createKeysEnv(opts: { db?: ReturnType<typeof createKeysDb> } = {}) {
  const db = opts.db ?? createKeysDb();
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
    DEVICE_KEYS: mockKv(),
    ONE_TIME_KEYS: mockKv(),
    CACHE: mockKv(),
    ACCOUNT_DATA: mockKv(),
    CROSS_SIGNING_KEYS: mockKv(),
    USER_KEYS: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => createUserKeysStub({ deviceIds: [DEVICE] }),
    },
    FEDERATION: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => ({
        fetch: async () => new Response('{}', { status: 200 }),
      }),
    },
    _db: db,
  } as unknown as Env & { _db: ReturnType<typeof createKeysDb> };
}

async function keysRequest(env: Env, path: string) {
  const res = await keysApp.request(`http://localhost${path}`, {}, env);
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Catchup leftover concurrent races after #231
// ---------------------------------------------------------------------------

describe('federation-catchup leftover concurrent-race after #232', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let timeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('get_missing_events POST barrier: both in-flight then 200∥404', async () => {
    const gate = createNBarrier(2);
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) return new Response('{}', { status: 200 });
      await gate.wait();
      if (String(url).includes(encodeURIComponent('!ok:example.com'))) {
        return new Response(JSON.stringify({ events: [{}, {}, {}] }), { status: 200 });
      }
      return new Response('nope', { status: 404 });
    });
    const okEnv = createCatchupEnv({ latestByRoom: { '!ok:example.com': '$ok' } });
    const failEnv = createCatchupEnv({ latestByRoom: { '!fail:example.com': '$f' } });
    const [ok, fail] = await Promise.all([
      runCatchup(okEnv as never, REMOTE, ['!ok:example.com']),
      runCatchup(failEnv as never, PEER, ['!fail:example.com']),
    ]);
    expect(gate.arrived).toBe(2);
    expect(ok.result).toEqual({ serverName: REMOTE, backfilledEvents: 3, success: true });
    expect(fail.result).toEqual({ serverName: PEER, backfilledEvents: 0, success: true });
    const posts = fetchMock.mock.calls.filter((c) => String(c[0]).includes('get_missing_events'));
    expect(posts).toHaveLength(2);
    expect((posts[0][1] as RequestInit).method).toBe('POST');
    expect((posts[1][1] as RequestInit).method).toBe('POST');
  });

  it('invalid JSON get_missing_events ∥ valid array isolation', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) return new Response('{}', { status: 200 });
      if (String(url).includes(encodeURIComponent('!bad:example.com'))) {
        return new Response('not-json', { status: 200 });
      }
      return new Response(JSON.stringify({ events: [{}, {}] }), { status: 200 });
    });
    const [bad, good] = await Promise.all([
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!bad:example.com': '$b' } }) as never,
        REMOTE,
        ['!bad:example.com']
      ),
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!good:example.com': '$g' } }) as never,
        PEER,
        ['!good:example.com']
      ),
    ]);
    expect(bad.result.backfilledEvents).toBe(0);
    expect(bad.result.success).toBe(true);
    expect(good.result.backfilledEvents).toBe(2);
  });

  it('events string length ∥ array length isolation (events?.length as-is)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) return new Response('{}', { status: 200 });
      if (String(url).includes(encodeURIComponent('!str:example.com'))) {
        return new Response(JSON.stringify({ events: 'abcd' }), { status: 200 });
      }
      return new Response(JSON.stringify({ events: [{}, {}, {}, {}, {}] }), { status: 200 });
    });
    const [str, arr] = await Promise.all([
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!str:example.com': '$s' } }) as never,
        REMOTE,
        ['!str:example.com']
      ),
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!arr:example.com': '$a' } }) as never,
        PEER,
        ['!arr:example.com']
      ),
    ]);
    expect(str.result.backfilledEvents).toBe(4);
    expect(arr.result.backfilledEvents).toBe(5);
  });

  it('missing latest short-circuit ∥ populated backfill isolation', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ events: [{}, {}] }), { status: 200 });
    });
    const [empty, filled] = await Promise.all([
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!empty:example.com': null } }) as never,
        REMOTE,
        ['!empty:example.com']
      ),
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!full:example.com': '$f' } }) as never,
        PEER,
        ['!full:example.com']
      ),
    ]);
    expect(empty.result.backfilledEvents).toBe(0);
    expect(empty.step.names).toEqual(['check-server', 'backfill-!empty:example.com']);
    expect(filled.result.backfilledEvents).toBe(2);
    const posts = fetchMock.mock.calls.filter((c) => String(c[0]).includes('get_missing_events'));
    expect(posts).toHaveLength(1);
    expect(String(posts[0][0])).toContain(encodeURIComponent('!full:example.com'));
  });

  it('version empty-body 200 ∥ version throw isolation', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes(REMOTE) && String(url).includes('/version')) {
        return new Response(null, { status: 200 });
      }
      if (String(url).includes(PEER) && String(url).includes('/version')) {
        throw new Error('dns');
      }
      return new Response(JSON.stringify({ events: [{}] }), { status: 200 });
    });
    const [ok, fail] = await Promise.all([
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!r:example.com': '$e' } }) as never,
        REMOTE,
        ['!r:example.com']
      ),
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!r:example.com': '$e' } }) as never,
        PEER,
        ['!r:example.com']
      ),
    ]);
    expect(ok.result.success).toBe(true);
    expect(ok.result.backfilledEvents).toBe(1);
    expect(fail.result).toMatchObject({ success: false, error: 'Server not reachable' });
  });

  it('duplicate roomIds in one payload ∥ unique rooms isolation', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ events: [{}] }), { status: 200 });
    });
    const dup = ['!dup:example.com', '!dup:example.com'];
    const uniq = ['!a:example.com', '!b:example.com'];
    const [d, u] = await Promise.all([
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!dup:example.com': '$d' } }) as never,
        REMOTE,
        dup
      ),
      runCatchup(
        createCatchupEnv({
          latestByRoom: { '!a:example.com': '$a', '!b:example.com': '$b' },
        }) as never,
        PEER,
        uniq
      ),
    ]);
    expect(d.result.backfilledEvents).toBe(2);
    expect(d.step.names.filter((n) => n.startsWith('backfill-'))).toHaveLength(2);
    expect(u.result.backfilledEvents).toBe(2);
  });

  it('events null ∥ events undefined ∥ counted array concurrent', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) return new Response('{}', { status: 200 });
      if (String(url).includes(encodeURIComponent('!n:example.com'))) {
        return new Response(JSON.stringify({ events: null }), { status: 200 });
      }
      if (String(url).includes(encodeURIComponent('!u:example.com'))) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response(JSON.stringify({ events: [{}, {}] }), { status: 200 });
    });
    const [n, u, c] = await Promise.all([
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!n:example.com': '$n' } }) as never,
        'n.example.com',
        ['!n:example.com']
      ),
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!u:example.com': '$u' } }) as never,
        'u.example.com',
        ['!u:example.com']
      ),
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!c:example.com': '$c' } }) as never,
        'c.example.com',
        ['!c:example.com']
      ),
    ]);
    expect(n.result.backfilledEvents).toBe(0);
    expect(u.result.backfilledEvents).toBe(0);
    expect(c.result.backfilledEvents).toBe(2);
  });

  it('Content-Type + limit/earliest pin under overlapping POST race', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    });
    await Promise.all([
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!a/b:example.com': '$slash' } }) as never,
        REMOTE,
        ['!a/b:example.com']
      ),
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!a b:example.com': '$space' } }) as never,
        PEER,
        ['!a b:example.com']
      ),
    ]);
    const posts = fetchMock.mock.calls.filter((c) => String(c[0]).includes('get_missing_events'));
    expect(posts).toHaveLength(2);
    const urls = posts.map((c) => String(c[0]));
    expect(urls).toContain(
      `https://${REMOTE}/_matrix/federation/v1/get_missing_events/${encodeURIComponent('!a/b:example.com')}`
    );
    expect(urls).toContain(
      `https://${PEER}/_matrix/federation/v1/get_missing_events/${encodeURIComponent('!a b:example.com')}`
    );
    for (const call of posts) {
      const init = call[1] as RequestInit;
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
      const body = JSON.parse(init.body as string) as {
        limit: number;
        earliest_events: string[];
        latest_events: unknown[];
      };
      expect(body.limit).toBe(100);
      expect(body.latest_events).toEqual([]);
      expect(body.earliest_events).toHaveLength(1);
    }
  });

  it('AbortSignal 10s version + 30s backfill isolated when one side never backfills', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) {
        if (String(url).includes(PEER)) return new Response('down', { status: 503 });
        return new Response('{}', { status: 200 });
      }
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    });
    timeoutSpy.mockClear();
    await Promise.all([
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!a:example.com': '$a' } }) as never,
        REMOTE,
        ['!a:example.com']
      ),
      runCatchup(
        createCatchupEnv({ latestByRoom: { '!a:example.com': '$a' } }) as never,
        PEER,
        ['!a:example.com']
      ),
    ]);
    expect(timeoutSpy.mock.calls.filter((c) => c[0] === 10_000)).toHaveLength(2);
    expect(timeoutSpy.mock.calls.filter((c) => c[0] === 30_000)).toHaveLength(1);
  });

  it('six remotes overlapping rooms POST isolation soft flood', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/version')) return new Response('{}', { status: 200 });
      const n = Number(String(url).match(/r(\d)/)?.[1] ?? 0);
      return new Response(JSON.stringify({ events: Array.from({ length: n }, () => ({})) }), {
        status: 200,
      });
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => {
        const room = `!r${i}:example.com`;
        return runCatchup(
          createCatchupEnv({ latestByRoom: { [room]: `$e${i}` } }) as never,
          `r${i}.example.com`,
          [room]
        );
      })
    );
    for (let i = 0; i < 6; i++) {
      expect(results[i].result.backfilledEvents).toBe(i);
      expect(results[i].result.serverName).toBe(`r${i}.example.com`);
    }
  });
});

// ---------------------------------------------------------------------------
// Consumer leftover concurrent races after #231
// ---------------------------------------------------------------------------

describe('federation-consumer leftover concurrent-race after #232', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', vi.fn());
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('same dest two messages in one batch → one PUT, both ack', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const a = makeMessage({
      destination: 'a.example.com',
      pdu: { event_id: '$1' },
      timestamp: NOW,
    });
    const b = makeMessage({
      destination: 'a.example.com',
      pdu: { event_id: '$2' },
      timestamp: NOW,
    });
    await handleFederationQueue(
      { messages: [a, b] } as unknown as MessageBatch<QueueBody>,
      { DB: makeConsumerDb(), SERVER_NAME: 'local.example.com' } as Env
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
      pdus: Array<{ event_id: string }>;
    };
    expect(body.pdus).toEqual([{ event_id: '$1' }, { event_id: '$2' }]);
    expect(a.ack).toHaveBeenCalledOnce();
    expect(b.ack).toHaveBeenCalledOnce();
  });

  it('same dest two messages fail → both retry same delay; sibling dest acks', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('fail.example.com')) return new Response('no', { status: 503 });
      return new Response('{}', { status: 200 });
    });
    const f1 = makeMessage(
      { destination: 'fail.example.com', pdu: { event_id: '$f1' }, timestamp: NOW },
      1
    );
    const f2 = makeMessage(
      { destination: 'fail.example.com', pdu: { event_id: '$f2' }, timestamp: NOW },
      1
    );
    const ok = makeMessage({
      destination: 'ok.example.com',
      pdu: { event_id: '$ok' },
      timestamp: NOW,
    });
    await handleFederationQueue(
      { messages: [f1, ok, f2] } as unknown as MessageBatch<QueueBody>,
      { DB: makeConsumerDb(), SERVER_NAME: 'local.example.com' } as Env
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ok.ack).toHaveBeenCalledOnce();
    expect(f1.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(f2.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(f1.ack).not.toHaveBeenCalled();
    expect(f2.ack).not.toHaveBeenCalled();
  });

  it('throwOnKey SELECT boom ∥ unsigned success concurrent batches', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const boom = makeMessage(
      { destination: 'boom.example.com', pdu: { event_id: '$b' }, timestamp: NOW },
      0
    );
    const ok = makeMessage({
      destination: 'ok.example.com',
      pdu: { event_id: '$o' },
      timestamp: NOW,
    });
    await Promise.all([
      handleFederationQueue(
        { messages: [boom] } as unknown as MessageBatch<QueueBody>,
        { DB: makeConsumerDb({ throwOnKey: true }), SERVER_NAME: 'local.example.com' } as Env
      ),
      handleFederationQueue(
        { messages: [ok] } as unknown as MessageBatch<QueueBody>,
        { DB: makeConsumerDb(), SERVER_NAME: 'local.example.com' } as Env
      ),
    ]);
    expect(boom.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(boom.ack).not.toHaveBeenCalled();
    expect(ok.ack).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('ok.example.com');
  });

  it('throwOnKey barrier: both dests wait then both reject without fetch', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const db = makeConsumerDb({
      throwOnKey: true,
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM server_keys'),
      },
    });
    const a = makeMessage(
      { destination: 'a.example.com', pdu: { event_id: '$a' }, timestamp: NOW },
      3
    );
    const b = makeMessage(
      { destination: 'b.example.com', pdu: { event_id: '$b' }, timestamp: NOW },
      3
    );
    await handleFederationQueue(
      { messages: [a, b] } as unknown as MessageBatch<QueueBody>,
      { DB: db, SERVER_NAME: 'local.example.com' } as Env
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(a.retry).toHaveBeenCalledWith({ delaySeconds: 8 * 60 });
    expect(b.retry).toHaveBeenCalledWith({ delaySeconds: 8 * 60 });
  });

  it('SERVER_NAME origin isolation under concurrent batches', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const left = makeMessage({
      destination: 'dest.example.com',
      pdu: { event_id: '$l' },
      timestamp: NOW,
    });
    const right = makeMessage({
      destination: 'dest.example.com',
      pdu: { event_id: '$r' },
      timestamp: NOW,
    });
    await Promise.all([
      handleFederationQueue(
        { messages: [left] } as unknown as MessageBatch<QueueBody>,
        { DB: makeConsumerDb(), SERVER_NAME: 'alpha.example.com' } as Env
      ),
      handleFederationQueue(
        { messages: [right] } as unknown as MessageBatch<QueueBody>,
        { DB: makeConsumerDb(), SERVER_NAME: 'beta.example.com' } as Env
      ),
    ]);
    const origins = fetchMock.mock.calls.map(
      (c) => JSON.parse(String(c[1]?.body)) as { origin: string }
    );
    expect(origins.map((o) => o.origin).sort()).toEqual(['alpha.example.com', 'beta.example.com']);
  });

  it('attempts 0/1/2/3 delay isolation concurrent batches', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response('no', { status: 500 }));
    const msgs = [0, 1, 2, 3].map((attempts) =>
      makeMessage(
        {
          destination: `a${attempts}.example.com`,
          pdu: { event_id: `$${attempts}` },
          timestamp: NOW,
        },
        attempts
      )
    );
    await Promise.all(
      msgs.map((m) =>
        handleFederationQueue(
          { messages: [m] } as unknown as MessageBatch<QueueBody>,
          { DB: makeConsumerDb(), SERVER_NAME: 'local.example.com' } as Env
        )
      )
    );
    expect(msgs[0].retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(msgs[1].retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(msgs[2].retry).toHaveBeenCalledWith({ delaySeconds: 240 });
    expect(msgs[3].retry).toHaveBeenCalledWith({ delaySeconds: 480 });
  });

  it('same message pdu+edu grouped vs edu-only concurrent batch', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const both = makeMessage({
      destination: 'both.example.com',
      pdu: { event_id: '$p' },
      edu: { edu_type: 'm.typing', content: { room_id: '!r:example.com' } },
      timestamp: NOW,
    });
    const eduOnly = makeMessage({
      destination: 'edu.example.com',
      edu: { edu_type: 'm.presence', content: { push: [] } },
      timestamp: NOW,
    });
    await Promise.all([
      handleFederationQueue(
        { messages: [both] } as unknown as MessageBatch<QueueBody>,
        { DB: makeConsumerDb(), SERVER_NAME: 'local.example.com' } as Env
      ),
      handleFederationQueue(
        { messages: [eduOnly] } as unknown as MessageBatch<QueueBody>,
        { DB: makeConsumerDb(), SERVER_NAME: 'local.example.com' } as Env
      ),
    ]);
    const byHost = Object.fromEntries(
      fetchMock.mock.calls.map((c) => [
        String(c[0]).includes('both.example.com') ? 'both' : 'edu',
        JSON.parse(String(c[1]?.body)),
      ])
    );
    expect(byHost.both).toMatchObject({
      pdus: [{ event_id: '$p' }],
      edus: [{ edu_type: 'm.typing', content: { room_id: '!r:example.com' } }],
    });
    expect(byHost.edu).toMatchObject({
      pdus: [],
      edus: [{ edu_type: 'm.presence', content: { push: [] } }],
    });
  });

  it('PUT method + send URL pin for in-batch three dests', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response('{}', { status: 202 }));
    const msgs = ['x.example.com', 'y.example.com', 'z.example.com'].map((destination) =>
      makeMessage({ destination, pdu: { event_id: `$${destination}` }, timestamp: NOW })
    );
    await handleFederationQueue(
      { messages: msgs } as unknown as MessageBatch<QueueBody>,
      { DB: makeConsumerDb(), SERVER_NAME: 'local.example.com' } as Env
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).method).toBe('PUT');
      expect(String(call[0])).toMatch(
        /^https:\/\/[xyz]\.example\.com\/_matrix\/federation\/v1\/send\/\d+_/
      );
    }
    for (const m of msgs) expect(m.ack).toHaveBeenCalledOnce();
  });

  it('empty messages ∥ empty messages concurrent never fetch', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    await Promise.all([
      handleFederationQueue(
        { messages: [] } as unknown as MessageBatch<QueueBody>,
        { DB: makeConsumerDb(), SERVER_NAME: 'local.example.com' } as Env
      ),
      handleFederationQueue(
        { messages: [] } as unknown as MessageBatch<QueueBody>,
        { DB: makeConsumerDb(), SERVER_NAME: 'peer.example.com' } as Env
      ),
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// /sync device_lists concurrent leftover
// ---------------------------------------------------------------------------

describe('device-list-sync leftover concurrent-race after #232', () => {
  beforeEach(() => {
    resetSyncMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('initial self seed ∥ incremental peer isolation', async () => {
    const initial = createSyncEnv({
      db: createSyncDb({ deviceKeyChanges: [], sharedRoomUsers: [] }),
    });
    const incr = createSyncEnv({
      db: createSyncDb({
        deviceKeyChanges: [{ user_id: BOB, stream_position: 15 }],
        sharedRoomUsers: [BOB],
      }),
    });
    const [a, b] = await Promise.all([
      syncRequest(initial, ''),
      syncRequest(incr, 'since=s10_td0'),
    ]);
    expect(a.body.device_lists).toEqual({ changed: [USER], left: [] });
    expect(b.body.device_lists).toEqual({ changed: [BOB], left: [] });
  });

  it('stale since ∥ fresh since isolation on shared db snapshot', async () => {
    const mk = () =>
      createSyncEnv({
        db: createSyncDb({
          deviceKeyChanges: [{ user_id: BOB, stream_position: 20 }],
          sharedRoomUsers: [BOB],
        }),
      });
    const [stale, fresh] = await Promise.all([
      syncRequest(mk(), 'since=s20_td0'),
      syncRequest(mk(), 'since=s19_td0'),
    ]);
    expect(stale.body.device_lists).toBeUndefined();
    expect(fresh.body.device_lists).toEqual({ changed: [BOB], left: [] });
  });

  it('self+peer ∥ empty omit isolation', async () => {
    const both = createSyncEnv({
      db: createSyncDb({
        deviceKeyChanges: [
          { user_id: USER, stream_position: 21 },
          { user_id: BOB, stream_position: 22 },
        ],
        sharedRoomUsers: [BOB],
      }),
    });
    const empty = createSyncEnv({
      db: createSyncDb({ deviceKeyChanges: [], sharedRoomUsers: [BOB] }),
    });
    const [a, b] = await Promise.all([
      syncRequest(both, 'since=s10_td0'),
      syncRequest(empty, 'since=s10_td0'),
    ]);
    expect(a.body.device_lists).toEqual({ changed: [BOB, USER], left: [] });
    expect(b.body.device_lists).toBeUndefined();
  });

  it('SELECT DISTINCT barrier TOCTOU mutates peer after both wait', async () => {
    const db = createSyncDb({
      deviceKeyChanges: [{ user_id: BOB, stream_position: 15 }],
      sharedRoomUsers: [BOB, CAROL],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('SELECT DISTINCT dkc.user_id'),
      },
      mutateAfterBarrier: [{ user_id: CAROL, stream_position: 99 }],
    });
    const env = createSyncEnv({ db });
    const [a, b] = await Promise.all([
      syncRequest(env, 'since=s10_td0'),
      syncRequest(env, 'since=s10_td0'),
    ]);
    for (const res of [a, b]) {
      expect(res.body.device_lists).toEqual({ changed: [CAROL], left: [] });
    }
  });

  it('SQL since bind isolation concurrent composite tokens', async () => {
    const dbA = createSyncDb({
      deviceKeyChanges: [{ user_id: BOB, stream_position: 100 }],
      sharedRoomUsers: [BOB],
    });
    const dbB = createSyncDb({
      deviceKeyChanges: [{ user_id: BOB, stream_position: 100 }],
      sharedRoomUsers: [BOB],
    });
    await Promise.all([
      syncRequest(createSyncEnv({ db: dbA }), 'since=s77_td3'),
      syncRequest(createSyncEnv({ db: dbB }), 'since=s12_td9'),
    ]);
    const distinctA = dbA.selects.find((s) => s.sql.includes('SELECT DISTINCT dkc.user_id'));
    const distinctB = dbB.selects.find((s) => s.sql.includes('SELECT DISTINCT dkc.user_id'));
    expect(distinctA?.args).toEqual([77, USER, USER]);
    expect(distinctB?.args).toEqual([12, USER, USER]);
  });

  it('device_lists-only DO wait ∥ to-device skip isolation', async () => {
    const waitDo = createSyncDoStub({ hasEvents: false });
    const skipDo = createSyncDoStub();
    getToDeviceMessages
      .mockResolvedValueOnce({ events: [], nextBatch: '0' })
      .mockResolvedValueOnce({
        events: [{ type: 'm.room_key_request', content: {}, sender: BOB }],
        nextBatch: '9',
      });
    const waitEnv = createSyncEnv({
      syncDo: waitDo,
      db: createSyncDb({
        deviceKeyChanges: [{ user_id: BOB, stream_position: 20 }],
        sharedRoomUsers: [BOB],
      }),
    });
    const skipEnv = createSyncEnv({
      syncDo: skipDo,
      db: createSyncDb({
        deviceKeyChanges: [{ user_id: BOB, stream_position: 20 }],
        sharedRoomUsers: [BOB],
      }),
    });
    const [waitRes, skipRes] = await Promise.all([
      syncRequest(waitEnv, 'since=s10_td0&timeout=5000'),
      syncRequest(skipEnv, 'since=s10_td0&timeout=5000'),
    ]);
    expect(waitRes.body.device_lists).toEqual({ changed: [BOB], left: [] });
    expect(skipRes.body.device_lists).toEqual({ changed: [BOB], left: [] });
    expect(waitDo.fetches).toHaveLength(1);
    expect(skipDo.fetches).toHaveLength(0);
  });

  it('outsider high stream ∥ shared peer isolation', async () => {
    const outsider = createSyncEnv({
      db: createSyncDb({
        deviceKeyChanges: [{ user_id: '@outsider:example.com', stream_position: 999 }],
        sharedRoomUsers: [BOB],
      }),
    });
    const peer = createSyncEnv({
      db: createSyncDb({
        deviceKeyChanges: [{ user_id: DAVE, stream_position: 11 }],
        sharedRoomUsers: [DAVE],
      }),
    });
    const [a, b] = await Promise.all([
      syncRequest(outsider, 'since=s1_td0'),
      syncRequest(peer, 'since=s1_td0'),
    ]);
    expect(a.body.device_lists).toBeUndefined();
    expect(b.body.device_lists).toEqual({ changed: [DAVE], left: [] });
  });

  it('left always [] under eight concurrent since windows', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => {
        const since = i + 1;
        return syncRequest(
          createSyncEnv({
            db: createSyncDb({
              deviceKeyChanges: [{ user_id: BOB, stream_position: since + 1 }],
              sharedRoomUsers: [BOB],
            }),
          }),
          `since=s${since}_td0`
        );
      })
    );
    for (const res of results) {
      expect(res.status).toBe(200);
      expect(res.body.device_lists).toEqual({ changed: [BOB], left: [] });
    }
  });

  it('legacy numeric since ∥ composite since isolation', async () => {
    const mk = () =>
      createSyncEnv({
        db: createSyncDb({
          deviceKeyChanges: [{ user_id: BOB, stream_position: 8 }],
          sharedRoomUsers: [BOB],
        }),
      });
    const [legacy, composite] = await Promise.all([
      syncRequest(mk(), 'since=7'),
      syncRequest(mk(), 'since=s7_td0'),
    ]);
    expect(legacy.body.device_lists).toEqual({ changed: [BOB], left: [] });
    expect(composite.body.device_lists).toEqual({ changed: [BOB], left: [] });
  });
});

// ---------------------------------------------------------------------------
// sliding-sync e2ee device_lists concurrent leftover
// ---------------------------------------------------------------------------

describe('sliding-sync device-list leftover concurrent-race after #232', () => {
  beforeEach(() => {
    resetSyncMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('MSC3575 ∥ MSC4186 same pos peer isolation', async () => {
    const mk = () =>
      createSlidingEnv({
        db: createSlidingDb({
          maxStreamPos: 50,
          deviceKeyChanges: [{ user_id: BOB, stream_position: 20 }],
          sharedRoomUsers: [BOB],
        }),
      });
    const [a, b] = await Promise.all([
      postSliding(MSC3575, mk(), { pos: '10', extensions: { e2ee: { enabled: true } } }),
      postSliding(MSC4186, mk(), { pos: '10', extensions: { e2ee: {} } }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(e2eeLists(a.body)).toEqual({ changed: [BOB], left: [] });
    expect(e2eeLists(b.body)).toEqual({ changed: [BOB], left: [] });
  });

  it('initial device seed ∥ incremental empty isolation', async () => {
    const initial = createSlidingEnv({
      userKeys: createUserKeysStub({ deviceIds: [DEVICE] }),
    });
    const incr = createSlidingEnv({
      db: createSlidingDb({
        maxStreamPos: 50,
        deviceKeyChanges: [
          { user_id: BOB, stream_position: 3 },
          { user_id: USER, stream_position: 4 },
        ],
        sharedRoomUsers: [BOB],
      }),
    });
    const [seed, stale] = await Promise.all([
      postSliding(V4, initial, { extensions: { e2ee: {} } }),
      postSliding(V4, incr, { pos: '10', extensions: { e2ee: {} } }),
    ]);
    expect(e2eeLists(seed.body).changed).toEqual([USER]);
    expect(e2eeLists(stale.body)).toEqual({ changed: [], left: [] });
  });

  it('pos 10 ∥ pos 40 window isolation', async () => {
    const mk = () =>
      createSlidingEnv({
        db: createSlidingDb({
          maxStreamPos: 50,
          deviceKeyChanges: [
            { user_id: BOB, stream_position: 20 },
            { user_id: CAROL, stream_position: 45 },
          ],
          sharedRoomUsers: [BOB, CAROL],
        }),
      });
    const [low, high] = await Promise.all([
      postSliding(MSC3575, mk(), { pos: '10', extensions: { e2ee: { enabled: true } } }),
      postSliding(MSC3575, mk(), { pos: '40', extensions: { e2ee: { enabled: true } } }),
    ]);
    expect(e2eeLists(low.body).changed).toEqual(expect.arrayContaining([BOB, CAROL]));
    expect(e2eeLists(high.body).changed).toEqual([CAROL]);
    expect(e2eeLists(high.body).changed).not.toContain(BOB);
  });

  it('device_key_changes all() barrier TOCTOU mutates after both wait', async () => {
    const db = createSlidingDb({
      maxStreamPos: 50,
      deviceKeyChanges: [{ user_id: BOB, stream_position: 20 }],
      sharedRoomUsers: [BOB, CAROL],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('SELECT DISTINCT dkc.user_id'),
      },
      mutateAfterBarrier: [{ user_id: CAROL, stream_position: 30 }],
    });
    const env = createSlidingEnv({ db });
    const [a, b] = await Promise.all([
      postSliding(MSC4186, env, { pos: '10', extensions: { e2ee: {} } }),
      postSliding(MSC4186, env, { pos: '10', extensions: { e2ee: {} } }),
    ]);
    expect(e2eeLists(a.body).changed).toEqual([CAROL]);
    expect(e2eeLists(b.body).changed).toEqual([CAROL]);
  });

  it('v4 ∥ MSC3575 ∥ MSC4186 three-way isolation', async () => {
    const mk = () =>
      createSlidingEnv({
        db: createSlidingDb({
          maxStreamPos: 50,
          deviceKeyChanges: [{ user_id: BOB, stream_position: 40 }],
          sharedRoomUsers: [BOB],
        }),
      });
    const [v4, msc, simp] = await Promise.all([
      postSliding(V4, mk(), { pos: '10', extensions: { e2ee: { enabled: true } } }),
      postSliding(MSC3575, mk(), { pos: '10', extensions: { e2ee: { enabled: true } } }),
      postSliding(MSC4186, mk(), { pos: '10', extensions: { e2ee: {} } }),
    ]);
    for (const res of [v4, msc, simp]) {
      expect(res.status).toBe(200);
      expect(e2eeLists(res.body)).toEqual({ changed: [BOB], left: [] });
    }
  });

  it('empty shared map self-only ∥ peer-only isolation', async () => {
    const selfOnly = createSlidingEnv({
      db: createSlidingDb({
        maxStreamPos: 50,
        deviceKeyChanges: [
          { user_id: USER, stream_position: 20 },
          { user_id: BOB, stream_position: 20 },
        ],
        sharedRoomUsers: [],
      }),
    });
    const peerOnly = createSlidingEnv({
      db: createSlidingDb({
        maxStreamPos: 50,
        deviceKeyChanges: [{ user_id: BOB, stream_position: 20 }],
        sharedRoomUsers: [BOB],
      }),
    });
    const [s, p] = await Promise.all([
      postSliding(V4, selfOnly, { pos: '10', extensions: { e2ee: {} } }),
      postSliding(V4, peerOnly, { pos: '10', extensions: { e2ee: {} } }),
    ]);
    expect(e2eeLists(s.body).changed).toEqual([USER]);
    expect(e2eeLists(p.body).changed).toEqual([BOB]);
  });
});

// ---------------------------------------------------------------------------
// /keys/changes concurrent leftover
// ---------------------------------------------------------------------------

describe('keys/changes leftover concurrent-race after #232', () => {
  beforeEach(() => {
    resetSyncMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('update window ∥ delete window isolation', async () => {
    const mk = () =>
      createKeysEnv({
        db: createKeysDb({
          memberships: sharedMemberships(USER, BOB, CAROL),
          keyChanges: [
            { user_id: BOB, device_id: 'D', change_type: 'update', stream_position: 4 },
            { user_id: CAROL, device_id: 'D', change_type: 'delete', stream_position: 7 },
          ],
        }),
      });
    const [upd, del] = await Promise.all([
      keysRequest(mk(), '/_matrix/client/v3/keys/changes?from=0&to=5'),
      keysRequest(mk(), '/_matrix/client/v3/keys/changes?from=5&to=10'),
    ]);
    expect(upd.body).toEqual({ changed: [BOB], left: [] });
    expect(del.body).toEqual({ changed: [], left: [CAROL] });
  });

  it('missing from ∥ valid window isolation', async () => {
    const env = createKeysEnv({
      db: createKeysDb({
        memberships: sharedMemberships(USER, BOB),
        keyChanges: [{ user_id: BOB, device_id: 'D', change_type: 'update', stream_position: 4 }],
      }),
    });
    const [missing, ok] = await Promise.all([
      keysRequest(env, '/_matrix/client/v3/keys/changes?to=10'),
      keysRequest(env, '/_matrix/client/v3/keys/changes?from=0&to=10'),
    ]);
    expect(missing.status).toBe(400);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ changed: [BOB], left: [] });
  });

  it('keys/changes all() barrier TOCTOU mutates after both wait', async () => {
    const db = createKeysDb({
      memberships: sharedMemberships(USER, BOB, CAROL),
      keyChanges: [{ user_id: BOB, device_id: 'D', change_type: 'update', stream_position: 4 }],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM device_key_changes dkc'),
      },
      mutateAfterBarrier: [
        { user_id: CAROL, device_id: 'D', change_type: 'delete', stream_position: 6 },
      ],
    });
    const env = createKeysEnv({ db });
    const [a, b] = await Promise.all([
      keysRequest(env, '/_matrix/client/v3/keys/changes?from=0&to=10'),
      keysRequest(env, '/_matrix/client/v3/keys/changes?from=0&to=10'),
    ]);
    expect(a.body).toEqual({ changed: [], left: [CAROL] });
    expect(b.body).toEqual({ changed: [], left: [CAROL] });
  });

  it('outsider high stream ∥ shared delete isolation', async () => {
    const outsider = createKeysEnv({
      db: createKeysDb({
        memberships: sharedMemberships(USER, BOB),
        keyChanges: [
          {
            user_id: '@outsider:example.com',
            device_id: 'X',
            change_type: 'update',
            stream_position: 8,
          },
        ],
      }),
    });
    const shared = createKeysEnv({
      db: createKeysDb({
        memberships: sharedMemberships(USER, BOB),
        keyChanges: [{ user_id: BOB, device_id: 'D', change_type: 'delete', stream_position: 9 }],
      }),
    });
    const [a, b] = await Promise.all([
      keysRequest(outsider, '/_matrix/client/v3/keys/changes?from=0&to=20'),
      keysRequest(shared, '/_matrix/client/v3/keys/changes?from=0&to=20'),
    ]);
    expect(a.body).toEqual({ changed: [], left: [] });
    expect(b.body).toEqual({ changed: [], left: [BOB] });
  });

  it('same user update+delete ∥ create-as-changed isolation', async () => {
    const both = createKeysEnv({
      db: createKeysDb({
        memberships: sharedMemberships(USER, BOB),
        keyChanges: [
          { user_id: BOB, device_id: 'D1', change_type: 'update', stream_position: 2 },
          { user_id: BOB, device_id: 'D2', change_type: 'delete', stream_position: 3 },
        ],
      }),
    });
    const created = createKeysEnv({
      db: createKeysDb({
        memberships: sharedMemberships(USER, CAROL),
        keyChanges: [{ user_id: CAROL, device_id: 'D', change_type: 'create', stream_position: 2 }],
      }),
    });
    const [a, b] = await Promise.all([
      keysRequest(both, '/_matrix/client/v3/keys/changes?from=1&to=10'),
      keysRequest(created, '/_matrix/client/v3/keys/changes?from=1&to=10'),
    ]);
    expect(a.body).toEqual({ changed: [BOB], left: [BOB] });
    expect(b.body).toEqual({ changed: [CAROL], left: [] });
  });

  it('window matrix flood concurrent from/to pairs', async () => {
    const windows = [
      { from: 0, to: 5, changed: [BOB], left: [] as string[] },
      { from: 5, to: 10, changed: [] as string[], left: [CAROL] },
      { from: 0, to: 10, changed: [BOB], left: [CAROL] },
      { from: 10, to: 20, changed: [] as string[], left: [] as string[] },
      { from: 3, to: 6, changed: [BOB], left: [] as string[] },
      { from: 6, to: 7, changed: [] as string[], left: [CAROL] },
    ];
    const results = await Promise.all(
      windows.map((w) =>
        keysRequest(
          createKeysEnv({
            db: createKeysDb({
              memberships: sharedMemberships(USER, BOB, CAROL),
              keyChanges: [
                { user_id: BOB, device_id: 'D', change_type: 'update', stream_position: 4 },
                { user_id: CAROL, device_id: 'D', change_type: 'delete', stream_position: 7 },
              ],
            }),
          }),
          `/_matrix/client/v3/keys/changes?from=${w.from}&to=${w.to}`
        )
      )
    );
    results.forEach((res, i) => {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ changed: windows[i].changed, left: windows[i].left });
    });
  });

  it('to-bound inclusive ∥ from-bound exclusive concurrent', async () => {
    const mk = () =>
      createKeysEnv({
        db: createKeysDb({
          memberships: sharedMemberships(USER, BOB),
          keyChanges: [{ user_id: BOB, device_id: 'D', change_type: 'update', stream_position: 10 }],
        }),
      });
    const [atTo, atFrom] = await Promise.all([
      keysRequest(mk(), '/_matrix/client/v3/keys/changes?from=0&to=10'),
      keysRequest(mk(), '/_matrix/client/v3/keys/changes?from=10&to=20'),
    ]);
    expect(atTo.body).toEqual({ changed: [BOB], left: [] });
    expect(atFrom.body).toEqual({ changed: [], left: [] });
  });
});
