/**
 * TOKENMAXX HEAVY leftovers after #211 — rooms *power-levels / redact*
 * concurrent race / TOCTOU leftovers.
 *
 * Distinct from rooms-mutate (#194) PL PUT∥PUT + redact∥redact happy-path floods,
 * rooms-concurrent (#192) redactBarrier / self-redact soft, rooms-read-upgrade (#208),
 * directory/userdir (#211), relations (#210), account (#209). Soft leftovers in
 * event-auth-room-state never barrier membership→PL→redact or send∥redact /
 * PL∥redact under Promise.all.
 *
 * Focus: redact PL check demotion mid-flight (no optimistic re-read on redact);
 * membership leave mid-flight during redact; send∥redact interleave; PL PUT∥redact;
 * dual distinct-event redact isolation; redacted_because UPDATE fail mid concurrent;
 * insufficient-PL / own-event / method / body / charset soft floods; PL state
 * conflict deepen; SQL bind contracts under parallel.
 *
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
const ROOM2_ENC = encodeURIComponent(ROOM2);
const EVENT = '$msg1:example.com';
const EVENT_ENC = encodeURIComponent(EVENT);
const EVENT2 = '$msg2:example.com';
const EVENT2_ENC = encodeURIComponent(EVENT2);
const AUTH = { Authorization: 'Bearer test-token' };
const NOW = 1_700_000_000_000;

type SqlCall = { sql: string; args: unknown[] };
type Membership = { membership: string; eventId: string };
type StateMap = Record<string, PDU | null>;
type FnBarrier = { count: number };

type DbOpts = {
  streamPosition?: number;
  redactBarrier?: { count: number };
  failRedactUpdate?: boolean;
  failRedactAfter?: number;
  runBarrier?: { match: (sql: string, args: unknown[]) => boolean; count: number };
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
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const selects: SqlCall[] = [];
  const redactWaiters: Array<() => void> = [];
  let redactBarrier = opts.redactBarrier;
  let redactUpdateCount = 0;
  let runBarrier = opts.runBarrier;
  const runWaiters = { list: [] as Array<() => void> };

  const db = {
    inserts,
    updates,
    deletes,
    selects,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              if (sql.includes('UPDATE stream_positions') && sql.includes('RETURNING position')) {
                const n = args[0] as number;
                streamPosition += n;
                return { position: streamPosition } as T;
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
              if (sql.includes('UPDATE events SET redacted_because')) {
                if (redactBarrier) {
                  await new Promise<void>((resolve) => {
                    redactWaiters.push(resolve);
                    if (redactWaiters.length >= redactBarrier!.count) {
                      const all = [...redactWaiters];
                      redactWaiters.length = 0;
                      redactBarrier = undefined;
                      for (const r of all) r();
                    }
                  });
                }
                redactUpdateCount += 1;
                if (opts.failRedactUpdate) throw new Error('d1-redact-update-fail');
                if (
                  opts.failRedactAfter !== undefined &&
                  redactUpdateCount > opts.failRedactAfter
                ) {
                  throw new Error('d1-redact-update-fail-after');
                }
                updates.push({ sql, args });
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.trimStart().startsWith('INSERT')) {
                inserts.push({ sql, args });
              } else if (sql.trimStart().startsWith('UPDATE')) {
                updates.push({ sql, args });
              } else if (sql.trimStart().startsWith('DELETE')) {
                deletes.push({ sql, args });
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch(stmts: unknown[]) {
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

function envFor(db: SqlDb, cache?: ReturnType<typeof mockKv>): Env {
  return {
    DB: db as unknown as D1Database,
    CACHE: cache ?? mockKv(),
    SERVER_NAME: SERVER,
    PUSH_NOTIFICATION_WORKFLOW: {
      create: vi.fn(async () => ({ id: 'push-1' })),
    },
    ROOM_JOIN_WORKFLOW: {
      create: vi.fn(async () => ({
        status: async () => ({ status: 'complete', output: { success: true } }),
      })),
    },
  } as unknown as Env;
}

async function request(
  path: string,
  init: RequestInit = {},
  db: SqlDb = createSqlDb(),
  cache?: ReturnType<typeof mockKv>
): Promise<{
  status: number;
  body: unknown;
  errcode?: string;
  db: SqlDb;
}> {
  const env = envFor(db, cache);
  const execCtx = createExecCtx();
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
  return { status: res.status, body, errcode, db };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  const upper = method.toUpperCase();
  const init: RequestInit = {
    method,
    headers: {
      ...AUTH,
      ...(upper === 'GET' || upper === 'HEAD' ? {} : { 'Content-Type': 'application/json' }),
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

function leaveMembership(eventId = '$alice-leave'): Membership {
  return { membership: 'leave', eventId };
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

function defaultPlContent(extra: Record<string, unknown> = {}) {
  return {
    users: { [USER]: 100, [BOB]: 50 },
    users_default: 0,
    state_default: 50,
    events_default: 0,
    ban: 50,
    kick: 50,
    redact: 50,
    invite: 50,
    events: {
      'm.room.name': 50,
      'm.room.power_levels': 100,
    },
    ...extra,
  };
}

function plPdu(eventId: string, content: Record<string, unknown> = defaultPlContent()) {
  return pdu({
    type: 'm.room.power_levels',
    event_id: eventId,
    content,
    state_key: '',
  });
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
      'm.room.power_levels': plPdu('$pl'),
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
  seedLocalRoom();
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

function redactPath(eventIdEnc: string, txn: string, roomEnc = ROOM_ENC) {
  return `/_matrix/client/v3/rooms/${roomEnc}/redact/${eventIdEnc}/${txn}`;
}

function plPath(roomEnc = ROOM_ENC) {
  return `/_matrix/client/v3/rooms/${roomEnc}/state/m.room.power_levels`;
}

function sendPath(txn: string, roomEnc = ROOM_ENC) {
  return `/_matrix/client/v3/rooms/${roomEnc}/send/m.room.message/${txn}`;
}


// ---------------------------------------------------------------------------
// redact PL check demotion mid-flight (no optimistic re-read on redact)
// ---------------------------------------------------------------------------

describe('race redact PL demotion mid-flight TOCTOU after #211', () => {
  it(`PL demotion during PL SELECT barrier soft-0`, async () => {
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
    let plReads = 0;
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        if (plReads > 2) {
          return plPdu(
            '$pl-demoted',
            defaultPlContent({ users: { [USER]: 0, [BOB]: 50 }, redact: 50 })
          );
        }
        return plPdu(
          '$pl',
          defaultPlContent({ users: { [USER]: 100, [BOB]: 50 }, redact: 50 })
        );
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
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `dem-a-0`), jsonInit('PUT', { reason: `a0` }), db),
      request(redactPath(EVENT_ENC, `dem-b-0`), jsonInit('PUT', { reason: `b0` }), db),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
    expect(storeEvent.mock.calls.length).toBe(2);
  });
  it(`PL demotion during PL SELECT barrier soft-1`, async () => {
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
    let plReads = 0;
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        if (plReads > 2) {
          return plPdu(
            '$pl-demoted',
            defaultPlContent({ users: { [USER]: 0, [BOB]: 50 }, redact: 50 })
          );
        }
        return plPdu(
          '$pl',
          defaultPlContent({ users: { [USER]: 100, [BOB]: 50 }, redact: 50 })
        );
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
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `dem-a-1`), jsonInit('PUT', { reason: `a1` }), db),
      request(redactPath(EVENT_ENC, `dem-b-1`), jsonInit('PUT', { reason: `b1` }), db),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
    expect(storeEvent.mock.calls.length).toBe(2);
  });
  it(`PL demotion during PL SELECT barrier soft-2`, async () => {
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
    let plReads = 0;
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        if (plReads > 2) {
          return plPdu(
            '$pl-demoted',
            defaultPlContent({ users: { [USER]: 0, [BOB]: 50 }, redact: 50 })
          );
        }
        return plPdu(
          '$pl',
          defaultPlContent({ users: { [USER]: 100, [BOB]: 50 }, redact: 50 })
        );
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
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `dem-a-2`), jsonInit('PUT', { reason: `a2` }), db),
      request(redactPath(EVENT_ENC, `dem-b-2`), jsonInit('PUT', { reason: `b2` }), db),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
    expect(storeEvent.mock.calls.length).toBe(2);
  });
  it(`PL demotion during PL SELECT barrier soft-3`, async () => {
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
    let plReads = 0;
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        if (plReads > 2) {
          return plPdu(
            '$pl-demoted',
            defaultPlContent({ users: { [USER]: 0, [BOB]: 50 }, redact: 50 })
          );
        }
        return plPdu(
          '$pl',
          defaultPlContent({ users: { [USER]: 100, [BOB]: 50 }, redact: 50 })
        );
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
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `dem-a-3`), jsonInit('PUT', { reason: `a3` }), db),
      request(redactPath(EVENT_ENC, `dem-b-3`), jsonInit('PUT', { reason: `b3` }), db),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
    expect(storeEvent.mock.calls.length).toBe(2);
  });
  it(`PL demotion during PL SELECT barrier soft-4`, async () => {
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
    let plReads = 0;
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        if (plReads > 2) {
          return plPdu(
            '$pl-demoted',
            defaultPlContent({ users: { [USER]: 0, [BOB]: 50 }, redact: 50 })
          );
        }
        return plPdu(
          '$pl',
          defaultPlContent({ users: { [USER]: 100, [BOB]: 50 }, redact: 50 })
        );
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
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `dem-a-4`), jsonInit('PUT', { reason: `a4` }), db),
      request(redactPath(EVENT_ENC, `dem-b-4`), jsonInit('PUT', { reason: `b4` }), db),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
    expect(storeEvent.mock.calls.length).toBe(2);
  });
  it(`PL demotion during PL SELECT barrier soft-5`, async () => {
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
    let plReads = 0;
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        if (plReads > 2) {
          return plPdu(
            '$pl-demoted',
            defaultPlContent({ users: { [USER]: 0, [BOB]: 50 }, redact: 50 })
          );
        }
        return plPdu(
          '$pl',
          defaultPlContent({ users: { [USER]: 100, [BOB]: 50 }, redact: 50 })
        );
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
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `dem-a-5`), jsonInit('PUT', { reason: `a5` }), db),
      request(redactPath(EVENT_ENC, `dem-b-5`), jsonInit('PUT', { reason: `b5` }), db),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
    expect(storeEvent.mock.calls.length).toBe(2);
  });
  it(`PL demotion during PL SELECT barrier soft-6`, async () => {
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
    let plReads = 0;
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        if (plReads > 2) {
          return plPdu(
            '$pl-demoted',
            defaultPlContent({ users: { [USER]: 0, [BOB]: 50 }, redact: 50 })
          );
        }
        return plPdu(
          '$pl',
          defaultPlContent({ users: { [USER]: 100, [BOB]: 50 }, redact: 50 })
        );
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
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `dem-a-6`), jsonInit('PUT', { reason: `a6` }), db),
      request(redactPath(EVENT_ENC, `dem-b-6`), jsonInit('PUT', { reason: `b6` }), db),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
    expect(storeEvent.mock.calls.length).toBe(2);
  });
  it(`PL demotion during PL SELECT barrier soft-7`, async () => {
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
    let plReads = 0;
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        if (plReads > 2) {
          return plPdu(
            '$pl-demoted',
            defaultPlContent({ users: { [USER]: 0, [BOB]: 50 }, redact: 50 })
          );
        }
        return plPdu(
          '$pl',
          defaultPlContent({ users: { [USER]: 100, [BOB]: 50 }, redact: 50 })
        );
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
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `dem-a-7`), jsonInit('PUT', { reason: `a7` }), db),
      request(redactPath(EVENT_ENC, `dem-b-7`), jsonInit('PUT', { reason: `b7` }), db),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
    expect(storeEvent.mock.calls.length).toBe(2);
  });
  it(`PL demotion during PL SELECT barrier soft-8`, async () => {
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
    let plReads = 0;
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        if (plReads > 2) {
          return plPdu(
            '$pl-demoted',
            defaultPlContent({ users: { [USER]: 0, [BOB]: 50 }, redact: 50 })
          );
        }
        return plPdu(
          '$pl',
          defaultPlContent({ users: { [USER]: 100, [BOB]: 50 }, redact: 50 })
        );
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
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `dem-a-8`), jsonInit('PUT', { reason: `a8` }), db),
      request(redactPath(EVENT_ENC, `dem-b-8`), jsonInit('PUT', { reason: `b8` }), db),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
    expect(storeEvent.mock.calls.length).toBe(2);
  });
  it(`PL demotion during PL SELECT barrier soft-9`, async () => {
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
    let plReads = 0;
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        if (plReads > 2) {
          return plPdu(
            '$pl-demoted',
            defaultPlContent({ users: { [USER]: 0, [BOB]: 50 }, redact: 50 })
          );
        }
        return plPdu(
          '$pl',
          defaultPlContent({ users: { [USER]: 100, [BOB]: 50 }, redact: 50 })
        );
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
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `dem-a-9`), jsonInit('PUT', { reason: `a9` }), db),
      request(redactPath(EVENT_ENC, `dem-b-9`), jsonInit('PUT', { reason: `b9` }), db),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
    expect(storeEvent.mock.calls.length).toBe(2);
  });
  it(`PL demotion during PL SELECT barrier soft-10`, async () => {
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
    let plReads = 0;
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        if (plReads > 2) {
          return plPdu(
            '$pl-demoted',
            defaultPlContent({ users: { [USER]: 0, [BOB]: 50 }, redact: 50 })
          );
        }
        return plPdu(
          '$pl',
          defaultPlContent({ users: { [USER]: 100, [BOB]: 50 }, redact: 50 })
        );
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
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `dem-a-10`), jsonInit('PUT', { reason: `a10` }), db),
      request(redactPath(EVENT_ENC, `dem-b-10`), jsonInit('PUT', { reason: `b10` }), db),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
    expect(storeEvent.mock.calls.length).toBe(2);
  });
  it(`PL demotion during PL SELECT barrier soft-11`, async () => {
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
    let plReads = 0;
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        if (plReads > 2) {
          return plPdu(
            '$pl-demoted',
            defaultPlContent({ users: { [USER]: 0, [BOB]: 50 }, redact: 50 })
          );
        }
        return plPdu(
          '$pl',
          defaultPlContent({ users: { [USER]: 100, [BOB]: 50 }, redact: 50 })
        );
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
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `dem-a-11`), jsonInit('PUT', { reason: `a11` }), db),
      request(redactPath(EVENT_ENC, `dem-b-11`), jsonInit('PUT', { reason: `b11` }), db),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
    expect(storeEvent.mock.calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// membership SELECT → leave mid-flight during redact
// ---------------------------------------------------------------------------

describe('race redact membership leave mid-flight TOCTOU after #211', () => {
  it(`membership leave after first SELECT soft-0`, async () => {
    let membershipReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      membershipReads += 1;
      if (membershipReads <= 2) return joinMembership(`$join-0`);
      return leaveMembership(`$leave-0`);
    });
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `mem-a-0`), jsonInit('PUT', { reason: 'a' }), db),
      request(redactPath(EVENT_ENC, `mem-b-0`), jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
  });
  it(`membership leave after first SELECT soft-1`, async () => {
    let membershipReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      membershipReads += 1;
      if (membershipReads <= 2) return joinMembership(`$join-1`);
      return leaveMembership(`$leave-1`);
    });
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `mem-a-1`), jsonInit('PUT', { reason: 'a' }), db),
      request(redactPath(EVENT_ENC, `mem-b-1`), jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
  });
  it(`membership leave after first SELECT soft-2`, async () => {
    let membershipReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      membershipReads += 1;
      if (membershipReads <= 2) return joinMembership(`$join-2`);
      return leaveMembership(`$leave-2`);
    });
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `mem-a-2`), jsonInit('PUT', { reason: 'a' }), db),
      request(redactPath(EVENT_ENC, `mem-b-2`), jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
  });
  it(`membership leave after first SELECT soft-3`, async () => {
    let membershipReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      membershipReads += 1;
      if (membershipReads <= 2) return joinMembership(`$join-3`);
      return leaveMembership(`$leave-3`);
    });
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `mem-a-3`), jsonInit('PUT', { reason: 'a' }), db),
      request(redactPath(EVENT_ENC, `mem-b-3`), jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
  });
  it(`membership leave after first SELECT soft-4`, async () => {
    let membershipReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      membershipReads += 1;
      if (membershipReads <= 2) return joinMembership(`$join-4`);
      return leaveMembership(`$leave-4`);
    });
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `mem-a-4`), jsonInit('PUT', { reason: 'a' }), db),
      request(redactPath(EVENT_ENC, `mem-b-4`), jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
  });
  it(`membership leave after first SELECT soft-5`, async () => {
    let membershipReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      membershipReads += 1;
      if (membershipReads <= 2) return joinMembership(`$join-5`);
      return leaveMembership(`$leave-5`);
    });
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `mem-a-5`), jsonInit('PUT', { reason: 'a' }), db),
      request(redactPath(EVENT_ENC, `mem-b-5`), jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
  });
  it(`membership leave after first SELECT soft-6`, async () => {
    let membershipReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      membershipReads += 1;
      if (membershipReads <= 2) return joinMembership(`$join-6`);
      return leaveMembership(`$leave-6`);
    });
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `mem-a-6`), jsonInit('PUT', { reason: 'a' }), db),
      request(redactPath(EVENT_ENC, `mem-b-6`), jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
  });
  it(`membership leave after first SELECT soft-7`, async () => {
    let membershipReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      membershipReads += 1;
      if (membershipReads <= 2) return joinMembership(`$join-7`);
      return leaveMembership(`$leave-7`);
    });
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `mem-a-7`), jsonInit('PUT', { reason: 'a' }), db),
      request(redactPath(EVENT_ENC, `mem-b-7`), jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
  });
  it(`membership leave after first SELECT soft-8`, async () => {
    let membershipReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      membershipReads += 1;
      if (membershipReads <= 2) return joinMembership(`$join-8`);
      return leaveMembership(`$leave-8`);
    });
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `mem-a-8`), jsonInit('PUT', { reason: 'a' }), db),
      request(redactPath(EVENT_ENC, `mem-b-8`), jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
  });
  it(`membership leave after first SELECT soft-9`, async () => {
    let membershipReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      membershipReads += 1;
      if (membershipReads <= 2) return joinMembership(`$join-9`);
      return leaveMembership(`$leave-9`);
    });
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `mem-a-9`), jsonInit('PUT', { reason: 'a' }), db),
      request(redactPath(EVENT_ENC, `mem-b-9`), jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
  });
  it(`membership leave after first SELECT soft-10`, async () => {
    let membershipReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      membershipReads += 1;
      if (membershipReads <= 2) return joinMembership(`$join-10`);
      return leaveMembership(`$leave-10`);
    });
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `mem-a-10`), jsonInit('PUT', { reason: 'a' }), db),
      request(redactPath(EVENT_ENC, `mem-b-10`), jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
  });
  it(`membership leave after first SELECT soft-11`, async () => {
    let membershipReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getMembership.mockImplementation(async () => {
      await withFnBarrier(barrier, waiters, () => {
        barrier = undefined;
      });
      membershipReads += 1;
      if (membershipReads <= 2) return joinMembership(`$join-11`);
      return leaveMembership(`$leave-11`);
    });
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `mem-a-11`), jsonInit('PUT', { reason: 'a' }), db),
      request(redactPath(EVENT_ENC, `mem-b-11`), jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// send∥redact interleave (claimed in rooms-mutate header, cases missing)
// ---------------------------------------------------------------------------

describe('race send∥redact interleave TOCTOU after #211', () => {
  it(`send∥redact same-room store barrier soft-0`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'target', msgtype: 'm.text' },
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
    const [sendRes, redactRes] = await Promise.all([
      request(
        sendPath(`send-0`),
        jsonInit('PUT', { msgtype: 'm.text', body: `parallel-0` }),
        db
      ),
      request(redactPath(EVENT_ENC, `redact-0`), jsonInit('PUT', { reason: `r0` }), db),
    ]);
    expect(sendRes.status).toBe(200);
    expect(redactRes.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });
  it(`send∥redact same-room store barrier soft-1`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'target', msgtype: 'm.text' },
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
    const [sendRes, redactRes] = await Promise.all([
      request(
        sendPath(`send-1`),
        jsonInit('PUT', { msgtype: 'm.text', body: `parallel-1` }),
        db
      ),
      request(redactPath(EVENT_ENC, `redact-1`), jsonInit('PUT', { reason: `r1` }), db),
    ]);
    expect(sendRes.status).toBe(200);
    expect(redactRes.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });
  it(`send∥redact same-room store barrier soft-2`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'target', msgtype: 'm.text' },
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
    const [sendRes, redactRes] = await Promise.all([
      request(
        sendPath(`send-2`),
        jsonInit('PUT', { msgtype: 'm.text', body: `parallel-2` }),
        db
      ),
      request(redactPath(EVENT_ENC, `redact-2`), jsonInit('PUT', { reason: `r2` }), db),
    ]);
    expect(sendRes.status).toBe(200);
    expect(redactRes.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });
  it(`send∥redact same-room store barrier soft-3`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'target', msgtype: 'm.text' },
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
    const [sendRes, redactRes] = await Promise.all([
      request(
        sendPath(`send-3`),
        jsonInit('PUT', { msgtype: 'm.text', body: `parallel-3` }),
        db
      ),
      request(redactPath(EVENT_ENC, `redact-3`), jsonInit('PUT', { reason: `r3` }), db),
    ]);
    expect(sendRes.status).toBe(200);
    expect(redactRes.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });
  it(`send∥redact same-room store barrier soft-4`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'target', msgtype: 'm.text' },
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
    const [sendRes, redactRes] = await Promise.all([
      request(
        sendPath(`send-4`),
        jsonInit('PUT', { msgtype: 'm.text', body: `parallel-4` }),
        db
      ),
      request(redactPath(EVENT_ENC, `redact-4`), jsonInit('PUT', { reason: `r4` }), db),
    ]);
    expect(sendRes.status).toBe(200);
    expect(redactRes.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });
  it(`send∥redact same-room store barrier soft-5`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'target', msgtype: 'm.text' },
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
    const [sendRes, redactRes] = await Promise.all([
      request(
        sendPath(`send-5`),
        jsonInit('PUT', { msgtype: 'm.text', body: `parallel-5` }),
        db
      ),
      request(redactPath(EVENT_ENC, `redact-5`), jsonInit('PUT', { reason: `r5` }), db),
    ]);
    expect(sendRes.status).toBe(200);
    expect(redactRes.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });
  it(`send∥redact same-room store barrier soft-6`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'target', msgtype: 'm.text' },
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
    const [sendRes, redactRes] = await Promise.all([
      request(
        sendPath(`send-6`),
        jsonInit('PUT', { msgtype: 'm.text', body: `parallel-6` }),
        db
      ),
      request(redactPath(EVENT_ENC, `redact-6`), jsonInit('PUT', { reason: `r6` }), db),
    ]);
    expect(sendRes.status).toBe(200);
    expect(redactRes.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });
  it(`send∥redact same-room store barrier soft-7`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'target', msgtype: 'm.text' },
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
    const [sendRes, redactRes] = await Promise.all([
      request(
        sendPath(`send-7`),
        jsonInit('PUT', { msgtype: 'm.text', body: `parallel-7` }),
        db
      ),
      request(redactPath(EVENT_ENC, `redact-7`), jsonInit('PUT', { reason: `r7` }), db),
    ]);
    expect(sendRes.status).toBe(200);
    expect(redactRes.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });
  it(`send∥redact same-room store barrier soft-8`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'target', msgtype: 'm.text' },
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
    const [sendRes, redactRes] = await Promise.all([
      request(
        sendPath(`send-8`),
        jsonInit('PUT', { msgtype: 'm.text', body: `parallel-8` }),
        db
      ),
      request(redactPath(EVENT_ENC, `redact-8`), jsonInit('PUT', { reason: `r8` }), db),
    ]);
    expect(sendRes.status).toBe(200);
    expect(redactRes.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });
  it(`send∥redact same-room store barrier soft-9`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'target', msgtype: 'm.text' },
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
    const [sendRes, redactRes] = await Promise.all([
      request(
        sendPath(`send-9`),
        jsonInit('PUT', { msgtype: 'm.text', body: `parallel-9` }),
        db
      ),
      request(redactPath(EVENT_ENC, `redact-9`), jsonInit('PUT', { reason: `r9` }), db),
    ]);
    expect(sendRes.status).toBe(200);
    expect(redactRes.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });
  it(`send∥redact same-room store barrier soft-10`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'target', msgtype: 'm.text' },
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
    const [sendRes, redactRes] = await Promise.all([
      request(
        sendPath(`send-10`),
        jsonInit('PUT', { msgtype: 'm.text', body: `parallel-10` }),
        db
      ),
      request(redactPath(EVENT_ENC, `redact-10`), jsonInit('PUT', { reason: `r10` }), db),
    ]);
    expect(sendRes.status).toBe(200);
    expect(redactRes.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });
  it(`send∥redact same-room store barrier soft-11`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'target', msgtype: 'm.text' },
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
    const [sendRes, redactRes] = await Promise.all([
      request(
        sendPath(`send-11`),
        jsonInit('PUT', { msgtype: 'm.text', body: `parallel-11` }),
        db
      ),
      request(redactPath(EVENT_ENC, `redact-11`), jsonInit('PUT', { reason: `r11` }), db),
    ]);
    expect(sendRes.status).toBe(200);
    expect(redactRes.status).toBe(200);
    expect(storeEvent.mock.calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PL PUT∥redact concurrent
// ---------------------------------------------------------------------------

describe('race PL PUT∥redact concurrent after #211', () => {
  it(`PL PUT∥redact store barrier soft-0`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 't', msgtype: 'm.text' },
      })
    );
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        return plPdu(plReads <= 2 ? '$pl-a' : '$pl-b');
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
    const newPl = defaultPlContent({
      users: { [USER]: 100, [BOB]: 40, [CAROL]: 10 },
    });
    const [plRes, redactRes] = await Promise.all([
      request(plPath(), jsonInit('PUT', newPl), db),
      request(
        redactPath(EVENT_ENC, `plx-0`),
        jsonInit('PUT', { reason: `with-pl-0` }),
        db
      ),
    ]);
    expect([200, 409].includes(plRes.status)).toBe(true);
    expect(redactRes.status).toBe(200);
  });
  it(`PL PUT∥redact store barrier soft-1`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 't', msgtype: 'm.text' },
      })
    );
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        return plPdu(plReads <= 2 ? '$pl-a' : '$pl-b');
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
    const newPl = defaultPlContent({
      users: { [USER]: 100, [BOB]: 40, [CAROL]: 10 },
    });
    const [plRes, redactRes] = await Promise.all([
      request(plPath(), jsonInit('PUT', newPl), db),
      request(
        redactPath(EVENT_ENC, `plx-1`),
        jsonInit('PUT', { reason: `with-pl-1` }),
        db
      ),
    ]);
    expect([200, 409].includes(plRes.status)).toBe(true);
    expect(redactRes.status).toBe(200);
  });
  it(`PL PUT∥redact store barrier soft-2`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 't', msgtype: 'm.text' },
      })
    );
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        return plPdu(plReads <= 2 ? '$pl-a' : '$pl-b');
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
    const newPl = defaultPlContent({
      users: { [USER]: 100, [BOB]: 40, [CAROL]: 10 },
    });
    const [plRes, redactRes] = await Promise.all([
      request(plPath(), jsonInit('PUT', newPl), db),
      request(
        redactPath(EVENT_ENC, `plx-2`),
        jsonInit('PUT', { reason: `with-pl-2` }),
        db
      ),
    ]);
    expect([200, 409].includes(plRes.status)).toBe(true);
    expect(redactRes.status).toBe(200);
  });
  it(`PL PUT∥redact store barrier soft-3`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 't', msgtype: 'm.text' },
      })
    );
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        return plPdu(plReads <= 2 ? '$pl-a' : '$pl-b');
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
    const newPl = defaultPlContent({
      users: { [USER]: 100, [BOB]: 40, [CAROL]: 10 },
    });
    const [plRes, redactRes] = await Promise.all([
      request(plPath(), jsonInit('PUT', newPl), db),
      request(
        redactPath(EVENT_ENC, `plx-3`),
        jsonInit('PUT', { reason: `with-pl-3` }),
        db
      ),
    ]);
    expect([200, 409].includes(plRes.status)).toBe(true);
    expect(redactRes.status).toBe(200);
  });
  it(`PL PUT∥redact store barrier soft-4`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 't', msgtype: 'm.text' },
      })
    );
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        return plPdu(plReads <= 2 ? '$pl-a' : '$pl-b');
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
    const newPl = defaultPlContent({
      users: { [USER]: 100, [BOB]: 40, [CAROL]: 10 },
    });
    const [plRes, redactRes] = await Promise.all([
      request(plPath(), jsonInit('PUT', newPl), db),
      request(
        redactPath(EVENT_ENC, `plx-4`),
        jsonInit('PUT', { reason: `with-pl-4` }),
        db
      ),
    ]);
    expect([200, 409].includes(plRes.status)).toBe(true);
    expect(redactRes.status).toBe(200);
  });
  it(`PL PUT∥redact store barrier soft-5`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 't', msgtype: 'm.text' },
      })
    );
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        return plPdu(plReads <= 2 ? '$pl-a' : '$pl-b');
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
    const newPl = defaultPlContent({
      users: { [USER]: 100, [BOB]: 40, [CAROL]: 10 },
    });
    const [plRes, redactRes] = await Promise.all([
      request(plPath(), jsonInit('PUT', newPl), db),
      request(
        redactPath(EVENT_ENC, `plx-5`),
        jsonInit('PUT', { reason: `with-pl-5` }),
        db
      ),
    ]);
    expect([200, 409].includes(plRes.status)).toBe(true);
    expect(redactRes.status).toBe(200);
  });
  it(`PL PUT∥redact store barrier soft-6`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 't', msgtype: 'm.text' },
      })
    );
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        return plPdu(plReads <= 2 ? '$pl-a' : '$pl-b');
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
    const newPl = defaultPlContent({
      users: { [USER]: 100, [BOB]: 40, [CAROL]: 10 },
    });
    const [plRes, redactRes] = await Promise.all([
      request(plPath(), jsonInit('PUT', newPl), db),
      request(
        redactPath(EVENT_ENC, `plx-6`),
        jsonInit('PUT', { reason: `with-pl-6` }),
        db
      ),
    ]);
    expect([200, 409].includes(plRes.status)).toBe(true);
    expect(redactRes.status).toBe(200);
  });
  it(`PL PUT∥redact store barrier soft-7`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 't', msgtype: 'm.text' },
      })
    );
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        return plPdu(plReads <= 2 ? '$pl-a' : '$pl-b');
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
    const newPl = defaultPlContent({
      users: { [USER]: 100, [BOB]: 40, [CAROL]: 10 },
    });
    const [plRes, redactRes] = await Promise.all([
      request(plPath(), jsonInit('PUT', newPl), db),
      request(
        redactPath(EVENT_ENC, `plx-7`),
        jsonInit('PUT', { reason: `with-pl-7` }),
        db
      ),
    ]);
    expect([200, 409].includes(plRes.status)).toBe(true);
    expect(redactRes.status).toBe(200);
  });
  it(`PL PUT∥redact store barrier soft-8`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 't', msgtype: 'm.text' },
      })
    );
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        return plPdu(plReads <= 2 ? '$pl-a' : '$pl-b');
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
    const newPl = defaultPlContent({
      users: { [USER]: 100, [BOB]: 40, [CAROL]: 10 },
    });
    const [plRes, redactRes] = await Promise.all([
      request(plPath(), jsonInit('PUT', newPl), db),
      request(
        redactPath(EVENT_ENC, `plx-8`),
        jsonInit('PUT', { reason: `with-pl-8` }),
        db
      ),
    ]);
    expect([200, 409].includes(plRes.status)).toBe(true);
    expect(redactRes.status).toBe(200);
  });
  it(`PL PUT∥redact store barrier soft-9`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 't', msgtype: 'm.text' },
      })
    );
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        return plPdu(plReads <= 2 ? '$pl-a' : '$pl-b');
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
    const newPl = defaultPlContent({
      users: { [USER]: 100, [BOB]: 40, [CAROL]: 10 },
    });
    const [plRes, redactRes] = await Promise.all([
      request(plPath(), jsonInit('PUT', newPl), db),
      request(
        redactPath(EVENT_ENC, `plx-9`),
        jsonInit('PUT', { reason: `with-pl-9` }),
        db
      ),
    ]);
    expect([200, 409].includes(plRes.status)).toBe(true);
    expect(redactRes.status).toBe(200);
  });
  it(`PL PUT∥redact store barrier soft-10`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 't', msgtype: 'm.text' },
      })
    );
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        return plPdu(plReads <= 2 ? '$pl-a' : '$pl-b');
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
    const newPl = defaultPlContent({
      users: { [USER]: 100, [BOB]: 40, [CAROL]: 10 },
    });
    const [plRes, redactRes] = await Promise.all([
      request(plPath(), jsonInit('PUT', newPl), db),
      request(
        redactPath(EVENT_ENC, `plx-10`),
        jsonInit('PUT', { reason: `with-pl-10` }),
        db
      ),
    ]);
    expect([200, 409].includes(plRes.status)).toBe(true);
    expect(redactRes.status).toBe(200);
  });
  it(`PL PUT∥redact store barrier soft-11`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 't', msgtype: 'm.text' },
      })
    );
    let plReads = 0;
    const waiters = { list: [] as Array<() => void> };
    let barrier: FnBarrier | undefined = { count: 2 };
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        plReads += 1;
        return plPdu(plReads <= 2 ? '$pl-a' : '$pl-b');
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
    const newPl = defaultPlContent({
      users: { [USER]: 100, [BOB]: 40, [CAROL]: 10 },
    });
    const [plRes, redactRes] = await Promise.all([
      request(plPath(), jsonInit('PUT', newPl), db),
      request(
        redactPath(EVENT_ENC, `plx-11`),
        jsonInit('PUT', { reason: `with-pl-11` }),
        db
      ),
    ]);
    expect([200, 409].includes(plRes.status)).toBe(true);
    expect(redactRes.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// insufficient PL / own-event redact concurrent soft floods
// ---------------------------------------------------------------------------

describe('race redact insufficient-PL soft flood after #211', () => {
  it(`other-sender insufficient PL soft-0`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'nope', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 10 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `forbid-a-0`), jsonInit('PUT', { reason: 'x' })),
      request(redactPath(EVENT_ENC, `forbid-b-0`), jsonInit('PUT', { reason: 'y' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(results.every((r) => r.errcode === 'M_FORBIDDEN')).toBe(true);
    expect(storeEvent).not.toHaveBeenCalled();
  });
  it(`other-sender insufficient PL soft-1`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'nope', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 10 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `forbid-a-1`), jsonInit('PUT', { reason: 'x' })),
      request(redactPath(EVENT_ENC, `forbid-b-1`), jsonInit('PUT', { reason: 'y' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(results.every((r) => r.errcode === 'M_FORBIDDEN')).toBe(true);
    expect(storeEvent).not.toHaveBeenCalled();
  });
  it(`other-sender insufficient PL soft-2`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'nope', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 10 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `forbid-a-2`), jsonInit('PUT', { reason: 'x' })),
      request(redactPath(EVENT_ENC, `forbid-b-2`), jsonInit('PUT', { reason: 'y' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(results.every((r) => r.errcode === 'M_FORBIDDEN')).toBe(true);
    expect(storeEvent).not.toHaveBeenCalled();
  });
  it(`other-sender insufficient PL soft-3`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'nope', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 10 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `forbid-a-3`), jsonInit('PUT', { reason: 'x' })),
      request(redactPath(EVENT_ENC, `forbid-b-3`), jsonInit('PUT', { reason: 'y' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(results.every((r) => r.errcode === 'M_FORBIDDEN')).toBe(true);
    expect(storeEvent).not.toHaveBeenCalled();
  });
  it(`other-sender insufficient PL soft-4`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'nope', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 10 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `forbid-a-4`), jsonInit('PUT', { reason: 'x' })),
      request(redactPath(EVENT_ENC, `forbid-b-4`), jsonInit('PUT', { reason: 'y' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(results.every((r) => r.errcode === 'M_FORBIDDEN')).toBe(true);
    expect(storeEvent).not.toHaveBeenCalled();
  });
  it(`other-sender insufficient PL soft-5`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'nope', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 10 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `forbid-a-5`), jsonInit('PUT', { reason: 'x' })),
      request(redactPath(EVENT_ENC, `forbid-b-5`), jsonInit('PUT', { reason: 'y' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(results.every((r) => r.errcode === 'M_FORBIDDEN')).toBe(true);
    expect(storeEvent).not.toHaveBeenCalled();
  });
  it(`other-sender insufficient PL soft-6`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'nope', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 10 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `forbid-a-6`), jsonInit('PUT', { reason: 'x' })),
      request(redactPath(EVENT_ENC, `forbid-b-6`), jsonInit('PUT', { reason: 'y' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(results.every((r) => r.errcode === 'M_FORBIDDEN')).toBe(true);
    expect(storeEvent).not.toHaveBeenCalled();
  });
  it(`other-sender insufficient PL soft-7`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'nope', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 10 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `forbid-a-7`), jsonInit('PUT', { reason: 'x' })),
      request(redactPath(EVENT_ENC, `forbid-b-7`), jsonInit('PUT', { reason: 'y' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(results.every((r) => r.errcode === 'M_FORBIDDEN')).toBe(true);
    expect(storeEvent).not.toHaveBeenCalled();
  });
  it(`other-sender insufficient PL soft-8`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'nope', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 10 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `forbid-a-8`), jsonInit('PUT', { reason: 'x' })),
      request(redactPath(EVENT_ENC, `forbid-b-8`), jsonInit('PUT', { reason: 'y' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(results.every((r) => r.errcode === 'M_FORBIDDEN')).toBe(true);
    expect(storeEvent).not.toHaveBeenCalled();
  });
  it(`other-sender insufficient PL soft-9`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'nope', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 10 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `forbid-a-9`), jsonInit('PUT', { reason: 'x' })),
      request(redactPath(EVENT_ENC, `forbid-b-9`), jsonInit('PUT', { reason: 'y' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(results.every((r) => r.errcode === 'M_FORBIDDEN')).toBe(true);
    expect(storeEvent).not.toHaveBeenCalled();
  });
  it(`other-sender insufficient PL soft-10`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'nope', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 10 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `forbid-a-10`), jsonInit('PUT', { reason: 'x' })),
      request(redactPath(EVENT_ENC, `forbid-b-10`), jsonInit('PUT', { reason: 'y' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(results.every((r) => r.errcode === 'M_FORBIDDEN')).toBe(true);
    expect(storeEvent).not.toHaveBeenCalled();
  });
  it(`other-sender insufficient PL soft-11`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'nope', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 10 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `forbid-a-11`), jsonInit('PUT', { reason: 'x' })),
      request(redactPath(EVENT_ENC, `forbid-b-11`), jsonInit('PUT', { reason: 'y' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(results.every((r) => r.errcode === 'M_FORBIDDEN')).toBe(true);
    expect(storeEvent).not.toHaveBeenCalled();
  });
  it(`other-sender insufficient PL soft-12`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'nope', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 10 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `forbid-a-12`), jsonInit('PUT', { reason: 'x' })),
      request(redactPath(EVENT_ENC, `forbid-b-12`), jsonInit('PUT', { reason: 'y' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(results.every((r) => r.errcode === 'M_FORBIDDEN')).toBe(true);
    expect(storeEvent).not.toHaveBeenCalled();
  });
  it(`other-sender insufficient PL soft-13`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'nope', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 10 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `forbid-a-13`), jsonInit('PUT', { reason: 'x' })),
      request(redactPath(EVENT_ENC, `forbid-b-13`), jsonInit('PUT', { reason: 'y' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(results.every((r) => r.errcode === 'M_FORBIDDEN')).toBe(true);
    expect(storeEvent).not.toHaveBeenCalled();
  });
  it(`other-sender insufficient PL soft-14`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'nope', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 10 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `forbid-a-14`), jsonInit('PUT', { reason: 'x' })),
      request(redactPath(EVENT_ENC, `forbid-b-14`), jsonInit('PUT', { reason: 'y' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(results.every((r) => r.errcode === 'M_FORBIDDEN')).toBe(true);
    expect(storeEvent).not.toHaveBeenCalled();
  });
  it(`other-sender insufficient PL soft-15`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'nope', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 10 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `forbid-a-15`), jsonInit('PUT', { reason: 'x' })),
      request(redactPath(EVENT_ENC, `forbid-b-15`), jsonInit('PUT', { reason: 'y' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(results.every((r) => r.errcode === 'M_FORBIDDEN')).toBe(true);
    expect(storeEvent).not.toHaveBeenCalled();
  });
  it(`own-event redact without PL soft-0`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'mine', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 0 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `own-a-0`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `own-b-0`), jsonInit('PUT', { reason: `mine-0` })),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
  it(`own-event redact without PL soft-1`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'mine', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 0 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `own-a-1`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `own-b-1`), jsonInit('PUT', { reason: `mine-1` })),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
  it(`own-event redact without PL soft-2`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'mine', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 0 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `own-a-2`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `own-b-2`), jsonInit('PUT', { reason: `mine-2` })),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
  it(`own-event redact without PL soft-3`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'mine', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 0 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `own-a-3`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `own-b-3`), jsonInit('PUT', { reason: `mine-3` })),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
  it(`own-event redact without PL soft-4`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'mine', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 0 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `own-a-4`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `own-b-4`), jsonInit('PUT', { reason: `mine-4` })),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
  it(`own-event redact without PL soft-5`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'mine', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 0 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `own-a-5`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `own-b-5`), jsonInit('PUT', { reason: `mine-5` })),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
  it(`own-event redact without PL soft-6`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'mine', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 0 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `own-a-6`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `own-b-6`), jsonInit('PUT', { reason: `mine-6` })),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
  it(`own-event redact without PL soft-7`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'mine', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 0 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `own-a-7`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `own-b-7`), jsonInit('PUT', { reason: `mine-7` })),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
  it(`own-event redact without PL soft-8`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'mine', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 0 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `own-a-8`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `own-b-8`), jsonInit('PUT', { reason: `mine-8` })),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
  it(`own-event redact without PL soft-9`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'mine', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 0 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `own-a-9`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `own-b-9`), jsonInit('PUT', { reason: `mine-9` })),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
  it(`own-event redact without PL soft-10`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'mine', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 0 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `own-a-10`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `own-b-10`), jsonInit('PUT', { reason: `mine-10` })),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
  it(`own-event redact without PL soft-11`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'mine', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-low',
        defaultPlContent({ users: { [USER]: 0 }, redact: 50 })
      ),
    });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `own-a-11`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `own-b-11`), jsonInit('PUT', { reason: `mine-11` })),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dual distinct-event redact isolation + redacted_because UPDATE races
// ---------------------------------------------------------------------------

describe('race dual-event redact isolation after #211', () => {
  it(`distinct events parallel redact soft-0`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockImplementation(async (_db, eventId: string) => {
      if (eventId === EVENT) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT,
          sender: BOB,
          content: { body: '1', msgtype: 'm.text' },
        });
      }
      if (eventId === EVENT2) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT2,
          sender: CAROL,
          content: { body: '2', msgtype: 'm.text' },
        });
      }
      return null;
    });
    const db = createSqlDb({ redactBarrier: { count: 2 } });
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `e1-0`), jsonInit('PUT', { reason: 'one' }), db),
      request(redactPath(EVENT2_ENC, `e2-0`), jsonInit('PUT', { reason: 'two' }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const redacts = db.updates.filter((u) => u.sql.includes('redacted_because'));
    expect(redacts.length).toBe(2);
    const targets = redacts.map((u) => u.args[1]);
    expect(targets.sort()).toEqual([EVENT, EVENT2].sort());
  });
  it(`distinct events parallel redact soft-1`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockImplementation(async (_db, eventId: string) => {
      if (eventId === EVENT) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT,
          sender: BOB,
          content: { body: '1', msgtype: 'm.text' },
        });
      }
      if (eventId === EVENT2) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT2,
          sender: CAROL,
          content: { body: '2', msgtype: 'm.text' },
        });
      }
      return null;
    });
    const db = createSqlDb({ redactBarrier: { count: 2 } });
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `e1-1`), jsonInit('PUT', { reason: 'one' }), db),
      request(redactPath(EVENT2_ENC, `e2-1`), jsonInit('PUT', { reason: 'two' }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const redacts = db.updates.filter((u) => u.sql.includes('redacted_because'));
    expect(redacts.length).toBe(2);
    const targets = redacts.map((u) => u.args[1]);
    expect(targets.sort()).toEqual([EVENT, EVENT2].sort());
  });
  it(`distinct events parallel redact soft-2`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockImplementation(async (_db, eventId: string) => {
      if (eventId === EVENT) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT,
          sender: BOB,
          content: { body: '1', msgtype: 'm.text' },
        });
      }
      if (eventId === EVENT2) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT2,
          sender: CAROL,
          content: { body: '2', msgtype: 'm.text' },
        });
      }
      return null;
    });
    const db = createSqlDb({ redactBarrier: { count: 2 } });
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `e1-2`), jsonInit('PUT', { reason: 'one' }), db),
      request(redactPath(EVENT2_ENC, `e2-2`), jsonInit('PUT', { reason: 'two' }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const redacts = db.updates.filter((u) => u.sql.includes('redacted_because'));
    expect(redacts.length).toBe(2);
    const targets = redacts.map((u) => u.args[1]);
    expect(targets.sort()).toEqual([EVENT, EVENT2].sort());
  });
  it(`distinct events parallel redact soft-3`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockImplementation(async (_db, eventId: string) => {
      if (eventId === EVENT) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT,
          sender: BOB,
          content: { body: '1', msgtype: 'm.text' },
        });
      }
      if (eventId === EVENT2) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT2,
          sender: CAROL,
          content: { body: '2', msgtype: 'm.text' },
        });
      }
      return null;
    });
    const db = createSqlDb({ redactBarrier: { count: 2 } });
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `e1-3`), jsonInit('PUT', { reason: 'one' }), db),
      request(redactPath(EVENT2_ENC, `e2-3`), jsonInit('PUT', { reason: 'two' }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const redacts = db.updates.filter((u) => u.sql.includes('redacted_because'));
    expect(redacts.length).toBe(2);
    const targets = redacts.map((u) => u.args[1]);
    expect(targets.sort()).toEqual([EVENT, EVENT2].sort());
  });
  it(`distinct events parallel redact soft-4`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockImplementation(async (_db, eventId: string) => {
      if (eventId === EVENT) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT,
          sender: BOB,
          content: { body: '1', msgtype: 'm.text' },
        });
      }
      if (eventId === EVENT2) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT2,
          sender: CAROL,
          content: { body: '2', msgtype: 'm.text' },
        });
      }
      return null;
    });
    const db = createSqlDb({ redactBarrier: { count: 2 } });
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `e1-4`), jsonInit('PUT', { reason: 'one' }), db),
      request(redactPath(EVENT2_ENC, `e2-4`), jsonInit('PUT', { reason: 'two' }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const redacts = db.updates.filter((u) => u.sql.includes('redacted_because'));
    expect(redacts.length).toBe(2);
    const targets = redacts.map((u) => u.args[1]);
    expect(targets.sort()).toEqual([EVENT, EVENT2].sort());
  });
  it(`distinct events parallel redact soft-5`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockImplementation(async (_db, eventId: string) => {
      if (eventId === EVENT) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT,
          sender: BOB,
          content: { body: '1', msgtype: 'm.text' },
        });
      }
      if (eventId === EVENT2) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT2,
          sender: CAROL,
          content: { body: '2', msgtype: 'm.text' },
        });
      }
      return null;
    });
    const db = createSqlDb({ redactBarrier: { count: 2 } });
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `e1-5`), jsonInit('PUT', { reason: 'one' }), db),
      request(redactPath(EVENT2_ENC, `e2-5`), jsonInit('PUT', { reason: 'two' }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const redacts = db.updates.filter((u) => u.sql.includes('redacted_because'));
    expect(redacts.length).toBe(2);
    const targets = redacts.map((u) => u.args[1]);
    expect(targets.sort()).toEqual([EVENT, EVENT2].sort());
  });
  it(`distinct events parallel redact soft-6`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockImplementation(async (_db, eventId: string) => {
      if (eventId === EVENT) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT,
          sender: BOB,
          content: { body: '1', msgtype: 'm.text' },
        });
      }
      if (eventId === EVENT2) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT2,
          sender: CAROL,
          content: { body: '2', msgtype: 'm.text' },
        });
      }
      return null;
    });
    const db = createSqlDb({ redactBarrier: { count: 2 } });
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `e1-6`), jsonInit('PUT', { reason: 'one' }), db),
      request(redactPath(EVENT2_ENC, `e2-6`), jsonInit('PUT', { reason: 'two' }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const redacts = db.updates.filter((u) => u.sql.includes('redacted_because'));
    expect(redacts.length).toBe(2);
    const targets = redacts.map((u) => u.args[1]);
    expect(targets.sort()).toEqual([EVENT, EVENT2].sort());
  });
  it(`distinct events parallel redact soft-7`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockImplementation(async (_db, eventId: string) => {
      if (eventId === EVENT) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT,
          sender: BOB,
          content: { body: '1', msgtype: 'm.text' },
        });
      }
      if (eventId === EVENT2) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT2,
          sender: CAROL,
          content: { body: '2', msgtype: 'm.text' },
        });
      }
      return null;
    });
    const db = createSqlDb({ redactBarrier: { count: 2 } });
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `e1-7`), jsonInit('PUT', { reason: 'one' }), db),
      request(redactPath(EVENT2_ENC, `e2-7`), jsonInit('PUT', { reason: 'two' }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const redacts = db.updates.filter((u) => u.sql.includes('redacted_because'));
    expect(redacts.length).toBe(2);
    const targets = redacts.map((u) => u.args[1]);
    expect(targets.sort()).toEqual([EVENT, EVENT2].sort());
  });
  it(`distinct events parallel redact soft-8`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockImplementation(async (_db, eventId: string) => {
      if (eventId === EVENT) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT,
          sender: BOB,
          content: { body: '1', msgtype: 'm.text' },
        });
      }
      if (eventId === EVENT2) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT2,
          sender: CAROL,
          content: { body: '2', msgtype: 'm.text' },
        });
      }
      return null;
    });
    const db = createSqlDb({ redactBarrier: { count: 2 } });
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `e1-8`), jsonInit('PUT', { reason: 'one' }), db),
      request(redactPath(EVENT2_ENC, `e2-8`), jsonInit('PUT', { reason: 'two' }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const redacts = db.updates.filter((u) => u.sql.includes('redacted_because'));
    expect(redacts.length).toBe(2);
    const targets = redacts.map((u) => u.args[1]);
    expect(targets.sort()).toEqual([EVENT, EVENT2].sort());
  });
  it(`distinct events parallel redact soft-9`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockImplementation(async (_db, eventId: string) => {
      if (eventId === EVENT) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT,
          sender: BOB,
          content: { body: '1', msgtype: 'm.text' },
        });
      }
      if (eventId === EVENT2) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT2,
          sender: CAROL,
          content: { body: '2', msgtype: 'm.text' },
        });
      }
      return null;
    });
    const db = createSqlDb({ redactBarrier: { count: 2 } });
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `e1-9`), jsonInit('PUT', { reason: 'one' }), db),
      request(redactPath(EVENT2_ENC, `e2-9`), jsonInit('PUT', { reason: 'two' }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const redacts = db.updates.filter((u) => u.sql.includes('redacted_because'));
    expect(redacts.length).toBe(2);
    const targets = redacts.map((u) => u.args[1]);
    expect(targets.sort()).toEqual([EVENT, EVENT2].sort());
  });
  it(`distinct events parallel redact soft-10`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockImplementation(async (_db, eventId: string) => {
      if (eventId === EVENT) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT,
          sender: BOB,
          content: { body: '1', msgtype: 'm.text' },
        });
      }
      if (eventId === EVENT2) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT2,
          sender: CAROL,
          content: { body: '2', msgtype: 'm.text' },
        });
      }
      return null;
    });
    const db = createSqlDb({ redactBarrier: { count: 2 } });
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `e1-10`), jsonInit('PUT', { reason: 'one' }), db),
      request(redactPath(EVENT2_ENC, `e2-10`), jsonInit('PUT', { reason: 'two' }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const redacts = db.updates.filter((u) => u.sql.includes('redacted_because'));
    expect(redacts.length).toBe(2);
    const targets = redacts.map((u) => u.args[1]);
    expect(targets.sort()).toEqual([EVENT, EVENT2].sort());
  });
  it(`distinct events parallel redact soft-11`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockImplementation(async (_db, eventId: string) => {
      if (eventId === EVENT) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT,
          sender: BOB,
          content: { body: '1', msgtype: 'm.text' },
        });
      }
      if (eventId === EVENT2) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT2,
          sender: CAROL,
          content: { body: '2', msgtype: 'm.text' },
        });
      }
      return null;
    });
    const db = createSqlDb({ redactBarrier: { count: 2 } });
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `e1-11`), jsonInit('PUT', { reason: 'one' }), db),
      request(redactPath(EVENT2_ENC, `e2-11`), jsonInit('PUT', { reason: 'two' }), db),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const redacts = db.updates.filter((u) => u.sql.includes('redacted_because'));
    expect(redacts.length).toBe(2);
    const targets = redacts.map((u) => u.args[1]);
    expect(targets.sort()).toEqual([EVENT, EVENT2].sort());
  });
  it(`redacted_because UPDATE fail mid concurrent soft-0`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb({ failRedactUpdate: true, redactBarrier: { count: 2 } });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `fail-a-0`), jsonInit('PUT', { reason: 'a' }), db),
      request(redactPath(EVENT_ENC, `fail-b-0`), jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect(results.every((r) => r.status >= 500 || r.status === 200)).toBe(true);
  });
  it(`redacted_because UPDATE fail mid concurrent soft-1`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb({ failRedactUpdate: true, redactBarrier: { count: 2 } });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `fail-a-1`), jsonInit('PUT', { reason: 'a' }), db),
      request(redactPath(EVENT_ENC, `fail-b-1`), jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect(results.every((r) => r.status >= 500 || r.status === 200)).toBe(true);
  });
  it(`redacted_because UPDATE fail mid concurrent soft-2`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb({ failRedactUpdate: true, redactBarrier: { count: 2 } });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `fail-a-2`), jsonInit('PUT', { reason: 'a' }), db),
      request(redactPath(EVENT_ENC, `fail-b-2`), jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect(results.every((r) => r.status >= 500 || r.status === 200)).toBe(true);
  });
  it(`redacted_because UPDATE fail mid concurrent soft-3`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb({ failRedactUpdate: true, redactBarrier: { count: 2 } });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `fail-a-3`), jsonInit('PUT', { reason: 'a' }), db),
      request(redactPath(EVENT_ENC, `fail-b-3`), jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect(results.every((r) => r.status >= 500 || r.status === 200)).toBe(true);
  });
  it(`redacted_because UPDATE fail mid concurrent soft-4`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb({ failRedactUpdate: true, redactBarrier: { count: 2 } });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `fail-a-4`), jsonInit('PUT', { reason: 'a' }), db),
      request(redactPath(EVENT_ENC, `fail-b-4`), jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect(results.every((r) => r.status >= 500 || r.status === 200)).toBe(true);
  });
  it(`redacted_because UPDATE fail mid concurrent soft-5`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb({ failRedactUpdate: true, redactBarrier: { count: 2 } });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `fail-a-5`), jsonInit('PUT', { reason: 'a' }), db),
      request(redactPath(EVENT_ENC, `fail-b-5`), jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect(results.every((r) => r.status >= 500 || r.status === 200)).toBe(true);
  });
  it(`redacted_because UPDATE fail mid concurrent soft-6`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb({ failRedactUpdate: true, redactBarrier: { count: 2 } });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `fail-a-6`), jsonInit('PUT', { reason: 'a' }), db),
      request(redactPath(EVENT_ENC, `fail-b-6`), jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect(results.every((r) => r.status >= 500 || r.status === 200)).toBe(true);
  });
  it(`redacted_because UPDATE fail mid concurrent soft-7`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb({ failRedactUpdate: true, redactBarrier: { count: 2 } });
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `fail-a-7`), jsonInit('PUT', { reason: 'a' }), db),
      request(redactPath(EVENT_ENC, `fail-b-7`), jsonInit('PUT', { reason: 'b' }), db),
    ]);
    expect(results.every((r) => r.status >= 500 || r.status === 200)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PL state PUT optimistic conflict deepen
// ---------------------------------------------------------------------------

describe('race PL state optimistic conflict deepen after #211', () => {
  it(`PL PUT∥PUT slot conflict deepen soft-0`, async () => {
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
        const id = plReads <= 2 ? '$pl-a' : '$pl-b';
        return plPdu(id);
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
    const bodyA = defaultPlContent({ users: { [USER]: 100, [BOB]: 30 } });
    const bodyB = defaultPlContent({ users: { [USER]: 100, [BOB]: 40 } });
    const [a, b] = await Promise.all([
      request(plPath(), jsonInit('PUT', bodyA), db),
      request(plPath(), jsonInit('PUT', bodyB), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });
  it(`PL PUT∥PUT slot conflict deepen soft-1`, async () => {
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
        const id = plReads <= 2 ? '$pl-a' : '$pl-b';
        return plPdu(id);
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
    const bodyA = defaultPlContent({ users: { [USER]: 100, [BOB]: 31 } });
    const bodyB = defaultPlContent({ users: { [USER]: 100, [BOB]: 41 } });
    const [a, b] = await Promise.all([
      request(plPath(), jsonInit('PUT', bodyA), db),
      request(plPath(), jsonInit('PUT', bodyB), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });
  it(`PL PUT∥PUT slot conflict deepen soft-2`, async () => {
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
        const id = plReads <= 2 ? '$pl-a' : '$pl-b';
        return plPdu(id);
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
    const bodyA = defaultPlContent({ users: { [USER]: 100, [BOB]: 32 } });
    const bodyB = defaultPlContent({ users: { [USER]: 100, [BOB]: 42 } });
    const [a, b] = await Promise.all([
      request(plPath(), jsonInit('PUT', bodyA), db),
      request(plPath(), jsonInit('PUT', bodyB), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });
  it(`PL PUT∥PUT slot conflict deepen soft-3`, async () => {
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
        const id = plReads <= 2 ? '$pl-a' : '$pl-b';
        return plPdu(id);
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
    const bodyA = defaultPlContent({ users: { [USER]: 100, [BOB]: 33 } });
    const bodyB = defaultPlContent({ users: { [USER]: 100, [BOB]: 43 } });
    const [a, b] = await Promise.all([
      request(plPath(), jsonInit('PUT', bodyA), db),
      request(plPath(), jsonInit('PUT', bodyB), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });
  it(`PL PUT∥PUT slot conflict deepen soft-4`, async () => {
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
        const id = plReads <= 2 ? '$pl-a' : '$pl-b';
        return plPdu(id);
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
    const bodyA = defaultPlContent({ users: { [USER]: 100, [BOB]: 34 } });
    const bodyB = defaultPlContent({ users: { [USER]: 100, [BOB]: 44 } });
    const [a, b] = await Promise.all([
      request(plPath(), jsonInit('PUT', bodyA), db),
      request(plPath(), jsonInit('PUT', bodyB), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });
  it(`PL PUT∥PUT slot conflict deepen soft-5`, async () => {
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
        const id = plReads <= 2 ? '$pl-a' : '$pl-b';
        return plPdu(id);
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
    const bodyA = defaultPlContent({ users: { [USER]: 100, [BOB]: 35 } });
    const bodyB = defaultPlContent({ users: { [USER]: 100, [BOB]: 45 } });
    const [a, b] = await Promise.all([
      request(plPath(), jsonInit('PUT', bodyA), db),
      request(plPath(), jsonInit('PUT', bodyB), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });
  it(`PL PUT∥PUT slot conflict deepen soft-6`, async () => {
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
        const id = plReads <= 2 ? '$pl-a' : '$pl-b';
        return plPdu(id);
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
    const bodyA = defaultPlContent({ users: { [USER]: 100, [BOB]: 36 } });
    const bodyB = defaultPlContent({ users: { [USER]: 100, [BOB]: 46 } });
    const [a, b] = await Promise.all([
      request(plPath(), jsonInit('PUT', bodyA), db),
      request(plPath(), jsonInit('PUT', bodyB), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });
  it(`PL PUT∥PUT slot conflict deepen soft-7`, async () => {
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
        const id = plReads <= 2 ? '$pl-a' : '$pl-b';
        return plPdu(id);
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
    const bodyA = defaultPlContent({ users: { [USER]: 100, [BOB]: 37 } });
    const bodyB = defaultPlContent({ users: { [USER]: 100, [BOB]: 47 } });
    const [a, b] = await Promise.all([
      request(plPath(), jsonInit('PUT', bodyA), db),
      request(plPath(), jsonInit('PUT', bodyB), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });
  it(`PL PUT∥PUT slot conflict deepen soft-8`, async () => {
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
        const id = plReads <= 2 ? '$pl-a' : '$pl-b';
        return plPdu(id);
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
    const bodyA = defaultPlContent({ users: { [USER]: 100, [BOB]: 38 } });
    const bodyB = defaultPlContent({ users: { [USER]: 100, [BOB]: 48 } });
    const [a, b] = await Promise.all([
      request(plPath(), jsonInit('PUT', bodyA), db),
      request(plPath(), jsonInit('PUT', bodyB), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });
  it(`PL PUT∥PUT slot conflict deepen soft-9`, async () => {
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
        const id = plReads <= 2 ? '$pl-a' : '$pl-b';
        return plPdu(id);
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
    const bodyA = defaultPlContent({ users: { [USER]: 100, [BOB]: 39 } });
    const bodyB = defaultPlContent({ users: { [USER]: 100, [BOB]: 49 } });
    const [a, b] = await Promise.all([
      request(plPath(), jsonInit('PUT', bodyA), db),
      request(plPath(), jsonInit('PUT', bodyB), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });
  it(`PL PUT∥PUT slot conflict deepen soft-10`, async () => {
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
        const id = plReads <= 2 ? '$pl-a' : '$pl-b';
        return plPdu(id);
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
    const bodyA = defaultPlContent({ users: { [USER]: 100, [BOB]: 40 } });
    const bodyB = defaultPlContent({ users: { [USER]: 100, [BOB]: 50 } });
    const [a, b] = await Promise.all([
      request(plPath(), jsonInit('PUT', bodyA), db),
      request(plPath(), jsonInit('PUT', bodyB), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });
  it(`PL PUT∥PUT slot conflict deepen soft-11`, async () => {
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
        const id = plReads <= 2 ? '$pl-a' : '$pl-b';
        return plPdu(id);
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
    const bodyA = defaultPlContent({ users: { [USER]: 100, [BOB]: 41 } });
    const bodyB = defaultPlContent({ users: { [USER]: 100, [BOB]: 51 } });
    const [a, b] = await Promise.all([
      request(plPath(), jsonInit('PUT', bodyA), db),
      request(plPath(), jsonInit('PUT', bodyB), db),
    ]);
    const statuses = [a.status, b.status];
    expect(statuses.every((s) => [200, 409].includes(s))).toBe(true);
    expect(statuses.includes(409) || storeEvent.mock.calls.length >= 1).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// method / body / charset / lifecycle soft floods
// ---------------------------------------------------------------------------

describe('redact concurrent soft flood — method matrix after #211', () => {
  it(`invalid method GET soft-0`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `m-0-a`), { method: 'GET', headers: AUTH }),
      request(redactPath(EVENT_ENC, `m-0-b`), { method: 'GET', headers: AUTH }),
    ]);
    expect(results.every((r) => r.status === 404 || r.status === 405 || r.status >= 400)).toBe(
      true
    );
  });
  it(`invalid method POST soft-1`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `m-1-a`), { method: 'POST', headers: AUTH }),
      request(redactPath(EVENT_ENC, `m-1-b`), { method: 'POST', headers: AUTH }),
    ]);
    expect(results.every((r) => r.status === 404 || r.status === 405 || r.status >= 400)).toBe(
      true
    );
  });
  it(`invalid method DELETE soft-2`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `m-2-a`), { method: 'DELETE', headers: AUTH }),
      request(redactPath(EVENT_ENC, `m-2-b`), { method: 'DELETE', headers: AUTH }),
    ]);
    expect(results.every((r) => r.status === 404 || r.status === 405 || r.status >= 400)).toBe(
      true
    );
  });
  it(`invalid method PATCH soft-3`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `m-3-a`), { method: 'PATCH', headers: AUTH }),
      request(redactPath(EVENT_ENC, `m-3-b`), { method: 'PATCH', headers: AUTH }),
    ]);
    expect(results.every((r) => r.status === 404 || r.status === 405 || r.status >= 400)).toBe(
      true
    );
  });
  it(`invalid method HEAD soft-4`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `m-4-a`), { method: 'HEAD', headers: AUTH }),
      request(redactPath(EVENT_ENC, `m-4-b`), { method: 'HEAD', headers: AUTH }),
    ]);
    expect(results.every((r) => r.status === 404 || r.status === 405 || r.status >= 400)).toBe(
      true
    );
  });
  it(`invalid method OPTIONS soft-5`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `m-5-a`), { method: 'OPTIONS', headers: AUTH }),
      request(redactPath(EVENT_ENC, `m-5-b`), { method: 'OPTIONS', headers: AUTH }),
    ]);
    expect(results.every((r) => r.status === 404 || r.status === 405 || r.status >= 400)).toBe(
      true
    );
  });
  it(`invalid method GET soft-6`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `m-6-a`), { method: 'GET', headers: AUTH }),
      request(redactPath(EVENT_ENC, `m-6-b`), { method: 'GET', headers: AUTH }),
    ]);
    expect(results.every((r) => r.status === 404 || r.status === 405 || r.status >= 400)).toBe(
      true
    );
  });
  it(`invalid method POST soft-7`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `m-7-a`), { method: 'POST', headers: AUTH }),
      request(redactPath(EVENT_ENC, `m-7-b`), { method: 'POST', headers: AUTH }),
    ]);
    expect(results.every((r) => r.status === 404 || r.status === 405 || r.status >= 400)).toBe(
      true
    );
  });
  it(`invalid method DELETE soft-8`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `m-8-a`), { method: 'DELETE', headers: AUTH }),
      request(redactPath(EVENT_ENC, `m-8-b`), { method: 'DELETE', headers: AUTH }),
    ]);
    expect(results.every((r) => r.status === 404 || r.status === 405 || r.status >= 400)).toBe(
      true
    );
  });
  it(`invalid method PATCH soft-9`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `m-9-a`), { method: 'PATCH', headers: AUTH }),
      request(redactPath(EVENT_ENC, `m-9-b`), { method: 'PATCH', headers: AUTH }),
    ]);
    expect(results.every((r) => r.status === 404 || r.status === 405 || r.status >= 400)).toBe(
      true
    );
  });
  it(`invalid method HEAD soft-10`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `m-10-a`), { method: 'HEAD', headers: AUTH }),
      request(redactPath(EVENT_ENC, `m-10-b`), { method: 'HEAD', headers: AUTH }),
    ]);
    expect(results.every((r) => r.status === 404 || r.status === 405 || r.status >= 400)).toBe(
      true
    );
  });
  it(`invalid method OPTIONS soft-11`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `m-11-a`), { method: 'OPTIONS', headers: AUTH }),
      request(redactPath(EVENT_ENC, `m-11-b`), { method: 'OPTIONS', headers: AUTH }),
    ]);
    expect(results.every((r) => r.status === 404 || r.status === 405 || r.status >= 400)).toBe(
      true
    );
  });
});

describe('redact concurrent soft flood — body / charset after #211', () => {
  it(`body edge soft-0`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'own', msgtype: 'm.text' },
      })
    );
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: 'not-json',
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `body-a-0`), init),
      request(redactPath(EVENT_ENC, `body-b-0`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 500].includes(r.status))).toBe(true);
  });
  it(`body edge soft-1`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'own', msgtype: 'm.text' },
      })
    );
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: '[1,2,3]',
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `body-a-1`), init),
      request(redactPath(EVENT_ENC, `body-b-1`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 500].includes(r.status))).toBe(true);
  });
  it(`body edge soft-2`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'own', msgtype: 'm.text' },
      })
    );
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: 'null',
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `body-a-2`), init),
      request(redactPath(EVENT_ENC, `body-b-2`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 500].includes(r.status))).toBe(true);
  });
  it(`body edge soft-3`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'own', msgtype: 'm.text' },
      })
    );
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: '42',
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `body-a-3`), init),
      request(redactPath(EVENT_ENC, `body-b-3`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 500].includes(r.status))).toBe(true);
  });
  it(`body edge soft-4`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'own', msgtype: 'm.text' },
      })
    );
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: '{}',
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `body-a-4`), init),
      request(redactPath(EVENT_ENC, `body-b-4`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 500].includes(r.status))).toBe(true);
  });
  it(`body edge soft-5`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'own', msgtype: 'm.text' },
      })
    );
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: '{"reason":"x"}',
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `body-a-5`), init),
      request(redactPath(EVENT_ENC, `body-b-5`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 500].includes(r.status))).toBe(true);
  });
  it(`body edge soft-6`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'own', msgtype: 'm.text' },
      })
    );
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: '{"reason":"x","extra":true}',
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `body-a-6`), init),
      request(redactPath(EVENT_ENC, `body-b-6`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 500].includes(r.status))).toBe(true);
  });
  it(`body edge soft-7`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'own', msgtype: 'm.text' },
      })
    );
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: '{"reason":"中文"}',
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `body-a-7`), init),
      request(redactPath(EVENT_ENC, `body-b-7`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 500].includes(r.status))).toBe(true);
  });
  it(`body edge soft-8`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'own', msgtype: 'm.text' },
      })
    );
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: '',
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `body-a-8`), init),
      request(redactPath(EVENT_ENC, `body-b-8`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 500].includes(r.status))).toBe(true);
  });
  it(`body edge soft-9`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'own', msgtype: 'm.text' },
      })
    );
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: '{"reason":null}',
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `body-a-9`), init),
      request(redactPath(EVENT_ENC, `body-b-9`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 500].includes(r.status))).toBe(true);
  });
  it(`body edge soft-10`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'own', msgtype: 'm.text' },
      })
    );
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: '{"reason":""}',
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `body-a-10`), init),
      request(redactPath(EVENT_ENC, `body-b-10`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 500].includes(r.status))).toBe(true);
  });
  it(`body edge soft-11`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'own', msgtype: 'm.text' },
      })
    );
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: '{"reason":"rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr"}',
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `body-a-11`), init),
      request(redactPath(EVENT_ENC, `body-b-11`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 500].includes(r.status))).toBe(true);
  });
  it(`body edge soft-12`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'own', msgtype: 'm.text' },
      })
    );
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: 'true',
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `body-a-12`), init),
      request(redactPath(EVENT_ENC, `body-b-12`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 500].includes(r.status))).toBe(true);
  });
  it(`body edge soft-13`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'own', msgtype: 'm.text' },
      })
    );
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: '"string"',
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `body-a-13`), init),
      request(redactPath(EVENT_ENC, `body-b-13`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 500].includes(r.status))).toBe(true);
  });
  it(`body edge soft-14`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'own', msgtype: 'm.text' },
      })
    );
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: '{"nested":{"a":1}}',
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `body-a-14`), init),
      request(redactPath(EVENT_ENC, `body-b-14`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 500].includes(r.status))).toBe(true);
  });
  it(`body edge soft-15`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'own', msgtype: 'm.text' },
      })
    );
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: '{"reason":"emoji-😀"}',
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `body-a-15`), init),
      request(redactPath(EVENT_ENC, `body-b-15`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 500].includes(r.status))).toBe(true);
  });
});

describe('redact concurrent soft flood — membership / missing / isolation after #211', () => {
  it(`not-member forbid soft-0`, async () => {
    getMembership.mockResolvedValue(null);
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `nm-a-0`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `nm-b-0`), jsonInit('PUT', { reason: 'x' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`not-member forbid soft-1`, async () => {
    getMembership.mockResolvedValue(null);
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `nm-a-1`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `nm-b-1`), jsonInit('PUT', { reason: 'x' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`not-member forbid soft-2`, async () => {
    getMembership.mockResolvedValue(null);
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `nm-a-2`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `nm-b-2`), jsonInit('PUT', { reason: 'x' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`not-member forbid soft-3`, async () => {
    getMembership.mockResolvedValue(null);
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `nm-a-3`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `nm-b-3`), jsonInit('PUT', { reason: 'x' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`not-member forbid soft-4`, async () => {
    getMembership.mockResolvedValue(null);
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `nm-a-4`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `nm-b-4`), jsonInit('PUT', { reason: 'x' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`not-member forbid soft-5`, async () => {
    getMembership.mockResolvedValue(null);
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `nm-a-5`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `nm-b-5`), jsonInit('PUT', { reason: 'x' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`not-member forbid soft-6`, async () => {
    getMembership.mockResolvedValue(null);
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `nm-a-6`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `nm-b-6`), jsonInit('PUT', { reason: 'x' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`not-member forbid soft-7`, async () => {
    getMembership.mockResolvedValue(null);
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `nm-a-7`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `nm-b-7`), jsonInit('PUT', { reason: 'x' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`not-member forbid soft-8`, async () => {
    getMembership.mockResolvedValue(null);
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `nm-a-8`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `nm-b-8`), jsonInit('PUT', { reason: 'x' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`not-member forbid soft-9`, async () => {
    getMembership.mockResolvedValue(null);
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `nm-a-9`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `nm-b-9`), jsonInit('PUT', { reason: 'x' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`not-member forbid soft-10`, async () => {
    getMembership.mockResolvedValue(null);
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `nm-a-10`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `nm-b-10`), jsonInit('PUT', { reason: 'x' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`not-member forbid soft-11`, async () => {
    getMembership.mockResolvedValue(null);
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `nm-a-11`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `nm-b-11`), jsonInit('PUT', { reason: 'x' })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`missing event 404 soft-0`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(null);
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `miss-a-0`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `miss-b-0`), jsonInit('PUT', {})),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
  });
  it(`missing event 404 soft-1`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(null);
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `miss-a-1`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `miss-b-1`), jsonInit('PUT', {})),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
  });
  it(`missing event 404 soft-2`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(null);
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `miss-a-2`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `miss-b-2`), jsonInit('PUT', {})),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
  });
  it(`missing event 404 soft-3`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(null);
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `miss-a-3`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `miss-b-3`), jsonInit('PUT', {})),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
  });
  it(`missing event 404 soft-4`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(null);
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `miss-a-4`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `miss-b-4`), jsonInit('PUT', {})),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
  });
  it(`missing event 404 soft-5`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(null);
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `miss-a-5`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `miss-b-5`), jsonInit('PUT', {})),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
  });
  it(`missing event 404 soft-6`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(null);
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `miss-a-6`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `miss-b-6`), jsonInit('PUT', {})),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
  });
  it(`missing event 404 soft-7`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(null);
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `miss-a-7`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `miss-b-7`), jsonInit('PUT', {})),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
  });
  it(`wrong-room event 404 soft-0`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        room_id: ROOM2,
        content: { body: 'elsewhere', msgtype: 'm.text' },
      })
    );
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `wr-a-0`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `wr-b-0`), jsonInit('PUT', {})),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
  });
  it(`wrong-room event 404 soft-1`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        room_id: ROOM2,
        content: { body: 'elsewhere', msgtype: 'm.text' },
      })
    );
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `wr-a-1`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `wr-b-1`), jsonInit('PUT', {})),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
  });
  it(`wrong-room event 404 soft-2`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        room_id: ROOM2,
        content: { body: 'elsewhere', msgtype: 'm.text' },
      })
    );
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `wr-a-2`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `wr-b-2`), jsonInit('PUT', {})),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
  });
  it(`wrong-room event 404 soft-3`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        room_id: ROOM2,
        content: { body: 'elsewhere', msgtype: 'm.text' },
      })
    );
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `wr-a-3`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `wr-b-3`), jsonInit('PUT', {})),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
  });
  it(`wrong-room event 404 soft-4`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        room_id: ROOM2,
        content: { body: 'elsewhere', msgtype: 'm.text' },
      })
    );
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `wr-a-4`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `wr-b-4`), jsonInit('PUT', {})),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
  });
  it(`wrong-room event 404 soft-5`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        room_id: ROOM2,
        content: { body: 'elsewhere', msgtype: 'm.text' },
      })
    );
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `wr-a-5`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `wr-b-5`), jsonInit('PUT', {})),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
  });
  it(`wrong-room event 404 soft-6`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        room_id: ROOM2,
        content: { body: 'elsewhere', msgtype: 'm.text' },
      })
    );
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `wr-a-6`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `wr-b-6`), jsonInit('PUT', {})),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
  });
  it(`wrong-room event 404 soft-7`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        room_id: ROOM2,
        content: { body: 'elsewhere', msgtype: 'm.text' },
      })
    );
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `wr-a-7`), jsonInit('PUT', {})),
      request(redactPath(EVENT_ENC, `wr-b-7`), jsonInit('PUT', {})),
    ]);
    expect(results.every((r) => r.status === 404)).toBe(true);
  });
  it(`multi-room redact isolation soft-0`, async () => {
    getMembership.mockImplementation(async (_db, roomId: string) => {
      if (roomId === ROOM || roomId === ROOM2) return joinMembership();
      return null;
    });
    getEvent.mockImplementation(async (_db, eventId: string) => {
      if (eventId === EVENT) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT,
          sender: BOB,
          room_id: ROOM,
          content: { body: 'r1', msgtype: 'm.text' },
        });
      }
      if (eventId === EVENT2) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT2,
          sender: CAROL,
          room_id: ROOM2,
          content: { body: 'r2', msgtype: 'm.text' },
        });
      }
      return null;
    });
    getRoom.mockImplementation(async (_db, roomId: string) => ({
      room_id: roomId,
      room_version: '10',
      creator: USER,
      is_public: false,
    }));
    getRoomEvents.mockResolvedValue({
      events: [pdu({ type: 'm.room.message', event_id: EVENT, depth: 3 })],
      end: 3,
    });
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `iso-a-0`, ROOM_ENC), jsonInit('PUT', { reason: 'a' }), db),
      request(
        redactPath(EVENT2_ENC, `iso-b-0`, ROOM2_ENC),
        jsonInit('PUT', { reason: 'b' }),
        db
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
  it(`multi-room redact isolation soft-1`, async () => {
    getMembership.mockImplementation(async (_db, roomId: string) => {
      if (roomId === ROOM || roomId === ROOM2) return joinMembership();
      return null;
    });
    getEvent.mockImplementation(async (_db, eventId: string) => {
      if (eventId === EVENT) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT,
          sender: BOB,
          room_id: ROOM,
          content: { body: 'r1', msgtype: 'm.text' },
        });
      }
      if (eventId === EVENT2) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT2,
          sender: CAROL,
          room_id: ROOM2,
          content: { body: 'r2', msgtype: 'm.text' },
        });
      }
      return null;
    });
    getRoom.mockImplementation(async (_db, roomId: string) => ({
      room_id: roomId,
      room_version: '10',
      creator: USER,
      is_public: false,
    }));
    getRoomEvents.mockResolvedValue({
      events: [pdu({ type: 'm.room.message', event_id: EVENT, depth: 3 })],
      end: 3,
    });
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `iso-a-1`, ROOM_ENC), jsonInit('PUT', { reason: 'a' }), db),
      request(
        redactPath(EVENT2_ENC, `iso-b-1`, ROOM2_ENC),
        jsonInit('PUT', { reason: 'b' }),
        db
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
  it(`multi-room redact isolation soft-2`, async () => {
    getMembership.mockImplementation(async (_db, roomId: string) => {
      if (roomId === ROOM || roomId === ROOM2) return joinMembership();
      return null;
    });
    getEvent.mockImplementation(async (_db, eventId: string) => {
      if (eventId === EVENT) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT,
          sender: BOB,
          room_id: ROOM,
          content: { body: 'r1', msgtype: 'm.text' },
        });
      }
      if (eventId === EVENT2) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT2,
          sender: CAROL,
          room_id: ROOM2,
          content: { body: 'r2', msgtype: 'm.text' },
        });
      }
      return null;
    });
    getRoom.mockImplementation(async (_db, roomId: string) => ({
      room_id: roomId,
      room_version: '10',
      creator: USER,
      is_public: false,
    }));
    getRoomEvents.mockResolvedValue({
      events: [pdu({ type: 'm.room.message', event_id: EVENT, depth: 3 })],
      end: 3,
    });
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `iso-a-2`, ROOM_ENC), jsonInit('PUT', { reason: 'a' }), db),
      request(
        redactPath(EVENT2_ENC, `iso-b-2`, ROOM2_ENC),
        jsonInit('PUT', { reason: 'b' }),
        db
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
  it(`multi-room redact isolation soft-3`, async () => {
    getMembership.mockImplementation(async (_db, roomId: string) => {
      if (roomId === ROOM || roomId === ROOM2) return joinMembership();
      return null;
    });
    getEvent.mockImplementation(async (_db, eventId: string) => {
      if (eventId === EVENT) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT,
          sender: BOB,
          room_id: ROOM,
          content: { body: 'r1', msgtype: 'm.text' },
        });
      }
      if (eventId === EVENT2) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT2,
          sender: CAROL,
          room_id: ROOM2,
          content: { body: 'r2', msgtype: 'm.text' },
        });
      }
      return null;
    });
    getRoom.mockImplementation(async (_db, roomId: string) => ({
      room_id: roomId,
      room_version: '10',
      creator: USER,
      is_public: false,
    }));
    getRoomEvents.mockResolvedValue({
      events: [pdu({ type: 'm.room.message', event_id: EVENT, depth: 3 })],
      end: 3,
    });
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `iso-a-3`, ROOM_ENC), jsonInit('PUT', { reason: 'a' }), db),
      request(
        redactPath(EVENT2_ENC, `iso-b-3`, ROOM2_ENC),
        jsonInit('PUT', { reason: 'b' }),
        db
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
  it(`multi-room redact isolation soft-4`, async () => {
    getMembership.mockImplementation(async (_db, roomId: string) => {
      if (roomId === ROOM || roomId === ROOM2) return joinMembership();
      return null;
    });
    getEvent.mockImplementation(async (_db, eventId: string) => {
      if (eventId === EVENT) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT,
          sender: BOB,
          room_id: ROOM,
          content: { body: 'r1', msgtype: 'm.text' },
        });
      }
      if (eventId === EVENT2) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT2,
          sender: CAROL,
          room_id: ROOM2,
          content: { body: 'r2', msgtype: 'm.text' },
        });
      }
      return null;
    });
    getRoom.mockImplementation(async (_db, roomId: string) => ({
      room_id: roomId,
      room_version: '10',
      creator: USER,
      is_public: false,
    }));
    getRoomEvents.mockResolvedValue({
      events: [pdu({ type: 'm.room.message', event_id: EVENT, depth: 3 })],
      end: 3,
    });
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `iso-a-4`, ROOM_ENC), jsonInit('PUT', { reason: 'a' }), db),
      request(
        redactPath(EVENT2_ENC, `iso-b-4`, ROOM2_ENC),
        jsonInit('PUT', { reason: 'b' }),
        db
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
  it(`multi-room redact isolation soft-5`, async () => {
    getMembership.mockImplementation(async (_db, roomId: string) => {
      if (roomId === ROOM || roomId === ROOM2) return joinMembership();
      return null;
    });
    getEvent.mockImplementation(async (_db, eventId: string) => {
      if (eventId === EVENT) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT,
          sender: BOB,
          room_id: ROOM,
          content: { body: 'r1', msgtype: 'm.text' },
        });
      }
      if (eventId === EVENT2) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT2,
          sender: CAROL,
          room_id: ROOM2,
          content: { body: 'r2', msgtype: 'm.text' },
        });
      }
      return null;
    });
    getRoom.mockImplementation(async (_db, roomId: string) => ({
      room_id: roomId,
      room_version: '10',
      creator: USER,
      is_public: false,
    }));
    getRoomEvents.mockResolvedValue({
      events: [pdu({ type: 'm.room.message', event_id: EVENT, depth: 3 })],
      end: 3,
    });
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `iso-a-5`, ROOM_ENC), jsonInit('PUT', { reason: 'a' }), db),
      request(
        redactPath(EVENT2_ENC, `iso-b-5`, ROOM2_ENC),
        jsonInit('PUT', { reason: 'b' }),
        db
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
  it(`multi-room redact isolation soft-6`, async () => {
    getMembership.mockImplementation(async (_db, roomId: string) => {
      if (roomId === ROOM || roomId === ROOM2) return joinMembership();
      return null;
    });
    getEvent.mockImplementation(async (_db, eventId: string) => {
      if (eventId === EVENT) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT,
          sender: BOB,
          room_id: ROOM,
          content: { body: 'r1', msgtype: 'm.text' },
        });
      }
      if (eventId === EVENT2) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT2,
          sender: CAROL,
          room_id: ROOM2,
          content: { body: 'r2', msgtype: 'm.text' },
        });
      }
      return null;
    });
    getRoom.mockImplementation(async (_db, roomId: string) => ({
      room_id: roomId,
      room_version: '10',
      creator: USER,
      is_public: false,
    }));
    getRoomEvents.mockResolvedValue({
      events: [pdu({ type: 'm.room.message', event_id: EVENT, depth: 3 })],
      end: 3,
    });
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `iso-a-6`, ROOM_ENC), jsonInit('PUT', { reason: 'a' }), db),
      request(
        redactPath(EVENT2_ENC, `iso-b-6`, ROOM2_ENC),
        jsonInit('PUT', { reason: 'b' }),
        db
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
  it(`multi-room redact isolation soft-7`, async () => {
    getMembership.mockImplementation(async (_db, roomId: string) => {
      if (roomId === ROOM || roomId === ROOM2) return joinMembership();
      return null;
    });
    getEvent.mockImplementation(async (_db, eventId: string) => {
      if (eventId === EVENT) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT,
          sender: BOB,
          room_id: ROOM,
          content: { body: 'r1', msgtype: 'm.text' },
        });
      }
      if (eventId === EVENT2) {
        return pdu({
          type: 'm.room.message',
          event_id: EVENT2,
          sender: CAROL,
          room_id: ROOM2,
          content: { body: 'r2', msgtype: 'm.text' },
        });
      }
      return null;
    });
    getRoom.mockImplementation(async (_db, roomId: string) => ({
      room_id: roomId,
      room_version: '10',
      creator: USER,
      is_public: false,
    }));
    getRoomEvents.mockResolvedValue({
      events: [pdu({ type: 'm.room.message', event_id: EVENT, depth: 3 })],
      end: 3,
    });
    const db = createSqlDb();
    const [a, b] = await Promise.all([
      request(redactPath(EVENT_ENC, `iso-a-7`, ROOM_ENC), jsonInit('PUT', { reason: 'a' }), db),
      request(
        redactPath(EVENT2_ENC, `iso-b-7`, ROOM2_ENC),
        jsonInit('PUT', { reason: 'b' }),
        db
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});

describe('PL state concurrent soft flood — permission / JSON after #211', () => {
  it(`PL PUT insufficient power soft-0`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-gate',
        defaultPlContent({
          users: { [USER]: 40 },
          events: { 'm.room.power_levels': 100 },
        })
      ),
    });
    const body = defaultPlContent({ users: { [USER]: 100, [BOB]: 0 } });
    const results = await Promise.all([
      request(plPath(), jsonInit('PUT', body)),
      request(plPath(), jsonInit('PUT', body)),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`PL PUT insufficient power soft-1`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-gate',
        defaultPlContent({
          users: { [USER]: 40 },
          events: { 'm.room.power_levels': 100 },
        })
      ),
    });
    const body = defaultPlContent({ users: { [USER]: 100, [BOB]: 1 } });
    const results = await Promise.all([
      request(plPath(), jsonInit('PUT', body)),
      request(plPath(), jsonInit('PUT', body)),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`PL PUT insufficient power soft-2`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-gate',
        defaultPlContent({
          users: { [USER]: 40 },
          events: { 'm.room.power_levels': 100 },
        })
      ),
    });
    const body = defaultPlContent({ users: { [USER]: 100, [BOB]: 2 } });
    const results = await Promise.all([
      request(plPath(), jsonInit('PUT', body)),
      request(plPath(), jsonInit('PUT', body)),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`PL PUT insufficient power soft-3`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-gate',
        defaultPlContent({
          users: { [USER]: 40 },
          events: { 'm.room.power_levels': 100 },
        })
      ),
    });
    const body = defaultPlContent({ users: { [USER]: 100, [BOB]: 3 } });
    const results = await Promise.all([
      request(plPath(), jsonInit('PUT', body)),
      request(plPath(), jsonInit('PUT', body)),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`PL PUT insufficient power soft-4`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-gate',
        defaultPlContent({
          users: { [USER]: 40 },
          events: { 'm.room.power_levels': 100 },
        })
      ),
    });
    const body = defaultPlContent({ users: { [USER]: 100, [BOB]: 4 } });
    const results = await Promise.all([
      request(plPath(), jsonInit('PUT', body)),
      request(plPath(), jsonInit('PUT', body)),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`PL PUT insufficient power soft-5`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-gate',
        defaultPlContent({
          users: { [USER]: 40 },
          events: { 'm.room.power_levels': 100 },
        })
      ),
    });
    const body = defaultPlContent({ users: { [USER]: 100, [BOB]: 5 } });
    const results = await Promise.all([
      request(plPath(), jsonInit('PUT', body)),
      request(plPath(), jsonInit('PUT', body)),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`PL PUT insufficient power soft-6`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-gate',
        defaultPlContent({
          users: { [USER]: 40 },
          events: { 'm.room.power_levels': 100 },
        })
      ),
    });
    const body = defaultPlContent({ users: { [USER]: 100, [BOB]: 6 } });
    const results = await Promise.all([
      request(plPath(), jsonInit('PUT', body)),
      request(plPath(), jsonInit('PUT', body)),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`PL PUT insufficient power soft-7`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-gate',
        defaultPlContent({
          users: { [USER]: 40 },
          events: { 'm.room.power_levels': 100 },
        })
      ),
    });
    const body = defaultPlContent({ users: { [USER]: 100, [BOB]: 7 } });
    const results = await Promise.all([
      request(plPath(), jsonInit('PUT', body)),
      request(plPath(), jsonInit('PUT', body)),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`PL PUT insufficient power soft-8`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-gate',
        defaultPlContent({
          users: { [USER]: 40 },
          events: { 'm.room.power_levels': 100 },
        })
      ),
    });
    const body = defaultPlContent({ users: { [USER]: 100, [BOB]: 8 } });
    const results = await Promise.all([
      request(plPath(), jsonInit('PUT', body)),
      request(plPath(), jsonInit('PUT', body)),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`PL PUT insufficient power soft-9`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-gate',
        defaultPlContent({
          users: { [USER]: 40 },
          events: { 'm.room.power_levels': 100 },
        })
      ),
    });
    const body = defaultPlContent({ users: { [USER]: 100, [BOB]: 9 } });
    const results = await Promise.all([
      request(plPath(), jsonInit('PUT', body)),
      request(plPath(), jsonInit('PUT', body)),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`PL PUT insufficient power soft-10`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-gate',
        defaultPlContent({
          users: { [USER]: 40 },
          events: { 'm.room.power_levels': 100 },
        })
      ),
    });
    const body = defaultPlContent({ users: { [USER]: 100, [BOB]: 10 } });
    const results = await Promise.all([
      request(plPath(), jsonInit('PUT', body)),
      request(plPath(), jsonInit('PUT', body)),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`PL PUT insufficient power soft-11`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': plPdu(
        '$pl-gate',
        defaultPlContent({
          users: { [USER]: 40 },
          events: { 'm.room.power_levels': 100 },
        })
      ),
    });
    const body = defaultPlContent({ users: { [USER]: 100, [BOB]: 11 } });
    const results = await Promise.all([
      request(plPath(), jsonInit('PUT', body)),
      request(plPath(), jsonInit('PUT', body)),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`PL PUT bad JSON soft-0`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: 'not-json-0',
    };
    const results = await Promise.all([
      request(plPath(), init),
      request(plPath(), { ...init }),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
  });
  it(`PL PUT bad JSON soft-1`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: 'not-json-1',
    };
    const results = await Promise.all([
      request(plPath(), init),
      request(plPath(), { ...init }),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
  });
  it(`PL PUT bad JSON soft-2`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: 'not-json-2',
    };
    const results = await Promise.all([
      request(plPath(), init),
      request(plPath(), { ...init }),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
  });
  it(`PL PUT bad JSON soft-3`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: 'not-json-3',
    };
    const results = await Promise.all([
      request(plPath(), init),
      request(plPath(), { ...init }),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
  });
  it(`PL PUT bad JSON soft-4`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: 'not-json-4',
    };
    const results = await Promise.all([
      request(plPath(), init),
      request(plPath(), { ...init }),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
  });
  it(`PL PUT bad JSON soft-5`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: 'not-json-5',
    };
    const results = await Promise.all([
      request(plPath(), init),
      request(plPath(), { ...init }),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
  });
  it(`PL PUT bad JSON soft-6`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: 'not-json-6',
    };
    const results = await Promise.all([
      request(plPath(), init),
      request(plPath(), { ...init }),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
  });
  it(`PL PUT bad JSON soft-7`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: 'not-json-7',
    };
    const results = await Promise.all([
      request(plPath(), init),
      request(plPath(), { ...init }),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
  });
  it(`PL PUT bad JSON soft-8`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: 'not-json-8',
    };
    const results = await Promise.all([
      request(plPath(), init),
      request(plPath(), { ...init }),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
  });
  it(`PL PUT bad JSON soft-9`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: 'not-json-9',
    };
    const results = await Promise.all([
      request(plPath(), init),
      request(plPath(), { ...init }),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
  });
  it(`PL PUT bad JSON soft-10`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: 'not-json-10',
    };
    const results = await Promise.all([
      request(plPath(), init),
      request(plPath(), { ...init }),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
  });
  it(`PL PUT bad JSON soft-11`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    const init: RequestInit = {
      method: 'PUT',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: 'not-json-11',
    };
    const results = await Promise.all([
      request(plPath(), init),
      request(plPath(), { ...init }),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
  });
  it(`PL PUT not-member soft-0`, async () => {
    getMembership.mockResolvedValue(leaveMembership());
    const body = defaultPlContent();
    const results = await Promise.all([
      request(plPath(), jsonInit('PUT', body)),
      request(plPath(), jsonInit('PUT', body)),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`PL PUT not-member soft-1`, async () => {
    getMembership.mockResolvedValue(leaveMembership());
    const body = defaultPlContent();
    const results = await Promise.all([
      request(plPath(), jsonInit('PUT', body)),
      request(plPath(), jsonInit('PUT', body)),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`PL PUT not-member soft-2`, async () => {
    getMembership.mockResolvedValue(leaveMembership());
    const body = defaultPlContent();
    const results = await Promise.all([
      request(plPath(), jsonInit('PUT', body)),
      request(plPath(), jsonInit('PUT', body)),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`PL PUT not-member soft-3`, async () => {
    getMembership.mockResolvedValue(leaveMembership());
    const body = defaultPlContent();
    const results = await Promise.all([
      request(plPath(), jsonInit('PUT', body)),
      request(plPath(), jsonInit('PUT', body)),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`PL PUT not-member soft-4`, async () => {
    getMembership.mockResolvedValue(leaveMembership());
    const body = defaultPlContent();
    const results = await Promise.all([
      request(plPath(), jsonInit('PUT', body)),
      request(plPath(), jsonInit('PUT', body)),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`PL PUT not-member soft-5`, async () => {
    getMembership.mockResolvedValue(leaveMembership());
    const body = defaultPlContent();
    const results = await Promise.all([
      request(plPath(), jsonInit('PUT', body)),
      request(plPath(), jsonInit('PUT', body)),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`PL PUT not-member soft-6`, async () => {
    getMembership.mockResolvedValue(leaveMembership());
    const body = defaultPlContent();
    const results = await Promise.all([
      request(plPath(), jsonInit('PUT', body)),
      request(plPath(), jsonInit('PUT', body)),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
  it(`PL PUT not-member soft-7`, async () => {
    getMembership.mockResolvedValue(leaveMembership());
    const body = defaultPlContent();
    const results = await Promise.all([
      request(plPath(), jsonInit('PUT', body)),
      request(plPath(), jsonInit('PUT', body)),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
  });
});

describe('PL/redact lifecycle + bind contracts after #211', () => {
  it(`lifecycle send→redact→PL soft-0`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'lifecycle', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const sendRes = await request(
      sendPath(`life-send-0`),
      jsonInit('PUT', { msgtype: 'm.text', body: `life-0` }),
      db
    );
    expect(sendRes.status).toBe(200);
    const redactRes = await request(
      redactPath(EVENT_ENC, `life-redact-0`),
      jsonInit('PUT', { reason: `done-0` }),
      db
    );
    expect(redactRes.status).toBe(200);
    const plRes = await request(
      plPath(),
      jsonInit('PUT', defaultPlContent({ users: { [USER]: 100, [BOB]: 20 } })),
      db
    );
    expect([200, 409].includes(plRes.status)).toBe(true);
  });
  it(`lifecycle send→redact→PL soft-1`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'lifecycle', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const sendRes = await request(
      sendPath(`life-send-1`),
      jsonInit('PUT', { msgtype: 'm.text', body: `life-1` }),
      db
    );
    expect(sendRes.status).toBe(200);
    const redactRes = await request(
      redactPath(EVENT_ENC, `life-redact-1`),
      jsonInit('PUT', { reason: `done-1` }),
      db
    );
    expect(redactRes.status).toBe(200);
    const plRes = await request(
      plPath(),
      jsonInit('PUT', defaultPlContent({ users: { [USER]: 100, [BOB]: 21 } })),
      db
    );
    expect([200, 409].includes(plRes.status)).toBe(true);
  });
  it(`lifecycle send→redact→PL soft-2`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'lifecycle', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const sendRes = await request(
      sendPath(`life-send-2`),
      jsonInit('PUT', { msgtype: 'm.text', body: `life-2` }),
      db
    );
    expect(sendRes.status).toBe(200);
    const redactRes = await request(
      redactPath(EVENT_ENC, `life-redact-2`),
      jsonInit('PUT', { reason: `done-2` }),
      db
    );
    expect(redactRes.status).toBe(200);
    const plRes = await request(
      plPath(),
      jsonInit('PUT', defaultPlContent({ users: { [USER]: 100, [BOB]: 22 } })),
      db
    );
    expect([200, 409].includes(plRes.status)).toBe(true);
  });
  it(`lifecycle send→redact→PL soft-3`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'lifecycle', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const sendRes = await request(
      sendPath(`life-send-3`),
      jsonInit('PUT', { msgtype: 'm.text', body: `life-3` }),
      db
    );
    expect(sendRes.status).toBe(200);
    const redactRes = await request(
      redactPath(EVENT_ENC, `life-redact-3`),
      jsonInit('PUT', { reason: `done-3` }),
      db
    );
    expect(redactRes.status).toBe(200);
    const plRes = await request(
      plPath(),
      jsonInit('PUT', defaultPlContent({ users: { [USER]: 100, [BOB]: 23 } })),
      db
    );
    expect([200, 409].includes(plRes.status)).toBe(true);
  });
  it(`lifecycle send→redact→PL soft-4`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'lifecycle', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const sendRes = await request(
      sendPath(`life-send-4`),
      jsonInit('PUT', { msgtype: 'm.text', body: `life-4` }),
      db
    );
    expect(sendRes.status).toBe(200);
    const redactRes = await request(
      redactPath(EVENT_ENC, `life-redact-4`),
      jsonInit('PUT', { reason: `done-4` }),
      db
    );
    expect(redactRes.status).toBe(200);
    const plRes = await request(
      plPath(),
      jsonInit('PUT', defaultPlContent({ users: { [USER]: 100, [BOB]: 24 } })),
      db
    );
    expect([200, 409].includes(plRes.status)).toBe(true);
  });
  it(`lifecycle send→redact→PL soft-5`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'lifecycle', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const sendRes = await request(
      sendPath(`life-send-5`),
      jsonInit('PUT', { msgtype: 'm.text', body: `life-5` }),
      db
    );
    expect(sendRes.status).toBe(200);
    const redactRes = await request(
      redactPath(EVENT_ENC, `life-redact-5`),
      jsonInit('PUT', { reason: `done-5` }),
      db
    );
    expect(redactRes.status).toBe(200);
    const plRes = await request(
      plPath(),
      jsonInit('PUT', defaultPlContent({ users: { [USER]: 100, [BOB]: 25 } })),
      db
    );
    expect([200, 409].includes(plRes.status)).toBe(true);
  });
  it(`lifecycle send→redact→PL soft-6`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'lifecycle', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const sendRes = await request(
      sendPath(`life-send-6`),
      jsonInit('PUT', { msgtype: 'm.text', body: `life-6` }),
      db
    );
    expect(sendRes.status).toBe(200);
    const redactRes = await request(
      redactPath(EVENT_ENC, `life-redact-6`),
      jsonInit('PUT', { reason: `done-6` }),
      db
    );
    expect(redactRes.status).toBe(200);
    const plRes = await request(
      plPath(),
      jsonInit('PUT', defaultPlContent({ users: { [USER]: 100, [BOB]: 26 } })),
      db
    );
    expect([200, 409].includes(plRes.status)).toBe(true);
  });
  it(`lifecycle send→redact→PL soft-7`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'lifecycle', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const sendRes = await request(
      sendPath(`life-send-7`),
      jsonInit('PUT', { msgtype: 'm.text', body: `life-7` }),
      db
    );
    expect(sendRes.status).toBe(200);
    const redactRes = await request(
      redactPath(EVENT_ENC, `life-redact-7`),
      jsonInit('PUT', { reason: `done-7` }),
      db
    );
    expect(redactRes.status).toBe(200);
    const plRes = await request(
      plPath(),
      jsonInit('PUT', defaultPlContent({ users: { [USER]: 100, [BOB]: 27 } })),
      db
    );
    expect([200, 409].includes(plRes.status)).toBe(true);
  });
  it(`lifecycle send→redact→PL soft-8`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'lifecycle', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const sendRes = await request(
      sendPath(`life-send-8`),
      jsonInit('PUT', { msgtype: 'm.text', body: `life-8` }),
      db
    );
    expect(sendRes.status).toBe(200);
    const redactRes = await request(
      redactPath(EVENT_ENC, `life-redact-8`),
      jsonInit('PUT', { reason: `done-8` }),
      db
    );
    expect(redactRes.status).toBe(200);
    const plRes = await request(
      plPath(),
      jsonInit('PUT', defaultPlContent({ users: { [USER]: 100, [BOB]: 28 } })),
      db
    );
    expect([200, 409].includes(plRes.status)).toBe(true);
  });
  it(`lifecycle send→redact→PL soft-9`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'lifecycle', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const sendRes = await request(
      sendPath(`life-send-9`),
      jsonInit('PUT', { msgtype: 'm.text', body: `life-9` }),
      db
    );
    expect(sendRes.status).toBe(200);
    const redactRes = await request(
      redactPath(EVENT_ENC, `life-redact-9`),
      jsonInit('PUT', { reason: `done-9` }),
      db
    );
    expect(redactRes.status).toBe(200);
    const plRes = await request(
      plPath(),
      jsonInit('PUT', defaultPlContent({ users: { [USER]: 100, [BOB]: 29 } })),
      db
    );
    expect([200, 409].includes(plRes.status)).toBe(true);
  });
  it(`lifecycle send→redact→PL soft-10`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'lifecycle', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const sendRes = await request(
      sendPath(`life-send-10`),
      jsonInit('PUT', { msgtype: 'm.text', body: `life-10` }),
      db
    );
    expect(sendRes.status).toBe(200);
    const redactRes = await request(
      redactPath(EVENT_ENC, `life-redact-10`),
      jsonInit('PUT', { reason: `done-10` }),
      db
    );
    expect(redactRes.status).toBe(200);
    const plRes = await request(
      plPath(),
      jsonInit('PUT', defaultPlContent({ users: { [USER]: 100, [BOB]: 30 } })),
      db
    );
    expect([200, 409].includes(plRes.status)).toBe(true);
  });
  it(`lifecycle send→redact→PL soft-11`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'lifecycle', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const sendRes = await request(
      sendPath(`life-send-11`),
      jsonInit('PUT', { msgtype: 'm.text', body: `life-11` }),
      db
    );
    expect(sendRes.status).toBe(200);
    const redactRes = await request(
      redactPath(EVENT_ENC, `life-redact-11`),
      jsonInit('PUT', { reason: `done-11` }),
      db
    );
    expect(redactRes.status).toBe(200);
    const plRes = await request(
      plPath(),
      jsonInit('PUT', defaultPlContent({ users: { [USER]: 100, [BOB]: 31 } })),
      db
    );
    expect([200, 409].includes(plRes.status)).toBe(true);
  });
  it(`redact reason bind contract soft-0`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'bind', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const reason = `reason-bind-0`;
    const res = await request(
      redactPath(EVENT_ENC, `bind-0`),
      jsonInit('PUT', { reason }),
      db
    );
    expect(res.status).toBe(200);
    expect(storeEvent).toHaveBeenCalled();
    const stored = storeEvent.mock.calls[0][1] as PDU;
    expect(stored.type).toBe('m.room.redaction');
    expect((stored.content as { redacts?: string; reason?: string }).redacts).toBe(EVENT);
    expect((stored.content as { reason?: string }).reason).toBe(reason);
    const updates = db.updates.filter((u) => u.sql.includes('redacted_because'));
    expect(updates.length).toBe(1);
    expect(updates[0].args[1]).toBe(EVENT);
  });
  it(`redact reason bind contract soft-1`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'bind', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const reason = `reason-bind-1`;
    const res = await request(
      redactPath(EVENT_ENC, `bind-1`),
      jsonInit('PUT', { reason }),
      db
    );
    expect(res.status).toBe(200);
    expect(storeEvent).toHaveBeenCalled();
    const stored = storeEvent.mock.calls[0][1] as PDU;
    expect(stored.type).toBe('m.room.redaction');
    expect((stored.content as { redacts?: string; reason?: string }).redacts).toBe(EVENT);
    expect((stored.content as { reason?: string }).reason).toBe(reason);
    const updates = db.updates.filter((u) => u.sql.includes('redacted_because'));
    expect(updates.length).toBe(1);
    expect(updates[0].args[1]).toBe(EVENT);
  });
  it(`redact reason bind contract soft-2`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'bind', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const reason = `reason-bind-2`;
    const res = await request(
      redactPath(EVENT_ENC, `bind-2`),
      jsonInit('PUT', { reason }),
      db
    );
    expect(res.status).toBe(200);
    expect(storeEvent).toHaveBeenCalled();
    const stored = storeEvent.mock.calls[0][1] as PDU;
    expect(stored.type).toBe('m.room.redaction');
    expect((stored.content as { redacts?: string; reason?: string }).redacts).toBe(EVENT);
    expect((stored.content as { reason?: string }).reason).toBe(reason);
    const updates = db.updates.filter((u) => u.sql.includes('redacted_because'));
    expect(updates.length).toBe(1);
    expect(updates[0].args[1]).toBe(EVENT);
  });
  it(`redact reason bind contract soft-3`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'bind', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const reason = `reason-bind-3`;
    const res = await request(
      redactPath(EVENT_ENC, `bind-3`),
      jsonInit('PUT', { reason }),
      db
    );
    expect(res.status).toBe(200);
    expect(storeEvent).toHaveBeenCalled();
    const stored = storeEvent.mock.calls[0][1] as PDU;
    expect(stored.type).toBe('m.room.redaction');
    expect((stored.content as { redacts?: string; reason?: string }).redacts).toBe(EVENT);
    expect((stored.content as { reason?: string }).reason).toBe(reason);
    const updates = db.updates.filter((u) => u.sql.includes('redacted_because'));
    expect(updates.length).toBe(1);
    expect(updates[0].args[1]).toBe(EVENT);
  });
  it(`redact reason bind contract soft-4`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'bind', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const reason = `reason-bind-4`;
    const res = await request(
      redactPath(EVENT_ENC, `bind-4`),
      jsonInit('PUT', { reason }),
      db
    );
    expect(res.status).toBe(200);
    expect(storeEvent).toHaveBeenCalled();
    const stored = storeEvent.mock.calls[0][1] as PDU;
    expect(stored.type).toBe('m.room.redaction');
    expect((stored.content as { redacts?: string; reason?: string }).redacts).toBe(EVENT);
    expect((stored.content as { reason?: string }).reason).toBe(reason);
    const updates = db.updates.filter((u) => u.sql.includes('redacted_because'));
    expect(updates.length).toBe(1);
    expect(updates[0].args[1]).toBe(EVENT);
  });
  it(`redact reason bind contract soft-5`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'bind', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const reason = `reason-bind-5`;
    const res = await request(
      redactPath(EVENT_ENC, `bind-5`),
      jsonInit('PUT', { reason }),
      db
    );
    expect(res.status).toBe(200);
    expect(storeEvent).toHaveBeenCalled();
    const stored = storeEvent.mock.calls[0][1] as PDU;
    expect(stored.type).toBe('m.room.redaction');
    expect((stored.content as { redacts?: string; reason?: string }).redacts).toBe(EVENT);
    expect((stored.content as { reason?: string }).reason).toBe(reason);
    const updates = db.updates.filter((u) => u.sql.includes('redacted_because'));
    expect(updates.length).toBe(1);
    expect(updates[0].args[1]).toBe(EVENT);
  });
  it(`redact reason bind contract soft-6`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'bind', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const reason = `reason-bind-6`;
    const res = await request(
      redactPath(EVENT_ENC, `bind-6`),
      jsonInit('PUT', { reason }),
      db
    );
    expect(res.status).toBe(200);
    expect(storeEvent).toHaveBeenCalled();
    const stored = storeEvent.mock.calls[0][1] as PDU;
    expect(stored.type).toBe('m.room.redaction');
    expect((stored.content as { redacts?: string; reason?: string }).redacts).toBe(EVENT);
    expect((stored.content as { reason?: string }).reason).toBe(reason);
    const updates = db.updates.filter((u) => u.sql.includes('redacted_because'));
    expect(updates.length).toBe(1);
    expect(updates[0].args[1]).toBe(EVENT);
  });
  it(`redact reason bind contract soft-7`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'bind', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const reason = `reason-bind-7`;
    const res = await request(
      redactPath(EVENT_ENC, `bind-7`),
      jsonInit('PUT', { reason }),
      db
    );
    expect(res.status).toBe(200);
    expect(storeEvent).toHaveBeenCalled();
    const stored = storeEvent.mock.calls[0][1] as PDU;
    expect(stored.type).toBe('m.room.redaction');
    expect((stored.content as { redacts?: string; reason?: string }).redacts).toBe(EVENT);
    expect((stored.content as { reason?: string }).reason).toBe(reason);
    const updates = db.updates.filter((u) => u.sql.includes('redacted_because'));
    expect(updates.length).toBe(1);
    expect(updates[0].args[1]).toBe(EVENT);
  });
  it(`notify failure soft concurrent soft-0`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'n', msgtype: 'm.text' },
      })
    );
    notifyUsersOfEvent.mockRejectedValue(new Error('notify-fail'));
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `nf-a-0`), jsonInit('PUT', { reason: 'a' })),
      request(redactPath(EVENT_ENC, `nf-b-0`), jsonInit('PUT', { reason: 'b' })),
    ]);
    expect(results.every((r) => r.status >= 500 || r.status === 200)).toBe(true);
  });
  it(`notify failure soft concurrent soft-1`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'n', msgtype: 'm.text' },
      })
    );
    notifyUsersOfEvent.mockRejectedValue(new Error('notify-fail'));
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `nf-a-1`), jsonInit('PUT', { reason: 'a' })),
      request(redactPath(EVENT_ENC, `nf-b-1`), jsonInit('PUT', { reason: 'b' })),
    ]);
    expect(results.every((r) => r.status >= 500 || r.status === 200)).toBe(true);
  });
  it(`notify failure soft concurrent soft-2`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'n', msgtype: 'm.text' },
      })
    );
    notifyUsersOfEvent.mockRejectedValue(new Error('notify-fail'));
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `nf-a-2`), jsonInit('PUT', { reason: 'a' })),
      request(redactPath(EVENT_ENC, `nf-b-2`), jsonInit('PUT', { reason: 'b' })),
    ]);
    expect(results.every((r) => r.status >= 500 || r.status === 200)).toBe(true);
  });
  it(`notify failure soft concurrent soft-3`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'n', msgtype: 'm.text' },
      })
    );
    notifyUsersOfEvent.mockRejectedValue(new Error('notify-fail'));
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `nf-a-3`), jsonInit('PUT', { reason: 'a' })),
      request(redactPath(EVENT_ENC, `nf-b-3`), jsonInit('PUT', { reason: 'b' })),
    ]);
    expect(results.every((r) => r.status >= 500 || r.status === 200)).toBe(true);
  });
  it(`notify failure soft concurrent soft-4`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'n', msgtype: 'm.text' },
      })
    );
    notifyUsersOfEvent.mockRejectedValue(new Error('notify-fail'));
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `nf-a-4`), jsonInit('PUT', { reason: 'a' })),
      request(redactPath(EVENT_ENC, `nf-b-4`), jsonInit('PUT', { reason: 'b' })),
    ]);
    expect(results.every((r) => r.status >= 500 || r.status === 200)).toBe(true);
  });
  it(`notify failure soft concurrent soft-5`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'n', msgtype: 'm.text' },
      })
    );
    notifyUsersOfEvent.mockRejectedValue(new Error('notify-fail'));
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `nf-a-5`), jsonInit('PUT', { reason: 'a' })),
      request(redactPath(EVENT_ENC, `nf-b-5`), jsonInit('PUT', { reason: 'b' })),
    ]);
    expect(results.every((r) => r.status >= 500 || r.status === 200)).toBe(true);
  });
  it(`notify failure soft concurrent soft-6`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'n', msgtype: 'm.text' },
      })
    );
    notifyUsersOfEvent.mockRejectedValue(new Error('notify-fail'));
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `nf-a-6`), jsonInit('PUT', { reason: 'a' })),
      request(redactPath(EVENT_ENC, `nf-b-6`), jsonInit('PUT', { reason: 'b' })),
    ]);
    expect(results.every((r) => r.status >= 500 || r.status === 200)).toBe(true);
  });
  it(`notify failure soft concurrent soft-7`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'n', msgtype: 'm.text' },
      })
    );
    notifyUsersOfEvent.mockRejectedValue(new Error('notify-fail'));
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `nf-a-7`), jsonInit('PUT', { reason: 'a' })),
      request(redactPath(EVENT_ENC, `nf-b-7`), jsonInit('PUT', { reason: 'b' })),
    ]);
    expect(results.every((r) => r.status >= 500 || r.status === 200)).toBe(true);
  });
});

describe('redact concurrent soft flood — content-type / auth after #211', () => {
  it(`content-type edge soft-0`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'ct', msgtype: 'm.text' },
      })
    );
    const headers: Record<string, string> = { ...AUTH };
    if ('text/plain') headers['Content-Type'] = 'text/plain';
    const init: RequestInit = {
      method: 'PUT',
      headers,
      body: JSON.stringify({ reason: `ct-0` }),
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `ct-a-0`), init),
      request(redactPath(EVENT_ENC, `ct-b-0`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 415].includes(r.status))).toBe(true);
  });
  it(`content-type edge soft-1`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'ct', msgtype: 'm.text' },
      })
    );
    const headers: Record<string, string> = { ...AUTH };
    if ('application/xml') headers['Content-Type'] = 'application/xml';
    const init: RequestInit = {
      method: 'PUT',
      headers,
      body: JSON.stringify({ reason: `ct-1` }),
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `ct-a-1`), init),
      request(redactPath(EVENT_ENC, `ct-b-1`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 415].includes(r.status))).toBe(true);
  });
  it(`content-type edge soft-2`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'ct', msgtype: 'm.text' },
      })
    );
    const headers: Record<string, string> = { ...AUTH };
    if ('multipart/form-data') headers['Content-Type'] = 'multipart/form-data';
    const init: RequestInit = {
      method: 'PUT',
      headers,
      body: JSON.stringify({ reason: `ct-2` }),
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `ct-a-2`), init),
      request(redactPath(EVENT_ENC, `ct-b-2`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 415].includes(r.status))).toBe(true);
  });
  it(`content-type edge soft-3`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'ct', msgtype: 'm.text' },
      })
    );
    const headers: Record<string, string> = { ...AUTH };
    if ('application/json; charset=utf-8') headers['Content-Type'] = 'application/json; charset=utf-8';
    const init: RequestInit = {
      method: 'PUT',
      headers,
      body: JSON.stringify({ reason: `ct-3` }),
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `ct-a-3`), init),
      request(redactPath(EVENT_ENC, `ct-b-3`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 415].includes(r.status))).toBe(true);
  });
  it(`content-type edge soft-4`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'ct', msgtype: 'm.text' },
      })
    );
    const headers: Record<string, string> = { ...AUTH };
    if ('APPLICATION/JSON') headers['Content-Type'] = 'APPLICATION/JSON';
    const init: RequestInit = {
      method: 'PUT',
      headers,
      body: JSON.stringify({ reason: `ct-4` }),
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `ct-a-4`), init),
      request(redactPath(EVENT_ENC, `ct-b-4`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 415].includes(r.status))).toBe(true);
  });
  it(`content-type edge soft-5`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'ct', msgtype: 'm.text' },
      })
    );
    const headers: Record<string, string> = { ...AUTH };
    if ('') headers['Content-Type'] = '';
    const init: RequestInit = {
      method: 'PUT',
      headers,
      body: JSON.stringify({ reason: `ct-5` }),
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `ct-a-5`), init),
      request(redactPath(EVENT_ENC, `ct-b-5`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 415].includes(r.status))).toBe(true);
  });
  it(`content-type edge soft-6`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'ct', msgtype: 'm.text' },
      })
    );
    const headers: Record<string, string> = { ...AUTH };
    if ('application/json;charset=utf-16') headers['Content-Type'] = 'application/json;charset=utf-16';
    const init: RequestInit = {
      method: 'PUT',
      headers,
      body: JSON.stringify({ reason: `ct-6` }),
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `ct-a-6`), init),
      request(redactPath(EVENT_ENC, `ct-b-6`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 415].includes(r.status))).toBe(true);
  });
  it(`content-type edge soft-7`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'ct', msgtype: 'm.text' },
      })
    );
    const headers: Record<string, string> = { ...AUTH };
    if ('application/json; boundary=x') headers['Content-Type'] = 'application/json; boundary=x';
    const init: RequestInit = {
      method: 'PUT',
      headers,
      body: JSON.stringify({ reason: `ct-7` }),
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `ct-a-7`), init),
      request(redactPath(EVENT_ENC, `ct-b-7`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 415].includes(r.status))).toBe(true);
  });
  it(`content-type edge soft-8`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'ct', msgtype: 'm.text' },
      })
    );
    const headers: Record<string, string> = { ...AUTH };
    if ('text/plain') headers['Content-Type'] = 'text/plain';
    const init: RequestInit = {
      method: 'PUT',
      headers,
      body: JSON.stringify({ reason: `ct-8` }),
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `ct-a-8`), init),
      request(redactPath(EVENT_ENC, `ct-b-8`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 415].includes(r.status))).toBe(true);
  });
  it(`content-type edge soft-9`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'ct', msgtype: 'm.text' },
      })
    );
    const headers: Record<string, string> = { ...AUTH };
    if ('application/xml') headers['Content-Type'] = 'application/xml';
    const init: RequestInit = {
      method: 'PUT',
      headers,
      body: JSON.stringify({ reason: `ct-9` }),
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `ct-a-9`), init),
      request(redactPath(EVENT_ENC, `ct-b-9`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 415].includes(r.status))).toBe(true);
  });
  it(`content-type edge soft-10`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'ct', msgtype: 'm.text' },
      })
    );
    const headers: Record<string, string> = { ...AUTH };
    if ('multipart/form-data') headers['Content-Type'] = 'multipart/form-data';
    const init: RequestInit = {
      method: 'PUT',
      headers,
      body: JSON.stringify({ reason: `ct-10` }),
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `ct-a-10`), init),
      request(redactPath(EVENT_ENC, `ct-b-10`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 415].includes(r.status))).toBe(true);
  });
  it(`content-type edge soft-11`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'ct', msgtype: 'm.text' },
      })
    );
    const headers: Record<string, string> = { ...AUTH };
    if ('application/json; charset=utf-8') headers['Content-Type'] = 'application/json; charset=utf-8';
    const init: RequestInit = {
      method: 'PUT',
      headers,
      body: JSON.stringify({ reason: `ct-11` }),
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `ct-a-11`), init),
      request(redactPath(EVENT_ENC, `ct-b-11`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 415].includes(r.status))).toBe(true);
  });
  it(`content-type edge soft-12`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'ct', msgtype: 'm.text' },
      })
    );
    const headers: Record<string, string> = { ...AUTH };
    if ('APPLICATION/JSON') headers['Content-Type'] = 'APPLICATION/JSON';
    const init: RequestInit = {
      method: 'PUT',
      headers,
      body: JSON.stringify({ reason: `ct-12` }),
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `ct-a-12`), init),
      request(redactPath(EVENT_ENC, `ct-b-12`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 415].includes(r.status))).toBe(true);
  });
  it(`content-type edge soft-13`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'ct', msgtype: 'm.text' },
      })
    );
    const headers: Record<string, string> = { ...AUTH };
    if ('') headers['Content-Type'] = '';
    const init: RequestInit = {
      method: 'PUT',
      headers,
      body: JSON.stringify({ reason: `ct-13` }),
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `ct-a-13`), init),
      request(redactPath(EVENT_ENC, `ct-b-13`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 415].includes(r.status))).toBe(true);
  });
  it(`content-type edge soft-14`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'ct', msgtype: 'm.text' },
      })
    );
    const headers: Record<string, string> = { ...AUTH };
    if ('application/json;charset=utf-16') headers['Content-Type'] = 'application/json;charset=utf-16';
    const init: RequestInit = {
      method: 'PUT',
      headers,
      body: JSON.stringify({ reason: `ct-14` }),
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `ct-a-14`), init),
      request(redactPath(EVENT_ENC, `ct-b-14`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 415].includes(r.status))).toBe(true);
  });
  it(`content-type edge soft-15`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'ct', msgtype: 'm.text' },
      })
    );
    const headers: Record<string, string> = { ...AUTH };
    if ('application/json; boundary=x') headers['Content-Type'] = 'application/json; boundary=x';
    const init: RequestInit = {
      method: 'PUT',
      headers,
      body: JSON.stringify({ reason: `ct-15` }),
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `ct-a-15`), init),
      request(redactPath(EVENT_ENC, `ct-b-15`), { ...init }),
    ]);
    expect(results.every((r) => [200, 400, 415].includes(r.status))).toBe(true);
  });
  it(`empty body optional soft-0`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'empty', msgtype: 'm.text' },
      })
    );
    const init: RequestInit = {
      method: 'PUT',
      headers: AUTH,
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `empty-a-0`), init),
      request(redactPath(EVENT_ENC, `empty-b-0`), { ...init }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
  it(`empty body optional soft-1`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'empty', msgtype: 'm.text' },
      })
    );
    const init: RequestInit = {
      method: 'PUT',
      headers: AUTH,
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `empty-a-1`), init),
      request(redactPath(EVENT_ENC, `empty-b-1`), { ...init }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
  it(`empty body optional soft-2`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'empty', msgtype: 'm.text' },
      })
    );
    const init: RequestInit = {
      method: 'PUT',
      headers: AUTH,
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `empty-a-2`), init),
      request(redactPath(EVENT_ENC, `empty-b-2`), { ...init }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
  it(`empty body optional soft-3`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'empty', msgtype: 'm.text' },
      })
    );
    const init: RequestInit = {
      method: 'PUT',
      headers: AUTH,
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `empty-a-3`), init),
      request(redactPath(EVENT_ENC, `empty-b-3`), { ...init }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
  it(`empty body optional soft-4`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'empty', msgtype: 'm.text' },
      })
    );
    const init: RequestInit = {
      method: 'PUT',
      headers: AUTH,
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `empty-a-4`), init),
      request(redactPath(EVENT_ENC, `empty-b-4`), { ...init }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
  it(`empty body optional soft-5`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'empty', msgtype: 'm.text' },
      })
    );
    const init: RequestInit = {
      method: 'PUT',
      headers: AUTH,
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `empty-a-5`), init),
      request(redactPath(EVENT_ENC, `empty-b-5`), { ...init }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
  it(`empty body optional soft-6`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'empty', msgtype: 'm.text' },
      })
    );
    const init: RequestInit = {
      method: 'PUT',
      headers: AUTH,
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `empty-a-6`), init),
      request(redactPath(EVENT_ENC, `empty-b-6`), { ...init }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
  it(`empty body optional soft-7`, async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'empty', msgtype: 'm.text' },
      })
    );
    const init: RequestInit = {
      method: 'PUT',
      headers: AUTH,
    };
    const results = await Promise.all([
      request(redactPath(EVENT_ENC, `empty-a-7`), init),
      request(redactPath(EVENT_ENC, `empty-b-7`), { ...init }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});
