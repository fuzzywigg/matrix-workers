/**
 * TOKENMAXX HEAVY deepen — different slice: typing HTTP API routes.
 * Avoids getTypingUsers / getTypingForRooms helpers (receipts-typing-helpers).
 * Tests-only — no product inventing.
 * Exercises PUT typing own-user gate, membership, JSON, timeout caps, Room DO.
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

import typingApp from '../src/api/typing';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const ROOM = '!r:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const USER_ENC = encodeURIComponent(USER);
const BOB_ENC = encodeURIComponent(BOB);

type Membership = { room_id: string; user_id: string; membership: string };

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

function createTypingDb(opts: { memberships?: Membership[] } = {}) {
  const memberships = opts.memberships ?? [];
  const selects: SqlCall[] = [];

  const db = {
    memberships,
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
              throw new Error(`Unexpected run() SQL: ${sql.slice(0, 140)}`);
            },
          };
        },
      };
    },
  };

  return db;
}

type TypingDb = ReturnType<typeof createTypingDb>;

function createEnv(opts: { db?: TypingDb; roomDO?: RoomDOStub } = {}) {
  const db = opts.db ?? createTypingDb();
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
  const res = await typingApp.request(`http://localhost${path}`, init, env);
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

function joinDb() {
  return createTypingDb({
    memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
  });
}

function typingPath(userIdEnc = USER_ENC) {
  return `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${userIdEnc}`;
}

describe('PUT /rooms/:roomId/typing/:userId', () => {
  it('forbids setting typing for another user', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, typingPath(BOB_ENC), jsonInit('PUT', { typing: true }));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot set typing status for other users',
    });
    expect(roomDO.fetches).toHaveLength(0);
    expect(db.selects).toHaveLength(0);
  });

  it('forbids even when Bob is a join member (own-user gate first)', async () => {
    const db = createTypingDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: ROOM, user_id: BOB, membership: 'join' },
      ],
    });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, typingPath(BOB_ENC), jsonInit('PUT', { typing: false }));
    expect(res.status).toBe(403);
    expect(roomDO.fetches).toHaveLength(0);
  });

  it('forbids when membership row missing', async () => {
    const db = createTypingDb({ memberships: [] });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, typingPath(), jsonInit('PUT', { typing: true }));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Not a member of this room',
    });
    expect(roomDO.fetches).toHaveLength(0);
  });

  it('forbids invite membership (join required)', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
    });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, typingPath(), jsonInit('PUT', { typing: true }));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Not a member of this room' });
    expect(roomDO.fetches).toHaveLength(0);
  });

  it('forbids leave membership', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const env = createEnv({ db });
    const res = await request(env, typingPath(), jsonInit('PUT', { typing: true }));
    expect(res.status).toBe(403);
  });

  it('forbids ban membership', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
    });
    const env = createEnv({ db });
    const res = await request(env, typingPath(), jsonInit('PUT', { typing: false }));
    expect(res.status).toBe(403);
  });

  it('rejects bad JSON', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, typingPath(), {
      method: 'PUT',
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

  it('rejects missing typing boolean', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, typingPath(), jsonInit('PUT', { timeout: 5000 }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: 'Missing required parameter: typing',
    });
    expect(roomDO.fetches).toHaveLength(0);
  });

  it('rejects typing as string (not boolean)', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, typingPath(), jsonInit('PUT', { typing: 'true' }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
    expect(roomDO.fetches).toHaveLength(0);
  });

  it('rejects typing as number', async () => {
    const db = joinDb();
    const env = createEnv({ db });
    const res = await request(env, typingPath(), jsonInit('PUT', { typing: 1 }));
    expect(res.status).toBe(400);
  });

  it('typing true uses default timeout 30000 to Room DO', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, typingPath(), jsonInit('PUT', { typing: true }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(roomDO.fetches).toHaveLength(1);
    expect(roomDO.fetches[0].method).toBe('PUT');
    expect(roomDO.fetches[0].url).toContain('/typing');
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: 30000,
    });
  });

  it('typing true with requested timeout below max is forwarded', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(
      env,
      typingPath(),
      jsonInit('PUT', { typing: true, timeout: 45000 })
    );
    expect(res.status).toBe(200);
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: 45000,
    });
  });

  it('typing true with requested timeout capped at 120000', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(
      env,
      typingPath(),
      jsonInit('PUT', { typing: true, timeout: 999999 })
    );
    expect(res.status).toBe(200);
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: 120000,
    });
  });

  it('typing true with timeout exactly 120000 is unchanged', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    await request(env, typingPath(), jsonInit('PUT', { typing: true, timeout: 120000 }));
    expect(roomDO.fetches[0].body).toMatchObject({ timeout: 120000 });
  });

  it('typing false stops typing (default timeout still sent)', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, typingPath(), jsonInit('PUT', { typing: false }));
    expect(res.status).toBe(200);
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: false,
      timeout: 30000,
    });
  });

  it('typing false ignores requested timeout (stays default)', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    await request(env, typingPath(), jsonInit('PUT', { typing: false, timeout: 90000 }));
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: false,
      timeout: 30000,
    });
  });

  it('membership check uses ROOM and USER', async () => {
    const db = joinDb();
    const env = createEnv({ db });
    await request(env, typingPath(), jsonInit('PUT', { typing: true }));
    expect(db.selects[0].args).toEqual([ROOM, USER]);
  });

  it('join membership is required and sufficient', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, typingPath(), jsonInit('PUT', { typing: true, timeout: 1000 }));
    expect(res.status).toBe(200);
    expect(roomDO.fetches).toHaveLength(1);
    expect(roomDO.fetches[0].body).toMatchObject({ timeout: 1000, typing: true });
  });
});
