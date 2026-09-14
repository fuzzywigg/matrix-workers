/**
 * TOKENMAXX HEAVY leftovers after #175 — relations/threads API soft/edge/reliability.
 * Complements relations-api-routes.test.ts (#123 TOKENMAXX deepen). Orthogonal to
 * federation keys/membership + account-data leftovers (#175), push leftovers,
 * keys/media/appservice races, devices/key-backups/report races.
 * Tests-only — no product inventing. Fixtures use example.com only.
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

import relations from '../src/api/relations';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const ROOM = '!room:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const PARENT = '$parent:example.com';
const PARENT_ENC = encodeURIComponent(PARENT);
const NOW = 1_700_000_000_000;

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
  badContentIds?: Set<string>;
} = {}) {
  const memberships = opts.memberships ?? [];
  const events = opts.events ?? [];
  const selects: SqlCall[] = [];

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

              if (
                sql.includes("relation_type = 'm.thread'") ||
                sql.includes('relation_type = \'m.thread\'')
              ) {
                if (sql.includes('event_id IN')) {
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
                            r.relates_to_event_id === e.event_id &&
                            r.sender === userId
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
                      content: opts.badContentIds?.has(e.event_id) ? '{bad' : e.content,
                    })) as T[],
                  };
                }
              }

              if (sql.includes('FROM events e') && sql.includes('relates_to_event_id')) {
                const roomId = args[0] as string;
                const eventId = args[1] as string;
                const dir = parseOrder(sql);

                let filtered = events.filter(
                  (e) => e.room_id === roomId && e.relates_to_event_id === eventId
                );

                const hasRelType =
                  sql.includes('relation_type = ?') && !sql.includes('event_type = ?');
                const hasRelAndEventType =
                  sql.includes('relation_type = ?') && sql.includes('event_type = ?');

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
                    content: opts.badContentIds?.has(e.event_id) ? '{bad' : e.content,
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
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const headers = new Headers(init.headers);
  if (!headers.has('Authorization')) {
    headers.set('Authorization', 'Bearer t');
  }
  const res = await relations.request(
    `http://localhost${path}`,
    { ...init, headers },
    envFor(db)
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
  return { status: res.status, body, headers: res.headers };
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

function threadRoot(
  overrides: Partial<EventRow> & Pick<EventRow, 'event_id' | 'origin_server_ts'>
): EventRow {
  return {
    event_id: overrides.event_id,
    room_id: overrides.room_id ?? ROOM,
    event_type: overrides.event_type ?? 'm.room.message',
    sender: overrides.sender ?? USER,
    origin_server_ts: overrides.origin_server_ts,
    content: overrides.content ?? JSON.stringify({ body: 'root', msgtype: 'm.text' }),
    relates_to_event_id: null,
    relation_type: null,
  };
}

function threadReply(
  rootId: string,
  overrides: Partial<EventRow> & Pick<EventRow, 'event_id' | 'origin_server_ts'>
): EventRow {
  return {
    event_id: overrides.event_id,
    room_id: overrides.room_id ?? ROOM,
    event_type: overrides.event_type ?? 'm.room.message',
    sender: overrides.sender ?? USER,
    origin_server_ts: overrides.origin_server_ts,
    content:
      overrides.content ??
      JSON.stringify({
        body: 'reply',
        msgtype: 'm.text',
        'm.relates_to': { rel_type: 'm.thread', event_id: rootId },
      }),
    relates_to_event_id: rootId,
    relation_type: 'm.thread',
  };
}

const base = `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}`;
const threadsBase = `/_matrix/client/v1/rooms/${ROOM_ENC}/threads`;


describe('relations leftovers GET all soft flood after #175', () => {

  it('all relations soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$c0a', origin_server_ts: NOW + 0 }),
        child({ event_id: '$c0b', origin_server_ts: NOW + 0 + 1, sender: BOB }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; sender: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c0b', '$c0a']);
    expect(body.chunk[0].sender).toBe(BOB);
  });

  it('all relations soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$c1a', origin_server_ts: NOW + 1 }),
        child({ event_id: '$c1b', origin_server_ts: NOW + 1 + 1, sender: BOB }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; sender: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c1b', '$c1a']);
    expect(body.chunk[0].sender).toBe(BOB);
  });

  it('all relations soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$c2a', origin_server_ts: NOW + 2 }),
        child({ event_id: '$c2b', origin_server_ts: NOW + 2 + 1, sender: BOB }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; sender: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c2b', '$c2a']);
    expect(body.chunk[0].sender).toBe(BOB);
  });

  it('all relations soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$c3a', origin_server_ts: NOW + 3 }),
        child({ event_id: '$c3b', origin_server_ts: NOW + 3 + 1, sender: BOB }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; sender: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c3b', '$c3a']);
    expect(body.chunk[0].sender).toBe(BOB);
  });

  it('all relations soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$c4a', origin_server_ts: NOW + 4 }),
        child({ event_id: '$c4b', origin_server_ts: NOW + 4 + 1, sender: BOB }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; sender: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c4b', '$c4a']);
    expect(body.chunk[0].sender).toBe(BOB);
  });

  it('all relations soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$c5a', origin_server_ts: NOW + 5 }),
        child({ event_id: '$c5b', origin_server_ts: NOW + 5 + 1, sender: BOB }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; sender: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c5b', '$c5a']);
    expect(body.chunk[0].sender).toBe(BOB);
  });

  it('all relations soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$c6a', origin_server_ts: NOW + 6 }),
        child({ event_id: '$c6b', origin_server_ts: NOW + 6 + 1, sender: BOB }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; sender: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c6b', '$c6a']);
    expect(body.chunk[0].sender).toBe(BOB);
  });

  it('all relations soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$c7a', origin_server_ts: NOW + 7 }),
        child({ event_id: '$c7b', origin_server_ts: NOW + 7 + 1, sender: BOB }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; sender: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c7b', '$c7a']);
    expect(body.chunk[0].sender).toBe(BOB);
  });

  it('all relations soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$c8a', origin_server_ts: NOW + 8 }),
        child({ event_id: '$c8b', origin_server_ts: NOW + 8 + 1, sender: BOB }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; sender: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c8b', '$c8a']);
    expect(body.chunk[0].sender).toBe(BOB);
  });

  it('all relations soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$c9a', origin_server_ts: NOW + 9 }),
        child({ event_id: '$c9b', origin_server_ts: NOW + 9 + 1, sender: BOB }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; sender: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c9b', '$c9a']);
    expect(body.chunk[0].sender).toBe(BOB);
  });

  it('all relations soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$c10a', origin_server_ts: NOW + 10 }),
        child({ event_id: '$c10b', origin_server_ts: NOW + 10 + 1, sender: BOB }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; sender: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c10b', '$c10a']);
    expect(body.chunk[0].sender).toBe(BOB);
  });

  it('all relations soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$c11a', origin_server_ts: NOW + 11 }),
        child({ event_id: '$c11b', origin_server_ts: NOW + 11 + 1, sender: BOB }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; sender: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c11b', '$c11a']);
    expect(body.chunk[0].sender).toBe(BOB);
  });

  it('all relations soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$c12a', origin_server_ts: NOW + 12 }),
        child({ event_id: '$c12b', origin_server_ts: NOW + 12 + 1, sender: BOB }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; sender: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c12b', '$c12a']);
    expect(body.chunk[0].sender).toBe(BOB);
  });

  it('all relations soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$c13a', origin_server_ts: NOW + 13 }),
        child({ event_id: '$c13b', origin_server_ts: NOW + 13 + 1, sender: BOB }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; sender: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c13b', '$c13a']);
    expect(body.chunk[0].sender).toBe(BOB);
  });

  it('all relations soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$c14a', origin_server_ts: NOW + 14 }),
        child({ event_id: '$c14b', origin_server_ts: NOW + 14 + 1, sender: BOB }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; sender: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c14b', '$c14a']);
    expect(body.chunk[0].sender).toBe(BOB);
  });

  it('all relations soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$c15a', origin_server_ts: NOW + 15 }),
        child({ event_id: '$c15b', origin_server_ts: NOW + 15 + 1, sender: BOB }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; sender: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c15b', '$c15a']);
    expect(body.chunk[0].sender).toBe(BOB);
  });

  it('all relations soft-16', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$c16a', origin_server_ts: NOW + 16 }),
        child({ event_id: '$c16b', origin_server_ts: NOW + 16 + 1, sender: BOB }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; sender: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c16b', '$c16a']);
    expect(body.chunk[0].sender).toBe(BOB);
  });

  it('all relations soft-17', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$c17a', origin_server_ts: NOW + 17 }),
        child({ event_id: '$c17b', origin_server_ts: NOW + 17 + 1, sender: BOB }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; sender: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c17b', '$c17a']);
    expect(body.chunk[0].sender).toBe(BOB);
  });

  it('all relations soft-18', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$c18a', origin_server_ts: NOW + 18 }),
        child({ event_id: '$c18b', origin_server_ts: NOW + 18 + 1, sender: BOB }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; sender: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c18b', '$c18a']);
    expect(body.chunk[0].sender).toBe(BOB);
  });

  it('all relations soft-19', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$c19a', origin_server_ts: NOW + 19 }),
        child({ event_id: '$c19b', origin_server_ts: NOW + 19 + 1, sender: BOB }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; sender: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c19b', '$c19a']);
    expect(body.chunk[0].sender).toBe(BOB);
  });

  it('all relations soft-20', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$c20a', origin_server_ts: NOW + 20 }),
        child({ event_id: '$c20b', origin_server_ts: NOW + 20 + 1, sender: BOB }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; sender: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c20b', '$c20a']);
    expect(body.chunk[0].sender).toBe(BOB);
  });

  it('all relations soft-21', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$c21a', origin_server_ts: NOW + 21 }),
        child({ event_id: '$c21b', origin_server_ts: NOW + 21 + 1, sender: BOB }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; sender: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c21b', '$c21a']);
    expect(body.chunk[0].sender).toBe(BOB);
  });

  it('all relations soft-22', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$c22a', origin_server_ts: NOW + 22 }),
        child({ event_id: '$c22b', origin_server_ts: NOW + 22 + 1, sender: BOB }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; sender: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c22b', '$c22a']);
    expect(body.chunk[0].sender).toBe(BOB);
  });

  it('all relations soft-23', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$c23a', origin_server_ts: NOW + 23 }),
        child({ event_id: '$c23b', origin_server_ts: NOW + 23 + 1, sender: BOB }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; sender: string }> };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c23b', '$c23a']);
    expect(body.chunk[0].sender).toBe(BOB);
  });
});


describe('relations leftovers empty chunk soft flood after #175', () => {

  it('empty chunk soft-0', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
  });

  it('empty chunk soft-1', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
  });

  it('empty chunk soft-2', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
  });

  it('empty chunk soft-3', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
  });

  it('empty chunk soft-4', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
  });

  it('empty chunk soft-5', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
  });

  it('empty chunk soft-6', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
  });

  it('empty chunk soft-7', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
  });

  it('empty chunk soft-8', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
  });

  it('empty chunk soft-9', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
  });

  it('empty chunk soft-10', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
  });

  it('empty chunk soft-11', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
  });

  it('empty chunk soft-12', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
  });

  it('empty chunk soft-13', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
  });

  it('empty chunk soft-14', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
  });

  it('empty chunk soft-15', async () => {
    const db = createRelationsDb({ memberships: [joinMember()], events: [] });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
  });
});


describe('relations leftovers GET by relType soft flood after #175', () => {

  it('relType m.annotation soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rt0',
          origin_server_ts: NOW + 0,
          relation_type: 'm.annotation',
          content: JSON.stringify({ 'm.relates_to': { rel_type: 'm.annotation' } }),
        }),
        child({
          event_id: '$other0',
          origin_server_ts: NOW + 0 + 50,
          relation_type: 'm.replace',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rt0']);
  });

  it('relType m.replace soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rt1',
          origin_server_ts: NOW + 1,
          relation_type: 'm.replace',
          content: JSON.stringify({ 'm.relates_to': { rel_type: 'm.replace' } }),
        }),
        child({
          event_id: '$other1',
          origin_server_ts: NOW + 1 + 50,
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, `${base}/m.replace`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rt1']);
  });

  it('relType m.reference soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rt2',
          origin_server_ts: NOW + 2,
          relation_type: 'm.reference',
          content: JSON.stringify({ 'm.relates_to': { rel_type: 'm.reference' } }),
        }),
        child({
          event_id: '$other2',
          origin_server_ts: NOW + 2 + 50,
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, `${base}/m.reference`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rt2']);
  });

  it('relType m.thread soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rt3',
          origin_server_ts: NOW + 3,
          relation_type: 'm.thread',
          content: JSON.stringify({ 'm.relates_to': { rel_type: 'm.thread' } }),
        }),
        child({
          event_id: '$other3',
          origin_server_ts: NOW + 3 + 50,
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, `${base}/m.thread`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rt3']);
  });

  it('relType io.element.relation soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rt4',
          origin_server_ts: NOW + 4,
          relation_type: 'io.element.relation',
          content: JSON.stringify({ 'm.relates_to': { rel_type: 'io.element.relation' } }),
        }),
        child({
          event_id: '$other4',
          origin_server_ts: NOW + 4 + 50,
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, `${base}/io.element.relation`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rt4']);
  });

  it('relType org.matrix.msc3758 soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rt5',
          origin_server_ts: NOW + 5,
          relation_type: 'org.matrix.msc3758',
          content: JSON.stringify({ 'm.relates_to': { rel_type: 'org.matrix.msc3758' } }),
        }),
        child({
          event_id: '$other5',
          origin_server_ts: NOW + 5 + 50,
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, `${base}/org.matrix.msc3758`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rt5']);
  });

  it('relType custom.rel soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rt6',
          origin_server_ts: NOW + 6,
          relation_type: 'custom.rel',
          content: JSON.stringify({ 'm.relates_to': { rel_type: 'custom.rel' } }),
        }),
        child({
          event_id: '$other6',
          origin_server_ts: NOW + 6 + 50,
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, `${base}/custom.rel`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rt6']);
  });

  it('relType x.y.z soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rt7',
          origin_server_ts: NOW + 7,
          relation_type: 'x.y.z',
          content: JSON.stringify({ 'm.relates_to': { rel_type: 'x.y.z' } }),
        }),
        child({
          event_id: '$other7',
          origin_server_ts: NOW + 7 + 50,
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, `${base}/x.y.z`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rt7']);
  });

  it('relType m.annotation soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rt8',
          origin_server_ts: NOW + 8,
          relation_type: 'm.annotation',
          content: JSON.stringify({ 'm.relates_to': { rel_type: 'm.annotation' } }),
        }),
        child({
          event_id: '$other8',
          origin_server_ts: NOW + 8 + 50,
          relation_type: 'm.replace',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rt8']);
  });

  it('relType m.replace soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rt9',
          origin_server_ts: NOW + 9,
          relation_type: 'm.replace',
          content: JSON.stringify({ 'm.relates_to': { rel_type: 'm.replace' } }),
        }),
        child({
          event_id: '$other9',
          origin_server_ts: NOW + 9 + 50,
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, `${base}/m.replace`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rt9']);
  });

  it('relType m.reference soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rt10',
          origin_server_ts: NOW + 10,
          relation_type: 'm.reference',
          content: JSON.stringify({ 'm.relates_to': { rel_type: 'm.reference' } }),
        }),
        child({
          event_id: '$other10',
          origin_server_ts: NOW + 10 + 50,
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, `${base}/m.reference`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rt10']);
  });

  it('relType m.thread soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rt11',
          origin_server_ts: NOW + 11,
          relation_type: 'm.thread',
          content: JSON.stringify({ 'm.relates_to': { rel_type: 'm.thread' } }),
        }),
        child({
          event_id: '$other11',
          origin_server_ts: NOW + 11 + 50,
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, `${base}/m.thread`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rt11']);
  });

  it('relType io.element.relation soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rt12',
          origin_server_ts: NOW + 12,
          relation_type: 'io.element.relation',
          content: JSON.stringify({ 'm.relates_to': { rel_type: 'io.element.relation' } }),
        }),
        child({
          event_id: '$other12',
          origin_server_ts: NOW + 12 + 50,
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, `${base}/io.element.relation`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rt12']);
  });

  it('relType org.matrix.msc3758 soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rt13',
          origin_server_ts: NOW + 13,
          relation_type: 'org.matrix.msc3758',
          content: JSON.stringify({ 'm.relates_to': { rel_type: 'org.matrix.msc3758' } }),
        }),
        child({
          event_id: '$other13',
          origin_server_ts: NOW + 13 + 50,
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, `${base}/org.matrix.msc3758`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rt13']);
  });

  it('relType custom.rel soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rt14',
          origin_server_ts: NOW + 14,
          relation_type: 'custom.rel',
          content: JSON.stringify({ 'm.relates_to': { rel_type: 'custom.rel' } }),
        }),
        child({
          event_id: '$other14',
          origin_server_ts: NOW + 14 + 50,
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, `${base}/custom.rel`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rt14']);
  });

  it('relType x.y.z soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rt15',
          origin_server_ts: NOW + 15,
          relation_type: 'x.y.z',
          content: JSON.stringify({ 'm.relates_to': { rel_type: 'x.y.z' } }),
        }),
        child({
          event_id: '$other15',
          origin_server_ts: NOW + 15 + 50,
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, `${base}/x.y.z`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rt15']);
  });

  it('relType m.annotation soft-16', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rt16',
          origin_server_ts: NOW + 16,
          relation_type: 'm.annotation',
          content: JSON.stringify({ 'm.relates_to': { rel_type: 'm.annotation' } }),
        }),
        child({
          event_id: '$other16',
          origin_server_ts: NOW + 16 + 50,
          relation_type: 'm.replace',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rt16']);
  });

  it('relType m.replace soft-17', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rt17',
          origin_server_ts: NOW + 17,
          relation_type: 'm.replace',
          content: JSON.stringify({ 'm.relates_to': { rel_type: 'm.replace' } }),
        }),
        child({
          event_id: '$other17',
          origin_server_ts: NOW + 17 + 50,
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, `${base}/m.replace`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rt17']);
  });

  it('relType m.reference soft-18', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rt18',
          origin_server_ts: NOW + 18,
          relation_type: 'm.reference',
          content: JSON.stringify({ 'm.relates_to': { rel_type: 'm.reference' } }),
        }),
        child({
          event_id: '$other18',
          origin_server_ts: NOW + 18 + 50,
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, `${base}/m.reference`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rt18']);
  });

  it('relType m.thread soft-19', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rt19',
          origin_server_ts: NOW + 19,
          relation_type: 'm.thread',
          content: JSON.stringify({ 'm.relates_to': { rel_type: 'm.thread' } }),
        }),
        child({
          event_id: '$other19',
          origin_server_ts: NOW + 19 + 50,
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, `${base}/m.thread`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rt19']);
  });

  it('relType io.element.relation soft-20', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rt20',
          origin_server_ts: NOW + 20,
          relation_type: 'io.element.relation',
          content: JSON.stringify({ 'm.relates_to': { rel_type: 'io.element.relation' } }),
        }),
        child({
          event_id: '$other20',
          origin_server_ts: NOW + 20 + 50,
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, `${base}/io.element.relation`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rt20']);
  });

  it('relType org.matrix.msc3758 soft-21', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rt21',
          origin_server_ts: NOW + 21,
          relation_type: 'org.matrix.msc3758',
          content: JSON.stringify({ 'm.relates_to': { rel_type: 'org.matrix.msc3758' } }),
        }),
        child({
          event_id: '$other21',
          origin_server_ts: NOW + 21 + 50,
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, `${base}/org.matrix.msc3758`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rt21']);
  });

  it('relType custom.rel soft-22', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rt22',
          origin_server_ts: NOW + 22,
          relation_type: 'custom.rel',
          content: JSON.stringify({ 'm.relates_to': { rel_type: 'custom.rel' } }),
        }),
        child({
          event_id: '$other22',
          origin_server_ts: NOW + 22 + 50,
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, `${base}/custom.rel`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rt22']);
  });

  it('relType x.y.z soft-23', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$rt23',
          origin_server_ts: NOW + 23,
          relation_type: 'x.y.z',
          content: JSON.stringify({ 'm.relates_to': { rel_type: 'x.y.z' } }),
        }),
        child({
          event_id: '$other23',
          origin_server_ts: NOW + 23 + 50,
          relation_type: 'm.annotation',
        }),
      ],
    });
    const res = await request(db, `${base}/x.y.z`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rt23']);
  });
});


describe('relations leftovers GET by relType+eventType soft flood after #175', () => {

  it('typed m.annotation/m.reaction soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$typed0',
          origin_server_ts: NOW + 0,
          relation_type: 'm.annotation',
          event_type: 'm.reaction',
        }),
        child({
          event_id: '$wrong-type0',
          origin_server_ts: NOW + 0 + 10,
          relation_type: 'm.annotation',
          event_type: 'm.other',
        }),
        child({
          event_id: '$wrong-rel0',
          origin_server_ts: NOW + 0 + 20,
          relation_type: 'm.other',
          event_type: 'm.reaction',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$typed0', type: 'm.reaction' });
  });

  it('typed m.replace/m.room.message soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$typed1',
          origin_server_ts: NOW + 1,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
        child({
          event_id: '$wrong-type1',
          origin_server_ts: NOW + 1 + 10,
          relation_type: 'm.replace',
          event_type: 'm.other',
        }),
        child({
          event_id: '$wrong-rel1',
          origin_server_ts: NOW + 1 + 20,
          relation_type: 'm.other',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, `${base}/m.replace/m.room.message`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$typed1', type: 'm.room.message' });
  });

  it('typed m.reference/m.room.message soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$typed2',
          origin_server_ts: NOW + 2,
          relation_type: 'm.reference',
          event_type: 'm.room.message',
        }),
        child({
          event_id: '$wrong-type2',
          origin_server_ts: NOW + 2 + 10,
          relation_type: 'm.reference',
          event_type: 'm.other',
        }),
        child({
          event_id: '$wrong-rel2',
          origin_server_ts: NOW + 2 + 20,
          relation_type: 'm.other',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, `${base}/m.reference/m.room.message`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$typed2', type: 'm.room.message' });
  });

  it('typed m.thread/m.room.message soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$typed3',
          origin_server_ts: NOW + 3,
          relation_type: 'm.thread',
          event_type: 'm.room.message',
        }),
        child({
          event_id: '$wrong-type3',
          origin_server_ts: NOW + 3 + 10,
          relation_type: 'm.thread',
          event_type: 'm.other',
        }),
        child({
          event_id: '$wrong-rel3',
          origin_server_ts: NOW + 3 + 20,
          relation_type: 'm.other',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, `${base}/m.thread/m.room.message`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$typed3', type: 'm.room.message' });
  });

  it('typed m.annotation/m.sticker soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$typed4',
          origin_server_ts: NOW + 4,
          relation_type: 'm.annotation',
          event_type: 'm.sticker',
        }),
        child({
          event_id: '$wrong-type4',
          origin_server_ts: NOW + 4 + 10,
          relation_type: 'm.annotation',
          event_type: 'm.other',
        }),
        child({
          event_id: '$wrong-rel4',
          origin_server_ts: NOW + 4 + 20,
          relation_type: 'm.other',
          event_type: 'm.sticker',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation/m.sticker`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$typed4', type: 'm.sticker' });
  });

  it('typed m.replace/m.room.encrypted soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$typed5',
          origin_server_ts: NOW + 5,
          relation_type: 'm.replace',
          event_type: 'm.room.encrypted',
        }),
        child({
          event_id: '$wrong-type5',
          origin_server_ts: NOW + 5 + 10,
          relation_type: 'm.replace',
          event_type: 'm.other',
        }),
        child({
          event_id: '$wrong-rel5',
          origin_server_ts: NOW + 5 + 20,
          relation_type: 'm.other',
          event_type: 'm.room.encrypted',
        }),
      ],
    });
    const res = await request(db, `${base}/m.replace/m.room.encrypted`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$typed5', type: 'm.room.encrypted' });
  });

  it('typed m.reference/m.room.encrypted soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$typed6',
          origin_server_ts: NOW + 6,
          relation_type: 'm.reference',
          event_type: 'm.room.encrypted',
        }),
        child({
          event_id: '$wrong-type6',
          origin_server_ts: NOW + 6 + 10,
          relation_type: 'm.reference',
          event_type: 'm.other',
        }),
        child({
          event_id: '$wrong-rel6',
          origin_server_ts: NOW + 6 + 20,
          relation_type: 'm.other',
          event_type: 'm.room.encrypted',
        }),
      ],
    });
    const res = await request(db, `${base}/m.reference/m.room.encrypted`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$typed6', type: 'm.room.encrypted' });
  });

  it('typed m.thread/m.room.encrypted soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$typed7',
          origin_server_ts: NOW + 7,
          relation_type: 'm.thread',
          event_type: 'm.room.encrypted',
        }),
        child({
          event_id: '$wrong-type7',
          origin_server_ts: NOW + 7 + 10,
          relation_type: 'm.thread',
          event_type: 'm.other',
        }),
        child({
          event_id: '$wrong-rel7',
          origin_server_ts: NOW + 7 + 20,
          relation_type: 'm.other',
          event_type: 'm.room.encrypted',
        }),
      ],
    });
    const res = await request(db, `${base}/m.thread/m.room.encrypted`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$typed7', type: 'm.room.encrypted' });
  });

  it('typed m.annotation/m.reaction soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$typed8',
          origin_server_ts: NOW + 8,
          relation_type: 'm.annotation',
          event_type: 'm.reaction',
        }),
        child({
          event_id: '$wrong-type8',
          origin_server_ts: NOW + 8 + 10,
          relation_type: 'm.annotation',
          event_type: 'm.other',
        }),
        child({
          event_id: '$wrong-rel8',
          origin_server_ts: NOW + 8 + 20,
          relation_type: 'm.other',
          event_type: 'm.reaction',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$typed8', type: 'm.reaction' });
  });

  it('typed m.replace/m.room.message soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$typed9',
          origin_server_ts: NOW + 9,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
        child({
          event_id: '$wrong-type9',
          origin_server_ts: NOW + 9 + 10,
          relation_type: 'm.replace',
          event_type: 'm.other',
        }),
        child({
          event_id: '$wrong-rel9',
          origin_server_ts: NOW + 9 + 20,
          relation_type: 'm.other',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, `${base}/m.replace/m.room.message`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$typed9', type: 'm.room.message' });
  });

  it('typed m.reference/m.room.message soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$typed10',
          origin_server_ts: NOW + 10,
          relation_type: 'm.reference',
          event_type: 'm.room.message',
        }),
        child({
          event_id: '$wrong-type10',
          origin_server_ts: NOW + 10 + 10,
          relation_type: 'm.reference',
          event_type: 'm.other',
        }),
        child({
          event_id: '$wrong-rel10',
          origin_server_ts: NOW + 10 + 20,
          relation_type: 'm.other',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, `${base}/m.reference/m.room.message`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$typed10', type: 'm.room.message' });
  });

  it('typed m.thread/m.room.message soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$typed11',
          origin_server_ts: NOW + 11,
          relation_type: 'm.thread',
          event_type: 'm.room.message',
        }),
        child({
          event_id: '$wrong-type11',
          origin_server_ts: NOW + 11 + 10,
          relation_type: 'm.thread',
          event_type: 'm.other',
        }),
        child({
          event_id: '$wrong-rel11',
          origin_server_ts: NOW + 11 + 20,
          relation_type: 'm.other',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, `${base}/m.thread/m.room.message`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$typed11', type: 'm.room.message' });
  });

  it('typed m.annotation/m.sticker soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$typed12',
          origin_server_ts: NOW + 12,
          relation_type: 'm.annotation',
          event_type: 'm.sticker',
        }),
        child({
          event_id: '$wrong-type12',
          origin_server_ts: NOW + 12 + 10,
          relation_type: 'm.annotation',
          event_type: 'm.other',
        }),
        child({
          event_id: '$wrong-rel12',
          origin_server_ts: NOW + 12 + 20,
          relation_type: 'm.other',
          event_type: 'm.sticker',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation/m.sticker`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$typed12', type: 'm.sticker' });
  });

  it('typed m.replace/m.room.encrypted soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$typed13',
          origin_server_ts: NOW + 13,
          relation_type: 'm.replace',
          event_type: 'm.room.encrypted',
        }),
        child({
          event_id: '$wrong-type13',
          origin_server_ts: NOW + 13 + 10,
          relation_type: 'm.replace',
          event_type: 'm.other',
        }),
        child({
          event_id: '$wrong-rel13',
          origin_server_ts: NOW + 13 + 20,
          relation_type: 'm.other',
          event_type: 'm.room.encrypted',
        }),
      ],
    });
    const res = await request(db, `${base}/m.replace/m.room.encrypted`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$typed13', type: 'm.room.encrypted' });
  });

  it('typed m.reference/m.room.encrypted soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$typed14',
          origin_server_ts: NOW + 14,
          relation_type: 'm.reference',
          event_type: 'm.room.encrypted',
        }),
        child({
          event_id: '$wrong-type14',
          origin_server_ts: NOW + 14 + 10,
          relation_type: 'm.reference',
          event_type: 'm.other',
        }),
        child({
          event_id: '$wrong-rel14',
          origin_server_ts: NOW + 14 + 20,
          relation_type: 'm.other',
          event_type: 'm.room.encrypted',
        }),
      ],
    });
    const res = await request(db, `${base}/m.reference/m.room.encrypted`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$typed14', type: 'm.room.encrypted' });
  });

  it('typed m.thread/m.room.encrypted soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$typed15',
          origin_server_ts: NOW + 15,
          relation_type: 'm.thread',
          event_type: 'm.room.encrypted',
        }),
        child({
          event_id: '$wrong-type15',
          origin_server_ts: NOW + 15 + 10,
          relation_type: 'm.thread',
          event_type: 'm.other',
        }),
        child({
          event_id: '$wrong-rel15',
          origin_server_ts: NOW + 15 + 20,
          relation_type: 'm.other',
          event_type: 'm.room.encrypted',
        }),
      ],
    });
    const res = await request(db, `${base}/m.thread/m.room.encrypted`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$typed15', type: 'm.room.encrypted' });
  });

  it('typed m.annotation/m.reaction soft-16', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$typed16',
          origin_server_ts: NOW + 16,
          relation_type: 'm.annotation',
          event_type: 'm.reaction',
        }),
        child({
          event_id: '$wrong-type16',
          origin_server_ts: NOW + 16 + 10,
          relation_type: 'm.annotation',
          event_type: 'm.other',
        }),
        child({
          event_id: '$wrong-rel16',
          origin_server_ts: NOW + 16 + 20,
          relation_type: 'm.other',
          event_type: 'm.reaction',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$typed16', type: 'm.reaction' });
  });

  it('typed m.replace/m.room.message soft-17', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$typed17',
          origin_server_ts: NOW + 17,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
        child({
          event_id: '$wrong-type17',
          origin_server_ts: NOW + 17 + 10,
          relation_type: 'm.replace',
          event_type: 'm.other',
        }),
        child({
          event_id: '$wrong-rel17',
          origin_server_ts: NOW + 17 + 20,
          relation_type: 'm.other',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, `${base}/m.replace/m.room.message`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$typed17', type: 'm.room.message' });
  });

  it('typed m.reference/m.room.message soft-18', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$typed18',
          origin_server_ts: NOW + 18,
          relation_type: 'm.reference',
          event_type: 'm.room.message',
        }),
        child({
          event_id: '$wrong-type18',
          origin_server_ts: NOW + 18 + 10,
          relation_type: 'm.reference',
          event_type: 'm.other',
        }),
        child({
          event_id: '$wrong-rel18',
          origin_server_ts: NOW + 18 + 20,
          relation_type: 'm.other',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, `${base}/m.reference/m.room.message`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$typed18', type: 'm.room.message' });
  });

  it('typed m.thread/m.room.message soft-19', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$typed19',
          origin_server_ts: NOW + 19,
          relation_type: 'm.thread',
          event_type: 'm.room.message',
        }),
        child({
          event_id: '$wrong-type19',
          origin_server_ts: NOW + 19 + 10,
          relation_type: 'm.thread',
          event_type: 'm.other',
        }),
        child({
          event_id: '$wrong-rel19',
          origin_server_ts: NOW + 19 + 20,
          relation_type: 'm.other',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, `${base}/m.thread/m.room.message`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$typed19', type: 'm.room.message' });
  });

  it('typed m.annotation/m.sticker soft-20', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$typed20',
          origin_server_ts: NOW + 20,
          relation_type: 'm.annotation',
          event_type: 'm.sticker',
        }),
        child({
          event_id: '$wrong-type20',
          origin_server_ts: NOW + 20 + 10,
          relation_type: 'm.annotation',
          event_type: 'm.other',
        }),
        child({
          event_id: '$wrong-rel20',
          origin_server_ts: NOW + 20 + 20,
          relation_type: 'm.other',
          event_type: 'm.sticker',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation/m.sticker`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$typed20', type: 'm.sticker' });
  });

  it('typed m.replace/m.room.encrypted soft-21', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$typed21',
          origin_server_ts: NOW + 21,
          relation_type: 'm.replace',
          event_type: 'm.room.encrypted',
        }),
        child({
          event_id: '$wrong-type21',
          origin_server_ts: NOW + 21 + 10,
          relation_type: 'm.replace',
          event_type: 'm.other',
        }),
        child({
          event_id: '$wrong-rel21',
          origin_server_ts: NOW + 21 + 20,
          relation_type: 'm.other',
          event_type: 'm.room.encrypted',
        }),
      ],
    });
    const res = await request(db, `${base}/m.replace/m.room.encrypted`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$typed21', type: 'm.room.encrypted' });
  });

  it('typed m.reference/m.room.encrypted soft-22', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$typed22',
          origin_server_ts: NOW + 22,
          relation_type: 'm.reference',
          event_type: 'm.room.encrypted',
        }),
        child({
          event_id: '$wrong-type22',
          origin_server_ts: NOW + 22 + 10,
          relation_type: 'm.reference',
          event_type: 'm.other',
        }),
        child({
          event_id: '$wrong-rel22',
          origin_server_ts: NOW + 22 + 20,
          relation_type: 'm.other',
          event_type: 'm.room.encrypted',
        }),
      ],
    });
    const res = await request(db, `${base}/m.reference/m.room.encrypted`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$typed22', type: 'm.room.encrypted' });
  });

  it('typed m.thread/m.room.encrypted soft-23', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$typed23',
          origin_server_ts: NOW + 23,
          relation_type: 'm.thread',
          event_type: 'm.room.encrypted',
        }),
        child({
          event_id: '$wrong-type23',
          origin_server_ts: NOW + 23 + 10,
          relation_type: 'm.thread',
          event_type: 'm.other',
        }),
        child({
          event_id: '$wrong-rel23',
          origin_server_ts: NOW + 23 + 20,
          relation_type: 'm.other',
          event_type: 'm.room.encrypted',
        }),
      ],
    });
    const res = await request(db, `${base}/m.thread/m.room.encrypted`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$typed23', type: 'm.room.encrypted' });
  });
});


describe('relations leftovers GET threads soft flood after #175', () => {

  it('threads list soft-0', async () => {
    const root = threadRoot({ event_id: '$root0', origin_server_ts: NOW + 0 });
    const reply = threadReply('$root0', {
      event_id: '$reply0',
      origin_server_ts: NOW + 0 + 5,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [root, reply],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$root0']);
  });

  it('threads list soft-1', async () => {
    const root = threadRoot({ event_id: '$root1', origin_server_ts: NOW + 1 });
    const reply = threadReply('$root1', {
      event_id: '$reply1',
      origin_server_ts: NOW + 1 + 5,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [root, reply],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$root1']);
  });

  it('threads list soft-2', async () => {
    const root = threadRoot({ event_id: '$root2', origin_server_ts: NOW + 2 });
    const reply = threadReply('$root2', {
      event_id: '$reply2',
      origin_server_ts: NOW + 2 + 5,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [root, reply],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$root2']);
  });

  it('threads list soft-3', async () => {
    const root = threadRoot({ event_id: '$root3', origin_server_ts: NOW + 3 });
    const reply = threadReply('$root3', {
      event_id: '$reply3',
      origin_server_ts: NOW + 3 + 5,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [root, reply],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$root3']);
  });

  it('threads list soft-4', async () => {
    const root = threadRoot({ event_id: '$root4', origin_server_ts: NOW + 4 });
    const reply = threadReply('$root4', {
      event_id: '$reply4',
      origin_server_ts: NOW + 4 + 5,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [root, reply],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$root4']);
  });

  it('threads list soft-5', async () => {
    const root = threadRoot({ event_id: '$root5', origin_server_ts: NOW + 5 });
    const reply = threadReply('$root5', {
      event_id: '$reply5',
      origin_server_ts: NOW + 5 + 5,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [root, reply],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$root5']);
  });

  it('threads list soft-6', async () => {
    const root = threadRoot({ event_id: '$root6', origin_server_ts: NOW + 6 });
    const reply = threadReply('$root6', {
      event_id: '$reply6',
      origin_server_ts: NOW + 6 + 5,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [root, reply],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$root6']);
  });

  it('threads list soft-7', async () => {
    const root = threadRoot({ event_id: '$root7', origin_server_ts: NOW + 7 });
    const reply = threadReply('$root7', {
      event_id: '$reply7',
      origin_server_ts: NOW + 7 + 5,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [root, reply],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$root7']);
  });

  it('threads list soft-8', async () => {
    const root = threadRoot({ event_id: '$root8', origin_server_ts: NOW + 8 });
    const reply = threadReply('$root8', {
      event_id: '$reply8',
      origin_server_ts: NOW + 8 + 5,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [root, reply],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$root8']);
  });

  it('threads list soft-9', async () => {
    const root = threadRoot({ event_id: '$root9', origin_server_ts: NOW + 9 });
    const reply = threadReply('$root9', {
      event_id: '$reply9',
      origin_server_ts: NOW + 9 + 5,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [root, reply],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$root9']);
  });

  it('threads list soft-10', async () => {
    const root = threadRoot({ event_id: '$root10', origin_server_ts: NOW + 10 });
    const reply = threadReply('$root10', {
      event_id: '$reply10',
      origin_server_ts: NOW + 10 + 5,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [root, reply],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$root10']);
  });

  it('threads list soft-11', async () => {
    const root = threadRoot({ event_id: '$root11', origin_server_ts: NOW + 11 });
    const reply = threadReply('$root11', {
      event_id: '$reply11',
      origin_server_ts: NOW + 11 + 5,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [root, reply],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$root11']);
  });

  it('threads list soft-12', async () => {
    const root = threadRoot({ event_id: '$root12', origin_server_ts: NOW + 12 });
    const reply = threadReply('$root12', {
      event_id: '$reply12',
      origin_server_ts: NOW + 12 + 5,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [root, reply],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$root12']);
  });

  it('threads list soft-13', async () => {
    const root = threadRoot({ event_id: '$root13', origin_server_ts: NOW + 13 });
    const reply = threadReply('$root13', {
      event_id: '$reply13',
      origin_server_ts: NOW + 13 + 5,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [root, reply],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$root13']);
  });

  it('threads list soft-14', async () => {
    const root = threadRoot({ event_id: '$root14', origin_server_ts: NOW + 14 });
    const reply = threadReply('$root14', {
      event_id: '$reply14',
      origin_server_ts: NOW + 14 + 5,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [root, reply],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$root14']);
  });

  it('threads list soft-15', async () => {
    const root = threadRoot({ event_id: '$root15', origin_server_ts: NOW + 15 });
    const reply = threadReply('$root15', {
      event_id: '$reply15',
      origin_server_ts: NOW + 15 + 5,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [root, reply],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$root15']);
  });

  it('threads list soft-16', async () => {
    const root = threadRoot({ event_id: '$root16', origin_server_ts: NOW + 16 });
    const reply = threadReply('$root16', {
      event_id: '$reply16',
      origin_server_ts: NOW + 16 + 5,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [root, reply],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$root16']);
  });

  it('threads list soft-17', async () => {
    const root = threadRoot({ event_id: '$root17', origin_server_ts: NOW + 17 });
    const reply = threadReply('$root17', {
      event_id: '$reply17',
      origin_server_ts: NOW + 17 + 5,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [root, reply],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$root17']);
  });

  it('threads list soft-18', async () => {
    const root = threadRoot({ event_id: '$root18', origin_server_ts: NOW + 18 });
    const reply = threadReply('$root18', {
      event_id: '$reply18',
      origin_server_ts: NOW + 18 + 5,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [root, reply],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$root18']);
  });

  it('threads list soft-19', async () => {
    const root = threadRoot({ event_id: '$root19', origin_server_ts: NOW + 19 });
    const reply = threadReply('$root19', {
      event_id: '$reply19',
      origin_server_ts: NOW + 19 + 5,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [root, reply],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$root19']);
  });
});


describe('relations leftovers threads participated soft flood after #175', () => {

  it('threads participated soft-0', async () => {
    const mine = threadRoot({ event_id: '$mine0', origin_server_ts: NOW + 0 });
    const mineReply = threadReply('$mine0', {
      event_id: '$mine-r0',
      origin_server_ts: NOW + 0 + 1,
      sender: BOB,
    });
    const other = threadRoot({
      event_id: '$other-root0',
      origin_server_ts: NOW + 0 + 2,
      sender: BOB,
    });
    const otherReply = threadReply('$other-root0', {
      event_id: '$other-r0',
      origin_server_ts: NOW + 0 + 3,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [mine, mineReply, other, otherReply],
    });
    const res = await request(db, `${threadsBase}?include=participated`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$mine0']);
  });

  it('threads participated soft-1', async () => {
    const mine = threadRoot({ event_id: '$mine1', origin_server_ts: NOW + 1 });
    const mineReply = threadReply('$mine1', {
      event_id: '$mine-r1',
      origin_server_ts: NOW + 1 + 1,
      sender: BOB,
    });
    const other = threadRoot({
      event_id: '$other-root1',
      origin_server_ts: NOW + 1 + 2,
      sender: BOB,
    });
    const otherReply = threadReply('$other-root1', {
      event_id: '$other-r1',
      origin_server_ts: NOW + 1 + 3,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [mine, mineReply, other, otherReply],
    });
    const res = await request(db, `${threadsBase}?include=participated`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$mine1']);
  });

  it('threads participated soft-2', async () => {
    const mine = threadRoot({ event_id: '$mine2', origin_server_ts: NOW + 2 });
    const mineReply = threadReply('$mine2', {
      event_id: '$mine-r2',
      origin_server_ts: NOW + 2 + 1,
      sender: BOB,
    });
    const other = threadRoot({
      event_id: '$other-root2',
      origin_server_ts: NOW + 2 + 2,
      sender: BOB,
    });
    const otherReply = threadReply('$other-root2', {
      event_id: '$other-r2',
      origin_server_ts: NOW + 2 + 3,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [mine, mineReply, other, otherReply],
    });
    const res = await request(db, `${threadsBase}?include=participated`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$mine2']);
  });

  it('threads participated soft-3', async () => {
    const mine = threadRoot({ event_id: '$mine3', origin_server_ts: NOW + 3 });
    const mineReply = threadReply('$mine3', {
      event_id: '$mine-r3',
      origin_server_ts: NOW + 3 + 1,
      sender: BOB,
    });
    const other = threadRoot({
      event_id: '$other-root3',
      origin_server_ts: NOW + 3 + 2,
      sender: BOB,
    });
    const otherReply = threadReply('$other-root3', {
      event_id: '$other-r3',
      origin_server_ts: NOW + 3 + 3,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [mine, mineReply, other, otherReply],
    });
    const res = await request(db, `${threadsBase}?include=participated`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$mine3']);
  });

  it('threads participated soft-4', async () => {
    const mine = threadRoot({ event_id: '$mine4', origin_server_ts: NOW + 4 });
    const mineReply = threadReply('$mine4', {
      event_id: '$mine-r4',
      origin_server_ts: NOW + 4 + 1,
      sender: BOB,
    });
    const other = threadRoot({
      event_id: '$other-root4',
      origin_server_ts: NOW + 4 + 2,
      sender: BOB,
    });
    const otherReply = threadReply('$other-root4', {
      event_id: '$other-r4',
      origin_server_ts: NOW + 4 + 3,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [mine, mineReply, other, otherReply],
    });
    const res = await request(db, `${threadsBase}?include=participated`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$mine4']);
  });

  it('threads participated soft-5', async () => {
    const mine = threadRoot({ event_id: '$mine5', origin_server_ts: NOW + 5 });
    const mineReply = threadReply('$mine5', {
      event_id: '$mine-r5',
      origin_server_ts: NOW + 5 + 1,
      sender: BOB,
    });
    const other = threadRoot({
      event_id: '$other-root5',
      origin_server_ts: NOW + 5 + 2,
      sender: BOB,
    });
    const otherReply = threadReply('$other-root5', {
      event_id: '$other-r5',
      origin_server_ts: NOW + 5 + 3,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [mine, mineReply, other, otherReply],
    });
    const res = await request(db, `${threadsBase}?include=participated`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$mine5']);
  });

  it('threads participated soft-6', async () => {
    const mine = threadRoot({ event_id: '$mine6', origin_server_ts: NOW + 6 });
    const mineReply = threadReply('$mine6', {
      event_id: '$mine-r6',
      origin_server_ts: NOW + 6 + 1,
      sender: BOB,
    });
    const other = threadRoot({
      event_id: '$other-root6',
      origin_server_ts: NOW + 6 + 2,
      sender: BOB,
    });
    const otherReply = threadReply('$other-root6', {
      event_id: '$other-r6',
      origin_server_ts: NOW + 6 + 3,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [mine, mineReply, other, otherReply],
    });
    const res = await request(db, `${threadsBase}?include=participated`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$mine6']);
  });

  it('threads participated soft-7', async () => {
    const mine = threadRoot({ event_id: '$mine7', origin_server_ts: NOW + 7 });
    const mineReply = threadReply('$mine7', {
      event_id: '$mine-r7',
      origin_server_ts: NOW + 7 + 1,
      sender: BOB,
    });
    const other = threadRoot({
      event_id: '$other-root7',
      origin_server_ts: NOW + 7 + 2,
      sender: BOB,
    });
    const otherReply = threadReply('$other-root7', {
      event_id: '$other-r7',
      origin_server_ts: NOW + 7 + 3,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [mine, mineReply, other, otherReply],
    });
    const res = await request(db, `${threadsBase}?include=participated`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$mine7']);
  });

  it('threads participated soft-8', async () => {
    const mine = threadRoot({ event_id: '$mine8', origin_server_ts: NOW + 8 });
    const mineReply = threadReply('$mine8', {
      event_id: '$mine-r8',
      origin_server_ts: NOW + 8 + 1,
      sender: BOB,
    });
    const other = threadRoot({
      event_id: '$other-root8',
      origin_server_ts: NOW + 8 + 2,
      sender: BOB,
    });
    const otherReply = threadReply('$other-root8', {
      event_id: '$other-r8',
      origin_server_ts: NOW + 8 + 3,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [mine, mineReply, other, otherReply],
    });
    const res = await request(db, `${threadsBase}?include=participated`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$mine8']);
  });

  it('threads participated soft-9', async () => {
    const mine = threadRoot({ event_id: '$mine9', origin_server_ts: NOW + 9 });
    const mineReply = threadReply('$mine9', {
      event_id: '$mine-r9',
      origin_server_ts: NOW + 9 + 1,
      sender: BOB,
    });
    const other = threadRoot({
      event_id: '$other-root9',
      origin_server_ts: NOW + 9 + 2,
      sender: BOB,
    });
    const otherReply = threadReply('$other-root9', {
      event_id: '$other-r9',
      origin_server_ts: NOW + 9 + 3,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [mine, mineReply, other, otherReply],
    });
    const res = await request(db, `${threadsBase}?include=participated`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$mine9']);
  });

  it('threads participated soft-10', async () => {
    const mine = threadRoot({ event_id: '$mine10', origin_server_ts: NOW + 10 });
    const mineReply = threadReply('$mine10', {
      event_id: '$mine-r10',
      origin_server_ts: NOW + 10 + 1,
      sender: BOB,
    });
    const other = threadRoot({
      event_id: '$other-root10',
      origin_server_ts: NOW + 10 + 2,
      sender: BOB,
    });
    const otherReply = threadReply('$other-root10', {
      event_id: '$other-r10',
      origin_server_ts: NOW + 10 + 3,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [mine, mineReply, other, otherReply],
    });
    const res = await request(db, `${threadsBase}?include=participated`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$mine10']);
  });

  it('threads participated soft-11', async () => {
    const mine = threadRoot({ event_id: '$mine11', origin_server_ts: NOW + 11 });
    const mineReply = threadReply('$mine11', {
      event_id: '$mine-r11',
      origin_server_ts: NOW + 11 + 1,
      sender: BOB,
    });
    const other = threadRoot({
      event_id: '$other-root11',
      origin_server_ts: NOW + 11 + 2,
      sender: BOB,
    });
    const otherReply = threadReply('$other-root11', {
      event_id: '$other-r11',
      origin_server_ts: NOW + 11 + 3,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [mine, mineReply, other, otherReply],
    });
    const res = await request(db, `${threadsBase}?include=participated`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$mine11']);
  });

  it('threads participated soft-12', async () => {
    const mine = threadRoot({ event_id: '$mine12', origin_server_ts: NOW + 12 });
    const mineReply = threadReply('$mine12', {
      event_id: '$mine-r12',
      origin_server_ts: NOW + 12 + 1,
      sender: BOB,
    });
    const other = threadRoot({
      event_id: '$other-root12',
      origin_server_ts: NOW + 12 + 2,
      sender: BOB,
    });
    const otherReply = threadReply('$other-root12', {
      event_id: '$other-r12',
      origin_server_ts: NOW + 12 + 3,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [mine, mineReply, other, otherReply],
    });
    const res = await request(db, `${threadsBase}?include=participated`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$mine12']);
  });

  it('threads participated soft-13', async () => {
    const mine = threadRoot({ event_id: '$mine13', origin_server_ts: NOW + 13 });
    const mineReply = threadReply('$mine13', {
      event_id: '$mine-r13',
      origin_server_ts: NOW + 13 + 1,
      sender: BOB,
    });
    const other = threadRoot({
      event_id: '$other-root13',
      origin_server_ts: NOW + 13 + 2,
      sender: BOB,
    });
    const otherReply = threadReply('$other-root13', {
      event_id: '$other-r13',
      origin_server_ts: NOW + 13 + 3,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [mine, mineReply, other, otherReply],
    });
    const res = await request(db, `${threadsBase}?include=participated`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$mine13']);
  });

  it('threads participated soft-14', async () => {
    const mine = threadRoot({ event_id: '$mine14', origin_server_ts: NOW + 14 });
    const mineReply = threadReply('$mine14', {
      event_id: '$mine-r14',
      origin_server_ts: NOW + 14 + 1,
      sender: BOB,
    });
    const other = threadRoot({
      event_id: '$other-root14',
      origin_server_ts: NOW + 14 + 2,
      sender: BOB,
    });
    const otherReply = threadReply('$other-root14', {
      event_id: '$other-r14',
      origin_server_ts: NOW + 14 + 3,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [mine, mineReply, other, otherReply],
    });
    const res = await request(db, `${threadsBase}?include=participated`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$mine14']);
  });

  it('threads participated soft-15', async () => {
    const mine = threadRoot({ event_id: '$mine15', origin_server_ts: NOW + 15 });
    const mineReply = threadReply('$mine15', {
      event_id: '$mine-r15',
      origin_server_ts: NOW + 15 + 1,
      sender: BOB,
    });
    const other = threadRoot({
      event_id: '$other-root15',
      origin_server_ts: NOW + 15 + 2,
      sender: BOB,
    });
    const otherReply = threadReply('$other-root15', {
      event_id: '$other-r15',
      origin_server_ts: NOW + 15 + 3,
      sender: BOB,
    });
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [mine, mineReply, other, otherReply],
    });
    const res = await request(db, `${threadsBase}?include=participated`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$mine15']);
  });
});


describe('relations leftovers pagination soft flood after #175', () => {

  it('pagination dir=b from soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p0a', origin_server_ts: 100 + 0 }),
        child({ event_id: '$p0b', origin_server_ts: 200 + 0 }),
        child({ event_id: '$p0c', origin_server_ts: 300 + 0 }),
        child({ event_id: '$p0d', origin_server_ts: 400 + 0 }),
      ],
    });
    const from = 350 + 0;
    const res = await request(db, `${base}?from=${from}&dir=b&limit=2`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$p0c', '$p0b']);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('pagination dir=b from soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p1a', origin_server_ts: 100 + 1 }),
        child({ event_id: '$p1b', origin_server_ts: 200 + 1 }),
        child({ event_id: '$p1c', origin_server_ts: 300 + 1 }),
        child({ event_id: '$p1d', origin_server_ts: 400 + 1 }),
      ],
    });
    const from = 350 + 1;
    const res = await request(db, `${base}?from=${from}&dir=b&limit=2`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$p1c', '$p1b']);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('pagination dir=b from soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p2a', origin_server_ts: 100 + 2 }),
        child({ event_id: '$p2b', origin_server_ts: 200 + 2 }),
        child({ event_id: '$p2c', origin_server_ts: 300 + 2 }),
        child({ event_id: '$p2d', origin_server_ts: 400 + 2 }),
      ],
    });
    const from = 350 + 2;
    const res = await request(db, `${base}?from=${from}&dir=b&limit=2`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$p2c', '$p2b']);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('pagination dir=b from soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p3a', origin_server_ts: 100 + 3 }),
        child({ event_id: '$p3b', origin_server_ts: 200 + 3 }),
        child({ event_id: '$p3c', origin_server_ts: 300 + 3 }),
        child({ event_id: '$p3d', origin_server_ts: 400 + 3 }),
      ],
    });
    const from = 350 + 3;
    const res = await request(db, `${base}?from=${from}&dir=b&limit=2`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$p3c', '$p3b']);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('pagination dir=b from soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p4a', origin_server_ts: 100 + 4 }),
        child({ event_id: '$p4b', origin_server_ts: 200 + 4 }),
        child({ event_id: '$p4c', origin_server_ts: 300 + 4 }),
        child({ event_id: '$p4d', origin_server_ts: 400 + 4 }),
      ],
    });
    const from = 350 + 4;
    const res = await request(db, `${base}?from=${from}&dir=b&limit=2`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$p4c', '$p4b']);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('pagination dir=b from soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p5a', origin_server_ts: 100 + 5 }),
        child({ event_id: '$p5b', origin_server_ts: 200 + 5 }),
        child({ event_id: '$p5c', origin_server_ts: 300 + 5 }),
        child({ event_id: '$p5d', origin_server_ts: 400 + 5 }),
      ],
    });
    const from = 350 + 5;
    const res = await request(db, `${base}?from=${from}&dir=b&limit=2`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$p5c', '$p5b']);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('pagination dir=b from soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p6a', origin_server_ts: 100 + 6 }),
        child({ event_id: '$p6b', origin_server_ts: 200 + 6 }),
        child({ event_id: '$p6c', origin_server_ts: 300 + 6 }),
        child({ event_id: '$p6d', origin_server_ts: 400 + 6 }),
      ],
    });
    const from = 350 + 6;
    const res = await request(db, `${base}?from=${from}&dir=b&limit=2`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$p6c', '$p6b']);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('pagination dir=b from soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p7a', origin_server_ts: 100 + 7 }),
        child({ event_id: '$p7b', origin_server_ts: 200 + 7 }),
        child({ event_id: '$p7c', origin_server_ts: 300 + 7 }),
        child({ event_id: '$p7d', origin_server_ts: 400 + 7 }),
      ],
    });
    const from = 350 + 7;
    const res = await request(db, `${base}?from=${from}&dir=b&limit=2`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$p7c', '$p7b']);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('pagination dir=b from soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p8a', origin_server_ts: 100 + 8 }),
        child({ event_id: '$p8b', origin_server_ts: 200 + 8 }),
        child({ event_id: '$p8c', origin_server_ts: 300 + 8 }),
        child({ event_id: '$p8d', origin_server_ts: 400 + 8 }),
      ],
    });
    const from = 350 + 8;
    const res = await request(db, `${base}?from=${from}&dir=b&limit=2`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$p8c', '$p8b']);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('pagination dir=b from soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p9a', origin_server_ts: 100 + 9 }),
        child({ event_id: '$p9b', origin_server_ts: 200 + 9 }),
        child({ event_id: '$p9c', origin_server_ts: 300 + 9 }),
        child({ event_id: '$p9d', origin_server_ts: 400 + 9 }),
      ],
    });
    const from = 350 + 9;
    const res = await request(db, `${base}?from=${from}&dir=b&limit=2`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$p9c', '$p9b']);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('pagination dir=b from soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p10a', origin_server_ts: 100 + 10 }),
        child({ event_id: '$p10b', origin_server_ts: 200 + 10 }),
        child({ event_id: '$p10c', origin_server_ts: 300 + 10 }),
        child({ event_id: '$p10d', origin_server_ts: 400 + 10 }),
      ],
    });
    const from = 350 + 10;
    const res = await request(db, `${base}?from=${from}&dir=b&limit=2`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$p10c', '$p10b']);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('pagination dir=b from soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p11a', origin_server_ts: 100 + 11 }),
        child({ event_id: '$p11b', origin_server_ts: 200 + 11 }),
        child({ event_id: '$p11c', origin_server_ts: 300 + 11 }),
        child({ event_id: '$p11d', origin_server_ts: 400 + 11 }),
      ],
    });
    const from = 350 + 11;
    const res = await request(db, `${base}?from=${from}&dir=b&limit=2`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$p11c', '$p11b']);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('pagination dir=b from soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p12a', origin_server_ts: 100 + 12 }),
        child({ event_id: '$p12b', origin_server_ts: 200 + 12 }),
        child({ event_id: '$p12c', origin_server_ts: 300 + 12 }),
        child({ event_id: '$p12d', origin_server_ts: 400 + 12 }),
      ],
    });
    const from = 350 + 12;
    const res = await request(db, `${base}?from=${from}&dir=b&limit=2`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$p12c', '$p12b']);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('pagination dir=b from soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p13a', origin_server_ts: 100 + 13 }),
        child({ event_id: '$p13b', origin_server_ts: 200 + 13 }),
        child({ event_id: '$p13c', origin_server_ts: 300 + 13 }),
        child({ event_id: '$p13d', origin_server_ts: 400 + 13 }),
      ],
    });
    const from = 350 + 13;
    const res = await request(db, `${base}?from=${from}&dir=b&limit=2`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$p13c', '$p13b']);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('pagination dir=b from soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p14a', origin_server_ts: 100 + 14 }),
        child({ event_id: '$p14b', origin_server_ts: 200 + 14 }),
        child({ event_id: '$p14c', origin_server_ts: 300 + 14 }),
        child({ event_id: '$p14d', origin_server_ts: 400 + 14 }),
      ],
    });
    const from = 350 + 14;
    const res = await request(db, `${base}?from=${from}&dir=b&limit=2`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$p14c', '$p14b']);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('pagination dir=b from soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p15a', origin_server_ts: 100 + 15 }),
        child({ event_id: '$p15b', origin_server_ts: 200 + 15 }),
        child({ event_id: '$p15c', origin_server_ts: 300 + 15 }),
        child({ event_id: '$p15d', origin_server_ts: 400 + 15 }),
      ],
    });
    const from = 350 + 15;
    const res = await request(db, `${base}?from=${from}&dir=b&limit=2`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$p15c', '$p15b']);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('pagination dir=f from soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$f0a', origin_server_ts: 100 + 0 }),
        child({ event_id: '$f0b', origin_server_ts: 200 + 0 }),
        child({ event_id: '$f0c', origin_server_ts: 300 + 0 }),
      ],
    });
    const from = 150 + 0;
    const res = await request(db, `${base}?from=${from}&dir=f&limit=10`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$f0b', '$f0c']);
  });

  it('pagination dir=f from soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$f1a', origin_server_ts: 100 + 1 }),
        child({ event_id: '$f1b', origin_server_ts: 200 + 1 }),
        child({ event_id: '$f1c', origin_server_ts: 300 + 1 }),
      ],
    });
    const from = 150 + 1;
    const res = await request(db, `${base}?from=${from}&dir=f&limit=10`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$f1b', '$f1c']);
  });

  it('pagination dir=f from soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$f2a', origin_server_ts: 100 + 2 }),
        child({ event_id: '$f2b', origin_server_ts: 200 + 2 }),
        child({ event_id: '$f2c', origin_server_ts: 300 + 2 }),
      ],
    });
    const from = 150 + 2;
    const res = await request(db, `${base}?from=${from}&dir=f&limit=10`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$f2b', '$f2c']);
  });

  it('pagination dir=f from soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$f3a', origin_server_ts: 100 + 3 }),
        child({ event_id: '$f3b', origin_server_ts: 200 + 3 }),
        child({ event_id: '$f3c', origin_server_ts: 300 + 3 }),
      ],
    });
    const from = 150 + 3;
    const res = await request(db, `${base}?from=${from}&dir=f&limit=10`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$f3b', '$f3c']);
  });

  it('pagination dir=f from soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$f4a', origin_server_ts: 100 + 4 }),
        child({ event_id: '$f4b', origin_server_ts: 200 + 4 }),
        child({ event_id: '$f4c', origin_server_ts: 300 + 4 }),
      ],
    });
    const from = 150 + 4;
    const res = await request(db, `${base}?from=${from}&dir=f&limit=10`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$f4b', '$f4c']);
  });

  it('pagination dir=f from soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$f5a', origin_server_ts: 100 + 5 }),
        child({ event_id: '$f5b', origin_server_ts: 200 + 5 }),
        child({ event_id: '$f5c', origin_server_ts: 300 + 5 }),
      ],
    });
    const from = 150 + 5;
    const res = await request(db, `${base}?from=${from}&dir=f&limit=10`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$f5b', '$f5c']);
  });

  it('pagination dir=f from soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$f6a', origin_server_ts: 100 + 6 }),
        child({ event_id: '$f6b', origin_server_ts: 200 + 6 }),
        child({ event_id: '$f6c', origin_server_ts: 300 + 6 }),
      ],
    });
    const from = 150 + 6;
    const res = await request(db, `${base}?from=${from}&dir=f&limit=10`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$f6b', '$f6c']);
  });

  it('pagination dir=f from soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$f7a', origin_server_ts: 100 + 7 }),
        child({ event_id: '$f7b', origin_server_ts: 200 + 7 }),
        child({ event_id: '$f7c', origin_server_ts: 300 + 7 }),
      ],
    });
    const from = 150 + 7;
    const res = await request(db, `${base}?from=${from}&dir=f&limit=10`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$f7b', '$f7c']);
  });

  it('pagination dir=f from soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$f8a', origin_server_ts: 100 + 8 }),
        child({ event_id: '$f8b', origin_server_ts: 200 + 8 }),
        child({ event_id: '$f8c', origin_server_ts: 300 + 8 }),
      ],
    });
    const from = 150 + 8;
    const res = await request(db, `${base}?from=${from}&dir=f&limit=10`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$f8b', '$f8c']);
  });

  it('pagination dir=f from soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$f9a', origin_server_ts: 100 + 9 }),
        child({ event_id: '$f9b', origin_server_ts: 200 + 9 }),
        child({ event_id: '$f9c', origin_server_ts: 300 + 9 }),
      ],
    });
    const from = 150 + 9;
    const res = await request(db, `${base}?from=${from}&dir=f&limit=10`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$f9b', '$f9c']);
  });

  it('pagination dir=f from soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$f10a', origin_server_ts: 100 + 10 }),
        child({ event_id: '$f10b', origin_server_ts: 200 + 10 }),
        child({ event_id: '$f10c', origin_server_ts: 300 + 10 }),
      ],
    });
    const from = 150 + 10;
    const res = await request(db, `${base}?from=${from}&dir=f&limit=10`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$f10b', '$f10c']);
  });

  it('pagination dir=f from soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$f11a', origin_server_ts: 100 + 11 }),
        child({ event_id: '$f11b', origin_server_ts: 200 + 11 }),
        child({ event_id: '$f11c', origin_server_ts: 300 + 11 }),
      ],
    });
    const from = 150 + 11;
    const res = await request(db, `${base}?from=${from}&dir=f&limit=10`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$f11b', '$f11c']);
  });

  it('pagination dir=f from soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$f12a', origin_server_ts: 100 + 12 }),
        child({ event_id: '$f12b', origin_server_ts: 200 + 12 }),
        child({ event_id: '$f12c', origin_server_ts: 300 + 12 }),
      ],
    });
    const from = 150 + 12;
    const res = await request(db, `${base}?from=${from}&dir=f&limit=10`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$f12b', '$f12c']);
  });

  it('pagination dir=f from soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$f13a', origin_server_ts: 100 + 13 }),
        child({ event_id: '$f13b', origin_server_ts: 200 + 13 }),
        child({ event_id: '$f13c', origin_server_ts: 300 + 13 }),
      ],
    });
    const from = 150 + 13;
    const res = await request(db, `${base}?from=${from}&dir=f&limit=10`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$f13b', '$f13c']);
  });

  it('pagination dir=f from soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$f14a', origin_server_ts: 100 + 14 }),
        child({ event_id: '$f14b', origin_server_ts: 200 + 14 }),
        child({ event_id: '$f14c', origin_server_ts: 300 + 14 }),
      ],
    });
    const from = 150 + 14;
    const res = await request(db, `${base}?from=${from}&dir=f&limit=10`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$f14b', '$f14c']);
  });

  it('pagination dir=f from soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$f15a', origin_server_ts: 100 + 15 }),
        child({ event_id: '$f15b', origin_server_ts: 200 + 15 }),
        child({ event_id: '$f15c', origin_server_ts: 300 + 15 }),
      ],
    });
    const from = 150 + 15;
    const res = await request(db, `${base}?from=${from}&dir=f&limit=10`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$f15b', '$f15c']);
  });
});


describe('relations leftovers next_batch soft flood after #175', () => {

  it('next_batch soft-0', async () => {
    const events = Array.from({ length: 5 }, (_, j) =>
      child({ event_id: `$nb0-${j}`, origin_server_ts: NOW + 0 * 10 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=2&dir=b`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(body.chunk).toHaveLength(2);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('next_batch soft-1', async () => {
    const events = Array.from({ length: 5 }, (_, j) =>
      child({ event_id: `$nb1-${j}`, origin_server_ts: NOW + 1 * 10 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=2&dir=b`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(body.chunk).toHaveLength(2);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('next_batch soft-2', async () => {
    const events = Array.from({ length: 5 }, (_, j) =>
      child({ event_id: `$nb2-${j}`, origin_server_ts: NOW + 2 * 10 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=2&dir=b`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(body.chunk).toHaveLength(2);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('next_batch soft-3', async () => {
    const events = Array.from({ length: 5 }, (_, j) =>
      child({ event_id: `$nb3-${j}`, origin_server_ts: NOW + 3 * 10 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=2&dir=b`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(body.chunk).toHaveLength(2);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('next_batch soft-4', async () => {
    const events = Array.from({ length: 5 }, (_, j) =>
      child({ event_id: `$nb4-${j}`, origin_server_ts: NOW + 4 * 10 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=2&dir=b`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(body.chunk).toHaveLength(2);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('next_batch soft-5', async () => {
    const events = Array.from({ length: 5 }, (_, j) =>
      child({ event_id: `$nb5-${j}`, origin_server_ts: NOW + 5 * 10 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=2&dir=b`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(body.chunk).toHaveLength(2);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('next_batch soft-6', async () => {
    const events = Array.from({ length: 5 }, (_, j) =>
      child({ event_id: `$nb6-${j}`, origin_server_ts: NOW + 6 * 10 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=2&dir=b`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(body.chunk).toHaveLength(2);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('next_batch soft-7', async () => {
    const events = Array.from({ length: 5 }, (_, j) =>
      child({ event_id: `$nb7-${j}`, origin_server_ts: NOW + 7 * 10 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=2&dir=b`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(body.chunk).toHaveLength(2);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('next_batch soft-8', async () => {
    const events = Array.from({ length: 5 }, (_, j) =>
      child({ event_id: `$nb8-${j}`, origin_server_ts: NOW + 8 * 10 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=2&dir=b`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(body.chunk).toHaveLength(2);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('next_batch soft-9', async () => {
    const events = Array.from({ length: 5 }, (_, j) =>
      child({ event_id: `$nb9-${j}`, origin_server_ts: NOW + 9 * 10 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=2&dir=b`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(body.chunk).toHaveLength(2);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('next_batch soft-10', async () => {
    const events = Array.from({ length: 5 }, (_, j) =>
      child({ event_id: `$nb10-${j}`, origin_server_ts: NOW + 10 * 10 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=2&dir=b`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(body.chunk).toHaveLength(2);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('next_batch soft-11', async () => {
    const events = Array.from({ length: 5 }, (_, j) =>
      child({ event_id: `$nb11-${j}`, origin_server_ts: NOW + 11 * 10 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=2&dir=b`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(body.chunk).toHaveLength(2);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('next_batch soft-12', async () => {
    const events = Array.from({ length: 5 }, (_, j) =>
      child({ event_id: `$nb12-${j}`, origin_server_ts: NOW + 12 * 10 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=2&dir=b`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(body.chunk).toHaveLength(2);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('next_batch soft-13', async () => {
    const events = Array.from({ length: 5 }, (_, j) =>
      child({ event_id: `$nb13-${j}`, origin_server_ts: NOW + 13 * 10 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=2&dir=b`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(body.chunk).toHaveLength(2);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('next_batch soft-14', async () => {
    const events = Array.from({ length: 5 }, (_, j) =>
      child({ event_id: `$nb14-${j}`, origin_server_ts: NOW + 14 * 10 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=2&dir=b`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(body.chunk).toHaveLength(2);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });

  it('next_batch soft-15', async () => {
    const events = Array.from({ length: 5 }, (_, j) =>
      child({ event_id: `$nb15-${j}`, origin_server_ts: NOW + 15 * 10 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=2&dir=b`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(body.chunk).toHaveLength(2);
    expect(body.next_batch).toBe(String(body.chunk[1].origin_server_ts));
  });
});


describe('relations leftovers leave membership soft flood after #175', () => {

  it('leave membership soft-0', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$leave0', origin_server_ts: NOW + 0 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(1);
  });

  it('leave membership soft-1', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$leave1', origin_server_ts: NOW + 1 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(1);
  });

  it('leave membership soft-2', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$leave2', origin_server_ts: NOW + 2 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(1);
  });

  it('leave membership soft-3', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$leave3', origin_server_ts: NOW + 3 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(1);
  });

  it('leave membership soft-4', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$leave4', origin_server_ts: NOW + 4 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(1);
  });

  it('leave membership soft-5', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$leave5', origin_server_ts: NOW + 5 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(1);
  });

  it('leave membership soft-6', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$leave6', origin_server_ts: NOW + 6 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(1);
  });

  it('leave membership soft-7', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$leave7', origin_server_ts: NOW + 7 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(1);
  });

  it('leave membership soft-8', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$leave8', origin_server_ts: NOW + 8 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(1);
  });

  it('leave membership soft-9', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$leave9', origin_server_ts: NOW + 9 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(1);
  });

  it('leave membership soft-10', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$leave10', origin_server_ts: NOW + 10 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(1);
  });

  it('leave membership soft-11', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$leave11', origin_server_ts: NOW + 11 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(1);
  });

  it('leave membership soft-12', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$leave12', origin_server_ts: NOW + 12 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(1);
  });

  it('leave membership soft-13', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$leave13', origin_server_ts: NOW + 13 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(1);
  });

  it('leave membership soft-14', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$leave14', origin_server_ts: NOW + 14 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(1);
  });

  it('leave membership soft-15', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$leave15', origin_server_ts: NOW + 15 })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(1);
  });
});


describe('relations leftovers forbidden soft flood after #175', () => {

  it('forbidden invite soft-0', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$forb0', origin_server_ts: NOW })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden ban soft-1', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$forb1', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden knock soft-2', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$forb2', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden missing soft-3', async () => {
    const db = createRelationsDb({
      memberships: [],
      events: [child({ event_id: '$forb3', origin_server_ts: NOW })],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden invite soft-4', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$forb4', origin_server_ts: NOW })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden ban soft-5', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$forb5', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden knock soft-6', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$forb6', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden missing soft-7', async () => {
    const db = createRelationsDb({
      memberships: [],
      events: [child({ event_id: '$forb7', origin_server_ts: NOW })],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden invite soft-8', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$forb8', origin_server_ts: NOW })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden ban soft-9', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$forb9', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden knock soft-10', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$forb10', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden missing soft-11', async () => {
    const db = createRelationsDb({
      memberships: [],
      events: [child({ event_id: '$forb11', origin_server_ts: NOW })],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden invite soft-12', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$forb12', origin_server_ts: NOW })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden ban soft-13', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$forb13', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden knock soft-14', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$forb14', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden missing soft-15', async () => {
    const db = createRelationsDb({
      memberships: [],
      events: [child({ event_id: '$forb15', origin_server_ts: NOW })],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden invite soft-16', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$forb16', origin_server_ts: NOW })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden ban soft-17', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$forb17', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden knock soft-18', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$forb18', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden missing soft-19', async () => {
    const db = createRelationsDb({
      memberships: [],
      events: [child({ event_id: '$forb19', origin_server_ts: NOW })],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden invite soft-20', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$forb20', origin_server_ts: NOW })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden ban soft-21', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$forb21', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden knock soft-22', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$forb22', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbidden missing soft-23', async () => {
    const db = createRelationsDb({
      memberships: [],
      events: [child({ event_id: '$forb23', origin_server_ts: NOW })],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
});


describe('relations leftovers charset soft flood after #175', () => {

  it('charset path soft-0', async () => {
    const roomId = "!room/with/slash:example.com";
    const parentId = "$evt:example.com";
    const db = createRelationsDb({
      memberships: [joinMember(roomId)],
      events: [
        child({
          event_id: `$cs0`,
          room_id: roomId,
          relates_to_event_id: parentId,
          origin_server_ts: NOW + 0,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parentId)}`;
    const res = await request(db, path);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; room_id: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0].event_id).toBe(`$cs0`);
    expect(body.chunk[0].room_id).toBe(roomId);
  });

  it('charset path soft-1', async () => {
    const roomId = "!room+plus:example.com";
    const parentId = "$evt+plus:example.com";
    const db = createRelationsDb({
      memberships: [joinMember(roomId)],
      events: [
        child({
          event_id: `$cs1`,
          room_id: roomId,
          relates_to_event_id: parentId,
          origin_server_ts: NOW + 1,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parentId)}`;
    const res = await request(db, path);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; room_id: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0].event_id).toBe(`$cs1`);
    expect(body.chunk[0].room_id).toBe(roomId);
  });

  it('charset path soft-2', async () => {
    const roomId = "!room space:example.com";
    const parentId = "$evt space:example.com";
    const db = createRelationsDb({
      memberships: [joinMember(roomId)],
      events: [
        child({
          event_id: `$cs2`,
          room_id: roomId,
          relates_to_event_id: parentId,
          origin_server_ts: NOW + 2,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parentId)}`;
    const res = await request(db, path);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; room_id: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0].event_id).toBe(`$cs2`);
    expect(body.chunk[0].room_id).toBe(roomId);
  });

  it('charset path soft-3', async () => {
    const roomId = "!\u5ba4:example.com";
    const parentId = "$\u4e8b\u4ef6:example.com";
    const db = createRelationsDb({
      memberships: [joinMember(roomId)],
      events: [
        child({
          event_id: `$cs3`,
          room_id: roomId,
          relates_to_event_id: parentId,
          origin_server_ts: NOW + 3,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parentId)}`;
    const res = await request(db, path);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; room_id: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0].event_id).toBe(`$cs3`);
    expect(body.chunk[0].room_id).toBe(roomId);
  });

  it('charset path soft-4', async () => {
    const roomId = "!room#hash:example.com";
    const parentId = "$evt#hash:example.com";
    const db = createRelationsDb({
      memberships: [joinMember(roomId)],
      events: [
        child({
          event_id: `$cs4`,
          room_id: roomId,
          relates_to_event_id: parentId,
          origin_server_ts: NOW + 4,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parentId)}`;
    const res = await request(db, path);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; room_id: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0].event_id).toBe(`$cs4`);
    expect(body.chunk[0].room_id).toBe(roomId);
  });

  it('charset path soft-5', async () => {
    const roomId = "!room&amp:example.com";
    const parentId = "$evt&amp:example.com";
    const db = createRelationsDb({
      memberships: [joinMember(roomId)],
      events: [
        child({
          event_id: `$cs5`,
          room_id: roomId,
          relates_to_event_id: parentId,
          origin_server_ts: NOW + 5,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parentId)}`;
    const res = await request(db, path);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; room_id: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0].event_id).toBe(`$cs5`);
    expect(body.chunk[0].room_id).toBe(roomId);
  });

  it('charset path soft-6', async () => {
    const roomId = "!room=eq:example.com";
    const parentId = "$evt=eq:example.com";
    const db = createRelationsDb({
      memberships: [joinMember(roomId)],
      events: [
        child({
          event_id: `$cs6`,
          room_id: roomId,
          relates_to_event_id: parentId,
          origin_server_ts: NOW + 6,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parentId)}`;
    const res = await request(db, path);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; room_id: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0].event_id).toBe(`$cs6`);
    expect(body.chunk[0].room_id).toBe(roomId);
  });

  it('charset path soft-7', async () => {
    const roomId = "!room?q:example.com";
    const parentId = "$evt?q:example.com";
    const db = createRelationsDb({
      memberships: [joinMember(roomId)],
      events: [
        child({
          event_id: `$cs7`,
          room_id: roomId,
          relates_to_event_id: parentId,
          origin_server_ts: NOW + 7,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parentId)}`;
    const res = await request(db, path);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; room_id: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0].event_id).toBe(`$cs7`);
    expect(body.chunk[0].room_id).toBe(roomId);
  });

  it('charset path soft-8', async () => {
    const roomId = "!room%25:example.com";
    const parentId = "$evt%25:example.com";
    const db = createRelationsDb({
      memberships: [joinMember(roomId)],
      events: [
        child({
          event_id: `$cs8`,
          room_id: roomId,
          relates_to_event_id: parentId,
          origin_server_ts: NOW + 8,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parentId)}`;
    const res = await request(db, path);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; room_id: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0].event_id).toBe(`$cs8`);
    expect(body.chunk[0].room_id).toBe(roomId);
  });

  it('charset path soft-9', async () => {
    const roomId = "!room.dot:example.com";
    const parentId = "$evt.dot:example.com";
    const db = createRelationsDb({
      memberships: [joinMember(roomId)],
      events: [
        child({
          event_id: `$cs9`,
          room_id: roomId,
          relates_to_event_id: parentId,
          origin_server_ts: NOW + 9,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parentId)}`;
    const res = await request(db, path);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; room_id: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0].event_id).toBe(`$cs9`);
    expect(body.chunk[0].room_id).toBe(roomId);
  });

  it('charset path soft-10', async () => {
    const roomId = "!room_under:example.com";
    const parentId = "$evt_under:example.com";
    const db = createRelationsDb({
      memberships: [joinMember(roomId)],
      events: [
        child({
          event_id: `$cs10`,
          room_id: roomId,
          relates_to_event_id: parentId,
          origin_server_ts: NOW + 10,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parentId)}`;
    const res = await request(db, path);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; room_id: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0].event_id).toBe(`$cs10`);
    expect(body.chunk[0].room_id).toBe(roomId);
  });

  it('charset path soft-11', async () => {
    const roomId = "!room-dash:example.com";
    const parentId = "$evt-dash:example.com";
    const db = createRelationsDb({
      memberships: [joinMember(roomId)],
      events: [
        child({
          event_id: `$cs11`,
          room_id: roomId,
          relates_to_event_id: parentId,
          origin_server_ts: NOW + 11,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parentId)}`;
    const res = await request(db, path);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; room_id: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0].event_id).toBe(`$cs11`);
    expect(body.chunk[0].room_id).toBe(roomId);
  });

  it('charset path soft-12', async () => {
    const roomId = "!AaBbCc:example.com";
    const parentId = "$AaBbCc:example.com";
    const db = createRelationsDb({
      memberships: [joinMember(roomId)],
      events: [
        child({
          event_id: `$cs12`,
          room_id: roomId,
          relates_to_event_id: parentId,
          origin_server_ts: NOW + 12,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parentId)}`;
    const res = await request(db, path);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; room_id: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0].event_id).toBe(`$cs12`);
    expect(body.chunk[0].room_id).toBe(roomId);
  });

  it('charset path soft-13', async () => {
    const roomId = "!123:example.com";
    const parentId = "$123:example.com";
    const db = createRelationsDb({
      memberships: [joinMember(roomId)],
      events: [
        child({
          event_id: `$cs13`,
          room_id: roomId,
          relates_to_event_id: parentId,
          origin_server_ts: NOW + 13,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parentId)}`;
    const res = await request(db, path);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; room_id: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0].event_id).toBe(`$cs13`);
    expect(body.chunk[0].room_id).toBe(roomId);
  });

  it('charset path soft-14', async () => {
    const roomId = "!room~tilde:example.com";
    const parentId = "$evt~tilde:example.com";
    const db = createRelationsDb({
      memberships: [joinMember(roomId)],
      events: [
        child({
          event_id: `$cs14`,
          room_id: roomId,
          relates_to_event_id: parentId,
          origin_server_ts: NOW + 14,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parentId)}`;
    const res = await request(db, path);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; room_id: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0].event_id).toBe(`$cs14`);
    expect(body.chunk[0].room_id).toBe(roomId);
  });

  it('charset path soft-15', async () => {
    const roomId = "!room*star:example.com";
    const parentId = "$evt*star:example.com";
    const db = createRelationsDb({
      memberships: [joinMember(roomId)],
      events: [
        child({
          event_id: `$cs15`,
          room_id: roomId,
          relates_to_event_id: parentId,
          origin_server_ts: NOW + 15,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parentId)}`;
    const res = await request(db, path);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; room_id: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0].event_id).toBe(`$cs15`);
    expect(body.chunk[0].room_id).toBe(roomId);
  });

  it('charset path soft-16', async () => {
    const roomId = "!room(paren):example.com";
    const parentId = "$evt(paren):example.com";
    const db = createRelationsDb({
      memberships: [joinMember(roomId)],
      events: [
        child({
          event_id: `$cs16`,
          room_id: roomId,
          relates_to_event_id: parentId,
          origin_server_ts: NOW + 16,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parentId)}`;
    const res = await request(db, path);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; room_id: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0].event_id).toBe(`$cs16`);
    expect(body.chunk[0].room_id).toBe(roomId);
  });

  it('charset path soft-17', async () => {
    const roomId = "!room[bracket]:example.com";
    const parentId = "$evt[bracket]:example.com";
    const db = createRelationsDb({
      memberships: [joinMember(roomId)],
      events: [
        child({
          event_id: `$cs17`,
          room_id: roomId,
          relates_to_event_id: parentId,
          origin_server_ts: NOW + 17,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parentId)}`;
    const res = await request(db, path);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; room_id: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0].event_id).toBe(`$cs17`);
    expect(body.chunk[0].room_id).toBe(roomId);
  });

  it('charset path soft-18', async () => {
    const roomId = "!room{brace}:example.com";
    const parentId = "$evt{brace}:example.com";
    const db = createRelationsDb({
      memberships: [joinMember(roomId)],
      events: [
        child({
          event_id: `$cs18`,
          room_id: roomId,
          relates_to_event_id: parentId,
          origin_server_ts: NOW + 18,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parentId)}`;
    const res = await request(db, path);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; room_id: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0].event_id).toBe(`$cs18`);
    expect(body.chunk[0].room_id).toBe(roomId);
  });

  it('charset path soft-19', async () => {
    const roomId = "!room|pipe:example.com";
    const parentId = "$evt|pipe:example.com";
    const db = createRelationsDb({
      memberships: [joinMember(roomId)],
      events: [
        child({
          event_id: `$cs19`,
          room_id: roomId,
          relates_to_event_id: parentId,
          origin_server_ts: NOW + 19,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parentId)}`;
    const res = await request(db, path);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; room_id: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0].event_id).toBe(`$cs19`);
    expect(body.chunk[0].room_id).toBe(roomId);
  });

  it('charset path soft-20', async () => {
    const roomId = "!room\\back:example.com";
    const parentId = "$evt\\back:example.com";
    const db = createRelationsDb({
      memberships: [joinMember(roomId)],
      events: [
        child({
          event_id: `$cs20`,
          room_id: roomId,
          relates_to_event_id: parentId,
          origin_server_ts: NOW + 20,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parentId)}`;
    const res = await request(db, path);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; room_id: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0].event_id).toBe(`$cs20`);
    expect(body.chunk[0].room_id).toBe(roomId);
  });

  it('charset path soft-21', async () => {
    const roomId = "!room'quote:example.com";
    const parentId = "$evt'quote:example.com";
    const db = createRelationsDb({
      memberships: [joinMember(roomId)],
      events: [
        child({
          event_id: `$cs21`,
          room_id: roomId,
          relates_to_event_id: parentId,
          origin_server_ts: NOW + 21,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parentId)}`;
    const res = await request(db, path);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; room_id: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0].event_id).toBe(`$cs21`);
    expect(body.chunk[0].room_id).toBe(roomId);
  });

  it('charset path soft-22', async () => {
    const roomId = "!room\"dquote:example.com";
    const parentId = "$evt\"dquote:example.com";
    const db = createRelationsDb({
      memberships: [joinMember(roomId)],
      events: [
        child({
          event_id: `$cs22`,
          room_id: roomId,
          relates_to_event_id: parentId,
          origin_server_ts: NOW + 22,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parentId)}`;
    const res = await request(db, path);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; room_id: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0].event_id).toBe(`$cs22`);
    expect(body.chunk[0].room_id).toBe(roomId);
  });

  it('charset path soft-23', async () => {
    const roomId = "!room:example.com";
    const parentId = "$parent/with/slash:example.com";
    const db = createRelationsDb({
      memberships: [joinMember(roomId)],
      events: [
        child({
          event_id: `$cs23`,
          room_id: roomId,
          relates_to_event_id: parentId,
          origin_server_ts: NOW + 23,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parentId)}`;
    const res = await request(db, path);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string; room_id: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0].event_id).toBe(`$cs23`);
    expect(body.chunk[0].room_id).toBe(roomId);
  });
});


describe('relations leftovers method matrix after #175', () => {

  it('method POST soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$m0', origin_server_ts: NOW })],
    });
    const res = await request(db, base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method PUT soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$m1', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method PATCH soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$m2', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method DELETE soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$m3', origin_server_ts: NOW })],
    });
    const res = await request(db, threadsBase, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method OPTIONS soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$m4', origin_server_ts: NOW })],
    });
    const res = await request(db, base, {
      method: 'OPTIONS',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method HEAD soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$m5', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation`, {
      method: 'HEAD',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method POST soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$m6', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method PUT soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$m7', origin_server_ts: NOW })],
    });
    const res = await request(db, threadsBase, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method PATCH soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$m8', origin_server_ts: NOW })],
    });
    const res = await request(db, base, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method DELETE soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$m9', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method OPTIONS soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$m10', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction`, {
      method: 'OPTIONS',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method HEAD soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$m11', origin_server_ts: NOW })],
    });
    const res = await request(db, threadsBase, {
      method: 'HEAD',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method POST soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$m12', origin_server_ts: NOW })],
    });
    const res = await request(db, base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method PUT soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$m13', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method PATCH soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$m14', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method DELETE soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$m15', origin_server_ts: NOW })],
    });
    const res = await request(db, threadsBase, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method OPTIONS soft-16', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$m16', origin_server_ts: NOW })],
    });
    const res = await request(db, base, {
      method: 'OPTIONS',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method HEAD soft-17', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$m17', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation`, {
      method: 'HEAD',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method POST soft-18', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$m18', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method PUT soft-19', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$m19', origin_server_ts: NOW })],
    });
    const res = await request(db, threadsBase, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method PATCH soft-20', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$m20', origin_server_ts: NOW })],
    });
    const res = await request(db, base, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method DELETE soft-21', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$m21', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method OPTIONS soft-22', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$m22', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction`, {
      method: 'OPTIONS',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method HEAD soft-23', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$m23', origin_server_ts: NOW })],
    });
    const res = await request(db, threadsBase, {
      method: 'HEAD',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
    });
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  it('method GET soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: `$g0`, origin_server_ts: NOW })],
    });
    const res = await request(db, base, { method: 'GET' });
    expect(res.status).toBe(200);
  });

  it('method GET soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: `$g1`, origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation`, { method: 'GET' });
    expect(res.status).toBe(200);
  });

  it('method GET soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: `$g2`, origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction`, { method: 'GET' });
    expect(res.status).toBe(200);
  });

  it('method GET soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
      threadRoot({ event_id: '$g3', origin_server_ts: NOW }),
      threadReply('$g3', { event_id: '$gr3', origin_server_ts: NOW + 1 }),
    ],
    });
    const res = await request(db, threadsBase, { method: 'GET' });
    expect(res.status).toBe(200);
  });

  it('method GET soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: `$g4`, origin_server_ts: NOW })],
    });
    const res = await request(db, base, { method: 'GET' });
    expect(res.status).toBe(200);
  });

  it('method GET soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: `$g5`, origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation`, { method: 'GET' });
    expect(res.status).toBe(200);
  });

  it('method GET soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: `$g6`, origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction`, { method: 'GET' });
    expect(res.status).toBe(200);
  });

  it('method GET soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
      threadRoot({ event_id: '$g7', origin_server_ts: NOW }),
      threadReply('$g7', { event_id: '$gr7', origin_server_ts: NOW + 1 }),
    ],
    });
    const res = await request(db, threadsBase, { method: 'GET' });
    expect(res.status).toBe(200);
  });
});


describe('relations leftovers failure edges after #175', () => {

  it('membership query failure soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      throwOnMembership: true,
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('membership query failure soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      throwOnMembership: true,
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('membership query failure soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      throwOnMembership: true,
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('membership query failure soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      throwOnMembership: true,
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('membership query failure soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      throwOnMembership: true,
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('membership query failure soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      throwOnMembership: true,
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('membership query failure soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      throwOnMembership: true,
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('membership query failure soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      throwOnMembership: true,
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('membership query failure soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      throwOnMembership: true,
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('membership query failure soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      throwOnMembership: true,
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('membership query failure soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      throwOnMembership: true,
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('membership query failure soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      throwOnMembership: true,
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('events query failure soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      throwOnEvents: true,
      events: [child({ event_id: '$ef0', origin_server_ts: NOW })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('events query failure soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      throwOnEvents: true,
      events: [child({ event_id: '$ef1', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation`);
    expect(res.status).toBe(500);
  });

  it('events query failure soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      throwOnEvents: true,
      events: [child({ event_id: '$ef2', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction`);
    expect(res.status).toBe(500);
  });

  it('events query failure soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      throwOnEvents: true,
      events: [child({ event_id: '$ef3', origin_server_ts: NOW })],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(500);
  });

  it('events query failure soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      throwOnEvents: true,
      events: [child({ event_id: '$ef4', origin_server_ts: NOW })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('events query failure soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      throwOnEvents: true,
      events: [child({ event_id: '$ef5', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation`);
    expect(res.status).toBe(500);
  });

  it('events query failure soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      throwOnEvents: true,
      events: [child({ event_id: '$ef6', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction`);
    expect(res.status).toBe(500);
  });

  it('events query failure soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      throwOnEvents: true,
      events: [child({ event_id: '$ef7', origin_server_ts: NOW })],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(500);
  });

  it('events query failure soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      throwOnEvents: true,
      events: [child({ event_id: '$ef8', origin_server_ts: NOW })],
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('events query failure soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      throwOnEvents: true,
      events: [child({ event_id: '$ef9', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation`);
    expect(res.status).toBe(500);
  });

  it('events query failure soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      throwOnEvents: true,
      events: [child({ event_id: '$ef10', origin_server_ts: NOW })],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction`);
    expect(res.status).toBe(500);
  });

  it('events query failure soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      throwOnEvents: true,
      events: [child({ event_id: '$ef11', origin_server_ts: NOW })],
    });
    const res = await request(db, threadsBase);
    expect(res.status).toBe(500);
  });

  it('bad content JSON soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$badjson0', origin_server_ts: NOW })],
      badContentIds: new Set(['$badjson0']),
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('bad content JSON soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$badjson1', origin_server_ts: NOW })],
      badContentIds: new Set(['$badjson1']),
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('bad content JSON soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$badjson2', origin_server_ts: NOW })],
      badContentIds: new Set(['$badjson2']),
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('bad content JSON soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$badjson3', origin_server_ts: NOW })],
      badContentIds: new Set(['$badjson3']),
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('bad content JSON soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$badjson4', origin_server_ts: NOW })],
      badContentIds: new Set(['$badjson4']),
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('bad content JSON soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$badjson5', origin_server_ts: NOW })],
      badContentIds: new Set(['$badjson5']),
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('bad content JSON soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$badjson6', origin_server_ts: NOW })],
      badContentIds: new Set(['$badjson6']),
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('bad content JSON soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$badjson7', origin_server_ts: NOW })],
      badContentIds: new Set(['$badjson7']),
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('bad content JSON soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$badjson8', origin_server_ts: NOW })],
      badContentIds: new Set(['$badjson8']),
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('bad content JSON soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$badjson9', origin_server_ts: NOW })],
      badContentIds: new Set(['$badjson9']),
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('bad content JSON soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$badjson10', origin_server_ts: NOW })],
      badContentIds: new Set(['$badjson10']),
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });

  it('bad content JSON soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$badjson11', origin_server_ts: NOW })],
      badContentIds: new Set(['$badjson11']),
    });
    const res = await request(db, base);
    expect(res.status).toBe(500);
  });
});


describe('relations leftovers limit edges soft flood after #175', () => {

  it('limit=0 soft-0', async () => {
    const events = Array.from({ length: 12 }, (_, j) =>
      child({ event_id: `$lim0-${j}`, origin_server_ts: NOW + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=0`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: unknown[] };
    expect(body.chunk.length).toBeLessThanOrEqual(100);
  });

  it('limit=1 soft-1', async () => {
    const events = Array.from({ length: 12 }, (_, j) =>
      child({ event_id: `$lim1-${j}`, origin_server_ts: NOW + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=1`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: unknown[] };
    expect(body.chunk.length).toBeLessThanOrEqual(100);
  });

  it('limit=2 soft-2', async () => {
    const events = Array.from({ length: 12 }, (_, j) =>
      child({ event_id: `$lim2-${j}`, origin_server_ts: NOW + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=2`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: unknown[] };
    expect(body.chunk.length).toBeLessThanOrEqual(100);
  });

  it('limit=50 soft-3', async () => {
    const events = Array.from({ length: 12 }, (_, j) =>
      child({ event_id: `$lim3-${j}`, origin_server_ts: NOW + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=50`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: unknown[] };
    expect(body.chunk.length).toBeLessThanOrEqual(100);
  });

  it('limit=100 soft-4', async () => {
    const events = Array.from({ length: 12 }, (_, j) =>
      child({ event_id: `$lim4-${j}`, origin_server_ts: NOW + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=100`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: unknown[] };
    expect(body.chunk.length).toBeLessThanOrEqual(100);
  });

  it('limit=101 soft-5', async () => {
    const events = Array.from({ length: 12 }, (_, j) =>
      child({ event_id: `$lim5-${j}`, origin_server_ts: NOW + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=101`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: unknown[] };
    expect(body.chunk.length).toBeLessThanOrEqual(100);
  });

  it('limit=999 soft-6', async () => {
    const events = Array.from({ length: 12 }, (_, j) =>
      child({ event_id: `$lim6-${j}`, origin_server_ts: NOW + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=999`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: unknown[] };
    expect(body.chunk.length).toBeLessThanOrEqual(100);
  });

  it('limit=NaN soft-7', async () => {
    const events = Array.from({ length: 12 }, (_, j) =>
      child({ event_id: `$lim7-${j}`, origin_server_ts: NOW + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=NaN`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: unknown[] };
    expect(body.chunk.length).toBeLessThanOrEqual(100);
  });

  it('limit=-1 soft-8', async () => {
    const events = Array.from({ length: 12 }, (_, j) =>
      child({ event_id: `$lim8-${j}`, origin_server_ts: NOW + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=-1`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: unknown[] };
    expect(body.chunk.length).toBeLessThanOrEqual(100);
  });

  it('limit=abc soft-9', async () => {
    const events = Array.from({ length: 12 }, (_, j) =>
      child({ event_id: `$lim9-${j}`, origin_server_ts: NOW + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=abc`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: unknown[] };
    expect(body.chunk.length).toBeLessThanOrEqual(100);
  });

  it('limit=default soft-10', async () => {
    const events = Array.from({ length: 12 }, (_, j) =>
      child({ event_id: `$lim10-${j}`, origin_server_ts: NOW + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: unknown[] };
    expect(body.chunk.length).toBeLessThanOrEqual(100);
  });

  it('limit=1.5 soft-11', async () => {
    const events = Array.from({ length: 12 }, (_, j) =>
      child({ event_id: `$lim11-${j}`, origin_server_ts: NOW + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=1.5`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: unknown[] };
    expect(body.chunk.length).toBeLessThanOrEqual(100);
  });

  it('limit=01 soft-12', async () => {
    const events = Array.from({ length: 12 }, (_, j) =>
      child({ event_id: `$lim12-${j}`, origin_server_ts: NOW + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=01`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: unknown[] };
    expect(body.chunk.length).toBeLessThanOrEqual(100);
  });

  it('limit=00 soft-13', async () => {
    const events = Array.from({ length: 12 }, (_, j) =>
      child({ event_id: `$lim13-${j}`, origin_server_ts: NOW + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=00`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: unknown[] };
    expect(body.chunk.length).toBeLessThanOrEqual(100);
  });

  it('limit=50.9 soft-14', async () => {
    const events = Array.from({ length: 12 }, (_, j) =>
      child({ event_id: `$lim14-${j}`, origin_server_ts: NOW + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=50.9`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: unknown[] };
    expect(body.chunk.length).toBeLessThanOrEqual(100);
  });

  it('limit=1000 soft-15', async () => {
    const events = Array.from({ length: 12 }, (_, j) =>
      child({ event_id: `$lim15-${j}`, origin_server_ts: NOW + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const res = await request(db, `${base}?limit=1000`);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: unknown[] };
    expect(body.chunk.length).toBeLessThanOrEqual(100);
  });
});


describe('relations leftovers paginate lifecycle after #175', () => {

  it('paginate lifecycle soft-0', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$life0-${j}`, origin_server_ts: NOW + 0 * 100 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const first = await request(db, `${base}?limit=2&dir=b`);
    expect(first.status).toBe(200);
    const b1 = first.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(b1.chunk).toHaveLength(2);
    expect(b1.next_batch).toBeTruthy();

    const second = await request(db, `${base}?limit=2&dir=b&from=${b1.next_batch}`);
    expect(second.status).toBe(200);
    const b2 = second.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(b2.chunk).toHaveLength(2);
    expect(b2.chunk[0].event_id).not.toBe(b1.chunk[0].event_id);

    const third = await request(db, `${base}?limit=2&dir=b&from=${b2.next_batch}`);
    expect(third.status).toBe(200);
    const b3 = third.body as { chunk: Array<{ event_id: string }>; next_batch?: string };
    expect(b3.chunk).toHaveLength(2);
    expect(b3.next_batch).toBeUndefined();
  });

  it('paginate lifecycle soft-1', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$life1-${j}`, origin_server_ts: NOW + 1 * 100 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const first = await request(db, `${base}?limit=2&dir=b`);
    expect(first.status).toBe(200);
    const b1 = first.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(b1.chunk).toHaveLength(2);
    expect(b1.next_batch).toBeTruthy();

    const second = await request(db, `${base}?limit=2&dir=b&from=${b1.next_batch}`);
    expect(second.status).toBe(200);
    const b2 = second.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(b2.chunk).toHaveLength(2);
    expect(b2.chunk[0].event_id).not.toBe(b1.chunk[0].event_id);

    const third = await request(db, `${base}?limit=2&dir=b&from=${b2.next_batch}`);
    expect(third.status).toBe(200);
    const b3 = third.body as { chunk: Array<{ event_id: string }>; next_batch?: string };
    expect(b3.chunk).toHaveLength(2);
    expect(b3.next_batch).toBeUndefined();
  });

  it('paginate lifecycle soft-2', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$life2-${j}`, origin_server_ts: NOW + 2 * 100 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const first = await request(db, `${base}?limit=2&dir=b`);
    expect(first.status).toBe(200);
    const b1 = first.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(b1.chunk).toHaveLength(2);
    expect(b1.next_batch).toBeTruthy();

    const second = await request(db, `${base}?limit=2&dir=b&from=${b1.next_batch}`);
    expect(second.status).toBe(200);
    const b2 = second.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(b2.chunk).toHaveLength(2);
    expect(b2.chunk[0].event_id).not.toBe(b1.chunk[0].event_id);

    const third = await request(db, `${base}?limit=2&dir=b&from=${b2.next_batch}`);
    expect(third.status).toBe(200);
    const b3 = third.body as { chunk: Array<{ event_id: string }>; next_batch?: string };
    expect(b3.chunk).toHaveLength(2);
    expect(b3.next_batch).toBeUndefined();
  });

  it('paginate lifecycle soft-3', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$life3-${j}`, origin_server_ts: NOW + 3 * 100 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const first = await request(db, `${base}?limit=2&dir=b`);
    expect(first.status).toBe(200);
    const b1 = first.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(b1.chunk).toHaveLength(2);
    expect(b1.next_batch).toBeTruthy();

    const second = await request(db, `${base}?limit=2&dir=b&from=${b1.next_batch}`);
    expect(second.status).toBe(200);
    const b2 = second.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(b2.chunk).toHaveLength(2);
    expect(b2.chunk[0].event_id).not.toBe(b1.chunk[0].event_id);

    const third = await request(db, `${base}?limit=2&dir=b&from=${b2.next_batch}`);
    expect(third.status).toBe(200);
    const b3 = third.body as { chunk: Array<{ event_id: string }>; next_batch?: string };
    expect(b3.chunk).toHaveLength(2);
    expect(b3.next_batch).toBeUndefined();
  });

  it('paginate lifecycle soft-4', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$life4-${j}`, origin_server_ts: NOW + 4 * 100 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const first = await request(db, `${base}?limit=2&dir=b`);
    expect(first.status).toBe(200);
    const b1 = first.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(b1.chunk).toHaveLength(2);
    expect(b1.next_batch).toBeTruthy();

    const second = await request(db, `${base}?limit=2&dir=b&from=${b1.next_batch}`);
    expect(second.status).toBe(200);
    const b2 = second.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(b2.chunk).toHaveLength(2);
    expect(b2.chunk[0].event_id).not.toBe(b1.chunk[0].event_id);

    const third = await request(db, `${base}?limit=2&dir=b&from=${b2.next_batch}`);
    expect(third.status).toBe(200);
    const b3 = third.body as { chunk: Array<{ event_id: string }>; next_batch?: string };
    expect(b3.chunk).toHaveLength(2);
    expect(b3.next_batch).toBeUndefined();
  });

  it('paginate lifecycle soft-5', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$life5-${j}`, origin_server_ts: NOW + 5 * 100 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const first = await request(db, `${base}?limit=2&dir=b`);
    expect(first.status).toBe(200);
    const b1 = first.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(b1.chunk).toHaveLength(2);
    expect(b1.next_batch).toBeTruthy();

    const second = await request(db, `${base}?limit=2&dir=b&from=${b1.next_batch}`);
    expect(second.status).toBe(200);
    const b2 = second.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(b2.chunk).toHaveLength(2);
    expect(b2.chunk[0].event_id).not.toBe(b1.chunk[0].event_id);

    const third = await request(db, `${base}?limit=2&dir=b&from=${b2.next_batch}`);
    expect(third.status).toBe(200);
    const b3 = third.body as { chunk: Array<{ event_id: string }>; next_batch?: string };
    expect(b3.chunk).toHaveLength(2);
    expect(b3.next_batch).toBeUndefined();
  });

  it('paginate lifecycle soft-6', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$life6-${j}`, origin_server_ts: NOW + 6 * 100 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const first = await request(db, `${base}?limit=2&dir=b`);
    expect(first.status).toBe(200);
    const b1 = first.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(b1.chunk).toHaveLength(2);
    expect(b1.next_batch).toBeTruthy();

    const second = await request(db, `${base}?limit=2&dir=b&from=${b1.next_batch}`);
    expect(second.status).toBe(200);
    const b2 = second.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(b2.chunk).toHaveLength(2);
    expect(b2.chunk[0].event_id).not.toBe(b1.chunk[0].event_id);

    const third = await request(db, `${base}?limit=2&dir=b&from=${b2.next_batch}`);
    expect(third.status).toBe(200);
    const b3 = third.body as { chunk: Array<{ event_id: string }>; next_batch?: string };
    expect(b3.chunk).toHaveLength(2);
    expect(b3.next_batch).toBeUndefined();
  });

  it('paginate lifecycle soft-7', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$life7-${j}`, origin_server_ts: NOW + 7 * 100 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const first = await request(db, `${base}?limit=2&dir=b`);
    expect(first.status).toBe(200);
    const b1 = first.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(b1.chunk).toHaveLength(2);
    expect(b1.next_batch).toBeTruthy();

    const second = await request(db, `${base}?limit=2&dir=b&from=${b1.next_batch}`);
    expect(second.status).toBe(200);
    const b2 = second.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(b2.chunk).toHaveLength(2);
    expect(b2.chunk[0].event_id).not.toBe(b1.chunk[0].event_id);

    const third = await request(db, `${base}?limit=2&dir=b&from=${b2.next_batch}`);
    expect(third.status).toBe(200);
    const b3 = third.body as { chunk: Array<{ event_id: string }>; next_batch?: string };
    expect(b3.chunk).toHaveLength(2);
    expect(b3.next_batch).toBeUndefined();
  });

  it('paginate lifecycle soft-8', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$life8-${j}`, origin_server_ts: NOW + 8 * 100 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const first = await request(db, `${base}?limit=2&dir=b`);
    expect(first.status).toBe(200);
    const b1 = first.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(b1.chunk).toHaveLength(2);
    expect(b1.next_batch).toBeTruthy();

    const second = await request(db, `${base}?limit=2&dir=b&from=${b1.next_batch}`);
    expect(second.status).toBe(200);
    const b2 = second.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(b2.chunk).toHaveLength(2);
    expect(b2.chunk[0].event_id).not.toBe(b1.chunk[0].event_id);

    const third = await request(db, `${base}?limit=2&dir=b&from=${b2.next_batch}`);
    expect(third.status).toBe(200);
    const b3 = third.body as { chunk: Array<{ event_id: string }>; next_batch?: string };
    expect(b3.chunk).toHaveLength(2);
    expect(b3.next_batch).toBeUndefined();
  });

  it('paginate lifecycle soft-9', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$life9-${j}`, origin_server_ts: NOW + 9 * 100 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const first = await request(db, `${base}?limit=2&dir=b`);
    expect(first.status).toBe(200);
    const b1 = first.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(b1.chunk).toHaveLength(2);
    expect(b1.next_batch).toBeTruthy();

    const second = await request(db, `${base}?limit=2&dir=b&from=${b1.next_batch}`);
    expect(second.status).toBe(200);
    const b2 = second.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(b2.chunk).toHaveLength(2);
    expect(b2.chunk[0].event_id).not.toBe(b1.chunk[0].event_id);

    const third = await request(db, `${base}?limit=2&dir=b&from=${b2.next_batch}`);
    expect(third.status).toBe(200);
    const b3 = third.body as { chunk: Array<{ event_id: string }>; next_batch?: string };
    expect(b3.chunk).toHaveLength(2);
    expect(b3.next_batch).toBeUndefined();
  });

  it('paginate lifecycle soft-10', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$life10-${j}`, origin_server_ts: NOW + 10 * 100 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const first = await request(db, `${base}?limit=2&dir=b`);
    expect(first.status).toBe(200);
    const b1 = first.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(b1.chunk).toHaveLength(2);
    expect(b1.next_batch).toBeTruthy();

    const second = await request(db, `${base}?limit=2&dir=b&from=${b1.next_batch}`);
    expect(second.status).toBe(200);
    const b2 = second.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(b2.chunk).toHaveLength(2);
    expect(b2.chunk[0].event_id).not.toBe(b1.chunk[0].event_id);

    const third = await request(db, `${base}?limit=2&dir=b&from=${b2.next_batch}`);
    expect(third.status).toBe(200);
    const b3 = third.body as { chunk: Array<{ event_id: string }>; next_batch?: string };
    expect(b3.chunk).toHaveLength(2);
    expect(b3.next_batch).toBeUndefined();
  });

  it('paginate lifecycle soft-11', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$life11-${j}`, origin_server_ts: NOW + 11 * 100 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const first = await request(db, `${base}?limit=2&dir=b`);
    expect(first.status).toBe(200);
    const b1 = first.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(b1.chunk).toHaveLength(2);
    expect(b1.next_batch).toBeTruthy();

    const second = await request(db, `${base}?limit=2&dir=b&from=${b1.next_batch}`);
    expect(second.status).toBe(200);
    const b2 = second.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(b2.chunk).toHaveLength(2);
    expect(b2.chunk[0].event_id).not.toBe(b1.chunk[0].event_id);

    const third = await request(db, `${base}?limit=2&dir=b&from=${b2.next_batch}`);
    expect(third.status).toBe(200);
    const b3 = third.body as { chunk: Array<{ event_id: string }>; next_batch?: string };
    expect(b3.chunk).toHaveLength(2);
    expect(b3.next_batch).toBeUndefined();
  });

  it('paginate lifecycle soft-12', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$life12-${j}`, origin_server_ts: NOW + 12 * 100 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const first = await request(db, `${base}?limit=2&dir=b`);
    expect(first.status).toBe(200);
    const b1 = first.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(b1.chunk).toHaveLength(2);
    expect(b1.next_batch).toBeTruthy();

    const second = await request(db, `${base}?limit=2&dir=b&from=${b1.next_batch}`);
    expect(second.status).toBe(200);
    const b2 = second.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(b2.chunk).toHaveLength(2);
    expect(b2.chunk[0].event_id).not.toBe(b1.chunk[0].event_id);

    const third = await request(db, `${base}?limit=2&dir=b&from=${b2.next_batch}`);
    expect(third.status).toBe(200);
    const b3 = third.body as { chunk: Array<{ event_id: string }>; next_batch?: string };
    expect(b3.chunk).toHaveLength(2);
    expect(b3.next_batch).toBeUndefined();
  });

  it('paginate lifecycle soft-13', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$life13-${j}`, origin_server_ts: NOW + 13 * 100 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const first = await request(db, `${base}?limit=2&dir=b`);
    expect(first.status).toBe(200);
    const b1 = first.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(b1.chunk).toHaveLength(2);
    expect(b1.next_batch).toBeTruthy();

    const second = await request(db, `${base}?limit=2&dir=b&from=${b1.next_batch}`);
    expect(second.status).toBe(200);
    const b2 = second.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(b2.chunk).toHaveLength(2);
    expect(b2.chunk[0].event_id).not.toBe(b1.chunk[0].event_id);

    const third = await request(db, `${base}?limit=2&dir=b&from=${b2.next_batch}`);
    expect(third.status).toBe(200);
    const b3 = third.body as { chunk: Array<{ event_id: string }>; next_batch?: string };
    expect(b3.chunk).toHaveLength(2);
    expect(b3.next_batch).toBeUndefined();
  });

  it('paginate lifecycle soft-14', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$life14-${j}`, origin_server_ts: NOW + 14 * 100 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const first = await request(db, `${base}?limit=2&dir=b`);
    expect(first.status).toBe(200);
    const b1 = first.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(b1.chunk).toHaveLength(2);
    expect(b1.next_batch).toBeTruthy();

    const second = await request(db, `${base}?limit=2&dir=b&from=${b1.next_batch}`);
    expect(second.status).toBe(200);
    const b2 = second.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(b2.chunk).toHaveLength(2);
    expect(b2.chunk[0].event_id).not.toBe(b1.chunk[0].event_id);

    const third = await request(db, `${base}?limit=2&dir=b&from=${b2.next_batch}`);
    expect(third.status).toBe(200);
    const b3 = third.body as { chunk: Array<{ event_id: string }>; next_batch?: string };
    expect(b3.chunk).toHaveLength(2);
    expect(b3.next_batch).toBeUndefined();
  });

  it('paginate lifecycle soft-15', async () => {
    const events = Array.from({ length: 6 }, (_, j) =>
      child({ event_id: `$life15-${j}`, origin_server_ts: NOW + 15 * 100 + j })
    );
    const db = createRelationsDb({ memberships: [joinMember()], events });
    const first = await request(db, `${base}?limit=2&dir=b`);
    expect(first.status).toBe(200);
    const b1 = first.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch?: string;
    };
    expect(b1.chunk).toHaveLength(2);
    expect(b1.next_batch).toBeTruthy();

    const second = await request(db, `${base}?limit=2&dir=b&from=${b1.next_batch}`);
    expect(second.status).toBe(200);
    const b2 = second.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(b2.chunk).toHaveLength(2);
    expect(b2.chunk[0].event_id).not.toBe(b1.chunk[0].event_id);

    const third = await request(db, `${base}?limit=2&dir=b&from=${b2.next_batch}`);
    expect(third.status).toBe(200);
    const b3 = third.body as { chunk: Array<{ event_id: string }>; next_batch?: string };
    expect(b3.chunk).toHaveLength(2);
    expect(b3.next_batch).toBeUndefined();
  });
});


describe('relations leftovers concurrent select accounting after #175', () => {

  it('parallel GETs isolate soft-0', async () => {
    const dbA = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$parA0', origin_server_ts: NOW + 0 })],
    });
    const dbB = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$parB0a', origin_server_ts: NOW + 0 }),
        child({ event_id: '$parB0b', origin_server_ts: NOW + 0 + 1 }),
      ],
    });
    const [a, b] = await Promise.all([request(dbA, base), request(dbB, base)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.body as { chunk: unknown[] }).chunk).toHaveLength(1);
    expect((b.body as { chunk: unknown[] }).chunk).toHaveLength(2);
    expect(dbA.selects.length).toBeGreaterThanOrEqual(2);
    expect(dbB.selects.length).toBeGreaterThanOrEqual(2);
  });

  it('parallel GETs isolate soft-1', async () => {
    const dbA = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$parA1', origin_server_ts: NOW + 1 })],
    });
    const dbB = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$parB1a', origin_server_ts: NOW + 1 }),
        child({ event_id: '$parB1b', origin_server_ts: NOW + 1 + 1 }),
      ],
    });
    const [a, b] = await Promise.all([request(dbA, base), request(dbB, base)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.body as { chunk: unknown[] }).chunk).toHaveLength(1);
    expect((b.body as { chunk: unknown[] }).chunk).toHaveLength(2);
    expect(dbA.selects.length).toBeGreaterThanOrEqual(2);
    expect(dbB.selects.length).toBeGreaterThanOrEqual(2);
  });

  it('parallel GETs isolate soft-2', async () => {
    const dbA = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$parA2', origin_server_ts: NOW + 2 })],
    });
    const dbB = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$parB2a', origin_server_ts: NOW + 2 }),
        child({ event_id: '$parB2b', origin_server_ts: NOW + 2 + 1 }),
      ],
    });
    const [a, b] = await Promise.all([request(dbA, base), request(dbB, base)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.body as { chunk: unknown[] }).chunk).toHaveLength(1);
    expect((b.body as { chunk: unknown[] }).chunk).toHaveLength(2);
    expect(dbA.selects.length).toBeGreaterThanOrEqual(2);
    expect(dbB.selects.length).toBeGreaterThanOrEqual(2);
  });

  it('parallel GETs isolate soft-3', async () => {
    const dbA = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$parA3', origin_server_ts: NOW + 3 })],
    });
    const dbB = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$parB3a', origin_server_ts: NOW + 3 }),
        child({ event_id: '$parB3b', origin_server_ts: NOW + 3 + 1 }),
      ],
    });
    const [a, b] = await Promise.all([request(dbA, base), request(dbB, base)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.body as { chunk: unknown[] }).chunk).toHaveLength(1);
    expect((b.body as { chunk: unknown[] }).chunk).toHaveLength(2);
    expect(dbA.selects.length).toBeGreaterThanOrEqual(2);
    expect(dbB.selects.length).toBeGreaterThanOrEqual(2);
  });

  it('parallel GETs isolate soft-4', async () => {
    const dbA = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$parA4', origin_server_ts: NOW + 4 })],
    });
    const dbB = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$parB4a', origin_server_ts: NOW + 4 }),
        child({ event_id: '$parB4b', origin_server_ts: NOW + 4 + 1 }),
      ],
    });
    const [a, b] = await Promise.all([request(dbA, base), request(dbB, base)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.body as { chunk: unknown[] }).chunk).toHaveLength(1);
    expect((b.body as { chunk: unknown[] }).chunk).toHaveLength(2);
    expect(dbA.selects.length).toBeGreaterThanOrEqual(2);
    expect(dbB.selects.length).toBeGreaterThanOrEqual(2);
  });

  it('parallel GETs isolate soft-5', async () => {
    const dbA = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$parA5', origin_server_ts: NOW + 5 })],
    });
    const dbB = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$parB5a', origin_server_ts: NOW + 5 }),
        child({ event_id: '$parB5b', origin_server_ts: NOW + 5 + 1 }),
      ],
    });
    const [a, b] = await Promise.all([request(dbA, base), request(dbB, base)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.body as { chunk: unknown[] }).chunk).toHaveLength(1);
    expect((b.body as { chunk: unknown[] }).chunk).toHaveLength(2);
    expect(dbA.selects.length).toBeGreaterThanOrEqual(2);
    expect(dbB.selects.length).toBeGreaterThanOrEqual(2);
  });

  it('parallel GETs isolate soft-6', async () => {
    const dbA = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$parA6', origin_server_ts: NOW + 6 })],
    });
    const dbB = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$parB6a', origin_server_ts: NOW + 6 }),
        child({ event_id: '$parB6b', origin_server_ts: NOW + 6 + 1 }),
      ],
    });
    const [a, b] = await Promise.all([request(dbA, base), request(dbB, base)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.body as { chunk: unknown[] }).chunk).toHaveLength(1);
    expect((b.body as { chunk: unknown[] }).chunk).toHaveLength(2);
    expect(dbA.selects.length).toBeGreaterThanOrEqual(2);
    expect(dbB.selects.length).toBeGreaterThanOrEqual(2);
  });

  it('parallel GETs isolate soft-7', async () => {
    const dbA = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$parA7', origin_server_ts: NOW + 7 })],
    });
    const dbB = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$parB7a', origin_server_ts: NOW + 7 }),
        child({ event_id: '$parB7b', origin_server_ts: NOW + 7 + 1 }),
      ],
    });
    const [a, b] = await Promise.all([request(dbA, base), request(dbB, base)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.body as { chunk: unknown[] }).chunk).toHaveLength(1);
    expect((b.body as { chunk: unknown[] }).chunk).toHaveLength(2);
    expect(dbA.selects.length).toBeGreaterThanOrEqual(2);
    expect(dbB.selects.length).toBeGreaterThanOrEqual(2);
  });

  it('parallel GETs isolate soft-8', async () => {
    const dbA = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$parA8', origin_server_ts: NOW + 8 })],
    });
    const dbB = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$parB8a', origin_server_ts: NOW + 8 }),
        child({ event_id: '$parB8b', origin_server_ts: NOW + 8 + 1 }),
      ],
    });
    const [a, b] = await Promise.all([request(dbA, base), request(dbB, base)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.body as { chunk: unknown[] }).chunk).toHaveLength(1);
    expect((b.body as { chunk: unknown[] }).chunk).toHaveLength(2);
    expect(dbA.selects.length).toBeGreaterThanOrEqual(2);
    expect(dbB.selects.length).toBeGreaterThanOrEqual(2);
  });

  it('parallel GETs isolate soft-9', async () => {
    const dbA = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$parA9', origin_server_ts: NOW + 9 })],
    });
    const dbB = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$parB9a', origin_server_ts: NOW + 9 }),
        child({ event_id: '$parB9b', origin_server_ts: NOW + 9 + 1 }),
      ],
    });
    const [a, b] = await Promise.all([request(dbA, base), request(dbB, base)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.body as { chunk: unknown[] }).chunk).toHaveLength(1);
    expect((b.body as { chunk: unknown[] }).chunk).toHaveLength(2);
    expect(dbA.selects.length).toBeGreaterThanOrEqual(2);
    expect(dbB.selects.length).toBeGreaterThanOrEqual(2);
  });

  it('parallel GETs isolate soft-10', async () => {
    const dbA = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$parA10', origin_server_ts: NOW + 10 })],
    });
    const dbB = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$parB10a', origin_server_ts: NOW + 10 }),
        child({ event_id: '$parB10b', origin_server_ts: NOW + 10 + 1 }),
      ],
    });
    const [a, b] = await Promise.all([request(dbA, base), request(dbB, base)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.body as { chunk: unknown[] }).chunk).toHaveLength(1);
    expect((b.body as { chunk: unknown[] }).chunk).toHaveLength(2);
    expect(dbA.selects.length).toBeGreaterThanOrEqual(2);
    expect(dbB.selects.length).toBeGreaterThanOrEqual(2);
  });

  it('parallel GETs isolate soft-11', async () => {
    const dbA = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$parA11', origin_server_ts: NOW + 11 })],
    });
    const dbB = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$parB11a', origin_server_ts: NOW + 11 }),
        child({ event_id: '$parB11b', origin_server_ts: NOW + 11 + 1 }),
      ],
    });
    const [a, b] = await Promise.all([request(dbA, base), request(dbB, base)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.body as { chunk: unknown[] }).chunk).toHaveLength(1);
    expect((b.body as { chunk: unknown[] }).chunk).toHaveLength(2);
    expect(dbA.selects.length).toBeGreaterThanOrEqual(2);
    expect(dbB.selects.length).toBeGreaterThanOrEqual(2);
  });

  it('parallel GETs isolate soft-12', async () => {
    const dbA = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$parA12', origin_server_ts: NOW + 12 })],
    });
    const dbB = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$parB12a', origin_server_ts: NOW + 12 }),
        child({ event_id: '$parB12b', origin_server_ts: NOW + 12 + 1 }),
      ],
    });
    const [a, b] = await Promise.all([request(dbA, base), request(dbB, base)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.body as { chunk: unknown[] }).chunk).toHaveLength(1);
    expect((b.body as { chunk: unknown[] }).chunk).toHaveLength(2);
    expect(dbA.selects.length).toBeGreaterThanOrEqual(2);
    expect(dbB.selects.length).toBeGreaterThanOrEqual(2);
  });

  it('parallel GETs isolate soft-13', async () => {
    const dbA = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$parA13', origin_server_ts: NOW + 13 })],
    });
    const dbB = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$parB13a', origin_server_ts: NOW + 13 }),
        child({ event_id: '$parB13b', origin_server_ts: NOW + 13 + 1 }),
      ],
    });
    const [a, b] = await Promise.all([request(dbA, base), request(dbB, base)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.body as { chunk: unknown[] }).chunk).toHaveLength(1);
    expect((b.body as { chunk: unknown[] }).chunk).toHaveLength(2);
    expect(dbA.selects.length).toBeGreaterThanOrEqual(2);
    expect(dbB.selects.length).toBeGreaterThanOrEqual(2);
  });

  it('parallel GETs isolate soft-14', async () => {
    const dbA = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$parA14', origin_server_ts: NOW + 14 })],
    });
    const dbB = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$parB14a', origin_server_ts: NOW + 14 }),
        child({ event_id: '$parB14b', origin_server_ts: NOW + 14 + 1 }),
      ],
    });
    const [a, b] = await Promise.all([request(dbA, base), request(dbB, base)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.body as { chunk: unknown[] }).chunk).toHaveLength(1);
    expect((b.body as { chunk: unknown[] }).chunk).toHaveLength(2);
    expect(dbA.selects.length).toBeGreaterThanOrEqual(2);
    expect(dbB.selects.length).toBeGreaterThanOrEqual(2);
  });

  it('parallel GETs isolate soft-15', async () => {
    const dbA = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$parA15', origin_server_ts: NOW + 15 })],
    });
    const dbB = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$parB15a', origin_server_ts: NOW + 15 }),
        child({ event_id: '$parB15b', origin_server_ts: NOW + 15 + 1 }),
      ],
    });
    const [a, b] = await Promise.all([request(dbA, base), request(dbB, base)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.body as { chunk: unknown[] }).chunk).toHaveLength(1);
    expect((b.body as { chunk: unknown[] }).chunk).toHaveLength(2);
    expect(dbA.selects.length).toBeGreaterThanOrEqual(2);
    expect(dbB.selects.length).toBeGreaterThanOrEqual(2);
  });
});


describe('relations leftovers room isolation soft flood after #175', () => {

  it('room isolation soft-0', async () => {
    const otherRoom = '!other0:example.com';
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$in0', origin_server_ts: NOW + 0 }),
        child({
          event_id: '$out0',
          room_id: otherRoom,
          origin_server_ts: NOW + 0 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$in0']);
  });

  it('room isolation soft-1', async () => {
    const otherRoom = '!other1:example.com';
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$in1', origin_server_ts: NOW + 1 }),
        child({
          event_id: '$out1',
          room_id: otherRoom,
          origin_server_ts: NOW + 1 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$in1']);
  });

  it('room isolation soft-2', async () => {
    const otherRoom = '!other2:example.com';
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$in2', origin_server_ts: NOW + 2 }),
        child({
          event_id: '$out2',
          room_id: otherRoom,
          origin_server_ts: NOW + 2 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$in2']);
  });

  it('room isolation soft-3', async () => {
    const otherRoom = '!other3:example.com';
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$in3', origin_server_ts: NOW + 3 }),
        child({
          event_id: '$out3',
          room_id: otherRoom,
          origin_server_ts: NOW + 3 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$in3']);
  });

  it('room isolation soft-4', async () => {
    const otherRoom = '!other4:example.com';
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$in4', origin_server_ts: NOW + 4 }),
        child({
          event_id: '$out4',
          room_id: otherRoom,
          origin_server_ts: NOW + 4 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$in4']);
  });

  it('room isolation soft-5', async () => {
    const otherRoom = '!other5:example.com';
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$in5', origin_server_ts: NOW + 5 }),
        child({
          event_id: '$out5',
          room_id: otherRoom,
          origin_server_ts: NOW + 5 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$in5']);
  });

  it('room isolation soft-6', async () => {
    const otherRoom = '!other6:example.com';
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$in6', origin_server_ts: NOW + 6 }),
        child({
          event_id: '$out6',
          room_id: otherRoom,
          origin_server_ts: NOW + 6 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$in6']);
  });

  it('room isolation soft-7', async () => {
    const otherRoom = '!other7:example.com';
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$in7', origin_server_ts: NOW + 7 }),
        child({
          event_id: '$out7',
          room_id: otherRoom,
          origin_server_ts: NOW + 7 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$in7']);
  });

  it('room isolation soft-8', async () => {
    const otherRoom = '!other8:example.com';
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$in8', origin_server_ts: NOW + 8 }),
        child({
          event_id: '$out8',
          room_id: otherRoom,
          origin_server_ts: NOW + 8 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$in8']);
  });

  it('room isolation soft-9', async () => {
    const otherRoom = '!other9:example.com';
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$in9', origin_server_ts: NOW + 9 }),
        child({
          event_id: '$out9',
          room_id: otherRoom,
          origin_server_ts: NOW + 9 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$in9']);
  });

  it('room isolation soft-10', async () => {
    const otherRoom = '!other10:example.com';
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$in10', origin_server_ts: NOW + 10 }),
        child({
          event_id: '$out10',
          room_id: otherRoom,
          origin_server_ts: NOW + 10 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$in10']);
  });

  it('room isolation soft-11', async () => {
    const otherRoom = '!other11:example.com';
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$in11', origin_server_ts: NOW + 11 }),
        child({
          event_id: '$out11',
          room_id: otherRoom,
          origin_server_ts: NOW + 11 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$in11']);
  });

  it('room isolation soft-12', async () => {
    const otherRoom = '!other12:example.com';
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$in12', origin_server_ts: NOW + 12 }),
        child({
          event_id: '$out12',
          room_id: otherRoom,
          origin_server_ts: NOW + 12 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$in12']);
  });

  it('room isolation soft-13', async () => {
    const otherRoom = '!other13:example.com';
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$in13', origin_server_ts: NOW + 13 }),
        child({
          event_id: '$out13',
          room_id: otherRoom,
          origin_server_ts: NOW + 13 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$in13']);
  });

  it('room isolation soft-14', async () => {
    const otherRoom = '!other14:example.com';
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$in14', origin_server_ts: NOW + 14 }),
        child({
          event_id: '$out14',
          room_id: otherRoom,
          origin_server_ts: NOW + 14 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$in14']);
  });

  it('room isolation soft-15', async () => {
    const otherRoom = '!other15:example.com';
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$in15', origin_server_ts: NOW + 15 }),
        child({
          event_id: '$out15',
          room_id: otherRoom,
          origin_server_ts: NOW + 15 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$in15']);
  });
});


describe('relations leftovers parent isolation soft flood after #175', () => {

  it('parent isolation soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$hit0', origin_server_ts: NOW + 0 }),
        child({
          event_id: '$miss0',
          relates_to_event_id: `$other-parent0:example.com`,
          origin_server_ts: NOW + 0 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$hit0']);
  });

  it('parent isolation soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$hit1', origin_server_ts: NOW + 1 }),
        child({
          event_id: '$miss1',
          relates_to_event_id: `$other-parent1:example.com`,
          origin_server_ts: NOW + 1 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$hit1']);
  });

  it('parent isolation soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$hit2', origin_server_ts: NOW + 2 }),
        child({
          event_id: '$miss2',
          relates_to_event_id: `$other-parent2:example.com`,
          origin_server_ts: NOW + 2 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$hit2']);
  });

  it('parent isolation soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$hit3', origin_server_ts: NOW + 3 }),
        child({
          event_id: '$miss3',
          relates_to_event_id: `$other-parent3:example.com`,
          origin_server_ts: NOW + 3 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$hit3']);
  });

  it('parent isolation soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$hit4', origin_server_ts: NOW + 4 }),
        child({
          event_id: '$miss4',
          relates_to_event_id: `$other-parent4:example.com`,
          origin_server_ts: NOW + 4 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$hit4']);
  });

  it('parent isolation soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$hit5', origin_server_ts: NOW + 5 }),
        child({
          event_id: '$miss5',
          relates_to_event_id: `$other-parent5:example.com`,
          origin_server_ts: NOW + 5 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$hit5']);
  });

  it('parent isolation soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$hit6', origin_server_ts: NOW + 6 }),
        child({
          event_id: '$miss6',
          relates_to_event_id: `$other-parent6:example.com`,
          origin_server_ts: NOW + 6 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$hit6']);
  });

  it('parent isolation soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$hit7', origin_server_ts: NOW + 7 }),
        child({
          event_id: '$miss7',
          relates_to_event_id: `$other-parent7:example.com`,
          origin_server_ts: NOW + 7 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$hit7']);
  });

  it('parent isolation soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$hit8', origin_server_ts: NOW + 8 }),
        child({
          event_id: '$miss8',
          relates_to_event_id: `$other-parent8:example.com`,
          origin_server_ts: NOW + 8 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$hit8']);
  });

  it('parent isolation soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$hit9', origin_server_ts: NOW + 9 }),
        child({
          event_id: '$miss9',
          relates_to_event_id: `$other-parent9:example.com`,
          origin_server_ts: NOW + 9 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$hit9']);
  });

  it('parent isolation soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$hit10', origin_server_ts: NOW + 10 }),
        child({
          event_id: '$miss10',
          relates_to_event_id: `$other-parent10:example.com`,
          origin_server_ts: NOW + 10 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$hit10']);
  });

  it('parent isolation soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$hit11', origin_server_ts: NOW + 11 }),
        child({
          event_id: '$miss11',
          relates_to_event_id: `$other-parent11:example.com`,
          origin_server_ts: NOW + 11 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$hit11']);
  });

  it('parent isolation soft-12', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$hit12', origin_server_ts: NOW + 12 }),
        child({
          event_id: '$miss12',
          relates_to_event_id: `$other-parent12:example.com`,
          origin_server_ts: NOW + 12 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$hit12']);
  });

  it('parent isolation soft-13', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$hit13', origin_server_ts: NOW + 13 }),
        child({
          event_id: '$miss13',
          relates_to_event_id: `$other-parent13:example.com`,
          origin_server_ts: NOW + 13 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$hit13']);
  });

  it('parent isolation soft-14', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$hit14', origin_server_ts: NOW + 14 }),
        child({
          event_id: '$miss14',
          relates_to_event_id: `$other-parent14:example.com`,
          origin_server_ts: NOW + 14 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$hit14']);
  });

  it('parent isolation soft-15', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$hit15', origin_server_ts: NOW + 15 }),
        child({
          event_id: '$miss15',
          relates_to_event_id: `$other-parent15:example.com`,
          origin_server_ts: NOW + 15 + 1,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$hit15']);
  });
});


describe('relations leftovers content shape soft flood after #175', () => {

  it('content shape soft-0', async () => {
    const content = "{}";
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$shape0',
          origin_server_ts: NOW + 0,
          content,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ content: unknown }> };
    expect(body.chunk[0].content).toEqual(JSON.parse(content));
  });

  it('content shape soft-1', async () => {
    const content = "{\"key\":\"x\"}";
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$shape1',
          origin_server_ts: NOW + 1,
          content,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ content: unknown }> };
    expect(body.chunk[0].content).toEqual(JSON.parse(content));
  });

  it('content shape soft-2', async () => {
    const content = "{\"m.relates_to\":{\"rel_type\":\"m.annotation\",\"key\":\"A\"}}";
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$shape2',
          origin_server_ts: NOW + 2,
          content,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ content: unknown }> };
    expect(body.chunk[0].content).toEqual(JSON.parse(content));
  });

  it('content shape soft-3', async () => {
    const content = "{\"body\":\"\",\"msgtype\":\"m.text\"}";
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$shape3',
          origin_server_ts: NOW + 3,
          content,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ content: unknown }> };
    expect(body.chunk[0].content).toEqual(JSON.parse(content));
  });

  it('content shape soft-4', async () => {
    const content = "{\"nested\":{\"a\":[1,2,3]}}";
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$shape4',
          origin_server_ts: NOW + 4,
          content,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ content: unknown }> };
    expect(body.chunk[0].content).toEqual(JSON.parse(content));
  });

  it('content shape soft-5', async () => {
    const content = "{\"unicode\":\"hello\"}";
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$shape5',
          origin_server_ts: NOW + 5,
          content,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ content: unknown }> };
    expect(body.chunk[0].content).toEqual(JSON.parse(content));
  });

  it('content shape soft-6', async () => {
    const content = "{\"empty_arr\":[]}";
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$shape6',
          origin_server_ts: NOW + 6,
          content,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ content: unknown }> };
    expect(body.chunk[0].content).toEqual(JSON.parse(content));
  });

  it('content shape soft-7', async () => {
    const content = "{\"nullish\":null}";
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$shape7',
          origin_server_ts: NOW + 7,
          content,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ content: unknown }> };
    expect(body.chunk[0].content).toEqual(JSON.parse(content));
  });

  it('content shape soft-8', async () => {
    const content = "{\"bool\":true}";
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$shape8',
          origin_server_ts: NOW + 8,
          content,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ content: unknown }> };
    expect(body.chunk[0].content).toEqual(JSON.parse(content));
  });

  it('content shape soft-9', async () => {
    const content = "{\"n\":0}";
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$shape9',
          origin_server_ts: NOW + 9,
          content,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ content: unknown }> };
    expect(body.chunk[0].content).toEqual(JSON.parse(content));
  });

  it('content shape soft-10', async () => {
    const content = "{\"long\":\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"}";
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$shape10',
          origin_server_ts: NOW + 10,
          content,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ content: unknown }> };
    expect(body.chunk[0].content).toEqual(JSON.parse(content));
  });

  it('content shape soft-11', async () => {
    const content = "{\"m.new_content\":{\"body\":\"edit\"}}";
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$shape11',
          origin_server_ts: NOW + 11,
          content,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ content: unknown }> };
    expect(body.chunk[0].content).toEqual(JSON.parse(content));
  });

  it('content shape soft-12', async () => {
    const content = "{\"url\":\"mxc://example.com/abc\"}";
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$shape12',
          origin_server_ts: NOW + 12,
          content,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ content: unknown }> };
    expect(body.chunk[0].content).toEqual(JSON.parse(content));
  });

  it('content shape soft-13', async () => {
    const content = "{\"info\":{\"w\":1,\"h\":1}}";
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$shape13',
          origin_server_ts: NOW + 13,
          content,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ content: unknown }> };
    expect(body.chunk[0].content).toEqual(JSON.parse(content));
  });

  it('content shape soft-14', async () => {
    const content = "{\"m.mentions\":{}}";
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$shape14',
          origin_server_ts: NOW + 14,
          content,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ content: unknown }> };
    expect(body.chunk[0].content).toEqual(JSON.parse(content));
  });

  it('content shape soft-15', async () => {
    const content = "{\"formatted_body\":\"<b>x</b>\",\"format\":\"org.matrix.custom.html\"}";
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$shape15',
          origin_server_ts: NOW + 15,
          content,
        }),
      ],
    });
    const res = await request(db, base);
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ content: unknown }> };
    expect(body.chunk[0].content).toEqual(JSON.parse(content));
  });
});


describe('relations leftovers SQL bind contracts after #175', () => {

  it('all-relations bind soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$bind0', origin_server_ts: NOW + 0 })],
    });
    const res = await request(db, `${base}?from=1700000000050&dir=b&limit=10`);
    expect(res.status).toBe(200);
    const mem = db.selects.find((s) => s.sql.includes('room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const ev = db.selects.find((s) => s.sql.includes('FROM events e'));
    expect(ev?.args[0]).toBe(ROOM);
    expect(ev?.args[1]).toBe(PARENT);
    expect(ev?.args).toContain(1700000000050);
  });

  it('all-relations bind soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$bind1', origin_server_ts: NOW + 1 })],
    });
    const res = await request(db, `${base}?from=1700000000051&dir=b&limit=10`);
    expect(res.status).toBe(200);
    const mem = db.selects.find((s) => s.sql.includes('room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const ev = db.selects.find((s) => s.sql.includes('FROM events e'));
    expect(ev?.args[0]).toBe(ROOM);
    expect(ev?.args[1]).toBe(PARENT);
    expect(ev?.args).toContain(1700000000051);
  });

  it('all-relations bind soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$bind2', origin_server_ts: NOW + 2 })],
    });
    const res = await request(db, `${base}?from=1700000000052&dir=b&limit=10`);
    expect(res.status).toBe(200);
    const mem = db.selects.find((s) => s.sql.includes('room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const ev = db.selects.find((s) => s.sql.includes('FROM events e'));
    expect(ev?.args[0]).toBe(ROOM);
    expect(ev?.args[1]).toBe(PARENT);
    expect(ev?.args).toContain(1700000000052);
  });

  it('all-relations bind soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$bind3', origin_server_ts: NOW + 3 })],
    });
    const res = await request(db, `${base}?from=1700000000053&dir=b&limit=10`);
    expect(res.status).toBe(200);
    const mem = db.selects.find((s) => s.sql.includes('room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const ev = db.selects.find((s) => s.sql.includes('FROM events e'));
    expect(ev?.args[0]).toBe(ROOM);
    expect(ev?.args[1]).toBe(PARENT);
    expect(ev?.args).toContain(1700000000053);
  });

  it('all-relations bind soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$bind4', origin_server_ts: NOW + 4 })],
    });
    const res = await request(db, `${base}?from=1700000000054&dir=b&limit=10`);
    expect(res.status).toBe(200);
    const mem = db.selects.find((s) => s.sql.includes('room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const ev = db.selects.find((s) => s.sql.includes('FROM events e'));
    expect(ev?.args[0]).toBe(ROOM);
    expect(ev?.args[1]).toBe(PARENT);
    expect(ev?.args).toContain(1700000000054);
  });

  it('all-relations bind soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$bind5', origin_server_ts: NOW + 5 })],
    });
    const res = await request(db, `${base}?from=1700000000055&dir=b&limit=10`);
    expect(res.status).toBe(200);
    const mem = db.selects.find((s) => s.sql.includes('room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const ev = db.selects.find((s) => s.sql.includes('FROM events e'));
    expect(ev?.args[0]).toBe(ROOM);
    expect(ev?.args[1]).toBe(PARENT);
    expect(ev?.args).toContain(1700000000055);
  });

  it('all-relations bind soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$bind6', origin_server_ts: NOW + 6 })],
    });
    const res = await request(db, `${base}?from=1700000000056&dir=b&limit=10`);
    expect(res.status).toBe(200);
    const mem = db.selects.find((s) => s.sql.includes('room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const ev = db.selects.find((s) => s.sql.includes('FROM events e'));
    expect(ev?.args[0]).toBe(ROOM);
    expect(ev?.args[1]).toBe(PARENT);
    expect(ev?.args).toContain(1700000000056);
  });

  it('all-relations bind soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$bind7', origin_server_ts: NOW + 7 })],
    });
    const res = await request(db, `${base}?from=1700000000057&dir=b&limit=10`);
    expect(res.status).toBe(200);
    const mem = db.selects.find((s) => s.sql.includes('room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const ev = db.selects.find((s) => s.sql.includes('FROM events e'));
    expect(ev?.args[0]).toBe(ROOM);
    expect(ev?.args[1]).toBe(PARENT);
    expect(ev?.args).toContain(1700000000057);
  });

  it('all-relations bind soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$bind8', origin_server_ts: NOW + 8 })],
    });
    const res = await request(db, `${base}?from=1700000000058&dir=b&limit=10`);
    expect(res.status).toBe(200);
    const mem = db.selects.find((s) => s.sql.includes('room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const ev = db.selects.find((s) => s.sql.includes('FROM events e'));
    expect(ev?.args[0]).toBe(ROOM);
    expect(ev?.args[1]).toBe(PARENT);
    expect(ev?.args).toContain(1700000000058);
  });

  it('all-relations bind soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$bind9', origin_server_ts: NOW + 9 })],
    });
    const res = await request(db, `${base}?from=1700000000059&dir=b&limit=10`);
    expect(res.status).toBe(200);
    const mem = db.selects.find((s) => s.sql.includes('room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const ev = db.selects.find((s) => s.sql.includes('FROM events e'));
    expect(ev?.args[0]).toBe(ROOM);
    expect(ev?.args[1]).toBe(PARENT);
    expect(ev?.args).toContain(1700000000059);
  });

  it('all-relations bind soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$bind10', origin_server_ts: NOW + 10 })],
    });
    const res = await request(db, `${base}?from=1700000000060&dir=b&limit=10`);
    expect(res.status).toBe(200);
    const mem = db.selects.find((s) => s.sql.includes('room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const ev = db.selects.find((s) => s.sql.includes('FROM events e'));
    expect(ev?.args[0]).toBe(ROOM);
    expect(ev?.args[1]).toBe(PARENT);
    expect(ev?.args).toContain(1700000000060);
  });

  it('all-relations bind soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$bind11', origin_server_ts: NOW + 11 })],
    });
    const res = await request(db, `${base}?from=1700000000061&dir=b&limit=10`);
    expect(res.status).toBe(200);
    const mem = db.selects.find((s) => s.sql.includes('room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
    const ev = db.selects.find((s) => s.sql.includes('FROM events e'));
    expect(ev?.args[0]).toBe(ROOM);
    expect(ev?.args[1]).toBe(PARENT);
    expect(ev?.args).toContain(1700000000061);
  });

  it('typed bind soft-0', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$tbind0',
          origin_server_ts: NOW + 0,
          relation_type: 'm.annotation',
          event_type: 'm.reaction',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction?limit=5`);
    expect(res.status).toBe(200);
    const ev = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(ev?.args.slice(0, 4)).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction']);
  });

  it('typed bind soft-1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$tbind1',
          origin_server_ts: NOW + 1,
          relation_type: 'm.annotation',
          event_type: 'm.reaction',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction?limit=5`);
    expect(res.status).toBe(200);
    const ev = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(ev?.args.slice(0, 4)).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction']);
  });

  it('typed bind soft-2', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$tbind2',
          origin_server_ts: NOW + 2,
          relation_type: 'm.annotation',
          event_type: 'm.reaction',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction?limit=5`);
    expect(res.status).toBe(200);
    const ev = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(ev?.args.slice(0, 4)).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction']);
  });

  it('typed bind soft-3', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$tbind3',
          origin_server_ts: NOW + 3,
          relation_type: 'm.annotation',
          event_type: 'm.reaction',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction?limit=5`);
    expect(res.status).toBe(200);
    const ev = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(ev?.args.slice(0, 4)).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction']);
  });

  it('typed bind soft-4', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$tbind4',
          origin_server_ts: NOW + 4,
          relation_type: 'm.annotation',
          event_type: 'm.reaction',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction?limit=5`);
    expect(res.status).toBe(200);
    const ev = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(ev?.args.slice(0, 4)).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction']);
  });

  it('typed bind soft-5', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$tbind5',
          origin_server_ts: NOW + 5,
          relation_type: 'm.annotation',
          event_type: 'm.reaction',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction?limit=5`);
    expect(res.status).toBe(200);
    const ev = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(ev?.args.slice(0, 4)).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction']);
  });

  it('typed bind soft-6', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$tbind6',
          origin_server_ts: NOW + 6,
          relation_type: 'm.annotation',
          event_type: 'm.reaction',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction?limit=5`);
    expect(res.status).toBe(200);
    const ev = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(ev?.args.slice(0, 4)).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction']);
  });

  it('typed bind soft-7', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$tbind7',
          origin_server_ts: NOW + 7,
          relation_type: 'm.annotation',
          event_type: 'm.reaction',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction?limit=5`);
    expect(res.status).toBe(200);
    const ev = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(ev?.args.slice(0, 4)).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction']);
  });

  it('typed bind soft-8', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$tbind8',
          origin_server_ts: NOW + 8,
          relation_type: 'm.annotation',
          event_type: 'm.reaction',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction?limit=5`);
    expect(res.status).toBe(200);
    const ev = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(ev?.args.slice(0, 4)).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction']);
  });

  it('typed bind soft-9', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$tbind9',
          origin_server_ts: NOW + 9,
          relation_type: 'm.annotation',
          event_type: 'm.reaction',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction?limit=5`);
    expect(res.status).toBe(200);
    const ev = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(ev?.args.slice(0, 4)).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction']);
  });

  it('typed bind soft-10', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$tbind10',
          origin_server_ts: NOW + 10,
          relation_type: 'm.annotation',
          event_type: 'm.reaction',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction?limit=5`);
    expect(res.status).toBe(200);
    const ev = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(ev?.args.slice(0, 4)).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction']);
  });

  it('typed bind soft-11', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$tbind11',
          origin_server_ts: NOW + 11,
          relation_type: 'm.annotation',
          event_type: 'm.reaction',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction?limit=5`);
    expect(res.status).toBe(200);
    const ev = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(ev?.args.slice(0, 4)).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction']);
  });
});

