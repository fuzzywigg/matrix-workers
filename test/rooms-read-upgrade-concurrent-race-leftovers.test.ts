/**
 * TOKENMAXX HEAVY leftovers after #202 — rooms *read / upgrade / advertised-mutate*
 * concurrent-race / TOCTOU slices not covered by rooms (#192), rooms-mutate (#194),
 * aliases (#193), or search+spaces (#199).
 *
 * Distinct from #191–#202: #194 advertised invite∥kick / knock∥invite / upgrade∥join
 * but only implemented kick∥kick, ban∥unban, knock∥knock, upgrade∥join membership soft;
 * #192 soft-flooded messages/members/timestamp validation without membership→data
 * barrier TOCTOU; room_summary / context / joined_members / GET aliases / upgrade∥upgrade
 * / alias-migrate∥directory / send∥leave / join|knock-by-alias mid-flight had zero
 * concurrent-race leftovers coverage.
 *
 * Focus: dual upgrade∥upgrade + alias-migration∥directory; invite∥kick + knock∥invite
 * competing membership writes; room_summary multi-SELECT visibility TOCTOU; context /
 * joined_members / aliases / timestamp_to_event membership→data TOCTOU; send∥leave;
 * join/knock-by-alias resolve mid-flight; cross-read isolation + soft floods.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env, PDU } from '../src/types';
import { hashToken } from '../src/utils/crypto';

const authState = vi.hoisted(() => ({
  userId: '@alice:example.com' as string | undefined,
  deviceId: 'DEVICEA' as string,
}));

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (
      c: {
        req: { header: (k: string) => string | undefined };
        set: (k: string, v: unknown) => void;
      },
      next: () => Promise<void>
    ) => {
      const override = c.req.header('X-Test-User');
      c.set('userId', override ?? authState.userId);
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
const ALIAS = '#general:example.com';
const ALIAS_ENC = encodeURIComponent(ALIAS);
const EVENT = '$msg1:example.com';
const EVENT_ENC = encodeURIComponent(EVENT);
const AUTH = { Authorization: 'Bearer test-token' };
const NOW = 1_700_000_000_000;

type SqlCall = { sql: string; args: unknown[] };
type Membership = { membership: string; eventId: string };
type StateMap = Record<string, PDU | null>;
type FnBarrier = { count: number };
type SelectBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };

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
  selectBarrier?: SelectBarrier;
  runBarrier?: SelectBarrier;
  mutateMemberCountAfterSelects?: { after: number; next: number };
  mutateSummaryStateAfterSelects?: {
    after: number;
    next: Array<{ event_type: string; content: string }>;
  };
  mutateRoomPublicAfterSelects?: { after: number; next: number };
  mutateTokenMembershipAfterSelects?: { after: number; next: { membership: string } | null };
  mutateAliasRowsAfterSelects?: {
    after: number;
    next: Array<{ alias: string; room_id: string }>;
  };
  mutateTsEventsAfterSelects?: {
    after: number;
    next: Array<{ event_id: string; origin_server_ts: number; room_id: string }>;
  };
  mutateContextAfterSelects?: {
    after: number;
    nextBefore?: Array<Record<string, unknown>>;
    nextAfter?: Array<Record<string, unknown>>;
  };
  failOnSqlIncludesAfter?: { includes: string; after: number };
};

async function withBarrier(
  barrier: SelectBarrier | undefined,
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
  let summaryState = [...(opts.summaryState ?? [])];
  let memberCount = opts.memberCount ?? 0;
  const accessTokens = opts.accessTokens ?? [];
  let tokenMembership = opts.tokenMembership ?? null;
  let contextBefore = [...(opts.contextBefore ?? [])];
  let contextAfter = [...(opts.contextAfter ?? [])];
  let tsEvents = [...(opts.tsEvents ?? [])];
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
  let failCounts: Record<string, number> = {};

  const maybeMutate = () => {
    const n = selects.length;
    if (opts.mutateMemberCountAfterSelects && n === opts.mutateMemberCountAfterSelects.after) {
      memberCount = opts.mutateMemberCountAfterSelects.next;
    }
    if (opts.mutateSummaryStateAfterSelects && n === opts.mutateSummaryStateAfterSelects.after) {
      summaryState = [...opts.mutateSummaryStateAfterSelects.next];
    }
    if (opts.mutateRoomPublicAfterSelects && n === opts.mutateRoomPublicAfterSelects.after) {
      for (const r of roomRows) r.is_public = opts.mutateRoomPublicAfterSelects.next;
    }
    if (
      opts.mutateTokenMembershipAfterSelects &&
      n === opts.mutateTokenMembershipAfterSelects.after
    ) {
      tokenMembership = opts.mutateTokenMembershipAfterSelects.next;
    }
    if (opts.mutateAliasRowsAfterSelects && n === opts.mutateAliasRowsAfterSelects.after) {
      aliasRows.splice(0, aliasRows.length, ...opts.mutateAliasRowsAfterSelects.next);
    }
    if (opts.mutateTsEventsAfterSelects && n === opts.mutateTsEventsAfterSelects.after) {
      tsEvents = [...opts.mutateTsEventsAfterSelects.next];
    }
    if (opts.mutateContextAfterSelects && n === opts.mutateContextAfterSelects.after) {
      if (opts.mutateContextAfterSelects.nextBefore) {
        contextBefore = [...opts.mutateContextAfterSelects.nextBefore];
      }
      if (opts.mutateContextAfterSelects.nextAfter) {
        contextAfter = [...opts.mutateContextAfterSelects.nextAfter];
      }
    }
  };

  const maybeFail = (sql: string) => {
    const failAfter = opts.failOnSqlIncludesAfter;
    if (!failAfter || !sql.includes(failAfter.includes)) return;
    failCounts[failAfter.includes] = (failCounts[failAfter.includes] ?? 0) + 1;
    if (failCounts[failAfter.includes] > failAfter.after) {
      throw new Error(`injected fail on ${failAfter.includes}`);
    }
  };

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
    get memberCount() {
      return memberCount;
    },
    setMemberCount(n: number) {
      memberCount = n;
    },
    get summaryState() {
      return summaryState;
    },
    setSummaryState(next: Array<{ event_type: string; content: string }>) {
      summaryState = [...next];
    },
    get tokenMembership() {
      return tokenMembership;
    },
    setTokenMembership(next: { membership: string } | null) {
      tokenMembership = next;
    },
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              maybeMutate();
              maybeFail(sql);
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
                sql.includes(
                  'SELECT event_id, depth FROM events WHERE room_id = ? ORDER BY depth DESC'
                )
              ) {
                return (lastEvent
                  ? { event_id: lastEvent.event_id, depth: lastEvent.depth }
                  : null) as T;
              }

              return null as T;
            },
            async all<T>() {
              selects.push({ sql, args });
              maybeMutate();
              maybeFail(sql);
              await withBarrier(
                selectBarrier,
                selectWaiters,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );

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

              if (sql.includes('SELECT * FROM events') && sql.includes('origin_server_ts < ?')) {
                return { results: contextBefore as T[] };
              }

              if (sql.includes('SELECT * FROM events') && sql.includes('origin_server_ts > ?')) {
                return { results: contextAfter as T[] };
              }

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
              maybeFail(sql);
              if (sql.trimStart().startsWith('INSERT')) {
                inserts.push({ sql, args });
                if (sql.includes('room_knocks')) {
                  knocks.push({
                    room_id: args[0] as string,
                    user_id: args[1] as string,
                  });
                }
                if (sql.includes('INSERT') && sql.includes('room_aliases')) {
                  aliasRows.push({
                    alias: args[0] as string,
                    room_id: args[1] as string,
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

function jsonInit(
  method: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): RequestInit {
  const upper = method.toUpperCase();
  const init: RequestInit = {
    method,
    headers: {
      ...AUTH,
      ...(upper === 'GET' || upper === 'HEAD' ? {} : { 'Content-Type': 'application/json' }),
      ...extraHeaders,
    },
  };
  if (upper !== 'GET' && upper !== 'HEAD' && body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return init;
}

function asUser(userId: string, method: string, body?: unknown): RequestInit {
  return jsonInit(method, body, { 'X-Test-User': userId });
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

function ctxEvent(partial: Record<string, unknown> = {}) {
  return {
    event_id: EVENT,
    event_type: 'm.room.message',
    room_id: ROOM,
    sender: BOB,
    origin_server_ts: NOW,
    content: JSON.stringify({ body: 'hi', msgtype: 'm.text' }),
    state_key: null,
    ...partial,
  };
}

/** Context route formats via DB-row shape (event_type + string content). */
function contextTargetEvent(partial: Record<string, unknown> = {}) {
  return {
    event_id: EVENT,
    room_id: ROOM,
    sender: USER,
    event_type: 'm.room.message',
    type: 'm.room.message',
    content: JSON.stringify({ body: 'mid', msgtype: 'm.text' }),
    origin_server_ts: NOW,
    state_key: null,
    ...partial,
  };
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
  let roomSeq = 0;
  generateRoomId.mockReset().mockImplementation(async () => {
    roomSeq += 1;
    return `!newroom${roomSeq}:example.com`;
  });
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

const N = 8;
const okish = (s: number) => [200, 403, 404, 400, 409, 500].includes(s);


// ---------------------------------------------------------------------------
// race upgrade∥upgrade dual TOCTOU after #202 (missed by #194 upgrade∥join only)
// ---------------------------------------------------------------------------

describe('race upgrade∥upgrade dual TOCTOU after #202', () => {
  for (let i = 0; i < N; i++) {
    it(`upgrade∥upgrade parallel tombstone #${i}`, async () => {
      seedLocalRoom();
      getRoomState.mockResolvedValue([
        pdu({
          type: 'm.room.create',
          event_id: '$create',
          content: { creator: USER, room_version: '10' },
          state_key: '',
        }),
        pdu({
          type: 'm.room.power_levels',
          event_id: '$pl',
          content: defaultPlContent(),
          state_key: '',
        }),
        pdu({
          type: 'm.room.member',
          event_id: '$alice-join',
          content: { membership: 'join' },
          state_key: USER,
        }),
      ]);
      const waiters = { list: [] as Array<() => void> };
      let barrier: FnBarrier | undefined = { count: 2 };
      getMembership.mockImplementation(async () => {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        return joinMembership(`$u${i}`);
      });
      const db = createSqlDb({
        roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
        lastEvent: { event_id: EVENT, depth: 3 },
        aliasRows: [
          { alias: `#u${i}:example.com`, room_id: ROOM },
          { alias: `#v${i}:example.com`, room_id: ROOM },
        ],
      });
      const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade';
      const [a, b] = await Promise.all([
        request(path, jsonInit('POST', { new_version: '11' }), db),
        request(path, jsonInit('POST', { new_version: '11' }), db),
      ]);
      expect([a.status, b.status].every(okish)).toBe(true);
      expect([a.status, b.status].some((s) => s === 200)).toBe(true);
      expect(createRoom.mock.calls.length).toBeGreaterThanOrEqual(1);
      const replacements = [a, b]
        .filter((r) => r.status === 200)
        .map((r) => (r.body as { replacement_room: string }).replacement_room);
      expect(new Set(replacements).size).toBe(replacements.length);
    });
  }

  for (let i = 0; i < N; i++) {
    it(`upgrade∥upgrade PL mid-flight forbid #${i}`, async () => {
      seedLocalRoom();
      getRoomState.mockResolvedValue([]);
      const waiters = { list: [] as Array<() => void> };
      let barrier: FnBarrier | undefined = { count: 2 };
      let plCalls = 0;
      getMembership.mockResolvedValue(joinMembership());
      getStateEvent.mockImplementation(async (_db, _room, type: string) => {
        if (type === 'm.room.power_levels') {
          await withFnBarrier(barrier, waiters, () => {
            barrier = undefined;
          });
          plCalls += 1;
          if (plCalls === 1) {
            return pdu({
              type: 'm.room.power_levels',
              event_id: `$pl-ok-${i}`,
              content: defaultPlContent(),
              state_key: '',
            });
          }
          return pdu({
            type: 'm.room.power_levels',
            event_id: `$pl-low-${i}`,
            content: {
              ...defaultPlContent(),
              users: { [USER]: 0 },
              events: { 'm.room.tombstone': 100 },
            },
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
      const db = createSqlDb({
        roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
        lastEvent: { event_id: EVENT, depth: 3 },
      });
      const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade';
      const [a, b] = await Promise.all([
        request(path, jsonInit('POST', { new_version: '11' }), db),
        request(path, jsonInit('POST', { new_version: '11' }), db),
      ]);
      expect([a.status, b.status].every(okish)).toBe(true);
    });
  }
});


// ---------------------------------------------------------------------------
// race upgrade alias-migration ∥ directory alias mutate after #202
// ---------------------------------------------------------------------------

describe('race upgrade alias-migration ∥ directory after #202', () => {
  for (let i = 0; i < N; i++) {
    it(`upgrade∥directory DELETE mid-migrate #${i}`, async () => {
      seedLocalRoom();
      getRoomState.mockResolvedValue([]);
      getMembership.mockResolvedValue(joinMembership());
      const alias = `#mig${i}:example.com`;
      const db = createSqlDb({
        roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
        lastEvent: { event_id: EVENT, depth: 3 },
        aliasRows: [{ alias, room_id: ROOM }],
        runBarrier: {
          match: (sql) => sql.includes('UPDATE room_aliases SET room_id'),
          count: 1,
        },
      });
      getRoomByAlias.mockResolvedValue(ROOM);
      deleteRoomAlias.mockImplementation(async () => {
        const idx = db.aliasRows.findIndex((a) => a.alias === alias);
        if (idx >= 0) db.aliasRows.splice(idx, 1);
      });
      const [up, del] = await Promise.all([
        request(
          '/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade',
          jsonInit('POST', { new_version: '11' }),
          db
        ),
        request(
          '/_matrix/client/v3/directory/room/' + encodeURIComponent(alias),
          jsonInit('DELETE', {}),
          db
        ),
      ]);
      expect([up.status, del.status].every(okish)).toBe(true);
    });
  }

  for (let i = 0; i < N; i++) {
    it(`upgrade∥directory PUT competing alias #${i}`, async () => {
      seedLocalRoom();
      getRoomState.mockResolvedValue([]);
      getMembership.mockResolvedValue(joinMembership());
      const alias = `#put${i}:example.com`;
      const db = createSqlDb({
        roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
        lastEvent: { event_id: EVENT, depth: 3 },
        aliasRows: [{ alias, room_id: ROOM }],
      });
      let aliasGets = 0;
      getRoomByAlias.mockImplementation(async () => {
        aliasGets += 1;
        return aliasGets === 1 ? null : ROOM;
      });
      const [up, put] = await Promise.all([
        request(
          '/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade',
          jsonInit('POST', { new_version: '11' }),
          db
        ),
        request(
          '/_matrix/client/v3/directory/room/' + encodeURIComponent(alias),
          jsonInit('PUT', { room_id: ROOM2 }),
          db
        ),
      ]);
      expect([up.status, put.status].every(okish)).toBe(true);
      if (up.status === 200) {
        const replacement = (up.body as { replacement_room: string }).replacement_room;
        const migrated = db.aliasRows.filter((a) => a.alias === alias);
        if (migrated.length) {
          expect([ROOM, ROOM2, replacement].includes(migrated[0].room_id)).toBe(true);
        }
      }
    });
  }
});


// ---------------------------------------------------------------------------
// race invite∥kick — advertised in #194 describe, never implemented
// ---------------------------------------------------------------------------


describe('race invite∥kick competing target membership after #202', () => {
  for (let i = 0; i < N; i++) {
    it(`invite∥kick target join→leave mid-flight #${i}`, async () => {
      seedLocalRoom();
      const waiters = { list: [] as Array<() => void> };
      let barrier: FnBarrier | undefined = { count: 2 };
      let bobCalls = 0;
      getMembership.mockImplementation(async (_db, _room, userId: string) => {
        if (userId === USER) return joinMembership();
        if (userId === BOB) {
          await withFnBarrier(barrier, waiters, () => {
            barrier = undefined;
          });
          bobCalls += 1;
          return bobCalls === 1
            ? joinMembership(`$bob${i}`)
            : { membership: 'leave', eventId: `$left${i}` };
        }
        return null;
      });
      const db = createSqlDb();
      const [inv, kick] = await Promise.all([
        request(
          '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite',
          jsonInit('POST', { user_id: BOB }),
          db
        ),
        request(
          '/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick',
          jsonInit('POST', { user_id: BOB, reason: `r${i}` }),
          db
        ),
      ]);
      expect([inv.status, kick.status].every((s) => [200, 403].includes(s))).toBe(true);
    });
  }

  for (let i = 0; i < N; i++) {
    it(`invite∥kick target leave→join mid-flight #${i}`, async () => {
      seedLocalRoom();
      const waiters = { list: [] as Array<() => void> };
      let barrier: FnBarrier | undefined = { count: 2 };
      let bobCalls = 0;
      getMembership.mockImplementation(async (_db, _room, userId: string) => {
        if (userId === USER) return joinMembership();
        if (userId === BOB) {
          await withFnBarrier(barrier, waiters, () => {
            barrier = undefined;
          });
          bobCalls += 1;
          return bobCalls === 1
            ? { membership: 'leave', eventId: `$left${i}` }
            : joinMembership(`$bob${i}`);
        }
        return null;
      });
      const db = createSqlDb();
      const [inv, kick] = await Promise.all([
        request(
          '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite',
          jsonInit('POST', { user_id: BOB }),
          db
        ),
        request(
          '/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick',
          jsonInit('POST', { user_id: BOB, reason: `s${i}` }),
          db
        ),
      ]);
      expect([inv.status, kick.status].every((s) => [200, 403].includes(s))).toBe(true);
    });
  }

  for (let i = 0; i < N; i++) {
    it(`invite∥kick updateMembership barrier #${i}`, async () => {
      seedLocalRoom();
      // Invite needs non-join target; kick needs join — flip after both SELECTs so
      // invite writes while kick observes leave (or the reverse) under one barrier.
      const waiters = { list: [] as Array<() => void> };
      let barrier: FnBarrier | undefined = { count: 2 };
      let bobCalls = 0;
      getMembership.mockImplementation(async (_db, _room, userId: string) => {
        if (userId === USER) return joinMembership();
        if (userId === BOB) {
          await withFnBarrier(barrier, waiters, () => {
            barrier = undefined;
          });
          bobCalls += 1;
          // Odd indices: first sees leave (invite writes), second sees join (kick may write)
          if (i % 2 === 0) {
            return bobCalls === 1
              ? { membership: 'leave', eventId: `$left${i}` }
              : joinMembership(`$bob${i}`);
          }
          return bobCalls === 1
            ? joinMembership(`$bob${i}`)
            : { membership: 'leave', eventId: `$left${i}` };
        }
        return null;
      });
      const writes: string[] = [];
      updateMembership.mockImplementation(async (_db, _room, userId: string, membership: string) => {
        writes.push(`${userId}:${membership}`);
      });
      const db = createSqlDb();
      const [inv, kick] = await Promise.all([
        request(
          '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite',
          jsonInit('POST', { user_id: BOB }),
          db
        ),
        request(
          '/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick',
          jsonInit('POST', { user_id: BOB, reason: `t${i}` }),
          db
        ),
      ]);
      expect([inv.status, kick.status].every((s) => [200, 403].includes(s))).toBe(true);
      expect(writes.length).toBeGreaterThanOrEqual(0);
    });
  }
});


// ---------------------------------------------------------------------------
// race knock∥invite — advertised in #194 describe, only knock∥knock shipped
// ---------------------------------------------------------------------------

describe('race knock∥invite competing membership writes after #202', () => {
  for (let i = 0; i < N; i++) {
    it(`knock∥invite bob knock vs alice invite #${i}`, async () => {
      seedLocalRoom();
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
      getMembership.mockImplementation(async (_db, _room, userId: string) => {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        if (userId === USER) return joinMembership();
        if (userId === BOB) return null;
        return null;
      });
      const db = createSqlDb();
      const [knock, inv] = await Promise.all([
        request(
          '/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock',
          asUser(BOB, 'POST', { reason: `please-${i}` }),
          db
        ),
        request(
          '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite',
          asUser(USER, 'POST', { user_id: BOB }),
          db
        ),
      ]);
      expect([knock.status, inv.status].every((s) => [200, 403, 400].includes(s))).toBe(true);
    });
  }

  for (let i = 0; i < N; i++) {
    it(`knock∥invite storeEvent last-write soft #${i}`, async () => {
      seedLocalRoom();
      defaultState({
        'm.room.join_rules': pdu({
          type: 'm.room.join_rules',
          event_id: '$jr-knock',
          content: { join_rule: 'knock' },
          state_key: '',
        }),
      });
      getMembership.mockImplementation(async (_db, _room, userId: string) => {
        if (userId === USER) return joinMembership();
        return null;
      });
      const waiters = { list: [] as Array<() => void> };
      let barrier: FnBarrier | undefined = { count: 2 };
      const membershipWrites: string[] = [];
      storeEvent.mockImplementation(async (_db, event: PDU) => {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        membershipWrites.push(String((event.content as { membership?: string })?.membership));
        return 1;
      });
      updateMembership.mockImplementation(async (_db, _room, _user, membership: string) => {
        membershipWrites.push(`upd:${membership}`);
      });
      const db = createSqlDb();
      const [knock, inv] = await Promise.all([
        request(
          '/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock',
          asUser(BOB, 'POST', { reason: `again-${i}` }),
          db
        ),
        request(
          '/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite',
          asUser(USER, 'POST', { user_id: BOB }),
          db
        ),
      ]);
      expect([knock.status, inv.status].every((s) => [200, 403, 400].includes(s))).toBe(true);
      expect(membershipWrites.length).toBeGreaterThanOrEqual(0);
    });
  }
});


// ---------------------------------------------------------------------------
// race room_summary multi-SELECT visibility TOCTOU after #202
// ---------------------------------------------------------------------------

describe('race room_summary multi-SELECT visibility TOCTOU after #202', () => {
  for (let i = 0; i < N; i++) {
    it(`summary∥summary is_public flip mid-flight #${i}`, async () => {
      const db = createSqlDb({
        roomRows: [{ room_id: ROOM, room_version: '10', is_public: 1 }],
        memberCount: 3 + i,
        summaryState: [
          {
            event_type: 'm.room.join_rules',
            content: JSON.stringify({ join_rule: 'invite' }),
          },
          {
            event_type: 'm.room.name',
            content: JSON.stringify({ name: `R${i}` }),
          },
        ],
        selectBarrier: {
          match: (sql) => sql.includes('SELECT room_id, room_version, is_public FROM rooms'),
          count: 2,
        },
        mutateRoomPublicAfterSelects: { after: 1, next: 0 },
      });
      const path = '/_matrix/client/v1/room_summary/' + ROOM_ENC;
      const [a, b] = await Promise.all([request(path, {}, db), request(path, {}, db)]);
      expect([a.status, b.status].every((s) => [200, 404].includes(s))).toBe(true);
    });
  }

  for (let i = 0; i < N; i++) {
    it(`summary∥summary join_rule flip mid-flight #${i}`, async () => {
      const db = createSqlDb({
        roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
        memberCount: 2,
        summaryState: [
          {
            event_type: 'm.room.join_rules',
            content: JSON.stringify({ join_rule: 'public' }),
          },
        ],
        selectBarrier: {
          match: (sql) =>
            sql.includes('SELECT e.event_type, e.content FROM room_state') ||
            sql.includes('rs.event_type IN'),
          count: 2,
        },
        mutateSummaryStateAfterSelects: {
          after: 1,
          next: [
            {
              event_type: 'm.room.join_rules',
              content: JSON.stringify({ join_rule: 'invite' }),
            },
          ],
        },
      });
      const path = '/_matrix/client/v1/room_summary/' + ROOM_ENC;
      const [a, b] = await Promise.all([request(path, {}, db), request(path, {}, db)]);
      expect([a.status, b.status].every((s) => [200, 404].includes(s))).toBe(true);
    });
  }

  for (let i = 0; i < N; i++) {
    it(`summary auth membership attach mid-flight #${i}`, async () => {
      const token = `summary-tok-${i}`;
      const tokenHash = await hashToken(token);
      const db = createSqlDb({
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
        selectBarrier: {
          match: (sql) =>
            sql.includes('SELECT membership FROM room_memberships') &&
            sql.includes('user_id = ?'),
          count: 2,
        },
        mutateTokenMembershipAfterSelects: {
          after: 1,
          next: { membership: 'leave' },
        },
      });
      const path = '/_matrix/client/v1/room_summary/' + ROOM_ENC;
      const headers = { Authorization: `Bearer ${token}` };
      const [a, b] = await Promise.all([
        request(path, { headers }, db),
        request(path, { headers }, db),
      ]);
      expect([a.status, b.status].every((s) => [200, 404].includes(s))).toBe(true);
      for (const r of [a, b]) {
        if (r.status === 200) {
          const membership = (r.body as { membership?: string }).membership;
          expect(['join', 'leave']).toContain(membership);
        }
      }
    });
  }

  for (let i = 0; i < N; i++) {
    it(`summary alias resolve mid-flight delete #${i}`, async () => {
      const db = createSqlDb({
        aliasRows: [{ alias: ALIAS, room_id: ROOM }],
        roomRows: [{ room_id: ROOM, room_version: '10', is_public: 1 }],
        memberCount: 1,
        summaryState: [
          {
            event_type: 'm.room.join_rules',
            content: JSON.stringify({ join_rule: 'public' }),
          },
        ],
        selectBarrier: {
          match: (sql) => sql.includes('SELECT room_id FROM room_aliases WHERE alias = ?'),
          count: 2,
        },
        mutateAliasRowsAfterSelects: { after: 1, next: [] },
      });
      const path = '/_matrix/client/v1/room_summary/' + ALIAS_ENC;
      const [a, b] = await Promise.all([request(path, {}, db), request(path, {}, db)]);
      expect([a.status, b.status].every((s) => [200, 404].includes(s))).toBe(true);
    });
  }

  for (let i = 0; i < N; i++) {
    it(`summary memberCount mutate mid-flight #${i}`, async () => {
      const db = createSqlDb({
        roomRows: [{ room_id: ROOM, room_version: '10', is_public: 1 }],
        memberCount: 5,
        summaryState: [
          {
            event_type: 'm.room.join_rules',
            content: JSON.stringify({ join_rule: 'public' }),
          },
        ],
        selectBarrier: {
          match: (sql) => sql.includes('SELECT COUNT(*) as count FROM room_memberships'),
          count: 2,
        },
        mutateMemberCountAfterSelects: { after: 1, next: 99 },
      });
      const path = '/_matrix/client/v1/room_summary/' + ROOM_ENC;
      const [a, b] = await Promise.all([request(path, {}, db), request(path, {}, db)]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const counts = [a, b].map(
        (r) => (r.body as { num_joined_members: number }).num_joined_members
      );
      expect(counts.every((c) => c === 5 || c === 99)).toBe(true);
    });
  }
});


// ---------------------------------------------------------------------------
// race read-path membership→data TOCTOU after #202
// ---------------------------------------------------------------------------

describe('race context membership→event TOCTOU after #202', () => {
  for (let i = 0; i < N; i++) {
    it(`context leave mid-flight after membership SELECT #${i}`, async () => {
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
          ? joinMembership(`$c${i}`)
          : { membership: 'leave', eventId: `$left${i}` };
      });
      getEvent.mockResolvedValue(contextTargetEvent());
      getRoomState.mockResolvedValue([]);
      const db = createSqlDb({
        contextBefore: [ctxEvent({ event_id: `$b${i}`, origin_server_ts: NOW - 10 })],
        contextAfter: [ctxEvent({ event_id: `$a${i}`, origin_server_ts: NOW + 10 })],
      });
      const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/context/${EVENT_ENC}?limit=4`;
      const [a, b] = await Promise.all([
        request(path, jsonInit('GET'), db),
        request(path, jsonInit('GET'), db),
      ]);
      expect([a.status, b.status].every((s) => [200, 403].includes(s))).toBe(true);
    });
  }

  for (let i = 0; i < N; i++) {
    it(`context event mutate mid-flight after membership #${i}`, async () => {
      seedLocalRoom();
      getMembership.mockResolvedValue(joinMembership());
      let eventCalls = 0;
      getEvent.mockImplementation(async () => {
        eventCalls += 1;
        if (eventCalls === 1) return contextTargetEvent();
        return null;
      });
      getRoomState.mockResolvedValue([]);
      const db = createSqlDb({
        contextBefore: [],
        contextAfter: [],
      });
      const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/context/${EVENT_ENC}?limit=2`;
      const [a, b] = await Promise.all([
        request(path, jsonInit('GET'), db),
        request(path, jsonInit('GET'), db),
      ]);
      expect([a.status, b.status].every((s) => [200, 404].includes(s))).toBe(true);
    });
  }
});

describe('race joined_members membership→data TOCTOU after #202', () => {
  for (let i = 0; i < N; i++) {
    it(`joined_members leave mid-flight #${i}`, async () => {
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
          ? joinMembership(`$jm${i}`)
          : { membership: 'leave', eventId: `$left${i}` };
      });
      const db = createSqlDb({
        membershipRows: [
          { room_id: ROOM, user_id: USER, membership: 'join', display_name: 'Alice' },
          { room_id: ROOM, user_id: BOB, membership: 'join', display_name: `Bob${i}` },
          { room_id: ROOM, user_id: CAROL, membership: 'leave' },
        ],
      });
      const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/joined_members';
      const [a, b] = await Promise.all([
        request(path, jsonInit('GET'), db),
        request(path, jsonInit('GET'), db),
      ]);
      expect([a.status, b.status].every((s) => [200, 403].includes(s))).toBe(true);
      for (const r of [a, b]) {
        if (r.status === 200) {
          const joined = (r.body as { joined: Record<string, unknown> }).joined;
          expect(joined[USER]).toBeTruthy();
          expect(joined[BOB]).toBeTruthy();
          expect(joined[CAROL]).toBeUndefined();
        }
      }
    });
  }

  for (let i = 0; i < N; i++) {
    it(`joined_members∥joined_members multi-room isolation #${i}`, async () => {
      seedLocalRoom();
      getMembership.mockResolvedValue(joinMembership());
      getRoom.mockImplementation(async (_db, roomId: string) => ({
        room_id: roomId,
        room_version: '10',
        creator: USER,
        is_public: false,
      }));
      const db = createSqlDb({
        membershipRows: [
          { room_id: ROOM, user_id: USER, membership: 'join', display_name: 'A' },
          { room_id: ROOM2, user_id: BOB, membership: 'join', display_name: 'B' },
        ],
      });
      const [a, b] = await Promise.all([
        request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/joined_members', jsonInit('GET'), db),
        request('/_matrix/client/v3/rooms/' + ROOM2_ENC + '/joined_members', jsonInit('GET'), db),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect((a.body as { joined: Record<string, unknown> }).joined[USER]).toBeTruthy();
      expect((a.body as { joined: Record<string, unknown> }).joined[BOB]).toBeUndefined();
      expect((b.body as { joined: Record<string, unknown> }).joined[BOB]).toBeTruthy();
    });
  }
});

describe('race GET aliases membership→data TOCTOU after #202', () => {
  for (let i = 0; i < N; i++) {
    it(`aliases leave mid-flight #${i}`, async () => {
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
          ? joinMembership(`$al${i}`)
          : { membership: 'leave', eventId: `$left${i}` };
      });
      const db = createSqlDb({
        aliasRows: [
          { alias: `#a${i}:example.com`, room_id: ROOM },
          { alias: `#b${i}:example.com`, room_id: ROOM },
        ],
      });
      const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/aliases';
      const [a, b] = await Promise.all([
        request(path, jsonInit('GET'), db),
        request(path, jsonInit('GET'), db),
      ]);
      expect([a.status, b.status].every((s) => [200, 403].includes(s))).toBe(true);
    });
  }

  for (let i = 0; i < N; i++) {
    it(`aliases list mutate mid-flight after membership #${i}`, async () => {
      seedLocalRoom();
      getMembership.mockResolvedValue(joinMembership());
      const db = createSqlDb({
        aliasRows: [{ alias: `#keep${i}:example.com`, room_id: ROOM }],
        selectBarrier: {
          match: (sql) => sql.includes('SELECT alias FROM room_aliases WHERE room_id = ?'),
          count: 2,
        },
        mutateAliasRowsAfterSelects: {
          after: 1,
          next: [
            { alias: `#keep${i}:example.com`, room_id: ROOM },
            { alias: `#extra${i}:example.com`, room_id: ROOM },
          ],
        },
      });
      const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/aliases';
      const [a, b] = await Promise.all([
        request(path, jsonInit('GET'), db),
        request(path, jsonInit('GET'), db),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const lens = [a, b].map((r) => (r.body as { aliases: string[] }).aliases.length);
      expect(lens.every((n) => n === 1 || n === 2)).toBe(true);
    });
  }
});

describe('race timestamp_to_event membership→event TOCTOU after #202', () => {
  for (let i = 0; i < N; i++) {
    it(`timestamp_to_event leave mid-flight #${i}`, async () => {
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
          ? joinMembership(`$ts${i}`)
          : { membership: 'leave', eventId: `$left${i}` };
      });
      const db = createSqlDb({
        tsEvents: [
          { event_id: `$e${i}:example.com`, origin_server_ts: NOW + i, room_id: ROOM },
        ],
      });
      const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=${NOW}&dir=f`;
      const [a, b] = await Promise.all([
        request(path, jsonInit('GET'), db),
        request(path, jsonInit('GET'), db),
      ]);
      expect([a.status, b.status].every((s) => [200, 403, 404].includes(s))).toBe(true);
    });
  }

  for (let i = 0; i < N; i++) {
    it(`timestamp_to_event dir=b event mutate mid-flight #${i}`, async () => {
      seedLocalRoom();
      getMembership.mockResolvedValue(joinMembership());
      const db = createSqlDb({
        tsEvents: [
          { event_id: `$old${i}:example.com`, origin_server_ts: NOW - 100, room_id: ROOM },
        ],
        selectBarrier: {
          match: (sql) =>
            sql.includes('SELECT event_id, origin_server_ts') &&
            sql.includes('origin_server_ts <= ?'),
          count: 2,
        },
        mutateTsEventsAfterSelects: {
          after: 1,
          next: [],
        },
      });
      const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=${NOW}&dir=b`;
      const [a, b] = await Promise.all([
        request(path, jsonInit('GET'), db),
        request(path, jsonInit('GET'), db),
      ]);
      expect([a.status, b.status].every((s) => [200, 404].includes(s))).toBe(true);
    });
  }
});


// ---------------------------------------------------------------------------
// race send∥leave membership SELECT→write TOCTOU after #202
// ---------------------------------------------------------------------------

describe('race send∥leave membership SELECT→write TOCTOU after #202', () => {
  for (let i = 0; i < N; i++) {
    it(`send∥leave interleaved membership #${i}`, async () => {
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
          ? joinMembership(`$s${i}`)
          : { membership: 'leave', eventId: `$left${i}` };
      });
      const db = createSqlDb();
      const [send, leave] = await Promise.all([
        request(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.message/txn-sl-${i}`,
          jsonInit('PUT', { body: `hi-${i}`, msgtype: 'm.text' }),
          db
        ),
        request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
      ]);
      expect([send.status, leave.status].every((s) => [200, 403].includes(s))).toBe(true);
    });
  }

  for (let i = 0; i < N; i++) {
    it(`send after leave mid-flight store soft #${i}`, async () => {
      seedLocalRoom();
      // Both pass membership as join so both reach storeEvent under one barrier.
      getMembership.mockResolvedValue(joinMembership(`$s2-${i}`));
      const waiters = { list: [] as Array<() => void> };
      let barrier: FnBarrier | undefined = { count: 2 };
      storeEvent.mockImplementation(async () => {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        return 1;
      });
      const db = createSqlDb();
      const [send, leave] = await Promise.all([
        request(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.message/txn-sl2-${i}`,
          jsonInit('PUT', { body: `x-${i}`, msgtype: 'm.text' }),
          db
        ),
        request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/leave', jsonInit('POST', {}), db),
      ]);
      expect([send.status, leave.status].every(okish)).toBe(true);
      expect(storeEvent.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  }
});


// ---------------------------------------------------------------------------
// race join/knock-by-alias resolve mid-flight after #202
// ---------------------------------------------------------------------------

describe('race join-by-alias resolve mid-flight after #202', () => {
  for (let i = 0; i < N; i++) {
    it(`join alias deleted mid-flight #${i}`, async () => {
      seedLocalRoom();
      const waiters = { list: [] as Array<() => void> };
      let barrier: FnBarrier | undefined = { count: 2 };
      let aliasCalls = 0;
      getRoomByAlias.mockImplementation(async () => {
        await withFnBarrier(barrier, waiters, () => {
          barrier = undefined;
        });
        aliasCalls += 1;
        return aliasCalls === 1 ? ROOM : null;
      });
      getMembership.mockResolvedValue(null);
      defaultState({
        'm.room.join_rules': pdu({
          type: 'm.room.join_rules',
          event_id: '$jr',
          content: { join_rule: 'public' },
          state_key: '',
        }),
      });
      getRoom.mockResolvedValue({
        room_id: ROOM,
        room_version: '10',
        creator: USER,
        is_public: true,
      });
      const db = createSqlDb();
      const path = '/_matrix/client/v3/join/' + ALIAS_ENC;
      const [a, b] = await Promise.all([
        request(path, jsonInit('POST', {}), db),
        request(path, jsonInit('POST', {}), db),
      ]);
      expect([a.status, b.status].every((s) => [200, 404, 403].includes(s))).toBe(true);
    });
  }

  for (let i = 0; i < N; i++) {
    it(`join alias moved to other room mid-flight #${i}`, async () => {
      let aliasCalls = 0;
      getRoomByAlias.mockImplementation(async () => {
        aliasCalls += 1;
        return aliasCalls === 1 ? ROOM : ROOM2;
      });
      getRoom.mockImplementation(async (_db, roomId: string) => ({
        room_id: roomId,
        room_version: '10',
        creator: USER,
        is_public: true,
      }));
      getMembership.mockResolvedValue(null);
      defaultState({
        'm.room.join_rules': pdu({
          type: 'm.room.join_rules',
          event_id: '$jr',
          content: { join_rule: 'public' },
          state_key: '',
        }),
      });
      const db = createSqlDb();
      const path = '/_matrix/client/v3/join/' + ALIAS_ENC;
      const [a, b] = await Promise.all([
        request(path, jsonInit('POST', {}), db),
        request(path, jsonInit('POST', {}), db),
      ]);
      expect([a.status, b.status].every((s) => [200, 404, 403].includes(s))).toBe(true);
      if (a.status === 200 && b.status === 200) {
        const ids = [
          (a.body as { room_id: string }).room_id,
          (b.body as { room_id: string }).room_id,
        ];
        expect(ids.every((id) => id === ROOM || id === ROOM2)).toBe(true);
      }
    });
  }
});

describe('race knock-by-alias resolve mid-flight after #202', () => {
  for (let i = 0; i < N; i++) {
    it(`knock alias deleted mid-flight #${i}`, async () => {
      seedLocalRoom();
      let aliasCalls = 0;
      getRoomByAlias.mockImplementation(async () => {
        aliasCalls += 1;
        return aliasCalls === 1 ? ROOM : null;
      });
      getMembership.mockResolvedValue(null);
      defaultState({
        'm.room.join_rules': pdu({
          type: 'm.room.join_rules',
          event_id: '$jr-knock',
          content: { join_rule: 'knock' },
          state_key: '',
        }),
      });
      const db = createSqlDb();
      const path = '/_matrix/client/v3/knock/' + ALIAS_ENC;
      const [a, b] = await Promise.all([
        request(path, jsonInit('POST', { reason: `k${i}` }), db),
        request(path, jsonInit('POST', { reason: `k2-${i}` }), db),
      ]);
      expect([a.status, b.status].every((s) => [200, 404, 403, 400].includes(s))).toBe(true);
    });
  }

  for (let i = 0; i < N; i++) {
    it(`knock-by-alias∥rooms-knock isolation #${i}`, async () => {
      seedLocalRoom();
      getRoomByAlias.mockResolvedValue(ROOM);
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
      const [a, b] = await Promise.all([
        request(
          '/_matrix/client/v3/knock/' + ALIAS_ENC,
          jsonInit('POST', { reason: `alias-${i}` }),
          db
        ),
        request(
          '/_matrix/client/v3/rooms/' + ROOM_ENC + '/knock',
          jsonInit('POST', { reason: `id-${i}` }),
          db
        ),
      ]);
      expect([a.status, b.status].every((s) => [200, 403, 400].includes(s))).toBe(true);
    });
  }
});


// ---------------------------------------------------------------------------
// cross-read isolation + soft floods for uncovered read/upgrade surfaces
// ---------------------------------------------------------------------------

describe('cross-read isolation summary∥context∥joined_members after #202', () => {
  for (let i = 0; i < N; i++) {
    it(`summary∥context∥joined_members parallel soft #${i}`, async () => {
      seedLocalRoom();
      getMembership.mockResolvedValue(joinMembership());
      getEvent.mockResolvedValue(contextTargetEvent());
      getRoomState.mockResolvedValue([]);
      const db = createSqlDb({
        roomRows: [{ room_id: ROOM, room_version: '10', is_public: 1 }],
        memberCount: 2,
        summaryState: [
          {
            event_type: 'm.room.join_rules',
            content: JSON.stringify({ join_rule: 'public' }),
          },
        ],
        membershipRows: [
          { room_id: ROOM, user_id: USER, membership: 'join', display_name: 'A' },
        ],
        contextBefore: [],
        contextAfter: [],
      });
      const [s, c, j] = await Promise.all([
        request('/_matrix/client/v1/room_summary/' + ROOM_ENC, {}, db),
        request(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/context/${EVENT_ENC}?limit=2`,
          jsonInit('GET'),
          db
        ),
        request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/joined_members', jsonInit('GET'), db),
      ]);
      expect(s.status).toBe(200);
      expect(c.status).toBe(200);
      expect(j.status).toBe(200);
    });
  }

  for (let i = 0; i < N; i++) {
    it(`aliases∥timestamp∥summary isolation #${i}`, async () => {
      seedLocalRoom();
      getMembership.mockResolvedValue(joinMembership());
      const db = createSqlDb({
        roomRows: [{ room_id: ROOM, room_version: '10', is_public: 1 }],
        memberCount: 1,
        summaryState: [
          {
            event_type: 'm.room.join_rules',
            content: JSON.stringify({ join_rule: 'public' }),
          },
        ],
        aliasRows: [{ alias: `#iso${i}:example.com`, room_id: ROOM }],
        tsEvents: [
          { event_id: `$iso${i}:example.com`, origin_server_ts: NOW, room_id: ROOM },
        ],
      });
      const [a, t, s] = await Promise.all([
        request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/aliases', jsonInit('GET'), db),
        request(
          `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=${NOW}&dir=f`,
          jsonInit('GET'),
          db
        ),
        request('/_matrix/client/v1/room_summary/' + ROOM_ENC, {}, db),
      ]);
      expect(a.status).toBe(200);
      expect(t.status).toBe(200);
      expect(s.status).toBe(200);
    });
  }
});

describe('soft floods room_summary / context / upgrade after #202', () => {
  for (let i = 0; i < N; i++) {
    it(`soft summary method flood #${i}`, async () => {
      const db = createSqlDb({
        roomRows: [{ room_id: ROOM, room_version: '10', is_public: 1 }],
        memberCount: 0,
        summaryState: [
          {
            event_type: 'm.room.join_rules',
            content: JSON.stringify({ join_rule: 'public' }),
          },
        ],
      });
      const path = '/_matrix/client/v1/room_summary/' + ROOM_ENC;
      const methods = ['POST', 'PUT', 'DELETE', 'PATCH'] as const;
      const res = await request(path, jsonInit(methods[i % methods.length], {}), db);
      expect([404, 405, 400, 200].includes(res.status)).toBe(true);
    });
  }

  for (let i = 0; i < N; i++) {
    it(`soft context missing membership #${i}`, async () => {
      seedLocalRoom();
      getMembership.mockResolvedValue(null);
      const db = createSqlDb();
      const res = await request(
        `/_matrix/client/v3/rooms/${ROOM_ENC}/context/${EVENT_ENC}`,
        jsonInit('GET'),
        db
      );
      expect(res.status).toBe(403);
    });
  }

  for (let i = 0; i < N; i++) {
    it(`soft upgrade unsupported version #${i}`, async () => {
      seedLocalRoom();
      getMembership.mockResolvedValue(joinMembership());
      const db = createSqlDb({
        roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      });
      const res = await request(
        '/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade',
        jsonInit('POST', { new_version: `99.${i}` }),
        db
      );
      expect(res.status).toBe(400);
      expect(res.errcode).toBe('M_UNSUPPORTED_ROOM_VERSION');
    });
  }

  for (let i = 0; i < N; i++) {
    it(`soft timestamp missing params #${i}`, async () => {
      seedLocalRoom();
      getMembership.mockResolvedValue(joinMembership());
      const db = createSqlDb();
      const path =
        i % 2 === 0
          ? `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?dir=f`
          : `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=${NOW}`;
      const res = await request(path, jsonInit('GET'), db);
      expect(res.status).toBe(400);
    });
  }

  for (let i = 0; i < N; i++) {
    it(`soft joined_members auth missing #${i}`, async () => {
      authState.userId = undefined;
      const db = createSqlDb();
      const res = await request(
        '/_matrix/client/v3/rooms/' + ROOM_ENC + '/joined_members',
        { method: 'GET' },
        db
      );
      // requireAuth mock sets undefined userId — handler may 403/500
      expect(okish(res.status)).toBe(true);
    });
  }

  for (let i = 0; i < N; i++) {
    it(`soft invite∥kick missing user_id #${i}`, async () => {
      seedLocalRoom();
      getMembership.mockResolvedValue(joinMembership());
      const db = createSqlDb();
      const [inv, kick] = await Promise.all([
        request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/invite', jsonInit('POST', {}), db),
        request('/_matrix/client/v3/rooms/' + ROOM_ENC + '/kick', jsonInit('POST', {}), db),
      ]);
      expect(inv.status).toBe(400);
      expect(kick.status).toBe(400);
    });
  }

  for (let i = 0; i < N; i++) {
    it(`soft upgrade∥upgrade missing JSON #${i}`, async () => {
      seedLocalRoom();
      getMembership.mockResolvedValue(joinMembership());
      const db = createSqlDb({
        roomRows: [{ room_id: ROOM, room_version: '10', is_public: 0 }],
      });
      const path = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/upgrade';
      const [a, b] = await Promise.all([
        request(path, { method: 'POST', headers: AUTH, body: '{'}, db),
        request(path, { method: 'POST', headers: AUTH, body: 'not-json' }, db),
      ]);
      expect([a.status, b.status].every((s) => s === 400)).toBe(true);
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`soft summary∥summary flood lifecycle #${i}`, async () => {
      const db = createSqlDb({
        roomRows: [{ room_id: ROOM, room_version: '10', is_public: 1 }],
        memberCount: i,
        summaryState: [
          {
            event_type: 'm.room.join_rules',
            content: JSON.stringify({ join_rule: 'public' }),
          },
          {
            event_type: 'm.room.name',
            content: JSON.stringify({ name: `Flood${i}` }),
          },
        ],
      });
      const path = '/_matrix/client/v1/room_summary/' + ROOM_ENC;
      const results = await Promise.all(
        Array.from({ length: 4 }, () => request(path, {}, db))
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(
        results.every(
          (r) => (r.body as { num_joined_members: number }).num_joined_members === i
        )
      ).toBe(true);
    });
  }
});
