/**
 * TOKENMAXX HEAVY deepen — receipts HTTP API routes.
 * Different slice than account (#103), login (#101), admin (#102), devices/profile (#100).
 * Avoids getReceiptsForRoom helpers (covered in receipts-typing-helpers).
 * Tests-only — no product inventing.
 * Exercises POST receipt + read_markers membership, types, account_data, Room DO.
 */
import { describe, expect, it, vi } from 'vitest';
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

import receiptsApp from '../src/api/receipts';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const ROOM = '!r:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
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

              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 140)}`);
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
              throw new Error(`Unhandled run() SQL: ${sql.slice(0, 140)}`);
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
} = {}) {
  const db = opts.db ?? createReceiptsDb();
  const roomDO = opts.roomDO ?? createRoomDOStub();

  const env = {
    DB: db as unknown as D1Database,
    SERVER_NAME: 'example.com',
    ROOMS: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => roomDO,
    },
    _db: db,
    _roomDO: roomDO,
  };

  return env as unknown as Env & typeof env;
}

async function request(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  const res = await receiptsApp.request(`http://localhost${path}`, init, env);
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

function receiptPath(type: string, eventId = EVENT) {
  return `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/${encodeURIComponent(type)}/${encodeURIComponent(eventId)}`;
}

const markersPath = `/_matrix/client/v3/rooms/${ROOM_ENC}/read_markers`;

function fullyReadContent(eventId: string) {
  return JSON.stringify({ event_id: eventId });
}

describe('POST /rooms/:roomId/receipt/:receiptType/:eventId', () => {
  it('rejects invalid receipt type', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, receiptPath('m.invalid'), jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_INVALID_PARAM',
      error: 'Invalid receipt type: m.invalid',
    });
    expect(roomDO.fetches).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
  });

  it('rejects unknown receipt type strings', async () => {
    const db = joinDb();
    const env = createEnv({ db });
    const res = await request(env, receiptPath('read'), jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('forbids when membership row missing', async () => {
    const db = createReceiptsDb({ memberships: [] });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, receiptPath('m.read'), jsonInit('POST', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Not a member of this room',
    });
    expect(roomDO.fetches).toHaveLength(0);
  });

  it('forbids when membership is invite (not join)', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
    });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, receiptPath('m.read'), jsonInit('POST', {}));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Not a member of this room' });
    expect(roomDO.fetches).toHaveLength(0);
  });

  it('forbids when membership is leave', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const env = createEnv({ db });
    const res = await request(env, receiptPath('m.fully_read'), jsonInit('POST', {}));
    expect(res.status).toBe(403);
  });

  it('m.fully_read stores account_data only (no Room DO fetch)', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, receiptPath('m.fully_read'), jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(roomDO.fetches).toHaveLength(0);
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].sql).toContain('INSERT INTO account_data');
    expect(db.inserts[0].args).toEqual([USER, ROOM, fullyReadContent(EVENT)]);
    expect(db.accountData[0]).toMatchObject({
      user_id: USER,
      room_id: ROOM,
      event_type: 'm.fully_read',
      content: fullyReadContent(EVENT),
    });
  });

  it('m.fully_read upserts existing account_data row', async () => {
    const db = joinDb({
      accountData: [
        {
          user_id: USER,
          room_id: ROOM,
          event_type: 'm.fully_read',
          content: fullyReadContent('$old'),
        },
      ],
    });
    const env = createEnv({ db });
    const res = await request(env, receiptPath('m.fully_read', EVENT2), jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(db.accountData).toHaveLength(1);
    expect(db.accountData[0].content).toBe(fullyReadContent(EVENT2));
  });

  it('m.read stores Room DO receipt and also m.fully_read account_data', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, receiptPath('m.read'), jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(roomDO.fetches).toHaveLength(1);
    expect(roomDO.fetches[0].method).toBe('PUT');
    expect(roomDO.fetches[0].url).toContain('/receipt');
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      event_id: EVENT,
      receipt_type: 'm.read',
    });
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].args).toEqual([USER, ROOM, fullyReadContent(EVENT)]);
  });

  it('m.read.private stores Room DO only (no fully_read account_data)', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, receiptPath('m.read.private'), jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(roomDO.fetches).toHaveLength(1);
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      event_id: EVENT,
      receipt_type: 'm.read.private',
    });
    expect(db.inserts).toHaveLength(0);
    expect(db.accountData).toHaveLength(0);
  });

  it('forwards optional body.thread_id to Room DO for m.read', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(
      env,
      receiptPath('m.read'),
      jsonInit('POST', { thread_id: THREAD })
    );
    expect(res.status).toBe(200);
    expect(roomDO.fetches[0].body).toMatchObject({
      receipt_type: 'm.read',
      thread_id: THREAD,
      event_id: EVENT,
      user_id: USER,
    });
  });

  it('forwards thread_id for m.read.private', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    await request(env, receiptPath('m.read.private'), jsonInit('POST', { thread_id: THREAD }));
    expect(roomDO.fetches[0].body).toMatchObject({
      receipt_type: 'm.read.private',
      thread_id: THREAD,
    });
  });

  it('accepts empty JSON body {}', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, receiptPath('m.read'), jsonInit('POST', {}));
    expect(res.status).toBe(200);
    // JSON.stringify drops undefined thread_id — body has no thread_id key
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      event_id: EVENT,
      receipt_type: 'm.read',
    });
  });

  it('accepts missing body (no Content-Type / no body)', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, receiptPath('m.read'), {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    expect(roomDO.fetches).toHaveLength(1);
    expect(db.inserts).toHaveLength(1);
  });

  it('accepts invalid JSON body as optional (body parse catch)', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, receiptPath('m.read.private'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: 'not-json',
    });
    expect(res.status).toBe(200);
    expect(roomDO.fetches).toHaveLength(1);
    expect(db.inserts).toHaveLength(0);
  });

  it('m.fully_read ignores thread_id for DO (still no DO call)', async () => {
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
    expect(db.inserts[0].args[2]).toBe(fullyReadContent(EVENT));
  });

  it('uses room_id and user_id from path / auth for membership check', async () => {
    const db = joinDb();
    const env = createEnv({ db });
    await request(env, receiptPath('m.read'), jsonInit('POST', {}));
    const membershipSelect = db.selects.find((s) => s.sql.includes('room_memberships'));
    expect(membershipSelect?.args).toEqual([ROOM, USER]);
  });
});

describe('POST /rooms/:roomId/read_markers', () => {
  it('rejects bad JSON', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, markersPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: '{bad',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
    expect(roomDO.fetches).toHaveLength(0);
  });

  it('forbids when not a member', async () => {
    const db = createReceiptsDb({ memberships: [] });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, markersPath, jsonInit('POST', { 'm.read': EVENT }));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Not a member of this room',
    });
    expect(roomDO.fetches).toHaveLength(0);
  });

  it('forbids invite membership', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
    });
    const env = createEnv({ db });
    const res = await request(env, markersPath, jsonInit('POST', { 'm.fully_read': EVENT }));
    expect(res.status).toBe(403);
  });

  it('stores m.fully_read only in account_data (still obtains Room DO stub)', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, markersPath, jsonInit('POST', { 'm.fully_read': EVENT }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].args).toEqual([USER, ROOM, fullyReadContent(EVENT)]);
    // getRoomDO is called but no receipt fetch without m.read / m.read.private
    expect(roomDO.fetches).toHaveLength(0);
  });

  it('m.read stores DO receipt and auto-updates fully_read when fully_read omitted', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, markersPath, jsonInit('POST', { 'm.read': EVENT }));
    expect(res.status).toBe(200);
    expect(roomDO.fetches).toHaveLength(1);
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      event_id: EVENT,
      receipt_type: 'm.read',
    });
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].args).toEqual([USER, ROOM, fullyReadContent(EVENT)]);
  });

  it('m.read + explicit fully_read does not auto-overwrite fully_read to m.read value', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(
      env,
      markersPath,
      jsonInit('POST', {
        'm.fully_read': EVENT2,
        'm.read': EVENT,
      })
    );
    expect(res.status).toBe(200);
    expect(roomDO.fetches).toHaveLength(1);
    expect(roomDO.fetches[0].body).toMatchObject({
      event_id: EVENT,
      receipt_type: 'm.read',
    });
    // Only one account_data insert — the explicit fully_read (EVENT2), not auto from m.read
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].args).toEqual([USER, ROOM, fullyReadContent(EVENT2)]);
    expect(db.accountData[0].content).toBe(fullyReadContent(EVENT2));
  });

  it('m.read.private only stores DO receipt (no account_data)', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(
      env,
      markersPath,
      jsonInit('POST', { 'm.read.private': EVENT3 })
    );
    expect(res.status).toBe(200);
    expect(roomDO.fetches).toHaveLength(1);
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      event_id: EVENT3,
      receipt_type: 'm.read.private',
    });
    expect(db.inserts).toHaveLength(0);
  });

  it('combination: fully_read + m.read.private', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(
      env,
      markersPath,
      jsonInit('POST', {
        'm.fully_read': EVENT,
        'm.read.private': EVENT2,
      })
    );
    expect(res.status).toBe(200);
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].args[2]).toBe(fullyReadContent(EVENT));
    expect(roomDO.fetches).toHaveLength(1);
    expect(roomDO.fetches[0].body).toMatchObject({
      receipt_type: 'm.read.private',
      event_id: EVENT2,
    });
  });

  it('combination: m.read + m.read.private with auto fully_read', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(
      env,
      markersPath,
      jsonInit('POST', {
        'm.read': EVENT,
        'm.read.private': EVENT2,
      })
    );
    expect(res.status).toBe(200);
    expect(roomDO.fetches).toHaveLength(2);
    expect(roomDO.fetches[0].body).toMatchObject({ receipt_type: 'm.read', event_id: EVENT });
    expect(roomDO.fetches[1].body).toMatchObject({
      receipt_type: 'm.read.private',
      event_id: EVENT2,
    });
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].args[2]).toBe(fullyReadContent(EVENT));
  });

  it('combination: all three markers with explicit fully_read (no auto overwrite)', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(
      env,
      markersPath,
      jsonInit('POST', {
        'm.fully_read': EVENT3,
        'm.read': EVENT,
        'm.read.private': EVENT2,
      })
    );
    expect(res.status).toBe(200);
    expect(roomDO.fetches).toHaveLength(2);
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].args[2]).toBe(fullyReadContent(EVENT3));
  });

  it('empty object body succeeds with no writes', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, markersPath, jsonInit('POST', {}));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.inserts).toHaveLength(0);
    expect(roomDO.fetches).toHaveLength(0);
  });

  it('membership query uses ROOM and USER constants', async () => {
    const db = joinDb();
    const env = createEnv({ db });
    await request(env, markersPath, jsonInit('POST', { 'm.read': EVENT }));
    const sel = db.selects.find((s) => s.sql.includes('room_memberships'));
    expect(sel?.args).toEqual([ROOM, USER]);
  });

  it('does not confuse Bob membership with Alice auth user', async () => {
    const db = createReceiptsDb({
      memberships: [{ room_id: ROOM, user_id: BOB, membership: 'join' }],
    });
    const env = createEnv({ db });
    const res = await request(env, markersPath, jsonInit('POST', { 'm.read': EVENT }));
    expect(res.status).toBe(403);
  });
});
