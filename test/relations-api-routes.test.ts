/**
 * TOKENMAXX HEAVY deepen — different slice: relations / threads API routes (events leftover).
 * After #120 (voip/rtc/calls). Keys leftovers already thick; relations suite was thin (~20 its).
 * Avoids voip/rtc/calls (#118/#120), sliding-sync (#119), sync (#117), keys/search siblings.
 * Tests-only — no product inventing.
 * Exercises membership gates, pagination dirs, relType/eventType filters, threads include,
 * room/parent isolation, SQL bind contracts, limit/NaN edges, response shape matrix.
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

// =============================================================================
// TOKENMAXX HEAVY leftovers after #120 — deepen thin events/relations slice
// =============================================================================

const OTHER_ROOM = '!other:example.com';
const OTHER_ROOM_ENC = encodeURIComponent(OTHER_ROOM);
const OTHER_PARENT = '$otherparent:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const threadsBase = `/_matrix/client/v1/rooms/${ROOM_ENC}/threads`;

function rootEvent(
  id: string,
  ts: number,
  sender = USER,
  roomId = ROOM
): EventRow {
  return {
    event_id: id,
    room_id: roomId,
    event_type: 'm.room.message',
    sender,
    origin_server_ts: ts,
    content: JSON.stringify({ body: `root-${id}` }),
    relates_to_event_id: null,
    relation_type: null,
  };
}

function threadChild(
  id: string,
  rootId: string,
  ts: number,
  sender = USER,
  roomId = ROOM
): EventRow {
  return {
    event_id: id,
    room_id: roomId,
    event_type: 'm.room.message',
    sender,
    origin_server_ts: ts,
    content: JSON.stringify({ body: `thread-${id}` }),
    relates_to_event_id: rootId,
    relation_type: 'm.thread',
  };
}

function relMembershipQuery(selects: SqlCall[]) {
  return selects.find((s) => s.sql.includes('FROM room_memberships'));
}

function relEventsQuery(selects: SqlCall[]) {
  return selects.find(
    (s) =>
      s.sql.includes('FROM events e') &&
      s.sql.includes('relates_to_event_id') &&
      !s.sql.includes('event_id IN')
  );
}

function threadsQuery(selects: SqlCall[]) {
  return selects.find((s) => s.sql.includes('event_id IN'));
}

describe('relations TOKENMAXX membership matrix after #120', () => {
  const paths: Array<[string, string]> = [
    ['all', base],
    ['relType', `${base}/m.annotation`],
    ['relType+eventType', `${base}/m.annotation/m.reaction`],
    ['threads', threadsBase],
  ];

  it.each(paths)(
    'forbids invite on %s',
    async (_label, path) => {
      const db = createRelationsDb({
        memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      });
      const res = await request(db, path, {
        headers: { Authorization: 'Bearer t' },
      });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
    }
  );

  it.each(paths)(
    'forbids ban on %s',
    async (_label, path) => {
      const db = createRelationsDb({
        memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      });
      const res = await request(db, path, {
        headers: { Authorization: 'Bearer t' },
      });
      expect(res.status).toBe(403);
    }
  );

  it.each(paths)(
    'forbids knock on %s',
    async (_label, path) => {
      const db = createRelationsDb({
        memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      });
      const res = await request(db, path, {
        headers: { Authorization: 'Bearer t' },
      });
      expect(res.status).toBe(403);
    }
  );

  it.each(paths)(
    'allows leave historic access on %s',
    async (_label, path) => {
      const db = createRelationsDb({
        memberships: [leaveMember()],
        events: [
          rootEvent('$r', 1),
          threadChild('$t', '$r', 2),
          child({ event_id: '$c', origin_server_ts: 3 }),
        ],
      });
      const res = await request(db, path, {
        headers: { Authorization: 'Bearer t' },
      });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('chunk');
    }
  );

  it('membership in a different room does not grant access', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: OTHER_ROOM, user_id: USER, membership: 'join' }],
      events: [child({ event_id: '$c', origin_server_ts: 1 })],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(403);
  });

  it('binds authenticated userId + path roomId into membership lookup', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [],
    });
    await request(db, base, { headers: { Authorization: 'Bearer t' } });
    const m = relMembershipQuery(db.selects);
    expect(m?.args).toEqual([ROOM, USER]);
  });

  it.each([
    ['relType', `${base}/m.annotation`],
    ['relType+eventType', `${base}/m.annotation/m.reaction`],
    ['threads', threadsBase],
  ])('membership SQL args for %s use path roomId', async (_label, path) => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [],
    });
    await request(db, path, { headers: { Authorization: 'Bearer t' } });
    expect(relMembershipQuery(db.selects)?.args).toEqual([ROOM, USER]);
  });
});

describe('relations TOKENMAXX room and parent isolation', () => {
  it('excludes children that belong to another room', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$here', origin_server_ts: 10 }),
        child({
          event_id: '$there',
          origin_server_ts: 20,
          room_id: OTHER_ROOM,
        }),
      ],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$here']);
  });

  it('excludes children that relate to a different parent event', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p1', origin_server_ts: 10, relates_to_event_id: PARENT }),
        child({
          event_id: '$p2',
          origin_server_ts: 20,
          relates_to_event_id: OTHER_PARENT,
        }),
      ],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$p1']);
  });

  it('typed filter still isolates by room + parent', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ok',
          origin_server_ts: 1,
          relation_type: 'm.annotation',
        }),
        child({
          event_id: '$wrong-room',
          origin_server_ts: 2,
          relation_type: 'm.annotation',
          room_id: OTHER_ROOM,
        }),
        child({
          event_id: '$wrong-parent',
          origin_server_ts: 3,
          relation_type: 'm.annotation',
          relates_to_event_id: OTHER_PARENT,
        }),
        child({
          event_id: '$wrong-type',
          origin_server_ts: 4,
          relation_type: 'm.reference',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$ok']);
  });

  it('other-room hierarchy path uses that roomId in membership + SQL', async () => {
    const db = createRelationsDb({
      memberships: [
        { room_id: OTHER_ROOM, user_id: USER, membership: 'join' },
      ],
      events: [
        child({
          event_id: '$x',
          origin_server_ts: 1,
          room_id: OTHER_ROOM,
          relates_to_event_id: OTHER_PARENT,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${OTHER_ROOM_ENC}/relations/${encodeURIComponent(OTHER_PARENT)}`;
    const res = await request(db, path, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { chunk: Array<{ event_id: string }> }).chunk[0].event_id).toBe(
      '$x'
    );
    expect(relMembershipQuery(db.selects)?.args).toEqual([OTHER_ROOM, USER]);
    expect(relEventsQuery(db.selects)?.args.slice(0, 2)).toEqual([
      OTHER_ROOM,
      OTHER_PARENT,
    ]);
  });

  it('threads ignore thread roots that live in another room', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        rootEvent('$local', 100),
        threadChild('$lt', '$local', 101),
        rootEvent('$remote', 200, USER, OTHER_ROOM),
        threadChild('$rt', '$remote', 201, USER, OTHER_ROOM),
      ],
    });
    const res = await request(db, threadsBase, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$local']);
  });
});

describe('relations TOKENMAXX response shape matrix', () => {
  it('includes sender, origin_server_ts, type, room_id, content for each chunk item', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$shaped',
          origin_server_ts: 42,
          sender: BOB,
          event_type: 'm.reaction',
          content: JSON.stringify({ key: '👍' }),
        }),
      ],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.body).toEqual({
      chunk: [
        {
          event_id: '$shaped',
          type: 'm.reaction',
          sender: BOB,
          origin_server_ts: 42,
          content: { key: '👍' },
          room_id: ROOM,
        },
      ],
    });
  });

  it('preserves nested content objects and arrays after JSON parse', async () => {
    const nested = {
      'm.relates_to': {
        rel_type: 'm.annotation',
        event_id: PARENT,
        key: '🚀',
      },
      extra: [1, 2, { a: true }],
    };
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$n',
          origin_server_ts: 1,
          content: JSON.stringify(nested),
        }),
      ],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as { chunk: Array<{ content: unknown }> };
    expect(body.chunk[0].content).toEqual(nested);
  });

  it('surfaces JSON.parse failures on content as HTTP 500', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$bad',
          origin_server_ts: 1,
          content: '{not-json',
        }),
      ],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it('typed+eventType response uses event_type as type field', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$msg',
          origin_server_ts: 9,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
          content: JSON.stringify({ body: 'edit' }),
        }),
      ],
    });
    const res = await request(db, `${base}/m.replace/m.room.message`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as { chunk: Array<{ type: string; content: { body: string } }> };
    expect(body.chunk[0]).toMatchObject({
      type: 'm.room.message',
      content: { body: 'edit' },
    });
  });

  it('empty chunk has no next_batch key', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [],
    });
    const res = await request(db, `${base}?limit=1`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.body).toEqual({ chunk: [] });
    expect(Object.keys(res.body as object)).toEqual(['chunk']);
  });

  it('next_batch is stringified origin_server_ts of last returned event', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$1', origin_server_ts: 111 }),
        child({ event_id: '$2', origin_server_ts: 222 }),
        child({ event_id: '$3', origin_server_ts: 333 }),
      ],
    });
    const res = await request(db, `${base}?limit=2&dir=f`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as {
      chunk: Array<{ event_id: string }>;
      next_batch: string;
    };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$1', '$2']);
    expect(body.next_batch).toBe('222');
    expect(typeof body.next_batch).toBe('string');
  });
});

describe('relations TOKENMAXX SQL bind contracts', () => {
  it('all-relations binds roomId, eventId, then optional from, then limit+1', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$a', origin_server_ts: 10 })],
    });
    await request(db, `${base}?from=50&dir=b&limit=3`, {
      headers: { Authorization: 'Bearer t' },
    });
    const q = relEventsQuery(db.selects);
    expect(q?.args).toEqual([ROOM, PARENT, 50, 4]);
    expect(q?.sql).toMatch(/origin_server_ts < \?/);
    expect(q?.sql).toMatch(/ORDER BY e\.origin_server_ts DESC/);
  });

  it('all-relations dir=f uses origin_server_ts > ? and ASC', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [],
    });
    await request(db, `${base}?from=9&dir=f&limit=1`, {
      headers: { Authorization: 'Bearer t' },
    });
    const q = relEventsQuery(db.selects);
    expect(q?.args).toEqual([ROOM, PARENT, 9, 2]);
    expect(q?.sql).toMatch(/origin_server_ts > \?/);
    expect(q?.sql).toMatch(/ORDER BY e\.origin_server_ts ASC/);
  });

  it('relType binds roomId, eventId, relType, limit+1 (no from)', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [],
    });
    await request(db, `${base}/m.annotation?from=999&limit=7&dir=b`, {
      headers: { Authorization: 'Bearer t' },
    });
    const q = relEventsQuery(db.selects);
    // typed endpoint ignores `from` — only room, parent, relType, limit+1
    expect(q?.args).toEqual([ROOM, PARENT, 'm.annotation', 8]);
    expect(q?.sql).not.toMatch(/origin_server_ts [<>]/);
  });

  it('relType+eventType binds both filters', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [],
    });
    await request(db, `${base}/m.thread/m.room.message?limit=4&dir=f`, {
      headers: { Authorization: 'Bearer t' },
    });
    const q = relEventsQuery(db.selects);
    expect(q?.args).toEqual([ROOM, PARENT, 'm.thread', 'm.room.message', 5]);
    expect(q?.sql).toMatch(/ORDER BY e\.origin_server_ts ASC/);
  });

  it('threads default include=all binds roomId twice then limit (no user filter)', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [],
    });
    await request(db, threadsBase, { headers: { Authorization: 'Bearer t' } });
    const q = threadsQuery(db.selects);
    expect(q?.args).toEqual([ROOM, ROOM, 50]);
    expect(q?.sql).not.toMatch(/e\.sender = \?/);
  });

  it('threads include=participated binds userId twice before limit', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [],
    });
    await request(db, `${threadsBase}?include=participated&limit=10`, {
      headers: { Authorization: 'Bearer t' },
    });
    const q = threadsQuery(db.selects);
    expect(q?.args).toEqual([ROOM, ROOM, USER, USER, 10]);
  });

  it('URL-decoded roomId and eventId reach SQL binds', async () => {
    const fancyRoom = '!room with spaces:example.com';
    const fancyParent = '$event/with/slashes:example.com';
    const db = createRelationsDb({
      memberships: [
        { room_id: fancyRoom, user_id: USER, membership: 'join' },
      ],
      events: [
        child({
          event_id: '$c',
          origin_server_ts: 1,
          room_id: fancyRoom,
          relates_to_event_id: fancyParent,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(fancyRoom)}/relations/${encodeURIComponent(fancyParent)}`;
    const res = await request(db, path, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(relMembershipQuery(db.selects)?.args).toEqual([fancyRoom, USER]);
    expect(relEventsQuery(db.selects)?.args.slice(0, 2)).toEqual([
      fancyRoom,
      fancyParent,
    ]);
  });
});

describe('relations TOKENMAXX limit / dir / from edges', () => {
  it('limit=0 fetches 1 and returns empty chunk without next_batch', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a', origin_server_ts: 1 }),
        child({ event_id: '$b', origin_server_ts: 2 }),
      ],
    });
    const res = await request(db, `${base}?limit=0`, {
      headers: { Authorization: 'Bearer t' },
    });
    const q = relEventsQuery(db.selects);
    expect(q?.args[q.args.length - 1]).toBe(1);
    expect(res.body).toEqual({ chunk: [] });
  });

  it('non-numeric limit becomes NaN fetch bound (documents parseInt)', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$a', origin_server_ts: 1 })],
    });
    await request(db, `${base}?limit=abc`, {
      headers: { Authorization: 'Bearer t' },
    });
    const q = relEventsQuery(db.selects);
    expect(Number.isNaN(q?.args[q.args.length - 1] as number)).toBe(true);
  });

  it('parseInt prefix quirks: limit=50xyz → 50 (+1 fetch 51)', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [],
    });
    await request(db, `${base}?limit=50xyz`, {
      headers: { Authorization: 'Bearer t' },
    });
    const q = relEventsQuery(db.selects);
    expect(q?.args[q.args.length - 1]).toBe(51);
  });

  it('negative limit is not clamped upward (Math.min only caps max)', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [],
    });
    await request(db, `${base}?limit=-5`, {
      headers: { Authorization: 'Bearer t' },
    });
    const q = relEventsQuery(db.selects);
    expect(q?.args[q.args.length - 1]).toBe(-4);
  });

  it('unknown dir is not b → ASC (only exact b is DESC)', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a', origin_server_ts: 10 }),
        child({ event_id: '$b', origin_server_ts: 20 }),
      ],
    });
    const res = await request(db, `${base}?dir=sideways`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$a', '$b']);
    expect(relEventsQuery(db.selects)?.sql).toMatch(/ASC/);
  });

  it('empty dir query uses default b', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a', origin_server_ts: 1 }),
        child({ event_id: '$b', origin_server_ts: 2 }),
      ],
    });
    const res = await request(db, `${base}?dir=`, {
      headers: { Authorization: 'Bearer t' },
    });
    // empty string is falsy → `|| 'b'`
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$b', '$a']);
  });

  it('from=NaN filters with NaN comparisons (documents parseInt)', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a', origin_server_ts: 100 }),
        child({ event_id: '$b', origin_server_ts: 200 }),
      ],
    });
    const res = await request(db, `${base}?from=nope&dir=b`, {
      headers: { Authorization: 'Bearer t' },
    });
    // ts < NaN is always false → empty
    const body = res.body as { chunk: unknown[] };
    expect(body.chunk).toHaveLength(0);
    expect(relEventsQuery(db.selects)?.args[2]).toBeNaN();
  });

  it('exact boundary: from equals ts excluded for both dirs', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a', origin_server_ts: 100 }),
        child({ event_id: '$b', origin_server_ts: 200 }),
        child({ event_id: '$c', origin_server_ts: 300 }),
      ],
    });
    const back = await request(db, `${base}?from=200&dir=b`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(
      (back.body as { chunk: Array<{ event_id: string }> }).chunk.map((e) => e.event_id)
    ).toEqual(['$a']);

    const fwd = await request(db, `${base}?from=200&dir=f`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(
      (fwd.body as { chunk: Array<{ event_id: string }> }).chunk.map((e) => e.event_id)
    ).toEqual(['$c']);
  });

  it('hasMore false when result count equals limit exactly', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$1', origin_server_ts: 10 }),
        child({ event_id: '$2', origin_server_ts: 20 }),
      ],
    });
    const res = await request(db, `${base}?limit=2`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as { chunk: unknown[]; next_batch?: string };
    expect(body.chunk).toHaveLength(2);
    expect(body.next_batch).toBeUndefined();
  });

  it('typed endpoints clamp limit identically to 100', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [],
    });
    await request(db, `${base}/m.annotation?limit=500`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(relEventsQuery(db.selects)?.args.at(-1)).toBe(101);

    const db2 = createRelationsDb({
      memberships: [joinMember()],
      events: [],
    });
    await request(db2, `${base}/m.annotation/m.reaction?limit=500`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(relEventsQuery(db2.selects)?.args.at(-1)).toBe(101);
  });

  it('default limit on typed endpoints fetches 51', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [],
    });
    await request(db, `${base}/m.reference`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(relEventsQuery(db.selects)?.args.at(-1)).toBe(51);
  });
});

describe('relations TOKENMAXX relation_type vocabulary', () => {
  const types = [
    'm.annotation',
    'm.reference',
    'm.replace',
    'm.thread',
    'io.element.relation.custom',
  ] as const;

  it.each(types)('filters relType=%s exclusively', async (relType) => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: types.map((t, i) =>
        child({
          event_id: `$e-${t}`,
          origin_server_ts: i + 1,
          relation_type: t,
          event_type: 'm.room.message',
        })
      ),
    });
    const res = await request(db, `${base}/${encodeURIComponent(relType)}`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual([`$e-${relType}`]);
    expect(relEventsQuery(db.selects)?.args[2]).toBe(relType);
  });

  it('URL-encoded relType and eventType round-trip into binds', async () => {
    const relType = 'm.annotation';
    const eventType = 'm.reaction';
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$r',
          origin_server_ts: 1,
          relation_type: relType,
          event_type: eventType,
        }),
      ],
    });
    const path = `${base}/${encodeURIComponent(relType)}/${encodeURIComponent(eventType)}`;
    const res = await request(db, path, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(relEventsQuery(db.selects)?.args.slice(2, 4)).toEqual([
      relType,
      eventType,
    ]);
  });

  it('all-relations returns mixed relation types unsorted-by-type (ts only)', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$ann',
          origin_server_ts: 30,
          relation_type: 'm.annotation',
        }),
        child({
          event_id: '$rep',
          origin_server_ts: 10,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
        child({
          event_id: '$ref',
          origin_server_ts: 20,
          relation_type: 'm.reference',
          event_type: 'm.room.message',
        }),
      ],
    });
    const res = await request(db, `${base}?dir=f`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as { chunk: Array<{ event_id: string }> };
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$rep', '$ref', '$ann']);
  });
});

describe('relations TOKENMAXX threads deepen', () => {
  it('returns empty chunk when room has no thread relations', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        rootEvent('$lonely', 1),
        child({
          event_id: '$ann',
          origin_server_ts: 2,
          relation_type: 'm.annotation',
          relates_to_event_id: '$lonely',
        }),
      ],
    });
    const res = await request(db, threadsBase, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.body).toEqual({ chunk: [] });
  });

  it('clamps threads limit to 100', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [],
    });
    await request(db, `${threadsBase}?limit=999`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(threadsQuery(db.selects)?.args.at(-1)).toBe(100);
  });

  it('defaults threads limit to 50', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [],
    });
    await request(db, threadsBase, { headers: { Authorization: 'Bearer t' } });
    expect(threadsQuery(db.selects)?.args.at(-1)).toBe(50);
  });

  it('threads limit=0 returns empty', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        rootEvent('$r', 1),
        threadChild('$t', '$r', 2),
      ],
    });
    const res = await request(db, `${threadsBase}?limit=0`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(0);
  });

  it('include=participated with no participation yields empty', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        rootEvent('$r', 1, BOB),
        threadChild('$t', '$r', 2, CAROL),
      ],
    });
    const res = await request(db, `${threadsBase}?include=participated`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(0);
  });

  it('include=participated keeps root when user is root sender even if replies are others', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        rootEvent('$mine', 50, USER),
        threadChild('$t', '$mine', 51, BOB),
      ],
    });
    const res = await request(db, `${threadsBase}?include=participated`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(
      (res.body as { chunk: Array<{ event_id: string }> }).chunk.map((e) => e.event_id)
    ).toEqual(['$mine']);
  });

  it('include=participated keeps root when user only replied (not root sender)', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        rootEvent('$theirs', 10, BOB),
        threadChild('$t1', '$theirs', 11, CAROL),
        threadChild('$t2', '$theirs', 12, USER),
      ],
    });
    const res = await request(db, `${threadsBase}?include=participated`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(
      (res.body as { chunk: Array<{ event_id: string }> }).chunk.map((e) => e.event_id)
    ).toEqual(['$theirs']);
  });

  it('unknown include value behaves like all (no participated filter)', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        rootEvent('$r', 1, BOB),
        threadChild('$t', '$r', 2, CAROL),
      ],
    });
    const res = await request(db, `${threadsBase}?include=weird`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(
      (res.body as { chunk: Array<{ event_id: string }> }).chunk.map((e) => e.event_id)
    ).toEqual(['$r']);
    expect(threadsQuery(db.selects)?.args).toEqual([ROOM, ROOM, 50]);
  });

  it('empty include falls back to all via ||', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        rootEvent('$r', 1, BOB),
        threadChild('$t', '$r', 2, CAROL),
      ],
    });
    const res = await request(db, `${threadsBase}?include=`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(
      (res.body as { chunk: Array<{ event_id: string }> }).chunk
    ).toHaveLength(1);
  });

  it('orders thread roots by origin_server_ts DESC always', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        rootEvent('$old', 10),
        rootEvent('$mid', 20),
        rootEvent('$new', 30),
        threadChild('$t1', '$old', 11),
        threadChild('$t2', '$mid', 21),
        threadChild('$t3', '$new', 31),
      ],
    });
    const res = await request(db, threadsBase, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(
      (res.body as { chunk: Array<{ event_id: string }> }).chunk.map((e) => e.event_id)
    ).toEqual(['$new', '$mid', '$old']);
  });

  it('thread root content JSON parse failure → 500', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        {
          ...rootEvent('$r', 1),
          content: 'not-json',
        },
        threadChild('$t', '$r', 2),
      ],
    });
    const res = await request(db, threadsBase, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it('maps thread root fields like relations chunk', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        rootEvent('$r', 77, BOB),
        threadChild('$t', '$r', 78, CAROL),
      ],
    });
    const res = await request(db, threadsBase, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.body).toEqual({
      chunk: [
        {
          event_id: '$r',
          type: 'm.room.message',
          sender: BOB,
          origin_server_ts: 77,
          content: { body: 'root-$r' },
          room_id: ROOM,
        },
      ],
    });
  });

  it('multiple replies to one root still yield a single root entry', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        rootEvent('$r', 1),
        threadChild('$t1', '$r', 2),
        threadChild('$t2', '$r', 3),
        threadChild('$t3', '$r', 4),
      ],
    });
    const res = await request(db, threadsBase, {
      headers: { Authorization: 'Bearer t' },
    });
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(1);
  });

  it('leave membership can list threads', async () => {
    const db = createRelationsDb({
      memberships: [leaveMember()],
      events: [rootEvent('$r', 1), threadChild('$t', '$r', 2)],
    });
    const res = await request(db, threadsBase, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { chunk: unknown[] }).chunk).toHaveLength(1);
  });

  it('threads SQL always ORDER BY DESC regardless of unused query params', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [],
    });
    await request(db, `${threadsBase}?dir=f&from=1`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(threadsQuery(db.selects)?.sql).toMatch(/ORDER BY e\.origin_server_ts DESC/);
  });
});

describe('relations TOKENMAXX pagination chaining', () => {
  it('can walk all-relations pages using next_batch as from', async () => {
    const events = Array.from({ length: 6 }, (_, i) =>
      child({ event_id: `$p${i}`, origin_server_ts: (i + 1) * 100 })
    );
    const db = createRelationsDb({
      memberships: [joinMember()],
      events,
    });

    const page1 = await request(db, `${base}?limit=2&dir=b`, {
      headers: { Authorization: 'Bearer t' },
    });
    const b1 = page1.body as {
      chunk: Array<{ event_id: string }>;
      next_batch: string;
    };
    expect(b1.chunk.map((e) => e.event_id)).toEqual(['$p5', '$p4']);
    expect(b1.next_batch).toBe('500');

    const page2 = await request(db, `${base}?limit=2&dir=b&from=${b1.next_batch}`, {
      headers: { Authorization: 'Bearer t' },
    });
    const b2 = page2.body as {
      chunk: Array<{ event_id: string }>;
      next_batch: string;
    };
    expect(b2.chunk.map((e) => e.event_id)).toEqual(['$p3', '$p2']);
    expect(b2.next_batch).toBe('300');

    const page3 = await request(db, `${base}?limit=2&dir=b&from=${b2.next_batch}`, {
      headers: { Authorization: 'Bearer t' },
    });
    const b3 = page3.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(b3.chunk.map((e) => e.event_id)).toEqual(['$p1', '$p0']);
    expect(b3.next_batch).toBeUndefined();
  });

  it('forward pagination chaining with dir=f', async () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      child({ event_id: `$f${i}`, origin_server_ts: (i + 1) * 10 })
    );
    const db = createRelationsDb({
      memberships: [joinMember()],
      events,
    });
    const p1 = await request(db, `${base}?limit=2&dir=f`, {
      headers: { Authorization: 'Bearer t' },
    });
    const b1 = p1.body as {
      chunk: Array<{ event_id: string }>;
      next_batch: string;
    };
    expect(b1.chunk.map((e) => e.event_id)).toEqual(['$f0', '$f1']);
    expect(b1.next_batch).toBe('20');

    const p2 = await request(db, `${base}?limit=2&dir=f&from=${b1.next_batch}`, {
      headers: { Authorization: 'Bearer t' },
    });
    const b2 = p2.body as {
      chunk: Array<{ event_id: string }>;
      next_batch: string;
    };
    expect(b2.chunk.map((e) => e.event_id)).toEqual(['$f2', '$f3']);
    expect(b2.next_batch).toBe('40');

    const p3 = await request(db, `${base}?limit=2&dir=f&from=${b2.next_batch}`, {
      headers: { Authorization: 'Bearer t' },
    });
    const b3 = p3.body as {
      chunk: Array<{ event_id: string }>;
      next_batch?: string;
    };
    expect(b3.chunk.map((e) => e.event_id)).toEqual(['$f4']);
    expect(b3.next_batch).toBeUndefined();
  });
});

describe('relations TOKENMAXX typed pagination + dir matrix', () => {
  it.each([
    ['relType', `${base}/m.annotation`],
    ['relType+eventType', `${base}/m.annotation/m.reaction`],
  ])('%s dir=b DESC with next_batch', async (_label, path) => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$1', origin_server_ts: 10 }),
        child({ event_id: '$2', origin_server_ts: 20 }),
        child({ event_id: '$3', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${path}?limit=1&dir=b`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as {
      chunk: Array<{ event_id: string }>;
      next_batch: string;
    };
    expect(body.chunk[0].event_id).toBe('$3');
    expect(body.next_batch).toBe('30');
  });

  it.each([
    ['relType', `${base}/m.annotation`],
    ['relType+eventType', `${base}/m.annotation/m.reaction`],
  ])('%s dir=f ASC with next_batch', async (_label, path) => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$1', origin_server_ts: 10 }),
        child({ event_id: '$2', origin_server_ts: 20 }),
        child({ event_id: '$3', origin_server_ts: 30 }),
      ],
    });
    const res = await request(db, `${path}?limit=1&dir=f`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as {
      chunk: Array<{ event_id: string }>;
      next_batch: string;
    };
    expect(body.chunk[0].event_id).toBe('$1');
    expect(body.next_batch).toBe('10');
  });

  it('typed endpoint with limit exact count omits next_batch', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$1', origin_server_ts: 1 }),
        child({ event_id: '$2', origin_server_ts: 2 }),
      ],
    });
    const res = await request(db, `${base}/m.annotation?limit=2`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect((res.body as { next_batch?: string }).next_batch).toBeUndefined();
  });
});

describe('relations TOKENMAXX membership SQL short-circuit', () => {
  it('does not query events when membership fails', async () => {
    const db = createRelationsDb({
      memberships: [],
      events: [child({ event_id: '$c', origin_server_ts: 1 })],
    });
    await request(db, base, { headers: { Authorization: 'Bearer t' } });
    expect(relMembershipQuery(db.selects)).toBeTruthy();
    expect(relEventsQuery(db.selects)).toBeUndefined();
    expect(threadsQuery(db.selects)).toBeUndefined();
  });

  it('does not query threads events when membership fails', async () => {
    const db = createRelationsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [rootEvent('$r', 1), threadChild('$t', '$r', 2)],
    });
    await request(db, threadsBase, { headers: { Authorization: 'Bearer t' } });
    expect(threadsQuery(db.selects)).toBeUndefined();
  });
});

describe('relations TOKENMAXX dense annotation stress', () => {
  it('returns 100 of 120 annotations with next_batch under clamp', async () => {
    const events = Array.from({ length: 120 }, (_, i) =>
      child({
        event_id: `$ann${i}`,
        origin_server_ts: i + 1,
        relation_type: 'm.annotation',
        content: JSON.stringify({ key: `k${i}` }),
      })
    );
    const db = createRelationsDb({
      memberships: [joinMember()],
      events,
    });
    const res = await request(db, `${base}/m.annotation?limit=100&dir=f`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as {
      chunk: Array<{ event_id: string; content: { key: string } }>;
      next_batch: string;
    };
    expect(body.chunk).toHaveLength(100);
    expect(body.chunk[0].event_id).toBe('$ann0');
    expect(body.chunk[99].event_id).toBe('$ann99');
    expect(body.chunk[99].content.key).toBe('k99');
    expect(body.next_batch).toBe('100');
    expect(relEventsQuery(db.selects)?.args.at(-1)).toBe(101);
  });

  it('all-relations default page returns at most 50 of many', async () => {
    const events = Array.from({ length: 60 }, (_, i) =>
      child({ event_id: `$d${i}`, origin_server_ts: i + 1 })
    );
    const db = createRelationsDb({
      memberships: [joinMember()],
      events,
    });
    const res = await request(db, `${base}?dir=f`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as {
      chunk: unknown[];
      next_batch: string;
    };
    expect(body.chunk).toHaveLength(50);
    expect(body.next_batch).toBe('50');
  });
});

describe('relations TOKENMAXX eventType path segments', () => {
  it.each([
    'm.reaction',
    'm.room.message',
    'm.room.encrypted',
    'org.example.custom',
  ])('eventType=%s filters strictly', async (eventType) => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: `$match`,
          origin_server_ts: 1,
          relation_type: 'm.annotation',
          event_type: eventType,
        }),
        child({
          event_id: `$other`,
          origin_server_ts: 2,
          relation_type: 'm.annotation',
          event_type: 'm.other',
        }),
      ],
    });
    const res = await request(
      db,
      `${base}/m.annotation/${encodeURIComponent(eventType)}`,
      { headers: { Authorization: 'Bearer t' } }
    );
    const body = res.body as { chunk: Array<{ event_id: string; type: string }> };
    expect(body.chunk).toHaveLength(1);
    expect(body.chunk[0]).toMatchObject({ event_id: '$match', type: eventType });
  });

  it('relType match but eventType mismatch yields empty', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$x',
          origin_server_ts: 1,
          relation_type: 'm.annotation',
          event_type: 'm.reaction',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation/m.room.message`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.body).toEqual({ chunk: [] });
  });

  it('eventType match but relType mismatch yields empty', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$x',
          origin_server_ts: 1,
          relation_type: 'm.replace',
          event_type: 'm.reaction',
        }),
      ],
    });
    const res = await request(db, `${base}/m.annotation/m.reaction`, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.body).toEqual({ chunk: [] });
  });
});

describe('relations TOKENMAXX sender diversity', () => {
  it('preserves distinct senders across chunk without coalescing', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a', origin_server_ts: 1, sender: USER }),
        child({ event_id: '$b', origin_server_ts: 2, sender: BOB }),
        child({ event_id: '$c', origin_server_ts: 3, sender: CAROL }),
      ],
    });
    const res = await request(db, `${base}?dir=f`, {
      headers: { Authorization: 'Bearer t' },
    });
    const body = res.body as { chunk: Array<{ sender: string }> };
    expect(body.chunk.map((e) => e.sender)).toEqual([USER, BOB, CAROL]);
  });

  it('threads preserve root sender even when replies differ', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        rootEvent('$r', 1, CAROL),
        threadChild('$t', '$r', 2, BOB),
      ],
    });
    const res = await request(db, threadsBase, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(
      (res.body as { chunk: Array<{ sender: string }> }).chunk[0].sender
    ).toBe(CAROL);
  });
});

describe('relations TOKENMAXX content edge values', () => {
  it.each([
    ['empty object', {}],
    ['nullish-looking strings', { body: '', msgtype: 'm.text' }],
    ['unicode', { key: '🎉💯🔥' }],
    ['deep nest', { a: { b: { c: [1, null, false] } } }],
  ])('round-trips content %s', async (_label, content) => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$c',
          origin_server_ts: 1,
          content: JSON.stringify(content),
        }),
      ],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(
      (res.body as { chunk: Array<{ content: unknown }> }).chunk[0].content
    ).toEqual(content);
  });

  it('JSON literal null content parses to null', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$n',
          origin_server_ts: 1,
          content: 'null',
        }),
      ],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(
      (res.body as { chunk: Array<{ content: unknown }> }).chunk[0].content
    ).toBeNull();
  });

  it('JSON array content is preserved', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({
          event_id: '$arr',
          origin_server_ts: 1,
          content: JSON.stringify([1, 'two', true]),
        }),
      ],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(
      (res.body as { chunk: Array<{ content: unknown }> }).chunk[0].content
    ).toEqual([1, 'two', true]);
  });
});

describe('relations TOKENMAXX roomId path variants', () => {
  it('handles room ids with encoded bang and colon', async () => {
    const roomId = '!abc:example.com';
    const parent = '$p:example.com';
    const db = createRelationsDb({
      memberships: [{ room_id: roomId, user_id: USER, membership: 'join' }],
      events: [
        child({
          event_id: '$c',
          origin_server_ts: 1,
          room_id: roomId,
          relates_to_event_id: parent,
        }),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(parent)}`;
    const res = await request(db, path, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(
      (res.body as { chunk: Array<{ room_id: string }> }).chunk[0].room_id
    ).toBe(roomId);
  });

  it('threads path encodes roomId the same way', async () => {
    const roomId = '!space/child:example.com';
    const db = createRelationsDb({
      memberships: [{ room_id: roomId, user_id: USER, membership: 'join' }],
      events: [
        rootEvent('$r', 1, USER, roomId),
        threadChild('$t', '$r', 2, USER, roomId),
      ],
    });
    const path = `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/threads`;
    const res = await request(db, path, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(
      (res.body as { chunk: Array<{ room_id: string }> }).chunk[0].room_id
    ).toBe(roomId);
    expect(relMembershipQuery(db.selects)?.args[0]).toBe(roomId);
  });
});

describe('relations TOKENMAXX concurrent-looking select accounting', () => {
  it('each request appends membership then events selects', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [child({ event_id: '$a', origin_server_ts: 1 })],
    });
    await request(db, base, { headers: { Authorization: 'Bearer t' } });
    await request(db, `${base}/m.annotation`, {
      headers: { Authorization: 'Bearer t' },
    });
    await request(db, threadsBase, { headers: { Authorization: 'Bearer t' } });
    const membershipSelects = db.selects.filter((s) =>
      s.sql.includes('FROM room_memberships')
    );
    expect(membershipSelects).toHaveLength(3);
    expect(db.selects.length).toBeGreaterThanOrEqual(6);
  });
});

describe('relations TOKENMAXX equal timestamps', () => {
  it('stable-enough ordering when timestamps collide (both returned)', async () => {
    const db = createRelationsDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$a', origin_server_ts: 50 }),
        child({ event_id: '$b', origin_server_ts: 50 }),
        child({ event_id: '$c', origin_server_ts: 50 }),
      ],
    });
    const res = await request(db, base, {
      headers: { Authorization: 'Bearer t' },
    });
    const ids = (res.body as { chunk: Array<{ event_id: string }> }).chunk.map(
      (e) => e.event_id
    );
    expect(ids).toHaveLength(3);
    expect(new Set(ids)).toEqual(new Set(['$a', '$b', '$c']));
  });
});

describe('relations TOKENMAXX leftover membership status strings', () => {
  it.each(['', 'JOIN', 'joined', 'Leave', 'left', 'forbidden'])(
    'treats non-canonical membership %j as forbidden',
    async (membership) => {
      const db = createRelationsDb({
        memberships: [{ room_id: ROOM, user_id: USER, membership }],
      });
      const res = await request(db, base, {
        headers: { Authorization: 'Bearer t' },
      });
      expect(res.status).toBe(403);
    }
  );
});
