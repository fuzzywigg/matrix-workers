/**
 * TOKENMAXX HEAVY deepen after #93 (key-backups) — different slice: search API helpers + /search route.
 * Avoids oauth (#90), spaces (#89), key-backups (#93), versions/well-known (#87), server-notice (#85).
 * Tests only (+ export-only src changes for testability). No product inventing.
 */
import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', AUTH_USER);
      c.set('deviceId', 'DEVICE1');
      await next();
    };
  },
}));

import search, {
  SEARCH_PAGE_SIZE,
  DEFAULT_CONTEXT_BEFORE,
  DEFAULT_CONTEXT_AFTER,
  emptyRoomEventsResponse,
  isBlankSearchTerm,
  escapeFtsSearchTerm,
  parseSearchOffset,
  applyRoomFilters,
  buildOrderByClause,
  appendInFilter,
  appendSenderTypeFilters,
  parseEventContent,
  parseContextEventContent,
  absoluteRank,
  buildSearchResultFromRow,
  formatContextEvent,
  resolveContextLimits,
  collectContextSenders,
  mapUserProfile,
  nextBatchToken,
  paginateSearchRows,
  buildSearchGroupings,
  uniqueResultRoomIds,
  formatStateEvent,
  buildFtsSelectSkeleton,
  buildFtsCountSkeleton,
  extractHighlights,
  type SearchEventRow,
  type SearchResult,
  type SearchFilter,
} from '../src/api/search';
import type { Env } from '../src/types';

const AUTH_USER = '@alice:example.com';
const OTHER_USER = '@bob:example.com';
const ROOM_A = '!roomA:example.com';
const ROOM_B = '!roomB:example.com';
const ROOM_C = '!roomC:example.com';

// ---------------------------------------------------------------------------
// In-memory D1 for search memberships / events / FTS / state / users
// ---------------------------------------------------------------------------

type MembershipRow = { room_id: string; user_id: string; membership: string };
type EventRow = {
  event_id: string;
  event_type: string;
  room_id: string;
  sender: string;
  origin_server_ts: number;
  content: string;
  state_key?: string | null;
};
type FtsRow = { event_id: string; body: string; rank: number };
type StateRow = { room_id: string; event_id: string };
type UserRow = { user_id: string; display_name: string | null; avatar_url: string | null };

type SearchStore = {
  memberships: MembershipRow[];
  events: EventRow[];
  fts: FtsRow[];
  state: StateRow[];
  users: UserRow[];
  sqlLog: string[];
  bindLog: unknown[][];
};

function ftsMatch(body: string, term: string): boolean {
  const needles = term.toLowerCase().split(/\s+/).filter(Boolean);
  if (needles.length === 0) return false;
  const hay = body.toLowerCase();
  return needles.every((n) => hay.includes(n));
}

function createSearchDb(seed?: Partial<SearchStore>): D1Database & { store: SearchStore } {
  const store: SearchStore = {
    memberships: seed?.memberships ? [...seed.memberships] : [],
    events: seed?.events ? [...seed.events] : [],
    fts: seed?.fts ? [...seed.fts] : [],
    state: seed?.state ? [...seed.state] : [],
    users: seed?.users ? [...seed.users] : [],
    sqlLog: [],
    bindLog: [],
  };

  return {
    store,
    prepare(sql: string) {
      store.sqlLog.push(sql);
      return {
        bind(...args: unknown[]) {
          store.bindLog.push(args);
          return {
            async first<T>() {
              if (sql.includes('SELECT COUNT(*) as total') && sql.includes('events_fts')) {
                const [term, ...roomIds] = args as [string, ...string[]];
                const total = store.fts.filter((f) => {
                  if (!ftsMatch(f.body, term)) return false;
                  const ev = store.events.find((e) => e.event_id === f.event_id);
                  return !!ev && roomIds.includes(ev.room_id);
                }).length;
                return { total } as T;
              }
              if (sql.includes('FROM users') && sql.includes('user_id = ?')) {
                const [userId] = args as [string];
                const u = store.users.find((x) => x.user_id === userId);
                return (u
                  ? { display_name: u.display_name, avatar_url: u.avatar_url }
                  : null) as T;
              }
              return null as T;
            },
            async all<T>() {
              // Memberships
              if (sql.includes('FROM room_memberships') && sql.includes("membership IN ('join', 'leave')")) {
                const [userId] = args as [string];
                const results = store.memberships
                  .filter((m) => m.user_id === userId && (m.membership === 'join' || m.membership === 'leave'))
                  .map((m) => ({ room_id: m.room_id }));
                return { results: results as T[], success: true, meta: { duration: 0, changes: 0, last_row_id: 0, size_after: 0, served_by: 'mock' } };
              }

              // FTS search select
              if (sql.includes('FROM events_fts') && sql.includes('bm25') && sql.includes('JOIN events')) {
                const term = args[0] as string;
                // Collect room ids from IN (?) placeholders — they sit between term and optional filters / limit
                // Reconstruct by parsing: after MATCH ?, room ids fill the IN list, then optional sender/type, then limit+1, offset
                const roomInMatch = sql.match(/e\.room_id IN \(([?, ]+)\)/);
                const roomCount = roomInMatch ? roomInMatch[1].split(',').length : 0;
                let idx = 1;
                const roomIds = args.slice(idx, idx + roomCount) as string[];
                idx += roomCount;

                let senders: string[] | null = null;
                let notSenders: string[] | null = null;
                let types: string[] | null = null;
                let notTypes: string[] | null = null;

                if (sql.includes('e.sender IN (')) {
                  const m = sql.match(/e\.sender IN \(([?, ]+)\)/);
                  const n = m ? m[1].split(',').length : 0;
                  senders = args.slice(idx, idx + n) as string[];
                  idx += n;
                }
                if (sql.includes('e.sender NOT IN (')) {
                  const m = sql.match(/e\.sender NOT IN \(([?, ]+)\)/);
                  const n = m ? m[1].split(',').length : 0;
                  notSenders = args.slice(idx, idx + n) as string[];
                  idx += n;
                }
                if (sql.includes('e.event_type IN (')) {
                  const m = sql.match(/e\.event_type IN \(([?, ]+)\)/);
                  const n = m ? m[1].split(',').length : 0;
                  types = args.slice(idx, idx + n) as string[];
                  idx += n;
                }
                if (sql.includes('e.event_type NOT IN (')) {
                  const m = sql.match(/e\.event_type NOT IN \(([?, ]+)\)/);
                  const n = m ? m[1].split(',').length : 0;
                  notTypes = args.slice(idx, idx + n) as string[];
                  idx += n;
                }

                const limit = args[idx] as number;
                const offset = args[idx + 1] as number;

                let rows = store.fts
                  .map((f) => {
                    const e = store.events.find((ev) => ev.event_id === f.event_id);
                    if (!e) return null;
                    if (!ftsMatch(f.body, term)) return null;
                    if (!roomIds.includes(e.room_id)) return null;
                    if (senders && !senders.includes(e.sender)) return null;
                    if (notSenders && notSenders.includes(e.sender)) return null;
                    if (types && !types.includes(e.event_type)) return null;
                    if (notTypes && notTypes.includes(e.event_type)) return null;
                    return {
                      event_id: e.event_id,
                      event_type: e.event_type,
                      room_id: e.room_id,
                      sender: e.sender,
                      origin_server_ts: e.origin_server_ts,
                      content: e.content,
                      rank: f.rank,
                    };
                  })
                  .filter(Boolean) as SearchEventRow[];

                if (sql.includes('ORDER BY rank ASC')) {
                  rows = rows.sort((a, b) => a.rank - b.rank);
                } else {
                  rows = rows.sort((a, b) => b.origin_server_ts - a.origin_server_ts);
                }

                const sliced = rows.slice(offset, offset + limit);
                return { results: sliced as T[], success: true, meta: { duration: 0, changes: 0, last_row_id: 0, size_after: 0, served_by: 'mock' } };
              }

              // Context before
              if (
                sql.includes('FROM events') &&
                sql.includes('origin_server_ts < ?') &&
                sql.includes('ORDER BY origin_server_ts DESC')
              ) {
                const [roomId, ts, lim] = args as [string, number, number];
                const results = store.events
                  .filter((e) => e.room_id === roomId && e.origin_server_ts < ts)
                  .sort((a, b) => b.origin_server_ts - a.origin_server_ts)
                  .slice(0, lim)
                  .map((e) => ({
                    event_id: e.event_id,
                    event_type: e.event_type,
                    sender: e.sender,
                    origin_server_ts: e.origin_server_ts,
                    content: e.content,
                  }));
                return { results: results as T[], success: true, meta: { duration: 0, changes: 0, last_row_id: 0, size_after: 0, served_by: 'mock' } };
              }

              // Context after
              if (
                sql.includes('FROM events') &&
                sql.includes('origin_server_ts > ?') &&
                sql.includes('ORDER BY origin_server_ts ASC')
              ) {
                const [roomId, ts, lim] = args as [string, number, number];
                const results = store.events
                  .filter((e) => e.room_id === roomId && e.origin_server_ts > ts)
                  .sort((a, b) => a.origin_server_ts - b.origin_server_ts)
                  .slice(0, lim)
                  .map((e) => ({
                    event_id: e.event_id,
                    event_type: e.event_type,
                    sender: e.sender,
                    origin_server_ts: e.origin_server_ts,
                    content: e.content,
                  }));
                return { results: results as T[], success: true, meta: { duration: 0, changes: 0, last_row_id: 0, size_after: 0, served_by: 'mock' } };
              }

              // Room state
              if (sql.includes('FROM room_state') && sql.includes('JOIN events')) {
                const [roomId] = args as [string];
                const results = store.state
                  .filter((s) => s.room_id === roomId)
                  .map((s) => {
                    const e = store.events.find((ev) => ev.event_id === s.event_id)!;
                    return {
                      event_type: e.event_type,
                      state_key: e.state_key ?? '',
                      sender: e.sender,
                      content: e.content,
                      origin_server_ts: e.origin_server_ts,
                    };
                  });
                return { results: results as T[], success: true, meta: { duration: 0, changes: 0, last_row_id: 0, size_after: 0, served_by: 'mock' } };
              }

              return { results: [] as T[], success: true, meta: { duration: 0, changes: 0, last_row_id: 0, size_after: 0, served_by: 'mock' } };
            },
            async run() {
              return {
                success: true,
                meta: { changes: 0, last_row_id: 0, duration: 0, size_after: 0 },
                results: [],
              };
            },
          };
        },
      };
    },
  } as unknown as D1Database & { store: SearchStore };
}

function env(db: D1Database, partial: Partial<Env> = {}): Env {
  return {
    SERVER_NAME: 'example.com',
    DB: db,
    ...partial,
  } as Env;
}

async function request(path: string, db: D1Database, body?: unknown) {
  const init: RequestInit = { method: 'POST' };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await search.request(`http://localhost${path}`, init, env(db));
  let json: any = null;
  const text = await res.text();
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, res };
}

function roomEventsBody(partial: Record<string, unknown> = {}) {
  return {
    search_categories: {
      room_events: {
        search_term: 'hello',
        ...partial,
      },
    },
  };
}

function makeEvent(
  partial: Partial<EventRow> & Pick<EventRow, 'event_id' | 'room_id' | 'origin_server_ts'>
): EventRow {
  return {
    event_type: 'm.room.message',
    sender: AUTH_USER,
    content: JSON.stringify({ body: 'hello world', msgtype: 'm.text' }),
    state_key: null,
    ...partial,
  };
}

function seedBasic(): D1Database & { store: SearchStore } {
  const events = [
    makeEvent({ event_id: '$e1', room_id: ROOM_A, origin_server_ts: 1000, content: JSON.stringify({ body: 'hello alice', msgtype: 'm.text' }) }),
    makeEvent({ event_id: '$e2', room_id: ROOM_A, origin_server_ts: 2000, sender: OTHER_USER, content: JSON.stringify({ body: 'hello bob', msgtype: 'm.text' }) }),
    makeEvent({ event_id: '$e3', room_id: ROOM_B, origin_server_ts: 3000, content: JSON.stringify({ body: 'hello room b', msgtype: 'm.text' }) }),
    makeEvent({ event_id: '$e4', room_id: ROOM_A, origin_server_ts: 1500, event_type: 'm.room.member', content: JSON.stringify({ membership: 'join' }), state_key: AUTH_USER }),
    makeEvent({ event_id: '$e5', room_id: ROOM_C, origin_server_ts: 4000, content: JSON.stringify({ body: 'secret', msgtype: 'm.text' }) }),
  ];
  return createSearchDb({
    memberships: [
      { room_id: ROOM_A, user_id: AUTH_USER, membership: 'join' },
      { room_id: ROOM_B, user_id: AUTH_USER, membership: 'leave' },
      { room_id: ROOM_C, user_id: OTHER_USER, membership: 'join' },
    ],
    events,
    fts: [
      { event_id: '$e1', body: 'hello alice', rank: -1.5 },
      { event_id: '$e2', body: 'hello bob', rank: -0.5 },
      { event_id: '$e3', body: 'hello room b', rank: -2.0 },
      { event_id: '$e5', body: 'secret', rank: -3.0 },
    ],
    state: [{ room_id: ROOM_A, event_id: '$e4' }],
    users: [
      { user_id: AUTH_USER, display_name: 'Alice', avatar_url: 'mxc://example.com/a' },
      { user_id: OTHER_USER, display_name: null, avatar_url: null },
    ],
  });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('SEARCH_PAGE_SIZE / context defaults', () => {
  it('uses page size 50', () => {
    expect(SEARCH_PAGE_SIZE).toBe(50);
  });

  it('defaults context before/after to 5', () => {
    expect(DEFAULT_CONTEXT_BEFORE).toBe(5);
    expect(DEFAULT_CONTEXT_AFTER).toBe(5);
  });
});

describe('emptyRoomEventsResponse', () => {
  it('returns empty results/count/highlights under room_events', () => {
    expect(emptyRoomEventsResponse()).toEqual({
      search_categories: {
        room_events: { results: [], count: 0, highlights: [] },
      },
    });
  });

  it('returns a fresh object each call', () => {
    const a = emptyRoomEventsResponse();
    const b = emptyRoomEventsResponse();
    expect(a).not.toBe(b);
    expect(a.search_categories).not.toBe(b.search_categories);
  });
});

describe('isBlankSearchTerm', () => {
  it('treats null/undefined/empty as blank', () => {
    expect(isBlankSearchTerm(null)).toBe(true);
    expect(isBlankSearchTerm(undefined)).toBe(true);
    expect(isBlankSearchTerm('')).toBe(true);
  });

  it('treats whitespace-only as blank', () => {
    expect(isBlankSearchTerm('   ')).toBe(true);
    expect(isBlankSearchTerm('\t\n')).toBe(true);
  });

  it('accepts non-blank terms including leading/trailing spaces', () => {
    expect(isBlankSearchTerm('a')).toBe(false);
    expect(isBlankSearchTerm(' hello ')).toBe(false);
  });
});

describe('escapeFtsSearchTerm', () => {
  it('replaces FTS5 specials with spaces and trims', () => {
    expect(escapeFtsSearchTerm(`hello"world`)).toBe('hello world');
    expect(escapeFtsSearchTerm("a'b*c(d)e")).toBe('a b c d e');
  });

  it('collapses only specials — preserves other punctuation', () => {
    expect(escapeFtsSearchTerm('hello-world!')).toBe('hello-world!');
  });

  it('trims outer whitespace after replacement', () => {
    expect(escapeFtsSearchTerm('  *hello*  ')).toBe('hello');
  });

  it('returns empty string when only specials remain', () => {
    expect(escapeFtsSearchTerm('***')).toBe('');
    expect(escapeFtsSearchTerm('""()')).toBe('');
  });

  it('leaves plain multi-word terms unchanged aside from trim', () => {
    expect(escapeFtsSearchTerm('  foo bar  ')).toBe('foo bar');
  });
});

describe('parseSearchOffset', () => {
  it('defaults null/undefined/empty to 0', () => {
    expect(parseSearchOffset(null)).toBe(0);
    expect(parseSearchOffset(undefined)).toBe(0);
    expect(parseSearchOffset('')).toBe(0);
  });

  it('parses integer strings', () => {
    expect(parseSearchOffset('0')).toBe(0);
    expect(parseSearchOffset('50')).toBe(50);
    expect(parseSearchOffset('100')).toBe(100);
  });

  it('parses float prefixes via parseInt', () => {
    expect(parseSearchOffset('12.9')).toBe(12);
  });

  it('returns NaN for non-numeric truthy values (prior behavior)', () => {
    expect(Number.isNaN(parseSearchOffset('abc'))).toBe(true);
  });
});

describe('applyRoomFilters', () => {
  const rooms = [ROOM_A, ROOM_B, ROOM_C];

  it('returns all user rooms when filter is empty', () => {
    expect(applyRoomFilters(rooms, {})).toEqual(rooms);
    expect(applyRoomFilters(rooms)).toEqual(rooms);
  });

  it('intersects with rooms allow-list', () => {
    expect(applyRoomFilters(rooms, { rooms: [ROOM_B, ROOM_C] })).toEqual([ROOM_B, ROOM_C]);
  });

  it('drops rooms not in the user set even if allow-listed', () => {
    expect(applyRoomFilters([ROOM_A], { rooms: [ROOM_A, ROOM_B] })).toEqual([ROOM_A]);
  });

  it('excludes not_rooms', () => {
    expect(applyRoomFilters(rooms, { not_rooms: [ROOM_B] })).toEqual([ROOM_A, ROOM_C]);
  });

  it('applies rooms then not_rooms', () => {
    expect(applyRoomFilters(rooms, { rooms: [ROOM_A, ROOM_B], not_rooms: [ROOM_A] })).toEqual([ROOM_B]);
  });

  it('treats empty rooms/not_rooms arrays as no-op', () => {
    expect(applyRoomFilters(rooms, { rooms: [], not_rooms: [] })).toEqual(rooms);
  });

  it('preserves Iterable input order via Array.from', () => {
    const set = new Set([ROOM_C, ROOM_A, ROOM_B]);
    expect(applyRoomFilters(set, {})).toEqual([ROOM_C, ROOM_A, ROOM_B]);
  });

  it('returns empty when allow-list has no overlap', () => {
    expect(applyRoomFilters([ROOM_A], { rooms: [ROOM_B] })).toEqual([]);
  });
});

describe('buildOrderByClause', () => {
  it('orders by rank ASC for rank', () => {
    expect(buildOrderByClause('rank')).toBe(' ORDER BY rank ASC');
  });

  it('orders by origin_server_ts DESC for recent and defaults', () => {
    expect(buildOrderByClause('recent')).toBe(' ORDER BY e.origin_server_ts DESC');
    expect(buildOrderByClause(undefined)).toBe(' ORDER BY e.origin_server_ts DESC');
    expect(buildOrderByClause('other')).toBe(' ORDER BY e.origin_server_ts DESC');
  });
});

describe('appendInFilter / appendSenderTypeFilters', () => {
  it('no-ops on empty/undefined values', () => {
    const params: unknown[] = [];
    expect(appendInFilter('Q', params, 'e.sender', undefined)).toBe('Q');
    expect(appendInFilter('Q', params, 'e.sender', [])).toBe('Q');
    expect(params).toEqual([]);
  });

  it('appends IN placeholders and binds values', () => {
    const params: unknown[] = ['term'];
    const q = appendInFilter('BASE', params, 'e.sender', ['@a:x', '@b:x']);
    expect(q).toBe('BASE AND e.sender IN (?,?)');
    expect(params).toEqual(['term', '@a:x', '@b:x']);
  });

  it('appends NOT IN when negate is true', () => {
    const params: unknown[] = [];
    const q = appendInFilter('BASE', params, 'e.event_type', ['m.room.message'], true);
    expect(q).toBe('BASE AND e.event_type NOT IN (?)');
    expect(params).toEqual(['m.room.message']);
  });

  it('chains sender/type filters in product order', () => {
    const params: unknown[] = [];
    const filter: SearchFilter = {
      senders: ['@a:x'],
      not_senders: ['@b:x'],
      types: ['m.room.message'],
      not_types: ['m.room.member'],
    };
    const q = appendSenderTypeFilters('BASE', params, filter);
    expect(q).toBe(
      'BASE AND e.sender IN (?) AND e.sender NOT IN (?) AND e.event_type IN (?) AND e.event_type NOT IN (?)'
    );
    expect(params).toEqual(['@a:x', '@b:x', 'm.room.message', 'm.room.member']);
  });

  it('skips absent filter fields', () => {
    const params: unknown[] = [];
    const q = appendSenderTypeFilters('BASE', params, { senders: ['@a:x'] });
    expect(q).toBe('BASE AND e.sender IN (?)');
    expect(params).toEqual(['@a:x']);
  });
});

describe('parseEventContent / parseContextEventContent', () => {
  it('parses object JSON', () => {
    expect(parseEventContent('{"body":"hi"}')).toEqual({ body: 'hi' });
  });

  it('returns {} on malformed JSON', () => {
    expect(parseEventContent('{')).toEqual({});
    expect(parseEventContent('')).toEqual({});
  });

  it('preserves arrays from JSON.parse (prior behavior)', () => {
    expect(parseEventContent('[1,2]')).toEqual([1, 2]);
  });

  it('parseContextEventContent throws on bad JSON', () => {
    expect(() => parseContextEventContent('{')).toThrow();
  });

  it('parseContextEventContent returns objects', () => {
    expect(parseContextEventContent('{"a":1}')).toEqual({ a: 1 });
  });
});

describe('absoluteRank / buildSearchResultFromRow', () => {
  it('takes absolute value and treats nullish as 0', () => {
    expect(absoluteRank(-1.5)).toBe(1.5);
    expect(absoluteRank(2)).toBe(2);
    expect(absoluteRank(0)).toBe(0);
    expect(absoluteRank(null)).toBe(0);
    expect(absoluteRank(undefined)).toBe(0);
  });

  it('maps a row into SearchResult with abs rank and parsed content', () => {
    const row: SearchEventRow = {
      event_id: '$x',
      event_type: 'm.room.message',
      room_id: ROOM_A,
      sender: AUTH_USER,
      origin_server_ts: 99,
      content: '{"body":"z"}',
      rank: -2.25,
    };
    expect(buildSearchResultFromRow(row)).toEqual({
      event_id: '$x',
      rank: 2.25,
      result: {
        event_id: '$x',
        type: 'm.room.message',
        room_id: ROOM_A,
        sender: AUTH_USER,
        origin_server_ts: 99,
        content: { body: 'z' },
      },
    });
  });

  it('uses {} content when row content is malformed', () => {
    const row: SearchEventRow = {
      event_id: '$x',
      event_type: 'm.room.message',
      room_id: ROOM_A,
      sender: AUTH_USER,
      origin_server_ts: 1,
      content: 'not-json',
      rank: 0,
    };
    expect(buildSearchResultFromRow(row).result.content).toEqual({});
  });
});

describe('formatContextEvent / resolveContextLimits / collectContextSenders', () => {
  it('formats a context row with room_id', () => {
    expect(
      formatContextEvent(
        {
          event_id: '$c',
          event_type: 'm.room.message',
          sender: AUTH_USER,
          origin_server_ts: 1,
          content: '{"body":"c"}',
        },
        ROOM_A
      )
    ).toEqual({
      event_id: '$c',
      type: 'm.room.message',
      sender: AUTH_USER,
      origin_server_ts: 1,
      content: { body: 'c' },
      room_id: ROOM_A,
    });
  });

  it('defaults context limits to 5 / 5', () => {
    expect(resolveContextLimits({})).toEqual({ beforeLimit: 5, afterLimit: 5 });
  });

  it('honors explicit before/after including 0', () => {
    expect(resolveContextLimits({ before_limit: 0, after_limit: 2 })).toEqual({
      beforeLimit: 0,
      afterLimit: 2,
    });
  });

  it('collects unique senders from hit + before + after', () => {
    expect(
      collectContextSenders(AUTH_USER, [{ sender: OTHER_USER }, { sender: AUTH_USER }], [
        { sender: '@carol:example.com' },
      ])
    ).toEqual([AUTH_USER, OTHER_USER, '@carol:example.com']);
  });
});

describe('mapUserProfile', () => {
  it('maps nullish names/avatars to undefined', () => {
    expect(mapUserProfile({ display_name: null, avatar_url: null })).toEqual({
      displayname: undefined,
      avatar_url: undefined,
    });
  });

  it('maps empty strings to undefined via ||', () => {
    expect(mapUserProfile({ display_name: '', avatar_url: '' })).toEqual({
      displayname: undefined,
      avatar_url: undefined,
    });
  });

  it('preserves non-empty values', () => {
    expect(mapUserProfile({ display_name: 'Alice', avatar_url: 'mxc://x/y' })).toEqual({
      displayname: 'Alice',
      avatar_url: 'mxc://x/y',
    });
  });
});

describe('nextBatchToken / paginateSearchRows', () => {
  it('returns undefined when hasMore is false', () => {
    expect(nextBatchToken(0, 50, false)).toBeUndefined();
  });

  it('returns offset+pageSize string when hasMore', () => {
    expect(nextBatchToken(0, 50, true)).toBe('50');
    expect(nextBatchToken(50, 50, true)).toBe('100');
  });

  it('paginates with hasMore when rows exceed page size', () => {
    const rows = Array.from({ length: 51 }, (_, i) => i);
    expect(paginateSearchRows(rows, 50)).toEqual({ page: rows.slice(0, 50), hasMore: true });
  });

  it('paginates without hasMore at exact page size', () => {
    const rows = Array.from({ length: 50 }, (_, i) => i);
    expect(paginateSearchRows(rows)).toEqual({ page: rows, hasMore: false });
  });

  it('handles empty rows', () => {
    expect(paginateSearchRows([])).toEqual({ page: [], hasMore: false });
  });
});

describe('buildSearchGroupings / uniqueResultRoomIds', () => {
  const results: SearchResult[] = [
    {
      event_id: '$1',
      rank: 1,
      result: {
        event_id: '$1',
        type: 'm.room.message',
        room_id: ROOM_A,
        sender: AUTH_USER,
        origin_server_ts: 1,
        content: {},
      },
    },
    {
      event_id: '$2',
      rank: 1,
      result: {
        event_id: '$2',
        type: 'm.room.message',
        room_id: ROOM_A,
        sender: OTHER_USER,
        origin_server_ts: 2,
        content: {},
      },
    },
    {
      event_id: '$3',
      rank: 1,
      result: {
        event_id: '$3',
        type: 'm.room.message',
        room_id: ROOM_B,
        sender: AUTH_USER,
        origin_server_ts: 3,
        content: {},
      },
    },
  ];

  it('returns undefined for missing/empty group_by', () => {
    expect(buildSearchGroupings(results, undefined)).toBeUndefined();
    expect(buildSearchGroupings(results, [])).toBeUndefined();
  });

  it('ignores unknown group keys and returns undefined when none match', () => {
    expect(buildSearchGroupings(results, [{ key: 'day' }])).toBeUndefined();
  });

  it('groups by room_id', () => {
    expect(buildSearchGroupings(results, [{ key: 'room_id' }])).toEqual({
      room_id: {
        [ROOM_A]: { results: ['$1', '$2'], order: 0 },
        [ROOM_B]: { results: ['$3'], order: 0 },
      },
    });
  });

  it('groups by sender', () => {
    expect(buildSearchGroupings(results, [{ key: 'sender' }])).toEqual({
      sender: {
        [AUTH_USER]: { results: ['$1', '$3'], order: 0 },
        [OTHER_USER]: { results: ['$2'], order: 0 },
      },
    });
  });

  it('can group by room_id and sender together', () => {
    const g = buildSearchGroupings(results, [{ key: 'room_id' }, { key: 'sender' }]);
    expect(g?.room_id[ROOM_A].results).toEqual(['$1', '$2']);
    expect(g?.sender[AUTH_USER].results).toEqual(['$1', '$3']);
  });

  it('uniqueResultRoomIds preserves first-seen order', () => {
    expect(uniqueResultRoomIds(results)).toEqual([ROOM_A, ROOM_B]);
  });

  it('uniqueResultRoomIds returns empty for empty input', () => {
    expect(uniqueResultRoomIds([])).toEqual([]);
  });
});

describe('formatStateEvent / FTS skeletons', () => {
  it('formats state rows with JSON content', () => {
    expect(
      formatStateEvent(
        {
          event_type: 'm.room.member',
          state_key: AUTH_USER,
          sender: AUTH_USER,
          content: '{"membership":"join"}',
          origin_server_ts: 1,
        },
        ROOM_A
      )
    ).toEqual({
      type: 'm.room.member',
      state_key: AUTH_USER,
      sender: AUTH_USER,
      content: { membership: 'join' },
      origin_server_ts: 1,
      room_id: ROOM_A,
    });
  });

  it('throws when state content is malformed (prior bare JSON.parse)', () => {
    expect(() =>
      formatStateEvent(
        {
          event_type: 'm.room.name',
          state_key: '',
          sender: AUTH_USER,
          content: '{',
          origin_server_ts: 1,
        },
        ROOM_A
      )
    ).toThrow();
  });

  it('builds select skeleton with N room placeholders', () => {
    const sql = buildFtsSelectSkeleton(3);
    expect(sql).toContain('bm25(events_fts) as rank');
    expect(sql).toContain('e.room_id IN (?,?,?)');
    expect(sql).toContain('fts.body MATCH ?');
  });

  it('builds count skeleton with N room placeholders', () => {
    const sql = buildFtsCountSkeleton(1);
    expect(sql).toContain('COUNT(*) as total');
    expect(sql).toContain('e.room_id IN (?)');
  });

  it('builds empty IN list for zero rooms (edge)', () => {
    expect(buildFtsSelectSkeleton(0)).toContain('e.room_id IN ()');
  });
});

describe('extractHighlights', () => {
  it('lowercases and splits on whitespace', () => {
    expect(extractHighlights('Hello World')).toEqual(['hello', 'world']);
  });

  it('dedupes repeated terms', () => {
    expect(extractHighlights('foo FOO Foo')).toEqual(['foo']);
  });

  it('drops empty segments from multi-space', () => {
    expect(extractHighlights('  a   b  ')).toEqual(['a', 'b']);
  });

  it('returns empty array for blank input', () => {
    expect(extractHighlights('')).toEqual([]);
    expect(extractHighlights('   ')).toEqual([]);
  });

  it('preserves punctuation attached to words', () => {
    expect(extractHighlights('hello, world!')).toEqual(['hello,', 'world!']);
  });
});

// ---------------------------------------------------------------------------
// Route: POST /_matrix/client/v3/search
// ---------------------------------------------------------------------------

describe('POST /_matrix/client/v3/search — request validation', () => {
  it('returns M_BAD_JSON for malformed body', async () => {
    const db = seedBasic();
    const res = await request('/_matrix/client/v3/search', db, '{');
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });

  it('returns empty room_events when search_categories.room_events missing', async () => {
    const db = seedBasic();
    const res = await request('/_matrix/client/v3/search', db, { search_categories: {} });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(emptyRoomEventsResponse());
  });

  it('returns empty room_events for blank search_term', async () => {
    const db = seedBasic();
    const res = await request('/_matrix/client/v3/search', db, roomEventsBody({ search_term: '   ' }));
    expect(res.status).toBe(200);
    expect(res.body.search_categories.room_events.results).toEqual([]);
    expect(res.body.search_categories.room_events.count).toBe(0);
  });

  it('returns empty room_events for empty search_term', async () => {
    const db = seedBasic();
    const res = await request('/_matrix/client/v3/search', db, roomEventsBody({ search_term: '' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(emptyRoomEventsResponse());
  });
});

describe('POST /_matrix/client/v3/search — membership / room filters', () => {
  it('searches join+leave rooms and excludes rooms the user never joined', async () => {
    const db = seedBasic();
    const res = await request('/_matrix/client/v3/search', db, roomEventsBody({ search_term: 'hello' }));
    expect(res.status).toBe(200);
    const ids = res.body.search_categories.room_events.results.map((r: any) => r.event_id);
    expect(ids).toContain('$e1');
    expect(ids).toContain('$e2');
    expect(ids).toContain('$e3');
    expect(ids).not.toContain('$e5'); // ROOM_C only OTHER_USER
  });

  it('returns empty when rooms filter intersects to nothing', async () => {
    const db = seedBasic();
    const res = await request(
      '/_matrix/client/v3/search',
      db,
      roomEventsBody({ search_term: 'hello', filter: { rooms: [ROOM_C] } })
    );
    expect(res.body).toEqual(emptyRoomEventsResponse());
  });

  it('honors rooms allow-list within membership', async () => {
    const db = seedBasic();
    const res = await request(
      '/_matrix/client/v3/search',
      db,
      roomEventsBody({ search_term: 'hello', filter: { rooms: [ROOM_B] } })
    );
    const ids = res.body.search_categories.room_events.results.map((r: any) => r.event_id);
    expect(ids).toEqual(['$e3']);
  });

  it('honors not_rooms exclusion', async () => {
    const db = seedBasic();
    const res = await request(
      '/_matrix/client/v3/search',
      db,
      roomEventsBody({ search_term: 'hello', filter: { not_rooms: [ROOM_A] } })
    );
    const ids = res.body.search_categories.room_events.results.map((r: any) => r.event_id);
    expect(ids).toEqual(['$e3']);
  });

  it('returns empty when user has no join/leave memberships', async () => {
    const db = createSearchDb({ memberships: [], events: [], fts: [] });
    const res = await request('/_matrix/client/v3/search', db, roomEventsBody());
    expect(res.body).toEqual(emptyRoomEventsResponse());
  });

  it('ignores invite/ban memberships for searchable rooms', async () => {
    const db = createSearchDb({
      memberships: [
        { room_id: ROOM_A, user_id: AUTH_USER, membership: 'invite' },
        { room_id: ROOM_B, user_id: AUTH_USER, membership: 'ban' },
      ],
      events: [makeEvent({ event_id: '$e1', room_id: ROOM_A, origin_server_ts: 1 })],
      fts: [{ event_id: '$e1', body: 'hello', rank: -1 }],
    });
    const res = await request('/_matrix/client/v3/search', db, roomEventsBody());
    expect(res.body).toEqual(emptyRoomEventsResponse());
  });
});

describe('POST /_matrix/client/v3/search — sender/type filters + order', () => {
  it('filters by senders', async () => {
    const db = seedBasic();
    const res = await request(
      '/_matrix/client/v3/search',
      db,
      roomEventsBody({ search_term: 'hello', filter: { senders: [OTHER_USER] } })
    );
    const ids = res.body.search_categories.room_events.results.map((r: any) => r.event_id);
    expect(ids).toEqual(['$e2']);
  });

  it('filters by not_senders', async () => {
    const db = seedBasic();
    const res = await request(
      '/_matrix/client/v3/search',
      db,
      roomEventsBody({ search_term: 'hello', filter: { not_senders: [OTHER_USER] } })
    );
    const ids = res.body.search_categories.room_events.results.map((r: any) => r.event_id);
    expect(ids).toContain('$e1');
    expect(ids).toContain('$e3');
    expect(ids).not.toContain('$e2');
  });

  it('filters by types', async () => {
    const db = seedBasic();
    // force a member event into FTS so type filter can hit it
    db.store.fts.push({ event_id: '$e4', body: 'hello member', rank: -0.1 });
    const res = await request(
      '/_matrix/client/v3/search',
      db,
      roomEventsBody({ search_term: 'hello', filter: { types: ['m.room.member'] } })
    );
    const ids = res.body.search_categories.room_events.results.map((r: any) => r.event_id);
    expect(ids).toEqual(['$e4']);
  });

  it('filters by not_types', async () => {
    const db = seedBasic();
    db.store.fts.push({ event_id: '$e4', body: 'hello member', rank: -0.1 });
    const res = await request(
      '/_matrix/client/v3/search',
      db,
      roomEventsBody({ search_term: 'hello', filter: { not_types: ['m.room.message'] } })
    );
    const ids = res.body.search_categories.room_events.results.map((r: any) => r.event_id);
    expect(ids).toEqual(['$e4']);
  });

  it('orders by recent (default) descending origin_server_ts', async () => {
    const db = seedBasic();
    const res = await request('/_matrix/client/v3/search', db, roomEventsBody({ search_term: 'hello' }));
    const ts = res.body.search_categories.room_events.results.map((r: any) => r.result.origin_server_ts);
    expect(ts).toEqual([...ts].sort((a: number, b: number) => b - a));
  });

  it('orders by rank ascending BM25 when order_by=rank', async () => {
    const db = seedBasic();
    const res = await request(
      '/_matrix/client/v3/search',
      db,
      roomEventsBody({ search_term: 'hello', order_by: 'rank' })
    );
    const ranks = res.body.search_categories.room_events.results.map((r: any) => r.rank);
    // absolute ranks from -2, -1.5, -0.5 → 2, 1.5, 0.5 — order follows raw ASC then abs
    expect(ranks[0]).toBeGreaterThanOrEqual(ranks[ranks.length - 1] > 0 ? 0 : -Infinity);
    const rawOrder = db.store.fts
      .filter((f) => f.body.includes('hello'))
      .sort((a, b) => a.rank - b.rank)
      .map((f) => Math.abs(f.rank));
    expect(ranks).toEqual(rawOrder);
  });

  it('returns absolute ranks in results', async () => {
    const db = seedBasic();
    const res = await request('/_matrix/client/v3/search', db, roomEventsBody({ search_term: 'hello' }));
    for (const r of res.body.search_categories.room_events.results) {
      expect(r.rank).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('POST /_matrix/client/v3/search — highlights / count / pagination', () => {
  it('returns lowercase unique highlights from the raw search_term', async () => {
    const db = seedBasic();
    const res = await request(
      '/_matrix/client/v3/search',
      db,
      roomEventsBody({ search_term: 'Hello HELLO world' })
    );
    expect(res.body.search_categories.room_events.highlights).toEqual(['hello', 'world']);
  });

  it('returns approximate count from FTS count query', async () => {
    const db = seedBasic();
    const res = await request('/_matrix/client/v3/search', db, roomEventsBody({ search_term: 'hello' }));
    expect(res.body.search_categories.room_events.count).toBe(3);
  });

  it('escapes FTS specials before MATCH', async () => {
    const db = seedBasic();
    await request('/_matrix/client/v3/search', db, roomEventsBody({ search_term: 'hello"world' }));
    const ftsBind = db.store.bindLog.find((b) => typeof b[0] === 'string' && (b[0] as string).includes('hello'));
    expect(ftsBind?.[0]).toBe('hello world');
  });

  it('omits next_batch when results fit in one page', async () => {
    const db = seedBasic();
    const res = await request('/_matrix/client/v3/search', db, roomEventsBody({ search_term: 'hello' }));
    expect(res.body.search_categories.room_events.next_batch).toBeUndefined();
  });

  it('includes next_batch when more than SEARCH_PAGE_SIZE matches', async () => {
    const events: EventRow[] = [];
    const fts: FtsRow[] = [];
    for (let i = 0; i < 55; i++) {
      const id = `$p${i}`;
      events.push(
        makeEvent({
          event_id: id,
          room_id: ROOM_A,
          origin_server_ts: 1000 + i,
          content: JSON.stringify({ body: `hello ${i}`, msgtype: 'm.text' }),
        })
      );
      fts.push({ event_id: id, body: `hello ${i}`, rank: -1 });
    }
    const db = createSearchDb({
      memberships: [{ room_id: ROOM_A, user_id: AUTH_USER, membership: 'join' }],
      events,
      fts,
    });
    const res = await request('/_matrix/client/v3/search', db, roomEventsBody({ search_term: 'hello' }));
    expect(res.body.search_categories.room_events.results).toHaveLength(50);
    expect(res.body.search_categories.room_events.next_batch).toBe('50');
    expect(res.body.search_categories.room_events.count).toBe(55);
  });

  it('honors next_batch offset for page 2', async () => {
    const events: EventRow[] = [];
    const fts: FtsRow[] = [];
    for (let i = 0; i < 55; i++) {
      const id = `$p${i}`;
      events.push(
        makeEvent({
          event_id: id,
          room_id: ROOM_A,
          origin_server_ts: 1000 + i,
          content: JSON.stringify({ body: `hello ${i}`, msgtype: 'm.text' }),
        })
      );
      fts.push({ event_id: id, body: `hello ${i}`, rank: -1 });
    }
    const db = createSearchDb({
      memberships: [{ room_id: ROOM_A, user_id: AUTH_USER, membership: 'join' }],
      events,
      fts,
    });
    const res = await request('/_matrix/client/v3/search?next_batch=50', db, roomEventsBody({ search_term: 'hello' }));
    expect(res.body.search_categories.room_events.results).toHaveLength(5);
    expect(res.body.search_categories.room_events.next_batch).toBeUndefined();
  });
});

describe('POST /_matrix/client/v3/search — context / profiles / state / groupings', () => {
  it('adds events_before/after when event_context is set', async () => {
    const db = seedBasic();
    const res = await request(
      '/_matrix/client/v3/search',
      db,
      roomEventsBody({
        search_term: 'hello bob',
        filter: { rooms: [ROOM_A], senders: [OTHER_USER] },
        event_context: { before_limit: 2, after_limit: 2 },
      })
    );
    const hit = res.body.search_categories.room_events.results[0];
    expect(hit.event_id).toBe('$e2');
    expect(hit.context.events_before.map((e: any) => e.event_id)).toContain('$e1');
    expect(hit.context.events_before.map((e: any) => e.event_id)).toContain('$e4');
    // chronological before (reversed from DESC query)
    const beforeTs = hit.context.events_before.map((e: any) => e.origin_server_ts);
    expect(beforeTs).toEqual([...beforeTs].sort((a: number, b: number) => a - b));
  });

  it('includes profile_info when include_profile is true', async () => {
    const db = seedBasic();
    const res = await request(
      '/_matrix/client/v3/search',
      db,
      roomEventsBody({
        search_term: 'hello bob',
        filter: { senders: [OTHER_USER] },
        event_context: { before_limit: 5, after_limit: 0, include_profile: true },
      })
    );
    const profiles = res.body.search_categories.room_events.results[0].context.profile_info;
    expect(profiles[AUTH_USER]).toEqual({ displayname: 'Alice', avatar_url: 'mxc://example.com/a' });
    expect(profiles[OTHER_USER]).toEqual({ displayname: undefined, avatar_url: undefined });
  });

  it('omits profile_info when include_profile is false/absent', async () => {
    const db = seedBasic();
    const res = await request(
      '/_matrix/client/v3/search',
      db,
      roomEventsBody({
        search_term: 'hello bob',
        filter: { senders: [OTHER_USER] },
        event_context: { before_limit: 1, after_limit: 0 },
      })
    );
    expect(res.body.search_categories.room_events.results[0].context.profile_info).toBeUndefined();
  });

  it('includes state map when include_state is true', async () => {
    const db = seedBasic();
    const res = await request(
      '/_matrix/client/v3/search',
      db,
      roomEventsBody({ search_term: 'hello alice', filter: { rooms: [ROOM_A] }, include_state: true })
    );
    const state = res.body.search_categories.room_events.state;
    expect(state[ROOM_A]).toEqual([
      expect.objectContaining({
        type: 'm.room.member',
        state_key: AUTH_USER,
        room_id: ROOM_A,
        content: { membership: 'join' },
      }),
    ]);
  });

  it('omits state when include_state is false', async () => {
    const db = seedBasic();
    const res = await request('/_matrix/client/v3/search', db, roomEventsBody({ search_term: 'hello' }));
    expect(res.body.search_categories.room_events.state).toBeUndefined();
  });

  it('omits state when include_state true but zero results', async () => {
    const db = seedBasic();
    const res = await request(
      '/_matrix/client/v3/search',
      db,
      roomEventsBody({ search_term: 'nomatchzzz', include_state: true })
    );
    expect(res.body.search_categories.room_events.state).toBeUndefined();
    expect(res.body.search_categories.room_events.results).toEqual([]);
  });

  it('builds room_id groupings', async () => {
    const db = seedBasic();
    const res = await request(
      '/_matrix/client/v3/search',
      db,
      roomEventsBody({
        search_term: 'hello',
        groupings: { group_by: [{ key: 'room_id' }] },
      })
    );
    const groups = res.body.search_categories.room_events.groups;
    expect(groups.room_id[ROOM_A].results).toEqual(expect.arrayContaining(['$e1', '$e2']));
    expect(groups.room_id[ROOM_B].results).toEqual(['$e3']);
  });

  it('builds sender groupings', async () => {
    const db = seedBasic();
    const res = await request(
      '/_matrix/client/v3/search',
      db,
      roomEventsBody({
        search_term: 'hello',
        groupings: { group_by: [{ key: 'sender' }] },
      })
    );
    const groups = res.body.search_categories.room_events.groups;
    expect(groups.sender[OTHER_USER].results).toEqual(['$e2']);
    expect(groups.sender[AUTH_USER].results).toEqual(expect.arrayContaining(['$e1', '$e3']));
  });

  it('ignores unknown grouping keys without emitting groups', async () => {
    const db = seedBasic();
    const res = await request(
      '/_matrix/client/v3/search',
      db,
      roomEventsBody({
        search_term: 'hello',
        groupings: { group_by: [{ key: 'day' }] },
      })
    );
    expect(res.body.search_categories.room_events.groups).toBeUndefined();
  });

  it('uses default context limits of 5 when limits omitted', async () => {
    const events: EventRow[] = [
      makeEvent({ event_id: '$hit', room_id: ROOM_A, origin_server_ts: 5000, content: JSON.stringify({ body: 'hello', msgtype: 'm.text' }) }),
    ];
    for (let i = 1; i <= 8; i++) {
      events.push(
        makeEvent({
          event_id: `$b${i}`,
          room_id: ROOM_A,
          origin_server_ts: 5000 - i * 10,
          content: JSON.stringify({ body: `before ${i}`, msgtype: 'm.text' }),
        })
      );
      events.push(
        makeEvent({
          event_id: `$a${i}`,
          room_id: ROOM_A,
          origin_server_ts: 5000 + i * 10,
          content: JSON.stringify({ body: `after ${i}`, msgtype: 'm.text' }),
        })
      );
    }
    const db = createSearchDb({
      memberships: [{ room_id: ROOM_A, user_id: AUTH_USER, membership: 'join' }],
      events,
      fts: [{ event_id: '$hit', body: 'hello', rank: -1 }],
    });
    const res = await request(
      '/_matrix/client/v3/search',
      db,
      roomEventsBody({ search_term: 'hello', event_context: {} })
    );
    const ctx = res.body.search_categories.room_events.results[0].context;
    expect(ctx.events_before).toHaveLength(5);
    expect(ctx.events_after).toHaveLength(5);
  });
});

describe('POST /_matrix/client/v3/search — content / isolation edges', () => {
  it('parses event content into result.content', async () => {
    const db = seedBasic();
    const res = await request(
      '/_matrix/client/v3/search',
      db,
      roomEventsBody({ search_term: 'hello alice', filter: { rooms: [ROOM_A] } })
    );
    expect(res.body.search_categories.room_events.results[0].result.content).toEqual({
      body: 'hello alice',
      msgtype: 'm.text',
    });
  });

  it('returns {} content when stored content is malformed', async () => {
    const db = createSearchDb({
      memberships: [{ room_id: ROOM_A, user_id: AUTH_USER, membership: 'join' }],
      events: [
        makeEvent({
          event_id: '$bad',
          room_id: ROOM_A,
          origin_server_ts: 1,
          content: '{not-json',
        }),
      ],
      fts: [{ event_id: '$bad', body: 'hello', rank: -1 }],
    });
    const res = await request('/_matrix/client/v3/search', db, roomEventsBody({ search_term: 'hello' }));
    expect(res.body.search_categories.room_events.results[0].result.content).toEqual({});
  });

  it('does not leak another user membership rooms', async () => {
    const db = seedBasic();
    const res = await request('/_matrix/client/v3/search', db, roomEventsBody({ search_term: 'secret' }));
    expect(res.body.search_categories.room_events.results).toEqual([]);
    expect(res.body.search_categories.room_events.count).toBe(0);
  });

  it('round-trips filter + order + grouping in one request', async () => {
    const db = seedBasic();
    const res = await request(
      '/_matrix/client/v3/search',
      db,
      roomEventsBody({
        search_term: 'hello',
        filter: { rooms: [ROOM_A, ROOM_B], not_senders: [OTHER_USER] },
        order_by: 'recent',
        groupings: { group_by: [{ key: 'room_id' }, { key: 'sender' }] },
      })
    );
    const ids = res.body.search_categories.room_events.results.map((r: any) => r.event_id);
    expect(ids).toEqual(expect.arrayContaining(['$e1', '$e3']));
    expect(ids).not.toContain('$e2');
    expect(res.body.search_categories.room_events.groups.room_id).toBeTruthy();
    expect(res.body.search_categories.room_events.groups.sender).toBeTruthy();
  });
});
