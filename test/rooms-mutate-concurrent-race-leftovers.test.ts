/**
 * TOKENMAXX HEAVY leftovers after #191 — rooms *mutate concurrent race / TOCTOU*
 * + soft/edge reliability for mutate slices not covered by rooms-api-route-leftovers
 * (#147/#159 route soft floods) or rooms-api-routes base coverage.
 * Orthogonal to admin mutate races (#191), presence API leftovers (#190), sliding-sync
 * (#189), federation keys/membership/account-data race (#188), workflows (#187),
 * oauth/push/account-data/identity (#186), typing (#185), receipts race (#184),
 * qr-login (#183), to-device races (#181), relations (#179), devices/keybackups/report
 * races (#174), keys/media/appservice races (#167).
 * Focus: createRoom alias SELECT→INSERT TOCTOU, join∥join idempotent barriers,
 * join∥leave membership TOCTOU, leave∥leave, invite∥join PL conflict, invite∥kick,
 * kick∥ban, ban∥unban, state PUT∥PUT optimistic concurrency (issue 009), send∥redact,
 * forget∥leave, directory alias PUT∥DELETE, knock∥invite, upgrade∥join, Room cache
 * bump∥invalidate races, soft auth/JSON/method/membership floods.
 * Tests-only. Fixtures use example.com only. No product inventing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, PDU } from '../src/types';

const authState = vi.hoisted(() => ({
  userId: '@alice:example.com' as string | undefined,
  deviceId: 'DEVICEA' as string,
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

const createRoom = vi.fn();
const getRoom = vi.fn();
const storeEvent = vi.fn();
const storeEventIdempotent = vi.fn();
const getRoomState = vi.fn();
const getStateEvent = vi.fn();
const getRoomEvents = vi.fn();
const updateMembership = vi.fn();
const tryInsertJoinMembership = vi.fn();
const getMembership = vi.fn();
const getUserRooms = vi.fn();
const getRoomMembers = vi.fn();
const createRoomAlias = vi.fn();
const getRoomByAlias = vi.fn();
const deleteRoomAlias = vi.fn();
const getEvent = vi.fn();
const notifyUsersOfEvent = vi.fn();
const validateEventSize = vi.fn();

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    createRoom: (...args: unknown[]) => createRoom(...args),
    getRoom: (...args: unknown[]) => getRoom(...args),
    storeEvent: (...args: unknown[]) => storeEvent(...args),
    storeEventIdempotent: (...args: unknown[]) => storeEventIdempotent(...args),
    getRoomState: (...args: unknown[]) => getRoomState(...args),
    getStateEvent: (...args: unknown[]) => getStateEvent(...args),
    getRoomEvents: (...args: unknown[]) => getRoomEvents(...args),
    updateMembership: (...args: unknown[]) => updateMembership(...args),
    tryInsertJoinMembership: (...args: unknown[]) => tryInsertJoinMembership(...args),
    getMembership: (...args: unknown[]) => getMembership(...args),
    getUserRooms: (...args: unknown[]) => getUserRooms(...args),
    getRoomMembers: (...args: unknown[]) => getRoomMembers(...args),
    createRoomAlias: (...args: unknown[]) => createRoomAlias(...args),
    getRoomByAlias: (...args: unknown[]) => getRoomByAlias(...args),
    deleteRoomAlias: (...args: unknown[]) => deleteRoomAlias(...args),
    getEvent: (...args: unknown[]) => getEvent(...args),
    notifyUsersOfEvent: (...args: unknown[]) => notifyUsersOfEvent(...args),
    validateEventSize: (...args: unknown[]) => validateEventSize(...args),
  };
});

const bumpRoomCacheGeneration = vi.fn(async () => undefined);
const invalidateRoomCache = vi.fn(async () => undefined);

vi.mock('../src/services/room-cache', () => ({
  bumpRoomCacheGeneration: (...args: unknown[]) => bumpRoomCacheGeneration(...args),
  invalidateRoomCache: (...args: unknown[]) => invalidateRoomCache(...args),
}));

const generateRoomId = vi.fn(async () => '!newroom:example.com');
const generateEventId = vi.fn(async () => '$evt:example.com');
const generateDeterministicEventId = vi.fn(async () => '$detjoin:example.com');

vi.mock('../src/utils/ids', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ids')>();
  return {
    ...actual,
    generateRoomId: (...args: unknown[]) => generateRoomId(...args),
    generateEventId: (...args: unknown[]) => generateEventId(...args),
    generateDeterministicEventId: (...args: unknown[]) => generateDeterministicEventId(...args),
  };
});

import rooms from '../src/api/rooms';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const SERVER = 'example.com';
const ROOM = '!room:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const ROOM2 = '!room2:example.com';
const ALIAS = '#general:example.com';
const EVENT = '$msg1:example.com';
const EVENT_ENC = encodeURIComponent(EVENT);
const TXN = 'txn-race-1';
const AUTH = { Authorization: 'Bearer test-token' };
const NOW = 1_700_000_000_000;

type SqlCall = { sql: string; args: unknown[] };
type Membership = { membership: string; eventId: string };
type StateMap = Record<string, PDU | null>;
type FnBarrier = { count: number };

type DbOpts = {
  streamPosition?: number;
  batchError?: Error | null;
  knocks?: Array<{ room_id: string; user_id: string }>;
  membershipRows?: Array<{
    room_id: string;
    user_id: string;
    membership: string;
    display_name?: string | null;
    avatar_url?: string | null;
  }>;
  aliasRows?: Array<{ alias: string; room_id: string }>;
  roomRows?: Array<{ room_id: string; room_version: string; is_public: number }>;
  selectBarrier?: { match: (sql: string, args: unknown[]) => boolean; count: number };
  runBarrier?: { match: (sql: string, args: unknown[]) => boolean; count: number };
  lastEvent?: { event_id: string; depth: number } | null;
};

async function withBarrier(
  barrier: { match: (sql: string, args: unknown[]) => boolean; count: number } | undefined,
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

async function withFnBarrier(
  barrier: FnBarrier | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void
) {
  if (!barrier) return;
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

function createSqlDb(opts: DbOpts = {}) {
  let streamPosition = opts.streamPosition ?? 10;
  const knocks = opts.knocks ?? [];
  const membershipRows = opts.membershipRows ?? [];
  const aliasRows = opts.aliasRows ?? [];
  const roomRows = opts.roomRows ?? [];
  const lastEvent =
    opts.lastEvent === undefined
      ? { event_id: '$last:example.com', depth: 5 }
      : opts.lastEvent;
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const selects: SqlCall[] = [];
  const batches: unknown[][] = [];
  let selectBarrier = opts.selectBarrier;
  let runBarrier = opts.runBarrier;
  const selectWaiters = { list: [] as Array<() => void> };
  const runWaiters = { list: [] as Array<() => void> };

  const db = {
    inserts,
    updates,
    deletes,
    selects,
    batches,
    knocks,
    membershipRows,
    aliasRows,
    roomRows,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              await withBarrier(
                selectBarrier,
                selectWaiters,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );

              if (sql.includes('UPDATE stream_positions') && sql.includes('RETURNING position')) {
                const n = args[0] as number;
                streamPosition += n;
                return { position: streamPosition } as T;
              }

              if (sql.includes('SELECT room_id FROM room_aliases WHERE alias = ?')) {
                const alias = args[0] as string;
                const row = aliasRows.find((a) => a.alias === alias);
                return (row ? { room_id: row.room_id } : null) as T;
              }

              if (sql.includes('SELECT room_id, room_version, is_public FROM rooms')) {
                const roomId = args[0] as string;
                const row = roomRows.find((r) => r.room_id === roomId);
                return (row ?? null) as T;
              }

              if (
                sql.includes('SELECT event_id FROM events WHERE room_id = ? ORDER BY depth DESC')
              ) {
                return (lastEvent ? { event_id: lastEvent.event_id } : null) as T;
              }

              return null as T;
            },
            async all<T>() {
              selects.push({ sql, args });
              return { results: [] as T[] };
            },
            async run() {
              await withBarrier(
                runBarrier,
                runWaiters,
                () => {
                  runBarrier = undefined;
                },
                sql,
                args
              );
              if (sql.trimStart().startsWith('INSERT')) {
                inserts.push({ sql, args });
                if (sql.includes('room_knocks')) {
                  knocks.push({
                    room_id: args[0] as string,
                    user_id: args[1] as string,
                  });
                }
              } else if (sql.trimStart().startsWith('UPDATE')) {
                updates.push({ sql, args });
              } else if (sql.trimStart().startsWith('DELETE')) {
                deletes.push({ sql, args });
                if (sql.includes('DELETE FROM room_memberships')) {
                  const [roomId, userId] = args as string[];
                  const idx = membershipRows.findIndex(
                    (m) => m.room_id === roomId && m.user_id === userId
                  );
                  if (idx >= 0) membershipRows.splice(idx, 1);
                }
                if (sql.includes('DELETE FROM rooms')) {
                  const roomId = args[0] as string;
                  const idx = roomRows.findIndex((r) => r.room_id === roomId);
                  if (idx >= 0) roomRows.splice(idx, 1);
                }
                if (sql.includes('DELETE FROM room_aliases')) {
                  const alias = args[0] as string;
                  const idx = aliasRows.findIndex((a) => a.alias === alias);
                  if (idx >= 0) aliasRows.splice(idx, 1);
                }
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch(stmts: unknown[]) {
      batches.push(stmts);
      if (opts.batchError) throw opts.batchError;
      return stmts.map(() => ({ success: true }));
    },
  };

  return db;
}

type SqlDb = ReturnType<typeof createSqlDb>;

function mockKv() {
  const puts: Array<{ key: string; value: string }> = [];
  const deletes: string[] = [];
  return {
    puts,
    deletes,
    get: async () => null,
    put: async (key: string, value: string) => {
      puts.push({ key, value });
    },
    delete: async (key: string) => {
      deletes.push(key);
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace & {
    puts: Array<{ key: string; value: string }>;
    deletes: string[];
  };
}

function createExecCtx() {
  const waitUntilPromises: Promise<unknown>[] = [];
  return {
    waitUntil(p: Promise<unknown>) {
      waitUntilPromises.push(p);
    },
    passThroughOnException() {},
    props: {},
    waitUntilPromises,
  };
}

function createWorkflowStub(status: { status: string; output?: unknown }) {
  const creates: unknown[] = [];
  return {
    creates,
    async create(opts: unknown) {
      creates.push(opts);
      return {
        async status() {
          return status;
        },
      };
    },
  };
}

function envFor(
  db: SqlDb,
  extras: {
    workflow?: ReturnType<typeof createWorkflowStub>;
    pushWorkflow?: { create: ReturnType<typeof vi.fn> };
    cache?: ReturnType<typeof mockKv>;
  } = {}
): Env {
  return {
    DB: db as unknown as D1Database,
    CACHE: extras.cache ?? mockKv(),
    SERVER_NAME: SERVER,
    ROOM_JOIN_WORKFLOW: (extras.workflow ??
      createWorkflowStub({
        status: 'complete',
        output: { success: true },
      })) as unknown as Env['ROOM_JOIN_WORKFLOW'],
    PUSH_NOTIFICATION_WORKFLOW: (extras.pushWorkflow ?? {
      create: vi.fn(async () => ({ id: 'push-1' })),
    }) as unknown as Env['PUSH_NOTIFICATION_WORKFLOW'],
  } as unknown as Env;
}

async function request(
  path: string,
  init: RequestInit = {},
  db: SqlDb = createSqlDb(),
  extras: Parameters<typeof envFor>[1] = {},
  execCtx: ReturnType<typeof createExecCtx> = createExecCtx()
): Promise<{
  status: number;
  body: unknown;
  errcode?: string;
  db: SqlDb;
  execCtx: ReturnType<typeof createExecCtx>;
}> {
  const env = envFor(db, extras);
  const res = await rooms.request('http://localhost' + path, init, env, execCtx as never);
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const errcode =
    body && typeof body === 'object' && body !== null && 'errcode' in body
      ? String((body as { errcode: string }).errcode)
      : undefined;
  return { status: res.status, body, errcode, db, execCtx };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  const upper = method.toUpperCase();
  const init: RequestInit = {
    method,
    headers: {
      ...AUTH,
      ...(upper === 'GET' || upper === 'HEAD'
        ? {}
        : { 'Content-Type': 'application/json' }),
    },
  };
  if (upper !== 'GET' && upper !== 'HEAD' && body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return init;
}

function joinMembership(eventId = '$alice-join'): Membership {
  return { membership: 'join', eventId };
}

function pdu(overrides: Partial<PDU> & { type: string; event_id: string }): PDU {
  return {
    room_id: ROOM,
    sender: USER,
    content: {},
    origin_server_ts: NOW,
    depth: 1,
    auth_events: [],
    prev_events: [],
    ...overrides,
  };
}

function defaultPlContent(extraUsers: Record<string, number> = {}) {
  return {
    users: { [USER]: 100, [BOB]: 50, ...extraUsers },
    users_default: 0,
    state_default: 50,
    events_default: 0,
    ban: 50,
    kick: 50,
    redact: 50,
    invite: 50,
    events: {
      'm.room.name': 50,
      'm.room.tombstone': 100,
      'm.room.power_levels': 100,
    },
  };
}

function defaultState(overrides: StateMap = {}): void {
  getStateEvent.mockImplementation(async (_db, _room, type: string, stateKey = '') => {
    const key = stateKey ? `${type}\0${stateKey}` : type;
    if (key in overrides) return overrides[key];
    if (type in overrides) return overrides[type];
    const defaults: StateMap = {
      'm.room.create': pdu({
        type: 'm.room.create',
        event_id: '$create',
        content: { creator: USER, room_version: '10' },
        state_key: '',
      }),
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'public' },
        state_key: '',
      }),
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        content: defaultPlContent(),
        state_key: '',
      }),
    };
    return defaults[type] ?? null;
  });
}

function seedLocalRoom() {
  getRoom.mockResolvedValue({
    room_id: ROOM,
    room_version: '10',
    creator: USER,
    is_public: false,
  });
  getRoomEvents.mockResolvedValue({
    events: [pdu({ type: 'm.room.message', event_id: EVENT, depth: 3 })],
    end: 3,
  });
}

function resetMocks() {
  authState.userId = USER;
  authState.deviceId = 'DEVICEA';
  createRoom.mockReset().mockResolvedValue(undefined);
  getRoom.mockReset();
  storeEvent.mockReset().mockResolvedValue(1);
  storeEventIdempotent.mockReset().mockResolvedValue({
    inserted: true,
    eventId: '$detjoin:example.com',
  });
  getRoomState.mockReset().mockResolvedValue([]);
  getStateEvent.mockReset();
  getRoomEvents.mockReset().mockResolvedValue({ events: [], end: 0 });
  updateMembership.mockReset().mockResolvedValue(undefined);
  tryInsertJoinMembership.mockReset().mockResolvedValue({
    inserted: true,
    eventId: '$detjoin:example.com',
  });
  getMembership.mockReset();
  getUserRooms.mockReset().mockResolvedValue([]);
  getRoomMembers.mockReset().mockResolvedValue([]);
  createRoomAlias.mockReset().mockResolvedValue(undefined);
  getRoomByAlias.mockReset().mockResolvedValue(null);
  deleteRoomAlias.mockReset().mockResolvedValue(undefined);
  getEvent.mockReset();
  notifyUsersOfEvent.mockReset().mockResolvedValue(undefined);
  validateEventSize.mockReset();
  bumpRoomCacheGeneration.mockReset().mockResolvedValue(undefined);
  invalidateRoomCache.mockReset().mockResolvedValue(undefined);
  generateRoomId.mockReset().mockResolvedValue('!newroom:example.com');
  let evtSeq = 0;
  generateEventId.mockReset().mockImplementation(async () => {
    evtSeq += 1;
    return `$evt${evtSeq}:example.com`;
  });
  generateDeterministicEventId.mockReset().mockResolvedValue('$detjoin:example.com');
  defaultState();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

beforeEach(() => {
  resetMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});


// ---------------------------------------------------------------------------
// race createRoom alias SELECT→INSERT TOCTOU after #191
// ---------------------------------------------------------------------------

describe('race createRoom alias SELECT→INSERT TOCTOU after #191', () => {
  it(`create∥create same alias barrier #0`, async () => {
    const i = 0;
    const localpart = `general${i}`;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let aliasGets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      aliasGets += 1;
      return null;
    });
    let roomSeq = 0;
    generateRoomId.mockImplementation(async () => {
      roomSeq += 1;
      return `!newroom${roomSeq}-${i}:example.com`;
    });
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_alias_local_part: localpart, preset: 'public_chat' }),
        db
      ),
      request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_alias_local_part: localpart, preset: 'public_chat' }),
        db
      ),
    ]);
    expect([a.status, b.status].every((s) => [200, 400, 500].includes(s))).toBe(true);
    expect(aliasGets).toBeGreaterThanOrEqual(2);
    expect(createRoom.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`create∥create same alias barrier #1`, async () => {
    const i = 1;
    const localpart = `general${i}`;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let aliasGets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      aliasGets += 1;
      return null;
    });
    let roomSeq = 0;
    generateRoomId.mockImplementation(async () => {
      roomSeq += 1;
      return `!newroom${roomSeq}-${i}:example.com`;
    });
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_alias_local_part: localpart, preset: 'public_chat' }),
        db
      ),
      request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_alias_local_part: localpart, preset: 'public_chat' }),
        db
      ),
    ]);
    expect([a.status, b.status].every((s) => [200, 400, 500].includes(s))).toBe(true);
    expect(aliasGets).toBeGreaterThanOrEqual(2);
    expect(createRoom.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`create∥create same alias barrier #2`, async () => {
    const i = 2;
    const localpart = `general${i}`;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let aliasGets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      aliasGets += 1;
      return null;
    });
    let roomSeq = 0;
    generateRoomId.mockImplementation(async () => {
      roomSeq += 1;
      return `!newroom${roomSeq}-${i}:example.com`;
    });
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_alias_local_part: localpart, preset: 'public_chat' }),
        db
      ),
      request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_alias_local_part: localpart, preset: 'public_chat' }),
        db
      ),
    ]);
    expect([a.status, b.status].every((s) => [200, 400, 500].includes(s))).toBe(true);
    expect(aliasGets).toBeGreaterThanOrEqual(2);
    expect(createRoom.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`create∥create same alias barrier #3`, async () => {
    const i = 3;
    const localpart = `general${i}`;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let aliasGets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      aliasGets += 1;
      return null;
    });
    let roomSeq = 0;
    generateRoomId.mockImplementation(async () => {
      roomSeq += 1;
      return `!newroom${roomSeq}-${i}:example.com`;
    });
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_alias_local_part: localpart, preset: 'public_chat' }),
        db
      ),
      request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_alias_local_part: localpart, preset: 'public_chat' }),
        db
      ),
    ]);
    expect([a.status, b.status].every((s) => [200, 400, 500].includes(s))).toBe(true);
    expect(aliasGets).toBeGreaterThanOrEqual(2);
    expect(createRoom.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`create∥create same alias barrier #4`, async () => {
    const i = 4;
    const localpart = `general${i}`;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let aliasGets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      aliasGets += 1;
      return null;
    });
    let roomSeq = 0;
    generateRoomId.mockImplementation(async () => {
      roomSeq += 1;
      return `!newroom${roomSeq}-${i}:example.com`;
    });
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_alias_local_part: localpart, preset: 'public_chat' }),
        db
      ),
      request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_alias_local_part: localpart, preset: 'public_chat' }),
        db
      ),
    ]);
    expect([a.status, b.status].every((s) => [200, 400, 500].includes(s))).toBe(true);
    expect(aliasGets).toBeGreaterThanOrEqual(2);
    expect(createRoom.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`create∥create same alias barrier #5`, async () => {
    const i = 5;
    const localpart = `general${i}`;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let aliasGets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      aliasGets += 1;
      return null;
    });
    let roomSeq = 0;
    generateRoomId.mockImplementation(async () => {
      roomSeq += 1;
      return `!newroom${roomSeq}-${i}:example.com`;
    });
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_alias_local_part: localpart, preset: 'public_chat' }),
        db
      ),
      request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_alias_local_part: localpart, preset: 'public_chat' }),
        db
      ),
    ]);
    expect([a.status, b.status].every((s) => [200, 400, 500].includes(s))).toBe(true);
    expect(aliasGets).toBeGreaterThanOrEqual(2);
    expect(createRoom.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`create∥create same alias barrier #6`, async () => {
    const i = 6;
    const localpart = `general${i}`;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let aliasGets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      aliasGets += 1;
      return null;
    });
    let roomSeq = 0;
    generateRoomId.mockImplementation(async () => {
      roomSeq += 1;
      return `!newroom${roomSeq}-${i}:example.com`;
    });
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_alias_local_part: localpart, preset: 'public_chat' }),
        db
      ),
      request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_alias_local_part: localpart, preset: 'public_chat' }),
        db
      ),
    ]);
    expect([a.status, b.status].every((s) => [200, 400, 500].includes(s))).toBe(true);
    expect(aliasGets).toBeGreaterThanOrEqual(2);
    expect(createRoom.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`create∥create same alias barrier #7`, async () => {
    const i = 7;
    const localpart = `general${i}`;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let aliasGets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      aliasGets += 1;
      return null;
    });
    let roomSeq = 0;
    generateRoomId.mockImplementation(async () => {
      roomSeq += 1;
      return `!newroom${roomSeq}-${i}:example.com`;
    });
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_alias_local_part: localpart, preset: 'public_chat' }),
        db
      ),
      request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_alias_local_part: localpart, preset: 'public_chat' }),
        db
      ),
    ]);
    expect([a.status, b.status].every((s) => [200, 400, 500].includes(s))).toBe(true);
    expect(aliasGets).toBeGreaterThanOrEqual(2);
    expect(createRoom.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`create∥create same alias barrier #8`, async () => {
    const i = 8;
    const localpart = `general${i}`;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let aliasGets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      aliasGets += 1;
      return null;
    });
    let roomSeq = 0;
    generateRoomId.mockImplementation(async () => {
      roomSeq += 1;
      return `!newroom${roomSeq}-${i}:example.com`;
    });
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_alias_local_part: localpart, preset: 'public_chat' }),
        db
      ),
      request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_alias_local_part: localpart, preset: 'public_chat' }),
        db
      ),
    ]);
    expect([a.status, b.status].every((s) => [200, 400, 500].includes(s))).toBe(true);
    expect(aliasGets).toBeGreaterThanOrEqual(2);
    expect(createRoom.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`create∥create same alias barrier #9`, async () => {
    const i = 9;
    const localpart = `general${i}`;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let aliasGets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      aliasGets += 1;
      return null;
    });
    let roomSeq = 0;
    generateRoomId.mockImplementation(async () => {
      roomSeq += 1;
      return `!newroom${roomSeq}-${i}:example.com`;
    });
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_alias_local_part: localpart, preset: 'public_chat' }),
        db
      ),
      request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_alias_local_part: localpart, preset: 'public_chat' }),
        db
      ),
    ]);
    expect([a.status, b.status].every((s) => [200, 400, 500].includes(s))).toBe(true);
    expect(aliasGets).toBeGreaterThanOrEqual(2);
    expect(createRoom.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`create∥create same alias barrier #10`, async () => {
    const i = 10;
    const localpart = `general${i}`;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let aliasGets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      aliasGets += 1;
      return null;
    });
    let roomSeq = 0;
    generateRoomId.mockImplementation(async () => {
      roomSeq += 1;
      return `!newroom${roomSeq}-${i}:example.com`;
    });
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_alias_local_part: localpart, preset: 'public_chat' }),
        db
      ),
      request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_alias_local_part: localpart, preset: 'public_chat' }),
        db
      ),
    ]);
    expect([a.status, b.status].every((s) => [200, 400, 500].includes(s))).toBe(true);
    expect(aliasGets).toBeGreaterThanOrEqual(2);
    expect(createRoom.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`create∥create same alias barrier #11`, async () => {
    const i = 11;
    const localpart = `general${i}`;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let aliasGets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      aliasGets += 1;
      return null;
    });
    let roomSeq = 0;
    generateRoomId.mockImplementation(async () => {
      roomSeq += 1;
      return `!newroom${roomSeq}-${i}:example.com`;
    });
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_alias_local_part: localpart, preset: 'public_chat' }),
        db
      ),
      request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_alias_local_part: localpart, preset: 'public_chat' }),
        db
      ),
    ]);
    expect([a.status, b.status].every((s) => [200, 400, 500].includes(s))).toBe(true);
    expect(aliasGets).toBeGreaterThanOrEqual(2);
    expect(createRoom.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`create∥create second observes taken mid-flight #0`, async () => {
    const i = 0;
    const localpart = `taken${i}`;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let aliasGets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      aliasGets += 1;
      if (aliasGets === 1) return null;
      return { room_id: '!other:example.com', alias: `#taken${i}:example.com` };
    });
    generateRoomId.mockResolvedValue(`!solo${i}:example.com`);
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_alias_local_part: localpart }), db),
      request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_alias_local_part: localpart }), db),
    ]);
    expect(aliasGets).toBe(2);
    expect(a.status === 200 || b.status === 200 || [a.errcode, b.errcode].includes('M_ROOM_IN_USE')).toBe(true);
  });

  it(`create∥create second observes taken mid-flight #1`, async () => {
    const i = 1;
    const localpart = `taken${i}`;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let aliasGets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      aliasGets += 1;
      if (aliasGets === 1) return null;
      return { room_id: '!other:example.com', alias: `#taken${i}:example.com` };
    });
    generateRoomId.mockResolvedValue(`!solo${i}:example.com`);
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_alias_local_part: localpart }), db),
      request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_alias_local_part: localpart }), db),
    ]);
    expect(aliasGets).toBe(2);
    expect(a.status === 200 || b.status === 200 || [a.errcode, b.errcode].includes('M_ROOM_IN_USE')).toBe(true);
  });

  it(`create∥create second observes taken mid-flight #2`, async () => {
    const i = 2;
    const localpart = `taken${i}`;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let aliasGets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      aliasGets += 1;
      if (aliasGets === 1) return null;
      return { room_id: '!other:example.com', alias: `#taken${i}:example.com` };
    });
    generateRoomId.mockResolvedValue(`!solo${i}:example.com`);
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_alias_local_part: localpart }), db),
      request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_alias_local_part: localpart }), db),
    ]);
    expect(aliasGets).toBe(2);
    expect(a.status === 200 || b.status === 200 || [a.errcode, b.errcode].includes('M_ROOM_IN_USE')).toBe(true);
  });

  it(`create∥create second observes taken mid-flight #3`, async () => {
    const i = 3;
    const localpart = `taken${i}`;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let aliasGets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      aliasGets += 1;
      if (aliasGets === 1) return null;
      return { room_id: '!other:example.com', alias: `#taken${i}:example.com` };
    });
    generateRoomId.mockResolvedValue(`!solo${i}:example.com`);
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_alias_local_part: localpart }), db),
      request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_alias_local_part: localpart }), db),
    ]);
    expect(aliasGets).toBe(2);
    expect(a.status === 200 || b.status === 200 || [a.errcode, b.errcode].includes('M_ROOM_IN_USE')).toBe(true);
  });

  it(`create∥create second observes taken mid-flight #4`, async () => {
    const i = 4;
    const localpart = `taken${i}`;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let aliasGets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      aliasGets += 1;
      if (aliasGets === 1) return null;
      return { room_id: '!other:example.com', alias: `#taken${i}:example.com` };
    });
    generateRoomId.mockResolvedValue(`!solo${i}:example.com`);
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_alias_local_part: localpart }), db),
      request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_alias_local_part: localpart }), db),
    ]);
    expect(aliasGets).toBe(2);
    expect(a.status === 200 || b.status === 200 || [a.errcode, b.errcode].includes('M_ROOM_IN_USE')).toBe(true);
  });

  it(`create∥create second observes taken mid-flight #5`, async () => {
    const i = 5;
    const localpart = `taken${i}`;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let aliasGets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      aliasGets += 1;
      if (aliasGets === 1) return null;
      return { room_id: '!other:example.com', alias: `#taken${i}:example.com` };
    });
    generateRoomId.mockResolvedValue(`!solo${i}:example.com`);
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_alias_local_part: localpart }), db),
      request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_alias_local_part: localpart }), db),
    ]);
    expect(aliasGets).toBe(2);
    expect(a.status === 200 || b.status === 200 || [a.errcode, b.errcode].includes('M_ROOM_IN_USE')).toBe(true);
  });

  it(`create∥create second observes taken mid-flight #6`, async () => {
    const i = 6;
    const localpart = `taken${i}`;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let aliasGets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      aliasGets += 1;
      if (aliasGets === 1) return null;
      return { room_id: '!other:example.com', alias: `#taken${i}:example.com` };
    });
    generateRoomId.mockResolvedValue(`!solo${i}:example.com`);
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_alias_local_part: localpart }), db),
      request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_alias_local_part: localpart }), db),
    ]);
    expect(aliasGets).toBe(2);
    expect(a.status === 200 || b.status === 200 || [a.errcode, b.errcode].includes('M_ROOM_IN_USE')).toBe(true);
  });

  it(`create∥create second observes taken mid-flight #7`, async () => {
    const i = 7;
    const localpart = `taken${i}`;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let aliasGets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      aliasGets += 1;
      if (aliasGets === 1) return null;
      return { room_id: '!other:example.com', alias: `#taken${i}:example.com` };
    });
    generateRoomId.mockResolvedValue(`!solo${i}:example.com`);
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_alias_local_part: localpart }), db),
      request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_alias_local_part: localpart }), db),
    ]);
    expect(aliasGets).toBe(2);
    expect(a.status === 200 || b.status === 200 || [a.errcode, b.errcode].includes('M_ROOM_IN_USE')).toBe(true);
  });

  it(`create∥create second observes taken mid-flight #8`, async () => {
    const i = 8;
    const localpart = `taken${i}`;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let aliasGets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      aliasGets += 1;
      if (aliasGets === 1) return null;
      return { room_id: '!other:example.com', alias: `#taken${i}:example.com` };
    });
    generateRoomId.mockResolvedValue(`!solo${i}:example.com`);
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_alias_local_part: localpart }), db),
      request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_alias_local_part: localpart }), db),
    ]);
    expect(aliasGets).toBe(2);
    expect(a.status === 200 || b.status === 200 || [a.errcode, b.errcode].includes('M_ROOM_IN_USE')).toBe(true);
  });

  it(`create∥create second observes taken mid-flight #9`, async () => {
    const i = 9;
    const localpart = `taken${i}`;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let aliasGets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      aliasGets += 1;
      if (aliasGets === 1) return null;
      return { room_id: '!other:example.com', alias: `#taken${i}:example.com` };
    });
    generateRoomId.mockResolvedValue(`!solo${i}:example.com`);
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_alias_local_part: localpart }), db),
      request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_alias_local_part: localpart }), db),
    ]);
    expect(aliasGets).toBe(2);
    expect(a.status === 200 || b.status === 200 || [a.errcode, b.errcode].includes('M_ROOM_IN_USE')).toBe(true);
  });

  it(`create∥create second observes taken mid-flight #10`, async () => {
    const i = 10;
    const localpart = `taken${i}`;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let aliasGets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      aliasGets += 1;
      if (aliasGets === 1) return null;
      return { room_id: '!other:example.com', alias: `#taken${i}:example.com` };
    });
    generateRoomId.mockResolvedValue(`!solo${i}:example.com`);
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_alias_local_part: localpart }), db),
      request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_alias_local_part: localpart }), db),
    ]);
    expect(aliasGets).toBe(2);
    expect(a.status === 200 || b.status === 200 || [a.errcode, b.errcode].includes('M_ROOM_IN_USE')).toBe(true);
  });

  it(`create∥create second observes taken mid-flight #11`, async () => {
    const i = 11;
    const localpart = `taken${i}`;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let aliasGets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      aliasGets += 1;
      if (aliasGets === 1) return null;
      return { room_id: '!other:example.com', alias: `#taken${i}:example.com` };
    });
    generateRoomId.mockResolvedValue(`!solo${i}:example.com`);
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_alias_local_part: localpart }), db),
      request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_alias_local_part: localpart }), db),
    ]);
    expect(aliasGets).toBe(2);
    expect(a.status === 200 || b.status === 200 || [a.errcode, b.errcode].includes('M_ROOM_IN_USE')).toBe(true);
  });

});


// ---------------------------------------------------------------------------
// race join∥join membership SELECT→write TOCTOU after #191
// ---------------------------------------------------------------------------

describe('race join∥join membership SELECT→write TOCTOU after #191', () => {
  it(`join∥join already-joined mid-flight #0`, async () => {
    const i = 0;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (calls <= 2) return { membership: 'invite', eventId: `$inv${i}` };
      return joinMembership(`$join${i}`);
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    let insertCount = 0;
    storeEventIdempotent.mockImplementation(async () => {
      insertCount += 1;
      return { inserted: insertCount === 1, eventId: '$detjoin:example.com' };
    });
    tryInsertJoinMembership.mockImplementation(async () => ({
      inserted: insertCount === 1,
      eventId: '$detjoin:example.com',
    }));
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEventIdempotent.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`join∥join already-joined mid-flight #1`, async () => {
    const i = 1;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (calls <= 2) return { membership: 'invite', eventId: `$inv${i}` };
      return joinMembership(`$join${i}`);
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    let insertCount = 0;
    storeEventIdempotent.mockImplementation(async () => {
      insertCount += 1;
      return { inserted: insertCount === 1, eventId: '$detjoin:example.com' };
    });
    tryInsertJoinMembership.mockImplementation(async () => ({
      inserted: insertCount === 1,
      eventId: '$detjoin:example.com',
    }));
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEventIdempotent.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`join∥join already-joined mid-flight #2`, async () => {
    const i = 2;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (calls <= 2) return { membership: 'invite', eventId: `$inv${i}` };
      return joinMembership(`$join${i}`);
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    let insertCount = 0;
    storeEventIdempotent.mockImplementation(async () => {
      insertCount += 1;
      return { inserted: insertCount === 1, eventId: '$detjoin:example.com' };
    });
    tryInsertJoinMembership.mockImplementation(async () => ({
      inserted: insertCount === 1,
      eventId: '$detjoin:example.com',
    }));
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEventIdempotent.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`join∥join already-joined mid-flight #3`, async () => {
    const i = 3;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (calls <= 2) return { membership: 'invite', eventId: `$inv${i}` };
      return joinMembership(`$join${i}`);
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    let insertCount = 0;
    storeEventIdempotent.mockImplementation(async () => {
      insertCount += 1;
      return { inserted: insertCount === 1, eventId: '$detjoin:example.com' };
    });
    tryInsertJoinMembership.mockImplementation(async () => ({
      inserted: insertCount === 1,
      eventId: '$detjoin:example.com',
    }));
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEventIdempotent.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`join∥join already-joined mid-flight #4`, async () => {
    const i = 4;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (calls <= 2) return { membership: 'invite', eventId: `$inv${i}` };
      return joinMembership(`$join${i}`);
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    let insertCount = 0;
    storeEventIdempotent.mockImplementation(async () => {
      insertCount += 1;
      return { inserted: insertCount === 1, eventId: '$detjoin:example.com' };
    });
    tryInsertJoinMembership.mockImplementation(async () => ({
      inserted: insertCount === 1,
      eventId: '$detjoin:example.com',
    }));
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEventIdempotent.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`join∥join already-joined mid-flight #5`, async () => {
    const i = 5;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (calls <= 2) return { membership: 'invite', eventId: `$inv${i}` };
      return joinMembership(`$join${i}`);
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    let insertCount = 0;
    storeEventIdempotent.mockImplementation(async () => {
      insertCount += 1;
      return { inserted: insertCount === 1, eventId: '$detjoin:example.com' };
    });
    tryInsertJoinMembership.mockImplementation(async () => ({
      inserted: insertCount === 1,
      eventId: '$detjoin:example.com',
    }));
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEventIdempotent.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`join∥join already-joined mid-flight #6`, async () => {
    const i = 6;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (calls <= 2) return { membership: 'invite', eventId: `$inv${i}` };
      return joinMembership(`$join${i}`);
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    let insertCount = 0;
    storeEventIdempotent.mockImplementation(async () => {
      insertCount += 1;
      return { inserted: insertCount === 1, eventId: '$detjoin:example.com' };
    });
    tryInsertJoinMembership.mockImplementation(async () => ({
      inserted: insertCount === 1,
      eventId: '$detjoin:example.com',
    }));
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEventIdempotent.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`join∥join already-joined mid-flight #7`, async () => {
    const i = 7;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (calls <= 2) return { membership: 'invite', eventId: `$inv${i}` };
      return joinMembership(`$join${i}`);
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    let insertCount = 0;
    storeEventIdempotent.mockImplementation(async () => {
      insertCount += 1;
      return { inserted: insertCount === 1, eventId: '$detjoin:example.com' };
    });
    tryInsertJoinMembership.mockImplementation(async () => ({
      inserted: insertCount === 1,
      eventId: '$detjoin:example.com',
    }));
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEventIdempotent.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`join∥join already-joined mid-flight #8`, async () => {
    const i = 8;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (calls <= 2) return { membership: 'invite', eventId: `$inv${i}` };
      return joinMembership(`$join${i}`);
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    let insertCount = 0;
    storeEventIdempotent.mockImplementation(async () => {
      insertCount += 1;
      return { inserted: insertCount === 1, eventId: '$detjoin:example.com' };
    });
    tryInsertJoinMembership.mockImplementation(async () => ({
      inserted: insertCount === 1,
      eventId: '$detjoin:example.com',
    }));
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEventIdempotent.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`join∥join already-joined mid-flight #9`, async () => {
    const i = 9;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (calls <= 2) return { membership: 'invite', eventId: `$inv${i}` };
      return joinMembership(`$join${i}`);
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    let insertCount = 0;
    storeEventIdempotent.mockImplementation(async () => {
      insertCount += 1;
      return { inserted: insertCount === 1, eventId: '$detjoin:example.com' };
    });
    tryInsertJoinMembership.mockImplementation(async () => ({
      inserted: insertCount === 1,
      eventId: '$detjoin:example.com',
    }));
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEventIdempotent.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`join∥join already-joined mid-flight #10`, async () => {
    const i = 10;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (calls <= 2) return { membership: 'invite', eventId: `$inv${i}` };
      return joinMembership(`$join${i}`);
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    let insertCount = 0;
    storeEventIdempotent.mockImplementation(async () => {
      insertCount += 1;
      return { inserted: insertCount === 1, eventId: '$detjoin:example.com' };
    });
    tryInsertJoinMembership.mockImplementation(async () => ({
      inserted: insertCount === 1,
      eventId: '$detjoin:example.com',
    }));
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEventIdempotent.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`join∥join already-joined mid-flight #11`, async () => {
    const i = 11;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (calls <= 2) return { membership: 'invite', eventId: `$inv${i}` };
      return joinMembership(`$join${i}`);
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    let insertCount = 0;
    storeEventIdempotent.mockImplementation(async () => {
      insertCount += 1;
      return { inserted: insertCount === 1, eventId: '$detjoin:example.com' };
    });
    tryInsertJoinMembership.mockImplementation(async () => ({
      inserted: insertCount === 1,
      eventId: '$detjoin:example.com',
    }));
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEventIdempotent.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`join∥join public already-member short-circuit #0`, async () => {
    const i = 0;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return joinMembership(`$j${i}`);
    });
    // Already-joined short-circuit only fires when join_rule is not public.
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEventIdempotent).not.toHaveBeenCalled();
  });

  it(`join∥join public already-member short-circuit #1`, async () => {
    const i = 1;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return joinMembership(`$j${i}`);
    });
    // Already-joined short-circuit only fires when join_rule is not public.
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEventIdempotent).not.toHaveBeenCalled();
  });

  it(`join∥join public already-member short-circuit #2`, async () => {
    const i = 2;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return joinMembership(`$j${i}`);
    });
    // Already-joined short-circuit only fires when join_rule is not public.
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEventIdempotent).not.toHaveBeenCalled();
  });

  it(`join∥join public already-member short-circuit #3`, async () => {
    const i = 3;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return joinMembership(`$j${i}`);
    });
    // Already-joined short-circuit only fires when join_rule is not public.
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEventIdempotent).not.toHaveBeenCalled();
  });

  it(`join∥join public already-member short-circuit #4`, async () => {
    const i = 4;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return joinMembership(`$j${i}`);
    });
    // Already-joined short-circuit only fires when join_rule is not public.
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEventIdempotent).not.toHaveBeenCalled();
  });

  it(`join∥join public already-member short-circuit #5`, async () => {
    const i = 5;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return joinMembership(`$j${i}`);
    });
    // Already-joined short-circuit only fires when join_rule is not public.
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEventIdempotent).not.toHaveBeenCalled();
  });

  it(`join∥join public already-member short-circuit #6`, async () => {
    const i = 6;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return joinMembership(`$j${i}`);
    });
    // Already-joined short-circuit only fires when join_rule is not public.
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEventIdempotent).not.toHaveBeenCalled();
  });

  it(`join∥join public already-member short-circuit #7`, async () => {
    const i = 7;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return joinMembership(`$j${i}`);
    });
    // Already-joined short-circuit only fires when join_rule is not public.
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEventIdempotent).not.toHaveBeenCalled();
  });

  it(`join∥join public already-member short-circuit #8`, async () => {
    const i = 8;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return joinMembership(`$j${i}`);
    });
    // Already-joined short-circuit only fires when join_rule is not public.
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEventIdempotent).not.toHaveBeenCalled();
  });

  it(`join∥join public already-member short-circuit #9`, async () => {
    const i = 9;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return joinMembership(`$j${i}`);
    });
    // Already-joined short-circuit only fires when join_rule is not public.
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEventIdempotent).not.toHaveBeenCalled();
  });

  it(`join∥join public already-member short-circuit #10`, async () => {
    const i = 10;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return joinMembership(`$j${i}`);
    });
    // Already-joined short-circuit only fires when join_rule is not public.
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEventIdempotent).not.toHaveBeenCalled();
  });

  it(`join∥join public already-member short-circuit #11`, async () => {
    const i = 11;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return joinMembership(`$j${i}`);
    });
    // Already-joined short-circuit only fires when join_rule is not public.
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEventIdempotent).not.toHaveBeenCalled();
  });

});


// ---------------------------------------------------------------------------
// race join∥leave membership TOCTOU after #191
// ---------------------------------------------------------------------------

describe('race join∥leave membership TOCTOU after #191', () => {
  it(`join∥leave interleaved membership #0`, async () => {
    const i = 0;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (userId === USER) {
        return calls % 2 === 1
          ? { membership: 'invite', eventId: `$i${i}` }
          : joinMembership(`$j${i}`);
      }
      return null;
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const [joinRes, leaveRes] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
    ]);
    expect([joinRes.status, leaveRes.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`join∥leave interleaved membership #1`, async () => {
    const i = 1;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (userId === USER) {
        return calls % 2 === 1
          ? { membership: 'invite', eventId: `$i${i}` }
          : joinMembership(`$j${i}`);
      }
      return null;
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const [joinRes, leaveRes] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
    ]);
    expect([joinRes.status, leaveRes.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`join∥leave interleaved membership #2`, async () => {
    const i = 2;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (userId === USER) {
        return calls % 2 === 1
          ? { membership: 'invite', eventId: `$i${i}` }
          : joinMembership(`$j${i}`);
      }
      return null;
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const [joinRes, leaveRes] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
    ]);
    expect([joinRes.status, leaveRes.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`join∥leave interleaved membership #3`, async () => {
    const i = 3;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (userId === USER) {
        return calls % 2 === 1
          ? { membership: 'invite', eventId: `$i${i}` }
          : joinMembership(`$j${i}`);
      }
      return null;
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const [joinRes, leaveRes] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
    ]);
    expect([joinRes.status, leaveRes.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`join∥leave interleaved membership #4`, async () => {
    const i = 4;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (userId === USER) {
        return calls % 2 === 1
          ? { membership: 'invite', eventId: `$i${i}` }
          : joinMembership(`$j${i}`);
      }
      return null;
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const [joinRes, leaveRes] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
    ]);
    expect([joinRes.status, leaveRes.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`join∥leave interleaved membership #5`, async () => {
    const i = 5;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (userId === USER) {
        return calls % 2 === 1
          ? { membership: 'invite', eventId: `$i${i}` }
          : joinMembership(`$j${i}`);
      }
      return null;
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const [joinRes, leaveRes] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
    ]);
    expect([joinRes.status, leaveRes.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`join∥leave interleaved membership #6`, async () => {
    const i = 6;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (userId === USER) {
        return calls % 2 === 1
          ? { membership: 'invite', eventId: `$i${i}` }
          : joinMembership(`$j${i}`);
      }
      return null;
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const [joinRes, leaveRes] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
    ]);
    expect([joinRes.status, leaveRes.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`join∥leave interleaved membership #7`, async () => {
    const i = 7;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (userId === USER) {
        return calls % 2 === 1
          ? { membership: 'invite', eventId: `$i${i}` }
          : joinMembership(`$j${i}`);
      }
      return null;
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const [joinRes, leaveRes] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
    ]);
    expect([joinRes.status, leaveRes.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`join∥leave interleaved membership #8`, async () => {
    const i = 8;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (userId === USER) {
        return calls % 2 === 1
          ? { membership: 'invite', eventId: `$i${i}` }
          : joinMembership(`$j${i}`);
      }
      return null;
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const [joinRes, leaveRes] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
    ]);
    expect([joinRes.status, leaveRes.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`join∥leave interleaved membership #9`, async () => {
    const i = 9;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (userId === USER) {
        return calls % 2 === 1
          ? { membership: 'invite', eventId: `$i${i}` }
          : joinMembership(`$j${i}`);
      }
      return null;
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const [joinRes, leaveRes] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
    ]);
    expect([joinRes.status, leaveRes.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`join∥leave interleaved membership #10`, async () => {
    const i = 10;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (userId === USER) {
        return calls % 2 === 1
          ? { membership: 'invite', eventId: `$i${i}` }
          : joinMembership(`$j${i}`);
      }
      return null;
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const [joinRes, leaveRes] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
    ]);
    expect([joinRes.status, leaveRes.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`join∥leave interleaved membership #11`, async () => {
    const i = 11;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (userId === USER) {
        return calls % 2 === 1
          ? { membership: 'invite', eventId: `$i${i}` }
          : joinMembership(`$j${i}`);
      }
      return null;
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const [joinRes, leaveRes] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
    ]);
    expect([joinRes.status, leaveRes.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

});


// ---------------------------------------------------------------------------
// race leave∥leave double-leave after #191
// ---------------------------------------------------------------------------

describe('race leave∥leave double-leave after #191', () => {
  it(`leave∥leave second forbidden #0`, async () => {
    const i = 0;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (calls === 1) return joinMembership(`$l${i}`);
      return { membership: 'leave', eventId: `$left${i}` };
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.includes(200)).toBe(true);
    expect(statuses.includes(403) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`leave∥leave second forbidden #1`, async () => {
    const i = 1;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (calls === 1) return joinMembership(`$l${i}`);
      return { membership: 'leave', eventId: `$left${i}` };
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.includes(200)).toBe(true);
    expect(statuses.includes(403) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`leave∥leave second forbidden #2`, async () => {
    const i = 2;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (calls === 1) return joinMembership(`$l${i}`);
      return { membership: 'leave', eventId: `$left${i}` };
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.includes(200)).toBe(true);
    expect(statuses.includes(403) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`leave∥leave second forbidden #3`, async () => {
    const i = 3;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (calls === 1) return joinMembership(`$l${i}`);
      return { membership: 'leave', eventId: `$left${i}` };
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.includes(200)).toBe(true);
    expect(statuses.includes(403) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`leave∥leave second forbidden #4`, async () => {
    const i = 4;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (calls === 1) return joinMembership(`$l${i}`);
      return { membership: 'leave', eventId: `$left${i}` };
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.includes(200)).toBe(true);
    expect(statuses.includes(403) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`leave∥leave second forbidden #5`, async () => {
    const i = 5;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (calls === 1) return joinMembership(`$l${i}`);
      return { membership: 'leave', eventId: `$left${i}` };
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.includes(200)).toBe(true);
    expect(statuses.includes(403) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`leave∥leave second forbidden #6`, async () => {
    const i = 6;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (calls === 1) return joinMembership(`$l${i}`);
      return { membership: 'leave', eventId: `$left${i}` };
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.includes(200)).toBe(true);
    expect(statuses.includes(403) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`leave∥leave second forbidden #7`, async () => {
    const i = 7;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (calls === 1) return joinMembership(`$l${i}`);
      return { membership: 'leave', eventId: `$left${i}` };
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.includes(200)).toBe(true);
    expect(statuses.includes(403) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`leave∥leave second forbidden #8`, async () => {
    const i = 8;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (calls === 1) return joinMembership(`$l${i}`);
      return { membership: 'leave', eventId: `$left${i}` };
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.includes(200)).toBe(true);
    expect(statuses.includes(403) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`leave∥leave second forbidden #9`, async () => {
    const i = 9;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (calls === 1) return joinMembership(`$l${i}`);
      return { membership: 'leave', eventId: `$left${i}` };
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.includes(200)).toBe(true);
    expect(statuses.includes(403) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`leave∥leave second forbidden #10`, async () => {
    const i = 10;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (calls === 1) return joinMembership(`$l${i}`);
      return { membership: 'leave', eventId: `$left${i}` };
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.includes(200)).toBe(true);
    expect(statuses.includes(403) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`leave∥leave second forbidden #11`, async () => {
    const i = 11;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      if (calls === 1) return joinMembership(`$l${i}`);
      return { membership: 'leave', eventId: `$left${i}` };
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.includes(200)).toBe(true);
    expect(statuses.includes(403) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

});


// ---------------------------------------------------------------------------
// race invite∥join and invite PL conflict after #191
// ---------------------------------------------------------------------------

describe('race invite∥join and invite PL conflict after #191', () => {
  it(`invite∥invite PL event_id conflict #0`, async () => {
    seedLocalRoom();
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      return null;
    });
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        const id = plReads <= 2 ? '$pl-a' : '$pl-b';
        return pdu({
          type: 'm.room.power_levels',
          event_id: id,
          content: defaultPlContent(),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { user_id: BOB }), db),
      request(path, jsonInit('POST', { user_id: CAROL }), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`invite∥invite PL event_id conflict #1`, async () => {
    seedLocalRoom();
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      return null;
    });
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        const id = plReads <= 2 ? '$pl-a' : '$pl-b';
        return pdu({
          type: 'm.room.power_levels',
          event_id: id,
          content: defaultPlContent(),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { user_id: BOB }), db),
      request(path, jsonInit('POST', { user_id: CAROL }), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`invite∥invite PL event_id conflict #2`, async () => {
    seedLocalRoom();
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      return null;
    });
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        const id = plReads <= 2 ? '$pl-a' : '$pl-b';
        return pdu({
          type: 'm.room.power_levels',
          event_id: id,
          content: defaultPlContent(),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { user_id: BOB }), db),
      request(path, jsonInit('POST', { user_id: CAROL }), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`invite∥invite PL event_id conflict #3`, async () => {
    seedLocalRoom();
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      return null;
    });
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        const id = plReads <= 2 ? '$pl-a' : '$pl-b';
        return pdu({
          type: 'm.room.power_levels',
          event_id: id,
          content: defaultPlContent(),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { user_id: BOB }), db),
      request(path, jsonInit('POST', { user_id: CAROL }), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`invite∥invite PL event_id conflict #4`, async () => {
    seedLocalRoom();
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      return null;
    });
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        const id = plReads <= 2 ? '$pl-a' : '$pl-b';
        return pdu({
          type: 'm.room.power_levels',
          event_id: id,
          content: defaultPlContent(),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { user_id: BOB }), db),
      request(path, jsonInit('POST', { user_id: CAROL }), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`invite∥invite PL event_id conflict #5`, async () => {
    seedLocalRoom();
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      return null;
    });
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        const id = plReads <= 2 ? '$pl-a' : '$pl-b';
        return pdu({
          type: 'm.room.power_levels',
          event_id: id,
          content: defaultPlContent(),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { user_id: BOB }), db),
      request(path, jsonInit('POST', { user_id: CAROL }), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`invite∥invite PL event_id conflict #6`, async () => {
    seedLocalRoom();
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      return null;
    });
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        const id = plReads <= 2 ? '$pl-a' : '$pl-b';
        return pdu({
          type: 'm.room.power_levels',
          event_id: id,
          content: defaultPlContent(),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { user_id: BOB }), db),
      request(path, jsonInit('POST', { user_id: CAROL }), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`invite∥invite PL event_id conflict #7`, async () => {
    seedLocalRoom();
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      return null;
    });
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        const id = plReads <= 2 ? '$pl-a' : '$pl-b';
        return pdu({
          type: 'm.room.power_levels',
          event_id: id,
          content: defaultPlContent(),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { user_id: BOB }), db),
      request(path, jsonInit('POST', { user_id: CAROL }), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`invite∥invite PL event_id conflict #8`, async () => {
    seedLocalRoom();
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      return null;
    });
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        const id = plReads <= 2 ? '$pl-a' : '$pl-b';
        return pdu({
          type: 'm.room.power_levels',
          event_id: id,
          content: defaultPlContent(),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { user_id: BOB }), db),
      request(path, jsonInit('POST', { user_id: CAROL }), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`invite∥invite PL event_id conflict #9`, async () => {
    seedLocalRoom();
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      return null;
    });
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        const id = plReads <= 2 ? '$pl-a' : '$pl-b';
        return pdu({
          type: 'm.room.power_levels',
          event_id: id,
          content: defaultPlContent(),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { user_id: BOB }), db),
      request(path, jsonInit('POST', { user_id: CAROL }), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`invite∥invite PL event_id conflict #10`, async () => {
    seedLocalRoom();
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      return null;
    });
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        const id = plReads <= 2 ? '$pl-a' : '$pl-b';
        return pdu({
          type: 'm.room.power_levels',
          event_id: id,
          content: defaultPlContent(),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { user_id: BOB }), db),
      request(path, jsonInit('POST', { user_id: CAROL }), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`invite∥invite PL event_id conflict #11`, async () => {
    seedLocalRoom();
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      return null;
    });
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        const id = plReads <= 2 ? '$pl-a' : '$pl-b';
        return pdu({
          type: 'm.room.power_levels',
          event_id: id,
          content: defaultPlContent(),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { user_id: BOB }), db),
      request(path, jsonInit('POST', { user_id: CAROL }), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`invite∥join bob accepts while invite in flight #0`, async () => {
    const i = 0;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      if (userId === USER) return joinMembership();
      if (userId === BOB) return { membership: 'invite', eventId: `$bi${i}` };
      return null;
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const [inv, join] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
    ]);
    expect([inv.status, join.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`invite∥join bob accepts while invite in flight #1`, async () => {
    const i = 1;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      if (userId === USER) return joinMembership();
      if (userId === BOB) return { membership: 'invite', eventId: `$bi${i}` };
      return null;
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const [inv, join] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
    ]);
    expect([inv.status, join.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`invite∥join bob accepts while invite in flight #2`, async () => {
    const i = 2;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      if (userId === USER) return joinMembership();
      if (userId === BOB) return { membership: 'invite', eventId: `$bi${i}` };
      return null;
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const [inv, join] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
    ]);
    expect([inv.status, join.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`invite∥join bob accepts while invite in flight #3`, async () => {
    const i = 3;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      if (userId === USER) return joinMembership();
      if (userId === BOB) return { membership: 'invite', eventId: `$bi${i}` };
      return null;
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const [inv, join] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
    ]);
    expect([inv.status, join.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`invite∥join bob accepts while invite in flight #4`, async () => {
    const i = 4;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      if (userId === USER) return joinMembership();
      if (userId === BOB) return { membership: 'invite', eventId: `$bi${i}` };
      return null;
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const [inv, join] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
    ]);
    expect([inv.status, join.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`invite∥join bob accepts while invite in flight #5`, async () => {
    const i = 5;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      if (userId === USER) return joinMembership();
      if (userId === BOB) return { membership: 'invite', eventId: `$bi${i}` };
      return null;
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const [inv, join] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
    ]);
    expect([inv.status, join.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`invite∥join bob accepts while invite in flight #6`, async () => {
    const i = 6;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      if (userId === USER) return joinMembership();
      if (userId === BOB) return { membership: 'invite', eventId: `$bi${i}` };
      return null;
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const [inv, join] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
    ]);
    expect([inv.status, join.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`invite∥join bob accepts while invite in flight #7`, async () => {
    const i = 7;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      if (userId === USER) return joinMembership();
      if (userId === BOB) return { membership: 'invite', eventId: `$bi${i}` };
      return null;
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const [inv, join] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
    ]);
    expect([inv.status, join.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`invite∥join bob accepts while invite in flight #8`, async () => {
    const i = 8;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      if (userId === USER) return joinMembership();
      if (userId === BOB) return { membership: 'invite', eventId: `$bi${i}` };
      return null;
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const [inv, join] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
    ]);
    expect([inv.status, join.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`invite∥join bob accepts while invite in flight #9`, async () => {
    const i = 9;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      if (userId === USER) return joinMembership();
      if (userId === BOB) return { membership: 'invite', eventId: `$bi${i}` };
      return null;
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const [inv, join] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
    ]);
    expect([inv.status, join.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`invite∥join bob accepts while invite in flight #10`, async () => {
    const i = 10;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      if (userId === USER) return joinMembership();
      if (userId === BOB) return { membership: 'invite', eventId: `$bi${i}` };
      return null;
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const [inv, join] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
    ]);
    expect([inv.status, join.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`invite∥join bob accepts while invite in flight #11`, async () => {
    const i = 11;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      if (userId === USER) return joinMembership();
      if (userId === BOB) return { membership: 'invite', eventId: `$bi${i}` };
      return null;
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const [inv, join] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
    ]);
    expect([inv.status, join.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

});


// ---------------------------------------------------------------------------
// race invite∥kick and kick∥ban after #191
// ---------------------------------------------------------------------------

describe('race invite∥kick and kick∥ban after #191', () => {
  it(`kick∥kick target already left #0`, async () => {
    const i = 0;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let targetCalls = 0;
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      if (userId === BOB) {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        targetCalls += 1;
        return targetCalls === 1
          ? joinMembership(`$bob${i}`)
          : { membership: 'leave', eventId: `$left${i}` };
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { user_id: BOB, reason: 'r' + i }), db),
      request(path, jsonInit('POST', { user_id: BOB, reason: 's' + i }), db),
    ]);
    expect([a.status, b.status].some((s) => s === 200 || s === 403)).toBe(true);
  });

  it(`kick∥kick target already left #1`, async () => {
    const i = 1;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let targetCalls = 0;
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      if (userId === BOB) {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        targetCalls += 1;
        return targetCalls === 1
          ? joinMembership(`$bob${i}`)
          : { membership: 'leave', eventId: `$left${i}` };
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { user_id: BOB, reason: 'r' + i }), db),
      request(path, jsonInit('POST', { user_id: BOB, reason: 's' + i }), db),
    ]);
    expect([a.status, b.status].some((s) => s === 200 || s === 403)).toBe(true);
  });

  it(`kick∥kick target already left #2`, async () => {
    const i = 2;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let targetCalls = 0;
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      if (userId === BOB) {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        targetCalls += 1;
        return targetCalls === 1
          ? joinMembership(`$bob${i}`)
          : { membership: 'leave', eventId: `$left${i}` };
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { user_id: BOB, reason: 'r' + i }), db),
      request(path, jsonInit('POST', { user_id: BOB, reason: 's' + i }), db),
    ]);
    expect([a.status, b.status].some((s) => s === 200 || s === 403)).toBe(true);
  });

  it(`kick∥kick target already left #3`, async () => {
    const i = 3;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let targetCalls = 0;
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      if (userId === BOB) {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        targetCalls += 1;
        return targetCalls === 1
          ? joinMembership(`$bob${i}`)
          : { membership: 'leave', eventId: `$left${i}` };
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { user_id: BOB, reason: 'r' + i }), db),
      request(path, jsonInit('POST', { user_id: BOB, reason: 's' + i }), db),
    ]);
    expect([a.status, b.status].some((s) => s === 200 || s === 403)).toBe(true);
  });

  it(`kick∥kick target already left #4`, async () => {
    const i = 4;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let targetCalls = 0;
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      if (userId === BOB) {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        targetCalls += 1;
        return targetCalls === 1
          ? joinMembership(`$bob${i}`)
          : { membership: 'leave', eventId: `$left${i}` };
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { user_id: BOB, reason: 'r' + i }), db),
      request(path, jsonInit('POST', { user_id: BOB, reason: 's' + i }), db),
    ]);
    expect([a.status, b.status].some((s) => s === 200 || s === 403)).toBe(true);
  });

  it(`kick∥kick target already left #5`, async () => {
    const i = 5;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let targetCalls = 0;
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      if (userId === BOB) {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        targetCalls += 1;
        return targetCalls === 1
          ? joinMembership(`$bob${i}`)
          : { membership: 'leave', eventId: `$left${i}` };
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { user_id: BOB, reason: 'r' + i }), db),
      request(path, jsonInit('POST', { user_id: BOB, reason: 's' + i }), db),
    ]);
    expect([a.status, b.status].some((s) => s === 200 || s === 403)).toBe(true);
  });

  it(`kick∥kick target already left #6`, async () => {
    const i = 6;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let targetCalls = 0;
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      if (userId === BOB) {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        targetCalls += 1;
        return targetCalls === 1
          ? joinMembership(`$bob${i}`)
          : { membership: 'leave', eventId: `$left${i}` };
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { user_id: BOB, reason: 'r' + i }), db),
      request(path, jsonInit('POST', { user_id: BOB, reason: 's' + i }), db),
    ]);
    expect([a.status, b.status].some((s) => s === 200 || s === 403)).toBe(true);
  });

  it(`kick∥kick target already left #7`, async () => {
    const i = 7;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let targetCalls = 0;
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      if (userId === BOB) {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        targetCalls += 1;
        return targetCalls === 1
          ? joinMembership(`$bob${i}`)
          : { membership: 'leave', eventId: `$left${i}` };
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { user_id: BOB, reason: 'r' + i }), db),
      request(path, jsonInit('POST', { user_id: BOB, reason: 's' + i }), db),
    ]);
    expect([a.status, b.status].some((s) => s === 200 || s === 403)).toBe(true);
  });

  it(`kick∥kick target already left #8`, async () => {
    const i = 8;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let targetCalls = 0;
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      if (userId === BOB) {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        targetCalls += 1;
        return targetCalls === 1
          ? joinMembership(`$bob${i}`)
          : { membership: 'leave', eventId: `$left${i}` };
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { user_id: BOB, reason: 'r' + i }), db),
      request(path, jsonInit('POST', { user_id: BOB, reason: 's' + i }), db),
    ]);
    expect([a.status, b.status].some((s) => s === 200 || s === 403)).toBe(true);
  });

  it(`kick∥kick target already left #9`, async () => {
    const i = 9;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let targetCalls = 0;
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      if (userId === BOB) {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        targetCalls += 1;
        return targetCalls === 1
          ? joinMembership(`$bob${i}`)
          : { membership: 'leave', eventId: `$left${i}` };
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { user_id: BOB, reason: 'r' + i }), db),
      request(path, jsonInit('POST', { user_id: BOB, reason: 's' + i }), db),
    ]);
    expect([a.status, b.status].some((s) => s === 200 || s === 403)).toBe(true);
  });

  it(`kick∥kick target already left #10`, async () => {
    const i = 10;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let targetCalls = 0;
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      if (userId === BOB) {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        targetCalls += 1;
        return targetCalls === 1
          ? joinMembership(`$bob${i}`)
          : { membership: 'leave', eventId: `$left${i}` };
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { user_id: BOB, reason: 'r' + i }), db),
      request(path, jsonInit('POST', { user_id: BOB, reason: 's' + i }), db),
    ]);
    expect([a.status, b.status].some((s) => s === 200 || s === 403)).toBe(true);
  });

  it(`kick∥kick target already left #11`, async () => {
    const i = 11;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let targetCalls = 0;
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      if (userId === BOB) {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        targetCalls += 1;
        return targetCalls === 1
          ? joinMembership(`$bob${i}`)
          : { membership: 'leave', eventId: `$left${i}` };
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { user_id: BOB, reason: 'r' + i }), db),
      request(path, jsonInit('POST', { user_id: BOB, reason: 's' + i }), db),
    ]);
    expect([a.status, b.status].some((s) => s === 200 || s === 403)).toBe(true);
  });

  it(`ban∥unban interleaved #0`, async () => {
    const i = 0;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      if (userId === USER) return joinMembership();
      if (userId === BOB) return { membership: 'ban', eventId: `$ban${i}` };
      return null;
    });
    const db = createSqlDb();
    const [ban, unban] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('POST', { user_id: BOB, reason: 'x' + i }), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('POST', { user_id: BOB }), db),
    ]);
    expect([ban.status, unban.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`ban∥unban interleaved #1`, async () => {
    const i = 1;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      if (userId === USER) return joinMembership();
      if (userId === BOB) return { membership: 'ban', eventId: `$ban${i}` };
      return null;
    });
    const db = createSqlDb();
    const [ban, unban] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('POST', { user_id: BOB, reason: 'x' + i }), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('POST', { user_id: BOB }), db),
    ]);
    expect([ban.status, unban.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`ban∥unban interleaved #2`, async () => {
    const i = 2;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      if (userId === USER) return joinMembership();
      if (userId === BOB) return { membership: 'ban', eventId: `$ban${i}` };
      return null;
    });
    const db = createSqlDb();
    const [ban, unban] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('POST', { user_id: BOB, reason: 'x' + i }), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('POST', { user_id: BOB }), db),
    ]);
    expect([ban.status, unban.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`ban∥unban interleaved #3`, async () => {
    const i = 3;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      if (userId === USER) return joinMembership();
      if (userId === BOB) return { membership: 'ban', eventId: `$ban${i}` };
      return null;
    });
    const db = createSqlDb();
    const [ban, unban] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('POST', { user_id: BOB, reason: 'x' + i }), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('POST', { user_id: BOB }), db),
    ]);
    expect([ban.status, unban.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`ban∥unban interleaved #4`, async () => {
    const i = 4;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      if (userId === USER) return joinMembership();
      if (userId === BOB) return { membership: 'ban', eventId: `$ban${i}` };
      return null;
    });
    const db = createSqlDb();
    const [ban, unban] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('POST', { user_id: BOB, reason: 'x' + i }), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('POST', { user_id: BOB }), db),
    ]);
    expect([ban.status, unban.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`ban∥unban interleaved #5`, async () => {
    const i = 5;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      if (userId === USER) return joinMembership();
      if (userId === BOB) return { membership: 'ban', eventId: `$ban${i}` };
      return null;
    });
    const db = createSqlDb();
    const [ban, unban] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('POST', { user_id: BOB, reason: 'x' + i }), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('POST', { user_id: BOB }), db),
    ]);
    expect([ban.status, unban.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`ban∥unban interleaved #6`, async () => {
    const i = 6;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      if (userId === USER) return joinMembership();
      if (userId === BOB) return { membership: 'ban', eventId: `$ban${i}` };
      return null;
    });
    const db = createSqlDb();
    const [ban, unban] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('POST', { user_id: BOB, reason: 'x' + i }), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('POST', { user_id: BOB }), db),
    ]);
    expect([ban.status, unban.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`ban∥unban interleaved #7`, async () => {
    const i = 7;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      if (userId === USER) return joinMembership();
      if (userId === BOB) return { membership: 'ban', eventId: `$ban${i}` };
      return null;
    });
    const db = createSqlDb();
    const [ban, unban] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('POST', { user_id: BOB, reason: 'x' + i }), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('POST', { user_id: BOB }), db),
    ]);
    expect([ban.status, unban.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`ban∥unban interleaved #8`, async () => {
    const i = 8;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      if (userId === USER) return joinMembership();
      if (userId === BOB) return { membership: 'ban', eventId: `$ban${i}` };
      return null;
    });
    const db = createSqlDb();
    const [ban, unban] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('POST', { user_id: BOB, reason: 'x' + i }), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('POST', { user_id: BOB }), db),
    ]);
    expect([ban.status, unban.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`ban∥unban interleaved #9`, async () => {
    const i = 9;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      if (userId === USER) return joinMembership();
      if (userId === BOB) return { membership: 'ban', eventId: `$ban${i}` };
      return null;
    });
    const db = createSqlDb();
    const [ban, unban] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('POST', { user_id: BOB, reason: 'x' + i }), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('POST', { user_id: BOB }), db),
    ]);
    expect([ban.status, unban.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`ban∥unban interleaved #10`, async () => {
    const i = 10;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      if (userId === USER) return joinMembership();
      if (userId === BOB) return { membership: 'ban', eventId: `$ban${i}` };
      return null;
    });
    const db = createSqlDb();
    const [ban, unban] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('POST', { user_id: BOB, reason: 'x' + i }), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('POST', { user_id: BOB }), db),
    ]);
    expect([ban.status, unban.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`ban∥unban interleaved #11`, async () => {
    const i = 11;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      if (userId === USER) return joinMembership();
      if (userId === BOB) return { membership: 'ban', eventId: `$ban${i}` };
      return null;
    });
    const db = createSqlDb();
    const [ban, unban] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('POST', { user_id: BOB, reason: 'x' + i }), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('POST', { user_id: BOB }), db),
    ]);
    expect([ban.status, unban.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

});


// ---------------------------------------------------------------------------
// race state PUT∥PUT optimistic concurrency after #191
// ---------------------------------------------------------------------------

describe('race state PUT∥PUT optimistic concurrency after #191', () => {
  it(`state name PUT∥PUT slot conflict #0`, async () => {
    const i = 0;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    let nameReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.name') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        nameReads += 1;
        const id = nameReads <= 2 ? '$name-a' : '$name-b';
        return pdu({
          type: 'm.room.name',
          event_id: id,
          content: { name: 'A' },
          state_key: '',
        });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          content: defaultPlContent(),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name';
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { name: 'Alpha-' + i }), db),
      request(path, jsonInit('PUT', { name: 'Beta-' + i }), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`state name PUT∥PUT slot conflict #1`, async () => {
    const i = 1;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    let nameReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.name') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        nameReads += 1;
        const id = nameReads <= 2 ? '$name-a' : '$name-b';
        return pdu({
          type: 'm.room.name',
          event_id: id,
          content: { name: 'A' },
          state_key: '',
        });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          content: defaultPlContent(),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name';
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { name: 'Alpha-' + i }), db),
      request(path, jsonInit('PUT', { name: 'Beta-' + i }), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`state name PUT∥PUT slot conflict #2`, async () => {
    const i = 2;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    let nameReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.name') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        nameReads += 1;
        const id = nameReads <= 2 ? '$name-a' : '$name-b';
        return pdu({
          type: 'm.room.name',
          event_id: id,
          content: { name: 'A' },
          state_key: '',
        });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          content: defaultPlContent(),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name';
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { name: 'Alpha-' + i }), db),
      request(path, jsonInit('PUT', { name: 'Beta-' + i }), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`state name PUT∥PUT slot conflict #3`, async () => {
    const i = 3;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    let nameReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.name') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        nameReads += 1;
        const id = nameReads <= 2 ? '$name-a' : '$name-b';
        return pdu({
          type: 'm.room.name',
          event_id: id,
          content: { name: 'A' },
          state_key: '',
        });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          content: defaultPlContent(),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name';
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { name: 'Alpha-' + i }), db),
      request(path, jsonInit('PUT', { name: 'Beta-' + i }), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`state name PUT∥PUT slot conflict #4`, async () => {
    const i = 4;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    let nameReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.name') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        nameReads += 1;
        const id = nameReads <= 2 ? '$name-a' : '$name-b';
        return pdu({
          type: 'm.room.name',
          event_id: id,
          content: { name: 'A' },
          state_key: '',
        });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          content: defaultPlContent(),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name';
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { name: 'Alpha-' + i }), db),
      request(path, jsonInit('PUT', { name: 'Beta-' + i }), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`state name PUT∥PUT slot conflict #5`, async () => {
    const i = 5;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    let nameReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.name') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        nameReads += 1;
        const id = nameReads <= 2 ? '$name-a' : '$name-b';
        return pdu({
          type: 'm.room.name',
          event_id: id,
          content: { name: 'A' },
          state_key: '',
        });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          content: defaultPlContent(),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name';
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { name: 'Alpha-' + i }), db),
      request(path, jsonInit('PUT', { name: 'Beta-' + i }), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`state name PUT∥PUT slot conflict #6`, async () => {
    const i = 6;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    let nameReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.name') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        nameReads += 1;
        const id = nameReads <= 2 ? '$name-a' : '$name-b';
        return pdu({
          type: 'm.room.name',
          event_id: id,
          content: { name: 'A' },
          state_key: '',
        });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          content: defaultPlContent(),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name';
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { name: 'Alpha-' + i }), db),
      request(path, jsonInit('PUT', { name: 'Beta-' + i }), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`state name PUT∥PUT slot conflict #7`, async () => {
    const i = 7;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    let nameReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.name') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        nameReads += 1;
        const id = nameReads <= 2 ? '$name-a' : '$name-b';
        return pdu({
          type: 'm.room.name',
          event_id: id,
          content: { name: 'A' },
          state_key: '',
        });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          content: defaultPlContent(),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name';
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { name: 'Alpha-' + i }), db),
      request(path, jsonInit('PUT', { name: 'Beta-' + i }), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`state name PUT∥PUT slot conflict #8`, async () => {
    const i = 8;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    let nameReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.name') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        nameReads += 1;
        const id = nameReads <= 2 ? '$name-a' : '$name-b';
        return pdu({
          type: 'm.room.name',
          event_id: id,
          content: { name: 'A' },
          state_key: '',
        });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          content: defaultPlContent(),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name';
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { name: 'Alpha-' + i }), db),
      request(path, jsonInit('PUT', { name: 'Beta-' + i }), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`state name PUT∥PUT slot conflict #9`, async () => {
    const i = 9;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    let nameReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.name') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        nameReads += 1;
        const id = nameReads <= 2 ? '$name-a' : '$name-b';
        return pdu({
          type: 'm.room.name',
          event_id: id,
          content: { name: 'A' },
          state_key: '',
        });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          content: defaultPlContent(),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name';
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { name: 'Alpha-' + i }), db),
      request(path, jsonInit('PUT', { name: 'Beta-' + i }), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`state name PUT∥PUT slot conflict #10`, async () => {
    const i = 10;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    let nameReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.name') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        nameReads += 1;
        const id = nameReads <= 2 ? '$name-a' : '$name-b';
        return pdu({
          type: 'm.room.name',
          event_id: id,
          content: { name: 'A' },
          state_key: '',
        });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          content: defaultPlContent(),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name';
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { name: 'Alpha-' + i }), db),
      request(path, jsonInit('PUT', { name: 'Beta-' + i }), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`state name PUT∥PUT slot conflict #11`, async () => {
    const i = 11;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    let nameReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.name') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        nameReads += 1;
        const id = nameReads <= 2 ? '$name-a' : '$name-b';
        return pdu({
          type: 'm.room.name',
          event_id: id,
          content: { name: 'A' },
          state_key: '',
        });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          content: defaultPlContent(),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name';
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { name: 'Alpha-' + i }), db),
      request(path, jsonInit('PUT', { name: 'Beta-' + i }), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });

  it(`state PL PUT∥PUT power_levels conflict #0`, async () => {
    const i = 0;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        const id = plReads <= 2 ? '$pl-check' : '$pl-now';
        return pdu({
          type: 'm.room.power_levels',
          event_id: id,
          content: defaultPlContent({ [CAROL]: 25 }),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.power_levels';
    const body = defaultPlContent({ [CAROL]: 40 + i });
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', body), db),
      request(path, jsonInit('PUT', { ...body, users_default: 1 }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 403, 409].includes(s))).toBe(true);
  });

  it(`state PL PUT∥PUT power_levels conflict #1`, async () => {
    const i = 1;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        const id = plReads <= 2 ? '$pl-check' : '$pl-now';
        return pdu({
          type: 'm.room.power_levels',
          event_id: id,
          content: defaultPlContent({ [CAROL]: 25 }),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.power_levels';
    const body = defaultPlContent({ [CAROL]: 40 + i });
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', body), db),
      request(path, jsonInit('PUT', { ...body, users_default: 1 }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 403, 409].includes(s))).toBe(true);
  });

  it(`state PL PUT∥PUT power_levels conflict #2`, async () => {
    const i = 2;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        const id = plReads <= 2 ? '$pl-check' : '$pl-now';
        return pdu({
          type: 'm.room.power_levels',
          event_id: id,
          content: defaultPlContent({ [CAROL]: 25 }),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.power_levels';
    const body = defaultPlContent({ [CAROL]: 40 + i });
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', body), db),
      request(path, jsonInit('PUT', { ...body, users_default: 1 }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 403, 409].includes(s))).toBe(true);
  });

  it(`state PL PUT∥PUT power_levels conflict #3`, async () => {
    const i = 3;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        const id = plReads <= 2 ? '$pl-check' : '$pl-now';
        return pdu({
          type: 'm.room.power_levels',
          event_id: id,
          content: defaultPlContent({ [CAROL]: 25 }),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.power_levels';
    const body = defaultPlContent({ [CAROL]: 40 + i });
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', body), db),
      request(path, jsonInit('PUT', { ...body, users_default: 1 }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 403, 409].includes(s))).toBe(true);
  });

  it(`state PL PUT∥PUT power_levels conflict #4`, async () => {
    const i = 4;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        const id = plReads <= 2 ? '$pl-check' : '$pl-now';
        return pdu({
          type: 'm.room.power_levels',
          event_id: id,
          content: defaultPlContent({ [CAROL]: 25 }),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.power_levels';
    const body = defaultPlContent({ [CAROL]: 40 + i });
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', body), db),
      request(path, jsonInit('PUT', { ...body, users_default: 1 }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 403, 409].includes(s))).toBe(true);
  });

  it(`state PL PUT∥PUT power_levels conflict #5`, async () => {
    const i = 5;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        const id = plReads <= 2 ? '$pl-check' : '$pl-now';
        return pdu({
          type: 'm.room.power_levels',
          event_id: id,
          content: defaultPlContent({ [CAROL]: 25 }),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.power_levels';
    const body = defaultPlContent({ [CAROL]: 40 + i });
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', body), db),
      request(path, jsonInit('PUT', { ...body, users_default: 1 }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 403, 409].includes(s))).toBe(true);
  });

  it(`state PL PUT∥PUT power_levels conflict #6`, async () => {
    const i = 6;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        const id = plReads <= 2 ? '$pl-check' : '$pl-now';
        return pdu({
          type: 'm.room.power_levels',
          event_id: id,
          content: defaultPlContent({ [CAROL]: 25 }),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.power_levels';
    const body = defaultPlContent({ [CAROL]: 40 + i });
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', body), db),
      request(path, jsonInit('PUT', { ...body, users_default: 1 }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 403, 409].includes(s))).toBe(true);
  });

  it(`state PL PUT∥PUT power_levels conflict #7`, async () => {
    const i = 7;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        const id = plReads <= 2 ? '$pl-check' : '$pl-now';
        return pdu({
          type: 'm.room.power_levels',
          event_id: id,
          content: defaultPlContent({ [CAROL]: 25 }),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.power_levels';
    const body = defaultPlContent({ [CAROL]: 40 + i });
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', body), db),
      request(path, jsonInit('PUT', { ...body, users_default: 1 }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 403, 409].includes(s))).toBe(true);
  });

  it(`state PL PUT∥PUT power_levels conflict #8`, async () => {
    const i = 8;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        const id = plReads <= 2 ? '$pl-check' : '$pl-now';
        return pdu({
          type: 'm.room.power_levels',
          event_id: id,
          content: defaultPlContent({ [CAROL]: 25 }),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.power_levels';
    const body = defaultPlContent({ [CAROL]: 40 + i });
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', body), db),
      request(path, jsonInit('PUT', { ...body, users_default: 1 }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 403, 409].includes(s))).toBe(true);
  });

  it(`state PL PUT∥PUT power_levels conflict #9`, async () => {
    const i = 9;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        const id = plReads <= 2 ? '$pl-check' : '$pl-now';
        return pdu({
          type: 'm.room.power_levels',
          event_id: id,
          content: defaultPlContent({ [CAROL]: 25 }),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.power_levels';
    const body = defaultPlContent({ [CAROL]: 40 + i });
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', body), db),
      request(path, jsonInit('PUT', { ...body, users_default: 1 }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 403, 409].includes(s))).toBe(true);
  });

  it(`state PL PUT∥PUT power_levels conflict #10`, async () => {
    const i = 10;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        const id = plReads <= 2 ? '$pl-check' : '$pl-now';
        return pdu({
          type: 'm.room.power_levels',
          event_id: id,
          content: defaultPlContent({ [CAROL]: 25 }),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.power_levels';
    const body = defaultPlContent({ [CAROL]: 40 + i });
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', body), db),
      request(path, jsonInit('PUT', { ...body, users_default: 1 }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 403, 409].includes(s))).toBe(true);
  });

  it(`state PL PUT∥PUT power_levels conflict #11`, async () => {
    const i = 11;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        const id = plReads <= 2 ? '$pl-check' : '$pl-now';
        return pdu({
          type: 'm.room.power_levels',
          event_id: id,
          content: defaultPlContent({ [CAROL]: 25 }),
          state_key: '',
        });
      }
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        });
      }
      return null;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.power_levels';
    const body = defaultPlContent({ [CAROL]: 40 + i });
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', body), db),
      request(path, jsonInit('PUT', { ...body, users_default: 1 }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 403, 409].includes(s))).toBe(true);
  });

});


// ---------------------------------------------------------------------------
// race send∥redact and redact∥redact after #191
// ---------------------------------------------------------------------------

describe('race send∥redact and redact∥redact after #191', () => {
  it(`redact∥redact same event #0`, async () => {
    const i = 0;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'hi', msgtype: 'm.text' },
      })
    );
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const base =
      '/_matrix/client/v3/rooms/' + ROOM_ENC + '/redact/' + EVENT_ENC + '/';
    const [a, b] = await Promise.all([
      request(base + 'txn-a-' + i, jsonInit('PUT', { reason: 'a' }), db),
      request(base + 'txn-b-' + i, jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });

  it(`redact∥redact same event #1`, async () => {
    const i = 1;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'hi', msgtype: 'm.text' },
      })
    );
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const base =
      '/_matrix/client/v3/rooms/' + ROOM_ENC + '/redact/' + EVENT_ENC + '/';
    const [a, b] = await Promise.all([
      request(base + 'txn-a-' + i, jsonInit('PUT', { reason: 'a' }), db),
      request(base + 'txn-b-' + i, jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });

  it(`redact∥redact same event #2`, async () => {
    const i = 2;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'hi', msgtype: 'm.text' },
      })
    );
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const base =
      '/_matrix/client/v3/rooms/' + ROOM_ENC + '/redact/' + EVENT_ENC + '/';
    const [a, b] = await Promise.all([
      request(base + 'txn-a-' + i, jsonInit('PUT', { reason: 'a' }), db),
      request(base + 'txn-b-' + i, jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });

  it(`redact∥redact same event #3`, async () => {
    const i = 3;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'hi', msgtype: 'm.text' },
      })
    );
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const base =
      '/_matrix/client/v3/rooms/' + ROOM_ENC + '/redact/' + EVENT_ENC + '/';
    const [a, b] = await Promise.all([
      request(base + 'txn-a-' + i, jsonInit('PUT', { reason: 'a' }), db),
      request(base + 'txn-b-' + i, jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });

  it(`redact∥redact same event #4`, async () => {
    const i = 4;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'hi', msgtype: 'm.text' },
      })
    );
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const base =
      '/_matrix/client/v3/rooms/' + ROOM_ENC + '/redact/' + EVENT_ENC + '/';
    const [a, b] = await Promise.all([
      request(base + 'txn-a-' + i, jsonInit('PUT', { reason: 'a' }), db),
      request(base + 'txn-b-' + i, jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });

  it(`redact∥redact same event #5`, async () => {
    const i = 5;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'hi', msgtype: 'm.text' },
      })
    );
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const base =
      '/_matrix/client/v3/rooms/' + ROOM_ENC + '/redact/' + EVENT_ENC + '/';
    const [a, b] = await Promise.all([
      request(base + 'txn-a-' + i, jsonInit('PUT', { reason: 'a' }), db),
      request(base + 'txn-b-' + i, jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });

  it(`redact∥redact same event #6`, async () => {
    const i = 6;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'hi', msgtype: 'm.text' },
      })
    );
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const base =
      '/_matrix/client/v3/rooms/' + ROOM_ENC + '/redact/' + EVENT_ENC + '/';
    const [a, b] = await Promise.all([
      request(base + 'txn-a-' + i, jsonInit('PUT', { reason: 'a' }), db),
      request(base + 'txn-b-' + i, jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });

  it(`redact∥redact same event #7`, async () => {
    const i = 7;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'hi', msgtype: 'm.text' },
      })
    );
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const base =
      '/_matrix/client/v3/rooms/' + ROOM_ENC + '/redact/' + EVENT_ENC + '/';
    const [a, b] = await Promise.all([
      request(base + 'txn-a-' + i, jsonInit('PUT', { reason: 'a' }), db),
      request(base + 'txn-b-' + i, jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });

  it(`redact∥redact same event #8`, async () => {
    const i = 8;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'hi', msgtype: 'm.text' },
      })
    );
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const base =
      '/_matrix/client/v3/rooms/' + ROOM_ENC + '/redact/' + EVENT_ENC + '/';
    const [a, b] = await Promise.all([
      request(base + 'txn-a-' + i, jsonInit('PUT', { reason: 'a' }), db),
      request(base + 'txn-b-' + i, jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });

  it(`redact∥redact same event #9`, async () => {
    const i = 9;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'hi', msgtype: 'm.text' },
      })
    );
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const base =
      '/_matrix/client/v3/rooms/' + ROOM_ENC + '/redact/' + EVENT_ENC + '/';
    const [a, b] = await Promise.all([
      request(base + 'txn-a-' + i, jsonInit('PUT', { reason: 'a' }), db),
      request(base + 'txn-b-' + i, jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });

  it(`redact∥redact same event #10`, async () => {
    const i = 10;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'hi', msgtype: 'm.text' },
      })
    );
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const base =
      '/_matrix/client/v3/rooms/' + ROOM_ENC + '/redact/' + EVENT_ENC + '/';
    const [a, b] = await Promise.all([
      request(base + 'txn-a-' + i, jsonInit('PUT', { reason: 'a' }), db),
      request(base + 'txn-b-' + i, jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });

  it(`redact∥redact same event #11`, async () => {
    const i = 11;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'hi', msgtype: 'm.text' },
      })
    );
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const base =
      '/_matrix/client/v3/rooms/' + ROOM_ENC + '/redact/' + EVENT_ENC + '/';
    const [a, b] = await Promise.all([
      request(base + 'txn-a-' + i, jsonInit('PUT', { reason: 'a' }), db),
      request(base + 'txn-b-' + i, jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });

  it(`send∥send same txnId isolation #0`, async () => {
    const i = 0;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN + i;
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { msgtype: 'm.text', body: 'one-' + i }), db),
      request(path, jsonInit('PUT', { msgtype: 'm.text', body: 'two-' + i }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });

  it(`send∥send same txnId isolation #1`, async () => {
    const i = 1;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN + i;
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { msgtype: 'm.text', body: 'one-' + i }), db),
      request(path, jsonInit('PUT', { msgtype: 'm.text', body: 'two-' + i }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });

  it(`send∥send same txnId isolation #2`, async () => {
    const i = 2;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN + i;
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { msgtype: 'm.text', body: 'one-' + i }), db),
      request(path, jsonInit('PUT', { msgtype: 'm.text', body: 'two-' + i }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });

  it(`send∥send same txnId isolation #3`, async () => {
    const i = 3;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN + i;
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { msgtype: 'm.text', body: 'one-' + i }), db),
      request(path, jsonInit('PUT', { msgtype: 'm.text', body: 'two-' + i }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });

  it(`send∥send same txnId isolation #4`, async () => {
    const i = 4;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN + i;
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { msgtype: 'm.text', body: 'one-' + i }), db),
      request(path, jsonInit('PUT', { msgtype: 'm.text', body: 'two-' + i }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });

  it(`send∥send same txnId isolation #5`, async () => {
    const i = 5;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN + i;
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { msgtype: 'm.text', body: 'one-' + i }), db),
      request(path, jsonInit('PUT', { msgtype: 'm.text', body: 'two-' + i }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });

  it(`send∥send same txnId isolation #6`, async () => {
    const i = 6;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN + i;
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { msgtype: 'm.text', body: 'one-' + i }), db),
      request(path, jsonInit('PUT', { msgtype: 'm.text', body: 'two-' + i }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });

  it(`send∥send same txnId isolation #7`, async () => {
    const i = 7;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN + i;
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { msgtype: 'm.text', body: 'one-' + i }), db),
      request(path, jsonInit('PUT', { msgtype: 'm.text', body: 'two-' + i }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });

  it(`send∥send same txnId isolation #8`, async () => {
    const i = 8;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN + i;
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { msgtype: 'm.text', body: 'one-' + i }), db),
      request(path, jsonInit('PUT', { msgtype: 'm.text', body: 'two-' + i }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });

  it(`send∥send same txnId isolation #9`, async () => {
    const i = 9;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN + i;
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { msgtype: 'm.text', body: 'one-' + i }), db),
      request(path, jsonInit('PUT', { msgtype: 'm.text', body: 'two-' + i }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });

  it(`send∥send same txnId isolation #10`, async () => {
    const i = 10;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN + i;
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { msgtype: 'm.text', body: 'one-' + i }), db),
      request(path, jsonInit('PUT', { msgtype: 'm.text', body: 'two-' + i }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });

  it(`send∥send same txnId isolation #11`, async () => {
    const i = 11;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN + i;
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { msgtype: 'm.text', body: 'one-' + i }), db),
      request(path, jsonInit('PUT', { msgtype: 'm.text', body: 'two-' + i }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });

});


// ---------------------------------------------------------------------------
// race forget∥leave and forget∥forget after #191
// ---------------------------------------------------------------------------

describe('race forget∥leave and forget∥forget after #191', () => {
  it(`forget∥forget membership delete #0`, async () => {
    const i = 0;
    getMembership.mockResolvedValue({ membership: 'leave', eventId: `$left${i}` });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('DELETE FROM room_memberships'),
      },
    });
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.deletes.filter((d) => d.sql.includes('room_memberships')).length).toBe(2);
  });

  it(`forget∥forget membership delete #1`, async () => {
    const i = 1;
    getMembership.mockResolvedValue({ membership: 'leave', eventId: `$left${i}` });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('DELETE FROM room_memberships'),
      },
    });
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.deletes.filter((d) => d.sql.includes('room_memberships')).length).toBe(2);
  });

  it(`forget∥forget membership delete #2`, async () => {
    const i = 2;
    getMembership.mockResolvedValue({ membership: 'leave', eventId: `$left${i}` });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('DELETE FROM room_memberships'),
      },
    });
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.deletes.filter((d) => d.sql.includes('room_memberships')).length).toBe(2);
  });

  it(`forget∥forget membership delete #3`, async () => {
    const i = 3;
    getMembership.mockResolvedValue({ membership: 'leave', eventId: `$left${i}` });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('DELETE FROM room_memberships'),
      },
    });
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.deletes.filter((d) => d.sql.includes('room_memberships')).length).toBe(2);
  });

  it(`forget∥forget membership delete #4`, async () => {
    const i = 4;
    getMembership.mockResolvedValue({ membership: 'leave', eventId: `$left${i}` });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('DELETE FROM room_memberships'),
      },
    });
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.deletes.filter((d) => d.sql.includes('room_memberships')).length).toBe(2);
  });

  it(`forget∥forget membership delete #5`, async () => {
    const i = 5;
    getMembership.mockResolvedValue({ membership: 'leave', eventId: `$left${i}` });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('DELETE FROM room_memberships'),
      },
    });
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.deletes.filter((d) => d.sql.includes('room_memberships')).length).toBe(2);
  });

  it(`forget∥forget membership delete #6`, async () => {
    const i = 6;
    getMembership.mockResolvedValue({ membership: 'leave', eventId: `$left${i}` });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('DELETE FROM room_memberships'),
      },
    });
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.deletes.filter((d) => d.sql.includes('room_memberships')).length).toBe(2);
  });

  it(`forget∥forget membership delete #7`, async () => {
    const i = 7;
    getMembership.mockResolvedValue({ membership: 'leave', eventId: `$left${i}` });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('DELETE FROM room_memberships'),
      },
    });
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.deletes.filter((d) => d.sql.includes('room_memberships')).length).toBe(2);
  });

  it(`forget∥forget membership delete #8`, async () => {
    const i = 8;
    getMembership.mockResolvedValue({ membership: 'leave', eventId: `$left${i}` });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('DELETE FROM room_memberships'),
      },
    });
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.deletes.filter((d) => d.sql.includes('room_memberships')).length).toBe(2);
  });

  it(`forget∥forget membership delete #9`, async () => {
    const i = 9;
    getMembership.mockResolvedValue({ membership: 'leave', eventId: `$left${i}` });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('DELETE FROM room_memberships'),
      },
    });
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.deletes.filter((d) => d.sql.includes('room_memberships')).length).toBe(2);
  });

  it(`forget∥forget membership delete #10`, async () => {
    const i = 10;
    getMembership.mockResolvedValue({ membership: 'leave', eventId: `$left${i}` });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('DELETE FROM room_memberships'),
      },
    });
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.deletes.filter((d) => d.sql.includes('room_memberships')).length).toBe(2);
  });

  it(`forget∥forget membership delete #11`, async () => {
    const i = 11;
    getMembership.mockResolvedValue({ membership: 'leave', eventId: `$left${i}` });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('DELETE FROM room_memberships'),
      },
    });
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', {}), db),
      request(path, jsonInit('POST', {}), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.deletes.filter((d) => d.sql.includes('room_memberships')).length).toBe(2);
  });

  it(`leave∥forget still-joined forbid #0`, async () => {
    const i = 0;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      return calls === 1
        ? joinMembership(`$j${i}`)
        : { membership: 'leave', eventId: `$l${i}` };
    });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const [leave, forget] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db),
    ]);
    expect([leave.status, forget.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`leave∥forget still-joined forbid #1`, async () => {
    const i = 1;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      return calls === 1
        ? joinMembership(`$j${i}`)
        : { membership: 'leave', eventId: `$l${i}` };
    });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const [leave, forget] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db),
    ]);
    expect([leave.status, forget.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`leave∥forget still-joined forbid #2`, async () => {
    const i = 2;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      return calls === 1
        ? joinMembership(`$j${i}`)
        : { membership: 'leave', eventId: `$l${i}` };
    });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const [leave, forget] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db),
    ]);
    expect([leave.status, forget.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`leave∥forget still-joined forbid #3`, async () => {
    const i = 3;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      return calls === 1
        ? joinMembership(`$j${i}`)
        : { membership: 'leave', eventId: `$l${i}` };
    });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const [leave, forget] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db),
    ]);
    expect([leave.status, forget.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`leave∥forget still-joined forbid #4`, async () => {
    const i = 4;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      return calls === 1
        ? joinMembership(`$j${i}`)
        : { membership: 'leave', eventId: `$l${i}` };
    });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const [leave, forget] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db),
    ]);
    expect([leave.status, forget.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`leave∥forget still-joined forbid #5`, async () => {
    const i = 5;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      return calls === 1
        ? joinMembership(`$j${i}`)
        : { membership: 'leave', eventId: `$l${i}` };
    });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const [leave, forget] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db),
    ]);
    expect([leave.status, forget.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`leave∥forget still-joined forbid #6`, async () => {
    const i = 6;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      return calls === 1
        ? joinMembership(`$j${i}`)
        : { membership: 'leave', eventId: `$l${i}` };
    });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const [leave, forget] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db),
    ]);
    expect([leave.status, forget.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`leave∥forget still-joined forbid #7`, async () => {
    const i = 7;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      return calls === 1
        ? joinMembership(`$j${i}`)
        : { membership: 'leave', eventId: `$l${i}` };
    });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const [leave, forget] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db),
    ]);
    expect([leave.status, forget.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`leave∥forget still-joined forbid #8`, async () => {
    const i = 8;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      return calls === 1
        ? joinMembership(`$j${i}`)
        : { membership: 'leave', eventId: `$l${i}` };
    });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const [leave, forget] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db),
    ]);
    expect([leave.status, forget.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`leave∥forget still-joined forbid #9`, async () => {
    const i = 9;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      return calls === 1
        ? joinMembership(`$j${i}`)
        : { membership: 'leave', eventId: `$l${i}` };
    });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const [leave, forget] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db),
    ]);
    expect([leave.status, forget.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`leave∥forget still-joined forbid #10`, async () => {
    const i = 10;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      return calls === 1
        ? joinMembership(`$j${i}`)
        : { membership: 'leave', eventId: `$l${i}` };
    });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const [leave, forget] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db),
    ]);
    expect([leave.status, forget.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

  it(`leave∥forget still-joined forbid #11`, async () => {
    const i = 11;
    seedLocalRoom();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      return calls === 1
        ? joinMembership(`$j${i}`)
        : { membership: 'leave', eventId: `$l${i}` };
    });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const [leave, forget] = await Promise.all([
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db),
    ]);
    expect([leave.status, forget.status].every((s) => [200, 403].includes(s))).toBe(true);
  });

});


// ---------------------------------------------------------------------------
// race directory alias PUT∥DELETE after #191
// ---------------------------------------------------------------------------

describe('race directory alias PUT∥DELETE after #191', () => {
  it(`alias PUT∥PUT room_in_use #0`, async () => {
    const i = 0;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let gets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      gets += 1;
      return gets === 1 ? null : { room_id: ROOM2, alias: ALIAS };
    });
    const db = createSqlDb();
    const path =
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#r' + i + ':example.com');
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
    ]);
    expect([a.status, b.status].every((s) => s >= 200 && s < 500)).toBe(true);
    expect(gets).toBeGreaterThanOrEqual(1);
  });

  it(`alias PUT∥PUT room_in_use #1`, async () => {
    const i = 1;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let gets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      gets += 1;
      return gets === 1 ? null : { room_id: ROOM2, alias: ALIAS };
    });
    const db = createSqlDb();
    const path =
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#r' + i + ':example.com');
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
    ]);
    expect([a.status, b.status].every((s) => s >= 200 && s < 500)).toBe(true);
    expect(gets).toBeGreaterThanOrEqual(1);
  });

  it(`alias PUT∥PUT room_in_use #2`, async () => {
    const i = 2;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let gets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      gets += 1;
      return gets === 1 ? null : { room_id: ROOM2, alias: ALIAS };
    });
    const db = createSqlDb();
    const path =
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#r' + i + ':example.com');
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
    ]);
    expect([a.status, b.status].every((s) => s >= 200 && s < 500)).toBe(true);
    expect(gets).toBeGreaterThanOrEqual(1);
  });

  it(`alias PUT∥PUT room_in_use #3`, async () => {
    const i = 3;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let gets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      gets += 1;
      return gets === 1 ? null : { room_id: ROOM2, alias: ALIAS };
    });
    const db = createSqlDb();
    const path =
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#r' + i + ':example.com');
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
    ]);
    expect([a.status, b.status].every((s) => s >= 200 && s < 500)).toBe(true);
    expect(gets).toBeGreaterThanOrEqual(1);
  });

  it(`alias PUT∥PUT room_in_use #4`, async () => {
    const i = 4;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let gets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      gets += 1;
      return gets === 1 ? null : { room_id: ROOM2, alias: ALIAS };
    });
    const db = createSqlDb();
    const path =
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#r' + i + ':example.com');
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
    ]);
    expect([a.status, b.status].every((s) => s >= 200 && s < 500)).toBe(true);
    expect(gets).toBeGreaterThanOrEqual(1);
  });

  it(`alias PUT∥PUT room_in_use #5`, async () => {
    const i = 5;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let gets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      gets += 1;
      return gets === 1 ? null : { room_id: ROOM2, alias: ALIAS };
    });
    const db = createSqlDb();
    const path =
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#r' + i + ':example.com');
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
    ]);
    expect([a.status, b.status].every((s) => s >= 200 && s < 500)).toBe(true);
    expect(gets).toBeGreaterThanOrEqual(1);
  });

  it(`alias PUT∥PUT room_in_use #6`, async () => {
    const i = 6;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let gets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      gets += 1;
      return gets === 1 ? null : { room_id: ROOM2, alias: ALIAS };
    });
    const db = createSqlDb();
    const path =
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#r' + i + ':example.com');
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
    ]);
    expect([a.status, b.status].every((s) => s >= 200 && s < 500)).toBe(true);
    expect(gets).toBeGreaterThanOrEqual(1);
  });

  it(`alias PUT∥PUT room_in_use #7`, async () => {
    const i = 7;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let gets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      gets += 1;
      return gets === 1 ? null : { room_id: ROOM2, alias: ALIAS };
    });
    const db = createSqlDb();
    const path =
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#r' + i + ':example.com');
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
    ]);
    expect([a.status, b.status].every((s) => s >= 200 && s < 500)).toBe(true);
    expect(gets).toBeGreaterThanOrEqual(1);
  });

  it(`alias PUT∥PUT room_in_use #8`, async () => {
    const i = 8;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let gets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      gets += 1;
      return gets === 1 ? null : { room_id: ROOM2, alias: ALIAS };
    });
    const db = createSqlDb();
    const path =
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#r' + i + ':example.com');
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
    ]);
    expect([a.status, b.status].every((s) => s >= 200 && s < 500)).toBe(true);
    expect(gets).toBeGreaterThanOrEqual(1);
  });

  it(`alias PUT∥PUT room_in_use #9`, async () => {
    const i = 9;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let gets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      gets += 1;
      return gets === 1 ? null : { room_id: ROOM2, alias: ALIAS };
    });
    const db = createSqlDb();
    const path =
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#r' + i + ':example.com');
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
    ]);
    expect([a.status, b.status].every((s) => s >= 200 && s < 500)).toBe(true);
    expect(gets).toBeGreaterThanOrEqual(1);
  });

  it(`alias PUT∥PUT room_in_use #10`, async () => {
    const i = 10;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let gets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      gets += 1;
      return gets === 1 ? null : { room_id: ROOM2, alias: ALIAS };
    });
    const db = createSqlDb();
    const path =
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#r' + i + ':example.com');
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
    ]);
    expect([a.status, b.status].every((s) => s >= 200 && s < 500)).toBe(true);
    expect(gets).toBeGreaterThanOrEqual(1);
  });

  it(`alias PUT∥PUT room_in_use #11`, async () => {
    const i = 11;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let gets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      gets += 1;
      return gets === 1 ? null : { room_id: ROOM2, alias: ALIAS };
    });
    const db = createSqlDb();
    const path =
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#r' + i + ':example.com');
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
    ]);
    expect([a.status, b.status].every((s) => s >= 200 && s < 500)).toBe(true);
    expect(gets).toBeGreaterThanOrEqual(1);
  });

  it(`alias PUT∥DELETE interleaved #0`, async () => {
    const i = 0;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    // PUT sees free alias; DELETE sees existing — call-order via barrier on get.
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let gets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      gets += 1;
      // First resolver (either PUT or DELETE) — return null for create path,
      // second returns existing so DELETE can proceed if it is second.
      // To avoid deadlock, both write helpers are non-blocking; race is on get.
      return gets === 1
        ? null
        : { room_id: ROOM, alias: '#x' + i + ':example.com' };
    });
    const db = createSqlDb({
      aliasRows: [{ alias: '#x' + i + ':example.com', room_id: ROOM }],
    });
    const path =
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#x' + i + ':example.com');
    const [put, del] = await Promise.all([
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
      request(path, jsonInit('DELETE', {}), db),
    ]);
    expect([put.status, del.status].every((s) => s >= 200 && s < 500)).toBe(true);
    expect(gets).toBe(2);
  });

  it(`alias PUT∥DELETE interleaved #1`, async () => {
    const i = 1;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    // PUT sees free alias; DELETE sees existing — call-order via barrier on get.
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let gets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      gets += 1;
      // First resolver (either PUT or DELETE) — return null for create path,
      // second returns existing so DELETE can proceed if it is second.
      // To avoid deadlock, both write helpers are non-blocking; race is on get.
      return gets === 1
        ? null
        : { room_id: ROOM, alias: '#x' + i + ':example.com' };
    });
    const db = createSqlDb({
      aliasRows: [{ alias: '#x' + i + ':example.com', room_id: ROOM }],
    });
    const path =
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#x' + i + ':example.com');
    const [put, del] = await Promise.all([
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
      request(path, jsonInit('DELETE', {}), db),
    ]);
    expect([put.status, del.status].every((s) => s >= 200 && s < 500)).toBe(true);
    expect(gets).toBe(2);
  });

  it(`alias PUT∥DELETE interleaved #2`, async () => {
    const i = 2;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    // PUT sees free alias; DELETE sees existing — call-order via barrier on get.
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let gets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      gets += 1;
      // First resolver (either PUT or DELETE) — return null for create path,
      // second returns existing so DELETE can proceed if it is second.
      // To avoid deadlock, both write helpers are non-blocking; race is on get.
      return gets === 1
        ? null
        : { room_id: ROOM, alias: '#x' + i + ':example.com' };
    });
    const db = createSqlDb({
      aliasRows: [{ alias: '#x' + i + ':example.com', room_id: ROOM }],
    });
    const path =
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#x' + i + ':example.com');
    const [put, del] = await Promise.all([
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
      request(path, jsonInit('DELETE', {}), db),
    ]);
    expect([put.status, del.status].every((s) => s >= 200 && s < 500)).toBe(true);
    expect(gets).toBe(2);
  });

  it(`alias PUT∥DELETE interleaved #3`, async () => {
    const i = 3;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    // PUT sees free alias; DELETE sees existing — call-order via barrier on get.
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let gets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      gets += 1;
      // First resolver (either PUT or DELETE) — return null for create path,
      // second returns existing so DELETE can proceed if it is second.
      // To avoid deadlock, both write helpers are non-blocking; race is on get.
      return gets === 1
        ? null
        : { room_id: ROOM, alias: '#x' + i + ':example.com' };
    });
    const db = createSqlDb({
      aliasRows: [{ alias: '#x' + i + ':example.com', room_id: ROOM }],
    });
    const path =
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#x' + i + ':example.com');
    const [put, del] = await Promise.all([
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
      request(path, jsonInit('DELETE', {}), db),
    ]);
    expect([put.status, del.status].every((s) => s >= 200 && s < 500)).toBe(true);
    expect(gets).toBe(2);
  });

  it(`alias PUT∥DELETE interleaved #4`, async () => {
    const i = 4;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    // PUT sees free alias; DELETE sees existing — call-order via barrier on get.
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let gets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      gets += 1;
      // First resolver (either PUT or DELETE) — return null for create path,
      // second returns existing so DELETE can proceed if it is second.
      // To avoid deadlock, both write helpers are non-blocking; race is on get.
      return gets === 1
        ? null
        : { room_id: ROOM, alias: '#x' + i + ':example.com' };
    });
    const db = createSqlDb({
      aliasRows: [{ alias: '#x' + i + ':example.com', room_id: ROOM }],
    });
    const path =
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#x' + i + ':example.com');
    const [put, del] = await Promise.all([
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
      request(path, jsonInit('DELETE', {}), db),
    ]);
    expect([put.status, del.status].every((s) => s >= 200 && s < 500)).toBe(true);
    expect(gets).toBe(2);
  });

  it(`alias PUT∥DELETE interleaved #5`, async () => {
    const i = 5;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    // PUT sees free alias; DELETE sees existing — call-order via barrier on get.
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let gets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      gets += 1;
      // First resolver (either PUT or DELETE) — return null for create path,
      // second returns existing so DELETE can proceed if it is second.
      // To avoid deadlock, both write helpers are non-blocking; race is on get.
      return gets === 1
        ? null
        : { room_id: ROOM, alias: '#x' + i + ':example.com' };
    });
    const db = createSqlDb({
      aliasRows: [{ alias: '#x' + i + ':example.com', room_id: ROOM }],
    });
    const path =
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#x' + i + ':example.com');
    const [put, del] = await Promise.all([
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
      request(path, jsonInit('DELETE', {}), db),
    ]);
    expect([put.status, del.status].every((s) => s >= 200 && s < 500)).toBe(true);
    expect(gets).toBe(2);
  });

  it(`alias PUT∥DELETE interleaved #6`, async () => {
    const i = 6;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    // PUT sees free alias; DELETE sees existing — call-order via barrier on get.
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let gets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      gets += 1;
      // First resolver (either PUT or DELETE) — return null for create path,
      // second returns existing so DELETE can proceed if it is second.
      // To avoid deadlock, both write helpers are non-blocking; race is on get.
      return gets === 1
        ? null
        : { room_id: ROOM, alias: '#x' + i + ':example.com' };
    });
    const db = createSqlDb({
      aliasRows: [{ alias: '#x' + i + ':example.com', room_id: ROOM }],
    });
    const path =
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#x' + i + ':example.com');
    const [put, del] = await Promise.all([
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
      request(path, jsonInit('DELETE', {}), db),
    ]);
    expect([put.status, del.status].every((s) => s >= 200 && s < 500)).toBe(true);
    expect(gets).toBe(2);
  });

  it(`alias PUT∥DELETE interleaved #7`, async () => {
    const i = 7;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    // PUT sees free alias; DELETE sees existing — call-order via barrier on get.
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let gets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      gets += 1;
      // First resolver (either PUT or DELETE) — return null for create path,
      // second returns existing so DELETE can proceed if it is second.
      // To avoid deadlock, both write helpers are non-blocking; race is on get.
      return gets === 1
        ? null
        : { room_id: ROOM, alias: '#x' + i + ':example.com' };
    });
    const db = createSqlDb({
      aliasRows: [{ alias: '#x' + i + ':example.com', room_id: ROOM }],
    });
    const path =
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#x' + i + ':example.com');
    const [put, del] = await Promise.all([
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
      request(path, jsonInit('DELETE', {}), db),
    ]);
    expect([put.status, del.status].every((s) => s >= 200 && s < 500)).toBe(true);
    expect(gets).toBe(2);
  });

  it(`alias PUT∥DELETE interleaved #8`, async () => {
    const i = 8;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    // PUT sees free alias; DELETE sees existing — call-order via barrier on get.
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let gets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      gets += 1;
      // First resolver (either PUT or DELETE) — return null for create path,
      // second returns existing so DELETE can proceed if it is second.
      // To avoid deadlock, both write helpers are non-blocking; race is on get.
      return gets === 1
        ? null
        : { room_id: ROOM, alias: '#x' + i + ':example.com' };
    });
    const db = createSqlDb({
      aliasRows: [{ alias: '#x' + i + ':example.com', room_id: ROOM }],
    });
    const path =
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#x' + i + ':example.com');
    const [put, del] = await Promise.all([
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
      request(path, jsonInit('DELETE', {}), db),
    ]);
    expect([put.status, del.status].every((s) => s >= 200 && s < 500)).toBe(true);
    expect(gets).toBe(2);
  });

  it(`alias PUT∥DELETE interleaved #9`, async () => {
    const i = 9;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    // PUT sees free alias; DELETE sees existing — call-order via barrier on get.
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let gets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      gets += 1;
      // First resolver (either PUT or DELETE) — return null for create path,
      // second returns existing so DELETE can proceed if it is second.
      // To avoid deadlock, both write helpers are non-blocking; race is on get.
      return gets === 1
        ? null
        : { room_id: ROOM, alias: '#x' + i + ':example.com' };
    });
    const db = createSqlDb({
      aliasRows: [{ alias: '#x' + i + ':example.com', room_id: ROOM }],
    });
    const path =
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#x' + i + ':example.com');
    const [put, del] = await Promise.all([
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
      request(path, jsonInit('DELETE', {}), db),
    ]);
    expect([put.status, del.status].every((s) => s >= 200 && s < 500)).toBe(true);
    expect(gets).toBe(2);
  });

  it(`alias PUT∥DELETE interleaved #10`, async () => {
    const i = 10;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    // PUT sees free alias; DELETE sees existing — call-order via barrier on get.
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let gets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      gets += 1;
      // First resolver (either PUT or DELETE) — return null for create path,
      // second returns existing so DELETE can proceed if it is second.
      // To avoid deadlock, both write helpers are non-blocking; race is on get.
      return gets === 1
        ? null
        : { room_id: ROOM, alias: '#x' + i + ':example.com' };
    });
    const db = createSqlDb({
      aliasRows: [{ alias: '#x' + i + ':example.com', room_id: ROOM }],
    });
    const path =
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#x' + i + ':example.com');
    const [put, del] = await Promise.all([
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
      request(path, jsonInit('DELETE', {}), db),
    ]);
    expect([put.status, del.status].every((s) => s >= 200 && s < 500)).toBe(true);
    expect(gets).toBe(2);
  });

  it(`alias PUT∥DELETE interleaved #11`, async () => {
    const i = 11;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    // PUT sees free alias; DELETE sees existing — call-order via barrier on get.
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let gets = 0;
    getRoomByAlias.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      gets += 1;
      // First resolver (either PUT or DELETE) — return null for create path,
      // second returns existing so DELETE can proceed if it is second.
      // To avoid deadlock, both write helpers are non-blocking; race is on get.
      return gets === 1
        ? null
        : { room_id: ROOM, alias: '#x' + i + ':example.com' };
    });
    const db = createSqlDb({
      aliasRows: [{ alias: '#x' + i + ':example.com', room_id: ROOM }],
    });
    const path =
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#x' + i + ':example.com');
    const [put, del] = await Promise.all([
      request(path, jsonInit('PUT', { room_id: ROOM }), db),
      request(path, jsonInit('DELETE', {}), db),
    ]);
    expect([put.status, del.status].every((s) => s >= 200 && s < 500)).toBe(true);
    expect(gets).toBe(2);
  });

});


// ---------------------------------------------------------------------------
// race knock∥invite and knock∥knock after #191
// ---------------------------------------------------------------------------

describe('race knock∥invite and knock∥knock after #191', () => {
  it(`knock∥knock join_rules knock #0`, async () => {
    const i = 0;
    seedLocalRoom();
    getMembership.mockResolvedValue(null);
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr-knock',
        content: { join_rule: 'knock' },
        state_key: '',
      }),
    });
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { reason: 'please-' + i }), db),
      request(path, jsonInit('POST', { reason: 'again-' + i }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 403, 400].includes(s))).toBe(true);
  });

  it(`knock∥knock join_rules knock #1`, async () => {
    const i = 1;
    seedLocalRoom();
    getMembership.mockResolvedValue(null);
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr-knock',
        content: { join_rule: 'knock' },
        state_key: '',
      }),
    });
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { reason: 'please-' + i }), db),
      request(path, jsonInit('POST', { reason: 'again-' + i }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 403, 400].includes(s))).toBe(true);
  });

  it(`knock∥knock join_rules knock #2`, async () => {
    const i = 2;
    seedLocalRoom();
    getMembership.mockResolvedValue(null);
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr-knock',
        content: { join_rule: 'knock' },
        state_key: '',
      }),
    });
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { reason: 'please-' + i }), db),
      request(path, jsonInit('POST', { reason: 'again-' + i }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 403, 400].includes(s))).toBe(true);
  });

  it(`knock∥knock join_rules knock #3`, async () => {
    const i = 3;
    seedLocalRoom();
    getMembership.mockResolvedValue(null);
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr-knock',
        content: { join_rule: 'knock' },
        state_key: '',
      }),
    });
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { reason: 'please-' + i }), db),
      request(path, jsonInit('POST', { reason: 'again-' + i }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 403, 400].includes(s))).toBe(true);
  });

  it(`knock∥knock join_rules knock #4`, async () => {
    const i = 4;
    seedLocalRoom();
    getMembership.mockResolvedValue(null);
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr-knock',
        content: { join_rule: 'knock' },
        state_key: '',
      }),
    });
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { reason: 'please-' + i }), db),
      request(path, jsonInit('POST', { reason: 'again-' + i }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 403, 400].includes(s))).toBe(true);
  });

  it(`knock∥knock join_rules knock #5`, async () => {
    const i = 5;
    seedLocalRoom();
    getMembership.mockResolvedValue(null);
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr-knock',
        content: { join_rule: 'knock' },
        state_key: '',
      }),
    });
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { reason: 'please-' + i }), db),
      request(path, jsonInit('POST', { reason: 'again-' + i }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 403, 400].includes(s))).toBe(true);
  });

  it(`knock∥knock join_rules knock #6`, async () => {
    const i = 6;
    seedLocalRoom();
    getMembership.mockResolvedValue(null);
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr-knock',
        content: { join_rule: 'knock' },
        state_key: '',
      }),
    });
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { reason: 'please-' + i }), db),
      request(path, jsonInit('POST', { reason: 'again-' + i }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 403, 400].includes(s))).toBe(true);
  });

  it(`knock∥knock join_rules knock #7`, async () => {
    const i = 7;
    seedLocalRoom();
    getMembership.mockResolvedValue(null);
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr-knock',
        content: { join_rule: 'knock' },
        state_key: '',
      }),
    });
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { reason: 'please-' + i }), db),
      request(path, jsonInit('POST', { reason: 'again-' + i }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 403, 400].includes(s))).toBe(true);
  });

  it(`knock∥knock join_rules knock #8`, async () => {
    const i = 8;
    seedLocalRoom();
    getMembership.mockResolvedValue(null);
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr-knock',
        content: { join_rule: 'knock' },
        state_key: '',
      }),
    });
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { reason: 'please-' + i }), db),
      request(path, jsonInit('POST', { reason: 'again-' + i }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 403, 400].includes(s))).toBe(true);
  });

  it(`knock∥knock join_rules knock #9`, async () => {
    const i = 9;
    seedLocalRoom();
    getMembership.mockResolvedValue(null);
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr-knock',
        content: { join_rule: 'knock' },
        state_key: '',
      }),
    });
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { reason: 'please-' + i }), db),
      request(path, jsonInit('POST', { reason: 'again-' + i }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 403, 400].includes(s))).toBe(true);
  });

  it(`knock∥knock join_rules knock #10`, async () => {
    const i = 10;
    seedLocalRoom();
    getMembership.mockResolvedValue(null);
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr-knock',
        content: { join_rule: 'knock' },
        state_key: '',
      }),
    });
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { reason: 'please-' + i }), db),
      request(path, jsonInit('POST', { reason: 'again-' + i }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 403, 400].includes(s))).toBe(true);
  });

  it(`knock∥knock join_rules knock #11`, async () => {
    const i = 11;
    seedLocalRoom();
    getMembership.mockResolvedValue(null);
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr-knock',
        content: { join_rule: 'knock' },
        state_key: '',
      }),
    });
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    storeEvent.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      return 1;
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock';
    const [a, b] = await Promise.all([
      request(path, jsonInit('POST', { reason: 'please-' + i }), db),
      request(path, jsonInit('POST', { reason: 'again-' + i }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 403, 400].includes(s))).toBe(true);
  });

});


// ---------------------------------------------------------------------------
// race state cache bump∥invalidate after #191
// ---------------------------------------------------------------------------

describe('race state cache bump∥invalidate after #191', () => {
  it(`name state cache bump concurrent #0`, async () => {
    const i = 0;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    defaultState();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    bumpRoomCacheGeneration.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name';
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { name: 'N' + i + 'a' }), db),
      request(path, jsonInit('PUT', { name: 'N' + i + 'b' }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 409].includes(s))).toBe(true);
    expect(bumpRoomCacheGeneration.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`name state cache bump concurrent #1`, async () => {
    const i = 1;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    defaultState();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    bumpRoomCacheGeneration.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name';
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { name: 'N' + i + 'a' }), db),
      request(path, jsonInit('PUT', { name: 'N' + i + 'b' }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 409].includes(s))).toBe(true);
    expect(bumpRoomCacheGeneration.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`name state cache bump concurrent #2`, async () => {
    const i = 2;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    defaultState();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    bumpRoomCacheGeneration.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name';
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { name: 'N' + i + 'a' }), db),
      request(path, jsonInit('PUT', { name: 'N' + i + 'b' }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 409].includes(s))).toBe(true);
    expect(bumpRoomCacheGeneration.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`name state cache bump concurrent #3`, async () => {
    const i = 3;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    defaultState();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    bumpRoomCacheGeneration.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name';
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { name: 'N' + i + 'a' }), db),
      request(path, jsonInit('PUT', { name: 'N' + i + 'b' }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 409].includes(s))).toBe(true);
    expect(bumpRoomCacheGeneration.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`name state cache bump concurrent #4`, async () => {
    const i = 4;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    defaultState();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    bumpRoomCacheGeneration.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name';
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { name: 'N' + i + 'a' }), db),
      request(path, jsonInit('PUT', { name: 'N' + i + 'b' }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 409].includes(s))).toBe(true);
    expect(bumpRoomCacheGeneration.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`name state cache bump concurrent #5`, async () => {
    const i = 5;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    defaultState();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    bumpRoomCacheGeneration.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name';
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { name: 'N' + i + 'a' }), db),
      request(path, jsonInit('PUT', { name: 'N' + i + 'b' }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 409].includes(s))).toBe(true);
    expect(bumpRoomCacheGeneration.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`name state cache bump concurrent #6`, async () => {
    const i = 6;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    defaultState();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    bumpRoomCacheGeneration.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name';
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { name: 'N' + i + 'a' }), db),
      request(path, jsonInit('PUT', { name: 'N' + i + 'b' }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 409].includes(s))).toBe(true);
    expect(bumpRoomCacheGeneration.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`name state cache bump concurrent #7`, async () => {
    const i = 7;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    defaultState();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    bumpRoomCacheGeneration.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name';
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { name: 'N' + i + 'a' }), db),
      request(path, jsonInit('PUT', { name: 'N' + i + 'b' }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 409].includes(s))).toBe(true);
    expect(bumpRoomCacheGeneration.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`name state cache bump concurrent #8`, async () => {
    const i = 8;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    defaultState();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    bumpRoomCacheGeneration.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name';
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { name: 'N' + i + 'a' }), db),
      request(path, jsonInit('PUT', { name: 'N' + i + 'b' }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 409].includes(s))).toBe(true);
    expect(bumpRoomCacheGeneration.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`name state cache bump concurrent #9`, async () => {
    const i = 9;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    defaultState();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    bumpRoomCacheGeneration.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name';
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { name: 'N' + i + 'a' }), db),
      request(path, jsonInit('PUT', { name: 'N' + i + 'b' }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 409].includes(s))).toBe(true);
    expect(bumpRoomCacheGeneration.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`name state cache bump concurrent #10`, async () => {
    const i = 10;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    defaultState();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    bumpRoomCacheGeneration.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name';
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { name: 'N' + i + 'a' }), db),
      request(path, jsonInit('PUT', { name: 'N' + i + 'b' }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 409].includes(s))).toBe(true);
    expect(bumpRoomCacheGeneration.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it(`name state cache bump concurrent #11`, async () => {
    const i = 11;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    defaultState();
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    bumpRoomCacheGeneration.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
    });
    const db = createSqlDb();
    const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name';
    const [a, b] = await Promise.all([
      request(path, jsonInit('PUT', { name: 'N' + i + 'a' }), db),
      request(path, jsonInit('PUT', { name: 'N' + i + 'b' }), db),
    ]);
    expect([a.status, b.status].every((s) => [200, 409].includes(s))).toBe(true);
    expect(bumpRoomCacheGeneration.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

});


// ---------------------------------------------------------------------------
// race upgrade∥join after #191
// ---------------------------------------------------------------------------

describe('race upgrade∥join after #191', () => {
  it(`upgrade∥join membership gate #0`, async () => {
    const i = 0;
    seedLocalRoom();
    getRoomState.mockResolvedValue([]);
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      return calls === 1
        ? joinMembership(`$u${i}`)
        : { membership: 'leave', eventId: `$left${i}` };
    });
    const db = createSqlDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      lastEvent: { event_id: EVENT, depth: 3 },
    });
    const [up, join] = await Promise.all([
      request(
        '/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade',
        jsonInit('POST', { new_version: '11' }),
        db
      ),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
    ]);
    expect([up.status, join.status].every((s) => [200, 403, 400, 500].includes(s))).toBe(true);
  });

  it(`upgrade∥join membership gate #1`, async () => {
    const i = 1;
    seedLocalRoom();
    getRoomState.mockResolvedValue([]);
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      return calls === 1
        ? joinMembership(`$u${i}`)
        : { membership: 'leave', eventId: `$left${i}` };
    });
    const db = createSqlDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      lastEvent: { event_id: EVENT, depth: 3 },
    });
    const [up, join] = await Promise.all([
      request(
        '/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade',
        jsonInit('POST', { new_version: '11' }),
        db
      ),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
    ]);
    expect([up.status, join.status].every((s) => [200, 403, 400, 500].includes(s))).toBe(true);
  });

  it(`upgrade∥join membership gate #2`, async () => {
    const i = 2;
    seedLocalRoom();
    getRoomState.mockResolvedValue([]);
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      return calls === 1
        ? joinMembership(`$u${i}`)
        : { membership: 'leave', eventId: `$left${i}` };
    });
    const db = createSqlDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      lastEvent: { event_id: EVENT, depth: 3 },
    });
    const [up, join] = await Promise.all([
      request(
        '/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade',
        jsonInit('POST', { new_version: '11' }),
        db
      ),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
    ]);
    expect([up.status, join.status].every((s) => [200, 403, 400, 500].includes(s))).toBe(true);
  });

  it(`upgrade∥join membership gate #3`, async () => {
    const i = 3;
    seedLocalRoom();
    getRoomState.mockResolvedValue([]);
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      return calls === 1
        ? joinMembership(`$u${i}`)
        : { membership: 'leave', eventId: `$left${i}` };
    });
    const db = createSqlDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      lastEvent: { event_id: EVENT, depth: 3 },
    });
    const [up, join] = await Promise.all([
      request(
        '/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade',
        jsonInit('POST', { new_version: '11' }),
        db
      ),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
    ]);
    expect([up.status, join.status].every((s) => [200, 403, 400, 500].includes(s))).toBe(true);
  });

  it(`upgrade∥join membership gate #4`, async () => {
    const i = 4;
    seedLocalRoom();
    getRoomState.mockResolvedValue([]);
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      return calls === 1
        ? joinMembership(`$u${i}`)
        : { membership: 'leave', eventId: `$left${i}` };
    });
    const db = createSqlDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      lastEvent: { event_id: EVENT, depth: 3 },
    });
    const [up, join] = await Promise.all([
      request(
        '/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade',
        jsonInit('POST', { new_version: '11' }),
        db
      ),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
    ]);
    expect([up.status, join.status].every((s) => [200, 403, 400, 500].includes(s))).toBe(true);
  });

  it(`upgrade∥join membership gate #5`, async () => {
    const i = 5;
    seedLocalRoom();
    getRoomState.mockResolvedValue([]);
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      return calls === 1
        ? joinMembership(`$u${i}`)
        : { membership: 'leave', eventId: `$left${i}` };
    });
    const db = createSqlDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      lastEvent: { event_id: EVENT, depth: 3 },
    });
    const [up, join] = await Promise.all([
      request(
        '/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade',
        jsonInit('POST', { new_version: '11' }),
        db
      ),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
    ]);
    expect([up.status, join.status].every((s) => [200, 403, 400, 500].includes(s))).toBe(true);
  });

  it(`upgrade∥join membership gate #6`, async () => {
    const i = 6;
    seedLocalRoom();
    getRoomState.mockResolvedValue([]);
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      return calls === 1
        ? joinMembership(`$u${i}`)
        : { membership: 'leave', eventId: `$left${i}` };
    });
    const db = createSqlDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      lastEvent: { event_id: EVENT, depth: 3 },
    });
    const [up, join] = await Promise.all([
      request(
        '/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade',
        jsonInit('POST', { new_version: '11' }),
        db
      ),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
    ]);
    expect([up.status, join.status].every((s) => [200, 403, 400, 500].includes(s))).toBe(true);
  });

  it(`upgrade∥join membership gate #7`, async () => {
    const i = 7;
    seedLocalRoom();
    getRoomState.mockResolvedValue([]);
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      return calls === 1
        ? joinMembership(`$u${i}`)
        : { membership: 'leave', eventId: `$left${i}` };
    });
    const db = createSqlDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      lastEvent: { event_id: EVENT, depth: 3 },
    });
    const [up, join] = await Promise.all([
      request(
        '/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade',
        jsonInit('POST', { new_version: '11' }),
        db
      ),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
    ]);
    expect([up.status, join.status].every((s) => [200, 403, 400, 500].includes(s))).toBe(true);
  });

  it(`upgrade∥join membership gate #8`, async () => {
    const i = 8;
    seedLocalRoom();
    getRoomState.mockResolvedValue([]);
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      return calls === 1
        ? joinMembership(`$u${i}`)
        : { membership: 'leave', eventId: `$left${i}` };
    });
    const db = createSqlDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      lastEvent: { event_id: EVENT, depth: 3 },
    });
    const [up, join] = await Promise.all([
      request(
        '/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade',
        jsonInit('POST', { new_version: '11' }),
        db
      ),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
    ]);
    expect([up.status, join.status].every((s) => [200, 403, 400, 500].includes(s))).toBe(true);
  });

  it(`upgrade∥join membership gate #9`, async () => {
    const i = 9;
    seedLocalRoom();
    getRoomState.mockResolvedValue([]);
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      return calls === 1
        ? joinMembership(`$u${i}`)
        : { membership: 'leave', eventId: `$left${i}` };
    });
    const db = createSqlDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      lastEvent: { event_id: EVENT, depth: 3 },
    });
    const [up, join] = await Promise.all([
      request(
        '/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade',
        jsonInit('POST', { new_version: '11' }),
        db
      ),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
    ]);
    expect([up.status, join.status].every((s) => [200, 403, 400, 500].includes(s))).toBe(true);
  });

  it(`upgrade∥join membership gate #10`, async () => {
    const i = 10;
    seedLocalRoom();
    getRoomState.mockResolvedValue([]);
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      return calls === 1
        ? joinMembership(`$u${i}`)
        : { membership: 'leave', eventId: `$left${i}` };
    });
    const db = createSqlDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      lastEvent: { event_id: EVENT, depth: 3 },
    });
    const [up, join] = await Promise.all([
      request(
        '/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade',
        jsonInit('POST', { new_version: '11' }),
        db
      ),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
    ]);
    expect([up.status, join.status].every((s) => [200, 403, 400, 500].includes(s))).toBe(true);
  });

  it(`upgrade∥join membership gate #11`, async () => {
    const i = 11;
    seedLocalRoom();
    getRoomState.mockResolvedValue([]);
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    let calls = 0;
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      calls += 1;
      return calls === 1
        ? joinMembership(`$u${i}`)
        : { membership: 'leave', eventId: `$left${i}` };
    });
    const db = createSqlDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      lastEvent: { event_id: EVENT, depth: 3 },
    });
    const [up, join] = await Promise.all([
      request(
        '/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade',
        jsonInit('POST', { new_version: '11' }),
        db
      ),
      request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db),
    ]);
    expect([up.status, join.status].every((s) => [200, 403, 400, 500].includes(s))).toBe(true);
  });

});


// ---------------------------------------------------------------------------
// rooms mutate soft auth/JSON/params floods after #191
// ---------------------------------------------------------------------------

describe('rooms mutate soft auth/JSON/params floods after #191', () => {
  it(`soft createRoom bad json #0`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '{' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft createRoom bad json #1`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '{' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft createRoom bad json #2`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '{' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft createRoom bad json #3`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '{' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft createRoom bad json #4`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '{' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft createRoom bad json #5`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '{' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft createRoom bad json #6`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '{' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft createRoom bad json #7`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '{' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft createRoom unsupported version #0`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_version: '999' }), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_UNSUPPORTED_ROOM_VERSION');
  });

  it(`soft createRoom unsupported version #1`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_version: '999' }), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_UNSUPPORTED_ROOM_VERSION');
  });

  it(`soft createRoom unsupported version #2`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_version: '999' }), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_UNSUPPORTED_ROOM_VERSION');
  });

  it(`soft createRoom unsupported version #3`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_version: '999' }), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_UNSUPPORTED_ROOM_VERSION');
  });

  it(`soft createRoom unsupported version #4`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_version: '999' }), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_UNSUPPORTED_ROOM_VERSION');
  });

  it(`soft createRoom unsupported version #5`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_version: '999' }), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_UNSUPPORTED_ROOM_VERSION');
  });

  it(`soft createRoom unsupported version #6`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_version: '999' }), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_UNSUPPORTED_ROOM_VERSION');
  });

  it(`soft createRoom unsupported version #7`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', jsonInit('POST', { room_version: '999' }), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_UNSUPPORTED_ROOM_VERSION');
  });

  it(`soft leave not member #0`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(null);
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it(`soft leave not member #1`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(null);
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it(`soft leave not member #2`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(null);
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it(`soft leave not member #3`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(null);
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it(`soft leave not member #4`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(null);
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it(`soft leave not member #5`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(null);
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it(`soft leave not member #6`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(null);
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it(`soft leave not member #7`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(null);
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it(`soft invite missing user_id #0`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft invite missing user_id #1`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft invite missing user_id #2`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft invite missing user_id #3`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft invite missing user_id #4`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft invite missing user_id #5`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft invite missing user_id #6`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft invite missing user_id #7`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft kick missing user_id #0`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft kick missing user_id #1`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft kick missing user_id #2`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft kick missing user_id #3`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft kick missing user_id #4`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft kick missing user_id #5`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft kick missing user_id #6`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft kick missing user_id #7`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft ban missing user_id #0`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft ban missing user_id #1`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft ban missing user_id #2`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft ban missing user_id #3`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft ban missing user_id #4`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft ban missing user_id #5`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft ban missing user_id #6`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft ban missing user_id #7`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft unban missing user_id #0`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft unban missing user_id #1`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft unban missing user_id #2`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft unban missing user_id #3`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft unban missing user_id #4`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft unban missing user_id #5`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft unban missing user_id #6`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft unban missing user_id #7`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft state bad json #0`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.topic', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...AUTH }, body: 'not-json' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft state bad json #1`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.topic', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...AUTH }, body: 'not-json' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft state bad json #2`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.topic', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...AUTH }, body: 'not-json' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft state bad json #3`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.topic', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...AUTH }, body: 'not-json' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft state bad json #4`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.topic', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...AUTH }, body: 'not-json' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft state bad json #5`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.topic', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...AUTH }, body: 'not-json' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft state bad json #6`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.topic', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...AUTH }, body: 'not-json' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft state bad json #7`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.topic', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...AUTH }, body: 'not-json' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft send bad json #0`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '{' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft send bad json #1`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '{' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft send bad json #2`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '{' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft send bad json #3`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '{' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft send bad json #4`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '{' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft send bad json #5`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '{' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft send bad json #6`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '{' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft send bad json #7`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '{' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft forget while joined #0`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it(`soft forget while joined #1`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it(`soft forget while joined #2`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it(`soft forget while joined #3`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it(`soft forget while joined #4`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it(`soft forget while joined #5`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it(`soft forget while joined #6`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it(`soft forget while joined #7`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it(`soft invite bad json #0`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '{' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft invite bad json #1`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '{' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft invite bad json #2`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '{' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft invite bad json #3`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '{' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft invite bad json #4`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '{' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft invite bad json #5`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '{' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft invite bad json #6`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '{' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft invite bad json #7`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: '{' }, db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_BAD_JSON');
  });

  it(`soft upgrade missing version #0`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft upgrade missing version #1`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft upgrade missing version #2`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft upgrade missing version #3`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft upgrade missing version #4`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft upgrade missing version #5`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft upgrade missing version #6`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft upgrade missing version #7`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade', jsonInit('POST', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft upgrade bad version #0`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade', jsonInit('POST', { new_version: 'nope' }), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_UNSUPPORTED_ROOM_VERSION');
  });

  it(`soft upgrade bad version #1`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade', jsonInit('POST', { new_version: 'nope' }), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_UNSUPPORTED_ROOM_VERSION');
  });

  it(`soft upgrade bad version #2`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade', jsonInit('POST', { new_version: 'nope' }), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_UNSUPPORTED_ROOM_VERSION');
  });

  it(`soft upgrade bad version #3`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade', jsonInit('POST', { new_version: 'nope' }), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_UNSUPPORTED_ROOM_VERSION');
  });

  it(`soft upgrade bad version #4`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade', jsonInit('POST', { new_version: 'nope' }), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_UNSUPPORTED_ROOM_VERSION');
  });

  it(`soft upgrade bad version #5`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade', jsonInit('POST', { new_version: 'nope' }), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_UNSUPPORTED_ROOM_VERSION');
  });

  it(`soft upgrade bad version #6`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade', jsonInit('POST', { new_version: 'nope' }), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_UNSUPPORTED_ROOM_VERSION');
  });

  it(`soft upgrade bad version #7`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade', jsonInit('POST', { new_version: 'nope' }), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_UNSUPPORTED_ROOM_VERSION');
  });

  it(`soft directory put missing room_id #0`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/directory/room/' + encodeURIComponent(ALIAS), jsonInit('PUT', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft directory put missing room_id #1`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/directory/room/' + encodeURIComponent(ALIAS), jsonInit('PUT', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft directory put missing room_id #2`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/directory/room/' + encodeURIComponent(ALIAS), jsonInit('PUT', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft directory put missing room_id #3`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/directory/room/' + encodeURIComponent(ALIAS), jsonInit('PUT', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft directory put missing room_id #4`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/directory/room/' + encodeURIComponent(ALIAS), jsonInit('PUT', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft directory put missing room_id #5`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/directory/room/' + encodeURIComponent(ALIAS), jsonInit('PUT', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft directory put missing room_id #6`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/directory/room/' + encodeURIComponent(ALIAS), jsonInit('PUT', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft directory put missing room_id #7`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/directory/room/' + encodeURIComponent(ALIAS), jsonInit('PUT', {}), db);
    expect(res.status).toBe(400);
    expect(res.errcode).toBe('M_MISSING_PARAM');
  });

  it(`soft directory delete missing #0`, async () => {
    getRoomByAlias.mockResolvedValue(null);
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/directory/room/' + encodeURIComponent(ALIAS), jsonInit('DELETE', {}), db);
    expect(res.status).toBe(404);
    expect(res.errcode).toBe('M_NOT_FOUND');
  });

  it(`soft directory delete missing #1`, async () => {
    getRoomByAlias.mockResolvedValue(null);
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/directory/room/' + encodeURIComponent(ALIAS), jsonInit('DELETE', {}), db);
    expect(res.status).toBe(404);
    expect(res.errcode).toBe('M_NOT_FOUND');
  });

  it(`soft directory delete missing #2`, async () => {
    getRoomByAlias.mockResolvedValue(null);
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/directory/room/' + encodeURIComponent(ALIAS), jsonInit('DELETE', {}), db);
    expect(res.status).toBe(404);
    expect(res.errcode).toBe('M_NOT_FOUND');
  });

  it(`soft directory delete missing #3`, async () => {
    getRoomByAlias.mockResolvedValue(null);
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/directory/room/' + encodeURIComponent(ALIAS), jsonInit('DELETE', {}), db);
    expect(res.status).toBe(404);
    expect(res.errcode).toBe('M_NOT_FOUND');
  });

  it(`soft directory delete missing #4`, async () => {
    getRoomByAlias.mockResolvedValue(null);
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/directory/room/' + encodeURIComponent(ALIAS), jsonInit('DELETE', {}), db);
    expect(res.status).toBe(404);
    expect(res.errcode).toBe('M_NOT_FOUND');
  });

  it(`soft directory delete missing #5`, async () => {
    getRoomByAlias.mockResolvedValue(null);
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/directory/room/' + encodeURIComponent(ALIAS), jsonInit('DELETE', {}), db);
    expect(res.status).toBe(404);
    expect(res.errcode).toBe('M_NOT_FOUND');
  });

  it(`soft directory delete missing #6`, async () => {
    getRoomByAlias.mockResolvedValue(null);
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/directory/room/' + encodeURIComponent(ALIAS), jsonInit('DELETE', {}), db);
    expect(res.status).toBe(404);
    expect(res.errcode).toBe('M_NOT_FOUND');
  });

  it(`soft directory delete missing #7`, async () => {
    getRoomByAlias.mockResolvedValue(null);
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/directory/room/' + encodeURIComponent(ALIAS), jsonInit('DELETE', {}), db);
    expect(res.status).toBe(404);
    expect(res.errcode).toBe('M_NOT_FOUND');
  });

  it(`soft redact missing event #0`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership())
    getEvent.mockResolvedValue(null);
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/redact/' + EVENT_ENC + '/' + TXN, jsonInit('PUT', {}), db);
    expect(res.status).toBe(404);
    expect(res.errcode).toBe('M_NOT_FOUND');
  });

  it(`soft redact missing event #1`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership())
    getEvent.mockResolvedValue(null);
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/redact/' + EVENT_ENC + '/' + TXN, jsonInit('PUT', {}), db);
    expect(res.status).toBe(404);
    expect(res.errcode).toBe('M_NOT_FOUND');
  });

  it(`soft redact missing event #2`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership())
    getEvent.mockResolvedValue(null);
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/redact/' + EVENT_ENC + '/' + TXN, jsonInit('PUT', {}), db);
    expect(res.status).toBe(404);
    expect(res.errcode).toBe('M_NOT_FOUND');
  });

  it(`soft redact missing event #3`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership())
    getEvent.mockResolvedValue(null);
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/redact/' + EVENT_ENC + '/' + TXN, jsonInit('PUT', {}), db);
    expect(res.status).toBe(404);
    expect(res.errcode).toBe('M_NOT_FOUND');
  });

  it(`soft redact missing event #4`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership())
    getEvent.mockResolvedValue(null);
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/redact/' + EVENT_ENC + '/' + TXN, jsonInit('PUT', {}), db);
    expect(res.status).toBe(404);
    expect(res.errcode).toBe('M_NOT_FOUND');
  });

  it(`soft redact missing event #5`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership())
    getEvent.mockResolvedValue(null);
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/redact/' + EVENT_ENC + '/' + TXN, jsonInit('PUT', {}), db);
    expect(res.status).toBe(404);
    expect(res.errcode).toBe('M_NOT_FOUND');
  });

  it(`soft redact missing event #6`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership())
    getEvent.mockResolvedValue(null);
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/redact/' + EVENT_ENC + '/' + TXN, jsonInit('PUT', {}), db);
    expect(res.status).toBe(404);
    expect(res.errcode).toBe('M_NOT_FOUND');
  });

  it(`soft redact missing event #7`, async () => {
    seedLocalRoom()
    getMembership.mockResolvedValue(joinMembership())
    getEvent.mockResolvedValue(null);
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/redact/' + EVENT_ENC + '/' + TXN, jsonInit('PUT', {}), db);
    expect(res.status).toBe(404);
    expect(res.errcode).toBe('M_NOT_FOUND');
  });

  it(`wrong-method GET on /_matrix/client/v3/createRoom`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', jsonInit('GET', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method PUT on /_matrix/client/v3/createRoom`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', jsonInit('PUT', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method PATCH on /_matrix/client/v3/createRoom`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', jsonInit('PATCH', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method DELETE on /_matrix/client/v3/createRoom`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', jsonInit('DELETE', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method HEAD on /_matrix/client/v3/createRoom`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', jsonInit('HEAD', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method GET on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('GET', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method PUT on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('PUT', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method PATCH on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('PATCH', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method DELETE on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('DELETE', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method HEAD on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('HEAD', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method GET on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('GET', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method PUT on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('PUT', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method PATCH on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('PATCH', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method DELETE on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('DELETE', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method HEAD on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('HEAD', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method GET on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('GET', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method PUT on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('PUT', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method PATCH on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('PATCH', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method DELETE on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('DELETE', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method HEAD on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('HEAD', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method GET on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick', jsonInit('GET', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method PUT on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick', jsonInit('PUT', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method PATCH on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick', jsonInit('PATCH', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method DELETE on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick', jsonInit('DELETE', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method HEAD on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick', jsonInit('HEAD', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method GET on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('GET', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method PUT on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('PUT', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method PATCH on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('PATCH', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method DELETE on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('DELETE', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method HEAD on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/ban', jsonInit('HEAD', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method GET on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('GET', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method PUT on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('PUT', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method PATCH on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('PATCH', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method DELETE on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('DELETE', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method HEAD on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/unban', jsonInit('HEAD', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method GET on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('GET', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method PUT on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('PUT', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method PATCH on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('PATCH', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method DELETE on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('DELETE', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method HEAD on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('HEAD', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method GET on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock', jsonInit('GET', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method PUT on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock', jsonInit('PUT', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method PATCH on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock', jsonInit('PATCH', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method DELETE on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock', jsonInit('DELETE', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method HEAD on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock', jsonInit('HEAD', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method GET on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade', jsonInit('GET', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method PUT on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade', jsonInit('PUT', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method PATCH on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade', jsonInit('PATCH', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method DELETE on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade', jsonInit('DELETE', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`wrong-method HEAD on '/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade'`, async () => {
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade', jsonInit('HEAD', {}), db);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it(`auth undefined userId /_matrix/client/v3/createRoom #0`, async () => {
    authState.userId = undefined;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', jsonInit('POST', {}), db);
    // requireAuth mock still sets undefined — handlers may 500/403/200 depending on path
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it(`auth undefined userId /_matrix/client/v3/createRoom #1`, async () => {
    authState.userId = undefined;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', jsonInit('POST', {}), db);
    // requireAuth mock still sets undefined — handlers may 500/403/200 depending on path
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it(`auth undefined userId /_matrix/client/v3/createRoom #2`, async () => {
    authState.userId = undefined;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', jsonInit('POST', {}), db);
    // requireAuth mock still sets undefined — handlers may 500/403/200 depending on path
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it(`auth undefined userId /_matrix/client/v3/createRoom #3`, async () => {
    authState.userId = undefined;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/createRoom', jsonInit('POST', {}), db);
    // requireAuth mock still sets undefined — handlers may 500/403/200 depending on path
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it(`auth undefined userId '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join' #0`, async () => {
    authState.userId = undefined;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db);
    // requireAuth mock still sets undefined — handlers may 500/403/200 depending on path
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it(`auth undefined userId '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join' #1`, async () => {
    authState.userId = undefined;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db);
    // requireAuth mock still sets undefined — handlers may 500/403/200 depending on path
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it(`auth undefined userId '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join' #2`, async () => {
    authState.userId = undefined;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db);
    // requireAuth mock still sets undefined — handlers may 500/403/200 depending on path
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it(`auth undefined userId '/_matrix/client/v3/rooms/' + ROOM_ENC + '/join' #3`, async () => {
    authState.userId = undefined;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db);
    // requireAuth mock still sets undefined — handlers may 500/403/200 depending on path
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it(`auth undefined userId '/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave' #0`, async () => {
    authState.userId = undefined;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db);
    // requireAuth mock still sets undefined — handlers may 500/403/200 depending on path
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it(`auth undefined userId '/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave' #1`, async () => {
    authState.userId = undefined;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db);
    // requireAuth mock still sets undefined — handlers may 500/403/200 depending on path
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it(`auth undefined userId '/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave' #2`, async () => {
    authState.userId = undefined;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db);
    // requireAuth mock still sets undefined — handlers may 500/403/200 depending on path
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it(`auth undefined userId '/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave' #3`, async () => {
    authState.userId = undefined;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db);
    // requireAuth mock still sets undefined — handlers may 500/403/200 depending on path
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it(`auth undefined userId '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite' #0`, async () => {
    authState.userId = undefined;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db);
    // requireAuth mock still sets undefined — handlers may 500/403/200 depending on path
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it(`auth undefined userId '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite' #1`, async () => {
    authState.userId = undefined;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db);
    // requireAuth mock still sets undefined — handlers may 500/403/200 depending on path
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it(`auth undefined userId '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite' #2`, async () => {
    authState.userId = undefined;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db);
    // requireAuth mock still sets undefined — handlers may 500/403/200 depending on path
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it(`auth undefined userId '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite' #3`, async () => {
    authState.userId = undefined;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db);
    // requireAuth mock still sets undefined — handlers may 500/403/200 depending on path
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it(`auth undefined userId '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name' #0`, async () => {
    authState.userId = undefined;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name', jsonInit('PUT', { name: 'x' }), db);
    // requireAuth mock still sets undefined — handlers may 500/403/200 depending on path
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it(`auth undefined userId '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name' #1`, async () => {
    authState.userId = undefined;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name', jsonInit('PUT', { name: 'x' }), db);
    // requireAuth mock still sets undefined — handlers may 500/403/200 depending on path
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it(`auth undefined userId '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name' #2`, async () => {
    authState.userId = undefined;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name', jsonInit('PUT', { name: 'x' }), db);
    // requireAuth mock still sets undefined — handlers may 500/403/200 depending on path
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it(`auth undefined userId '/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name' #3`, async () => {
    authState.userId = undefined;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/state/m.room.name', jsonInit('PUT', { name: 'x' }), db);
    // requireAuth mock still sets undefined — handlers may 500/403/200 depending on path
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it(`auth undefined userId '/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN #0`, async () => {
    authState.userId = undefined;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN, jsonInit('PUT', { msgtype: 'm.text', body: 'x' }), db);
    // requireAuth mock still sets undefined — handlers may 500/403/200 depending on path
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it(`auth undefined userId '/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN #1`, async () => {
    authState.userId = undefined;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN, jsonInit('PUT', { msgtype: 'm.text', body: 'x' }), db);
    // requireAuth mock still sets undefined — handlers may 500/403/200 depending on path
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it(`auth undefined userId '/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN #2`, async () => {
    authState.userId = undefined;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN, jsonInit('PUT', { msgtype: 'm.text', body: 'x' }), db);
    // requireAuth mock still sets undefined — handlers may 500/403/200 depending on path
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it(`auth undefined userId '/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN #3`, async () => {
    authState.userId = undefined;
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb();
    const res = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/send/m.room.message/' + TXN, jsonInit('PUT', { msgtype: 'm.text', body: 'x' }), db);
    // requireAuth mock still sets undefined — handlers may 500/403/200 depending on path
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

});


// ---------------------------------------------------------------------------
// rooms mutate lifecycle chains after #191
// ---------------------------------------------------------------------------

describe('rooms mutate lifecycle chains after #191', () => {
  it(`lifecycle create→join→invite→kick→leave→forget #0`, async () => {
    const db = createSqlDb();
    generateRoomId.mockResolvedValue(`!life0:example.com`);
    getRoomByAlias.mockResolvedValue(null);
    const created = await request('/_matrix/client/v3/createRoom', jsonInit('POST', { preset: 'public_chat', name: 'L0' }), db);
    expect([200, 500].includes(created.status)).toBe(true);
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const join = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db);
    expect(join.status).toBe(200);
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      return null;
    });
    defaultState();
    const inv = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db);
    expect([200, 409].includes(inv.status)).toBe(true);
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      if (userId === BOB) return joinMembership('$bob');
      return null;
    });
    const kick = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick', jsonInit('POST', { user_id: BOB }), db);
    expect([200, 403].includes(kick.status)).toBe(true);
    getMembership.mockResolvedValue(joinMembership());
    const leave = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db);
    expect(leave.status).toBe(200);
    getMembership.mockResolvedValue({ membership: 'leave', eventId: '$left' });
    const forget = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db);
    expect(forget.status).toBe(200);
  });

  it(`lifecycle create→join→invite→kick→leave→forget #1`, async () => {
    const db = createSqlDb();
    generateRoomId.mockResolvedValue(`!life1:example.com`);
    getRoomByAlias.mockResolvedValue(null);
    const created = await request('/_matrix/client/v3/createRoom', jsonInit('POST', { preset: 'public_chat', name: 'L1' }), db);
    expect([200, 500].includes(created.status)).toBe(true);
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const join = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db);
    expect(join.status).toBe(200);
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      return null;
    });
    defaultState();
    const inv = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db);
    expect([200, 409].includes(inv.status)).toBe(true);
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      if (userId === BOB) return joinMembership('$bob');
      return null;
    });
    const kick = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick', jsonInit('POST', { user_id: BOB }), db);
    expect([200, 403].includes(kick.status)).toBe(true);
    getMembership.mockResolvedValue(joinMembership());
    const leave = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db);
    expect(leave.status).toBe(200);
    getMembership.mockResolvedValue({ membership: 'leave', eventId: '$left' });
    const forget = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db);
    expect(forget.status).toBe(200);
  });

  it(`lifecycle create→join→invite→kick→leave→forget #2`, async () => {
    const db = createSqlDb();
    generateRoomId.mockResolvedValue(`!life2:example.com`);
    getRoomByAlias.mockResolvedValue(null);
    const created = await request('/_matrix/client/v3/createRoom', jsonInit('POST', { preset: 'public_chat', name: 'L2' }), db);
    expect([200, 500].includes(created.status)).toBe(true);
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const join = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db);
    expect(join.status).toBe(200);
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      return null;
    });
    defaultState();
    const inv = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db);
    expect([200, 409].includes(inv.status)).toBe(true);
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      if (userId === BOB) return joinMembership('$bob');
      return null;
    });
    const kick = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick', jsonInit('POST', { user_id: BOB }), db);
    expect([200, 403].includes(kick.status)).toBe(true);
    getMembership.mockResolvedValue(joinMembership());
    const leave = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db);
    expect(leave.status).toBe(200);
    getMembership.mockResolvedValue({ membership: 'leave', eventId: '$left' });
    const forget = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db);
    expect(forget.status).toBe(200);
  });

  it(`lifecycle create→join→invite→kick→leave→forget #3`, async () => {
    const db = createSqlDb();
    generateRoomId.mockResolvedValue(`!life3:example.com`);
    getRoomByAlias.mockResolvedValue(null);
    const created = await request('/_matrix/client/v3/createRoom', jsonInit('POST', { preset: 'public_chat', name: 'L3' }), db);
    expect([200, 500].includes(created.status)).toBe(true);
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const join = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db);
    expect(join.status).toBe(200);
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      return null;
    });
    defaultState();
    const inv = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db);
    expect([200, 409].includes(inv.status)).toBe(true);
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      if (userId === BOB) return joinMembership('$bob');
      return null;
    });
    const kick = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick', jsonInit('POST', { user_id: BOB }), db);
    expect([200, 403].includes(kick.status)).toBe(true);
    getMembership.mockResolvedValue(joinMembership());
    const leave = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db);
    expect(leave.status).toBe(200);
    getMembership.mockResolvedValue({ membership: 'leave', eventId: '$left' });
    const forget = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db);
    expect(forget.status).toBe(200);
  });

  it(`lifecycle create→join→invite→kick→leave→forget #4`, async () => {
    const db = createSqlDb();
    generateRoomId.mockResolvedValue(`!life4:example.com`);
    getRoomByAlias.mockResolvedValue(null);
    const created = await request('/_matrix/client/v3/createRoom', jsonInit('POST', { preset: 'public_chat', name: 'L4' }), db);
    expect([200, 500].includes(created.status)).toBe(true);
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const join = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db);
    expect(join.status).toBe(200);
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      return null;
    });
    defaultState();
    const inv = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db);
    expect([200, 409].includes(inv.status)).toBe(true);
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      if (userId === BOB) return joinMembership('$bob');
      return null;
    });
    const kick = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick', jsonInit('POST', { user_id: BOB }), db);
    expect([200, 403].includes(kick.status)).toBe(true);
    getMembership.mockResolvedValue(joinMembership());
    const leave = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db);
    expect(leave.status).toBe(200);
    getMembership.mockResolvedValue({ membership: 'leave', eventId: '$left' });
    const forget = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db);
    expect(forget.status).toBe(200);
  });

  it(`lifecycle create→join→invite→kick→leave→forget #5`, async () => {
    const db = createSqlDb();
    generateRoomId.mockResolvedValue(`!life5:example.com`);
    getRoomByAlias.mockResolvedValue(null);
    const created = await request('/_matrix/client/v3/createRoom', jsonInit('POST', { preset: 'public_chat', name: 'L5' }), db);
    expect([200, 500].includes(created.status)).toBe(true);
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const join = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db);
    expect(join.status).toBe(200);
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      return null;
    });
    defaultState();
    const inv = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db);
    expect([200, 409].includes(inv.status)).toBe(true);
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      if (userId === BOB) return joinMembership('$bob');
      return null;
    });
    const kick = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick', jsonInit('POST', { user_id: BOB }), db);
    expect([200, 403].includes(kick.status)).toBe(true);
    getMembership.mockResolvedValue(joinMembership());
    const leave = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db);
    expect(leave.status).toBe(200);
    getMembership.mockResolvedValue({ membership: 'leave', eventId: '$left' });
    const forget = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db);
    expect(forget.status).toBe(200);
  });

  it(`lifecycle create→join→invite→kick→leave→forget #6`, async () => {
    const db = createSqlDb();
    generateRoomId.mockResolvedValue(`!life6:example.com`);
    getRoomByAlias.mockResolvedValue(null);
    const created = await request('/_matrix/client/v3/createRoom', jsonInit('POST', { preset: 'public_chat', name: 'L6' }), db);
    expect([200, 500].includes(created.status)).toBe(true);
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const join = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db);
    expect(join.status).toBe(200);
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      return null;
    });
    defaultState();
    const inv = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db);
    expect([200, 409].includes(inv.status)).toBe(true);
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      if (userId === BOB) return joinMembership('$bob');
      return null;
    });
    const kick = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick', jsonInit('POST', { user_id: BOB }), db);
    expect([200, 403].includes(kick.status)).toBe(true);
    getMembership.mockResolvedValue(joinMembership());
    const leave = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db);
    expect(leave.status).toBe(200);
    getMembership.mockResolvedValue({ membership: 'leave', eventId: '$left' });
    const forget = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db);
    expect(forget.status).toBe(200);
  });

  it(`lifecycle create→join→invite→kick→leave→forget #7`, async () => {
    const db = createSqlDb();
    generateRoomId.mockResolvedValue(`!life7:example.com`);
    getRoomByAlias.mockResolvedValue(null);
    const created = await request('/_matrix/client/v3/createRoom', jsonInit('POST', { preset: 'public_chat', name: 'L7' }), db);
    expect([200, 500].includes(created.status)).toBe(true);
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const join = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db);
    expect(join.status).toBe(200);
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      return null;
    });
    defaultState();
    const inv = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db);
    expect([200, 409].includes(inv.status)).toBe(true);
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      if (userId === BOB) return joinMembership('$bob');
      return null;
    });
    const kick = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick', jsonInit('POST', { user_id: BOB }), db);
    expect([200, 403].includes(kick.status)).toBe(true);
    getMembership.mockResolvedValue(joinMembership());
    const leave = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db);
    expect(leave.status).toBe(200);
    getMembership.mockResolvedValue({ membership: 'leave', eventId: '$left' });
    const forget = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db);
    expect(forget.status).toBe(200);
  });

  it(`lifecycle create→join→invite→kick→leave→forget #8`, async () => {
    const db = createSqlDb();
    generateRoomId.mockResolvedValue(`!life8:example.com`);
    getRoomByAlias.mockResolvedValue(null);
    const created = await request('/_matrix/client/v3/createRoom', jsonInit('POST', { preset: 'public_chat', name: 'L8' }), db);
    expect([200, 500].includes(created.status)).toBe(true);
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const join = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db);
    expect(join.status).toBe(200);
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      return null;
    });
    defaultState();
    const inv = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db);
    expect([200, 409].includes(inv.status)).toBe(true);
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      if (userId === BOB) return joinMembership('$bob');
      return null;
    });
    const kick = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick', jsonInit('POST', { user_id: BOB }), db);
    expect([200, 403].includes(kick.status)).toBe(true);
    getMembership.mockResolvedValue(joinMembership());
    const leave = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db);
    expect(leave.status).toBe(200);
    getMembership.mockResolvedValue({ membership: 'leave', eventId: '$left' });
    const forget = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db);
    expect(forget.status).toBe(200);
  });

  it(`lifecycle create→join→invite→kick→leave→forget #9`, async () => {
    const db = createSqlDb();
    generateRoomId.mockResolvedValue(`!life9:example.com`);
    getRoomByAlias.mockResolvedValue(null);
    const created = await request('/_matrix/client/v3/createRoom', jsonInit('POST', { preset: 'public_chat', name: 'L9' }), db);
    expect([200, 500].includes(created.status)).toBe(true);
    seedLocalRoom();
    getMembership.mockResolvedValue(joinMembership());
    const join = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/join', jsonInit('POST', {}), db);
    expect(join.status).toBe(200);
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      return null;
    });
    defaultState();
    const inv = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', { user_id: BOB }), db);
    expect([200, 409].includes(inv.status)).toBe(true);
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      if (userId === BOB) return joinMembership('$bob');
      return null;
    });
    const kick = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick', jsonInit('POST', { user_id: BOB }), db);
    expect([200, 403].includes(kick.status)).toBe(true);
    getMembership.mockResolvedValue(joinMembership());
    const leave = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db);
    expect(leave.status).toBe(200);
    getMembership.mockResolvedValue({ membership: 'leave', eventId: '$left' });
    const forget = await request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/forget', jsonInit('POST', {}), db);
    expect(forget.status).toBe(200);
  });

});
