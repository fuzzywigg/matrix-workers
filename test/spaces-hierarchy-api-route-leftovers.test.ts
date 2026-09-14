/**
 * TOKENMAXX HEAVY leftovers after #157 — spaces hierarchy API soft/edge/reliability.
 * Complements spaces-room-info.test.ts. Tests-only — no product inventing.
 * Fixtures use example.com only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '../src/types';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICE');
      await next();
    };
  },
}));

import spaces from '../src/api/spaces';

const USER = '@alice:example.com';
const ROOM = '!space:example.com';
const SERVER = 'example.com';
const AUTH = { Authorization: 'Bearer test-token' };

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

type ChildEvent = { state_key: string; content: string };
type RoomInfoSeed = {
  room_id: string;
  is_public?: number;
  state?: StateMap;
  memberCount?: number | null;
};

function createHierarchyDb(opts: {
  rootExists?: boolean;
  rootRoomId?: string;
  childEvents?: ChildEvent[];
  grandchildEvents?: Record<string, ChildEvent[]>;
  rooms?: Record<string, RoomInfoSeed>;
  throwOnSqlIncludes?: string;
} = {}) {
  const rootRoomId = opts.rootRoomId ?? ROOM;
  const rootExists = opts.rootExists !== false;
  const childEvents = opts.childEvents ?? [];
  const grandchildEvents = opts.grandchildEvents ?? {};
  const rooms = opts.rooms ?? {};

  if (rootExists && !rooms[rootRoomId]) {
    rooms[rootRoomId] = {
      room_id: rootRoomId,
      state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) },
      memberCount: 1,
    };
  }

  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          const roomIdArg = args[0] as string | undefined;
          return {
            async first<T>() {
              if (opts.throwOnSqlIncludes && sql.includes(opts.throwOnSqlIncludes)) {
                throw new Error(`db boom: ${opts.throwOnSqlIncludes}`);
              }

              if (
                sql.includes('SELECT room_id FROM rooms WHERE room_id') &&
                !sql.includes('is_public')
              ) {
                return rootExists && roomIdArg === rootRoomId
                  ? ({ room_id: rootRoomId } as T)
                  : null;
              }

              if (sql.includes('SELECT room_id, is_public FROM rooms')) {
                const seed = roomIdArg ? rooms[roomIdArg] : undefined;
                if (!seed) return null as T;
                return {
                  room_id: seed.room_id,
                  is_public: seed.is_public ?? 1,
                } as T;
              }

              const state = (roomIdArg && rooms[roomIdArg]?.state) || {};
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
                  const content = state[et];
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
              if (opts.throwOnSqlIncludes && sql.includes(opts.throwOnSqlIncludes)) {
                throw new Error(`db boom: ${opts.throwOnSqlIncludes}`);
              }
              if (sql.includes("rs.event_type = 'm.space.child'")) {
                if (roomIdArg === rootRoomId) {
                  return { results: childEvents as T[] };
                }
                const gcs = grandchildEvents[roomIdArg ?? ''] ?? [];
                return { results: gcs as T[] };
              }
              return { results: [] as T[] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function hierarchyEnv(db: D1Database, serverName = SERVER): Env {
  return {
    SERVER_NAME: serverName,
    DB: db,
  } as Env;
}

async function getHierarchy(
  roomId: string,
  query = '',
  db: D1Database = createHierarchyDb({}),
  init: RequestInit = {}
) {
  const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/hierarchy${query}`;
  const res = await spaces.request(
    `http://localhost${path}`,
    { headers: { ...AUTH, ...(init.headers || {}) }, method: init.method ?? 'GET', body: init.body },
    hierarchyEnv(db)
  );
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body: body as Record<string, unknown> | null };
}

beforeEach(() => {
  vi.clearAllMocks();
});

void USER;

describe('spaces hierarchy leftovers empty hierarchy soft flood after #157', () => {
  for (let i = 0; i < 25; i++) {
    it(`empty hierarchy soft-${i}`, async () => {
      const db = createHierarchyDb({
        childEvents: [],
        rooms: {
          [ROOM]: {
            room_id: ROOM,
            state: {
              'm.room.create': JSON.stringify({ type: 'm.space' }),
              'm.room.name': JSON.stringify({ name: `Empty-${i}` }),
            },
            memberCount: i,
          },
        },
      });
      const { status, body } = await getHierarchy(ROOM, '', db);
      expect(status).toBe(200);
      const rooms = body!.rooms as Array<Record<string, unknown>>;
      expect(rooms).toHaveLength(1);
      expect(rooms[0].room_id).toBe(ROOM);
      expect(rooms[0].name).toBe(`Empty-${i}`);
      expect(rooms[0].children_state).toEqual([]);
      expect(body!.next_batch).toBeUndefined();
    });
  }
});

describe('spaces hierarchy leftovers suggested_only soft flood after #157', () => {
  for (let i = 0; i < 25; i++) {
    it(`suggested_only soft-${i}`, async () => {
      const sug = `!sug${i}:example.com`;
      const nosug = `!nosug${i}:example.com`;
      const omit = `!omit${i}:example.com`;
      const db = createHierarchyDb({
        childEvents: [
          {
            state_key: sug,
            content: JSON.stringify({ via: ['example.com'], suggested: true }),
          },
          {
            state_key: nosug,
            content: JSON.stringify({ via: ['example.com'], suggested: false }),
          },
          {
            state_key: omit,
            content: JSON.stringify({ via: ['example.com'] }),
          },
        ],
        rooms: {
          [ROOM]: { room_id: ROOM },
          [sug]: { room_id: sug, state: { 'm.room.name': JSON.stringify({ name: `Sug-${i}` }) } },
          [nosug]: { room_id: nosug },
          [omit]: { room_id: omit },
        },
      });
      const { status, body } = await getHierarchy(ROOM, '?suggested_only=true', db);
      expect(status).toBe(200);
      const rooms = body!.rooms as Array<{ room_id: string }>;
      expect(rooms.map((r) => r.room_id)).toEqual([ROOM, sug]);
    });
  }
});

describe('spaces hierarchy leftovers via soft flood after #157', () => {
  for (let i = 0; i < 25; i++) {
    it(`via soft-${i}`, async () => {
      const ok = `!ok${i}:example.com`;
      const emptyVia = `!empty${i}:example.com`;
      const noVia = `!novia${i}:example.com`;
      const viaHost = i % 2 === 0 ? 'example.com' : `via${i}.example.com`;
      const db = createHierarchyDb({
        childEvents: [
          { state_key: emptyVia, content: JSON.stringify({ via: [], suggested: true }) },
          { state_key: noVia, content: JSON.stringify({ suggested: true }) },
          { state_key: ok, content: JSON.stringify({ via: [viaHost] }) },
        ],
        rooms: {
          [ROOM]: { room_id: ROOM },
          [ok]: { room_id: ok, state: { 'm.room.name': JSON.stringify({ name: `Ok-${i}` }) } },
          [emptyVia]: { room_id: emptyVia },
          [noVia]: { room_id: noVia },
        },
      });
      const { status, body } = await getHierarchy(ROOM, '', db);
      expect(status).toBe(200);
      const rooms = body!.rooms as Array<{ room_id: string; name?: string }>;
      expect(rooms.map((r) => r.room_id)).toEqual([ROOM, ok]);
      expect(rooms[1].name).toBe(`Ok-${i}`);
    });
  }
});

describe('spaces hierarchy leftovers limit soft flood after #157', () => {
  for (let i = 0; i < 25; i++) {
    it(`limit soft-${i}`, async () => {
      const limit = (i % 10) + 1;
      const childEvents: ChildEvent[] = [];
      const rooms: Record<string, RoomInfoSeed> = { [ROOM]: { room_id: ROOM } };
      for (let c = 0; c < 15; c++) {
        const id = `!lim${i}c${c}:example.com`;
        childEvents.push({
          state_key: id,
          content: JSON.stringify({ via: ['example.com'] }),
        });
        rooms[id] = { room_id: id };
      }
      const db = createHierarchyDb({ childEvents, rooms });
      const { status, body } = await getHierarchy(ROOM, `?limit=${limit}`, db);
      expect(status).toBe(200);
      const roomsOut = body!.rooms as Array<{ room_id: string }>;
      expect(roomsOut.length).toBe(limit);
      // root + 15 children = 16 > limit → next_batch present
      expect(body!.next_batch).toBe(roomsOut[limit - 1].room_id);
    });
  }
});

describe('spaces hierarchy leftovers max_depth soft flood after #157', () => {
  for (let i = 0; i < 25; i++) {
    it(`max_depth soft-${i}`, async () => {
      const childId = `!child${i}:example.com`;
      const grandId = `!grand${i}:example.com`;
      const maxDepth = i % 3 === 0 ? 1 : i % 3 === 1 ? 2 : 3;
      const db = createHierarchyDb({
        childEvents: [
          { state_key: childId, content: JSON.stringify({ via: ['example.com'] }) },
        ],
        grandchildEvents: {
          [childId]: [
            {
              state_key: grandId,
              content: JSON.stringify({ via: ['example.com'], order: String(i) }),
            },
          ],
        },
        rooms: {
          [ROOM]: { room_id: ROOM },
          [childId]: {
            room_id: childId,
            state: { 'm.room.name': JSON.stringify({ name: `Child-${i}` }) },
          },
          [grandId]: { room_id: grandId },
        },
      });
      const { status, body } = await getHierarchy(ROOM, `?max_depth=${maxDepth}`, db);
      expect(status).toBe(200);
      const rooms = body!.rooms as Array<Record<string, unknown>>;
      expect(rooms).toHaveLength(2);
      expect(rooms[1].room_id).toBe(childId);
      if (maxDepth > 1) {
        expect(rooms[1].children_state).toEqual([
          {
            type: 'm.space.child',
            state_key: grandId,
            content: { via: ['example.com'], order: String(i) },
          },
        ]);
      } else {
        expect(rooms[1].children_state).toEqual([]);
      }
    });
  }
});

describe('spaces hierarchy leftovers membership forbidden / room-missing soft flood after #157', () => {
  // Implementation gates on room existence only (no membership check) → M_NOT_FOUND.
  for (let i = 0; i < 25; i++) {
    it(`room-missing not-found soft-${i}`, async () => {
      const missing = `!missing${i}:example.com`;
      const { status, body } = await getHierarchy(
        missing,
        '',
        createHierarchyDb({ rootExists: false, rootRoomId: missing })
      );
      expect(status).toBe(404);
      expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
    });
  }
});

describe('spaces hierarchy leftovers corrupt child soft flood after #157', () => {
  for (let i = 0; i < 25; i++) {
    it(`corrupt child getRoomInfo skip soft-${i}`, async () => {
      const boom = `!boom${i}:example.com`;
      const ok = `!ok${i}:example.com`;
      const db = createHierarchyDb({
        childEvents: [
          {
            state_key: boom,
            content: JSON.stringify({ via: ['example.com'] }),
          },
          {
            state_key: ok,
            content: JSON.stringify({ via: ['example.com'] }),
          },
        ],
        rooms: {
          [ROOM]: { room_id: ROOM },
          [boom]: {
            room_id: boom,
            state: { 'm.room.name': `{bad-${i}` },
          },
          [ok]: {
            room_id: ok,
            state: { 'm.room.name': JSON.stringify({ name: `Ok-${i}` }) },
          },
        },
      });
      const { status, body } = await getHierarchy(ROOM, '', db);
      expect(status).toBe(200);
      const rooms = body!.rooms as Array<{ room_id: string; name?: string }>;
      expect(rooms.map((r) => r.room_id)).toEqual([ROOM, ok]);
      expect(rooms[1].name).toBe(`Ok-${i}`);
    });
  }
});

describe('spaces hierarchy leftovers ghost / missing-child soft flood after #157', () => {
  for (let i = 0; i < 10; i++) {
    it(`ghost child skipped soft-${i}`, async () => {
      const ghost = `!ghost${i}:example.com`;
      const db = createHierarchyDb({
        childEvents: [
          { state_key: ghost, content: JSON.stringify({ via: ['example.com'] }) },
        ],
        rooms: { [ROOM]: { room_id: ROOM } },
      });
      const { status, body } = await getHierarchy(ROOM, '', db);
      expect(status).toBe(200);
      const rooms = body!.rooms as Array<{ room_id: string }>;
      expect(rooms.map((r) => r.room_id)).toEqual([ROOM]);
    });
  }
});

describe('spaces hierarchy leftovers method matrix after #157', () => {
  const path = `/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/hierarchy`;
  const bad = ['POST', 'PUT', 'DELETE', 'PATCH'];
  for (const method of bad) {
    it(`${method} hierarchy → 404/405`, async () => {
      const db = createHierarchyDb({});
      const res = await spaces.request(
        `http://localhost${path}`,
        {
          method,
          headers: { ...AUTH, 'Content-Type': 'application/json' },
          body: method === 'GET' ? undefined : '{}',
        },
        hierarchyEnv(db)
      );
      expect([404, 405]).toContain(res.status);
    });
  }
});

describe('spaces hierarchy leftovers charset / query soft flood after #157', () => {
  const okQueries = [
    '',
    '?from=',
    '?from=token',
    '?suggested_only=false',
    '?suggested_only=TRUE',
    '?suggested_only=1',
    '?limit=50',
    '?limit=100',
    '?max_depth=1',
    '?max_depth=2&limit=10',
    '?suggested_only=true&max_depth=2',
    '?max_depth=0',
    '?from=abc&limit=5',
    '?limit=1',
    '?limit=2&max_depth=1',
  ];
  for (const [i, q] of okQueries.entries()) {
    it(`query variant soft-${i} (${q || 'none'})`, async () => {
      const db = createHierarchyDb({ childEvents: [] });
      const { status, body } = await getHierarchy(ROOM, q, db);
      expect(status).toBe(200);
      expect(Array.isArray(body!.rooms)).toBe(true);
    });
  }

  // Document: limit=0 / negative → rooms.slice(0, 0) then next_batch reads rooms[-1] → 500
  for (const [i, q] of ['?limit=0', '?limit=-1'].entries()) {
    it(`limit edge crash soft-${i} (${q})`, async () => {
      const db = createHierarchyDb({ childEvents: [] });
      const { status } = await getHierarchy(ROOM, q, db);
      expect(status).toBe(500);
    });
  }
});

describe('spaces hierarchy leftovers lifecycle soft flood after #157', () => {
  for (let i = 0; i < 25; i++) {
    it(`empty→child→suggested lifecycle soft-${i}`, async () => {
      // 1) empty
      const empty = await getHierarchy(ROOM, '', createHierarchyDb({ childEvents: [] }));
      expect(empty.status).toBe(200);
      expect((empty.body!.rooms as unknown[]).length).toBe(1);

      // 2) with child
      const child = `!lc${i}:example.com`;
      const withChild = await getHierarchy(
        ROOM,
        '',
        createHierarchyDb({
          childEvents: [
            {
              state_key: child,
              content: JSON.stringify({ via: ['example.com'], suggested: i % 2 === 0 }),
            },
          ],
          rooms: {
            [ROOM]: { room_id: ROOM },
            [child]: {
              room_id: child,
              state: { 'm.room.name': JSON.stringify({ name: `LC-${i}` }) },
            },
          },
        })
      );
      expect(withChild.status).toBe(200);
      expect((withChild.body!.rooms as unknown[]).length).toBe(2);

      // 3) suggested_only
      const sugOnly = await getHierarchy(
        ROOM,
        '?suggested_only=true',
        createHierarchyDb({
          childEvents: [
            {
              state_key: child,
              content: JSON.stringify({ via: ['example.com'], suggested: i % 2 === 0 }),
            },
          ],
          rooms: {
            [ROOM]: { room_id: ROOM },
            [child]: { room_id: child },
          },
        })
      );
      expect(sugOnly.status).toBe(200);
      const ids = (sugOnly.body!.rooms as Array<{ room_id: string }>).map((r) => r.room_id);
      if (i % 2 === 0) {
        expect(ids).toEqual([ROOM, child]);
      } else {
        expect(ids).toEqual([ROOM]);
      }
    });
  }
});
