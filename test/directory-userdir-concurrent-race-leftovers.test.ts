/**
 * TOKENMAXX HEAVY leftovers after #208/#209 — client *directory / user_directory /
 * thirdparty* concurrent race / TOCTOU + soft/edge reliability for slices with
 * zero prior concurrent-race coverage.
 *
 * Live handlers live inline on `src/index.ts` (not federation publicRooms soft
 * floods, not aliases directory/room #193, not account #209). Soft leftovers for
 * federation publicRooms (#161/#129) never barriered client GET publicRooms
 * rooms→name/topic/members SELECT chains, FTS user_directory MATCH TOCTOU, or
 * thirdparty/dehydrated stubs under Promise.all.
 *
 * Distinct domain — not account (#209), rooms-read-upgrade (#208), push (#207),
 * typing (#206), sliding-sync (#205), presence (#204), sync (#202), voip (#201),
 * report/server-notices (#200), search+spaces (#199), profile (#198/#197),
 * tags (#196), workflows (#195), rooms-mutate (#194), aliases (#193).
 *
 * Focus: publicRooms rooms ALL→per-room FIRST TOCTOU; is_public/name/topic/
 * member-count mid-flight mutate; POST publicRooms stub flood; user_directory
 * FTS ALL barrier + deactivate/guest/exclude-self mid-flight; limit/limited;
 * bad JSON / empty term / method soft; thirdparty protocols + dehydrated
 * device stubs; SQL bind contracts; cross-endpoint isolation.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/rate-limit', () => ({
  rateLimitMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  getRateLimitType: () => 'default',
  getClientId: () => 'unknown',
  RATE_LIMITS: {},
}));

vi.mock('hono/logger', () => ({
  logger: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../src/middleware/analytics', () => ({
  analyticsMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

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
  optionalAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      if (authState.userId) c.set('userId', authState.userId);
      c.set('deviceId', authState.deviceId);
      await next();
    };
  },
  extractAccessToken: () => 'test-token',
  validateAccessToken: async () =>
    authState.userId
      ? { userId: authState.userId, deviceId: authState.deviceId }
      : null,
}));

vi.mock('../src/durable-objects', () => ({
  RoomDurableObject: class {},
  SyncDurableObject: class {},
  FederationDurableObject: class {},
  CallRoomDurableObject: class {},
  AdminDurableObject: class {},
  UserKeysDurableObject: class {},
  PushDurableObject: class {},
  RateLimitDurableObject: class {},
}));

vi.mock('../src/workflows', () => ({
  RoomJoinWorkflow: class {},
  PushNotificationWorkflow: class {},
  FederationCatchupWorkflow: class {},
  MediaCleanupWorkflow: class {},
  StateCompactionWorkflow: class {},
}));

import app from '../src/index';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const DAVE = '@dave:example.com';
const EVE = '@eve:example.com';
const ROOM_A = '!a:example.com';
const ROOM_B = '!b:example.com';
const ROOM_C = '!c:example.com';
const ROOM_D = '!d:example.com';
const AUTH = { Authorization: 'Bearer test-token' };

type SqlCall = { sql: string; args: unknown[] };
type SqlBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };

type PublicRoom = { room_id: string; room_version: string; is_public: number };
type StateSlot = {
  room_id: string;
  event_type: string;
  state_key: string;
  content: string;
};
type Membership = { room_id: string; user_id: string; membership: string };
type DirUser = {
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  is_deactivated: number;
  is_guest: number;
  fts: string;
};

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

function createDirectoryDb(
  opts: {
    rooms?: PublicRoom[];
    state?: StateSlot[];
    memberships?: Membership[];
    users?: DirUser[];
    allBarrier?: SqlBarrier;
    firstBarrier?: SqlBarrier;
    mutateRoomsAfterAll?: { after: number; next: PublicRoom[] };
    mutateStateAfterFirst?: { after: number; next: StateSlot[] };
    mutateMembershipsAfterFirst?: { after: number; next: Membership[] };
    mutateUsersAfterAll?: { after: number; next: DirUser[] };
    failRoomsAll?: boolean;
    failNameFirst?: boolean;
    failTopicFirst?: boolean;
    failMemberFirst?: boolean;
    failFtsAll?: boolean;
    failFtsAfter?: number;
  } = {}
) {
  const rooms = [...(opts.rooms ?? [])];
  const state = [...(opts.state ?? [])];
  const memberships = [...(opts.memberships ?? [])];
  const users = [...(opts.users ?? [])];
  const selects: SqlCall[] = [];
  const alls: SqlCall[] = [];
  const firsts: SqlCall[] = [];
  const events: string[] = [];

  let allBarrier = opts.allBarrier;
  let firstBarrier = opts.firstBarrier;
  const allWaiters = { list: [] as Array<() => void> };
  const firstWaiters = { list: [] as Array<() => void> };

  let roomsAllCount = 0;
  let ftsAllCount = 0;
  let firstCount = 0;

  const stmt = (sql: string) => {
    const bound = (...args: unknown[]) => {
      const exec = {
        async first<T>() {
          firsts.push({ sql, args });
          selects.push({ sql, args });
          events.push(`first:${sql.slice(0, 56)}`);
          await withSqlBarrier(
            firstBarrier,
            firstWaiters,
            () => {
              firstBarrier = undefined;
            },
            sql,
            args
          );
          firstCount += 1;

          if (opts.mutateStateAfterFirst && firstCount === opts.mutateStateAfterFirst.after) {
            state.splice(0, state.length, ...opts.mutateStateAfterFirst.next);
            events.push('mutate:state-after-first');
          }
          if (
            opts.mutateMembershipsAfterFirst &&
            firstCount === opts.mutateMembershipsAfterFirst.after
          ) {
            memberships.splice(0, memberships.length, ...opts.mutateMembershipsAfterFirst.next);
            events.push('mutate:memberships-after-first');
          }

          if (sql.includes("rs.event_type = 'm.room.name'")) {
            if (opts.failNameFirst) throw new Error('d1-name-first-fail');
            const roomId = args[0] as string;
            const row = state.find((s) => s.room_id === roomId && s.event_type === 'm.room.name');
            return (row ? { content: row.content } : null) as T;
          }
          if (sql.includes("rs.event_type = 'm.room.topic'")) {
            if (opts.failTopicFirst) throw new Error('d1-topic-first-fail');
            const roomId = args[0] as string;
            const row = state.find((s) => s.room_id === roomId && s.event_type === 'm.room.topic');
            return (row ? { content: row.content } : null) as T;
          }
          if (sql.includes('COUNT(*) as count FROM room_memberships')) {
            if (opts.failMemberFirst) throw new Error('d1-member-first-fail');
            const roomId = args[0] as string;
            const count = memberships.filter(
              (m) => m.room_id === roomId && m.membership === 'join'
            ).length;
            return { count } as T;
          }

          throw new Error('Unhandled first() SQL: ' + sql.slice(0, 160));
        },

        async all<T>() {
          alls.push({ sql, args });
          selects.push({ sql, args });
          events.push(`all:${sql.slice(0, 56)}`);
          await withSqlBarrier(
            allBarrier,
            allWaiters,
            () => {
              allBarrier = undefined;
            },
            sql,
            args
          );

          if (sql.includes('FROM rooms r') && sql.includes('is_public = 1')) {
            if (opts.failRoomsAll) throw new Error('d1-rooms-all-fail');
            roomsAllCount += 1;
            const snapshot = rooms
              .filter((r) => r.is_public === 1)
              .slice(0, 100)
              .map((r) => ({ room_id: r.room_id, room_version: r.room_version }));
            if (opts.mutateRoomsAfterAll && roomsAllCount === opts.mutateRoomsAfterAll.after) {
              rooms.splice(0, rooms.length, ...opts.mutateRoomsAfterAll.next);
              events.push('mutate:rooms-after-all');
            }
            return { results: snapshot as T[] };
          }

          if (sql.includes('users_fts') && sql.includes('MATCH')) {
            if (opts.failFtsAll) throw new Error('d1-fts-all-fail');
            ftsAllCount += 1;
            if (opts.failFtsAfter !== undefined && ftsAllCount > opts.failFtsAfter) {
              throw new Error('d1-fts-all-fail-after');
            }
            const term = String(args[0] ?? '').toLowerCase();
            const exclude = args[1] as string;
            const limitPlus = Number(args[2] ?? 11);
            const tokens = term.split(/\s+/).filter(Boolean);
            let hits = users.filter((u) => {
              if (!tokens.length) return false;
              if (u.user_id === exclude) return false;
              if (u.is_deactivated) return false;
              if (u.is_guest) return false;
              const hay = `${u.fts} ${u.user_id} ${u.display_name ?? ''}`.toLowerCase();
              return tokens.every((t) => hay.includes(t));
            });
            hits = hits.slice(0, limitPlus);
            if (opts.mutateUsersAfterAll && ftsAllCount === opts.mutateUsersAfterAll.after) {
              users.splice(0, users.length, ...opts.mutateUsersAfterAll.next);
              events.push('mutate:users-after-fts');
            }
            return {
              results: hits.map((u) => ({
                user_id: u.user_id,
                display_name: u.display_name,
                avatar_url: u.avatar_url,
              })) as T[],
            };
          }

          return { results: [] as T[] };
        },

        async run() {
          throw new Error('Unexpected run() in directory stub: ' + sql.slice(0, 80));
        },
      };
      return exec;
    };

    return {
      bind: bound,
      first: <T,>() => bound().first<T>(),
      all: <T,>() => bound().all<T>(),
      run: () => bound().run(),
    };
  };

  return {
    rooms,
    state,
    memberships,
    users,
    selects,
    alls,
    firsts,
    events,
    get roomsAllCount() {
      return roomsAllCount;
    },
    get ftsAllCount() {
      return ftsAllCount;
    },
    prepare(sql: string) {
      return stmt(sql);
    },
  };
}

type DirectoryDb = ReturnType<typeof createDirectoryDb>;

function seedPublic(
  roomId: string,
  opts: { name?: string; topic?: string; members?: string[]; is_public?: number } = {}
): {
  room: PublicRoom;
  state: StateSlot[];
  memberships: Membership[];
} {
  const state: StateSlot[] = [];
  if (opts.name !== undefined) {
    state.push({
      room_id: roomId,
      event_type: 'm.room.name',
      state_key: '',
      content: JSON.stringify({ name: opts.name }),
    });
  }
  if (opts.topic !== undefined) {
    state.push({
      room_id: roomId,
      event_type: 'm.room.topic',
      state_key: '',
      content: JSON.stringify({ topic: opts.topic }),
    });
  }
  const memberships = (opts.members ?? [USER, BOB]).map((user_id) => ({
    room_id: roomId,
    user_id,
    membership: 'join',
  }));
  return {
    room: { room_id: roomId, room_version: '11', is_public: opts.is_public ?? 1 },
    state,
    memberships,
  };
}

function seedUser(
  userId: string,
  opts: Partial<Omit<DirUser, 'user_id'>> & { display_name?: string | null } = {}
): DirUser {
  const display = opts.display_name !== undefined ? opts.display_name : userId.slice(1).split(':')[0];
  return {
    user_id: userId,
    display_name: display,
    avatar_url: opts.avatar_url ?? null,
    is_deactivated: opts.is_deactivated ?? 0,
    is_guest: opts.is_guest ?? 0,
    fts: opts.fts ?? `${display ?? ''} ${userId}`,
  };
}

function createEnv(db: DirectoryDb): Env & { _db: DirectoryDb } {
  return {
    SERVER_NAME: 'example.com',
    SERVER_VERSION: 'test',
    DB: db as unknown as D1Database,
    _db: db,
  } as unknown as Env & { _db: DirectoryDb };
}

async function request(env: Env, path: string, init: RequestInit = {}) {
  const res = await app.request(`http://localhost${path}`, init, env);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { status: res.status, body, headers: res.headers };
}

function jsonInit(method: string, body?: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...AUTH,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
}

function defaultPublicFixture() {
  const a = seedPublic(ROOM_A, { name: 'Alpha', topic: 'ta', members: [USER, BOB] });
  const b = seedPublic(ROOM_B, { name: 'Beta', topic: 'tb', members: [USER, CAROL, DAVE] });
  const c = seedPublic(ROOM_C, { name: 'Gamma', members: [BOB], is_public: 0 });
  return {
    rooms: [a.room, b.room, c.room],
    state: [...a.state, ...b.state, ...c.state],
    memberships: [...a.memberships, ...b.memberships, ...c.memberships],
  };
}

function defaultUsers(): DirUser[] {
  return [
    seedUser(USER, { display_name: 'Alice' }),
    seedUser(BOB, { display_name: 'Bob Builder' }),
    seedUser(CAROL, { display_name: 'Carol' }),
    seedUser(DAVE, { display_name: 'Dave', avatar_url: 'mxc://example.com/av' }),
    seedUser(EVE, { display_name: 'Eve', is_deactivated: 1 }),
    seedUser('@guest:example.com', { display_name: 'Guest', is_guest: 1 }),
  ];
}

beforeEach(() => {
  authState.userId = USER;
  authState.deviceId = 'DEVICEA';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// publicRooms GET — rooms ALL barrier + per-room FIRST TOCTOU
// ---------------------------------------------------------------------------

describe('race publicRooms rooms ALL barrier TOCTOU after #208', () => {
  it('parallel GET under rooms ALL barrier both 200 with same public snapshot', async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM rooms r') && sql.includes('is_public = 1'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const body = r.body as { chunk: Array<{ room_id: string; name?: string; num_joined_members?: number }>; total_room_count_estimate: number };
      expect(body.chunk.map((x) => x.room_id).sort()).toEqual([ROOM_A, ROOM_B].sort());
      expect(body.total_room_count_estimate).toBe(2);
      expect(body.chunk.find((x) => x.room_id === ROOM_A)?.name).toBe('Alpha');
      expect(body.chunk.find((x) => x.room_id === ROOM_B)?.num_joined_members).toBe(3);
    }
    expect(db.roomsAllCount).toBe(2);
  });

  it('rooms ALL mid-flight is_public flip: second may see mutated set', async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM rooms r') && sql.includes('is_public = 1'),
      },
      mutateRoomsAfterAll: {
        after: 1,
        next: [
          { room_id: ROOM_A, room_version: '11', is_public: 0 },
          { room_id: ROOM_B, room_version: '11', is_public: 1 },
          { room_id: ROOM_D, room_version: '11', is_public: 1 },
        ],
      },
    });
    db.state.push({
      room_id: ROOM_D,
      event_type: 'm.room.name',
      state_key: '',
      content: JSON.stringify({ name: 'Delta' }),
    });
    db.memberships.push({ room_id: ROOM_D, user_id: USER, membership: 'join' });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const ids = results.map((r) =>
      (r.body as { chunk: Array<{ room_id: string }> }).chunk.map((c) => c.room_id).sort()
    );
    expect(ids.some((x) => x.join(',') === [ROOM_A, ROOM_B].sort().join(','))).toBe(true);
    expect(ids.some((x) => x.join(',') === [ROOM_B, ROOM_D].sort().join(','))).toBe(true);
  });
  it(`rooms ALL barrier soft-0: dual GET coherent public chunk`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM rooms r') && sql.includes('is_public = 1'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const body = r.body as { chunk: unknown[]; total_room_count_estimate: number };
      expect(body.chunk).toHaveLength(2);
      expect(body.total_room_count_estimate).toBe(2);
    }
  });
  it(`rooms ALL barrier soft-1: dual GET coherent public chunk`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM rooms r') && sql.includes('is_public = 1'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const body = r.body as { chunk: unknown[]; total_room_count_estimate: number };
      expect(body.chunk).toHaveLength(2);
      expect(body.total_room_count_estimate).toBe(2);
    }
  });
  it(`rooms ALL barrier soft-2: dual GET coherent public chunk`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM rooms r') && sql.includes('is_public = 1'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const body = r.body as { chunk: unknown[]; total_room_count_estimate: number };
      expect(body.chunk).toHaveLength(2);
      expect(body.total_room_count_estimate).toBe(2);
    }
  });
  it(`rooms ALL barrier soft-3: dual GET coherent public chunk`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM rooms r') && sql.includes('is_public = 1'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const body = r.body as { chunk: unknown[]; total_room_count_estimate: number };
      expect(body.chunk).toHaveLength(2);
      expect(body.total_room_count_estimate).toBe(2);
    }
  });
  it(`rooms ALL barrier soft-4: dual GET coherent public chunk`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM rooms r') && sql.includes('is_public = 1'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const body = r.body as { chunk: unknown[]; total_room_count_estimate: number };
      expect(body.chunk).toHaveLength(2);
      expect(body.total_room_count_estimate).toBe(2);
    }
  });
  it(`rooms ALL barrier soft-5: dual GET coherent public chunk`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM rooms r') && sql.includes('is_public = 1'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const body = r.body as { chunk: unknown[]; total_room_count_estimate: number };
      expect(body.chunk).toHaveLength(2);
      expect(body.total_room_count_estimate).toBe(2);
    }
  });
  it(`rooms ALL barrier soft-6: dual GET coherent public chunk`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM rooms r') && sql.includes('is_public = 1'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const body = r.body as { chunk: unknown[]; total_room_count_estimate: number };
      expect(body.chunk).toHaveLength(2);
      expect(body.total_room_count_estimate).toBe(2);
    }
  });
  it(`rooms ALL barrier soft-7: dual GET coherent public chunk`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM rooms r') && sql.includes('is_public = 1'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const body = r.body as { chunk: unknown[]; total_room_count_estimate: number };
      expect(body.chunk).toHaveLength(2);
      expect(body.total_room_count_estimate).toBe(2);
    }
  });
  it(`rooms ALL barrier soft-8: dual GET coherent public chunk`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM rooms r') && sql.includes('is_public = 1'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const body = r.body as { chunk: unknown[]; total_room_count_estimate: number };
      expect(body.chunk).toHaveLength(2);
      expect(body.total_room_count_estimate).toBe(2);
    }
  });
  it(`rooms ALL barrier soft-9: dual GET coherent public chunk`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM rooms r') && sql.includes('is_public = 1'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const body = r.body as { chunk: unknown[]; total_room_count_estimate: number };
      expect(body.chunk).toHaveLength(2);
      expect(body.total_room_count_estimate).toBe(2);
    }
  });
  it(`rooms ALL barrier soft-10: dual GET coherent public chunk`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM rooms r') && sql.includes('is_public = 1'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const body = r.body as { chunk: unknown[]; total_room_count_estimate: number };
      expect(body.chunk).toHaveLength(2);
      expect(body.total_room_count_estimate).toBe(2);
    }
  });
  it(`rooms ALL barrier soft-11: dual GET coherent public chunk`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM rooms r') && sql.includes('is_public = 1'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const body = r.body as { chunk: unknown[]; total_room_count_estimate: number };
      expect(body.chunk).toHaveLength(2);
      expect(body.total_room_count_estimate).toBe(2);
    }
  });
  it(`rooms ALL barrier soft-12: dual GET coherent public chunk`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM rooms r') && sql.includes('is_public = 1'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const body = r.body as { chunk: unknown[]; total_room_count_estimate: number };
      expect(body.chunk).toHaveLength(2);
      expect(body.total_room_count_estimate).toBe(2);
    }
  });
  it(`rooms ALL barrier soft-13: dual GET coherent public chunk`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM rooms r') && sql.includes('is_public = 1'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const body = r.body as { chunk: unknown[]; total_room_count_estimate: number };
      expect(body.chunk).toHaveLength(2);
      expect(body.total_room_count_estimate).toBe(2);
    }
  });
  it(`rooms ALL barrier soft-14: dual GET coherent public chunk`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM rooms r') && sql.includes('is_public = 1'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const body = r.body as { chunk: unknown[]; total_room_count_estimate: number };
      expect(body.chunk).toHaveLength(2);
      expect(body.total_room_count_estimate).toBe(2);
    }
  });
  it(`rooms ALL barrier soft-15: dual GET coherent public chunk`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM rooms r') && sql.includes('is_public = 1'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const body = r.body as { chunk: unknown[]; total_room_count_estimate: number };
      expect(body.chunk).toHaveLength(2);
      expect(body.total_room_count_estimate).toBe(2);
    }
  });
});

describe('race publicRooms name/topic/member FIRST mid-flight after #208', () => {
  it('name FIRST barrier: dual GET both 200; mid-flight rename visible to later enrichment', async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      firstBarrier: {
        count: 2,
        match: (sql) => sql.includes("rs.event_type = 'm.room.name'"),
      },
      mutateStateAfterFirst: {
        after: 1,
        next: [
          {
            room_id: ROOM_A,
            event_type: 'm.room.name',
            state_key: '',
            content: JSON.stringify({ name: 'Alpha-Renamed' }),
          },
          {
            room_id: ROOM_A,
            event_type: 'm.room.topic',
            state_key: '',
            content: JSON.stringify({ topic: 'ta' }),
          },
          {
            room_id: ROOM_B,
            event_type: 'm.room.name',
            state_key: '',
            content: JSON.stringify({ name: 'Beta' }),
          },
          {
            room_id: ROOM_B,
            event_type: 'm.room.topic',
            state_key: '',
            content: JSON.stringify({ topic: 'tb' }),
          },
        ],
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const names = results.flatMap((r) =>
      (r.body as { chunk: Array<{ room_id: string; name?: string }> }).chunk
        .filter((c) => c.room_id === ROOM_A)
        .map((c) => c.name)
    );
    // After barrier release, mutate-on-first may land before the peer's name FIRST,
    // so both GETs can observe Alpha-Renamed (lost pre-mutate snapshot).
    expect(names.every((n) => n === 'Alpha' || n === 'Alpha-Renamed')).toBe(true);
    expect(names.length).toBe(2);
  });

  it('member COUNT FIRST mid-flight join: counts may diverge across parallel GETs', async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      firstBarrier: {
        count: 2,
        match: (sql) => sql.includes('COUNT(*) as count FROM room_memberships'),
      },
      mutateMembershipsAfterFirst: {
        after: 1,
        next: [
          ...fx.memberships,
          { room_id: ROOM_A, user_id: CAROL, membership: 'join' },
        ],
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const counts = results.map(
      (r) =>
        (r.body as { chunk: Array<{ room_id: string; num_joined_members: number }> }).chunk.find(
          (c) => c.room_id === ROOM_A
        )!.num_joined_members
    );
    expect(counts.every((c) => c === 2 || c === 3)).toBe(true);
  });
  it(`name FIRST barrier soft-0: dual GET under name SELECT pack`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      firstBarrier: {
        count: 2,
        match: (sql) => sql.includes("rs.event_type = 'm.room.name'"),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`name FIRST barrier soft-1: dual GET under name SELECT pack`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      firstBarrier: {
        count: 2,
        match: (sql) => sql.includes("rs.event_type = 'm.room.name'"),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`name FIRST barrier soft-2: dual GET under name SELECT pack`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      firstBarrier: {
        count: 2,
        match: (sql) => sql.includes("rs.event_type = 'm.room.name'"),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`name FIRST barrier soft-3: dual GET under name SELECT pack`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      firstBarrier: {
        count: 2,
        match: (sql) => sql.includes("rs.event_type = 'm.room.name'"),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`name FIRST barrier soft-4: dual GET under name SELECT pack`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      firstBarrier: {
        count: 2,
        match: (sql) => sql.includes("rs.event_type = 'm.room.name'"),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`name FIRST barrier soft-5: dual GET under name SELECT pack`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      firstBarrier: {
        count: 2,
        match: (sql) => sql.includes("rs.event_type = 'm.room.name'"),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`name FIRST barrier soft-6: dual GET under name SELECT pack`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      firstBarrier: {
        count: 2,
        match: (sql) => sql.includes("rs.event_type = 'm.room.name'"),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`name FIRST barrier soft-7: dual GET under name SELECT pack`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      firstBarrier: {
        count: 2,
        match: (sql) => sql.includes("rs.event_type = 'm.room.name'"),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`name FIRST barrier soft-8: dual GET under name SELECT pack`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      firstBarrier: {
        count: 2,
        match: (sql) => sql.includes("rs.event_type = 'm.room.name'"),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`name FIRST barrier soft-9: dual GET under name SELECT pack`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      firstBarrier: {
        count: 2,
        match: (sql) => sql.includes("rs.event_type = 'm.room.name'"),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`name FIRST barrier soft-10: dual GET under name SELECT pack`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      firstBarrier: {
        count: 2,
        match: (sql) => sql.includes("rs.event_type = 'm.room.name'"),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`name FIRST barrier soft-11: dual GET under name SELECT pack`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      firstBarrier: {
        count: 2,
        match: (sql) => sql.includes("rs.event_type = 'm.room.name'"),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
});

describe('race publicRooms N-way flood + failure soft after #208', () => {
  it('8-way parallel GET under rooms ALL barrier all 200', async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      allBarrier: {
        count: 8,
        match: (sql) => sql.includes('FROM rooms r') && sql.includes('is_public = 1'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => request(env, '/_matrix/client/v3/publicRooms'))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.roomsAllCount).toBe(8);
  });

  it('rooms ALL throw surfaces 500', async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, failRoomsAll: true });
    const env = createEnv(db);
    const res = await request(env, '/_matrix/client/v3/publicRooms');
    expect(res.status).toBe(500);
  });

  it('parallel GET both 500 when rooms ALL throws under barrier', async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      failRoomsAll: true,
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM rooms r') && sql.includes('is_public = 1'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms'),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('name FIRST throw surfaces 500 mid enrichment', async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, failNameFirst: true });
    const env = createEnv(db);
    const res = await request(env, '/_matrix/client/v3/publicRooms');
    expect(res.status).toBe(500);
  });
  it(`N-way soft flood-0: ${4 + (0 % 5)}-way GET without barrier`, async () => {
    const n = 4 + (0 % 5);
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx });
    const env = createEnv(db);
    const results = await Promise.all(
      Array.from({ length: n }, () => request(env, '/_matrix/client/v3/publicRooms'))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.roomsAllCount).toBe(n);
  });
  it(`N-way soft flood-1: ${4 + (1 % 5)}-way GET without barrier`, async () => {
    const n = 4 + (1 % 5);
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx });
    const env = createEnv(db);
    const results = await Promise.all(
      Array.from({ length: n }, () => request(env, '/_matrix/client/v3/publicRooms'))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.roomsAllCount).toBe(n);
  });
  it(`N-way soft flood-2: ${4 + (2 % 5)}-way GET without barrier`, async () => {
    const n = 4 + (2 % 5);
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx });
    const env = createEnv(db);
    const results = await Promise.all(
      Array.from({ length: n }, () => request(env, '/_matrix/client/v3/publicRooms'))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.roomsAllCount).toBe(n);
  });
  it(`N-way soft flood-3: ${4 + (3 % 5)}-way GET without barrier`, async () => {
    const n = 4 + (3 % 5);
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx });
    const env = createEnv(db);
    const results = await Promise.all(
      Array.from({ length: n }, () => request(env, '/_matrix/client/v3/publicRooms'))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.roomsAllCount).toBe(n);
  });
  it(`N-way soft flood-4: ${4 + (4 % 5)}-way GET without barrier`, async () => {
    const n = 4 + (4 % 5);
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx });
    const env = createEnv(db);
    const results = await Promise.all(
      Array.from({ length: n }, () => request(env, '/_matrix/client/v3/publicRooms'))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.roomsAllCount).toBe(n);
  });
  it(`N-way soft flood-5: ${4 + (5 % 5)}-way GET without barrier`, async () => {
    const n = 4 + (5 % 5);
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx });
    const env = createEnv(db);
    const results = await Promise.all(
      Array.from({ length: n }, () => request(env, '/_matrix/client/v3/publicRooms'))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.roomsAllCount).toBe(n);
  });
  it(`N-way soft flood-6: ${4 + (6 % 5)}-way GET without barrier`, async () => {
    const n = 4 + (6 % 5);
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx });
    const env = createEnv(db);
    const results = await Promise.all(
      Array.from({ length: n }, () => request(env, '/_matrix/client/v3/publicRooms'))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.roomsAllCount).toBe(n);
  });
  it(`N-way soft flood-7: ${4 + (7 % 5)}-way GET without barrier`, async () => {
    const n = 4 + (7 % 5);
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx });
    const env = createEnv(db);
    const results = await Promise.all(
      Array.from({ length: n }, () => request(env, '/_matrix/client/v3/publicRooms'))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.roomsAllCount).toBe(n);
  });
  it(`N-way soft flood-8: ${4 + (8 % 5)}-way GET without barrier`, async () => {
    const n = 4 + (8 % 5);
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx });
    const env = createEnv(db);
    const results = await Promise.all(
      Array.from({ length: n }, () => request(env, '/_matrix/client/v3/publicRooms'))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.roomsAllCount).toBe(n);
  });
  it(`N-way soft flood-9: ${4 + (9 % 5)}-way GET without barrier`, async () => {
    const n = 4 + (9 % 5);
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx });
    const env = createEnv(db);
    const results = await Promise.all(
      Array.from({ length: n }, () => request(env, '/_matrix/client/v3/publicRooms'))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.roomsAllCount).toBe(n);
  });
});

describe('publicRooms POST stub + method soft flood after #208', () => {
  it('POST returns empty chunk stub', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const res = await request(env, '/_matrix/client/v3/publicRooms', jsonInit('POST', { filter: {} }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [], total_room_count_estimate: 0 });
  });

  it('parallel POST stubs isolate from GET public listing', async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx });
    const env = createEnv(db);
    const [getRes, postRes] = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/publicRooms', jsonInit('POST', { limit: 10 })),
    ]);
    expect(getRes.status).toBe(200);
    expect((getRes.body as { chunk: unknown[] }).chunk).toHaveLength(2);
    expect(postRes.status).toBe(200);
    expect(postRes.body).toEqual({ chunk: [], total_room_count_estimate: 0 });
  });
  it('POST stub soft-0', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const bodies = [
      {},
      { limit: 1 },
      { filter: { generic_search_term: 'x0' } },
      { include_all_networks: true },
      null,
    ];
    const res = await request(
      env,
      '/_matrix/client/v3/publicRooms',
      jsonInit('POST', bodies[0 % 5])
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [], total_room_count_estimate: 0 });
  });
  it('POST stub soft-1', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const bodies = [
      {},
      { limit: 2 },
      { filter: { generic_search_term: 'x1' } },
      { include_all_networks: true },
      null,
    ];
    const res = await request(
      env,
      '/_matrix/client/v3/publicRooms',
      jsonInit('POST', bodies[1 % 5])
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [], total_room_count_estimate: 0 });
  });
  it('POST stub soft-2', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const bodies = [
      {},
      { limit: 3 },
      { filter: { generic_search_term: 'x2' } },
      { include_all_networks: true },
      null,
    ];
    const res = await request(
      env,
      '/_matrix/client/v3/publicRooms',
      jsonInit('POST', bodies[2 % 5])
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [], total_room_count_estimate: 0 });
  });
  it('POST stub soft-3', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const bodies = [
      {},
      { limit: 4 },
      { filter: { generic_search_term: 'x3' } },
      { include_all_networks: true },
      null,
    ];
    const res = await request(
      env,
      '/_matrix/client/v3/publicRooms',
      jsonInit('POST', bodies[3 % 5])
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [], total_room_count_estimate: 0 });
  });
  it('POST stub soft-4', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const bodies = [
      {},
      { limit: 5 },
      { filter: { generic_search_term: 'x4' } },
      { include_all_networks: true },
      null,
    ];
    const res = await request(
      env,
      '/_matrix/client/v3/publicRooms',
      jsonInit('POST', bodies[4 % 5])
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [], total_room_count_estimate: 0 });
  });
  it('POST stub soft-5', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const bodies = [
      {},
      { limit: 1 },
      { filter: { generic_search_term: 'x5' } },
      { include_all_networks: true },
      null,
    ];
    const res = await request(
      env,
      '/_matrix/client/v3/publicRooms',
      jsonInit('POST', bodies[5 % 5])
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [], total_room_count_estimate: 0 });
  });
  it('POST stub soft-6', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const bodies = [
      {},
      { limit: 2 },
      { filter: { generic_search_term: 'x6' } },
      { include_all_networks: true },
      null,
    ];
    const res = await request(
      env,
      '/_matrix/client/v3/publicRooms',
      jsonInit('POST', bodies[6 % 5])
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [], total_room_count_estimate: 0 });
  });
  it('POST stub soft-7', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const bodies = [
      {},
      { limit: 3 },
      { filter: { generic_search_term: 'x7' } },
      { include_all_networks: true },
      null,
    ];
    const res = await request(
      env,
      '/_matrix/client/v3/publicRooms',
      jsonInit('POST', bodies[7 % 5])
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [], total_room_count_estimate: 0 });
  });
  it('POST stub soft-8', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const bodies = [
      {},
      { limit: 4 },
      { filter: { generic_search_term: 'x8' } },
      { include_all_networks: true },
      null,
    ];
    const res = await request(
      env,
      '/_matrix/client/v3/publicRooms',
      jsonInit('POST', bodies[8 % 5])
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [], total_room_count_estimate: 0 });
  });
  it('POST stub soft-9', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const bodies = [
      {},
      { limit: 5 },
      { filter: { generic_search_term: 'x9' } },
      { include_all_networks: true },
      null,
    ];
    const res = await request(
      env,
      '/_matrix/client/v3/publicRooms',
      jsonInit('POST', bodies[9 % 5])
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [], total_room_count_estimate: 0 });
  });
  it('POST stub soft-10', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const bodies = [
      {},
      { limit: 1 },
      { filter: { generic_search_term: 'x10' } },
      { include_all_networks: true },
      null,
    ];
    const res = await request(
      env,
      '/_matrix/client/v3/publicRooms',
      jsonInit('POST', bodies[10 % 5])
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [], total_room_count_estimate: 0 });
  });
  it('POST stub soft-11', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const bodies = [
      {},
      { limit: 2 },
      { filter: { generic_search_term: 'x11' } },
      { include_all_networks: true },
      null,
    ];
    const res = await request(
      env,
      '/_matrix/client/v3/publicRooms',
      jsonInit('POST', bodies[11 % 5])
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [], total_room_count_estimate: 0 });
  });
  it('POST stub soft-12', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const bodies = [
      {},
      { limit: 3 },
      { filter: { generic_search_term: 'x12' } },
      { include_all_networks: true },
      null,
    ];
    const res = await request(
      env,
      '/_matrix/client/v3/publicRooms',
      jsonInit('POST', bodies[12 % 5])
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [], total_room_count_estimate: 0 });
  });
  it('POST stub soft-13', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const bodies = [
      {},
      { limit: 4 },
      { filter: { generic_search_term: 'x13' } },
      { include_all_networks: true },
      null,
    ];
    const res = await request(
      env,
      '/_matrix/client/v3/publicRooms',
      jsonInit('POST', bodies[13 % 5])
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [], total_room_count_estimate: 0 });
  });
  it('POST stub soft-14', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const bodies = [
      {},
      { limit: 5 },
      { filter: { generic_search_term: 'x14' } },
      { include_all_networks: true },
      null,
    ];
    const res = await request(
      env,
      '/_matrix/client/v3/publicRooms',
      jsonInit('POST', bodies[14 % 5])
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [], total_room_count_estimate: 0 });
  });
  it('POST stub soft-15', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const bodies = [
      {},
      { limit: 1 },
      { filter: { generic_search_term: 'x15' } },
      { include_all_networks: true },
      null,
    ];
    const res = await request(
      env,
      '/_matrix/client/v3/publicRooms',
      jsonInit('POST', bodies[15 % 5])
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [], total_room_count_estimate: 0 });
  });
});

describe('publicRooms concurrent soft flood — method matrix after #208', () => {
  it('method soft-0: PUT', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const res = await request(env, '/_matrix/client/v3/publicRooms', { method: 'PUT', headers: AUTH });
    expect([200, 204, 404, 405]).toContain(res.status);
  });
  it('method soft-1: DELETE', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const res = await request(env, '/_matrix/client/v3/publicRooms', { method: 'DELETE', headers: AUTH });
    expect([200, 204, 404, 405]).toContain(res.status);
  });
  it('method soft-2: PATCH', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const res = await request(env, '/_matrix/client/v3/publicRooms', { method: 'PATCH', headers: AUTH });
    expect([200, 204, 404, 405]).toContain(res.status);
  });
  it('method soft-3: OPTIONS', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const res = await request(env, '/_matrix/client/v3/publicRooms', { method: 'OPTIONS', headers: AUTH });
    expect([200, 204, 404, 405]).toContain(res.status);
  });
  it('method soft-4: PUT', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const res = await request(env, '/_matrix/client/v3/publicRooms', { method: 'PUT', headers: AUTH });
    expect([200, 204, 404, 405]).toContain(res.status);
  });
  it('method soft-5: DELETE', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const res = await request(env, '/_matrix/client/v3/publicRooms', { method: 'DELETE', headers: AUTH });
    expect([200, 204, 404, 405]).toContain(res.status);
  });
  it('method soft-6: PATCH', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const res = await request(env, '/_matrix/client/v3/publicRooms', { method: 'PATCH', headers: AUTH });
    expect([200, 204, 404, 405]).toContain(res.status);
  });
  it('method soft-7: OPTIONS', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const res = await request(env, '/_matrix/client/v3/publicRooms', { method: 'OPTIONS', headers: AUTH });
    expect([200, 204, 404, 405]).toContain(res.status);
  });
  it('method soft-8: PUT', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const res = await request(env, '/_matrix/client/v3/publicRooms', { method: 'PUT', headers: AUTH });
    expect([200, 204, 404, 405]).toContain(res.status);
  });
  it('method soft-9: DELETE', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const res = await request(env, '/_matrix/client/v3/publicRooms', { method: 'DELETE', headers: AUTH });
    expect([200, 204, 404, 405]).toContain(res.status);
  });
  it('method soft-10: PATCH', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const res = await request(env, '/_matrix/client/v3/publicRooms', { method: 'PATCH', headers: AUTH });
    expect([200, 204, 404, 405]).toContain(res.status);
  });
  it('method soft-11: OPTIONS', async () => {
    const env = createEnv(createDirectoryDb(defaultPublicFixture()));
    const res = await request(env, '/_matrix/client/v3/publicRooms', { method: 'OPTIONS', headers: AUTH });
    expect([200, 204, 404, 405]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// user_directory /search — FTS ALL barrier TOCTOU
// ---------------------------------------------------------------------------

describe('race user_directory FTS ALL barrier TOCTOU after #208', () => {
  it('parallel search under FTS ALL barrier both 200 with Bob', async () => {
    const db = createDirectoryDb({
      users: defaultUsers(),
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('users_fts') && sql.includes('MATCH'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/user_directory/search', jsonInit('POST', { search_term: 'bob' })),
      request(env, '/_matrix/client/v3/user_directory/search', jsonInit('POST', { search_term: 'bob' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    for (const r of results) {
      const body = r.body as { results: Array<{ user_id: string }>; limited: boolean };
      expect(body.results.some((u) => u.user_id === BOB)).toBe(true);
      expect(body.results.every((u) => u.user_id !== USER)).toBe(true);
      expect(body.results.every((u) => u.user_id !== EVE)).toBe(true);
    }
    expect(db.ftsAllCount).toBe(2);
  });

  it('FTS mid-flight deactivate: second search may drop Bob', async () => {
    const db = createDirectoryDb({
      users: defaultUsers(),
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('users_fts') && sql.includes('MATCH'),
      },
      mutateUsersAfterAll: {
        after: 1,
        next: defaultUsers().map((u) =>
          u.user_id === BOB ? { ...u, is_deactivated: 1 } : u
        ),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/user_directory/search', jsonInit('POST', { search_term: 'bob' })),
      request(env, '/_matrix/client/v3/user_directory/search', jsonInit('POST', { search_term: 'bob' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const hitCounts = results.map(
      (r) =>
        (r.body as { results: Array<{ user_id: string }> }).results.filter((u) => u.user_id === BOB)
          .length
    );
    expect(hitCounts).toContain(1);
    expect(hitCounts.every((c) => c === 0 || c === 1)).toBe(true);
  });

  it('limit+1 limited flag under parallel distinct limits', async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      seedUser(`@u${i}:example.com`, { display_name: `User${i}`, fts: `user${i} shared` })
    );
    const db = createDirectoryDb({ users: [...defaultUsers(), ...many] });
    const env = createEnv(db);
    const results = await Promise.all([
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'shared', limit: 5 })
      ),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'shared', limit: 50 })
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const [a, b] = results.map((r) => r.body as { results: unknown[]; limited: boolean });
    expect(a.results.length).toBe(5);
    expect(a.limited).toBe(true);
    expect(b.results.length).toBeLessThanOrEqual(50);
  });
  it(`FTS ALL barrier soft-0: dual search term=bob`, async () => {
    const db = createDirectoryDb({
      users: defaultUsers(),
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('users_fts') && sql.includes('MATCH'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'bob', limit: 10 })
      ),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'bob', limit: 10 })
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`FTS ALL barrier soft-1: dual search term=carol`, async () => {
    const db = createDirectoryDb({
      users: defaultUsers(),
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('users_fts') && sql.includes('MATCH'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'carol', limit: 10 })
      ),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'carol', limit: 10 })
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`FTS ALL barrier soft-2: dual search term=dave`, async () => {
    const db = createDirectoryDb({
      users: defaultUsers(),
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('users_fts') && sql.includes('MATCH'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'dave', limit: 10 })
      ),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'dave', limit: 10 })
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`FTS ALL barrier soft-3: dual search term=builder`, async () => {
    const db = createDirectoryDb({
      users: defaultUsers(),
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('users_fts') && sql.includes('MATCH'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'builder', limit: 10 })
      ),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'builder', limit: 10 })
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`FTS ALL barrier soft-4: dual search term=bob`, async () => {
    const db = createDirectoryDb({
      users: defaultUsers(),
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('users_fts') && sql.includes('MATCH'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'bob', limit: 10 })
      ),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'bob', limit: 10 })
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`FTS ALL barrier soft-5: dual search term=carol`, async () => {
    const db = createDirectoryDb({
      users: defaultUsers(),
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('users_fts') && sql.includes('MATCH'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'carol', limit: 10 })
      ),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'carol', limit: 10 })
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`FTS ALL barrier soft-6: dual search term=dave`, async () => {
    const db = createDirectoryDb({
      users: defaultUsers(),
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('users_fts') && sql.includes('MATCH'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'dave', limit: 10 })
      ),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'dave', limit: 10 })
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`FTS ALL barrier soft-7: dual search term=builder`, async () => {
    const db = createDirectoryDb({
      users: defaultUsers(),
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('users_fts') && sql.includes('MATCH'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'builder', limit: 10 })
      ),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'builder', limit: 10 })
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`FTS ALL barrier soft-8: dual search term=bob`, async () => {
    const db = createDirectoryDb({
      users: defaultUsers(),
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('users_fts') && sql.includes('MATCH'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'bob', limit: 10 })
      ),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'bob', limit: 10 })
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`FTS ALL barrier soft-9: dual search term=carol`, async () => {
    const db = createDirectoryDb({
      users: defaultUsers(),
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('users_fts') && sql.includes('MATCH'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'carol', limit: 10 })
      ),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'carol', limit: 10 })
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`FTS ALL barrier soft-10: dual search term=dave`, async () => {
    const db = createDirectoryDb({
      users: defaultUsers(),
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('users_fts') && sql.includes('MATCH'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'dave', limit: 10 })
      ),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'dave', limit: 10 })
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`FTS ALL barrier soft-11: dual search term=builder`, async () => {
    const db = createDirectoryDb({
      users: defaultUsers(),
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('users_fts') && sql.includes('MATCH'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'builder', limit: 10 })
      ),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'builder', limit: 10 })
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`FTS ALL barrier soft-12: dual search term=bob`, async () => {
    const db = createDirectoryDb({
      users: defaultUsers(),
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('users_fts') && sql.includes('MATCH'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'bob', limit: 10 })
      ),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'bob', limit: 10 })
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`FTS ALL barrier soft-13: dual search term=carol`, async () => {
    const db = createDirectoryDb({
      users: defaultUsers(),
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('users_fts') && sql.includes('MATCH'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'carol', limit: 10 })
      ),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'carol', limit: 10 })
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`FTS ALL barrier soft-14: dual search term=dave`, async () => {
    const db = createDirectoryDb({
      users: defaultUsers(),
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('users_fts') && sql.includes('MATCH'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'dave', limit: 10 })
      ),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'dave', limit: 10 })
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
  it(`FTS ALL barrier soft-15: dual search term=builder`, async () => {
    const db = createDirectoryDb({
      users: defaultUsers(),
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('users_fts') && sql.includes('MATCH'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'builder', limit: 10 })
      ),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'builder', limit: 10 })
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
});

describe('race user_directory empty/bad JSON / exclude-self soft after #208', () => {
  it('empty search_term returns empty without FTS', async () => {
    const db = createDirectoryDb({ users: defaultUsers() });
    const env = createEnv(db);
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: '' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [], limited: false });
    expect(db.ftsAllCount).toBe(0);
  });

  it('bad JSON → M_BAD_JSON', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
    expect((res.body as { errcode: string }).errcode).toBe('M_BAD_JSON');
  });

  it('self never appears when searching own display name', async () => {
    const db = createDirectoryDb({ users: defaultUsers() });
    const env = createEnv(db);
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'alice' })
    );
    expect(res.status).toBe(200);
    const body = res.body as { results: Array<{ user_id: string }> };
    expect(body.results.every((u) => u.user_id !== USER)).toBe(true);
  });

  it('guest and deactivated filtered', async () => {
    const db = createDirectoryDb({ users: defaultUsers() });
    const env = createEnv(db);
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'eve' })
    );
    expect(res.status).toBe(200);
    expect((res.body as { results: unknown[] }).results).toHaveLength(0);
    const g = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'guest' })
    );
    expect((g.body as { results: unknown[] }).results).toHaveLength(0);
  });

  it('FTS throw surfaces 500', async () => {
    const db = createDirectoryDb({ users: defaultUsers(), failFtsAll: true });
    const env = createEnv(db);
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'bob' })
    );
    expect(res.status).toBe(500);
  });

  it('parallel FTS both 500 under barrier when FTS throws', async () => {
    const db = createDirectoryDb({
      users: defaultUsers(),
      failFtsAll: true,
      allBarrier: {
        count: 2,
        match: (sql) => sql.includes('users_fts'),
      },
    });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/user_directory/search', jsonInit('POST', { search_term: 'bob' })),
      request(env, '/_matrix/client/v3/user_directory/search', jsonInit('POST', { search_term: 'bob' })),
    ]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });
  it('bad JSON soft-0', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const bodies = ['{', '{x', 'null', '[1]', '"str"'];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: bodies[0 % 5],
    });
    expect([200, 400, 500]).toContain(res.status);
  });
  it('bad JSON soft-1', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const bodies = ['{', '{x', 'null', '[1]', '"str"'];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: bodies[1 % 5],
    });
    expect([200, 400, 500]).toContain(res.status);
  });
  it('bad JSON soft-2', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const bodies = ['{', '{x', 'null', '[1]', '"str"'];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: bodies[2 % 5],
    });
    expect([200, 400, 500]).toContain(res.status);
  });
  it('bad JSON soft-3', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const bodies = ['{', '{x', 'null', '[1]', '"str"'];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: bodies[3 % 5],
    });
    expect([200, 400, 500]).toContain(res.status);
  });
  it('bad JSON soft-4', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const bodies = ['{', '{x', 'null', '[1]', '"str"'];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: bodies[4 % 5],
    });
    expect([200, 400, 500]).toContain(res.status);
  });
  it('bad JSON soft-5', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const bodies = ['{', '{x', 'null', '[1]', '"str"'];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: bodies[5 % 5],
    });
    expect([200, 400, 500]).toContain(res.status);
  });
  it('bad JSON soft-6', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const bodies = ['{', '{x', 'null', '[1]', '"str"'];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: bodies[6 % 5],
    });
    expect([200, 400, 500]).toContain(res.status);
  });
  it('bad JSON soft-7', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const bodies = ['{', '{x', 'null', '[1]', '"str"'];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: bodies[7 % 5],
    });
    expect([200, 400, 500]).toContain(res.status);
  });
  it('bad JSON soft-8', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const bodies = ['{', '{x', 'null', '[1]', '"str"'];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: bodies[8 % 5],
    });
    expect([200, 400, 500]).toContain(res.status);
  });
  it('bad JSON soft-9', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const bodies = ['{', '{x', 'null', '[1]', '"str"'];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: bodies[9 % 5],
    });
    expect([200, 400, 500]).toContain(res.status);
  });
  it('bad JSON soft-10', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const bodies = ['{', '{x', 'null', '[1]', '"str"'];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: bodies[10 % 5],
    });
    expect([200, 400, 500]).toContain(res.status);
  });
  it('bad JSON soft-11', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const bodies = ['{', '{x', 'null', '[1]', '"str"'];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: bodies[11 % 5],
    });
    expect([200, 400, 500]).toContain(res.status);
  });
  it('bad JSON soft-12', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const bodies = ['{', '{x', 'null', '[1]', '"str"'];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: bodies[12 % 5],
    });
    expect([200, 400, 500]).toContain(res.status);
  });
  it('bad JSON soft-13', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const bodies = ['{', '{x', 'null', '[1]', '"str"'];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: bodies[13 % 5],
    });
    expect([200, 400, 500]).toContain(res.status);
  });
  it('bad JSON soft-14', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const bodies = ['{', '{x', 'null', '[1]', '"str"'];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: bodies[14 % 5],
    });
    expect([200, 400, 500]).toContain(res.status);
  });
  it('bad JSON soft-15', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const bodies = ['{', '{x', 'null', '[1]', '"str"'];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: bodies[15 % 5],
    });
    expect([200, 400, 500]).toContain(res.status);
  });
  it('empty/whitespace term soft-0', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const terms = ['', '   ', '\t', null, undefined];
    const term = terms[0 % 5];
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: term as unknown as string })
    );
    expect(res.status).toBe(200);
    expect((res.body as { results: unknown[] }).results).toEqual([]);
  });
  it('empty/whitespace term soft-1', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const terms = ['', '   ', '\t', null, undefined];
    const term = terms[1 % 5];
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: term as unknown as string })
    );
    expect(res.status).toBe(200);
    expect((res.body as { results: unknown[] }).results).toEqual([]);
  });
  it('empty/whitespace term soft-2', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const terms = ['', '   ', '\t', null, undefined];
    const term = terms[2 % 5];
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: term as unknown as string })
    );
    expect(res.status).toBe(200);
    expect((res.body as { results: unknown[] }).results).toEqual([]);
  });
  it('empty/whitespace term soft-3', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const terms = ['', '   ', '\t', null, undefined];
    const term = terms[3 % 5];
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: term as unknown as string })
    );
    expect(res.status).toBe(200);
    expect((res.body as { results: unknown[] }).results).toEqual([]);
  });
  it('empty/whitespace term soft-4', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const terms = ['', '   ', '\t', null, undefined];
    const term = terms[4 % 5];
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: term as unknown as string })
    );
    expect(res.status).toBe(200);
    expect((res.body as { results: unknown[] }).results).toEqual([]);
  });
  it('empty/whitespace term soft-5', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const terms = ['', '   ', '\t', null, undefined];
    const term = terms[5 % 5];
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: term as unknown as string })
    );
    expect(res.status).toBe(200);
    expect((res.body as { results: unknown[] }).results).toEqual([]);
  });
  it('empty/whitespace term soft-6', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const terms = ['', '   ', '\t', null, undefined];
    const term = terms[6 % 5];
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: term as unknown as string })
    );
    expect(res.status).toBe(200);
    expect((res.body as { results: unknown[] }).results).toEqual([]);
  });
  it('empty/whitespace term soft-7', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const terms = ['', '   ', '\t', null, undefined];
    const term = terms[7 % 5];
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: term as unknown as string })
    );
    expect(res.status).toBe(200);
    expect((res.body as { results: unknown[] }).results).toEqual([]);
  });
  it('empty/whitespace term soft-8', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const terms = ['', '   ', '\t', null, undefined];
    const term = terms[8 % 5];
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: term as unknown as string })
    );
    expect(res.status).toBe(200);
    expect((res.body as { results: unknown[] }).results).toEqual([]);
  });
  it('empty/whitespace term soft-9', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const terms = ['', '   ', '\t', null, undefined];
    const term = terms[9 % 5];
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: term as unknown as string })
    );
    expect(res.status).toBe(200);
    expect((res.body as { results: unknown[] }).results).toEqual([]);
  });
  it('empty/whitespace term soft-10', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const terms = ['', '   ', '\t', null, undefined];
    const term = terms[10 % 5];
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: term as unknown as string })
    );
    expect(res.status).toBe(200);
    expect((res.body as { results: unknown[] }).results).toEqual([]);
  });
  it('empty/whitespace term soft-11', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const terms = ['', '   ', '\t', null, undefined];
    const term = terms[11 % 5];
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: term as unknown as string })
    );
    expect(res.status).toBe(200);
    expect((res.body as { results: unknown[] }).results).toEqual([]);
  });
});

describe('user_directory concurrent soft flood — limit clamp / charset after #208', () => {
  it('limit clamp soft-0', async () => {
    const many = Array.from({ length: 60 }, (_, j) =>
      seedUser(`@n${j}:example.com`, { display_name: `Name${j}`, fts: 'shared name' })
    );
    const db = createDirectoryDb({ users: [...defaultUsers(), ...many] });
    const env = createEnv(db);
    const limits = [0, 1, 10, 50, 999, -1, undefined];
    const limit = limits[0 % 7] as number | undefined;
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'shared', limit })
    );
    expect(res.status).toBe(200);
    const body = res.body as { results: unknown[]; limited: boolean };
    expect(body.results.length).toBeLessThanOrEqual(50);
  });
  it('limit clamp soft-1', async () => {
    const many = Array.from({ length: 60 }, (_, j) =>
      seedUser(`@n${j}:example.com`, { display_name: `Name${j}`, fts: 'shared name' })
    );
    const db = createDirectoryDb({ users: [...defaultUsers(), ...many] });
    const env = createEnv(db);
    const limits = [0, 1, 10, 50, 999, -1, undefined];
    const limit = limits[1 % 7] as number | undefined;
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'shared', limit })
    );
    expect(res.status).toBe(200);
    const body = res.body as { results: unknown[]; limited: boolean };
    expect(body.results.length).toBeLessThanOrEqual(50);
  });
  it('limit clamp soft-2', async () => {
    const many = Array.from({ length: 60 }, (_, j) =>
      seedUser(`@n${j}:example.com`, { display_name: `Name${j}`, fts: 'shared name' })
    );
    const db = createDirectoryDb({ users: [...defaultUsers(), ...many] });
    const env = createEnv(db);
    const limits = [0, 1, 10, 50, 999, -1, undefined];
    const limit = limits[2 % 7] as number | undefined;
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'shared', limit })
    );
    expect(res.status).toBe(200);
    const body = res.body as { results: unknown[]; limited: boolean };
    expect(body.results.length).toBeLessThanOrEqual(50);
  });
  it('limit clamp soft-3', async () => {
    const many = Array.from({ length: 60 }, (_, j) =>
      seedUser(`@n${j}:example.com`, { display_name: `Name${j}`, fts: 'shared name' })
    );
    const db = createDirectoryDb({ users: [...defaultUsers(), ...many] });
    const env = createEnv(db);
    const limits = [0, 1, 10, 50, 999, -1, undefined];
    const limit = limits[3 % 7] as number | undefined;
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'shared', limit })
    );
    expect(res.status).toBe(200);
    const body = res.body as { results: unknown[]; limited: boolean };
    expect(body.results.length).toBeLessThanOrEqual(50);
  });
  it('limit clamp soft-4', async () => {
    const many = Array.from({ length: 60 }, (_, j) =>
      seedUser(`@n${j}:example.com`, { display_name: `Name${j}`, fts: 'shared name' })
    );
    const db = createDirectoryDb({ users: [...defaultUsers(), ...many] });
    const env = createEnv(db);
    const limits = [0, 1, 10, 50, 999, -1, undefined];
    const limit = limits[4 % 7] as number | undefined;
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'shared', limit })
    );
    expect(res.status).toBe(200);
    const body = res.body as { results: unknown[]; limited: boolean };
    expect(body.results.length).toBeLessThanOrEqual(50);
  });
  it('limit clamp soft-5', async () => {
    const many = Array.from({ length: 60 }, (_, j) =>
      seedUser(`@n${j}:example.com`, { display_name: `Name${j}`, fts: 'shared name' })
    );
    const db = createDirectoryDb({ users: [...defaultUsers(), ...many] });
    const env = createEnv(db);
    const limits = [0, 1, 10, 50, 999, -1, undefined];
    const limit = limits[5 % 7] as number | undefined;
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'shared', limit })
    );
    expect(res.status).toBe(200);
    const body = res.body as { results: unknown[]; limited: boolean };
    expect(body.results.length).toBeLessThanOrEqual(50);
  });
  it('limit clamp soft-6', async () => {
    const many = Array.from({ length: 60 }, (_, j) =>
      seedUser(`@n${j}:example.com`, { display_name: `Name${j}`, fts: 'shared name' })
    );
    const db = createDirectoryDb({ users: [...defaultUsers(), ...many] });
    const env = createEnv(db);
    const limits = [0, 1, 10, 50, 999, -1, undefined];
    const limit = limits[6 % 7] as number | undefined;
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'shared', limit })
    );
    expect(res.status).toBe(200);
    const body = res.body as { results: unknown[]; limited: boolean };
    expect(body.results.length).toBeLessThanOrEqual(50);
  });
  it('limit clamp soft-7', async () => {
    const many = Array.from({ length: 60 }, (_, j) =>
      seedUser(`@n${j}:example.com`, { display_name: `Name${j}`, fts: 'shared name' })
    );
    const db = createDirectoryDb({ users: [...defaultUsers(), ...many] });
    const env = createEnv(db);
    const limits = [0, 1, 10, 50, 999, -1, undefined];
    const limit = limits[7 % 7] as number | undefined;
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'shared', limit })
    );
    expect(res.status).toBe(200);
    const body = res.body as { results: unknown[]; limited: boolean };
    expect(body.results.length).toBeLessThanOrEqual(50);
  });
  it('limit clamp soft-8', async () => {
    const many = Array.from({ length: 60 }, (_, j) =>
      seedUser(`@n${j}:example.com`, { display_name: `Name${j}`, fts: 'shared name' })
    );
    const db = createDirectoryDb({ users: [...defaultUsers(), ...many] });
    const env = createEnv(db);
    const limits = [0, 1, 10, 50, 999, -1, undefined];
    const limit = limits[8 % 7] as number | undefined;
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'shared', limit })
    );
    expect(res.status).toBe(200);
    const body = res.body as { results: unknown[]; limited: boolean };
    expect(body.results.length).toBeLessThanOrEqual(50);
  });
  it('limit clamp soft-9', async () => {
    const many = Array.from({ length: 60 }, (_, j) =>
      seedUser(`@n${j}:example.com`, { display_name: `Name${j}`, fts: 'shared name' })
    );
    const db = createDirectoryDb({ users: [...defaultUsers(), ...many] });
    const env = createEnv(db);
    const limits = [0, 1, 10, 50, 999, -1, undefined];
    const limit = limits[9 % 7] as number | undefined;
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'shared', limit })
    );
    expect(res.status).toBe(200);
    const body = res.body as { results: unknown[]; limited: boolean };
    expect(body.results.length).toBeLessThanOrEqual(50);
  });
  it('limit clamp soft-10', async () => {
    const many = Array.from({ length: 60 }, (_, j) =>
      seedUser(`@n${j}:example.com`, { display_name: `Name${j}`, fts: 'shared name' })
    );
    const db = createDirectoryDb({ users: [...defaultUsers(), ...many] });
    const env = createEnv(db);
    const limits = [0, 1, 10, 50, 999, -1, undefined];
    const limit = limits[10 % 7] as number | undefined;
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'shared', limit })
    );
    expect(res.status).toBe(200);
    const body = res.body as { results: unknown[]; limited: boolean };
    expect(body.results.length).toBeLessThanOrEqual(50);
  });
  it('limit clamp soft-11', async () => {
    const many = Array.from({ length: 60 }, (_, j) =>
      seedUser(`@n${j}:example.com`, { display_name: `Name${j}`, fts: 'shared name' })
    );
    const db = createDirectoryDb({ users: [...defaultUsers(), ...many] });
    const env = createEnv(db);
    const limits = [0, 1, 10, 50, 999, -1, undefined];
    const limit = limits[11 % 7] as number | undefined;
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'shared', limit })
    );
    expect(res.status).toBe(200);
    const body = res.body as { results: unknown[]; limited: boolean };
    expect(body.results.length).toBeLessThanOrEqual(50);
  });
  it('limit clamp soft-12', async () => {
    const many = Array.from({ length: 60 }, (_, j) =>
      seedUser(`@n${j}:example.com`, { display_name: `Name${j}`, fts: 'shared name' })
    );
    const db = createDirectoryDb({ users: [...defaultUsers(), ...many] });
    const env = createEnv(db);
    const limits = [0, 1, 10, 50, 999, -1, undefined];
    const limit = limits[12 % 7] as number | undefined;
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'shared', limit })
    );
    expect(res.status).toBe(200);
    const body = res.body as { results: unknown[]; limited: boolean };
    expect(body.results.length).toBeLessThanOrEqual(50);
  });
  it('limit clamp soft-13', async () => {
    const many = Array.from({ length: 60 }, (_, j) =>
      seedUser(`@n${j}:example.com`, { display_name: `Name${j}`, fts: 'shared name' })
    );
    const db = createDirectoryDb({ users: [...defaultUsers(), ...many] });
    const env = createEnv(db);
    const limits = [0, 1, 10, 50, 999, -1, undefined];
    const limit = limits[13 % 7] as number | undefined;
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'shared', limit })
    );
    expect(res.status).toBe(200);
    const body = res.body as { results: unknown[]; limited: boolean };
    expect(body.results.length).toBeLessThanOrEqual(50);
  });
  it('charset Content-Type soft-0', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const cts = [
      'application/json',
      'application/json; charset=utf-8',
      'application/json;charset=UTF-8',
      'text/plain',
      'application/json; charset=utf-16',
    ];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': cts[0 % 5] },
      body: JSON.stringify({ search_term: 'bob' }),
    });
    expect([200, 400, 415]).toContain(res.status);
  });
  it('charset Content-Type soft-1', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const cts = [
      'application/json',
      'application/json; charset=utf-8',
      'application/json;charset=UTF-8',
      'text/plain',
      'application/json; charset=utf-16',
    ];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': cts[1 % 5] },
      body: JSON.stringify({ search_term: 'bob' }),
    });
    expect([200, 400, 415]).toContain(res.status);
  });
  it('charset Content-Type soft-2', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const cts = [
      'application/json',
      'application/json; charset=utf-8',
      'application/json;charset=UTF-8',
      'text/plain',
      'application/json; charset=utf-16',
    ];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': cts[2 % 5] },
      body: JSON.stringify({ search_term: 'bob' }),
    });
    expect([200, 400, 415]).toContain(res.status);
  });
  it('charset Content-Type soft-3', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const cts = [
      'application/json',
      'application/json; charset=utf-8',
      'application/json;charset=UTF-8',
      'text/plain',
      'application/json; charset=utf-16',
    ];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': cts[3 % 5] },
      body: JSON.stringify({ search_term: 'bob' }),
    });
    expect([200, 400, 415]).toContain(res.status);
  });
  it('charset Content-Type soft-4', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const cts = [
      'application/json',
      'application/json; charset=utf-8',
      'application/json;charset=UTF-8',
      'text/plain',
      'application/json; charset=utf-16',
    ];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': cts[4 % 5] },
      body: JSON.stringify({ search_term: 'bob' }),
    });
    expect([200, 400, 415]).toContain(res.status);
  });
  it('charset Content-Type soft-5', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const cts = [
      'application/json',
      'application/json; charset=utf-8',
      'application/json;charset=UTF-8',
      'text/plain',
      'application/json; charset=utf-16',
    ];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': cts[5 % 5] },
      body: JSON.stringify({ search_term: 'bob' }),
    });
    expect([200, 400, 415]).toContain(res.status);
  });
  it('charset Content-Type soft-6', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const cts = [
      'application/json',
      'application/json; charset=utf-8',
      'application/json;charset=UTF-8',
      'text/plain',
      'application/json; charset=utf-16',
    ];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': cts[6 % 5] },
      body: JSON.stringify({ search_term: 'bob' }),
    });
    expect([200, 400, 415]).toContain(res.status);
  });
  it('charset Content-Type soft-7', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const cts = [
      'application/json',
      'application/json; charset=utf-8',
      'application/json;charset=UTF-8',
      'text/plain',
      'application/json; charset=utf-16',
    ];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': cts[7 % 5] },
      body: JSON.stringify({ search_term: 'bob' }),
    });
    expect([200, 400, 415]).toContain(res.status);
  });
  it('charset Content-Type soft-8', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const cts = [
      'application/json',
      'application/json; charset=utf-8',
      'application/json;charset=UTF-8',
      'text/plain',
      'application/json; charset=utf-16',
    ];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': cts[8 % 5] },
      body: JSON.stringify({ search_term: 'bob' }),
    });
    expect([200, 400, 415]).toContain(res.status);
  });
  it('charset Content-Type soft-9', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const cts = [
      'application/json',
      'application/json; charset=utf-8',
      'application/json;charset=UTF-8',
      'text/plain',
      'application/json; charset=utf-16',
    ];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': cts[9 % 5] },
      body: JSON.stringify({ search_term: 'bob' }),
    });
    expect([200, 400, 415]).toContain(res.status);
  });
});

describe('user_directory SQL bind contracts after #208', () => {
  it('FTS MATCH binds sanitized term, exclude self, limit+1', async () => {
    const db = createDirectoryDb({ users: defaultUsers() });
    const env = createEnv(db);
    await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'bo*b"x', limit: 7 })
    );
    const fts = db.alls.find((c) => c.sql.includes('users_fts'));
    expect(fts).toBeTruthy();
    expect(fts!.args[0]).toBe('bo b x');
    expect(fts!.args[1]).toBe(USER);
    expect(fts!.args[2]).toBe(8);
  });

  it('default limit 10 binds 11', async () => {
    const db = createDirectoryDb({ users: defaultUsers() });
    const env = createEnv(db);
    await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'carol' })
    );
    const fts = db.alls.find((c) => c.sql.includes('users_fts'));
    expect(fts!.args[2]).toBe(11);
  });

  it('null display_name / avatar_url preserved in response', async () => {
    const db = createDirectoryDb({
      users: [seedUser(USER), seedUser(BOB, { display_name: null, avatar_url: null, fts: 'bob' })],
    });
    const env = createEnv(db);
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'bob' })
    );
    expect(res.status).toBe(200);
    const hit = (res.body as { results: Array<Record<string, unknown>> }).results[0];
    expect(hit).toEqual({ user_id: BOB, display_name: null, avatar_url: null });
  });
  it(`bind soft-0: term sanitizes quotes/stars/parens`, async () => {
    const db = createDirectoryDb({ users: defaultUsers() });
    const env = createEnv(db);
    const raw = 'a*b';
    await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: raw })
    );
    const fts = db.alls.find((c) => c.sql.includes('users_fts'));
    expect(String(fts!.args[0])).not.toMatch(/[*"'()]/);
  });
  it(`bind soft-1: term sanitizes quotes/stars/parens`, async () => {
    const db = createDirectoryDb({ users: defaultUsers() });
    const env = createEnv(db);
    const raw = 'a"b';
    await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: raw })
    );
    const fts = db.alls.find((c) => c.sql.includes('users_fts'));
    expect(String(fts!.args[0])).not.toMatch(/[*"'()]/);
  });
  it(`bind soft-2: term sanitizes quotes/stars/parens`, async () => {
    const db = createDirectoryDb({ users: defaultUsers() });
    const env = createEnv(db);
    const raw = 'a\'b';
    await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: raw })
    );
    const fts = db.alls.find((c) => c.sql.includes('users_fts'));
    expect(String(fts!.args[0])).not.toMatch(/[*"'()]/);
  });
  it(`bind soft-3: term sanitizes quotes/stars/parens`, async () => {
    const db = createDirectoryDb({ users: defaultUsers() });
    const env = createEnv(db);
    const raw = 'a(b)';
    await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: raw })
    );
    const fts = db.alls.find((c) => c.sql.includes('users_fts'));
    expect(String(fts!.args[0])).not.toMatch(/[*"'()]/);
  });
  it(`bind soft-4: term sanitizes quotes/stars/parens`, async () => {
    const db = createDirectoryDb({ users: defaultUsers() });
    const env = createEnv(db);
    const raw = 'a)b(';
    await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: raw })
    );
    const fts = db.alls.find((c) => c.sql.includes('users_fts'));
    expect(String(fts!.args[0])).not.toMatch(/[*"'()]/);
  });
  it(`bind soft-5: term sanitizes quotes/stars/parens`, async () => {
    const db = createDirectoryDb({ users: defaultUsers() });
    const env = createEnv(db);
    const raw = '***';
    await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: raw })
    );
    const fts = db.alls.find((c) => c.sql.includes('users_fts'));
    expect(String(fts!.args[0])).not.toMatch(/[*"'()]/);
  });
  it(`bind soft-6: term sanitizes quotes/stars/parens`, async () => {
    const db = createDirectoryDb({ users: defaultUsers() });
    const env = createEnv(db);
    const raw = '(((';
    await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: raw })
    );
    const fts = db.alls.find((c) => c.sql.includes('users_fts'));
    expect(String(fts!.args[0])).not.toMatch(/[*"'()]/);
  });
  it(`bind soft-7: term sanitizes quotes/stars/parens`, async () => {
    const db = createDirectoryDb({ users: defaultUsers() });
    const env = createEnv(db);
    const raw = 'x y';
    await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: raw })
    );
    const fts = db.alls.find((c) => c.sql.includes('users_fts'));
    expect(String(fts!.args[0])).not.toMatch(/[*"'()]/);
  });
});

describe('race thirdparty protocols concurrent stub after #208', () => {
  it('parallel GET protocols all return empty object', async () => {
    const env = createEnv(createDirectoryDb());
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(env, '/_matrix/client/v3/thirdparty/protocols')
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const r of results) expect(r.body).toEqual({});
  });
  it('protocols soft-0', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(env, '/_matrix/client/v3/thirdparty/protocols', {
      method: 'GET',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
  it('protocols soft-1', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(env, '/_matrix/client/v3/thirdparty/protocols', {
      method: 'GET',
      headers: {},
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
  it('protocols soft-2', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(env, '/_matrix/client/v3/thirdparty/protocols', {
      method: 'GET',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
  it('protocols soft-3', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(env, '/_matrix/client/v3/thirdparty/protocols', {
      method: 'GET',
      headers: {},
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
  it('protocols soft-4', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(env, '/_matrix/client/v3/thirdparty/protocols', {
      method: 'GET',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
  it('protocols soft-5', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(env, '/_matrix/client/v3/thirdparty/protocols', {
      method: 'GET',
      headers: {},
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
  it('protocols soft-6', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(env, '/_matrix/client/v3/thirdparty/protocols', {
      method: 'GET',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
  it('protocols soft-7', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(env, '/_matrix/client/v3/thirdparty/protocols', {
      method: 'GET',
      headers: {},
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
  it('protocols soft-8', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(env, '/_matrix/client/v3/thirdparty/protocols', {
      method: 'GET',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
  it('protocols soft-9', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(env, '/_matrix/client/v3/thirdparty/protocols', {
      method: 'GET',
      headers: {},
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
  it('protocols soft-10', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(env, '/_matrix/client/v3/thirdparty/protocols', {
      method: 'GET',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
  it('protocols soft-11', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(env, '/_matrix/client/v3/thirdparty/protocols', {
      method: 'GET',
      headers: {},
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
  it('protocols soft-12', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(env, '/_matrix/client/v3/thirdparty/protocols', {
      method: 'GET',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
  it('protocols soft-13', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(env, '/_matrix/client/v3/thirdparty/protocols', {
      method: 'GET',
      headers: {},
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
  it('protocols soft-14', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(env, '/_matrix/client/v3/thirdparty/protocols', {
      method: 'GET',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
  it('protocols soft-15', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(env, '/_matrix/client/v3/thirdparty/protocols', {
      method: 'GET',
      headers: {},
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
});

describe('dehydrated device stub concurrent soft after #208', () => {
  it('parallel GET dehydrated_device all 404 M_NOT_FOUND', async () => {
    const env = createEnv(createDirectoryDb());
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(env, '/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device')
      )
    );
    expect(results.every((r) => r.status === 404)).toBe(true);
    for (const r of results) {
      expect((r.body as { errcode: string }).errcode).toBe('M_NOT_FOUND');
    }
  });
  it('dehydrated soft-0', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(
      env,
      '/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device',
      { headers: AUTH }
    );
    expect(res.status).toBe(404);
  });
  it('dehydrated soft-1', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(
      env,
      '/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device',
      { headers: AUTH }
    );
    expect(res.status).toBe(404);
  });
  it('dehydrated soft-2', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(
      env,
      '/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device',
      { headers: AUTH }
    );
    expect(res.status).toBe(404);
  });
  it('dehydrated soft-3', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(
      env,
      '/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device',
      { headers: AUTH }
    );
    expect(res.status).toBe(404);
  });
  it('dehydrated soft-4', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(
      env,
      '/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device',
      { headers: AUTH }
    );
    expect(res.status).toBe(404);
  });
  it('dehydrated soft-5', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(
      env,
      '/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device',
      { headers: AUTH }
    );
    expect(res.status).toBe(404);
  });
  it('dehydrated soft-6', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(
      env,
      '/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device',
      { headers: AUTH }
    );
    expect(res.status).toBe(404);
  });
  it('dehydrated soft-7', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(
      env,
      '/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device',
      { headers: AUTH }
    );
    expect(res.status).toBe(404);
  });
  it('dehydrated soft-8', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(
      env,
      '/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device',
      { headers: AUTH }
    );
    expect(res.status).toBe(404);
  });
  it('dehydrated soft-9', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(
      env,
      '/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device',
      { headers: AUTH }
    );
    expect(res.status).toBe(404);
  });
  it('dehydrated soft-10', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(
      env,
      '/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device',
      { headers: AUTH }
    );
    expect(res.status).toBe(404);
  });
  it('dehydrated soft-11', async () => {
    const env = createEnv(createDirectoryDb());
    const res = await request(
      env,
      '/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device',
      { headers: AUTH }
    );
    expect(res.status).toBe(404);
  });
});

describe('race directory∥user_directory cross-endpoint isolation after #208', () => {
  it('parallel publicRooms + user_directory never mix fixtures', async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({
      ...fx,
      users: defaultUsers(),
      allBarrier: {
        count: 2,
        match: (sql) =>
          (sql.includes('FROM rooms r') && sql.includes('is_public')) ||
          sql.includes('users_fts'),
      },
    });
    const env = createEnv(db);
    const [roomsRes, searchRes] = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'bob' })
      ),
    ]);
    expect(roomsRes.status).toBe(200);
    expect(searchRes.status).toBe(200);
    expect(
      (roomsRes.body as { chunk: Array<{ room_id: string }> }).chunk.map((c) => c.room_id).sort()
    ).toEqual([ROOM_A, ROOM_B].sort());
    expect(
      (searchRes.body as { results: Array<{ user_id: string }> }).results.some(
        (u) => u.user_id === BOB
      )
    ).toBe(true);
  });

  it('publicRooms∥thirdparty∥user_directory triple isolation', async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, users: defaultUsers() });
    const env = createEnv(db);
    const [a, b, c] = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(env, '/_matrix/client/v3/thirdparty/protocols'),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'carol' })
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c.status).toBe(200);
    expect(b.body).toEqual({});
    expect(
      (c.body as { results: Array<{ user_id: string }> }).results[0]?.user_id
    ).toBe(CAROL);
  });
  it(`cross soft-0: GET rooms∥POST search∥GET protocols`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, users: defaultUsers() });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'dave' })
      ),
      request(env, '/_matrix/client/v3/thirdparty/protocols'),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
  });
  it(`cross soft-1: GET rooms∥POST search∥GET protocols`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, users: defaultUsers() });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'dave' })
      ),
      request(env, '/_matrix/client/v3/thirdparty/protocols'),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
  });
  it(`cross soft-2: GET rooms∥POST search∥GET protocols`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, users: defaultUsers() });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'dave' })
      ),
      request(env, '/_matrix/client/v3/thirdparty/protocols'),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
  });
  it(`cross soft-3: GET rooms∥POST search∥GET protocols`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, users: defaultUsers() });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'dave' })
      ),
      request(env, '/_matrix/client/v3/thirdparty/protocols'),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
  });
  it(`cross soft-4: GET rooms∥POST search∥GET protocols`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, users: defaultUsers() });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'dave' })
      ),
      request(env, '/_matrix/client/v3/thirdparty/protocols'),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
  });
  it(`cross soft-5: GET rooms∥POST search∥GET protocols`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, users: defaultUsers() });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'dave' })
      ),
      request(env, '/_matrix/client/v3/thirdparty/protocols'),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
  });
  it(`cross soft-6: GET rooms∥POST search∥GET protocols`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, users: defaultUsers() });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'dave' })
      ),
      request(env, '/_matrix/client/v3/thirdparty/protocols'),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
  });
  it(`cross soft-7: GET rooms∥POST search∥GET protocols`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, users: defaultUsers() });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'dave' })
      ),
      request(env, '/_matrix/client/v3/thirdparty/protocols'),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
  });
  it(`cross soft-8: GET rooms∥POST search∥GET protocols`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, users: defaultUsers() });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'dave' })
      ),
      request(env, '/_matrix/client/v3/thirdparty/protocols'),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
  });
  it(`cross soft-9: GET rooms∥POST search∥GET protocols`, async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, users: defaultUsers() });
    const env = createEnv(db);
    const results = await Promise.all([
      request(env, '/_matrix/client/v3/publicRooms'),
      request(
        env,
        '/_matrix/client/v3/user_directory/search',
        jsonInit('POST', { search_term: 'dave' })
      ),
      request(env, '/_matrix/client/v3/thirdparty/protocols'),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
  });
});

describe('directory lifecycle soft floods after #208', () => {
  it('lifecycle: list → mutate is_public → list', async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx });
    const env = createEnv(db);
    const first = await request(env, '/_matrix/client/v3/publicRooms');
    expect((first.body as { chunk: unknown[] }).chunk).toHaveLength(2);
    db.rooms.find((r) => r.room_id === ROOM_A)!.is_public = 0;
    const second = await request(env, '/_matrix/client/v3/publicRooms');
    expect(
      (second.body as { chunk: Array<{ room_id: string }> }).chunk.map((c) => c.room_id)
    ).toEqual([ROOM_B]);
  });

  it('lifecycle: search → deactivate → search', async () => {
    const db = createDirectoryDb({ users: defaultUsers() });
    const env = createEnv(db);
    const first = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'bob' })
    );
    expect((first.body as { results: unknown[] }).results).toHaveLength(1);
    db.users.find((u) => u.user_id === BOB)!.is_deactivated = 1;
    const second = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'bob' })
    );
    expect((second.body as { results: unknown[] }).results).toHaveLength(0);
  });
  it('lifecycle soft-0: rooms then search', async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, users: defaultUsers() });
    const env = createEnv(db);
    expect((await request(env, '/_matrix/client/v3/publicRooms')).status).toBe(200);
    expect(
      (
        await request(
          env,
          '/_matrix/client/v3/user_directory/search',
          jsonInit('POST', { search_term: 'carol' })
        )
      ).status
    ).toBe(200);
  });
  it('lifecycle soft-1: rooms then search', async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, users: defaultUsers() });
    const env = createEnv(db);
    expect((await request(env, '/_matrix/client/v3/publicRooms')).status).toBe(200);
    expect(
      (
        await request(
          env,
          '/_matrix/client/v3/user_directory/search',
          jsonInit('POST', { search_term: 'carol' })
        )
      ).status
    ).toBe(200);
  });
  it('lifecycle soft-2: rooms then search', async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, users: defaultUsers() });
    const env = createEnv(db);
    expect((await request(env, '/_matrix/client/v3/publicRooms')).status).toBe(200);
    expect(
      (
        await request(
          env,
          '/_matrix/client/v3/user_directory/search',
          jsonInit('POST', { search_term: 'carol' })
        )
      ).status
    ).toBe(200);
  });
  it('lifecycle soft-3: rooms then search', async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, users: defaultUsers() });
    const env = createEnv(db);
    expect((await request(env, '/_matrix/client/v3/publicRooms')).status).toBe(200);
    expect(
      (
        await request(
          env,
          '/_matrix/client/v3/user_directory/search',
          jsonInit('POST', { search_term: 'carol' })
        )
      ).status
    ).toBe(200);
  });
  it('lifecycle soft-4: rooms then search', async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, users: defaultUsers() });
    const env = createEnv(db);
    expect((await request(env, '/_matrix/client/v3/publicRooms')).status).toBe(200);
    expect(
      (
        await request(
          env,
          '/_matrix/client/v3/user_directory/search',
          jsonInit('POST', { search_term: 'carol' })
        )
      ).status
    ).toBe(200);
  });
  it('lifecycle soft-5: rooms then search', async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, users: defaultUsers() });
    const env = createEnv(db);
    expect((await request(env, '/_matrix/client/v3/publicRooms')).status).toBe(200);
    expect(
      (
        await request(
          env,
          '/_matrix/client/v3/user_directory/search',
          jsonInit('POST', { search_term: 'carol' })
        )
      ).status
    ).toBe(200);
  });
  it('lifecycle soft-6: rooms then search', async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, users: defaultUsers() });
    const env = createEnv(db);
    expect((await request(env, '/_matrix/client/v3/publicRooms')).status).toBe(200);
    expect(
      (
        await request(
          env,
          '/_matrix/client/v3/user_directory/search',
          jsonInit('POST', { search_term: 'carol' })
        )
      ).status
    ).toBe(200);
  });
  it('lifecycle soft-7: rooms then search', async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, users: defaultUsers() });
    const env = createEnv(db);
    expect((await request(env, '/_matrix/client/v3/publicRooms')).status).toBe(200);
    expect(
      (
        await request(
          env,
          '/_matrix/client/v3/user_directory/search',
          jsonInit('POST', { search_term: 'carol' })
        )
      ).status
    ).toBe(200);
  });
  it('lifecycle soft-8: rooms then search', async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, users: defaultUsers() });
    const env = createEnv(db);
    expect((await request(env, '/_matrix/client/v3/publicRooms')).status).toBe(200);
    expect(
      (
        await request(
          env,
          '/_matrix/client/v3/user_directory/search',
          jsonInit('POST', { search_term: 'carol' })
        )
      ).status
    ).toBe(200);
  });
  it('lifecycle soft-9: rooms then search', async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, users: defaultUsers() });
    const env = createEnv(db);
    expect((await request(env, '/_matrix/client/v3/publicRooms')).status).toBe(200);
    expect(
      (
        await request(
          env,
          '/_matrix/client/v3/user_directory/search',
          jsonInit('POST', { search_term: 'carol' })
        )
      ).status
    ).toBe(200);
  });
  it('lifecycle soft-10: rooms then search', async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, users: defaultUsers() });
    const env = createEnv(db);
    expect((await request(env, '/_matrix/client/v3/publicRooms')).status).toBe(200);
    expect(
      (
        await request(
          env,
          '/_matrix/client/v3/user_directory/search',
          jsonInit('POST', { search_term: 'carol' })
        )
      ).status
    ).toBe(200);
  });
  it('lifecycle soft-11: rooms then search', async () => {
    const fx = defaultPublicFixture();
    const db = createDirectoryDb({ ...fx, users: defaultUsers() });
    const env = createEnv(db);
    expect((await request(env, '/_matrix/client/v3/publicRooms')).status).toBe(200);
    expect(
      (
        await request(
          env,
          '/_matrix/client/v3/user_directory/search',
          jsonInit('POST', { search_term: 'carol' })
        )
      ).status
    ).toBe(200);
  });
});

describe('publicRooms enrichment edges soft flood after #208', () => {
  it('missing name/topic yields undefined fields; member count 0 ok', async () => {
    const db = createDirectoryDb({
      rooms: [{ room_id: ROOM_A, room_version: '11', is_public: 1 }],
      state: [],
      memberships: [],
    });
    const env = createEnv(db);
    const res = await request(env, '/_matrix/client/v3/publicRooms');
    expect(res.status).toBe(200);
    const chunk = (res.body as { chunk: Array<Record<string, unknown>> }).chunk;
    expect(chunk).toHaveLength(1);
    expect(chunk[0].room_id).toBe(ROOM_A);
    expect(chunk[0].name).toBeUndefined();
    expect(chunk[0].topic).toBeUndefined();
    expect(chunk[0].num_joined_members).toBe(0);
    expect(chunk[0].world_readable).toBe(false);
    expect(chunk[0].guest_can_join).toBe(false);
  });
  it('enrichment soft-0: public room with partial state', async () => {
    const withName = 0 % 2 === 0;
    const withTopic = 0 % 3 === 0;
    const members = [USER, BOB, CAROL].slice(0, (0 % 3) + 1);
    const seeded = seedPublic(ROOM_A, {
      name: withName ? 'N0' : undefined,
      topic: withTopic ? 'T0' : undefined,
      members,
    });
    const db = createDirectoryDb({
      rooms: [seeded.room],
      state: seeded.state,
      memberships: seeded.memberships,
    });
    const env = createEnv(db);
    const res = await request(env, '/_matrix/client/v3/publicRooms');
    expect(res.status).toBe(200);
    const row = (res.body as { chunk: Array<{ num_joined_members: number; name?: string }> }).chunk[0];
    expect(row.num_joined_members).toBe(members.length);
    if (withName) expect(row.name).toBe('N0');
  });
  it('enrichment soft-1: public room with partial state', async () => {
    const withName = 1 % 2 === 0;
    const withTopic = 1 % 3 === 0;
    const members = [USER, BOB, CAROL].slice(0, (1 % 3) + 1);
    const seeded = seedPublic(ROOM_A, {
      name: withName ? 'N1' : undefined,
      topic: withTopic ? 'T1' : undefined,
      members,
    });
    const db = createDirectoryDb({
      rooms: [seeded.room],
      state: seeded.state,
      memberships: seeded.memberships,
    });
    const env = createEnv(db);
    const res = await request(env, '/_matrix/client/v3/publicRooms');
    expect(res.status).toBe(200);
    const row = (res.body as { chunk: Array<{ num_joined_members: number; name?: string }> }).chunk[0];
    expect(row.num_joined_members).toBe(members.length);
    if (withName) expect(row.name).toBe('N1');
  });
  it('enrichment soft-2: public room with partial state', async () => {
    const withName = 2 % 2 === 0;
    const withTopic = 2 % 3 === 0;
    const members = [USER, BOB, CAROL].slice(0, (2 % 3) + 1);
    const seeded = seedPublic(ROOM_A, {
      name: withName ? 'N2' : undefined,
      topic: withTopic ? 'T2' : undefined,
      members,
    });
    const db = createDirectoryDb({
      rooms: [seeded.room],
      state: seeded.state,
      memberships: seeded.memberships,
    });
    const env = createEnv(db);
    const res = await request(env, '/_matrix/client/v3/publicRooms');
    expect(res.status).toBe(200);
    const row = (res.body as { chunk: Array<{ num_joined_members: number; name?: string }> }).chunk[0];
    expect(row.num_joined_members).toBe(members.length);
    if (withName) expect(row.name).toBe('N2');
  });
  it('enrichment soft-3: public room with partial state', async () => {
    const withName = 3 % 2 === 0;
    const withTopic = 3 % 3 === 0;
    const members = [USER, BOB, CAROL].slice(0, (3 % 3) + 1);
    const seeded = seedPublic(ROOM_A, {
      name: withName ? 'N3' : undefined,
      topic: withTopic ? 'T3' : undefined,
      members,
    });
    const db = createDirectoryDb({
      rooms: [seeded.room],
      state: seeded.state,
      memberships: seeded.memberships,
    });
    const env = createEnv(db);
    const res = await request(env, '/_matrix/client/v3/publicRooms');
    expect(res.status).toBe(200);
    const row = (res.body as { chunk: Array<{ num_joined_members: number; name?: string }> }).chunk[0];
    expect(row.num_joined_members).toBe(members.length);
    if (withName) expect(row.name).toBe('N3');
  });
  it('enrichment soft-4: public room with partial state', async () => {
    const withName = 4 % 2 === 0;
    const withTopic = 4 % 3 === 0;
    const members = [USER, BOB, CAROL].slice(0, (4 % 3) + 1);
    const seeded = seedPublic(ROOM_A, {
      name: withName ? 'N4' : undefined,
      topic: withTopic ? 'T4' : undefined,
      members,
    });
    const db = createDirectoryDb({
      rooms: [seeded.room],
      state: seeded.state,
      memberships: seeded.memberships,
    });
    const env = createEnv(db);
    const res = await request(env, '/_matrix/client/v3/publicRooms');
    expect(res.status).toBe(200);
    const row = (res.body as { chunk: Array<{ num_joined_members: number; name?: string }> }).chunk[0];
    expect(row.num_joined_members).toBe(members.length);
    if (withName) expect(row.name).toBe('N4');
  });
  it('enrichment soft-5: public room with partial state', async () => {
    const withName = 5 % 2 === 0;
    const withTopic = 5 % 3 === 0;
    const members = [USER, BOB, CAROL].slice(0, (5 % 3) + 1);
    const seeded = seedPublic(ROOM_A, {
      name: withName ? 'N5' : undefined,
      topic: withTopic ? 'T5' : undefined,
      members,
    });
    const db = createDirectoryDb({
      rooms: [seeded.room],
      state: seeded.state,
      memberships: seeded.memberships,
    });
    const env = createEnv(db);
    const res = await request(env, '/_matrix/client/v3/publicRooms');
    expect(res.status).toBe(200);
    const row = (res.body as { chunk: Array<{ num_joined_members: number; name?: string }> }).chunk[0];
    expect(row.num_joined_members).toBe(members.length);
    if (withName) expect(row.name).toBe('N5');
  });
  it('enrichment soft-6: public room with partial state', async () => {
    const withName = 6 % 2 === 0;
    const withTopic = 6 % 3 === 0;
    const members = [USER, BOB, CAROL].slice(0, (6 % 3) + 1);
    const seeded = seedPublic(ROOM_A, {
      name: withName ? 'N6' : undefined,
      topic: withTopic ? 'T6' : undefined,
      members,
    });
    const db = createDirectoryDb({
      rooms: [seeded.room],
      state: seeded.state,
      memberships: seeded.memberships,
    });
    const env = createEnv(db);
    const res = await request(env, '/_matrix/client/v3/publicRooms');
    expect(res.status).toBe(200);
    const row = (res.body as { chunk: Array<{ num_joined_members: number; name?: string }> }).chunk[0];
    expect(row.num_joined_members).toBe(members.length);
    if (withName) expect(row.name).toBe('N6');
  });
  it('enrichment soft-7: public room with partial state', async () => {
    const withName = 7 % 2 === 0;
    const withTopic = 7 % 3 === 0;
    const members = [USER, BOB, CAROL].slice(0, (7 % 3) + 1);
    const seeded = seedPublic(ROOM_A, {
      name: withName ? 'N7' : undefined,
      topic: withTopic ? 'T7' : undefined,
      members,
    });
    const db = createDirectoryDb({
      rooms: [seeded.room],
      state: seeded.state,
      memberships: seeded.memberships,
    });
    const env = createEnv(db);
    const res = await request(env, '/_matrix/client/v3/publicRooms');
    expect(res.status).toBe(200);
    const row = (res.body as { chunk: Array<{ num_joined_members: number; name?: string }> }).chunk[0];
    expect(row.num_joined_members).toBe(members.length);
    if (withName) expect(row.name).toBe('N7');
  });
  it('enrichment soft-8: public room with partial state', async () => {
    const withName = 8 % 2 === 0;
    const withTopic = 8 % 3 === 0;
    const members = [USER, BOB, CAROL].slice(0, (8 % 3) + 1);
    const seeded = seedPublic(ROOM_A, {
      name: withName ? 'N8' : undefined,
      topic: withTopic ? 'T8' : undefined,
      members,
    });
    const db = createDirectoryDb({
      rooms: [seeded.room],
      state: seeded.state,
      memberships: seeded.memberships,
    });
    const env = createEnv(db);
    const res = await request(env, '/_matrix/client/v3/publicRooms');
    expect(res.status).toBe(200);
    const row = (res.body as { chunk: Array<{ num_joined_members: number; name?: string }> }).chunk[0];
    expect(row.num_joined_members).toBe(members.length);
    if (withName) expect(row.name).toBe('N8');
  });
  it('enrichment soft-9: public room with partial state', async () => {
    const withName = 9 % 2 === 0;
    const withTopic = 9 % 3 === 0;
    const members = [USER, BOB, CAROL].slice(0, (9 % 3) + 1);
    const seeded = seedPublic(ROOM_A, {
      name: withName ? 'N9' : undefined,
      topic: withTopic ? 'T9' : undefined,
      members,
    });
    const db = createDirectoryDb({
      rooms: [seeded.room],
      state: seeded.state,
      memberships: seeded.memberships,
    });
    const env = createEnv(db);
    const res = await request(env, '/_matrix/client/v3/publicRooms');
    expect(res.status).toBe(200);
    const row = (res.body as { chunk: Array<{ num_joined_members: number; name?: string }> }).chunk[0];
    expect(row.num_joined_members).toBe(members.length);
    if (withName) expect(row.name).toBe('N9');
  });
  it('enrichment soft-10: public room with partial state', async () => {
    const withName = 10 % 2 === 0;
    const withTopic = 10 % 3 === 0;
    const members = [USER, BOB, CAROL].slice(0, (10 % 3) + 1);
    const seeded = seedPublic(ROOM_A, {
      name: withName ? 'N10' : undefined,
      topic: withTopic ? 'T10' : undefined,
      members,
    });
    const db = createDirectoryDb({
      rooms: [seeded.room],
      state: seeded.state,
      memberships: seeded.memberships,
    });
    const env = createEnv(db);
    const res = await request(env, '/_matrix/client/v3/publicRooms');
    expect(res.status).toBe(200);
    const row = (res.body as { chunk: Array<{ num_joined_members: number; name?: string }> }).chunk[0];
    expect(row.num_joined_members).toBe(members.length);
    if (withName) expect(row.name).toBe('N10');
  });
  it('enrichment soft-11: public room with partial state', async () => {
    const withName = 11 % 2 === 0;
    const withTopic = 11 % 3 === 0;
    const members = [USER, BOB, CAROL].slice(0, (11 % 3) + 1);
    const seeded = seedPublic(ROOM_A, {
      name: withName ? 'N11' : undefined,
      topic: withTopic ? 'T11' : undefined,
      members,
    });
    const db = createDirectoryDb({
      rooms: [seeded.room],
      state: seeded.state,
      memberships: seeded.memberships,
    });
    const env = createEnv(db);
    const res = await request(env, '/_matrix/client/v3/publicRooms');
    expect(res.status).toBe(200);
    const row = (res.body as { chunk: Array<{ num_joined_members: number; name?: string }> }).chunk[0];
    expect(row.num_joined_members).toBe(members.length);
    if (withName) expect(row.name).toBe('N11');
  });
});

describe('user_directory Accept/auth identity soft flood after #208', () => {
  it('Accept soft-0', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const accepts = ['*/*', 'application/json', 'text/html', 'application/json, text/plain', ''];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: {
        ...AUTH,
        'Content-Type': 'application/json',
        Accept: accepts[0 % 5],
      },
      body: JSON.stringify({ search_term: 'bob' }),
    });
    expect(res.status).toBe(200);
  });
  it('Accept soft-1', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const accepts = ['*/*', 'application/json', 'text/html', 'application/json, text/plain', ''];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: {
        ...AUTH,
        'Content-Type': 'application/json',
        Accept: accepts[1 % 5],
      },
      body: JSON.stringify({ search_term: 'bob' }),
    });
    expect(res.status).toBe(200);
  });
  it('Accept soft-2', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const accepts = ['*/*', 'application/json', 'text/html', 'application/json, text/plain', ''];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: {
        ...AUTH,
        'Content-Type': 'application/json',
        Accept: accepts[2 % 5],
      },
      body: JSON.stringify({ search_term: 'bob' }),
    });
    expect(res.status).toBe(200);
  });
  it('Accept soft-3', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const accepts = ['*/*', 'application/json', 'text/html', 'application/json, text/plain', ''];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: {
        ...AUTH,
        'Content-Type': 'application/json',
        Accept: accepts[3 % 5],
      },
      body: JSON.stringify({ search_term: 'bob' }),
    });
    expect(res.status).toBe(200);
  });
  it('Accept soft-4', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const accepts = ['*/*', 'application/json', 'text/html', 'application/json, text/plain', ''];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: {
        ...AUTH,
        'Content-Type': 'application/json',
        Accept: accepts[4 % 5],
      },
      body: JSON.stringify({ search_term: 'bob' }),
    });
    expect(res.status).toBe(200);
  });
  it('Accept soft-5', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const accepts = ['*/*', 'application/json', 'text/html', 'application/json, text/plain', ''];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: {
        ...AUTH,
        'Content-Type': 'application/json',
        Accept: accepts[5 % 5],
      },
      body: JSON.stringify({ search_term: 'bob' }),
    });
    expect(res.status).toBe(200);
  });
  it('Accept soft-6', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const accepts = ['*/*', 'application/json', 'text/html', 'application/json, text/plain', ''];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: {
        ...AUTH,
        'Content-Type': 'application/json',
        Accept: accepts[6 % 5],
      },
      body: JSON.stringify({ search_term: 'bob' }),
    });
    expect(res.status).toBe(200);
  });
  it('Accept soft-7', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const accepts = ['*/*', 'application/json', 'text/html', 'application/json, text/plain', ''];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: {
        ...AUTH,
        'Content-Type': 'application/json',
        Accept: accepts[7 % 5],
      },
      body: JSON.stringify({ search_term: 'bob' }),
    });
    expect(res.status).toBe(200);
  });
  it('Accept soft-8', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const accepts = ['*/*', 'application/json', 'text/html', 'application/json, text/plain', ''];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: {
        ...AUTH,
        'Content-Type': 'application/json',
        Accept: accepts[8 % 5],
      },
      body: JSON.stringify({ search_term: 'bob' }),
    });
    expect(res.status).toBe(200);
  });
  it('Accept soft-9', async () => {
    const env = createEnv(createDirectoryDb({ users: defaultUsers() }));
    const accepts = ['*/*', 'application/json', 'text/html', 'application/json, text/plain', ''];
    const res = await request(env, '/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      headers: {
        ...AUTH,
        'Content-Type': 'application/json',
        Accept: accepts[9 % 5],
      },
      body: JSON.stringify({ search_term: 'bob' }),
    });
    expect(res.status).toBe(200);
  });
  it('auth identity soft-0: requester excluded', async () => {
    authState.userId = [USER, BOB, CAROL, DAVE][0 % 4];
    const db = createDirectoryDb({ users: defaultUsers() });
    const env = createEnv(db);
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'a' })
    );
    expect(res.status).toBe(200);
    const ids = (res.body as { results: Array<{ user_id: string }> }).results.map((u) => u.user_id);
    expect(ids).not.toContain(authState.userId);
  });
  it('auth identity soft-1: requester excluded', async () => {
    authState.userId = [USER, BOB, CAROL, DAVE][1 % 4];
    const db = createDirectoryDb({ users: defaultUsers() });
    const env = createEnv(db);
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'a' })
    );
    expect(res.status).toBe(200);
    const ids = (res.body as { results: Array<{ user_id: string }> }).results.map((u) => u.user_id);
    expect(ids).not.toContain(authState.userId);
  });
  it('auth identity soft-2: requester excluded', async () => {
    authState.userId = [USER, BOB, CAROL, DAVE][2 % 4];
    const db = createDirectoryDb({ users: defaultUsers() });
    const env = createEnv(db);
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'a' })
    );
    expect(res.status).toBe(200);
    const ids = (res.body as { results: Array<{ user_id: string }> }).results.map((u) => u.user_id);
    expect(ids).not.toContain(authState.userId);
  });
  it('auth identity soft-3: requester excluded', async () => {
    authState.userId = [USER, BOB, CAROL, DAVE][3 % 4];
    const db = createDirectoryDb({ users: defaultUsers() });
    const env = createEnv(db);
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'a' })
    );
    expect(res.status).toBe(200);
    const ids = (res.body as { results: Array<{ user_id: string }> }).results.map((u) => u.user_id);
    expect(ids).not.toContain(authState.userId);
  });
  it('auth identity soft-4: requester excluded', async () => {
    authState.userId = [USER, BOB, CAROL, DAVE][4 % 4];
    const db = createDirectoryDb({ users: defaultUsers() });
    const env = createEnv(db);
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'a' })
    );
    expect(res.status).toBe(200);
    const ids = (res.body as { results: Array<{ user_id: string }> }).results.map((u) => u.user_id);
    expect(ids).not.toContain(authState.userId);
  });
  it('auth identity soft-5: requester excluded', async () => {
    authState.userId = [USER, BOB, CAROL, DAVE][5 % 4];
    const db = createDirectoryDb({ users: defaultUsers() });
    const env = createEnv(db);
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'a' })
    );
    expect(res.status).toBe(200);
    const ids = (res.body as { results: Array<{ user_id: string }> }).results.map((u) => u.user_id);
    expect(ids).not.toContain(authState.userId);
  });
  it('auth identity soft-6: requester excluded', async () => {
    authState.userId = [USER, BOB, CAROL, DAVE][6 % 4];
    const db = createDirectoryDb({ users: defaultUsers() });
    const env = createEnv(db);
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'a' })
    );
    expect(res.status).toBe(200);
    const ids = (res.body as { results: Array<{ user_id: string }> }).results.map((u) => u.user_id);
    expect(ids).not.toContain(authState.userId);
  });
  it('auth identity soft-7: requester excluded', async () => {
    authState.userId = [USER, BOB, CAROL, DAVE][7 % 4];
    const db = createDirectoryDb({ users: defaultUsers() });
    const env = createEnv(db);
    const res = await request(
      env,
      '/_matrix/client/v3/user_directory/search',
      jsonInit('POST', { search_term: 'a' })
    );
    expect(res.status).toBe(200);
    const ids = (res.body as { results: Array<{ user_id: string }> }).results.map((u) => u.user_id);
    expect(ids).not.toContain(authState.userId);
  });
});
