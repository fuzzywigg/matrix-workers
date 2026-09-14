/**
 * TOKENMAXX HEAVY deepen — different slice: room tags API routes.
 * Avoids search (#94), key-backups (#96), oauth (#90), spaces (#89), devices/aliases/relations.
 * Tests-only — no product inventing.
 * Exercises own-user gate, membership, m.tag account_data CRUD edge cases.
 */
import { describe, expect, it, vi } from 'vitest';
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

import tags from '../src/api/tags';

const USER = '@alice:example.com';
const OTHER = '@bob:example.com';
const ROOM = '!room:example.com';
const USER_ENC = encodeURIComponent(USER);
const OTHER_ENC = encodeURIComponent(OTHER);
const ROOM_ENC = encodeURIComponent(ROOM);

type Membership = { room_id: string; user_id: string; membership: string };

type AccountDataRow = {
  user_id: string;
  room_id: string;
  event_type: string;
  content: string;
};

type SqlCall = { sql: string; args: unknown[] };

function createTagsDb(opts: {
  memberships?: Membership[];
  accountData?: AccountDataRow[];
} = {}) {
  const memberships = opts.memberships ?? [];
  const accountData = opts.accountData ?? [];
  const inserts: SqlCall[] = [];
  const selects: SqlCall[] = [];

  const db = {
    memberships,
    accountData,
    inserts,
    selects,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });

              if (sql.includes('FROM room_memberships')) {
                const [roomId, userId] = args as string[];
                const row = memberships.find(
                  (m) => m.room_id === roomId && m.user_id === userId
                );
                return (row ? { membership: row.membership } : null) as T;
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
                return (row ? { content: row.content } : null) as T;
              }

              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 140)}`);
            },

            async all<T>() {
              return { results: [] as T[] };
            },

            async run() {
              if (sql.includes('INSERT INTO account_data')) {
                inserts.push({ sql, args });
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
              throw new Error(`Unhandled run() SQL: ${sql.slice(0, 140)}`);
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
    SERVER_NAME: 'example.com',
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

const tagsPath = `/_matrix/client/v3/user/${USER_ENC}/rooms/${ROOM_ENC}/tags`;
const otherTagsPath = `/_matrix/client/v3/user/${OTHER_ENC}/rooms/${ROOM_ENC}/tags`;

describe('tags GET', () => {
  it('forbids reading another user tags', async () => {
    const db = createTagsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const res = await request(db, otherTagsPath, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot access tags for other users',
    });
  });

  it('forbids when membership row missing', async () => {
    const db = createTagsDb({ memberships: [] });
    const res = await request(db, tagsPath, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Not a member of this room' });
  });

  it('allows leave membership (any membership row is enough)', async () => {
    const db = createTagsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const res = await request(db, tagsPath, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: {} });
  });

  it('returns empty tags when no m.tag account_data', async () => {
    const db = createTagsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const res = await request(db, tagsPath, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: {} });
  });

  it('returns parsed tags map', async () => {
    const db = createTagsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      accountData: [
        {
          user_id: USER,
          room_id: ROOM,
          event_type: 'm.tag',
          content: JSON.stringify({
            tags: {
              'm.favourite': { order: 0.5 },
              'u.work': {},
            },
          }),
        },
      ],
    });
    const res = await request(db, tagsPath, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tags: {
        'm.favourite': { order: 0.5 },
        'u.work': {},
      },
    });
  });

  it('returns empty tags when content JSON corrupt', async () => {
    const db = createTagsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      accountData: [
        {
          user_id: USER,
          room_id: ROOM,
          event_type: 'm.tag',
          content: '{bad',
        },
      ],
    });
    const res = await request(db, tagsPath, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: {} });
  });

  it('returns empty tags when content.tags missing', async () => {
    const db = createTagsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      accountData: [
        {
          user_id: USER,
          room_id: ROOM,
          event_type: 'm.tag',
          content: JSON.stringify({ other: true }),
        },
      ],
    });
    const res = await request(db, tagsPath, {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tags: {} });
  });
});

describe('tags PUT', () => {
  it('forbids setting tags for another user', async () => {
    const db = createTagsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const res = await request(
      db,
      `${otherTagsPath}/m.favourite`,
      jsonInit('PUT', { order: 0.1 })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Cannot set tags for other users' });
  });

  it('forbids when not a member', async () => {
    const db = createTagsDb({ memberships: [] });
    const res = await request(
      db,
      `${tagsPath}/m.favourite`,
      jsonInit('PUT', { order: 0.1 })
    );
    expect(res.status).toBe(403);
  });

  it('creates m.tag account_data when none exists (empty body ok)', async () => {
    const db = createTagsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const res = await request(db, `${tagsPath}/m.favourite`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.inserts).toHaveLength(1);
    expect(JSON.parse(db.accountData[0].content)).toEqual({
      tags: { 'm.favourite': {} },
    });
  });

  it('merges new tag into existing tags map', async () => {
    const db = createTagsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      accountData: [
        {
          user_id: USER,
          room_id: ROOM,
          event_type: 'm.tag',
          content: JSON.stringify({ tags: { 'u.old': { order: 1 } } }),
        },
      ],
    });
    const res = await request(
      db,
      `${tagsPath}/m.favourite`,
      jsonInit('PUT', { order: 0.25 })
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(db.accountData[0].content)).toEqual({
      tags: {
        'u.old': { order: 1 },
        'm.favourite': { order: 0.25 },
      },
    });
  });

  it('overwrites existing tag content', async () => {
    const db = createTagsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      accountData: [
        {
          user_id: USER,
          room_id: ROOM,
          event_type: 'm.tag',
          content: JSON.stringify({ tags: { 'm.favourite': { order: 0.9 } } }),
        },
      ],
    });
    await request(
      db,
      `${tagsPath}/m.favourite`,
      jsonInit('PUT', { order: 0.1 })
    );
    expect(JSON.parse(db.accountData[0].content)).toEqual({
      tags: { 'm.favourite': { order: 0.1 } },
    });
  });

  it('starts fresh when existing content JSON is corrupt', async () => {
    const db = createTagsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      accountData: [
        {
          user_id: USER,
          room_id: ROOM,
          event_type: 'm.tag',
          content: 'not-json',
        },
      ],
    });
    await request(
      db,
      `${tagsPath}/u.work`,
      jsonInit('PUT', { order: 0 })
    );
    expect(JSON.parse(db.accountData[0].content)).toEqual({
      tags: { 'u.work': { order: 0 } },
    });
  });

  it('percent-decodes tag name in path', async () => {
    const db = createTagsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const tag = encodeURIComponent('u.my tag');
    const res = await request(
      db,
      `${tagsPath}/${tag}`,
      jsonInit('PUT', {})
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(db.accountData[0].content).tags).toHaveProperty('u.my tag');
  });
});

describe('tags DELETE', () => {
  it('forbids deleting another user tags', async () => {
    const db = createTagsDb();
    const res = await request(db, `${otherTagsPath}/m.favourite`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: 'Cannot delete tags for other users',
    });
  });

  it('no-ops successfully when no m.tag account_data', async () => {
    const db = createTagsDb({ accountData: [] });
    const res = await request(db, `${tagsPath}/m.favourite`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.inserts).toEqual([]);
  });

  it('no-ops when existing content JSON corrupt', async () => {
    const db = createTagsDb({
      accountData: [
        {
          user_id: USER,
          room_id: ROOM,
          event_type: 'm.tag',
          content: '{',
        },
      ],
    });
    const res = await request(db, `${tagsPath}/m.favourite`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(db.inserts).toEqual([]);
    expect(db.accountData[0].content).toBe('{');
  });

  it('removes one tag and persists remaining', async () => {
    const db = createTagsDb({
      accountData: [
        {
          user_id: USER,
          room_id: ROOM,
          event_type: 'm.tag',
          content: JSON.stringify({
            tags: {
              'm.favourite': { order: 0.5 },
              'm.lowpriority': {},
            },
          }),
        },
      ],
    });
    const res = await request(db, `${tagsPath}/m.favourite`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(db.accountData[0].content)).toEqual({
      tags: { 'm.lowpriority': {} },
    });
  });

  it('deleting unknown tag still rewrites account_data unchanged map', async () => {
    const db = createTagsDb({
      accountData: [
        {
          user_id: USER,
          room_id: ROOM,
          event_type: 'm.tag',
          content: JSON.stringify({ tags: { 'u.keep': {} } }),
        },
      ],
    });
    const res = await request(db, `${tagsPath}/u.missing`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(db.inserts).toHaveLength(1);
    expect(JSON.parse(db.accountData[0].content)).toEqual({
      tags: { 'u.keep': {} },
    });
  });

  it('handles content.tags missing by writing empty tags object', async () => {
    const db = createTagsDb({
      accountData: [
        {
          user_id: USER,
          room_id: ROOM,
          event_type: 'm.tag',
          content: JSON.stringify({}),
        },
      ],
    });
    const res = await request(db, `${tagsPath}/m.favourite`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(db.accountData[0].content)).toEqual({ tags: {} });
  });
});
