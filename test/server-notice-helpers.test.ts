/**
 * TOKENMAXX HEAVY deepen of server-notice helpers after #80 (VoIP/RTC).
 * Slice: sendServerNotice (+ getServerNoticeUser / getOrCreateNoticeRoom via side effects).
 * Tests only — no production changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const generateOpaqueId = vi.fn(async (length: number = 18) => `opaque${length}`);
const generateEventId = vi.fn(async (serverName: string) => `$evt-${++eventSeq}:${serverName}`);

let eventSeq = 0;

vi.mock('../src/utils/ids', () => ({
  generateOpaqueId: (...args: unknown[]) => generateOpaqueId(...(args as [number?])),
  generateEventId: (...args: unknown[]) => generateEventId(...(args as [string])),
}));

import { sendServerNotice } from '../src/api/server-notices';

const SERVER = 'matrix.example.com';
const TARGET = '@alice:matrix.example.com';
const SERVER_USER = `@server:${SERVER}`;
const NOTICE_ROOM_TYPE = 'm.server_notice';

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
              // users lookup
              if (sql.includes('SELECT user_id FROM users WHERE user_id')) {
                const [userId] = args as [string];
                const row = store.users.get(userId);
                return (row ? { user_id: row.user_id } : null) as T;
              }

              // existing notice room for target
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

              // latest event by depth
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
              // auth events for notice message
              if (
                sql.includes('FROM room_state rs') &&
                sql.includes("m.room.create") &&
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

              if (sql.includes("INSERT INTO events") && sql.includes("m.room.message")) {
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

function bootstrapEvents(db: NoticeDb, roomId: string) {
  return db.events
    .filter((e) => e.room_id === roomId && e.event_type !== 'm.room.message')
    .sort((a, b) => a.depth - b.depth);
}

function messageEvents(db: NoticeDb, roomId: string) {
  return db.events
    .filter((e) => e.room_id === roomId && e.event_type === 'm.room.message')
    .sort((a, b) => a.depth - b.depth);
}

describe('sendServerNotice TOKENMAXX HEAVY after #80', () => {
  const NOW = 1_700_000_000_000;

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
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // First-send: create server user + notice room + bootstrap DAG + message
  // -------------------------------------------------------------------------

  describe('cold path: create server user, notice room, and first message', () => {
    it('returns a generated event id for the notice message', async () => {
      const db = createNoticeDb();
      const eventId = await sendServerNotice(db, SERVER, TARGET, 'Hello notice');
      expect(eventId).toBe(`$evt-8:${SERVER}`); // 7 bootstrap + 1 message
    });

    it('creates the @server:domain user with fixed display name and flags', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      expect(db.store.users.get(SERVER_USER)).toEqual({
        user_id: SERVER_USER,
        localpart: 'server',
        display_name: 'Server Notices',
        admin: 0,
        is_guest: 0,
        is_deactivated: 0,
      });
    });

    it('does not insert the server user when it already exists', async () => {
      const users = new Map<string, UserRow>([
        [
          SERVER_USER,
          {
            user_id: SERVER_USER,
            localpart: 'server',
            display_name: 'Server Notices',
            admin: 0,
            is_guest: 0,
            is_deactivated: 0,
          },
        ],
      ]);
      const db = createNoticeDb({ users });
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      const insertUserSql = db.store.sqlLog.filter((s) => s.includes('INSERT INTO users'));
      expect(insertUserSql).toHaveLength(0);
      expect(db.store.users.size).toBe(1);
    });

    it('creates a private room_version=10 room with server user as creator at now', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      expect(db.store.rooms.size).toBe(1);
      const room = [...db.store.rooms.values()][0];
      expect(room).toEqual({
        room_id: `!opaque18:${SERVER}`,
        room_version: '10',
        is_public: 0,
        creator_id: SERVER_USER,
        created_at: NOW,
      });
      expect(generateOpaqueId).toHaveBeenCalledWith(18);
    });

    it('bootstraps exactly seven state events before the notice message', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      const roomId = [...db.store.rooms.keys()][0];
      const boot = bootstrapEvents(db.store, roomId);
      expect(boot.map((e) => e.event_type)).toEqual([
        'm.room.create',
        'm.room.name',
        'm.room.join_rules',
        'm.room.history_visibility',
        'm.room.power_levels',
        'm.room.member',
        'm.room.member',
      ]);
      expect(messageEvents(db.store, roomId)).toHaveLength(1);
    });

    it('pins create content: creator, room_version 10, type m.server_notice', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      const roomId = [...db.store.rooms.keys()][0];
      const create = bootstrapEvents(db.store, roomId)[0];
      expect(JSON.parse(create.content)).toEqual({
        creator: SERVER_USER,
        room_version: '10',
        type: NOTICE_ROOM_TYPE,
      });
      expect(create.state_key).toBe('');
      expect(create.sender).toBe(SERVER_USER);
    });

    it('pins name / join_rules / history_visibility contents', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      const roomId = [...db.store.rooms.keys()][0];
      const boot = bootstrapEvents(db.store, roomId);
      expect(JSON.parse(boot[1].content)).toEqual({ name: 'Server Notices' });
      expect(JSON.parse(boot[2].content)).toEqual({ join_rule: 'invite' });
      expect(JSON.parse(boot[3].content)).toEqual({ history_visibility: 'joined' });
    });

    it('pins power_levels with server user at 100 and invite:0', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      const roomId = [...db.store.rooms.keys()][0];
      const pl = JSON.parse(bootstrapEvents(db.store, roomId)[4].content);
      expect(pl).toEqual({
        users: { [SERVER_USER]: 100 },
        users_default: 0,
        events_default: 50,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0,
      });
    });

    it('joins the server user and invites the target with correct state keys', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      const roomId = [...db.store.rooms.keys()][0];
      const boot = bootstrapEvents(db.store, roomId);
      expect(boot[5].state_key).toBe(SERVER_USER);
      expect(JSON.parse(boot[5].content)).toEqual({
        membership: 'join',
        displayname: 'Server Notices',
      });
      expect(boot[6].state_key).toBe(TARGET);
      expect(JSON.parse(boot[6].content)).toEqual({ membership: 'invite' });
    });

    it('builds a linear prev_events DAG with depths 1..7 and origin_server_ts = now+depth', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      const roomId = [...db.store.rooms.keys()][0];
      const boot = bootstrapEvents(db.store, roomId);
      expect(boot.map((e) => e.depth)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(boot.map((e) => e.origin_server_ts)).toEqual([
        NOW + 1,
        NOW + 2,
        NOW + 3,
        NOW + 4,
        NOW + 5,
        NOW + 6,
        NOW + 7,
      ]);
      expect(JSON.parse(boot[0].prev_events)).toEqual([]);
      for (let i = 1; i < boot.length; i++) {
        expect(JSON.parse(boot[i].prev_events)).toEqual([boot[i - 1].event_id]);
      }
    });

    it('accumulates auth_events only for create / power_levels / join_rules', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      const roomId = [...db.store.rooms.keys()][0];
      const boot = bootstrapEvents(db.store, roomId);
      // create: empty auth
      expect(JSON.parse(boot[0].auth_events)).toEqual([]);
      // name: create already pushed after create insert → auth=[create]
      expect(JSON.parse(boot[1].auth_events)).toEqual([boot[0].event_id]);
      // join_rules: still only create (join_rules not yet pushed)
      expect(JSON.parse(boot[2].auth_events)).toEqual([boot[0].event_id]);
      // history: create + join_rules
      expect(JSON.parse(boot[3].auth_events)).toEqual([boot[0].event_id, boot[2].event_id]);
      // power_levels: create + join_rules
      expect(JSON.parse(boot[4].auth_events)).toEqual([boot[0].event_id, boot[2].event_id]);
      // server member: create + join_rules + power_levels
      expect(JSON.parse(boot[5].auth_events)).toEqual([
        boot[0].event_id,
        boot[2].event_id,
        boot[4].event_id,
      ]);
      // target invite: same triple
      expect(JSON.parse(boot[6].auth_events)).toEqual([
        boot[0].event_id,
        boot[2].event_id,
        boot[4].event_id,
      ]);
    });

    it('writes room_state for each bootstrap event keyed by type+state_key', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      const roomId = [...db.store.rooms.keys()][0];
      const boot = bootstrapEvents(db.store, roomId);
      expect(db.store.roomState).toEqual([
        { room_id: roomId, event_type: 'm.room.create', state_key: '', event_id: boot[0].event_id },
        { room_id: roomId, event_type: 'm.room.name', state_key: '', event_id: boot[1].event_id },
        {
          room_id: roomId,
          event_type: 'm.room.join_rules',
          state_key: '',
          event_id: boot[2].event_id,
        },
        {
          room_id: roomId,
          event_type: 'm.room.history_visibility',
          state_key: '',
          event_id: boot[3].event_id,
        },
        {
          room_id: roomId,
          event_type: 'm.room.power_levels',
          state_key: '',
          event_id: boot[4].event_id,
        },
        {
          room_id: roomId,
          event_type: 'm.room.member',
          state_key: SERVER_USER,
          event_id: boot[5].event_id,
        },
        {
          room_id: roomId,
          event_type: 'm.room.member',
          state_key: TARGET,
          event_id: boot[6].event_id,
        },
      ]);
    });

    it('creates join+invite memberships both pointing at the last bootstrap event id', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      const roomId = [...db.store.rooms.keys()][0];
      const lastBootId = bootstrapEvents(db.store, roomId)[6].event_id;
      expect(db.store.memberships).toEqual([
        {
          room_id: roomId,
          user_id: SERVER_USER,
          membership: 'join',
          event_id: lastBootId,
          display_name: 'Server Notices',
        },
        {
          room_id: roomId,
          user_id: TARGET,
          membership: 'invite',
          event_id: lastBootId,
        },
      ]);
    });

    it('sends the notice as m.room.message with default msgtype m.text and usage_limit type', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'Quota exceeded');
      const roomId = [...db.store.rooms.keys()][0];
      const [msg] = messageEvents(db.store, roomId);
      expect(msg.sender).toBe(SERVER_USER);
      expect(msg.state_key).toBeNull();
      expect(msg.depth).toBe(8);
      expect(msg.origin_server_ts).toBe(NOW);
      expect(JSON.parse(msg.content)).toEqual({
        msgtype: 'm.text',
        body: 'Quota exceeded',
        'm.server_notice_type': 'm.server_notice.usage_limit_reached',
      });
      expect(JSON.parse(msg.prev_events)).toEqual([bootstrapEvents(db.store, roomId)[6].event_id]);
    });

    it('includes create + power_levels + server member in message auth_events', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      const roomId = [...db.store.rooms.keys()][0];
      const boot = bootstrapEvents(db.store, roomId);
      const [msg] = messageEvents(db.store, roomId);
      // Auth query includes create, PL (state_key ''), and server member (state_key = server user).
      // Target invite member has state_key = TARGET so it is excluded.
      expect(JSON.parse(msg.auth_events)).toEqual([
        boot[0].event_id,
        boot[4].event_id,
        boot[5].event_id,
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Message content variants
  // -------------------------------------------------------------------------

  describe('message content edges', () => {
    it('honors a custom msgtype', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'See image', 'm.notice');
      const roomId = [...db.store.rooms.keys()][0];
      expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.notice');
    });

    it('omits admin_contact when undefined', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi', 'm.text', undefined);
      const content = JSON.parse(messageEvents(db.store, [...db.store.rooms.keys()][0])[0].content);
      expect(content).not.toHaveProperty('admin_contact');
    });

    it('includes admin_contact when provided (including empty string)', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi', 'm.text', 'mailto:admin@example.com');
      const content = JSON.parse(messageEvents(db.store, [...db.store.rooms.keys()][0])[0].content);
      expect(content.admin_contact).toBe('mailto:admin@example.com');
    });

    it('includes empty-string admin_contact because the guard is truthy on presence', async () => {
      // `if (adminContact)` — empty string is falsy and is omitted
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi', 'm.text', '');
      const content = JSON.parse(messageEvents(db.store, [...db.store.rooms.keys()][0])[0].content);
      expect(content).not.toHaveProperty('admin_contact');
    });

    it('always stamps m.server_notice_type regardless of msgtype', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'x', 'm.emote');
      const content = JSON.parse(messageEvents(db.store, [...db.store.rooms.keys()][0])[0].content);
      expect(content['m.server_notice_type']).toBe('m.server_notice.usage_limit_reached');
    });

    it('preserves unicode / whitespace / JSON-metacharacters in body', async () => {
      const bodies = [
        '  spaced  ',
        'こんにちは',
        'line\nbreak\ttab',
        '{"inject":true}',
        'quote"and\\slash',
        '',
      ];
      for (const body of bodies) {
        eventSeq = 0;
        const db = createNoticeDb();
        await sendServerNotice(db, SERVER, TARGET, body);
        const roomId = [...db.store.rooms.keys()][0];
        expect(JSON.parse(messageEvents(db.store, roomId)[0].content).body).toBe(body);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Warm path: reuse existing notice room
  // -------------------------------------------------------------------------

  describe('warm path: reuse existing notice room', () => {
    function seedExistingNoticeRoom(opts?: {
      roomId?: string;
      latestDepth?: number;
      latestEventId?: string;
      includeServerUser?: boolean;
    }) {
      const roomId = opts?.roomId ?? `!existing:${SERVER}`;
      const createId = '$create-existing';
      const plId = '$pl-existing';
      const memberId = '$member-existing';
      const latestDepth = opts?.latestDepth ?? 7;
      const latestEventId = opts?.latestEventId ?? '$invite-existing';

      const users = new Map<string, UserRow>();
      if (opts?.includeServerUser !== false) {
        users.set(SERVER_USER, {
          user_id: SERVER_USER,
          localpart: 'server',
          display_name: 'Server Notices',
          admin: 0,
          is_guest: 0,
          is_deactivated: 0,
        });
      }

      const events: EventRow[] = [
        {
          event_id: createId,
          room_id: roomId,
          sender: SERVER_USER,
          event_type: 'm.room.create',
          state_key: '',
          content: JSON.stringify({
            creator: SERVER_USER,
            room_version: '10',
            type: NOTICE_ROOM_TYPE,
          }),
          origin_server_ts: NOW - 1000,
          depth: 1,
          auth_events: '[]',
          prev_events: '[]',
        },
        {
          event_id: plId,
          room_id: roomId,
          sender: SERVER_USER,
          event_type: 'm.room.power_levels',
          state_key: '',
          content: '{}',
          origin_server_ts: NOW - 900,
          depth: 5,
          auth_events: '[]',
          prev_events: '[]',
        },
        {
          event_id: memberId,
          room_id: roomId,
          sender: SERVER_USER,
          event_type: 'm.room.member',
          state_key: SERVER_USER,
          content: JSON.stringify({ membership: 'join' }),
          origin_server_ts: NOW - 800,
          depth: 6,
          auth_events: '[]',
          prev_events: '[]',
        },
        {
          event_id: latestEventId,
          room_id: roomId,
          sender: SERVER_USER,
          event_type: 'm.room.member',
          state_key: TARGET,
          content: JSON.stringify({ membership: 'invite' }),
          origin_server_ts: NOW - 700,
          depth: latestDepth,
          auth_events: '[]',
          prev_events: '[]',
        },
      ];

      return createNoticeDb({
        users,
        rooms: new Map([
          [
            roomId,
            {
              room_id: roomId,
              room_version: '10',
              is_public: 0,
              creator_id: SERVER_USER,
              created_at: NOW - 2000,
            },
          ],
        ]),
        events,
        roomState: [
          { room_id: roomId, event_type: 'm.room.create', state_key: '', event_id: createId },
          { room_id: roomId, event_type: 'm.room.power_levels', state_key: '', event_id: plId },
          {
            room_id: roomId,
            event_type: 'm.room.member',
            state_key: SERVER_USER,
            event_id: memberId,
          },
          {
            room_id: roomId,
            event_type: 'm.room.member',
            state_key: TARGET,
            event_id: latestEventId,
          },
        ],
        memberships: [
          {
            room_id: roomId,
            user_id: SERVER_USER,
            membership: 'join',
            event_id: latestEventId,
            display_name: 'Server Notices',
          },
          {
            room_id: roomId,
            user_id: TARGET,
            membership: 'invite',
            event_id: latestEventId,
          },
        ],
      });
    }

    it('reuses the existing notice room and does not create a new room', async () => {
      const db = seedExistingNoticeRoom();
      await sendServerNotice(db, SERVER, TARGET, 'again');
      expect(db.store.rooms.size).toBe(1);
      expect([...db.store.rooms.keys()][0]).toBe(`!existing:${SERVER}`);
      expect(db.store.sqlLog.some((s) => s.includes('INSERT INTO rooms'))).toBe(false);
      expect(generateOpaqueId).not.toHaveBeenCalled();
    });

    it('appends a message at latest.depth + 1 with prev_events = [latest]', async () => {
      const db = seedExistingNoticeRoom({ latestDepth: 12, latestEventId: '$tip' });
      await sendServerNotice(db, SERVER, TARGET, 'again');
      const msgs = messageEvents(db.store, `!existing:${SERVER}`);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].depth).toBe(13);
      expect(JSON.parse(msgs[0].prev_events)).toEqual(['$tip']);
    });

    it('creates the server user on warm path when missing (room create already done)', async () => {
      const db = seedExistingNoticeRoom({ includeServerUser: false });
      expect(db.store.users.has(SERVER_USER)).toBe(false);
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      expect(db.store.users.has(SERVER_USER)).toBe(true);
      // getOrCreateNoticeRoom short-circuits before getServerNoticeUser;
      // sendServerNotice then calls getServerNoticeUser → insert once.
      expect(db.store.sqlLog.filter((s) => s.includes('INSERT INTO users'))).toHaveLength(1);
    });

    it('second consecutive send after cold create reuses the same room', async () => {
      const db = createNoticeDb();
      const first = await sendServerNotice(db, SERVER, TARGET, 'one');
      const roomId = [...db.store.rooms.keys()][0];
      const second = await sendServerNotice(db, SERVER, TARGET, 'two');
      expect(db.store.rooms.size).toBe(1);
      const msgs = messageEvents(db.store, roomId);
      expect(msgs).toHaveLength(2);
      expect(msgs[0].event_id).toBe(first);
      expect(msgs[1].event_id).toBe(second);
      expect(msgs[1].depth).toBe(9);
      expect(JSON.parse(msgs[1].prev_events)).toEqual([first]);
      expect(JSON.parse(msgs[1].content).body).toBe('two');
    });

    it('ignores non-notice rooms that share the target membership', async () => {
      const decoyRoom = `!decoy:${SERVER}`;
      const noticeRoom = `!notice:${SERVER}`;
      const db = createNoticeDb({
        users: new Map([
          [
            SERVER_USER,
            {
              user_id: SERVER_USER,
              localpart: 'server',
              display_name: 'Server Notices',
              admin: 0,
              is_guest: 0,
              is_deactivated: 0,
            },
          ],
        ]),
        rooms: new Map([
          [
            decoyRoom,
            {
              room_id: decoyRoom,
              room_version: '10',
              is_public: 1,
              creator_id: TARGET,
              created_at: NOW - 5000,
            },
          ],
        ]),
        events: [
          {
            event_id: '$decoy-create',
            room_id: decoyRoom,
            sender: TARGET,
            event_type: 'm.room.create',
            state_key: '',
            content: JSON.stringify({ creator: TARGET, room_version: '10' }), // no m.server_notice
            origin_server_ts: NOW - 5000,
            depth: 1,
            auth_events: '[]',
            prev_events: '[]',
          },
        ],
        roomState: [
          {
            room_id: decoyRoom,
            event_type: 'm.room.create',
            state_key: '',
            event_id: '$decoy-create',
          },
        ],
        memberships: [
          {
            room_id: decoyRoom,
            user_id: TARGET,
            membership: 'join',
            event_id: '$decoy-create',
          },
        ],
      });

      await sendServerNotice(db, SERVER, TARGET, 'fresh');
      expect(db.store.rooms.has(decoyRoom)).toBe(true);
      expect(db.store.rooms.has(`!opaque18:${SERVER}`)).toBe(true);
      expect(db.store.rooms.has(noticeRoom)).toBe(false);
      expect(db.store.rooms.size).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Depth / latest-event edges
  // -------------------------------------------------------------------------

  describe('depth and latest-event edges', () => {
    it('uses depth=1 and empty prev_events when latest query returns null', async () => {
      // Seed a "notice room" membership match but with no events so latest is null.
      // (Artificial: production always has bootstrap events; pins the || 0 branch.)
      const roomId = `!empty:${SERVER}`;
      const db = createNoticeDb({
        users: new Map([
          [
            SERVER_USER,
            {
              user_id: SERVER_USER,
              localpart: 'server',
              display_name: 'Server Notices',
              admin: 0,
              is_guest: 0,
              is_deactivated: 0,
            },
          ],
        ]),
        rooms: new Map([
          [
            roomId,
            {
              room_id: roomId,
              room_version: '10',
              is_public: 0,
              creator_id: SERVER_USER,
              created_at: NOW,
            },
          ],
        ]),
        events: [
          {
            event_id: '$create-only-for-lookup',
            room_id: roomId,
            sender: SERVER_USER,
            event_type: 'm.room.create',
            state_key: '',
            content: JSON.stringify({
              creator: SERVER_USER,
              room_version: '10',
              type: NOTICE_ROOM_TYPE,
            }),
            origin_server_ts: NOW,
            depth: 1,
            auth_events: '[]',
            prev_events: '[]',
          },
        ],
        roomState: [
          {
            room_id: roomId,
            event_type: 'm.room.create',
            state_key: '',
            event_id: '$create-only-for-lookup',
          },
        ],
        memberships: [
          {
            room_id: roomId,
            user_id: TARGET,
            membership: 'invite',
            event_id: '$create-only-for-lookup',
          },
        ],
      });

      // Force latest query to null while keeping notice-room lookup intact.
      const originalPrepare = db.prepare.bind(db);
      (db as any).prepare = (sql: string) => {
        if (
          sql.includes('SELECT event_id, depth FROM events') &&
          sql.includes('ORDER BY depth DESC')
        ) {
          return {
            bind() {
              return {
                async first() {
                  return null;
                },
                async all() {
                  return { results: [] };
                },
                async run() {
                  return { meta: { changes: 0 } };
                },
              };
            },
          };
        }
        return originalPrepare(sql);
      };

      const eventId = await sendServerNotice(db, SERVER, TARGET, 'orphan-depth');
      const msg = db.store.events.find((e) => e.event_id === eventId)!;
      expect(msg.depth).toBe(1); // (null?.depth || 0) + 1
      expect(JSON.parse(msg.prev_events)).toEqual([]);
    });

    it('treats latest.depth === 0 as falsy via || and still yields depth 1', async () => {
      const roomId = `!zero:${SERVER}`;
      const db = createNoticeDb({
        users: new Map([
          [
            SERVER_USER,
            {
              user_id: SERVER_USER,
              localpart: 'server',
              display_name: 'Server Notices',
              admin: 0,
              is_guest: 0,
              is_deactivated: 0,
            },
          ],
        ]),
        rooms: new Map([
          [
            roomId,
            {
              room_id: roomId,
              room_version: '10',
              is_public: 0,
              creator_id: SERVER_USER,
              created_at: NOW,
            },
          ],
        ]),
        events: [
          {
            event_id: '$create-z',
            room_id: roomId,
            sender: SERVER_USER,
            event_type: 'm.room.create',
            state_key: '',
            content: JSON.stringify({
              creator: SERVER_USER,
              room_version: '10',
              type: NOTICE_ROOM_TYPE,
            }),
            origin_server_ts: NOW,
            depth: 0, // pathological
            auth_events: '[]',
            prev_events: '[]',
          },
        ],
        roomState: [
          { room_id: roomId, event_type: 'm.room.create', state_key: '', event_id: '$create-z' },
        ],
        memberships: [
          { room_id: roomId, user_id: TARGET, membership: 'invite', event_id: '$create-z' },
        ],
      });

      const eventId = await sendServerNotice(db, SERVER, TARGET, 'zero-depth');
      const msg = db.store.events.find((e) => e.event_id === eventId)!;
      // latest is found; (0 || 0) + 1 === 1 — and prev_events still uses latest because truthy object
      expect(msg.depth).toBe(1);
      expect(JSON.parse(msg.prev_events)).toEqual(['$create-z']);
    });
  });

  // -------------------------------------------------------------------------
  // Clock pinning
  // -------------------------------------------------------------------------

  describe('clock pinning', () => {
    it('pins room created_at and message origin_server_ts to Date.now()', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'clock');
      const room = [...db.store.rooms.values()][0];
      expect(room.created_at).toBe(NOW);
      const roomId = room.room_id;
      expect(messageEvents(db.store, roomId)[0].origin_server_ts).toBe(NOW);
    });

    it('uses an advanced clock mid-flight for message ts when time moves after bootstrap', async () => {
      const db = createNoticeDb();
      // Advance after room creation begins: bootstrap uses NOW, then we jump before message.
      // sendServerNotice reads Date.now() once at start of message path after room returns.
      // To observe a different message ts, advance during the last generateEventId for the message.
      let calls = 0;
      generateEventId.mockImplementation(async (serverName: string) => {
        calls++;
        if (calls === 8) {
          vi.setSystemTime(NOW + 5_000);
        }
        return `$evt-${calls}:${serverName}`;
      });

      await sendServerNotice(db, SERVER, TARGET, 'later');
      const roomId = [...db.store.rooms.keys()][0];
      const boot = bootstrapEvents(db.store, roomId);
      expect(boot[0].origin_server_ts).toBe(NOW + 1);
      expect(messageEvents(db.store, roomId)[0].origin_server_ts).toBe(NOW + 5_000);
    });

    it('pins bootstrap origin_server_ts relative to the room-create now snapshot', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'x');
      const roomId = [...db.store.rooms.keys()][0];
      const boot = bootstrapEvents(db.store, roomId);
      for (let i = 0; i < boot.length; i++) {
        expect(boot[i].origin_server_ts - (NOW + (i + 1))).toBe(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Multi-user / multi-server isolation
  // -------------------------------------------------------------------------

  describe('isolation across users and servers', () => {
    it('creates a distinct notice room per target user', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, '@a:matrix.example.com', 'for a');
      generateOpaqueId.mockImplementation(async () => 'opaque-b');
      await sendServerNotice(db, SERVER, '@b:matrix.example.com', 'for b');
      expect(db.store.rooms.size).toBe(2);
      const rooms = [...db.store.rooms.keys()];
      expect(rooms).toContain(`!opaque18:${SERVER}`);
      expect(rooms).toContain(`!opaque-b:${SERVER}`);

      const aMemberships = db.store.memberships.filter((m) => m.user_id === '@a:matrix.example.com');
      const bMemberships = db.store.memberships.filter((m) => m.user_id === '@b:matrix.example.com');
      expect(aMemberships).toHaveLength(1);
      expect(bMemberships).toHaveLength(1);
      expect(aMemberships[0].room_id).not.toBe(bMemberships[0].room_id);
    });

    it('scopes the server notice user to the given serverName', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, 'one.example.com', '@u:one.example.com', 'n1');
      await sendServerNotice(db, 'two.example.com', '@u:two.example.com', 'n2');
      expect(db.store.users.has('@server:one.example.com')).toBe(true);
      expect(db.store.users.has('@server:two.example.com')).toBe(true);
      expect(db.store.users.size).toBe(2);
    });

    it('embeds serverName into generated room and event ids', async () => {
      const db = createNoticeDb();
      const eventId = await sendServerNotice(db, 'hs.test', '@u:hs.test', 'x');
      expect([...db.store.rooms.keys()][0]).toBe('!opaque18:hs.test');
      expect(eventId.endsWith(':hs.test')).toBe(true);
      expect(generateEventId).toHaveBeenCalledWith('hs.test');
    });
  });

  // -------------------------------------------------------------------------
  // Auth events query filtering
  // -------------------------------------------------------------------------

  describe('auth event selection for the notice message', () => {
    it('excludes member state for the target user from message auth_events', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      const roomId = [...db.store.rooms.keys()][0];
      const boot = bootstrapEvents(db.store, roomId);
      const auth = JSON.parse(messageEvents(db.store, roomId)[0].auth_events) as string[];
      expect(auth).not.toContain(boot[6].event_id); // target invite
      expect(auth).toContain(boot[5].event_id); // server join
    });

    it('returns empty auth_events when room_state has no matching rows', async () => {
      const roomId = `!noauth:${SERVER}`;
      const db = createNoticeDb({
        users: new Map([
          [
            SERVER_USER,
            {
              user_id: SERVER_USER,
              localpart: 'server',
              display_name: 'Server Notices',
              admin: 0,
              is_guest: 0,
              is_deactivated: 0,
            },
          ],
        ]),
        rooms: new Map([
          [
            roomId,
            {
              room_id: roomId,
              room_version: '10',
              is_public: 0,
              creator_id: SERVER_USER,
              created_at: NOW,
            },
          ],
        ]),
        events: [
          {
            event_id: '$c',
            room_id: roomId,
            sender: SERVER_USER,
            event_type: 'm.room.create',
            state_key: '',
            content: JSON.stringify({
              creator: SERVER_USER,
              room_version: '10',
              type: NOTICE_ROOM_TYPE,
            }),
            origin_server_ts: NOW,
            depth: 3,
            auth_events: '[]',
            prev_events: '[]',
          },
        ],
        roomState: [
          // Only name — does not match auth query event_type filter
          { room_id: roomId, event_type: 'm.room.name', state_key: '', event_id: '$c' },
          // create state required for notice-room detection
          { room_id: roomId, event_type: 'm.room.create', state_key: '', event_id: '$c' },
        ],
        memberships: [
          { room_id: roomId, user_id: TARGET, membership: 'invite', event_id: '$c' },
        ],
      });

      // Override auth all() to return empty while keeping create for room lookup
      const orig = db.prepare.bind(db);
      (db as any).prepare = (sql: string) => {
        if (sql.includes('FROM room_state rs') && sql.includes('m.room.power_levels')) {
          return {
            bind() {
              return {
                async all() {
                  return { results: [] };
                },
                async first() {
                  return null;
                },
                async run() {
                  return { meta: { changes: 0 } };
                },
              };
            },
          };
        }
        return orig(sql);
      };

      const eventId = await sendServerNotice(db, SERVER, TARGET, 'no-auth');
      const msg = db.store.events.find((e) => e.event_id === eventId)!;
      expect(JSON.parse(msg.auth_events)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // SQL / ID generation call contracts
  // -------------------------------------------------------------------------

  describe('call contracts', () => {
    it('calls generateEventId once per bootstrap event plus once for the message', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      expect(generateEventId).toHaveBeenCalledTimes(8);
    });

    it('calls generateOpaqueId only on cold room create', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'one');
      expect(generateOpaqueId).toHaveBeenCalledTimes(1);
      generateOpaqueId.mockClear();
      await sendServerNotice(db, SERVER, TARGET, 'two');
      expect(generateOpaqueId).not.toHaveBeenCalled();
    });

    it('issues the notice-room LIKE lookup against m.server_notice type marker', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      const lookup = db.store.sqlLog.find(
        (s) => s.includes('room_memberships rm') && s.includes('m.server_notice')
      );
      expect(lookup).toBeDefined();
      expect(lookup).toContain('%"type":"m.server_notice"%');
    });

    it('inserts the notice message without a state_key column', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      const msgInsert = db.store.sqlLog.find(
        (s) => s.includes('INSERT INTO events') && s.includes("m.room.message")
      );
      expect(msgInsert).toBeDefined();
      expect(msgInsert).not.toMatch(/state_key/);
    });
  });

  // -------------------------------------------------------------------------
  // Matrix ID / server name matrix
  // -------------------------------------------------------------------------

  describe('server name and mxid matrix', () => {
    const cases: Array<{ server: string; target: string }> = [
      { server: 'a.co', target: '@u:a.co' },
      { server: 'matrix.fuzzywigg.com', target: '@admin:matrix.fuzzywigg.com' },
      { server: 'localhost', target: '@guest:localhost' },
      { server: 'hs:8448', target: '@u:hs:8448' },
    ];

    for (const { server, target } of cases) {
      it(`creates @server:${server} and room !opaque18:${server} for ${target}`, async () => {
        eventSeq = 0;
        const db = createNoticeDb();
        const eventId = await sendServerNotice(db, server, target, 'n');
        expect(db.store.users.has(`@server:${server}`)).toBe(true);
        expect([...db.store.rooms.keys()][0]).toBe(`!opaque18:${server}`);
        expect(eventId).toBe(`$evt-8:${server}`);
        const roomId = [...db.store.rooms.keys()][0];
        expect(JSON.parse(bootstrapEvents(db.store, roomId)[5].content).displayname).toBe(
          'Server Notices'
        );
        expect(bootstrapEvents(db.store, roomId)[6].state_key).toBe(target);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Idempotent-ish multi-notice content snapshots
  // -------------------------------------------------------------------------

  describe('multi-notice content snapshots', () => {
    it('keeps bootstrap events untouched when appending more notices', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'n1');
      const roomId = [...db.store.rooms.keys()][0];
      const bootBefore = bootstrapEvents(db.store, roomId).map((e) => ({ ...e }));
      await sendServerNotice(db, SERVER, TARGET, 'n2', 'm.notice', 'mailto:a@b.c');
      await sendServerNotice(db, SERVER, TARGET, 'n3');
      expect(bootstrapEvents(db.store, roomId)).toEqual(bootBefore);
      const msgs = messageEvents(db.store, roomId);
      expect(msgs.map((m) => JSON.parse(m.content).body)).toEqual(['n1', 'n2', 'n3']);
      expect(JSON.parse(msgs[1].content)).toMatchObject({
        msgtype: 'm.notice',
        admin_contact: 'mailto:a@b.c',
        'm.server_notice_type': 'm.server_notice.usage_limit_reached',
      });
      expect(msgs.map((m) => m.depth)).toEqual([8, 9, 10]);
    });

    it('chains prev_events across three notices', async () => {
      const db = createNoticeDb();
      const ids = [
        await sendServerNotice(db, SERVER, TARGET, 'a'),
        await sendServerNotice(db, SERVER, TARGET, 'b'),
        await sendServerNotice(db, SERVER, TARGET, 'c'),
      ];
      const roomId = [...db.store.rooms.keys()][0];
      const msgs = messageEvents(db.store, roomId);
      const lastBoot = bootstrapEvents(db.store, roomId)[6].event_id;
      expect(JSON.parse(msgs[0].prev_events)).toEqual([lastBoot]);
      expect(JSON.parse(msgs[1].prev_events)).toEqual([ids[0]]);
      expect(JSON.parse(msgs[2].prev_events)).toEqual([ids[1]]);
    });
  });

  // -------------------------------------------------------------------------
  // Power levels / membership content regressions
  // -------------------------------------------------------------------------

  describe('bootstrap content regressions', () => {
    it('does not grant the target user power levels in the PL event', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      const roomId = [...db.store.rooms.keys()][0];
      const pl = JSON.parse(bootstrapEvents(db.store, roomId)[4].content);
      expect(pl.users[TARGET]).toBeUndefined();
      expect(Object.keys(pl.users)).toEqual([SERVER_USER]);
    });

    it('uses invite join_rule so only invited users enter the notice room', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      const roomId = [...db.store.rooms.keys()][0];
      expect(JSON.parse(bootstrapEvents(db.store, roomId)[2].content).join_rule).toBe('invite');
    });

    it('uses joined history_visibility', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      const roomId = [...db.store.rooms.keys()][0];
      expect(JSON.parse(bootstrapEvents(db.store, roomId)[3].content).history_visibility).toBe(
        'joined'
      );
    });

    it('names the room Server Notices', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      const roomId = [...db.store.rooms.keys()][0];
      expect(JSON.parse(bootstrapEvents(db.store, roomId)[1].content).name).toBe('Server Notices');
    });

    it('marks create.type as m.server_notice for client filtering', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      const roomId = [...db.store.rooms.keys()][0];
      expect(JSON.parse(bootstrapEvents(db.store, roomId)[0].content).type).toBe('m.server_notice');
    });
  });

  // -------------------------------------------------------------------------
  // Default parameter behavior
  // -------------------------------------------------------------------------

  describe('default parameters', () => {
    it('defaults msgtype to m.text when omitted', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'only-body');
      const roomId = [...db.store.rooms.keys()][0];
      expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe('m.text');
    });

    it('allows overriding msgtype while leaving adminContact unset', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'body', 'm.notice');
      const content = JSON.parse(messageEvents(db.store, [...db.store.rooms.keys()][0])[0].content);
      expect(content.msgtype).toBe('m.notice');
      expect(content.admin_contact).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Sender / event_type invariants on every persisted event
  // -------------------------------------------------------------------------

  describe('sender and type invariants', () => {
    it('uses the server notice user as sender for every bootstrap and message event', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      const roomId = [...db.store.rooms.keys()][0];
      for (const e of db.store.events.filter((ev) => ev.room_id === roomId)) {
        expect(e.sender).toBe(SERVER_USER);
      }
    });

    it('never writes a state_key on the notice message row', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      const roomId = [...db.store.rooms.keys()][0];
      expect(messageEvents(db.store, roomId)[0].state_key).toBeNull();
    });

    it('serializes auth_events and prev_events as JSON arrays on every bootstrap row', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      const roomId = [...db.store.rooms.keys()][0];
      for (const e of bootstrapEvents(db.store, roomId)) {
        expect(Array.isArray(JSON.parse(e.auth_events))).toBe(true);
        expect(Array.isArray(JSON.parse(e.prev_events))).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // msgtype matrix
  // -------------------------------------------------------------------------

  describe('msgtype matrix', () => {
    for (const msgtype of ['m.text', 'm.notice', 'm.emote', 'm.image', 'org.custom.notice']) {
      it(`persists msgtype=${msgtype}`, async () => {
        eventSeq = 0;
        const db = createNoticeDb();
        await sendServerNotice(db, SERVER, TARGET, 'body', msgtype);
        const roomId = [...db.store.rooms.keys()][0];
        expect(JSON.parse(messageEvents(db.store, roomId)[0].content).msgtype).toBe(msgtype);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Cold path creates server user inside getOrCreateNoticeRoom
  // -------------------------------------------------------------------------

  describe('server user creation timing', () => {
    it('inserts the server user during room create (before the message path lookup)', async () => {
      const db = createNoticeDb();
      const order: string[] = [];
      const orig = db.prepare.bind(db);
      (db as any).prepare = (sql: string) => {
        if (sql.includes('INSERT INTO users')) order.push('insert-user');
        if (sql.includes('INSERT INTO rooms')) order.push('insert-room');
        if (sql.includes("m.room.message")) order.push('insert-message');
        return orig(sql);
      };
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      expect(order.indexOf('insert-user')).toBeLessThan(order.indexOf('insert-room'));
      expect(order.indexOf('insert-room')).toBeLessThan(order.indexOf('insert-message'));
    });

    it('looks up the server user again after room create without a second insert', async () => {
      const db = createNoticeDb();
      await sendServerNotice(db, SERVER, TARGET, 'hi');
      const userSelects = db.store.sqlLog.filter((s) =>
        s.includes('SELECT user_id FROM users WHERE user_id')
      );
      // Once inside getOrCreateNoticeRoom, once in sendServerNotice after room returns.
      expect(userSelects.length).toBeGreaterThanOrEqual(2);
      expect(db.store.sqlLog.filter((s) => s.includes('INSERT INTO users'))).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // LIKE marker sensitivity for notice-room detection
  // -------------------------------------------------------------------------

  describe('notice-room detection marker', () => {
    it('does not reuse a room whose create type is only a prefix of m.server_notice', async () => {
      const roomId = `!almost:${SERVER}`;
      const db = createNoticeDb({
        users: new Map([
          [
            SERVER_USER,
            {
              user_id: SERVER_USER,
              localpart: 'server',
              display_name: 'Server Notices',
              admin: 0,
              is_guest: 0,
              is_deactivated: 0,
            },
          ],
        ]),
        rooms: new Map([
          [
            roomId,
            {
              room_id: roomId,
              room_version: '10',
              is_public: 0,
              creator_id: SERVER_USER,
              created_at: NOW,
            },
          ],
        ]),
        events: [
          {
            event_id: '$almost',
            room_id: roomId,
            sender: SERVER_USER,
            event_type: 'm.room.create',
            state_key: '',
            // `"type":"m.server_notice_extra"` does NOT contain `"type":"m.server_notice"`
            // because the LIKE/includes marker requires the closing quote after notice.
            content: JSON.stringify({
              creator: SERVER_USER,
              room_version: '10',
              type: 'm.server_notice_extra',
            }),
            origin_server_ts: NOW,
            depth: 1,
            auth_events: '[]',
            prev_events: '[]',
          },
        ],
        roomState: [
          { room_id: roomId, event_type: 'm.room.create', state_key: '', event_id: '$almost' },
        ],
        memberships: [
          { room_id: roomId, user_id: TARGET, membership: 'invite', event_id: '$almost' },
        ],
      });

      await sendServerNotice(db, SERVER, TARGET, 'x');
      expect(db.store.rooms.size).toBe(2);
      expect(db.store.rooms.has(`!opaque18:${SERVER}`)).toBe(true);
      expect(messageEvents(db.store, roomId)).toHaveLength(0);
      expect(messageEvents(db.store, `!opaque18:${SERVER}`)).toHaveLength(1);
    });

    it('creates a new room when create content lacks the type marker entirely', async () => {
      const roomId = `!plain:${SERVER}`;
      const db = createNoticeDb({
        users: new Map([
          [
            SERVER_USER,
            {
              user_id: SERVER_USER,
              localpart: 'server',
              display_name: 'Server Notices',
              admin: 0,
              is_guest: 0,
              is_deactivated: 0,
            },
          ],
        ]),
        rooms: new Map([
          [
            roomId,
            {
              room_id: roomId,
              room_version: '10',
              is_public: 0,
              creator_id: SERVER_USER,
              created_at: NOW,
            },
          ],
        ]),
        events: [
          {
            event_id: '$plain',
            room_id: roomId,
            sender: SERVER_USER,
            event_type: 'm.room.create',
            state_key: '',
            content: JSON.stringify({ creator: SERVER_USER, room_version: '10' }),
            origin_server_ts: NOW,
            depth: 1,
            auth_events: '[]',
            prev_events: '[]',
          },
        ],
        roomState: [
          { room_id: roomId, event_type: 'm.room.create', state_key: '', event_id: '$plain' },
        ],
        memberships: [
          { room_id: roomId, user_id: TARGET, membership: 'join', event_id: '$plain' },
        ],
      });

      await sendServerNotice(db, SERVER, TARGET, 'x');
      expect(db.store.rooms.size).toBe(2);
      expect(db.store.rooms.has(`!opaque18:${SERVER}`)).toBe(true);
    });
  });
});
