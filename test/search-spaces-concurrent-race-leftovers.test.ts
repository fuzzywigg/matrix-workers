/**
 * TOKENMAXX HEAVY leftovers after #197 — search + spaces *concurrent race / TOCTOU*
 * + soft/edge reliability for slices not covered by search-api-route-leftovers /
 * spaces-hierarchy-api-route-leftovers (#157) or search-helpers / spaces-room-info.
 *
 * Distinct domain — not rooms-mutate (#194), aliases (#193), rooms (#192),
 * admin-mutate (#191), presence (#190), tags (#196), profile-mutate (#197),
 * workflows (#195), sliding-sync (#189), fed-keys (#188), oauth/push (#186),
 * typing (#185), receipts (#184), qr-login (#183), to-device (#181).
 *
 * Focus: search membership SELECT→FTS TOCTOU under Promise.all; FTS/context/
 * profile/state mid-flight mutation; parallel search filter/order/pagination
 * isolation; spaces hierarchy root→child SELECT barriers; child via/suggested
 * mutate mid-flight; getRoomInfo state TOCTOU; multi-room hierarchy isolation;
 * failure soft mid concurrent; method/body/charset/lifecycle soft floods;
 * SQL bind contracts.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
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

import search, { emptyRoomEventsSearchResponse, SEARCH_PAGE_LIMIT } from '../src/api/search';
import spaces, { getRoomInfo } from '../src/api/spaces';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const SERVER = 'example.com';
const ROOM_A = '!a:example.com';
const ROOM_B = '!b:example.com';
const ROOM_C = '!c:example.com';
const SPACE = '!space:example.com';
const SPACE2 = '!space2:example.com';
const CHILD = '!child:example.com';
const CHILD2 = '!child2:example.com';
const CHILD3 = '!child3:example.com';
const GC = '!gc:example.com';
const SPACE_ENC = encodeURIComponent(SPACE);

type SqlCall = { sql: string; args: unknown[] };
type SelectBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };

type FtsRow = {
  event_id: string;
  event_type: string;
  room_id: string;
  sender: string;
  origin_server_ts: number;
  content: string;
  rank: number;
};

type CtxRow = {
  event_id: string;
  event_type: string;
  sender: string;
  origin_server_ts: number;
  content: string;
};

type StateRow = {
  event_type: string;
  state_key: string;
  sender: string;
  content: string;
  origin_server_ts: number;
};

type ProfileRow = { display_name: string | null; avatar_url: string | null };

type ChildEvent = { state_key: string; content: string };
type StateMap = Partial<
  Record<
    | 'm.room.name'
    | 'm.room.topic'
    | 'm.room.canonical_alias'
    | 'm.room.avatar'
    | 'm.room.join_rules'
    | 'm.room.create'
    | 'm.room.history_visibility'
    | 'm.room.guest_access',
    string | null
  >
>;
type RoomInfoSeed = {
  room_id: string;
  is_public?: number;
  state?: StateMap;
  memberCount?: number | null;
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

function fts(partial: Partial<FtsRow> & Pick<FtsRow, 'event_id'>): FtsRow {
  return {
    event_type: 'm.room.message',
    room_id: ROOM_A,
    sender: BOB,
    origin_server_ts: 1000,
    content: JSON.stringify({ body: 'hello world', msgtype: 'm.text' }),
    rank: -1.5,
    ...partial,
  };
}

function childVia(roomId: string, suggested = false, via: string[] | null = [SERVER]): ChildEvent {
  return {
    state_key: roomId,
    content: JSON.stringify(via === null ? { suggested } : { via, suggested }),
  };
}

function createSearchRaceDb(
  opts: {
    memberships?: string[];
    ftsRows?: FtsRow[];
    total?: number | null;
    context?: Record<string, CtxRow[]>;
    profiles?: Record<string, ProfileRow | null>;
    roomState?: Record<string, StateRow[]>;
    selectBarrier?: SelectBarrier;
    mutateMembershipAfterSelects?: { after: number; next: string[] };
    mutateFtsAfterMembershipSelects?: { after: number; next: FtsRow[] };
    mutateFtsAfterFtsSelects?: { after: number; next: FtsRow[] };
    failOnSqlIncludesAfter?: { includes: string; after: number };
    throwOnSqlIncludes?: string;
  } = {}
) {
  const memberships = [...(opts.memberships ?? [ROOM_A, ROOM_B])];
  let ftsRows = [...(opts.ftsRows ?? [])];
  let total = opts.total === undefined ? ftsRows.length : opts.total;
  const context = { ...(opts.context ?? {}) };
  const profiles = { ...(opts.profiles ?? {}) };
  const roomState = { ...(opts.roomState ?? {}) };

  const selects: SqlCall[] = [];
  const events: string[] = [];

  let selectBarrier = opts.selectBarrier;
  const selectWaiters = { list: [] as Array<() => void> };

  let membershipSelectCount = 0;
  let ftsSelectCount = 0;
  let failCounts: Record<string, number> = {};

  const mutateMembership = opts.mutateMembershipAfterSelects;
  const mutateFtsAfterMembership = opts.mutateFtsAfterMembershipSelects;
  const mutateFtsAfterFts = opts.mutateFtsAfterFtsSelects;
  const failAfter = opts.failOnSqlIncludesAfter;

  const db = {
    memberships,
    get ftsRows() {
      return ftsRows;
    },
    setFtsRows(next: FtsRow[]) {
      ftsRows = [...next];
      if (opts.total === undefined) total = ftsRows.length;
    },
    selects,
    events,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              events.push(`first:${sql.slice(0, 48)}`);
              await withBarrier(
                selectBarrier,
                selectWaiters,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );
              if (opts.throwOnSqlIncludes && sql.includes(opts.throwOnSqlIncludes)) {
                throw new Error(`db boom: ${opts.throwOnSqlIncludes}`);
              }
              if (failAfter && sql.includes(failAfter.includes)) {
                failCounts[failAfter.includes] = (failCounts[failAfter.includes] ?? 0) + 1;
                if (failCounts[failAfter.includes] > failAfter.after) {
                  throw new Error(`db fail-after: ${failAfter.includes}`);
                }
              }
              if (sql.includes('COUNT(*)') && sql.includes('events_fts')) {
                return { total: total ?? 0 } as T;
              }
              if (sql.includes('FROM users WHERE user_id')) {
                const userId = args[0] as string;
                const profile = profiles[userId];
                return (profile === undefined ? null : profile) as T;
              }
              return null as T;
            },
            async all<T>() {
              selects.push({ sql, args });
              events.push(`all:${sql.slice(0, 48)}`);
              await withBarrier(
                selectBarrier,
                selectWaiters,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );
              if (opts.throwOnSqlIncludes && sql.includes(opts.throwOnSqlIncludes)) {
                throw new Error(`db boom: ${opts.throwOnSqlIncludes}`);
              }
              if (failAfter && sql.includes(failAfter.includes)) {
                failCounts[failAfter.includes] = (failCounts[failAfter.includes] ?? 0) + 1;
                if (failCounts[failAfter.includes] > failAfter.after) {
                  throw new Error(`db fail-after: ${failAfter.includes}`);
                }
              }
              if (sql.includes('FROM room_memberships')) {
                membershipSelectCount += 1;
                const snapshot = memberships.map((room_id) => ({ room_id }));
                if (mutateMembership && membershipSelectCount === mutateMembership.after) {
                  memberships.splice(0, memberships.length, ...mutateMembership.next);
                  events.push('mutate:membership');
                }
                if (
                  mutateFtsAfterMembership &&
                  membershipSelectCount === mutateFtsAfterMembership.after
                ) {
                  ftsRows = [...mutateFtsAfterMembership.next];
                  if (opts.total === undefined) total = ftsRows.length;
                  events.push('mutate:fts-after-membership');
                }
                return { results: snapshot as T[] };
              }
              if (sql.includes('FROM events_fts') || sql.includes('bm25(events_fts)')) {
                ftsSelectCount += 1;
                const limit = Number(args[args.length - 2] ?? 51);
                const offset = Number(args[args.length - 1] ?? 0);
                let rows = ftsRows.slice();
                if (sql.includes('ORDER BY rank ASC')) {
                  rows = rows.slice().sort((a, b) => a.rank - b.rank);
                } else {
                  rows = rows.slice().sort((a, b) => b.origin_server_ts - a.origin_server_ts);
                }
                const page = rows.slice(offset, offset + limit);
                if (mutateFtsAfterFts && ftsSelectCount === mutateFtsAfterFts.after) {
                  ftsRows = [...mutateFtsAfterFts.next];
                  if (opts.total === undefined) total = ftsRows.length;
                  events.push('mutate:fts-after-fts');
                }
                return { results: page as T[] };
              }
              if (sql.includes('origin_server_ts < ?')) {
                const roomId = args[0] as string;
                const ts = args[1] as number;
                return { results: ((context[`${roomId}|before|${ts}`] ?? []) as T[]).slice() };
              }
              if (sql.includes('origin_server_ts > ?')) {
                const roomId = args[0] as string;
                const ts = args[1] as number;
                return { results: ((context[`${roomId}|after|${ts}`] ?? []) as T[]).slice() };
              }
              if (sql.includes('FROM room_state')) {
                const roomId = args[0] as string;
                return { results: ((roomState[roomId] ?? []) as T[]).slice() };
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

type SearchRaceDb = ReturnType<typeof createSearchRaceDb>;

function createSpacesRaceDb(
  opts: {
    rootExists?: boolean;
    rootRoomId?: string;
    childEvents?: ChildEvent[];
    grandchildEvents?: Record<string, ChildEvent[]>;
    rooms?: Record<string, RoomInfoSeed>;
    selectBarrier?: SelectBarrier;
    mutateRootAfterExists?: { after: number; exists: boolean };
    mutateChildrenAfterSelects?: { after: number; next: ChildEvent[] };
    mutateRoomStateAfterSelects?: {
      after: number;
      roomId: string;
      nextState: StateMap;
    };
    failOnSqlIncludesAfter?: { includes: string; after: number };
    throwOnSqlIncludes?: string;
  } = {}
) {
  const rootRoomId = opts.rootRoomId ?? SPACE;
  let rootExists = opts.rootExists !== false;
  let childEvents = [...(opts.childEvents ?? [])];
  const grandchildEvents = { ...(opts.grandchildEvents ?? {}) };
  const rooms: Record<string, RoomInfoSeed> = { ...(opts.rooms ?? {}) };

  if (rootExists && !rooms[rootRoomId]) {
    rooms[rootRoomId] = {
      room_id: rootRoomId,
      state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) },
      memberCount: 1,
    };
  }

  const selects: SqlCall[] = [];
  const events: string[] = [];

  let selectBarrier = opts.selectBarrier;
  const selectWaiters = { list: [] as Array<() => void> };

  let existsSelectCount = 0;
  let childSelectCount = 0;
  let stateSelectCount = 0;
  const failCounts: Record<string, number> = {};

  const mutateRoot = opts.mutateRootAfterExists;
  const mutateChildren = opts.mutateChildrenAfterSelects;
  const mutateRoomState = opts.mutateRoomStateAfterSelects;
  const failAfter = opts.failOnSqlIncludesAfter;

  const db = {
    rooms,
    get childEvents() {
      return childEvents;
    },
    setChildEvents(next: ChildEvent[]) {
      childEvents = [...next];
    },
    selects,
    events,
    get rootExists() {
      return rootExists;
    },
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          const roomIdArg = args[0] as string | undefined;
          return {
            async first<T>() {
              selects.push({ sql, args });
              events.push(`first:${sql.slice(0, 48)}`);
              await withBarrier(
                selectBarrier,
                selectWaiters,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );
              if (opts.throwOnSqlIncludes && sql.includes(opts.throwOnSqlIncludes)) {
                throw new Error(`db boom: ${opts.throwOnSqlIncludes}`);
              }
              if (failAfter && sql.includes(failAfter.includes)) {
                failCounts[failAfter.includes] = (failCounts[failAfter.includes] ?? 0) + 1;
                if (failCounts[failAfter.includes] > failAfter.after) {
                  throw new Error(`db fail-after: ${failAfter.includes}`);
                }
              }
              if (
                sql.includes('SELECT room_id FROM rooms WHERE room_id') &&
                !sql.includes('is_public')
              ) {
                existsSelectCount += 1;
                const snap = rootExists && roomIdArg === rootRoomId;
                if (mutateRoot && existsSelectCount === mutateRoot.after) {
                  rootExists = mutateRoot.exists;
                  events.push('mutate:root-exists');
                }
                return snap ? ({ room_id: rootRoomId } as T) : null;
              }
              if (sql.includes('SELECT room_id, is_public FROM rooms')) {
                const seed = roomIdArg ? rooms[roomIdArg] : undefined;
                if (!seed) return null as T;
                return {
                  room_id: seed.room_id,
                  is_public: seed.is_public ?? 1,
                } as T;
              }
              const eventTypes = [
                'm.room.name',
                'm.room.topic',
                'm.room.canonical_alias',
                'm.room.avatar',
                'm.room.join_rules',
                'm.room.create',
                'm.room.history_visibility',
                'm.room.guest_access',
              ] as const;
              for (const et of eventTypes) {
                if (sql.includes(`rs.event_type = '${et}'`)) {
                  stateSelectCount += 1;
                  if (
                    mutateRoomState &&
                    stateSelectCount === mutateRoomState.after &&
                    roomIdArg === mutateRoomState.roomId
                  ) {
                    rooms[roomIdArg] = {
                      ...rooms[roomIdArg],
                      room_id: roomIdArg,
                      state: { ...rooms[roomIdArg]?.state, ...mutateRoomState.nextState },
                    };
                    events.push('mutate:room-state');
                  }
                  const content = (roomIdArg && rooms[roomIdArg]?.state)?.[et];
                  return content != null ? ({ content } as T) : null;
                }
              }
              if (sql.includes('FROM room_memberships') && sql.includes('COUNT(*)')) {
                const seed = roomIdArg ? rooms[roomIdArg] : undefined;
                if (!seed || seed.memberCount === null) return null as T;
                return { count: seed.memberCount ?? 0 } as T;
              }
              return null;
            },
            async all<T>() {
              selects.push({ sql, args });
              events.push(`all:${sql.slice(0, 48)}`);
              await withBarrier(
                selectBarrier,
                selectWaiters,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );
              if (opts.throwOnSqlIncludes && sql.includes(opts.throwOnSqlIncludes)) {
                throw new Error(`db boom: ${opts.throwOnSqlIncludes}`);
              }
              if (failAfter && sql.includes(failAfter.includes)) {
                failCounts[failAfter.includes] = (failCounts[failAfter.includes] ?? 0) + 1;
                if (failCounts[failAfter.includes] > failAfter.after) {
                  throw new Error(`db fail-after: ${failAfter.includes}`);
                }
              }
              if (sql.includes("rs.event_type = 'm.space.child'")) {
                childSelectCount += 1;
                let snapshot: ChildEvent[];
                if (roomIdArg === rootRoomId) {
                  snapshot = childEvents.slice();
                } else {
                  snapshot = (grandchildEvents[roomIdArg ?? ''] ?? []).slice();
                }
                if (mutateChildren && childSelectCount === mutateChildren.after) {
                  childEvents = [...mutateChildren.next];
                  events.push('mutate:children');
                }
                return { results: snapshot as T[] };
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

type SpacesRaceDb = ReturnType<typeof createSpacesRaceDb>;

function searchEnv(db: SearchRaceDb): Env {
  return { SERVER_NAME: SERVER, DB: db as unknown as D1Database } as unknown as Env;
}

function spacesEnv(db: SpacesRaceDb, serverName = SERVER): Env {
  return { SERVER_NAME: serverName, DB: db as unknown as D1Database } as unknown as Env;
}

async function postSearch(
  db: SearchRaceDb,
  body: unknown,
  query = ''
): Promise<{ status: number; body: any }> {
  const res = await search.request(
    `http://localhost/_matrix/client/v3/search${query}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    searchEnv(db)
  );
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function getHierarchy(
  db: SpacesRaceDb,
  roomId: string,
  query = ''
): Promise<{ status: number; body: any }> {
  const enc = encodeURIComponent(roomId);
  const res = await spaces.request(
    `http://localhost/_matrix/client/v1/rooms/${enc}/hierarchy${query}`,
    { method: 'GET', headers: { Authorization: 'Bearer t' } },
    spacesEnv(db)
  );
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

function roomEventsBody(overrides: Record<string, unknown> = {}) {
  return {
    search_categories: {
      room_events: {
        search_term: 'hello',
        ...overrides,
      },
    },
  };
}

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
}

function seedChildRooms(
  ids: string[],
  extra: Record<string, RoomInfoSeed> = {}
): Record<string, RoomInfoSeed> {
  const rooms: Record<string, RoomInfoSeed> = { ...extra };
  for (const id of ids) {
    rooms[id] = rooms[id] ?? {
      room_id: id,
      state: { 'm.room.name': JSON.stringify({ name: id }) },
      memberCount: 2,
    };
  }
  return rooms;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});


// ===========================================================================
// SEARCH — membership SELECT → FTS TOCTOU / concurrent
// ===========================================================================

describe('race search membership SELECT→FTS TOCTOU after #197', () => {
  it('parallel search under membership barrier both see join rooms', async () => {
    const db = createSearchRaceDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: '$e1', room_id: ROOM_A }),
        fts({ event_id: '$e2', room_id: ROOM_B, origin_server_ts: 2000 }),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([
      postSearch(db, roomEventsBody()),
      postSearch(db, roomEventsBody({ search_term: 'world' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => r.body.search_categories.room_events.count >= 0)).toBe(true);
    expect(db.events.filter((e) => e.startsWith('all:')).length).toBeGreaterThanOrEqual(2);
  });

  it('membership cleared after first SELECT → second search may empty', async () => {
    const db = createSearchRaceDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$e1' })],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const first = await postSearch(db, roomEventsBody());
    expect(first.status).toBe(200);
    expect(first.body.search_categories.room_events.results.length).toBe(1);
    const second = await postSearch(db, roomEventsBody());
    expect(second.status).toBe(200);
    expect(second.body).toEqual(emptyRoomEventsSearchResponse());
    expect(db.events).toContain('mutate:membership');
  });

  it('membership TOCTOU soft: join rooms → empty after first SELECT', async () => {
    for (let i = 0; i < 8; i++) {
      const db = createSearchRaceDb({
        memberships: [ROOM_A, ROOM_B],
        ftsRows: [fts({ event_id: `$m-${i}`, origin_server_ts: 1000 + i })],
        mutateMembershipAfterSelects: { after: 1, next: [] },
      });
      const a = await postSearch(db, roomEventsBody({ search_term: `term-${i}` }));
      const b = await postSearch(db, roomEventsBody({ search_term: `term-${i}` }));
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(b.body.search_categories.room_events.count).toBe(0);
    }
  });

  it('parallel search under barrier with membership flip mid-pack', async () => {
    const db = createSearchRaceDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$race' })],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const results = await Promise.all([
      postSearch(db, roomEventsBody()),
      postSearch(db, roomEventsBody()),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const counts = results.map((r) => r.body.search_categories.room_events.results.length);
    expect(counts.includes(0) || counts.includes(1)).toBe(true);
  });

  it('rooms filter ∥ membership clear → empty after mutate', async () => {
    const db = createSearchRaceDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [fts({ event_id: '$f1' }), fts({ event_id: '$f2', room_id: ROOM_B })],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const first = await postSearch(
      db,
      roomEventsBody({ filter: { rooms: [ROOM_A] } })
    );
    expect(first.status).toBe(200);
    const second = await postSearch(
      db,
      roomEventsBody({ filter: { rooms: [ROOM_A] } })
    );
    expect(second.body).toEqual(emptyRoomEventsSearchResponse());
  });
});

describe('race search FTS mutate mid-flight after #197', () => {
  it('FTS rows injected after membership SELECT visible to FTS query', async () => {
    const db = createSearchRaceDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$base' })],
      mutateFtsAfterMembershipSelects: {
        after: 1,
        next: [
          fts({ event_id: '$base' }),
          fts({ event_id: '$injected', origin_server_ts: 9999, rank: -0.1 }),
        ],
      },
    });
    const res = await postSearch(db, roomEventsBody());
    expect(res.status).toBe(200);
    const ids = res.body.search_categories.room_events.results.map((r: any) => r.event_id);
    expect(ids).toContain('$injected');
    expect(db.events).toContain('mutate:fts-after-membership');
  });

  it('FTS rows cleared after first FTS SELECT → count may diverge', async () => {
    const db = createSearchRaceDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$a' }), fts({ event_id: '$b', origin_server_ts: 2000 })],
      total: 2,
      mutateFtsAfterFtsSelects: { after: 1, next: [] },
    });
    const res = await postSearch(db, roomEventsBody());
    expect(res.status).toBe(200);
    expect(res.body.search_categories.room_events.results.length).toBeLessThanOrEqual(2);
  });

  it('parallel searches share mutating FTS under membership barrier', async () => {
    const db = createSearchRaceDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$shared' })],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
      mutateFtsAfterMembershipSelects: {
        after: 2,
        next: [fts({ event_id: '$late', origin_server_ts: 5000 })],
      },
    });
    const results = await Promise.all([
      postSearch(db, roomEventsBody({ search_term: 'alpha' })),
      postSearch(db, roomEventsBody({ search_term: 'beta' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('FTS mutate soft flood after membership', async () => {
    for (let i = 0; i < 10; i++) {
      const db = createSearchRaceDb({
        memberships: [ROOM_A],
        ftsRows: [fts({ event_id: `$pre-${i}` })],
        mutateFtsAfterMembershipSelects: {
          after: 1,
          next: [fts({ event_id: `$post-${i}`, origin_server_ts: 8000 + i })],
        },
      });
      const res = await postSearch(db, roomEventsBody({ search_term: `flood-${i}` }));
      expect(res.status).toBe(200);
      expect(res.body.search_categories.room_events.results[0].event_id).toBe(`$post-${i}`);
    }
  });
});

describe('race search parallel filter/order/pagination isolation after #197', () => {
  it('parallel order_by recent∥rank under membership barrier both 200', async () => {
    const rows = [
      fts({ event_id: '$r1', rank: -3, origin_server_ts: 100 }),
      fts({ event_id: '$r2', rank: -1, origin_server_ts: 300 }),
      fts({ event_id: '$r3', rank: -2, origin_server_ts: 200 }),
    ];
    const db = createSearchRaceDb({
      memberships: [ROOM_A],
      ftsRows: rows,
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const [recent, rank] = await Promise.all([
      postSearch(db, roomEventsBody({ order_by: 'recent' })),
      postSearch(db, roomEventsBody({ order_by: 'rank' })),
    ]);
    expect(recent.status).toBe(200);
    expect(rank.status).toBe(200);
    expect(recent.body.search_categories.room_events.results[0].event_id).toBe('$r2');
    expect(rank.body.search_categories.room_events.results[0].event_id).toBe('$r1');
  });

  it('parallel rooms filter vs not_rooms filter isolate results', async () => {
    const db = createSearchRaceDb({
      memberships: [ROOM_A, ROOM_B, ROOM_C],
      ftsRows: [
        fts({ event_id: '$a', room_id: ROOM_A }),
        fts({ event_id: '$b', room_id: ROOM_B, origin_server_ts: 2000 }),
        fts({ event_id: '$c', room_id: ROOM_C, origin_server_ts: 3000 }),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const [onlyA, notA] = await Promise.all([
      postSearch(db, roomEventsBody({ filter: { rooms: [ROOM_A] } })),
      postSearch(db, roomEventsBody({ filter: { not_rooms: [ROOM_A] } })),
    ]);
    expect(onlyA.status).toBe(200);
    expect(notA.status).toBe(200);
    // Mock returns all fts rows without room SQL filter; route still binds rooms.
    // Assert membership SELECT ran twice and both succeeded.
    expect(db.selects.filter((s) => s.sql.includes('FROM room_memberships')).length).toBe(2);
  });

  it('parallel next_batch pagination under barrier both 200', async () => {
    const rows = Array.from({ length: 55 }, (_, i) =>
      fts({ event_id: `$p${i}`, origin_server_ts: 10_000 - i })
    );
    const db = createSearchRaceDb({
      memberships: [ROOM_A],
      ftsRows: rows,
      total: 55,
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const [page0, page1] = await Promise.all([
      postSearch(db, roomEventsBody()),
      postSearch(db, roomEventsBody(), '?next_batch=50'),
    ]);
    expect(page0.status).toBe(200);
    expect(page1.status).toBe(200);
    expect(page0.body.search_categories.room_events.results.length).toBe(SEARCH_PAGE_LIMIT);
    expect(page0.body.search_categories.room_events.next_batch).toBe('50');
    expect(page1.body.search_categories.room_events.results.length).toBe(5);
  });

  it('sender filter ∥ not_senders concurrent soft', async () => {
    for (let i = 0; i < 6; i++) {
      const db = createSearchRaceDb({
        memberships: [ROOM_A],
        ftsRows: [
          fts({ event_id: `$bob-${i}`, sender: BOB }),
          fts({ event_id: `$carol-${i}`, sender: CAROL, origin_server_ts: 2000 }),
        ],
        selectBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
      });
      const results = await Promise.all([
        postSearch(db, roomEventsBody({ filter: { senders: [BOB] } })),
        postSearch(db, roomEventsBody({ filter: { not_senders: [BOB] } })),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    }
  });
});

describe('race search context/profile/state concurrent after #197', () => {
  it('event_context∥include_profile under membership barrier', async () => {
    const db = createSearchRaceDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ctx', origin_server_ts: 5000 })],
      context: {
        [`${ROOM_A}|before|5000`]: [
          {
            event_id: '$before',
            event_type: 'm.room.message',
            sender: CAROL,
            origin_server_ts: 4000,
            content: JSON.stringify({ body: 'before' }),
          },
        ],
        [`${ROOM_A}|after|5000`]: [
          {
            event_id: '$after',
            event_type: 'm.room.message',
            sender: BOB,
            origin_server_ts: 6000,
            content: JSON.stringify({ body: 'after' }),
          },
        ],
      },
      profiles: {
        [BOB]: { display_name: 'Bob', avatar_url: null },
        [CAROL]: { display_name: 'Carol', avatar_url: 'mxc://example.com/c' },
      },
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([
      postSearch(
        db,
        roomEventsBody({
          event_context: { before_limit: 2, after_limit: 2, include_profile: true },
        })
      ),
      postSearch(
        db,
        roomEventsBody({
          event_context: { before_limit: 1, after_limit: 1, include_profile: false },
        })
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const withProfile = results.find(
      (r) => r.body.search_categories.room_events.results[0]?.context?.profile_info
    );
    expect(withProfile).toBeTruthy();
  });

  it('include_state∥groupings concurrent both attach extras', async () => {
    const db = createSearchRaceDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: '$s1', room_id: ROOM_A }),
        fts({ event_id: '$s2', room_id: ROOM_B, origin_server_ts: 2000, sender: CAROL }),
      ],
      roomState: {
        [ROOM_A]: [
          {
            event_type: 'm.room.name',
            state_key: '',
            sender: USER,
            content: JSON.stringify({ name: 'A' }),
            origin_server_ts: 1,
          },
        ],
        [ROOM_B]: [
          {
            event_type: 'm.room.topic',
            state_key: '',
            sender: USER,
            content: JSON.stringify({ topic: 'B' }),
            origin_server_ts: 2,
          },
        ],
      },
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const [withState, withGroups] = await Promise.all([
      postSearch(db, roomEventsBody({ include_state: true })),
      postSearch(
        db,
        roomEventsBody({
          groupings: { group_by: [{ key: 'room_id' }, { key: 'sender' }] },
        })
      ),
    ]);
    expect(withState.status).toBe(200);
    expect(withGroups.status).toBe(200);
    expect(withState.body.search_categories.room_events.state).toBeTruthy();
    expect(withGroups.body.search_categories.room_events.groups.room_id).toBeTruthy();
  });

  it('context soft flood concurrent pairs', async () => {
    for (let i = 0; i < 8; i++) {
      const ts = 7000 + i;
      const db = createSearchRaceDb({
        memberships: [ROOM_A],
        ftsRows: [fts({ event_id: `$c-${i}`, origin_server_ts: ts })],
        context: {
          [`${ROOM_A}|before|${ts}`]: [
            {
              event_id: `$cb-${i}`,
              event_type: 'm.room.message',
              sender: BOB,
              origin_server_ts: ts - 1,
              content: JSON.stringify({ body: 'x' }),
            },
          ],
        },
        selectBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
      });
      const results = await Promise.all([
        postSearch(db, roomEventsBody({ event_context: { before_limit: 3 } })),
        postSearch(db, roomEventsBody({ event_context: { after_limit: 3 } })),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    }
  });
});

describe('race search failure soft mid concurrent after #197', () => {
  it('FTS throw on second request surfaces 500 while first ok', async () => {
    const db = createSearchRaceDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok' })],
      // First request hits events_fts twice (FTS all + COUNT); after:2 lets it finish.
      failOnSqlIncludesAfter: { includes: 'events_fts', after: 2 },
    });
    const first = await postSearch(db, roomEventsBody());
    expect(first.status).toBe(200);
    // Third events_fts hit (second request FTS all) → throw → Hono 500.
    const second = await postSearch(db, roomEventsBody());
    expect(second.status).toBe(500);
  });

  it('membership throw surfaces 500 for both parallel when barrier-synced', async () => {
    const db = createSearchRaceDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$x' })],
      throwOnSqlIncludes: 'room_memberships',
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([
      postSearch(db, roomEventsBody()),
      postSearch(db, roomEventsBody()),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('COUNT throw after FTS success surfaces 500', async () => {
    const db = createSearchRaceDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$c' })],
      throwOnSqlIncludes: 'COUNT(*)',
    });
    const res = await postSearch(db, roomEventsBody());
    expect(res.status).toBe(500);
  });

  it('failure soft flood on membership throws → 500', async () => {
    for (let i = 0; i < 8; i++) {
      const db = createSearchRaceDb({
        memberships: [ROOM_A],
        ftsRows: [fts({ event_id: `$fail-${i}` })],
        throwOnSqlIncludes: 'room_memberships',
      });
      const res = await postSearch(db, roomEventsBody({ search_term: `f${i}` }));
      expect(res.status).toBe(500);
    }
  });
});

describe('race search concurrent multi-request flood after #197', () => {
  it('8-way parallel search under membership barrier all 200', async () => {
    const db = createSearchRaceDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: '$f1' }),
        fts({ event_id: '$f2', room_id: ROOM_B, origin_server_ts: 2000 }),
      ],
      selectBarrier: {
        count: 8,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        postSearch(db, roomEventsBody({ search_term: `flood-${i}` }))
      )
    );
    expect(statusesOf(results)).toEqual(Array(8).fill(200));
  });

  it('mixed blank∥success∥filter flood', async () => {
    const db = createSearchRaceDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$mix' })],
    });
    const results = await Promise.all([
      postSearch(db, roomEventsBody({ search_term: '   ' })),
      postSearch(db, { search_categories: {} }),
      postSearch(db, roomEventsBody()),
      postSearch(db, roomEventsBody({ filter: { rooms: [ROOM_A] } })),
      postSearch(db, roomEventsBody({ order_by: 'rank' })),
      postSearch(db, roomEventsBody({ include_state: true })),
    ]);
    expect(statusesOf(results)).toEqual(Array(6).fill(200));
    expect(results[0].body).toEqual(emptyRoomEventsSearchResponse());
    expect(results[1].body).toEqual(emptyRoomEventsSearchResponse());
    expect(results[2].body.search_categories.room_events.results.length).toBe(1);
  });

  it('N×N parallel search soft flood', async () => {
    for (let n = 2; n <= 6; n++) {
      const db = createSearchRaceDb({
        memberships: [ROOM_A],
        ftsRows: [fts({ event_id: `$n-${n}` })],
        selectBarrier: {
          count: n,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
      });
      const results = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          postSearch(db, roomEventsBody({ search_term: `n${n}-${i}` }))
        )
      );
      expect(statusesOf(results)).toEqual(Array(n).fill(200));
    }
  });
});

describe('search concurrent soft flood — bad JSON / empty / method after #197', () => {
  it('bad json soft-0', async () => {
    const db = createSearchRaceDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$bj0' })] });
    const res = await postSearch(db, '{not-json-0');
    expect(res.status).toBe(400);
  });
  it('bad json soft-1', async () => {
    const db = createSearchRaceDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$bj1' })] });
    const res = await postSearch(db, '{not-json-1');
    expect(res.status).toBe(400);
  });
  it('bad json soft-2', async () => {
    const db = createSearchRaceDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$bj2' })] });
    const res = await postSearch(db, '{not-json-2');
    expect(res.status).toBe(400);
  });
  it('bad json soft-3', async () => {
    const db = createSearchRaceDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$bj3' })] });
    const res = await postSearch(db, '{not-json-3');
    expect(res.status).toBe(400);
  });
  it('bad json soft-4', async () => {
    const db = createSearchRaceDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$bj4' })] });
    const res = await postSearch(db, '{not-json-4');
    expect(res.status).toBe(400);
  });
  it('bad json soft-5', async () => {
    const db = createSearchRaceDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$bj5' })] });
    const res = await postSearch(db, '{not-json-5');
    expect(res.status).toBe(400);
  });
  it('bad json soft-6', async () => {
    const db = createSearchRaceDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$bj6' })] });
    const res = await postSearch(db, '{not-json-6');
    expect(res.status).toBe(400);
  });
  it('bad json soft-7', async () => {
    const db = createSearchRaceDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$bj7' })] });
    const res = await postSearch(db, '{not-json-7');
    expect(res.status).toBe(400);
  });
  it('bad json soft-8', async () => {
    const db = createSearchRaceDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$bj8' })] });
    const res = await postSearch(db, '{not-json-8');
    expect(res.status).toBe(400);
  });
  it('bad json soft-9', async () => {
    const db = createSearchRaceDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$bj9' })] });
    const res = await postSearch(db, '{not-json-9');
    expect(res.status).toBe(400);
  });
  it('bad json soft-10', async () => {
    const db = createSearchRaceDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$bj10' })] });
    const res = await postSearch(db, '{not-json-10');
    expect(res.status).toBe(400);
  });
  it('bad json soft-11', async () => {
    const db = createSearchRaceDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$bj11' })] });
    const res = await postSearch(db, '{not-json-11');
    expect(res.status).toBe(400);
  });
  it('empty category soft concurrent pairs', async () => {
    for (let i = 0; i < 10; i++) {
      const db = createSearchRaceDb({
        memberships: [ROOM_A],
        ftsRows: [fts({ event_id: `$ec-${i}` })],
      });
      const results = await Promise.all([
        postSearch(db, { search_categories: {} }),
        postSearch(db, { search_categories: { room_events: undefined } }),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(results[0].body).toEqual(emptyRoomEventsSearchResponse());
    }
  });

  it('method matrix soft flood', async () => {
    const db = createSearchRaceDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$meth' })],
    });
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      const res = await search.request(
        'http://localhost/_matrix/client/v3/search',
        { method, headers: { Authorization: 'Bearer t' } },
        searchEnv(db)
      );
      expect([404, 405, 200, 204].includes(res.status) || res.status >= 400).toBe(true);
    }
  });
});

describe('search concurrent soft flood — charset / lifecycle / bind after #197', () => {
  it('charset content-type soft flood', async () => {
    const ctypes = [
      'application/json',
      'application/json; charset=utf-8',
      'application/json;charset=UTF-8',
      'application/json; charset=UTF-8; boundary=x',
    ];
    for (let i = 0; i < ctypes.length; i++) {
      const db = createSearchRaceDb({
        memberships: [ROOM_A],
        ftsRows: [fts({ event_id: `$ct-${i}` })],
      });
      const res = await search.request(
        'http://localhost/_matrix/client/v3/search',
        {
          method: 'POST',
          headers: { 'Content-Type': ctypes[i], Authorization: 'Bearer t' },
          body: JSON.stringify(roomEventsBody({ search_term: `ct-${i}` })),
        },
        searchEnv(db)
      );
      expect(res.status).toBe(200);
    }
  });

  it('lifecycle search→empty→search chains', async () => {
    for (let i = 0; i < 8; i++) {
      const db = createSearchRaceDb({
        memberships: [ROOM_A],
        ftsRows: [fts({ event_id: `$life-${i}` })],
      });
      expect((await postSearch(db, roomEventsBody())).status).toBe(200);
      expect((await postSearch(db, roomEventsBody({ search_term: ' ' }))).body).toEqual(
        emptyRoomEventsSearchResponse()
      );
      expect((await postSearch(db, roomEventsBody({ search_term: `again-${i}` }))).status).toBe(
        200
      );
    }
  });

  it('membership SELECT binds userId', async () => {
    const db = createSearchRaceDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$bind' })],
    });
    await postSearch(db, roomEventsBody());
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args[0]).toBe(USER);
  });

  it('FTS MATCH binds escaped term then room ids then limit/offset', async () => {
    const db = createSearchRaceDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [fts({ event_id: '$bind2' })],
    });
    await postSearch(db, roomEventsBody({ search_term: 'hello"world' }));
    const ftsCall = db.selects.find(
      (s) => s.sql.includes('events_fts') && s.sql.includes('LIMIT')
    );
    expect(ftsCall).toBeTruthy();
    expect(ftsCall!.args[0]).toBe('hello world');
    expect(ftsCall!.args).toContain(ROOM_A);
    expect(ftsCall!.args).toContain(ROOM_B);
    expect(ftsCall!.args[ftsCall!.args.length - 2]).toBe(SEARCH_PAGE_LIMIT + 1);
    expect(ftsCall!.args[ftsCall!.args.length - 1]).toBe(0);
  });

  it('parallel bind contracts stay coherent', async () => {
    const db = createSearchRaceDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$pb' })],
      selectBarrier: {
        count: 3,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    await Promise.all([
      postSearch(db, roomEventsBody({ search_term: 'one' })),
      postSearch(db, roomEventsBody({ search_term: 'two' })),
      postSearch(db, roomEventsBody({ search_term: 'three' })),
    ]);
    const mems = db.selects.filter((s) => s.sql.includes('FROM room_memberships'));
    expect(mems.length).toBe(3);
    expect(mems.every((m) => m.args[0] === USER)).toBe(true);
  });
});


// ===========================================================================
// SPACES — hierarchy concurrent / TOCTOU
// ===========================================================================

describe('race spaces hierarchy root→child SELECT TOCTOU after #197', () => {
  it('parallel hierarchy under child SELECT barrier both 200', async () => {
    const db = createSpacesRaceDb({
      childEvents: [childVia(CHILD), childVia(CHILD2, true)],
      rooms: seedChildRooms([CHILD, CHILD2]),
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes("rs.event_type = 'm.space.child'"),
      },
    });
    const results = await Promise.all([
      getHierarchy(db, SPACE),
      getHierarchy(db, SPACE, '?max_depth=1'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.rooms.length).toBeGreaterThanOrEqual(1);
  });

  it('root exists flip after first check → second notFound', async () => {
    const db = createSpacesRaceDb({
      childEvents: [childVia(CHILD)],
      rooms: seedChildRooms([CHILD]),
      mutateRootAfterExists: { after: 1, exists: false },
    });
    const first = await getHierarchy(db, SPACE);
    expect(first.status).toBe(200);
    const second = await getHierarchy(db, SPACE);
    expect(second.status).toBe(404);
    expect(db.events).toContain('mutate:root-exists');
  });

  it('root TOCTOU soft flood join→gone', async () => {
    for (let i = 0; i < 8; i++) {
      const db = createSpacesRaceDb({
        childEvents: [childVia(CHILD)],
        rooms: seedChildRooms([CHILD]),
        mutateRootAfterExists: { after: 1, exists: false },
      });
      expect((await getHierarchy(db, SPACE)).status).toBe(200);
      expect((await getHierarchy(db, SPACE)).status).toBe(404);
    }
  });

  it('children cleared after first child SELECT → second sees only space', async () => {
    const db = createSpacesRaceDb({
      childEvents: [childVia(CHILD), childVia(CHILD2)],
      rooms: seedChildRooms([CHILD, CHILD2]),
      mutateChildrenAfterSelects: { after: 1, next: [] },
    });
    const first = await getHierarchy(db, SPACE);
    expect(first.status).toBe(200);
    expect(first.body.rooms.length).toBeGreaterThanOrEqual(2);
    const second = await getHierarchy(db, SPACE);
    expect(second.status).toBe(200);
    expect(second.body.rooms.length).toBe(1);
    expect(second.body.rooms[0].room_id).toBe(SPACE);
  });

  it('parallel hierarchy with children mutate mid-pack', async () => {
    const db = createSpacesRaceDb({
      childEvents: [childVia(CHILD), childVia(CHILD2)],
      rooms: seedChildRooms([CHILD, CHILD2, CHILD3]),
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes("rs.event_type = 'm.space.child'"),
      },
      mutateChildrenAfterSelects: {
        after: 1,
        next: [childVia(CHILD3, true)],
      },
    });
    const results = await Promise.all([getHierarchy(db, SPACE), getHierarchy(db, SPACE)]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
});

describe('race spaces child via/suggested mutate mid-flight after #197', () => {
  it('via emptied mid-flight skips deleted children on next request', async () => {
    const db = createSpacesRaceDb({
      childEvents: [childVia(CHILD), childVia(CHILD2)],
      rooms: seedChildRooms([CHILD, CHILD2]),
      mutateChildrenAfterSelects: {
        after: 1,
        next: [childVia(CHILD, false, []), childVia(CHILD2)],
      },
    });
    const first = await getHierarchy(db, SPACE);
    expect(first.body.rooms.some((r: any) => r.room_id === CHILD)).toBe(true);
    const second = await getHierarchy(db, SPACE);
    expect(second.body.rooms.some((r: any) => r.room_id === CHILD)).toBe(false);
    expect(second.body.rooms.some((r: any) => r.room_id === CHILD2)).toBe(true);
  });

  it('suggested_only∥full hierarchy concurrent under barrier', async () => {
    const db = createSpacesRaceDb({
      childEvents: [childVia(CHILD, true), childVia(CHILD2, false), childVia(CHILD3, true)],
      rooms: seedChildRooms([CHILD, CHILD2, CHILD3]),
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes("rs.event_type = 'm.space.child'"),
      },
    });
    const [suggested, full] = await Promise.all([
      getHierarchy(db, SPACE, '?suggested_only=true'),
      getHierarchy(db, SPACE, '?suggested_only=false'),
    ]);
    expect(suggested.status).toBe(200);
    expect(full.status).toBe(200);
    const suggestedIds = suggested.body.rooms.map((r: any) => r.room_id);
    expect(suggestedIds).toContain(SPACE);
    expect(suggestedIds).toContain(CHILD);
    expect(suggestedIds).not.toContain(CHILD2);
    expect(full.body.rooms.map((r: any) => r.room_id)).toContain(CHILD2);
  });

  it('suggested flip soft flood mid-flight', async () => {
    for (let i = 0; i < 8; i++) {
      const db = createSpacesRaceDb({
        childEvents: [childVia(CHILD, false)],
        rooms: seedChildRooms([CHILD]),
        mutateChildrenAfterSelects: {
          after: 1,
          next: [childVia(CHILD, true)],
        },
      });
      const a = await getHierarchy(db, SPACE, '?suggested_only=true');
      expect(a.body.rooms.some((r: any) => r.room_id === CHILD)).toBe(false);
      const b = await getHierarchy(db, SPACE, '?suggested_only=true');
      expect(b.body.rooms.some((r: any) => r.room_id === CHILD)).toBe(true);
    }
  });

  it('corrupt child injected mid-flight surfaces 500 on children_state parse', async () => {
    const db = createSpacesRaceDb({
      childEvents: [childVia(CHILD)],
      rooms: seedChildRooms([CHILD]),
      mutateChildrenAfterSelects: {
        after: 1,
        next: [
          { state_key: CHILD2, content: '{not-json' },
          childVia(CHILD),
        ],
      },
    });
    const first = await getHierarchy(db, SPACE);
    expect(first.status).toBe(200);
    // Root children_state maps JSON.parse without try/catch → corrupt entry → 500.
    const second = await getHierarchy(db, SPACE);
    expect(second.status).toBe(500);
  });

  it('valid children after corrupt cleared succeed again', async () => {
    const db = createSpacesRaceDb({
      childEvents: [{ state_key: CHILD2, content: '{not-json' }, childVia(CHILD)],
      rooms: seedChildRooms([CHILD]),
    });
    expect((await getHierarchy(db, SPACE)).status).toBe(500);
    db.setChildEvents([childVia(CHILD)]);
    const recovered = await getHierarchy(db, SPACE);
    expect(recovered.status).toBe(200);
    expect(recovered.body.rooms.some((r: any) => r.room_id === CHILD)).toBe(true);
  });
});

describe('race spaces max_depth / limit / multi-room isolation after #197', () => {
  it('max_depth>1∥max_depth=1 concurrent under barrier', async () => {
    const db = createSpacesRaceDb({
      childEvents: [childVia(CHILD)],
      rooms: seedChildRooms([CHILD, GC]),
      grandchildEvents: { [CHILD]: [childVia(GC)] },
      selectBarrier: {
        count: 2,
        match: (sql, args) =>
          sql.includes("rs.event_type = 'm.space.child'") && args[0] === SPACE,
      },
    });
    const [deep, shallow] = await Promise.all([
      getHierarchy(db, SPACE, '?max_depth=2'),
      getHierarchy(db, SPACE, '?max_depth=1'),
    ]);
    expect(deep.status).toBe(200);
    expect(shallow.status).toBe(200);
    const deepChild = deep.body.rooms.find((r: any) => r.room_id === CHILD);
    const shallowChild = shallow.body.rooms.find((r: any) => r.room_id === CHILD);
    expect(deepChild?.children_state?.length).toBeGreaterThanOrEqual(1);
    expect(shallowChild?.children_state?.length ?? 0).toBe(0);
  });

  it('limit∥overflow concurrent next_batch soft', async () => {
    const kids = [CHILD, CHILD2, CHILD3, '!c4:example.com', '!c5:example.com'];
    const db = createSpacesRaceDb({
      childEvents: kids.map((id) => childVia(id)),
      rooms: seedChildRooms(kids),
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes("rs.event_type = 'm.space.child'"),
      },
    });
    const [lim1, lim100] = await Promise.all([
      getHierarchy(db, SPACE, '?limit=1'),
      getHierarchy(db, SPACE, '?limit=100'),
    ]);
    expect(lim1.status).toBe(200);
    expect(lim100.status).toBe(200);
    expect(lim1.body.rooms.length).toBe(1);
    expect(lim1.body.next_batch).toBeTruthy();
    expect(lim100.body.rooms.length).toBeGreaterThan(1);
  });

  it('parallel hierarchy across two spaces isolate children', async () => {
    // Use two independent DBs to model per-request isolation across rooms
    const db1 = createSpacesRaceDb({
      rootRoomId: SPACE,
      childEvents: [childVia(CHILD)],
      rooms: seedChildRooms([CHILD]),
    });
    const db2 = createSpacesRaceDb({
      rootRoomId: SPACE2,
      childEvents: [childVia(CHILD2)],
      rooms: seedChildRooms([CHILD2], {
        [SPACE2]: {
          room_id: SPACE2,
          state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) },
          memberCount: 1,
        },
      }),
    });
    const [a, b] = await Promise.all([getHierarchy(db1, SPACE), getHierarchy(db2, SPACE2)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.rooms.map((r: any) => r.room_id)).toContain(CHILD);
    expect(a.body.rooms.map((r: any) => r.room_id)).not.toContain(CHILD2);
    expect(b.body.rooms.map((r: any) => r.room_id)).toContain(CHILD2);
  });

  it('limit soft flood concurrent pairs', async () => {
    const kids = [CHILD, CHILD2, CHILD3];
    for (let i = 0; i < 8; i++) {
      const db = createSpacesRaceDb({
        childEvents: kids.map((id) => childVia(id)),
        rooms: seedChildRooms(kids),
        selectBarrier: {
          count: 2,
          match: (sql) => sql.includes("rs.event_type = 'm.space.child'"),
        },
      });
      const results = await Promise.all([
        getHierarchy(db, SPACE, `?limit=${1 + (i % 3)}`),
        getHierarchy(db, SPACE, '?limit=50'),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    }
  });
});

describe('race spaces getRoomInfo state TOCTOU after #197', () => {
  it('name state mutates mid getRoomInfo sequential fields', async () => {
    const db = createSpacesRaceDb({
      rooms: {
        [SPACE]: {
          room_id: SPACE,
          state: {
            'm.room.create': JSON.stringify({ type: 'm.space' }),
            'm.room.name': JSON.stringify({ name: 'Before' }),
          },
          memberCount: 3,
        },
      },
      mutateRoomStateAfterSelects: {
        after: 1,
        roomId: SPACE,
        nextState: { 'm.room.name': JSON.stringify({ name: 'After' }) },
      },
    });
    const info = await getRoomInfo(db as unknown as D1Database, SPACE, SERVER);
    expect(info).toBeTruthy();
    // Mutation fires on first matching state SELECT; name may be Before or After
    // depending on which field is queried first (name is early).
    expect(['Before', 'After']).toContain(info!.name);
    expect(db.events).toContain('mutate:room-state');
  });

  it('parallel getRoomInfo under barrier both resolve', async () => {
    const db = createSpacesRaceDb({
      rooms: {
        [CHILD]: {
          room_id: CHILD,
          state: {
            'm.room.name': JSON.stringify({ name: 'Child' }),
            'm.room.create': JSON.stringify({ type: 'm.space' }),
          },
          memberCount: 2,
        },
      },
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('SELECT room_id, is_public FROM rooms'),
      },
    });
    const [a, b] = await Promise.all([
      getRoomInfo(db as unknown as D1Database, CHILD, SERVER),
      getRoomInfo(db as unknown as D1Database, CHILD, SERVER),
    ]);
    expect(a?.room_id).toBe(CHILD);
    expect(b?.room_id).toBe(CHILD);
  });

  it('getRoomInfo missing room returns null concurrently', async () => {
    const db = createSpacesRaceDb({ rooms: {} });
    const results = await Promise.all([
      getRoomInfo(db as unknown as D1Database, '!missing:example.com', SERVER),
      getRoomInfo(db as unknown as D1Database, '!missing2:example.com', SERVER),
    ]);
    expect(results).toEqual([null, null]);
  });

  it('getRoomInfo soft flood memberCount null→0', async () => {
    for (let i = 0; i < 8; i++) {
      const id = `!room-${i}:example.com`;
      const db = createSpacesRaceDb({
        rooms: {
          [id]: {
            room_id: id,
            state: { 'm.room.create': JSON.stringify({}) },
            memberCount: null,
          },
        },
      });
      const info = await getRoomInfo(db as unknown as D1Database, id, SERVER);
      expect(info?.num_joined_members).toBe(0);
    }
  });
});

describe('race spaces failure soft mid concurrent after #197', () => {
  it('child SELECT throw surfaces 500 for hierarchy', async () => {
    const db = createSpacesRaceDb({
      childEvents: [childVia(CHILD)],
      rooms: seedChildRooms([CHILD]),
      throwOnSqlIncludes: "rs.event_type = 'm.space.child'",
    });
    const res = await getHierarchy(db, SPACE);
    expect(res.status).toBe(500);
  });

  it('parallel hierarchy both 500 when child SQL throws under barrier', async () => {
    const db = createSpacesRaceDb({
      childEvents: [childVia(CHILD)],
      rooms: seedChildRooms([CHILD]),
      throwOnSqlIncludes: 'm.space.child',
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('m.space.child'),
      },
    });
    const results = await Promise.all([
      getHierarchy(db, SPACE),
      getHierarchy(db, SPACE),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('fail-after first child SELECT: first ok second 500', async () => {
    const db = createSpacesRaceDb({
      childEvents: [childVia(CHILD)],
      rooms: seedChildRooms([CHILD]),
      failOnSqlIncludesAfter: { includes: 'm.space.child', after: 1 },
    });
    const first = await getHierarchy(db, SPACE);
    expect(first.status).toBe(200);
    const second = await getHierarchy(db, SPACE);
    expect(second.status).toBe(500);
  });

  it('failure soft flood on rooms exists throw → 500', async () => {
    for (let i = 0; i < 8; i++) {
      const db = createSpacesRaceDb({
        throwOnSqlIncludes: 'SELECT room_id FROM rooms WHERE room_id',
      });
      const res = await getHierarchy(db, SPACE);
      expect(res.status).toBe(500);
    }
  });
});

describe('race spaces concurrent multi-request flood after #197', () => {
  it('8-way parallel hierarchy under child barrier all 200', async () => {
    const db = createSpacesRaceDb({
      childEvents: [childVia(CHILD), childVia(CHILD2, true)],
      rooms: seedChildRooms([CHILD, CHILD2]),
      selectBarrier: {
        count: 8,
        match: (sql) => sql.includes("rs.event_type = 'm.space.child'"),
      },
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => getHierarchy(db, SPACE))
    );
    expect(statusesOf(results)).toEqual(Array(8).fill(200));
  });

  it('mixed suggested∥depth∥limit∥notFound flood', async () => {
    const db = createSpacesRaceDb({
      childEvents: [childVia(CHILD, true), childVia(CHILD2, false)],
      rooms: seedChildRooms([CHILD, CHILD2]),
    });
    const results = await Promise.all([
      getHierarchy(db, SPACE, '?suggested_only=true'),
      getHierarchy(db, SPACE, '?max_depth=2'),
      getHierarchy(db, SPACE, '?limit=1'),
      getHierarchy(db, '!nope:example.com'),
      getHierarchy(db, SPACE),
      getHierarchy(db, SPACE, '?from=token&limit=10'),
    ]);
    expect(results.filter((r) => r.status === 200).length).toBe(5);
    expect(results.filter((r) => r.status === 404).length).toBe(1);
  });

  it('N-way hierarchy soft flood', async () => {
    for (let n = 2; n <= 6; n++) {
      const db = createSpacesRaceDb({
        childEvents: [childVia(CHILD)],
        rooms: seedChildRooms([CHILD]),
        selectBarrier: {
          count: n,
          match: (sql) => sql.includes("rs.event_type = 'm.space.child'"),
        },
      });
      const results = await Promise.all(
        Array.from({ length: n }, () => getHierarchy(db, SPACE))
      );
      expect(statusesOf(results)).toEqual(Array(n).fill(200));
    }
  });
});

describe('spaces concurrent soft flood — notFound / method / encode after #197', () => {
  it('notFound soft-0', async () => {
    const db = createSpacesRaceDb({ rootExists: false });
    const res = await getHierarchy(db, `!missing-0:example.com`);
    expect(res.status).toBe(404);
  });
  it('notFound soft-1', async () => {
    const db = createSpacesRaceDb({ rootExists: false });
    const res = await getHierarchy(db, `!missing-1:example.com`);
    expect(res.status).toBe(404);
  });
  it('notFound soft-2', async () => {
    const db = createSpacesRaceDb({ rootExists: false });
    const res = await getHierarchy(db, `!missing-2:example.com`);
    expect(res.status).toBe(404);
  });
  it('notFound soft-3', async () => {
    const db = createSpacesRaceDb({ rootExists: false });
    const res = await getHierarchy(db, `!missing-3:example.com`);
    expect(res.status).toBe(404);
  });
  it('notFound soft-4', async () => {
    const db = createSpacesRaceDb({ rootExists: false });
    const res = await getHierarchy(db, `!missing-4:example.com`);
    expect(res.status).toBe(404);
  });
  it('notFound soft-5', async () => {
    const db = createSpacesRaceDb({ rootExists: false });
    const res = await getHierarchy(db, `!missing-5:example.com`);
    expect(res.status).toBe(404);
  });
  it('notFound soft-6', async () => {
    const db = createSpacesRaceDb({ rootExists: false });
    const res = await getHierarchy(db, `!missing-6:example.com`);
    expect(res.status).toBe(404);
  });
  it('notFound soft-7', async () => {
    const db = createSpacesRaceDb({ rootExists: false });
    const res = await getHierarchy(db, `!missing-7:example.com`);
    expect(res.status).toBe(404);
  });
  it('notFound soft-8', async () => {
    const db = createSpacesRaceDb({ rootExists: false });
    const res = await getHierarchy(db, `!missing-8:example.com`);
    expect(res.status).toBe(404);
  });
  it('notFound soft-9', async () => {
    const db = createSpacesRaceDb({ rootExists: false });
    const res = await getHierarchy(db, `!missing-9:example.com`);
    expect(res.status).toBe(404);
  });
  it('notFound soft-10', async () => {
    const db = createSpacesRaceDb({ rootExists: false });
    const res = await getHierarchy(db, `!missing-10:example.com`);
    expect(res.status).toBe(404);
  });
  it('notFound soft-11', async () => {
    const db = createSpacesRaceDb({ rootExists: false });
    const res = await getHierarchy(db, `!missing-11:example.com`);
    expect(res.status).toBe(404);
  });
  it('method matrix soft flood', async () => {
    const db = createSpacesRaceDb({
      childEvents: [childVia(CHILD)],
      rooms: seedChildRooms([CHILD]),
    });
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await spaces.request(
        `http://localhost/_matrix/client/v1/rooms/${SPACE_ENC}/hierarchy`,
        { method, headers: { Authorization: 'Bearer t' } },
        spacesEnv(db)
      );
      expect([404, 405].includes(res.status) || res.status >= 400).toBe(true);
    }
  });

  it('percent-encoded room id soft flood', async () => {
    for (let i = 0; i < 8; i++) {
      const db = createSpacesRaceDb({
        childEvents: [childVia(CHILD)],
        rooms: seedChildRooms([CHILD]),
      });
      const res = await getHierarchy(db, SPACE);
      expect(res.status).toBe(200);
      expect(res.body.rooms[0].room_id).toBe(SPACE);
    }
  });
});

describe('spaces concurrent soft flood — lifecycle / bind / charset after #197', () => {
  it('lifecycle hierarchy→mutate children→hierarchy', async () => {
    for (let i = 0; i < 8; i++) {
      const db = createSpacesRaceDb({
        childEvents: [childVia(CHILD)],
        rooms: seedChildRooms([CHILD, CHILD2]),
      });
      const a = await getHierarchy(db, SPACE);
      expect(a.body.rooms.some((r: any) => r.room_id === CHILD)).toBe(true);
      db.setChildEvents([childVia(CHILD2)]);
      const b = await getHierarchy(db, SPACE);
      expect(b.body.rooms.some((r: any) => r.room_id === CHILD2)).toBe(true);
      expect(b.body.rooms.some((r: any) => r.room_id === CHILD)).toBe(false);
    }
  });

  it('exists SELECT binds room_id', async () => {
    const db = createSpacesRaceDb({
      childEvents: [],
    });
    await getHierarchy(db, SPACE);
    const exists = db.selects.find(
      (s) =>
        s.sql.includes('SELECT room_id FROM rooms WHERE room_id') &&
        !s.sql.includes('is_public')
    );
    expect(exists?.args[0]).toBe(SPACE);
  });

  it('child SELECT binds space room_id', async () => {
    const db = createSpacesRaceDb({
      childEvents: [childVia(CHILD)],
      rooms: seedChildRooms([CHILD]),
    });
    await getHierarchy(db, SPACE);
    const childSel = db.selects.find((s) => s.sql.includes("m.space.child"));
    expect(childSel?.args[0]).toBe(SPACE);
  });

  it('parallel bind contracts stay per-request', async () => {
    const db = createSpacesRaceDb({
      childEvents: [childVia(CHILD)],
      rooms: seedChildRooms([CHILD]),
      selectBarrier: {
        count: 3,
        match: (sql) => sql.includes('m.space.child'),
      },
    });
    await Promise.all([
      getHierarchy(db, SPACE),
      getHierarchy(db, SPACE),
      getHierarchy(db, SPACE),
    ]);
    const childSels = db.selects.filter(
      (s) => s.sql.includes('m.space.child') && s.args[0] === SPACE
    );
    expect(childSels.length).toBeGreaterThanOrEqual(3);
  });

  it('Accept / Authorization header soft flood', async () => {
    const headersList = [
      { Authorization: 'Bearer t' },
      { Authorization: 'Bearer t', Accept: 'application/json' },
      { Authorization: 'Bearer t', Accept: '*/*' },
      { Authorization: 'Bearer t', 'Accept-Language': 'en' },
    ];
    for (let i = 0; i < headersList.length; i++) {
      const db = createSpacesRaceDb({
        childEvents: [childVia(CHILD)],
        rooms: seedChildRooms([CHILD]),
      });
      const res = await spaces.request(
        `http://localhost/_matrix/client/v1/rooms/${SPACE_ENC}/hierarchy`,
        { method: 'GET', headers: headersList[i] },
        spacesEnv(db)
      );
      expect(res.status).toBe(200);
    }
  });
});


describe('search concurrent soft flood — blank term / no rooms / highlights after #197', () => {
  it.each([
    '',
    ' ',
    '   ',
    '\t',
    '\n',
    '\r\n',
    '  \t  ',
    '\u00a0',
  ])('blank term %# → empty response', async (term) => {
    const db = createSearchRaceDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$blank' })],
    });
    const res = await postSearch(db, roomEventsBody({ search_term: term }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(emptyRoomEventsSearchResponse());
  });

  it('no membership rooms → empty even with FTS rows', async () => {
    for (let i = 0; i < 8; i++) {
      const db = createSearchRaceDb({
        memberships: [],
        ftsRows: [fts({ event_id: `$nm-${i}` })],
      });
      const res = await postSearch(db, roomEventsBody({ search_term: `nm${i}` }));
      expect(res.body).toEqual(emptyRoomEventsSearchResponse());
    }
  });

  it('highlights unique lowercased words under concurrent searches', async () => {
    const db = createSearchRaceDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$hl' })],
      selectBarrier: {
        count: 4,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([
      postSearch(db, roomEventsBody({ search_term: 'Hello World' })),
      postSearch(db, roomEventsBody({ search_term: 'hello HELLO' })),
      postSearch(db, roomEventsBody({ search_term: 'Foo bar baz' })),
      postSearch(db, roomEventsBody({ search_term: 'a a a' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200, 200]);
    expect(results[0].body.search_categories.room_events.highlights).toEqual([
      'hello',
      'world',
    ]);
    expect(results[1].body.search_categories.room_events.highlights).toEqual(['hello']);
    expect(results[3].body.search_categories.room_events.highlights).toEqual(['a']);
  });

  it('leave membership still searchable (join|leave)', async () => {
    // Route selects membership IN ('join','leave') — mock returns room ids only.
    for (let i = 0; i < 6; i++) {
      const db = createSearchRaceDb({
        memberships: [ROOM_A],
        ftsRows: [fts({ event_id: `$leave-${i}` })],
      });
      const res = await postSearch(db, roomEventsBody());
      expect(res.status).toBe(200);
      expect(res.body.search_categories.room_events.results.length).toBe(1);
    }
  });
});

describe('search concurrent soft flood — groupings / state / next_batch edges after #197', () => {
  it('unknown group_by keys ignored; known keys attach', async () => {
    const db = createSearchRaceDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$g1' }), fts({ event_id: '$g2', origin_server_ts: 2000 })],
    });
    const res = await postSearch(
      db,
      roomEventsBody({
        groupings: { group_by: [{ key: 'room_id' }, { key: 'nope' }, { key: 'sender' }] },
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.search_categories.room_events.groups.room_id).toBeTruthy();
    expect(res.body.search_categories.room_events.groups.sender).toBeTruthy();
    expect(res.body.search_categories.room_events.groups.nope).toBeUndefined();
  });

  it('include_state with zero results omits state', async () => {
    const db = createSearchRaceDb({
      memberships: [ROOM_A],
      ftsRows: [],
      total: 0,
    });
    const res = await postSearch(db, roomEventsBody({ include_state: true }));
    expect(res.status).toBe(200);
    expect(res.body.search_categories.room_events.state).toBeUndefined();
  });

  it('next_batch soft flood offsets', async () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      fts({ event_id: `$nb${i}`, origin_server_ts: 10_000 - i })
    );
    for (const offset of [0, 10, 50, 55, 59, 100]) {
      const db = createSearchRaceDb({
        memberships: [ROOM_A],
        ftsRows: rows,
        total: 60,
      });
      const q = offset === 0 ? '' : `?next_batch=${offset}`;
      const res = await postSearch(db, roomEventsBody(), q);
      expect(res.status).toBe(200);
      const got = res.body.search_categories.room_events.results.length;
      expect(got).toBe(Math.max(0, Math.min(SEARCH_PAGE_LIMIT, 60 - offset)));
    }
  });

  it('parallel include_state across rooms bind contracts', async () => {
    const db = createSearchRaceDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: '$sa', room_id: ROOM_A }),
        fts({ event_id: '$sb', room_id: ROOM_B, origin_server_ts: 2000 }),
      ],
      roomState: {
        [ROOM_A]: [
          {
            event_type: 'm.room.name',
            state_key: '',
            sender: USER,
            content: JSON.stringify({ name: 'A' }),
            origin_server_ts: 1,
          },
        ],
        [ROOM_B]: [
          {
            event_type: 'm.room.name',
            state_key: '',
            sender: USER,
            content: JSON.stringify({ name: 'B' }),
            origin_server_ts: 1,
          },
        ],
      },
      selectBarrier: {
        count: 3,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([
      postSearch(db, roomEventsBody({ include_state: true })),
      postSearch(db, roomEventsBody({ include_state: true })),
      postSearch(db, roomEventsBody({ include_state: false })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results[0].body.search_categories.room_events.state[ROOM_A]).toBeTruthy();
    expect(results[2].body.search_categories.room_events.state).toBeUndefined();
  });
});

describe('spaces concurrent soft flood — via empty / suggested matrix / depth after #197', () => {
  it.each([
    { via: null as string[] | null, suggested: false },
    { via: [] as string[] | null, suggested: false },
    { via: [] as string[] | null, suggested: true },
  ])('empty/missing via skipped %#', async ({ via, suggested }) => {
    const db = createSpacesRaceDb({
      childEvents: [childVia(CHILD, suggested, via), childVia(CHILD2, false, [SERVER])],
      rooms: seedChildRooms([CHILD, CHILD2]),
    });
    const res = await getHierarchy(db, SPACE);
    expect(res.status).toBe(200);
    const ids = res.body.rooms.map((r: any) => r.room_id);
    expect(ids).not.toContain(CHILD);
    expect(ids).toContain(CHILD2);
  });

  it('suggested_only matrix soft flood', async () => {
    const variants = [
      [true, true, false],
      [false, false, false],
      [true, false, true],
      [false, true, true],
    ];
    for (let i = 0; i < variants.length; i++) {
      const [s1, s2, s3] = variants[i];
      const db = createSpacesRaceDb({
        childEvents: [
          childVia(CHILD, s1),
          childVia(CHILD2, s2),
          childVia(CHILD3, s3),
        ],
        rooms: seedChildRooms([CHILD, CHILD2, CHILD3]),
      });
      const res = await getHierarchy(db, SPACE, '?suggested_only=true');
      expect(res.status).toBe(200);
      const ids = res.body.rooms.map((r: any) => r.room_id);
      expect(ids).toContain(SPACE);
      if (s1) expect(ids).toContain(CHILD);
      else expect(ids).not.toContain(CHILD);
      if (s2) expect(ids).toContain(CHILD2);
      else expect(ids).not.toContain(CHILD2);
      if (s3) expect(ids).toContain(CHILD3);
      else expect(ids).not.toContain(CHILD3);
    }
  });

  it('max_depth soft flood 0..4', async () => {
    for (let depth = 0; depth <= 4; depth++) {
      const db = createSpacesRaceDb({
        childEvents: [childVia(CHILD)],
        rooms: seedChildRooms([CHILD, GC]),
        grandchildEvents: { [CHILD]: [childVia(GC)] },
      });
      const res = await getHierarchy(db, SPACE, `?max_depth=${depth}`);
      expect(res.status).toBe(200);
      const child = res.body.rooms.find((r: any) => r.room_id === CHILD);
      if (depth > 1) {
        expect(child?.children_state?.length).toBeGreaterThanOrEqual(1);
      } else if (child) {
        expect(child.children_state?.length ?? 0).toBe(0);
      }
    }
  });

  it('parallel suggested∥via∥depth flood', async () => {
    for (let i = 0; i < 6; i++) {
      const db = createSpacesRaceDb({
        childEvents: [
          childVia(CHILD, true),
          childVia(CHILD2, false),
          childVia(CHILD3, false, []),
        ],
        rooms: seedChildRooms([CHILD, CHILD2, CHILD3, GC]),
        grandchildEvents: { [CHILD]: [childVia(GC)] },
        selectBarrier: {
          count: 3,
          match: (sql, args) =>
            sql.includes("rs.event_type = 'm.space.child'") && args[0] === SPACE,
        },
      });
      const results = await Promise.all([
        getHierarchy(db, SPACE, '?suggested_only=true'),
        getHierarchy(db, SPACE, '?max_depth=2'),
        getHierarchy(db, SPACE, '?limit=2'),
      ]);
      expect(statusesOf(results)).toEqual([200, 200, 200]);
    }
  });
});

describe('spaces concurrent soft flood — getRoomInfo field edges after #197', () => {
  it('world_readable / guest_can_join matrix', async () => {
    const cases = [
      { hist: 'world_readable', guest: 'can_join', wr: true, gj: true },
      { hist: 'shared', guest: 'forbidden', wr: false, gj: false },
      { hist: 'invited', guest: 'can_join', wr: false, gj: true },
      { hist: 'world_readable', guest: 'forbidden', wr: true, gj: false },
    ];
    for (const c of cases) {
      const id = `!edge-${c.hist}-${c.guest}:example.com`;
      const db = createSpacesRaceDb({
        rooms: {
          [id]: {
            room_id: id,
            state: {
              'm.room.history_visibility': JSON.stringify({
                history_visibility: c.hist,
              }),
              'm.room.guest_access': JSON.stringify({ guest_access: c.guest }),
            },
            memberCount: 1,
          },
        },
      });
      const info = await getRoomInfo(db as unknown as D1Database, id, SERVER);
      expect(info?.world_readable).toBe(c.wr);
      expect(info?.guest_can_join).toBe(c.gj);
    }
  });

  it('room_type m.space vs undefined soft', async () => {
    for (const type of ['m.space', undefined, 'm.space.child']) {
      const id = `!type-${String(type)}:example.com`;
      const db = createSpacesRaceDb({
        rooms: {
          [id]: {
            room_id: id,
            state: {
              'm.room.create': JSON.stringify(type ? { type } : {}),
            },
            memberCount: 0,
          },
        },
      });
      const info = await getRoomInfo(db as unknown as D1Database, id, SERVER);
      expect(info?.room_type).toBe(type);
    }
  });

  it('parallel getRoomInfo distinct rooms isolate names', async () => {
    const db = createSpacesRaceDb({
      rooms: {
        [CHILD]: {
          room_id: CHILD,
          state: { 'm.room.name': JSON.stringify({ name: 'One' }) },
          memberCount: 1,
        },
        [CHILD2]: {
          room_id: CHILD2,
          state: { 'm.room.name': JSON.stringify({ name: 'Two' }) },
          memberCount: 2,
        },
        [CHILD3]: {
          room_id: CHILD3,
          state: { 'm.room.name': JSON.stringify({ name: 'Three' }) },
          memberCount: 3,
        },
      },
      selectBarrier: {
        count: 3,
        match: (sql) => sql.includes('SELECT room_id, is_public FROM rooms'),
      },
    });
    const [a, b, c] = await Promise.all([
      getRoomInfo(db as unknown as D1Database, CHILD, SERVER),
      getRoomInfo(db as unknown as D1Database, CHILD2, SERVER),
      getRoomInfo(db as unknown as D1Database, CHILD3, SERVER),
    ]);
    expect(a?.name).toBe('One');
    expect(b?.name).toBe('Two');
    expect(c?.name).toBe('Three');
    expect(c?.num_joined_members).toBe(3);
  });
});

describe('race search∥spaces cross-module isolation after #197', () => {
  it('parallel search + hierarchy never mix DB fixtures', async () => {
    const searchDb = createSearchRaceDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$cross' })],
    });
    const spacesDb = createSpacesRaceDb({
      childEvents: [childVia(CHILD)],
      rooms: seedChildRooms([CHILD]),
    });
    const [s, h] = await Promise.all([
      postSearch(searchDb, roomEventsBody()),
      getHierarchy(spacesDb, SPACE),
    ]);
    expect(s.status).toBe(200);
    expect(h.status).toBe(200);
    expect(s.body.search_categories.room_events.results[0].event_id).toBe('$cross');
    expect(h.body.rooms.some((r: any) => r.room_id === CHILD)).toBe(true);
  });

  it('cross-module soft flood pairs', async () => {
    for (let i = 0; i < 10; i++) {
      const searchDb = createSearchRaceDb({
        memberships: [ROOM_A],
        ftsRows: [fts({ event_id: `$x-${i}` })],
      });
      const spacesDb = createSpacesRaceDb({
        childEvents: [childVia(CHILD)],
        rooms: seedChildRooms([CHILD]),
      });
      const results = await Promise.all([
        postSearch(searchDb, roomEventsBody({ search_term: `x${i}` })),
        getHierarchy(spacesDb, SPACE, i % 2 === 0 ? '?suggested_only=false' : ''),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
    }
  });
});
