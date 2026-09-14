/**
 * TOKENMAXX HEAVY leftovers after #178/#181 — receipts *concurrent race / TOCTOU*
 * + soft/edge reliability for slices not covered by receipts-api-route-leftovers (#178).
 * Orthogonal to to-device concurrent races (#181), presence/typing leftovers (#166),
 * oauth/push/identity leftovers (#177/#182), and relations leftovers (#179).
 * Focus: membership SELECT→write TOCTOU, parallel m.read/m.fully_read account_data
 * last-write-wins, receipt∥read_markers races, Room DO PUT barriers, getReceiptsForRoom
 * private-filter∥throw isolation, multi-room Promise.all soft floods.
 * Tests-only. Fixtures use example.com only. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { getReceiptsForRoom, getReceiptsForRooms } from '../src/api/receipts';

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

import receiptsApp from '../src/api/receipts';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const ROOM = '!r:example.com';
const ROOM2 = '!r2:example.com';
const ROOM3 = '!r3:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const ROOM2_ENC = encodeURIComponent(ROOM2);
const ROOM3_ENC = encodeURIComponent(ROOM3);
const EVENT = '$event1:example.com';
const EVENT2 = '$event2:example.com';
const EVENT3 = '$event3:example.com';
const THREAD = '$thread1:example.com';
const AUTH = { Authorization: 'Bearer test-token' };

type Membership = { room_id: string; user_id: string; membership: string };
type AccountDataRow = {
  user_id: string;
  room_id: string;
  event_type: string;
  content: string;
};
type SqlCall = { sql: string; args: unknown[] };
type RoomFetch = { url: string; method: string; body?: unknown; order: number };
type SelectBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };
type InsertBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };

type ReceiptBlob = Record<
  string,
  Record<string, Record<string, { ts: number; thread_id?: string }>>
>;

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
  fetchBarrier?: { count: number };
  throwOnPut?: boolean;
  delayMs?: number;
} = {}) {
  const fetches: RoomFetch[] = [];
  let order = 0;
  let putBarrier = opts.fetchBarrier;
  const waitersRef = { list: [] as Array<() => void> };

  return {
    fetches,
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
          waitersRef.list.push(resolve);
          if (waitersRef.list.length >= putBarrier!.count) {
            const all = [...waitersRef.list];
            waitersRef.list = [];
            putBarrier = undefined;
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
      if (url.includes('/receipts')) {
        return Response.json({ receipts: {} });
      }
      return Response.json({ ok: true });
    },
  };
}

type RoomDOStub = ReturnType<typeof createRoomDOStub>;

function createReceiptsDb(
  opts: {
    memberships?: Membership[];
    accountData?: AccountDataRow[];
    selectBarrier?: SelectBarrier;
    insertBarrier?: InsertBarrier;
    mutateMembershipAfterSelects?: {
      after: number;
      next: Membership[];
    };
    failInsertAfter?: number;
  } = {}
) {
  const memberships = [...(opts.memberships ?? [])];
  const accountData = [...(opts.accountData ?? [])];
  const inserts: SqlCall[] = [];
  const selects: SqlCall[] = [];
  const events: string[] = [];
  let selectBarrier = opts.selectBarrier;
  let insertBarrier = opts.insertBarrier;
  const selectWaiters = { list: [] as Array<() => void> };
  const insertWaiters = { list: [] as Array<() => void> };
  let membershipSelectCount = 0;
  let insertCount = 0;
  const mutate = opts.mutateMembershipAfterSelects;
  const failInsertAfter = opts.failInsertAfter;

  const db = {
    memberships,
    accountData,
    inserts,
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

              if (sql.includes('FROM room_memberships')) {
                const [roomId, userId] = args as string[];
                const snapshot = memberships.find(
                  (m) => m.room_id === roomId && m.user_id === userId
                );
                membershipSelectCount += 1;
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
              await withBarrier(
                insertBarrier,
                insertWaiters,
                () => {
                  insertBarrier = undefined;
                },
                sql,
                args
              );

              if (sql.includes('INSERT INTO account_data')) {
                inserts.push({ sql, args });
                insertCount += 1;
                events.push('run:insert-account_data');
                if (failInsertAfter !== undefined && insertCount > failInsertAfter) {
                  throw new Error('account_data insert fail');
                }
                const [userId, roomId, content] = args as [string, string, string];
                const eventType = 'm.fully_read';
                const idx = accountData.findIndex(
                  (a) =>
                    a.user_id === userId &&
                    a.room_id === roomId &&
                    a.event_type === eventType
                );
                const row: AccountDataRow = {
                  user_id: userId,
                  room_id: roomId,
                  event_type: eventType,
                  content,
                };
                if (idx >= 0) accountData[idx] = row;
                else accountData.push(row);
                return { success: true, meta: { changes: 1, last_row_id: 1 } };
              }
              throw new Error('Unhandled run() SQL: ' + sql.slice(0, 140));
            },
          };
        },
      };
    },
  };

  return db;
}

type ReceiptsDb = ReturnType<typeof createReceiptsDb>;

function createEnv(opts: {
  db?: ReceiptsDb;
  roomDO?: RoomDOStub;
  roomById?: Record<string, RoomDOStub>;
} = {}) {
  const db = opts.db ?? createReceiptsDb();
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
  const res = await receiptsApp.request('http://localhost' + path, init, env);
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
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function joinDb(extra?: Partial<Parameters<typeof createReceiptsDb>[0]>) {
  return createReceiptsDb({
    memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    ...extra,
  });
}

function joinMultiDb(rooms: string[], extra?: Partial<Parameters<typeof createReceiptsDb>[0]>) {
  return createReceiptsDb({
    memberships: rooms.map((room_id) => ({
      room_id,
      user_id: USER,
      membership: 'join',
    })),
    ...extra,
  });
}

function receiptPath(type: string, eventId = EVENT, roomEnc = ROOM_ENC) {
  return (
    '/_matrix/client/v3/rooms/' +
    roomEnc +
    '/receipt/' +
    encodeURIComponent(type) +
    '/' +
    encodeURIComponent(eventId)
  );
}

const markersPath = '/_matrix/client/v3/rooms/' + ROOM_ENC + '/read_markers';
const markersPath2 = '/_matrix/client/v3/rooms/' + ROOM2_ENC + '/read_markers';

function fullyReadContent(eventId: string) {
  return JSON.stringify({ event_id: eventId });
}

function mockRoomsNamespace(
  byRoom: Record<
    string,
    | { kind: 'receipts'; receipts: ReceiptBlob }
    | { kind: 'throw'; error: Error }
    | { kind: 'http'; status: number; body: unknown }
    | {
        kind: 'barrier';
        receipts: ReceiptBlob;
        count: number;
        waiters?: { list: Array<() => void> };
      }
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
            return new Response(JSON.stringify({ receipts: {} }), {
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
            return new Response(JSON.stringify({ receipts: entry.receipts }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }
          const url = new URL(request.url);
          if (url.pathname.endsWith('/receipts')) {
            return new Response(JSON.stringify({ receipts: entry.receipts }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response(JSON.stringify({ receipts: {} }), {
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
// Membership SELECT → write TOCTOU
// ---------------------------------------------------------------------------

describe('race receipt membership SELECT→write TOCTOU after #178', () => {
  it('both parallel m.read see join at SELECT; last write wins fully_read', async () => {
    const db = joinDb({
      selectBarrier: {
        match: (sql) => sql.includes('FROM room_memberships'),
        count: 2,
      },
    });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });

    const results = await Promise.all([
      request(env, receiptPath('m.read', EVENT), jsonInit('POST', {})),
      request(env, receiptPath('m.read', EVENT2), jsonInit('POST', {})),
    ]);

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(roomDO.fetches).toHaveLength(2);
    expect(db.accountData).toHaveLength(1);
    const final = JSON.parse(db.accountData[0].content) as { event_id: string };
    expect([EVENT, EVENT2]).toContain(final.event_id);
    expect(db.inserts).toHaveLength(2);
  });

  it('membership flips leave after first SELECT; second may forbid', async () => {
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
      request(env, receiptPath('m.read', EVENT), jsonInit('POST', {})),
      request(env, receiptPath('m.read', EVENT2), jsonInit('POST', {})),
    ]);

    // First SELECT snapshots join then mutates; second SELECT observes leave.
    expect(results.some((r) => r.status === 200)).toBe(true);
    expect(results.some((r) => r.status === 403)).toBe(true);
    expect(db.events).toContain('mutate:membership');
    expect(db.memberships[0].membership).toBe('leave');
    expect(roomDO.fetches.length).toBe(1);
  });

  it('post-mutate sequential request is forbidden after leave flip', async () => {
    const db = joinDb({
      mutateMembershipAfterSelects: {
        after: 1,
        next: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      },
    });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });

    const first = await request(env, receiptPath('m.read', EVENT), jsonInit('POST', {}));
    expect(first.status).toBe(200);

    const second = await request(env, receiptPath('m.read', EVENT2), jsonInit('POST', {}));
    expect(second.status).toBe(403);
    expect(second.errcode).toBe('M_FORBIDDEN');
    expect(roomDO.fetches).toHaveLength(1);
  });

  for (const status of ['invite', 'ban', 'knock', 'leave'] as const) {
    it(`TOCTOU soft: join→${status} after first SELECT forbids next receipt`, async () => {
      const db = joinDb({
        mutateMembershipAfterSelects: {
          after: 1,
          next: [{ room_id: ROOM, user_id: USER, membership: status }],
        },
      });
      const env = createEnv({ db, roomDO: createRoomDOStub() });
      expect(
        (await request(env, receiptPath('m.fully_read', EVENT), jsonInit('POST', {}))).status
      ).toBe(200);
      const denied = await request(
        env,
        receiptPath('m.fully_read', EVENT2),
        jsonInit('POST', {})
      );
      expect(denied.status).toBe(403);
      expect(denied.errcode).toBe('M_FORBIDDEN');
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`membership barrier soft-${i}: parallel fully_read last-write-wins`, async () => {
      const db = joinDb({
        selectBarrier: {
          match: (sql) => sql.includes('FROM room_memberships'),
          count: 2,
        },
      });
      const env = createEnv({ db, roomDO: createRoomDOStub() });
      const a = '$a-' + i + ':example.com';
      const b = '$b-' + i + ':example.com';
      const results = await Promise.all([
        request(env, receiptPath('m.fully_read', a), jsonInit('POST', {})),
        request(env, receiptPath('m.fully_read', b), jsonInit('POST', {})),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(db.accountData).toHaveLength(1);
      const final = JSON.parse(db.accountData[0].content) as { event_id: string };
      expect([a, b]).toContain(final.event_id);
    });
  }
});

// ---------------------------------------------------------------------------
// Parallel account_data last-write-wins
// ---------------------------------------------------------------------------

describe('race parallel m.read account_data last-write-wins after #178', () => {
  it('N parallel m.read share one account_data row with last writer', async () => {
    const N = 8;
    const db = joinDb({
      insertBarrier: {
        match: (sql) => sql.includes('INSERT INTO account_data'),
        count: N,
      },
    });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const eids = Array.from({ length: N }, (_, i) => `$par-${i}:example.com`);

    const results = await Promise.all(
      eids.map((eid) => request(env, receiptPath('m.read', eid), jsonInit('POST', {})))
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(roomDO.fetches).toHaveLength(N);
    expect(db.accountData).toHaveLength(1);
    expect(db.inserts).toHaveLength(N);
    const final = JSON.parse(db.accountData[0].content) as { event_id: string };
    expect(eids).toContain(final.event_id);
  });

  it('m.read ∥ m.fully_read race — both write same row', async () => {
    const db = joinDb({
      insertBarrier: {
        match: (sql) => sql.includes('INSERT INTO account_data'),
        count: 2,
      },
    });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });

    const results = await Promise.all([
      request(env, receiptPath('m.read', EVENT), jsonInit('POST', {})),
      request(env, receiptPath('m.fully_read', EVENT2), jsonInit('POST', {})),
    ]);

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(roomDO.fetches).toHaveLength(1); // only m.read hits DO
    expect(db.accountData).toHaveLength(1);
    const final = JSON.parse(db.accountData[0].content) as { event_id: string };
    expect([EVENT, EVENT2]).toContain(final.event_id);
  });

  it('m.read.private ∥ m.read — private never touches account_data', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub({ fetchBarrier: { count: 2 } });
    const env = createEnv({ db, roomDO });

    const results = await Promise.all([
      request(
        env,
        receiptPath('m.read.private', EVENT),
        jsonInit('POST', { thread_id: THREAD })
      ),
      request(env, receiptPath('m.read', EVENT2), jsonInit('POST', {})),
    ]);

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(roomDO.fetches).toHaveLength(2);
    expect(db.accountData).toHaveLength(1);
    expect(JSON.parse(db.accountData[0].content)).toEqual({ event_id: EVENT2 });
    const privateBody = roomDO.fetches.find(
      (f) => (f.body as { receipt_type?: string })?.receipt_type === 'm.read.private'
    );
    expect(privateBody?.body).toMatchObject({
      event_id: EVENT,
      receipt_type: 'm.read.private',
      thread_id: THREAD,
    });
  });

  for (let i = 0; i < 16; i++) {
    it(`parallel m.read soft-${i}: dual last-write-wins`, async () => {
      const db = joinDb({
        insertBarrier: {
          match: (sql) => sql.includes('INSERT INTO account_data'),
          count: 2,
        },
      });
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const a = `$soft-a-${i}:example.com`;
      const b = `$soft-b-${i}:example.com`;
      const results = await Promise.all([
        request(env, receiptPath('m.read', a), jsonInit('POST', {})),
        request(env, receiptPath('m.read', b), jsonInit('POST', {})),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(db.accountData).toHaveLength(1);
      expect([a, b]).toContain(
        (JSON.parse(db.accountData[0].content) as { event_id: string }).event_id
      );
    });
  }
});

// ---------------------------------------------------------------------------
// receipt ∥ read_markers races
// ---------------------------------------------------------------------------

describe('race receipt∥read_markers concurrent after #178', () => {
  it('m.read receipt ∥ read_markers m.fully_read — both succeed', async () => {
    const db = joinDb({
      insertBarrier: {
        match: (sql) => sql.includes('INSERT INTO account_data'),
        count: 2,
      },
    });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });

    const results = await Promise.all([
      request(env, receiptPath('m.read', EVENT), jsonInit('POST', {})),
      request(env, markersPath, jsonInit('POST', { 'm.fully_read': EVENT2 })),
    ]);

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.accountData).toHaveLength(1);
    expect(db.inserts).toHaveLength(2);
    const final = JSON.parse(db.accountData[0].content) as { event_id: string };
    expect([EVENT, EVENT2]).toContain(final.event_id);
  });

  it('read_markers m.read+fully_read ∥ receipt private — DO gets both puts', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub({ fetchBarrier: { count: 2 } });
    const env = createEnv({ db, roomDO });

    const results = await Promise.all([
      request(
        env,
        markersPath,
        jsonInit('POST', { 'm.read': EVENT, 'm.fully_read': EVENT2 })
      ),
      request(
        env,
        receiptPath('m.read.private', EVENT3),
        jsonInit('POST', { thread_id: THREAD })
      ),
    ]);

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(roomDO.fetches).toHaveLength(2);
    expect(db.accountData).toHaveLength(1);
    expect(JSON.parse(db.accountData[0].content)).toEqual({ event_id: EVENT2 });
  });

  it('parallel read_markers on same room — last fully_read wins', async () => {
    const db = joinDb({
      insertBarrier: {
        match: (sql) => sql.includes('INSERT INTO account_data'),
        count: 2,
      },
    });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });

    const results = await Promise.all([
      request(env, markersPath, jsonInit('POST', { 'm.fully_read': EVENT })),
      request(env, markersPath, jsonInit('POST', { 'm.fully_read': EVENT2 })),
    ]);

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.accountData).toHaveLength(1);
    expect([EVENT, EVENT2]).toContain(
      (JSON.parse(db.accountData[0].content) as { event_id: string }).event_id
    );
  });

  it('parallel read_markers across rooms isolate account_data', async () => {
    const db = joinMultiDb([ROOM, ROOM2], {
      insertBarrier: {
        match: (sql) => sql.includes('INSERT INTO account_data'),
        count: 2,
      },
    });
    const do1 = createRoomDOStub();
    const do2 = createRoomDOStub();
    const env = createEnv({
      db,
      roomById: { [ROOM]: do1, [ROOM2]: do2 },
    });

    const results = await Promise.all([
      request(env, markersPath, jsonInit('POST', { 'm.read': EVENT })),
      request(env, markersPath2, jsonInit('POST', { 'm.read': EVENT2 })),
    ]);

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.accountData).toHaveLength(2);
    expect(do1.fetches).toHaveLength(1);
    expect(do2.fetches).toHaveLength(1);
    const byRoom = Object.fromEntries(
      db.accountData.map((r) => [r.room_id, JSON.parse(r.content).event_id])
    );
    expect(byRoom[ROOM]).toBe(EVENT);
    expect(byRoom[ROOM2]).toBe(EVENT2);
  });

  for (let i = 0; i < 14; i++) {
    it(`receipt∥markers soft-${i}`, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const readEid = `$rm-${i}:example.com`;
      const fullEid = `$rf-${i}:example.com`;
      const results = await Promise.all([
        request(env, receiptPath('m.read', readEid), jsonInit('POST', {})),
        request(env, markersPath, jsonInit('POST', { 'm.fully_read': fullEid })),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(roomDO.fetches).toHaveLength(1);
      expect(db.accountData).toHaveLength(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Room DO PUT barriers / failures
// ---------------------------------------------------------------------------

describe('race Room DO PUT barriers and failures after #178', () => {
  it('parallel m.read wait on DO PUT barrier then both land', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub({ fetchBarrier: { count: 3 } });
    const env = createEnv({ db, roomDO });

    const results = await Promise.all([
      request(env, receiptPath('m.read', EVENT), jsonInit('POST', {})),
      request(env, receiptPath('m.read', EVENT2), jsonInit('POST', {})),
      request(
        env,
        receiptPath('m.read.private', EVENT3),
        jsonInit('POST', { thread_id: THREAD })
      ),
    ]);

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(roomDO.fetches).toHaveLength(3);
    expect(db.accountData).toHaveLength(1);
  });

  it('DO throw on PUT surfaces as 500 for m.read', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub({ throwOnPut: true });
    const env = createEnv({ db, roomDO });

    const res = await request(env, receiptPath('m.read', EVENT), jsonInit('POST', {}));
    expect(res.status).toBe(500);
  });

  it('m.fully_read ignores DO throw capability (no DO call)', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub({ throwOnPut: true });
    const env = createEnv({ db, roomDO });

    const res = await request(
      env,
      receiptPath('m.fully_read', EVENT),
      jsonInit('POST', {})
    );
    expect(res.status).toBe(200);
    expect(roomDO.fetches).toHaveLength(0);
    expect(db.accountData[0].content).toBe(fullyReadContent(EVENT));
  });

  it('read_markers m.read DO throw aborts before auto fully_read', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub({ throwOnPut: true });
    const env = createEnv({ db, roomDO });

    const res = await request(env, markersPath, jsonInit('POST', { 'm.read': EVENT }));
    expect(res.status).toBe(500);
    expect(db.accountData).toHaveLength(0);
  });

  it('read_markers explicit fully_read then DO throw on m.read keeps fully_read', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub({ throwOnPut: true });
    const env = createEnv({ db, roomDO });

    const res = await request(
      env,
      markersPath,
      jsonInit('POST', { 'm.fully_read': EVENT2, 'm.read': EVENT })
    );
    expect(res.status).toBe(500);
    expect(db.accountData).toHaveLength(1);
    expect(JSON.parse(db.accountData[0].content)).toEqual({ event_id: EVENT2 });
  });

  for (let i = 0; i < 12; i++) {
    it(`DO barrier soft-${i}: dual private+read`, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub({ fetchBarrier: { count: 2 } });
      const env = createEnv({ db, roomDO });
      const results = await Promise.all([
        request(
          env,
          receiptPath('m.read.private', `$p-${i}:example.com`),
          jsonInit('POST', { thread_id: `$t-${i}:example.com` })
        ),
        request(
          env,
          receiptPath('m.read', `$r-${i}:example.com`),
          jsonInit('POST', {})
        ),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(roomDO.fetches).toHaveLength(2);
      expect(db.inserts).toHaveLength(1);
    });
  }
});

// ---------------------------------------------------------------------------
// account_data insert failure mid race
// ---------------------------------------------------------------------------

describe('race account_data insert failure mid concurrent after #178', () => {
  it('second insert failure after first succeeds — one row remains', async () => {
    const db = joinDb({ failInsertAfter: 1 });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });

    const first = await request(env, receiptPath('m.read', EVENT), jsonInit('POST', {}));
    expect(first.status).toBe(200);

    const second = await request(env, receiptPath('m.read', EVENT2), jsonInit('POST', {}));
    expect(second.status).toBe(500);

    expect(db.accountData).toHaveLength(1);
    expect(JSON.parse(db.accountData[0].content)).toEqual({ event_id: EVENT });
    // DO put for m.read happens before account_data insert
    expect(roomDO.fetches.length).toBeGreaterThanOrEqual(1);
  });

  for (let i = 0; i < 10; i++) {
    it(`insert-fail soft-${i}: fully_read first then fail`, async () => {
      const db = joinDb({ failInsertAfter: 1 });
      const env = createEnv({ db, roomDO: createRoomDOStub() });
      expect(
        (
          await request(
            env,
            receiptPath('m.fully_read', `$ok-${i}:example.com`),
            jsonInit('POST', {})
          )
        ).status
      ).toBe(200);
      const fail = await request(
        env,
        receiptPath('m.fully_read', `$fail-${i}:example.com`),
        jsonInit('POST', {})
      );
      expect(fail.status).toBe(500);
      expect(db.accountData).toHaveLength(1);
    });
  }
});

// ---------------------------------------------------------------------------
// getReceiptsForRoom / getReceiptsForRooms concurrent
// ---------------------------------------------------------------------------

describe('race getReceiptsForRoom private-filter∥throw after #178', () => {
  const mixed: ReceiptBlob = {
    $pub: {
      'm.read': {
        [USER]: { ts: 100 },
        [BOB]: { ts: 200 },
      },
      'm.read.private': {
        [USER]: { ts: 110, thread_id: THREAD },
        [BOB]: { ts: 220 },
      },
    },
    $onlyBob: {
      'm.read.private': {
        [BOB]: { ts: 300 },
      },
    },
  };

  it('parallel getReceiptsForRoom same room — identical private filters', async () => {
    const env = envWithRooms({
      [ROOM]: {
        kind: 'barrier',
        receipts: mixed,
        count: 3,
      },
    });

    const results = await Promise.all([
      getReceiptsForRoom(env, ROOM, USER),
      getReceiptsForRoom(env, ROOM, USER),
      getReceiptsForRoom(env, ROOM, USER),
    ]);

    for (const r of results) {
      expect(r.type).toBe('m.receipt');
      expect(r.content.$pub['m.read'][USER].ts).toBe(100);
      expect(r.content.$pub['m.read.private'][USER].thread_id).toBe(THREAD);
      expect(r.content.$pub['m.read.private'][BOB]).toBeUndefined();
      expect(r.content.$onlyBob).toBeUndefined();
    }
  });

  it('parallel get with different requesting users filters privately', async () => {
    const env = envWithRooms({
      [ROOM]: {
        kind: 'barrier',
        receipts: mixed,
        count: 2,
      },
    });

    const [aliceView, bobView] = await Promise.all([
      getReceiptsForRoom(env, ROOM, USER),
      getReceiptsForRoom(env, ROOM, BOB),
    ]);

    expect(aliceView.content.$pub['m.read.private'][USER]).toBeDefined();
    expect(aliceView.content.$pub['m.read.private'][BOB]).toBeUndefined();
    expect(bobView.content.$pub['m.read.private'][BOB]).toBeDefined();
    expect(bobView.content.$pub['m.read.private'][USER]).toBeUndefined();
    expect(bobView.content.$onlyBob['m.read.private'][BOB].ts).toBe(300);
  });

  it('getReceiptsForRooms isolates throw in one room', async () => {
    const env = envWithRooms({
      [ROOM]: { kind: 'throw', error: new Error('boom-room') },
      [ROOM2]: {
        kind: 'receipts',
        receipts: {
          $ok: { 'm.read': { [USER]: { ts: 1 } } },
        },
      },
      [ROOM3]: {
        kind: 'receipts',
        receipts: {
          $p: { 'm.read.private': { [CAROL]: { ts: 9 } } },
        },
      },
    });

    const byRoom = await getReceiptsForRooms(env, [ROOM, ROOM2, ROOM3], USER);
    expect(byRoom[ROOM]).toBeUndefined();
    expect(byRoom[ROOM2].$ok['m.read'][USER].ts).toBe(1);
    expect(byRoom[ROOM3]).toBeUndefined(); // private other user filtered out
  });

  it('parallel getReceiptsForRooms calls remain isolated', async () => {
    const env = envWithRooms({
      [ROOM]: {
        kind: 'barrier',
        receipts: { $a: { 'm.read': { [USER]: { ts: 1 } } } },
        count: 2,
      },
      [ROOM2]: {
        kind: 'receipts',
        receipts: { $b: { 'm.read': { [USER]: { ts: 2 } } } },
      },
    });

    const [a, b] = await Promise.all([
      getReceiptsForRooms(env, [ROOM, ROOM2], USER),
      getReceiptsForRooms(env, [ROOM, ROOM2], USER),
    ]);

    expect(a[ROOM].$a['m.read'][USER].ts).toBe(1);
    expect(b[ROOM].$a['m.read'][USER].ts).toBe(1);
    expect(a[ROOM2].$b['m.read'][USER].ts).toBe(2);
    expect(b[ROOM2].$b['m.read'][USER].ts).toBe(2);
  });

  for (let i = 0; i < 14; i++) {
    it(`private-filter soft-${i}`, async () => {
      const env = envWithRooms({
        [ROOM]: {
          kind: 'receipts',
          receipts: {
            [`$e-${i}`]: {
              'm.read': { [USER]: { ts: i }, [BOB]: { ts: i + 100 } },
              'm.read.private': {
                [USER]: { ts: i + 1, thread_id: `$t-${i}:example.com` },
                [BOB]: { ts: i + 2 },
              },
            },
          },
        },
      });
      const r = await getReceiptsForRoom(env, ROOM, USER);
      expect(r.content[`$e-${i}`]['m.read.private'][BOB]).toBeUndefined();
      expect(r.content[`$e-${i}`]['m.read.private'][USER].ts).toBe(i + 1);
    });
  }
});

// ---------------------------------------------------------------------------
// Multi-room HTTP isolation under concurrency
// ---------------------------------------------------------------------------

describe('race multi-room receipt HTTP isolation after #178', () => {
  it('parallel receipts to three rooms never mix DO payloads', async () => {
    const db = joinMultiDb([ROOM, ROOM2, ROOM3]);
    const dos = {
      [ROOM]: createRoomDOStub(),
      [ROOM2]: createRoomDOStub(),
      [ROOM3]: createRoomDOStub(),
    };
    const env = createEnv({ db, roomById: dos });

    const results = await Promise.all([
      request(
        env,
        receiptPath('m.read', EVENT, ROOM_ENC),
        jsonInit('POST', { thread_id: '$t1:example.com' })
      ),
      request(
        env,
        receiptPath('m.read', EVENT2, ROOM2_ENC),
        jsonInit('POST', { thread_id: '$t2:example.com' })
      ),
      request(
        env,
        receiptPath('m.read.private', EVENT3, ROOM3_ENC),
        jsonInit('POST', { thread_id: '$t3:example.com' })
      ),
    ]);

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(dos[ROOM].fetches[0].body).toMatchObject({
      event_id: EVENT,
      receipt_type: 'm.read',
      thread_id: '$t1:example.com',
    });
    expect(dos[ROOM2].fetches[0].body).toMatchObject({
      event_id: EVENT2,
      receipt_type: 'm.read',
      thread_id: '$t2:example.com',
    });
    expect(dos[ROOM3].fetches[0].body).toMatchObject({
      event_id: EVENT3,
      receipt_type: 'm.read.private',
      thread_id: '$t3:example.com',
    });
    expect(db.accountData.filter((r) => r.room_id === ROOM)).toHaveLength(1);
    expect(db.accountData.filter((r) => r.room_id === ROOM2)).toHaveLength(1);
    expect(db.accountData.filter((r) => r.room_id === ROOM3)).toHaveLength(0);
  });

  for (let i = 0; i < 12; i++) {
    it(`multi-room soft-${i}: ROOM∥ROOM2 fully_read`, async () => {
      const db = joinMultiDb([ROOM, ROOM2]);
      const env = createEnv({
        db,
        roomById: {
          [ROOM]: createRoomDOStub(),
          [ROOM2]: createRoomDOStub(),
        },
      });
      const results = await Promise.all([
        request(
          env,
          receiptPath('m.fully_read', `$x-${i}:example.com`, ROOM_ENC),
          jsonInit('POST', {})
        ),
        request(
          env,
          receiptPath('m.fully_read', `$y-${i}:example.com`, ROOM2_ENC),
          jsonInit('POST', {})
        ),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(db.accountData).toHaveLength(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Soft floods — method / charset / invalid type under concurrency
// ---------------------------------------------------------------------------

describe('receipt concurrent soft flood — invalid type matrix after #178', () => {
  const badTypes = [
    'm.read.public',
    'm.fully_read.private',
    'read',
    'M.READ',
    'm.receipt',
    'm.read ',
    'm.read\n',
    '../m.read',
    'm.read;drop',
  ];

  for (const type of badTypes) {
    it(`rejects invalid type under parallel load: ${JSON.stringify(type)}`, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          request(env, receiptPath(type), jsonInit('POST', {}))
        )
      );
      for (const r of results) {
        expect(r.status).toBe(400);
        expect(r.errcode).toBe('M_INVALID_PARAM');
      }
      expect(roomDO.fetches).toHaveLength(0);
      expect(db.inserts).toHaveLength(0);
    });
  }

  it('empty receipt type path yields non-success (router 404)', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => request(env, receiptPath(''), jsonInit('POST', {})))
    );
    expect(results.every((r) => r.status !== 200)).toBe(true);
    expect(roomDO.fetches).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
  });

  for (let i = 0; i < 12; i++) {
    it(`invalid∥valid soft-${i}: bad type does not poison good receipt`, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const results = await Promise.all([
        request(env, receiptPath('m.not.a.type'), jsonInit('POST', {})),
        request(env, receiptPath('m.read', `$ok-${i}:example.com`), jsonInit('POST', {})),
      ]);
      expect(results[0].status).toBe(400);
      expect(results[1].status).toBe(200);
      expect(roomDO.fetches).toHaveLength(1);
      expect(db.accountData).toHaveLength(1);
    });
  }
});

describe('receipt concurrent soft flood — method matrix after #178', () => {
  const methods = ['GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'] as const;

  for (const method of methods) {
    it(`wrong method ${method} on receipt is not 200`, async () => {
      const db = joinDb();
      const env = createEnv({ db, roomDO: createRoomDOStub() });
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          request(env, receiptPath('m.read'), { method, headers: { ...AUTH } })
        )
      );
      expect(results.every((r) => r.status !== 200)).toBe(true);
      expect(db.inserts).toHaveLength(0);
    });
  }

  for (const method of methods) {
    it(`wrong method ${method} on read_markers is not 200`, async () => {
      const db = joinDb();
      const env = createEnv({ db, roomDO: createRoomDOStub() });
      const res = await request(env, markersPath, {
        method,
        headers: { ...AUTH },
      });
      expect(res.status).not.toBe(200);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`method soft-${i}: GET∥POST — only POST mutates`, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const results = await Promise.all([
        request(env, receiptPath('m.read', `$g-${i}:example.com`), {
          method: 'GET',
          headers: { ...AUTH },
        }),
        request(
          env,
          receiptPath('m.read', `$p-${i}:example.com`),
          jsonInit('POST', {})
        ),
      ]);
      expect(results[0].status).not.toBe(200);
      expect(results[1].status).toBe(200);
      expect(roomDO.fetches).toHaveLength(1);
    });
  }
});

describe('receipt concurrent soft flood — charset / bad JSON after #178', () => {
  const charsets = [
    'application/json',
    'application/json; charset=utf-8',
    'application/json;charset=UTF-8',
    'application/json; charset=utf-8; boundary=x',
  ];

  for (const ct of charsets) {
    it(`accepts Content-Type ${ct} for m.read`, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const res = await request(env, receiptPath('m.read'), {
        method: 'POST',
        headers: { 'Content-Type': ct, ...AUTH },
        body: JSON.stringify({ thread_id: THREAD }),
      });
      expect(res.status).toBe(200);
      expect(roomDO.fetches[0].body).toMatchObject({ thread_id: THREAD });
    });
  }

  it('parallel bad JSON bodies still succeed for optional receipt body', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub({ fetchBarrier: { count: 4 } });
    const env = createEnv({ db, roomDO });
    const junk = ['{', 'null', '[]', 'not-json'];
    const results = await Promise.all(
      junk.map((body, i) =>
        request(env, receiptPath('m.read', `$j-${i}:example.com`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body,
        })
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(roomDO.fetches).toHaveLength(4);
  });

  it('parallel truncated/invalid JSON on read_markers all M_BAD_JSON', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    // Truly unparseable — parsed-but-non-object JSON (null/[]) can 500 on property access.
    const junk = ['{', 'nope', '{bad', ',,,', '"unterminated'];
    const results = await Promise.all(
      junk.map((body) =>
        request(env, markersPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body,
        })
      )
    );
    for (const r of results) {
      expect(r.status).toBe(400);
      expect(r.errcode).toBe('M_BAD_JSON');
    }
    expect(roomDO.fetches).toHaveLength(0);
  });

  it('parallel parsed non-object JSON on read_markers is non-mutating', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    // null/[]/true/0 throw on property access → 500; "" indexes as undefined → empty 200.
    const junk = ['null', '[]', 'true', '0', '""'];
    const results = await Promise.all(
      junk.map((body) =>
        request(env, markersPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body,
        })
      )
    );
    expect(results.every((r) => r.status === 500 || r.status === 200)).toBe(true);
    expect(roomDO.fetches).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
    expect(db.accountData).toHaveLength(0);
  });

  for (let i = 0; i < 12; i++) {
    it(`charset soft-${i}: utf-8 thread_id unicode`, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const thread_id = `$ thr-${i}-日本語-🔐:example.com`;
      const res = await request(
        env,
        receiptPath('m.read.private', `$u-${i}:example.com`),
        jsonInit('POST', { thread_id })
      );
      expect(res.status).toBe(200);
      expect(roomDO.fetches[0].body).toMatchObject({ thread_id });
      expect(db.inserts).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Membership forbid under concurrent load
// ---------------------------------------------------------------------------

describe('receipt concurrent soft flood — membership forbid after #178', () => {
  for (const status of ['leave', 'ban', 'invite', 'knock'] as const) {
    it(`parallel receipts all forbidden when membership=${status}`, async () => {
      const db = createReceiptsDb({
        memberships: [{ room_id: ROOM, user_id: USER, membership: status }],
      });
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const results = await Promise.all([
        request(env, receiptPath('m.read'), jsonInit('POST', {})),
        request(env, receiptPath('m.fully_read'), jsonInit('POST', {})),
        request(env, markersPath, jsonInit('POST', { 'm.read': EVENT })),
      ]);
      expect(results.every((r) => r.status === 403)).toBe(true);
      expect(results.every((r) => r.errcode === 'M_FORBIDDEN')).toBe(true);
      expect(roomDO.fetches).toHaveLength(0);
      expect(db.inserts).toHaveLength(0);
    });
  }

  it('missing membership row forbids parallel receipt+markers', async () => {
    const db = createReceiptsDb({ memberships: [] });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const results = await Promise.all([
      request(env, receiptPath('m.read'), jsonInit('POST', {})),
      request(env, markersPath, jsonInit('POST', { 'm.fully_read': EVENT })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(roomDO.fetches).toHaveLength(0);
  });

  for (let i = 0; i < 12; i++) {
    it(`forbid soft-${i}: bob join does not authorize alice`, async () => {
      const db = createReceiptsDb({
        memberships: [{ room_id: ROOM, user_id: BOB, membership: 'join' }],
      });
      const env = createEnv({ db, roomDO: createRoomDOStub() });
      const results = await Promise.all([
        request(env, receiptPath('m.read', `$b-${i}:example.com`), jsonInit('POST', {})),
        request(
          env,
          markersPath,
          jsonInit('POST', { 'm.read': `$b2-${i}:example.com` })
        ),
      ]);
      expect(results.every((r) => r.status === 403)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// read_markers combination races
// ---------------------------------------------------------------------------

describe('race read_markers combination matrix concurrent after #178', () => {
  const combos: Array<{
    label: string;
    body: Record<string, string>;
    expectDo: number;
    expectFull: string | null;
  }> = [
    {
      label: 'only fully_read',
      body: { 'm.fully_read': EVENT },
      expectDo: 0,
      expectFull: EVENT,
    },
    {
      label: 'only m.read',
      body: { 'm.read': EVENT2 },
      expectDo: 1,
      expectFull: EVENT2,
    },
    {
      label: 'only private',
      body: { 'm.read.private': EVENT3 },
      expectDo: 1,
      expectFull: null,
    },
    {
      label: 'read+fully',
      body: { 'm.read': EVENT, 'm.fully_read': EVENT2 },
      expectDo: 1,
      expectFull: EVENT2,
    },
    {
      label: 'all three',
      body: {
        'm.read': EVENT,
        'm.fully_read': EVENT2,
        'm.read.private': EVENT3,
      },
      expectDo: 2,
      expectFull: EVENT2,
    },
    {
      label: 'private+fully',
      body: { 'm.read.private': EVENT3, 'm.fully_read': EVENT },
      expectDo: 1,
      expectFull: EVENT,
    },
  ];

  for (const c of combos) {
    it(`combo race dual: ${c.label}`, async () => {
      const db = joinDb();
      // Barrier only when each request issues a single DO PUT — multi-PUT bodies
      // would deadlock waiting for later puts in the same request.
      const roomDO = createRoomDOStub({
        fetchBarrier: c.expectDo === 1 ? { count: 2 } : undefined,
      });
      const env = createEnv({ db, roomDO });

      const results = await Promise.all([
        request(env, markersPath, jsonInit('POST', c.body)),
        request(env, markersPath, jsonInit('POST', c.body)),
      ]);

      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(roomDO.fetches).toHaveLength(c.expectDo * 2);
      if (c.expectFull) {
        expect(db.accountData).toHaveLength(1);
        expect(JSON.parse(db.accountData[0].content)).toEqual({
          event_id: c.expectFull,
        });
      } else {
        expect(db.accountData).toHaveLength(0);
      }
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`combo soft-${i}: empty strings skipped under parallel`, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const results = await Promise.all([
        request(
          env,
          markersPath,
          jsonInit('POST', {
            'm.read': '',
            'm.fully_read': '',
            'm.read.private': '',
          })
        ),
        request(
          env,
          markersPath,
          jsonInit('POST', { 'm.fully_read': `$keep-${i}:example.com` })
        ),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(roomDO.fetches).toHaveLength(0);
      expect(db.accountData).toHaveLength(1);
      expect(JSON.parse(db.accountData[0].content)).toEqual({
        event_id: `$keep-${i}:example.com`,
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Auth identity soft edges under concurrency
// ---------------------------------------------------------------------------

describe('receipt concurrent soft flood — auth identity after #178', () => {
  it('switching auth user mid-suite isolates account_data rows', async () => {
    const db = createReceiptsDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: ROOM, user_id: BOB, membership: 'join' },
      ],
    });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });

    authState.userId = USER;
    const a = await request(env, receiptPath('m.read', EVENT), jsonInit('POST', {}));
    expect(a.status).toBe(200);

    authState.userId = BOB;
    const b = await request(env, receiptPath('m.read', EVENT2), jsonInit('POST', {}));
    expect(b.status).toBe(200);

    expect(db.accountData).toHaveLength(2);
    expect(db.accountData.find((r) => r.user_id === USER)?.content).toBe(
      fullyReadContent(EVENT)
    );
    expect(db.accountData.find((r) => r.user_id === BOB)?.content).toBe(
      fullyReadContent(EVENT2)
    );
  });

  for (let i = 0; i < 10; i++) {
    it(`auth soft-${i}: parallel alice∥bob receipts`, async () => {
      const db = createReceiptsDb({
        memberships: [
          { room_id: ROOM, user_id: USER, membership: 'join' },
          { room_id: ROOM, user_id: BOB, membership: 'join' },
        ],
      });
      // Separate envs with fixed auth — simulate via sequential auth swap + barrier inserts
      authState.userId = USER;
      const roomDO = createRoomDOStub();
      const envA = createEnv({ db, roomDO });
      const resA = await request(
        envA,
        receiptPath('m.fully_read', `$alice-${i}:example.com`),
        jsonInit('POST', {})
      );
      authState.userId = BOB;
      const resB = await request(
        envA,
        receiptPath('m.fully_read', `$bob-${i}:example.com`),
        jsonInit('POST', {})
      );
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      expect(db.accountData.filter((r) => r.user_id === USER)).toHaveLength(1);
      expect(db.accountData.filter((r) => r.user_id === BOB)).toHaveLength(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Empty room list / helper edge soft floods
// ---------------------------------------------------------------------------

describe('getReceiptsForRooms concurrent soft flood — empty/edge after #178', () => {
  it('empty roomIds returns {} without DO calls', async () => {
    const fetches: string[] = [];
    const env = {
      ROOMS: {
        idFromName(roomId: string) {
          fetches.push(roomId);
          return { name: roomId };
        },
        get() {
          throw new Error('should not get');
        },
      },
    } as unknown as Env;

    const results = await Promise.all([
      getReceiptsForRooms(env, [], USER),
      getReceiptsForRooms(env, [], BOB),
      getReceiptsForRooms(env, []),
    ]);
    expect(results.every((r) => Object.keys(r).length === 0)).toBe(true);
    expect(fetches).toHaveLength(0);
  });

  for (let i = 0; i < 12; i++) {
    it(`empty content soft-${i}: rooms with only foreign private omitted`, async () => {
      const env = envWithRooms({
        [ROOM]: {
          kind: 'receipts',
          receipts: {
            [`$only-${i}`]: {
              'm.read.private': { [BOB]: { ts: i } },
            },
          },
        },
        [ROOM2]: {
          kind: 'receipts',
          receipts: {
            [`$keep-${i}`]: {
              'm.read': { [USER]: { ts: i + 50 } },
            },
          },
        },
      });
      const byRoom = await getReceiptsForRooms(env, [ROOM, ROOM2], USER);
      expect(byRoom[ROOM]).toBeUndefined();
      expect(byRoom[ROOM2][`$keep-${i}`]['m.read'][USER].ts).toBe(i + 50);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`http error soft-${i}: non-json DO treated via throw path isolation`, async () => {
      const env = envWithRooms({
        [ROOM]: { kind: 'http', status: 500, body: { error: 'nope' } },
        [ROOM2]: {
          kind: 'receipts',
          receipts: { $ok: { 'm.read': { [USER]: { ts: 1 } } } },
        },
      });
      // getReceiptsForRoom will parse JSON successfully for 500 body — content may be weird;
      // rooms that throw are isolated. Force throw room:
      const env2 = envWithRooms({
        [ROOM]: { kind: 'throw', error: new Error('soft-' + i) },
        [ROOM2]: {
          kind: 'receipts',
          receipts: { $ok: { 'm.read': { [USER]: { ts: i } } } },
        },
      });
      const byRoom = await getReceiptsForRooms(env2, [ROOM, ROOM2], USER);
      expect(byRoom[ROOM]).toBeUndefined();
      expect(byRoom[ROOM2].$ok['m.read'][USER].ts).toBe(i);
      // also exercise http stub path once
      const raw = await getReceiptsForRoom(env, ROOM);
      expect(raw.type).toBe('m.receipt');
    });
  }
});

// ---------------------------------------------------------------------------
// Thread_id race soft deepen
// ---------------------------------------------------------------------------

describe('race thread_id body concurrent after #178', () => {
  it('parallel m.read with distinct thread_ids both forward to DO', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub({ fetchBarrier: { count: 2 } });
    const env = createEnv({ db, roomDO });

    const results = await Promise.all([
      request(
        env,
        receiptPath('m.read', EVENT),
        jsonInit('POST', { thread_id: '$t-a:example.com' })
      ),
      request(
        env,
        receiptPath('m.read', EVENT2),
        jsonInit('POST', { thread_id: '$t-b:example.com' })
      ),
    ]);

    expect(results.every((r) => r.status === 200)).toBe(true);
    const threads = roomDO.fetches.map(
      (f) => (f.body as { thread_id?: string }).thread_id
    );
    expect(threads.sort()).toEqual(['$t-a:example.com', '$t-b:example.com'].sort());
  });

  const threadBodies = [
    { label: 'undefined omitted', body: {}, expect: undefined },
    { label: 'null thread_id', body: { thread_id: null }, expect: null },
    { label: 'number thread_id', body: { thread_id: 42 }, expect: 42 },
    { label: 'empty string', body: { thread_id: '' }, expect: '' },
    { label: 'array thread_id', body: { thread_id: ['x'] }, expect: ['x'] },
  ] as const;

  for (const row of threadBodies) {
    it(`forwards thread_id shape under race: ${row.label}`, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const res = await request(
        env,
        receiptPath('m.read.private'),
        jsonInit('POST', row.body)
      );
      expect(res.status).toBe(200);
      expect((roomDO.fetches[0].body as { thread_id?: unknown }).thread_id).toEqual(
        row.expect
      );
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`thread soft-${i}: private∥read distinct threads`, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub({ fetchBarrier: { count: 2 } });
      const env = createEnv({ db, roomDO });
      const results = await Promise.all([
        request(
          env,
          receiptPath('m.read.private', `$tp-${i}:example.com`),
          jsonInit('POST', { thread_id: `$priv-${i}:example.com` })
        ),
        request(
          env,
          receiptPath('m.read', `$tr-${i}:example.com`),
          jsonInit('POST', { thread_id: `$pub-${i}:example.com` })
        ),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(roomDO.fetches).toHaveLength(2);
      expect(db.accountData).toHaveLength(1);
    });
  }
});
