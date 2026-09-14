/**
 * TOKENMAXX HEAVY deepen — different slice: room aliases / directory API routes.
 * Avoids search (#94), key-backups (#96), oauth (#90), spaces (#89), devices (sibling).
 * After #226 leftover pass: sequential route edges not covered by concurrent-race
 * leftovers (#193) — PL 0/equal/state_default-falsy, extra-colon split, extra
 * body fields, visibility-without-room, servers JSON non-array, bind contracts.
 * Residual after #241: null/empty room_id, JOIN case, servers ""/JSON-string,
 * string/negative/null PL coerce, events_default ignored, creator "", NaN
 * is_public, visibility null/array.
 * Tests-only — no product inventing.
 * Exercises alias resolve/create/delete + room visibility directory list.
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

import aliases from '../src/api/aliases';

const USER = '@alice:example.com';
const OTHER = '@bob:example.com';
const SERVER = 'example.com';
const ROOM = '!room:example.com';
const ALIAS = '#general:example.com';
const ALIAS_ENC = encodeURIComponent(ALIAS);
const ROOM_ENC = encodeURIComponent(ROOM);

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

function createAliasesDb(opts: {
  aliases?: AliasRow[];
  rooms?: RoomRow[];
  memberships?: MembershipRow[];
  /** Raw power_levels content string; null = no PL event. */
  powerLevelsContent?: string | null;
  /** Force power_levels first() to throw JSON path via invalid content. */
  powerLevelsRaw?: string | null;
} = {}) {
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
              if (sql.includes('INSERT INTO room_aliases')) {
                inserts.push({ sql, args });
                const [alias, roomId, creatorId, servers, createdAt] = args as [
                  string,
                  string,
                  string,
                  string,
                  number,
                ];
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

function seedAlias(overrides: Partial<AliasRow> = {}): AliasRow {
  return {
    alias: overrides.alias ?? ALIAS,
    room_id: overrides.room_id ?? ROOM,
    creator_id: overrides.creator_id ?? USER,
    servers: overrides.servers === undefined ? JSON.stringify([SERVER]) : overrides.servers,
    created_at: overrides.created_at ?? 1_700_000_000_000,
  };
}

describe('aliases GET /directory/room/:roomAlias', () => {
  it('returns 404 when alias unknown', async () => {
    const db = createAliasesDb();
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent('#missing:example.com')}`
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('resolves alias with parsed servers list', async () => {
    const db = createAliasesDb({
      aliases: [
        seedAlias({
          servers: JSON.stringify(['example.com', 'peer.example.org']),
        }),
      ],
    });
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      room_id: ROOM,
      servers: ['example.com', 'peer.example.org'],
    });
  });

  it('falls back to SERVER_NAME when servers is null', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ servers: null })],
    });
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM, servers: [SERVER] });
  });

  it('falls back to SERVER_NAME when servers JSON is corrupt', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ servers: '{not-json' })],
    });
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM, servers: [SERVER] });
  });

  it('decodes percent-encoded alias path param', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ alias: '#space room:example.com' })],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent('#space room:example.com')}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ room_id: ROOM });
  });
});

describe('aliases PUT /directory/room/:roomAlias', () => {
  it('rejects non-JSON with M_BAD_JSON', async () => {
    const db = createAliasesDb();
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer t',
      },
      body: '{',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('rejects missing room_id', async () => {
    const db = createAliasesDb();
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('PUT', {})
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('rejects invalid alias format (no leading #)', async () => {
    const db = createAliasesDb();
    const bad = encodeURIComponent('general:example.com');
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${bad}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_INVALID_PARAM',
      error: 'Invalid room alias format',
    });
  });

  it('rejects invalid alias format (no colon)', async () => {
    const db = createAliasesDb();
    const bad = encodeURIComponent('#general');
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${bad}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('rejects alias for another server', async () => {
    const db = createAliasesDb();
    const foreign = encodeURIComponent('#general:other.org');
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${foreign}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_INVALID_PARAM',
      error: 'Cannot create alias for another server',
    });
  });

  it('returns 404 when room does not exist', async () => {
    const db = createAliasesDb({ rooms: [] });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('forbids create when not joined (missing membership)', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('forbids create when membership is leave (must be join)', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(res.status).toBe(403);
  });

  it('returns M_ROOM_IN_USE when alias already exists', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      aliases: [seedAlias()],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ errcode: 'M_ROOM_IN_USE' });
    expect(db.inserts).toEqual([]);
  });

  it('creates alias for joined member with local server servers list', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.inserts).toHaveLength(1);
    expect(db.aliases[0]).toMatchObject({
      alias: ALIAS,
      room_id: ROOM,
      creator_id: USER,
      servers: JSON.stringify([SERVER]),
    });
    expect(typeof db.aliases[0].created_at).toBe('number');
  });
});

describe('aliases DELETE /directory/room/:roomAlias', () => {
  it('returns 404 when alias missing', async () => {
    const db = createAliasesDb();
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(404);
  });

  it('allows creator to delete without power_levels lookup success path', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: USER })],
      powerLevelsContent: null,
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(db.aliases).toHaveLength(0);
    expect(db.deletes).toHaveLength(1);
  });

  it('forbids non-creator when no power_levels state', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsContent: null,
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot delete alias',
    });
    expect(db.aliases).toHaveLength(1);
  });

  it('forbids non-creator when power_levels JSON is corrupt', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsRaw: '{broken',
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Cannot delete alias' });
  });

  it('forbids non-creator below state_default / users_default', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsContent: JSON.stringify({
        users_default: 0,
        state_default: 50,
        users: { [USER]: 10 },
      }),
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: 'Insufficient power level to delete alias',
    });
  });

  it('allows non-creator with sufficient power (users + state_default)', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsContent: JSON.stringify({
        users_default: 0,
        state_default: 50,
        users: { [USER]: 50 },
      }),
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(db.aliases).toHaveLength(0);
  });

  it('uses users_default when user not in users map', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsContent: JSON.stringify({
        users_default: 100,
        state_default: 50,
      }),
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(200);
    expect(db.aliases).toHaveLength(0);
  });

  it('defaults users_default=0 and state_default=50 when fields missing', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsContent: JSON.stringify({}),
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } }
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: 'Insufficient power level to delete alias',
    });
  });
});

describe('aliases GET /directory/list/room/:roomId', () => {
  it('returns 404 for unknown room', async () => {
    const db = createAliasesDb({ rooms: [] });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`
    );
    expect(res.status).toBe(404);
  });

  it('maps is_public=1 to public', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 1 }],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ visibility: 'public' });
  });

  it('maps is_public=0 to private', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ visibility: 'private' });
  });
});

describe('aliases PUT /directory/list/room/:roomId', () => {
  it('rejects non-JSON', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer t',
        },
        body: 'x',
      }
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('rejects missing/invalid visibility', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const a = await request(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', {})
    );
    expect(a.status).toBe(400);
    expect(a.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });

    const b = await request(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'world_readable' })
    );
    expect(b.status).toBe(400);
    expect(b.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('forbids when not a joined member', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'public' })
    );
    expect(res.status).toBe(403);
  });

  it('forbids leave membership for visibility change', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'public' })
    );
    expect(res.status).toBe(403);
  });

  it('forbids when power insufficient', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: JSON.stringify({
        users_default: 0,
        state_default: 50,
        users: { [USER]: 0 },
      }),
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'public' })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Insufficient power level' });
  });

  it('forbids when power_levels JSON corrupt', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsRaw: 'not-json',
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'public' })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Cannot change visibility' });
  });

  it('allows visibility change when no power_levels (skip PL gate)', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: null,
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'public' })
    );
    expect(res.status).toBe(200);
    expect(db.rooms[0].is_public).toBe(1);
    expect(db.updates[0].args).toEqual([1, ROOM]);
  });

  it('sets private when power sufficient', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 1 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: 100 },
        state_default: 50,
      }),
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'private' })
    );
    expect(res.status).toBe(200);
    expect(db.rooms[0].is_public).toBe(0);
  });
});

describe('aliases leftover GET resolve edges after #226', () => {
  it('returns parsed empty servers array without defaulting', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ servers: '[]' })],
    });
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM, servers: [] });
  });

  it('returns JSON.parse number as servers (non-array leftover)', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ servers: '0' })],
    });
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(res.status).toBe(200);
    expect((res.body as { servers: unknown }).servers).toBe(0);
  });

  it('returns JSON.parse object as servers', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ servers: '{"ok":true}' })],
    });
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(res.status).toBe(200);
    expect((res.body as { servers: unknown }).servers).toEqual({ ok: true });
  });

  it('JSON.parse("null") leftover: servers field is null', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ servers: 'null' })],
    });
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(res.status).toBe(200);
    expect((res.body as { servers: unknown }).servers).toBeNull();
  });

  it('Hono+decodeURIComponent leftover: double-encoded alias still resolves', async () => {
    const db = createAliasesDb({ aliases: [seedAlias()] });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(ALIAS_ENC)}`
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ room_id: ROOM });
  });

  it('GET resolve SELECT binds the decoded alias', async () => {
    const db = createAliasesDb({ aliases: [seedAlias()] });
    await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    const sel = db.selects.find((s) => s.sql.includes('SELECT room_id, servers'));
    expect(sel?.args).toEqual([ALIAS]);
  });
});

describe('aliases leftover PUT create edges after #226', () => {
  it('ignores extra JSON fields and still binds local SERVER_NAME servers list', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('PUT', { room_id: ROOM, extra: true, servers: ['evil.example.org'] })
    );
    expect(res.status).toBe(200);
    expect(db.inserts[0].args[1]).toBe(ROOM);
    expect(db.inserts[0].args[2]).toBe(USER);
    expect(db.inserts[0].args[3]).toBe(JSON.stringify([SERVER]));
  });

  it('rejects room_id 0 / false as missing param', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const a = await request(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent('#z0:example.com')}`,
      jsonInit('PUT', { room_id: 0 })
    );
    const b = await request(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent('#z1:example.com')}`,
      jsonInit('PUT', { room_id: false })
    );
    expect(a.status).toBe(400);
    expect(a.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
    expect(b.status).toBe(400);
    expect(db.inserts).toHaveLength(0);
  });

  it('split leftover: extra :8448 still matches SERVER_NAME', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const alias = '#ops:example.com:8448';
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(res.status).toBe(200);
    expect(db.aliases[0].alias).toBe(alias);
  });

  it('split leftover: middle server other.org is foreign', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent('#x:other.org:example.com')}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Cannot create alias for another server' });
  });

  it('empty localpart #:example.com is accepted as format-valid', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent('#:example.com')}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(res.status).toBe(200);
    expect(db.aliases[0].alias).toBe('#:example.com');
  });

  it('server name compare is case-sensitive (EXAMPLE.COM rejected)', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent('#x:EXAMPLE.COM')}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('joined on ROOM does not allow alias on another existing room', async () => {
    const db = createAliasesDb({
      rooms: [
        { room_id: ROOM, is_public: 0 },
        { room_id: '!other:example.com', is_public: 0 },
      ],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent('#x:example.com')}`,
      jsonInit('PUT', { room_id: '!other:example.com' })
    );
    expect(res.status).toBe(403);
    expect(db.inserts).toHaveLength(0);
  });

  it('unicode localpart stores decoded alias', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const alias = '#café:example.com';
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(res.status).toBe(200);
    expect(db.aliases[0].alias).toBe(alias);
  });

  it('invite membership is not join — forbidden', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'invite' }],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
});

describe('aliases leftover DELETE PL edges after #226', () => {
  it('creator deletes even when power_levels JSON is corrupt (skips PL)', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: USER })],
      powerLevelsRaw: '{broken',
    });
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(db.aliases).toHaveLength(0);
    expect(db.selects.some((s) => s.sql.includes('power_levels'))).toBe(false);
  });

  it('users[userId]=0 falls through to users_default 100 and allows delete', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: 0 },
        users_default: 100,
        state_default: 50,
      }),
    });
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(db.aliases).toHaveLength(0);
  });

  it('equal power userPower === state_default allows delete', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: 50 },
        state_default: 50,
      }),
    });
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
  });

  it('state_default 0 is falsy so required stays 50 — user 0 forbidden', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: 0 },
        users_default: 0,
        state_default: 0,
      }),
    });
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Insufficient power level to delete alias' });
    expect(db.aliases).toHaveLength(1);
  });

  it('PL query binds the alias room_id not the requester', async () => {
    const otherRoom = '!other:example.com';
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER, room_id: otherRoom })],
      powerLevelsContent: JSON.stringify({ users: { [USER]: 100 }, state_default: 50 }),
    });
    await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    const plSel = db.selects.find((s) => s.sql.includes('power_levels'));
    expect(plSel?.args).toEqual([otherRoom]);
  });
});

describe('aliases leftover visibility edges after #226', () => {
  it('maps is_public=2 (truthy) to public', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 2 }],
    });
    const res = await request(db, `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ visibility: 'public' });
  });

  it('GET visibility does not require membership', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 1 }],
      memberships: [],
    });
    const res = await request(db, `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ visibility: 'public' });
  });

  it('PUT visibility with membership but no rooms row still 200 (no existence check)', async () => {
    const db = createAliasesDb({
      rooms: [],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: null,
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'public' })
    );
    expect(res.status).toBe(200);
    expect(db.updates[0].args).toEqual([1, ROOM]);
  });

  it('PUT visibility extra fields ignored', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: null,
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'private', extra: 1 })
    );
    expect(res.status).toBe(200);
    expect(db.updates[0].args).toEqual([0, ROOM]);
  });

  it('users[userId]=0 falls through to users_default for visibility', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: 0 },
        users_default: 80,
        state_default: 50,
      }),
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'public' })
    );
    expect(res.status).toBe(200);
    expect(db.rooms[0].is_public).toBe(1);
  });

  it('state_default 0 falsy leftover requires 50 — user 10 forbidden', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: 10 },
        state_default: 0,
      }),
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'public' })
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Insufficient power level' });
  });

  it('equal power 50 allows visibility change', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: 50 },
        state_default: 50,
      }),
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'public' })
    );
    expect(res.status).toBe(200);
    expect(db.rooms[0].is_public).toBe(1);
  });

  it('PUT visibility SELECT membership binds roomId from path', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: null,
    });
    await request(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'public' })
    );
    const mem = db.selects.find((s) => s.sql.includes('FROM room_memberships'));
    expect(mem?.args).toEqual([ROOM, USER]);
  });
});

describe('aliases leftover deepen after #232 — PL shapes / boolean servers / negative is_public', () => {
  it('GET resolve returns servers JSON boolean true as-is', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ servers: 'true' })],
    });
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(res.status).toBe(200);
    expect((res.body as { servers: unknown }).servers).toBe(true);
  });

  it('GET resolve returns servers JSON boolean false as-is', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ servers: 'false' })],
    });
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(res.status).toBe(200);
    expect((res.body as { servers: unknown }).servers).toBe(false);
  });

  it('maps is_public=-1 (truthy) to public', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: -1 }],
    });
    const res = await request(db, `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ visibility: 'public' });
  });

  it('DELETE non-creator with PL content [] is forbidden', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsContent: '[]',
    });
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(403);
    expect(db.aliases).toHaveLength(1);
  });

  it('DELETE non-creator with PL content number is forbidden', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsContent: '50',
    });
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(403);
  });

  it('users_default-only PL (no users map) allows delete when default high', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsContent: JSON.stringify({ users_default: 100, state_default: 50 }),
    });
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(db.aliases).toHaveLength(0);
  });

  it('visibility PUT with PL [] is forbidden', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: '[]',
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'public' })
    );
    expect(res.status).toBe(403);
    expect(db.updates).toHaveLength(0);
  });

  it('visibility PUT rejects Capitalized Public', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: null,
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'Public' })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('ban membership forbids visibility PUT', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }],
      powerLevelsContent: null,
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'public' })
    );
    expect(res.status).toBe(403);
  });

  it('knock membership forbids alias create', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'knock' }],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(res.status).toBe(403);
    expect(db.inserts).toHaveLength(0);
  });

  it('room_id whitespace string is truthy so not missing-param — 404 room', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent('#ws:example.com')}`,
      jsonInit('PUT', { room_id: '   ' })
    );
    expect(res.status).toBe(404);
    expect(db.inserts).toHaveLength(0);
  });

  it('INSERT created_at is a finite number near Date.now', async () => {
    const before = Date.now();
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    const after = Date.now();
    expect(res.status).toBe(200);
    const ts = db.inserts[0].args[4] as number;
    expect(Number.isFinite(ts)).toBe(true);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe('aliases leftover residual deepen after #241 — PL coerce / servers / membership case', () => {
  it('rejects room_id null as M_MISSING_PARAM', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent('#n:example.com')}`,
      jsonInit('PUT', { room_id: null })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
    expect(db.inserts).toHaveLength(0);
  });

  it('rejects room_id empty string as M_MISSING_PARAM', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent('#e:example.com')}`,
      jsonInit('PUT', { room_id: '' })
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('membership JOIN (wrong case) forbids alias create', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'JOIN' }],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${ALIAS_ENC}`,
      jsonInit('PUT', { room_id: ROOM })
    );
    expect(res.status).toBe(403);
    expect(db.inserts).toHaveLength(0);
  });

  it('GET resolve servers "" falls back to SERVER_NAME', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ servers: '' })],
    });
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ room_id: ROOM, servers: [SERVER] });
  });

  it('GET resolve servers JSON string value returned as-is', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ servers: '"solo.example.org"' })],
    });
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`);
    expect(res.status).toBe(200);
    expect((res.body as { servers: unknown }).servers).toBe('solo.example.org');
  });

  it('string users power "100" allows non-creator DELETE', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: '100' },
        state_default: 50,
      }),
    });
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(db.aliases).toHaveLength(0);
  });

  it('negative userPower=-1 / state_default=50 forbids DELETE', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: -1 },
        state_default: 50,
      }),
    });
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(403);
    expect(db.aliases).toHaveLength(1);
  });

  it('negative userPower=-1 / state_default=-5 allows DELETE', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: -1 },
        state_default: -5,
      }),
    });
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(db.aliases).toHaveLength(0);
  });

  it('users[userId]=null falls through to users_default for DELETE', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: null },
        users_default: 80,
        state_default: 50,
      }),
    });
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(200);
  });

  it('events_default does not substitute for state_default gate', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: OTHER })],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: 0 },
        users_default: 0,
        events_default: 100,
        state_default: 50,
      }),
    });
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(403);
    // users[USER]=0 falls through → users_default 0 → 0 < 50
    expect(res.body).toMatchObject({ error: 'Insufficient power level to delete alias' });
  });

  it('creator_id empty string is not the requester — forbids without PL', async () => {
    const db = createAliasesDb({
      aliases: [seedAlias({ creator_id: '' })],
      powerLevelsContent: null,
    });
    const res = await request(db, `/_matrix/client/v3/directory/room/${ALIAS_ENC}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(403);
    expect(db.aliases).toHaveLength(1);
  });

  it('visibility null / empty / array rejected as M_MISSING_PARAM', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: null,
    });
    for (const visibility of [null, '', ['public']] as unknown[]) {
      const res = await request(
        db,
        `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
        jsonInit('PUT', { visibility })
      );
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
    }
    expect(db.updates).toHaveLength(0);
  });

  it('maps is_public NaN (falsy) to private', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: Number.NaN }],
    });
    const res = await request(db, `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ visibility: 'private' });
  });

  it('room_id array is truthy so not missing-param — room 404', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/room/${encodeURIComponent('#arr:example.com')}`,
      jsonInit('PUT', { room_id: [ROOM] })
    );
    expect(res.status).toBe(404);
    expect(db.inserts).toHaveLength(0);
  });

  it('string power allows visibility PUT', async () => {
    const db = createAliasesDb({
      rooms: [{ room_id: ROOM, is_public: 0 }],
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
      powerLevelsContent: JSON.stringify({
        users: { [USER]: '60' },
        state_default: 50,
      }),
    });
    const res = await request(
      db,
      `/_matrix/client/v3/directory/list/room/${ROOM_ENC}`,
      jsonInit('PUT', { visibility: 'public' })
    );
    expect(res.status).toBe(200);
    expect(db.rooms[0].is_public).toBe(1);
  });
});
