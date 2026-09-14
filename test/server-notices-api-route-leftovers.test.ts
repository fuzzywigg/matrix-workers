/**
 * TOKENMAXX HEAVY leftovers after #166 — server-notices HTTP admin routes.
 * Complements server-notice-helpers.test.ts (helper/DB path already deep).
 * Orthogonal to presence/typing #166 and admin dashboard `/admin/api/server-notice`.
 * Focus: Synapse + Matrix admin POST send_server_notice auth gates, bad JSON,
 * missing params, msgtype defaulting, admin_contact fork, soft/edge floods.
 * Tests-only — no product inventing. Fixtures use example.com only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const authState = vi.hoisted(() => ({
  userId: '@admin:example.com' as string | undefined,
  deviceId: 'ADMINDEVICE',
}));

const generateOpaqueId = vi.fn(async (length: number = 18) => `opaque${++opaqueSeq}-${length}`);
const generateEventId = vi.fn(async (serverName: string) => `$evt-${++eventSeq}:${serverName}`);

let eventSeq = 0;
let opaqueSeq = 0;

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', authState.userId);
      c.set('deviceId', authState.deviceId);
      await next();
    };
  },
}));

vi.mock('../src/utils/ids', () => ({
  generateOpaqueId: (...args: unknown[]) => generateOpaqueId(...(args as [number?])),
  generateEventId: (...args: unknown[]) => generateEventId(...(args as [string])),
}));

import noticesApp from '../src/api/server-notices';

const SERVER = 'example.com';
const ADMIN = '@admin:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const DAVE = '@dave:example.com';
const SERVER_USER = `@server:${SERVER}`;
const NOTICE_ROOM_TYPE = 'm.server_notice';
const NOW = 1_700_000_000_000;

const SYNAPSE_PATH = '/_synapse/admin/v1/send_server_notice';
const MATRIX_PATH = '/_matrix/client/v3/admin/send_server_notice';
const PATHS = [SYNAPSE_PATH, MATRIX_PATH] as const;

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

function adminUser(userId = ADMIN, admin = 1): UserRow {
  const localpart = userId.slice(1).split(':')[0]!;
  return {
    user_id: userId,
    localpart,
    display_name: localpart,
    admin,
    is_guest: 0,
    is_deactivated: 0,
  };
}

function createNoticeDb(seed?: Partial<NoticeDb>): D1Database & { store: NoticeDb } {
  const store: NoticeDb = {
    users: seed?.users ?? new Map([[ADMIN, adminUser()]]),
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
                return { event_id: inRoom[0]!.event_id, depth: inRoom[0]!.depth } as T;
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

function makeEnv(db: D1Database = createNoticeDb()): Env {
  return {
    SERVER_NAME: SERVER,
    DB: db,
  } as unknown as Env;
}

async function post(
  path: string,
  body: unknown,
  env: Env = makeEnv(),
  init: RequestInit = {}
): Promise<{ status: number; body: Record<string, unknown> | string | null; res: Response; env: Env }> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && typeof body === 'object' && body !== null) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await noticesApp.request(
    `http://localhost${path}`,
    {
      method: 'POST',
      ...init,
      headers,
      body:
        typeof body === 'string' || body instanceof ArrayBuffer || body === undefined
          ? (body as BodyInit | undefined)
          : JSON.stringify(body),
    },
    env
  );
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, res, env };
}

function noticePayload(
  overrides: {
    user_id?: string | null;
    content?: {
      msgtype?: string;
      body?: string | null;
      admin_contact?: string;
    } | null;
  } = {}
) {
  const base: Record<string, unknown> = {
    user_id: overrides.user_id === undefined ? BOB : overrides.user_id,
  };
  if (overrides.content === null) {
    base.content = null;
  } else if (overrides.content === undefined) {
    base.content = { msgtype: 'm.text', body: 'hello notice' };
  } else {
    base.content = { msgtype: 'm.text', body: 'hello notice', ...overrides.content };
  }
  return base;
}

function latestMessage(store: NoticeDb): EventRow | undefined {
  return store.events
    .filter((e) => e.event_type === 'm.room.message')
    .sort((a, b) => b.depth - a.depth)[0];
}

beforeEach(() => {
  eventSeq = 0;
  opaqueSeq = 0;
  authState.userId = ADMIN;
  authState.deviceId = 'ADMINDEVICE';
  generateOpaqueId.mockReset();
  generateEventId.mockReset();
  generateOpaqueId.mockImplementation(
    async (length: number = 18) => `opaque${++opaqueSeq}-${length}`
  );
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

// ---------------------------------------------------------------------------
// Admin gate — both paths
// ---------------------------------------------------------------------------

describe('server-notices leftovers admin gate after #166', () => {
  for (const path of PATHS) {
    it(`${path} rejects missing user row`, async () => {
      authState.userId = '@ghost:example.com';
      const db = createNoticeDb({ users: new Map([[ADMIN, adminUser()]]) });
      const { status, body } = await post(path, noticePayload(), makeEnv(db));
      expect(status).toBe(403);
      expect(body.errcode).toBe('M_FORBIDDEN');
      expect(body.error).toMatch(/Admin access required/i);
      expect(db.store.events.filter((e) => e.event_type === 'm.room.message')).toHaveLength(0);
    });

    it(`${path} rejects admin=0`, async () => {
      authState.userId = BOB;
      const db = createNoticeDb({
        users: new Map([
          [ADMIN, adminUser()],
          [BOB, adminUser(BOB, 0)],
        ]),
      });
      const { status, body } = await post(path, noticePayload(), makeEnv(db));
      expect(status).toBe(403);
      expect(body.errcode).toBe('M_FORBIDDEN');
    });

    it(`${path} allows admin=1`, async () => {
      const db = createNoticeDb();
      const { status, body } = await post(path, noticePayload(), makeEnv(db));
      expect(status).toBe(200);
      expect(body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    });
  }

  for (let i = 0; i < 12; i++) {
    it(`admin gate soft-${i} admin=0 on synapse`, async () => {
      authState.userId = `@soft${i}:example.com`;
      const db = createNoticeDb({
        users: new Map([[`@soft${i}:example.com`, adminUser(`@soft${i}:example.com`, 0)]]),
      });
      const { status, body } = await post(SYNAPSE_PATH, noticePayload(), makeEnv(db));
      expect(status).toBe(403);
      expect(body.errcode).toBe('M_FORBIDDEN');
    });

    it(`admin gate soft-${i} missing row on matrix`, async () => {
      authState.userId = `@missing${i}:example.com`;
      const db = createNoticeDb({ users: new Map() });
      const { status, body } = await post(MATRIX_PATH, noticePayload(), makeEnv(db));
      expect(status).toBe(403);
      expect(body.errcode).toBe('M_FORBIDDEN');
    });
  }
});

// ---------------------------------------------------------------------------
// Bad JSON — both paths
// ---------------------------------------------------------------------------

describe('server-notices leftovers bad JSON after #166', () => {
  for (const path of PATHS) {
    it(`${path} rejects truncated JSON`, async () => {
      const { status, body } = await post(path, '{not-json', makeEnv(), {
        headers: { 'Content-Type': 'application/json' },
      });
      expect(status).toBe(400);
      expect(body.errcode).toBe('M_BAD_JSON');
    });

    it(`${path} rejects empty body as bad JSON`, async () => {
      const { status, body } = await post(path, '', makeEnv(), {
        headers: { 'Content-Type': 'application/json' },
      });
      expect(status).toBe(400);
      expect(body.errcode).toBe('M_BAD_JSON');
    });
  }

  for (let i = 0; i < 16; i++) {
    it(`bad JSON soft-${i} synapse`, async () => {
      const { status, body } = await post(SYNAPSE_PATH, `{"broken":${i}`, makeEnv(), {
        headers: { 'Content-Type': 'application/json' },
      });
      expect(status).toBe(400);
      expect(body.errcode).toBe('M_BAD_JSON');
    });

    it(`bad JSON soft-${i} matrix`, async () => {
      const { status, body } = await post(MATRIX_PATH, `[${i},`, makeEnv(), {
        headers: { 'Content-Type': 'application/json' },
      });
      expect(status).toBe(400);
      expect(body.errcode).toBe('M_BAD_JSON');
    });
  }
});

// ---------------------------------------------------------------------------
// Missing params — both paths
// ---------------------------------------------------------------------------

describe('server-notices leftovers missing params after #166', () => {
  const missingCases: Array<{ name: string; body: Record<string, unknown> }> = [
    { name: 'no user_id', body: { content: { body: 'x' } } },
    { name: 'empty user_id', body: { user_id: '', content: { body: 'x' } } },
    { name: 'null user_id', body: { user_id: null, content: { body: 'x' } } },
    { name: 'no content', body: { user_id: BOB } },
    { name: 'null content', body: { user_id: BOB, content: null } },
    { name: 'no content.body', body: { user_id: BOB, content: { msgtype: 'm.text' } } },
    { name: 'empty content.body', body: { user_id: BOB, content: { body: '' } } },
    { name: 'null content.body', body: { user_id: BOB, content: { body: null } } },
  ];

  for (const path of PATHS) {
    for (const c of missingCases) {
      it(`${path} ${c.name}`, async () => {
        const { status, body } = await post(path, c.body);
        expect(status).toBe(400);
        expect(body.errcode).toBe('M_MISSING_PARAM');
        expect(body.error).toMatch(/user_id or content\.body/);
      });
    }
  }

  for (let i = 0; i < 12; i++) {
    it(`missing params soft-${i} both paths parallel`, async () => {
      const payload = { user_id: BOB, content: { msgtype: 'm.notice' } };
      const [a, b] = await Promise.all([
        post(SYNAPSE_PATH, payload),
        post(MATRIX_PATH, payload),
      ]);
      expect(a.status).toBe(400);
      expect(b.status).toBe(400);
      expect(a.body.errcode).toBe('M_MISSING_PARAM');
      expect(b.body.errcode).toBe('M_MISSING_PARAM');
    });
  }
});

// ---------------------------------------------------------------------------
// Success — Synapse path
// ---------------------------------------------------------------------------

describe('server-notices leftovers synapse success after #166', () => {
  it('returns event_id and creates notice message', async () => {
    const db = createNoticeDb();
    const { status, body } = await post(
      SYNAPSE_PATH,
      noticePayload({ content: { body: 'synapse hello', msgtype: 'm.text' } }),
      makeEnv(db)
    );
    expect(status).toBe(200);
    expect(body).toEqual({ event_id: `$evt-8:${SERVER}` });
    const msg = latestMessage(db.store);
    expect(msg).toBeTruthy();
    expect(msg!.sender).toBe(SERVER_USER);
    const content = JSON.parse(msg!.content);
    expect(content.body).toBe('synapse hello');
    expect(content.msgtype).toBe('m.text');
    expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
  });

  it('defaults msgtype to m.text when omitted', async () => {
    const db = createNoticeDb();
    const { status, body } = await post(
      SYNAPSE_PATH,
      { user_id: BOB, content: { body: 'no msgtype' } },
      makeEnv(db)
    );
    expect(status).toBe(200);
    expect(body.event_id).toBeTruthy();
    const content = JSON.parse(latestMessage(db.store)!.content);
    expect(content.msgtype).toBe('m.text');
  });

  it('forwards admin_contact into message content', async () => {
    const db = createNoticeDb();
    const { status } = await post(
      SYNAPSE_PATH,
      noticePayload({
        content: {
          body: 'contact me',
          admin_contact: 'mailto:admin@example.com',
        },
      }),
      makeEnv(db)
    );
    expect(status).toBe(200);
    const content = JSON.parse(latestMessage(db.store)!.content);
    expect(content.admin_contact).toBe('mailto:admin@example.com');
  });

  it('omits admin_contact when not provided', async () => {
    const db = createNoticeDb();
    await post(SYNAPSE_PATH, noticePayload({ content: { body: 'plain' } }), makeEnv(db));
    const content = JSON.parse(latestMessage(db.store)!.content);
    expect(content.admin_contact).toBeUndefined();
  });

  it('accepts m.notice msgtype', async () => {
    const db = createNoticeDb();
    await post(
      SYNAPSE_PATH,
      noticePayload({ content: { body: 'notice type', msgtype: 'm.notice' } }),
      makeEnv(db)
    );
    const content = JSON.parse(latestMessage(db.store)!.content);
    expect(content.msgtype).toBe('m.notice');
  });

  for (let i = 0; i < 20; i++) {
    it(`synapse success soft-${i}`, async () => {
      const db = createNoticeDb();
      const target = `@target${i}:example.com`;
      const { status, body } = await post(
        SYNAPSE_PATH,
        noticePayload({
          user_id: target,
          content: {
            body: `soft body ${i} — café ☕`,
            msgtype: i % 2 === 0 ? 'm.text' : 'm.notice',
            admin_contact: i % 3 === 0 ? `mailto:ops${i}@example.com` : undefined,
          },
        }),
        makeEnv(db)
      );
      expect(status).toBe(200);
      expect(typeof body.event_id).toBe('string');
      const content = JSON.parse(latestMessage(db.store)!.content);
      expect(content.body).toBe(`soft body ${i} — café ☕`);
      if (i % 3 === 0) {
        expect(content.admin_contact).toBe(`mailto:ops${i}@example.com`);
      } else {
        expect(content.admin_contact).toBeUndefined();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Success — Matrix client admin path (no admin_contact forward)
// ---------------------------------------------------------------------------

describe('server-notices leftovers matrix success after #166', () => {
  it('returns event_id without requiring admin_contact field', async () => {
    const db = createNoticeDb();
    const { status, body } = await post(
      MATRIX_PATH,
      noticePayload({ content: { body: 'matrix hello' } }),
      makeEnv(db)
    );
    expect(status).toBe(200);
    expect(body.event_id).toMatch(/^\$evt-\d+:example\.com$/);
  });

  it('defaults msgtype to m.text', async () => {
    const db = createNoticeDb();
    await post(MATRIX_PATH, { user_id: CAROL, content: { body: 'matrix default' } }, makeEnv(db));
    const content = JSON.parse(latestMessage(db.store)!.content);
    expect(content.msgtype).toBe('m.text');
    expect(content.body).toBe('matrix default');
  });

  it('does not forward admin_contact even if present in JSON body', async () => {
    const db = createNoticeDb();
    await post(
      MATRIX_PATH,
      {
        user_id: DAVE,
        content: {
          body: 'should drop contact',
          msgtype: 'm.text',
          admin_contact: 'mailto:should-not-appear@example.com',
        },
      },
      makeEnv(db)
    );
    const content = JSON.parse(latestMessage(db.store)!.content);
    expect(content.body).toBe('should drop contact');
    expect(content.admin_contact).toBeUndefined();
  });

  for (let i = 0; i < 20; i++) {
    it(`matrix success soft-${i}`, async () => {
      const db = createNoticeDb();
      const { status, body } = await post(
        MATRIX_PATH,
        noticePayload({
          user_id: `@mx${i}:example.com`,
          content: {
            body: `mx soft ${i}`,
            msgtype: i % 2 === 0 ? 'm.text' : 'm.notice',
            admin_contact: 'mailto:ignored@example.com',
          },
        }),
        makeEnv(db)
      );
      expect(status).toBe(200);
      expect(body.event_id).toBeTruthy();
      const content = JSON.parse(latestMessage(db.store)!.content);
      expect(content.admin_contact).toBeUndefined();
      expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
    });
  }
});

// ---------------------------------------------------------------------------
// Path fork — Synapse vs Matrix admin_contact behavior
// ---------------------------------------------------------------------------

describe('server-notices leftovers path fork admin_contact after #166', () => {
  for (let i = 0; i < 10; i++) {
    it(`fork soft-${i} synapse keeps contact / matrix drops`, async () => {
      const contact = `mailto:fork${i}@example.com`;
      const payload = noticePayload({
        user_id: `@fork${i}:example.com`,
        content: { body: `fork ${i}`, admin_contact: contact },
      });

      const synDb = createNoticeDb();
      const mxDb = createNoticeDb();
      const [syn, mx] = await Promise.all([
        post(SYNAPSE_PATH, payload, makeEnv(synDb)),
        post(MATRIX_PATH, payload, makeEnv(mxDb)),
      ]);

      expect(syn.status).toBe(200);
      expect(mx.status).toBe(200);
      expect(JSON.parse(latestMessage(synDb.store)!.content).admin_contact).toBe(contact);
      expect(JSON.parse(latestMessage(mxDb.store)!.content).admin_contact).toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------------
// Room reuse / bootstrap side effects via routes
// ---------------------------------------------------------------------------

describe('server-notices leftovers room bootstrap via routes after #166', () => {
  it('synapse creates server user and notice room on first send', async () => {
    const db = createNoticeDb();
    await post(SYNAPSE_PATH, noticePayload({ user_id: BOB }), makeEnv(db));
    expect(db.store.users.has(SERVER_USER)).toBe(true);
    expect(db.store.rooms.size).toBe(1);
    expect(db.store.memberships.some((m) => m.user_id === BOB && m.membership === 'invite')).toBe(
      true
    );
  });

  it('second synapse notice reuses room (depth increases)', async () => {
    const db = createNoticeDb();
    const env = makeEnv(db);
    await post(SYNAPSE_PATH, noticePayload({ content: { body: 'one' } }), env);
    const roomsAfterFirst = db.store.rooms.size;
    const depth1 = latestMessage(db.store)!.depth;
    await post(SYNAPSE_PATH, noticePayload({ content: { body: 'two' } }), env);
    expect(db.store.rooms.size).toBe(roomsAfterFirst);
    expect(latestMessage(db.store)!.depth).toBe(depth1 + 1);
    expect(JSON.parse(latestMessage(db.store)!.content).body).toBe('two');
  });

  it('matrix path also bootstraps notice room', async () => {
    const db = createNoticeDb();
    await post(MATRIX_PATH, noticePayload({ user_id: CAROL }), makeEnv(db));
    expect(db.store.rooms.size).toBe(1);
    expect(db.store.users.get(SERVER_USER)?.display_name).toBe('Server Notices');
  });

  for (let i = 0; i < 8; i++) {
    it(`bootstrap soft-${i} distinct targets get distinct rooms`, async () => {
      const db = createNoticeDb();
      const env = makeEnv(db);
      await post(
        i % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
        noticePayload({ user_id: `@u${i}a:example.com`, content: { body: `a${i}` } }),
        env
      );
      await post(
        i % 2 === 0 ? MATRIX_PATH : SYNAPSE_PATH,
        noticePayload({ user_id: `@u${i}b:example.com`, content: { body: `b${i}` } }),
        env
      );
      expect(db.store.rooms.size).toBe(2);
      expect(db.store.events.filter((e) => e.event_type === 'm.room.message')).toHaveLength(2);
    });
  }
});

// ---------------------------------------------------------------------------
// Reliability / edge soft floods
// ---------------------------------------------------------------------------

describe('server-notices leftovers reliability edges after #166', () => {
  it('empty string admin_contact on synapse is falsy and omitted', async () => {
    const db = createNoticeDb();
    await post(
      SYNAPSE_PATH,
      noticePayload({ content: { body: 'empty contact', admin_contact: '' } }),
      makeEnv(db)
    );
    const content = JSON.parse(latestMessage(db.store)!.content);
    expect(content.admin_contact).toBeUndefined();
  });

  it('unicode body + long admin_contact on synapse', async () => {
    const db = createNoticeDb();
    const body = 'お知らせ — ⚠️ security — ' + 'x'.repeat(200);
    const contact = 'mailto:' + 'a'.repeat(80) + '@example.com';
    await post(
      SYNAPSE_PATH,
      noticePayload({ content: { body, admin_contact: contact, msgtype: 'm.notice' } }),
      makeEnv(db)
    );
    const content = JSON.parse(latestMessage(db.store)!.content);
    expect(content.body).toBe(body);
    expect(content.admin_contact).toBe(contact);
    expect(content.msgtype).toBe('m.notice');
  });

  it('admin check uses authenticated userId not body.user_id', async () => {
    authState.userId = BOB;
    const db = createNoticeDb({
      users: new Map([
        [BOB, adminUser(BOB, 0)],
        [ADMIN, adminUser(ADMIN, 1)],
      ]),
    });
    const { status, body } = await post(
      SYNAPSE_PATH,
      // body claims admin target — caller is still non-admin
      noticePayload({ user_id: ADMIN, content: { body: 'spoof' } }),
      makeEnv(db)
    );
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });

  for (const path of PATHS) {
    for (let i = 0; i < 10; i++) {
      it(`${path} method soft-${i} only POST succeeds shape`, async () => {
        const db = createNoticeDb();
        const { status, body } = await post(
          path,
          noticePayload({ content: { body: `ok-${i}` } }),
          makeEnv(db)
        );
        expect(status).toBe(200);
        expect(body).toHaveProperty('event_id');
        expect(Object.keys(body)).toEqual(['event_id']);
      });
    }
  }

  for (let i = 0; i < 12; i++) {
    it(`parallel path soft-${i} independent DBs`, async () => {
      const synDb = createNoticeDb();
      const mxDb = createNoticeDb();
      const [syn, mx] = await Promise.all([
        post(
          SYNAPSE_PATH,
          noticePayload({
            user_id: `@par-s${i}:example.com`,
            content: { body: `s${i}`, admin_contact: `mailto:s${i}@example.com` },
          }),
          makeEnv(synDb)
        ),
        post(
          MATRIX_PATH,
          noticePayload({
            user_id: `@par-m${i}:example.com`,
            content: { body: `m${i}`, admin_contact: `mailto:m${i}@example.com` },
          }),
          makeEnv(mxDb)
        ),
      ]);
      expect(syn.status).toBe(200);
      expect(mx.status).toBe(200);
      expect(syn.body.event_id).not.toBe(mx.body.event_id);
      expect(JSON.parse(latestMessage(synDb.store)!.content).admin_contact).toBe(
        `mailto:s${i}@example.com`
      );
      expect(JSON.parse(latestMessage(mxDb.store)!.content).admin_contact).toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------------
// Soft flood — mixed denial + success matrix
// ---------------------------------------------------------------------------

describe('server-notices leftovers mixed soft flood after #166', () => {
  const cases: Array<{
    name: string;
    path: string;
    admin: number | 'missing';
    body: unknown;
    expectStatus: number;
    errcode?: string;
  }> = [];

  for (let i = 0; i < 24; i++) {
    const path = i % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH;
    cases.push({
      name: `mixed soft-${i} success`,
      path,
      admin: 1,
      body: noticePayload({
        user_id: `@mix${i}:example.com`,
        content: { body: `mix ${i}`, admin_contact: `mailto:mix${i}@example.com` },
      }),
      expectStatus: 200,
    });
    cases.push({
      name: `mixed soft-${i} forbidden`,
      path,
      admin: i % 3 === 0 ? 'missing' : 0,
      body: noticePayload({ content: { body: `deny ${i}` } }),
      expectStatus: 403,
      errcode: 'M_FORBIDDEN',
    });
    cases.push({
      name: `mixed soft-${i} missing param`,
      path,
      admin: 1,
      body: { user_id: BOB, content: {} },
      expectStatus: 400,
      errcode: 'M_MISSING_PARAM',
    });
  }

  for (const c of cases) {
    it(c.name, async () => {
      if (c.admin === 'missing') {
        authState.userId = '@nobody:example.com';
      } else if (c.admin === 0) {
        authState.userId = '@pleb:example.com';
      } else {
        authState.userId = ADMIN;
      }

      const users = new Map<string, UserRow>();
      if (c.admin === 1) users.set(ADMIN, adminUser(ADMIN, 1));
      if (c.admin === 0) users.set('@pleb:example.com', adminUser('@pleb:example.com', 0));

      const db = createNoticeDb({ users });
      const { status, body } =
        typeof c.body === 'string'
          ? await post(c.path, c.body, makeEnv(db), {
              headers: { 'Content-Type': 'application/json' },
            })
          : await post(c.path, c.body, makeEnv(db));

      expect(status).toBe(c.expectStatus);
      if (c.errcode) {
        expect(body.errcode).toBe(c.errcode);
      } else {
        expect(body.event_id).toMatch(/^\$evt-/);
      }
    });
  }
});
