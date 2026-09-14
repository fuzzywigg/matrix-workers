/**
 * TOKENMAXX HEAVY leftovers after #204 — typing *concurrent race / TOCTOU*
 * + soft/edge reliability for slices not covered by typing-api-routes,
 * typing-api-route-leftovers soft start/stop races (#185), or
 * presence-typing / presence-receipts-typing-todevice leftovers.
 *
 * Distinct domain — not presence (#204), sync (#202), voip/rtc/calls (#201),
 * report/server-notices (#200), search/spaces (#199), profile (#198/#197),
 * tags (#196), workflows (#195), rooms-mutate (#194), aliases (#193),
 * rooms (#192), admin-mutate (#191). Complements #185 concurrent PUT soft
 * races which lacked membership SELECT→Room-DO PUT barriers, DO PUT
 * barriers, getTypingUsers∥PUT coherency, and leave-flip TOCTOU.
 *
 * Focus: membership SELECT→DO PUT TOCTOU; Room DO PUT barriers;
 * start∥stop last-write; getTypingUsers/getTypingForRooms∥PUT;
 * DO/D1 failure soft; method/body/foreign/timeout/charset soft floods;
 * SQL/DO bind contracts under parallel.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { getTypingUsers, getTypingForRooms } from '../src/api/typing';

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

import typingApp from '../src/api/typing';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const DAVE = '@dave:example.com';
const ROOM = '!r:example.com';
const ROOM2 = '!r2:example.com';
const ROOM3 = '!r3:example.com';
const ROOM4 = '!r4:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const ROOM2_ENC = encodeURIComponent(ROOM2);
const ROOM3_ENC = encodeURIComponent(ROOM3);
const USER_ENC = encodeURIComponent(USER);
const BOB_ENC = encodeURIComponent(BOB);
const CAROL_ENC = encodeURIComponent(CAROL);
const AUTH = { Authorization: 'Bearer test-token' };

type Membership = { room_id: string; user_id: string; membership: string };
type SqlCall = { sql: string; args: unknown[] };
type RoomFetch = { url: string; method: string; body?: unknown; order: number };
type SelectBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };
type DoPutBarrier = { count: number };
type DoGetBarrier = { count: number };

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

function createRoomDOStub(opts: {
  fetchBarrier?: DoPutBarrier;
  getBarrier?: DoGetBarrier;
  throwOnPut?: boolean;
  throwOnGet?: boolean;
  delayMs?: number;
  typingUsers?: string[];
  mutateTypingAfterPuts?: { after: number; next: string[] };
} = {}) {
  const fetches: RoomFetch[] = [];
  let order = 0;
  let putBarrier = opts.fetchBarrier;
  let getBarrier = opts.getBarrier;
  const putWaiters = { list: [] as Array<() => void> };
  const getWaiters = { list: [] as Array<() => void> };
  let typingUsers = [...(opts.typingUsers ?? [])];
  let putCount = 0;
  const mutate = opts.mutateTypingAfterPuts;

  return {
    fetches,
    get typingUsers() {
      return typingUsers;
    },
    setTypingUsers(next: string[]) {
      typingUsers = [...next];
    },
    async fetch(req: Request): Promise<Response> {
      let body: unknown;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        try {
          body = await req.json();
        } catch {
          body = undefined;
        }
      }
      const url = req.url;
      const method = req.method;

      if (method === 'PUT' && putBarrier) {
        await new Promise<void>((resolve) => {
          putWaiters.list.push(resolve);
          if (putWaiters.list.length >= putBarrier!.count) {
            const all = [...putWaiters.list];
            putWaiters.list = [];
            putBarrier = undefined;
            for (const r of all) r();
          }
        });
      }
      if (method === 'GET' && getBarrier) {
        await new Promise<void>((resolve) => {
          getWaiters.list.push(resolve);
          if (getWaiters.list.length >= getBarrier!.count) {
            const all = [...getWaiters.list];
            getWaiters.list = [];
            getBarrier = undefined;
            for (const r of all) r();
          }
        });
      }
      if (opts.delayMs) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }

      fetches.push({ url, method, body, order: ++order });

      if (opts.throwOnPut && method === 'PUT') {
        throw new Error('room-do-put-fail');
      }
      if (opts.throwOnGet && method === 'GET') {
        throw new Error('room-do-get-fail');
      }

      if (method === 'PUT' && url.includes('/typing')) {
        putCount += 1;
        const b = body as { user_id?: string; typing?: boolean } | undefined;
        if (b?.user_id && typeof b.typing === 'boolean') {
          if (b.typing) {
            if (!typingUsers.includes(b.user_id)) typingUsers.push(b.user_id);
          } else {
            typingUsers = typingUsers.filter((u) => u !== b.user_id);
          }
        }
        if (mutate && putCount === mutate.after) {
          typingUsers = [...mutate.next];
        }
        return Response.json({ ok: true });
      }
      if (method === 'GET' && url.includes('/typing')) {
        return Response.json({ user_ids: [...typingUsers] });
      }
      return Response.json({ ok: true });
    },
  };
}

type RoomDOStub = ReturnType<typeof createRoomDOStub>;

function createTypingDb(
  opts: {
    memberships?: Membership[];
    selectBarrier?: SelectBarrier;
    mutateMembershipAfterSelects?: {
      after: number;
      next: Membership[];
    };
    failSelectAfter?: number;
    failSelect?: boolean;
  } = {}
) {
  const memberships = [...(opts.memberships ?? [])];
  const selects: SqlCall[] = [];
  const events: string[] = [];
  let selectBarrier = opts.selectBarrier;
  const selectWaiters = { list: [] as Array<() => void> };
  let membershipSelectCount = 0;
  const mutate = opts.mutateMembershipAfterSelects;
  const failSelectAfter = opts.failSelectAfter;

  const db = {
    memberships,
    selects,
    events,
    failSelect: opts.failSelect ?? false,
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

              if (db.failSelect) throw new Error('d1-select-fail');
              if (sql.includes('FROM room_memberships')) {
                const [roomId, userId] = args as string[];
                const snapshot = memberships.find(
                  (m) => m.room_id === roomId && m.user_id === userId
                );
                membershipSelectCount += 1;
                if (
                  failSelectAfter !== undefined &&
                  membershipSelectCount > failSelectAfter
                ) {
                  throw new Error('d1-select-fail-after');
                }
                if (mutate && membershipSelectCount === mutate.after) {
                  memberships.splice(0, memberships.length, ...mutate.next);
                  events.push('mutate:membership');
                }
                return (snapshot ? { membership: snapshot.membership } : null) as T;
              }
              throw new Error('Unhandled first() SQL: ' + sql.slice(0, 140));
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              throw new Error('Unexpected run() SQL: ' + sql.slice(0, 140));
            },
          };
        },
      };
    },
  };

  return db;
}

type TypingDb = ReturnType<typeof createTypingDb>;

function createEnv(opts: {
  db?: TypingDb;
  roomDO?: RoomDOStub;
  roomById?: Record<string, RoomDOStub>;
} = {}) {
  const db = opts.db ?? createTypingDb();
  const defaultDO = opts.roomDO ?? createRoomDOStub();
  const roomById = opts.roomById ?? {};
  const idCalls: string[] = [];

  const env = {
    DB: db as unknown as D1Database,
    SERVER_NAME: 'example.com',
    ROOMS: {
      idFromName: (name: string) => {
        idCalls.push(name);
        return { name, toString: () => name };
      },
      get: (id: { name: string }) => roomById[id.name] ?? defaultDO,
    },
    _db: db,
    _roomDO: defaultDO,
    _idCalls: idCalls,
  };

  return env as unknown as Env & typeof env;
}

async function request(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown; errcode?: string }> {
  const res = await typingApp.request('http://localhost' + path, init, env);
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
  return { status: res.status, body, errcode };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...AUTH,
    },
    body:
      body === undefined
        ? undefined
        : typeof body === 'string'
          ? body
          : JSON.stringify(body),
  };
}

function joinDb(extra?: Partial<Parameters<typeof createTypingDb>[0]>) {
  return createTypingDb({
    memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    ...extra,
  });
}

function joinMultiDb(
  rooms: string[],
  extra?: Partial<Parameters<typeof createTypingDb>[0]>
) {
  return createTypingDb({
    memberships: rooms.map((room_id) => ({
      room_id,
      user_id: USER,
      membership: 'join',
    })),
    ...extra,
  });
}

function typingPath(userIdEnc = USER_ENC, roomEnc = ROOM_ENC) {
  return '/_matrix/client/v3/rooms/' + roomEnc + '/typing/' + userIdEnc;
}

function statusesOf(results: Array<{ status: number }>) {
  return results.map((r) => r.status);
}

function mockRoomsNamespace(
  byRoom: Record<
    string,
    | { kind: 'typing'; user_ids: string[] }
    | { kind: 'throw'; error: Error }
    | { kind: 'http'; status: number; body: unknown }
    | {
        kind: 'barrier';
        user_ids: string[];
        count: number;
        waiters?: { list: Array<() => void> };
      }
    | { kind: 'delay'; user_ids: string[]; ms: number }
  >
) {
  return {
    idFromName(roomId: string) {
      return { name: roomId };
    },
    get(id: { name: string }) {
      const roomId = id.name;
      return {
        async fetch(request: Request) {
          const entry = byRoom[roomId];
          if (!entry) {
            return new Response(JSON.stringify({ user_ids: [] }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }
          if (entry.kind === 'throw') throw entry.error;
          if (entry.kind === 'http') {
            return new Response(JSON.stringify(entry.body), {
              status: entry.status,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          if (entry.kind === 'delay') {
            await new Promise((r) => setTimeout(r, entry.ms));
            return new Response(JSON.stringify({ user_ids: entry.user_ids }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }
          if (entry.kind === 'barrier') {
            const waiters = entry.waiters ?? (entry.waiters = { list: [] });
            await new Promise<void>((resolve) => {
              waiters.list.push(resolve);
              if (waiters.list.length >= entry.count) {
                const all = [...waiters.list];
                waiters.list = [];
                for (const r of all) r();
              }
            });
            return new Response(JSON.stringify({ user_ids: entry.user_ids }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }
          const url = new URL(request.url);
          if (url.pathname.endsWith('/typing')) {
            return new Response(JSON.stringify({ user_ids: entry.user_ids }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response(JSON.stringify({ user_ids: [] }), {
            headers: { 'Content-Type': 'application/json' },
          });
        },
      };
    },
  };
}

function envWithRooms(byRoom: Parameters<typeof mockRoomsNamespace>[0]): Env {
  return { ROOMS: mockRoomsNamespace(byRoom) } as unknown as Env;
}

beforeEach(() => {
  authState.userId = USER;
  authState.deviceId = 'DEVICEA';
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Membership SELECT → Room DO PUT TOCTOU
// ---------------------------------------------------------------------------

describe('race typing membership SELECT→DO PUT TOCTOU after #204', () => {
  it('both parallel starts see join at SELECT; both land on Room DO', async () => {
    const db = joinDb({
      selectBarrier: {
        match: (sql) => sql.includes('FROM room_memberships'),
        count: 2,
      },
    });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });

    const results = await Promise.all([
      request(env, typingPath(), jsonInit('PUT', { typing: true, timeout: 1111 })),
      request(env, typingPath(), jsonInit('PUT', { typing: true, timeout: 2222 })),
    ]);

    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.selects).toHaveLength(2);
    expect(roomDO.fetches).toHaveLength(2);
    expect(
      roomDO.fetches.every(
        (f) => f.method === 'PUT' && (f.body as { typing: boolean }).typing === true
      )
    ).toBe(true);
  });

  it('membership flips leave after first SELECT; second forbids before DO', async () => {
    const db = joinDb({
      selectBarrier: {
        match: (sql) => sql.includes('FROM room_memberships'),
        count: 2,
      },
      mutateMembershipAfterSelects: {
        after: 1,
        next: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      },
    });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });

    const results = await Promise.all([
      request(env, typingPath(), jsonInit('PUT', { typing: true, timeout: 5000 })),
      request(env, typingPath(), jsonInit('PUT', { typing: true, timeout: 6000 })),
    ]);

    const oks = results.filter((r) => r.status === 200);
    const forbids = results.filter((r) => r.status === 403);
    expect(oks).toHaveLength(1);
    expect(forbids).toHaveLength(1);
    expect(forbids[0].errcode).toBe('M_FORBIDDEN');
    expect(roomDO.fetches).toHaveLength(1);
    expect(db.events).toContain('mutate:membership');
  });

  it('post-mutate sequential request is forbidden after leave flip', async () => {
    const db = joinDb({
      mutateMembershipAfterSelects: {
        after: 1,
        next: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      },
    });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });

    const first = await request(
      env,
      typingPath(),
      jsonInit('PUT', { typing: true, timeout: 3000 })
    );
    expect(first.status).toBe(200);
    expect(roomDO.fetches).toHaveLength(1);

    const second = await request(
      env,
      typingPath(),
      jsonInit('PUT', { typing: false })
    );
    expect(second.status).toBe(403);
    expect(roomDO.fetches).toHaveLength(1);
  });

  for (let i = 0; i < 12; i++) {
    it(`SELECT barrier soft-${i}: N parallel starts all join`, async () => {
      const n = 2 + (i % 3);
      const db = joinDb({
        selectBarrier: {
          match: (sql) => sql.includes('FROM room_memberships'),
          count: n,
        },
      });
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const results = await Promise.all(
        Array.from({ length: n }, (_, j) =>
          request(
            env,
            typingPath(),
            jsonInit('PUT', { typing: true, timeout: 1000 + j + i })
          )
        )
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(db.selects).toHaveLength(n);
      expect(roomDO.fetches).toHaveLength(n);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`leave-flip soft-${i}: invite/knock/leave/ban forbid second`, async () => {
      const nextMembership = (['leave', 'ban', 'invite', 'knock'] as const)[i % 4];
      const db = joinDb({
        selectBarrier: {
          match: (sql) => sql.includes('FROM room_memberships'),
          count: 2,
        },
        mutateMembershipAfterSelects: {
          after: 1,
          next: [{ room_id: ROOM, user_id: USER, membership: nextMembership }],
        },
      });
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const results = await Promise.all([
        request(env, typingPath(), jsonInit('PUT', { typing: true })),
        request(env, typingPath(), jsonInit('PUT', { typing: true })),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 403)).toHaveLength(1);
      expect(roomDO.fetches).toHaveLength(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Room DO PUT barriers + start∥stop last-write
// ---------------------------------------------------------------------------

describe('race typing Room DO PUT barriers after #204', () => {
  it('parallel starts wait on DO PUT barrier then both land', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub({ fetchBarrier: { count: 2 } });
    const env = createEnv({ db, roomDO });

    const results = await Promise.all([
      request(env, typingPath(), jsonInit('PUT', { typing: true, timeout: 4000 })),
      request(env, typingPath(), jsonInit('PUT', { typing: true, timeout: 5000 })),
    ]);

    expect(statusesOf(results)).toEqual([200, 200]);
    expect(roomDO.fetches).toHaveLength(2);
    expect(roomDO.typingUsers).toContain(USER);
  });

  it('start∥stop race — both DO PUTs land; stop may clear typing set', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub({ fetchBarrier: { count: 2 } });
    const env = createEnv({ db, roomDO });

    const results = await Promise.all([
      request(env, typingPath(), jsonInit('PUT', { typing: true, timeout: 8000 })),
      request(env, typingPath(), jsonInit('PUT', { typing: false })),
    ]);

    expect(statusesOf(results)).toEqual([200, 200]);
    expect(roomDO.fetches).toHaveLength(2);
    const typings = roomDO.fetches.map((f) => (f.body as { typing: boolean }).typing);
    expect(typings.sort()).toEqual([false, true]);
  });

  it('DO throw on PUT surfaces as non-200', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub({ throwOnPut: true });
    const env = createEnv({ db, roomDO });
    const res = await request(
      env,
      typingPath(),
      jsonInit('PUT', { typing: true, timeout: 2000 })
    );
    expect(res.status).not.toBe(200);
    expect(roomDO.fetches).toHaveLength(1);
  });

  it('parallel DO throw — both fail without partial success confusion', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub({ throwOnPut: true, fetchBarrier: { count: 2 } });
    const env = createEnv({ db, roomDO });
    const results = await Promise.all([
      request(env, typingPath(), jsonInit('PUT', { typing: true })),
      request(env, typingPath(), jsonInit('PUT', { typing: false })),
    ]);
    expect(results.every((r) => r.status !== 200)).toBe(true);
    expect(roomDO.fetches).toHaveLength(2);
  });

  for (let i = 0; i < 10; i++) {
    it(`DO barrier soft-${i}: start∥refresh both succeed`, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub({ fetchBarrier: { count: 2 } });
      const env = createEnv({ db, roomDO });
      const results = await Promise.all([
        request(
          env,
          typingPath(),
          jsonInit('PUT', { typing: true, timeout: 3000 + i })
        ),
        request(
          env,
          typingPath(),
          jsonInit('PUT', { typing: true, timeout: 4000 + i })
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(roomDO.fetches).toHaveLength(2);
      expect(
        roomDO.fetches.map((f) => (f.body as { timeout: number }).timeout).sort()
      ).toEqual([3000 + i, 4000 + i].sort());
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`stop-default-timeout soft-${i}: stop ignores body timeout`, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const res = await request(
        env,
        typingPath(),
        jsonInit('PUT', { typing: false, timeout: 99999 })
      );
      expect(res.status).toBe(200);
      expect(roomDO.fetches[0].body).toEqual({
        user_id: USER,
        typing: false,
        timeout: 30000,
      });
    });
  }
});

// ---------------------------------------------------------------------------
// getTypingUsers ∥ PUT coherency
// ---------------------------------------------------------------------------

describe('race getTypingUsers∥PUT coherency after #204', () => {
  it('GET mid PUT barrier still returns pre-put typing set', async () => {
    const roomDO = createRoomDOStub({
      typingUsers: [BOB],
      fetchBarrier: { count: 2 },
    });
    const db = joinDb();
    const env = createEnv({ db, roomDO });

    const put1 = request(
      env,
      typingPath(),
      jsonInit('PUT', { typing: true, timeout: 7000 })
    );

    // Wait until first PUT is parked on the DO PUT barrier (not yet recorded).
    await new Promise((r) => setTimeout(r, 5));

    const mid = await getTypingUsers(env, ROOM);
    expect(mid).toEqual([BOB]);
    expect(roomDO.fetches.filter((f) => f.method === 'PUT')).toHaveLength(0);

    const put2 = request(
      env,
      typingPath(),
      jsonInit('PUT', { typing: true, timeout: 8000 })
    );
    const [a, b] = await Promise.all([put1, put2]);
    expect(statusesOf([a, b])).toEqual([200, 200]);
    expect(roomDO.fetches.filter((f) => f.method === 'PUT')).toHaveLength(2);
    expect(roomDO.typingUsers).toEqual(expect.arrayContaining([BOB, USER]));
  });

  it('dual getTypingUsers barrier returns same snapshot', async () => {
    const env = envWithRooms({
      [ROOM]: {
        kind: 'barrier',
        user_ids: [USER, BOB],
        count: 2,
      },
    });
    const [a, b] = await Promise.all([
      getTypingUsers(env, ROOM),
      getTypingUsers(env, ROOM),
    ]);
    expect(a).toEqual([USER, BOB]);
    expect(b).toEqual([USER, BOB]);
  });

  it('getTypingUsers∥HTTP PUT — helper sees DO typing after put completes', async () => {
    const roomDO = createRoomDOStub({ typingUsers: [] });
    const db = joinDb();
    const env = createEnv({ db, roomDO });

    const put = await request(
      env,
      typingPath(),
      jsonInit('PUT', { typing: true, timeout: 4500 })
    );
    expect(put.status).toBe(200);
    const users = await getTypingUsers(env, ROOM);
    expect(users).toContain(USER);
  });

  it('parallel getTypingUsers same room — identical lists', async () => {
    const env = envWithRooms({
      [ROOM]: { kind: 'typing', user_ids: [USER, CAROL] },
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => getTypingUsers(env, ROOM))
    );
    expect(results.every((r) => JSON.stringify(r) === JSON.stringify([USER, CAROL]))).toBe(
      true
    );
  });

  it('getTypingForRooms isolates throw in one room', async () => {
    const env = envWithRooms({
      [ROOM]: { kind: 'typing', user_ids: [USER] },
      [ROOM2]: { kind: 'throw', error: new Error('do-boom') },
      [ROOM3]: { kind: 'typing', user_ids: [BOB, CAROL] },
    });
    const byRoom = await getTypingForRooms(env, [ROOM, ROOM2, ROOM3]);
    expect(byRoom[ROOM]).toEqual([USER]);
    expect(byRoom[ROOM2]).toBeUndefined();
    expect(byRoom[ROOM3]).toEqual([BOB, CAROL]);
  });

  it('parallel getTypingForRooms calls remain isolated', async () => {
    const env = envWithRooms({
      [ROOM]: { kind: 'typing', user_ids: [USER] },
      [ROOM2]: { kind: 'typing', user_ids: [BOB] },
    });
    const [a, b] = await Promise.all([
      getTypingForRooms(env, [ROOM]),
      getTypingForRooms(env, [ROOM2]),
    ]);
    expect(a).toEqual({ [ROOM]: [USER] });
    expect(b).toEqual({ [ROOM2]: [BOB] });
  });

  for (let i = 0; i < 10; i++) {
    it(`helper soft-${i}: empty rooms omitted from getTypingForRooms`, async () => {
      const env = envWithRooms({
        [ROOM]: { kind: 'typing', user_ids: i % 2 === 0 ? [USER] : [] },
        [ROOM2]: { kind: 'typing', user_ids: [] },
      });
      const byRoom = await getTypingForRooms(env, [ROOM, ROOM2]);
      if (i % 2 === 0) {
        expect(byRoom).toEqual({ [ROOM]: [USER] });
      } else {
        expect(byRoom).toEqual({});
      }
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`get barrier soft-${i}: dual GET same snapshot`, async () => {
      const ids = [`@u${i}:example.com`, BOB];
      const env = envWithRooms({
        [ROOM]: { kind: 'barrier', user_ids: ids, count: 2 },
      });
      const [a, b] = await Promise.all([
        getTypingUsers(env, ROOM),
        getTypingUsers(env, ROOM),
      ]);
      expect(a).toEqual(ids);
      expect(b).toEqual(ids);
    });
  }
});

// ---------------------------------------------------------------------------
// Multi-room HTTP isolation
// ---------------------------------------------------------------------------

describe('race multi-room typing HTTP isolation after #204', () => {
  it('parallel typing to three rooms never mix DO payloads', async () => {
    const db = joinMultiDb([ROOM, ROOM2, ROOM3]);
    const do1 = createRoomDOStub();
    const do2 = createRoomDOStub();
    const do3 = createRoomDOStub();
    const env = createEnv({
      db,
      roomById: { [ROOM]: do1, [ROOM2]: do2, [ROOM3]: do3 },
    });

    const results = await Promise.all([
      request(
        env,
        typingPath(USER_ENC, ROOM_ENC),
        jsonInit('PUT', { typing: true, timeout: 1001 })
      ),
      request(
        env,
        typingPath(USER_ENC, ROOM2_ENC),
        jsonInit('PUT', { typing: true, timeout: 2002 })
      ),
      request(
        env,
        typingPath(USER_ENC, ROOM3_ENC),
        jsonInit('PUT', { typing: false })
      ),
    ]);

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(do1.fetches).toHaveLength(1);
    expect(do2.fetches).toHaveLength(1);
    expect(do3.fetches).toHaveLength(1);
    expect(do1.fetches[0].body).toMatchObject({ timeout: 1001, typing: true });
    expect(do2.fetches[0].body).toMatchObject({ timeout: 2002, typing: true });
    expect(do3.fetches[0].body).toMatchObject({ typing: false, timeout: 30000 });
  });

  for (let i = 0; i < 12; i++) {
    it(`multi-room soft-${i}: ROOM∥ROOM2 start`, async () => {
      const db = joinMultiDb([ROOM, ROOM2]);
      const do1 = createRoomDOStub();
      const do2 = createRoomDOStub();
      const env = createEnv({
        db,
        roomById: { [ROOM]: do1, [ROOM2]: do2 },
      });
      const results = await Promise.all([
        request(
          env,
          typingPath(USER_ENC, ROOM_ENC),
          jsonInit('PUT', { typing: true, timeout: 1500 + i })
        ),
        request(
          env,
          typingPath(USER_ENC, ROOM2_ENC),
          jsonInit('PUT', { typing: true, timeout: 2500 + i })
        ),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(do1.fetches).toHaveLength(1);
      expect(do2.fetches).toHaveLength(1);
      expect(env._idCalls).toEqual(expect.arrayContaining([ROOM, ROOM2]));
    });
  }

  it('ROOM join + ROOM2 leave — only joined room mutates DO', async () => {
    const db = createTypingDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: ROOM2, user_id: USER, membership: 'leave' },
      ],
    });
    const do1 = createRoomDOStub();
    const do2 = createRoomDOStub();
    const env = createEnv({
      db,
      roomById: { [ROOM]: do1, [ROOM2]: do2 },
    });
    const results = await Promise.all([
      request(
        env,
        typingPath(USER_ENC, ROOM_ENC),
        jsonInit('PUT', { typing: true })
      ),
      request(
        env,
        typingPath(USER_ENC, ROOM2_ENC),
        jsonInit('PUT', { typing: true })
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 403]);
    expect(do1.fetches).toHaveLength(1);
    expect(do2.fetches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Soft flood — method matrix
// ---------------------------------------------------------------------------

describe('typing concurrent soft flood — method matrix after #204', () => {
  const methods = ['GET', 'POST', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'] as const;

  for (const method of methods) {
    it(`wrong method ${method} on typing is not 200`, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const init: RequestInit = {
        method,
        headers: { ...AUTH, 'Content-Type': 'application/json' },
      };
      if (method !== 'GET' && method !== 'HEAD') {
        init.body = JSON.stringify({ typing: true });
      }
      const results = await Promise.all(
        Array.from({ length: 3 }, () => request(env, typingPath(), init))
      );
      expect(results.every((r) => r.status !== 200)).toBe(true);
      expect(roomDO.fetches).toHaveLength(0);
      expect(db.selects).toHaveLength(0);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`method soft-${i}: GET∥PUT — only PUT mutates`, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const results = await Promise.all([
        request(env, typingPath(), { method: 'GET', headers: { ...AUTH } }),
        request(
          env,
          typingPath(),
          jsonInit('PUT', { typing: true, timeout: 2000 + i })
        ),
      ]);
      expect(results[0].status).not.toBe(200);
      expect(results[1].status).toBe(200);
      expect(roomDO.fetches).toHaveLength(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Soft flood — bad JSON / body / timeout edges
// ---------------------------------------------------------------------------

describe('typing concurrent soft flood — bad JSON / body edges after #204', () => {
  const badBodies: Array<{ label: string; body: unknown; expectStatus: number }> = [
    { label: 'empty-obj', body: {}, expectStatus: 400 },
    { label: 'missing-typing', body: { timeout: 1000 }, expectStatus: 400 },
    { label: 'string-typing', body: { typing: 'true' }, expectStatus: 400 },
    { label: 'number-typing', body: { typing: 1 }, expectStatus: 400 },
    { label: 'null-typing', body: { typing: null }, expectStatus: 400 },
    { label: 'array-root', body: ['typing'], expectStatus: 400 },
    { label: 'string-root', body: 'typing', expectStatus: 400 },
  ];

  for (let i = 0; i < badBodies.length; i++) {
    const entry = badBodies[i];
    it(`PUT body soft-${i} (${entry.label}) parallel`, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const results = await Promise.all([
        request(env, typingPath(), jsonInit('PUT', entry.body)),
        request(env, typingPath(), jsonInit('PUT', entry.body)),
      ]);
      expect(results.every((r) => r.status === entry.expectStatus)).toBe(true);
      expect(roomDO.fetches).toHaveLength(0);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`truncated JSON soft-${i} parallel`, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const results = await Promise.all([
        request(env, typingPath(), {
          method: 'PUT',
          headers: { ...AUTH, 'Content-Type': 'application/json' },
          body: '{"typing":tru',
        }),
        request(env, typingPath(), {
          method: 'PUT',
          headers: { ...AUTH, 'Content-Type': 'application/json' },
          body: '{',
        }),
      ]);
      expect(results.every((r) => r.status === 400)).toBe(true);
      expect(roomDO.fetches).toHaveLength(0);
    });
  }

  const timeoutCases: Array<{ label: string; timeout: number; expected: number }> = [
    { label: 'default-omit', timeout: 0, expected: 30000 },
    { label: 'small', timeout: 1, expected: 1 },
    { label: 'cap-exact', timeout: 120000, expected: 120000 },
    { label: 'over-cap', timeout: 999999, expected: 120000 },
    { label: 'mid', timeout: 45000, expected: 45000 },
  ];

  for (let i = 0; i < timeoutCases.length; i++) {
    const tc = timeoutCases[i];
    it(`timeout soft-${i} (${tc.label}) parallel last both capped`, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub({ fetchBarrier: { count: 2 } });
      const env = createEnv({ db, roomDO });
      const body =
        tc.label === 'default-omit'
          ? { typing: true }
          : { typing: true, timeout: tc.timeout };
      const results = await Promise.all([
        request(env, typingPath(), jsonInit('PUT', body)),
        request(env, typingPath(), jsonInit('PUT', body)),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(
        roomDO.fetches.every(
          (f) => (f.body as { timeout: number }).timeout === tc.expected
        )
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Soft flood — foreign user / own-user gate
// ---------------------------------------------------------------------------

describe('typing concurrent soft flood — foreign user / own-user gate after #204', () => {
  for (let i = 0; i < 10; i++) {
    it(`foreign user soft-${i}`, async () => {
      const db = joinDb({
        memberships: [
          { room_id: ROOM, user_id: USER, membership: 'join' },
          { room_id: ROOM, user_id: BOB, membership: 'join' },
          { room_id: ROOM, user_id: CAROL, membership: 'join' },
        ],
      });
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const results = await Promise.all([
        request(
          env,
          typingPath(USER_ENC),
          jsonInit('PUT', { typing: true, timeout: 1000 + i })
        ),
        request(env, typingPath(BOB_ENC), jsonInit('PUT', { typing: true })),
        request(env, typingPath(CAROL_ENC), jsonInit('PUT', { typing: false })),
      ]);
      expect(statusesOf(results)).toEqual([200, 403, 403]);
      expect(roomDO.fetches).toHaveLength(1);
      expect((roomDO.fetches[0].body as { user_id: string }).user_id).toBe(USER);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`encoded foreign soft-${i}`, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const res = await request(
        env,
        typingPath(BOB_ENC),
        jsonInit('PUT', { typing: true })
      );
      expect(res.status).toBe(403);
      expect(res.errcode).toBe('M_FORBIDDEN');
      expect(roomDO.fetches).toHaveLength(0);
      expect(db.selects).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Soft flood — charset / content-type
// ---------------------------------------------------------------------------

describe('typing concurrent soft flood — charset / content-type after #204', () => {
  const contentTypes = [
    'application/json',
    'application/json; charset=utf-8',
    'application/json;charset=UTF-8',
    'application/json; charset=iso-8859-1',
  ];

  for (let i = 0; i < contentTypes.length; i++) {
    const ct = contentTypes[i];
    it(`content-type soft-${i}: ${ct}`, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const results = await Promise.all([
        request(env, typingPath(), {
          method: 'PUT',
          headers: { ...AUTH, 'Content-Type': ct },
          body: JSON.stringify({ typing: true, timeout: 3000 + i }),
        }),
        request(env, typingPath(), {
          method: 'PUT',
          headers: { ...AUTH, 'Content-Type': ct },
          body: JSON.stringify({ typing: false }),
        }),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(roomDO.fetches).toHaveLength(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Soft flood — membership forbid under parallel
// ---------------------------------------------------------------------------

describe('typing concurrent soft flood — membership forbid after #204', () => {
  const states = ['leave', 'ban', 'invite', 'knock'] as const;

  for (const state of states) {
    it(`non-join ${state} forbids parallel typing`, async () => {
      const db = createTypingDb({
        memberships: [{ room_id: ROOM, user_id: USER, membership: state }],
      });
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          request(env, typingPath(), jsonInit('PUT', { typing: true }))
        )
      );
      expect(results.every((r) => r.status === 403)).toBe(true);
      expect(roomDO.fetches).toHaveLength(0);
    });
  }

  it('missing membership row forbids parallel start+stop', async () => {
    const db = createTypingDb({ memberships: [] });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const results = await Promise.all([
      request(env, typingPath(), jsonInit('PUT', { typing: true })),
      request(env, typingPath(), jsonInit('PUT', { typing: false })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(roomDO.fetches).toHaveLength(0);
  });

  for (let i = 0; i < 8; i++) {
    it(`forbid∥join soft-${i}: other room leave does not poison join`, async () => {
      const db = createTypingDb({
        memberships: [
          { room_id: ROOM, user_id: USER, membership: 'join' },
          { room_id: ROOM2, user_id: USER, membership: 'leave' },
        ],
      });
      const do1 = createRoomDOStub();
      const do2 = createRoomDOStub();
      const env = createEnv({
        db,
        roomById: { [ROOM]: do1, [ROOM2]: do2 },
      });
      const results = await Promise.all([
        request(
          env,
          typingPath(USER_ENC, ROOM_ENC),
          jsonInit('PUT', { typing: true, timeout: 1000 + i })
        ),
        request(
          env,
          typingPath(USER_ENC, ROOM2_ENC),
          jsonInit('PUT', { typing: true })
        ),
      ]);
      expect(results[0].status).toBe(200);
      expect(results[1].status).toBe(403);
      expect(do1.fetches).toHaveLength(1);
      expect(do2.fetches).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Soft flood — auth identity switching
// ---------------------------------------------------------------------------

describe('typing concurrent soft flood — auth identity after #204', () => {
  it('switching auth user mid-suite isolates Room DO user_id payloads', async () => {
    const db = createTypingDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: ROOM, user_id: BOB, membership: 'join' },
      ],
    });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });

    authState.userId = USER;
    const a = await request(
      env,
      typingPath(USER_ENC),
      jsonInit('PUT', { typing: true, timeout: 1111 })
    );
    expect(a.status).toBe(200);

    authState.userId = BOB;
    const b = await request(
      env,
      typingPath(BOB_ENC),
      jsonInit('PUT', { typing: true, timeout: 2222 })
    );
    expect(b.status).toBe(200);

    expect(roomDO.fetches).toHaveLength(2);
    expect(roomDO.fetches[0].body).toMatchObject({ user_id: USER, timeout: 1111 });
    expect(roomDO.fetches[1].body).toMatchObject({ user_id: BOB, timeout: 2222 });
    expect(roomDO.typingUsers.sort()).toEqual([BOB, USER].sort());
  });

  for (let i = 0; i < 8; i++) {
    it(`auth soft-${i}: bob cannot set alice typing`, async () => {
      authState.userId = BOB;
      const db = createTypingDb({
        memberships: [
          { room_id: ROOM, user_id: USER, membership: 'join' },
          { room_id: ROOM, user_id: BOB, membership: 'join' },
        ],
      });
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const res = await request(
        env,
        typingPath(USER_ENC),
        jsonInit('PUT', { typing: true })
      );
      expect(res.status).toBe(403);
      expect(roomDO.fetches).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Store / select failure mid concurrent
// ---------------------------------------------------------------------------

describe('race typing store failure mid concurrent after #204', () => {
  it('D1 select fail before DO — no Room DO side effect', async () => {
    const db = joinDb({ failSelect: true });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(
      env,
      typingPath(),
      jsonInit('PUT', { typing: true })
    );
    expect(res.status).not.toBe(200);
    expect(roomDO.fetches).toHaveLength(0);
  });

  it('second select fails after first succeeds — one DO put remains', async () => {
    const db = joinDb({ failSelectAfter: 1 });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const first = await request(
      env,
      typingPath(),
      jsonInit('PUT', { typing: true, timeout: 3333 })
    );
    expect(first.status).toBe(200);
    const second = await request(
      env,
      typingPath(),
      jsonInit('PUT', { typing: false })
    );
    expect(second.status).not.toBe(200);
    expect(roomDO.fetches).toHaveLength(1);
  });

  for (let i = 0; i < 8; i++) {
    it(`D1 fail soft-${i}: parallel both error`, async () => {
      const db = joinDb({ failSelect: true });
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const results = await Promise.all([
        request(env, typingPath(), jsonInit('PUT', { typing: true })),
        request(env, typingPath(), jsonInit('PUT', { typing: false })),
      ]);
      expect(results.every((r) => r.status !== 200)).toBe(true);
      expect(roomDO.fetches).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// SQL / DO bind contracts under parallel
// ---------------------------------------------------------------------------

describe('typing concurrent SQL/DO bind contracts after #204', () => {
  it('parallel PUT bind contracts stay room+user order', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    await Promise.all([
      request(env, typingPath(), jsonInit('PUT', { typing: true, timeout: 1000 })),
      request(env, typingPath(), jsonInit('PUT', { typing: false })),
    ]);
    expect(db.selects).toHaveLength(2);
    for (const sel of db.selects) {
      expect(sel.sql).toContain('FROM room_memberships');
      expect(sel.args).toEqual([ROOM, USER]);
    }
    expect(roomDO.fetches.every((f) => f.url.includes('/typing'))).toBe(true);
    expect(roomDO.fetches.every((f) => (f.body as { user_id: string }).user_id === USER)).toBe(
      true
    );
  });

  it('URL-encoded path binds decoded ids under parallel', async () => {
    const weirdRoom = '!weird+room:example.com';
    const db = createTypingDb({
      memberships: [{ room_id: weirdRoom, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const results = await Promise.all([
      request(
        env,
        typingPath(USER_ENC, encodeURIComponent(weirdRoom)),
        jsonInit('PUT', { typing: true, timeout: 5000 })
      ),
      request(
        env,
        typingPath(USER_ENC, encodeURIComponent(weirdRoom)),
        jsonInit('PUT', { typing: false })
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.selects.every((c) => c.args[0] === weirdRoom)).toBe(true);
    expect(env._idCalls.every((n) => n === weirdRoom)).toBe(true);
  });

  for (let i = 0; i < 8; i++) {
    it(`bind soft-${i}: idFromName uses room id once per put`, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      await request(
        env,
        typingPath(),
        jsonInit('PUT', { typing: true, timeout: 2000 + i })
      );
      expect(env._idCalls).toEqual([ROOM]);
      expect(roomDO.fetches[0].body).toMatchObject({
        user_id: USER,
        typing: true,
        timeout: 2000 + i,
      });
    });
  }
});

// ---------------------------------------------------------------------------
// getTypingForRooms concurrent soft flood — empty/edge
// ---------------------------------------------------------------------------

describe('getTypingForRooms concurrent soft flood — empty/edge after #204', () => {
  it('empty roomIds returns {} without DO calls', async () => {
    const calls: string[] = [];
    const env = {
      ROOMS: {
        idFromName(roomId: string) {
          calls.push(roomId);
          return { name: roomId };
        },
        get() {
          throw new Error('should-not-get');
        },
      },
    } as unknown as Env;
    const byRoom = await getTypingForRooms(env, []);
    expect(byRoom).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it('http error body still parsed as user_ids when present', async () => {
    const env = envWithRooms({
      [ROOM]: { kind: 'http', status: 200, body: { user_ids: [DAVE] } },
    });
    expect(await getTypingUsers(env, ROOM)).toEqual([DAVE]);
  });

  for (let i = 0; i < 12; i++) {
    it(`edge soft-${i}: delay rooms still resolve in parallel`, async () => {
      const env = envWithRooms({
        [ROOM]: { kind: 'delay', user_ids: [USER], ms: 1 },
        [ROOM2]: { kind: 'delay', user_ids: i % 2 ? [BOB] : [], ms: 1 },
        [ROOM3]: { kind: 'typing', user_ids: [CAROL] },
        [ROOM4]: { kind: 'throw', error: new Error(`boom-${i}`) },
      });
      const byRoom = await getTypingForRooms(env, [ROOM, ROOM2, ROOM3, ROOM4]);
      expect(byRoom[ROOM]).toEqual([USER]);
      expect(byRoom[ROOM3]).toEqual([CAROL]);
      expect(byRoom[ROOM4]).toBeUndefined();
      if (i % 2) expect(byRoom[ROOM2]).toEqual([BOB]);
      else expect(byRoom[ROOM2]).toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------------
// Lifecycle start→stop under parallel + isolation
// ---------------------------------------------------------------------------

describe('typing concurrent soft flood — lifecycle start→stop after #204', () => {
  for (let i = 0; i < 12; i++) {
    it(`lifecycle soft-${i}`, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const start = await request(
        env,
        typingPath(),
        jsonInit('PUT', { typing: true, timeout: 5000 + i })
      );
      expect(start.status).toBe(200);
      expect(roomDO.typingUsers).toContain(USER);
      const stop = await request(
        env,
        typingPath(),
        jsonInit('PUT', { typing: false })
      );
      expect(stop.status).toBe(200);
      expect(roomDO.typingUsers).not.toContain(USER);
      expect(roomDO.fetches).toHaveLength(2);
    });
  }

  it('cross-room DO isolation under parallel PUTs', async () => {
    const db = joinMultiDb([ROOM, ROOM2]);
    const do1 = createRoomDOStub({ typingUsers: [BOB] });
    const do2 = createRoomDOStub({ typingUsers: [CAROL] });
    const env = createEnv({
      db,
      roomById: { [ROOM]: do1, [ROOM2]: do2 },
    });
    const results = await Promise.all([
      request(
        env,
        typingPath(USER_ENC, ROOM_ENC),
        jsonInit('PUT', { typing: true, timeout: 1000 })
      ),
      request(
        env,
        typingPath(USER_ENC, ROOM2_ENC),
        jsonInit('PUT', { typing: true, timeout: 2000 })
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(do1.typingUsers.sort()).toEqual([BOB, USER].sort());
    expect(do2.typingUsers.sort()).toEqual([CAROL, USER].sort());
    expect(do1.fetches).toHaveLength(1);
    expect(do2.fetches).toHaveLength(1);
  });
});
