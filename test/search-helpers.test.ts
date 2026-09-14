/**
 * TOKENMAXX HEAVY deepen after #89 (spaces) — different slice: client search helpers + route.
 * Avoids spaces (#89), event-auth (#88), versions/well-known (#87), server-notice (#85).
 * Tests only (+ export/extraction for testability; no product inventing).
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

import search, {
  SEARCH_PAGE_LIMIT,
  applyRoomIdFilters,
  buildSearchGroupings,
  emptyRoomEventsSearchResponse,
  escapeFtsSearchTerm,
  extractHighlights,
  formatSearchRank,
  isBlankSearchTerm,
  nextSearchBatchToken,
  parseSearchOffset,
  resolveEventContextLimits,
  resolveSearchOrderBy,
} from '../src/api/search';
import type { Env } from '../src/types';

const USER = '@alice:example.com';

type FtsRow = {
  event_id: string;
  event_type: string;
  room_id: string;
  sender: string;
  origin_server_ts: number;
  content: string;
  rank: number;
};

type CtxRow = {
  event_id: string;
  event_type: string;
  sender: string;
  origin_server_ts: number;
  content: string;
};

type StateRow = {
  event_type: string;
  state_key: string;
  sender: string;
  content: string;
  origin_server_ts: number;
};

type ProfileRow = { display_name: string | null; avatar_url: string | null };

type SearchDbOpts = {
  memberships?: string[];
  ftsRows?: FtsRow[];
  total?: number | null;
  /** Context events keyed by `${roomId}|before|${ts}` / `${roomId}|after|${ts}` */
  context?: Record<string, CtxRow[]>;
  profiles?: Record<string, ProfileRow | null>;
  roomState?: Record<string, StateRow[]>;
  throwOnSqlIncludes?: string;
};

function createSearchDb(opts: SearchDbOpts = {}): D1Database & { sqlLog: string[]; bindLog: unknown[][] } {
  const memberships = opts.memberships ?? ['!a:example.com', '!b:example.com'];
  const ftsRows = opts.ftsRows ?? [];
  const total = opts.total === undefined ? ftsRows.length : opts.total;
  const context = opts.context ?? {};
  const profiles = opts.profiles ?? {};
  const roomState = opts.roomState ?? {};
  const sqlLog: string[] = [];
  const bindLog: unknown[][] = [];

  return {
    sqlLog,
    bindLog,
    prepare(sql: string) {
      sqlLog.push(sql);
      return {
        bind(...args: unknown[]) {
          bindLog.push(args);
          return {
            async first<T>() {
              if (opts.throwOnSqlIncludes && sql.includes(opts.throwOnSqlIncludes)) {
                throw new Error(`db boom: ${opts.throwOnSqlIncludes}`);
              }
              if (sql.includes('COUNT(*)')) {
                return { total } as T;
              }
              if (sql.includes('FROM users WHERE user_id')) {
                const userId = args[0] as string;
                const profile = profiles[userId];
                return (profile === undefined ? null : profile) as T;
              }
              return null as T;
            },
            async all<T>() {
              if (opts.throwOnSqlIncludes && sql.includes(opts.throwOnSqlIncludes)) {
                throw new Error(`db boom: ${opts.throwOnSqlIncludes}`);
              }
              if (sql.includes('FROM room_memberships')) {
                return { results: memberships.map((room_id) => ({ room_id })) } as { results: T[] };
              }
              if (sql.includes('FROM events_fts') || sql.includes('bm25(events_fts)')) {
                // Apply LIMIT/OFFSET from bind args (last two params)
                const limit = Number(args[args.length - 2] ?? 51);
                const offset = Number(args[args.length - 1] ?? 0);
                let rows = ftsRows.slice();

                // Optional sender IN filter — detect by SQL fragment and bind positions
                if (sql.includes('AND e.sender IN (')) {
                  const senderInMatch = sql.match(
                    /AND e\.sender IN \(([^)]+)\)/
                  );
                  if (senderInMatch) {
                    const placeholderCount = (senderInMatch[1].match(/\?/g) || []).length;
                    // find slice: args[0]=fts, args[1..n]=rooms, then senders
                    const roomCount = (sql.match(/e\.room_id IN \(([^)]+)\)/)?.[1].match(/\?/g) || [])
                      .length;
                    const senderStart = 1 + roomCount;
                    const filterSenders = args.slice(
                      senderStart,
                      senderStart + placeholderCount
                    ) as string[];
                    rows = rows.filter((r) => filterSenders.includes(r.sender));
                  }
                }
                if (sql.includes('AND e.sender NOT IN (')) {
                  const notMatch = sql.match(/AND e\.sender NOT IN \(([^)]+)\)/);
                  if (notMatch) {
                    const placeholderCount = (notMatch[1].match(/\?/g) || []).length;
                    const roomCount = (sql.match(/e\.room_id IN \(([^)]+)\)/)?.[1].match(/\?/g) || [])
                      .length;
                    let cursor = 1 + roomCount;
                    if (sql.includes('AND e.sender IN (')) {
                      const inCount = (
                        sql.match(/AND e\.sender IN \(([^)]+)\)/)?.[1].match(/\?/g) || []
                      ).length;
                      cursor += inCount;
                    }
                    const excluded = args.slice(cursor, cursor + placeholderCount) as string[];
                    rows = rows.filter((r) => !excluded.includes(r.sender));
                  }
                }
                if (sql.includes('AND e.event_type IN (')) {
                  const typeMatch = sql.match(/AND e\.event_type IN \(([^)]+)\)/);
                  if (typeMatch) {
                    const placeholderCount = (typeMatch[1].match(/\?/g) || []).length;
                    // types are after rooms (+ optional sender filters); take trailing filter values before limit
                    const typeArgs = args.slice(
                      args.length - 2 - placeholderCount,
                      args.length - 2
                    ) as string[];
                    // If not_types also present, this slice may include them — handle NOT IN separately below
                    if (!sql.includes('AND e.event_type NOT IN (')) {
                      rows = rows.filter((r) => typeArgs.includes(r.event_type));
                    } else {
                      // only take the IN portion: walk from after rooms/senders
                      const roomCount = (
                        sql.match(/e\.room_id IN \(([^)]+)\)/)?.[1].match(/\?/g) || []
                      ).length;
                      let cursor = 1 + roomCount;
                      if (sql.includes('AND e.sender IN (')) {
                        cursor += (
                          sql.match(/AND e\.sender IN \(([^)]+)\)/)?.[1].match(/\?/g) || []
                        ).length;
                      }
                      if (sql.includes('AND e.sender NOT IN (')) {
                        cursor += (
                          sql.match(/AND e\.sender NOT IN \(([^)]+)\)/)?.[1].match(/\?/g) || []
                        ).length;
                      }
                      const includeTypes = args.slice(cursor, cursor + placeholderCount) as string[];
                      rows = rows.filter((r) => includeTypes.includes(r.event_type));
                    }
                  }
                }
                if (sql.includes('AND e.event_type NOT IN (')) {
                  const notTypeMatch = sql.match(/AND e\.event_type NOT IN \(([^)]+)\)/);
                  if (notTypeMatch) {
                    const placeholderCount = (notTypeMatch[1].match(/\?/g) || []).length;
                    const excludeTypes = args.slice(
                      args.length - 2 - placeholderCount,
                      args.length - 2
                    ) as string[];
                    rows = rows.filter((r) => !excludeTypes.includes(r.event_type));
                  }
                }

                if (sql.includes('ORDER BY rank ASC')) {
                  rows = rows.slice().sort((a, b) => a.rank - b.rank);
                } else {
                  rows = rows.slice().sort((a, b) => b.origin_server_ts - a.origin_server_ts);
                }

                return { results: rows.slice(offset, offset + limit) } as { results: T[] };
              }
              if (sql.includes('origin_server_ts < ?')) {
                const roomId = args[0] as string;
                const ts = args[1] as number;
                const key = `${roomId}|before|${ts}`;
                return { results: (context[key] ?? []).slice() } as { results: T[] };
              }
              if (sql.includes('origin_server_ts > ?')) {
                const roomId = args[0] as string;
                const ts = args[1] as number;
                const key = `${roomId}|after|${ts}`;
                return { results: (context[key] ?? []).slice() } as { results: T[] };
              }
              if (sql.includes('FROM room_state')) {
                const roomId = args[0] as string;
                return { results: (roomState[roomId] ?? []).slice() } as { results: T[] };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  } as unknown as D1Database & { sqlLog: string[]; bindLog: unknown[][] };
}

function env(db: D1Database): Env {
  return {
    SERVER_NAME: 'example.com',
    DB: db,
  } as Env;
}

async function postSearch(
  body: unknown,
  db: D1Database,
  query = ''
): Promise<{ status: number; body: any }> {
  const res = await search.request(
    `http://localhost/_matrix/client/v3/search${query}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    env(db)
  );
  return { status: res.status, body: await res.json() };
}

function fts(
  partial: Partial<FtsRow> & Pick<FtsRow, 'event_id'>
): FtsRow {
  return {
    event_type: 'm.room.message',
    room_id: '!a:example.com',
    sender: '@bob:example.com',
    origin_server_ts: 1000,
    content: JSON.stringify({ body: 'hello world', msgtype: 'm.text' }),
    rank: -1.5,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('emptyRoomEventsSearchResponse', () => {
  it('returns the canonical empty payload shape', () => {
    expect(emptyRoomEventsSearchResponse()).toEqual({
      search_categories: {
        room_events: { results: [], count: 0, highlights: [] },
      },
    });
  });

  it('returns a fresh object each call', () => {
    const a = emptyRoomEventsSearchResponse();
    const b = emptyRoomEventsSearchResponse();
    expect(a).not.toBe(b);
    expect(a.search_categories).not.toBe(b.search_categories);
    expect(a.search_categories.room_events).not.toBe(b.search_categories.room_events);
  });
});

describe('isBlankSearchTerm', () => {
  it('treats nullish and empty as blank', () => {
    expect(isBlankSearchTerm(null)).toBe(true);
    expect(isBlankSearchTerm(undefined)).toBe(true);
    expect(isBlankSearchTerm('')).toBe(true);
  });

  it('treats whitespace-only as blank', () => {
    expect(isBlankSearchTerm(' ')).toBe(true);
    expect(isBlankSearchTerm('\t\n')).toBe(true);
    expect(isBlankSearchTerm('   \t  ')).toBe(true);
  });

  it('accepts non-blank terms including padded content', () => {
    expect(isBlankSearchTerm('a')).toBe(false);
    expect(isBlankSearchTerm(' hello ')).toBe(false);
    expect(isBlankSearchTerm('0')).toBe(false);
  });
});

describe('applyRoomIdFilters', () => {
  const rooms = ['!a:ex', '!b:ex', '!c:ex'];

  it('returns all rooms when filter is empty', () => {
    expect(applyRoomIdFilters(rooms)).toEqual(rooms);
    expect(applyRoomIdFilters(new Set(rooms), {})).toEqual(rooms);
  });

  it('intersects with rooms allow-list', () => {
    expect(applyRoomIdFilters(rooms, { rooms: ['!b:ex', '!z:ex'] })).toEqual(['!b:ex']);
  });

  it('ignores empty rooms allow-list (falsy length)', () => {
    expect(applyRoomIdFilters(rooms, { rooms: [] })).toEqual(rooms);
  });

  it('excludes not_rooms', () => {
    expect(applyRoomIdFilters(rooms, { not_rooms: ['!a:ex', '!c:ex'] })).toEqual(['!b:ex']);
  });

  it('ignores empty not_rooms', () => {
    expect(applyRoomIdFilters(rooms, { not_rooms: [] })).toEqual(rooms);
  });

  it('applies rooms then not_rooms', () => {
    expect(
      applyRoomIdFilters(rooms, { rooms: ['!a:ex', '!b:ex'], not_rooms: ['!a:ex'] })
    ).toEqual(['!b:ex']);
  });

  it('returns empty when allow-list has no overlap', () => {
    expect(applyRoomIdFilters(rooms, { rooms: ['!z:ex'] })).toEqual([]);
  });

  it('returns empty when all rooms are excluded', () => {
    expect(applyRoomIdFilters(rooms, { not_rooms: rooms })).toEqual([]);
  });

  it('handles empty membership set', () => {
    expect(applyRoomIdFilters([], { rooms: ['!a:ex'] })).toEqual([]);
  });

  it('does not mutate the input iterable array', () => {
    const input = ['!a:ex', '!b:ex'];
    applyRoomIdFilters(input, { not_rooms: ['!a:ex'] });
    expect(input).toEqual(['!a:ex', '!b:ex']);
  });
});

describe('escapeFtsSearchTerm', () => {
  it('replaces FTS5 special characters with spaces and trims', () => {
    expect(escapeFtsSearchTerm(`hello"world`)).toBe('hello world');
    expect(escapeFtsSearchTerm(`a'b*c(d)e`)).toBe('a b c d e');
    expect(escapeFtsSearchTerm(`  "x"  `)).toBe('x');
  });

  it('leaves plain terms unchanged aside from trim', () => {
    expect(escapeFtsSearchTerm('hello world')).toBe('hello world');
    expect(escapeFtsSearchTerm('  hello  ')).toBe('hello');
  });

  it('can collapse to empty after escaping', () => {
    expect(escapeFtsSearchTerm(`"""`)).toBe('');
    expect(escapeFtsSearchTerm(`()*`)).toBe('');
    expect(escapeFtsSearchTerm(`'"`)).toBe('');
  });

  it('does not escape other punctuation', () => {
    expect(escapeFtsSearchTerm('foo-bar_baz?')).toBe('foo-bar_baz?');
    expect(escapeFtsSearchTerm('a:b')).toBe('a:b');
  });
});

describe('parseSearchOffset', () => {
  it('defaults missing/empty to 0', () => {
    expect(parseSearchOffset(undefined)).toBe(0);
    expect(parseSearchOffset(null)).toBe(0);
    // empty string is falsy → 0 without parseInt
    expect(parseSearchOffset('')).toBe(0);
  });

  it('parses integer offsets', () => {
    expect(parseSearchOffset('0')).toBe(0);
    expect(parseSearchOffset('50')).toBe(50);
    expect(parseSearchOffset('100')).toBe(100);
  });

  it('documents parseInt quirks for non-numeric tokens', () => {
    expect(parseSearchOffset('nope')).toBeNaN();
    expect(parseSearchOffset('12abc')).toBe(12);
    expect(parseSearchOffset(' 7')).toBe(7);
  });
});

describe('resolveSearchOrderBy', () => {
  it('uses BM25 ASC for rank', () => {
    expect(resolveSearchOrderBy('rank')).toBe(' ORDER BY rank ASC');
  });

  it('defaults to recent DESC for anything else', () => {
    expect(resolveSearchOrderBy(undefined)).toBe(' ORDER BY e.origin_server_ts DESC');
    expect(resolveSearchOrderBy('recent')).toBe(' ORDER BY e.origin_server_ts DESC');
    expect(resolveSearchOrderBy('RANK')).toBe(' ORDER BY e.origin_server_ts DESC'); // case-sensitive
    expect(resolveSearchOrderBy('')).toBe(' ORDER BY e.origin_server_ts DESC');
  });
});

describe('formatSearchRank', () => {
  it('returns absolute value of BM25 ranks', () => {
    expect(formatSearchRank(-2.5)).toBe(2.5);
    expect(formatSearchRank(3)).toBe(3);
    expect(formatSearchRank(-0)).toBe(0);
  });

  it('coerces nullish/0 via || 0 then abs', () => {
    expect(formatSearchRank(null)).toBe(0);
    expect(formatSearchRank(undefined)).toBe(0);
    expect(formatSearchRank(0)).toBe(0);
  });
});

describe('extractHighlights', () => {
  it('lowercases, splits on whitespace, dedupes', () => {
    expect(extractHighlights('Hello World hello')).toEqual(['hello', 'world']);
  });

  it('drops empty segments from runs of whitespace', () => {
    expect(extractHighlights('  a   b  ')).toEqual(['a', 'b']);
  });

  it('returns empty for blank input', () => {
    expect(extractHighlights('')).toEqual([]);
    expect(extractHighlights('   ')).toEqual([]);
  });

  it('preserves punctuation attached to words', () => {
    expect(extractHighlights('foo, bar!')).toEqual(['foo,', 'bar!']);
  });

  it('handles single token', () => {
    expect(extractHighlights('Matrix')).toEqual(['matrix']);
  });
});

describe('buildSearchGroupings', () => {
  const results = [
    {
      event_id: '$1',
      result: { room_id: '!a:ex', sender: '@a:ex' },
    },
    {
      event_id: '$2',
      result: { room_id: '!a:ex', sender: '@b:ex' },
    },
    {
      event_id: '$3',
      result: { room_id: '!b:ex', sender: '@a:ex' },
    },
  ];

  it('returns undefined for missing group_by', () => {
    expect(buildSearchGroupings(undefined, results)).toBeUndefined();
  });

  it('returns undefined when only unknown keys are requested', () => {
    expect(buildSearchGroupings([{ key: 'content' }], results)).toBeUndefined();
    expect(buildSearchGroupings([{ key: 'ROOM_ID' }], results)).toBeUndefined();
  });

  it('groups by room_id with order 0 and event id lists', () => {
    expect(buildSearchGroupings([{ key: 'room_id' }], results)).toEqual({
      room_id: {
        '!a:ex': { results: ['$1', '$2'], order: 0 },
        '!b:ex': { results: ['$3'], order: 0 },
      },
    });
  });

  it('groups by sender', () => {
    expect(buildSearchGroupings([{ key: 'sender' }], results)).toEqual({
      sender: {
        '@a:ex': { results: ['$1', '$3'], order: 0 },
        '@b:ex': { results: ['$2'], order: 0 },
      },
    });
  });

  it('supports both room_id and sender in one pass', () => {
    const groups = buildSearchGroupings([{ key: 'room_id' }, { key: 'sender' }], results);
    expect(groups).toHaveProperty('room_id');
    expect(groups).toHaveProperty('sender');
  });

  it('ignores unknown keys alongside known ones', () => {
    const groups = buildSearchGroupings(
      [{ key: 'nope' }, { key: 'sender' }, { key: 'also_nope' }],
      results
    );
    expect(Object.keys(groups!)).toEqual(['sender']);
  });

  it('returns empty-ish groups object structure for empty results', () => {
    expect(buildSearchGroupings([{ key: 'room_id' }], [])).toEqual({ room_id: {} });
  });
});

describe('resolveEventContextLimits', () => {
  it('defaults before/after to 5', () => {
    expect(resolveEventContextLimits({})).toEqual({ beforeLimit: 5, afterLimit: 5 });
  });

  it('uses provided limits (|| so 0 falls back)', () => {
    expect(resolveEventContextLimits({ before_limit: 2, after_limit: 9 })).toEqual({
      beforeLimit: 2,
      afterLimit: 9,
    });
    expect(resolveEventContextLimits({ before_limit: 0, after_limit: 0 })).toEqual({
      beforeLimit: 5,
      afterLimit: 5,
    });
  });
});

describe('nextSearchBatchToken / SEARCH_PAGE_LIMIT', () => {
  it('uses page limit constant 50', () => {
    expect(SEARCH_PAGE_LIMIT).toBe(50);
  });

  it('encodes offset + limit', () => {
    expect(nextSearchBatchToken(0)).toBe('50');
    expect(nextSearchBatchToken(50)).toBe('100');
    expect(nextSearchBatchToken(10, 25)).toBe('35');
  });
});

// ---------------------------------------------------------------------------
// Route: POST /_matrix/client/v3/search
// ---------------------------------------------------------------------------

describe('POST /_matrix/client/v3/search', () => {
  let db: ReturnType<typeof createSearchDb>;

  beforeEach(() => {
    db = createSearchDb();
  });

  it('returns M_BAD_JSON for invalid JSON body', async () => {
    const { status, body } = await postSearch('{', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });

  it('returns empty payload when room_events category is missing', async () => {
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });

  it('returns empty payload when search_categories is missing', async () => {
    const { body } = await postSearch({}, db);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });

  it('returns empty for blank search_term', async () => {
    for (const term of ['', '   ', '\t']) {
      const { body } = await postSearch(
        { search_categories: { room_events: { search_term: term } } },
        db
      );
      expect(body).toEqual(emptyRoomEventsSearchResponse());
    }
  });

  it('returns empty when user has no memberships', async () => {
    db = createSearchDb({ memberships: [] });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello' } } },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });

  it('returns empty when rooms filter excludes all memberships', async () => {
    db = createSearchDb({ memberships: ['!a:example.com'] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'hello',
            filter: { rooms: ['!other:example.com'] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });

  it('returns empty when not_rooms excludes all memberships', async () => {
    db = createSearchDb({ memberships: ['!a:example.com'] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'hello',
            filter: { not_rooms: ['!a:example.com'] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });

  it('returns formatted results with abs rank, highlights, and count', async () => {
    db = createSearchDb({
      memberships: ['!a:example.com'],
      ftsRows: [
        fts({ event_id: '$1', rank: -2.25, origin_server_ts: 2000 }),
        fts({ event_id: '$2', rank: -0.5, origin_server_ts: 1000 }),
      ],
      total: 2,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'Hello World' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.count).toBe(2);
    expect(body.search_categories.room_events.highlights).toEqual(['hello', 'world']);
    expect(body.search_categories.room_events.results).toHaveLength(2);
    // default order: recent DESC
    expect(body.search_categories.room_events.results[0].event_id).toBe('$1');
    expect(body.search_categories.room_events.results[0].rank).toBe(2.25);
    expect(body.search_categories.room_events.results[0].result.content).toEqual({
      body: 'hello world',
      msgtype: 'm.text',
    });
    expect(body.search_categories.room_events.next_batch).toBeUndefined();
  });

  it('uses escaped FTS term in MATCH bind', async () => {
    db = createSearchDb({
      memberships: ['!a:example.com'],
      ftsRows: [fts({ event_id: '$1' })],
    });
    await postSearch(
      { search_categories: { room_events: { search_term: `hi"there` } } },
      db
    );
    const ftsBind = db.bindLog.find((b) => b[0] === 'hi there');
    expect(ftsBind).toBeTruthy();
  });

  it('orders by rank when order_by=rank', async () => {
    db = createSearchDb({
      memberships: ['!a:example.com'],
      ftsRows: [
        fts({ event_id: '$hi', rank: -0.1, origin_server_ts: 9999 }),
        fts({ event_id: '$lo', rank: -5, origin_server_ts: 1 }),
      ],
    });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: { search_term: 'x', order_by: 'rank' },
        },
      },
      db
    );
    expect(body.search_categories.room_events.results.map((r: any) => r.event_id)).toEqual([
      '$lo',
      '$hi',
    ]);
    expect(db.sqlLog.some((s) => s.includes('ORDER BY rank ASC'))).toBe(true);
  });

  it('defaults order_by to recent (timestamp DESC)', async () => {
    db = createSearchDb({
      memberships: ['!a:example.com'],
      ftsRows: [fts({ event_id: '$1' })],
    });
    await postSearch({ search_categories: { room_events: { search_term: 'x' } } }, db);
    expect(db.sqlLog.some((s) => s.includes('ORDER BY e.origin_server_ts DESC'))).toBe(true);
  });

  it('sets next_batch when more than SEARCH_PAGE_LIMIT results', async () => {
    const rows = Array.from({ length: SEARCH_PAGE_LIMIT + 1 }, (_, i) =>
      fts({ event_id: `$${i}`, origin_server_ts: 1000 + i })
    );
    db = createSearchDb({
      memberships: ['!a:example.com'],
      ftsRows: rows,
      total: 100,
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'x' } } },
      db
    );
    expect(body.search_categories.room_events.results).toHaveLength(SEARCH_PAGE_LIMIT);
    expect(body.search_categories.room_events.next_batch).toBe('50');
  });

  it('honors next_batch offset', async () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      fts({ event_id: `$${i}`, origin_server_ts: 1000 + i })
    );
    db = createSearchDb({
      memberships: ['!a:example.com'],
      ftsRows: rows,
      total: 60,
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'x' } } },
      db,
      '?next_batch=50'
    );
    // recent DESC: highest ts first; offset 50 → remaining 10 oldest of the sorted list
    expect(body.search_categories.room_events.results).toHaveLength(10);
    expect(body.search_categories.room_events.next_batch).toBeUndefined();
  });

  it('treats invalid JSON content as empty object', async () => {
    db = createSearchDb({
      memberships: ['!a:example.com'],
      ftsRows: [fts({ event_id: '$1', content: '{not-json' })],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'x' } } },
      db
    );
    expect(body.search_categories.room_events.results[0].result.content).toEqual({});
  });

  it('applies senders filter in SQL', async () => {
    db = createSearchDb({
      memberships: ['!a:example.com'],
      ftsRows: [
        fts({ event_id: '$keep', sender: '@bob:example.com' }),
        fts({ event_id: '$drop', sender: '@eve:example.com' }),
      ],
    });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'x',
            filter: { senders: ['@bob:example.com'] },
          },
        },
      },
      db
    );
    expect(body.search_categories.room_events.results.map((r: any) => r.event_id)).toEqual([
      '$keep',
    ]);
    expect(db.sqlLog.some((s) => s.includes('AND e.sender IN ('))).toBe(true);
  });

  it('applies not_senders filter in SQL', async () => {
    db = createSearchDb({
      memberships: ['!a:example.com'],
      ftsRows: [
        fts({ event_id: '$keep', sender: '@bob:example.com' }),
        fts({ event_id: '$drop', sender: '@eve:example.com' }),
      ],
    });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'x',
            filter: { not_senders: ['@eve:example.com'] },
          },
        },
      },
      db
    );
    expect(body.search_categories.room_events.results.map((r: any) => r.event_id)).toEqual([
      '$keep',
    ]);
  });

  it('applies types / not_types filters', async () => {
    db = createSearchDb({
      memberships: ['!a:example.com'],
      ftsRows: [
        fts({ event_id: '$msg', event_type: 'm.room.message' }),
        fts({ event_id: '$emote', event_type: 'm.room.member' }),
      ],
    });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'x',
            filter: { types: ['m.room.message'], not_types: ['m.room.member'] },
          },
        },
      },
      db
    );
    expect(body.search_categories.room_events.results.map((r: any) => r.event_id)).toEqual([
      '$msg',
    ]);
  });

  it('includes event context (before reversed, after as-is)', async () => {
    const hit = fts({ event_id: '$hit', origin_server_ts: 5000 });
    db = createSearchDb({
      memberships: ['!a:example.com'],
      ftsRows: [hit],
      context: {
        '!a:example.com|before|5000': [
          {
            event_id: '$b2',
            event_type: 'm.room.message',
            sender: '@x:example.com',
            origin_server_ts: 4000,
            content: JSON.stringify({ body: 'b2' }),
          },
          {
            event_id: '$b1',
            event_type: 'm.room.message',
            sender: '@y:example.com',
            origin_server_ts: 3000,
            content: JSON.stringify({ body: 'b1' }),
          },
        ],
        '!a:example.com|after|5000': [
          {
            event_id: '$a1',
            event_type: 'm.room.message',
            sender: '@z:example.com',
            origin_server_ts: 6000,
            content: JSON.stringify({ body: 'a1' }),
          },
        ],
      },
    });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'x',
            event_context: { before_limit: 2, after_limit: 1 },
          },
        },
      },
      db
    );
    const ctx = body.search_categories.room_events.results[0].context;
    // before query returns DESC order [b2, b1]; handler reverses → chronological
    expect(ctx.events_before.map((e: any) => e.event_id)).toEqual(['$b1', '$b2']);
    expect(ctx.events_after.map((e: any) => e.event_id)).toEqual(['$a1']);
    expect(ctx.events_before[0].content).toEqual({ body: 'b1' });
    expect(ctx.events_before[0].room_id).toBe('!a:example.com');
    expect(ctx.profile_info).toBeUndefined();
  });

  it('includes profile_info when include_profile is true', async () => {
    const hit = fts({
      event_id: '$hit',
      sender: '@bob:example.com',
      origin_server_ts: 5000,
    });
    db = createSearchDb({
      memberships: ['!a:example.com'],
      ftsRows: [hit],
      context: {
        '!a:example.com|before|5000': [
          {
            event_id: '$b',
            event_type: 'm.room.message',
            sender: '@carol:example.com',
            origin_server_ts: 4000,
            content: JSON.stringify({ body: 'b' }),
          },
        ],
        '!a:example.com|after|5000': [],
      },
      profiles: {
        '@bob:example.com': { display_name: 'Bob', avatar_url: 'mxc://x/y' },
        '@carol:example.com': { display_name: null, avatar_url: null },
      },
    });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'x',
            event_context: { include_profile: true },
          },
        },
      },
      db
    );
    const profiles = body.search_categories.room_events.results[0].context.profile_info;
    expect(profiles['@bob:example.com']).toEqual({
      displayname: 'Bob',
      avatar_url: 'mxc://x/y',
    });
    // null DB fields → undefined via || undefined
    expect(profiles['@carol:example.com']).toEqual({
      displayname: undefined,
      avatar_url: undefined,
    });
  });

  it('omits missing profiles from profile_info', async () => {
    const hit = fts({ event_id: '$hit', sender: '@ghost:example.com', origin_server_ts: 1 });
    db = createSearchDb({
      memberships: ['!a:example.com'],
      ftsRows: [hit],
      context: {
        '!a:example.com|before|1': [],
        '!a:example.com|after|1': [],
      },
      profiles: {},
    });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'x',
            event_context: { include_profile: true },
          },
        },
      },
      db
    );
    expect(body.search_categories.room_events.results[0].context.profile_info).toEqual({});
  });

  it('includes room state when include_state is true and results exist', async () => {
    db = createSearchDb({
      memberships: ['!a:example.com', '!b:example.com'],
      ftsRows: [
        fts({ event_id: '$1', room_id: '!a:example.com' }),
        fts({ event_id: '$2', room_id: '!b:example.com', origin_server_ts: 900 }),
      ],
      roomState: {
        '!a:example.com': [
          {
            event_type: 'm.room.name',
            state_key: '',
            sender: '@a:example.com',
            content: JSON.stringify({ name: 'A' }),
            origin_server_ts: 1,
          },
        ],
        '!b:example.com': [
          {
            event_type: 'm.room.topic',
            state_key: '',
            sender: '@b:example.com',
            content: JSON.stringify({ topic: 'B' }),
            origin_server_ts: 2,
          },
        ],
      },
    });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: { search_term: 'x', include_state: true },
        },
      },
      db
    );
    const state = body.search_categories.room_events.state;
    expect(state['!a:example.com'][0]).toMatchObject({
      type: 'm.room.name',
      content: { name: 'A' },
      room_id: '!a:example.com',
    });
    expect(state['!b:example.com'][0].content).toEqual({ topic: 'B' });
  });

  it('skips state fetch when include_state but zero results', async () => {
    db = createSearchDb({
      memberships: ['!a:example.com'],
      ftsRows: [],
      total: 0,
    });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: { search_term: 'x', include_state: true },
        },
      },
      db
    );
    expect(body.search_categories.room_events.state).toBeUndefined();
    expect(db.sqlLog.some((s) => s.includes('FROM room_state'))).toBe(false);
  });

  it('adds groups for room_id and sender groupings', async () => {
    db = createSearchDb({
      memberships: ['!a:example.com', '!b:example.com'],
      ftsRows: [
        fts({ event_id: '$1', room_id: '!a:example.com', sender: '@bob:example.com' }),
        fts({
          event_id: '$2',
          room_id: '!b:example.com',
          sender: '@bob:example.com',
          origin_server_ts: 500,
        }),
      ],
    });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'x',
            groupings: { group_by: [{ key: 'room_id' }, { key: 'sender' }] },
          },
        },
      },
      db
    );
    expect(body.search_categories.room_events.groups.room_id['!a:example.com'].results).toEqual([
      '$1',
    ]);
    expect(body.search_categories.room_events.groups.sender['@bob:example.com'].results).toEqual([
      '$1',
      '$2',
    ]);
  });

  it('omits groups when only unknown group_by keys are provided', async () => {
    db = createSearchDb({
      memberships: ['!a:example.com'],
      ftsRows: [fts({ event_id: '$1' })],
    });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'x',
            groupings: { group_by: [{ key: 'content' }] },
          },
        },
      },
      db
    );
    expect(body.search_categories.room_events.groups).toBeUndefined();
  });

  it('uses count 0 when COUNT query returns null', async () => {
    db = createSearchDb({
      memberships: ['!a:example.com'],
      ftsRows: [fts({ event_id: '$1' })],
      total: null,
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'x' } } },
      db
    );
    expect(body.search_categories.room_events.count).toBe(0);
  });

  it('surfaces membership DB errors as HTTP 500 (Hono default)', async () => {
    db = createSearchDb({ throwOnSqlIncludes: 'room_memberships' });
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: JSON.stringify({ search_categories: { room_events: { search_term: 'x' } } }),
      },
      env(db)
    );
    expect(res.status).toBe(500);
  });

  it('surfaces FTS DB errors as HTTP 500 (Hono default)', async () => {
    db = createSearchDb({
      memberships: ['!a:example.com'],
      throwOnSqlIncludes: 'events_fts',
    });
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: JSON.stringify({ search_categories: { room_events: { search_term: 'x' } } }),
      },
      env(db)
    );
    expect(res.status).toBe(500);
  });

  it('binds membership userId from auth context', async () => {
    db = createSearchDb({ memberships: [] });
    await postSearch({ search_categories: { room_events: { search_term: 'x' } } }, db);
    expect(db.bindLog[0][0]).toBe(USER);
  });

  it('intersects rooms filter with memberships before querying FTS', async () => {
    db = createSearchDb({
      memberships: ['!a:example.com', '!b:example.com'],
      ftsRows: [fts({ event_id: '$1', room_id: '!a:example.com' })],
    });
    await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'x',
            filter: { rooms: ['!a:example.com', '!z:example.com'] },
          },
        },
      },
      db
    );
    const ftsSql = db.sqlLog.find((s) => s.includes('bm25(events_fts)'));
    expect(ftsSql).toMatch(/e\.room_id IN \(\?\)/); // single room after intersect
    const ftsBind = db.bindLog.find((b) => b.includes('!a:example.com') && b[0] === 'x');
    expect(ftsBind).toContain('!a:example.com');
    expect(ftsBind).not.toContain('!b:example.com');
  });
});


describe('search TOKENMAXX route leftovers after #94', () => {
  let db: ReturnType<typeof createSearchDb>;

  function fts(partial: Partial<FtsRow> & Pick<FtsRow, 'event_id'>): FtsRow {
    return {
      event_id: partial.event_id,
      event_type: partial.event_type ?? 'm.room.message',
      room_id: partial.room_id ?? '!a:example.com',
      sender: partial.sender ?? '@bob:example.com',
      origin_server_ts: partial.origin_server_ts ?? 1000,
      content: partial.content ?? JSON.stringify({ body: 'hello world' }),
      rank: partial.rank ?? 0.5,
    };
  }

  async function postSearch(
    body: unknown,
    database: ReturnType<typeof createSearchDb>,
    path = '/_matrix/client/v3/search'
  ) {
    const res = await search.request(
      `http://localhost${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: JSON.stringify(body),
      },
      env(database)
    );
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }

  it('does not short-circuit when escaped FTS term becomes empty (""")', async () => {
    db = createSearchDb({
      memberships: ['!a:example.com'],
      ftsRows: [fts({ event_id: '$1' })],
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: '"""' } } },
      db
    );
    expect(status).toBe(200);
    // Membership bind is first; FTS MATCH bind uses escaped term as args[0]
    const ftsBind = db.bindLog.find(
      (b) => b.length >= 3 && b.includes('!a:example.com') && typeof b[0] === 'string'
    );
    expect(ftsBind?.[0]).toBe('');
    expect(body.search_categories.room_events).toBeTruthy();
  });

  it('binds NaN OFFSET for non-numeric next_batch', async () => {
    db = createSearchDb({
      memberships: ['!a:example.com'],
      ftsRows: [fts({ event_id: '$1' })],
    });
    const { status } = await postSearch(
      { search_categories: { room_events: { search_term: 'x' } } },
      db,
      '/_matrix/client/v3/search?next_batch=nope'
    );
    expect(status).toBe(200);
    const ftsBind = db.bindLog.find((b) => b.includes('x') || b[0] === 'x');
    expect(Number.isNaN(ftsBind?.[ftsBind.length - 1] as number)).toBe(true);
  });

  it('skips empty senders/types filter arrays in SQL', async () => {
    db = createSearchDb({
      memberships: ['!a:example.com'],
      ftsRows: [fts({ event_id: '$1' })],
    });
    await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'x',
            filter: { senders: [], not_senders: [], types: [], not_types: [] },
          },
        },
      },
      db
    );
    const ftsSql = db.sqlLog.find((s) => s.includes('bm25(events_fts)'));
    expect(ftsSql).not.toMatch(/AND e\.sender IN/);
    expect(ftsSql).not.toMatch(/AND e\.sender NOT IN/);
    expect(ftsSql).not.toMatch(/AND e\.event_type IN/);
    expect(ftsSql).not.toMatch(/AND e\.event_type NOT IN/);
  });

  it('surfaces context JSON.parse failures as HTTP 500', async () => {
    db = createSearchDb({
      memberships: ['!a:example.com'],
      ftsRows: [fts({ event_id: '$1', origin_server_ts: 1000 })],
      context: {
        '!a:example.com|before|1000': [
          {
            event_id: '$c',
            event_type: 'm.room.message',
            sender: '@bob:example.com',
            origin_server_ts: 900,
            content: '{bad',
          },
        ],
      },
    });
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: JSON.stringify({
          search_categories: {
            room_events: {
              search_term: 'x',
              event_context: { before_limit: 1, after_limit: 0 },
            },
          },
        }),
      },
      env(db)
    );
    expect(res.status).toBe(500);
  });

  it('omits groups when group_by is empty array', async () => {
    db = createSearchDb({
      memberships: ['!a:example.com'],
      ftsRows: [fts({ event_id: '$1' })],
    });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'x',
            groupings: { group_by: [] },
          },
        },
      },
      db
    );
    expect(body.search_categories.room_events.groups).toBeUndefined();
  });

  it('paginates with next_batch=50 when 51 rows exist', async () => {
    const rows = Array.from({ length: 51 }, (_, i) =>
      fts({ event_id: `$${i}`, origin_server_ts: 2000 - i })
    );
    db = createSearchDb({ memberships: ['!a:example.com'], ftsRows: rows, total: 51 });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'x' } } },
      db,
      '/_matrix/client/v3/search?next_batch=50'
    );
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.next_batch).toBeUndefined();
  });

  it('formatSearchRank maps NaN to 0 and keeps Infinity', () => {
    expect(formatSearchRank(Number.NaN)).toBe(0);
    expect(formatSearchRank(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });
});
