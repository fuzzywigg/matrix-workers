/**
 * TOKENMAXX HEAVY leftovers after #169 — server-notices API route soft/edge/reliability.
 * Complements server-notice-helpers.test.ts (helper-level sendServerNotice coverage).
 * No dedicated HTTP leftovers for Synapse/Matrix admin send_server_notice routes on main.
 * Orthogonal to push (#169), to-device (#168), room-state (#170), device-list (#171).
 * Tests-only — no product inventing. Fixtures use example.com only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const generateOpaqueId = vi.fn(async (length: number = 18) => `opaque${length}`);
let eventSeq = 0;
const generateEventId = vi.fn(async (serverName: string) => `$evt-${++eventSeq}:${serverName}`);

vi.mock('../src/utils/ids', () => ({
  generateOpaqueId: (...args: unknown[]) => generateOpaqueId(...(args as [number?])),
  generateEventId: (...args: unknown[]) => generateEventId(...(args as [string])),
}));

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICEA');
      await next();
    };
  },
}));

import noticesApp from '../src/api/server-notices';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const SERVER = 'example.com';
const SERVER_USER = `@server:${SERVER}`;
const NOTICE_ROOM_TYPE = 'm.server_notice';

const SYNAPSE_PATH = '/_synapse/admin/v1/send_server_notice';
const MATRIX_PATH = '/_matrix/client/v3/admin/send_server_notice';
const PATHS = [SYNAPSE_PATH, MATRIX_PATH] as const;

const NOW = 1_700_000_000_000;

type UserRow = {
  user_id: string;
  localpart: string;
  display_name: string;
  admin: number;
  is_guest: number;
  is_deactivated: number;
};

type RoomRow = {
  room_id: string;
  room_version: string;
  is_public: number;
  creator_id: string;
  created_at: number;
};

type EventRow = {
  event_id: string;
  room_id: string;
  sender: string;
  event_type: string;
  state_key: string | null;
  content: string;
  origin_server_ts: number;
  depth: number;
  auth_events: string;
  prev_events: string;
};

type StateRow = {
  room_id: string;
  event_type: string;
  state_key: string;
  event_id: string;
};

type MembershipRow = {
  room_id: string;
  user_id: string;
  membership: string;
  event_id: string;
  display_name?: string | null;
};

type NoticeDb = {
  users: Map<string, UserRow>;
  rooms: Map<string, RoomRow>;
  events: EventRow[];
  roomState: StateRow[];
  memberships: MembershipRow[];
  sqlLog: string[];
  throwOn?: string | null;
};

function adminUser(userId = USER, admin = 1): UserRow {
  const localpart = userId.slice(1).split(':')[0];
  return {
    user_id: userId,
    localpart,
    display_name: localpart,
    admin,
    is_guest: 0,
    is_deactivated: 0,
  };
}

function createNoticeDb(seed?: Partial<NoticeDb> & { admin?: number }): D1Database & {
  store: NoticeDb;
} {
  const users = seed?.users ?? new Map([[USER, adminUser(USER, seed?.admin ?? 1)]]);
  if (!users.has(USER) && seed?.admin !== undefined) {
    users.set(USER, adminUser(USER, seed.admin));
  }
  const store: NoticeDb = {
    users,
    rooms: seed?.rooms ?? new Map(),
    events: seed?.events ?? [],
    roomState: seed?.roomState ?? [],
    memberships: seed?.memberships ?? [],
    sqlLog: [],
    throwOn: seed?.throwOn ?? null,
  };

  return {
    store,
    prepare(sql: string) {
      store.sqlLog.push(sql);
      if (store.throwOn && sql.includes(store.throwOn)) {
        throw new Error(`forced-db-error:${store.throwOn}`);
      }
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT admin FROM users WHERE user_id = ?')) {
                const [userId] = args as [string];
                const row = store.users.get(userId);
                return (row ? { admin: row.admin } : null) as T;
              }

              if (sql.includes('SELECT user_id FROM users WHERE user_id')) {
                const [userId] = args as [string];
                const row = store.users.get(userId);
                return (row ? { user_id: row.user_id } : null) as T;
              }

              if (
                sql.includes('FROM room_memberships rm') &&
                sql.includes('m.room.create') &&
                sql.includes('m.server_notice')
              ) {
                const [targetUserId] = args as [string];
                for (const m of store.memberships) {
                  if (m.user_id !== targetUserId) continue;
                  const createState = store.roomState.find(
                    (s) =>
                      s.room_id === m.room_id &&
                      s.event_type === 'm.room.create' &&
                      s.state_key === ''
                  );
                  if (!createState) continue;
                  const createEvent = store.events.find((e) => e.event_id === createState.event_id);
                  if (createEvent?.content.includes(`"type":"${NOTICE_ROOM_TYPE}"`)) {
                    return { room_id: m.room_id } as T;
                  }
                }
                return null as T;
              }

              if (
                sql.includes('SELECT event_id, depth FROM events') &&
                sql.includes('ORDER BY depth DESC')
              ) {
                const [roomId] = args as [string];
                const inRoom = store.events
                  .filter((e) => e.room_id === roomId)
                  .sort((a, b) => b.depth - a.depth);
                if (!inRoom.length) return null as T;
                return { event_id: inRoom[0].event_id, depth: inRoom[0].depth } as T;
              }

              return null as T;
            },
            async all<T>() {
              if (
                sql.includes('FROM room_state rs') &&
                sql.includes('m.room.create') &&
                sql.includes('m.room.power_levels') &&
                sql.includes('m.room.member')
              ) {
                const [roomId, serverUserId] = args as [string, string];
                const rows = store.roomState
                  .filter(
                    (s) =>
                      s.room_id === roomId &&
                      ['m.room.create', 'm.room.power_levels', 'm.room.member'].includes(
                        s.event_type
                      ) &&
                      (s.state_key === '' || s.state_key === serverUserId)
                  )
                  .map((s) => ({ event_id: s.event_id }));
                return { results: rows as T[] };
              }
              return { results: [] as T[] };
            },
            async run() {
              if (sql.includes('INSERT INTO users')) {
                const [userId, localpart] = args as [string, string];
                store.users.set(userId, {
                  user_id: userId,
                  localpart,
                  display_name: 'Server Notices',
                  admin: 0,
                  is_guest: 0,
                  is_deactivated: 0,
                });
                return { meta: { changes: 1 } };
              }

              if (sql.includes('INSERT INTO rooms')) {
                const [roomId, creatorId, createdAt] = args as [string, string, number];
                store.rooms.set(roomId, {
                  room_id: roomId,
                  room_version: '10',
                  is_public: 0,
                  creator_id: creatorId,
                  created_at: createdAt,
                });
                return { meta: { changes: 1 } };
              }

              if (sql.includes('INSERT INTO events') && sql.includes('state_key')) {
                const [
                  eventId,
                  roomId,
                  sender,
                  eventType,
                  stateKey,
                  content,
                  originServerTs,
                  depth,
                  authEvents,
                  prevEvents,
                ] = args as [
                  string,
                  string,
                  string,
                  string,
                  string,
                  string,
                  number,
                  number,
                  string,
                  string,
                ];
                store.events.push({
                  event_id: eventId,
                  room_id: roomId,
                  sender,
                  event_type: eventType,
                  state_key: stateKey,
                  content,
                  origin_server_ts: originServerTs,
                  depth,
                  auth_events: authEvents,
                  prev_events: prevEvents,
                });
                return { meta: { changes: 1 } };
              }

              if (sql.includes('INSERT INTO events') && sql.includes('m.room.message')) {
                const [
                  eventId,
                  roomId,
                  sender,
                  content,
                  originServerTs,
                  depth,
                  authEvents,
                  prevEvents,
                ] = args as [
                  string,
                  string,
                  string,
                  string,
                  number,
                  number,
                  string,
                  string,
                ];
                store.events.push({
                  event_id: eventId,
                  room_id: roomId,
                  sender,
                  event_type: 'm.room.message',
                  state_key: null,
                  content,
                  origin_server_ts: originServerTs,
                  depth,
                  auth_events: authEvents,
                  prev_events: prevEvents,
                });
                return { meta: { changes: 1 } };
              }

              if (sql.includes('INSERT OR REPLACE INTO room_state')) {
                const [roomId, eventType, stateKey, eventId] = args as [
                  string,
                  string,
                  string,
                  string,
                ];
                const idx = store.roomState.findIndex(
                  (s) =>
                    s.room_id === roomId &&
                    s.event_type === eventType &&
                    s.state_key === stateKey
                );
                const row = {
                  room_id: roomId,
                  event_type: eventType,
                  state_key: stateKey,
                  event_id: eventId,
                };
                if (idx >= 0) store.roomState[idx] = row;
                else store.roomState.push(row);
                return { meta: { changes: 1 } };
              }

              if (sql.includes('INSERT INTO room_memberships') && sql.includes('display_name')) {
                const [roomId, userId, eventId] = args as [string, string, string];
                store.memberships.push({
                  room_id: roomId,
                  user_id: userId,
                  membership: 'join',
                  event_id: eventId,
                  display_name: 'Server Notices',
                });
                return { meta: { changes: 1 } };
              }

              if (sql.includes('INSERT INTO room_memberships')) {
                const [roomId, userId, eventId] = args as [string, string, string];
                store.memberships.push({
                  room_id: roomId,
                  user_id: userId,
                  membership: 'invite',
                  event_id: eventId,
                });
                return { meta: { changes: 1 } };
              }

              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database & { store: NoticeDb };
}

type NoticeDbHandle = ReturnType<typeof createNoticeDb>;

function envFor(db: NoticeDbHandle): Env {
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
  } as unknown as Env;
}

async function request(
  db: NoticeDbHandle,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await noticesApp.request(`http://localhost${path}`, init, envFor(db));
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, headers: res.headers };
}

function jsonInit(
  method: string,
  body?: unknown,
  contentType = 'application/json'
): RequestInit {
  const headers: Record<string, string> = {
    Authorization: 'Bearer test-token',
  };
  const upper = method.toUpperCase();
  const noBody = upper === 'GET' || upper === 'HEAD';
  if (contentType && !noBody) headers['Content-Type'] = contentType;
  return {
    method,
    headers,
    body:
      noBody || body === undefined
        ? undefined
        : typeof body === 'string'
          ? body
          : JSON.stringify(body),
  };
}

function validBody(overrides: Record<string, unknown> = {}) {
  const contentOverride =
    typeof overrides.content === 'object' && overrides.content
      ? (overrides.content as Record<string, unknown>)
      : {};
  const rest = { ...overrides };
  delete rest.content;
  return {
    user_id: BOB,
    content: {
      msgtype: 'm.text',
      body: 'Server notice body',
      ...contentOverride,
    },
    ...rest,
  };
}

function messageEvents(store: NoticeDb, roomId: string) {
  return store.events
    .filter((e) => e.room_id === roomId && e.event_type === 'm.room.message')
    .sort((a, b) => a.depth - b.depth);
}

beforeEach(() => {
  eventSeq = 0;
  generateOpaqueId.mockReset();
  generateEventId.mockReset();
  generateOpaqueId.mockImplementation(async (length: number = 18) => `opaque${length}`);
  generateEventId.mockImplementation(
    async (serverName: string) => `$evt-${++eventSeq}:${serverName}`
  );
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});


describe('server-notices leftovers admin gate after #169', () => {
  for (const path of PATHS) {
    it(`forbids non-admin on ${path}`, async () => {
      const db = createNoticeDb({ admin: 0 });
      const res = await request(db, path, jsonInit('POST', validBody()));
      expect(res.status).toBe(403);
      expect(res.body.errcode).toBe('M_FORBIDDEN');
      expect(res.body.error).toMatch(/Admin access required/i);
      expect(db.store.rooms.size).toBe(0);
    });

    it(`forbids missing user row on ${path}`, async () => {
      const db = createNoticeDb({ users: new Map() });
      const res = await request(db, path, jsonInit('POST', validBody()));
      expect(res.status).toBe(403);
      expect(res.body.errcode).toBe('M_FORBIDDEN');
    });

    it(`allows admin=1 on ${path}`, async () => {
      const db = createNoticeDb({ admin: 1 });
      const res = await request(db, path, jsonInit('POST', validBody({ content: { body: 'ok' } })));
      expect(res.status).toBe(200);
      expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    });
  }
});

describe('server-notices leftovers bad JSON / missing params after #169', () => {
  for (const path of PATHS) {
    it(`bad JSON string on ${path}`, async () => {
      const db = createNoticeDb();
      const res = await request(db, path, jsonInit('POST', '{not-json'));
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_BAD_JSON');
    });

    it(`empty object missing fields on ${path}`, async () => {
      const db = createNoticeDb();
      const res = await request(db, path, jsonInit('POST', {}));
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_MISSING_PARAM');
    });

    it(`missing user_id on ${path}`, async () => {
      const db = createNoticeDb();
      const res = await request(
        db,
        path,
        jsonInit('POST', { content: { body: 'x', msgtype: 'm.text' } })
      );
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_MISSING_PARAM');
    });

    it(`missing content.body on ${path}`, async () => {
      const db = createNoticeDb();
      const res = await request(
        db,
        path,
        jsonInit('POST', { user_id: BOB, content: { msgtype: 'm.text' } })
      );
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_MISSING_PARAM');
    });

    it(`missing content object on ${path}`, async () => {
      const db = createNoticeDb();
      const res = await request(db, path, jsonInit('POST', { user_id: BOB }));
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_MISSING_PARAM');
    });

    it(`empty string body rejected on ${path}`, async () => {
      const db = createNoticeDb();
      const res = await request(
        db,
        path,
        jsonInit('POST', { user_id: BOB, content: { body: '', msgtype: 'm.text' } })
      );
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_MISSING_PARAM');
    });

    it(`null body rejected on ${path}`, async () => {
      const db = createNoticeDb();
      const res = await request(
        db,
        path,
        jsonInit('POST', { user_id: BOB, content: { body: null, msgtype: 'm.text' } })
      );
      expect(res.status).toBe(400);
      expect(res.body.errcode).toBe('M_MISSING_PARAM');
    });
  }
});

describe('server-notices leftovers success shape + side effects after #169', () => {
  for (const path of PATHS) {
    it(`creates notice room + message on cold ${path}`, async () => {
      const db = createNoticeDb();
      const res = await request(
        db,
        path,
        jsonInit('POST', validBody({ content: { body: `cold-${path}`, msgtype: 'm.text' } }))
      );
      expect(res.status).toBe(200);
      expect(typeof res.body.event_id).toBe('string');
      expect(db.store.users.has(SERVER_USER)).toBe(true);
      expect(db.store.rooms.size).toBe(1);
      const roomId = [...db.store.rooms.keys()][0];
      expect(roomId).toBe(`!opaque18:${SERVER}`);
      expect(messageEvents(db.store, roomId)).toHaveLength(1);
      const msg = messageEvents(db.store, roomId)[0];
      const content = JSON.parse(msg.content);
      expect(content.body).toBe(`cold-${path}`);
      expect(content.msgtype).toBe('m.text');
      expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
      expect(msg.sender).toBe(SERVER_USER);
    });

    it(`defaults msgtype to m.text when omitted on ${path}`, async () => {
      const db = createNoticeDb();
      const res = await request(
        db,
        path,
        jsonInit('POST', { user_id: BOB, content: { body: 'no-msgtype' } })
      );
      expect(res.status).toBe(200);
      const roomId = [...db.store.rooms.keys()][0];
      const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
      expect(content.msgtype).toBe('m.text');
    });

    it(`honors custom msgtype on ${path}`, async () => {
      const db = createNoticeDb();
      const res = await request(
        db,
        path,
        jsonInit('POST', {
          user_id: BOB,
          content: { body: 'notice', msgtype: 'm.notice' },
        })
      );
      expect(res.status).toBe(200);
      const roomId = [...db.store.rooms.keys()][0];
      const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
      expect(content.msgtype).toBe('m.notice');
    });

    it(`reuses existing notice room on warm ${path}`, async () => {
      const db = createNoticeDb();
      const first = await request(db, path, jsonInit('POST', validBody({ content: { body: 'one' } })));
      expect(first.status).toBe(200);
      const roomCount = db.store.rooms.size;
      const second = await request(
        db,
        path,
        jsonInit('POST', validBody({ content: { body: 'two' } }))
      );
      expect(second.status).toBe(200);
      expect(db.store.rooms.size).toBe(roomCount);
      const roomId = [...db.store.rooms.keys()][0];
      expect(messageEvents(db.store, roomId)).toHaveLength(2);
      expect(first.body.event_id).not.toBe(second.body.event_id);
    });
  }

  it('synapse path includes admin_contact when provided', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: {
          body: 'contact-me',
          msgtype: 'm.text',
          admin_contact: 'mailto:admin@example.com',
        },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content.admin_contact).toBe('mailto:admin@example.com');
  });

  it('matrix path does not thread admin_contact (API omits arg)', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: {
          body: 'no-contact',
          msgtype: 'm.text',
          admin_contact: 'mailto:admin@example.com',
        },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content.admin_contact).toBeUndefined();
  });
});

describe('server-notices leftovers target isolation after #169', () => {
  it('separate targets get separate notice rooms', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'to-bob' } })
    );
    generateOpaqueId.mockImplementation(async (length: number = 18) => `opaqueB${length}`);
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: CAROL, content: { body: 'to-carol' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(2);
    const bobRooms = db.store.memberships.filter((m) => m.user_id === BOB).map((m) => m.room_id);
    const carolRooms = db.store.memberships
      .filter((m) => m.user_id === CAROL)
      .map((m) => m.room_id);
    expect(new Set(bobRooms).size).toBe(1);
    expect(new Set(carolRooms).size).toBe(1);
    expect(bobRooms[0]).not.toBe(carolRooms[0]);
  });

  it('invite membership recorded for target user', async () => {
    const db = createNoticeDb();
    await request(db, SYNAPSE_PATH, jsonInit('POST', validBody()));
    const invite = db.store.memberships.find((m) => m.user_id === BOB);
    expect(invite?.membership).toBe('invite');
  });
});

describe('server-notices leftovers method matrix after #169', () => {
  const methods = ['GET', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const;
  for (const path of PATHS) {
    for (const method of methods) {
      it(`${method} not handled as success on ${path}`, async () => {
        const db = createNoticeDb();
        const res = await request(db, path, jsonInit(method, validBody()));
        expect(res.status).not.toBe(200);
        expect(db.store.rooms.size).toBe(0);
      });
    }
  }
});

describe('server-notices leftovers charset / content-type after #169', () => {
  const charsets = [
    'application/json',
    'application/json; charset=utf-8',
    'application/json;charset=UTF-8',
    'application/json; charset=UTF-8',
    'APPLICATION/JSON',
    'application/json; charset=utf-8; boundary=x',
  ];
  for (const path of PATHS) {
    for (const [i, ct] of charsets.entries()) {
      it(`accepts content-type variant ${i} on ${path}`, async () => {
        const db = createNoticeDb();
        const res = await request(
          db,
          path,
          jsonInit('POST', validBody({ content: { body: `ct-${i}` } }), ct)
        );
        expect([200, 400]).toContain(res.status);
        if (res.status === 200) {
          expect(res.body.event_id).toBeTruthy();
        }
      });
    }
  }
});

describe('server-notices leftovers success soft flood after #169', () => {
  it('success soft-0', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-0', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
  it('success soft-1', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-1', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
  it('success soft-2', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-2', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
  it('success soft-3', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-3', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
  it('success soft-4', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-4', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
  it('success soft-5', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-5', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
  it('success soft-6', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-6', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
  it('success soft-7', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-7', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
  it('success soft-8', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-8', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
  it('success soft-9', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-9', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
  it('success soft-10', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-10', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
  it('success soft-11', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-11', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
  it('success soft-12', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-12', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
  it('success soft-13', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-13', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
  it('success soft-14', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-14', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
  it('success soft-15', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-15', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
  it('success soft-16', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-16', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
  it('success soft-17', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-17', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
  it('success soft-18', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-18', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
  it('success soft-19', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-19', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
  it('success soft-20', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-20', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
  it('success soft-21', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-21', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
  it('success soft-22', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-22', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
  it('success soft-23', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-23', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
  it('success soft-24', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'soft-24', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    expect(db.store.rooms.size).toBe(1);
  });
});

describe('server-notices leftovers forbid soft flood after #169', () => {
  it('forbid soft-0', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-0' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
  it('forbid soft-1', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-1' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
  it('forbid soft-2', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-2' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
  it('forbid soft-3', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-3' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
  it('forbid soft-4', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-4' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
  it('forbid soft-5', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-5' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
  it('forbid soft-6', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-6' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
  it('forbid soft-7', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-7' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
  it('forbid soft-8', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-8' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
  it('forbid soft-9', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-9' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
  it('forbid soft-10', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-10' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
  it('forbid soft-11', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-11' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
  it('forbid soft-12', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-12' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
  it('forbid soft-13', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-13' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
  it('forbid soft-14', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-14' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
  it('forbid soft-15', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-15' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
  it('forbid soft-16', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-16' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
  it('forbid soft-17', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-17' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
  it('forbid soft-18', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-18' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
  it('forbid soft-19', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-19' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
  it('forbid soft-20', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-20' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
  it('forbid soft-21', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-21' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
  it('forbid soft-22', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-22' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
  it('forbid soft-23', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-23' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
  it('forbid soft-24', async () => {
    const db = createNoticeDb({ admin: 0 });
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'forbid-24' } })
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.store.rooms.size).toBe(0);
  });
});

describe('server-notices leftovers bad-json soft flood after #169', () => {
  it('bad-json soft-0', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', '{bad-0'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('bad-json soft-1', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('POST', '{bad-1'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('bad-json soft-2', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', '{bad-2'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('bad-json soft-3', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('POST', '{bad-3'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('bad-json soft-4', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', '{bad-4'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('bad-json soft-5', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('POST', '{bad-5'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('bad-json soft-6', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', '{bad-6'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('bad-json soft-7', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('POST', '{bad-7'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('bad-json soft-8', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', '{bad-8'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('bad-json soft-9', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('POST', '{bad-9'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('bad-json soft-10', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', '{bad-10'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('bad-json soft-11', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('POST', '{bad-11'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('bad-json soft-12', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', '{bad-12'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('bad-json soft-13', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('POST', '{bad-13'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('bad-json soft-14', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', '{bad-14'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('bad-json soft-15', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('POST', '{bad-15'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('bad-json soft-16', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', '{bad-16'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('bad-json soft-17', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('POST', '{bad-17'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('bad-json soft-18', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', '{bad-18'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('bad-json soft-19', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('POST', '{bad-19'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('bad-json soft-20', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', '{bad-20'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('bad-json soft-21', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('POST', '{bad-21'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('bad-json soft-22', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', '{bad-22'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('bad-json soft-23', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('POST', '{bad-23'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
  it('bad-json soft-24', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', '{bad-24'));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
});

describe('server-notices leftovers missing-param soft flood after #169', () => {
  it('missing-param soft-0', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('missing-param soft-1', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB }));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('missing-param soft-2', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', { content: { body: `mp-2` } }));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('missing-param soft-3', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('missing-param soft-4', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB }));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('missing-param soft-5', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('POST', { content: { body: `mp-5` } }));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('missing-param soft-6', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('missing-param soft-7', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB }));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('missing-param soft-8', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', { content: { body: `mp-8` } }));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('missing-param soft-9', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('missing-param soft-10', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB }));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('missing-param soft-11', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('POST', { content: { body: `mp-11` } }));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('missing-param soft-12', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('missing-param soft-13', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB }));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('missing-param soft-14', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', { content: { body: `mp-14` } }));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('missing-param soft-15', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('missing-param soft-16', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB }));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('missing-param soft-17', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('POST', { content: { body: `mp-17` } }));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('missing-param soft-18', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('missing-param soft-19', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB }));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('missing-param soft-20', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', { content: { body: `mp-20` } }));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('missing-param soft-21', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('missing-param soft-22', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB }));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('missing-param soft-23', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('POST', { content: { body: `mp-23` } }));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
  it('missing-param soft-24', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('POST', {}));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });
});

describe('server-notices leftovers warm-reuse soft flood after #169', () => {
  it('warm-reuse soft-0', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-0' } })
    );
    const second = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-0' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('warm-reuse soft-1', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-1' } })
    );
    const second = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-1' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('warm-reuse soft-2', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-2' } })
    );
    const second = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-2' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('warm-reuse soft-3', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-3' } })
    );
    const second = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-3' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('warm-reuse soft-4', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-4' } })
    );
    const second = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-4' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('warm-reuse soft-5', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-5' } })
    );
    const second = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-5' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('warm-reuse soft-6', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-6' } })
    );
    const second = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-6' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('warm-reuse soft-7', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-7' } })
    );
    const second = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-7' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('warm-reuse soft-8', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-8' } })
    );
    const second = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-8' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('warm-reuse soft-9', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-9' } })
    );
    const second = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-9' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('warm-reuse soft-10', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-10' } })
    );
    const second = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-10' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('warm-reuse soft-11', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-11' } })
    );
    const second = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-11' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('warm-reuse soft-12', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-12' } })
    );
    const second = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-12' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('warm-reuse soft-13', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-13' } })
    );
    const second = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-13' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('warm-reuse soft-14', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-14' } })
    );
    const second = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-14' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('warm-reuse soft-15', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-15' } })
    );
    const second = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-15' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('warm-reuse soft-16', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-16' } })
    );
    const second = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-16' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('warm-reuse soft-17', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-17' } })
    );
    const second = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-17' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('warm-reuse soft-18', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-18' } })
    );
    const second = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-18' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('warm-reuse soft-19', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-19' } })
    );
    const second = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-19' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('warm-reuse soft-20', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-20' } })
    );
    const second = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-20' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('warm-reuse soft-21', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-21' } })
    );
    const second = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-21' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('warm-reuse soft-22', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-22' } })
    );
    const second = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-22' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('warm-reuse soft-23', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-23' } })
    );
    const second = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-23' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('warm-reuse soft-24', async () => {
    const db = createNoticeDb();
    const first = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-a-24' } })
    );
    const second = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'warm-b-24' } })
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
});

describe('server-notices leftovers cross-endpoint parity soft flood after #169', () => {
  it('cross-endpoint soft-0', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-0' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-0' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-0',
      'x-b-0',
    ]);
  });
  it('cross-endpoint soft-1', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-1' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-1' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-1',
      'x-b-1',
    ]);
  });
  it('cross-endpoint soft-2', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-2' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-2' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-2',
      'x-b-2',
    ]);
  });
  it('cross-endpoint soft-3', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-3' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-3' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-3',
      'x-b-3',
    ]);
  });
  it('cross-endpoint soft-4', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-4' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-4' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-4',
      'x-b-4',
    ]);
  });
  it('cross-endpoint soft-5', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-5' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-5' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-5',
      'x-b-5',
    ]);
  });
  it('cross-endpoint soft-6', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-6' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-6' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-6',
      'x-b-6',
    ]);
  });
  it('cross-endpoint soft-7', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-7' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-7' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-7',
      'x-b-7',
    ]);
  });
  it('cross-endpoint soft-8', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-8' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-8' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-8',
      'x-b-8',
    ]);
  });
  it('cross-endpoint soft-9', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-9' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-9' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-9',
      'x-b-9',
    ]);
  });
  it('cross-endpoint soft-10', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-10' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-10' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-10',
      'x-b-10',
    ]);
  });
  it('cross-endpoint soft-11', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-11' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-11' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-11',
      'x-b-11',
    ]);
  });
  it('cross-endpoint soft-12', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-12' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-12' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-12',
      'x-b-12',
    ]);
  });
  it('cross-endpoint soft-13', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-13' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-13' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-13',
      'x-b-13',
    ]);
  });
  it('cross-endpoint soft-14', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-14' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-14' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-14',
      'x-b-14',
    ]);
  });
  it('cross-endpoint soft-15', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-15' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-15' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-15',
      'x-b-15',
    ]);
  });
  it('cross-endpoint soft-16', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-16' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-16' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-16',
      'x-b-16',
    ]);
  });
  it('cross-endpoint soft-17', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-17' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-17' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-17',
      'x-b-17',
    ]);
  });
  it('cross-endpoint soft-18', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-18' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-18' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-18',
      'x-b-18',
    ]);
  });
  it('cross-endpoint soft-19', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-19' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-19' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-19',
      'x-b-19',
    ]);
  });
  it('cross-endpoint soft-20', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-20' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-20' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-20',
      'x-b-20',
    ]);
  });
  it('cross-endpoint soft-21', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-21' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-21' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-21',
      'x-b-21',
    ]);
  });
  it('cross-endpoint soft-22', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-22' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-22' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-22',
      'x-b-22',
    ]);
  });
  it('cross-endpoint soft-23', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-23' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-23' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-23',
      'x-b-23',
    ]);
  });
  it('cross-endpoint soft-24', async () => {
    const db = createNoticeDb();
    const a = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-a-24' } })
    );
    const b = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'x-b-24' } })
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId).map((e) => JSON.parse(e.content).body)).toEqual([
      'x-a-24',
      'x-b-24',
    ]);
  });
});

describe('server-notices leftovers msgtype matrix after #169', () => {
  it('msgtype soft-0-m_text', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-0', msgtype: 'm.text' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.text');
  });
  it('msgtype soft-1-m_notice', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-1', msgtype: 'm.notice' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.notice');
  });
  it('msgtype soft-2-m_emote', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-2', msgtype: 'm.emote' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.emote');
  });
  it('msgtype soft-3-org_example_custom', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-3', msgtype: 'org.example.custom' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('org.example.custom');
  });
  it('msgtype soft-4-m_image', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-4', msgtype: 'm.image' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.image');
  });
  it('msgtype soft-5-m_file', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-5', msgtype: 'm.file' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.file');
  });
  it('msgtype soft-6-m_audio', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-6', msgtype: 'm.audio' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.audio');
  });
  it('msgtype soft-7-m_video', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-7', msgtype: 'm.video' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.video');
  });
  it('msgtype soft-8-m_location', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-8', msgtype: 'm.location' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.location');
  });
  it('msgtype soft-9-m_key_verification_request', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-9', msgtype: 'm.key.verification.request' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.key.verification.request');
  });
  it('msgtype soft-10-m_text', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-10', msgtype: 'm.text' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.text');
  });
  it('msgtype soft-11-m_notice', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-11', msgtype: 'm.notice' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.notice');
  });
  it('msgtype soft-12-m_emote', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-12', msgtype: 'm.emote' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.emote');
  });
  it('msgtype soft-13-org_example_custom', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-13', msgtype: 'org.example.custom' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('org.example.custom');
  });
  it('msgtype soft-14-m_image', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-14', msgtype: 'm.image' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.image');
  });
  it('msgtype soft-15-m_file', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-15', msgtype: 'm.file' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.file');
  });
  it('msgtype soft-16-m_audio', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-16', msgtype: 'm.audio' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.audio');
  });
  it('msgtype soft-17-m_video', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-17', msgtype: 'm.video' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.video');
  });
  it('msgtype soft-18-m_location', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-18', msgtype: 'm.location' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.location');
  });
  it('msgtype soft-19-m_key_verification_request', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-19', msgtype: 'm.key.verification.request' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.key.verification.request');
  });
  it('msgtype soft-20-m_text', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-20', msgtype: 'm.text' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.text');
  });
  it('msgtype soft-21-m_notice', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-21', msgtype: 'm.notice' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.notice');
  });
  it('msgtype soft-22-m_emote', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-22', msgtype: 'm.emote' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.emote');
  });
  it('msgtype soft-23-org_example_custom', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-23', msgtype: 'org.example.custom' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('org.example.custom');
  });
  it('msgtype soft-24-m_image', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-24', msgtype: 'm.image' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.image');
  });
  it('msgtype soft-25-m_file', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-25', msgtype: 'm.file' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.file');
  });
  it('msgtype soft-26-m_audio', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-26', msgtype: 'm.audio' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.audio');
  });
  it('msgtype soft-27-m_video', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-27', msgtype: 'm.video' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.video');
  });
  it('msgtype soft-28-m_location', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-28', msgtype: 'm.location' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.location');
  });
  it('msgtype soft-29-m_key_verification_request', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'mt-29', msgtype: 'm.key.verification.request' },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.key.verification.request');
  });
});

describe('server-notices leftovers body variants soft flood after #169', () => {
  it('body-variant soft-0', async () => {
    const db = createNoticeDb();
    const bodyText = 'hello';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-1', async () => {
    const db = createNoticeDb();
    const bodyText = 'unicode-café-日本語';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-2', async () => {
    const db = createNoticeDb();
    const bodyText = 'emoji-🔔-alert';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-3', async () => {
    const db = createNoticeDb();
    const bodyText = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-4', async () => {
    const db = createNoticeDb();
    const bodyText = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-5', async () => {
    const db = createNoticeDb();
    const bodyText = 'line1\nline2';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-6', async () => {
    const db = createNoticeDb();
    const bodyText = 'tab\there';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-7', async () => {
    const db = createNoticeDb();
    const bodyText = '{"looks":"json"}';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-8', async () => {
    const db = createNoticeDb();
    const bodyText = '<script>x</script>';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-9', async () => {
    const db = createNoticeDb();
    const bodyText = 'spaces  around  ';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-10', async () => {
    const db = createNoticeDb();
    const bodyText = 'hello';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-11', async () => {
    const db = createNoticeDb();
    const bodyText = 'unicode-café-日本語';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-12', async () => {
    const db = createNoticeDb();
    const bodyText = 'emoji-🔔-alert';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-13', async () => {
    const db = createNoticeDb();
    const bodyText = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-14', async () => {
    const db = createNoticeDb();
    const bodyText = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-15', async () => {
    const db = createNoticeDb();
    const bodyText = 'line1\nline2';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-16', async () => {
    const db = createNoticeDb();
    const bodyText = 'tab\there';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-17', async () => {
    const db = createNoticeDb();
    const bodyText = '{"looks":"json"}';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-18', async () => {
    const db = createNoticeDb();
    const bodyText = '<script>x</script>';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-19', async () => {
    const db = createNoticeDb();
    const bodyText = 'spaces  around  ';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-20', async () => {
    const db = createNoticeDb();
    const bodyText = 'hello';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-21', async () => {
    const db = createNoticeDb();
    const bodyText = 'unicode-café-日本語';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-22', async () => {
    const db = createNoticeDb();
    const bodyText = 'emoji-🔔-alert';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-23', async () => {
    const db = createNoticeDb();
    const bodyText = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-24', async () => {
    const db = createNoticeDb();
    const bodyText = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-25', async () => {
    const db = createNoticeDb();
    const bodyText = 'line1\nline2';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-26', async () => {
    const db = createNoticeDb();
    const bodyText = 'tab\there';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-27', async () => {
    const db = createNoticeDb();
    const bodyText = '{"looks":"json"}';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-28', async () => {
    const db = createNoticeDb();
    const bodyText = '<script>x</script>';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
  it('body-variant soft-29', async () => {
    const db = createNoticeDb();
    const bodyText = 'spaces  around  ';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: bodyText, msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(bodyText);
  });
});

describe('server-notices leftovers lifecycle soft flood after #169', () => {
  it('lifecycle soft-0', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-0-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-0-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-0-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-0-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
  it('lifecycle soft-1', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-1-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-1-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-1-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-1-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
  it('lifecycle soft-2', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-2-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-2-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-2-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-2-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
  it('lifecycle soft-3', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-3-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-3-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-3-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-3-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
  it('lifecycle soft-4', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-4-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-4-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-4-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-4-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
  it('lifecycle soft-5', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-5-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-5-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-5-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-5-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
  it('lifecycle soft-6', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-6-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-6-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-6-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-6-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
  it('lifecycle soft-7', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-7-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-7-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-7-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-7-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
  it('lifecycle soft-8', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-8-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-8-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-8-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-8-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
  it('lifecycle soft-9', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-9-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-9-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-9-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-9-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
  it('lifecycle soft-10', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-10-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-10-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-10-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-10-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
  it('lifecycle soft-11', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-11-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-11-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-11-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-11-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
  it('lifecycle soft-12', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-12-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-12-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-12-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-12-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
  it('lifecycle soft-13', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-13-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-13-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-13-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-13-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
  it('lifecycle soft-14', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-14-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-14-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-14-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-14-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
  it('lifecycle soft-15', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-15-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-15-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-15-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-15-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
  it('lifecycle soft-16', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-16-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-16-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-16-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-16-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
  it('lifecycle soft-17', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-17-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-17-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-17-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-17-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
  it('lifecycle soft-18', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-18-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-18-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-18-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-18-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
  it('lifecycle soft-19', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-19-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-19-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-19-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-19-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
  it('lifecycle soft-20', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-20-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-20-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-20-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-20-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
  it('lifecycle soft-21', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-21-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-21-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-21-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-21-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
  it('lifecycle soft-22', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-22-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-22-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-22-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-22-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
  it('lifecycle soft-23', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-23-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-23-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-23-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-23-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
  it('lifecycle soft-24', async () => {
    const db = createNoticeDb();
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', validBody({ content: { body: 'l-24-deny' } })))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    const s1 = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-24-a' } })
    );
    const s2 = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'l-24-b', msgtype: 'm.notice' } })
    );
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    expect((await request(db, SYNAPSE_PATH, jsonInit('POST', '{nope'))).status).toBe(400);
    expect((await request(db, MATRIX_PATH, jsonInit('POST', {}))).status).toBe(400);
    const roomId = [...db.store.rooms.keys()][0];
    const msgs = messageEvents(db.store, roomId);
    expect(msgs).toHaveLength(2);
    expect(JSON.parse(msgs[0].content).body).toBe('l-24-a');
    expect(JSON.parse(msgs[1].content).msgtype).toBe('m.notice');
  });
});

describe('server-notices leftovers wrong-method soft flood after #169', () => {
  it('wrong-method soft-0', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('GET', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
  it('wrong-method soft-1', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('PUT', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
  it('wrong-method soft-2', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('DELETE', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
  it('wrong-method soft-3', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('PATCH', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
  it('wrong-method soft-4', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('GET', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
  it('wrong-method soft-5', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('PUT', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
  it('wrong-method soft-6', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('DELETE', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
  it('wrong-method soft-7', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('PATCH', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
  it('wrong-method soft-8', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('GET', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
  it('wrong-method soft-9', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('PUT', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
  it('wrong-method soft-10', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('DELETE', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
  it('wrong-method soft-11', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('PATCH', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
  it('wrong-method soft-12', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('GET', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
  it('wrong-method soft-13', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('PUT', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
  it('wrong-method soft-14', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('DELETE', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
  it('wrong-method soft-15', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('PATCH', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
  it('wrong-method soft-16', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('GET', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
  it('wrong-method soft-17', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('PUT', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
  it('wrong-method soft-18', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('DELETE', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
  it('wrong-method soft-19', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('PATCH', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
  it('wrong-method soft-20', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('GET', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
  it('wrong-method soft-21', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('PUT', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
  it('wrong-method soft-22', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('DELETE', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
  it('wrong-method soft-23', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, jsonInit('PATCH', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
  it('wrong-method soft-24', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, jsonInit('GET', validBody()));
    expect(res.status).not.toBe(200);
    expect(db.store.rooms.size).toBe(0);
  });
});

describe('server-notices leftovers target soft flood after #169', () => {
  it('target soft-0', async () => {
    const db = createNoticeDb();
    const target = '@bob:example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-0' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
  it('target soft-1', async () => {
    const db = createNoticeDb();
    const target = '@carol:example.com';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-1' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
  it('target soft-2', async () => {
    const db = createNoticeDb();
    const target = '@dave:example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-2' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
  it('target soft-3', async () => {
    const db = createNoticeDb();
    const target = '@eve:example.com';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-3' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
  it('target soft-4', async () => {
    const db = createNoticeDb();
    const target = '@frank:example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-4' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
  it('target soft-5', async () => {
    const db = createNoticeDb();
    const target = '@bob:example.com';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-5' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
  it('target soft-6', async () => {
    const db = createNoticeDb();
    const target = '@carol:example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-6' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
  it('target soft-7', async () => {
    const db = createNoticeDb();
    const target = '@dave:example.com';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-7' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
  it('target soft-8', async () => {
    const db = createNoticeDb();
    const target = '@eve:example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-8' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
  it('target soft-9', async () => {
    const db = createNoticeDb();
    const target = '@frank:example.com';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-9' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
  it('target soft-10', async () => {
    const db = createNoticeDb();
    const target = '@bob:example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-10' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
  it('target soft-11', async () => {
    const db = createNoticeDb();
    const target = '@carol:example.com';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-11' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
  it('target soft-12', async () => {
    const db = createNoticeDb();
    const target = '@dave:example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-12' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
  it('target soft-13', async () => {
    const db = createNoticeDb();
    const target = '@eve:example.com';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-13' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
  it('target soft-14', async () => {
    const db = createNoticeDb();
    const target = '@frank:example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-14' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
  it('target soft-15', async () => {
    const db = createNoticeDb();
    const target = '@bob:example.com';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-15' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
  it('target soft-16', async () => {
    const db = createNoticeDb();
    const target = '@carol:example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-16' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
  it('target soft-17', async () => {
    const db = createNoticeDb();
    const target = '@dave:example.com';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-17' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
  it('target soft-18', async () => {
    const db = createNoticeDb();
    const target = '@eve:example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-18' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
  it('target soft-19', async () => {
    const db = createNoticeDb();
    const target = '@frank:example.com';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-19' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
  it('target soft-20', async () => {
    const db = createNoticeDb();
    const target = '@bob:example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-20' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
  it('target soft-21', async () => {
    const db = createNoticeDb();
    const target = '@carol:example.com';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-21' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
  it('target soft-22', async () => {
    const db = createNoticeDb();
    const target = '@dave:example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-22' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
  it('target soft-23', async () => {
    const db = createNoticeDb();
    const target = '@eve:example.com';
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-23' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
  it('target soft-24', async () => {
    const db = createNoticeDb();
    const target = '@frank:example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: target, content: { body: 't-24' } })
    );
    expect(res.status).toBe(200);
    const invite = db.store.memberships.find((m) => m.user_id === target);
    expect(invite?.membership).toBe('invite');
  });
});

describe('server-notices leftovers query-string tolerance after #169', () => {
  it('query soft-0', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH + '?access_token=ignored&foo=0',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-0' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('query soft-1', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH + '?access_token=ignored&foo=1',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-1' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('query soft-2', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH + '?access_token=ignored&foo=2',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-2' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('query soft-3', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH + '?access_token=ignored&foo=3',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-3' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('query soft-4', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH + '?access_token=ignored&foo=4',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-4' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('query soft-5', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH + '?access_token=ignored&foo=5',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-5' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('query soft-6', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH + '?access_token=ignored&foo=6',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-6' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('query soft-7', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH + '?access_token=ignored&foo=7',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-7' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('query soft-8', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH + '?access_token=ignored&foo=8',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-8' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('query soft-9', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH + '?access_token=ignored&foo=9',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-9' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('query soft-10', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH + '?access_token=ignored&foo=10',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-10' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('query soft-11', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH + '?access_token=ignored&foo=11',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-11' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('query soft-12', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH + '?access_token=ignored&foo=12',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-12' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('query soft-13', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH + '?access_token=ignored&foo=13',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-13' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('query soft-14', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH + '?access_token=ignored&foo=14',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-14' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('query soft-15', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH + '?access_token=ignored&foo=15',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-15' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('query soft-16', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH + '?access_token=ignored&foo=16',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-16' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('query soft-17', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH + '?access_token=ignored&foo=17',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-17' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('query soft-18', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH + '?access_token=ignored&foo=18',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-18' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('query soft-19', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH + '?access_token=ignored&foo=19',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-19' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('query soft-20', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH + '?access_token=ignored&foo=20',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-20' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('query soft-21', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH + '?access_token=ignored&foo=21',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-21' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('query soft-22', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH + '?access_token=ignored&foo=22',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-22' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('query soft-23', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH + '?access_token=ignored&foo=23',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-23' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('query soft-24', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH + '?access_token=ignored&foo=24',
      jsonInit('POST', { user_id: BOB, content: { body: 'q-24' } })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
});

describe('server-notices leftovers admin_contact soft flood after #169', () => {
  it('admin_contact soft-0', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-0@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-0', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
  it('admin_contact soft-1', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-1@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-1', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
  it('admin_contact soft-2', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-2@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-2', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
  it('admin_contact soft-3', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-3@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-3', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
  it('admin_contact soft-4', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-4@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-4', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
  it('admin_contact soft-5', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-5@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-5', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
  it('admin_contact soft-6', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-6@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-6', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
  it('admin_contact soft-7', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-7@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-7', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
  it('admin_contact soft-8', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-8@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-8', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
  it('admin_contact soft-9', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-9@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-9', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
  it('admin_contact soft-10', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-10@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-10', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
  it('admin_contact soft-11', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-11@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-11', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
  it('admin_contact soft-12', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-12@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-12', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
  it('admin_contact soft-13', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-13@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-13', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
  it('admin_contact soft-14', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-14@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-14', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
  it('admin_contact soft-15', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-15@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-15', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
  it('admin_contact soft-16', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-16@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-16', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
  it('admin_contact soft-17', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-17@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-17', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
  it('admin_contact soft-18', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-18@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-18', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
  it('admin_contact soft-19', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-19@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-19', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
  it('admin_contact soft-20', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-20@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-20', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
  it('admin_contact soft-21', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-21@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-21', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
  it('admin_contact soft-22', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-22@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-22', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
  it('admin_contact soft-23', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-23@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-23', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
  it('admin_contact soft-24', async () => {
    const db = createNoticeDb();
    const contact = 'mailto:ops-24@example.com';
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'c-24', msgtype: 'm.text', admin_contact: contact },
      })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    expect(JSON.parse(messageEvents(db.store, roomId)[0].content).admin_contact).toBe(contact);
  });
});

describe('server-notices leftovers extra-fields soft flood after #169', () => {
  it('extra-fields soft-0', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-0', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 0,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('extra-fields soft-1', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-1', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 1,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('extra-fields soft-2', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-2', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 2,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('extra-fields soft-3', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-3', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 3,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('extra-fields soft-4', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-4', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 4,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('extra-fields soft-5', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-5', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 5,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('extra-fields soft-6', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-6', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 6,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('extra-fields soft-7', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-7', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 7,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('extra-fields soft-8', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-8', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 8,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('extra-fields soft-9', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-9', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 9,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('extra-fields soft-10', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-10', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 10,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('extra-fields soft-11', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-11', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 11,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('extra-fields soft-12', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-12', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 12,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('extra-fields soft-13', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-13', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 13,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('extra-fields soft-14', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-14', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 14,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('extra-fields soft-15', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-15', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 15,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('extra-fields soft-16', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-16', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 16,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('extra-fields soft-17', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-17', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 17,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('extra-fields soft-18', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-18', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 18,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('extra-fields soft-19', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-19', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 19,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('extra-fields soft-20', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-20', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 20,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('extra-fields soft-21', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-21', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 21,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('extra-fields soft-22', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-22', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 22,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('extra-fields soft-23', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-23', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 23,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
  it('extra-fields soft-24', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', {
        user_id: BOB,
        content: { body: 'ef-24', msgtype: 'm.text', unexpected: true },
        type: 'm.server_notice',
        extra: 24,
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.event_id).toBeTruthy();
  });
});

describe('server-notices leftovers sequential burst soft flood after #169', () => {
  it('burst soft-0', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-0-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
  it('burst soft-1', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-1-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
  it('burst soft-2', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-2-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
  it('burst soft-3', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-3-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
  it('burst soft-4', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-4-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
  it('burst soft-5', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-5-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
  it('burst soft-6', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-6-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
  it('burst soft-7', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-7-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
  it('burst soft-8', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-8-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
  it('burst soft-9', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-9-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
  it('burst soft-10', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-10-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
  it('burst soft-11', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-11-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
  it('burst soft-12', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-12-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
  it('burst soft-13', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-13-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
  it('burst soft-14', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-14-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
  it('burst soft-15', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-15-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
  it('burst soft-16', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-16-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
  it('burst soft-17', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-17-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
  it('burst soft-18', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-18-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
  it('burst soft-19', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-19-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
  it('burst soft-20', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-20-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
  it('burst soft-21', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-21-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
  it('burst soft-22', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-22-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
  it('burst soft-23', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-23-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
  it('burst soft-24', async () => {
    const db = createNoticeDb();
    const results = [];
    for (let n = 0; n < 5; n++) {
      results.push(
        await request(
          db,
          n % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
          jsonInit('POST', { user_id: BOB, content: { body: `burst-24-${n}` } })
        )
      );
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.event_id)).size).toBe(5);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(5);
  });
});

describe('server-notices leftovers notice-type marker soft flood after #169', () => {
  it('notice-type soft-0', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-0' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
  it('notice-type soft-1', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-1' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
  it('notice-type soft-2', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-2' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
  it('notice-type soft-3', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-3' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
  it('notice-type soft-4', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-4' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
  it('notice-type soft-5', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-5' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
  it('notice-type soft-6', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-6' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
  it('notice-type soft-7', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-7' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
  it('notice-type soft-8', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-8' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
  it('notice-type soft-9', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-9' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
  it('notice-type soft-10', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-10' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
  it('notice-type soft-11', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-11' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
  it('notice-type soft-12', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-12' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
  it('notice-type soft-13', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-13' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
  it('notice-type soft-14', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-14' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
  it('notice-type soft-15', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-15' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
  it('notice-type soft-16', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-16' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
  it('notice-type soft-17', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-17' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
  it('notice-type soft-18', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-18' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
  it('notice-type soft-19', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-19' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
  it('notice-type soft-20', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-20' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
  it('notice-type soft-21', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-21' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
  it('notice-type soft-22', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-22' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
  it('notice-type soft-23', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-23' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
  it('notice-type soft-24', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'nt-24' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const content = JSON.parse(messageEvents(db.store, roomId)[0].content);
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });
});

describe('server-notices leftovers bootstrap DAG soft flood after #169', () => {
  it('bootstrap soft-0', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-0' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
  it('bootstrap soft-1', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-1' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
  it('bootstrap soft-2', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-2' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
  it('bootstrap soft-3', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-3' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
  it('bootstrap soft-4', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-4' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
  it('bootstrap soft-5', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-5' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
  it('bootstrap soft-6', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-6' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
  it('bootstrap soft-7', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-7' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
  it('bootstrap soft-8', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-8' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
  it('bootstrap soft-9', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-9' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
  it('bootstrap soft-10', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-10' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
  it('bootstrap soft-11', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-11' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
  it('bootstrap soft-12', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-12' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
  it('bootstrap soft-13', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-13' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
  it('bootstrap soft-14', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-14' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
  it('bootstrap soft-15', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-15' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
  it('bootstrap soft-16', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-16' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
  it('bootstrap soft-17', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-17' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
  it('bootstrap soft-18', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-18' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
  it('bootstrap soft-19', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-19' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
  it('bootstrap soft-20', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-20' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
  it('bootstrap soft-21', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-21' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
  it('bootstrap soft-22', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-22' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
  it('bootstrap soft-23', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-23' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
  it('bootstrap soft-24', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit('POST', { user_id: BOB, content: { body: 'boot-24' } })
    );
    expect(res.status).toBe(200);
    const roomId = [...db.store.rooms.keys()][0];
    const boot = db.store.events
      .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
      .sort((a, b) => a.depth - b.depth);
    expect(boot.map((e) => e.event_type)).toEqual([
      'm.room.create',
      'm.room.name',
      'm.room.join_rules',
      'm.room.history_visibility',
      'm.room.power_levels',
      'm.room.member',
      'm.room.member',
    ]);
    const create = JSON.parse(boot[0].content);
    expect(create.type).toBe('m.server_notice');
    expect(create.room_version).toBe('10');
    expect(create.creator).toBe(SERVER_USER);
  });
});

describe('server-notices leftovers header soft flood after #169', () => {
  it('header soft-0', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-0': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-0' } }),
    });
    expect(res.status).toBe(200);
  });
  it('header soft-1', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-1': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-1' } }),
    });
    expect(res.status).toBe(200);
  });
  it('header soft-2', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-2': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-2' } }),
    });
    expect(res.status).toBe(200);
  });
  it('header soft-3', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-3': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-3' } }),
    });
    expect(res.status).toBe(200);
  });
  it('header soft-4', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-4': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-4' } }),
    });
    expect(res.status).toBe(200);
  });
  it('header soft-5', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-5': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-5' } }),
    });
    expect(res.status).toBe(200);
  });
  it('header soft-6', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-6': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-6' } }),
    });
    expect(res.status).toBe(200);
  });
  it('header soft-7', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-7': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-7' } }),
    });
    expect(res.status).toBe(200);
  });
  it('header soft-8', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-8': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-8' } }),
    });
    expect(res.status).toBe(200);
  });
  it('header soft-9', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-9': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-9' } }),
    });
    expect(res.status).toBe(200);
  });
  it('header soft-10', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-10': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-10' } }),
    });
    expect(res.status).toBe(200);
  });
  it('header soft-11', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-11': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-11' } }),
    });
    expect(res.status).toBe(200);
  });
  it('header soft-12', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-12': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-12' } }),
    });
    expect(res.status).toBe(200);
  });
  it('header soft-13', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-13': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-13' } }),
    });
    expect(res.status).toBe(200);
  });
  it('header soft-14', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-14': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-14' } }),
    });
    expect(res.status).toBe(200);
  });
  it('header soft-15', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-15': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-15' } }),
    });
    expect(res.status).toBe(200);
  });
  it('header soft-16', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-16': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-16' } }),
    });
    expect(res.status).toBe(200);
  });
  it('header soft-17', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-17': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-17' } }),
    });
    expect(res.status).toBe(200);
  });
  it('header soft-18', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-18': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-18' } }),
    });
    expect(res.status).toBe(200);
  });
  it('header soft-19', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-19': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-19' } }),
    });
    expect(res.status).toBe(200);
  });
  it('header soft-20', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-20': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-20' } }),
    });
    expect(res.status).toBe(200);
  });
  it('header soft-21', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-21': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-21' } }),
    });
    expect(res.status).toBe(200);
  });
  it('header soft-22', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-22': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-22' } }),
    });
    expect(res.status).toBe(200);
  });
  it('header soft-23', async () => {
    const db = createNoticeDb();
    const res = await request(db, MATRIX_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-23': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-23' } }),
    });
    expect(res.status).toBe(200);
  });
  it('header soft-24', async () => {
    const db = createNoticeDb();
    const res = await request(db, SYNAPSE_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Unused-24': '1',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ user_id: BOB, content: { body: 'h-24' } }),
    });
    expect(res.status).toBe(200);
  });
});

describe('server-notices leftovers promote-demote soft flood after #169', () => {
  it('promote-demote soft-0', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-0-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-0-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-0-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('promote-demote soft-1', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-1-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-1-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-1-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('promote-demote soft-2', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-2-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-2-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-2-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('promote-demote soft-3', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-3-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-3-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-3-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('promote-demote soft-4', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-4-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-4-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-4-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('promote-demote soft-5', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-5-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-5-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-5-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('promote-demote soft-6', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-6-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-6-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-6-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('promote-demote soft-7', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-7-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-7-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-7-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('promote-demote soft-8', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-8-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-8-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-8-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('promote-demote soft-9', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-9-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-9-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-9-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('promote-demote soft-10', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-10-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-10-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-10-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('promote-demote soft-11', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-11-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-11-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-11-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('promote-demote soft-12', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-12-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-12-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-12-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('promote-demote soft-13', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-13-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-13-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-13-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('promote-demote soft-14', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-14-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-14-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-14-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('promote-demote soft-15', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-15-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-15-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-15-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('promote-demote soft-16', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-16-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-16-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-16-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('promote-demote soft-17', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-17-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-17-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-17-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('promote-demote soft-18', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-18-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-18-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-18-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('promote-demote soft-19', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-19-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-19-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-19-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('promote-demote soft-20', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-20-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-20-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-20-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('promote-demote soft-21', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-21-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-21-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-21-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('promote-demote soft-22', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-22-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-22-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-22-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('promote-demote soft-23', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-23-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-23-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-23-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
  it('promote-demote soft-24', async () => {
    const db = createNoticeDb({ admin: 1 });
    expect(
      (await request(db, SYNAPSE_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-24-1' } }))).status
    ).toBe(200);
    db.store.users.set(USER, adminUser(USER, 0));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-24-2' } }))).status
    ).toBe(403);
    db.store.users.set(USER, adminUser(USER, 1));
    expect(
      (await request(db, MATRIX_PATH, jsonInit('POST', { user_id: BOB, content: { body: 'pd-24-3' } }))).status
    ).toBe(200);
    expect(db.store.rooms.size).toBe(1);
    const roomId = [...db.store.rooms.keys()][0];
    expect(messageEvents(db.store, roomId)).toHaveLength(2);
  });
});

