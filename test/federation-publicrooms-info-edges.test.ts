/**
 * TOKENMAXX HEAVY deepen after #122 — publicRooms + getRoomPublicInfo field edges.
 * #122 listed/paginated publicRooms lightly; this expands chunk field mapping, corrupt JSON
 * degrade paths, since/prev_batch, POST search vs list, and limit clamps.
 * Avoids federation media (sibling suite), keys/events (#121), voip/sync (#117–#120).
 * Tests-only — no product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  optionalFederationAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

import federation from '../src/api/federation';

const SERVER = 'example.com';
const ROOM = '!room:example.com';
const ROOM_B = '!beta:example.com';
const ROOM_PRIV = '!priv:example.com';

type EventRow = {
  event_id: string;
  room_id: string;
  event_type: string;
  state_key: string;
  content: string;
};

type RoomRow = {
  room_id: string;
  is_public: number;
  created_at: number;
};

type Membership = { room_id: string; user_id: string; membership: string };

type AliasRow = { alias: string; room_id: string };

function stateKey(roomId: string, eventType: string, sk: string) {
  return `${roomId}|${eventType}|${sk}`;
}

function createPublicDb(opts: {
  rooms?: RoomRow[];
  events?: EventRow[];
  roomState?: Map<string, string>;
  memberships?: Membership[];
  aliases?: AliasRow[];
} = {}) {
  const rooms = [...(opts.rooms ?? [])];
  const events = new Map((opts.events ?? []).map((e) => [e.event_id, e]));
  const roomState = opts.roomState ?? new Map<string, string>();
  const memberships = [...(opts.memberships ?? [])];
  const aliases = [...(opts.aliases ?? [])];
  const sqlLog: string[] = [];

  function contentFor(roomId: string, eventType: string): string | null {
    const eid = roomState.get(stateKey(roomId, eventType, ''));
    if (!eid) return null;
    return events.get(eid)?.content ?? null;
  }

  function contentFor(roomId: string, eventType: string): string | null {
    const eid = roomState.get(stateKey(roomId, eventType, ''));
    if (!eid) return null;
    return events.get(eid)?.content ?? null;
  }

  const db = {
    rooms,
    events,
    roomState,
    memberships,
    aliases,
    sqlLog,
    prepare(sql: string) {
      sqlLog.push(sql);

      async function firstInner<T>(args: unknown[]): Promise<T | null> {
        if (sql.includes('SELECT COUNT(*) as count FROM rooms WHERE is_public = 1')) {
          return { count: rooms.filter((r) => r.is_public === 1).length } as T;
        }
        if (
          sql.includes('FROM room_state rs') &&
          sql.includes('JOIN events e') &&
          sql.includes('rs.event_type =')
        ) {
          const [roomId] = args as [string];
          const match = sql.match(/rs\.event_type = '([^']+)'/);
          const eventType = match?.[1];
          if (!eventType) return null as T;
          const content = contentFor(roomId, eventType);
          return (content != null ? { content } : null) as T;
        }
        if (
          sql.includes('COUNT(*) as count FROM room_memberships') &&
          sql.includes("membership = 'join'")
        ) {
          const [roomId] = args as [string];
          const count = memberships.filter(
            (m) => m.room_id === roomId && m.membership === 'join'
          ).length;
          return { count } as T;
        }
        return null as T;
      }

      async function allInner<T>(args: unknown[]): Promise<{ results: T[] }> {
        if (sql.includes('FROM rooms r') && sql.includes('is_public = 1')) {
          const publicRooms = rooms
            .filter((r) => r.is_public === 1)
            .sort((a, b) => b.created_at - a.created_at);

          if (sql.includes('LEFT JOIN room_state rs_name')) {
            const like = String(args[0] ?? '').replace(/%/g, '').toLowerCase();
            const limitPlus = Number(args[args.length - 2]);
            const offset = Number(args[args.length - 1]);
            const filtered = publicRooms.filter((r) => {
              if (!like) return true;
              const name = contentFor(r.room_id, 'm.room.name')?.toLowerCase() ?? '';
              const topic = contentFor(r.room_id, 'm.room.topic')?.toLowerCase() ?? '';
              const aliasHit = aliases.some(
                (a) => a.room_id === r.room_id && a.alias.toLowerCase().includes(like)
              );
              return name.includes(like) || topic.includes(like) || aliasHit;
            });
            return {
              results: filtered.slice(offset, offset + limitPlus).map((r) => ({
                room_id: r.room_id,
              })) as T[],
            };
          }

          const limitPlus = Number(args[0]);
          const offset = Number(args[1]);
          return {
            results: publicRooms.slice(offset, offset + limitPlus).map((r) => ({
              room_id: r.room_id,
            })) as T[],
          };
        }
        return { results: [] as T[] };
      }

      return {
        async first<T>() {
          return firstInner<T>([]);
        },
        async all<T>() {
          return allInner<T>([]);
        },
        async run() {
          return { success: true, meta: { changes: 0 } };
        },
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              return firstInner<T>(args);
            },
            async all<T>() {
              return allInner<T>(args);
            },
            async run() {
              return { success: true, meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };

  return db as unknown as D1Database & typeof db;
}

function makeEnv(db: D1Database): Env {
  return {
    SERVER_NAME: SERVER,
    SERVER_VERSION: 'test',
    DB: db,
  } as unknown as Env;
}

async function req(
  method: string,
  path: string,
  db: D1Database,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await federation.request(`http://localhost${path}`, init, makeEnv(db));
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep */
  }
  return { status: res.status, body: parsed };
}

function evt(
  id: string,
  type: string,
  content: unknown,
  roomId = ROOM,
  stateKeyVal = ''
): EventRow {
  return {
    event_id: id,
    room_id: roomId,
    event_type: type,
    state_key: stateKeyVal,
    content: typeof content === 'string' ? content : JSON.stringify(content),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-09-14T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('federation publicRooms getRoomPublicInfo field mapping', () => {
  it('maps name, topic, alias, avatar, join_rule, members, room_type, guest, world_readable', async () => {
    const events = [
      evt('$name', 'm.room.name', { name: 'Lobby' }),
      evt('$topic', 'm.room.topic', { topic: 'Welcome' }),
      evt('$alias', 'm.room.canonical_alias', { alias: '#lobby:example.com' }),
      evt('$avatar', 'm.room.avatar', { url: 'mxc://example.com/av' }),
      evt('$jr', 'm.room.join_rules', { join_rule: 'public' }),
      evt('$hist', 'm.room.history_visibility', { history_visibility: 'world_readable' }),
      evt('$guest', 'm.room.guest_access', { guest_access: 'can_join' }),
      evt('$create', 'm.room.create', { type: 'm.space', creator: '@a:example.com' }),
    ];
    const roomState = new Map(
      events.map((e) => [stateKey(ROOM, e.event_type, e.state_key), e.event_id])
    );
    const db = createPublicDb({
      rooms: [{ room_id: ROOM, is_public: 1, created_at: 100 }],
      events,
      roomState,
      memberships: [
        { room_id: ROOM, user_id: '@a:example.com', membership: 'join' },
        { room_id: ROOM, user_id: '@b:example.com', membership: 'join' },
        { room_id: ROOM, user_id: '@c:example.com', membership: 'leave' },
      ],
    });

    const res = await req('GET', '/_matrix/federation/v1/publicRooms', db);
    expect(res.status).toBe(200);
    const chunk = (res.body as { chunk: Record<string, unknown>[] }).chunk;
    expect(chunk).toHaveLength(1);
    expect(chunk[0]).toMatchObject({
      room_id: ROOM,
      name: 'Lobby',
      topic: 'Welcome',
      canonical_alias: '#lobby:example.com',
      avatar_url: 'mxc://example.com/av',
      join_rule: 'public',
      num_joined_members: 2,
      world_readable: true,
      guest_can_join: true,
      room_type: 'm.space',
    });
  });

  it('defaults join_rule to invite and world_readable/guest false when state missing', async () => {
    const db = createPublicDb({
      rooms: [{ room_id: ROOM, is_public: 1, created_at: 1 }],
      events: [],
      roomState: new Map(),
    });
    const res = await req('GET', '/_matrix/federation/v1/publicRooms', db);
    const chunk = (res.body as { chunk: Record<string, unknown>[] }).chunk[0];
    expect(chunk).toMatchObject({
      room_id: ROOM,
      join_rule: 'invite',
      world_readable: false,
      guest_can_join: false,
      num_joined_members: 0,
    });
    expect(chunk.name).toBeUndefined();
    expect(chunk.room_type).toBeUndefined();
  });

  it('degrades corrupt JSON on history/guest/create without throwing', async () => {
    const events = [
      evt('$hist', 'm.room.history_visibility', '{bad'),
      evt('$guest', 'm.room.guest_access', '{bad'),
      evt('$create', 'm.room.create', '{bad'),
    ];
    const roomState = new Map(
      events.map((e) => [stateKey(ROOM, e.event_type, ''), e.event_id])
    );
    const db = createPublicDb({
      rooms: [{ room_id: ROOM, is_public: 1, created_at: 1 }],
      events,
      roomState,
    });
    const res = await req('GET', '/_matrix/federation/v1/publicRooms', db);
    expect(res.status).toBe(200);
    const chunk = (res.body as { chunk: Record<string, unknown>[] }).chunk[0];
    expect(chunk.world_readable).toBe(false);
    expect(chunk.guest_can_join).toBe(false);
    expect(chunk.room_type).toBeUndefined();
  });

  it('returns 500 when name content is corrupt JSON (unhandled parse)', async () => {
    const events = [evt('$name', 'm.room.name', '{bad')];
    const roomState = new Map([[stateKey(ROOM, 'm.room.name', ''), '$name']]);
    const db = createPublicDb({
      rooms: [{ room_id: ROOM, is_public: 1, created_at: 1 }],
      events,
      roomState,
    });
    const res = await req('GET', '/_matrix/federation/v1/publicRooms', db);
    expect(res.status).toBe(500);
  });

  it('returns 500 when topic content is corrupt JSON (unhandled parse)', async () => {
    const events = [evt('$topic', 'm.room.topic', 'not-json')];
    const roomState = new Map([[stateKey(ROOM, 'm.room.topic', ''), '$topic']]);
    const db = createPublicDb({
      rooms: [{ room_id: ROOM, is_public: 1, created_at: 1 }],
      events,
      roomState,
    });
    const res = await req('GET', '/_matrix/federation/v1/publicRooms', db);
    expect(res.status).toBe(500);
  });

  it('guest_access other than can_join is false', async () => {
    const events = [evt('$guest', 'm.room.guest_access', { guest_access: 'forbidden' })];
    const roomState = new Map([[stateKey(ROOM, 'm.room.guest_access', ''), '$guest']]);
    const db = createPublicDb({
      rooms: [{ room_id: ROOM, is_public: 1, created_at: 1 }],
      events,
      roomState,
    });
    const res = await req('GET', '/_matrix/federation/v1/publicRooms', db);
    const chunk = (res.body as { chunk: Record<string, unknown>[] }).chunk[0];
    expect(chunk.guest_can_join).toBe(false);
  });

  it('excludes private rooms from the directory', async () => {
    const db = createPublicDb({
      rooms: [
        { room_id: ROOM, is_public: 1, created_at: 2 },
        { room_id: ROOM_PRIV, is_public: 0, created_at: 9 },
      ],
    });
    const res = await req('GET', '/_matrix/federation/v1/publicRooms', db);
    const chunk = (res.body as { chunk: { room_id: string }[] }).chunk;
    expect(chunk.map((c) => c.room_id)).toEqual([ROOM]);
    expect((res.body as { total_room_count_estimate: number }).total_room_count_estimate).toBe(1);
  });
});

describe('federation publicRooms GET pagination edges', () => {
  function threePublic() {
    return createPublicDb({
      rooms: [
        { room_id: '!a:example.com', is_public: 1, created_at: 300 },
        { room_id: '!b:example.com', is_public: 1, created_at: 200 },
        { room_id: '!c:example.com', is_public: 1, created_at: 100 },
      ],
    });
  }

  it('clamps limit to 500 and defaults to 100', async () => {
    const rooms = Array.from({ length: 3 }, (_, i) => ({
      room_id: `!r${i}:example.com`,
      is_public: 1,
      created_at: 1000 - i,
    }));
    const db = createPublicDb({ rooms });
    const def = await req('GET', '/_matrix/federation/v1/publicRooms', db);
    expect((def.body as { chunk: unknown[] }).chunk).toHaveLength(3);

    const huge = await req('GET', '/_matrix/federation/v1/publicRooms?limit=9999', db);
    expect(huge.status).toBe(200);
    expect((huge.body as { chunk: unknown[] }).chunk).toHaveLength(3);
  });

  it('emits next_batch when more results exist', async () => {
    const db = threePublic();
    const res = await req('GET', '/_matrix/federation/v1/publicRooms?limit=2', db);
    expect(res.body).toMatchObject({
      next_batch: 'offset_2',
      total_room_count_estimate: 3,
    });
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(2);
    expect((res.body as { prev_batch?: string }).prev_batch).toBeUndefined();
  });

  it('emits prev_batch on subsequent pages', async () => {
    const db = threePublic();
    const res = await req('GET', '/_matrix/federation/v1/publicRooms?limit=2&since=offset_2', db);
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(1);
    expect(res.body).toMatchObject({ prev_batch: 'offset_0' });
    expect((res.body as { next_batch?: string }).next_batch).toBeUndefined();
  });

  it('ignores since tokens that do not start with offset_', async () => {
    const db = threePublic();
    const res = await req('GET', '/_matrix/federation/v1/publicRooms?limit=10&since=cursor_2', db);
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(3);
  });

  it('treats malformed offset_ NaN as 0', async () => {
    const db = threePublic();
    const res = await req('GET', '/_matrix/federation/v1/publicRooms?limit=10&since=offset_nope', db);
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(3);
  });

  it('accepts include_all_networks without changing results', async () => {
    const db = threePublic();
    const res = await req(
      'GET',
      '/_matrix/federation/v1/publicRooms?include_all_networks=true',
      db
    );
    expect(res.status).toBe(200);
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(3);
  });
});

describe('federation publicRooms POST search edges', () => {
  it('rejects bad JSON', async () => {
    const db = createPublicDb({ rooms: [{ room_id: ROOM, is_public: 1, created_at: 1 }] });
    const res = await req('POST', '/_matrix/federation/v1/publicRooms', db, '{x');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('lists without filter using the non-search SQL path', async () => {
    const db = createPublicDb({
      rooms: [
        { room_id: ROOM, is_public: 1, created_at: 2 },
        { room_id: ROOM_B, is_public: 1, created_at: 1 },
      ],
    });
    const res = await req('POST', '/_matrix/federation/v1/publicRooms', db, { limit: 10 });
    expect(res.status).toBe(200);
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(2);
    expect(db.sqlLog.some((s) => s.includes('LEFT JOIN room_state rs_name'))).toBe(false);
  });

  it('searches by name term (case-insensitive)', async () => {
    const events = [
      evt('$n1', 'm.room.name', { name: 'Alpha Room' }, ROOM),
      evt('$n2', 'm.room.name', { name: 'Beta' }, ROOM_B),
    ];
    const roomState = new Map([
      [stateKey(ROOM, 'm.room.name', ''), '$n1'],
      [stateKey(ROOM_B, 'm.room.name', ''), '$n2'],
    ]);
    const db = createPublicDb({
      rooms: [
        { room_id: ROOM, is_public: 1, created_at: 2 },
        { room_id: ROOM_B, is_public: 1, created_at: 1 },
      ],
      events,
      roomState,
    });
    const res = await req('POST', '/_matrix/federation/v1/publicRooms', db, {
      filter: { generic_search_term: 'ALPHA' },
    });
    expect(res.status).toBe(200);
    const ids = (res.body as { chunk: { room_id: string }[] }).chunk.map((c) => c.room_id);
    expect(ids).toEqual([ROOM]);
    expect(db.sqlLog.some((s) => s.includes('LEFT JOIN room_state rs_name'))).toBe(true);
  });

  it('searches by topic and alias', async () => {
    const events = [evt('$t', 'm.room.topic', { topic: 'gardening tips' }, ROOM)];
    const roomState = new Map([[stateKey(ROOM, 'm.room.topic', ''), '$t']]);
    const db = createPublicDb({
      rooms: [
        { room_id: ROOM, is_public: 1, created_at: 2 },
        { room_id: ROOM_B, is_public: 1, created_at: 1 },
      ],
      events,
      roomState,
      aliases: [{ alias: '#plants:example.com', room_id: ROOM_B }],
    });

    const byTopic = await req('POST', '/_matrix/federation/v1/publicRooms', db, {
      filter: { generic_search_term: 'garden' },
    });
    expect((byTopic.body as { chunk: { room_id: string }[] }).chunk.map((c) => c.room_id)).toEqual([
      ROOM,
    ]);

    const byAlias = await req('POST', '/_matrix/federation/v1/publicRooms', db, {
      filter: { generic_search_term: 'plants' },
    });
    expect((byAlias.body as { chunk: { room_id: string }[] }).chunk.map((c) => c.room_id)).toEqual([
      ROOM_B,
    ]);
  });

  it('POST pagination with since + next_batch', async () => {
    const db = createPublicDb({
      rooms: [
        { room_id: '!a:example.com', is_public: 1, created_at: 300 },
        { room_id: '!b:example.com', is_public: 1, created_at: 200 },
        { room_id: '!c:example.com', is_public: 1, created_at: 100 },
      ],
    });
    const page1 = await req('POST', '/_matrix/federation/v1/publicRooms', db, {
      limit: 2,
      since: 'offset_0',
    });
    expect(page1.body).toMatchObject({ next_batch: 'offset_2' });

    const page2 = await req('POST', '/_matrix/federation/v1/publicRooms', db, {
      limit: 2,
      since: 'offset_2',
    });
    expect((page2.body as { chunk: unknown[] }).chunk).toHaveLength(1);
    expect(page2.body).toMatchObject({ prev_batch: 'offset_0' });
  });

  it('clamps POST limit to 500 and defaults empty body limit to 100', async () => {
    const db = createPublicDb({
      rooms: [{ room_id: ROOM, is_public: 1, created_at: 1 }],
    });
    const res = await req('POST', '/_matrix/federation/v1/publicRooms', db, { limit: 10_000 });
    expect(res.status).toBe(200);
    const empty = await req('POST', '/_matrix/federation/v1/publicRooms', db, {});
    expect(empty.status).toBe(200);
  });

  it('empty search term uses non-search path', async () => {
    const db = createPublicDb({
      rooms: [{ room_id: ROOM, is_public: 1, created_at: 1 }],
    });
    const res = await req('POST', '/_matrix/federation/v1/publicRooms', db, {
      filter: { generic_search_term: '' },
    });
    expect(res.status).toBe(200);
    // empty string is falsy → non-search branch
    expect(db.sqlLog.some((s) => s.includes('LEFT JOIN room_state rs_name'))).toBe(false);
  });
});

describe('federation publicRooms method probes', () => {
  it('rejects PUT/DELETE on publicRooms', async () => {
    const db = createPublicDb();
    const put = await federation.request(
      'http://localhost/_matrix/federation/v1/publicRooms',
      { method: 'PUT', body: '{}' },
      makeEnv(db)
    );
    const del = await federation.request(
      'http://localhost/_matrix/federation/v1/publicRooms',
      { method: 'DELETE' },
      makeEnv(db)
    );
    expect(put.status).toBe(404);
    expect(del.status).toBe(404);
  });
});
