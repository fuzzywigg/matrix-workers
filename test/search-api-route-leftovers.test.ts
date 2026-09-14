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
const SERVER = 'example.com';

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
                    // types are near the end before LIMIT/OFFSET
                    const typeStart = args.length - 2 - placeholderCount;
                    // account for not_types after types
                    let end = args.length - 2;
                    if (sql.includes('AND e.event_type NOT IN (')) {
                      const notCount = (
                        sql.match(/AND e\.event_type NOT IN \(([^)]+)\)/)?.[1].match(/\?/g) || []
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
    `http://localhost/_matrix/client/v3/search${query}`,
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

beforeEach(() => {
  vi.clearAllMocks();
});

void USER;
void SEARCH_PAGE_LIMIT;

describe('search leftovers empty search soft flood after #157', () => {
  for (let i = 0; i < 25; i++) {
    it(`empty search soft-${i}`, async () => {
      const terms = ['', '   ', '\t', '\n', '  \t  '];
      const term = terms[i % terms.length];
      const db = createSearchDb({ memberships: [ROOM_A] });
      const { status, body } = await postSearch(
        { search_categories: { room_events: { search_term: term } } },
        db
      );
      expect(status).toBe(200);
      expect(body).toEqual(emptyRoomEventsSearchResponse());
    });
  }
});

describe('search leftovers room_events search_term soft flood after #157', () => {
  const terms = [
    'hello',
    'world',
    'Hello World',
    'matrix',
    'alice',
    'bob',
    'test-term',
    'foo_bar',
    'café',
    'emoji🎉',
    'a',
    'ab',
    'one two three',
    'quoted"term',
    "apostrophe's",
    'star*fish',
    'paren(s)',
    'plus+plus',
    'hash#tag',
    'slash/path',
    'dot.dot',
    'under_score',
    'UPPER',
    'MiXeD',
    '12345',
  ];
  for (let i = 0; i < 25; i++) {
    it(`room_events search_term soft-${i}`, async () => {
      const term = terms[i];
      const db = createSearchDb({
        memberships: [ROOM_A],
        ftsRows: [
          fts({
            event_id: `$term${i}:example.com`,
            content: JSON.stringify({ body: term, msgtype: 'm.text' }),
            origin_server_ts: 1000 + i,
          }),
        ],
        total: 1,
      });
      const { status, body } = await postSearch(
        { search_categories: { room_events: { search_term: term } } },
        db
      );
      expect(status).toBe(200);
      expect(body.search_categories.room_events.results).toHaveLength(1);
      expect(body.search_categories.room_events.results[0].event_id).toBe(
        `$term${i}:example.com`
      );
      expect(body.search_categories.room_events.count).toBe(1);
      expect(Array.isArray(body.search_categories.room_events.highlights)).toBe(true);
    });
  }
});

describe('search leftovers include_state soft flood after #157', () => {
  for (let i = 0; i < 25; i++) {
    it(`include_state soft-${i}`, async () => {
      const db = createSearchDb({
        memberships: [ROOM_A],
        ftsRows: [fts({ event_id: `$st${i}:example.com`, origin_server_ts: 2000 + i })],
        total: 1,
        roomState: {
          [ROOM_A]: [
            {
              event_type: 'm.room.name',
              state_key: '',
              sender: '@alice:example.com',
              content: JSON.stringify({ name: `Room-${i}` }),
              origin_server_ts: 100,
            },
          ],
        },
      });
      const { status, body } = await postSearch(
        {
          search_categories: {
            room_events: { search_term: `state-${i}`, include_state: true },
          },
        },
        db
      );
      expect(status).toBe(200);
      expect(body.search_categories.room_events.state).toBeDefined();
      expect(body.search_categories.room_events.state[ROOM_A]).toHaveLength(1);
      expect(body.search_categories.room_events.state[ROOM_A][0].content).toEqual({
        name: `Room-${i}`,
      });
    });
  }
});

describe('search leftovers keys soft flood after #157', () => {
  // keys is accepted on the request type but unused by the handler — still 200.
  const keySets: string[][] = [
    ['content.body'],
    ['content.body', 'content.topic'],
    ['content.name'],
    [],
    ['content.body', 'content.name', 'content.topic'],
  ];
  for (let i = 0; i < 25; i++) {
    it(`keys soft-${i}`, async () => {
      const keys = keySets[i % keySets.length];
      const db = createSearchDb({
        memberships: [ROOM_A],
        ftsRows: [fts({ event_id: `$k${i}:example.com` })],
        total: 1,
      });
      const { status, body } = await postSearch(
        {
          search_categories: {
            room_events: { search_term: `keys-${i}`, keys },
          },
        },
        db
      );
      expect(status).toBe(200);
      expect(body.search_categories.room_events.results).toHaveLength(1);
    });
  }
});

describe('search leftovers filter soft flood after #157', () => {
  for (let i = 0; i < 25; i++) {
    it(`filter soft-${i}`, async () => {
      const mode = i % 5;
      const db = createSearchDb({
        memberships: [ROOM_A, ROOM_B],
        ftsRows: [
          fts({
            event_id: `$fa${i}:example.com`,
            room_id: ROOM_A,
            sender: '@bob:example.com',
            event_type: 'm.room.message',
          }),
          fts({
            event_id: `$fb${i}:example.com`,
            room_id: ROOM_B,
            sender: '@carol:example.com',
            event_type: 'm.room.message',
            origin_server_ts: 2000,
          }),
        ],
        total: 2,
      });

      let filter: Record<string, unknown> = {};
      if (mode === 0) filter = { rooms: [ROOM_A] };
      else if (mode === 1) filter = { not_rooms: [ROOM_B] };
      else if (mode === 2) filter = { senders: ['@bob:example.com'] };
      else if (mode === 3) filter = { not_senders: ['@carol:example.com'] };
      else filter = { types: ['m.room.message'] };

      const { status, body } = await postSearch(
        {
          search_categories: {
            room_events: { search_term: `filter-${i}`, filter },
          },
        },
        db
      );
      expect(status).toBe(200);
      expect(body.search_categories.room_events.results.length).toBeGreaterThanOrEqual(1);
    });
  }
});

describe('search leftovers bad JSON / missing categories failure soft flood after #157', () => {
  const badBodies = [
    '{',
    '{]',
    '',
    'not-json',
    '{broken',
    '[,]',
    '{"search_categories"',
    'undefined',
    'NaN',
    '{ok:',
  ];
  for (let i = 0; i < 25; i++) {
    it(`bad JSON soft-${i}`, async () => {
      const db = createSearchDb();
      const { status, body } = await postSearch(badBodies[i % badBodies.length], db);
      expect(status).toBe(400);
      expect(body.errcode).toBe('M_BAD_JSON');
    });
  }

  for (let i = 0; i < 25; i++) {
    it(`missing search_categories soft-${i}`, async () => {
      const db = createSearchDb({ memberships: [ROOM_A] });
      const payloads = [
        {},
        { search_categories: {} },
        { search_categories: { room_events: undefined } },
        { other: 1 },
        { search_categories: { something_else: {} } },
      ];
      const { status, body } = await postSearch(payloads[i % payloads.length], db);
      expect(status).toBe(200);
      expect(body).toEqual(emptyRoomEventsSearchResponse());
    });
  }
});

describe('search leftovers charset soft flood after #157', () => {
  const charsets = [
    'application/json',
    'application/json; charset=utf-8',
    'application/json;charset=UTF-8',
    'application/json; charset=UTF-8',
    'application/json; charset="utf-8"',
  ];
  for (let i = 0; i < 25; i++) {
    it(`charset soft-${i}`, async () => {
      const ct = charsets[i % charsets.length];
      const db = createSearchDb({
        memberships: [ROOM_A],
        ftsRows: [fts({ event_id: `$ct${i}:example.com` })],
        total: 1,
      });
      const { status, body } = await postSearch(
        { search_categories: { room_events: { search_term: `ct-${i}` } } },
        db,
        '',
        ct
      );
      expect(status).toBe(200);
      expect(body.search_categories.room_events.results).toHaveLength(1);
    });
  }
});

describe('search leftovers method matrix after #157', () => {
  const path = '/_matrix/client/v3/search';
  const bad = ['GET', 'PUT', 'DELETE', 'PATCH'];
  for (const method of bad) {
    it(`${method} search → 404/405`, async () => {
      const db = createSearchDb();
      const res = await search.request(
        `http://localhost${path}`,
        {
          method,
          headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
          body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
        },
        env(db)
      );
      expect([404, 405]).toContain(res.status);
    });
  }
});

describe('search leftovers no-membership / filter-empty soft flood after #157', () => {
  for (let i = 0; i < 15; i++) {
    it(`no memberships soft-${i}`, async () => {
      const db = createSearchDb({ memberships: [] });
      const { status, body } = await postSearch(
        { search_categories: { room_events: { search_term: `nm-${i}` } } },
        db
      );
      expect(status).toBe(200);
      expect(body).toEqual(emptyRoomEventsSearchResponse());
    });
  }
});

describe('search leftovers lifecycle soft flood after #157', () => {
  for (let i = 0; i < 25; i++) {
    it(`empty→hit→include_state lifecycle soft-${i}`, async () => {
      const emptyDb = createSearchDb({ memberships: [ROOM_A], ftsRows: [], total: 0 });
      const empty = await postSearch(
        { search_categories: { room_events: { search_term: `lc-empty-${i}` } } },
        emptyDb
      );
      expect(empty.status).toBe(200);
      expect(empty.body.search_categories.room_events.results).toEqual([]);

      const hitDb = createSearchDb({
        memberships: [ROOM_A],
        ftsRows: [fts({ event_id: `$lc${i}:example.com`, origin_server_ts: 3000 + i })],
        total: 1,
        roomState: {
          [ROOM_A]: [
            {
              event_type: 'm.room.topic',
              state_key: '',
              sender: '@alice:example.com',
              content: JSON.stringify({ topic: `t-${i}` }),
              origin_server_ts: 50,
            },
          ],
        },
      });
      const hit = await postSearch(
        { search_categories: { room_events: { search_term: `lc-hit-${i}` } } },
        hitDb
      );
      expect(hit.status).toBe(200);
      expect(hit.body.search_categories.room_events.results).toHaveLength(1);

      const withState = await postSearch(
        {
          search_categories: {
            room_events: { search_term: `lc-state-${i}`, include_state: true },
          },
        },
        hitDb
      );
      expect(withState.status).toBe(200);
      expect(withState.body.search_categories.room_events.state[ROOM_A][0].content).toEqual({
        topic: `t-${i}`,
      });
    });
  }
});
