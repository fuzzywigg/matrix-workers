/**
 * TOKENMAXX HEAVY leftovers — typing HTTP + sync helper edges after #178.
 * Complements typing-api-routes, receipts-typing-helpers, presence-typing leftovers (#166),
 * and presence-receipts-typing-todevice soft floods. Distinct slice: membership matrices,
 * body/timeout edges, Room DO / SQL bind contracts, multi-room isolation, concurrent
 * start/stop races, getTypingUsers/getTypingForRooms failure + empty omission.
 * Tests-only — no product inventing. example.com only. Not receipts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { getTypingUsers, getTypingForRooms } from '../src/api/typing';

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
const CAROL = '@carol:example.com';
const DAVE = '@dave:example.com';
const ROOM = '!r:example.com';
const ROOM2 = '!r2:example.com';
const ROOM3 = '!r3:example.com';
const ROOM4 = '!r4:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const ROOM2_ENC = encodeURIComponent(ROOM2);
const USER_ENC = encodeURIComponent(USER);
const BOB_ENC = encodeURIComponent(BOB);
const CAROL_ENC = encodeURIComponent(CAROL);

type Membership = { room_id: string; user_id: string; membership: string };
type SqlCall = { sql: string; args: unknown[] };
type RoomFetch = { url: string; method: string; body?: unknown };

function createRoomDOStub(opts?: {
  fail?: boolean;
  response?: Response | (() => Response);
}) {
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
      if (opts?.fail) throw new Error('room-do-fail');
      if (opts?.response) {
        return typeof opts.response === 'function' ? opts.response() : opts.response;
      }
      return Response.json({ ok: true });
    },
  };
}

type RoomDOStub = ReturnType<typeof createRoomDOStub>;

function createTypingDb(opts: {
  memberships?: Membership[];
  failSelect?: boolean;
} = {}) {
  const memberships = opts.memberships ?? [];
  const selects: SqlCall[] = [];

  const db = {
    memberships,
    selects,
    failSelect: opts.failSelect ?? false,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              if (db.failSelect) throw new Error('d1-select-fail');
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
): Promise<{ status: number; body: unknown }> {
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

function joinDb(extra?: Membership[]) {
  return createTypingDb({
    memberships: [
      { room_id: ROOM, user_id: USER, membership: 'join' },
      ...(extra ?? []),
    ],
  });
}

function typingPath(userIdEnc = USER_ENC, roomEnc = ROOM_ENC) {
  return '/_matrix/client/v3/rooms/' + roomEnc + '/typing/' + userIdEnc;
}

function mockRoomsNamespace(
  byRoom: Record<
    string,
    | { kind: 'typing'; user_ids: string[] }
    | { kind: 'throw'; error: Error }
    | { kind: 'http'; status: number; body: unknown }
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
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Membership status matrix
// ---------------------------------------------------------------------------

describe('typing leftovers membership status matrix', () => {
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
    'Join',
    'join ',
    ' join',
  ] as const;

  it.each(statuses)('PUT typing forbids membership=%s', async (status) => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: status }],
    });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, typingPath(), jsonInit('PUT', { typing: true }));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Not a member of this room',
    });
    expect(roomDO.fetches).toHaveLength(0);
    expect(db.selects).toHaveLength(1);
  });

  it.each(statuses)('PUT stop-typing forbids membership=%s', async (status) => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: status }],
    });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, typingPath(), jsonInit('PUT', { typing: false }));
    expect(res.status).toBe(403);
    expect(roomDO.fetches).toHaveLength(0);
  });

  it('missing membership row forbids typing', async () => {
    const db = createTypingDb({ memberships: [] });
    const env = createEnv({ db });
    expect((await request(env, typingPath(), jsonInit('PUT', { typing: true }))).status).toBe(
      403
    );
  });

  it('Bob join does not authorize Alice typing', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM, user_id: BOB, membership: 'join' }],
    });
    const env = createEnv({ db });
    expect((await request(env, typingPath(), jsonInit('PUT', { typing: true }))).status).toBe(
      403
    );
  });

  it('join in ROOM2 does not authorize typing in ROOM', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM2, user_id: USER, membership: 'join' }],
    });
    const env = createEnv({ db });
    expect((await request(env, typingPath(), jsonInit('PUT', { typing: true }))).status).toBe(
      403
    );
  });

  it('exact join membership authorizes', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, typingPath(), jsonInit('PUT', { typing: true }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(roomDO.fetches).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Own-user gate matrix
// ---------------------------------------------------------------------------

describe('typing leftovers own-user gate matrix', () => {
  const others = [
    [BOB_ENC, BOB],
    [CAROL_ENC, CAROL],
    [encodeURIComponent(DAVE), DAVE],
    [encodeURIComponent('@eve:example.com'), '@eve:example.com'],
    [encodeURIComponent('@alice:other.example.com'), '@alice:other.example.com'],
  ] as const;

  it.each(others)('forbids path user %s before membership lookup', async (enc, _id) => {
    const db = joinDb([
      { room_id: ROOM, user_id: BOB, membership: 'join' },
      { room_id: ROOM, user_id: CAROL, membership: 'join' },
      { room_id: ROOM, user_id: DAVE, membership: 'join' },
    ]);
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, typingPath(enc), jsonInit('PUT', { typing: true }));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot set typing status for other users',
    });
    expect(roomDO.fetches).toHaveLength(0);
    expect(db.selects).toHaveLength(0);
  });

  it.each(others)('forbids stop-typing for path user %s', async (enc) => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, typingPath(enc), jsonInit('PUT', { typing: false }));
    expect(res.status).toBe(403);
    expect(roomDO.fetches).toHaveLength(0);
    expect(db.selects).toHaveLength(0);
  });

  it('allows only exact authenticated USER in path', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, typingPath(USER_ENC), jsonInit('PUT', { typing: true }));
    expect(res.status).toBe(200);
    expect(roomDO.fetches[0].body).toMatchObject({ user_id: USER });
  });
});

// ---------------------------------------------------------------------------
// Body / typing-field edges
// ---------------------------------------------------------------------------

describe('typing leftovers body type edges', () => {
  const badTyping = [
    ['string-true', 'true'],
    ['string-false', 'false'],
    ['number-1', 1],
    ['number-0', 0],
    ['null', null],
    ['array', []],
    ['object', {}],
    ['undefined-key-missing', undefined],
  ] as const;

  for (const [label, value] of badTyping) {
    it('rejects typing=' + label, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const body =
        value === undefined ? { timeout: 1000 } : { typing: value as unknown, timeout: 1000 };
      const res = await request(env, typingPath(), jsonInit('PUT', body));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        errcode: 'M_MISSING_PARAM',
        error: 'Missing required parameter: typing',
      });
      expect(roomDO.fetches).toHaveLength(0);
    });
  }

  it('rejects empty object', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, typingPath(), jsonInit('PUT', {}));
    expect(res.status).toBe(400);
    expect(roomDO.fetches).toHaveLength(0);
  });

  it('rejects empty array body as bad JSON shape via missing typing', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, typingPath(), jsonInit('PUT', []));
    expect(res.status).toBe(400);
    expect(roomDO.fetches).toHaveLength(0);
  });

  it('rejects malformed JSON', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, typingPath(), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
    expect(roomDO.fetches).toHaveLength(0);
  });

  it('rejects truncated JSON', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, typingPath(), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: '{"typing":',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('accepts typing true with extra unknown keys (forwarded only known fields)', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(
      env,
      typingPath(),
      jsonInit('PUT', { typing: true, timeout: 5000, extra: 'x', nested: { a: 1 } })
    );
    expect(res.status).toBe(200);
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: 5000,
    });
  });

  it('accepts typing false with extra keys', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(
      env,
      typingPath(),
      jsonInit('PUT', { typing: false, foo: 1, timeout: 99999 })
    );
    expect(res.status).toBe(200);
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: false,
      timeout: 30000,
    });
  });
});

// ---------------------------------------------------------------------------
// Timeout clamp matrix
// ---------------------------------------------------------------------------

describe('typing leftovers timeout clamp matrix', () => {
  const belowMax = [
    1, 100, 1000, 5000, 15000, 29999, 30000, 30001, 45000, 60000, 90000, 119999, 120000,
  ] as const;

  it.each(belowMax)('forwards timeout=%s when typing true', async (timeout) => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, typingPath(), jsonInit('PUT', { typing: true, timeout }));
    expect(res.status).toBe(200);
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout,
    });
  });

  const overMax = [120001, 150000, 200000, 999999, 1_000_000, Number.MAX_SAFE_INTEGER] as const;

  it.each(overMax)('caps timeout=%s to 120000', async (timeout) => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, typingPath(), jsonInit('PUT', { typing: true, timeout }));
    expect(res.status).toBe(200);
    expect(roomDO.fetches[0].body).toMatchObject({ timeout: 120000 });
  });

  const falsyTimeouts = [0, NaN, null, false, ''] as const;

  it.each(falsyTimeouts)(
    'typing true with falsy timeout=%s uses default 30000',
    async (timeout) => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const res = await request(
        env,
        typingPath(),
        jsonInit('PUT', { typing: true, timeout: timeout as unknown as number })
      );
      expect(res.status).toBe(200);
      expect(roomDO.fetches[0].body).toMatchObject({ timeout: 30000 });
    }
  );

  it.each([-1, -100] as const)(
    'typing true with negative timeout=%s is truthy and forwarded (Math.min)',
    async (timeout) => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const res = await request(env, typingPath(), jsonInit('PUT', { typing: true, timeout }));
      expect(res.status).toBe(200);
      expect(roomDO.fetches[0].body).toMatchObject({ timeout });
    }
  );

  it('typing true with string timeout coerces via Math.min', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(
      env,
      typingPath(),
      jsonInit('PUT', { typing: true, timeout: '45000' as unknown as number })
    );
    expect(res.status).toBe(200);
    expect(roomDO.fetches[0].body).toMatchObject({ timeout: 45000 });
  });

  it('omitted timeout defaults to 30000 when typing true', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    await request(env, typingPath(), jsonInit('PUT', { typing: true }));
    expect(roomDO.fetches[0].body).toMatchObject({ timeout: 30000 });
  });

  const ignoredOnStop = [1, 45000, 120000, 999999] as const;

  it.each(ignoredOnStop)('typing false ignores timeout=%s (stays 30000)', async (timeout) => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    await request(env, typingPath(), jsonInit('PUT', { typing: false, timeout }));
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: false,
      timeout: 30000,
    });
  });
});

// ---------------------------------------------------------------------------
// Room DO / SQL bind contracts
// ---------------------------------------------------------------------------

describe('typing leftovers Room DO and SQL bind contracts', () => {
  it('membership select binds room then user', async () => {
    const db = joinDb();
    const env = createEnv({ db });
    await request(env, typingPath(), jsonInit('PUT', { typing: true }));
    expect(db.selects).toHaveLength(1);
    expect(db.selects[0].args).toEqual([ROOM, USER]);
    expect(db.selects[0].sql).toContain('room_memberships');
  });

  it('idFromName uses decoded room id', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    await request(env, typingPath(), jsonInit('PUT', { typing: true }));
    expect(env._idCalls).toEqual([ROOM]);
  });

  it('Room DO PUT path ends with /typing and JSON content-type body', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    await request(env, typingPath(), jsonInit('PUT', { typing: true, timeout: 1234 }));
    expect(roomDO.fetches[0].method).toBe('PUT');
    expect(roomDO.fetches[0].url).toContain('/typing');
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: 1234,
    });
  });

  it('ROOM2 path isolates idFromName and membership bind', async () => {
    const db = createTypingDb({
      memberships: [{ room_id: ROOM2, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(
      env,
      typingPath(USER_ENC, ROOM2_ENC),
      jsonInit('PUT', { typing: true, timeout: 2000 })
    );
    expect(res.status).toBe(200);
    expect(db.selects[0].args).toEqual([ROOM2, USER]);
    expect(env._idCalls).toEqual([ROOM2]);
  });

  it('per-room DO stubs isolate fetches', async () => {
    const db = createTypingDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: ROOM2, user_id: USER, membership: 'join' },
      ],
    });
    const do1 = createRoomDOStub();
    const do2 = createRoomDOStub();
    const env = createEnv({ db, roomById: { [ROOM]: do1, [ROOM2]: do2 } });

    await request(env, typingPath(USER_ENC, ROOM_ENC), jsonInit('PUT', { typing: true }));
    await request(
      env,
      typingPath(USER_ENC, ROOM2_ENC),
      jsonInit('PUT', { typing: false })
    );

    expect(do1.fetches).toHaveLength(1);
    expect(do2.fetches).toHaveLength(1);
    expect(do1.fetches[0].body).toMatchObject({ typing: true });
    expect(do2.fetches[0].body).toMatchObject({ typing: false });
  });

  for (let i = 0; i < 12; i++) {
    it('SQL+DO contract soft-' + i, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const typing = i % 2 === 0;
      const timeout = 1000 + i * 1000;
      const res = await request(
        env,
        typingPath(),
        jsonInit('PUT', { typing, timeout })
      );
      expect(res.status).toBe(200);
      expect(db.selects[0].args).toEqual([ROOM, USER]);
      expect(env._idCalls).toEqual([ROOM]);
      expect(roomDO.fetches[0].body).toEqual({
        user_id: USER,
        typing,
        timeout: typing ? Math.min(timeout, 120000) : 30000,
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Concurrent start/stop races
// ---------------------------------------------------------------------------

describe('typing leftovers concurrent start/stop races', () => {
  it('parallel start PUTs each hit Room DO', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(env, typingPath(), jsonInit('PUT', { typing: true, timeout: 1000 + i }))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(roomDO.fetches).toHaveLength(8);
    expect(db.selects).toHaveLength(8);
  });

  it('start then stop sequence sends two DO PUTs with correct bodies', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    expect(
      (await request(env, typingPath(), jsonInit('PUT', { typing: true, timeout: 40000 }))).status
    ).toBe(200);
    expect(
      (await request(env, typingPath(), jsonInit('PUT', { typing: false, timeout: 90000 }))).status
    ).toBe(200);
    expect(roomDO.fetches).toHaveLength(2);
    expect(roomDO.fetches[0].body).toEqual({
      user_id: USER,
      typing: true,
      timeout: 40000,
    });
    expect(roomDO.fetches[1].body).toEqual({
      user_id: USER,
      typing: false,
      timeout: 30000,
    });
  });

  it('interleaved start/stop across two rooms stays isolated', async () => {
    const db = createTypingDb({
      memberships: [
        { room_id: ROOM, user_id: USER, membership: 'join' },
        { room_id: ROOM2, user_id: USER, membership: 'join' },
      ],
    });
    const do1 = createRoomDOStub();
    const do2 = createRoomDOStub();
    const env = createEnv({ db, roomById: { [ROOM]: do1, [ROOM2]: do2 } });

    const results = await Promise.all([
      request(env, typingPath(USER_ENC, ROOM_ENC), jsonInit('PUT', { typing: true, timeout: 1111 })),
      request(
        env,
        typingPath(USER_ENC, ROOM2_ENC),
        jsonInit('PUT', { typing: true, timeout: 2222 })
      ),
      request(env, typingPath(USER_ENC, ROOM_ENC), jsonInit('PUT', { typing: false })),
      request(env, typingPath(USER_ENC, ROOM2_ENC), jsonInit('PUT', { typing: false })),
    ]);

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(do1.fetches).toHaveLength(2);
    expect(do2.fetches).toHaveLength(2);
    expect(do1.fetches.map((f) => (f.body as { typing: boolean }).typing)).toEqual([
      true,
      false,
    ]);
    expect(do2.fetches.map((f) => (f.body as { typing: boolean }).typing)).toEqual([
      true,
      false,
    ]);
  });

  for (let i = 0; i < 10; i++) {
    it('refresh-typing soft-' + i + ' re-forwards timeout', async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const timeout = 5000 + i * 250;
      await request(env, typingPath(), jsonInit('PUT', { typing: true, timeout }));
      await request(env, typingPath(), jsonInit('PUT', { typing: true, timeout: timeout + 1 }));
      expect(roomDO.fetches).toHaveLength(2);
      expect(roomDO.fetches[1].body).toMatchObject({
        typing: true,
        timeout: timeout + 1,
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Method / path matrix
// ---------------------------------------------------------------------------

describe('typing leftovers method and path matrix', () => {
  it('GET typing path is not handled as PUT success', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, typingPath(), {
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status).not.toBe(200);
    expect(roomDO.fetches).toHaveLength(0);
  });

  const bodyMethods = ['POST', 'DELETE', 'PATCH'] as const;

  it.each(bodyMethods)('%s typing path is not handled as PUT success', async (method) => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, typingPath(), jsonInit(method, { typing: true }));
    expect(res.status).not.toBe(200);
    expect(roomDO.fetches).toHaveLength(0);
  });

  it('unknown room path segment still runs membership with decoded id', async () => {
    const weird = '!weird+room:example.com';
    const db = createTypingDb({
      memberships: [{ room_id: weird, user_id: USER, membership: 'join' }],
    });
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(
      env,
      typingPath(USER_ENC, encodeURIComponent(weird)),
      jsonInit('PUT', { typing: true })
    );
    expect(res.status).toBe(200);
    expect(db.selects[0].args[0]).toBe(weird);
    expect(env._idCalls).toEqual([weird]);
  });
});

// ---------------------------------------------------------------------------
// getTypingUsers / getTypingForRooms leftover edges
// ---------------------------------------------------------------------------

describe('typing leftovers getTypingUsers helper edges', () => {
  it('returns user_ids from Room DO GET /typing', async () => {
    const env = envWithRooms({
      [ROOM]: { kind: 'typing', user_ids: [USER, BOB] },
    });
    expect(await getTypingUsers(env, ROOM)).toEqual([USER, BOB]);
  });

  it('returns empty list when DO has no typers', async () => {
    const env = envWithRooms({
      [ROOM]: { kind: 'typing', user_ids: [] },
    });
    expect(await getTypingUsers(env, ROOM)).toEqual([]);
  });

  it('propagates DO throw from getTypingUsers', async () => {
    const env = envWithRooms({
      [ROOM]: { kind: 'throw', error: new Error('typing-do-down') },
    });
    await expect(getTypingUsers(env, ROOM)).rejects.toThrow('typing-do-down');
  });

  for (let i = 0; i < 12; i++) {
    it('getTypingUsers soft-' + i + ' preserves order', async () => {
      const users = Array.from({ length: i + 1 }, (_, j) => '@u' + j + ':example.com');
      const env = envWithRooms({
        [ROOM]: { kind: 'typing', user_ids: users },
      });
      expect(await getTypingUsers(env, ROOM)).toEqual(users);
    });
  }
});

describe('typing leftovers getTypingForRooms multi-room edges', () => {
  it('returns {} for empty room list without DO calls', async () => {
    let called = false;
    const env = {
      ROOMS: {
        idFromName() {
          called = true;
          return { name: 'x' };
        },
        get() {
          called = true;
          return { fetch: async () => Response.json({ user_ids: [] }) };
        },
      },
    } as unknown as Env;
    expect(await getTypingForRooms(env, [])).toEqual({});
    expect(called).toBe(false);
  });

  it('omits rooms with empty typer lists', async () => {
    const env = envWithRooms({
      [ROOM]: { kind: 'typing', user_ids: [] },
      [ROOM2]: { kind: 'typing', user_ids: [USER] },
      [ROOM3]: { kind: 'typing', user_ids: [] },
    });
    expect(await getTypingForRooms(env, [ROOM, ROOM2, ROOM3])).toEqual({
      [ROOM2]: [USER],
    });
  });

  it('aggregates multi-user lists across rooms', async () => {
    const env = envWithRooms({
      [ROOM]: { kind: 'typing', user_ids: [USER, BOB] },
      [ROOM2]: { kind: 'typing', user_ids: [CAROL] },
      [ROOM3]: { kind: 'typing', user_ids: [DAVE, USER] },
    });
    expect(await getTypingForRooms(env, [ROOM, ROOM2, ROOM3])).toEqual({
      [ROOM]: [USER, BOB],
      [ROOM2]: [CAROL],
      [ROOM3]: [DAVE, USER],
    });
  });

  it('isolates DO throw to empty users for that room only', async () => {
    const env = envWithRooms({
      [ROOM]: { kind: 'throw', error: new Error('boom') },
      [ROOM2]: { kind: 'typing', user_ids: [BOB] },
    });
    expect(await getTypingForRooms(env, [ROOM, ROOM2])).toEqual({
      [ROOM2]: [BOB],
    });
  });

  it('isolates multiple throws among healthy rooms', async () => {
    const env = envWithRooms({
      [ROOM]: { kind: 'throw', error: new Error('a') },
      [ROOM2]: { kind: 'typing', user_ids: [USER] },
      [ROOM3]: { kind: 'throw', error: new Error('b') },
      [ROOM4]: { kind: 'typing', user_ids: [CAROL, DAVE] },
    });
    expect(await getTypingForRooms(env, [ROOM, ROOM2, ROOM3, ROOM4])).toEqual({
      [ROOM2]: [USER],
      [ROOM4]: [CAROL, DAVE],
    });
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
              return new Response(JSON.stringify({ user_ids: [USER + ':' + id.name] }), {
                headers: { 'Content-Type': 'application/json' },
              });
            },
          };
        },
      },
    } as unknown as Env;
    const rooms = [ROOM, ROOM2, ROOM3];
    const result = await getTypingForRooms(env, rooms);
    expect(seen.sort()).toEqual(rooms.slice().sort());
    expect(Object.keys(result).sort()).toEqual(rooms.slice().sort());
  });

  for (let i = 0; i < 12; i++) {
    it('multi-room soft-' + i + ' omits empty and keeps busy', async () => {
      const busy = '!busy-' + i + ':example.com';
      const quiet = '!quiet-' + i + ':example.com';
      const env = envWithRooms({
        [busy]: { kind: 'typing', user_ids: [USER, '@n' + i + ':example.com'] },
        [quiet]: { kind: 'typing', user_ids: [] },
      });
      const result = await getTypingForRooms(env, [quiet, busy]);
      expect(result[quiet]).toBeUndefined();
      expect(result[busy]).toEqual([USER, '@n' + i + ':example.com']);
    });
  }
});

// ---------------------------------------------------------------------------
// Side-effect soft deepen
// ---------------------------------------------------------------------------

describe('typing leftovers side-effect contracts soft deepen', () => {
  for (let i = 0; i < 16; i++) {
    it('start-typing soft-' + i, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const timeout = 2000 + i * 500;
      const res = await request(
        env,
        typingPath(),
        jsonInit('PUT', { typing: true, timeout })
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({});
      expect(roomDO.fetches).toHaveLength(1);
      expect(roomDO.fetches[0].body).toEqual({
        user_id: USER,
        typing: true,
        timeout: Math.min(timeout, 120000),
      });
      expect(db.selects[0].args).toEqual([ROOM, USER]);
    });
  }

  for (let i = 0; i < 12; i++) {
    it('stop-typing soft-' + i, async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const res = await request(
        env,
        typingPath(),
        jsonInit('PUT', { typing: false, timeout: 10000 + i })
      );
      expect(res.status).toBe(200);
      expect(roomDO.fetches[0].body).toEqual({
        user_id: USER,
        typing: false,
        timeout: 30000,
      });
    });
  }

  for (let i = 0; i < 12; i++) {
    it('forbid-other-user soft-' + i + ' skips SQL and DO', async () => {
      const db = joinDb();
      const roomDO = createRoomDOStub();
      const env = createEnv({ db, roomDO });
      const other = encodeURIComponent('@other' + i + ':example.com');
      const res = await request(env, typingPath(other), jsonInit('PUT', { typing: true }));
      expect(res.status).toBe(403);
      expect(db.selects).toHaveLength(0);
      expect(roomDO.fetches).toHaveLength(0);
      expect(env._idCalls).toEqual([]);
    });
  }
});
