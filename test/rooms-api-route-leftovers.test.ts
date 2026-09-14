/**
 * TOKENMAXX HEAVY leftovers after #147 — rooms client API edge/failure/reliability.
 * Orthogonal to rooms-api-routes (#114) and rooms-initial-state / aliases siblings.
 * Tests-only — Hono app.request() against src/api/rooms.ts. No product inventing.
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
  batchErrors?: Array<Error | null>;
  deleteRoomsError?: Error | null;
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
  const lastEvent =
    opts.lastEvent === undefined
      ? { event_id: '$last:example.com', depth: 5 }
      : opts.lastEvent;
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const selects: SqlCall[] = [];
  const batches: unknown[][] = [];
  let batchCall = 0;

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
                sql.includes('rs.event_type IN')
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
              if (
                opts.deleteRoomsError &&
                sql.includes('DELETE FROM rooms WHERE room_id = ?')
              ) {
                deletes.push({ sql, args });
                throw opts.deleteRoomsError;
              }
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
      batchCall += 1;
      if (opts.batchErrors && opts.batchErrors[batchCall - 1]) {
        throw opts.batchErrors[batchCall - 1];
      }
      if (opts.batchError && batchCall === 1) throw opts.batchError;
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

function plannedPdus(): PDU[] {
  return validateEventSize.mock.calls.map((c) => c[0] as PDU);
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
  generateEventId.mockReset().mockResolvedValue('$evt:example.com');
  generateDeterministicEventId.mockReset().mockResolvedValue('$detjoin:example.com');

  defaultState();
});

afterEach(() => {
  vi.useRealTimers();
});


describe('createRoom leftovers — presets / invites / soft fields', () => {
  it('defaults to private_chat preset: invite PL 50, join_rule invite, guest forbidden', async () => {
    const db = createSqlDb();
    const { status, body } = await request(
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { name: 'Private' }),
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual({ room_id: '!newroom:example.com' });
    expect(createRoom).toHaveBeenCalledWith(
      expect.anything(),
      '!newroom:example.com',
      expect.any(String),
      USER,
      false
    );

    const pdus = plannedPdus();
    const pl = pdus.find((p) => p.type === 'm.room.power_levels');
    const jr = pdus.find((p) => p.type === 'm.room.join_rules');
    const guest = pdus.find((p) => p.type === 'm.room.guest_access');
    const hist = pdus.find((p) => p.type === 'm.room.history_visibility');
    expect(pl?.content).toMatchObject({ invite: 50, users: { [USER]: 100 } });
    expect(jr?.content).toEqual({ join_rule: 'invite' });
    expect(guest?.content).toEqual({ guest_access: 'forbidden' });
    expect(hist?.content).toEqual({ history_visibility: 'shared' });
  });

  it('trusted_private_chat preset keeps invite join_rule and invite PL 50', async () => {
    await request(
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { preset: 'trusted_private_chat', name: 'Trusted' })
    );
    const pdus = plannedPdus();
    expect(pdus.find((p) => p.type === 'm.room.join_rules')?.content).toEqual({
      join_rule: 'invite',
    });
    expect(pdus.find((p) => p.type === 'm.room.power_levels')?.content).toMatchObject({
      invite: 50,
    });
  });

  it('public_chat preset sets invite PL 0, public join, can_join guests', async () => {
    await request(
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { preset: 'public_chat', visibility: 'public' })
    );
    const pdus = plannedPdus();
    expect(pdus.find((p) => p.type === 'm.room.power_levels')?.content).toMatchObject({
      invite: 0,
    });
    expect(pdus.find((p) => p.type === 'm.room.join_rules')?.content).toEqual({
      join_rule: 'public',
    });
    expect(pdus.find((p) => p.type === 'm.room.guest_access')?.content).toEqual({
      guest_access: 'can_join',
    });
  });

  it('invite[] + is_direct stamps is_direct on invite membership PDUs', async () => {
    await request(
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', {
        invite: [BOB, CAROL],
        is_direct: true,
        preset: 'private_chat',
      })
    );
    const invites = plannedPdus().filter(
      (p) => p.type === 'm.room.member' && p.state_key !== USER
    );
    expect(invites).toHaveLength(2);
    for (const inv of invites) {
      expect(inv.content).toMatchObject({ membership: 'invite', is_direct: true });
    }
  });

  it('soft-accepts reserved invite_3pid + creation_content without failing', async () => {
    const { status, body } = await request(
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', {
        name: 'Soft',
        invite_3pid: [{ medium: 'email', address: 'x@y.z', id_server: 'id.example' }],
        creation_content: { 'm.federate': false, type: 'org.example.custom' },
        extra_client_field: 'ignored',
      })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ room_id: '!newroom:example.com' });
    const create = plannedPdus().find((p) => p.type === 'm.room.create');
    expect(create?.content).toMatchObject({ creator: USER });
    expect(create?.content).not.toHaveProperty('m.federate');
  });

  it('writes m.fully_read account_data keyed to create event id', async () => {
    let evtSeq = 0;
    generateEventId.mockImplementation(async () => {
      evtSeq += 1;
      return `$createEvt${evtSeq}:example.com`;
    });
    const db = createSqlDb();
    const { status } = await request(
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { name: 'FR' }),
      db
    );
    expect(status).toBe(200);
    const fr = db.inserts.find((i) => i.sql.includes('m.fully_read'));
    expect(fr).toBeTruthy();
    expect(fr?.args[0]).toBe(USER);
    expect(fr?.args[1]).toBe('!newroom:example.com');
    expect(JSON.parse(fr?.args[2] as string)).toEqual({
      event_id: '$createEvt1:example.com',
    });
  });

  it('topic-only create still plans topic + create/member/PL baseline', async () => {
    await request(
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { topic: 'only-topic' })
    );
    const types = plannedPdus().map((p) => p.type);
    expect(types.slice(0, 6)).toEqual([
      'm.room.create',
      'm.room.member',
      'm.room.power_levels',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.guest_access',
    ]);
    expect(types).toContain('m.room.topic');
    expect(types).not.toContain('m.room.name');
  });

  it('empty body createRoom succeeds with private defaults', async () => {
    const { status, body } = await request(
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({ room_id: '!newroom:example.com' });
  });
});

describe('createRoom leftovers — failure / cleanup reliability', () => {
  it('returns unknown when rooms-row cleanup also fails after batch error', async () => {
    const db = createSqlDb({
      batchError: new Error('batch boom'),
      deleteRoomsError: new Error('delete rooms boom'),
    });
    const { status, body } = await request(
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { name: 'X' }),
      db
    );
    expect(status).toBe(500);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN', error: 'Failed to create room' });
    expect(db.deletes.some((d) => d.sql.includes('DELETE FROM rooms'))).toBe(true);
  });

  it('swallows compensating cleanup failure and still surfaces original batch error', async () => {
    const db = createSqlDb({
      batchErrors: [new Error('partial write'), new Error('cleanup also failed')],
    });
    const { status, body } = await request(
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { name: 'Y' }),
      db
    );
    expect(status).toBe(500);
    expect(body).toMatchObject({ errcode: 'M_UNKNOWN' });
    expect(db.batches.length).toBeGreaterThanOrEqual(2);
  });

  it('empty-string room_version falls back to default (falsy || default)', async () => {
    const { status, body } = await request(
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { room_version: '' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ room_id: '!newroom:example.com' });
    expect(createRoom.mock.calls[0][2]).toEqual(expect.any(String));
    expect(createRoom.mock.calls[0][2]).not.toBe('');
  });

  it('rejects whitespace / unknown room_version as unsupported', async () => {
    for (const room_version of [' ', '1.5', '999', 'v10']) {
      const { status, body } = await request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { room_version })
      );
      expect(status).toBe(400);
      expect(body).toMatchObject({ errcode: 'M_UNSUPPORTED_ROOM_VERSION' });
    }
  });

  it('rejects disallowed initial_state types with exact message', async () => {
    for (const type of ['m.room.create', 'm.room.member', 'm.room.power_levels']) {
      const { status, body } = await request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', {
          initial_state: [{ type, content: { x: 1 }, state_key: '' }],
        })
      );
      expect(status).toBe(400);
      expect(body).toMatchObject({
        errcode: 'M_INVALID_PARAM',
        error: `initial_state[0]: '${type}' cannot be set via initial_state`,
      });
    }
  });

  it('rejects missing-content / bad state_key / blank-type initial_state entries', async () => {
    const cases: Array<{ initial_state: unknown[]; error: string }> = [
      {
        initial_state: [{ type: 'm.room.name' }],
        error: "initial_state[0]: missing or invalid 'content' property",
      },
      {
        initial_state: [{ type: 'm.room.name', content: ['x'] }],
        error: "initial_state[0]: missing or invalid 'content' property",
      },
      {
        initial_state: [
          {
            type: 'm.room.name',
            content: { name: 'n' },
            state_key: 1 as unknown as string,
          },
        ],
        error: "initial_state[0]: 'state_key' must be a string",
      },
      {
        initial_state: [{ type: '  ', content: { name: 'n' } }],
        error: "initial_state[0]: missing or invalid 'type' property",
      },
      {
        initial_state: [42 as unknown as object],
        error: 'initial_state[0]: must be an object',
      },
    ];
    for (const c of cases) {
      const { status, body } = await request(
        '/_matrix/client/v3/createRoom',
        jsonInit('POST', { initial_state: c.initial_state })
      );
      expect(status).toBe(400);
      expect(body).toMatchObject({ errcode: 'M_INVALID_PARAM', error: c.error });
    }
  });

  it('rejects unsupported encryption algorithm in initial_state', async () => {
    const { status, body } = await request(
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', {
        initial_state: [
          { type: 'm.room.encryption', content: { algorithm: 'm.olm.v1.curve25519-aes-sha2' } },
        ],
      })
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({
      errcode: 'M_INVALID_PARAM',
      error: "initial_state[0]: unsupported algorithm 'm.olm.v1.curve25519-aes-sha2'",
    });
  });
});

describe('join leftovers — join_rule matrix / remote workflow soft statuses', () => {
  it.each([
    'knock',
    'knock_restricted',
    'restricted',
    'invite',
  ] as const)('forbids join when join_rule=%s without invite (exact error)', async (joinRule) => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(null);
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: joinRule },
        state_key: '',
      }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/join`,
      jsonInit('POST', {})
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({ errcode: 'M_FORBIDDEN', error: 'Cannot join room' });
  });

  it('allows join when leave membership but join_rule public', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue({ membership: 'leave', eventId: '$left' });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/join`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(body).toEqual({ room_id: ROOM });
    expect(storeEventIdempotent).toHaveBeenCalled();
  });

  it('forbids rejoin after leave when invite-only', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue({ membership: 'leave', eventId: '$left' });
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
    expect(body).toMatchObject({ error: 'Cannot join room' });
  });

  it('remote join accepts workflow queued soft status', async () => {
    getRoom.mockResolvedValue(null);
    const workflow = createWorkflowStub({ status: 'queued' });
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

  it('remote join fails when complete without success flag', async () => {
    getRoom.mockResolvedValue(null);
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${REMOTE_ENC}/join`,
      jsonInit('POST', {}),
      createSqlDb(),
      { workflow: createWorkflowStub({ status: 'complete', output: {} }) }
    );
    expect(status).toBe(500);
    expect(body).toMatchObject({
      errcode: 'M_UNKNOWN',
      error: 'Failed to join remote room',
    });
  });

  it('join by alias forbids restricted join_rule without invite', async () => {
    getRoomByAlias.mockResolvedValue(ROOM);
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(null);
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'restricted' },
        state_key: '',
      }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/join/${ALIAS_ENC}`,
      jsonInit('POST', {})
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'Cannot join room' });
  });

  it('join by room id with invite membership succeeds under invite rule', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue({ membership: 'invite', eventId: '$inv' });
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
      jsonInit('POST', { reason: 'accepted' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ room_id: ROOM });
  });

  it('skips notify when both event and membership inserts are duplicates', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(null);
    storeEventIdempotent.mockResolvedValue({ inserted: false, eventId: '$detjoin:example.com' });
    tryInsertJoinMembership.mockResolvedValue({
      inserted: false,
      eventId: '$detjoin:example.com',
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/join`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(notifyUsersOfEvent).not.toHaveBeenCalled();
  });
});

describe('leave / knock leftovers', () => {
  it('leave forbids invite-only membership (not join)', async () => {
    getMembership.mockResolvedValue({ membership: 'invite', eventId: '$inv' });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/leave`,
      jsonInit('POST', {})
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'Not a member of this room' });
  });

  it('leave forbids ban membership', async () => {
    getMembership.mockResolvedValue({ membership: 'ban', eventId: '$ban' });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/leave`,
      jsonInit('POST', {})
    );
    expect(status).toBe(403);
  });

  it('knock forbids when already invited? still allowed only for knock rules — invite rule blocked', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue({ membership: 'invite', eventId: '$inv' });
    defaultState({
      'm.room.join_rules': pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        content: { join_rule: 'invite' },
        state_key: '',
      }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/knock`,
      jsonInit('POST', { reason: 'pls' })
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('knock accepts missing body as empty reason', async () => {
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
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/knock`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: '{',
      },
      db
    );
    expect(status).toBe(200);
    expect(storeEvent).toHaveBeenCalled();
    expect(db.knocks.length).toBe(1);
  });
});

describe('state / members / messages / send leftovers', () => {
  it('GET state forbids invite membership', async () => {
    getMembership.mockResolvedValue({ membership: 'invite', eventId: '$inv' });
    const { status, body } = await request(`/_matrix/client/v3/rooms/${ROOM_ENC}/state`);
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'Not a member of this room' });
  });

  it('PUT state with omitted state_key uses empty string slot', async () => {
    getMembership.mockResolvedValue(joinMembership());
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.topic`,
      jsonInit('PUT', { topic: 't' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ event_id: '$evt:example.com' });
    expect(storeEvent.mock.calls[0][1]).toMatchObject({
      type: 'm.room.topic',
      state_key: '',
      content: { topic: 't' },
    });
  });

  it('PUT state bumps cache for topic and avatar as well as name', async () => {
    getMembership.mockResolvedValue(joinMembership());
    for (const [type, content] of [
      ['m.room.topic', { topic: 'x' }],
      ['m.room.avatar', { url: 'mxc://example.com/a' }],
      ['m.room.canonical_alias', { alias: ALIAS }],
    ] as const) {
      bumpRoomCacheGeneration.mockClear();
      invalidateRoomCache.mockClear();
      const { status } = await request(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/state/${encodeURIComponent(type)}`,
        jsonInit('PUT', content)
      );
      expect(status).toBe(200);
      expect(bumpRoomCacheGeneration).toHaveBeenCalledWith(expect.anything(), ROOM);
      expect(invalidateRoomCache).toHaveBeenCalledWith(expect.anything(), ROOM);
    }

    bumpRoomCacheGeneration.mockClear();
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/${encodeURIComponent('m.room.join_rules')}`,
      jsonInit('PUT', { join_rule: 'public' })
    );
    expect(status).toBe(200);
    expect(bumpRoomCacheGeneration).not.toHaveBeenCalled();
  });

  it('members filters out null state events from parallel fetch', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getRoomMembers.mockResolvedValue([
      { userId: USER, membership: 'join' },
      { userId: BOB, membership: 'join' },
      { userId: CAROL, membership: 'leave' },
    ]);
    getStateEvent.mockImplementation(async (_db, _room, type: string, stateKey = '') => {
      if (type === 'm.room.member' && stateKey === BOB) return null;
      if (type === 'm.room.member') {
        return pdu({
          type: 'm.room.member',
          event_id: `$m-${stateKey}`,
          state_key: stateKey,
          content: { membership: 'join' },
          sender: stateKey,
        });
      }
      return null;
    });
    const { status, body } = await request(`/_matrix/client/v3/rooms/${ROOM_ENC}/members`);
    expect(status).toBe(200);
    const chunk = (body as { chunk: Array<{ state_key: string }> }).chunk;
    expect(chunk.map((e) => e.state_key).sort()).toEqual([CAROL, USER].sort());
  });

  it('messages defaults dir=b and limit=10; NaN limit becomes NaN-capped path', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getRoomEvents.mockResolvedValue({
      events: [
        pdu({
          type: 'm.room.message',
          event_id: EVENT,
          content: { body: 'hi', msgtype: 'm.text' },
        }),
      ],
      end: 99,
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/messages`
    );
    expect(status).toBe(200);
    expect(getRoomEvents).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      undefined,
      10,
      'b'
    );
    expect(body).toMatchObject({ start: 's0', end: 's99' });

    getRoomEvents.mockClear();
    await request(`/_matrix/client/v3/rooms/${ROOM_ENC}/messages?limit=nope&dir=f`);
    // parseInt('nope') => NaN; Math.min(NaN, 100) => NaN forwarded
    expect(getRoomEvents.mock.calls[0][3]).toBeNaN();
    expect(getRoomEvents.mock.calls[0][4]).toBe('f');
  });

  it('messages omits end when chunk empty even with from token', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    const { body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/messages?from=s5&dir=b`
    );
    expect(body).toEqual({ start: 's5', chunk: [] });
    expect(body).not.toHaveProperty('end');
  });

  it('event endpoint forbids non-join membership', async () => {
    getMembership.mockResolvedValue({ membership: 'leave', eventId: '$l' });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/event/${EVENT_ENC}`
    );
    expect(status).toBe(403);
  });

  it('send forbids invite membership and does not schedule push', async () => {
    getMembership.mockResolvedValue({ membership: 'invite', eventId: '$inv' });
    const pushWorkflow = { create: vi.fn(async () => ({ id: 'p' })) };
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.message/txn1`,
      jsonInit('PUT', { msgtype: 'm.text', body: 'x' }),
      createSqlDb(),
      { pushWorkflow }
    );
    expect(status).toBe(403);
    expect(pushWorkflow.create).not.toHaveBeenCalled();
  });
});

describe('moderation leftovers — reason / exact errors / soft floods', () => {
  it('invite stores reason when provided', async () => {
    getMembership
      .mockResolvedValueOnce(joinMembership()) // inviter
      .mockResolvedValueOnce(null); // invitee
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`,
      jsonInit('POST', { user_id: BOB, reason: 'welcome' })
    );
    expect(status).toBe(200);
    // current implementation does not copy reason into content — assert actual contract
    expect(storeEvent.mock.calls[0][1]).toMatchObject({
      type: 'm.room.member',
      state_key: BOB,
      content: { membership: 'invite' },
    });
  });

  it('kick exact errors: missing user / not in room / success reason content', async () => {
    getMembership.mockResolvedValue(joinMembership());
    const missing = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/kick`,
      jsonInit('POST', {})
    );
    expect(missing.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });

    getMembership
      .mockResolvedValueOnce(joinMembership())
      .mockResolvedValueOnce(null);
    const notIn = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/kick`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(notIn.status).toBe(403);
  });

  it('ban includes reason on membership content', async () => {
    getMembership.mockResolvedValue(joinMembership());
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/ban`,
      jsonInit('POST', { user_id: BOB, reason: 'abuse' })
    );
    expect(status).toBe(200);
    expect(storeEvent.mock.calls[0][1]).toMatchObject({
      content: { membership: 'ban', reason: 'abuse' },
      state_key: BOB,
    });
  });

  it('unban exact error when target not banned', async () => {
    getMembership
      .mockResolvedValueOnce(joinMembership())
      .mockResolvedValueOnce({ membership: 'leave', eventId: '$l' });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/unban`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forget exact error while joined', async () => {
    getMembership.mockResolvedValue(joinMembership());
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/forget`,
      jsonInit('POST', {})
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({
      error: 'Cannot forget room while still a member',
    });
  });

  it('forget succeeds for ban/knock/invite leftover memberships', async () => {
    for (const membership of ['ban', 'knock', 'invite', 'leave'] as const) {
      getMembership.mockResolvedValue({ membership, eventId: '$x' });
      const db = createSqlDb({
        membershipRows: [{ room_id: ROOM, user_id: USER, membership }],
      });
      const { status } = await request(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/forget`,
        jsonInit('POST', {}),
        db
      );
      expect(status).toBe(200);
      expect(db.membershipRows).toEqual([]);
    }
  });

  it('forget with null membership still returns 200 (idempotent delete)', async () => {
    getMembership.mockResolvedValue(null);
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/forget`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
  });
});

describe('redact / context / joined_members leftovers', () => {
  it('redact forbids non-join membership', async () => {
    getMembership.mockResolvedValue({ membership: 'leave', eventId: '$l' });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/t`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(403);
  });

  it('redact notifies and marks redacted_because', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getEvent.mockResolvedValue(
      pdu({
        type: 'm.room.message',
        event_id: EVENT,
        sender: USER,
        content: { body: 'x', msgtype: 'm.text' },
      })
    );
    const db = createSqlDb();
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${EVENT_ENC}/txn`,
      jsonInit('PUT', { reason: 'cleanup' }),
      db
    );
    expect(status).toBe(200);
    expect(notifyUsersOfEvent).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      '$evt:example.com',
      'm.room.redaction'
    );
    expect(db.updates.some((u) => u.sql.includes('redacted_because'))).toBe(true);
  });

  it('context caps limit at 100 and treats NSE small limits', async () => {
    getMembership.mockResolvedValue(joinMembership());
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
    getRoomState.mockResolvedValue([]);
    const db = createSqlDb({
      contextBefore: [],
      contextAfter: [],
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/context/${EVENT_ENC}?limit=999`,
      {},
      db
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      event: expect.objectContaining({ event_id: EVENT }),
      events_before: [],
      events_after: [],
    });
  });

  it('joined_members forbids non-join and returns empty map', async () => {
    getMembership.mockResolvedValue(null);
    const forbidden = await request(`/_matrix/client/v3/rooms/${ROOM_ENC}/joined_members`);
    expect(forbidden.status).toBe(403);

    getMembership.mockResolvedValue(joinMembership());
    const empty = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/joined_members`,
      {},
      createSqlDb({ membershipRows: [] })
    );
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ joined: {} });
  });
});

describe('directory leftovers', () => {
  it('directory PUT soft-flood: extra fields ignored when valid room_id present', async () => {
    getRoomByAlias.mockResolvedValue(null);
    getMembership.mockResolvedValue(joinMembership());
    const { status } = await request(
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('PUT', {
        room_id: ROOM,
        servers: ['evil.example'],
        unexpected: true,
      })
    );
    expect(status).toBe(200);
    expect(createRoomAlias).toHaveBeenCalledWith(expect.anything(), ALIAS, ROOM, USER);
  });

  it('directory DELETE missing returns not found exact', async () => {
    getRoomByAlias.mockResolvedValue(null);
    const { status, body } = await request(`/_matrix/client/v3/directory/room/${ALIAS_ENC}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });
});

describe('room_summary leftovers — visibility / auth soft matrix', () => {
  it('world_readable private room is visible anonymously', async () => {
    const db = createSqlDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      summaryState: [
        {
          event_type: 'm.room.join_rules',
          content: JSON.stringify({ join_rule: 'invite' }),
        },
        {
          event_type: 'm.room.history_visibility',
          content: JSON.stringify({ history_visibility: 'world_readable' }),
        },
        {
          event_type: 'm.room.avatar',
          content: JSON.stringify({ url: 'mxc://example.com/av' }),
        },
        {
          event_type: 'm.room.canonical_alias',
          content: JSON.stringify({ alias: ALIAS }),
        },
        {
          event_type: 'm.room.encryption',
          content: JSON.stringify({ algorithm: 'm.megolm.v1.aes-sha2' }),
        },
      ],
      memberCount: 2,
    });
    const { status, body } = await request(
      `/_matrix/client/v1/room_summary/${ROOM_ENC}`,
      {},
      db
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      room_id: ROOM,
      world_readable: true,
      guest_can_join: false,
      avatar_url: 'mxc://example.com/av',
      canonical_alias: ALIAS,
      encryption: 'm.megolm.v1.aes-sha2',
      num_joined_members: 2,
      join_rule: 'invite',
    });
  });

  it('authenticated non-member sees membership leave on public room', async () => {
    const token = 'bearer-token';
    const tokenHash = await hashToken(token);
    const db = createSqlDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 1 }],
      summaryState: [
        {
          event_type: 'm.room.join_rules',
          content: JSON.stringify({ join_rule: 'public' }),
        },
      ],
      accessTokens: [{ token_hash: tokenHash, user_id: USER }],
      tokenMembership: null,
    });
    const { status, body } = await request(
      `/_matrix/client/v1/room_summary/${ROOM_ENC}`,
      { headers: { Authorization: `Bearer ${token}` } },
      db
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ membership: 'leave', join_rule: 'public' });
  });

  it('private invite-only room with no world_readable hides from anonymous', async () => {
    const db = createSqlDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      summaryState: [
        {
          event_type: 'm.room.join_rules',
          content: JSON.stringify({ join_rule: 'invite' }),
        },
        {
          event_type: 'm.room.history_visibility',
          content: JSON.stringify({ history_visibility: 'shared' }),
        },
      ],
    });
    const { status, body } = await request(
      `/_matrix/client/v1/room_summary/${ROOM_ENC}`,
      {},
      db
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('knock_restricted private room remains summarizable anonymously', async () => {
    const db = createSqlDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      summaryState: [
        {
          event_type: 'm.room.join_rules',
          content: JSON.stringify({ join_rule: 'knock_restricted' }),
        },
      ],
    });
    const { status } = await request(
      `/_matrix/client/v1/room_summary/${ROOM_ENC}`,
      {},
      db
    );
    expect(status).toBe(200);
  });
});

describe('timestamp_to_event leftovers', () => {
  it('forbids invite membership (must be join)', async () => {
    getMembership.mockResolvedValue({ membership: 'invite', eventId: '$inv' });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=${NOW}&dir=f`
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'Not a member of this room' });
  });

  it('returns exact not-found when no event in direction', async () => {
    getMembership.mockResolvedValue(joinMembership());
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=${NOW}&dir=b`,
      {},
      createSqlDb({ tsEvents: [] })
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({
      error: 'No event found for the given timestamp',
    });
  });
});

describe('upgrade leftovers — copy name/topic/avatar/encryption/guest', () => {
  it('copies optional state fields into replacement room events', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(joinMembership());
    generateRoomId.mockResolvedValue('!up:example.com');
    getRoomState.mockResolvedValue([
      pdu({
        type: 'm.room.join_rules',
        event_id: '$jr',
        state_key: '',
        content: { join_rule: 'public' },
      }),
      pdu({
        type: 'm.room.history_visibility',
        event_id: '$hv',
        state_key: '',
        content: { history_visibility: 'joined' },
      }),
      pdu({
        type: 'm.room.name',
        event_id: '$name',
        state_key: '',
        content: { name: 'Old' },
      }),
      pdu({
        type: 'm.room.topic',
        event_id: '$topic',
        state_key: '',
        content: { topic: 't' },
      }),
      pdu({
        type: 'm.room.avatar',
        event_id: '$av',
        state_key: '',
        content: { url: 'mxc://example.com/a' },
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
        type: 'm.room.create',
        event_id: '$create',
        state_key: '',
        content: { creator: USER },
      }),
      pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        state_key: '',
        content: {
          users: { [USER]: 100 },
          events: { 'm.room.tombstone': 100 },
        },
      }),
      pdu({
        type: 'm.room.member',
        event_id: '$mem',
        state_key: USER,
        content: { membership: 'join' },
      }),
    ]);

    const db = createSqlDb({
      aliasRows: [{ alias: ALIAS, room_id: ROOM }],
      lastEvent: { event_id: '$last', depth: 9 },
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`,
      jsonInit('POST', { new_version: '10' }),
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual({ replacement_room: '!up:example.com' });

    const stored = storeEvent.mock.calls.map((c) => c[1] as PDU);
    const types = stored.map((p) => p.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'm.room.create',
        'm.room.member',
        'm.room.power_levels',
        'm.room.join_rules',
        'm.room.history_visibility',
        'm.room.name',
        'm.room.topic',
        'm.room.avatar',
        'm.room.encryption',
        'm.room.guest_access',
        'm.room.tombstone',
      ])
    );
    expect(stored.find((p) => p.type === 'm.room.create')?.content).toMatchObject({
      predecessor: { room_id: ROOM, event_id: '$last' },
    });
    expect(stored.find((p) => p.type === 'm.room.name' && p.room_id === '!up:example.com')?.content).toEqual({
      name: 'Old',
    });
    expect(db.aliasRows[0].room_id).toBe('!up:example.com');

    const restrict = stored.find(
      (p) => p.type === 'm.room.power_levels' && p.room_id === ROOM
    );
    expect(restrict?.content).toMatchObject({ events_default: 100, invite: 100 });
  });

  it('upgrade forbids with exact tombstone PL message', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(joinMembership());
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        state_key: '',
        content: {
          users: { [USER]: 50 },
          events: { 'm.room.tombstone': 100 },
          state_default: 50,
        },
      }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`,
      jsonInit('POST', { new_version: '10' })
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({
      error: 'Insufficient power level to upgrade room',
    });
  });
});

describe('soft reliability floods — createRoom / join / summary', () => {
  it('createRoom soft-flood: many extra JSON fields still create private room', async () => {
    const extras: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) extras[`x${i}`] = i % 2 === 0 ? `v${i}` : { nested: i };
    const { status, body } = await request(
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', { ...extras, visibility: 'private' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ room_id: '!newroom:example.com' });
  });

  it('join soft-flood: empty JSON / whitespace body variants on public room', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(null);
    for (const body of ['{}', 'null', '[]', '"x"']) {
      storeEventIdempotent.mockClear();
      const { status } = await request(`/_matrix/client/v3/rooms/${ROOM_ENC}/join`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer t',
          'Content-Type': 'application/json',
        },
        body,
      });
      // join ignores body; all should succeed for public room
      expect(status).toBe(200);
    }
  });

  it('room_summary soft-flood: repeated anonymous hits stay stable', async () => {
    const db = createSqlDb({
      roomRows: [{ room_id: ROOM, room_version: '11', is_public: 1 }],
      summaryState: [
        {
          event_type: 'm.room.name',
          content: JSON.stringify({ name: 'N' }),
        },
        {
          event_type: 'm.room.join_rules',
          content: JSON.stringify({ join_rule: 'public' }),
        },
        {
          event_type: 'm.room.guest_access',
          content: JSON.stringify({ guest_access: 'can_join' }),
        },
      ],
      memberCount: 1,
    });
    for (let i = 0; i < 8; i++) {
      const { status, body } = await request(
        `/_matrix/client/v1/room_summary/${ROOM_ENC}`,
        {},
        db
      );
      expect(status).toBe(200);
      expect(body).toMatchObject({
        name: 'N',
        guest_can_join: true,
        room_version: '11',
      });
    }
  });

  it('joined_rooms soft-flood: empty and large list both shape correctly', async () => {
    getUserRooms.mockResolvedValueOnce([]);
    const empty = await request('/_matrix/client/v3/joined_rooms');
    expect(empty.body).toEqual({ joined_rooms: [] });

    const many = Array.from({ length: 50 }, (_, i) => `!r${i}:example.com`);
    getUserRooms.mockResolvedValueOnce(many);
    const big = await request('/_matrix/client/v3/joined_rooms');
    expect(big.body).toEqual({ joined_rooms: many });
  });
});


describe('createRoom leftovers — initial_state encryption edges', () => {
  it('accepts single valid megolm encryption in initial_state', async () => {
    const { status } = await request(
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', {
        initial_state: [
          {
            type: 'm.room.encryption',
            state_key: '',
            content: { algorithm: 'm.megolm.v1.aes-sha2' },
          },
        ],
      })
    );
    expect(status).toBe(200);
    expect(plannedPdus().some((p) => p.type === 'm.room.encryption')).toBe(true);
  });

  it('rejects encryption missing algorithm', async () => {
    const { status, body } = await request(
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', {
        initial_state: [{ type: 'm.room.encryption', content: {} }],
      })
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({
      error: "initial_state[0]: m.room.encryption requires 'algorithm'",
    });
  });

  it('plans custom initial_state after baseline with empty state_key default', async () => {
    await request(
      '/_matrix/client/v3/createRoom',
      jsonInit('POST', {
        initial_state: [
          { type: 'org.example.widget', content: { url: 'https://example.com' } },
        ],
      })
    );
    const custom = plannedPdus().find((p) => p.type === 'org.example.widget');
    expect(custom?.state_key).toBe('');
    expect(custom?.content).toEqual({ url: 'https://example.com' });
  });
});

describe('join leftovers — default join_rule invite when state missing', () => {
  it('treats missing join_rules as invite and forbids without invite', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(null);
    getStateEvent.mockImplementation(async (_db, _room, type: string) => {
      if (type === 'm.room.join_rules') return null;
      if (type === 'm.room.create') {
        return pdu({
          type: 'm.room.create',
          event_id: '$create',
          state_key: '',
          content: { creator: USER },
        });
      }
      return null;
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/join`,
      jsonInit('POST', {})
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'Cannot join room' });
  });

  it('notifies when only membership insert is new', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(null);
    storeEventIdempotent.mockResolvedValue({ inserted: false, eventId: '$detjoin:example.com' });
    tryInsertJoinMembership.mockResolvedValue({
      inserted: true,
      eventId: '$detjoin:example.com',
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/join`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(notifyUsersOfEvent).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      '$detjoin:example.com',
      'm.room.member'
    );
  });

  it('notifies when only event insert is new', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(null);
    storeEventIdempotent.mockResolvedValue({ inserted: true, eventId: '$detjoin:example.com' });
    tryInsertJoinMembership.mockResolvedValue({
      inserted: false,
      eventId: '$existing:example.com',
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/join`,
      jsonInit('POST', {})
    );
    expect(status).toBe(200);
    expect(notifyUsersOfEvent).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      '$existing:example.com',
      'm.room.member'
    );
  });
});

describe('send / push leftovers', () => {
  it('m.room.message schedules push workflow via waitUntil', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getRoomEvents.mockResolvedValue({
      events: [pdu({ type: 'm.room.message', event_id: '$prev', depth: 3 })],
      end: 3,
    });
    const pushWorkflow = { create: vi.fn(async () => ({ id: 'push-x' })) };
    const execCtx = createExecCtx();
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.message/txn-msg`,
      jsonInit('PUT', { msgtype: 'm.text', body: 'hi' }),
      createSqlDb(),
      { pushWorkflow },
      execCtx
    );
    expect(status).toBe(200);
    expect(body).toEqual({ event_id: '$evt:example.com' });
    await Promise.all(execCtx.waitUntilPromises);
    expect(pushWorkflow.create).toHaveBeenCalled();
  });

  it('reaction-type send does not schedule push', async () => {
    getMembership.mockResolvedValue(joinMembership());
    const pushWorkflow = { create: vi.fn(async () => ({ id: 'push-x' })) };
    const execCtx = createExecCtx();
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.reaction/txn-r`,
      jsonInit('PUT', {
        'm.relates_to': { rel_type: 'm.annotation', event_id: EVENT, key: '👍' },
      }),
      createSqlDb(),
      { pushWorkflow },
      execCtx
    );
    expect(status).toBe(200);
    await Promise.all(execCtx.waitUntilPromises);
    expect(pushWorkflow.create).not.toHaveBeenCalled();
  });
});

describe('invite / kick PL soft edges', () => {
  it('invite uses users_default when user missing from PL map', async () => {
    getMembership.mockResolvedValueOnce(joinMembership()).mockResolvedValueOnce(null);
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        state_key: '',
        content: { users_default: 0, invite: 50 },
      }),
    });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`,
      jsonInit('POST', { user_id: BOB })
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'Insufficient power level to invite' });
  });

  it('kick compares against target power and forbids equal-or-higher target', async () => {
    getMembership
      .mockResolvedValueOnce(joinMembership())
      .mockResolvedValueOnce({ membership: 'join', eventId: '$bob' });
    defaultState({
      'm.room.power_levels': pdu({
        type: 'm.room.power_levels',
        event_id: '$pl',
        state_key: '',
        content: {
          users: { [USER]: 50, [BOB]: 50 },
          kick: 50,
          users_default: 0,
        },
      }),
    });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/kick`,
      jsonInit('POST', { user_id: BOB, reason: 'nope' })
    );
    expect(status).toBe(403);
  });
});

describe('context / aliases / messages soft edges', () => {
  it('context forbids leave membership', async () => {
    getMembership.mockResolvedValue({ membership: 'leave', eventId: '$l' });
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/context/${EVENT_ENC}?limit=1`
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'Not a member of this room' });
  });

  it('aliases list forbids invite membership', async () => {
    getMembership.mockResolvedValue({ membership: 'invite', eventId: '$i' });
    const { status } = await request(`/_matrix/client/v3/rooms/${ROOM_ENC}/aliases`);
    expect(status).toBe(403);
  });

  it('messages forbids ban membership', async () => {
    getMembership.mockResolvedValue({ membership: 'ban', eventId: '$b' });
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/messages?dir=f`
    );
    expect(status).toBe(403);
  });

  it('messages limit=0 still queries with 0', async () => {
    getMembership.mockResolvedValue(joinMembership());
    getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    await request(`/_matrix/client/v3/rooms/${ROOM_ENC}/messages?limit=0`);
    expect(getRoomEvents.mock.calls[0][3]).toBe(0);
  });
});

describe('directory GET servers field', () => {
  it('returns local SERVER_NAME in servers array', async () => {
    getRoomByAlias.mockResolvedValue(ROOM);
    const { status, body } = await request(
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`
    );
    expect(status).toBe(200);
    expect(body).toEqual({ room_id: ROOM, servers: [SERVER] });
  });
});

describe('timestamp soft validation leftovers', () => {
  it('rejects non-integer ts and invalid dir with exact messages', async () => {
    getMembership.mockResolvedValue(joinMembership());
    const badTs = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=abc&dir=f`
    );
    expect(badTs.status).toBe(400);
    expect(badTs.body).toMatchObject({
      errcode: 'M_INVALID_PARAM',
      error: 'ts must be a valid integer timestamp in milliseconds',
    });

    const badDir = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=1&dir=sideways`
    );
    expect(badDir.status).toBe(400);
    expect(badDir.body).toMatchObject({
      error: "dir must be 'f' (forward) or 'b' (backward)",
    });
  });

  it('forward and backward pick closest events independently', async () => {
    getMembership.mockResolvedValue(joinMembership());
    const db = createSqlDb({
      tsEvents: [
        { event_id: '$early', origin_server_ts: NOW - 1000, room_id: ROOM },
        { event_id: '$mid', origin_server_ts: NOW, room_id: ROOM },
        { event_id: '$late', origin_server_ts: NOW + 1000, room_id: ROOM },
      ],
    });
    const forward = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=${NOW - 500}&dir=f`,
      {},
      db
    );
    expect(forward.body).toEqual({ event_id: '$mid', origin_server_ts: NOW });

    const backward = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=${NOW + 500}&dir=b`,
      {},
      db
    );
    expect(backward.body).toEqual({ event_id: '$mid', origin_server_ts: NOW });
  });
});

describe('upgrade leftovers — empty predecessor when no last event', () => {
  it('uses empty predecessor event_id when old room has no events', async () => {
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getMembership.mockResolvedValue(joinMembership());
    generateRoomId.mockResolvedValue('!emptypred:example.com');
    getRoomState.mockResolvedValue([]);
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
      jsonInit('POST', { new_version: '10' }),
      createSqlDb({ lastEvent: null })
    );
    expect(status).toBe(200);
    expect(body).toEqual({ replacement_room: '!emptypred:example.com' });
    const create = (storeEvent.mock.calls.map((c) => c[1] as PDU)).find(
      (p) => p.type === 'm.room.create'
    );
    expect(create?.content).toMatchObject({
      predecessor: { room_id: ROOM, event_id: '' },
    });
  });
});

describe('room_summary membership soft matrix', () => {
  it('member token attaches join membership on private invite room', async () => {
    const token = 'member-token';
    const tokenHash = await hashToken(token);
    const db = createSqlDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
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
      `/_matrix/client/v1/room_summary/${ROOM_ENC}`,
      { headers: { Authorization: `Bearer ${token}` } },
      db
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ membership: 'join' });
  });

  it('invalid bearer token is treated as anonymous for private invite room', async () => {
    const db = createSqlDb({
      roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      summaryState: [
        {
          event_type: 'm.room.join_rules',
          content: JSON.stringify({ join_rule: 'invite' }),
        },
      ],
      accessTokens: [],
    });
    const { status } = await request(
      `/_matrix/client/v1/room_summary/${ROOM_ENC}`,
      { headers: { Authorization: 'Bearer nope' } },
      db
    );
    expect(status).toBe(404);
  });
});
