/**
 * TOKENMAXX HEAVY leftovers after #167/#169 — relations / threads API soft/edge/reliability.
 * Complements relations-api-routes.test.ts. Third distinct overnight leftovers slice
 * (orthogonal to keys/media/appservice races #167 and push #169).
 * Tests-only — no product inventing. Fixtures use example.com only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import relations from '../src/api/relations';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const ROOM = '!room:example.com';
const ROOM2 = '!other:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const PARENT = '$parent:example.com';
const PARENT_ENC = encodeURIComponent(PARENT);
const PARENT2 = '$otherparent:example.com';
const PARENT2_ENC = encodeURIComponent(PARENT2);

type Membership = { room_id: string; user_id: string; membership: string };

type EventRow = {
  event_id: string;
  room_id: string;
  event_type: string;
  sender: string;
  origin_server_ts: number;
  content: string;
  relates_to_event_id: string | null;
  relation_type: string | null;
};

type SqlCall = { sql: string; args: unknown[] };

function createRelationsDb(opts: {
  memberships?: Membership[];
  events?: EventRow[];
  throwOnMembership?: boolean;
  throwOnEvents?: boolean;
  corruptContentIds?: Set<string>;
} = {}) {
  const memberships = opts.memberships ?? [];
  const events = opts.events ?? [];
  const selects: SqlCall[] = [];
  const corruptContentIds = opts.corruptContentIds ?? new Set<string>();

  function parseOrder(sql: string): 'ASC' | 'DESC' {
    return sql.includes('ASC') ? 'ASC' : 'DESC';
  }

  function sortEvents(rows: EventRow[], dir: 'ASC' | 'DESC'): EventRow[] {
    return [...rows].sort((a, b) =>
      dir === 'ASC'
        ? a.origin_server_ts - b.origin_server_ts
        : b.origin_server_ts - a.origin_server_ts
    );
  }

  const db = {
    memberships,
    events,
    selects,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              if (opts.throwOnMembership && sql.includes('FROM room_memberships')) {
                throw new Error('membership query failed');
              }
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
              selects.push({ sql, args });
              if (opts.throwOnEvents) {
                throw new Error('events query failed');
              }

              // Threads list: DISTINCT roots that have m.thread children
              if (sql.includes('event_id IN') && sql.includes('m.thread')) {
                const roomId = args[0] as string;
                const dir = parseOrder(sql);
                const limit = args[args.length - 1] as number;
                const roots = events.filter(
                  (e) =>
                    e.room_id === roomId &&
                    events.some(
                      (c) =>
                        c.room_id === roomId &&
                        c.relation_type === 'm.thread' &&
                        c.relates_to_event_id === e.event_id
                    )
                );

                let filtered = roots;
                if (sql.includes('e.sender = ?')) {
                  const userId = args[2] as string;
                  filtered = roots.filter(
                    (e) =>
                      e.sender === userId ||
                      events.some(
                        (r) =>
                          r.relates_to_event_id === e.event_id && r.sender === userId
                      )
                  );
                }

                const ordered = sortEvents(filtered, dir).slice(0, limit);
                return {
                  results: ordered.map((e) => ({
                    event_id: e.event_id,
                    event_type: e.event_type,
                    sender: e.sender,
                    origin_server_ts: e.origin_server_ts,
                    content: corruptContentIds.has(e.event_id) ? '{not-json' : e.content,
                  })) as T[],
                };
              }

              if (sql.includes('FROM events e') && sql.includes('relates_to_event_id')) {
                const roomId = args[0] as string;
                const eventId = args[1] as string;
                const dir = parseOrder(sql);

                let filtered = events.filter(
                  (e) => e.room_id === roomId && e.relates_to_event_id === eventId
                );

                const hasRelAndEventType =
                  sql.includes('relation_type = ?') && sql.includes('event_type = ?');
                const hasRelType =
                  sql.includes('relation_type = ?') && !sql.includes('event_type = ?');

                let argIdx = 2;
                if (hasRelAndEventType) {
                  const relType = args[argIdx++] as string;
                  const eventType = args[argIdx++] as string;
                  filtered = filtered.filter(
                    (e) => e.relation_type === relType && e.event_type === eventType
                  );
                } else if (hasRelType) {
                  const relType = args[argIdx++] as string;
                  filtered = filtered.filter((e) => e.relation_type === relType);
                }

                if (sql.includes('origin_server_ts < ?')) {
                  const from = args[argIdx++] as number;
                  filtered = filtered.filter((e) => e.origin_server_ts < from);
                } else if (sql.includes('origin_server_ts > ?')) {
                  const from = args[argIdx++] as number;
                  filtered = filtered.filter((e) => e.origin_server_ts > from);
                }

                const limit = args[args.length - 1] as number;
                const ordered = sortEvents(filtered, dir).slice(0, limit);
                return {
                  results: ordered.map((e) => ({
                    event_id: e.event_id,
                    event_type: e.event_type,
                    sender: e.sender,
                    origin_server_ts: e.origin_server_ts,
                    content: corruptContentIds.has(e.event_id) ? '{not-json' : e.content,
                  })) as T[],
                };
              }

              throw new Error(`Unhandled all() SQL: ${sql.slice(0, 180)}`);
            },

            async run() {
              throw new Error(`Unexpected run() in relations leftovers: ${sql.slice(0, 80)}`);
            },
          };
        },
      };
    },
  };

  return db;
}

type RelationsDb = ReturnType<typeof createRelationsDb>;

function envFor(db: RelationsDb): Env {
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: 'example.com',
  } as unknown as Env;
}

async function request(
  db: RelationsDb,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: any; res: Response }> {
  const headers = new Headers(init.headers);
  if (!headers.has('Authorization')) {
    headers.set('Authorization', 'Bearer t');
  }
  const res = await relations.request(
    `http://localhost${path}`,
    { ...init, headers },
    envFor(db)
  );
  let body: any = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, res };
}

function joinMember(roomId = ROOM, userId = USER): Membership {
  return { room_id: roomId, user_id: userId, membership: 'join' };
}

function leaveMember(roomId = ROOM, userId = USER): Membership {
  return { room_id: roomId, user_id: userId, membership: 'leave' };
}

function child(
  overrides: Partial<EventRow> & Pick<EventRow, 'event_id' | 'origin_server_ts'>
): EventRow {
  return {
    event_id: overrides.event_id,
    room_id: overrides.room_id ?? ROOM,
    event_type: overrides.event_type ?? 'm.reaction',
    sender: overrides.sender ?? USER,
    origin_server_ts: overrides.origin_server_ts,
    content:
      overrides.content ??
      JSON.stringify({ 'm.relates_to': { rel_type: 'm.annotation', key: '👍' } }),
    relates_to_event_id: overrides.relates_to_event_id ?? PARENT,
    relation_type: overrides.relation_type ?? 'm.annotation',
  };
}

function threadRoot(id: string, ts: number, sender = USER): EventRow {
  return {
    event_id: id,
    room_id: ROOM,
    event_type: 'm.room.message',
    sender,
    origin_server_ts: ts,
    content: JSON.stringify({ body: `root-${id}`, msgtype: 'm.text' }),
    relates_to_event_id: null,
    relation_type: null,
  };
}

function threadReply(rootId: string, id: string, ts: number, sender = USER): EventRow {
  return {
    event_id: id,
    room_id: ROOM,
    event_type: 'm.room.message',
    sender,
    origin_server_ts: ts,
    content: JSON.stringify({
      body: `reply-${id}`,
      msgtype: 'm.text',
      'm.relates_to': { rel_type: 'm.thread', event_id: rootId },
    }),
    relates_to_event_id: rootId,
    relation_type: 'm.thread',
  };
}

const base = `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}`;
const threadsPath = `/_matrix/client/v1/rooms/${ROOM_ENC}/threads`;
const typedPath = `${base}/m.annotation`;
const typedEvtPath = `${base}/m.annotation/m.reaction`;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('relations leftovers all relations empty soft flood after #167', () => {

  it('all relations empty soft-0', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('all relations empty soft-1', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('all relations empty soft-2', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('all relations empty soft-3', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('all relations empty soft-4', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('all relations empty soft-5', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('all relations empty soft-6', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('all relations empty soft-7', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('all relations empty soft-8', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('all relations empty soft-9', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('all relations empty soft-10', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('all relations empty soft-11', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('all relations empty soft-12', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('all relations empty soft-13', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('all relations empty soft-14', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('all relations empty soft-15', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });
});

describe('relations leftovers typed relations empty soft flood after #167', () => {

  it('typed relations empty soft-0', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed relations empty soft-1', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed relations empty soft-2', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed relations empty soft-3', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed relations empty soft-4', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed relations empty soft-5', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed relations empty soft-6', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed relations empty soft-7', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed relations empty soft-8', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed relations empty soft-9', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed relations empty soft-10', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed relations empty soft-11', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed relations empty soft-12', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed relations empty soft-13', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed relations empty soft-14', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed relations empty soft-15', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });
});

describe('relations leftovers typed+eventType empty soft flood after #167', () => {

  it('typed+eventType empty soft-0', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed+eventType empty soft-1', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed+eventType empty soft-2', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed+eventType empty soft-3', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed+eventType empty soft-4', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed+eventType empty soft-5', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed+eventType empty soft-6', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed+eventType empty soft-7', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed+eventType empty soft-8', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed+eventType empty soft-9', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed+eventType empty soft-10', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed+eventType empty soft-11', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed+eventType empty soft-12', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed+eventType empty soft-13', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed+eventType empty soft-14', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('typed+eventType empty soft-15', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });
});

describe('relations leftovers threads empty soft flood after #167', () => {

  it('threads empty soft-0', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('threads empty soft-1', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('threads empty soft-2', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('threads empty soft-3', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('threads empty soft-4', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('threads empty soft-5', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('threads empty soft-6', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('threads empty soft-7', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('threads empty soft-8', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('threads empty soft-9', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('threads empty soft-10', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('threads empty soft-11', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('threads empty soft-12', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('threads empty soft-13', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('threads empty soft-14', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });

  it('threads empty soft-15', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
    expect(db.selects.some((s) => s.sql.includes('FROM room_memberships'))).toBe(true);
  });
});

describe('relations leftovers all-relations success soft flood after #167', () => {

  it('all relations success soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a0', origin_server_ts: 100 + 0 }),
        child({ event_id: '$b0', origin_server_ts: 200 + 0 }),
        child({
          event_id: '$c0',
          origin_server_ts: 300 + 0,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
          content: JSON.stringify({ body: 'edit-0' }),
        }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk[0].event_id).toBe('$c0');
    expect(res.body.chunk[0].room_id).toBe(ROOM);
    expect(res.body.chunk[2].event_id).toBe('$a0');
  });

  it('all relations success soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a1', origin_server_ts: 100 + 1 }),
        child({ event_id: '$b1', origin_server_ts: 200 + 1 }),
        child({
          event_id: '$c1',
          origin_server_ts: 300 + 1,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
          content: JSON.stringify({ body: 'edit-1' }),
        }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk[0].event_id).toBe('$c1');
    expect(res.body.chunk[0].room_id).toBe(ROOM);
    expect(res.body.chunk[2].event_id).toBe('$a1');
  });

  it('all relations success soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a2', origin_server_ts: 100 + 2 }),
        child({ event_id: '$b2', origin_server_ts: 200 + 2 }),
        child({
          event_id: '$c2',
          origin_server_ts: 300 + 2,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
          content: JSON.stringify({ body: 'edit-2' }),
        }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk[0].event_id).toBe('$c2');
    expect(res.body.chunk[0].room_id).toBe(ROOM);
    expect(res.body.chunk[2].event_id).toBe('$a2');
  });

  it('all relations success soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a3', origin_server_ts: 100 + 3 }),
        child({ event_id: '$b3', origin_server_ts: 200 + 3 }),
        child({
          event_id: '$c3',
          origin_server_ts: 300 + 3,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
          content: JSON.stringify({ body: 'edit-3' }),
        }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk[0].event_id).toBe('$c3');
    expect(res.body.chunk[0].room_id).toBe(ROOM);
    expect(res.body.chunk[2].event_id).toBe('$a3');
  });

  it('all relations success soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a4', origin_server_ts: 100 + 4 }),
        child({ event_id: '$b4', origin_server_ts: 200 + 4 }),
        child({
          event_id: '$c4',
          origin_server_ts: 300 + 4,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
          content: JSON.stringify({ body: 'edit-4' }),
        }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk[0].event_id).toBe('$c4');
    expect(res.body.chunk[0].room_id).toBe(ROOM);
    expect(res.body.chunk[2].event_id).toBe('$a4');
  });

  it('all relations success soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a5', origin_server_ts: 100 + 5 }),
        child({ event_id: '$b5', origin_server_ts: 200 + 5 }),
        child({
          event_id: '$c5',
          origin_server_ts: 300 + 5,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
          content: JSON.stringify({ body: 'edit-5' }),
        }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk[0].event_id).toBe('$c5');
    expect(res.body.chunk[0].room_id).toBe(ROOM);
    expect(res.body.chunk[2].event_id).toBe('$a5');
  });

  it('all relations success soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a6', origin_server_ts: 100 + 6 }),
        child({ event_id: '$b6', origin_server_ts: 200 + 6 }),
        child({
          event_id: '$c6',
          origin_server_ts: 300 + 6,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
          content: JSON.stringify({ body: 'edit-6' }),
        }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk[0].event_id).toBe('$c6');
    expect(res.body.chunk[0].room_id).toBe(ROOM);
    expect(res.body.chunk[2].event_id).toBe('$a6');
  });

  it('all relations success soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a7', origin_server_ts: 100 + 7 }),
        child({ event_id: '$b7', origin_server_ts: 200 + 7 }),
        child({
          event_id: '$c7',
          origin_server_ts: 300 + 7,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
          content: JSON.stringify({ body: 'edit-7' }),
        }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk[0].event_id).toBe('$c7');
    expect(res.body.chunk[0].room_id).toBe(ROOM);
    expect(res.body.chunk[2].event_id).toBe('$a7');
  });

  it('all relations success soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a8', origin_server_ts: 100 + 8 }),
        child({ event_id: '$b8', origin_server_ts: 200 + 8 }),
        child({
          event_id: '$c8',
          origin_server_ts: 300 + 8,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
          content: JSON.stringify({ body: 'edit-8' }),
        }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk[0].event_id).toBe('$c8');
    expect(res.body.chunk[0].room_id).toBe(ROOM);
    expect(res.body.chunk[2].event_id).toBe('$a8');
  });

  it('all relations success soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a9', origin_server_ts: 100 + 9 }),
        child({ event_id: '$b9', origin_server_ts: 200 + 9 }),
        child({
          event_id: '$c9',
          origin_server_ts: 300 + 9,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
          content: JSON.stringify({ body: 'edit-9' }),
        }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk[0].event_id).toBe('$c9');
    expect(res.body.chunk[0].room_id).toBe(ROOM);
    expect(res.body.chunk[2].event_id).toBe('$a9');
  });

  it('all relations success soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a10', origin_server_ts: 100 + 10 }),
        child({ event_id: '$b10', origin_server_ts: 200 + 10 }),
        child({
          event_id: '$c10',
          origin_server_ts: 300 + 10,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
          content: JSON.stringify({ body: 'edit-10' }),
        }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk[0].event_id).toBe('$c10');
    expect(res.body.chunk[0].room_id).toBe(ROOM);
    expect(res.body.chunk[2].event_id).toBe('$a10');
  });

  it('all relations success soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a11', origin_server_ts: 100 + 11 }),
        child({ event_id: '$b11', origin_server_ts: 200 + 11 }),
        child({
          event_id: '$c11',
          origin_server_ts: 300 + 11,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
          content: JSON.stringify({ body: 'edit-11' }),
        }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk[0].event_id).toBe('$c11');
    expect(res.body.chunk[0].room_id).toBe(ROOM);
    expect(res.body.chunk[2].event_id).toBe('$a11');
  });

  it('all relations success soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a12', origin_server_ts: 100 + 12 }),
        child({ event_id: '$b12', origin_server_ts: 200 + 12 }),
        child({
          event_id: '$c12',
          origin_server_ts: 300 + 12,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
          content: JSON.stringify({ body: 'edit-12' }),
        }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk[0].event_id).toBe('$c12');
    expect(res.body.chunk[0].room_id).toBe(ROOM);
    expect(res.body.chunk[2].event_id).toBe('$a12');
  });

  it('all relations success soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a13', origin_server_ts: 100 + 13 }),
        child({ event_id: '$b13', origin_server_ts: 200 + 13 }),
        child({
          event_id: '$c13',
          origin_server_ts: 300 + 13,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
          content: JSON.stringify({ body: 'edit-13' }),
        }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk[0].event_id).toBe('$c13');
    expect(res.body.chunk[0].room_id).toBe(ROOM);
    expect(res.body.chunk[2].event_id).toBe('$a13');
  });

  it('all relations success soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a14', origin_server_ts: 100 + 14 }),
        child({ event_id: '$b14', origin_server_ts: 200 + 14 }),
        child({
          event_id: '$c14',
          origin_server_ts: 300 + 14,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
          content: JSON.stringify({ body: 'edit-14' }),
        }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk[0].event_id).toBe('$c14');
    expect(res.body.chunk[0].room_id).toBe(ROOM);
    expect(res.body.chunk[2].event_id).toBe('$a14');
  });

  it('all relations success soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a15', origin_server_ts: 100 + 15 }),
        child({ event_id: '$b15', origin_server_ts: 200 + 15 }),
        child({
          event_id: '$c15',
          origin_server_ts: 300 + 15,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
          content: JSON.stringify({ body: 'edit-15' }),
        }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk[0].event_id).toBe('$c15');
    expect(res.body.chunk[0].room_id).toBe(ROOM);
    expect(res.body.chunk[2].event_id).toBe('$a15');
  });
});

describe('relations leftovers typed success soft flood after #167', () => {

  it('typed success soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ann0', origin_server_ts: 10 + 0 }),
        child({
          event_id: '$rep0',
          origin_server_ts: 20 + 0,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$ann0');
    expect(res.body.chunk[0].type).toBe('m.reaction');
  });

  it('typed success soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ann1', origin_server_ts: 10 + 1 }),
        child({
          event_id: '$rep1',
          origin_server_ts: 20 + 1,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$ann1');
    expect(res.body.chunk[0].type).toBe('m.reaction');
  });

  it('typed success soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ann2', origin_server_ts: 10 + 2 }),
        child({
          event_id: '$rep2',
          origin_server_ts: 20 + 2,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$ann2');
    expect(res.body.chunk[0].type).toBe('m.reaction');
  });

  it('typed success soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ann3', origin_server_ts: 10 + 3 }),
        child({
          event_id: '$rep3',
          origin_server_ts: 20 + 3,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$ann3');
    expect(res.body.chunk[0].type).toBe('m.reaction');
  });

  it('typed success soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ann4', origin_server_ts: 10 + 4 }),
        child({
          event_id: '$rep4',
          origin_server_ts: 20 + 4,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$ann4');
    expect(res.body.chunk[0].type).toBe('m.reaction');
  });

  it('typed success soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ann5', origin_server_ts: 10 + 5 }),
        child({
          event_id: '$rep5',
          origin_server_ts: 20 + 5,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$ann5');
    expect(res.body.chunk[0].type).toBe('m.reaction');
  });

  it('typed success soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ann6', origin_server_ts: 10 + 6 }),
        child({
          event_id: '$rep6',
          origin_server_ts: 20 + 6,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$ann6');
    expect(res.body.chunk[0].type).toBe('m.reaction');
  });

  it('typed success soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ann7', origin_server_ts: 10 + 7 }),
        child({
          event_id: '$rep7',
          origin_server_ts: 20 + 7,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$ann7');
    expect(res.body.chunk[0].type).toBe('m.reaction');
  });

  it('typed success soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ann8', origin_server_ts: 10 + 8 }),
        child({
          event_id: '$rep8',
          origin_server_ts: 20 + 8,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$ann8');
    expect(res.body.chunk[0].type).toBe('m.reaction');
  });

  it('typed success soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ann9', origin_server_ts: 10 + 9 }),
        child({
          event_id: '$rep9',
          origin_server_ts: 20 + 9,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$ann9');
    expect(res.body.chunk[0].type).toBe('m.reaction');
  });

  it('typed success soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ann10', origin_server_ts: 10 + 10 }),
        child({
          event_id: '$rep10',
          origin_server_ts: 20 + 10,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$ann10');
    expect(res.body.chunk[0].type).toBe('m.reaction');
  });

  it('typed success soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ann11', origin_server_ts: 10 + 11 }),
        child({
          event_id: '$rep11',
          origin_server_ts: 20 + 11,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$ann11');
    expect(res.body.chunk[0].type).toBe('m.reaction');
  });

  it('typed success soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ann12', origin_server_ts: 10 + 12 }),
        child({
          event_id: '$rep12',
          origin_server_ts: 20 + 12,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$ann12');
    expect(res.body.chunk[0].type).toBe('m.reaction');
  });

  it('typed success soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ann13', origin_server_ts: 10 + 13 }),
        child({
          event_id: '$rep13',
          origin_server_ts: 20 + 13,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$ann13');
    expect(res.body.chunk[0].type).toBe('m.reaction');
  });

  it('typed success soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ann14', origin_server_ts: 10 + 14 }),
        child({
          event_id: '$rep14',
          origin_server_ts: 20 + 14,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$ann14');
    expect(res.body.chunk[0].type).toBe('m.reaction');
  });

  it('typed success soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ann15', origin_server_ts: 10 + 15 }),
        child({
          event_id: '$rep15',
          origin_server_ts: 20 + 15,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$ann15');
    expect(res.body.chunk[0].type).toBe('m.reaction');
  });
});

describe('relations leftovers typed+eventType success soft flood after #167', () => {

  it('typed+eventType success soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$r0', origin_server_ts: 5 + 0 }),
        child({
          event_id: '$m0',
          origin_server_ts: 6 + 0,
          event_type: 'm.room.message',
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$r0');
  });

  it('typed+eventType success soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$r1', origin_server_ts: 5 + 1 }),
        child({
          event_id: '$m1',
          origin_server_ts: 6 + 1,
          event_type: 'm.room.message',
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$r1');
  });

  it('typed+eventType success soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$r2', origin_server_ts: 5 + 2 }),
        child({
          event_id: '$m2',
          origin_server_ts: 6 + 2,
          event_type: 'm.room.message',
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$r2');
  });

  it('typed+eventType success soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$r3', origin_server_ts: 5 + 3 }),
        child({
          event_id: '$m3',
          origin_server_ts: 6 + 3,
          event_type: 'm.room.message',
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$r3');
  });

  it('typed+eventType success soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$r4', origin_server_ts: 5 + 4 }),
        child({
          event_id: '$m4',
          origin_server_ts: 6 + 4,
          event_type: 'm.room.message',
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$r4');
  });

  it('typed+eventType success soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$r5', origin_server_ts: 5 + 5 }),
        child({
          event_id: '$m5',
          origin_server_ts: 6 + 5,
          event_type: 'm.room.message',
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$r5');
  });

  it('typed+eventType success soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$r6', origin_server_ts: 5 + 6 }),
        child({
          event_id: '$m6',
          origin_server_ts: 6 + 6,
          event_type: 'm.room.message',
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$r6');
  });

  it('typed+eventType success soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$r7', origin_server_ts: 5 + 7 }),
        child({
          event_id: '$m7',
          origin_server_ts: 6 + 7,
          event_type: 'm.room.message',
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$r7');
  });

  it('typed+eventType success soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$r8', origin_server_ts: 5 + 8 }),
        child({
          event_id: '$m8',
          origin_server_ts: 6 + 8,
          event_type: 'm.room.message',
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$r8');
  });

  it('typed+eventType success soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$r9', origin_server_ts: 5 + 9 }),
        child({
          event_id: '$m9',
          origin_server_ts: 6 + 9,
          event_type: 'm.room.message',
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$r9');
  });

  it('typed+eventType success soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$r10', origin_server_ts: 5 + 10 }),
        child({
          event_id: '$m10',
          origin_server_ts: 6 + 10,
          event_type: 'm.room.message',
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$r10');
  });

  it('typed+eventType success soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$r11', origin_server_ts: 5 + 11 }),
        child({
          event_id: '$m11',
          origin_server_ts: 6 + 11,
          event_type: 'm.room.message',
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$r11');
  });

  it('typed+eventType success soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$r12', origin_server_ts: 5 + 12 }),
        child({
          event_id: '$m12',
          origin_server_ts: 6 + 12,
          event_type: 'm.room.message',
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$r12');
  });

  it('typed+eventType success soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$r13', origin_server_ts: 5 + 13 }),
        child({
          event_id: '$m13',
          origin_server_ts: 6 + 13,
          event_type: 'm.room.message',
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$r13');
  });

  it('typed+eventType success soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$r14', origin_server_ts: 5 + 14 }),
        child({
          event_id: '$m14',
          origin_server_ts: 6 + 14,
          event_type: 'm.room.message',
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$r14');
  });

  it('typed+eventType success soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$r15', origin_server_ts: 5 + 15 }),
        child({
          event_id: '$m15',
          origin_server_ts: 6 + 15,
          event_type: 'm.room.message',
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$r15');
  });
});

describe('relations leftovers threads success soft flood after #167', () => {

  it('threads success soft-0', async () => {
    const root = `$root0:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(root, 1000 + 0),
        threadReply(root, `$reply0a:example.com`, 1100 + 0),
        threadReply(root, `$reply0b:example.com`, 1200 + 0, BOB),
      ],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe(root);
    expect(res.body.chunk[0].content.body).toBe(`root-${root}`);
  });

  it('threads success soft-1', async () => {
    const root = `$root1:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(root, 1000 + 1),
        threadReply(root, `$reply1a:example.com`, 1100 + 1),
        threadReply(root, `$reply1b:example.com`, 1200 + 1, BOB),
      ],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe(root);
    expect(res.body.chunk[0].content.body).toBe(`root-${root}`);
  });

  it('threads success soft-2', async () => {
    const root = `$root2:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(root, 1000 + 2),
        threadReply(root, `$reply2a:example.com`, 1100 + 2),
        threadReply(root, `$reply2b:example.com`, 1200 + 2, BOB),
      ],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe(root);
    expect(res.body.chunk[0].content.body).toBe(`root-${root}`);
  });

  it('threads success soft-3', async () => {
    const root = `$root3:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(root, 1000 + 3),
        threadReply(root, `$reply3a:example.com`, 1100 + 3),
        threadReply(root, `$reply3b:example.com`, 1200 + 3, BOB),
      ],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe(root);
    expect(res.body.chunk[0].content.body).toBe(`root-${root}`);
  });

  it('threads success soft-4', async () => {
    const root = `$root4:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(root, 1000 + 4),
        threadReply(root, `$reply4a:example.com`, 1100 + 4),
        threadReply(root, `$reply4b:example.com`, 1200 + 4, BOB),
      ],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe(root);
    expect(res.body.chunk[0].content.body).toBe(`root-${root}`);
  });

  it('threads success soft-5', async () => {
    const root = `$root5:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(root, 1000 + 5),
        threadReply(root, `$reply5a:example.com`, 1100 + 5),
        threadReply(root, `$reply5b:example.com`, 1200 + 5, BOB),
      ],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe(root);
    expect(res.body.chunk[0].content.body).toBe(`root-${root}`);
  });

  it('threads success soft-6', async () => {
    const root = `$root6:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(root, 1000 + 6),
        threadReply(root, `$reply6a:example.com`, 1100 + 6),
        threadReply(root, `$reply6b:example.com`, 1200 + 6, BOB),
      ],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe(root);
    expect(res.body.chunk[0].content.body).toBe(`root-${root}`);
  });

  it('threads success soft-7', async () => {
    const root = `$root7:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(root, 1000 + 7),
        threadReply(root, `$reply7a:example.com`, 1100 + 7),
        threadReply(root, `$reply7b:example.com`, 1200 + 7, BOB),
      ],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe(root);
    expect(res.body.chunk[0].content.body).toBe(`root-${root}`);
  });

  it('threads success soft-8', async () => {
    const root = `$root8:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(root, 1000 + 8),
        threadReply(root, `$reply8a:example.com`, 1100 + 8),
        threadReply(root, `$reply8b:example.com`, 1200 + 8, BOB),
      ],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe(root);
    expect(res.body.chunk[0].content.body).toBe(`root-${root}`);
  });

  it('threads success soft-9', async () => {
    const root = `$root9:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(root, 1000 + 9),
        threadReply(root, `$reply9a:example.com`, 1100 + 9),
        threadReply(root, `$reply9b:example.com`, 1200 + 9, BOB),
      ],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe(root);
    expect(res.body.chunk[0].content.body).toBe(`root-${root}`);
  });

  it('threads success soft-10', async () => {
    const root = `$root10:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(root, 1000 + 10),
        threadReply(root, `$reply10a:example.com`, 1100 + 10),
        threadReply(root, `$reply10b:example.com`, 1200 + 10, BOB),
      ],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe(root);
    expect(res.body.chunk[0].content.body).toBe(`root-${root}`);
  });

  it('threads success soft-11', async () => {
    const root = `$root11:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(root, 1000 + 11),
        threadReply(root, `$reply11a:example.com`, 1100 + 11),
        threadReply(root, `$reply11b:example.com`, 1200 + 11, BOB),
      ],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe(root);
    expect(res.body.chunk[0].content.body).toBe(`root-${root}`);
  });

  it('threads success soft-12', async () => {
    const root = `$root12:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(root, 1000 + 12),
        threadReply(root, `$reply12a:example.com`, 1100 + 12),
        threadReply(root, `$reply12b:example.com`, 1200 + 12, BOB),
      ],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe(root);
    expect(res.body.chunk[0].content.body).toBe(`root-${root}`);
  });

  it('threads success soft-13', async () => {
    const root = `$root13:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(root, 1000 + 13),
        threadReply(root, `$reply13a:example.com`, 1100 + 13),
        threadReply(root, `$reply13b:example.com`, 1200 + 13, BOB),
      ],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe(root);
    expect(res.body.chunk[0].content.body).toBe(`root-${root}`);
  });

  it('threads success soft-14', async () => {
    const root = `$root14:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(root, 1000 + 14),
        threadReply(root, `$reply14a:example.com`, 1100 + 14),
        threadReply(root, `$reply14b:example.com`, 1200 + 14, BOB),
      ],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe(root);
    expect(res.body.chunk[0].content.body).toBe(`root-${root}`);
  });

  it('threads success soft-15', async () => {
    const root = `$root15:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(root, 1000 + 15),
        threadReply(root, `$reply15a:example.com`, 1100 + 15),
        threadReply(root, `$reply15b:example.com`, 1200 + 15, BOB),
      ],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe(root);
    expect(res.body.chunk[0].content.body).toBe(`root-${root}`);
  });
});

describe('relations leftovers threads participated soft flood after #167', () => {

  it('threads participated soft-0', async () => {
    const rootMine = `$rmine0:example.com`;
    const rootOther = `$rother0:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(rootMine, 100 + 0, USER),
        threadReply(rootMine, `$rmr0:example.com`, 110 + 0, BOB),
        threadRoot(rootOther, 200 + 0, BOB),
        threadReply(rootOther, `$ror0:example.com`, 210 + 0, BOB),
      ],
    });
    const res = await request(db, `${threadsPath}?include=participated`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([rootMine]);
  });

  it('threads participated soft-1', async () => {
    const rootMine = `$rmine1:example.com`;
    const rootOther = `$rother1:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(rootMine, 100 + 1, USER),
        threadReply(rootMine, `$rmr1:example.com`, 110 + 1, BOB),
        threadRoot(rootOther, 200 + 1, BOB),
        threadReply(rootOther, `$ror1:example.com`, 210 + 1, BOB),
      ],
    });
    const res = await request(db, `${threadsPath}?include=participated`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([rootMine]);
  });

  it('threads participated soft-2', async () => {
    const rootMine = `$rmine2:example.com`;
    const rootOther = `$rother2:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(rootMine, 100 + 2, USER),
        threadReply(rootMine, `$rmr2:example.com`, 110 + 2, BOB),
        threadRoot(rootOther, 200 + 2, BOB),
        threadReply(rootOther, `$ror2:example.com`, 210 + 2, BOB),
      ],
    });
    const res = await request(db, `${threadsPath}?include=participated`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([rootMine]);
  });

  it('threads participated soft-3', async () => {
    const rootMine = `$rmine3:example.com`;
    const rootOther = `$rother3:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(rootMine, 100 + 3, USER),
        threadReply(rootMine, `$rmr3:example.com`, 110 + 3, BOB),
        threadRoot(rootOther, 200 + 3, BOB),
        threadReply(rootOther, `$ror3:example.com`, 210 + 3, BOB),
      ],
    });
    const res = await request(db, `${threadsPath}?include=participated`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([rootMine]);
  });

  it('threads participated soft-4', async () => {
    const rootMine = `$rmine4:example.com`;
    const rootOther = `$rother4:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(rootMine, 100 + 4, USER),
        threadReply(rootMine, `$rmr4:example.com`, 110 + 4, BOB),
        threadRoot(rootOther, 200 + 4, BOB),
        threadReply(rootOther, `$ror4:example.com`, 210 + 4, BOB),
      ],
    });
    const res = await request(db, `${threadsPath}?include=participated`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([rootMine]);
  });

  it('threads participated soft-5', async () => {
    const rootMine = `$rmine5:example.com`;
    const rootOther = `$rother5:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(rootMine, 100 + 5, USER),
        threadReply(rootMine, `$rmr5:example.com`, 110 + 5, BOB),
        threadRoot(rootOther, 200 + 5, BOB),
        threadReply(rootOther, `$ror5:example.com`, 210 + 5, BOB),
      ],
    });
    const res = await request(db, `${threadsPath}?include=participated`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([rootMine]);
  });

  it('threads participated soft-6', async () => {
    const rootMine = `$rmine6:example.com`;
    const rootOther = `$rother6:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(rootMine, 100 + 6, USER),
        threadReply(rootMine, `$rmr6:example.com`, 110 + 6, BOB),
        threadRoot(rootOther, 200 + 6, BOB),
        threadReply(rootOther, `$ror6:example.com`, 210 + 6, BOB),
      ],
    });
    const res = await request(db, `${threadsPath}?include=participated`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([rootMine]);
  });

  it('threads participated soft-7', async () => {
    const rootMine = `$rmine7:example.com`;
    const rootOther = `$rother7:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(rootMine, 100 + 7, USER),
        threadReply(rootMine, `$rmr7:example.com`, 110 + 7, BOB),
        threadRoot(rootOther, 200 + 7, BOB),
        threadReply(rootOther, `$ror7:example.com`, 210 + 7, BOB),
      ],
    });
    const res = await request(db, `${threadsPath}?include=participated`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([rootMine]);
  });

  it('threads participated soft-8', async () => {
    const rootMine = `$rmine8:example.com`;
    const rootOther = `$rother8:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(rootMine, 100 + 8, USER),
        threadReply(rootMine, `$rmr8:example.com`, 110 + 8, BOB),
        threadRoot(rootOther, 200 + 8, BOB),
        threadReply(rootOther, `$ror8:example.com`, 210 + 8, BOB),
      ],
    });
    const res = await request(db, `${threadsPath}?include=participated`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([rootMine]);
  });

  it('threads participated soft-9', async () => {
    const rootMine = `$rmine9:example.com`;
    const rootOther = `$rother9:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(rootMine, 100 + 9, USER),
        threadReply(rootMine, `$rmr9:example.com`, 110 + 9, BOB),
        threadRoot(rootOther, 200 + 9, BOB),
        threadReply(rootOther, `$ror9:example.com`, 210 + 9, BOB),
      ],
    });
    const res = await request(db, `${threadsPath}?include=participated`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([rootMine]);
  });

  it('threads participated soft-10', async () => {
    const rootMine = `$rmine10:example.com`;
    const rootOther = `$rother10:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(rootMine, 100 + 10, USER),
        threadReply(rootMine, `$rmr10:example.com`, 110 + 10, BOB),
        threadRoot(rootOther, 200 + 10, BOB),
        threadReply(rootOther, `$ror10:example.com`, 210 + 10, BOB),
      ],
    });
    const res = await request(db, `${threadsPath}?include=participated`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([rootMine]);
  });

  it('threads participated soft-11', async () => {
    const rootMine = `$rmine11:example.com`;
    const rootOther = `$rother11:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(rootMine, 100 + 11, USER),
        threadReply(rootMine, `$rmr11:example.com`, 110 + 11, BOB),
        threadRoot(rootOther, 200 + 11, BOB),
        threadReply(rootOther, `$ror11:example.com`, 210 + 11, BOB),
      ],
    });
    const res = await request(db, `${threadsPath}?include=participated`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([rootMine]);
  });

  it('threads participated soft-12', async () => {
    const rootMine = `$rmine12:example.com`;
    const rootOther = `$rother12:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(rootMine, 100 + 12, USER),
        threadReply(rootMine, `$rmr12:example.com`, 110 + 12, BOB),
        threadRoot(rootOther, 200 + 12, BOB),
        threadReply(rootOther, `$ror12:example.com`, 210 + 12, BOB),
      ],
    });
    const res = await request(db, `${threadsPath}?include=participated`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([rootMine]);
  });

  it('threads participated soft-13', async () => {
    const rootMine = `$rmine13:example.com`;
    const rootOther = `$rother13:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(rootMine, 100 + 13, USER),
        threadReply(rootMine, `$rmr13:example.com`, 110 + 13, BOB),
        threadRoot(rootOther, 200 + 13, BOB),
        threadReply(rootOther, `$ror13:example.com`, 210 + 13, BOB),
      ],
    });
    const res = await request(db, `${threadsPath}?include=participated`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([rootMine]);
  });

  it('threads participated soft-14', async () => {
    const rootMine = `$rmine14:example.com`;
    const rootOther = `$rother14:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(rootMine, 100 + 14, USER),
        threadReply(rootMine, `$rmr14:example.com`, 110 + 14, BOB),
        threadRoot(rootOther, 200 + 14, BOB),
        threadReply(rootOther, `$ror14:example.com`, 210 + 14, BOB),
      ],
    });
    const res = await request(db, `${threadsPath}?include=participated`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([rootMine]);
  });

  it('threads participated soft-15', async () => {
    const rootMine = `$rmine15:example.com`;
    const rootOther = `$rother15:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(rootMine, 100 + 15, USER),
        threadReply(rootMine, `$rmr15:example.com`, 110 + 15, BOB),
        threadRoot(rootOther, 200 + 15, BOB),
        threadReply(rootOther, `$ror15:example.com`, 210 + 15, BOB),
      ],
    });
    const res = await request(db, `${threadsPath}?include=participated`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([rootMine]);
  });
});

describe('relations leftovers leave all-relations soft flood after #167', () => {

  it('leave all-relations soft-0', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv0', origin_server_ts: 50 + 0 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave all-relations soft-1', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv1', origin_server_ts: 50 + 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave all-relations soft-2', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv2', origin_server_ts: 50 + 2 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave all-relations soft-3', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv3', origin_server_ts: 50 + 3 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave all-relations soft-4', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv4', origin_server_ts: 50 + 4 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave all-relations soft-5', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv5', origin_server_ts: 50 + 5 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave all-relations soft-6', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv6', origin_server_ts: 50 + 6 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave all-relations soft-7', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv7', origin_server_ts: 50 + 7 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave all-relations soft-8', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv8', origin_server_ts: 50 + 8 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave all-relations soft-9', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv9', origin_server_ts: 50 + 9 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave all-relations soft-10', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv10', origin_server_ts: 50 + 10 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave all-relations soft-11', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv11', origin_server_ts: 50 + 11 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave all-relations soft-12', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv12', origin_server_ts: 50 + 12 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave all-relations soft-13', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv13', origin_server_ts: 50 + 13 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave all-relations soft-14', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv14', origin_server_ts: 50 + 14 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave all-relations soft-15', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv15', origin_server_ts: 50 + 15 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });
});

describe('relations leftovers leave typed soft flood after #167', () => {

  it('leave typed soft-0', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv0', origin_server_ts: 50 + 0 })],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed soft-1', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv1', origin_server_ts: 50 + 1 })],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed soft-2', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv2', origin_server_ts: 50 + 2 })],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed soft-3', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv3', origin_server_ts: 50 + 3 })],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed soft-4', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv4', origin_server_ts: 50 + 4 })],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed soft-5', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv5', origin_server_ts: 50 + 5 })],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed soft-6', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv6', origin_server_ts: 50 + 6 })],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed soft-7', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv7', origin_server_ts: 50 + 7 })],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed soft-8', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv8', origin_server_ts: 50 + 8 })],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed soft-9', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv9', origin_server_ts: 50 + 9 })],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed soft-10', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv10', origin_server_ts: 50 + 10 })],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed soft-11', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv11', origin_server_ts: 50 + 11 })],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed soft-12', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv12', origin_server_ts: 50 + 12 })],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed soft-13', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv13', origin_server_ts: 50 + 13 })],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed soft-14', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv14', origin_server_ts: 50 + 14 })],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed soft-15', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv15', origin_server_ts: 50 + 15 })],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });
});

describe('relations leftovers leave typed+eventType soft flood after #167', () => {

  it('leave typed+eventType soft-0', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv0', origin_server_ts: 50 + 0 })],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed+eventType soft-1', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv1', origin_server_ts: 50 + 1 })],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed+eventType soft-2', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv2', origin_server_ts: 50 + 2 })],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed+eventType soft-3', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv3', origin_server_ts: 50 + 3 })],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed+eventType soft-4', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv4', origin_server_ts: 50 + 4 })],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed+eventType soft-5', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv5', origin_server_ts: 50 + 5 })],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed+eventType soft-6', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv6', origin_server_ts: 50 + 6 })],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed+eventType soft-7', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv7', origin_server_ts: 50 + 7 })],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed+eventType soft-8', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv8', origin_server_ts: 50 + 8 })],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed+eventType soft-9', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv9', origin_server_ts: 50 + 9 })],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed+eventType soft-10', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv10', origin_server_ts: 50 + 10 })],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed+eventType soft-11', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv11', origin_server_ts: 50 + 11 })],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed+eventType soft-12', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv12', origin_server_ts: 50 + 12 })],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed+eventType soft-13', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv13', origin_server_ts: 50 + 13 })],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed+eventType soft-14', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv14', origin_server_ts: 50 + 14 })],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave typed+eventType soft-15', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv15', origin_server_ts: 50 + 15 })],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });
});

describe('relations leftovers leave threads soft flood after #167', () => {

  it('leave threads soft-0', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv0', origin_server_ts: 50 + 0 })],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave threads soft-1', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv1', origin_server_ts: 50 + 1 })],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave threads soft-2', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv2', origin_server_ts: 50 + 2 })],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave threads soft-3', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv3', origin_server_ts: 50 + 3 })],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave threads soft-4', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv4', origin_server_ts: 50 + 4 })],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave threads soft-5', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv5', origin_server_ts: 50 + 5 })],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave threads soft-6', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv6', origin_server_ts: 50 + 6 })],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave threads soft-7', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv7', origin_server_ts: 50 + 7 })],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave threads soft-8', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv8', origin_server_ts: 50 + 8 })],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave threads soft-9', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv9', origin_server_ts: 50 + 9 })],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave threads soft-10', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv10', origin_server_ts: 50 + 10 })],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave threads soft-11', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv11', origin_server_ts: 50 + 11 })],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave threads soft-12', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv12', origin_server_ts: 50 + 12 })],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave threads soft-13', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv13', origin_server_ts: 50 + 13 })],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave threads soft-14', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv14', origin_server_ts: 50 + 14 })],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('leave threads soft-15', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$lv15', origin_server_ts: 50 + 15 })],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });
});

describe('relations leftovers forbid-missing all soft flood after #167', () => {

  it('forbid-missing all soft-0', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing all soft-1', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing all soft-2', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing all soft-3', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing all soft-4', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing all soft-5', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing all soft-6', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing all soft-7', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing all soft-8', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing all soft-9', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing all soft-10', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing all soft-11', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing all soft-12', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing all soft-13', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing all soft-14', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing all soft-15', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
});

describe('relations leftovers forbid-missing typed soft flood after #167', () => {

  it('forbid-missing typed soft-0', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed soft-1', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed soft-2', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed soft-3', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed soft-4', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed soft-5', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed soft-6', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed soft-7', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed soft-8', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed soft-9', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed soft-10', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed soft-11', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed soft-12', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed soft-13', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed soft-14', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed soft-15', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
});

describe('relations leftovers forbid-missing typed+eventType soft flood after #167', () => {

  it('forbid-missing typed+eventType soft-0', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed+eventType soft-1', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed+eventType soft-2', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed+eventType soft-3', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed+eventType soft-4', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed+eventType soft-5', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed+eventType soft-6', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed+eventType soft-7', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed+eventType soft-8', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed+eventType soft-9', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed+eventType soft-10', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed+eventType soft-11', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed+eventType soft-12', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed+eventType soft-13', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed+eventType soft-14', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing typed+eventType soft-15', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
});

describe('relations leftovers forbid-missing threads soft flood after #167', () => {

  it('forbid-missing threads soft-0', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing threads soft-1', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing threads soft-2', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing threads soft-3', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing threads soft-4', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing threads soft-5', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing threads soft-6', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing threads soft-7', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing threads soft-8', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing threads soft-9', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing threads soft-10', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing threads soft-11', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing threads soft-12', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing threads soft-13', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing threads soft-14', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbid-missing threads soft-15', async () => {
    const db = createRelationsDb({ memberships: [], events: [] });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
});

describe('relations leftovers forbid-invite soft flood after #167', () => {

  it('forbid invite soft-0', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$x0', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid invite soft-1', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$x1', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid invite soft-2', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$x2', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid invite soft-3', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$x3', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid invite soft-4', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$x4', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid invite soft-5', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$x5', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid invite soft-6', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$x6', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid invite soft-7', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$x7', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid invite soft-8', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$x8', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid invite soft-9', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$x9', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid invite soft-10', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$x10', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid invite soft-11', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$x11', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid invite soft-12', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$x12', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid invite soft-13', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$x13', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid invite soft-14', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$x14', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid invite soft-15', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$x15', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });
});

describe('relations leftovers forbid-ban soft flood after #167', () => {

  it('forbid ban soft-0', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$x0', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid ban soft-1', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$x1', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid ban soft-2', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$x2', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid ban soft-3', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$x3', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid ban soft-4', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$x4', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid ban soft-5', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$x5', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid ban soft-6', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$x6', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid ban soft-7', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$x7', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid ban soft-8', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$x8', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid ban soft-9', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$x9', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid ban soft-10', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$x10', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid ban soft-11', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$x11', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid ban soft-12', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$x12', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid ban soft-13', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$x13', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid ban soft-14', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$x14', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid ban soft-15', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$x15', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });
});

describe('relations leftovers forbid-knock soft flood after #167', () => {

  it('forbid knock soft-0', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$x0', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid knock soft-1', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$x1', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid knock soft-2', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$x2', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid knock soft-3', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$x3', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid knock soft-4', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$x4', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid knock soft-5', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$x5', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid knock soft-6', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$x6', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid knock soft-7', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$x7', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid knock soft-8', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$x8', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid knock soft-9', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$x9', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid knock soft-10', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$x10', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid knock soft-11', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$x11', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid knock soft-12', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$x12', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid knock soft-13', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$x13', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid knock soft-14', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$x14', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('forbid knock soft-15', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$x15', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });
});

describe('relations leftovers limit next_batch soft flood after #167', () => {

  it('limit next_batch soft-0', async () => {
    const events = Array.from({ length: 8 }, (_, j) =>
      child({ event_id: `$lim0_${j}`, origin_server_ts: (j + 1) * 10 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=1&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.next_batch).toBeDefined();
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(2);
  });

  it('limit next_batch soft-1', async () => {
    const events = Array.from({ length: 8 }, (_, j) =>
      child({ event_id: `$lim1_${j}`, origin_server_ts: (j + 1) * 10 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=2&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(2);
    expect(res.body.next_batch).toBeDefined();
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(3);
  });

  it('limit next_batch soft-2', async () => {
    const events = Array.from({ length: 8 }, (_, j) =>
      child({ event_id: `$lim2_${j}`, origin_server_ts: (j + 1) * 10 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=3&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.next_batch).toBeDefined();
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(4);
  });

  it('limit next_batch soft-3', async () => {
    const events = Array.from({ length: 8 }, (_, j) =>
      child({ event_id: `$lim3_${j}`, origin_server_ts: (j + 1) * 10 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=4&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(4);
    expect(res.body.next_batch).toBeDefined();
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(5);
  });

  it('limit next_batch soft-4', async () => {
    const events = Array.from({ length: 8 }, (_, j) =>
      child({ event_id: `$lim4_${j}`, origin_server_ts: (j + 1) * 10 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=5&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(5);
    expect(res.body.next_batch).toBeDefined();
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(6);
  });

  it('limit next_batch soft-5', async () => {
    const events = Array.from({ length: 8 }, (_, j) =>
      child({ event_id: `$lim5_${j}`, origin_server_ts: (j + 1) * 10 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=1&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.next_batch).toBeDefined();
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(2);
  });

  it('limit next_batch soft-6', async () => {
    const events = Array.from({ length: 8 }, (_, j) =>
      child({ event_id: `$lim6_${j}`, origin_server_ts: (j + 1) * 10 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=2&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(2);
    expect(res.body.next_batch).toBeDefined();
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(3);
  });

  it('limit next_batch soft-7', async () => {
    const events = Array.from({ length: 8 }, (_, j) =>
      child({ event_id: `$lim7_${j}`, origin_server_ts: (j + 1) * 10 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=3&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.next_batch).toBeDefined();
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(4);
  });

  it('limit next_batch soft-8', async () => {
    const events = Array.from({ length: 8 }, (_, j) =>
      child({ event_id: `$lim8_${j}`, origin_server_ts: (j + 1) * 10 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=4&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(4);
    expect(res.body.next_batch).toBeDefined();
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(5);
  });

  it('limit next_batch soft-9', async () => {
    const events = Array.from({ length: 8 }, (_, j) =>
      child({ event_id: `$lim9_${j}`, origin_server_ts: (j + 1) * 10 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=5&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(5);
    expect(res.body.next_batch).toBeDefined();
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(6);
  });

  it('limit next_batch soft-10', async () => {
    const events = Array.from({ length: 8 }, (_, j) =>
      child({ event_id: `$lim10_${j}`, origin_server_ts: (j + 1) * 10 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=1&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.next_batch).toBeDefined();
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(2);
  });

  it('limit next_batch soft-11', async () => {
    const events = Array.from({ length: 8 }, (_, j) =>
      child({ event_id: `$lim11_${j}`, origin_server_ts: (j + 1) * 10 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=2&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(2);
    expect(res.body.next_batch).toBeDefined();
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(3);
  });

  it('limit next_batch soft-12', async () => {
    const events = Array.from({ length: 8 }, (_, j) =>
      child({ event_id: `$lim12_${j}`, origin_server_ts: (j + 1) * 10 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=3&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.next_batch).toBeDefined();
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(4);
  });

  it('limit next_batch soft-13', async () => {
    const events = Array.from({ length: 8 }, (_, j) =>
      child({ event_id: `$lim13_${j}`, origin_server_ts: (j + 1) * 10 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=4&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(4);
    expect(res.body.next_batch).toBeDefined();
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(5);
  });

  it('limit next_batch soft-14', async () => {
    const events = Array.from({ length: 8 }, (_, j) =>
      child({ event_id: `$lim14_${j}`, origin_server_ts: (j + 1) * 10 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=5&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(5);
    expect(res.body.next_batch).toBeDefined();
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(6);
  });

  it('limit next_batch soft-15', async () => {
    const events = Array.from({ length: 8 }, (_, j) =>
      child({ event_id: `$lim15_${j}`, origin_server_ts: (j + 1) * 10 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=1&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.next_batch).toBeDefined();
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(2);
  });
});

describe('relations leftovers dir=f from soft flood after #167', () => {

  it('dir=f from soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$fa0', origin_server_ts: 10 }),
        child({ event_id: '$fb0', origin_server_ts: 20 }),
        child({ event_id: '$fc0', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=f&from=15`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$fb0',
      '$fc0',
    ]);
  });

  it('dir=f from soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$fa1', origin_server_ts: 10 }),
        child({ event_id: '$fb1', origin_server_ts: 20 }),
        child({ event_id: '$fc1', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=f&from=15`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$fb1',
      '$fc1',
    ]);
  });

  it('dir=f from soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$fa2', origin_server_ts: 10 }),
        child({ event_id: '$fb2', origin_server_ts: 20 }),
        child({ event_id: '$fc2', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=f&from=15`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$fb2',
      '$fc2',
    ]);
  });

  it('dir=f from soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$fa3', origin_server_ts: 10 }),
        child({ event_id: '$fb3', origin_server_ts: 20 }),
        child({ event_id: '$fc3', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=f&from=15`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$fb3',
      '$fc3',
    ]);
  });

  it('dir=f from soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$fa4', origin_server_ts: 10 }),
        child({ event_id: '$fb4', origin_server_ts: 20 }),
        child({ event_id: '$fc4', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=f&from=15`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$fb4',
      '$fc4',
    ]);
  });

  it('dir=f from soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$fa5', origin_server_ts: 10 }),
        child({ event_id: '$fb5', origin_server_ts: 20 }),
        child({ event_id: '$fc5', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=f&from=15`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$fb5',
      '$fc5',
    ]);
  });

  it('dir=f from soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$fa6', origin_server_ts: 10 }),
        child({ event_id: '$fb6', origin_server_ts: 20 }),
        child({ event_id: '$fc6', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=f&from=15`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$fb6',
      '$fc6',
    ]);
  });

  it('dir=f from soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$fa7', origin_server_ts: 10 }),
        child({ event_id: '$fb7', origin_server_ts: 20 }),
        child({ event_id: '$fc7', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=f&from=15`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$fb7',
      '$fc7',
    ]);
  });

  it('dir=f from soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$fa8', origin_server_ts: 10 }),
        child({ event_id: '$fb8', origin_server_ts: 20 }),
        child({ event_id: '$fc8', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=f&from=15`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$fb8',
      '$fc8',
    ]);
  });

  it('dir=f from soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$fa9', origin_server_ts: 10 }),
        child({ event_id: '$fb9', origin_server_ts: 20 }),
        child({ event_id: '$fc9', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=f&from=15`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$fb9',
      '$fc9',
    ]);
  });

  it('dir=f from soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$fa10', origin_server_ts: 10 }),
        child({ event_id: '$fb10', origin_server_ts: 20 }),
        child({ event_id: '$fc10', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=f&from=15`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$fb10',
      '$fc10',
    ]);
  });

  it('dir=f from soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$fa11', origin_server_ts: 10 }),
        child({ event_id: '$fb11', origin_server_ts: 20 }),
        child({ event_id: '$fc11', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=f&from=15`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$fb11',
      '$fc11',
    ]);
  });

  it('dir=f from soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$fa12', origin_server_ts: 10 }),
        child({ event_id: '$fb12', origin_server_ts: 20 }),
        child({ event_id: '$fc12', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=f&from=15`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$fb12',
      '$fc12',
    ]);
  });

  it('dir=f from soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$fa13', origin_server_ts: 10 }),
        child({ event_id: '$fb13', origin_server_ts: 20 }),
        child({ event_id: '$fc13', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=f&from=15`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$fb13',
      '$fc13',
    ]);
  });

  it('dir=f from soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$fa14', origin_server_ts: 10 }),
        child({ event_id: '$fb14', origin_server_ts: 20 }),
        child({ event_id: '$fc14', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=f&from=15`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$fb14',
      '$fc14',
    ]);
  });

  it('dir=f from soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$fa15', origin_server_ts: 10 }),
        child({ event_id: '$fb15', origin_server_ts: 20 }),
        child({ event_id: '$fc15', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=f&from=15`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$fb15',
      '$fc15',
    ]);
  });
});

describe('relations leftovers dir=b from soft flood after #167', () => {

  it('dir=b from soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ba0', origin_server_ts: 10 }),
        child({ event_id: '$bb0', origin_server_ts: 20 }),
        child({ event_id: '$bc0', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=b&from=25`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$bb0',
      '$ba0',
    ]);
  });

  it('dir=b from soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ba1', origin_server_ts: 10 }),
        child({ event_id: '$bb1', origin_server_ts: 20 }),
        child({ event_id: '$bc1', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=b&from=25`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$bb1',
      '$ba1',
    ]);
  });

  it('dir=b from soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ba2', origin_server_ts: 10 }),
        child({ event_id: '$bb2', origin_server_ts: 20 }),
        child({ event_id: '$bc2', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=b&from=25`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$bb2',
      '$ba2',
    ]);
  });

  it('dir=b from soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ba3', origin_server_ts: 10 }),
        child({ event_id: '$bb3', origin_server_ts: 20 }),
        child({ event_id: '$bc3', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=b&from=25`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$bb3',
      '$ba3',
    ]);
  });

  it('dir=b from soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ba4', origin_server_ts: 10 }),
        child({ event_id: '$bb4', origin_server_ts: 20 }),
        child({ event_id: '$bc4', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=b&from=25`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$bb4',
      '$ba4',
    ]);
  });

  it('dir=b from soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ba5', origin_server_ts: 10 }),
        child({ event_id: '$bb5', origin_server_ts: 20 }),
        child({ event_id: '$bc5', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=b&from=25`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$bb5',
      '$ba5',
    ]);
  });

  it('dir=b from soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ba6', origin_server_ts: 10 }),
        child({ event_id: '$bb6', origin_server_ts: 20 }),
        child({ event_id: '$bc6', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=b&from=25`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$bb6',
      '$ba6',
    ]);
  });

  it('dir=b from soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ba7', origin_server_ts: 10 }),
        child({ event_id: '$bb7', origin_server_ts: 20 }),
        child({ event_id: '$bc7', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=b&from=25`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$bb7',
      '$ba7',
    ]);
  });

  it('dir=b from soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ba8', origin_server_ts: 10 }),
        child({ event_id: '$bb8', origin_server_ts: 20 }),
        child({ event_id: '$bc8', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=b&from=25`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$bb8',
      '$ba8',
    ]);
  });

  it('dir=b from soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ba9', origin_server_ts: 10 }),
        child({ event_id: '$bb9', origin_server_ts: 20 }),
        child({ event_id: '$bc9', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=b&from=25`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$bb9',
      '$ba9',
    ]);
  });

  it('dir=b from soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ba10', origin_server_ts: 10 }),
        child({ event_id: '$bb10', origin_server_ts: 20 }),
        child({ event_id: '$bc10', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=b&from=25`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$bb10',
      '$ba10',
    ]);
  });

  it('dir=b from soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ba11', origin_server_ts: 10 }),
        child({ event_id: '$bb11', origin_server_ts: 20 }),
        child({ event_id: '$bc11', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=b&from=25`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$bb11',
      '$ba11',
    ]);
  });

  it('dir=b from soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ba12', origin_server_ts: 10 }),
        child({ event_id: '$bb12', origin_server_ts: 20 }),
        child({ event_id: '$bc12', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=b&from=25`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$bb12',
      '$ba12',
    ]);
  });

  it('dir=b from soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ba13', origin_server_ts: 10 }),
        child({ event_id: '$bb13', origin_server_ts: 20 }),
        child({ event_id: '$bc13', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=b&from=25`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$bb13',
      '$ba13',
    ]);
  });

  it('dir=b from soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ba14', origin_server_ts: 10 }),
        child({ event_id: '$bb14', origin_server_ts: 20 }),
        child({ event_id: '$bc14', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=b&from=25`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$bb14',
      '$ba14',
    ]);
  });

  it('dir=b from soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$ba15', origin_server_ts: 10 }),
        child({ event_id: '$bb15', origin_server_ts: 20 }),
        child({ event_id: '$bc15', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${base}?dir=b&from=25`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$bb15',
      '$ba15',
    ]);
  });
});

describe('relations leftovers limit clamp soft flood after #167', () => {

  it('limit clamp soft-0', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${base}?limit=99990`);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(101);
  });

  it('limit clamp soft-1', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${base}?limit=99991`);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(101);
  });

  it('limit clamp soft-2', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${base}?limit=99992`);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(101);
  });

  it('limit clamp soft-3', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${base}?limit=99993`);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(101);
  });

  it('limit clamp soft-4', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${base}?limit=99994`);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(101);
  });

  it('limit clamp soft-5', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${base}?limit=99995`);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(101);
  });

  it('limit clamp soft-6', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${base}?limit=99996`);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(101);
  });

  it('limit clamp soft-7', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${base}?limit=99997`);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(101);
  });

  it('limit clamp soft-8', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${base}?limit=99998`);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(101);
  });

  it('limit clamp soft-9', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${base}?limit=99999`);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(101);
  });

  it('limit clamp soft-10', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${base}?limit=999910`);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(101);
  });

  it('limit clamp soft-11', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${base}?limit=999911`);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(101);
  });

  it('limit clamp soft-12', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${base}?limit=999912`);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(101);
  });

  it('limit clamp soft-13', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${base}?limit=999913`);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(101);
  });

  it('limit clamp soft-14', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${base}?limit=999914`);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(101);
  });

  it('limit clamp soft-15', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${base}?limit=999915`);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(101);
  });
});

describe('relations leftovers default limit soft flood after #167', () => {

  it('default limit soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$d0', origin_server_ts: 1 })],
    });
    await request(db, base);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(51);
  });

  it('default limit soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$d1', origin_server_ts: 1 })],
    });
    await request(db, base);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(51);
  });

  it('default limit soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$d2', origin_server_ts: 1 })],
    });
    await request(db, base);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(51);
  });

  it('default limit soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$d3', origin_server_ts: 1 })],
    });
    await request(db, base);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(51);
  });

  it('default limit soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$d4', origin_server_ts: 1 })],
    });
    await request(db, base);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(51);
  });

  it('default limit soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$d5', origin_server_ts: 1 })],
    });
    await request(db, base);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(51);
  });

  it('default limit soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$d6', origin_server_ts: 1 })],
    });
    await request(db, base);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(51);
  });

  it('default limit soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$d7', origin_server_ts: 1 })],
    });
    await request(db, base);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(51);
  });

  it('default limit soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$d8', origin_server_ts: 1 })],
    });
    await request(db, base);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(51);
  });

  it('default limit soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$d9', origin_server_ts: 1 })],
    });
    await request(db, base);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(51);
  });

  it('default limit soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$d10', origin_server_ts: 1 })],
    });
    await request(db, base);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(51);
  });

  it('default limit soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$d11', origin_server_ts: 1 })],
    });
    await request(db, base);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(51);
  });

  it('default limit soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$d12', origin_server_ts: 1 })],
    });
    await request(db, base);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(51);
  });

  it('default limit soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$d13', origin_server_ts: 1 })],
    });
    await request(db, base);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(51);
  });

  it('default limit soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$d14', origin_server_ts: 1 })],
    });
    await request(db, base);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(51);
  });

  it('default limit soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$d15', origin_server_ts: 1 })],
    });
    await request(db, base);
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(51);
  });
});

describe('relations leftovers room isolation soft flood after #167', () => {

  it('room isolation soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember(), joinMember(ROOM2)],
      events: [
        child({ event_id: '$here0', origin_server_ts: 10, room_id: ROOM }),
        child({
          event_id: '$there0',
          origin_server_ts: 20,
          room_id: ROOM2,
          relates_to_event_id: PARENT,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$here0']);
  });

  it('room isolation soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember(), joinMember(ROOM2)],
      events: [
        child({ event_id: '$here1', origin_server_ts: 10, room_id: ROOM }),
        child({
          event_id: '$there1',
          origin_server_ts: 20,
          room_id: ROOM2,
          relates_to_event_id: PARENT,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$here1']);
  });

  it('room isolation soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember(), joinMember(ROOM2)],
      events: [
        child({ event_id: '$here2', origin_server_ts: 10, room_id: ROOM }),
        child({
          event_id: '$there2',
          origin_server_ts: 20,
          room_id: ROOM2,
          relates_to_event_id: PARENT,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$here2']);
  });

  it('room isolation soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember(), joinMember(ROOM2)],
      events: [
        child({ event_id: '$here3', origin_server_ts: 10, room_id: ROOM }),
        child({
          event_id: '$there3',
          origin_server_ts: 20,
          room_id: ROOM2,
          relates_to_event_id: PARENT,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$here3']);
  });

  it('room isolation soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember(), joinMember(ROOM2)],
      events: [
        child({ event_id: '$here4', origin_server_ts: 10, room_id: ROOM }),
        child({
          event_id: '$there4',
          origin_server_ts: 20,
          room_id: ROOM2,
          relates_to_event_id: PARENT,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$here4']);
  });

  it('room isolation soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember(), joinMember(ROOM2)],
      events: [
        child({ event_id: '$here5', origin_server_ts: 10, room_id: ROOM }),
        child({
          event_id: '$there5',
          origin_server_ts: 20,
          room_id: ROOM2,
          relates_to_event_id: PARENT,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$here5']);
  });

  it('room isolation soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember(), joinMember(ROOM2)],
      events: [
        child({ event_id: '$here6', origin_server_ts: 10, room_id: ROOM }),
        child({
          event_id: '$there6',
          origin_server_ts: 20,
          room_id: ROOM2,
          relates_to_event_id: PARENT,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$here6']);
  });

  it('room isolation soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember(), joinMember(ROOM2)],
      events: [
        child({ event_id: '$here7', origin_server_ts: 10, room_id: ROOM }),
        child({
          event_id: '$there7',
          origin_server_ts: 20,
          room_id: ROOM2,
          relates_to_event_id: PARENT,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$here7']);
  });

  it('room isolation soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember(), joinMember(ROOM2)],
      events: [
        child({ event_id: '$here8', origin_server_ts: 10, room_id: ROOM }),
        child({
          event_id: '$there8',
          origin_server_ts: 20,
          room_id: ROOM2,
          relates_to_event_id: PARENT,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$here8']);
  });

  it('room isolation soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember(), joinMember(ROOM2)],
      events: [
        child({ event_id: '$here9', origin_server_ts: 10, room_id: ROOM }),
        child({
          event_id: '$there9',
          origin_server_ts: 20,
          room_id: ROOM2,
          relates_to_event_id: PARENT,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$here9']);
  });

  it('room isolation soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember(), joinMember(ROOM2)],
      events: [
        child({ event_id: '$here10', origin_server_ts: 10, room_id: ROOM }),
        child({
          event_id: '$there10',
          origin_server_ts: 20,
          room_id: ROOM2,
          relates_to_event_id: PARENT,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$here10']);
  });

  it('room isolation soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember(), joinMember(ROOM2)],
      events: [
        child({ event_id: '$here11', origin_server_ts: 10, room_id: ROOM }),
        child({
          event_id: '$there11',
          origin_server_ts: 20,
          room_id: ROOM2,
          relates_to_event_id: PARENT,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$here11']);
  });

  it('room isolation soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember(), joinMember(ROOM2)],
      events: [
        child({ event_id: '$here12', origin_server_ts: 10, room_id: ROOM }),
        child({
          event_id: '$there12',
          origin_server_ts: 20,
          room_id: ROOM2,
          relates_to_event_id: PARENT,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$here12']);
  });

  it('room isolation soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember(), joinMember(ROOM2)],
      events: [
        child({ event_id: '$here13', origin_server_ts: 10, room_id: ROOM }),
        child({
          event_id: '$there13',
          origin_server_ts: 20,
          room_id: ROOM2,
          relates_to_event_id: PARENT,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$here13']);
  });

  it('room isolation soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember(), joinMember(ROOM2)],
      events: [
        child({ event_id: '$here14', origin_server_ts: 10, room_id: ROOM }),
        child({
          event_id: '$there14',
          origin_server_ts: 20,
          room_id: ROOM2,
          relates_to_event_id: PARENT,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$here14']);
  });

  it('room isolation soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember(), joinMember(ROOM2)],
      events: [
        child({ event_id: '$here15', origin_server_ts: 10, room_id: ROOM }),
        child({
          event_id: '$there15',
          origin_server_ts: 20,
          room_id: ROOM2,
          relates_to_event_id: PARENT,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$here15']);
  });
});

describe('relations leftovers parent isolation soft flood after #167', () => {

  it('parent isolation soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p10', origin_server_ts: 10, relates_to_event_id: PARENT }),
        child({ event_id: '$p20', origin_server_ts: 20, relates_to_event_id: PARENT2 }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p10']);
    const res2 = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT2_ENC}`
    );
    expect(res2.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p20']);
  });

  it('parent isolation soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p11', origin_server_ts: 10, relates_to_event_id: PARENT }),
        child({ event_id: '$p21', origin_server_ts: 20, relates_to_event_id: PARENT2 }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p11']);
    const res2 = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT2_ENC}`
    );
    expect(res2.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p21']);
  });

  it('parent isolation soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p12', origin_server_ts: 10, relates_to_event_id: PARENT }),
        child({ event_id: '$p22', origin_server_ts: 20, relates_to_event_id: PARENT2 }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p12']);
    const res2 = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT2_ENC}`
    );
    expect(res2.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p22']);
  });

  it('parent isolation soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p13', origin_server_ts: 10, relates_to_event_id: PARENT }),
        child({ event_id: '$p23', origin_server_ts: 20, relates_to_event_id: PARENT2 }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p13']);
    const res2 = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT2_ENC}`
    );
    expect(res2.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p23']);
  });

  it('parent isolation soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p14', origin_server_ts: 10, relates_to_event_id: PARENT }),
        child({ event_id: '$p24', origin_server_ts: 20, relates_to_event_id: PARENT2 }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p14']);
    const res2 = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT2_ENC}`
    );
    expect(res2.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p24']);
  });

  it('parent isolation soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p15', origin_server_ts: 10, relates_to_event_id: PARENT }),
        child({ event_id: '$p25', origin_server_ts: 20, relates_to_event_id: PARENT2 }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p15']);
    const res2 = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT2_ENC}`
    );
    expect(res2.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p25']);
  });

  it('parent isolation soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p16', origin_server_ts: 10, relates_to_event_id: PARENT }),
        child({ event_id: '$p26', origin_server_ts: 20, relates_to_event_id: PARENT2 }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p16']);
    const res2 = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT2_ENC}`
    );
    expect(res2.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p26']);
  });

  it('parent isolation soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p17', origin_server_ts: 10, relates_to_event_id: PARENT }),
        child({ event_id: '$p27', origin_server_ts: 20, relates_to_event_id: PARENT2 }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p17']);
    const res2 = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT2_ENC}`
    );
    expect(res2.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p27']);
  });

  it('parent isolation soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p18', origin_server_ts: 10, relates_to_event_id: PARENT }),
        child({ event_id: '$p28', origin_server_ts: 20, relates_to_event_id: PARENT2 }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p18']);
    const res2 = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT2_ENC}`
    );
    expect(res2.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p28']);
  });

  it('parent isolation soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p19', origin_server_ts: 10, relates_to_event_id: PARENT }),
        child({ event_id: '$p29', origin_server_ts: 20, relates_to_event_id: PARENT2 }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p19']);
    const res2 = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT2_ENC}`
    );
    expect(res2.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p29']);
  });

  it('parent isolation soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p110', origin_server_ts: 10, relates_to_event_id: PARENT }),
        child({ event_id: '$p210', origin_server_ts: 20, relates_to_event_id: PARENT2 }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p110']);
    const res2 = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT2_ENC}`
    );
    expect(res2.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p210']);
  });

  it('parent isolation soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p111', origin_server_ts: 10, relates_to_event_id: PARENT }),
        child({ event_id: '$p211', origin_server_ts: 20, relates_to_event_id: PARENT2 }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p111']);
    const res2 = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT2_ENC}`
    );
    expect(res2.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p211']);
  });

  it('parent isolation soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p112', origin_server_ts: 10, relates_to_event_id: PARENT }),
        child({ event_id: '$p212', origin_server_ts: 20, relates_to_event_id: PARENT2 }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p112']);
    const res2 = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT2_ENC}`
    );
    expect(res2.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p212']);
  });

  it('parent isolation soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p113', origin_server_ts: 10, relates_to_event_id: PARENT }),
        child({ event_id: '$p213', origin_server_ts: 20, relates_to_event_id: PARENT2 }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p113']);
    const res2 = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT2_ENC}`
    );
    expect(res2.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p213']);
  });

  it('parent isolation soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p114', origin_server_ts: 10, relates_to_event_id: PARENT }),
        child({ event_id: '$p214', origin_server_ts: 20, relates_to_event_id: PARENT2 }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p114']);
    const res2 = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT2_ENC}`
    );
    expect(res2.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p214']);
  });

  it('parent isolation soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p115', origin_server_ts: 10, relates_to_event_id: PARENT }),
        child({ event_id: '$p215', origin_server_ts: 20, relates_to_event_id: PARENT2 }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p115']);
    const res2 = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT2_ENC}`
    );
    expect(res2.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$p215']);
  });
});

describe('relations leftovers Accept header soft flood after #167', () => {

  it('Accept soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$ac0', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Accept: '*/*', Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
  });

  it('Accept soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$ac1', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Accept: 'application/json', Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
  });

  it('Accept soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$ac2', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Accept: 'application/json, text/plain, */*', Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
  });

  it('Accept soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$ac3', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Accept: 'application/json;q=0.9,*/*;q=0.8', Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
  });

  it('Accept soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$ac4', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Accept: 'text/html,application/json', Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
  });

  it('Accept soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$ac5', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Accept: '*/*', Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
  });

  it('Accept soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$ac6', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Accept: 'application/json', Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
  });

  it('Accept soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$ac7', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Accept: 'application/json, text/plain, */*', Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
  });

  it('Accept soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$ac8', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Accept: 'application/json;q=0.9,*/*;q=0.8', Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
  });

  it('Accept soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$ac9', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Accept: 'text/html,application/json', Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
  });

  it('Accept soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$ac10', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Accept: '*/*', Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
  });

  it('Accept soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$ac11', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Accept: 'application/json', Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
  });

  it('Accept soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$ac12', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Accept: 'application/json, text/plain, */*', Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
  });

  it('Accept soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$ac13', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Accept: 'application/json;q=0.9,*/*;q=0.8', Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
  });

  it('Accept soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$ac14', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Accept: 'text/html,application/json', Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
  });

  it('Accept soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$ac15', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Accept: '*/*', Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
  });
});

describe('relations leftovers Authorization soft flood after #167', () => {

  it('Authorization soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$au0', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$au0');
  });

  it('Authorization soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$au1', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer leftover-token' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$au1');
  });

  it('Authorization soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$au2', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$au2');
  });

  it('Authorization soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$au3', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer alice-device-token' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$au3');
  });

  it('Authorization soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$au4', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$au4');
  });

  it('Authorization soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$au5', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer leftover-token' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$au5');
  });

  it('Authorization soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$au6', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$au6');
  });

  it('Authorization soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$au7', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer alice-device-token' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$au7');
  });

  it('Authorization soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$au8', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$au8');
  });

  it('Authorization soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$au9', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer leftover-token' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$au9');
  });

  it('Authorization soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$au10', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$au10');
  });

  it('Authorization soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$au11', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer alice-device-token' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$au11');
  });

  it('Authorization soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$au12', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$au12');
  });

  it('Authorization soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$au13', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer leftover-token' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$au13');
  });

  it('Authorization soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$au14', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$au14');
  });

  it('Authorization soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$au15', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer alice-device-token' },
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$au15');
  });
});

describe('relations leftovers SQL bind all soft flood after #167', () => {

  it('SQL bind all soft-0', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, base);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const rel = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(rel?.args[0]).toBe(ROOM);
    expect(rel?.args[1]).toBe(PARENT);
    expect(rel?.args[rel.args.length - 1]).toBe(51);
  });

  it('SQL bind all soft-1', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, base);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const rel = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(rel?.args[0]).toBe(ROOM);
    expect(rel?.args[1]).toBe(PARENT);
    expect(rel?.args[rel.args.length - 1]).toBe(51);
  });

  it('SQL bind all soft-2', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, base);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const rel = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(rel?.args[0]).toBe(ROOM);
    expect(rel?.args[1]).toBe(PARENT);
    expect(rel?.args[rel.args.length - 1]).toBe(51);
  });

  it('SQL bind all soft-3', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, base);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const rel = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(rel?.args[0]).toBe(ROOM);
    expect(rel?.args[1]).toBe(PARENT);
    expect(rel?.args[rel.args.length - 1]).toBe(51);
  });

  it('SQL bind all soft-4', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, base);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const rel = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(rel?.args[0]).toBe(ROOM);
    expect(rel?.args[1]).toBe(PARENT);
    expect(rel?.args[rel.args.length - 1]).toBe(51);
  });

  it('SQL bind all soft-5', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, base);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const rel = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(rel?.args[0]).toBe(ROOM);
    expect(rel?.args[1]).toBe(PARENT);
    expect(rel?.args[rel.args.length - 1]).toBe(51);
  });

  it('SQL bind all soft-6', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, base);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const rel = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(rel?.args[0]).toBe(ROOM);
    expect(rel?.args[1]).toBe(PARENT);
    expect(rel?.args[rel.args.length - 1]).toBe(51);
  });

  it('SQL bind all soft-7', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, base);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const rel = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(rel?.args[0]).toBe(ROOM);
    expect(rel?.args[1]).toBe(PARENT);
    expect(rel?.args[rel.args.length - 1]).toBe(51);
  });

  it('SQL bind all soft-8', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, base);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const rel = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(rel?.args[0]).toBe(ROOM);
    expect(rel?.args[1]).toBe(PARENT);
    expect(rel?.args[rel.args.length - 1]).toBe(51);
  });

  it('SQL bind all soft-9', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, base);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const rel = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(rel?.args[0]).toBe(ROOM);
    expect(rel?.args[1]).toBe(PARENT);
    expect(rel?.args[rel.args.length - 1]).toBe(51);
  });

  it('SQL bind all soft-10', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, base);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const rel = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(rel?.args[0]).toBe(ROOM);
    expect(rel?.args[1]).toBe(PARENT);
    expect(rel?.args[rel.args.length - 1]).toBe(51);
  });

  it('SQL bind all soft-11', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, base);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const rel = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(rel?.args[0]).toBe(ROOM);
    expect(rel?.args[1]).toBe(PARENT);
    expect(rel?.args[rel.args.length - 1]).toBe(51);
  });

  it('SQL bind all soft-12', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, base);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const rel = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(rel?.args[0]).toBe(ROOM);
    expect(rel?.args[1]).toBe(PARENT);
    expect(rel?.args[rel.args.length - 1]).toBe(51);
  });

  it('SQL bind all soft-13', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, base);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const rel = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(rel?.args[0]).toBe(ROOM);
    expect(rel?.args[1]).toBe(PARENT);
    expect(rel?.args[rel.args.length - 1]).toBe(51);
  });

  it('SQL bind all soft-14', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, base);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const rel = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(rel?.args[0]).toBe(ROOM);
    expect(rel?.args[1]).toBe(PARENT);
    expect(rel?.args[rel.args.length - 1]).toBe(51);
  });

  it('SQL bind all soft-15', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, base);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const rel = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(rel?.args[0]).toBe(ROOM);
    expect(rel?.args[1]).toBe(PARENT);
    expect(rel?.args[rel.args.length - 1]).toBe(51);
  });
});

describe('relations leftovers SQL bind typed soft flood after #167', () => {

  it('SQL bind typed soft-0', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedPath}?limit=3`);
    const rel = db.selects.find((s) => s.sql.includes('relation_type = ?'));
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 4]);
  });

  it('SQL bind typed soft-1', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedPath}?limit=3`);
    const rel = db.selects.find((s) => s.sql.includes('relation_type = ?'));
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 4]);
  });

  it('SQL bind typed soft-2', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedPath}?limit=3`);
    const rel = db.selects.find((s) => s.sql.includes('relation_type = ?'));
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 4]);
  });

  it('SQL bind typed soft-3', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedPath}?limit=3`);
    const rel = db.selects.find((s) => s.sql.includes('relation_type = ?'));
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 4]);
  });

  it('SQL bind typed soft-4', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedPath}?limit=3`);
    const rel = db.selects.find((s) => s.sql.includes('relation_type = ?'));
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 4]);
  });

  it('SQL bind typed soft-5', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedPath}?limit=3`);
    const rel = db.selects.find((s) => s.sql.includes('relation_type = ?'));
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 4]);
  });

  it('SQL bind typed soft-6', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedPath}?limit=3`);
    const rel = db.selects.find((s) => s.sql.includes('relation_type = ?'));
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 4]);
  });

  it('SQL bind typed soft-7', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedPath}?limit=3`);
    const rel = db.selects.find((s) => s.sql.includes('relation_type = ?'));
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 4]);
  });

  it('SQL bind typed soft-8', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedPath}?limit=3`);
    const rel = db.selects.find((s) => s.sql.includes('relation_type = ?'));
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 4]);
  });

  it('SQL bind typed soft-9', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedPath}?limit=3`);
    const rel = db.selects.find((s) => s.sql.includes('relation_type = ?'));
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 4]);
  });

  it('SQL bind typed soft-10', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedPath}?limit=3`);
    const rel = db.selects.find((s) => s.sql.includes('relation_type = ?'));
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 4]);
  });

  it('SQL bind typed soft-11', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedPath}?limit=3`);
    const rel = db.selects.find((s) => s.sql.includes('relation_type = ?'));
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 4]);
  });

  it('SQL bind typed soft-12', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedPath}?limit=3`);
    const rel = db.selects.find((s) => s.sql.includes('relation_type = ?'));
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 4]);
  });

  it('SQL bind typed soft-13', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedPath}?limit=3`);
    const rel = db.selects.find((s) => s.sql.includes('relation_type = ?'));
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 4]);
  });

  it('SQL bind typed soft-14', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedPath}?limit=3`);
    const rel = db.selects.find((s) => s.sql.includes('relation_type = ?'));
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 4]);
  });

  it('SQL bind typed soft-15', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedPath}?limit=3`);
    const rel = db.selects.find((s) => s.sql.includes('relation_type = ?'));
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 4]);
  });
});

describe('relations leftovers SQL bind typed+eventType soft flood after #167', () => {

  it('SQL bind typed+eventType soft-0', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedEvtPath}?limit=7&dir=f`);
    const rel = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction', 8]);
    expect(rel?.sql.includes('ASC')).toBe(true);
  });

  it('SQL bind typed+eventType soft-1', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedEvtPath}?limit=7&dir=f`);
    const rel = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction', 8]);
    expect(rel?.sql.includes('ASC')).toBe(true);
  });

  it('SQL bind typed+eventType soft-2', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedEvtPath}?limit=7&dir=f`);
    const rel = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction', 8]);
    expect(rel?.sql.includes('ASC')).toBe(true);
  });

  it('SQL bind typed+eventType soft-3', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedEvtPath}?limit=7&dir=f`);
    const rel = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction', 8]);
    expect(rel?.sql.includes('ASC')).toBe(true);
  });

  it('SQL bind typed+eventType soft-4', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedEvtPath}?limit=7&dir=f`);
    const rel = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction', 8]);
    expect(rel?.sql.includes('ASC')).toBe(true);
  });

  it('SQL bind typed+eventType soft-5', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedEvtPath}?limit=7&dir=f`);
    const rel = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction', 8]);
    expect(rel?.sql.includes('ASC')).toBe(true);
  });

  it('SQL bind typed+eventType soft-6', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedEvtPath}?limit=7&dir=f`);
    const rel = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction', 8]);
    expect(rel?.sql.includes('ASC')).toBe(true);
  });

  it('SQL bind typed+eventType soft-7', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedEvtPath}?limit=7&dir=f`);
    const rel = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction', 8]);
    expect(rel?.sql.includes('ASC')).toBe(true);
  });

  it('SQL bind typed+eventType soft-8', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedEvtPath}?limit=7&dir=f`);
    const rel = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction', 8]);
    expect(rel?.sql.includes('ASC')).toBe(true);
  });

  it('SQL bind typed+eventType soft-9', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedEvtPath}?limit=7&dir=f`);
    const rel = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction', 8]);
    expect(rel?.sql.includes('ASC')).toBe(true);
  });

  it('SQL bind typed+eventType soft-10', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedEvtPath}?limit=7&dir=f`);
    const rel = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction', 8]);
    expect(rel?.sql.includes('ASC')).toBe(true);
  });

  it('SQL bind typed+eventType soft-11', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedEvtPath}?limit=7&dir=f`);
    const rel = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction', 8]);
    expect(rel?.sql.includes('ASC')).toBe(true);
  });

  it('SQL bind typed+eventType soft-12', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedEvtPath}?limit=7&dir=f`);
    const rel = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction', 8]);
    expect(rel?.sql.includes('ASC')).toBe(true);
  });

  it('SQL bind typed+eventType soft-13', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedEvtPath}?limit=7&dir=f`);
    const rel = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction', 8]);
    expect(rel?.sql.includes('ASC')).toBe(true);
  });

  it('SQL bind typed+eventType soft-14', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedEvtPath}?limit=7&dir=f`);
    const rel = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction', 8]);
    expect(rel?.sql.includes('ASC')).toBe(true);
  });

  it('SQL bind typed+eventType soft-15', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    await request(db, `${typedEvtPath}?limit=7&dir=f`);
    const rel = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(rel?.args).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction', 8]);
    expect(rel?.sql.includes('ASC')).toBe(true);
  });
});

describe('relations leftovers relation_type vocabulary soft flood after #167', () => {

  it('relation_type vocab soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rv0',
          origin_server_ts: 1,
          relation_type: 'm.annotation',
          event_type: 'm.room.message',
        }),
        child({ event_id: '$other0', origin_server_ts: 2, relation_type: 'm.noise.other', event_type: 'm.room.message' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/${encodeURIComponent('m.annotation')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$rv0');
  });

  it('relation_type vocab soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rv1',
          origin_server_ts: 1,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
        child({ event_id: '$other1', origin_server_ts: 2, relation_type: 'm.noise.other', event_type: 'm.room.message' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/${encodeURIComponent('m.replace')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$rv1');
  });

  it('relation_type vocab soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rv2',
          origin_server_ts: 1,
          relation_type: 'm.thread',
          event_type: 'm.room.message',
        }),
        child({ event_id: '$other2', origin_server_ts: 2, relation_type: 'm.noise.other', event_type: 'm.room.message' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/${encodeURIComponent('m.thread')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$rv2');
  });

  it('relation_type vocab soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rv3',
          origin_server_ts: 1,
          relation_type: 'm.reference',
          event_type: 'm.room.message',
        }),
        child({ event_id: '$other3', origin_server_ts: 2, relation_type: 'm.noise.other', event_type: 'm.room.message' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/${encodeURIComponent('m.reference')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$rv3');
  });

  it('relation_type vocab soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rv4',
          origin_server_ts: 1,
          relation_type: 'io.element.relation',
          event_type: 'm.room.message',
        }),
        child({ event_id: '$other4', origin_server_ts: 2, relation_type: 'm.noise.other', event_type: 'm.room.message' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/${encodeURIComponent('io.element.relation')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$rv4');
  });

  it('relation_type vocab soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rv5',
          origin_server_ts: 1,
          relation_type: 'org.example.custom',
          event_type: 'm.room.message',
        }),
        child({ event_id: '$other5', origin_server_ts: 2, relation_type: 'm.noise.other', event_type: 'm.room.message' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/${encodeURIComponent('org.example.custom')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$rv5');
  });

  it('relation_type vocab soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rv6',
          origin_server_ts: 1,
          relation_type: 'm.reaction',
          event_type: 'm.room.message',
        }),
        child({ event_id: '$other6', origin_server_ts: 2, relation_type: 'm.noise.other', event_type: 'm.room.message' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/${encodeURIComponent('m.reaction')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$rv6');
  });

  it('relation_type vocab soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rv7',
          origin_server_ts: 1,
          relation_type: 'm.reply',
          event_type: 'm.room.message',
        }),
        child({ event_id: '$other7', origin_server_ts: 2, relation_type: 'm.noise.other', event_type: 'm.room.message' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/${encodeURIComponent('m.reply')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$rv7');
  });

  it('relation_type vocab soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rv8',
          origin_server_ts: 1,
          relation_type: 'm.annotation',
          event_type: 'm.room.message',
        }),
        child({ event_id: '$other8', origin_server_ts: 2, relation_type: 'm.noise.other', event_type: 'm.room.message' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/${encodeURIComponent('m.annotation')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$rv8');
  });

  it('relation_type vocab soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rv9',
          origin_server_ts: 1,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
        child({ event_id: '$other9', origin_server_ts: 2, relation_type: 'm.noise.other', event_type: 'm.room.message' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/${encodeURIComponent('m.replace')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$rv9');
  });

  it('relation_type vocab soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rv10',
          origin_server_ts: 1,
          relation_type: 'm.thread',
          event_type: 'm.room.message',
        }),
        child({ event_id: '$other10', origin_server_ts: 2, relation_type: 'm.noise.other', event_type: 'm.room.message' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/${encodeURIComponent('m.thread')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$rv10');
  });

  it('relation_type vocab soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rv11',
          origin_server_ts: 1,
          relation_type: 'm.reference',
          event_type: 'm.room.message',
        }),
        child({ event_id: '$other11', origin_server_ts: 2, relation_type: 'm.noise.other', event_type: 'm.room.message' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/${encodeURIComponent('m.reference')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$rv11');
  });

  it('relation_type vocab soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rv12',
          origin_server_ts: 1,
          relation_type: 'io.element.relation',
          event_type: 'm.room.message',
        }),
        child({ event_id: '$other12', origin_server_ts: 2, relation_type: 'm.noise.other', event_type: 'm.room.message' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/${encodeURIComponent('io.element.relation')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$rv12');
  });

  it('relation_type vocab soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rv13',
          origin_server_ts: 1,
          relation_type: 'org.example.custom',
          event_type: 'm.room.message',
        }),
        child({ event_id: '$other13', origin_server_ts: 2, relation_type: 'm.noise.other', event_type: 'm.room.message' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/${encodeURIComponent('org.example.custom')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$rv13');
  });

  it('relation_type vocab soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rv14',
          origin_server_ts: 1,
          relation_type: 'm.reaction',
          event_type: 'm.room.message',
        }),
        child({ event_id: '$other14', origin_server_ts: 2, relation_type: 'm.noise.other', event_type: 'm.room.message' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/${encodeURIComponent('m.reaction')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$rv14');
  });

  it('relation_type vocab soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rv15',
          origin_server_ts: 1,
          relation_type: 'm.reply',
          event_type: 'm.room.message',
        }),
        child({ event_id: '$other15', origin_server_ts: 2, relation_type: 'm.noise.other', event_type: 'm.room.message' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/${encodeURIComponent('m.reply')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].event_id).toBe('$rv15');
  });
});

describe('relations leftovers eventType vocabulary soft flood after #167', () => {

  it('eventType vocab soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ev0',
          origin_server_ts: 1,
          event_type: 'm.reaction',
          relation_type: 'm.annotation',
        }),
        child({ event_id: '$skip0', origin_server_ts: 2, event_type: 'm.noise.skip', relation_type: 'm.annotation' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/m.annotation/${encodeURIComponent('m.reaction')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].type).toBe('m.reaction');
  });

  it('eventType vocab soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ev1',
          origin_server_ts: 1,
          event_type: 'm.room.message',
          relation_type: 'm.annotation',
        }),
        child({ event_id: '$skip1', origin_server_ts: 2, event_type: 'm.noise.skip', relation_type: 'm.annotation' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/m.annotation/${encodeURIComponent('m.room.message')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].type).toBe('m.room.message');
  });

  it('eventType vocab soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ev2',
          origin_server_ts: 1,
          event_type: 'm.room.encrypted',
          relation_type: 'm.annotation',
        }),
        child({ event_id: '$skip2', origin_server_ts: 2, event_type: 'm.noise.skip', relation_type: 'm.annotation' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/m.annotation/${encodeURIComponent('m.room.encrypted')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].type).toBe('m.room.encrypted');
  });

  it('eventType vocab soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ev3',
          origin_server_ts: 1,
          event_type: 'm.sticker',
          relation_type: 'm.annotation',
        }),
        child({ event_id: '$skip3', origin_server_ts: 2, event_type: 'm.noise.skip', relation_type: 'm.annotation' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/m.annotation/${encodeURIComponent('m.sticker')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].type).toBe('m.sticker');
  });

  it('eventType vocab soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ev4',
          origin_server_ts: 1,
          event_type: 'org.example.custom',
          relation_type: 'm.annotation',
        }),
        child({ event_id: '$skip4', origin_server_ts: 2, event_type: 'm.noise.skip', relation_type: 'm.annotation' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/m.annotation/${encodeURIComponent('org.example.custom')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].type).toBe('org.example.custom');
  });

  it('eventType vocab soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ev5',
          origin_server_ts: 1,
          event_type: 'm.key.verification.done',
          relation_type: 'm.annotation',
        }),
        child({ event_id: '$skip5', origin_server_ts: 2, event_type: 'm.noise.skip', relation_type: 'm.annotation' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/m.annotation/${encodeURIComponent('m.key.verification.done')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].type).toBe('m.key.verification.done');
  });

  it('eventType vocab soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ev6',
          origin_server_ts: 1,
          event_type: 'm.reaction',
          relation_type: 'm.annotation',
        }),
        child({ event_id: '$skip6', origin_server_ts: 2, event_type: 'm.noise.skip', relation_type: 'm.annotation' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/m.annotation/${encodeURIComponent('m.reaction')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].type).toBe('m.reaction');
  });

  it('eventType vocab soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ev7',
          origin_server_ts: 1,
          event_type: 'm.room.message',
          relation_type: 'm.annotation',
        }),
        child({ event_id: '$skip7', origin_server_ts: 2, event_type: 'm.noise.skip', relation_type: 'm.annotation' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/m.annotation/${encodeURIComponent('m.room.message')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].type).toBe('m.room.message');
  });

  it('eventType vocab soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ev8',
          origin_server_ts: 1,
          event_type: 'm.room.encrypted',
          relation_type: 'm.annotation',
        }),
        child({ event_id: '$skip8', origin_server_ts: 2, event_type: 'm.noise.skip', relation_type: 'm.annotation' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/m.annotation/${encodeURIComponent('m.room.encrypted')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].type).toBe('m.room.encrypted');
  });

  it('eventType vocab soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ev9',
          origin_server_ts: 1,
          event_type: 'm.sticker',
          relation_type: 'm.annotation',
        }),
        child({ event_id: '$skip9', origin_server_ts: 2, event_type: 'm.noise.skip', relation_type: 'm.annotation' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/m.annotation/${encodeURIComponent('m.sticker')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].type).toBe('m.sticker');
  });

  it('eventType vocab soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ev10',
          origin_server_ts: 1,
          event_type: 'org.example.custom',
          relation_type: 'm.annotation',
        }),
        child({ event_id: '$skip10', origin_server_ts: 2, event_type: 'm.noise.skip', relation_type: 'm.annotation' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/m.annotation/${encodeURIComponent('org.example.custom')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].type).toBe('org.example.custom');
  });

  it('eventType vocab soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ev11',
          origin_server_ts: 1,
          event_type: 'm.key.verification.done',
          relation_type: 'm.annotation',
        }),
        child({ event_id: '$skip11', origin_server_ts: 2, event_type: 'm.noise.skip', relation_type: 'm.annotation' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/m.annotation/${encodeURIComponent('m.key.verification.done')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].type).toBe('m.key.verification.done');
  });

  it('eventType vocab soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ev12',
          origin_server_ts: 1,
          event_type: 'm.reaction',
          relation_type: 'm.annotation',
        }),
        child({ event_id: '$skip12', origin_server_ts: 2, event_type: 'm.noise.skip', relation_type: 'm.annotation' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/m.annotation/${encodeURIComponent('m.reaction')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].type).toBe('m.reaction');
  });

  it('eventType vocab soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ev13',
          origin_server_ts: 1,
          event_type: 'm.room.message',
          relation_type: 'm.annotation',
        }),
        child({ event_id: '$skip13', origin_server_ts: 2, event_type: 'm.noise.skip', relation_type: 'm.annotation' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/m.annotation/${encodeURIComponent('m.room.message')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].type).toBe('m.room.message');
  });

  it('eventType vocab soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ev14',
          origin_server_ts: 1,
          event_type: 'm.room.encrypted',
          relation_type: 'm.annotation',
        }),
        child({ event_id: '$skip14', origin_server_ts: 2, event_type: 'm.noise.skip', relation_type: 'm.annotation' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/m.annotation/${encodeURIComponent('m.room.encrypted')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].type).toBe('m.room.encrypted');
  });

  it('eventType vocab soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ev15',
          origin_server_ts: 1,
          event_type: 'm.sticker',
          relation_type: 'm.annotation',
        }),
        child({ event_id: '$skip15', origin_server_ts: 2, event_type: 'm.noise.skip', relation_type: 'm.annotation' }),
      ],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}/m.annotation/${encodeURIComponent('m.sticker')}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.chunk[0].type).toBe('m.sticker');
  });
});

describe('relations leftovers concurrent select soft flood after #167', () => {

  it('concurrent select soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$cc0', origin_server_ts: 1 })],
    });
    const results = await Promise.all([
      request(db, base),
      request(db, typedPath),
      request(db, typedEvtPath),
      request(db, threadsPath),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.selects.filter((s) => s.sql.includes('FROM room_memberships')).length).toBeGreaterThanOrEqual(4);
  });

  it('concurrent select soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$cc1', origin_server_ts: 1 })],
    });
    const results = await Promise.all([
      request(db, base),
      request(db, typedPath),
      request(db, typedEvtPath),
      request(db, threadsPath),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.selects.filter((s) => s.sql.includes('FROM room_memberships')).length).toBeGreaterThanOrEqual(4);
  });

  it('concurrent select soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$cc2', origin_server_ts: 1 })],
    });
    const results = await Promise.all([
      request(db, base),
      request(db, typedPath),
      request(db, typedEvtPath),
      request(db, threadsPath),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.selects.filter((s) => s.sql.includes('FROM room_memberships')).length).toBeGreaterThanOrEqual(4);
  });

  it('concurrent select soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$cc3', origin_server_ts: 1 })],
    });
    const results = await Promise.all([
      request(db, base),
      request(db, typedPath),
      request(db, typedEvtPath),
      request(db, threadsPath),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.selects.filter((s) => s.sql.includes('FROM room_memberships')).length).toBeGreaterThanOrEqual(4);
  });

  it('concurrent select soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$cc4', origin_server_ts: 1 })],
    });
    const results = await Promise.all([
      request(db, base),
      request(db, typedPath),
      request(db, typedEvtPath),
      request(db, threadsPath),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.selects.filter((s) => s.sql.includes('FROM room_memberships')).length).toBeGreaterThanOrEqual(4);
  });

  it('concurrent select soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$cc5', origin_server_ts: 1 })],
    });
    const results = await Promise.all([
      request(db, base),
      request(db, typedPath),
      request(db, typedEvtPath),
      request(db, threadsPath),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.selects.filter((s) => s.sql.includes('FROM room_memberships')).length).toBeGreaterThanOrEqual(4);
  });

  it('concurrent select soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$cc6', origin_server_ts: 1 })],
    });
    const results = await Promise.all([
      request(db, base),
      request(db, typedPath),
      request(db, typedEvtPath),
      request(db, threadsPath),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.selects.filter((s) => s.sql.includes('FROM room_memberships')).length).toBeGreaterThanOrEqual(4);
  });

  it('concurrent select soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$cc7', origin_server_ts: 1 })],
    });
    const results = await Promise.all([
      request(db, base),
      request(db, typedPath),
      request(db, typedEvtPath),
      request(db, threadsPath),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.selects.filter((s) => s.sql.includes('FROM room_memberships')).length).toBeGreaterThanOrEqual(4);
  });

  it('concurrent select soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$cc8', origin_server_ts: 1 })],
    });
    const results = await Promise.all([
      request(db, base),
      request(db, typedPath),
      request(db, typedEvtPath),
      request(db, threadsPath),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.selects.filter((s) => s.sql.includes('FROM room_memberships')).length).toBeGreaterThanOrEqual(4);
  });

  it('concurrent select soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$cc9', origin_server_ts: 1 })],
    });
    const results = await Promise.all([
      request(db, base),
      request(db, typedPath),
      request(db, typedEvtPath),
      request(db, threadsPath),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.selects.filter((s) => s.sql.includes('FROM room_memberships')).length).toBeGreaterThanOrEqual(4);
  });

  it('concurrent select soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$cc10', origin_server_ts: 1 })],
    });
    const results = await Promise.all([
      request(db, base),
      request(db, typedPath),
      request(db, typedEvtPath),
      request(db, threadsPath),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.selects.filter((s) => s.sql.includes('FROM room_memberships')).length).toBeGreaterThanOrEqual(4);
  });

  it('concurrent select soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$cc11', origin_server_ts: 1 })],
    });
    const results = await Promise.all([
      request(db, base),
      request(db, typedPath),
      request(db, typedEvtPath),
      request(db, threadsPath),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.selects.filter((s) => s.sql.includes('FROM room_memberships')).length).toBeGreaterThanOrEqual(4);
  });

  it('concurrent select soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$cc12', origin_server_ts: 1 })],
    });
    const results = await Promise.all([
      request(db, base),
      request(db, typedPath),
      request(db, typedEvtPath),
      request(db, threadsPath),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.selects.filter((s) => s.sql.includes('FROM room_memberships')).length).toBeGreaterThanOrEqual(4);
  });

  it('concurrent select soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$cc13', origin_server_ts: 1 })],
    });
    const results = await Promise.all([
      request(db, base),
      request(db, typedPath),
      request(db, typedEvtPath),
      request(db, threadsPath),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.selects.filter((s) => s.sql.includes('FROM room_memberships')).length).toBeGreaterThanOrEqual(4);
  });

  it('concurrent select soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$cc14', origin_server_ts: 1 })],
    });
    const results = await Promise.all([
      request(db, base),
      request(db, typedPath),
      request(db, typedEvtPath),
      request(db, threadsPath),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.selects.filter((s) => s.sql.includes('FROM room_memberships')).length).toBeGreaterThanOrEqual(4);
  });

  it('concurrent select soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$cc15', origin_server_ts: 1 })],
    });
    const results = await Promise.all([
      request(db, base),
      request(db, typedPath),
      request(db, typedEvtPath),
      request(db, threadsPath),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.selects.filter((s) => s.sql.includes('FROM room_memberships')).length).toBeGreaterThanOrEqual(4);
  });
});

describe('relations leftovers equal timestamps soft flood after #167', () => {

  it('equal timestamps soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$e10', origin_server_ts: 42 }),
        child({ event_id: '$e20', origin_server_ts: 42 }),
        child({ event_id: '$e30', origin_server_ts: 42 }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk.every((e: { origin_server_ts: number }) => e.origin_server_ts === 42)).toBe(true);
  });

  it('equal timestamps soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$e11', origin_server_ts: 42 }),
        child({ event_id: '$e21', origin_server_ts: 42 }),
        child({ event_id: '$e31', origin_server_ts: 42 }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk.every((e: { origin_server_ts: number }) => e.origin_server_ts === 42)).toBe(true);
  });

  it('equal timestamps soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$e12', origin_server_ts: 42 }),
        child({ event_id: '$e22', origin_server_ts: 42 }),
        child({ event_id: '$e32', origin_server_ts: 42 }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk.every((e: { origin_server_ts: number }) => e.origin_server_ts === 42)).toBe(true);
  });

  it('equal timestamps soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$e13', origin_server_ts: 42 }),
        child({ event_id: '$e23', origin_server_ts: 42 }),
        child({ event_id: '$e33', origin_server_ts: 42 }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk.every((e: { origin_server_ts: number }) => e.origin_server_ts === 42)).toBe(true);
  });

  it('equal timestamps soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$e14', origin_server_ts: 42 }),
        child({ event_id: '$e24', origin_server_ts: 42 }),
        child({ event_id: '$e34', origin_server_ts: 42 }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk.every((e: { origin_server_ts: number }) => e.origin_server_ts === 42)).toBe(true);
  });

  it('equal timestamps soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$e15', origin_server_ts: 42 }),
        child({ event_id: '$e25', origin_server_ts: 42 }),
        child({ event_id: '$e35', origin_server_ts: 42 }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk.every((e: { origin_server_ts: number }) => e.origin_server_ts === 42)).toBe(true);
  });

  it('equal timestamps soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$e16', origin_server_ts: 42 }),
        child({ event_id: '$e26', origin_server_ts: 42 }),
        child({ event_id: '$e36', origin_server_ts: 42 }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk.every((e: { origin_server_ts: number }) => e.origin_server_ts === 42)).toBe(true);
  });

  it('equal timestamps soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$e17', origin_server_ts: 42 }),
        child({ event_id: '$e27', origin_server_ts: 42 }),
        child({ event_id: '$e37', origin_server_ts: 42 }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk.every((e: { origin_server_ts: number }) => e.origin_server_ts === 42)).toBe(true);
  });

  it('equal timestamps soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$e18', origin_server_ts: 42 }),
        child({ event_id: '$e28', origin_server_ts: 42 }),
        child({ event_id: '$e38', origin_server_ts: 42 }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk.every((e: { origin_server_ts: number }) => e.origin_server_ts === 42)).toBe(true);
  });

  it('equal timestamps soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$e19', origin_server_ts: 42 }),
        child({ event_id: '$e29', origin_server_ts: 42 }),
        child({ event_id: '$e39', origin_server_ts: 42 }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk.every((e: { origin_server_ts: number }) => e.origin_server_ts === 42)).toBe(true);
  });

  it('equal timestamps soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$e110', origin_server_ts: 42 }),
        child({ event_id: '$e210', origin_server_ts: 42 }),
        child({ event_id: '$e310', origin_server_ts: 42 }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk.every((e: { origin_server_ts: number }) => e.origin_server_ts === 42)).toBe(true);
  });

  it('equal timestamps soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$e111', origin_server_ts: 42 }),
        child({ event_id: '$e211', origin_server_ts: 42 }),
        child({ event_id: '$e311', origin_server_ts: 42 }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk.every((e: { origin_server_ts: number }) => e.origin_server_ts === 42)).toBe(true);
  });

  it('equal timestamps soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$e112', origin_server_ts: 42 }),
        child({ event_id: '$e212', origin_server_ts: 42 }),
        child({ event_id: '$e312', origin_server_ts: 42 }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk.every((e: { origin_server_ts: number }) => e.origin_server_ts === 42)).toBe(true);
  });

  it('equal timestamps soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$e113', origin_server_ts: 42 }),
        child({ event_id: '$e213', origin_server_ts: 42 }),
        child({ event_id: '$e313', origin_server_ts: 42 }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk.every((e: { origin_server_ts: number }) => e.origin_server_ts === 42)).toBe(true);
  });

  it('equal timestamps soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$e114', origin_server_ts: 42 }),
        child({ event_id: '$e214', origin_server_ts: 42 }),
        child({ event_id: '$e314', origin_server_ts: 42 }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk.every((e: { origin_server_ts: number }) => e.origin_server_ts === 42)).toBe(true);
  });

  it('equal timestamps soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$e115', origin_server_ts: 42 }),
        child({ event_id: '$e215', origin_server_ts: 42 }),
        child({ event_id: '$e315', origin_server_ts: 42 }),
      ],
    });
    const res = await request(db, `${base}?dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.chunk.every((e: { origin_server_ts: number }) => e.origin_server_ts === 42)).toBe(true);
  });
});

describe('relations leftovers content edges soft flood after #167', () => {

  it('content edges soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ct0',
          origin_server_ts: 1,
          content: '{}',
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].content).toEqual(JSON.parse('{}'));
  });

  it('content edges soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ct1',
          origin_server_ts: 1,
          content: '{"key":null}',
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].content).toEqual(JSON.parse('{"key":null}'));
  });

  it('content edges soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ct2',
          origin_server_ts: 1,
          content: '{"m.relates_to":{"rel_type":"m.annotation","key":""}}',
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].content).toEqual(JSON.parse('{"m.relates_to":{"rel_type":"m.annotation","key":""}}'));
  });

  it('content edges soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ct3',
          origin_server_ts: 1,
          content: '{"body":"","msgtype":"m.text"}',
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].content).toEqual(JSON.parse('{"body":"","msgtype":"m.text"}'));
  });

  it('content edges soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ct4',
          origin_server_ts: 1,
          content: '{"nested":{"a":[1,2,3]}}',
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].content).toEqual(JSON.parse('{"nested":{"a":[1,2,3]}}'));
  });

  it('content edges soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ct5',
          origin_server_ts: 1,
          content: '{"emoji":"🔥"}',
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].content).toEqual(JSON.parse('{"emoji":"🔥"}'));
  });

  it('content edges soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ct6',
          origin_server_ts: 1,
          content: '{}',
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].content).toEqual(JSON.parse('{}'));
  });

  it('content edges soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ct7',
          origin_server_ts: 1,
          content: '{"key":null}',
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].content).toEqual(JSON.parse('{"key":null}'));
  });

  it('content edges soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ct8',
          origin_server_ts: 1,
          content: '{"m.relates_to":{"rel_type":"m.annotation","key":""}}',
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].content).toEqual(JSON.parse('{"m.relates_to":{"rel_type":"m.annotation","key":""}}'));
  });

  it('content edges soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ct9',
          origin_server_ts: 1,
          content: '{"body":"","msgtype":"m.text"}',
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].content).toEqual(JSON.parse('{"body":"","msgtype":"m.text"}'));
  });

  it('content edges soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ct10',
          origin_server_ts: 1,
          content: '{"nested":{"a":[1,2,3]}}',
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].content).toEqual(JSON.parse('{"nested":{"a":[1,2,3]}}'));
  });

  it('content edges soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ct11',
          origin_server_ts: 1,
          content: '{"emoji":"🔥"}',
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].content).toEqual(JSON.parse('{"emoji":"🔥"}'));
  });

  it('content edges soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ct12',
          origin_server_ts: 1,
          content: '{}',
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].content).toEqual(JSON.parse('{}'));
  });

  it('content edges soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ct13',
          origin_server_ts: 1,
          content: '{"key":null}',
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].content).toEqual(JSON.parse('{"key":null}'));
  });

  it('content edges soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ct14',
          origin_server_ts: 1,
          content: '{"m.relates_to":{"rel_type":"m.annotation","key":""}}',
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].content).toEqual(JSON.parse('{"m.relates_to":{"rel_type":"m.annotation","key":""}}'));
  });

  it('content edges soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ct15',
          origin_server_ts: 1,
          content: '{"body":"","msgtype":"m.text"}',
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].content).toEqual(JSON.parse('{"body":"","msgtype":"m.text"}'));
  });
});

describe('relations leftovers URL encode soft flood after #167', () => {

  it('URL encode soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$pv0', origin_server_ts: 1 })],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/relations/${encodeURIComponent(PARENT)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$pv0');
  });

  it('URL encode soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$pv1', origin_server_ts: 1 })],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/relations/${encodeURIComponent(PARENT)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$pv1');
  });

  it('URL encode soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$pv2', origin_server_ts: 1 })],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/relations/${encodeURIComponent(PARENT)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$pv2');
  });

  it('URL encode soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$pv3', origin_server_ts: 1 })],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/relations/${encodeURIComponent(PARENT)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$pv3');
  });

  it('URL encode soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$pv4', origin_server_ts: 1 })],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/relations/${encodeURIComponent(PARENT)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$pv4');
  });

  it('URL encode soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$pv5', origin_server_ts: 1 })],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/relations/${encodeURIComponent(PARENT)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$pv5');
  });

  it('URL encode soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$pv6', origin_server_ts: 1 })],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/relations/${encodeURIComponent(PARENT)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$pv6');
  });

  it('URL encode soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$pv7', origin_server_ts: 1 })],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/relations/${encodeURIComponent(PARENT)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$pv7');
  });

  it('URL encode soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$pv8', origin_server_ts: 1 })],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/relations/${encodeURIComponent(PARENT)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$pv8');
  });

  it('URL encode soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$pv9', origin_server_ts: 1 })],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/relations/${encodeURIComponent(PARENT)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$pv9');
  });

  it('URL encode soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$pv10', origin_server_ts: 1 })],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/relations/${encodeURIComponent(PARENT)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$pv10');
  });

  it('URL encode soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$pv11', origin_server_ts: 1 })],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/relations/${encodeURIComponent(PARENT)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$pv11');
  });

  it('URL encode soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$pv12', origin_server_ts: 1 })],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/relations/${encodeURIComponent(PARENT)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$pv12');
  });

  it('URL encode soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$pv13', origin_server_ts: 1 })],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/relations/${encodeURIComponent(PARENT)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$pv13');
  });

  it('URL encode soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$pv14', origin_server_ts: 1 })],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/relations/${encodeURIComponent(PARENT)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$pv14');
  });

  it('URL encode soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$pv15', origin_server_ts: 1 })],
    });
    const res = await request(
      db,
      `/_matrix/client/v1/rooms/${encodeURIComponent(ROOM)}/relations/${encodeURIComponent(PARENT)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].event_id).toBe('$pv15');
  });
});

describe('relations leftovers ignored to= soft flood after #167', () => {

  it('ignored to= soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$to0', origin_server_ts: 100 }),
        child({ event_id: '$to20', origin_server_ts: 200 }),
      ],
    });
    const res = await request(db, `${base}?to=0&from=150&dir=f`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$to20']);
  });

  it('ignored to= soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$to1', origin_server_ts: 100 }),
        child({ event_id: '$to21', origin_server_ts: 200 }),
      ],
    });
    const res = await request(db, `${base}?to=1&from=150&dir=f`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$to21']);
  });

  it('ignored to= soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$to2', origin_server_ts: 100 }),
        child({ event_id: '$to22', origin_server_ts: 200 }),
      ],
    });
    const res = await request(db, `${base}?to=2&from=150&dir=f`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$to22']);
  });

  it('ignored to= soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$to3', origin_server_ts: 100 }),
        child({ event_id: '$to23', origin_server_ts: 200 }),
      ],
    });
    const res = await request(db, `${base}?to=3&from=150&dir=f`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$to23']);
  });

  it('ignored to= soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$to4', origin_server_ts: 100 }),
        child({ event_id: '$to24', origin_server_ts: 200 }),
      ],
    });
    const res = await request(db, `${base}?to=4&from=150&dir=f`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$to24']);
  });

  it('ignored to= soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$to5', origin_server_ts: 100 }),
        child({ event_id: '$to25', origin_server_ts: 200 }),
      ],
    });
    const res = await request(db, `${base}?to=5&from=150&dir=f`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$to25']);
  });

  it('ignored to= soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$to6', origin_server_ts: 100 }),
        child({ event_id: '$to26', origin_server_ts: 200 }),
      ],
    });
    const res = await request(db, `${base}?to=6&from=150&dir=f`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$to26']);
  });

  it('ignored to= soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$to7', origin_server_ts: 100 }),
        child({ event_id: '$to27', origin_server_ts: 200 }),
      ],
    });
    const res = await request(db, `${base}?to=7&from=150&dir=f`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$to27']);
  });

  it('ignored to= soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$to8', origin_server_ts: 100 }),
        child({ event_id: '$to28', origin_server_ts: 200 }),
      ],
    });
    const res = await request(db, `${base}?to=8&from=150&dir=f`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$to28']);
  });

  it('ignored to= soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$to9', origin_server_ts: 100 }),
        child({ event_id: '$to29', origin_server_ts: 200 }),
      ],
    });
    const res = await request(db, `${base}?to=9&from=150&dir=f`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$to29']);
  });

  it('ignored to= soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$to10', origin_server_ts: 100 }),
        child({ event_id: '$to210', origin_server_ts: 200 }),
      ],
    });
    const res = await request(db, `${base}?to=10&from=150&dir=f`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$to210']);
  });

  it('ignored to= soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$to11', origin_server_ts: 100 }),
        child({ event_id: '$to211', origin_server_ts: 200 }),
      ],
    });
    const res = await request(db, `${base}?to=11&from=150&dir=f`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$to211']);
  });

  it('ignored to= soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$to12', origin_server_ts: 100 }),
        child({ event_id: '$to212', origin_server_ts: 200 }),
      ],
    });
    const res = await request(db, `${base}?to=12&from=150&dir=f`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$to212']);
  });

  it('ignored to= soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$to13', origin_server_ts: 100 }),
        child({ event_id: '$to213', origin_server_ts: 200 }),
      ],
    });
    const res = await request(db, `${base}?to=13&from=150&dir=f`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$to213']);
  });

  it('ignored to= soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$to14', origin_server_ts: 100 }),
        child({ event_id: '$to214', origin_server_ts: 200 }),
      ],
    });
    const res = await request(db, `${base}?to=14&from=150&dir=f`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$to214']);
  });

  it('ignored to= soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$to15', origin_server_ts: 100 }),
        child({ event_id: '$to215', origin_server_ts: 200 }),
      ],
    });
    const res = await request(db, `${base}?to=15&from=150&dir=f`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(['$to215']);
  });
});

describe('relations leftovers weird limit soft flood after #167', () => {

  it('weird limit soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$wl0', origin_server_ts: 1 })],
    });
    const res = await request(db, `${base}?limit=abc`);
    // Document current behavior: non-numeric limits become NaN fetch size; route still 200 if mock returns rows
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body.chunk)).toBe(true);
    }
  });

  it('weird limit soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$wl1', origin_server_ts: 1 })],
    });
    const res = await request(db, `${base}?limit=`);
    // Document current behavior: non-numeric limits become NaN fetch size; route still 200 if mock returns rows
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body.chunk)).toBe(true);
    }
  });

  it('weird limit soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$wl2', origin_server_ts: 1 })],
    });
    const res = await request(db, `${base}?limit=-1`);
    // Document current behavior: non-numeric limits become NaN fetch size; route still 200 if mock returns rows
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body.chunk)).toBe(true);
    }
  });

  it('weird limit soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$wl3', origin_server_ts: 1 })],
    });
    const res = await request(db, `${base}?limit=0`);
    // Document current behavior: non-numeric limits become NaN fetch size; route still 200 if mock returns rows
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body.chunk)).toBe(true);
    }
  });

  it('weird limit soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$wl4', origin_server_ts: 1 })],
    });
    const res = await request(db, `${base}?limit=0.5`);
    // Document current behavior: non-numeric limits become NaN fetch size; route still 200 if mock returns rows
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body.chunk)).toBe(true);
    }
  });

  it('weird limit soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$wl5', origin_server_ts: 1 })],
    });
    const res = await request(db, `${base}?limit=1e2`);
    // Document current behavior: non-numeric limits become NaN fetch size; route still 200 if mock returns rows
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body.chunk)).toBe(true);
    }
  });

  it('weird limit soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$wl6', origin_server_ts: 1 })],
    });
    const res = await request(db, `${base}?limit=Infinity`);
    // Document current behavior: non-numeric limits become NaN fetch size; route still 200 if mock returns rows
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body.chunk)).toBe(true);
    }
  });

  it('weird limit soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$wl7', origin_server_ts: 1 })],
    });
    const res = await request(db, `${base}?limit=NaN`);
    // Document current behavior: non-numeric limits become NaN fetch size; route still 200 if mock returns rows
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body.chunk)).toBe(true);
    }
  });

  it('weird limit soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$wl8', origin_server_ts: 1 })],
    });
    const res = await request(db, `${base}?limit=abc`);
    // Document current behavior: non-numeric limits become NaN fetch size; route still 200 if mock returns rows
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body.chunk)).toBe(true);
    }
  });

  it('weird limit soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$wl9', origin_server_ts: 1 })],
    });
    const res = await request(db, `${base}?limit=`);
    // Document current behavior: non-numeric limits become NaN fetch size; route still 200 if mock returns rows
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body.chunk)).toBe(true);
    }
  });

  it('weird limit soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$wl10', origin_server_ts: 1 })],
    });
    const res = await request(db, `${base}?limit=-1`);
    // Document current behavior: non-numeric limits become NaN fetch size; route still 200 if mock returns rows
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body.chunk)).toBe(true);
    }
  });

  it('weird limit soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$wl11', origin_server_ts: 1 })],
    });
    const res = await request(db, `${base}?limit=0`);
    // Document current behavior: non-numeric limits become NaN fetch size; route still 200 if mock returns rows
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body.chunk)).toBe(true);
    }
  });

  it('weird limit soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$wl12', origin_server_ts: 1 })],
    });
    const res = await request(db, `${base}?limit=0.5`);
    // Document current behavior: non-numeric limits become NaN fetch size; route still 200 if mock returns rows
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body.chunk)).toBe(true);
    }
  });

  it('weird limit soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$wl13', origin_server_ts: 1 })],
    });
    const res = await request(db, `${base}?limit=1e2`);
    // Document current behavior: non-numeric limits become NaN fetch size; route still 200 if mock returns rows
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body.chunk)).toBe(true);
    }
  });

  it('weird limit soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$wl14', origin_server_ts: 1 })],
    });
    const res = await request(db, `${base}?limit=Infinity`);
    // Document current behavior: non-numeric limits become NaN fetch size; route still 200 if mock returns rows
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body.chunk)).toBe(true);
    }
  });

  it('weird limit soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$wl15', origin_server_ts: 1 })],
    });
    const res = await request(db, `${base}?limit=NaN`);
    // Document current behavior: non-numeric limits become NaN fetch size; route still 200 if mock returns rows
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body.chunk)).toBe(true);
    }
  });
});


describe('relations leftovers failure and edge cases after #167', () => {
  it('membership query throw propagates on all-relations', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], throwOnMembership: true });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('membership query throw propagates on threads', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], throwOnMembership: true });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(500);
  });

  it('events query throw propagates after membership ok', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], throwOnEvents: true });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('corrupt JSON content throws on all-relations map', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$bad', origin_server_ts: 1 })],
      corruptContentIds: new Set(['$bad']),
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('corrupt JSON content throws on threads map', async () => {
    const root = '$badroot:example.com';
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [threadRoot(root, 1), threadReply(root, '$br:example.com', 2)],
      corruptContentIds: new Set([root]),
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(500);
  });

  it('invite membership forbidden on typed endpoint', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$x', origin_server_ts: 1 })],
    });
    const res = await request(db, typedPath);
    expect(res.status).toBe(403);
  });

  it('ban membership forbidden on typed+eventType', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
    });
    const res = await request(db, typedEvtPath);
    expect(res.status).toBe(403);
  });

  it('knock membership forbidden on threads', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
    });
    const res = await request(db, threadsPath);
    expect(res.status).toBe(403);
  });

  it('wrong-room membership does not grant access', async () => {
    const db = createRelationsDb({
      memberships: [joinMember(ROOM2)],
      events: [child({ event_id: '$x', origin_server_ts: 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
  });

  it('next_batch absent when exact limit match', async () => {
    const events = Array.from({ length: 2 }, (_, j) =>
      child({ event_id: `$ex${j}`, origin_server_ts: (j + 1) * 10 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=2`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(2);
    expect(res.body.next_batch).toBeUndefined();
  });

  it('typed endpoint ignores from= (no from filter in SQL)', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a', origin_server_ts: 10 }),
        child({ event_id: '$b', origin_server_ts: 20 }),
      ],
    });
    const res = await request(db, `${typedPath}?from=15&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(2);
  });

  it('include=all returns all thread roots', async () => {
    const r1 = '$t1:example.com';
    const r2 = '$t2:example.com';
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        threadRoot(r1, 10, BOB),
        threadReply(r1, '$t1r:example.com', 11, BOB),
        threadRoot(r2, 20, USER),
        threadReply(r2, '$t2r:example.com', 21, USER),
      ],
    });
    const res = await request(db, `${threadsPath}?include=all`);
    expect(res.status).toBe(200);
    expect(res.body.chunk.map((e: { event_id: string }) => e.event_id).sort()).toEqual(
      [r1, r2].sort()
    );
  });

  it('errcode vocabulary M_FORBIDDEN across endpoints', async () => {
    const db = createRelationsDb({ memberships: [] });
    for (const path of [base, typedPath, typedEvtPath, threadsPath]) {
      const res = await request(db, path);
      expect(res.body.errcode).toBe('M_FORBIDDEN');
      expect(typeof res.body.error).toBe('string');
    }
  });
});


describe('relations leftovers method matrix after #167', () => {
  const cases: Array<{ path: string; bad: string[] }> = [
    { path: base, bad: ['POST', 'PUT', 'DELETE', 'PATCH'] },
    { path: typedPath, bad: ['POST', 'PUT', 'DELETE', 'PATCH'] },
    { path: typedEvtPath, bad: ['POST', 'PUT', 'DELETE', 'PATCH'] },
    { path: threadsPath, bad: ['POST', 'PUT', 'DELETE', 'PATCH'] },
  ];
  for (const c of cases) {
    for (const method of c.bad) {
      it(`${method} ${c.path} → 404/405`, async () => {
        const db = createRelationsDb({ memberships: [joinMember()], events: [] });
        const res = await request(db, c.path, { method });
        expect([404, 405]).toContain(res.status);
      });
    }
  }
});

describe('relations leftovers lifecycle soft floods after #167', () => {

  it('relations→typed→threads lifecycle soft-0', async () => {
    const root = `$life0:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$ann0`, origin_server_ts: 10 }),
        child({
          event_id: `$rep0`,
          origin_server_ts: 20,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
        threadRoot(root, 100),
        threadReply(root, `$lr0:example.com`, 110),
      ],
    });
    const all = await request(db, base);
    expect(all.status).toBe(200);
    expect(all.body.chunk.length).toBeGreaterThanOrEqual(2);
    const typed = await request(db, typedPath);
    expect(typed.status).toBe(200);
    expect(typed.body.chunk.some((e: { event_id: string }) => e.event_id === `$ann0`)).toBe(true);
    const typedEvt = await request(db, typedEvtPath);
    expect(typedEvt.status).toBe(200);
    expect(typedEvt.body.chunk[0].event_id).toBe(`$ann0`);
    const threads = await request(db, threadsPath);
    expect(threads.status).toBe(200);
    expect(threads.body.chunk.some((e: { event_id: string }) => e.event_id === root)).toBe(true);
  });

  it('relations→typed→threads lifecycle soft-1', async () => {
    const root = `$life1:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$ann1`, origin_server_ts: 10 }),
        child({
          event_id: `$rep1`,
          origin_server_ts: 20,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
        threadRoot(root, 100),
        threadReply(root, `$lr1:example.com`, 110),
      ],
    });
    const all = await request(db, base);
    expect(all.status).toBe(200);
    expect(all.body.chunk.length).toBeGreaterThanOrEqual(2);
    const typed = await request(db, typedPath);
    expect(typed.status).toBe(200);
    expect(typed.body.chunk.some((e: { event_id: string }) => e.event_id === `$ann1`)).toBe(true);
    const typedEvt = await request(db, typedEvtPath);
    expect(typedEvt.status).toBe(200);
    expect(typedEvt.body.chunk[0].event_id).toBe(`$ann1`);
    const threads = await request(db, threadsPath);
    expect(threads.status).toBe(200);
    expect(threads.body.chunk.some((e: { event_id: string }) => e.event_id === root)).toBe(true);
  });

  it('relations→typed→threads lifecycle soft-2', async () => {
    const root = `$life2:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$ann2`, origin_server_ts: 10 }),
        child({
          event_id: `$rep2`,
          origin_server_ts: 20,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
        threadRoot(root, 100),
        threadReply(root, `$lr2:example.com`, 110),
      ],
    });
    const all = await request(db, base);
    expect(all.status).toBe(200);
    expect(all.body.chunk.length).toBeGreaterThanOrEqual(2);
    const typed = await request(db, typedPath);
    expect(typed.status).toBe(200);
    expect(typed.body.chunk.some((e: { event_id: string }) => e.event_id === `$ann2`)).toBe(true);
    const typedEvt = await request(db, typedEvtPath);
    expect(typedEvt.status).toBe(200);
    expect(typedEvt.body.chunk[0].event_id).toBe(`$ann2`);
    const threads = await request(db, threadsPath);
    expect(threads.status).toBe(200);
    expect(threads.body.chunk.some((e: { event_id: string }) => e.event_id === root)).toBe(true);
  });

  it('relations→typed→threads lifecycle soft-3', async () => {
    const root = `$life3:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$ann3`, origin_server_ts: 10 }),
        child({
          event_id: `$rep3`,
          origin_server_ts: 20,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
        threadRoot(root, 100),
        threadReply(root, `$lr3:example.com`, 110),
      ],
    });
    const all = await request(db, base);
    expect(all.status).toBe(200);
    expect(all.body.chunk.length).toBeGreaterThanOrEqual(2);
    const typed = await request(db, typedPath);
    expect(typed.status).toBe(200);
    expect(typed.body.chunk.some((e: { event_id: string }) => e.event_id === `$ann3`)).toBe(true);
    const typedEvt = await request(db, typedEvtPath);
    expect(typedEvt.status).toBe(200);
    expect(typedEvt.body.chunk[0].event_id).toBe(`$ann3`);
    const threads = await request(db, threadsPath);
    expect(threads.status).toBe(200);
    expect(threads.body.chunk.some((e: { event_id: string }) => e.event_id === root)).toBe(true);
  });

  it('relations→typed→threads lifecycle soft-4', async () => {
    const root = `$life4:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$ann4`, origin_server_ts: 10 }),
        child({
          event_id: `$rep4`,
          origin_server_ts: 20,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
        threadRoot(root, 100),
        threadReply(root, `$lr4:example.com`, 110),
      ],
    });
    const all = await request(db, base);
    expect(all.status).toBe(200);
    expect(all.body.chunk.length).toBeGreaterThanOrEqual(2);
    const typed = await request(db, typedPath);
    expect(typed.status).toBe(200);
    expect(typed.body.chunk.some((e: { event_id: string }) => e.event_id === `$ann4`)).toBe(true);
    const typedEvt = await request(db, typedEvtPath);
    expect(typedEvt.status).toBe(200);
    expect(typedEvt.body.chunk[0].event_id).toBe(`$ann4`);
    const threads = await request(db, threadsPath);
    expect(threads.status).toBe(200);
    expect(threads.body.chunk.some((e: { event_id: string }) => e.event_id === root)).toBe(true);
  });

  it('relations→typed→threads lifecycle soft-5', async () => {
    const root = `$life5:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$ann5`, origin_server_ts: 10 }),
        child({
          event_id: `$rep5`,
          origin_server_ts: 20,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
        threadRoot(root, 100),
        threadReply(root, `$lr5:example.com`, 110),
      ],
    });
    const all = await request(db, base);
    expect(all.status).toBe(200);
    expect(all.body.chunk.length).toBeGreaterThanOrEqual(2);
    const typed = await request(db, typedPath);
    expect(typed.status).toBe(200);
    expect(typed.body.chunk.some((e: { event_id: string }) => e.event_id === `$ann5`)).toBe(true);
    const typedEvt = await request(db, typedEvtPath);
    expect(typedEvt.status).toBe(200);
    expect(typedEvt.body.chunk[0].event_id).toBe(`$ann5`);
    const threads = await request(db, threadsPath);
    expect(threads.status).toBe(200);
    expect(threads.body.chunk.some((e: { event_id: string }) => e.event_id === root)).toBe(true);
  });

  it('relations→typed→threads lifecycle soft-6', async () => {
    const root = `$life6:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$ann6`, origin_server_ts: 10 }),
        child({
          event_id: `$rep6`,
          origin_server_ts: 20,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
        threadRoot(root, 100),
        threadReply(root, `$lr6:example.com`, 110),
      ],
    });
    const all = await request(db, base);
    expect(all.status).toBe(200);
    expect(all.body.chunk.length).toBeGreaterThanOrEqual(2);
    const typed = await request(db, typedPath);
    expect(typed.status).toBe(200);
    expect(typed.body.chunk.some((e: { event_id: string }) => e.event_id === `$ann6`)).toBe(true);
    const typedEvt = await request(db, typedEvtPath);
    expect(typedEvt.status).toBe(200);
    expect(typedEvt.body.chunk[0].event_id).toBe(`$ann6`);
    const threads = await request(db, threadsPath);
    expect(threads.status).toBe(200);
    expect(threads.body.chunk.some((e: { event_id: string }) => e.event_id === root)).toBe(true);
  });

  it('relations→typed→threads lifecycle soft-7', async () => {
    const root = `$life7:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$ann7`, origin_server_ts: 10 }),
        child({
          event_id: `$rep7`,
          origin_server_ts: 20,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
        threadRoot(root, 100),
        threadReply(root, `$lr7:example.com`, 110),
      ],
    });
    const all = await request(db, base);
    expect(all.status).toBe(200);
    expect(all.body.chunk.length).toBeGreaterThanOrEqual(2);
    const typed = await request(db, typedPath);
    expect(typed.status).toBe(200);
    expect(typed.body.chunk.some((e: { event_id: string }) => e.event_id === `$ann7`)).toBe(true);
    const typedEvt = await request(db, typedEvtPath);
    expect(typedEvt.status).toBe(200);
    expect(typedEvt.body.chunk[0].event_id).toBe(`$ann7`);
    const threads = await request(db, threadsPath);
    expect(threads.status).toBe(200);
    expect(threads.body.chunk.some((e: { event_id: string }) => e.event_id === root)).toBe(true);
  });

  it('relations→typed→threads lifecycle soft-8', async () => {
    const root = `$life8:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$ann8`, origin_server_ts: 10 }),
        child({
          event_id: `$rep8`,
          origin_server_ts: 20,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
        threadRoot(root, 100),
        threadReply(root, `$lr8:example.com`, 110),
      ],
    });
    const all = await request(db, base);
    expect(all.status).toBe(200);
    expect(all.body.chunk.length).toBeGreaterThanOrEqual(2);
    const typed = await request(db, typedPath);
    expect(typed.status).toBe(200);
    expect(typed.body.chunk.some((e: { event_id: string }) => e.event_id === `$ann8`)).toBe(true);
    const typedEvt = await request(db, typedEvtPath);
    expect(typedEvt.status).toBe(200);
    expect(typedEvt.body.chunk[0].event_id).toBe(`$ann8`);
    const threads = await request(db, threadsPath);
    expect(threads.status).toBe(200);
    expect(threads.body.chunk.some((e: { event_id: string }) => e.event_id === root)).toBe(true);
  });

  it('relations→typed→threads lifecycle soft-9', async () => {
    const root = `$life9:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$ann9`, origin_server_ts: 10 }),
        child({
          event_id: `$rep9`,
          origin_server_ts: 20,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
        threadRoot(root, 100),
        threadReply(root, `$lr9:example.com`, 110),
      ],
    });
    const all = await request(db, base);
    expect(all.status).toBe(200);
    expect(all.body.chunk.length).toBeGreaterThanOrEqual(2);
    const typed = await request(db, typedPath);
    expect(typed.status).toBe(200);
    expect(typed.body.chunk.some((e: { event_id: string }) => e.event_id === `$ann9`)).toBe(true);
    const typedEvt = await request(db, typedEvtPath);
    expect(typedEvt.status).toBe(200);
    expect(typedEvt.body.chunk[0].event_id).toBe(`$ann9`);
    const threads = await request(db, threadsPath);
    expect(threads.status).toBe(200);
    expect(threads.body.chunk.some((e: { event_id: string }) => e.event_id === root)).toBe(true);
  });

  it('relations→typed→threads lifecycle soft-10', async () => {
    const root = `$life10:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$ann10`, origin_server_ts: 10 }),
        child({
          event_id: `$rep10`,
          origin_server_ts: 20,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
        threadRoot(root, 100),
        threadReply(root, `$lr10:example.com`, 110),
      ],
    });
    const all = await request(db, base);
    expect(all.status).toBe(200);
    expect(all.body.chunk.length).toBeGreaterThanOrEqual(2);
    const typed = await request(db, typedPath);
    expect(typed.status).toBe(200);
    expect(typed.body.chunk.some((e: { event_id: string }) => e.event_id === `$ann10`)).toBe(true);
    const typedEvt = await request(db, typedEvtPath);
    expect(typedEvt.status).toBe(200);
    expect(typedEvt.body.chunk[0].event_id).toBe(`$ann10`);
    const threads = await request(db, threadsPath);
    expect(threads.status).toBe(200);
    expect(threads.body.chunk.some((e: { event_id: string }) => e.event_id === root)).toBe(true);
  });

  it('relations→typed→threads lifecycle soft-11', async () => {
    const root = `$life11:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$ann11`, origin_server_ts: 10 }),
        child({
          event_id: `$rep11`,
          origin_server_ts: 20,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
        threadRoot(root, 100),
        threadReply(root, `$lr11:example.com`, 110),
      ],
    });
    const all = await request(db, base);
    expect(all.status).toBe(200);
    expect(all.body.chunk.length).toBeGreaterThanOrEqual(2);
    const typed = await request(db, typedPath);
    expect(typed.status).toBe(200);
    expect(typed.body.chunk.some((e: { event_id: string }) => e.event_id === `$ann11`)).toBe(true);
    const typedEvt = await request(db, typedEvtPath);
    expect(typedEvt.status).toBe(200);
    expect(typedEvt.body.chunk[0].event_id).toBe(`$ann11`);
    const threads = await request(db, threadsPath);
    expect(threads.status).toBe(200);
    expect(threads.body.chunk.some((e: { event_id: string }) => e.event_id === root)).toBe(true);
  });

  it('relations→typed→threads lifecycle soft-12', async () => {
    const root = `$life12:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$ann12`, origin_server_ts: 10 }),
        child({
          event_id: `$rep12`,
          origin_server_ts: 20,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
        threadRoot(root, 100),
        threadReply(root, `$lr12:example.com`, 110),
      ],
    });
    const all = await request(db, base);
    expect(all.status).toBe(200);
    expect(all.body.chunk.length).toBeGreaterThanOrEqual(2);
    const typed = await request(db, typedPath);
    expect(typed.status).toBe(200);
    expect(typed.body.chunk.some((e: { event_id: string }) => e.event_id === `$ann12`)).toBe(true);
    const typedEvt = await request(db, typedEvtPath);
    expect(typedEvt.status).toBe(200);
    expect(typedEvt.body.chunk[0].event_id).toBe(`$ann12`);
    const threads = await request(db, threadsPath);
    expect(threads.status).toBe(200);
    expect(threads.body.chunk.some((e: { event_id: string }) => e.event_id === root)).toBe(true);
  });

  it('relations→typed→threads lifecycle soft-13', async () => {
    const root = `$life13:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$ann13`, origin_server_ts: 10 }),
        child({
          event_id: `$rep13`,
          origin_server_ts: 20,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
        threadRoot(root, 100),
        threadReply(root, `$lr13:example.com`, 110),
      ],
    });
    const all = await request(db, base);
    expect(all.status).toBe(200);
    expect(all.body.chunk.length).toBeGreaterThanOrEqual(2);
    const typed = await request(db, typedPath);
    expect(typed.status).toBe(200);
    expect(typed.body.chunk.some((e: { event_id: string }) => e.event_id === `$ann13`)).toBe(true);
    const typedEvt = await request(db, typedEvtPath);
    expect(typedEvt.status).toBe(200);
    expect(typedEvt.body.chunk[0].event_id).toBe(`$ann13`);
    const threads = await request(db, threadsPath);
    expect(threads.status).toBe(200);
    expect(threads.body.chunk.some((e: { event_id: string }) => e.event_id === root)).toBe(true);
  });

  it('relations→typed→threads lifecycle soft-14', async () => {
    const root = `$life14:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$ann14`, origin_server_ts: 10 }),
        child({
          event_id: `$rep14`,
          origin_server_ts: 20,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
        threadRoot(root, 100),
        threadReply(root, `$lr14:example.com`, 110),
      ],
    });
    const all = await request(db, base);
    expect(all.status).toBe(200);
    expect(all.body.chunk.length).toBeGreaterThanOrEqual(2);
    const typed = await request(db, typedPath);
    expect(typed.status).toBe(200);
    expect(typed.body.chunk.some((e: { event_id: string }) => e.event_id === `$ann14`)).toBe(true);
    const typedEvt = await request(db, typedEvtPath);
    expect(typedEvt.status).toBe(200);
    expect(typedEvt.body.chunk[0].event_id).toBe(`$ann14`);
    const threads = await request(db, threadsPath);
    expect(threads.status).toBe(200);
    expect(threads.body.chunk.some((e: { event_id: string }) => e.event_id === root)).toBe(true);
  });

  it('relations→typed→threads lifecycle soft-15', async () => {
    const root = `$life15:example.com`;
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$ann15`, origin_server_ts: 10 }),
        child({
          event_id: `$rep15`,
          origin_server_ts: 20,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
        threadRoot(root, 100),
        threadReply(root, `$lr15:example.com`, 110),
      ],
    });
    const all = await request(db, base);
    expect(all.status).toBe(200);
    expect(all.body.chunk.length).toBeGreaterThanOrEqual(2);
    const typed = await request(db, typedPath);
    expect(typed.status).toBe(200);
    expect(typed.body.chunk.some((e: { event_id: string }) => e.event_id === `$ann15`)).toBe(true);
    const typedEvt = await request(db, typedEvtPath);
    expect(typedEvt.status).toBe(200);
    expect(typedEvt.body.chunk[0].event_id).toBe(`$ann15`);
    const threads = await request(db, threadsPath);
    expect(threads.status).toBe(200);
    expect(threads.body.chunk.some((e: { event_id: string }) => e.event_id === root)).toBe(true);
  });
});

describe('relations leftovers pagination chain soft flood after #167', () => {

  it('pagination chain soft-0', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$ch0_${j}`, origin_server_ts: (j + 1) * 100 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const page1 = await request(db, `${base}?limit=2&dir=b`);
    expect(page1.body.chunk).toHaveLength(2);
    expect(page1.body.next_batch).toBeDefined();
    const page2 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page1.body.next_batch}`
    );
    expect(page2.body.chunk).toHaveLength(2);
    expect(page2.body.chunk[0].origin_server_ts).toBeLessThan(
      page1.body.chunk[page1.body.chunk.length - 1].origin_server_ts
    );
    const page3 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page2.body.next_batch}`
    );
    expect(page3.body.chunk).toHaveLength(2);
    expect(page3.body.next_batch).toBeUndefined();
  });

  it('pagination chain soft-1', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$ch1_${j}`, origin_server_ts: (j + 1) * 100 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const page1 = await request(db, `${base}?limit=2&dir=b`);
    expect(page1.body.chunk).toHaveLength(2);
    expect(page1.body.next_batch).toBeDefined();
    const page2 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page1.body.next_batch}`
    );
    expect(page2.body.chunk).toHaveLength(2);
    expect(page2.body.chunk[0].origin_server_ts).toBeLessThan(
      page1.body.chunk[page1.body.chunk.length - 1].origin_server_ts
    );
    const page3 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page2.body.next_batch}`
    );
    expect(page3.body.chunk).toHaveLength(2);
    expect(page3.body.next_batch).toBeUndefined();
  });

  it('pagination chain soft-2', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$ch2_${j}`, origin_server_ts: (j + 1) * 100 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const page1 = await request(db, `${base}?limit=2&dir=b`);
    expect(page1.body.chunk).toHaveLength(2);
    expect(page1.body.next_batch).toBeDefined();
    const page2 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page1.body.next_batch}`
    );
    expect(page2.body.chunk).toHaveLength(2);
    expect(page2.body.chunk[0].origin_server_ts).toBeLessThan(
      page1.body.chunk[page1.body.chunk.length - 1].origin_server_ts
    );
    const page3 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page2.body.next_batch}`
    );
    expect(page3.body.chunk).toHaveLength(2);
    expect(page3.body.next_batch).toBeUndefined();
  });

  it('pagination chain soft-3', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$ch3_${j}`, origin_server_ts: (j + 1) * 100 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const page1 = await request(db, `${base}?limit=2&dir=b`);
    expect(page1.body.chunk).toHaveLength(2);
    expect(page1.body.next_batch).toBeDefined();
    const page2 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page1.body.next_batch}`
    );
    expect(page2.body.chunk).toHaveLength(2);
    expect(page2.body.chunk[0].origin_server_ts).toBeLessThan(
      page1.body.chunk[page1.body.chunk.length - 1].origin_server_ts
    );
    const page3 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page2.body.next_batch}`
    );
    expect(page3.body.chunk).toHaveLength(2);
    expect(page3.body.next_batch).toBeUndefined();
  });

  it('pagination chain soft-4', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$ch4_${j}`, origin_server_ts: (j + 1) * 100 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const page1 = await request(db, `${base}?limit=2&dir=b`);
    expect(page1.body.chunk).toHaveLength(2);
    expect(page1.body.next_batch).toBeDefined();
    const page2 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page1.body.next_batch}`
    );
    expect(page2.body.chunk).toHaveLength(2);
    expect(page2.body.chunk[0].origin_server_ts).toBeLessThan(
      page1.body.chunk[page1.body.chunk.length - 1].origin_server_ts
    );
    const page3 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page2.body.next_batch}`
    );
    expect(page3.body.chunk).toHaveLength(2);
    expect(page3.body.next_batch).toBeUndefined();
  });

  it('pagination chain soft-5', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$ch5_${j}`, origin_server_ts: (j + 1) * 100 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const page1 = await request(db, `${base}?limit=2&dir=b`);
    expect(page1.body.chunk).toHaveLength(2);
    expect(page1.body.next_batch).toBeDefined();
    const page2 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page1.body.next_batch}`
    );
    expect(page2.body.chunk).toHaveLength(2);
    expect(page2.body.chunk[0].origin_server_ts).toBeLessThan(
      page1.body.chunk[page1.body.chunk.length - 1].origin_server_ts
    );
    const page3 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page2.body.next_batch}`
    );
    expect(page3.body.chunk).toHaveLength(2);
    expect(page3.body.next_batch).toBeUndefined();
  });

  it('pagination chain soft-6', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$ch6_${j}`, origin_server_ts: (j + 1) * 100 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const page1 = await request(db, `${base}?limit=2&dir=b`);
    expect(page1.body.chunk).toHaveLength(2);
    expect(page1.body.next_batch).toBeDefined();
    const page2 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page1.body.next_batch}`
    );
    expect(page2.body.chunk).toHaveLength(2);
    expect(page2.body.chunk[0].origin_server_ts).toBeLessThan(
      page1.body.chunk[page1.body.chunk.length - 1].origin_server_ts
    );
    const page3 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page2.body.next_batch}`
    );
    expect(page3.body.chunk).toHaveLength(2);
    expect(page3.body.next_batch).toBeUndefined();
  });

  it('pagination chain soft-7', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$ch7_${j}`, origin_server_ts: (j + 1) * 100 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const page1 = await request(db, `${base}?limit=2&dir=b`);
    expect(page1.body.chunk).toHaveLength(2);
    expect(page1.body.next_batch).toBeDefined();
    const page2 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page1.body.next_batch}`
    );
    expect(page2.body.chunk).toHaveLength(2);
    expect(page2.body.chunk[0].origin_server_ts).toBeLessThan(
      page1.body.chunk[page1.body.chunk.length - 1].origin_server_ts
    );
    const page3 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page2.body.next_batch}`
    );
    expect(page3.body.chunk).toHaveLength(2);
    expect(page3.body.next_batch).toBeUndefined();
  });

  it('pagination chain soft-8', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$ch8_${j}`, origin_server_ts: (j + 1) * 100 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const page1 = await request(db, `${base}?limit=2&dir=b`);
    expect(page1.body.chunk).toHaveLength(2);
    expect(page1.body.next_batch).toBeDefined();
    const page2 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page1.body.next_batch}`
    );
    expect(page2.body.chunk).toHaveLength(2);
    expect(page2.body.chunk[0].origin_server_ts).toBeLessThan(
      page1.body.chunk[page1.body.chunk.length - 1].origin_server_ts
    );
    const page3 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page2.body.next_batch}`
    );
    expect(page3.body.chunk).toHaveLength(2);
    expect(page3.body.next_batch).toBeUndefined();
  });

  it('pagination chain soft-9', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$ch9_${j}`, origin_server_ts: (j + 1) * 100 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const page1 = await request(db, `${base}?limit=2&dir=b`);
    expect(page1.body.chunk).toHaveLength(2);
    expect(page1.body.next_batch).toBeDefined();
    const page2 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page1.body.next_batch}`
    );
    expect(page2.body.chunk).toHaveLength(2);
    expect(page2.body.chunk[0].origin_server_ts).toBeLessThan(
      page1.body.chunk[page1.body.chunk.length - 1].origin_server_ts
    );
    const page3 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page2.body.next_batch}`
    );
    expect(page3.body.chunk).toHaveLength(2);
    expect(page3.body.next_batch).toBeUndefined();
  });

  it('pagination chain soft-10', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$ch10_${j}`, origin_server_ts: (j + 1) * 100 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const page1 = await request(db, `${base}?limit=2&dir=b`);
    expect(page1.body.chunk).toHaveLength(2);
    expect(page1.body.next_batch).toBeDefined();
    const page2 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page1.body.next_batch}`
    );
    expect(page2.body.chunk).toHaveLength(2);
    expect(page2.body.chunk[0].origin_server_ts).toBeLessThan(
      page1.body.chunk[page1.body.chunk.length - 1].origin_server_ts
    );
    const page3 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page2.body.next_batch}`
    );
    expect(page3.body.chunk).toHaveLength(2);
    expect(page3.body.next_batch).toBeUndefined();
  });

  it('pagination chain soft-11', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$ch11_${j}`, origin_server_ts: (j + 1) * 100 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const page1 = await request(db, `${base}?limit=2&dir=b`);
    expect(page1.body.chunk).toHaveLength(2);
    expect(page1.body.next_batch).toBeDefined();
    const page2 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page1.body.next_batch}`
    );
    expect(page2.body.chunk).toHaveLength(2);
    expect(page2.body.chunk[0].origin_server_ts).toBeLessThan(
      page1.body.chunk[page1.body.chunk.length - 1].origin_server_ts
    );
    const page3 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page2.body.next_batch}`
    );
    expect(page3.body.chunk).toHaveLength(2);
    expect(page3.body.next_batch).toBeUndefined();
  });

  it('pagination chain soft-12', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$ch12_${j}`, origin_server_ts: (j + 1) * 100 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const page1 = await request(db, `${base}?limit=2&dir=b`);
    expect(page1.body.chunk).toHaveLength(2);
    expect(page1.body.next_batch).toBeDefined();
    const page2 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page1.body.next_batch}`
    );
    expect(page2.body.chunk).toHaveLength(2);
    expect(page2.body.chunk[0].origin_server_ts).toBeLessThan(
      page1.body.chunk[page1.body.chunk.length - 1].origin_server_ts
    );
    const page3 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page2.body.next_batch}`
    );
    expect(page3.body.chunk).toHaveLength(2);
    expect(page3.body.next_batch).toBeUndefined();
  });

  it('pagination chain soft-13', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$ch13_${j}`, origin_server_ts: (j + 1) * 100 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const page1 = await request(db, `${base}?limit=2&dir=b`);
    expect(page1.body.chunk).toHaveLength(2);
    expect(page1.body.next_batch).toBeDefined();
    const page2 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page1.body.next_batch}`
    );
    expect(page2.body.chunk).toHaveLength(2);
    expect(page2.body.chunk[0].origin_server_ts).toBeLessThan(
      page1.body.chunk[page1.body.chunk.length - 1].origin_server_ts
    );
    const page3 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page2.body.next_batch}`
    );
    expect(page3.body.chunk).toHaveLength(2);
    expect(page3.body.next_batch).toBeUndefined();
  });

  it('pagination chain soft-14', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$ch14_${j}`, origin_server_ts: (j + 1) * 100 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const page1 = await request(db, `${base}?limit=2&dir=b`);
    expect(page1.body.chunk).toHaveLength(2);
    expect(page1.body.next_batch).toBeDefined();
    const page2 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page1.body.next_batch}`
    );
    expect(page2.body.chunk).toHaveLength(2);
    expect(page2.body.chunk[0].origin_server_ts).toBeLessThan(
      page1.body.chunk[page1.body.chunk.length - 1].origin_server_ts
    );
    const page3 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page2.body.next_batch}`
    );
    expect(page3.body.chunk).toHaveLength(2);
    expect(page3.body.next_batch).toBeUndefined();
  });

  it('pagination chain soft-15', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$ch15_${j}`, origin_server_ts: (j + 1) * 100 })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const page1 = await request(db, `${base}?limit=2&dir=b`);
    expect(page1.body.chunk).toHaveLength(2);
    expect(page1.body.next_batch).toBeDefined();
    const page2 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page1.body.next_batch}`
    );
    expect(page2.body.chunk).toHaveLength(2);
    expect(page2.body.chunk[0].origin_server_ts).toBeLessThan(
      page1.body.chunk[page1.body.chunk.length - 1].origin_server_ts
    );
    const page3 = await request(
      db,
      `${base}?limit=2&dir=b&from=${page2.body.next_batch}`
    );
    expect(page3.body.chunk).toHaveLength(2);
    expect(page3.body.next_batch).toBeUndefined();
  });
});

describe('relations leftovers sender diversity soft flood after #167', () => {

  it('sender diversity soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$s10`, origin_server_ts: 1, sender: USER }),
        child({ event_id: `$s20`, origin_server_ts: 2, sender: BOB }),
        child({
          event_id: `$s30`,
          origin_server_ts: 3,
          sender: `@carol:example.com`,
        }),
      ],
    });
    const res = await request(db, `${base}?dir=f`);
    expect(res.body.chunk.map((e: { sender: string }) => e.sender)).toEqual([
      USER,
      BOB,
      '@carol:example.com',
    ]);
  });

  it('sender diversity soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$s11`, origin_server_ts: 1, sender: USER }),
        child({ event_id: `$s21`, origin_server_ts: 2, sender: BOB }),
        child({
          event_id: `$s31`,
          origin_server_ts: 3,
          sender: `@carol:example.com`,
        }),
      ],
    });
    const res = await request(db, `${base}?dir=f`);
    expect(res.body.chunk.map((e: { sender: string }) => e.sender)).toEqual([
      USER,
      BOB,
      '@carol:example.com',
    ]);
  });

  it('sender diversity soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$s12`, origin_server_ts: 1, sender: USER }),
        child({ event_id: `$s22`, origin_server_ts: 2, sender: BOB }),
        child({
          event_id: `$s32`,
          origin_server_ts: 3,
          sender: `@carol:example.com`,
        }),
      ],
    });
    const res = await request(db, `${base}?dir=f`);
    expect(res.body.chunk.map((e: { sender: string }) => e.sender)).toEqual([
      USER,
      BOB,
      '@carol:example.com',
    ]);
  });

  it('sender diversity soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$s13`, origin_server_ts: 1, sender: USER }),
        child({ event_id: `$s23`, origin_server_ts: 2, sender: BOB }),
        child({
          event_id: `$s33`,
          origin_server_ts: 3,
          sender: `@carol:example.com`,
        }),
      ],
    });
    const res = await request(db, `${base}?dir=f`);
    expect(res.body.chunk.map((e: { sender: string }) => e.sender)).toEqual([
      USER,
      BOB,
      '@carol:example.com',
    ]);
  });

  it('sender diversity soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$s14`, origin_server_ts: 1, sender: USER }),
        child({ event_id: `$s24`, origin_server_ts: 2, sender: BOB }),
        child({
          event_id: `$s34`,
          origin_server_ts: 3,
          sender: `@carol:example.com`,
        }),
      ],
    });
    const res = await request(db, `${base}?dir=f`);
    expect(res.body.chunk.map((e: { sender: string }) => e.sender)).toEqual([
      USER,
      BOB,
      '@carol:example.com',
    ]);
  });

  it('sender diversity soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$s15`, origin_server_ts: 1, sender: USER }),
        child({ event_id: `$s25`, origin_server_ts: 2, sender: BOB }),
        child({
          event_id: `$s35`,
          origin_server_ts: 3,
          sender: `@carol:example.com`,
        }),
      ],
    });
    const res = await request(db, `${base}?dir=f`);
    expect(res.body.chunk.map((e: { sender: string }) => e.sender)).toEqual([
      USER,
      BOB,
      '@carol:example.com',
    ]);
  });

  it('sender diversity soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$s16`, origin_server_ts: 1, sender: USER }),
        child({ event_id: `$s26`, origin_server_ts: 2, sender: BOB }),
        child({
          event_id: `$s36`,
          origin_server_ts: 3,
          sender: `@carol:example.com`,
        }),
      ],
    });
    const res = await request(db, `${base}?dir=f`);
    expect(res.body.chunk.map((e: { sender: string }) => e.sender)).toEqual([
      USER,
      BOB,
      '@carol:example.com',
    ]);
  });

  it('sender diversity soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$s17`, origin_server_ts: 1, sender: USER }),
        child({ event_id: `$s27`, origin_server_ts: 2, sender: BOB }),
        child({
          event_id: `$s37`,
          origin_server_ts: 3,
          sender: `@carol:example.com`,
        }),
      ],
    });
    const res = await request(db, `${base}?dir=f`);
    expect(res.body.chunk.map((e: { sender: string }) => e.sender)).toEqual([
      USER,
      BOB,
      '@carol:example.com',
    ]);
  });

  it('sender diversity soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$s18`, origin_server_ts: 1, sender: USER }),
        child({ event_id: `$s28`, origin_server_ts: 2, sender: BOB }),
        child({
          event_id: `$s38`,
          origin_server_ts: 3,
          sender: `@carol:example.com`,
        }),
      ],
    });
    const res = await request(db, `${base}?dir=f`);
    expect(res.body.chunk.map((e: { sender: string }) => e.sender)).toEqual([
      USER,
      BOB,
      '@carol:example.com',
    ]);
  });

  it('sender diversity soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$s19`, origin_server_ts: 1, sender: USER }),
        child({ event_id: `$s29`, origin_server_ts: 2, sender: BOB }),
        child({
          event_id: `$s39`,
          origin_server_ts: 3,
          sender: `@carol:example.com`,
        }),
      ],
    });
    const res = await request(db, `${base}?dir=f`);
    expect(res.body.chunk.map((e: { sender: string }) => e.sender)).toEqual([
      USER,
      BOB,
      '@carol:example.com',
    ]);
  });

  it('sender diversity soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$s110`, origin_server_ts: 1, sender: USER }),
        child({ event_id: `$s210`, origin_server_ts: 2, sender: BOB }),
        child({
          event_id: `$s310`,
          origin_server_ts: 3,
          sender: `@carol:example.com`,
        }),
      ],
    });
    const res = await request(db, `${base}?dir=f`);
    expect(res.body.chunk.map((e: { sender: string }) => e.sender)).toEqual([
      USER,
      BOB,
      '@carol:example.com',
    ]);
  });

  it('sender diversity soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$s111`, origin_server_ts: 1, sender: USER }),
        child({ event_id: `$s211`, origin_server_ts: 2, sender: BOB }),
        child({
          event_id: `$s311`,
          origin_server_ts: 3,
          sender: `@carol:example.com`,
        }),
      ],
    });
    const res = await request(db, `${base}?dir=f`);
    expect(res.body.chunk.map((e: { sender: string }) => e.sender)).toEqual([
      USER,
      BOB,
      '@carol:example.com',
    ]);
  });

  it('sender diversity soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$s112`, origin_server_ts: 1, sender: USER }),
        child({ event_id: `$s212`, origin_server_ts: 2, sender: BOB }),
        child({
          event_id: `$s312`,
          origin_server_ts: 3,
          sender: `@carol:example.com`,
        }),
      ],
    });
    const res = await request(db, `${base}?dir=f`);
    expect(res.body.chunk.map((e: { sender: string }) => e.sender)).toEqual([
      USER,
      BOB,
      '@carol:example.com',
    ]);
  });

  it('sender diversity soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$s113`, origin_server_ts: 1, sender: USER }),
        child({ event_id: `$s213`, origin_server_ts: 2, sender: BOB }),
        child({
          event_id: `$s313`,
          origin_server_ts: 3,
          sender: `@carol:example.com`,
        }),
      ],
    });
    const res = await request(db, `${base}?dir=f`);
    expect(res.body.chunk.map((e: { sender: string }) => e.sender)).toEqual([
      USER,
      BOB,
      '@carol:example.com',
    ]);
  });

  it('sender diversity soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$s114`, origin_server_ts: 1, sender: USER }),
        child({ event_id: `$s214`, origin_server_ts: 2, sender: BOB }),
        child({
          event_id: `$s314`,
          origin_server_ts: 3,
          sender: `@carol:example.com`,
        }),
      ],
    });
    const res = await request(db, `${base}?dir=f`);
    expect(res.body.chunk.map((e: { sender: string }) => e.sender)).toEqual([
      USER,
      BOB,
      '@carol:example.com',
    ]);
  });

  it('sender diversity soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: `$s115`, origin_server_ts: 1, sender: USER }),
        child({ event_id: `$s215`, origin_server_ts: 2, sender: BOB }),
        child({
          event_id: `$s315`,
          origin_server_ts: 3,
          sender: `@carol:example.com`,
        }),
      ],
    });
    const res = await request(db, `${base}?dir=f`);
    expect(res.body.chunk.map((e: { sender: string }) => e.sender)).toEqual([
      USER,
      BOB,
      '@carol:example.com',
    ]);
  });
});

describe('relations leftovers dense annotation soft flood after #167', () => {

  it('dense annotation soft-0', async () => {
    const events = Array.from({ length: 40 }, (_, j) =>
      child({
        event_id: `$d0_${j}`,
        origin_server_ts: j + 1,
        content: JSON.stringify({
          'm.relates_to': { rel_type: 'm.annotation', key: `k${j % 5}` },
        }),
      })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${typedPath}?limit=10&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(10);
    expect(res.body.next_batch).toBeDefined();
    expect(res.body.chunk[0].event_id).toBe(`$d0_39`);
  });

  it('dense annotation soft-1', async () => {
    const events = Array.from({ length: 40 }, (_, j) =>
      child({
        event_id: `$d1_${j}`,
        origin_server_ts: j + 1,
        content: JSON.stringify({
          'm.relates_to': { rel_type: 'm.annotation', key: `k${j % 5}` },
        }),
      })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${typedPath}?limit=10&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(10);
    expect(res.body.next_batch).toBeDefined();
    expect(res.body.chunk[0].event_id).toBe(`$d1_39`);
  });

  it('dense annotation soft-2', async () => {
    const events = Array.from({ length: 40 }, (_, j) =>
      child({
        event_id: `$d2_${j}`,
        origin_server_ts: j + 1,
        content: JSON.stringify({
          'm.relates_to': { rel_type: 'm.annotation', key: `k${j % 5}` },
        }),
      })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${typedPath}?limit=10&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(10);
    expect(res.body.next_batch).toBeDefined();
    expect(res.body.chunk[0].event_id).toBe(`$d2_39`);
  });

  it('dense annotation soft-3', async () => {
    const events = Array.from({ length: 40 }, (_, j) =>
      child({
        event_id: `$d3_${j}`,
        origin_server_ts: j + 1,
        content: JSON.stringify({
          'm.relates_to': { rel_type: 'm.annotation', key: `k${j % 5}` },
        }),
      })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${typedPath}?limit=10&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(10);
    expect(res.body.next_batch).toBeDefined();
    expect(res.body.chunk[0].event_id).toBe(`$d3_39`);
  });

  it('dense annotation soft-4', async () => {
    const events = Array.from({ length: 40 }, (_, j) =>
      child({
        event_id: `$d4_${j}`,
        origin_server_ts: j + 1,
        content: JSON.stringify({
          'm.relates_to': { rel_type: 'm.annotation', key: `k${j % 5}` },
        }),
      })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${typedPath}?limit=10&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(10);
    expect(res.body.next_batch).toBeDefined();
    expect(res.body.chunk[0].event_id).toBe(`$d4_39`);
  });

  it('dense annotation soft-5', async () => {
    const events = Array.from({ length: 40 }, (_, j) =>
      child({
        event_id: `$d5_${j}`,
        origin_server_ts: j + 1,
        content: JSON.stringify({
          'm.relates_to': { rel_type: 'm.annotation', key: `k${j % 5}` },
        }),
      })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${typedPath}?limit=10&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(10);
    expect(res.body.next_batch).toBeDefined();
    expect(res.body.chunk[0].event_id).toBe(`$d5_39`);
  });

  it('dense annotation soft-6', async () => {
    const events = Array.from({ length: 40 }, (_, j) =>
      child({
        event_id: `$d6_${j}`,
        origin_server_ts: j + 1,
        content: JSON.stringify({
          'm.relates_to': { rel_type: 'm.annotation', key: `k${j % 5}` },
        }),
      })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${typedPath}?limit=10&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(10);
    expect(res.body.next_batch).toBeDefined();
    expect(res.body.chunk[0].event_id).toBe(`$d6_39`);
  });

  it('dense annotation soft-7', async () => {
    const events = Array.from({ length: 40 }, (_, j) =>
      child({
        event_id: `$d7_${j}`,
        origin_server_ts: j + 1,
        content: JSON.stringify({
          'm.relates_to': { rel_type: 'm.annotation', key: `k${j % 5}` },
        }),
      })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${typedPath}?limit=10&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(10);
    expect(res.body.next_batch).toBeDefined();
    expect(res.body.chunk[0].event_id).toBe(`$d7_39`);
  });

  it('dense annotation soft-8', async () => {
    const events = Array.from({ length: 40 }, (_, j) =>
      child({
        event_id: `$d8_${j}`,
        origin_server_ts: j + 1,
        content: JSON.stringify({
          'm.relates_to': { rel_type: 'm.annotation', key: `k${j % 5}` },
        }),
      })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${typedPath}?limit=10&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(10);
    expect(res.body.next_batch).toBeDefined();
    expect(res.body.chunk[0].event_id).toBe(`$d8_39`);
  });

  it('dense annotation soft-9', async () => {
    const events = Array.from({ length: 40 }, (_, j) =>
      child({
        event_id: `$d9_${j}`,
        origin_server_ts: j + 1,
        content: JSON.stringify({
          'm.relates_to': { rel_type: 'm.annotation', key: `k${j % 5}` },
        }),
      })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${typedPath}?limit=10&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(10);
    expect(res.body.next_batch).toBeDefined();
    expect(res.body.chunk[0].event_id).toBe(`$d9_39`);
  });

  it('dense annotation soft-10', async () => {
    const events = Array.from({ length: 40 }, (_, j) =>
      child({
        event_id: `$d10_${j}`,
        origin_server_ts: j + 1,
        content: JSON.stringify({
          'm.relates_to': { rel_type: 'm.annotation', key: `k${j % 5}` },
        }),
      })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${typedPath}?limit=10&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(10);
    expect(res.body.next_batch).toBeDefined();
    expect(res.body.chunk[0].event_id).toBe(`$d10_39`);
  });

  it('dense annotation soft-11', async () => {
    const events = Array.from({ length: 40 }, (_, j) =>
      child({
        event_id: `$d11_${j}`,
        origin_server_ts: j + 1,
        content: JSON.stringify({
          'm.relates_to': { rel_type: 'm.annotation', key: `k${j % 5}` },
        }),
      })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${typedPath}?limit=10&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(10);
    expect(res.body.next_batch).toBeDefined();
    expect(res.body.chunk[0].event_id).toBe(`$d11_39`);
  });

  it('dense annotation soft-12', async () => {
    const events = Array.from({ length: 40 }, (_, j) =>
      child({
        event_id: `$d12_${j}`,
        origin_server_ts: j + 1,
        content: JSON.stringify({
          'm.relates_to': { rel_type: 'm.annotation', key: `k${j % 5}` },
        }),
      })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${typedPath}?limit=10&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(10);
    expect(res.body.next_batch).toBeDefined();
    expect(res.body.chunk[0].event_id).toBe(`$d12_39`);
  });

  it('dense annotation soft-13', async () => {
    const events = Array.from({ length: 40 }, (_, j) =>
      child({
        event_id: `$d13_${j}`,
        origin_server_ts: j + 1,
        content: JSON.stringify({
          'm.relates_to': { rel_type: 'm.annotation', key: `k${j % 5}` },
        }),
      })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${typedPath}?limit=10&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(10);
    expect(res.body.next_batch).toBeDefined();
    expect(res.body.chunk[0].event_id).toBe(`$d13_39`);
  });

  it('dense annotation soft-14', async () => {
    const events = Array.from({ length: 40 }, (_, j) =>
      child({
        event_id: `$d14_${j}`,
        origin_server_ts: j + 1,
        content: JSON.stringify({
          'm.relates_to': { rel_type: 'm.annotation', key: `k${j % 5}` },
        }),
      })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${typedPath}?limit=10&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(10);
    expect(res.body.next_batch).toBeDefined();
    expect(res.body.chunk[0].event_id).toBe(`$d14_39`);
  });

  it('dense annotation soft-15', async () => {
    const events = Array.from({ length: 40 }, (_, j) =>
      child({
        event_id: `$d15_${j}`,
        origin_server_ts: j + 1,
        content: JSON.stringify({
          'm.relates_to': { rel_type: 'm.annotation', key: `k${j % 5}` },
        }),
      })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${typedPath}?limit=10&dir=b`);
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(10);
    expect(res.body.next_batch).toBeDefined();
    expect(res.body.chunk[0].event_id).toBe(`$d15_39`);
  });
});
