/**
 * TOKENMAXX HEAVY deepen — rooms client API HTTP routes.
 * Different slice than media (#109), account/admin/login/keys (#99–#111).
 * Avoids validateStateEvent-only coverage (rooms-initial-state) and aliases
 * directory sibling module (aliases-api-routes).
 * Tests-only — no product inventing.
 * Exercises create/join/leave/knock/state/messages/send/moderation/directory/
 * summary/timestamp/upgrade membership gates, PL checks, and SQL edges.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, PDU } from '../src/types';
import { hashToken } from '../src/utils/crypto';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICEA');
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
const REMOTE_ROOM = '!room:remote.org';
const REMOTE_ENC = encodeURIComponent(REMOTE_ROOM);
const ALIAS = '#general:example.com';
const ALIAS_ENC = encodeURIComponent(ALIAS);
const EVENT = '$msg1:example.com';
const EVENT_ENC = encodeURIComponent(EVENT);
const NOW = 1_700_000_000_000;

type SqlCall = { sql: string; args: unknown[] };

type Membership = { membership: string; eventId: string };

type StateMap = Record<string, PDU | null>;

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
  summaryState?: Array<{ event_type: string; content: string }>;
  memberCount?: number;
  accessTokens?: Array<{ token_hash: string; user_id: string }>;
  tokenMembership?: { membership: string } | null;
  contextBefore?: Array<Record<string, unknown>>;
  contextAfter?: Array<Record<string, unknown>>;
  tsEvents?: Array<{ event_id: string; origin_server_ts: number; room_id: string }>;
  lastEvent?: { event_id: string; depth: number } | null;
};

function createSqlDb(opts: DbOpts = {}) {
  let streamPosition = opts.streamPosition ?? 10;
  const knocks = opts.knocks ?? [];
  const membershipRows = opts.membershipRows ?? [];
  const aliasRows = opts.aliasRows ?? [];
  const roomRows = opts.roomRows ?? [];
  const summaryState = opts.summaryState ?? [];
  const memberCount = opts.memberCount ?? 0;
  const accessTokens = opts.accessTokens ?? [];
  const tokenMembership = opts.tokenMembership ?? null;
  const contextBefore = opts.contextBefore ?? [];
  const contextAfter = opts.contextAfter ?? [];
  const tsEvents = opts.tsEvents ?? [];
  const lastEvent = opts.lastEvent ?? { event_id: '$last:example.com', depth: 5 };
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const selects: SqlCall[] = [];
  const batches: unknown[][] = [];

  const db = {
    inserts,
    updates,
    deletes,
    selects,
    batches,
    knocks,
    membershipRows,
    aliasRows,
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

              if (sql.includes('SELECT COUNT(*) as count FROM room_memberships')) {
                return { count: memberCount } as T;
              }

              if (sql.includes('SELECT user_id FROM access_tokens WHERE token_hash = ?')) {
                const hash = args[0] as string;
                const row = accessTokens.find((t) => t.token_hash === hash);
                return (row ? { user_id: row.user_id } : null) as T;
              }

              if (
                sql.includes('SELECT membership FROM room_memberships') &&
                sql.includes('user_id = ?')
              ) {
                return tokenMembership as T;
              }

              if (
                sql.includes('SELECT event_id, origin_server_ts') &&
                sql.includes('origin_server_ts >= ?')
              ) {
                const [roomId, ts] = args as [string, number];
                const hit = tsEvents
                  .filter((e) => e.room_id === roomId && e.origin_server_ts >= ts)
                  .sort((a, b) => a.origin_server_ts - b.origin_server_ts)[0];
                return (hit
                  ? { event_id: hit.event_id, origin_server_ts: hit.origin_server_ts }
                  : null) as T;
              }

              if (
                sql.includes('SELECT event_id, origin_server_ts') &&
                sql.includes('origin_server_ts <= ?')
              ) {
                const [roomId, ts] = args as [string, number];
                const hit = tsEvents
                  .filter((e) => e.room_id === roomId && e.origin_server_ts <= ts)
                  .sort((a, b) => b.origin_server_ts - a.origin_server_ts)[0];
                return (hit
                  ? { event_id: hit.event_id, origin_server_ts: hit.origin_server_ts }
                  : null) as T;
              }

              if (
                sql.includes('SELECT event_id FROM events WHERE room_id = ? ORDER BY depth DESC')
              ) {
                return (lastEvent ? { event_id: lastEvent.event_id } : null) as T;
              }

              if (
                sql.includes('SELECT event_id, depth FROM events WHERE room_id = ? ORDER BY depth DESC')
              ) {
                return (lastEvent
                  ? { event_id: lastEvent.event_id, depth: lastEvent.depth }
                  : null) as T;
              }

              return null as T;
            },

            async all<T>() {
              selects.push({ sql, args });

              if (
                sql.includes('SELECT e.event_type, e.content FROM room_state') ||
                sql.includes("rs.event_type IN")
              ) {
                return { results: summaryState as T[] };
              }

              if (
                sql.includes('SELECT user_id, display_name, avatar_url') &&
                sql.includes("membership = 'join'")
              ) {
                const roomId = args[0] as string;
                return {
                  results: membershipRows
                    .filter((m) => m.room_id === roomId && m.membership === 'join')
                    .map((m) => ({
                      user_id: m.user_id,
                      display_name: m.display_name ?? null,
                      avatar_url: m.avatar_url ?? null,
                    })) as T[],
                };
              }

              if (sql.includes('SELECT alias FROM room_aliases WHERE room_id = ?')) {
                const roomId = args[0] as string;
                return {
                  results: aliasRows
                    .filter((a) => a.room_id === roomId)
                    .map((a) => ({ alias: a.alias })) as T[],
                };
              }

              if (
                sql.includes('SELECT * FROM events') &&
                sql.includes('origin_server_ts < ?')
              ) {
                return { results: contextBefore as T[] };
              }

              if (
                sql.includes('SELECT * FROM events') &&
                sql.includes('origin_server_ts > ?')
              ) {
                return { results: contextAfter as T[] };
              }

              return { results: [] as T[] };
            },

            async run() {
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
                if (sql.includes('UPDATE room_aliases SET room_id')) {
                  const [newRoomId, alias] = args as string[];
                  const row = aliasRows.find((a) => a.alias === alias);
                  if (row) row.room_id = newRoomId;
                }
              } else if (sql.trimStart().startsWith('DELETE')) {
                deletes.push({ sql, args });
                if (sql.includes('DELETE FROM room_memberships')) {
                  const [roomId, userId] = args as string[];
                  const idx = membershipRows.findIndex(
                    (m) => m.room_id === roomId && m.user_id === userId
                  );
                  if (idx >= 0) membershipRows.splice(idx, 1);
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
  return {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
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

function createWorkflowStub(status: {
  status: string;
  output?: unknown;
}) {
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
  } = {}
): Env {
  return {
    DB: db as unknown as D1Database,
    CACHE: mockKv(),
    SERVER_NAME: SERVER,
    ROOM_JOIN_WORKFLOW: (extras.workflow ??
      createWorkflowStub({ status: 'complete', output: { success: true } })) as unknown as Env['ROOM_JOIN_WORKFLOW'],
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
  db: SqlDb;
  execCtx: ReturnType<typeof createExecCtx>;
  env: Env;
}> {
  const env = envFor(db, extras);
  const res = await rooms.request(`http://localhost${path}`, init, env, execCtx as never);
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, db, execCtx, env };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function joinMembership(eventId = '$alice-join'): Membership {
  return { membership: 'join', eventId };
}

function pdu(
  overrides: Partial<PDU> & { type: string; event_id: string }
): PDU {
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
        content: {
          users: { [USER]: 100 },
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
          },
        },
        state_key: '',
      }),
    };
    return defaults[type] ?? null;
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);

  createRoom.mockReset().mockResolvedValue(undefined);
  getRoom.mockReset();
  storeEvent.mockReset().mockResolvedValue(1);
  storeEventIdempotent.mockReset().mockResolvedValue({ inserted: true, eventId: '$detjoin:example.com' });
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
  generateEventId.mockReset().mockResolvedValue('$evt:example.com');
  generateDeterministicEventId.mockReset().mockResolvedValue('$detjoin:example.com');

  defaultState();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /createRoom', () => {
  it('rejects bad JSON', async () => {
    const { status, body } = await request('/_matrix/client/v3/createRoom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: '{',
    });
    expect(status).toBe(400);
    expect(body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('rejects non-array initial_state', async () => {
    const { status, body } = await request(
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { initial_state: { type: 'm.room.name' } })
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({
      errcode: 'M_INVALID_PARAM',
      error: 'initial_state must be an array',
    });
  });

  it('rejects duplicate encryption in initial_state', async () => {
    const enc = {
      type: 'm.room.encryption',
      content: { algorithm: 'm.megolm.v1.aes-sha2' },
    };
    const { status, body } = await request(
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { initial_state: [enc, enc] })
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({
      errcode: 'M_INVALID_PARAM',
      error: expect.stringMatching(/multiple m\.room\.encryption/),
    });
  });

  it('rejects invalid initial_state event via validateStateEvent', async () => {
    const { status, body } = await request(
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', {
        initial_state: [{ type: 'm.room.create', content: { creator: USER } }],
      })
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({
      errcode: 'M_INVALID_PARAM',
      error: expect.stringMatching(/cannot be set via initial_state/),
    });
  });

  it('rejects unsupported room_version', async () => {
    const { status, body } = await request(
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { room_version: '999' })
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ errcode: 'M_UNSUPPORTED_ROOM_VERSION' });
  });

  it('rejects alias already in use', async () => {
    getRoomByAlias.mockResolvedValue(ROOM);
    const { status, body } = await request(
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { room_alias_local_part: 'general' })
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ errcode: 'M_ROOM_IN_USE' });
    expect(getRoomByAlias).toHaveBeenCalledWith(
      expect.anything(),
      '#general:example.com'
    );
  });

  it('creates room with name/topic/preset/alias and notifies sync', async () => {
    const db = createSqlDb();
    const { status, body } = await request(
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', {
        name: 'General',
        topic: 'hello',
        preset: 'public_chat',
        visibility: 'public',
        room_alias_local_part: 'general',
        invite: [BOB],
        initial_state: [
          {
            type: 'm.room.encryption',
            content: { algorithm: 'm.megolm.v1.aes-sha2' },
          },
        ],
      }),
      db
    );

    expect(status).toBe(200);
    expect(body).toEqual({
      room_id: '!newroom:example.com',
      room_alias: '#general:example.com',
    });
    expect(createRoom).toHaveBeenCalledWith(
      expect.anything(),
      '!newroom:example.com',
      expect.any(String),
      USER,
      true
    );
    expect(db.batches.length).toBe(1);
    expect(db.inserts.some((i) => i.sql.includes('account_data'))).toBe(true);
    expect(createRoomAlias).toHaveBeenCalledWith(
      expect.anything(),
      '#general:example.com',
      '!newroom:example.com',
      USER
    );
    expect(notifyUsersOfEvent).toHaveBeenCalledWith(
      expect.anything(),
      '!newroom:example.com',
      '!newroom:example.com',
      'm.room.create'
    );
  });

  it('rolls back rooms row when initial events batch fails', async () => {
    const db = createSqlDb({ batchError: new Error('batch boom') });
    const { status, body } = await request(
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { name: 'X' }),
      db
    );
    expect(status).toBe(500);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN' });
    expect(db.deletes.some((d) => d.sql.includes('DELETE FROM rooms'))).toBe(true);
  });

  it('returns M_TOO_LARGE when validateEventSize throws with errcode', async () => {
    const tooLarge = Object.assign(new Error('payload too big'), {
      errcode: 'M_TOO_LARGE',
    });
    validateEventSize.mockImplementation(() => {
      throw tooLarge;
    });
    const { status, body } = await request(
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { name: 'X' })
    );
    expect(status).toBe(413);
    expect(body).toMatchObject({ errcode: 'M_TOO_LARGE' });
  });
});

describe('GET /joined_rooms', () => {
  it('returns joined rooms from getUserRooms', async () => {
    getUserRooms.mockResolvedValue([ROOM, '!other:example.com']);
    const { status, body } = await request('/_matrix/client/v3/joined_rooms');
    expect(status).toBe(200);
    expect(body).toEqual({ joined_rooms: [ROOM, '!other:example.com'] });
    expect(getUserRooms).toHaveBeenCalledWith(expect.anything(), USER, 'join');
  });
});

describe('POST /rooms/:roomId/join', () => {
  it('404 when local room missing', async () => {
    getRoom.mockResolvedValue(null);
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/join`,
      jsonInit('POST', {})
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('returns room_id when already joined', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/join`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({ room_id: ROOM });
    expect(storeEventIdempotent).not.toHaveBeenCalled();
  });

  it('forbids join when invite-only and not invited', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(null);
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/join`,
      jsonInit('POST', {})
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('joins public room and notifies on new insert', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(null);
    getRoomEvents.mockResolvedValue({
      events: [pdu({ type: 'm.room.message', event_id: '$prev', depth: 3 })],
      end: 3,
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/join`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({ room_id: ROOM });
    expect(generateDeterministicEventId).toHaveBeenCalled();
    expect(storeEventIdempotent).toHaveBeenCalled();
    expect(tryInsertJoinMembership).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      USER,
      '$detjoin:example.com'
    );
    expect(notifyUsersOfEvent).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      '$detjoin:example.com',
      'm.room.member'
    );
  });

  it('joins when invited to invite-only room; skips notify on duplicate', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue({ membership: 'invite', eventId: '$invite' });
    storeEventIdempotent.mockResolvedValue({
      inserted: false,
      eventId: '$detjoin:example.com',
    });
    tryInsertJoinMembership.mockResolvedValue({
      inserted: false,
      eventId: '$detjoin:example.com',
    });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/join`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(notifyUsersOfEvent).not.toHaveBeenCalled();
  });

  it('remote missing room: returns room_id while workflow running', async () => {
    getRoom.mockResolvedValue(null);
    const workflow = createWorkflowStub({ status: 'running' });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${REMOTE_ENC}/join`,
      jsonInit('POST', {}),
      createSqlDb(),
      { workflow }
    );
    expect(status).toBe(200);
    expect(body).toEqual({ room_id: REMOTE_ROOM });
    expect(workflow.creates[0]).toMatchObject({
      params: {
        roomId: REMOTE_ROOM,
        userId: USER,
        isRemote: true,
        remoteServer: 'remote.org',
      },
    });
  });

  it('remote missing room: succeeds when workflow complete+success', async () => {
    getRoom.mockResolvedValue(null);
    const workflow = createWorkflowStub({
      status: 'complete',
      output: { success: true },
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${REMOTE_ENC}/join`,
      jsonInit('POST', {}),
      createSqlDb(),
      { workflow }
    );
    expect(status).toBe(200);
    expect(body).toEqual({ room_id: REMOTE_ROOM });
  });

  it('remote missing room: 500 when workflow failed', async () => {
    getRoom.mockResolvedValue(null);
    const workflow = createWorkflowStub({
      status: 'complete',
      output: { success: false },
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${REMOTE_ENC}/join`,
      jsonInit('POST', {}),
      createSqlDb(),
      { workflow }
    );
    expect(status).toBe(500);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN' });
  });

  it('remote missing room: 500 when workflow.status throws', async () => {
    getRoom.mockResolvedValue(null);
    const workflow = {
      creates: [] as unknown[],
      async create(opts: unknown) {
        workflow.creates.push(opts);
        return {
          async status() {
            throw new Error('wf boom');
          },
        };
      },
    };
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${REMOTE_ENC}/join`,
      jsonInit('POST', {}),
      createSqlDb(),
      { workflow: workflow as never }
    );
    expect(status).toBe(500);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN' });
  });
});

describe('POST /rooms/:roomId/leave', () => {
  it('forbids leave when not joined', async () => {
    getMembership.mockResolvedValue({ membership: 'invite', eventId: '$i' });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/leave`,
      jsonInit('POST', {})
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('stores leave membership and notifies', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getRoomEvents.mockResolvedValue({
      events: [pdu({ type: 'm.room.message', event_id: '$p', depth: 2 })],
      end: 2,
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/leave`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(storeEvent).toHaveBeenCalled();
    const stored = storeEvent.mock.calls[0][1] as PDU;
    expect(stored).toMatchObject({
      type: 'm.room.member',
      state_key: USER,
      content: { membership: 'leave' },
      depth: 3,
    });
    expect(updateMembership).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      USER,
      'leave',
      '$evt:example.com'
    );
    expect(notifyUsersOfEvent).toHaveBeenCalled();
  });
});

describe('POST knock endpoints', () => {
  it('knock: 404 missing room', async () => {
    getRoom.mockResolvedValue(null);
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/knock`,
      jsonInit('POST', { reason: 'pls' })
    );
    expect(status).toBe(404);
  });

  it('knock: returns room_id when already joined', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(joinMembership());
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/knock`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({ room_id: ROOM });
    expect(storeEvent).not.toHaveBeenCalled();
  });

  it('knock: forbids banned users', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue({ membership: 'ban', eventId: '$b' });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/knock`,
      jsonInit('POST', {})
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: expect.stringMatching(/banned/i) });
  });

  it('knock: forbids when join_rule is not knock*', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(null);
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/knock`,
      jsonInit('POST', {})
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: expect.stringMatching(/does not allow knocking/) });
  });

  it('knock: stores knock + room_knocks row with reason', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(null);
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'knock' },
        state_key: '',
      }),
    });
    const db = createSqlDb();
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/knock`,
      jsonInit('POST', { reason: 'hello' }),
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual({ room_id: ROOM });
    expect(storeEvent).toHaveBeenCalled();
    expect(updateMembership).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      USER,
      'knock',
      '$evt:example.com'
    );
    expect(db.knocks).toEqual([{ room_id: ROOM, user_id: USER }]);
  });

  it('knock by alias: resolves alias then knocks', async () => {
    getRoomByAlias.mockResolvedValue(ROOM);
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(null);
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'knock_restricted' },
        state_key: '',
      }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/knock/${ALIAS_ENC}`,
      jsonInit('POST', { reason: 'via alias' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ room_id: ROOM });
    expect(getRoomByAlias).toHaveBeenCalledWith(expect.anything(), ALIAS);
  });

  it('knock by alias: 404 when alias missing', async () => {
    getRoomByAlias.mockResolvedValue(null);
    const { status } = await request(
      `/_matrix/client/v3/knock/${ALIAS_ENC}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(404);
  });

  it('knock by alias: accepts empty body', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(null);
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'knock' },
        state_key: '',
      }),
    });
    const { status } = await request(`/_matrix/client/v3/knock/${ROOM_ENC}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
      body: 'not-json',
    });
    expect(status).toBe(200);
  });
});

describe('GET/PUT room state', () => {
  it('GET state: forbids non-members', async () => {
    getMembership.mockResolvedValue(null);
    const { status } = await request(`/_matrix/client/v3/rooms/${ROOM_ENC}/state`);
    expect(status).toBe(403);
  });

  it('GET state: returns formatted state events', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getRoomState.mockResolvedValue([
      pdu({
        type: 'm.room.name',
        event_id: '$n',
        state_key: '',
        content: { name: 'R' },
      }),
    ]);
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state`
    );
    expect(status).toBe(200);
    expect(body).toEqual([
      expect.objectContaining({
        type: 'm.room.name',
        content: { name: 'R' },
        event_id: '$n',
        room_id: ROOM,
      }),
    ]);
  });

  it('GET specific state: 404 when missing', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getStateEvent.mockResolvedValue(null);
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`
    );
    expect(status).toBe(404);
  });

  it('GET specific state: returns content only', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getStateEvent.mockResolvedValue(
      pdu({
        type: 'm.room.name',
        event_id: '$n',
        content: { name: 'Lobby' },
        state_key: '',
      })
    );
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ name: 'Lobby' });
  });

  it('PUT state: bad JSON', async () => {
    getMembership.mockResolvedValue(joinMembership());
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: '{',
      }
    );
    expect(status).toBe(400);
  });

  it('PUT state: forbids insufficient power', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        content: { users: { [USER]: 10 }, state_default: 50, users_default: 0 },
        state_key: '',
      }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'Nope' })
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: expect.stringMatching(/power level/) });
  });

  it('PUT state: conflict when PL changes mid-request', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let plCalls = 0;
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$create', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        plCalls += 1;
        return pdu({
          type: 'm.room.power_levels',
          event_id: plCalls === 1 ? '$pl1' : '$pl2',
          content: { users: { [USER]: 100 }, state_default: 50 },
          state_key: '',
        });
      }
      if (type === 'm.room.name') return null;
      return null;
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'Race' })
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({ errcode: 'M_CONFLICT' });
    expect(storeEvent).not.toHaveBeenCalled();
  });

  it('PUT state: conflict when target slot changes mid-request', async () => {
    getMembership.mockResolvedValue(joinMembership());
    let nameCalls = 0;
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$create', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          content: { users: { [USER]: 100 }, state_default: 50 },
          state_key: '',
        });
      }
      if (type === 'm.room.name') {
        nameCalls += 1;
        return pdu({
          type: 'm.room.name',
          event_id: nameCalls === 1 ? '$n1' : '$n2',
          content: { name: 'old' },
          state_key: '',
        });
      }
      return null;
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'Race2' })
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({
      errcode: 'M_CONFLICT',
      error: expect.stringMatching(/m\.room\.name/),
    });
  });

  it('PUT state: stores event, bumps cache for name, notifies', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getRoomEvents.mockResolvedValue({
      events: [pdu({ type: 'm.room.message', event_id: '$p', depth: 4 })],
      end: 4,
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      jsonInit('PUT', { name: 'Lobby' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ event_id: '$evt:example.com' });
    expect(bumpRoomCacheGeneration).toHaveBeenCalledWith(expect.anything(), ROOM);
    expect(invalidateRoomCache).toHaveBeenCalledWith(expect.anything(), ROOM);
    expect(notifyUsersOfEvent).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      '$evt:example.com',
      'm.room.name'
    );
  });

  it('PUT state: membership event updates membership table', async () => {
    getMembership.mockResolvedValue(joinMembership());
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.member/${encodeURIComponent(BOB)}`,
      jsonInit('PUT', {
        membership: 'join',
        displayname: 'Bob',
        avatar_url: 'mxc://example.com/a',
      })
    );
    expect(status).toBe(200);
    expect(updateMembership).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      BOB,
      'join',
      '$evt:example.com',
      'Bob',
      'mxc://example.com/a'
    );
  });
});

describe('GET members / messages / event / send', () => {
  it('members: forbids non-join', async () => {
    getMembership.mockResolvedValue({ membership: 'leave', eventId: '$l' });
    const { status } = await request(`/_matrix/client/v3/rooms/${ROOM_ENC}/members`);
    expect(status).toBe(403);
  });

  it('members: returns member event chunk', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getRoomMembers.mockResolvedValue([
      { userId: USER, displayName: 'A', avatarUrl: null },
      { userId: BOB, displayName: null, avatarUrl: null },
    ]);
    getStateEvent.mockImplementation(async (_db, _room, type, stateKey = '') => {
      if (type !== 'm.room.member') return null;
      return pdu({
        type: 'm.room.member',
        event_id: `$m-${stateKey}`,
        state_key: stateKey,
        sender: stateKey,
        content: { membership: 'join' },
      });
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/members`
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      chunk: expect.arrayContaining([
        expect.objectContaining({ state_key: USER }),
        expect.objectContaining({ state_key: BOB }),
      ]),
    });
  });

  it('messages: forbids non-members', async () => {
    getMembership.mockResolvedValue(null);
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/messages?dir=b`
    );
    expect(status).toBe(403);
  });

  it('messages: parses s-prefixed from token and omits end when empty', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/messages?from=s42&dir=b&limit=5`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ start: 's42', chunk: [] });
    expect(getRoomEvents).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      42,
      5,
      'b'
    );
  });

  it('messages: includes end when events returned; caps limit at 100', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getRoomEvents.mockResolvedValue({
      events: [
        pdu({
          type: 'm.room.message',
          event_id: EVENT,
          content: { body: 'hi', msgtype: 'm.text' },
          unsigned: { age: 1 },
        }),
      ],
      end: 99,
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/messages?from=10&dir=f&limit=999`
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      start: '10',
      end: 's99',
      chunk: [expect.objectContaining({ event_id: EVENT, type: 'm.room.message' })],
    });
    expect(getRoomEvents).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      10,
      100,
      'f'
    );
  });

  it('messages: NaN from token becomes undefined', async () => {
    getMembership.mockResolvedValue(joinMembership());
    await request(`/_matrix/client/v3/rooms/${ROOM_ENC}/messages?from=sxyz`);
    expect(getRoomEvents).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      undefined,
      10,
      'b'
    );
  });

  it('event: 404 when missing or wrong room', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(null);
    const missing = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/event/${EVENT_ENC}`
    );
    expect(missing.status).toBe(404);

    getEvent.mockResolvedValue(
      pdu({ type: 'm.room.message', event_id: EVENT, room_id: '!other:example.com' })
    );
    const wrong = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/event/${EVENT_ENC}`
    );
    expect(wrong.status).toBe(404);
  });

  it('event: returns client-shaped event', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        content: { body: 'x', msgtype: 'm.text' },
        unsigned: { transaction_id: 't1' },
      })
    );
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/event/${EVENT_ENC}`
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      event_id: EVENT,
      type: 'm.room.message',
      content: { body: 'x', msgtype: 'm.text' },
      unsigned: { transaction_id: 't1' },
    });
  });

  it('send: bad JSON / non-member', async () => {
    getMembership.mockResolvedValue(null);
    const forbidden = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.message/txn1`,
      jsonInit('PUT', { msgtype: 'm.text', body: 'hi' })
    );
    expect(forbidden.status).toBe(403);

    getMembership.mockResolvedValue(joinMembership());
    const bad = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.message/txn1`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: '{',
      }
    );
    expect(bad.status).toBe(400);
  });

  it('send: stores message, notifies, schedules push workflow', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getRoomEvents.mockResolvedValue({
      events: [pdu({ type: 'm.room.message', event_id: '$p', depth: 7 })],
      end: 7,
    });
    const pushCreate = vi.fn(async () => ({ id: 'p1' }));
    const { status, body, execCtx } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.message/txn-42`,
      jsonInit('PUT', { msgtype: 'm.text', body: 'hello' }),
      createSqlDb(),
      { pushWorkflow: { create: pushCreate } }
    );
    expect(status).toBe(200);
    expect(body).toEqual({ event_id: '$evt:example.com' });
    const stored = storeEvent.mock.calls[0][1] as PDU;
    expect(stored).toMatchObject({
      type: 'm.room.message',
      content: { msgtype: 'm.text', body: 'hello' },
      unsigned: { transaction_id: 'txn-42' },
      depth: 8,
    });
    expect(notifyUsersOfEvent).toHaveBeenCalled();
    await Promise.all(execCtx.waitUntilPromises);
    expect(pushCreate).toHaveBeenCalledWith({
      params: expect.objectContaining({
        eventId: '$evt:example.com',
        roomId: ROOM,
        eventType: 'm.room.message',
        sender: USER,
      }),
    });
  });

  it('send: encrypted also schedules push; other types do not', async () => {
    getMembership.mockResolvedValue(joinMembership());
    const pushCreate = vi.fn(async () => ({ id: 'p1' }));
    const enc = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.encrypted/t1`,
      jsonInit('PUT', { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x' }),
      createSqlDb(),
      { pushWorkflow: { create: pushCreate } }
    );
    expect(enc.status).toBe(200);
    await Promise.all(enc.execCtx.waitUntilPromises);
    expect(pushCreate).toHaveBeenCalledTimes(1);

    pushCreate.mockClear();
    const react = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.reaction/t2`,
      jsonInit('PUT', { 'm.relates_to': { rel_type: 'm.annotation', event_id: EVENT, key: '👍' } }),
      createSqlDb(),
      { pushWorkflow: { create: pushCreate } }
    );
    expect(react.status).toBe(200);
    await Promise.all(react.execCtx.waitUntilPromises);
    expect(pushCreate).not.toHaveBeenCalled();
  });

  it('send: push workflow create rejection is swallowed', async () => {
    getMembership.mockResolvedValue(joinMembership());
    const pushCreate = vi.fn(async () => {
      throw new Error('push down');
    });
    const { status, execCtx } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.message/t`,
      jsonInit('PUT', { msgtype: 'm.text', body: 'x' }),
      createSqlDb(),
      { pushWorkflow: { create: pushCreate } }
    );
    expect(status).toBe(200);
    await Promise.all(execCtx.waitUntilPromises);
  });
});

describe('invite / kick / ban / unban', () => {
  it('invite: bad JSON / missing user_id / non-member', async () => {
    const bad = await request(`/_matrix/client/v3/rooms/${ROOM_ENC}/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: '{',
    });
    expect(bad.status).toBe(400);

    getMembership.mockResolvedValue(joinMembership());
    const missing = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`,
      jsonInit('POST', {})
    );
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });

    getMembership.mockResolvedValue(null);
    const forbidden = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(forbidden.status).toBe(403);
  });

  it('invite: insufficient PL', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        content: { users: { [USER]: 10 }, invite: 50, users_default: 0 },
        state_key: '',
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(status).toBe(403);
  });

  it('invite: already joined / already invited idempotent', async () => {
    getMembership
      .mockResolvedValueOnce(joinMembership())
      .mockResolvedValueOnce({ membership: 'join', eventId: '$bj' });
    const joined = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(joined.status).toBe(403);

    getMembership
      .mockResolvedValueOnce(joinMembership())
      .mockResolvedValueOnce({ membership: 'invite', eventId: '$bi' });
    const invited = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(invited.status).toBe(200);
    expect(invited.body).toEqual({});
    expect(storeEvent).not.toHaveBeenCalled();
  });

  it('invite: stores invite; conflicts if PL changes', async () => {
    getMembership.mockImplementation(async (_db, _room, userId: string) => {
      if (userId === USER) return joinMembership();
      return null;
    });
    let pl = 0;
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$c', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        pl += 1;
        return pdu({
          type: 'm.room.power_levels',
          event_id: pl <= 1 ? '$pl1' : '$pl2',
          content: { users: { [USER]: 100 }, invite: 50 },
          state_key: '',
        });
      }
      return null;
    });
    const conflict = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(conflict.status).toBe(409);

    pl = 0;
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.create') {
        return pdu({ type: 'm.room.create', event_id: '$c', state_key: '' });
      }
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          content: { users: { [USER]: 100 }, invite: 50 },
          state_key: '',
        });
      }
      return null;
    });
    const ok = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(ok.status).toBe(200);
    expect(updateMembership).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      BOB,
      'invite',
      '$evt:example.com'
    );
  });

  it('kick: missing user / not in room / PL too low vs target', async () => {
    getMembership.mockResolvedValue(joinMembership());
    const missing = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/kick`,
      jsonInit('POST', {})
    );
    expect(missing.status).toBe(400);

    getMembership
      .mockResolvedValueOnce(joinMembership())
      .mockResolvedValueOnce(null);
    const notIn = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/kick`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(notIn.status).toBe(403);

    getMembership.mockImplementation(async (_db, _room, uid: string) =>
      uid === USER || uid === BOB ? joinMembership(`$m-${uid}`) : null
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        content: {
          users: { [USER]: 50, [BOB]: 50 },
          kick: 50,
          users_default: 0,
        },
        state_key: '',
      }),
    });
    const equalPl = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/kick`,
      jsonInit('POST', { user_id: BOB, reason: 'bye' })
    );
    expect(equalPl.status).toBe(403);
  });

  it('kick: stores leave for target with reason', async () => {
    getMembership.mockImplementation(async (_db, _room, uid: string) =>
      uid === USER || uid === BOB ? joinMembership(`$m-${uid}`) : null
    );
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/kick`,
      jsonInit('POST', { user_id: BOB, reason: 'spam' })
    );
    expect(status).toBe(200);
    const stored = storeEvent.mock.calls[0][1] as PDU;
    expect(stored).toMatchObject({
      type: 'm.room.member',
      state_key: BOB,
      content: { membership: 'leave', reason: 'spam' },
      sender: USER,
    });
    expect(updateMembership).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      BOB,
      'leave',
      '$evt:example.com'
    );
  });

  it('ban: insufficient PL; success path', async () => {
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        content: { users: { [USER]: 10 }, ban: 50, users_default: 0 },
        state_key: '',
      }),
    });
    const low = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/ban`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(low.status).toBe(403);

    defaultState();
    getMembership.mockImplementation(async (_db, _room, uid: string) => {
      if (uid === USER) return joinMembership();
      if (uid === BOB) return { membership: 'join', eventId: '$bj' };
      return null;
    });
    const ok = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/ban`,
      jsonInit('POST', { user_id: BOB, reason: 'abuse' })
    );
    expect(ok.status).toBe(200);
    expect(storeEvent.mock.calls[0][1]).toMatchObject({
      content: { membership: 'ban', reason: 'abuse' },
      state_key: BOB,
    });
    expect(updateMembership).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      BOB,
      'ban',
      '$evt:example.com'
    );
  });

  it('unban: not banned / low PL / success', async () => {
    getMembership
      .mockResolvedValueOnce(joinMembership())
      .mockResolvedValueOnce({ membership: 'leave', eventId: '$l' });
    const notBanned = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/unban`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(notBanned.status).toBe(403);

    getMembership.mockImplementation(async (_db, _room, uid: string) => {
      if (uid === USER) return joinMembership();
      if (uid === BOB) return { membership: 'ban', eventId: '$bb' };
      return null;
    });
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        content: { users: { [USER]: 10 }, ban: 50, users_default: 0 },
        state_key: '',
      }),
    });
    const low = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/unban`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(low.status).toBe(403);

    defaultState();
    const ok = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/unban`,
      jsonInit('POST', { user_id: BOB, reason: 'ok' })
    );
    expect(ok.status).toBe(200);
    expect(updateMembership).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      BOB,
      'leave',
      '$evt:example.com'
    );
  });
});

describe('forget / redact / context / joined_members / room aliases', () => {
  it('forget: forbids while still joined', async () => {
    getMembership.mockResolvedValue(joinMembership());
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/forget`,
      jsonInit('POST', {})
    );
    expect(status).toBe(403);
  });

  it('forget: deletes membership when left', async () => {
    getMembership.mockResolvedValue({ membership: 'leave', eventId: '$l' });
    const db = createSqlDb({
      membershipRows: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const { status, db: out } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/forget`,
      jsonInit('POST', {}),
      db
    );
    expect(status).toBe(200);
    expect(out.deletes.some((d) => d.sql.includes('DELETE FROM room_memberships'))).toBe(
      true
    );
    expect(out.membershipRows).toEqual([]);
  });

  it('redact: missing event / insufficient PL for others / own ok', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(null);
    const missing = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/txn`,
      jsonInit('PUT', {})
    );
    expect(missing.status).toBe(404);

    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: BOB,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        content: { users: { [USER]: 10 }, redact: 50, users_default: 0 },
        state_key: '',
      }),
    });
    const low = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/txn`,
      jsonInit('PUT', { reason: 'no' })
    );
    expect(low.status).toBe(403);

    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'mine', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const own = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/txn-r`,
      jsonInit('PUT', { reason: 'oops' }),
      db
    );
    expect(own.status).toBe(200);
    expect(own.body).toEqual({ event_id: '$evt:example.com' });
    expect(storeEvent.mock.calls[0][1]).toMatchObject({
      type: 'm.room.redaction',
      content: { redacts: EVENT, reason: 'oops' },
      redacts: EVENT,
      unsigned: { transaction_id: 'txn-r' },
    });
    expect(db.updates.some((u) => u.sql.includes('redacted_because'))).toBe(true);
  });

  it('redact: high PL can redact others; empty body ok', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: CAROL,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/t`,
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer t' },
        body: 'not-json',
      }
    );
    expect(status).toBe(200);
    expect(storeEvent.mock.calls[0][1]).toMatchObject({
      content: { redacts: EVENT },
    });
  });

  it('context: forbids / not found', async () => {
    getMembership.mockResolvedValue(null);
    const forbidden = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/context/${EVENT_ENC}?limit=2`
    );
    expect(forbidden.status).toBe(403);

    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(null);
    const missing = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/context/${EVENT_ENC}`
    );
    expect(missing.status).toBe(404);
  });

  it('context: returns before/after/state around hybrid-shaped event', async () => {
    getMembership.mockResolvedValue(joinMembership());
    // Route formats via event_type + string content (DB row shape).
    getEvent.mockResolvedValue({
      event_id: EVENT,
      room_id: ROOM,
      sender: USER,
      event_type: 'm.room.message',
      type: 'm.room.message',
      content: JSON.stringify({ body: 'mid', msgtype: 'm.text' }),
      origin_server_ts: NOW,
      state_key: null,
    });
    getRoomState.mockResolvedValue([
      pdu({
        type: 'm.room.create',
        event_id: '$create',
        state_key: '',
        content: { creator: USER },
      }),
    ]);
    const db = createSqlDb({
      contextBefore: [
        {
          event_id: '$b',
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          state_key: null,
          content: JSON.stringify({ body: 'before', msgtype: 'm.text' }),
          origin_server_ts: NOW - 10,
        },
      ],
      contextAfter: [
        {
          event_id: '$a',
          room_id: ROOM,
          sender: CAROL,
          event_type: 'm.room.message',
          state_key: null,
          content: JSON.stringify({ body: 'after', msgtype: 'm.text' }),
          origin_server_ts: NOW + 10,
        },
      ],
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/context/${EVENT_ENC}?limit=4`,
      {},
      db
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      event: expect.objectContaining({
        event_id: EVENT,
        type: 'm.room.message',
        content: { body: 'mid', msgtype: 'm.text' },
      }),
      events_before: [
        expect.objectContaining({ event_id: '$b', content: { body: 'before', msgtype: 'm.text' } }),
      ],
      events_after: [
        expect.objectContaining({ event_id: '$a', content: { body: 'after', msgtype: 'm.text' } }),
      ],
      state: [expect.objectContaining({ type: 'm.room.create' })],
      start: String(NOW - 10),
      end: String(NOW + 10),
    });
  });

  it('joined_members: maps display/avatar', async () => {
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb({
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
          display_name: null,
          avatar_url: null,
        },
      ],
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/joined_members`,
      {},
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      joined: {
        [USER]: { display_name: 'Alice', avatar_url: 'mxc://example.com/a' },
        [BOB]: { display_name: undefined, avatar_url: undefined },
      },
    });
  });

  it('room aliases list: forbids / returns aliases', async () => {
    getMembership.mockResolvedValue(null);
    const forbidden = await request(`/_matrix/client/v3/rooms/${ROOM_ENC}/aliases`);
    expect(forbidden.status).toBe(403);

    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb({
      aliasRows: [
        { alias: ALIAS, room_id: ROOM },
        { alias: '#other:example.com', room_id: ROOM },
      ],
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/aliases`,
      {},
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual({ aliases: [ALIAS, '#other:example.com'] });
  });
});

describe('POST /join/:roomIdOrAlias + directory', () => {
  it('join by alias: 404 when alias/room missing', async () => {
    getRoomByAlias.mockResolvedValue(null);
    const aliasMissing = await request(
      `/_matrix/client/v3/join/${ALIAS_ENC}`,
      jsonInit('POST', {})
    );
    expect(aliasMissing.status).toBe(404);

    getRoomByAlias.mockResolvedValue(ROOM);
    getRoom.mockResolvedValue(null);
    const roomMissing = await request(
      `/_matrix/client/v3/join/${ALIAS_ENC}`,
      jsonInit('POST', {})
    );
    expect(roomMissing.status).toBe(404);
  });

  it('join by room id: already joined short-circuit', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/join/${ROOM_ENC}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({ room_id: ROOM });
  });

  it('join by alias: public join via storeEventIdempotent', async () => {
    getRoomByAlias.mockResolvedValue(ROOM);
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(null);
    const { status, body } = await request(
      `/_matrix/client/v3/join/${ALIAS_ENC}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({ room_id: ROOM });
    expect(storeEventIdempotent).toHaveBeenCalled();
    expect(tryInsertJoinMembership).toHaveBeenCalled();
  });

  it('join by id: forbids invite-only without invite', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(null);
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/join/${ROOM_ENC}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(403);
  });

  it('directory GET: resolves alias', async () => {
    getRoomByAlias.mockResolvedValue(ROOM);
    const { status, body } = await request(
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ room_id: ROOM, servers: [SERVER] });
  });

  it('directory GET: 404 missing', async () => {
    getRoomByAlias.mockResolvedValue(null);
    const { status } = await request(
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`
    );
    expect(status).toBe(404);
  });

  it('directory PUT: bad JSON / missing room_id / in use / non-member / ok', async () => {
    const bad = await request(`/_matrix/client/v3/directory/room/${ALIAS_ENC}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: '{',
    });
    expect(bad.status).toBe(400);

    const missing = await request(
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('PUT', {})
    );
    expect(missing.status).toBe(400);

    getRoomByAlias.mockResolvedValue(ROOM);
    const inUse = await request(
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(inUse.status).toBe(400);
    expect(inUse.body).toMatchObject({ errcode: 'M_ROOM_IN_USE' });

    getRoomByAlias.mockResolvedValue(null);
    getMembership.mockResolvedValue(null);
    const forbidden = await request(
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(forbidden.status).toBe(403);

    getMembership.mockResolvedValue(joinMembership());
    const ok = await request(
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(ok.status).toBe(200);
    expect(createRoomAlias).toHaveBeenCalledWith(
      expect.anything(),
      ALIAS,
      ROOM,
      USER
    );
  });

  it('directory DELETE: missing / ok', async () => {
    getRoomByAlias.mockResolvedValue(null);
    const missing = await request(
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(missing.status).toBe(404);

    getRoomByAlias.mockResolvedValue(ROOM);
    const ok = await request(`/_matrix/client/v3/directory/room/${ALIAS_ENC}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(ok.status).toBe(200);
    expect(deleteRoomAlias).toHaveBeenCalledWith(expect.anything(), ALIAS);
  });
});

describe('GET room_summary (MSC3266)', () => {
  it('404 for missing alias / missing room', async () => {
    const aliasMissing = await request(
      `/_matrix/client/v1/room_summary/${ALIAS_ENC}`,
      {},
      createSqlDb({ aliasRows: [] })
    );
    expect(aliasMissing.status).toBe(404);

    const roomMissing = await request(
      `/_matrix/client/v1/room_summary/${ROOM_ENC}`,
      {},
      createSqlDb({ roomRows: [] })
    );
    expect(roomMissing.status).toBe(404);
  });

  it('hides private invite-only rooms from anonymous callers', async () => {
    const db = createSqlDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      summaryState: [
        {
          event_type: 'm.room.join_rules',
          content: JSON.stringify({ join_rule: 'invite' }),
        },
      ],
      memberCount: 3,
    });
    const { status } = await request(
      `/_matrix/client/v1/room_summary/${ROOM_ENC}`,
      {},
      db
    );
    expect(status).toBe(404);
  });

  it('returns public room summary fields from state', async () => {
    const db = createSqlDb({
      roomRows: [{ room_id: ROOM, room_version: '11', is_public: 1 }],
      memberCount: 4,
      summaryState: [
        { event_type: 'm.room.name', content: JSON.stringify({ name: 'Public' }) },
        { event_type: 'm.room.topic', content: JSON.stringify({ topic: 't' }) },
        {
          event_type: 'm.room.avatar',
          content: JSON.stringify({ url: 'mxc://example.com/av' }),
        },
        {
          event_type: 'm.room.join_rules',
          content: JSON.stringify({ join_rule: 'public' }),
        },
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
          content: JSON.stringify({ history_visibility: 'world_readable' }),
        },
        {
          event_type: 'm.room.guest_access',
          content: JSON.stringify({ guest_access: 'can_join' }),
        },
      ],
    });
    const { status, body } = await request(
      `/_matrix/client/v1/room_summary/${ROOM_ENC}`,
      {},
      db
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      room_id: ROOM,
      num_joined_members: 4,
      room_version: '11',
      name: 'Public',
      topic: 't',
      avatar_url: 'mxc://example.com/av',
      join_rule: 'public',
      canonical_alias: ALIAS,
      encryption: 'm.megolm.v1.aes-sha2',
      world_readable: true,
      guest_can_join: true,
    });
  });

  it('resolves alias and attaches membership for bearer token', async () => {
    const token = 'summary-token';
    const tokenHash = await hashToken(token);
    const db = createSqlDb({
      aliasRows: [{ alias: ALIAS, room_id: ROOM }],
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      memberCount: 1,
      summaryState: [
        {
          event_type: 'm.room.join_rules',
          content: JSON.stringify({ join_rule: 'invite' }),
        },
      ],
      accessTokens: [{ token_hash: tokenHash, user_id: USER }],
      tokenMembership: { membership: 'join' },
    });
    const { status, body } = await request(
      `/_matrix/client/v1/room_summary/${ALIAS_ENC}`,
      { headers: { Authorization: `Bearer ${token}` } },
      db
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      room_id: ROOM,
      membership: 'join',
    });
  });

  it('allows knock rooms to be summarized anonymously when not public', async () => {
    const db = createSqlDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      memberCount: 2,
      summaryState: [
        {
          event_type: 'm.room.join_rules',
          content: JSON.stringify({ join_rule: 'knock' }),
        },
      ],
    });
    const { status, body } = await request(
      `/_matrix/client/v1/room_summary/${ROOM_ENC}`,
      {},
      db
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ room_id: ROOM, join_rule: 'knock' });
  });
});

describe('GET timestamp_to_event (MSC3030)', () => {
  it('requires ts and dir; validates values', async () => {
    getMembership.mockResolvedValue(joinMembership());
    const noTs = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?dir=f`
    );
    expect(noTs.status).toBe(400);
    expect(noTs.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });

    const noDir = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=1`
    );
    expect(noDir.status).toBe(400);

    const badTs = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=abc&dir=f`
    );
    expect(badTs.status).toBe(400);
    expect(badTs.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });

    const badDir = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=1&dir=x`
    );
    expect(badDir.status).toBe(400);
    expect(badDir.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('forbids non-members; 404 when no event; finds f/b', async () => {
    getMembership.mockResolvedValue(null);
    const forbidden = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=${NOW}&dir=f`
    );
    expect(forbidden.status).toBe(403);

    getMembership.mockResolvedValue(joinMembership());
    const empty = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=${NOW}&dir=f`,
      {},
      createSqlDb({ tsEvents: [] })
    );
    expect(empty.status).toBe(404);

    const db = createSqlDb({
      tsEvents: [
        { event_id: '$early', origin_server_ts: NOW - 100, room_id: ROOM },
        { event_id: '$late', origin_server_ts: NOW + 100, room_id: ROOM },
      ],
    });
    const fwd = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=${NOW}&dir=f`,
      {},
      db
    );
    expect(fwd.status).toBe(200);
    expect(fwd.body).toEqual({ event_id: '$late', origin_server_ts: NOW + 100 });

    const back = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=${NOW}&dir=b`,
      {},
      db
    );
    expect(back.status).toBe(200);
    expect(back.body).toEqual({ event_id: '$early', origin_server_ts: NOW - 100 });
  });
});

describe('POST /rooms/:roomId/upgrade', () => {
  it('bad JSON / missing version / unsupported version', async () => {
    const bad = await request(`/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: '{',
    });
    expect(bad.status).toBe(400);

    const missing = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`,
      jsonInit('POST', {})
    );
    expect(missing.status).toBe(400);

    const unsupported = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`,
      jsonInit('POST', { new_version: '999' })
    );
    expect(unsupported.status).toBe(400);
    expect(unsupported.body).toMatchObject({
      errcode: 'M_UNSUPPORTED_ROOM_VERSION',
    });
  });

  it('404 / non-member / insufficient tombstone PL', async () => {
    getRoom.mockResolvedValue(null);
    const missing = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`,
      jsonInit('POST', { new_version: '11' })
    );
    expect(missing.status).toBe(404);

    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(null);
    const forbidden = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`,
      jsonInit('POST', { new_version: '11' })
    );
    expect(forbidden.status).toBe(403);

    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        content: {
          users: { [USER]: 50 },
          events: { 'm.room.tombstone': 100 },
          state_default: 50,
        },
        state_key: '',
      }),
    });
    const low = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`,
      jsonInit('POST', { new_version: '11' })
    );
    expect(low.status).toBe(403);
  });

  it('upgrades room: creates replacement, tombstones old, migrates aliases', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(joinMembership());
    getRoomState.mockResolvedValue([
      pdu({
        type: 'm.room.create',
        event_id: '$create',
        state_key: '',
        content: { creator: USER, room_version: '10' },
      }),
      pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        state_key: '',
        content: {
          users: { [USER]: 100 },
          events: { 'm.room.tombstone': 100 },
          state_default: 50,
          users_default: 0,
        },
      }),
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        state_key: '',
        content: { join_rule: 'invite' },
      }),
      pdu({
        type: 'm.room.history_visibility',
        event_id: '$hv',
        state_key: '',
        content: { history_visibility: 'shared' },
      }),
      pdu({
        type: 'm.room.name',
        event_id: '$n',
        state_key: '',
        content: { name: 'Old' },
      }),
      pdu({
        type: 'm.room.topic',
        event_id: '$t',
        state_key: '',
        content: { topic: 'top' },
      }),
      pdu({
        type: 'm.room.avatar',
        event_id: '$av',
        state_key: '',
        content: { url: 'mxc://example.com/av' },
      }),
      pdu({
        type: 'm.room.encryption',
        event_id: '$enc',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      }),
      pdu({
        type: 'm.room.guest_access',
        event_id: '$ga',
        state_key: '',
        content: { guest_access: 'can_join' },
      }),
      pdu({
        type: 'm.room.member',
        event_id: '$alice-join',
        state_key: USER,
        content: { membership: 'join' },
      }),
    ]);

    let eventSeq = 0;
    generateEventId.mockImplementation(async () => `$up${++eventSeq}:example.com`);
    generateRoomId.mockResolvedValue('!upgraded:example.com');

    const db = createSqlDb({
      aliasRows: [{ alias: ALIAS, room_id: ROOM }],
      lastEvent: { event_id: '$last', depth: 9 },
    });

    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`,
      jsonInit('POST', { new_version: '11' }),
      db
    );

    expect(status).toBe(200);
    expect(body).toEqual({ replacement_room: '!upgraded:example.com' });
    expect(createRoom).toHaveBeenCalledWith(
      expect.anything(),
      '!upgraded:example.com',
      '11',
      USER,
      false
    );
    expect(storeEvent.mock.calls.length).toBeGreaterThan(5);

    const createEvt = storeEvent.mock.calls.find(
      (c) => (c[1] as PDU).type === 'm.room.create'
    )?.[1] as PDU;
    expect(createEvt).toMatchObject({
      room_id: '!upgraded:example.com',
      content: {
        room_version: '11',
        predecessor: { room_id: ROOM, event_id: '$last' },
      },
    });

    const tombstone = storeEvent.mock.calls.find(
      (c) =>
        (c[1] as PDU).type === 'm.room.tombstone' && (c[1] as PDU).room_id === ROOM
    )?.[1] as PDU;
    expect(tombstone).toMatchObject({
      content: {
        replacement_room: '!upgraded:example.com',
      },
    });

    expect(db.aliasRows[0].room_id).toBe('!upgraded:example.com');
    expect(updateMembership).toHaveBeenCalledWith(
      expect.anything(),
      '!upgraded:example.com',
      USER,
      'join',
      expect.any(String)
    );
  });

  it('upgrade uses default PL/join/history when state sparse', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(joinMembership());
    getStateEvent.mockResolvedValue(null);
    getRoomState.mockResolvedValue([]);
    generateRoomId.mockResolvedValue('!sparse:example.com');

    // Without PL event, tombstone power defaults to state_default 50 and
    // userPower defaults to 0 → forbidden. Seed a PL that permits upgrade
    // but leave getRoomState empty so copy paths use defaults.
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.power_levels') {
        return pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          state_key: '',
          content: {
            users: { [USER]: 100 },
            events: { 'm.room.tombstone': 100 },
          },
        });
      }
      return null;
    });

    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`,
      jsonInit('POST', { new_version: '10' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ replacement_room: '!sparse:example.com' });

    const types = storeEvent.mock.calls.map((c) => (c[1] as PDU).type);
    expect(types).toContain('m.room.join_rules');
    expect(types).toContain('m.room.history_visibility');
    expect(types).toContain('m.room.tombstone');
  });
});
