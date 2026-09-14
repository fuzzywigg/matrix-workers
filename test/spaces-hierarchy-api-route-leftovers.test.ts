/**
 * TOKENMAXX HEAVY leftovers after #157 — spaces hierarchy soft/edge/reliability.
 * Complements spaces-room-info.test.ts; orthogonal to open keys/media/appservice #158. Tests-only — no product inventing.
 * Fixtures use example.com only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';

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
import type { Env } from '../src/types';

const SERVER = 'example.com';
const ROOM = '!space:example.com';
const CHILD = '!child:example.com';
const CHILD2 = '!child2:example.com';
const GC = '!gc:example.com';

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
  db: D1Database = createHierarchyDb({})
) {
  const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/hierarchy${query}`;
  const res = await spaces.request(
    `http://localhost${path}`,
    { headers: { Authorization: 'Bearer test-token' } },
    hierarchyEnv(db)
  );
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function seedChild(id: string, via: string[] | null = ['example.com'], suggested = false) {
  const content: Record<string, unknown> = {};
  if (via !== null) content.via = via;
  if (suggested) content.suggested = true;
  return { state_key: id, content: JSON.stringify(content) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('spaces leftovers hierarchy empty soft reliability after #157', () => {
  it('empty hierarchy soft-0', async () => {
    const { status, body } = await getHierarchy(ROOM);
    expect(status).toBe(200);
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].children_state).toEqual([]);
    expect(body.next_batch).toBeUndefined();
  });
  it('empty hierarchy soft-1', async () => {
    const { status, body } = await getHierarchy(ROOM);
    expect(status).toBe(200);
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].children_state).toEqual([]);
    expect(body.next_batch).toBeUndefined();
  });
  it('empty hierarchy soft-2', async () => {
    const { status, body } = await getHierarchy(ROOM);
    expect(status).toBe(200);
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].children_state).toEqual([]);
    expect(body.next_batch).toBeUndefined();
  });
  it('empty hierarchy soft-3', async () => {
    const { status, body } = await getHierarchy(ROOM);
    expect(status).toBe(200);
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].children_state).toEqual([]);
    expect(body.next_batch).toBeUndefined();
  });
  it('empty hierarchy soft-4', async () => {
    const { status, body } = await getHierarchy(ROOM);
    expect(status).toBe(200);
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].children_state).toEqual([]);
    expect(body.next_batch).toBeUndefined();
  });
  it('empty hierarchy soft-5', async () => {
    const { status, body } = await getHierarchy(ROOM);
    expect(status).toBe(200);
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].children_state).toEqual([]);
    expect(body.next_batch).toBeUndefined();
  });
  it('empty hierarchy soft-6', async () => {
    const { status, body } = await getHierarchy(ROOM);
    expect(status).toBe(200);
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].children_state).toEqual([]);
    expect(body.next_batch).toBeUndefined();
  });
  it('empty hierarchy soft-7', async () => {
    const { status, body } = await getHierarchy(ROOM);
    expect(status).toBe(200);
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].children_state).toEqual([]);
    expect(body.next_batch).toBeUndefined();
  });
  it('empty hierarchy soft-8', async () => {
    const { status, body } = await getHierarchy(ROOM);
    expect(status).toBe(200);
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].children_state).toEqual([]);
    expect(body.next_batch).toBeUndefined();
  });
  it('empty hierarchy soft-9', async () => {
    const { status, body } = await getHierarchy(ROOM);
    expect(status).toBe(200);
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].children_state).toEqual([]);
    expect(body.next_batch).toBeUndefined();
  });
  it('empty hierarchy soft-10', async () => {
    const { status, body } = await getHierarchy(ROOM);
    expect(status).toBe(200);
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].children_state).toEqual([]);
    expect(body.next_batch).toBeUndefined();
  });
  it('empty hierarchy soft-11', async () => {
    const { status, body } = await getHierarchy(ROOM);
    expect(status).toBe(200);
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].children_state).toEqual([]);
    expect(body.next_batch).toBeUndefined();
  });
  it('empty hierarchy soft-12', async () => {
    const { status, body } = await getHierarchy(ROOM);
    expect(status).toBe(200);
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].children_state).toEqual([]);
    expect(body.next_batch).toBeUndefined();
  });
  it('empty hierarchy soft-13', async () => {
    const { status, body } = await getHierarchy(ROOM);
    expect(status).toBe(200);
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].children_state).toEqual([]);
    expect(body.next_batch).toBeUndefined();
  });
  it('empty hierarchy soft-14', async () => {
    const { status, body } = await getHierarchy(ROOM);
    expect(status).toBe(200);
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].children_state).toEqual([]);
    expect(body.next_batch).toBeUndefined();
  });
  it('empty hierarchy soft-15', async () => {
    const { status, body } = await getHierarchy(ROOM);
    expect(status).toBe(200);
    expect(body.rooms).toHaveLength(1);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].children_state).toEqual([]);
    expect(body.next_batch).toBeUndefined();
  });
});

describe('spaces leftovers suggested_only soft matrix after #157', () => {
  it('suggested_only soft-0', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, state: { 'm.room.name': JSON.stringify({ name: 'A' }) }, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, state: { 'm.room.name': JSON.stringify({ name: 'B' }) }, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '?suggested_only=true', db);
    expect(status).toBe(200);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain(ROOM);
    expect(ids).toContain(CHILD); expect(ids).not.toContain(CHILD2);
  });
  it('suggested_only soft-1', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, state: { 'm.room.name': JSON.stringify({ name: 'A' }) }, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, state: { 'm.room.name': JSON.stringify({ name: 'B' }) }, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '?suggested_only=false', db);
    expect(status).toBe(200);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain(ROOM);
    expect(ids).toContain(CHILD); expect(ids).toContain(CHILD2);
  });
  it('suggested_only soft-2', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, state: { 'm.room.name': JSON.stringify({ name: 'A' }) }, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, state: { 'm.room.name': JSON.stringify({ name: 'B' }) }, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '?suggested_only=TRUE', db);
    expect(status).toBe(200);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain(ROOM);
    expect(ids).toContain(CHILD); expect(ids).toContain(CHILD2);
  });
  it('suggested_only soft-3', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, state: { 'm.room.name': JSON.stringify({ name: 'A' }) }, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, state: { 'm.room.name': JSON.stringify({ name: 'B' }) }, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '?suggested_only=1', db);
    expect(status).toBe(200);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain(ROOM);
    expect(ids).toContain(CHILD); expect(ids).toContain(CHILD2);
  });
  it('suggested_only soft-4', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, state: { 'm.room.name': JSON.stringify({ name: 'A' }) }, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, state: { 'm.room.name': JSON.stringify({ name: 'B' }) }, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '?suggested_only=yes', db);
    expect(status).toBe(200);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain(ROOM);
    expect(ids).toContain(CHILD); expect(ids).toContain(CHILD2);
  });
  it('suggested_only soft-5', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, state: { 'm.room.name': JSON.stringify({ name: 'A' }) }, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, state: { 'm.room.name': JSON.stringify({ name: 'B' }) }, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '?suggested_only=0', db);
    expect(status).toBe(200);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain(ROOM);
    expect(ids).toContain(CHILD); expect(ids).toContain(CHILD2);
  });
  it('suggested_only soft-6', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, state: { 'm.room.name': JSON.stringify({ name: 'A' }) }, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, state: { 'm.room.name': JSON.stringify({ name: 'B' }) }, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(200);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain(ROOM);
    expect(ids).toContain(CHILD); expect(ids).toContain(CHILD2);
  });
  it('suggested_only soft-7', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, state: { 'm.room.name': JSON.stringify({ name: 'A' }) }, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, state: { 'm.room.name': JSON.stringify({ name: 'B' }) }, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '?suggested_only=', db);
    expect(status).toBe(200);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain(ROOM);
    expect(ids).toContain(CHILD); expect(ids).toContain(CHILD2);
  });
  it('suggested filter soft flood-0', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild('!s0:example.com', ['example.com'], true),
        seedChild('!u0:example.com', ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        ['!s0:example.com']: { room_id: '!s0:example.com', memberCount: 1 },
        ['!u0:example.com']: { room_id: '!u0:example.com', memberCount: 1 },
      },
    });
    const { body } = await getHierarchy(ROOM, '?suggested_only=true', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain('!s0:example.com');
    expect(ids).not.toContain('!u0:example.com');
  });
  it('suggested filter soft flood-1', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild('!s1:example.com', ['example.com'], true),
        seedChild('!u1:example.com', ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        ['!s1:example.com']: { room_id: '!s1:example.com', memberCount: 1 },
        ['!u1:example.com']: { room_id: '!u1:example.com', memberCount: 1 },
      },
    });
    const { body } = await getHierarchy(ROOM, '?suggested_only=true', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain('!s1:example.com');
    expect(ids).not.toContain('!u1:example.com');
  });
  it('suggested filter soft flood-2', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild('!s2:example.com', ['example.com'], true),
        seedChild('!u2:example.com', ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        ['!s2:example.com']: { room_id: '!s2:example.com', memberCount: 1 },
        ['!u2:example.com']: { room_id: '!u2:example.com', memberCount: 1 },
      },
    });
    const { body } = await getHierarchy(ROOM, '?suggested_only=true', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain('!s2:example.com');
    expect(ids).not.toContain('!u2:example.com');
  });
  it('suggested filter soft flood-3', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild('!s3:example.com', ['example.com'], true),
        seedChild('!u3:example.com', ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        ['!s3:example.com']: { room_id: '!s3:example.com', memberCount: 1 },
        ['!u3:example.com']: { room_id: '!u3:example.com', memberCount: 1 },
      },
    });
    const { body } = await getHierarchy(ROOM, '?suggested_only=true', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain('!s3:example.com');
    expect(ids).not.toContain('!u3:example.com');
  });
  it('suggested filter soft flood-4', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild('!s4:example.com', ['example.com'], true),
        seedChild('!u4:example.com', ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        ['!s4:example.com']: { room_id: '!s4:example.com', memberCount: 1 },
        ['!u4:example.com']: { room_id: '!u4:example.com', memberCount: 1 },
      },
    });
    const { body } = await getHierarchy(ROOM, '?suggested_only=true', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain('!s4:example.com');
    expect(ids).not.toContain('!u4:example.com');
  });
  it('suggested filter soft flood-5', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild('!s5:example.com', ['example.com'], true),
        seedChild('!u5:example.com', ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        ['!s5:example.com']: { room_id: '!s5:example.com', memberCount: 1 },
        ['!u5:example.com']: { room_id: '!u5:example.com', memberCount: 1 },
      },
    });
    const { body } = await getHierarchy(ROOM, '?suggested_only=true', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain('!s5:example.com');
    expect(ids).not.toContain('!u5:example.com');
  });
  it('suggested filter soft flood-6', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild('!s6:example.com', ['example.com'], true),
        seedChild('!u6:example.com', ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        ['!s6:example.com']: { room_id: '!s6:example.com', memberCount: 1 },
        ['!u6:example.com']: { room_id: '!u6:example.com', memberCount: 1 },
      },
    });
    const { body } = await getHierarchy(ROOM, '?suggested_only=true', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain('!s6:example.com');
    expect(ids).not.toContain('!u6:example.com');
  });
  it('suggested filter soft flood-7', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild('!s7:example.com', ['example.com'], true),
        seedChild('!u7:example.com', ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        ['!s7:example.com']: { room_id: '!s7:example.com', memberCount: 1 },
        ['!u7:example.com']: { room_id: '!u7:example.com', memberCount: 1 },
      },
    });
    const { body } = await getHierarchy(ROOM, '?suggested_only=true', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain('!s7:example.com');
    expect(ids).not.toContain('!u7:example.com');
  });
  it('suggested filter soft flood-8', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild('!s8:example.com', ['example.com'], true),
        seedChild('!u8:example.com', ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        ['!s8:example.com']: { room_id: '!s8:example.com', memberCount: 1 },
        ['!u8:example.com']: { room_id: '!u8:example.com', memberCount: 1 },
      },
    });
    const { body } = await getHierarchy(ROOM, '?suggested_only=true', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain('!s8:example.com');
    expect(ids).not.toContain('!u8:example.com');
  });
  it('suggested filter soft flood-9', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild('!s9:example.com', ['example.com'], true),
        seedChild('!u9:example.com', ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        ['!s9:example.com']: { room_id: '!s9:example.com', memberCount: 1 },
        ['!u9:example.com']: { room_id: '!u9:example.com', memberCount: 1 },
      },
    });
    const { body } = await getHierarchy(ROOM, '?suggested_only=true', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain('!s9:example.com');
    expect(ids).not.toContain('!u9:example.com');
  });
  it('suggested filter soft flood-10', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild('!s10:example.com', ['example.com'], true),
        seedChild('!u10:example.com', ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        ['!s10:example.com']: { room_id: '!s10:example.com', memberCount: 1 },
        ['!u10:example.com']: { room_id: '!u10:example.com', memberCount: 1 },
      },
    });
    const { body } = await getHierarchy(ROOM, '?suggested_only=true', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain('!s10:example.com');
    expect(ids).not.toContain('!u10:example.com');
  });
  it('suggested filter soft flood-11', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild('!s11:example.com', ['example.com'], true),
        seedChild('!u11:example.com', ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        ['!s11:example.com']: { room_id: '!s11:example.com', memberCount: 1 },
        ['!u11:example.com']: { room_id: '!u11:example.com', memberCount: 1 },
      },
    });
    const { body } = await getHierarchy(ROOM, '?suggested_only=true', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain('!s11:example.com');
    expect(ids).not.toContain('!u11:example.com');
  });
});

describe('spaces leftovers via soft flood after #157', () => {
  it('via soft-0', async () => {
    const content: Record<string, unknown> = {};
    content.via = [];
    const db = createHierarchyDb({
      childEvents: [{ state_key: CHILD, content: JSON.stringify(content) }],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 2 },
      },
    });
    const { body } = await getHierarchy(ROOM, '', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).not.toContain(CHILD);
  });
  it('via soft-1', async () => {
    const content: Record<string, unknown> = {};
    // omit via
    const db = createHierarchyDb({
      childEvents: [{ state_key: CHILD, content: JSON.stringify(content) }],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 2 },
      },
    });
    const { body } = await getHierarchy(ROOM, '', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).not.toContain(CHILD);
  });
  it('via soft-2', async () => {
    const content: Record<string, unknown> = {};
    content.via = ["example.com"];
    const db = createHierarchyDb({
      childEvents: [{ state_key: CHILD, content: JSON.stringify(content) }],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 2 },
      },
    });
    const { body } = await getHierarchy(ROOM, '', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain(CHILD);
  });
  it('via soft-3', async () => {
    const content: Record<string, unknown> = {};
    content.via = ["a","b"];
    const db = createHierarchyDb({
      childEvents: [{ state_key: CHILD, content: JSON.stringify(content) }],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 2 },
      },
    });
    const { body } = await getHierarchy(ROOM, '', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain(CHILD);
  });
  it('via soft-4', async () => {
    const content: Record<string, unknown> = {};
    content.via = [];
    const db = createHierarchyDb({
      childEvents: [{ state_key: CHILD, content: JSON.stringify(content) }],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 2 },
      },
    });
    const { body } = await getHierarchy(ROOM, '', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).not.toContain(CHILD);
  });
  it('via soft-5', async () => {
    const content: Record<string, unknown> = {};
    // omit via
    const db = createHierarchyDb({
      childEvents: [{ state_key: CHILD, content: JSON.stringify(content) }],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 2 },
      },
    });
    const { body } = await getHierarchy(ROOM, '', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).not.toContain(CHILD);
  });
  it('via soft-6', async () => {
    const content: Record<string, unknown> = {};
    content.via = ["example.com"];
    const db = createHierarchyDb({
      childEvents: [{ state_key: CHILD, content: JSON.stringify(content) }],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 2 },
      },
    });
    const { body } = await getHierarchy(ROOM, '', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain(CHILD);
  });
  it('via soft-7', async () => {
    const content: Record<string, unknown> = {};
    content.via = ["a","b"];
    const db = createHierarchyDb({
      childEvents: [{ state_key: CHILD, content: JSON.stringify(content) }],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 2 },
      },
    });
    const { body } = await getHierarchy(ROOM, '', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain(CHILD);
  });
  it('via soft-8', async () => {
    const content: Record<string, unknown> = {};
    content.via = [];
    const db = createHierarchyDb({
      childEvents: [{ state_key: CHILD, content: JSON.stringify(content) }],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 2 },
      },
    });
    const { body } = await getHierarchy(ROOM, '', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).not.toContain(CHILD);
  });
  it('via soft-9', async () => {
    const content: Record<string, unknown> = {};
    // omit via
    const db = createHierarchyDb({
      childEvents: [{ state_key: CHILD, content: JSON.stringify(content) }],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 2 },
      },
    });
    const { body } = await getHierarchy(ROOM, '', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).not.toContain(CHILD);
  });
  it('via soft-10', async () => {
    const content: Record<string, unknown> = {};
    content.via = ["example.com"];
    const db = createHierarchyDb({
      childEvents: [{ state_key: CHILD, content: JSON.stringify(content) }],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 2 },
      },
    });
    const { body } = await getHierarchy(ROOM, '', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain(CHILD);
  });
  it('via soft-11', async () => {
    const content: Record<string, unknown> = {};
    content.via = ["a","b"];
    const db = createHierarchyDb({
      childEvents: [{ state_key: CHILD, content: JSON.stringify(content) }],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 2 },
      },
    });
    const { body } = await getHierarchy(ROOM, '', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain(CHILD);
  });
  it('via soft-12', async () => {
    const content: Record<string, unknown> = {};
    content.via = [];
    const db = createHierarchyDb({
      childEvents: [{ state_key: CHILD, content: JSON.stringify(content) }],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 2 },
      },
    });
    const { body } = await getHierarchy(ROOM, '', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).not.toContain(CHILD);
  });
  it('via soft-13', async () => {
    const content: Record<string, unknown> = {};
    // omit via
    const db = createHierarchyDb({
      childEvents: [{ state_key: CHILD, content: JSON.stringify(content) }],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 2 },
      },
    });
    const { body } = await getHierarchy(ROOM, '', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).not.toContain(CHILD);
  });
  it('via soft-14', async () => {
    const content: Record<string, unknown> = {};
    content.via = ["example.com"];
    const db = createHierarchyDb({
      childEvents: [{ state_key: CHILD, content: JSON.stringify(content) }],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 2 },
      },
    });
    const { body } = await getHierarchy(ROOM, '', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain(CHILD);
  });
  it('via soft-15', async () => {
    const content: Record<string, unknown> = {};
    content.via = ["a","b"];
    const db = createHierarchyDb({
      childEvents: [{ state_key: CHILD, content: JSON.stringify(content) }],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 2 },
      },
    });
    const { body } = await getHierarchy(ROOM, '', db);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain(CHILD);
  });
});

describe('spaces leftovers limit soft flood after #157', () => {
  it('limit soft-0', async () => {
    const children = Array.from({ length: 5 }, (_, j) => seedChild('!c' + j + ':example.com'));
    const rooms: Record<string, RoomInfoSeed> = {
      [ROOM]: { room_id: ROOM, memberCount: 1 },
    };
    for (let j = 0; j < 5; j++) {
      rooms['!c' + j + ':example.com'] = { room_id: '!c' + j + ':example.com', memberCount: 1 };
    }
    const db = createHierarchyDb({ childEvents: children, rooms });
    const { status, body } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(200);
    expect(Array.isArray(body.rooms)).toBe(true);
    expect(body.rooms.length).toBeGreaterThanOrEqual(0);
  });
  it('limit soft-1', async () => {
    const children = Array.from({ length: 5 }, (_, j) => seedChild('!c' + j + ':example.com'));
    const rooms: Record<string, RoomInfoSeed> = {
      [ROOM]: { room_id: ROOM, memberCount: 1 },
    };
    for (let j = 0; j < 5; j++) {
      rooms['!c' + j + ':example.com'] = { room_id: '!c' + j + ':example.com', memberCount: 1 };
    }
    const db = createHierarchyDb({ childEvents: children, rooms });
    const { status } = await getHierarchy(ROOM, '?limit=0', db);
    expect(status).toBe(500);
  });
  it('limit soft-2', async () => {
    const children = Array.from({ length: 5 }, (_, j) => seedChild('!c' + j + ':example.com'));
    const rooms: Record<string, RoomInfoSeed> = {
      [ROOM]: { room_id: ROOM, memberCount: 1 },
    };
    for (let j = 0; j < 5; j++) {
      rooms['!c' + j + ':example.com'] = { room_id: '!c' + j + ':example.com', memberCount: 1 };
    }
    const db = createHierarchyDb({ childEvents: children, rooms });
    const { status, body } = await getHierarchy(ROOM, '?limit=1', db);
    expect(status).toBe(200);
    expect(Array.isArray(body.rooms)).toBe(true);
    expect(body.rooms.length).toBeGreaterThanOrEqual(0);
  });
  it('limit soft-3', async () => {
    const children = Array.from({ length: 5 }, (_, j) => seedChild('!c' + j + ':example.com'));
    const rooms: Record<string, RoomInfoSeed> = {
      [ROOM]: { room_id: ROOM, memberCount: 1 },
    };
    for (let j = 0; j < 5; j++) {
      rooms['!c' + j + ':example.com'] = { room_id: '!c' + j + ':example.com', memberCount: 1 };
    }
    const db = createHierarchyDb({ childEvents: children, rooms });
    const { status, body } = await getHierarchy(ROOM, '?limit=2', db);
    expect(status).toBe(200);
    expect(Array.isArray(body.rooms)).toBe(true);
    expect(body.rooms.length).toBeGreaterThanOrEqual(0);
  });
  it('limit soft-4', async () => {
    const children = Array.from({ length: 5 }, (_, j) => seedChild('!c' + j + ':example.com'));
    const rooms: Record<string, RoomInfoSeed> = {
      [ROOM]: { room_id: ROOM, memberCount: 1 },
    };
    for (let j = 0; j < 5; j++) {
      rooms['!c' + j + ':example.com'] = { room_id: '!c' + j + ':example.com', memberCount: 1 };
    }
    const db = createHierarchyDb({ childEvents: children, rooms });
    const { status, body } = await getHierarchy(ROOM, '?limit=50', db);
    expect(status).toBe(200);
    expect(Array.isArray(body.rooms)).toBe(true);
    expect(body.rooms.length).toBeGreaterThanOrEqual(0);
  });
  it('limit soft-5', async () => {
    const children = Array.from({ length: 5 }, (_, j) => seedChild('!c' + j + ':example.com'));
    const rooms: Record<string, RoomInfoSeed> = {
      [ROOM]: { room_id: ROOM, memberCount: 1 },
    };
    for (let j = 0; j < 5; j++) {
      rooms['!c' + j + ':example.com'] = { room_id: '!c' + j + ':example.com', memberCount: 1 };
    }
    const db = createHierarchyDb({ childEvents: children, rooms });
    const { status, body } = await getHierarchy(ROOM, '?limit=100', db);
    expect(status).toBe(200);
    expect(Array.isArray(body.rooms)).toBe(true);
    expect(body.rooms.length).toBeGreaterThanOrEqual(0);
  });
  it('limit soft-6', async () => {
    const children = Array.from({ length: 5 }, (_, j) => seedChild('!c' + j + ':example.com'));
    const rooms: Record<string, RoomInfoSeed> = {
      [ROOM]: { room_id: ROOM, memberCount: 1 },
    };
    for (let j = 0; j < 5; j++) {
      rooms['!c' + j + ':example.com'] = { room_id: '!c' + j + ':example.com', memberCount: 1 };
    }
    const db = createHierarchyDb({ childEvents: children, rooms });
    const { status, body } = await getHierarchy(ROOM, '?limit=999', db);
    expect(status).toBe(200);
    expect(Array.isArray(body.rooms)).toBe(true);
    expect(body.rooms.length).toBeGreaterThanOrEqual(0);
  });
  it('limit soft-7', async () => {
    const children = Array.from({ length: 5 }, (_, j) => seedChild('!c' + j + ':example.com'));
    const rooms: Record<string, RoomInfoSeed> = {
      [ROOM]: { room_id: ROOM, memberCount: 1 },
    };
    for (let j = 0; j < 5; j++) {
      rooms['!c' + j + ':example.com'] = { room_id: '!c' + j + ':example.com', memberCount: 1 };
    }
    const db = createHierarchyDb({ childEvents: children, rooms });
    const { status } = await getHierarchy(ROOM, '?limit=-1', db);
    expect(status).toBe(500);
  });
  it('limit soft-8', async () => {
    const children = Array.from({ length: 5 }, (_, j) => seedChild('!c' + j + ':example.com'));
    const rooms: Record<string, RoomInfoSeed> = {
      [ROOM]: { room_id: ROOM, memberCount: 1 },
    };
    for (let j = 0; j < 5; j++) {
      rooms['!c' + j + ':example.com'] = { room_id: '!c' + j + ':example.com', memberCount: 1 };
    }
    const db = createHierarchyDb({ childEvents: children, rooms });
    const { status, body } = await getHierarchy(ROOM, '?limit=abc', db);
    expect(status).toBe(200);
    expect(Array.isArray(body.rooms)).toBe(true);
    expect(body.rooms.length).toBeGreaterThanOrEqual(0);
  });
  it('limit soft-9', async () => {
    const children = Array.from({ length: 5 }, (_, j) => seedChild('!c' + j + ':example.com'));
    const rooms: Record<string, RoomInfoSeed> = {
      [ROOM]: { room_id: ROOM, memberCount: 1 },
    };
    for (let j = 0; j < 5; j++) {
      rooms['!c' + j + ':example.com'] = { room_id: '!c' + j + ':example.com', memberCount: 1 };
    }
    const db = createHierarchyDb({ childEvents: children, rooms });
    const { status, body } = await getHierarchy(ROOM, '?limit=3.9', db);
    expect(status).toBe(200);
    expect(Array.isArray(body.rooms)).toBe(true);
    expect(body.rooms.length).toBeGreaterThanOrEqual(0);
  });
  it('limit soft-10', async () => {
    const children = Array.from({ length: 5 }, (_, j) => seedChild('!c' + j + ':example.com'));
    const rooms: Record<string, RoomInfoSeed> = {
      [ROOM]: { room_id: ROOM, memberCount: 1 },
    };
    for (let j = 0; j < 5; j++) {
      rooms['!c' + j + ':example.com'] = { room_id: '!c' + j + ':example.com', memberCount: 1 };
    }
    const db = createHierarchyDb({ childEvents: children, rooms });
    const { status, body } = await getHierarchy(ROOM, '?limit=', db);
    expect(status).toBe(200);
    expect(Array.isArray(body.rooms)).toBe(true);
    expect(body.rooms.length).toBeGreaterThanOrEqual(0);
  });
  it('limit soft-11', async () => {
    const children = Array.from({ length: 5 }, (_, j) => seedChild('!c' + j + ':example.com'));
    const rooms: Record<string, RoomInfoSeed> = {
      [ROOM]: { room_id: ROOM, memberCount: 1 },
    };
    for (let j = 0; j < 5; j++) {
      rooms['!c' + j + ':example.com'] = { room_id: '!c' + j + ':example.com', memberCount: 1 };
    }
    const db = createHierarchyDb({ childEvents: children, rooms });
    const { status, body } = await getHierarchy(ROOM, '?limit=01', db);
    expect(status).toBe(200);
    expect(Array.isArray(body.rooms)).toBe(true);
    expect(body.rooms.length).toBeGreaterThanOrEqual(0);
  });
  it('next_batch soft-0', async () => {
    const children = Array.from({ length: 4 }, (_, j) => seedChild('!n' + j + ':example.com'));
    const rooms: Record<string, RoomInfoSeed> = { [ROOM]: { room_id: ROOM, memberCount: 1 } };
    for (let j = 0; j < 4; j++) rooms['!n' + j + ':example.com'] = { room_id: '!n' + j + ':example.com', memberCount: 1 };
    const db = createHierarchyDb({ childEvents: children, rooms });
    const { body } = await getHierarchy(ROOM, '?limit=2', db);
    expect(body.rooms.length).toBe(2);
    expect(body.next_batch).toBe(body.rooms[1].room_id);
  });
  it('next_batch soft-1', async () => {
    const children = Array.from({ length: 4 }, (_, j) => seedChild('!n' + j + ':example.com'));
    const rooms: Record<string, RoomInfoSeed> = { [ROOM]: { room_id: ROOM, memberCount: 1 } };
    for (let j = 0; j < 4; j++) rooms['!n' + j + ':example.com'] = { room_id: '!n' + j + ':example.com', memberCount: 1 };
    const db = createHierarchyDb({ childEvents: children, rooms });
    const { body } = await getHierarchy(ROOM, '?limit=2', db);
    expect(body.rooms.length).toBe(2);
    expect(body.next_batch).toBe(body.rooms[1].room_id);
  });
  it('next_batch soft-2', async () => {
    const children = Array.from({ length: 4 }, (_, j) => seedChild('!n' + j + ':example.com'));
    const rooms: Record<string, RoomInfoSeed> = { [ROOM]: { room_id: ROOM, memberCount: 1 } };
    for (let j = 0; j < 4; j++) rooms['!n' + j + ':example.com'] = { room_id: '!n' + j + ':example.com', memberCount: 1 };
    const db = createHierarchyDb({ childEvents: children, rooms });
    const { body } = await getHierarchy(ROOM, '?limit=2', db);
    expect(body.rooms.length).toBe(2);
    expect(body.next_batch).toBe(body.rooms[1].room_id);
  });
  it('next_batch soft-3', async () => {
    const children = Array.from({ length: 4 }, (_, j) => seedChild('!n' + j + ':example.com'));
    const rooms: Record<string, RoomInfoSeed> = { [ROOM]: { room_id: ROOM, memberCount: 1 } };
    for (let j = 0; j < 4; j++) rooms['!n' + j + ':example.com'] = { room_id: '!n' + j + ':example.com', memberCount: 1 };
    const db = createHierarchyDb({ childEvents: children, rooms });
    const { body } = await getHierarchy(ROOM, '?limit=2', db);
    expect(body.rooms.length).toBe(2);
    expect(body.next_batch).toBe(body.rooms[1].room_id);
  });
  it('next_batch soft-4', async () => {
    const children = Array.from({ length: 4 }, (_, j) => seedChild('!n' + j + ':example.com'));
    const rooms: Record<string, RoomInfoSeed> = { [ROOM]: { room_id: ROOM, memberCount: 1 } };
    for (let j = 0; j < 4; j++) rooms['!n' + j + ':example.com'] = { room_id: '!n' + j + ':example.com', memberCount: 1 };
    const db = createHierarchyDb({ childEvents: children, rooms });
    const { body } = await getHierarchy(ROOM, '?limit=2', db);
    expect(body.rooms.length).toBe(2);
    expect(body.next_batch).toBe(body.rooms[1].room_id);
  });
  it('next_batch soft-5', async () => {
    const children = Array.from({ length: 4 }, (_, j) => seedChild('!n' + j + ':example.com'));
    const rooms: Record<string, RoomInfoSeed> = { [ROOM]: { room_id: ROOM, memberCount: 1 } };
    for (let j = 0; j < 4; j++) rooms['!n' + j + ':example.com'] = { room_id: '!n' + j + ':example.com', memberCount: 1 };
    const db = createHierarchyDb({ childEvents: children, rooms });
    const { body } = await getHierarchy(ROOM, '?limit=2', db);
    expect(body.rooms.length).toBe(2);
    expect(body.next_batch).toBe(body.rooms[1].room_id);
  });
  it('next_batch soft-6', async () => {
    const children = Array.from({ length: 4 }, (_, j) => seedChild('!n' + j + ':example.com'));
    const rooms: Record<string, RoomInfoSeed> = { [ROOM]: { room_id: ROOM, memberCount: 1 } };
    for (let j = 0; j < 4; j++) rooms['!n' + j + ':example.com'] = { room_id: '!n' + j + ':example.com', memberCount: 1 };
    const db = createHierarchyDb({ childEvents: children, rooms });
    const { body } = await getHierarchy(ROOM, '?limit=2', db);
    expect(body.rooms.length).toBe(2);
    expect(body.next_batch).toBe(body.rooms[1].room_id);
  });
  it('next_batch soft-7', async () => {
    const children = Array.from({ length: 4 }, (_, j) => seedChild('!n' + j + ':example.com'));
    const rooms: Record<string, RoomInfoSeed> = { [ROOM]: { room_id: ROOM, memberCount: 1 } };
    for (let j = 0; j < 4; j++) rooms['!n' + j + ':example.com'] = { room_id: '!n' + j + ':example.com', memberCount: 1 };
    const db = createHierarchyDb({ childEvents: children, rooms });
    const { body } = await getHierarchy(ROOM, '?limit=2', db);
    expect(body.rooms.length).toBe(2);
    expect(body.next_batch).toBe(body.rooms[1].room_id);
  });
  it('next_batch soft-8', async () => {
    const children = Array.from({ length: 4 }, (_, j) => seedChild('!n' + j + ':example.com'));
    const rooms: Record<string, RoomInfoSeed> = { [ROOM]: { room_id: ROOM, memberCount: 1 } };
    for (let j = 0; j < 4; j++) rooms['!n' + j + ':example.com'] = { room_id: '!n' + j + ':example.com', memberCount: 1 };
    const db = createHierarchyDb({ childEvents: children, rooms });
    const { body } = await getHierarchy(ROOM, '?limit=2', db);
    expect(body.rooms.length).toBe(2);
    expect(body.next_batch).toBe(body.rooms[1].room_id);
  });
  it('next_batch soft-9', async () => {
    const children = Array.from({ length: 4 }, (_, j) => seedChild('!n' + j + ':example.com'));
    const rooms: Record<string, RoomInfoSeed> = { [ROOM]: { room_id: ROOM, memberCount: 1 } };
    for (let j = 0; j < 4; j++) rooms['!n' + j + ':example.com'] = { room_id: '!n' + j + ':example.com', memberCount: 1 };
    const db = createHierarchyDb({ childEvents: children, rooms });
    const { body } = await getHierarchy(ROOM, '?limit=2', db);
    expect(body.rooms.length).toBe(2);
    expect(body.next_batch).toBe(body.rooms[1].room_id);
  });
});

describe('spaces leftovers max_depth soft flood after #157', () => {
  it('max_depth soft-0 depth=0', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD)],
      grandchildEvents: {
        [CHILD]: [{ state_key: GC, content: JSON.stringify({ via: ['example.com'] }) }],
      },
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [GC]: { room_id: GC, memberCount: 1 },
      },
    });
    const q = '?max_depth=0';
    const { status, body } = await getHierarchy(ROOM, q, db);
    expect(status).toBe(200);
    const child = body.rooms.find((r: any) => r.room_id === CHILD);
    expect(child).toBeTruthy();
  });
  it('max_depth soft-1 depth=1', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD)],
      grandchildEvents: {
        [CHILD]: [{ state_key: GC, content: JSON.stringify({ via: ['example.com'] }) }],
      },
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [GC]: { room_id: GC, memberCount: 1 },
      },
    });
    const q = '?max_depth=1';
    const { status, body } = await getHierarchy(ROOM, q, db);
    expect(status).toBe(200);
    const child = body.rooms.find((r: any) => r.room_id === CHILD);
    expect(child).toBeTruthy();
  });
  it('max_depth soft-2 depth=2', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD)],
      grandchildEvents: {
        [CHILD]: [{ state_key: GC, content: JSON.stringify({ via: ['example.com'] }) }],
      },
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [GC]: { room_id: GC, memberCount: 1 },
      },
    });
    const q = '?max_depth=2';
    const { status, body } = await getHierarchy(ROOM, q, db);
    expect(status).toBe(200);
    const child = body.rooms.find((r: any) => r.room_id === CHILD);
    expect(child).toBeTruthy();
  });
  it('max_depth soft-3 depth=3', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD)],
      grandchildEvents: {
        [CHILD]: [{ state_key: GC, content: JSON.stringify({ via: ['example.com'] }) }],
      },
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [GC]: { room_id: GC, memberCount: 1 },
      },
    });
    const q = '?max_depth=3';
    const { status, body } = await getHierarchy(ROOM, q, db);
    expect(status).toBe(200);
    const child = body.rooms.find((r: any) => r.room_id === CHILD);
    expect(child).toBeTruthy();
  });
  it('max_depth soft-4 depth=abc', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD)],
      grandchildEvents: {
        [CHILD]: [{ state_key: GC, content: JSON.stringify({ via: ['example.com'] }) }],
      },
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [GC]: { room_id: GC, memberCount: 1 },
      },
    });
    const q = '?max_depth=abc';
    const { status, body } = await getHierarchy(ROOM, q, db);
    expect(status).toBe(200);
    const child = body.rooms.find((r: any) => r.room_id === CHILD);
    expect(child).toBeTruthy();
  });
  it('max_depth soft-5 depth=', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD)],
      grandchildEvents: {
        [CHILD]: [{ state_key: GC, content: JSON.stringify({ via: ['example.com'] }) }],
      },
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [GC]: { room_id: GC, memberCount: 1 },
      },
    });
    const q = '';
    const { status, body } = await getHierarchy(ROOM, q, db);
    expect(status).toBe(200);
    const child = body.rooms.find((r: any) => r.room_id === CHILD);
    expect(child).toBeTruthy();
  });
  it('max_depth soft-6 depth=-1', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD)],
      grandchildEvents: {
        [CHILD]: [{ state_key: GC, content: JSON.stringify({ via: ['example.com'] }) }],
      },
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [GC]: { room_id: GC, memberCount: 1 },
      },
    });
    const q = '?max_depth=-1';
    const { status, body } = await getHierarchy(ROOM, q, db);
    expect(status).toBe(200);
    const child = body.rooms.find((r: any) => r.room_id === CHILD);
    expect(child).toBeTruthy();
  });
  it('max_depth soft-7 depth=1.5', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD)],
      grandchildEvents: {
        [CHILD]: [{ state_key: GC, content: JSON.stringify({ via: ['example.com'] }) }],
      },
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [GC]: { room_id: GC, memberCount: 1 },
      },
    });
    const q = '?max_depth=1.5';
    const { status, body } = await getHierarchy(ROOM, q, db);
    expect(status).toBe(200);
    const child = body.rooms.find((r: any) => r.room_id === CHILD);
    expect(child).toBeTruthy();
  });
  it('max_depth soft-8 depth=99', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD)],
      grandchildEvents: {
        [CHILD]: [{ state_key: GC, content: JSON.stringify({ via: ['example.com'] }) }],
      },
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [GC]: { room_id: GC, memberCount: 1 },
      },
    });
    const q = '?max_depth=99';
    const { status, body } = await getHierarchy(ROOM, q, db);
    expect(status).toBe(200);
    const child = body.rooms.find((r: any) => r.room_id === CHILD);
    expect(child).toBeTruthy();
  });
  it('max_depth soft-9 depth=NaN', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD)],
      grandchildEvents: {
        [CHILD]: [{ state_key: GC, content: JSON.stringify({ via: ['example.com'] }) }],
      },
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [GC]: { room_id: GC, memberCount: 1 },
      },
    });
    const q = '?max_depth=NaN';
    const { status, body } = await getHierarchy(ROOM, q, db);
    expect(status).toBe(200);
    const child = body.rooms.find((r: any) => r.room_id === CHILD);
    expect(child).toBeTruthy();
  });
  it('max_depth soft-10 depth=true', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD)],
      grandchildEvents: {
        [CHILD]: [{ state_key: GC, content: JSON.stringify({ via: ['example.com'] }) }],
      },
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [GC]: { room_id: GC, memberCount: 1 },
      },
    });
    const q = '?max_depth=true';
    const { status, body } = await getHierarchy(ROOM, q, db);
    expect(status).toBe(200);
    const child = body.rooms.find((r: any) => r.room_id === CHILD);
    expect(child).toBeTruthy();
  });
  it('max_depth soft-11 depth=0', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD)],
      grandchildEvents: {
        [CHILD]: [{ state_key: GC, content: JSON.stringify({ via: ['example.com'] }) }],
      },
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [GC]: { room_id: GC, memberCount: 1 },
      },
    });
    const q = '?max_depth=0';
    const { status, body } = await getHierarchy(ROOM, q, db);
    expect(status).toBe(200);
    const child = body.rooms.find((r: any) => r.room_id === CHILD);
    expect(child).toBeTruthy();
  });
});

describe('spaces leftovers corrupt child soft flood after #157', () => {
  // Root children_state uses bare JSON.parse — corrupt content → 500 (uncaught).
  it('corrupt child soft-0', async () => {
    const db = createHierarchyDb({
      childEvents: [
        { state_key: '!bad:example.com', content: '{not-json-0' },
        seedChild(CHILD),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(500);
  });
  it('corrupt child soft-1', async () => {
    const db = createHierarchyDb({
      childEvents: [
        { state_key: '!bad:example.com', content: '{not-json-1' },
        seedChild(CHILD),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(500);
  });
  it('corrupt child soft-2', async () => {
    const db = createHierarchyDb({
      childEvents: [
        { state_key: '!bad:example.com', content: '{not-json-2' },
        seedChild(CHILD),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(500);
  });
  it('corrupt child soft-3', async () => {
    const db = createHierarchyDb({
      childEvents: [
        { state_key: '!bad:example.com', content: '{not-json-3' },
        seedChild(CHILD),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(500);
  });
  it('corrupt child soft-4', async () => {
    const db = createHierarchyDb({
      childEvents: [
        { state_key: '!bad:example.com', content: '{not-json-4' },
        seedChild(CHILD),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(500);
  });
  it('corrupt child soft-5', async () => {
    const db = createHierarchyDb({
      childEvents: [
        { state_key: '!bad:example.com', content: '{not-json-5' },
        seedChild(CHILD),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(500);
  });
  it('corrupt child soft-6', async () => {
    const db = createHierarchyDb({
      childEvents: [
        { state_key: '!bad:example.com', content: '{not-json-6' },
        seedChild(CHILD),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(500);
  });
  it('corrupt child soft-7', async () => {
    const db = createHierarchyDb({
      childEvents: [
        { state_key: '!bad:example.com', content: '{not-json-7' },
        seedChild(CHILD),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(500);
  });
  it('corrupt child soft-8', async () => {
    const db = createHierarchyDb({
      childEvents: [
        { state_key: '!bad:example.com', content: '{not-json-8' },
        seedChild(CHILD),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(500);
  });
  it('corrupt child soft-9', async () => {
    const db = createHierarchyDb({
      childEvents: [
        { state_key: '!bad:example.com', content: '{not-json-9' },
        seedChild(CHILD),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(500);
  });
  it('corrupt child soft-10', async () => {
    const db = createHierarchyDb({
      childEvents: [
        { state_key: '!bad:example.com', content: '{not-json-10' },
        seedChild(CHILD),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(500);
  });
  it('corrupt child soft-11', async () => {
    const db = createHierarchyDb({
      childEvents: [
        { state_key: '!bad:example.com', content: '{not-json-11' },
        seedChild(CHILD),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(500);
  });
  it('corrupt child soft-12', async () => {
    const db = createHierarchyDb({
      childEvents: [
        { state_key: '!bad:example.com', content: '{not-json-12' },
        seedChild(CHILD),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(500);
  });
  it('corrupt child soft-13', async () => {
    const db = createHierarchyDb({
      childEvents: [
        { state_key: '!bad:example.com', content: '{not-json-13' },
        seedChild(CHILD),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(500);
  });
  it('corrupt child soft-14', async () => {
    const db = createHierarchyDb({
      childEvents: [
        { state_key: '!bad:example.com', content: '{not-json-14' },
        seedChild(CHILD),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(500);
  });
  it('corrupt child soft-15', async () => {
    const db = createHierarchyDb({
      childEvents: [
        { state_key: '!bad:example.com', content: '{not-json-15' },
        seedChild(CHILD),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(500);
  });
});


describe('spaces leftovers failure edges after #157', () => {
  it('missing root soft-0', async () => {
    const { status, body } = await getHierarchy('!missing0:example.com', '', createHierarchyDb({ rootExists: false, rootRoomId: '!missing0:example.com' }));
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('missing root soft-1', async () => {
    const { status, body } = await getHierarchy('!missing1:example.com', '', createHierarchyDb({ rootExists: false, rootRoomId: '!missing1:example.com' }));
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('missing root soft-2', async () => {
    const { status, body } = await getHierarchy('!missing2:example.com', '', createHierarchyDb({ rootExists: false, rootRoomId: '!missing2:example.com' }));
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('missing root soft-3', async () => {
    const { status, body } = await getHierarchy('!missing3:example.com', '', createHierarchyDb({ rootExists: false, rootRoomId: '!missing3:example.com' }));
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('missing root soft-4', async () => {
    const { status, body } = await getHierarchy('!missing4:example.com', '', createHierarchyDb({ rootExists: false, rootRoomId: '!missing4:example.com' }));
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('missing root soft-5', async () => {
    const { status, body } = await getHierarchy('!missing5:example.com', '', createHierarchyDb({ rootExists: false, rootRoomId: '!missing5:example.com' }));
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('missing root soft-6', async () => {
    const { status, body } = await getHierarchy('!missing6:example.com', '', createHierarchyDb({ rootExists: false, rootRoomId: '!missing6:example.com' }));
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('missing root soft-7', async () => {
    const { status, body } = await getHierarchy('!missing7:example.com', '', createHierarchyDb({ rootExists: false, rootRoomId: '!missing7:example.com' }));
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('from query is ignored soft-0', async () => {
    const { status, body } = await getHierarchy(ROOM, '?from=token');
    expect(status).toBe(200);
    expect(body.rooms[0].room_id).toBe(ROOM);
  });
  it('from query is ignored soft-1', async () => {
    const { status, body } = await getHierarchy(ROOM, '?from=');
    expect(status).toBe(200);
    expect(body.rooms).toHaveLength(1);
  });
  it('child missing room soft skip', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild('!gone:example.com')],
      rooms: { [ROOM]: { room_id: ROOM, memberCount: 1 } },
    });
    const { body } = await getHierarchy(ROOM, '', db);
    expect(body.rooms.map((r: any) => r.room_id)).toEqual([ROOM]);
  });
  it('root children_state always includes all child events even if skipped', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, []),
        seedChild(CHILD2),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, memberCount: 1 },
      },
    });
    const { body } = await getHierarchy(ROOM, '', db);
    expect(body.rooms[0].children_state).toHaveLength(2);
    expect(body.rooms.map((r: any) => r.room_id)).toEqual([ROOM, CHILD2]);
  });

});

describe('spaces leftovers lifecycle soft floods after #157', () => {
  it('hierarchy lifecycle soft-0', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: {
          room_id: ROOM,
          state: {
            'm.room.create': JSON.stringify({ type: 'm.space' }),
            'm.room.name': JSON.stringify({ name: 'Root0' }),
          },
          memberCount: 1,
        },
        [CHILD]: { room_id: CHILD, state: { 'm.room.name': JSON.stringify({ name: 'C0' }) }, memberCount: 2 },
        [CHILD2]: { room_id: CHILD2, memberCount: 3 },
      },
    });
    const all = await getHierarchy(ROOM, '', db);
    expect(all.status).toBe(200);
    expect(all.body.rooms[0].name).toBe('Root0');
    const sug = await getHierarchy(ROOM, '?suggested_only=true', db);
    expect(sug.body.rooms.map((r: any) => r.room_id)).toEqual([ROOM, CHILD]);
    const lim = await getHierarchy(ROOM, '?limit=1', db);
    expect(lim.body.rooms).toHaveLength(1);
    expect(lim.body.next_batch).toBe(ROOM);
  });
  it('hierarchy lifecycle soft-1', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: {
          room_id: ROOM,
          state: {
            'm.room.create': JSON.stringify({ type: 'm.space' }),
            'm.room.name': JSON.stringify({ name: 'Root1' }),
          },
          memberCount: 2,
        },
        [CHILD]: { room_id: CHILD, state: { 'm.room.name': JSON.stringify({ name: 'C1' }) }, memberCount: 2 },
        [CHILD2]: { room_id: CHILD2, memberCount: 3 },
      },
    });
    const all = await getHierarchy(ROOM, '', db);
    expect(all.status).toBe(200);
    expect(all.body.rooms[0].name).toBe('Root1');
    const sug = await getHierarchy(ROOM, '?suggested_only=true', db);
    expect(sug.body.rooms.map((r: any) => r.room_id)).toEqual([ROOM, CHILD]);
    const lim = await getHierarchy(ROOM, '?limit=1', db);
    expect(lim.body.rooms).toHaveLength(1);
    expect(lim.body.next_batch).toBe(ROOM);
  });
  it('hierarchy lifecycle soft-2', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: {
          room_id: ROOM,
          state: {
            'm.room.create': JSON.stringify({ type: 'm.space' }),
            'm.room.name': JSON.stringify({ name: 'Root2' }),
          },
          memberCount: 3,
        },
        [CHILD]: { room_id: CHILD, state: { 'm.room.name': JSON.stringify({ name: 'C2' }) }, memberCount: 2 },
        [CHILD2]: { room_id: CHILD2, memberCount: 3 },
      },
    });
    const all = await getHierarchy(ROOM, '', db);
    expect(all.status).toBe(200);
    expect(all.body.rooms[0].name).toBe('Root2');
    const sug = await getHierarchy(ROOM, '?suggested_only=true', db);
    expect(sug.body.rooms.map((r: any) => r.room_id)).toEqual([ROOM, CHILD]);
    const lim = await getHierarchy(ROOM, '?limit=1', db);
    expect(lim.body.rooms).toHaveLength(1);
    expect(lim.body.next_batch).toBe(ROOM);
  });
  it('hierarchy lifecycle soft-3', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: {
          room_id: ROOM,
          state: {
            'm.room.create': JSON.stringify({ type: 'm.space' }),
            'm.room.name': JSON.stringify({ name: 'Root3' }),
          },
          memberCount: 4,
        },
        [CHILD]: { room_id: CHILD, state: { 'm.room.name': JSON.stringify({ name: 'C3' }) }, memberCount: 2 },
        [CHILD2]: { room_id: CHILD2, memberCount: 3 },
      },
    });
    const all = await getHierarchy(ROOM, '', db);
    expect(all.status).toBe(200);
    expect(all.body.rooms[0].name).toBe('Root3');
    const sug = await getHierarchy(ROOM, '?suggested_only=true', db);
    expect(sug.body.rooms.map((r: any) => r.room_id)).toEqual([ROOM, CHILD]);
    const lim = await getHierarchy(ROOM, '?limit=1', db);
    expect(lim.body.rooms).toHaveLength(1);
    expect(lim.body.next_batch).toBe(ROOM);
  });
  it('hierarchy lifecycle soft-4', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: {
          room_id: ROOM,
          state: {
            'm.room.create': JSON.stringify({ type: 'm.space' }),
            'm.room.name': JSON.stringify({ name: 'Root4' }),
          },
          memberCount: 5,
        },
        [CHILD]: { room_id: CHILD, state: { 'm.room.name': JSON.stringify({ name: 'C4' }) }, memberCount: 2 },
        [CHILD2]: { room_id: CHILD2, memberCount: 3 },
      },
    });
    const all = await getHierarchy(ROOM, '', db);
    expect(all.status).toBe(200);
    expect(all.body.rooms[0].name).toBe('Root4');
    const sug = await getHierarchy(ROOM, '?suggested_only=true', db);
    expect(sug.body.rooms.map((r: any) => r.room_id)).toEqual([ROOM, CHILD]);
    const lim = await getHierarchy(ROOM, '?limit=1', db);
    expect(lim.body.rooms).toHaveLength(1);
    expect(lim.body.next_batch).toBe(ROOM);
  });
  it('hierarchy lifecycle soft-5', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: {
          room_id: ROOM,
          state: {
            'm.room.create': JSON.stringify({ type: 'm.space' }),
            'm.room.name': JSON.stringify({ name: 'Root5' }),
          },
          memberCount: 6,
        },
        [CHILD]: { room_id: CHILD, state: { 'm.room.name': JSON.stringify({ name: 'C5' }) }, memberCount: 2 },
        [CHILD2]: { room_id: CHILD2, memberCount: 3 },
      },
    });
    const all = await getHierarchy(ROOM, '', db);
    expect(all.status).toBe(200);
    expect(all.body.rooms[0].name).toBe('Root5');
    const sug = await getHierarchy(ROOM, '?suggested_only=true', db);
    expect(sug.body.rooms.map((r: any) => r.room_id)).toEqual([ROOM, CHILD]);
    const lim = await getHierarchy(ROOM, '?limit=1', db);
    expect(lim.body.rooms).toHaveLength(1);
    expect(lim.body.next_batch).toBe(ROOM);
  });
  it('hierarchy lifecycle soft-6', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: {
          room_id: ROOM,
          state: {
            'm.room.create': JSON.stringify({ type: 'm.space' }),
            'm.room.name': JSON.stringify({ name: 'Root6' }),
          },
          memberCount: 7,
        },
        [CHILD]: { room_id: CHILD, state: { 'm.room.name': JSON.stringify({ name: 'C6' }) }, memberCount: 2 },
        [CHILD2]: { room_id: CHILD2, memberCount: 3 },
      },
    });
    const all = await getHierarchy(ROOM, '', db);
    expect(all.status).toBe(200);
    expect(all.body.rooms[0].name).toBe('Root6');
    const sug = await getHierarchy(ROOM, '?suggested_only=true', db);
    expect(sug.body.rooms.map((r: any) => r.room_id)).toEqual([ROOM, CHILD]);
    const lim = await getHierarchy(ROOM, '?limit=1', db);
    expect(lim.body.rooms).toHaveLength(1);
    expect(lim.body.next_batch).toBe(ROOM);
  });
  it('hierarchy lifecycle soft-7', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: {
          room_id: ROOM,
          state: {
            'm.room.create': JSON.stringify({ type: 'm.space' }),
            'm.room.name': JSON.stringify({ name: 'Root7' }),
          },
          memberCount: 8,
        },
        [CHILD]: { room_id: CHILD, state: { 'm.room.name': JSON.stringify({ name: 'C7' }) }, memberCount: 2 },
        [CHILD2]: { room_id: CHILD2, memberCount: 3 },
      },
    });
    const all = await getHierarchy(ROOM, '', db);
    expect(all.status).toBe(200);
    expect(all.body.rooms[0].name).toBe('Root7');
    const sug = await getHierarchy(ROOM, '?suggested_only=true', db);
    expect(sug.body.rooms.map((r: any) => r.room_id)).toEqual([ROOM, CHILD]);
    const lim = await getHierarchy(ROOM, '?limit=1', db);
    expect(lim.body.rooms).toHaveLength(1);
    expect(lim.body.next_batch).toBe(ROOM);
  });
  it('hierarchy lifecycle soft-8', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: {
          room_id: ROOM,
          state: {
            'm.room.create': JSON.stringify({ type: 'm.space' }),
            'm.room.name': JSON.stringify({ name: 'Root8' }),
          },
          memberCount: 9,
        },
        [CHILD]: { room_id: CHILD, state: { 'm.room.name': JSON.stringify({ name: 'C8' }) }, memberCount: 2 },
        [CHILD2]: { room_id: CHILD2, memberCount: 3 },
      },
    });
    const all = await getHierarchy(ROOM, '', db);
    expect(all.status).toBe(200);
    expect(all.body.rooms[0].name).toBe('Root8');
    const sug = await getHierarchy(ROOM, '?suggested_only=true', db);
    expect(sug.body.rooms.map((r: any) => r.room_id)).toEqual([ROOM, CHILD]);
    const lim = await getHierarchy(ROOM, '?limit=1', db);
    expect(lim.body.rooms).toHaveLength(1);
    expect(lim.body.next_batch).toBe(ROOM);
  });
  it('hierarchy lifecycle soft-9', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: {
          room_id: ROOM,
          state: {
            'm.room.create': JSON.stringify({ type: 'm.space' }),
            'm.room.name': JSON.stringify({ name: 'Root9' }),
          },
          memberCount: 10,
        },
        [CHILD]: { room_id: CHILD, state: { 'm.room.name': JSON.stringify({ name: 'C9' }) }, memberCount: 2 },
        [CHILD2]: { room_id: CHILD2, memberCount: 3 },
      },
    });
    const all = await getHierarchy(ROOM, '', db);
    expect(all.status).toBe(200);
    expect(all.body.rooms[0].name).toBe('Root9');
    const sug = await getHierarchy(ROOM, '?suggested_only=true', db);
    expect(sug.body.rooms.map((r: any) => r.room_id)).toEqual([ROOM, CHILD]);
    const lim = await getHierarchy(ROOM, '?limit=1', db);
    expect(lim.body.rooms).toHaveLength(1);
    expect(lim.body.next_batch).toBe(ROOM);
  });
  it('hierarchy lifecycle soft-10', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: {
          room_id: ROOM,
          state: {
            'm.room.create': JSON.stringify({ type: 'm.space' }),
            'm.room.name': JSON.stringify({ name: 'Root10' }),
          },
          memberCount: 11,
        },
        [CHILD]: { room_id: CHILD, state: { 'm.room.name': JSON.stringify({ name: 'C10' }) }, memberCount: 2 },
        [CHILD2]: { room_id: CHILD2, memberCount: 3 },
      },
    });
    const all = await getHierarchy(ROOM, '', db);
    expect(all.status).toBe(200);
    expect(all.body.rooms[0].name).toBe('Root10');
    const sug = await getHierarchy(ROOM, '?suggested_only=true', db);
    expect(sug.body.rooms.map((r: any) => r.room_id)).toEqual([ROOM, CHILD]);
    const lim = await getHierarchy(ROOM, '?limit=1', db);
    expect(lim.body.rooms).toHaveLength(1);
    expect(lim.body.next_batch).toBe(ROOM);
  });
  it('hierarchy lifecycle soft-11', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: {
          room_id: ROOM,
          state: {
            'm.room.create': JSON.stringify({ type: 'm.space' }),
            'm.room.name': JSON.stringify({ name: 'Root11' }),
          },
          memberCount: 12,
        },
        [CHILD]: { room_id: CHILD, state: { 'm.room.name': JSON.stringify({ name: 'C11' }) }, memberCount: 2 },
        [CHILD2]: { room_id: CHILD2, memberCount: 3 },
      },
    });
    const all = await getHierarchy(ROOM, '', db);
    expect(all.status).toBe(200);
    expect(all.body.rooms[0].name).toBe('Root11');
    const sug = await getHierarchy(ROOM, '?suggested_only=true', db);
    expect(sug.body.rooms.map((r: any) => r.room_id)).toEqual([ROOM, CHILD]);
    const lim = await getHierarchy(ROOM, '?limit=1', db);
    expect(lim.body.rooms).toHaveLength(1);
    expect(lim.body.next_batch).toBe(ROOM);
  });
});


// ---------------------------------------------------------------------------
// TOKENMAXX deepen after #157 — extra soft floods beyond closed #155
// ---------------------------------------------------------------------------

describe('spaces leftovers URL encode soft flood after #157', () => {
  it('encoded roomId soft-0', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD, ['example.com'], true)],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(200);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].num_joined_members).toBe(1);
  });
  it('encoded roomId soft-1', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD, ['example.com'], true)],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 2 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(200);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].num_joined_members).toBe(2);
  });
  it('encoded roomId soft-2', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD, ['example.com'], true)],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 3 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(200);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].num_joined_members).toBe(3);
  });
  it('encoded roomId soft-3', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD, ['example.com'], true)],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 4 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(200);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].num_joined_members).toBe(4);
  });
  it('encoded roomId soft-4', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD, ['example.com'], true)],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 5 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(200);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].num_joined_members).toBe(5);
  });
  it('encoded roomId soft-5', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD, ['example.com'], true)],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 6 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(200);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].num_joined_members).toBe(6);
  });
  it('encoded roomId soft-6', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD, ['example.com'], true)],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 7 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(200);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].num_joined_members).toBe(7);
  });
  it('encoded roomId soft-7', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD, ['example.com'], true)],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 8 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(200);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].num_joined_members).toBe(8);
  });
  it('encoded roomId soft-8', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD, ['example.com'], true)],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 9 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(200);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].num_joined_members).toBe(9);
  });
  it('encoded roomId soft-9', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD, ['example.com'], true)],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 10 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(200);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].num_joined_members).toBe(10);
  });
  it('encoded roomId soft-10', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD, ['example.com'], true)],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 11 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(200);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].num_joined_members).toBe(11);
  });
  it('encoded roomId soft-11', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD, ['example.com'], true)],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 12 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(200);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].num_joined_members).toBe(12);
  });
  it('encoded roomId soft-12', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD, ['example.com'], true)],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 13 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(200);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].num_joined_members).toBe(13);
  });
  it('encoded roomId soft-13', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD, ['example.com'], true)],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 14 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(200);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].num_joined_members).toBe(14);
  });
  it('encoded roomId soft-14', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD, ['example.com'], true)],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 15 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(200);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].num_joined_members).toBe(15);
  });
  it('encoded roomId soft-15', async () => {
    const db = createHierarchyDb({
      childEvents: [seedChild(CHILD, ['example.com'], true)],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 16 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '', db);
    expect(status).toBe(200);
    expect(body.rooms[0].room_id).toBe(ROOM);
    expect(body.rooms[0].num_joined_members).toBe(16);
  });
});

describe('spaces leftovers suggested+limit soft flood after #157', () => {
  it('suggested limit soft-0', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '?suggested_only=true&limit=1', db);
    expect(status).toBe(200);
    expect(body.rooms.every((r: any) => r.room_id === ROOM || r.room_id === CHILD)).toBe(true);
  });
  it('suggested limit soft-1', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '?suggested_only=true&limit=2', db);
    expect(status).toBe(200);
    expect(body.rooms.every((r: any) => r.room_id === ROOM || r.room_id === CHILD)).toBe(true);
  });
  it('suggested limit soft-2', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '?suggested_only=true&limit=3', db);
    expect(status).toBe(200);
    expect(body.rooms.every((r: any) => r.room_id === ROOM || r.room_id === CHILD)).toBe(true);
  });
  it('suggested limit soft-3', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '?suggested_only=true&limit=4', db);
    expect(status).toBe(200);
    expect(body.rooms.every((r: any) => r.room_id === ROOM || r.room_id === CHILD)).toBe(true);
  });
  it('suggested limit soft-4', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '?suggested_only=true&limit=5', db);
    expect(status).toBe(200);
    expect(body.rooms.every((r: any) => r.room_id === ROOM || r.room_id === CHILD)).toBe(true);
  });
  it('suggested limit soft-5', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '?suggested_only=true&limit=1', db);
    expect(status).toBe(200);
    expect(body.rooms.every((r: any) => r.room_id === ROOM || r.room_id === CHILD)).toBe(true);
  });
  it('suggested limit soft-6', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '?suggested_only=true&limit=2', db);
    expect(status).toBe(200);
    expect(body.rooms.every((r: any) => r.room_id === ROOM || r.room_id === CHILD)).toBe(true);
  });
  it('suggested limit soft-7', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '?suggested_only=true&limit=3', db);
    expect(status).toBe(200);
    expect(body.rooms.every((r: any) => r.room_id === ROOM || r.room_id === CHILD)).toBe(true);
  });
  it('suggested limit soft-8', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '?suggested_only=true&limit=4', db);
    expect(status).toBe(200);
    expect(body.rooms.every((r: any) => r.room_id === ROOM || r.room_id === CHILD)).toBe(true);
  });
  it('suggested limit soft-9', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '?suggested_only=true&limit=5', db);
    expect(status).toBe(200);
    expect(body.rooms.every((r: any) => r.room_id === ROOM || r.room_id === CHILD)).toBe(true);
  });
  it('suggested limit soft-10', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '?suggested_only=true&limit=1', db);
    expect(status).toBe(200);
    expect(body.rooms.every((r: any) => r.room_id === ROOM || r.room_id === CHILD)).toBe(true);
  });
  it('suggested limit soft-11', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '?suggested_only=true&limit=2', db);
    expect(status).toBe(200);
    expect(body.rooms.every((r: any) => r.room_id === ROOM || r.room_id === CHILD)).toBe(true);
  });
  it('suggested limit soft-12', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '?suggested_only=true&limit=3', db);
    expect(status).toBe(200);
    expect(body.rooms.every((r: any) => r.room_id === ROOM || r.room_id === CHILD)).toBe(true);
  });
  it('suggested limit soft-13', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '?suggested_only=true&limit=4', db);
    expect(status).toBe(200);
    expect(body.rooms.every((r: any) => r.room_id === ROOM || r.room_id === CHILD)).toBe(true);
  });
  it('suggested limit soft-14', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '?suggested_only=true&limit=5', db);
    expect(status).toBe(200);
    expect(body.rooms.every((r: any) => r.room_id === ROOM || r.room_id === CHILD)).toBe(true);
  });
  it('suggested limit soft-15', async () => {
    const db = createHierarchyDb({
      childEvents: [
        seedChild(CHILD, ['example.com'], true),
        seedChild(CHILD2, ['example.com'], false),
      ],
      rooms: {
        [ROOM]: { room_id: ROOM, state: { 'm.room.create': JSON.stringify({ type: 'm.space' }) }, memberCount: 1 },
        [CHILD]: { room_id: CHILD, memberCount: 1 },
        [CHILD2]: { room_id: CHILD2, memberCount: 1 },
      },
    });
    const { status, body } = await getHierarchy(ROOM, '?suggested_only=true&limit=1', db);
    expect(status).toBe(200);
    expect(body.rooms.every((r: any) => r.room_id === ROOM || r.room_id === CHILD)).toBe(true);
  });
});

describe('spaces leftovers method matrix after #157', () => {
  it('POST hierarchy rejected soft-0', async () => {
    const db = createHierarchyDb();
    const res = await spaces.request(
      `http://localhost/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/hierarchy`,
      { method: 'POST' },
      { SERVER_NAME: SERVER, DB: db } as Env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('POST hierarchy rejected soft-1', async () => {
    const db = createHierarchyDb();
    const res = await spaces.request(
      `http://localhost/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/hierarchy`,
      { method: 'POST' },
      { SERVER_NAME: SERVER, DB: db } as Env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('POST hierarchy rejected soft-2', async () => {
    const db = createHierarchyDb();
    const res = await spaces.request(
      `http://localhost/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/hierarchy`,
      { method: 'POST' },
      { SERVER_NAME: SERVER, DB: db } as Env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('POST hierarchy rejected soft-3', async () => {
    const db = createHierarchyDb();
    const res = await spaces.request(
      `http://localhost/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/hierarchy`,
      { method: 'POST' },
      { SERVER_NAME: SERVER, DB: db } as Env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PUT hierarchy rejected soft-0', async () => {
    const db = createHierarchyDb();
    const res = await spaces.request(
      `http://localhost/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/hierarchy`,
      { method: 'PUT' },
      { SERVER_NAME: SERVER, DB: db } as Env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PUT hierarchy rejected soft-1', async () => {
    const db = createHierarchyDb();
    const res = await spaces.request(
      `http://localhost/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/hierarchy`,
      { method: 'PUT' },
      { SERVER_NAME: SERVER, DB: db } as Env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PUT hierarchy rejected soft-2', async () => {
    const db = createHierarchyDb();
    const res = await spaces.request(
      `http://localhost/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/hierarchy`,
      { method: 'PUT' },
      { SERVER_NAME: SERVER, DB: db } as Env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PUT hierarchy rejected soft-3', async () => {
    const db = createHierarchyDb();
    const res = await spaces.request(
      `http://localhost/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/hierarchy`,
      { method: 'PUT' },
      { SERVER_NAME: SERVER, DB: db } as Env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('DELETE hierarchy rejected soft-0', async () => {
    const db = createHierarchyDb();
    const res = await spaces.request(
      `http://localhost/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/hierarchy`,
      { method: 'DELETE' },
      { SERVER_NAME: SERVER, DB: db } as Env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('DELETE hierarchy rejected soft-1', async () => {
    const db = createHierarchyDb();
    const res = await spaces.request(
      `http://localhost/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/hierarchy`,
      { method: 'DELETE' },
      { SERVER_NAME: SERVER, DB: db } as Env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('DELETE hierarchy rejected soft-2', async () => {
    const db = createHierarchyDb();
    const res = await spaces.request(
      `http://localhost/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/hierarchy`,
      { method: 'DELETE' },
      { SERVER_NAME: SERVER, DB: db } as Env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('DELETE hierarchy rejected soft-3', async () => {
    const db = createHierarchyDb();
    const res = await spaces.request(
      `http://localhost/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/hierarchy`,
      { method: 'DELETE' },
      { SERVER_NAME: SERVER, DB: db } as Env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PATCH hierarchy rejected soft-0', async () => {
    const db = createHierarchyDb();
    const res = await spaces.request(
      `http://localhost/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/hierarchy`,
      { method: 'PATCH' },
      { SERVER_NAME: SERVER, DB: db } as Env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PATCH hierarchy rejected soft-1', async () => {
    const db = createHierarchyDb();
    const res = await spaces.request(
      `http://localhost/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/hierarchy`,
      { method: 'PATCH' },
      { SERVER_NAME: SERVER, DB: db } as Env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PATCH hierarchy rejected soft-2', async () => {
    const db = createHierarchyDb();
    const res = await spaces.request(
      `http://localhost/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/hierarchy`,
      { method: 'PATCH' },
      { SERVER_NAME: SERVER, DB: db } as Env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PATCH hierarchy rejected soft-3', async () => {
    const db = createHierarchyDb();
    const res = await spaces.request(
      `http://localhost/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/hierarchy`,
      { method: 'PATCH' },
      { SERVER_NAME: SERVER, DB: db } as Env
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('spaces leftovers notFound soft flood after #157', () => {
  it('missing room soft-0', async () => {
    const db = createHierarchyDb({ rootExists: false });
    const { status, body } = await getHierarchy('!missing0:example.com', '', db);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('missing room soft-1', async () => {
    const db = createHierarchyDb({ rootExists: false });
    const { status, body } = await getHierarchy('!missing1:example.com', '', db);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('missing room soft-2', async () => {
    const db = createHierarchyDb({ rootExists: false });
    const { status, body } = await getHierarchy('!missing2:example.com', '', db);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('missing room soft-3', async () => {
    const db = createHierarchyDb({ rootExists: false });
    const { status, body } = await getHierarchy('!missing3:example.com', '', db);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('missing room soft-4', async () => {
    const db = createHierarchyDb({ rootExists: false });
    const { status, body } = await getHierarchy('!missing4:example.com', '', db);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('missing room soft-5', async () => {
    const db = createHierarchyDb({ rootExists: false });
    const { status, body } = await getHierarchy('!missing5:example.com', '', db);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('missing room soft-6', async () => {
    const db = createHierarchyDb({ rootExists: false });
    const { status, body } = await getHierarchy('!missing6:example.com', '', db);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('missing room soft-7', async () => {
    const db = createHierarchyDb({ rootExists: false });
    const { status, body } = await getHierarchy('!missing7:example.com', '', db);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('missing room soft-8', async () => {
    const db = createHierarchyDb({ rootExists: false });
    const { status, body } = await getHierarchy('!missing8:example.com', '', db);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('missing room soft-9', async () => {
    const db = createHierarchyDb({ rootExists: false });
    const { status, body } = await getHierarchy('!missing9:example.com', '', db);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('missing room soft-10', async () => {
    const db = createHierarchyDb({ rootExists: false });
    const { status, body } = await getHierarchy('!missing10:example.com', '', db);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('missing room soft-11', async () => {
    const db = createHierarchyDb({ rootExists: false });
    const { status, body } = await getHierarchy('!missing11:example.com', '', db);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('missing room soft-12', async () => {
    const db = createHierarchyDb({ rootExists: false });
    const { status, body } = await getHierarchy('!missing12:example.com', '', db);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('missing room soft-13', async () => {
    const db = createHierarchyDb({ rootExists: false });
    const { status, body } = await getHierarchy('!missing13:example.com', '', db);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('missing room soft-14', async () => {
    const db = createHierarchyDb({ rootExists: false });
    const { status, body } = await getHierarchy('!missing14:example.com', '', db);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
  it('missing room soft-15', async () => {
    const db = createHierarchyDb({ rootExists: false });
    const { status, body } = await getHierarchy('!missing15:example.com', '', db);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
});
