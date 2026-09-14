/**
 * TOKENMAXX HEAVY leftovers after #209 — relations + threads *concurrent race / TOCTOU*
 * for `src/api/relations.ts`.
 *
 * Distinct from #191–#209 niches (admin-mutate, rooms, aliases, rooms-mutate,
 * workflows, tags, profile-mutate, profile, search+spaces, report+server-notices,
 * voip/rtc/calls, sync, presence, sliding-sync, typing, push, rooms-read-upgrade,
 * account). Soft leftovers live in `relations-api-routes` / `relations-api-route-leftovers`
 * (Promise.all soft floods only — no membership SELECT→events barrier TOCTOU).
 *
 * Focus: membership SELECT→relations/threads query TOCTOU under Promise.all;
 * join→ban/invite/knock mid-flight; leave historic access; events mutate mid-flight
 * (inject/clear children after membership); typed relType/eventType concurrent;
 * threads include=participated; pagination from/dir; multi-room/parent isolation;
 * failure soft mid concurrent; method/charset/lifecycle soft floods; SQL bind contracts;
 * relations∥threads cross-endpoint isolation.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
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
const CAROL = '@carol:example.com';
const SERVER = 'example.com';
const ROOM = '!room:example.com';
const ROOM_B = '!room-b:example.com';
const ROOM_C = '!room-c:example.com';
const PARENT = '$parent:example.com';
const PARENT_B = '$parent-b:example.com';
const PARENT_C = '$parent-c:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const ROOM_B_ENC = encodeURIComponent(ROOM_B);
const ROOM_C_ENC = encodeURIComponent(ROOM_C);
const PARENT_ENC = encodeURIComponent(PARENT);
const PARENT_B_ENC = encodeURIComponent(PARENT_B);
const PARENT_C_ENC = encodeURIComponent(PARENT_C);

const REL_BASE = `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}`;
const THREADS = `/_matrix/client/v1/rooms/${ROOM_ENC}/threads`;

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
type SelectBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };

async function withBarrier(
  barrier: SelectBarrier | undefined,
  waitersRef: { list: Array<() => void> },
  clear: () => void,
  sql: string,
  args: unknown[]
) {
  if (!barrier || !barrier.match(sql, args)) return;
  await new Promise<void>((resolve) => {
    waitersRef.list.push(resolve);
    if (waitersRef.list.length >= barrier.count) {
      const all = [...waitersRef.list];
      waitersRef.list = [];
      clear();
      for (const r of all) r();
    }
  });
}

function createRelationsRaceDb(
  opts: {
    memberships?: Membership[];
    events?: EventRow[];
    selectBarrier?: SelectBarrier;
    mutateMembershipAfterSelects?: { after: number; next: Membership[] };
    mutateEventsAfterMembershipSelects?: { after: number; next: EventRow[] };
    mutateEventsAfterEventsSelects?: { after: number; next: EventRow[] };
    failOnSqlIncludesAfter?: { includes: string; after: number };
    throwOnSqlIncludes?: string;
  } = {}
) {
  let memberships = [...(opts.memberships ?? [])];
  let events = [...(opts.events ?? [])];
  const selects: SqlCall[] = [];
  const timeline: string[] = [];

  let selectBarrier = opts.selectBarrier;
  const selectWaiters = { list: [] as Array<() => void> };

  let membershipSelectCount = 0;
  let eventsSelectCount = 0;
  const failCounts: Record<string, number> = {};

  const mutateMembership = opts.mutateMembershipAfterSelects;
  const mutateEventsAfterMembership = opts.mutateEventsAfterMembershipSelects;
  const mutateEventsAfterEvents = opts.mutateEventsAfterEventsSelects;
  const failAfter = opts.failOnSqlIncludesAfter;

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
    get memberships() {
      return memberships;
    },
    setMemberships(next: Membership[]) {
      memberships = [...next];
    },
    get events() {
      return events;
    },
    setEvents(next: EventRow[]) {
      events = [...next];
    },
    selects,
    timeline,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              timeline.push(`first:${sql.slice(0, 56)}`);
              await withBarrier(
                selectBarrier,
                selectWaiters,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );
              if (opts.throwOnSqlIncludes && sql.includes(opts.throwOnSqlIncludes)) {
                throw new Error(`db boom: ${opts.throwOnSqlIncludes}`);
              }
              if (failAfter && sql.includes(failAfter.includes)) {
                failCounts[failAfter.includes] = (failCounts[failAfter.includes] ?? 0) + 1;
                if (failCounts[failAfter.includes] > failAfter.after) {
                  throw new Error(`db fail-after: ${failAfter.includes}`);
                }
              }
              if (sql.includes('FROM room_memberships')) {
                membershipSelectCount += 1;
                const [roomId, userId] = args as string[];
                const snap = memberships.find(
                  (m) => m.room_id === roomId && m.user_id === userId
                );
                if (mutateMembership && membershipSelectCount === mutateMembership.after) {
                  memberships = [...mutateMembership.next];
                  timeline.push('mutate:membership');
                }
                if (mutateEventsAfterMembership && membershipSelectCount === mutateEventsAfterMembership.after) {
                  events = [...mutateEventsAfterMembership.next];
                  timeline.push('mutate:events-after-membership');
                }
                return (snap ? { membership: snap.membership } : null) as T;
              }
              return null as T;
            },
            async all<T>() {
              selects.push({ sql, args });
              timeline.push(`all:${sql.slice(0, 56)}`);
              await withBarrier(
                selectBarrier,
                selectWaiters,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );
              if (opts.throwOnSqlIncludes && sql.includes(opts.throwOnSqlIncludes)) {
                throw new Error(`db boom: ${opts.throwOnSqlIncludes}`);
              }
              if (failAfter && sql.includes(failAfter.includes)) {
                failCounts[failAfter.includes] = (failCounts[failAfter.includes] ?? 0) + 1;
                if (failCounts[failAfter.includes] > failAfter.after) {
                  throw new Error(`db fail-after: ${failAfter.includes}`);
                }
              }

              eventsSelectCount += 1;
              if (mutateEventsAfterEvents && eventsSelectCount === mutateEventsAfterEvents.after) {
                // mutate after this snapshot is taken
              }
              const eventsSnap = events.slice();
              if (mutateEventsAfterEvents && eventsSelectCount === mutateEventsAfterEvents.after) {
                events = [...mutateEventsAfterEvents.next];
                timeline.push('mutate:events-after-events');
              }

              // Threads list
              if (
                (sql.includes("relation_type = 'm.thread'") ||
                  sql.includes("relation_type = 'm.thread'")) &&
                sql.includes('event_id IN')
              ) {
                const roomId = args[0] as string;
                const dir = parseOrder(sql);
                const limit = args[args.length - 1] as number;
                let roots = eventsSnap.filter(
                  (e) =>
                    e.room_id === roomId &&
                    eventsSnap.some(
                      (c) =>
                        c.room_id === roomId &&
                        c.relation_type === 'm.thread' &&
                        c.relates_to_event_id === e.event_id
                    )
                );
                if (sql.includes('e.sender = ?')) {
                  const userId = args[2] as string;
                  roots = roots.filter(
                    (e) =>
                      e.sender === userId ||
                      eventsSnap.some(
                        (r) =>
                          r.relates_to_event_id === e.event_id && r.sender === userId
                      )
                  );
                }
                const ordered = sortEvents(roots, dir).slice(0, limit);
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

              if (sql.includes('FROM events e') && sql.includes('relates_to_event_id')) {
                const roomId = args[0] as string;
                const eventId = args[1] as string;
                const dir = parseOrder(sql);
                let filtered = eventsSnap.filter(
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
                    content: e.content,
                  })) as T[],
                };
              }

              return { results: [] as T[] };
            },
            async run() {
              return { success: true, meta: { changes: 0, last_row_id: 0 } };
            },
          };
        },
      };
    },
  };

  return db;
}

type RelationsRaceDb = ReturnType<typeof createRelationsRaceDb>;

function envFor(db: RelationsRaceDb): Env {
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
  } as unknown as Env;
}

async function get(
  db: RelationsRaceDb,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    Authorization: 'Bearer t',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  const res = await relations.request(
    `http://localhost${path}`,
    {
      ...init,
      method: (init.method as string) ?? 'GET',
      headers,
    },
    envFor(db)
  );
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function join(roomId = ROOM, userId = USER): Membership {
  return { room_id: roomId, user_id: userId, membership: 'join' };
}

function mem(membership: string, roomId = ROOM, userId = USER): Membership {
  return { room_id: roomId, user_id: userId, membership };
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
      JSON.stringify({ 'm.relates_to': { rel_type: 'm.annotation' } }),
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
    sender: overrides.sender ?? BOB,
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

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
}

function chunkIds(body: any): string[] {
  return (body?.chunk ?? []).map((e: { event_id: string }) => e.event_id);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ===========================================================================
// Membership SELECT → relations query TOCTOU
// ===========================================================================

describe('race relations membership SELECT→query TOCTOU after #209', () => {
  it('parallel all-relations under membership barrier both 200', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [
        child({ event_id: '$a', origin_server_ts: 100 }),
        child({ event_id: '$b', origin_server_ts: 200 }),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([get(db, REL_BASE), get(db, REL_BASE)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => chunkIds(r.body).length === 2)).toBe(true);
  });

  it('membership cleared after first SELECT → second forbidden', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [child({ event_id: '$c1', origin_server_ts: 10 })],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const first = await get(db, REL_BASE);
    expect(first.status).toBe(200);
    expect(chunkIds(first.body)).toEqual(['$c1']);
    const second = await get(db, REL_BASE);
    expect(second.status).toBe(403);
    expect(db.timeline).toContain('mutate:membership');
  });

  it.each(['ban', 'invite', 'knock'] as const)(
    'membership flip join→%s after first SELECT → second 403',
    async (next) => {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [child({ event_id: `$flip-${next}`, origin_server_ts: 50 })],
        mutateMembershipAfterSelects: { after: 1, next: [mem(next)] },
      });
      const a = await get(db, REL_BASE);
      const b = await get(db, REL_BASE);
      expect(a.status).toBe(200);
      expect(b.status).toBe(403);
    }
  );

  it('join→leave after first SELECT still allows historic access', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [child({ event_id: '$hist', origin_server_ts: 11 })],
      mutateMembershipAfterSelects: { after: 1, next: [mem('leave')] },
    });
    const a = await get(db, REL_BASE);
    const b = await get(db, REL_BASE);
    expect(statusesOf([a, b])).toEqual([200, 200]);
  });

  it('parallel under barrier with membership clear mid-pack', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [child({ event_id: '$race', origin_server_ts: 1 })],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const results = await Promise.all([get(db, REL_BASE), get(db, REL_BASE)]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 403]);
  });

  it('membership TOCTOU soft flood join→empty', async () => {
    for (let i = 0; i < 12; i++) {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [child({ event_id: `$soft-${i}`, origin_server_ts: 1000 + i })],
        mutateMembershipAfterSelects: { after: 1, next: [] },
      });
      const a = await get(db, REL_BASE);
      const b = await get(db, REL_BASE);
      expect(a.status).toBe(200);
      expect(b.status).toBe(403);
    }
  });

  it('typed relType path membership flip mid-flight', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [child({ event_id: '$ann', origin_server_ts: 5 })],
      mutateMembershipAfterSelects: { after: 1, next: [mem('ban')] },
    });
    const a = await get(db, `${REL_BASE}/m.annotation`);
    const b = await get(db, `${REL_BASE}/m.annotation`);
    expect(a.status).toBe(200);
    expect(b.status).toBe(403);
  });

  it('relType+eventType path membership flip mid-flight', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [child({ event_id: '$typed', origin_server_ts: 7 })],
      mutateMembershipAfterSelects: { after: 1, next: [mem('invite')] },
    });
    const a = await get(db, `${REL_BASE}/m.annotation/m.reaction`);
    const b = await get(db, `${REL_BASE}/m.annotation/m.reaction`);
    expect(a.status).toBe(200);
    expect(b.status).toBe(403);
  });
});

// ===========================================================================
// Events mutate mid-flight (after membership / after events SELECT)
// ===========================================================================

describe('race relations events mutate mid-flight after #209', () => {
  it('children injected after membership SELECT visible to events query', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [child({ event_id: '$base', origin_server_ts: 10 })],
      mutateEventsAfterMembershipSelects: {
        after: 1,
        next: [
          child({ event_id: '$base', origin_server_ts: 10 }),
          child({ event_id: '$injected', origin_server_ts: 9999 }),
        ],
      },
    });
    const res = await get(db, REL_BASE);
    expect(res.status).toBe(200);
    expect(chunkIds(res.body)).toContain('$injected');
    expect(db.timeline).toContain('mutate:events-after-membership');
  });

  it('children cleared after first events SELECT → second empty', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [
        child({ event_id: '$a', origin_server_ts: 1 }),
        child({ event_id: '$b', origin_server_ts: 2 }),
      ],
      mutateEventsAfterEventsSelects: { after: 1, next: [] },
    });
    const first = await get(db, REL_BASE);
    expect(first.status).toBe(200);
    expect(chunkIds(first.body).length).toBe(2);
    const second = await get(db, REL_BASE);
    expect(second.status).toBe(200);
    expect(chunkIds(second.body)).toEqual([]);
  });

  it('parallel relations share mutating children under membership barrier', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [child({ event_id: '$shared', origin_server_ts: 1 })],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
      mutateEventsAfterMembershipSelects: {
        after: 2,
        next: [child({ event_id: '$late', origin_server_ts: 5000 })],
      },
    });
    const results = await Promise.all([get(db, REL_BASE), get(db, REL_BASE)]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('events mutate soft flood after membership', async () => {
    for (let i = 0; i < 10; i++) {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [child({ event_id: `$pre-${i}`, origin_server_ts: i })],
        mutateEventsAfterMembershipSelects: {
          after: 1,
          next: [child({ event_id: `$post-${i}`, origin_server_ts: 8000 + i })],
        },
      });
      const res = await get(db, REL_BASE);
      expect(res.status).toBe(200);
      expect(chunkIds(res.body)).toEqual([`$post-${i}`]);
    }
  });

  it('annotation∥replace concurrent isolation under barrier', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [
        child({ event_id: '$ann', origin_server_ts: 1, relation_type: 'm.annotation' }),
        child({
          event_id: '$edit',
          origin_server_ts: 2,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
          content: JSON.stringify({ body: '* edited' }),
        }),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([
      get(db, `${REL_BASE}/m.annotation`),
      get(db, `${REL_BASE}/m.replace`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(chunkIds(results[0].body)).toEqual(['$ann']);
    expect(chunkIds(results[1].body)).toEqual(['$edit']);
  });
});

// ===========================================================================
// Threads concurrent-race / TOCTOU
// ===========================================================================

describe('race threads membership SELECT→list TOCTOU after #209', () => {
  const rootA = threadRoot({ event_id: '$root-a', origin_server_ts: 100 });
  const replyA = threadReply('$root-a', { event_id: '$reply-a', origin_server_ts: 101 });
  const rootB = threadRoot({ event_id: '$root-b', origin_server_ts: 200, sender: CAROL });
  const replyB = threadReply('$root-b', {
    event_id: '$reply-b',
    origin_server_ts: 201,
    sender: BOB,
  });

  it('parallel threads under membership barrier both 200', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [rootA, replyA, rootB, replyB],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([get(db, THREADS), get(db, THREADS)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.every((r) => chunkIds(r.body).length === 2)).toBe(true);
  });

  it('membership cleared after first threads SELECT → second 403', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [rootA, replyA],
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const a = await get(db, THREADS);
    const b = await get(db, THREADS);
    expect(a.status).toBe(200);
    expect(b.status).toBe(403);
  });

  it('parallel threads barrier with ban mid-pack', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [rootA, replyA],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
      mutateMembershipAfterSelects: { after: 1, next: [mem('ban')] },
    });
    const results = await Promise.all([get(db, THREADS), get(db, THREADS)]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 403]);
  });

  it('include=participated∥all concurrent under barrier', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [rootA, replyA, rootB, replyB],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([
      get(db, `${THREADS}?include=all`),
      get(db, `${THREADS}?include=participated`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(chunkIds(results[0].body).sort()).toEqual(['$root-a', '$root-b']);
    expect(chunkIds(results[1].body)).toEqual(['$root-a']);
  });

  it('thread roots injected after membership SELECT', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [rootA, replyA],
      mutateEventsAfterMembershipSelects: {
        after: 1,
        next: [
          rootA,
          replyA,
          rootB,
          replyB,
          threadRoot({ event_id: '$root-c', origin_server_ts: 300 }),
          threadReply('$root-c', { event_id: '$reply-c', origin_server_ts: 301 }),
        ],
      },
    });
    const res = await get(db, THREADS);
    expect(res.status).toBe(200);
    expect(chunkIds(res.body)).toContain('$root-c');
  });

  it('threads cleared after first events SELECT → second empty', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [rootA, replyA, rootB, replyB],
      mutateEventsAfterEventsSelects: { after: 1, next: [] },
    });
    const a = await get(db, THREADS);
    const b = await get(db, THREADS);
    expect(a.status).toBe(200);
    expect(chunkIds(a.body).length).toBe(2);
    expect(b.status).toBe(200);
    expect(chunkIds(b.body)).toEqual([]);
  });

  it('threads membership TOCTOU soft flood', async () => {
    for (let i = 0; i < 10; i++) {
      const root = threadRoot({ event_id: `$tr-${i}`, origin_server_ts: 100 + i });
      const reply = threadReply(`$tr-${i}`, {
        event_id: `$tp-${i}`,
        origin_server_ts: 200 + i,
      });
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [root, reply],
        mutateMembershipAfterSelects: { after: 1, next: [mem('knock')] },
      });
      const a = await get(db, THREADS);
      const b = await get(db, THREADS);
      expect(a.status).toBe(200);
      expect(b.status).toBe(403);
    }
  });

  it('leave membership still lists threads', async () => {
    const db = createRelationsRaceDb({
      memberships: [mem('leave')],
      events: [rootA, replyA],
    });
    const res = await get(db, THREADS);
    expect(res.status).toBe(200);
    expect(chunkIds(res.body)).toEqual(['$root-a']);
  });
});

// ===========================================================================
// Pagination / dir / limit concurrent
// ===========================================================================

describe('race relations pagination/dir concurrent after #209', () => {
  const kids = Array.from({ length: 12 }, (_, i) =>
    child({ event_id: `$p${i}`, origin_server_ts: (i + 1) * 100 })
  );

  it('dir=b∥dir=f under membership barrier', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: kids,
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([
      get(db, `${REL_BASE}?dir=b&limit=3`),
      get(db, `${REL_BASE}?dir=f&limit=3`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(chunkIds(results[0].body)).toEqual(['$p11', '$p10', '$p9']);
    expect(chunkIds(results[1].body)).toEqual(['$p0', '$p1', '$p2']);
  });

  it('from pagination concurrent both 200', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: kids,
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([
      get(db, `${REL_BASE}?from=700&dir=b&limit=2`),
      get(db, `${REL_BASE}?from=300&dir=f&limit=2`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(chunkIds(results[0].body).every((id) => {
      const ts = kids.find((k) => k.event_id === id)!.origin_server_ts;
      return ts < 700;
    })).toBe(true);
  });

  it('limit matrix concurrent soft flood', async () => {
    for (const limit of [1, 2, 5, 50, 100, 999]) {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: kids,
        selectBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
      });
      const results = await Promise.all([
        get(db, `${REL_BASE}?limit=${limit}`),
        get(db, `${REL_BASE}?limit=${limit}`),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      const capped = Math.min(limit, 100);
      expect(chunkIds(results[0].body).length).toBeLessThanOrEqual(capped);
    }
  });

  it('next_batch present when over limit under barrier', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: kids,
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([
      get(db, `${REL_BASE}?limit=3`),
      get(db, `${REL_BASE}?limit=3`),
    ]);
    expect(results.every((r) => typeof r.body.next_batch === 'string')).toBe(true);
  });
});

// ===========================================================================
// Multi-room / multi-parent isolation
// ===========================================================================

describe('race relations multi-room/parent isolation after #209', () => {
  it('room A∥room B concurrent isolation', async () => {
    const db = createRelationsRaceDb({
      memberships: [join(ROOM), join(ROOM_B)],
      events: [
        child({ event_id: '$ra', origin_server_ts: 1, room_id: ROOM }),
        child({
          event_id: '$rb',
          origin_server_ts: 2,
          room_id: ROOM_B,
          relates_to_event_id: PARENT_B,
        }),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([
      get(db, REL_BASE),
      get(
        db,
        `/_matrix/client/v1/rooms/${ROOM_B_ENC}/relations/${PARENT_B_ENC}`
      ),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(chunkIds(results[0].body)).toEqual(['$ra']);
    expect(chunkIds(results[1].body)).toEqual(['$rb']);
  });

  it('parent A∥parent B same room concurrent', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [
        child({ event_id: '$pa', origin_server_ts: 1, relates_to_event_id: PARENT }),
        child({
          event_id: '$pb',
          origin_server_ts: 2,
          relates_to_event_id: PARENT_B,
        }),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([
      get(db, REL_BASE),
      get(db, `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_B_ENC}`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(chunkIds(results[0].body)).toEqual(['$pa']);
    expect(chunkIds(results[1].body)).toEqual(['$pb']);
  });

  it('room C membership missing while A/B succeed', async () => {
    const db = createRelationsRaceDb({
      memberships: [join(ROOM), join(ROOM_B)],
      events: [
        child({ event_id: '$ok', origin_server_ts: 1 }),
        child({
          event_id: '$other',
          origin_server_ts: 2,
          room_id: ROOM_C,
          relates_to_event_id: PARENT_C,
        }),
      ],
    });
    const results = await Promise.all([
      get(db, REL_BASE),
      get(
        db,
        `/_matrix/client/v1/rooms/${ROOM_C_ENC}/relations/${PARENT_C_ENC}`
      ),
    ]);
    expect(results[0].status).toBe(200);
    expect(results[1].status).toBe(403);
  });

  it('3-way room isolation soft flood', async () => {
    for (let i = 0; i < 6; i++) {
      const db = createRelationsRaceDb({
        memberships: [join(ROOM), join(ROOM_B), join(ROOM_C)],
        events: [
          child({ event_id: `$a${i}`, origin_server_ts: i, room_id: ROOM }),
          child({
            event_id: `$b${i}`,
            origin_server_ts: i,
            room_id: ROOM_B,
            relates_to_event_id: PARENT_B,
          }),
          child({
            event_id: `$c${i}`,
            origin_server_ts: i,
            room_id: ROOM_C,
            relates_to_event_id: PARENT_C,
          }),
        ],
        selectBarrier: {
          count: 3,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
      });
      const results = await Promise.all([
        get(db, REL_BASE),
        get(db, `/_matrix/client/v1/rooms/${ROOM_B_ENC}/relations/${PARENT_B_ENC}`),
        get(db, `/_matrix/client/v1/rooms/${ROOM_C_ENC}/relations/${PARENT_C_ENC}`),
      ]);
      expect(statusesOf(results)).toEqual([200, 200, 200]);
      expect(chunkIds(results[0].body)).toEqual([`$a${i}`]);
      expect(chunkIds(results[1].body)).toEqual([`$b${i}`]);
      expect(chunkIds(results[2].body)).toEqual([`$c${i}`]);
    }
  });
});

// ===========================================================================
// Failure soft mid concurrent
// ===========================================================================

describe('race relations failure soft mid concurrent after #209', () => {
  it('membership throw surfaces 500 for barrier-synced pair', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [child({ event_id: '$e', origin_server_ts: 1 })],
      throwOnSqlIncludes: 'FROM room_memberships',
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([get(db, REL_BASE), get(db, REL_BASE)]);
    expect(statusesOf(results)).toEqual([500, 500]);
  });

  it('events throw on second request → first ok second 500', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [child({ event_id: '$e', origin_server_ts: 1 })],
      failOnSqlIncludesAfter: { includes: 'FROM events e', after: 1 },
    });
    const first = await get(db, REL_BASE);
    expect(first.status).toBe(200);
    const second = await get(db, REL_BASE);
    expect(second.status).toBe(500);
  });

  it('threads membership throw soft flood', async () => {
    for (let i = 0; i < 8; i++) {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [
          threadRoot({ event_id: `$r${i}`, origin_server_ts: i }),
          threadReply(`$r${i}`, { event_id: `$p${i}`, origin_server_ts: i + 1 }),
        ],
        throwOnSqlIncludes: 'FROM room_memberships',
      });
      const res = await get(db, THREADS);
      expect(res.status).toBe(500);
    }
  });

  it('events throw soft flood on typed path', async () => {
    for (let i = 0; i < 8; i++) {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [child({ event_id: `$t${i}`, origin_server_ts: i })],
        throwOnSqlIncludes: 'FROM events e',
      });
      const res = await get(db, `${REL_BASE}/m.annotation`);
      expect(res.status).toBe(500);
    }
  });
});

// ===========================================================================
// Multi-request floods + cross-endpoint isolation
// ===========================================================================

describe('race relations concurrent multi-request flood after #209', () => {
  it('8-way parallel all-relations under barrier all 200', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [
        child({ event_id: '$1', origin_server_ts: 1 }),
        child({ event_id: '$2', origin_server_ts: 2 }),
      ],
      selectBarrier: {
        count: 8,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => get(db, REL_BASE))
    );
    expect(statusesOf(results)).toEqual(Array(8).fill(200));
  });

  it('mixed all∥typed∥threads∥participated flood', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [
        child({ event_id: '$ann', origin_server_ts: 1 }),
        threadRoot({ event_id: '$root', origin_server_ts: 10 }),
        threadReply('$root', { event_id: '$reply', origin_server_ts: 11 }),
      ],
      selectBarrier: {
        count: 4,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([
      get(db, REL_BASE),
      get(db, `${REL_BASE}/m.annotation`),
      get(db, THREADS),
      get(db, `${THREADS}?include=participated`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200, 200]);
  });

  it('N×N parallel relations soft flood', async () => {
    for (let n = 2; n <= 6; n++) {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [child({ event_id: `$n${n}`, origin_server_ts: n })],
        selectBarrier: {
          count: n,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
      });
      const results = await Promise.all(
        Array.from({ length: n }, () => get(db, REL_BASE))
      );
      expect(statusesOf(results)).toEqual(Array(n).fill(200));
    }
  });

  it('relations∥threads cross-endpoint isolation', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [
        child({ event_id: '$rel', origin_server_ts: 1 }),
        threadRoot({ event_id: '$root', origin_server_ts: 50 }),
        threadReply('$root', { event_id: '$reply', origin_server_ts: 51 }),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const [rel, thr] = await Promise.all([get(db, REL_BASE), get(db, THREADS)]);
    expect(rel.status).toBe(200);
    expect(thr.status).toBe(200);
    expect(chunkIds(rel.body)).toEqual(['$rel']);
    expect(chunkIds(thr.body)).toEqual(['$root']);
  });
});

// ===========================================================================
// Soft floods — method / charset / lifecycle / blank
// ===========================================================================

describe('relations concurrent soft flood — method/charset/lifecycle after #209', () => {
  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'] as const)(
    'method %s soft on relations',
    async (method) => {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [child({ event_id: '$m', origin_server_ts: 1 })],
      });
      const res = await get(db, REL_BASE, { method });
      expect([200, 404, 405].includes(res.status) || res.status >= 400).toBe(true);
    }
  );

  it.each(['POST', 'PUT', 'DELETE', 'PATCH'] as const)(
    'method %s soft on threads',
    async (method) => {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [
          threadRoot({ event_id: '$r', origin_server_ts: 1 }),
          threadReply('$r', { event_id: '$p', origin_server_ts: 2 }),
        ],
      });
      const res = await get(db, THREADS, { method });
      expect(res.status).not.toBe(200);
    }
  );

  it('charset content-type soft flood on GET (ignored)', async () => {
    for (const ct of [
      'application/json',
      'application/json; charset=utf-8',
      'text/plain',
      'application/xml',
      '',
    ]) {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [child({ event_id: '$ct', origin_server_ts: 1 })],
      });
      const headers: Record<string, string> = { Authorization: 'Bearer t' };
      if (ct) headers['Content-Type'] = ct;
      const res = await get(db, REL_BASE, { headers });
      expect(res.status).toBe(200);
    }
  });

  it('lifecycle join→leave→ban soft chain', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [child({ event_id: '$life', origin_server_ts: 1 })],
    });
    expect((await get(db, REL_BASE)).status).toBe(200);
    db.setMemberships([mem('leave')]);
    expect((await get(db, REL_BASE)).status).toBe(200);
    db.setMemberships([mem('ban')]);
    expect((await get(db, REL_BASE)).status).toBe(403);
    db.setMemberships([]);
    expect((await get(db, REL_BASE)).status).toBe(403);
  });

  it('blank/empty room concurrent soft', async () => {
    for (let i = 0; i < 8; i++) {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [],
        selectBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
      });
      const results = await Promise.all([get(db, REL_BASE), get(db, THREADS)]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(chunkIds(results[0].body)).toEqual([]);
      expect(chunkIds(results[1].body)).toEqual([]);
    }
  });

  it('corrupt content JSON soft — one bad child', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [
        child({
          event_id: '$bad',
          origin_server_ts: 1,
          content: '{not-json',
        }),
      ],
    });
    const res = await get(db, REL_BASE);
    expect([200, 500]).toContain(res.status);
  });
});

// ===========================================================================
// Soft floods — membership status / encode / query junk
// ===========================================================================

describe('relations concurrent soft flood — membership/encode/query after #209', () => {
  it.each(['join', 'leave', 'invite', 'ban', 'knock', 'banish', '', 'JOIN'] as const)(
    'membership status=%s soft',
    async (status) => {
      const db = createRelationsRaceDb({
        memberships: status === '' ? [] : [mem(status)],
        events: [child({ event_id: '$ms', origin_server_ts: 1 })],
      });
      const res = await get(db, REL_BASE);
      if (status === 'join' || status === 'leave') {
        expect(res.status).toBe(200);
      } else {
        expect(res.status).toBe(403);
      }
    }
  );

  it('percent-encoded room/parent soft flood', async () => {
    const fancyRoom = '!room with spaces:example.com';
    const fancyParent = '$parent/with/slashes:example.com';
    for (let i = 0; i < 6; i++) {
      const db = createRelationsRaceDb({
        memberships: [join(fancyRoom)],
        events: [
          child({
            event_id: `$enc-${i}`,
            origin_server_ts: i,
            room_id: fancyRoom,
            relates_to_event_id: fancyParent,
          }),
        ],
      });
      const path = `/_matrix/client/v1/rooms/${encodeURIComponent(fancyRoom)}/relations/${encodeURIComponent(fancyParent)}`;
      const res = await get(db, path);
      expect(res.status).toBe(200);
      expect(chunkIds(res.body)).toEqual([`$enc-${i}`]);
    }
  });

  it('junk query params soft concurrent', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [child({ event_id: '$q', origin_server_ts: 1 })],
      selectBarrier: {
        count: 3,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([
      get(db, `${REL_BASE}?foo=bar&limit=abc`),
      get(db, `${REL_BASE}?dir=sideways&from=notanumber`),
      get(db, `${THREADS}?include=maybe&limit=-1`),
    ]);
    expect(results.every((r) => [200, 403, 500].includes(r.status))).toBe(true);
  });

  it('relation_type vocabulary concurrent soft', async () => {
    const types = [
      'm.annotation',
      'm.replace',
      'm.thread',
      'm.reference',
      'org.example.custom',
      'm.annotation/../evil',
    ];
    for (const relType of types) {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [
          child({
            event_id: `$rt-${relType}`,
            origin_server_ts: 1,
            relation_type: relType.includes('/') ? 'm.annotation' : relType,
          }),
        ],
      });
      const res = await get(db, `${REL_BASE}/${encodeURIComponent(relType)}`);
      expect([200, 403, 404]).toContain(res.status);
    }
  });

  it('bob foreign membership does not grant alice', async () => {
    const db = createRelationsRaceDb({
      memberships: [join(ROOM, BOB)],
      events: [child({ event_id: '$bob', origin_server_ts: 1 })],
    });
    const res = await get(db, REL_BASE);
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// SQL bind contracts under parallel
// ===========================================================================

describe('relations concurrent SQL bind contracts after #209', () => {
  it('membership SELECT binds roomId+userId', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [child({ event_id: '$b', origin_server_ts: 1 })],
    });
    await get(db, REL_BASE);
    const memSel = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(memSel?.args).toEqual([ROOM, USER]);
  });

  it('all-relations binds room+parent+limit+1', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [child({ event_id: '$b', origin_server_ts: 1 })],
    });
    await get(db, `${REL_BASE}?limit=7`);
    const ev = db.selects.find(
      (s) => s.sql.includes('FROM events e') && s.sql.includes('relates_to_event_id')
    );
    expect(ev?.args[0]).toBe(ROOM);
    expect(ev?.args[1]).toBe(PARENT);
    expect(ev?.args[ev.args.length - 1]).toBe(8);
  });

  it('typed relType binds relation_type', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [child({ event_id: '$b', origin_server_ts: 1 })],
    });
    await get(db, `${REL_BASE}/m.annotation`);
    const ev = db.selects.find((s) => s.sql.includes('relation_type = ?'));
    expect(ev?.args).toContain('m.annotation');
  });

  it('relType+eventType binds both filters', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [child({ event_id: '$b', origin_server_ts: 1 })],
    });
    await get(db, `${REL_BASE}/m.annotation/m.reaction`);
    const ev = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(ev?.args.slice(0, 4)).toEqual([ROOM, PARENT, 'm.annotation', 'm.reaction']);
  });

  it('threads participated binds userId twice', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [
        threadRoot({ event_id: '$r', origin_server_ts: 1 }),
        threadReply('$r', { event_id: '$p', origin_server_ts: 2 }),
      ],
    });
    await get(db, `${THREADS}?include=participated`);
    const thr = db.selects.find((s) => s.sql.includes('event_id IN'));
    expect(thr?.args[0]).toBe(ROOM);
    expect(thr?.args[1]).toBe(ROOM);
    expect(thr?.args[2]).toBe(USER);
    expect(thr?.args[3]).toBe(USER);
  });

  it('parallel bind contract soft flood', async () => {
    for (let i = 0; i < 10; i++) {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [child({ event_id: `$bind-${i}`, origin_server_ts: i })],
        selectBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
      });
      await Promise.all([get(db, REL_BASE), get(db, `${REL_BASE}/m.annotation`)]);
      const mems = db.selects.filter((s) => s.sql.includes('FROM room_memberships'));
      expect(mems.every((s) => s.args[0] === ROOM && s.args[1] === USER)).toBe(true);
    }
  });

  it('from= pagination binds timestamp', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [
        child({ event_id: '$1', origin_server_ts: 100 }),
        child({ event_id: '$2', origin_server_ts: 200 }),
      ],
    });
    await get(db, `${REL_BASE}?from=150&dir=b`);
    const ev = db.selects.find((s) => s.sql.includes('origin_server_ts < ?'));
    expect(ev?.args).toContain(150);
  });
});

// ===========================================================================
// Dense annotation / sender diversity concurrent
// ===========================================================================

describe('race relations dense annotation / sender concurrent after #209', () => {
  it('dense reactions under 4-way barrier', async () => {
    const dense = Array.from({ length: 40 }, (_, i) =>
      child({
        event_id: `$rxn-${i}`,
        origin_server_ts: 1000 + i,
        sender: i % 2 === 0 ? USER : BOB,
        content: JSON.stringify({
          'm.relates_to': { rel_type: 'm.annotation', key: i % 3 === 0 ? '👍' : '❤️' },
        }),
      })
    );
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: dense,
      selectBarrier: {
        count: 4,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([
      get(db, REL_BASE),
      get(db, `${REL_BASE}/m.annotation`),
      get(db, `${REL_BASE}/m.annotation/m.reaction`),
      get(db, `${REL_BASE}?limit=10`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200, 200]);
    expect(chunkIds(results[3].body)).toHaveLength(10);
  });

  it('sender diversity concurrent soft', async () => {
    const senders = [USER, BOB, CAROL, '@dave:example.com', '@erin:example.com'];
    for (let i = 0; i < senders.length; i++) {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: senders.map((s, j) =>
          child({
            event_id: `$s-${i}-${j}`,
            origin_server_ts: j + 1,
            sender: s,
          })
        ),
        selectBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
      });
      const results = await Promise.all([get(db, REL_BASE), get(db, REL_BASE)]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(chunkIds(results[0].body)).toHaveLength(senders.length);
    }
  });

  it('equal timestamps concurrent order stable-enough', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [
        child({ event_id: '$eq1', origin_server_ts: 50 }),
        child({ event_id: '$eq2', origin_server_ts: 50 }),
        child({ event_id: '$eq3', origin_server_ts: 50 }),
      ],
      selectBarrier: {
        count: 3,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([
      get(db, REL_BASE),
      get(db, REL_BASE),
      get(db, REL_BASE),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results.every((r) => chunkIds(r.body).length === 3)).toBe(true);
  });
});

// ===========================================================================
// Endpoint path matrix concurrent soft
// ===========================================================================

describe('relations concurrent soft flood — path matrix after #209', () => {
  const paths = [
    REL_BASE,
    `${REL_BASE}/m.annotation`,
    `${REL_BASE}/m.replace`,
    `${REL_BASE}/m.thread`,
    `${REL_BASE}/m.annotation/m.reaction`,
    `${REL_BASE}/m.replace/m.room.message`,
    THREADS,
    `${THREADS}?include=all`,
    `${THREADS}?include=participated`,
    `${THREADS}?limit=1`,
  ];

  it('path matrix under barrier all reachable', async () => {
    const db = createRelationsRaceDb({
      memberships: [join()],
      events: [
        child({ event_id: '$ann', origin_server_ts: 1 }),
        child({
          event_id: '$edit',
          origin_server_ts: 2,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
        threadRoot({ event_id: '$root', origin_server_ts: 10 }),
        threadReply('$root', { event_id: '$reply', origin_server_ts: 11 }),
      ],
      selectBarrier: {
        count: paths.length,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all(paths.map((p) => get(db, p)));
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('path matrix membership-forbidden soft', async () => {
    for (const path of paths) {
      const db = createRelationsRaceDb({
        memberships: [mem('ban')],
        events: [child({ event_id: '$x', origin_server_ts: 1 })],
      });
      const res = await get(db, path);
      expect(res.status).toBe(403);
    }
  });

  it('path matrix dual-GET soft flood', async () => {
    for (const path of paths) {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [
          child({ event_id: '$y', origin_server_ts: 1 }),
          threadRoot({ event_id: '$root', origin_server_ts: 10 }),
          threadReply('$root', { event_id: '$reply', origin_server_ts: 11 }),
        ],
        selectBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
      });
      const results = await Promise.all([get(db, path), get(db, path)]);
      expect(statusesOf(results)).toEqual([200, 200]);
    }
  });
});

// ===========================================================================
// Expanded soft floods (individual its — HEAVY deepen parity with #204–#209)
// ===========================================================================

describe('relations concurrent soft flood — membership TOCTOU its after #209', () => {
  for (let i = 0; i < 12; i++) {
    it(`membership clear soft-${i}`, async () => {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [child({ event_id: `$mc-${i}`, origin_server_ts: 1000 + i })],
        mutateMembershipAfterSelects: { after: 1, next: [] },
      });
      const a = await get(db, REL_BASE);
      const b = await get(db, REL_BASE);
      expect(a.status).toBe(200);
      expect(b.status).toBe(403);
    });
  }

  for (const next of ['ban', 'invite', 'knock'] as const) {
    for (let i = 0; i < 4; i++) {
      it(`join→${next} soft-${i}`, async () => {
        const db = createRelationsRaceDb({
          memberships: [join()],
          events: [child({ event_id: `$jf-${next}-${i}`, origin_server_ts: i })],
          mutateMembershipAfterSelects: { after: 1, next: [mem(next)] },
          selectBarrier: {
            count: 2,
            match: (sql) => sql.includes('FROM room_memberships'),
          },
        });
        const results = await Promise.all([get(db, REL_BASE), get(db, REL_BASE)]);
        expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 403]);
      });
    }
  }
});

describe('relations concurrent soft flood — events mutate its after #209', () => {
  for (let i = 0; i < 10; i++) {
    it(`events inject after membership soft-${i}`, async () => {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [child({ event_id: `$pre-${i}`, origin_server_ts: i })],
        mutateEventsAfterMembershipSelects: {
          after: 1,
          next: [child({ event_id: `$post-${i}`, origin_server_ts: 8000 + i })],
        },
      });
      const res = await get(db, REL_BASE);
      expect(res.status).toBe(200);
      expect(chunkIds(res.body)).toEqual([`$post-${i}`]);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`events clear after events-select soft-${i}`, async () => {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [
          child({ event_id: `$ea-${i}`, origin_server_ts: 1 }),
          child({ event_id: `$eb-${i}`, origin_server_ts: 2 }),
        ],
        mutateEventsAfterEventsSelects: { after: 1, next: [] },
      });
      const a = await get(db, REL_BASE);
      const b = await get(db, REL_BASE);
      expect(a.status).toBe(200);
      expect(chunkIds(a.body).length).toBe(2);
      expect(b.status).toBe(200);
      expect(chunkIds(b.body)).toEqual([]);
    });
  }
});

describe('threads concurrent soft flood — membership/include its after #209', () => {
  for (let i = 0; i < 10; i++) {
    it(`threads membership TOCTOU soft-${i}`, async () => {
      const root = threadRoot({ event_id: `$tr-${i}`, origin_server_ts: 100 + i });
      const reply = threadReply(`$tr-${i}`, {
        event_id: `$tp-${i}`,
        origin_server_ts: 200 + i,
      });
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [root, reply],
        mutateMembershipAfterSelects: { after: 1, next: [mem('knock')] },
      });
      const a = await get(db, THREADS);
      const b = await get(db, THREADS);
      expect(a.status).toBe(200);
      expect(b.status).toBe(403);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`threads include=all∥participated soft-${i}`, async () => {
      const rootA = threadRoot({ event_id: `$ra-${i}`, origin_server_ts: 100 });
      const replyA = threadReply(`$ra-${i}`, { event_id: `$pa-${i}`, origin_server_ts: 101 });
      const rootB = threadRoot({
        event_id: `$rb-${i}`,
        origin_server_ts: 200,
        sender: CAROL,
      });
      const replyB = threadReply(`$rb-${i}`, {
        event_id: `$pb-${i}`,
        origin_server_ts: 201,
        sender: BOB,
      });
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [rootA, replyA, rootB, replyB],
        selectBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
      });
      const results = await Promise.all([
        get(db, `${THREADS}?include=all`),
        get(db, `${THREADS}?include=participated`),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(chunkIds(results[0].body).sort()).toEqual([`$ra-${i}`, `$rb-${i}`].sort());
      expect(chunkIds(results[1].body)).toEqual([`$ra-${i}`]);
    });
  }
});

describe('relations concurrent soft flood — failure its after #209', () => {
  for (let i = 0; i < 8; i++) {
    it(`membership throw soft-${i}`, async () => {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [child({ event_id: `$ft-${i}`, origin_server_ts: i })],
        throwOnSqlIncludes: 'FROM room_memberships',
      });
      const res = await get(db, REL_BASE);
      expect(res.status).toBe(500);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`events throw soft-${i}`, async () => {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [child({ event_id: `$fe-${i}`, origin_server_ts: i })],
        throwOnSqlIncludes: 'FROM events e',
      });
      const res = await get(db, `${REL_BASE}/m.annotation`);
      expect(res.status).toBe(500);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`threads membership throw soft-${i}`, async () => {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [
          threadRoot({ event_id: `$r${i}`, origin_server_ts: i }),
          threadReply(`$r${i}`, { event_id: `$p${i}`, origin_server_ts: i + 1 }),
        ],
        throwOnSqlIncludes: 'FROM room_memberships',
      });
      const res = await get(db, THREADS);
      expect(res.status).toBe(500);
    });
  }
});

describe('relations concurrent soft flood — method matrix its after #209', () => {
  const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'] as const;
  for (const method of methods) {
    it(`relations method ${method} soft`, async () => {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [child({ event_id: '$m', origin_server_ts: 1 })],
      });
      const results = await Promise.all(
        Array.from({ length: 2 }, () => get(db, REL_BASE, { method }))
      );
      if (method === 'GET' || method === 'HEAD') {
        // Hono serves HEAD via the GET handler (200, empty body).
        expect(results.every((r) => r.status === 200)).toBe(true);
      } else {
        expect(results.every((r) => r.status !== 200)).toBe(true);
      }
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`method soft-${i}: wrong∥GET — only GET succeeds`, async () => {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [child({ event_id: `$ms-${i}`, origin_server_ts: i })],
      });
      const results = await Promise.all([
        get(db, REL_BASE, { method: 'POST' }),
        get(db, REL_BASE, { method: 'GET' }),
      ]);
      expect(results[0].status).not.toBe(200);
      expect(results[1].status).toBe(200);
    });
  }
});

describe('relations concurrent soft flood — encode/query/bind its after #209', () => {
  for (let i = 0; i < 8; i++) {
    it(`percent-encode soft-${i}`, async () => {
      const fancyRoom = '!room with spaces:example.com';
      const fancyParent = '$parent/with/slashes:example.com';
      const db = createRelationsRaceDb({
        memberships: [join(fancyRoom)],
        events: [
          child({
            event_id: `$enc-${i}`,
            origin_server_ts: i,
            room_id: fancyRoom,
            relates_to_event_id: fancyParent,
          }),
        ],
      });
      const path = `/_matrix/client/v1/rooms/${encodeURIComponent(fancyRoom)}/relations/${encodeURIComponent(fancyParent)}`;
      const res = await get(db, path);
      expect(res.status).toBe(200);
      expect(chunkIds(res.body)).toEqual([`$enc-${i}`]);
    });
  }

  for (let i = 0; i < 10; i++) {
    it(`bind contract soft-${i}`, async () => {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [child({ event_id: `$bind-${i}`, origin_server_ts: i })],
        selectBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
      });
      await Promise.all([get(db, REL_BASE), get(db, `${REL_BASE}/m.annotation`)]);
      const mems = db.selects.filter((s) => s.sql.includes('FROM room_memberships'));
      expect(mems.every((s) => s.args[0] === ROOM && s.args[1] === USER)).toBe(true);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`blank room concurrent soft-${i}`, async () => {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [],
        selectBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
      });
      const results = await Promise.all([get(db, REL_BASE), get(db, THREADS)]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(chunkIds(results[0].body)).toEqual([]);
      expect(chunkIds(results[1].body)).toEqual([]);
    });
  }

  for (let n = 2; n <= 8; n++) {
    it(`${n}-way parallel relations soft`, async () => {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [child({ event_id: `$n${n}`, origin_server_ts: n })],
        selectBarrier: {
          count: n,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
      });
      const results = await Promise.all(
        Array.from({ length: n }, () => get(db, REL_BASE))
      );
      expect(statusesOf(results)).toEqual(Array(n).fill(200));
    });
  }
});

describe('relations concurrent soft flood — path dual its after #209', () => {
  const softPaths = [
    ['all', REL_BASE],
    ['annotation', `${REL_BASE}/m.annotation`],
    ['replace', `${REL_BASE}/m.replace`],
    ['thread-rel', `${REL_BASE}/m.thread`],
    ['typed', `${REL_BASE}/m.annotation/m.reaction`],
    ['threads', THREADS],
    ['participated', `${THREADS}?include=participated`],
  ] as const;

  for (const [label, path] of softPaths) {
    for (let i = 0; i < 4; i++) {
      it(`path ${label} dual soft-${i}`, async () => {
        const db = createRelationsRaceDb({
          memberships: [join()],
          events: [
            child({ event_id: `$y-${label}-${i}`, origin_server_ts: 1 }),
            child({
              event_id: `$edit-${label}-${i}`,
              origin_server_ts: 2,
              relation_type: 'm.replace',
              event_type: 'm.room.message',
            }),
            threadRoot({ event_id: `$root-${label}-${i}`, origin_server_ts: 10 }),
            threadReply(`$root-${label}-${i}`, {
              event_id: `$reply-${label}-${i}`,
              origin_server_ts: 11,
            }),
          ],
          selectBarrier: {
            count: 2,
            match: (sql) => sql.includes('FROM room_memberships'),
          },
        });
        const results = await Promise.all([get(db, path), get(db, path)]);
        expect(statusesOf(results)).toEqual([200, 200]);
      });
    }
  }
});

describe('relations concurrent soft flood — lifecycle/charset its after #209', () => {
  for (let i = 0; i < 8; i++) {
    it(`lifecycle join→leave→ban soft-${i}`, async () => {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [child({ event_id: `$life-${i}`, origin_server_ts: i })],
      });
      expect((await get(db, REL_BASE)).status).toBe(200);
      db.setMemberships([mem('leave')]);
      expect((await get(db, REL_BASE)).status).toBe(200);
      db.setMemberships([mem('ban')]);
      expect((await get(db, REL_BASE)).status).toBe(403);
    });
  }

  const contentTypes = [
    'application/json',
    'application/json; charset=utf-8',
    'text/plain',
    'application/xml',
    '',
  ];
  for (let i = 0; i < contentTypes.length; i++) {
    it(`charset soft-${i}`, async () => {
      const ct = contentTypes[i];
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [child({ event_id: `$ct-${i}`, origin_server_ts: 1 })],
      });
      const headers: Record<string, string> = { Authorization: 'Bearer t' };
      if (ct) headers['Content-Type'] = ct;
      const res = await get(db, REL_BASE, { headers });
      expect(res.status).toBe(200);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`cross-endpoint relations∥threads soft-${i}`, async () => {
      const db = createRelationsRaceDb({
        memberships: [join()],
        events: [
          child({ event_id: `$rel-${i}`, origin_server_ts: 1 }),
          threadRoot({ event_id: `$root-${i}`, origin_server_ts: 50 }),
          threadReply(`$root-${i}`, { event_id: `$reply-${i}`, origin_server_ts: 51 }),
        ],
        selectBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
      });
      const [rel, thr] = await Promise.all([get(db, REL_BASE), get(db, THREADS)]);
      expect(rel.status).toBe(200);
      expect(thr.status).toBe(200);
      expect(chunkIds(rel.body)).toEqual([`$rel-${i}`]);
      expect(chunkIds(thr.body)).toEqual([`$root-${i}`]);
    });
  }
});
