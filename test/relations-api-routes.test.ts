/**
 * TOKENMAXX HEAVY deepen — different slice: relations / threads API routes.
 * Avoids search (#94), key-backups (#96), oauth (#90), spaces (#89), devices/aliases siblings.
 * Tests-only — no product inventing.
 * Exercises membership gates, pagination dirs, relType/eventType filters, threads include.
 */
import { describe, expect, it, vi } from 'vitest';
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

import relations from '../src/api/relations';

const USER = '@alice:example.com';
const ROOM = '!room:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const PARENT = '$parent:example.com';
const PARENT_ENC = encodeURIComponent(PARENT);

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

              // Threads list: DISTINCT roots that have m.thread children
              if (
                sql.includes('relation_type = \'m.thread\'') ||
                sql.includes("relation_type = 'm.thread'")
              ) {
                // This is the threads endpoint (IN subquery)
                if (sql.includes('event_id IN')) {
                  const roomId = args[0] as string;
                  const dir = parseOrder(sql);
                  let limit = args[args.length - 1] as number;
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
                  if (sql.includes('participated') || sql.includes('e.sender = ?')) {
                    // include=participated binds userId twice before limit
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
                      content: e.content,
                    })) as T[],
                  };
                }
              }

              // Generic relations query
              if (
                sql.includes('FROM events e') &&
                sql.includes('relates_to_event_id')
              ) {
                const roomId = args[0] as string;
                const eventId = args[1] as string;
                const dir = parseOrder(sql);

                let filtered = events.filter(
                  (e) =>
                    e.room_id === roomId && e.relates_to_event_id === eventId
                );

                // Detect filters from SQL shape / args
                const hasRelType =
                  sql.includes('relation_type = ?') &&
                  !sql.includes('event_type = ?');
                const hasRelAndEventType =
                  sql.includes('relation_type = ?') &&
                  sql.includes('event_type = ?');

                let argIdx = 2;
                if (hasRelAndEventType) {
                  const relType = args[argIdx++] as string;
                  const eventType = args[argIdx++] as string;
                  filtered = filtered.filter(
                    (e) =>
                      e.relation_type === relType && e.event_type === eventType
                  );
                } else if (hasRelType) {
                  const relType = args[argIdx++] as string;
                  filtered = filtered.filter((e) => e.relation_type === relType);
                }

                // from pagination (only on untyped relations endpoint)
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
                    content: e.content,
                  })) as T[],
                };
              }

              throw new Error(`Unhandled all() SQL: ${sql.slice(0, 180)}`);
            },

            async run() {
              throw new Error(`Unexpected run() in relations tests: ${sql.slice(0, 80)}`);
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
): Promise<{ status: number; body: unknown }> {
  const res = await relations.request(
    `http://localhost${path}`,
    init,
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
  return { status: res.status, body };
}

function authGet(path: string): Promise<{ status: number; body: unknown }> {
  // helper unused — keep request explicit
  void path;
  return Promise.resolve({ status: 0, body: null });
}
void authGet;

function joinMember(): Membership {
  return { room_id: ROOM, user_id: USER, membership: 'join' };
}

function leaveMember(): Membership {
  return { room_id: ROOM, user_id: USER, membership: 'leave' };
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
    content: overrides.content ?? JSON.stringify({ 'm.relates_to': { rel_type: 'm.annotation' } }),
    relates_to_event_id: overrides.relates_to_event_id ?? PARENT,
    relation_type: overrides.relation_type ?? 'm.annotation',
  };
}

const base = `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}`;

describe('relations membership gates', () => {
  it.each([
    ['all relations', base],
    ['by relType', `${base}/m.annotation`],
    ['by relType+eventType', `${base}/m.annotation/m.reaction`],
    ['threads', `/_matrix/client/v1/rooms/${ROOM_ENC}/threads`],
  ])('forbids when membership missing — %s', async (_label, path) => {
    const db = createRelationsDb({ memberships: [] });
    const res = await request(db, path, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it.each([
    ['invite', 'invite'],
    ['ban', 'ban'],
    ['knock', 'knock'],
  ])('forbids membership=%s on all-relations', async (_label, membership) => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership }],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(403);
  });

  it('allows leave membership (historic access)', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$c1', origin_server_ts: 10 })],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(1);
  });
});

describe('relations GET all relations', () => {
  it('returns empty chunk when no children', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunk: [] });
  });

  it('maps events and parses content JSON; default dir=b (DESC)', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a', origin_server_ts: 100 }),
        child({ event_id: '$b', origin_server_ts: 200 }),
        child({ event_id: '$c', origin_server_ts: 300 }),
      ],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk: Array<{ event_id: string; type: string; room_id: string; content: unknown }>;
      next_batch?: string;
    };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$c', '$b', '$a']);
    expect(body.chunk[0]).toMatchObject({
      type: 'm.reaction',
      room_id: ROOM,
      content: { 'm.relates_to': { rel_type: 'm.annotation' } },
    });
    expect(body.next_batch).toBeUndefined();
  });

  it('dir=f orders ASC', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a', origin_server_ts: 100 }),
        child({ event_id: '$b', origin_server_ts: 200 }),
      ],
    });
    const res = await request(db, `${base}?dir=f`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$a', '$b']);
  });

  it('applies from cursor with dir=b (ts < from)', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a', origin_server_ts: 100 }),
        child({ event_id: '$b', origin_server_ts: 200 }),
        child({ event_id: '$c', origin_server_ts: 300 }),
      ],
    });
    const res = await request(db, `${base}?from=250&dir=b`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$b', '$a']);
  });

  it('applies from cursor with dir=f (ts > from)', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a', origin_server_ts: 100 }),
        child({ event_id: '$b', origin_server_ts: 200 }),
        child({ event_id: '$c', origin_server_ts: 300 }),
      ],
    });
    const res = await request(db, `${base}?from=150&dir=f`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$b', '$c']);
  });

  it('caps limit at 100 and emits next_batch when more remain', async () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      child({ event_id: `$e${i}`, origin_server_ts: (i + 1) * 10 })
    );
    const db = createRelationsDb({
      memberships: [joinMember()],
      events,
    });
    // limit=2 → fetch 3; return 2 + next_batch
    const res = await request(db, `${base}?limit=2&dir=b`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as {
      chunk: Array<{ event_id: string; origin_server_ts: number }>;
      next_batch: string;
    };
    expect(body.chunk).toHaveLength(2);
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$e4', '$e3']);
    expect(body.next_batch).toBe('40');

    // Ensure SQL limit was capped request: limit+1 = 3
    const relQuery = db.selects.find((s) => s.sql.includes('relates_to_event_id'));
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(3);
  });

  it('defaults limit to 50 (fetches 51)', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$a', origin_server_ts: 1 })],
    });
    await request(db, base, { headers: { Authorization: 'Bearer t' } });
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(51);
  });

  it('clamps absurd limit query to 100 (+1 fetch)', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [],
    });
    await request(db, `${base}?limit=9999`, {
      headers: { Authorization: 'Bearer t' },
    });
    const relQuery = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(relQuery?.args[relQuery.args.length - 1]).toBe(101);
  });

  it('ignores to= query param (reserved, voided)', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$a', origin_server_ts: 10 })],
    });
    const res = await request(db, `${base}?to=1&from=5&dir=f`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(1);
  });
});

describe('relations GET by relType', () => {
  it('filters to matching relation_type only', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ann',
          origin_server_ts: 1,
          relation_type: 'm.annotation',
        }),
        child({
          event_id: '$ref',
          origin_server_ts: 2,
          relation_type: 'm.reference',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$ann']);
  });

  it('paginates with next_batch for typed relations', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$1', origin_server_ts: 10, relation_type: 'm.annotation' }),
        child({ event_id: '$2', origin_server_ts: 20, relation_type: 'm.annotation' }),
        child({ event_id: '$3', origin_server_ts: 30, relation_type: 'm.annotation' }),
      ],
    });
    const res = await request(db, `${base}/m.annotation?limit=1&dir=b`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as {
      chunk: Array<{ event_id: string }>;
      next_batch: string;
    };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$3']);
    expect(body.next_batch).toBe('30');
  });

  it('dir=f ASC for typed relations', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$1', origin_server_ts: 10 }),
        child({ event_id: '$2', origin_server_ts: 20 }),
      ],
    });
    const res = await request(db, `${base}/m.annotation?dir=f`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$1', '$2']);
  });
});

describe('relations GET by relType + eventType', () => {
  it('filters both relation_type and event_type', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$r1',
          origin_server_ts: 1,
          relation_type: 'm.annotation',
          event_type: 'm.reaction',
        }),
        child({
          event_id: '$r2',
          origin_server_ts: 2,
          relation_type: 'm.annotation',
          event_type: 'm.room.message',
        }),
        child({
          event_id: '$r3',
          origin_server_ts: 3,
          relation_type: 'm.replace',
          event_type: 'm.reaction',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$r1', type: 'm.reaction' });
  });

  it('returns next_batch when typed+eventType page overflows', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a', origin_server_ts: 5, event_type: 'm.reaction' }),
        child({ event_id: '$b', origin_server_ts: 15, event_type: 'm.reaction' }),
      ],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction?limit=1`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as {
      chunk: Array<{ event_id: string }>;
      next_batch: string;
    };
    expect(body.chunk[0].event_id).toBe('$b');
    expect(body.next_batch).toBe('15');
  });
});

describe('relations GET threads', () => {
  const threadsPath = `/_matrix/client/v1/rooms/${ROOM_ENC}/threads`;

  function root(id: string, ts: number, sender = USER): EventRow {
    return {
      event_id: id,
      room_id: ROOM,
      event_type: 'm.room.message',
      sender,
      origin_server_ts: ts,
      content: JSON.stringify({ body: 'root' }),
      relates_to_event_id: null,
      relation_type: null,
    };
  }

  function threadReply(
    id: string,
    rootId: string,
    ts: number,
    sender = USER
  ): EventRow {
    return {
      event_id: id,
      room_id: ROOM,
      event_type: 'm.room.message',
      sender,
      origin_server_ts: ts,
      content: JSON.stringify({ body: 'reply' }),
      relates_to_event_id: rootId,
      relation_type: 'm.thread',
    };
  }

  it('lists thread roots newest-first', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        root('$r1', 100),
        root('$r2', 200),
        root('$lonely', 50),
        threadReply('$t1', '$r1', 110),
        threadReply('$t2', '$r2', 210),
      ],
    });
    const res = await request(db, threadsPath, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$r2', '$r1']);
  });

  it('include=participated filters to sender or participant replies', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        root('$mine', 100, USER),
        root('$theirs', 200, '@bob:example.com'),
        root('$joined', 300, '@carol:example.com'),
        threadReply('$a', '$mine', 101, '@bob:example.com'),
        threadReply('$b', '$theirs', 201, '@bob:example.com'),
        threadReply('$c', '$joined', 301, USER),
      ],
    });
    const res = await request(db, `${threadsPath}?include=participated`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as { chunk: Array<{ event_id: string }> };
    // mine (sender) + joined (user replied); theirs excluded
    expect(body.chunk.map((e) => e.event_id).sort()).toEqual(['$joined', '$mine']);
  });

  it('include=all (default) returns every thread root', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        root('$r1', 10, '@bob:example.com'),
        threadReply('$t1', '$r1', 11, '@carol:example.com'),
      ],
    });
    const res = await request(db, `${threadsPath}?include=all`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as { chunk: Array<{ event_id: string; content: unknown }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({
      event_id: '$r1',
      content: { body: 'root' },
      room_id: ROOM,
    });
  });

  it('respects limit on threads list', async () => {
    const events: EventRow[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(root(`$r${i}`, (i + 1) * 10));
      events.push(threadReply(`$t${i}`, `$r${i}`, (i + 1) * 10 + 1));
    }
    const db = createRelationsDb({
      memberships: [joinMember()],
      events,
    });
    const res = await request(db, `${threadsPath}?limit=2`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as { chunk: unknown[] };
    expect(body.chunk).toHaveLength(2);
  });

  it('forbids threads when not join/leave', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
    });
    const res = await request(db, threadsPath, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(403);
  });
});
