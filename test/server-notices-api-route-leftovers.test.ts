/**
 * TOKENMAXX HEAVY leftovers after #165/#166 — server-notices API route edges.
 * Complements server-notice-helpers.test.ts (unit deepen of sendServerNotice).
 * Focus: Synapse + Matrix admin POSTs — admin gate, validation, msgtype /
 * admin_contact parity, dual-endpoint response shape, soft floods, concurrent
 * sends, warm-room reuse via HTTP. Tests-only — no product inventing.
 * Fixtures use example.com only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const authState = vi.hoisted(() => ({
  userId: '@admin:example.com' as string | undefined,
  deviceId: 'ADMINDEVICE' as string,
}));

const generateOpaqueId = vi.fn(
  async (length: number = 18) => `opaque${length}-${++opaqueSeq}`
);
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

import serverNoticesApp from '../src/api/server-notices';

const ADMIN = '@admin:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const DAVE = '@dave:example.com';
const SERVER = 'example.com';
const SERVER_USER = `@server:${SERVER}`;
const NOTICE_ROOM_TYPE = 'm.server_notice';
const NOW = 1_700_000_000_000;

const SYNAPSE_PATH = '/_synapse/admin/v1/send_server_notice';
const MATRIX_PATH = '/_matrix/client/v3/admin/send_server_notice';

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
  failAdminSelect?: boolean;
  failInsertMessage?: boolean;
};

function seedUser(userId: string, admin: number): UserRow {
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

function createNoticeDb(seed?: Partial<NoticeDb>): D1Database & { store: NoticeDb } {
  const store: NoticeDb = {
    users: seed?.users ?? new Map([[ADMIN, seedUser(ADMIN, 1)]]),
    rooms: seed?.rooms ?? new Map(),
    events: seed?.events ?? [],
    roomState: seed?.roomState ?? [],
    memberships: seed?.memberships ?? [],
    sqlLog: [],
    failAdminSelect: seed?.failAdminSelect,
    failInsertMessage: seed?.failInsertMessage,
  };

  return {
    store,
    prepare(sql: string) {
      store.sqlLog.push(sql);
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT admin FROM users WHERE user_id = ?')) {
                if (store.failAdminSelect) {
                  throw new Error('admin select failed');
                }
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
                if (store.failInsertMessage) {
                  throw new Error('message insert failed');
                }
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

function envFor(db: NoticeDbHandle, serverName = SERVER): Env {
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: serverName,
  } as unknown as Env;
}

async function request(
  db: NoticeDbHandle,
  path: string,
  init: RequestInit = {},
  serverName = SERVER
): Promise<{ status: number; body: Record<string, unknown> | null; text: string }> {
  const res = await serverNoticesApp.request(`http://localhost${path}`, init, envFor(db, serverName));
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = null;
    }
  }
  return { status: res.status, body, text };
}

function jsonInit(body?: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function noticePayload(
  overrides: {
    user_id?: string;
    body?: string;
    msgtype?: string;
    admin_contact?: string;
    omitContent?: boolean;
    omitBody?: boolean;
    omitUserId?: boolean;
    content?: Record<string, unknown> | null;
  } = {}
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (!overrides.omitUserId) {
    payload.user_id = overrides.user_id ?? BOB;
  }
  if (overrides.omitContent) {
    return payload;
  }
  if (overrides.content === null) {
    payload.content = null;
    return payload;
  }
  if (overrides.content) {
    payload.content = overrides.content;
    return payload;
  }
  const content: Record<string, unknown> = {};
  if (!overrides.omitBody) {
    content.body = overrides.body ?? 'Notice body';
  }
  if (overrides.msgtype !== undefined) {
    content.msgtype = overrides.msgtype;
  }
  if (overrides.admin_contact !== undefined) {
    content.admin_contact = overrides.admin_contact;
  }
  payload.content = content;
  return payload;
}

function messageEvents(db: NoticeDb, roomId?: string) {
  return db.events
    .filter(
      (e) =>
        e.event_type === 'm.room.message' && (roomId === undefined || e.room_id === roomId)
    )
    .sort((a, b) => a.depth - b.depth);
}

function noticeRooms(db: NoticeDb) {
  return [...db.rooms.keys()];
}

beforeEach(() => {
  eventSeq = 0;
  opaqueSeq = 0;
  authState.userId = ADMIN;
  authState.deviceId = 'ADMINDEVICE';
  generateOpaqueId.mockReset();
  generateEventId.mockReset();
  generateOpaqueId.mockImplementation(
    async (length: number = 18) => `opaque${length}-${++opaqueSeq}`
  );
  generateEventId.mockImplementation(
    async (serverName: string) => `$evt-${++eventSeq}:${serverName}`
  );
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Admin gate
// ---------------------------------------------------------------------------

describe.each([
  ['synapse', SYNAPSE_PATH],
  ['matrix', MATRIX_PATH],
] as const)('server-notices leftovers admin gate (%s)', (_label, path) => {
  it('rejects non-admin caller with M_FORBIDDEN', async () => {
    const db = createNoticeDb({
      users: new Map([[ADMIN, seedUser(ADMIN, 0)]]),
    });
    const res = await request(db, path, jsonInit(noticePayload()));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'Admin access required',
    });
    expect(messageEvents(db.store)).toHaveLength(0);
  });

  it('rejects missing caller user row with M_FORBIDDEN', async () => {
    const db = createNoticeDb({ users: new Map() });
    const res = await request(db, path, jsonInit(noticePayload()));
    expect(res.status).toBe(403);
    expect(res.body?.errcode).toBe('M_FORBIDDEN');
    expect(messageEvents(db.store)).toHaveLength(0);
  });

  it('rejects admin flag values other than exactly 1', async () => {
    for (const flag of [2, -1, 10, 100]) {
      eventSeq = 0;
      const db = createNoticeDb({
        users: new Map([[ADMIN, seedUser(ADMIN, flag)]]),
      });
      const res = await request(db, path, jsonInit(noticePayload({ body: `flag-${flag}` })));
      expect(res.status).toBe(403);
      expect(res.body?.errcode).toBe('M_FORBIDDEN');
      expect(messageEvents(db.store)).toHaveLength(0);
    }
  });

  it('allows admin=1 and returns event_id', async () => {
    const db = createNoticeDb();
    const res = await request(db, path, jsonInit(noticePayload({ body: 'ok' })));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ event_id: `$evt-8:${SERVER}` });
    expect(messageEvents(db.store)).toHaveLength(1);
  });

  it('checks admin for the authenticated userId, not the target', async () => {
    authState.userId = BOB;
    const db = createNoticeDb({
      users: new Map([
        [BOB, seedUser(BOB, 0)],
        [ADMIN, seedUser(ADMIN, 1)],
      ]),
    });
    const res = await request(
      db,
      path,
      jsonInit(noticePayload({ user_id: ADMIN, body: 'nope' }))
    );
    expect(res.status).toBe(403);
    expect(messageEvents(db.store)).toHaveLength(0);
  });

  it('admin gate soft-flood for non-admin callers', async () => {
    for (let i = 0; i < 12; i++) {
      eventSeq = 0;
      const db = createNoticeDb({
        users: new Map([[ADMIN, seedUser(ADMIN, 0)]]),
      });
      const res = await request(db, path, jsonInit(noticePayload({ body: `deny-${i}` })));
      expect(res.status).toBe(403);
      expect(res.body?.errcode).toBe('M_FORBIDDEN');
    }
  });
});

// ---------------------------------------------------------------------------
// Validation / bad JSON
// ---------------------------------------------------------------------------

describe.each([
  ['synapse', SYNAPSE_PATH],
  ['matrix', MATRIX_PATH],
] as const)('server-notices leftovers validation (%s)', (_label, path) => {
  it('rejects malformed JSON with M_BAD_JSON', async () => {
    const db = createNoticeDb();
    const res = await request(db, path, jsonInit('{not-json'));
    expect(res.status).toBe(400);
    expect(res.body?.errcode).toBe('M_BAD_JSON');
    expect(messageEvents(db.store)).toHaveLength(0);
  });

  it('rejects empty object (missing user_id and body)', async () => {
    const db = createNoticeDb();
    const res = await request(db, path, jsonInit({}));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      errcode: 'M_MISSING_PARAM',
      error: 'Missing required parameter: user_id or content.body',
    });
  });

  it('rejects missing user_id', async () => {
    const db = createNoticeDb();
    const res = await request(db, path, jsonInit(noticePayload({ omitUserId: true })));
    expect(res.status).toBe(400);
    expect(res.body?.errcode).toBe('M_MISSING_PARAM');
  });

  it('rejects missing content', async () => {
    const db = createNoticeDb();
    const res = await request(db, path, jsonInit(noticePayload({ omitContent: true })));
    expect(res.status).toBe(400);
    expect(res.body?.errcode).toBe('M_MISSING_PARAM');
  });

  it('rejects null content', async () => {
    const db = createNoticeDb();
    const res = await request(db, path, jsonInit(noticePayload({ content: null })));
    expect(res.status).toBe(400);
    expect(res.body?.errcode).toBe('M_MISSING_PARAM');
  });

  it('rejects missing content.body', async () => {
    const db = createNoticeDb();
    const res = await request(db, path, jsonInit(noticePayload({ omitBody: true })));
    expect(res.status).toBe(400);
    expect(res.body?.errcode).toBe('M_MISSING_PARAM');
  });

  it('rejects empty-string content.body (falsy guard)', async () => {
    const db = createNoticeDb();
    const res = await request(db, path, jsonInit(noticePayload({ body: '' })));
    expect(res.status).toBe(400);
    expect(res.body?.errcode).toBe('M_MISSING_PARAM');
  });

  it('rejects empty-string user_id (falsy guard)', async () => {
    const db = createNoticeDb();
    const res = await request(db, path, jsonInit(noticePayload({ user_id: '' })));
    expect(res.status).toBe(400);
    expect(res.body?.errcode).toBe('M_MISSING_PARAM');
  });

  it.each([
    ['null body', { user_id: BOB, content: { body: null } }],
    ['undefined body via omit', { user_id: BOB, content: { msgtype: 'm.text' } }],
    ['numeric body ignored as truthy? wait number', { user_id: BOB, content: { body: 0 } }],
    ['false body', { user_id: BOB, content: { body: false } }],
  ] as const)('rejects falsy content.body cases: %s', async (_name, payload) => {
    const db = createNoticeDb();
    const res = await request(db, path, jsonInit(payload));
    expect(res.status).toBe(400);
    expect(res.body?.errcode).toBe('M_MISSING_PARAM');
  });

  it('accepts whitespace-only body (truthy string)', async () => {
    const db = createNoticeDb();
    const res = await request(db, path, jsonInit(noticePayload({ body: '   ' })));
    expect(res.status).toBe(200);
    const msgs = messageEvents(db.store);
    expect(msgs).toHaveLength(1);
    expect(JSON.parse(msgs[0].content).body).toBe('   ');
  });

  it('validation soft-flood missing-param variants', async () => {
    const variants = [
      {},
      { user_id: BOB },
      { content: {} },
      { content: { body: '' } },
      { user_id: '', content: { body: 'x' } },
      { user_id: BOB, content: null },
      { user_id: BOB, content: { msgtype: 'm.notice' } },
      { content: { body: 'no-user' } },
    ];
    for (const [i, payload] of variants.entries()) {
      eventSeq = 0;
      const db = createNoticeDb();
      const res = await request(db, path, jsonInit(payload));
      expect(res.status, `variant ${i}`).toBe(400);
      expect(res.body?.errcode).toBe('M_MISSING_PARAM');
    }
  });

  it('rejects truly invalid JSON with M_BAD_JSON', async () => {
    for (const junk of ['{', '{]', '{\"user_id\":', 'not-json', '{user_id:1}', ',{}']) {
      const db = createNoticeDb();
      const res = await request(db, path, jsonInit(junk));
      expect(res.status).toBe(400);
      expect(res.body?.errcode).toBe('M_BAD_JSON');
      expect(messageEvents(db.store)).toHaveLength(0);
    }
  });

  it('parsed non-object JSON does not create notices', async () => {
    for (const junk of ['[]', 'null', '"str"', 'true', '0', 'false']) {
      const db = createNoticeDb();
      const res = await request(db, path, jsonInit(junk));
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(messageEvents(db.store)).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Happy path + content edges
// ---------------------------------------------------------------------------

describe.each([
  ['synapse', SYNAPSE_PATH],
  ['matrix', MATRIX_PATH],
] as const)('server-notices leftovers happy path (%s)', (_label, path) => {
  it('cold path creates server user, notice room, and message', async () => {
    const db = createNoticeDb();
    const res = await request(db, path, jsonInit(noticePayload({ body: 'Quota hit' })));
    expect(res.status).toBe(200);
    expect(typeof res.body?.event_id).toBe('string');
    expect(db.store.users.has(SERVER_USER)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(1);
    const msgs = messageEvents(db.store);
    expect(msgs).toHaveLength(1);
    const content = JSON.parse(msgs[0].content);
    expect(content).toMatchObject({
      msgtype: 'm.text',
      body: 'Quota hit',
      'm.server_notice_type': 'm.server_notice.usage_limit_reached',
    });
    expect(content.admin_contact).toBeUndefined();
  });

  it('defaults msgtype to m.text when omitted', async () => {
    const db = createNoticeDb();
    const res = await request(db, path, jsonInit(noticePayload({ body: 'default-msgtype' })));
    expect(res.status).toBe(200);
    const content = JSON.parse(messageEvents(db.store)[0].content);
    expect(content.msgtype).toBe('m.text');
  });

  it.each(['m.notice', 'm.emote', 'm.image', 'org.example.custom'])(
    'honors custom msgtype %s',
    async (msgtype) => {
      const db = createNoticeDb();
      const res = await request(
        db,
        path,
        jsonInit(noticePayload({ body: `mt-${msgtype}`, msgtype }))
      );
      expect(res.status).toBe(200);
      const content = JSON.parse(messageEvents(db.store)[0].content);
      expect(content.msgtype).toBe(msgtype);
    }
  );

  it('preserves unicode and JSON metacharacters in body', async () => {
    const bodies = [
      'hello 🌍',
      'line1\nline2',
      'quote " and \\ slash',
      '{"nested":true}',
      '日本語お知らせ',
    ];
    for (const body of bodies) {
      eventSeq = 0;
      const db = createNoticeDb();
      const res = await request(db, path, jsonInit(noticePayload({ body })));
      expect(res.status).toBe(200);
      expect(JSON.parse(messageEvents(db.store)[0].content).body).toBe(body);
    }
  });

  it('warm path reuses notice room across consecutive POSTs', async () => {
    const db = createNoticeDb();
    const first = await request(db, path, jsonInit(noticePayload({ body: 'one' })));
    const second = await request(db, path, jsonInit(noticePayload({ body: 'two' })));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body?.event_id).not.toBe(second.body?.event_id);
    expect(noticeRooms(db.store)).toHaveLength(1);
    expect(messageEvents(db.store)).toHaveLength(2);
  });

  it('isolates notice rooms per target user', async () => {
    const db = createNoticeDb();
    const a = await request(db, path, jsonInit(noticePayload({ user_id: BOB, body: 'for-bob' })));
    const b = await request(
      db,
      path,
      jsonInit(noticePayload({ user_id: CAROL, body: 'for-carol' }))
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(noticeRooms(db.store)).toHaveLength(2);
  });

  it('happy-path soft flood distinct bodies', async () => {
    const db = createNoticeDb();
    for (let i = 0; i < 16; i++) {
      const res = await request(db, path, jsonInit(noticePayload({ body: `soft-${i}` })));
      expect(res.status).toBe(200);
      expect(res.body?.event_id).toMatch(/^\$evt-\d+:example\.com$/);
    }
    expect(noticeRooms(db.store)).toHaveLength(1);
    expect(messageEvents(db.store)).toHaveLength(16);
    expect(messageEvents(db.store).map((m) => JSON.parse(m.content).body)).toEqual(
      Array.from({ length: 16 }, (_, i) => `soft-${i}`)
    );
  });

  it('response shape is exactly { event_id }', async () => {
    const db = createNoticeDb();
    const res = await request(db, path, jsonInit(noticePayload({ body: 'shape' })));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body ?? {}).sort()).toEqual(['event_id']);
  });
});

// ---------------------------------------------------------------------------
// Synapse-only admin_contact
// ---------------------------------------------------------------------------

describe('server-notices leftovers synapse admin_contact', () => {
  it('includes admin_contact when provided on synapse path', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit(
        noticePayload({
          body: 'with-contact',
          admin_contact: 'mailto:admin@example.com',
        })
      )
    );
    expect(res.status).toBe(200);
    const content = JSON.parse(messageEvents(db.store)[0].content);
    expect(content.admin_contact).toBe('mailto:admin@example.com');
  });

  it('omits empty-string admin_contact (falsy guard)', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit(noticePayload({ body: 'empty-contact', admin_contact: '' }))
    );
    expect(res.status).toBe(200);
    const content = JSON.parse(messageEvents(db.store)[0].content);
    expect(content).not.toHaveProperty('admin_contact');
  });

  it('omits admin_contact when not provided on synapse path', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit(noticePayload({ body: 'no-contact' }))
    );
    expect(res.status).toBe(200);
    const content = JSON.parse(messageEvents(db.store)[0].content);
    expect(content).not.toHaveProperty('admin_contact');
  });

  it('matrix path ignores admin_contact in request body (not forwarded)', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      MATRIX_PATH,
      jsonInit(
        noticePayload({
          body: 'matrix-contact',
          admin_contact: 'mailto:admin@example.com',
        })
      )
    );
    expect(res.status).toBe(200);
    const content = JSON.parse(messageEvents(db.store)[0].content);
    expect(content).not.toHaveProperty('admin_contact');
    expect(content.body).toBe('matrix-contact');
  });

  it('admin_contact soft flood on synapse', async () => {
    for (let i = 0; i < 10; i++) {
      eventSeq = 0;
      const db = createNoticeDb();
      const contact = `mailto:ops${i}@example.com`;
      const res = await request(
        db,
        SYNAPSE_PATH,
        jsonInit(noticePayload({ body: `c-${i}`, admin_contact: contact }))
      );
      expect(res.status).toBe(200);
      expect(JSON.parse(messageEvents(db.store)[0].content).admin_contact).toBe(contact);
    }
  });
});

// ---------------------------------------------------------------------------
// Dual-endpoint parity
// ---------------------------------------------------------------------------

describe('server-notices leftovers dual-endpoint parity', () => {
  it('both endpoints return matching event_id shape for identical payloads', async () => {
    const dbA = createNoticeDb();
    const dbB = createNoticeDb();
    const payload = noticePayload({ body: 'parity', msgtype: 'm.notice' });
    const a = await request(dbA, SYNAPSE_PATH, jsonInit(payload));
    eventSeq = 0;
    const b = await request(dbB, MATRIX_PATH, jsonInit(payload));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual(b.body);
    expect(JSON.parse(messageEvents(dbA.store)[0].content).msgtype).toBe('m.notice');
    expect(JSON.parse(messageEvents(dbB.store)[0].content).msgtype).toBe('m.notice');
  });

  it('parity soft flood across endpoints', async () => {
    for (let i = 0; i < 8; i++) {
      eventSeq = 0;
      const dbS = createNoticeDb();
      const dbM = createNoticeDb();
      const payload = noticePayload({ body: `parity-${i}` });
      const s = await request(dbS, SYNAPSE_PATH, jsonInit(payload));
      eventSeq = 0;
      const m = await request(dbM, MATRIX_PATH, jsonInit(payload));
      expect(s.body).toEqual(m.body);
      expect(s.status).toBe(200);
      expect(m.status).toBe(200);
    }
  });

  it('wrong method is not handled as success on either path', async () => {
    for (const path of [SYNAPSE_PATH, MATRIX_PATH]) {
      const db = createNoticeDb();
      const res = await request(db, path, {
        method: 'GET',
        headers: { Authorization: 'Bearer test-token' },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(messageEvents(db.store)).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Auth identity + multi-admin
// ---------------------------------------------------------------------------

describe('server-notices leftovers auth identity', () => {
  it('second admin user can send notices', async () => {
    authState.userId = '@ops:example.com';
    const db = createNoticeDb({
      users: new Map([
        [ADMIN, seedUser(ADMIN, 1)],
        ['@ops:example.com', seedUser('@ops:example.com', 1)],
      ]),
    });
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit(noticePayload({ body: 'from-ops' }))
    );
    expect(res.status).toBe(200);
    expect(messageEvents(db.store)).toHaveLength(1);
  });

  it('switching auth mid-suite from admin to non-admin flips to forbidden', async () => {
    const db = createNoticeDb({
      users: new Map([
        [ADMIN, seedUser(ADMIN, 1)],
        [BOB, seedUser(BOB, 0)],
      ]),
    });
    authState.userId = ADMIN;
    const ok = await request(db, MATRIX_PATH, jsonInit(noticePayload({ body: 'admin-ok' })));
    expect(ok.status).toBe(200);
    authState.userId = BOB;
    const deny = await request(db, MATRIX_PATH, jsonInit(noticePayload({ body: 'bob-no' })));
    expect(deny.status).toBe(403);
    expect(messageEvents(db.store)).toHaveLength(1);
  });

  it('auth soft flood alternating admins', async () => {
    const admins = ['@a1:example.com', '@a2:example.com', '@a3:example.com'];
    const users = new Map(admins.map((id) => [id, seedUser(id, 1)]));
    const db = createNoticeDb({ users });
    for (let i = 0; i < 12; i++) {
      authState.userId = admins[i % admins.length];
      const res = await request(
        db,
        i % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
        jsonInit(noticePayload({ user_id: DAVE, body: `alt-${i}` }))
      );
      expect(res.status).toBe(200);
    }
    expect(noticeRooms(db.store)).toHaveLength(1);
    expect(messageEvents(db.store)).toHaveLength(12);
  });
});

// ---------------------------------------------------------------------------
// Concurrent races
// ---------------------------------------------------------------------------

describe('server-notices leftovers concurrent races', () => {
  it('parallel synapse POSTs for same target all succeed (no lock)', async () => {
    const db = createNoticeDb();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(db, SYNAPSE_PATH, jsonInit(noticePayload({ body: `race-${i}` })))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    const ids = results.map((r) => r.body?.event_id);
    expect(new Set(ids).size).toBe(8);
    expect(messageEvents(db.store).length).toBeGreaterThanOrEqual(8);
  });

  it('parallel matrix POSTs for different targets create distinct rooms', async () => {
    const db = createNoticeDb();
    const targets = [BOB, CAROL, DAVE, '@erin:example.com'];
    const results = await Promise.all(
      targets.map((user_id, i) =>
        request(db, MATRIX_PATH, jsonInit(noticePayload({ user_id, body: `t-${i}` })))
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(noticeRooms(db.store)).toHaveLength(targets.length);
  });

  it('mixed synapse∥matrix concurrent soft flood', async () => {
    const db = createNoticeDb();
    const jobs = Array.from({ length: 20 }, (_, i) =>
      request(
        db,
        i % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
        jsonInit(noticePayload({ body: `mix-${i}` }))
      )
    );
    const results = await Promise.all(jobs);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => typeof r.body?.event_id === 'string')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SERVER_NAME / event id binding
// ---------------------------------------------------------------------------

describe('server-notices leftovers server name binding', () => {
  it('event_id and server user use SERVER_NAME from env', async () => {
    const db = createNoticeDb();
    const res = await request(
      db,
      SYNAPSE_PATH,
      jsonInit(noticePayload({ body: 'domain' })),
      'example.com'
    );
    expect(res.status).toBe(200);
    expect(res.body?.event_id).toBe(`$evt-8:example.com`);
    expect(db.store.users.has('@server:example.com')).toBe(true);
  });

  it('server-name soft flood keeps event_id domain stable', async () => {
    for (let i = 0; i < 10; i++) {
      eventSeq = 0;
      const db = createNoticeDb();
      const res = await request(
        db,
        i % 2 === 0 ? SYNAPSE_PATH : MATRIX_PATH,
        jsonInit(noticePayload({ body: `sn-${i}` }))
      );
      expect(String(res.body?.event_id)).toContain(':example.com');
    }
  });
});

// ---------------------------------------------------------------------------
// Endpoint matrix soft floods (HEAVY density)
// ---------------------------------------------------------------------------

describe('server-notices leftovers endpoint soft-flood matrix', () => {
  const bodies = Array.from({ length: 20 }, (_, i) => `matrix-body-${i}`);

  for (const [pathLabel, path] of [
    ['synapse', SYNAPSE_PATH],
    ['matrix', MATRIX_PATH],
  ] as const) {
    for (const [i, body] of bodies.entries()) {
      it(`${pathLabel} soft-${i} body succeeds`, async () => {
        const db = createNoticeDb();
        const res = await request(db, path, jsonInit(noticePayload({ body })));
        expect(res.status).toBe(200);
        expect(res.body?.event_id).toMatch(/^\$evt-\d+:example\.com$/);
        expect(JSON.parse(messageEvents(db.store)[0].content).body).toBe(body);
      });
    }
  }

  it.each([
    ['synapse', SYNAPSE_PATH, 'm.text'],
    ['synapse', SYNAPSE_PATH, 'm.notice'],
    ['synapse', SYNAPSE_PATH, 'm.emote'],
    ['matrix', MATRIX_PATH, 'm.text'],
    ['matrix', MATRIX_PATH, 'm.notice'],
    ['matrix', MATRIX_PATH, 'm.emote'],
  ] as const)('%s msgtype matrix %s', async (_label, path, msgtype) => {
    const db = createNoticeDb();
    const res = await request(
      db,
      path,
      jsonInit(noticePayload({ body: `mt-${msgtype}`, msgtype }))
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(messageEvents(db.store)[0].content).msgtype).toBe(msgtype);
  });

  it.each([
    ['missing user_id', { content: { body: 'x' } }],
    ['missing body', { user_id: BOB, content: {} }],
    ['empty user_id', { user_id: '', content: { body: 'x' } }],
    ['empty body', { user_id: BOB, content: { body: '' } }],
    ['null content', { user_id: BOB, content: null }],
    ['no fields', {}],
  ] as const)('validation matrix %s on both endpoints', async (_name, payload) => {
    for (const path of [SYNAPSE_PATH, MATRIX_PATH]) {
      eventSeq = 0;
      const db = createNoticeDb();
      const res = await request(db, path, jsonInit(payload));
      expect(res.status).toBe(400);
      expect(res.body?.errcode).toBe('M_MISSING_PARAM');
    }
  });

  it.each([0, 2, 3, 5, 9, 99, -1] as const)(
    'admin flag=%s forbidden on both endpoints',
    async (flag) => {
      for (const path of [SYNAPSE_PATH, MATRIX_PATH]) {
        eventSeq = 0;
        const db = createNoticeDb({
          users: new Map([[ADMIN, seedUser(ADMIN, flag)]]),
        });
        const res = await request(db, path, jsonInit(noticePayload({ body: `af-${flag}` })));
        expect(res.status).toBe(403);
        expect(res.body?.errcode).toBe('M_FORBIDDEN');
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Target user soft flood
// ---------------------------------------------------------------------------

describe('server-notices leftovers target soft flood', () => {
  it('sends to many distinct local targets via synapse', async () => {
    const db = createNoticeDb();
    for (let i = 0; i < 15; i++) {
      const user_id = `@user${i}:example.com`;
      const res = await request(
        db,
        SYNAPSE_PATH,
        jsonInit(noticePayload({ user_id, body: `to-${i}` }))
      );
      expect(res.status).toBe(200);
    }
    expect(noticeRooms(db.store)).toHaveLength(15);
    expect(messageEvents(db.store)).toHaveLength(15);
  });

  it('re-targets same user after other users without mixing rooms', async () => {
    const db = createNoticeDb();
    await request(db, MATRIX_PATH, jsonInit(noticePayload({ user_id: BOB, body: 'b1' })));
    await request(db, MATRIX_PATH, jsonInit(noticePayload({ user_id: CAROL, body: 'c1' })));
    await request(db, MATRIX_PATH, jsonInit(noticePayload({ user_id: BOB, body: 'b2' })));
    expect(noticeRooms(db.store)).toHaveLength(2);
    const bobRooms = db.store.memberships
      .filter((m) => m.user_id === BOB)
      .map((m) => m.room_id);
    expect(new Set(bobRooms).size).toBe(1);
    expect(messageEvents(db.store, bobRooms[0])).toHaveLength(2);
  });
});
