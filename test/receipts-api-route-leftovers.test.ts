/**
 * TOKENMAXX HEAVY leftovers — receipts HTTP + sync helper edges after #168.
 * Complements receipts-api-routes, receipts-typing-helpers, presence-typing leftovers (#166),
 * and presence-receipts-typing-todevice soft floods. Distinct slice: membership/type matrices,
 * thread_id body edges, fully_read overwrite races, Room DO payload contracts, private-filter
 * sync helpers, multi-room isolation. Tests-only — no product inventing. example.com only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { getReceiptsForRoom, getReceiptsForRooms } from '../src/api/receipts';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICEA');
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
const EVENT = '$event1:example.com';
const EVENT2 = '$event2:example.com';
const EVENT3 = '$event3:example.com';
const THREAD = '$thread1:example.com';

type Membership = { room_id: string; user_id: string; membership: string };
type AccountDataRow = {
  user_id: string;
  room_id: string;
  event_type: string;
  content: string;
};
type SqlCall = { sql: string; args: unknown[] };
type RoomFetch = { url: string; method: string; body?: unknown };

type ReceiptBlob = Record<
  string,
  Record<string, Record<string, { ts: number; thread_id?: string }>>
>;

function createRoomDOStub() {
  const fetches: RoomFetch[] = [];
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
      fetches.push({ url: req.url, method: req.method, body });
      return Response.json({ ok: true });
    },
  };
}

type RoomDOStub = ReturnType<typeof createRoomDOStub>;

function createReceiptsDb(opts: {
  memberships?: Membership[];
  accountData?: AccountDataRow[];
} = {}) {
  const memberships = opts.memberships ?? [];
  const accountData = opts.accountData ?? [];
  const inserts: SqlCall[] = [];
  const selects: SqlCall[] = [];

  const db = {
    memberships,
    accountData,
    inserts,
    selects,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              if (sql.includes('FROM room_memberships')) {
                const [roomId, userId] = args as string[];
                const row = memberships.find(
                  (m) => m.room_id === roomId && m.user_id === userId
                );
                return (row ? { membership: row.membership } : null) as T;
              }
              throw new Error('Unhandled first() SQL: ' + sql.slice(0, 140));
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              if (sql.includes('INSERT INTO account_data')) {
                inserts.push({ sql, args });
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
): Promise<{ status: number; body: unknown }> {
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
  return { status: res.status, body };
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

function joinDb(extra?: Partial<Parameters<typeof createReceiptsDb>[0]>) {
  return createReceiptsDb({
    memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
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
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});


describe('receipts leftovers membership status matrix', () => {
  const statuses = [
    'invite',
    'leave',
    'ban',
    'knock',
    'JOIN',
    'joined',
    'Leave',
    '',
    'forbidden',
    'member',
  ] as const;

  it.each(statuses)('POST receipt forbids membership=%s', async (status) => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: status }],
    });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, receiptPath('m.read'), jsonInit('POST', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Not a member of this room',
    });
    expect(roomDO.fetches).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
  });

  it.each(statuses)('POST read_markers forbids membership=%s', async (status) => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: status }],
    });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(
      env,
      markersPath,
      jsonInit('POST', { 'm.read': EVENT, 'm.fully_read': EVENT2 })
    );
    expect(res.status).toBe(403);
    expect(roomDO.fetches).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
  });

  it('missing membership row forbids receipt', async () => {
    const db = createReceiptsDb({ memberships: [] });
    const env = createEnv({ db });
    const res = await request(env, receiptPath('m.fully_read'), jsonInit('POST', {}));
    expect(res.status).toBe(403);
  });

  it('Bob join does not authorize Alice receipt', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: BOB, membership: 'join' }],
    });
    const env = createEnv({ db });
    expect((await request(env, receiptPath('m.read'), jsonInit('POST', {}))).status).toBe(403);
  });

  it('join in ROOM2 does not authorize receipt in ROOM', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM2, user_id: USER, membership: 'join' }],
    });
    const env = createEnv({ db });
    expect((await request(env, receiptPath('m.read'), jsonInit('POST', {}))).status).toBe(403);
  });
});


describe('receipts leftovers invalid receipt type vocabulary', () => {
  const invalid = [
  "m.read.public",
  "m.receipt",
  "read",
  "m.fully_read.private",
  "M.read",
  "m.Read",
  "m.read ",
  " m.read",
  "null",
  "undefined",
  "0",
  "true",
  "m.typing",
  "m.presence",
  "fully_read",
  "m.fullyread",
  "m.private",
  "private",
  "m.read.private.extra",
  "m.read/../x",
  "../m.read",
  "m.read.private ",
  "m.fully_read ",
  "receipt"
] as const;

  it.each(invalid)('rejects type %j with M_INVALID_PARAM', async (type) => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, receiptPath(type), jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_INVALID_PARAM',
      error: `Invalid receipt type: ${type}`,
    });
    expect(roomDO.fetches).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
  });

  it.each(['m.read', 'm.read.private', 'm.fully_read'] as const)(
    'still accepts valid type %s',
    async (type) => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const res = await request(env, receiptPath(type), jsonInit('POST', {}));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({});
    }
  );
});


describe('receipts leftovers thread_id body edges', () => {
  const threadValues: Array<{ label: string; body: unknown; expectThread?: unknown }> = [
    { label: 'string thread', body: { thread_id: THREAD }, expectThread: THREAD },
    { label: 'empty string', body: { thread_id: '' }, expectThread: '' },
    { label: 'null thread_id', body: { thread_id: null }, expectThread: null },
    { label: 'numeric thread_id', body: { thread_id: 42 }, expectThread: 42 },
    { label: 'boolean thread_id', body: { thread_id: true }, expectThread: true },
    { label: 'array thread_id', body: { thread_id: ['$t'] }, expectThread: ['$t'] },
    { label: 'object thread_id', body: { thread_id: { id: THREAD } }, expectThread: { id: THREAD } },
    { label: 'extra keys ignored path', body: { thread_id: THREAD, extra: 1 }, expectThread: THREAD },
    { label: 'main timeline sentinel', body: { thread_id: 'main' }, expectThread: 'main' },
  ];

  for (const row of threadValues) {
    it(`m.read forwards thread_id: ${row.label}`, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const res = await request(env, receiptPath('m.read'), jsonInit('POST', row.body));
      expect(res.status).toBe(200);
      expect(roomDO.fetches[0].body).toMatchObject({
        user_id: USER,
        event_id: EVENT,
        receipt_type: 'm.read',
        thread_id: row.expectThread,
      });
      expect(db.inserts).toHaveLength(1);
    });

    it(`m.read.private forwards thread_id: ${row.label}`, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const res = await request(
        env,
        receiptPath('m.read.private'),
        jsonInit('POST', row.body)
      );
      expect(res.status).toBe(200);
      expect(roomDO.fetches[0].body).toMatchObject({
        receipt_type: 'm.read.private',
        thread_id: row.expectThread,
      });
      expect(db.inserts).toHaveLength(0);
    });
  }

  it('m.fully_read ignores thread_id (account_data only)', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(
      env,
      receiptPath('m.fully_read'),
      jsonInit('POST', { thread_id: THREAD })
    );
    expect(res.status).toBe(200);
    expect(roomDO.fetches).toHaveLength(0);
    expect(db.inserts[0].args).toEqual([USER, ROOM, fullyReadContent(EVENT)]);
  });

  it('invalid JSON body still succeeds for receipt (optional body)', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, receiptPath('m.read'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: '{not-json',
    });
    expect(res.status).toBe(200);
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      event_id: EVENT,
      receipt_type: 'm.read',
    });
  });

  it('empty body string treated as optional parse failure', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, receiptPath('m.read.private'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: '',
    });
    expect(res.status).toBe(200);
    expect(roomDO.fetches).toHaveLength(1);
  });
});


describe('receipts leftovers eventId path matrix', () => {
  const eventIds = ["$evt-0:example.com","$evt-1:example.com","$evt-2:example.com","$evt-3:example.com","$evt-4:example.com","$evt-5:example.com","$evt-6:example.com","$evt-7:example.com","$evt-8:example.com","$evt-9:example.com","$evt-10:example.com","$evt-11:example.com","$evt-12:example.com","$evt-13:example.com","$evt-14:example.com","$evt-15:example.com","$evt-16:example.com","$evt-17:example.com","$evt-18:example.com","$evt-19:example.com","$weird+chars/here:example.com","$long-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:example.com"] as const;

  it.each(eventIds)('m.read stores eventId %j in DO + fully_read', async (eventId) => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, receiptPath('m.read', eventId), jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(roomDO.fetches[0].body).toMatchObject({
      event_id: eventId,
      receipt_type: 'm.read',
    });
    expect(db.inserts[0].args[2]).toBe(fullyReadContent(eventId));
  });

  it.each(eventIds.slice(0, 12))('m.fully_read stores eventId %j', async (eventId) => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, receiptPath('m.fully_read', eventId), jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(roomDO.fetches).toHaveLength(0);
    expect(db.accountData[0].content).toBe(fullyReadContent(eventId));
  });
});


describe('receipts leftovers fully_read overwrite races', () => {
  it('sequential m.fully_read advances marker', async () => {
    const db = joinDb();
    const env = createEnv({ db });
    for (const eid of [EVENT, EVENT2, EVENT3]) {
      const res = await request(env, receiptPath('m.fully_read', eid), jsonInit('POST', {}));
      expect(res.status).toBe(200);
      expect(db.accountData).toHaveLength(1);
      expect(db.accountData[0].content).toBe(fullyReadContent(eid));
    }
    expect(db.inserts).toHaveLength(3);
  });

  it('m.read then m.fully_read overwrites auto marker', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    await request(env, receiptPath('m.read', EVENT), jsonInit('POST', {}));
    expect(db.accountData[0].content).toBe(fullyReadContent(EVENT));
    await request(env, receiptPath('m.fully_read', EVENT2), jsonInit('POST', {}));
    expect(db.accountData).toHaveLength(1);
    expect(db.accountData[0].content).toBe(fullyReadContent(EVENT2));
    expect(roomDO.fetches).toHaveLength(1);
  });

  it('m.fully_read then m.read overwrites to m.read event', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    await request(env, receiptPath('m.fully_read', EVENT), jsonInit('POST', {}));
    await request(env, receiptPath('m.read', EVENT2), jsonInit('POST', {}));
    expect(db.accountData[0].content).toBe(fullyReadContent(EVENT2));
    expect(roomDO.fetches).toHaveLength(1);
  });

  it('m.read.private never touches fully_read across repeats', async () => {
    const db = joinDb({
      accountData: [
        {
          user_id: USER,
          room_id: ROOM,
          event_type: 'm.fully_read',
          content: fullyReadContent(EVENT),
        },
      ],
    });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    for (let i = 0; i < 8; i++) {
      await request(
        env,
        receiptPath('m.read.private', '$p' + i + ':example.com'),
        jsonInit('POST', { thread_id: '$t' + i + ':example.com' })
      );
    }
    expect(roomDO.fetches).toHaveLength(8);
    expect(db.inserts).toHaveLength(0);
    expect(db.accountData[0].content).toBe(fullyReadContent(EVENT));
  });

  for (let i = 0; i < 16; i++) {
    it('overwrite race soft-' + i + ': m.read then explicit fully_read', async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const readEid = '$read-' + i + ':example.com';
      const fullEid = '$full-' + i + ':example.com';
      await request(env, receiptPath('m.read', readEid), jsonInit('POST', {}));
      await request(env, markersPath, jsonInit('POST', { 'm.fully_read': fullEid }));
      expect(db.accountData[0].content).toBe(fullyReadContent(fullEid));
      expect(roomDO.fetches[0].body).toMatchObject({
        event_id: readEid,
        receipt_type: 'm.read',
      });
    });
  }
});


describe('receipts leftovers read_markers combination matrix', () => {
  const combos: Array<{
    label: string;
    body: Record<string, string>;
    doCount: number;
    accountCount: number;
    fully?: string;
  }> = [
    { label: 'empty', body: {}, doCount: 0, accountCount: 0 },
    { label: 'fully only', body: { 'm.fully_read': EVENT }, doCount: 0, accountCount: 1, fully: EVENT },
    { label: 'read only', body: { 'm.read': EVENT }, doCount: 1, accountCount: 1, fully: EVENT },
    {
      label: 'private only',
      body: { 'm.read.private': EVENT },
      doCount: 1,
      accountCount: 0,
    },
    {
      label: 'fully+read same',
      body: { 'm.fully_read': EVENT, 'm.read': EVENT },
      doCount: 1,
      accountCount: 1,
      fully: EVENT,
    },
    {
      label: 'fully+read different',
      body: { 'm.fully_read': EVENT2, 'm.read': EVENT },
      doCount: 1,
      accountCount: 1,
      fully: EVENT2,
    },
    {
      label: 'fully+private',
      body: { 'm.fully_read': EVENT, 'm.read.private': EVENT2 },
      doCount: 1,
      accountCount: 1,
      fully: EVENT,
    },
    {
      label: 'read+private',
      body: { 'm.read': EVENT, 'm.read.private': EVENT2 },
      doCount: 2,
      accountCount: 1,
      fully: EVENT,
    },
    {
      label: 'all three',
      body: { 'm.fully_read': EVENT3, 'm.read': EVENT, 'm.read.private': EVENT2 },
      doCount: 2,
      accountCount: 1,
      fully: EVENT3,
    },
  ];

  for (const c of combos) {
    it('combo: ' + c.label, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const res = await request(env, markersPath, jsonInit('POST', c.body));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({});
      expect(roomDO.fetches).toHaveLength(c.doCount);
      expect(db.inserts).toHaveLength(c.accountCount);
      if (c.fully) {
        expect(db.accountData[0].content).toBe(fullyReadContent(c.fully));
      }
    });
  }

  it('falsy empty-string m.read is skipped (no DO / no auto fully_read)', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, markersPath, jsonInit('POST', { 'm.read': '' }));
    expect(res.status).toBe(200);
    expect(roomDO.fetches).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
  });

  it('falsy empty-string m.fully_read is skipped', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, markersPath, jsonInit('POST', { 'm.fully_read': '' }));
    expect(res.status).toBe(200);
    expect(db.inserts).toHaveLength(0);
  });

  it('falsy empty-string m.read.private is skipped', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, markersPath, jsonInit('POST', { 'm.read.private': '' }));
    expect(res.status).toBe(200);
    expect(roomDO.fetches).toHaveLength(0);
  });

  it('empty m.read with explicit fully_read only writes fully_read', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(
      env,
      markersPath,
      jsonInit('POST', { 'm.read': '', 'm.fully_read': EVENT })
    );
    expect(res.status).toBe(200);
    expect(roomDO.fetches).toHaveLength(0);
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].args[2]).toBe(fullyReadContent(EVENT));
  });

  it('read_markers bad JSON is M_BAD_JSON (unlike receipt optional body)', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, markersPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
    expect(roomDO.fetches).toHaveLength(0);
  });

  for (let i = 0; i < 12; i++) {
    it('read_markers soft combo flood-' + i, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const readEid = '$rm-read-' + i + ':example.com';
      const privEid = '$rm-priv-' + i + ':example.com';
      const fullEid = '$rm-full-' + i + ':example.com';
      const res = await request(
        env,
        markersPath,
        jsonInit('POST', {
          'm.read': readEid,
          'm.read.private': privEid,
          'm.fully_read': fullEid,
        })
      );
      expect(res.status).toBe(200);
      expect(roomDO.fetches).toHaveLength(2);
      expect(roomDO.fetches[0].body).toMatchObject({
        event_id: readEid,
        receipt_type: 'm.read',
      });
      expect(roomDO.fetches[1].body).toMatchObject({
        event_id: privEid,
        receipt_type: 'm.read.private',
      });
      expect(db.inserts[0].args[2]).toBe(fullyReadContent(fullEid));
    });
  }
});


describe('receipts leftovers Room DO and SQL bind contracts', () => {
  it('idFromName uses roomId from path for m.read', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    await request(env, receiptPath('m.read'), jsonInit('POST', {}));
    expect(env._idCalls).toEqual([ROOM]);
  });

  it('idFromName uses roomId for read_markers even when only fully_read', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    await request(env, markersPath, jsonInit('POST', { 'm.fully_read': EVENT }));
    expect(env._idCalls).toEqual([ROOM]);
    expect(roomDO.fetches).toHaveLength(0);
  });

  it('m.fully_read receipt path never calls idFromName', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    await request(env, receiptPath('m.fully_read'), jsonInit('POST', {}));
    expect(env._idCalls).toEqual([]);
  });

  it('account_data INSERT SQL contains ON CONFLICT upsert', async () => {
    const db = joinDb();
    const env = createEnv({ db });
    await request(env, receiptPath('m.fully_read'), jsonInit('POST', {}));
    expect(db.inserts[0].sql).toContain('INSERT INTO account_data');
    expect(db.inserts[0].sql).toContain('ON CONFLICT');
    expect(db.inserts[0].sql).toContain('m.fully_read');
    expect(db.inserts[0].args).toEqual([USER, ROOM, fullyReadContent(EVENT)]);
  });

  it('membership SELECT binds room then user', async () => {
    const db = joinDb();
    const env = createEnv({ db });
    await request(env, receiptPath('m.read'), jsonInit('POST', {}));
    const sel = db.selects.find((s) => s.sql.includes('room_memberships'));
    expect(sel?.args).toEqual([ROOM, USER]);
  });

  it('isolates account_data per room on sequential writes', async () => {
    const db = createReceiptsDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: ROOM2, user_id: USER, membership: 'join' },
      ],
    });
    const do1 = createRoomDOStub();
    const do2 = createRoomDOStub();
    const env = createEnv({
      db,
      roomById: { [ROOM]: do1, [ROOM2]: do2 },
    });
    await request(env, receiptPath('m.read', EVENT), jsonInit('POST', {}));
    await request(
      env,
      '/_matrix/client/v3/rooms/' +
        ROOM2_ENC +
        '/receipt/m.read/' +
        encodeURIComponent(EVENT2),
      jsonInit('POST', {})
    );
    expect(db.accountData).toHaveLength(2);
    expect(db.accountData.find((a) => a.room_id === ROOM)?.content).toBe(
      fullyReadContent(EVENT)
    );
    expect(db.accountData.find((a) => a.room_id === ROOM2)?.content).toBe(
      fullyReadContent(EVENT2)
    );
    expect(do1.fetches).toHaveLength(1);
    expect(do2.fetches).toHaveLength(1);
  });

  it('read_markers room isolation: ROOM2 markers do not touch ROOM DO', async () => {
    const db = createReceiptsDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: ROOM2, user_id: USER, membership: 'join' },
      ],
    });
    const do1 = createRoomDOStub();
    const do2 = createRoomDOStub();
    const env = createEnv({
      db,
      roomById: { [ROOM]: do1, [ROOM2]: do2 },
    });
    await request(env, markersPath2, jsonInit('POST', { 'm.read': EVENT3 }));
    expect(do1.fetches).toHaveLength(0);
    expect(do2.fetches).toHaveLength(1);
    expect(do2.fetches[0].body).toMatchObject({
      event_id: EVENT3,
      receipt_type: 'm.read',
    });
  });

  for (let i = 0; i < 10; i++) {
    it('DO payload contract soft-' + i, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const eid = '$do-' + i + ':example.com';
      const tid = '$thr-' + i + ':example.com';
      await request(
        env,
        receiptPath('m.read', eid),
        jsonInit('POST', { thread_id: tid })
      );
      expect(roomDO.fetches[0]).toMatchObject({
        method: 'PUT',
        body: {
          user_id: USER,
          event_id: eid,
          receipt_type: 'm.read',
          thread_id: tid,
        },
      });
      expect(roomDO.fetches[0].url).toContain('/receipt');
    });
  }
});


describe('receipts leftovers getReceiptsForRoom private-filter matrix', () => {
  const users = [USER, BOB, CAROL] as const;

  it.each(users)('requester %s only sees own private receipts', async (requester) => {
    const receipts: ReceiptBlob = {
      '$shared': {
        'm.read': {
          [USER]: { ts: 1 },
          [BOB]: { ts: 2 },
          [CAROL]: { ts: 3 },
        },
        'm.read.private': {
          [USER]: { ts: 11, thread_id: '$ta' },
          [BOB]: { ts: 22, thread_id: '$tb' },
          [CAROL]: { ts: 33 },
        },
      },
    };
    const env = envWithRooms({ [ROOM]: { kind: 'receipts', receipts } });
    const result = await getReceiptsForRoom(env, ROOM, requester);
    expect(result.type).toBe('m.receipt');
    expect(result.content['$shared']['m.read']).toEqual(receipts['$shared']['m.read']);
    expect(result.content['$shared']['m.read.private']).toEqual({
      [requester]: receipts['$shared']['m.read.private'][requester],
    });
  });

  it('omits events that only contain other users private receipts', async () => {
    const env = envWithRooms({
      [ROOM]: {
        kind: 'receipts',
        receipts: {
          '$gone': {
            'm.read.private': { [BOB]: { ts: 9 } },
          },
          '$keep': {
            'm.read.private': { [USER]: { ts: 8 } },
          },
        },
      },
    });
    const result = await getReceiptsForRoom(env, ROOM, USER);
    expect(result.content['$gone']).toBeUndefined();
    expect(result.content['$keep']).toEqual({
      'm.read.private': { [USER]: { ts: 8 } },
    });
  });

  it('unfiltered path returns all private receipts', async () => {
    const receipts: ReceiptBlob = {
      '$e': {
        'm.read.private': {
          [USER]: { ts: 1 },
          [BOB]: { ts: 2 },
        },
      },
    };
    const env = envWithRooms({ [ROOM]: { kind: 'receipts', receipts } });
    const result = await getReceiptsForRoom(env, ROOM);
    expect(result.content).toEqual(receipts);
  });

  for (let i = 0; i < 12; i++) {
    it('private filter soft-' + i + ' preserves public + own private', async () => {
      const pubTs = 1000 + i;
      const privTs = 2000 + i;
      const tid = '$t-' + i + ':example.com';
      const env = envWithRooms({
        [ROOM]: {
          kind: 'receipts',
          receipts: {
            ['$e-' + i]: {
              'm.read': { [USER]: { ts: pubTs }, [BOB]: { ts: pubTs + 1 } },
              'm.read.private': {
                [USER]: { ts: privTs, thread_id: tid },
                [BOB]: { ts: privTs + 5 },
              },
            },
          },
        },
      });
      const result = await getReceiptsForRoom(env, ROOM, USER);
      expect(result.content['$e-' + i]).toEqual({
        'm.read': { [USER]: { ts: pubTs }, [BOB]: { ts: pubTs + 1 } },
        'm.read.private': { [USER]: { ts: privTs, thread_id: tid } },
      });
    });
  }
});

describe('receipts leftovers getReceiptsForRooms multi-room edges', () => {
  it('returns {} for empty room list', async () => {
    expect(await getReceiptsForRooms(envWithRooms({}), [], USER)).toEqual({});
  });

  it('aggregates multiple rooms with private filtering', async () => {
    const env = envWithRooms({
      [ROOM]: {
        kind: 'receipts',
        receipts: {
          '$a': {
            'm.read': { [USER]: { ts: 1 } },
            'm.read.private': { [USER]: { ts: 2 }, [BOB]: { ts: 3 } },
          },
        },
      },
      [ROOM2]: {
        kind: 'receipts',
        receipts: {
          '$b': {
            'm.read.private': { [BOB]: { ts: 4 } },
          },
        },
      },
      [ROOM3]: {
        kind: 'receipts',
        receipts: {
          '$c': { 'm.read': { [CAROL]: { ts: 5 } } },
        },
      },
    });
    const result = await getReceiptsForRooms(env, [ROOM, ROOM2, ROOM3], USER);
    expect(Object.keys(result).sort()).toEqual([ROOM, ROOM3].sort());
    expect(result[ROOM]['$a']['m.read.private']).toEqual({ [USER]: { ts: 2 } });
    expect(result[ROOM2]).toBeUndefined();
    expect(result[ROOM3]['$c']['m.read'][CAROL].ts).toBe(5);
  });

  it('isolates DO throw to omit that room only', async () => {
    const env = envWithRooms({
      [ROOM]: { kind: 'throw', error: new Error('boom') },
      [ROOM2]: {
        kind: 'receipts',
        receipts: { '$e': { 'm.read': { [USER]: { ts: 1 } } } },
      },
    });
    const result = await getReceiptsForRooms(env, [ROOM, ROOM2], USER);
    expect(result[ROOM]).toBeUndefined();
    expect(result[ROOM2]['$e']['m.read'][USER].ts).toBe(1);
  });

  it('fetches rooms in parallel', async () => {
    const seen: string[] = [];
    const env = {
      ROOMS: {
        idFromName(roomId: string) {
          return { name: roomId };
        },
        get(id: { name: string }) {
          return {
            async fetch() {
              seen.push(id.name);
              await new Promise((r) => setTimeout(r, 8));
              return new Response(
                JSON.stringify({
                  receipts: {
                    '$e': { 'm.read': { [USER]: { ts: seen.length } } },
                  },
                }),
                { headers: { 'Content-Type': 'application/json' } }
              );
            },
          };
        },
      },
    } as unknown as Env;
    const rooms = [ROOM, ROOM2, ROOM3];
    const result = await getReceiptsForRooms(env, rooms, USER);
    expect(seen.sort()).toEqual(rooms.slice().sort());
    expect(Object.keys(result).sort()).toEqual(rooms.slice().sort());
  });

  for (let i = 0; i < 10; i++) {
    it('multi-room soft-' + i + ' omits empty filtered rooms', async () => {
      const env = envWithRooms({
        [ROOM]: {
          kind: 'receipts',
          receipts: {
            '$only-bob': { 'm.read.private': { [BOB]: { ts: i } } },
          },
        },
        [ROOM2]: {
          kind: 'receipts',
          receipts: {
            '$alice': { 'm.read': { [USER]: { ts: 100 + i } } },
          },
        },
      });
      const result = await getReceiptsForRooms(env, [ROOM, ROOM2], USER);
      expect(result[ROOM]).toBeUndefined();
      expect(result[ROOM2]['$alice']['m.read'][USER].ts).toBe(100 + i);
    });
  }
});


describe('receipts leftovers side-effect contracts soft deepen', () => {
  for (let i = 0; i < 16; i++) {
    it('m.read side-effects soft-' + i, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const eid = '$side-read-' + i + ':example.com';
      const res = await request(env, receiptPath('m.read', eid), jsonInit('POST', {}));
      expect(res.status).toBe(200);
      expect(roomDO.fetches).toHaveLength(1);
      expect(db.inserts).toHaveLength(1);
      expect(db.inserts[0].args).toEqual([USER, ROOM, fullyReadContent(eid)]);
      expect(roomDO.fetches[0].body).toEqual({
        user_id: USER,
        event_id: eid,
        receipt_type: 'm.read',
      });
    });
  }

  for (let i = 0; i < 12; i++) {
    it('m.read.private no account_data soft-' + i, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const eid = '$side-priv-' + i + ':example.com';
      const res = await request(
        env,
        receiptPath('m.read.private', eid),
        jsonInit('POST', { thread_id: '$tp-' + i + ':example.com' })
      );
      expect(res.status).toBe(200);
      expect(db.inserts).toHaveLength(0);
      expect(roomDO.fetches[0].body).toMatchObject({
        event_id: eid,
        receipt_type: 'm.read.private',
        thread_id: '$tp-' + i + ':example.com',
      });
    });
  }

  for (let i = 0; i < 12; i++) {
    it('m.fully_read account_data-only soft-' + i, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const eid = '$side-full-' + i + ':example.com';
      const res = await request(env, receiptPath('m.fully_read', eid), jsonInit('POST', {}));
      expect(res.status).toBe(200);
      expect(roomDO.fetches).toHaveLength(0);
      expect(env._idCalls).toEqual([]);
      expect(db.accountData[0]).toMatchObject({
        user_id: USER,
        room_id: ROOM,
        event_type: 'm.fully_read',
        content: fullyReadContent(eid),
      });
    });
  }
});
