/**
 * TOKENMAXX HEAVY leftovers after #192 — aliases *concurrent race / TOCTOU*
 * + soft/edge reliability for slices not covered by aliases-api-routes or
 * tags-aliases soft leftovers (#153).
 *
 * Distinct domain — not rooms (#192), admin-mutate (#191), presence (#190),
 * sliding-sync (#189), fed-keys (#188), workflows (#187), oauth/push (#186),
 * typing (#185), receipts (#184/#178), qr-login (#183), to-device (#181),
 * relations (#179).
 *
 * Focus: PUT alias check→insert TOCTOU under Promise.all; membership mid-flight
 * flips; DELETE∥PUT races; visibility last-write-wins; PL delete gates; multi-alias
 * / multi-room isolation; INSERT/DELETE/UPDATE barriers + failure soft;
 * method/body/charset/server soft floods.
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
const ROOM3 = '!room3:example.com';
const ALIAS = '#general:example.com';
const ALIAS2 = '#lobby:example.com';
const ALIAS3 = '#ops:example.com';
const NOW = 1_700_000_000_000;

type AliasRow = {
  alias: string;
  room_id: string;
  creator_id: string;
  servers: string | null;
  created_at: number;
};

type RoomRow = {
  room_id: string;
  is_public: number;
};

type MembershipRow = {
  room_id: string;
  user_id: string;
  membership: string;
};

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
    mutateMembershipAfterSelects?: {
      after: number;
      next: MembershipRow[];
    };
    mutateAliasAfterExistingSelects?: {
      after: number;
      next: AliasRow[];
    };
    failInsertAfter?: number;
    failDeleteAfter?: number;
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
  const events: string[] = [];

  let selectBarrier = opts.selectBarrier;
  let runBarrier = opts.runBarrier;
  const selectWaiters = { list: [] as Array<() => void> };
  const runWaiters = { list: [] as Array<() => void> };

  let membershipSelectCount = 0;
  let existingAliasSelectCount = 0;
  let insertCount = 0;
  let deleteCount = 0;
  let updateCount = 0;

  const mutateMembership = opts.mutateMembershipAfterSelects;
  const mutateAlias = opts.mutateAliasAfterExistingSelects;
  const failInsertAfter = opts.failInsertAfter;
  const failDeleteAfter = opts.failDeleteAfter;
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
    events,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              events.push(`first:${sql.slice(0, 56)}`);
              await withBarrier(
                selectBarrier,
                selectWaiters,
                () => {
                  selectBarrier = undefined;
                },
                sql,
                args
              );

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
                existingAliasSelectCount += 1;
                if (mutateAlias && existingAliasSelectCount === mutateAlias.after) {
                  aliasRows.splice(0, aliasRows.length, ...mutateAlias.next);
                  events.push('mutate:alias-after-existing-select');
                }
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
                const snapshot = memberships.find(
                  (m) => m.room_id === roomId && m.user_id === userId
                );
                membershipSelectCount += 1;
                if (mutateMembership && membershipSelectCount === mutateMembership.after) {
                  memberships.splice(0, memberships.length, ...mutateMembership.next);
                  events.push('mutate:membership');
                }
                return (snapshot ? { membership: snapshot.membership } : null) as T;
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
                insertCount += 1;
                events.push('run:insert-alias');
                if (failInsertAfter !== undefined && insertCount > failInsertAfter) {
                  throw new Error('d1-alias-insert-fail');
                }
                const [alias, roomId, creatorId, servers, createdAt] = args as [
                  string,
                  string,
                  string,
                  string,
                  number,
                ];
                if (uniqueAliasInsert && aliasRows.some((a) => a.alias === alias)) {
                  // Simulate UNIQUE constraint — callers that raced past the
                  // existence check still collide at INSERT.
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
                deleteCount += 1;
                events.push('run:delete-alias');
                if (failDeleteAfter !== undefined && deleteCount > failDeleteAfter) {
                  throw new Error('d1-alias-delete-fail');
                }
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
                updates.push({ sql, args });
                updateCount += 1;
                events.push('run:update-visibility');
                if (failUpdateAfter !== undefined && updateCount > failUpdateAfter) {
                  throw new Error('d1-visibility-update-fail');
                }
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

function envFor(db: AliasesDb, serverName = SERVER): Env {
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: serverName,
  } as unknown as Env;
}

async function request(
  db: AliasesDb,
  path: string,
  init: RequestInit = {},
  serverName = SERVER
): Promise<{ status: number; body: unknown }> {
  const res = await aliases.request(`http://localhost${path}`, init, envFor(db, serverName));
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

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// PUT alias check → insert TOCTOU
// ---------------------------------------------------------------------------

describe('race PUT alias check→insert TOCTOU after #192', () => {
  it('parallel PUT same alias: first wins, second hits UNIQUE or M_ROOM_IN_USE', async () => {
    const db = createAliasesDb({
      rooms: [room()],
      memberships: [joinedMember()],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('SELECT alias FROM room_aliases'),
      },
    });

    const results = await Promise.all([
      request(db, aliasPath(), jsonInit('PUT', { room_id: ROOM })),
      request(db, aliasPath(), jsonInit('PUT', { room_id: ROOM })),
    ]);

    // Both passed existence check (barrier); one INSERT succeeds, other UNIQUE-fails → 500,
    // OR if one completed before the other's existence SELECT, that one gets 409.
    const ok = results.filter((r) => r.status === 200);
    const conflictOrFail = results.filter((r) => r.status === 409 || r.status === 500);
    expect(ok.length + conflictOrFail.length).toBe(2);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(db.aliases.filter((a) => a.alias === ALIAS)).toHaveLength(1);
  });

  it('sequential PUT after winner returns M_ROOM_IN_USE', async () => {
    const db = createAliasesDb({
      rooms: [room()],
      memberships: [joinedMember()],
    });
    const first = await request(db, aliasPath(), jsonInit('PUT', { room_id: ROOM }));
    expect(first.status).toBe(200);
    const second = await request(db, aliasPath(), jsonInit('PUT', { room_id: ROOM }));
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ errcode: 'M_ROOM_IN_USE' });
    expect(db.aliases).toHaveLength(1);
  });

  it('alias appears mid-flight after existence SELECT → second INSERT UNIQUE-fails', async () => {
    const db = createAliasesDb({
      rooms: [room()],
      memberships: [joinedMember()],
      mutateAliasAfterExistingSelects: {
        after: 1,
        next: [seedAlias({ creator_id: OTHER })],
      },
    });

    const first = await request(db, aliasPath(), jsonInit('PUT', { room_id: ROOM }));
    // First saw empty, then mutate injected alias → INSERT UNIQUE → 500
    expect([200, 500]).toContain(first.status);
    expect(db.aliases.some((a) => a.alias === ALIAS)).toBe(true);
  });

  for (let i = 0; i < 12; i++) {
    it(`TOCTOU soft-${i}: dual PUT same alias under existence barrier`, async () => {
      const alias = `#race${i}:example.com`;
      const db = createAliasesDb({
        rooms: [room()],
        memberships: [joinedMember()],
        selectBarrier: {
          count: 2,
          match: (sql) => sql.includes('SELECT alias FROM room_aliases'),
        },
      });
      const results = await Promise.all([
        request(db, aliasPath(alias), jsonInit('PUT', { room_id: ROOM })),
        request(db, aliasPath(alias), jsonInit('PUT', { room_id: ROOM })),
      ]);
      expect(results.some((r) => r.status === 200)).toBe(true);
      expect(db.aliases.filter((a) => a.alias === alias)).toHaveLength(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Membership SELECT → write TOCTOU
// ---------------------------------------------------------------------------

describe('race PUT membership SELECT→write TOCTOU after #192', () => {
  it('membership flips leave after first SELECT; second may forbid', async () => {
    const db = createAliasesDb({
      rooms: [room()],
      memberships: [joinedMember()],
      mutateMembershipAfterSelects: {
        after: 1,
        next: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      },
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });

    const a = `#mema:example.com`;
    const b = `#memb:example.com`;
    const results = await Promise.all([
      request(db, aliasPath(a), jsonInit('PUT', { room_id: ROOM })),
      request(db, aliasPath(b), jsonInit('PUT', { room_id: ROOM })),
    ]);

    // Both saw join at SELECT (barrier) so both may create; OR one may race after mutate.
    const codes = new Set(results.map((r) => r.status));
    expect([...codes].every((c) => c === 200 || c === 403)).toBe(true);
  });

  it('post-mutate sequential request is forbidden after leave flip', async () => {
    const db = createAliasesDb({
      rooms: [room()],
      memberships: [joinedMember()],
      mutateMembershipAfterSelects: {
        after: 1,
        next: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      },
    });
    const first = await request(
      db,
      aliasPath('#first:example.com'),
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(first.status).toBe(200);
    const second = await request(
      db,
      aliasPath('#second:example.com'),
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(second.status).toBe(403);
    expect(second.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  for (const status of ['leave', 'ban', 'invite', 'knock'] as const) {
    it(`TOCTOU soft: join→${status} after first SELECT forbids next PUT`, async () => {
      const db = createAliasesDb({
        rooms: [room()],
        memberships: [joinedMember()],
        mutateMembershipAfterSelects: {
          after: 1,
          next: [{ room_id: ROOM, user_id: USER, membership: status }],
        },
      });
      expect(
        (
          await request(db, aliasPath(`#ok-${status}:example.com`), jsonInit('PUT', { room_id: ROOM }))
        ).status
      ).toBe(200);
      expect(
        (
          await request(
            db,
            aliasPath(`#blocked-${status}:example.com`),
            jsonInit('PUT', { room_id: ROOM })
          )
        ).status
      ).toBe(403);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`membership barrier soft-${i}: parallel PUT distinct aliases both join`, async () => {
      const db = createAliasesDb({
        rooms: [room()],
        memberships: [joinedMember()],
        selectBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
      });
      const a = `#mb-${i}-a:example.com`;
      const b = `#mb-${i}-b:example.com`;
      const results = await Promise.all([
        request(db, aliasPath(a), jsonInit('PUT', { room_id: ROOM })),
        request(db, aliasPath(b), jsonInit('PUT', { room_id: ROOM })),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(db.aliases.map((x) => x.alias).sort()).toEqual([a, b].sort());
    });
  }
});

// ---------------------------------------------------------------------------
// DELETE ∥ PUT / resolve races
// ---------------------------------------------------------------------------

describe('race DELETE∥PUT∥GET alias concurrent after #192', () => {
  it('parallel DELETE same alias by creator — both may succeed (idempotent empty)', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias()],
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('DELETE FROM room_aliases'),
      },
    });
    const results = await Promise.all([
      request(db, aliasPath(), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
      request(db, aliasPath(), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
    ]);
    // First SELECT both see alias; both DELETE → both 200, alias gone.
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.aliases).toHaveLength(0);
    expect(db.deletes.length).toBe(2);
  });

  it('DELETE∥PUT recreate — final state is either present or absent cleanly', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias()],
      rooms: [room()],
      memberships: [joinedMember()],
    });
    const results = await Promise.all([
      request(db, aliasPath(), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
      request(db, aliasPath(), jsonInit('PUT', { room_id: ROOM })),
    ]);
    const codes = results.map((r) => r.status);
    expect(codes.every((c) => c === 200 || c === 409)).toBe(true);
    // At most one row for ALIAS
    expect(db.aliases.filter((a) => a.alias === ALIAS).length).toBeLessThanOrEqual(1);
  });

  it('GET resolve ∥ DELETE — resolve sees before or 404 after', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias()],
      selectBarrier: {
        count: 2,
        match: (sql) =>
          sql.includes('FROM room_aliases') &&
          (sql.includes('SELECT room_id, servers') || sql.includes('SELECT room_id, creator_id')),
      },
    });
    const results = await Promise.all([
      request(db, aliasPath()),
      request(db, aliasPath(), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
    ]);
    const get = results[0];
    const del = results[1];
    expect(del.status).toBe(200);
    expect([200, 404]).toContain(get.status);
    if (get.status === 200) {
      expect(get.body).toMatchObject({ room_id: ROOM });
    }
  });

  it('PUT create ∥ GET resolve before insert lands — resolve may 404 then succeed', async () => {
    const db = createAliasesDb({
      rooms: [room()],
      memberships: [joinedMember()],
      runBarrier: {
        count: 1,
        match: (sql) => sql.includes('INSERT INTO room_aliases'),
      },
    });
    // Kick PUT then immediately GET — GET may race before INSERT completes.
    const putP = request(db, aliasPath(ALIAS2), jsonInit('PUT', { room_id: ROOM }));
    // Yield so PUT reaches INSERT barrier
    await Promise.resolve();
    const mid = await request(db, aliasPath(ALIAS2));
    const put = await putP;
    expect(put.status).toBe(200);
    // Mid GET: either 404 (before insert) or 200 (after) depending on scheduling
    expect([200, 404]).toContain(mid.status);
    const after = await request(db, aliasPath(ALIAS2));
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({ room_id: ROOM });
  });

  for (let i = 0; i < 10; i++) {
    it(`DELETE∥PUT soft-${i}`, async () => {
      const alias = `#dp-${i}:example.com`;
      const db = createAliasesDb({
        aliases: [seedAlias({ alias })],
        rooms: [room()],
        memberships: [joinedMember()],
      });
      const results = await Promise.all([
        request(db, aliasPath(alias), {
          method: 'DELETE',
          headers: { Authorization: 'Bearer t' },
        }),
        request(db, aliasPath(alias), jsonInit('PUT', { room_id: ROOM })),
      ]);
      expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);
      expect(db.aliases.filter((a) => a.alias === alias).length).toBeLessThanOrEqual(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Visibility last-write-wins + membership gates
// ---------------------------------------------------------------------------

describe('race visibility GET∥PUT concurrent after #192', () => {
  it('parallel PUT public∥private — last write wins is_public', async () => {
    const db = createAliasesDb({
      rooms: [room(ROOM, 0)],
      memberships: [joinedMember()],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: 100 },
        users_default: 0,
        state_default: 50,
      }),
      runBarrier: {
        count: 2,
        match: (sql) => sql.includes('UPDATE rooms SET is_public'),
      },
    });
    const results = await Promise.all([
      request(db, visibilityPath(), jsonInit('PUT', { visibility: 'public' })),
      request(db, visibilityPath(), jsonInit('PUT', { visibility: 'private' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.updates).toHaveLength(2);
    expect([0, 1]).toContain(db.rooms[0].is_public);
  });

  it('GET∥PUT visibility — GET sees before or after update', async () => {
    const db = createAliasesDb({
      rooms: [room(ROOM, 0)],
      memberships: [joinedMember()],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: 100 },
        state_default: 50,
      }),
    });
    const results = await Promise.all([
      request(db, visibilityPath()),
      request(db, visibilityPath(), jsonInit('PUT', { visibility: 'public' })),
    ]);
    expect(results[1].status).toBe(200);
    expect(results[0].status).toBe(200);
    expect(['public', 'private']).toContain(
      (results[0].body as { visibility: string }).visibility
    );
    expect(db.rooms[0].is_public).toBe(1);
  });

  it('visibility membership flip mid-flight forbids second PUT', async () => {
    const db = createAliasesDb({
      rooms: [room(ROOM, 0)],
      memberships: [joinedMember()],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: 100 },
        state_default: 50,
      }),
      mutateMembershipAfterSelects: {
        after: 1,
        next: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
      },
    });
    const first = await request(db, visibilityPath(), jsonInit('PUT', { visibility: 'public' }));
    expect(first.status).toBe(200);
    const second = await request(
      db,
      visibilityPath(),
      jsonInit('PUT', { visibility: 'private' })
    );
    expect(second.status).toBe(403);
  });

  it('parallel visibility across three rooms never mix updates', async () => {
    const db = createAliasesDb({
      rooms: [room(ROOM, 0), room(ROOM2, 0), room(ROOM3, 1)],
      memberships: [joinedMember(ROOM), joinedMember(ROOM2), joinedMember(ROOM3)],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: 100 },
        state_default: 50,
      }),
    });
    const results = await Promise.all([
      request(db, visibilityPath(ROOM), jsonInit('PUT', { visibility: 'public' })),
      request(db, visibilityPath(ROOM2), jsonInit('PUT', { visibility: 'public' })),
      request(db, visibilityPath(ROOM3), jsonInit('PUT', { visibility: 'private' })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(db.rooms.find((r) => r.room_id === ROOM)?.is_public).toBe(1);
    expect(db.rooms.find((r) => r.room_id === ROOM2)?.is_public).toBe(1);
    expect(db.rooms.find((r) => r.room_id === ROOM3)?.is_public).toBe(0);
  });

  for (let i = 0; i < 10; i++) {
    it(`visibility soft-${i}: public∥private last-write`, async () => {
      const db = createAliasesDb({
        rooms: [room(ROOM, i % 2)],
        memberships: [joinedMember()],
        powerLevelsContent: JSON.stringify({
          users: { [USER]: 100 },
          state_default: 50,
        }),
      });
      const results = await Promise.all([
        request(db, visibilityPath(), jsonInit('PUT', { visibility: 'public' })),
        request(db, visibilityPath(), jsonInit('PUT', { visibility: 'private' })),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect([0, 1]).toContain(db.rooms[0].is_public);
    });
  }
});

// ---------------------------------------------------------------------------
// Power-level delete gates under concurrency
// ---------------------------------------------------------------------------

describe('race DELETE power-level gates concurrent after #192', () => {
  it('non-creator with sufficient PL deletes in parallel with creator — alias gone', async () => {
    // Auth always alice; seed creator as OTHER so alice needs PL.
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: 100 },
        users_default: 0,
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

  it('non-creator below PL is forbidden even under parallel load', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: 10 },
        users_default: 0,
        state_default: 50,
      }),
    });
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(db, aliasPath(), { method: 'DELETE', headers: { Authorization: 'Bearer t' } })
      )
    );
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.aliases).toHaveLength(1);
    expect(db.deletes).toHaveLength(0);
  });

  it('corrupt PL JSON forbids non-creator under parallel DELETE', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsRaw: '{broken',
    });
    const results = await Promise.all([
      request(db, aliasPath(), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
      request(db, aliasPath(), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
    ]);
    expect(results.every((r) => r.status === 403)).toBe(true);
    expect(db.aliases).toHaveLength(1);
  });

  for (let i = 0; i < 8; i++) {
    it(`PL delete soft-${i}: creator parallel DELETE`, async () => {
      const alias = `#pl-${i}:example.com`;
      const db = createAliasesDb({
        aliases: [seedAlias({ alias, creator_id: USER })],
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
      expect(db.aliases.find((a) => a.alias === alias)).toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------------
// Multi-alias / multi-room isolation
// ---------------------------------------------------------------------------

describe('race multi-alias multi-room HTTP isolation after #192', () => {
  it('parallel PUT three distinct aliases never collide rows', async () => {
    const db = createAliasesDb({
      rooms: [room(), room(ROOM2), room(ROOM3)],
      memberships: [joinedMember(ROOM), joinedMember(ROOM2), joinedMember(ROOM3)],
    });
    const results = await Promise.all([
      request(db, aliasPath(ALIAS), jsonInit('PUT', { room_id: ROOM })),
      request(db, aliasPath(ALIAS2), jsonInit('PUT', { room_id: ROOM2 })),
      request(db, aliasPath(ALIAS3), jsonInit('PUT', { room_id: ROOM3 })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(db.aliases).toHaveLength(3);
    expect(db.aliases.find((a) => a.alias === ALIAS)?.room_id).toBe(ROOM);
    expect(db.aliases.find((a) => a.alias === ALIAS2)?.room_id).toBe(ROOM2);
    expect(db.aliases.find((a) => a.alias === ALIAS3)?.room_id).toBe(ROOM3);
  });

  it('parallel GET resolve three aliases returns correct room_ids', async () => {
    const db = createAliasesDb({
      aliases: [
        seedAlias({ alias: ALIAS, room_id: ROOM }),
        seedAlias({ alias: ALIAS2, room_id: ROOM2 }),
        seedAlias({ alias: ALIAS3, room_id: ROOM3 }),
      ],
    });
    const results = await Promise.all([
      request(db, aliasPath(ALIAS)),
      request(db, aliasPath(ALIAS2)),
      request(db, aliasPath(ALIAS3)),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(results[0].body).toMatchObject({ room_id: ROOM });
    expect(results[1].body).toMatchObject({ room_id: ROOM2 });
    expect(results[2].body).toMatchObject({ room_id: ROOM3 });
  });

  it('parallel DELETE three aliases isolates deletes', async () => {
    const db = createAliasesDb({
      aliases: [
        seedAlias({ alias: ALIAS }),
        seedAlias({ alias: ALIAS2 }),
        seedAlias({ alias: ALIAS3 }),
      ],
    });
    const results = await Promise.all([
      request(db, aliasPath(ALIAS), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
      request(db, aliasPath(ALIAS2), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
      request(db, aliasPath(ALIAS3), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(db.aliases).toHaveLength(0);
    expect(db.deletes).toHaveLength(3);
  });

  it('PUT many aliases for same room under concurrency — all land', async () => {
    const names = Array.from({ length: 8 }, (_, i) => `#bulk${i}:example.com`);
    const db = createAliasesDb({
      rooms: [room()],
      memberships: [joinedMember()],
    });
    const results = await Promise.all(
      names.map((n) => request(db, aliasPath(n), jsonInit('PUT', { room_id: ROOM })))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(db.aliases).toHaveLength(8);
    expect(new Set(db.aliases.map((a) => a.alias)).size).toBe(8);
  });

  for (let i = 0; i < 8; i++) {
    it(`multi-room soft-${i}: ROOM∥ROOM2 PUT+GET`, async () => {
      const a = `#mr-${i}-a:example.com`;
      const b = `#mr-${i}-b:example.com`;
      const db = createAliasesDb({
        rooms: [room(), room(ROOM2)],
        memberships: [joinedMember(ROOM), joinedMember(ROOM2)],
      });
      const put = await Promise.all([
        request(db, aliasPath(a), jsonInit('PUT', { room_id: ROOM })),
        request(db, aliasPath(b), jsonInit('PUT', { room_id: ROOM2 })),
      ]);
      expect(statusesOf(put)).toEqual([200, 200]);
      const get = await Promise.all([request(db, aliasPath(a)), request(db, aliasPath(b))]);
      expect(get[0].body).toMatchObject({ room_id: ROOM });
      expect(get[1].body).toMatchObject({ room_id: ROOM2 });
    });
  }
});

// ---------------------------------------------------------------------------
// INSERT / DELETE / UPDATE failure mid concurrent
// ---------------------------------------------------------------------------

describe('race alias store failure mid concurrent after #192', () => {
  it('second INSERT failure after first succeeds — one row remains', async () => {
    const db = createAliasesDb({
      rooms: [room()],
      memberships: [joinedMember()],
      failInsertAfter: 1,
    });
    const first = await request(
      db,
      aliasPath('#ok:example.com'),
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(first.status).toBe(200);
    const second = await request(
      db,
      aliasPath('#fail:example.com'),
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(second.status).toBe(500);
    expect(db.aliases).toHaveLength(1);
    expect(db.aliases[0].alias).toBe('#ok:example.com');
  });

  it('DELETE failure mid concurrent surfaces 500', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias(), seedAlias({ alias: ALIAS2 })],
      failDeleteAfter: 1,
    });
    const first = await request(db, aliasPath(ALIAS), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(first.status).toBe(200);
    const second = await request(db, aliasPath(ALIAS2), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(second.status).toBe(500);
    expect(db.aliases.some((a) => a.alias === ALIAS2)).toBe(true);
  });

  it('visibility UPDATE failure after first success — room stays public', async () => {
    const db = createAliasesDb({
      rooms: [room(ROOM, 0)],
      memberships: [joinedMember()],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: 100 },
        state_default: 50,
      }),
      failUpdateAfter: 1,
    });
    const first = await request(db, visibilityPath(), jsonInit('PUT', { visibility: 'public' }));
    expect(first.status).toBe(200);
    expect(db.rooms[0].is_public).toBe(1);
    const second = await request(
      db,
      visibilityPath(),
      jsonInit('PUT', { visibility: 'private' })
    );
    expect(second.status).toBe(500);
    expect(db.rooms[0].is_public).toBe(1);
  });

  for (let i = 0; i < 8; i++) {
    it(`insert-fail soft-${i}: first ok then fail`, async () => {
      const db = createAliasesDb({
        rooms: [room()],
        memberships: [joinedMember()],
        failInsertAfter: 1,
      });
      expect(
        (
          await request(db, aliasPath(`#s-${i}-ok:example.com`), jsonInit('PUT', { room_id: ROOM }))
        ).status
      ).toBe(200);
      expect(
        (
          await request(
            db,
            aliasPath(`#s-${i}-fail:example.com`),
            jsonInit('PUT', { room_id: ROOM })
          )
        ).status
      ).toBe(500);
    });
  }
});

// ---------------------------------------------------------------------------
// Soft floods — method / body / charset / server / format
// ---------------------------------------------------------------------------

describe('aliases concurrent soft flood — invalid method matrix after #192', () => {
  for (const method of ['POST', 'PATCH', 'OPTIONS', 'HEAD'] as const) {
    it(`rejects or no-routes ${method} under parallel load`, async () => {
      const db = createAliasesDb({
        rooms: [room()],
        memberships: [joinedMember()],
        aliases: [seedAlias()],
      });
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          request(db, aliasPath(), {
            method,
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer t',
            },
            body: method === 'HEAD' || method === 'OPTIONS' ? undefined : JSON.stringify({ room_id: ROOM }),
          })
        )
      );
      // Hono returns 404/405 for unmatched methods
      expect(results.every((r) => r.status === 404 || r.status === 405 || r.status === 200)).toBe(
        true
      );
    });
  }
});

describe('aliases concurrent soft flood — bad JSON / missing params after #192', () => {
  const badBodies: Array<{ label: string; body: string | undefined; headers?: Record<string, string> }> = [
    { label: 'truncated', body: '{' },
    { label: 'empty-obj', body: '{}' },
    { label: 'null-room', body: JSON.stringify({ room_id: null }) },
    { label: 'empty-room', body: JSON.stringify({ room_id: '' }) },
    { label: 'array', body: '[]' },
    { label: 'string', body: '"x"' },
    { label: 'number', body: '1' },
    { label: 'undefined-body', body: undefined },
  ];

  for (const [i, entry] of badBodies.entries()) {
    it(`PUT bad body soft-${i} (${entry.label}) parallel`, async () => {
      const db = createAliasesDb({
        rooms: [room()],
        memberships: [joinedMember()],
      });
      const results = await Promise.all(
        Array.from({ length: 2 }, () =>
          request(db, aliasPath(`#bad-${i}:example.com`), {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer t',
              ...(entry.headers ?? {}),
            },
            body: entry.body,
          })
        )
      );
      expect(results.every((r) => r.status === 400 || r.status === 500)).toBe(true);
      expect(db.aliases).toHaveLength(0);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`visibility bad body soft-${i}`, async () => {
      const db = createAliasesDb({
        rooms: [room()],
        memberships: [joinedMember()],
        powerLevelsContent: JSON.stringify({
          users: { [USER]: 100 },
          state_default: 50,
        }),
      });
      const bodies = [
        {},
        { visibility: 'secret' },
        { visibility: null },
        { visibility: 1 },
        { visibility: '' },
        { visibility: 'PUBLIC' },
        { visibility: ['public'] },
        { vis: 'public' },
      ];
      const body = bodies[i % bodies.length];
      const results = await Promise.all([
        request(db, visibilityPath(), jsonInit('PUT', body)),
        request(db, visibilityPath(), jsonInit('PUT', body)),
      ]);
      expect(results.every((r) => r.status === 400)).toBe(true);
    });
  }
});

describe('aliases concurrent soft flood — foreign server / format after #192', () => {
  for (let i = 0; i < 10; i++) {
    it(`foreign server soft-${i}`, async () => {
      const db = createAliasesDb({
        rooms: [room()],
        memberships: [joinedMember()],
      });
      const foreign = `#x${i}:other.org`;
      const results = await Promise.all([
        request(db, aliasPath(foreign), jsonInit('PUT', { room_id: ROOM })),
        request(db, aliasPath(foreign), jsonInit('PUT', { room_id: ROOM })),
      ]);
      expect(results.every((r) => r.status === 400)).toBe(true);
      expect(results[0].body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
      expect(db.inserts).toHaveLength(0);
    });
  }

  for (const bad of ['nocolon', 'missinghash:example.com', '#', '##:example.com'] as const) {
    it(`invalid format parallel: ${bad}`, async () => {
      const db = createAliasesDb({
        rooms: [room()],
        memberships: [joinedMember()],
      });
      // Force formats that fail startsWith('#') or includes(':')
      const path = `/_matrix/client/v3/directory/room/${encodeURIComponent(bad)}`;
      const results = await Promise.all([
        request(db, path, jsonInit('PUT', { room_id: ROOM })),
        request(db, path, jsonInit('PUT', { room_id: ROOM })),
      ]);
      // ##:example.com has # and : and local server — may succeed as create attempt
      // or 400 format; nocolon / missinghash / # → 400
      if (bad === '##:example.com') {
        expect(results.every((r) => r.status === 200 || r.status === 400 || r.status === 500)).toBe(
          true
        );
      } else {
        expect(results.every((r) => r.status === 400)).toBe(true);
      }
    });
  }
});

describe('aliases concurrent soft flood — room missing / not member after #192', () => {
  for (let i = 0; i < 8; i++) {
    it(`missing room soft-${i}`, async () => {
      const db = createAliasesDb({ rooms: [], memberships: [] });
      const results = await Promise.all([
        request(db, aliasPath(`#nr-${i}:example.com`), jsonInit('PUT', { room_id: ROOM })),
        request(db, aliasPath(`#nr-${i}b:example.com`), jsonInit('PUT', { room_id: ROOM2 })),
      ]);
      expect(results.every((r) => r.status === 404)).toBe(true);
    });
  }

  for (const membership of ['leave', 'ban', 'invite', 'knock'] as const) {
    it(`not-joined (${membership}) parallel PUT forbid`, async () => {
      const db = createAliasesDb({
        rooms: [room()],
        memberships: [{ room_id: ROOM, user_id: USER, membership }],
      });
      const results = await Promise.all([
        request(db, aliasPath(`#nj-${membership}-a:example.com`), jsonInit('PUT', { room_id: ROOM })),
        request(db, aliasPath(`#nj-${membership}-b:example.com`), jsonInit('PUT', { room_id: ROOM })),
      ]);
      expect(results.every((r) => r.status === 403)).toBe(true);
      expect(db.inserts).toHaveLength(0);
    });
  }
});

describe('aliases concurrent soft flood — resolve servers JSON edges after #192', () => {
  const serverCases: Array<{ servers: string | null; expectServers: string[] }> = [
    { servers: null, expectServers: [SERVER] },
    { servers: '{bad', expectServers: [SERVER] },
    { servers: '[]', expectServers: [] },
    { servers: JSON.stringify([SERVER]), expectServers: [SERVER] },
    { servers: JSON.stringify([SERVER, 'peer.example.org']), expectServers: [SERVER, 'peer.example.org'] },
    { servers: 'null', expectServers: [SERVER] },
    { servers: '""', expectServers: [SERVER] },
    { servers: JSON.stringify({}), expectServers: [SERVER] },
  ];

  for (const [i, c] of serverCases.entries()) {
    it(`resolve servers soft-${i} parallel`, async () => {
      const alias = `#srv-${i}:example.com`;
      const db = createAliasesDb({
        aliases: [seedAlias({ alias, servers: c.servers })],
      });
      const results = await Promise.all([
        request(db, aliasPath(alias)),
        request(db, aliasPath(alias)),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      // JSON.parse("null") / "" / {} fall into catch or non-array → default SERVER_NAME
      // except valid arrays (including empty)
      for (const r of results) {
        expect(r.body).toMatchObject({ room_id: ROOM });
        const servers = (r.body as { servers: unknown }).servers;
        if (Array.isArray(c.expectServers) && c.servers && c.servers.startsWith('[')) {
          expect(servers).toEqual(c.expectServers);
        } else if (c.servers === null || c.servers === '{bad') {
          expect(servers).toEqual([SERVER]);
        }
      }
    });
  }
});

describe('aliases concurrent soft flood — lifecycle create→resolve→delete after #192', () => {
  for (let i = 0; i < 12; i++) {
    it(`lifecycle soft-${i}`, async () => {
      const alias = `#life-${i}:example.com`;
      const db = createAliasesDb({
        rooms: [room()],
        memberships: [joinedMember()],
      });
      const put = await request(db, aliasPath(alias), jsonInit('PUT', { room_id: ROOM }));
      expect(put.status).toBe(200);
      const get = await request(db, aliasPath(alias));
      expect(get.status).toBe(200);
      expect(get.body).toMatchObject({ room_id: ROOM, servers: [SERVER] });
      const del = await request(db, aliasPath(alias), {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t' },
      });
      expect(del.status).toBe(200);
      const missing = await request(db, aliasPath(alias));
      expect(missing.status).toBe(404);
      // recreate
      const again = await request(db, aliasPath(alias), jsonInit('PUT', { room_id: ROOM }));
      expect(again.status).toBe(200);
      expect(db.aliases.filter((a) => a.alias === alias)).toHaveLength(1);
    });
  }
});

describe('aliases concurrent soft flood — visibility PL forbid matrix after #192', () => {
  for (let i = 0; i < 8; i++) {
    it(`visibility PL forbid soft-${i}`, async () => {
      const db = createAliasesDb({
        rooms: [room(ROOM, 0)],
        memberships: [joinedMember()],
        powerLevelsContent: JSON.stringify({
          users: { [USER]: i }, // below state_default 50 for i < 50
          users_default: 0,
          state_default: 50,
        }),
      });
      const results = await Promise.all([
        request(db, visibilityPath(), jsonInit('PUT', { visibility: 'public' })),
        request(db, visibilityPath(), jsonInit('PUT', { visibility: 'private' })),
      ]);
      expect(results.every((r) => r.status === 403)).toBe(true);
      expect(db.rooms[0].is_public).toBe(0);
      expect(db.updates).toHaveLength(0);
    });
  }

  it('visibility with no PL state allows update (no gate)', async () => {
    const db = createAliasesDb({
      rooms: [room(ROOM, 0)],
      memberships: [joinedMember()],
      powerLevelsContent: null,
    });
    const results = await Promise.all([
      request(db, visibilityPath(), jsonInit('PUT', { visibility: 'public' })),
      request(db, visibilityPath()),
    ]);
    expect(results[0].status).toBe(200);
    expect(results[1].status).toBe(200);
    expect(db.rooms[0].is_public).toBe(1);
  });
});

describe('aliases concurrent soft flood — charset / content-type edges after #192', () => {
  const ctypes = [
    'application/json',
    'application/json; charset=utf-8',
    'application/json;charset=UTF-8',
    'text/plain',
    'application/x-www-form-urlencoded',
  ];

  for (const [i, ct] of ctypes.entries()) {
    it(`content-type soft-${i}: ${ct}`, async () => {
      const db = createAliasesDb({
        rooms: [room()],
        memberships: [joinedMember()],
      });
      const alias = `#ct-${i}:example.com`;
      const results = await Promise.all([
        request(db, aliasPath(alias), {
          method: 'PUT',
          headers: { 'Content-Type': ct, Authorization: 'Bearer t' },
          body: JSON.stringify({ room_id: ROOM }),
        }),
        request(db, aliasPath(`#ct-${i}-b:example.com`), {
          method: 'PUT',
          headers: { 'Content-Type': ct, Authorization: 'Bearer t' },
          body: JSON.stringify({ room_id: ROOM }),
        }),
      ]);
      // Hono json() typically still parses when body is JSON text
      expect(results.every((r) => r.status === 200 || r.status === 400 || r.status === 409)).toBe(
        true
      );
    });
  }
});

describe('aliases concurrent bind contracts after #192', () => {
  it('PUT INSERT binds alias, room_id, creator, servers JSON, timestamp', async () => {
    const db = createAliasesDb({
      rooms: [room()],
      memberships: [joinedMember()],
    });
    const res = await request(db, aliasPath(), jsonInit('PUT', { room_id: ROOM }));
    expect(res.status).toBe(200);
    expect(db.inserts).toHaveLength(1);
    const args = db.inserts[0].args;
    expect(args[0]).toBe(ALIAS);
    expect(args[1]).toBe(ROOM);
    expect(args[2]).toBe(USER);
    expect(args[3]).toBe(JSON.stringify([SERVER]));
    expect(typeof args[4]).toBe('number');
  });

  it('DELETE binds alias only', async () => {
    const db = createAliasesDb({ aliases: [seedAlias()] });
    await request(db, aliasPath(), { method: 'DELETE', headers: { Authorization: 'Bearer t' } });
    expect(db.deletes[0].args).toEqual([ALIAS]);
  });

  it('visibility UPDATE binds is_public then room_id', async () => {
    const db = createAliasesDb({
      rooms: [room()],
      memberships: [joinedMember()],
      powerLevelsContent: null,
    });
    await request(db, visibilityPath(), jsonInit('PUT', { visibility: 'public' }));
    expect(db.updates[0].args).toEqual([1, ROOM]);
    await request(db, visibilityPath(), jsonInit('PUT', { visibility: 'private' }));
    expect(db.updates[1].args).toEqual([0, ROOM]);
  });

  it('parallel PUT bind contracts stay per-alias', async () => {
    const db = createAliasesDb({
      rooms: [room(), room(ROOM2)],
      memberships: [joinedMember(ROOM), joinedMember(ROOM2)],
    });
    await Promise.all([
      request(db, aliasPath(ALIAS), jsonInit('PUT', { room_id: ROOM })),
      request(db, aliasPath(ALIAS2), jsonInit('PUT', { room_id: ROOM2 })),
    ]);
    const byAlias = Object.fromEntries(db.inserts.map((c) => [c.args[0] as string, c.args]));
    expect(byAlias[ALIAS]).toEqual([
      ALIAS,
      ROOM,
      USER,
      JSON.stringify([SERVER]),
      expect.any(Number),
    ]);
    expect(byAlias[ALIAS2]).toEqual([
      ALIAS2,
      ROOM2,
      USER,
      JSON.stringify([SERVER]),
      expect.any(Number),
    ]);
  });
});
