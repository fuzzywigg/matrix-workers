import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createUser,
  getUserById,
  getUserByLocalpart,
  getPasswordHash,
  updateUserProfile,
  createDevice,
  getDevice,
  getUserDevices,
  deleteDevice,
  createAccessToken,
  getUserByTokenHash,
  deleteAccessToken,
  deleteAllUserTokens,
  createRoom,
  getRoom,
  storeEvent,
  storeEventIdempotent,
  getEvent,
  getRoomEvents,
  getRoomState,
  getStateEvent,
  updateMembership,
  tryInsertJoinMembership,
  getMembership,
  getUserRooms,
  getRoomMembers,
  createRoomAlias,
  getRoomByAlias,
  deleteRoomAlias,
  getLatestStreamPosition,
  getEventsSince,
  getEventsByIds,
  validateEventSize,
} from '../src/services/database';
import { MatrixApiError } from '../src/utils/errors';
import type { PDU } from '../src/types';

const NOW = 1_700_000_000_000;
const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const ROOM = '!r:example.com';

type UserRow = {
  user_id: string;
  localpart: string;
  password_hash: string | null;
  display_name: string | null;
  avatar_url: string | null;
  is_guest: number;
  is_deactivated: number;
  admin: number;
  created_at: number;
  updated_at: number;
};

type DeviceRow = {
  user_id: string;
  device_id: string;
  display_name: string | null;
  last_seen_ts: number | null;
  last_seen_ip: string | null;
  created_at: number;
};

type TokenRow = {
  token_id: string;
  token_hash: string;
  user_id: string;
  device_id: string | null;
  created_at: number;
};

type RoomRow = {
  room_id: string;
  room_version: string;
  creator_id: string | null;
  is_public: number;
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
  unsigned: string | null;
  depth: number;
  auth_events: string;
  prev_events: string;
  hashes: string | null;
  signatures: string | null;
  stream_ordering: number;
};

type MembershipRow = {
  room_id: string;
  user_id: string;
  membership: string;
  event_id: string;
  display_name: string | null;
  avatar_url: string | null;
};

type AliasRow = {
  alias: string;
  room_id: string;
  creator_id: string;
  created_at: number;
};

type StateKey = `${string}\0${string}\0${string}`;

function pdu(partial: Partial<PDU> & Pick<PDU, 'event_id' | 'type'>): PDU {
  return {
    room_id: ROOM,
    sender: USER,
    content: {},
    origin_server_ts: NOW,
    auth_events: [],
    prev_events: [],
    depth: 1,
    hashes: { sha256: 'h' },
    signatures: { 'example.com': { 'ed25519:1': 'sig' } },
    ...partial,
  };
}

function eventRowFromPdu(event: PDU, streamOrdering: number): EventRow {
  return {
    event_id: event.event_id,
    room_id: event.room_id,
    sender: event.sender,
    event_type: event.type,
    state_key: event.state_key ?? null,
    content: JSON.stringify(event.content),
    origin_server_ts: event.origin_server_ts,
    unsigned: event.unsigned ? JSON.stringify(event.unsigned) : null,
    depth: event.depth,
    auth_events: JSON.stringify(event.auth_events),
    prev_events: JSON.stringify(event.prev_events),
    hashes: event.hashes ? JSON.stringify(event.hashes) : null,
    signatures: event.signatures ? JSON.stringify(event.signatures) : null,
    stream_ordering: streamOrdering,
  };
}

/** In-memory D1 stand-in covering database.ts CRUD SQL shapes. */
function createCrudDb(seed: {
  users?: UserRow[];
  devices?: DeviceRow[];
  tokens?: TokenRow[];
  rooms?: RoomRow[];
  events?: EventRow[];
  memberships?: MembershipRow[];
  aliases?: AliasRow[];
  roomState?: Array<{ room_id: string; event_type: string; state_key: string; event_id: string }>;
  streamPosition?: number;
} = {}) {
  const users = [...(seed.users ?? [])];
  const devices = [...(seed.devices ?? [])];
  const tokens = [...(seed.tokens ?? [])];
  const rooms = [...(seed.rooms ?? [])];
  const events = [...(seed.events ?? [])];
  const memberships = [...(seed.memberships ?? [])];
  const aliases = [...(seed.aliases ?? [])];
  const roomState = new Map<StateKey, string>();
  for (const s of seed.roomState ?? []) {
    roomState.set(`${s.room_id}\0${s.event_type}\0${s.state_key}`, s.event_id);
  }
  let streamPosition = seed.streamPosition ?? 0;

  const prepares: string[] = [];
  const binds: unknown[][] = [];
  const runs: Array<{ sql: string; args: unknown[] }> = [];

  function stmt(sql: string, args: unknown[] = []) {
    return {
      bind(...bindArgs: unknown[]) {
        binds.push(bindArgs);
        return stmt(sql, bindArgs);
      },
      async first<T>() {
        // stream_positions UPDATE...RETURNING
        if (sql.includes('UPDATE stream_positions') && sql.includes('RETURNING position')) {
          streamPosition += 1;
          return { position: streamPosition } as T;
        }

        if (sql.includes('FROM users WHERE user_id = ?') && sql.includes('password_hash')) {
          const user = users.find((u) => u.user_id === args[0]);
          return (user ? { password_hash: user.password_hash } : null) as T;
        }

        if (sql.includes('FROM users WHERE user_id = ?')) {
          const user = users.find((u) => u.user_id === args[0]);
          return (user ?? null) as T;
        }

        if (sql.includes('FROM users WHERE localpart = ?')) {
          const user = users.find((u) => u.localpart === args[0]);
          return (user ?? null) as T;
        }

        if (sql.includes('FROM devices WHERE user_id = ? AND device_id = ?')) {
          const device = devices.find(
            (d) => d.user_id === args[0] && d.device_id === args[1]
          );
          return (device ?? null) as T;
        }

        if (sql.includes('FROM access_tokens WHERE token_hash = ?')) {
          const token = tokens.find((t) => t.token_hash === args[0]);
          return (token
            ? { user_id: token.user_id, device_id: token.device_id }
            : null) as T;
        }

        if (sql.includes('FROM rooms WHERE room_id = ?')) {
          const room = rooms.find((r) => r.room_id === args[0]);
          return (room ?? null) as T;
        }

        if (
          sql.includes('FROM events WHERE event_id = ?') &&
          !sql.includes('JOIN') &&
          !sql.includes('IN (')
        ) {
          const event = events.find((e) => e.event_id === args[0]);
          return (event ?? null) as T;
        }

        if (
          sql.includes('FROM room_state rs') &&
          sql.includes('JOIN events e') &&
          sql.includes('rs.event_type = ?')
        ) {
          const [roomId, eventType, stateKey] = args as [string, string, string];
          const key = `${roomId}\0${eventType}\0${stateKey}` as StateKey;
          const eventId = roomState.get(key);
          if (!eventId) return null as T;
          const event = events.find((e) => e.event_id === eventId);
          return (event ?? null) as T;
        }

        if (sql.includes('FROM room_memberships WHERE room_id = ? AND user_id = ?')) {
          const m = memberships.find(
            (row) => row.room_id === args[0] && row.user_id === args[1]
          );
          return (m
            ? { membership: m.membership, event_id: m.event_id }
            : null) as T;
        }

        if (sql.includes('FROM room_aliases WHERE alias = ?')) {
          const alias = aliases.find((a) => a.alias === args[0]);
          return (alias ? { room_id: alias.room_id } : null) as T;
        }

        if (sql.includes('MAX(stream_ordering)')) {
          const max = events.reduce(
            (acc, e) => Math.max(acc, e.stream_ordering),
            -Infinity
          );
          return {
            max_ordering: events.length === 0 ? null : max === -Infinity ? null : max,
          } as T;
        }

        if (sql.includes('INSERT INTO room_memberships') && sql.includes('RETURNING event_id')) {
          const [roomId, userId, eventId, displayName, avatarUrl] = args as [
            string,
            string,
            string,
            string | null,
            string | null,
          ];
          const existing = memberships.find(
            (m) => m.room_id === roomId && m.user_id === userId
          );
          if (existing?.membership === 'join') {
            return { event_id: existing.event_id } as T;
          }
          if (existing) {
            existing.membership = 'join';
            existing.event_id = eventId;
            existing.display_name = displayName;
            existing.avatar_url = avatarUrl;
            return { event_id: eventId } as T;
          }
          memberships.push({
            room_id: roomId,
            user_id: userId,
            membership: 'join',
            event_id: eventId,
            display_name: displayName,
            avatar_url: avatarUrl,
          });
          return { event_id: eventId } as T;
        }

        return null as T;
      },
      async all<T>() {
        if (sql.includes('FROM devices WHERE user_id = ?')) {
          return {
            results: devices.filter((d) => d.user_id === args[0]) as T[],
          };
        }

        if (sql.includes('FROM room_memberships WHERE user_id = ?')) {
          let rows = memberships.filter((m) => m.user_id === args[0]);
          if (sql.includes('AND membership = ?')) {
            rows = rows.filter((m) => m.membership === args[1]);
          }
          return { results: rows.map((m) => ({ room_id: m.room_id })) as T[] };
        }

        if (
          sql.includes('FROM room_memberships WHERE room_id = ?') &&
          sql.includes('user_id, membership')
        ) {
          let rows = memberships.filter((m) => m.room_id === args[0]);
          if (sql.includes('AND membership = ?')) {
            rows = rows.filter((m) => m.membership === args[1]);
          }
          return {
            results: rows.map((m) => ({
              user_id: m.user_id,
              membership: m.membership,
              display_name: m.display_name,
              avatar_url: m.avatar_url,
            })) as T[],
          };
        }

        if (sql.includes('FROM room_state rs') && sql.includes('JOIN events e')) {
          const roomId = args[0] as string;
          const results: EventRow[] = [];
          for (const [key, eventId] of roomState) {
            const [rid] = key.split('\0');
            if (rid !== roomId) continue;
            const event = events.find((e) => e.event_id === eventId);
            if (event) results.push(event);
          }
          return { results: results as T[] };
        }

        if (sql.includes('FROM events') && sql.includes('IN (')) {
          const ids = args as string[];
          return {
            results: events.filter((e) => ids.includes(e.event_id)) as T[],
          };
        }

        // getRoomEvents (single-line) and getEventsSince (multi-line) both filter by room_id
        if (sql.includes('FROM events') && sql.includes('room_id = ?')) {
          const roomId = args[0] as string;
          let rows = events.filter((e) => e.room_id === roomId);

          if (sql.includes('stream_ordering < ?')) {
            const fromToken = args[1] as number;
            const limit = args[2] as number;
            rows = rows
              .filter((e) => e.stream_ordering < fromToken)
              .sort((a, b) => b.stream_ordering - a.stream_ordering)
              .slice(0, limit);
          } else if (
            sql.includes('stream_ordering > ?') &&
            sql.includes('ORDER BY stream_ordering ASC')
          ) {
            const sinceOrFrom = args[1] as number;
            const limit = args[2] as number;
            rows = rows
              .filter((e) => e.stream_ordering > sinceOrFrom)
              .sort((a, b) => a.stream_ordering - b.stream_ordering)
              .slice(0, limit);
          } else if (sql.includes('ORDER BY stream_ordering DESC')) {
            const limit = args[1] as number;
            rows = rows
              .sort((a, b) => b.stream_ordering - a.stream_ordering)
              .slice(0, limit);
          } else if (sql.includes('ORDER BY stream_ordering ASC')) {
            const limit = args[1] as number;
            rows = rows
              .sort((a, b) => a.stream_ordering - b.stream_ordering)
              .slice(0, limit);
          }

          return { results: rows as T[] };
        }

        return { results: [] };
      },
      async run() {
        runs.push({ sql, args });

        if (sql.includes('INSERT INTO users')) {
          const [userId, localpart, passwordHash, isGuest, createdAt, updatedAt] =
            args as [string, string, string | null, number, number, number];
          users.push({
            user_id: userId,
            localpart,
            password_hash: passwordHash,
            display_name: null,
            avatar_url: null,
            is_guest: isGuest,
            is_deactivated: 0,
            admin: 0,
            created_at: createdAt,
            updated_at: updatedAt,
          });
          return { meta: { changes: 1 } };
        }

        if (sql.includes('UPDATE users SET display_name')) {
          const [displayName, updatedAt, userId] = args as [string, number, string];
          const user = users.find((u) => u.user_id === userId);
          if (user) {
            user.display_name = displayName;
            user.updated_at = updatedAt;
          }
          return { meta: { changes: user ? 1 : 0 } };
        }

        if (sql.includes('UPDATE users SET avatar_url')) {
          const [avatarUrl, updatedAt, userId] = args as [string, number, string];
          const user = users.find((u) => u.user_id === userId);
          if (user) {
            user.avatar_url = avatarUrl;
            user.updated_at = updatedAt;
          }
          return { meta: { changes: user ? 1 : 0 } };
        }

        if (sql.includes('INSERT INTO devices')) {
          const [userId, deviceId, displayName, createdAt] = args as [
            string,
            string,
            string | null,
            number,
          ];
          devices.push({
            user_id: userId,
            device_id: deviceId,
            display_name: displayName,
            last_seen_ts: null,
            last_seen_ip: null,
            created_at: createdAt,
          });
          return { meta: { changes: 1 } };
        }

        if (sql.includes('DELETE FROM devices')) {
          const [userId, deviceId] = args as [string, string];
          const before = devices.length;
          for (let i = devices.length - 1; i >= 0; i--) {
            if (devices[i].user_id === userId && devices[i].device_id === deviceId) {
              devices.splice(i, 1);
            }
          }
          return { meta: { changes: before - devices.length } };
        }

        if (sql.includes('INSERT INTO access_tokens')) {
          const [tokenId, tokenHash, userId, deviceId, createdAt] = args as [
            string,
            string,
            string,
            string | null,
            number,
          ];
          tokens.push({
            token_id: tokenId,
            token_hash: tokenHash,
            user_id: userId,
            device_id: deviceId,
            created_at: createdAt,
          });
          return { meta: { changes: 1 } };
        }

        if (sql.includes('DELETE FROM access_tokens WHERE token_hash')) {
          const before = tokens.length;
          for (let i = tokens.length - 1; i >= 0; i--) {
            if (tokens[i].token_hash === args[0]) tokens.splice(i, 1);
          }
          return { meta: { changes: before - tokens.length } };
        }

        if (sql.includes('DELETE FROM access_tokens WHERE user_id')) {
          const before = tokens.length;
          for (let i = tokens.length - 1; i >= 0; i--) {
            if (tokens[i].user_id === args[0]) tokens.splice(i, 1);
          }
          return { meta: { changes: before - tokens.length } };
        }

        if (sql.includes('INSERT INTO rooms')) {
          const [roomId, roomVersion, creatorId, isPublic, createdAt] = args as [
            string,
            string,
            string,
            number,
            number,
          ];
          rooms.push({
            room_id: roomId,
            room_version: roomVersion,
            creator_id: creatorId,
            is_public: isPublic,
            created_at: createdAt,
          });
          return { meta: { changes: 1 } };
        }

        if (sql.includes('INSERT OR IGNORE INTO events') || sql.includes('INSERT INTO events')) {
          const [
            eventId,
            roomId,
            sender,
            eventType,
            stateKey,
            content,
            originServerTs,
            unsigned,
            depth,
            authEvents,
            prevEvents,
            hashes,
            signatures,
            streamOrdering,
          ] = args as [
            string,
            string,
            string,
            string,
            string | null,
            string,
            number,
            string | null,
            number,
            string,
            string,
            string | null,
            string | null,
            number,
          ];
          const exists = events.some((e) => e.event_id === eventId);
          if (exists && sql.includes('OR IGNORE')) {
            return { meta: { changes: 0 } };
          }
          if (exists) {
            return { meta: { changes: 0 } };
          }
          events.push({
            event_id: eventId,
            room_id: roomId,
            sender,
            event_type: eventType,
            state_key: stateKey,
            content,
            origin_server_ts: originServerTs,
            unsigned,
            depth,
            auth_events: authEvents,
            prev_events: prevEvents,
            hashes,
            signatures,
            stream_ordering: streamOrdering,
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
          roomState.set(`${roomId}\0${eventType}\0${stateKey}`, eventId);
          return { meta: { changes: 1 } };
        }

        if (sql.includes('INSERT OR REPLACE INTO room_memberships')) {
          const [roomId, userId, membership, eventId, displayName, avatarUrl] =
            args as [string, string, string, string, string | null, string | null];
          const existing = memberships.find(
            (m) => m.room_id === roomId && m.user_id === userId
          );
          if (existing) {
            existing.membership = membership;
            existing.event_id = eventId;
            existing.display_name = displayName;
            existing.avatar_url = avatarUrl;
          } else {
            memberships.push({
              room_id: roomId,
              user_id: userId,
              membership,
              event_id: eventId,
              display_name: displayName,
              avatar_url: avatarUrl,
            });
          }
          return { meta: { changes: 1 } };
        }

        if (sql.includes('INSERT INTO room_aliases')) {
          const [alias, roomId, creatorId, createdAt] = args as [
            string,
            string,
            string,
            number,
          ];
          aliases.push({ alias, room_id: roomId, creator_id: creatorId, created_at: createdAt });
          return { meta: { changes: 1 } };
        }

        if (sql.includes('DELETE FROM room_aliases')) {
          const before = aliases.length;
          for (let i = aliases.length - 1; i >= 0; i--) {
            if (aliases[i].alias === args[0]) aliases.splice(i, 1);
          }
          return { meta: { changes: before - aliases.length } };
        }

        return { meta: { changes: 0 } };
      },
    };
  }

  return {
    prepare(sql: string) {
      prepares.push(sql);
      return stmt(sql);
    },
    _state: {
      users,
      devices,
      tokens,
      rooms,
      events,
      memberships,
      aliases,
      roomState,
      get streamPosition() {
        return streamPosition;
      },
      prepares,
      binds,
      runs,
    },
  } as unknown as D1Database & {
    _state: {
      users: UserRow[];
      devices: DeviceRow[];
      tokens: TokenRow[];
      rooms: RoomRow[];
      events: EventRow[];
      memberships: MembershipRow[];
      aliases: AliasRow[];
      roomState: Map<StateKey, string>;
      streamPosition: number;
      prepares: string[];
      binds: unknown[][];
      runs: Array<{ sql: string; args: unknown[] }>;
    };
  };
}

describe('database user helpers', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('createUser inserts guest=0 / non-guest and nullable password', async () => {
    const db = createCrudDb();
    await createUser(db, USER, 'alice', 'hash', false);
    await createUser(db, '@g:example.com', 'g', null, true);

    expect(db._state.users).toHaveLength(2);
    expect(db._state.users[0]).toMatchObject({
      user_id: USER,
      localpart: 'alice',
      password_hash: 'hash',
      is_guest: 0,
      created_at: NOW,
      updated_at: NOW,
    });
    expect(db._state.users[1]).toMatchObject({
      password_hash: null,
      is_guest: 1,
    });
  });

  it('getUserById maps boolean flags and omits null profile fields', async () => {
    const db = createCrudDb({
      users: [
        {
          user_id: USER,
          localpart: 'alice',
          password_hash: 'h',
          display_name: null,
          avatar_url: null,
          is_guest: 0,
          is_deactivated: 1,
          admin: 1,
          created_at: 11,
          updated_at: 11,
        },
      ],
    });
    await expect(getUserById(db, USER)).resolves.toEqual({
      user_id: USER,
      localpart: 'alice',
      display_name: undefined,
      avatar_url: undefined,
      is_guest: false,
      is_deactivated: true,
      admin: true,
      created_at: 11,
    });
    await expect(getUserById(db, '@missing:example.com')).resolves.toBeNull();
  });

  it('getUserById preserves non-null display_name / avatar_url', async () => {
    const db = createCrudDb({
      users: [
        {
          user_id: USER,
          localpart: 'alice',
          password_hash: null,
          display_name: 'Alice',
          avatar_url: 'mxc://a/b',
          is_guest: 1,
          is_deactivated: 0,
          admin: 0,
          created_at: 1,
          updated_at: 1,
        },
      ],
    });
    await expect(getUserById(db, USER)).resolves.toMatchObject({
      display_name: 'Alice',
      avatar_url: 'mxc://a/b',
      is_guest: true,
      is_deactivated: false,
      admin: false,
    });
  });

  it('getUserByLocalpart returns null / mapped user', async () => {
    const db = createCrudDb({
      users: [
        {
          user_id: USER,
          localpart: 'alice',
          password_hash: null,
          display_name: 'A',
          avatar_url: null,
          is_guest: 0,
          is_deactivated: 0,
          admin: 0,
          created_at: 5,
          updated_at: 5,
        },
      ],
    });
    await expect(getUserByLocalpart(db, 'alice')).resolves.toMatchObject({
      user_id: USER,
      localpart: 'alice',
      display_name: 'A',
    });
    await expect(getUserByLocalpart(db, 'nobody')).resolves.toBeNull();
  });

  it('getPasswordHash returns hash, null hash, or missing → null', async () => {
    const db = createCrudDb({
      users: [
        {
          user_id: USER,
          localpart: 'alice',
          password_hash: 'pbkdf2',
          display_name: null,
          avatar_url: null,
          is_guest: 0,
          is_deactivated: 0,
          admin: 0,
          created_at: 1,
          updated_at: 1,
        },
        {
          user_id: BOB,
          localpart: 'bob',
          password_hash: null,
          display_name: null,
          avatar_url: null,
          is_guest: 0,
          is_deactivated: 0,
          admin: 0,
          created_at: 1,
          updated_at: 1,
        },
      ],
    });
    await expect(getPasswordHash(db, USER)).resolves.toBe('pbkdf2');
    await expect(getPasswordHash(db, BOB)).resolves.toBeNull();
    await expect(getPasswordHash(db, '@x:example.com')).resolves.toBeNull();
  });

  it('updateUserProfile updates display_name and/or avatar_url independently', async () => {
    const db = createCrudDb({
      users: [
        {
          user_id: USER,
          localpart: 'alice',
          password_hash: null,
          display_name: 'Old',
          avatar_url: 'mxc://old',
          is_guest: 0,
          is_deactivated: 0,
          admin: 0,
          created_at: 1,
          updated_at: 1,
        },
      ],
    });

    await updateUserProfile(db, USER);
    expect(db._state.users[0].display_name).toBe('Old');
    expect(db._state.users[0].avatar_url).toBe('mxc://old');
    expect(db._state.runs).toHaveLength(0);

    await updateUserProfile(db, USER, 'New');
    expect(db._state.users[0].display_name).toBe('New');
    expect(db._state.users[0].updated_at).toBe(NOW);
    expect(db._state.runs).toHaveLength(1);

    await updateUserProfile(db, USER, undefined, 'mxc://new');
    expect(db._state.users[0].avatar_url).toBe('mxc://new');
    expect(db._state.runs).toHaveLength(2);

    await updateUserProfile(db, USER, 'Both', 'mxc://both');
    expect(db._state.users[0]).toMatchObject({
      display_name: 'Both',
      avatar_url: 'mxc://both',
    });
    expect(db._state.runs).toHaveLength(4);
  });

  it('updateUserProfile allows clearing fields with empty string', async () => {
    const db = createCrudDb({
      users: [
        {
          user_id: USER,
          localpart: 'alice',
          password_hash: null,
          display_name: 'Alice',
          avatar_url: 'mxc://a',
          is_guest: 0,
          is_deactivated: 0,
          admin: 0,
          created_at: 1,
          updated_at: 1,
        },
      ],
    });
    await updateUserProfile(db, USER, '', '');
    expect(db._state.users[0].display_name).toBe('');
    expect(db._state.users[0].avatar_url).toBe('');
  });
});

describe('database device helpers', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('createDevice stores null display_name when omitted', async () => {
    const db = createCrudDb();
    await createDevice(db, USER, 'DEVICE1');
    await createDevice(db, USER, 'DEVICE2', 'Phone');
    expect(db._state.devices).toEqual([
      {
        user_id: USER,
        device_id: 'DEVICE1',
        display_name: null,
        last_seen_ts: null,
        last_seen_ip: null,
        created_at: NOW,
      },
      {
        user_id: USER,
        device_id: 'DEVICE2',
        display_name: 'Phone',
        last_seen_ts: null,
        last_seen_ip: null,
        created_at: NOW,
      },
    ]);
  });

  it('getDevice maps nullables and returns null when missing', async () => {
    const db = createCrudDb({
      devices: [
        {
          user_id: USER,
          device_id: 'D1',
          display_name: null,
          last_seen_ts: null,
          last_seen_ip: null,
          created_at: 9,
        },
        {
          user_id: USER,
          device_id: 'D2',
          display_name: 'Laptop',
          last_seen_ts: 100,
          last_seen_ip: '1.2.3.4',
          created_at: 9,
        },
      ],
    });
    await expect(getDevice(db, USER, 'D1')).resolves.toEqual({
      device_id: 'D1',
      user_id: USER,
      display_name: undefined,
      last_seen_ts: undefined,
      last_seen_ip: undefined,
    });
    await expect(getDevice(db, USER, 'D2')).resolves.toEqual({
      device_id: 'D2',
      user_id: USER,
      display_name: 'Laptop',
      last_seen_ts: 100,
      last_seen_ip: '1.2.3.4',
    });
    await expect(getDevice(db, USER, 'NOPE')).resolves.toBeNull();
    await expect(getDevice(db, BOB, 'D1')).resolves.toBeNull();
  });

  it('getUserDevices returns empty / mapped list without created_at', async () => {
    const db = createCrudDb({
      devices: [
        {
          user_id: USER,
          device_id: 'A',
          display_name: 'a',
          last_seen_ts: 1,
          last_seen_ip: '::1',
          created_at: 1,
        },
        {
          user_id: BOB,
          device_id: 'B',
          display_name: null,
          last_seen_ts: null,
          last_seen_ip: null,
          created_at: 1,
        },
      ],
    });
    await expect(getUserDevices(db, USER)).resolves.toEqual([
      {
        device_id: 'A',
        user_id: USER,
        display_name: 'a',
        last_seen_ts: 1,
        last_seen_ip: '::1',
      },
    ]);
    await expect(getUserDevices(db, '@nobody:example.com')).resolves.toEqual([]);
  });

  it('deleteDevice removes only the matching user+device pair', async () => {
    const db = createCrudDb({
      devices: [
        {
          user_id: USER,
          device_id: 'D1',
          display_name: null,
          last_seen_ts: null,
          last_seen_ip: null,
          created_at: 1,
        },
        {
          user_id: USER,
          device_id: 'D2',
          display_name: null,
          last_seen_ts: null,
          last_seen_ip: null,
          created_at: 1,
        },
        {
          user_id: BOB,
          device_id: 'D1',
          display_name: null,
          last_seen_ts: null,
          last_seen_ip: null,
          created_at: 1,
        },
      ],
    });
    await deleteDevice(db, USER, 'D1');
    expect(db._state.devices.map((d) => `${d.user_id}:${d.device_id}`)).toEqual([
      `${USER}:D2`,
      `${BOB}:D1`,
    ]);
  });
});

describe('database access token helpers', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('createAccessToken stores nullable device_id', async () => {
    const db = createCrudDb();
    await createAccessToken(db, 'tid1', 'hash1', USER, 'DEVICE');
    await createAccessToken(db, 'tid2', 'hash2', USER, null);
    expect(db._state.tokens).toEqual([
      {
        token_id: 'tid1',
        token_hash: 'hash1',
        user_id: USER,
        device_id: 'DEVICE',
        created_at: NOW,
      },
      {
        token_id: 'tid2',
        token_hash: 'hash2',
        user_id: USER,
        device_id: null,
        created_at: NOW,
      },
    ]);
  });

  it('getUserByTokenHash returns user/device or null', async () => {
    const db = createCrudDb({
      tokens: [
        {
          token_id: 't1',
          token_hash: 'abc',
          user_id: USER,
          device_id: 'D',
          created_at: 1,
        },
        {
          token_id: 't2',
          token_hash: 'no-device',
          user_id: BOB,
          device_id: null,
          created_at: 1,
        },
      ],
    });
    await expect(getUserByTokenHash(db, 'abc')).resolves.toEqual({
      userId: USER,
      deviceId: 'D',
    });
    await expect(getUserByTokenHash(db, 'no-device')).resolves.toEqual({
      userId: BOB,
      deviceId: null,
    });
    await expect(getUserByTokenHash(db, 'missing')).resolves.toBeNull();
  });

  it('deleteAccessToken removes by hash only', async () => {
    const db = createCrudDb({
      tokens: [
        {
          token_id: 't1',
          token_hash: 'keep',
          user_id: USER,
          device_id: null,
          created_at: 1,
        },
        {
          token_id: 't2',
          token_hash: 'drop',
          user_id: USER,
          device_id: null,
          created_at: 1,
        },
      ],
    });
    await deleteAccessToken(db, 'drop');
    expect(db._state.tokens.map((t) => t.token_hash)).toEqual(['keep']);
  });

  it('deleteAllUserTokens removes every token for a user', async () => {
    const db = createCrudDb({
      tokens: [
        {
          token_id: 't1',
          token_hash: 'a',
          user_id: USER,
          device_id: '1',
          created_at: 1,
        },
        {
          token_id: 't2',
          token_hash: 'b',
          user_id: USER,
          device_id: '2',
          created_at: 1,
        },
        {
          token_id: 't3',
          token_hash: 'c',
          user_id: BOB,
          device_id: null,
          created_at: 1,
        },
      ],
    });
    await deleteAllUserTokens(db, USER);
    expect(db._state.tokens).toHaveLength(1);
    expect(db._state.tokens[0].user_id).toBe(BOB);
  });
});

describe('database room helpers', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('createRoom defaults isPublic=false and stores is_public 0/1', async () => {
    const db = createCrudDb();
    await createRoom(db, ROOM, '10', USER);
    await createRoom(db, '!pub:example.com', '11', BOB, true);
    expect(db._state.rooms[0]).toMatchObject({
      room_id: ROOM,
      room_version: '10',
      creator_id: USER,
      is_public: 0,
      created_at: NOW,
    });
    expect(db._state.rooms[1].is_public).toBe(1);
  });

  it('getRoom maps is_public and nullable creator', async () => {
    const db = createCrudDb({
      rooms: [
        {
          room_id: ROOM,
          room_version: '10',
          creator_id: null,
          is_public: 0,
          created_at: 3,
        },
        {
          room_id: '!p:example.com',
          room_version: '11',
          creator_id: USER,
          is_public: 1,
          created_at: 4,
        },
      ],
    });
    await expect(getRoom(db, ROOM)).resolves.toEqual({
      room_id: ROOM,
      room_version: '10',
      is_public: false,
      creator_id: undefined,
      created_at: 3,
    });
    await expect(getRoom(db, '!p:example.com')).resolves.toEqual({
      room_id: '!p:example.com',
      room_version: '11',
      is_public: true,
      creator_id: USER,
      created_at: 4,
    });
    await expect(getRoom(db, '!missing:example.com')).resolves.toBeNull();
  });
});

describe('database storeEvent / getEvent', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('storeEvent allocates stream ordering, inserts row, updates room_state for state events', async () => {
    const db = createCrudDb({ streamPosition: 10 });
    const event = pdu({
      event_id: '$s1',
      type: 'm.room.name',
      state_key: '',
      content: { name: 'General' },
    });
    await expect(storeEvent(db, event)).resolves.toBe(11);
    expect(db._state.events).toHaveLength(1);
    expect(db._state.events[0]).toMatchObject({
      event_id: '$s1',
      event_type: 'm.room.name',
      state_key: '',
      stream_ordering: 11,
      content: JSON.stringify({ name: 'General' }),
    });
    expect(db._state.roomState.get(`${ROOM}\0m.room.name\0`)).toBe('$s1');
  });

  it('storeEvent skips room_state when state_key is undefined (message)', async () => {
    const db = createCrudDb({ streamPosition: 0 });
    const event = pdu({
      event_id: '$m1',
      type: 'm.room.message',
      content: { body: 'hi', msgtype: 'm.text' },
    });
    // ensure state_key truly absent
    delete (event as { state_key?: string }).state_key;
    await expect(storeEvent(db, event)).resolves.toBe(1);
    expect(db._state.roomState.size).toBe(0);
    expect(db._state.events[0].state_key).toBeNull();
  });

  it('storeEvent defaults stream ordering to 1 when RETURNING is null', async () => {
    const hybrid = createCrudDb({ streamPosition: 0 });
    const orig = hybrid.prepare.bind(hybrid);
    hybrid.prepare = ((sql: string) => {
      if (sql.includes('UPDATE stream_positions')) {
        return {
          bind() {
            return this;
          },
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        };
      }
      return orig(sql);
    }) as typeof hybrid.prepare;

    const ordering = await storeEvent(
      hybrid,
      pdu({ event_id: '$fallback', type: 'm.room.message', content: { body: 'x' } })
    );
    expect(ordering).toBe(1);
    expect(hybrid._state.events[0].stream_ordering).toBe(1);
  });

  it('storeEvent rejects oversized content via validateEventSize', async () => {
    const db = createCrudDb();
    const event = pdu({
      event_id: '$big',
      type: 'm.room.message',
      content: { body: 'x'.repeat(70_000) },
    });
    expect(() => validateEventSize(event)).toThrow(MatrixApiError);
    await expect(storeEvent(db, event)).rejects.toBeInstanceOf(MatrixApiError);
    expect(db._state.events).toHaveLength(0);
  });

  it('storeEvent serializes unsigned/hashes/signatures and nulls when absent', async () => {
    const db = createCrudDb({ streamPosition: 2 });
    const withExtras = pdu({
      event_id: '$u1',
      type: 'm.room.member',
      state_key: USER,
      content: { membership: 'join' },
      unsigned: { age: 1 },
    });
    await storeEvent(db, withExtras);
    expect(db._state.events[0].unsigned).toBe(JSON.stringify({ age: 1 }));
    expect(db._state.events[0].hashes).toBe(JSON.stringify({ sha256: 'h' }));

    const bare = pdu({
      event_id: '$u2',
      type: 'm.room.message',
      content: { body: 'n' },
    });
    delete (bare as { unsigned?: unknown }).unsigned;
    delete (bare as { hashes?: unknown }).hashes;
    delete (bare as { signatures?: unknown }).signatures;
    await storeEvent(db, bare);
    expect(db._state.events[1].unsigned).toBeNull();
    expect(db._state.events[1].hashes).toBeNull();
    expect(db._state.events[1].signatures).toBeNull();
  });

  it('storeEventIdempotent inserts new events and updates state when inserted', async () => {
    const db = createCrudDb({ streamPosition: 5 });
    const event = pdu({
      event_id: '$idemp1',
      type: 'm.room.topic',
      state_key: '',
      content: { topic: 't' },
    });
    await expect(storeEventIdempotent(db, event)).resolves.toEqual({
      inserted: true,
      streamOrdering: 6,
    });
    expect(db._state.roomState.get(`${ROOM}\0m.room.topic\0`)).toBe('$idemp1');
  });

  it('storeEventIdempotent returns inserted:false without updating state on collision', async () => {
    const existing = eventRowFromPdu(
      pdu({
        event_id: '$dup',
        type: 'm.room.name',
        state_key: '',
        content: { name: 'old' },
      }),
      3
    );
    const db = createCrudDb({
      streamPosition: 3,
      events: [existing],
      roomState: [
        { room_id: ROOM, event_type: 'm.room.name', state_key: '', event_id: '$dup' },
      ],
    });
    const collision = pdu({
      event_id: '$dup',
      type: 'm.room.name',
      state_key: '',
      content: { name: 'new' },
    });
    await expect(storeEventIdempotent(db, collision)).resolves.toEqual({
      inserted: false,
      streamOrdering: null,
    });
    // stream id still allocated
    expect(db._state.streamPosition).toBe(4);
    expect(db._state.events).toHaveLength(1);
    expect(db._state.events[0].content).toBe(JSON.stringify({ name: 'old' }));
    expect(db._state.roomState.get(`${ROOM}\0m.room.name\0`)).toBe('$dup');
  });

  it('storeEventIdempotent skips room_state for non-state events even when inserted', async () => {
    const db = createCrudDb({ streamPosition: 0 });
    const event = pdu({
      event_id: '$msg',
      type: 'm.room.message',
      content: { body: 'x' },
    });
    delete (event as { state_key?: string }).state_key;
    await expect(storeEventIdempotent(db, event)).resolves.toEqual({
      inserted: true,
      streamOrdering: 1,
    });
    expect(db._state.roomState.size).toBe(0);
  });

  it('getEvent returns null / fully parsed PDU including optional fields', async () => {
    const db = createCrudDb({
      events: [
        eventRowFromPdu(
          pdu({
            event_id: '$g1',
            type: 'm.room.member',
            state_key: USER,
            content: { membership: 'join' },
            unsigned: { age: 9 },
          }),
          1
        ),
        {
          event_id: '$g2',
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.message',
          state_key: null,
          content: JSON.stringify({ body: 'hi' }),
          origin_server_ts: NOW,
          unsigned: null,
          depth: 2,
          auth_events: '[]',
          prev_events: '[]',
          hashes: null,
          signatures: null,
          stream_ordering: 2,
        },
      ],
    });
    await expect(getEvent(db, '$missing')).resolves.toBeNull();
    await expect(getEvent(db, '$g1')).resolves.toMatchObject({
      event_id: '$g1',
      type: 'm.room.member',
      state_key: USER,
      content: { membership: 'join' },
      unsigned: { age: 9 },
      hashes: { sha256: 'h' },
    });
    await expect(getEvent(db, '$g2')).resolves.toEqual({
      event_id: '$g2',
      room_id: ROOM,
      sender: USER,
      type: 'm.room.message',
      state_key: undefined,
      content: { body: 'hi' },
      origin_server_ts: NOW,
      unsigned: undefined,
      depth: 2,
      auth_events: [],
      prev_events: [],
      hashes: undefined,
      signatures: undefined,
    });
  });
});

describe('database getRoomEvents / getRoomState / getStateEvent', () => {
  function seededEvents(): EventRow[] {
    return [1, 2, 3, 4, 5].map((n) =>
      eventRowFromPdu(
        pdu({
          event_id: `$${n}`,
          type: 'm.room.message',
          content: { body: String(n) },
          depth: n,
        }),
        n
      )
    );
  }

  it('getRoomEvents backwards without fromToken returns newest-first page', async () => {
    const db = createCrudDb({ events: seededEvents() });
    const { events, end } = await getRoomEvents(db, ROOM, undefined, 2, 'b');
    expect(events.map((e) => e.event_id)).toEqual(['$5', '$4']);
    expect(end).toBe(4);
  });

  it('getRoomEvents backwards with fromToken uses stream_ordering <', async () => {
    const db = createCrudDb({ events: seededEvents() });
    const { events, end } = await getRoomEvents(db, ROOM, 4, 2, 'b');
    expect(events.map((e) => e.event_id)).toEqual(['$3', '$2']);
    expect(end).toBe(2);
    expect(db._state.binds.some((b) => b[0] === ROOM && b[1] === 4 && b[2] === 2)).toBe(
      true
    );
  });

  it('getRoomEvents forwards without/with fromToken', async () => {
    const db = createCrudDb({ events: seededEvents() });
    const first = await getRoomEvents(db, ROOM, undefined, 2, 'f');
    expect(first.events.map((e) => e.event_id)).toEqual(['$1', '$2']);
    expect(first.end).toBe(2);

    const next = await getRoomEvents(db, ROOM, 2, 2, 'f');
    expect(next.events.map((e) => e.event_id)).toEqual(['$3', '$4']);
    expect(next.end).toBe(4);
  });

  it('getRoomEvents end falls back to fromToken then 0 when empty', async () => {
    const db = createCrudDb({ events: [] });
    await expect(getRoomEvents(db, ROOM, 9, 10, 'b')).resolves.toEqual({
      events: [],
      end: 9,
    });
    await expect(getRoomEvents(db, ROOM, undefined, 10, 'f')).resolves.toEqual({
      events: [],
      end: 0,
    });
  });

  it('getRoomEvents defaults limit=50 direction=b and ignores other rooms', async () => {
    const db = createCrudDb({
      events: [
        ...seededEvents(),
        eventRowFromPdu(
          pdu({
            event_id: '$other',
            room_id: '!other:example.com',
            type: 'm.room.message',
            content: { body: 'x' },
          }),
          99
        ),
      ],
    });
    const { events } = await getRoomEvents(db, ROOM);
    expect(events).toHaveLength(5);
    expect(events.every((e) => e.room_id === ROOM)).toBe(true);
  });

  it('getRoomEvents treats fromToken 0 as falsy (no stream filter)', async () => {
    const db = createCrudDb({ events: seededEvents() });
    const { events } = await getRoomEvents(db, ROOM, 0, 2, 'b');
    // fromToken falsy → no `< ?` branch
    expect(events.map((e) => e.event_id)).toEqual(['$5', '$4']);
  });

  it('getRoomState joins current state event ids', async () => {
    const name = pdu({
      event_id: '$name',
      type: 'm.room.name',
      state_key: '',
      content: { name: 'N' },
    });
    const member = pdu({
      event_id: '$mem',
      type: 'm.room.member',
      state_key: USER,
      content: { membership: 'join' },
    });
    const db = createCrudDb({
      events: [eventRowFromPdu(name, 1), eventRowFromPdu(member, 2)],
      roomState: [
        { room_id: ROOM, event_type: 'm.room.name', state_key: '', event_id: '$name' },
        {
          room_id: ROOM,
          event_type: 'm.room.member',
          state_key: USER,
          event_id: '$mem',
        },
      ],
    });
    const state = await getRoomState(db, ROOM);
    expect(state.map((e) => e.event_id).sort()).toEqual(['$mem', '$name']);
    expect(state.find((e) => e.event_id === '$name')?.content).toEqual({ name: 'N' });
  });

  it('getRoomState returns empty for rooms with no state', async () => {
    const db = createCrudDb();
    await expect(getRoomState(db, ROOM)).resolves.toEqual([]);
  });

  it('getStateEvent returns null / parsed event; defaults stateKey to empty', async () => {
    const name = pdu({
      event_id: '$name',
      type: 'm.room.name',
      state_key: '',
      content: { name: 'N' },
      unsigned: { age: 1 },
    });
    const db = createCrudDb({
      events: [eventRowFromPdu(name, 1)],
      roomState: [
        { room_id: ROOM, event_type: 'm.room.name', state_key: '', event_id: '$name' },
      ],
    });
    await expect(getStateEvent(db, ROOM, 'm.room.name')).resolves.toMatchObject({
      event_id: '$name',
      type: 'm.room.name',
      state_key: '',
      content: { name: 'N' },
      unsigned: { age: 1 },
    });
    await expect(getStateEvent(db, ROOM, 'm.room.topic', '')).resolves.toBeNull();
    await expect(getStateEvent(db, ROOM, 'm.room.member', USER)).resolves.toBeNull();
  });
});

describe('database membership helpers', () => {
  it('updateMembership inserts or replaces membership rows', async () => {
    const db = createCrudDb();
    await updateMembership(db, ROOM, USER, 'join', '$e1', 'Alice', 'mxc://a');
    expect(db._state.memberships[0]).toEqual({
      room_id: ROOM,
      user_id: USER,
      membership: 'join',
      event_id: '$e1',
      display_name: 'Alice',
      avatar_url: 'mxc://a',
    });
    await updateMembership(db, ROOM, USER, 'leave', '$e2');
    expect(db._state.memberships).toHaveLength(1);
    expect(db._state.memberships[0]).toMatchObject({
      membership: 'leave',
      event_id: '$e2',
      display_name: null,
      avatar_url: null,
    });
  });

  it('tryInsertJoinMembership inserts when absent', async () => {
    const db = createCrudDb();
    await expect(
      tryInsertJoinMembership(db, ROOM, USER, '$new', 'A', null as unknown as string)
    ).resolves.toEqual({ inserted: true, eventId: '$new' });
    expect(db._state.memberships[0].event_id).toBe('$new');
  });

  it('tryInsertJoinMembership keeps existing join event_id (inserted:false)', async () => {
    const db = createCrudDb({
      memberships: [
        {
          room_id: ROOM,
          user_id: USER,
          membership: 'join',
          event_id: '$old',
          display_name: 'Alice',
          avatar_url: null,
        },
      ],
    });
    await expect(
      tryInsertJoinMembership(db, ROOM, USER, '$new', 'Ignored')
    ).resolves.toEqual({ inserted: false, eventId: '$old' });
    expect(db._state.memberships[0].event_id).toBe('$old');
    expect(db._state.memberships[0].display_name).toBe('Alice');
  });

  it('tryInsertJoinMembership upgrades invite/leave to join with new event_id', async () => {
    const db = createCrudDb({
      memberships: [
        {
          room_id: ROOM,
          user_id: USER,
          membership: 'invite',
          event_id: '$inv',
          display_name: null,
          avatar_url: null,
        },
      ],
    });
    await expect(
      tryInsertJoinMembership(db, ROOM, USER, '$join', 'Alice', 'mxc://a')
    ).resolves.toEqual({ inserted: true, eventId: '$join' });
    expect(db._state.memberships[0]).toMatchObject({
      membership: 'join',
      event_id: '$join',
      display_name: 'Alice',
      avatar_url: 'mxc://a',
    });
  });

  it('tryInsertJoinMembership falls back to provided eventId when RETURNING is null', async () => {
    const db = createCrudDb();
    const orig = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (sql.includes('RETURNING event_id')) {
        return {
          bind() {
            return this;
          },
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        };
      }
      return orig(sql);
    }) as typeof db.prepare;
    await expect(tryInsertJoinMembership(db, ROOM, USER, '$fb')).resolves.toEqual({
      inserted: true,
      eventId: '$fb',
    });
  });

  it('getMembership returns null or mapped membership', async () => {
    const db = createCrudDb({
      memberships: [
        {
          room_id: ROOM,
          user_id: USER,
          membership: 'join',
          event_id: '$e',
          display_name: null,
          avatar_url: null,
        },
      ],
    });
    await expect(getMembership(db, ROOM, USER)).resolves.toEqual({
      membership: 'join',
      eventId: '$e',
    });
    await expect(getMembership(db, ROOM, BOB)).resolves.toBeNull();
  });

  it('getUserRooms filters optional membership', async () => {
    const db = createCrudDb({
      memberships: [
        {
          room_id: '!a:example.com',
          user_id: USER,
          membership: 'join',
          event_id: '$1',
          display_name: null,
          avatar_url: null,
        },
        {
          room_id: '!b:example.com',
          user_id: USER,
          membership: 'leave',
          event_id: '$2',
          display_name: null,
          avatar_url: null,
        },
        {
          room_id: '!c:example.com',
          user_id: BOB,
          membership: 'join',
          event_id: '$3',
          display_name: null,
          avatar_url: null,
        },
      ],
    });
    await expect(getUserRooms(db, USER)).resolves.toEqual([
      '!a:example.com',
      '!b:example.com',
    ]);
    await expect(getUserRooms(db, USER, 'join')).resolves.toEqual(['!a:example.com']);
    await expect(getUserRooms(db, USER, 'invite')).resolves.toEqual([]);
  });

  it('getRoomMembers maps display fields and optional membership filter', async () => {
    const db = createCrudDb({
      memberships: [
        {
          room_id: ROOM,
          user_id: USER,
          membership: 'join',
          event_id: '$1',
          display_name: 'Alice',
          avatar_url: null,
        },
        {
          room_id: ROOM,
          user_id: BOB,
          membership: 'invite',
          event_id: '$2',
          display_name: null,
          avatar_url: 'mxc://b',
        },
      ],
    });
    await expect(getRoomMembers(db, ROOM)).resolves.toEqual([
      {
        userId: USER,
        membership: 'join',
        displayName: 'Alice',
        avatarUrl: undefined,
      },
      {
        userId: BOB,
        membership: 'invite',
        displayName: undefined,
        avatarUrl: 'mxc://b',
      },
    ]);
    await expect(getRoomMembers(db, ROOM, 'join')).resolves.toEqual([
      {
        userId: USER,
        membership: 'join',
        displayName: 'Alice',
        avatarUrl: undefined,
      },
    ]);
  });
});

describe('database alias helpers', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('createRoomAlias / getRoomByAlias / deleteRoomAlias round-trip', async () => {
    const db = createCrudDb();
    await createRoomAlias(db, '#general:example.com', ROOM, USER);
    expect(db._state.aliases[0]).toEqual({
      alias: '#general:example.com',
      room_id: ROOM,
      creator_id: USER,
      created_at: NOW,
    });
    await expect(getRoomByAlias(db, '#general:example.com')).resolves.toBe(ROOM);
    await expect(getRoomByAlias(db, '#missing:example.com')).resolves.toBeNull();
    await deleteRoomAlias(db, '#general:example.com');
    await expect(getRoomByAlias(db, '#general:example.com')).resolves.toBeNull();
    expect(db._state.aliases).toHaveLength(0);
  });

  it('deleteRoomAlias is a no-op for unknown aliases', async () => {
    const db = createCrudDb({
      aliases: [
        {
          alias: '#keep:example.com',
          room_id: ROOM,
          creator_id: USER,
          created_at: 1,
        },
      ],
    });
    await deleteRoomAlias(db, '#gone:example.com');
    expect(db._state.aliases).toHaveLength(1);
  });
});

describe('database stream / batch event helpers', () => {
  it('getLatestStreamPosition returns 0 for empty / null MAX', async () => {
    const db = createCrudDb();
    await expect(getLatestStreamPosition(db)).resolves.toBe(0);
  });

  it('getLatestStreamPosition returns MAX stream_ordering', async () => {
    const db = createCrudDb({
      events: [
        eventRowFromPdu(pdu({ event_id: '$1', type: 'm.room.message' }), 3),
        eventRowFromPdu(pdu({ event_id: '$2', type: 'm.room.message' }), 9),
        eventRowFromPdu(pdu({ event_id: '$3', type: 'm.room.message' }), 5),
      ],
    });
    await expect(getLatestStreamPosition(db)).resolves.toBe(9);
  });

  it('getEventsSince filters by room + stream_ordering > since with limit', async () => {
    const db = createCrudDb({
      events: [1, 2, 3, 4, 5].map((n) =>
        eventRowFromPdu(
          pdu({
            event_id: `$${n}`,
            type: 'm.room.message',
            content: { body: String(n) },
          }),
          n
        )
      ),
    });
    const page = await getEventsSince(db, ROOM, 2, 2);
    expect(page.map((e) => e.event_id)).toEqual(['$3', '$4']);
    expect(page[0].content).toEqual({ body: '3' });

    const defaultLimit = await getEventsSince(db, ROOM, 0);
    expect(defaultLimit).toHaveLength(5);

    await expect(getEventsSince(db, ROOM, 100)).resolves.toEqual([]);
  });

  it('getEventsByIds returns [] for empty input without preparing', async () => {
    const db = createCrudDb({
      events: [eventRowFromPdu(pdu({ event_id: '$1', type: 'm.room.message' }), 1)],
    });
    await expect(getEventsByIds(db, [])).resolves.toEqual([]);
    expect(db._state.prepares).toHaveLength(0);
  });

  it('getEventsByIds fetches matching ids and parses optional JSON fields', async () => {
    const db = createCrudDb({
      events: [
        eventRowFromPdu(
          pdu({
            event_id: '$a',
            type: 'm.room.member',
            state_key: USER,
            content: { membership: 'join' },
            unsigned: { age: 1 },
          }),
          1
        ),
        {
          event_id: '$b',
          room_id: ROOM,
          sender: BOB,
          event_type: 'm.room.message',
          state_key: null,
          content: JSON.stringify({ body: 'b' }),
          origin_server_ts: NOW,
          unsigned: null,
          depth: 2,
          auth_events: '[]',
          prev_events: '[]',
          hashes: null,
          signatures: null,
          stream_ordering: 2,
        },
      ],
    });
    const got = await getEventsByIds(db, ['$a', '$missing', '$b']);
    expect(got.map((e) => e.event_id)).toEqual(['$a', '$b']);
    expect(got[0]).toMatchObject({
      type: 'm.room.member',
      state_key: USER,
      unsigned: { age: 1 },
      hashes: { sha256: 'h' },
    });
    expect(got[1]).toMatchObject({
      type: 'm.room.message',
      state_key: undefined,
      hashes: undefined,
      signatures: undefined,
    });
  });

  it('getEventsByIds pages at 100 ids per IN (...) query', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `$${i}`);
    const events = ids.map((id, i) =>
      eventRowFromPdu(
        pdu({
          event_id: id,
          type: 'm.room.message',
          content: { body: String(i) },
        }),
        i + 1
      )
    );
    const db = createCrudDb({ events });
    const got = await getEventsByIds(db, ids);
    expect(got).toHaveLength(250);
    const inPrepares = db._state.prepares.filter((s) => s.includes('IN ('));
    expect(inPrepares).toHaveLength(3);
    // 100 + 100 + 50 placeholders
    expect((inPrepares[0].match(/\?/g) ?? []).length).toBe(100);
    expect((inPrepares[1].match(/\?/g) ?? []).length).toBe(100);
    expect((inPrepares[2].match(/\?/g) ?? []).length).toBe(50);
  });
});

describe('database CRUD contracts / isolation', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('createUser defaults isGuest to false when omitted', async () => {
    const db = createCrudDb();
    await createUser(db, USER, 'alice', 'h');
    expect(db._state.users[0].is_guest).toBe(0);
  });

  it('user/device/token helpers do not cross-contaminate prepares across calls', async () => {
    const db = createCrudDb();
    await createUser(db, USER, 'alice', 'h');
    await createDevice(db, USER, 'D');
    await createAccessToken(db, 't', 'hash', USER, 'D');
    const sqls = db._state.prepares.join('\n');
    expect(sqls).toContain('INSERT INTO users');
    expect(sqls).toContain('INSERT INTO devices');
    expect(sqls).toContain('INSERT INTO access_tokens');
    await expect(getUserByTokenHash(db, 'hash')).resolves.toEqual({
      userId: USER,
      deviceId: 'D',
    });
  });

  it('empty-string state_key is treated as state (updates room_state)', async () => {
    const db = createCrudDb({ streamPosition: 0 });
    await storeEvent(
      db,
      pdu({
        event_id: '$empty-key',
        type: 'm.room.name',
        state_key: '',
        content: { name: 'x' },
      })
    );
    expect(db._state.roomState.has(`${ROOM}\0m.room.name\0`)).toBe(true);
  });

  it('getRoomEvents parses JSON fields on returned events', async () => {
    const db = createCrudDb({
      events: [
        {
          event_id: '$p',
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.message',
          state_key: null,
          content: JSON.stringify({ body: 'parsed' }),
          origin_server_ts: NOW,
          unsigned: JSON.stringify({ age: 2 }),
          depth: 1,
          auth_events: JSON.stringify(['$a']),
          prev_events: JSON.stringify(['$b']),
          hashes: null,
          signatures: null,
          stream_ordering: 1,
        },
      ],
    });
    const { events } = await getRoomEvents(db, ROOM, undefined, 10, 'f');
    expect(events[0]).toMatchObject({
      content: { body: 'parsed' },
      unsigned: { age: 2 },
      auth_events: ['$a'],
      prev_events: ['$b'],
      state_key: undefined,
    });
  });

  it('storeEvent bind order matches INSERT column list', async () => {
    const db = createCrudDb({ streamPosition: 0 });
    const event = pdu({
      event_id: '$bind',
      type: 'm.room.member',
      state_key: USER,
      content: { membership: 'join' },
      unsigned: { age: 0 },
      depth: 7,
      auth_events: ['$auth'],
      prev_events: ['$prev'],
    });
    await storeEvent(db, event);
    const insert = db._state.runs.find((r) => r.sql.includes('INSERT INTO events'));
    expect(insert?.args).toEqual([
      '$bind',
      ROOM,
      USER,
      'm.room.member',
      USER,
      JSON.stringify({ membership: 'join' }),
      NOW,
      JSON.stringify({ age: 0 }),
      7,
      JSON.stringify(['$auth']),
      JSON.stringify(['$prev']),
      JSON.stringify({ sha256: 'h' }),
      JSON.stringify({ 'example.com': { 'ed25519:1': 'sig' } }),
      1,
    ]);
  });
});

describe('database CRUD TOKENMAXX edge paths after #73', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps unicode display names through user + membership paths', async () => {
    const db = createCrudDb();
    await createUser(db, USER, 'alice', 'h');
    await updateUserProfile(db, USER, 'アリス 🚀');
    await expect(getUserById(db, USER)).resolves.toMatchObject({
      display_name: 'アリス 🚀',
    });
    await updateMembership(db, ROOM, USER, 'join', '$u', 'アリス 🚀', 'mxc://絵');
    await expect(getRoomMembers(db, ROOM)).resolves.toEqual([
      {
        userId: USER,
        membership: 'join',
        displayName: 'アリス 🚀',
        avatarUrl: 'mxc://絵',
      },
    ]);
  });

  it('getLatestStreamPosition treats max_ordering 0 as present (not ?? fallback)', async () => {
    const db = createCrudDb({
      events: [eventRowFromPdu(pdu({ event_id: '$z', type: 'm.room.message' }), 0)],
    });
    await expect(getLatestStreamPosition(db)).resolves.toBe(0);
  });

  it('getEventsSince isolates rooms and honors since:0 as incremental', async () => {
    const db = createCrudDb({
      events: [
        eventRowFromPdu(pdu({ event_id: '$a1', type: 'm.room.message' }), 1),
        eventRowFromPdu(
          pdu({
            event_id: '$o1',
            room_id: '!other:example.com',
            type: 'm.room.message',
          }),
          2
        ),
        eventRowFromPdu(pdu({ event_id: '$a2', type: 'm.room.message' }), 3),
      ],
    });
    const sinceZero = await getEventsSince(db, ROOM, 0, 10);
    expect(sinceZero.map((e) => e.event_id)).toEqual(['$a1', '$a2']);
  });

  it('getEventsByIds exact page-size boundary uses a single prepare', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `$${i}`);
    const db = createCrudDb({
      events: ids.map((id, i) =>
        eventRowFromPdu(pdu({ event_id: id, type: 'm.room.message' }), i + 1)
      ),
    });
    await expect(getEventsByIds(db, ids)).resolves.toHaveLength(100);
    expect(db._state.prepares.filter((s) => s.includes('IN ('))).toHaveLength(1);
  });

  it('getEventsByIds with 101 ids spills into a second page of 1', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `$${i}`);
    const db = createCrudDb({
      events: ids.map((id, i) =>
        eventRowFromPdu(pdu({ event_id: id, type: 'm.room.message' }), i + 1)
      ),
    });
    await getEventsByIds(db, ids);
    const pages = db._state.prepares.filter((s) => s.includes('IN ('));
    expect(pages).toHaveLength(2);
    expect((pages[0].match(/\?/g) ?? []).length).toBe(100);
    expect((pages[1].match(/\?/g) ?? []).length).toBe(1);
  });

  it('storeEvent replaces prior room_state for the same type/state_key', async () => {
    const db = createCrudDb({ streamPosition: 0 });
    await storeEvent(
      db,
      pdu({
        event_id: '$n1',
        type: 'm.room.name',
        state_key: '',
        content: { name: 'one' },
      })
    );
    await storeEvent(
      db,
      pdu({
        event_id: '$n2',
        type: 'm.room.name',
        state_key: '',
        content: { name: 'two' },
      })
    );
    expect(db._state.roomState.get(`${ROOM}\0m.room.name\0`)).toBe('$n2');
    await expect(getStateEvent(db, ROOM, 'm.room.name')).resolves.toMatchObject({
      event_id: '$n2',
      content: { name: 'two' },
    });
  });

  it('storeEventIdempotent allocates stream ids even when colliding', async () => {
    const db = createCrudDb({
      streamPosition: 10,
      events: [
        eventRowFromPdu(pdu({ event_id: '$same', type: 'm.room.message' }), 10),
      ],
    });
    await storeEventIdempotent(
      db,
      pdu({ event_id: '$same', type: 'm.room.message', content: { body: 'x' } })
    );
    await storeEventIdempotent(
      db,
      pdu({ event_id: '$same', type: 'm.room.message', content: { body: 'y' } })
    );
    expect(db._state.streamPosition).toBe(12);
    expect(db._state.events).toHaveLength(1);
  });

  it('getRoomEvents forwards fromToken 0 uses unfiltered ASC branch', async () => {
    const db = createCrudDb({
      events: [1, 2, 3].map((n) =>
        eventRowFromPdu(
          pdu({ event_id: `$${n}`, type: 'm.room.message', content: { body: String(n) } }),
          n
        )
      ),
    });
    const { events, end } = await getRoomEvents(db, ROOM, 0, 2, 'f');
    expect(events.map((e) => e.event_id)).toEqual(['$1', '$2']);
    expect(end).toBe(2);
  });

  it('tryInsertJoinMembership omits profile fields when undefined', async () => {
    const db = createCrudDb();
    await tryInsertJoinMembership(db, ROOM, USER, '$j');
    expect(db._state.memberships[0]).toMatchObject({
      display_name: null,
      avatar_url: null,
      event_id: '$j',
    });
  });

  it('getUserByTokenHash / getPasswordHash bind the lookup key once', async () => {
    const db = createCrudDb({
      users: [
        {
          user_id: USER,
          localpart: 'alice',
          password_hash: 'secret',
          display_name: null,
          avatar_url: null,
          is_guest: 0,
          is_deactivated: 0,
          admin: 0,
          created_at: 1,
          updated_at: 1,
        },
      ],
      tokens: [
        {
          token_id: 't',
          token_hash: 'th',
          user_id: USER,
          device_id: 'D',
          created_at: 1,
        },
      ],
    });
    db._state.binds.length = 0;
    await getPasswordHash(db, USER);
    await getUserByTokenHash(db, 'th');
    expect(db._state.binds).toEqual([[USER], ['th']]);
  });

  it('createDevice / createAccessToken / createRoomAlias stamp Date.now()', async () => {
    const db = createCrudDb();
    await createDevice(db, USER, 'D', 'n');
    await createAccessToken(db, 'tid', 'h', USER, 'D');
    await createRoomAlias(db, '#a:example.com', ROOM, USER);
    expect(db._state.devices[0].created_at).toBe(NOW);
    expect(db._state.tokens[0].created_at).toBe(NOW);
    expect(db._state.aliases[0].created_at).toBe(NOW);
  });

  it('getRoomMembers returns empty for unknown rooms', async () => {
    const db = createCrudDb({
      memberships: [
        {
          room_id: ROOM,
          user_id: USER,
          membership: 'join',
          event_id: '$1',
          display_name: null,
          avatar_url: null,
        },
      ],
    });
    await expect(getRoomMembers(db, '!nope:example.com')).resolves.toEqual([]);
  });

  it('getMembership distinguishes ban/knock/invite states', async () => {
    const db = createCrudDb({
      memberships: [
        {
          room_id: ROOM,
          user_id: USER,
          membership: 'ban',
          event_id: '$b',
          display_name: null,
          avatar_url: null,
        },
        {
          room_id: ROOM,
          user_id: BOB,
          membership: 'knock',
          event_id: '$k',
          display_name: null,
          avatar_url: null,
        },
      ],
    });
    await expect(getMembership(db, ROOM, USER)).resolves.toEqual({
      membership: 'ban',
      eventId: '$b',
    });
    await expect(getMembership(db, ROOM, BOB)).resolves.toEqual({
      membership: 'knock',
      eventId: '$k',
    });
  });

  it('sequential storeEvent calls allocate monotonically increasing stream ids', async () => {
    const db = createCrudDb({ streamPosition: 100 });
    const a = await storeEvent(
      db,
      pdu({ event_id: '$s1', type: 'm.room.message', content: { body: '1' } })
    );
    const b = await storeEvent(
      db,
      pdu({ event_id: '$s2', type: 'm.room.message', content: { body: '2' } })
    );
    const c = await storeEvent(
      db,
      pdu({ event_id: '$s3', type: 'm.room.message', content: { body: '3' } })
    );
    expect([a, b, c]).toEqual([101, 102, 103]);
  });

  it('getStateEvent with explicit empty state_key matches defaulted call', async () => {
    const db = createCrudDb({
      events: [
        eventRowFromPdu(
          pdu({
            event_id: '$t',
            type: 'm.room.topic',
            state_key: '',
            content: { topic: 'hi' },
          }),
          1
        ),
      ],
      roomState: [
        { room_id: ROOM, event_type: 'm.room.topic', state_key: '', event_id: '$t' },
      ],
    });
    const a = await getStateEvent(db, ROOM, 'm.room.topic');
    const b = await getStateEvent(db, ROOM, 'm.room.topic', '');
    expect(a).toEqual(b);
    expect(a?.content).toEqual({ topic: 'hi' });
  });

  it('deleteAllUserTokens on a user with no tokens is a quiet no-op', async () => {
    const db = createCrudDb({
      tokens: [
        {
          token_id: 't',
          token_hash: 'h',
          user_id: BOB,
          device_id: null,
          created_at: 1,
        },
      ],
    });
    await deleteAllUserTokens(db, USER);
    expect(db._state.tokens).toHaveLength(1);
  });

  it('getUserDevices maps null profile fields to undefined for every device', async () => {
    const db = createCrudDb({
      devices: [
        {
          user_id: USER,
          device_id: 'A',
          display_name: null,
          last_seen_ts: null,
          last_seen_ip: null,
          created_at: 1,
        },
        {
          user_id: USER,
          device_id: 'B',
          display_name: null,
          last_seen_ts: null,
          last_seen_ip: null,
          created_at: 2,
        },
      ],
    });
    const devices = await getUserDevices(db, USER);
    expect(devices).toHaveLength(2);
    expect(devices.every((d) => d.display_name === undefined)).toBe(true);
    expect(devices.every((d) => d.last_seen_ts === undefined)).toBe(true);
    expect(devices.every((d) => d.last_seen_ip === undefined)).toBe(true);
  });

  it('getRoomEvents limit 1 returns end equal to that single event stream_ordering', async () => {
    const db = createCrudDb({
      events: [5, 6, 7].map((n) =>
        eventRowFromPdu(pdu({ event_id: `$${n}`, type: 'm.room.message' }), n)
      ),
    });
    const { events, end } = await getRoomEvents(db, ROOM, undefined, 1, 'b');
    expect(events).toHaveLength(1);
    expect(events[0].event_id).toBe('$7');
    expect(end).toBe(7);
  });
});


describe('database CRUD TOKENMAXX leftovers after #226', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('updateUserProfile is a quiet no-op when both fields are omitted', async () => {
    const db = createCrudDb({
      users: [
        {
          user_id: USER,
          localpart: 'alice',
          password_hash: 'h',
          display_name: 'Alice',
          avatar_url: 'mxc://example.com/a',
          is_guest: 0,
          is_deactivated: 0,
          admin: 0,
          created_at: NOW,
          updated_at: NOW,
        },
      ],
    });
    await updateUserProfile(db, USER);
    expect(db._state.runs).toEqual([]);
    expect(db._state.users[0].display_name).toBe('Alice');
    expect(db._state.users[0].avatar_url).toBe('mxc://example.com/a');
  });

  it('getUserById maps admin and is_deactivated independently', async () => {
    const db = createCrudDb({
      users: [
        {
          user_id: USER,
          localpart: 'alice',
          password_hash: null,
          display_name: null,
          avatar_url: null,
          is_guest: 0,
          is_deactivated: 1,
          admin: 1,
          created_at: NOW,
          updated_at: NOW,
        },
      ],
    });
    const user = await getUserById(db, USER);
    expect(user).toMatchObject({
      is_guest: false,
      is_deactivated: true,
      admin: true,
    });
  });

  it('createRoom stores is_public=1 when isPublic=true', async () => {
    const db = createCrudDb();
    await createRoom(db, ROOM, '10', USER, true);
    expect(db._state.rooms[0].is_public).toBe(1);
    const room = await getRoom(db, ROOM);
    expect(room?.is_public).toBe(true);
  });

  it('getRoomByAlias / deleteDevice / deleteAccessToken are quiet misses', async () => {
    const db = createCrudDb();
    await expect(getRoomByAlias(db, '#missing:example.com')).resolves.toBeNull();
    await expect(deleteDevice(db, USER, 'DEV')).resolves.toBeUndefined();
    await expect(deleteAccessToken(db, 'no-hash')).resolves.toBeUndefined();
    expect(db._state.devices).toEqual([]);
    expect(db._state.tokens).toEqual([]);
  });

  it('getRoomEvents on an empty room returns end=0', async () => {
    const db = createCrudDb();
    const { events, end } = await getRoomEvents(db, ROOM);
    expect(events).toEqual([]);
    expect(end).toBe(0);
  });

  it('getEventsSince defaults limit to 100', async () => {
    const db = createCrudDb({
      events: Array.from({ length: 120 }, (_, i) =>
        eventRowFromPdu(pdu({ event_id: `$e${i}`, type: 'm.room.message' }), i + 1)
      ),
    });
    const page = await getEventsSince(db, ROOM, 0);
    expect(page).toHaveLength(100);
    expect(page[0].event_id).toBe('$e0');
    expect(page[99].event_id).toBe('$e99');
  });

  it('getEventsByIds with 250 ids issues three prepares (100/100/50)', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `$id${i}`);
    const db = createCrudDb({
      events: ids.map((id, i) =>
        eventRowFromPdu(pdu({ event_id: id, type: 'm.room.message' }), i + 1)
      ),
    });
    db._state.prepares.length = 0;
    const got = await getEventsByIds(db, ids);
    expect(got).toHaveLength(250);
    const inPrepares = db._state.prepares.filter((s) => s.includes('IN ('));
    expect(inPrepares).toHaveLength(3);
  });

  it('storeEventIdempotent currently does not invoke validateEventSize (documents gap)', async () => {
    // Contrast with storeEvent which rejects oversized content. Idempotent path skips the check today.
    const huge = 'x'.repeat(70_000);
    const event = pdu({
      event_id: '$huge',
      type: 'm.room.message',
      content: { body: huge, msgtype: 'm.text' },
    });
    expect(() => validateEventSize(event)).toThrow(MatrixApiError);
    const db = createCrudDb();
    const result = await storeEventIdempotent(db, event);
    expect(result.inserted).toBe(true);
    expect(db._state.events).toHaveLength(1);
  });

  it('tryInsertJoinMembership concurrent double-join collapses to one membership row', async () => {
    const db = createCrudDb();
    const [a, b] = await Promise.all([
      tryInsertJoinMembership(db, ROOM, USER, '$join-a', 'Alice'),
      tryInsertJoinMembership(db, ROOM, USER, '$join-b', 'Alice2'),
    ]);
    expect(db._state.memberships).toHaveLength(1);
    // First writer wins join event_id; second sees existing join → inserted:false
    const winners = [a, b].filter((r) => r.inserted);
    const losers = [a, b].filter((r) => !r.inserted);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].eventId).toBe(winners[0].eventId);
    expect(db._state.memberships[0].event_id).toBe(winners[0].eventId);
  });

  it('updateMembership without profile fields stores null display/avatar', async () => {
    const db = createCrudDb();
    await updateMembership(db, ROOM, USER, 'invite', '$inv');
    expect(db._state.memberships[0]).toMatchObject({
      membership: 'invite',
      event_id: '$inv',
      display_name: null,
      avatar_url: null,
    });
  });

  it('getUserRooms without filter returns every membership state', async () => {
    const db = createCrudDb({
      memberships: [
        {
          room_id: '!a:example.com',
          user_id: USER,
          membership: 'join',
          event_id: '$1',
          display_name: null,
          avatar_url: null,
        },
        {
          room_id: '!b:example.com',
          user_id: USER,
          membership: 'leave',
          event_id: '$2',
          display_name: null,
          avatar_url: null,
        },
        {
          room_id: '!c:example.com',
          user_id: USER,
          membership: 'invite',
          event_id: '$3',
          display_name: null,
          avatar_url: null,
        },
      ],
    });
    const rooms = await getUserRooms(db, USER);
    expect(rooms.sort()).toEqual(['!a:example.com', '!b:example.com', '!c:example.com']);
  });

  it('getStateEvent returns null for unknown type/key pairs', async () => {
    const db = createCrudDb({
      events: [eventRowFromPdu(pdu({ event_id: '$c', type: 'm.room.create', state_key: '' }), 1)],
      roomState: [
        { room_id: ROOM, event_type: 'm.room.create', state_key: '', event_id: '$c' },
      ],
    });
    await expect(getStateEvent(db, ROOM, 'm.room.topic')).resolves.toBeNull();
    await expect(getStateEvent(db, ROOM, 'm.room.create', 'nope')).resolves.toBeNull();
  });

  it('getRoomState returns multiple distinct state types for one room', async () => {
    const create = pdu({ event_id: '$c', type: 'm.room.create', state_key: '', content: { creator: USER } });
    const name = pdu({
      event_id: '$n',
      type: 'm.room.name',
      state_key: '',
      content: { name: 'Lobby' },
    });
    const member = pdu({
      event_id: '$m',
      type: 'm.room.member',
      state_key: USER,
      content: { membership: 'join' },
    });
    const db = createCrudDb({
      events: [
        eventRowFromPdu(create, 1),
        eventRowFromPdu(name, 2),
        eventRowFromPdu(member, 3),
      ],
      roomState: [
        { room_id: ROOM, event_type: 'm.room.create', state_key: '', event_id: '$c' },
        { room_id: ROOM, event_type: 'm.room.name', state_key: '', event_id: '$n' },
        { room_id: ROOM, event_type: 'm.room.member', state_key: USER, event_id: '$m' },
      ],
    });
    const state = await getRoomState(db, ROOM);
    expect(state.map((e) => e.type).sort()).toEqual([
      'm.room.create',
      'm.room.member',
      'm.room.name',
    ]);
  });

  it('createAccessToken → getUserByTokenHash round-trips nullable device_id', async () => {
    const db = createCrudDb();
    await createAccessToken(db, 'tid', 'thash', USER, null);
    await expect(getUserByTokenHash(db, 'thash')).resolves.toEqual({
      userId: USER,
      deviceId: null,
    });
  });

  it('storeEvent with empty content object still allocates a stream id', async () => {
    const db = createCrudDb();
    const stream = await storeEvent(
      db,
      pdu({ event_id: '$empty', type: 'm.room.message', content: {} })
    );
    expect(stream).toBe(1);
    expect(JSON.parse(db._state.events[0].content)).toEqual({});
  });

  it('getEvent maps null hashes/signatures/unsigned to undefined', async () => {
    const db = createCrudDb({
      events: [
        {
          event_id: '$bare',
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.message',
          state_key: null,
          content: '{}',
          origin_server_ts: NOW,
          unsigned: null,
          depth: 1,
          auth_events: '[]',
          prev_events: '[]',
          hashes: null,
          signatures: null,
          stream_ordering: 1,
        },
      ],
    });
    const event = await getEvent(db, '$bare');
    expect(event?.hashes).toBeUndefined();
    expect(event?.signatures).toBeUndefined();
    expect(event?.unsigned).toBeUndefined();
    expect(event?.state_key).toBeUndefined();
  });
});

describe('database CRUD TOKENMAXX leftovers after #232', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('storeEvent treats explicit null state_key as state (updates room_state)', async () => {
    // state_key !== undefined gate — null is a defined value and still writes room_state
    const db = createCrudDb();
    const event = pdu({
      event_id: '$null-sk',
      type: 'm.room.name',
      content: { name: 'Lobby' },
    });
    (event as { state_key: string | null }).state_key = null;
    await storeEvent(db, event);
    expect(db._state.events[0].state_key).toBeNull();
    expect(db._state.roomState.get(`${ROOM}\0m.room.name\0null`)).toBe('$null-sk');
  });

  it('concurrent storeEvent allocates distinct monotonically increasing stream ids', async () => {
    const db = createCrudDb();
    const streams = await Promise.all([
      storeEvent(db, pdu({ event_id: '$p1', type: 'm.room.message', content: { body: '1' } })),
      storeEvent(db, pdu({ event_id: '$p2', type: 'm.room.message', content: { body: '2' } })),
      storeEvent(db, pdu({ event_id: '$p3', type: 'm.room.message', content: { body: '3' } })),
    ]);
    expect(new Set(streams).size).toBe(3);
    expect(streams.sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(db._state.events).toHaveLength(3);
  });

  it('storeEventIdempotent concurrent same event_id collapses to one inserted winner', async () => {
    const db = createCrudDb();
    const event = pdu({
      event_id: '$same',
      type: 'm.room.topic',
      state_key: '',
      content: { topic: 'x' },
    });
    const [a, b] = await Promise.all([
      storeEventIdempotent(db, event),
      storeEventIdempotent(db, event),
    ]);
    const winners = [a, b].filter((r) => r.inserted);
    const losers = [a, b].filter((r) => !r.inserted);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].streamOrdering).toBeNull();
    expect(db._state.events.filter((e) => e.event_id === '$same')).toHaveLength(1);
  });

  it('getEventsByIds returns only found ids and ignores unknown placeholders', async () => {
    const db = createCrudDb({
      events: [
        eventRowFromPdu(pdu({ event_id: '$a', type: 'm.room.message' }), 1),
        eventRowFromPdu(pdu({ event_id: '$c', type: 'm.room.message' }), 2),
      ],
    });
    const got = await getEventsByIds(db, ['$a', '$missing', '$c', '$a']);
    expect(got.map((e) => e.event_id).sort()).toEqual(['$a', '$c']);
  });

  it('getEventsSince with limit 0 returns an empty page', async () => {
    const db = createCrudDb({
      events: [eventRowFromPdu(pdu({ event_id: '$e1', type: 'm.room.message' }), 1)],
    });
    await expect(getEventsSince(db, ROOM, 0, 0)).resolves.toEqual([]);
  });

  it('validateEventSize soft-cap error message includes the byte count', () => {
    const event = pdu({
      event_id: '$big',
      type: 'm.room.message',
      content: { body: 'x'.repeat(70_000) },
    });
    try {
      validateEventSize(event);
      expect.unreachable('should throw');
    } catch (err) {
      const e = err as MatrixApiError;
      expect(e.errcode).toBe('M_TOO_LARGE');
      expect(e.status).toBe(413);
      expect(e.message).toMatch(/65536/);
      expect(e.message).toMatch(/got \d+/);
    }
  });

  it('updateUserProfile can update avatar_url alone without touching display_name', async () => {
    const db = createCrudDb({
      users: [
        {
          user_id: USER,
          localpart: 'alice',
          password_hash: 'h',
          display_name: 'Alice',
          avatar_url: null,
          is_guest: 0,
          is_deactivated: 0,
          admin: 0,
          created_at: NOW,
          updated_at: NOW,
        },
      ],
    });
    await updateUserProfile(db, USER, undefined, 'mxc://example.com/new');
    expect(db._state.users[0].display_name).toBe('Alice');
    expect(db._state.users[0].avatar_url).toBe('mxc://example.com/new');
    expect(db._state.runs.filter((r) => r.sql.includes('avatar_url'))).toHaveLength(1);
    expect(db._state.runs.filter((r) => r.sql.includes('display_name'))).toHaveLength(0);
  });

  it('getRoomEvents forwards with fromToken pages oldest-first after the cursor', async () => {
    const db = createCrudDb({
      events: [1, 2, 3, 4, 5].map((n) =>
        eventRowFromPdu(pdu({ event_id: `$${n}`, type: 'm.room.message' }), n)
      ),
    });
    const { events, end } = await getRoomEvents(db, ROOM, 2, 2, 'f');
    expect(events.map((e) => e.event_id)).toEqual(['$3', '$4']);
    expect(end).toBe(4);
  });

  it('createUser guest stamps Date.now for created_at and updated_at', async () => {
    const db = createCrudDb();
    await createUser(db, USER, 'alice', null, true);
    expect(db._state.users[0]).toMatchObject({
      is_guest: 1,
      password_hash: null,
      created_at: NOW,
      updated_at: NOW,
    });
  });

  it('getRoomMembers with membership filter returns mapped display fields', async () => {
    const db = createCrudDb({
      memberships: [
        {
          room_id: ROOM,
          user_id: USER,
          membership: 'join',
          event_id: '$1',
          display_name: 'Alice',
          avatar_url: 'mxc://example.com/a',
        },
        {
          room_id: ROOM,
          user_id: BOB,
          membership: 'invite',
          event_id: '$2',
          display_name: null,
          avatar_url: null,
        },
      ],
    });
    const joined = await getRoomMembers(db, ROOM, 'join');
    expect(joined).toEqual([
      {
        userId: USER,
        membership: 'join',
        displayName: 'Alice',
        avatarUrl: 'mxc://example.com/a',
      },
    ]);
  });

  it('deleteRoomAlias then getRoomByAlias is null; recreate binds creator', async () => {
    const db = createCrudDb();
    await createRoomAlias(db, '#lobby:example.com', ROOM, USER);
    await deleteRoomAlias(db, '#lobby:example.com');
    await expect(getRoomByAlias(db, '#lobby:example.com')).resolves.toBeNull();
    await createRoomAlias(db, '#lobby:example.com', ROOM, BOB);
    await expect(getRoomByAlias(db, '#lobby:example.com')).resolves.toBe(ROOM);
    expect(db._state.aliases[0].creator_id).toBe(BOB);
  });

  it('getUserByLocalpart returns null for unknown localpart without preparing cross-user rows', async () => {
    const db = createCrudDb({
      users: [
        {
          user_id: USER,
          localpart: 'alice',
          password_hash: 'h',
          display_name: null,
          avatar_url: null,
          is_guest: 0,
          is_deactivated: 0,
          admin: 0,
          created_at: NOW,
          updated_at: NOW,
        },
      ],
    });
    await expect(getUserByLocalpart(db, 'bob')).resolves.toBeNull();
    await expect(getUserByLocalpart(db, 'alice')).resolves.toMatchObject({ user_id: USER });
  });

  it('updateMembership replaces prior membership for the same room/user pair', async () => {
    const db = createCrudDb();
    await updateMembership(db, ROOM, USER, 'invite', '$inv', 'Alice');
    await updateMembership(db, ROOM, USER, 'join', '$join', 'Alice', 'mxc://example.com/a');
    expect(db._state.memberships).toHaveLength(1);
    expect(db._state.memberships[0]).toMatchObject({
      membership: 'join',
      event_id: '$join',
      display_name: 'Alice',
      avatar_url: 'mxc://example.com/a',
    });
  });

  it('getLatestStreamPosition ignores other rooms only via global MAX', async () => {
    const db = createCrudDb({
      events: [
        eventRowFromPdu(pdu({ event_id: '$a', type: 'm.room.message', room_id: '!a:example.com' }), 3),
        eventRowFromPdu(pdu({ event_id: '$b', type: 'm.room.message', room_id: '!b:example.com' }), 9),
      ],
    });
    // Global max across all rooms (sync cursor semantics)
    await expect(getLatestStreamPosition(db)).resolves.toBe(9);
  });
});

describe('database CRUD TOKENMAXX leftovers after #241', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getRoomEvents omits hashes/signatures even when the row stores them', async () => {
    // SELECT * returns the columns, but the mapper never copies hashes/signatures
    // (contrast getEvent / getEventsByIds which do).
    const db = createCrudDb({
      events: [
        eventRowFromPdu(
          pdu({
            event_id: '$h',
            type: 'm.room.message',
            content: { body: 'hi' },
            hashes: { sha256: 'abc' },
            signatures: { 'example.com': { 'ed25519:1': 'sig' } },
          }),
          1
        ),
      ],
    });
    const { events } = await getRoomEvents(db, ROOM);
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty('hashes');
    expect(events[0]).not.toHaveProperty('signatures');
    expect(events[0].content).toEqual({ body: 'hi' });
  });

  it('getEventsSince / getRoomState also omit hashes and signatures', async () => {
    const create = pdu({
      event_id: '$c',
      type: 'm.room.create',
      state_key: '',
      content: { creator: USER },
      hashes: { sha256: 'c' },
      signatures: { 'example.com': { 'ed25519:1': 's' } },
    });
    const msg = pdu({
      event_id: '$m',
      type: 'm.room.message',
      content: { body: 'x' },
      hashes: { sha256: 'm' },
      signatures: { 'example.com': { 'ed25519:1': 's2' } },
    });
    const db = createCrudDb({
      events: [eventRowFromPdu(create, 1), eventRowFromPdu(msg, 2)],
      roomState: [
        { room_id: ROOM, event_type: 'm.room.create', state_key: '', event_id: '$c' },
      ],
    });
    const since = await getEventsSince(db, ROOM, 0);
    expect(since.every((e) => !('hashes' in e) && !('signatures' in e))).toBe(true);
    const state = await getRoomState(db, ROOM);
    expect(state).toHaveLength(1);
    expect(state[0]).not.toHaveProperty('hashes');
    expect(state[0]).not.toHaveProperty('signatures');
  });

  it('storeEvent rejects hard-cap oversized PDUs without writing a row', async () => {
    const db = createCrudDb();
    const event = pdu({
      event_id: '$hard',
      type: 'm.room.message',
      content: { body: 'ok' },
    });
    event.auth_events = Array.from({ length: 40_000 }, (_, i) => `$auth-${i}:example.com`);
    expect(JSON.stringify(event.content).length).toBeLessThanOrEqual(65_536);
    expect(JSON.stringify(event).length).toBeGreaterThan(921_600);
    await expect(storeEvent(db, event)).rejects.toMatchObject({
      errcode: 'M_TOO_LARGE',
      status: 413,
    });
    expect(db._state.events).toHaveLength(0);
  });

  it('storeEventIdempotent treats missing meta.changes as inserted:false', async () => {
    const db = createCrudDb();
    const orig = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (sql.includes('INSERT OR IGNORE INTO events')) {
        return {
          bind() {
            return {
              async run() {
                // No meta → (meta?.changes ?? 0) > 0 is false
                return {};
              },
              first: async () => null,
              all: async () => ({ results: [] }),
            };
          },
        };
      }
      return orig(sql);
    }) as typeof db.prepare;

    const result = await storeEventIdempotent(
      db,
      pdu({ event_id: '$nomet', type: 'm.room.message', content: { body: 'x' } })
    );
    expect(result).toEqual({ inserted: false, streamOrdering: null });
    expect(db._state.events).toHaveLength(0);
    // Stream id is still allocated optimistically before INSERT
    expect(db._state.streamPosition).toBe(1);
  });

  it('storeEventIdempotent defaults stream ordering to 1 when RETURNING is null', async () => {
    const hybrid = createCrudDb({ streamPosition: 0 });
    const orig = hybrid.prepare.bind(hybrid);
    hybrid.prepare = ((sql: string) => {
      if (sql.includes('UPDATE stream_positions')) {
        return {
          bind() {
            return this;
          },
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        };
      }
      return orig(sql);
    }) as typeof hybrid.prepare;

    await expect(
      storeEventIdempotent(
        hybrid,
        pdu({ event_id: '$fb-idem', type: 'm.room.message', content: { body: 'x' } })
      )
    ).resolves.toEqual({ inserted: true, streamOrdering: 1 });
    expect(hybrid._state.events[0].stream_ordering).toBe(1);
  });

  it('getRoomEvents with limit 0 returns empty page and end fromToken/0', async () => {
    const db = createCrudDb({
      events: [eventRowFromPdu(pdu({ event_id: '$e1', type: 'm.room.message' }), 1)],
    });
    await expect(getRoomEvents(db, ROOM, 5, 0, 'b')).resolves.toEqual({
      events: [],
      end: 5,
    });
    await expect(getRoomEvents(db, ROOM, undefined, 0, 'f')).resolves.toEqual({
      events: [],
      end: 0,
    });
  });

  it('getRoomEvents treats empty-string unsigned as falsy (maps to undefined)', async () => {
    const db = createCrudDb({
      events: [
        {
          event_id: '$u',
          room_id: ROOM,
          sender: USER,
          event_type: 'm.room.message',
          state_key: null,
          content: '{}',
          origin_server_ts: NOW,
          unsigned: '',
          depth: 1,
          auth_events: '[]',
          prev_events: '[]',
          hashes: null,
          signatures: null,
          stream_ordering: 1,
        },
      ],
    });
    const { events } = await getRoomEvents(db, ROOM);
    expect(events[0].unsigned).toBeUndefined();
  });

  it('getEventsByIds still maps hashes/signatures when getRoomEvents would omit them', async () => {
    const event = pdu({
      event_id: '$cmp',
      type: 'm.room.message',
      content: { body: 'cmp' },
      hashes: { sha256: 'cmp' },
      signatures: { 'example.com': { 'ed25519:1': 'sig' } },
    });
    const db = createCrudDb({ events: [eventRowFromPdu(event, 1)] });
    const [byId] = await getEventsByIds(db, ['$cmp']);
    const { events: roomPage } = await getRoomEvents(db, ROOM);
    expect(byId.hashes).toEqual({ sha256: 'cmp' });
    expect(byId.signatures).toEqual({ 'example.com': { 'ed25519:1': 'sig' } });
    expect(roomPage[0]).not.toHaveProperty('hashes');
  });

  it('storeEventIdempotent with null state_key still updates room_state when inserted', async () => {
    const db = createCrudDb();
    const event = pdu({
      event_id: '$null-sk-idem',
      type: 'm.room.name',
      content: { name: 'Lobby' },
    });
    (event as { state_key: string | null }).state_key = null;
    await expect(storeEventIdempotent(db, event)).resolves.toEqual({
      inserted: true,
      streamOrdering: 1,
    });
    expect(db._state.roomState.get(`${ROOM}\0m.room.name\0null`)).toBe('$null-sk-idem');
  });

  it('createDevice with explicit displayName binds the string (not null)', async () => {
    const db = createCrudDb();
    await createDevice(db, USER, 'PHONE', 'Pixel');
    expect(db._state.devices[0]).toMatchObject({
      user_id: USER,
      device_id: 'PHONE',
      display_name: 'Pixel',
      created_at: NOW,
    });
  });
});

describe('database CRUD TOKENMAXX residual leftovers after #252', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('storeEvent soft-cap reject does not consume a stream position', async () => {
    const db = createCrudDb({ streamPosition: 7 });
    const event = pdu({
      event_id: '$soft',
      type: 'm.room.message',
      content: { body: 'x'.repeat(70_000) },
    });
    await expect(storeEvent(db, event)).rejects.toMatchObject({
      errcode: 'M_TOO_LARGE',
      status: 413,
    });
    expect(db._state.events).toHaveLength(0);
    expect(db._state.streamPosition).toBe(7);
  });

  it('storeEvent hard-cap reject also leaves stream position untouched', async () => {
    const db = createCrudDb({ streamPosition: 3 });
    const event = pdu({
      event_id: '$hard2',
      type: 'm.room.message',
      content: { body: 'ok' },
    });
    event.auth_events = Array.from({ length: 40_000 }, (_, i) => `$auth-${i}:example.com`);
    await expect(storeEvent(db, event)).rejects.toMatchObject({ errcode: 'M_TOO_LARGE' });
    expect(db._state.streamPosition).toBe(3);
  });

  it('getRoomEvents backwards fromToken with no matches returns end=fromToken', async () => {
    const db = createCrudDb({
      events: [eventRowFromPdu(pdu({ event_id: '$e1', type: 'm.room.message' }), 1)],
    });
    // Cursor below every stream_ordering → empty page; end falls back to fromToken
    await expect(getRoomEvents(db, ROOM, 1, 10, 'b')).resolves.toEqual({
      events: [],
      end: 1,
    });
  });

  it('getRoomEvents forwards fromToken past the tip returns end=fromToken', async () => {
    const db = createCrudDb({
      events: [eventRowFromPdu(pdu({ event_id: '$e1', type: 'm.room.message' }), 5)],
    });
    await expect(getRoomEvents(db, ROOM, 5, 10, 'f')).resolves.toEqual({
      events: [],
      end: 5,
    });
  });

  it('storeEvent replaces room_state for the same type+state_key', async () => {
    const db = createCrudDb();
    await storeEvent(
      db,
      pdu({
        event_id: '$name1',
        type: 'm.room.name',
        state_key: '',
        content: { name: 'Old' },
      })
    );
    await storeEvent(
      db,
      pdu({
        event_id: '$name2',
        type: 'm.room.name',
        state_key: '',
        content: { name: 'New' },
      })
    );
    expect(db._state.roomState.get(`${ROOM}\0m.room.name\0`)).toBe('$name2');
    const state = await getRoomState(db, ROOM);
    expect(state).toHaveLength(1);
    expect(state[0].event_id).toBe('$name2');
    expect(state[0].content).toEqual({ name: 'New' });
  });

  it('getEvent round-trips hashes/signatures/unsigned after storeEvent', async () => {
    const db = createCrudDb();
    const event = pdu({
      event_id: '$rt',
      type: 'm.room.message',
      content: { body: 'hi' },
      unsigned: { age: 42 },
      hashes: { sha256: 'abc' },
      signatures: { 'example.com': { 'ed25519:1': 'sig' } },
    });
    await storeEvent(db, event);
    await expect(getEvent(db, '$rt')).resolves.toMatchObject({
      event_id: '$rt',
      content: { body: 'hi' },
      unsigned: { age: 42 },
      hashes: { sha256: 'abc' },
      signatures: { 'example.com': { 'ed25519:1': 'sig' } },
    });
  });

  it('getEventsByIds with an all-missing page returns []', async () => {
    const db = createCrudDb({
      events: [eventRowFromPdu(pdu({ event_id: '$only', type: 'm.room.message' }), 1)],
    });
    await expect(getEventsByIds(db, ['$nope1', '$nope2'])).resolves.toEqual([]);
  });

  it('getEventsSince at the tip returns [] without touching earlier events', async () => {
    const db = createCrudDb({
      events: [
        eventRowFromPdu(pdu({ event_id: '$a', type: 'm.room.message' }), 1),
        eventRowFromPdu(pdu({ event_id: '$b', type: 'm.room.message' }), 2),
      ],
    });
    await expect(getEventsSince(db, ROOM, 2)).resolves.toEqual([]);
    await expect(getEventsSince(db, ROOM, 1)).resolves.toMatchObject([{ event_id: '$b' }]);
  });

  it('getRoomMembers without filter returns invite+join with undefined profile fields', async () => {
    const db = createCrudDb({
      memberships: [
        {
          room_id: ROOM,
          user_id: USER,
          membership: 'join',
          event_id: '$1',
          display_name: null,
          avatar_url: null,
        },
        {
          room_id: ROOM,
          user_id: BOB,
          membership: 'invite',
          event_id: '$2',
          display_name: null,
          avatar_url: null,
        },
      ],
    });
    const members = await getRoomMembers(db, ROOM);
    expect(members).toHaveLength(2);
    expect(members.find((m) => m.userId === USER)).toEqual({
      userId: USER,
      membership: 'join',
      displayName: undefined,
      avatarUrl: undefined,
    });
    expect(members.find((m) => m.userId === BOB)?.membership).toBe('invite');
  });

  it('deleteDevice removes only the targeted device row', async () => {
    const db = createCrudDb({
      devices: [
        {
          user_id: USER,
          device_id: 'A',
          display_name: null,
          last_seen_ts: null,
          last_seen_ip: null,
          created_at: NOW,
        },
        {
          user_id: USER,
          device_id: 'B',
          display_name: null,
          last_seen_ts: null,
          last_seen_ip: null,
          created_at: NOW,
        },
      ],
    });
    await deleteDevice(db, USER, 'A');
    expect(db._state.devices.map((d) => d.device_id)).toEqual(['B']);
    await expect(getDevice(db, USER, 'A')).resolves.toBeNull();
    await expect(getDevice(db, USER, 'B')).resolves.toMatchObject({ device_id: 'B' });
  });

  it('createUser non-guest stores password_hash and is_guest=0', async () => {
    const db = createCrudDb();
    await createUser(db, USER, 'alice', 'pbkdf2-hash', false);
    expect(db._state.users[0]).toMatchObject({
      user_id: USER,
      localpart: 'alice',
      password_hash: 'pbkdf2-hash',
      is_guest: 0,
      created_at: NOW,
      updated_at: NOW,
    });
    await expect(getPasswordHash(db, USER)).resolves.toBe('pbkdf2-hash');
  });

  it('storeEventIdempotent duplicate does not rewrite room_state for a state event', async () => {
    const db = createCrudDb();
    const event = pdu({
      event_id: '$topic',
      type: 'm.room.topic',
      state_key: '',
      content: { topic: 'hello' },
    });
    await expect(storeEventIdempotent(db, event)).resolves.toEqual({
      inserted: true,
      streamOrdering: 1,
    });
    expect(db._state.roomState.get(`${ROOM}\0m.room.topic\0`)).toBe('$topic');
    // Corrupt room_state pointer; a duplicate insert must not REPLACE it
    db._state.roomState.set(`${ROOM}\0m.room.topic\0`, '$stale');
    await expect(storeEventIdempotent(db, event)).resolves.toEqual({
      inserted: false,
      streamOrdering: null,
    });
    expect(db._state.roomState.get(`${ROOM}\0m.room.topic\0`)).toBe('$stale');
    expect(db._state.events.filter((e) => e.event_id === '$topic')).toHaveLength(1);
  });

  it('updateUserProfile can update display_name alone without touching avatar_url', async () => {
    const db = createCrudDb({
      users: [
        {
          user_id: USER,
          localpart: 'alice',
          password_hash: 'h',
          display_name: 'Old',
          avatar_url: 'mxc://example.com/keep',
          is_guest: 0,
          is_deactivated: 0,
          admin: 0,
          created_at: NOW,
          updated_at: NOW,
        },
      ],
    });
    await updateUserProfile(db, USER, 'New');
    expect(db._state.users[0].display_name).toBe('New');
    expect(db._state.users[0].avatar_url).toBe('mxc://example.com/keep');
    expect(db._state.runs.filter((r) => r.sql.includes('display_name'))).toHaveLength(1);
    expect(db._state.runs.filter((r) => r.sql.includes('avatar_url'))).toHaveLength(0);
  });
});

describe('database CRUD TOKENMAXX residual leftovers after #264', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('concurrent soft-cap reject + successful storeEvent: reject leaves sibling stream intact', async () => {
    const db = createCrudDb({ streamPosition: 4 });
    const huge = pdu({
      event_id: '$huge-race',
      type: 'm.room.message',
      content: { body: 'x'.repeat(70_000) },
    });
    const ok = pdu({
      event_id: '$ok-race',
      type: 'm.room.message',
      content: { body: 'hi' },
    });
    const [rej, win] = await Promise.allSettled([storeEvent(db, huge), storeEvent(db, ok)]);
    expect(rej.status).toBe('rejected');
    if (rej.status === 'rejected') {
      expect(rej.reason).toMatchObject({ errcode: 'M_TOO_LARGE', status: 413 });
      expect((rej.reason as MatrixApiError).message).toMatch(/content exceeds/);
    }
    expect(win.status).toBe('fulfilled');
    if (win.status === 'fulfilled') {
      expect(win.value).toBe(5);
    }
    expect(db._state.events.map((e) => e.event_id)).toEqual(['$ok-race']);
    expect(db._state.streamPosition).toBe(5);
  });

  it('tryInsertJoinMembership concurrent invite→join upgrades collapse to one join', async () => {
    const db = createCrudDb({
      memberships: [
        {
          room_id: ROOM,
          user_id: USER,
          membership: 'invite',
          event_id: '$inv',
          display_name: null,
          avatar_url: null,
        },
      ],
    });
    const [a, b] = await Promise.all([
      tryInsertJoinMembership(db, ROOM, USER, '$join-a', 'A'),
      tryInsertJoinMembership(db, ROOM, USER, '$join-b', 'B'),
    ]);
    expect(db._state.memberships).toHaveLength(1);
    expect(db._state.memberships[0].membership).toBe('join');
    const winners = [a, b].filter((r) => r.inserted);
    const losers = [a, b].filter((r) => !r.inserted);
    // First upgrade wins; second sees join and keeps the winner's event_id
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].eventId).toBe(winners[0].eventId);
    expect(db._state.memberships[0].event_id).toBe(winners[0].eventId);
  });

  it('concurrent updateMembership last-writer-wins on the same user row', async () => {
    const db = createCrudDb();
    await Promise.all([
      updateMembership(db, ROOM, USER, 'invite', '$inv', 'Inv'),
      updateMembership(db, ROOM, USER, 'join', '$join', 'Join', 'mxc://a'),
    ]);
    expect(db._state.memberships).toHaveLength(1);
    expect(['invite', 'join']).toContain(db._state.memberships[0].membership);
    expect(['$inv', '$join']).toContain(db._state.memberships[0].event_id);
  });

  it('concurrent createRoomAlias for distinct aliases both persist', async () => {
    const db = createCrudDb();
    await Promise.all([
      createRoomAlias(db, '#a:example.com', ROOM, USER),
      createRoomAlias(db, '#b:example.com', ROOM, BOB),
    ]);
    expect(db._state.aliases).toHaveLength(2);
    await expect(getRoomByAlias(db, '#a:example.com')).resolves.toBe(ROOM);
    await expect(getRoomByAlias(db, '#b:example.com')).resolves.toBe(ROOM);
  });

  it('concurrent storeEventIdempotent on distinct event_ids both insert with unique streams', async () => {
    const db = createCrudDb();
    const [a, b] = await Promise.all([
      storeEventIdempotent(
        db,
        pdu({ event_id: '$ida', type: 'm.room.message', content: { body: 'a' } })
      ),
      storeEventIdempotent(
        db,
        pdu({ event_id: '$idb', type: 'm.room.message', content: { body: 'b' } })
      ),
    ]);
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(true);
    expect(a.streamOrdering).not.toBe(b.streamOrdering);
    expect(new Set([a.streamOrdering, b.streamOrdering])).toEqual(new Set([1, 2]));
    expect(db._state.events).toHaveLength(2);
  });

  it('concurrent getRoomEvents + storeEvent sees a coherent end stream', async () => {
    const db = createCrudDb({
      events: [eventRowFromPdu(pdu({ event_id: '$e0', type: 'm.room.message' }), 1)],
      streamPosition: 1,
    });
    const [, page] = await Promise.all([
      storeEvent(db, pdu({ event_id: '$e1', type: 'm.room.message', content: { body: 'n' } })),
      getRoomEvents(db, ROOM, undefined, 10, 'f'),
    ]);
    // Page may or may not include the mid-flight insert; end must be a known stream id
    expect([0, 1, 2]).toContain(page.end);
    expect(db._state.events.map((e) => e.event_id).sort()).toEqual(['$e0', '$e1']);
    expect(db._state.streamPosition).toBe(2);
  });

  it('hard-cap reject under Promise.allSettled does not allocate a stream id', async () => {
    const db = createCrudDb({ streamPosition: 9 });
    const hard = pdu({
      event_id: '$hard-race',
      type: 'm.room.message',
      content: { body: 'ok' },
    });
    hard.auth_events = Array.from({ length: 40_000 }, (_, i) => `$auth-${i}:example.com`);
    const [rej] = await Promise.allSettled([storeEvent(db, hard)]);
    expect(rej.status).toBe('rejected');
    if (rej.status === 'rejected') {
      expect(rej.reason).toMatchObject({ errcode: 'M_TOO_LARGE' });
      expect((rej.reason as MatrixApiError).message).toMatch(/D1 row limit/);
    }
    expect(db._state.events).toHaveLength(0);
    expect(db._state.streamPosition).toBe(9);
  });
});

describe('database CRUD TOKENMAXX residual leftovers after #272', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('concurrent hard-cap reject + successful storeEvent: reject leaves sibling stream intact', async () => {
    const db = createCrudDb({ streamPosition: 6 });
    const hard = pdu({
      event_id: '$hard-sib',
      type: 'm.room.message',
      content: { body: 'ok' },
    });
    hard.auth_events = Array.from({ length: 40_000 }, (_, i) => `$auth-${i}:example.com`);
    const ok = pdu({
      event_id: '$ok-sib',
      type: 'm.room.message',
      content: { body: 'n' },
    });
    const [rej, win] = await Promise.allSettled([storeEvent(db, hard), storeEvent(db, ok)]);
    expect(rej.status).toBe('rejected');
    if (rej.status === 'rejected') {
      expect(rej.reason).toMatchObject({ errcode: 'M_TOO_LARGE' });
      expect((rej.reason as MatrixApiError).message).toMatch(/D1 row limit/);
    }
    expect(win.status).toBe('fulfilled');
    if (win.status === 'fulfilled') {
      expect(win.value).toBe(7);
    }
    expect(db._state.events.map((e) => e.event_id)).toEqual(['$ok-sib']);
    expect(db._state.streamPosition).toBe(7);
  });

  it('storeEventIdempotent oversized inserts under race while storeEvent(huge) rejects', async () => {
    const db = createCrudDb({ streamPosition: 2 });
    const huge = pdu({
      event_id: '$huge-idem',
      type: 'm.room.message',
      content: { body: 'x'.repeat(70_000) },
    });
    const ok = pdu({
      event_id: '$ok-idem-race',
      type: 'm.room.message',
      content: { body: 'ok' },
    });
    const [idem, storeOk, storeHuge] = await Promise.allSettled([
      storeEventIdempotent(db, huge),
      storeEvent(db, ok),
      storeEvent(db, { ...huge, event_id: '$huge-store' }),
    ]);
    expect(idem.status).toBe('fulfilled');
    if (idem.status === 'fulfilled') {
      expect(idem.value.inserted).toBe(true);
      expect(idem.value.streamOrdering).not.toBeNull();
    }
    expect(storeOk.status).toBe('fulfilled');
    expect(storeHuge.status).toBe('rejected');
    if (storeHuge.status === 'rejected') {
      expect(storeHuge.reason).toMatchObject({ errcode: 'M_TOO_LARGE' });
    }
    const ids = db._state.events.map((e) => e.event_id).sort();
    expect(ids).toEqual(['$huge-idem', '$ok-idem-race'].sort());
    expect(ids).not.toContain('$huge-store');
  });

  it('tryInsertJoinMembership concurrent leave→join upgrades collapse to one join', async () => {
    const db = createCrudDb({
      memberships: [
        {
          room_id: ROOM,
          user_id: USER,
          membership: 'leave',
          event_id: '$left',
          display_name: 'Gone',
          avatar_url: null,
        },
      ],
    });
    const [a, b] = await Promise.all([
      tryInsertJoinMembership(db, ROOM, USER, '$join-leave-a', 'A'),
      tryInsertJoinMembership(db, ROOM, USER, '$join-leave-b', 'B'),
    ]);
    expect(db._state.memberships).toHaveLength(1);
    expect(db._state.memberships[0].membership).toBe('join');
    const winners = [a, b].filter((r) => r.inserted);
    const losers = [a, b].filter((r) => !r.inserted);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].eventId).toBe(winners[0].eventId);
    expect(db._state.memberships[0].event_id).toBe(winners[0].eventId);
  });

  it('tryInsertJoinMembership concurrent ban→join upgrades collapse to one join', async () => {
    const db = createCrudDb({
      memberships: [
        {
          room_id: ROOM,
          user_id: USER,
          membership: 'ban',
          event_id: '$banned',
          display_name: null,
          avatar_url: null,
        },
      ],
    });
    const [a, b] = await Promise.all([
      tryInsertJoinMembership(db, ROOM, USER, '$join-ban-a', 'A'),
      tryInsertJoinMembership(db, ROOM, USER, '$join-ban-b', 'B'),
    ]);
    expect(db._state.memberships).toHaveLength(1);
    expect(db._state.memberships[0].membership).toBe('join');
    const winners = [a, b].filter((r) => r.inserted);
    expect(winners).toHaveLength(1);
    expect(db._state.memberships[0].event_id).toBe(winners[0].eventId);
  });

  it('concurrent getLatestStreamPosition + storeEvent stays coherent', async () => {
    const db = createCrudDb({
      events: [eventRowFromPdu(pdu({ event_id: '$e0', type: 'm.room.message' }), 3)],
      streamPosition: 3,
    });
    const [tip, stream] = await Promise.all([
      getLatestStreamPosition(db),
      storeEvent(db, pdu({ event_id: '$e1', type: 'm.room.message', content: { body: 'n' } })),
    ]);
    expect([3, 4]).toContain(tip);
    expect(stream).toBe(4);
    expect(db._state.streamPosition).toBe(4);
    expect(db._state.events.map((e) => e.event_id).sort()).toEqual(['$e0', '$e1']);
  });

  it('concurrent getRoomState / getStateEvent + state storeEvent sees old or new only', async () => {
    const old = pdu({
      event_id: '$old-name',
      type: 'm.room.name',
      state_key: '',
      content: { name: 'Old' },
    });
    const db = createCrudDb({
      events: [eventRowFromPdu(old, 1)],
      roomState: [{ room_id: ROOM, event_type: 'm.room.name', state_key: '', event_id: '$old-name' }],
      streamPosition: 1,
    });
    const neu = pdu({
      event_id: '$new-name',
      type: 'm.room.name',
      state_key: '',
      content: { name: 'New' },
    });
    const [, state, single] = await Promise.all([
      storeEvent(db, neu),
      getRoomState(db, ROOM),
      getStateEvent(db, ROOM, 'm.room.name', ''),
    ]);
    const nameIds = state
      .filter((e) => e.type === 'm.room.name')
      .map((e) => e.event_id);
    expect(nameIds).toHaveLength(1);
    expect(['$old-name', '$new-name']).toContain(nameIds[0]);
    expect(single === null || ['$old-name', '$new-name'].includes(single.event_id)).toBe(true);
    // Final writer must win room_state
    const final = await getStateEvent(db, ROOM, 'm.room.name', '');
    expect(final?.event_id).toBe('$new-name');
  });

  it('concurrent getEventsByIds overlapping pages stay isolated', async () => {
    const rows = Array.from({ length: 150 }, (_, i) =>
      eventRowFromPdu(
        pdu({ event_id: `$e${i}`, type: 'm.room.message', content: { body: String(i) } }),
        i + 1
      )
    );
    const db = createCrudDb({ events: rows, streamPosition: 150 });
    const allIds = rows.map((r) => r.event_id);
    const subset = allIds.slice(0, 50);
    const missing = Array.from({ length: 30 }, (_, i) => `$missing-${i}`);
    const [full, part, none] = await Promise.all([
      getEventsByIds(db, allIds),
      getEventsByIds(db, subset),
      getEventsByIds(db, missing),
    ]);
    expect(full).toHaveLength(150);
    expect(part).toHaveLength(50);
    expect(none).toEqual([]);
    expect(new Set(full.map((e) => e.event_id)).size).toBe(150);
    expect(part.map((e) => e.event_id).sort()).toEqual([...subset].sort());
    expect(db._state.events).toHaveLength(150);
  });

  it('deleteAllUserTokens ∥ createAccessToken ∥ getUserByTokenHash stay coherent', async () => {
    const db = createCrudDb({
      tokens: [
        {
          token_id: 't1',
          token_hash: 'hash-old',
          user_id: USER,
          device_id: 'DEV',
          created_at: NOW,
        },
      ],
    });
    const [del, created, lookup] = await Promise.all([
      deleteAllUserTokens(db, USER),
      createAccessToken(db, 'tid-new', 'hash-new', USER, 'DEV2'),
      getUserByTokenHash(db, 'hash-old'),
    ]);
    expect(del).toBeUndefined();
    expect(created).toBeUndefined();
    // Mid-flight lookup may see the old row or miss after delete
    if (lookup !== null) {
      expect(lookup).toMatchObject({ userId: USER, deviceId: 'DEV' });
    }
    const remaining = db._state.tokens.filter((t) => t.user_id === USER);
    // delete-all then create → [hash-new]; create then delete-all → [] (new wiped too).
    // hash-old must never survive both completing.
    expect(remaining.every((t) => t.token_hash === 'hash-new')).toBe(true);
    expect(remaining.length).toBeLessThanOrEqual(1);
  });

  it('concurrent getRoomEvents forwards and backwards stay independently correct', async () => {
    const rows = [1, 2, 3, 4, 5].map((n) =>
      eventRowFromPdu(pdu({ event_id: `$e${n}`, type: 'm.room.message' }), n)
    );
    const db = createCrudDb({ events: rows, streamPosition: 5 });
    const [fwd, back] = await Promise.all([
      getRoomEvents(db, ROOM, undefined, 10, 'f'),
      getRoomEvents(db, ROOM, undefined, 10, 'b'),
    ]);
    expect(fwd.events.map((e) => e.event_id)).toEqual(['$e1', '$e2', '$e3', '$e4', '$e5']);
    expect(back.events.map((e) => e.event_id)).toEqual(['$e5', '$e4', '$e3', '$e2', '$e1']);
    expect(fwd.end).toBe(5);
    expect(back.end).toBe(1);
  });
});

describe('database CRUD TOKENMAXX residual second-wave leftovers after #282', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tryInsertJoinMembership concurrent knock→join upgrades collapse to one join', async () => {
    const db = createCrudDb({
      memberships: [
        {
          room_id: ROOM,
          user_id: USER,
          membership: 'knock',
          event_id: '$knocked',
          display_name: 'Knocker',
          avatar_url: null,
        },
      ],
    });
    const [a, b] = await Promise.all([
      tryInsertJoinMembership(db, ROOM, USER, '$join-knock-a', 'A'),
      tryInsertJoinMembership(db, ROOM, USER, '$join-knock-b', 'B'),
    ]);
    expect(db._state.memberships).toHaveLength(1);
    expect(db._state.memberships[0].membership).toBe('join');
    const winners = [a, b].filter((r) => r.inserted);
    const losers = [a, b].filter((r) => !r.inserted);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].eventId).toBe(winners[0].eventId);
    expect(db._state.memberships[0].event_id).toBe(winners[0].eventId);
  });

  it('concurrent getEventsSince + storeEvent: since page sees old tip or new only', async () => {
    const seed = pdu({ event_id: '$seed', type: 'm.room.message', content: { body: 's' } });
    const db = createCrudDb({
      events: [eventRowFromPdu(seed, 4)],
      streamPosition: 4,
    });
    const neu = pdu({ event_id: '$neu', type: 'm.room.message', content: { body: 'n' } });
    const [page, stream] = await Promise.all([getEventsSince(db, ROOM, 4, 10), storeEvent(db, neu)]);
    expect(stream).toBe(5);
    expect(db._state.streamPosition).toBe(5);
    // Mid-flight page may miss the concurrent insert (since > 4 empty) or catch it
    expect(page.every((e) => e.event_id === '$neu')).toBe(true);
    expect(page.length).toBeLessThanOrEqual(1);
    const after = await getEventsSince(db, ROOM, 4, 10);
    expect(after.map((e) => e.event_id)).toEqual(['$neu']);
  });

  it('concurrent same-alias createRoomAlias both persist under harness (no UNIQUE)', async () => {
    const db = createCrudDb();
    await Promise.all([
      createRoomAlias(db, '#same:example.com', ROOM, USER),
      createRoomAlias(db, '#same:example.com', ROOM, BOB),
    ]);
    // In-memory stand-in does not enforce UNIQUE(alias) — both inserts land
    expect(db._state.aliases.filter((a) => a.alias === '#same:example.com')).toHaveLength(2);
    expect(new Set(db._state.aliases.map((a) => a.creator_id))).toEqual(new Set([USER, BOB]));
    await expect(getRoomByAlias(db, '#same:example.com')).resolves.toBe(ROOM);
  });

  it('storeEventIdempotent hard-cap oversized inserts under race while storeEvent rejects', async () => {
    const db = createCrudDb({ streamPosition: 1 });
    const hard = pdu({
      event_id: '$hard-idem',
      type: 'm.room.message',
      content: { body: 'ok' },
    });
    hard.auth_events = Array.from({ length: 40_000 }, (_, i) => `$auth-${i}:example.com`);
    expect(JSON.stringify(hard.content).length).toBeLessThanOrEqual(65_536);
    expect(JSON.stringify(hard).length).toBeGreaterThan(921_600);
    const ok = pdu({
      event_id: '$ok-hard-race',
      type: 'm.room.message',
      content: { body: 'ok' },
    });
    const [idem, storeOk, storeHard] = await Promise.allSettled([
      storeEventIdempotent(db, hard),
      storeEvent(db, ok),
      storeEvent(db, { ...hard, event_id: '$hard-store' }),
    ]);
    expect(idem.status).toBe('fulfilled');
    if (idem.status === 'fulfilled') {
      expect(idem.value.inserted).toBe(true);
      expect(idem.value.streamOrdering).not.toBeNull();
    }
    expect(storeOk.status).toBe('fulfilled');
    expect(storeHard.status).toBe('rejected');
    if (storeHard.status === 'rejected') {
      expect(storeHard.reason).toMatchObject({ errcode: 'M_TOO_LARGE' });
      expect((storeHard.reason as MatrixApiError).message).toMatch(/D1 row limit/);
    }
    const ids = db._state.events.map((e) => e.event_id).sort();
    expect(ids).toEqual(['$hard-idem', '$ok-hard-race'].sort());
    expect(ids).not.toContain('$hard-store');
  });
});

describe('database CRUD TOKENMAXX residual tertiary leftovers after #290', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('deleteRoomAlias ∥ createRoomAlias same alias collapses to create-wins or empty', async () => {
    const db = createCrudDb({
      aliases: [
        {
          alias: '#race:example.com',
          room_id: ROOM,
          creator_id: USER,
          created_at: NOW,
        },
      ],
    });
    await Promise.all([
      deleteRoomAlias(db, '#race:example.com'),
      createRoomAlias(db, '#race:example.com', ROOM, BOB),
    ]);
    // Interleaving: delete-then-create → one BOB row; create-then-delete → empty (delete removes both).
    const remaining = db._state.aliases.filter((a) => a.alias === '#race:example.com');
    expect(remaining.length).toBeLessThanOrEqual(1);
    if (remaining.length === 1) {
      expect(remaining[0]).toMatchObject({ room_id: ROOM, creator_id: BOB });
    }
    const looked = await getRoomByAlias(db, '#race:example.com');
    expect(looked === null || looked === ROOM).toBe(true);
  });

  it('getUserRooms ∥ updateMembership: join filter sees old invite or new join only', async () => {
    const db = createCrudDb({
      memberships: [
        {
          room_id: ROOM,
          user_id: USER,
          membership: 'invite',
          event_id: '$inv',
          display_name: null,
          avatar_url: null,
        },
      ],
    });
    const [rooms] = await Promise.all([
      getUserRooms(db, USER, 'join'),
      updateMembership(db, ROOM, USER, 'join', '$join'),
    ]);
    expect(rooms.length).toBeLessThanOrEqual(1);
    expect(rooms.every((r) => r === ROOM)).toBe(true);
    await expect(getUserRooms(db, USER, 'join')).resolves.toEqual([ROOM]);
    await expect(getMembership(db, ROOM, USER)).resolves.toEqual({
      membership: 'join',
      eventId: '$join',
    });
  });

  it('getRoomMembers ∥ tryInsertJoinMembership: page sees invite or upgraded join', async () => {
    const db = createCrudDb({
      memberships: [
        {
          room_id: ROOM,
          user_id: USER,
          membership: 'invite',
          event_id: '$inv',
          display_name: 'Alice',
          avatar_url: null,
        },
      ],
    });
    const [members, upgrade] = await Promise.all([
      getRoomMembers(db, ROOM),
      tryInsertJoinMembership(db, ROOM, USER, '$join-up', 'Alice'),
    ]);
    expect(upgrade.inserted).toBe(true);
    expect(upgrade.eventId).toBe('$join-up');
    expect(members).toHaveLength(1);
    expect(members[0].userId).toBe(USER);
    expect(['invite', 'join']).toContain(members[0].membership);
    const after = await getRoomMembers(db, ROOM, 'join');
    expect(after).toEqual([
      { userId: USER, membership: 'join', displayName: 'Alice', avatarUrl: undefined },
    ]);
  });

  it('storeEventIdempotent soft-oversized inserts under race while storeEvent soft-rejects', async () => {
    const db = createCrudDb({ streamPosition: 1 });
    const soft = pdu({
      event_id: '$soft-idem',
      type: 'm.room.message',
      content: { body: 'x'.repeat(70_000) },
    });
    expect(JSON.stringify(soft.content).length).toBeGreaterThan(65_536);
    const ok = pdu({
      event_id: '$ok-soft-race',
      type: 'm.room.message',
      content: { body: 'ok' },
    });
    const [idem, storeOk, storeSoft] = await Promise.allSettled([
      storeEventIdempotent(db, soft),
      storeEvent(db, ok),
      storeEvent(db, { ...soft, event_id: '$soft-store' }),
    ]);
    expect(idem.status).toBe('fulfilled');
    if (idem.status === 'fulfilled') {
      expect(idem.value.inserted).toBe(true);
      expect(idem.value.streamOrdering).not.toBeNull();
    }
    expect(storeOk.status).toBe('fulfilled');
    expect(storeSoft.status).toBe('rejected');
    if (storeSoft.status === 'rejected') {
      expect(storeSoft.reason).toMatchObject({ errcode: 'M_TOO_LARGE' });
      expect((storeSoft.reason as MatrixApiError).message).toMatch(/content exceeds/);
    }
    const ids = db._state.events.map((e) => e.event_id).sort();
    expect(ids).toEqual(['$ok-soft-race', '$soft-idem'].sort());
    expect(ids).not.toContain('$soft-store');
  });

  it('getDevice ∥ deleteDevice: read sees device or null; sibling device untouched', async () => {
    const db = createCrudDb({
      devices: [
        {
          user_id: USER,
          device_id: 'DEV1',
          display_name: 'Phone',
          last_seen_ts: null,
          last_seen_ip: null,
          created_at: NOW,
        },
        {
          user_id: USER,
          device_id: 'DEV2',
          display_name: 'Laptop',
          last_seen_ts: null,
          last_seen_ip: null,
          created_at: NOW,
        },
      ],
    });
    const [got] = await Promise.all([getDevice(db, USER, 'DEV1'), deleteDevice(db, USER, 'DEV1')]);
    expect(got === null || got?.device_id === 'DEV1').toBe(true);
    await expect(getDevice(db, USER, 'DEV1')).resolves.toBeNull();
    await expect(getDevice(db, USER, 'DEV2')).resolves.toMatchObject({
      device_id: 'DEV2',
      display_name: 'Laptop',
    });
  });

  it('getPasswordHash ∥ createUser sibling: lookup stays isolated from insert', async () => {
    const db = createCrudDb({
      users: [
        {
          user_id: USER,
          localpart: 'alice',
          password_hash: 'pbkdf2-existing',
          display_name: null,
          avatar_url: null,
          is_guest: 0,
          is_deactivated: 0,
          admin: 0,
          created_at: NOW,
          updated_at: NOW,
        },
      ],
    });
    const [hash] = await Promise.all([
      getPasswordHash(db, USER),
      createUser(db, BOB, 'bob', 'pbkdf2-bob', false),
    ]);
    expect(hash).toBe('pbkdf2-existing');
    await expect(getPasswordHash(db, BOB)).resolves.toBe('pbkdf2-bob');
    await expect(getPasswordHash(db, USER)).resolves.toBe('pbkdf2-existing');
  });
});

describe('database CRUD TOKENMAXX residual quaternary leftovers after #310', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getUserById ∥ updateUserProfile: read sees old or new display_name only', async () => {
    const db = createCrudDb({
      users: [
        {
          user_id: USER,
          localpart: 'alice',
          password_hash: 'h',
          display_name: 'Old',
          avatar_url: 'mxc://example.com/a',
          is_guest: 0,
          is_deactivated: 0,
          admin: 0,
          created_at: NOW,
          updated_at: NOW,
        },
      ],
    });
    const [got] = await Promise.all([
      getUserById(db, USER),
      updateUserProfile(db, USER, 'New'),
    ]);
    expect(got).not.toBeNull();
    expect(['Old', 'New']).toContain(got!.display_name);
    expect(got!.avatar_url).toBe('mxc://example.com/a');
    await expect(getUserById(db, USER)).resolves.toMatchObject({
      display_name: 'New',
      avatar_url: 'mxc://example.com/a',
    });
  });

  it('getUserDevices ∥ deleteDevice: page sees deleted device or not; sibling untouched', async () => {
    const db = createCrudDb({
      devices: [
        {
          user_id: USER,
          device_id: 'DEV1',
          display_name: 'Phone',
          last_seen_ts: null,
          last_seen_ip: null,
          created_at: NOW,
        },
        {
          user_id: USER,
          device_id: 'DEV2',
          display_name: 'Laptop',
          last_seen_ts: null,
          last_seen_ip: null,
          created_at: NOW,
        },
      ],
    });
    const [devices] = await Promise.all([
      getUserDevices(db, USER),
      deleteDevice(db, USER, 'DEV1'),
    ]);
    expect(devices.length).toBeGreaterThanOrEqual(1);
    expect(devices.length).toBeLessThanOrEqual(2);
    expect(devices.every((d) => d.user_id === USER)).toBe(true);
    expect(devices.some((d) => d.device_id === 'DEV2')).toBe(true);
    await expect(getDevice(db, USER, 'DEV1')).resolves.toBeNull();
    await expect(getUserDevices(db, USER)).resolves.toEqual([
      {
        user_id: USER,
        device_id: 'DEV2',
        display_name: 'Laptop',
        last_seen_ts: undefined,
        last_seen_ip: undefined,
      },
    ]);
  });

  it('getRoom ∥ createRoom sibling: lookup stays isolated from insert', async () => {
    const other = '!other:example.com';
    const db = createCrudDb({
      rooms: [
        {
          room_id: ROOM,
          room_version: '10',
          creator_id: USER,
          is_public: 0,
          created_at: NOW,
        },
      ],
    });
    const [got] = await Promise.all([
      getRoom(db, ROOM),
      createRoom(db, other, '11', BOB, true),
    ]);
    expect(got).toEqual({
      room_id: ROOM,
      room_version: '10',
      creator_id: USER,
      is_public: false,
      created_at: NOW,
    });
    await expect(getRoom(db, other)).resolves.toEqual({
      room_id: other,
      room_version: '11',
      creator_id: BOB,
      is_public: true,
      created_at: NOW,
    });
  });

  it('getEvent ∥ storeEventIdempotent same id: read sees null or event; insert collapses', async () => {
    const event = pdu({
      event_id: '$race-idem',
      type: 'm.room.message',
      content: { body: 'hi' },
    });
    const db = createCrudDb({ streamPosition: 2 });
    const [got, idem] = await Promise.all([
      getEvent(db, '$race-idem'),
      storeEventIdempotent(db, event),
    ]);
    expect(got === null || got.event_id === '$race-idem').toBe(true);
    expect(idem.inserted).toBe(true);
    expect(idem.streamOrdering).not.toBeNull();
    await expect(getEvent(db, '$race-idem')).resolves.toMatchObject({
      event_id: '$race-idem',
      content: { body: 'hi' },
    });
    const again = await storeEventIdempotent(db, event);
    expect(again.inserted).toBe(false);
    expect(db._state.events.filter((e) => e.event_id === '$race-idem')).toHaveLength(1);
  });

  it('getMembership ∥ updateMembership invite→ban: read sees invite or ban only', async () => {
    const db = createCrudDb({
      memberships: [
        {
          room_id: ROOM,
          user_id: USER,
          membership: 'invite',
          event_id: '$inv',
          display_name: null,
          avatar_url: null,
        },
      ],
    });
    const [got] = await Promise.all([
      getMembership(db, ROOM, USER),
      updateMembership(db, ROOM, USER, 'ban', '$ban'),
    ]);
    expect(got).not.toBeNull();
    expect(['invite', 'ban']).toContain(got!.membership);
    expect(['$inv', '$ban']).toContain(got!.eventId);
    await expect(getMembership(db, ROOM, USER)).resolves.toEqual({
      membership: 'ban',
      eventId: '$ban',
    });
  });

  it('getRoomByAlias ∥ deleteRoomAlias: read sees room or null under race', async () => {
    const db = createCrudDb({
      aliases: [
        {
          alias: '#gone:example.com',
          room_id: ROOM,
          creator_id: USER,
          created_at: NOW,
        },
      ],
    });
    const [got] = await Promise.all([
      getRoomByAlias(db, '#gone:example.com'),
      deleteRoomAlias(db, '#gone:example.com'),
    ]);
    expect(got === null || got === ROOM).toBe(true);
    await expect(getRoomByAlias(db, '#gone:example.com')).resolves.toBeNull();
  });

  it('deleteAccessToken ∥ createAccessToken same hash: final lookup coherent', async () => {
    const db = createCrudDb({
      tokens: [
        {
          token_id: 'tid-old',
          token_hash: 'hash-race',
          user_id: USER,
          device_id: 'DEV1',
          created_at: NOW,
        },
      ],
    });
    await Promise.all([
      deleteAccessToken(db, 'hash-race'),
      createAccessToken(db, 'tid-new', 'hash-race', USER, 'DEV2'),
    ]);
    const looked = await getUserByTokenHash(db, 'hash-race');
    // Interleaving: delete-then-create → DEV2; create-then-delete may wipe both or leave new.
    if (looked) {
      expect(looked).toEqual({ userId: USER, deviceId: 'DEV2' });
    } else {
      expect(db._state.tokens.filter((t) => t.token_hash === 'hash-race')).toHaveLength(0);
    }
  });

  it('getEventsByIds([]) ∥ getEventsByIds(page) stay isolated under race', async () => {
    const a = pdu({ event_id: '$a', type: 'm.room.message', content: { body: 'a' } });
    const b = pdu({ event_id: '$b', type: 'm.room.message', content: { body: 'b' } });
    const db = createCrudDb({
      events: [eventRowFromPdu(a, 1), eventRowFromPdu(b, 2)],
      streamPosition: 2,
    });
    const [empty, page, missing] = await Promise.all([
      getEventsByIds(db, []),
      getEventsByIds(db, ['$a', '$b']),
      getEventsByIds(db, ['$missing']),
    ]);
    expect(empty).toEqual([]);
    expect(page.map((e) => e.event_id).sort()).toEqual(['$a', '$b']);
    expect(missing).toEqual([]);
  });

  it('tryInsertJoinMembership already-join keeps event_id ∥ getMembership under race', async () => {
    const db = createCrudDb({
      memberships: [
        {
          room_id: ROOM,
          user_id: USER,
          membership: 'join',
          event_id: '$join-keep',
          display_name: 'Alice',
          avatar_url: null,
        },
      ],
    });
    const [upgrade, got] = await Promise.all([
      tryInsertJoinMembership(db, ROOM, USER, '$join-new', 'Alice'),
      getMembership(db, ROOM, USER),
    ]);
    expect(upgrade.inserted).toBe(false);
    expect(upgrade.eventId).toBe('$join-keep');
    expect(got).toEqual({ membership: 'join', eventId: '$join-keep' });
    expect(db._state.memberships).toHaveLength(1);
    expect(db._state.memberships[0].event_id).toBe('$join-keep');
  });
});

describe('database CRUD TOKENMAXX residual quinary leftovers after #319', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getUserByLocalpart ∥ createUser sibling: lookup stays isolated from insert', async () => {
    const db = createCrudDb({
      users: [
        {
          user_id: USER,
          localpart: 'alice',
          password_hash: 'h',
          display_name: 'Alice',
          avatar_url: null,
          is_guest: 0,
          is_deactivated: 0,
          admin: 0,
          created_at: NOW,
          updated_at: NOW,
        },
      ],
    });
    const [got] = await Promise.all([
      getUserByLocalpart(db, 'alice'),
      createUser(db, BOB, 'bob', 'pbkdf2-bob', false),
    ]);
    expect(got).toMatchObject({ user_id: USER, localpart: 'alice', display_name: 'Alice' });
    await expect(getUserByLocalpart(db, 'bob')).resolves.toMatchObject({
      user_id: BOB,
      localpart: 'bob',
    });
    await expect(getUserByLocalpart(db, 'alice')).resolves.toMatchObject({ user_id: USER });
  });

  it('getPasswordHash ∥ updateUserProfile: hash stays stable while profile mutates', async () => {
    const db = createCrudDb({
      users: [
        {
          user_id: USER,
          localpart: 'alice',
          password_hash: 'pbkdf2-stable',
          display_name: 'Old',
          avatar_url: 'mxc://example.com/old',
          is_guest: 0,
          is_deactivated: 0,
          admin: 0,
          created_at: NOW,
          updated_at: NOW,
        },
      ],
    });
    const [hash] = await Promise.all([
      getPasswordHash(db, USER),
      updateUserProfile(db, USER, 'New', 'mxc://example.com/new'),
    ]);
    expect(hash).toBe('pbkdf2-stable');
    await expect(getPasswordHash(db, USER)).resolves.toBe('pbkdf2-stable');
    await expect(getUserById(db, USER)).resolves.toMatchObject({
      display_name: 'New',
      avatar_url: 'mxc://example.com/new',
    });
  });

  it('createDevice ∥ getDevice: read sees null or device; sibling untouched', async () => {
    const db = createCrudDb({
      devices: [
        {
          user_id: USER,
          device_id: 'KEEP',
          display_name: 'Keep',
          last_seen_ts: null,
          last_seen_ip: null,
          created_at: NOW,
        },
      ],
    });
    const [got] = await Promise.all([
      getDevice(db, USER, 'NEW'),
      createDevice(db, USER, 'NEW', 'Phone'),
    ]);
    expect(got === null || got?.device_id === 'NEW').toBe(true);
    await expect(getDevice(db, USER, 'NEW')).resolves.toMatchObject({
      device_id: 'NEW',
      display_name: 'Phone',
    });
    await expect(getDevice(db, USER, 'KEEP')).resolves.toMatchObject({
      device_id: 'KEEP',
      display_name: 'Keep',
    });
  });

  it('deleteAllUserTokens ∥ sibling user token lookup stay isolated', async () => {
    const db = createCrudDb({
      tokens: [
        {
          token_id: 'tid-a',
          token_hash: 'hash-a',
          user_id: USER,
          device_id: 'DEV1',
          created_at: NOW,
        },
        {
          token_id: 'tid-b',
          token_hash: 'hash-b',
          user_id: BOB,
          device_id: 'DEV2',
          created_at: NOW,
        },
      ],
    });
    const [bobLookup] = await Promise.all([
      getUserByTokenHash(db, 'hash-b'),
      deleteAllUserTokens(db, USER),
    ]);
    expect(bobLookup).toEqual({ userId: BOB, deviceId: 'DEV2' });
    await expect(getUserByTokenHash(db, 'hash-a')).resolves.toBeNull();
    await expect(getUserByTokenHash(db, 'hash-b')).resolves.toEqual({
      userId: BOB,
      deviceId: 'DEV2',
    });
  });

  it('getLatestStreamPosition ∥ storeEventIdempotent: tip sees old or new only', async () => {
    const seed = pdu({ event_id: '$seed-tip', type: 'm.room.message', content: { body: 't' } });
    const db = createCrudDb({
      events: [eventRowFromPdu(seed, 7)],
      streamPosition: 7,
    });
    const event = pdu({
      event_id: '$stream-idem',
      type: 'm.room.message',
      content: { body: 's' },
    });
    const [tip, idem] = await Promise.all([
      getLatestStreamPosition(db),
      storeEventIdempotent(db, event),
    ]);
    expect(tip === 7 || tip === 8).toBe(true);
    expect(idem.inserted).toBe(true);
    expect(idem.streamOrdering).toBe(8);
    await expect(getLatestStreamPosition(db)).resolves.toBe(8);
    await expect(getEvent(db, '$stream-idem')).resolves.toMatchObject({
      event_id: '$stream-idem',
    });
  });

  it('getUserRooms(join) ∥ updateMembership join→leave: page sees room or empty', async () => {
    const db = createCrudDb({
      memberships: [
        {
          room_id: ROOM,
          user_id: USER,
          membership: 'join',
          event_id: '$join',
          display_name: null,
          avatar_url: null,
        },
      ],
    });
    const [rooms] = await Promise.all([
      getUserRooms(db, USER, 'join'),
      updateMembership(db, ROOM, USER, 'leave', '$leave'),
    ]);
    expect(rooms.length).toBeLessThanOrEqual(1);
    expect(rooms.every((r) => r === ROOM)).toBe(true);
    await expect(getUserRooms(db, USER, 'join')).resolves.toEqual([]);
    await expect(getMembership(db, ROOM, USER)).resolves.toEqual({
      membership: 'leave',
      eventId: '$leave',
    });
  });

  it('getEventsSince(limit:0) ∥ storeEvent: empty page does not poison insert', async () => {
    const seed = pdu({ event_id: '$seed-q', type: 'm.room.message', content: { body: 's' } });
    const db = createCrudDb({
      events: [eventRowFromPdu(seed, 3)],
      streamPosition: 3,
    });
    const neu = pdu({ event_id: '$neu-q', type: 'm.room.message', content: { body: 'n' } });
    const [page, stream] = await Promise.all([
      getEventsSince(db, ROOM, 0, 0),
      storeEvent(db, neu),
    ]);
    expect(page).toEqual([]);
    expect(stream).toBe(4);
    await expect(getEventsSince(db, ROOM, 3, 10)).resolves.toMatchObject([
      { event_id: '$neu-q' },
    ]);
  });

  it('createUser guest ∥ getUserById maps is_guest under race with non-guest sibling', async () => {
    const guestId = '@guest:example.com';
    const db = createCrudDb();
    const [,] = await Promise.all([
      createUser(db, guestId, 'guest', null, true),
      createUser(db, USER, 'alice', 'pbkdf2-alice', false),
    ]);
    const [guest, alice] = await Promise.all([
      getUserById(db, guestId),
      getUserById(db, USER),
    ]);
    expect(guest).toMatchObject({
      user_id: guestId,
      localpart: 'guest',
      is_guest: true,
    });
    expect(alice).toMatchObject({
      user_id: USER,
      localpart: 'alice',
      is_guest: false,
    });
    await expect(getPasswordHash(db, guestId)).resolves.toBeNull();
    await expect(getPasswordHash(db, USER)).resolves.toBe('pbkdf2-alice');
  });

  it('updateUserProfile avatar-only ∥ getUserById: display_name stays Old or reads mid-flight', async () => {
    const db = createCrudDb({
      users: [
        {
          user_id: USER,
          localpart: 'alice',
          password_hash: 'h',
          display_name: 'Old',
          avatar_url: 'mxc://example.com/old',
          is_guest: 0,
          is_deactivated: 0,
          admin: 0,
          created_at: NOW,
          updated_at: NOW,
        },
      ],
    });
    const [got] = await Promise.all([
      getUserById(db, USER),
      updateUserProfile(db, USER, undefined, 'mxc://example.com/new'),
    ]);
    expect(got).not.toBeNull();
    expect(got!.display_name).toBe('Old');
    expect(['mxc://example.com/old', 'mxc://example.com/new']).toContain(got!.avatar_url);
    await expect(getUserById(db, USER)).resolves.toMatchObject({
      display_name: 'Old',
      avatar_url: 'mxc://example.com/new',
    });
  });
});

describe('database CRUD TOKENMAXX residual senary leftovers after #330', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getRoomMembers(join) ∥ updateMembership leave: page sees member or empty', async () => {
    const db = createCrudDb({
      memberships: [
        {
          room_id: ROOM,
          user_id: USER,
          membership: 'join',
          event_id: '$join',
          display_name: 'Alice',
          avatar_url: null,
        },
        {
          room_id: ROOM,
          user_id: BOB,
          membership: 'join',
          event_id: '$bob',
          display_name: 'Bob',
          avatar_url: null,
        },
      ],
    });
    const [members] = await Promise.all([
      getRoomMembers(db, ROOM, 'join'),
      updateMembership(db, ROOM, USER, 'leave', '$leave'),
    ]);
    expect(members.length).toBeGreaterThanOrEqual(1);
    expect(members.length).toBeLessThanOrEqual(2);
    expect(members.every((m) => m.membership === 'join')).toBe(true);
    expect(members.some((m) => m.userId === BOB)).toBe(true);
    await expect(getRoomMembers(db, ROOM, 'join')).resolves.toEqual([
      { userId: BOB, membership: 'join', displayName: 'Bob', avatarUrl: undefined },
    ]);
    await expect(getMembership(db, ROOM, USER)).resolves.toEqual({
      membership: 'leave',
      eventId: '$leave',
    });
  });

  it('createAccessToken ∥ getUserByTokenHash: read sees null or token under race', async () => {
    const db = createCrudDb();
    const [got] = await Promise.all([
      getUserByTokenHash(db, 'hash-new'),
      createAccessToken(db, 'tid-new', 'hash-new', USER, 'DEV1'),
    ]);
    expect(got === null || got?.userId === USER).toBe(true);
    await expect(getUserByTokenHash(db, 'hash-new')).resolves.toEqual({
      userId: USER,
      deviceId: 'DEV1',
    });
  });

  it('deleteDevice ∥ getDevice same id: read sees device or null; sibling untouched', async () => {
    const db = createCrudDb({
      devices: [
        {
          user_id: USER,
          device_id: 'GONE',
          display_name: 'Phone',
          last_seen_ts: null,
          last_seen_ip: null,
          created_at: NOW,
        },
        {
          user_id: USER,
          device_id: 'KEEP',
          display_name: 'Laptop',
          last_seen_ts: null,
          last_seen_ip: null,
          created_at: NOW,
        },
      ],
    });
    const [got] = await Promise.all([
      getDevice(db, USER, 'GONE'),
      deleteDevice(db, USER, 'GONE'),
    ]);
    expect(got === null || got?.device_id === 'GONE').toBe(true);
    await expect(getDevice(db, USER, 'GONE')).resolves.toBeNull();
    await expect(getDevice(db, USER, 'KEEP')).resolves.toMatchObject({
      device_id: 'KEEP',
      display_name: 'Laptop',
    });
  });

  it('createRoomAlias ∥ getRoomByAlias: lookup sees null or room under race', async () => {
    const db = createCrudDb();
    const [got] = await Promise.all([
      getRoomByAlias(db, '#new:example.com'),
      createRoomAlias(db, '#new:example.com', ROOM, USER),
    ]);
    expect(got === null || got === ROOM).toBe(true);
    await expect(getRoomByAlias(db, '#new:example.com')).resolves.toBe(ROOM);
  });

  it('getRoomEvents ∥ storeEvent: page sees old tip or includes new only', async () => {
    const seed = pdu({ event_id: '$seed-se', type: 'm.room.message', content: { body: 's' } });
    const db = createCrudDb({
      events: [eventRowFromPdu(seed, 5)],
      streamPosition: 5,
    });
    const neu = pdu({ event_id: '$neu-se', type: 'm.room.message', content: { body: 'n' } });
    const [page, stream] = await Promise.all([
      getRoomEvents(db, ROOM, undefined, 10, 'f'),
      storeEvent(db, neu),
    ]);
    expect(stream).toBe(6);
    expect(page.events.length).toBeGreaterThanOrEqual(1);
    expect(page.events.length).toBeLessThanOrEqual(2);
    expect(page.events.every((e) => e.event_id === '$seed-se' || e.event_id === '$neu-se')).toBe(
      true
    );
    const after = await getRoomEvents(db, ROOM, undefined, 10, 'f');
    expect(after.events.map((e) => e.event_id).sort()).toEqual(['$neu-se', '$seed-se'].sort());
  });

  it('deleteAccessToken ∥ getUserByTokenHash: read sees token or null under race', async () => {
    const db = createCrudDb({
      tokens: [
        {
          token_id: 'tid-del',
          token_hash: 'hash-del',
          user_id: USER,
          device_id: 'DEV1',
          created_at: NOW,
        },
      ],
    });
    const [got] = await Promise.all([
      getUserByTokenHash(db, 'hash-del'),
      deleteAccessToken(db, 'hash-del'),
    ]);
    expect(got === null || got?.userId === USER).toBe(true);
    await expect(getUserByTokenHash(db, 'hash-del')).resolves.toBeNull();
  });

  it('getPasswordHash missing ∥ createUser: hash stays null until insert settles', async () => {
    const db = createCrudDb();
    const [hash] = await Promise.all([
      getPasswordHash(db, USER),
      createUser(db, USER, 'alice', 'pbkdf2-alice', false),
    ]);
    expect(hash === null || hash === 'pbkdf2-alice').toBe(true);
    await expect(getPasswordHash(db, USER)).resolves.toBe('pbkdf2-alice');
    await expect(getUserByLocalpart(db, 'alice')).resolves.toMatchObject({
      user_id: USER,
      localpart: 'alice',
    });
  });

  it('getEventsSince ∥ getLatestStreamPosition: tip/page stay coherent under race', async () => {
    const a = pdu({ event_id: '$a-tip', type: 'm.room.message', content: { body: 'a' } });
    const b = pdu({ event_id: '$b-tip', type: 'm.room.message', content: { body: 'b' } });
    const db = createCrudDb({
      events: [eventRowFromPdu(a, 1), eventRowFromPdu(b, 2)],
      streamPosition: 2,
    });
    const [page, tip] = await Promise.all([
      getEventsSince(db, ROOM, 0, 10),
      getLatestStreamPosition(db),
    ]);
    expect(tip).toBe(2);
    expect(page.map((e) => e.event_id)).toEqual(['$a-tip', '$b-tip']);
  });

  it('deleteAllUserTokens ∥ createAccessToken same user: final lookup coherent', async () => {
    const db = createCrudDb({
      tokens: [
        {
          token_id: 'tid-old',
          token_hash: 'hash-old',
          user_id: USER,
          device_id: 'DEV1',
          created_at: NOW,
        },
      ],
    });
    await Promise.all([
      deleteAllUserTokens(db, USER),
      createAccessToken(db, 'tid-new', 'hash-new', USER, 'DEV2'),
    ]);
    await expect(getUserByTokenHash(db, 'hash-old')).resolves.toBeNull();
    const neu = await getUserByTokenHash(db, 'hash-new');
    // Interleaving: delete-all-then-create → DEV2; create-then-delete-all may wipe new too.
    if (neu) {
      expect(neu).toEqual({ userId: USER, deviceId: 'DEV2' });
    } else {
      expect(db._state.tokens.filter((t) => t.user_id === USER)).toHaveLength(0);
    }
  });
});

describe('database CRUD TOKENMAXX residual septenary leftovers after #336', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getUserById missing ∥ createUser: read sees null or user under race', async () => {
    const db = createCrudDb();
    const [got] = await Promise.all([
      getUserById(db, USER),
      createUser(db, USER, 'alice', 'pbkdf2-alice', false),
    ]);
    expect(got === null || got?.user_id === USER).toBe(true);
    await expect(getUserById(db, USER)).resolves.toMatchObject({
      user_id: USER,
      localpart: 'alice',
      is_guest: false,
    });
    await expect(getPasswordHash(db, USER)).resolves.toBe('pbkdf2-alice');
  });

  it('getDevice missing ∥ createDevice: read sees null or device under race', async () => {
    const db = createCrudDb();
    const [got] = await Promise.all([
      getDevice(db, USER, 'DEV-NEW'),
      createDevice(db, USER, 'DEV-NEW', 'Phone'),
    ]);
    expect(got === null || got?.device_id === 'DEV-NEW').toBe(true);
    await expect(getDevice(db, USER, 'DEV-NEW')).resolves.toMatchObject({
      user_id: USER,
      device_id: 'DEV-NEW',
      display_name: 'Phone',
    });
  });

  it('getMembership invite ∥ updateMembership ban: read sees invite or ban', async () => {
    const db = createCrudDb({
      memberships: [
        {
          room_id: ROOM,
          user_id: USER,
          membership: 'invite',
          event_id: '$invite',
          display_name: 'Alice',
          avatar_url: null,
        },
      ],
    });
    const [got] = await Promise.all([
      getMembership(db, ROOM, USER),
      updateMembership(db, ROOM, USER, 'ban', '$ban', 'Alice'),
    ]);
    expect(got).not.toBeNull();
    expect(['invite', 'ban']).toContain(got!.membership);
    expect(['$invite', '$ban']).toContain(got!.eventId);
    await expect(getMembership(db, ROOM, USER)).resolves.toEqual({
      membership: 'ban',
      eventId: '$ban',
    });
  });

  it('getRoom missing ∥ createRoom: lookup sees null or room under race', async () => {
    const db = createCrudDb();
    const [got] = await Promise.all([
      getRoom(db, ROOM),
      createRoom(db, ROOM, '10', USER, true),
    ]);
    expect(got === null || got?.room_id === ROOM).toBe(true);
    await expect(getRoom(db, ROOM)).resolves.toEqual({
      room_id: ROOM,
      room_version: '10',
      creator_id: USER,
      is_public: true,
      created_at: NOW,
    });
  });

  it('getStateEvent ∥ storeEventIdempotent state overwrite: read sees old or new', async () => {
    const oldEvt = pdu({
      event_id: '$name-old',
      type: 'm.room.name',
      state_key: '',
      content: { name: 'Old' },
    });
    const db = createCrudDb({
      events: [eventRowFromPdu(oldEvt, 1)],
      roomState: [
        { room_id: ROOM, event_type: 'm.room.name', state_key: '', event_id: '$name-old' },
      ],
      streamPosition: 1,
    });
    const neu = pdu({
      event_id: '$name-new',
      type: 'm.room.name',
      state_key: '',
      content: { name: 'New' },
    });
    const [got, insert] = await Promise.all([
      getStateEvent(db, ROOM, 'm.room.name', ''),
      storeEventIdempotent(db, neu),
    ]);
    expect(insert.inserted).toBe(true);
    expect(got).not.toBeNull();
    expect(['Old', 'New']).toContain((got!.content as { name: string }).name);
    await expect(getStateEvent(db, ROOM, 'm.room.name', '')).resolves.toMatchObject({
      event_id: '$name-new',
      content: { name: 'New' },
    });
  });

  it('deleteAccessToken one hash ∥ createAccessToken other: sibling hash stays', async () => {
    const db = createCrudDb({
      tokens: [
        {
          token_id: 'tid-keep',
          token_hash: 'hash-keep',
          user_id: USER,
          device_id: 'DEV1',
          created_at: NOW,
        },
        {
          token_id: 'tid-del',
          token_hash: 'hash-del',
          user_id: USER,
          device_id: 'DEV2',
          created_at: NOW,
        },
      ],
    });
    await Promise.all([
      deleteAccessToken(db, 'hash-del'),
      createAccessToken(db, 'tid-new', 'hash-new', USER, 'DEV3'),
    ]);
    await expect(getUserByTokenHash(db, 'hash-del')).resolves.toBeNull();
    await expect(getUserByTokenHash(db, 'hash-keep')).resolves.toEqual({
      userId: USER,
      deviceId: 'DEV1',
    });
    await expect(getUserByTokenHash(db, 'hash-new')).resolves.toEqual({
      userId: USER,
      deviceId: 'DEV3',
    });
  });

  it('getEventsSince(since=tip) ∥ storeEvent: page empty or new only', async () => {
    const seed = pdu({ event_id: '$seed-sep', type: 'm.room.message', content: { body: 's' } });
    const db = createCrudDb({
      events: [eventRowFromPdu(seed, 7)],
      streamPosition: 7,
    });
    const neu = pdu({ event_id: '$neu-sep', type: 'm.room.message', content: { body: 'n' } });
    const [page, stream] = await Promise.all([
      getEventsSince(db, ROOM, 7, 10),
      storeEvent(db, neu),
    ]);
    expect(stream).toBe(8);
    expect(page.length).toBeLessThanOrEqual(1);
    expect(page.every((e) => e.event_id === '$neu-sep')).toBe(true);
    await expect(getEventsSince(db, ROOM, 7, 10)).resolves.toMatchObject([
      { event_id: '$neu-sep' },
    ]);
  });

  it('getUserRooms(join) ∥ updateMembership leave: page sees room or empty', async () => {
    const other = '!other:example.com';
    const db = createCrudDb({
      memberships: [
        {
          room_id: ROOM,
          user_id: USER,
          membership: 'join',
          event_id: '$j1',
          display_name: null,
          avatar_url: null,
        },
        {
          room_id: other,
          user_id: USER,
          membership: 'join',
          event_id: '$j2',
          display_name: null,
          avatar_url: null,
        },
      ],
    });
    const [rooms] = await Promise.all([
      getUserRooms(db, USER, 'join'),
      updateMembership(db, ROOM, USER, 'leave', '$leave'),
    ]);
    expect(rooms.length).toBeGreaterThanOrEqual(1);
    expect(rooms.length).toBeLessThanOrEqual(2);
    expect(rooms).toContain(other);
    await expect(getUserRooms(db, USER, 'join')).resolves.toEqual([other]);
    await expect(getMembership(db, ROOM, USER)).resolves.toEqual({
      membership: 'leave',
      eventId: '$leave',
    });
  });

  it('getEventsByIds ∥ getEvent same id stay coherent under race', async () => {
    const a = pdu({ event_id: '$a-sep', type: 'm.room.message', content: { body: 'a' } });
    const b = pdu({ event_id: '$b-sep', type: 'm.room.message', content: { body: 'b' } });
    const db = createCrudDb({
      events: [eventRowFromPdu(a, 1), eventRowFromPdu(b, 2)],
      streamPosition: 2,
    });
    const [byIds, single, missing] = await Promise.all([
      getEventsByIds(db, ['$a-sep', '$b-sep', '$missing']),
      getEvent(db, '$a-sep'),
      getEvent(db, '$missing'),
    ]);
    expect(byIds.map((e) => e.event_id).sort()).toEqual(['$a-sep', '$b-sep'].sort());
    expect(single).toMatchObject({ event_id: '$a-sep', content: { body: 'a' } });
    expect(missing).toBeNull();
  });
});

describe('database CRUD TOKENMAXX residual octonary leftovers after #356', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getUserByLocalpart missing ∥ createUser same localpart: read sees null or user', async () => {
    const db = createCrudDb();
    const [got] = await Promise.all([
      getUserByLocalpart(db, 'alice'),
      createUser(db, USER, 'alice', 'pbkdf2-alice', false),
    ]);
    expect(got === null || got?.user_id === USER).toBe(true);
    await expect(getUserByLocalpart(db, 'alice')).resolves.toMatchObject({
      user_id: USER,
      localpart: 'alice',
    });
  });

  it('getUserDevices ∥ createDevice: page sees new device or not; sibling untouched', async () => {
    const db = createCrudDb({
      devices: [
        {
          user_id: USER,
          device_id: 'KEEP',
          display_name: 'Laptop',
          last_seen_ts: null,
          last_seen_ip: null,
          created_at: NOW,
        },
      ],
    });
    const [devices] = await Promise.all([
      getUserDevices(db, USER),
      createDevice(db, USER, 'NEW', 'Phone'),
    ]);
    expect(devices.length).toBeGreaterThanOrEqual(1);
    expect(devices.length).toBeLessThanOrEqual(2);
    expect(devices.some((d) => d.device_id === 'KEEP')).toBe(true);
    await expect(getDevice(db, USER, 'NEW')).resolves.toMatchObject({
      device_id: 'NEW',
      display_name: 'Phone',
    });
    await expect(getUserDevices(db, USER)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ device_id: 'KEEP' }),
        expect.objectContaining({ device_id: 'NEW' }),
      ])
    );
  });

  it('updateUserProfile avatar-only ∥ getUserById: display_name stays; avatar old or new', async () => {
    const db = createCrudDb({
      users: [
        {
          user_id: USER,
          localpart: 'alice',
          password_hash: 'h',
          display_name: 'Alice',
          avatar_url: 'mxc://example.com/old',
          is_guest: 0,
          is_deactivated: 0,
          admin: 0,
          created_at: NOW,
          updated_at: NOW,
        },
      ],
    });
    const [got] = await Promise.all([
      getUserById(db, USER),
      updateUserProfile(db, USER, undefined, 'mxc://example.com/new'),
    ]);
    expect(got).not.toBeNull();
    expect(got!.display_name).toBe('Alice');
    expect(['mxc://example.com/old', 'mxc://example.com/new']).toContain(got!.avatar_url);
    await expect(getUserById(db, USER)).resolves.toMatchObject({
      display_name: 'Alice',
      avatar_url: 'mxc://example.com/new',
    });
  });

  it('getRoomState ∥ storeEventIdempotent state: page sees old or new name only', async () => {
    const old = pdu({
      event_id: '$old-oct',
      type: 'm.room.name',
      state_key: '',
      content: { name: 'Old' },
    });
    const db = createCrudDb({
      events: [eventRowFromPdu(old, 1)],
      roomState: [
        { room_id: ROOM, event_type: 'm.room.name', state_key: '', event_id: '$old-oct' },
      ],
      streamPosition: 1,
    });
    const neu = pdu({
      event_id: '$new-oct',
      type: 'm.room.name',
      state_key: '',
      content: { name: 'New' },
    });
    const [state, insert] = await Promise.all([
      getRoomState(db, ROOM),
      storeEventIdempotent(db, neu),
    ]);
    expect(insert.inserted).toBe(true);
    const names = state.filter((e) => e.type === 'm.room.name');
    expect(names).toHaveLength(1);
    expect(['$old-oct', '$new-oct']).toContain(names[0].event_id);
    await expect(getStateEvent(db, ROOM, 'm.room.name', '')).resolves.toMatchObject({
      event_id: '$new-oct',
      content: { name: 'New' },
    });
  });

  it('createRoomAlias ∥ getRoomByAlias missing: lookup sees null or room under race', async () => {
    const db = createCrudDb();
    const [got] = await Promise.all([
      getRoomByAlias(db, '#oct:example.com'),
      createRoomAlias(db, '#oct:example.com', ROOM, USER),
    ]);
    expect(got === null || got === ROOM).toBe(true);
    await expect(getRoomByAlias(db, '#oct:example.com')).resolves.toBe(ROOM);
  });

  it('getLatestStreamPosition ∥ storeEvent: tip sees old or new only', async () => {
    const seed = pdu({ event_id: '$seed-oct', type: 'm.room.message', content: { body: 's' } });
    const db = createCrudDb({
      events: [eventRowFromPdu(seed, 4)],
      streamPosition: 4,
    });
    const neu = pdu({ event_id: '$neu-oct', type: 'm.room.message', content: { body: 'n' } });
    const [tip, stream] = await Promise.all([
      getLatestStreamPosition(db),
      storeEvent(db, neu),
    ]);
    expect([4, 5]).toContain(tip);
    expect(stream).toBe(5);
    await expect(getLatestStreamPosition(db)).resolves.toBe(5);
    await expect(getEvent(db, '$neu-oct')).resolves.toMatchObject({ event_id: '$neu-oct' });
  });

  it('tryInsertJoinMembership leave→join ∥ getMembership: read sees leave or join', async () => {
    const db = createCrudDb({
      memberships: [
        {
          room_id: ROOM,
          user_id: USER,
          membership: 'leave',
          event_id: '$leave',
          display_name: 'Alice',
          avatar_url: null,
        },
      ],
    });
    const [got, upgrade] = await Promise.all([
      getMembership(db, ROOM, USER),
      tryInsertJoinMembership(db, ROOM, USER, '$join-oct', 'Alice'),
    ]);
    expect(upgrade.inserted).toBe(true);
    expect(upgrade.eventId).toBe('$join-oct');
    expect(got).not.toBeNull();
    expect(['leave', 'join']).toContain(got!.membership);
    await expect(getMembership(db, ROOM, USER)).resolves.toEqual({
      membership: 'join',
      eventId: '$join-oct',
    });
  });

  it('getEventsByIds ∥ storeEvent new id: page omits or includes new only after settle', async () => {
    const a = pdu({ event_id: '$a-oct', type: 'm.room.message', content: { body: 'a' } });
    const db = createCrudDb({
      events: [eventRowFromPdu(a, 1)],
      streamPosition: 1,
    });
    const neu = pdu({ event_id: '$b-oct', type: 'm.room.message', content: { body: 'b' } });
    const [page, stream] = await Promise.all([
      getEventsByIds(db, ['$a-oct', '$b-oct']),
      storeEvent(db, neu),
    ]);
    expect(stream).toBe(2);
    expect(page.length).toBeGreaterThanOrEqual(1);
    expect(page.length).toBeLessThanOrEqual(2);
    expect(page.every((e) => e.event_id === '$a-oct' || e.event_id === '$b-oct')).toBe(true);
    expect(page.some((e) => e.event_id === '$a-oct')).toBe(true);
    await expect(getEventsByIds(db, ['$a-oct', '$b-oct'])).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_id: '$a-oct' }),
        expect.objectContaining({ event_id: '$b-oct' }),
      ])
    );
  });

  it('getRoomMembers(ban) ∥ updateMembership ban→join: filter sees ban or empty', async () => {
    const db = createCrudDb({
      memberships: [
        {
          room_id: ROOM,
          user_id: USER,
          membership: 'ban',
          event_id: '$ban',
          display_name: 'Alice',
          avatar_url: null,
        },
      ],
    });
    const [banned] = await Promise.all([
      getRoomMembers(db, ROOM, 'ban'),
      updateMembership(db, ROOM, USER, 'join', '$join'),
    ]);
    expect(banned.length).toBeLessThanOrEqual(1);
    expect(banned.every((m) => m.membership === 'ban')).toBe(true);
    await expect(getRoomMembers(db, ROOM, 'ban')).resolves.toEqual([]);
    await expect(getMembership(db, ROOM, USER)).resolves.toEqual({
      membership: 'join',
      eventId: '$join',
    });
  });
});
