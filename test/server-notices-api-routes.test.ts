/**
 * TOKENMAXX HEAVY deepen after #121–#123 — different slice: server-notice HTTP admin routes.
 * Helper sendServerNotice is already thick in server-notice-helpers.test.ts; this exercises
 * Hono app.request() for Synapse-compat + client admin send_server_notice wrappers.
 * Avoids federation S2S (#122), relations (#123), voip/sync (#117–#120), appservice route suite.
 * Tests-only — no product inventing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const authState = vi.hoisted(() => ({
  userId: '@admin:example.com',
  deviceId: 'ADMINDEVICE',
}));

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', authState.userId);
      c.set('deviceId', authState.deviceId);
      await next();
    };
  },
}));

const generateOpaqueId = vi.fn(async (length: number = 18) => `opaque${String(length).padStart(2, '0')}${'x'.repeat(Math.max(0, length - 8))}`);
const generateEventId = vi.fn(async (serverName: string) => `$notice-${++eventSeq}:${serverName}`);
let eventSeq = 0;

vi.mock('../src/utils/ids', () => ({
  generateOpaqueId: (...args: unknown[]) => generateOpaqueId(...(args as [number?])),
  generateEventId: (...args: unknown[]) => generateEventId(...(args as [string])),
}));

import noticesApp from '../src/api/server-notices';

const SERVER = 'example.com';
const ADMIN = '@admin:example.com';
const TARGET = '@alice:example.com';
const SERVER_USER = `@server:${SERVER}`;
const NOTICE_ROOM_TYPE = 'm.server_notice';
const SYNAPSE_PATH = '/_synapse/admin/v1/send_server_notice';
const CLIENT_PATH = '/_matrix/client/v3/admin/send_server_notice';

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
};

function createNoticeDb(seed?: Partial<NoticeDb>): D1Database & { store: NoticeDb } {
  const store: NoticeDb = {
    users: seed?.users ?? new Map(),
    rooms: seed?.rooms ?? new Map(),
    events: seed?.events ?? [],
    roomState: seed?.roomState ?? [],
    memberships: seed?.memberships ?? [],
    sqlLog: [],
  };

  return {
    store,
    prepare(sql: string) {
      store.sqlLog.push(sql);
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT admin FROM users WHERE user_id')) {
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
              if (sql.includes('INSERT INTO events') && sql.includes("m.room.message")) {
                const [
                  eventId,
                  roomId,
                  sender,
                  content,
                  originServerTs,
                  depth,
                  authEvents,
                  prevEvents,
                ] = args as [string, string, string, string, number, number, string, string];
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
                    s.room_id === roomId && s.event_type === eventType && s.state_key === stateKey
                );
                const row = { room_id: roomId, event_type: eventType, state_key: stateKey, event_id: eventId };
                if (idx >= 0) store.roomState[idx] = row;
                else store.roomState.push(row);
                return { meta: { changes: 1 } };
              }
              if (sql.includes('INSERT INTO room_memberships')) {
                if (sql.includes('display_name')) {
                  const [roomId, userId, eventId, displayName] = args as [
                    string,
                    string,
                    string,
                    string,
                  ];
                  store.memberships.push({
                    room_id: roomId,
                    user_id: userId,
                    membership: 'join',
                    event_id: eventId,
                    display_name: displayName,
                  });
                } else {
                  const [roomId, userId, eventId] = args as [string, string, string];
                  store.memberships.push({
                    room_id: roomId,
                    user_id: userId,
                    membership: 'invite',
                    event_id: eventId,
                  });
                }
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

function seedAdmin(admin = 1, userId = ADMIN): Map<string, UserRow> {
  const users = new Map<string, UserRow>();
  users.set(userId, {
    user_id: userId,
    localpart: userId.slice(1).split(':')[0],
    display_name: 'Admin',
    admin,
    is_guest: 0,
    is_deactivated: 0,
  });
  return users;
}

function envFor(db: D1Database): Env {
  return { DB: db, SERVER_NAME: SERVER } as unknown as Env;
}

function jsonInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

async function request(
  path: string,
  init: RequestInit,
  opts: { db?: D1Database & { store: NoticeDb } } = {}
): Promise<{
  status: number;
  body: unknown;
  text: string;
  db: D1Database & { store: NoticeDb };
}> {
  const db = opts.db ?? createNoticeDb({ users: seedAdmin() });
  const res = await noticesApp.request(`http://localhost${path}`, init, envFor(db));
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body, text, db };
}

beforeEach(() => {
  eventSeq = 0;
  authState.userId = ADMIN;
  authState.deviceId = 'ADMINDEVICE';
  generateOpaqueId.mockClear();
  generateEventId.mockClear();
  generateOpaqueId.mockImplementation(
    async (length: number = 18) => `opaque${String(length).padStart(2, '0')}${'x'.repeat(Math.max(0, length - 8))}`
  );
  generateEventId.mockImplementation(
    async (serverName: string) => `$notice-${++eventSeq}:${serverName}`
  );
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-09-14T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const PATHS = [
  ['synapse', SYNAPSE_PATH],
  ['client', CLIENT_PATH],
] as const;

// ---------------------------------------------------------------------------
// Shared admin / validation gates
// ---------------------------------------------------------------------------

describe.each(PATHS)('server-notices %s POST admin gates', (_label, path) => {
  it('forbids non-admin callers', async () => {
    const db = createNoticeDb({ users: seedAdmin(0) });
    const res = await request(
      path,
      jsonInit({ user_id: TARGET, content: { body: 'hi', msgtype: 'm.text' } }),
      { db }
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN', error: 'Admin access required' });
  });

  it('forbids when the auth user row is missing', async () => {
    const db = createNoticeDb({ users: new Map() });
    const res = await request(
      path,
      jsonInit({ user_id: TARGET, content: { body: 'hi' } }),
      { db }
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('treats admin values other than 1 as forbidden', async () => {
    const users = seedAdmin(2);
    const db = createNoticeDb({ users });
    const res = await request(
      path,
      jsonInit({ user_id: TARGET, content: { body: 'hi' } }),
      { db }
    );
    expect(res.status).toBe(403);
  });

  it('rejects non-JSON bodies with M_BAD_JSON', async () => {
    const res = await request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_BAD_JSON' });
  });

  it('requires user_id', async () => {
    const res = await request(path, jsonInit({ content: { body: 'hi' } }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
    expect((res.body as { error: string }).error).toContain('user_id');
  });

  it('requires content.body', async () => {
    const res = await request(path, jsonInit({ user_id: TARGET, content: { msgtype: 'm.text' } }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('requires content object (missing content → missing param)', async () => {
    const res = await request(path, jsonInit({ user_id: TARGET }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });

  it('rejects empty string body as missing content.body', async () => {
    const res = await request(path, jsonInit({ user_id: TARGET, content: { body: '' } }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });
  });
});

// ---------------------------------------------------------------------------
// Successful send paths
// ---------------------------------------------------------------------------

describe.each(PATHS)('server-notices %s POST success paths', (_label, path) => {
  it('sends a notice, creates server user + notice room, returns event_id', async () => {
    const res = await request(
      path,
      jsonInit({ user_id: TARGET, content: { body: 'Maintenance tonight', msgtype: 'm.text' } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ event_id: `$notice-8:${SERVER}` });
    // create events (7) + message = 8 generateEventId calls when room is new
    expect(generateEventId).toHaveBeenCalled();
    expect(res.db.store.users.has(SERVER_USER)).toBe(true);
    expect(res.db.store.rooms.size).toBe(1);
    const message = res.db.store.events.find((e) => e.event_type === 'm.room.message');
    expect(message).toBeTruthy();
    expect(JSON.parse(message!.content)).toMatchObject({
      msgtype: 'm.text',
      body: 'Maintenance tonight',
      'm.server_notice_type': 'm.server_notice.usage_limit_reached',
    });
    expect(message!.sender).toBe(SERVER_USER);
  });

  it('defaults msgtype to m.text when omitted', async () => {
    const res = await request(path, jsonInit({ user_id: TARGET, content: { body: 'hello' } }));
    expect(res.status).toBe(200);
    const message = res.db.store.events.find((e) => e.event_type === 'm.room.message');
    expect(JSON.parse(message!.content).msgtype).toBe('m.text');
  });

  it('honors custom msgtype', async () => {
    const res = await request(
      path,
      jsonInit({ user_id: TARGET, content: { body: 'alert', msgtype: 'm.notice' } })
    );
    expect(res.status).toBe(200);
    const message = res.db.store.events.find((e) => e.event_type === 'm.room.message');
    expect(JSON.parse(message!.content).msgtype).toBe('m.notice');
  });

  it('reuses an existing notice room on a second send', async () => {
    const db = createNoticeDb({ users: seedAdmin() });
    const first = await request(
      path,
      jsonInit({ user_id: TARGET, content: { body: 'one' } }),
      { db }
    );
    expect(first.status).toBe(200);
    const roomCount = db.store.rooms.size;
    const second = await request(
      path,
      jsonInit({ user_id: TARGET, content: { body: 'two' } }),
      { db }
    );
    expect(second.status).toBe(200);
    expect(db.store.rooms.size).toBe(roomCount);
    const messages = db.store.events.filter((e) => e.event_type === 'm.room.message');
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => JSON.parse(m.content).body)).toEqual(['one', 'two']);
  });

  it('invites the target and joins the server notice user', async () => {
    const res = await request(path, jsonInit({ user_id: TARGET, content: { body: 'x' } }));
    const joins = res.db.store.memberships.filter((m) => m.membership === 'join');
    const invites = res.db.store.memberships.filter((m) => m.membership === 'invite');
    expect(joins.some((m) => m.user_id === SERVER_USER)).toBe(true);
    expect(invites.some((m) => m.user_id === TARGET)).toBe(true);
  });

  it('checks admin using the authenticated userId from middleware', async () => {
    authState.userId = '@otheradmin:example.com';
    const users = seedAdmin(1, '@otheradmin:example.com');
    const db = createNoticeDb({ users });
    const res = await request(
      path,
      jsonInit({ user_id: TARGET, content: { body: 'ok' } }),
      { db }
    );
    expect(res.status).toBe(200);
    expect(db.store.sqlLog.some((s) => s.includes('SELECT admin FROM users'))).toBe(true);
  });
});

describe('server-notices synapse-only admin_contact', () => {
  it('forwards admin_contact into the message content on synapse path', async () => {
    const res = await request(
      SYNAPSE_PATH,
      jsonInit({
        user_id: TARGET,
        content: {
          body: 'Contact us',
          msgtype: 'm.text',
          admin_contact: 'mailto:admin@example.com',
        },
      })
    );
    expect(res.status).toBe(200);
    const message = res.db.store.events.find((e) => e.event_type === 'm.room.message');
    expect(JSON.parse(message!.content).admin_contact).toBe('mailto:admin@example.com');
  });

  it('client path does not accept admin_contact (typed body omits it)', async () => {
    const res = await request(
      CLIENT_PATH,
      jsonInit({
        user_id: TARGET,
        content: {
          body: 'Contact us',
          msgtype: 'm.text',
          admin_contact: 'mailto:admin@example.com',
        },
      })
    );
    expect(res.status).toBe(200);
    const message = res.db.store.events.find((e) => e.event_type === 'm.room.message');
    // client handler never passes admin_contact to sendServerNotice
    expect(JSON.parse(message!.content).admin_contact).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Method probes + path isolation
// ---------------------------------------------------------------------------

describe('server-notices route probes', () => {
  for (const path of [SYNAPSE_PATH, CLIENT_PATH]) {
    it(`rejects GET on ${path}`, async () => {
      const res = await request(path, { method: 'GET' });
      expect(res.status).toBe(404);
    });

    it(`rejects PUT on ${path}`, async () => {
      const db = createNoticeDb({ users: seedAdmin() });
      const put = await noticesApp.request(
        `http://localhost${path}`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' },
        envFor(db)
      );
      expect(put.status).toBe(404);
    });

    it(`rejects DELETE on ${path}`, async () => {
      const db = createNoticeDb({ users: seedAdmin() });
      const del = await noticesApp.request(
        `http://localhost${path}`,
        { method: 'DELETE' },
        envFor(db)
      );
      expect(del.status).toBe(404);
    });
  }

  it('does not expose unrelated admin paths on this app', async () => {
    const res = await request('/_synapse/admin/v1/users', { method: 'GET' });
    expect(res.status).toBe(404);
  });
});

describe('server-notices room create content', () => {
  it('marks the created room with m.server_notice type', async () => {
    const res = await request(
      SYNAPSE_PATH,
      jsonInit({ user_id: TARGET, content: { body: 'typed' } })
    );
    const create = res.db.store.events.find((e) => e.event_type === 'm.room.create');
    expect(create).toBeTruthy();
    expect(JSON.parse(create!.content)).toMatchObject({
      type: NOTICE_ROOM_TYPE,
      room_version: '10',
      creator: SERVER_USER,
    });
  });

  it('names the room Server Notices', async () => {
    const res = await request(
      CLIENT_PATH,
      jsonInit({ user_id: TARGET, content: { body: 'named' } })
    );
    const name = res.db.store.events.find((e) => e.event_type === 'm.room.name');
    expect(JSON.parse(name!.content).name).toBe('Server Notices');
  });

  it('reuses an existing @server:domain user without double-insert', async () => {
    const users = seedAdmin();
    users.set(SERVER_USER, {
      user_id: SERVER_USER,
      localpart: 'server',
      display_name: 'Server Notices',
      admin: 0,
      is_guest: 0,
      is_deactivated: 0,
    });
    const db = createNoticeDb({ users });
    const res = await request(
      SYNAPSE_PATH,
      jsonInit({ user_id: TARGET, content: { body: 'reuse' } }),
      { db }
    );
    expect(res.status).toBe(200);
    expect(db.store.users.get(SERVER_USER)?.localpart).toBe('server');
  });
});
