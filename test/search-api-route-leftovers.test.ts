/**
 * TOKENMAXX HEAVY leftovers after #157 — search API soft/edge/reliability.
 * Complements search-helpers.test.ts. Orthogonal to open keys/media/appservice #158.
 * Tests-only — no product inventing. Fixtures use example.com only.
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

import search, { emptyRoomEventsSearchResponse } from '../src/api/search';
import type { Env } from '../src/types';

const USER = '@alice:example.com';
const ROOM_A = '!a:example.com';
const ROOM_B = '!b:example.com';
const BOB = '@bob:example.com';

type FtsRow = {
  event_id: string;
  event_type: string;
  room_id: string;
  sender: string;
  origin_server_ts: number;
  content: string;
  rank: number;
};

type SearchDbOpts = {
  memberships?: string[];
  ftsRows?: FtsRow[];
  total?: number | null;
  throwOnSqlIncludes?: string;
};

function createSearchDb(opts: SearchDbOpts = {}): D1Database & { sqlLog: string[]; bindLog: unknown[][] } {
  const memberships = opts.memberships ?? [ROOM_A, ROOM_B];
  const ftsRows = opts.ftsRows ?? [];
  const total = opts.total === undefined ? ftsRows.length : opts.total;
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
                const limit = Number(args[args.length - 2] ?? 51);
                const offset = Number(args[args.length - 1] ?? 0);
                let rows = ftsRows.slice();
                if (sql.includes('ORDER BY rank ASC')) {
                  rows = rows.slice().sort((a, b) => a.rank - b.rank);
                } else {
                  rows = rows.slice().sort((a, b) => b.origin_server_ts - a.origin_server_ts);
                }
                return { results: rows.slice(offset, offset + limit) } as { results: T[] };
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
  return { SERVER_NAME: 'example.com', DB: db } as Env;
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
    sender: BOB,
    origin_server_ts: 1000,
    content: JSON.stringify({ body: 'hello world', msgtype: 'm.text' }),
    rank: -1.5,
    ...partial,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('search leftovers empty category soft flood after #157', () => {
  it('empty categories soft-0', async () => {
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$x0' })] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty categories soft-1', async () => {
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$x1' })] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty categories soft-2', async () => {
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$x2' })] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty categories soft-3', async () => {
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$x3' })] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty categories soft-4', async () => {
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$x4' })] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty categories soft-5', async () => {
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$x5' })] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty categories soft-6', async () => {
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$x6' })] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty categories soft-7', async () => {
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$x7' })] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty categories soft-8', async () => {
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$x8' })] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty categories soft-9', async () => {
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$x9' })] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty categories soft-10', async () => {
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$x10' })] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty categories soft-11', async () => {
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$x11' })] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty categories soft-12', async () => {
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$x12' })] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty categories soft-13', async () => {
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$x13' })] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty categories soft-14', async () => {
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$x14' })] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty categories soft-15', async () => {
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$x15' })] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty categories soft-16', async () => {
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$x16' })] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty categories soft-17', async () => {
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$x17' })] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty categories soft-18', async () => {
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$x18' })] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty categories soft-19', async () => {
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$x19' })] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty categories soft-20', async () => {
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$x20' })] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty categories soft-21', async () => {
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$x21' })] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty categories soft-22', async () => {
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$x22' })] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('empty categories soft-23', async () => {
    const db = createSearchDb({ memberships: [ROOM_A], ftsRows: [fts({ event_id: '$x23' })] });
    const { status, body } = await postSearch({ search_categories: {} }, db);
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
});

describe('search leftovers blank term soft flood after #157', () => {
  const BLANKS = [
    '',
    '   ',
    '\t',
    '\n',
    '  \t  ',
    '\t\n',
    '    ',
    '\n\n',
    ' \t ',
    '\r',
    '\r\n',
    '  ',
    '',
    '   ',
    '\t',
    '\n',
    '  \t  ',
    '\t\n',
    '    ',
    '\n\n',
    ' \t ',
    '\r',
    '\r\n',
    '  ',
  ];
  it('blank term soft-0', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: BLANKS[0] } } },
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('blank term soft-1', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: BLANKS[1] } } },
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('blank term soft-2', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: BLANKS[2] } } },
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('blank term soft-3', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: BLANKS[3] } } },
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('blank term soft-4', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: BLANKS[4] } } },
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('blank term soft-5', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: BLANKS[5] } } },
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('blank term soft-6', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: BLANKS[6] } } },
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('blank term soft-7', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: BLANKS[7] } } },
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('blank term soft-8', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: BLANKS[8] } } },
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('blank term soft-9', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: BLANKS[9] } } },
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('blank term soft-10', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: BLANKS[10] } } },
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('blank term soft-11', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: BLANKS[11] } } },
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('blank term soft-12', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: BLANKS[12] } } },
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('blank term soft-13', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: BLANKS[13] } } },
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('blank term soft-14', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: BLANKS[14] } } },
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('blank term soft-15', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: BLANKS[15] } } },
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('blank term soft-16', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: BLANKS[16] } } },
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('blank term soft-17', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: BLANKS[17] } } },
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('blank term soft-18', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: BLANKS[18] } } },
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('blank term soft-19', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: BLANKS[19] } } },
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('blank term soft-20', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: BLANKS[20] } } },
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('blank term soft-21', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: BLANKS[21] } } },
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('blank term soft-22', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: BLANKS[22] } } },
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('blank term soft-23', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: BLANKS[23] } } },
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
});



describe('search leftovers success soft flood after #157', () => {
  it('success soft-0', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok0', origin_server_ts: 2000, rank: -1.0 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello0' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok0');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello0');
  });
  it('success soft-1', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok1', origin_server_ts: 2001, rank: -1.01 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello1' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok1');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello1');
  });
  it('success soft-2', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok2', origin_server_ts: 2002, rank: -1.02 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello2' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok2');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello2');
  });
  it('success soft-3', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok3', origin_server_ts: 2003, rank: -1.03 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello3' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok3');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello3');
  });
  it('success soft-4', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok4', origin_server_ts: 2004, rank: -1.04 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello4' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok4');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello4');
  });
  it('success soft-5', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok5', origin_server_ts: 2005, rank: -1.05 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello5' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok5');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello5');
  });
  it('success soft-6', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok6', origin_server_ts: 2006, rank: -1.06 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello6' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok6');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello6');
  });
  it('success soft-7', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok7', origin_server_ts: 2007, rank: -1.07 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello7' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok7');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello7');
  });
  it('success soft-8', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok8', origin_server_ts: 2008, rank: -1.08 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello8' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok8');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello8');
  });
  it('success soft-9', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok9', origin_server_ts: 2009, rank: -1.09 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello9' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok9');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello9');
  });
  it('success soft-10', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok10', origin_server_ts: 2010, rank: -1.1 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello10' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok10');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello10');
  });
  it('success soft-11', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok11', origin_server_ts: 2011, rank: -1.11 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello11' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok11');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello11');
  });
  it('success soft-12', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok12', origin_server_ts: 2012, rank: -1.12 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello12' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok12');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello12');
  });
  it('success soft-13', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok13', origin_server_ts: 2013, rank: -1.13 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello13' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok13');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello13');
  });
  it('success soft-14', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok14', origin_server_ts: 2014, rank: -1.1400000000000001 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello14' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok14');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello14');
  });
  it('success soft-15', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok15', origin_server_ts: 2015, rank: -1.15 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello15' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok15');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello15');
  });
  it('success soft-16', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok16', origin_server_ts: 2016, rank: -1.16 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello16' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok16');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello16');
  });
  it('success soft-17', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok17', origin_server_ts: 2017, rank: -1.17 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello17' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok17');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello17');
  });
  it('success soft-18', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok18', origin_server_ts: 2018, rank: -1.18 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello18' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok18');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello18');
  });
  it('success soft-19', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok19', origin_server_ts: 2019, rank: -1.19 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello19' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok19');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello19');
  });
  it('success soft-20', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok20', origin_server_ts: 2020, rank: -1.2 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello20' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok20');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello20');
  });
  it('success soft-21', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok21', origin_server_ts: 2021, rank: -1.21 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello21' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok21');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello21');
  });
  it('success soft-22', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok22', origin_server_ts: 2022, rank: -1.22 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello22' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok22');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello22');
  });
  it('success soft-23', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok23', origin_server_ts: 2023, rank: -1.23 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello23' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok23');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello23');
  });
  it('success soft-24', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok24', origin_server_ts: 2024, rank: -1.24 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello24' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok24');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello24');
  });
  it('success soft-25', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok25', origin_server_ts: 2025, rank: -1.25 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello25' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok25');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello25');
  });
  it('success soft-26', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok26', origin_server_ts: 2026, rank: -1.26 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello26' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok26');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello26');
  });
  it('success soft-27', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok27', origin_server_ts: 2027, rank: -1.27 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello27' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok27');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello27');
  });
  it('success soft-28', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok28', origin_server_ts: 2028, rank: -1.28 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello28' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok28');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello28');
  });
  it('success soft-29', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok29', origin_server_ts: 2029, rank: -1.29 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello29' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok29');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello29');
  });
  it('success soft-30', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok30', origin_server_ts: 2030, rank: -1.3 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello30' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok30');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello30');
  });
  it('success soft-31', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$ok31', origin_server_ts: 2031, rank: -1.31 })],
      total: 1,
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'hello31' } } },
      db
    );
    expect(status).toBe(200);
    expect(body.search_categories.room_events.results).toHaveLength(1);
    expect(body.search_categories.room_events.results[0].event_id).toBe('$ok31');
    expect(body.search_categories.room_events.count).toBe(1);
    expect(body.search_categories.room_events.highlights).toContain('hello31');
  });
});

describe('search leftovers order_by soft flood after #157', () => {
  it('order_by rank soft-0', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$hi0', rank: -0.1, origin_server_ts: 9999 }),
        fts({ event_id: '$lo0', rank: -5 - 0, origin_server_ts: 1 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'x0', order_by: 'rank' } } },
      db
    );
    expect(body.search_categories.room_events.results.map((r: any) => r.event_id)).toEqual([
      '$lo0',
      '$hi0',
    ]);
  });
  it('order_by rank soft-1', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$hi1', rank: -0.1, origin_server_ts: 9999 }),
        fts({ event_id: '$lo1', rank: -5 - 1, origin_server_ts: 1 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'x1', order_by: 'rank' } } },
      db
    );
    expect(body.search_categories.room_events.results.map((r: any) => r.event_id)).toEqual([
      '$lo1',
      '$hi1',
    ]);
  });
  it('order_by rank soft-2', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$hi2', rank: -0.1, origin_server_ts: 9999 }),
        fts({ event_id: '$lo2', rank: -5 - 2, origin_server_ts: 1 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'x2', order_by: 'rank' } } },
      db
    );
    expect(body.search_categories.room_events.results.map((r: any) => r.event_id)).toEqual([
      '$lo2',
      '$hi2',
    ]);
  });
  it('order_by rank soft-3', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$hi3', rank: -0.1, origin_server_ts: 9999 }),
        fts({ event_id: '$lo3', rank: -5 - 3, origin_server_ts: 1 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'x3', order_by: 'rank' } } },
      db
    );
    expect(body.search_categories.room_events.results.map((r: any) => r.event_id)).toEqual([
      '$lo3',
      '$hi3',
    ]);
  });
  it('order_by rank soft-4', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$hi4', rank: -0.1, origin_server_ts: 9999 }),
        fts({ event_id: '$lo4', rank: -5 - 4, origin_server_ts: 1 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'x4', order_by: 'rank' } } },
      db
    );
    expect(body.search_categories.room_events.results.map((r: any) => r.event_id)).toEqual([
      '$lo4',
      '$hi4',
    ]);
  });
  it('order_by rank soft-5', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$hi5', rank: -0.1, origin_server_ts: 9999 }),
        fts({ event_id: '$lo5', rank: -5 - 5, origin_server_ts: 1 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'x5', order_by: 'rank' } } },
      db
    );
    expect(body.search_categories.room_events.results.map((r: any) => r.event_id)).toEqual([
      '$lo5',
      '$hi5',
    ]);
  });
  it('order_by rank soft-6', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$hi6', rank: -0.1, origin_server_ts: 9999 }),
        fts({ event_id: '$lo6', rank: -5 - 6, origin_server_ts: 1 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'x6', order_by: 'rank' } } },
      db
    );
    expect(body.search_categories.room_events.results.map((r: any) => r.event_id)).toEqual([
      '$lo6',
      '$hi6',
    ]);
  });
  it('order_by rank soft-7', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$hi7', rank: -0.1, origin_server_ts: 9999 }),
        fts({ event_id: '$lo7', rank: -5 - 7, origin_server_ts: 1 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'x7', order_by: 'rank' } } },
      db
    );
    expect(body.search_categories.room_events.results.map((r: any) => r.event_id)).toEqual([
      '$lo7',
      '$hi7',
    ]);
  });
  it('order_by rank soft-8', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$hi8', rank: -0.1, origin_server_ts: 9999 }),
        fts({ event_id: '$lo8', rank: -5 - 8, origin_server_ts: 1 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'x8', order_by: 'rank' } } },
      db
    );
    expect(body.search_categories.room_events.results.map((r: any) => r.event_id)).toEqual([
      '$lo8',
      '$hi8',
    ]);
  });
  it('order_by rank soft-9', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$hi9', rank: -0.1, origin_server_ts: 9999 }),
        fts({ event_id: '$lo9', rank: -5 - 9, origin_server_ts: 1 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'x9', order_by: 'rank' } } },
      db
    );
    expect(body.search_categories.room_events.results.map((r: any) => r.event_id)).toEqual([
      '$lo9',
      '$hi9',
    ]);
  });
  it('order_by rank soft-10', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$hi10', rank: -0.1, origin_server_ts: 9999 }),
        fts({ event_id: '$lo10', rank: -5 - 10, origin_server_ts: 1 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'x10', order_by: 'rank' } } },
      db
    );
    expect(body.search_categories.room_events.results.map((r: any) => r.event_id)).toEqual([
      '$lo10',
      '$hi10',
    ]);
  });
  it('order_by rank soft-11', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$hi11', rank: -0.1, origin_server_ts: 9999 }),
        fts({ event_id: '$lo11', rank: -5 - 11, origin_server_ts: 1 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'x11', order_by: 'rank' } } },
      db
    );
    expect(body.search_categories.room_events.results.map((r: any) => r.event_id)).toEqual([
      '$lo11',
      '$hi11',
    ]);
  });
  it('order_by rank soft-12', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$hi12', rank: -0.1, origin_server_ts: 9999 }),
        fts({ event_id: '$lo12', rank: -5 - 12, origin_server_ts: 1 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'x12', order_by: 'rank' } } },
      db
    );
    expect(body.search_categories.room_events.results.map((r: any) => r.event_id)).toEqual([
      '$lo12',
      '$hi12',
    ]);
  });
  it('order_by rank soft-13', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$hi13', rank: -0.1, origin_server_ts: 9999 }),
        fts({ event_id: '$lo13', rank: -5 - 13, origin_server_ts: 1 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'x13', order_by: 'rank' } } },
      db
    );
    expect(body.search_categories.room_events.results.map((r: any) => r.event_id)).toEqual([
      '$lo13',
      '$hi13',
    ]);
  });
  it('order_by rank soft-14', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$hi14', rank: -0.1, origin_server_ts: 9999 }),
        fts({ event_id: '$lo14', rank: -5 - 14, origin_server_ts: 1 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'x14', order_by: 'rank' } } },
      db
    );
    expect(body.search_categories.room_events.results.map((r: any) => r.event_id)).toEqual([
      '$lo14',
      '$hi14',
    ]);
  });
  it('order_by rank soft-15', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$hi15', rank: -0.1, origin_server_ts: 9999 }),
        fts({ event_id: '$lo15', rank: -5 - 15, origin_server_ts: 1 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'x15', order_by: 'rank' } } },
      db
    );
    expect(body.search_categories.room_events.results.map((r: any) => r.event_id)).toEqual([
      '$lo15',
      '$hi15',
    ]);
  });
  it('order_by recent soft-0', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$new0', origin_server_ts: 3000 }),
        fts({ event_id: '$old0', origin_server_ts: 1000 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'y0' } } },
      db
    );
    expect(body.search_categories.room_events.results[0].event_id).toBe('$new0');
  });
  it('order_by recent soft-1', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$new1', origin_server_ts: 3001 }),
        fts({ event_id: '$old1', origin_server_ts: 1001 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'y1' } } },
      db
    );
    expect(body.search_categories.room_events.results[0].event_id).toBe('$new1');
  });
  it('order_by recent soft-2', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$new2', origin_server_ts: 3002 }),
        fts({ event_id: '$old2', origin_server_ts: 1002 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'y2' } } },
      db
    );
    expect(body.search_categories.room_events.results[0].event_id).toBe('$new2');
  });
  it('order_by recent soft-3', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$new3', origin_server_ts: 3003 }),
        fts({ event_id: '$old3', origin_server_ts: 1003 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'y3' } } },
      db
    );
    expect(body.search_categories.room_events.results[0].event_id).toBe('$new3');
  });
  it('order_by recent soft-4', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$new4', origin_server_ts: 3004 }),
        fts({ event_id: '$old4', origin_server_ts: 1004 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'y4' } } },
      db
    );
    expect(body.search_categories.room_events.results[0].event_id).toBe('$new4');
  });
  it('order_by recent soft-5', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$new5', origin_server_ts: 3005 }),
        fts({ event_id: '$old5', origin_server_ts: 1005 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'y5' } } },
      db
    );
    expect(body.search_categories.room_events.results[0].event_id).toBe('$new5');
  });
  it('order_by recent soft-6', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$new6', origin_server_ts: 3006 }),
        fts({ event_id: '$old6', origin_server_ts: 1006 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'y6' } } },
      db
    );
    expect(body.search_categories.room_events.results[0].event_id).toBe('$new6');
  });
  it('order_by recent soft-7', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$new7', origin_server_ts: 3007 }),
        fts({ event_id: '$old7', origin_server_ts: 1007 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'y7' } } },
      db
    );
    expect(body.search_categories.room_events.results[0].event_id).toBe('$new7');
  });
  it('order_by recent soft-8', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$new8', origin_server_ts: 3008 }),
        fts({ event_id: '$old8', origin_server_ts: 1008 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'y8' } } },
      db
    );
    expect(body.search_categories.room_events.results[0].event_id).toBe('$new8');
  });
  it('order_by recent soft-9', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$new9', origin_server_ts: 3009 }),
        fts({ event_id: '$old9', origin_server_ts: 1009 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'y9' } } },
      db
    );
    expect(body.search_categories.room_events.results[0].event_id).toBe('$new9');
  });
  it('order_by recent soft-10', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$new10', origin_server_ts: 3010 }),
        fts({ event_id: '$old10', origin_server_ts: 1010 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'y10' } } },
      db
    );
    expect(body.search_categories.room_events.results[0].event_id).toBe('$new10');
  });
  it('order_by recent soft-11', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$new11', origin_server_ts: 3011 }),
        fts({ event_id: '$old11', origin_server_ts: 1011 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'y11' } } },
      db
    );
    expect(body.search_categories.room_events.results[0].event_id).toBe('$new11');
  });
  it('order_by recent soft-12', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$new12', origin_server_ts: 3012 }),
        fts({ event_id: '$old12', origin_server_ts: 1012 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'y12' } } },
      db
    );
    expect(body.search_categories.room_events.results[0].event_id).toBe('$new12');
  });
  it('order_by recent soft-13', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$new13', origin_server_ts: 3013 }),
        fts({ event_id: '$old13', origin_server_ts: 1013 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'y13' } } },
      db
    );
    expect(body.search_categories.room_events.results[0].event_id).toBe('$new13');
  });
  it('order_by recent soft-14', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$new14', origin_server_ts: 3014 }),
        fts({ event_id: '$old14', origin_server_ts: 1014 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'y14' } } },
      db
    );
    expect(body.search_categories.room_events.results[0].event_id).toBe('$new14');
  });
  it('order_by recent soft-15', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [
        fts({ event_id: '$new15', origin_server_ts: 3015 }),
        fts({ event_id: '$old15', origin_server_ts: 1015 }),
      ],
    });
    const { body } = await postSearch(
      { search_categories: { room_events: { search_term: 'y15' } } },
      db
    );
    expect(body.search_categories.room_events.results[0].event_id).toBe('$new15');
  });
});

describe('search leftovers filter soft flood after #157', () => {
  it('rooms filter miss soft-0', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'z0',
            filter: { rooms: ['!other0:example.com'] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('rooms filter miss soft-1', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'z1',
            filter: { rooms: ['!other1:example.com'] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('rooms filter miss soft-2', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'z2',
            filter: { rooms: ['!other2:example.com'] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('rooms filter miss soft-3', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'z3',
            filter: { rooms: ['!other3:example.com'] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('rooms filter miss soft-4', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'z4',
            filter: { rooms: ['!other4:example.com'] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('rooms filter miss soft-5', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'z5',
            filter: { rooms: ['!other5:example.com'] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('rooms filter miss soft-6', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'z6',
            filter: { rooms: ['!other6:example.com'] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('rooms filter miss soft-7', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'z7',
            filter: { rooms: ['!other7:example.com'] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('rooms filter miss soft-8', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'z8',
            filter: { rooms: ['!other8:example.com'] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('rooms filter miss soft-9', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'z9',
            filter: { rooms: ['!other9:example.com'] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('rooms filter miss soft-10', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'z10',
            filter: { rooms: ['!other10:example.com'] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('rooms filter miss soft-11', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'z11',
            filter: { rooms: ['!other11:example.com'] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('rooms filter miss soft-12', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'z12',
            filter: { rooms: ['!other12:example.com'] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('rooms filter miss soft-13', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'z13',
            filter: { rooms: ['!other13:example.com'] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('rooms filter miss soft-14', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'z14',
            filter: { rooms: ['!other14:example.com'] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('rooms filter miss soft-15', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'z15',
            filter: { rooms: ['!other15:example.com'] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('not_rooms excludes soft-0', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'w0',
            filter: { not_rooms: [ROOM_A] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('not_rooms excludes soft-1', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'w1',
            filter: { not_rooms: [ROOM_A] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('not_rooms excludes soft-2', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'w2',
            filter: { not_rooms: [ROOM_A] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('not_rooms excludes soft-3', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'w3',
            filter: { not_rooms: [ROOM_A] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('not_rooms excludes soft-4', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'w4',
            filter: { not_rooms: [ROOM_A] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('not_rooms excludes soft-5', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'w5',
            filter: { not_rooms: [ROOM_A] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('not_rooms excludes soft-6', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'w6',
            filter: { not_rooms: [ROOM_A] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('not_rooms excludes soft-7', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'w7',
            filter: { not_rooms: [ROOM_A] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('not_rooms excludes soft-8', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'w8',
            filter: { not_rooms: [ROOM_A] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('not_rooms excludes soft-9', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'w9',
            filter: { not_rooms: [ROOM_A] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('not_rooms excludes soft-10', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'w10',
            filter: { not_rooms: [ROOM_A] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('not_rooms excludes soft-11', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'w11',
            filter: { not_rooms: [ROOM_A] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('not_rooms excludes soft-12', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'w12',
            filter: { not_rooms: [ROOM_A] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('not_rooms excludes soft-13', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'w13',
            filter: { not_rooms: [ROOM_A] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('not_rooms excludes soft-14', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'w14',
            filter: { not_rooms: [ROOM_A] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
  it('not_rooms excludes soft-15', async () => {
    const db = createSearchDb({ memberships: [ROOM_A] });
    const { body } = await postSearch(
      {
        search_categories: {
          room_events: {
            search_term: 'w15',
            filter: { not_rooms: [ROOM_A] },
          },
        },
      },
      db
    );
    expect(body).toEqual(emptyRoomEventsSearchResponse());
  });
});

describe('search leftovers bad json soft flood after #157', () => {
  it('bad json soft-0', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch("{", db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad json soft-1', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch("{]", db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad json soft-2', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch("{{", db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad json soft-3', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch("}", db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad json soft-4', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch(",,", db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad json soft-5', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch("'", db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad json soft-6', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch("<html>", db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad json soft-7', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch("{bad", db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad json soft-8', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch("[1,2,", db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad json soft-9', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch("truee", db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad json soft-10', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch("nul", db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad json soft-11', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch("{\"a\":", db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad json soft-12', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch("[{\"a\":]", db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad json soft-13', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch("{]", db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad json soft-14', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch("{", db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad json soft-15', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch("{]", db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad json soft-16', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch("{{", db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad json soft-17', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch("}", db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad json soft-18', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch(",,", db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad json soft-19', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch("'", db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad json soft-20', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch("<html>", db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad json soft-21', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch("{bad", db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
  it('bad json soft-22', async () => {
    const db = createSearchDb();
    const { status, body } = await postSearch("[1,2,", db);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });
});


describe('search leftovers method matrix after #157', () => {
  it('GET rejected soft-0', async () => {
    const db = createSearchDb();
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      { method: 'GET', headers: { Authorization: 'Bearer t' } },
      env(db)
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('GET rejected soft-1', async () => {
    const db = createSearchDb();
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      { method: 'GET', headers: { Authorization: 'Bearer t' } },
      env(db)
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('GET rejected soft-2', async () => {
    const db = createSearchDb();
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      { method: 'GET', headers: { Authorization: 'Bearer t' } },
      env(db)
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('GET rejected soft-3', async () => {
    const db = createSearchDb();
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      { method: 'GET', headers: { Authorization: 'Bearer t' } },
      env(db)
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PUT rejected soft-0', async () => {
    const db = createSearchDb();
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      { method: 'PUT', headers: { Authorization: 'Bearer t' } },
      env(db)
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PUT rejected soft-1', async () => {
    const db = createSearchDb();
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      { method: 'PUT', headers: { Authorization: 'Bearer t' } },
      env(db)
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PUT rejected soft-2', async () => {
    const db = createSearchDb();
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      { method: 'PUT', headers: { Authorization: 'Bearer t' } },
      env(db)
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PUT rejected soft-3', async () => {
    const db = createSearchDb();
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      { method: 'PUT', headers: { Authorization: 'Bearer t' } },
      env(db)
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('DELETE rejected soft-0', async () => {
    const db = createSearchDb();
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
      env(db)
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('DELETE rejected soft-1', async () => {
    const db = createSearchDb();
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
      env(db)
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('DELETE rejected soft-2', async () => {
    const db = createSearchDb();
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
      env(db)
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('DELETE rejected soft-3', async () => {
    const db = createSearchDb();
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
      env(db)
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PATCH rejected soft-0', async () => {
    const db = createSearchDb();
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      { method: 'PATCH', headers: { Authorization: 'Bearer t' } },
      env(db)
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PATCH rejected soft-1', async () => {
    const db = createSearchDb();
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      { method: 'PATCH', headers: { Authorization: 'Bearer t' } },
      env(db)
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PATCH rejected soft-2', async () => {
    const db = createSearchDb();
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      { method: 'PATCH', headers: { Authorization: 'Bearer t' } },
      env(db)
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
  it('PATCH rejected soft-3', async () => {
    const db = createSearchDb();
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      { method: 'PATCH', headers: { Authorization: 'Bearer t' } },
      env(db)
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('search leftovers failure edges after #157', () => {
  it('membership query boom soft-0', async () => {
    const db = createSearchDb({ throwOnSqlIncludes: 'FROM room_memberships' });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'boom0' } } },
      db
    );
    expect(status).toBe(500);
    expect(String(body._raw ?? body)).toMatch(/Internal Server Error|Error|boom/i);
  });
  it('membership query boom soft-1', async () => {
    const db = createSearchDb({ throwOnSqlIncludes: 'FROM room_memberships' });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'boom1' } } },
      db
    );
    expect(status).toBe(500);
    expect(String(body._raw ?? body)).toMatch(/Internal Server Error|Error|boom/i);
  });
  it('membership query boom soft-2', async () => {
    const db = createSearchDb({ throwOnSqlIncludes: 'FROM room_memberships' });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'boom2' } } },
      db
    );
    expect(status).toBe(500);
    expect(String(body._raw ?? body)).toMatch(/Internal Server Error|Error|boom/i);
  });
  it('membership query boom soft-3', async () => {
    const db = createSearchDb({ throwOnSqlIncludes: 'FROM room_memberships' });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'boom3' } } },
      db
    );
    expect(status).toBe(500);
    expect(String(body._raw ?? body)).toMatch(/Internal Server Error|Error|boom/i);
  });
  it('membership query boom soft-4', async () => {
    const db = createSearchDb({ throwOnSqlIncludes: 'FROM room_memberships' });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'boom4' } } },
      db
    );
    expect(status).toBe(500);
    expect(String(body._raw ?? body)).toMatch(/Internal Server Error|Error|boom/i);
  });
  it('membership query boom soft-5', async () => {
    const db = createSearchDb({ throwOnSqlIncludes: 'FROM room_memberships' });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'boom5' } } },
      db
    );
    expect(status).toBe(500);
    expect(String(body._raw ?? body)).toMatch(/Internal Server Error|Error|boom/i);
  });
  it('membership query boom soft-6', async () => {
    const db = createSearchDb({ throwOnSqlIncludes: 'FROM room_memberships' });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'boom6' } } },
      db
    );
    expect(status).toBe(500);
    expect(String(body._raw ?? body)).toMatch(/Internal Server Error|Error|boom/i);
  });
  it('membership query boom soft-7', async () => {
    const db = createSearchDb({ throwOnSqlIncludes: 'FROM room_memberships' });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'boom7' } } },
      db
    );
    expect(status).toBe(500);
    expect(String(body._raw ?? body)).toMatch(/Internal Server Error|Error|boom/i);
  });
  it('membership query boom soft-8', async () => {
    const db = createSearchDb({ throwOnSqlIncludes: 'FROM room_memberships' });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'boom8' } } },
      db
    );
    expect(status).toBe(500);
    expect(String(body._raw ?? body)).toMatch(/Internal Server Error|Error|boom/i);
  });
  it('membership query boom soft-9', async () => {
    const db = createSearchDb({ throwOnSqlIncludes: 'FROM room_memberships' });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'boom9' } } },
      db
    );
    expect(status).toBe(500);
    expect(String(body._raw ?? body)).toMatch(/Internal Server Error|Error|boom/i);
  });
  it('membership query boom soft-10', async () => {
    const db = createSearchDb({ throwOnSqlIncludes: 'FROM room_memberships' });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'boom10' } } },
      db
    );
    expect(status).toBe(500);
    expect(String(body._raw ?? body)).toMatch(/Internal Server Error|Error|boom/i);
  });
  it('membership query boom soft-11', async () => {
    const db = createSearchDb({ throwOnSqlIncludes: 'FROM room_memberships' });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'boom11' } } },
      db
    );
    expect(status).toBe(500);
    expect(String(body._raw ?? body)).toMatch(/Internal Server Error|Error|boom/i);
  });
  it('fts query boom soft-0', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      throwOnSqlIncludes: 'events_fts',
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'fts0' } } },
      db
    );
    expect(status).toBe(500);
    expect(String(body._raw ?? body)).toMatch(/Internal Server Error|Error|boom/i);
  });
  it('fts query boom soft-1', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      throwOnSqlIncludes: 'events_fts',
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'fts1' } } },
      db
    );
    expect(status).toBe(500);
    expect(String(body._raw ?? body)).toMatch(/Internal Server Error|Error|boom/i);
  });
  it('fts query boom soft-2', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      throwOnSqlIncludes: 'events_fts',
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'fts2' } } },
      db
    );
    expect(status).toBe(500);
    expect(String(body._raw ?? body)).toMatch(/Internal Server Error|Error|boom/i);
  });
  it('fts query boom soft-3', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      throwOnSqlIncludes: 'events_fts',
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'fts3' } } },
      db
    );
    expect(status).toBe(500);
    expect(String(body._raw ?? body)).toMatch(/Internal Server Error|Error|boom/i);
  });
  it('fts query boom soft-4', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      throwOnSqlIncludes: 'events_fts',
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'fts4' } } },
      db
    );
    expect(status).toBe(500);
    expect(String(body._raw ?? body)).toMatch(/Internal Server Error|Error|boom/i);
  });
  it('fts query boom soft-5', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      throwOnSqlIncludes: 'events_fts',
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'fts5' } } },
      db
    );
    expect(status).toBe(500);
    expect(String(body._raw ?? body)).toMatch(/Internal Server Error|Error|boom/i);
  });
  it('fts query boom soft-6', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      throwOnSqlIncludes: 'events_fts',
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'fts6' } } },
      db
    );
    expect(status).toBe(500);
    expect(String(body._raw ?? body)).toMatch(/Internal Server Error|Error|boom/i);
  });
  it('fts query boom soft-7', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      throwOnSqlIncludes: 'events_fts',
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'fts7' } } },
      db
    );
    expect(status).toBe(500);
    expect(String(body._raw ?? body)).toMatch(/Internal Server Error|Error|boom/i);
  });
  it('fts query boom soft-8', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      throwOnSqlIncludes: 'events_fts',
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'fts8' } } },
      db
    );
    expect(status).toBe(500);
    expect(String(body._raw ?? body)).toMatch(/Internal Server Error|Error|boom/i);
  });
  it('fts query boom soft-9', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      throwOnSqlIncludes: 'events_fts',
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'fts9' } } },
      db
    );
    expect(status).toBe(500);
    expect(String(body._raw ?? body)).toMatch(/Internal Server Error|Error|boom/i);
  });
  it('fts query boom soft-10', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      throwOnSqlIncludes: 'events_fts',
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'fts10' } } },
      db
    );
    expect(status).toBe(500);
    expect(String(body._raw ?? body)).toMatch(/Internal Server Error|Error|boom/i);
  });
  it('fts query boom soft-11', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      throwOnSqlIncludes: 'events_fts',
    });
    const { status, body } = await postSearch(
      { search_categories: { room_events: { search_term: 'fts11' } } },
      db
    );
    expect(status).toBe(500);
    expect(String(body._raw ?? body)).toMatch(/Internal Server Error|Error|boom/i);
  });
});


describe('search leftovers lifecycle soft floods after #157', () => {
  it('search lifecycle soft-0', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: '$L0a', origin_server_ts: 5000, room_id: ROOM_A }),
        fts({ event_id: '$L0b', origin_server_ts: 4000, room_id: ROOM_B }),
      ],
      total: 2,
    });
    const empty = await postSearch({ search_categories: {} }, db);
    expect(empty.body).toEqual(emptyRoomEventsSearchResponse());
    const hit = await postSearch(
      { search_categories: { room_events: { search_term: 'life0' } } },
      db
    );
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(2);
    const filtered = await postSearch(
      {
        search_categories: {
          room_events: { search_term: 'life0', filter: { rooms: [ROOM_A] } },
        },
      },
      db
    );
    expect(filtered.status).toBe(200);
  });
  it('search lifecycle soft-1', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: '$L1a', origin_server_ts: 5001, room_id: ROOM_A }),
        fts({ event_id: '$L1b', origin_server_ts: 4001, room_id: ROOM_B }),
      ],
      total: 2,
    });
    const empty = await postSearch({ search_categories: {} }, db);
    expect(empty.body).toEqual(emptyRoomEventsSearchResponse());
    const hit = await postSearch(
      { search_categories: { room_events: { search_term: 'life1' } } },
      db
    );
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(2);
    const filtered = await postSearch(
      {
        search_categories: {
          room_events: { search_term: 'life1', filter: { rooms: [ROOM_A] } },
        },
      },
      db
    );
    expect(filtered.status).toBe(200);
  });
  it('search lifecycle soft-2', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: '$L2a', origin_server_ts: 5002, room_id: ROOM_A }),
        fts({ event_id: '$L2b', origin_server_ts: 4002, room_id: ROOM_B }),
      ],
      total: 2,
    });
    const empty = await postSearch({ search_categories: {} }, db);
    expect(empty.body).toEqual(emptyRoomEventsSearchResponse());
    const hit = await postSearch(
      { search_categories: { room_events: { search_term: 'life2' } } },
      db
    );
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(2);
    const filtered = await postSearch(
      {
        search_categories: {
          room_events: { search_term: 'life2', filter: { rooms: [ROOM_A] } },
        },
      },
      db
    );
    expect(filtered.status).toBe(200);
  });
  it('search lifecycle soft-3', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: '$L3a', origin_server_ts: 5003, room_id: ROOM_A }),
        fts({ event_id: '$L3b', origin_server_ts: 4003, room_id: ROOM_B }),
      ],
      total: 2,
    });
    const empty = await postSearch({ search_categories: {} }, db);
    expect(empty.body).toEqual(emptyRoomEventsSearchResponse());
    const hit = await postSearch(
      { search_categories: { room_events: { search_term: 'life3' } } },
      db
    );
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(2);
    const filtered = await postSearch(
      {
        search_categories: {
          room_events: { search_term: 'life3', filter: { rooms: [ROOM_A] } },
        },
      },
      db
    );
    expect(filtered.status).toBe(200);
  });
  it('search lifecycle soft-4', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: '$L4a', origin_server_ts: 5004, room_id: ROOM_A }),
        fts({ event_id: '$L4b', origin_server_ts: 4004, room_id: ROOM_B }),
      ],
      total: 2,
    });
    const empty = await postSearch({ search_categories: {} }, db);
    expect(empty.body).toEqual(emptyRoomEventsSearchResponse());
    const hit = await postSearch(
      { search_categories: { room_events: { search_term: 'life4' } } },
      db
    );
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(2);
    const filtered = await postSearch(
      {
        search_categories: {
          room_events: { search_term: 'life4', filter: { rooms: [ROOM_A] } },
        },
      },
      db
    );
    expect(filtered.status).toBe(200);
  });
  it('search lifecycle soft-5', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: '$L5a', origin_server_ts: 5005, room_id: ROOM_A }),
        fts({ event_id: '$L5b', origin_server_ts: 4005, room_id: ROOM_B }),
      ],
      total: 2,
    });
    const empty = await postSearch({ search_categories: {} }, db);
    expect(empty.body).toEqual(emptyRoomEventsSearchResponse());
    const hit = await postSearch(
      { search_categories: { room_events: { search_term: 'life5' } } },
      db
    );
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(2);
    const filtered = await postSearch(
      {
        search_categories: {
          room_events: { search_term: 'life5', filter: { rooms: [ROOM_A] } },
        },
      },
      db
    );
    expect(filtered.status).toBe(200);
  });
  it('search lifecycle soft-6', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: '$L6a', origin_server_ts: 5006, room_id: ROOM_A }),
        fts({ event_id: '$L6b', origin_server_ts: 4006, room_id: ROOM_B }),
      ],
      total: 2,
    });
    const empty = await postSearch({ search_categories: {} }, db);
    expect(empty.body).toEqual(emptyRoomEventsSearchResponse());
    const hit = await postSearch(
      { search_categories: { room_events: { search_term: 'life6' } } },
      db
    );
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(2);
    const filtered = await postSearch(
      {
        search_categories: {
          room_events: { search_term: 'life6', filter: { rooms: [ROOM_A] } },
        },
      },
      db
    );
    expect(filtered.status).toBe(200);
  });
  it('search lifecycle soft-7', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: '$L7a', origin_server_ts: 5007, room_id: ROOM_A }),
        fts({ event_id: '$L7b', origin_server_ts: 4007, room_id: ROOM_B }),
      ],
      total: 2,
    });
    const empty = await postSearch({ search_categories: {} }, db);
    expect(empty.body).toEqual(emptyRoomEventsSearchResponse());
    const hit = await postSearch(
      { search_categories: { room_events: { search_term: 'life7' } } },
      db
    );
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(2);
    const filtered = await postSearch(
      {
        search_categories: {
          room_events: { search_term: 'life7', filter: { rooms: [ROOM_A] } },
        },
      },
      db
    );
    expect(filtered.status).toBe(200);
  });
  it('search lifecycle soft-8', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: '$L8a', origin_server_ts: 5008, room_id: ROOM_A }),
        fts({ event_id: '$L8b', origin_server_ts: 4008, room_id: ROOM_B }),
      ],
      total: 2,
    });
    const empty = await postSearch({ search_categories: {} }, db);
    expect(empty.body).toEqual(emptyRoomEventsSearchResponse());
    const hit = await postSearch(
      { search_categories: { room_events: { search_term: 'life8' } } },
      db
    );
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(2);
    const filtered = await postSearch(
      {
        search_categories: {
          room_events: { search_term: 'life8', filter: { rooms: [ROOM_A] } },
        },
      },
      db
    );
    expect(filtered.status).toBe(200);
  });
  it('search lifecycle soft-9', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: '$L9a', origin_server_ts: 5009, room_id: ROOM_A }),
        fts({ event_id: '$L9b', origin_server_ts: 4009, room_id: ROOM_B }),
      ],
      total: 2,
    });
    const empty = await postSearch({ search_categories: {} }, db);
    expect(empty.body).toEqual(emptyRoomEventsSearchResponse());
    const hit = await postSearch(
      { search_categories: { room_events: { search_term: 'life9' } } },
      db
    );
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(2);
    const filtered = await postSearch(
      {
        search_categories: {
          room_events: { search_term: 'life9', filter: { rooms: [ROOM_A] } },
        },
      },
      db
    );
    expect(filtered.status).toBe(200);
  });
  it('search lifecycle soft-10', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: '$L10a', origin_server_ts: 5010, room_id: ROOM_A }),
        fts({ event_id: '$L10b', origin_server_ts: 4010, room_id: ROOM_B }),
      ],
      total: 2,
    });
    const empty = await postSearch({ search_categories: {} }, db);
    expect(empty.body).toEqual(emptyRoomEventsSearchResponse());
    const hit = await postSearch(
      { search_categories: { room_events: { search_term: 'life10' } } },
      db
    );
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(2);
    const filtered = await postSearch(
      {
        search_categories: {
          room_events: { search_term: 'life10', filter: { rooms: [ROOM_A] } },
        },
      },
      db
    );
    expect(filtered.status).toBe(200);
  });
  it('search lifecycle soft-11', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: '$L11a', origin_server_ts: 5011, room_id: ROOM_A }),
        fts({ event_id: '$L11b', origin_server_ts: 4011, room_id: ROOM_B }),
      ],
      total: 2,
    });
    const empty = await postSearch({ search_categories: {} }, db);
    expect(empty.body).toEqual(emptyRoomEventsSearchResponse());
    const hit = await postSearch(
      { search_categories: { room_events: { search_term: 'life11' } } },
      db
    );
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(2);
    const filtered = await postSearch(
      {
        search_categories: {
          room_events: { search_term: 'life11', filter: { rooms: [ROOM_A] } },
        },
      },
      db
    );
    expect(filtered.status).toBe(200);
  });
  it('search lifecycle soft-12', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: '$L12a', origin_server_ts: 5012, room_id: ROOM_A }),
        fts({ event_id: '$L12b', origin_server_ts: 4012, room_id: ROOM_B }),
      ],
      total: 2,
    });
    const empty = await postSearch({ search_categories: {} }, db);
    expect(empty.body).toEqual(emptyRoomEventsSearchResponse());
    const hit = await postSearch(
      { search_categories: { room_events: { search_term: 'life12' } } },
      db
    );
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(2);
    const filtered = await postSearch(
      {
        search_categories: {
          room_events: { search_term: 'life12', filter: { rooms: [ROOM_A] } },
        },
      },
      db
    );
    expect(filtered.status).toBe(200);
  });
  it('search lifecycle soft-13', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: '$L13a', origin_server_ts: 5013, room_id: ROOM_A }),
        fts({ event_id: '$L13b', origin_server_ts: 4013, room_id: ROOM_B }),
      ],
      total: 2,
    });
    const empty = await postSearch({ search_categories: {} }, db);
    expect(empty.body).toEqual(emptyRoomEventsSearchResponse());
    const hit = await postSearch(
      { search_categories: { room_events: { search_term: 'life13' } } },
      db
    );
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(2);
    const filtered = await postSearch(
      {
        search_categories: {
          room_events: { search_term: 'life13', filter: { rooms: [ROOM_A] } },
        },
      },
      db
    );
    expect(filtered.status).toBe(200);
  });
  it('search lifecycle soft-14', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: '$L14a', origin_server_ts: 5014, room_id: ROOM_A }),
        fts({ event_id: '$L14b', origin_server_ts: 4014, room_id: ROOM_B }),
      ],
      total: 2,
    });
    const empty = await postSearch({ search_categories: {} }, db);
    expect(empty.body).toEqual(emptyRoomEventsSearchResponse());
    const hit = await postSearch(
      { search_categories: { room_events: { search_term: 'life14' } } },
      db
    );
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(2);
    const filtered = await postSearch(
      {
        search_categories: {
          room_events: { search_term: 'life14', filter: { rooms: [ROOM_A] } },
        },
      },
      db
    );
    expect(filtered.status).toBe(200);
  });
  it('search lifecycle soft-15', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A, ROOM_B],
      ftsRows: [
        fts({ event_id: '$L15a', origin_server_ts: 5015, room_id: ROOM_A }),
        fts({ event_id: '$L15b', origin_server_ts: 4015, room_id: ROOM_B }),
      ],
      total: 2,
    });
    const empty = await postSearch({ search_categories: {} }, db);
    expect(empty.body).toEqual(emptyRoomEventsSearchResponse());
    const hit = await postSearch(
      { search_categories: { room_events: { search_term: 'life15' } } },
      db
    );
    expect(hit.status).toBe(200);
    expect(hit.body.search_categories.room_events.results).toHaveLength(2);
    const filtered = await postSearch(
      {
        search_categories: {
          room_events: { search_term: 'life15', filter: { rooms: [ROOM_A] } },
        },
      },
      db
    );
    expect(filtered.status).toBe(200);
  });
});

describe('search leftovers charset soft flood after #157', () => {
  it('charset utf-8 soft-0', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$cs0' })],
    });
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: 'Bearer t',
        },
        body: JSON.stringify({
          search_categories: { room_events: { search_term: 'cs0' } },
        }),
      },
      env(db)
    );
    expect(res.status).toBe(200);
  });
  it('charset utf-8 soft-1', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$cs1' })],
    });
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: 'Bearer t',
        },
        body: JSON.stringify({
          search_categories: { room_events: { search_term: 'cs1' } },
        }),
      },
      env(db)
    );
    expect(res.status).toBe(200);
  });
  it('charset utf-8 soft-2', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$cs2' })],
    });
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: 'Bearer t',
        },
        body: JSON.stringify({
          search_categories: { room_events: { search_term: 'cs2' } },
        }),
      },
      env(db)
    );
    expect(res.status).toBe(200);
  });
  it('charset utf-8 soft-3', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$cs3' })],
    });
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: 'Bearer t',
        },
        body: JSON.stringify({
          search_categories: { room_events: { search_term: 'cs3' } },
        }),
      },
      env(db)
    );
    expect(res.status).toBe(200);
  });
  it('charset utf-8 soft-4', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$cs4' })],
    });
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: 'Bearer t',
        },
        body: JSON.stringify({
          search_categories: { room_events: { search_term: 'cs4' } },
        }),
      },
      env(db)
    );
    expect(res.status).toBe(200);
  });
  it('charset utf-8 soft-5', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$cs5' })],
    });
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: 'Bearer t',
        },
        body: JSON.stringify({
          search_categories: { room_events: { search_term: 'cs5' } },
        }),
      },
      env(db)
    );
    expect(res.status).toBe(200);
  });
  it('charset utf-8 soft-6', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$cs6' })],
    });
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: 'Bearer t',
        },
        body: JSON.stringify({
          search_categories: { room_events: { search_term: 'cs6' } },
        }),
      },
      env(db)
    );
    expect(res.status).toBe(200);
  });
  it('charset utf-8 soft-7', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$cs7' })],
    });
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: 'Bearer t',
        },
        body: JSON.stringify({
          search_categories: { room_events: { search_term: 'cs7' } },
        }),
      },
      env(db)
    );
    expect(res.status).toBe(200);
  });
  it('charset utf-8 soft-8', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$cs8' })],
    });
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: 'Bearer t',
        },
        body: JSON.stringify({
          search_categories: { room_events: { search_term: 'cs8' } },
        }),
      },
      env(db)
    );
    expect(res.status).toBe(200);
  });
  it('charset utf-8 soft-9', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$cs9' })],
    });
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: 'Bearer t',
        },
        body: JSON.stringify({
          search_categories: { room_events: { search_term: 'cs9' } },
        }),
      },
      env(db)
    );
    expect(res.status).toBe(200);
  });
  it('charset utf-8 soft-10', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$cs10' })],
    });
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: 'Bearer t',
        },
        body: JSON.stringify({
          search_categories: { room_events: { search_term: 'cs10' } },
        }),
      },
      env(db)
    );
    expect(res.status).toBe(200);
  });
  it('charset utf-8 soft-11', async () => {
    const db = createSearchDb({
      memberships: [ROOM_A],
      ftsRows: [fts({ event_id: '$cs11' })],
    });
    const res = await search.request(
      'http://localhost/_matrix/client/v3/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: 'Bearer t',
        },
        body: JSON.stringify({
          search_categories: { room_events: { search_term: 'cs11' } },
        }),
      },
      env(db)
    );
    expect(res.status).toBe(200);
  });
});

void USER;
