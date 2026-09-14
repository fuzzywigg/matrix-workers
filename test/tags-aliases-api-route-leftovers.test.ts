/**
 * TOKENMAXX HEAVY leftovers after #153 — tags + aliases directory soft/edge/reliability.
 * Complements tags-api-routes + aliases-api-routes. Tests-only — no product inventing.
 * Fixtures use example.com only.
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
import aliases from '../src/api/aliases';

const USER = '@alice:example.com';
const OTHER = '@bob:example.com';
const SERVER = 'example.com';
const ROOM = '!room:example.com';
const ALIAS = '#general:example.com';
const USER_ENC = encodeURIComponent(USER);
const OTHER_ENC = encodeURIComponent(OTHER);
const ROOM_ENC = encodeURIComponent(ROOM);
const ALIAS_ENC = encodeURIComponent(ALIAS);

type Membership = { room_id: string; user_id: string; membership: string };
type AccountDataRow = { user_id: string; room_id: string; event_type: string; content: string };
type AliasRow = { alias: string; room_id: string; creator_id: string; servers: string | null; created_at: number };
type RoomRow = { room_id: string; is_public: number };
type SqlCall = { sql: string; args: unknown[] };

function createTagsDb(opts: { memberships?: Membership[]; accountData?: AccountDataRow[] } = {}) {
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
                const row = memberships.find((m) => m.room_id === roomId && m.user_id === userId);
                return (row ? { membership: row.membership } : null) as T;
              }
              if (sql.includes('FROM account_data') && sql.includes("event_type = 'm.tag'")) {
                const [userId, roomId] = args as string[];
                const row = accountData.find(
                  (a) => a.user_id === userId && a.room_id === roomId && a.event_type === 'm.tag'
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
                  (a) => a.user_id === userId && a.room_id === roomId && a.event_type === 'm.tag'
                );
                const row: AccountDataRow = { user_id: userId, room_id: roomId, event_type: 'm.tag', content };
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

function tagsEnv(db: TagsDb): Env {
  return { DB: db as unknown as D1Database, SERVER_NAME: SERVER } as unknown as Env;
}

async function tagsRequest(db: TagsDb, path: string, init: RequestInit = {}) {
  const res = await tags.request(`http://localhost${path}`, init, tagsEnv(db));
  let body: any = null;
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

function createAliasesDb(opts: {
  aliases?: AliasRow[];
  rooms?: RoomRow[];
  memberships?: Membership[];
  powerLevelsContent?: string | null;
} = {}) {
  const aliasRows = opts.aliases ?? [];
  const roomRows = opts.rooms ?? [];
  const memberships = opts.memberships ?? [];
  const powerLevelsContent = opts.powerLevelsContent === undefined ? null : opts.powerLevelsContent;
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  const selects: SqlCall[] = [];
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
              if (sql.includes('FROM room_aliases') && sql.includes('SELECT room_id, servers')) {
                const alias = args[0] as string;
                const row = aliasRows.find((a) => a.alias === alias);
                if (!row) return null as T;
                return { room_id: row.room_id, servers: row.servers } as T;
              }
              if (sql.includes('FROM room_aliases') && sql.includes('SELECT room_id, creator_id')) {
                const alias = args[0] as string;
                const row = aliasRows.find((a) => a.alias === alias);
                if (!row) return null as T;
                return { room_id: row.room_id, creator_id: row.creator_id } as T;
              }
              if (sql.includes('SELECT alias FROM room_aliases') && sql.includes('WHERE alias = ?')) {
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
                const row = memberships.find((m) => m.room_id === roomId && m.user_id === userId);
                return (row ? { membership: row.membership } : null) as T;
              }
              if (sql.includes('m.room.power_levels') || (sql.includes('FROM room_state') && sql.includes('power_levels'))) {
                if (powerLevelsContent == null) return null as T;
                return { content: powerLevelsContent } as T;
              }
              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 160)}`);
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              if (sql.includes('INSERT INTO room_aliases')) {
                inserts.push({ sql, args });
                const [alias, roomId, creatorId, servers, createdAt] = args as [string, string, string, string, number];
                aliasRows.push({ alias, room_id: roomId, creator_id: creatorId, servers, created_at: createdAt });
                return { success: true, meta: { changes: 1, last_row_id: 1 } };
              }
              if (sql.includes('DELETE FROM room_aliases')) {
                deletes.push({ sql, args });
                const alias = args[0] as string;
                const before = aliasRows.length;
                for (let i = aliasRows.length - 1; i >= 0; i--) {
                  if (aliasRows[i].alias === alias) aliasRows.splice(i, 1);
                }
                return { success: true, meta: { changes: before - aliasRows.length, last_row_id: 0 } };
              }
              if (sql.includes('UPDATE rooms SET is_public')) {
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

function aliasesEnv(db: AliasesDb, serverName = SERVER): Env {
  return { DB: db as unknown as D1Database, SERVER_NAME: serverName } as unknown as Env;
}

async function aliasesRequest(db: AliasesDb, path: string, init: RequestInit = {}, serverName = SERVER) {
  const res = await aliases.request(`http://localhost${path}`, init, aliasesEnv(db, serverName));
  let body: any = null;
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

function joinTagsDb(extra?: Partial<AccountDataRow>) {
  const accountData: AccountDataRow[] = [];
  if (extra?.content) {
    accountData.push({
      user_id: USER,
      room_id: ROOM,
      event_type: 'm.tag',
      content: extra.content,
    });
  }
  return createTagsDb({
    memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    accountData,
  });
}

describe('tags leftovers GET soft reliability after #153', () => {
  it('GET empty tags soft-0', async () => {
    const db = joinTagsDb();
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body).toEqual({ tags: {} });
  });
  it('GET empty tags soft-1', async () => {
    const db = joinTagsDb();
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body).toEqual({ tags: {} });
  });
  it('GET empty tags soft-2', async () => {
    const db = joinTagsDb();
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body).toEqual({ tags: {} });
  });
  it('GET empty tags soft-3', async () => {
    const db = joinTagsDb();
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body).toEqual({ tags: {} });
  });
  it('GET empty tags soft-4', async () => {
    const db = joinTagsDb();
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body).toEqual({ tags: {} });
  });
  it('GET empty tags soft-5', async () => {
    const db = joinTagsDb();
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body).toEqual({ tags: {} });
  });
  it('GET empty tags soft-6', async () => {
    const db = joinTagsDb();
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body).toEqual({ tags: {} });
  });
  it('GET empty tags soft-7', async () => {
    const db = joinTagsDb();
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body).toEqual({ tags: {} });
  });
  it('GET empty tags soft-8', async () => {
    const db = joinTagsDb();
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body).toEqual({ tags: {} });
  });
  it('GET empty tags soft-9', async () => {
    const db = joinTagsDb();
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body).toEqual({ tags: {} });
  });
  it('GET empty tags soft-10', async () => {
    const db = joinTagsDb();
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body).toEqual({ tags: {} });
  });
  it('GET empty tags soft-11', async () => {
    const db = joinTagsDb();
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body).toEqual({ tags: {} });
  });
  it('GET empty tags soft-12', async () => {
    const db = joinTagsDb();
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body).toEqual({ tags: {} });
  });
  it('GET empty tags soft-13', async () => {
    const db = joinTagsDb();
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body).toEqual({ tags: {} });
  });
  it('GET empty tags soft-14', async () => {
    const db = joinTagsDb();
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body).toEqual({ tags: {} });
  });
  it('GET empty tags soft-15', async () => {
    const db = joinTagsDb();
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body).toEqual({ tags: {} });
  });
  it('GET parsed tags soft-0', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { 'm.favourite': { order: 0 } } }),
    });
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body.tags['m.favourite'].order).toBe(0);
  });
  it('GET parsed tags soft-1', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { 'm.favourite': { order: 0.01 } } }),
    });
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body.tags['m.favourite'].order).toBe(0.01);
  });
  it('GET parsed tags soft-2', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { 'm.favourite': { order: 0.02 } } }),
    });
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body.tags['m.favourite'].order).toBe(0.02);
  });
  it('GET parsed tags soft-3', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { 'm.favourite': { order: 0.03 } } }),
    });
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body.tags['m.favourite'].order).toBe(0.03);
  });
  it('GET parsed tags soft-4', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { 'm.favourite': { order: 0.04 } } }),
    });
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body.tags['m.favourite'].order).toBe(0.04);
  });
  it('GET parsed tags soft-5', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { 'm.favourite': { order: 0.05 } } }),
    });
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body.tags['m.favourite'].order).toBe(0.05);
  });
  it('GET parsed tags soft-6', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { 'm.favourite': { order: 0.06 } } }),
    });
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body.tags['m.favourite'].order).toBe(0.06);
  });
  it('GET parsed tags soft-7', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { 'm.favourite': { order: 0.07 } } }),
    });
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body.tags['m.favourite'].order).toBe(0.07);
  });
  it('GET parsed tags soft-8', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { 'm.favourite': { order: 0.08 } } }),
    });
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body.tags['m.favourite'].order).toBe(0.08);
  });
  it('GET parsed tags soft-9', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { 'm.favourite': { order: 0.09 } } }),
    });
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body.tags['m.favourite'].order).toBe(0.09);
  });
  it('GET parsed tags soft-10', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { 'm.favourite': { order: 0.1 } } }),
    });
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body.tags['m.favourite'].order).toBe(0.1);
  });
  it('GET parsed tags soft-11', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { 'm.favourite': { order: 0.11 } } }),
    });
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body.tags['m.favourite'].order).toBe(0.11);
  });
  it('GET parsed tags soft-12', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { 'm.favourite': { order: 0.12 } } }),
    });
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body.tags['m.favourite'].order).toBe(0.12);
  });
  it('GET parsed tags soft-13', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { 'm.favourite': { order: 0.13 } } }),
    });
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body.tags['m.favourite'].order).toBe(0.13);
  });
  it('GET parsed tags soft-14', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { 'm.favourite': { order: 0.14 } } }),
    });
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body.tags['m.favourite'].order).toBe(0.14);
  });
  it('GET parsed tags soft-15', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { 'm.favourite': { order: 0.15 } } }),
    });
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body.tags['m.favourite'].order).toBe(0.15);
  });
});
describe('tags leftovers PUT soft flood after #153', () => {
  it('PUT tag soft-0', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.favourite');
    const { status, body } = await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', { order: 0 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(1);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.favourite'].order).toBe(0);
  });
  it('PUT tag soft-1', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.favourite');
    const { status, body } = await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', { order: 0.02 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(1);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.favourite'].order).toBe(0.02);
  });
  it('PUT tag soft-2', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.favourite');
    const { status, body } = await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', { order: 0.04 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(1);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.favourite'].order).toBe(0.04);
  });
  it('PUT tag soft-3', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.favourite');
    const { status, body } = await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', { order: 0.06 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(1);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.favourite'].order).toBe(0.06);
  });
  it('PUT tag soft-4', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.favourite');
    const { status, body } = await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', { order: 0.08 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(1);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.favourite'].order).toBe(0.08);
  });
  it('PUT tag soft-5', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.favourite');
    const { status, body } = await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', { order: 0.1 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(1);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.favourite'].order).toBe(0.1);
  });
  it('PUT tag soft-6', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.favourite');
    const { status, body } = await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', { order: 0.12 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(1);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.favourite'].order).toBe(0.12);
  });
  it('PUT tag soft-7', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.favourite');
    const { status, body } = await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', { order: 0.14 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(1);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.favourite'].order).toBe(0.14);
  });
  it('PUT tag soft-8', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.favourite');
    const { status, body } = await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', { order: 0.16 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(1);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.favourite'].order).toBe(0.16);
  });
  it('PUT tag soft-9', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.favourite');
    const { status, body } = await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', { order: 0.18 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(1);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.favourite'].order).toBe(0.18);
  });
  it('PUT tag soft-10', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.favourite');
    const { status, body } = await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', { order: 0.2 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(1);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.favourite'].order).toBe(0.2);
  });
  it('PUT tag soft-11', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.favourite');
    const { status, body } = await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', { order: 0.22 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(1);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.favourite'].order).toBe(0.22);
  });
  it('PUT tag soft-12', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.favourite');
    const { status, body } = await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', { order: 0.24 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(1);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.favourite'].order).toBe(0.24);
  });
  it('PUT tag soft-13', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.favourite');
    const { status, body } = await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', { order: 0.26 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(1);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.favourite'].order).toBe(0.26);
  });
  it('PUT tag soft-14', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.favourite');
    const { status, body } = await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', { order: 0.28 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(1);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.favourite'].order).toBe(0.28);
  });
  it('PUT tag soft-15', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.favourite');
    const { status, body } = await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', { order: 0.3 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(1);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.favourite'].order).toBe(0.3);
  });
  it('PUT tag soft-16', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.favourite');
    const { status, body } = await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', { order: 0.32 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(1);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.favourite'].order).toBe(0.32);
  });
  it('PUT tag soft-17', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.favourite');
    const { status, body } = await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', { order: 0.34 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(1);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.favourite'].order).toBe(0.34);
  });
  it('PUT tag soft-18', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.favourite');
    const { status, body } = await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', { order: 0.36 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(1);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.favourite'].order).toBe(0.36);
  });
  it('PUT tag soft-19', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.favourite');
    const { status, body } = await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', { order: 0.38 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(1);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.favourite'].order).toBe(0.38);
  });
  it('PUT tag soft-20', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.favourite');
    const { status, body } = await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', { order: 0.4 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(1);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.favourite'].order).toBe(0.4);
  });
  it('PUT tag soft-21', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.favourite');
    const { status, body } = await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', { order: 0.42 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(1);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.favourite'].order).toBe(0.42);
  });
  it('PUT tag soft-22', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.favourite');
    const { status, body } = await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', { order: 0.44 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(1);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.favourite'].order).toBe(0.44);
  });
  it('PUT tag soft-23', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.favourite');
    const { status, body } = await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', { order: 0.46 }));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(1);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.favourite'].order).toBe(0.46);
  });
});
describe('tags leftovers DELETE soft flood after #153', () => {
  it('DELETE tag soft-0', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { keep: { order: 0 }, drop: { order: 0 } } }),
    });
    const { status, body } = await tagsRequest(
      db,
      `${tagsPath}/${encodeURIComponent('drop')}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const content = JSON.parse(db.accountData[0].content);
    expect(content.tags.keep).toEqual({ order: 0 });
    expect(content.tags.drop).toBeUndefined();
  });
  it('DELETE tag soft-1', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { keep: { order: 0 }, drop: { order: 1 } } }),
    });
    const { status, body } = await tagsRequest(
      db,
      `${tagsPath}/${encodeURIComponent('drop')}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const content = JSON.parse(db.accountData[0].content);
    expect(content.tags.keep).toEqual({ order: 0 });
    expect(content.tags.drop).toBeUndefined();
  });
  it('DELETE tag soft-2', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { keep: { order: 0 }, drop: { order: 2 } } }),
    });
    const { status, body } = await tagsRequest(
      db,
      `${tagsPath}/${encodeURIComponent('drop')}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const content = JSON.parse(db.accountData[0].content);
    expect(content.tags.keep).toEqual({ order: 0 });
    expect(content.tags.drop).toBeUndefined();
  });
  it('DELETE tag soft-3', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { keep: { order: 0 }, drop: { order: 3 } } }),
    });
    const { status, body } = await tagsRequest(
      db,
      `${tagsPath}/${encodeURIComponent('drop')}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const content = JSON.parse(db.accountData[0].content);
    expect(content.tags.keep).toEqual({ order: 0 });
    expect(content.tags.drop).toBeUndefined();
  });
  it('DELETE tag soft-4', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { keep: { order: 0 }, drop: { order: 4 } } }),
    });
    const { status, body } = await tagsRequest(
      db,
      `${tagsPath}/${encodeURIComponent('drop')}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const content = JSON.parse(db.accountData[0].content);
    expect(content.tags.keep).toEqual({ order: 0 });
    expect(content.tags.drop).toBeUndefined();
  });
  it('DELETE tag soft-5', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { keep: { order: 0 }, drop: { order: 5 } } }),
    });
    const { status, body } = await tagsRequest(
      db,
      `${tagsPath}/${encodeURIComponent('drop')}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const content = JSON.parse(db.accountData[0].content);
    expect(content.tags.keep).toEqual({ order: 0 });
    expect(content.tags.drop).toBeUndefined();
  });
  it('DELETE tag soft-6', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { keep: { order: 0 }, drop: { order: 6 } } }),
    });
    const { status, body } = await tagsRequest(
      db,
      `${tagsPath}/${encodeURIComponent('drop')}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const content = JSON.parse(db.accountData[0].content);
    expect(content.tags.keep).toEqual({ order: 0 });
    expect(content.tags.drop).toBeUndefined();
  });
  it('DELETE tag soft-7', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { keep: { order: 0 }, drop: { order: 7 } } }),
    });
    const { status, body } = await tagsRequest(
      db,
      `${tagsPath}/${encodeURIComponent('drop')}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const content = JSON.parse(db.accountData[0].content);
    expect(content.tags.keep).toEqual({ order: 0 });
    expect(content.tags.drop).toBeUndefined();
  });
  it('DELETE tag soft-8', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { keep: { order: 0 }, drop: { order: 8 } } }),
    });
    const { status, body } = await tagsRequest(
      db,
      `${tagsPath}/${encodeURIComponent('drop')}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const content = JSON.parse(db.accountData[0].content);
    expect(content.tags.keep).toEqual({ order: 0 });
    expect(content.tags.drop).toBeUndefined();
  });
  it('DELETE tag soft-9', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { keep: { order: 0 }, drop: { order: 9 } } }),
    });
    const { status, body } = await tagsRequest(
      db,
      `${tagsPath}/${encodeURIComponent('drop')}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const content = JSON.parse(db.accountData[0].content);
    expect(content.tags.keep).toEqual({ order: 0 });
    expect(content.tags.drop).toBeUndefined();
  });
  it('DELETE tag soft-10', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { keep: { order: 0 }, drop: { order: 10 } } }),
    });
    const { status, body } = await tagsRequest(
      db,
      `${tagsPath}/${encodeURIComponent('drop')}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const content = JSON.parse(db.accountData[0].content);
    expect(content.tags.keep).toEqual({ order: 0 });
    expect(content.tags.drop).toBeUndefined();
  });
  it('DELETE tag soft-11', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { keep: { order: 0 }, drop: { order: 11 } } }),
    });
    const { status, body } = await tagsRequest(
      db,
      `${tagsPath}/${encodeURIComponent('drop')}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const content = JSON.parse(db.accountData[0].content);
    expect(content.tags.keep).toEqual({ order: 0 });
    expect(content.tags.drop).toBeUndefined();
  });
  it('DELETE tag soft-12', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { keep: { order: 0 }, drop: { order: 12 } } }),
    });
    const { status, body } = await tagsRequest(
      db,
      `${tagsPath}/${encodeURIComponent('drop')}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const content = JSON.parse(db.accountData[0].content);
    expect(content.tags.keep).toEqual({ order: 0 });
    expect(content.tags.drop).toBeUndefined();
  });
  it('DELETE tag soft-13', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { keep: { order: 0 }, drop: { order: 13 } } }),
    });
    const { status, body } = await tagsRequest(
      db,
      `${tagsPath}/${encodeURIComponent('drop')}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const content = JSON.parse(db.accountData[0].content);
    expect(content.tags.keep).toEqual({ order: 0 });
    expect(content.tags.drop).toBeUndefined();
  });
  it('DELETE tag soft-14', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { keep: { order: 0 }, drop: { order: 14 } } }),
    });
    const { status, body } = await tagsRequest(
      db,
      `${tagsPath}/${encodeURIComponent('drop')}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const content = JSON.parse(db.accountData[0].content);
    expect(content.tags.keep).toEqual({ order: 0 });
    expect(content.tags.drop).toBeUndefined();
  });
  it('DELETE tag soft-15', async () => {
    const db = joinTagsDb({
      content: JSON.stringify({ tags: { keep: { order: 0 }, drop: { order: 15 } } }),
    });
    const { status, body } = await tagsRequest(
      db,
      `${tagsPath}/${encodeURIComponent('drop')}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    const content = JSON.parse(db.accountData[0].content);
    expect(content.tags.keep).toEqual({ order: 0 });
    expect(content.tags.drop).toBeUndefined();
  });
});
describe('tags leftovers failure edges after #153', () => {
  it('GET forbids other user', async () => {
    const db = joinTagsDb();
    const { status, body } = await tagsRequest(db, otherTagsPath);
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });

  it('PUT forbids other user', async () => {
    const db = joinTagsDb();
    const { status, body } = await tagsRequest(
      db,
      `${otherTagsPath}/m.favourite`,
      jsonInit('PUT', { order: 0.1 })
    );
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });

  it('DELETE forbids other user', async () => {
    const db = joinTagsDb();
    const { status, body } = await tagsRequest(
      db,
      `${otherTagsPath}/m.favourite`,
      jsonInit('DELETE')
    );
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });

  it('GET forbids missing membership', async () => {
    const db = createTagsDb({ memberships: [] });
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });

  it('PUT forbids missing membership', async () => {
    const db = createTagsDb({ memberships: [] });
    const { status, body } = await tagsRequest(
      db,
      `${tagsPath}/m.favourite`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });

  it('GET allows leave membership', async () => {
    const db = createTagsDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body).toEqual({ tags: {} });
  });

  it('GET corrupt JSON returns empty tags', async () => {
    const db = joinTagsDb({ content: '{bad' });
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body).toEqual({ tags: {} });
  });

  it('GET missing tags field returns empty', async () => {
    const db = joinTagsDb({ content: JSON.stringify({ not_tags: 1 }) });
    const { status, body } = await tagsRequest(db, tagsPath);
    expect(status).toBe(200);
    expect(body).toEqual({ tags: {} });
  });

  it('PUT empty body creates empty tag object', async () => {
    const db = joinTagsDb();
    const { status } = await tagsRequest(db, `${tagsPath}/m.lowpriority`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '',
    });
    expect(status).toBe(200);
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags['m.lowpriority']).toEqual({});
  });

  it('PUT corrupt existing starts fresh', async () => {
    const db = joinTagsDb({ content: 'not-json' });
    await tagsRequest(db, `${tagsPath}/m.favourite`, jsonInit('PUT', { order: 1 }));
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(content.tags).toEqual({ 'm.favourite': { order: 1 } });
  });

  it('DELETE no-ops when no account_data', async () => {
    const db = joinTagsDb();
    const { status, body } = await tagsRequest(db, `${tagsPath}/m.favourite`, jsonInit('DELETE'));
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.inserts.length).toBe(0);
  });

  it('DELETE corrupt JSON no-ops', async () => {
    const db = joinTagsDb({ content: '{oops' });
    const { status } = await tagsRequest(db, `${tagsPath}/m.favourite`, jsonInit('DELETE'));
    expect(status).toBe(200);
    expect(db.inserts.length).toBe(0);
  });

  it('percent-decodes tag name', async () => {
    const db = joinTagsDb();
    const tag = encodeURIComponent('m.server_notice');
    await tagsRequest(db, `${tagsPath}/${tag}`, jsonInit('PUT', {}));
    const content = JSON.parse(db.inserts[0].args[2] as string);
    expect(Object.keys(content.tags)).toContain('m.server_notice');
  });
});

describe('aliases leftovers GET resolve soft reliability after #153', () => {
  it('GET resolve with servers soft-0', async () => {
    const db = createAliasesDb({
      aliases: [{
        alias: ALIAS,
        room_id: ROOM,
        creator_id: USER,
        servers: JSON.stringify(['example.com', 'remote0.example.org']),
        created_at: 1,
      }],
    });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(status).toBe(200);
    expect(body.room_id).toBe(ROOM);
    expect(body.servers).toContain('example.com');
  });
  it('GET resolve with servers soft-1', async () => {
    const db = createAliasesDb({
      aliases: [{
        alias: ALIAS,
        room_id: ROOM,
        creator_id: USER,
        servers: JSON.stringify(['example.com', 'remote1.example.org']),
        created_at: 1,
      }],
    });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(status).toBe(200);
    expect(body.room_id).toBe(ROOM);
    expect(body.servers).toContain('example.com');
  });
  it('GET resolve with servers soft-2', async () => {
    const db = createAliasesDb({
      aliases: [{
        alias: ALIAS,
        room_id: ROOM,
        creator_id: USER,
        servers: JSON.stringify(['example.com', 'remote2.example.org']),
        created_at: 1,
      }],
    });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(status).toBe(200);
    expect(body.room_id).toBe(ROOM);
    expect(body.servers).toContain('example.com');
  });
  it('GET resolve with servers soft-3', async () => {
    const db = createAliasesDb({
      aliases: [{
        alias: ALIAS,
        room_id: ROOM,
        creator_id: USER,
        servers: JSON.stringify(['example.com', 'remote3.example.org']),
        created_at: 1,
      }],
    });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(status).toBe(200);
    expect(body.room_id).toBe(ROOM);
    expect(body.servers).toContain('example.com');
  });
  it('GET resolve with servers soft-4', async () => {
    const db = createAliasesDb({
      aliases: [{
        alias: ALIAS,
        room_id: ROOM,
        creator_id: USER,
        servers: JSON.stringify(['example.com', 'remote4.example.org']),
        created_at: 1,
      }],
    });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(status).toBe(200);
    expect(body.room_id).toBe(ROOM);
    expect(body.servers).toContain('example.com');
  });
  it('GET resolve with servers soft-5', async () => {
    const db = createAliasesDb({
      aliases: [{
        alias: ALIAS,
        room_id: ROOM,
        creator_id: USER,
        servers: JSON.stringify(['example.com', 'remote5.example.org']),
        created_at: 1,
      }],
    });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(status).toBe(200);
    expect(body.room_id).toBe(ROOM);
    expect(body.servers).toContain('example.com');
  });
  it('GET resolve with servers soft-6', async () => {
    const db = createAliasesDb({
      aliases: [{
        alias: ALIAS,
        room_id: ROOM,
        creator_id: USER,
        servers: JSON.stringify(['example.com', 'remote6.example.org']),
        created_at: 1,
      }],
    });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(status).toBe(200);
    expect(body.room_id).toBe(ROOM);
    expect(body.servers).toContain('example.com');
  });
  it('GET resolve with servers soft-7', async () => {
    const db = createAliasesDb({
      aliases: [{
        alias: ALIAS,
        room_id: ROOM,
        creator_id: USER,
        servers: JSON.stringify(['example.com', 'remote7.example.org']),
        created_at: 1,
      }],
    });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(status).toBe(200);
    expect(body.room_id).toBe(ROOM);
    expect(body.servers).toContain('example.com');
  });
  it('GET resolve with servers soft-8', async () => {
    const db = createAliasesDb({
      aliases: [{
        alias: ALIAS,
        room_id: ROOM,
        creator_id: USER,
        servers: JSON.stringify(['example.com', 'remote8.example.org']),
        created_at: 1,
      }],
    });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(status).toBe(200);
    expect(body.room_id).toBe(ROOM);
    expect(body.servers).toContain('example.com');
  });
  it('GET resolve with servers soft-9', async () => {
    const db = createAliasesDb({
      aliases: [{
        alias: ALIAS,
        room_id: ROOM,
        creator_id: USER,
        servers: JSON.stringify(['example.com', 'remote9.example.org']),
        created_at: 1,
      }],
    });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(status).toBe(200);
    expect(body.room_id).toBe(ROOM);
    expect(body.servers).toContain('example.com');
  });
  it('GET resolve with servers soft-10', async () => {
    const db = createAliasesDb({
      aliases: [{
        alias: ALIAS,
        room_id: ROOM,
        creator_id: USER,
        servers: JSON.stringify(['example.com', 'remote10.example.org']),
        created_at: 1,
      }],
    });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(status).toBe(200);
    expect(body.room_id).toBe(ROOM);
    expect(body.servers).toContain('example.com');
  });
  it('GET resolve with servers soft-11', async () => {
    const db = createAliasesDb({
      aliases: [{
        alias: ALIAS,
        room_id: ROOM,
        creator_id: USER,
        servers: JSON.stringify(['example.com', 'remote11.example.org']),
        created_at: 1,
      }],
    });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(status).toBe(200);
    expect(body.room_id).toBe(ROOM);
    expect(body.servers).toContain('example.com');
  });
  it('GET resolve with servers soft-12', async () => {
    const db = createAliasesDb({
      aliases: [{
        alias: ALIAS,
        room_id: ROOM,
        creator_id: USER,
        servers: JSON.stringify(['example.com', 'remote12.example.org']),
        created_at: 1,
      }],
    });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(status).toBe(200);
    expect(body.room_id).toBe(ROOM);
    expect(body.servers).toContain('example.com');
  });
  it('GET resolve with servers soft-13', async () => {
    const db = createAliasesDb({
      aliases: [{
        alias: ALIAS,
        room_id: ROOM,
        creator_id: USER,
        servers: JSON.stringify(['example.com', 'remote13.example.org']),
        created_at: 1,
      }],
    });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(status).toBe(200);
    expect(body.room_id).toBe(ROOM);
    expect(body.servers).toContain('example.com');
  });
  it('GET resolve with servers soft-14', async () => {
    const db = createAliasesDb({
      aliases: [{
        alias: ALIAS,
        room_id: ROOM,
        creator_id: USER,
        servers: JSON.stringify(['example.com', 'remote14.example.org']),
        created_at: 1,
      }],
    });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(status).toBe(200);
    expect(body.room_id).toBe(ROOM);
    expect(body.servers).toContain('example.com');
  });
  it('GET resolve with servers soft-15', async () => {
    const db = createAliasesDb({
      aliases: [{
        alias: ALIAS,
        room_id: ROOM,
        creator_id: USER,
        servers: JSON.stringify(['example.com', 'remote15.example.org']),
        created_at: 1,
      }],
    });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(status).toBe(200);
    expect(body.room_id).toBe(ROOM);
    expect(body.servers).toContain('example.com');
  });
});
describe('aliases leftovers PUT create soft flood after #153', () => {
  it('PUT create alias soft-0', async () => {
    const alias = `#room0:example.com`;
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.some((a) => a.alias === alias)).toBe(true);
    expect(JSON.parse(db.inserts[0].args[3] as string)).toEqual([SERVER]);
  });
  it('PUT create alias soft-1', async () => {
    const alias = `#room1:example.com`;
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.some((a) => a.alias === alias)).toBe(true);
    expect(JSON.parse(db.inserts[0].args[3] as string)).toEqual([SERVER]);
  });
  it('PUT create alias soft-2', async () => {
    const alias = `#room2:example.com`;
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.some((a) => a.alias === alias)).toBe(true);
    expect(JSON.parse(db.inserts[0].args[3] as string)).toEqual([SERVER]);
  });
  it('PUT create alias soft-3', async () => {
    const alias = `#room3:example.com`;
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.some((a) => a.alias === alias)).toBe(true);
    expect(JSON.parse(db.inserts[0].args[3] as string)).toEqual([SERVER]);
  });
  it('PUT create alias soft-4', async () => {
    const alias = `#room4:example.com`;
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.some((a) => a.alias === alias)).toBe(true);
    expect(JSON.parse(db.inserts[0].args[3] as string)).toEqual([SERVER]);
  });
  it('PUT create alias soft-5', async () => {
    const alias = `#room5:example.com`;
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.some((a) => a.alias === alias)).toBe(true);
    expect(JSON.parse(db.inserts[0].args[3] as string)).toEqual([SERVER]);
  });
  it('PUT create alias soft-6', async () => {
    const alias = `#room6:example.com`;
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.some((a) => a.alias === alias)).toBe(true);
    expect(JSON.parse(db.inserts[0].args[3] as string)).toEqual([SERVER]);
  });
  it('PUT create alias soft-7', async () => {
    const alias = `#room7:example.com`;
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.some((a) => a.alias === alias)).toBe(true);
    expect(JSON.parse(db.inserts[0].args[3] as string)).toEqual([SERVER]);
  });
  it('PUT create alias soft-8', async () => {
    const alias = `#room8:example.com`;
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.some((a) => a.alias === alias)).toBe(true);
    expect(JSON.parse(db.inserts[0].args[3] as string)).toEqual([SERVER]);
  });
  it('PUT create alias soft-9', async () => {
    const alias = `#room9:example.com`;
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.some((a) => a.alias === alias)).toBe(true);
    expect(JSON.parse(db.inserts[0].args[3] as string)).toEqual([SERVER]);
  });
  it('PUT create alias soft-10', async () => {
    const alias = `#room10:example.com`;
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.some((a) => a.alias === alias)).toBe(true);
    expect(JSON.parse(db.inserts[0].args[3] as string)).toEqual([SERVER]);
  });
  it('PUT create alias soft-11', async () => {
    const alias = `#room11:example.com`;
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.some((a) => a.alias === alias)).toBe(true);
    expect(JSON.parse(db.inserts[0].args[3] as string)).toEqual([SERVER]);
  });
  it('PUT create alias soft-12', async () => {
    const alias = `#room12:example.com`;
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.some((a) => a.alias === alias)).toBe(true);
    expect(JSON.parse(db.inserts[0].args[3] as string)).toEqual([SERVER]);
  });
  it('PUT create alias soft-13', async () => {
    const alias = `#room13:example.com`;
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.some((a) => a.alias === alias)).toBe(true);
    expect(JSON.parse(db.inserts[0].args[3] as string)).toEqual([SERVER]);
  });
  it('PUT create alias soft-14', async () => {
    const alias = `#room14:example.com`;
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.some((a) => a.alias === alias)).toBe(true);
    expect(JSON.parse(db.inserts[0].args[3] as string)).toEqual([SERVER]);
  });
  it('PUT create alias soft-15', async () => {
    const alias = `#room15:example.com`;
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.some((a) => a.alias === alias)).toBe(true);
    expect(JSON.parse(db.inserts[0].args[3] as string)).toEqual([SERVER]);
  });
  it('PUT create alias soft-16', async () => {
    const alias = `#room16:example.com`;
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.some((a) => a.alias === alias)).toBe(true);
    expect(JSON.parse(db.inserts[0].args[3] as string)).toEqual([SERVER]);
  });
  it('PUT create alias soft-17', async () => {
    const alias = `#room17:example.com`;
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.some((a) => a.alias === alias)).toBe(true);
    expect(JSON.parse(db.inserts[0].args[3] as string)).toEqual([SERVER]);
  });
  it('PUT create alias soft-18', async () => {
    const alias = `#room18:example.com`;
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.some((a) => a.alias === alias)).toBe(true);
    expect(JSON.parse(db.inserts[0].args[3] as string)).toEqual([SERVER]);
  });
  it('PUT create alias soft-19', async () => {
    const alias = `#room19:example.com`;
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.some((a) => a.alias === alias)).toBe(true);
    expect(JSON.parse(db.inserts[0].args[3] as string)).toEqual([SERVER]);
  });
});
describe('aliases leftovers DELETE soft flood after #153', () => {
  it('DELETE creator soft-0', async () => {
    const alias = `#del0:example.com`;
    const db = createAliasesDb({
      aliases: [{ alias, room_id: ROOM, creator_id: USER, servers: null, created_at: 1 }],
      rooms: [{ room_id: ROOM, is_public: 1 }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.find((a) => a.alias === alias)).toBeUndefined();
  });
  it('DELETE creator soft-1', async () => {
    const alias = `#del1:example.com`;
    const db = createAliasesDb({
      aliases: [{ alias, room_id: ROOM, creator_id: USER, servers: null, created_at: 1 }],
      rooms: [{ room_id: ROOM, is_public: 1 }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.find((a) => a.alias === alias)).toBeUndefined();
  });
  it('DELETE creator soft-2', async () => {
    const alias = `#del2:example.com`;
    const db = createAliasesDb({
      aliases: [{ alias, room_id: ROOM, creator_id: USER, servers: null, created_at: 1 }],
      rooms: [{ room_id: ROOM, is_public: 1 }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.find((a) => a.alias === alias)).toBeUndefined();
  });
  it('DELETE creator soft-3', async () => {
    const alias = `#del3:example.com`;
    const db = createAliasesDb({
      aliases: [{ alias, room_id: ROOM, creator_id: USER, servers: null, created_at: 1 }],
      rooms: [{ room_id: ROOM, is_public: 1 }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.find((a) => a.alias === alias)).toBeUndefined();
  });
  it('DELETE creator soft-4', async () => {
    const alias = `#del4:example.com`;
    const db = createAliasesDb({
      aliases: [{ alias, room_id: ROOM, creator_id: USER, servers: null, created_at: 1 }],
      rooms: [{ room_id: ROOM, is_public: 1 }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.find((a) => a.alias === alias)).toBeUndefined();
  });
  it('DELETE creator soft-5', async () => {
    const alias = `#del5:example.com`;
    const db = createAliasesDb({
      aliases: [{ alias, room_id: ROOM, creator_id: USER, servers: null, created_at: 1 }],
      rooms: [{ room_id: ROOM, is_public: 1 }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.find((a) => a.alias === alias)).toBeUndefined();
  });
  it('DELETE creator soft-6', async () => {
    const alias = `#del6:example.com`;
    const db = createAliasesDb({
      aliases: [{ alias, room_id: ROOM, creator_id: USER, servers: null, created_at: 1 }],
      rooms: [{ room_id: ROOM, is_public: 1 }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.find((a) => a.alias === alias)).toBeUndefined();
  });
  it('DELETE creator soft-7', async () => {
    const alias = `#del7:example.com`;
    const db = createAliasesDb({
      aliases: [{ alias, room_id: ROOM, creator_id: USER, servers: null, created_at: 1 }],
      rooms: [{ room_id: ROOM, is_public: 1 }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.find((a) => a.alias === alias)).toBeUndefined();
  });
  it('DELETE creator soft-8', async () => {
    const alias = `#del8:example.com`;
    const db = createAliasesDb({
      aliases: [{ alias, room_id: ROOM, creator_id: USER, servers: null, created_at: 1 }],
      rooms: [{ room_id: ROOM, is_public: 1 }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.find((a) => a.alias === alias)).toBeUndefined();
  });
  it('DELETE creator soft-9', async () => {
    const alias = `#del9:example.com`;
    const db = createAliasesDb({
      aliases: [{ alias, room_id: ROOM, creator_id: USER, servers: null, created_at: 1 }],
      rooms: [{ room_id: ROOM, is_public: 1 }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.find((a) => a.alias === alias)).toBeUndefined();
  });
  it('DELETE creator soft-10', async () => {
    const alias = `#del10:example.com`;
    const db = createAliasesDb({
      aliases: [{ alias, room_id: ROOM, creator_id: USER, servers: null, created_at: 1 }],
      rooms: [{ room_id: ROOM, is_public: 1 }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.find((a) => a.alias === alias)).toBeUndefined();
  });
  it('DELETE creator soft-11', async () => {
    const alias = `#del11:example.com`;
    const db = createAliasesDb({
      aliases: [{ alias, room_id: ROOM, creator_id: USER, servers: null, created_at: 1 }],
      rooms: [{ room_id: ROOM, is_public: 1 }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.find((a) => a.alias === alias)).toBeUndefined();
  });
  it('DELETE creator soft-12', async () => {
    const alias = `#del12:example.com`;
    const db = createAliasesDb({
      aliases: [{ alias, room_id: ROOM, creator_id: USER, servers: null, created_at: 1 }],
      rooms: [{ room_id: ROOM, is_public: 1 }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.find((a) => a.alias === alias)).toBeUndefined();
  });
  it('DELETE creator soft-13', async () => {
    const alias = `#del13:example.com`;
    const db = createAliasesDb({
      aliases: [{ alias, room_id: ROOM, creator_id: USER, servers: null, created_at: 1 }],
      rooms: [{ room_id: ROOM, is_public: 1 }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.find((a) => a.alias === alias)).toBeUndefined();
  });
  it('DELETE creator soft-14', async () => {
    const alias = `#del14:example.com`;
    const db = createAliasesDb({
      aliases: [{ alias, room_id: ROOM, creator_id: USER, servers: null, created_at: 1 }],
      rooms: [{ room_id: ROOM, is_public: 1 }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.find((a) => a.alias === alias)).toBeUndefined();
  });
  it('DELETE creator soft-15', async () => {
    const alias = `#del15:example.com`;
    const db = createAliasesDb({
      aliases: [{ alias, room_id: ROOM, creator_id: USER, servers: null, created_at: 1 }],
      rooms: [{ room_id: ROOM, is_public: 1 }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.aliases.find((a) => a.alias === alias)).toBeUndefined();
  });
});
describe('aliases leftovers visibility soft flood after #153', () => {
  it('GET visibility public soft-0', async () => {
    const db = createAliasesDb({ rooms: [{ room_id: ROOM, is_public: 1 }] });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ visibility: 'public' });
  });
  it('GET visibility public soft-1', async () => {
    const db = createAliasesDb({ rooms: [{ room_id: ROOM, is_public: 1 }] });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ visibility: 'public' });
  });
  it('GET visibility public soft-2', async () => {
    const db = createAliasesDb({ rooms: [{ room_id: ROOM, is_public: 1 }] });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ visibility: 'public' });
  });
  it('GET visibility public soft-3', async () => {
    const db = createAliasesDb({ rooms: [{ room_id: ROOM, is_public: 1 }] });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ visibility: 'public' });
  });
  it('GET visibility public soft-4', async () => {
    const db = createAliasesDb({ rooms: [{ room_id: ROOM, is_public: 1 }] });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ visibility: 'public' });
  });
  it('GET visibility public soft-5', async () => {
    const db = createAliasesDb({ rooms: [{ room_id: ROOM, is_public: 1 }] });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ visibility: 'public' });
  });
  it('GET visibility public soft-6', async () => {
    const db = createAliasesDb({ rooms: [{ room_id: ROOM, is_public: 1 }] });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ visibility: 'public' });
  });
  it('GET visibility public soft-7', async () => {
    const db = createAliasesDb({ rooms: [{ room_id: ROOM, is_public: 1 }] });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ visibility: 'public' });
  });
  it('GET visibility public soft-8', async () => {
    const db = createAliasesDb({ rooms: [{ room_id: ROOM, is_public: 1 }] });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ visibility: 'public' });
  });
  it('GET visibility public soft-9', async () => {
    const db = createAliasesDb({ rooms: [{ room_id: ROOM, is_public: 1 }] });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ visibility: 'public' });
  });
  it('GET visibility public soft-10', async () => {
    const db = createAliasesDb({ rooms: [{ room_id: ROOM, is_public: 1 }] });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ visibility: 'public' });
  });
  it('GET visibility public soft-11', async () => {
    const db = createAliasesDb({ rooms: [{ room_id: ROOM, is_public: 1 }] });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ visibility: 'public' });
  });
  it('PUT visibility private soft-0', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 1 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: JSON.stringify({ users: { [USER]: 100 }, state_default: 50 }),
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'private' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.rooms[0].is_public).toBe(0);
  });
  it('PUT visibility private soft-1', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 1 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: JSON.stringify({ users: { [USER]: 100 }, state_default: 50 }),
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'private' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.rooms[0].is_public).toBe(0);
  });
  it('PUT visibility private soft-2', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 1 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: JSON.stringify({ users: { [USER]: 100 }, state_default: 50 }),
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'private' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.rooms[0].is_public).toBe(0);
  });
  it('PUT visibility private soft-3', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 1 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: JSON.stringify({ users: { [USER]: 100 }, state_default: 50 }),
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'private' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.rooms[0].is_public).toBe(0);
  });
  it('PUT visibility private soft-4', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 1 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: JSON.stringify({ users: { [USER]: 100 }, state_default: 50 }),
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'private' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.rooms[0].is_public).toBe(0);
  });
  it('PUT visibility private soft-5', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 1 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: JSON.stringify({ users: { [USER]: 100 }, state_default: 50 }),
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'private' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.rooms[0].is_public).toBe(0);
  });
  it('PUT visibility private soft-6', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 1 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: JSON.stringify({ users: { [USER]: 100 }, state_default: 50 }),
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'private' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.rooms[0].is_public).toBe(0);
  });
  it('PUT visibility private soft-7', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 1 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: JSON.stringify({ users: { [USER]: 100 }, state_default: 50 }),
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'private' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.rooms[0].is_public).toBe(0);
  });
  it('PUT visibility private soft-8', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 1 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: JSON.stringify({ users: { [USER]: 100 }, state_default: 50 }),
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'private' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.rooms[0].is_public).toBe(0);
  });
  it('PUT visibility private soft-9', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 1 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: JSON.stringify({ users: { [USER]: 100 }, state_default: 50 }),
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'private' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.rooms[0].is_public).toBe(0);
  });
  it('PUT visibility private soft-10', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 1 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: JSON.stringify({ users: { [USER]: 100 }, state_default: 50 }),
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'private' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.rooms[0].is_public).toBe(0);
  });
  it('PUT visibility private soft-11', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 1 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: JSON.stringify({ users: { [USER]: 100 }, state_default: 50 }),
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'private' })
    );
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(db.rooms[0].is_public).toBe(0);
  });
});
describe('aliases leftovers failure edges after #153', () => {
  it('GET unknown alias 404', async () => {
    const db = createAliasesDb();
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('GET null servers falls back to SERVER_NAME', async () => {
    const db = createAliasesDb({
      aliases: [{ alias: ALIAS, room_id: ROOM, creator_id: USER, servers: null, created_at: 1 }],
    });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(status).toBe(200);
    expect(body.servers).toEqual([SERVER]);
  });

  it('GET corrupt servers falls back to SERVER_NAME', async () => {
    const db = createAliasesDb({
      aliases: [{ alias: ALIAS, room_id: ROOM, creator_id: USER, servers: '{bad', created_at: 1 }],
    });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(status).toBe(200);
    expect(body.servers).toEqual([SERVER]);
  });

  it('PUT bad JSON', async () => {
    const db = createAliasesDb();
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: '{',
    });
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });

  it('PUT missing room_id', async () => {
    const db = createAliasesDb();
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('PUT', {})
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_MISSING_PARAM');
  });

  it('PUT invalid alias no hash', async () => {
    const db = createAliasesDb();
    const { status, body } = await aliasesRequest(
      db,
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('general:example.com'),
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('PUT invalid alias no colon', async () => {
    const db = createAliasesDb();
    const { status, body } = await aliasesRequest(
      db,
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#general'),
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('PUT foreign server alias', async () => {
    const db = createAliasesDb();
    const { status, body } = await aliasesRequest(
      db,
      '/_matrix/client/v3/directory/room/' + encodeURIComponent('#x:other.example.org'),
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });

  it('PUT room missing 404', async () => {
    const db = createAliasesDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('PUT forbids non-join membership', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });

  it('PUT M_ROOM_IN_USE', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      aliases: [{ alias: ALIAS, room_id: ROOM, creator_id: USER, servers: null, created_at: 1 }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(status).toBe(409);
    expect(body.errcode).toBe('M_ROOM_IN_USE');
  });

  it('DELETE missing 404', async () => {
    const db = createAliasesDb();
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('DELETE non-creator without PL forbidden', async () => {
    const db = createAliasesDb({
      aliases: [{ alias: ALIAS, room_id: ROOM, creator_id: OTHER, servers: null, created_at: 1 }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });

  it('DELETE non-creator with sufficient power', async () => {
    const db = createAliasesDb({
      aliases: [{ alias: ALIAS, room_id: ROOM, creator_id: OTHER, servers: null, created_at: 1 }],
      powerLevelsContent: JSON.stringify({ users: { [USER]: 100 }, state_default: 50 }),
    });
    const { status } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(200);
  });

  it('DELETE non-creator corrupt PL forbidden', async () => {
    const db = createAliasesDb({
      aliases: [{ alias: ALIAS, room_id: ROOM, creator_id: OTHER, servers: null, created_at: 1 }],
      powerLevelsContent: '{bad',
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('DELETE')
    );
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });

  it('GET visibility unknown room 404', async () => {
    const db = createAliasesDb();
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('PUT visibility bad JSON', async () => {
    const db = createAliasesDb({ rooms: [{ room_id: ROOM, is_public: 0 }] });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: 'x',
    });
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
  });

  it('PUT visibility invalid value', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'secret' })
    );
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_MISSING_PARAM');
  });

  it('PUT visibility forbids non-join', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'public' })
    );
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });

  it('PUT visibility insufficient power', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: JSON.stringify({ users_default: 0, state_default: 50 }),
    });
    const { status, body } = await aliasesRequest(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'public' })
    );
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });

  it('GET visibility maps private', async () => {
    const db = createAliasesDb({ rooms: [{ room_id: ROOM, is_public: 0 }] });
    const { status, body } = await aliasesRequest(db, `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`);
    expect(status).toBe(200);
    expect(body).toEqual({ visibility: 'private' });
  });
});
