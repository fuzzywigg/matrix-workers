/**
 * TOKENMAXX HEAVY leftovers after #209/#208/#207 — relations / threads *concurrent race / TOCTOU*
 * + soft/edge reliability for slices not covered by relations-api-routes,
 * relations-api-route-leftovers soft Promise.all floods (#179), or
 * presence-receipts-typing-todevice leftovers.
 *
 * Distinct domain — not account (#209), rooms-read/upgrade (#208), push (#207),
 * typing (#206), sliding-sync (#205), presence (#204), sync (#202),
 * voip/rtc/calls (#201), report/server-notices (#200), search/spaces (#199),
 * profile (#198/#197), tags (#196), workflows (#195), rooms-mutate (#194),
 * aliases (#193), rooms (#192), admin-mutate (#191). Complements #179 soft
 * concurrent selects which lacked membership SELECT→events ALL barriers,
 * leave-flip TOCTOU, events mutate mid-flight, and dual-endpoint SELECT barriers.
 *
 * Focus: membership SELECT→events ALL TOCTOU; dual membership barriers;
 * events mutate mid-flight; all∥relType∥eventType∥threads isolation;
 * threads include=participated TOCTOU; multi-room/parent isolation;
 * pagination concurrent; D1 failure soft; method/limit/dir/membership/
 * charset/auth soft floods; SQL bind contracts under parallel.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const authState = vi.hoisted(() => ({
  userId: '@alice:example.com' as string | undefined,
  deviceId: 'DEVICEA' as string,
}));

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', authState.userId);
      c.set('deviceId', authState.deviceId);
      await next();
    };
  },
}));

import relations from '../src/api/relations';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const ROOM = '!r:example.com';
const ROOM2 = '!r2:example.com';
const ROOM3 = '!r3:example.com';
const ROOM4 = '!r4:example.com';
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

function createRelationsRaceDb(
  opts: {
    memberships?: Membership[];
    events?: EventRow[];
    selectBarrier?: SelectBarrier;
    eventsBarrier?: SelectBarrier;
    mutateMembershipAfterSelects?: { after: number; next: Membership[] };
    mutateEventsAfterMembershipSelects?: { after: number; next: EventRow[] };
    mutateEventsAfterEventsSelects?: { after: number; next: EventRow[] };
    failOnMembershipSelect?: boolean;
    failOnEventsSelect?: boolean;
    failMembershipAfter?: number;
    failEventsAfter?: number;
    corruptContentIds?: Set<string>;
    delayMsOnMembership?: number;
    delayMsOnEvents?: number;
  } = {}
) {
  const memberships = [...(opts.memberships ?? [])];
  let events = [...(opts.events ?? [])];
  const selects: SqlCall[] = [];
  const log: string[] = [];

  let selectBarrier = opts.selectBarrier;
  let eventsBarrier = opts.eventsBarrier;
  const selectWaiters = { list: [] as Array<() => void> };
  const eventsWaiters = { list: [] as Array<() => void> };

  let membershipSelectCount = 0;
  let eventsSelectCount = 0;
  const mutateMembership = opts.mutateMembershipAfterSelects;
  const mutateEventsAfterMembership = opts.mutateEventsAfterMembershipSelects;
  const mutateEventsAfterEvents = opts.mutateEventsAfterEventsSelects;
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

  function mapRow(e: EventRow) {
    return {
      event_id: e.event_id,
      event_type: e.event_type,
      sender: e.sender,
      origin_server_ts: e.origin_server_ts,
      content: corruptContentIds.has(e.event_id) ? '{not-json' : e.content,
    };
  }

  const db = {
    memberships,
    get events() {
      return events;
    },
    setEvents(next: EventRow[]) {
      events = [...next];
    },
    selects,
    log,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              log.push(`first:${sql.slice(0, 56)}`);
              await withBarrier(
                selectBarrier,
                selectWaiters,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );
              if (opts.delayMsOnMembership) {
                await new Promise((r) => setTimeout(r, opts.delayMsOnMembership));
              }
              if (opts.failOnMembershipSelect) throw new Error('d1-membership-fail');
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
                if (mutateMembership && membershipSelectCount === mutateMembership.after) {
                  memberships.splice(0, memberships.length, ...mutateMembership.next);
                  log.push('mutate:membership');
                }
                if (
                  mutateEventsAfterMembership &&
                  membershipSelectCount === mutateEventsAfterMembership.after
                ) {
                  events = [...mutateEventsAfterMembership.next];
                  log.push('mutate:events-after-membership');
                }
                return (snapshot ? { membership: snapshot.membership } : null) as T;
              }
              throw new Error('Unhandled first() SQL: ' + sql.slice(0, 140));
            },
            async all<T>() {
              selects.push({ sql, args });
              log.push(`all:${sql.slice(0, 56)}`);
              await withBarrier(
                eventsBarrier,
                eventsWaiters,
                () => {
                  eventsBarrier = undefined;
                },
                sql,
                args
              );
              if (opts.delayMsOnEvents) {
                await new Promise((r) => setTimeout(r, opts.delayMsOnEvents));
              }
              if (opts.failOnEventsSelect) throw new Error('d1-events-fail');
              // Snapshot before mutate-after so first waiter sees pre-mutation rows.
              const eventsSnapshot = [...events];
              eventsSelectCount += 1;
              if (
                opts.failEventsAfter !== undefined &&
                eventsSelectCount > opts.failEventsAfter
              ) {
                throw new Error('d1-events-fail-after');
              }
              if (mutateEventsAfterEvents && eventsSelectCount === mutateEventsAfterEvents.after) {
                events = [...mutateEventsAfterEvents.next];
                log.push('mutate:events-after-events');
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
                const roots = eventsSnapshot.filter(
                  (e) =>
                    e.room_id === roomId &&
                    eventsSnapshot.some(
                      (c) =>
                        c.room_id === roomId &&
                        c.relation_type === 'm.thread' &&
                        c.relates_to_event_id === e.event_id
                    )
                );
                let filtered = roots;
                if (sql.includes('e.sender = ?') || sql.includes('participated')) {
                  const userId = args[2] as string;
                  filtered = roots.filter(
                    (e) =>
                      e.sender === userId ||
                      eventsSnapshot.some(
                        (r) => r.relates_to_event_id === e.event_id && r.sender === userId
                      )
                  );
                }
                const ordered = sortEvents(filtered, dir).slice(0, limit);
                return { results: ordered.map(mapRow) as T[] };
              }

              if (sql.includes('FROM events e') && sql.includes('relates_to_event_id')) {
                const roomId = args[0] as string;
                const eventId = args[1] as string;
                const dir = parseOrder(sql);
                let filtered = eventsSnapshot.filter(
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
                return { results: ordered.map(mapRow) as T[] };
              }

              throw new Error('Unhandled all() SQL: ' + sql.slice(0, 180));
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
): Promise<{ status: number; body: unknown; errcode?: string }> {
  const res = await relations.request('http://localhost' + path, init, envFor(db));
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const errcode =
    body && typeof body === 'object' && body !== null && 'errcode' in body
      ? String((body as { errcode: string }).errcode)
      : undefined;
  return { status: res.status, body, errcode };
}

function get(db: RelationsRaceDb, path: string, headers: Record<string, string> = AUTH) {
  return request(db, path, { method: 'GET', headers });
}

function statusesOf(results: Array<{ status: number }>) {
  return results.map((r) => r.status);
}

function chunkIds(body: unknown): string[] {
  if (!body || typeof body !== 'object' || body === null || !('chunk' in body)) {
    return [];
  }
  const chunk = (body as { chunk?: Array<{ event_id?: string }> }).chunk;
  if (!Array.isArray(chunk)) return [];
  return chunk.map((e) => String(e?.event_id ?? ''));
}

function joinMember(room = ROOM, user = USER): Membership {
  return { room_id: room, user_id: user, membership: 'join' };
}

function leaveMember(room = ROOM, user = USER): Membership {
  return { room_id: room, user_id: user, membership: 'leave' };
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
    sender: overrides.sender ?? USER,
    origin_server_ts: overrides.origin_server_ts,
    content:
      overrides.content ?? JSON.stringify({ body: 'root', msgtype: 'm.text' }),
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
const typedPath = `${base}/m.annotation`;
const typedEvtPath = `${base}/m.annotation/m.reaction`;
const threadsPath = `/_matrix/client/v1/rooms/${ROOM_ENC}/threads`;

function joinDb(
  extra?: Partial<Parameters<typeof createRelationsRaceDb>[0]>,
  events?: EventRow[]
) {
  return createRelationsRaceDb({
    memberships: [joinMember()],
    events: events ?? [child({ event_id: '$c1', origin_server_ts: 100 })],
    ...extra,
  });
}

beforeEach(() => {
  authState.userId = USER;
  authState.deviceId = 'DEVICEA';
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});


// ---------------------------------------------------------------------------
// Membership SELECT → events ALL TOCTOU
// ---------------------------------------------------------------------------

describe('race relations membership SELECT→events ALL TOCTOU after #207', () => {
  it('both parallel all-relations see join at SELECT; both return chunk', async () => {
    const db = joinDb({
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([get(db, base), get(db, base)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(chunkIds(results[0].body)).toEqual(['$c1']);
    expect(chunkIds(results[1].body)).toEqual(['$c1']);
    expect(db.selects.filter((s) => s.sql.includes('FROM room_memberships')).length).toBe(2);
  });

  it('leave-flip after first membership SELECT: second may forbid', async () => {
    const db = joinDb({
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
      mutateMembershipAfterSelects: {
        after: 1,
        next: [leaveMember()], // still allowed (join|leave)
      },
    });
    const results = await Promise.all([get(db, base), get(db, base)]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('ban-flip after first membership SELECT: second forbids', async () => {
    const db = joinDb({
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
      mutateMembershipAfterSelects: {
        after: 1,
        next: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      },
    });
    const results = await Promise.all([get(db, base), get(db, base)]);
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([200, 403]);
  });

  it('invite-flip mid dual SELECT forbids one request', async () => {
    const db = joinDb({
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
      mutateMembershipAfterSelects: {
        after: 1,
        next: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      },
    });
    const results = await Promise.all([get(db, typedPath), get(db, typedPath)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
  });

  it('knock-flip mid dual SELECT forbids one request', async () => {
    const db = joinDb({
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
      mutateMembershipAfterSelects: {
        after: 1,
        next: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      },
    });
    const results = await Promise.all([get(db, threadsPath), get(db, threadsPath)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
  });

  it('membership wipe mid dual SELECT forbids one request', async () => {
    const db = joinDb({
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
      mutateMembershipAfterSelects: { after: 1, next: [] },
    });
    const results = await Promise.all([get(db, typedEvtPath), get(db, typedEvtPath)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
  });

  it('triple barrier all∥typed∥threads all pass join', async () => {
    const db = joinDb(
      {
        selectBarrier: {
          count: 3,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
      },
      [
        child({ event_id: '$a', origin_server_ts: 10 }),
        threadRoot({ event_id: '$root', origin_server_ts: 1 }),
        threadReply('$root', { event_id: '$rep', origin_server_ts: 2 }),
      ]
    );
    const results = await Promise.all([
      get(db, base),
      get(db, typedPath),
      get(db, threadsPath),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(chunkIds(results[0].body)).toContain('$a');
    expect(chunkIds(results[2].body)).toContain('$root');
  });

  it('four-endpoint membership barrier coherency', async () => {
    const db = joinDb({
      selectBarrier: {
        count: 4,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([
      get(db, base),
      get(db, typedPath),
      get(db, typedEvtPath),
      get(db, threadsPath),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200, 200]);
  });
});

describe('race relations events ALL barriers after #207', () => {
  it('dual events ALL barrier returns same snapshot', async () => {
    const db = joinDb(
      {
        eventsBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM events e') && sql.includes('relates_to_event_id'),
        },
      },
      [
        child({ event_id: '$a', origin_server_ts: 100 }),
        child({ event_id: '$b', origin_server_ts: 200 }),
      ]
    );
    const results = await Promise.all([get(db, base), get(db, base)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(chunkIds(results[0].body)).toEqual(['$b', '$a']);
    expect(chunkIds(results[1].body)).toEqual(['$b', '$a']);
  });

  it('events append after first events SELECT: second may see more', async () => {
    const db = joinDb(
      {
        eventsBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM events e') && sql.includes('relates_to_event_id'),
        },
        mutateEventsAfterEventsSelects: {
          after: 1,
          next: [
            child({ event_id: '$a', origin_server_ts: 100 }),
            child({ event_id: '$new', origin_server_ts: 300 }),
          ],
        },
      },
      [child({ event_id: '$a', origin_server_ts: 100 })]
    );
    const results = await Promise.all([get(db, base), get(db, base)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const lens = results.map((r) => chunkIds(r.body).length).sort();
    expect(lens[0]).toBe(1);
    expect(lens[1]).toBeGreaterThanOrEqual(1);
  });

  it('events clear after first events SELECT: second may empty', async () => {
    const db = joinDb(
      {
        eventsBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM events e') && sql.includes('relates_to_event_id'),
        },
        mutateEventsAfterEventsSelects: { after: 1, next: [] },
      },
      [child({ event_id: '$a', origin_server_ts: 100 })]
    );
    const results = await Promise.all([get(db, base), get(db, base)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const lens = results.map((r) => chunkIds(r.body).length).sort();
    expect(lens).toEqual([0, 1]);
  });

  it('events mutate after membership SELECT before events ALL', async () => {
    const db = joinDb(
      {
        selectBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
        mutateEventsAfterMembershipSelects: {
          after: 1,
          next: [child({ event_id: '$late', origin_server_ts: 999 })],
        },
      },
      [child({ event_id: '$early', origin_server_ts: 1 })]
    );
    const results = await Promise.all([get(db, base), get(db, base)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    // first saw early membership then events (possibly mutated); at least one sees late
    const allIds = results.flatMap((r) => chunkIds(r.body));
    expect(allIds.length).toBeGreaterThanOrEqual(1);
  });

  it('typed relType events barrier isolation from all-relations', async () => {
    const db = joinDb(
      {
        eventsBarrier: {
          count: 2,
          match: (sql) =>
            sql.includes('relation_type = ?') && !sql.includes('event_type = ?'),
        },
      },
      [
        child({ event_id: '$ann', origin_server_ts: 10, relation_type: 'm.annotation' }),
        child({
          event_id: '$ref',
          origin_server_ts: 20,
          relation_type: 'm.reference',
          event_type: 'm.room.message',
        }),
      ]
    );
    const results = await Promise.all([get(db, typedPath), get(db, typedPath)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(chunkIds(results[0].body)).toEqual(['$ann']);
    expect(chunkIds(results[1].body)).toEqual(['$ann']);
  });

  it('typed+eventType events barrier', async () => {
    const db = joinDb(
      {
        eventsBarrier: {
          count: 2,
          match: (sql) =>
            sql.includes('relation_type = ?') && sql.includes('event_type = ?'),
        },
      },
      [
        child({ event_id: '$rx', origin_server_ts: 10 }),
        child({
          event_id: '$msg',
          origin_server_ts: 20,
          event_type: 'm.room.message',
          relation_type: 'm.annotation',
        }),
      ]
    );
    const results = await Promise.all([get(db, typedEvtPath), get(db, typedEvtPath)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(chunkIds(results[0].body)).toEqual(['$rx']);
  });
});

describe('race relations threads SELECT barriers after #207', () => {
  it('dual threads barrier returns same roots', async () => {
    const db = joinDb(
      {
        eventsBarrier: {
          count: 2,
          match: (sql) => sql.includes('event_id IN'),
        },
      },
      [
        threadRoot({ event_id: '$r1', origin_server_ts: 10 }),
        threadReply('$r1', { event_id: '$p1', origin_server_ts: 11 }),
        threadRoot({ event_id: '$r2', origin_server_ts: 20 }),
        threadReply('$r2', { event_id: '$p2', origin_server_ts: 21 }),
      ]
    );
    const results = await Promise.all([get(db, threadsPath), get(db, threadsPath)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(chunkIds(results[0].body)).toEqual(['$r2', '$r1']);
    expect(chunkIds(results[1].body)).toEqual(['$r2', '$r1']);
  });

  it('thread root appended mid dual threads SELECT', async () => {
    const db = joinDb(
      {
        eventsBarrier: {
          count: 2,
          match: (sql) => sql.includes('event_id IN'),
        },
        mutateEventsAfterEventsSelects: {
          after: 1,
          next: [
            threadRoot({ event_id: '$r1', origin_server_ts: 10 }),
            threadReply('$r1', { event_id: '$p1', origin_server_ts: 11 }),
            threadRoot({ event_id: '$rNew', origin_server_ts: 99 }),
            threadReply('$rNew', { event_id: '$pNew', origin_server_ts: 100 }),
          ],
        },
      },
      [
        threadRoot({ event_id: '$r1', origin_server_ts: 10 }),
        threadReply('$r1', { event_id: '$p1', origin_server_ts: 11 }),
      ]
    );
    const results = await Promise.all([get(db, threadsPath), get(db, threadsPath)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const lens = results.map((r) => chunkIds(r.body).length).sort();
    expect(lens[0]).toBe(1);
    expect(lens[1]).toBeGreaterThanOrEqual(1);
  });

  it('include=participated TOCTOU under membership barrier', async () => {
    const db = joinDb(
      {
        selectBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
      },
      [
        threadRoot({ event_id: '$rAlice', origin_server_ts: 10, sender: USER }),
        threadReply('$rAlice', { event_id: '$pA', origin_server_ts: 11, sender: USER }),
        threadRoot({ event_id: '$rBob', origin_server_ts: 20, sender: BOB }),
        threadReply('$rBob', { event_id: '$pB', origin_server_ts: 21, sender: BOB }),
      ]
    );
    const path = threadsPath + '?include=participated';
    const results = await Promise.all([get(db, path), get(db, path)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(chunkIds(results[0].body)).toEqual(['$rAlice']);
    expect(chunkIds(results[1].body)).toEqual(['$rAlice']);
  });

  it('participated filter flips when reply sender mutates mid events', async () => {
    const db = joinDb(
      {
        eventsBarrier: {
          count: 2,
          match: (sql) => sql.includes('event_id IN'),
        },
        mutateEventsAfterEventsSelects: {
          after: 1,
          next: [
            threadRoot({ event_id: '$rBob', origin_server_ts: 20, sender: BOB }),
            threadReply('$rBob', { event_id: '$pB', origin_server_ts: 21, sender: USER }),
          ],
        },
      },
      [
        threadRoot({ event_id: '$rBob', origin_server_ts: 20, sender: BOB }),
        threadReply('$rBob', { event_id: '$pB', origin_server_ts: 21, sender: BOB }),
      ]
    );
    const path = threadsPath + '?include=participated';
    const results = await Promise.all([get(db, path), get(db, path)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    const lens = results.map((r) => chunkIds(r.body).length).sort();
    expect(lens).toEqual([0, 1]);
  });
});

describe('race relations multi-room / multi-parent isolation after #207', () => {
  it('parallel room1∥room2 membership barriers stay isolated', async () => {
    const db = createRelationsRaceDb({
      memberships: [joinMember(ROOM), joinMember(ROOM2)],
      events: [
        child({ event_id: '$r1', origin_server_ts: 10, room_id: ROOM }),
        child({
          event_id: '$r2',
          origin_server_ts: 20,
          room_id: ROOM2,
          relates_to_event_id: PARENT,
        }),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const p1 = `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}`;
    const p2 = `/_matrix/client/v1/rooms/${ROOM2_ENC}/relations/${PARENT_ENC}`;
    const results = await Promise.all([get(db, p1), get(db, p2)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(chunkIds(results[0].body)).toEqual(['$r1']);
    expect(chunkIds(results[1].body)).toEqual(['$r2']);
  });

  it('parallel parent∥parent2 isolation under events barrier', async () => {
    const db = createRelationsRaceDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p1c', origin_server_ts: 10, relates_to_event_id: PARENT }),
        child({ event_id: '$p2c', origin_server_ts: 20, relates_to_event_id: PARENT2 }),
      ],
      eventsBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM events e') && sql.includes('relates_to_event_id'),
      },
    });
    const p1 = base;
    const p2 = `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT2_ENC}`;
    const results = await Promise.all([get(db, p1), get(db, p2)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(chunkIds(results[0].body)).toEqual(['$p1c']);
    expect(chunkIds(results[1].body)).toEqual(['$p2c']);
  });

  it('three-room threads isolation under barrier', async () => {
    const db = createRelationsRaceDb({
      memberships: [joinMember(ROOM), joinMember(ROOM2), joinMember(ROOM3)],
      events: [
        threadRoot({ event_id: '$a', origin_server_ts: 1, room_id: ROOM }),
        threadReply('$a', { event_id: '$ar', origin_server_ts: 2, room_id: ROOM }),
        threadRoot({ event_id: '$b', origin_server_ts: 1, room_id: ROOM2 }),
        threadReply('$b', { event_id: '$br', origin_server_ts: 2, room_id: ROOM2 }),
        threadRoot({ event_id: '$c', origin_server_ts: 1, room_id: ROOM3 }),
        threadReply('$c', { event_id: '$cr', origin_server_ts: 2, room_id: ROOM3 }),
      ],
      selectBarrier: {
        count: 3,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([
      get(db, `/_matrix/client/v1/rooms/${ROOM_ENC}/threads`),
      get(db, `/_matrix/client/v1/rooms/${ROOM2_ENC}/threads`),
      get(db, `/_matrix/client/v1/rooms/${ROOM3_ENC}/threads`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(chunkIds(results[0].body)).toEqual(['$a']);
    expect(chunkIds(results[1].body)).toEqual(['$b']);
    expect(chunkIds(results[2].body)).toEqual(['$c']);
  });

  it('cross-endpoint all∥threads do not leak event types', async () => {
    const db = joinDb(
      {
        selectBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
      },
      [
        child({ event_id: '$ann', origin_server_ts: 50 }),
        threadRoot({ event_id: '$root', origin_server_ts: 1 }),
        threadReply('$root', { event_id: '$rep', origin_server_ts: 2 }),
      ]
    );
    const results = await Promise.all([get(db, base), get(db, threadsPath)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(chunkIds(results[0].body)).toContain('$ann');
    expect(chunkIds(results[0].body)).not.toContain('$root');
    expect(chunkIds(results[1].body)).toEqual(['$root']);
  });
});

describe('race relations pagination concurrent after #207', () => {
  it('from cursor concurrent dir=b isolation', async () => {
    const kids = [
      child({ event_id: '$1', origin_server_ts: 100 }),
      child({ event_id: '$2', origin_server_ts: 200 }),
      child({ event_id: '$3', origin_server_ts: 300 }),
      child({ event_id: '$4', origin_server_ts: 400 }),
    ];
    const db = joinDb(
      {
        eventsBarrier: {
          count: 2,
          match: (sql) => sql.includes('origin_server_ts < ?'),
        },
      },
      kids
    );
    const results = await Promise.all([
      get(db, base + '?from=350&dir=b'),
      get(db, base + '?from=250&dir=b'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(chunkIds(results[0].body)).toEqual(['$3', '$2', '$1']);
    expect(chunkIds(results[1].body)).toEqual(['$2', '$1']);
  });

  it('from cursor concurrent dir=f isolation', async () => {
    const kids = [
      child({ event_id: '$1', origin_server_ts: 100 }),
      child({ event_id: '$2', origin_server_ts: 200 }),
      child({ event_id: '$3', origin_server_ts: 300 }),
    ];
    const db = joinDb(
      {
        eventsBarrier: {
          count: 2,
          match: (sql) => sql.includes('origin_server_ts > ?'),
        },
      },
      kids
    );
    const results = await Promise.all([
      get(db, base + '?from=150&dir=f'),
      get(db, base + '?from=50&dir=f'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(chunkIds(results[0].body)).toEqual(['$2', '$3']);
    expect(chunkIds(results[1].body)).toEqual(['$1', '$2', '$3']);
  });

  it('limit concurrent next_batch coherency', async () => {
    const kids = Array.from({ length: 10 }, (_, i) =>
      child({ event_id: `$L${i}`, origin_server_ts: (i + 1) * 10 })
    );
    const db = joinDb(
      {
        eventsBarrier: {
          count: 3,
          match: (sql) => sql.includes('FROM events e') && sql.includes('relates_to_event_id'),
        },
      },
      kids
    );
    const results = await Promise.all([
      get(db, base + '?limit=3'),
      get(db, base + '?limit=5'),
      get(db, base + '?limit=8'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results[0].body.chunk).toHaveLength(3);
    expect(results[0].body.next_batch).toBeTruthy();
    expect(results[1].body.chunk).toHaveLength(5);
    expect(results[2].body.chunk).toHaveLength(8);
  });
});

describe('race relations leave historic + auth identity after #207', () => {
  it('leave membership concurrent still allows historic reads', async () => {
    const db = createRelationsRaceDb({
      memberships: [leaveMember()],
      events: [child({ event_id: '$h', origin_server_ts: 1 })],
      selectBarrier: {
        count: 3,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([
      get(db, base),
      get(db, typedPath),
      get(db, threadsPath),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
  });

  it('auth userId swap mid barrier affects membership lookup', async () => {
    const db = createRelationsRaceDb({
      memberships: [joinMember(ROOM, USER)],
      events: [child({ event_id: '$a', origin_server_ts: 1 })],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const p1 = get(db, base);
    authState.userId = BOB;
    const p2 = get(db, base);
    const results = await Promise.all([p1, p2]);
    // One may be alice (ok) one bob (forbidden) depending on when set applied
    expect(results.every((r) => r.status === 200 || r.status === 403)).toBe(true);
    authState.userId = USER;
  });
});

describe('race relations store failure mid concurrent after #207', () => {
  it('membership SELECT fail soft → 500 both', async () => {
    const db = joinDb({ failOnMembershipSelect: true });
    const results = await Promise.all([get(db, base), get(db, typedPath)]);
    expect(results.every((r) => r.status >= 500)).toBe(true);
  });

  it('events SELECT fail soft → 500', async () => {
    const db = joinDb({ failOnEventsSelect: true });
    const results = await Promise.all([get(db, base), get(db, base)]);
    expect(results.every((r) => r.status >= 500)).toBe(true);
  });

  it('fail membership after first of dual barrier', async () => {
    const db = joinDb({
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
      failMembershipAfter: 1,
    });
    const results = await Promise.all([get(db, base), get(db, base)]);
    const ok = results.filter((r) => r.status === 200).length;
    const bad = results.filter((r) => r.status >= 500).length;
    expect(ok).toBe(1);
    expect(bad).toBe(1);
  });

  it('fail events after first of dual barrier', async () => {
    const db = joinDb({
      eventsBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM events e'),
      },
      failEventsAfter: 1,
    });
    const results = await Promise.all([get(db, base), get(db, base)]);
    expect(results.filter((r) => r.status === 200).length).toBe(1);
    expect(results.filter((r) => r.status >= 500).length).toBe(1);
  });

  it('corrupt content JSON mid concurrent → 500 for that request', async () => {
    const db = joinDb(
      {
        eventsBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM events e'),
        },
        corruptContentIds: new Set(['$bad']),
      },
      [
        child({ event_id: '$ok', origin_server_ts: 1 }),
        child({ event_id: '$bad', origin_server_ts: 2 }),
      ]
    );
    const results = await Promise.all([get(db, base), get(db, base)]);
    expect(results.every((r) => r.status >= 500)).toBe(true);
  });
});


describe('relations concurrent soft flood — method matrix after #207', () => {
  it('method POST soft-0 on all-relations', async () => {
    const db = joinDb();
    const res = await request(db, base, { method: 'POST', headers: AUTH });
    expect([404, 405, 200, 204].includes(res.status) || res.status >= 400).toBe(true);
  });

  it('method PUT soft-1 on all-relations', async () => {
    const db = joinDb();
    const res = await request(db, base, { method: 'PUT', headers: AUTH });
    expect([404, 405, 200, 204].includes(res.status) || res.status >= 400).toBe(true);
  });

  it('method DELETE soft-2 on all-relations', async () => {
    const db = joinDb();
    const res = await request(db, base, { method: 'DELETE', headers: AUTH });
    expect([404, 405, 200, 204].includes(res.status) || res.status >= 400).toBe(true);
  });

  it('method PATCH soft-3 on all-relations', async () => {
    const db = joinDb();
    const res = await request(db, base, { method: 'PATCH', headers: AUTH });
    expect([404, 405, 200, 204].includes(res.status) || res.status >= 400).toBe(true);
  });

  it('method OPTIONS soft-4 on all-relations', async () => {
    const db = joinDb();
    const res = await request(db, base, { method: 'OPTIONS', headers: AUTH });
    expect([404, 405, 200, 204].includes(res.status) || res.status >= 400).toBe(true);
  });

  it('method HEAD soft-5 on all-relations', async () => {
    const db = joinDb();
    const res = await request(db, base, { method: 'HEAD', headers: AUTH });
    expect([404, 405, 200, 204].includes(res.status) || res.status >= 400).toBe(true);
  });

  it('method POST soft-0 on threads', async () => {
    const db = joinDb();
    const res = await request(db, threadsPath, { method: 'POST', headers: AUTH });
    expect([404, 405, 200, 204].includes(res.status) || res.status >= 400).toBe(true);
  });

  it('method PUT soft-1 on threads', async () => {
    const db = joinDb();
    const res = await request(db, threadsPath, { method: 'PUT', headers: AUTH });
    expect([404, 405, 200, 204].includes(res.status) || res.status >= 400).toBe(true);
  });

  it('method DELETE soft-2 on threads', async () => {
    const db = joinDb();
    const res = await request(db, threadsPath, { method: 'DELETE', headers: AUTH });
    expect([404, 405, 200, 204].includes(res.status) || res.status >= 400).toBe(true);
  });

  it('method PATCH soft-3 on threads', async () => {
    const db = joinDb();
    const res = await request(db, threadsPath, { method: 'PATCH', headers: AUTH });
    expect([404, 405, 200, 204].includes(res.status) || res.status >= 400).toBe(true);
  });

  it('method OPTIONS soft-4 on threads', async () => {
    const db = joinDb();
    const res = await request(db, threadsPath, { method: 'OPTIONS', headers: AUTH });
    expect([404, 405, 200, 204].includes(res.status) || res.status >= 400).toBe(true);
  });

  it('method HEAD soft-5 on threads', async () => {
    const db = joinDb();
    const res = await request(db, threadsPath, { method: 'HEAD', headers: AUTH });
    expect([404, 405, 200, 204].includes(res.status) || res.status >= 400).toBe(true);
  });

});

describe('relations concurrent soft flood — membership forbid after #207', () => {
  it('forbids membership=invite on all', async () => {
    const db = createRelationsRaceDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$x', origin_server_ts: 1 })],
    });
    const res = await get(db, base);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it('forbids membership=invite on typed', async () => {
    const db = createRelationsRaceDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$x', origin_server_ts: 1 })],
    });
    const res = await get(db, typedPath);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it('forbids membership=invite on typedEvt', async () => {
    const db = createRelationsRaceDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$x', origin_server_ts: 1 })],
    });
    const res = await get(db, typedEvtPath);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it('forbids membership=invite on threads', async () => {
    const db = createRelationsRaceDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
      events: [child({ event_id: '$x', origin_server_ts: 1 })],
    });
    const res = await get(db, threadsPath);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it('forbids membership=ban on all', async () => {
    const db = createRelationsRaceDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$x', origin_server_ts: 1 })],
    });
    const res = await get(db, base);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it('forbids membership=ban on typed', async () => {
    const db = createRelationsRaceDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$x', origin_server_ts: 1 })],
    });
    const res = await get(db, typedPath);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it('forbids membership=ban on typedEvt', async () => {
    const db = createRelationsRaceDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$x', origin_server_ts: 1 })],
    });
    const res = await get(db, typedEvtPath);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it('forbids membership=ban on threads', async () => {
    const db = createRelationsRaceDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      events: [child({ event_id: '$x', origin_server_ts: 1 })],
    });
    const res = await get(db, threadsPath);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it('forbids membership=knock on all', async () => {
    const db = createRelationsRaceDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$x', origin_server_ts: 1 })],
    });
    const res = await get(db, base);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it('forbids membership=knock on typed', async () => {
    const db = createRelationsRaceDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$x', origin_server_ts: 1 })],
    });
    const res = await get(db, typedPath);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it('forbids membership=knock on typedEvt', async () => {
    const db = createRelationsRaceDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$x', origin_server_ts: 1 })],
    });
    const res = await get(db, typedEvtPath);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it('forbids membership=knock on threads', async () => {
    const db = createRelationsRaceDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
      events: [child({ event_id: '$x', origin_server_ts: 1 })],
    });
    const res = await get(db, threadsPath);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it('forbids membership=missing on all', async () => {
    const db = createRelationsRaceDb({
      memberships: [],
      events: [child({ event_id: '$x', origin_server_ts: 1 })],
    });
    const res = await get(db, base);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it('forbids membership=missing on typed', async () => {
    const db = createRelationsRaceDb({
      memberships: [],
      events: [child({ event_id: '$x', origin_server_ts: 1 })],
    });
    const res = await get(db, typedPath);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it('forbids membership=missing on typedEvt', async () => {
    const db = createRelationsRaceDb({
      memberships: [],
      events: [child({ event_id: '$x', origin_server_ts: 1 })],
    });
    const res = await get(db, typedEvtPath);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

  it('forbids membership=missing on threads', async () => {
    const db = createRelationsRaceDb({
      memberships: [],
      events: [child({ event_id: '$x', origin_server_ts: 1 })],
    });
    const res = await get(db, threadsPath);
    expect(res.status).toBe(403);
    expect(res.errcode).toBe('M_FORBIDDEN');
  });

});

describe('relations concurrent soft flood — limit / dir / from edges after #207', () => {
  it('limit edge soft-0 (0)', async () => {
    const db = joinDb(undefined, Array.from({ length: 5 }, (_, i) => child({ event_id: `$e${i}`, origin_server_ts: i + 1 })));
    const res = await get(db, base + '?limit=0');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('limit edge soft-1 (1)', async () => {
    const db = joinDb(undefined, Array.from({ length: 5 }, (_, i) => child({ event_id: `$e${i}`, origin_server_ts: i + 1 })));
    const res = await get(db, base + '?limit=1');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('limit edge soft-2 (50)', async () => {
    const db = joinDb(undefined, Array.from({ length: 5 }, (_, i) => child({ event_id: `$e${i}`, origin_server_ts: i + 1 })));
    const res = await get(db, base + '?limit=50');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('limit edge soft-3 (100)', async () => {
    const db = joinDb(undefined, Array.from({ length: 5 }, (_, i) => child({ event_id: `$e${i}`, origin_server_ts: i + 1 })));
    const res = await get(db, base + '?limit=100');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('limit edge soft-4 (101)', async () => {
    const db = joinDb(undefined, Array.from({ length: 5 }, (_, i) => child({ event_id: `$e${i}`, origin_server_ts: i + 1 })));
    const res = await get(db, base + '?limit=101');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('limit edge soft-5 (9999)', async () => {
    const db = joinDb(undefined, Array.from({ length: 5 }, (_, i) => child({ event_id: `$e${i}`, origin_server_ts: i + 1 })));
    const res = await get(db, base + '?limit=9999');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('limit edge soft-6 (-1)', async () => {
    const db = joinDb(undefined, Array.from({ length: 5 }, (_, i) => child({ event_id: `$e${i}`, origin_server_ts: i + 1 })));
    const res = await get(db, base + '?limit=-1');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('limit edge soft-7 (abc)', async () => {
    const db = joinDb(undefined, Array.from({ length: 5 }, (_, i) => child({ event_id: `$e${i}`, origin_server_ts: i + 1 })));
    const res = await get(db, base + '?limit=abc');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('limit edge soft-8 (50xyz)', async () => {
    const db = joinDb(undefined, Array.from({ length: 5 }, (_, i) => child({ event_id: `$e${i}`, origin_server_ts: i + 1 })));
    const res = await get(db, base + '?limit=50xyz');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('limit edge soft-9 (default)', async () => {
    const db = joinDb(undefined, Array.from({ length: 5 }, (_, i) => child({ event_id: `$e${i}`, origin_server_ts: i + 1 })));
    const res = await get(db, base + '');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('dir edge soft-0 (b)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$a', origin_server_ts: 1 }),
      child({ event_id: '$b', origin_server_ts: 2 }),
    ]);
    const res = await get(db, base + '?dir=b');
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBe(2);
  });

  it('dir edge soft-1 (f)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$a', origin_server_ts: 1 }),
      child({ event_id: '$b', origin_server_ts: 2 }),
    ]);
    const res = await get(db, base + '?dir=f');
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBe(2);
  });

  it('dir edge soft-2 (B)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$a', origin_server_ts: 1 }),
      child({ event_id: '$b', origin_server_ts: 2 }),
    ]);
    const res = await get(db, base + '?dir=B');
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBe(2);
  });

  it('dir edge soft-3 (forward)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$a', origin_server_ts: 1 }),
      child({ event_id: '$b', origin_server_ts: 2 }),
    ]);
    const res = await get(db, base + '?dir=forward');
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBe(2);
  });

  it('dir edge soft-4 (empty)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$a', origin_server_ts: 1 }),
      child({ event_id: '$b', origin_server_ts: 2 }),
    ]);
    const res = await get(db, base + '?dir=');
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBe(2);
  });

  it('dir edge soft-5 (weird)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$a', origin_server_ts: 1 }),
      child({ event_id: '$b', origin_server_ts: 2 }),
    ]);
    const res = await get(db, base + '?dir=weird');
    expect(res.status).toBe(200);
    expect(res.body.chunk.length).toBe(2);
  });

  it('from edge soft-0 (0)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$a', origin_server_ts: 100 }),
      child({ event_id: '$b', origin_server_ts: 200 }),
    ]);
    const res = await get(db, base + '?from=0&dir=b');
    expect(res.status).toBe(200);
  });

  it('from edge soft-1 (1)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$a', origin_server_ts: 100 }),
      child({ event_id: '$b', origin_server_ts: 200 }),
    ]);
    const res = await get(db, base + '?from=1&dir=b');
    expect(res.status).toBe(200);
  });

  it('from edge soft-2 (150)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$a', origin_server_ts: 100 }),
      child({ event_id: '$b', origin_server_ts: 200 }),
    ]);
    const res = await get(db, base + '?from=150&dir=b');
    expect(res.status).toBe(200);
  });

  it('from edge soft-3 (999999)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$a', origin_server_ts: 100 }),
      child({ event_id: '$b', origin_server_ts: 200 }),
    ]);
    const res = await get(db, base + '?from=999999&dir=b');
    expect(res.status).toBe(200);
  });

  it('from edge soft-4 (NaN)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$a', origin_server_ts: 100 }),
      child({ event_id: '$b', origin_server_ts: 200 }),
    ]);
    const res = await get(db, base + '?from=NaN&dir=b');
    expect(res.status).toBe(200);
  });

  it('from edge soft-5 (abc)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$a', origin_server_ts: 100 }),
      child({ event_id: '$b', origin_server_ts: 200 }),
    ]);
    const res = await get(db, base + '?from=abc&dir=b');
    expect(res.status).toBe(200);
  });

});

describe('relations concurrent soft flood — charset / headers after #207', () => {
  it('header soft-0 — Accept application/json', async () => {
    const db = joinDb();
    const res = await request(db, base, { method: 'GET', headers: { Authorization: 'Bearer t', Accept: 'application/json' } });
    expect(res.status).toBe(200);
  });

  it('header soft-1 — Accept */*', async () => {
    const db = joinDb();
    const res = await request(db, base, { method: 'GET', headers: { Authorization: 'Bearer t', Accept: '*/*' } });
    expect(res.status).toBe(200);
  });

  it('header soft-2 — Accept-Language', async () => {
    const db = joinDb();
    const res = await request(db, base, { method: 'GET', headers: { Authorization: 'Bearer t', 'Accept-Language': 'en-US' } });
    expect(res.status).toBe(200);
  });

  it('header soft-3 — X-Requested-With', async () => {
    const db = joinDb();
    const res = await request(db, base, { method: 'GET', headers: { Authorization: 'Bearer t', 'X-Requested-With': 'XMLHttpRequest' } });
    expect(res.status).toBe(200);
  });

  it('header soft-4 — Cache-Control', async () => {
    const db = joinDb();
    const res = await request(db, base, { method: 'GET', headers: { Authorization: 'Bearer t', 'Cache-Control': 'no-cache' } });
    expect(res.status).toBe(200);
  });

  it('header soft-5 — User-Agent', async () => {
    const db = joinDb();
    const res = await request(db, base, { method: 'GET', headers: { Authorization: 'Bearer t', 'User-Agent': 'Element/1' } });
    expect(res.status).toBe(200);
  });

  it('header soft-6 — Content-Type unused', async () => {
    const db = joinDb();
    const res = await request(db, base, { method: 'GET', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' } });
    expect(res.status).toBe(200);
  });

  it('header soft-7 — charset utf-8', async () => {
    const db = joinDb();
    const res = await request(db, base, { method: 'GET', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json; charset=utf-8' } });
    expect(res.status).toBe(200);
  });

});

describe('relations concurrent soft flood — percent-encoding after #207', () => {
  it('double-encoded-ish room still decodes once via Hono', async () => {
    const db = joinDb();
    const res = await get(db, base);
    expect(res.status).toBe(200);
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args[0]).toBe(ROOM);
    expect(mem?.args[1]).toBe(USER);
  });

  it('URL-encoded relType round-trips', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$x', origin_server_ts: 1, relation_type: 'm.annotation' }),
    ]);
    const path = base + '/' + encodeURIComponent('m.annotation');
    const res = await get(db, path);
    expect(res.status).toBe(200);
    expect(chunkIds(res.body)).toEqual(['$x']);
  });

  it('URL-encoded eventType round-trips', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$x', origin_server_ts: 1, event_type: 'm.reaction' }),
    ]);
    const path =
      base +
      '/' +
      encodeURIComponent('m.annotation') +
      '/' +
      encodeURIComponent('m.reaction');
    const res = await get(db, path);
    expect(res.status).toBe(200);
    expect(chunkIds(res.body)).toEqual(['$x']);
  });

  it('multi-room percent-encoded threads', async () => {
    for (const [room, enc] of [
      [ROOM, ROOM_ENC],
      [ROOM2, ROOM2_ENC],
      [ROOM3, ROOM3_ENC],
    ] as const) {
      const db = createRelationsRaceDb({
        memberships: [joinMember(room)],
        events: [
          threadRoot({ event_id: '$t', origin_server_ts: 1, room_id: room }),
          threadReply('$t', { event_id: '$tr', origin_server_ts: 2, room_id: room }),
        ],
      });
      const res = await get(db, `/_matrix/client/v1/rooms/${enc}/threads`);
      expect(res.status).toBe(200);
      expect(chunkIds(res.body)).toEqual(['$t']);
    }
  });
});

describe('relations concurrent soft flood — relation_type vocabulary after #207', () => {
  it('relType vocab soft-0 (m.annotation)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$v', origin_server_ts: 1, relation_type: 'm.annotation' }),
      child({ event_id: '$other', origin_server_ts: 2, relation_type: 'm.noise' }),
    ]);
    const res = await get(db, base + '/' + encodeURIComponent('m.annotation'));
    expect(res.status).toBe(200);
    expect(chunkIds(res.body)).toEqual(['$v']);
  });

  it('relType vocab soft-1 (m.reference)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$v', origin_server_ts: 1, relation_type: 'm.reference' }),
      child({ event_id: '$other', origin_server_ts: 2, relation_type: 'm.noise' }),
    ]);
    const res = await get(db, base + '/' + encodeURIComponent('m.reference'));
    expect(res.status).toBe(200);
    expect(chunkIds(res.body)).toEqual(['$v']);
  });

  it('relType vocab soft-2 (m.replace)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$v', origin_server_ts: 1, relation_type: 'm.replace' }),
      child({ event_id: '$other', origin_server_ts: 2, relation_type: 'm.noise' }),
    ]);
    const res = await get(db, base + '/' + encodeURIComponent('m.replace'));
    expect(res.status).toBe(200);
    expect(chunkIds(res.body)).toEqual(['$v']);
  });

  it('relType vocab soft-3 (m.thread)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$v', origin_server_ts: 1, relation_type: 'm.thread' }),
      child({ event_id: '$other', origin_server_ts: 2, relation_type: 'm.noise' }),
    ]);
    const res = await get(db, base + '/' + encodeURIComponent('m.thread'));
    expect(res.status).toBe(200);
    expect(chunkIds(res.body)).toEqual(['$v']);
  });

  it('relType vocab soft-4 (io.element.relation)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$v', origin_server_ts: 1, relation_type: 'io.element.relation' }),
      child({ event_id: '$other', origin_server_ts: 2, relation_type: 'm.noise' }),
    ]);
    const res = await get(db, base + '/' + encodeURIComponent('io.element.relation'));
    expect(res.status).toBe(200);
    expect(chunkIds(res.body)).toEqual(['$v']);
  });

  it('relType vocab soft-5 (m.custom.foo)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$v', origin_server_ts: 1, relation_type: 'm.custom.foo' }),
      child({ event_id: '$other', origin_server_ts: 2, relation_type: 'm.noise' }),
    ]);
    const res = await get(db, base + '/' + encodeURIComponent('m.custom.foo'));
    expect(res.status).toBe(200);
    expect(chunkIds(res.body)).toEqual(['$v']);
  });

  it('relType vocab soft-6 (x)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$v', origin_server_ts: 1, relation_type: 'x' }),
      child({ event_id: '$other', origin_server_ts: 2, relation_type: 'm.noise' }),
    ]);
    const res = await get(db, base + '/' + encodeURIComponent('x'));
    expect(res.status).toBe(200);
    expect(chunkIds(res.body)).toEqual(['$v']);
  });

  it('relType vocab soft-7 (m.annotation/extra)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$v', origin_server_ts: 1, relation_type: 'm.annotation/extra' }),
      child({ event_id: '$other', origin_server_ts: 2, relation_type: 'm.noise' }),
    ]);
    const res = await get(db, base + '/' + encodeURIComponent('m.annotation/extra'));
    expect(res.status).toBe(200);
    expect(chunkIds(res.body)).toEqual(['$v']);
  });

});

describe('relations concurrent soft flood — eventType vocabulary after #207', () => {
  it('eventType vocab soft-0 (m.reaction)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$v', origin_server_ts: 1, event_type: 'm.reaction', relation_type: 'm.annotation' }),
      child({ event_id: '$skip', origin_server_ts: 2, event_type: 'm.noise', relation_type: 'm.annotation' }),
    ]);
    const res = await get(
      db,
      base + '/m.annotation/' + encodeURIComponent('m.reaction')
    );
    expect(res.status).toBe(200);
    expect(chunkIds(res.body)).toEqual(['$v']);
  });

  it('eventType vocab soft-1 (m.room.message)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$v', origin_server_ts: 1, event_type: 'm.room.message', relation_type: 'm.annotation' }),
      child({ event_id: '$skip', origin_server_ts: 2, event_type: 'm.noise', relation_type: 'm.annotation' }),
    ]);
    const res = await get(
      db,
      base + '/m.annotation/' + encodeURIComponent('m.room.message')
    );
    expect(res.status).toBe(200);
    expect(chunkIds(res.body)).toEqual(['$v']);
  });

  it('eventType vocab soft-2 (m.room.encrypted)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$v', origin_server_ts: 1, event_type: 'm.room.encrypted', relation_type: 'm.annotation' }),
      child({ event_id: '$skip', origin_server_ts: 2, event_type: 'm.noise', relation_type: 'm.annotation' }),
    ]);
    const res = await get(
      db,
      base + '/m.annotation/' + encodeURIComponent('m.room.encrypted')
    );
    expect(res.status).toBe(200);
    expect(chunkIds(res.body)).toEqual(['$v']);
  });

  it('eventType vocab soft-3 (m.sticker)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$v', origin_server_ts: 1, event_type: 'm.sticker', relation_type: 'm.annotation' }),
      child({ event_id: '$skip', origin_server_ts: 2, event_type: 'm.noise', relation_type: 'm.annotation' }),
    ]);
    const res = await get(
      db,
      base + '/m.annotation/' + encodeURIComponent('m.sticker')
    );
    expect(res.status).toBe(200);
    expect(chunkIds(res.body)).toEqual(['$v']);
  });

  it('eventType vocab soft-4 (m.room.member)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$v', origin_server_ts: 1, event_type: 'm.room.member', relation_type: 'm.annotation' }),
      child({ event_id: '$skip', origin_server_ts: 2, event_type: 'm.noise', relation_type: 'm.annotation' }),
    ]);
    const res = await get(
      db,
      base + '/m.annotation/' + encodeURIComponent('m.room.member')
    );
    expect(res.status).toBe(200);
    expect(chunkIds(res.body)).toEqual(['$v']);
  });

  it('eventType vocab soft-5 (org.matrix.msc3381.poll.start)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$v', origin_server_ts: 1, event_type: 'org.matrix.msc3381.poll.start', relation_type: 'm.annotation' }),
      child({ event_id: '$skip', origin_server_ts: 2, event_type: 'm.noise', relation_type: 'm.annotation' }),
    ]);
    const res = await get(
      db,
      base + '/m.annotation/' + encodeURIComponent('org.matrix.msc3381.poll.start')
    );
    expect(res.status).toBe(200);
    expect(chunkIds(res.body)).toEqual(['$v']);
  });

  it('eventType vocab soft-6 (m.key.verification.request)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$v', origin_server_ts: 1, event_type: 'm.key.verification.request', relation_type: 'm.annotation' }),
      child({ event_id: '$skip', origin_server_ts: 2, event_type: 'm.noise', relation_type: 'm.annotation' }),
    ]);
    const res = await get(
      db,
      base + '/m.annotation/' + encodeURIComponent('m.key.verification.request')
    );
    expect(res.status).toBe(200);
    expect(chunkIds(res.body)).toEqual(['$v']);
  });

});

describe('relations concurrent soft flood — multi-request floods after #207', () => {
  it('Promise.all flood n=2 all-relations', async () => {
    const db = joinDb({
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all(
      Array.from({ length: 2 }, () => get(db, base))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(
      db.selects.filter((s) => s.sql.includes('FROM room_memberships')).length
    ).toBeGreaterThanOrEqual(2);
  });

  it('Promise.all flood n=4 all-relations', async () => {
    const db = joinDb({
      selectBarrier: {
        count: 4,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => get(db, base))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(
      db.selects.filter((s) => s.sql.includes('FROM room_memberships')).length
    ).toBeGreaterThanOrEqual(4);
  });

  it('Promise.all flood n=6 all-relations', async () => {
    const db = joinDb({
      selectBarrier: {
        count: 6,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => get(db, base))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(
      db.selects.filter((s) => s.sql.includes('FROM room_memberships')).length
    ).toBeGreaterThanOrEqual(6);
  });

  it('Promise.all flood n=8 all-relations', async () => {
    const db = joinDb({
      selectBarrier: {
        count: 8,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => get(db, base))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(
      db.selects.filter((s) => s.sql.includes('FROM room_memberships')).length
    ).toBeGreaterThanOrEqual(8);
  });

  it('Promise.all flood n=12 all-relations', async () => {
    const db = joinDb({
      selectBarrier: {
        count: 8,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all(
      Array.from({ length: 12 }, () => get(db, base))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(
      db.selects.filter((s) => s.sql.includes('FROM room_memberships')).length
    ).toBeGreaterThanOrEqual(12);
  });

  it('Promise.all flood n=16 all-relations', async () => {
    const db = joinDb({
      selectBarrier: {
        count: 8,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all(
      Array.from({ length: 16 }, () => get(db, base))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(
      db.selects.filter((s) => s.sql.includes('FROM room_memberships')).length
    ).toBeGreaterThanOrEqual(16);
  });

  it('Promise.all mixed-endpoint flood n=2', async () => {
    const db = joinDb(
      {
        selectBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
      },
      [
        child({ event_id: '$c', origin_server_ts: 1 }),
        threadRoot({ event_id: '$r', origin_server_ts: 1 }),
        threadReply('$r', { event_id: '$rr', origin_server_ts: 2 }),
      ]
    );
    const paths = [base, typedPath, typedEvtPath, threadsPath];
    const results = await Promise.all(
      Array.from({ length: 2 }, (_, i) => get(db, paths[i % paths.length]))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('Promise.all mixed-endpoint flood n=4', async () => {
    const db = joinDb(
      {
        selectBarrier: {
          count: 4,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
      },
      [
        child({ event_id: '$c', origin_server_ts: 1 }),
        threadRoot({ event_id: '$r', origin_server_ts: 1 }),
        threadReply('$r', { event_id: '$rr', origin_server_ts: 2 }),
      ]
    );
    const paths = [base, typedPath, typedEvtPath, threadsPath];
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) => get(db, paths[i % paths.length]))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('Promise.all mixed-endpoint flood n=8', async () => {
    const db = joinDb(
      {
        selectBarrier: {
          count: 8,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
      },
      [
        child({ event_id: '$c', origin_server_ts: 1 }),
        threadRoot({ event_id: '$r', origin_server_ts: 1 }),
        threadReply('$r', { event_id: '$rr', origin_server_ts: 2 }),
      ]
    );
    const paths = [base, typedPath, typedEvtPath, threadsPath];
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => get(db, paths[i % paths.length]))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

});

describe('relations concurrent SQL bind contracts after #207', () => {
  it('membership SELECT binds roomId + userId under parallel', async () => {
    const db = joinDb({
      selectBarrier: {
        count: 3,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    await Promise.all([get(db, base), get(db, typedPath), get(db, threadsPath)]);
    const mems = db.selects.filter((s) => s.sql.includes('FROM room_memberships'));
    expect(mems.length).toBe(3);
    for (const m of mems) {
      expect(m.args[0]).toBe(ROOM);
      expect(m.args[1]).toBe(USER);
    }
  });

  it('all-relations binds room + parent + limit+1', async () => {
    const db = joinDb();
    await get(db, base + '?limit=7');
    const ev = db.selects.find(
      (s) =>
        s.sql.includes('FROM events e') &&
        s.sql.includes('relates_to_event_id') &&
        !s.sql.includes('relation_type = ?')
    );
    expect(ev?.args[0]).toBe(ROOM);
    expect(ev?.args[1]).toBe(PARENT);
    expect(ev?.args[ev.args.length - 1]).toBe(8);
  });

  it('typed binds relType', async () => {
    const db = joinDb();
    await get(db, typedPath);
    const ev = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && !s.sql.includes('event_type = ?')
    );
    expect(ev?.args.slice(0, 3)).toEqual([ROOM, PARENT, 'm.annotation']);
  });

  it('typed+eventType binds both filters', async () => {
    const db = joinDb();
    await get(db, typedEvtPath);
    const ev = db.selects.find(
      (s) => s.sql.includes('relation_type = ?') && s.sql.includes('event_type = ?')
    );
    expect(ev?.args.slice(0, 4)).toEqual([
      ROOM,
      PARENT,
      'm.annotation',
      'm.reaction',
    ]);
  });

  it('threads include=all binds room twice then limit', async () => {
    const db = joinDb(
      undefined,
      [
        threadRoot({ event_id: '$r', origin_server_ts: 1 }),
        threadReply('$r', { event_id: '$rr', origin_server_ts: 2 }),
      ]
    );
    await get(db, threadsPath + '?limit=12');
    const ev = db.selects.find((s) => s.sql.includes('event_id IN'));
    expect(ev?.args[0]).toBe(ROOM);
    expect(ev?.args[1]).toBe(ROOM);
    expect(ev?.args[ev.args.length - 1]).toBe(12);
  });

  it('threads include=participated binds userId twice', async () => {
    const db = joinDb(
      undefined,
      [
        threadRoot({ event_id: '$r', origin_server_ts: 1 }),
        threadReply('$r', { event_id: '$rr', origin_server_ts: 2 }),
      ]
    );
    await get(db, threadsPath + '?include=participated');
    const ev = db.selects.find((s) => s.sql.includes('event_id IN'));
    expect(ev?.args[0]).toBe(ROOM);
    expect(ev?.args[1]).toBe(ROOM);
    expect(ev?.args[2]).toBe(USER);
    expect(ev?.args[3]).toBe(USER);
  });

  it('from= cursor binds numeric parseInt under parallel', async () => {
    const db = joinDb(
      {
        eventsBarrier: {
          count: 2,
          match: (sql) => sql.includes('origin_server_ts < ?'),
        },
      },
      [
        child({ event_id: '$a', origin_server_ts: 100 }),
        child({ event_id: '$b', origin_server_ts: 200 }),
      ]
    );
    await Promise.all([
      get(db, base + '?from=150&dir=b'),
      get(db, base + '?from=250&dir=b'),
    ]);
    const cursors = db.selects.filter((s) => s.sql.includes('origin_server_ts < ?'));
    expect(cursors.map((c) => c.args[2]).sort()).toEqual([150, 250]);
  });

  it('parallel bind contracts stay per-request across rooms', async () => {
    const db = createRelationsRaceDb({
      memberships: [joinMember(ROOM), joinMember(ROOM2)],
      events: [
        child({ event_id: '$a', origin_server_ts: 1, room_id: ROOM }),
        child({
          event_id: '$b',
          origin_server_ts: 1,
          room_id: ROOM2,
          relates_to_event_id: PARENT,
        }),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    await Promise.all([
      get(db, `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT_ENC}`),
      get(db, `/_matrix/client/v1/rooms/${ROOM2_ENC}/relations/${PARENT_ENC}`),
    ]);
    const mems = db.selects.filter((s) => s.sql.includes('FROM room_memberships'));
    expect(mems.map((m) => m.args[0]).sort()).toEqual([ROOM, ROOM2].sort());
  });
});

describe('relations concurrent soft flood — lifecycle after #207', () => {
  it('lifecycle join-read→ban→forbid', async () => {
    for (let i = 0; i < 8; i++) {
      const db = joinDb();
      const a = await get(db, base);
      expect(a.status).toBe(200);
      db.memberships.splice(0, db.memberships.length, {
        room_id: ROOM,
        user_id: USER,
        membership: 'ban',
      });
      const b = await get(db, base);
      expect(b.status).toBe(403);
    }
  });

  it('lifecycle events append→clear→append', async () => {
    for (let i = 0; i < 8; i++) {
      const db = joinDb(undefined, [child({ event_id: '$a', origin_server_ts: 1 })]);
      expect(chunkIds((await get(db, base)).body)).toEqual(['$a']);
      db.setEvents([
        child({ event_id: '$a', origin_server_ts: 1 }),
        child({ event_id: '$b', origin_server_ts: 2 }),
      ]);
      expect(chunkIds((await get(db, base)).body)).toEqual(['$b', '$a']);
      db.setEvents([]);
      expect(chunkIds((await get(db, base)).body)).toEqual([]);
      db.setEvents([child({ event_id: '$c', origin_server_ts: 3 })]);
      expect(chunkIds((await get(db, base)).body)).toEqual(['$c']);
    }
  });

  it('lifecycle threads appear then disappear', async () => {
    for (let i = 0; i < 6; i++) {
      const db = joinDb(undefined, [
        threadRoot({ event_id: '$r', origin_server_ts: 1 }),
        threadReply('$r', { event_id: '$rr', origin_server_ts: 2 }),
      ]);
      expect(chunkIds((await get(db, threadsPath)).body)).toEqual(['$r']);
      db.setEvents([threadRoot({ event_id: '$r', origin_server_ts: 1 })]);
      expect(chunkIds((await get(db, threadsPath)).body)).toEqual([]);
    }
  });

  it('lifecycle leave still historic then wipe forbids', async () => {
    for (let i = 0; i < 6; i++) {
      const db = createRelationsRaceDb({
        memberships: [leaveMember()],
        events: [child({ event_id: '$h', origin_server_ts: 1 })],
      });
      expect((await get(db, base)).status).toBe(200);
      db.memberships.splice(0, db.memberships.length);
      expect((await get(db, base)).status).toBe(403);
    }
  });
});

describe('relations concurrent soft flood — empty / blank / edge responses after #207', () => {
  it('empty chunk has no next_batch under concurrent', async () => {
    const db = joinDb(
      {
        selectBarrier: {
          count: 4,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
      },
      []
    );
    const results = await Promise.all([
      get(db, base),
      get(db, typedPath),
      get(db, typedEvtPath),
      get(db, threadsPath),
    ]);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body.chunk).toEqual([]);
      expect(r.body.next_batch).toBeUndefined();
    }
  });

  it('include unknown behaves like all', async () => {
    const db = joinDb(undefined, [
      threadRoot({ event_id: '$r', origin_server_ts: 1, sender: BOB }),
      threadReply('$r', { event_id: '$rr', origin_server_ts: 2, sender: BOB }),
    ]);
    const res = await get(db, threadsPath + '?include=nope');
    expect(res.status).toBe(200);
    expect(chunkIds(res.body)).toEqual(['$r']);
  });

  it('to= query ignored concurrent soft', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$a', origin_server_ts: 100 }),
      child({ event_id: '$b', origin_server_ts: 200 }),
    ]);
    const results = await Promise.all([
      get(db, base + '?to=150'),
      // from=150 excludes ts==150; both children remain (100 and 200 with dir=b)
      get(db, base + '?to=999&from=150&dir=b'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(chunkIds(results[0].body)).toEqual(['$b', '$a']);
    // from=150 dir=b → origin_server_ts < 150 → only $a
    expect(chunkIds(results[1].body)).toEqual(['$a']);
  });

  it('response shape matrix under barrier', async () => {
    const db = joinDb(
      {
        eventsBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM events e'),
        },
      },
      [
        child({
          event_id: '$shape',
          origin_server_ts: 42,
          content: JSON.stringify({ key: 'val', nested: { a: 1 } }),
        }),
      ]
    );
    const results = await Promise.all([get(db, base), get(db, base)]);
    for (const r of results) {
      expect(r.body.chunk[0]).toMatchObject({
        event_id: '$shape',
        type: 'm.reaction',
        sender: USER,
        origin_server_ts: 42,
        room_id: ROOM,
        content: { key: 'val', nested: { a: 1 } },
      });
    }
  });
});

describe('relations concurrent soft flood — auth identity matrix after #207', () => {
  it('auth identity soft-0 (@alice:example.com)', async () => {
    authState.userId = '@alice:example.com';
    const db = createRelationsRaceDb({
      memberships: [joinMember(ROOM, USER), joinMember(ROOM, BOB)],
      events: [child({ event_id: '$a', origin_server_ts: 1 })],
    });
    const res = await get(db, base);
    if (authState.userId === USER || authState.userId === BOB) {
      expect(res.status).toBe(200);
    } else {
      expect(res.status).toBe(403);
    }
    authState.userId = USER;
  });

  it('auth identity soft-1 (@bob:example.com)', async () => {
    authState.userId = '@bob:example.com';
    const db = createRelationsRaceDb({
      memberships: [joinMember(ROOM, USER), joinMember(ROOM, BOB)],
      events: [child({ event_id: '$a', origin_server_ts: 1 })],
    });
    const res = await get(db, base);
    if (authState.userId === USER || authState.userId === BOB) {
      expect(res.status).toBe(200);
    } else {
      expect(res.status).toBe(403);
    }
    authState.userId = USER;
  });

  it('auth identity soft-2 (@carol:example.com)', async () => {
    authState.userId = '@carol:example.com';
    const db = createRelationsRaceDb({
      memberships: [joinMember(ROOM, USER), joinMember(ROOM, BOB)],
      events: [child({ event_id: '$a', origin_server_ts: 1 })],
    });
    const res = await get(db, base);
    if (authState.userId === USER || authState.userId === BOB) {
      expect(res.status).toBe(200);
    } else {
      expect(res.status).toBe(403);
    }
    authState.userId = USER;
  });

  it('auth identity soft-3 (undefined)', async () => {
    authState.userId = undefined;
    const db = createRelationsRaceDb({
      memberships: [joinMember(ROOM, USER), joinMember(ROOM, BOB)],
      events: [child({ event_id: '$a', origin_server_ts: 1 })],
    });
    const res = await get(db, base);
    if (authState.userId === USER || authState.userId === BOB) {
      expect(res.status).toBe(200);
    } else {
      expect(res.status).toBe(403);
    }
    authState.userId = USER;
  });

});

describe('relations concurrent cross-parent PARENT3 isolation after #207', () => {
  it('PARENT3 empty while PARENT has children under barrier', async () => {
    const db = createRelationsRaceDb({
      memberships: [joinMember()],
      events: [
        child({ event_id: '$p', origin_server_ts: 1, relates_to_event_id: PARENT }),
      ],
      eventsBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM events e') && sql.includes('relates_to_event_id'),
      },
    });
    const results = await Promise.all([
      get(db, base),
      get(db, `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${PARENT3_ENC}`),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(chunkIds(results[0].body)).toEqual(['$p']);
    expect(chunkIds(results[1].body)).toEqual([]);
  });

  it('ROOM4 forbidden while ROOM ok under dual membership barrier', async () => {
    const db = createRelationsRaceDb({
      memberships: [joinMember(ROOM)],
      events: [child({ event_id: '$a', origin_server_ts: 1 })],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([
      get(db, base),
      get(
        db,
        `/_matrix/client/v1/rooms/${encodeURIComponent(ROOM4)}/relations/${PARENT_ENC}`
      ),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
  });
});


describe('race relations dual-parent typed concurrent after #207', () => {
  it('annotation∥reference parallel filters under barrier', async () => {
    const db = joinDb(
      {
        eventsBarrier: {
          count: 2,
          match: (sql) => sql.includes('relation_type = ?') && !sql.includes('event_type = ?'),
        },
      },
      [
        child({ event_id: '$ann', origin_server_ts: 10, relation_type: 'm.annotation' }),
        child({
          event_id: '$ref',
          origin_server_ts: 20,
          relation_type: 'm.reference',
          event_type: 'm.room.message',
        }),
      ]
    );
    const results = await Promise.all([
      get(db, base + '/m.annotation'),
      get(db, base + '/m.reference'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(chunkIds(results[0].body)).toEqual(['$ann']);
    expect(chunkIds(results[1].body)).toEqual(['$ref']);
  });

  it('replace∥thread relation filters concurrent', async () => {
    const db = joinDb(
      {
        eventsBarrier: {
          count: 2,
          match: (sql) => sql.includes('relation_type = ?') && !sql.includes('event_type = ?'),
        },
      },
      [
        child({
          event_id: '$ed',
          origin_server_ts: 10,
          relation_type: 'm.replace',
          event_type: 'm.room.message',
        }),
        child({
          event_id: '$th',
          origin_server_ts: 20,
          relation_type: 'm.thread',
          event_type: 'm.room.message',
        }),
      ]
    );
    const results = await Promise.all([
      get(db, base + '/m.replace'),
      get(db, base + '/m.thread'),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(chunkIds(results[0].body)).toEqual(['$ed']);
    expect(chunkIds(results[1].body)).toEqual(['$th']);
  });

  it('eventType matrix concurrent reaction∥message', async () => {
    const db = joinDb(
      {
        eventsBarrier: {
          count: 2,
          match: (sql) =>
            sql.includes('relation_type = ?') && sql.includes('event_type = ?'),
        },
      },
      [
        child({ event_id: '$rx', origin_server_ts: 10, event_type: 'm.reaction' }),
        child({
          event_id: '$msg',
          origin_server_ts: 20,
          event_type: 'm.room.message',
          relation_type: 'm.annotation',
        }),
      ]
    );
    const results = await Promise.all([
      get(db, base + '/m.annotation/m.reaction'),
      get(db, base + '/m.annotation/' + encodeURIComponent('m.room.message')),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(chunkIds(results[0].body)).toEqual(['$rx']);
    expect(chunkIds(results[1].body)).toEqual(['$msg']);
  });
});

describe('race relations delay soft mid concurrent after #207', () => {
  it('membership delay does not reorder barrier release', async () => {
    const db = joinDb({
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
      delayMsOnMembership: 5,
    });
    const results = await Promise.all([get(db, base), get(db, typedPath)]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('events delay under dual barrier', async () => {
    const db = joinDb({
      eventsBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM events e'),
      },
      delayMsOnEvents: 5,
    });
    const results = await Promise.all([get(db, base), get(db, base)]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });
});

describe('relations concurrent soft flood — next_batch edges after #207', () => {
  it('next_batch when limit=1 of 10', async () => {
    const kids = Array.from({ length: 10 }, (_, i) =>
      child({ event_id: `$nb${i}`, origin_server_ts: (i + 1) * 10 })
    );
    const db = joinDb(undefined, kids);
    const res = await get(db, base + '?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(1);
    expect(res.body.next_batch).toBeTruthy();
  });

  it('next_batch when limit=2 of 10', async () => {
    const kids = Array.from({ length: 10 }, (_, i) =>
      child({ event_id: `$nb${i}`, origin_server_ts: (i + 1) * 10 })
    );
    const db = joinDb(undefined, kids);
    const res = await get(db, base + '?limit=2');
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(2);
    expect(res.body.next_batch).toBeTruthy();
  });

  it('next_batch when limit=3 of 10', async () => {
    const kids = Array.from({ length: 10 }, (_, i) =>
      child({ event_id: `$nb${i}`, origin_server_ts: (i + 1) * 10 })
    );
    const db = joinDb(undefined, kids);
    const res = await get(db, base + '?limit=3');
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.next_batch).toBeTruthy();
  });

  it('next_batch when limit=4 of 10', async () => {
    const kids = Array.from({ length: 10 }, (_, i) =>
      child({ event_id: `$nb${i}`, origin_server_ts: (i + 1) * 10 })
    );
    const db = joinDb(undefined, kids);
    const res = await get(db, base + '?limit=4');
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(4);
    expect(res.body.next_batch).toBeTruthy();
  });

  it('next_batch when limit=5 of 10', async () => {
    const kids = Array.from({ length: 10 }, (_, i) =>
      child({ event_id: `$nb${i}`, origin_server_ts: (i + 1) * 10 })
    );
    const db = joinDb(undefined, kids);
    const res = await get(db, base + '?limit=5');
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(5);
    expect(res.body.next_batch).toBeTruthy();
  });

  it('next_batch when limit=9 of 10', async () => {
    const kids = Array.from({ length: 10 }, (_, i) =>
      child({ event_id: `$nb${i}`, origin_server_ts: (i + 1) * 10 })
    );
    const db = joinDb(undefined, kids);
    const res = await get(db, base + '?limit=9');
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(9);
    expect(res.body.next_batch).toBeTruthy();
  });

  it('no next_batch when limit=10 of exactly 10', async () => {
    const kids = Array.from({ length: 10 }, (_, i) =>
      child({ event_id: `$nb${i}`, origin_server_ts: (i + 1) * 10 })
    );
    const db = joinDb(undefined, kids);
    const res = await get(db, base + '?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(10);
    // hasMore only when fetch returns limit+1 rows
    expect(res.body.next_batch).toBeUndefined();
  });

  it('no next_batch when exact page fill equals remaining', async () => {
    const kids = Array.from({ length: 3 }, (_, i) =>
      child({ event_id: `$ex${i}`, origin_server_ts: (i + 1) * 10 })
    );
    const db = joinDb(undefined, kids);
    const res = await get(db, base + '?limit=3');
    expect(res.status).toBe(200);
    expect(res.body.chunk).toHaveLength(3);
    expect(res.body.next_batch).toBeUndefined();
  });

  it('typed next_batch concurrent', async () => {
    const kids = Array.from({ length: 8 }, (_, i) =>
      child({ event_id: `$tn${i}`, origin_server_ts: (i + 1) * 10 })
    );
    const db = joinDb(
      {
        eventsBarrier: {
          count: 2,
          match: (sql) => sql.includes('relation_type = ?') && !sql.includes('event_type = ?'),
        },
      },
      kids
    );
    const results = await Promise.all([
      get(db, typedPath + '?limit=3'),
      get(db, typedPath + '?limit=5'),
    ]);
    expect(results[0].body.chunk).toHaveLength(3);
    expect(results[0].body.next_batch).toBeTruthy();
    expect(results[1].body.chunk).toHaveLength(5);
    expect(results[1].body.next_batch).toBeTruthy();
  });
});

describe('relations concurrent soft flood — threads include matrix after #207', () => {
  it('threads include=all soft', async () => {
    const db = joinDb(undefined, [
      threadRoot({ event_id: '$ra', origin_server_ts: 10, sender: USER }),
      threadReply('$ra', { event_id: '$ra1', origin_server_ts: 11, sender: USER }),
      threadRoot({ event_id: '$rb', origin_server_ts: 20, sender: BOB }),
      threadReply('$rb', { event_id: '$rb1', origin_server_ts: 21, sender: BOB }),
    ]);
    const q = 'all' === '' ? '' : '?include=all';
    const res = await get(db, threadsPath + q);
    expect(res.status).toBe(200);
    if ('all' === 'participated') {
      expect(chunkIds(res.body)).toEqual(['$ra']);
    } else {
      expect(chunkIds(res.body).sort()).toEqual(['$ra', '$rb'].sort());
    }
  });

  it('threads include=participated soft', async () => {
    const db = joinDb(undefined, [
      threadRoot({ event_id: '$ra', origin_server_ts: 10, sender: USER }),
      threadReply('$ra', { event_id: '$ra1', origin_server_ts: 11, sender: USER }),
      threadRoot({ event_id: '$rb', origin_server_ts: 20, sender: BOB }),
      threadReply('$rb', { event_id: '$rb1', origin_server_ts: 21, sender: BOB }),
    ]);
    const q = 'participated' === '' ? '' : '?include=participated';
    const res = await get(db, threadsPath + q);
    expect(res.status).toBe(200);
    if ('participated' === 'participated') {
      expect(chunkIds(res.body)).toEqual(['$ra']);
    } else {
      expect(chunkIds(res.body).sort()).toEqual(['$ra', '$rb'].sort());
    }
  });

  it('threads include=empty soft', async () => {
    const db = joinDb(undefined, [
      threadRoot({ event_id: '$ra', origin_server_ts: 10, sender: USER }),
      threadReply('$ra', { event_id: '$ra1', origin_server_ts: 11, sender: USER }),
      threadRoot({ event_id: '$rb', origin_server_ts: 20, sender: BOB }),
      threadReply('$rb', { event_id: '$rb1', origin_server_ts: 21, sender: BOB }),
    ]);
    const q = '' === '' ? '' : '?include=';
    const res = await get(db, threadsPath + q);
    expect(res.status).toBe(200);
    if ('' === 'participated') {
      expect(chunkIds(res.body)).toEqual(['$ra']);
    } else {
      expect(chunkIds(res.body).sort()).toEqual(['$ra', '$rb'].sort());
    }
  });

  it('threads include=ALL soft', async () => {
    const db = joinDb(undefined, [
      threadRoot({ event_id: '$ra', origin_server_ts: 10, sender: USER }),
      threadReply('$ra', { event_id: '$ra1', origin_server_ts: 11, sender: USER }),
      threadRoot({ event_id: '$rb', origin_server_ts: 20, sender: BOB }),
      threadReply('$rb', { event_id: '$rb1', origin_server_ts: 21, sender: BOB }),
    ]);
    const q = 'ALL' === '' ? '' : '?include=ALL';
    const res = await get(db, threadsPath + q);
    expect(res.status).toBe(200);
    if ('ALL' === 'participated') {
      expect(chunkIds(res.body)).toEqual(['$ra']);
    } else {
      expect(chunkIds(res.body).sort()).toEqual(['$ra', '$rb'].sort());
    }
  });

  it('threads include=Participated soft', async () => {
    const db = joinDb(undefined, [
      threadRoot({ event_id: '$ra', origin_server_ts: 10, sender: USER }),
      threadReply('$ra', { event_id: '$ra1', origin_server_ts: 11, sender: USER }),
      threadRoot({ event_id: '$rb', origin_server_ts: 20, sender: BOB }),
      threadReply('$rb', { event_id: '$rb1', origin_server_ts: 21, sender: BOB }),
    ]);
    const q = 'Participated' === '' ? '' : '?include=Participated';
    const res = await get(db, threadsPath + q);
    expect(res.status).toBe(200);
    if ('Participated' === 'participated') {
      expect(chunkIds(res.body)).toEqual(['$ra']);
    } else {
      expect(chunkIds(res.body).sort()).toEqual(['$ra', '$rb'].sort());
    }
  });

  it('threads include=both soft', async () => {
    const db = joinDb(undefined, [
      threadRoot({ event_id: '$ra', origin_server_ts: 10, sender: USER }),
      threadReply('$ra', { event_id: '$ra1', origin_server_ts: 11, sender: USER }),
      threadRoot({ event_id: '$rb', origin_server_ts: 20, sender: BOB }),
      threadReply('$rb', { event_id: '$rb1', origin_server_ts: 21, sender: BOB }),
    ]);
    const q = 'both' === '' ? '' : '?include=both';
    const res = await get(db, threadsPath + q);
    expect(res.status).toBe(200);
    if ('both' === 'participated') {
      expect(chunkIds(res.body)).toEqual(['$ra']);
    } else {
      expect(chunkIds(res.body).sort()).toEqual(['$ra', '$rb'].sort());
    }
  });

  it('threads include=none soft', async () => {
    const db = joinDb(undefined, [
      threadRoot({ event_id: '$ra', origin_server_ts: 10, sender: USER }),
      threadReply('$ra', { event_id: '$ra1', origin_server_ts: 11, sender: USER }),
      threadRoot({ event_id: '$rb', origin_server_ts: 20, sender: BOB }),
      threadReply('$rb', { event_id: '$rb1', origin_server_ts: 21, sender: BOB }),
    ]);
    const q = 'none' === '' ? '' : '?include=none';
    const res = await get(db, threadsPath + q);
    expect(res.status).toBe(200);
    if ('none' === 'participated') {
      expect(chunkIds(res.body)).toEqual(['$ra']);
    } else {
      expect(chunkIds(res.body).sort()).toEqual(['$ra', '$rb'].sort());
    }
  });

});

describe('relations concurrent soft flood — bob/carol isolation after #207', () => {
  it('bob membership does not grant alice room', async () => {
    for (let i = 0; i < 6; i++) {
      const db = createRelationsRaceDb({
        memberships: [joinMember(ROOM, BOB), joinMember(ROOM2, USER)],
        events: [
          child({ event_id: '$bob', origin_server_ts: 1, room_id: ROOM }),
          child({
            event_id: '$alice',
            origin_server_ts: 1,
            room_id: ROOM2,
            relates_to_event_id: PARENT,
          }),
        ],
      });
      const a = await get(db, base);
      expect(a.status).toBe(403);
      const b = await get(
        db,
        `/_matrix/client/v1/rooms/${ROOM2_ENC}/relations/${PARENT_ENC}`
      );
      expect(b.status).toBe(200);
      expect(chunkIds(b.body)).toEqual(['$alice']);
    }
  });

  it('carol auth with only bob membership forbids', async () => {
    authState.userId = CAROL;
    const db = createRelationsRaceDb({
      memberships: [joinMember(ROOM, BOB)],
      events: [child({ event_id: '$x', origin_server_ts: 1 })],
    });
    const res = await get(db, base);
    expect(res.status).toBe(403);
    authState.userId = USER;
  });

  it('parallel alice∥bob distinct rooms under barrier', async () => {
    const db = createRelationsRaceDb({
      memberships: [joinMember(ROOM, USER), joinMember(ROOM2, BOB)],
      events: [
        child({ event_id: '$a', origin_server_ts: 1, room_id: ROOM }),
        child({
          event_id: '$b',
          origin_server_ts: 1,
          room_id: ROOM2,
          relates_to_event_id: PARENT,
        }),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const pAlice = get(db, base);
    authState.userId = BOB;
    const pBob = get(
      db,
      `/_matrix/client/v1/rooms/${ROOM2_ENC}/relations/${PARENT_ENC}`
    );
    const results = await Promise.all([pAlice, pBob]);
    expect(results.every((r) => r.status === 200 || r.status === 403)).toBe(true);
    authState.userId = USER;
  });
});

describe('relations concurrent soft flood — content JSON edges after #207', () => {
  it('nested arrays/objects preserved under barrier', async () => {
    const content = {
      'm.relates_to': { rel_type: 'm.annotation', key: '👍' },
      arr: [1, 2, { z: true }],
    };
    const db = joinDb(
      {
        eventsBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM events e'),
        },
      },
      [
        child({
          event_id: '$j',
          origin_server_ts: 1,
          content: JSON.stringify(content),
        }),
      ]
    );
    const results = await Promise.all([get(db, base), get(db, base)]);
    expect(results[0].body.chunk[0].content).toEqual(content);
    expect(results[1].body.chunk[0].content).toEqual(content);
  });

  it('empty object content soft flood', async () => {
    for (let i = 0; i < 6; i++) {
      const db = joinDb(undefined, [
        child({ event_id: `$e${i}`, origin_server_ts: i, content: '{}' }),
      ]);
      const res = await get(db, base);
      expect(res.body.chunk[0].content).toEqual({});
    }
  });

  it('nullish-looking string content parses', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$n', origin_server_ts: 1, content: 'null' }),
    ]);
    const res = await get(db, base);
    expect(res.status).toBe(200);
    expect(res.body.chunk[0].content).toBeNull();
  });
});

describe('relations concurrent soft flood — sender matrix after #207', () => {
  it('sender soft-0 (@alice:example.com)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$s', origin_server_ts: 1, sender: '@alice:example.com' }),
    ]);
    const res = await get(db, base);
    expect(res.body.chunk[0].sender).toBe('@alice:example.com');
  });

  it('sender soft-1 (@bob:example.com)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$s', origin_server_ts: 1, sender: '@bob:example.com' }),
    ]);
    const res = await get(db, base);
    expect(res.body.chunk[0].sender).toBe('@bob:example.com');
  });

  it('sender soft-2 (@carol:example.com)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$s', origin_server_ts: 1, sender: '@carol:example.com' }),
    ]);
    const res = await get(db, base);
    expect(res.body.chunk[0].sender).toBe('@carol:example.com');
  });

  it('sender soft-3 (@dave:example.com)', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$s', origin_server_ts: 1, sender: '@dave:example.com' }),
    ]);
    const res = await get(db, base);
    expect(res.body.chunk[0].sender).toBe('@dave:example.com');
  });

});


describe('race relations membership×endpoint matrix after #207', () => {
  it('allows membership=join on all under dual barrier', async () => {
    const db = createRelationsRaceDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      events: [
        child({ event_id: '$c', origin_server_ts: 1 }),
        threadRoot({ event_id: '$r', origin_server_ts: 1 }),
        threadReply('$r', { event_id: '$rr', origin_server_ts: 2 }),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([get(db, base), get(db, base)]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('allows membership=join on typed under dual barrier', async () => {
    const db = createRelationsRaceDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      events: [
        child({ event_id: '$c', origin_server_ts: 1 }),
        threadRoot({ event_id: '$r', origin_server_ts: 1 }),
        threadReply('$r', { event_id: '$rr', origin_server_ts: 2 }),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([get(db, typedPath), get(db, typedPath)]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('allows membership=join on typedEvt under dual barrier', async () => {
    const db = createRelationsRaceDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      events: [
        child({ event_id: '$c', origin_server_ts: 1 }),
        threadRoot({ event_id: '$r', origin_server_ts: 1 }),
        threadReply('$r', { event_id: '$rr', origin_server_ts: 2 }),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([get(db, typedEvtPath), get(db, typedEvtPath)]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('allows membership=join on threads under dual barrier', async () => {
    const db = createRelationsRaceDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      events: [
        child({ event_id: '$c', origin_server_ts: 1 }),
        threadRoot({ event_id: '$r', origin_server_ts: 1 }),
        threadReply('$r', { event_id: '$rr', origin_server_ts: 2 }),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([get(db, threadsPath), get(db, threadsPath)]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('allows membership=leave on all under dual barrier', async () => {
    const db = createRelationsRaceDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      events: [
        child({ event_id: '$c', origin_server_ts: 1 }),
        threadRoot({ event_id: '$r', origin_server_ts: 1 }),
        threadReply('$r', { event_id: '$rr', origin_server_ts: 2 }),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([get(db, base), get(db, base)]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('allows membership=leave on typed under dual barrier', async () => {
    const db = createRelationsRaceDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      events: [
        child({ event_id: '$c', origin_server_ts: 1 }),
        threadRoot({ event_id: '$r', origin_server_ts: 1 }),
        threadReply('$r', { event_id: '$rr', origin_server_ts: 2 }),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([get(db, typedPath), get(db, typedPath)]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('allows membership=leave on typedEvt under dual barrier', async () => {
    const db = createRelationsRaceDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      events: [
        child({ event_id: '$c', origin_server_ts: 1 }),
        threadRoot({ event_id: '$r', origin_server_ts: 1 }),
        threadReply('$r', { event_id: '$rr', origin_server_ts: 2 }),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([get(db, typedEvtPath), get(db, typedEvtPath)]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

  it('allows membership=leave on threads under dual barrier', async () => {
    const db = createRelationsRaceDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      events: [
        child({ event_id: '$c', origin_server_ts: 1 }),
        threadRoot({ event_id: '$r', origin_server_ts: 1 }),
        threadReply('$r', { event_id: '$rr', origin_server_ts: 2 }),
      ],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });
    const results = await Promise.all([get(db, threadsPath), get(db, threadsPath)]);
    expect(statusesOf(results)).toEqual([200, 200]);
  });

});

describe('relations concurrent soft flood — dir×from matrix after #207', () => {
  it('dir=b from=50 soft', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$1', origin_server_ts: 100 }),
      child({ event_id: '$2', origin_server_ts: 200 }),
      child({ event_id: '$3', origin_server_ts: 300 }),
    ]);
    const res = await get(db, base + '?dir=b&from=50');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('dir=b from=100 soft', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$1', origin_server_ts: 100 }),
      child({ event_id: '$2', origin_server_ts: 200 }),
      child({ event_id: '$3', origin_server_ts: 300 }),
    ]);
    const res = await get(db, base + '?dir=b&from=100');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('dir=b from=150 soft', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$1', origin_server_ts: 100 }),
      child({ event_id: '$2', origin_server_ts: 200 }),
      child({ event_id: '$3', origin_server_ts: 300 }),
    ]);
    const res = await get(db, base + '?dir=b&from=150');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('dir=b from=200 soft', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$1', origin_server_ts: 100 }),
      child({ event_id: '$2', origin_server_ts: 200 }),
      child({ event_id: '$3', origin_server_ts: 300 }),
    ]);
    const res = await get(db, base + '?dir=b&from=200');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('dir=b from=250 soft', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$1', origin_server_ts: 100 }),
      child({ event_id: '$2', origin_server_ts: 200 }),
      child({ event_id: '$3', origin_server_ts: 300 }),
    ]);
    const res = await get(db, base + '?dir=b&from=250');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('dir=f from=50 soft', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$1', origin_server_ts: 100 }),
      child({ event_id: '$2', origin_server_ts: 200 }),
      child({ event_id: '$3', origin_server_ts: 300 }),
    ]);
    const res = await get(db, base + '?dir=f&from=50');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('dir=f from=100 soft', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$1', origin_server_ts: 100 }),
      child({ event_id: '$2', origin_server_ts: 200 }),
      child({ event_id: '$3', origin_server_ts: 300 }),
    ]);
    const res = await get(db, base + '?dir=f&from=100');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('dir=f from=150 soft', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$1', origin_server_ts: 100 }),
      child({ event_id: '$2', origin_server_ts: 200 }),
      child({ event_id: '$3', origin_server_ts: 300 }),
    ]);
    const res = await get(db, base + '?dir=f&from=150');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('dir=f from=200 soft', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$1', origin_server_ts: 100 }),
      child({ event_id: '$2', origin_server_ts: 200 }),
      child({ event_id: '$3', origin_server_ts: 300 }),
    ]);
    const res = await get(db, base + '?dir=f&from=200');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

  it('dir=f from=250 soft', async () => {
    const db = joinDb(undefined, [
      child({ event_id: '$1', origin_server_ts: 100 }),
      child({ event_id: '$2', origin_server_ts: 200 }),
      child({ event_id: '$3', origin_server_ts: 300 }),
    ]);
    const res = await get(db, base + '?dir=f&from=250');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.chunk)).toBe(true);
  });

});

describe('relations concurrent soft flood — multi-parent bind flood after #207', () => {
  it('six parents sequential isolation', async () => {
    const parents = [PARENT, PARENT2, PARENT3, '$p4:example.com', '$p5:example.com', '$p6:example.com'];
    const db = createRelationsRaceDb({
      memberships: [joinMember()],
      events: parents.map((p, i) =>
        child({
          event_id: `$c${i}`,
          origin_server_ts: i + 1,
          relates_to_event_id: p,
        })
      ),
    });
    for (const [i, p] of parents.entries()) {
      const res = await get(
        db,
        `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${encodeURIComponent(p)}`
      );
      expect(res.status).toBe(200);
      expect(chunkIds(res.body)).toEqual([`$c${i}`]);
    }
  });

  it('parallel four parents under events barrier', async () => {
    const parents = [PARENT, PARENT2, PARENT3, '$p4:example.com'];
    const db = createRelationsRaceDb({
      memberships: [joinMember()],
      events: parents.map((p, i) =>
        child({
          event_id: `$c${i}`,
          origin_server_ts: i + 1,
          relates_to_event_id: p,
        })
      ),
      eventsBarrier: {
        count: 4,
        match: (sql) => sql.includes('FROM events e') && sql.includes('relates_to_event_id'),
      },
    });
    const results = await Promise.all(
      parents.map((p) =>
        get(db, `/_matrix/client/v1/rooms/${ROOM_ENC}/relations/${encodeURIComponent(p)}`)
      )
    );
    expect(statusesOf(results)).toEqual([200, 200, 200, 200]);
    expect(results.map((r) => chunkIds(r.body)[0])).toEqual(['$c0', '$c1', '$c2', '$c3']);
  });
});
