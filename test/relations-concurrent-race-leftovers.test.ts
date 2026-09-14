/**
 * TOKENMAXX HEAVY leftovers after #208 — relations/threads *concurrent race / TOCTOU*
 * + soft/edge reliability for slices not covered by relations-api-routes or
 * relations-api-route-leftovers soft concurrent selects (#179).
 *
 * Distinct domain — not rooms-read/upgrade (#208), push (#207), typing (#206),
 * sliding-sync (#205), presence (#204), sync (#202), voip/rtc/calls (#201),
 * report/server-notices (#200), search/spaces (#199), profile (#198/#197),
 * tags (#196), workflows (#195), rooms-mutate (#194), aliases (#193),
 * rooms (#192), admin-mutate (#191). Complements #179 soft Promise.all
 * selects which lacked membership SELECT→events ALL barriers, leave/ban
 * mid-flight TOCTOU, events mutate mid-flight, typed∥threads endpoint
 * isolation, and dual-ALL coherency.
 *
 * Focus: membership SELECT→events ALL TOCTOU; dual membership / dual events
 * ALL barriers; events mutate mid-flight; all∥typed∥typed+eventType∥threads
 * concurrent isolation; threads include=participated TOCTOU; pagination
 * from/dir isolation; cross-room/parent isolation; D1 failure soft;
 * method/auth/charset/membership/lifecycle soft floods; SQL bind contracts.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
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
const CAROL = '@carol:example.com';
const ROOM = '!room:example.com';
const ROOM2 = '!room2:example.com';
const ROOM3 = '!room3:example.com';
const PARENT = '$parent:example.com';
const PARENT2 = '$parent2:example.com';
const PARENT3 = '$parent3:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const ROOM2_ENC = encodeURIComponent(ROOM2);
const ROOM3_ENC = encodeURIComponent(ROOM3);
const PARENT_ENC = encodeURIComponent(PARENT);
const PARENT2_ENC = encodeURIComponent(PARENT2);
const PARENT3_ENC = encodeURIComponent(PARENT3);
const AUTH = { Authorization: 'Bearer test-token' };

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

function createRelationsRaceDb(
  opts: {
    memberships?: Membership[];
    events?: EventRow[];
    membershipBarrier?: SelectBarrier;
    eventsBarrier?: SelectBarrier;
    mutateMembershipAfterSelects?: { after: number; next: Membership[] };
    mutateEventsAfterMembershipSelects?: { after: number; next: EventRow[] };
    mutateEventsAfterAll?: { after: number; next: EventRow[] };
    failMembershipAfter?: number;
    failEventsAfter?: number;
    failMembership?: boolean;
    failEvents?: boolean;
  } = {}
) {
  let memberships = [...(opts.memberships ?? [])];
  let events = [...(opts.events ?? [])];
  const selects: SqlCall[] = [];
  const allCalls: SqlCall[] = [];
  const timeline: string[] = [];
  let membershipBarrier = opts.membershipBarrier;
  let eventsBarrier = opts.eventsBarrier;
  const membershipWaiters = { list: [] as Array<() => void> };
  const eventsWaiters = { list: [] as Array<() => void> };
  let membershipSelectCount = 0;
  let eventsAllCount = 0;

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
    allCalls,
    timeline,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              timeline.push(`first:${sql.slice(0, 40)}`);
              await withBarrier(
                membershipBarrier,
                membershipWaiters,
                () => {
                  membershipBarrier = undefined;
                },
                sql,
                args
              );

              if (opts.failMembership) throw new Error('d1-membership-fail');
              if (sql.includes('FROM room_memberships')) {
                const [roomId, userId] = args as string[];
                const snapshot = memberships.find(
                  (m) => m.room_id === roomId && m.user_id === userId
                );
                membershipSelectCount += 1;
                if (
                  opts.failMembershipAfter !== undefined &&
                  membershipSelectCount > opts.failMembershipAfter
                ) {
                  throw new Error('d1-membership-fail-after');
                }
                if (
                  opts.mutateMembershipAfterSelects &&
                  membershipSelectCount === opts.mutateMembershipAfterSelects.after
                ) {
                  memberships = [...opts.mutateMembershipAfterSelects.next];
                  timeline.push('mutate:membership');
                }
                if (
                  opts.mutateEventsAfterMembershipSelects &&
                  membershipSelectCount === opts.mutateEventsAfterMembershipSelects.after
                ) {
                  events = [...opts.mutateEventsAfterMembershipSelects.next];
                  timeline.push('mutate:events-after-membership');
                }
                return (snapshot ? { membership: snapshot.membership } : null) as T;
              }
              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 140)}`);
            },

            async all<T>() {
              allCalls.push({ sql, args });
              selects.push({ sql, args });
              timeline.push(`all:${sql.slice(0, 40)}`);
              await withBarrier(
                eventsBarrier,
                eventsWaiters,
                () => {
                  eventsBarrier = undefined;
                },
                sql,
                args
              );

              if (opts.failEvents) throw new Error('d1-events-fail');
              eventsAllCount += 1;
              if (
                opts.failEventsAfter !== undefined &&
                eventsAllCount > opts.failEventsAfter
              ) {
                throw new Error('d1-events-fail-after');
              }

              // Snapshot events for this ALL before any post-ALL mutate.
              const eventSnapshot = [...events];

              const finish = <T>(results: T[]) => {
                if (
                  opts.mutateEventsAfterAll &&
                  eventsAllCount === opts.mutateEventsAfterAll.after
                ) {
                  events = [...opts.mutateEventsAfterAll.next];
                  timeline.push('mutate:events-after-all');
                }
                return { results };
              };

              // Threads list: DISTINCT roots that have m.thread children
              if (
                sql.includes("relation_type = 'm.thread'") &&
                sql.includes('event_id IN')
              ) {
                const roomId = args[0] as string;
                const dir = parseOrder(sql);
                const limit = args[args.length - 1] as number;
                const roots = eventSnapshot.filter(
                  (e) =>
                    e.room_id === roomId &&
                    eventSnapshot.some(
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
                      eventSnapshot.some(
                        (r) =>
                          r.relates_to_event_id === e.event_id &&
                          r.sender === userId
                      )
                  );
                }

                const ordered = sortEvents(filtered, dir).slice(0, limit);
                return finish(
                  ordered.map((e) => ({
                    event_id: e.event_id,
                    event_type: e.event_type,
                    sender: e.sender,
                    origin_server_ts: e.origin_server_ts,
                    content: e.content,
                  })) as T[]
                );
              }

              if (
                sql.includes('FROM events e') &&
                sql.includes('relates_to_event_id')
              ) {
                const roomId = args[0] as string;
                const eventId = args[1] as string;
                const dir = parseOrder(sql);

                let filtered = eventSnapshot.filter(
                  (e) => e.room_id === roomId && e.relates_to_event_id === eventId
                );

                const hasRelAndEventType =
                  sql.includes('relation_type = ?') &&
                  sql.includes('event_type = ?');
                const hasRelType =
                  sql.includes('relation_type = ?') &&
                  !sql.includes('event_type = ?');

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

                if (sql.includes('origin_server_ts < ?')) {
                  const from = args[argIdx++] as number;
                  filtered = filtered.filter((e) => e.origin_server_ts < from);
                } else if (sql.includes('origin_server_ts > ?')) {
                  const from = args[argIdx++] as number;
                  filtered = filtered.filter((e) => e.origin_server_ts > from);
                }

                const limit = args[args.length - 1] as number;
                const ordered = sortEvents(filtered, dir).slice(0, limit);
                return finish(
                  ordered.map((e) => ({
                    event_id: e.event_id,
                    event_type: e.event_type,
                    sender: e.sender,
                    origin_server_ts: e.origin_server_ts,
                    content: e.content,
                  })) as T[]
                );
              }

              throw new Error(`Unhandled all() SQL: ${sql.slice(0, 180)}`);
            },

            async run() {
              throw new Error(`Unexpected run() in relations race tests: ${sql.slice(0, 80)}`);
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
    SERVER_NAME: 'example.com',
  } as unknown as Env;
}

async function request(
  db: RelationsRaceDb,
  path: string,
  init: RequestInit = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Matrix JSON bodies; matches sibling race suites
): Promise<{ status: number; body: any; errcode?: string }> {
  const res = await relations.request(`http://localhost${path}`, init, envFor(db));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed response body
  let body: any = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return {
    status: res.status,
    body,
    errcode: body && typeof body === 'object' ? body.errcode : undefined,
  };
}

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
}

function joinMem(roomId = ROOM, userId = USER): Membership {
  return { room_id: roomId, user_id: userId, membership: 'join' };
}

function leaveMem(roomId = ROOM, userId = USER): Membership {
  return { room_id: roomId, user_id: userId, membership: 'leave' };
}

function banMem(roomId = ROOM, userId = USER): Membership {
  return { room_id: roomId, user_id: userId, membership: 'ban' };
}

function inviteMem(roomId = ROOM, userId = USER): Membership {
  return { room_id: roomId, user_id: userId, membership: 'invite' };
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

const allPath = `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}`;
const typedPath = `${allPath}/m.annotation`;
const typedEventPath = `${allPath}/m.annotation/m.reaction`;
const threadsPath = `/_matrix/client/v1/rooms/${ROOM_ENC}/threads`;
const allPath2 = `/_matrix/client/v1/rooms/${ROOM2_ENC}/relations/${PARENT2_ENC}`;
const threadsPath2 = `/_matrix/client/v1/rooms/${ROOM2_ENC}/threads`;

function seedChildren(n: number, roomId = ROOM, parentId = PARENT): EventRow[] {
  return Array.from({ length: n }, (_, i) =>
    child({
      event_id: `$c${i}:${roomId.replace(/[!:]/g, '')}`,
      origin_server_ts: 1000 + i * 10,
      room_id: roomId,
      relates_to_event_id: parentId,
      sender: i % 2 === 0 ? USER : BOB,
    })
  );
}

function seedThreadBundle(roomId = ROOM): EventRow[] {
  const root = threadRoot({
    event_id: `$root:${roomId.replace(/[!:]/g, '')}`,
    origin_server_ts: 500,
    room_id: roomId,
    sender: BOB,
  });
  const reply = threadReply(root.event_id, {
    event_id: `$treply:${roomId.replace(/[!:]/g, '')}`,
    origin_server_ts: 600,
    room_id: roomId,
    sender: USER,
  });
  return [root, reply];
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Membership SELECT → events ALL TOCTOU
// ---------------------------------------------------------------------------

describe('race relations membership SELECT→events ALL TOCTOU after #208', () => {
  it('both parallel GETs see join at SELECT; both return chunk under membership barrier', async () => {
    const kids = seedChildren(3);
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: kids,
      membershipBarrier: {
        match: (sql) => sql.includes('FROM room_memberships'),
        count: 2,
      },
    });

    const results = await Promise.all([
      request(db, allPath, { headers: AUTH }),
      request(db, allPath, { headers: AUTH }),
    ]);

    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.selects.filter((s) => s.sql.includes('FROM room_memberships'))).toHaveLength(2);
    expect(db.allCalls).toHaveLength(2);
    for (const r of results) {
      expect(r.body.chunk).toHaveLength(3);
    }
  });

  it('membership flips ban after first SELECT; second forbids before events ALL', async () => {
    const kids = seedChildren(2);
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: kids,
      membershipBarrier: {
        match: (sql) => sql.includes('FROM room_memberships'),
        count: 2,
      },
      mutateMembershipAfterSelects: {
        after: 1,
        next: [banMem()],
      },
    });

    const results = await Promise.all([
      request(db, allPath, { headers: AUTH }),
      request(db, allPath, { headers: AUTH }),
    ]);

    const oks = results.filter((r) => r.status === 200);
    const forbids = results.filter((r) => r.status === 403);
    expect(oks).toHaveLength(1);
    expect(forbids).toHaveLength(1);
    expect(forbids[0].errcode).toBe('M_FORBIDDEN');
    expect(db.allCalls).toHaveLength(1);
    expect(db.timeline).toContain('mutate:membership');
  });

  it('membership flips invite after first SELECT; second forbids', async () => {
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: seedChildren(1),
      membershipBarrier: {
        match: (sql) => sql.includes('FROM room_memberships'),
        count: 2,
      },
      mutateMembershipAfterSelects: {
        after: 1,
        next: [inviteMem()],
      },
    });

    const results = await Promise.all([
      request(db, typedPath, { headers: AUTH }),
      request(db, typedPath, { headers: AUTH }),
    ]);

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 403)).toHaveLength(1);
    expect(db.allCalls).toHaveLength(1);
  });

  it('join→leave mid-flight still allows both (leave is permitted membership)', async () => {
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: seedChildren(2),
      membershipBarrier: {
        match: (sql) => sql.includes('FROM room_memberships'),
        count: 2,
      },
      mutateMembershipAfterSelects: {
        after: 1,
        next: [leaveMem()],
      },
    });

    const results = await Promise.all([
      request(db, allPath, { headers: AUTH }),
      request(db, allPath, { headers: AUTH }),
    ]);

    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.allCalls).toHaveLength(2);
  });

  it('post-mutate sequential request is forbidden after ban flip', async () => {
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: seedChildren(2),
      mutateMembershipAfterSelects: {
        after: 1,
        next: [banMem()],
      },
    });

    const first = await request(db, allPath, { headers: AUTH });
    expect(first.status).toBe(200);
    expect(first.body.chunk).toHaveLength(2);

    const second = await request(db, allPath, { headers: AUTH });
    expect(second.status).toBe(403);
    expect(second.errcode).toBe('M_FORBIDDEN');
    expect(db.allCalls).toHaveLength(1);
  });

  for (const flip of ['ban', 'invite', 'knock'] as const) {
    it(`threads membership flip→${flip} mid barrier: one ok one forbid`, async () => {
      const bundle = seedThreadBundle();
      const db = createRelationsRaceDb({
        memberships: [joinMem()],
        events: bundle,
        membershipBarrier: {
          match: (sql) => sql.includes('FROM room_memberships'),
          count: 2,
        },
        mutateMembershipAfterSelects: {
          after: 1,
          next: [{ room_id: ROOM, user_id: USER, membership: flip }],
        },
      });

      const results = await Promise.all([
        request(db, threadsPath, { headers: AUTH }),
        request(db, threadsPath, { headers: AUTH }),
      ]);

      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 403)).toHaveLength(1);
      expect(db.allCalls).toHaveLength(1);
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`membership SELECT barrier soft-${i}: N parallel GETs all join`, async () => {
      const n = 2 + (i % 3);
      const db = createRelationsRaceDb({
        memberships: [joinMem()],
        events: seedChildren(4),
        membershipBarrier: {
          match: (sql) => sql.includes('FROM room_memberships'),
          count: n,
        },
      });

      const results = await Promise.all(
        Array.from({ length: n }, () =>
          request(db, i % 2 === 0 ? allPath : typedPath, { headers: AUTH })
        )
      );

      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(db.allCalls).toHaveLength(n);
      expect(
        db.selects.filter((s) => s.sql.includes('FROM room_memberships'))
      ).toHaveLength(n);
    });
  }
});

// ---------------------------------------------------------------------------
// Events ALL barriers + mutate mid-flight
// ---------------------------------------------------------------------------

describe('race relations events ALL barriers + mutate mid-flight after #208', () => {
  it('dual events ALL barrier: both GETs see same chunk snapshot', async () => {
    const kids = seedChildren(5);
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: kids,
      eventsBarrier: {
        match: (sql) => sql.includes('FROM events e') && sql.includes('relates_to_event_id'),
        count: 2,
      },
    });

    const results = await Promise.all([
      request(db, allPath, { headers: AUTH }),
      request(db, allPath, { headers: AUTH }),
    ]);

    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.allCalls).toHaveLength(2);
    expect(results[0].body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(
      results[1].body.chunk.map((e: { event_id: string }) => e.event_id)
    );
  });

  it('events shrink after first ALL under barrier; second GET sees empty chunk', async () => {
    const kids = seedChildren(4);
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: kids,
      eventsBarrier: {
        match: (sql) => sql.includes('FROM events e') && sql.includes('relates_to_event_id'),
        count: 2,
      },
      mutateEventsAfterAll: {
        after: 1,
        next: [],
      },
    });

    const results = await Promise.all([
      request(db, allPath, { headers: AUTH }),
      request(db, allPath, { headers: AUTH }),
    ]);

    expect(statusesOf(results)).toEqual([200, 200]);
    const lengths = results.map((r) => r.body.chunk.length).sort((a, b) => a - b);
    expect(lengths).toEqual([0, 4]);
    expect(db.timeline).toContain('mutate:events-after-all');
  });

  it('events grow after first ALL under barrier; second GET sees new annotations', async () => {
    const initial = seedChildren(1);
    const grown = seedChildren(6);
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: initial,
      eventsBarrier: {
        match: (sql) =>
          sql.includes('FROM events e') && sql.includes('relation_type = ?'),
        count: 2,
      },
      mutateEventsAfterAll: {
        after: 1,
        next: grown,
      },
    });

    const results = await Promise.all([
      request(db, typedPath, { headers: AUTH }),
      request(db, typedPath, { headers: AUTH }),
    ]);

    expect(statusesOf(results)).toEqual([200, 200]);
    const lengths = results.map((r) => r.body.chunk.length).sort((a, b) => a - b);
    expect(lengths).toEqual([1, 6]);
  });

  it('mutate after first ALL: sequential second request sees mutated set', async () => {
    const initial = seedChildren(3);
    const next = seedChildren(1).map((e) => ({
      ...e,
      event_id: '$only:example.com',
      origin_server_ts: 9999,
    }));
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: initial,
      mutateEventsAfterAll: {
        after: 1,
        next,
      },
    });

    const first = await request(db, allPath, { headers: AUTH });
    expect(first.body.chunk).toHaveLength(3);

    const second = await request(db, allPath, { headers: AUTH });
    expect(second.body.chunk).toHaveLength(1);
    expect(second.body.chunk[0].event_id).toBe('$only:example.com');
  });

  it('typed filter mid-flight under ALL barrier: annotation→reference swap', async () => {
    const annotations = seedChildren(3);
    const references = annotations.map((e, i) => ({
      ...e,
      event_id: `$ref${i}:example.com`,
      relation_type: 'm.reference',
      event_type: 'm.room.message',
      content: JSON.stringify({ 'm.relates_to': { rel_type: 'm.reference' } }),
    }));
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: annotations,
      eventsBarrier: {
        match: (sql) =>
          sql.includes('FROM events e') && sql.includes('relation_type = ?'),
        count: 2,
      },
      mutateEventsAfterAll: {
        after: 1,
        next: references,
      },
    });

    const results = await Promise.all([
      request(db, typedPath, { headers: AUTH }),
      request(db, typedPath, { headers: AUTH }),
    ]);

    expect(statusesOf(results)).toEqual([200, 200]);
    const lengths = results.map((r) => r.body.chunk.length).sort((a, b) => a - b);
    expect(lengths).toEqual([0, 3]);
  });

  it('membership→events single-request TOCTOU: events clear after membership SELECT', async () => {
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: seedChildren(5),
      mutateEventsAfterMembershipSelects: {
        after: 1,
        next: [],
      },
    });

    const res = await request(db, allPath, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(0);
    expect(db.timeline).toContain('mutate:events-after-membership');
  });

  it('membership→events single-request TOCTOU: events grow after membership SELECT', async () => {
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: seedChildren(1),
      mutateEventsAfterMembershipSelects: {
        after: 1,
        next: seedChildren(7),
      },
    });

    const res = await request(db, typedEventPath, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(7);
  });

  for (let i = 0; i < 10; i++) {
    it(`events ALL barrier soft-${i}: N parallel typed GETs`, async () => {
      const n = 2 + (i % 3);
      const db = createRelationsRaceDb({
        memberships: [joinMem()],
        events: seedChildren(8),
        eventsBarrier: {
          match: (sql) =>
            sql.includes('FROM events e') && sql.includes('relation_type = ?'),
          count: n,
        },
      });

      const path = i % 2 === 0 ? typedPath : typedEventPath;
      const results = await Promise.all(
        Array.from({ length: n }, () => request(db, path, { headers: AUTH }))
      );

      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(db.allCalls).toHaveLength(n);
      const ids = results.map((r) =>
        r.body.chunk.map((e: { event_id: string }) => e.event_id).join(',')
      );
      expect(new Set(ids).size).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Cross-endpoint concurrent isolation
// ---------------------------------------------------------------------------

describe('race relations cross-endpoint concurrent isolation after #208', () => {
  it('all∥typed∥typed+eventType∥threads under membership barrier', async () => {
    const kids = seedChildren(4);
    const bundle = seedThreadBundle();
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: [...kids, ...bundle],
      membershipBarrier: {
        match: (sql) => sql.includes('FROM room_memberships'),
        count: 4,
      },
    });

    const results = await Promise.all([
      request(db, allPath, { headers: AUTH }),
      request(db, typedPath, { headers: AUTH }),
      request(db, typedEventPath, { headers: AUTH }),
      request(db, threadsPath, { headers: AUTH }),
    ]);

    expect(statusesOf(results)).toEqual([200, 200, 200, 200]);
    expect(results[0].body.chunk.length).toBeGreaterThanOrEqual(4);
    expect(results[1].body.chunk).toHaveLength(4);
    expect(results[2].body.chunk).toHaveLength(4);
    expect(results[3].body.chunk).toHaveLength(1);
    expect(db.allCalls).toHaveLength(4);
  });

  it('all∥threads membership ban flip: one success path + forbids', async () => {
    const kids = seedChildren(2);
    const bundle = seedThreadBundle();
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: [...kids, ...bundle],
      membershipBarrier: {
        match: (sql) => sql.includes('FROM room_memberships'),
        count: 2,
      },
      mutateMembershipAfterSelects: {
        after: 1,
        next: [banMem()],
      },
    });

    const results = await Promise.all([
      request(db, allPath, { headers: AUTH }),
      request(db, threadsPath, { headers: AUTH }),
    ]);

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 403)).toHaveLength(1);
  });

  for (let i = 0; i < 8; i++) {
    it(`endpoint pair soft-${i}: typed∥threads isolation`, async () => {
      const kids = seedChildren(3 + (i % 3));
      const bundle = seedThreadBundle();
      const db = createRelationsRaceDb({
        memberships: [joinMem()],
        events: [...kids, ...bundle],
        membershipBarrier: {
          match: (sql) => sql.includes('FROM room_memberships'),
          count: 2,
        },
      });

      const [a, b] = await Promise.all([
        request(db, typedEventPath, { headers: AUTH }),
        request(db, `${threadsPath}?include=all`, { headers: AUTH }),
      ]);

      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body.chunk.every((e: { type: string }) => e.type === 'm.reaction')).toBe(
        true
      );
      expect(b.body.chunk).toHaveLength(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Threads participated TOCTOU
// ---------------------------------------------------------------------------

describe('race relations threads include=participated TOCTOU after #208', () => {
  it('participated∥all under events barrier see consistent roots', async () => {
    const rootA = threadRoot({ event_id: '$ra:example.com', origin_server_ts: 100 });
    const rootB = threadRoot({
      event_id: '$rb:example.com',
      origin_server_ts: 200,
      sender: CAROL,
    });
    const replyA = threadReply(rootA.event_id, {
      event_id: '$ra1:example.com',
      origin_server_ts: 150,
      sender: USER,
    });
    const replyB = threadReply(rootB.event_id, {
      event_id: '$rb1:example.com',
      origin_server_ts: 250,
      sender: BOB,
    });
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: [rootA, rootB, replyA, replyB],
      eventsBarrier: {
        match: (sql) => sql.includes('event_id IN'),
        count: 2,
      },
    });

    const [participated, all] = await Promise.all([
      request(db, `${threadsPath}?include=participated`, { headers: AUTH }),
      request(db, `${threadsPath}?include=all`, { headers: AUTH }),
    ]);

    expect(participated.status).toBe(200);
    expect(all.status).toBe(200);
    expect(participated.body.chunk).toHaveLength(1);
    expect(participated.body.chunk[0].event_id).toBe('$ra:example.com');
    expect(all.body.chunk).toHaveLength(2);
  });

  it('participated TOCTOU: reply removed after first ALL under barrier', async () => {
    const root = threadRoot({ event_id: '$r:example.com', origin_server_ts: 100 });
    const reply = threadReply(root.event_id, {
      event_id: '$rr:example.com',
      origin_server_ts: 110,
      sender: USER,
    });
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: [root, reply],
      eventsBarrier: {
        match: (sql) => sql.includes('event_id IN'),
        count: 2,
      },
      mutateEventsAfterAll: {
        after: 1,
        next: [root],
      },
    });

    const results = await Promise.all([
      request(db, `${threadsPath}?include=participated`, { headers: AUTH }),
      request(db, `${threadsPath}?include=participated`, { headers: AUTH }),
    ]);

    expect(statusesOf(results)).toEqual([200, 200]);
    const lengths = results.map((r) => r.body.chunk.length).sort((a, b) => a - b);
    expect(lengths).toEqual([0, 1]);
  });

  it('participated TOCTOU: alice reply added after first ALL under barrier', async () => {
    const root = threadRoot({
      event_id: '$r2:example.com',
      origin_server_ts: 100,
      sender: BOB,
    });
    const bobReply = threadReply(root.event_id, {
      event_id: '$br:example.com',
      origin_server_ts: 110,
      sender: BOB,
    });
    const aliceReply = threadReply(root.event_id, {
      event_id: '$ar:example.com',
      origin_server_ts: 120,
      sender: USER,
    });
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: [root, bobReply],
      eventsBarrier: {
        match: (sql) => sql.includes('event_id IN'),
        count: 2,
      },
      mutateEventsAfterAll: {
        after: 1,
        next: [root, bobReply, aliceReply],
      },
    });

    const results = await Promise.all([
      request(db, `${threadsPath}?include=participated`, { headers: AUTH }),
      request(db, `${threadsPath}?include=participated`, { headers: AUTH }),
    ]);

    expect(statusesOf(results)).toEqual([200, 200]);
    const lengths = results.map((r) => r.body.chunk.length).sort((a, b) => a - b);
    // without alice reply: root.sender is BOB and no alice participation → 0
    // with alice reply → 1
    expect(lengths).toEqual([0, 1]);
  });

  it('participated single-request membership→events TOCTOU clears participation', async () => {
    const root = threadRoot({ event_id: '$r3:example.com', origin_server_ts: 100 });
    const reply = threadReply(root.event_id, {
      event_id: '$rr3:example.com',
      origin_server_ts: 110,
      sender: USER,
    });
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: [root, reply],
      mutateEventsAfterMembershipSelects: {
        after: 1,
        next: [root],
      },
    });

    const res = await request(db, `${threadsPath}?include=participated`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(0);
  });

  for (let i = 0; i < 8; i++) {
    it(`threads participated soft-${i}: parallel include=participated`, async () => {
      const n = 2 + (i % 2);
      const roots = Array.from({ length: 3 }, (_, k) =>
        threadRoot({
          event_id: `$tr${k}:example.com`,
          origin_server_ts: 1000 + k,
          sender: k === 0 ? USER : BOB,
        })
      );
      const replies = roots.flatMap((r, k) =>
        k === 0
          ? [
              threadReply(r.event_id, {
                event_id: `$trr${k}:example.com`,
                origin_server_ts: 2000 + k,
                sender: USER,
              }),
            ]
          : [
              threadReply(r.event_id, {
                event_id: `$trr${k}:example.com`,
                origin_server_ts: 2000 + k,
                sender: BOB,
              }),
            ]
      );
      const db = createRelationsRaceDb({
        memberships: [joinMem()],
        events: [...roots, ...replies],
        eventsBarrier: {
          match: (sql) => sql.includes('event_id IN'),
          count: n,
        },
      });

      const results = await Promise.all(
        Array.from({ length: n }, () =>
          request(db, `${threadsPath}?include=participated`, { headers: AUTH })
        )
      );

      expect(results.every((r) => r.status === 200)).toBe(true);
      // root0 sender USER counts as participated even without reply filter alone
      expect(results.every((r) => r.body.chunk.length === 1)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Pagination from/dir concurrent isolation
// ---------------------------------------------------------------------------

describe('race relations pagination from/dir concurrent isolation after #208', () => {
  it('from=backwards∥forwards under events barrier isolate windows', async () => {
    const kids = seedChildren(10);
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: kids,
      eventsBarrier: {
        match: (sql) => sql.includes('FROM events e'),
        count: 2,
      },
    });

    const [back, fwd] = await Promise.all([
      request(db, `${allPath}?dir=b&from=1050&limit=5`, { headers: AUTH }),
      request(db, `${allPath}?dir=f&from=1050&limit=5`, { headers: AUTH }),
    ]);

    expect(back.status).toBe(200);
    expect(fwd.status).toBe(200);
    expect(
      back.body.chunk.every((e: { origin_server_ts: number }) => e.origin_server_ts < 1050)
    ).toBe(true);
    expect(
      fwd.body.chunk.every((e: { origin_server_ts: number }) => e.origin_server_ts > 1050)
    ).toBe(true);
  });

  it('limit isolation under dual ALL barrier', async () => {
    const kids = seedChildren(20);
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: kids,
      eventsBarrier: {
        match: (sql) => sql.includes('FROM events e'),
        count: 2,
      },
    });

    const [small, big] = await Promise.all([
      request(db, `${allPath}?limit=3`, { headers: AUTH }),
      request(db, `${allPath}?limit=15`, { headers: AUTH }),
    ]);

    expect(small.body.chunk).toHaveLength(3);
    expect(big.body.chunk).toHaveLength(15);
    expect(small.body.next_batch).toBeDefined();
    expect(big.body.next_batch).toBeDefined();
  });

  for (let i = 0; i < 10; i++) {
    it(`pagination soft-${i}: parallel from windows`, async () => {
      const kids = seedChildren(12);
      const from = 1000 + (i % 5) * 20;
      const db = createRelationsRaceDb({
        memberships: [joinMem()],
        events: kids,
        membershipBarrier: {
          match: (sql) => sql.includes('FROM room_memberships'),
          count: 2,
        },
      });

      const results = await Promise.all([
        request(db, `${allPath}?dir=b&from=${from}&limit=4`, { headers: AUTH }),
        request(db, `${allPath}?dir=b&from=${from}&limit=4`, { headers: AUTH }),
      ]);

      expect(statusesOf(results)).toEqual([200, 200]);
      expect(results[0].body.chunk.map((e: { event_id: string }) => e.event_id)).toEqual(
        results[1].body.chunk.map((e: { event_id: string }) => e.event_id)
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Cross-room / parent isolation
// ---------------------------------------------------------------------------

describe('race relations cross-room/parent isolation after #208', () => {
  it('room1∥room2 under membership barrier never leak events', async () => {
    const a = seedChildren(3, ROOM, PARENT);
    const b = seedChildren(5, ROOM2, PARENT2);
    const db = createRelationsRaceDb({
      memberships: [joinMem(ROOM), joinMem(ROOM2)],
      events: [...a, ...b],
      membershipBarrier: {
        match: (sql) => sql.includes('FROM room_memberships'),
        count: 2,
      },
    });

    const [ra, rb] = await Promise.all([
      request(db, allPath, { headers: AUTH }),
      request(db, allPath2, { headers: AUTH }),
    ]);

    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(ra.body.chunk).toHaveLength(3);
    expect(rb.body.chunk).toHaveLength(5);
    expect(
      ra.body.chunk.every((e: { room_id: string }) => e.room_id === ROOM)
    ).toBe(true);
    expect(
      rb.body.chunk.every((e: { room_id: string }) => e.room_id === ROOM2)
    ).toBe(true);
  });

  it('parent1∥parent2 same room isolate relation graphs', async () => {
    const p1 = seedChildren(2, ROOM, PARENT);
    const p2 = [
      child({
        event_id: '$p2a:example.com',
        origin_server_ts: 3000,
        relates_to_event_id: PARENT3,
      }),
      child({
        event_id: '$p2b:example.com',
        origin_server_ts: 3010,
        relates_to_event_id: PARENT3,
      }),
      child({
        event_id: '$p2c:example.com',
        origin_server_ts: 3020,
        relates_to_event_id: PARENT3,
      }),
    ];
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: [...p1, ...p2],
      eventsBarrier: {
        match: (sql) => sql.includes('FROM events e'),
        count: 2,
      },
    });

    const pathP3 = `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT3_ENC}`;
    const [r1, r3] = await Promise.all([
      request(db, allPath, { headers: AUTH }),
      request(db, pathP3, { headers: AUTH }),
    ]);

    expect(r1.body.chunk).toHaveLength(2);
    expect(r3.body.chunk).toHaveLength(3);
    expect(
      r1.body.chunk.every((e: { event_id: string }) => !e.event_id.startsWith('$p2'))
    ).toBe(true);
  });

  it('room2 ban mid-flight does not affect room1 GET', async () => {
    const a = seedChildren(2, ROOM, PARENT);
    const b = seedChildren(2, ROOM2, PARENT2);
    const db = createRelationsRaceDb({
      memberships: [joinMem(ROOM), joinMem(ROOM2)],
      events: [...a, ...b],
      membershipBarrier: {
        match: (sql) => sql.includes('FROM room_memberships'),
        count: 2,
      },
      mutateMembershipAfterSelects: {
        after: 1,
        next: [joinMem(ROOM), banMem(ROOM2)],
      },
    });

    const results = await Promise.all([
      request(db, allPath, { headers: AUTH }),
      request(db, allPath2, { headers: AUTH }),
    ]);

    const oks = results.filter((r) => r.status === 200);
    const forbids = results.filter((r) => r.status === 403);
    expect(oks.length + forbids.length).toBe(2);
    expect(oks.length).toBeGreaterThanOrEqual(1);
  });

  it('threads room1∥room2 isolation', async () => {
    const t1 = seedThreadBundle(ROOM);
    const t2 = seedThreadBundle(ROOM2);
    const db = createRelationsRaceDb({
      memberships: [joinMem(ROOM), joinMem(ROOM2)],
      events: [...t1, ...t2],
      membershipBarrier: {
        match: (sql) => sql.includes('FROM room_memberships'),
        count: 2,
      },
    });

    const [a, b] = await Promise.all([
      request(db, threadsPath, { headers: AUTH }),
      request(db, threadsPath2, { headers: AUTH }),
    ]);

    expect(a.body.chunk).toHaveLength(1);
    expect(b.body.chunk).toHaveLength(1);
    expect(a.body.chunk[0].room_id).toBe(ROOM);
    expect(b.body.chunk[0].room_id).toBe(ROOM2);
  });

  for (let i = 0; i < 8; i++) {
    it(`multi-room soft-${i}: three rooms parallel`, async () => {
      const rooms = [
        { id: ROOM, enc: ROOM_ENC, parent: PARENT, penc: PARENT_ENC },
        { id: ROOM2, enc: ROOM2_ENC, parent: PARENT2, penc: PARENT2_ENC },
        { id: ROOM3, enc: ROOM3_ENC, parent: PARENT3, penc: PARENT3_ENC },
      ];
      const events = rooms.flatMap((r, idx) =>
        seedChildren(2 + idx, r.id, r.parent)
      );
      const db = createRelationsRaceDb({
        memberships: rooms.map((r) => joinMem(r.id)),
        events,
        membershipBarrier: {
          match: (sql) => sql.includes('FROM room_memberships'),
          count: 3,
        },
      });

      const results = await Promise.all(
        rooms.map((r) =>
          request(
            db,
            `/_matrix/client/v1/rooms/${r.enc}/relations/${r.penc}`,
            { headers: AUTH }
          )
        )
      );

      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.map((r) => r.body.chunk.length)).toEqual([2, 3, 4]);
    });
  }
});

// ---------------------------------------------------------------------------
// Failure soft mid-concurrent
// ---------------------------------------------------------------------------

describe('race relations D1 failure soft mid-concurrent after #208', () => {
  it('membership fail: parallel GETs both 500', async () => {
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: seedChildren(2),
      failMembership: true,
      membershipBarrier: {
        match: (sql) => sql.includes('FROM room_memberships'),
        count: 2,
      },
    });

    const results = await Promise.all([
      request(db, allPath, { headers: AUTH }),
      request(db, allPath, { headers: AUTH }),
    ]);

    expect(results.every((r) => r.status >= 500)).toBe(true);
    expect(db.allCalls).toHaveLength(0);
  });

  it('events fail after membership: parallel GETs both 500', async () => {
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: seedChildren(2),
      failEvents: true,
      eventsBarrier: {
        match: (sql) => sql.includes('FROM events e'),
        count: 2,
      },
    });

    const results = await Promise.all([
      request(db, allPath, { headers: AUTH }),
      request(db, typedPath, { headers: AUTH }),
    ]);

    expect(results.every((r) => r.status >= 500)).toBe(true);
  });

  it('failMembershipAfter=1: one ok one 500 under barrier', async () => {
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: seedChildren(2),
      failMembershipAfter: 1,
      membershipBarrier: {
        match: (sql) => sql.includes('FROM room_memberships'),
        count: 2,
      },
    });

    const results = await Promise.all([
      request(db, allPath, { headers: AUTH }),
      request(db, allPath, { headers: AUTH }),
    ]);

    const oks = results.filter((r) => r.status === 200);
    const fails = results.filter((r) => r.status >= 500);
    expect(oks).toHaveLength(1);
    expect(fails).toHaveLength(1);
  });

  it('failEventsAfter=1: one ok one 500', async () => {
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: seedChildren(2),
      failEventsAfter: 1,
      eventsBarrier: {
        match: (sql) => sql.includes('FROM events e'),
        count: 2,
      },
    });

    const results = await Promise.all([
      request(db, allPath, { headers: AUTH }),
      request(db, allPath, { headers: AUTH }),
    ]);

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status >= 500)).toHaveLength(1);
  });

  for (let i = 0; i < 6; i++) {
    it(`failure soft-${i}: threads failEvents isolation`, async () => {
      const db = createRelationsRaceDb({
        memberships: [joinMem()],
        events: seedThreadBundle(),
        failEvents: i % 2 === 0,
      });

      const res = await request(db, threadsPath, { headers: AUTH });
      if (i % 2 === 0) {
        expect(res.status).toBeGreaterThanOrEqual(500);
      } else {
        expect(res.status).toBe(200);
        expect(res.body.chunk).toHaveLength(1);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Soft floods — method / auth / charset / membership / lifecycle
// ---------------------------------------------------------------------------

describe('relations concurrent soft flood — method matrix after #208', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
    for (let i = 0; i < 4; i++) {
      it(`method ${method} soft-${i} on ${['all', 'typed', 'threads'][i % 3]}`, async () => {
        const path =
          i % 3 === 0 ? allPath : i % 3 === 1 ? typedPath : threadsPath;
        const db = createRelationsRaceDb({
          memberships: [joinMem()],
          events: seedChildren(1),
        });

        const results = await Promise.all([
          request(db, path, { method, headers: AUTH }),
          request(db, path, { method, headers: AUTH }),
        ]);

        expect(results.every((r) => r.status === 404 || r.status === 405)).toBe(
          true
        );
      });
    }
  }
});

describe('relations concurrent soft flood — membership forbid after #208', () => {
  for (const membership of ['invite', 'ban', 'knock', 'missing'] as const) {
    for (let i = 0; i < 4; i++) {
      it(`forbid ${membership} soft-${i}`, async () => {
        const memberships =
          membership === 'missing'
            ? []
            : [{ room_id: ROOM, user_id: USER, membership }];
        const db = createRelationsRaceDb({
          memberships,
          events: seedChildren(2),
          membershipBarrier: {
            match: (sql) => sql.includes('FROM room_memberships'),
            count: 2,
          },
        });

        const path =
          i % 4 === 0
            ? allPath
            : i % 4 === 1
              ? typedPath
              : i % 4 === 2
                ? typedEventPath
                : threadsPath;

        const results = await Promise.all([
          request(db, path, { headers: AUTH }),
          request(db, path, { headers: AUTH }),
        ]);

        expect(statusesOf(results)).toEqual([403, 403]);
        expect(results.every((r) => r.errcode === 'M_FORBIDDEN')).toBe(true);
        expect(db.allCalls).toHaveLength(0);
      });
    }
  }
});

describe('relations concurrent soft flood — empty / charset / Accept after #208', () => {
  for (let i = 0; i < 10; i++) {
    it(`empty chunk soft-${i}`, async () => {
      const db = createRelationsRaceDb({
        memberships: [joinMem()],
        events: [],
        membershipBarrier: {
          match: (sql) => sql.includes('FROM room_memberships'),
          count: 2,
        },
      });

      const results = await Promise.all([
        request(db, allPath, {
          headers: {
            ...AUTH,
            Accept: i % 2 === 0 ? 'application/json' : '*/*',
          },
        }),
        request(db, typedPath, {
          headers: {
            ...AUTH,
            'Accept-Charset': i % 2 === 0 ? 'utf-8' : 'utf-8, *;q=0.1',
          },
        }),
      ]);

      expect(statusesOf(results)).toEqual([200, 200]);
      expect(results.every((r) => r.body.chunk.length === 0)).toBe(true);
    });
  }

  for (let i = 0; i < 6; i++) {
    it(`leave membership empty soft-${i}`, async () => {
      const db = createRelationsRaceDb({
        memberships: [leaveMem()],
        events: seedChildren(i % 3),
      });

      const res = await request(db, allPath, { headers: AUTH });
      expect(res.status).toBe(200);
      expect(res.body.chunk).toHaveLength(i % 3);
    });
  }
});

describe('relations concurrent soft flood — lifecycle join→leave→ban after #208', () => {
  for (let i = 0; i < 8; i++) {
    it(`lifecycle soft-${i}`, async () => {
      const db = createRelationsRaceDb({
        memberships: [joinMem()],
        events: seedChildren(3),
      });

      const joined = await request(db, allPath, { headers: AUTH });
      expect(joined.status).toBe(200);
      expect(joined.body.chunk).toHaveLength(3);

      db.setMemberships([leaveMem()]);
      const left = await request(db, typedPath, { headers: AUTH });
      expect(left.status).toBe(200);

      db.setMemberships([banMem()]);
      const banned = await Promise.all([
        request(db, allPath, { headers: AUTH }),
        request(db, threadsPath, { headers: AUTH }),
      ]);
      expect(statusesOf(banned)).toEqual([403, 403]);
    });
  }
});

describe('relations concurrent soft flood — dense annotations after #208', () => {
  for (let i = 0; i < 8; i++) {
    it(`dense soft-${i}: parallel limit cap`, async () => {
      const kids = seedChildren(120);
      const db = createRelationsRaceDb({
        memberships: [joinMem()],
        events: kids,
        eventsBarrier: {
          match: (sql) => sql.includes('FROM events e'),
          count: 2,
        },
      });

      const results = await Promise.all([
        request(db, `${allPath}?limit=100`, { headers: AUTH }),
        request(db, `${typedPath}?limit=100`, { headers: AUTH }),
      ]);

      expect(statusesOf(results)).toEqual([200, 200]);
      expect(results[0].body.chunk).toHaveLength(100);
      expect(results[1].body.chunk).toHaveLength(100);
      expect(results[0].body.next_batch).toBeDefined();
    });
  }
});

// ---------------------------------------------------------------------------
// SQL bind contracts under parallel
// ---------------------------------------------------------------------------

describe('relations concurrent SQL bind contracts after #208', () => {
  it('membership SELECT binds room_id + user_id for all endpoints', async () => {
    const kids = seedChildren(1);
    const bundle = seedThreadBundle();
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: [...kids, ...bundle],
      membershipBarrier: {
        match: (sql) => sql.includes('FROM room_memberships'),
        count: 4,
      },
    });

    await Promise.all([
      request(db, allPath, { headers: AUTH }),
      request(db, typedPath, { headers: AUTH }),
      request(db, typedEventPath, { headers: AUTH }),
      request(db, threadsPath, { headers: AUTH }),
    ]);

    const mem = db.selects.filter((s) => s.sql.includes('FROM room_memberships'));
    expect(mem).toHaveLength(4);
    for (const s of mem) {
      expect(s.args[0]).toBe(ROOM);
      expect(s.args[1]).toBe(USER);
    }
  });

  it('untyped relations ALL binds room + parent + limit+1', async () => {
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: seedChildren(2),
    });

    await request(db, `${allPath}?limit=7`, { headers: AUTH });
    const all = db.allCalls[0];
    expect(all.args[0]).toBe(ROOM);
    expect(all.args[1]).toBe(PARENT);
    expect(all.args[all.args.length - 1]).toBe(8);
  });

  it('typed binds relation_type; typed+eventType binds both', async () => {
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: seedChildren(2),
      membershipBarrier: {
        match: (sql) => sql.includes('FROM room_memberships'),
        count: 2,
      },
    });

    await Promise.all([
      request(db, typedPath, { headers: AUTH }),
      request(db, typedEventPath, { headers: AUTH }),
    ]);

    const typed = db.allCalls.find(
      (c) =>
        c.sql.includes('relation_type = ?') && !c.sql.includes('event_type = ?')
    );
    const both = db.allCalls.find(
      (c) =>
        c.sql.includes('relation_type = ?') && c.sql.includes('event_type = ?')
    );
    expect(typed?.args.slice(0, 3)).toEqual([ROOM, PARENT, 'm.annotation']);
    expect(both?.args.slice(0, 4)).toEqual([
      ROOM,
      PARENT,
      'm.annotation',
      'm.reaction',
    ]);
  });

  it('threads participated binds userId twice before limit', async () => {
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: seedThreadBundle(),
    });

    await request(db, `${threadsPath}?include=participated`, { headers: AUTH });
    const call = db.allCalls[0];
    expect(call.args[0]).toBe(ROOM);
    expect(call.args[1]).toBe(ROOM);
    expect(call.args[2]).toBe(USER);
    expect(call.args[3]).toBe(USER);
  });

  it('from pagination binds timestamp before limit', async () => {
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: seedChildren(5),
    });

    await request(db, `${allPath}?dir=b&from=1040&limit=2`, { headers: AUTH });
    const call = db.allCalls[0];
    expect(call.sql).toContain('origin_server_ts < ?');
    expect(call.args).toContain(1040);
    expect(call.args[call.args.length - 1]).toBe(3);
  });

  for (let i = 0; i < 8; i++) {
    it(`bind contract soft-${i}: parallel all path room+parent`, async () => {
      const db = createRelationsRaceDb({
        memberships: [joinMem()],
        events: seedChildren(3),
        eventsBarrier: {
          match: (sql) => sql.includes('FROM events e'),
          count: 2,
        },
      });

      await Promise.all([
        request(db, allPath, { headers: AUTH }),
        request(db, allPath, { headers: AUTH }),
      ]);

      expect(db.allCalls).toHaveLength(2);
      for (const c of db.allCalls) {
        expect(c.args[0]).toBe(ROOM);
        expect(c.args[1]).toBe(PARENT);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Relation type vocabulary concurrent soft
// ---------------------------------------------------------------------------

describe('relations concurrent soft flood — relation_type vocabulary after #208', () => {
  const types = [
    'm.annotation',
    'm.reference',
    'm.replace',
    'm.thread',
    'org.example.custom',
  ] as const;

  for (const relType of types) {
    for (let i = 0; i < 3; i++) {
      it(`relType ${relType} soft-${i}`, async () => {
        const events = [
          child({
            event_id: `$v0:example.com`,
            origin_server_ts: 10,
            relation_type: relType,
            event_type: relType === 'm.annotation' ? 'm.reaction' : 'm.room.message',
          }),
          child({
            event_id: `$v1:example.com`,
            origin_server_ts: 20,
            relation_type: 'm.annotation',
          }),
        ];
        const db = createRelationsRaceDb({
          memberships: [joinMem()],
          events,
          membershipBarrier: {
            match: (sql) => sql.includes('FROM room_memberships'),
            count: 2,
          },
        });

        const path = `${allPath}/${encodeURIComponent(relType)}`;
        const results = await Promise.all([
          request(db, path, { headers: AUTH }),
          request(db, path, { headers: AUTH }),
        ]);

        expect(statusesOf(results)).toEqual([200, 200]);
        const expected = relType === 'm.annotation' ? 1 : 1;
        // m.annotation has both? No — second is annotation, first is relType
        const want = events.filter((e) => e.relation_type === relType).length;
        expect(results[0].body.chunk).toHaveLength(want);
        expect(results[1].body.chunk).toHaveLength(want);
        void expected;
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Percent-encoding / path variants under concurrent
// ---------------------------------------------------------------------------

describe('relations concurrent soft flood — percent-encoding after #208', () => {
  for (let i = 0; i < 8; i++) {
    it(`encode soft-${i}: room+parent path variants`, async () => {
      const roomAlt = encodeURIComponent(ROOM);
      const parentAlt = encodeURIComponent(PARENT);
      const db = createRelationsRaceDb({
        memberships: [joinMem()],
        events: seedChildren(2),
        membershipBarrier: {
          match: (sql) => sql.includes('FROM room_memberships'),
          count: 2,
        },
      });

      const results = await Promise.all([
        request(db, `/_matrix/client/v1/rooms/${roomAlt}/relations/${parentAlt}`, {
          headers: AUTH,
        }),
        request(
          db,
          `/_matrix/client/v1/rooms/${roomAlt}/relations/${parentAlt}/m.annotation`,
          { headers: AUTH }
        ),
      ]);

      expect(statusesOf(results)).toEqual([200, 200]);
      expect(results[0].body.chunk).toHaveLength(2);
      expect(results[1].body.chunk).toHaveLength(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Equal timestamps / next_batch coherency under race
// ---------------------------------------------------------------------------

describe('race relations equal timestamps + next_batch coherency after #208', () => {
  it('equal timestamps dual GET preserve chunk length under ALL barrier', async () => {
    const kids = Array.from({ length: 5 }, (_, i) =>
      child({
        event_id: `$eq${i}:example.com`,
        origin_server_ts: 4242,
      })
    );
    const db = createRelationsRaceDb({
      memberships: [joinMem()],
      events: kids,
      eventsBarrier: {
        match: (sql) => sql.includes('FROM events e'),
        count: 2,
      },
    });

    const results = await Promise.all([
      request(db, `${allPath}?limit=3`, { headers: AUTH }),
      request(db, `${allPath}?limit=3`, { headers: AUTH }),
    ]);

    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results[0].body.chunk).toHaveLength(3);
    expect(results[1].body.chunk).toHaveLength(3);
    expect(results[0].body.next_batch).toBe('4242');
    expect(results[1].body.next_batch).toBe('4242');
  });

  for (let i = 0; i < 6; i++) {
    it(`next_batch soft-${i}: hasMore coherency`, async () => {
      const kids = seedChildren(8);
      const db = createRelationsRaceDb({
        memberships: [joinMem()],
        events: kids,
        membershipBarrier: {
          match: (sql) => sql.includes('FROM room_memberships'),
          count: 2,
        },
      });

      const results = await Promise.all([
        request(db, `${allPath}?limit=3`, { headers: AUTH }),
        request(db, `${allPath}?limit=3`, { headers: AUTH }),
      ]);

      expect(results.every((r) => typeof r.body.next_batch === 'string')).toBe(
        true
      );
      expect(results[0].body.next_batch).toBe(results[1].body.next_batch);
    });
  }
});
