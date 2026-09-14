/**
 * TOKENMAXX HEAVY leftovers after #233 / deepen after #241 — residual
 * *aliases* concurrent-race / TOCTOU + reliability slices not covered by
 * aliases-api-routes, tags-aliases soft leftovers (#153), concurrent leftovers
 * (#193/#228/#233), or analytics sibling deepen (#227/#233).
 *
 * Distinct from #233: visibility membership barrier+flip; failFirst room/
 * membership; PL []/number/string/true/null/{}; quad UNIQUE; PUT∥DELETE
 * barriers; is_public=-1; servers boolean; multi-endpoint; ban/knock lifecycle.
 *
 * Deepen after #241 residual focus:
 *   string/negative/null PL coercion under parallel DELETE/visibility;
 *   events_default ignored (state_default gate); JOIN case membership forbid;
 *   servers "" / JSON-string resolve; failFirst power_levels isolation;
 *   triple visibility LWW; failUpdate sibling-room isolation;
 *   creator_id "" vs USER; GET∥PUT same-alias barrier; soft floods.
 *
 * Tests-only. Fixtures use example.com only. No product inventing.
 */
import { describe, expect, it, vi } from 'vitest';
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

import aliases from '../src/api/aliases';

const USER = '@alice:example.com';
const OTHER = '@bob:example.com';
const SERVER = 'example.com';
const ROOM = '!room:example.com';
const ROOM2 = '!room2:example.com';
const ALIAS = '#general:example.com';
const ALIAS2 = '#lobby:example.com';
const NOW = 1_700_000_000_000;

type AliasRow = {
  alias: string;
  room_id: string;
  creator_id: string;
  servers: string | null;
  created_at: number;
};

type RoomRow = { room_id: string; is_public: number };
type MembershipRow = { room_id: string; user_id: string; membership: string };
type SqlCall = { sql: string; args: unknown[] };
type SelectBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };
type RunBarrier = { match: (sql: string, args: unknown[]) => boolean; count: number };

async function withBarrier(
  barrier: { match: (sql: string, args: unknown[]) => boolean; count: number } | undefined,
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

function seedAlias(overrides: Partial<AliasRow> = {}): AliasRow {
  return {
    alias: overrides.alias ?? ALIAS,
    room_id: overrides.room_id ?? ROOM,
    creator_id: overrides.creator_id ?? USER,
    servers: overrides.servers === undefined ? JSON.stringify([SERVER]) : overrides.servers,
    created_at: overrides.created_at ?? NOW,
  };
}

function createAliasesDb(
  opts: {
    aliases?: AliasRow[];
    rooms?: RoomRow[];
    memberships?: MembershipRow[];
    powerLevelsContent?: string | null;
    powerLevelsRaw?: string | null;
    selectBarrier?: SelectBarrier;
    runBarrier?: RunBarrier;
    failFirst?: { match: (sql: string, args: unknown[]) => boolean; after: number };
    failUpdateAfter?: number;
    uniqueAliasInsert?: boolean;
  } = {}
) {
  const aliasRows = opts.aliases ?? [];
  const roomRows = opts.rooms ?? [];
  const memberships = opts.memberships ?? [];
  const powerLevelsContent =
    opts.powerLevelsRaw !== undefined
      ? opts.powerLevelsRaw
      : opts.powerLevelsContent === undefined
        ? null
        : opts.powerLevelsContent;

  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const selects: SqlCall[] = [];

  let selectBarrier = opts.selectBarrier;
  let runBarrier = opts.runBarrier;
  const selectWaiters = { list: [] as Array<() => void> };
  const runWaiters = { list: [] as Array<() => void> };
  let failFirstCount = 0;
  let updateCount = 0;
  const failFirst = opts.failFirst;
  const failUpdateAfter = opts.failUpdateAfter;
  const uniqueAliasInsert = opts.uniqueAliasInsert ?? true;

  const db = {
    aliases: aliasRows,
    rooms: roomRows,
    memberships,
    inserts,
    updates,
    deletes,
    selects,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              await withBarrier(
                selectBarrier,
                selectWaiters,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );

              if (failFirst && failFirst.match(sql, args)) {
                failFirstCount += 1;
                if (failFirstCount > failFirst.after) {
                  throw new Error('d1-alias-first-fail');
                }
              }

              if (
                sql.includes('FROM room_aliases') &&
                sql.includes('SELECT room_id, servers')
              ) {
                const alias = args[0] as string;
                const row = aliasRows.find((a) => a.alias === alias);
                if (!row) return null as T;
                return { room_id: row.room_id, servers: row.servers } as T;
              }

              if (
                sql.includes('FROM room_aliases') &&
                sql.includes('SELECT room_id, creator_id')
              ) {
                const alias = args[0] as string;
                const row = aliasRows.find((a) => a.alias === alias);
                if (!row) return null as T;
                return { room_id: row.room_id, creator_id: row.creator_id } as T;
              }

              if (
                sql.includes('SELECT alias FROM room_aliases') &&
                sql.includes('WHERE alias = ?')
              ) {
                const alias = args[0] as string;
                const row = aliasRows.find((a) => a.alias === alias);
                return (row ? { alias: row.alias } : null) as T;
              }

              if (sql.includes('SELECT room_id FROM rooms WHERE room_id = ?')) {
                const roomId = args[0] as string;
                const row = roomRows.find((r) => r.room_id === roomId);
                return (row ? { room_id: row.room_id } : null) as T;
              }

              if (sql.includes('SELECT is_public FROM rooms')) {
                const roomId = args[0] as string;
                const row = roomRows.find((r) => r.room_id === roomId);
                if (!row) return null as T;
                return { is_public: row.is_public } as T;
              }

              if (sql.includes('FROM room_memberships')) {
                const [roomId, userId] = args as string[];
                const row = memberships.find(
                  (m) => m.room_id === roomId && m.user_id === userId
                );
                return (row ? { membership: row.membership } : null) as T;
              }

              if (
                sql.includes('m.room.power_levels') ||
                (sql.includes('FROM room_state') && sql.includes('power_levels'))
              ) {
                if (powerLevelsContent == null) return null as T;
                return { content: powerLevelsContent } as T;
              }

              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 160)}`);
            },

            async all<T>() {
              selects.push({ sql, args });
              return { results: [] as T[] };
            },

            async run() {
              await withBarrier(
                runBarrier,
                runWaiters,
                () => {
                  runBarrier = undefined;
                },
                sql,
                args
              );

              if (sql.includes('INSERT INTO room_aliases')) {
                inserts.push({ sql, args });
                const [alias, roomId, creatorId, servers, createdAt] = args as [
                  string,
                  string,
                  string,
                  string,
                  number,
                ];
                if (uniqueAliasInsert && aliasRows.some((a) => a.alias === alias)) {
                  throw new Error('UNIQUE constraint failed: room_aliases.alias');
                }
                aliasRows.push({
                  alias,
                  room_id: roomId,
                  creator_id: creatorId,
                  servers,
                  created_at: createdAt,
                });
                return { success: true, meta: { changes: 1, last_row_id: 1 } };
              }

              if (sql.includes('DELETE FROM room_aliases')) {
                deletes.push({ sql, args });
                const alias = args[0] as string;
                const before = aliasRows.length;
                for (let i = aliasRows.length - 1; i >= 0; i--) {
                  if (aliasRows[i].alias === alias) aliasRows.splice(i, 1);
                }
                return {
                  success: true,
                  meta: { changes: before - aliasRows.length, last_row_id: 0 },
                };
              }

              if (sql.includes('UPDATE rooms SET is_public')) {
                updateCount += 1;
                if (failUpdateAfter !== undefined && updateCount > failUpdateAfter) {
                  throw new Error('d1-alias-update-fail');
                }
                updates.push({ sql, args });
                const [isPublic, roomId] = args as [number, string];
                const row = roomRows.find((r) => r.room_id === roomId);
                if (row) row.is_public = isPublic;
                return { success: true, meta: { changes: row ? 1 : 0, last_row_id: 0 } };
              }

              throw new Error(`Unhandled run() SQL: ${sql.slice(0, 160)}`);
            },
          };
        },
      };
    },
  };

  return db;
}

type AliasesDb = ReturnType<typeof createAliasesDb>;

function envFor(db: AliasesDb): Env {
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
  } as unknown as Env;
}

async function request(
  db: AliasesDb,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  const res = await aliases.request(`http://localhost${path}`, init, envFor(db));
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

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function joinedMember(roomId = ROOM, userId = USER): MembershipRow {
  return { room_id: roomId, user_id: userId, membership: 'join' };
}

function room(roomId = ROOM, isPublic = 0): RoomRow {
  return { room_id: roomId, is_public: isPublic };
}

function aliasPath(alias = ALIAS): string {
  return `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`;
}

function visibilityPath(roomId = ROOM): string {
  return `/_matrix/client/v3/directory/list/room/${encodeURIComponent(roomId)}`;
}

describe('race residual string/negative/null PL coercion after #241', () => {
  it('string users power "100" coerces under < and allows parallel DELETE', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: '100' },
        state_default: 50,
      }),
    });
    const results = await Promise.all([
      request(db, aliasPath(), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
      request(db, aliasPath(), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.aliases).toHaveLength(0);
  });

  it('string state_default "50" with user 0 forbids DELETE (0 < "50")', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: 0 },
        users_default: 0,
        state_default: '50',
      }),
    });
    const results = await Promise.all([
      request(db, aliasPath(), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
      request(db, aliasPath(), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.aliases).toHaveLength(1);
  });

  it('negative userPower=-1 with state_default=-5 allows ( -1 < -5 is false )', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: -1 },
        state_default: -5,
      }),
    });
    const results = await Promise.all([
      request(db, aliasPath(), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
      request(db, aliasPath(), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.aliases).toHaveLength(0);
  });

  it('negative userPower=-1 with state_default=50 forbids under parallel', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: -1 },
        state_default: 50,
      }),
    });
    const results = await Promise.all([
      request(db, aliasPath(), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
      request(db, aliasPath(), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.aliases).toHaveLength(1);
  });

  it('users[userId]=null falls through to users_default under parallel DELETE', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: null },
        users_default: 100,
        state_default: 50,
      }),
    });
    const results = await Promise.all([
      request(db, aliasPath(), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
      request(db, aliasPath(), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.aliases).toHaveLength(0);
  });

  it('visibility PUT with string power "80" allows under parallel', async () => {
    const db = createAliasesDb({
      rooms: [room(ROOM, 0)],
      memberships: [joinedMember()],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: '80' },
        state_default: 50,
      }),
    });
    const results = await Promise.all([
      request(db, visibilityPath(), jsonInit('PUT', { visibility: 'public' })),
      request(db, visibilityPath(), jsonInit('PUT', { visibility: 'private' })),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.updates.length).toBeGreaterThanOrEqual(1);
  });

  for (let i = 0; i < 6; i++) {
    it(`string PL residual soft-${i}`, async () => {
      const alias = `#spl-${i}:example.com`;
      const db = createAliasesDb({
        aliases: [seedAlias({ alias, creator_id: OTHER })],
        powerLevelsContent: JSON.stringify({
          users: { [USER]: String(50 + i) },
          state_default: 50,
        }),
      });
      const results = await Promise.all([
        request(db, aliasPath(alias), {
          method: 'DELETE',
          headers: { Authorization: 'Bearer t' },
        }),
        request(db, aliasPath(alias), {
          method: 'DELETE',
          headers: { Authorization: 'Bearer t' },
        }),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(db.aliases).toHaveLength(0);
    });
  }
});

describe('race residual events_default ignored + JOIN case + creator "" after #241', () => {
  it('events_default 100 does not substitute for state_default — user 0 forbidden', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: 0 },
        users_default: 0,
        events_default: 100,
        state_default: 50,
      }),
    });
    const results = await Promise.all([
      request(db, aliasPath(), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
      request(db, aliasPath(), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.aliases).toHaveLength(1);
  });

  it('membership JOIN (wrong case) parallel PUT both forbidden', async () => {
    const db = createAliasesDb({
      rooms: [room()],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'JOIN' }],
    });
    const results = await Promise.all([
      request(db, aliasPath('#j1:example.com'), jsonInit('PUT', { room_id: ROOM })),
      request(db, aliasPath('#j2:example.com'), jsonInit('PUT', { room_id: ROOM })),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.inserts).toHaveLength(0);
  });

  it('creator_id empty string !== USER — needs PL; without PL both forbidden', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: '' })],
      powerLevelsContent: null,
    });
    const results = await Promise.all([
      request(db, aliasPath(), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
      request(db, aliasPath(), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.aliases).toHaveLength(1);
  });

  it('creator_id empty string with sufficient PL allows DELETE', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: '' })],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: 100 },
        state_default: 50,
      }),
    });
    const results = await Promise.all([
      request(db, aliasPath(), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
      request(db, aliasPath(), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.aliases).toHaveLength(0);
  });

  for (const membership of ['Join', 'joined', 'JOIN'] as const) {
    it(`visibility forbid membership=${membership} under parallel`, async () => {
      const db = createAliasesDb({
        rooms: [room(ROOM, 0)],
        memberships: [{ room_id: ROOM, user_id: USER, membership }],
        powerLevelsContent: null,
      });
      const results = await Promise.all([
        request(db, visibilityPath(), jsonInit('PUT', { visibility: 'public' })),
        request(db, visibilityPath(), jsonInit('PUT', { visibility: 'private' })),
      ]);
      expect(results.every((r) => r.status === 403)).toBe(true);
      expect(db.updates).toHaveLength(0);
    });
  }
});

describe('race residual servers empty/string + GET∥PUT barrier after #241', () => {
  it('servers "" JSON.parse throws → SERVER_NAME fallback under parallel GET', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ servers: '' })],
    });
    const results = await Promise.all([
      request(db, aliasPath()),
      request(db, aliasPath()),
      request(db, aliasPath()),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(
      results.every((r) => JSON.stringify((r.body as { servers: unknown }).servers) === JSON.stringify([SERVER]))
    ).toBe(true);
  });

  it('servers JSON string value returned as-is under parallel GET', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ servers: '"only-one.example.org"' })],
    });
    const results = await Promise.all([request(db, aliasPath()), request(db, aliasPath())]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((results[0].body as { servers: unknown }).servers).toBe('only-one.example.org');
  });

  it('GET resolve ∥ PUT create distinct alias under INSERT barrier — both settle', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias()],
      rooms: [room()],
      memberships: [joinedMember()],
      runBarrier: {
        count: 1,
        match: (sql) => sql.includes('INSERT INTO room_aliases'),
      },
    });
    const putP = request(db, aliasPath(ALIAS2), jsonInit('PUT', { room_id: ROOM }));
    await Promise.resolve();
    const get = await request(db, aliasPath());
    const put = await putP;
    expect(get.status).toBe(200);
    expect(put.status).toBe(200);
    expect(db.aliases.some((a) => a.alias === ALIAS2)).toBe(true);
  });

  it('DELETE missing ∥ PUT create same alias — 404 and 200 isolate', async () => {
    const db = createAliasesDb({
      rooms: [room()],
      memberships: [joinedMember()],
    });
    const results = await Promise.all([
      request(db, aliasPath(ALIAS2), {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t' },
      }),
      request(db, aliasPath(ALIAS2), jsonInit('PUT', { room_id: ROOM })),
    ]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 404]);
    expect(db.aliases.filter((a) => a.alias === ALIAS2)).toHaveLength(1);
  });

  for (let i = 0; i < 6; i++) {
    it(`servers empty/string residual soft-${i}`, async () => {
      const alias = `#srv-${i}:example.com`;
      const servers = i % 2 === 0 ? '' : `"peer${i}.example.org"`;
      const db = createAliasesDb({
        aliases: [seedAlias({ alias, servers })],
      });
      const results = await Promise.all([
        request(db, aliasPath(alias)),
        request(db, aliasPath(alias)),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      if (i % 2 === 0) {
        expect((results[0].body as { servers: unknown }).servers).toEqual([SERVER]);
      } else {
        expect((results[0].body as { servers: unknown }).servers).toBe(`peer${i}.example.org`);
      }
    });
  }
});

describe('race residual failFirst PL + failUpdate sibling + triple visibility after #241', () => {
  it('power_levels failFirst after:0 isolates sibling alias DELETE', async () => {
    const db = createAliasesDb({
      aliases: [
        seedAlias({ alias: ALIAS, creator_id: OTHER, room_id: ROOM }),
        seedAlias({ alias: ALIAS2, creator_id: OTHER, room_id: ROOM2 }),
      ],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: 100 },
        state_default: 50,
      }),
      failFirst: {
        after: 0,
        match: (sql, args) =>
          (sql.includes('m.room.power_levels') || sql.includes('power_levels')) &&
          args[0] === ROOM,
      },
    });
    const results = await Promise.all([
      request(db, aliasPath(ALIAS), {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t' },
      }),
      request(db, aliasPath(ALIAS2), {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t' },
      }),
    ]);
    expect(results[0].status).toBe(500);
    expect(results[1].status).toBe(200);
    expect(db.aliases.map((a) => a.alias)).toEqual([ALIAS]);
  });

  it('failUpdate after:0 — first visibility UPDATE 500; room stays private', async () => {
    const db = createAliasesDb({
      rooms: [room(ROOM, 0), room(ROOM2, 0)],
      memberships: [joinedMember(ROOM), joinedMember(ROOM2)],
      powerLevelsContent: null,
      failUpdateAfter: 0,
    });
    const first = await request(
      db,
      visibilityPath(ROOM),
      jsonInit('PUT', { visibility: 'public' })
    );
    expect(first.status).toBe(500);
    expect(db.rooms.find((r) => r.room_id === ROOM)?.is_public).toBe(0);
    expect(db.rooms.find((r) => r.room_id === ROOM2)?.is_public).toBe(0);
  });

  it('failUpdate after:1 — first visibility ok, second fails, ROOM state sticky', async () => {
    const db = createAliasesDb({
      rooms: [room(ROOM, 0), room(ROOM2, 0)],
      memberships: [joinedMember(ROOM), joinedMember(ROOM2)],
      powerLevelsContent: null,
      failUpdateAfter: 1,
    });
    const a = await request(db, visibilityPath(ROOM), jsonInit('PUT', { visibility: 'public' }));
    expect(a.status).toBe(200);
    expect(db.rooms.find((r) => r.room_id === ROOM)?.is_public).toBe(1);
    const b = await request(
      db,
      visibilityPath(ROOM),
      jsonInit('PUT', { visibility: 'private' })
    );
    expect(b.status).toBe(500);
    expect(db.rooms.find((r) => r.room_id === ROOM)?.is_public).toBe(1);
    expect(db.rooms.find((r) => r.room_id === ROOM2)?.is_public).toBe(0);
  });

  it('triple visibility public∥private∥public under UPDATE barrier — last-write coherent', async () => {
    const db = createAliasesDb({
      rooms: [room(ROOM, 0)],
      memberships: [joinedMember()],
      powerLevelsContent: null,
      runBarrier: {
        count: 3,
        match: (sql) => sql.includes('UPDATE rooms SET is_public'),
      },
    });
    const results = await Promise.all([
      request(db, visibilityPath(), jsonInit('PUT', { visibility: 'public' })),
      request(db, visibilityPath(), jsonInit('PUT', { visibility: 'private' })),
      request(db, visibilityPath(), jsonInit('PUT', { visibility: 'public' })),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.updates).toHaveLength(3);
    expect([0, 1]).toContain(db.rooms[0].is_public);
    // Final value equals last completed UPDATE args[0]
    const last = db.updates[db.updates.length - 1].args[0];
    expect(db.rooms[0].is_public).toBe(last);
  });

  for (let i = 0; i < 6; i++) {
    it(`triple visibility residual soft-${i}`, async () => {
      const db = createAliasesDb({
        rooms: [room(ROOM, 0)],
        memberships: [joinedMember()],
        powerLevelsContent: null,
      });
      const results = await Promise.all([
        request(db, visibilityPath(), jsonInit('PUT', { visibility: 'public' })),
        request(db, visibilityPath(), jsonInit('PUT', { visibility: 'private' })),
        request(db, visibilityPath(), jsonInit('PUT', { visibility: 'public' })),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect([0, 1]).toContain(db.rooms[0].is_public);
    });
  }
});

describe('race residual cross-endpoint + null room_id soft after #241', () => {
  it('PUT null room_id ∥ empty room_id both M_MISSING_PARAM under parallel', async () => {
    const db = createAliasesDb({
      rooms: [room()],
      memberships: [joinedMember()],
    });
    const results = await Promise.all([
      request(db, aliasPath('#n0:example.com'), jsonInit('PUT', { room_id: null })),
      request(db, aliasPath('#n1:example.com'), jsonInit('PUT', { room_id: '' })),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(results.every((r) => (r.body as { errcode: string }).errcode === 'M_MISSING_PARAM')).toBe(
      true
    );
    expect(db.inserts).toHaveLength(0);
  });

  it('visibility null∥""∥array all missing-param under parallel', async () => {
    const db = createAliasesDb({
      rooms: [room(ROOM, 0)],
      memberships: [joinedMember()],
      powerLevelsContent: null,
    });
    const results = await Promise.all([
      request(db, visibilityPath(), jsonInit('PUT', { visibility: null })),
      request(db, visibilityPath(), jsonInit('PUT', { visibility: '' })),
      request(db, visibilityPath(), jsonInit('PUT', { visibility: ['public'] })),
    ]);
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(db.updates).toHaveLength(0);
  });

  it('GET visibility ∥ PUT alias ∥ DELETE missing — statuses isolate', async () => {
    const db = createAliasesDb({
      rooms: [room(ROOM, 1)],
      memberships: [joinedMember()],
    });
    const results = await Promise.all([
      request(db, visibilityPath()),
      request(db, aliasPath('#iso:example.com'), jsonInit('PUT', { room_id: ROOM })),
      request(db, aliasPath('#missing:example.com'), {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t' },
      }),
    ]);
    expect(results[0].status).toBe(200);
    expect(results[1].status).toBe(200);
    expect(results[2].status).toBe(404);
    expect(db.aliases.some((a) => a.alias === '#iso:example.com')).toBe(true);
  });

  for (let i = 0; i < 8; i++) {
    it(`null/empty room_id residual soft-${i}`, async () => {
      const db = createAliasesDb({
        rooms: [room()],
        memberships: [joinedMember()],
      });
      const body = i % 2 === 0 ? { room_id: null } : { room_id: '' };
      const results = await Promise.all([
        request(db, aliasPath(`#ne-${i}a:example.com`), jsonInit('PUT', body)),
        request(db, aliasPath(`#ne-${i}b:example.com`), jsonInit('PUT', body)),
      ]);
      expect(results.every((r) => r.status === 400)).toBe(true);
      expect(db.inserts).toHaveLength(0);
    });
  }
});
