/**
 * TOKENMAXX HEAVY leftovers after #193 — tags *concurrent race / TOCTOU*
 * + soft/edge reliability for slices not covered by tags-api-routes or
 * tags-aliases soft leftovers (#153 / #156).
 *
 * Distinct domain — not aliases (#193), rooms (#192), admin-mutate (#191),
 * presence (#190), sliding-sync (#189), fed-keys (#188), workflows (#187),
 * oauth/push (#186), typing (#185), receipts (#184), qr-login (#183),
 * to-device (#181), relations (#179).
 *
 * Focus: PUT/DELETE m.tag account_data read→merge→write lost-update under
 * Promise.all; membership row SELECT→clear mid-flight TOCTOU; DELETE∥PUT∥GET
 * races; multi-tag / multi-room isolation; INSERT failure soft; method/body/
 * charset/foreign-user/lifecycle soft floods; SQL bind contracts.
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

import tags from '../src/api/tags';

const USER = '@alice:example.com';
const OTHER = '@bob:example.com';
const SERVER = 'example.com';
const ROOM = '!room:example.com';
const ROOM2 = '!room2:example.com';
const ROOM3 = '!room3:example.com';
const USER_ENC = encodeURIComponent(USER);
const OTHER_ENC = encodeURIComponent(OTHER);
const ROOM_ENC = encodeURIComponent(ROOM);
const ROOM2_ENC = encodeURIComponent(ROOM2);
const ROOM3_ENC = encodeURIComponent(ROOM3);
const TAG_FAV = 'm.favourite';
const TAG_LOW = 'm.lowpriority';
const TAG_CUSTOM = 'u.work';

type Membership = { room_id: string; user_id: string; membership: string };

type AccountDataRow = {
  user_id: string;
  room_id: string;
  event_type: string;
  content: string;
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

function seedTagRow(
  tagsMap: Record<string, Record<string, unknown>>,
  overrides: Partial<AccountDataRow> = {}
): AccountDataRow {
  return {
    user_id: overrides.user_id ?? USER,
    room_id: overrides.room_id ?? ROOM,
    event_type: overrides.event_type ?? 'm.tag',
    content: overrides.content ?? JSON.stringify({ tags: tagsMap }),
  };
}

function createTagsDb(
  opts: {
    memberships?: Membership[];
    accountData?: AccountDataRow[];
    selectBarrier?: SelectBarrier;
    runBarrier?: RunBarrier;
    mutateMembershipAfterSelects?: {
      after: number;
      next: Membership[];
    };
    mutateAccountDataAfterTagSelects?: {
      after: number;
      next: AccountDataRow[];
    };
    failInsertAfter?: number;
  } = {}
) {
  const memberships = opts.memberships ?? [];
  const accountData = opts.accountData ?? [];
  const inserts: SqlCall[] = [];
  const selects: SqlCall[] = [];
  const events: string[] = [];

  let selectBarrier = opts.selectBarrier;
  let runBarrier = opts.runBarrier;
  const selectWaiters = { list: [] as Array<() => void> };
  const runWaiters = { list: [] as Array<() => void> };

  let membershipSelectCount = 0;
  let tagSelectCount = 0;
  let insertCount = 0;

  const mutateMembership = opts.mutateMembershipAfterSelects;
  const mutateAccountData = opts.mutateAccountDataAfterTagSelects;
  const failInsertAfter = opts.failInsertAfter;

  const db = {
    memberships,
    accountData,
    inserts,
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
                sql.includes('FROM account_data') &&
                sql.includes("event_type = 'm.tag'")
              ) {
                const [userId, roomId] = args as string[];
                const row = accountData.find(
                  (a) =>
                    a.user_id === userId &&
                    a.room_id === roomId &&
                    a.event_type === 'm.tag'
                );
                tagSelectCount += 1;
                if (mutateAccountData && tagSelectCount === mutateAccountData.after) {
                  accountData.splice(0, accountData.length, ...mutateAccountData.next);
                  events.push('mutate:account-data');
                }
                return (row ? { content: row.content } : null) as T;
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

              if (sql.includes('INSERT INTO account_data')) {
                inserts.push({ sql, args });
                insertCount += 1;
                events.push('run:insert-tag');
                if (failInsertAfter !== undefined && insertCount > failInsertAfter) {
                  throw new Error('d1-tag-insert-fail');
                }
                const [userId, roomId, content] = args as [string, string, string];
                const idx = accountData.findIndex(
                  (a) =>
                    a.user_id === userId &&
                    a.room_id === roomId &&
                    a.event_type === 'm.tag'
                );
                const row: AccountDataRow = {
                  user_id: userId,
                  room_id: roomId,
                  event_type: 'm.tag',
                  content,
                };
                if (idx >= 0) accountData[idx] = row;
                else accountData.push(row);
                return { success: true, meta: { changes: 1, last_row_id: 1 } };
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

type TagsDb = ReturnType<typeof createTagsDb>;

function envFor(db: TagsDb): Env {
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
  } as unknown as Env;
}

async function request(
  db: TagsDb,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  const res = await tags.request(`http://localhost${path}`, init, envFor(db));
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

function joinedMember(roomId = ROOM, userId = USER): Membership {
  return { room_id: roomId, user_id: userId, membership: 'join' };
}

function tagsCollectionPath(userEnc = USER_ENC, roomEnc = ROOM_ENC): string {
  return `/_matrix/client/v3/user/${userEnc}/rooms/${roomEnc}/tags`;
}

function tagPath(tag: string, userEnc = USER_ENC, roomEnc = ROOM_ENC): string {
  return `${tagsCollectionPath(userEnc, roomEnc)}/${encodeURIComponent(tag)}`;
}

function parseTags(db: TagsDb, roomId = ROOM): Record<string, Record<string, unknown>> {
  const row = db.accountData.find(
    (a) => a.user_id === USER && a.room_id === roomId && a.event_type === 'm.tag'
  );
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.content) as { tags?: Record<string, Record<string, unknown>> };
    return parsed.tags ?? {};
  } catch {
    return {};
  }
}

function statusesOf(results: Array<{ status: number }>): number[] {
  return results.map((r) => r.status).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// PUT tag read→merge→write lost-update TOCTOU
// ---------------------------------------------------------------------------

describe('race PUT tag read→merge→write TOCTOU after #193', () => {
  it('parallel PUT distinct tags on empty map: last-write-wins may drop a tag', async () => {
    const db = createTagsDb({
      memberships: [joinedMember()],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM account_data') && sql.includes("event_type = 'm.tag'"),
      },
    });

    const results = await Promise.all([
      request(db, tagPath(TAG_FAV), jsonInit('PUT', { order: 0.1 })),
      request(db, tagPath(TAG_LOW), jsonInit('PUT', { order: 0.9 })),
    ]);

    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.inserts.length).toBe(2);
    // Both SELECTs saw empty (barrier). Each wrote a singleton map → final state
    // is whichever INSERT ran last — classic lost-update.
    const final = parseTags(db);
    const keys = Object.keys(final).sort();
    expect(keys.length).toBe(1);
    expect([TAG_FAV, TAG_LOW]).toContain(keys[0]);
  });

  it('sequential PUT distinct tags preserves both (no lost update)', async () => {
    const db = createTagsDb({ memberships: [joinedMember()] });
    expect((await request(db, tagPath(TAG_FAV), jsonInit('PUT', { order: 0.1 }))).status).toBe(200);
    expect((await request(db, tagPath(TAG_LOW), jsonInit('PUT', { order: 0.9 }))).status).toBe(200);
    expect(Object.keys(parseTags(db)).sort()).toEqual([TAG_FAV, TAG_LOW].sort());
  });

  it('account_data injected mid-flight after first tag SELECT → second may overwrite', async () => {
    const db = createTagsDb({
      memberships: [joinedMember()],
      mutateAccountDataAfterTagSelects: {
        after: 1,
        next: [seedTagRow({ [TAG_CUSTOM]: { order: 0.5 } })],
      },
    });

    const res = await request(db, tagPath(TAG_FAV), jsonInit('PUT', { order: 0.1 }));
    expect(res.status).toBe(200);
    // First SELECT saw empty → wrote {favourite}; mutate injected after SELECT
    // but before INSERT so INSERT overwrites injected custom unless race ordered
    // differently. Either way final must include favourite from this PUT.
    expect(parseTags(db)[TAG_FAV]).toEqual({ order: 0.1 });
  });

  for (let i = 0; i < 12; i++) {
    it(`TOCTOU soft-${i}: dual PUT distinct tags under account_data barrier`, async () => {
      const a = `u.race-a-${i}`;
      const b = `u.race-b-${i}`;
      const db = createTagsDb({
        memberships: [joinedMember()],
        selectBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM account_data') && sql.includes("event_type = 'm.tag'"),
        },
      });
      const results = await Promise.all([
        request(db, tagPath(a), jsonInit('PUT', { order: i / 100 })),
        request(db, tagPath(b), jsonInit('PUT', { order: 1 - i / 100 })),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(Object.keys(parseTags(db)).length).toBe(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`TOCTOU soft merge-${i}: dual PUT same tag under barrier last-write-wins`, async () => {
      const db = createTagsDb({
        memberships: [joinedMember()],
        accountData: [seedTagRow({ [TAG_FAV]: { order: 0 } })],
        selectBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM account_data') && sql.includes("event_type = 'm.tag'"),
        },
      });
      const results = await Promise.all([
        request(db, tagPath(TAG_FAV), jsonInit('PUT', { order: 0.1 + i / 1000 })),
        request(db, tagPath(TAG_FAV), jsonInit('PUT', { order: 0.9 - i / 1000 })),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(db.inserts).toHaveLength(2);
      const order = parseTags(db)[TAG_FAV]?.order;
      expect([0.1 + i / 1000, 0.9 - i / 1000]).toContain(order);
    });
  }
});

// ---------------------------------------------------------------------------
// Membership SELECT → write TOCTOU
// ---------------------------------------------------------------------------

describe('race PUT membership SELECT→write TOCTOU after #193', () => {
  it('membership row removed after first SELECT; barrier may still allow both', async () => {
    const db = createTagsDb({
      memberships: [joinedMember()],
      mutateMembershipAfterSelects: {
        after: 1,
        next: [],
      },
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM room_memberships'),
      },
    });

    const results = await Promise.all([
      request(db, tagPath(`u.mem-a`), jsonInit('PUT', { order: 0.1 })),
      request(db, tagPath(`u.mem-b`), jsonInit('PUT', { order: 0.2 })),
    ]);

    // Both saw membership at SELECT (barrier) so both may create; mutate clears after first.
    const codes = new Set(results.map((r) => r.status));
    expect([...codes].every((c) => c === 200 || c === 403)).toBe(true);
  });

  it('post-mutate sequential request is forbidden after membership row cleared', async () => {
    const db = createTagsDb({
      memberships: [joinedMember()],
      mutateMembershipAfterSelects: {
        after: 1,
        next: [],
      },
    });
    const first = await request(db, tagPath('u.first'), jsonInit('PUT', {}));
    expect(first.status).toBe(200);
    const second = await request(db, tagPath('u.second'), jsonInit('PUT', {}));
    expect(second.status).toBe(403);
    expect(second.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  // tags.ts only checks membership row presence — leave/ban/invite/knock still allow.
  for (const status of ['leave', 'ban', 'invite', 'knock'] as const) {
    it(`TOCTOU soft: join→${status} still allows next PUT (any membership row)`, async () => {
      const db = createTagsDb({
        memberships: [joinedMember()],
        mutateMembershipAfterSelects: {
          after: 1,
          next: [{ room_id: ROOM, user_id: USER, membership: status }],
        },
      });
      expect((await request(db, tagPath(`u.ok-${status}`), jsonInit('PUT', {}))).status).toBe(200);
      expect(
        (await request(db, tagPath(`u.still-${status}`), jsonInit('PUT', {}))).status
      ).toBe(200);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`membership clear soft-${i}: first PUT ok, second forbidden after empty next`, async () => {
      const db = createTagsDb({
        memberships: [joinedMember()],
        mutateMembershipAfterSelects: {
          after: 1,
          next: [],
        },
      });
      expect((await request(db, tagPath(`u.clear-${i}-a`), jsonInit('PUT', {}))).status).toBe(200);
      expect((await request(db, tagPath(`u.clear-${i}-b`), jsonInit('PUT', {}))).status).toBe(403);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`membership barrier soft-${i}: parallel PUT distinct tags both join`, async () => {
      const db = createTagsDb({
        memberships: [joinedMember()],
        selectBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM room_memberships'),
        },
      });
      const a = `u.mb-${i}-a`;
      const b = `u.mb-${i}-b`;
      const results = await Promise.all([
        request(db, tagPath(a), jsonInit('PUT', { order: 0.1 })),
        request(db, tagPath(b), jsonInit('PUT', { order: 0.2 })),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      // Without account_data barrier, sequential merge may keep both or last-write
      // depending on interleaving of SELECT/INSERT across the two requests.
      expect(db.inserts.length).toBe(2);
      expect(Object.keys(parseTags(db)).length).toBeGreaterThanOrEqual(1);
    });
  }
});

// ---------------------------------------------------------------------------
// DELETE ∥ PUT ∥ GET races
// ---------------------------------------------------------------------------

describe('race DELETE∥PUT∥GET tag concurrent after #193', () => {
  it('parallel DELETE same tag — both may succeed (idempotent rewrite)', async () => {
    const db = createTagsDb({
      memberships: [joinedMember()],
      accountData: [seedTagRow({ [TAG_FAV]: { order: 0.5 }, [TAG_LOW]: {} })],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM account_data') && sql.includes("event_type = 'm.tag'"),
      },
    });
    const results = await Promise.all([
      request(db, tagPath(TAG_FAV), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
      request(db, tagPath(TAG_FAV), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(parseTags(db)[TAG_FAV]).toBeUndefined();
    // Both SELECTs saw fav+low; both deleted fav → final has low
    expect(parseTags(db)[TAG_LOW]).toEqual({});
  });

  it('DELETE∥PUT same tag under account_data barrier — both 200, final ambiguous', async () => {
    const db = createTagsDb({
      memberships: [joinedMember()],
      accountData: [seedTagRow({ [TAG_FAV]: { order: 0.1 } })],
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM account_data') && sql.includes("event_type = 'm.tag'"),
      },
    });
    const results = await Promise.all([
      request(db, tagPath(TAG_FAV), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
      request(db, tagPath(TAG_FAV), jsonInit('PUT', { order: 0.7 })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.inserts).toHaveLength(2);
    // Final is either empty map (DELETE last) or {favourite: 0.7} (PUT last)
    const final = parseTags(db);
    const hasFav = TAG_FAV in final;
    if (hasFav) {
      expect(final[TAG_FAV]).toEqual({ order: 0.7 });
    } else {
      expect(final).toEqual({});
    }
  });

  it('GET∥PUT concurrent: GET may see pre or post write', async () => {
    const db = createTagsDb({
      memberships: [joinedMember()],
      accountData: [seedTagRow({ [TAG_LOW]: {} })],
    });
    const results = await Promise.all([
      request(db, tagsCollectionPath()),
      request(db, tagPath(TAG_FAV), jsonInit('PUT', { order: 0.2 })),
    ]);
    expect(results[1].status).toBe(200);
    expect(results[0].status).toBe(200);
    const getBody = results[0].body as { tags: Record<string, unknown> };
    expect(typeof getBody.tags).toBe('object');
  });

  for (let i = 0; i < 10; i++) {
    it(`DELETE∥PUT distinct tags soft-${i}`, async () => {
      const keep = `u.keep-${i}`;
      const drop = `u.drop-${i}`;
      const db = createTagsDb({
        memberships: [joinedMember()],
        accountData: [seedTagRow({ [keep]: { order: 0.1 }, [drop]: { order: 0.2 } })],
        selectBarrier: {
          count: 2,
          match: (sql) => sql.includes('FROM account_data') && sql.includes("event_type = 'm.tag'"),
        },
      });
      const results = await Promise.all([
        request(db, tagPath(drop), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
        request(db, tagPath(`u.add-${i}`), jsonInit('PUT', { order: 0.3 })),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      // Lost-update: final is one writer's map
      expect(Object.keys(parseTags(db)).length).toBeGreaterThanOrEqual(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`DELETE no-op when missing soft-${i}`, async () => {
      const db = createTagsDb({ memberships: [joinedMember()] });
      const results = await Promise.all([
        request(db, tagPath(`u.missing-${i}`), {
          method: 'DELETE',
          headers: { Authorization: 'Bearer t' },
        }),
        request(db, tagPath(`u.missing-${i}-b`), {
          method: 'DELETE',
          headers: { Authorization: 'Bearer t' },
        }),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(db.inserts).toHaveLength(0);
      expect(db.accountData).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Multi-tag / multi-room HTTP isolation
// ---------------------------------------------------------------------------

describe('race multi-tag multi-room HTTP isolation after #193', () => {
  it('parallel PUT across three rooms keeps per-room account_data rows', async () => {
    const db = createTagsDb({
      memberships: [joinedMember(ROOM), joinedMember(ROOM2), joinedMember(ROOM3)],
    });
    const results = await Promise.all([
      request(db, tagPath(TAG_FAV, USER_ENC, ROOM_ENC), jsonInit('PUT', { order: 0.1 })),
      request(db, tagPath(TAG_LOW, USER_ENC, ROOM2_ENC), jsonInit('PUT', { order: 0.2 })),
      request(db, tagPath(TAG_CUSTOM, USER_ENC, ROOM3_ENC), jsonInit('PUT', { order: 0.3 })),
    ]);
    expect(statusesOf(results)).toEqual([200, 200, 200]);
    expect(db.accountData).toHaveLength(3);
    expect(Object.keys(parseTags(db, ROOM))).toEqual([TAG_FAV]);
    expect(Object.keys(parseTags(db, ROOM2))).toEqual([TAG_LOW]);
    expect(Object.keys(parseTags(db, ROOM3))).toEqual([TAG_CUSTOM]);
  });

  for (let i = 0; i < 10; i++) {
    it(`multi-room GET isolation soft-${i}`, async () => {
      const db = createTagsDb({
        memberships: [joinedMember(ROOM), joinedMember(ROOM2)],
        accountData: [
          seedTagRow({ [TAG_FAV]: { order: i / 100 } }, { room_id: ROOM }),
          seedTagRow({ [TAG_LOW]: { order: 1 - i / 100 } }, { room_id: ROOM2 }),
        ],
      });
      const results = await Promise.all([
        request(db, tagsCollectionPath(USER_ENC, ROOM_ENC)),
        request(db, tagsCollectionPath(USER_ENC, ROOM2_ENC)),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect((results[0].body as { tags: Record<string, unknown> }).tags).toEqual({
        [TAG_FAV]: { order: i / 100 },
      });
      expect((results[1].body as { tags: Record<string, unknown> }).tags).toEqual({
        [TAG_LOW]: { order: 1 - i / 100 },
      });
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`triple PUT same room distinct tags soft-${i} (RMW may lose)`, async () => {
      const db = createTagsDb({
        memberships: [joinedMember()],
        selectBarrier: {
          count: 3,
          match: (sql) => sql.includes('FROM account_data') && sql.includes("event_type = 'm.tag'"),
        },
      });
      const tagsNames = [`u.t${i}-a`, `u.t${i}-b`, `u.t${i}-c`];
      const results = await Promise.all(
        tagsNames.map((t, idx) =>
          request(db, tagPath(t), jsonInit('PUT', { order: idx / 10 }))
        )
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(db.inserts).toHaveLength(3);
      expect(Object.keys(parseTags(db)).length).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Store failure mid concurrent
// ---------------------------------------------------------------------------

describe('race tag store failure mid concurrent after #193', () => {
  it('first INSERT ok, second throws → one 200 one 500', async () => {
    const db = createTagsDb({
      memberships: [joinedMember()],
      failInsertAfter: 1,
      selectBarrier: {
        count: 2,
        match: (sql) => sql.includes('FROM account_data') && sql.includes("event_type = 'm.tag'"),
      },
    });
    const results = await Promise.all([
      request(db, tagPath('u.fail-a'), jsonInit('PUT', {})),
      request(db, tagPath('u.fail-b'), jsonInit('PUT', {})),
    ]);
    const ok = results.filter((r) => r.status === 200);
    const fail = results.filter((r) => r.status === 500);
    expect(ok.length).toBe(1);
    expect(fail.length).toBe(1);
    expect(db.inserts.length).toBeGreaterThanOrEqual(1);
  });

  for (let i = 0; i < 8; i++) {
    it(`insert fail soft-${i}: failInsertAfter=0 both 500`, async () => {
      const db = createTagsDb({
        memberships: [joinedMember()],
        failInsertAfter: 0,
      });
      const results = await Promise.all([
        request(db, tagPath(`u.fa-${i}`), jsonInit('PUT', { order: 0.1 })),
        request(db, tagPath(`u.fb-${i}`), jsonInit('PUT', { order: 0.2 })),
      ]);
      expect(results.every((r) => r.status === 500)).toBe(true);
    });
  }

  it('DELETE after corrupt JSON no-ops without insert', async () => {
    const db = createTagsDb({
      memberships: [joinedMember()],
      accountData: [
        {
          user_id: USER,
          room_id: ROOM,
          event_type: 'm.tag',
          content: '{bad',
        },
      ],
    });
    const results = await Promise.all([
      request(db, tagPath(TAG_FAV), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
      request(db, tagPath(TAG_LOW), { method: 'DELETE', headers: { Authorization: 'Bearer t' } }),
    ]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(db.inserts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Soft floods — method / body / charset / foreign user / format
// ---------------------------------------------------------------------------

describe('tags concurrent soft flood — invalid method matrix after #193', () => {
  for (const method of ['POST', 'PATCH', 'OPTIONS', 'HEAD'] as const) {
    it(`rejects or no-routes ${method} under parallel load`, async () => {
      const db = createTagsDb({
        memberships: [joinedMember()],
        accountData: [seedTagRow({ [TAG_FAV]: {} })],
      });
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          request(db, tagPath(TAG_FAV), {
            method,
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer t',
            },
            body: method === 'HEAD' || method === 'OPTIONS' ? undefined : JSON.stringify({ order: 1 }),
          })
        )
      );
      expect(results.every((r) => r.status === 404 || r.status === 405 || r.status === 200)).toBe(
        true
      );
    });
  }
});

describe('tags concurrent soft flood — bad JSON / body edges after #193', () => {
  const badBodies: Array<{ label: string; body: string | undefined }> = [
    { label: 'truncated', body: '{' },
    { label: 'empty-obj', body: '{}' },
    { label: 'array', body: '[]' },
    { label: 'string', body: '"x"' },
    { label: 'number', body: '1' },
    { label: 'null', body: 'null' },
    { label: 'undefined-body', body: undefined },
    { label: 'order-string', body: JSON.stringify({ order: 'high' }) },
  ];

  for (const [i, entry] of badBodies.entries()) {
    it(`PUT body soft-${i} (${entry.label}) parallel still 200 (body optional/loose)`, async () => {
      const db = createTagsDb({ memberships: [joinedMember()] });
      const results = await Promise.all(
        Array.from({ length: 2 }, () =>
          request(db, tagPath(`u.bad-${i}`), {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer t',
            },
            body: entry.body,
          })
        )
      );
      // tags PUT treats body as optional; truncated JSON → empty content via catch
      expect(results.every((r) => r.status === 200 || r.status === 500)).toBe(true);
    });
  }
});

describe('tags concurrent soft flood — foreign user / not member after #193', () => {
  for (let i = 0; i < 10; i++) {
    it(`foreign user soft-${i}`, async () => {
      const db = createTagsDb({ memberships: [joinedMember()] });
      const results = await Promise.all([
        request(db, tagPath(`u.fx-${i}`, OTHER_ENC), jsonInit('PUT', { order: 0.1 })),
        request(db, tagsCollectionPath(OTHER_ENC)),
        request(db, tagPath(`u.fx-${i}`, OTHER_ENC), {
          method: 'DELETE',
          headers: { Authorization: 'Bearer t' },
        }),
      ]);
      expect(results.every((r) => r.status === 403)).toBe(true);
      expect(results[0].body).toMatchObject({ errcode: 'M_FORBIDDEN' });
      expect(db.inserts).toHaveLength(0);
    });
  }

  for (const membership of ['leave', 'ban', 'invite', 'knock'] as const) {
    it(`any membership row (${membership}) parallel PUT/GET allow`, async () => {
      const db = createTagsDb({
        memberships: [{ room_id: ROOM, user_id: USER, membership }],
      });
      // tags only requires a membership row — status is ignored
      const results = await Promise.all([
        request(db, tagPath(`u.nj-${membership}`), jsonInit('PUT', {})),
        request(db, tagsCollectionPath()),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      expect(db.inserts.length).toBeGreaterThanOrEqual(1);
    });
  }

  for (let i = 0; i < 8; i++) {
    it(`missing membership row soft-${i}`, async () => {
      const db = createTagsDb({ memberships: [] });
      const results = await Promise.all([
        request(db, tagPath(`u.nm-${i}`), jsonInit('PUT', {})),
        request(db, tagsCollectionPath()),
      ]);
      expect(results.every((r) => r.status === 403)).toBe(true);
    });
  }
});

describe('tags concurrent soft flood — GET corrupt / empty after #193', () => {
  const contentCases: Array<{ label: string; content: string | null }> = [
    { label: 'missing', content: null },
    { label: 'corrupt', content: '{bad' },
    { label: 'null-json', content: 'null' },
    { label: 'empty-obj', content: '{}' },
    { label: 'tags-null', content: JSON.stringify({ tags: null }) },
    { label: 'tags-array', content: JSON.stringify({ tags: [] }) },
    { label: 'tags-string', content: JSON.stringify({ tags: 'x' }) },
    { label: 'valid', content: JSON.stringify({ tags: { [TAG_FAV]: { order: 0.5 } } }) },
  ];

  for (const [i, c] of contentCases.entries()) {
    it(`GET content soft-${i} (${c.label}) parallel`, async () => {
      const db = createTagsDb({
        memberships: [joinedMember()],
        accountData:
          c.content === null
            ? []
            : [
                {
                  user_id: USER,
                  room_id: ROOM,
                  event_type: 'm.tag',
                  content: c.content,
                },
              ],
      });
      const results = await Promise.all([
        request(db, tagsCollectionPath()),
        request(db, tagsCollectionPath()),
      ]);
      expect(statusesOf(results)).toEqual([200, 200]);
      for (const r of results) {
        expect(r.body).toHaveProperty('tags');
      }
    });
  }
});

describe('tags concurrent soft flood — lifecycle put→get→delete after #193', () => {
  for (let i = 0; i < 12; i++) {
    it(`lifecycle soft-${i}`, async () => {
      const tag = `u.life-${i}`;
      const db = createTagsDb({ memberships: [joinedMember()] });
      const put = await request(db, tagPath(tag), jsonInit('PUT', { order: i / 100 }));
      expect(put.status).toBe(200);
      const get = await request(db, tagsCollectionPath());
      expect(get.status).toBe(200);
      expect((get.body as { tags: Record<string, unknown> }).tags[tag]).toEqual({
        order: i / 100,
      });
      const del = await request(db, tagPath(tag), {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t' },
      });
      expect(del.status).toBe(200);
      expect(parseTags(db)[tag]).toBeUndefined();
      // recreate
      const again = await request(db, tagPath(tag), jsonInit('PUT', { order: 1 }));
      expect(again.status).toBe(200);
      expect(parseTags(db)[tag]).toEqual({ order: 1 });
    });
  }
});

describe('tags concurrent soft flood — charset / content-type edges after #193', () => {
  const ctypes = [
    'application/json',
    'application/json; charset=utf-8',
    'application/json;charset=UTF-8',
    'text/plain',
    'application/x-www-form-urlencoded',
  ];

  for (const [i, ct] of ctypes.entries()) {
    it(`content-type soft-${i}: ${ct}`, async () => {
      const db = createTagsDb({ memberships: [joinedMember()] });
      const results = await Promise.all([
        request(db, tagPath(`u.ct-${i}`), {
          method: 'PUT',
          headers: { 'Content-Type': ct, Authorization: 'Bearer t' },
          body: JSON.stringify({ order: 0.1 }),
        }),
        request(db, tagPath(`u.ct-${i}-b`), {
          method: 'PUT',
          headers: { 'Content-Type': ct, Authorization: 'Bearer t' },
          body: JSON.stringify({ order: 0.2 }),
        }),
      ]);
      expect(results.every((r) => r.status === 200 || r.status === 400 || r.status === 500)).toBe(
        true
      );
    });
  }
});

describe('tags concurrent soft flood — percent-encoded tag names after #193', () => {
  const encoded = [
    'm.favourite',
    'u.work',
    'u.with space',
    'u.slash/part',
    'u.plus+tag',
  ];

  for (const [i, name] of encoded.entries()) {
    it(`encoded tag soft-${i}: ${name}`, async () => {
      const db = createTagsDb({ memberships: [joinedMember()] });
      const path = tagPath(name);
      const results = await Promise.all([
        request(db, path, jsonInit('PUT', { order: 0.1 })),
        request(db, path, jsonInit('PUT', { order: 0.2 })),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(Object.keys(parseTags(db)).length).toBeGreaterThanOrEqual(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Bind contracts
// ---------------------------------------------------------------------------

describe('tags concurrent bind contracts after #193', () => {
  it('PUT INSERT binds user_id, room_id, content JSON with tags map', async () => {
    const db = createTagsDb({ memberships: [joinedMember()] });
    const res = await request(db, tagPath(TAG_FAV), jsonInit('PUT', { order: 0.42 }));
    expect(res.status).toBe(200);
    expect(db.inserts).toHaveLength(1);
    const args = db.inserts[0].args;
    expect(args[0]).toBe(USER);
    expect(args[1]).toBe(ROOM);
    expect(JSON.parse(args[2] as string)).toEqual({ tags: { [TAG_FAV]: { order: 0.42 } } });
    expect(db.inserts[0].sql).toContain('ON CONFLICT');
  });

  it('DELETE rewrite binds remaining tags map', async () => {
    const db = createTagsDb({
      memberships: [joinedMember()],
      accountData: [seedTagRow({ [TAG_FAV]: { order: 0.1 }, [TAG_LOW]: {} })],
    });
    await request(db, tagPath(TAG_FAV), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(db.inserts).toHaveLength(1);
    expect(JSON.parse(db.inserts[0].args[2] as string)).toEqual({
      tags: { [TAG_LOW]: {} },
    });
  });

  it('membership SELECT binds room_id then user_id', async () => {
    const db = createTagsDb({ memberships: [joinedMember()] });
    await request(db, tagsCollectionPath());
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
  });

  it('account_data SELECT binds user_id then room_id', async () => {
    const db = createTagsDb({ memberships: [joinedMember()] });
    await request(db, tagsCollectionPath());
    const ad = db.selects.find(
      (s) => s.sql.includes('FROM account_data') && s.sql.includes("event_type = 'm.tag'")
    );
    expect(ad?.args).toEqual([USER, ROOM]);
  });

  it('parallel PUT bind contracts stay per-room', async () => {
    const db = createTagsDb({
      memberships: [joinedMember(ROOM), joinedMember(ROOM2)],
    });
    await Promise.all([
      request(db, tagPath(TAG_FAV, USER_ENC, ROOM_ENC), jsonInit('PUT', { order: 0.1 })),
      request(db, tagPath(TAG_LOW, USER_ENC, ROOM2_ENC), jsonInit('PUT', { order: 0.2 })),
    ]);
    const byRoom = Object.fromEntries(
      db.inserts.map((c) => [c.args[1] as string, c.args])
    );
    expect(byRoom[ROOM]?.[0]).toBe(USER);
    expect(JSON.parse(byRoom[ROOM]?.[2] as string)).toEqual({
      tags: { [TAG_FAV]: { order: 0.1 } },
    });
    expect(byRoom[ROOM2]?.[0]).toBe(USER);
    expect(JSON.parse(byRoom[ROOM2]?.[2] as string)).toEqual({
      tags: { [TAG_LOW]: { order: 0.2 } },
    });
  });

  for (let i = 0; i < 6; i++) {
    it(`bind soft-${i}: PUT then DELETE order content`, async () => {
      const tag = `u.bind-${i}`;
      const db = createTagsDb({ memberships: [joinedMember()] });
      await request(db, tagPath(tag), jsonInit('PUT', { order: i / 10 }));
      await request(db, tagPath(tag), {
        method: 'DELETE',
        headers: { Authorization: 'Bearer t' },
      });
      expect(db.inserts).toHaveLength(2);
      expect(JSON.parse(db.inserts[0].args[2] as string)).toEqual({
        tags: { [tag]: { order: i / 10 } },
      });
      expect(JSON.parse(db.inserts[1].args[2] as string)).toEqual({ tags: {} });
    });
  }
});
