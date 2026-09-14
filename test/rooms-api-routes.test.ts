/**
 * TOKENMAXX HEAVY deepen after #109/#111 — different slice: rooms API routes.
 * Avoids media (#109), account/admin/identity/keys/login/search-helpers (#111),
 * push (#107), oauth edges (#106), presence/report/receipts/typing/to-device/account-data (#105).
 * Helper-only validateStateEvent coverage lives in rooms-initial-state.test.ts —
 * this file exercises Hono app.request() across create/join/leave/knock/state/send/
 * invite/kick/ban/redact/directory/summary/upgrade and related room endpoints.
 * Tests-only — no product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, PDU, Room } from '../src/types';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICEA');
      await next();
    };
  },
}));

const dbFns = vi.hoisted(() => ({
  createRoom: vi.fn(),
  getRoom: vi.fn(),
  storeEvent: vi.fn(),
  storeEventIdempotent: vi.fn(),
  getRoomState: vi.fn(),
  getStateEvent: vi.fn(),
  getRoomEvents: vi.fn(),
  updateMembership: vi.fn(),
  tryInsertJoinMembership: vi.fn(),
  getMembership: vi.fn(),
  getUserRooms: vi.fn(),
  getRoomMembers: vi.fn(),
  createRoomAlias: vi.fn(),
  getRoomByAlias: vi.fn(),
  deleteRoomAlias: vi.fn(),
  getEvent: vi.fn(),
  notifyUsersOfEvent: vi.fn(),
}));

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    createRoom: (...args: unknown[]) => dbFns.createRoom(...args),
    getRoom: (...args: unknown[]) => dbFns.getRoom(...args),
    storeEvent: (...args: unknown[]) => dbFns.storeEvent(...args),
    storeEventIdempotent: (...args: unknown[]) => dbFns.storeEventIdempotent(...args),
    getRoomState: (...args: unknown[]) => dbFns.getRoomState(...args),
    getStateEvent: (...args: unknown[]) => dbFns.getStateEvent(...args),
    getRoomEvents: (...args: unknown[]) => dbFns.getRoomEvents(...args),
    updateMembership: (...args: unknown[]) => dbFns.updateMembership(...args),
    tryInsertJoinMembership: (...args: unknown[]) => dbFns.tryInsertJoinMembership(...args),
    getMembership: (...args: unknown[]) => dbFns.getMembership(...args),
    getUserRooms: (...args: unknown[]) => dbFns.getUserRooms(...args),
    getRoomMembers: (...args: unknown[]) => dbFns.getRoomMembers(...args),
    createRoomAlias: (...args: unknown[]) => dbFns.createRoomAlias(...args),
    getRoomByAlias: (...args: unknown[]) => dbFns.getRoomByAlias(...args),
    deleteRoomAlias: (...args: unknown[]) => dbFns.deleteRoomAlias(...args),
    getEvent: (...args: unknown[]) => dbFns.getEvent(...args),
    notifyUsersOfEvent: (...args: unknown[]) => dbFns.notifyUsersOfEvent(...args),
  };
});

const cacheFns = vi.hoisted(() => ({
  invalidateRoomCache: vi.fn(async () => undefined),
  bumpRoomCacheGeneration: vi.fn(async () => undefined),
}));

vi.mock('../src/services/room-cache', () => ({
  invalidateRoomCache: (...args: unknown[]) => cacheFns.invalidateRoomCache(...args),
  bumpRoomCacheGeneration: (...args: unknown[]) => cacheFns.bumpRoomCacheGeneration(...args),
}));

let eventSeq = 0;
vi.mock('../src/utils/ids', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ids')>();
  return {
    ...actual,
    generateRoomId: vi.fn(async (serverName: string) => `!pinnedroom:${serverName}`),
    generateEventId: vi.fn(async (serverName: string) => {
      eventSeq += 1;
      return `$evt${eventSeq}:${serverName}`;
    }),
    generateDeterministicEventId: vi.fn(
      async (serverName: string, roomId: string, userId: string) =>
        `$det-${roomId.slice(1, 6)}-${userId.slice(1, 6)}:${serverName}`
    ),
  };
});

import roomsApp from '../src/api/rooms';
import { hashToken } from '../src/utils/crypto';
import { generateEventId, generateRoomId } from '../src/utils/ids';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const SERVER = 'example.com';
const ROOM = '!room:example.com';
const REMOTE_ROOM = '!remote:other.org';
const ALIAS = '#general:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const ALIAS_ENC = encodeURIComponent(ALIAS);
const REMOTE_ENC = encodeURIComponent(REMOTE_ROOM);
const EVENT = '$event:example.com';
const EVENT_ENC = encodeURIComponent(EVENT);

type SqlCall = { sql: string; args: unknown[] };
type Membership = { membership: string; eventId: string };
type StateSlot = {
  event_id: string;
  type: string;
  state_key: string;
  content: unknown;
  sender?: string;
  origin_server_ts?: number;
  room_id?: string;
};

type RoomsDbOpts = {
  streamPosition?: number;
  batchError?: Error | null;
  cleanupBatchError?: Error | null;
  knocks?: Array<{ room_id: string; user_id: string; reason: string | null; event_id: string }>;
  membershipRows?: Array<{
    room_id: string;
    user_id: string;
    membership: string;
    display_name?: string | null;
    avatar_url?: string | null;
  }>;
  aliasRows?: Array<{ alias: string; room_id: string }>;
  roomRows?: Array<{ room_id: string; room_version: string; is_public: number }>;
  stateRows?: Array<{ event_type: string; content: string }>;
  events?: Array<{
    event_id: string;
    room_id: string;
    sender: string;
    event_type: string;
    state_key: string | null;
    content: string;
    origin_server_ts: number;
    depth?: number;
  }>;
  accessTokens?: Array<{ token_hash: string; user_id: string }>;
  throwOnSqlIncludes?: string;
};

function createRoomsDb(opts: RoomsDbOpts = {}) {
  const knocks = opts.knocks ? [...opts.knocks] : [];
  const membershipRows = opts.membershipRows ? [...opts.membershipRows] : [];
  const aliasRows = opts.aliasRows ? [...opts.aliasRows] : [];
  const roomRows = opts.roomRows
    ? [...opts.roomRows]
    : [{ room_id: ROOM, room_version: '10', is_public: 1 }];
  const stateRows = opts.stateRows ? [...opts.stateRows] : [];
  const events = opts.events ? [...opts.events] : [];
  const accessTokens = opts.accessTokens ? [...opts.accessTokens] : [];
  let streamPosition = opts.streamPosition ?? 100;

  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const selects: SqlCall[] = [];
  const batches: unknown[][] = [];

  const db = {
    knocks,
    membershipRows,
    aliasRows,
    roomRows,
    stateRows,
    events,
    inserts,
    updates,
    deletes,
    selects,
    batches,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          const stmt = {
            sql,
            args,
            async first<T>() {
              selects.push({ sql, args });
              if (opts.throwOnSqlIncludes && sql.includes(opts.throwOnSqlIncludes)) {
                throw new Error(`forced boom: ${opts.throwOnSqlIncludes}`);
              }

              if (sql.includes('UPDATE stream_positions') && sql.includes('RETURNING position')) {
                const n = Number(args[0] ?? 0);
                streamPosition += n;
                return { position: streamPosition } as T;
              }

              if (sql.includes('FROM room_aliases') && sql.includes('SELECT room_id') && sql.includes('WHERE alias')) {
                const alias = args[0] as string;
                const row = aliasRows.find((a) => a.alias === alias);
                return (row ? { room_id: row.room_id } : null) as T;
              }

              if (sql.includes('FROM rooms WHERE room_id') && sql.includes('room_version')) {
                const roomId = args[0] as string;
                const row = roomRows.find((r) => r.room_id === roomId);
                return (row ?? null) as T;
              }

              if (sql.includes('COUNT(*)') && sql.includes('room_memberships') && sql.includes("membership = 'join'")) {
                const roomId = args[0] as string;
                const count = membershipRows.filter(
                  (m) => m.room_id === roomId && m.membership === 'join'
                ).length;
                return { count } as T;
              }

              if (sql.includes('FROM access_tokens') && sql.includes('token_hash')) {
                const hash = args[0] as string;
                const row = accessTokens.find((t) => t.token_hash === hash);
                return (row ? { user_id: row.user_id } : null) as T;
              }

              if (
                sql.includes('FROM room_memberships') &&
                sql.includes('SELECT membership') &&
                sql.includes('user_id')
              ) {
                const [roomId, userId] = args as string[];
                const row = membershipRows.find(
                  (m) => m.room_id === roomId && m.user_id === userId
                );
                return (row ? { membership: row.membership } : null) as T;
              }

              if (sql.includes('SELECT event_id FROM events') && sql.includes('ORDER BY depth DESC')) {
                const roomId = args[0] as string;
                const roomEvents = events
                  .filter((e) => e.room_id === roomId)
                  .sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));
                const hit = roomEvents[0];
                return (hit ? { event_id: hit.event_id } : null) as T;
              }

              if (sql.includes('SELECT event_id, depth FROM events') && sql.includes('ORDER BY depth DESC')) {
                const roomId = args[0] as string;
                const roomEvents = events
                  .filter((e) => e.room_id === roomId)
                  .sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));
                const hit = roomEvents[0];
                return (hit ? { event_id: hit.event_id, depth: hit.depth ?? 0 } : null) as T;
              }

              if (
                sql.includes('SELECT event_id, origin_server_ts') &&
                sql.includes('origin_server_ts >=')
              ) {
                const [roomId, ts] = args as [string, number];
                const hit = events
                  .filter((e) => e.room_id === roomId && e.origin_server_ts >= ts)
                  .sort((a, b) => a.origin_server_ts - b.origin_server_ts)[0];
                return (hit
                  ? { event_id: hit.event_id, origin_server_ts: hit.origin_server_ts }
                  : null) as T;
              }

              if (
                sql.includes('SELECT event_id, origin_server_ts') &&
                sql.includes('origin_server_ts <=')
              ) {
                const [roomId, ts] = args as [string, number];
                const hit = events
                  .filter((e) => e.room_id === roomId && e.origin_server_ts <= ts)
                  .sort((a, b) => b.origin_server_ts - a.origin_server_ts)[0];
                return (hit
                  ? { event_id: hit.event_id, origin_server_ts: hit.origin_server_ts }
                  : null) as T;
              }

              return null as T;
            },

            async all<T>() {
              selects.push({ sql, args });
              if (opts.throwOnSqlIncludes && sql.includes(opts.throwOnSqlIncludes)) {
                throw new Error(`forced boom: ${opts.throwOnSqlIncludes}`);
              }

              if (sql.includes('FROM room_state rs') && sql.includes('JOIN events e')) {
                return { results: stateRows as T[] };
              }

              if (
                sql.includes('FROM events') &&
                sql.includes('origin_server_ts <') &&
                sql.includes('ORDER BY origin_server_ts DESC')
              ) {
                const [roomId, ts, limit] = args as [string, number, number];
                const results = events
                  .filter((e) => e.room_id === roomId && e.origin_server_ts < ts)
                  .sort((a, b) => b.origin_server_ts - a.origin_server_ts)
                  .slice(0, limit);
                return { results: results as T[] };
              }

              if (
                sql.includes('FROM events') &&
                sql.includes('origin_server_ts >') &&
                sql.includes('ORDER BY origin_server_ts ASC')
              ) {
                const [roomId, ts, limit] = args as [string, number, number];
                const results = events
                  .filter((e) => e.room_id === roomId && e.origin_server_ts > ts)
                  .sort((a, b) => a.origin_server_ts - b.origin_server_ts)
                  .slice(0, limit);
                return { results: results as T[] };
              }

              if (
                sql.includes('FROM room_memberships') &&
                sql.includes("membership = 'join'") &&
                sql.includes('display_name')
              ) {
                const roomId = args[0] as string;
                const results = membershipRows
                  .filter((m) => m.room_id === roomId && m.membership === 'join')
                  .map((m) => ({
                    user_id: m.user_id,
                    display_name: m.display_name ?? null,
                    avatar_url: m.avatar_url ?? null,
                  }));
                return { results: results as T[] };
              }

              if (sql.includes('SELECT alias FROM room_aliases WHERE room_id')) {
                const roomId = args[0] as string;
                const results = aliasRows
                  .filter((a) => a.room_id === roomId)
                  .map((a) => ({ alias: a.alias }));
                return { results: results as T[] };
              }

              return { results: [] as T[] };
            },

            async run() {
              if (sql.includes('INSERT INTO account_data')) {
                inserts.push({ sql, args });
                return { success: true, meta: { changes: 1, last_row_id: 1 } };
              }
              if (sql.includes('DELETE FROM rooms WHERE room_id')) {
                deletes.push({ sql, args });
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('INSERT OR REPLACE INTO room_knocks')) {
                inserts.push({ sql, args });
                const [roomId, userId, reason, eventId] = args as [
                  string,
                  string,
                  string | null,
                  string,
                ];
                const existing = knocks.findIndex(
                  (k) => k.room_id === roomId && k.user_id === userId
                );
                const row = {
                  room_id: roomId,
                  user_id: userId,
                  reason,
                  event_id: eventId,
                };
                if (existing >= 0) knocks[existing] = row;
                else knocks.push(row);
                return { success: true, meta: { changes: 1, last_row_id: 1 } };
              }
              if (sql.includes('DELETE FROM room_memberships WHERE room_id') && sql.includes('user_id')) {
                deletes.push({ sql, args });
                const [roomId, userId] = args as string[];
                for (let i = membershipRows.length - 1; i >= 0; i--) {
                  if (
                    membershipRows[i].room_id === roomId &&
                    membershipRows[i].user_id === userId
                  ) {
                    membershipRows.splice(i, 1);
                  }
                }
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('UPDATE events SET redacted_because')) {
                updates.push({ sql, args });
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('UPDATE room_aliases SET room_id')) {
                updates.push({ sql, args });
                const [newRoomId, alias] = args as string[];
                const row = aliasRows.find((a) => a.alias === alias);
                if (row) row.room_id = newRoomId;
                return { success: true, meta: { changes: row ? 1 : 0, last_row_id: 0 } };
              }
              inserts.push({ sql, args });
              return { success: true, meta: { changes: 1, last_row_id: 1 } };
            },
          };
          return stmt;
        },
      };
    },
    async batch(stmts: Array<{ run?: () => Promise<unknown> }>) {
      batches.push(stmts as unknown[]);
      if (opts.batchError && batches.length === 1) {
        throw opts.batchError;
      }
      if (opts.cleanupBatchError && batches.length > 1) {
        throw opts.cleanupBatchError;
      }
      for (const s of stmts) {
        if (typeof s.run === 'function') await s.run();
      }
      return stmts.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };

  return db;
}

type RoomsDb = ReturnType<typeof createRoomsDb>;

function mockKv() {
  const data: Record<string, string> = {};
  return {
    data,
    get: async (key: string) => data[key] ?? null,
    put: async (key: string, value: string) => {
      data[key] = value;
    },
    delete: async (key: string) => {
      delete data[key];
    },
  } as unknown as KVNamespace;
}

function seedRoom(overrides: Partial<Room> = {}): Room {
  return {
    room_id: overrides.room_id ?? ROOM,
    room_version: overrides.room_version ?? '10',
    creator_id: overrides.creator_id ?? USER,
    is_public: overrides.is_public ?? false,
    created_at: overrides.created_at ?? 1,
  };
}

function seedMembership(overrides: Partial<Membership> = {}): Membership {
  return {
    membership: overrides.membership ?? 'join',
    eventId: overrides.eventId ?? '$member:example.com',
  };
}

function seedState(
  type: string,
  content: unknown,
  overrides: Partial<StateSlot> = {}
): StateSlot {
  return {
    event_id: overrides.event_id ?? `$state-${type}:example.com`,
    type,
    state_key: overrides.state_key ?? '',
    content,
    sender: overrides.sender ?? USER,
    origin_server_ts: overrides.origin_server_ts ?? 1000,
    room_id: overrides.room_id ?? ROOM,
  };
}

function seedPdu(overrides: Partial<PDU> & { type?: string } = {}): PDU {
  return {
    event_id: overrides.event_id ?? '$msg:example.com',
    room_id: overrides.room_id ?? ROOM,
    sender: overrides.sender ?? USER,
    type: overrides.type ?? 'm.room.message',
    state_key: overrides.state_key,
    content: overrides.content ?? { body: 'hi', msgtype: 'm.text' },
    origin_server_ts: overrides.origin_server_ts ?? 2000,
    depth: overrides.depth ?? 5,
    auth_events: overrides.auth_events ?? [],
    prev_events: overrides.prev_events ?? [],
    unsigned: overrides.unsigned,
  };
}

const waitUntilFns: Promise<unknown>[] = [];
const pushWorkflowCreate = vi.fn(async () => ({ id: 'push-1' }));
const joinWorkflowCreate = vi.fn();

function envFor(db: RoomsDb, extra: Partial<Env> = {}): Env {
  waitUntilFns.length = 0;
  return {
    DB: db as unknown as D1Database,
    CACHE: mockKv(),
    SERVER_NAME: SERVER,
    ROOM_JOIN_WORKFLOW: {
      create: joinWorkflowCreate,
    },
    PUSH_NOTIFICATION_WORKFLOW: {
      create: pushWorkflowCreate,
    },
    ...extra,
  } as unknown as Env;
}

async function request(
  db: RoomsDb,
  path: string,
  init: RequestInit = {},
  extraEnv: Partial<Env> = {}
): Promise<{ status: number; body: unknown; db: RoomsDb }> {
  const env = envFor(db, extraEnv);
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => {
      waitUntilFns.push(p);
    },
    passThroughOnException: () => {},
  };
  const res = await roomsApp.fetch(
    new Request(`http://localhost${path}`, init),
    env,
    executionCtx as ExecutionContext
  );
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, db };
}

function jsonInit(method: string, body?: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function resetDbFns() {
  for (const fn of Object.values(dbFns)) {
    fn.mockReset();
  }
  dbFns.createRoom.mockResolvedValue(undefined);
  dbFns.storeEvent.mockResolvedValue(1);
  dbFns.storeEventIdempotent.mockResolvedValue({ inserted: true, eventId: '$det:example.com' });
  dbFns.tryInsertJoinMembership.mockResolvedValue({ inserted: true, eventId: '$det:example.com' });
  dbFns.updateMembership.mockResolvedValue(undefined);
  dbFns.createRoomAlias.mockResolvedValue(undefined);
  dbFns.deleteRoomAlias.mockResolvedValue(undefined);
  dbFns.notifyUsersOfEvent.mockResolvedValue(undefined);
  dbFns.getUserRooms.mockResolvedValue([]);
  dbFns.getRoomState.mockResolvedValue([]);
  dbFns.getRoomEvents.mockResolvedValue({ events: [], end: 0 });
  dbFns.getRoomMembers.mockResolvedValue([]);
  dbFns.getRoomByAlias.mockResolvedValue(null);
  dbFns.getRoom.mockResolvedValue(null);
  dbFns.getMembership.mockResolvedValue(null);
  dbFns.getStateEvent.mockResolvedValue(null);
  dbFns.getEvent.mockResolvedValue(null);
  cacheFns.invalidateRoomCache.mockReset();
  cacheFns.bumpRoomCacheGeneration.mockReset();
  cacheFns.invalidateRoomCache.mockResolvedValue(undefined);
  cacheFns.bumpRoomCacheGeneration.mockResolvedValue(undefined);
  pushWorkflowCreate.mockReset();
  pushWorkflowCreate.mockResolvedValue({ id: 'push-1' });
  joinWorkflowCreate.mockReset();
  eventSeq = 0;
}

function defaultPl(extra: Record<string, unknown> = {}) {
  return {
    users: { [USER]: 100, [BOB]: 50, [CAROL]: 0 },
    users_default: 0,
    state_default: 50,
    events_default: 0,
    ban: 50,
    kick: 50,
    redact: 50,
    invite: 50,
    events: { 'm.room.name': 50, 'm.room.tombstone': 100 },
    ...extra,
  };
}

function mockJoinedWithPl(pl: Record<string, unknown> = defaultPl()) {
  dbFns.getMembership.mockResolvedValue(seedMembership({ membership: 'join' }));
  dbFns.getStateEvent.mockImplementation(async (_db, _r, type: string, stateKey?: string) => {
    if (type === 'm.room.power_levels') {
      return seedState('m.room.power_levels', pl, { event_id: '$pl-v1:example.com' }) as unknown as PDU;
    }
    if (type === 'm.room.create') {
      return seedState('m.room.create', { creator: USER }) as unknown as PDU;
    }
    if (type === 'm.room.join_rules') {
      return seedState('m.room.join_rules', { join_rule: 'public' }) as unknown as PDU;
    }
    if (type === 'm.room.name' && stateKey === '') {
      return seedState('m.room.name', { name: 'Old' }, { event_id: '$name-v1:example.com' }) as unknown as PDU;
    }
    return null;
  });
  dbFns.getRoomEvents.mockResolvedValue({
    events: [seedPdu({ event_id: '$prev:example.com', depth: 4 })],
    end: 4,
  });
}

beforeEach(() => {
  resetDbFns();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /_matrix/client/v3/createRoom', () => {
  it('rejects invalid JSON body', async () => {
    const db = createRoomsDb();
    const res = await request(db, '/_matrix/client/v3/createRoom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('rejects alias already in use', async () => {
    const db = createRoomsDb();
    dbFns.getRoomByAlias.mockResolvedValue(ROOM);
    const res = await request(
      db,
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { room_alias_local_part: 'general' })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_ROOM_IN_USE' });
    expect(dbFns.createRoom).not.toHaveBeenCalled();
  });

  it('rejects non-array initial_state', async () => {
    const db = createRoomsDb();
    const res = await request(
      db,
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { initial_state: { type: 'm.room.name' } })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_INVALID_PARAM',
      error: 'initial_state must be an array',
    });
  });

  it('rejects duplicate m.room.encryption in initial_state', async () => {
    const db = createRoomsDb();
    const enc = {
      type: 'm.room.encryption',
      content: { algorithm: 'm.megolm.v1.aes-sha2' },
    };
    const res = await request(
      db,
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { initial_state: [enc, enc] })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_INVALID_PARAM',
      error: 'Cannot specify multiple m.room.encryption events in initial_state',
    });
  });

  it('rejects invalid initial_state event (disallowed type)', async () => {
    const db = createRoomsDb();
    const res = await request(
      db,
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', {
        initial_state: [{ type: 'm.room.create', content: { creator: USER } }],
      })
    );
    expect(res.status).toBe(400);
    expect((res.body as { errcode: string }).errcode).toBe('M_INVALID_PARAM');
    expect(String((res.body as { error: string }).error)).toContain('cannot be set via initial_state');
  });

  it('rejects initial_state missing type', async () => {
    const db = createRoomsDb();
    const res = await request(
      db,
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { initial_state: [{ content: { name: 'x' } }] })
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain("missing or invalid 'type'");
  });

  it('rejects initial_state with non-object content', async () => {
    const db = createRoomsDb();
    const res = await request(
      db,
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { initial_state: [{ type: 'm.room.name', content: 'nope' }] })
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain("missing or invalid 'content'");
  });

  it('rejects encryption without algorithm', async () => {
    const db = createRoomsDb();
    const res = await request(
      db,
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', {
        initial_state: [{ type: 'm.room.encryption', content: {} }],
      })
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain('requires');
  });

  it('rejects unsupported encryption algorithm', async () => {
    const db = createRoomsDb();
    const res = await request(
      db,
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', {
        initial_state: [{ type: 'm.room.encryption', content: { algorithm: 'bad.algo' } }],
      })
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain('unsupported algorithm');
  });

  it('rejects unsupported room version', async () => {
    const db = createRoomsDb();
    const res = await request(
      db,
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { room_version: '999' })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_UNSUPPORTED_ROOM_VERSION' });
  });

  it('creates private room by default', async () => {
    const db = createRoomsDb();
    const res = await request(db, '/_matrix/client/v3/createRoom', jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ room_id: `!pinnedroom:${SERVER}` });
    expect(dbFns.createRoom).toHaveBeenCalledWith(
      expect.anything(),
      `!pinnedroom:${SERVER}`,
      '10',
      USER,
      false
    );
    expect(dbFns.notifyUsersOfEvent).toHaveBeenCalled();
    expect(db.inserts.some((i) => i.sql.includes('INSERT INTO account_data'))).toBe(true);
  });

  it('creates public room with visibility and preset', async () => {
    const db = createRoomsDb();
    const res = await request(
      db,
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', {
        visibility: 'public',
        preset: 'public_chat',
        name: 'Public Lounge',
        topic: 'hello',
      })
    );
    expect(res.status).toBe(200);
    expect(dbFns.createRoom).toHaveBeenCalledWith(
      expect.anything(),
      `!pinnedroom:${SERVER}`,
      '10',
      USER,
      true
    );
    expect(db.batches.length).toBeGreaterThan(0);
  });

  it('creates room with alias and invitees', async () => {
    const db = createRoomsDb();
    dbFns.getRoomByAlias.mockResolvedValue(null);
    const res = await request(
      db,
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', {
        room_alias_local_part: 'general',
        invite: [BOB],
        is_direct: true,
        preset: 'private_chat',
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      room_id: `!pinnedroom:${SERVER}`,
      room_alias: ALIAS,
    });
    expect(dbFns.createRoomAlias).toHaveBeenCalledWith(
      expect.anything(),
      ALIAS,
      `!pinnedroom:${SERVER}`,
      USER
    );
  });

  it('creates encrypted room via valid initial_state', async () => {
    const db = createRoomsDb();
    const res = await request(
      db,
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', {
        initial_state: [
          {
            type: 'm.room.encryption',
            content: { algorithm: 'm.megolm.v1.aes-sha2' },
          },
        ],
      })
    );
    expect(res.status).toBe(200);
    expect((res.body as { room_id: string }).room_id).toBe(`!pinnedroom:${SERVER}`);
  });

  it('rolls back when initial events batch fails', async () => {
    const db = createRoomsDb({ batchError: new Error('d1 batch boom') });
    const res = await request(db, '/_matrix/client/v3/createRoom', jsonInit('POST', { name: 'X' }));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN' });
    expect(db.deletes.some((d) => d.sql.includes('DELETE FROM rooms'))).toBe(true);
  });

  it('returns M_TOO_LARGE when initial_state content exceeds soft cap', async () => {
    const db = createRoomsDb();
    const huge = 'x'.repeat(70_000);
    const res = await request(
      db,
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', {
        initial_state: [{ type: 'm.room.topic', content: { topic: huge } }],
      })
    );
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ errcode: 'M_TOO_LARGE' });
    expect(db.deletes.some((d) => d.sql.includes('DELETE FROM rooms'))).toBe(true);
  });

  it('logs when compensating cleanup batch also fails', async () => {
    const db = createRoomsDb({
      batchError: new Error('primary batch fail'),
      cleanupBatchError: new Error('cleanup also fail'),
    });
    const res = await request(db, '/_matrix/client/v3/createRoom', jsonInit('POST', {}));
    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalled();
  });

  it('rejects non-string state_key in initial_state', async () => {
    const db = createRoomsDb();
    const res = await request(
      db,
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', {
        initial_state: [{ type: 'org.example.custom', state_key: 12, content: { a: 1 } }],
      })
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain("'state_key' must be a string");
  });

  it('rejects non-object initial_state entries', async () => {
    const db = createRoomsDb();
    const res = await request(
      db,
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { initial_state: ['not-an-object'] })
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain('must be an object');
  });

  it('surfaces server error when null initial_state entry crashes encryption pre-check', async () => {
    // Product code filters s.type before validateStateEvent; null throws TypeError → M_UNKNOWN.
    const db = createRoomsDb();
    const res = await request(
      db,
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { initial_state: [null] })
    );
    expect(res.status).toBe(500);
  });
});

describe('GET /_matrix/client/v3/joined_rooms', () => {
  it('returns empty list when user has no rooms', async () => {
    const db = createRoomsDb();
    dbFns.getUserRooms.mockResolvedValue([]);
    const res = await request(db, '/_matrix/client/v3/joined_rooms');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ joined_rooms: [] });
    expect(dbFns.getUserRooms).toHaveBeenCalledWith(expect.anything(), USER, 'join');
  });

  it('returns joined room ids', async () => {
    const db = createRoomsDb();
    dbFns.getUserRooms.mockResolvedValue([ROOM, '!other:example.com']);
    const res = await request(db, '/_matrix/client/v3/joined_rooms');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ joined_rooms: [ROOM, '!other:example.com'] });
  });
});

describe('POST /_matrix/client/v3/rooms/:roomId/join', () => {
  it('returns not found for missing local room', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(null);
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/join`, jsonInit('POST', {}));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('returns room_id when already joined', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(seedRoom());
    dbFns.getMembership.mockResolvedValue(seedMembership({ membership: 'join' }));
    dbFns.getStateEvent.mockResolvedValue(
      seedState('m.room.join_rules', { join_rule: 'invite' }) as unknown as PDU
    );
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/join`, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM });
    expect(dbFns.storeEventIdempotent).not.toHaveBeenCalled();
  });

  it('forbids join on invite-only without invite', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(seedRoom());
    dbFns.getMembership.mockResolvedValue(null);
    dbFns.getStateEvent.mockResolvedValue(
      seedState('m.room.join_rules', { join_rule: 'invite' }) as unknown as PDU
    );
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/join`, jsonInit('POST', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('joins public room and notifies', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(seedRoom());
    dbFns.getMembership.mockResolvedValue(null);
    mockJoinedWithPl();
    dbFns.getMembership.mockResolvedValue(null);
    dbFns.getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.join_rules') {
        return seedState('m.room.join_rules', { join_rule: 'public' }) as unknown as PDU;
      }
      if (type === 'm.room.create') {
        return seedState('m.room.create', { creator: USER }) as unknown as PDU;
      }
      if (type === 'm.room.power_levels') {
        return seedState('m.room.power_levels', defaultPl()) as unknown as PDU;
      }
      return null;
    });
    dbFns.storeEventIdempotent.mockResolvedValue({ inserted: true, eventId: '$join:example.com' });
    dbFns.tryInsertJoinMembership.mockResolvedValue({ inserted: true, eventId: '$join:example.com' });
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/join`, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM });
    expect(dbFns.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('joins from invite without notify when both inserts are duplicates', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(seedRoom());
    dbFns.getMembership.mockResolvedValue(seedMembership({ membership: 'invite' }));
    dbFns.getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.join_rules') {
        return seedState('m.room.join_rules', { join_rule: 'invite' }) as unknown as PDU;
      }
      if (type === 'm.room.create') {
        return seedState('m.room.create', { creator: USER }) as unknown as PDU;
      }
      if (type === 'm.room.power_levels') {
        return seedState('m.room.power_levels', defaultPl()) as unknown as PDU;
      }
      return null;
    });
    dbFns.storeEventIdempotent.mockResolvedValue({ inserted: false, eventId: '$dup:example.com' });
    dbFns.tryInsertJoinMembership.mockResolvedValue({ inserted: false, eventId: '$dup:example.com' });
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/join`, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(dbFns.notifyUsersOfEvent).not.toHaveBeenCalled();
  });

  it('accepts remote join while workflow is running', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(null);
    joinWorkflowCreate.mockResolvedValue({
      status: async () => ({ status: 'running' }),
    });
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${REMOTE_ENC}/join`,
      jsonInit('POST', {})
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: REMOTE_ROOM });
    expect(joinWorkflowCreate).toHaveBeenCalled();
  });

  it('accepts remote join while workflow is queued', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(null);
    joinWorkflowCreate.mockResolvedValue({
      status: async () => ({ status: 'queued' }),
    });
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${REMOTE_ENC}/join`,
      jsonInit('POST', {})
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: REMOTE_ROOM });
  });

  it('returns room_id when remote workflow completes successfully', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(null);
    joinWorkflowCreate.mockResolvedValue({
      status: async () => ({ status: 'complete', output: { success: true } }),
    });
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${REMOTE_ENC}/join`,
      jsonInit('POST', {})
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: REMOTE_ROOM });
  });

  it('fails when remote workflow completes without success', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(null);
    joinWorkflowCreate.mockResolvedValue({
      status: async () => ({ status: 'complete', output: { success: false } }),
    });
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${REMOTE_ENC}/join`,
      jsonInit('POST', {})
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN' });
  });

  it('fails when remote workflow status throws', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(null);
    joinWorkflowCreate.mockResolvedValue({
      status: async () => {
        throw new Error('workflow boom');
      },
    });
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${REMOTE_ENC}/join`,
      jsonInit('POST', {})
    );
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errcode: 'M_UNKNOWN' });
  });
});

describe('POST /_matrix/client/v3/rooms/:roomId/leave', () => {
  it('forbids leave when not a member', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(null);
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/leave`, jsonInit('POST', {}));
    expect(res.status).toBe(403);
  });

  it('forbids leave when only invited', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership({ membership: 'invite' }));
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/leave`, jsonInit('POST', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('leaves successfully and notifies', async () => {
    const db = createRoomsDb();
    mockJoinedWithPl();
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/leave`, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(dbFns.storeEvent).toHaveBeenCalled();
    expect(dbFns.updateMembership).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      USER,
      'leave',
      expect.any(String)
    );
    expect(dbFns.notifyUsersOfEvent).toHaveBeenCalled();
  });
});


describe('POST /_matrix/client/v3/rooms/:roomId/knock', () => {
  it('returns not found for missing room', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(null);
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/knock`, jsonInit('POST', {}));
    expect(res.status).toBe(404);
  });

  it('returns room_id when already joined', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(seedRoom());
    dbFns.getMembership.mockResolvedValue(seedMembership({ membership: 'join' }));
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/knock`, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM });
  });

  it('forbids knock when banned', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(seedRoom());
    dbFns.getMembership.mockResolvedValue(seedMembership({ membership: 'ban' }));
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/knock`, jsonInit('POST', {}));
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toContain('banned');
  });

  it('forbids knock when join_rule is invite', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(seedRoom());
    dbFns.getMembership.mockResolvedValue(null);
    dbFns.getStateEvent.mockResolvedValue(
      seedState('m.room.join_rules', { join_rule: 'invite' }) as unknown as PDU
    );
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/knock`, jsonInit('POST', {}));
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toContain('does not allow knocking');
  });

  it('knocks successfully with reason and inserts room_knocks', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(seedRoom());
    dbFns.getMembership.mockResolvedValue(null);
    dbFns.getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.join_rules') {
        return seedState('m.room.join_rules', { join_rule: 'knock' }) as unknown as PDU;
      }
      if (type === 'm.room.create') {
        return seedState('m.room.create', { creator: USER }) as unknown as PDU;
      }
      if (type === 'm.room.power_levels') {
        return seedState('m.room.power_levels', defaultPl()) as unknown as PDU;
      }
      return null;
    });
    dbFns.getRoomEvents.mockResolvedValue({ events: [seedPdu()], end: 1 });
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/knock`,
      jsonInit('POST', { reason: 'please let me in' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM });
    expect(dbFns.updateMembership).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      USER,
      'knock',
      expect.any(String)
    );
    expect(db.knocks).toEqual([
      expect.objectContaining({
        room_id: ROOM,
        user_id: USER,
        reason: 'please let me in',
      }),
    ]);
  });

  it('accepts empty/invalid JSON body via parse fallback', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(seedRoom());
    dbFns.getMembership.mockResolvedValue(null);
    dbFns.getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.join_rules') {
        return seedState('m.room.join_rules', { join_rule: 'knock_restricted' }) as unknown as PDU;
      }
      return seedState(type, {}) as unknown as PDU;
    });
    dbFns.getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/knock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: 'not-json',
    });
    expect(res.status).toBe(200);
    expect(db.knocks[0]?.reason).toBeNull();
  });
});

describe('POST /_matrix/client/v3/knock/:roomIdOrAlias', () => {
  it('returns not found when alias missing', async () => {
    const db = createRoomsDb();
    dbFns.getRoomByAlias.mockResolvedValue(null);
    const res = await request(
      db,
      `/_matrix/client/v3/knock/${ALIAS_ENC}`,
      jsonInit('POST', {})
    );
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toContain('alias');
  });

  it('resolves alias then knocks', async () => {
    const db = createRoomsDb();
    dbFns.getRoomByAlias.mockResolvedValue(ROOM);
    dbFns.getRoom.mockResolvedValue(seedRoom());
    dbFns.getMembership.mockResolvedValue(null);
    dbFns.getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.join_rules') {
        return seedState('m.room.join_rules', { join_rule: 'knock' }) as unknown as PDU;
      }
      return seedState(type, {}) as unknown as PDU;
    });
    dbFns.getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    const res = await request(
      db,
      `/_matrix/client/v3/knock/${ALIAS_ENC}`,
      jsonInit('POST', { reason: 'via alias' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM });
    expect(dbFns.getRoomByAlias).toHaveBeenCalledWith(expect.anything(), ALIAS);
  });

  it('forbids when join_rule disallows knock', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(seedRoom());
    dbFns.getStateEvent.mockResolvedValue(
      seedState('m.room.join_rules', { join_rule: 'public' }) as unknown as PDU
    );
    const res = await request(
      db,
      `/_matrix/client/v3/knock/${ROOM_ENC}`,
      jsonInit('POST', {})
    );
    expect(res.status).toBe(403);
  });

  it('returns room_id when already joined via knock-by-id', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(seedRoom());
    dbFns.getStateEvent.mockResolvedValue(
      seedState('m.room.join_rules', { join_rule: 'knock' }) as unknown as PDU
    );
    dbFns.getMembership.mockResolvedValue(seedMembership({ membership: 'join' }));
    const res = await request(
      db,
      `/_matrix/client/v3/knock/${ROOM_ENC}`,
      jsonInit('POST', {})
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM });
  });

  it('forbids when banned via knock-by-id', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(seedRoom());
    dbFns.getStateEvent.mockResolvedValue(
      seedState('m.room.join_rules', { join_rule: 'knock' }) as unknown as PDU
    );
    dbFns.getMembership.mockResolvedValue(seedMembership({ membership: 'ban' }));
    const res = await request(
      db,
      `/_matrix/client/v3/knock/${ROOM_ENC}`,
      jsonInit('POST', {})
    );
    expect(res.status).toBe(403);
  });

  it('returns not found when room id missing', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(null);
    const res = await request(
      db,
      `/_matrix/client/v3/knock/${ROOM_ENC}`,
      jsonInit('POST', {})
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /_matrix/client/v3/rooms/:roomId/state', () => {
  it('forbids non-members', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(null);
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/state`);
    expect(res.status).toBe(403);
  });

  it('returns formatted state events', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getRoomState.mockResolvedValue([
      seedState('m.room.name', { name: 'Lobby' }) as unknown as PDU,
      seedState('m.room.topic', { topic: 'hi' }, { state_key: '' }) as unknown as PDU,
    ]);
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/state`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        type: 'm.room.name',
        content: { name: 'Lobby' },
        event_id: expect.any(String),
        room_id: ROOM,
      }),
      expect.objectContaining({ type: 'm.room.topic', content: { topic: 'hi' } }),
    ]);
  });
});

describe('GET /_matrix/client/v3/rooms/:roomId/state/:eventType/:stateKey?', () => {
  it('forbids non-members', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(null);
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`);
    expect(res.status).toBe(403);
  });

  it('returns not found when state missing', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getStateEvent.mockResolvedValue(null);
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`);
    expect(res.status).toBe(404);
  });

  it('returns content without stateKey path', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getStateEvent.mockResolvedValue(
      seedState('m.room.name', { name: 'N' }) as unknown as PDU
    );
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'N' });
    expect(dbFns.getStateEvent).toHaveBeenCalledWith(expect.anything(), ROOM, 'm.room.name', '');
  });

  it('returns content with stateKey path', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getStateEvent.mockResolvedValue(
      seedState('m.room.member', { membership: 'join' }, { state_key: BOB }) as unknown as PDU
    );
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.member/${encodeURIComponent(BOB)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ membership: 'join' });
  });
});

describe('PUT /_matrix/client/v3/rooms/:roomId/state/:eventType/:stateKey?', () => {
  it('forbids non-members', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(null);
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'X' })
    );
    expect(res.status).toBe(403);
  });

  it('rejects bad JSON', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: '{bad',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('forbids insufficient power level', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.power_levels') {
        return seedState('m.room.power_levels', {
          users: { [USER]: 10 },
          users_default: 0,
          state_default: 50,
          events: { 'm.room.name': 50 },
        }) as unknown as PDU;
      }
      if (type === 'm.room.create') {
        return seedState('m.room.create', { creator: USER }) as unknown as PDU;
      }
      return null;
    });
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'Nope' })
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toContain('Insufficient power level');
  });

  it('conflicts when power levels change mid-request', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    let plReads = 0;
    dbFns.getStateEvent.mockImplementation(async (_db, _r, type: string, _stateKey?: string) => {
      if (type === 'm.room.power_levels') {
        plReads += 1;
        const id = plReads <= 1 ? '$pl-old:example.com' : '$pl-new:example.com';
        return seedState('m.room.power_levels', defaultPl(), { event_id: id }) as unknown as PDU;
      }
      if (type === 'm.room.create') {
        return seedState('m.room.create', { creator: USER }) as unknown as PDU;
      }
      if (type === 'm.room.name') {
        return seedState('m.room.name', { name: 'Old' }, { event_id: '$name-v1:example.com' }) as unknown as PDU;
      }
      return null;
    });
    dbFns.getRoomEvents.mockResolvedValue({ events: [seedPdu()], end: 1 });
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'New' })
    );
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ errcode: 'M_CONFLICT' });
    expect((res.body as { error: string }).error).toContain('Power levels changed');
  });

  it('conflicts when state slot changes mid-request', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    let nameReads = 0;
    dbFns.getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.power_levels') {
        return seedState('m.room.power_levels', defaultPl(), {
          event_id: '$pl-stable:example.com',
        }) as unknown as PDU;
      }
      if (type === 'm.room.create') {
        return seedState('m.room.create', { creator: USER }) as unknown as PDU;
      }
      if (type === 'm.room.name') {
        nameReads += 1;
        const id = nameReads <= 1 ? '$name-a:example.com' : '$name-b:example.com';
        return seedState('m.room.name', { name: 'Old' }, { event_id: id }) as unknown as PDU;
      }
      return null;
    });
    dbFns.getRoomEvents.mockResolvedValue({ events: [seedPdu()], end: 1 });
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'New' })
    );
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ errcode: 'M_CONFLICT' });
    expect((res.body as { error: string }).error).toContain('changed during request');
  });

  it('sets m.room.name successfully and bumps cache', async () => {
    const db = createRoomsDb();
    mockJoinedWithPl();
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'Renamed' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$evt/) });
    expect(cacheFns.bumpRoomCacheGeneration).toHaveBeenCalledWith(expect.anything(), ROOM);
    expect(cacheFns.invalidateRoomCache).toHaveBeenCalledWith(expect.anything(), ROOM);
    expect(dbFns.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('updates membership table for m.room.member state', async () => {
    const db = createRoomsDb();
    mockJoinedWithPl();
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.member/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', {
        membership: 'join',
        displayname: 'Bob',
        avatar_url: 'mxc://example.com/a',
      })
    );
    expect(res.status).toBe(200);
    expect(dbFns.updateMembership).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      BOB,
      'join',
      expect.any(String),
      'Bob',
      'mxc://example.com/a'
    );
  });

  it('warns when cache generation bump fails', async () => {
    const db = createRoomsDb();
    mockJoinedWithPl();
    cacheFns.bumpRoomCacheGeneration.mockRejectedValueOnce(new Error('kv down'));
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.topic`,
      jsonInit('PUT', { topic: 't' })
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(console.warn).toHaveBeenCalled();
  });
});


describe('GET /_matrix/client/v3/rooms/:roomId/members', () => {
  it('forbids non-members', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(null);
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/members`);
    expect(res.status).toBe(403);
  });

  it('returns member events fetched in parallel', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getRoomMembers.mockResolvedValue([
      { userId: USER, membership: 'join', eventId: '$m1' },
      { userId: BOB, membership: 'join', eventId: '$m2' },
    ]);
    dbFns.getStateEvent.mockImplementation(async (_db, _r, type: string, stateKey?: string) => {
      if (type === 'm.room.member' && stateKey) {
        return seedState(
          'm.room.member',
          { membership: 'join' },
          { state_key: stateKey, event_id: `$mem-${stateKey}` }
        ) as unknown as PDU;
      }
      return null;
    });
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/members`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ state_key: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.state_key).sort()).toEqual([BOB, USER].sort());
  });
});

describe('GET /_matrix/client/v3/rooms/:roomId/messages', () => {
  it('forbids non-members', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(null);
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/messages`);
    expect(res.status).toBe(403);
  });

  it('parses s-prefix from token', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getRoomEvents.mockResolvedValue({
      events: [seedPdu({ event_id: '$a:example.com' })],
      end: 42,
    });
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/messages?from=s20&dir=b&limit=5`);
    expect(res.status).toBe(200);
    expect(dbFns.getRoomEvents).toHaveBeenCalledWith(expect.anything(), ROOM, 20, 5, 'b');
    expect(res.body).toMatchObject({ start: 's20', end: 's42' });
  });

  it('parses plain numeric from token', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getRoomEvents.mockResolvedValue({
      events: [seedPdu()],
      end: 7,
    });
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/messages?from=7&dir=f`);
    expect(dbFns.getRoomEvents).toHaveBeenCalledWith(expect.anything(), ROOM, 7, 10, 'f');
    expect(res.body).toMatchObject({ start: '7', end: 's7' });
  });

  it('omits end when chunk is empty', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/messages`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ start: 's0', chunk: [] });
    expect((res.body as { end?: string }).end).toBeUndefined();
  });

  it('caps limit at 100', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/messages?limit=999`);
    expect(dbFns.getRoomEvents).toHaveBeenCalledWith(expect.anything(), ROOM, undefined, 100, 'b');
  });
});

describe('GET /_matrix/client/v3/rooms/:roomId/event/:eventId', () => {
  it('forbids non-members', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(null);
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/event/${EVENT_ENC}`);
    expect(res.status).toBe(403);
  });

  it('returns not found for wrong room', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getEvent.mockResolvedValue(seedPdu({ room_id: '!other:example.com' }));
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/event/${EVENT_ENC}`);
    expect(res.status).toBe(404);
  });

  it('returns not found when event missing', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getEvent.mockResolvedValue(null);
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/event/${EVENT_ENC}`);
    expect(res.status).toBe(404);
  });

  it('returns formatted event on success', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getEvent.mockResolvedValue(
      seedPdu({ event_id: EVENT, content: { body: 'hello', msgtype: 'm.text' } })
    );
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/event/${EVENT_ENC}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      event_id: EVENT,
      type: 'm.room.message',
      content: { body: 'hello', msgtype: 'm.text' },
      room_id: ROOM,
    });
  });
});

describe('PUT /_matrix/client/v3/rooms/:roomId/send/:eventType/:txnId', () => {
  it('forbids non-members', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(null);
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.message/txn1`,
      jsonInit('PUT', { body: 'hi', msgtype: 'm.text' })
    );
    expect(res.status).toBe(403);
  });

  it('rejects bad JSON', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.message/txn1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: 'nope',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('sends m.room.message and triggers push workflow', async () => {
    const db = createRoomsDb();
    mockJoinedWithPl();
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.message/txn-msg`,
      jsonInit('PUT', { body: 'hi', msgtype: 'm.text' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.stringMatching(/^\$evt/) });
    expect(waitUntilFns.length).toBe(1);
    await Promise.all(waitUntilFns);
    expect(pushWorkflowCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          eventType: 'm.room.message',
          roomId: ROOM,
          sender: USER,
        }),
      })
    );
  });

  it('sends m.room.encrypted and triggers push workflow', async () => {
    const db = createRoomsDb();
    mockJoinedWithPl();
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.encrypted/txn-enc`,
      jsonInit('PUT', { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'abc' })
    );
    expect(res.status).toBe(200);
    await Promise.all(waitUntilFns);
    expect(pushWorkflowCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ eventType: 'm.room.encrypted' }),
      })
    );
  });

  it('does not push for non-message event types', async () => {
    const db = createRoomsDb();
    mockJoinedWithPl();
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.reaction/txn-r`,
      jsonInit('PUT', { 'm.relates_to': { rel_type: 'm.annotation', event_id: EVENT, key: '👍' } })
    );
    expect(res.status).toBe(200);
    expect(waitUntilFns.length).toBe(0);
    expect(pushWorkflowCreate).not.toHaveBeenCalled();
  });
});

describe('POST /_matrix/client/v3/rooms/:roomId/invite', () => {
  it('rejects bad JSON', async () => {
    const db = createRoomsDb();
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: '{',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('requires user_id', async () => {
    const db = createRoomsDb();
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('forbids when inviter not a member', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(null);
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(res.status).toBe(403);
  });

  it('forbids insufficient invite power', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getStateEvent.mockResolvedValue(
      seedState('m.room.power_levels', {
        users: { [USER]: 10 },
        users_default: 0,
        invite: 50,
      }) as unknown as PDU
    );
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toContain('invite');
  });

  it('forbids inviting already-joined user', async () => {
    const db = createRoomsDb();
    mockJoinedWithPl();
    dbFns.getMembership
      .mockResolvedValueOnce(seedMembership())
      .mockResolvedValueOnce(seedMembership({ membership: 'join' }));
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toContain('already in the room');
  });

  it('is idempotent when already invited', async () => {
    const db = createRoomsDb();
    mockJoinedWithPl();
    dbFns.getMembership
      .mockResolvedValueOnce(seedMembership())
      .mockResolvedValueOnce(seedMembership({ membership: 'invite' }));
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(dbFns.storeEvent).not.toHaveBeenCalled();
  });

  it('conflicts when power levels change during invite', async () => {
    const db = createRoomsDb();
    dbFns.getMembership
      .mockResolvedValueOnce(seedMembership())
      .mockResolvedValueOnce(null);
    let plReads = 0;
    dbFns.getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.power_levels') {
        plReads += 1;
        return seedState('m.room.power_levels', defaultPl(), {
          event_id: plReads <= 1 ? '$pl1:example.com' : '$pl2:example.com',
        }) as unknown as PDU;
      }
      if (type === 'm.room.create') {
        return seedState('m.room.create', { creator: USER }) as unknown as PDU;
      }
      return null;
    });
    dbFns.getRoomEvents.mockResolvedValue({ events: [seedPdu()], end: 1 });
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ errcode: 'M_CONFLICT' });
  });

  it('invites successfully', async () => {
    const db = createRoomsDb();
    mockJoinedWithPl();
    dbFns.getMembership.mockResolvedValueOnce(seedMembership()).mockResolvedValueOnce(null);
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(res.status).toBe(200);
    expect(dbFns.updateMembership).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      BOB,
      'invite',
      expect.any(String)
    );
    expect(dbFns.notifyUsersOfEvent).toHaveBeenCalled();
  });
});

describe('POST /_matrix/client/v3/rooms/:roomId/kick', () => {
  it('requires user_id', async () => {
    const db = createRoomsDb();
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/kick`, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('forbids when kicker not a member', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(null);
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/kick`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(res.status).toBe(403);
  });

  it('forbids when target not joined', async () => {
    const db = createRoomsDb();
    dbFns.getMembership
      .mockResolvedValueOnce(seedMembership())
      .mockResolvedValueOnce(null);
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/kick`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toContain('not in the room');
  });

  it('forbids when user power below kick threshold', async () => {
    const db = createRoomsDb();
    dbFns.getMembership
      .mockResolvedValueOnce(seedMembership())
      .mockResolvedValueOnce(seedMembership());
    dbFns.getStateEvent.mockResolvedValue(
      seedState('m.room.power_levels', {
        users: { [USER]: 40, [BOB]: 0 },
        users_default: 0,
        kick: 50,
      }) as unknown as PDU
    );
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/kick`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(res.status).toBe(403);
  });

  it('forbids when user power is not greater than target', async () => {
    const db = createRoomsDb();
    dbFns.getMembership
      .mockResolvedValueOnce(seedMembership())
      .mockResolvedValueOnce(seedMembership());
    dbFns.getStateEvent.mockResolvedValue(
      seedState('m.room.power_levels', {
        users: { [USER]: 50, [BOB]: 50 },
        users_default: 0,
        kick: 50,
      }) as unknown as PDU
    );
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/kick`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(res.status).toBe(403);
  });

  it('kicks with reason successfully', async () => {
    const db = createRoomsDb();
    mockJoinedWithPl();
    dbFns.getMembership
      .mockResolvedValueOnce(seedMembership())
      .mockResolvedValueOnce(seedMembership({ membership: 'join', eventId: '$bob:example.com' }));
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/kick`,
      jsonInit('POST', { user_id: BOB, reason: 'spam' })
    );
    expect(res.status).toBe(200);
    expect(dbFns.storeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'm.room.member',
        state_key: BOB,
        content: expect.objectContaining({ membership: 'leave', reason: 'spam' }),
      })
    );
    expect(dbFns.updateMembership).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      BOB,
      'leave',
      expect.any(String)
    );
  });
});


describe('POST /_matrix/client/v3/rooms/:roomId/ban', () => {
  it('requires user_id', async () => {
    const db = createRoomsDb();
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/ban`, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('forbids when banner not a member', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(null);
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/ban`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(res.status).toBe(403);
  });

  it('forbids insufficient ban power', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getStateEvent.mockResolvedValue(
      seedState('m.room.power_levels', {
        users: { [USER]: 40, [BOB]: 0 },
        ban: 50,
        users_default: 0,
      }) as unknown as PDU
    );
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/ban`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(res.status).toBe(403);
  });

  it('forbids when power not greater than target', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getStateEvent.mockResolvedValue(
      seedState('m.room.power_levels', {
        users: { [USER]: 50, [BOB]: 50 },
        ban: 50,
        users_default: 0,
      }) as unknown as PDU
    );
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/ban`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(res.status).toBe(403);
  });

  it('bans with reason successfully', async () => {
    const db = createRoomsDb();
    mockJoinedWithPl();
    dbFns.getMembership
      .mockResolvedValueOnce(seedMembership())
      .mockResolvedValueOnce(seedMembership({ membership: 'join', eventId: '$t:example.com' }));
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/ban`,
      jsonInit('POST', { user_id: BOB, reason: 'abuse' })
    );
    expect(res.status).toBe(200);
    expect(dbFns.updateMembership).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      BOB,
      'ban',
      expect.any(String)
    );
    expect(dbFns.storeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        content: expect.objectContaining({ membership: 'ban', reason: 'abuse' }),
      })
    );
  });
});

describe('POST /_matrix/client/v3/rooms/:roomId/unban', () => {
  it('requires user_id', async () => {
    const db = createRoomsDb();
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/unban`, jsonInit('POST', {}));
    expect(res.status).toBe(400);
  });

  it('forbids when target is not banned', async () => {
    const db = createRoomsDb();
    mockJoinedWithPl();
    dbFns.getMembership
      .mockResolvedValueOnce(seedMembership())
      .mockResolvedValueOnce(seedMembership({ membership: 'leave' }));
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/unban`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toContain('not banned');
  });

  it('forbids insufficient unban power', async () => {
    const db = createRoomsDb();
    dbFns.getMembership
      .mockResolvedValueOnce(seedMembership())
      .mockResolvedValueOnce(seedMembership({ membership: 'ban' }));
    dbFns.getStateEvent.mockResolvedValue(
      seedState('m.room.power_levels', {
        users: { [USER]: 40 },
        ban: 50,
        users_default: 0,
      }) as unknown as PDU
    );
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/unban`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(res.status).toBe(403);
  });

  it('unbans successfully setting membership to leave', async () => {
    const db = createRoomsDb();
    mockJoinedWithPl();
    dbFns.getMembership
      .mockResolvedValueOnce(seedMembership())
      .mockResolvedValueOnce(seedMembership({ membership: 'ban', eventId: '$ban:example.com' }));
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/unban`,
      jsonInit('POST', { user_id: BOB, reason: 'appealed' })
    );
    expect(res.status).toBe(200);
    expect(dbFns.updateMembership).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      BOB,
      'leave',
      expect.any(String)
    );
  });
});

describe('POST /_matrix/client/v3/rooms/:roomId/forget', () => {
  it('cannot forget while still joined', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership({ membership: 'join' }));
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/forget`, jsonInit('POST', {}));
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toContain('Cannot forget');
  });

  it('forgets successfully and deletes membership row', async () => {
    const db = createRoomsDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    dbFns.getMembership.mockResolvedValue(seedMembership({ membership: 'leave' }));
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/forget`, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.membershipRows.find((m) => m.user_id === USER && m.room_id === ROOM)).toBeUndefined();
    expect(db.deletes.some((d) => d.sql.includes('DELETE FROM room_memberships'))).toBe(true);
  });

  it('forgets when no membership exists', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(null);
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/forget`, jsonInit('POST', {}));
    expect(res.status).toBe(200);
  });
});

describe('PUT /_matrix/client/v3/rooms/:roomId/redact/:eventId/:txnId', () => {
  it('forbids non-members', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(null);
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/txn1`,
      jsonInit('PUT', {})
    );
    expect(res.status).toBe(403);
  });

  it('returns not found for missing event', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getEvent.mockResolvedValue(null);
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/txn1`,
      jsonInit('PUT', {})
    );
    expect(res.status).toBe(404);
  });

  it('forbids redacting others event without redact PL', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getEvent.mockResolvedValue(seedPdu({ sender: BOB, event_id: EVENT }));
    dbFns.getStateEvent.mockResolvedValue(
      seedState('m.room.power_levels', {
        users: { [USER]: 10 },
        users_default: 0,
        redact: 50,
      }) as unknown as PDU
    );
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/txn1`,
      jsonInit('PUT', { reason: 'nope' })
    );
    expect(res.status).toBe(403);
  });

  it('allows redacting own event without redact PL', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getEvent.mockResolvedValue(seedPdu({ sender: USER, event_id: EVENT }));
    dbFns.getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.power_levels') {
        return seedState('m.room.power_levels', {
          users: { [USER]: 0 },
          users_default: 0,
          redact: 50,
        }) as unknown as PDU;
      }
      if (type === 'm.room.create') {
        return seedState('m.room.create', { creator: USER }) as unknown as PDU;
      }
      return null;
    });
    dbFns.getRoomEvents.mockResolvedValue({ events: [seedPdu()], end: 1 });
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/txn1`,
      jsonInit('PUT', { reason: 'typo' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event_id: expect.any(String) });
    expect(db.updates.some((u) => u.sql.includes('redacted_because'))).toBe(true);
  });

  it('redacts others event with sufficient PL and updates redacted_because', async () => {
    const db = createRoomsDb();
    mockJoinedWithPl();
    dbFns.getEvent.mockResolvedValue(seedPdu({ sender: BOB, event_id: EVENT }));
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/txn2`,
      jsonInit('PUT', { reason: 'mod' })
    );
    expect(res.status).toBe(200);
    expect(db.updates.some((u) => u.sql.includes('SET redacted_because'))).toBe(true);
    expect(dbFns.notifyUsersOfEvent).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      expect.any(String),
      'm.room.redaction'
    );
  });
});

describe('GET /_matrix/client/v3/rooms/:roomId/context/:eventId', () => {
  it('forbids non-members', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(null);
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/context/${EVENT_ENC}`);
    expect(res.status).toBe(403);
  });

  it('returns not found for missing event', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getEvent.mockResolvedValue(null);
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/context/${EVENT_ENC}`);
    expect(res.status).toBe(404);
  });

  it('returns context with before/after/state using dual-shape event', async () => {
    const db = createRoomsDb({
      events: [
        {
          event_id: '$before:example.com',
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          state_key: null,
          content: JSON.stringify({ body: 'before', msgtype: 'm.text' }),
          origin_server_ts: 1000,
        },
        {
          event_id: '$after:example.com',
          room_id: ROOM,
          sender: CAROL,
          event_type: 'm.room.message',
          state_key: null,
          content: JSON.stringify({ body: 'after', msgtype: 'm.text' }),
          origin_server_ts: 3000,
        },
      ],
    });
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getEvent.mockResolvedValue({
      event_id: EVENT,
      room_id: ROOM,
      sender: USER,
      type: 'm.room.message',
      event_type: 'm.room.message',
      state_key: null,
      content: JSON.stringify({ body: 'center', msgtype: 'm.text' }),
      origin_server_ts: 2000,
    } as unknown as PDU);
    dbFns.getRoomState.mockResolvedValue([
      seedState('m.room.name', { name: 'Ctx' }) as unknown as PDU,
    ]);
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/context/${EVENT_ENC}?limit=10`
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      event: { type: string; content: { body: string } };
      events_before: Array<{ event_id: string }>;
      events_after: Array<{ event_id: string }>;
      state: Array<{ type: string }>;
    };
    expect(body.event).toMatchObject({ type: 'm.room.message', content: { body: 'center' } });
    expect(body.events_before.map((e) => e.event_id)).toEqual(['$before:example.com']);
    expect(body.events_after.map((e) => e.event_id)).toEqual(['$after:example.com']);
    expect(body.state[0]).toMatchObject({ type: 'm.room.name' });
  });
});

describe('GET /_matrix/client/v3/rooms/:roomId/joined_members', () => {
  it('forbids non-members', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(null);
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/joined_members`);
    expect(res.status).toBe(403);
  });

  it('returns joined members with display names', async () => {
    const db = createRoomsDb({
      membershipRows: [
        {
          room_id: ROOM,
          user_id: USER,
          membership: 'join',
          display_name: 'Alice',
          avatar_url: 'mxc://example.com/a',
        },
        {
          room_id: ROOM,
          user_id: BOB,
          membership: 'join',
          display_name: 'Bob',
          avatar_url: null,
        },
        { room_id: ROOM, user_id: CAROL, membership: 'leave', display_name: 'Carol' },
      ],
    });
    dbFns.getMembership.mockResolvedValue(seedMembership());
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/joined_members`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      joined: {
        [USER]: { display_name: 'Alice', avatar_url: 'mxc://example.com/a' },
        [BOB]: { display_name: 'Bob' },
      },
    });
  });
});

describe('GET /_matrix/client/v3/rooms/:roomId/aliases', () => {
  it('forbids non-members', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(null);
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/aliases`);
    expect(res.status).toBe(403);
  });

  it('returns aliases for room', async () => {
    const db = createRoomsDb({
      aliasRows: [
        { alias: ALIAS, room_id: ROOM },
        { alias: '#other:example.com', room_id: ROOM },
      ],
    });
    dbFns.getMembership.mockResolvedValue(seedMembership());
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/aliases`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ aliases: [ALIAS, '#other:example.com'] });
  });
});


describe('POST /_matrix/client/v3/join/:roomIdOrAlias', () => {
  it('returns not found for missing alias', async () => {
    const db = createRoomsDb();
    dbFns.getRoomByAlias.mockResolvedValue(null);
    const res = await request(db, `/_matrix/client/v3/join/${ALIAS_ENC}`, jsonInit('POST', {}));
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toContain('alias');
  });

  it('returns not found for missing room id', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(null);
    const res = await request(db, `/_matrix/client/v3/join/${ROOM_ENC}`, jsonInit('POST', {}));
    expect(res.status).toBe(404);
  });

  it('returns room_id when already joined', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(seedRoom());
    dbFns.getMembership.mockResolvedValue(seedMembership({ membership: 'join' }));
    dbFns.getStateEvent.mockResolvedValue(
      seedState('m.room.join_rules', { join_rule: 'invite' }) as unknown as PDU
    );
    const res = await request(db, `/_matrix/client/v3/join/${ROOM_ENC}`, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM });
  });

  it('forbids invite-only without invite', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(seedRoom());
    dbFns.getMembership.mockResolvedValue(null);
    dbFns.getStateEvent.mockResolvedValue(
      seedState('m.room.join_rules', { join_rule: 'invite' }) as unknown as PDU
    );
    const res = await request(db, `/_matrix/client/v3/join/${ROOM_ENC}`, jsonInit('POST', {}));
    expect(res.status).toBe(403);
  });

  it('joins successfully by room id when public', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(seedRoom());
    dbFns.getMembership.mockResolvedValue(null);
    dbFns.getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.join_rules') {
        return seedState('m.room.join_rules', { join_rule: 'public' }) as unknown as PDU;
      }
      return seedState(type, {}) as unknown as PDU;
    });
    dbFns.getRoomEvents.mockResolvedValue({ events: [seedPdu()], end: 1 });
    const res = await request(db, `/_matrix/client/v3/join/${ROOM_ENC}`, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM });
    expect(dbFns.storeEventIdempotent).toHaveBeenCalled();
    expect(dbFns.tryInsertJoinMembership).toHaveBeenCalled();
  });

  it('joins successfully by alias', async () => {
    const db = createRoomsDb();
    dbFns.getRoomByAlias.mockResolvedValue(ROOM);
    dbFns.getRoom.mockResolvedValue(seedRoom());
    dbFns.getMembership.mockResolvedValue(seedMembership({ membership: 'invite' }));
    dbFns.getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.join_rules') {
        return seedState('m.room.join_rules', { join_rule: 'invite' }) as unknown as PDU;
      }
      return seedState(type, {}) as unknown as PDU;
    });
    dbFns.getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    const res = await request(db, `/_matrix/client/v3/join/${ALIAS_ENC}`, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM });
  });
});

describe('directory room alias GET/PUT/DELETE', () => {
  it('GET returns not found for missing alias', async () => {
    const db = createRoomsDb();
    dbFns.getRoomByAlias.mockResolvedValue(null);
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(res.status).toBe(404);
  });

  it('GET resolves alias successfully', async () => {
    const db = createRoomsDb();
    dbFns.getRoomByAlias.mockResolvedValue(ROOM);
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM, servers: [SERVER] });
  });

  it('PUT rejects bad JSON', async () => {
    const db = createRoomsDb();
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: 'x',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('PUT requires room_id', async () => {
    const db = createRoomsDb();
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('PUT', {})
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('PUT rejects alias already in use', async () => {
    const db = createRoomsDb();
    dbFns.getRoomByAlias.mockResolvedValue(ROOM);
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_ROOM_IN_USE' });
  });

  it('PUT forbids non-members', async () => {
    const db = createRoomsDb();
    dbFns.getRoomByAlias.mockResolvedValue(null);
    dbFns.getMembership.mockResolvedValue(null);
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(res.status).toBe(403);
  });

  it('PUT creates alias when member', async () => {
    const db = createRoomsDb();
    dbFns.getRoomByAlias.mockResolvedValue(null);
    dbFns.getMembership.mockResolvedValue(seedMembership());
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(res.status).toBe(200);
    expect(dbFns.createRoomAlias).toHaveBeenCalledWith(expect.anything(), ALIAS, ROOM, USER);
  });

  it('DELETE returns not found for missing alias', async () => {
    const db = createRoomsDb();
    dbFns.getRoomByAlias.mockResolvedValue(null);
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(404);
  });

  it('DELETE removes existing alias', async () => {
    const db = createRoomsDb();
    dbFns.getRoomByAlias.mockResolvedValue(ROOM);
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('DELETE')
    );
    expect(res.status).toBe(200);
    expect(dbFns.deleteRoomAlias).toHaveBeenCalledWith(expect.anything(), ALIAS);
  });
});

describe('GET /_matrix/client/v1/room_summary/:roomIdOrAlias', () => {
  it('returns not found for missing alias', async () => {
    const db = createRoomsDb({ aliasRows: [] });
    const res = await request(db, `/_matrix/client/v1/room_summary/${ALIAS_ENC}`);
    expect(res.status).toBe(404);
  });

  it('returns not found for missing room', async () => {
    const db = createRoomsDb({ roomRows: [] });
    const res = await request(db, `/_matrix/client/v1/room_summary/${ROOM_ENC}`);
    expect(res.status).toBe(404);
  });

  it('hides private invite-only rooms from anonymous callers', async () => {
    const db = createRoomsDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      stateRows: [
        { event_type: 'm.room.join_rules', content: JSON.stringify({ join_rule: 'invite' }) },
        {
          event_type: 'm.room.history_visibility',
          content: JSON.stringify({ history_visibility: 'shared' }),
        },
      ],
    });
    const res = await request(db, `/_matrix/client/v1/room_summary/${ROOM_ENC}`, {
      method: 'GET',
    });
    expect(res.status).toBe(404);
  });

  it('returns summary for public rooms', async () => {
    const db = createRoomsDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 1 }],
      membershipRows: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: ROOM, user_id: BOB, membership: 'join' },
      ],
      stateRows: [
        { event_type: 'm.room.name', content: JSON.stringify({ name: 'Public' }) },
        { event_type: 'm.room.topic', content: JSON.stringify({ topic: 'hi' }) },
        { event_type: 'm.room.avatar', content: JSON.stringify({ url: 'mxc://x/y' }) },
        { event_type: 'm.room.join_rules', content: JSON.stringify({ join_rule: 'public' }) },
        {
          event_type: 'm.room.canonical_alias',
          content: JSON.stringify({ alias: ALIAS }),
        },
        {
          event_type: 'm.room.encryption',
          content: JSON.stringify({ algorithm: 'm.megolm.v1.aes-sha2' }),
        },
        {
          event_type: 'm.room.history_visibility',
          content: JSON.stringify({ history_visibility: 'shared' }),
        },
        {
          event_type: 'm.room.guest_access',
          content: JSON.stringify({ guest_access: 'can_join' }),
        },
      ],
      aliasRows: [{ alias: ALIAS, room_id: ROOM }],
    });
    const res = await request(db, `/_matrix/client/v1/room_summary/${ALIAS_ENC}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      room_id: ROOM,
      name: 'Public',
      topic: 'hi',
      avatar_url: 'mxc://x/y',
      join_rule: 'public',
      canonical_alias: ALIAS,
      encryption: 'm.megolm.v1.aes-sha2',
      num_joined_members: 2,
      world_readable: false,
      guest_can_join: true,
      room_version: '10',
    });
  });

  it('allows private rooms with knock join_rule', async () => {
    const db = createRoomsDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      stateRows: [
        { event_type: 'm.room.join_rules', content: JSON.stringify({ join_rule: 'knock' }) },
        {
          event_type: 'm.room.history_visibility',
          content: JSON.stringify({ history_visibility: 'shared' }),
        },
      ],
    });
    const res = await request(db, `/_matrix/client/v1/room_summary/${ROOM_ENC}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ room_id: ROOM, join_rule: 'knock' });
  });

  it('allows private world_readable rooms', async () => {
    const db = createRoomsDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      stateRows: [
        { event_type: 'm.room.join_rules', content: JSON.stringify({ join_rule: 'invite' }) },
        {
          event_type: 'm.room.history_visibility',
          content: JSON.stringify({ history_visibility: 'world_readable' }),
        },
      ],
    });
    const res = await request(db, `/_matrix/client/v1/room_summary/${ROOM_ENC}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ world_readable: true });
  });

  it('includes membership when Authorization Bearer token matches', async () => {
    const token = 'summary-auth-token';
    const tokenHash = await hashToken(token);
    const db = createRoomsDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      stateRows: [
        { event_type: 'm.room.join_rules', content: JSON.stringify({ join_rule: 'invite' }) },
        {
          event_type: 'm.room.history_visibility',
          content: JSON.stringify({ history_visibility: 'shared' }),
        },
      ],
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      accessTokens: [{ token_hash: tokenHash, user_id: USER }],
    });
    const res = await request(db, `/_matrix/client/v1/room_summary/${ROOM_ENC}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ membership: 'join', room_id: ROOM });
  });
});

describe('GET /_matrix/client/v3/rooms/:roomId/timestamp_to_event', () => {
  it('requires ts param', async () => {
    const db = createRoomsDb();
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?dir=f`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('requires dir param', async () => {
    const db = createRoomsDb();
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=1`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('rejects invalid ts', async () => {
    const db = createRoomsDb();
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=abc&dir=f`
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('rejects invalid dir', async () => {
    const db = createRoomsDb();
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=1&dir=sideways`
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('forbids non-members', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(null);
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=1000&dir=f`
    );
    expect(res.status).toBe(403);
  });

  it('finds forward hit', async () => {
    const db = createRoomsDb({
      events: [
        {
          event_id: '$f1:example.com',
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.message',
          state_key: null,
          content: '{}',
          origin_server_ts: 1500,
        },
        {
          event_id: '$f2:example.com',
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.message',
          state_key: null,
          content: '{}',
          origin_server_ts: 2500,
        },
      ],
    });
    dbFns.getMembership.mockResolvedValue(seedMembership());
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=2000&dir=f`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ event_id: '$f2:example.com', origin_server_ts: 2500 });
  });

  it('finds backward hit', async () => {
    const db = createRoomsDb({
      events: [
        {
          event_id: '$b1:example.com',
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.message',
          state_key: null,
          content: '{}',
          origin_server_ts: 1500,
        },
        {
          event_id: '$b2:example.com',
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.message',
          state_key: null,
          content: '{}',
          origin_server_ts: 2500,
        },
      ],
    });
    dbFns.getMembership.mockResolvedValue(seedMembership());
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=2000&dir=b`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ event_id: '$b1:example.com', origin_server_ts: 1500 });
  });

  it('returns not found on miss', async () => {
    const db = createRoomsDb({ events: [] });
    dbFns.getMembership.mockResolvedValue(seedMembership());
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=9999&dir=f`
    );
    expect(res.status).toBe(404);
  });
});


describe('POST /_matrix/client/v3/rooms/:roomId/upgrade', () => {
  it('rejects bad JSON', async () => {
    const db = createRoomsDb();
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: 'nope',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('requires new_version', async () => {
    const db = createRoomsDb();
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`,
      jsonInit('POST', {})
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('rejects unsupported room version', async () => {
    const db = createRoomsDb();
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`,
      jsonInit('POST', { new_version: '99' })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_UNSUPPORTED_ROOM_VERSION' });
  });

  it('returns not found when room missing', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(null);
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`,
      jsonInit('POST', { new_version: '11' })
    );
    expect(res.status).toBe(404);
  });

  it('forbids non-members', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(seedRoom());
    dbFns.getMembership.mockResolvedValue(null);
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`,
      jsonInit('POST', { new_version: '11' })
    );
    expect(res.status).toBe(403);
  });

  it('forbids insufficient tombstone power level', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(seedRoom());
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getStateEvent.mockResolvedValue(
      seedState('m.room.power_levels', {
        users: { [USER]: 50 },
        users_default: 0,
        state_default: 50,
        events: { 'm.room.tombstone': 100 },
      }) as unknown as PDU
    );
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`,
      jsonInit('POST', { new_version: '11' })
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toContain('Insufficient power level to upgrade');
  });

  it('upgrades successfully creating replacement and migrating aliases', async () => {
    const db = createRoomsDb({
      aliasRows: [
        { alias: ALIAS, room_id: ROOM },
        { alias: '#extra:example.com', room_id: ROOM },
      ],
      events: [
        {
          event_id: '$last:example.com',
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.message',
          state_key: null,
          content: '{}',
          origin_server_ts: 5000,
          depth: 9,
        },
      ],
    });
    dbFns.getRoom.mockResolvedValue(seedRoom());
    dbFns.getMembership.mockResolvedValue(seedMembership());
    const pl = defaultPl({ events: { 'm.room.tombstone': 100, 'm.room.name': 50 } });
    dbFns.getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.power_levels') {
        return seedState('m.room.power_levels', pl, { event_id: '$pl:example.com' }) as unknown as PDU;
      }
      return null;
    });
    dbFns.getRoomState.mockResolvedValue([
      seedState('m.room.create', { creator: USER }) as unknown as PDU,
      seedState('m.room.power_levels', pl) as unknown as PDU,
      seedState('m.room.join_rules', { join_rule: 'invite' }) as unknown as PDU,
      seedState('m.room.history_visibility', { history_visibility: 'shared' }) as unknown as PDU,
      seedState('m.room.name', { name: 'Old Room' }) as unknown as PDU,
      seedState('m.room.topic', { topic: 't' }) as unknown as PDU,
      seedState('m.room.avatar', { url: 'mxc://a/b' }) as unknown as PDU,
      seedState('m.room.encryption', { algorithm: 'm.megolm.v1.aes-sha2' }) as unknown as PDU,
      seedState('m.room.guest_access', { guest_access: 'forbidden' }) as unknown as PDU,
      seedState('m.room.member', { membership: 'join' }, { state_key: USER }) as unknown as PDU,
    ]);

    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`,
      jsonInit('POST', { new_version: '11' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ replacement_room: `!pinnedroom:${SERVER}` });
    expect(dbFns.createRoom).toHaveBeenCalledWith(
      expect.anything(),
      `!pinnedroom:${SERVER}`,
      '11',
      USER,
      false
    );
    expect(dbFns.storeEvent).toHaveBeenCalled();
    expect(dbFns.updateMembership).toHaveBeenCalledWith(
      expect.anything(),
      `!pinnedroom:${SERVER}`,
      USER,
      'join',
      expect.any(String)
    );
    expect(db.aliasRows.every((a) => a.room_id === `!pinnedroom:${SERVER}`)).toBe(true);
    expect(db.updates.some((u) => u.sql.includes('UPDATE room_aliases SET room_id'))).toBe(true);

    const tombstoneCall = dbFns.storeEvent.mock.calls.find(
      (call) => (call[1] as PDU).type === 'm.room.tombstone'
    );
    expect(tombstoneCall).toBeTruthy();
    expect((tombstoneCall![1] as PDU).content).toMatchObject({
      replacement_room: `!pinnedroom:${SERVER}`,
    });
  });

  it('forbids upgrade when power levels event is missing (null PL)', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(seedRoom());
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getStateEvent.mockResolvedValue(null);
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`,
      jsonInit('POST', { new_version: '11' })
    );
    expect(res.status).toBe(403);
  });

  it('upgrades using default join_rules/history when those state events are absent', async () => {
    const db = createRoomsDb({
      events: [
        {
          event_id: '$pred:example.com',
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.message',
          state_key: null,
          content: '{}',
          origin_server_ts: 1,
          depth: 1,
        },
      ],
    });
    dbFns.getRoom.mockResolvedValue(seedRoom());
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getStateEvent.mockResolvedValue(
      seedState(
        'm.room.power_levels',
        { users: { [USER]: 100 }, users_default: 0, events: { 'm.room.tombstone': 100 } },
        { event_id: '$pl:example.com' }
      ) as unknown as PDU
    );
    dbFns.getRoomState.mockResolvedValue([
      seedState('m.room.create', { creator: USER }) as unknown as PDU,
      seedState('m.room.member', { membership: 'join' }, { state_key: USER }) as unknown as PDU,
    ]);
    const ok = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`,
      jsonInit('POST', { new_version: '10' })
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ replacement_room: `!pinnedroom:${SERVER}` });
    const joinRuleStored = dbFns.storeEvent.mock.calls.some(
      (call) =>
        (call[1] as PDU).type === 'm.room.join_rules' &&
        (call[1] as PDU).room_id === `!pinnedroom:${SERVER}` &&
        ((call[1] as PDU).content as { join_rule: string }).join_rule === 'invite'
    );
    expect(joinRuleStored).toBe(true);
  });

  
  it('restricts old room power levels after successful upgrade', async () => {
    const db = createRoomsDb({
      events: [
        {
          event_id: '$e:example.com',
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.message',
          state_key: null,
          content: '{}',
          origin_server_ts: 1,
          depth: 3,
        },
      ],
    });
    dbFns.getRoom.mockResolvedValue(seedRoom());
    dbFns.getMembership.mockResolvedValue(seedMembership());
    // Provide a PL that is truthy for the gate; the else-defaults branch for NEW room
    // PL is skipped. Cover the restrict-event defaults when we use a normal PL instead.
    dbFns.getStateEvent.mockResolvedValue(
      seedState('m.room.power_levels', {
        users: { [USER]: 100 },
        events: { 'm.room.tombstone': 50 },
      }) as unknown as PDU
    );
    dbFns.getRoomState.mockResolvedValue([
      seedState('m.room.create', { creator: USER }) as unknown as PDU,
      seedState('m.room.member', { membership: 'join' }, { state_key: USER }) as unknown as PDU,
    ]);
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`,
      jsonInit('POST', { new_version: '11' })
    );
    expect(res.status).toBe(200);
    const restrict = dbFns.storeEvent.mock.calls.find(
      (call) =>
        (call[1] as PDU).type === 'm.room.power_levels' &&
        (call[1] as PDU).room_id === ROOM &&
        ((call[1] as PDU).content as { events_default?: number }).events_default === 100
    );
    expect(restrict).toBeTruthy();
  });
});

describe('rooms API misc edge coverage', () => {
  it('createRoom with trusted_private_chat preset succeeds', async () => {
    const db = createRoomsDb();
    const res = await request(
      db,
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { preset: 'trusted_private_chat', name: 'DM' })
    );
    expect(res.status).toBe(200);
    expect((res.body as { room_id: string }).room_id).toBe(`!pinnedroom:${SERVER}`);
  });

  it('createRoom rejects empty-string type in initial_state', async () => {
    const db = createRoomsDb();
    const res = await request(
      db,
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { initial_state: [{ type: '   ', content: { a: 1 } }] })
    );
    expect(res.status).toBe(400);
  });

  it('join notifies when only membership insert is new', async () => {
    const db = createRoomsDb();
    dbFns.getRoom.mockResolvedValue(seedRoom());
    dbFns.getMembership.mockResolvedValue(null);
    dbFns.getStateEvent.mockImplementation(async (_db, _r, type: string) => {
      if (type === 'm.room.join_rules') {
        return seedState('m.room.join_rules', { join_rule: 'public' }) as unknown as PDU;
      }
      return seedState(type, {}) as unknown as PDU;
    });
    dbFns.getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    dbFns.storeEventIdempotent.mockResolvedValue({ inserted: false, eventId: '$exist:example.com' });
    dbFns.tryInsertJoinMembership.mockResolvedValue({ inserted: true, eventId: '$exist:example.com' });
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/join`, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(dbFns.notifyUsersOfEvent).toHaveBeenCalled();
  });

  it('kick rejects bad JSON', async () => {
    const db = createRoomsDb();
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/kick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: 'x',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('ban rejects bad JSON', async () => {
    const db = createRoomsDb();
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/ban`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: 'x',
    });
    expect(res.status).toBe(400);
  });

  it('unban rejects bad JSON and forbids non-member unbanner', async () => {
    const db = createRoomsDb();
    const bad = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/unban`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: 'x',
    });
    expect(bad.status).toBe(400);

    dbFns.getMembership.mockResolvedValue(null);
    const forbidden = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/unban`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(forbidden.status).toBe(403);
  });

  it('redact accepts empty body when JSON parse fails', async () => {
    const db = createRoomsDb();
    mockJoinedWithPl();
    dbFns.getEvent.mockResolvedValue(seedPdu({ sender: USER, event_id: EVENT }));
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/txn`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: 'not-json',
    });
    expect(res.status).toBe(200);
  });

  it('GET event rejects event from wrong room even if found', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getEvent.mockResolvedValue(seedPdu({ room_id: '!nope:example.com', event_id: EVENT }));
    const res = await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/event/${EVENT_ENC}`);
    expect(res.status).toBe(404);
  });

  it('messages treats non-numeric from token as undefined', async () => {
    const db = createRoomsDb();
    dbFns.getMembership.mockResolvedValue(seedMembership());
    dbFns.getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    await request(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/messages?from=snotanumber`);
    expect(dbFns.getRoomEvents).toHaveBeenCalledWith(expect.anything(), ROOM, undefined, 10, 'b');
  });

  it('PUT state without stateKey uses empty string', async () => {
    const db = createRoomsDb();
    mockJoinedWithPl();
    const res = await request(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.avatar`,
      jsonInit('PUT', { url: 'mxc://example.com/z' })
    );
    expect(res.status).toBe(200);
    expect(dbFns.storeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'm.room.avatar', state_key: '' })
    );
  });

  it('generateRoomId mock is used by createRoom', async () => {
    const db = createRoomsDb();
    await request(db, '/_matrix/client/v3/createRoom', jsonInit('POST', {}));
    expect(generateRoomId).toHaveBeenCalledWith(SERVER);
    expect(generateEventId).toHaveBeenCalled();
  });
});
