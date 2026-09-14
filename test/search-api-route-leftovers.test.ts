/**
 * TOKENMAXX HEAVY leftovers after #157 — search API route soft/edge/reliability.
 * Complements search-helpers.test.ts. Tests-only — no product inventing.
 * Fixtures use example.com only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
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

import search, {
  SEARCH_PAGE_LIMIT,
  emptyRoomEventsSearchResponse,
} from '../src/api/search';

const USER = '@alice:example.com';
const ROOM_A = '!a:example.com';
const ROOM_B = '!b:example.com';
const ROOM_C = '!c:example.com';
const SERVER = 'example.com';
const PATH = '/_matrix/client/v3/search';

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
  context?: Record<string, CtxRow[]>;
  profiles?: Record<string, ProfileRow | null>;
  roomState?: Record<string, StateRow[]>;
  throwOnSqlIncludes?: string;
};

function createSearchDb(
  opts: SearchDbOpts = {}
): D1Database & { sqlLog: string[]; bindLog: unknown[][] } {
  const memberships = opts.memberships ?? [ROOM_A, ROOM_B];
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
                return {
                  results: memberships.map((room_id) => ({ room_id })),
                } as { results: T[] };
              }
              if (sql.includes('FROM events_fts') || sql.includes('bm25(events_fts)')) {
                const limit = Number(args[args.length - 2] ?? 51);
                const offset = Number(args[args.length - 1] ?? 0);
                let rows = ftsRows.slice();

                if (sql.includes('AND e.sender IN (')) {
                  const senderInMatch = sql.match(/AND e\.sender IN \(([^)]+)\)/);
                  if (senderInMatch) {
                    const placeholderCount = (senderInMatch[1].match(/\?/g) || []).length;
                    const roomCount = (
                      sql.match(/e\.room_id IN \(([^)]+)\)/)?.[1].match(/\?/g) || []
                    ).length;
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
                    const roomCount = (
                      sql.match(/e\.room_id IN \(([^)]+)\)/)?.[1].match(/\?/g) || []
                    ).length;
                    let cursor = 1 + roomCount;
                    if (sql.includes('AND e.sender IN (')) {
                      const inCount = (
                        sql.match(/AND e\.sender IN \(([^)]+)\)/)?.[1].match(/\?/g) || []
                      ).length;
                      cursor += inCount;
                    }
                    const filterSenders = args.slice(cursor, cursor + placeholderCount) as string[];
                    rows = rows.filter((r) => !filterSenders.includes(r.sender));
                  }
                }
                if (sql.includes('AND e.event_type IN (')) {
                  const typeMatch = sql.match(/AND e\.event_type IN \(([^)]+)\)/);
                  if (typeMatch) {
                    const placeholderCount = (typeMatch[1].match(/\?/g) || []).length;
                    let end = args.length - 2;
                    if (sql.includes('AND e.event_type NOT IN (')) {
                      const notCount = (
                        sql.match(/AND e\.event_type NOT IN \(([^)]+)\)/)?.[1].match(/\?/g) ||
                        []
                      ).length;
                      end -= notCount;
                    }
                    const filterTypes = args.slice(end - placeholderCount, end) as string[];
                    rows = rows.filter((r) => filterTypes.includes(r.event_type));
                  }
                }
                if (sql.includes('AND e.event_type NOT IN (')) {
                  const notMatch = sql.match(/AND e\.event_type NOT IN \(([^)]+)\)/);
                  if (notMatch) {
                    const placeholderCount = (notMatch[1].match(/\?/g) || []).length;
                    const filterTypes = args.slice(
                      args.length - 2 - placeholderCount,
                      args.length - 2
                    ) as string[];
                    rows = rows.filter((r) => !filterTypes.includes(r.event_type));
                  }
                }

                if (sql.includes('ORDER BY rank ASC')) {
                  rows.sort((a, b) => a.rank - b.rank);
                } else {
                  rows.sort((a, b) => b.origin_server_ts - a.origin_server_ts);
                }

                const off = Number.isNaN(offset) ? 0 : offset;
                return { results: rows.slice(off, off + limit) as T[] };
              }
              if (sql.includes('FROM events') && sql.includes('origin_server_ts <')) {
                const roomId = args[0] as string;
                const ts = args[1] as number;
                const key = `${roomId}|before|${ts}`;
                return { results: (context[key] ?? []).slice() } as { results: T[] };
              }
              if (sql.includes('FROM events') && sql.includes('origin_server_ts >')) {
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
    SERVER_NAME: SERVER,
    DB: db,
  } as Env;
}

async function postSearch(
  body: unknown,
  db: D1Database,
  query = '',
  contentType = 'application/json'
): Promise<{ status: number; body: any }> {
  const res = await search.request(
    `http://localhost${PATH}${query}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        Authorization: 'Bearer t',
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    env(db)
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

function fts(partial: Partial<FtsRow> & Pick<FtsRow, 'event_id'>): FtsRow {
  return {
    event_type: 'm.room.message',
    room_id: ROOM_A,
    sender: '@bob:example.com',
    origin_server_ts: 1000,
    content: JSON.stringify({ body: 'hello world', msgtype: 'm.text' }),
    rank: -1.5,
    ...partial,
  };
}

function roomEventsBody(
  searchTerm: string,
  extra: Record<string, unknown> = {}
): { search_categories: { room_events: Record<string, unknown> } } {
  return {
    search_categories: {
      room_events: { search_term: searchTerm, ...extra },
    },
  };
}

function nameState(name: string): StateRow[] {
  return [
    {
      event_type: 'm.room.name',
      state_key: '',
      sender: '@alice:example.com',
      content: JSON.stringify({ name }),
      origin_server_ts: 100,
    },
  ];
}

function topicState(topic: string): StateRow[] {
  return [
    {
      event_type: 'm.room.topic',
      state_key: '',
      sender: '@alice:example.com',
      content: JSON.stringify({ topic }),
      origin_server_ts: 50,
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
});

void USER;
void SEARCH_PAGE_LIMIT;
void ROOM_C;

describe('search leftovers empty search soft flood after #157', () => {
  it('empty search soft-0', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody(''), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty search soft-1', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody('   '), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty search soft-2', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody('\t'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty search soft-3', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody('\n'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty search soft-4', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody('  \t  '), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty search soft-5', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody(' '), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty search soft-6', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody(' \n '), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty search soft-7', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody('\r'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty search soft-8', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody('\r\n'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty search soft-9', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody('  \n  '), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty search soft-10', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody(''), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty search soft-11', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody('   '), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty search soft-12', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody('\t'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty search soft-13', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody('\n'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty search soft-14', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody('  \t  '), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty search soft-15', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody(' '), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty search soft-16', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody(' \n '), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty search soft-17', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody('\r'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty search soft-18', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody('\r\n'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty search soft-19', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody('  \n  '), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty search soft-20', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody(''), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty search soft-21', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody('   '), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty search soft-22', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody('\t'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty search soft-23', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody('\n'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty search soft-24', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(roomEventsBody('  \t  '), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
});

describe('search leftovers room_events search_term soft flood after #157', () => {
  it('room_events search_term soft-0', async () => {
    const term = "hello";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term0:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1000 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term0:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
  it('room_events search_term soft-1', async () => {
    const term = "world";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term1:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1001 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term1:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
  it('room_events search_term soft-2', async () => {
    const term = "Hello World";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term2:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1002 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term2:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
  it('room_events search_term soft-3', async () => {
    const term = "matrix";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term3:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1003 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term3:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
  it('room_events search_term soft-4', async () => {
    const term = "alice";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term4:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1004 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term4:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
  it('room_events search_term soft-5', async () => {
    const term = "bob";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term5:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1005 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term5:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
  it('room_events search_term soft-6', async () => {
    const term = "test-term";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term6:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1006 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term6:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
  it('room_events search_term soft-7', async () => {
    const term = "foo_bar";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term7:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1007 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term7:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
  it('room_events search_term soft-8', async () => {
    const term = "café";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term8:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1008 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term8:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
  it('room_events search_term soft-9', async () => {
    const term = "emoji🎉";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term9:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1009 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term9:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
  it('room_events search_term soft-10', async () => {
    const term = "a";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term10:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1010 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term10:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
  it('room_events search_term soft-11', async () => {
    const term = "ab";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term11:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1011 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term11:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
  it('room_events search_term soft-12', async () => {
    const term = "one two three";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term12:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1012 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term12:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
  it('room_events search_term soft-13', async () => {
    const term = "quoted\"term";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term13:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1013 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term13:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
  it('room_events search_term soft-14', async () => {
    const term = "apostrophe's";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term14:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1014 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term14:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
  it('room_events search_term soft-15', async () => {
    const term = "star*fish";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term15:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1015 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term15:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
  it('room_events search_term soft-16', async () => {
    const term = "paren(s)";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term16:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1016 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term16:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
  it('room_events search_term soft-17', async () => {
    const term = "plus+plus";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term17:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1017 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term17:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
  it('room_events search_term soft-18', async () => {
    const term = "hash#tag";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term18:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1018 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term18:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
  it('room_events search_term soft-19', async () => {
    const term = "slash/path";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term19:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1019 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term19:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
  it('room_events search_term soft-20', async () => {
    const term = "dot.dot";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term20:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1020 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term20:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
  it('room_events search_term soft-21', async () => {
    const term = "under_score";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term21:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1021 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term21:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
  it('room_events search_term soft-22', async () => {
    const term = "UPPER";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term22:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1022 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term22:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
  it('room_events search_term soft-23', async () => {
    const term = "MiXeD";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term23:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1023 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term23:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
  it('room_events search_term soft-24', async () => {
    const term = "12345";
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$term24:example.com`, content: JSON.stringify({ body: term, msgtype: 'm.text' }), origin_server_ts: 1024 })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody(term), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe(`$term24:example.com`);
    expect(body.search_categories.room_events.count).toBe(1);
    expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
  });
});

describe('search leftovers include_state soft flood after #157', () => {
  it('include_state soft-0', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st0:example.com`, origin_server_ts: 2000 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-0') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-0', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-0' });
  });
  it('include_state soft-1', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st1:example.com`, origin_server_ts: 2001 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-1') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-1', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-1' });
  });
  it('include_state soft-2', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st2:example.com`, origin_server_ts: 2002 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-2') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-2', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-2' });
  });
  it('include_state soft-3', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st3:example.com`, origin_server_ts: 2003 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-3') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-3', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-3' });
  });
  it('include_state soft-4', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st4:example.com`, origin_server_ts: 2004 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-4') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-4', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-4' });
  });
  it('include_state soft-5', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st5:example.com`, origin_server_ts: 2005 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-5') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-5', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-5' });
  });
  it('include_state soft-6', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st6:example.com`, origin_server_ts: 2006 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-6') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-6', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-6' });
  });
  it('include_state soft-7', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st7:example.com`, origin_server_ts: 2007 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-7') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-7', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-7' });
  });
  it('include_state soft-8', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st8:example.com`, origin_server_ts: 2008 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-8') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-8', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-8' });
  });
  it('include_state soft-9', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st9:example.com`, origin_server_ts: 2009 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-9') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-9', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-9' });
  });
  it('include_state soft-10', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st10:example.com`, origin_server_ts: 2010 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-10') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-10', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-10' });
  });
  it('include_state soft-11', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st11:example.com`, origin_server_ts: 2011 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-11') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-11', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-11' });
  });
  it('include_state soft-12', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st12:example.com`, origin_server_ts: 2012 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-12') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-12', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-12' });
  });
  it('include_state soft-13', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st13:example.com`, origin_server_ts: 2013 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-13') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-13', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-13' });
  });
  it('include_state soft-14', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st14:example.com`, origin_server_ts: 2014 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-14') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-14', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-14' });
  });
  it('include_state soft-15', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st15:example.com`, origin_server_ts: 2015 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-15') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-15', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-15' });
  });
  it('include_state soft-16', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st16:example.com`, origin_server_ts: 2016 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-16') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-16', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-16' });
  });
  it('include_state soft-17', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st17:example.com`, origin_server_ts: 2017 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-17') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-17', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-17' });
  });
  it('include_state soft-18', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st18:example.com`, origin_server_ts: 2018 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-18') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-18', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-18' });
  });
  it('include_state soft-19', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st19:example.com`, origin_server_ts: 2019 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-19') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-19', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-19' });
  });
  it('include_state soft-20', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st20:example.com`, origin_server_ts: 2020 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-20') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-20', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-20' });
  });
  it('include_state soft-21', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st21:example.com`, origin_server_ts: 2021 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-21') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-21', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-21' });
  });
  it('include_state soft-22', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st22:example.com`, origin_server_ts: 2022 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-22') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-22', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-22' });
  });
  it('include_state soft-23', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st23:example.com`, origin_server_ts: 2023 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-23') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-23', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-23' });
  });
  it('include_state soft-24', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$st24:example.com`, origin_server_ts: 2024 })],
      total: 1,
      roomState: { [ROOM_A]: nameState('Room-24') },
    });
    const { status, body } = await postSearch(roomEventsBody('state-24', { include_state: true }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
    expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ name: 'Room-24' });
  });
});

describe('search leftovers keys soft flood after #157', () => {
  // keys is accepted on the request type but unused by the handler — still 200.
  it('keys soft-0', async () => {
    const keys = ['content.body'];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k0:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-0', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('keys soft-1', async () => {
    const keys = ['content.body', 'content.topic'];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k1:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-1', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('keys soft-2', async () => {
    const keys = ['content.name'];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k2:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-2', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('keys soft-3', async () => {
    const keys = [];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k3:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-3', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('keys soft-4', async () => {
    const keys = ['content.body', 'content.name', 'content.topic'];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k4:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-4', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('keys soft-5', async () => {
    const keys = ['content.body'];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k5:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-5', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('keys soft-6', async () => {
    const keys = ['content.body', 'content.topic'];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k6:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-6', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('keys soft-7', async () => {
    const keys = ['content.name'];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k7:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-7', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('keys soft-8', async () => {
    const keys = [];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k8:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-8', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('keys soft-9', async () => {
    const keys = ['content.body', 'content.name', 'content.topic'];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k9:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-9', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('keys soft-10', async () => {
    const keys = ['content.body'];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k10:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-10', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('keys soft-11', async () => {
    const keys = ['content.body', 'content.topic'];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k11:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-11', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('keys soft-12', async () => {
    const keys = ['content.name'];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k12:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-12', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('keys soft-13', async () => {
    const keys = [];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k13:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-13', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('keys soft-14', async () => {
    const keys = ['content.body', 'content.name', 'content.topic'];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k14:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-14', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('keys soft-15', async () => {
    const keys = ['content.body'];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k15:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-15', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('keys soft-16', async () => {
    const keys = ['content.body', 'content.topic'];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k16:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-16', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('keys soft-17', async () => {
    const keys = ['content.name'];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k17:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-17', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('keys soft-18', async () => {
    const keys = [];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k18:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-18', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('keys soft-19', async () => {
    const keys = ['content.body', 'content.name', 'content.topic'];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k19:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-19', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('keys soft-20', async () => {
    const keys = ['content.body'];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k20:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-20', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('keys soft-21', async () => {
    const keys = ['content.body', 'content.topic'];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k21:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-21', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('keys soft-22', async () => {
    const keys = ['content.name'];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k22:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-22', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('keys soft-23', async () => {
    const keys = [];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k23:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-23', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('keys soft-24', async () => {
    const keys = ['content.body', 'content.name', 'content.topic'];
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$k24:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('keys-24', { keys }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
});

describe('search leftovers filter room/sender soft flood after #157', () => {
  it('filter room/sender soft-0', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa0:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb0:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { rooms: [ROOM_A] };
    const { status, body } = await postSearch(roomEventsBody('filter-0', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
  it('filter room/sender soft-1', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa1:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb1:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { not_rooms: [ROOM_B] };
    const { status, body } = await postSearch(roomEventsBody('filter-1', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
  it('filter room/sender soft-2', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa2:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb2:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { senders: ['@bob:example.com'] };
    const { status, body } = await postSearch(roomEventsBody('filter-2', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
  it('filter room/sender soft-3', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa3:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb3:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { not_senders: ['@carol:example.com'] };
    const { status, body } = await postSearch(roomEventsBody('filter-3', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
  it('filter room/sender soft-4', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa4:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb4:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { types: ['m.room.message'] };
    const { status, body } = await postSearch(roomEventsBody('filter-4', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
  it('filter room/sender soft-5', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa5:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb5:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { rooms: [ROOM_A, ROOM_B] };
    const { status, body } = await postSearch(roomEventsBody('filter-5', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
  it('filter room/sender soft-6', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa6:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb6:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { senders: ['@bob:example.com', '@carol:example.com'] };
    const { status, body } = await postSearch(roomEventsBody('filter-6', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
  it('filter room/sender soft-7', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa7:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb7:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { not_types: ['m.room.member'] };
    const { status, body } = await postSearch(roomEventsBody('filter-7', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
  it('filter room/sender soft-8', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa8:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb8:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { rooms: [ROOM_A], senders: ["@bob:example.com"] };
    const { status, body } = await postSearch(roomEventsBody('filter-8', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
  it('filter room/sender soft-9', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa9:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb9:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { not_rooms: [ROOM_C] };
    const { status, body } = await postSearch(roomEventsBody('filter-9', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
  it('filter room/sender soft-10', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa10:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb10:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { rooms: [ROOM_A] };
    const { status, body } = await postSearch(roomEventsBody('filter-10', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
  it('filter room/sender soft-11', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa11:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb11:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { not_rooms: [ROOM_B] };
    const { status, body } = await postSearch(roomEventsBody('filter-11', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
  it('filter room/sender soft-12', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa12:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb12:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { senders: ['@bob:example.com'] };
    const { status, body } = await postSearch(roomEventsBody('filter-12', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
  it('filter room/sender soft-13', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa13:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb13:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { not_senders: ['@carol:example.com'] };
    const { status, body } = await postSearch(roomEventsBody('filter-13', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
  it('filter room/sender soft-14', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa14:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb14:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { types: ['m.room.message'] };
    const { status, body } = await postSearch(roomEventsBody('filter-14', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
  it('filter room/sender soft-15', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa15:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb15:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { rooms: [ROOM_A, ROOM_B] };
    const { status, body } = await postSearch(roomEventsBody('filter-15', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
  it('filter room/sender soft-16', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa16:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb16:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { senders: ['@bob:example.com', '@carol:example.com'] };
    const { status, body } = await postSearch(roomEventsBody('filter-16', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
  it('filter room/sender soft-17', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa17:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb17:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { not_types: ['m.room.member'] };
    const { status, body } = await postSearch(roomEventsBody('filter-17', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
  it('filter room/sender soft-18', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa18:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb18:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { rooms: [ROOM_A], senders: ["@bob:example.com"] };
    const { status, body } = await postSearch(roomEventsBody('filter-18', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
  it('filter room/sender soft-19', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa19:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb19:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { not_rooms: [ROOM_C] };
    const { status, body } = await postSearch(roomEventsBody('filter-19', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
  it('filter room/sender soft-20', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa20:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb20:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { rooms: [ROOM_A] };
    const { status, body } = await postSearch(roomEventsBody('filter-20', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
  it('filter room/sender soft-21', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa21:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb21:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { not_rooms: [ROOM_B] };
    const { status, body } = await postSearch(roomEventsBody('filter-21', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
  it('filter room/sender soft-22', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa22:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb22:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { senders: ['@bob:example.com'] };
    const { status, body } = await postSearch(roomEventsBody('filter-22', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
  it('filter room/sender soft-23', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa23:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb23:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { not_senders: ['@carol:example.com'] };
    const { status, body } = await postSearch(roomEventsBody('filter-23', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
  it('filter room/sender soft-24', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: `$fa24:example.com`, room_id: ROOM_A, sender: '@bob:example.com' }),
        fts({ event_id: `$fb24:example.com`, room_id: ROOM_B, sender: '@carol:example.com', origin_server_ts: 2000 }),
      ],
      total: 2,
    });
    const filter = { types: ['m.room.message'] };
    const { status, body } = await postSearch(roomEventsBody('filter-24', { filter }), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
  });
});

describe('search leftovers pagination soft flood after #157', () => {
  it('pagination soft-0', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg0-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-0'),
      db,
      "?next_batch="
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
  it('pagination soft-1', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg1-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-1'),
      db,
      "?next_batch=0"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
  it('pagination soft-2', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg2-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-2'),
      db,
      "?next_batch=1"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
  it('pagination soft-3', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg3-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-3'),
      db,
      "?next_batch=10"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
  it('pagination soft-4', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg4-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-4'),
      db,
      "?next_batch=25"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
  it('pagination soft-5', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg5-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-5'),
      db,
      "?next_batch=49"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
  it('pagination soft-6', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg6-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-6'),
      db,
      "?next_batch=50"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
  it('pagination soft-7', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg7-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-7'),
      db,
      "?next_batch=51"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
  it('pagination soft-8', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg8-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-8'),
      db,
      "?next_batch=100"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
  it('pagination soft-9', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg9-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-9'),
      db,
      "?next_batch=abc"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
  it('pagination soft-10', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg10-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-10'),
      db,
      "?next_batch=-1"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
  it('pagination soft-11', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg11-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-11'),
      db,
      "?next_batch=1.5"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
  it('pagination soft-12', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg12-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-12'),
      db,
      "?next_batch=00"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
  it('pagination soft-13', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg13-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-13'),
      db,
      "?next_batch=000"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
  it('pagination soft-14', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg14-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-14'),
      db,
      "?next_batch=NaN"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
  it('pagination soft-15', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg15-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-15'),
      db,
      "?next_batch=true"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
  it('pagination soft-16', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg16-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-16'),
      db,
      "?next_batch=%20"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
  it('pagination soft-17', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg17-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-17'),
      db,
      "?next_batch=%2B10"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
  it('pagination soft-18', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg18-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-18'),
      db,
      "?next_batch=0x10"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
  it('pagination soft-19', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg19-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-19'),
      db,
      "?next_batch=1e2"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
  it('pagination soft-20', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg20-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-20'),
      db,
      "?next_batch=999"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
  it('pagination soft-21', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg21-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-21'),
      db,
      "?next_batch=2"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
  it('pagination soft-22', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg22-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-22'),
      db,
      "?next_batch=3"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
  it('pagination soft-23', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg23-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-23'),
      db,
      "?next_batch=4"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
  it('pagination soft-24', async () => {
    const rows = Array.from({ length: 5 }, (_, j) =>
      fts({ event_id: `$pg24-${j}:example.com`, origin_server_ts: 5000 - j, rank: -1 - j * 0.1 })
    );
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: rows, total: 5 });
    const { status, body } = await postSearch(
      roomEventsBody('page-24'),
      db,
      "?next_batch=5"
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.search_categories.room_events.results)).toBe(true);
    expect(body.search_categories.room_events.count).toBe(5);
  });
});

describe('search leftovers charset soft flood after #157', () => {
  it('charset soft-0', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct0:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-0'), db, '', "application/json");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('charset soft-1', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct1:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-1'), db, '', "application/json; charset=utf-8");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('charset soft-2', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct2:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-2'), db, '', "application/json;charset=UTF-8");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('charset soft-3', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct3:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-3'), db, '', "application/json; charset=UTF-8");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('charset soft-4', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct4:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-4'), db, '', "application/json; charset=\"utf-8\"");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('charset soft-5', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct5:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-5'), db, '', "application/json");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('charset soft-6', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct6:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-6'), db, '', "application/json; charset=utf-8");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('charset soft-7', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct7:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-7'), db, '', "application/json;charset=UTF-8");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('charset soft-8', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct8:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-8'), db, '', "application/json; charset=UTF-8");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('charset soft-9', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct9:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-9'), db, '', "application/json; charset=\"utf-8\"");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('charset soft-10', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct10:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-10'), db, '', "application/json");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('charset soft-11', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct11:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-11'), db, '', "application/json; charset=utf-8");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('charset soft-12', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct12:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-12'), db, '', "application/json;charset=UTF-8");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('charset soft-13', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct13:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-13'), db, '', "application/json; charset=UTF-8");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('charset soft-14', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct14:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-14'), db, '', "application/json; charset=\"utf-8\"");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('charset soft-15', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct15:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-15'), db, '', "application/json");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('charset soft-16', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct16:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-16'), db, '', "application/json; charset=utf-8");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('charset soft-17', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct17:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-17'), db, '', "application/json;charset=UTF-8");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('charset soft-18', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct18:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-18'), db, '', "application/json; charset=UTF-8");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('charset soft-19', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct19:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-19'), db, '', "application/json; charset=\"utf-8\"");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('charset soft-20', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct20:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-20'), db, '', "application/json");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('charset soft-21', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct21:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-21'), db, '', "application/json; charset=utf-8");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('charset soft-22', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct22:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-22'), db, '', "application/json;charset=UTF-8");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('charset soft-23', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct23:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-23'), db, '', "application/json; charset=UTF-8");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('charset soft-24', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$ct24:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('ct-24'), db, '', "application/json; charset=\"utf-8\"");
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
});

describe('search leftovers method matrix after #157', () => {
  it('method matrix soft-0 GET', async () => {
    const db = createSearchDb();
    const res = await search.request(`http://localhost${PATH}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: undefined,
    }, env(db));
    expect([404, 405]).toContain(res.status);
  });
  it('method matrix soft-1 PUT', async () => {
    const db = createSearchDb();
    const res = await search.request(`http://localhost${PATH}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    }, env(db));
    expect([404, 405]).toContain(res.status);
  });
  it('method matrix soft-2 DELETE', async () => {
    const db = createSearchDb();
    const res = await search.request(`http://localhost${PATH}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: undefined,
    }, env(db));
    expect([404, 405]).toContain(res.status);
  });
  it('method matrix soft-3 PATCH', async () => {
    const db = createSearchDb();
    const res = await search.request(`http://localhost${PATH}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{}',
    }, env(db));
    expect([404, 405]).toContain(res.status);
  });
  it('method matrix soft-4 HEAD', async () => {
    const db = createSearchDb();
    const res = await search.request(`http://localhost${PATH}`, {
      method: 'HEAD',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: undefined,
    }, env(db));
    expect([404, 405]).toContain(res.status);
  });
  it('method matrix soft-5 OPTIONS', async () => {
    const db = createSearchDb();
    const res = await search.request(`http://localhost${PATH}`, {
      method: 'OPTIONS',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: undefined,
    }, env(db));
    expect([404, 405]).toContain(res.status);
  });
  it('method matrix soft-6 POST ok', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$mm0:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('mm-0'), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('method matrix soft-7 POST ok', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$mm1:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('mm-1'), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('method matrix soft-8 POST ok', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$mm2:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('mm-2'), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
  it('method matrix soft-9 POST ok', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$mm3:example.com` })],
      total: 1,
    });
    const { status, body } = await postSearch(roomEventsBody('mm-3'), db);
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
  });
});

describe('search leftovers bad JSON failure soft flood after #157', () => {
  it('bad JSON soft-0', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('{', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad JSON soft-1', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('{]', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad JSON soft-2', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad JSON soft-3', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('not-json', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad JSON soft-4', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('{broken', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad JSON soft-5', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('[,]', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad JSON soft-6', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('{"search_categories"', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad JSON soft-7', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('undefined', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad JSON soft-8', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('NaN', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad JSON soft-9', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('{ok:', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad JSON soft-10', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('{true}', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad JSON soft-11', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('{null}', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad JSON soft-12', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('[', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad JSON soft-13', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('123,', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad JSON soft-14', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('"str', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad JSON soft-15', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('{,}', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad JSON soft-16', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('{{}', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad JSON soft-17', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('}}', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad JSON soft-18', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('<!--', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad JSON soft-19', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('<?xml', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad JSON soft-20', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('\0', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad JSON soft-21', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('\ufffd', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad JSON soft-22', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('{a:1}', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad JSON soft-23', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('[1,2,', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad JSON soft-24', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch('{][', db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
});

describe('search leftovers missing categories soft flood after #157', () => {
  it('missing search_categories soft-0', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({}, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('missing search_categories soft-1', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('missing search_categories soft-2', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({ search_categories: { room_events: undefined } }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('missing search_categories soft-3', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({ other: 1 }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('missing search_categories soft-4', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({ search_categories: { something_else: {} } }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('missing search_categories soft-5', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({ search_categories: null }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('missing search_categories soft-6', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({ search_categories: { room_events: null } }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('missing search_categories soft-7', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({ search_categories: [] }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('missing search_categories soft-8', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({ foo: "bar" }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('missing search_categories soft-9', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({ search_categories: { media: {} } }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('missing search_categories soft-10', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({}, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('missing search_categories soft-11', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('missing search_categories soft-12', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({ search_categories: { room_events: undefined } }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('missing search_categories soft-13', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({ other: 1 }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('missing search_categories soft-14', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({ search_categories: { something_else: {} } }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('missing search_categories soft-15', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({ search_categories: null }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('missing search_categories soft-16', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({ search_categories: { room_events: null } }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('missing search_categories soft-17', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({ search_categories: [] }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('missing search_categories soft-18', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({ foo: "bar" }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('missing search_categories soft-19', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({ search_categories: { media: {} } }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('missing search_categories soft-20', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({}, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('missing search_categories soft-21', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('missing search_categories soft-22', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({ search_categories: { room_events: undefined } }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('missing search_categories soft-23', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({ other: 1 }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('missing search_categories soft-24', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch({ search_categories: { something_else: {} } }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
});

describe('search leftovers no-membership soft flood after #157', () => {
  it('no memberships soft-0', async () => {
    const db = createSearchDb({ memberships: [] });
    const { status, body } = await postSearch(roomEventsBody('nm-0'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('no memberships soft-1', async () => {
    const db = createSearchDb({ memberships: [] });
    const { status, body } = await postSearch(roomEventsBody('nm-1'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('no memberships soft-2', async () => {
    const db = createSearchDb({ memberships: [] });
    const { status, body } = await postSearch(roomEventsBody('nm-2'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('no memberships soft-3', async () => {
    const db = createSearchDb({ memberships: [] });
    const { status, body } = await postSearch(roomEventsBody('nm-3'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('no memberships soft-4', async () => {
    const db = createSearchDb({ memberships: [] });
    const { status, body } = await postSearch(roomEventsBody('nm-4'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('no memberships soft-5', async () => {
    const db = createSearchDb({ memberships: [] });
    const { status, body } = await postSearch(roomEventsBody('nm-5'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('no memberships soft-6', async () => {
    const db = createSearchDb({ memberships: [] });
    const { status, body } = await postSearch(roomEventsBody('nm-6'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('no memberships soft-7', async () => {
    const db = createSearchDb({ memberships: [] });
    const { status, body } = await postSearch(roomEventsBody('nm-7'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('no memberships soft-8', async () => {
    const db = createSearchDb({ memberships: [] });
    const { status, body } = await postSearch(roomEventsBody('nm-8'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('no memberships soft-9', async () => {
    const db = createSearchDb({ memberships: [] });
    const { status, body } = await postSearch(roomEventsBody('nm-9'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('no memberships soft-10', async () => {
    const db = createSearchDb({ memberships: [] });
    const { status, body } = await postSearch(roomEventsBody('nm-10'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('no memberships soft-11', async () => {
    const db = createSearchDb({ memberships: [] });
    const { status, body } = await postSearch(roomEventsBody('nm-11'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('no memberships soft-12', async () => {
    const db = createSearchDb({ memberships: [] });
    const { status, body } = await postSearch(roomEventsBody('nm-12'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('no memberships soft-13', async () => {
    const db = createSearchDb({ memberships: [] });
    const { status, body } = await postSearch(roomEventsBody('nm-13'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('no memberships soft-14', async () => {
    const db = createSearchDb({ memberships: [] });
    const { status, body } = await postSearch(roomEventsBody('nm-14'), db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
});

describe('search leftovers lifecycle soft flood after #157', () => {
  it('empty→hit→include_state lifecycle soft-0', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-0'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc0:example.com`, origin_server_ts: 3000 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-0') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-0'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-0', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-0' });
  });
  it('empty→hit→include_state lifecycle soft-1', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-1'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc1:example.com`, origin_server_ts: 3001 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-1') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-1'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-1', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-1' });
  });
  it('empty→hit→include_state lifecycle soft-2', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-2'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc2:example.com`, origin_server_ts: 3002 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-2') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-2'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-2', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-2' });
  });
  it('empty→hit→include_state lifecycle soft-3', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-3'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc3:example.com`, origin_server_ts: 3003 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-3') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-3'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-3', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-3' });
  });
  it('empty→hit→include_state lifecycle soft-4', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-4'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc4:example.com`, origin_server_ts: 3004 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-4') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-4'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-4', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-4' });
  });
  it('empty→hit→include_state lifecycle soft-5', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-5'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc5:example.com`, origin_server_ts: 3005 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-5') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-5'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-5', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-5' });
  });
  it('empty→hit→include_state lifecycle soft-6', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-6'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc6:example.com`, origin_server_ts: 3006 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-6') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-6'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-6', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-6' });
  });
  it('empty→hit→include_state lifecycle soft-7', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-7'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc7:example.com`, origin_server_ts: 3007 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-7') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-7'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-7', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-7' });
  });
  it('empty→hit→include_state lifecycle soft-8', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-8'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc8:example.com`, origin_server_ts: 3008 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-8') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-8'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-8', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-8' });
  });
  it('empty→hit→include_state lifecycle soft-9', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-9'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc9:example.com`, origin_server_ts: 3009 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-9') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-9'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-9', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-9' });
  });
  it('empty→hit→include_state lifecycle soft-10', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-10'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc10:example.com`, origin_server_ts: 3010 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-10') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-10'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-10', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-10' });
  });
  it('empty→hit→include_state lifecycle soft-11', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-11'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc11:example.com`, origin_server_ts: 3011 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-11') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-11'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-11', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-11' });
  });
  it('empty→hit→include_state lifecycle soft-12', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-12'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc12:example.com`, origin_server_ts: 3012 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-12') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-12'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-12', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-12' });
  });
  it('empty→hit→include_state lifecycle soft-13', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-13'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc13:example.com`, origin_server_ts: 3013 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-13') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-13'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-13', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-13' });
  });
  it('empty→hit→include_state lifecycle soft-14', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-14'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc14:example.com`, origin_server_ts: 3014 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-14') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-14'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-14', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-14' });
  });
  it('empty→hit→include_state lifecycle soft-15', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-15'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc15:example.com`, origin_server_ts: 3015 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-15') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-15'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-15', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-15' });
  });
  it('empty→hit→include_state lifecycle soft-16', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-16'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc16:example.com`, origin_server_ts: 3016 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-16') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-16'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-16', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-16' });
  });
  it('empty→hit→include_state lifecycle soft-17', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-17'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc17:example.com`, origin_server_ts: 3017 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-17') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-17'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-17', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-17' });
  });
  it('empty→hit→include_state lifecycle soft-18', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-18'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc18:example.com`, origin_server_ts: 3018 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-18') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-18'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-18', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-18' });
  });
  it('empty→hit→include_state lifecycle soft-19', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-19'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc19:example.com`, origin_server_ts: 3019 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-19') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-19'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-19', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-19' });
  });
  it('empty→hit→include_state lifecycle soft-20', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-20'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc20:example.com`, origin_server_ts: 3020 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-20') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-20'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-20', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-20' });
  });
  it('empty→hit→include_state lifecycle soft-21', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-21'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc21:example.com`, origin_server_ts: 3021 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-21') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-21'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-21', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-21' });
  });
  it('empty→hit→include_state lifecycle soft-22', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-22'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc22:example.com`, origin_server_ts: 3022 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-22') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-22'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-22', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-22' });
  });
  it('empty→hit→include_state lifecycle soft-23', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-23'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc23:example.com`, origin_server_ts: 3023 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-23') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-23'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-23', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-23' });
  });
  it('empty→hit→include_state lifecycle soft-24', async () => {
    const empty = await postSearch(roomEventsBody('lc-empty-24'), createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 }));
    expect(empty.status).toBe(200);
    expect(empty.body.search_categories.room_events.results).toEqual([]);

    const hitDb = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: `$lc24:example.com`, origin_server_ts: 3024 })],
      total: 1,
      roomState: { [ROOM_A]: topicState('t-24') },
    });
    const hit = await postSearch(roomEventsBody('lc-hit-24'), hitDb);
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(1);

    const withState = await postSearch(roomEventsBody('lc-state-24', { include_state: true }), hitDb);
    expect(withState.status).toBe(200);
    expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({ topic: 't-24' });
  });
});
